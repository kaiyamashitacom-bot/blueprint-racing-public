// 遊ぶ人が作ったコースを確かめる (走れる形か)。指で引いた線を、なめらかな輪の点にする道具もここ
// 決まり (design/DECISIONS.md の「コース」): 道幅に下限あり (8 台が走れる幅)。公開は 1 周走れたら + 管理者が確かめてから
import { cleanDisplayName, nameKey } from "./account.ts";
import { DRS_DETECT_BEFORE, type DrsZoneDef } from "./drs.ts";
import { sectorSplitProblem, sectorSplits } from "./sectors.ts";
import { ROAD_SURFACES, buildTrack, wallDistance, type PitDef, type RoadSurface, type Track, type TrackDef } from "./track.ts";

/** 作れるコースの決まり (仮の数) */
export const TRACK_LIMITS = {
  /** 輪の点の数 */
  minPoints: 4,
  /** 長い直線にも 60 m ごとに点が入るので、10 km なら 170 点ほど要る */
  maxPoints: 400,
  /** 1 周の長さ (m)。決まりは「上限なし」だが、作る画面と座標の広さ (maxCoord) に合わせて 10 km まで (11/25 仮)。
   *  10 km で buildTrack 1〜2 ms・確かめ 6 ms・走りの線 60 ms・形の配列 0.6 MB (20 km でも倍になるだけ) */
  minLength: 600,
  maxLength: 10000,
  /** 道幅の半分 (m)。6 m で道幅 12 m (8 台が並んでもすり抜けられる) */
  minHalfWidth: 6,
  maxHalfWidth: 10,
  /** 芝・砂利の幅 (m) */
  minRunoff: 3,
  maxRunoff: 15,
  /** 座標の大きさの上限 (m) */
  maxCoord: 5000,
  /** 名前の長さ */
  maxName: 20,
  /** スタートの並び (8 台) の所の曲がりの合計の上限 (度) */
  gridTurnDeg: 55,
  /** 点どうしの最短の間 (m)。近すぎると Catmull-Rom の線が折れやすい */
  minPointGap: 6,
  /** DRS の区間の数・1 つの長さ (m)・検知の線は始まりの何 m 手前までか */
  maxDrsZones: 3,
  minDrsLength: 80,
  maxDrsDetect: 400,
  /** ピット: 入り口はスタートの線の何 m 手前まで・出口は何 m 先まで (どちらも 40 m 以上離す) */
  pitMin: 40,
  pitMax: 400,
  /** ピットの道の区間の曲がりの合計の上限 (度) */
  pitTurnDeg: 100,
} as const;

/** ピットの道の入り口・出口から、道に移る長さ (track.ts の inLen・outLen と同じ) */
const PIT_IN_LEN = 40;
const PIT_OUT_LEN = 45;

/** スタートの並び: physics.ts の gridPosition は s = -(10 + slot × 8)。8 台目の後ろまで */
export const GRID_BACK = 10 + 7 * 8 + 6;
/** スタートの線の先も少しまっすぐ */
export const GRID_FRONT = 10;

export type TrackIssueCode = "name" | "points" | "coord" | "length" | "width" | "runoff" | "cross" | "close" | "corner" | "grid" | "walls" | "drs" | "pit" | "surface" | "sectors";

export interface TrackIssue {
  code: TrackIssueCode;
  /** 遊ぶ人に見せる文 */
  message: string;
  /** 問題のある所 (m)。画面で印を付ける */
  at?: [number, number];
}

export interface TrackCheck {
  ok: boolean;
  issues: TrackIssue[];
  /** 組み立てたコース (点の数が足りないなどで組めないときは null) */
  track: Track | null;
}

