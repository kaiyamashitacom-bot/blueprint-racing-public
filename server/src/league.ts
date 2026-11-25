// リーグ戦 (2 時間ごとの自動のレース) の保存と進め方、/api/league/... の受け口。LeagueDO (league_do.ts) の中で、その DO の SQLite に表を作って使う。
// 中身の計算は shared (league.ts・scheduled.ts・rivals.ts・leaguerace.ts・familiarity.ts・stamps.ts・constructors.ts)。
// 進め方 (DECISIONS 11/25「2 時間ごとに自動でレース」「サーバーの重さの対策」「1 部から計算」):
// - poke (cron か alarm から): 新しい枠が来たら、アカウントの一覧に合わせてリーグに入れ・外し、その枠のレースを予定に積む (1 部から)
// - step (alarm から 1 回ずつ): 予定の先頭の 1 レースだけを計算する (1 回の呼び出しを短く)。22 時のレースが全部終わったら、次の step で日を締める
// - 日の締め: 賞金 (アカウントの DO に払ってもらう)・部の入れ替え・王者・週のはんこ・コンストラクターの分 (6a の受け口)
// - アカウントの DO への用 (育ち・慣れ・賞金・コンストラクター) は、先に自分の表を書いてから「送る箱」(outbox) に入れて送る。届かなければ次の step で送り直す
// 自分のチームの結果だけ見られる (出たレースだけ。ほかのリーグのレースは見られない)。
// 数は全部 仮。
import {
  activeLeagues,
  addLeagueDayToConstructors,
  addLeagueRace,
  addRivalPoints,
  advanceRivalDay,
  advanceRivalSeason,
  betCarKey,
  anyPartDef,
  applyFamiliarity,
  BOT_DESIGNS,
  CHAMPION_TITLE,
  closeLeagueDay,
  createRivals,
  DEFAULT_ADMIN_CONFIG,
  divisionTitle,
  DIVISION_COUNT,
  driverBrain,
  driverCarScales,
  familiarityNow,
  findLeagueOf,
  joinLeague,
  leagueDayAt,
  leagueDayStart,
  leagueName,
  leaguePrizeFor,
  leagueStandings,
  leagueTeams,
  leagueWeekStamps,
  leaveLeague,
  makeBrain,
  moveTeamToDivision,
  newLeagueState,
  nextScheduledAt,
  planScheduledRaces,
  recordFamiliarity,
  rivalBrain,
  rivalCarScales,
  rivalDesign,
  scheduledEntries,
  scheduledQueue,
  scheduledSlotIndex,
  scheduledSlotStart,
  scheduledTrackId,
  SCHEDULED_DROP_AFTER_SLOTS,
  SCHEDULED_EVERY_MS,
  SCHEDULED_LAPS,
  seasonIndexAt,
  partStrengthOf,
  simulateRace,
  STAND_IN_SKILL,
  TRACK_DEFS,
  type AdminConfig,
  type PartStrength,
  type BetResultCar,
  type ConstructorLeagueAcc,
  type FamiliarityMap,
  type HeadlessCarSpec,
  type League,
  type LeagueState,
  type RaceCar,
  type RivalTeam,
  type ScheduledRacePlan,
  type StampId,
  type TeamDrivers,
  type TeamRaceReport,
} from "@bpr/shared";
import type { SqlRunner, SqlValue } from "./accounts.ts";
import type { LeagueMember, LeagueTeamData } from "./league_accounts.ts";
import type { PlaceBetInput } from "./bets.ts";

/** 賭けの返事 (アカウントの DO の RPC は ApiError の数を運べないので、形で返す) */
export type PlaceBetReply = { ok: true; bet: unknown; money: number } | { ok: false; status: number; error: string };

/** step のあいだの alarm の間 (ms、仮)。1 回の呼び出しで 1 レースだけ計算し、次は少しあけて */
export const LEAGUE_STEP_GAP_MS = 1000;
/** 何も積んでいないとき、次の枠のこれだけあとに自分でも起きる (cron の控え、仮) */
export const LEAGUE_WAKE_AFTER_SLOT_MS = 15_000;
/** 1 レースの計算を試す回数 (アカウントの DO に届かないなど)。超えたら「計算していない」にする (仮) */
export const LEAGUE_RACE_TRIES = 3;
/** 結果と日の記録を残す日数 (仮) */
export const LEAGUE_KEEP_DAYS = 14;
/** 送る箱の 1 つを送り直す回数 (仮) */
export const LEAGUE_OUTBOX_TRIES = 30;
/** 1 日の最後の枠 (22 時、日本時間) */
const LAST_SLOT_OF_DAY = 24 / (SCHEDULED_EVERY_MS / 3_600_000) - 1;
const DAY_MS = 24 * 3_600_000;

/** アカウントの DO への用 (league_do.ts が RPC で、試験は直接つなぐ) */
export interface LeagueAccountsPort {
  roster(): Promise<LeagueMember[]>;
  auth(token: string | null): Promise<LeagueMember | null>;
  teams(teamIds: string[]): Promise<LeagueTeamData[]>;
  /** 代走の慣れ・雇った運転手の育ちと慣れ・整備・研究 (accounts_do の recordTeamRace。同じ raceId は 1 回だけ) */
  recordRace(raceId: string, report: TeamRaceReport, accountOf: Record<string, number>): Promise<void>;
  /** 同じ id は 1 回だけ払う */
  payPrizes(id: string, items: Array<{ accountId: number; amount: number; reason: string }>): Promise<void>;
  /**
   * その日のリーグ戦の分をコンストラクターに足す (accounts_do の addConstructorLeagueDay、季節の係 6a の受け口)。同じ dayKey は 1 回だけ。
   * meta = その日の部・王者・週のはんこ (季節の記録とはんこ帳に入る)
   */
  constructorsDay(dayKey: string, delta: ConstructorLeagueAcc, meta: LeagueDayMeta): Promise<void>;
  /** 管理者の数 (無ければ null = はじめの数) */
  adminConfig(): Promise<AdminConfig | null>;
  /** ギフトコードで決まった部の動き (まだ当てていないもの)。日の締めのあとに当てる。なくてよい */
  moves?(): Promise<LeagueMove[]>;
  /** 当てた部の動きを消してもらう (送る箱から) */
  ackMoves?(ids: number[]): Promise<void>;
  /** 賭けの払い (server/src/bets.ts の settle。result = null は計算できなかったレース → 返す)。同じ raceId は 1 回だけ。なくてよい */
  settleBets?(raceId: string, result: BetResultCar[] | null): Promise<void>;
  /** 賭ける (bets_league.ts から。お金を動かすのはアカウントの DO)。なくてよい (そのときは賭けの受け口が断る) */
  placeBet?(input: PlaceBetInput): Promise<PlaceBetReply>;
  /** 自分の賭け (結果待ち・記録)。なくてよい */
  myBets?(accountId: number): Promise<unknown>;
}

