// 管理者が変えられる数 (賞金・部品の強さ・手数料など)。初めの値と確かめ。数は全部 (仮)。
// server は AdminConfig を 1 つ保存し、管理者の画面からの変更は applyAdminPatch で確かめてから入れる。
import { DEFAULT_MANUAL_BONUS, MANUAL_BONUS_MAX } from "./gearbox.ts";
import { BET } from "./betting.ts";
import { MARKET } from "./market.ts";
import { lapsFactor, PRIZE_CPU_ONLY_RATE, PRIZE_FINISH, PRIZE_PER_POINT } from "./money.ts";
import { DIVISION_COUNT } from "./league.ts";
import { BASE_PART_KINDS, type BasePartKind, type PartKind } from "./parts.ts";
import { MAX_CARS } from "./room.ts";
import { DEFAULT_SEASON_RULES, type ClassId, type RaceKind, type SeasonRules } from "./season.ts";

export interface AdminConfig {
  /** 普段のレースの賞金: 1 点あたり (money.ts の PRIZE_PER_POINT と同じ式) */
  prizePerPoint: number;
  /** 普段のレースの賞金: 完走のごほうび */
  prizeFinish: number;
  /** 大会の賞金 (1 位から) */
  tournamentPrize: number[];
  /** 人のチームが 1 つだけのレースの賞金の割合 (少なめ) */
  cpuOnlyPrizeRate: number;
  /** 季節の賞金 (級の中の順位、1 位から) */
  seasonPrize: number[];
  /** 季節の賞金の級ごとの倍率 (1 級から 5 級) */
  seasonPrizeClassMul: [number, number, number, number, number];
  /** 2 時間ごとのリーグ戦の、毎日の締めの賞金 (4 チームのリーグの中の順位 1〜2 位、人のチームだけ) */
  leaguePrize: number[];
  /** リーグ戦の賞金の部ごとの倍率 (1 部から 8 部)。下の部ほど多い (先を行くチームが離れすぎず、下のチームが追いつけるように) */
  leaguePrizeDivisionMul: number[];
  /** 練習の賞金 (サーバーが確かめた 1 周ごと) */
  practicePrizePerLap: number;
  /** コンストラクター (チームのチャンピオン) の点: リーグ戦の点に掛ける重み (全部の部に共通) */
  constructorLeagueWeight: number;
  /** コンストラクターの点: リーグ戦の部ごとの倍率 (1 部から 8 部)。上の部で取った点ほど重い */
  constructorDivisionMul: number[];
  /** 級ごとのコンストラクターのチャンピオンの賞金 (もと) */
  constructorPrize: number;
  /** その賞金の級ごとの倍率 (1 級から 5 級)。上の級ほど多い */
  constructorPrizeClassMul: [number, number, number, number, number];
  /** 総合のコンストラクターのチャンピオン (全体で 1 チーム) の賞金 */
  constructorOverallPrize: number;
  /** 級ごとのドライバーズチャンピオンの賞金 (もと。級の倍率は constructorPrizeClassMul と同じ)。運転手のいるチームへ */
  driverChampionPrize: number;
  /** 総合のドライバーズチャンピオンの賞金 */
  driverOverallPrize: number;
  /** 季節の点の倍率 */
  season: SeasonRules;
  /** 部品の強さの倍率 (全部) */
  partStrength: number;
  /** 部品の強さの倍率 (種類ごと。全部の倍率と掛ける) */
  partKindStrength: Record<BasePartKind, number>;
  /** 市場で売れたときの手数料の割合 */
  marketFeeRate: number;
  /** 招かれた人 (管理者の作った招待の合言葉を持つ人) だけ登録できる。はじめは切 (決まり: 誰でも登録できる。最初は URL を身内にだけ教える) */
  inviteOnly: boolean;
  /** マニュアル (自分で変速、パソコンだけ) で走ったときの車の速さ (最高速と加速) の上がり分 (0.03 = 3%。0〜0.3) */
  manualSpeedBonus: number;
  /** ギフトコードの中身の上限 (付けたいときだけ。null = 上限なし。決まり 11/25「中身の上限はなし。付けたいときだけ管理者の画面で」) */
  /** お金 (1 つの中身あたり) */
  giftMoneyMax: number | null;
  /** 部品の段階 (1〜5) */
  giftPartTierMax: number | null;
  /** 部品の数 (1 つの中身あたり) */
  giftPartCountMax: number | null;
  /** 運転手の契約金の割引 (%) */
  giftDiscountMax: number | null;
  /** 毎日の自動の大会 (dailytour.ts、DECISIONS 11/25「大会を毎日自動で開く・全員参加」): 開く */
  autoTourOn: boolean;
  /** 毎日の大会のスタートの時刻 (日本時間の 時・分)。予選はその 30 分前まで、組の部屋はその 10 分前 */
  autoTourHour: number;
  autoTourMinute: number;
  /** 毎日の大会の格 (1 = 小・2 = 中・3 = 大): 月〜土 / 日曜 */
  autoTourGradeWeekday: number;
  autoTourGradeSunday: number;
  /** 賭け (betting.ts): 一時停止 */
  betPaused: boolean;
  /**
   * 本物のお金 (課金) を入れたら入にする。入の間は賭けの受け口が全部断る (見直しと法律の確かめが済むまで。DECISIONS 11/25「レースの結果に賭ける」)。
   * 今は本物のお金が無いので切。賭けられるのはいつもゲームの中のお金 (accounts.money) だけ
   */
  realMoneyEnabled: boolean;
  /** 賭けの胴元の取り分 (0.1 = 1 割。倍率 = (1 − これ) ÷ 見込み) */
  betMargin: number;
  /** 賭けの締め切り (レースのスタートの何分前) */
  betCloseMinutes: number;
  /** 賭けの 1 回の一番小さい額 */
  betMinStake: number;
  /** 賭けの上限 (付けたいときだけ。null = 上限なし。決まり 11/25「賭けの上限はなし」) */
  /** 1 回 */
  betMaxStake: number | null;
  /** 1 日 (日本時間) */
  betMaxPerDay: number | null;
  /** 手元のお金のこの割合まで (0.2 = 2 割) */
  betMaxShareOfMoney: number | null;
  /** 走行点 (racepoints.ts、DECISIONS 11/25「走って点をためて交換」): 入 = たまる・交換できる。切 = どちらも止める (ギフトと景品の走行点は入る) */
  rpOn: boolean;
  /** 走行点: 完走の点 (周の数の倍率を掛ける。2 周 ×1・5 周 ×1.75・10 周 ×3) */
  rpFinish: number;
  /** 走行点: 1 位の上乗せ (1 つ下がるごとに 1 減る。5 なら 1 位 +5 … 5 位 +1) */
  rpPosBonus: number;
  /** 走行点: 大会 (自分で走ったとき) の倍率。大会は 1 日の上限に数えない */
  rpTourMul: number;
  /** 走行点: 1 周アタックの 1 周 (確かめが通った周) */
  rpTaLap: number;
  /** 走行点: 1 周アタックで自分の週の記録を縮めたとき (1 周の点の代わり) */
  rpTaBest: number;
  /** 走行点: 1 日 (日本時間) にレースと 1 周アタックでもらえる上限 */
  rpDailyCap: number;
  /** 管理者のお知らせ 1 行 (オープニングの画面の隅に出す。空 = 出さない。ANNOUNCEMENT_MAX 字まで・改行なし) */
  announcement: string;
}

