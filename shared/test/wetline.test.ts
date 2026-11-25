// 雨のあと、みんなが走る線から先に乾く (weather.ts の lineWetnessAt・wetnessAtLateral と physics.ts)
import { describe, expect, it } from "vitest";
import {
  DT, LINE_DRY_BAND, LINE_DRY_CORE, SAMPLE_DESIGN, botInput, computeStats, createCar, getTrack, lineWetnessAt, makeBrain, newLapState, stepCar,
  updateLaps, wetnessAt, wetnessAtLateral, type WeatherPlan,
} from "../src/index.ts";

const RAIN_THEN_SUN: WeatherPlan = { seed: 1, changes: [{ at: 0, sky: "heavy" }, { at: 60, sky: "sun" }], fakes: [], startWet: 0.95 };

describe("走る線から先に乾く", () => {
  it("降っている間は同じ。やんだら線の上が速く乾き、どちらも最後は乾く", () => {
    for (const t of [0, 30, 59]) expect(lineWetnessAt(RAIN_THEN_SUN, t)).toBeCloseTo(wetnessAt(RAIN_THEN_SUN, t), 9);
    for (const t of [80, 120, 150]) expect(lineWetnessAt(RAIN_THEN_SUN, t)).toBeLessThan(wetnessAt(RAIN_THEN_SUN, t) - 0.04);
    expect(lineWetnessAt(RAIN_THEN_SUN, 1000)).toBe(0);
    expect(wetnessAt(RAIN_THEN_SUN, 1000)).toBe(0);
    // 同じ入力なら同じ
    expect(lineWetnessAt(RAIN_THEN_SUN, 123.4)).toBe(lineWetnessAt(RAIN_THEN_SUN, 123.4));
    // また降り出すと線の上も濡れていく
    const again: WeatherPlan = { ...RAIN_THEN_SUN, changes: [...RAIN_THEN_SUN.changes, { at: 120, sky: "heavy" }] };
    expect(lineWetnessAt(again, 200)).toBeGreaterThan(lineWetnessAt(RAIN_THEN_SUN, 200));
  });

  it("線から横に離れるほど まわりの濡れ具合に戻る", () => {
    expect(wetnessAtLateral(0.6, 0.2, 0)).toBe(0.2);
    expect(wetnessAtLateral(0.6, 0.2, -LINE_DRY_CORE)).toBe(0.2);
    const mid = wetnessAtLateral(0.6, 0.2, LINE_DRY_CORE + LINE_DRY_BAND / 2);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.6);
    expect(wetnessAtLateral(0.6, 0.2, LINE_DRY_CORE + LINE_DRY_BAND + 1)).toBe(0.6);
    // 線の方が濡れていることはない (降り始めは同じ)
    expect(wetnessAtLateral(0.3, 0.5, 0)).toBe(0.3);
  });

  it("乾きかけの道では、線を走る車は 線の上の乾いた分だけ速い", () => {
    const lap = (lineWetness?: number) => {
      const track = getTrack("aozu");
      const stats = computeStats(SAMPLE_DESIGN);
      const car = createCar(track, stats, 0, { tire: "M" });
      car.started = true;
      const brain = makeBrain(() => 0.5, 0.95);
      const st = newLapState();
      let t = 0;
      while (t < 200 && st.lapsDone < 1) {
        const ev = stepCar(car, botInput(car, stats, track, brain, t, [], 0.45), stats, track, DT, { wetness: 0.45, ...(lineWetness !== undefined ? { lineWetness } : {}) });
        t += DT;
        updateLaps(car, st, ev, t, track.length, 5, false);
      }
      return t;
    };
    const wetAll = lap();
    const dryLine = lap(0.1);
    expect(dryLine).toBeLessThan(wetAll - 0.3);
    // 線の上も同じ濡れ具合なら今までと同じ
    expect(lap(0.45)).toBe(wetAll);
  });
});
