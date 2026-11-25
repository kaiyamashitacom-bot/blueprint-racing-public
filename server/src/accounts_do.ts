// アカウントの Durable Object (全員で 1 つ、SQLite に保存)。
// 画面からは /api/... を fetch で、部屋の DO からは RPC (raceEntry・payPrizes・recordTeamRace) で使う。RPC は外から呼べない
// 研究の終わり・市場の締め切り・季節の切れ目は、呼ばれたときに進めるほか alarm でも進める (知らせを出すため)
import { DurableObject } from "cloudflare:workers";
import type { AdminConfig, CarDesign, ClassId, TrackDef, ConstructorLeagueAcc, FixedCarResult, FixedField, JoinTeam, TeamRaceReport } from "@bpr/shared";
import { AccountStore, type SqlRunner } from "./accounts.ts";
import { handleApi } from "./api.ts";
import { TaStore } from "./timeattack.ts";
import { TEAM_PATH, TeamStore } from "./team.ts";
import { SEASON_PATH, SeasonStore, type LeagueDayMeta, type RaceFeed, type RaceFeedPaid } from "./season.ts";
import { leagueAuth, leagueRoster, leagueTeamData, type LeagueMember, type LeagueTeamData } from "./league_accounts.ts";
import { TrackStore, pubNumber } from "./tracks.ts";
import { ROOMS_PATH, RoomRegistry, handleRoomsApi, type CustomRoomStatus } from "./rooms.ts";
import { PLAYERS_ADMIN_PATH, handlePlayersAdminApi } from "./admin_players.ts";
import { GIFT_PATH, GiftStore, handleGiftApi } from "./gift.ts";
import { BETS_ADMIN_PATH, BetStore, handleBetsAdminApi, type PlaceBetInput } from "./bets.ts";
import { TOUR_BETS_PATH, handleTourBetsApi, reconcileTourBets, settleTourBets } from "./bets_tour.ts";
import { RP_PATH, RacePointStore, earnTaLap, handleRacePointsApi } from "./racepoints.ts";
import { ApiError } from "./accounts.ts";
import { TRACK_DEFS, type CustomRoomConfig } from "@bpr/shared";

export interface AccountsEnv {
  /** 管理者のログイン ID (カンマ区切り)。作るときは server/.dev.vars に BPR_ADMIN_IDS=... と書く (git に入れない) */
  BPR_ADMIN_IDS?: string;
  /** "1" のときだけ、管理者が時計をずらせる (季節の締めや大会を試すため。作るときの server/.dev.vars だけに書く) */
  BPR_DEV_CLOCK?: string;
  /** リーグ戦の開発用の印 (league_do.ts)。"1" なら時計ずらしも使える */
  BPR_DEV?: string;
  /** 大会の組の部屋 (worker.ts の RaceRoomDO) */
  ROOM?: DurableObjectNamespace;
}

/** 大会の組の部屋の RPC (worker.ts の RaceRoomDO.setupTournament) と、開いた部屋の RPC (setupCustom) */
interface TourRoomStub {
  setupTournament(field: FixedField): Promise<boolean>;
  setupCustom(cfg: CustomRoomConfig): Promise<boolean>;
}

/** alarm は早くてもこれだけ先 (仮。続けて起きすぎないように) */
const ALARM_MIN_GAP_MS = 2000;