/** コースを確かめる。問題がなければ issues は空 */
export function checkTrack(def: TrackDef): TrackCheck {
  const L = TRACK_LIMITS;
  const issues: TrackIssue[] = [];
  const name = (def.name ?? "").trim();
  if (!name) issues.push({ code: "name", message: "コースに名前を付けてください" });
  else if (name.length > L.maxName) issues.push({ code: "name", message: `名前は ${L.maxName} 字までです` });

  if (!(def.halfWidth >= L.minHalfWidth)) {
    issues.push({ code: "width", message: `道幅が狭すぎます。${L.minHalfWidth * 2} m 以上にしてください (8 台が走れる幅)` });
  } else if (def.halfWidth > L.maxHalfWidth) {
    issues.push({ code: "width", message: `道幅は ${L.maxHalfWidth * 2} m までです` });
  }
  if (!(def.runoff >= L.minRunoff && def.runoff <= L.maxRunoff)) {
    issues.push({ code: "runoff", message: `芝の幅は ${L.minRunoff}〜${L.maxRunoff} m にしてください` });
  }
  for (const w of def.walls ?? []) {
    if (!(w.length === 2 && w[0] >= 0 && w[0] <= 1 && w[1] >= 0 && w[1] <= 1)) {
      issues.push({ code: "walls", message: "壁の区間の数がおかしいです" });
      break;
    }
  }

  const pts = def.points ?? [];
  if (pts.length < L.minPoints) {
    issues.push({ code: "points", message: `点が少なすぎます。輪になるように ${L.minPoints} 点以上で線を引いてください` });
    return { ok: false, issues, track: null };
  }
  if (pts.length > L.maxPoints) issues.push({ code: "points", message: `点が多すぎます (${L.maxPoints} 点まで)` });
  for (const p of pts) {
    if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= L.maxCoord && Math.abs(p[1]) <= L.maxCoord)) {
      issues.push({ code: "coord", message: "コースが広がりすぎています" });
      return { ok: false, issues, track: null };
    }
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < L.minPointGap) {
      issues.push({ code: "points", message: "近すぎる点があります。点を消すか離してください", at: [a[0], a[1]] });
      break;
    }
  }

  const track = buildTrack({ ...def, halfWidth: Math.max(def.halfWidth, 1), runoff: Math.max(def.runoff, 0) });
  if (track.length < L.minLength) {
    issues.push({ code: "length", message: `1 周が短すぎます (${Math.round(track.length)} m)。${L.minLength} m 以上にしてください` });
  } else if (track.length > L.maxLength) {
    issues.push({ code: "length", message: `1 周が長すぎます (${Math.round(track.length)} m)。${L.maxLength} m までにしてください` });
  }

  issues.push(...checkSeparation(track));
  issues.push(...checkCorners(track));
  issues.push(...checkGrid(track));
  issues.push(...checkDrs(track));
  issues.push(...checkPit(track));
  issues.push(...checkSectors(track));
  if (def.surface !== undefined && !ROAD_SURFACES.includes(def.surface)) issues.push({ code: "surface", message: "その路面はまだ使えません" });
  return { ok: issues.length === 0, issues, track };
}

const modL = (v: number, L: number) => ((v % L) + L) % L;

/** セクターの切れ目 (書いてあるときだけ): 2 つ・順に並ぶ・1 つのセクターは 1 周の 10% 以上 */
function checkSectors(t: Track): TrackIssue[] {
  const s = t.def.sectors;
  if (s === undefined) return [];
  const p = sectorSplitProblem(s);
  if (!p) return [];
  const f = Array.isArray(s) && typeof s[0] === "number" && Number.isFinite(s[0]) ? modL(s[0], 1) : sectorSplits(t.def)[0];
  const i = Math.floor(f * t.n) % t.n;
  return [{ code: "sectors", message: p, at: [t.px[i], t.py[i]] }];
}

