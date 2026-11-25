// 部品の進化・限界突破・品 (かけら・特別指導書) の受け口と、景品の入り口 (季節の締め・王者 7 日・1 周アタックの週の 1 位・ギフトコード)。
// DO の SQLite の代わりに node:sqlite を使う (team.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ITEM_IDS, PRIZE_ITEMS, SHARDS_PER_ITEM, TA_SUBMIT_GRACE_MS, evolveCost, EVOLUTIONS, seasonWindow, taWeek } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { GIFT_APPLY } from "../src/gift.ts";
import { SeasonStore, humanDriverId, leagueWeekTop, type RaceFeed } from "../src/season.ts";
import { TeamStore } from "../src/team.ts";
import { TaStore } from "../src/timeattack.ts";

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
  const store = new AccountStore({ sql, tx, now: () => clock.t, iterations: 1000 });
  const team = new TeamStore({ sql, tx, now: () => clock.t }, store);
  const season = new SeasonStore({ sql, tx, now: () => clock.t, teamInfo: (acc, d) => team.raceTeam(acc, d) }, store);
  const ta = new TaStore({ sql, tx, now: () => clock.t });
  return { db, sql, store, team, season, ta, clock };
}
type All = ReturnType<typeof makeAll>;

async function user(all: All, n: number, money = 200_000) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `7.7.7.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), all.store, undefined, all.team, all.season);
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: `item${n}`, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(`item${n}`)!.id);
  all.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(money, id);
  return { call, id };
}

const money = (all: All, id: number) => Number(all.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);
const inv = (all: All, id: number) => all.store.inventory(id);
const give = (all: All, id: number, part: string, n: number) =>
  all.db.prepare("INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?) ON CONFLICT(account_id, part_id) DO UPDATE SET n = excluded.n").run(id, part, n);

describe("進化・限界突破・品の受け口", () => {
  it("進化: お金を払い、元の部品 1 つが先の部品 1 つに。研究がまだなら断る", async () => {
    const all = makeAll();
    const a = await user(all, 1);
    const view = await a.call("GET", "/api/research/evolution");
    expect(view.status).toBe(200);
    expect(view.data.recipes.length).toBe(EVOLUTIONS.length);
    const r = EVOLUTIONS.find((x) => x.id === "e_eng_m1_eng_m2")!;
    const m0 = money(all, a.id);
    const ev = await a.call("POST", "/api/research/evolve", { recipeId: r.id });
    expect(ev.status).toBe(200);
    expect(money(all, a.id)).toBe(m0 - evolveCost(r));
    expect(inv(all, a.id).eng_m1 ?? 0).toBe(0);
    expect(inv(all, a.id).eng_m2).toBe(1);
    // 段階 3 の先は研究が要る
    give(all, a.id, "eng_p2", 1);
    const lock = await a.call("POST", "/api/research/evolve", { recipeId: "e_eng_p2_eng_p3" });
    expect(lock.status).toBe(400);
    expect(inv(all, a.id).eng_p2).toBe(1);
    expect((await a.call("POST", "/api/research/evolve", { recipeId: "nope" })).status).toBe(404);
  });

  it("限界突破: 限界設計図 1 つで 5+、品がなければ断る。市場には出せない", async () => {
    const all = makeAll();
    const a = await user(all, 2);
    give(all, a.id, "eng_p5", 1);
    expect((await a.call("POST", "/api/research/limit", { partId: "eng_p5" })).status).toBe(400);
    give(all, a.id, ITEM_IDS.limitBlueprint, 1);
    const view = await a.call("GET", "/api/research/evolution");
    expect(view.data.limits.map((l: any) => l.id)).toContain("eng_p5");
    expect(view.data.items[0]).toMatchObject({ id: ITEM_IDS.limitBlueprint, count: 1 });
    const r = await a.call("POST", "/api/research/limit", { partId: "eng_p5" });
    expect(r.status).toBe(200);
    expect(inv(all, a.id).eng_p5_x1).toBe(1);
    expect(inv(all, a.id)[ITEM_IDS.limitBlueprint] ?? 0).toBe(0);
    // 市場: 限界を超えた部品と品は出せず、売れる物の一覧にも出ない
    give(all, a.id, ITEM_IDS.coachBook, 1);
    expect((await a.call("POST", "/api/market/list", { item: { type: "part", partId: "eng_p5_x1", count: 1 }, mode: "fixed", price: 1000, hours: 24 })).status).toBe(400);
    expect((await a.call("POST", "/api/market/list", { item: { type: "part", partId: ITEM_IDS.coachBook, count: 1 }, mode: "fixed", price: 1000, hours: 24 })).status).toBe(400);
    const m = await a.call("GET", "/api/market");
    expect(Object.keys(m.data.sellable.parts)).not.toContain("eng_p5_x1");
    expect(Object.keys(m.data.sellable.parts)).not.toContain(ITEM_IDS.coachBook);
  });

  it("かけら 10 個 → 品 1 つ。特別指導書は雇った運転手に (2 回まで)", async () => {
    const all = makeAll();
    const a = await user(all, 3);
    give(all, a.id, ITEM_IDS.coachShard, SHARDS_PER_ITEM * 3);
    const c = await a.call("POST", "/api/team/items/convert", { shard: ITEM_IDS.coachShard, count: 3 });
    expect(c.status).toBe(200);
    expect(inv(all, a.id)[ITEM_IDS.coachBook]).toBe(3);
    expect((await a.call("POST", "/api/team/items/convert", { shard: ITEM_IDS.coachShard })).status).toBe(400);
    // 運転手がいないと使えない
    expect((await a.call("POST", "/api/team/items/coach")).status).toBe(400);
    const d = (await a.call("GET", "/api/drivers")).data.free[0];
    expect((await a.call("POST", "/api/drivers/hire", { driverId: d.id })).status).toBe(200);
    const before = (await a.call("GET", "/api/drivers")).data.mine.potential;
    const u1 = await a.call("POST", "/api/team/items/coach");
    expect(u1.status).toBe(200);
    expect(u1.data.coached).toBe(1);
    const after = (await a.call("GET", "/api/drivers")).data.mine.potential;
    for (const k of Object.keys(before)) expect(after[k]).toBe(Math.min(100, before[k] + 5));
    expect((await a.call("POST", "/api/team/items/coach")).status).toBe(200);
    const no = await a.call("POST", "/api/team/items/coach");
    expect(no.status).toBe(400);
    // 3 回目は断られ、指導書は減らない
    expect(inv(all, a.id)[ITEM_IDS.coachBook]).toBe(1);
  });
});

describe("景品の入り口", () => {
  it("季節の締め: 級と総合のチャンピオン・ドライバーズ・リーグ戦の週の 1 位に品 (1 回だけ)", async () => {
    const all = makeAll();
    const a = await user(all, 11);
    const b = await user(all, 12);
    const c = await user(all, 13);
    const f: RaceFeed = {
      raceId: "r1",
      at: all.clock.t,
      laps: 5,
      trackId: "aozu",
      humans: 2,
      maxWet: 0,
      cars: [
        { id: "p1", pos: 1, finished: true, fastest: true, penalty: 0, accountId: a.id, gridPos: 1, pitStops: 1 },
        { id: "p2", pos: 2, finished: true, fastest: false, penalty: 0, accountId: b.id, standIn: true, gridPos: 3, pitStops: 1 },
        ...[3, 4, 5, 6, 7, 8].map((pos) => ({ id: `b${pos}`, pos, finished: true, fastest: false, penalty: 0 })),
      ],
    };
    all.season.recordRace(f);
    all.season.addLeagueDay("day-1", { [String(c.id)]: 30 }, {});
    const season = all.season.tally().season;
    all.clock.t = seasonWindow(season).endsAt + 1000;
    expect(all.season.tick().closed).toEqual([season]);
    // a: 級と総合のドライバーズ (特別指導書 1 + 2)。c: 級と総合のコンストラクター (限界設計図 1 + 2) とリーグ戦の週の 1 位 (指導書 1)
    expect(inv(all, a.id)[ITEM_IDS.coachBook]).toBe(PRIZE_ITEMS.classDriver.count + PRIZE_ITEMS.overallDriver.count);
    expect(inv(all, c.id)[ITEM_IDS.limitBlueprint]).toBe(PRIZE_ITEMS.classConstructor.count + PRIZE_ITEMS.overallConstructor.count);
    expect(inv(all, c.id)[ITEM_IDS.coachBook]).toBe(PRIZE_ITEMS.leagueWeek.count);
    expect(inv(all, b.id)[ITEM_IDS.limitBlueprint] ?? 0).toBe(0);
    const n = all.db.prepare("SELECT text FROM notices WHERE account_id = ? AND id = ?").get(c.id, `prize:season:${season}`) as { text: string };
    expect(n.text).toContain("限界設計図");
    // もう一度締めても増えない
    all.season.tick();
    expect(inv(all, c.id)[ITEM_IDS.limitBlueprint]).toBe(3);
    expect(humanDriverId(a.id)).toBeTruthy();
  });

  it("王者を 7 日続けて守ると 1 つ (7 日目)。途中で替わると数え直し", async () => {
    const all = makeAll();
    const a = await user(all, 21);
    const b = await user(all, 22);
    const champ = (day: number, team: number) => all.season.addLeagueDay(`league-${day}`, {}, { champion: String(team) });
    for (let d = 1; d <= 6; d++) champ(d, a.id);
    expect(inv(all, a.id)[PRIZE_ITEMS.championStreak.item] ?? 0).toBe(0);
    champ(7, a.id);
    expect(inv(all, a.id)[PRIZE_ITEMS.championStreak.item]).toBe(1);
    // 同じ日はもう数えない
    expect(champ(7, a.id)).toBe(false);
    champ(8, b.id);
    for (let d = 9; d <= 14; d++) champ(d, a.id);
    expect(inv(all, a.id)[PRIZE_ITEMS.championStreak.item]).toBe(1);
    expect(inv(all, b.id)[PRIZE_ITEMS.championStreak.item] ?? 0).toBe(0);
  });

  it("リーグ戦の週の 1 位: 部の重みのついた分が一番の人 (コンピューターは除く)", () => {
    expect(leagueWeekTop({ "3": 10, "5": 30, rv1_2_0: 99 })).toBe("5");
    expect(leagueWeekTop({ "7": 20, "4": 20 })).toBe("4");
    expect(leagueWeekTop({})).toBeNull();
  });

  it("1 周アタックの週の 1 位: 週の受け付けが終わったら 1 回だけ", async () => {
    const all = makeAll();
    const a = await user(all, 31);
    const b = await user(all, 32);
    const cur = all.ta.currentWeek().index;
    const ins = all.db.prepare("INSERT INTO ta_best (week, account_id, lap_ms, ghost, design_hash, driver, team, at, tries, mt) VALUES (?, ?, ?, NULL, 'h', 'd', 't', ?, 1, 0)");
    ins.run(cur, a.id, 30000, all.clock.t);
    ins.run(cur, b.id, 29000, all.clock.t);
    // まだ今週
    expect(all.ta.awardDue()).toBe(0);
    all.clock.t = taWeek(cur).endsAt + TA_SUBMIT_GRACE_MS + 1000;
    expect(all.ta.awardDue()).toBe(1);
    expect(inv(all, b.id)[PRIZE_ITEMS.timeAttackWeek.item]).toBe(1);
    expect(inv(all, a.id)[PRIZE_ITEMS.timeAttackWeek.item] ?? 0).toBe(0);
    expect(all.ta.awardDue()).toBe(0);
    expect(inv(all, b.id)[PRIZE_ITEMS.timeAttackWeek.item]).toBe(1);
  });

  it("ギフトコードの品: 持ち物に入る", async () => {
    const all = makeAll();
    const a = await user(all, 41);
    const acc = all.store.getAccount(a.id)!;
    const line = GIFT_APPLY.item({ acc, now: all.clock.t, giftId: 1, sql: all.sql, accounts: all.store, team: all.team, season: all.season, pending: () => {} }, { item: ITEM_IDS.limitShard, count: 7 });
    expect(line).toContain("限界突破のかけら");
    expect(inv(all, a.id)[ITEM_IDS.limitShard]).toBe(7);
  });
});