export class AccountsDO extends DurableObject<AccountsEnv> {
  private store: AccountStore;
  /** 1 周アタック (同じ SQLite に表を足す) */
  private ta: TaStore;
  /** チーム・運転手・研究・市場・知らせ (同じ SQLite に表を足す) */
  private team: TeamStore;
  /** 季節・級・大会・管理者の数 (同じ SQLite に表を足す) */
  private season: SeasonStore;
  /** みんなのコース (同じ SQLite に表を足す) */
  private tracks: TrackStore;
  /** 開いた部屋の一覧 (rooms.ts。同じ SQLite に表を足す) */
  private rooms: RoomRegistry;
  /** ギフトコード (gift.ts。同じ SQLite に表を足す) */
  private gifts: GiftStore;
  /** 賭け (bets.ts。同じ SQLite に表を足す。ゲームの中のお金だけ。時計はリーグの DO と同じ本当の時刻) */
  private bets: BetStore;
  /** 走行点と交換所 (racepoints.ts。同じ SQLite に表を足す) */
  private rp: RacePointStore;
  /** 作るときだけ: 季節と大会の時計をずらす ms (本番は 0) */
  private devOffset = 0;
  /** 置いた alarm の時刻 (undefined = わからない) */
  private alarmAt: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: AccountsEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql as unknown as SqlRunner;
    const tx = <T,>(fn: () => T): T => ctx.storage.transactionSync(fn);
    this.store = new AccountStore({
      sql,
      tx,
      adminIds: String(env.BPR_ADMIN_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      // 招かれた人だけ登録できるか (管理者の数)
      inviteOnly: () => this.season.config().inviteOnly,
    });
    // マニュアルの速さの上がり分 (管理者の数) で、マニュアルの周の速さの上限をゆるめる
    // 1 周アタックの走行点 (racepoints.ts。確かめの通った周ごと / 記録更新。1 日の上限あり)
    this.ta = new TaStore({ sql, tx, mtBonus: () => this.season.config().manualSpeedBonus, earn: (id, improved, at) => earnTaLap(sql, this.season.config(), id, improved, at) });
    // 季節の切れ目 (運転手の契約) も同じ時計で進むよう、チームにも同じ時計を渡す
    const now = () => Date.now() + this.devOffset;
    this.team = new TeamStore({ sql, tx, now }, this.store);
    this.season = new SeasonStore(
      { sql, tx, now, teamInfo: (acc, design) => this.team.raceTeam(acc, design), onDriverChampions: (season, ids) => void this.team.championBonus(season, ids), onConstructorChampion: (season, teamId) => void this.team.rarePrize(season, teamId), classMoves: () => this.gifts.takeClassMoves(),
        // 大会の景品 (結果と同じ取りまとめで)・全員参加の大会の車・毎日の自動の大会
        grantPrizes: (acc, items, at) => this.gifts.grantInTx(acc, items, at),
        teamData: (acc) => leagueTeamData(this.store, this.team, String(acc)),
        autoTournaments: true,
        // 大会の優勝の賭けを払う・返す (bets_tour.ts)
        onTournamentClosed: (id) => void settleTourBets(this.season, this.bets, id),
      },
      this.store,
    );
    this.tracks = new TrackStore({ sql, tx }, this.store);
    this.rooms = new RoomRegistry({ sql, tx });
    this.gifts = new GiftStore({ sql, tx, now, caps: () => this.season.config() }, this.store, this.team, this.season);
    this.bets = new BetStore({ sql, tx, config: () => this.season.config() }, this.store);
    this.rp = new RacePointStore({ sql, tx, now, config: () => this.season.config() }, this.store, this.gifts);
    if (env.BPR_DEV_CLOCK === "1" || env.BPR_DEV === "1") {
      const r = sql.exec("SELECT body FROM season_kv WHERE k = 'dev_offset'").toArray()[0];
      this.devOffset = r ? Number(JSON.parse(String(r.body))) || 0 : 0;
    }
  }