/** DRS の区間 (書いてあるときだけ): 数・長さ・重なり・検知の線 */
function checkDrs(t: Track): TrackIssue[] {
  const zones = t.def.drs;
  if (zones === undefined) return [];
  const L = TRACK_LIMITS;
  const len = t.length;
  if (!Array.isArray(zones)) return [{ code: "drs", message: "DRS の区間が読めません" }];
  if (zones.length > L.maxDrsZones) return [{ code: "drs", message: `DRS の区間は ${L.maxDrsZones} つまでです` }];
  const out: TrackIssue[] = [];
  const at = (s: number): [number, number] => {
    const i = Math.floor(modL(s, len) / t.step) % t.n;
    return [t.px[i], t.py[i]];
  };
  for (const z of zones) {
    const ok = Number.isFinite(z.start) && Number.isFinite(z.end) && (z.detect === undefined || Number.isFinite(z.detect));
    if (!ok || Math.abs(z.start) > len || Math.abs(z.end) > 2 * len) {
      out.push({ code: "drs", message: "DRS の区間の数がおかしいです" });
      continue;
    }
    const zl = z.end - z.start;
    if (zl < L.minDrsLength) out.push({ code: "drs", message: `DRS の区間が短すぎます (${Math.round(zl)} m)。${L.minDrsLength} m 以上に`, at: at(z.start) });
    else if (zl > len * 0.5) out.push({ code: "drs", message: "DRS の区間が長すぎます (1 周の半分まで)", at: at(z.start) });
    const det = z.detect ?? z.start - DRS_DETECT_BEFORE;
    if (det > z.start - 10 || det < z.start - L.maxDrsDetect) out.push({ code: "drs", message: `DRS の検知の線は区間の 10〜${L.maxDrsDetect} m 手前に`, at: at(z.start) });
  }
  // 重なり (輪なので、始まりの順に並べて隣どうし)
  const sorted = zones
    .filter((z) => Number.isFinite(z.start) && Number.isFinite(z.end) && z.end > z.start)
    .map((z) => ({ a: modL(z.start, len), l: z.end - z.start }))
    .sort((p, q) => p.a - q.a);
  for (let k = 0; k < sorted.length && sorted.length > 1; k++) {
    const p = sorted[k];
    const q = sorted[(k + 1) % sorted.length];
    const gap = modL(q.a - p.a, len) || len;
    if (p.l >= gap) {
      out.push({ code: "drs", message: "DRS の区間が重なっています", at: at(q.a) });
      break;
    }
  }
  return out;
}

/** ピット (書いてあるときだけ): 入り口・止まる所・出口の順と、道の区間がまっすぐに近いか */
function checkPit(t: Track): TrackIssue[] {
  const p = t.def.pit;
  if (p === undefined) return [];
  const L = TRACK_LIMITS;
  const lane = t.pit;
  const at: [number, number] = [t.px[0], t.py[0]];
  if (p.side !== undefined && p.side !== 1 && p.side !== -1) return [{ code: "pit", message: "ピットの側が読めません", at }];
  const nums = [lane.entry, lane.box, lane.exit];
  if (!nums.every(Number.isFinite)) return [{ code: "pit", message: "ピットの数が読めません", at }];
  const out: TrackIssue[] = [];
  if (lane.entry > -L.pitMin || lane.entry < -L.pitMax) out.push({ code: "pit", message: `ピットの入り口はスタートの線の ${L.pitMin}〜${L.pitMax} m 手前に`, at });
  if (lane.exit < L.pitMin || lane.exit > L.pitMax) out.push({ code: "pit", message: `ピットの出口はスタートの線の ${L.pitMin}〜${L.pitMax} m 先に`, at });
  if (lane.box < lane.entry + PIT_IN_LEN || lane.box > lane.exit - PIT_OUT_LEN) {
    out.push({ code: "pit", message: `止まる所は入り口の ${PIT_IN_LEN} m 先から、出口の ${PIT_OUT_LEN} m 手前までに`, at });
  }
  if (lane.exit - lane.entry > t.length * 0.5) out.push({ code: "pit", message: "ピットの道が長すぎます (1 周の半分まで)", at });
  if (out.length) return out;
  let turn = 0;
  for (let s = lane.entry; s < lane.exit; s += t.step) {
    const i = Math.floor(modL(s, t.length) / t.step) % t.n;
    turn += Math.abs(t.curv[i]) * t.step;
  }
  const deg = (turn * 180) / Math.PI;
  if (deg > L.pitTurnDeg) out.push({ code: "pit", message: `ピットの道の所が曲がりすぎです (${Math.round(deg)} 度)。入り口と出口をスタートの線に近づけて`, at });
  return out;
}

// ---------------------------------------------------------------------------
// サーバーで受け取ったコースを読む

/**
 * 送られてきたコース (信用しない) を TrackDef の形にする。読めなければ null。
 * 知らない項目は捨てる。決まりに合うかは checkTrack で別に確かめる
 */
