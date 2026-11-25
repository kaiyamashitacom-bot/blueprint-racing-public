// 賭け (bets.ts・bets_league.ts) の試験。アカウントの DO とリーグの DO は別の node:sqlite。間の RPC は直接つなぐ。
// ゲームの中のお金だけ・自分のレースは不可・締め切り・上限 (はじめは無し)・払い・返す・本物のお金の止め・管理者の 403・wallet_log
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, cloneAdminConfig, scheduledSlotIndex, scheduledSlotStart, type AdminConfig } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { TeamStore } from "../src/team.ts";
import { LeagueStore, type LeagueAccountsPort } from "../src/league.ts";
import { leagueAuth, leagueRoster, leagueTeamData } from "../src/league_accounts.ts";
import { BetStore, handleBetsAdminApi } from "../src/bets.ts";
import { ApiError } from "../src/accounts.ts";
import { handleBetsApi } from "../src/bets_league.ts";

function sqlite() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec(q: string, ...b: SqlValue[]) {
      const rows = db.prepare(q).all(...(b as Array<string | number | null>)) as Array<Record<string, SqlValue>>;
      return { toArray: () => rows };
    },
  };
  const tx = <T,>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { db, sql, tx };
}

// 日本時間 2026-12-03 (木) 0:30。次の枠は 2:00、締め切りは 1:55
const DAY0 = Date.UTC(2026, 11, 2, 15, 30);
const NEXT = scheduledSlotStart(scheduledSlotIndex(DAY0) + 1);

function makeAll(hooks: { failTeams?: number } = {}) {
  const clock = { t: DAY0 };
  const cfg: { c: AdminConfig } = { c: cloneAdminConfig(DEFAULT_ADMIN_CONFIG) };
  const a = sqlite();
  const store = new AccountStore({ sql: a.sql, tx: a.tx, now: () => clock.t, iterations: 1000, adminIds: ["user9"] });
  const team = new TeamStore({ sql: a.sql, tx: a.tx, now: () => clock.t }, store);
  const bets = new BetStore({ sql: a.sql, tx: a.tx, now: () => clock.t, config: () => cfg.c }, store);
  const port: LeagueAccountsPort = {
    roster: async () => leagueRoster(a.sql),
    auth: async (t) => leagueAuth(store, t),
    teams: async (ids) => {
      if (hooks.failTeams && hooks.failTeams-- > 0) throw new Error("teams down");
      return ids.map((id) => leagueTeamData(store, team, id)).filter((x) => x !== null);
    },
    recordRace: async (raceId, report, accountOf) => team.recordRace(raceId, report, accountOf),
    payPrizes: async (id, items) => void store.payPrizes(id, items),
    constructorsDay: async () => {},
    adminConfig: async () => cfg.c,
    settleBets: async (raceId, result) => void bets.settle(raceId, result),
    placeBet: async (input) => {
      try {
        const r = bets.place(input);
        return { ok: true, bet: r.bet, money: r.money };
      } catch (e) {
        if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message };
        throw e;
      }
    },
    myBets: async (id) => bets.mine(id),
  };
  const l = sqlite();
  const league = new LeagueStore({ sql: l.sql, tx: l.tx, now: () => clock.t }, port);
  return { clock, cfg, a, store, team, bets, league, port, l };
}

type All = ReturnType<typeof makeAll>;

