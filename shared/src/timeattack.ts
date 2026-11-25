// 1 周アタック (DECISIONS の作る順番 4 の追加): 毎週お題のコースを、好きなときに走ってタイムを残す。
// 上位の人の幽霊 (走った線だけ) と並んで走れる。ほかの人の設計図は見せない。8 人そろわなくても競えるようにするためのもの。
// ここは画面とサーバーの両方で使う、決まった計算だけ (時刻は ms で受け取り、中で Date.now() は呼ばない)。
// サーバーで長い計算をしない (Cloudflare の無料の枠の CPU の上限): 確かめは コースの点と幽霊の点を 1 回ずつなめるだけ。
// 数はすべて (仮)。
import { validateDesign, type CarDesign, type CarStats } from "./design.ts";
import { DRS_DRAG } from "./drs.ts";
import { DEFAULT_MANUAL_BONUS } from "./gearbox.ts";
import { designFits, type Inventory } from "./inventory.ts";
import { anyPartDef } from "./research.ts";
import { seasonIndexAt, seasonWindow, SEASON_EPOCH_MS } from "./season.ts";
import { NO_TIRE_MODS, tireGrip, type TireCompound } from "./tires.ts";
import { queryTrack, type Track, type TrackDef } from "./track.ts";
import { rotationTrackDefs, TRACK_DEFS } from "./tracks.ts";

// ---------------------------------------------------------------- 決まり (仮)

/** 走る条件 (仮): 晴れ・柔らかい (S) の新品・満タン。全員同じにして比べやすく */
export const TA_CONDITIONS: Readonly<{ sky: "sun"; tire: TireCompound; wear: number; fuel: "full" }> = { sky: "sun", tire: "S", wear: 0, fuel: "full" };
/** 1 回の走りで数える周 (仮): スタートからの周 + 勢いのついた周 2 つ。タイヤが減りすぎないうちに終える */
export const TA_RUN_LAPS = 3;
/** 順位表に出す数 (仮) */
export const TA_TOP_N = 20;
/** 一度に取れる幽霊の数 (仮) */
export const TA_GHOSTS_MAX = 5;
/** 幽霊の点の間隔 (秒)。レースの画面 (race/view.ts) の記録と同じ */
export const TA_GHOST_DT = 0.1;
/** 受け付ける 1 周の上限 (秒、仮) */
export const TA_MAX_LAP = 300;
/** 週が変わったあとも、前の週の記録を受け付ける時間 (ms、仮)。週の終わりぎりぎりに走り終えた人のため */
export const TA_SUBMIT_GRACE_MS = 10 * 60_000;
/** 1 人が 1 時間に送れる回数 (仮) */
export const TA_SUBMIT_PER_HOUR = 120;

/** 下限の見積もり (仮): 曲がり具合をならす幅 (前後 m)・曲がりをゆるく見る倍率・全体に掛ける割合 */
export const TA_FLOOR_CURV_WINDOW = 25;
export const TA_FLOOR_CURV_FACTOR = 0.8;
export const TA_FLOOR_RATIO = 0.95;
/** 幽霊の確かめ (仮) */
export const TA_GHOST_SPEED_SLACK = 1.1; // 速さの上限に掛ける余裕
export const TA_GHOST_ROUND_SLACK = 0.3; // 点の丸め (0.1 m) の分の余裕 (m)
export const TA_GHOST_EDGE_SLACK = 3; // コースの外 (芝・砂利の外の壁) からはみ出してよい幅 (m)
export const TA_GHOST_COUNT_SLACK = 3; // 点の数のずれの余裕 (個)
export const TA_GHOST_START_TOL = 40; // 最初の点とスタートの線の距離の上限 (m)
export const TA_GHOST_PROGRESS_TOL = 0.08; // コースに沿って進んだ距離のずれ (割合)
export const TA_GHOST_PATH_MIN = 0.85; // 走った線の長さ ÷ コースの長さ の下限
export const TA_GHOST_PATH_MAX = 1.25; // 同じく上限

// ---------------------------------------------------------------- 今週のコース

export interface TaWeek {
  /** 週の番号 (季節と同じ。月曜 0:00 日本時間に変わる) */
  index: number;
  trackId: string;
  trackName: string;
  startsAt: number;
  /** この時刻からは次の週 */
  endsAt: number;
}