export function parseTrackDef(raw: unknown, id = ""): TrackDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (!Array.isArray(r.points) || r.points.length > TRACK_LIMITS.maxPoints * 2) return null;
  const points: Array<[number, number]> = [];
  for (const p of r.points as unknown[]) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = num(p[0]);
    const y = num(p[1]);
    if (x === null || y === null) return null;
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }
  const halfWidth = num(r.halfWidth);
  const runoff = num(r.runoff);
  if (halfWidth === null || runoff === null) return null;
  const def: TrackDef = { id, name: typeof r.name === "string" ? r.name.slice(0, 200) : "", points, halfWidth, runoff };
  if (r.walls !== undefined) {
    if (!Array.isArray(r.walls) || r.walls.length > TRACK_LIMITS.maxPoints) return null;
    const walls: Array<[number, number]> = [];
    for (const w of r.walls as unknown[]) {
      if (!Array.isArray(w) || w.length !== 2 || num(w[0]) === null || num(w[1]) === null) return null;
      walls.push([w[0] as number, w[1] as number]);
    }
    if (walls.length) def.walls = walls;
  }
  if (r.drs !== undefined) {
    if (!Array.isArray(r.drs) || r.drs.length > 10) return null;
    const drs: DrsZoneDef[] = [];
    for (const z of r.drs as unknown[]) {
      if (!z || typeof z !== "object") return null;
      const zz = z as Record<string, unknown>;
      const start = num(zz.start);
      const end = num(zz.end);
      if (start === null || end === null) return null;
      const d: DrsZoneDef = { start: Math.round(start), end: Math.round(end) };
      if (zz.detect !== undefined) {
        const det = num(zz.detect);
        if (det === null) return null;
        d.detect = Math.round(det);
      }
      drs.push(d);
    }
    def.drs = drs;
  }
  if (r.pit !== undefined) {
    if (!r.pit || typeof r.pit !== "object") return null;
    const pp = r.pit as Record<string, unknown>;
    const pit: PitDef = {};
    if (pp.side !== undefined) {
      if (pp.side !== 1 && pp.side !== -1) return null;
      pit.side = pp.side;
    }
    for (const k of ["entry", "box", "exit"] as const) {
      if (pp[k] === undefined) continue;
      const v = num(pp[k]);
      if (v === null) return null;
      pit[k] = Math.round(v);
    }
    def.pit = pit;
  }
  if (r.surface !== undefined) {
    if (typeof r.surface !== "string" || !ROAD_SURFACES.includes(r.surface as RoadSurface)) return null;
    def.surface = r.surface as RoadSurface;
  }
  if (r.kerbs !== undefined) {
    if (typeof r.kerbs !== "boolean") return null;
    if (!r.kerbs) def.kerbs = false;
  }
  if (r.sectors !== undefined) {
    if (!Array.isArray(r.sectors) || r.sectors.length !== 2) return null;
    const sec: number[] = [];
    for (const v of r.sectors as unknown[]) {
      const x = num(v);
      if (x === null) return null;
      sec.push(Math.round(x * 1000) / 1000);
    }
    def.sectors = sec;
  }
  return def;
}

/** 走りに効く所だけ (名前と id を除く) を同じ順に並べた文字。同じ形かをくらべるのに使う */
export function trackShapeKey(def: TrackDef): string {
  return JSON.stringify({
    points: def.points,
    halfWidth: def.halfWidth,
    runoff: def.runoff,
    walls: def.walls ?? null,
    drs: def.drs ?? null,
    pit: def.pit ?? null,
    surface: def.surface ?? "asphalt",
    kerbs: def.kerbs !== false,
  });
}

/** DRS の区間を割合 (0..1 の始まり・終わり) から m に (作る画面で形を変えても区間がついて来るように) */
export function drsFromFractions(fr: ReadonlyArray<readonly [number, number]>, length: number): DrsZoneDef[] {
  return fr.map(([a0, b]) => {
    const a = ((a0 % 1) + 1) % 1;
    const start = Math.round(a * length);
    const end = Math.round((b < a ? b + 1 : b) * length);
    return { start, end };
  });
}

/** コースの距離 s のまわりの直線 (曲がりの小さな所) を探す。DRS の区間を置く道具で使う。なければ null */
export function straightAround(t: Track, s: number, curvMax = 1 / 260): { start: number; end: number } | null {
  const n = t.n;
  const i0 = Math.floor(modL(s, t.length) / t.step) % n;
  const ok = (i: number) => Math.abs(t.curv[((i % n) + n) % n]) < curvMax;
  if (!ok(i0)) return null;
  let a = i0;
  let b = i0;
  while (b - a < n - 1 && ok(a - 1)) a--;
  while (b - a < n - 1 && ok(b + 1)) b++;
  return { start: a * t.step, end: (b + 1) * t.step };
}

