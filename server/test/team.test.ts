// チーム・運転手・研究・市場・知らせの保存と受け口の試験。DO の SQLite の代わりに node:sqlite を使う
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CREW, MARKET, RESEARCH, SAMPLE_DESIGN, STARTING_MONEY, TRACK_DEFS, seasonWindow, seasonIndexAt, type TeamRaceReport } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { TeamStore } from "../src/team.ts";

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
  // 季節の途中の時刻
  const w = seasonWindow(seasonIndexAt(Date.UTC(2026, 11, 3)));
  const clock = { t: w.startsAt + 24 * 3600_000 };
  const store = new AccountStore({ sql, tx, now: () => clock.t, iterations: 1000 });
  const team = new TeamStore({ sql, tx, now: () => clock.t }, store);
  return { db, store, team, clock };
}

type All = ReturnType<typeof makeAll>;

async function user(all: All, n: number, money = 100_000) {
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
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(`user${n}`)!.id);
  all.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(money, id);
  return { call, id };
}

const money = (all: All, id: number) => Number(all.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);
const parts = (all: All, id: number) => all.store.inventory(id);
const logSum = (all: All, id: number) => Number(all.db.prepare("SELECT SUM(delta) AS s FROM wallet_log WHERE account_id = ?").get(id)!.s);

describe("チームの受け口", () => {
  it("ログインが要る", async () => {
    const all = makeAll();
    const res = await handleApi(new Request("http://x/api/team"), all.store, undefined, all.team);
    expect(res.status).toBe(401);
  });

  it("はじめて開くとチームができ、紋章・2 台の設計図・整備を変えられる", async () => {
    const all = makeAll();
    const a = await user(all, 1, 5000);
    const t = await a.call("GET", "/api/team");
    expect(t.status).toBe(200);
    expect(t.data.name).toBe("チーム1");
    expect(t.data.crew.level).toBe(1);
    expect(t.data.crew.factor).toBe(1);
    expect(t.data.driver).toBeNull();
    const em = await a.call("PUT", "/api/team/emblem", { emblem: { shape: "shield", color: "#e10600", mark: "star", markColor: "#ffffff" } });
    expect(em.status).toBe(200);
    expect((await a.call("PUT", "/api/team/emblem", { emblem: { shape: "blob" } })).status).toBe(400);
    // この機械の設計図を 2 台目に
    const car = await a.call("PUT", "/api/team/cars", { slot: "second", design: SAMPLE_DESIGN });
    expect(car.status).toBe(200);
    expect(car.data.cars.second.name).toBe(SAMPLE_DESIGN.name);
    expect(car.data.cars.second.ok).toBe(true);
    // もう一度送ると同じ設計図を上書き (増えない)
    await a.call("PUT", "/api/team/cars", { slot: "second", design: SAMPLE_DESIGN });
    expect(all.store.listDesigns(a.id).length).toBe(1);
    // 1 台目は同じ設計図の id を指せる
    const id = car.data.cars.second.id;
    expect((await a.call("PUT", "/api/team/cars", { slot: "player", designId: id })).data.cars.player.id).toBe(id);
    // 1 台目と同じ設計図を指しているときに 2 台目へ送ると、新しく作る
    await a.call("PUT", "/api/team/cars", { slot: "second", designId: id });
    await a.call("PUT", "/api/team/cars", { slot: "second", design: { ...SAMPLE_DESIGN, name: "べつの車" } });
    expect(all.store.listDesigns(a.id).length).toBe(2);
    // 整備を上げる: お金が減り、記録が残る
    const up = await a.call("POST", "/api/team/crew");
    expect(up.status).toBe(200);
    expect(up.data.level).toBe(2);
    const [c1, c2] = [CREW.upgradeCost[1], CREW.upgradeCost[2]];
    expect(money(all, a.id)).toBe(5000 - c1);
    expect(logSum(all, a.id)).toBe(STARTING_MONEY - c1); // はじめのお金 (記録) + 整備
    expect((await a.call("POST", "/api/team/crew")).status).toBe(200);
    expect(money(all, a.id)).toBe(5000 - c1 - c2);
    // 次は 6,000 で足りない。財布は変わらない
    expect(CREW.upgradeCost[3]).toBeGreaterThan(5000 - c1 - c2);
    expect((await a.call("POST", "/api/team/crew")).status).toBe(400);
    expect(money(all, a.id)).toBe(5000 - c1 - c2);
    expect((await a.call("GET", "/api/team")).data.crew.factor).toBeLessThan(1);
  });
});

