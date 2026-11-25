// 変速 (ギア、7 段) のしくみ (DECISIONS 11/25「パソコンだけ『マニュアル』を選べる」)。
// オートマ (ふつう・かんたん・コンピューター・代走) は今までの式のまま = いつも一番よい段に入っている、とみなす。
//   ここで出す段と回転は 画面と音のためだけ (速さは変わらない)。
// マニュアル (パソコンだけ): 人が段を選ぶ (CarInput.gear)。車の速さ (最高速と加速) が manualSpeedBonus (管理者の数、はじめ 3%) だけ上がる:
//   力 × (1 + b)、空気の抵抗 ÷ (1 + b)² (最高速がちょうど × (1 + b))。握りで決まる加速・曲がり・ブレーキは同じ。
//   - 回しすぎ (回転が 1 以上): 力が切れる (頭打ち。速さはその段の上限で止まる)
//   - 段が高すぎて回転が低い (2 速から上で LUG_RPM より下): 加速が鈍い
//   上手に変えれば上がり分を全部使え、下手だと減る。数は全部 (仮)。
import type { CarStats } from "./design.ts";

/** 段の数 */
export const GEAR_COUNT = 7;
/** マニュアルの速さの上がり分のはじめの値 (AdminConfig.manualSpeedBonus) と幅 */
export const DEFAULT_MANUAL_BONUS = 0.03;
export const MANUAL_BONUS_MAX = 0.3;
/** となりの段の速さの比 (上の段は 1.3 倍まで回る) */
export const GEAR_STEP = 1.3;
/** 7 速の回しきりの速さ = マニュアルの最高速 × これ (DRS・風よけ・オーバーテイクで最高速を超えても回しきらない) */
export const GEAR_TOP_HEADROOM = 1.2;
/** 回転がこれより低いと (2 速から上) 力が落ちる。一番低いときの力の割合 */
export const LUG_RPM = 0.55;
export const LUG_MIN = 0.3;
/** 変えどき (画面の回転の目盛りが光る回転)。オートマの見た目の段もここで上げる */
export const SHIFT_RPM = 0.94;
/** 画面の回転の数 (見た目だけ): 回しきり と 一番低い所 */
export const REDLINE_RPM = 12000;
export const IDLE_RPM = 3800;

/** 段 gear (1..7) の回しきりの速さ (m/s)。bonus = マニュアルの上がり分 (オートマの見た目は 0) */
export function gearTopSpeed(stats: Pick<CarStats, "topSpeed">, gear: number, bonus = 0): number {
  const g = clampGear(gear);
  return (Math.max(10, stats.topSpeed) * (1 + bonus) * GEAR_TOP_HEADROOM) / GEAR_STEP ** (GEAR_COUNT - g);
}

/** 回転の割合 (1 = 回しきり) */
export function rpmFraction(speed: number, gear: number, stats: Pick<CarStats, "topSpeed">, bonus = 0): number {
  return Math.abs(speed) / gearTopSpeed(stats, gear, bonus);
}

/** 回転の割合 → 力の割合。1 以上 = 回しきりで力が切れる (0)・低すぎ = 鈍い (1 速は半クラッチでいつも 1) */
export function gearPowerFactor(rpm: number, gear: number): number {
  if (rpm >= 1) return 0;
  if (clampGear(gear) <= 1 || rpm >= LUG_RPM) return 1;
  const k = Math.max(0, rpm) / LUG_RPM;
  return LUG_MIN + (1 - LUG_MIN) * k * k;
}

/** 速さに合う段 (回転が SHIFT_RPM より低い一番低い段)。オートマの見た目の段と、上手な人の選び方 */
export function idealGear(speed: number, stats: Pick<CarStats, "topSpeed">, bonus = 0, shiftAt = SHIFT_RPM): number {
  for (let g = 1; g < GEAR_COUNT; g++) if (rpmFraction(speed, g, stats, bonus) < shiftAt) return g;
  return GEAR_COUNT;
}

/** 画面の回転 (rpm、見た目だけ) */
export function displayRpm(rpm: number): number {
  return Math.round(IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * Math.max(0, Math.min(1.02, rpm)));
}

export function clampGear(g: number): number {
  return Number.isFinite(g) ? Math.max(1, Math.min(GEAR_COUNT, Math.round(g))) : 1;
}

/** マニュアルの上がり分を確かめる (読めなければ はじめの値) */
export function cleanManualBonus(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MANUAL_BONUS_MAX ? v : DEFAULT_MANUAL_BONUS;
}

/**
 * マニュアルの回転と力に効く上がり分 = 管理者の数 (manualSpeedBonus) + ギア箱の部品 (CarStats.shiftBonus)。
 * physics.ts と 画面の回転計・音で同じ数を使う (前は画面がギア箱の分を入れず 約 2% ずれていた)
 */
export function manualShiftBonus(stats: Pick<CarStats, "shiftBonus">, manualBonus?: unknown): number {
  return cleanManualBonus(manualBonus) + (stats.shiftBonus ?? 0);
}

/** マニュアルの車の性能 (最高速の見積もりなど、確かめに使う): 力 × (1 + b)、空気の抵抗 ÷ (1 + b)²、最高速 × (1 + b) */
export function manualStats<T extends Pick<CarStats, "power" | "dragK" | "topSpeed">>(stats: T, bonus: number): T {
  const b = Math.max(0, bonus);
  if (!(b > 0)) return stats;
  return { ...stats, power: stats.power * (1 + b), dragK: stats.dragK / (1 + b) ** 2, topSpeed: stats.topSpeed * (1 + b) };
}