/** 公式のふりをする名前は使えない (管理者が直すときは使える) */
const TRACK_NAME_RESERVED = ["公式", "official", "管理", "運営", "admin"];

/** コースの名前を整える (公開するとき) */
export function cleanTrackName(raw: unknown): string {
  return cleanDisplayName(raw);
}

/** コースの名前を確かめる。問題がなければ null。admin = 管理者が付ける名前 (公式などの言葉も使える) */
export function checkTrackName(raw: unknown, admin = false): string | null {
  const s = cleanTrackName(raw);
  if (!s) return "コースに名前を付けてください";
  if ([...s].length > TRACK_LIMITS.maxName) return `名前は ${TRACK_LIMITS.maxName} 字までです`;
  if (/[<>]/.test(s)) return "名前に < > は使えません";
  if (!admin && TRACK_NAME_RESERVED.some((w) => nameKey(s).includes(w))) return "名前に「公式」「運営」などは使えません";
  return null;
}

/** 文だけほしいとき */
export function trackProblems(def: TrackDef): string[] {
  return checkTrack(def).issues.map((i) => i.message);
}

/** 離れた区間どうしが近すぎないか (道が交わる・壁を越えて近道できる)。試験 sim.test.ts と同じ決まり */
function checkSeparation(t: Track): TrackIssue[] {
  const def = t.def;
  const need = 2 * (def.halfWidth + def.runoff + 0.6) + 2;
  const skip = need * 2.2;
  // 升目に分けて近くだけ比べる
  const cell = need;
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (let i = 0; i < t.n; i += 2) {
    const k = key(Math.floor(t.px[i] / cell), Math.floor(t.py[i] / cell));
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  // 悪い組を集め、近い所はひとまとめにする
  const bad: Array<{ i: number; j: number; d: number }> = [];
  for (let i = 0; i < t.n; i += 2) {
    const cx = Math.floor(t.px[i] / cell);
    const cy = Math.floor(t.py[i] / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get(key(cx + ox, cy + oy)) ?? []) {
          if (j <= i) continue;
          const gap = Math.min(j - i, t.n - (j - i)) * t.step;
          if (gap < skip) continue;
          const d = Math.hypot(t.px[i] - t.px[j], t.py[i] - t.py[j]);
          if (d <= need) bad.push({ i, j, d });
        }
      }
    }
  }
  const spots: Array<{ i: number; j: number; d: number }> = [];
  for (const b of bad.sort((p, q) => p.d - q.d)) {
    const near = spots.some((s) => arcGap(t, s.i, b.i) < skip && arcGap(t, s.j, b.j) < skip);
    if (!near) spots.push(b);
    if (spots.length >= 4) break;
  }
  return spots.map((s) => {
    const mx = (t.px[s.i] + t.px[s.j]) / 2;
    const my = (t.py[s.i] + t.py[s.j]) / 2;
    if (s.d < def.halfWidth * 2) return { code: "cross" as const, message: "道どうしが交わっています (8 の字や重なりは作れません)", at: [mx, my] as [number, number] };
    return {
      code: "close" as const,
      message: `離れた道どうしが近すぎます (${s.d.toFixed(0)} m)。${Math.ceil(need)} m 以上離してください (壁ごしに近道できないように)`,
      at: [mx, my] as [number, number],
    };
  });
}

function arcGap(t: Track, a: number, b: number): number {
  const k = Math.abs(a - b);
  return Math.min(k, t.n - k) * t.step;
}

/**
 * 曲がりの半径と要る半径を 0.1 m まで書く (今は切り捨て・要るのは切り上げ。同じ数に見えないように)。
 * 例「半径 11.6 m → 12.4 m 以上に (あと 0.8 m)」。QA 2 回目: 「半径 12 m、12 m 以上に」と出ていた
 */
export function cornerNeedText(r: number, need: number): string {
  const now = Math.floor(r * 10) / 10;
  const want = Math.max(Math.ceil(need * 10) / 10, Math.round((now + 0.1) * 10) / 10);
  const more = Math.round((want - now) * 10) / 10;
  return `半径 ${now.toFixed(1)} m → ${want.toFixed(1)} m 以上に (あと ${more.toFixed(1)} m)`;
}

