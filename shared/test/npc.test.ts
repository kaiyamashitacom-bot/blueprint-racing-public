// コンピューター (NPC) の強さ (11/25 ユーザー「もっと強く」)。
// 前の版の 1 周 (上手さ 0.9、2〜3 周目の一番速い周): 青図 見本 36.35・小型 38.68・身軽 38.38・細足 37.43 (平均 37.71)
//                                                 つづら 見本 56.95・小型 60.68・身軽 59.63・細足 59.20 (平均 59.12)
import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS, BOT_SKILL_MAX, BOT_SKILL_MIN, DT, LINE_MARGIN, SAMPLE_DESIGN, TRACK_DEFS, botInput, computeStats, createCar, getTrack,
  lineCurvature, makeBrain, newLapState, racingLine, rampSteer, stepCar, updateLaps, type CarDesign, type TireCompound,
} from "../src/index.ts";

interface RunOpts {
  design?: CarDesign;
  skill?: number;
  laps?: number;
  /**
   * 人の操作と同じく 左・まっすぐ・右 とペダルの入り切りだけ。ハンドルは画面と同じく rampSteer を通る。
   * 上手な人は 押す長さで切れ具合を加減する (押す・離すを、切りたい量と実際の切れの差がたまるたびに切りかえる)。
   * 11/25 速いときの切れ角の制限 (STEER_LIMIT) を入れた: 前の「0.3 より大きければ いっぱい」の人は 速いときに大きく切って直すしかなく、
   * 青図の直線で芝に出るようになったので、押す長さで加減する人に替えた
   */
  digital?: boolean;
  wet?: number;
  tire?: TireCompound;
  seed?: number;
}

function lap(trackId: string, o: RunOpts = {}) {
  const track = getTrack(trackId);
  const stats = computeStats(o.design ?? SAMPLE_DESIGN);
  const car = createCar(track, stats, 0, { tire: o.tire });
  car.started = true;
  let r = o.seed ?? 3;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const brain = makeBrain(rand, o.skill ?? 0.9);
  const st = newLapState();
  let t = 0;
  let walls = 0;
  let grass = 0;
  let held = 0;
  let owe = 0;
  while (t < 900 && !st.finished && !st.retired) {
    const inp = botInput(car, stats, track, brain, t, [], o.wet ?? 0);
    if (o.digital) {
      const u = owe + inp.steer;
      held = rampSteer(held, u > 0.5 ? 1 : u < -0.5 ? -1 : 0, DT);
      owe = u - held;
      inp.steer = held;
      inp.throttle = inp.throttle > 0.5 ? 1 : 0;
      inp.brake = inp.brake > 0.2 ? 1 : 0;
    }
    const ev = stepCar(car, inp, stats, track, DT, { wetness: o.wet ?? 0 });
    t += DT;
    if (ev.wall > 3) walls++;
    if (car.surface === "grass") grass += DT;
    updateLaps(car, st, ev, t, track.length, o.laps ?? 3, false);
  }
  return { best: st.bestLap ?? Infinity, finished: st.finished, walls, grass };
}

describe("走る線", () => {
  for (const def of TRACK_DEFS) {
    it(`${def.name}: 道の中に収まり、全体として中心の線よりゆるく曲がる`, () => {
      const t = getTrack(def.id);
      const line = racingLine(t);
      let maxD = 0;
      let maxK = 0;
      let maxC = 0;
      let sumK = 0;
      let sumC = 0;
      const center = lineCurvature(t, new Float64Array(t.n));
      for (let i = 0; i < t.n; i++) {
        maxD = Math.max(maxD, Math.abs(line.d[i]));
        maxK = Math.max(maxK, Math.abs(line.curv[i]));
        maxC = Math.max(maxC, Math.abs(center[i]));
        sumK += line.curv[i] ** 2;
        sumC += center[i] ** 2;
      }
      expect(maxD).toBeLessThanOrEqual(def.halfWidth - LINE_MARGIN + 1e-9);
      expect(maxD).toBeGreaterThan(2);
      expect(sumK).toBeLessThan(sumC * 0.95);
      expect(maxK).toBeLessThan(maxC * 1.3);
      expect(racingLine(t)).toBe(line);
    });
  }
});

describe("コンピューターの強さ", () => {
  const before: Record<string, number> = { aozu: 37.71, tsuzura: 59.12 };
  for (const def of TRACK_DEFS) {
    // 前の版の値があるコース (青図・つづら坂) だけ。実在のサーキットは realtracks.test.ts
    it.skipIf(!(def.id in before))(`${def.name}: 前の版よりはっきり速い (上手さ 0.9、4 台の平均)`, () => {
      const bests = BOT_DESIGNS.map((d) => lap(def.id, { design: d, skill: 0.9 }).best);
      const mean = bests.reduce((a, b) => a + b, 0) / bests.length;
      expect(mean).toBeLessThan(before[def.id] * 0.97);
    });
    it(`${def.name}: 一番上手いコンピューターは、上手な人 (走る線をボタンだけで走る) と同じくらい`, () => {
      const human = lap(def.id, { skill: 1, digital: true });
      expect(human.finished).toBe(true);
      const top = lap(def.id, { skill: BOT_SKILL_MAX }).best;
      const low = lap(def.id, { skill: BOT_SKILL_MIN }).best;
      expect(top).toBeLessThan(human.best * 1.02);
      expect(top).toBeGreaterThan(human.best * 0.94);
      // 上手さで差が出る
      expect(low - top).toBeGreaterThan(0.6);
      expect(low).toBeLessThan(human.best * 1.08);
    });
    it(`${def.name}: どの車・上手さでも 壁に当たらず走り切る`, () => {
      for (const d of BOT_DESIGNS) {
        for (const skill of [BOT_SKILL_MIN, 0.9, BOT_SKILL_MAX]) {
          const res = lap(def.id, { design: d, skill, laps: 2, seed: 7 });
          expect(res.finished, `${d.name} ${skill}`).toBe(true);
          expect(res.walls, `${d.name} ${skill}`).toBe(0);
          expect(res.grass, `${d.name} ${skill}`).toBeLessThan(1);
        }
      }
    });
    it(`${def.name}: 濡れた路面 (雨用タイヤ) でも走り切る`, () => {
      for (const [wet, tire] of [[0.5, "I"], [0.95, "W"]] as const) {
        const res = lap(def.id, { skill: 0.9, laps: 2, wet, tire });
        expect(res.finished, `${wet}`).toBe(true);
        expect(res.walls, `${wet}`).toBe(0);
      }
    });
  }
  it("makeBrain の上手さは BOT_SKILL_MIN 〜 BOT_SKILL_MAX", () => {
    let r = 9;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 50; i++) {
      const b = makeBrain(rand);
      expect(b.skill).toBeGreaterThanOrEqual(BOT_SKILL_MIN);
      expect(b.skill).toBeLessThanOrEqual(BOT_SKILL_MAX);
    }
  });
});
