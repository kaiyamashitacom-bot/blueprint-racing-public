// リーグ戦 (2 時間ごとの自動のレースの順位)。季節の点・級 (5 つ) とは別のもの。級の上がり下がりには関係しない。
// 決めごと (ユーザー 11/25): 1 リーグ 4 チーム (8 台)。2 時間ごとのレースはリーグの 4 チームが毎回全員一緒に走る。
//   仮: ふつう人のチーム 2 つ + 名前のあるコンピューターのチーム 2 つ。人が足りないリーグはコンピューターで埋める。
//   部は 1 部〜8 部の 8 つ。人が増えたらリーグを足す。部の入れ替えは毎日、部の境ごとに 2 人 (上のリーグの下の人と、下のリーグの上の人)。
//   1 部の上に「王者」の肩書き。
// 仮 (取りまとめ役が決めた):
// - 1 日 = 日本時間 0:00〜22:00 の 12 レース。22:00 のレースのあとに締める (closeLeagueDay)。点は毎日 0 に戻る
// - 1 日の順位 = その日の点の合計 → 勝った数 → 最後のレースの結果 (チームの良いほうの順位) → id
// - 部の境ごとに、上のリーグの下の人が下へ、下のリーグの上の人が上へ (入れ替え)。1 部の一番上と 8 部の一番下は動かない
// - 人が 1 チームだけのリーグ: 上半分 (1〜2 位) なら上の境の入れ替えに、下半分なら下の境の入れ替えに出る。相手のいない境はその日は入れ替えなし
// - 同じ部にリーグが何個もあるとき (B・C …) は A↔A・B↔B で組み、上に同じ字のリーグが無ければ順番に (B→A、C→A …)。
//   上のリーグは 1 日に何回でも入れ替えに出られる (下へ行ける人がいる間。2 人目は上の境で上がらない上のほうの人、1 部の一番上は除く)
// - 新しい人は 8 部から。人の空きがある一番下の部のリーグに入る。空きが無ければ 8 部のリーグを足す (8 部 B …)
// - 人が 1 チームだけのリーグは、空きをコンピューターのチームで埋める
// - コンピューターのチームは上の部ほど強く、ずっと同じリーグに残る (ライバル)
// - 毎日、各リーグの上位 2 (4 チーム中) の人のチームに少しの賞金 (下の部ほど多い)。はんこは週に 1 つ、その週に着いた一番上の部のもの
// - 王者: 毎日の締めで、1 部の人のチームのうち一番の 1 チームが次の締めまで王者 (コンピューターはなれない)。
//   1 部のリーグが何個もあるときは、その日の点 → 勝った数で比べる
// 点はチームの 2 台の F1 の点の合計 (倍率なし)。時刻は ms。
import { baseRacePoints, seasonIndexAt, SEASON_EPOCH_MS, type RaceCar } from "./season.ts";

export const DIVISION_COUNT = 8;
export const TOP_DIVISION = 1;
export const LOWEST_DIVISION = 8;
/** 1 リーグのチームの数 */
export const LEAGUE_TEAMS = 4;
/** 1 リーグの人のチームの数 */
export const LEAGUE_HUMANS = 2;
/** 人が 2 チームそろったリーグのコンピューターのチームの数 (rivals.ts の RIVAL.perLeague と同じ)。人が 1 チームなら 3 */
export const LEAGUE_CPUS = LEAGUE_TEAMS - LEAGUE_HUMANS;
/** 毎日の締めで賞金をもらう上位の数 */
export const LEAGUE_PRIZE_RANKS = 2;
/** 日の切れ目の時差 (日本時間) */
export const LEAGUE_TZ_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** 1 部の上の特別な肩書き */
export const CHAMPION_TITLE = "王者";
/** 部の肩書き (仮)。季節の間、チーム名の横に出す。添字 = 部 (1 部 = 一番上) */
export const DIVISION_TITLES: Readonly<Record<number, string>> = {
  1: "技術監督",
  2: "技術部長",
  3: "主任設計技師",
  4: "上級設計技師",
  5: "設計技師",
  6: "設計助手",
  7: "製図工",
  8: "製図見習い",
};

function clampDivision(d: number): number {
  return Math.max(TOP_DIVISION, Math.min(LOWEST_DIVISION, Math.floor(d)));
}

