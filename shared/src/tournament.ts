// 大会: 管理者が日時・コース・周回・天気を決める。級なし。
// 予選: 大会の前の日までに、好きなときに一人で走って 1 周の記録を出す。記録の順が並び (グリッド)。
// 決まり: 乾いた路面では、乾いた路面用のタイヤ (S・M・H) を 2 種類以上使う (最低 1 回ピット)。破ったら失格。
// 結果は季節の点 (CountedRace, kind "tournament") になる。時刻は ms で受け取る。
import { MAX_CARS } from "./room.ts";
import type { CountedRace, RaceCar } from "./season.ts";
import { TIRE_DEFS, type TireCompound } from "./tires.ts";
import type { TournamentPrizeSpec } from "./tourprize.ts";
import { isTournamentGrade } from "./tourprize.ts";
import { makeWeatherPlan, SKY_WET, type Sky, type WeatherPlan } from "./weather.ts";

/** 日付の切れ目に使う時差 (日本時間、仮) */
export const TOURNAMENT_TZ_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** 周回数の幅 (仮) */
export const TOURNAMENT_LAPS_MIN = 1;
export const TOURNAMENT_LAPS_MAX = 60;
/** 予選が開いている時間の下限 (仮)。これより短い大会は組めない */
export const MIN_QUALIFY_WINDOW_MS = 6 * 3_600_000;
/** 濡れ具合がこれ未満なら「乾いた路面」(仮。普通のタイヤが小雨用より握る間) */
export const DRY_ROAD_MAX_WET = 0.1;

export type TournamentWeather =
  /** ずっとこの空 */
  | { mode: "fixed"; sky: Sky }
  /** おまかせ (seed で決まる。rain 0..1 = 雨の見込み、startSky = 最初の空) */
  | { mode: "random"; seed: number; rain?: number; startSky?: Sky };

/** 格と景品 (tourprize.ts) も持つ */
export interface TournamentSpec extends TournamentPrizeSpec {
  id: string;
  name: string;
  /** 大会を組んだ時刻 = 予選が開く時刻 */
  createdAt: number;
  /** スタートの時刻 */
  startsAt: number;
  trackId: string;
  laps: number;
  weather: TournamentWeather;
  /** 予選の締め切り (なし = 大会の日の 0:00。毎日の大会はスタートの 30 分前、dailytour.ts) */
  qualifyClosesAt?: number;
  /** 全員参加: 申し込みなしで全部の人のチームが 2 台で出る (来ない人は代走)。なし = 予選の組を決めた人だけ (前からの大会) */
  allEnter?: boolean;
  /** 毎日の自動の大会 (dailytour.ts) */
  auto?: boolean;
}

export type TournamentIssue = "name" | "track" | "laps" | "weather" | "past" | "no_qualifying_window" | "grade";

/** 大会を組むときの確かめ。knownTrackIds を渡すとコースがあるかも見る */
export function validateTournament(spec: TournamentSpec, now: number, knownTrackIds?: readonly string[]): TournamentIssue[] {
  const out: TournamentIssue[] = [];
  if (typeof spec.name !== "string" || spec.name.trim() === "") out.push("name");
  if (typeof spec.trackId !== "string" || spec.trackId === "" || (knownTrackIds && !knownTrackIds.includes(spec.trackId))) out.push("track");
  if (!Number.isInteger(spec.laps) || spec.laps < TOURNAMENT_LAPS_MIN || spec.laps > TOURNAMENT_LAPS_MAX) out.push("laps");
  const w = spec.weather;
  if (!w || (w.mode === "fixed" ? !(w.sky in SKY_WET) : w.mode === "random" ? !Number.isFinite(w.seed) : true)) out.push("weather");
  if (!(spec.startsAt > now)) out.push("past");
  if (spec.grade !== undefined && !isTournamentGrade(spec.grade)) out.push("grade");
  const q = qualifyWindow(spec);
  if (q.closesAt - Math.max(q.opensAt, now) < MIN_QUALIFY_WINDOW_MS) out.push("no_qualifying_window");
  return out;
}

/** 大会の日の 0:00 (日本時間) */
export function tournamentDayStart(startsAt: number): number {
  const local = startsAt + TOURNAMENT_TZ_OFFSET_MS;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - TOURNAMENT_TZ_OFFSET_MS;
}

/** 予選の時間: 大会を組んだときから、大会の日の 0:00 (= 前の日の終わり) まで (qualifyClosesAt があればそこまで。スタートより後にはしない) */
export function qualifyWindow(spec: TournamentSpec): { opensAt: number; closesAt: number } {
  const closesAt = spec.qualifyClosesAt !== undefined && Number.isFinite(spec.qualifyClosesAt) ? Math.min(spec.qualifyClosesAt, spec.startsAt) : tournamentDayStart(spec.startsAt);
  return { opensAt: spec.createdAt, closesAt };
}