/** 週の番号から、その週のコース (公式コースを順に回す) */
export function taTrackFor(index: number, defs: readonly TrackDef[] = TRACK_DEFS): TrackDef {
  const n = defs.length;
  return defs[((index % n) + n) % n];
}

export function taWeek(index: number, epoch = SEASON_EPOCH_MS): TaWeek {
  const w = seasonWindow(index, epoch);
  // 週の始まりに回し方に入っているコースだけ (足したコースは先の週から。今の週は変わらない)
  const def = taTrackFor(index, rotationTrackDefs(w.startsAt));
  return { index, trackId: def.id, trackName: def.name, startsAt: w.startsAt, endsAt: w.endsAt };
}

/** 時刻 t (ms) の週 */
export function taWeekAt(t: number, epoch = SEASON_EPOCH_MS): TaWeek {
  return taWeek(seasonIndexAt(t, epoch), epoch);
}

/** 送られてきた週の番号を受け付けるか (今の週か、変わってすぐの前の週) */
export function taAcceptsWeek(week: number, now: number, epoch = SEASON_EPOCH_MS): boolean {
  const cur = taWeekAt(now, epoch);
  if (week === cur.index) return true;
  return week === cur.index - 1 && now < cur.startsAt + TA_SUBMIT_GRACE_MS;
}

