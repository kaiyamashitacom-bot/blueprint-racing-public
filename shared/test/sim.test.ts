import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS, DT, SAMPLE_DESIGN, STARTER_BOX, TRACK_DEFS, botInput, computeStats, countParts, createCar, getTrack,
  makeBrain, newLapState, stepCar, updateLaps, validateDesign, wallDistance,
} from "../src/index.ts";

describe("設計図", () => {
  it("見本と全部のコンピューターの車は正しい", () => {
    for (const d of BOT_DESIGNS) expect(validateDesign(d), d.name).toEqual([]);
  });
  it("見本ははじめの部品の箱だけでできる", () => {
    const n = countParts(SAMPLE_DESIGN);
    for (const [id, k] of Object.entries(n)) expect(k, id).toBeLessThanOrEqual(STARTER_BOX[id] ?? 0);
  });
  it("まちがいを見つける", () => {
    expect(validateDesign({ name: "x", parts: [] })).toContain("運転席を 1 つ置いてください");
    const lonely = { name: "x", parts: [...SAMPLE_DESIGN.parts, { id: "frame", c: 6, r: 10, rot: 0 as const }] };
    expect(validateDesign(lonely)).toContain("運転席とつながっていない部品があります");
    const over = { name: "x", parts: [...SAMPLE_DESIGN.parts, { id: "frame", c: 3, r: 1, rot: 0 as const }] };
    expect(validateDesign(over)).toContain("重なった部品があります");
  });
  it("性能の数がそれらしい", () => {
    const s = computeStats(SAMPLE_DESIGN);
    expect(s.mass).toBeGreaterThan(300);
    expect(s.power).toBeGreaterThan(50);
    expect(s.topSpeed).toBeGreaterThan(35);
    expect(s.topSpeed).toBeLessThan(90);
  });
});

describe("コース", () => {
  for (const def of TRACK_DEFS) {
    it(`${def.name}: 離れた区間どうしが近すぎない (壁を越えて近道できない)`, () => {
      const t = getTrack(def.id);
      const need = 2 * (def.halfWidth + def.runoff + 0.6) + 2;
      let worst = Infinity;
      for (let i = 0; i < t.n; i += 2) {
        for (let j = i + 2; j < t.n; j += 2) {
          const gap = Math.min(j - i, t.n - (j - i)) * t.step;
          if (gap < need * 2.2) continue;
          const d = Math.hypot(t.px[i] - t.px[j], t.py[i] - t.py[j]);
          worst = Math.min(worst, d);
        }
      }
      expect(worst).toBeGreaterThan(need);
      expect(wallDistance(t, 0)).toBeGreaterThan(def.halfWidth);
    });
    it(`${def.name}: 曲がりの内側で壁の線が折れない (半径 > 壁までの距離)`, () => {
      const t = getTrack(def.id);
      let worst = Infinity;
      let at = -1;
      for (let i = 0; i < t.n; i++) {
        const margin = 1 / Math.max(1e-6, Math.abs(t.curv[i])) - wallDistance(t, i);
        if (margin < worst) {
          worst = margin;
          at = i;
        }
      }
      expect(worst, `点 ${at}/${t.n} 半径 ${(1 / Math.abs(t.curv[at])).toFixed(1)} m`).toBeGreaterThan(2);
    });
  }
});

function runBot(trackId: string, design = SAMPLE_DESIGN, laps = 2, skill = 0.95, digital = false) {
  const track = getTrack(trackId);
  const stats = computeStats(design);
  const car = createCar(track, stats, 0);
  car.started = true;
  let r = 1;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const brain = makeBrain(rand, skill);
  const st = newLapState();
  let t = 0;
  let walls = 0;
  while (t < 600 && !st.finished && !st.retired) {
    const inp = botInput(car, stats, track, brain, t);
    // 人の操作と同じく 左・まっすぐ・右 だけ
    if (digital) {
      inp.steer = Math.abs(inp.steer) < 0.3 ? 0 : Math.sign(inp.steer);
      inp.throttle = inp.throttle > 0.5 ? 1 : 0;
      inp.brake = inp.brake > 0.2 ? 1 : 0;
    }
    const ev = stepCar(car, inp, stats, track, DT);
    t += DT;
    if (ev.wall > 3) walls++;
    updateLaps(car, st, ev, t, track.length, laps, false);
  }
  return { st, t, walls, len: track.length };
}

describe("走り", () => {
  for (const def of TRACK_DEFS) {
    it(`${def.name}: コンピューターが 2 周走り切る`, () => {
      const { st, len } = runBot(def.id);
      expect(st.finished).toBe(true);
      expect(st.bestLap!).toBeLessThan(len / 12);
    });
  }
  for (const def of TRACK_DEFS) {
    it(`${def.name}: ボタン (左右・アクセル・ブレーキ の入り切り) だけでも走り切れる`, () => {
      const { st, len } = runBot(def.id, SAMPLE_DESIGN, 2, 0.95, true);
      expect(st.finished).toBe(true);
      expect(st.bestLap!).toBeLessThan(len / 10);
    });
  }
  it("同じ入力なら同じ結果 (決まった計算)", () => {
    const a = runBot("aozu", SAMPLE_DESIGN, 1);
    const b = runBot("aozu", SAMPLE_DESIGN, 1);
    expect(a.st.finishTime).toBe(b.st.finishTime);
  });
});
