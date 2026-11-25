// タイヤの部品の特徴 (DECISIONS の最後の項「タイヤの部品にも特徴」) と、研究の部品を車に付けられること
import { describe, expect, it } from "vitest";
import {
  BURST_GRIP, KERB_WEAR, NO_TIRE_MODS, PARTS, RESEARCH_PARTS, SAMPLE_DESIGN, TIRE_ORDER, TIRE_TRAITS, TIRE_TRAIT_ORDER, blendTireMods, cleanInventory,
  computeStats, createCar, getTrack, pointAt, puddleEffect, puddlesOf, queryTrack, stepCar, surfaceAt, tireGrip, traitGrip, traitMods, validateDesign,
  type CarDesign, type CarState, type CarStats, type TireMods, type TireTrait,
} from "../src/index.ts";

const track = getTrack("aozu");
const base = computeStats(SAMPLE_DESIGN);

/** 見本の車に、特徴 trait (段階 tier) のタイヤだけが付いているとした性能 */
function withTrait(trait: TireTrait | null, tier = 3): CarStats {
  return { ...base, tireMods: trait ? traitMods(trait, tier) : { ...NO_TIRE_MODS } };
}

/** コースの距離 s・横のずれ d に、向きをそろえて速さ v で置いた車 */
function placeCar(stats: CarStats, s: number, d: number, v: number, side = 0): CarState {
  const car = createCar(track, stats, 0);
  const p = pointAt(track, s, d);
  car.x = p.x;
  car.y = p.y;
  car.heading = p.heading;
  const fx = Math.cos(p.heading);
  const fy = Math.sin(p.heading);
  car.vx = fx * v - fy * side;
  car.vy = fy * v + fx * side;
  const q = queryTrack(track, p.x, p.y);
  car.hint = q.index;
  car.lastS = q.s;
  car.dist = q.s;
  car.started = true;
  return car;
}

const coast = { steer: 0, throttle: 0, brake: 0 };

/** 決まった運転で 1 刻み: 中心の線の少し先へ向かい、24 m/s を保つ (bot.ts を使わずに毎回同じ動き) */
function follow(car: CarState, stats: CarStats) {
  const p = pointAt(track, car.lastS + 12, 0);
  let diff = Math.atan2(p.y - car.y, p.x - car.x) - car.heading;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return stepCar(car, { steer: Math.max(-1, Math.min(1, diff * 2.5)), throttle: Math.hypot(car.vx, car.vy) < 24 ? 1 : 0, brake: 0 }, stats, track, undefined, { damage: false });
}

describe("特徴の表", () => {
  it("7 つの特徴があり、段階が上がるほど 良い所が大きく 悪い所が小さい", () => {
    expect(TIRE_TRAIT_ORDER.length).toBe(7);
    expect(TIRE_TRAIT_ORDER.map((t) => TIRE_TRAITS[t].name)).toEqual(["長持ち", "食いつき", "雨に強い", "縁石に強い", "破裂しにくい", "曲がりに強い", "ブレーキに強い"]);
    for (const t of TIRE_TRAIT_ORDER) {
      const d = TIRE_TRAITS[t];
      for (let i = 1; i < 5; i++) {
        expect(d.good[i], `${t} good ${i}`).toBeGreaterThan(d.good[i - 1]);
        expect(d.bad[i], `${t} bad ${i}`).toBeLessThan(d.bad[i - 1]);
      }
      for (const v of [...d.good, ...d.bad]) expect(v).toBeGreaterThan(0);
    }
  });

  it("お店の段階 1〜2 のタイヤにも 研究の段階 3〜5 のタイヤにも特徴があり、7 つ全部がどこかにある", () => {
    const tires = [...PARTS, ...RESEARCH_PARTS].filter((p) => p.kind === "tire");
    for (const p of tires) expect(p.trait, p.id).toBeDefined();
    expect(new Set(tires.map((p) => p.trait))).toEqual(new Set(TIRE_TRAIT_ORDER));
    expect(PARTS.filter((p) => p.kind === "tire").every((p) => p.tier <= 2)).toBe(true);
    // お店の特徴は 研究で強くなる (同じ特徴の 段階の高い部品がある)
    for (const t of ["bite", "corner"] as const) {
      const shop = PARTS.find((p) => p.kind === "tire" && p.trait === t)!;
      const lab = RESEARCH_PARTS.find((p) => p.kind === "tire" && p.trait === t)!;
      expect(lab.tier).toBeGreaterThan(shop.tier);
    }
  });

  it("特徴のない部品は 何も変えない。混ぜると握りの割合で効く", () => {
    expect(traitMods(undefined, 3)).toEqual(NO_TIRE_MODS);
    const a = traitMods("bite", 1);
    const m = blendTireMods([{ mods: a, weight: 1.8 }, { mods: { ...NO_TIRE_MODS }, weight: 1 }]);
    expect(m.grip).toBeCloseTo(1 + 0.02 * (1.8 / 2.8), 10);
    // 見本の車: 前は細いタイヤ (破裂しにくい)、後ろは太いタイヤ (食いつき)
    expect(base.tireMods!.grip).toBeCloseTo(1 + 0.02 * (3.6 / 5.6), 10);
    expect(base.tireMods!.tough).toBeCloseTo(0.06 * (2 / 5.6), 10);
    expect(base.tireTraits!.map((x) => x.trait)).toEqual(["bite", "tough"]);
  });

  it("特徴は種類 (S・M・H・I・W) の効きに掛け合わせで効く", () => {
    const m = traitMods("rain", 4);
    for (const c of TIRE_ORDER) {
      for (const wet of [0, 0.3, 0.6, 0.9]) {
        const car = { tire: c, wear: 0.3, burst: false };
        expect(tireGrip(car, wet, m) / tireGrip(car, wet, NO_TIRE_MODS)).toBeCloseTo(traitGrip(m, wet), 10);
      }
    }
    // 破裂したら特徴は効かない
    expect(tireGrip({ tire: "M", wear: 1, burst: true }, 0, traitMods("bite", 5))).toBe(BURST_GRIP);
  });
});

