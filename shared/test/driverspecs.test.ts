// 運転手の名簿 (似た名前)・得意・珍しい運転手・契約金の式・ライバルの運転手 (11/25 ユーザー「あと運転手も追加していこう」)
import { describe, expect, it } from "vitest";
import {
  DRIVERS, DRIVER_CATALOG, FRESH_WEAR, KERB_WIDTH, RARE_DRIVER_IDS, RIVAL, SAMPLE_DESIGN, SPECIALTIES, SPECIALTY_FX, SPECIALTY_IDS, STAT_KEYS,
  TRACK_DEFS, botInput, catalogDriver, computeStats, createCar, createDriverPool, createRivals, driverBrain, driverCarScales, driverFee,
  driverOverall, driverShortName, ensureFreeDrivers, findDriver, freeDrivers, getTrack, hireDriver, makeBrain, makeDriver, offerRareDriver,
  pointAt, prizeOffers, rivalBrain, rivalCarScales, rivalDriveParams, seasonWindow, signingCost, specFeeFactor, stepCar, upgradeDriverPool,
  withCatalogDriver, type Body, type CarState, type DriverPool, type SpecialtyId,
} from "../src/index.ts";

/** 小さな指紋 (FNV-1a と 31 倍の和)。node の型に頼らない */
const hash = (x: unknown) => {
  const s = JSON.stringify(x);
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
};
const S0 = seasonWindow(0);
const MID = { speed: 60, stability: 60, tyreFuel: 60, pitSense: 60 };

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

