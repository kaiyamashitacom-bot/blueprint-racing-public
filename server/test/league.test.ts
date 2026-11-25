// リーグ戦 (2 時間ごとの自動のレース) の保存と進め方の試験。DO の SQLite の代わりに node:sqlite を使う。
// アカウントの DO (アカウント・チーム) と リーグの DO は別の SQLite。間の RPC は直接つなぐ
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_CONFIG, leagueDayAt, leaguePrizeFor, scheduledSlotIndex, scheduledSlotStart, type ConstructorLeagueAcc,
} from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { TeamStore } from "../src/team.ts";
import { handleLeagueApi, LeagueStore, type LeagueAccountsPort, type LeagueDayMeta } from "../src/league.ts";
import { leagueAuth, leagueRoster, leagueTeamData } from "../src/league_accounts.ts";

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

// 日本時間 2026-12-03 (木) 0:30
const DAY0 = Date.UTC(2026, 11, 2, 15, 30);

interface Hooks {
  failPay?: number;
  failRecord?: number;
  failTeams?: number;
}

function makeAll(hooks: Hooks = {}) {
  const clock = { t: DAY0 };
  const a = sqlite();
  const store = new AccountStore({ sql: a.sql, tx: a.tx, now: () => clock.t, iterations: 1000 });
  const team = new TeamStore({ sql: a.sql, tx: a.tx, now: () => clock.t }, store);
  const ctor: Array<{ dayKey: string; delta: ConstructorLeagueAcc; meta: LeagueDayMeta }> = [];
  const port: LeagueAccountsPort = {
    roster: async () => leagueRoster(a.sql),
    auth: async (t) => leagueAuth(store, t),
    teams: async (ids) => {
      if (hooks.failTeams && hooks.failTeams-- > 0) throw new Error("teams down");
      return ids.map((id) => leagueTeamData(store, team, id)).filter((x) => x !== null);
    },
    recordRace: async (raceId, report, accountOf) => {
      if (hooks.failRecord && hooks.failRecord-- > 0) throw new Error("record down");
      team.recordRace(raceId, report, accountOf);
    },
    payPrizes: async (id, items) => {
      if (hooks.failPay && hooks.failPay-- > 0) throw new Error("pay down");
      store.payPrizes(id, items);
    },
    constructorsDay: async (dayKey, delta, meta) => {
      ctor.push({ dayKey, delta, meta });
    },
    adminConfig: async () => null,
  };
  const l = sqlite();
  const league = new LeagueStore({ sql: l.sql, tx: l.tx, now: () => clock.t }, port);
  return { clock, a, store, team, league, port, ctor, l };
}

type All = ReturnType<typeof makeAll>;

async function user(all: All, n: number, money = 1000) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `9.9.9.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), all.store, undefined, all.team);
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: `user${n}`, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.a.db.prepare("SELECT id FROM accounts WHERE login = ?").get(`user${n}`)!.id);
  all.a.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(money, id);
  const league = async (method: string, path: string, dev = false) => {
    const res = await handleLeagueApi(new Request(`http://x${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }), all.league, all.port, { dev });
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };
  return { call, league, id, tid: String(id) };
}

const money = (all: All, id: number) => Number(all.a.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);

/** 積んだものを全部進める (1 回の step で 1 つ) */
async function drain(all: All, max = 60): Promise<string[]> {
  const did: string[] = [];
  for (let i = 0; i < max; i++) {
    const r = await all.league.step(all.clock.t);
    if (!r) break;
    did.push(r.kind === "close" ? `close:${r.day}` : `${r.status}:${r.raceId}`);
  }
  await all.league.flushOutbox();
  return did;
}

/** 日本時間のその日の k 番目の枠 (0 = 0 時 … 11 = 22 時) の 1 分あと */
const slotTime = (dayStartMs: number, k: number) => scheduledSlotStart(scheduledSlotIndex(dayStartMs) + k) + 60_000;

