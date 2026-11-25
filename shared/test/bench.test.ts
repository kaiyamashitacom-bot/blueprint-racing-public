// 試走台 (車づくりの画面で 部品を置くたびに出す見積もり)
import { describe, expect, it } from "vitest";
import {
  BENCH_RADIUS, BENCH_TRACE_STEP, BOT_DESIGNS, NO_TIRE_MODS, SAMPLE_DESIGN, TRACK_DEFS, benchLap, computeStats, cornerSpeed, getTrack, traitMods,
  type CarDesign,
} from "../src/index.ts";

const swap = (from: string, to: string): CarDesign => ({ name: "x", parts: SAMPLE_DESIGN.parts.map((p) => (p.id === from ? { ...p, id: to } : p)) });

describe("試走台", () => {
  it("曲がりの速さ: 羽根・握り・曲がりに強いタイヤで上がる", () => {
    const st = computeStats(SAMPLE_DESIGN);
    const v = cornerSpeed(st);
    // 半径 30 m を 50〜110 km/h くらい
    expect(v * 3.6).toBeGreaterThan(50);
    expect(v * 3.6).toBeLessThan(110);
    expect(cornerSpeed({ ...st, downK: st.downK * 2 })).toBeGreaterThan(v);
    expect(cornerSpeed({ ...st, tireMods: traitMods("corner", 5) })).toBeGreaterThan(cornerSpeed({ ...st, tireMods: { ...NO_TIRE_MODS } }));
    expect(cornerSpeed({ ...st, tireMods: traitMods("brake", 3) })).toBeLessThan(cornerSpeed({ ...st, tireMods: { ...NO_TIRE_MODS } }));
    expect(cornerSpeed(computeStats(swap("tire_w1", "tire_w5")))).toBeGreaterThan(v);
    expect(cornerSpeed(st, BENCH_RADIUS * 2)).toBeGreaterThan(v);
  });

  for (const def of TRACK_DEFS) {
    it(`${def.name}: 1 周のタイムと燃料が出て、毎回同じ。速い車ほど速い`, () => {
      const track = getTrack(def.id);
      const st = computeStats(SAMPLE_DESIGN);
      const a = benchLap(st, track);
      const b = benchLap(st, track);
      expect(a).toEqual(b);
      expect(a.lap).not.toBeNull();
      expect(a.fuel!).toBeGreaterThan(0);
      // 全開で 1 周走るより少ない
      expect(a.fuel!).toBeLessThan(st.fuelRate * a.lap!);
      expect(a.trace.length).toBe(Math.ceil(track.length / BENCH_TRACE_STEP));
      expect(Math.max(...a.trace)).toBeCloseTo(a.vmax, 0);
      const fast = benchLap(computeStats(swap("eng_m1", "eng_p3")), track);
      expect(fast.lap!).toBeLessThan(a.lap!);
      const grippy = benchLap(computeStats(swap("tire_w1", "tire_w5")), track);
      expect(grippy.lap!).toBeLessThan(a.lap!);
    });
  }

  it("コンピューターの車 4 台とも走り切り、1 台 1 コース 50 ms ほど (この機械で)", () => {
    for (const def of TRACK_DEFS) {
      const track = getTrack(def.id);
      for (const d of BOT_DESIGNS) {
        const t0 = Date.now();
        const r = benchLap(computeStats(d), track);
        const ms = Date.now() - t0;
        expect(r.lap, d.name).not.toBeNull();
        // 遅い機械 (試験の箱) でも通るように ゆるく
        expect(ms).toBeLessThan(250);
      }
    }
  });

  it("走れない車 (力が 0) は すぐ null", () => {
    const st = computeStats(SAMPLE_DESIGN);
    expect(benchLap({ ...st, power: 0 }, getTrack("aozu")).lap).toBeNull();
  });
});