export type TournamentPhase = "qualifying" | "grid_set" | "started";

export function tournamentPhaseAt(spec: TournamentSpec, now: number): TournamentPhase {
  if (now >= spec.startsAt) return "started";
  return now < qualifyWindow(spec).closesAt ? "qualifying" : "grid_set";
}

/** 大会の天気の予定 (raceSeconds = レースのおよその長さ) */
export function tournamentWeatherPlan(spec: TournamentSpec, raceSeconds: number): WeatherPlan {
  const w = spec.weather;
  if (w.mode === "fixed") return { seed: 1, changes: [{ at: 0, sky: w.sky }], fakes: [], startWet: SKY_WET[w.sky] };
  return makeWeatherPlan(w.seed, raceSeconds, { rain: w.rain, startSky: w.startSky });
}

// ---------------------------------------------------------------- 予選

export interface QualifyAttempt {
  driverId: string;
  teamId: string;
  /** 1 周の時間 (秒) */
  lapTime: number;
  /** 近道などで数えない周は false */
  valid: boolean;
  /** 走った時刻 (ms) */
  at: number;
}

export interface QualifyRow {
  driverId: string;
  teamId: string;
  lapTime: number;
  at: number;
}

/** 予選の表: 予選の時間の中の、数える周の、運転手ごとの一番速い記録 (速い順、同じなら先に出したほう) */
export function qualifyingTable(spec: TournamentSpec, attempts: readonly QualifyAttempt[]): QualifyRow[] {
  const { opensAt, closesAt } = qualifyWindow(spec);
  const best = new Map<string, QualifyRow>();
  for (const a of attempts) {
    if (!a.valid || !(a.lapTime > 0) || !Number.isFinite(a.lapTime) || a.at < opensAt || a.at >= closesAt) continue;
    const cur = best.get(a.driverId);
    if (!cur || a.lapTime < cur.lapTime || (a.lapTime === cur.lapTime && a.at < cur.at)) {
      best.set(a.driverId, { driverId: a.driverId, teamId: a.teamId, lapTime: a.lapTime, at: a.at });
    }
  }
  return [...best.values()].sort((a, b) => a.lapTime - b.lapTime || a.at - b.at || (a.driverId < b.driverId ? -1 : 1));
}

export interface GridSlot {
  driverId: string;
  teamId: string;
  /** 予選の記録 (無ければ null = 後ろに並ぶ) */
  lapTime: number | null;
  /** 0 から (gridPosition に渡す) */
  slot: number;
}

export interface Entrant {
  driverId: string;
  teamId: string;
}

/**
 * 並び: 予選の記録の順、記録の無い出場者 (雇った運転手・予選を走らなかったチーム) はその後ろ。
 * 後ろの並び: strength (運転手 → 見込みの 1 周の秒、tourgrid.ts) を渡すと、強い (速い) 車ほど後ろ (一番強い車が最後尾。
 * 前を抜いて上がってくる。11/25 ユーザー)。同じなら チーム id → 運転手 id。見込みの無い車は一番前。渡さなければ id 順 (前から)。
 * (仮) 席 (seats、ふつう 8) に入りきらない分は reserves (このレースには出ない)。
 */
export function tournamentGrid(
  spec: TournamentSpec,
  attempts: readonly QualifyAttempt[],
  entrants: readonly Entrant[] = [],
  seats = MAX_CARS,
  strength?: ReadonlyMap<string, number>,
): { grid: GridSlot[]; reserves: GridSlot[] } {
  const table = qualifyingTable(spec, attempts);
  const timed = new Set(table.map((r) => r.driverId));
  const byId = (a: Entrant, b: Entrant) => (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0);
  const rest = [...new Map(entrants.filter((e) => !timed.has(e.driverId)).map((e) => [e.driverId, e])).values()];
  if (strength) {
    const lap = (e: Entrant) => {
      const v = strength.get(e.driverId);
      return v !== undefined && Number.isFinite(v) ? v : Infinity;
    };
    // 遅い (弱い) 車が前、速い (強い) 車が後ろ
    rest.sort((a, b) => lap(b) - lap(a) || byId(a, b));
  } else rest.sort((a, b) => (a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0));
  const all: GridSlot[] = [
    ...table.map((r, i) => ({ driverId: r.driverId, teamId: r.teamId, lapTime: r.lapTime, slot: i })),
    ...rest.map((e, i) => ({ driverId: e.driverId, teamId: e.teamId, lapTime: null, slot: table.length + i })),
  ];
  return { grid: all.slice(0, seats), reserves: all.slice(seats) };
}

