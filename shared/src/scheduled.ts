// 2 時間ごとの自動のレース (全部 仮): 日本時間 0・2・4 … 22 時に、server がリーグ戦 (league.ts) のレースを走らせる。
// 人は運転しない: 人のチームの 2 台もコンピューター (自分の車は代走 = 普通の上手さ・走る前の予定のまま、2 台目は雇った運転手)。
// 名前のあるコンピューターのチーム (ライバル) は、その 2 人の運転手で走る。
// 待合も「もうすぐ」の知らせもなし。server が画面なしで全部のリーグのレースを走らせ、結果だけを保存する。各チームは自分の結果を見られる。
// リーグの 4 チーム (8 台) が毎回全員一緒に走る (リーグにつき 1 レース。くじで組に分けるのはやめた、11/25)。
// 並び (スタートの順) はくじ: レースの seed (枠とリーグで決まる) で混ぜるので、同じレースはいつも同じ並び。
// 点は季節の点に入らず、リーグ戦の順位だけ (addLeagueRace)。5 周。コースは公式コースを順番に回す。
import { activeLeagues, LEAGUE_TEAMS, leagueTeams, type LeagueState } from "./league.ts";
import { MAX_CARS } from "./room.ts";
import { rotationTrackIds } from "./tracks.ts";

/** 間隔 */
export const SCHEDULED_EVERY_MS = 2 * 3_600_000;
/** 日本時間の時差 (日本は夏時間なし) */
export const SCHEDULED_TZ_OFFSET_MS = 9 * 3_600_000;
export const SCHEDULED_LAPS = 5;
/** 1 レースのチームの数 (リーグの全部) */
export const SCHEDULED_TEAMS_PER_RACE = LEAGUE_TEAMS;
/** 1 チームの車 */
const CARS_PER_TEAM = 2;

/** 枠の番号 (1970-01-01 0:00 日本時間からの 2 時間の数) */
export function scheduledSlotIndex(t: number): number {
  return Math.floor((t + SCHEDULED_TZ_OFFSET_MS) / SCHEDULED_EVERY_MS);
}

/** 枠の番号のスタートの時刻 (ms) */
export function scheduledSlotStart(index: number): number {
  return index * SCHEDULED_EVERY_MS - SCHEDULED_TZ_OFFSET_MS;
}

/** t より後 (t ちょうどは含まない) の次のスタートの時刻 */
export function nextScheduledAt(t: number): number {
  return scheduledSlotStart(scheduledSlotIndex(t) + 1);
}

/** その枠のコース: 公式コースを順番に (枠の番号で回す)。コースは枠の始まりに回し方に入っているもの (tracks.ts の TRACK_ROTATION_FROM) */
export function scheduledTrackId(slotStart: number, trackIds: readonly string[] = rotationTrackIds(slotStart)): string {
  if (trackIds.length === 0) throw new Error("no tracks");
  const i = scheduledSlotIndex(slotStart);
  return trackIds[((i % trackIds.length) + trackIds.length) % trackIds.length];
}

