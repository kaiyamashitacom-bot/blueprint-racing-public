// コースを描くための線 (世界の座標 m で 1 度だけ作っておく)
import { KERB_WIDTH, drsZones, gridPosition, normalAt, pitBoxPoint, pitLanePath, sectorSplitDistances, wallDistance, type Track } from "@bpr/shared";

/** セクターの色 (地図の塗り分け・札の字。S1 赤・S2 青・S3 黄、中継の地図風。仮)。区間タイムの色 (紫・緑・黄) とは別 */
export const SECTOR_TINTS = ["#ff5c6c", "#4aa3ff", "#ffcf3a"] as const;
/** 同じ色を薄く (地図の今いないセクター) */
export const SECTOR_TINTS_SOFT = ["#f2b3b9", "#b4d3f5", "#f3e1a6"] as const;
/** DRS の緑 (ボタン・塔の札と同じ) */
export const DRS_GREEN = "#22d37a";

export interface TrackPaths {
  asphalt: Path2D;
  runoff: Path2D;
  edges: Path2D;
  walls: Path2D;
  center: Path2D;
  kerbA: Path2D;
  kerbB: Path2D;
  startA: Path2D;
  startB: Path2D;
  gridBoxes: Path2D;
  /** 壁の外側の 2 本目の線 (防護壁らしく) */
  walls2: Path2D;
  /** ブレーキの目安の板 (曲がりの 100 m・50 m 手前)。前の形 (黄色い斜めの線)。画面は boardMarks を描く */
  boards: Path2D;
  /** ブレーキの目安の板: 置く場所・向き (道の向き)・字 ("100" / "50") */
  boardMarks: Array<{ x: number; y: number; heading: number; label: string }>;
  /** 壁の外のタイヤの防護壁 (壁に沿った太い線) */
  barrier: Path2D;
  /** スタートの直線のまわり: ピット側の舗装 (ガレージ前) と、反対側の観客席 */
  apron: Path2D;
  garages: Path2D;
  stands: Path2D;
  standRows: Path2D;
  /** 曲がりの番号 (T1, T2 …) を書く場所 */
  corners: Array<{ x: number; y: number; label: string }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** ピットの道の中心の線 (入り口から出口まで) */
  pitLane: Path2D;
  /** 止まる場所 */
  pitBox: { x: number; y: number; heading: number };
  /** セクターの切れ目: 道を横切る塗った線 (スタートの線より細い) */
  sectorLines: Path2D;
  /** セクターの切れ目の札 (道の外)。k = 0 は S1|S2、1 は S2|S3 */
  sectorMarks: Array<{ x: number; y: number; k: number }>;
  /** DRS の区間ごと (drsZones と同じ順): 区間の道の両端の線・検知の線 (点線)・始まりと終わりの線・札 */
  drs: Array<{ edge: Path2D; detect: Path2D; start: Path2D; end: Path2D; marks: Array<{ x: number; y: number; kind: "detect" | "start" | "end" }> }>;
}

const cache = new WeakMap<Track, TrackPaths>();

/** タイヤの防護壁を置く、壁からの距離 (m、仮) */
const BARRIER_GAP = 1.7;
/** 観客席の長さの半分 (スタートの線の前後、m、仮) */
const STANDS_HALF = 90;

