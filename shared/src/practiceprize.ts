// 練習の賞金 (DECISIONS「練習は少しだけ。つながっている間にサーバーが確かめた周だけ」、AdminConfig.practicePrizePerLap)。
// ログインして練習で走り終えた周 (正しい周) を、画面が 1 周アタックと同じ形 (周の秒と幽霊) で送る。
// サーバーは 1 周アタックと同じ安い確かめ (timeattack.ts の checkTaSubmission: コースと幽霊の点を 1 回なめるだけ) をして、
// 通った周ごとに 1 日 (日本時間) の周の上限 (practicePrizeDailyLaps) まで払う。
// 練習の条件 (天気・タイヤ・燃料は自由) でも同じ確かめでよい: 1 周の下限は「晴れ・柔らかい新品・燃料なしの軽さの押しつけ」の
// 一番速い条件で見積もり、雨用のタイヤ (と雨に強い特徴) の濡れた路面の握りも 柔らかいタイヤの乾いた路面より小さいので、
// 雨の周・燃料の少ない周も下限より遅い (試験で確かめる)。速さの上限 (幽霊) は力と空気の抵抗だけで決まるので天気に関係ない。
// 数は全部 (仮)。
import type { AdminConfig } from "./adminconfig.ts";
import type { CarStats } from "./design.ts";
import type { Inventory } from "./inventory.ts";
import { checkTaSubmission, type TaSubmission } from "./timeattack.ts";
import type { Track } from "./track.ts";
import { isOfficialTrackId, isPublicTrackId } from "./tracks.ts";

/** 1 人が 1 時間に送れる回数 (仮。1 周は 30 秒より長いので、ふつうに走って届かない数) */
export const PRACTICE_SUBMIT_PER_HOUR = 150;

/** 賞金の出るコース: 公式のコースと みんなのコース ("pub:<n>")。自分で作っただけのコース (この機械の中) は出ない */
export function practicePrizeTrackOk(trackId: unknown): trackId is string {
  return typeof trackId === "string" && trackId.length <= 40 && (isOfficialTrackId(trackId) || isPublicTrackId(trackId));
}

/**
 * 練習の 1 周の確かめ (だめなら理由)。1 周アタックと同じ確かめ (設計図・持ち物・1 周の下限・幽霊)。
 * stats = computeStats(design, 部品の強さの倍率)。mtBonus = マニュアルの速さの上がり分 (AdminConfig.manualSpeedBonus)
 */
export function checkPracticeLap(sub: TaSubmission, stats: CarStats, track: Track, inventory: Inventory | null, mtBonus?: number): string | null {
  return checkTaSubmission(sub, stats, track, inventory, mtBonus);
}

/** その日にもう paidLaps 周払ったあとの、次の 1 周の賞金と 残りの周 (その周を払ったあと) */
export function practiceLapPay(cfg: Readonly<Pick<AdminConfig, "practicePrizePerLap" | "practicePrizeDailyLaps">>, paidLaps: number): { amount: number; left: number } {
  const cap = Math.max(0, Math.floor(cfg.practicePrizeDailyLaps));
  const done = Math.max(0, Math.floor(paidLaps));
  if (done >= cap || !(cfg.practicePrizePerLap > 0)) return { amount: 0, left: Math.max(0, cap - done) };
  return { amount: Math.floor(cfg.practicePrizePerLap), left: cap - done - 1 };
}
