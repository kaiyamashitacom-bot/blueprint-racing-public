// コース: 中心の線 (輪) と道幅。コースの外は「芝・砂利 (遅くなる)」か「すぐ壁」
// 座標は m。x は右、y は下 (画面と同じ)。
import type { DrsZoneDef } from "./drs.ts";

export type RunoffKind = "grass" | "wall";
/** 道の路面 (今はアスファルトだけ。砂利の道・濡れやすい所などはあとで。仮) */
export type RoadSurface = "asphalt";
export const ROAD_SURFACES: readonly RoadSurface[] = ["asphalt"];

export interface TrackDef {
  id: string;
  name: string;
  /** 中心の線を通る点 (輪。最後から最初へ戻る)。最初の 2 点の間にスタートの線がある */
  points: Array<[number, number]>;
  /** 道幅の半分 (m) */
  halfWidth: number;
  /** 芝・砂利の幅 (m)。この外が壁 */
  runoff: number;
  /** すぐ壁にする区間 (コースの長さに対する割合 0..1) */
  walls?: Array<[number, number]>;
  /** ピットの道 (スタートの直線の横の、芝・砂利の中)。書かなければ決まった形 */
  pit?: PitDef;
  /** DRS の区間 (道のり m)。書かなければ長い直線から決める (drs.ts の drsZones) */
  drs?: DrsZoneDef[];
  /** 道の路面 (書かなければアスファルト) */
  surface?: RoadSurface;
  /** 曲がりの内側の縁石 (書かなければあり。false でなし) */
  kerbs?: boolean;
  /** セクター (区間タイム) の切れ目: 1 周の割合 2 つ (S1 | S2 | S3)。書かなければ 3 等分 (sectors.ts)。旗の区間とは別 */
  sectors?: number[];
}

export interface PitDef {
  /** 道のどちら側か (1 = 右、-1 = 左)。書かなければ輪の内側 */
  side?: 1 | -1;
  /** 入り口: スタートの線の何 m 手前か (マイナス) */
  entry?: number;
  /** 止まる場所: 線からの距離 (m) */
  box?: number;
  /** 出口: 線の何 m 先か */
  exit?: number;
}

/** ピットの道 (コースの距離 u は、スタートの線を 0 として手前がマイナス) */
export interface PitLane {
  side: 1 | -1;
  entry: number;
  box: number;
  exit: number;
  /** ピットの道の中心の横のずれ (m、side の向き込み) */
  laneD: number;
  /** 出口で合流する横のずれ */
  outD: number;
  /** 入り口から道に移るまでと、道から合流するまでの長さ (m) */
  inLen: number;
  outLen: number;
}

export interface Track {
  def: TrackDef;
  /** 1 周の長さ (m) */
  length: number;
  /** 中心の線を約 1 m ごとに区切った点 */
  n: number;
  px: Float64Array;
  py: Float64Array;
  /** 進む向き */
  tx: Float64Array;
  ty: Float64Array;
  /** 曲がり具合 (+ 右曲がり) */
  curv: Float64Array;
  /** その点の芝・砂利の幅 (0 ならすぐ壁) */
  runoff: Float64Array;
  /** 縁石: 1 = 右側、-1 = 左側、0 = なし */
  kerb: Int8Array;
  step: number;
  /** ピットの道 */
  pit: PitLane;
}

/** 曲がりの大きさがこれより大きいと内側に縁石 */
const KERB_CURV = 1 / 55;
export const KERB_WIDTH = 1.4;

export function buildTrack(def: TrackDef): Track {
  // 1) 中心の線を細かく (Catmull-Rom で輪にする)
  const pts = def.points;
  const m = pts.length;
  const dense: Array<[number, number]> = [];
  const SUB = 60;
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i - 1 + m) % m];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % m];
    const p3 = pts[(i + 2) % m];
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  // 2) 長さをはかって約 1 m ごとに並べ直す
  const cum: number[] = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[dense.length];
  const n = Math.round(length);
  const step = length / n;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    while (cum[j + 1] < s) j++;
    const a = dense[j];
    const b = dense[(j + 1) % dense.length];
    const u = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
    px[i] = a[0] + (b[0] - a[0]) * u;
    py[i] = a[1] + (b[1] - a[1]) * u;
  }
  // 3) 向き・曲がり具合
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const dx = px[b] - px[a];
    const dy = py[b] - py[a];
    const l = Math.hypot(dx, dy) || 1;
    tx[i] = dx / l;
    ty[i] = dy / l;
  }
  const curv = new Float64Array(n);
  const W = 6; // 前後 6 点で曲がりをはかる
  for (let i = 0; i < n; i++) {
    const a = (i - W + n) % n;
    const b = (i + W) % n;
    const cross = tx[a] * ty[b] - ty[a] * tx[b];
    const dot = tx[a] * tx[b] + ty[a] * ty[b];
    curv[i] = Math.atan2(cross, dot) / (2 * W * step);
  }
  // 4) 壁の区間と縁石
  const runoff = new Float64Array(n).fill(def.runoff);
  for (const [from, to] of def.walls ?? []) {
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const inside = from <= to ? f >= from && f <= to : f >= from || f <= to;
      if (inside) runoff[i] = 0;
    }
  }
  const kerb = new Int8Array(n);
  for (let i = 0; i < n && def.kerbs !== false; i++) {
    // 右曲がり (curv > 0) なら右側が内側
    if (Math.abs(curv[i]) > KERB_CURV) kerb[i] = curv[i] > 0 ? 1 : -1;
  }
  // 5) ピットの道: 輪の内側 (曲がりの合計の向き) の芝・砂利の真ん中あたり
  let turn = 0;
  for (let i = 0; i < n; i++) turn += curv[i] * step;
  const pd = def.pit ?? {};
  const side: 1 | -1 = pd.side ?? (turn >= 0 ? 1 : -1);
  const hw = def.halfWidth;
  const entry = pd.entry ?? -100;
  const exit = pd.exit ?? 110;
  // ピットの道の区間で一番せまい芝・砂利の幅。せまければ道の端を通る (壁の内側 2 m 以上)
  let minRun = Infinity;
  for (let u = entry; u <= exit; u += step) minRun = Math.min(minRun, runoff[Math.floor((((u % length) + length) % length) / step) % n]);
  const pit: PitLane = {
    side,
    entry,
    box: pd.box ?? 15,
    exit,
    laneD: side * Math.min(hw + minRun * 0.5, hw + minRun + 0.6 - 2),
    outD: side * (hw - 2.5),
    inLen: 40,
    outLen: 45,
  };
  return { def, length, n, px, py, tx, ty, curv, runoff, kerb, step, pit };
}