// ---------------------------------------------------------------- タイヤの決まり

/** 1 本のタイヤで走った区間 */
export interface Stint {
  tire: TireCompound;
  /** この区間で走った距離 (m) */
  meters: number;
  /** この区間の間ずっと乾いた路面だった */
  dry: boolean;
}

export function isDryRoad(wet: number): boolean {
  return wet < DRY_ROAD_MAX_WET;
}

/** スタートとピットでタイヤを替えたときに呼ぶ: 新しい区間を始める */
export function startStint(stints: readonly Stint[], tire: TireCompound, wet: number): Stint[] {
  return [...stints, { tire, meters: 0, dry: isDryRoad(wet) }];
}

/** 走った分を今の区間に足す (周ごと・濡れ具合が変わったときなどに呼ぶ)。濡れたら区間は「乾いた」でなくなる */
export function advanceStint(stints: readonly Stint[], meters: number, wet: number): Stint[] {
  if (stints.length === 0) return [];
  const last = stints[stints.length - 1];
  return [...stints.slice(0, -1), { tire: last.tire, meters: last.meters + Math.max(0, meters), dry: last.dry && isDryRoad(wet) }];
}

export interface TireRuleResult {
  /** 決まりが当てはまる (走った区間が全部乾いた路面) */
  applies: boolean;
  ok: boolean;
  /** 使った乾いた路面用のタイヤ */
  dryCompounds: TireCompound[];
}

/**
 * 大会のタイヤの決まり: 走った区間 (0 m の区間は数えない) が全部乾いた路面なら、
 * 乾いた路面用のタイヤを 2 種類以上使っていないと失格。一度でも濡れた路面を走ったら当てはまらない (F1 と同じ考え、仮)。
 */
export function checkDryTireRule(stints: readonly Stint[]): TireRuleResult {
  const run = stints.filter((s) => s.meters > 0);
  const dryCompounds = [...new Set(run.filter((s) => TIRE_DEFS[s.tire].slick).map((s) => s.tire))].sort();
  const applies = run.length > 0 && run.every((s) => s.dry);
  return { applies, ok: !applies || dryCompounds.length >= 2, dryCompounds };
}

// ---------------------------------------------------------------- 結果

export interface TournamentCarResult {
  driverId: string;
  /** 空きを埋めたコンピューターは null */
  teamId: string | null;
  /** 部屋の順位 (1 から) */
  pos: number;
  finished: boolean;
  /** 一番速い周 (秒) */
  best: number | null;
  stints: readonly Stint[];
  /** 代走 (人が来なかった) */
  standIn?: boolean;
}

export interface ClassifiedCar extends TournamentCarResult {
  /** 失格を除いて詰めた順位 (失格は後ろ) */
  finalPos: number;
  dq: boolean;
  fastest: boolean;
  tireRule: TireRuleResult;
}

/**
 * 大会の結果を確定する: ゴールした車にタイヤの決まりを当て、破った車は失格 (後ろへ・点なし)。
 * 一番速い周は失格でないゴールした車の中から選び直す (同じ時間なら上の順位)。
 */
export function classifyTournament(spec: TournamentSpec, results: readonly TournamentCarResult[], endedAt: number): { cars: ClassifiedCar[]; race: CountedRace } {
  const checked = [...results]
    .sort((a, b) => a.pos - b.pos)
    .map((r) => {
      const tireRule = checkDryTireRule(r.stints);
      return { r, tireRule, dq: r.finished && !tireRule.ok };
    });
  const order = [...checked.filter((c) => !c.dq), ...checked.filter((c) => c.dq)];
  let fastestId: string | null = null;
  let fastest = Infinity;
  for (const c of order) {
    if (c.dq || !c.r.finished || c.r.best === null) continue;
    if (c.r.best < fastest) {
      fastest = c.r.best;
      fastestId = c.r.driverId;
    }
  }
  const cars: ClassifiedCar[] = order.map((c, i) => ({ ...c.r, finalPos: i + 1, dq: c.dq, fastest: c.r.driverId === fastestId, tireRule: c.tireRule }));
  const raceCars: RaceCar[] = cars.map((c) => ({
    driverId: c.driverId,
    teamId: c.teamId,
    pos: c.finalPos,
    finished: c.finished,
    fastest: c.fastest,
    dq: c.dq,
    standIn: c.standIn === true,
  }));
  return { cars, race: { raceId: `tournament-${spec.id}`, kind: "tournament", at: endedAt, cars: raceCars } };
}