/** のこり時間の短い言い方: 「3 日 4 時間」「5 時間 12 分」「12 分」 */
export function taLeftText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d} 日 ${h} 時間`;
  if (h > 0) return `${h} 時間 ${mm} 分`;
  return `${mm} 分`;
}

// ---------------------------------------------------------------- 1 周の下限

/**
 * 車がまっすぐで出せる速さの上限 (m/s)。羽根が全部落ちて DRS も開いた、一番空気の抵抗が小さいときで見る。
 * bonus = マニュアルの速さの上がり分 (gearbox.ts。最高速が × (1 + bonus)。オートマは 0)
 */
export function taSpeedCeiling(stats: CarStats, bonus = 0): number {
  if (!(stats.power > 0)) return 0;
  const wingDrag = (stats.layout ?? []).reduce((a, s) => a + (s.drag ?? 0), 0);
  const drag = Math.max(0.05, (stats.dragK - wingDrag) * DRS_DRAG);
  return Math.cbrt((stats.power * 1000) / drag) * (1 + Math.max(0, bonus));
}

/**
 * この車でこのコースを 1 周するのにかかる秒の下限 (これより速い周は受け付けない)。
 * 中心の線の曲がり具合を前後 TA_FLOOR_CURV_WINDOW m でならし、さらにゆるく見て (道幅を使う分)、
 * 握り (柔らかいタイヤの新品・燃料なしの軽さ・押しつけ) で回れる速さと、まっすぐの上限の小さいほうで走ったとする。
 * 加速と減速の時間は入れない (甘く見る)。コースの点を 1 回なめるだけ。
 * 見本の車たちでは、一番上手いコンピューター (bench.ts) の 6〜7 割になる (試験で確かめる)
 */
export function taLapFloor(stats: CarStats, track: Track, bonus = 0): number {
  const vTop = taSpeedCeiling(stats, bonus);
  if (!(vTop > 0)) return Infinity;
  const tm = stats.tireMods ?? NO_TIRE_MODS;
  const g = tireGrip({ tire: TA_CONDITIONS.tire, wear: 0, burst: false }, 0, tm) * tm.lat;
  const a0 = stats.gripAccel * g;
  const dk = (stats.downK * g) / Math.max(1, stats.dryMass);
  const n = track.n;
  const W = Math.max(1, Math.round(TA_FLOOR_CURV_WINDOW / track.step));
  const span = 2 * W + 1;
  // 輪なので前後をつないだ和で、ならした曲がり具合を出す
  let sum = 0;
  for (let j = -W; j <= W; j++) sum += track.curv[(((j % n) + n) % n)];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const k = (Math.abs(sum) / span) * TA_FLOOR_CURV_FACTOR;
    const den = k - dk;
    const v = den > 0 ? Math.min(vTop, Math.sqrt(a0 / den)) : vTop;
    t += track.step / v;
    sum += track.curv[(i + W + 1) % n] - track.curv[(((i - W) % n) + n) % n];
  }
  return t * TA_FLOOR_RATIO;
}

// ---------------------------------------------------------------- 送られてきた周の確かめ

/** 周の秒を確かめる (だめなら理由)。bonus = マニュアルの速さの上がり分 (オートマは 0) */
export function checkTaLap(lap: unknown, stats: CarStats, track: Track, bonus = 0): string | null {
  if (typeof lap !== "number" || !Number.isFinite(lap) || lap <= 0) return "タイムが読めません";
  if (lap > TA_MAX_LAP) return "タイムが長すぎます";
  if (lap < taLapFloor(stats, track, bonus)) return "この車では出せないタイムです";
  return null;
}

/**
 * 幽霊の点 ([x, y, 向き] が 0.1 秒ごと) が その周の走りとして筋が通っているか。
 * - 点の数が 周の秒 ÷ 0.1 とほぼ同じ
 * - となりの点との間が、その車の速さの上限で 0.1 秒に進める距離より短い
 * - どの点もコースの近く (芝・砂利の外の壁より内側)
 * - スタートの線の近くから始まり、コースに沿ってほぼ 1 周ぶん進んでいる
 * - 走った線の長さが コースの長さとだいたい同じ
 */
export function checkTaGhost(pts: unknown, lap: number, stats: CarStats, track: Track, bonus = 0): string | null {
  if (!Array.isArray(pts) || pts.length % 3 !== 0) return "幽霊が読めません";
  const n = pts.length / 3;
  const expect = lap / TA_GHOST_DT;
  if (Math.abs(n - expect) > TA_GHOST_COUNT_SLACK + expect * 0.01) return "幽霊の長さがタイムと合いません";
  if (n < 10) return "幽霊が短すぎます";
  for (const v of pts) if (typeof v !== "number" || !Number.isFinite(v)) return "幽霊が読めません";
  const step = taSpeedCeiling(stats, bonus) * TA_GHOST_DT * TA_GHOST_SPEED_SLACK + TA_GHOST_ROUND_SLACK;
  const def = track.def;
  const edge = Math.max(def.halfWidth + def.runoff, Math.abs(track.pit.laneD) + def.halfWidth) + TA_GHOST_EDGE_SLACK;
  const L = track.length;
  let hint = -1;
  let path = 0;
  let progress = 0;
  let prevS = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3] as number;
    const y = pts[i * 3 + 1] as number;
    const h = pts[i * 3 + 2] as number;
    if (Math.abs(h) > 10) return "幽霊が読めません";
    const q = queryTrack(track, x, y, hint);
    hint = q.index;
    if (Math.abs(q.d) > edge) return "幽霊がコースから外れています";
    if (i === 0) {
      if (q.s > TA_GHOST_START_TOL && q.s < L - TA_GHOST_START_TOL) return "幽霊がスタートの線から始まっていません";
    } else {
      const dx = x - (pts[i * 3 - 3] as number);
      const dy = y - (pts[i * 3 - 2] as number);
      const d = Math.hypot(dx, dy);
      if (d > step) return "幽霊の速さがこの車では出せません";
      path += d;
      let ds = q.s - prevS;
      if (ds > L / 2) ds -= L;
      else if (ds < -L / 2) ds += L;
      progress += ds;
    }
    prevS = q.s;
  }
  if (Math.abs(progress - L) > L * TA_GHOST_PROGRESS_TOL) return "幽霊が 1 周していません";
  if (path < L * TA_GHOST_PATH_MIN || path > L * TA_GHOST_PATH_MAX) return "幽霊の長さがコースと合いません";
  return null;
}

/** 設計図が仕上がっていて、持っている部品だけでできているか (inventory = null なら持ち物は見ない) */
export function checkTaDesign(design: CarDesign, inventory: Inventory | null): string | null {
  for (const p of design.parts) if (!anyPartDef(p.id)) return "知らない部品があります";
  const errs = validateDesign(design);
  if (errs.length) return `車が仕上がっていません (${errs[0]})`;
  if (inventory) {
    const fit = designFits(design, inventory);
    if (!fit.ok) return "持っていない部品を使っています";
  }
  return null;
}

export interface TaSubmission {
  lap: number;
  pts: number[];
  design: CarDesign;
  /** マニュアル (自分で変速) で走った (11/25 足した。なし = オートマ。速さの上限を上がり分だけゆるめる) */
  mt?: boolean;
}

/**
 * 送られてきた 1 周をまとめて確かめる (だめなら理由)。stats は computeStats(design)。
 * mtBonus = マニュアルの速さの上がり分 (AdminConfig.manualSpeedBonus)。mt の周だけ下限と速さの上限をその分ゆるめる
 */
export function checkTaSubmission(sub: TaSubmission, stats: CarStats, track: Track, inventory: Inventory | null, mtBonus = DEFAULT_MANUAL_BONUS): string | null {
  // ギア箱の部品 (stats.shiftBonus) はマニュアルの上がり分に足す (physics.ts と同じ)
  const bonus = sub.mt ? Math.max(0, mtBonus) + (stats.shiftBonus ?? 0) : 0;
  return checkTaDesign(sub.design, inventory) ?? checkTaLap(sub.lap, stats, track, bonus) ?? checkTaGhost(sub.pts, sub.lap, stats, track, bonus);
}

// ---------------------------------------------------------------- 順位

/** 周の秒を ms の整数に (同じ ms は同じタイム) */
export function taLapMs(lap: number): number {
  return Math.round(lap * 1000);
}

export interface TaEntry {
  lapMs: number;
  /** その記録を出した時刻 (ms)。同じタイムなら先に出したほうを上に並べる */
  at: number;
}

/** a のほうが上なら負 */
export function compareTa(a: TaEntry, b: TaEntry): number {
  return a.lapMs - b.lapMs || a.at - b.at;
}

/**
 * 速い順に並べて順位を付ける。同じタイム (ms) は同じ順位 (1・2・2・4)、並びは先に出した順
 */
export function rankTa<T extends TaEntry>(list: readonly T[]): Array<T & { rank: number }> {
  const sorted = [...list].sort(compareTa);
  const out: Array<T & { rank: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const prev = out[i - 1];
    const rank = prev && prev.lapMs === sorted[i].lapMs ? prev.rank : i + 1;
    out.push({ ...sorted[i], rank });
  }
  return out;
}

/** 自分より速い人の数から順位 (同じタイムは同じ順位) */
export function taRankOf(fasterCount: number): number {
  return fasterCount + 1;
}

/** 前の記録より速いか (同じ ms は速くない) */
export function taImproves(lap: number, prevLapMs: number | null | undefined): boolean {
  return prevLapMs === null || prevLapMs === undefined || taLapMs(lap) < prevLapMs;
}

// ---------------------------------------------------------------- 幽霊を小さくする

/**
 * 幽霊の点を短い文字列にする: x・y は 0.1 m、向きは 0.01 の整数にし、前の点との差を
 * 符号つきの可変長の整数で並べて base64url にする。JSON の数の並びの 3 分の 1 ほどになる
 */
export function encodeGhost(pts: readonly number[]): string {
  const bytes: number[] = [];
  const prev = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const k = i % 3;
    const v = Math.round(pts[i] * (k === 2 ? 100 : 10));
    const d = v - prev[k];
    prev[k] = v;
    // zigzag
    let z = d >= 0 ? d * 2 : -d * 2 - 1;
    do {
      let b = z % 128;
      z = Math.floor(z / 128);
      if (z > 0) b |= 128;
      bytes.push(b);
    } while (z > 0);
  }
  return `g1.${base64url(bytes)}`;
}

/** 戻す。読めなければ null。点の数の上限 maxPts (数の個数) を超えても null */
export function decodeGhost(s: unknown, maxPts = Math.ceil(TA_MAX_LAP / TA_GHOST_DT + 10) * 3): number[] | null {
  if (typeof s !== "string" || !s.startsWith("g1.")) return null;
  const bytes = unbase64url(s.slice(3));
  if (!bytes) return null;
  const out: number[] = [];
  const prev = [0, 0, 0];
  let z = 0;
  let mul = 1;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    z += (b & 127) * mul;
    if (b & 128) {
      mul *= 128;
      if (mul > 2 ** 35) return null;
      continue;
    }
    const d = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    const k = out.length % 3;
    prev[k] += d;
    out.push(prev[k] / (k === 2 ? 100 : 10));
    if (out.length > maxPts) return null;
    z = 0;
    mul = 1;
  }
  if (mul !== 1 || out.length % 3 !== 0) return null;
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INV: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]));

function base64url(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}

function unbase64url(s: string): number[] | null {
  if (s.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const v: number[] = [];
    for (let j = i; j < Math.min(i + 4, s.length); j++) {
      const x = B64_INV[s[j]];
      if (x === undefined) return null;
      v.push(x);
    }
    out.push((v[0] << 2) | (v[1] >> 4));
    if (v.length > 2) out.push(((v[1] & 15) << 4) | (v[2] >> 2));
    if (v.length > 3) out.push(((v[2] & 3) << 6) | v[3]);
  }
  return out;
}

// ---------------------------------------------------------------- 設計図の印

/** 設計図の印 (部品の並びだけ。置いた順と名前は見ない)。FNV-1a の 32 ビットを 16 進 8 桁で */
export function designHash(design: CarDesign): string {
  const key = design.parts
    .map((p) => `${p.id}@${p.c},${p.r},${p.rot}`)
    .sort()
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------- 幽霊の記録 (画面用)

/**
 * 毎こまの車の位置 (時刻・x・y・向き) を残し、周の区切りで 0.1 秒の目盛りちょうどに並べ直して幽霊にする。
 * レースの画面の幽霊の記録は「前の記録から 0.1 秒以上」で取るので、1/60 秒の刻みでは平均 0.11 秒ほどの間隔になり、
 * 再生 (0.1 秒ごと) と少しずれる。1 周アタックではこちらで記録して、時刻と点の数をきっちり合わせる
 */
export class TaGhostRecorder {
  private t: number[] = [];
  private x: number[] = [];
  private y: number[] = [];
  private h: number[] = [];

  push(t: number, x: number, y: number, h: number) {
    if (this.t.length && t <= this.t[this.t.length - 1]) return;
    this.t.push(t);
    this.x.push(x);
    this.y.push(y);
    this.h.push(h);
  }

  lastT(): number {
    return this.t.length ? this.t[this.t.length - 1] : -Infinity;
  }

  dropBefore(t: number) {
    let k = 0;
    while (k < this.t.length - 1 && this.t[k + 1] < t) k++;
    if (k > 0) {
      this.t.splice(0, k);
      this.x.splice(0, k);
      this.y.splice(0, k);
      this.h.splice(0, k);
    }
  }

  /** start から time 秒ぶんを 0.1 秒ごとに ([x, y, 向き] の並び。レースの画面の幽霊と同じ形) */
  ghost(start: number, time: number): number[] {
    const out: number[] = [];
    const n = Math.floor(time / TA_GHOST_DT + 1e-6) + 1;
    let j = 0;
    const T = this.t;
    for (let k = 0; k < n; k++) {
      const tt = start + k * TA_GHOST_DT;
      while (j < T.length - 2 && T[j + 1] < tt) j++;
      let x: number;
      let y: number;
      let h: number;
      if (!T.length) {
        x = y = h = 0;
      } else if (tt <= T[0]) {
        x = this.x[0];
        y = this.y[0];
        h = this.h[0];
      } else if (j + 1 >= T.length || tt >= T[T.length - 1]) {
        const e = T.length - 1;
        x = this.x[e];
        y = this.y[e];
        h = this.h[e];
      } else {
        const f = (tt - T[j]) / Math.max(1e-9, T[j + 1] - T[j]);
        x = this.x[j] + (this.x[j + 1] - this.x[j]) * f;
        y = this.y[j] + (this.y[j + 1] - this.y[j]) * f;
        let dh = this.h[j + 1] - this.h[j];
        if (dh > Math.PI) dh -= 2 * Math.PI;
        else if (dh < -Math.PI) dh += 2 * Math.PI;
        h = this.h[j] + dh * f;
        if (h > Math.PI) h -= 2 * Math.PI;
        else if (h < -Math.PI) h += 2 * Math.PI;
      }
      out.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(h * 100) / 100);
    }
    return out;
  }
}