/** 曲がりがきつすぎないか (曲がりの半径 > 壁までの距離 + 2)。内側の壁の線が折れない */
function checkCorners(t: Track): TrackIssue[] {
  const out: TrackIssue[] = [];
  const margin = (i: number) => 1 / Math.max(1e-6, Math.abs(t.curv[i])) - wallDistance(t, i);
  // 続いた悪い所をひとまとめに (輪なので、良い所から数えはじめる)
  let start = 0;
  while (start < t.n && margin(start) <= 2) start++;
  if (start >= t.n) return [{ code: "corner", message: "どこも曲がりがきつすぎます", at: [t.px[0], t.py[0]] }];
  let worst = -1;
  for (let k = 1; k <= t.n; k++) {
    const i = (start + k) % t.n;
    const m = margin(i);
    if (m <= 2) {
      if (worst < 0 || m < margin(worst)) worst = i;
    } else if (worst >= 0) {
      out.push({
        code: "corner",
        message: `曲がりがきつすぎます。${cornerNeedText(1 / Math.max(1e-6, Math.abs(t.curv[worst])), wallDistance(t, worst) + 2)}。曲がりをゆるくするか、そこを壁にするか、道幅や芝を狭く`,
        at: [t.px[worst], t.py[worst]],
      });
      worst = -1;
    }
  }
  return out.slice(0, 6);
}

/** スタートの並び (8 台) の所が、まっすぐに近いか */
function checkGrid(t: Track): TrackIssue[] {
  let turn = 0;
  for (let s = -GRID_BACK; s < GRID_FRONT; s++) {
    const i = Math.floor((((s % t.length) + t.length) % t.length) / t.step) % t.n;
    turn += Math.abs(t.curv[i]) * t.step;
  }
  const deg = (turn * 180) / Math.PI;
  if (deg <= TRACK_LIMITS.gridTurnDeg) return [];
  return [
    {
      code: "grid",
      message: `スタートの並び (線の後ろ ${GRID_BACK} m) が曲がりすぎです。まっすぐな所にスタートを置いてください`,
      at: [t.px[0], t.py[0]],
    },
  ];
}

// ---------------------------------------------------------------------------
// 指で引いた線 → なめらかな輪の点

export interface SimplifyOptions {
  /** 並べ直す間 (m) */
  spacing?: number;
  /** なめらかにする回数 */
  smooth?: number;
  /** 点を減らすときの許し (m) */
  tolerance?: number;
  /** 曲がりの所の点の間 (m)。長いまっすぐの両端にもこの間で点を置く */
  cornerSpacing?: number;
}

/**
 * 指やマウスで引いた線 (たくさんの点) を、Catmull-Rom 用の少ない点の輪にする。
 * 最後は最初へ自動でつなぐ (はみ出して最初の点を越えた分は切る)。
 * スタートは一番長いまっすぐの後ろの方に置き直す (並びが入るように)。
 */
export function simplifyPath(raw: ReadonlyArray<readonly [number, number]>, opt: SimplifyOptions = {}): Array<[number, number]> {
  const spacing = opt.spacing ?? 4;
  const smooth = opt.smooth ?? 6;
  const tol = opt.tolerance ?? 3;
  const corner = opt.cornerSpacing ?? 30;
  let pts: Array<[number, number]> = [];
  for (const p of raw) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.5) pts.push([p[0], p[1]]);
  }
  if (pts.length < 3) return pts;
  pts = trimClosing(pts);
  // 1) 同じ間に並べ直す (輪)
  let ring = resampleLoop(pts, spacing);
  if (ring.length < 6) return ring;
  // 2) 手のふるえをならす
  for (let k = 0; k < smooth; k++) ring = smoothLoop(ring);
  // 3) 点を減らす (まっすぐは少なく、曲がりは残す)
  let out = douglasPeuckerLoop(ring, tol);
  // 4) 曲がりの所は点を足す・まっすぐの両端にも点 (Catmull-Rom がふくらまないように)
  out = evenOut(out, corner);
  out = startOnStraight(out);
  return out.map(([x, y]) => [round1(x), round1(y)]);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 終わりが最初の点を越えてはみ出した分を切る */
