// 代走が遊ぶ人の走る前の準備 (タイヤと燃料) を使う (standin.ts・leaguerace.ts)
import { describe, expect, it } from "vitest";
import {
  SAMPLE_DESIGN,
  TRACK_DEFS,
  allocRules,
  botStartSetup,
  cleanSetupPref,
  computeStats,
  getTrack,
  makeBrain,
  planFuel,
  prefStartSetup,
  setsCount,
  simulateRace,
  type HeadlessCarSpec,
} from "../src/index.ts";

const track = getTrack(TRACK_DEFS[0].id);
const stats = computeStats(SAMPLE_DESIGN);

describe("走る前の準備を確かめる", () => {
  it("形のちがうものは null。組は 0 以上の整数にそろえる", () => {
    expect(cleanSetupPref(null)).toBeNull();
    expect(cleanSetupPref({ tire: "X", fuel: "full" })).toBeNull();
    expect(cleanSetupPref({ tire: "S", fuel: "lots" })).toBeNull();
    expect(cleanSetupPref({ tire: "S", fuel: "race", alloc: { S: 2.7, H: -1, Z: 3 }, tireFor: "slick", extra: 1 })).toEqual({ tire: "S", fuel: "race", alloc: { S: 2 }, tireFor: "slick" });
    expect(cleanSetupPref({ tire: "M", fuel: "light", alloc: {} })).toEqual({ tire: "M", fuel: "light" });
  });

  it("燃料: 満タン ≥ レースの分 ≥ 少なめ", () => {
    const full = planFuel(stats, track, 5, "full");
    const race = planFuel(stats, track, 5, "race");
    const light = planFuel(stats, track, 5, "light");
    expect(full).toBe(stats.fuelCap);
    expect(race).toBeLessThanOrEqual(full);
    expect(light).toBeLessThan(race);
  });
});

describe("代走のスタートの準備", () => {
  const rules = allocRules("league", 5);
  const ctx = { stats, track, laps: 5, rules, wet: 0, wetMax: 0 };
  const base = botStartSetup(stats, track, 5, 0, 0, undefined, { rules, wetMax: 0 });

  it("組の好みを決まりの数に合わせ、乾いた路面のために選んだタイヤで出る。燃料は好みの量", () => {
    const s = prefStartSetup({ tire: "S", fuel: "light", alloc: { S: 3, H: 3 }, tireFor: "slick" }, base, ctx);
    expect(s.tire).toBe("S");
    expect(s.fuel).toBe(planFuel(stats, track, 5, "light"));
    expect(setsCount(s.sets!) + 1).toBeLessThanOrEqual(rules.limit);
  });

  it("大雨なのに乾いた路面のタイヤを選んでいたら、持っている中で一番握るもの (雨用があればそれ)", () => {
    const wet = { ...ctx, wet: 0.8, wetMax: 0.8 };
    const s = prefStartSetup({ tire: "S", fuel: "full", alloc: { S: 1, W: 1, M: 1 }, tireFor: "slick" }, base, wet);
    expect(s.tire).toBe("W");
  });

  it("組の好みがなければおまかせの組。決まりのない練習なら燃料だけ", () => {
    const s = prefStartSetup({ tire: "M", fuel: "race" }, base, ctx);
    expect(s.sets).toBeTruthy();
    const practice = prefStartSetup({ tire: "S", fuel: "light" }, { tire: "M", fuel: 10 }, { ...ctx, rules: allocRules("practice", 0) });
    expect(practice.tire).toBe("M");
    expect(practice.fuel).toBe(planFuel(stats, track, 5, "light"));
  });
});

describe("リーグ戦のレース (simulateRace) の代走", () => {
  const spec = (id: string, extra: Partial<HeadlessCarSpec> = {}): HeadlessCarSpec => ({ id, design: SAMPLE_DESIGN, brain: ({ rand }) => makeBrain(rand, 0.85), ...extra });
  const opts = { trackId: TRACK_DEFS[0].id, laps: 2, seed: 77, weather: { seed: 1, changes: [{ at: 0, sky: "sun" as const }], fakes: [], startWet: 0 } };

  it("準備がなければ今までと同じ結果 (team を付けても、同時にピットに入らなければ同じ)", () => {
    const a = simulateRace([spec("a"), spec("b"), spec("c")], opts);
    const b = simulateRace([spec("a", { pref: null }), spec("b"), spec("c")], opts);
    expect(b).toEqual(a);
  });

  it("準備があると最後のタイヤや結果が変わりうる。いつ計算しても同じ", () => {
    const pref = { tire: "S" as const, fuel: "race" as const, alloc: { S: 2 }, tireFor: "slick" as const };
    const one = simulateRace([spec("a", { pref }), spec("b"), spec("c")], opts);
    const two = simulateRace([spec("a", { pref }), spec("b"), spec("c")], opts);
    expect(two).toEqual(one);
    const a = one.results.find((r) => r.id === "a")!;
    expect(a.tire).toBe("S");
  });
});