describe("足すだけ (前からいる運転手は変わらない)", () => {
  it("作りものの 40 人 (本番の種) と 種 7 の 120 人の 名前・能力・伸びしろ は 名簿を足す前と同じ", () => {
    // 名簿を足す前 (11/25) の作りと同じ値 (sha256 でも前と同じことを確かめた)
    const pool = createDriverPool(20261125);
    expect(hash(pool.drivers.slice(0, 40).map((d) => [d.id, d.name, d.stats, d.potential]))).toBe("f9f1cd5c01cf411f");
    expect(hash(Array.from({ length: 120 }, (_, i) => makeDriver(7, i)).map((d) => [d.id, d.name, d.stats, d.potential]))).toBe("851f8e8050b40e4b");
    expect(makeDriver(20261125, 0)).toMatchObject({ id: "d0", name: "柊沢 ハギ", stats: { speed: 51, stability: 67, tyreFuel: 46, pitSense: 54 }, potential: { speed: 64, stability: 90, tyreFuel: 70, pitSense: 62 } });
    expect(makeDriver(20261125, 57)).toMatchObject({ id: "d57", name: "砥森 セクン", stats: { speed: 57, stability: 46, tyreFuel: 39, pitSense: 56 } });
  });

  it("名簿のはじめの 46 人 (40 + 珍しい 6) は 並び・id・能力・得意を変えない (足すときは末尾に)", () => {
    expect(DRIVER_CATALOG.length).toBeGreaterThanOrEqual(46);
    expect(hash(DRIVER_CATALOG.slice(0, 46).map((e) => [e.id, e.name, e.s, e.g, e.specs, !!e.rare]))).toBe("ff25d9a2a0ab6f9f");
  });

  it("名簿: id と名前は重ならず、能力は幅の中、得意は 0〜2 つ、国と年代がばらける", () => {
    const ids = DRIVER_CATALOG.map((e) => e.id);
    const names = DRIVER_CATALOG.map((e) => e.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const e of DRIVER_CATALOG) {
      expect(e.id).not.toMatch(/^d\d+$/);
      expect(e.name).toMatch(/^[゠-ヿ・]+$/);
      expect(e.specs.length).toBeLessThanOrEqual(2);
      expect(new Set(e.specs).size).toBe(e.specs.length);
      for (const s of e.specs) expect(SPECIALTY_IDS).toContain(s);
      for (const v of e.s) {
        expect(v).toBeGreaterThanOrEqual(DRIVERS.statMin);
        expect(v).toBeLessThanOrEqual(e.rare ? 90 : DRIVERS.statMax);
      }
    }
    expect(new Set(DRIVER_CATALOG.map((e) => e.nat)).size).toBeGreaterThanOrEqual(12);
    expect(new Set(DRIVER_CATALOG.map((e) => e.era)).size).toBeGreaterThanOrEqual(6);
    expect(RARE_DRIVER_IDS).toHaveLength(6);
    // 全部の得意に 雇える人がいる
    for (const s of SPECIALTY_IDS) expect(DRIVER_CATALOG.some((e) => !e.rare && e.specs.includes(s)), s).toBe(true);
  });

  it("はじめの候補は 作りもの 40 + 名簿のふつうの 40 = 80 人。作りものにも得意 (別の乱数) が付く", () => {
    const pool = createDriverPool(20261125);
    expect(pool.drivers).toHaveLength(80);
    expect(pool.drivers.slice(40).map((d) => d.id)).toEqual(DRIVER_CATALOG.filter((e) => !e.rare).map((e) => e.id));
    const n = [0, 1, 2].map((k) => pool.drivers.slice(0, 40).filter((d) => d.specs!.length === k).length);
    expect(n.every((x) => x > 0)).toBe(true);
    // ensureFreeDrivers で足す人は 名簿のあとに 作りもの d80.. ではなく d40.. (番号は作りものだけで数える)
    const more = ensureFreeDrivers({ ...pool, drivers: pool.drivers.map((d) => ({ ...d, contract: { teamId: "x", fee: 1, since: 0, paidSeason: 0, renew: true } })) }, 3);
    expect(more.drivers.slice(80).map((d) => d.id)).toEqual(["d40", "d41", "d42"]);
  });

  it("前に保存した候補は upgradeDriverPool で 得意と名簿を足すだけ。2 回目は同じものを返す", () => {
    const fresh = createDriverPool(99, 45, false);
    const old: DriverPool = { seed: fresh.seed, next: fresh.next, drivers: fresh.drivers.map(({ specs: _s, ...d }) => d) };
    old.drivers[2] = { ...old.drivers[2], races: 7, contract: { teamId: "A", fee: 900, since: 0, paidSeason: 0, renew: true } };
    const up = upgradeDriverPool(old);
    expect(up.drivers.slice(0, 45).map((d) => [d.id, d.name, d.stats, d.potential, d.races, d.contract])).toEqual(old.drivers.map((d) => [d.id, d.name, d.stats, d.potential, d.races, d.contract]));
    expect(up.drivers.slice(0, 45).map((d) => d.specs)).toEqual(fresh.drivers.map((d) => d.specs));
    expect(up.drivers.slice(45).map((d) => d.id)).toEqual(DRIVER_CATALOG.filter((e) => !e.rare).map((e) => e.id));
    expect(up.next).toBe(45);
    expect(upgradeDriverPool(up)).toBe(up);
  });

  it("部屋の名前 (12 字) に入らない名前は 名字だけ", () => {
    expect(driverShortName("ランド・ノリソ")).toBe("ランド・ノリソ");
    expect(driverShortName("ファン・マヌエル・ファンジョ")).toBe("ファンジョ");
    for (const e of DRIVER_CATALOG) expect([...driverShortName(e.name)].length).toBeLessThanOrEqual(12);
  });
});