const PART_KINDS: readonly BasePartKind[] = BASE_PART_KINDS;

export const DEFAULT_ADMIN_CONFIG: Readonly<AdminConfig> = {
  prizePerPoint: PRIZE_PER_POINT,
  prizeFinish: PRIZE_FINISH,
  tournamentPrize: [10000, 7000, 5000, 4000, 3000, 2000, 1500, 1000],
  cpuOnlyPrizeRate: PRIZE_CPU_ONLY_RATE,
  seasonPrize: [30000, 20000, 15000, 10000, 8000, 6000, 5000, 4000, 3000, 2000],
  seasonPrizeClassMul: [3, 2, 1.5, 1.2, 1],
  leaguePrize: [300, 150],
  leaguePrizeDivisionMul: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7],
  practicePrizePerLap: 5,
  constructorLeagueWeight: 0.1,
  constructorDivisionMul: [2, 1.7, 1.4, 1.2, 1, 0.75, 0.5, 0.3],
  constructorPrize: 5000,
  constructorPrizeClassMul: [4, 3, 2, 1.5, 1],
  constructorOverallPrize: 40000,
  driverChampionPrize: 2500,
  driverOverallPrize: 20000,
  season: { ...DEFAULT_SEASON_RULES },
  partStrength: 1,
  partKindStrength: { seat: 1, engine: 1, tire: 1, tank: 1, wing: 1, brake: 1, frame: 1 },
  marketFeeRate: MARKET.feeRate,
  inviteOnly: false,
  manualSpeedBonus: DEFAULT_MANUAL_BONUS,
  giftMoneyMax: null,
  giftPartTierMax: null,
  giftPartCountMax: null,
  giftDiscountMax: null,
  autoTourOn: true,
  autoTourHour: 22,
  autoTourMinute: 30,
  autoTourGradeWeekday: 2,
  autoTourGradeSunday: 3,
  betPaused: false,
  realMoneyEnabled: false,
  betMargin: BET.margin,
  betCloseMinutes: BET.closeMinutes,
  betMinStake: BET.minStake,
  betMaxStake: null,
  betMaxPerDay: null,
  betMaxShareOfMoney: null,
  rpOn: true,
  rpFinish: 10,
  rpPosBonus: 5,
  rpTourMul: 1,
  rpTaLap: 1,
  rpTaBest: 5,
  rpDailyCap: 150,
  announcement: "",
};