  /** 季節の締め・大会の知らせ・組の部屋を開く・締め切り (alarm と管理者の操作のあと) */
  private async seasonTick() {
    // 1 周アタックの週の 1 位の景品 (締め切った週。同じ週は 1 回だけ)
    try {
      this.ta.awardDue(Date.now() + this.devOffset);
    } catch (e) {
      console.error("ta award", (e as Error)?.message ?? e);
    }
    let r: ReturnType<SeasonStore["tick"]> | null = null;
    try {
      r = this.season.tick();
    } catch (e) {
      console.error("season tick", (e as Error)?.message ?? e);
      return null;
    }
    // 大会の優勝の賭け: 決まった・取りやめた大会の分を払う・返す (取りこぼし用)
    try {
      reconcileTourBets(this.season, this.bets);
    } catch (e) {
      console.error("tour bets", (e as Error)?.message ?? e);
    }
    for (const field of r.launch) {
      try {
        const ns = this.env.ROOM;
        if (!ns) break;
        const stub = ns.get(ns.idFromName(`tour-${field.tag.replace(":", "-")}`)) as unknown as TourRoomStub;
        // 部屋は本当の時計で動く (作るときに時計をずらしていたら戻して渡す)
        if (await stub.setupTournament({ ...field, startAt: field.startAt - this.devOffset })) this.season.markPushed(field.tag);
      } catch (e) {
        console.error("tour room", (e as Error)?.message ?? e);
      }
    }
    return { closed: r.closed, launched: r.launch.map((f) => f.tag), finalized: r.finalized };
  }

  async fetch(req: Request): Promise<Response> {
    const devClock =
      this.env.BPR_DEV_CLOCK === "1" || this.env.BPR_DEV === "1"
        ? {
            get: () => this.devOffset,
            set: (off: number) => {
              this.devOffset = off;
              this.ctx.storage.sql.exec("INSERT INTO season_kv (k, body) VALUES ('dev_offset', ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body", JSON.stringify(off));
            },
          }
        : undefined;
    // 開いた部屋 (rooms.ts) と 遊ぶ人の管理 (admin_players.ts: 止める・招く)
    const p0 = new URL(req.url).pathname.replace(/\/+$/, "");
    if (ROOMS_PATH.test(p0)) return handleRoomsApi(req, p0, req.method, this.roomsDeps());
    if (PLAYERS_ADMIN_PATH.test(p0)) return handlePlayersAdminApi(req, p0, req.method, this.store);
    if (GIFT_PATH.test(p0)) return handleGiftApi(req, p0, req.method, this.store, this.gifts);
    if (RP_PATH.test(p0)) return handleRacePointsApi(req, p0, req.method, this.store, this.rp);
    // 賭けの量と一時停止 (管理者だけ。一時停止は管理者の数 betPaused を変えるので、変更の記録にも残る)
    if (TOUR_BETS_PATH.test(p0)) return handleTourBetsApi(req, p0, req.method, this.store, this.season, this.bets);
    if (BETS_ADMIN_PATH.test(p0)) return handleBetsAdminApi(req, p0, req.method, this.store, this.bets, (paused, by) => void this.season.setConfig({ betPaused: paused }, by));
    const res = await handleApi(req, this.store, this.ta, this.team, this.season, { devClock, tick: () => this.seasonTick() }, this.tracks, this.rooms);
    // チーム・季節・大会の動きのあと (と、起きて最初の 1 回) に、次に進めることのある時刻へ alarm を置き直す
    const path = new URL(req.url).pathname;
    if (((TEAM_PATH.test(path) || SEASON_PATH.test(path)) && req.method !== "GET") || this.alarmAt === undefined) await this.scheduleAlarm();
    return res;
  }

  async alarm() {
    this.alarmAt = undefined;
    // 季節の締め (賞金) を先に、そのあとチーム (運転手の契約の更新) を進める
    await this.seasonTick();
    try {
      this.team.tickAll();
    } catch (e) {
      console.error("team alarm", (e as Error)?.message ?? e);
    }
    await this.scheduleAlarm();
  }

