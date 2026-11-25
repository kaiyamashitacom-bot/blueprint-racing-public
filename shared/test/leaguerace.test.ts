// 画面なしのレース (リーグ戦の 2 時間ごと)。粗い刻み (1/20 秒) でも 1/60 秒と結果が大きく変わらないことを確かめる
// (DECISIONS 11/25「サーバーの重さの対策」)。どれも同じ seed なら同じ答えなので、数の幅は決まった値に対して余裕を見たもの
import { describe, expect, it } from "vitest";
import { BOT_DESIGNS, checkDryTireRule, isRealCircuitId, LEAGUE_RACE_DT, makeBrain, makeWeatherPlan, simulateRace, TRACK_DEFS, type HeadlessCarSpec } from "../src/index.ts";

const field = (n = 8): HeadlessCarSpec[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, design: BOT_DESIGNS[i % BOT_DESIGNS.length], brain: ({ rand }) => makeBrain(rand, 0.8 + 0.025 * i) }));

const dry = (seed: number) => makeWeatherPlan(seed, 400, { rain: 0 });
const pct = (a: number, b: number) => Math.abs(a / b - 1) * 100;

function corr(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db);
}

describe("画面なしのレース", () => {
  it("大会の決まり (tireKind tournament): 履いたタイヤの区間を返し、乾いた路面では 2 種類使うようにピットに入る", () => {
    const r = simulateRace(field(), { trackId: "aozu", laps: 4, seed: 3, weather: dry(3), tireKind: "tournament" });
    const done = r.results.filter((x) => x.finished);
    expect(done.length).toBeGreaterThan(4);
    for (const x of done) {
      expect(x.stints!.length, x.id).toBeGreaterThan(0);
      expect(checkDryTireRule(x.stints!).ok, `${x.id} ${JSON.stringify(x.stints)}`).toBe(true);
    }
    // リーグ戦 (なし) には区間を付けない
    expect(simulateRace(field(2), { trackId: "aozu", laps: 1, seed: 3 }).results[0].stints).toBeUndefined();
  });
  it("server の刻みは 1/20 秒", () => {
    expect(LEAGUE_RACE_DT).toBeCloseTo(1 / 20);
  });

  it("同じ seed・同じ車なら同じ結果。点・順位・一番速い周は部屋と同じ決まり", () => {
    const a = simulateRace(field(), { trackId: "aozu", laps: 2, seed: 9 });
    const b = simulateRace(field(), { trackId: "aozu", laps: 2, seed: 9 });
    expect(b).toEqual(a);
    expect(a.results.map((r) => r.pos)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a.results.filter((r) => r.fastest)).toHaveLength(1);
    const pts = a.results.map((r) => r.points - (r.fastest && r.points > 0 ? 1 : 0));
    expect(pts).toEqual([25, 18, 15, 12, 10, 8, 0, 0]);
    // 並び (grid) は渡した順
    expect([...a.results].sort((x, y) => x.grid - y.grid).map((r) => r.id)).toEqual(field().map((c) => c.id));
  });

  it("1 台だけ: 1/20 秒の 1 周と合計は 1/60 秒と 1.5% 以内 (どの車・どのコースも)", () => {
    for (const def of TRACK_DEFS) {
      BOT_DESIGNS.forEach((design, i) => {
        const run = (dt: number) =>
          simulateRace([{ id: "s", design, brain: ({ rand }) => makeBrain(rand, 0.95) }], { trackId: def.id, laps: 3, seed: 7, dt, weather: dry(5) }).results[0];
        const fine = run(1 / 60);
        const coarse = run(1 / 20);
        expect(fine.finished && coarse.finished, `${def.id} ${i}`).toBe(true);
        expect(pct(coarse.best!, fine.best!), `${def.id} ${i} best`).toBeLessThan(1.5);
        expect(pct(coarse.total, fine.total), `${def.id} ${i} total`).toBeLessThan(1.5);
      });
    }
  });

  it("8 台: 平均の時間・完走の数・何レースかの点の取り方が 1/60 秒と近い", () => {
    const pts = [new Array(8).fill(0), new Array(8).fill(0)];
    // 青図・つづら坂だけ (重い。実在のサーキットは 1 台の比べと realtracks.test.ts の部屋のレース)
    for (const def of TRACK_DEFS.filter((d) => !isRealCircuitId(d.id))) {
      for (const seed of [1, 2, 3, 4]) {
        const [fine, coarse] = [1 / 60, 1 / 20].map((dt) => simulateRace(field(), { trackId: def.id, laps: 5, seed, dt, weather: dry(seed) }));
        const fin = (r: typeof fine) => r.results.filter((x) => x.finished);
        const mean = (r: typeof fine) => fin(r).reduce((s, x) => s + x.total, 0) / fin(r).length;
        expect(Math.abs(fin(fine).length - fin(coarse).length), `${def.id} ${seed}`).toBeLessThanOrEqual(1);
        expect(pct(mean(coarse), mean(fine)), `${def.id} ${seed} mean`).toBeLessThan(2);
        const best = (r: typeof fine) => Math.min(...r.results.map((x) => x.best ?? Infinity));
        expect(pct(best(coarse), best(fine)), `${def.id} ${seed} best`).toBeLessThan(1.5);
        [fine, coarse].forEach((r, k) => r.results.forEach((x) => (pts[k][Number(x.id.slice(1))] += x.points)));
      }
    }
    // 1 レースの順位はぶつかりや抜き合いで入れかわるが、何レースか合わせた点の取り方 (強い車ほど多い) はそろう
    expect(corr(pts[0], pts[1])).toBeGreaterThan(0.8);
  });
});