/** 部 → 肩書き (範囲の外は端の部に寄せる) */
export function divisionTitle(division: number): string {
  return DIVISION_TITLES[clampDivision(division)];
}

/** 部ごとのコンピューターのチームの強さ (仮)。skill は makeBrain / ライバルの運転手の目安、partTier は部品の段階の目安 */
export function divisionCpuStrength(division: number): { skillMin: number; skillMax: number; partTier: number } {
  const d = clampDivision(division);
  const up = LOWEST_DIVISION - d; // 8 部 = 0、1 部 = 7
  const skillMin = Math.round((0.62 + up * 0.035) * 1000) / 1000;
  const skillMax = Math.min(1, Math.round((skillMin + 0.14) * 1000) / 1000);
  const partTier = [5, 4, 4, 3, 3, 2, 1, 1][d - 1];
  return { skillMin, skillMax, partTier };
}

/** 時刻 t の日の番号 (日本時間の日付ごと) */
export function leagueDayAt(t: number): number {
  return Math.floor((t + LEAGUE_TZ_OFFSET_MS) / DAY_MS);
}

/** 日の番号の 0:00 (日本時間) */
export function leagueDayStart(day: number): number {
  return day * DAY_MS - LEAGUE_TZ_OFFSET_MS;
}

export interface League {
  /** 例 "d8-0" (8 部の 1 つ目) */
  id: string;
  division: number;
  /** 同じ部の何番目 (0 = A) */
  index: number;
  /** 人のチーム (LEAGUE_HUMANS まで) */
  humans: string[];
  /** コンピューターのチーム (人 + これ = LEAGUE_TEAMS)。id は server がライバルのチームに結びつける */
  cpus: string[];
  /** 次に作るコンピューターのチームの番号 */
  nextCpu: number;
}

/** 1 日の 1 チームの集計 */
export interface DayTally {
  points: number;
  wins: number;
  races: number;
  /** 最後に走ったレースの時刻と、そのときのチームの良いほうの順位 (ゴールしていなければ 99) */
  lastAt: number;
  lastPos: number;
}

export interface LeagueState {
  /** 今の日の番号 (leagueDayAt) */
  day: number;
  leagues: League[];
  /** リーグ → チーム → 今日の集計 */
  tally: Record<string, Record<string, DayTally>>;
  /** 人のチーム → 今週走った一番上の部 (週の切れ目のはんこ用) */
  weekBest: Record<string, number>;
  /** 今の王者 (人のチーム)。いなければ null */
  champion: string | null;
}

export function newLeagueState(day: number): LeagueState {
  return { day, leagues: [], tally: {}, weekBest: {}, champion: null };
}

export function leagueId(division: number, index: number): string {
  return `d${division}-${index}`;
}

/** 画面用の名前: 8 部、8 部 B、8 部 C … */
export function leagueName(l: Pick<League, "division" | "index">): string {
  if (l.index === 0) return `${l.division} 部`;
  const letter = String.fromCharCode(65 + (l.index % 26));
  return `${l.division} 部 ${letter}${l.index >= 26 ? Math.floor(l.index / 26) : ""}`;
}

/** リーグの 4 チーム (人が先) */
export function leagueTeams(l: League): string[] {
  return [...l.humans, ...l.cpus];
}

/** 人の数に合わせてコンピューターのチームを足し引きする (減らすときは後から入ったほうから) */
function fitCpus(l: League): League {
  const want = Math.max(0, LEAGUE_TEAMS - l.humans.length);
  const cpus = l.cpus.slice(0, want);
  let next = l.nextCpu;
  while (cpus.length < want) cpus.push(`${l.id}-cpu${next++}`);
  return { ...l, cpus, nextCpu: next };
}

function makeLeague(division: number, index: number): League {
  return fitCpus({ id: leagueId(division, index), division, index, humans: [], cpus: [], nextCpu: 0 });
}

function sortLeagues(ls: League[]): League[] {
  return ls.sort((a, b) => b.division - a.division || a.index - b.index);
}

export function findLeagueOf(state: LeagueState, teamId: string): League | null {
  return state.leagues.find((l) => l.humans.includes(teamId) || l.cpus.includes(teamId)) ?? null;
}

/** 今そのチームがいる部。どこにもいなければ null */
export function divisionOf(state: LeagueState, teamId: string): number | null {
  return findLeagueOf(state, teamId)?.division ?? null;
}