describe("運転手", () => {
  it("空いている候補を見て雇い、続けるかを決め、手放すと違約金", async () => {
    const all = makeAll();
    const a = await user(all, 1, 50_000);
    const b = await user(all, 2, 50_000);
    const list = await a.call("GET", "/api/drivers");
    expect(list.data.free.length).toBeGreaterThanOrEqual(8);
    expect(list.data.mine).toBeNull();
    const d = list.data.free[list.data.free.length - 1];
    expect(d.signCost).toBeGreaterThan(0);
    const hire = await a.call("POST", "/api/drivers/hire", { driverId: d.id });
    expect(hire.status).toBe(200);
    expect(money(all, a.id)).toBe(50_000 - hire.data.cost);
    // ほかのチームは取れない
    const taken = await b.call("POST", "/api/drivers/hire", { driverId: d.id });
    expect(taken.status).toBe(409);
    const mine = (await a.call("GET", "/api/drivers")).data.mine;
    expect(mine.id).toBe(d.id);
    expect(mine.renew).toBe(true);
    expect((await a.call("PUT", "/api/drivers/renew", { renew: false })).status).toBe(200);
    expect((await a.call("GET", "/api/drivers")).data.mine.renew).toBe(false);
    const before = money(all, a.id);
    const rel = await a.call("POST", "/api/drivers/release");
    expect(rel.status).toBe(200);
    expect(rel.data.penalty).toBeGreaterThan(0);
    expect(money(all, a.id)).toBe(before - rel.data.penalty);
    expect((await a.call("GET", "/api/drivers")).data.mine).toBeNull();
    expect((await a.call("POST", "/api/drivers/release")).status).toBe(404);
  });

  it("お金が足りなければ雇えず、財布は変わらない", async () => {
    const all = makeAll();
    const a = await user(all, 1, 10);
    const d = (await a.call("GET", "/api/drivers")).data.free[0];
    const r = await a.call("POST", "/api/drivers/hire", { driverId: d.id });
    expect(r.status).toBe(400);
    expect(money(all, a.id)).toBe(10);
  });

  it("季節の切れ目: 続ける契約は次の季節の契約金を払い、知らせが出る", async () => {
    const all = makeAll();
    const a = await user(all, 1, 50_000);
    const d = (await a.call("GET", "/api/drivers")).data.free[0];
    await a.call("POST", "/api/drivers/hire", { driverId: d.id });
    const before = money(all, a.id);
    all.clock.t += 7 * 24 * 3600_000;
    const mine = (await a.call("GET", "/api/drivers")).data.mine;
    expect(mine.id).toBe(d.id);
    expect(money(all, a.id)).toBe(before - mine.fee);
    const n = (await a.call("GET", "/api/notices")).data;
    expect(n.notices.some((x: { title: string }) => x.title === "契約を続けた")).toBe(true);
  });
});

