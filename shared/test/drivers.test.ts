import { describe, expect, it } from "vitest";
import { makeBrain } from "../src/bot.ts";
import {
  createDriverPool, driverBrain, driverFee, driverOverall, driverTraits, DRIVERS, ensureFreeDrivers, findDriver, freeDrivers, growDriver,
  hireDriver, makeDriver, recordDriverRace, releaseDriver, releasePenalty, renewContracts, setRenew, signingCost, STAT_KEYS, teamDriver,
  type DriverPool,
} from "../src/drivers.ts";
import { DRIVER_CATALOG } from "../src/drivercatalog.ts";
import { seededRand } from "../src/econ.ts";
import { BOT_NAMES } from "../src/presets.ts";
import { seasonWindow } from "../src/season.ts";

const S0 = seasonWindow(0);
const MID = S0.startsAt + (S0.endsAt - S0.startsAt) / 2;

function hired(pool: DriverPool, team: string, id: string, funds = 1e9, now = S0.startsAt) {
  const r = hireDriver(pool, team, id, funds, S0, now);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("候補の運転手", () => {
  it("同じ種なら同じ候補、違う種なら違う", () => {
    const a = createDriverPool(42);
    const b = createDriverPool(42);
    const c = createDriverPool(43);
    expect(a).toEqual(b);
    expect(a.drivers.map((d) => d.name)).not.toEqual(c.drivers.map((d) => d.name));
    // 作りもの 40 人 + 名簿のふつうの運転手 (珍しい人は入らない)
    expect(a.drivers).toHaveLength(DRIVERS.poolSize + DRIVER_CATALOG.filter((e) => !e.rare).length);
  });

  it("名前は重ならず、コンピューターの車の名前とも違い、能力は幅の中", () => {
    const pool = createDriverPool(7, 120);
    const names = pool.drivers.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of pool.drivers) {
      expect(BOT_NAMES).not.toContain(d.name);
      for (const k of STAT_KEYS) {
        expect(d.stats[k]).toBeGreaterThanOrEqual(DRIVERS.statMin);
        expect(d.stats[k]).toBeLessThanOrEqual(DRIVERS.statMax);
        expect(d.potential[k]).toBeGreaterThanOrEqual(d.stats[k]);
        expect(d.potential[k]).toBeLessThanOrEqual(100);
      }
    }
  });

  it("番号 i の運転手は 作る順番によらず同じ", () => {
    const pool = ensureFreeDrivers(createDriverPool(5, 3, false), 10);
    expect(pool.drivers).toHaveLength(10);
    expect(pool.drivers[7].stats).toEqual(makeDriver(5, 7).stats);
  });

  it("空きが減ったら足す", () => {
    let pool = createDriverPool(1, 10, false);
    for (let i = 0; i < 6; i++) pool = hired(pool, `t${i}`, pool.drivers[i].id).pool;
    expect(freeDrivers(pool)).toHaveLength(4);
    pool = ensureFreeDrivers(pool, 8);
    expect(freeDrivers(pool)).toHaveLength(8);
    expect(ensureFreeDrivers(pool, 8)).toBe(pool);
  });

  it("契約金は総合が高いほど高い", () => {
    const pool = createDriverPool(3, 60);
    const sorted = [...pool.drivers].sort((a, b) => driverOverall(a.stats) - driverOverall(b.stats));
    expect(driverFee(sorted[0])).toBeLessThan(driverFee(sorted[sorted.length - 1]));
    for (const d of pool.drivers) expect(driverFee(d) % DRIVERS.feeRound).toBe(0);
  });
});