/** チーム名の横に出す肩書き (王者 > 部の肩書き)。リーグにいなければ null */
export function teamTitle(state: LeagueState, teamId: string): string | null {
  if (state.champion === teamId) return CHAMPION_TITLE;
  const d = divisionOf(state, teamId);
  return d === null ? null : divisionTitle(d);
}

/** 新しい人のチームを入れる: 人の空きがある一番下の部のリーグ、無ければ 8 部にリーグを足す */
export function joinLeague(state: LeagueState, teamId: string): LeagueState {
  if (findLeagueOf(state, teamId)) return state;
  const leagues = [...state.leagues];
  let i = -1;
  for (let d = LOWEST_DIVISION; d >= TOP_DIVISION && i < 0; d--) {
    i = leagues.findIndex((l) => l.division === d && l.humans.length < LEAGUE_HUMANS);
  }
  if (i < 0) {
    const index = leagues.filter((l) => l.division === LOWEST_DIVISION).reduce((m, l) => Math.max(m, l.index + 1), 0);
    leagues.push(makeLeague(LOWEST_DIVISION, index));
    i = leagues.length - 1;
  }
  leagues[i] = fitCpus({ ...leagues[i], humans: [...leagues[i].humans, teamId] });
  return { ...state, leagues: sortLeagues(leagues) };
}

/** 退会したチームを外す (空いた席はコンピューターが埋める。王者なら王者もいなくなる) */
export function leaveLeague(state: LeagueState, teamId: string): LeagueState {
  const l = state.leagues.find((x) => x.humans.includes(teamId));
  if (!l) return state;
  const weekBest = { ...state.weekBest };
  delete weekBest[teamId];
  return {
    ...state,
    leagues: state.leagues.map((x) => (x === l ? fitCpus({ ...x, humans: x.humans.filter((h) => h !== teamId) }) : x)),
    weekBest,
    champion: state.champion === teamId ? null : state.champion,
  };
}

/**
 * 管理者のギフトコードで部を動かす (日の締めのあと、次の日のはじめに効く)。
 * 今のリーグから外し、その部で人の空きがあるリーグへ入れる。空きが無ければその部にリーグを足す。
 * リーグにいないチーム・同じ部なら そのまま (state を返す)。王者と今週の一番上の部はそのまま
 */
export function moveTeamToDivision(state: LeagueState, teamId: string, division: number): LeagueState {
  const d = clampDivision(division);
  const from = state.leagues.find((x) => x.humans.includes(teamId));
  if (!from || from.division === d) return state;
  let leagues = state.leagues.map((x) => (x === from ? fitCpus({ ...x, humans: x.humans.filter((h) => h !== teamId) }) : x));
  let i = leagues.findIndex((l) => l.division === d && l.humans.length < LEAGUE_HUMANS);
  if (i < 0) {
    const index = leagues.filter((l) => l.division === d).reduce((m, l) => Math.max(m, l.index + 1), 0);
    leagues = [...leagues, makeLeague(d, index)];
    i = leagues.length - 1;
  }
  leagues[i] = fitCpus({ ...leagues[i], humans: [...leagues[i].humans, teamId] });
  return { ...state, leagues: sortLeagues(leagues) };
}

/** 人のいるリーグ (自動のレースを走らせるリーグ) */
export function activeLeagues(state: LeagueState): League[] {
  return state.leagues.filter((l) => l.humans.length > 0);
}

// ---------------------------------------------------------------- 点と順位

function emptyDay(): DayTally {
  return { points: 0, wins: 0, races: 0, lastAt: 0, lastPos: 99 };
}

/**
 * 自動のレース 1 回の結果をリーグに足す。slotStart はそのレースの枠の時刻 (今日の外なら何もしない)。
 * cars の teamId は人のチームかコンピューターのチームの id (名前の無い空き埋め = null は数えない)。
 */
