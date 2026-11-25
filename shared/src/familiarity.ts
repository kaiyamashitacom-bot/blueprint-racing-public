// コンピューターも慣れる (DECISIONS 11/25「コンピューターも慣れる」)。
// コースごとの慣れ (0..1): 1 回走るごとに残りの 10% ずつ 1 に近づき、走らないと 7 日で半分に戻る (なめらかに減る)。
// 慣れは上手さ (bot.ts の BotBrain.skill) に足す: 雇った運転手・コンピューターのチームは最大 +0.02、代走は最大 +0.05。
// JSON にそのまま残せる形。時刻はいつも外から ms で渡す。数は全部 (仮)。
import type { BotBrain } from "./bot.ts";

export const FAMILIARITY = {
  /** 1 回走るごとに、残り (1 - 慣れ) のこの割合だけ近づく */
  gainPerRace: 0.1,
  /** 走らないと、この時間で半分に戻る (ms) */
  halfLifeMs: 7 * 24 * 3600_000,
  /** 慣れ 1 のときに上手さに足す分 (雇った運転手・コンピューターのチーム) */
  maxSkillBonus: 0.02,
  /** 代走 (本人の車をコンピューターが走らせる) の慣れ 1 のときの足し分 */
  standInMaxBonus: 0.05,
  /** これより小さい慣れは 0 とみなす (残しておく行を減らす) */
  floor: 0.001,
} as const;

/** あるコースの慣れ: v は at の時刻の値 */
export interface Familiarity {
  v: number;
  at: number;
}

/** コースの id → 慣れ */
export type FamiliarityMap = Record<string, Familiarity>;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 今 (now) の慣れ (0..1)。走らない時間だけ半分ずつ戻る */
export function familiarityAt(f: Familiarity | null | undefined, now: number): number {
  if (!f || !Number.isFinite(f.v)) return 0;
  const idle = Math.max(0, now - f.at);
  const v = clamp01(f.v) * 0.5 ** (idle / FAMILIARITY.halfLifeMs);
  return v < FAMILIARITY.floor ? 0 : v;
}

/** 1 回走ったあと (今の値に、残りの gainPerRace を足す) */
export function familiarityAfterRace(f: Familiarity | null | undefined, now: number): Familiarity {
  const cur = familiarityAt(f, now);
  return { v: cur + (1 - cur) * FAMILIARITY.gainPerRace, at: now };
}

/** 慣れから上手さに足す分 (standIn = 代走) */
export function familiaritySkillBonus(v: number, standIn = false): number {
  return clamp01(v) * (standIn ? FAMILIARITY.standInMaxBonus : FAMILIARITY.maxSkillBonus);
}

/** 地図から今の値だけ (部屋に渡す形: コースの id → 0..1) */
export function familiarityNow(map: Readonly<FamiliarityMap>, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [track, f] of Object.entries(map)) {
    const v = familiarityAt(f, now);
    if (v > 0) out[track] = Math.round(v * 1e4) / 1e4;
  }
  return out;
}

/** 地図のそのコースを 1 回走ったことにする (新しい地図を返す) */
export function recordFamiliarity(map: Readonly<FamiliarityMap>, trackId: string, now: number): FamiliarityMap {
  return { ...map, [trackId]: familiarityAfterRace(map[trackId], now) };
}

/** 頭 (BotBrain) の上手さに慣れを足す (1 を超えない)。頭そのものを書きかえて返す */
export function applyFamiliarity(brain: BotBrain, v: number, standIn = false): BotBrain {
  brain.skill = Math.min(1, brain.skill + familiaritySkillBonus(v, standIn));
  return brain;
}