function lcg(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 枠とリーグから決まる seed (server が別の seed を渡してもよい) */
export function scheduledSeed(slot: number, leagueId: string): number {
  return (Math.imul(slot, 2654435761) ^ hashStr(leagueId)) >>> 0;
}

/** seed で混ぜた並び (同じ seed・同じ並びなら同じ結果)。元の配列は変えない */
export function shuffleBySeed<T>(items: readonly T[], seed: number): T[] {
  const list = [...items];
  const r = lcg(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** スタートの並びのくじの seed (レースの seed から。走りの seed とは別の流れ) */
export function scheduledGridSeed(race: Pick<ScheduledRacePlan, "seed">): number {
  return (race.seed ^ 0x9e3779b9) >>> 0;
}

export interface ScheduledRacePlan {
  /** レースの名前 (結果の保存に使う) */
  raceId: string;
  /** 枠の番号 (scheduledSlotIndex) */
  slot: number;
  leagueId: string;
  division: number;
  /** 同じ部の何番目のリーグ (0 = A) */
  leagueIndex: number;
  /** 出るチーム (リーグの全部、id の順。スタートの並びは scheduledEntries がくじで決める) */
  teams: string[];
  /** 名前の無いコンピューターの車の数 (ふつう 0) */
  fillerCars: number;
  /** このレースの走りの seed (makeWeatherPlan・makeBrain など)。スタートの並びのくじもここから */
  seed: number;
}

export interface ScheduledPlan {
  slot: number;
  startsAt: number;
  trackId: string;
  laps: number;
  races: ScheduledRacePlan[];
}

/** 計算の順: 枠の古い順 → 1 部から 8 部 → 同じ部は A・B … */
export function compareScheduledRaces(a: ScheduledRacePlan, b: ScheduledRacePlan): number {
  return a.slot - b.slot || a.division - b.division || a.leagueIndex - b.leagueIndex;
}

/** その枠のレースの予定。人のいるリーグごとに 1 レース (4 チーム全員)。並びは計算の順 (1 部から、同じ部は A から) */
export function planScheduledRaces(slotStart: number, leagues: LeagueState, trackIds?: readonly string[]): ScheduledPlan {
  const slot = scheduledSlotIndex(slotStart);
  const startsAt = scheduledSlotStart(slot);
  const races: ScheduledRacePlan[] = [];
  for (const l of activeLeagues(leagues)) {
    const teams = [...new Set(leagueTeams(l))].sort();
    races.push({
      raceId: `sched-${slot}-${l.id}`,
      slot,
      leagueId: l.id,
      division: l.division,
      leagueIndex: l.index,
      teams,
      fillerCars: Math.max(0, MAX_CARS - teams.length * CARS_PER_TEAM),
      seed: (scheduledSeed(slot, l.id) + 1) >>> 0,
    });
  }
  races.sort(compareScheduledRaces);
  return { slot, startsAt, trackId: scheduledTrackId(startsAt, trackIds), laps: SCHEDULED_LAPS, races };
}

// ---------------------------------------------------------------- 計算が追いつかないとき (仮)

/** この数の枠 (2 枠 = 4 時間) 以上古い残りは計算しない */
export const SCHEDULED_DROP_AFTER_SLOTS = 2;

export interface ScheduledQueue {
  /** 計算する順 (前の枠の残り → 今の枠の 1 部から) */
  run: ScheduledRacePlan[];
  /** 古すぎて計算しないレース (結果は「計算していない」、点も賞金も無し) */
  dropped: ScheduledRacePlan[];
}

/**
 * 新しい枠が来たときの計算の順番。leftovers = まだ計算していない前の枠までのレース、fresh = 今の枠の予定。
 * 今の枠から SCHEDULED_DROP_AFTER_SLOTS 枠以上古い残りは落とす。同じレースが両方にあっても 1 回だけ
 */
export function scheduledQueue(leftovers: readonly ScheduledRacePlan[], fresh: readonly ScheduledRacePlan[], currentSlot: number): ScheduledQueue {
  const seen = new Set<string>();
  const uniq = (r: ScheduledRacePlan) => !seen.has(r.raceId) && (seen.add(r.raceId), true);
  const all = [...leftovers, ...fresh].filter(uniq).sort(compareScheduledRaces);
  const dropped = all.filter((r) => currentSlot - r.slot >= SCHEDULED_DROP_AFTER_SLOTS);
  const run = all.filter((r) => currentSlot - r.slot < SCHEDULED_DROP_AFTER_SLOTS);
  return { run, dropped };
}

/** 落としたレースの記録 (各チームが「計算していない」と見られるように。点・賞金は付けない) */
export interface SkippedScheduledRace {
  raceId: string;
  slot: number;
  leagueId: string;
  teams: string[];
  status: "not_computed";
}

export function skippedRecord(r: ScheduledRacePlan): SkippedScheduledRace {
  return { raceId: r.raceId, slot: r.slot, leagueId: r.leagueId, teams: [...r.teams], status: "not_computed" };
}

/** 人のチームの 2 台 (どちらもコンピューターが運転する) */
export interface TeamDrivers {
  teamId: string;
  /** 遊ぶ人の運転手 (代走で走る) */
  ownDriverId: string;
  /** 雇った運転手 (いなければ null。そのときは 1 台だけ) */
  hiredDriverId: string | null;
}

export interface ScheduledCarEntry {
  /** 人のチームの車なら運転手の id。ライバルの車なら "<チーム id>#0" / "#1" (server がライバルの運転手に結びつける) */
  driverId: string;
  teamId: string;
  /** 自分の車 = 代走 (STAND_IN_SKILL)。雇った運転手・ライバルは false */
  standIn: boolean;
  /** 名前のあるコンピューターのチーム (ライバル) の車 */
  rival: boolean;
}

/**
 * レースのチームから走る車の一覧を作る。drivers に無いチームはライバル (2 台) として扱う。
 * 返す並びがスタートの並び (1 番目がポール): くじで決まり (scheduledGridSeed)、同じレース・同じ車ならいつも同じ。
 * drivers を渡す並びには左右されない (大会は予選の順のまま。ここは 2 時間ごとのリーグ戦だけ)
 */
export function scheduledEntries(race: ScheduledRacePlan, drivers: readonly TeamDrivers[]): ScheduledCarEntry[] {
  const byTeam = new Map(drivers.map((d) => [d.teamId, d]));
  const out: ScheduledCarEntry[] = [];
  // くじの前の並びは id の順にそろえる (teams・drivers の渡す並びでスタートの並びが変わらないように)
  for (const t of [...new Set(race.teams)].sort()) {
    const d = byTeam.get(t);
    if (!d) {
      out.push({ driverId: `${t}#0`, teamId: t, standIn: false, rival: true }, { driverId: `${t}#1`, teamId: t, standIn: false, rival: true });
      continue;
    }
    out.push({ driverId: d.ownDriverId, teamId: t, standIn: true, rival: false });
    if (d.hiredDriverId !== null) out.push({ driverId: d.hiredDriverId, teamId: t, standIn: false, rival: false });
  }
  return shuffleBySeed(out, scheduledGridSeed(race));
}

/** そのチームの出たレースだけ (各チームは自分の結果を見られる) */
export function scheduledResultsFor<T extends { teams: readonly string[] }>(races: readonly T[], teamId: string): T[] {
  return races.filter((r) => r.teams.includes(teamId));
}
