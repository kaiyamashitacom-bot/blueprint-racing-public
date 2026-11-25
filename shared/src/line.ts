// 走る線 (レーシングライン): 道幅を使って、曲がりをできるだけゆるくする線。
// コンピューターの運転 (bot.ts) と先導車 (racecontrol.ts) が使う。コースごとに 1 回だけ計算して覚えておく。
// 作り方: 粗い点 (16 m ごと) で「曲がりの大きさの 2 乗の合計」が小さくなるよう横のずれを少しずつ直し、
// 細かい点 (8 m・4 m) に移してさらに直す。決まった計算なので、画面とサーバーで同じ線になる。
import { normalAt, pointAt, type Track } from "./track.ts";

export interface RacingLine {
  /** 中心の線の点ごとの、走る線の横のずれ (m、+ 右) */
  d: Float64Array;
  /** 走る線の曲がり具合 (+ 右曲がり)。中心の線の点の番号で引く */
  curv: Float64Array;
}

/** 道の端から走る線までの余白 (m、仮) */
export const LINE_MARGIN = 2.2;

const LEVELS: ReadonlyArray<readonly [number, number]> = [
  [16, 500],
  [8, 250],
  [4, 100],
];

const cache = new WeakMap<Track, RacingLine>();

export function racingLine(track: Track): RacingLine {
  const hit = cache.get(track);
  if (hit) return hit;
  const lim = Math.max(0, track.def.halfWidth - LINE_MARGIN);
  let prev: { m: number; d: Float64Array } | null = null;
  let m = 0;
  let d = new Float64Array(0);
  for (const [spacing, iters] of LEVELS) {
    m = Math.max(8, Math.round(track.length / spacing));
    const sp = track.length / m;
    const cx = new Float64Array(m);
    const cy = new Float64Array(m);
    const nx = new Float64Array(m);
    const ny = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const p = pointAt(track, i * sp);
      cx[i] = p.x;
      cy[i] = p.y;
      const [a, b] = normalAt(track, p.index);
      nx[i] = a;
      ny[i] = b;
    }
    d = new Float64Array(m);
    if (prev) {
      for (let i = 0; i < m; i++) {
        const u = (i / m) * prev.m;
        const i0 = Math.floor(u) % prev.m;
        const w = u - Math.floor(u);
        d[i] = prev.d[i0] * (1 - w) + prev.d[(i0 + 1) % prev.m] * w;
      }
    }
    const wrap = (j: number) => ((j % m) + m) % m;
    const X = (j: number) => cx[wrap(j)] + nx[wrap(j)] * d[wrap(j)];
    const Y = (j: number) => cy[wrap(j)] + ny[wrap(j)] * d[wrap(j)];
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < m; i++) {
        // 前後 2 点ずつから見て、曲がりが一番小さくなる位置へ (横にだけ動かす)
        const tx = (4 * (X(i - 1) + X(i + 1)) - (X(i - 2) + X(i + 2))) / 6;
        const ty = (4 * (Y(i - 1) + Y(i + 1)) - (Y(i - 2) + Y(i + 2))) / 6;
        const want = (tx - cx[i]) * nx[i] + (ty - cy[i]) * ny[i];
        d[i] = Math.max(-lim, Math.min(lim, want));
      }
    }
    prev = { m, d };
  }
  // 中心の線の点 (約 1 m ごと) に移す
  const n = track.n;
  const D = new Float64Array(n);
  const sp = track.length / m;
  for (let i = 0; i < n; i++) {
    const u = (i * track.step) / sp;
    const i0 = Math.floor(u) % m;
    const w = u - Math.floor(u);
    D[i] = d[i0] * (1 - w) + d[(i0 + 1) % m] * w;
  }
  const K = lineCurvature(track, D);
  const line = { d: D, curv: K };
  cache.set(track, line);
  return line;
}

/** 中心の線の点ごとの横のずれ D (m) で決まる線の曲がり具合 (前後 6 点の弦の向きの変わり方) */
export function lineCurvature(track: Track, D: ArrayLike<number>): Float64Array {
  const n = track.n;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [a, b] = normalAt(track, i);
    X[i] = track.px[i] + a * D[i];
    Y[i] = track.py[i] + b * D[i];
  }
  const K = new Float64Array(n);
  const W = 6;
  for (let i = 0; i < n; i++) {
    const a = (i - W + n) % n;
    const b = (i + W) % n;
    const ax = X[i] - X[a];
    const ay = Y[i] - Y[a];
    const bx = X[b] - X[i];
    const by = Y[b] - Y[i];
    const len = Math.hypot(ax, ay) + Math.hypot(bx, by);
    K[i] = Math.atan2(ax * by - ay * bx, ax * bx + ay * by) / Math.max(1e-6, len / 2);
  }
  return K;
}

/** コースの距離 s の点の番号 */
export function trackIndex(track: Track, s: number): number {
  const L = track.length;
  return Math.floor((((s % L) + L) % L) / track.step) % track.n;
}