/** ギフトコードの部の動き (id はアカウントの DO の中の番号、division は行き先の部) */
export interface LeagueMove {
  id: number;
  teamId: string;
  division: number;
}

/** 日の締めで季節の係に渡すもの (server/src/season.ts の LeagueDayMeta と同じ形) */
export interface LeagueDayMeta {
  divisions?: Record<string, number>;
  champion?: string | null;
  stamps?: Record<string, StampId[]>;
}

export interface LeagueDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
}

/** 予定に積んだレース */
export interface QueuedRace extends ScheduledRacePlan {
  startsAt: number;
  trackId: string;
  laps: number;
  tries: number;
}

interface Queue {
  /** 予定に積んだ一番新しい枠 */
  planned: number;
  run: QueuedRace[];
  /** 締める日 (なし = null) */
  closeDue: number | null;
}

type OutboxItem =
  | { id: string; tries: number; kind: "record"; raceId: string; report: TeamRaceReport; accountOf: Record<string, number> }
  | { id: string; tries: number; kind: "pay"; payId: string; items: Array<{ accountId: number; amount: number; reason: string }> }
  | { id: string; tries: number; kind: "ctor"; dayKey: string; delta: ConstructorLeagueAcc; meta: LeagueDayMeta }
  | { id: string; tries: number; kind: "moves"; ids: number[] }
  | { id: string; tries: number; kind: "bets"; raceId: string; result: BetResultCar[] | null };

export type LeagueCarKind = "standin" | "hired" | "cpu" | "rival";

export interface LeagueRaceCar {
  teamId: string;
  team: string;
  driver: string;
  kind: LeagueCarKind;
  human: boolean;
  grid: number;
  pos: number;
  points: number;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  total: number;
  best: number | null;
  fastest: boolean;
  pitStops: number;
  tire: string;
}

export interface LeagueRaceRecord {
  raceId: string;
  slot: number;
  at: number;
  leagueId: string;
  league: string;
  division: number;
  trackId: string;
  laps: number;
  status: "done" | "not_computed";
  wetMax: number;
  teams: string[];
  cars: LeagueRaceCar[];
}

