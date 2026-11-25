// 走行点と交換所 (server/src/racepoints.ts・shared/src/racepoints.ts) の試験。DO の SQLite の代わりに node:sqlite を使う (tourprize.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_CONFIG,
  DEFAULT_RP_SHOP,
  ITEM_IDS,
  SAMPLE_DESIGN,
  SHARDS_PER_ITEM,
  checkGiftItem,
  checkRpShopInput,
  defaultTournamentPrizes,
  giftItemsByName,
  jstDayStart,
  jstWeekStart,
  rpCapped,
  rpForRace,
  rpForTa,
  rpMonthEstimate,
  seasonWindow,
  type FixedCarResult,
  type GiftItem,
} from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { GiftStore, handleGiftApi } from "../src/gift.ts";
import { leagueTeamData } from "../src/league_accounts.ts";
import { RP_BUY_PER_MIN, RacePointStore, earnTaLap, handleRacePointsApi } from "../src/racepoints.ts";
import { LOBBY_LEAD_MS, SeasonStore, fillerDriverId, humanDriverId, type RaceFeed, type RaceFeedCar } from "../src/season.ts";
import { TeamStore } from "../src/team.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
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
  // 季節 1 の火曜の昼 (日本時間)
  const clock = { t: seasonWindow(1).startsAt + DAY + 3 * HOUR };
  const now = () => clock.t;
  let gifts: GiftStore | null = null;
  const store = new AccountStore({ sql, tx, now, iterations: 1000, adminIds: ["boss"] });
  const team = new TeamStore({ sql, tx, now }, store);
  const season = new SeasonStore(
    {
      sql,
      tx,
      now,
      teamInfo: (acc, d) => team.raceTeam(acc, d),
      classMoves: () => gifts!.takeClassMoves(),
      grantPrizes: (acc, items, at) => gifts!.grantInTx(acc, items, at),
      teamData: (acc) => leagueTeamData(store, team, String(acc)),
    },
    store,
  );
  gifts = new GiftStore({ sql, tx, now, caps: () => season.config() }, store, team, season);
  const rp = new RacePointStore({ sql, tx, now, config: () => season.config() }, store, gifts);
  return { db, sql, store, team, season, gifts, rp, clock };
}
type All = ReturnType<typeof makeAll>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; data: Record<string, any> };