/** 右向きの法線 (進む向きを 90 度右へ) */
export function normalAt(track: Track, i: number): [number, number] {
  return [-track.ty[i], track.tx[i]];
}

export interface TrackQuery {
  /** 一番近い中心の点の番号 */
  index: number;
  /** コースの始まりからの距離 (0..length) */
  s: number;
  /** 中心の線からの横のずれ (+ 右) */
  d: number;
}

/** 位置から、コースのどこにいるかを調べる。hint は前回の index (近くだけ探す) */
export function queryTrack(track: Track, x: number, y: number, hint = -1): TrackQuery {
  const n = track.n;
  let best = -1;
  let bestD2 = Infinity;
  const scan = (from: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const i = (((from + k) % n) + n) % n;
      const dx = x - track.px[i];
      const dy = y - track.py[i];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
  };
  if (hint >= 0) scan(hint - 40, 81);
  const maxSide = track.def.halfWidth + track.def.runoff + 4;
  if (best < 0 || bestD2 > maxSide * maxSide) {
    bestD2 = Infinity;
    scan(0, n);
  }
  const i = best;
  // 線分に投影して少し正確に
  const dx = x - track.px[i];
  const dy = y - track.py[i];
  const along = dx * track.tx[i] + dy * track.ty[i];
  const [nx, ny] = normalAt(track, i);
  const d = dx * nx + dy * ny;
  let s = i * track.step + along;
  s = ((s % track.length) + track.length) % track.length;
  return { index: i, s, d };
}

/** コースの距離 s の位置 (+ 横のずれ d) */
export function pointAt(track: Track, s: number, d = 0): { x: number; y: number; heading: number; index: number } {
  const L = track.length;
  const ss = ((s % L) + L) % L;
  const f = ss / track.step;
  const i = Math.floor(f) % track.n;
  const k = (i + 1) % track.n;
  const u = f - Math.floor(f);
  const x = track.px[i] + (track.px[k] - track.px[i]) * u;
  const y = track.py[i] + (track.py[k] - track.py[i]) * u;
  const [nx, ny] = normalAt(track, i);
  return { x: x + nx * d, y: y + ny * d, heading: Math.atan2(track.ty[i], track.tx[i]), index: i };
}

export interface Surface {
  /** 握りの倍率 */
  grip: number;
  /** 転がりの抵抗 (m/s²) */
  roll: number;
  /** 速さに比べて増える抵抗 (m/s² を 1 m/s ごとに)。なし = 0 */
  rollV?: number;
  kind: "asphalt" | "kerb" | "grass";
}

const ASPHALT: Surface = { grip: 1, roll: 0.25, kind: "asphalt" };
const KERB: Surface = { grip: 0.9, roll: 0.9, kind: "kerb" };
// 芝 (11/25 試走「濡れた芝で動けない・速いときはゆるい」): 抵抗を速さに比べて増やす。
// 止まりかけでは小さく (出られる)、140 km/h では前の 5 m/s² よりずっと強い。数は (仮)
const GRASS: Surface = { grip: 0.55, roll: 0.4, rollV: 0.2, kind: "grass" };

export function surfaceAt(track: Track, q: TrackQuery): Surface {
  const hw = track.def.halfWidth;
  const ad = Math.abs(q.d);
  if (ad <= hw) {
    const side = track.kerb[q.index];
    if (side !== 0 && ad >= hw - KERB_WIDTH && Math.sign(q.d) === side) return KERB;
    return ASPHALT;
  }
  return GRASS;
}

/** 壁までの横の距離 (中心から) */
export function wallDistance(track: Track, index: number): number {
  return track.def.halfWidth + track.runoff[index] + 0.6;
}

/** 道の上か (芝・砂利に全部はみ出していないか) */
export function onTrack(track: Track, q: TrackQuery, margin = 1.2): boolean {
  return Math.abs(q.d) <= track.def.halfWidth + margin;
}