export function trackPaths(track: Track): TrackPaths {
  const hit = cache.get(track);
  if (hit) return hit;
  const n = track.n;
  const hw = track.def.halfWidth;
  const at = (i: number, d: number): [number, number] => {
    const [nx, ny] = normalAt(track, i);
    return [track.px[i] + nx * d, track.py[i] + ny * d];
  };
  const loop = (p: Path2D, f: (i: number) => [number, number]) => {
    for (let i = 0; i <= n; i++) {
      const [x, y] = f(i % n);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    p.closePath();
  };

  const asphalt = new Path2D();
  loop(asphalt, (i) => at(i, -hw));
  loop(asphalt, (i) => at(i, hw));

  const wallD = (i: number) => wallDistance(track, i) - 0.3;
  const runoff = new Path2D();
  loop(runoff, (i) => at(i, -wallD(i)));
  loop(runoff, (i) => at(i, wallD(i)));

  const walls2 = new Path2D();
  loop(walls2, (i) => at(i, -(wallD(i) + 0.9)));
  loop(walls2, (i) => at(i, wallD(i) + 0.9));

  // 曲がりの頂点 (曲がり具合が大きい所の山) を探して番号をつける
  const corners: TrackPaths["corners"] = [];
  const boards = new Path2D();
  const boardMarks: TrackPaths["boardMarks"] = [];
  const apex: number[] = [];
  const TH = 1 / 70;
  let i0 = 0;
  while (i0 < n && Math.abs(track.curv[i0]) > TH) i0++;
  for (let k = 0; k < n; k++) {
    const i = (i0 + k) % n;
    if (Math.abs(track.curv[i]) <= TH) continue;
    // 1 つの曲がりの範囲をたどり、一番きつい所を頂点に
    let best = i;
    let j = i;
    let steps = 0;
    while (Math.abs(track.curv[j % n]) > TH && steps < n) {
      if (Math.abs(track.curv[j % n]) > Math.abs(track.curv[best])) best = j % n;
      j++;
      steps++;
    }
    if (!apex.length || Math.min(Math.abs(best - apex[apex.length - 1]), n - Math.abs(best - apex[apex.length - 1])) * track.step > 50) apex.push(best);
    k += steps;
  }
  apex.forEach((a, idx) => {
    const side = Math.sign(track.curv[a]);
    // 外側に番号
    const [x, y] = at(a, -side * (wallD(a) + 6));
    corners.push({ x, y, label: `T${idx + 1}` });
    // 頂点の手前、曲がりの入口から 100 m・50 m 手前の外側に板
    let entry = a;
    for (let b = 0; b < 200; b++) {
      const q = (a - b + n) % n;
      if (Math.abs(track.curv[q]) < TH * 0.6) {
        entry = q;
        break;
      }
    }
    for (const back of [100, 50]) {
      const q = Math.round((entry - back / track.step + n * 2) % n);
      const [bx, by] = at(q, -side * (hw + 1.5));
      const [cx2, cy2] = at(q, -side * (hw + 1.5 + back / 25));
      boards.moveTo(bx, by);
      boards.lineTo(cx2, cy2);
      // 板は道の端から少し外 (芝の上)。壁より外には出さない
      const off = Math.min(hw + 3.2, Math.max(hw + 1.6, wallD(q) - 1.4));
      const [mx, my] = at(q, -side * off);
      boardMarks.push({ x: mx, y: my, heading: Math.atan2(track.ty[q], track.tx[q]), label: String(back) });
    }
  });

  const edges = new Path2D();
  loop(edges, (i) => at(i, -hw));
  loop(edges, (i) => at(i, hw));
  const walls = new Path2D();
  loop(walls, (i) => at(i, -wallD(i)));
  loop(walls, (i) => at(i, wallD(i)));

  const center = new Path2D();
  loop(center, (i) => at(i, 0));

  const kerbA = new Path2D();
  const kerbB = new Path2D();
  for (let i = 0; i < n; i++) {
    const side = track.kerb[i];
    if (!side) continue;
    const j = (i + 1) % n;
    const p = Math.floor(i / 3) % 2 === 0 ? kerbA : kerbB;
    const a = at(i, side * (hw - KERB_WIDTH));
    const b = at(i, side * hw);
    const c = at(j, side * hw);
    const d = at(j, side * (hw - KERB_WIDTH));
    p.moveTo(a[0], a[1]);
    p.lineTo(b[0], b[1]);
    p.lineTo(c[0], c[1]);
    p.lineTo(d[0], d[1]);
    p.closePath();
  }

  // スタートの線 (市松模様)
  const startA = new Path2D();
  const startB = new Path2D();
  const [nx, ny] = normalAt(track, 0);
  const tx = track.tx[0];
  const ty = track.ty[0];
  const sq = 1;
  const cols = Math.round((hw * 2) / sq);
  for (let k = 0; k < cols; k++) {
    for (let row = 0; row < 2; row++) {
      const p = (k + row) % 2 === 0 ? startA : startB;
      const d0 = -hw + k * sq;
      const s0 = row * sq - sq;
      const x0 = track.px[0] + nx * d0 + tx * s0;
      const y0 = track.py[0] + ny * d0 + ty * s0;
      p.moveTo(x0, y0);
      p.lineTo(x0 + nx * sq, y0 + ny * sq);
      p.lineTo(x0 + nx * sq + tx * sq, y0 + ny * sq + ty * sq);
      p.lineTo(x0 + tx * sq, y0 + ty * sq);
      p.closePath();
    }
  }

  // スタートの並びの枠
  const gridBoxes = new Path2D();
  for (let slot = 0; slot < 8; slot++) {
    const g = gridPosition(track, slot);
    const fx = Math.cos(g.heading);
    const fy = Math.sin(g.heading);
    const rx = -fy;
    const ry = fx;
    const front = 3;
    const half = 1.8;
    const ax = g.x + fx * front - rx * half;
    const ay = g.y + fy * front - ry * half;
    gridBoxes.moveTo(ax - fx * 1.2, ay - fy * 1.2);
    gridBoxes.lineTo(ax, ay);
    gridBoxes.lineTo(ax + rx * half * 2, ay + ry * half * 2);
    gridBoxes.lineTo(ax + rx * half * 2 - fx * 1.2, ay + ry * half * 2 - fy * 1.2);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, track.px[i]);
    maxX = Math.max(maxX, track.px[i]);
    minY = Math.min(minY, track.py[i]);
    maxY = Math.max(maxY, track.py[i]);
  }
  // 壁の外: タイヤの防護壁 (壁の 1.7 m 外)
  const barrier = new Path2D();
  loop(barrier, (i) => at(i, -(wallD(i) + BARRIER_GAP)));
  loop(barrier, (i) => at(i, wallD(i) + BARRIER_GAP));

  // スタートの直線のまわり (仮の広さ): ピット側はガレージ前の舗装、反対側は観客席
  const pside = track.pit.side;
  const idx = (u: number) => Math.round((((u % track.length) + track.length) % track.length) / track.step) % n;
  const band = (p: Path2D, from: number, to: number, sideSign: number, d0: number, d1: number) => {
    const pts: Array<[number, number]> = [];
    for (let u = from; u <= to; u += 2) {
      const i = idx(u);
      pts.push(at(i, sideSign * (wallD(i) + d0)));
    }
    for (let u = to; u >= from; u -= 2) {
      const i = idx(u);
      pts.push(at(i, sideSign * (wallD(i) + d1)));
    }
    pts.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
  };
  const apron = new Path2D();
  const garages = new Path2D();
  const pe = track.pit.entry;
  const px2 = track.pit.exit;
  band(apron, pe, px2, pside, BARRIER_GAP + 1.2, BARRIER_GAP + 13);
  for (let u = pe + 6; u < px2 - 3; u += 7) {
    const i = idx(u);
    const [ax, ay] = at(i, pside * (wallD(i) + BARRIER_GAP + 5));
    const [bx2, by2] = at(i, pside * (wallD(i) + BARRIER_GAP + 13));
    garages.moveTo(ax, ay);
    garages.lineTo(bx2, by2);
  }
  const stands = new Path2D();
  const standRows = new Path2D();
  const s0 = -STANDS_HALF;
  const s1 = STANDS_HALF;
  band(stands, s0, s1, -pside, BARRIER_GAP + 3, BARRIER_GAP + 15);
  for (let r = 0; r < 5; r++) {
    const d = BARRIER_GAP + 4.5 + r * 2.4;
    for (let u = s0 + 1; u <= s1 - 1; u += 2) {
      const i = idx(u);
      const [x, y] = at(i, -pside * (wallD(i) + d));
      if (u === s0 + 1) standRows.moveTo(x, y);
      else standRows.lineTo(x, y);
    }
  }

  const pitLane = new Path2D();
  pitLanePath(track, 2).forEach((pt, k) => (k ? pitLane.lineTo(pt.x, pt.y) : pitLane.moveTo(pt.x, pt.y)));
  const pitBox = pitBoxPoint(track);

  // 道を横切る線 (道のり s、幅 wd m)。dash を渡すと点線 (塗りの長さ・すき間 m)
  const across = (p: Path2D, s: number, wd: number, dash?: [number, number]) => {
    const i = idx(s);
    const [nx, ny] = normalAt(track, i);
    const hx = (track.tx[i] * wd) / 2;
    const hy = (track.ty[i] * wd) / 2;
    const x = track.px[i];
    const y = track.py[i];
    const seg = (d0: number, d1: number) => {
      p.moveTo(x + nx * d0 - hx, y + ny * d0 - hy);
      p.lineTo(x + nx * d1 - hx, y + ny * d1 - hy);
      p.lineTo(x + nx * d1 + hx, y + ny * d1 + hy);
      p.lineTo(x + nx * d0 + hx, y + ny * d0 + hy);
      p.closePath();
    };
    if (!dash) return seg(-hw, hw);
    for (let d = -hw; d < hw; d += dash[0] + dash[1]) seg(d, Math.min(hw, d + dash[0]));
  };
  // 札の場所: 道の外 (芝の上)。壁より外には出さない (ブレーキの目安の板と同じ)
  const boardAt = (s: number, side: number): [number, number] => {
    const i = idx(s);
    const off = Math.min(hw + 3.2, Math.max(hw + 1.6, wallD(i) - 1.4));
    return at(i, side * off);
  };
  // セクターの切れ目 (札は道の +側、DRS の札は −側にして重ならないように)
  const sectorLines = new Path2D();
  const sectorMarks: TrackPaths["sectorMarks"] = [];
  sectorSplitDistances(track).forEach((s, k) => {
    across(sectorLines, s, 0.45);
    const [x, y] = boardAt(s, 1);
    sectorMarks.push({ x, y, k });
  });
  // DRS の区間
  const drs: TrackPaths["drs"] = drsZones(track).map((z) => {
    const edge = new Path2D();
    for (const side of [-1, 1]) {
      for (let u = z.start; u <= z.end + 0.01; u += 2) {
        const [x, y] = at(idx(Math.min(u, z.end)), side * (hw - 0.2));
        if (u === z.start) edge.moveTo(x, y);
        else edge.lineTo(x, y);
      }
    }
    const detect = new Path2D();
    const start = new Path2D();
    const end = new Path2D();
    across(detect, z.detect, 0.4, [0.9, 0.7]);
    across(start, z.start, 0.4);
    across(end, z.end, 0.25, [0.5, 0.5]);
    const marks: TrackPaths["drs"][number]["marks"] = [];
    for (const [s, kind] of [[z.detect, "detect"], [z.start, "start"], [z.end, "end"]] as const) {
      const [x, y] = boardAt(s, -1);
      marks.push({ x, y, kind });
    }
    return { edge, detect, start, end, marks };
  });

  const out: TrackPaths = { sectorLines, sectorMarks, drs, pitLane, pitBox, asphalt, runoff, edges, walls, walls2, boards, boardMarks, barrier, apron, garages, stands, standRows, corners, center, kerbA, kerbB, startA, startB, gridBoxes, bounds: { minX, minY, maxX, maxY } };
  cache.set(track, out);
  return out;
}