export interface LeagueDayRecord {
  day: number;
  closedAt: number;
  /** リーグ → 締めた日の順位 (名前つき) */
  standings: Record<string, Array<{ id: string; name: string; rank: number; points: number; wins: number; races: number; human: boolean }>>;
  awards: Array<{ teamId: string; leagueId: string; division: number; rank: number; points: number; prize: number }>;
  swaps: Array<{ up: { teamId: string; from: string; to: string }; down: { teamId: string; from: string; to: string } }>;
  champion: string | null;
  championName: string | null;
  weekStamps: Array<{ teamId: string; division: number }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS league_kv (
  k TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS league_teams (
  team_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS league_rivals (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS league_fam (
  who TEXT NOT NULL,
  track TEXT NOT NULL,
  v REAL NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (who, track)
);
CREATE TABLE IF NOT EXISTS league_races (
  race_id TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  at INTEGER NOT NULL,
  league_id TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS league_race_teams (
  team_id TEXT NOT NULL,
  race_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (team_id, race_id)
);
CREATE INDEX IF NOT EXISTS league_race_teams_at ON league_race_teams(team_id, at);
CREATE TABLE IF NOT EXISTS league_days (
  day INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);
`;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 設計図の部品の段階の平均 (ライバルの部品の上げ方の目安) */
/** 週のはんこ (チーム → はんこ) */
function weekStampMap(week: ReadonlyArray<{ teamId: string; division: number }>): Record<string, StampId[]> {
  const out: Record<string, StampId[]> = {};
  for (const w of week) {
    const s = leagueWeekStamps([w], w.teamId);
    if (s.length) out[w.teamId] = s;
  }
  return out;
}

function designTier(d: { parts: Array<{ id: string }> }): number {
  if (!d.parts.length) return 1;
  return d.parts.reduce((s, p) => s + (anyPartDef(p.id)?.tier ?? 1), 0) / d.parts.length;
}

export class LeagueStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  readonly now: () => number;

  constructor(
    deps: LeagueDeps,
    private port: LeagueAccountsPort,
  ) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  private kvGet<T>(k: string): T | null {
    const r = this.row("SELECT body FROM league_kv WHERE k = ?", k);
    return r ? (JSON.parse(String(r.body)) as T) : null;
  }

  private kvPut(k: string, v: unknown) {
    this.sql.exec("INSERT INTO league_kv (k, body) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body", k, JSON.stringify(v));
  }

  // ---------------------------------------------------------------- 保存

  state(now = this.now()): LeagueState {
    return this.kvGet<LeagueState>("state") ?? newLeagueState(leagueDayAt(now));
  }

  private saveState(s: LeagueState) {
    this.kvPut("state", s);
  }

  queue(): Queue {
    return this.kvGet<Queue>("queue") ?? { planned: Number.NEGATIVE_INFINITY, run: [], closeDue: null };
  }

  private saveQueue(q: Queue) {
    // JSON は -Infinity を残せないので、まだ積んでいないときは -1
    this.kvPut("queue", { ...q, planned: Number.isFinite(q.planned) ? q.planned : -1 });
  }

  private outbox(): OutboxItem[] {
    return this.kvGet<OutboxItem[]>("outbox") ?? [];
  }

  private pushOutbox(item: OutboxItem) {
    this.kvPut("outbox", [...this.outbox().filter((x) => x.id !== item.id), item]);
  }

  private teamName(id: string): string | null {
    const r = this.row("SELECT name FROM league_teams WHERE team_id = ?", id);
    return r ? String(r.name) : null;
  }

  private setTeamName(id: string, name: string) {
    this.sql.exec("INSERT INTO league_teams (team_id, name) VALUES (?, ?) ON CONFLICT(team_id) DO UPDATE SET name = excluded.name", id, name);
  }

  // ---------------------------------------------------------------- コンピューターのチーム (ライバル)

  /** リーグのコンピューターの席 (id "<リーグ>-cpu<n>") に結びつくライバルのチーム。はじめて使うときに作る (同じリーグ・同じ番号なら同じチーム) */
  rival(cpuId: string, league: Pick<League, "id" | "division">): RivalTeam {
    const r = this.row("SELECT body FROM league_rivals WHERE id = ?", cpuId);
    if (r) return JSON.parse(String(r.body)) as RivalTeam;
    const n = Math.max(0, Number(/-cpu(\d+)$/.exec(cpuId)?.[1] ?? 0));
    const rv = createRivals(hashStr(league.id) % 1_000_000, league.division, n + 1)[n];
    this.saveRival(cpuId, league.id, rv);
    return rv;
  }

  private saveRival(cpuId: string, leagueId: string, rv: RivalTeam) {
    this.sql.exec("INSERT INTO league_rivals (id, league_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", cpuId, leagueId, JSON.stringify(rv));
  }

  private famMap(who: string): FamiliarityMap {
    const out: FamiliarityMap = {};
    for (const r of this.rows("SELECT track, v, at FROM league_fam WHERE who = ?", who)) out[String(r.track)] = { v: Number(r.v), at: Number(r.at) };
    return out;
  }

  private famRecord(who: string, trackId: string, now: number) {
    const f = recordFamiliarity(this.famMap(who), trackId, now)[trackId];
    this.sql.exec("INSERT INTO league_fam (who, track, v, at) VALUES (?, ?, ?, ?) ON CONFLICT(who, track) DO UPDATE SET v = excluded.v, at = excluded.at", who, trackId, f.v, f.at);
  }

  /** 名前 (人のチームは覚えた名前、ライバルはチーム名) */
  private nameOf(id: string, state: LeagueState): string {
    const l = findLeagueOf(state, id);
    if (l && l.cpus.includes(id)) return this.rival(id, l).name;
    return this.teamName(id) ?? "(退会したチーム)";
  }

  // ---------------------------------------------------------------- 入る・外れる

  /** アカウントの一覧に合わせる: 無いチームを外し、新しいチームを入れる (8 部から) */
  private syncRoster(state: LeagueState, roster: readonly LeagueMember[]): LeagueState {
    const ids = new Set(roster.map((m) => m.teamId));
    let s = state;
    for (const l of state.leagues) for (const h of l.humans) if (!ids.has(h)) s = leaveLeague(s, h);
    for (const m of [...roster].sort((a, b) => Number(a.teamId) - Number(b.teamId))) {
      this.setTeamName(m.teamId, m.name);
      s = joinLeague(s, m.teamId);
    }
    return s;
  }

  /** 1 チームを入れる (画面を開いたとき。まだリーグにいなければ) */
  ensureMember(m: LeagueMember): LeagueState {
    return this.tx(() => {
      this.setTeamName(m.teamId, m.name);
      const s0 = this.state();
      if (findLeagueOf(s0, m.teamId)) return s0;
      const s = joinLeague(s0, m.teamId);
      this.saveState(s);
      return s;
    });
  }

  // ---------------------------------------------------------------- 進め方

  /**
   * cron・alarm から: 新しい枠が来たら予定に積む。dev = 開発用に、次の枠を今すぐ積む (時刻より先の枠も)。
   * 積んだ枠の番号を返す (積まなければ null)
   */
  async poke(now = this.now(), opts: { dev?: boolean } = {}): Promise<number | null> {
    await this.flushOutbox();
    let roster: LeagueMember[] | null = null;
    try {
      roster = await this.port.roster();
    } catch (e) {
      console.error("league roster", (e as Error)?.message ?? e);
    }
    return this.tx(() => {
      let state = this.state(now);
      if (roster) state = this.syncRoster(state, roster);
      const q = this.queue();
      const current = scheduledSlotIndex(now);
      const planned = Number.isFinite(q.planned) && q.planned >= 0 ? q.planned : Number.NEGATIVE_INFINITY;
      const slot = opts.dev ? Math.max(Number.isFinite(planned) ? planned + 1 : current, current) : current;
      let did: number | null = null;
      if (slot > planned) {
        const startsAt = scheduledSlotStart(slot);
        const plan = planScheduledRaces(startsAt, state);
        const fresh: QueuedRace[] = plan.races.map((r) => ({ ...r, startsAt, trackId: plan.trackId, laps: plan.laps, tries: 0 }));
        const { run, dropped } = scheduledQueue(q.run, fresh, opts.dev ? slot : current);
        for (const r of dropped) this.saveSkipped(r as QueuedRace, state);
        q.run = run as QueuedRace[];
        q.planned = slot;
        did = slot;
        // その日のレースが 1 つもなく日が変わった (人がいない・止まっていた): 前の日を締める
        const day = leagueDayAt(startsAt);
        if (state.day < day && !q.run.some((r) => leagueDayAt(r.startsAt) <= state.day)) q.closeDue = state.day;
      }
      this.saveState(state);
      this.saveQueue(q);
      return did;
    });
  }

  /** 次に起きる時刻 (やることがあればすぐ、なければ次の枠のあと) */
  nextWake(now = this.now()): number {
    const q = this.queue();
    if (q.run.length || q.closeDue !== null || this.outbox().length) return now + LEAGUE_STEP_GAP_MS;
    return nextScheduledAt(now) + LEAGUE_WAKE_AFTER_SLOT_MS;
  }

  /** 計算を待っているレースの数 */
  pending(): number {
    return this.queue().run.length;
  }

  /**
   * 1 回分だけ進める: 日を締める か 1 レースを計算する。返すのは したこと (なければ null)
   */
  async step(now = this.now()): Promise<{ kind: "close"; day: number } | { kind: "race"; raceId: string; status: "done" | "not_computed" | "retry" } | null> {
    await this.flushOutbox();
    const q = this.queue();
    const state = this.state(now);
    const head = q.run[0];
    if (q.closeDue !== null || (head && leagueDayAt(head.startsAt) > state.day)) return this.closeDay(now);
    if (!head) return null;
    // 古すぎる (計算が追いつかなかった): 計算せずに記録だけ
    const league = state.leagues.find((l) => l.id === head.leagueId);
    if (scheduledSlotIndex(now) - head.slot >= SCHEDULED_DROP_AFTER_SLOTS || !league || league.humans.length === 0) {
      this.tx(() => {
        if (league && league.humans.length) this.saveSkipped(head, state);
        else this.voidBets(head.raceId);
        this.finishHead(head);
      });
      return { kind: "race", raceId: head.raceId, status: "not_computed" };
    }
    let data: LeagueTeamData[] | null = null;
    try {
      data = await this.port.teams(league.humans);
    } catch (e) {
      console.error("league teams", (e as Error)?.message ?? e);
    }
    // 部品の強さの倍率 (管理者の数)。読めなければ全部 1 で
    let strength: PartStrength | null = null;
    try {
      const cfg = await this.port.adminConfig();
      if (cfg) strength = partStrengthOf(cfg);
    } catch (e) {
      console.error("league admin config", (e as Error)?.message ?? e);
    }
    return this.tx(() => {
      // 待っている間に変わっていても、今の様子で計算する
      const st = this.state(now);
      const lg = st.leagues.find((l) => l.id === head.leagueId);
      const qq = this.queue();
      if (!qq.run.length || qq.run[0].raceId !== head.raceId) return null;
      if (!data || !lg) return this.retryHead(qq, st);
      // 走れる人のチームが 1 つもない (全員 管理者が止めている・退会した): 計算しない。賭けは返す
      if (!lg.humans.some((h) => data!.some((d) => d.teamId === h))) {
        this.voidBets(head.raceId);
        this.finishHead(head);
        return { kind: "race" as const, raceId: head.raceId, status: "not_computed" as const };
      }
      try {
        this.runRace(head, lg, st, data, now, strength);
      } catch (e) {
        console.error("league race", head.raceId, (e as Error)?.message ?? e);
        return this.retryHead(qq, st);
      }
      this.finishHead(head);
      return { kind: "race" as const, raceId: head.raceId, status: "done" as const };
    });
  }

  private retryHead(q: Queue, state: LeagueState) {
    const head = q.run[0];
    head.tries++;
    if (head.tries >= LEAGUE_RACE_TRIES) {
      this.saveSkipped(head, state);
      this.saveQueue(q);
      this.finishHead(head);
      return { kind: "race" as const, raceId: head.raceId, status: "not_computed" as const };
    }
    this.saveQueue(q);
    return { kind: "race" as const, raceId: head.raceId, status: "retry" as const };
  }

  /** 先頭のレースを外す。その枠が 22 時で、もう残りが無ければ日を締める番 */
  private finishHead(head: QueuedRace) {
    const q = this.queue();
    q.run = q.run.filter((r) => r.raceId !== head.raceId);
    const slotOfDay = ((head.slot % 12) + 12) % 12;
    if (slotOfDay === LAST_SLOT_OF_DAY && !q.run.some((r) => r.slot === head.slot)) q.closeDue = leagueDayAt(head.startsAt);
    this.saveQueue(q);
  }

  private saveSkipped(r: QueuedRace, state: LeagueState) {
    const l = state.leagues.find((x) => x.id === r.leagueId);
    const teams = l ? leagueTeams(l) : r.teams;
    const rec: LeagueRaceRecord = {
      raceId: r.raceId,
      slot: r.slot,
      at: r.startsAt,
      leagueId: r.leagueId,
      league: leagueName({ division: r.division, index: r.leagueIndex }),
      division: r.division,
      trackId: r.trackId,
      laps: r.laps,
      status: "not_computed",
      wetMax: 0,
      teams,
      cars: [],
    };
    this.saveRecord(rec, l?.humans ?? []);
    this.voidBets(r.raceId);
  }

  /** 計算できなかったレースの賭けを返してもらう (アカウントの DO へ、送る箱で) */
  private voidBets(raceId: string) {
    this.pushOutbox({ id: `bets:${raceId}`, tries: 0, kind: "bets", raceId, result: null });
  }

  /** 覚えている人のチームの名前 (賭けのレースの一覧用) */
  teamNameOf(id: string): string | null {
    return this.teamName(id);
  }

  /** 慣れ (今の値、コース → 0..1)。賭けの倍率の見積もり用 (who = "rv:<運転手の id>") */
  famNow(who: string, now = this.now()): Record<string, number> {
    return familiarityNow(this.famMap(who), now);
  }

  private saveRecord(rec: LeagueRaceRecord, humans: readonly string[]) {
    this.sql.exec(
      "INSERT INTO league_races (race_id, slot, at, league_id, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(race_id) DO UPDATE SET body = excluded.body",
      rec.raceId,
      rec.slot,
      rec.at,
      rec.leagueId,
      JSON.stringify(rec),
    );
    for (const t of humans) this.sql.exec("INSERT OR IGNORE INTO league_race_teams (team_id, race_id, at) VALUES (?, ?, ?)", t, rec.raceId, rec.at);
  }

  /** 1 レースを計算して残す (取りまとめの中で呼ぶ) */
  private runRace(head: QueuedRace, league: League, state: LeagueState, data: readonly LeagueTeamData[], now: number, strength: PartStrength | null = null) {
    const byTeam = new Map(data.map((d) => [d.teamId, d]));
    const humans = league.humans.filter((h) => byTeam.has(h));
    for (const d of data) this.setTeamName(d.teamId, d.name);
    const teams = [...new Set(leagueTeams(league))].sort();
    const drivers: TeamDrivers[] = humans.map((h) => ({ teamId: h, ownDriverId: `own:${h}`, hiredDriverId: byTeam.get(h)!.hired?.driverId ?? `cpu:${h}` }));
    // 来なかった人のチーム (アカウントが消えた) はコンピューターの席として扱わない: 走らせない
    const entries = scheduledEntries({ ...head, teams: teams.filter((t) => humans.includes(t) || league.cpus.includes(t)) }, drivers);
    const track = head.trackId;
    const rivals = new Map<string, RivalTeam>();
    const specs: HeadlessCarSpec[] = [];
    const meta = new Map<string, { teamId: string; team: string; driver: string; kind: LeagueCarKind; human: boolean; famWho?: string }>();
    for (const e of entries) {
      if (e.rival) {
        const cpuId = e.teamId;
        const rv = rivals.get(cpuId) ?? this.rival(cpuId, league);
        rivals.set(cpuId, rv);
        const k = e.driverId.endsWith("#1") ? 1 : 0;
        const drv = rv.drivers[k];
        const fam = familiarityNow(this.famMap(`rv:${drv.id}`), now)[track] ?? 0;
        const base = BOT_DESIGNS[hashStr(rv.id) % BOT_DESIGNS.length];
        // 運転手の得意 (タイヤ・燃費・縁石) も車に効く (前に作ったライバルには得意が無い = 今のまま)
        specs.push({ id: e.driverId, design: rivalDesign(rv, base), ...rivalCarScales(rv, k), brain: ({ rand, wetStart }) => applyFamiliarity(rivalBrain(rv, k, rand, wetStart), fam) });
        meta.set(e.driverId, { teamId: cpuId, team: rv.name, driver: drv.name, kind: "rival", human: false, famWho: `rv:${drv.id}` });
        continue;
      }
      const d = byTeam.get(e.teamId)!;
      if (e.standIn) {
        const fam = d.standInFam[track] ?? 0;
        // 代走の車: 遊ぶ人の最後の走る前の準備 (タイヤと燃料) があればそれで
        specs.push({ id: e.driverId, design: d.design, serviceFactor: d.serviceFactor, pref: d.setup ?? null, team: d.teamId, brain: ({ rand }) => applyFamiliarity(makeBrain(rand, STAND_IN_SKILL), fam, true) });
        meta.set(e.driverId, { teamId: d.teamId, team: d.name, driver: d.driver, kind: "standin", human: true });
      } else if (d.hired && e.driverId === d.hired.driverId) {
        const h = d.hired;
        const fam = h.fam[track] ?? 0;
        // 雇った運転手: タイヤと燃料の扱い (driverCarScales) も車に効く
        specs.push({ id: e.driverId, design: d.secondDesign, serviceFactor: d.serviceFactor, team: d.teamId, ...driverCarScales(h.stats, h.specs), brain: ({ rand }) => applyFamiliarity(driverBrain(h.stats, rand, h.specs), fam) });
        meta.set(e.driverId, { teamId: d.teamId, team: d.name, driver: h.name, kind: "hired", human: true });
      } else {
        // 運転手を雇っていないチームの 2 台目: コンピューターの代走 (普通の上手さ、慣れなし)
        specs.push({ id: e.driverId, design: d.secondDesign, serviceFactor: d.serviceFactor, team: d.teamId, brain: ({ rand }) => makeBrain(rand, STAND_IN_SKILL) });
        meta.set(e.driverId, { teamId: d.teamId, team: d.name, driver: "代走 CPU", kind: "cpu", human: true });
      }
    }
    const sim = simulateRace(specs, { trackId: track, laps: head.laps, seed: head.seed, strength });
    const cars: LeagueRaceCar[] = sim.results.map((r) => {
      const m = meta.get(r.id)!;
      return {
        teamId: m.teamId,
        team: m.team,
        driver: m.driver,
        kind: m.kind,
        human: m.human,
        grid: r.grid + 1,
        pos: r.pos,
        points: r.points,
        finished: r.finished,
        retired: r.retired,
        lapsDone: r.lapsDone,
        total: r.total,
        best: r.best,
        fastest: r.fastest,
        pitStops: r.pitStops,
        tire: r.tire,
      };
    });
    // リーグの点
    const raceCars: RaceCar[] = sim.results.map((r) => ({ driverId: r.id, teamId: meta.get(r.id)!.teamId, pos: r.pos, finished: r.finished, fastest: r.fastest, standIn: meta.get(r.id)!.kind !== "hired" && meta.get(r.id)!.human }));
    const next = addLeagueRace(state, league.id, raceCars, head.startsAt);
    this.saveState(next);
    // ライバル: 点と慣れ
    for (const [cpuId, rv0] of rivals) {
      const pts = raceCars.filter((c) => c.teamId === cpuId).reduce((s, c) => s + (sim.results.find((x) => x.id === c.driverId)?.points ?? 0), 0);
      this.saveRival(cpuId, league.id, addRivalPoints([rv0], rv0.id, pts)[0]);
    }
    for (const m of meta.values()) if (m.famWho) this.famRecord(m.famWho, track, now);
    // 遊ぶ人の車の部品の段階 (季節の切れ目にライバルの部品を上げる目安)
    if (data.length) {
      const field = this.kvGet<Record<string, number>>("fieldTier") ?? {};
      field[league.id] = data.reduce((s, d) => s + designTier(d.design), 0) / data.length;
      this.kvPut("fieldTier", field);
    }
    const rec: LeagueRaceRecord = {
      raceId: head.raceId,
      slot: head.slot,
      at: head.startsAt,
      leagueId: league.id,
      league: leagueName(league),
      division: league.division,
      trackId: track,
      laps: head.laps,
      status: "done",
      wetMax: Math.round(sim.wetMax * 100) / 100,
      teams,
      cars,
    };
    this.saveRecord(rec, humans);
    // 賭けの払い (アカウントの DO へ、送る箱で)。車は「チーム/1 台目・2 台目」(代走とライバルの 1 人目が 1 台目)
    const betCars: BetResultCar[] = sim.results.map((r) => {
      const m = meta.get(r.id)!;
      const n = m.kind === "standin" || (m.kind === "rival" && r.id.endsWith("#0")) ? 1 : 2;
      return { key: betCarKey(m.teamId, n), team: m.teamId, pos: r.pos, finished: r.finished };
    });
    this.pushOutbox({ id: `bets:${head.raceId}`, tries: 0, kind: "bets", raceId: head.raceId, result: betCars });
    // アカウントの DO へ: 代走の慣れ・雇った運転手の育ちと慣れ・整備・研究
    const report: TeamRaceReport = { trackId: track, laps: head.laps, cars: sim.results.length, humans: humans.length, teams: [] };
    const accountOf: Record<string, number> = {};
    for (const h of humans) {
      const own = sim.results.find((r) => r.id === `own:${h}`);
      if (!own) continue;
      const hiredId = byTeam.get(h)!.hired?.driverId;
      const two = hiredId ? sim.results.find((r) => r.id === hiredId) : undefined;
      const pick = (r: (typeof sim.results)[number]) => ({
        id: r.id, pos: r.pos, points: r.points, finished: r.finished, retired: r.retired, lapsDone: r.lapsDone, pitStops: r.pitStops, distM: r.distM, wallHits: r.wallHits, partIds: r.partIds,
      });
      report.teams.push({ id: own.id, key: own.id, car1: { ...pick(own), standIn: true }, car2: two && hiredId ? { ...pick(two), driverId: hiredId } : null });
      accountOf[own.id] = Number(h);
    }
    if (report.teams.length) this.pushOutbox({ id: `record:${head.raceId}`, tries: 0, kind: "record", raceId: head.raceId, report, accountOf });
  }

  // ---------------------------------------------------------------- 日の締め

  private async closeDay(now: number) {
    let cfg: AdminConfig | null = null;
    try {
      cfg = await this.port.adminConfig();
    } catch (e) {
      console.error("league admin config", (e as Error)?.message ?? e);
    }
    const config = cfg ?? DEFAULT_ADMIN_CONFIG;
    // ギフトコードの部の動き (締めのあと、次の日のはじめから効く。その日の点・入れ替え・王者は動かす前の部で)
    let moves: LeagueMove[] = [];
    try {
      moves = (await this.port.moves?.()) ?? [];
    } catch (e) {
      console.error("league moves", (e as Error)?.message ?? e);
    }
    /** 次の日の state に部の動きを当て、当てたものを送る箱に入れる (リーグにまだいないチームは次の締めまで待つ) */
    const withMoves = (next: LeagueState): LeagueState => {
      const done: number[] = [];
      for (const m of moves) {
        if (!findLeagueOf(next, m.teamId)) continue;
        next = moveTeamToDivision(next, m.teamId, m.division);
        done.push(m.id);
      }
      if (done.length) this.pushOutbox({ id: `moves:${done.join(",")}`.slice(0, 200), tries: 0, kind: "moves", ids: done });
      return next;
    };
    return this.tx(() => {
      const state = this.state(now);
      const q = this.queue();
      const day = state.day;
      const raced = Object.values(state.tally).some((t) => Object.values(t).some((x) => x.races > 0));
      // 次の日: 積んである一番古いレースの日 (なければ今日)。締めるのは 1 日ずつ
      const target = Math.max(day + 1, Math.min(leagueDayAt(now), ...q.run.map((r) => leagueDayAt(r.startsAt))));
      const dayKey = `league-${day}`;
      if (!raced) {
        // レースの無かった日: 入れ替えも賞金もなし。週をまたいだら週のはんこだけ (季節の係へ)
        const weekEnds = seasonIndexAt(leagueDayStart(target)) !== seasonIndexAt(leagueDayStart(day));
        const stamps = weekEnds ? weekStampMap(Object.entries(state.weekBest).map(([teamId, division]) => ({ teamId, division }))) : {};
        this.saveState(withMoves({ ...state, day: target, tally: {}, weekBest: weekEnds ? {} : state.weekBest }));
        q.closeDue = null;
        this.saveQueue(q);
        if (Object.keys(stamps).length) this.pushOutbox({ id: `ctor:${day}`, tries: 0, kind: "ctor", dayKey, delta: {}, meta: { stamps } });
        return { kind: "close" as const, day };
      }
      const delta = addLeagueDayToConstructors({}, state, config);
      const close = closeLeagueDay(state);
      const awards = close.awards.map((a) => ({ ...a, prize: leaguePrizeFor(config, a.division, a.rank) }));
      const names = (id: string) => this.nameOf(id, state);
      const standings: LeagueDayRecord["standings"] = {};
      for (const [lid, rows] of Object.entries(close.standings)) standings[lid] = rows.map((r) => ({ ...r, name: names(r.id) }));
      // ライバルを育て、部品を上げる: 毎日 1/7 ずつ。週 (= 季節) の切れ目に残りを済ませて季節を締める
      const weekEnds = seasonIndexAt(leagueDayStart(day + 1)) !== seasonIndexAt(leagueDayStart(day));
      this.advanceRivals(seasonIndexAt(leagueDayStart(day)), weekEnds);
      const rec: LeagueDayRecord = {
        day,
        closedAt: now,
        standings,
        awards,
        swaps: close.swaps,
        champion: close.champion,
        championName: close.champion ? names(close.champion) : null,
        weekStamps: close.weekStamps,
      };
      this.sql.exec("INSERT INTO league_days (day, body) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET body = excluded.body", day, JSON.stringify(rec));
      this.saveState(withMoves({ ...close.next, day: Math.max(close.next.day, target) }));
      q.closeDue = null;
      this.saveQueue(q);
      // 古い記録を消す
      const keep = now - LEAGUE_KEEP_DAYS * DAY_MS;
      this.sql.exec("DELETE FROM league_races WHERE at < ?", keep);
      this.sql.exec("DELETE FROM league_race_teams WHERE at < ?", keep);
      this.sql.exec("DELETE FROM league_days WHERE day < ?", day - LEAGUE_KEEP_DAYS);
      // 賞金 (アカウントの DO が払う。同じ id は 1 回だけ)
      const items = awards
        .filter((a) => a.prize > 0)
        .map((a) => ({ accountId: Number(a.teamId), amount: a.prize, reason: `リーグ戦 ${leagueName({ division: a.division, index: Number(a.leagueId.split("-")[1] ?? 0) })} ${a.rank} 位` }));
      if (items.length) this.pushOutbox({ id: `pay:${day}`, tries: 0, kind: "pay", payId: dayKey, items });
      // コンストラクターの分・その日の部・王者・週のはんこ (季節の係へ)
      const divisions: Record<string, number> = {};
      for (const l of state.leagues) for (const h of l.humans) divisions[h] = l.division;
      this.pushOutbox({ id: `ctor:${day}`, tries: 0, kind: "ctor", dayKey, delta, meta: { divisions, champion: close.champion, stamps: weekStampMap(close.weekStamps) } });
      return { kind: "close" as const, day };
    });
  }

  private advanceRivals(season: number, weekEnds: boolean) {
    const field = this.kvGet<Record<string, number>>("fieldTier") ?? {};
    const byLeague = new Map<string, Array<{ id: string; rv: RivalTeam }>>();
    for (const r of this.rows("SELECT id, league_id, body FROM league_rivals")) {
      const lid = String(r.league_id);
      const list = byLeague.get(lid) ?? [];
      list.push({ id: String(r.id), rv: JSON.parse(String(r.body)) as RivalTeam });
      byLeague.set(lid, list);
    }
    for (const [lid, list] of byLeague) {
      const input = { season, fieldTier: field[lid] ?? 1 };
      const next = weekEnds ? advanceRivalSeason(list.map((x) => x.rv), input) : advanceRivalDay(list.map((x) => x.rv), input);
      list.forEach((x, i) => this.saveRival(x.id, lid, next[i]));
    }
  }

  // ---------------------------------------------------------------- 送る箱

  /** 送る箱の中身 (試験と見張り用) */
  outboxSize(): number {
    return this.outbox().length;
  }

  /** アカウントの DO への用を送る (届いたものは消す。届かなければ数を数えて次に送り直す) */
  async flushOutbox(): Promise<void> {
    const items = this.outbox();
    if (!items.length) return;
    const done = new Set<string>();
    const tried = new Map<string, number>();
    for (const it of items) {
      try {
        if (it.kind === "record") await this.port.recordRace(it.raceId, it.report, it.accountOf);
        else if (it.kind === "pay") await this.port.payPrizes(it.payId, it.items);
        else if (it.kind === "moves") await this.port.ackMoves?.(it.ids);
        else if (it.kind === "bets") await this.port.settleBets?.(it.raceId, it.result);
        else await this.port.constructorsDay(it.dayKey, it.delta, it.meta);
        done.add(it.id);
      } catch (e) {
        console.error("league outbox", it.id, (e as Error)?.message ?? e);
        tried.set(it.id, it.tries + 1);
      }
    }
    this.tx(() => {
      const keep = this.outbox()
        .filter((x) => !done.has(x.id))
        .map((x) => (tried.has(x.id) ? { ...x, tries: tried.get(x.id)! } : x))
        .filter((x) => {
          if (x.tries < LEAGUE_OUTBOX_TRIES) return true;
          console.error("league outbox: あきらめた", x.id);
          return false;
        });
      this.kvPut("outbox", keep);
    });
  }

  // ---------------------------------------------------------------- 見せるもの

  /** 自分のリーグ (部・肩書き・王者・4 チームの今日の点と順位・前の日の結果) */
  myLeague(teamId: string, now = this.now()) {
    const state = this.state(now);
    const league = findLeagueOf(state, teamId);
    const next = this.nextRace(now);
    const champion = state.champion;
    const base = {
      now,
      day: state.day,
      dayStart: leagueDayStart(state.day),
      next,
      pending: this.pending(),
      champion: champion ? { teamId: champion, name: this.nameOf(champion, state), mine: champion === teamId } : null,
    };
    if (!league) return { ...base, league: null };
    const rows = leagueStandings(state, league.id).map((r) => ({
      rank: r.rank,
      name: this.nameOf(r.id, state),
      mine: r.id === teamId,
      human: r.human,
      title: r.human ? (state.champion === r.id ? CHAMPION_TITLE : divisionTitle(league.division)) : null,
      personality: r.human ? null : this.rival(r.id, league).personality,
      points: r.points,
      wins: r.wins,
      races: r.races,
    }));
    return {
      ...base,
      league: {
        id: league.id,
        name: leagueName(league),
        division: league.division,
        title: state.champion === teamId ? CHAMPION_TITLE : divisionTitle(league.division),
        divisionTitle: divisionTitle(league.division),
        isChampion: state.champion === teamId,
        rows,
      },
      lastDay: this.lastDayFor(teamId),
    };
  }

  /** 前に締めた日の自分の結果 (順位・賞金・上がった/下がった・王者) */
  private lastDayFor(teamId: string) {
    const r = this.row("SELECT body FROM league_days ORDER BY day DESC LIMIT 1");
    if (!r) return null;
    const d = JSON.parse(String(r.body)) as LeagueDayRecord;
    let rank: number | null = null;
    let leagueId: string | null = null;
    for (const [lid, rows] of Object.entries(d.standings)) {
      const me = rows.find((x) => x.id === teamId);
      if (me) {
        rank = me.rank;
        leagueId = lid;
      }
    }
    if (leagueId === null) return null;
    const prize = d.awards.find((a) => a.teamId === teamId)?.prize ?? 0;
    const moved = d.swaps.some((s) => s.up.teamId === teamId) ? "up" : d.swaps.some((s) => s.down.teamId === teamId) ? "down" : null;
    return { day: d.day, rank, prize, moved, champion: d.champion === teamId };
  }

  /** 自分のチームの出たレース (新しい順) */
  myResults(teamId: string, limit = 12): LeagueRaceRecord[] {
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 12));
    return this.rows(
      "SELECT r.body FROM league_race_teams t JOIN league_races r ON r.race_id = t.race_id WHERE t.team_id = ? ORDER BY t.at DESC, r.race_id DESC LIMIT ?",
      teamId,
      n,
    ).map((x) => JSON.parse(String(x.body)) as LeagueRaceRecord);
  }

  /** 8 つの部の段 (肩書き・リーグの数・人の数・自分の部) と王者 */
  ladder(teamId: string | null, now = this.now()) {
    const state = this.state(now);
    const mine = teamId ? findLeagueOf(state, teamId)?.division ?? null : null;
    const divisions = Array.from({ length: DIVISION_COUNT }, (_, i) => {
      const d = i + 1;
      const ls = state.leagues.filter((l) => l.division === d);
      return { division: d, title: divisionTitle(d), leagues: ls.length, humans: ls.reduce((s, l) => s + l.humans.length, 0), mine: mine === d };
    });
    const champion = state.champion ? { name: this.nameOf(state.champion, state), mine: state.champion === teamId } : null;
    return { day: state.day, divisions, champion, active: activeLeagues(state).length };
  }

  /** 次のレースの時刻とコース */
  nextRace(now = this.now()) {
    const at = nextScheduledAt(now);
    const trackId = scheduledTrackId(at);
    return { at, trackId, trackName: TRACK_DEFS.find((d) => d.id === trackId)?.name ?? trackId, laps: SCHEDULED_LAPS };
  }

  /** チームの肩書き (王者 > 部の肩書き)。リーグにいなければ入れない */
  titles(teamIds: readonly string[], now = this.now()): Record<string, string> {
    const state = this.state(now);
    const out: Record<string, string> = {};
    for (const id of teamIds) {
      if (state.champion === id) out[id] = CHAMPION_TITLE;
      else {
        const l = findLeagueOf(state, id);
        if (l) out[id] = divisionTitle(l.division);
      }
    }
    return out;
  }

  /** 開発用: 全部消す */
  devReset() {
    this.tx(() => {
      for (const t of ["league_kv", "league_teams", "league_rivals", "league_fam", "league_races", "league_race_teams", "league_days"]) this.sql.exec(`DELETE FROM ${t}`);
    });
  }
}

// ---------------------------------------------------------------- /api/league/...

const MAX_BODY = 4 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

export interface LeagueApiOpts {
  /** 開発用の受け口 (枠を今すぐ積む・消す) を開ける。server/.dev.vars の BPR_DEV=1 のときだけ */
  dev?: boolean;
  /** 開発用に枠を積んだあと (DO は alarm を置く) */
  onDevSlot?: () => Promise<void>;
}

/**
 * GET  /api/league           自分のリーグ (部・肩書き・王者・4 チームの今日の点・前の日の結果・次のレース)。はじめて開くと 8 部に入る
 * GET  /api/league/results   自分のチームの出たレース (?limit=12)
 * GET  /api/league/ladder    8 つの部の段と王者
 * GET  /api/league/next      次のレースの時刻 (ログインなしでよい)
 * POST /api/league/dev/slot  開発用: 次の枠を今すぐ積んで計算する (BPR_DEV=1 のときだけ)
 * POST /api/league/dev/reset 開発用: リーグを全部消す (BPR_DEV=1 のときだけ)
 */
export async function handleLeagueApi(req: Request, store: LeagueStore, port: LeagueAccountsPort, opts: LeagueApiOpts = {}): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const M = req.method;
    if (path === "/api/league/next" && M === "GET") return json(store.nextRace());
    if (path.startsWith("/api/league/dev/")) {
      if (!opts.dev) return json({ error: "ありません" }, 404);
      if (path === "/api/league/dev/slot" && M === "POST") {
        const slot = await store.poke(store.now(), { dev: true });
        await opts.onDevSlot?.();
        return json({ slot, startsAt: slot === null ? null : scheduledSlotStart(slot), pending: store.pending() });
      }
      if (path === "/api/league/dev/reset" && M === "POST") {
        store.devReset();
        return json({ ok: true });
      }
      return json({ error: "ありません" }, 404);
    }
    if ((await req.text()).length > MAX_BODY) return json({ error: "送るものが大きすぎます" }, 413);
    const me = await port.auth(bearer(req));
    if (!me) return json({ error: "ログインしてください" }, 401);
    if (path === "/api/league" && M === "GET") {
      store.ensureMember(me);
      const v = store.myLeague(me.teamId);
      // ほかのチームの id (アカウントの番号) は返さない
      return json({ ...v, champion: v.champion ? { name: v.champion.name, mine: v.champion.mine } : null });
    }
    if (path === "/api/league/results" && M === "GET") {
      const results = store.myResults(me.teamId, Number(url.searchParams.get("limit") ?? 12)).map(({ teams: _t, cars, ...r }) => ({
        ...r,
        cars: cars.map(({ teamId, ...c }) => ({ ...c, mine: teamId === me.teamId })),
      }));
      return json({ results });
    }
    if (path === "/api/league/ladder" && M === "GET") return json(store.ladder(me.teamId));
    return json({ error: "ありません" }, 404);
  } catch (e) {
    console.error("league api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}
