// 季節と大会の保存 (SQLite) と /api/season・/api/tournaments・/api/admin/... の受け口。
// アカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。中身の計算は shared (season.ts・tournament.ts・stamps.ts・
// constructors.ts・driverchamps.ts・adminconfig.ts・notify.ts・tireset.ts)。
// - チームの id は アカウントの番号の文字列 (team.ts と同じ)。人の運転手の id は "h<番号>"、雇った運転手は運転手の候補の id
// - 1 つのレースは raceId で 1 回だけ数える (season_races)。賞金も同じ取りまとめ (transaction) の中で払う
// - 季節の締め (月曜 0:00 日本時間) は 1 季節ずつ、取りまとめ 1 回で: 級の入れ替え・チャンピオン・賞金・はんこ・記録・表示名を変えてよい印
//   運転手の契約の更新は team.ts が季節の切れ目に自分でする (ここではしない。賞金を先に入れるため、DO は先にこちらを呼ぶ)
// - 大会: 予選 (好きなときに一人で走る、タイヤの組は持ち越し) → スタートの LOBBY_LEAD_MS 前に組 (8 台ずつ) を作り、部屋の DO に渡す →
//   組ごとの結果が全部そろったら (か、締め切りを過ぎたら) 決める (classifyTournament)。点は ×10 で季節へ
// 時刻はみんな deps.now から (試験と、作るときの時計ずらし用)。
import {
  CLASS_IDS,
  DEFAULT_ADMIN_CONFIG,
  NOTICE_TITLES,
  STAMP_DEFS,
  TIRE_DEFS,
  TRACK_DEFS,
  addRaceToTally,
  addStamps,
  allocRules,
  applyAdminPatch,
  applyQualiRun,
  baseRacePoints,
  changeQualiAlloc,
  checkTaSubmission,
  classRanking,
  classifyTournament,
  cloneAdminConfig,
  closeSeason,
  computeStats,
  designFits,
  constructorsByClass,
  constructorsOverall,
  decodeGhost,
  designHash,
  driverChampionOverall,
  driverChampionsByClass,
  dueNotices,
  fuelPerMeter,
  getTrack,
  historyEntry,
  newQualiTires,
  newSeasonTally,
  nextNoticeAt,
  normalizeAlloc,
  playClassOf,
  qualifyWindow,
  qualifyingTable,
  raceSetupFromQuali,
  racePrizeFor,
  raceStamps,
  registerTeam,
  seasonIndexAt,
  seasonPrizeFor,
  seasonStamps,
  seasonWindow,
  setOptions,
  stampsForDisplay,
  startFromSets,
  tournamentGrid,
  tournamentPhaseAt,
  tournamentWeatherPlan,
  validateAdminConfig,
  validateAlloc,
  validateDesign,
  validateTournament,
  isTireCompound,
  type AdminConfig,
  type CarDesign,
  type ClassId,
  type ClassTable,
  type ConstructorLeagueAcc,
  type CountedRace,
  type DriverPool,
  type FixedCar,
  type FixedCarResult,
  type FixedField,
  type JoinTeam,
  type QualiTires,
  type QualifyAttempt,
  type RaceCar,
  type RankRow,
  type SeasonTally,
  type SetPick,
  type Sky,
  type StampBook,
  type StampId,
  type TeamHistoryEntry,
  type TournamentCarResult,
  type TournamentSpec,
  type TournamentWeather,
} from "@bpr/shared";
import {
  DAILY_TOUR,
  STAND_IN_SKILL,
  applyFamiliarity,
  checkTournamentPrizes,
  dailyTourDayDue,
  describeGiftItem,
  dailyTourSettings,
  dailyTourSpec,
  driverBrain,
  driverCarScales,
  driverTraits,
  estimatedLap,
  jstDayStart,
  makeBrain,
  nextDailyTourOpen,
  prizeSummary,
  simulateRace,
  tournamentPrizeAwards,
  tournamentPrizesOf,
  type GiftItem,
  type HeadlessCarSpec,
} from "@bpr/shared";
import { ApiError, parseDesign, type Account, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";
import type { LeagueTeamData } from "./league_accounts.ts";
import { PRIZE_ITEMS, addPrize, advanceChampionStreak, rpForRace, type ChampionStreak, type PrizeGrants } from "@bpr/shared";
import { grantItems } from "./items.ts";
import { ensureRpSchema, earnRaceFinish, earnRacePoints } from "./racepoints.ts";
import { AdminConfigLog, type AdminBy, type AdminConfigAction } from "./admin_config_log.ts";
import { adminErrorTexts } from "@bpr/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS season_kv (
  k TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS season_races (
  race_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS season_closed (
  season INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stamp_books (
  team_id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_history (
  team_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (team_id, season)
);
CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tour_quali (
  tid TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  best_ms INTEGER,
  best_at INTEGER,
  body TEXT NOT NULL,
  PRIMARY KEY (tid, account_id)
);
CREATE TABLE IF NOT EXISTS tour_groups (
  tid TEXT NOT NULL,
  grp INTEGER NOT NULL,
  at INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (tid, grp)
);
CREATE TABLE IF NOT EXISTS tour_here (
  tid TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (tid, account_id)
);
CREATE TABLE IF NOT EXISTS league_days (
  day_key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`;

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/** 大会の組の部屋を開く (待合を始める) のは、スタートのこれだけ前 (仮) */
export const LOBBY_LEAD_MS = 10 * MIN_MS;
/** 大会の組の大きさ (はじめの値と幅。管理者が大会ごとに変えられる。仮) */
export const TOUR_GROUP_SIZE = 8;
export const TOUR_GROUP_MIN = 2;
export const TOUR_GROUP_MAX = 8;
/** 組の結果を待つ締め切り: スタート + 周 × 4 分 + 15 分 (仮。そろわなければ届いた組だけで決める) */
export const tourDeadline = (spec: Pick<TournamentSpec, "startsAt" | "laps">) => spec.startsAt + spec.laps * 4 * MIN_MS + 15 * MIN_MS;
/** 予選の 1 回の走りを送れる数 (1 時間に。仮) */
export const QUALI_RUNS_PER_HOUR = 60;
/** 大会の名前の長さ (仮) */
export const TOUR_NAME_MAX = 24;
/** 一覧に出す終わった大会の数 (仮) */
export const TOUR_LIST_DONE = 10;
/** 順位表に出す数 (仮) */
export const STANDINGS_MAX = 100;
/**
 * 全員参加の大会: 組を作る時 (スタートの 10 分前) までのこれだけの間に大会の画面を開いていた人を「つないでいる」とする (仮)。
 * つないでいる人のいる組は部屋で走り、いない組はサーバーで計算する (画面に送らない。alarm で 1 組ずつ、上の組から)
 */
export const TOUR_PRESENCE_MS = 15 * MIN_MS;
/** 雇った運転手のいないチームの 2 台目 (全員参加の大会の埋め草) の運転手の id */
export const fillerDriverId = (accountId: number) => `s${accountId}`;
const isFiller = (driverId: string) => /^s\d+$/.test(driverId);

export type FuelMode = "full" | "race" | "light";
const FUEL_MODES: readonly FuelMode[] = ["full", "race", "light"];

/** 人の運転手の id */
export const humanDriverId = (accountId: number) => `h${accountId}`;
const tid = (accountId: number) => String(accountId);
const aidOf = (teamId: string) => Number(teamId);
const groupLetter = (g: number) => (g < 26 ? String.fromCharCode(65 + g) : `G${g + 1}`);

// ---------------------------------------------------------------- 受け取る形

/** 普段のレース (すぐ走る・部屋) の 1 台 (部屋の DO から) */
export interface RaceFeedCar {
  /** 部屋の中の id */
  id: string;
  pos: number;
  finished: boolean;
  fastest: boolean;
  penalty: number;
  /** 1 台目: ログインした人のアカウント */
  accountId?: number;
  /** 2 台目: 持ち主のアカウントと雇った運転手の id */
  ownerAccountId?: number;
  hiredDriverId?: string;
  /** 代走 (通信が切れてコンピューターが走らせた) */
  standIn?: boolean;
  /** 並び (1 から) */
  gridPos?: number | null;
  pitStops?: number;
}

export interface RaceFeed {
  /** 同じレースは 1 回だけ数える */
  raceId: string;
  at: number;
  laps: number;
  trackId: string;
  /** 出た人の数 (名無しも数える。賞金の「人が自分だけ」に使う) */
  humans: number;
  /** レース中の一番の濡れ具合 (はんこ) */
  maxWet: number;
  cars: RaceFeedCar[];
}

export interface RaceFeedPaid {
  car1: number;
  car2: number;
  /** 払ったあとの財布 */
  money: number;
  /** 走行点 (自分で走った 1 台目だけ。racepoints.ts)。earned = 入った点・wanted = 上限が無ければ・left = 今日あと */
  rp?: { earned: number; wanted: number; left: number; points: number };
}

/** 大会の組の 1 台 (画面に返す形にも使う) */
export interface TourGroupCar {
  key: string;
  teamId: string;
  driverId: string;
  kind: "human" | "hired";
  name: string;
  team: string;
  /** 予選の記録 (秒、なし = 後ろ) */
  lapTime: number | null;
  slot: number;
}

export interface TourResultRow {
  finalPos: number;
  group: string;
  driverId: string;
  teamId: string;
  name: string;
  team: string;
  finished: boolean;
  dq: boolean;
  fastest: boolean;
  standIn: boolean;
  best: number | null;
  points: number;
  prize: number;
  /** 受け取った景品 (順位の景品・参加賞。言い表し) */
  gifts?: string[];
  /** 当てられなかった景品 */
  giftsMissed?: string[];
  /** 走行点 (自分で走ったときだけ。代走は無し) */
  rp?: number;
}

export interface TourRow {
  spec: TournamentSpec;
  groupSize: number;
  status: "open" | "running" | "done" | "cancelled";
  groups?: Array<{ letter: string; cars: TourGroupCar[] }>;
  /** 部屋に渡す中身 (組ごと) と、渡せたか */
  fields?: FixedField[];
  pushed?: boolean[];
  /** 組ごと: サーバーで計算する組 (つないでいる人がいない、全員参加の大会だけ) */
  headless?: boolean[];
  results?: TourResultRow[];
  endedAt?: number;
}

interface QualiBody {
  q: QualiTires;
  design: CarDesign | null;
  /** 走る前の予定 (代走もこれで走る) */
  plan: { start: SetPick | null; fuel: FuelMode };
  /** 回数の制限 */
  rate?: { n: number; resetAt: number };
}

interface StampRow {
  book: StampBook;
  /** 今の季節にもらったはんこ (記録に入れる) */
  season: number;
  got: StampId[];
}

/** 季節の記録 (チームごと)。shared の TeamHistoryEntry + チャンピオンなど */
export interface HistoryRow extends TeamHistoryEntry {
  points: number;
  /** コンストラクター (チームのチャンピオン): 級の / 総合の */
  constructor: "overall" | "class" | null;
  /** その季節の運転手の 1 位 (自分の運転手 = 人か雇った運転手) */
  driverChampion: "overall" | "class" | null;
  /** 級が変わった先 */
  nextCls: number | null;
  prize: number;
}

/** 締めた季節のまとめ (全体に見せる) */
export interface SeasonSummary {
  season: number;
  at: number;
  overallConstructor: { teamId: string; team: string; points: number; prize: number } | null;
  overallDriver: { driverId: string; name: string; team: string; points: number; prize: number } | null;
  classes: Array<{
    cls: ClassId;
    constructor: { teamId: string; team: string; points: number; prize: number } | null;
    driver: { driverId: string; name: string; team: string; points: number; prize: number } | null;
    top: { teamId: string; team: string; points: number } | null;
  }>;
  moves: Array<{ teamId: string; team: string; from: ClassId | null; to: ClassId }>;
}

export interface LeagueDayMeta {
  /** チーム → その日の部 (記録の肩書きに使う) */
  divisions?: Record<string, number>;
  /** 王者のチーム */
  champion?: string | null;
  /** チーム → もらったはんこ (週の部のはんこなど) */
  stamps?: Record<string, StampId[]>;
}

export interface SeasonDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
  /** 大会の組を作るときのチームの様子 (2 台目・整備の腕・代走の慣れ)。team.ts の raceTeam。取りまとめの外で呼ぶ */
  teamInfo?: (accountId: number, design: CarDesign) => JoinTeam | null;
  /**
   * 季節を締めたあと (取りまとめの外): チャンピオン (級か総合) になった雇った運転手の id。team.ts の championBonus (伸びしろ +5) に渡す。
   * 同じ季節で 2 回呼ばれることがある (受け手が 1 回だけにする)
   */
  onDriverChampions?: (season: number, driverIds: string[]) => void;
  /** 季節を締めたあと (取りまとめの外): 総合のコンストラクターズチャンピオンのチーム。team.ts の rarePrize (珍しい運転手と ただで契約) に渡す */
  onConstructorChampion?: (season: number, teamId: string) => void;
  /**
   * 季節の締め (取りまとめの中) で: ギフトコードで決まった級の動き (チーム → 次の季節の級)。gift.ts の takeClassMoves。
   * 締めの入れ替えのあとに上書きする (その季節の点とチャンピオンはそのまま)
   */
  classMoves?: () => Record<string, ClassId>;
  /**
   * 大会の景品を渡す (大会を決める取りまとめの中で。gift.ts の grantInTx)。なし = 景品は渡さない (試験)
   */
  grantPrizes?: (accountId: number, items: readonly GiftItem[], now: number) => { received: string[]; later: string[]; failed: string[] } | null;
  /** 全員参加の大会で、予選を走らなかったチームの車 (league_accounts.ts の leagueTeamData) */
  teamData?: (accountId: number) => LeagueTeamData | null;
  /** 毎日の自動の大会を開く (AccountsDO だけ。試験は選んで入れる) */
  autoTournaments?: boolean;
  /** 大会が決まった・取りやめたあと (取りまとめの外で)。大会の優勝の賭けを払う・返す (bets_tour.ts) */
  onTournamentClosed?: (id: string) => void;
}

export class SeasonStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  readonly now: () => number;
  private classMoves?: () => Record<string, ClassId>;
  private teamInfo?: (accountId: number, design: CarDesign) => JoinTeam | null;
  private onDriverChampions?: (season: number, driverIds: string[]) => void;
  private onConstructorChampion?: (season: number, teamId: string) => void;
  /** 最後に締めた季節の総合のコンストラクターズチャンピオン (closeOne が入れる) */
  private lastConsChampion: string | null = null;
  private grantPrizes?: SeasonDeps["grantPrizes"];
  private teamData?: SeasonDeps["teamData"];
  private autoTournaments: boolean;
  private onTournamentClosed?: (id: string) => void;
  /** 管理者の数の変更の記録 (admin_config_log.ts) */
  readonly configLog: AdminConfigLog;

  constructor(
    deps: SeasonDeps,
    private accounts: AccountStore,
  ) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    this.teamInfo = deps.teamInfo;
    this.onDriverChampions = deps.onDriverChampions;
    this.onConstructorChampion = deps.onConstructorChampion;
    this.classMoves = deps.classMoves;
    this.grantPrizes = deps.grantPrizes;
    this.teamData = deps.teamData;
    this.autoTournaments = deps.autoTournaments === true;
    this.onTournamentClosed = deps.onTournamentClosed;
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
    // 走行点の表 (racepoints.ts。結果の取りまとめの中で初めて作ると、戻したときに表ごと消えるので先に)
    ensureRpSchema(this.sql);
    this.configLog = new AdminConfigLog(this.sql);
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  private kvGet<T>(k: string): T | null {
    const r = this.row("SELECT body FROM season_kv WHERE k = ?", k);
    return r ? (JSON.parse(String(r.body)) as T) : null;
  }

  private kvPut(k: string, v: unknown) {
    this.sql.exec("INSERT INTO season_kv (k, body) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body", k, JSON.stringify(v));
  }

  // ---------------------------------------------------------------- 管理者の数

  config(): AdminConfig {
    const c = this.kvGet<AdminConfig>("config");
    if (!c) return cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    // 項目が増えたときのために、はじめの値に重ねて確かめる
    const v = validateAdminConfig({ ...cloneAdminConfig(DEFAULT_ADMIN_CONFIG), ...c });
    return v.ok ? v.config : cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
  }

  /** 一部の変更 (保存・読みこみ)。変わった項目は記録に残す (by = した管理者) */
  setConfig(patch: unknown, by: AdminBy | null = null, action: AdminConfigAction = "save"): AdminConfig {
    return this.tx(() => this.writeConfig(patch, by, action, null));
  }

  /** 確かめて入れて、記録に残す (取りまとめの中で呼ぶ) */
  private writeConfig(patch: unknown, by: AdminBy | null, action: AdminConfigAction, ref: number | null): AdminConfig {
    const before = this.config();
    const r = applyAdminPatch(before, patch);
    if (!r.ok) throw new ApiError(400, `数がおかしい項目があります: ${adminErrorTexts(r.errors, typeof patch === "object" && patch ? (patch as Record<string, unknown>) : undefined).join(" / ")}`);
    this.kvPut("config", r.config);
    this.configLog.add(this.now(), by, action, before, r.config, ref);
    return r.config;
  }

  resetConfig(by: AdminBy | null = null): AdminConfig {
    return this.tx(() => {
      const before = this.config();
      this.sql.exec("DELETE FROM season_kv WHERE k = 'config'");
      const after = this.config();
      this.configLog.add(this.now(), by, "reset", before, after);
      return after;
    });
  }

  /**
   * 記録の版に戻す (side = その変更の後 / 前)。保存したままの数を今の確かめ (applyAdminPatch) に通してから入れる。
   * 今は無い項目は捨て、あとから足した項目は今の値のまま。戻したことも記録に残す
   */
  restoreConfig(logId: number, side: "before" | "after", by: AdminBy | null = null, action: AdminConfigAction = "restore"): AdminConfig {
    return this.tx(() => {
      const v = this.configLog.versions(logId);
      if (!v) throw new ApiError(404, "その版は見つかりません (古い記録は消えます)");
      const known = Object.fromEntries(Object.entries(v[side]).filter(([k]) => k in DEFAULT_ADMIN_CONFIG));
      return this.writeConfig(known, by, action, logId);
    });
  }

  /** 一番新しい変更を取り消す (その変更の前の数に戻す) */
  undoConfig(by: AdminBy | null = null): AdminConfig {
    const id = this.configLog.latestId();
    if (id === null) throw new ApiError(400, "取り消せる変更がありません");
    return this.restoreConfig(id, "before", by, "undo");
  }

  // ---------------------------------------------------------------- 級の表と集計

  /** 級の表 (保存したもの + まだ入っていないアカウントは級なし) */
  classes(): ClassTable {
    let t: ClassTable = this.kvGet<ClassTable>("classes") ?? {};
    for (const r of this.rows("SELECT id FROM accounts")) t = registerTeam(t, tid(Number(r.id)));
    return t;
  }

  /** 保存してある級 (null = 級なし) */
  classOf(accountId: number): ClassId | null {
    const t = this.kvGet<ClassTable>("classes") ?? {};
    return t[tid(accountId)] ?? null;
  }

  /** 普段のレースで走る級 (級なしは一番下) */
  playClass(accountId: number | null): ClassId {
    if (accountId === null) return 5;
    return playClassOf(this.kvGet<ClassTable>("classes") ?? {}, tid(accountId));
  }

  /** 今の集計 (締めの前なら前の季節のまま) */
  tally(): SeasonTally {
    const t = this.kvGet<SeasonTally>("tally");
    if (t) return t;
    // はじめて: 今の季節から数える (残しておかないと、眠っていた間の季節が締まらない)
    const fresh = newSeasonTally(seasonIndexAt(this.now()));
    this.kvPut("tally", fresh);
    return fresh;
  }

  private leagueAcc(season: number): ConstructorLeagueAcc {
    const v = this.kvGet<{ season: number; acc: ConstructorLeagueAcc }>("league_acc");
    return v && v.season === season ? v.acc : {};
  }

  // ---------------------------------------------------------------- 名前

  private names(): Map<string, { team: string; driver: string }> {
    const m = new Map<string, { team: string; driver: string }>();
    for (const r of this.rows("SELECT id, team, driver FROM accounts")) m.set(tid(Number(r.id)), { team: String(r.team), driver: String(r.driver) });
    return m;
  }

  private hiredNames(): Map<string, string> {
    const r = this.row("SELECT body FROM econ_kv WHERE k = 'drivers'");
    const m = new Map<string, string>();
    if (!r) return m;
    try {
      for (const d of (JSON.parse(String(r.body)) as DriverPool).drivers) m.set(d.id, d.name);
    } catch {
      /* 読めなければ id のまま */
    }
    return m;
  }

  private namer() {
    const names = this.names();
    let hired: Map<string, string> | null = null;
    const team = (teamId: string) => names.get(teamId)?.team ?? "(退会したチーム)";
    const driver = (driverId: string) => {
      if (/^h\d+$/.test(driverId)) return names.get(driverId.slice(1))?.driver ?? "(退会)";
      hired ??= this.hiredNames();
      return hired.get(driverId) ?? driverId;
    };
    return { team, driver };
  }

  // ---------------------------------------------------------------- お金とはんこ

  /** 財布に入れる (退会していたら null)。払ったあとのお金を返す */
  private credit(accountId: number, amount: number, reason: string, at: number): number | null {
    const n = Math.max(0, Math.floor(amount));
    if (n <= 0) {
      const r = this.row("SELECT money FROM accounts WHERE id = ?", accountId);
      return r ? Number(r.money) : null;
    }
    const r = this.row("UPDATE accounts SET money = money + ? WHERE id = ? RETURNING money", n, accountId);
    if (!r) return null;
    this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", accountId, n, reason.slice(0, 80), at);
    return Number(r.money);
  }

  private stampRow(teamId: string, season: number): StampRow {
    const r = this.row("SELECT body FROM stamp_books WHERE team_id = ?", teamId);
    const v = r ? (JSON.parse(String(r.body)) as StampRow) : { book: {}, season, got: [] };
    if (v.season !== season) return { book: v.book, season, got: [] };
    return v;
  }

  /** ギフトコードのはんこ (呼ぶ側の取りまとめの中で。今の季節に押す) */
  grantStamps(accountId: number, stamps: readonly StampId[]): void {
    const ok = stamps.filter((s) => s in STAMP_DEFS);
    this.giveStamps(tid(accountId), ok, this.now(), this.tally().season);
  }

  private giveStamps(teamId: string, stamps: readonly StampId[], at: number, season: number) {
    if (!stamps.length) return;
    const v = this.stampRow(teamId, season);
    const got = new Set(v.got);
    for (const s of stamps) got.add(s);
    const out: StampRow = { book: addStamps(v.book, stamps, at), season, got: [...got] };
    this.sql.exec("INSERT INTO stamp_books (team_id, body) VALUES (?, ?) ON CONFLICT(team_id) DO UPDATE SET body = excluded.body", teamId, JSON.stringify(out));
  }

  // ---------------------------------------------------------------- 普段のレース

  /**
   * 終わった普段のレースを季節に足し、賞金を払い、はんこを押す (同じ raceId は 1 回だけ)。
   * 点は season.ts の決まり (代走はチームだけ、雇った運転手は運転手順位にも)。賞金は管理者の数 (racePrizeFor)
   */
  recordRace(feed: RaceFeed): { counted: boolean; paid: Record<number, RaceFeedPaid> } {
    this.closeDue();
    const at = Number.isFinite(feed.at) ? feed.at : this.now();
    return this.tx(() => {
      if (this.row("SELECT race_id FROM season_races WHERE race_id = ?", feed.raceId)) return { counted: false, paid: {} };
      this.sql.exec("INSERT INTO season_races (race_id, kind, at) VALUES (?, 'everyday', ?)", feed.raceId, at);
      const cfg = this.config();
      const field = feed.cars.length;
      const cars: RaceCar[] = feed.cars.map((c) => {
        const acc = c.accountId ?? c.ownerAccountId;
        const teamId = acc !== undefined && this.exists(acc) ? tid(acc) : null;
        const driverId = c.hiredDriverId ?? (c.accountId !== undefined ? humanDriverId(c.accountId) : `cpu:${c.id}`);
        return { driverId, teamId, pos: c.pos, finished: c.finished, fastest: c.fastest, standIn: c.standIn === true };
      });
      const race: CountedRace = { raceId: feed.raceId, kind: "everyday", at, cars };
      let tally = this.tally();
      if (tally.season === seasonIndexAt(at)) {
        tally = addRaceToTally(tally, race, cfg.season);
        this.kvPut("tally", tally);
        let classes = this.kvGet<ClassTable>("classes") ?? {};
        for (const c of cars) if (c.teamId) classes = registerTeam(classes, c.teamId);
        this.kvPut("classes", classes);
      }
      // 賞金 (1 台目と 2 台目)。「人が自分だけ」は今までどおり人の数で (2 台目は数えない)
      const paid: Record<number, RaceFeedPaid> = {};
      const cpuOnly = feed.humans <= 1;
      feed.cars.forEach((c, i) => {
        const car = cars[i];
        if (!car.teamId) return;
        const acc = aidOf(car.teamId);
        const amount = racePrizeFor(cfg, "everyday", { pos: c.pos, points: baseRacePoints(car, field), finished: c.finished }, { laps: feed.laps, cpuOnly });
        const second = c.hiredDriverId !== undefined;
        const money = this.credit(acc, amount, `レース ${feed.laps} 周 ${second ? "2 台目 " : ""}${c.pos} 位 ${baseRacePoints(car, field)} 点`, at);
        if (money === null) return;
        const p = (paid[acc] ??= { car1: 0, car2: 0, money });
        if (second) p.car2 += Math.max(0, Math.floor(amount));
        else p.car1 += Math.max(0, Math.floor(amount));
        p.money = money;
      });
      // 走行点 (racepoints.ts): 自分で走った 1 台目だけ (代走・雇った運転手の 2 台目は無し)。1 日の上限あり
      feed.cars.forEach((c, i) => {
        if (c.accountId === undefined || c.standIn === true || !cars[i].teamId) return;
        const r = earnRaceFinish(this.sql, cfg, c.accountId, { pos: c.pos, finished: c.finished }, feed.laps, at);
        if (!r) return;
        const p = (paid[c.accountId] ??= { car1: 0, car2: 0, money: this.credit(c.accountId, 0, "", at) ?? 0 });
        p.rp = { earned: r.earned, wanted: r.wanted, left: r.left, points: r.points };
      });
      // はんこ (自分で走った 1 台目だけ。代走は無し)
      const season = seasonIndexAt(at);
      feed.cars.forEach((c, i) => {
        if (c.accountId === undefined || !cars[i].teamId) return;
        const mate = feed.cars.find((x) => x.ownerAccountId === c.accountId);
        const stamps = raceStamps({
          kind: "everyday",
          laps: feed.laps,
          pos: c.pos,
          gridPos: c.gridPos ?? null,
          finished: c.finished,
          fastest: c.fastest,
          standIn: c.standIn,
          pitStops: c.pitStops ?? 0,
          maxWet: feed.maxWet,
          penalty: c.penalty,
          teammatePos: mate ? mate.pos : null,
        });
        this.giveStamps(tid(c.accountId), stamps, at, season);
      });
      return { counted: true, paid };
    });
  }

  private exists(accountId: number): boolean {
    return !!this.row("SELECT id FROM accounts WHERE id = ?", accountId);
  }

  // ---------------------------------------------------------------- リーグ戦 (別の DO から)

  /**
   * リーグ戦の 1 日の分をコンストラクターに足す (リーグ戦の係が日の締めに呼ぶ。同じ dayKey は 1 回だけ)。
   * delta = shared の addLeagueDayToConstructors({}, その日の state, 管理者の数) (その日の分だけ)。meta は記録とはんこ用 (なくてもよい)
   */
  addLeagueDay(dayKey: string, delta: ConstructorLeagueAcc, meta: LeagueDayMeta = {}, at = this.now()): boolean {
    this.closeDue();
    return this.tx(() => {
      if (this.row("SELECT day_key FROM league_days WHERE day_key = ?", dayKey)) return false;
      this.sql.exec("INSERT INTO league_days (day_key, at) VALUES (?, ?)", dayKey, at);
      const season = this.tally().season;
      const acc = { ...this.leagueAcc(season) };
      for (const [team, v] of Object.entries(delta ?? {})) if (typeof v === "number" && Number.isFinite(v) && v > 0) acc[team] = (acc[team] ?? 0) + v;
      this.kvPut("league_acc", { season, acc });
      // 王者を 7 日続けて守ると 限界突破の品 (レースのあった日だけ数える = champion が来た日)
      if (meta.champion !== undefined) {
        const r = advanceChampionStreak(this.kvGet<ChampionStreak>("champ_streak"), meta.champion);
        this.kvPut("champ_streak", r.streak);
        if (r.award && r.streak.teamId && /^\d+$/.test(r.streak.teamId)) {
          const p = PRIZE_ITEMS.championStreak;
          grantItems(this.sql, aidOf(r.streak.teamId), { [p.item]: p.count }, { id: `prize:streak:${dayKey}`, title: "限界突破の品", why: `王者を ${r.streak.days} 日続けて守った`, at });
        }
      }
      if (meta.divisions || meta.champion !== undefined) {
        const prev = this.kvGet<{ divisions: Record<string, number>; champion: string | null }>("league_meta") ?? { divisions: {}, champion: null };
        this.kvPut("league_meta", { divisions: { ...prev.divisions, ...(meta.divisions ?? {}) }, champion: meta.champion === undefined ? prev.champion : meta.champion });
      }
      for (const [team, stamps] of Object.entries(meta.stamps ?? {})) {
        const ok = (stamps ?? []).filter((s) => s in STAMP_DEFS);
        if (ok.length && /^\d+$/.test(team) && this.exists(Number(team))) this.giveStamps(team, ok, at, season);
      }
      return true;
    });
  }

  // ---------------------------------------------------------------- 季節の締め

  /** 時刻の来た季節を締める (何季節分でも。1 季節ずつ取りまとめ 1 回)。締めた季節の番号を返す */
  closeDue(now = this.now()): number[] {
    const out: number[] = [];
    for (let guard = 0; guard < 520; guard++) {
      const t = this.tally();
      if (t.season >= seasonIndexAt(now)) break;
      this.lastConsChampion = null;
      const hired = this.tx(() => this.closeOne(t.season, now));
      out.push(t.season);
      // 総合のコンストラクターズチャンピオン: 珍しい運転手と ただで契約できる (チームの表。取りまとめの外で)
      const cons = this.lastConsChampion;
      if (cons && this.onConstructorChampion) {
        try {
          this.onConstructorChampion(t.season, cons);
        } catch (e) {
          console.error("constructor champion prize", (e as Error)?.message ?? e);
        }
      }
      // 雇った運転手のチャンピオン: 伸びしろ +5 (チームの表。取りまとめの外で)
      if (hired.length && this.onDriverChampions) {
        try {
          this.onDriverChampions(t.season, hired);
        } catch (e) {
          console.error("driver champion bonus", (e as Error)?.message ?? e);
        }
      }
    }
    return out;
  }

  /** 季節を 1 つ締める。チャンピオン (級か総合) になった雇った運転手の id を返す */
  private closeOne(season: number, now: number): string[] {
    const tally0 = this.tally();
    if (tally0.season !== season) return [];
    if (this.row("SELECT season FROM season_closed WHERE season = ?", season)) {
      this.kvPut("tally", newSeasonTally(season + 1));
      return [];
    }
    const cfg = this.config();
    const classes = this.classes();
    const tally = tally0;
    const acc = this.leagueAcc(season);
    const nm = this.namer();
    const at = seasonWindow(season).endsAt;
    // チャンピオンは級の入れ替えの前の級で
    const consClass = constructorsByClass(tally, acc, classes, cfg);
    const consAll = constructorsOverall(tally, acc, classes, cfg);
    this.lastConsChampion = consAll.champion ?? null;
    const drvClass = driverChampionsByClass(tally, classes, cfg);
    const drvAll = driverChampionOverall(tally, classes, cfg);
    const close0 = closeSeason(classes, tally);
    // ギフトコードの級の動き (次の季節の級を上書き。その季節の順位とチャンピオンはそのまま)
    const gifted = this.classMoves?.() ?? {};
    const close = Object.keys(gifted).length ? { ...close0, next: { ...close0.next, ...Object.fromEntries(Object.entries(gifted).filter(([t]) => t in close0.next)) } } : close0;
    const meta = this.kvGet<{ divisions: Record<string, number>; champion: string | null }>("league_meta") ?? { divisions: {}, champion: null };
    const label = `第 ${season + 1} 季`;

    // 賞金 (チームごとにまとめて 1 行ずつ)
    const prize = new Map<string, number>();
    const add = (team: string | null | undefined, amount: number) => {
      if (!team || !(amount > 0)) return;
      prize.set(team, (prize.get(team) ?? 0) + Math.floor(amount));
    };
    for (const cls of CLASS_IDS) {
      for (const r of close.rankings[cls]) if (r.races > 0) add(r.id, seasonPrizeFor(cfg, cls, r.rank));
    }
    for (const c of consClass) add(c.champion, c.prize);
    add(consAll.champion, consAll.prize);
    for (const d of drvClass) add(d.champion?.teamId, d.champion?.prize ?? 0);
    add(drvAll.champion?.teamId, drvAll.champion?.prize ?? 0);
    for (const [team, amount] of prize) this.credit(aidOf(team), amount, `${label}のごほうび`, now);
    // 限界突破の品 (DECISIONS 11/25「限界突破の品」): 級・総合のチャンピオン、ドライバーズチャンピオン、リーグ戦の週の 1 位
    let items: PrizeGrants = {};
    const why = new Map<string, string[]>();
    const award = (team: string | null | undefined, key: keyof typeof PRIZE_ITEMS) => {
      if (!team || !/^\d+$/.test(team)) return;
      items = addPrize(items, team, key);
      why.set(team, [...(why.get(team) ?? []), PRIZE_ITEMS[key].label]);
    };
    for (const c of consClass) award(c.champion, "classConstructor");
    award(consAll.champion, "overallConstructor");
    for (const d of drvClass) award(d.champion?.teamId, "classDriver");
    award(drvAll.champion?.teamId, "overallDriver");
    award(leagueWeekTop(acc), "leagueWeek");
    for (const [team, got] of Object.entries(items)) {
      grantItems(this.sql, aidOf(team), got, { id: `prize:season:${season}`, title: "限界突破の品", why: `${label} ${(why.get(team) ?? []).join("・")}`, at: now });
    }

    // はんこと記録
    const rankIn = new Map<string, { cls: ClassId; rank: number; points: number }>();
    for (const cls of CLASS_IDS) for (const r of close.rankings[cls]) rankIn.set(r.id, { cls, rank: r.rank, points: r.points });
    const driverChampOf = (team: string): "overall" | "class" | null => {
      if (drvAll.champion?.teamId === team) return "overall";
      return drvClass.some((d) => d.champion?.teamId === team) ? "class" : null;
    };
    for (const team of Object.keys(classes)) {
      if (!/^\d+$/.test(team) || !this.exists(aidOf(team))) continue;
      const stamps = seasonStamps(close, team, humanDriverId(aidOf(team)));
      if (driverChampOf(team) && !stamps.includes("driver_champion")) stamps.push("driver_champion");
      this.giveStamps(team, stamps, at, season);
      const got = this.stampRow(team, season).got;
      const r = rankIn.get(team);
      const h: HistoryRow = {
        ...historyEntry({
          season,
          cls: classes[team] ?? null,
          classRank: r?.rank ?? null,
          division: meta.divisions[team] ?? null,
          champion: meta.champion === team,
          stamps: got,
        }),
        points: r?.points ?? 0,
        constructor: consAll.champion === team ? "overall" : consClass.some((c) => c.champion === team) ? "class" : null,
        driverChampion: driverChampOf(team),
        nextCls: close.next[team] ?? null,
        prize: prize.get(team) ?? 0,
      };
      if (h.points > 0 || h.prize > 0 || got.length > 0 || h.division !== null) {
        this.sql.exec("INSERT INTO team_history (team_id, season, body) VALUES (?, ?, ?) ON CONFLICT(team_id, season) DO UPDATE SET body = excluded.body", team, season, JSON.stringify(h));
      }
      // 知らせ
      const text = r
        ? `${label}は ${r.cls} 級 ${r.rank} 位 (${r.points} 点)。${(close.next[team] ?? r.cls) < r.cls ? "昇級!" : (close.next[team] ?? r.cls) > r.cls ? "降級" : "級はそのまま"}${h.prize > 0 ? `。ごほうび ${h.prize.toLocaleString("ja-JP")}` : ""}`
        : `${label}が終わりました`;
      this.sql.exec(
        "INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) VALUES (?, ?, 'season_end', ?, ?, ?, 0)",
        aidOf(team),
        `season:${season}`,
        "季節が終わった",
        `${text}。表示名を今なら変えられます`,
        now,
      );
    }

    // まとめ (名前はこのときのものを残す。退会しても記録に名前が残る)
    const champ = (c: { teamId: string; points: number; prize: number } | null) => (c ? { teamId: c.teamId, team: nm.team(c.teamId), points: c.points, prize: c.prize } : null);
    const dchamp = (d: { driverId: string; teamId: string; points: number; prize: number } | null) =>
      d ? { driverId: d.driverId, name: nm.driver(d.driverId), team: nm.team(d.teamId), points: d.points, prize: d.prize } : null;
    const summary: SeasonSummary = {
      season,
      at: now,
      overallConstructor: consAll.champion ? champ({ teamId: consAll.champion, points: consAll.rows[0].total, prize: consAll.prize }) : null,
      overallDriver: dchamp(drvAll.champion),
      classes: CLASS_IDS.map((cls) => {
        const c = consClass.find((x) => x.cls === cls)!;
        const d = drvClass.find((x) => x.cls === cls)!;
        const top = close.rankings[cls][0];
        return {
          cls,
          constructor: c.champion ? champ({ teamId: c.champion, points: c.rows[0].total, prize: c.prize }) : null,
          driver: dchamp(d.champion),
          top: top && top.points > 0 ? { teamId: top.id, team: nm.team(top.id), points: top.points } : null,
        };
      }),
      moves: close.moves.map((m) => ({ teamId: m.teamId, team: nm.team(m.teamId), from: m.from, to: m.to })),
    };
    this.sql.exec("INSERT INTO season_closed (season, at, body) VALUES (?, ?, ?)", season, now, JSON.stringify(summary));

    // 次の季節へ: 級の入れ替え・点は 0・リーグ戦の分も 0・表示名を変えてよい
    this.kvPut("classes", close.next);
    this.kvPut("tally", close.nextTally);
    this.kvPut("league_acc", { season: season + 1, acc: {} });
    this.accounts.allowNameChange("all");
    // 雇った運転手 (人の運転手 h<番号> でない) のチャンピオン
    const champs = [drvAll.champion, ...drvClass.map((d) => d.champion)].filter((c): c is NonNullable<typeof c> => !!c).map((c) => c.driverId);
    return [...new Set(champs.filter((id) => !/^h\d+$/.test(id)))];
  }

  // ---------------------------------------------------------------- 見せる形

  seasonView(accountId: number | null) {
    this.closeDue();
    const now = this.now();
    const tally = this.tally();
    const classes = this.classes();
    const w = seasonWindow(tally.season);
    const nm = this.namer();
    const me = accountId === null ? null : tid(accountId);
    const meDriver = accountId === null ? null : humanDriverId(accountId);
    const teamRow = (r: RankRow) => ({ rank: r.rank, id: r.id, name: nm.team(r.id), points: r.points, tournamentPoints: r.tournamentPoints, races: r.races, me: r.id === me });
    const driverRow = (r: RankRow) => {
      const team = tally.drivers[r.id]?.teamId ?? "";
      return { rank: r.rank, id: r.id, name: nm.driver(r.id), team: nm.team(team), hired: !/^h\d+$/.test(r.id), points: r.points, tournamentPoints: r.tournamentPoints, races: r.races, me: r.id === meDriver || (!!me && team === me) };
    };
    const cut = <T extends { me: boolean }>(rows: T[]) => rows.filter((r, i) => i < STANDINGS_MAX || r.me);
    const drvClass = driverChampionsByClass(tally, classes, this.config());
    const per = CLASS_IDS.map((cls) => ({
      cls,
      teams: cut(classRanking(classes, tally, cls).map(teamRow)),
      drivers: cut((drvClass.find((d) => d.cls === cls)?.rows ?? []).map(driverRow)),
    }));
    const acc = this.leagueAcc(tally.season);
    const cons = constructorsOverall(tally, acc, classes, this.config());
    const drv = driverChampionOverall(tally, classes, this.config());
    let mine = null;
    if (me) {
      const cls = classes[me] ?? null;
      const play = playClassOf(classes, me);
      const tr = per.find((p) => p.cls === play)!.teams.find((r) => r.id === me) ?? null;
      const dr = drv.rows.find((r) => r.id === meDriver) ?? null;
      const cr = cons.rows.find((r) => r.teamId === me) ?? null;
      mine = {
        teamId: me,
        team: nm.team(me),
        driver: nm.driver(meDriver!),
        cls,
        playClass: play,
        classRank: tr?.rank ?? null,
        classTeams: per.find((p) => p.cls === play)!.teams.length,
        points: tally.teams[me]?.points ?? 0,
        driverPoints: tally.drivers[meDriver!]?.points ?? 0,
        driverRank: dr?.rank ?? null,
        constructorRank: cr?.rank ?? null,
      };
    }
    const lastRow = this.row("SELECT body FROM season_closed ORDER BY season DESC LIMIT 1");
    return {
      now,
      season: { index: tally.season, startsAt: w.startsAt, endsAt: w.endsAt },
      me: mine,
      classes: per,
      constructors: cut(cons.rows.map((r) => ({ rank: r.rank, id: r.teamId, name: nm.team(r.teamId), main: r.main, league: r.league, total: r.total, me: r.teamId === me }))),
      drivers: cut(drv.rows.map(driverRow)),
      last: lastRow ? (JSON.parse(String(lastRow.body)) as SeasonSummary) : null,
    };
  }

  /** 自分のはんこ帳と季節の記録 */
  myStamps(accountId: number) {
    const team = tid(accountId);
    const v = this.stampRow(team, this.tally().season);
    const history = this.rows("SELECT body FROM team_history WHERE team_id = ? ORDER BY season DESC LIMIT 60", team).map((r) => JSON.parse(String(r.body)) as HistoryRow);
    return {
      stamps: stampsForDisplay(v.book, 100).map((s) => ({ id: s.id, count: s.count, name: STAMP_DEFS[s.id].name, desc: STAMP_DEFS[s.id].desc, rarity: STAMP_DEFS[s.id].rarity })),
      thisSeason: v.got,
      history,
    };
  }

  /** 締めた季節のまとめ (新しい順) */
  seasonHistory(limit = 20): SeasonSummary[] {
    return this.rows("SELECT body FROM season_closed ORDER BY season DESC LIMIT ?", Math.max(1, Math.min(100, limit))).map((r) => JSON.parse(String(r.body)) as SeasonSummary);
  }

  /** 退会: 級の表・集計・はんこ・予選から外す (締めた季節のまとめの名前は残る) */
  forgetAccount(accountId: number): void {
    const team = tid(accountId);
    this.tx(() => {
      const classes = this.kvGet<ClassTable>("classes");
      if (classes && team in classes) {
        delete classes[team];
        this.kvPut("classes", classes);
      }
      const t = this.kvGet<SeasonTally>("tally");
      if (t) {
        delete t.teams[team];
        delete t.drivers[humanDriverId(accountId)];
        this.kvPut("tally", t);
      }
      this.sql.exec("DELETE FROM stamp_books WHERE team_id = ?", team);
      this.sql.exec("DELETE FROM team_history WHERE team_id = ?", team);
      this.sql.exec("DELETE FROM tour_quali WHERE account_id = ?", accountId);
    });
  }

  // ---------------------------------------------------------------- 大会

  /** 賭け (bets_tour.ts) が読む: 1 つの大会 (読むだけ) */
  tourForBets(id: string): TourRow | null {
    return this.loadTour(id);
  }

  /** 賭け (bets_tour.ts) が読む: 組が決まって、まだ始まっていない大会 */
  toursForBets(now = this.now()): TourRow[] {
    return this.rows("SELECT body FROM tournaments WHERE status = 'running' AND starts_at > ? ORDER BY starts_at", now).map((r) => JSON.parse(String(r.body)) as TourRow);
  }

  private loadTour(id: string): TourRow | null {
    const r = this.row("SELECT body FROM tournaments WHERE id = ?", id);
    return r ? (JSON.parse(String(r.body)) as TourRow) : null;
  }

  private saveTour(t: TourRow) {
    this.sql.exec(
      "INSERT INTO tournaments (id, status, starts_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, starts_at = excluded.starts_at, body = excluded.body",
      t.spec.id,
      t.status,
      t.spec.startsAt,
      JSON.stringify(t),
    );
  }

  private readSpecInput(b: Record<string, unknown>, base: Partial<TournamentSpec>): { spec: TournamentSpec; groupSize: number | undefined } {
    const name = typeof b.name === "string" ? b.name.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, TOUR_NAME_MAX) : base.name;
    const startsAt = b.startsAt !== undefined ? Number(b.startsAt) : base.startsAt;
    const trackId = typeof b.trackId === "string" ? b.trackId : base.trackId;
    const laps = b.laps !== undefined ? Number(b.laps) : base.laps;
    let weather = base.weather;
    if (b.weather !== undefined) weather = readWeather(b.weather) ?? ({ mode: "bad" } as unknown as TournamentWeather);
    const groupSize = b.groupSize !== undefined ? Number(b.groupSize) : undefined;
    // 格と景品 (tourprize.ts)。prizes / participation: 書かない = そのまま、null = 格のはじめの景品、[] (参加賞) = なし
    const grade = b.grade !== undefined ? (b.grade as TournamentSpec["grade"]) : base.grade;
    let prizes = base.prizes;
    let participation = base.participation;
    if (b.prizes !== undefined || b.participation !== undefined) {
      const c = checkTournamentPrizes(b.prizes === undefined ? (base.prizes ?? null) : b.prizes, b.participation === undefined ? (base.participation ?? null) : b.participation, this.config());
      if (!c.ok) throw new ApiError(400, `景品: ${c.error}`);
      prizes = c.prizes;
      participation = c.participation;
    }
    if (b.allEnter !== undefined && typeof b.allEnter !== "boolean") throw new ApiError(400, "全員参加がおかしいです");
    const allEnter = b.allEnter !== undefined ? b.allEnter === true : base.allEnter;
    const spec: TournamentSpec = {
      ...base,
      id: base.id ?? "",
      name: name ?? "",
      createdAt: base.createdAt ?? this.now(),
      startsAt: startsAt ?? NaN,
      trackId: trackId ?? "",
      laps: laps ?? NaN,
      weather: weather ?? { mode: "fixed", sky: "sun" },
    };
    for (const [k, v] of Object.entries({ grade, prizes, participation, allEnter }) as Array<[keyof TournamentSpec, unknown]>) {
      if (v === undefined) delete spec[k];
      else (spec as unknown as Record<string, unknown>)[k] = v;
    }
    return { spec, groupSize };
  }

  private checkSpec(spec: TournamentSpec, groupSize: number) {
    const issues = validateTournament(spec, this.now(), TRACK_DEFS.map((d) => d.id));
    if (!Number.isInteger(groupSize) || groupSize < TOUR_GROUP_MIN || groupSize > TOUR_GROUP_MAX) issues.push("group" as never);
    if (issues.length) throw new ApiError(400, `大会の中身がおかしいです: ${issues.map((i) => TOUR_ISSUE_TEXT[i] ?? i).join("・")}`);
  }

  createTournament(b: Record<string, unknown>): TourRow {
    const id = `t${this.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
    const { spec, groupSize } = this.readSpecInput(b, { id, createdAt: this.now() });
    const gs = groupSize ?? TOUR_GROUP_SIZE;
    this.checkSpec(spec, gs);
    const t: TourRow = { spec, groupSize: gs, status: "open" };
    this.tx(() => {
      this.saveTour(t);
      // 管理者の大会がある日は、その日の毎日の大会を開かない (もう開いていたら取りやめる)
      const day = jstDayStart(spec.startsAt);
      for (const r of this.rows("SELECT body FROM tournaments WHERE status = 'open' AND starts_at >= ? AND starts_at < ?", day, day + 24 * HOUR_MS)) {
        const o = JSON.parse(String(r.body)) as TourRow;
        if (o.spec.auto && o.spec.id !== id) this.saveTour({ ...o, status: "cancelled" });
      }
    });
    return t;
  }

  /** 大会を直す (予選が締まる前だけ。予選を走った人がいたら、コースと周は変えられない) */
  updateTournament(id: string, b: Record<string, unknown>): TourRow {
    return this.tx(() => {
      const t = this.loadTour(id);
      if (!t || t.status === "cancelled") throw new ApiError(404, "その大会はありません");
      if (t.status !== "open" || tournamentPhaseAt(t.spec, this.now()) !== "qualifying") throw new ApiError(409, "予選が締まったあとは直せません");
      const { spec, groupSize } = this.readSpecInput(b, t.spec);
      const ran = Number(this.row("SELECT COUNT(*) AS c FROM tour_quali WHERE tid = ? AND best_ms IS NOT NULL", id)?.c ?? 0) > 0;
      if (ran && (spec.trackId !== t.spec.trackId || spec.laps !== t.spec.laps)) throw new ApiError(409, "予選を走った人がいるので、コースと周回は変えられません");
      const gs = groupSize ?? t.groupSize;
      this.checkSpec(spec, gs);
      const next: TourRow = { ...t, spec, groupSize: gs };
      this.saveTour(next);
      return next;
    });
  }

  /** 大会を取りやめる (始まる前だけ) */
  cancelTournament(id: string): void {
    this.tx(() => {
      const t = this.loadTour(id);
      if (!t || t.status === "cancelled") throw new ApiError(404, "その大会はありません");
      if (t.status !== "open") throw new ApiError(409, "始まった大会は取りやめられません");
      this.saveTour({ ...t, status: "cancelled" });
    });
    this.onTournamentClosed?.(id);
  }

  private phaseOf(t: TourRow, now: number): "qualifying" | "grid_set" | "lobby" | "racing" | "done" | "cancelled" {
    if (t.status === "cancelled") return "cancelled";
    if (t.status === "done") return "done";
    if (t.status === "running") return now >= t.spec.startsAt ? "racing" : "lobby";
    const p = tournamentPhaseAt(t.spec, now);
    return p === "qualifying" ? "qualifying" : p === "grid_set" ? "grid_set" : "racing";
  }

  private tourBrief(t: TourRow, now: number) {
    const q = qualifyWindow(t.spec);
    const entries = Number(this.row("SELECT COUNT(*) AS c FROM tour_quali WHERE tid = ? AND best_ms IS NOT NULL", t.spec.id)?.c ?? 0);
    const track = TRACK_DEFS.find((d) => d.id === t.spec.trackId);
    return {
      id: t.spec.id,
      name: t.spec.name,
      trackId: t.spec.trackId,
      trackName: track?.name ?? t.spec.trackId,
      laps: t.spec.laps,
      weather: t.spec.weather,
      startsAt: t.spec.startsAt,
      createdAt: t.spec.createdAt,
      qualifyClosesAt: q.closesAt,
      groupSize: t.groupSize,
      status: t.status,
      phase: this.phaseOf(t, now),
      entries,
      grade: tournamentPrizesOf(t.spec).grade,
      auto: t.spec.auto === true,
      allEnter: t.spec.allEnter === true,
      /** この大会の景品 (言い表し) と、管理者が直すときの中身 (決めていなければ null = 格のはじめの景品) */
      prizes: prizeSummary(t.spec, { driver: (id) => this.namer().driver(id) }),
      prizeSpec: { prizes: t.spec.prizes ?? null, participation: t.spec.participation ?? null },
    };
  }

  listTournaments(includeCancelled = false) {
    this.closeDue();
    const now = this.now();
    const live = this.rows("SELECT body FROM tournaments WHERE status IN ('open', 'running') ORDER BY starts_at").map((r) => JSON.parse(String(r.body)) as TourRow);
    const done = this.rows("SELECT body FROM tournaments WHERE status = 'done' ORDER BY starts_at DESC LIMIT ?", TOUR_LIST_DONE).map((r) => JSON.parse(String(r.body)) as TourRow);
    const cancelled = includeCancelled ? this.rows("SELECT body FROM tournaments WHERE status = 'cancelled' ORDER BY starts_at DESC LIMIT 10").map((r) => JSON.parse(String(r.body)) as TourRow) : [];
    return { now, tournaments: [...live, ...done, ...cancelled].map((t) => this.tourBrief(t, now)) };
  }

  private quali(id: string, accountId: number): QualiBody | null {
    const r = this.row("SELECT body FROM tour_quali WHERE tid = ? AND account_id = ?", id, accountId);
    return r ? (JSON.parse(String(r.body)) as QualiBody) : null;
  }

  private saveQuali(id: string, accountId: number, body: QualiBody, best?: { ms: number; at: number } | null) {
    if (best === undefined) {
      this.sql.exec(
        "INSERT INTO tour_quali (tid, account_id, body) VALUES (?, ?, ?) ON CONFLICT(tid, account_id) DO UPDATE SET body = excluded.body",
        id,
        accountId,
        JSON.stringify(body),
      );
    } else {
      this.sql.exec(
        "INSERT INTO tour_quali (tid, account_id, best_ms, best_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tid, account_id) DO UPDATE SET best_ms = excluded.best_ms, best_at = excluded.best_at, body = excluded.body",
        id,
        accountId,
        best?.ms ?? null,
        best?.at ?? null,
        JSON.stringify(body),
      );
    }
  }

  private attempts(id: string): QualifyAttempt[] {
    return this.rows("SELECT account_id, best_ms, best_at FROM tour_quali WHERE tid = ? AND best_ms IS NOT NULL", id).map((r) => ({
      driverId: humanDriverId(Number(r.account_id)),
      teamId: tid(Number(r.account_id)),
      lapTime: Number(r.best_ms) / 1000,
      valid: true,
      at: Number(r.best_at),
    }));
  }

  /** 予選の表 (名前つき) */
  private qualiTable(t: TourRow, me: number | null) {
    const nm = this.namer();
    const table = qualifyingTable(t.spec, this.attempts(t.spec.id));
    const lead = table[0]?.lapTime ?? null;
    return table.map((r, i) => ({
      pos: i + 1,
      driver: nm.driver(r.driverId),
      team: nm.team(r.teamId),
      lap: r.lapTime,
      gap: lead === null || i === 0 ? null : Math.round((r.lapTime - lead) * 1000) / 1000,
      group: groupLetter(Math.floor(i / t.groupSize)),
      me: me !== null && r.teamId === tid(me),
    }));
  }

  /** 大会の様子 (ログインしていれば自分の予選とタイヤ) */
  tournamentView(id: string, accountId: number | null) {
    this.closeDue();
    const t = this.loadTour(id);
    if (!t || t.status === "cancelled") throw new ApiError(404, "その大会はありません");
    const now = this.now();
    const brief = this.tourBrief(t, now);
    const rules = allocRules("tournament", t.spec.laps, { qualifying: true });
    let mine = null;
    // 全員参加の大会: 画面を開いた = つないでいる (組を部屋で走るか、サーバーで計算するかを決める。TOUR_PRESENCE_MS)
    if (accountId !== null && t.spec.allEnter && t.status === "open" && now >= t.spec.startsAt - LOBBY_LEAD_MS - TOUR_PRESENCE_MS) this.markHere(id, accountId, now);
    if (accountId !== null) {
      const q = this.quali(id, accountId);
      const r = this.row("SELECT best_ms FROM tour_quali WHERE tid = ? AND account_id = ?", id, accountId);
      let group: { index: number; letter: string; slot: number; headless: boolean } | null = null;
      t.groups?.forEach((g, gi) => {
        const c = g.cars.find((x) => x.key === `acc:${accountId}`);
        // headless = この組はサーバーが計算する (つないでいなかった。代走が走る)
        if (c) group = { index: gi, letter: g.letter, slot: c.slot, headless: t.headless?.[gi] === true };
      });
      mine = {
        tires: q ? { alloc: q.q.alloc, sets: q.q.sets, locked: q.q.locked, runs: q.q.runs, options: setOptions(q.q.sets) } : null,
        best: r && r.best_ms !== null ? Number(r.best_ms) / 1000 : null,
        plan: q?.plan ?? null,
        design: q?.design ? { name: q.design.name } : null,
        group,
        /** 決勝のスタートのタイヤ (予定から) */
        raceSetup: q && q.plan.start ? raceSetupFromQuali(q.q, q.plan.start) : null,
      };
    }
    return {
      now,
      tournament: brief,
      rules,
      qualifying: this.qualiTable(t, accountId),
      groups: t.groups ?? null,
      results: t.results ?? null,
      me: mine,
    };
  }

  /** 大会の画面を開いた (全員参加の大会のつないでいる印) */
  markHere(id: string, accountId: number, now = this.now()): void {
    this.sql.exec("INSERT INTO tour_here (tid, account_id, at) VALUES (?, ?, ?) ON CONFLICT(tid, account_id) DO UPDATE SET at = excluded.at", id, accountId, now);
  }

  private openForQuali(id: string): TourRow {
    const t = this.loadTour(id);
    if (!t || t.status === "cancelled") throw new ApiError(404, "その大会はありません");
    if (t.status !== "open" || tournamentPhaseAt(t.spec, this.now()) !== "qualifying") throw new ApiError(409, "予選は締め切られました");
    return t;
  }

  /** 予選の前にタイヤの組を決める (最初の走りのあとは変えられない) */
  setQualiTires(acc: Account, id: string, raw: unknown) {
    return this.tx(() => {
      const t = this.openForQuali(id);
      const alloc = normalizeAlloc(raw);
      const errs = validateAlloc(alloc, allocRules("tournament", t.spec.laps, { qualifying: true }));
      if (errs.length) throw new ApiError(400, errs[0]);
      const cur = this.quali(id, acc.id);
      let q: QualiTires;
      if (cur) {
        const next = changeQualiAlloc(cur.q, alloc);
        if (!next) throw new ApiError(409, "予選を走り始めたので、組はもう変えられません");
        q = next;
      } else q = newQualiTires(alloc);
      const body: QualiBody = { q, design: cur?.design ?? null, plan: cur?.plan ?? { start: null, fuel: "race" }, rate: cur?.rate };
      this.saveQuali(id, acc.id, body);
      return { tires: { alloc: q.alloc, sets: q.sets, locked: q.locked, runs: q.runs, options: setOptions(q.sets) } };
    });
  }

  /**
   * 予選の 1 回の走りを送る: 使った組と走り終えたときの減り (持ち越し)。速い周があれば 1 周アタックと同じ確かめ (checkTaSubmission) をして記録。
   * 本文 { pick: {tire, used}, endWear, burst?, lap?, ghost?, design, designHash?, mt? }
   */
  qualiRun(acc: Account, id: string, b: Record<string, unknown>) {
    const design = parseDesign(b.design);
    if (!design || validateDesign(design).length) throw new ApiError(400, "設計図が読めません");
    const pick = readPick(b.pick);
    if (!pick) throw new ApiError(400, "タイヤの組がおかしいです");
    const endWear = Number(b.endWear);
    if (!Number.isFinite(endWear) || endWear < 0 || endWear > 1) throw new ApiError(400, "タイヤの減りがおかしいです");
    const hasLap = b.lap !== undefined && b.lap !== null;
    const lap = Number(b.lap);
    let pts: number[] | null = null;
    if (hasLap) {
      if (b.designHash !== undefined && b.designHash !== designHash(design)) throw new ApiError(400, "設計図の印が合いません");
      pts = decodeGhost(b.ghost);
      if (!pts) throw new ApiError(400, "走った線が読めません");
    }
    const now = this.now();
    return this.tx(() => {
      const t = this.openForQuali(id);
      const cur = this.quali(id, acc.id);
      if (!cur) throw new ApiError(400, "先にタイヤの組を決めてください");
      const rate = cur.rate && cur.rate.resetAt > now ? cur.rate : { n: 0, resetAt: now + HOUR_MS };
      if (rate.n >= QUALI_RUNS_PER_HOUR) throw new ApiError(429, "送るのが多すぎます。しばらくしてからもう一度");
      rate.n++;
      let improved = false;
      const prev = this.row("SELECT best_ms, best_at FROM tour_quali WHERE tid = ? AND account_id = ?", id, acc.id);
      let best: { ms: number; at: number } | null = prev && prev.best_ms !== null ? { ms: Number(prev.best_ms), at: Number(prev.best_at) } : null;
      if (hasLap && pts) {
        const track = getTrack(t.spec.trackId);
        // mt = マニュアルで走った (速さの上限を管理者の上がり分だけゆるめる)
        const why = checkTaSubmission({ lap, pts, design, mt: b.mt === true }, computeStats(design), track, this.accounts.inventory(acc.id), this.config().manualSpeedBonus);
        if (why) throw new ApiError(400, why);
        const ms = Math.round(lap * 1000);
        if (!best || ms < best.ms) {
          best = { ms, at: now };
          improved = true;
        }
      }
      const q = applyQualiRun(cur.q, pick, endWear, b.burst === true);
      if (!q) throw new ApiError(400, "その組は持っていません");
      // 予定のスタートの組が無くなったら (破裂したなど) 予定から外す
      const plan = { ...cur.plan };
      if (plan.start && !startFromSets(q.sets, plan.start)) plan.start = null;
      this.saveQuali(id, acc.id, { q, design, plan, rate }, best);
      const table = qualifyingTable(t.spec, this.attempts(id));
      const rank = table.findIndex((r) => r.teamId === tid(acc.id));
      return {
        improved,
        best: best ? best.ms / 1000 : null,
        rank: rank >= 0 ? rank + 1 : null,
        total: table.length,
        tires: { alloc: q.alloc, sets: q.sets, locked: q.locked, runs: q.runs, options: setOptions(q.sets) },
      };
    });
  }

  /** 決勝の予定 (スタートのタイヤと燃料、設計図)。来なかったときの代走もこれで走る。スタートの組を作るまで変えられる */
  setPlan(acc: Account, id: string, b: Record<string, unknown>) {
    return this.tx(() => {
      const t = this.loadTour(id);
      if (!t || t.status !== "open") throw new ApiError(409, "もう予定は変えられません");
      const cur = this.quali(id, acc.id);
      if (!cur) throw new ApiError(400, "先に予選のタイヤの組を決めてください");
      const plan = { ...cur.plan };
      if (b.start !== undefined) {
        if (b.start === null) plan.start = null;
        else {
          const pick = readPick(b.start);
          if (!pick || !startFromSets(cur.q.sets, pick)) throw new ApiError(400, "その組は持っていません");
          plan.start = pick;
        }
      }
      if (b.fuel !== undefined) {
        if (!FUEL_MODES.includes(b.fuel as FuelMode)) throw new ApiError(400, "燃料の選び方がおかしいです");
        plan.fuel = b.fuel as FuelMode;
      }
      let design = cur.design;
      if (b.design !== undefined) {
        const d = parseDesign(b.design);
        if (!d || validateDesign(d).length) throw new ApiError(400, "設計図が読めません");
        design = d;
      }
      this.saveQuali(id, acc.id, { ...cur, plan, design });
      return { plan, raceSetup: plan.start ? raceSetupFromQuali(cur.q, plan.start) : null };
    });
  }

  /** 組の部屋を開く時刻の来た大会 */
  dueLaunches(now = this.now()): string[] {
    return this.rows("SELECT id FROM tournaments WHERE status = 'open' AND starts_at - ? <= ? ORDER BY starts_at", LOBBY_LEAD_MS, now).map((r) => String(r.id));
  }

  /**
   * 大会の組を作る: 予選の順で groupSize ずつ (A = 1〜8 位 …)、予選の記録のない出場者 (雇った運転手・記録なしの人) は後ろ。
   * 予選の組を決めた人のチームが出場 (来なければ代走)。部屋に渡す FixedField を組ごとに返す。
   * 全員参加の大会 (allEnter): 全部の人のチームが 2 台で出る (予選の組を決めていないチームは 代走の車 = リーグ戦と同じ設計図)。
   * 雇った運転手のいないチームの 2 台目は埋め草 (運転手なし、点はチームだけ)。記録の無い車は 強い車ほど後ろ (tourgrid.ts)。
   * つないでいる人 (TOUR_PRESENCE_MS) のいない組は部屋に渡さず、スタートの時刻からサーバーで計算する (runHeadlessGroup)
   */
  launchTournament(id: string): FixedField[] {
    const t0 = this.loadTour(id);
    if (!t0 || t0.status !== "open") return [];
    const spec = t0.spec;
    const all = spec.allEnter === true;
    const quali = this.rows("SELECT account_id, body FROM tour_quali WHERE tid = ?", id)
      .map((r) => ({ acc: Number(r.account_id), body: JSON.parse(String(r.body)) as QualiBody }))
      // 管理者が止めている人のチームは出さない (止めている間だけ)
      .filter((x) => this.exists(x.acc) && !this.accounts.isSuspended(x.acc) && x.body.design && !validateDesign(x.body.design).length && designFits(x.body.design, this.accounts.inventory(x.acc)).ok);
    // チームの様子 (取りまとめの外で)
    const info = new Map<number, JoinTeam | null>();
    for (const x of quali) {
      try {
        info.set(x.acc, this.teamInfo ? this.teamInfo(x.acc, x.body.design!) : null);
      } catch {
        info.set(x.acc, null);
      }
    }
    // 全員参加: 予選の組を決めていないチーム (と、2 台目の設計図)
    const data = new Map<number, LeagueTeamData>();
    if (all && this.teamData) {
      for (const r of this.rows("SELECT id FROM accounts ORDER BY id")) {
        const acc = Number(r.id);
        if (this.accounts.isSuspended(acc)) continue;
        try {
          const d = this.teamData(acc);
          if (d) data.set(acc, d);
        } catch {
          /* そのチームは出ない */
        }
      }
    }
    const nm = this.namer();
    const track = getTrack(spec.trackId);
    /** 車ごとの もと (運転手 id → 部屋に渡す形を作る材料) */
    type Src =
      | { kind: "human"; acc: number; design: CarDesign; body: QualiBody | null; fam: number; serviceFactor?: number; skill: number }
      | { kind: "hired"; acc: number; design: CarDesign; name: string; driver?: FixedCar["driver"]; fam: number; serviceFactor?: number; skill: number };
    const src = new Map<string, Src>();
    const entrants: Array<{ driverId: string; teamId: string }> = [];
    const add = (driverId: string, acc: number, s: Src) => {
      if (src.has(driverId)) return;
      src.set(driverId, s);
      entrants.push({ driverId, teamId: tid(acc) });
    };
    for (const x of quali) {
      const ti = info.get(x.acc) ?? null;
      add(humanDriverId(x.acc), x.acc, { kind: "human", acc: x.acc, design: x.body.design!, body: x.body, fam: ti?.standInFam?.[spec.trackId] ?? 0, serviceFactor: ti?.serviceFactor, skill: STAND_IN_SKILL });
      const sec = ti?.second;
      if (sec) {
        add(sec.driverId, x.acc, { kind: "hired", acc: x.acc, design: sec.design, name: sec.name, driver: sec.driver, fam: sec.fam?.[spec.trackId] ?? 0, serviceFactor: ti?.serviceFactor, skill: driverTraits(sec.driver).skill });
      } else if (all) {
        const d = data.get(x.acc);
        add(fillerDriverId(x.acc), x.acc, { kind: "hired", acc: x.acc, design: d?.secondDesign ?? x.body.design!, name: `${nm.team(tid(x.acc)).slice(0, 8)} 2号車`, fam: 0, serviceFactor: ti?.serviceFactor, skill: STAND_IN_SKILL });
      }
    }
    for (const [acc, d] of data) {
      if (src.has(humanDriverId(acc))) continue;
      add(humanDriverId(acc), acc, { kind: "human", acc, design: d.design, body: null, fam: d.standInFam[spec.trackId] ?? 0, serviceFactor: d.serviceFactor, skill: STAND_IN_SKILL });
      if (d.hired) {
        add(d.hired.driverId, acc, { kind: "hired", acc, design: d.secondDesign, name: d.hired.name, driver: d.hired.stats, fam: d.hired.fam[spec.trackId] ?? 0, serviceFactor: d.serviceFactor, skill: driverTraits(d.hired.stats).skill });
      } else {
        add(fillerDriverId(acc), acc, { kind: "hired", acc, design: d.secondDesign, name: `${nm.team(tid(acc)).slice(0, 8)} 2号車`, fam: 0, serviceFactor: d.serviceFactor, skill: STAND_IN_SKILL });
      }
    }
    // 記録の無い車の強さ (全員参加だけ。強い車ほど後ろ)
    let strength: Map<string, number> | undefined;
    if (all) {
      const timed = new Set(qualifyingTable(spec, this.attempts(id)).map((r) => r.driverId));
      strength = new Map();
      for (const [driverId, s] of src) if (!timed.has(driverId)) strength.set(driverId, estimatedLap(s.design, spec.trackId, s.skill));
    }
    // 出ない人 (止めている・退会した・設計図が走れない) の予選の記録は組に入れない
    const { grid } = tournamentGrid(spec, this.attempts(id).filter((x) => src.has(x.driverId)), entrants, Number.MAX_SAFE_INTEGER, strength);
    // つないでいる人 (全員参加だけ)
    const here = new Set(
      all ? this.rows("SELECT account_id FROM tour_here WHERE tid = ? AND at >= ?", id, spec.startsAt - LOBBY_LEAD_MS - TOUR_PRESENCE_MS).map((r) => Number(r.account_id)) : [],
    );
    const groups: Array<{ letter: string; cars: TourGroupCar[] }> = [];
    const fields: FixedField[] = [];
    const headless: boolean[] = [];
    const weather = tournamentWeatherPlan(spec, spec.laps * 75);
    for (let g = 0; g * t0.groupSize < grid.length; g++) {
      const slice = grid.slice(g * t0.groupSize, (g + 1) * t0.groupSize);
      const cars: TourGroupCar[] = [];
      const fixed: FixedCar[] = [];
      let live = !all;
      slice.forEach((sl, i) => {
        const s = src.get(sl.driverId)!;
        const acc = s.acc;
        const human = s.kind === "human";
        const key = human ? `acc:${acc}` : `hire:${sl.driverId}`;
        const name = human ? nm.driver(sl.driverId) : s.name;
        cars.push({ key, teamId: sl.teamId, driverId: sl.driverId, kind: human ? "human" : "hired", name, team: nm.team(sl.teamId), lapTime: sl.lapTime, slot: i });
        if (s.kind === "human") {
          if (here.has(acc)) live = true;
          const body = s.body;
          const design = s.design;
          let setup: FixedCar["setup"] | undefined;
          if (body) {
            const stats = computeStats(design);
            const start = body.plan.start && startFromSets(body.q.sets, body.plan.start) ? body.plan.start : defaultStart(body.q);
            const st = start ? raceSetupFromQuali(body.q, start) : null;
            const need = fuelPerMeter(stats) * (spec.laps * track.length + 100) * 1.12 + 1.5;
            const fuel = body.plan.fuel === "full" ? stats.fuelCap : body.plan.fuel === "race" ? Math.min(stats.fuelCap, need) : Math.min(stats.fuelCap, need * 0.6);
            if (st) setup = { tire: st.tire, wear: st.wear, sets: st.sets, fuel };
          }
          fixed.push({
            key,
            name,
            design,
            slot: i,
            kind: "human",
            teamId: sl.teamId,
            driverId: sl.driverId,
            ...(setup ? { setup } : {}),
            fam: s.fam,
            ...(s.serviceFactor !== undefined ? { serviceFactor: s.serviceFactor } : {}),
          });
        } else {
          fixed.push({
            key,
            name,
            design: s.design,
            slot: i,
            kind: "hired",
            teamId: sl.teamId,
            driverId: sl.driverId,
            ...(s.driver ? { driver: s.driver } : {}),
            fam: s.fam,
            ...(s.serviceFactor !== undefined ? { serviceFactor: s.serviceFactor } : {}),
          });
        }
      });
      groups.push({ letter: groupLetter(g), cars });
      fields.push({ tag: `${id}:${g}`, trackId: spec.trackId, laps: spec.laps, startAt: spec.startsAt, weather, tireKind: "tournament", cars: fixed });
      headless.push(!live);
    }
    const done = this.tx(() => {
      const t = this.loadTour(id);
      if (!t || t.status !== "open") return false;
      // サーバーで計算する組は部屋に渡さない (渡した印を付けておく)
      this.saveTour({ ...t, status: "running", groups, fields, pushed: headless.map((h) => h), ...(all ? { headless } : {}) });
      return true;
    });
    if (!done) return [];
    // 誰も出ない大会はそのまま終わり
    if (!fields.length) this.finalizeTournament(id, true);
    return fields.filter((_, g) => !headless[g]);
  }

  /**
   * サーバーで計算する組を 1 つ走らせる (alarm で 1 組ずつ。スタートの時刻を過ぎた大会の、上の組から)。
   * 全部の車をコンピューターが走らせる (人の車は代走、2 台目は雇った運転手か埋め草)。走らせた組の名札を返す
   */
  runHeadlessGroup(now = this.now()): string | null {
    for (const r of this.rows("SELECT body FROM tournaments WHERE status = 'running' AND starts_at <= ? ORDER BY starts_at", now)) {
      const t = JSON.parse(String(r.body)) as TourRow;
      if (!t.headless || !t.fields) continue;
      for (let g = 0; g < t.fields.length; g++) {
        if (!t.headless[g] || this.row("SELECT grp FROM tour_groups WHERE tid = ? AND grp = ?", t.spec.id, g)) continue;
        const f = t.fields[g];
        const specs: HeadlessCarSpec[] = [...f.cars]
          .sort((a, b) => a.slot - b.slot)
          .map((c) => ({
            id: c.key,
            design: c.design,
            team: c.teamId,
            ...(c.serviceFactor !== undefined ? { serviceFactor: c.serviceFactor } : {}),
            ...(c.setup ? { setup: c.setup } : {}),
            ...(c.kind === "hired" && c.driver ? (({ wearScale, fuelScale }) => ({ wearScale, fuelScale }))(driverCarScales(c.driver)) : {}),
            brain:
              c.kind === "hired"
                ? ({ rand }) => (c.driver ? applyFamiliarity(driverBrain(c.driver, rand), c.fam ?? 0) : makeBrain(rand, STAND_IN_SKILL))
                : ({ rand }) => applyFamiliarity(makeBrain(rand, STAND_IN_SKILL), c.fam ?? 0, true),
          }));
        let seed = 7;
        for (const ch of f.tag) seed = (seed * 31 + ch.charCodeAt(0)) % 2_147_483_647;
        const sim = simulateRace(specs, { trackId: f.trackId, laps: f.laps, seed, weather: f.weather, tireKind: "tournament" });
        const byKey = new Map(f.cars.map((c) => [c.key, c]));
        const rows: FixedCarResult[] = sim.results.map((x) => {
          const c = byKey.get(x.id)!;
          return {
            key: c.key,
            teamId: c.teamId,
            driverId: c.driverId,
            kind: c.kind,
            pos: x.pos,
            gridPos: x.grid + 1,
            finished: x.finished,
            retired: x.retired,
            lapsDone: x.lapsDone,
            best: x.best,
            penalty: x.penalty,
            pitStops: x.pitStops,
            standIn: c.kind === "human",
            stints: x.stints ?? [],
            maxWet: sim.wetMax,
          };
        });
        this.recordTournamentGroup(f.tag, rows, f.startAt + Math.round(sim.raceSeconds * 1000));
        return f.tag;
      }
    }
    return null;
  }

  /** サーバーで計算する組がまだ残っている (スタートの時刻を過ぎた大会) */
  private headlessPending(now: number): boolean {
    for (const r of this.rows("SELECT body FROM tournaments WHERE status = 'running' AND starts_at <= ?", now)) {
      const t = JSON.parse(String(r.body)) as TourRow;
      if (t.headless?.some((h, g) => h && !this.row("SELECT grp FROM tour_groups WHERE tid = ? AND grp = ?", t.spec.id, g))) return true;
    }
    return false;
  }

  /** 組の部屋に渡せたら印を付ける (tag = "<大会の id>:<組>") */
  markPushed(tag: string) {
    const m = /^(.+):(\d+)$/.exec(tag);
    if (!m) return;
    const id = m[1];
    const group = Number(m[2]);
    this.tx(() => {
      const t = this.loadTour(id);
      if (!t || !t.pushed) return;
      t.pushed[group] = true;
      this.saveTour(t);
    });
  }

  /** 組の結果を受け取る (部屋の DO から)。全部そろったら決める */
  recordTournamentGroup(tag: string, rows: FixedCarResult[], endedAt: number): boolean {
    const m = /^(.+):(\d+)$/.exec(tag);
    if (!m) return false;
    const [, id, gs] = m;
    const g = Number(gs);
    const ready = this.tx(() => {
      const t = this.loadTour(id);
      if (!t || t.status !== "running" || !t.groups || g >= t.groups.length) return false;
      if (this.row("SELECT grp FROM tour_groups WHERE tid = ? AND grp = ?", id, g)) return false;
      this.sql.exec("INSERT INTO tour_groups (tid, grp, at, body) VALUES (?, ?, ?, ?)", id, g, endedAt, JSON.stringify(rows));
      return Number(this.row("SELECT COUNT(*) AS c FROM tour_groups WHERE tid = ?", id)?.c ?? 0) >= t.groups.length;
    });
    if (ready) this.finalizeTournament(id);
    return ready;
  }

  /** 締め切りを過ぎた大会を、届いた組だけで決める */
  finalizeOverdue(now = this.now()): string[] {
    const out: string[] = [];
    for (const r of this.rows("SELECT id, body FROM tournaments WHERE status = 'running'")) {
      const t = JSON.parse(String(r.body)) as TourRow;
      // サーバーで計算する組が残っていれば待つ (alarm で 1 組ずつ走らせている)
      if (t.headless?.some((h, g) => h && !this.row("SELECT grp FROM tour_groups WHERE tid = ? AND grp = ?", t.spec.id, g))) continue;
      if (now >= tourDeadline(t.spec)) {
        this.finalizeTournament(String(r.id), true);
        out.push(String(r.id));
      }
    }
    return out;
  }

  /**
   * 大会を決める: 組の順 (A の 1〜8 位 → B の 1〜8 位 …) に並べ、タイヤの決まりで失格を後ろへ (classifyTournament)。
   * 点は ×10 で季節へ、賞金 (管理者の表)、はんこ。取りまとめ 1 回
   */
  finalizeTournament(id: string, force = false): boolean {
    this.closeDue();
    const now = this.now();
    const ok = this.tx(() => {
      const t = this.loadTour(id);
      if (!t || t.status !== "running" || !t.groups) return false;
      const got = new Map<number, { at: number; rows: FixedCarResult[] }>();
      for (const r of this.rows("SELECT grp, at, body FROM tour_groups WHERE tid = ?", id)) got.set(Number(r.grp), { at: Number(r.at), rows: JSON.parse(String(r.body)) });
      if (!force && got.size < t.groups.length) return false;
      const cfg = this.config();
      const nm = this.namer();
      const results: TournamentCarResult[] = [];
      const extra = new Map<string, { group: string; fr: FixedCarResult; gridOverall: number }>();
      let offset = 0;
      let gridOffset = 0;
      let endedAt = 0;
      t.groups.forEach((grp, gi) => {
        const r = got.get(gi);
        if (r) {
          endedAt = Math.max(endedAt, r.at);
          const sorted = [...r.rows].sort((a, b) => a.pos - b.pos);
          for (const fr of sorted) {
            results.push({ driverId: fr.driverId, teamId: fr.teamId, pos: offset + fr.pos, finished: fr.finished, best: fr.best, stints: fr.stints, standIn: fr.standIn });
            extra.set(fr.driverId, { group: grp.letter, fr, gridOverall: gridOffset + fr.gridPos });
          }
          offset += sorted.length;
        }
        gridOffset += grp.cars.length;
      });
      const ended = endedAt || now;
      const { cars, race } = classifyTournament(t.spec, results, ended);
      // 埋め草の車 (全員参加の大会で雇った運転手のいないチームの 2 台目): 点はチームだけ
      for (const rc of race.cars) if (isFiller(rc.driverId)) rc.filler = true;
      const counted = !this.row("SELECT race_id FROM season_races WHERE race_id = ?", race.raceId);
      const field = cars.length;
      const rows: TourResultRow[] = [];
      if (counted) {
        this.sql.exec("INSERT INTO season_races (race_id, kind, at) VALUES (?, 'tournament', ?)", race.raceId, ended);
        let tally = this.tally();
        if (tally.season === seasonIndexAt(ended) && race.cars.length) {
          tally = addRaceToTally(tally, race, cfg.season);
          this.kvPut("tally", tally);
        }
      }
      const season = seasonIndexAt(ended);
      for (const c of cars) {
        const rc = race.cars.find((x) => x.driverId === c.driverId)!;
        const points = Math.round(baseRacePoints(rc, field) * cfg.season.tournamentMul);
        const prize = racePrizeFor(cfg, "tournament", { pos: c.finalPos, points, finished: c.finished, dq: c.dq }, { laps: t.spec.laps, cpuOnly: false });
        const ex = extra.get(c.driverId);
        if (counted && c.teamId) {
          this.credit(aidOf(c.teamId), prize, `大会「${t.spec.name}」${c.finalPos} 位`, ended);
          // 大会の優勝の限界突破の品は、大会の格の景品 (大の 1 位 = 限界設計図) に任せる。
          // 毎日の大会で毎回 設計図が出ないように、ここでは別に渡さない (11/25)
          if (ex && ex.fr.kind === "human") {
            const mate = cars.find((x) => x.teamId === c.teamId && x.driverId !== c.driverId);
            const stamps = raceStamps({
              kind: "tournament",
              laps: t.spec.laps,
              pos: c.finalPos,
              gridPos: ex.gridOverall,
              finished: c.finished,
              dq: c.dq,
              fastest: c.fastest,
              standIn: c.standIn,
              pitStops: ex.fr.pitStops,
              maxWet: ex.fr.maxWet,
              penalty: ex.fr.penalty,
              teammatePos: mate ? mate.finalPos : null,
              tiresUsed: [...new Set(c.stints.filter((s) => s.meters > 0).map((s) => s.tire))],
            });
            this.giveStamps(c.teamId, stamps, ended, season);
          }
        }
        // 走行点 (racepoints.ts): 自分で走った人の車だけ (代走・雇った運転手・埋め草は無し)。大会は 1 日 1 回なので上限の外
        let rp = 0;
        if (counted && c.teamId && ex && ex.fr.kind === "human" && !c.standIn) {
          const want = rpForRace(cfg, { pos: c.finalPos, finished: c.finished, dq: c.dq }, { laps: t.spec.laps, kind: "tournament" });
          rp = earnRacePoints(this.sql, cfg, aidOf(c.teamId), want, { kind: "tour", reason: `大会「${t.spec.name}」${c.finalPos} 位`.slice(0, 60), at: ended, capped: false })?.earned ?? 0;
        }
        rows.push({
          ...(rp > 0 ? { rp } : {}),
          finalPos: c.finalPos,
          group: ex?.group ?? "",
          driverId: c.driverId,
          teamId: c.teamId ?? "",
          name: nm.driver(c.driverId),
          team: c.teamId ? nm.team(c.teamId) : "",
          finished: c.finished,
          dq: c.dq,
          fastest: c.fastest,
          standIn: c.standIn === true,
          best: c.best,
          points: c.dq || !c.finished ? 0 : points,
          prize: counted ? prize : 0,
        });
      }
      // 大会の景品 (tourprize.ts): 順位の景品と参加賞を、結果と同じ取りまとめで渡す (失格・完走できずはなし。代走ももらう)
      if (counted && this.grantPrizes) {
        const giveAt = this.now();
        const names = { driver: (d: string) => nm.driver(d) };
        for (const a of tournamentPrizeAwards(cars, tournamentPrizesOf(t.spec))) {
          const got = this.grantPrizes(aidOf(a.teamId), [...a.cars.flatMap((c) => c.items), ...a.participation], giveAt);
          if (!got) continue;
          for (const c of a.cars) {
            const row = rows.find((r) => r.driverId === c.driverId);
            if (row) row.gifts = [...(row.gifts ?? []), ...c.items.map((it) => describeGiftItem(it, names))];
          }
          const top = rows.filter((r) => r.teamId === a.teamId && r.finished && !r.dq).sort((x, y) => x.finalPos - y.finalPos)[0];
          if (top) {
            if (a.participation.length) top.gifts = [...(top.gifts ?? []), ...a.participation.map((it) => `参加賞: ${describeGiftItem(it, names)}`)];
            if (got.failed.length) top.giftsMissed = got.failed;
          }
          const lines = [...got.received, ...got.later];
          this.sql.exec(
            "INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) VALUES (?, ?, 'tournament_prize', ?, ?, ?, 0)",
            aidOf(a.teamId),
            `tourprize:${id}`,
            "大会の景品を受け取りました",
            `「${t.spec.name}」: ${lines.join("・") || "—"}${got.failed.length ? `。受け取れなかったもの: ${got.failed.join("・")}` : ""}`.slice(0, 300),
            giveAt,
          );
        }
      }
      // 出場したチームに知らせ
      for (const team of new Set(rows.map((r) => r.teamId).filter(Boolean))) {
        const mine = rows.filter((r) => r.teamId === team).map((r) => `${r.name} ${r.dq ? "失格" : r.finished ? `${r.finalPos} 位` : "完走できず"}`);
        this.sql.exec(
          "INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) VALUES (?, ?, 'tournament_result', ?, ?, ?, 0)",
          aidOf(team),
          `tourres:${id}`,
          "大会の結果",
          `「${t.spec.name}」: ${mine.join("・")}`.slice(0, 200),
          ended,
        );
      }
      this.saveTour({ ...t, status: "done", results: rows, endedAt: ended });
      return true;
    });
    // 大会の優勝の賭けを払う (取りまとめの外で)
    if (ok) this.onTournamentClosed?.(id);
    return ok;
  }

  /** 組の部屋にまだ渡せていない分 (スタートの前だけ。部屋の DO に渡しそこねたときにやり直す) */
  unpushed(now = this.now()): FixedField[] {
    const out: FixedField[] = [];
    for (const r of this.rows("SELECT body FROM tournaments WHERE status = 'running' AND starts_at > ?", now)) {
      const t = JSON.parse(String(r.body)) as TourRow;
      (t.fields ?? []).forEach((f, g) => {
        if (!t.pushed?.[g]) out.push(f);
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- 知らせ・目覚まし

  private noticeSources() {
    return {
      tournaments: this.rows("SELECT body FROM tournaments WHERE status IN ('open', 'running')").map((r) => {
        const t = JSON.parse(String(r.body)) as TourRow;
        // 毎日の大会は 1 時間前だけ
        return { id: t.spec.id, name: t.spec.name, startsAt: t.spec.startsAt, ...(t.spec.auto ? { leads: DAILY_TOUR.noticeLeadsMs } : {}) };
      }),
    };
  }

  /** 大会の 24 時間前と 1 時間前の知らせを、全員に入れる (同じ知らせは 1 回) */
  deliverNotices(now = this.now()): number {
    const sent = this.kvGet<string[]>("notices_sent") ?? [];
    const due = dueNotices(this.noticeSources(), now, sent);
    if (!due.length) return 0;
    this.tx(() => {
      for (const n of due) {
        const startsAt = Number(n.data.startsAt);
        const hours = Math.round((startsAt - n.at) / HOUR_MS);
        const when = new Date(startsAt + 9 * HOUR_MS).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");
        const text = `「${n.data.name}」が ${hours >= 24 ? "明日" : `${hours} 時間後`} (${when}) に始まります`;
        this.sql.exec(
          "INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) SELECT id, ?, ?, ?, ?, ?, 0 FROM accounts",
          n.id,
          n.kind,
          NOTICE_TITLES[n.kind],
          text,
          n.at,
        );
      }
      // 送った印は 300 個まで残す
      this.kvPut("notices_sent", [...sent, ...due.map((n) => n.id)].slice(-300));
    });
    return due.length;
  }

  /** 次に起きる時刻 (季節の切れ目・大会の組を開く・締め切り・知らせ) */
  nextWake(now = this.now()): number | null {
    let best: number | null = seasonWindow(Math.max(this.tally().season, seasonIndexAt(now))).endsAt;
    const take = (t: number | null | undefined) => {
      if (t !== null && t !== undefined && Number.isFinite(t) && (best === null || t < best)) best = t;
    };
    for (const r of this.rows("SELECT status, body FROM tournaments WHERE status IN ('open', 'running')")) {
      const t = JSON.parse(String(r.body)) as TourRow;
      take(t.status === "open" ? t.spec.startsAt - LOBBY_LEAD_MS : tourDeadline(t.spec));
    }
    take(nextNoticeAt(this.noticeSources(), now, this.kvGet<string[]>("notices_sent") ?? []));
    // 毎日の大会: 次に開く時刻。開くはずの大会がまだ無ければ今すぐ。サーバーで計算する組が残っていれば今すぐ (1 組ずつ)
    if (this.autoTournaments) {
      const s = dailyTourSettings(this.config());
      if (this.dailyCandidate(now)) take(now);
      take(nextDailyTourOpen(now, s));
    }
    if (this.headlessPending(now)) take(now);
    return best;
  }

  /** 今 開くべき毎日の大会 (まだ無く、その日に管理者の大会も無いとき)。無ければ null */
  private dailyCandidate(now: number): TournamentSpec | null {
    const s = dailyTourSettings(this.config());
    const day = dailyTourDayDue(now, s);
    if (day === null) return null;
    const spec = dailyTourSpec(day, s, now);
    // 一度作った日は (取りやめても) もう作らない
    if (this.loadTour(spec.id)) return null;
    // 管理者が作った大会がある日は開かない
    const dayStart = jstDayStart(spec.startsAt);
    for (const r of this.rows("SELECT body FROM tournaments WHERE status != 'cancelled' AND starts_at >= ? AND starts_at < ?", dayStart, dayStart + 24 * HOUR_MS)) {
      if (!(JSON.parse(String(r.body)) as TourRow).spec.auto) return null;
    }
    return spec;
  }

  /**
   * 毎日の大会を開く (DECISIONS 11/25「大会を毎日自動で開く・全員参加」。dailytour.ts)。何度呼んでも 1 日 1 つ (id が日で決まる)。
   * 管理者の画面で止められる (autoTourOn)。作った大会の id を返す
   */
  ensureDailyTournament(now = this.now()): string | null {
    if (!this.autoTournaments) return null;
    return this.tx(() => {
      const spec = this.dailyCandidate(now);
      if (!spec) return null;
      this.saveTour({ spec, groupSize: DAILY_TOUR.groupSize, status: "open" });
      return spec.id;
    });
  }

  /** alarm から: 季節の締め・知らせ・締め切りの大会。組を開く大会の FixedField を返す (DO が部屋に渡す) */
  tick(now = this.now()): { closed: number[]; launch: FixedField[]; finalized: string[] } {
    const closed = this.closeDue(now);
    this.ensureDailyTournament(now);
    this.deliverNotices(now);
    for (const id of this.dueLaunches(now)) this.launchTournament(id);
    // サーバーで計算する組 (1 回に 1 組。残りは次の alarm)
    this.runHeadlessGroup(now);
    const finalized = this.finalizeOverdue(now);
    // 組を開いた大会 (と、前に渡しそこねた組) の部屋の中身。DO が部屋に渡して markPushed する
    return { closed, launch: this.unpushed(now), finalized };
  }

  // ---------------------------------------------------------------- 管理者: 遊ぶ人の一覧

  players(limit = 200) {
    const classes = this.kvGet<ClassTable>("classes") ?? {};
    return this.rows(
      "SELECT a.id, a.login, a.team, a.driver, a.money, a.created_at, (SELECT MAX(created_at) FROM sessions s WHERE s.account_id = a.id) AS last_login, (SELECT reason FROM suspended x WHERE x.account_id = a.id) AS suspended FROM accounts a ORDER BY a.id DESC LIMIT ?",
      Math.max(1, Math.min(1000, limit)),
    ).map((r) => ({
      login: String(r.login),
      team: String(r.team),
      driver: String(r.driver),
      money: Number(r.money),
      cls: classes[tid(Number(r.id))] ?? null,
      createdAt: Number(r.created_at),
      lastLogin: r.last_login === null ? null : Number(r.last_login),
      admin: this.accounts.isAdmin({ login: String(r.login) } as Account),
      /** 止められていれば わけ (空の文字もある)、止められていなければ null */
      suspended: r.suspended === null || r.suspended === undefined ? null : String(r.suspended),
    }));
  }
}

const TOUR_ISSUE_TEXT: Record<string, string> = {
  name: "名前",
  track: "コース",
  laps: "周回",
  weather: "天気",
  past: "日時が過ぎている",
  no_qualifying_window: "予選の時間が 6 時間に足りない (前の日までに組む)",
  grade: "格",
  group: "組の大きさ",
};

function readWeather(raw: unknown): TournamentWeather | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const sky = (s: unknown): s is Sky => s === "sun" || s === "light" || s === "heavy";
  if (w.mode === "fixed" && sky(w.sky)) return { mode: "fixed", sky: w.sky };
  if (w.mode === "random") {
    const seed = Number(w.seed ?? Math.floor(Math.random() * 1e9));
    const rain = w.rain === undefined ? undefined : Number(w.rain);
    if (!Number.isFinite(seed) || (rain !== undefined && !(rain >= 0 && rain <= 1))) return null;
    return { mode: "random", seed: Math.floor(seed), ...(rain !== undefined ? { rain } : {}), ...(sky(w.startSky) ? { startSky: w.startSky } : {}) };
  }
  return null;
}

function readPick(raw: unknown): SetPick | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (!isTireCompound(p.tire)) return null;
  if (p.used === undefined || p.used === null) return { tire: p.tire, used: null };
  const u = Number(p.used);
  return Number.isInteger(u) && u >= 0 && u < 40 ? { tire: p.tire, used: u } : null;
}

/** 予定のないときの決勝のスタートのタイヤ: 乾いた路面用の新品 (普通 → 硬い → 柔らかい)、なければ一番減っていない組 */
function defaultStart(q: QualiTires): SetPick | null {
  const opts = setOptions(q.sets);
  for (const c of ["M", "H", "S"] as const) {
    const o = opts.find((x) => x.tire === c && x.used === null);
    if (o) return { tire: c, used: null };
  }
  const dry = opts.filter((o) => TIRE_DEFS[o.tire].slick).sort((a, b) => a.wear - b.wear)[0] ?? opts.sort((a, b) => a.wear - b.wear)[0];
  return dry ? { tire: dry.tire, used: dry.used } : null;
}

// ---------------------------------------------------------------- /api/season・/api/tournaments・/api/admin/...

const MAX_BODY = 64 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "送るものが大きすぎます");
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下で断る */
  }
  throw new ApiError(400, "送られてきたものが読めません");
}

export const SEASON_PATH = /^\/api\/(season|tournaments|race-rules|admin\/(config|players|tournaments|dev))(\/|$)/;

export interface SeasonApiOpts {
  /** 作るときだけ: 時計をずらせる (POST /api/admin/dev/clock)。本番では無し */
  devClock?: { get(): number; set(offsetMs: number): Promise<void> | void };
  /** 時計をずらしたあとや管理者の操作のあとに、季節と大会を進める (DO の alarm と同じこと) */
  tick?: () => Promise<unknown>;
}

/**
 * GET  /api/season                         季節の順位 (級ごとのチームと運転手、総合のコンストラクターと運転手、前の季節のまとめ)。ログインしていれば自分の様子も
 * GET  /api/season/me                      自分のはんこ帳と季節の記録 (ログインが要る)
 * GET  /api/season/history                 締めた季節のまとめ
 * GET  /api/race-rules                     走りの決まりの数とお知らせ { manualSpeedBonus, announcement } (誰でも)
 * GET  /api/tournaments                    大会の一覧
 * GET  /api/tournaments/:id                大会の様子 (予選の表・組・結果・自分のタイヤと予定)
 * POST /api/tournaments/:id/tires          予選のタイヤの組を決める { alloc }
 * POST /api/tournaments/:id/quali          予選の 1 回の走りを送る { pick, endWear, burst?, lap?, ghost?, design, designHash? }
 * POST /api/tournaments/:id/plan           決勝の予定 { start?, fuel?, design? }
 * 管理者だけ:
 * GET  /api/admin/config  PUT (一部の変更)  POST /api/admin/config/reset
 * GET  /api/admin/config/history (変更の記録、新しい物から 200 件)  POST /api/admin/config/history/:id/restore { side?: "after"|"before" }
 * POST /api/admin/config/import { config }  POST /api/admin/config/undo (一番新しい変更を取り消す)
 * GET  /api/admin/players
 * GET  /api/admin/tournaments  POST (作る)  PUT /api/admin/tournaments/:id (直す)  DELETE /api/admin/tournaments/:id (取りやめ)
 * POST /api/admin/dev/clock { offsetMs } (作るときだけ)   POST /api/admin/dev/tick
 */
export async function handleSeasonApi(req: Request, path: string, method: string, accounts: AccountStore, season: SeasonStore, opts: SeasonApiOpts = {}): Promise<Response> {
  const auth = () => accounts.auth(bearer(req));
  const need = async () => {
    const a = await auth();
    if (!a) throw new ApiError(401, "ログインしてください");
    return a;
  };
  const M = method.toUpperCase();

  if (path === "/api/season" && M === "GET") return json(season.seasonView((await auth())?.id ?? null));
  // 走りの決まりの数 (誰でも読める): マニュアルの速さの上がり分 (11/25 足した)
  if (path === "/api/race-rules" && M === "GET") {
    const c = season.config();
    return json({ manualSpeedBonus: c.manualSpeedBonus, announcement: c.announcement });
  }
  if (path === "/api/season/me" && M === "GET") return json(season.myStamps((await need()).id));
  if (path === "/api/season/history" && M === "GET") return json({ seasons: season.seasonHistory() });
  if (path === "/api/tournaments" && M === "GET") return json(season.listTournaments());
  const tm = /^\/api\/tournaments\/([a-z0-9]{1,40})(\/(tires|quali|plan))?$/.exec(path);
  if (tm) {
    const id = tm[1];
    const sub = tm[3];
    if (!sub && M === "GET") return json(season.tournamentView(id, (await auth())?.id ?? null));
    if (sub && M === "POST") {
      const a = await need();
      const b = await body(req);
      if (sub === "tires") return json(season.setQualiTires(a, id, b.alloc));
      if (sub === "quali") return json(season.qualiRun(a, id, b));
      return json(season.setPlan(a, id, b));
    }
  }

  if (path.startsWith("/api/admin/")) {
    const a = await need();
    if (!accounts.isAdmin(a)) throw new ApiError(403, "管理者だけができます");
    if (path === "/api/admin/config" && M === "GET") return json({ config: season.config(), defaults: DEFAULT_ADMIN_CONFIG });
    const by = { id: a.id, login: a.login };
    if (path === "/api/admin/config" && M === "PUT") return json({ config: season.setConfig(await body(req), by) });
    if (path === "/api/admin/config/reset" && M === "POST") return json({ config: season.resetConfig(by) });
    // 変更の記録・読みこみ・取り消し・版に戻す (admin_config_log.ts)
    if (path === "/api/admin/config/history" && M === "GET") return json({ entries: season.configLog.list() });
    if (path === "/api/admin/config/import" && M === "POST") {
      const b = await body(req);
      return json({ config: season.setConfig(b && typeof b.config === "object" && b.config !== null ? b.config : b, by, "import") });
    }
    if (path === "/api/admin/config/undo" && M === "POST") return json({ config: season.undoConfig(by) });
    const cr = /^\/api\/admin\/config\/history\/(\d{1,12})\/restore$/.exec(path);
    if (cr && M === "POST") {
      const b = await body(req);
      return json({ config: season.restoreConfig(Number(cr[1]), b?.side === "before" ? "before" : "after", by) });
    }
    if (path === "/api/admin/players" && M === "GET") return json({ players: season.players() });
    if (path === "/api/admin/tournaments" && M === "GET") return json({ ...season.listTournaments(true), tracks: TRACK_DEFS.map((d) => ({ id: d.id, name: d.name })) });
    if (path === "/api/admin/tournaments" && M === "POST") {
      const t = season.createTournament(await body(req));
      await opts.tick?.();
      return json({ tournament: t.spec, groupSize: t.groupSize }, 201);
    }
    const am = /^\/api\/admin\/tournaments\/([a-z0-9]{1,40})$/.exec(path);
    if (am && M === "PUT") {
      const t = season.updateTournament(am[1], await body(req));
      await opts.tick?.();
      return json({ tournament: t.spec, groupSize: t.groupSize });
    }
    if (am && M === "DELETE") {
      season.cancelTournament(am[1]);
      await opts.tick?.();
      return json({ ok: true });
    }
    if (path === "/api/admin/dev/clock" && M === "POST") {
      if (!opts.devClock) throw new ApiError(404, "ありません");
      const b = await body(req);
      const off = Number(b.offsetMs);
      if (!Number.isFinite(off) || Math.abs(off) > 400 * 24 * HOUR_MS) throw new ApiError(400, "ずらす時間がおかしいです");
      await opts.devClock.set(off);
      const r = await opts.tick?.();
      return json({ offsetMs: opts.devClock.get(), now: season.now(), tick: r ?? null });
    }
    if (path === "/api/admin/dev/tick" && M === "POST") {
      if (!opts.devClock) throw new ApiError(404, "ありません");
      return json({ now: season.now(), tick: (await opts.tick?.()) ?? null });
    }
  }
  throw new ApiError(404, "ありません");
}

/** リーグ戦の週 (= 季節) の 1 位: リーグ戦の分 (部の重み付き) が一番多い人のチーム (同じなら id の小さい順)。いなければ null */
export function leagueWeekTop(acc: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  let bestV = 0;
  for (const [team, v] of Object.entries(acc ?? {})) {
    if (!/^\d+$/.test(team) || !(typeof v === "number" && v > 0)) continue;
    if (v > bestV || (v === bestV && best !== null && Number(team) < Number(best))) {
      best = team;
      bestV = v;
    }
  }
  return best;
}
