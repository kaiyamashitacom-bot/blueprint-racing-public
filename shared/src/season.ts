// 級と季節: 5 つの級・1 週間の季節・季節の点 (普段のレースは少し、大会は大きく)・チーム順位と運転手順位・上がり下がり。
// 決めごと (DECISIONS「級と季節」): 級は 5 つでチームに付く。季節の終わりに各級の 1 位の 1 チームが上へ (11/25 ユーザー「昇格できるチームを1チームにしよう」)、最下位の 1 チームが下へ (仮)。
// 新しいチームは最初の季節は級なしで、一番下の級に混ざって走る。次の季節から成績で級が決まる。
// 季節が変わると順位の点だけ 0 に戻る (部品とお金は持ち越し)。
// 時刻はすべて ms で受け取る (中で Date.now() は呼ばない)。
import { FASTEST_LAP_POINT, POINTS, pointsFor } from "./race.ts";

/** 級。1 が一番上、5 が一番下 (仮: 数の向き) */
export type ClassId = 1 | 2 | 3 | 4 | 5;
export const CLASS_IDS: readonly ClassId[] = [1, 2, 3, 4, 5];
export const TOP_CLASS: ClassId = 1;
export const LOWEST_CLASS: ClassId = 5;
/** 画面用の名前 (仮) */
export const CLASS_NAMES: Readonly<Record<ClassId, string>> = { 1: "1 級", 2: "2 級", 3: "3 級", 4: "4 級", 5: "5 級" };