describe("リーグ戦の進め方", () => {
  it("アカウントはリーグに自動で入り、枠のレースを 1 回に 1 レースずつ 1 部から計算する", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    const u2 = await user(all, 2);
    const u3 = await user(all, 3);
    const slot = await all.league.poke(all.clock.t);
    expect(slot).toBe(scheduledSlotIndex(all.clock.t));
    const st = all.league.state();
    expect(st.leagues.map((l) => [l.id, l.humans])).toEqual([
      ["d8-0", [u1.tid, u2.tid]],
      ["d8-1", [u3.tid]],
    ]);
    // 同じ枠は 2 回積まない
    expect(await all.league.poke(all.clock.t)).toBeNull();
    expect(all.league.pending()).toBe(2);
    const r1 = await all.league.step();
    expect(r1).toMatchObject({ kind: "race", status: "done", raceId: `sched-${slot}-d8-0` });
    expect(all.league.pending()).toBe(1);
    const r2 = await all.league.step();
    expect(r2).toMatchObject({ kind: "race", status: "done", raceId: `sched-${slot}-d8-1` });
    expect(await all.league.step()).toBeNull();
    // 自分の出たレースだけ見える。8 台 (人 2 チーム × 2 台 + コンピューター 2 チーム × 2 台)
    const mine = all.league.myResults(u1.tid);
    expect(mine).toHaveLength(1);
    expect(mine[0].leagueId).toBe("d8-0");
    expect(mine[0].cars).toHaveLength(8);
    expect(mine[0].cars.filter((c) => c.teamId === u1.tid).map((c) => c.kind).sort()).toEqual(["cpu", "standin"]);
    expect(mine[0].cars.filter((c) => c.kind === "rival")).toHaveLength(4);
    expect(new Set(mine[0].cars.map((c) => c.grid)).size).toBe(8);
    expect(all.league.myResults(u3.tid).map((r) => r.leagueId)).toEqual(["d8-1"]);
    // 人 1 チームのリーグはコンピューター 3 チーム
    expect(all.league.myResults(u3.tid)[0].cars.filter((c) => c.kind === "rival")).toHaveLength(6);
    // 今日の点
    const me = all.league.myLeague(u1.tid);
    expect(me.league?.division).toBe(8);
    expect(me.league?.title).toBe("製図見習い");
    expect(me.league?.rows).toHaveLength(4);
    expect(me.league?.rows.every((r) => r.races === 1)).toBe(true);
    expect(me.league?.rows.reduce((s, r) => s + r.points, 0)).toBe(mine[0].cars.reduce((s, c) => s + c.points, 0));
    // 代走の慣れがアカウントの側に残る (送る箱から)
    const fam = all.a.db.prepare("SELECT track FROM familiarity WHERE who = ?").all(`s:${u1.id}`) as Array<{ track: string }>;
    expect(fam.map((f) => f.track)).toEqual([mine[0].trackId]);
    expect(all.league.outboxSize()).toBe(0);
  });

  it("雇った運転手は 2 台目で走り、育ちと慣れがアカウントの側に残る。ライバルも慣れる", async () => {
    const all = makeAll();
    const u1 = await user(all, 1, 200_000);
    await user(all, 2);
    const d = (await u1.call("GET", "/api/drivers")).data.free[0];
    expect((await u1.call("POST", "/api/drivers/hire", { driverId: d.id })).status).toBe(200);
    await all.league.poke();
    await drain(all);
    const race = all.league.myResults(u1.tid)[0];
    const two = race.cars.find((c) => c.teamId === u1.tid && c.kind === "hired")!;
    expect(two.driver).toBe(d.name);
    const fam = all.a.db.prepare("SELECT who FROM familiarity WHERE who = ?").all(`d:${d.id}`);
    expect(fam).toHaveLength(1);
    expect((await u1.call("GET", "/api/drivers")).data.mine.races).toBe(1);
    const rv = all.l.db.prepare("SELECT COUNT(*) AS n FROM league_fam WHERE who LIKE 'rv:%'").get() as { n: number };
    expect(Number(rv.n)).toBe(4);
  });

  it("22 時のレースのあとに日を締める: 上位 2 の人に賞金、点は 0 に、季節の係にその日の分", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    const u2 = await user(all, 2);
    const dayStart = Date.UTC(2026, 11, 2, 15, 0); // 日本時間 12/3 0:00
    const day = leagueDayAt(dayStart);
    for (let k = 0; k < 12; k++) {
      all.clock.t = slotTime(dayStart, k);
      await all.league.poke();
      const did = await drain(all);
      if (k < 11) expect(did).toEqual([`done:sched-${scheduledSlotIndex(all.clock.t)}-d8-0`]);
      else expect(did).toEqual([`done:sched-${scheduledSlotIndex(all.clock.t)}-d8-0`, `close:${day}`]);
    }
    expect(all.league.myResults(u1.tid, 50)).toHaveLength(12);
    const st = all.league.state();
    expect(st.day).toBe(day + 1);
    expect(st.tally).toEqual({});
    // ライバルは日の締めごとに 1 日分 (週の 1/7) 上がる
    const rvs = (all.l.db.prepare("SELECT body FROM league_rivals").all() as Array<{ body: string }>).map((r) => JSON.parse(r.body));
    expect(rvs.length).toBeGreaterThan(0);
    for (const rv of rvs) expect(rv.daily).toMatchObject({ days: 1, grown: 12 });
    // 締めた日の記録 (自分の順位・賞金)
    const rec = JSON.parse(String((all.l.db.prepare("SELECT body FROM league_days WHERE day = ?").get(day) as { body: string }).body));
    const rows = rec.standings["d8-0"] as Array<{ id: string; rank: number; human: boolean; points: number }>;
    const humansTop = rows.slice(0, 2).filter((r) => r.human && r.points > 0);
    for (const u of [u1, u2]) {
      const r = rows.find((x) => x.id === u.tid)!;
      const prize = humansTop.some((x) => x.id === u.tid) ? leaguePrizeFor(DEFAULT_ADMIN_CONFIG, 8, r.rank) : 0;
      expect(money(all, u.id)).toBe(1000 + prize);
      const last = all.league.myLeague(u.tid).lastDay!;
      expect(last).toMatchObject({ day, rank: r.rank, prize, moved: null, champion: false });
    }
    // 季節の係へ: その日の分 (人のチームだけ) と部
    expect(all.ctor).toHaveLength(1);
    expect(all.ctor[0].dayKey).toBe(`league-${day}`);
    expect(Object.keys(all.ctor[0].delta).every((id) => id === u1.tid || id === u2.tid)).toBe(true);
    expect(all.ctor[0].meta.divisions).toEqual({ [u1.tid]: 8, [u2.tid]: 8 });
    // 次の日のレースは 0 から
    all.clock.t = slotTime(dayStart + 24 * 3_600_000, 0);
    await all.league.poke();
    await drain(all);
    expect(all.league.myLeague(u1.tid).league!.rows.every((r) => r.races === 1)).toBe(true);
  });

  it("2 枠 (4 時間) 以上遅れたレースは計算せず「計算していない」と残す", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    await all.league.poke();
    const old = scheduledSlotIndex(all.clock.t);
    all.clock.t += 2 * 2 * 3_600_000;
    await all.league.poke();
    const did = await drain(all);
    expect(did).toEqual([`done:sched-${old + 2}-d8-0`]);
    const res = all.league.myResults(u1.tid);
    expect(res.map((r) => [r.raceId, r.status])).toEqual([
      [`sched-${old + 2}-d8-0`, "done"],
      [`sched-${old}-d8-0`, "not_computed"],
    ]);
    // 点は入らない
    expect(all.league.myLeague(u1.tid).league!.rows.every((r) => r.races === 1)).toBe(true);
  });

  it("日が変わっても前の日の 22 時のレースが残っていれば、先に計算して締めてから次の日", async () => {
    const all = makeAll();
    await user(all, 1);
    const dayStart = Date.UTC(2026, 11, 2, 15, 0);
    all.clock.t = slotTime(dayStart, 11);
    await all.league.poke();
    // 計算しないうちに次の日の 0 時
    all.clock.t = slotTime(dayStart + 24 * 3_600_000, 0);
    await all.league.poke();
    const did = await drain(all);
    const s22 = scheduledSlotIndex(slotTime(dayStart, 11));
    expect(did).toEqual([`done:sched-${s22}-d8-0`, `close:${leagueDayAt(dayStart)}`, `done:sched-${s22 + 1}-d8-0`]);
    expect(all.league.state().day).toBe(leagueDayAt(dayStart) + 1);
  });

  it("アカウントの DO に届かなければ送り直す。チームの様子が取れなければ 3 回で「計算していない」", async () => {
    const all = makeAll({ failRecord: 1, failPay: 0 });
    const u1 = await user(all, 1);
    await all.league.poke();
    expect(await all.league.step()).toMatchObject({ status: "done" });
    await all.league.flushOutbox();
    expect(all.league.outboxSize()).toBe(1);
    await all.league.flushOutbox();
    expect(all.league.outboxSize()).toBe(0);
    expect(all.a.db.prepare("SELECT who FROM familiarity WHERE who = ?").all(`s:${u1.id}`)).toHaveLength(1);

    const b = makeAll({ failTeams: 5 });
    const v1 = await user(b, 1);
    await b.league.poke();
    expect(await b.league.step()).toMatchObject({ status: "retry" });
    expect(await b.league.step()).toMatchObject({ status: "retry" });
    expect(await b.league.step()).toMatchObject({ status: "not_computed" });
    expect(b.league.pending()).toBe(0);
    expect(b.league.myResults(v1.tid)[0].status).toBe("not_computed");
  });

  it("退会したチームは次の枠でリーグから外れ、空いた席はコンピューターが埋める", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    const u2 = await user(all, 2);
    await all.league.poke();
    all.a.db.prepare("DELETE FROM accounts WHERE id = ?").run(u2.id);
    all.clock.t += 2 * 3_600_000;
    await all.league.poke();
    const l = all.league.state().leagues[0];
    expect(l.humans).toEqual([u1.tid]);
    expect(l.cpus).toHaveLength(3);
    await drain(all);
    const race = all.league.myResults(u1.tid)[0];
    expect(race.cars.some((c) => c.teamId === u2.tid)).toBe(false);
    expect(race.cars).toHaveLength(8);
  });

  it("管理者が止めた人のチームは、止めている間 リーグ戦に出ない (席は残る)。全員止めたら計算しない", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    const u2 = await user(all, 2);
    all.a.db.prepare("INSERT INTO suspended (account_id, reason, at) VALUES (?, '', 0)").run(u2.id);
    await all.league.poke();
    expect(all.league.state().leagues[0].humans).toEqual([u1.tid, u2.tid]);
    await drain(all);
    const race = all.league.myResults(u1.tid)[0];
    expect(race.status).toBe("done");
    expect(race.cars.some((c) => c.teamId === u2.tid)).toBe(false);
    expect(all.league.myResults(u2.tid)).toHaveLength(0);
    // 全員止めた: 計算しない
    all.a.db.prepare("INSERT INTO suspended (account_id, reason, at) VALUES (?, '', 0)").run(u1.id);
    all.clock.t += 2 * 3_600_000;
    await all.league.poke();
    expect((await drain(all))[0]).toMatch(/^not_computed:/);
    // 戻すとまた走る
    all.a.db.prepare("DELETE FROM suspended").run();
    all.clock.t += 2 * 3_600_000;
    await all.league.poke();
    await drain(all);
    expect(all.league.myResults(u2.tid)[0].cars.filter((c) => c.teamId === u2.tid)).toHaveLength(2);
  });

  it("肩書き: 1 部の人のうち一番が王者 (日の締めで決まる)", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    expect(all.league.titles([u1.tid, "999"])).toEqual({});
    await all.league.poke();
    expect(all.league.titles([u1.tid])).toEqual({ [u1.tid]: "製図見習い" });
  });
});