describe("研究", () => {
  it("始める → 時間がたつと終わって知らせ → 作ると持ち物に入る", async () => {
    const all = makeAll();
    const a = await user(all, 1, 20_000);
    const tree = (await a.call("GET", "/api/research")).data.tree as Array<{ id: string; state: string; cost: number }>;
    // 28 + 研究で開発する新しい種類 19 (冷却・電池・ギア箱・サスペンション 4 つずつ・重り 3。11/25)
    expect(tree.length).toBe(47);
    expect(tree.find((x) => x.id === "r_eng_p4")!.state).toBe("locked");
    const st = await a.call("POST", "/api/research/start", { researchId: "r_brake_3" });
    expect(st.status).toBe(200);
    expect(money(all, a.id)).toBe(20_000 - RESEARCH.cost[3]);
    // 研究は 1 つずつ
    expect((await a.call("POST", "/api/research/start", { researchId: "r_tank_l3" })).status).toBe(409);
    const half = (await a.call("GET", "/api/research")).data;
    expect(half.active[0].progress).toBe(0);
    // まだ作れない
    expect((await a.call("POST", "/api/research/manufacture", { partId: "brake_3", count: 1 })).status).toBe(400);
    // 走ると早く進む (元の部品 brake_2 を付けて 3 km)
    all.team.recordRace("r1", report([{ id: "p1", parts: ["brake_2"], dist: 3000, pits: 1 }]), { p1: a.id });
    const boosted = (await a.call("GET", "/api/research")).data.active[0];
    expect(boosted.boostMs).toBe(3 * RESEARCH.boostMsPerKm);
    // 寝ている間に終わる (alarm でも呼ばれたときでも)
    all.clock.t += RESEARCH.durationMs[3];
    all.team.tickAll();
    const n = (await a.call("GET", "/api/notices")).data;
    expect(n.unread).toBe(1);
    expect(n.notices[0].kind).toBe("research_done");
    expect((await a.call("POST", "/api/notices/read")).data.unread).toBe(0);
    expect((await a.call("GET", "/api/team")).data.unread).toBe(0);
    const before = money(all, a.id);
    const mk = await a.call("POST", "/api/research/manufacture", { partId: "brake_3", count: 2 });
    expect(mk.status).toBe(200);
    expect(parts(all, a.id).brake_3).toBe(2);
    expect(money(all, a.id)).toBe(before - mk.data.cost);
    // 整備の慣れにピットの数が入っている
    expect((await a.call("GET", "/api/team")).data.crew.stops).toBe(1);
  });

  it("やめられる (お金は戻らない)", async () => {
    const all = makeAll();
    const a = await user(all, 1, 20_000);
    await a.call("POST", "/api/research/start", { researchId: "r_brake_3" });
    const c = await a.call("POST", "/api/research/cancel", { researchId: "r_brake_3" });
    expect(c.status).toBe(200);
    expect(c.data.refund).toBe(0);
    expect((await a.call("GET", "/api/research")).data.active.length).toBe(0);
  });
});

function report(cars: Array<{ id: string; parts: string[]; dist: number; pits: number; car2?: { driverId: string; pos: number } ; standIn?: boolean }>): TeamRaceReport {
  const base = { points: 10, finished: true, retired: false, lapsDone: 5, wallHits: 0 };
  return {
    trackId: TRACK_DEFS[0].id,
    laps: 5,
    cars: 8,
    humans: cars.length,
    teams: cars.map((c, i) => ({
      id: c.id,
      key: `k${i}`,
      car1: { ...base, id: c.id, pos: 1, pitStops: c.pits, distM: c.dist, partIds: c.parts, standIn: !!c.standIn },
      car2: c.car2 ? { ...base, id: `t${i}`, pos: c.car2.pos, pitStops: 1, distM: c.dist, partIds: c.parts, driverId: c.car2.driverId } : null,
    })),
  };
}

describe("レースのあと", () => {
  it("2 台目の運転手が育ち、慣れ (運転手と代走) が残り、同じレースは 1 回だけ", async () => {
    const all = makeAll();
    const a = await user(all, 1, 50_000);
    const d = (await a.call("GET", "/api/drivers")).data.free[0];
    await a.call("POST", "/api/drivers/hire", { driverId: d.id });
    // 2 台目の設計図を決めて、部屋に渡す様子を見る
    await a.call("PUT", "/api/team/cars", { slot: "second", design: { ...SAMPLE_DESIGN, name: "二号車" } });
    const join = all.team.raceTeam(a.id, SAMPLE_DESIGN);
    expect(join.second?.driverId).toBe(d.id);
    expect(join.second?.design.name).toBe("二号車");
    expect(join.serviceFactor).toBe(1);
    expect(join.standInFam).toEqual({});
    const r = report([{ id: "p1", parts: ["seat"], dist: 2000, pits: 2, car2: { driverId: d.id, pos: 2 }, standIn: true }]);
    all.team.recordRace("race-1", r, { p1: a.id });
    all.team.recordRace("race-1", r, { p1: a.id });
    const mine = (await a.call("GET", "/api/drivers")).data.mine;
    expect(mine.races).toBe(1);
    expect(mine.fam[TRACK_DEFS[0].id]).toBeCloseTo(0.1, 4);
    const t = (await a.call("GET", "/api/team")).data;
    expect(t.crew.stops).toBe(3);
    expect(t.standInFam[TRACK_DEFS[0].id]).toBeCloseTo(0.1, 4);
    const join2 = all.team.raceTeam(a.id, SAMPLE_DESIGN);
    expect(join2.second?.fam?.[TRACK_DEFS[0].id]).toBeCloseTo(0.1, 4);
    expect(join2.standInFam?.[TRACK_DEFS[0].id]).toBeCloseTo(0.1, 4);
  });

  it("運転手がいなければ 2 台目はない", async () => {
    const all = makeAll();
    const a = await user(all, 1);
    expect(all.team.raceTeam(a.id, SAMPLE_DESIGN).second).toBeUndefined();
  });
});