export function addLeagueRace(state: LeagueState, leagueIdOf: string, cars: readonly RaceCar[], slotStart: number): LeagueState {
  if (leagueDayAt(slotStart) !== state.day) return state;
  const league = state.leagues.find((l) => l.id === leagueIdOf);
  if (!league) return state;
  const members = new Set(leagueTeams(league));
  const table = { ...(state.tally[leagueIdOf] ?? {}) };
  const seen = new Set<string>();
  for (const c of cars) {
    if (c.teamId === null || !members.has(c.teamId)) continue;
    const t: DayTally = seen.has(c.teamId) ? table[c.teamId] : { ...(table[c.teamId] ?? emptyDay()), lastAt: slotStart, lastPos: 99 };
    if (!seen.has(c.teamId)) {
      t.races++;
      seen.add(c.teamId);
    }
    t.points += baseRacePoints(c, cars.length);
    const ok = c.finished && !c.dq;
    if (ok && c.pos === 1) t.wins++;
    if (ok) t.lastPos = Math.min(t.lastPos, c.pos);
    table[c.teamId] = t;
  }
  return { ...state, tally: { ...state.tally, [leagueIdOf]: table } };
}

/** 1 日の比べ方: 点 → 勝った数 → 最後のレースの結果 → id */
export function compareDay(a: DayTally, aId: string, b: DayTally, bId: string): number {
  if (a.points !== b.points) return b.points - a.points;
  if (a.wins !== b.wins) return b.wins - a.wins;
  if (a.lastPos !== b.lastPos) return a.lastPos - b.lastPos;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

export interface LeagueRow {
  id: string;
  rank: number;
  points: number;
  wins: number;
  races: number;
  human: boolean;
}

/** リーグの今日の順位 (4 チーム全部) */
export function leagueStandings(state: LeagueState, leagueIdOf: string): LeagueRow[] {
  const l = state.leagues.find((x) => x.id === leagueIdOf);
  if (!l) return [];
  const table = state.tally[leagueIdOf] ?? {};
  const t = (id: string) => table[id] ?? emptyDay();
  return leagueTeams(l)
    .sort((a, b) => compareDay(t(a), a, t(b), b))
    .map((id, i) => ({ id, rank: i + 1, points: t(id).points, wins: t(id).wins, races: t(id).races, human: l.humans.includes(id) }));
}

// ---------------------------------------------------------------- 毎日の締め

export interface LeagueAward {
  teamId: string;
  leagueId: string;
  division: number;
  rank: number;
  points: number;
}

export interface LeagueSwap {
  /** 上の部へ行くチーム (下のリーグの上の人) と元のリーグ */
  up: { teamId: string; from: string; to: string };
  /** 下の部へ行くチーム (上のリーグの下の人) と元のリーグ */
  down: { teamId: string; from: string; to: string };
}

export interface WeekStamp {
  teamId: string;
  /** その週に走った一番上の部 */
  division: number;
}

export interface LeagueDayClose {
  /** 次の日のリーグ (点は 0) */
  next: LeagueState;
  /** 各リーグの上位 2 (LEAGUE_PRIZE_RANKS) の人のチーム (点が 0 は除く)。賞金は adminconfig の leaguePrizeFor */
  awards: LeagueAward[];
  swaps: LeagueSwap[];
  /** 締めた日の順位 (リーグ → 順位) */
  standings: Record<string, LeagueRow[]>;
  /** 次の締めまでの王者 */
  champion: string | null;
  /** 週の終わりの日なら、人のチームごとの週のはんこ (stamps の weekDivisionStamp)。そうでなければ空 */
  weekStamps: WeekStamp[];
}

/**
 * 上のリーグから下へ行ける人の順 (2 人なら下のほうが先。上のほうは、上の境で上がらないときだけ 2 人目として出せる。
 * ただし 1 部の一番上は動かない)。1 人なら下半分のときだけ
 */
function downCandidates(rows: LeagueRow[], division: number): LeagueRow[] {
  const h = rows.filter((r) => r.human);
  if (h.length >= 2) return division === TOP_DIVISION ? [h[h.length - 1]] : [...h].reverse();
  if (h.length === 1 && h[0].rank > LEAGUE_TEAMS / 2) return [h[0]];
  return [];
}

/** 下のリーグから上へ行く人 (2 人なら上のほう、1 人なら上半分のときだけ) */
function upCandidate(rows: LeagueRow[]): LeagueRow | null {
  const h = rows.filter((r) => r.human);
  if (h.length >= 2) return h[0];
  if (h.length === 1 && h[0].rank <= LEAGUE_TEAMS / 2) return h[0];
  return null;
}

/**
 * その日を締める (22:00 のレースの結果を足したあとに呼ぶ)。
 * 賞金の順位・部の境の入れ替え・王者・(週の終わりなら) 週のはんこ を決め、点を 0 にした次の日を返す。
 */
export function closeLeagueDay(state: LeagueState, epoch = SEASON_EPOCH_MS): LeagueDayClose {
  const standings: Record<string, LeagueRow[]> = {};
  const awards: LeagueAward[] = [];
  for (const l of state.leagues) {
    const rows = leagueStandings(state, l.id);
    standings[l.id] = rows;
    for (const r of rows.slice(0, LEAGUE_PRIZE_RANKS)) {
      if (r.human && r.points > 0) awards.push({ teamId: r.id, leagueId: l.id, division: l.division, rank: r.rank, points: r.points });
    }
  }
  // 週のはんこ用: 今日走った部 (入れ替えの前)
  const weekBest = { ...state.weekBest };
  for (const l of state.leagues) for (const h of l.humans) weekBest[h] = Math.min(weekBest[h] ?? LOWEST_DIVISION + 1, l.division);
  // 部の境の入れ替え (上の境から順に)。下のリーグは 上のリーグと 順番に組む (A→A、B→B、相手が無ければ B→A、C→A …)。
  // 組んだ上のリーグに下へ行ける人が残っていなければ、上の部のほかのリーグを順に当たる。
  // どのリーグが先に組むかは日ごとに回す (いつも同じリーグが余らないように)。どの入れ替えも 1 人と 1 人なので、人は 2 人のまま
  const byId = new Map(state.leagues.map((l) => [l.id, { ...l, humans: [...l.humans] }]));
  const swaps: LeagueSwap[] = [];
  /** 今日すでに動く人 (2 回は動かない) */
  const moving = new Set<string>();
  for (let d = TOP_DIVISION; d < LOWEST_DIVISION; d++) {
    const uppers = state.leagues.filter((l) => l.division === d).sort((a, b) => a.index - b.index);
    const lowers = state.leagues.filter((l) => l.division === d + 1).sort((a, b) => a.index - b.index);
    if (uppers.length === 0 || lowers.length === 0) continue;
    const start = ((state.day % lowers.length) + lowers.length) % lowers.length;
    for (let k = 0; k < lowers.length; k++) {
      const i = (start + k) % lowers.length;
      const lower = lowers[i];
      const up = upCandidate(standings[lower.id]);
      if (!up || moving.has(up.id)) continue;
      const first = i % uppers.length;
      for (let j = 0; j < uppers.length; j++) {
        const upper = uppers[(first + j) % uppers.length];
        const down = downCandidates(standings[upper.id], d).find((r) => !moving.has(r.id));
        if (!down) continue;
        const U = byId.get(upper.id)!;
        const L = byId.get(lower.id)!;
        U.humans = U.humans.map((h) => (h === down.id ? up.id : h));
        L.humans = L.humans.map((h) => (h === up.id ? down.id : h));
        moving.add(up.id);
        moving.add(down.id);
        swaps.push({ up: { teamId: up.id, from: lower.id, to: upper.id }, down: { teamId: down.id, from: upper.id, to: lower.id } });
        break;
      }
    }
  }
  // 王者: 1 部の人のチームのうち、その日の点 → 勝った数 (→ 最後のレース → id) で一番
  let champ: { id: string; t: DayTally } | null = null;
  for (const l of state.leagues.filter((x) => x.division === TOP_DIVISION)) {
    for (const h of l.humans) {
      const t = state.tally[l.id]?.[h] ?? emptyDay();
      if (!champ || compareDay(t, h, champ.t, champ.id) < 0) champ = { id: h, t };
    }
  }
  const champion = champ ? champ.id : null;
  // 週の終わり
  const nextDay = state.day + 1;
  const weekEnds = seasonIndexAt(leagueDayStart(nextDay), epoch) !== seasonIndexAt(leagueDayStart(state.day), epoch);
  const weekStamps: WeekStamp[] = weekEnds
    ? Object.keys(weekBest)
        .sort()
        .filter((id) => weekBest[id] <= LOWEST_DIVISION)
        .map((id) => ({ teamId: id, division: weekBest[id] }))
    : [];
  const next: LeagueState = {
    day: nextDay,
    leagues: sortLeagues([...byId.values()].map(fitCpus)),
    tally: {},
    weekBest: weekEnds ? {} : weekBest,
    champion,
  };
  return { next, awards, swaps, standings, champion, weekStamps };
}