describe("/api/league", () => {
  it("ログインが要る。開くとリーグに入り、部と肩書き・段・次のレースが見える", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    const anon = await handleLeagueApi(new Request("http://x/api/league"), all.league, all.port);
    expect(anon.status).toBe(401);
    const next = await handleLeagueApi(new Request("http://x/api/league/next"), all.league, all.port);
    expect(next.status).toBe(200);
    const nx = (await next.json()) as { at: number; laps: number };
    expect(nx.at).toBe(scheduledSlotStart(scheduledSlotIndex(all.clock.t) + 1));
    expect(nx.laps).toBe(5);
    const me = await u1.league("GET", "/api/league");
    expect(me.status).toBe(200);
    expect(me.data.league.division).toBe(8);
    expect(me.data.league.title).toBe("製図見習い");
    expect(me.data.league.rows).toHaveLength(4);
    expect(me.data.league.rows.filter((r: { mine: boolean }) => r.mine)).toHaveLength(1);
    const ladder = await u1.league("GET", "/api/league/ladder");
    expect(ladder.data.divisions).toHaveLength(8);
    expect(ladder.data.divisions[0].title).toBe("技術監督");
    expect(ladder.data.divisions[7]).toMatchObject({ division: 8, humans: 1, mine: true });
    expect(ladder.data.champion).toBeNull();
    expect((await u1.league("GET", "/api/league/results")).data.results).toEqual([]);
  });

  it("開発用の受け口は dev のときだけ。次の枠を今すぐ積む", async () => {
    const all = makeAll();
    const u1 = await user(all, 1);
    expect((await u1.league("POST", "/api/league/dev/slot")).status).toBe(404);
    const a = await u1.league("POST", "/api/league/dev/slot", true);
    expect(a.status).toBe(200);
    expect(a.data.pending).toBe(1);
    const b = await u1.league("POST", "/api/league/dev/slot", true);
    expect(b.data.slot).toBe(a.data.slot + 1);
    await drain(all);
    expect(all.league.myResults(u1.tid)).toHaveLength(2);
    expect((await u1.league("POST", "/api/league/dev/reset", true)).status).toBe(200);
    expect(all.league.pending()).toBe(0);
  });
});