describe("契約金の式", () => {
  it("feeBase × (総合 / 50)² × (1 + 得意の割合)、50 で丸める", () => {
    const base: Omit<Parameters<typeof driverFee>[0], "specs"> = { id: "x", name: "x", stats: MID, potential: MID, races: 0, contract: null };
    const raw = DRIVERS.feeBase * (driverOverall(MID) / 50) ** 2;
    expect(driverFee(base)).toBe(Math.round(raw / 50) * 50);
    expect(driverFee({ ...base, specs: ["rain"] })).toBe(Math.round((raw * 1.1) / 50) * 50);
    expect(driverFee({ ...base, specs: ["rain", "kerb"] })).toBe(Math.round((raw * (1 + SPECIALTIES.rain.fee + SPECIALTIES.kerb.fee)) / 50) * 50);
    expect(specFeeFactor(["tyre", "defend"])).toBeCloseTo(1.18, 9);
    expect(specFeeFactor([])).toBe(1);
    // 例: 名簿の運転手
    const fee = (id: string) => driverFee(catalogDriver(DRIVER_CATALOG.find((e) => e.id === id)!));
    expect(fee("c15")).toBe(4200);
    expect(fee("c02")).toBe(3050);
    expect(fee("c09")).toBe(1300);
    expect(fee("c11")).toBe(1050);
  });

  it("若手は安くて伸びしろが大きい。名の知れた人は高く、伸びしろが小さい", () => {
    const pool = createDriverPool(20261125);
    const cat = pool.drivers.filter((d) => /^c\d+$/.test(d.id));
    const room = (d: { stats: typeof MID; potential: typeof MID }) => STAT_KEYS.reduce((s, k) => s + d.potential[k] - d.stats[k], 0) / 4;
    const young = cat.filter((d) => room(d) >= 30);
    const stars = cat.filter((d) => driverOverall(d.stats) >= 70);
    expect(young.length).toBeGreaterThanOrEqual(5);
    expect(stars.length).toBeGreaterThanOrEqual(4);
    for (const y of young) for (const s of stars) expect(driverFee(y)).toBeLessThan(driverFee(s) / 2);
    // 育ちきると 若手は名の知れた人に近くなる
    for (const y of young) expect(driverOverall(y.potential)).toBeGreaterThan(72);
  });
});

describe("珍しい運転手", () => {
  it("はじめの候補に入らず、名簿から足しても 空いている候補 (freeDrivers) に数えない", () => {
    const pool = createDriverPool(5);
    for (const id of RARE_DRIVER_IDS) expect(findDriver(pool, id)).toBeUndefined();
    const added = withCatalogDriver(pool, "rare1");
    expect(findDriver(added, "rare1")?.rare).toBe(true);
    expect(freeDrivers(added).some((d) => d.id === "rare1")).toBe(false);
    expect(freeDrivers(added)).toHaveLength(freeDrivers(pool).length);
    expect(withCatalogDriver(pool, "no-such")).toBe(pool);
  });

  it("ごほうびがなければ雇えない。ごほうびのチームだけ ただで雇え、期限が過ぎたら雇えない", () => {
    let pool = withCatalogDriver(createDriverPool(5), "rare3");
    expect(hireDriver(pool, "A", "rare3", 1e9, S0, S0.startsAt)).toEqual({ ok: false, error: "not_found" });
    const r = offerRareDriver(pool, "A", 0, 1)!;
    expect(r).not.toBeNull();
    pool = r.pool;
    const d = findDriver(pool, r.driverId)!;
    expect(prizeOffers(pool, "A", 0).map((x) => x.id)).toEqual([r.driverId]);
    expect(prizeOffers(pool, "B", 0)).toEqual([]);
    expect(prizeOffers(pool, "A", 2)).toEqual([]);
    expect(signingCost(d, S0, S0.startsAt)).toBe(0);
    expect(hireDriver(pool, "B", r.driverId, 1e9, S0, S0.startsAt)).toEqual({ ok: false, error: "not_found" });
    const S2 = seasonWindow(2);
    expect(hireDriver(pool, "A", r.driverId, 1e9, S2, S2.startsAt)).toEqual({ ok: false, error: "not_found" });
    const h = hireDriver(pool, "A", r.driverId, 0, S0, S0.startsAt);
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.cost).toBe(0);
    const mine = findDriver(h.pool, r.driverId)!;
    expect(mine.contract?.teamId).toBe("A");
    expect(mine.contract?.fee).toBe(driverFee(mine));
    expect(mine.offer).toBeUndefined();
  });

  it("ごほうびは季節で回り、契約中・ほかのチームへのごほうび中の人を飛ばす", () => {
    const pool = createDriverPool(5);
    const a = offerRareDriver(pool, "A", 0, 1)!;
    expect(a.driverId).toBe(RARE_DRIVER_IDS[0]);
    expect(offerRareDriver(pool, "A", 3, 4)!.driverId).toBe(RARE_DRIVER_IDS[3]);
    const b = offerRareDriver(a.pool, "B", 0, 1)!;
    expect(b.driverId).toBe(RARE_DRIVER_IDS[1]);
    const taken = { ...b.pool, drivers: b.pool.drivers.map((d) => (d.rare ? { ...d, offer: undefined, contract: { teamId: "Z", fee: 1, since: 0, paidSeason: 0, renew: true } } : d)) };
    for (const id of RARE_DRIVER_IDS) if (!findDriver(taken, id)) taken.drivers.push({ ...withCatalogDriver(taken, id).drivers.at(-1)!, contract: { teamId: "Z", fee: 1, since: 0, paidSeason: 0, renew: true } });
    expect(offerRareDriver(taken, "C", 0, 1)).toBeNull();
  });
});