describe("特徴は言うとおりに効く", () => {
  /** 決まった運転 (中心の線の少し先へ向かい、24 m/s を保つ) で 30 秒走ったときの すり減り */
  const wearAfterLap = (stats: CarStats) => {
    const car = placeCar(stats, 20, 0, 24);
    for (let i = 0; i < 60 * 30; i++) follow(car, stats);
    return car.wear;
  };

  it("長持ち: すり減りが遅い / 握りが少し低い", () => {
    const n = wearAfterLap(withTrait(null));
    const l = wearAfterLap(withTrait("long"));
    expect(n).toBeGreaterThan(0.01);
    expect(l).toBeLessThan(n * 0.9);
    const car = { tire: "M" as const, wear: 0, burst: false };
    expect(tireGrip(car, 0, traitMods("long", 3))).toBeLessThan(tireGrip(car, 0, NO_TIRE_MODS));
  });

  it("食いつき: 握りが高い / 早くすり減る", () => {
    const car = { tire: "M" as const, wear: 0, burst: false };
    expect(tireGrip(car, 0, traitMods("bite", 3))).toBeGreaterThan(tireGrip(car, 0, NO_TIRE_MODS));
    // 減りの倍率は +5.5% (段階 3)。握りが高い分 横滑りが減り、その分の減りが少ない。
    // 11/25 速いときの切れ角の制限 (physics.ts の STEER_LIMIT) で この決まった運転の横滑りが減り、差は約 +3.3% → 約 +1.9% (前は 1.03 倍で見ていた)
    expect(wearAfterLap(withTrait("bite"))).toBeGreaterThan(wearAfterLap(withTrait(null)) * 1.01);
  });

  it("雨に強い: 濡れた路面と水たまりで滑りにくい / 乾いた路面で少し遅い", () => {
    const m = traitMods("rain", 3);
    const car = { tire: "I" as const, wear: 0, burst: false };
    expect(tireGrip(car, 0.8, m)).toBeGreaterThan(tireGrip(car, 0.8, NO_TIRE_MODS));
    expect(tireGrip(car, 0, m)).toBeLessThan(tireGrip(car, 0, NO_TIRE_MODS));
    const p = puddlesOf(track)[0];
    const at = pointAt(track, p.s, p.d);
    const q = queryTrack(track, at.x, at.y);
    const plain = puddleEffect(track, q, 1, "M");
    const rain = puddleEffect(track, q, 1, "M", m.puddle);
    expect(plain.grip).toBeLessThan(1);
    expect(rain.grip).toBeGreaterThan(plain.grip);
    expect(puddleEffect(track, q, 1, "M", 1)).toEqual(plain);
  });

  it("縁石に強い: 縁石で握りが落ちにくく、減りにくい", () => {
    const i = track.kerb.findIndex((k, j) => k !== 0 && j > 50);
    expect(i).toBeGreaterThan(0);
    const side = track.kerb[i];
    const s = i * track.step;
    const d = side * (track.def.halfWidth - 0.4);
    const run = (stats: CarStats) => {
      const car = placeCar(stats, s, d, 20, 3);
      expect(surfaceAt(track, queryTrack(track, car.x, car.y))).toMatchObject({ kind: "kerb" });
      stepCar(car, coast, stats, track);
      return { wear: car.wear, slip: car.slip };
    };
    const n = run(withTrait(null));
    const k = run(withTrait("kerb", 4));
    expect(k.slip).toBeLessThan(n.slip);
    expect(k.wear).toBeLessThan(n.wear);
    // 縁石の上は アスファルトより減る
    const flat = placeCar(withTrait(null), s, 0, 20, 3);
    stepCar(flat, coast, withTrait(null), track);
    expect(n.wear).toBeGreaterThan(flat.wear * (KERB_WEAR - 0.2));
  });

  it("破裂しにくい: すり減りの限界を超えても少しだけ走れる / 少し早くすり減る", () => {
    const toBurst = (stats: CarStats) => {
      const car = placeCar(stats, 20, 0, 24);
      car.wear = 0.995;
      const from = car.dist;
      for (let k = 0; k < 60 * 300 && !car.burst; k++) follow(car, stats);
      return { m: car.dist - from, burst: car.burst };
    };
    const n = toBurst(withTrait(null));
    const t = toBurst(withTrait("tough", 4));
    expect(n.burst).toBe(true);
    expect(t.burst).toBe(true);
    expect(t.m).toBeGreaterThan(n.m + 100);
    expect(traitMods("tough", 4).wear).toBeGreaterThan(1);
  });

  it("曲がりに強い / ブレーキに強い: 横の握りと止まる力が入れ替わる", () => {
    const slide = (stats: CarStats) => {
      const car = placeCar(stats, 20, 0, 25, 4);
      stepCar(car, coast, stats, track);
      return car.slip;
    };
    const stop = (stats: CarStats) => {
      const car = placeCar(stats, 20, 0, 30);
      for (let k = 0; k < 30; k++) stepCar(car, { steer: 0, throttle: 0, brake: 1 }, stats, track);
      return Math.hypot(car.vx, car.vy);
    };
    const n = withTrait(null);
    const c = withTrait("corner");
    const b = withTrait("brake");
    expect(slide(c)).toBeLessThan(slide(n));
    expect(slide(b)).toBeGreaterThan(slide(n));
    expect(stop(b)).toBeLessThan(stop(n));
    expect(stop(c)).toBeGreaterThan(stop(n));
  });

  it("同じ計算は同じ答え (決まった計算)", () => {
    const run = () => {
      const st = withTrait("tough", 2);
      const car = placeCar(st, 100, 1, 28, 2);
      for (let k = 0; k < 600; k++) stepCar(car, { steer: Math.sin(k / 40), throttle: 1, brake: 0 }, st, track, undefined, { wetness: 0.8 });
      return [car.x, car.y, car.wear, car.overWear ?? 0];
    };
    expect(run()).toEqual(run());
  });
});

