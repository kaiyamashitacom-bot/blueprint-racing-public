import { describe, expect, it } from "vitest";
import {
  REPLAY_KEEP_LAPS,
  REPLAY_MAX_SAMPLES,
  brakePoints,
  closeReplay,
  decimate,
  newReplay,
  recordSample,
  replayLaps,
  replayLength,
  replaySamples,
  speedRange,
  type ReplaySample,
} from "../src/index.ts";

const DT = 1 / 60;

/** まっすぐ x の向きに、速さ v で n 刻み走る (brake = 踏み込み) */
function drive(buf = newReplay(), opts: { t0?: number; x0?: number; v?: number | ((i: number) => number); n?: number; brake?: (i: number) => number; lap?: (i: number) => number } = {}) {
  let x = opts.x0 ?? 0;
  const n = opts.n ?? 600;
  for (let i = 0; i < n; i++) {
    const v = typeof opts.v === "function" ? opts.v(i) : (opts.v ?? 30);
    x += v * DT;
    recordSample(buf, (opts.t0 ?? 0) + i * DT, x, 5, v, opts.brake?.(i) ?? 0, opts.lap?.(i) ?? 0);
  }
  return buf;
}

describe("走った線の記録", () => {
  it("0.1 秒ごとに 1 つ残す", () => {
    const buf = drive(newReplay(), { n: 600 }); // 10 秒
    expect(replayLength(buf)).toBeGreaterThanOrEqual(99);
    expect(replayLength(buf)).toBeLessThanOrEqual(101);
    const s = replaySamples(buf);
    for (let i = 1; i < s.length; i++) expect(s[i].t - s[i - 1].t).toBeGreaterThan(0.08);
    expect(s[10].v).toBe(30);
    expect(s[10].y).toBe(5);
  });

  it("JSON にできる (数の列)", () => {
    const buf = drive(newReplay(), { n: 60 });
    expect(JSON.parse(JSON.stringify(buf.data))).toEqual(buf.data);
    expect(buf.data.every((v) => typeof v === "number")).toBe(true);
  });

  it("ブレーキを踏んだ所に印。間の刻みで踏んでも残す", () => {
    // 2 刻みだけ踏む (0.1 秒の記録の間)
    const buf = drive(newReplay(), { n: 120, brake: (i) => (i === 31 || i === 32 ? 1 : 0) });
    const s = replaySamples(buf);
    expect(s.filter((x) => x.brake).length).toBe(1);
  });

  it("踏んでいなくても強く減速したらブレーキとみる (かんたん操作の自動ブレーキ)", () => {
    const buf = drive(newReplay(), { n: 120, v: (i) => (i < 60 ? 40 : 40 - (i - 60) * 0.25) }); // 15 m/s²
    const s = replaySamples(buf);
    expect(s.slice(0, 9).some((x) => x.brake)).toBe(false);
    expect(s.slice(11).every((x) => x.brake)).toBe(true);
  });

  it("ゆるい減速 (アクセルを離しただけ) はブレーキにしない", () => {
    const buf = drive(newReplay(), { n: 120, v: (i) => 40 - i * 0.03 }); // 1.8 m/s²
    expect(replaySamples(buf).some((x) => x.brake)).toBe(false);
  });

  it("今の周と、その前の数周だけ残す。周の時間もわかる", () => {
    const buf = newReplay();
    const lapLen = 300; // 10 秒で 1 周
    for (let i = 0; i < 600 * 6; i++) recordSample(buf, i * DT, i * 0.5, 0, 30, 0, Math.floor(i / lapLen));
    const laps = replayLaps(buf);
    expect(laps.map((l) => l.lap)).toEqual([8, 9, 10, 11].slice(-(REPLAY_KEEP_LAPS + 1)));
    // 走り終えた周は時間がある (5 秒)、走っている途中の周は null
    for (const l of laps.slice(0, -1)) expect(l.time).toBeCloseTo(5, 5);
    expect(laps[laps.length - 1].time).toBeNull();
    expect(replaySamples(buf, 10).every((s) => s.lap === 10)).toBe(true);
    expect(replaySamples(buf, 3)).toEqual([]);
  });

  it("ゴールしたら最後の周の時間も出る", () => {
    const buf = newReplay();
    for (let i = 0; i < 1200; i++) recordSample(buf, i * DT, i * 0.5, 0, 30, 0, i < 300 ? 0 : i < 600 ? 1 : 2);
    expect(replayLaps(buf).at(-1)!.time).toBeNull();
    closeReplay(buf);
    expect(replayLaps(buf).at(-1)!.time).toBeCloseTo(1199 * DT - 10, 5);
    closeReplay(buf);
    expect(replayLaps(buf).at(-1)!.time).toBeCloseTo(1199 * DT - 10, 5);
  });

  it("周が終わらなくても、数の上限で古いものを捨てる", () => {
    const buf = newReplay();
    for (let i = 0; i < REPLAY_MAX_SAMPLES * 7; i++) recordSample(buf, i * DT, i, 0, 10, 0, 0);
    expect(replayLength(buf)).toBe(REPLAY_MAX_SAMPLES);
  });

  it("おかしな数は残さない", () => {
    const buf = newReplay();
    expect(recordSample(buf, Number.NaN, 0, 0, 1, 0, 0)).toBe(false);
    expect(recordSample(buf, 0, Number.POSITIVE_INFINITY, 0, 1, 0, 0)).toBe(false);
    expect(recordSample(buf, 0, 0, 0, Number.NaN, 0, 0)).toBe(true);
    expect(replaySamples(buf)[0].v).toBe(0);
  });
});

describe("描くための間引きと印", () => {
  const line = (n: number, brakeAt: (i: number) => boolean = () => false): ReplaySample[] =>
    Array.from({ length: n }, (_, i) => ({ t: i * 0.1, x: i * 0.5, y: 0, v: 20 + (i % 7), brake: brakeAt(i), lap: 0 }));

  it("間引き: 離れた点だけ残し、最初と最後とブレーキの変わり目は残す", () => {
    const s = line(200, (i) => i >= 50 && i < 60);
    const d = decimate(s, 3);
    expect(d.length).toBeLessThan(s.length / 3);
    expect(d[0]).toBe(s[0]);
    expect(d[d.length - 1]).toBe(s[s.length - 1]);
    expect(d).toContain(s[50]);
    expect(d).toContain(s[60]);
    expect(decimate(s.slice(0, 2), 3)).toEqual(s.slice(0, 2));
  });

  it("ブレーキの始まり: 1 回踏むごとに 1 つ。短い途切れはつなぐ。向きと長さ", () => {
    const s = line(200, (i) => (i >= 20 && i < 30) || i === 31 || (i >= 100 && i < 110));
    const b = brakePoints(s);
    expect(b.length).toBe(2);
    expect(b[0].x).toBe(s[20].x);
    expect(b[0].dir).toBeCloseTo(0, 5);
    expect(b[0].len).toBeGreaterThan(4);
    expect(b[1].x).toBe(s[100].x);
    expect(brakePoints(line(50))).toEqual([]);
  });

  it("速さの幅", () => {
    const r = speedRange(line(100));
    expect(r.min).toBeGreaterThanOrEqual(20);
    expect(r.max).toBeLessThanOrEqual(26);
    expect(r.max).toBeGreaterThan(r.min);
    expect(speedRange([])).toEqual({ min: 0, max: 1 });
  });
});
