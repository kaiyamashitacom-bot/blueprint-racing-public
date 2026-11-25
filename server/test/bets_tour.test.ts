// 大会の優勝に賭ける (bets_tour.ts) の試験: 組が決まってからスタートまで・A 組のチームは不可・お金だけ・倍率・払い・A 組の結果なしは返す・本物のお金の止め
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SAMPLE_DESIGN, seasonWindow, type FixedCarResult } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { TeamStore } from "../src/team.ts";
import { LOBBY_LEAD_MS, SeasonStore, humanDriverId } from "../src/season.ts";
import { BetStore } from "../src/bets.ts";
import { handleTourBetsApi, settleTourBets, tourBetRaceId } from "../src/bets_tour.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function makeAll() {
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
  const w = seasonWindow(1);
  const clock = { t: w.startsAt + DAY + 3 * HOUR };
  const store = new AccountStore({ sql, tx, now: () => clock.t, iterations: 1000, adminIds: ["boss"] });
  const team = new TeamStore({ sql, tx, now: () => clock.t }, store);
  const ref: { bets?: BetStore } = {};
  const season: SeasonStore = new SeasonStore(
    { sql, tx, now: () => clock.t, teamInfo: (acc, d) => team.raceTeam(acc, d), onTournamentClosed: (id) => void settleTourBets(season, ref.bets!, id) },
    store,
  );
  const bets = new BetStore({ sql, tx, now: () => clock.t, config: () => season.config() }, store);
  ref.bets = bets;
  return { db, store, team, season, bets, clock };
}

type All = ReturnType<typeof makeAll>;