function trimClosing(pts: Array<[number, number]>): Array<[number, number]> {
  const total = pathLength(pts);
  const close = Math.max(8, Math.min(60, total * 0.05));
  const first = pts[0];
  // 後ろ 1/4 の中で最初の点に一番近い所で切る (近ければ)
  let best = -1;
  let bestD = close;
  for (let i = Math.floor(pts.length * 0.75); i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - first[0], pts[i][1] - first[1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best > 2 ? pts.slice(0, best) : pts;
}

function pathLength(pts: Array<[number, number]>): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** 輪を同じ間で並べ直す */
export function resampleLoop(pts: ReadonlyArray<readonly [number, number]>, spacing: number): Array<[number, number]> {
  const m = pts.length;
  const cum = [0];
  for (let i = 1; i <= m; i++) {
    const a = pts[i - 1];
    const b = pts[i % m];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[m];
  const n = Math.max(3, Math.round(total / spacing));
  const out: Array<[number, number]> = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * total;
    while (j < m - 1 && cum[j + 1] < s) j++;
    const a = pts[j];
    const b = pts[(j + 1) % m];
    const u = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

function smoothLoop(p: Array<[number, number]>): Array<[number, number]> {
  const n = p.length;
  return p.map((c, i) => {
    const a = p[(i - 1 + n) % n];
    const b = p[(i + 1) % n];
    return [(a[0] + 2 * c[0] + b[0]) / 4, (a[1] + 2 * c[1] + b[1]) / 4];
  });
}

/** 輪の Douglas-Peucker: 一番離れた 2 点で 2 つに分けて、それぞれ減らす */
function douglasPeuckerLoop(p: Array<[number, number]>, tol: number): Array<[number, number]> {
  const n = p.length;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const dp = (a: number, b: number) => {
    // a から b まで (b は輪を回って a より後ろのことがある)
    const len = (b - a + n) % n;
    if (len < 2) return;
    const A = p[a];
    const B = p[b];
    let best = -1;
    let bestD = tol;
    for (let k = 1; k < len; k++) {
      const i = (a + k) % n;
      const d = segDist(p[i], A, B);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return;
    keep[best] = 1;
    dp(a, best);
    dp(best, b);
  };
  dp(0, far);
  dp(far, 0);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i]);
  return out;
}

function segDist(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * u, p[1] - a[1] - dy * u);
}

/**
 * 減らした点を整える: 短すぎる間は 1 つにまとめ、長い間は同じ長さに分ける
 * (Catmull-Rom は隣どうしの間の長さが大きく違うと、短い方がふくらんで折れるため)
 */
function evenOut(pts: Array<[number, number]>, corner: number): Array<[number, number]> {
  const p = pts.slice();
  const minGap = Math.max(TRACK_LIMITS.minPointGap * 2, corner * 0.5);
  for (let guard = 0; guard < 500 && p.length > TRACK_LIMITS.minPoints; guard++) {
    let worst = -1;
    let worstD = minGap;
    for (let i = 0; i < p.length; i++) {
      const b = p[(i + 1) % p.length];
      const d = Math.hypot(b[0] - p[i][0], b[1] - p[i][1]);
      if (d < worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) break;
    const j = (worst + 1) % p.length;
    const a = p[worst];
    const b = p[j];
    p[worst] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    p.splice(j, 1);
  }
  const maxSeg = corner * 2;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    out.push(a);
    const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxSeg);
    for (let q = 1; q < k; q++) out.push([a[0] + ((b[0] - a[0]) * q) / k, a[1] + ((b[1] - a[1]) * q) / k]);
  }
  return out;
}

/** 一番長いまっすぐの後ろの方にある点をスタートにする (輪を回すだけ。走る向きは変えない) */
function startOnStraight(p: Array<[number, number]>): Array<[number, number]> {
  const n = p.length;
  if (n < 3) return p;
  const dir = (i: number) => {
    const a = p[i];
    const b = p[(i + 1) % n];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const segLen = (i: number) => {
    const a = p[i];
    const b = p[(i + 1) % n];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  const turn = (a: number, b: number) => {
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  // まっすぐの続き: 点 i から、向きが 0.12 rad 以内の間が続く所まで
  let best = { len: -1, from: 0, count: 1 };
  for (let i = 0; i < n; i++) {
    let len = segLen(i);
    let count = 1;
    while (count < n - 1 && turn(dir((i + count) % n), dir(i)) <= 0.12) {
      len += segLen((i + count) % n);
      count++;
    }
    if (len > best.len) best = { len, from: i, count };
  }
  // 続きの中の点 (始まりから s m の所) のうち、並びが入る所に一番近いもの
  const want = Math.min(best.len - 10, Math.max(GRID_BACK + 15, best.len * 0.65));
  let s = 0;
  let pick = best.from;
  let pickErr = Infinity;
  for (let c = 0; c <= best.count; c++) {
    const i = (best.from + c) % n;
    const err = Math.abs(s - want);
    if (err < pickErr) {
      pickErr = err;
      pick = i;
    }
    s += segLen(i);
  }
  return [...p.slice(pick), ...p.slice(0, pick)];
}

// ---------------------------------------------------------------------------
// 作る画面で使う小さな道具

/** 輪の各点が、コースの始まりから何割の所か (buildTrack と同じはかり方)。壁の区間を点の間で決めるのに使う */
export function controlFractions(points: ReadonlyArray<readonly [number, number]>): number[] {
  const m = points.length;
  const SUB = 60; // buildTrack と同じ
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < m; i++) {
    const p0 = points[(i - 1 + m) % m];
    const p1 = points[i];
    const p2 = points[(i + 1) % m];
    const p3 = points[(i + 2) % m];
    let len = 0;
    let px = p1[0];
    let py = p1[1];
    for (let k = 1; k <= SUB; k++) {
      const t = k / SUB;
      const [x, y] = catmull(p0, p1, p2, p3, t);
      len += Math.hypot(x - px, y - py);
      px = x;
      py = y;
    }
    seg.push(len);
    total += len;
  }
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < m; i++) {
    out.push(total > 0 ? acc / total : i / m);
    acc += seg[i];
  }
  return out;
}

export function catmull(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  t: number,
): [number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/** 点の間ごとの「壁か」から、TrackDef の walls (割合の区間) を作る。flags[i] は 点 i → 点 i+1 の間 */
export function wallsFromSegments(points: ReadonlyArray<readonly [number, number]>, flags: readonly boolean[]): Array<[number, number]> {
  const m = points.length;
  if (m < 2 || !flags.some((f) => f)) return [];
  if (flags.length >= m && flags.slice(0, m).every((f) => f)) return [[0, 1]];
  const fr = controlFractions(points);
  const end = (i: number) => (i + 1 < m ? fr[i + 1] : 1);
  const out: Array<[number, number]> = [];
  // 壁でない間から数えはじめて、続いた壁をひとまとめに
  let s0 = 0;
  while (s0 < m && flags[s0]) s0++;
  let from = -1;
  let last = -1;
  for (let k = 1; k <= m; k++) {
    const i = (s0 + k) % m;
    if (flags[i]) {
      if (from < 0) from = i;
      last = i;
    } else if (from >= 0) {
      out.push([round4(fr[from]), round4(end(last))]);
      from = -1;
    }
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** 細かい直し: 近すぎる点を消す・数を丸める・幅を決まりの中へ。曲がりのきつさは直さない (知らせるだけ) */
export function tidyTrack(def: TrackDef): TrackDef {
  const L = TRACK_LIMITS;
  const pts: Array<[number, number]> = [];
  for (const p of def.points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q: [number, number] = [round1(p[0]), round1(p[1])];
    const last = pts[pts.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < L.minPointGap) continue;
    pts.push(q);
  }
  while (pts.length > L.minPoints) {
    const a = pts[pts.length - 1];
    if (Math.hypot(a[0] - pts[0][0], a[1] - pts[0][1]) >= L.minPointGap) break;
    pts.pop();
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  const walls = (def.walls ?? [])
    .filter((w) => w.length === 2 && Number.isFinite(w[0]) && Number.isFinite(w[1]))
    .map(([a, b]) => [clamp(a, 0, 1), clamp(b, 0, 1)] as [number, number]);
  return {
    ...def,
    name: (def.name ?? "").trim().slice(0, L.maxName),
    points: pts,
    halfWidth: clamp(def.halfWidth, L.minHalfWidth, L.maxHalfWidth),
    runoff: clamp(def.runoff, L.minRunoff, L.maxRunoff),
    ...(walls.length ? { walls } : { walls: undefined }),
  };
}
