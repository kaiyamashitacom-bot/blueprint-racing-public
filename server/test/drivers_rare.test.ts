// 運転手の名簿と珍しい運転手 (サーバー): 候補の画面に得意が出る・珍しい運転手は候補に出ない・
// ギフトコードで契約できる (管理者の選びに自動で並ぶ)・総合のコンストラクターズチャンピオンのごほうび
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DRIVER_CATALOG, RARE_DRIVER_IDS, createDriverPool, seasonWindow, type DriverPool, type GiftItem } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { GiftStore, handleGiftApi } from "../src/gift.ts";
import { SeasonStore, type RaceFeed } from "../src/season.ts";
import { DRIVER_POOL_SEED, TeamStore } from "../src/team.ts";

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
      onConstructorChampion: (s, t) => void team.rarePrize(s, t),
      classMoves: () => gifts!.takeClassMoves(),
    },
    store,
  );
  gifts = new GiftStore({ sql, tx, now, caps: () => season.config() }, store, team, season);
  return { db, store, team, season, gifts, clock };
}
type All = ReturnType<typeof makeAll>;

async function user(all: All, login: string, n: number, money = 1000) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `9.9.8.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const p = new URL(req.url).pathname;
    const res = /^\/api\/(gift|admin\/gifts)(\/|$)/.test(p) ? await handleGiftApi(req, p, method, all.store, all.gifts) : await handleApi(req, all.store, undefined, all.team, all.season, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: login, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(login)!.id);
  all.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(money, id);
  return { call, id };
}

const money = (all: All, id: number) => Number(all.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);
const pool = (all: All) => JSON.parse(String(all.db.prepare("SELECT body FROM econ_kv WHERE k = 'drivers'").get()!.body)) as DriverPool;
const it1 = (kind: GiftItem["kind"], p: GiftItem["p"]): GiftItem => ({ kind, p });

describe("候補の画面", () => {
  it("名簿のふつうの運転手が並び、得意・国・年代が付く。珍しい運転手は並ばない", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const free = (await a.call("GET", "/api/drivers")).data.free as Array<{ id: string; specs: string[]; nat?: string; era?: number; rare?: boolean }>;
    const regular = DRIVER_CATALOG.filter((e) => !e.rare);
    for (const e of regular) {
      const d = free.find((x) => x.id === e.id)!;
      expect(d, e.id).toBeTruthy();
      expect(d.specs).toEqual(e.specs);
      expect(d.nat).toBe(e.nat);
      expect(d.era).toBe(e.era);
    }
    expect(free.some((x) => x.rare || RARE_DRIVER_IDS.includes(x.id))).toBe(false);
    expect(free.every((x) => Array.isArray(x.specs) && x.specs.length <= 2)).toBe(true);
  });

  it("前に保存した候補 (名簿と得意が無い) は 読むときに足す。前からいる人の id と能力と契約はそのまま", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1, 50_000);
    // 前の形の候補: 作りもの 40 人だけ、得意なし、1 人は a と契約中
    const old = createDriverPool(DRIVER_POOL_SEED, 40, false);
    const drivers = old.drivers.map(({ specs: _s, ...d }, i) =>
      i === 3 ? { ...d, contract: { teamId: String(a.id), fee: 1000, since: 1, paidSeason: 1, renew: true } } : d,
    );
    all.db.prepare("INSERT INTO econ_kv (k, body) VALUES ('drivers', ?)").run(JSON.stringify({ ...old, drivers }));
    const v = (await a.call("GET", "/api/drivers")).data;
    expect(v.mine.id).toBe("d3");
    expect(v.mine.stats).toEqual(Object.fromEntries(Object.entries(old.drivers[3].stats).map(([k, x]) => [k, Math.round(x)])));
    const p = pool(all);
    for (let i = 0; i < 40; i++) {
      expect(p.drivers[i].id).toBe(old.drivers[i].id);
      expect(p.drivers[i].stats).toEqual(old.drivers[i].stats);
      expect(p.drivers[i].potential).toEqual(old.drivers[i].potential);
      expect(p.drivers[i].specs).toEqual(old.drivers[i].specs);
    }
    expect(p.drivers[3].contract?.teamId).toBe(String(a.id));
    expect(p.drivers.filter((d) => d.id.startsWith("c"))).toHaveLength(DRIVER_CATALOG.filter((e) => !e.rare).length);
  });
});

describe("珍しい運転手", () => {
  it("ギフトコードで契約できる。管理者の選びに 候補にいなくても並ぶ", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2, 0);
    const b = await user(all, "bob", 3, 1e6);
    const opts = (await boss.call("GET", "/api/admin/gifts/options")).data.drivers as Array<{ id: string; name: string }>;
    for (const id of RARE_DRIVER_IDS) expect(opts.find((o) => o.id === id)?.name).toContain("珍しい");
    const made = await boss.call("POST", "/api/admin/gifts", { code: "RARECODE1", items: [it1("driver_hire", { driver: "rare2" })] });
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    // ほかの人は ふつうには雇えない (候補に出ない・頼んでも断る)
    expect((await b.call("POST", "/api/drivers/hire", { driverId: "rare2" })).status).toBe(404);
    const r = await a.call("POST", "/api/gift", { code: "RARECODE1" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const mine = (await a.call("GET", "/api/drivers")).data.mine;
    expect(mine.id).toBe("rare2");
    expect(mine.rare).toBe(true);
    expect(mine.specs).toEqual(DRIVER_CATALOG.find((e) => e.id === "rare2")!.specs);
    expect(money(all, a.id)).toBe(0);
    // 手放しても (違約金を払う) ふつうの候補には戻らない
    all.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(1e6, a.id);
    expect((await a.call("POST", "/api/drivers/release")).status).toBe(200);
    expect(((await b.call("GET", "/api/drivers")).data.free as Array<{ id: string }>).some((x) => x.id === "rare2")).toBe(false);
  });

  it("総合のコンストラクターズチャンピオンは 次の季節に 珍しい運転手と ただで契約できる (1 季節に 1 回)", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1, 50_000);
    const b = await user(all, "bob", 2, 50_000);
    const feed: RaceFeed = {
      raceId: "r1",
      at: all.clock.t,
      laps: 5,
      trackId: "aozu",
      humans: 2,
      maxWet: 0,
      cars: [
        { id: "p1", pos: 1, finished: true, fastest: true, penalty: 0, accountId: a.id },
        { id: "p2", pos: 2, finished: true, fastest: false, penalty: 0, accountId: b.id },
        ...[3, 4, 5, 6, 7, 8].map((pos) => ({ id: `b${pos}`, pos, finished: true, fastest: false, penalty: 0 })),
      ],
    };
    all.season.recordRace(feed);
    const season = all.season.tally().season;
    all.clock.t = seasonWindow(season).endsAt + 1000;
    expect(all.season.tick().closed).toEqual([season]);
    const va = (await a.call("GET", "/api/drivers")).data;
    const prize = (va.free as Array<{ id: string; rare?: boolean; prizeUntil?: number; signCost: number; fee: number }>).filter((x) => x.prizeUntil !== undefined);
    expect(prize).toHaveLength(1);
    expect(prize[0].rare).toBe(true);
    expect(prize[0].signCost).toBe(0);
    expect(prize[0].prizeUntil).toBe(season + 1);
    expect(va.free[0].id).toBe(prize[0].id);
    // ほかのチームには出ない
    expect(((await b.call("GET", "/api/drivers")).data.free as Array<{ id: string }>).some((x) => x.id === prize[0].id)).toBe(false);
    expect((await b.call("POST", "/api/drivers/hire", { driverId: prize[0].id })).status).toBe(404);
    const notice = all.db.prepare("SELECT text FROM notices WHERE account_id = ? AND kind = 'driver_prize'").get(a.id) as { text: string };
    expect(notice.text).toContain("ただで契約");
    // 同じ季節は 1 回だけ
    expect(all.team.rarePrize(season, String(a.id))).toBeNull();
    const before = money(all, a.id);
    const hire = await a.call("POST", "/api/drivers/hire", { driverId: prize[0].id });
    expect(hire.status, JSON.stringify(hire.data)).toBe(200);
    expect(hire.data.cost).toBe(0);
    expect(money(all, a.id)).toBe(before);
    const mine = (await a.call("GET", "/api/drivers")).data.mine;
    expect(mine.id).toBe(prize[0].id);
    expect(mine.prizeUntil).toBeUndefined();
    // 次の季節の切れ目からは ふつうに契約金を払う
    expect(pool(all).drivers.find((d) => d.id === prize[0].id)!.offer).toBeUndefined();
  });

  it("ごほうびの期限が過ぎたら雇えない", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1, 1e6);
    const season = all.season.tally().season;
    expect(all.team.rarePrize(season, String(a.id))).toBe(RARE_DRIVER_IDS[season % RARE_DRIVER_IDS.length]);
    const id = all.team.rarePrize(season, String(a.id)) ?? RARE_DRIVER_IDS[season % RARE_DRIVER_IDS.length];
    // until = season + 1。その次の季節には消える
    all.clock.t = seasonWindow(season + 2).startsAt + HOUR;
    const v = (await a.call("GET", "/api/drivers")).data;
    expect((v.free as Array<{ id: string }>).some((x) => x.id === id)).toBe(false);
    expect((await a.call("POST", "/api/drivers/hire", { driverId: id })).status).toBe(404);
  });
});
