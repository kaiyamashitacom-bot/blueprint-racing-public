// 毎日の自動の大会 (DECISIONS 11/25「大会を毎日自動で開く・全員参加」)。数は全部 (仮)。
// - 毎日 22:30 (日本時間、管理者が変えられる)。予選は 前の日の大会のスタート + 30 分 (= 前の大会が終わったころ) から 22:00 まで
//   (スタートの 30 分前)。組の部屋は 22:20 (スタートの 10 分前。リーグ戦の 22:00 のレースと日の締めのあと)
// - 全員参加 (allEnter)・10 周・天気はくじ (予報あり)・8 台ずつの組・格は 月〜土 中 / 日曜 大
// - コースは公式コースを日ごとに順に回す (その日の 0:00 に回し方に入っているもの。tracks.ts の TRACK_ROTATION_FROM。足しても今日は変わらない)
// - 知らせは 1 時間前だけ (毎日なので 24 時間前はやめる)
// - 管理者が作った大会がある日は開かない (server/src/season.ts が見る)
// - id は日で決まる ("d20261130") ので、何度呼んでも 1 日 1 つ
import type { AdminConfig } from "./adminconfig.ts";
import { rotationTrackDefs } from "./tracks.ts";
import { gradeFromNumber, type TournamentGrade } from "./tourprize.ts";
import { TOURNAMENT_TZ_OFFSET_MS, type TournamentSpec } from "./tournament.ts";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export const DAILY_TOUR = {
  laps: 10,
  groupSize: 8,
  /** 天気のくじの雨の見込み (管理者の画面の「変わる (おまかせ)」と同じ) */
  rain: 0.3,
  /** 予選の締め切り: スタートのこれだけ前 */
  qualiCloseBeforeMs: 30 * MIN_MS,
  /** 予選が開く: 前の日のスタートのこれだけあと */
  openAfterPrevMs: 30 * MIN_MS,
  /** 知らせ (スタートの何 ms 前) */
  noticeLeadsMs: [HOUR_MS] as readonly number[],
  /** 作るのが遅れたとき、スタートまでこれより短ければもう作らない (組の部屋はスタートの 10 分前) */
  minLeadMs: 15 * MIN_MS,
} as const;

/** 日本時間のその日の 0:00 (ms) */
export function jstDayStart(t: number): number {
  const local = t + TOURNAMENT_TZ_OFFSET_MS;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - TOURNAMENT_TZ_OFFSET_MS;
}

/** 日の番号 (1970-01-01 日本時間から) */
export function jstDayIndex(dayStart: number): number {
  return Math.floor((dayStart + TOURNAMENT_TZ_OFFSET_MS) / DAY_MS);
}

/** 曜日 (0 = 日 … 6 = 土、日本時間) */
export function jstWeekday(t: number): number {
  return new Date(t + TOURNAMENT_TZ_OFFSET_MS).getUTCDay();
}

export interface DailyTourSettings {
  on: boolean;
  hour: number;
  minute: number;
  gradeWeekday: TournamentGrade;
  gradeSunday: TournamentGrade;
}

export function dailyTourSettings(cfg: Pick<AdminConfig, "autoTourOn" | "autoTourHour" | "autoTourMinute" | "autoTourGradeWeekday" | "autoTourGradeSunday">): DailyTourSettings {
  return {
    on: cfg.autoTourOn,
    hour: cfg.autoTourHour,
    minute: cfg.autoTourMinute,
    gradeWeekday: gradeFromNumber(cfg.autoTourGradeWeekday),
    gradeSunday: gradeFromNumber(cfg.autoTourGradeSunday),
  };
}

export function dailyTourId(dayStart: number): string {
  const d = new Date(dayStart + TOURNAMENT_TZ_OFFSET_MS);
  return `d${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function isDailyTourId(id: string): boolean {
  return /^d\d{8}$/.test(id);
}

export const dailyTourStart = (dayStart: number, s: Pick<DailyTourSettings, "hour" | "minute">) => dayStart + s.hour * HOUR_MS + s.minute * MIN_MS;
/** 予選が開く時刻 (前の日のスタート + 30 分) */
export const dailyTourOpensAt = (dayStart: number, s: Pick<DailyTourSettings, "hour" | "minute">) => dailyTourStart(dayStart - DAY_MS, s) + DAILY_TOUR.openAfterPrevMs;

/** その日の格 (日曜は gradeSunday) */
export function dailyTourGrade(dayStart: number, s: Pick<DailyTourSettings, "gradeWeekday" | "gradeSunday">): TournamentGrade {
  return jstWeekday(dayStart) === 0 ? s.gradeSunday : s.gradeWeekday;
}

/** その日のコース: その日の 0:00 に回し方に入っている公式コースを、日の番号で順に */
export function dailyTourTrack(dayStart: number): { id: string; name: string } {
  const defs = rotationTrackDefs(dayStart);
  const n = defs.length;
  const i = jstDayIndex(dayStart);
  const d = defs[((i % n) + n) % n];
  return { id: d.id, name: d.name };
}

const WEEK_JP = ["日", "月", "火", "水", "木", "金", "土"];

/** その日の自動の大会の中身 (createdAt = 予選が開く時刻。遅れて作るときは now) */
export function dailyTourSpec(dayStart: number, s: DailyTourSettings, now: number): TournamentSpec {
  const startsAt = dailyTourStart(dayStart, s);
  const d = new Date(dayStart + TOURNAMENT_TZ_OFFSET_MS);
  const track = dailyTourTrack(dayStart);
  const grade = dailyTourGrade(dayStart, s);
  return {
    id: dailyTourId(dayStart),
    name: `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEK_JP[d.getUTCDay()]}) の大会${grade === "大" ? "・大" : ""}`,
    createdAt: Math.max(dailyTourOpensAt(dayStart, s), Math.min(now, startsAt)),
    startsAt,
    trackId: track.id,
    laps: DAILY_TOUR.laps,
    weather: { mode: "random", seed: (jstDayIndex(dayStart) * 7919 + 17) % 1_000_000_007, rain: DAILY_TOUR.rain },
    qualifyClosesAt: startsAt - DAILY_TOUR.qualiCloseBeforeMs,
    grade,
    allEnter: true,
    auto: true,
  };
}

/**
 * 今 (now) 予選が開いているべき自動の大会の日 (その日の 0:00)。無ければ null。
 * 今日の大会のスタートより前なら今日、過ぎていれば明日 (予選が開くのは前の日のスタート + 30 分から)
 */
export function dailyTourDayDue(now: number, s: DailyTourSettings): number | null {
  if (!s.on) return null;
  const today = jstDayStart(now);
  for (const day of [today, today + DAY_MS]) {
    if (now >= dailyTourOpensAt(day, s) && now < dailyTourStart(day, s) - DAILY_TOUR.minLeadMs) return day;
  }
  return null;
}

/** 次に自動の大会を作る時刻 (server の目覚まし用) */
export function nextDailyTourOpen(now: number, s: DailyTourSettings): number | null {
  if (!s.on) return null;
  const today = jstDayStart(now);
  for (const day of [today, today + DAY_MS, today + 2 * DAY_MS]) {
    const at = dailyTourOpensAt(day, s);
    if (at > now) return at;
  }
  return null;
}
