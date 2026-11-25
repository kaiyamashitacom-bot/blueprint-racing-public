// レースの賞金 (仮)。点に応じたお金 + 完走のごほうび。長いレースほど多く、人が自分 1 人 (ほかは全部 CPU) だと少なめ
// 決めごと: 「コンピューターと走っても賞金と点は入る (少なめ)」「レースでお金はかからない」
import type { ResultRow } from "./protocol.ts";

/** 1 点あたりのお金 (仮) */
export const PRIZE_PER_POINT = 20;
/** 完走のごほうび (仮) */
export const PRIZE_FINISH = 30;
/** 人が自分 1 人のレース (ほかは全部 CPU) の割合 (仮) */
export const PRIZE_CPU_ONLY_RATE = 0.5;

/** 部屋が結果を決めたときに、人の車ごとに知らせる中身 */
export interface RacePayoutRow {
  /** 部屋の中の id */
  id: string;
  /** つなぎ直しの印 (hello の key) */
  key: string;
  pos: number;
  points: number;
  finished: boolean;
}

export interface RaceReport {
  laps: number;
  trackId: string;
  /** レースに出た人の数 (通信が切れて CPU が代わりに走った人も数える) */
  humans: number;
  cars: number;
  rows: RacePayoutRow[];
}

/** 周の数の倍率: 2 周 = 1、5 周 = 1.75、10 周 = 3 */
export function lapsFactor(laps: number): number {
  return 0.5 + Math.max(1, laps) * 0.25;
}

/** 1 台の賞金 */
export function racePrize(row: { points: number; finished: boolean }, race: { laps: number; humans: number }): number {
  const base = row.points * PRIZE_PER_POINT + (row.finished ? PRIZE_FINISH : 0);
  const rate = race.humans <= 1 ? PRIZE_CPU_ONLY_RATE : 1;
  return Math.max(0, Math.round(base * lapsFactor(race.laps) * rate));
}

/** 部屋の結果から、人の車だけの知らせを作る (keyOf = 部屋の id → hello の key) */
export function raceReport(results: ResultRow[], keyOf: (id: string) => string, laps: number, trackId: string): RaceReport {
  const humans = results.filter((r) => !r.bot);
  return {
    laps,
    trackId,
    humans: humans.length,
    cars: results.length,
    rows: humans.map((r) => ({ id: r.id, key: keyOf(r.id), pos: r.pos, points: r.points, finished: r.finished })),
  };
}