describe("市場", () => {
  it("値段を決めて出す → 買う (5% の手数料)。部品は出したときに預かる", async () => {
    const all = makeAll();
    const a = await user(all, 1, 1000);
    const b = await user(all, 2, 5000);
    const have = parts(all, a.id).tire_n1;
    const l = await a.call("POST", "/api/market/list", { item: { type: "part", partId: "tire_n1", count: 2 }, mode: "fixed", price: 1000 });
    expect(l.status).toBe(201);
    expect(parts(all, a.id).tire_n1 ?? 0).toBe(have - 2);
    // 持っていない数は出せない
    expect((await a.call("POST", "/api/market/list", { item: { type: "part", partId: "tire_n1", count: 999 }, mode: "fixed", price: 10 })).status).toBe(400);
    // 自分のものは買えない
    expect((await a.call("POST", `/api/market/${l.data.id}/buy`)).status).toBe(400);
    const view = (await b.call("GET", "/api/market")).data;
    expect(view.listings.length).toBe(1);
    expect(view.listings[0].seller).toBe("チーム1");
    expect(view.listings[0].mine).toBe(false);
    const bought = await b.call("POST", `/api/market/${l.data.id}/buy`);
    expect(bought.status).toBe(200);
    expect(money(all, b.id)).toBe(4000);
    expect(money(all, a.id)).toBe(1000 + 1000 - Math.floor(1000 * MARKET.feeRate));
    expect(parts(all, b.id).tire_n1).toBe(have + 2);
    const n = (await a.call("GET", "/api/notices")).data.notices;
    expect(n[0].kind).toBe("market_sold");
    // 売れたあとは買えない
    expect((await b.call("POST", `/api/market/${l.data.id}/buy`)).status).toBe(409);
  });

  it("競り: 抜かれたらお金が戻って知らせ、締め切りで一番の人に渡る。誰も入れなければ戻る", async () => {
    const all = makeAll();
    const a = await user(all, 1, 0);
    const b = await user(all, 2, 3000);
    const c = await user(all, 3, 3000);
    const l = await a.call("POST", "/api/market/list", { item: { type: "part", partId: "seat", count: 1 }, mode: "auction", price: 100, hours: 2 });
    expect(l.status).toBe(201);
    expect((await b.call("POST", `/api/market/${l.data.id}/bid`, { amount: 50 })).status).toBe(400);
    expect((await b.call("POST", `/api/market/${l.data.id}/bid`, { amount: 100 })).status).toBe(200);
    expect(money(all, b.id)).toBe(2900);
    expect((await c.call("POST", `/api/market/${l.data.id}/bid`, { amount: 105 })).status).toBe(400);
    expect((await c.call("POST", `/api/market/${l.data.id}/bid`, { amount: 200 })).status).toBe(200);
    expect(money(all, b.id)).toBe(3000);
    expect(money(all, c.id)).toBe(2800);
    expect((await b.call("GET", "/api/notices")).data.notices[0].kind).toBe("outbid");
    // 値が入ったら やめられない
    expect((await a.call("POST", `/api/market/${l.data.id}/cancel`)).status).toBe(400);
    expect((await c.call("GET", "/api/market")).data.held).toBe(200);
    all.clock.t += 2 * 3600_000;
    all.team.tickAll();
    expect(money(all, a.id)).toBe(200 - Math.floor(200 * MARKET.feeRate));
    expect(parts(all, c.id).seat).toBe(2);
    expect((await c.call("GET", "/api/notices")).data.notices[0].title).toBe("競りで落とした");
    // 誰も入れない競りは期限で戻る
    const l2 = await a.call("POST", "/api/market/list", { item: { type: "part", partId: "frame", count: 3 }, mode: "auction", price: 100, hours: 1 });
    const frames = parts(all, a.id).frame ?? 0;
    all.clock.t += 3600_000;
    await a.call("GET", "/api/market");
    expect(parts(all, a.id).frame).toBe(frames + 3);
    const mine = (await a.call("GET", "/api/market")).data.mine.find((x: { id: string }) => x.id === l2.data.id);
    expect(mine.status).toBe("expired");
  });

  it("設計図を売ると、買った人に写しが渡り、売った人にも残る", async () => {
    const all = makeAll();
    const a = await user(all, 1, 0);
    const b = await user(all, 2, 1000);
    const saved = all.store.saveDesign(all.store.getAccount(a.id)!, SAMPLE_DESIGN);
    const l = await a.call("POST", "/api/market/list", { item: { type: "design", designId: saved.id }, mode: "fixed", price: 300 });
    expect(l.status).toBe(201);
    const view = (await b.call("GET", "/api/market?type=design")).data.listings[0];
    expect(view.item.type).toBe("design");
    expect(view.item.parts).toBe(SAMPLE_DESIGN.parts.length);
    // 中身 (部品の置き方) は見せない
    expect(JSON.stringify(view)).not.toContain('"c":');
    await b.call("POST", `/api/market/${l.data.id}/buy`);
    expect(all.store.listDesigns(b.id).length).toBe(1);
    expect(all.store.listDesigns(a.id).length).toBe(1);
  });

  it("部品の供給: 研究したチームが申し出 → 受ける → 注文すると作って届く", async () => {
    const all = makeAll();
    const a = await user(all, 1, 20_000);
    const b = await user(all, 2, 20_000);
    await a.call("POST", "/api/research/start", { researchId: "r_brake_3" });
    all.clock.t += RESEARCH.durationMs[3];
    expect((await a.call("POST", "/api/market/supply/offer", { team: "そんなチーム", partId: "brake_3", unitPrice: 900, maxUnits: 3 })).status).toBe(404);
    const off = await a.call("POST", "/api/market/supply/offer", { team: "チーム2", partId: "brake_3", unitPrice: 900, maxUnits: 3 });
    expect(off.status).toBe(201);
    expect((await b.call("GET", "/api/notices")).data.notices[0].title).toBe("供給の申し出");
    const sup = (await b.call("GET", "/api/market")).data.supplies[0];
    expect(sup.role).toBe("buyer");
    expect(sup.other).toBe("チーム1");
    expect((await b.call("POST", `/api/market/supply/${off.data.id}/order`, { count: 1 })).status).toBe(409);
    expect((await b.call("POST", `/api/market/supply/${off.data.id}/answer`, { accept: true })).status).toBe(200);
    const aBefore = money(all, a.id);
    const bBefore = money(all, b.id);
    const o = await b.call("POST", `/api/market/supply/${off.data.id}/order`, { count: 2 });
    expect(o.status).toBe(200);
    expect(parts(all, b.id).brake_3).toBe(2);
    expect(money(all, b.id)).toBe(bBefore - 1800);
    const build = 60 * 5 * 2;
    expect(money(all, a.id)).toBe(aBefore + 1800 - Math.floor(1800 * MARKET.feeRate) - build);
    expect((await b.call("POST", `/api/market/supply/${off.data.id}/order`, { count: 2 })).status).toBe(400);
  });
});

describe("退会", () => {
  it("チームと契約と出品を片付ける (競りのお金は返す)", async () => {
    const all = makeAll();
    const a = await user(all, 1, 50_000);
    const b = await user(all, 2, 5000);
    const d = (await a.call("GET", "/api/drivers")).data.free[0];
    await a.call("POST", "/api/drivers/hire", { driverId: d.id });
    const l = await a.call("POST", "/api/market/list", { item: { type: "part", partId: "seat", count: 1 }, mode: "auction", price: 100 });
    await b.call("POST", `/api/market/${l.data.id}/bid`, { amount: 500 });
    expect(money(all, b.id)).toBe(4500);
    expect((await a.call("DELETE", "/api/me", { password: "password1" })).status).toBe(200);
    expect(money(all, b.id)).toBe(5000);
    expect((await b.call("GET", "/api/market")).data.listings.length).toBe(0);
    expect((await b.call("GET", "/api/drivers")).data.free.some((x: { id: string }) => x.id === d.id)).toBe(true);
    expect(all.team.loadTeam(a.id)).toBeNull();
  });
});