describe("得意の効き目", () => {
  it("車の倍率: タイヤ・燃費・縁石。得意がなければ今の形のまま", () => {
    expect(driverCarScales(MID)).toEqual({ wearScale: driverCarScales(MID, []).wearScale, fuelScale: driverCarScales(MID, []).fuelScale });
    expect(Object.keys(driverCarScales(MID, ["rain", "pass"])).sort()).toEqual(["fuelScale", "wearScale"]);
    const plain = driverCarScales(MID);
    const t = driverCarScales(MID, ["tyre"]);
    expect(t.wearScale).toBeCloseTo(plain.wearScale * SPECIALTY_FX.tyreWear, 9);
    expect(t.fuelScale).toBe(plain.fuelScale);
    const f = driverCarScales(MID, ["fuel", "kerb"]);
    expect(f.fuelScale).toBeCloseTo(plain.fuelScale * SPECIALTY_FX.fuelScale, 9);
    expect(f.kerbScale).toBe(SPECIALTY_FX.kerbScale);
  });

  it("頭: スタート (反応が速い)・予選 (1 周アタックの走りは上手く)・雨・抜き・守り。得意がなければ makeBrain の形のまま", () => {
    const plain = driverBrain(MID, seeded(4));
    expect(driverBrain(MID, seeded(4), [])).toEqual(plain);
    expect(Object.keys(plain).filter((k) => k !== "pitSense").sort()).toEqual(Object.keys(makeBrain(seeded(4))).sort());
    expect(driverBrain(MID, seeded(4), ["start"]).reaction).toBeCloseTo(Math.max(0.1, plain.reaction * SPECIALTY_FX.startReaction), 9);
    const q = driverBrain(MID, seeded(4), ["quali"]);
    expect(q.freshSkill).toBe(SPECIALTY_FX.qualiFreshSkill);
    expect(q.skill).toBe(plain.skill);
    const qa = driverBrain(MID, seeded(4), ["quali"], { quali: true });
    expect(qa.skill).toBeCloseTo(plain.skill + SPECIALTY_FX.qualiFreshSkill, 9);
    expect(driverBrain(MID, seeded(4), ["rain"]).wetSkill).toBe(SPECIALTY_FX.rainWetSkill);
    expect(driverBrain(MID, seeded(4), ["pass"]).passAggression).toBe(SPECIALTY_FX.passAggression);
    expect(driverBrain(MID, seeded(4), ["defend"]).defend).toBe(SPECIALTY_FX.defend);
  });

  const track = getTrack(TRACK_DEFS[0].id);
  const stats = computeStats(SAMPLE_DESIGN);
  /** 同じ頭の種で 20 秒走らせた道のり */
  function drive(specs: SpecialtyId[], o: { wet?: number; wear?: number; tire?: "M" | "I" | "W" } = {}) {
    const car = createCar(track, stats, 0, { tire: o.tire ?? "M", wear: o.wear ?? 0 });
    const brain = driverBrain(MID, seeded(3), specs);
    car.started = true;
    for (let i = 0; i < 60 * 20; i++) stepCar(car, botInput(car, stats, track, brain, i / 60, [], o.wet ?? 0), stats, track, 1 / 60, { wetness: o.wet ?? 0 });
    return car.dist;
  }

  it("雨に強い: 濡れた路面で速い。乾いた路面では同じ", () => {
    expect(drive(["rain"], { wet: 0.8, tire: "I" })).toBeGreaterThan(drive([], { wet: 0.8, tire: "I" }) + 1);
    expect(drive(["rain"])).toBe(drive([]));
  });

  it("予選が速い: 新しいタイヤの間だけ速い (すり減ったタイヤでは同じ)", () => {
    expect(drive(["quali"])).toBeGreaterThan(drive([]) + 1);
    expect(drive(["quali"], { wear: FRESH_WEAR + 0.1 })).toBe(drive([], { wear: FRESH_WEAR + 0.1 }));
  });

  /** 道の中心を 30 m/s で走る車と、前か後ろの車 */
  function scene(gap: number, lateral: number, otherSpeed: number) {
    const s0 = 400;
    const p = pointAt(track, s0, 0);
    const car = createCar(track, stats, 0, { tire: "M" });
    car.started = true;
    Object.assign(car, { x: p.x, y: p.y, heading: p.heading, vx: 30 * Math.cos(p.heading), vy: 30 * Math.sin(p.heading), hint: p.index, lastS: s0 });
    const q = pointAt(track, s0 + gap, lateral);
    const other: Body = { x: q.x, y: q.y, heading: q.heading, vx: otherSpeed * Math.cos(q.heading), vy: otherSpeed * Math.sin(q.heading), mass: 600, width: stats.width, length: stats.length, bodyLx: 0, bodyLf: 0 };
    return { car, others: [other] };
  }

  it("追い抜きがうまい: 遠くの遅い車にも早めに仕掛ける", () => {
    // ふつうは 5 + 30 × 0.6 = 23 m 先まで。抜きがうまい人は × 1.35 = 31 m
    const sc = scene(27, 0, 20);
    const plain = driverBrain(MID, seeded(2));
    const pass = driverBrain(MID, seeded(2), ["pass"]);
    botInput(sc.car, stats, track, plain, 1, sc.others);
    botInput(sc.car, stats, track, pass, 1, sc.others);
    expect(plain.passSide).toBe(0);
    expect(pass.passSide).not.toBe(0);
  });

  it("守りが固い: 後ろから詰めてくる車の側へ寄せる。後ろに誰もいなければ同じ", () => {
    const run = (specs: SpecialtyId[], gap: number) => {
      const sc = scene(gap, 1.5, 36);
      return botInput(sc.car, stats, track, driverBrain(MID, seeded(2), specs), 1, sc.others).steer;
    };
    expect(run(["defend"], -7)).not.toBeCloseTo(run([], -7), 3);
    expect(run(["defend"], -60)).toBe(run([], -60));
    // 寄せる向きは 後ろの車のいる側 (横 +1.5) と同じ向き
    const sc = scene(-7, 1.5, 36);
    const sc2 = scene(-7, -1.5, 36);
    const a = botInput(sc.car, stats, track, driverBrain(MID, seeded(2), ["defend"]), 1, sc.others).steer;
    const b = botInput(sc2.car, stats, track, driverBrain(MID, seeded(2), ["defend"]), 1, sc2.others).steer;
    expect(Math.sign(a - b)).not.toBe(0);
  });

  it("縁石がうまい: 縁石の上で 握りの落ちと余分なすり減りが小さい", () => {
    const i = track.kerb.findIndex((k) => k !== 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const side = track.kerb[i];
    const step1 = (kerbScale?: number) => {
      const car: CarState = createCar(track, stats, 0, { tire: "M", ...(kerbScale !== undefined ? { kerbScale } : {}) });
      const s = i * track.step;
      const p = pointAt(track, s, side * (track.def.halfWidth - KERB_WIDTH / 2));
      Object.assign(car, { x: p.x, y: p.y, heading: p.heading, vx: 25 * Math.cos(p.heading), vy: 25 * Math.sin(p.heading), hint: p.index, lastS: s, started: true });
      stepCar(car, { steer: 0.3, throttle: 1, brake: 0 }, stats, track, 1 / 60);
      expect(car.surface).toBe("kerb");
      return car.wear;
    };
    expect(step1(0.5)).toBeLessThan(step1());
    expect(step1(1)).toBe(step1());
  });
});

describe("コンピューターのチームの運転手", () => {
  it("名簿から回る (リーグの種で決まる)。強さは前の式の席のまま、得意は名簿から", () => {
    const names = new Set(DRIVER_CATALOG.filter((e) => !e.rare).map((e) => e.name));
    let fromCat = 0;
    let all = 0;
    for (let seed = 0; seed < 20; seed++) {
      for (const d of [1, 4, 8]) {
        const rv = createRivals(seed, d, 3);
        expect(rv).toEqual(createRivals(seed, d, 3));
        const dn = rv.flatMap((r) => r.drivers.map((x) => x.name));
        expect(new Set(dn).size).toBe(dn.length);
        for (const r of rv) for (const x of r.drivers) {
          all++;
          if (names.has(x.name)) {
            fromCat++;
            const e = DRIVER_CATALOG.find((c) => c.name === x.name)!;
            expect(x.specs).toEqual(e.specs);
          }
          expect(RARE_DRIVER_IDS.some((id) => DRIVER_CATALOG.find((c) => c.id === id)!.name === x.name)).toBe(false);
        }
      }
    }
    expect(fromCat / all).toBeGreaterThan(RIVAL.catalogShare - 0.15);
    expect(fromCat / all).toBeLessThan(RIVAL.catalogShare + 0.15);
  });

  it("名簿から来ても 総合は前の作りものの運転手とほぼ同じ (部の強さの釣り合いはそのまま)", () => {
    for (let seed = 0; seed < 10; seed++) {
      const lseed = seed * 16 + 8;
      const rv = createRivals(seed, 8, 3);
      rv.forEach((r, i) => r.drivers.forEach((x, k) => {
        const proc = makeDriver(lseed + 7919, i * 2 + k);
        expect(Math.abs(driverOverall(x.stats) - driverOverall(proc.stats))).toBeLessThan(1.5);
      }));
    }
  });

  it("得意はライバルの頭と車にも効く。得意の無い (前に作った) ライバルは今のまま", () => {
    const rv = createRivals(3, 5)[0];
    const old = { ...rv, drivers: rv.drivers.map(({ specs: _s, ...d }) => d) as typeof rv.drivers };
    expect(rivalCarScales(old, 0)).toEqual({});
    const b = rivalBrain(old, 0, seeded(5), 0);
    expect(b.wetSkill).toBe(0);
    expect(b.defend).toBe(0);
    const withSpecs = { ...rv, drivers: [{ ...rv.drivers[0], specs: ["tyre", "pass"] as SpecialtyId[] }, rv.drivers[1]] as typeof rv.drivers };
    expect(rivalCarScales(withSpecs, 0)).toEqual({ wearScale: SPECIALTY_FX.tyreWear });
    expect(rivalBrain(withSpecs, 0, seeded(5), 0).passAggression).toBe(SPECIALTY_FX.passAggression);
    expect(rivalDriveParams(withSpecs, 0, 0).passAggression).toBeCloseTo(rivalDriveParams(old, 0, 0).passAggression * SPECIALTY_FX.passAggression, 9);
  });
});