describe("契約", () => {
  it("早い者勝ち: 2 つ目のチームは雇えない", () => {
    const pool = createDriverPool(9);
    const id = pool.drivers[0].id;
    const a = hired(pool, "A", id);
    const b = hireDriver(a.pool, "B", id, 1e9, S0, S0.startsAt);
    expect(b).toEqual({ ok: false, error: "taken" });
    expect(hireDriver(a.pool, "A", id, 1e9, S0, S0.startsAt)).toEqual({ ok: false, error: "already" });
    expect(teamDriver(a.pool, "A")?.id).toBe(id);
  });

  it("お金が足りなければ雇えない。季節の途中は残りの分だけ (下限あり)", () => {
    const pool = createDriverPool(9);
    const d = pool.drivers[0];
    const fee = driverFee(d);
    expect(signingCost(d, S0, S0.startsAt)).toBe(fee);
    expect(signingCost(d, S0, MID)).toBe(Math.ceil(fee / 2));
    expect(signingCost(d, S0, S0.endsAt - 1)).toBe(Math.ceil(fee * DRIVERS.minSignRatio));
    expect(hireDriver(pool, "A", d.id, fee - 1, S0, S0.startsAt)).toEqual({ ok: false, error: "no_money" });
    const r = hired(pool, "A", d.id, fee, S0.startsAt);
    expect(r.cost).toBe(fee);
  });

  it("季節の途中の入れ替えは 違約金 (契約金の残り) を足して払う", () => {
    const pool = createDriverPool(9);
    const [d1, d2] = pool.drivers;
    const a = hired(pool, "A", d1.id);
    const pen = releasePenalty(findDriver(a.pool, d1.id)!, S0, MID);
    expect(pen).toBe(Math.ceil(driverFee(d1) / 2));
    const swap = hired(a.pool, "A", d2.id, 1e9, MID);
    expect(swap.penalty).toBe(pen);
    expect(swap.cost).toBe(pen + signingCost(d2, S0, MID));
    expect(swap.releasedId).toBe(d1.id);
    expect(findDriver(swap.pool, d1.id)!.contract).toBeNull();
    expect(teamDriver(swap.pool, "A")?.id).toBe(d2.id);
    // 合わせたお金が無ければ入れ替えない
    expect(hireDriver(a.pool, "A", d2.id, swap.cost - 1, S0, MID)).toEqual({ ok: false, error: "no_money" });
  });

  it("手放すだけでも違約金。いない・足りないときはできない", () => {
    const pool = createDriverPool(9);
    const a = hired(pool, "A", pool.drivers[0].id);
    const r = releaseDriver(a.pool, "A", 1e9, S0, MID);
    expect(r.ok && r.cost).toBe(Math.ceil(driverFee(pool.drivers[0]) / 2));
    expect(releaseDriver(a.pool, "A", 0, S0, MID)).toEqual({ ok: false, error: "no_money" });
    expect(releaseDriver(pool, "A", 1e9, S0, MID)).toEqual({ ok: false, error: "not_found" });
    // 季節の終わりなら違約金は 0
    const end = releaseDriver(a.pool, "A", 0, S0, S0.endsAt);
    expect(end.ok && end.cost).toBe(0);
  });

  it("季節の切れ目: 続けるなら育った能力で払い、払えない・続けないなら離れる", () => {
    let pool = createDriverPool(11);
    const [d1, d2, d3] = pool.drivers;
    pool = hired(pool, "A", d1.id).pool;
    pool = hired(pool, "B", d2.id).pool;
    pool = hired(pool, "C", d3.id).pool;
    for (let i = 0; i < 20; i++) pool = recordDriverRace(pool, d1.id, { position: 1, cars: 8, finished: true, wallHits: 0, laps: 5, pitStops: 1 });
    const set = setRenew(pool, "C", false);
    if (!set.ok) throw new Error();
    pool = set.pool;
    const grownFee = driverFee(findDriver(pool, d1.id)!);
    const r = renewContracts(pool, { A: 1e9, B: 0, C: 1e9 }, 1);
    expect(r.charges).toEqual([{ teamId: "A", amount: grownFee, driverId: d1.id }]);
    expect(teamDriver(r.pool, "A")?.contract?.paidSeason).toBe(1);
    expect(teamDriver(r.pool, "B")).toBeUndefined();
    expect(teamDriver(r.pool, "C")).toBeUndefined();
    expect(r.events.map((e) => e.type).sort()).toEqual(["contract_ended", "contract_ended", "contract_renewed"]);
    // 2 回呼んでも 2 回は払わない
    expect(renewContracts(r.pool, { A: 1e9 }, 1).charges).toEqual([]);
  });
});

describe("育ち方", () => {
  it("レースに出るほど伸びしろへ近づき、超えない", () => {
    let d = makeDriver(1, 0);
    const start = driverOverall(d.stats);
    for (let i = 0; i < 300; i++) d = growDriver(d, { position: 2, cars: 8, finished: true, wallHits: 0, laps: 5, pitStops: 1 });
    expect(d.races).toBe(300);
    expect(driverOverall(d.stats)).toBeGreaterThan(start);
    for (const k of STAT_KEYS) {
      expect(d.stats[k]).toBeLessThanOrEqual(d.potential[k]);
      expect(d.potential[k] - d.stats[k]).toBeLessThan(1);
    }
  });

  it("壁に当たると安定が育ちにくい・ピットに入ると判断が育つ", () => {
    const d = makeDriver(2, 0);
    const clean = growDriver(d, { position: 4, cars: 8, finished: true, wallHits: 0, laps: 5, pitStops: 1 });
    const messy = growDriver(d, { position: 4, cars: 8, finished: true, wallHits: 3, laps: 5, pitStops: 0 });
    expect(clean.stats.stability).toBeGreaterThan(messy.stats.stability);
    expect(clean.stats.pitSense).toBeGreaterThan(messy.stats.pitSense);
  });
});

describe("運転", () => {
  it("能力から skill は bot の幅 (0.7..0.95) に入り、速い運転手ほど高い", () => {
    const lo = driverTraits({ speed: 15, stability: 15, tyreFuel: 15, pitSense: 15 });
    const hi = driverTraits({ speed: 100, stability: 100, tyreFuel: 100, pitSense: 100 });
    expect(lo.skill).toBeGreaterThanOrEqual(0.7);
    expect(hi.skill).toBeCloseTo(0.95);
    expect(hi.skill).toBeGreaterThan(lo.skill);
    expect(hi.wearScale).toBeLessThan(lo.wearScale);
    expect(hi.mistakeScale).toBeLessThan(lo.mistakeScale);
  });

  it("driverBrain は makeBrain と同じ形で skill だけ能力から", () => {
    const s = { speed: 80, stability: 60, tyreFuel: 50, pitSense: 40 };
    const b = driverBrain(s, seededRand(1));
    const ref = makeBrain(seededRand(1), driverTraits(s).skill);
    // pitSense (ピットの判断) だけは雇った運転手に足す
    expect(Object.keys(b).filter((k) => k !== "pitSense").sort()).toEqual(Object.keys(ref).sort());
    expect(b.pitSense).toBeGreaterThanOrEqual(0);
    expect(b.skill).toBe(ref.skill);
    expect(b.offset).toBe(ref.offset);
    expect(b.reaction).toBeGreaterThan(0);
  });
});