async function user(all: All, login: string, n: number, money = 1000) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `7.7.7.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), all.store, undefined, all.team, all.season, {});
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: login, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(login)!.id);
  all.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(money, id);
  const bet = async (method: string, body?: unknown) => {
    const res = await handleTourBetsApi(
      new Request("http://x/api/tourbets", { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }),
      "/api/tourbets",
      method,
      all.store,
      all.season,
      all.bets,
    );
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };
  return { call, bet, id };
}

const money = (all: All, id: number) => Number(all.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);

/** 管理者の大会 (2 台ずつの組)。a, b, c, d が組だけ決めて出る (予選の記録なし → チームの番号の順: A = a, b / B = c, d)。e は出ない */
async function setup() {
  const all = makeAll();
  const boss = await user(all, "boss", 1);
  const a = await user(all, "alice", 2);
  const b = await user(all, "bob", 3);
  const c = await user(all, "carol", 4);
  const d = await user(all, "dave", 5);
  const e = await user(all, "erin", 6);
  const day = seasonWindow(all.season.tally().season).startsAt;
  const startsAt = day + 3 * DAY + 20 * HOUR;
  const cr = await boss.call("POST", "/api/admin/tournaments", { name: "冬の杯", startsAt, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" }, groupSize: 2 });
  expect(cr.status).toBe(201);
  const id = cr.data.tournament.id as string;
  for (const u of [a, b, c, d]) {
    expect((await u.call("POST", `/api/tournaments/${id}/tires`, { alloc: { M: 2, H: 2 } })).status).toBe(200);
    expect((await u.call("POST", `/api/tournaments/${id}/plan`, { design: SAMPLE_DESIGN, fuel: "full", start: { tire: "M" } })).status).toBe(200);
  }
  return { all, boss, a, b, c, d, e, id, startsAt };
}

const row = (team: number, pos: number): FixedCarResult => ({
  key: `acc:${team}`,
  teamId: String(team),
  driverId: humanDriverId(team),
  kind: "human",
  pos,
  gridPos: pos,
  finished: true,
  retired: false,
  lapsDone: 2,
  best: 30 + pos,
  penalty: 0,
  pitStops: 1,
  standIn: false,
  stints: [
    { tire: "M", meters: 900, dry: true },
    { tire: "H", meters: 900, dry: true },
  ],
  maxWet: 0,
});

describe("大会の優勝に賭ける", () => {
  it("組が決まるまでは賭けられない → A 組の倍率 → A 組のチームは不可 → 賭ける → 優勝で払う", async () => {
    const { all, a, b, c, d, e, id, startsAt } = await setup();
    // 組が決まる前: 一覧には「これからの大会」だけ。賭けは 409
    const g0 = await c.bet("GET");
    expect(g0.status).toBe(200);
    expect(g0.data.tours).toEqual([]);
    expect(g0.data.upcoming[0]).toMatchObject({ tourId: id, opensAt: startsAt - LOBBY_LEAD_MS });
    expect((await c.bet("POST", { tourId: id, car: "0", stake: 100 })).status).toBe(409);

    // スタートの 10 分前: 組を開く
    all.clock.t = startsAt - LOBBY_LEAD_MS;
    all.season.tick();
    const g1 = await c.bet("GET");
    expect(g1.data.tours.length).toBe(1);
    const book = g1.data.tours[0];
    expect(book).toMatchObject({ tourId: id, group: "A", open: true, mine: false, closesAt: startsAt });
    expect(book.cars.map((x: any) => [x.driver, x.grid])).toEqual([
      ["運転手2", 1],
      ["運転手3", 2],
    ]);
    // 予選の記録が無いので強さの見込み。同じ車なら前の並びが強い
    expect(book.cars[0].qualiLap).toBeNull();
    expect(book.cars[0].estLap).toBeGreaterThan(0);
    expect(book.cars[0].pWin).toBeGreaterThan(book.cars[1].pWin);
    expect(book.cars[0].odds).toBeLessThan(book.cars[1].odds);
    // A 組のチーム (a, b) は不可
    expect((await a.bet("GET")).data.tours[0].mine).toBe(true);
    expect((await b.bet("POST", { tourId: id, car: "0", stake: 100, odds: book.cars[0].odds })).status).toBe(403);
    // お金のほかの物は断る・知らない車
    expect((await c.bet("POST", { tourId: id, car: "0", stake: 100, item: "x" })).status).toBe(400);
    expect((await c.bet("POST", { tourId: id, car: "7", stake: 100 })).status).toBe(400);
    // 倍率が違えば今の表を返す
    const stale = await c.bet("POST", { tourId: id, car: "0", stake: 100, odds: 99 });
    expect(stale.status).toBe(409);
    expect(stale.data.book.tourId).toBe(id);
    // B 組の c と 出ていない e は賭けられる
    const pc = await c.bet("POST", { tourId: id, car: "0", stake: 100, odds: book.cars[0].odds });
    expect(pc.status).toBe(201);
    expect(pc.data.bet).toMatchObject({ raceId: tourBetRaceId(id), kind: "tourwin", stake: 100, status: "open" });
    expect(money(all, c.id)).toBe(900);
    expect((await e.bet("POST", { tourId: id, car: "1", stake: 50, odds: book.cars[1].odds })).status).toBe(201);
    // 一時停止・本物のお金の止め
    all.season.setConfig({ betPaused: true });
    expect((await e.bet("POST", { tourId: id, car: "1", stake: 50 })).status).toBe(503);
    all.season.setConfig({ betPaused: false, realMoneyEnabled: true });
    expect((await e.bet("GET")).status).toBe(503);
    all.season.setConfig({ realMoneyEnabled: false });
    // スタートで締め切り
    all.clock.t = startsAt;
    expect((await e.bet("POST", { tourId: id, car: "1", stake: 50 })).status).toBe(409);

    // 結果: A 組は a が 1 位 → c の当たり、e の外れ
    all.clock.t = startsAt + 5 * 60_000;
    all.season.recordTournamentGroup(`${id}:0`, [row(a.id, 1), row(b.id, 2)], all.clock.t);
    const mc = money(all, c.id);
    const me = money(all, e.id);
    expect(all.season.recordTournamentGroup(`${id}:1`, [row(c.id, 1), row(d.id, 2)], all.clock.t)).toBe(true);
    const cBets = all.bets.mine(c.id);
    expect(cBets.history[0]).toMatchObject({ status: "won", payout: Math.floor(100 * book.cars[0].odds + 1e-6) });
    // 大会の賞金とは別に、賭けの払いが入っている
    const log = all.db.prepare("SELECT delta FROM wallet_log WHERE account_id = ? AND reason = 'bet_win'").all(c.id) as Array<{ delta: number }>;
    expect(log.map((r) => Number(r.delta))).toEqual([Math.floor(100 * book.cars[0].odds + 1e-6)]);
    expect(money(all, c.id)).toBeGreaterThan(mc);
    expect(all.bets.mine(e.id).history[0]).toMatchObject({ status: "lost", payout: 0 });
    expect(money(all, e.id)).toBe(me);
    // 2 回目は払わない
    expect(settleTourBets(all.season, all.bets, id)).toBe(0);
  });

  it("A 組の結果が来ないまま決まった大会の賭けは返す", async () => {
    const { all, c, d, id, startsAt } = await setup();
    all.clock.t = startsAt - LOBBY_LEAD_MS;
    all.season.tick();
    const book = (await c.bet("GET")).data.tours[0];
    expect((await c.bet("POST", { tourId: id, car: "1", stake: 300, odds: book.cars[1].odds })).status).toBe(201);
    expect(money(all, c.id)).toBe(700);
    // B 組だけ届いて、締め切りを過ぎて決まる
    all.clock.t = startsAt + 5 * 60_000;
    all.season.recordTournamentGroup(`${id}:1`, [row(c.id, 1), row(d.id, 2)], all.clock.t);
    expect(all.season.finalizeTournament(id, true)).toBe(true);
    expect(all.bets.mine(c.id).history[0]).toMatchObject({ status: "void", payout: 300 });
    expect(money(all, c.id)).toBeGreaterThanOrEqual(1000);
  });
});