async function user(all: All, n: number, money = 1000) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `9.9.9.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), all.store, undefined, all.team);
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: `user${n}`, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.a.db.prepare("SELECT id FROM accounts WHERE login = ?").get(`user${n}`)!.id);
  all.a.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(money, id);
  const bet = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const res = await handleBetsApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), all.league, all.port);
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };
  const admin = async (method: string, body?: unknown) => {
    const res = await handleBetsAdminApi(
      new Request("http://x/api/admin/bets", { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }),
      "/api/admin/bets",
      method,
      all.store,
      all.bets,
      (paused) => (all.cfg.c = { ...all.cfg.c, betPaused: paused }),
    );
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };
  return { call, bet, admin, id, tid: String(id) };
}

const money = (all: All, id: number) => Number(all.a.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);
const wallet = (all: All, id: number) =>
  (all.a.db.prepare("SELECT delta, reason FROM wallet_log WHERE account_id = ? AND reason LIKE 'bet%' ORDER BY id").all(id) as Array<{ delta: number; reason: string }>).map((r) => [r.reason, Number(r.delta)]);

async function drain(all: All, max = 40) {
  for (let i = 0; i < max; i++) if (!(await all.league.step(all.clock.t))) break;
  await all.league.flushOutbox();
}

/** 3 チーム: 1 と 2 は 8 部 (d8-0)、3 は 8 部 B (d8-1) */
async function setup(hooks: { failTeams?: number } = {}) {
  const all = makeAll(hooks);
  const u1 = await user(all, 1);
  const u2 = await user(all, 2);
  const u3 = await user(all, 3, 5000);
  await all.league.poke(all.clock.t);
  await drain(all);
  return { all, u1, u2, u3 };
}

const raceA = `sched-${scheduledSlotIndex(NEXT)}-d8-0`;
const raceB = `sched-${scheduledSlotIndex(NEXT)}-d8-1`;

describe("賭けの受け口", () => {
  it("レースの一覧と倍率。自分のレースは賭けられない。賭けるとお金が引かれ wallet_log に bet", async () => {
    const { all, u1, u3 } = await setup();
    const list = await u3.bet("GET", "/api/bets/races");
    expect(list.status).toBe(200);
    expect(list.data.slots[0].startsAt).toBe(NEXT);
    expect(list.data.slots[0].open).toBe(true);
    // 0:30 から その日の 22 時まで 11 枠
    expect(list.data.slots).toHaveLength(11);
    const races = list.data.slots[0].races;
    expect(races.map((r: any) => r.raceId)).toEqual([raceA, raceB]);
    expect(races.map((r: any) => r.mine)).toEqual([false, true]);
    expect(races[0].teams).toHaveLength(4);
    // ほかのチームの id は出ない
    expect(JSON.stringify(list.data)).not.toContain(`"${u1.tid}"`);

    const book = await u3.bet("GET", `/api/bets/race/${raceA}`);
    expect(book.status).toBe(200);
    const cars = book.data.teams.flatMap((t: any) => t.cars);
    expect(cars).toHaveLength(8);
    expect(cars.reduce((s: number, c: any) => s + c.pWin, 0)).toBeCloseTo(1, 2);
    expect(book.data.pairs).toHaveLength(6);
    const pick = cars.find((c: any) => c.win !== null);
    const r = await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "win", pick: { car: pick.car }, stake: 300, odds: pick.win });
    expect(r.status).toBe(201);
    expect(r.data.money).toBe(4700);
    expect(r.data.bet).toMatchObject({ stake: 300, odds: pick.win, status: "open", kind: "win" });
    expect(money(all, u3.id)).toBe(4700);
    expect(wallet(all, u3.id)).toEqual([["bet", -300]]);
    // 自分のチームの出るレース
    expect((await u1.bet("POST", "/api/bets", { raceId: raceA, kind: "win", pick: { car: "0/1" }, stake: 10 })).status).toBe(403);
    expect((await u3.bet("POST", "/api/bets", { raceId: raceB, kind: "win", pick: { car: "0/1" }, stake: 10 })).status).toBe(403);
    // 倍率が変わった (画面の倍率がちがう) → 賭けずに今の表
    const changed = await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "win", pick: { car: pick.car }, stake: 10, odds: pick.win + 1 });
    expect(changed.status).toBe(409);
    expect(changed.data.book.raceId).toBe(raceA);
    const mine = await u3.bet("GET", "/api/bets/mine");
    expect(mine.data.open).toHaveLength(1);
    expect(mine.data.todayStaked).toBe(300);
  });

  it("賭けられるのはゲームのお金だけ (品物・部品は断る)。上限ははじめは無し: 全部賭けてよい", async () => {
    const { all, u3 } = await setup();
    const book = (await u3.bet("GET", `/api/bets/race/${raceA}`)).data;
    const car = book.teams[0].cars[0].car;
    for (const body of [
      { raceId: raceA, kind: "win", pick: { car }, stake: 10, item: "limit_blueprint" },
      { raceId: raceA, kind: "win", pick: { car }, stake: 10, parts: { eng_m1: 1 } },
      { raceId: raceA, kind: "win", pick: { car }, stake: { part: "eng_m1" } },
      { raceId: raceA, kind: "win", pick: { car } },
    ]) {
      const r = await u3.bet("POST", "/api/bets", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.data.error).toContain("ゲームの中のお金だけ");
    }
    expect((await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "win", pick: { car }, stake: 0 })).status).toBe(400);
    expect((await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "win", pick: { car }, stake: 5001 })).data.error).toBe("お金が足りません");
    // 全部 (5000) 賭けてよい
    const all5000 = await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "top3", pick: { car }, stake: 5000 });
    expect(all5000.status).toBe(201);
    expect(money(all, u3.id)).toBe(0);
  });

  it("上限 (管理者が付けたとき): 1 回・1 日・手元の割合・一番小さい額", async () => {
    const { all, u3 } = await setup();
    const car = (await u3.bet("GET", `/api/bets/race/${raceA}`)).data.teams[0].cars[0].car;
    const put = (stake: number) => u3.bet("POST", "/api/bets", { raceId: raceA, kind: "top3", pick: { car }, stake });
    all.cfg.c = { ...all.cfg.c, betMinStake: 50, betMaxStake: 1000, betMaxPerDay: 1500, betMaxShareOfMoney: 0.2 };
    expect((await put(49)).data.error).toContain("50 円から");
    expect((await put(1001)).data.error).toContain("1,000 円まで");
    // 手元 5000 の 2 割 = 1000
    expect((await put(1000)).status).toBe(201);
    // 手元 4000 の 2 割 = 800、1 日あと 500
    expect((await put(600)).data.error).toContain("1 日");
    expect((await put(500)).status).toBe(201);
    expect((await put(50)).data.error).toContain("1 日");
    expect(money(all, u3.id)).toBe(3500);
    all.cfg.c = { ...all.cfg.c, betMaxPerDay: null, betMaxStake: null };
    expect((await put(701)).data.error).toContain("20%");
    expect((await put(700)).status).toBe(201);
  });

  it("締め切りはスタートの 5 分前", async () => {
    const { all, u3 } = await setup();
    const car = (await u3.bet("GET", `/api/bets/race/${raceA}`)).data.teams[0].cars[0].car;
    all.clock.t = NEXT - 5 * 60_000 - 1;
    expect((await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "top3", pick: { car }, stake: 10 })).status).toBe(201);
    all.clock.t = NEXT - 5 * 60_000;
    const late = await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "top3", pick: { car }, stake: 10 });
    expect(late.status).toBe(409);
    expect(late.data.error).toContain("締め切り");
    expect((await u3.bet("GET", "/api/bets/races")).data.slots[0].open).toBe(false);
    // アカウントの DO の側でも確かめる (リーグの DO を通らなくても)
    expect(() =>
      all.bets.place({ accountId: u3.id, raceId: raceA, startsAt: NEXT, raceLabel: "x", teams: [], kind: "win", pick: { car: "a/1" }, label: "x", stake: 10, odds: 2, prob: 0.4 }),
    ).toThrow(/締め切り/);
  });

  it("本物のお金の止め: realMoneyEnabled が入なら受け口は全部断る。一時停止は賭けだけ止める", async () => {
    const { all, u3 } = await setup();
    const car = (await u3.bet("GET", `/api/bets/race/${raceA}`)).data.teams[0].cars[0].car;
    expect(DEFAULT_ADMIN_CONFIG.realMoneyEnabled).toBe(false);
    all.cfg.c = { ...all.cfg.c, realMoneyEnabled: true };
    for (const [m, p] of [["GET", "/api/bets/races"], ["GET", `/api/bets/race/${raceA}`], ["GET", "/api/bets/mine"]] as const) expect((await u3.bet(m, p)).status).toBe(503);
    const r = await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "win", pick: { car }, stake: 10 });
    expect(r.status).toBe(503);
    expect(r.data.error).toContain("本物のお金");
    expect(() =>
      all.bets.place({ accountId: u3.id, raceId: raceA, startsAt: NEXT, raceLabel: "x", teams: [], kind: "win", pick: { car: "a/1" }, label: "x", stake: 10, odds: 2, prob: 0.4 }),
    ).toThrow(/本物のお金/);
    all.cfg.c = { ...all.cfg.c, realMoneyEnabled: false, betPaused: true };
    expect((await u3.bet("GET", "/api/bets/races")).data.paused).toBe(true);
    expect((await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "win", pick: { car }, stake: 10 })).status).toBe(503);
    expect(money(all, u3.id)).toBe(5000);
  });

  it("管理者の受け口: ほかの人は 403。量と胴元の取り分、一時停止", async () => {
    const { all, u3 } = await setup();
    expect((await u3.admin("GET")).status).toBe(403);
    expect((await u3.admin("PUT", { paused: true })).status).toBe(403);
    const boss = await user(all, 9);
    const s0 = await boss.admin("GET");
    expect(s0.status).toBe(200);
    expect(s0.data.all).toEqual({ bets: 0, won: 0, staked: 0, paid: 0, houseTake: 0 });
    const p = await boss.admin("PUT", { paused: true });
    expect(p.data.paused).toBe(true);
    expect(all.cfg.c.betPaused).toBe(true);
    expect((await boss.admin("PUT", { paused: "yes" })).status).toBe(400);
  });
});

describe("払いと返す", () => {
  it("決まった結果で払う: 当たりは 倍率 × 額 (切り捨て)・外れは 0・走らなかった車は返す。同じレースは 1 回だけ", async () => {
    const { all, u3 } = await setup();
    const place = (kind: "win" | "top3" | "pair", pick: any, stake: number, odds: number) =>
      all.bets.place({ accountId: u3.id, raceId: "r1", startsAt: NEXT, raceLabel: "8 部", teams: ["a", "b"], kind, pick, label: "x", stake, odds, prob: 0.5 });
    place("win", { car: "a/1" }, 100, 3.33);
    place("win", { car: "b/1" }, 100, 2.5);
    place("top3", { car: "b/2" }, 200, 1.5);
    place("pair", { first: "b", second: "a" }, 100, 1.9);
    place("win", { car: "z/1" }, 50, 9);
    expect(money(all, u3.id)).toBe(5000 - 550);
    const result = [
      { key: "a/1", team: "a", pos: 1, finished: true },
      { key: "b/2", team: "b", pos: 2, finished: true },
      { key: "a/2", team: "a", pos: 3, finished: true },
      { key: "b/1", team: "b", pos: 4, finished: false },
    ];
    expect(all.bets.settle("r1", result)).toEqual({ bets: 5, won: 2, paid: 333 + 300, refunded: 50 });
    expect(money(all, u3.id)).toBe(5000 - 550 + 333 + 300 + 50);
    expect(wallet(all, u3.id)).toEqual([["bet", -100], ["bet", -100], ["bet", -200], ["bet", -100], ["bet", -50], ["bet_win", 333], ["bet_win", 300], ["bet_refund", 50]]);
    const mine = all.bets.mine(u3.id);
    expect(mine.open).toHaveLength(0);
    expect(mine.history.map((b) => b.status).sort()).toEqual(["lost", "lost", "void", "won", "won"]);
    // 2 回目は何もしない
    expect(all.bets.settle("r1", result).bets).toBe(0);
    expect(money(all, u3.id)).toBe(5000 - 550 + 683);
    // 決まったレースには、もう賭けられない
    expect(() => place("win", { car: "a/1" }, 10, 2)).toThrow(/締め切り/);
    // 胴元の取り分 = 賭けた額 − 払った額 (返した分は数えない)
    const st = all.bets.stats();
    expect(st.all).toMatchObject({ bets: 4, staked: 500, paid: 633, houseTake: -133 });
    expect(st.refunded).toEqual({ bets: 1, staked: 50 });
  });

  it("リーグのレースを計算すると送る箱で払われる (結果の順位どおり)", async () => {
    const { all, u3 } = await setup();
    const book = (await u3.bet("GET", `/api/bets/race/${raceA}`)).data;
    const cars = book.teams.flatMap((t: any) => t.cars);
    for (const c of cars) if (c.top3 !== null) expect((await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "top3", pick: { car: c.car }, stake: 100, odds: c.top3 })).status).toBe(201);
    const n = cars.filter((c: any) => c.top3 !== null).length;
    expect(money(all, u3.id)).toBe(5000 - 100 * n);
    all.clock.t = NEXT + 60_000;
    await all.league.poke(all.clock.t);
    await drain(all);
    const mine = all.bets.mine(u3.id);
    expect(mine.open).toHaveLength(0);
    // 3 着以内に入った車は 3 台 (全部リタイアしなければ)。当たった分だけ払われる
    const won = mine.history.filter((b) => b.status === "won");
    expect(won.length).toBeGreaterThan(0);
    expect(won.length).toBeLessThanOrEqual(3);
    const paid = won.reduce((s, b) => s + b.payout, 0);
    expect(money(all, u3.id)).toBe(5000 - 100 * n + paid);
    expect(wallet(all, u3.id).filter(([r]) => r === "bet_win")).toHaveLength(won.length);
  });

  it("計算できなかったレース (「計算していない」) の賭けは返す", async () => {
    const { all, u1, u3 } = await setup();
    const car = (await u3.bet("GET", `/api/bets/race/${raceA}`)).data.teams[0].cars[0].car;
    expect((await u3.bet("POST", "/api/bets", { raceId: raceA, kind: "top3", pick: { car }, stake: 400 })).status).toBe(201);
    expect(money(all, u3.id)).toBe(4600);
    // 枠を積んだが計算が追いつかず、2 枠以上遅れて落とした
    all.clock.t = NEXT + 60_000;
    await all.league.poke(all.clock.t);
    all.clock.t = NEXT + 2 * 2 * 3_600_000 + 60_000;
    await all.league.poke(all.clock.t);
    await drain(all);
    expect(all.league.myResults(u1.tid).find((r) => r.raceId === raceA)?.status).toBe("not_computed");
    expect(money(all, u3.id)).toBe(5000);
    expect(wallet(all, u3.id)).toEqual([["bet", -400], ["bet_refund", 400]]);
    expect(all.bets.mine(u3.id).history[0].status).toBe("void");
  });

  it("結果の来ない賭け (レースが組まれなかった) は 6 時間あとに返す", async () => {
    const { all, u3 } = await setup();
    all.bets.place({ accountId: u3.id, raceId: "sched-1-d1-0", startsAt: NEXT, raceLabel: "x", teams: [], kind: "win", pick: { car: "a/1" }, label: "x", stake: 70, odds: 2, prob: 0.4 });
    all.clock.t = NEXT + 5 * 3_600_000;
    expect(all.bets.sweep()).toBe(0);
    all.clock.t = NEXT + 6 * 3_600_000 + 1;
    expect(all.bets.sweep()).toBe(1);
    expect(money(all, u3.id)).toBe(5000);
  });
});