describe("研究の部品 (段階 3〜5) を車に付けられる", () => {
  const swap = (from: string, to: string): CarDesign => ({ name: "研究", parts: SAMPLE_DESIGN.parts.map((p) => (p.id === from ? { ...p, id: to } : p)) });

  it("validateDesign と computeStats が 研究の部品を知っている", () => {
    const d = swap("tire_w1", "tire_w5");
    expect(validateDesign(d)).toEqual([]);
    const st = computeStats(d);
    expect(st.gripAccel).toBeGreaterThan(base.gripAccel);
    expect(st.tireTraits!.some((x) => x.trait === "bite" && x.tier === 5)).toBe(true);
    expect(st.tireMods!.grip).toBeGreaterThan(base.tireMods!.grip);
    const e = swap("eng_m1", "eng_p3");
    expect(validateDesign(e)).toEqual([]);
    expect(computeStats(e).power).toBeGreaterThan(base.power);
    expect(validateDesign(swap("tire_w1", "no_such_tire"))).toEqual(["知らない部品があります"]);
  });

  it("持ち物は 研究の部品も数え、知らない部品は捨てる", () => {
    expect(cleanInventory({ tire_w5: 2, eng_p3: 1, tire_n1: 3, nope: 4 })).toEqual({ tire_w5: 2, eng_p3: 1, tire_n1: 3 });
  });

  it("特徴の倍率は特徴のない値とずれない (特徴なしは前と同じ動き)", () => {
    const m: TireMods = blendTireMods([]);
    expect(m).toEqual(NO_TIRE_MODS);
  });
});