/** 倍率の幅 (仮) */
export const ADMIN_MUL_MIN = 0.1;
export const ADMIN_MUL_MAX = 10;
/** 手数料の上限 (仮) */
export const ADMIN_FEE_MAX = 0.5;
/** 賞金 1 つの上限 (仮) */
export const ADMIN_PRIZE_MAX = 10_000_000;
/** 走行点の 1 回の点の上限・1 日の上限の上限 (仮) */
export const ADMIN_RP_MAX = 1000;
export const ADMIN_RP_CAP_MAX = 100_000;
/** 賭けの胴元の取り分の上限 (仮) */
export const ADMIN_BET_MARGIN_MAX = 0.5;

/** お知らせの長さの上限 (字。仮) */
export const ANNOUNCEMENT_MAX = 80;

/** お知らせの確かめ: よければ null、悪ければわけ (日本語)。字は見た目の 1 字 (code point) で数える */
export function checkAnnouncement(v: unknown): string | null {
  if (typeof v !== "string") return "文字を入れてください";
  if (/[\u0000-\u001f\u007f]/.test(v)) return "改行は入れられません (1 行だけ)";
  const n = Array.from(v).length;
  if (n > ANNOUNCEMENT_MAX) return `長すぎます (${ANNOUNCEMENT_MAX} 字まで、今 ${n} 字)`;
  return null;
}

