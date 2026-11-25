import { describe, expect, it } from "vitest";
import { DT, SAMPLE_DESIGN, TRACK_DEFS, computeStats, createCar, getTrack, queryTrack, stepCar, wallDistance } from "../src/index.ts";

describe("壁", () => {
  for (const def of TRACK_DEFS) {
    it(`${def.name}: でたらめに曲がっても壁の外に出ない`, () => {
      const track = getTrack(def.id);
      const stats = computeStats(SAMPLE_DESIGN);
      let r = 3;
      const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
      let worst = 0;
      let where = "";
      for (let run = 0; run < 6; run++) {
        const car = createCar(track, stats, run);
        car.started = true;
        let steer = 0;
        for (let i = 0; i < 60 * 120; i++) {
          if (i % 40 === 0) steer = [-1, 0, 1][Math.floor(rand() * 3)];
          stepCar(car, { steer, throttle: 1, brake: 0 }, stats, track, DT);
          const q = queryTrack(track, car.x, car.y);
          const over = Math.abs(q.d) - (wallDistance(track, q.index) - stats.width / 2);
          if (over > worst) {
            worst = over;
            where = `run ${run} step ${i} idx ${q.index} d ${q.d.toFixed(2)} hint ${car.hint}`;
          }
        }
      }
      expect(worst, where).toBeLessThan(0.3);
    });
  }
});
