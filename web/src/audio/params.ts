// 車の様子 → 音の数 (エンジンの高さ・左右・ぶつかりの強さ など)。音の道具には触らない純粋な計算 (試験あり)。
// 毎こま呼ぶので、答えは渡された入れ物 (out) に書き、新しいものを作らない。数は全部 仮。

export interface EngineOut {
  /** 段 (1..GEARS) */
  gear: number;
  /** 回転の割合 0..1 */
  rpm: number;
  /** 基本の音の高さ (Hz) */
  freq: number;
  /** こもり具合 (低域を通す線の Hz) */
  cutoff: number;
  /** 大きさ 0..1 */
  gain: number;
}

export const GEARS = 7;
/** 段の切れ目 (最高速に対する割合)。低い段ほど短い (仮) */
const GEAR_TOP = [0.14, 0.27, 0.4, 0.53, 0.67, 0.82, 1.0];
const IDLE_RPM = 0.16;
/** 上の段に入ったあとの回転 (仮) */
const SHIFT_RPM = 0.58;
const F_LOW = 32;
const F_HIGH = 186;

export function newEngineOut(): EngineOut {
  return { gear: 1, rpm: IDLE_RPM, freq: F_LOW, cutoff: 300, gain: 0.3 };
}

/** 速さ (m/s)・最高速 (m/s)・アクセル (0..1) から、エンジンの音の数を out に書く */
export function engineParams(speed: number, top: number, throttle: number, out: EngineOut): EngineOut {
  const thr = clamp01(throttle);
  const r = Math.max(0, Math.min(1.08, Math.abs(speed) / Math.max(1, top)));
  let g = 0;
  while (g < GEARS - 1 && r > GEAR_TOP[g]) g++;
  const lo = g === 0 ? 0 : GEAR_TOP[g - 1];
  const hi = GEAR_TOP[g];
  const frac = Math.max(0, Math.min(1.05, (r - lo) / (hi - lo)));
  let rpm = g === 0 ? IDLE_RPM + (1 - IDLE_RPM) * frac : SHIFT_RPM + (1 - SHIFT_RPM) * frac;
  // 止まっている・ゆっくりのときはアクセルで空ぶかし (速さとともに薄め、音が下がらないように)
  if (r < 0.1) rpm += thr * 0.42 * (1 - r / 0.1);
  rpm = Math.min(1.04, rpm);
  out.gear = g + 1;
  out.rpm = rpm;
  out.freq = F_LOW + (F_HIGH - F_LOW) * rpm;
  out.cutoff = 260 + rpm * 1100 + thr * 2300;
  out.gain = Math.min(1, 0.32 + thr * 0.42 + rpm * 0.26);
  return out;
}

/**
 * マニュアル (自分で変速) の自分の車: 本当の段 (1..7) と回転の割合 (gearbox.ts の rpmFraction) から音の数を out に書く。
 * 音の高さの幅は engineParams と同じ
 */
export function engineParamsGear(gear: number, rpmFrac: number, speed: number, throttle: number, out: EngineOut): EngineOut {
  const thr = clamp01(throttle);
  let rpm = IDLE_RPM + (1 - IDLE_RPM) * Math.max(0, Math.min(1.04, rpmFrac));
  // 止まりかけはアクセルで空ぶかし (engineParams と同じ)
  if (Math.abs(speed) < 3) rpm += thr * 0.42 * (1 - Math.abs(speed) / 3);
  rpm = Math.min(1.04, rpm);
  out.gear = Math.max(1, Math.min(GEARS, Math.round(gear)));
  out.rpm = rpm;
  out.freq = F_LOW + (F_HIGH - F_LOW) * rpm;
  out.cutoff = 260 + rpm * 1100 + thr * 2300;
  out.gain = Math.min(1, 0.32 + thr * 0.42 + rpm * 0.26);
  return out;
}

export interface SpatialOut {
  /** -1 (左) .. 1 (右) */
  pan: number;
  /** 0..1 */
  gain: number;
  dist: number;
}

/** 聞こえなくなる遠さ (m、仮) */
export const HEAR_MAX = 140;
/** この遠さで半分の大きさ (m、仮) */
const HALF_DIST = 16;

export function newSpatialOut(): SpatialOut {
  return { pan: 0, gain: 0, dist: 0 };
}

/**
 * 音の出どころ (カメラからの差 dx, dy、m) を、画面の左右と大きさにする。
 * 画面は車の向き camH が上になるように回っている (view.ts の ctx.rotate(-π/2 - camH))。
 * 画面の右 = 世界の (-sin camH, cos camH)
 */
export function spatial(dx: number, dy: number, camH: number, out: SpatialOut): SpatialOut {
  const d = Math.hypot(dx, dy);
  const sx = -dx * Math.sin(camH) + dy * Math.cos(camH);
  out.dist = d;
  out.pan = Math.max(-0.85, Math.min(0.85, sx / (d + 6)));
  out.gain = d >= HEAR_MAX ? 0 : (1 / (1 + (d / HALF_DIST) ** 2)) * (1 - d / HEAR_MAX);
  return out;
}

/**
 * いちばん近い n 台を選ぶ (遠い順ではなく近い順に outIdx へ番号を書く)。返すのは選んだ数。
 * xs/ys は count 台ぶん。HEAR_MAX より遠い車は選ばない
 */