export function isClassId(v: unknown): v is ClassId {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** 季節の長さ = 1 週間 */
export const SEASON_MS = 7 * DAY_MS;
/** 季節 0 の始まり (仮): 2026-11-30 (月) 0:00 日本時間 */
export const SEASON_EPOCH_MS = Date.UTC(2026, 10, 29, 15, 0, 0);
/** 季節の終わりに上がる / 下がるチームの数 (決まり: 上がるのは 1 チーム。下がるのも 1 チームにそろえる = 仮) */
export const PROMOTE_COUNT = 1;
export const RELEGATE_COUNT = 1;

/** 季節の点の掛け算 */
export interface SeasonRules {
  /** 普段のレースの点の倍率 */
  everydayMul: number;
  /** 大会の点の倍率。普段の 10 倍 = 「普段は 1/10」(点を整数のままにするため大会のほうを 10 倍にした) */
  tournamentMul: number;
  /** 人のチームが 1 つだけ (あとはコンピューター) の普段のレースの倍率 (少なめ) */
  cpuOnlyMul: number;
}
/** (仮) 普段 ×1・大会 ×10・コンピューターだけ ×0.5 (2 時間ごとの自動のレースは季節の点に入らない。scheduled.ts のリーグ戦) */
export const DEFAULT_SEASON_RULES: Readonly<SeasonRules> = { everydayMul: 1, tournamentMul: 10, cpuOnlyMul: 0.5 };

// ---------------------------------------------------------------- 季節の時間

/** 時刻 t (ms) が何番目の季節か (epoch より前は負) */
export function seasonIndexAt(t: number, epoch = SEASON_EPOCH_MS): number {
  return Math.floor((t - epoch) / SEASON_MS);
}

export interface SeasonWindow {
  index: number;
  startsAt: number;
  /** この時刻からは次の季節 */
  endsAt: number;
}

export function seasonWindow(index: number, epoch = SEASON_EPOCH_MS): SeasonWindow {
  const startsAt = epoch + index * SEASON_MS;
  return { index, startsAt, endsAt: startsAt + SEASON_MS };
}

/** 運転手の契約・供給の約束が使う SeasonClock と同じ形 ({ index, startMs, endMs }) を、時刻 t の季節で作る */
export function seasonClockAt(t: number, epoch = SEASON_EPOCH_MS): { index: number; startMs: number; endMs: number } {
  const w = seasonWindow(seasonIndexAt(t, epoch), epoch);
  return { index: w.index, startMs: w.startsAt, endMs: w.endsAt };
}

// ---------------------------------------------------------------- 1 レースの点

/** everyday = すぐ走る・開いた部屋、tournament = 大会 */
export type RaceKind = "everyday" | "tournament";

/** 代走のコンピューターの上手さ (仮、「普通」)。makeBrain(rand, skill) に渡す */
export const STAND_IN_SKILL = 0.8;

/** 季節の点に数える 1 台の結果 */
export interface RaceCar {
  /** 運転手 (人の運転手も、雇ったコンピューターの運転手も) */
  driverId: string;
  /** 空きを埋めたコンピューターは null (点は付かない) */
  teamId: string | null;
  /** 順位 (1 から。ResultRow.pos と同じ) */
  pos: number;
  finished: boolean;
  /** 一番速い周 */
  fastest: boolean;
  /** 失格 (大会のタイヤの決まりなど) */
  dq?: boolean;
  /**
   * 代走: 人が来なかったので、その人の車をコンピューターが運転した (普通の上手さ・走る前の予定のまま)。
   * 点はチーム順位には全部入る。運転手順位: 普段のレースは入らない (仮)。大会は レースの点の 1/5 (切り捨て) × 大会の倍率
   * (11/25 ユーザー「チームはそのまま、運転手は 1/5」。STAND_IN_DRIVER_SHARE)。結果に「代走」と出す
   */
  standIn?: boolean;
  /** 運転手のいない埋め草の車 (全員参加の大会で、雇った運転手のいないチームの 2 台目)。点はチームだけ、運転手順位には入らない */
  filler?: boolean;
}

export interface CountedRace {
  raceId: string;
  kind: RaceKind;
  /** レースが終わった時刻 (ms)。どの季節に入るかを決める */
  at: number;
  cars: RaceCar[];
}

/** 人のチームが 1 つ以下 = コンピューターとだけ走った (自分の 2 台目は自分のチーム) */
export function isCpuOnlyRace(cars: readonly RaceCar[]): boolean {
  const teams = new Set<string>();
  for (const c of cars) if (c.teamId !== null) teams.add(c.teamId);
  return teams.size <= 1;
}

/** レースの部屋と同じ点 (ゴールした車だけ。F1 の点 + 一番速い周に 1 点)。失格は 0 */
export function baseRacePoints(car: RaceCar, field = 8): number {
  if (car.dq || !car.finished) return 0;
  const p = pointsFor(car.pos - 1, field);
  return p + (car.fastest && p > 0 ? FASTEST_LAP_POINT : 0);
}

/** そのレースの点の倍率 */
export function raceMultiplier(race: CountedRace, rules: SeasonRules = DEFAULT_SEASON_RULES): number {
  if (race.kind === "tournament") return rules.tournamentMul;
  return rules.everydayMul * (isCpuOnlyRace(race.cars) ? rules.cpuOnlyMul : 1);
}

export interface PointAward {
  driverId: string;
  teamId: string;
  pos: number;
  /** 代走 (チームには全部入る。運転手は driverPoints) */
  standIn: boolean;
  /** 季節の点 (整数。チームに入る) */
  points: number;
  /** 運転手順位に入る点。null = 運転手順位に数えない (普段のレースの代走・埋め草の車) */
  driverPoints: number | null;
}

/** 大会の代走の運転手の点: レースの点のこれだけ (切り捨ててから大会の倍率を掛ける。11/25 ユーザー) */
export const STAND_IN_DRIVER_SHARE = 1 / 5;

/** 代走の運転手の点 (レースの種類ごと)。null = 運転手順位に入らない */
export function standInDriverPoints(kind: RaceKind, basePoints: number, mul: number): number | null {
  if (kind !== "tournament") return null;
  return Math.round(Math.floor(basePoints * STAND_IN_DRIVER_SHARE + 1e-9) * mul);
}

/** チームの付いた車ごとの季節の点 */
export function racePointAwards(race: CountedRace, rules: SeasonRules = DEFAULT_SEASON_RULES): PointAward[] {
  const mul = raceMultiplier(race, rules);
  const out: PointAward[] = [];
  for (const c of race.cars) {
    if (c.teamId === null) continue;
    const base = baseRacePoints(c, race.cars.length);
    const points = Math.round(base * mul);
    const standIn = c.standIn === true;
    const driverPoints = c.filler ? null : standIn ? standInDriverPoints(race.kind, base, mul) : points;
    out.push({ driverId: c.driverId, teamId: c.teamId, pos: c.pos, standIn, points, driverPoints });
  }
  return out;
}

// ---------------------------------------------------------------- 季節の集計

export interface Tally {
  points: number;
  /** そのうち大会の点 (同点のときに使う) */
  tournamentPoints: number;
  /** 出たレースの数 */
  races: number;
  /** 順位ごとのゴールの数 (0 番 = 1 位の数)。同点のときに上から比べる */
  finishes: number[];
  /** 最後に点が増えた時刻 (同点なら先にその点に着いたほうが上)。点が 0 なら 0 */
  lastGainAt: number;
}

export interface DriverTally extends Tally {
  /** 最後に走ったチーム */
  teamId: string;
}

export interface SeasonTally {
  season: number;
  teams: Record<string, Tally>;
  drivers: Record<string, DriverTally>;
}

export function emptyTally(): Tally {
  return { points: 0, tournamentPoints: 0, races: 0, finishes: POINTS.map(() => 0), lastGainAt: 0 };
}

export function newSeasonTally(season: number): SeasonTally {
  return { season, teams: {}, drivers: {} };
}

function cloneTally<T extends Tally>(t: T): T {
  return { ...t, finishes: [...t.finishes] };
}

function addTo(t: Tally, points: number, tournament: boolean, at: number, pos: number | null) {
  t.points += points;
  if (tournament) t.tournamentPoints += points;
  if (points > 0) t.lastGainAt = Math.max(t.lastGainAt, at);
  if (pos !== null && pos >= 1 && pos <= t.finishes.length) t.finishes[pos - 1]++;
}

/**
 * 1 レースを季節の集計に足す (新しい集計を返す。元は変えない)。
 * race.at がこの季節の外なら何もしない。同じレースを 2 回足さないのは呼ぶ側の役目。
 */
export function addRaceToTally(tally: SeasonTally, race: CountedRace, rules: SeasonRules = DEFAULT_SEASON_RULES, epoch = SEASON_EPOCH_MS): SeasonTally {
  if (seasonIndexAt(race.at, epoch) !== tally.season) return tally;
  const awards = racePointAwards(race, rules);
  if (awards.length === 0) return tally;
  const teams = { ...tally.teams };
  const drivers = { ...tally.drivers };
  const tour = race.kind === "tournament";
  const byCar = new Map(race.cars.map((c) => [c.driverId, c]));
  const seenTeams = new Set<string>();
  for (const a of awards) {
    const car = byCar.get(a.driverId)!;
    const finishPos = car.finished && !car.dq ? car.pos : null;
    if (a.driverPoints !== null) {
      const d: DriverTally = cloneTally(drivers[a.driverId] ?? { ...emptyTally(), teamId: a.teamId });
      d.teamId = a.teamId;
      d.races++;
      // 代走の順位は運転手の 1 位の数などに数えない (自分で走っていないので)
      addTo(d, a.driverPoints, tour, race.at, a.standIn ? null : finishPos);
      drivers[a.driverId] = d;
    }
    // チームは 2 台の合計。出たレースの数は 1 レース 1 回
    const first = !seenTeams.has(a.teamId);
    const t = first ? cloneTally(teams[a.teamId] ?? emptyTally()) : teams[a.teamId];
    if (first) {
      t.races++;
      seenTeams.add(a.teamId);
    }
    addTo(t, a.points, tour, race.at, finishPos);
    teams[a.teamId] = t;
  }
  return { season: tally.season, teams, drivers };
}

/** 並べ方: 点 → 大会の点 → 1 位の数・2 位の数… → 先にその点に着いた → id */
export function compareTally(a: Tally, aId: string, b: Tally, bId: string): number {
  if (a.points !== b.points) return b.points - a.points;
  if (a.tournamentPoints !== b.tournamentPoints) return b.tournamentPoints - a.tournamentPoints;
  const n = Math.max(a.finishes.length, b.finishes.length);
  for (let i = 0; i < n; i++) {
    const x = a.finishes[i] ?? 0;
    const y = b.finishes[i] ?? 0;
    if (x !== y) return y - x;
  }
  if (a.points > 0 && a.lastGainAt !== b.lastGainAt) return a.lastGainAt - b.lastGainAt;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

export interface RankRow {
  id: string;
  /** 1 から */
  rank: number;
  points: number;
  tournamentPoints: number;
  races: number;
}

function rankOf(map: Record<string, Tally>, ids?: readonly string[]): RankRow[] {
  const list = ids ? [...new Set(ids)] : Object.keys(map);
  const rows = list.map((id) => ({ id, t: map[id] ?? emptyTally() }));
  rows.sort((a, b) => compareTally(a.t, a.id, b.t, b.id));
  return rows.map((r, i) => ({ id: r.id, rank: i + 1, points: r.t.points, tournamentPoints: r.t.tournamentPoints, races: r.t.races }));
}

/** チーム順位 (2 台の合計)。ids を渡すとそのチームだけ (点のないチームも 0 点で並ぶ) */
export function rankTeams(tally: SeasonTally, ids?: readonly string[]): RankRow[] {
  return rankOf(tally.teams, ids);
}

/** 運転手順位 (自分の点だけ。代走で入った点は数えない)。ids を渡すとその運転手だけ */
export function rankDrivers(tally: SeasonTally, ids?: readonly string[]): RankRow[] {
  return rankOf(tally.drivers, ids);
}

// ---------------------------------------------------------------- 級の表と季節の終わり

/** チーム → 級。null = 最初の季節 (級なし、一番下の級に混ざって走る) */
export type ClassTable = Record<string, ClassId | null>;

/** 普段のレースで走る級 (級なし・知らないチームは一番下) */
export function playClassOf(table: ClassTable, teamId: string): ClassId {
  return table[teamId] ?? LOWEST_CLASS;
}

/** 新しいチームを級なしで足す (もういるなら変えない) */
export function registerTeam(table: ClassTable, teamId: string): ClassTable {
  if (teamId in table) return table;
  return { ...table, [teamId]: null };
}

/** その級で並べられるチーム (一番下の級には級なしのチームも混ざる) */
export function teamsInClass(table: ClassTable, cls: ClassId): string[] {
  return Object.keys(table)
    .filter((id) => (table[id] ?? LOWEST_CLASS) === cls)
    .sort();
}

/** 級の中の順位 */
export function classRanking(table: ClassTable, tally: SeasonTally, cls: ClassId): RankRow[] {
  return rankTeams(tally, teamsInClass(table, cls));
}

/**
 * 級の中のチーム数 n のとき、上がる数と下がる数。
 * 仮: 1 チームしかいない級では、そのチームは 1 位なので上がる (下がらない)。2 チーム以上なら 1 位が上がり最下位が下がる
 */
export function moveCounts(cls: ClassId, n: number): { up: number; down: number } {
  return {
    up: cls === TOP_CLASS || n < 1 ? 0 : Math.min(PROMOTE_COUNT, n),
    down: cls === LOWEST_CLASS || n < 2 ? 0 : Math.min(RELEGATE_COUNT, n - 1),
  };
}

export interface ClassMove {
  teamId: string;
  from: ClassId | null;
  to: ClassId;
}

export interface SeasonClose {
  /** 次の季節の級の表 (全チームに級が付く) */
  next: ClassTable;
  /** 級が変わった・付いたチーム */
  moves: ClassMove[];
  /** 終わった季節の級ごとの順位 (賞金に使う) */
  rankings: Record<ClassId, RankRow[]>;
  /** 終わった季節の運転手順位 (全体) */
  drivers: RankRow[];
  /** 次の季節の空の集計 (点は 0 から) */
  nextTally: SeasonTally;
}

/**
 * 季節を締める。級ごとに並べて、上位を 1 つ上へ・下位を 1 つ下へ。
 * 級なしのチームは一番下の級の順位に混ざり、上位なら 1 つ上 (4 級)、それ以外は一番下の級になる。
 */
export function closeSeason(table: ClassTable, tally: SeasonTally): SeasonClose {
  const next: ClassTable = {};
  const moves: ClassMove[] = [];
  const rankings = {} as Record<ClassId, RankRow[]>;
  for (const cls of CLASS_IDS) {
    const rows = classRanking(table, tally, cls);
    rankings[cls] = rows;
    const { up, down } = moveCounts(cls, rows.length);
    rows.forEach((r, i) => {
      let to: ClassId = cls;
      if (i < up) to = (cls - 1) as ClassId;
      else if (i >= rows.length - down) to = (cls + 1) as ClassId;
      next[r.id] = to;
      const from = table[r.id] ?? null;
      if (from !== to) moves.push({ teamId: r.id, from, to });
    });
  }
  return { next, moves, rankings, drivers: rankDrivers(tally), nextTally: newSeasonTally(tally.season + 1) };
}