async function user(all: All, login: string, n: number) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const headers: Record<string, string> = { "cf-connecting-ip": `5.5.5.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = /^\/api\/(rp|admin\/rp)(\/|$)/.test(path)
      ? await handleRacePointsApi(req, path, method, all.store, all.rp)
      : /^\/api\/(gift|admin\/gifts)(\/|$)/.test(path)
        ? await handleGiftApi(req, path, method, all.store, all.gifts)
        : await handleApi(req, all.store, undefined, all.team, all.season, {});
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: login, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(login)!.id);
  return { call, id };
}
type User = Awaited<ReturnType<typeof user>>;

const points = (all: All, id: number) => Number(all.db.prepare("SELECT points FROM rp_wallet WHERE account_id = ?").get(id)?.points ?? 0);
const ledger = (all: All, id: number) => all.db.prepare("SELECT delta, kind FROM rp_ledger WHERE account_id = ? ORDER BY id").all(id) as Array<{ delta: number; kind: string }>;
const money = (all: All, id: number) => Number(all.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);
/** 走行点を直に入れる (交換の試験用。帳簿は gift) */
const give = (all: All, id: number, n: number) => all.db.prepare("INSERT INTO rp_wallet (account_id, points, day, day_earned) VALUES (?, ?, 0, 0) ON CONFLICT(account_id) DO UPDATE SET points = points + excluded.points").run(id, n);

let raceN = 0;
function feed(all: All, cars: RaceFeedCar[], laps = 5): RaceFeed {
  return { raceId: `r${++raceN}`, at: all.clock.t, laps, trackId: "aozu", humans: cars.filter((c) => c.accountId !== undefined).length, maxWet: 0, cars };
}
const car = (id: string, pos: number, o: Partial<RaceFeedCar> = {}): RaceFeedCar => ({ id, pos, finished: true, fastest: false, penalty: 0, ...o });

describe("走行点の決まり (shared)", () => {
  const cfg = DEFAULT_ADMIN_CONFIG;
  it("完走で点・順位が良いほど少し多め・周の数で増える。完走できず・失格は 0。切なら 0", () => {
    expect(rpForRace(cfg, { pos: 1, finished: true }, { laps: 2, kind: "everyday" })).toBe(15);
    expect(rpForRace(cfg, { pos: 5, finished: true }, { laps: 2, kind: "everyday" })).toBe(11);
    expect(rpForRace(cfg, { pos: 6, finished: true }, { laps: 2, kind: "everyday" })).toBe(10);
    expect(rpForRace(cfg, { pos: 8, finished: true }, { laps: 2, kind: "everyday" })).toBe(10);
    expect(rpForRace(cfg, { pos: 1, finished: true }, { laps: 5, kind: "everyday" })).toBe(26);
    expect(rpForRace(cfg, { pos: 1, finished: true }, { laps: 10, kind: "everyday" })).toBe(45);
    expect(rpForRace(cfg, { pos: 1, finished: false }, { laps: 10, kind: "everyday" })).toBe(0);
    expect(rpForRace(cfg, { pos: 1, finished: true, dq: true }, { laps: 10, kind: "tournament" })).toBe(0);
    expect(rpForRace({ ...cfg, rpTourMul: 2 }, { pos: 1, finished: true }, { laps: 10, kind: "tournament" })).toBe(90);
    expect(rpForRace({ ...cfg, rpOn: false }, { pos: 1, finished: true }, { laps: 5, kind: "everyday" })).toBe(0);
    expect(rpForTa(cfg, false)).toBe(1);
    expect(rpForTa(cfg, true)).toBe(5);
    expect(rpCapped(26, 140, 150)).toBe(10);
    expect(rpCapped(26, 150, 150)).toBe(0);
  });

  it("1 か月の目安: 上限 150 × 30 日 + 毎日の大会 + 参加賞 ≒ 6,400 点。かけら 10 個 (限界設計図 1 つ) がほぼ 1 か月", () => {
    const m = rpMonthEstimate(cfg);
    expect(m.capped).toBe(4500);
    expect(m.tour).toBe(900);
    expect(m.prize).toBe(986);
    const shard = DEFAULT_RP_SHOP.find((e) => e.items[0].kind === "item" && e.items[0].p.item === ITEM_IDS.limitShard)!;
    const months = (shard.price * SHARDS_PER_ITEM) / m.total;
    expect(months).toBeGreaterThan(0.8);
    expect(months).toBeLessThan(1.2);
    // 週 3 個まで → 1 か月で多くても 13 個ほど (ためた点で一気に買えない)
    expect(shard.limitWeek).toBe(3);
  });

  it("週は日本時間の月曜 0:00 から", () => {
    const tue = Date.UTC(2026, 10, 24, 3); // 11/24 (火) 12:00 日本時間
    expect(jstWeekStart(tue)).toBe(Date.UTC(2026, 10, 23) - 9 * HOUR);
    const sunNight = Date.UTC(2026, 10, 29, 14, 59); // 11/29 (日) 23:59 日本時間
    expect(jstWeekStart(sunNight)).toBe(Date.UTC(2026, 10, 23) - 9 * HOUR);
    expect(jstWeekStart(Date.UTC(2026, 10, 29, 15))).toBe(Date.UTC(2026, 10, 30) - 9 * HOUR);
  });

  it("はじめの交換所は全部 形が通る", () => {
    for (const e of DEFAULT_RP_SHOP) expect(checkRpShopInput(e).ok, e.name).toBe(true);
    expect(checkRpShopInput({ name: "", items: [{ kind: "money", p: { amount: 1 } }], price: 1 }).ok).toBe(false);
    expect(checkRpShopInput({ name: "a", items: [], price: 1 }).ok).toBe(false);
    expect(checkRpShopInput({ name: "a", items: [{ kind: "money", p: { amount: 1 } }], price: 0 }).ok).toBe(false);
    expect(checkRpShopInput({ name: "a", items: [{ kind: "money", p: { amount: 1 } }], price: 5, limitWeek: 0 }).ok).toBe(false);
  });
});

describe("走行点がたまる", () => {
  it("すぐ走る・部屋: 自分で走った 1 台目だけ。代走・雇った運転手の 2 台目・完走できず・名無しは 0。知らせの形 (paid.rp)", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const b = await user(all, "bob", 2);
    const c = await user(all, "carol", 3);
    const paid = all.season.recordRace(
      feed(all, [
        car("p1", 1, { accountId: a.id }),
        car("p2", 2, { ownerAccountId: a.id, hiredDriverId: "d1" }),
        car("p3", 3, { accountId: b.id, standIn: true }),
        car("p4", 4, { accountId: c.id, finished: false }),
        car("cpu", 5),
      ]),
    ).paid;
    expect(points(all, a.id)).toBe(rpForRace(DEFAULT_ADMIN_CONFIG, { pos: 1, finished: true }, { laps: 5, kind: "everyday" }));
    expect(points(all, b.id)).toBe(0);
    expect(points(all, c.id)).toBe(0);
    expect(paid[a.id].rp).toEqual({ earned: 26, wanted: 26, left: 150 - 26, points: 26 });
    expect(paid[b.id]?.rp).toBeUndefined();
    expect(ledger(all, a.id)).toEqual([{ delta: 26, kind: "race" }]);
    // 同じレースは 2 回数えない
    const f = feed(all, [car("p1", 1, { accountId: a.id })]);
    all.season.recordRace(f);
    all.season.recordRace(f);
    expect(points(all, a.id)).toBe(52);
  });

  it("1 日の上限: レースは上限まで (削られる)、次の日 (日本時間 0 時) に戻る。大会・ギフトは上限の外", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const cap = DEFAULT_ADMIN_CONFIG.rpDailyCap;
    let last: ReturnType<SeasonStore["recordRace"]>["paid"][number] | undefined;
    for (let i = 0; i < 8; i++) {
      all.clock.t += 6 * MIN;
      last = all.season.recordRace(feed(all, [car("p1", 1, { accountId: a.id })], 10)).paid[a.id];
    }
    expect(points(all, a.id)).toBe(cap);
    expect(last!.rp).toMatchObject({ earned: 0, wanted: 45, left: 0 });
    // 上限で削られた回は「上限まで」
    const rows = ledger(all, a.id);
    expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(cap);
    expect(rows.at(-1)!.delta).toBe(cap - 45 * 3);
    // 状態の受け口
    const st = (await a.call("GET", "/api/rp")).data;
    expect(st).toMatchObject({ on: true, points: cap, today: cap, left: 0, cap });
    // ギフトの走行点は上限の外
    const boss = await user(all, "boss", 9);
    const g = await boss.call("POST", "/api/admin/gifts", { items: [{ kind: "race_points", p: { amount: 70 } }], code: "RPTEST01" });
    expect(g.status).toBe(201);
    expect((await a.call("POST", "/api/gift", { code: "RPTEST01" })).status).toBe(200);
    expect(points(all, a.id)).toBe(cap + 70);
    expect(ledger(all, a.id).at(-1)).toEqual({ delta: 70, kind: "gift" });
    // 次の日 (日本時間 0 時) で戻る
    all.clock.t = jstDayStart(all.clock.t) + DAY + 5 * MIN;
    const p = all.season.recordRace(feed(all, [car("p1", 2, { accountId: a.id })], 2)).paid[a.id];
    expect(p.rp).toMatchObject({ earned: 14, left: cap - 14 });
    expect((await a.call("GET", "/api/rp")).data).toMatchObject({ today: 14, left: cap - 14 });
  });

  it("走行点を切にすると たまらない・交換できない (ギフトは入る)", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    all.season.setConfig({ rpOn: false }, "test");
    all.season.recordRace(feed(all, [car("p1", 1, { accountId: a.id })]));
    expect(points(all, a.id)).toBe(0);
    give(all, a.id, 10_000);
    const shop = (await a.call("GET", "/api/rp")).data.shop as Array<{ id: number }>;
    const r = await a.call("POST", "/api/rp/buy", { id: shop[0].id });
    expect(r.status).toBe(403);
    expect(points(all, a.id)).toBe(10_000);
  });

  it("1 周アタック: 確かめの通った周ごと 1 点・記録更新 5 点 (上限あり)", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const cfg = DEFAULT_ADMIN_CONFIG;
    expect(earnTaLap(all.sql, cfg, a.id, false, all.clock.t)).toMatchObject({ earned: 1, left: 149 });
    expect(earnTaLap(all.sql, cfg, a.id, true, all.clock.t)).toMatchObject({ earned: 5, left: 144 });
    expect(ledger(all, a.id).map((r) => r.kind)).toEqual(["ta", "ta"]);
    // 上限で止まる
    all.season.recordRace(feed(all, [car("p1", 1, { accountId: a.id })], 10));
    all.season.recordRace(feed(all, [car("p1", 1, { accountId: a.id })], 10));
    all.season.recordRace(feed(all, [car("p1", 1, { accountId: a.id })], 10));
    // 6 + 45 × 3 = 141 → 記録更新 5 点 → 残り 4 → レースで上限 → もう入らない
    expect(earnTaLap(all.sql, cfg, a.id, true, all.clock.t)).toMatchObject({ earned: 5, left: 4 });
    all.season.recordRace(feed(all, [car("p1", 1, { accountId: a.id })], 10));
    expect(earnTaLap(all.sql, cfg, a.id, true, all.clock.t)).toMatchObject({ earned: 0, left: 0 });
    expect(points(all, a.id)).toBe(150);
    expect(earnTaLap(all.sql, cfg, 9999, true, all.clock.t)).toBeNull();
  });

  it("リーグ戦 (いつも代走) はアカウントの係に走行点を入れない (日の締めのコンストラクターの点だけ)", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    expect(all.season.addLeagueDay("day1", { [String(a.id)]: 30 }, { champion: String(a.id) })).toBe(true);
    expect(points(all, a.id)).toBe(0);
    expect(ledger(all, a.id)).toEqual([]);
  });
});

/** 管理者が大会を作り、users が予定を決めて出場。スタートの 10 分前まで進めて組を開く (tourprize.test.ts と同じ) */
async function tourWith(all: All, boss: User, users: User[], extra: Record<string, unknown> = {}) {
  const day = seasonWindow(1).startsAt;
  const startsAt = day + 3 * DAY + 20 * HOUR;
  const cr = await boss.call("POST", "/api/admin/tournaments", { name: "走行点の杯", startsAt, trackId: "aozu", laps: 10, weather: { mode: "fixed", sky: "sun" }, groupSize: 8, ...extra });
  expect(cr.status).toBe(201);
  const id = cr.data.tournament.id as string;
  for (const u of users) {
    expect((await u.call("POST", `/api/tournaments/${id}/tires`, { alloc: { M: 2, H: 2 } })).status).toBe(200);
    expect((await u.call("POST", `/api/tournaments/${id}/plan`, { design: SAMPLE_DESIGN })).status).toBe(200);
  }
  all.clock.t = startsAt - LOBBY_LEAD_MS;
  all.season.tick();
  all.clock.t = startsAt + 5 * MIN;
  return { id, startsAt };
}
const dry2 = [
  { tire: "M" as const, meters: 900, dry: true },
  { tire: "H" as const, meters: 900, dry: true },
];
const row = (team: number, pos: number, o: Partial<FixedCarResult> = {}): FixedCarResult => ({
  key: `acc:${team}`,
  teamId: String(team),
  driverId: humanDriverId(team),
  kind: "human",
  pos,
  gridPos: pos,
  finished: true,
  retired: false,
  lapsDone: 10,
  best: 30 + pos,
  penalty: 0,
  pitStops: 1,
  standIn: false,
  stints: dry2,
  maxWet: 0,
  ...o,
});

describe("大会の走行点", () => {
  it("自分で走った人だけ (代走・雇った運転手は 0)。上限の外。参加賞の走行点は代走ももらう (はじめの景品が走行点になった)", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const [a, b, c] = [await user(all, "alice", 2), await user(all, "bob", 3), await user(all, "carol", 4)];
    // a は今日もう上限まで走った
    for (let i = 0; i < 4; i++) all.season.recordRace(feed(all, [car("p1", 1, { accountId: a.id })], 10));
    expect(points(all, a.id)).toBe(150);
    const { id } = await tourWith(all, boss, [a, b, c], { grade: "中" });
    const part = defaultTournamentPrizes("中").participation;
    expect(part).toEqual([{ kind: "race_points", p: { amount: 30 } }]);
    const before = [a, b, c].map((u) => points(all, u.id));
    // a 1 位 (自分で)、b 2 位 (代走)、b の雇った運転手 (埋め草) 3 位、c 完走できず
    expect(
      all.season.recordTournamentGroup(
        `${id}:0`,
        [row(a.id, 1), row(b.id, 2, { standIn: true }), row(b.id, 3, { key: `s${b.id}`, kind: "hired", driverId: fillerDriverId(b.id) }), row(c.id, 4, { finished: false, lapsDone: 3 })],
        all.clock.t,
      ),
    ).toBe(true);
    const cfg = DEFAULT_ADMIN_CONFIG;
    const won = rpForRace(cfg, { pos: 1, finished: true }, { laps: 10, kind: "tournament" });
    expect(points(all, a.id) - before[0]).toBe(won + 30);
    expect(points(all, b.id) - before[1]).toBe(30);
    expect(points(all, c.id) - before[2]).toBe(0);
    expect(ledger(all, a.id).slice(-2).map((r) => r.kind).sort()).toEqual(["prize", "tour"]);
    const v = (await a.call("GET", `/api/tournaments/${id}`)).data;
    const mine = v.results.find((r: any) => r.teamId === String(a.id));
    expect(mine.rp).toBe(won);
    expect(mine.gifts).toContain("参加賞: 走行点 30");
    expect(v.results.find((r: any) => r.teamId === String(b.id) && r.standIn).rp).toBeUndefined();
  });
});

describe("ギフトの種類「走行点」", () => {
  it("登録表にあり、形が通り、名前で探せる (大会のはじめの参加賞)。ギフトコードで受け取れる", async () => {
    expect(checkGiftItem({ kind: "race_points", p: { amount: 50 } }).ok).toBe(true);
    expect(checkGiftItem({ kind: "race_points", p: { amount: 0 } }).ok).toBe(false);
    expect(giftItemsByName("走行点", 50)).toEqual([{ kind: "race_points", p: { amount: 50 } }]);
    expect(defaultTournamentPrizes("大").participation).toEqual([{ kind: "race_points", p: { amount: 50 } }]);
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    expect((await boss.call("POST", "/api/admin/gifts", { code: "RPGIFT", items: [{ kind: "race_points", p: { amount: 250 } }, { kind: "money", p: { amount: 5 } }] })).status).toBe(201);
    const r = await a.call("POST", "/api/gift", { code: "rpgift" });
    expect(r.status).toBe(200);
    expect(r.data.received).toContain("走行点 250");
    expect(points(all, a.id)).toBe(250);
    expect((await a.call("GET", "/api/rp")).data).toMatchObject({ points: 250, today: 0 });
  });
});

describe("交換所", () => {
  it("はじめの一覧が入る (1 回だけ)。遊ぶ人には しまった物は出さない", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const st = (await a.call("GET", "/api/rp")).data;
    expect(st.shop.map((e: any) => e.name)).toEqual(DEFAULT_RP_SHOP.map((e) => e.name));
    expect(st.shop[0]).toMatchObject({ price: 600, limitWeek: 3, limitTotal: null, boughtWeek: 0, lines: ["限界突破のかけら ×1"] });
    // 作り直しても増えない
    new RacePointStore({ sql: all.sql, tx: (fn) => fn(), now: () => all.clock.t, config: () => all.season.config() }, all.store, all.gifts);
    expect((await a.call("GET", "/api/rp")).data.shop).toHaveLength(DEFAULT_RP_SHOP.length);
  });

  it("管理者だけが 一覧を見る・足す・直す・しまう・消す (ほかの人は 403、ログインなしは 401)。おかしな中身は 400", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const item: GiftItem = { kind: "money", p: { amount: 100 } };
    for (const [m, p, b] of [
      ["GET", "/api/admin/rp"],
      ["POST", "/api/admin/rp/shop", { name: "x", items: [item], price: 1 }],
      ["PUT", "/api/admin/rp/shop/1", { price: 2 }],
      ["DELETE", "/api/admin/rp/shop/1"],
    ] as Array<[string, string, unknown?]>) {
      expect((await a.call(m, p, b)).status, `${m} ${p}`).toBe(403);
    }
    const anon = await handleRacePointsApi(new Request("http://x/api/admin/rp"), "/api/admin/rp", "GET", all.store, all.rp);
    expect(anon.status).toBe(401);
    expect((await boss.call("POST", "/api/admin/rp/shop", { name: "x", items: [{ kind: "nope", p: {} }], price: 1 })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/rp/shop", { name: "x", items: [item], price: -1 })).status).toBe(400);

    const cr = await boss.call("POST", "/api/admin/rp/shop", { name: "お金 100", note: "ためし", items: [item], price: 40, limitWeek: 2 });
    expect(cr.status).toBe(201);
    const id = cr.data.entry.id as number;
    expect(cr.data.entry).toMatchObject({ name: "お金 100", price: 40, limitWeek: 2, limitTotal: null, hidden: false, lines: ["お金 100"], sold: 0 });
    const up = await boss.call("PUT", `/api/admin/rp/shop/${id}`, { price: 45, limitTotal: 5, hidden: true });
    expect(up.data.entry).toMatchObject({ name: "お金 100", price: 45, limitWeek: 2, limitTotal: 5, hidden: true });
    // しまった物は遊ぶ人に出ず、交換もできない
    expect((await a.call("GET", "/api/rp")).data.shop.some((e: any) => e.id === id)).toBe(false);
    give(all, a.id, 1000);
    expect((await a.call("POST", "/api/rp/buy", { id })).status).toBe(404);
    const v = (await boss.call("GET", "/api/admin/rp")).data;
    expect(v.shop.find((e: any) => e.id === id)).toMatchObject({ hidden: true });
    expect((await boss.call("DELETE", `/api/admin/rp/shop/${id}`)).status).toBe(200);
    expect((await boss.call("DELETE", `/api/admin/rp/shop/${id}`)).status).toBe(404);
    expect((await boss.call("PUT", `/api/admin/rp/shop/${id}`, { price: 1 })).status).toBe(404);
  });

  it("交換は 1 回の取りまとめ: 点を引いて中身を当てる。当てられなければ点も記録も戻る。足りなければ断る", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const shop = (await a.call("GET", "/api/rp")).data.shop as Array<{ id: number; name: string; price: number }>;
    const shard = shop.find((e) => e.name === "限界突破のかけら")!;
    const research = shop.find((e) => e.name.startsWith("研究"))!;
    // 足りない
    give(all, a.id, 100);
    const poor = await a.call("POST", "/api/rp/buy", { id: shard.id });
    expect(poor.status).toBe(409);
    expect(poor.data.error).toContain("足りません");
    give(all, a.id, 900);
    // 研究していない → 中身が当てられない → 全部戻る
    const m0 = money(all, a.id);
    const r0 = await a.call("POST", "/api/rp/buy", { id: research.id });
    expect(r0.status).toBe(409);
    expect(r0.data.error).toContain("研究");
    expect(points(all, a.id)).toBe(1000);
    expect(all.db.prepare("SELECT COUNT(*) AS c FROM rp_buys").get()!.c).toBe(0);
    expect(ledger(all, a.id).filter((r) => r.kind === "buy")).toEqual([]);
    // かけら: 点が減り、持ち物に入り、記録に残る
    const r1 = await a.call("POST", "/api/rp/buy", { id: shard.id });
    expect(r1.status).toBe(200);
    expect(r1.data).toMatchObject({ received: ["限界突破のかけら ×1"], points: 400, money: m0 });
    expect(points(all, a.id)).toBe(400);
    expect(Number(all.db.prepare("SELECT n FROM inventory WHERE account_id = ? AND part_id = ?").get(a.id, ITEM_IDS.limitShard)!.n)).toBe(1);
    const st = (await a.call("GET", "/api/rp")).data;
    expect(st.buys).toEqual([{ at: all.clock.t, name: "限界突破のかけら", price: 600, lines: ["限界突破のかけら ×1"] }]);
    expect(st.shop.find((e: any) => e.id === shard.id)).toMatchObject({ boughtWeek: 1, boughtTotal: 1 });
    expect(st.ledger[0]).toMatchObject({ delta: -600, kind: "buy" });
    // 合計 (管理者)
    const v = (await boss.call("GET", "/api/admin/rp")).data;
    expect(v.totals).toMatchObject({ spent: 600, outstanding: 400, holders: 1 });
    expect(v.shop.find((e: any) => e.id === shard.id).sold).toBe(1);
    // 知らない物
    expect((await a.call("POST", "/api/rp/buy", { id: 99999 })).status).toBe(404);
    expect((await a.call("POST", "/api/rp/buy", { id: "x" })).status).toBe(400);
  });

  it("中身の途中で落ちても (2 つ目が当てられない) 1 つ目も点も戻る", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const cr = await boss.call("POST", "/api/admin/rp/shop", {
      name: "お金と研究",
      items: [{ kind: "money", p: { amount: 777 } }, { kind: "research", p: { mode: "advance", node: "", hours: 1 } }],
      price: 10,
    });
    give(all, a.id, 50);
    const m0 = money(all, a.id);
    expect((await a.call("POST", "/api/rp/buy", { id: cr.data.entry.id })).status).toBe(409);
    expect(money(all, a.id)).toBe(m0);
    expect(points(all, a.id)).toBe(50);
  });

  it("回数の制限: 週 (月曜に戻る) と 全部。押しすぎは 1 分で止める", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const wk = (await boss.call("POST", "/api/admin/rp/shop", { name: "週 2", items: [{ kind: "money", p: { amount: 1 } }], price: 1, limitWeek: 2 })).data.entry.id;
    const tot = (await boss.call("POST", "/api/admin/rp/shop", { name: "1 回", items: [{ kind: "money", p: { amount: 1 } }], price: 1, limitTotal: 1 })).data.entry.id;
    give(all, a.id, 100);
    expect((await a.call("POST", "/api/rp/buy", { id: wk })).status).toBe(200);
    expect((await a.call("POST", "/api/rp/buy", { id: wk })).status).toBe(200);
    const third = await a.call("POST", "/api/rp/buy", { id: wk });
    expect(third.status).toBe(409);
    expect(third.data.error).toContain("今週");
    expect((await a.call("POST", "/api/rp/buy", { id: tot })).status).toBe(200);
    expect((await a.call("POST", "/api/rp/buy", { id: tot })).status).toBe(409);
    // 次の週 (月曜 0 時)
    all.clock.t = jstWeekStart(all.clock.t) + 7 * DAY + MIN;
    expect((await a.call("POST", "/api/rp/buy", { id: wk })).status).toBe(200);
    expect((await a.call("POST", "/api/rp/buy", { id: tot })).status).toBe(409);
    expect(points(all, a.id)).toBe(100 - 4);
    // 押しすぎ (1 分に RP_BUY_PER_MIN 回まで。断られた回も数える)
    all.clock.t += 2 * MIN;
    const codes: number[] = [];
    for (let i = 0; i < RP_BUY_PER_MIN + 1; i++) codes.push((await a.call("POST", "/api/rp/buy", { id: tot })).status);
    expect(codes.slice(0, RP_BUY_PER_MIN).every((s) => s === 409)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    all.clock.t += 2 * MIN;
    expect((await a.call("POST", "/api/rp/buy", { id: wk })).status).toBe(200);
  });
});
