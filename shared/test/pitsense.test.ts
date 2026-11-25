// 雇った運転手の「ピットの判断」(pitSense) がコンピューターのピットの決め方に効く (11/25)。運転手のいない車は今のまま
import { describe, expect, it } from "vitest";
import { SAMPLE_DESIGN, computeStats, createCar, driverBrain, getTrack, makeBrain, pitSenseParams, updateBotPit, type BotBrain } from "../src/index.ts";

const track = getTrack("aozu");
const stats = computeStats(SAMPLE_DESIGN);

function decide(pitSense: number | undefined, o: { wear?: number; dist?: number; wetNow: number; wetSoon: number }) {
  const car = createCar(track, stats, 0, { tire: "M", fuel: stats.fuelCap });
  car.dist = o.dist ?? 50;
  car.wear = o.wear ?? 0;
  const b: BotBrain = { ...makeBrain(() => 0.5, 0.9), pitSense };
  updateBotPit(car, stats, track, b, { totalLaps: 8, wetNow: o.wetNow, wetSoon: o.wetSoon });
  return car.pitOrder?.tire ?? null;
}

describe("ピットの判断 (pitSense)", () => {
  it("運転手のいない車 (pitSense なし) は前と同じ数", () => {
    expect(pitSenseParams(undefined)).toEqual({ look: 1, swapMargin: 1.07, wearLimit: 0.88 });
    expect(makeBrain(() => 0.5).pitSense).toBeUndefined();
  });

  it("雇った運転手の頭には能力の pitSense が入る", () => {
    const b = driverBrain({ speed: 50, stability: 50, tyreFuel: 50, pitSense: 80 }, () => 0.5);
    expect(b.pitSense).toBeCloseTo(0.8);
  });

  it("判断が良いほど 雨の降り始めに早く雨用へ替える (悪いと遅れる)", () => {
    const w = { wetNow: 0.05, wetSoon: 0.4 };
    expect(decide(undefined, w)).toBe("I");
    expect(decide(1, w)).toBe("I");
    expect(decide(0, w)).toBeNull();
    // 判断が悪くても、本当に濡れたら替える
    expect(decide(0, { wetNow: 0.5, wetSoon: 0.5 })).toBe("I");
  });

  it("判断が悪いと すり減ったタイヤで走りすぎる", () => {
    const at = { dist: track.length * 2 + 50, wetNow: 0, wetSoon: 0 };
    expect(decide(1, { ...at, wear: 0.5 })).toBe("H");
    expect(decide(undefined, { ...at, wear: 0.5 })).toBe("H");
    expect(decide(0, { ...at, wear: 0.5 })).toBeNull();
    expect(decide(0, { ...at, wear: 0.6 })).toBe("H");
  });
});