export function pickNearest(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number, cx: number, cy: number, n: number, outIdx: Int32Array, outD: Float32Array): number {
  let k = 0;
  for (let i = 0; i < count; i++) {
    const d = Math.hypot(xs[i] - cx, ys[i] - cy);
    if (d >= HEAR_MAX) continue;
    // 挿し入れ (n は小さい)
    let j = k < n ? k : n;
    if (j === n && d >= outD[n - 1]) continue;
    if (j === n) j = n - 1;
    while (j > 0 && outD[j - 1] > d) {
      outD[j] = outD[j - 1];
      outIdx[j] = outIdx[j - 1];
      j--;
    }
    outD[j] = d;
    outIdx[j] = i;
    if (k < n) k++;
  }
  return k;
}

/** ぶつかりの強さ (m/s) → 音の大きさ 0..1。thr より弱ければ 0 */
export function impactLevel(strength: number, thr: number): number {
  if (!(strength > thr)) return 0;
  return Math.min(1, Math.sqrt((strength - thr) / 14));
}

/** タイヤのきしみ 0..1: 横滑り (m/s)・強いブレーキ・速さ・路面 (0 道 / 1 縁石 / 2 芝)・濡れ (0..1) */
export function squealLevel(slip: number, brake: number, speed: number, surface: number, wet: number): number {
  if (surface === 2 || speed < 4) return 0;
  const s = clamp01((slip - 1.4) / 3.6);
  const b = brake > 0.55 && speed > 14 ? ((brake - 0.55) / 0.45) * Math.min(1, speed / 45) * 0.55 : 0;
  return clamp01(Math.max(s, b) * (1 - 0.75 * clamp01(wet)));
}

/** 縁石のがたがたの速さ (Hz): 赤白の縞 1 つ 1.2 m (仮) */
export function rumbleHz(speed: number): number {
  return Math.max(8, Math.min(70, Math.abs(speed) / 1.2));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---- ほかの車のきしみ・ぶつかり、旗・ゴール・周・ピットの合図 (11/25 足した。数は全部 仮) ----

/** 横滑りの速さ (m/s): 速さ (vx, vy) のうち、車の向き h に直角な分 */
export function lateralSlip(vx: number, vy: number, h: number): number {
  return Math.abs(-Math.sin(h) * vx + Math.cos(h) * vy);
}

/** ほかの車のぶつかりとみなす速さの減り方 (m/s²、仮。ブレーキの一番強いところより大きく) */
export const OTHER_HIT_DECEL = 70;

/**
 * ほかの車の速さが前の snap から dt 秒で prev → now に落ちた。
 * ブレーキでは出ない減り方ならぶつかり → 強さ (m/s、落ちた分)。そうでなければ 0
 */
export function otherHitStrength(prev: number, now: number, dt: number): number {
  if (!(dt > 0) || !(prev > now)) return 0;
  const drop = prev - now;
  return drop / Math.max(dt, 0.05) > OTHER_HIT_DECEL ? drop : 0;
}

/** 旗の重さ: 0 緑 / 1 黄旗 (どこかの区間) / 2 VSC / 3 SC */
export function flagLevel(mode: string | null | undefined, yellows: number): number {
  return mode === "sc" ? 3 : mode === "vsc" ? 2 : yellows > 0 ? 1 : 0;
}

export type FlagCue = "none" | "yellow" | "vsc" | "sc" | "green";
const FLAG_CUES: readonly FlagCue[] = ["green", "yellow", "vsc", "sc"];

/** 旗の重さが prev → now に変わったときの合図。重くなった = その旗の音・緑に戻った = 緑の音・軽くなっただけ = なし。prev < 0 (はじめ) はなし */
export function flagCue(prev: number, now: number): FlagCue {
  if (prev < 0 || prev === now) return "none";
  if (now > prev) return FLAG_CUES[Math.min(3, now)];
  return now === 0 ? "green" : "none";
}

export type LapChime = "none" | "pb" | "session";

/**
 * 周を走り終えたときの合図: 自分の前の一番 (prevBest) より速い = 自己ベスト (紫)。
 * そのうえ、ほかの車の一番速い周 (rivalBest、なし = Infinity) より速い = その場の一番。
 * はじめの周 (前の一番なし) は、ほかの車より速いときだけ鳴らす
 */
export function lapChime(time: number, valid: boolean, prevBest: number | null, rivalBest: number): LapChime {
  if (!valid || !(time > 0)) return "none";
  if (prevBest !== null && time >= prevBest) return "none";
  if (Number.isFinite(rivalBest) && time < rivalBest) return "session";
  return prevBest !== null ? "pb" : "none";
}

/**
 * タイヤ交換の締め具 (ホイールガン) の音の時刻 (止まってからの秒) を out に書き、数を返す。
 * 前半 = 外す (1 輪ずつ少しずらす)、後半 = 締める (タイヤの作業の終わりの少し前)。tireSec = タイヤの作業の秒 (0 = 替えない)
 */
export function wheelGunTimes(tireSec: number, wheels: number, out: Float32Array): number {
  if (!(tireSec > 0)) return 0;
  const n = Math.max(1, Math.min(Math.floor(out.length / 2), Math.round(wheels) || 4));
  const gap = Math.min(0.12, tireSec / (4 * n));
  for (let i = 0; i < n; i++) {
    const off = 0.15 + i * gap;
    out[i] = off;
    out[n + i] = Math.max(off + 0.3, tireSec - 0.35 - (n - 1 - i) * gap);
  }
  return n * 2;
}

/** 燃料のホースの音が鳴っているか: 止まって少ししてから、燃料の作業の秒 (fuelSec) まで */
export function fuelHissOn(pitT: number, fuelSec: number): boolean {
  return fuelSec > 0 && pitT >= 0.25 && pitT < fuelSec;
}