export function cloneAdminConfig(c: Readonly<AdminConfig>): AdminConfig {
  return {
    ...c,
    tournamentPrize: [...c.tournamentPrize],
    seasonPrize: [...c.seasonPrize],
    seasonPrizeClassMul: [...c.seasonPrizeClassMul],
    leaguePrize: [...c.leaguePrize],
    leaguePrizeDivisionMul: [...c.leaguePrizeDivisionMul],
    constructorDivisionMul: [...c.constructorDivisionMul],
    constructorPrizeClassMul: [...c.constructorPrizeClassMul],
    season: { ...c.season },
    partKindStrength: { ...c.partKindStrength },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const prize = (v: unknown) => num(v, 0, ADMIN_PRIZE_MAX) && Number.isInteger(v);
const prizeList = (v: unknown, minLen: number, maxLen: number) => Array.isArray(v) && v.length >= minLen && v.length <= maxLen && v.every(prize);

export type AdminConfigCheck = { ok: true; config: AdminConfig } | { ok: false; errors: string[] };

/** 形と幅を確かめる。errors には悪い項目の名前 */
export function validateAdminConfig(x: unknown): AdminConfigCheck {
  const errors: string[] = [];
  if (!isObj(x)) return { ok: false, errors: ["config"] };
  if (!prize(x.prizePerPoint)) errors.push("prizePerPoint");
  if (!prize(x.prizeFinish)) errors.push("prizeFinish");
  if (!prizeList(x.tournamentPrize, MAX_CARS, MAX_CARS)) errors.push("tournamentPrize");
  if (!num(x.cpuOnlyPrizeRate, 0, 1)) errors.push("cpuOnlyPrizeRate");
  if (!prizeList(x.seasonPrize, 0, 100)) errors.push("seasonPrize");
  if (!(Array.isArray(x.seasonPrizeClassMul) && x.seasonPrizeClassMul.length === 5 && x.seasonPrizeClassMul.every((v) => num(v, 0, ADMIN_MUL_MAX)))) errors.push("seasonPrizeClassMul");
  if (!prizeList(x.leaguePrize, 0, 20)) errors.push("leaguePrize");
  if (!(Array.isArray(x.leaguePrizeDivisionMul) && x.leaguePrizeDivisionMul.length === DIVISION_COUNT && x.leaguePrizeDivisionMul.every((v) => num(v, 0, ADMIN_MUL_MAX)))) errors.push("leaguePrizeDivisionMul");
  if (!num(x.constructorLeagueWeight, 0, ADMIN_MUL_MAX)) errors.push("constructorLeagueWeight");
  if (!(Array.isArray(x.constructorDivisionMul) && x.constructorDivisionMul.length === DIVISION_COUNT && x.constructorDivisionMul.every((v) => num(v, 0, ADMIN_MUL_MAX)))) errors.push("constructorDivisionMul");
  if (!num(x.constructorPrize, 0, 1e9)) errors.push("constructorPrize");
  if (!(Array.isArray(x.constructorPrizeClassMul) && x.constructorPrizeClassMul.length === 5 && x.constructorPrizeClassMul.every((v) => num(v, 0, ADMIN_MUL_MAX)))) errors.push("constructorPrizeClassMul");
  if (!num(x.constructorOverallPrize, 0, 1e9)) errors.push("constructorOverallPrize");
  if (!num(x.driverChampionPrize, 0, 1e9)) errors.push("driverChampionPrize");
  if (!num(x.driverOverallPrize, 0, 1e9)) errors.push("driverOverallPrize");
  if (!prize(x.practicePrizePerLap)) errors.push("practicePrizePerLap");
  const s = x.season;
  if (!(isObj(s) && num(s.everydayMul, 0, 100) && num(s.tournamentMul, 0, 100) && num(s.cpuOnlyMul, 0, 1))) errors.push("season");
  if (!num(x.partStrength, ADMIN_MUL_MIN, ADMIN_MUL_MAX)) errors.push("partStrength");
  const k = x.partKindStrength;
  if (!(isObj(k) && PART_KINDS.every((p) => num(k[p], ADMIN_MUL_MIN, ADMIN_MUL_MAX)))) errors.push("partKindStrength");
  if (!num(x.marketFeeRate, 0, ADMIN_FEE_MAX)) errors.push("marketFeeRate");
  if (typeof x.inviteOnly !== "boolean") errors.push("inviteOnly");
  if (!num(x.manualSpeedBonus, 0, MANUAL_BONUS_MAX)) errors.push("manualSpeedBonus");
  // ギフトコードの上限 (null = なし)
  const cap = (v: unknown, lo: number, hi: number) => v === null || (num(v, lo, hi) && Number.isInteger(v));
  if (!cap(x.giftMoneyMax, 0, ADMIN_PRIZE_MAX)) errors.push("giftMoneyMax");
  if (!cap(x.giftPartTierMax, 1, 5)) errors.push("giftPartTierMax");
  if (!cap(x.giftPartCountMax, 1, 999)) errors.push("giftPartCountMax");
  if (!cap(x.giftDiscountMax, 0, 100)) errors.push("giftDiscountMax");
  // 毎日の自動の大会
  const int = (v: unknown, lo: number, hi: number) => num(v, lo, hi) && Number.isInteger(v);
  if (typeof x.autoTourOn !== "boolean") errors.push("autoTourOn");
  if (!int(x.autoTourHour, 0, 23)) errors.push("autoTourHour");
  if (!int(x.autoTourMinute, 0, 59)) errors.push("autoTourMinute");
  if (!int(x.autoTourGradeWeekday, 1, 3)) errors.push("autoTourGradeWeekday");
  if (!int(x.autoTourGradeSunday, 1, 3)) errors.push("autoTourGradeSunday");
  // 賭け (上限は null = なし)
  if (typeof x.betPaused !== "boolean") errors.push("betPaused");
  if (typeof x.realMoneyEnabled !== "boolean") errors.push("realMoneyEnabled");
  if (!num(x.betMargin, 0, ADMIN_BET_MARGIN_MAX)) errors.push("betMargin");
  if (!(num(x.betCloseMinutes, 1, 120) && Number.isInteger(x.betCloseMinutes))) errors.push("betCloseMinutes");
  if (!(prize(x.betMinStake) && (x.betMinStake as number) >= 1)) errors.push("betMinStake");
  if (!cap(x.betMaxStake, 1, ADMIN_PRIZE_MAX)) errors.push("betMaxStake");
  if (!cap(x.betMaxPerDay, 1, ADMIN_PRIZE_MAX)) errors.push("betMaxPerDay");
  if (!(x.betMaxShareOfMoney === null || num(x.betMaxShareOfMoney, 0.01, 1))) errors.push("betMaxShareOfMoney");
  // 走行点
  if (typeof x.rpOn !== "boolean") errors.push("rpOn");
  if (!int(x.rpFinish, 0, ADMIN_RP_MAX)) errors.push("rpFinish");
  if (!int(x.rpPosBonus, 0, 100)) errors.push("rpPosBonus");
  if (!num(x.rpTourMul, 0, ADMIN_MUL_MAX)) errors.push("rpTourMul");
  if (!int(x.rpTaLap, 0, ADMIN_RP_MAX)) errors.push("rpTaLap");
  if (!int(x.rpTaBest, 0, ADMIN_RP_MAX)) errors.push("rpTaBest");
  if (!int(x.rpDailyCap, 0, ADMIN_RP_CAP_MAX)) errors.push("rpDailyCap");
  // お知らせ
  if (checkAnnouncement(x.announcement) !== null) errors.push("announcement");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: cloneAdminConfig(x as unknown as AdminConfig) };
}

/**
 * 管理者の画面からの一部の変更を合わせて確かめる。season と partKindStrength は中身ごとに合わせ、配列は丸ごと替える。
 * 知らない項目があれば errors に入れる。
 */
export function applyAdminPatch(base: Readonly<AdminConfig>, patch: unknown): AdminConfigCheck {
  if (!isObj(patch)) return { ok: false, errors: ["patch"] };
  const unknown = Object.keys(patch).filter((k) => !(k in DEFAULT_ADMIN_CONFIG));
  if (unknown.length > 0) return { ok: false, errors: unknown.map((k) => `unknown:${k}`) };
  const merged: Record<string, unknown> = { ...cloneAdminConfig(base), ...patch };
  if (isObj(patch.season)) merged.season = { ...base.season, ...patch.season };
  if (isObj(patch.partKindStrength)) merged.partKindStrength = { ...base.partKindStrength, ...patch.partKindStrength };
  return validateAdminConfig(merged);
}

/**
 * 1 台のレースの賞金。普段のレースは money.ts の racePrize と同じ式 (点 × 1 点あたり + 完走、周の数の倍率、人 1 人なら少なめ) を
 * 管理者の数で。大会は順位の表 (pos は 1 から)。失格は 0
 */
export function racePrizeFor(
  cfg: Readonly<AdminConfig>,
  kind: RaceKind,
  row: { pos: number; points: number; finished: boolean; dq?: boolean },
  race: { laps: number; cpuOnly: boolean },
): number {
  if (row.dq) return 0;
  if (kind === "tournament") return row.finished ? (cfg.tournamentPrize[row.pos - 1] ?? 0) : 0;
  const base = row.points * cfg.prizePerPoint + (row.finished ? cfg.prizeFinish : 0);
  return Math.max(0, Math.round(base * lapsFactor(race.laps) * (race.cpuOnly ? cfg.cpuOnlyPrizeRate : 1)));
}

/** 季節の賞金 (級の中の順位 rank は 1 から) */
export function seasonPrizeFor(cfg: Readonly<AdminConfig>, cls: ClassId, rank: number): number {
  return Math.floor((cfg.seasonPrize[rank - 1] ?? 0) * cfg.seasonPrizeClassMul[cls - 1]);
}

/** リーグ戦の賞金 (部 division は 1〜8、リーグの中の順位 rank は 1 から)。下の部ほど倍率が大きい */
export function leaguePrizeFor(cfg: Readonly<AdminConfig>, division: number, rank: number): number {
  return Math.floor((cfg.leaguePrize[rank - 1] ?? 0) * (cfg.leaguePrizeDivisionMul[division - 1] ?? 0));
}

/** 市場の手数料 (market.ts の marketFee と同じく四捨五入) */
export function marketFeeFor(cfg: Readonly<AdminConfig>, price: number): number {
  return Math.round(Math.max(0, price) * cfg.marketFeeRate);
}

/** 部品の強さの倍率 (全部 × 種類) */
export function partStrengthFor(cfg: Readonly<AdminConfig>, kind: PartKind): number {
  return cfg.partStrength * (cfg.partKindStrength[kind as BasePartKind] ?? 1);
}
