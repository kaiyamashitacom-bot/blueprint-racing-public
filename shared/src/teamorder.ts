// チームの 2 台目 (雇った運転手) への作戦の合図 (11/25「2 台目への作戦の合図」)。
// 人がレース中に送る: ピットに入れ・タイヤを持たせろ・攻めろ・前を譲れ。部屋 (room.ts) が 2 台目の頭 (BotBrain) と車の倍率を変える。
// 数は仮
import type { BotBrain } from "./bot.ts";
import type { CarState } from "./physics.ts";

export type TeamOrder = "pit" | "save" | "push" | "yield" | "none";

/** 画面のボタンの順 */
export const TEAM_ORDERS = ["pit", "save", "push", "yield"] as const satisfies readonly TeamOrder[];

export const TEAM_ORDER_TEXT: Record<TeamOrder, string> = {
  pit: "ピットに入れ",
  save: "タイヤを持たせろ",
  push: "攻めろ",
  yield: "前を譲れ",
  none: "ふつうに走れ",
};

/** 合図が効く数 (仮) */
export const TEAM_ORDER = {
  /** タイヤを持たせろ: 曲がりで使う握りの割合 × pace・すり減り × wear・燃料 × fuel */
  save: { pace: 0.94, wear: 0.8, fuel: 0.93 },
  /** 攻めろ: 抜きの強さ × aggression・すり減り × wear・ミス × mistake */
  push: { aggression: 1.5, wear: 1.12, mistake: 1.25 },
  /** 前を譲れ: 相方がこの距離 (m) 以内の後ろにいたら、相方の速さ × capFactor (最低 minCap m/s) まで落とす。timeoutS 秒で終わる */
  yield: { behindM: 45, capFactor: 0.85, minCap: 12, timeoutS: 30 },
};

export function isTeamOrder(v: unknown): v is TeamOrder {
  return v === "pit" || v === "save" || v === "push" || v === "yield" || v === "none";
}

/** 合図の前の数 (合図を変えたら ここへ戻す) */
export interface TeamOrderBase {
  passAggression: number;
  mistakeScale: number;
  wearScale: number;
  fuelScale: number;
}

export function teamOrderBase(brain: BotBrain, car: CarState): TeamOrderBase {
  return { passAggression: brain.passAggression ?? 1, mistakeScale: brain.mistakeScale ?? 1, wearScale: car.wearScale ?? 1, fuelScale: car.fuelScale ?? 1 };
}

/**
 * 合図を頭と車に入れる。pit は次に入れる周で入る (入ったら bot.ts が消す)。
 * save / push は次の合図まで続く。yield は yieldSpeedCap で効く (部屋が相方の位置を見る)
 */
export function applyTeamOrder(brain: BotBrain, car: CarState, order: TeamOrder, base: TeamOrderBase): void {
  brain.paceScale = order === "save" ? TEAM_ORDER.save.pace : undefined;
  brain.passAggression = base.passAggression * (order === "push" ? TEAM_ORDER.push.aggression : 1);
  brain.mistakeScale = base.mistakeScale * (order === "push" ? TEAM_ORDER.push.mistake : 1);
  car.wearScale = base.wearScale * (order === "save" ? TEAM_ORDER.save.wear : order === "push" ? TEAM_ORDER.push.wear : 1);
  car.fuelScale = base.fuelScale * (order === "save" ? TEAM_ORDER.save.fuel : 1);
  brain.forcePit = order === "pit" ? true : undefined;
}

/**
 * 前を譲れ: 相方 (人の車) がすぐ後ろにいれば 落とす速さ (m/s)。いなければ undefined。
 * dist は 1 周目からの道のり (同じ周の前後だけを見る)
 */
export function yieldSpeedCap(me: CarState, mate: { dist: number; vx: number; vy: number; pit?: boolean } | null): number | undefined {
  if (!mate || mate.pit || me.pit) return undefined;
  const gap = me.dist - mate.dist;
  if (gap <= 0 || gap > TEAM_ORDER.yield.behindM) return undefined;
  return Math.max(TEAM_ORDER.yield.minCap, Math.hypot(mate.vx, mate.vy) * TEAM_ORDER.yield.capFactor);
}

/** 前を譲れが済んだ (相方が前に出た) */
export function yieldDone(me: CarState, mate: { dist: number } | null): boolean {
  return !!mate && mate.dist > me.dist + 3;
}