  /** 次に進めることがある時刻に alarm を置く */
  private async scheduleAlarm() {
    let next: number | null = null;
    try {
      next = this.team.nextWake();
    } catch (e) {
      console.error("team wake", (e as Error)?.message ?? e);
    }
    try {
      // 季節の時計はずらしてあることがある (作るときだけ)。alarm は本当の時刻で置く
      const s = this.season.nextWake();
      if (s !== null) next = next === null ? s : Math.min(next, s);
      if (next !== null) next -= this.devOffset;
    } catch (e) {
      console.error("season wake", (e as Error)?.message ?? e);
    }
    const at = next === null ? null : Math.max(next, Date.now() + ALARM_MIN_GAP_MS);
    if (at === this.alarmAt) return;
    this.alarmAt = at;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  /** 開いた部屋の受け口に渡すもの */
  private roomsDeps() {
    const official = () => TRACK_DEFS.map((d) => ({ id: d.id, name: d.name }));
    return {
      accounts: this.store,
      rooms: this.rooms,
      classOf: (acc: number) => this.season.playClass(acc),
      // 公式のコース + 公開中のみんなのコース
      tracks: () => {
        try {
          return [...official(), ...this.tracks.listPublic(null).map((t) => ({ id: t.id, name: t.name }))];
        } catch (e) {
          console.error("rooms tracks", (e as Error)?.message ?? e);
          return official();
        }
      },
      trackDef: (id: string) => TRACK_DEFS.find((d) => d.id === id) ?? this.tracks.publicDef(id),
      launch: async (cfg: CustomRoomConfig) => {
        const ns = this.env.ROOM;
        if (!ns) return false;
        const stub = ns.get(ns.idFromName(`custom-${cfg.id}`)) as unknown as TourRoomStub;
        return stub.setupCustom(cfg);
      },
    };
  }

  /** 開いた部屋 (RaceRoomDO) から: 段階や人の数が変わった。一覧になければ false (閉じたか、消えた) */
  async updateCustomRoom(id: string, status: CustomRoomStatus): Promise<boolean> {
    return this.rooms.update(String(id).slice(0, 40), status);
  }

  /** ネットのレースに入るとき。ログインしていれば チーム (2 台目・整備・代走の慣れ) も返す */
  async raceEntry(token: string | undefined, design: CarDesign): Promise<{ account: { id: number; driver: string } | null; error?: string; team?: JoinTeam; cls?: ClassId }> {
    const r = await this.store.raceEntry(token, design);
    if (!r.account || r.error) return r;
    const cls = this.season.playClass(r.account.id);
    try {
      return { ...r, cls, team: this.team.raceTeam(r.account.id, design) };
    } catch (e) {
      console.error("race team", (e as Error)?.message ?? e);
      return { ...r, cls };
    }
  }

  async payPrizes(raceId: string, items: Array<{ accountId: number; amount: number; reason: string }>) {
    return this.store.payPrizes(raceId, items);
  }

  /** レースのあと: 2 台目の賞金を払い、整備・研究・運転手の育ち・慣れを残す。払ったあとの財布 (アカウント → お金) を返す */
  async recordTeamRace(raceId: string, report: TeamRaceReport, accountOf: Record<string, number>, prizes: Array<{ accountId: number; amount: number; reason: string }>) {
    this.team.recordRace(raceId, report, accountOf);
    const wallets = prizes.length ? this.store.payPrizes(`${raceId}:team`, prizes) : {};
    await this.scheduleAlarm();
    return wallets;
  }

  // ---- 季節と大会 (season.ts。部屋の DO とリーグ戦の DO から RPC で)

  /** 終わった普段のレースを季節に足し、賞金 (管理者の数) を払う。同じ raceId は 1 回だけ。アカウント → 払った額と財布 */
  async recordRace(feed: RaceFeed): Promise<Record<number, RaceFeedPaid>> {
    const r = this.season.recordRace({ ...feed, at: feed.at + this.devOffset });
    return r.paid;
  }

  /** 大会の組の結果 (部屋の DO から)。全部の組がそろったら大会を決める */
  async recordTournamentGroup(tag: string, rows: FixedCarResult[], endedAt: number): Promise<boolean> {
    const done = this.season.recordTournamentGroup(tag, rows, endedAt + this.devOffset);
    await this.scheduleAlarm();
    return done;
  }

  /**
   * リーグ戦の係 (LeagueDO) が日の締めに呼ぶ: その日のコンストラクターの分を季節に足す。同じ dayKey は 1 回だけ (false = もう入っている)。
   * delta = addLeagueDayToConstructors({}, その日の LeagueState, await adminConfig()) (その日の分だけ、人のチームの id → 点)。
   * meta (なくてよい) = { divisions: チーム → 部, champion: 王者のチーム, stamps: チーム → はんこ } (季節の記録とはんこ帳に入る)
   */
  async addConstructorLeagueDay(dayKey: string, delta: ConstructorLeagueAcc, meta?: LeagueDayMeta): Promise<boolean> {
    return this.season.addLeagueDay(String(dayKey).slice(0, 64), delta ?? {}, meta ?? {});
  }

  /** 管理者が変えられる数 (リーグ戦の賞金の倍率・コンストラクターの重みなど) */
  async adminConfig(): Promise<AdminConfig> {
    return this.season.config();
  }

  // ---- みんなのコース (tracks.ts。部屋の DO から RPC で)

  /** 公開中のコース ("pub:<n>") の形。なければ null。部屋は tracks.ts の resolveTrackDef から呼ぶ */
  async publicTrackDef(id: string): Promise<TrackDef | null> {
    return this.tracks.publicDef(String(id));
  }

  /** 部屋のレースがみんなのコースで終わったとき: 人の車ごとに走った回数と走り終えたか (いいねを押せる) と一番速い周を残す */
  async recordTrackRaceRuns(trackId: string, runs: Array<{ accountId: number; driver: string; finished: boolean; bestLap?: number }>): Promise<void> {
    const n = pubNumber(trackId);
    if (n === null) return;
    for (const r of runs.slice(0, 8)) {
      try {
        this.tracks.recordRun(r.accountId, String(r.driver ?? ""), n, !!r.finished, r.bestLap);
      } catch (e) {
        console.error("track run", (e as Error)?.message ?? e);
      }
    }
  }

  // ---- リーグ戦 (league_do.ts の LeagueDO から RPC で。中身は league_accounts.ts)

  /** 全部のチーム (リーグに自動で入れる) */
  async leagueRoster(): Promise<LeagueMember[]> {
    return leagueRoster(this.ctx.storage.sql as unknown as SqlRunner);
  }

  async leagueAuth(token: string | null): Promise<LeagueMember | null> {
    return leagueAuth(this.store, token);
  }

  /** 2 時間ごとのレースに出す 2 台の様子 (無くなったアカウントは入れない) */
  /** ギフトコードの部の動き (日の締めのあとに当てる。gift.ts) */
  async leagueMoves(): Promise<Array<{ id: number; teamId: string; division: number }>> {
    return this.gifts.leagueMoves();
  }

  /** 当てた部の動きを消す */
  async ackLeagueMoves(ids: number[]): Promise<void> {
    this.gifts.ackLeagueMoves(Array.isArray(ids) ? ids : []);
  }

  // ---- 賭け (bets.ts。リーグの DO の bets_league.ts から RPC で。お金を動かすのはここだけ)

  /** 賭ける (倍率はリーグの DO が出したもの。締め切り・自分のレース・上限・お金はここでもう一度確かめる) */
  async placeBet(input: PlaceBetInput): Promise<{ ok: true; bet: unknown; money: number } | { ok: false; status: number; error: string }> {
    try {
      const r = this.bets.place(input);
      return { ok: true, bet: r.bet, money: r.money };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message };
      throw e;
    }
  }

  /** レースの結果で賭けを払う (null = 計算できなかった → 返す)。同じレースは 1 回だけ */
  async settleBets(raceId: string, result: Parameters<BetStore["settle"]>[1]): Promise<void> {
    this.bets.settle(String(raceId).slice(0, 80), result);
    this.bets.sweep();
  }

  /** 自分の賭け */
  async myBets(accountId: number) {
    return this.bets.mine(Number(accountId));
  }

  async leagueTeams(teamIds: string[]): Promise<LeagueTeamData[]> {
    const out: LeagueTeamData[] = [];
    for (const id of teamIds.slice(0, 8)) {
      const d = leagueTeamData(this.store, this.team, id);
      if (d) out.push(d);
    }
    return out;
  }
}
