// レースの部屋: 待合 → スタート (信号) → レース → 結果 → 待合 … をくり返す。
// サーバー (Durable Object) が中に持つ。Cloudflare に頼らないので試験でそのまま動かせる。
// 人の車は人の画面が計算して位置を送ってくる (すり抜けるのでぶつかりの計算は要らない)。
// コンピューターの車と、通信が切れた人の車はここで計算する。
// 旗・VSC・SC (racecontrol.ts) もここで動かし、snap の flag で画面に知らせる。コンピューターは旗に従い、DRS と風よけも使う。
import { botInput, botStartSetup, makeBrain, updateBotPit, type BotBrain } from "./bot.ts";
import { bodyOf, pushApart, type Body } from "./collide.ts";
import { damageCount, packDamage, readDamage } from "./damage.ts";
import { drsAvailable, newDrsState, openDrs, towFactor, updateDrs } from "./drs.ts";
import { newOvertakeState, updateOvertake } from "./overtake.ts";
import { computeStats, validateDesign, type CarDesign, type CarStats } from "./design.ts";
import { createCar, DT, type CarState } from "./physics.ts";
import { stepCar } from "./physics.ts";
import { BOT_DESIGNS, BOT_NAMES } from "./presets.ts";
import { CAR_COLORS, SNAP_OT, type ClientMsg, type PhaseInfo, type ResultRow, type RosterEntry, type ServerMsg, type SnapCar } from "./protocol.ts";
import { JUMP_START_PENALTY, newLapState, pickFastest, pointsFor, sortStandings, updateLaps, type LapState } from "./race.ts";
import {
  flagInfo, flagSpeedCap, newRaceControl, overtakeAllowed, scFollowInput, scOrder, scTarget, stepRaceControl, VSC_SPEED,
  type FollowTarget, type RaceControl, type RcCar, type RcEvent,
} from "./racecontrol.ts";
import { isTireCompound, TIRE_DEFS, type TireCompound } from "./tires.ts";
import { inService, requestPit } from "./pit.ts";
import { isStopped, newStint, tyreLaps, updateStint, type StintState } from "./timing.ts";
import { allocRules, forecastWetMax, readTireSets, setOptions, type TireSets } from "./tireset.ts";
import { queryTrack, type TrackDef } from "./track.ts";
import { getTrack, registerTrackDef, TRACK_DEFS } from "./tracks.ts";
import { forecastAt, lineWetnessAt, makeWeatherPlan, skyAt, wetnessAt, type WeatherPlan } from "./weather.ts";
import { raceReport, type RaceReport } from "./money.ts";
import { driverBrain, driverCarScales, type DriverStats, type SpecialtyId } from "./drivers.ts";
import { applyFamiliarity } from "./familiarity.ts";
import { STAND_IN_SKILL } from "./season.ts";
import { applyTeamOrder, isTeamOrder, TEAM_ORDER, TEAM_ORDER_TEXT, teamOrderBase, yieldDone, yieldSpeedCap, type TeamOrder, type TeamOrderBase } from "./teamorder.ts";
import { advanceStint, startStint, type Stint } from "./tournament.ts";

export const LOBBY_MS = 12_000;
/** 待合の終わり近くに入った人にも、タイヤと燃料を決める時間をこれだけ残す (待合を伸ばす。仮) */
export const LATE_JOIN_MS = 10_000;
/** 遅れて入った人のために待合を伸ばすのは、はじめの終わりの時刻からこれまで (仮) */
export const LATE_JOIN_CAP_MS = 20_000;
export const RESULTS_MS = 25_000;
/** 先頭がゴールしてから残りを待つ時間 */
export const CHEQUERED_MS = 60_000;
export const MAX_CARS = 8;
/** レース中に人が全員切れても、つなぎ直しを待つ時間 */
export const REJOIN_GRACE_MS = 60_000;
/** コンピューターが天気を見る先の秒 (ピットに入るころの濡れ具合でタイヤを選ぶ、仮) */
const BOT_WEATHER_LOOK = 40;
/** 開いた部屋の待合の長さ (仮)。開いた人は 人が CUSTOM_START_MIN 人以上なら早めに始められる */
export const CUSTOM_LOBBY_MS = 90_000;
export const CUSTOM_START_MIN = 2;

/** 開いた部屋 (11/25 決まり「開く人がコース・周回数・級を決める。合言葉はなし」)。コースはいつも同じ */
export interface CustomRoomConfig {
  /** 部屋の id (一覧と /ws?room= に使う) */
  id: string;
  trackId: string;
  laps: number;
  /** 級 (開いた人の級。ちがう級の人は入れない) */
  cls: number;
  /** 開いた人のアカウントの番号と運転手名 (早めに始められるのはこの人だけ) */
  hostAccount: number;
  hostName: string;
  /** 公式でないコース (みんなのコース "pub:<n>") の形。部屋が getTrack で引けるように入れる */
  trackDef?: TrackDef;
  /** 一度人が入って、みんな抜けた (もう開かない) */
  closed?: boolean;
}

export interface RoomIO {
  send(id: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  /** 結果が決まったとき (人の車ごとの順位と点)。サーバーが賞金を払うのに使う (なくてもよい) */
  onResults?(report: RaceReport): void;
  /** 結果が決まったとき、チーム (ログインした人) ごとの 2 台の様子。運転手の育ち・整備の慣れ・研究・慣れに使う (なくてもよい) */
  onTeamResults?(report: TeamRaceReport): void;
  /** 顔ぶれの決まった部屋 (大会の組) の結果。onResults・onTeamResults の代わりに呼ぶ */
  onFixedResults?(tag: string, rows: FixedCarResult[], endedAt: number): void;
}

/**
 * 顔ぶれと並びが決まった部屋 (大会の組) の 1 台。人の車は来なければ代走 (走る前の予定のまま)、雇った運転手はいつもコンピューター
 */
export interface FixedCar {
  /** つなぎ直しの印 (人 = "acc:<アカウントの番号>"、雇った運転手 = "hire:<運転手の id>") */
  key: string;
  name: string;
  design: CarDesign;
  /** 並び (0 = 先頭) */
  slot: number;
  kind: "human" | "hired";
  teamId: string;
  driverId: string;
  /** 走る前の予定 (人の車: 予選の組から)。なし = コンピューターが決める */
  setup?: { tire: TireCompound; wear: number; sets: TireSets | null; fuel: number };
  /** 雇った運転手の能力と得意 */
  driver?: DriverStats;
  specs?: SpecialtyId[];
  /** このコースの慣れ (0..1。人の車は代走の慣れ) */
  fam?: number;
  /** ピットで止まる時間の倍率 (整備の組) */
  serviceFactor?: number;
}

export interface FixedField {
  /** 結果を返すときの名札 (大会の id と組) */
  tag: string;
  trackId: string;
  laps: number;
  /** スタートの時刻 (待合はここまで) */
  startAt: number;
  weather: WeatherPlan;
  /** 持っていく組の決まり (雇った運転手の組を決める) */
  tireKind?: "tournament" | "custom";
  cars: FixedCar[];
}

export interface FixedCarResult {
  key: string;
  teamId: string;
  driverId: string;
  kind: "human" | "hired";
  /** 部屋の順位 (1 から) */
  pos: number;
  /** 並び (1 から) */
  gridPos: number;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  /** 一番速い周 (秒) */
  best: number | null;
  penalty: number;
  pitStops: number;
  /** 代走が走らせた (人が来なかった・途中で切れた) */
  standIn: boolean;
  /** 履いたタイヤと走った道のり (大会のタイヤの決まりに使う) */
  stints: Stint[];
  /** レース中の路面の一番の濡れ具合 */
  maxWet: number;
}

/** チームの 2 台目 (お金で雇ったコンピューターの運転手) */
export interface TeamSecondCar {
  driverId: string;
  /** 運転手の名前 (部屋の名前の 12 字に切る) */
  name: string;
  design: CarDesign;
  /** 運転手の能力 (drivers.ts の driverBrain に渡す) */
  driver: DriverStats;
  /** 運転手の得意 (drivers.ts の SPECIALTIES。なし = 得意なし) */
  specs?: SpecialtyId[];
  /** コースの id → 慣れ (0..1、familiarity.ts) */
  fam?: Record<string, number>;
}

/** ログインした人のチームの様子 (hello のときにサーバーが渡す。名無しなら なし) */
export interface JoinTeam {
  /** ピットで止まる時間の倍率 (crew.ts の crewServiceFactor) */
  serviceFactor?: number;
  /** 2 台目 (雇った運転手がいて、設計図が使えるときだけ) */
  second?: TeamSecondCar | null;
  /** 代走 (通信が切れたときのコンピューター) のコースごとの慣れ (0..1) */
  standInFam?: Record<string, number>;
}

/** チームの 1 台の結果 */
export interface TeamCarResult {
  id: string;
  pos: number;
  points: number;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  pitStops: number;
  /** 走った道のり (m) */
  distM: number;
  /** 壁に強く当たった回数 */
  wallHits: number;
  /** 付けていた部品の id (研究を早める。重なりなし) */
  partIds: string[];
}

export interface TeamRaceReport {
  trackId: string;
  laps: number;
  cars: number;
  /** 出た人の数 (raceReport と同じ数え方) */
  humans: number;
  teams: Array<{
    /** 1 台目の部屋の id と、つなぎ直しの印 */
    id: string;
    key: string;
    car1: TeamCarResult & { standIn: boolean };
    car2: (TeamCarResult & { driverId: string }) | null;
  }>;
}

interface Entrant {
  id: string;
  key: string;
  name: string;
  design: CarDesign;
  stats: CarStats;
  bot: boolean;
  connected: boolean;
  /** レースの途中から入って、次を待っている */
  waiting: boolean;
  color: string;
  slot: number;
  car: CarState;
  lap: LapState;
  brain: BotBrain | null;
  /** コンピューターが運転している (コンピューターの車か、通信が切れた人) */
  ai: boolean;
  simT: number;
  /** 人の画面が「ピットの道の中」と言ってきた */
  remotePit: boolean;
  /** ピットに入った回数・今のタイヤを履いた道のり・止まっているか (レース中だけ。snap で送る) */
  stint: StintState;
  /** ログインした人のチーム (なし = 名無し) */
  team?: JoinTeam;
  /** チームの 2 台目なら、1 台目の部屋の id と運転手の id */
  ownerId?: string;
  driverId?: string;
  /** このレースで代走が走らせた */
  standIn?: boolean;
  /** 人の画面が「止まる場所で作業中」と言ってきた (チームの相方を待たせる) */
  remoteBox?: boolean;
  /** 同じチームのもう 1 台の部屋の id (ピットの止まる場所を分け合う) */
  mateId?: string;
  /** 人の画面が「マニュアルで走っている」と言ってきた (結果の AT / MT の印。なし = 言ってこない前の画面) */
  mt?: boolean;
  /** チームの 2 台目への作戦の合図 (teamorder.ts) と、合図の前の数・合図を受けた時刻 (simT) */
  order?: TeamOrder;
  orderBase?: TeamOrderBase;
  orderAt?: number;
}

export class RaceRoom {
  phase: PhaseInfo["phase"] = "idle";
  private entrants = new Map<string, Entrant>();
  private endsAt = 0;
  /** 待合を伸ばせる一番遅い時刻 (遅れて入った人のため。LATE_JOIN_CAP_MS) */
  private lobbyCapAt = 0;
  private lightsStartAt = 0;
  private lightsOutAt = 0;
  private chequeredAt = 0;
  private trackId: string;
  private trackTurn = 0;
  private results: ResultRow[] | undefined;
  private nextId = 1;
  private lastSnap = 0;
  private lastHumanAt = 0;
  private weather: WeatherPlan | null = null;
  /** 旗・VSC・SC (レースごとに作り直す) */
  private rc: RaceControl = newRaceControl();
  /** 顔ぶれの決まった部屋 (大会の組)。null = ふつうの部屋 */
  private fixed: FixedField | null = null;
  /** 決まった部屋の車ごとのタイヤの区間と、前の刻みの道のり */
  private stints = new Map<string, Stint[]>();
  private stintDist = new Map<string, number>();
  private maxWet = 0;
  /** 開いた部屋 (null = すぐ走るの部屋か大会の組) */
  private custom: CustomRoomConfig | null = null;

  constructor(
    private io: RoomIO,
    readonly laps: number,
    private rand: () => number = Math.random,
    private trackIds: string[] = TRACK_DEFS.map((d) => d.id),
  ) {
    this.trackId = trackIds[0];
  }

  info(): PhaseInfo {
    return {
      phase: this.phase,
      trackId: this.trackId,
      laps: this.laps,
      endsAt: this.endsAt,
      lightsStartAt: this.lightsStartAt,
      lightsOutAt: this.lightsOutAt,
      chequered: this.chequeredAt > 0,
      results: this.results,
      weather: this.weather ?? undefined,
      ...(this.custom ? { room: { id: this.custom.id, cls: this.custom.cls, host: this.custom.hostName } } : {}),
    };
  }

  humans(): number {
    let n = 0;
    for (const e of this.entrants.values()) if (!e.bot && e.connected) n++;
    return n;
  }

  roster(): RosterEntry[] {
    return [...this.entrants.values()]
      .filter((e) => !e.waiting)
      .map((e) => ({ id: e.id, name: e.name, design: e.design, bot: e.bot, color: e.color, slot: e.slot, ...(e.ownerId ? { owner: e.ownerId } : {}) }));
  }

  /** 人が入ってくる。同じ key なら つなぎ直し */
  join(
    key: string,
    name: string,
    design: CarDesign,
    now: number,
    /** id が決まったとき (何かを送る前) に呼ぶ。サーバーはここで id と WebSocket を結びつける */
    onId: (id: string) => void = () => {},
    /** ログインした人のチーム (2 台目・整備の腕・代走の慣れ)。なし = 名無しで今までどおり */
    team?: JoinTeam | null,
  ): { ok: true; id: string } | { ok: false; reason: "full" | "bad"; msg: string } {
    const errs = validateDesign(design);
    if (errs.length) return { ok: false, reason: "bad", msg: errs[0] };
    if (this.fixed && this.phase === "idle") return { ok: false, reason: "bad", msg: "この組のレースは終わりました" };
    if (this.custom?.closed) return { ok: false, reason: "bad", msg: "この部屋は閉じました。一覧から選び直してください" };
    const clean = cleanName(name);
    for (const e of this.entrants.values()) {
      if (!e.bot && e.key === key) {
        e.connected = true;
        e.name = clean;
        if (team) e.team = team;
        else if (team === null) delete e.team;
        if (this.phase !== "race") {
          e.design = design;
          e.stats = computeStats(design);
        }
        onId(e.id);
        this.welcome(e, now);
        if (this.phase === "race" && !e.waiting && e.ai && !e.lap.finished && !e.lap.retired) {
          e.ai = false;
          e.brain = null;
          this.io.send(e.id, {
            t: "resume",
            car: {
              x: e.car.x,
              y: e.car.y,
              heading: e.car.heading,
              vx: e.car.vx,
              vy: e.car.vy,
              dist: e.car.dist,
              fuel: e.car.fuel,
              lapsDone: e.lap.lapsDone,
              lapStart: e.lap.lapStart,
              bestLap: e.lap.bestLap,
              penalty: e.lap.penalty,
              tire: e.car.tire,
              wear: e.car.wear,
              burst: e.car.burst,
              sets: e.car.sets ?? undefined,
              dmg: packDamage(e.car.damage),
              hits: e.car.damage?.hits ?? 0,
            },
          });
        }
        this.io.broadcast({ t: "roster", roster: this.roster() });
        return { ok: true, id: e.id };
      }
    }
    if (this.fixed) return { ok: false, reason: "bad", msg: this.phase === "idle" || this.phase === "results" ? "この組のレースは終わりました" : "この組の出場者ではありません" };
    if (this.humans() >= MAX_CARS) return { ok: false, reason: "full", msg: "満員です" };
    const id = `p${this.nextId++}`;
    const stats = computeStats(design);
    const track = getTrack(this.trackId);
    const e: Entrant = {
      id,
      key,
      name: clean,
      design,
      stats,
      bot: false,
      connected: true,
      waiting: this.phase === "race",
      color: CAR_COLORS[0],
      slot: 0,
      car: createCar(track, stats, 0),
      lap: newLapState(),
      brain: null,
      ai: false,
      simT: 0,
      remotePit: false,
      stint: newStint("M", 0, 0),
      ...(team ? { team } : {}),
    };
    this.entrants.set(id, e);
    onId(id);
    if (this.phase === "idle") this.startLobby(now);
    if (this.phase === "lobby") {
      // 終わり近くに入った人: タイヤと燃料を決める時間を残す (伸ばすのは lobbyCapAt まで。大会の組は時刻どおり)
      if (!this.fixed && this.endsAt - now < LATE_JOIN_MS) this.endsAt = Math.max(this.endsAt, Math.min(now + LATE_JOIN_MS, this.lobbyCapAt));
      // 8 人そろったら早めに始める
      if (this.humans() >= MAX_CARS) this.endsAt = Math.min(this.endsAt, now + 3000);
      this.io.broadcast({ t: "phase", info: this.info() });
    }
    this.welcome(e, now);
    this.io.broadcast({ t: "roster", roster: this.roster() });
    return { ok: true, id };
  }

  private welcome(e: Entrant, now: number) {
    const team = e.team ? { crew: e.team.serviceFactor, second: e.team.second?.name } : {};
    this.io.send(e.id, { t: "welcome", id: e.id, now, info: this.info(), roster: this.roster(), waiting: e.waiting, ...team });
  }

  leave(id: string, now: number) {
    const e = this.entrants.get(id);
    if (!e || e.bot) return;
    e.connected = false;
    if (this.phase === "race" && !e.waiting && !e.lap.finished && !e.lap.retired) {
      // 通信が切れたらコンピューターが代わりに運転
      e.ai = true;
      e.brain = makeBrain(this.rand, 0.9);
      e.brain.reaction = 0;
      // ログインした人の代走は、そのチームで走るほどコースに慣れる (familiarity.ts)
      const fam = e.team?.standInFam?.[this.trackId];
      if (fam) applyFamiliarity(e.brain, fam, true);
      e.standIn = true;
      e.simT = Math.max(0, (now - this.lightsOutAt) / 1000);
      e.car.started = true;
      e.remotePit = false;
      e.car.pit = null;
      e.car.pitOrder = null;
      const q = queryTrack(getTrack(this.trackId), e.car.x, e.car.y);
      e.car.hint = q.index;
      e.car.lastS = q.s;
    } else if (!this.fixed) {
      this.entrants.delete(id);
      this.io.broadcast({ t: "roster", roster: this.roster() });
    }
    if (this.humans() === 0 && this.phase === "lobby" && !this.fixed) this.toIdle();
  }

  /** 人がいなくなって休む (開いた部屋はそれで閉じる) */
  private toIdle() {
    this.phase = "idle";
    this.entrants.clear();
    if (this.custom) this.custom.closed = true;
  }

  /** チームの 2 台目への作戦の合図 (レース中、2 台目が走っているときだけ) */
  private teamOrder(owner: Entrant, order: unknown) {
    if (this.phase !== "race" || owner.waiting || !isTeamOrder(order)) return;
    const mate = [...this.entrants.values()].find((x) => x.ownerId === owner.id && x.bot);
    if (!mate || !mate.brain || mate.lap.finished || mate.lap.retired) return;
    this.setOrder(mate, order);
    this.io.send(owner.id, { t: "info", text: `${mate.name} へ: ${TEAM_ORDER_TEXT[order]}` });
  }

  private setOrder(mate: Entrant, order: TeamOrder) {
    if (!mate.brain) return;
    mate.orderBase ??= teamOrderBase(mate.brain, mate.car);
    mate.order = order;
    mate.orderAt = mate.simT;
    applyTeamOrder(mate.brain, mate.car, order, mate.orderBase);
  }

  onMessage(id: string, msg: ClientMsg, now: number) {
    const e = this.entrants.get(id);
    if (!e || e.bot) return;
    switch (msg.t) {
      case "ping":
        this.io.send(id, { t: "pong", c: msg.c, s: now });
        return;
      case "state": {
        if (this.phase !== "race" || e.waiting || e.ai || e.lap.finished) return;
        if (![msg.x, msg.y, msg.h, msg.vx, msg.vy, msg.dist, msg.fuel].every(Number.isFinite)) return;
        const c = e.car;
        c.x = msg.x;
        c.y = msg.y;
        c.heading = msg.h;
        c.vx = msg.vx;
        c.vy = msg.vy;
        c.dist = msg.dist;
        c.fuel = msg.fuel;
        c.started = true;
        e.lap.lapsDone = Math.max(0, Math.floor(msg.lapsDone));
        e.lap.lapStart = msg.lapStart;
        noteBest(e.lap, msg.best, (now - this.lightsOutAt) / 1000);
        e.lap.penalty = Math.max(e.lap.penalty, msg.penalty);
        if (isTireCompound(msg.tire)) c.tire = msg.tire;
        if (typeof msg.wear === "number" && Number.isFinite(msg.wear)) c.wear = Math.max(0, Math.min(1, msg.wear));
        if (typeof msg.burst === "boolean") c.burst = msg.burst;
        // 傷み (hits を送ってくる画面だけ。dmg なし = 無傷)
        if (typeof msg.hits === "number") c.damage = readDamage(msg.dmg, msg.hits, e.stats);
        if (typeof msg.drs === "boolean") (c.drs ??= newDrsState()).open = msg.drs;
        if (typeof msg.ot === "boolean") (c.ot ??= newOvertakeState()).active = msg.ot;
        if (typeof msg.mt === "boolean") e.mt = msg.mt;
        if (msg.sets !== undefined) c.sets = readTireSets(msg.sets);
        e.remotePit = !!msg.pit;
        e.remoteBox = !!msg.pit && !!msg.box;
        return;
      }
      case "go": {
        if (this.phase !== "race" || e.waiting) return;
        if (msg.at < 0 && e.lap.penalty < JUMP_START_PENALTY) {
          this.io.broadcast({ t: "info", text: `${e.name} がフライング (+${JUMP_START_PENALTY} 秒)` });
        }
        return;
      }
      case "finish": {
        if (this.phase !== "race" || e.waiting || e.lap.finished) return;
        const t = (now - this.lightsOutAt) / 1000;
        // あまりにずれた時間は信じない (サーバーの時計に合わせる)
        const time = Math.abs(msg.time - t) < 5 ? msg.time : t;
        e.lap.finished = true;
        e.lap.finishTime = time;
        if (typeof msg.mt === "boolean") e.mt = msg.mt;
        e.lap.lapsDone = Math.max(e.lap.lapsDone, msg.lapsDone);
        noteBest(e.lap, msg.best, t);
        e.lap.penalty = Math.max(e.lap.penalty, msg.penalty);
        this.onFinish(now);
        return;
      }
      case "retire":
        if (this.phase === "race" && !e.waiting) e.lap.retired = true;
        return;
      case "order":
        this.teamOrder(e, msg.order);
        return;
      case "hello":
      case "start":
        // start は部屋の DO が開いた人かを確かめてから startNow を呼ぶ
        return;
    }
  }

  /** 旗の知らせ (info) */
  private announce(evs: RcEvent[]) {
    const name = (id: string) => this.entrants.get(id)?.name ?? id;
    for (const ev of evs) {
      let text = "";
      if (ev.kind === "sc") text = `SC (先導車): ${ev.reason}`;
      else if (ev.kind === "vsc") text = `VSC: ${ev.reason}`;
      else if (ev.kind === "ending") text = ev.mode === "sc" ? "SC はこの周で入ります" : "VSC がまもなく終わります";
      else if (ev.kind === "green") text = "グリーン: 再開";
      else if (ev.kind === "yellow") text = `黄旗 ${SECTOR_NAME(ev.sector)}: ${ev.reason}`;
      else if (ev.kind === "penalty") text = `${name(ev.id)} が追い越し禁止の間に ${name(ev.passed)} を抜いた (+${ev.seconds} 秒)`;
      if (text) this.io.broadcast({ t: "info", text });
    }
  }

  private onFinish(now: number) {
    if (!this.chequeredAt) {
      this.chequeredAt = now;
      this.io.broadcast({ t: "phase", info: this.info() });
    }
  }

  private startLobby(now: number) {
    this.phase = "lobby";
    this.endsAt = now + (this.custom ? CUSTOM_LOBBY_MS : LOBBY_MS);
    this.lobbyCapAt = this.endsAt + LATE_JOIN_CAP_MS;
    this.results = undefined;
    this.chequeredAt = 0;
    // 次のレースのコース (待合で見せるコースと走るコースをそろえる。開いた部屋は trackIds が 1 つなのでいつも同じ)
    if (!this.fixed) this.trackId = this.trackIds[this.trackTurn++ % this.trackIds.length];
    // 次のレースの天気 (待合のうちに予報を出せるように、ここで決める)
    this.weather = this.makeWeather();
  }

  private makeWeather(): WeatherPlan {
    const seed = 1 + Math.floor(this.rand() * 2147483645);
    // レースの長さは多めに見積もる (雨だと遅い)
    return makeWeatherPlan(seed, this.laps * 75);
  }

  /** 顔ぶれの決まった部屋か (大会の組) */
  isFixed(): boolean {
    return this.fixed !== null;
  }

  /** 開いた部屋にする (誰も入っていないうちに 1 回だけ)。コースはいつもこれ、待合は CUSTOM_LOBBY_MS */
  setCustom(cfg: CustomRoomConfig) {
    if (this.fixed || this.phase !== "idle" || this.entrants.size > 0) return;
    this.custom = { ...cfg };
    if (cfg.trackDef && cfg.trackDef.id === cfg.trackId) registerTrackDef(cfg.trackDef);
    this.trackIds = [cfg.trackId];
    this.trackId = cfg.trackId;
    this.trackTurn = 0;
  }

  /** 開いた部屋の決めごと (なし = すぐ走るの部屋か大会の組) */
  customConfig(): Readonly<CustomRoomConfig> | null {
    return this.custom;
  }

  /** 部屋の席の様子 (一覧に出す): つながっている人と、一緒に出る 2 台目の数 */
  seatsInfo(): { humans: number; cars: number } {
    let humans = 0;
    let seconds = 0;
    for (const e of this.entrants.values()) {
      if (e.bot || !e.connected) continue;
      humans++;
      if (e.team?.second) seconds++;
    }
    return { humans, cars: Math.min(MAX_CARS, humans + seconds) };
  }

  /**
   * 開いた部屋の待合を今終えてスタートへ (開いた人の「スタート」。開いた人かは呼ぶ側が確かめる)。
   * 人が CUSTOM_START_MIN 人より少なければ断る
   */
  startNow(now: number): { ok: true } | { ok: false; msg: string } {
    if (!this.custom || this.phase !== "lobby") return { ok: false, msg: "待合のときだけ始められます" };
    if (this.humans() < CUSTOM_START_MIN) return { ok: false, msg: `人が ${CUSTOM_START_MIN} 人そろったら始められます` };
    this.startRace(now);
    return { ok: true };
  }

  /**
   * 大会の組の部屋にする: 待合を startAt まで開き、決まった顔ぶれの席を作る (人はまだつながっていない)。
   * startAt になったら、来ていない人の車は代走 (STAND_IN_SKILL・走る前の予定のまま) が走らせる
   */
  setFixed(field: FixedField, now: number) {
    this.fixed = field;
    this.entrants.clear();
    this.trackId = field.trackId;
    this.weather = field.weather;
    this.results = undefined;
    this.chequeredAt = 0;
    const track = getTrack(field.trackId);
    field.cars.forEach((c, i) => {
      const stats = computeStats(c.design);
      // id は並べた順で決める (眠ったあとに戻しても WebSocket と結びつく)
      const id = `f${i}`;
      const human = c.kind === "human";
      this.entrants.set(id, {
        id,
        key: c.key,
        name: cleanName(c.name),
        design: c.design,
        stats,
        bot: !human,
        connected: !human,
        waiting: false,
        color: CAR_COLORS[c.slot % CAR_COLORS.length],
        slot: c.slot,
        car: createCar(track, stats, c.slot),
        lap: newLapState(),
        brain: null,
        ai: !human,
        simT: 0,
        remotePit: false,
        stint: newStint("M", 0, 0),
        ...(human ? {} : { driverId: c.driverId }),
      });
    });
    this.phase = "lobby";
    this.endsAt = Math.max(now, field.startAt);
    this.io.broadcast({ t: "roster", roster: this.roster() });
    this.io.broadcast({ t: "phase", info: this.info() });
  }

  private startFixedRace(now: number) {
    const f = this.fixed!;
    const track = getTrack(f.trackId);
    const weather = (this.weather ??= this.makeWeather());
    const wet0 = wetnessAt(weather, 0);
    const byKey = new Map(f.cars.map((c) => [c.key, c]));
    this.stints.clear();
    this.stintDist.clear();
    this.maxWet = wet0;
    // 同じチームの 2 台 (ピットの止まる場所を分け合う)
    const byTeam = new Map<string, string[]>();
    for (const e of this.entrants.values()) {
      const c = byKey.get(e.key);
      if (c) byTeam.set(c.teamId, [...(byTeam.get(c.teamId) ?? []), e.id]);
    }
    for (const e of this.entrants.values()) {
      const c = byKey.get(e.key);
      if (!c) {
        this.entrants.delete(e.id);
        continue;
      }
      const sf = c.serviceFactor !== undefined ? { serviceFactor: c.serviceFactor } : {};
      const setup =
        c.kind === "human" && c.setup
          ? { tire: c.setup.tire, wear: c.setup.wear, sets: c.setup.sets, fuel: c.setup.fuel }
          : botStartSetup(e.stats, track, this.laps, wet0, wetnessAt(weather, 60), this.rand, {
              rules: allocRules(f.tireKind ?? "tournament", this.laps),
              wetMax: forecastWetMax(wet0, forecastAt(weather, 0)),
            });
      e.waiting = false;
      e.slot = c.slot;
      e.color = CAR_COLORS[c.slot % CAR_COLORS.length];
      // 雇った運転手はタイヤと燃料の扱いが車に効く (人の車と代走には付けない)
      const scales = c.kind === "hired" && c.driver ? driverCarScales(c.driver, c.specs) : {};
      e.car = createCar(track, e.stats, c.slot, { ...setup, ...sf, ...scales });
      const mates = byTeam.get(c.teamId) ?? [];
      e.mateId = mates.length === 2 ? mates.find((id) => id !== e.id) : undefined;
      e.remoteBox = false;
      e.lap = newLapState();
      e.simT = 0;
      e.remotePit = false;
      e.stint = newStint(e.car.tire, e.car.wear, e.car.dist);
      if (c.kind === "hired") {
        e.ai = true;
        e.brain = applyFamiliarity(c.driver ? driverBrain(c.driver, this.rand, c.specs) : makeBrain(this.rand), c.fam ?? 0);
        e.standIn = false;
      } else if (e.connected) {
        e.ai = false;
        e.brain = null;
        e.standIn = false;
      } else {
        // 来なかった人の車: 代走 (普通の上手さ・予定のまま)
        e.ai = true;
        e.brain = applyFamiliarity(makeBrain(this.rand, STAND_IN_SKILL), c.fam ?? 0, true);
        e.standIn = true;
      }
      this.stints.set(e.id, startStint([], e.car.tire, wet0));
      this.stintDist.set(e.id, e.car.dist);
    }
    this.beginRace(now, weather);
  }

  private beginRace(now: number, weather: WeatherPlan) {
    this.phase = "race";
    this.chequeredAt = 0;
    this.results = undefined;
    this.rc = newRaceControl(skyAt(weather, 0));
    this.lastHumanAt = now;
    this.lightsStartAt = now + 3000;
    this.lightsOutAt = this.lightsStartAt + 5000 + Math.round(200 + this.rand() * 2000);
    this.endsAt = this.lightsOutAt + this.laps * 240_000;
    this.io.broadcast({ t: "roster", roster: this.roster() });
    this.io.broadcast({ t: "phase", info: this.info() });
  }

  private startRace(now: number) {
    if (this.fixed) return this.startFixedRace(now);
    // コースは待合を開いたときに決めてある (startLobby。待合の準備の札がそのコースで計算できるように)
    const track = getTrack(this.trackId);
    const weather = (this.weather ??= this.makeWeather());
    // 人を並べ、空きをコンピューターで埋める
    const humans = [...this.entrants.values()].filter((e) => !e.bot && e.connected);
    for (const e of [...this.entrants.values()]) if (e.bot || !e.connected) this.entrants.delete(e.id);
    shuffle(humans, this.rand);
    // スタートの並びはくじ (11/25 ユーザー「スターティンググリットは、ランダムにしよう」): 人もコンピューターも並びの場所をくじで
    const grid = Array.from({ length: MAX_CARS }, (_, k) => k);
    shuffle(grid, this.rand);
    const used = new Set<string>();
    humans.forEach((e, i) => {
      e.waiting = false;
      e.slot = grid[i];
      // 色は並びの場所で決める (コンピューターも同じ決め方なので、くじの並びでも色がかぶらない)
      e.color = CAR_COLORS[grid[i] % CAR_COLORS.length];
      e.car = createCar(track, e.stats, grid[i], e.team?.serviceFactor !== undefined ? { serviceFactor: e.team.serviceFactor } : {});
      e.standIn = false;
      e.lap = newLapState();
      e.ai = false;
      e.brain = null;
      e.simT = 0;
      e.remotePit = false;
      e.remoteBox = false;
      e.mateId = undefined;
      e.stint = newStint(e.car.tire, e.car.wear, e.car.dist);
      used.add(e.name);
    });
    const tireKind = this.custom ? "custom" : "quick";
    // チームの 2 台目 (雇った運転手)。8 台の席が空いているときだけ (満員なら 1 台目だけ)
    let k0 = humans.length;
    for (const h of humans) {
      const sec = h.team?.second;
      if (!sec || k0 >= MAX_CARS || validateDesign(sec.design).length) continue;
      const slot = grid[k0++];
      const stats = computeStats(sec.design);
      let name = cleanName(sec.name);
      if (used.has(name)) name = `${name.slice(0, 10)} 2`;
      used.add(name);
      const id = `t${this.nextId++}`;
      const car = createCar(track, stats, slot, {
        ...botStartSetup(stats, track, this.laps, wetnessAt(weather, 0), wetnessAt(weather, 60), this.rand, {
          rules: allocRules(tireKind, this.laps),
          wetMax: forecastWetMax(wetnessAt(weather, 0), forecastAt(weather, 0)),
        }),
        ...(h.team?.serviceFactor !== undefined ? { serviceFactor: h.team.serviceFactor } : {}),
        // 雇った運転手のタイヤと燃料の扱い
        ...driverCarScales(sec.driver, sec.specs),
      });
      h.mateId = id;
      const brain = applyFamiliarity(driverBrain(sec.driver, this.rand, sec.specs), sec.fam?.[this.trackId] ?? 0);
      this.entrants.set(id, {
        id,
        key: id,
        name,
        design: sec.design,
        stats,
        bot: true,
        connected: true,
        waiting: false,
        color: CAR_COLORS[slot % CAR_COLORS.length],
        slot,
        car,
        lap: newLapState(),
        brain,
        ai: true,
        simT: 0,
        remotePit: false,
        stint: newStint(car.tire, car.wear, car.dist),
        ownerId: h.id,
        driverId: sec.driverId,
        mateId: h.id,
      });
    }
    for (let k = k0; k < MAX_CARS; k++) {
      const slot = grid[k];
      const design = BOT_DESIGNS[Math.floor(this.rand() * BOT_DESIGNS.length)];
      const stats = computeStats(design);
      let name = BOT_NAMES[Math.floor(this.rand() * BOT_NAMES.length)];
      while (used.has(name)) name = BOT_NAMES[Math.floor(this.rand() * BOT_NAMES.length)];
      used.add(name);
      const id = `b${this.nextId++}`;
      const car = createCar(track, stats, slot, botStartSetup(stats, track, this.laps, wetnessAt(weather, 0), wetnessAt(weather, 60), this.rand, {
        rules: allocRules(tireKind, this.laps),
        wetMax: forecastWetMax(wetnessAt(weather, 0), forecastAt(weather, 0)),
      }));
      this.entrants.set(id, {
        id,
        key: id,
        name: `${name} (CPU)`,
        design,
        stats,
        bot: true,
        connected: true,
        waiting: false,
        color: CAR_COLORS[slot % CAR_COLORS.length],
        slot,
        car,
        lap: newLapState(),
        brain: makeBrain(this.rand),
        ai: true,
        simT: 0,
        remotePit: false,
        stint: newStint(car.tire, car.wear, car.dist),
      });
    }
    this.beginRace(now, weather);
  }

  private endRace(now: number) {
    const racers = [...this.entrants.values()].filter((e) => !e.waiting);
    const sorted = sortStandings(
      racers.map((e) => ({
        e,
        id: e.id,
        finished: e.lap.finished,
        retired: e.lap.retired,
        lapsDone: e.lap.lapsDone,
        finishTime: e.lap.finishTime,
        // 罰 = 走った側の罰 (フライング・近道) + 旗の罰 (黄旗・VSC で抜いた)
        penalty: e.lap.penalty + (this.rc.pen[e.id] ?? 0),
        dist: e.car.dist,
      })),
    );
    // 一番速い周: 同じタイムなら先に出した車、それも同じなら順位が上の車
    const fastestId = pickFastest(sorted.map((s) => ({ id: s.id, best: s.e.lap.bestLap, bestAt: s.e.lap.bestAt })));
    this.results = sorted.map((s, i) => ({
      id: s.id,
      name: s.e.name,
      color: s.e.color,
      bot: s.e.bot,
      pos: i + 1,
      finished: s.finished,
      retired: s.retired,
      lapsDone: s.lapsDone,
      total: s.finishTime + s.penalty,
      penalty: s.penalty,
      best: s.e.lap.bestLap,
      // 一番速い周の 1 点は、点の入る順位 (下から 2 台より上) で完走したときだけ
      points: s.finished ? pointsFor(i, sorted.length) + (s.id === fastestId && pointsFor(i, sorted.length) > 0 ? 1 : 0) : 0,
      fastest: s.id === fastestId,
      // 変速の印 (人の車で、画面が言ってきたときだけ)
      ...(!s.e.bot && typeof s.e.mt === "boolean" ? { mt: s.e.mt } : {}),
    }));
    this.phase = "results";
    this.endsAt = now + RESULTS_MS;
    this.io.broadcast({ t: "phase", info: this.info() });
    if (this.fixed) {
      this.io.onFixedResults?.(this.fixed.tag, this.fixedResults(), now);
      // 運転手の育ち・慣れ・整備・研究 (すぐ走ると同じ。来なかった人の車は代走として数える)
      if (this.io.onTeamResults) {
        const team = this.fixedTeamReport();
        if (team.teams.length) this.io.onTeamResults(team);
      }
      return;
    }
    const report = raceReport(this.results, (id) => this.entrants.get(id)?.key ?? "", this.laps, this.trackId);
    this.io.onResults?.(report);
    if (this.io.onTeamResults) {
      const team = this.teamReport(report.humans);
      if (team.teams.length) this.io.onTeamResults(team);
    }
  }

  /**
   * 大会のコンピューター (代走・雇った運転手): 乾いた路面で乾いた路面用のタイヤを 1 種類しか使っていなければ、
   * レースの半分を過ぎたら (か、最後に入れる入り口で) 別の種類に替えに入る (タイヤの決まりで失格にならないように。仮)
   */
  private dryTyreRulePit(e: Entrant, L: number, entry: number, wet: number) {
    const car = e.car;
    if (car.pit || !car.sets || wet >= 0.1 || !TIRE_DEFS[car.tire].slick) return;
    const used = new Set((this.stints.get(e.id) ?? []).filter((x) => TIRE_DEFS[x.tire].slick).map((x) => x.tire));
    used.add(car.tire);
    if (used.size >= 2) return;
    if (car.pitOrder?.tire && car.pitOrder.tire !== car.tire && TIRE_DEFS[car.pitOrder.tire].slick) return;
    // 次に通る入り口のあとに半周以上残るときだけ。半分を過ぎたか、これが最後に入れる入り口なら入る
    const total = this.laps * L;
    const toEntry = (((entry - car.dist) % L) + L) % L;
    const afterEntry = total - (car.dist + toEntry);
    if (afterEntry <= L * 0.5) return;
    if (car.dist + toEntry < total / 2 && afterEntry - L > L * 0.5) return;
    const opt = setOptions(car.sets)
      .filter((o) => TIRE_DEFS[o.tire].slick && o.tire !== car.tire)
      .sort((a, b) => a.wear - b.wear)[0];
    if (!opt) return;
    requestPit(car, { tire: opt.tire, used: opt.used, fuelTo: car.pitOrder?.fuelTo ?? null, repair: !!car.pitOrder?.repair });
  }

  /** 決まった部屋の結果 (タイヤの区間つき) */
  private fixedResults(): FixedCarResult[] {
    const f = this.fixed!;
    const byKey = new Map(f.cars.map((c) => [c.key, c]));
    const out: FixedCarResult[] = [];
    for (const r of this.results ?? []) {
      const e = this.entrants.get(r.id);
      const c = e ? byKey.get(e.key) : undefined;
      if (!e || !c) continue;
      out.push({
        key: c.key,
        teamId: c.teamId,
        driverId: c.driverId,
        kind: c.kind,
        pos: r.pos,
        gridPos: c.slot + 1,
        finished: r.finished,
        retired: r.retired,
        lapsDone: r.lapsDone,
        best: r.best,
        penalty: r.penalty,
        pitStops: e.stint.pitStops,
        standIn: !!e.standIn,
        stints: this.stints.get(e.id) ?? [],
        maxWet: Math.round(this.maxWet * 1000) / 1000,
      });
    }
    return out;
  }

  /** チームごとの 2 台の結果 (ログインした人だけ) */
  private teamReport(humans: number): TeamRaceReport {
    const teams: TeamRaceReport["teams"] = [];
    for (const e of this.entrants.values()) {
      if (e.bot || !e.team || e.waiting) continue;
      const c1 = this.teamCar(e);
      if (!c1) continue;
      const second = [...this.entrants.values()].find((x) => x.ownerId === e.id);
      const c2 = second ? this.teamCar(second) : null;
      teams.push({ id: e.id, key: e.key, car1: { ...c1, standIn: !!e.standIn }, car2: c2 && second?.driverId ? { ...c2, driverId: second.driverId } : null });
    }
    return { trackId: this.trackId, laps: this.laps, cars: this.results?.length ?? 0, humans, teams };
  }

  /**
   * 大会の組のチームごとの 2 台 (人の車 = 1 台目 (来なければ代走)・雇った運転手 = 2 台目)。
   * id と key は人の車のもの (key = "acc:<アカウントの番号>")
   */
  private fixedTeamReport(): TeamRaceReport {
    const f = this.fixed!;
    const byKey = new Map(f.cars.map((c) => [c.key, c]));
    const teams: TeamRaceReport["teams"] = [];
    let humans = 0;
    for (const e of this.entrants.values()) {
      const c = byKey.get(e.key);
      if (!c || c.kind !== "human") continue;
      if (!e.standIn) humans++;
      const c1 = this.teamCar(e);
      if (!c1) continue;
      const mate = e.mateId ? this.entrants.get(e.mateId) : undefined;
      const mc = mate ? byKey.get(mate.key) : undefined;
      const c2 = mate && mc?.kind === "hired" ? this.teamCar(mate) : null;
      teams.push({ id: e.id, key: e.key, car1: { ...c1, standIn: !!e.standIn }, car2: c2 && mc ? { ...c2, driverId: mc.driverId } : null });
    }
    return { trackId: this.trackId, laps: this.laps, cars: this.results?.length ?? 0, humans, teams };
  }

  /** チームの 1 台の結果 (結果になければ null) */
  private teamCar(e: Entrant): TeamCarResult | null {
    const r = (this.results ?? []).find((x) => x.id === e.id);
    if (!r) return null;
    {
      return {
        id: e.id,
        pos: r.pos,
        points: r.points,
        finished: r.finished,
        retired: r.retired,
        lapsDone: r.lapsDone,
        pitStops: e.stint.pitStops,
        distM: Math.max(0, Math.round(e.car.dist)),
        wallHits: e.car.damage?.hits ?? 0,
        partIds: [...new Set(e.design.parts.map((p) => p.id))],
      };
    }
  }

  tick(now: number) {
    switch (this.phase) {
      case "idle":
        return;
      case "lobby":
        if (this.humans() === 0 && !this.fixed) {
          this.toIdle();
          return;
        }
        if (now >= this.endsAt) this.startRace(now);
        return;
      case "race":
        this.tickRace(now);
        return;
      case "results":
        if (now >= this.endsAt && this.fixed) {
          // 大会の組は 1 回だけ。結果を出したら閉じる (結果は残す)
          this.phase = "idle";
          for (const e of this.entrants.values()) e.connected = e.bot;
          return;
        }
        if (now >= this.endsAt) {
          for (const e of [...this.entrants.values()]) if (e.bot || !e.connected) this.entrants.delete(e.id);
          for (const e of this.entrants.values()) e.waiting = false;
          if (this.humans() > 0) {
            this.startLobby(now);
            this.io.broadcast({ t: "roster", roster: this.roster() });
            this.io.broadcast({ t: "phase", info: this.info() });
          } else {
            this.toIdle();
          }
        }
        return;
    }
  }

  private tickRace(now: number) {
    const track = getTrack(this.trackId);
    const tRace = (now - this.lightsOutAt) / 1000;
    const chequered = this.chequeredAt > 0;
    const racers0 = [...this.entrants.values()].filter((e) => !e.waiting);
    const weather = this.weather;
    const inPitLane = (e: Entrant) => !!e.car.pit || e.remotePit;
    const rc = this.rc;
    const rcCar = (e: Entrant): RcCar => {
      const dmg = damageCount(e.car);
      return {
        id: e.id,
        dist: e.car.dist,
        speed: Math.hypot(e.car.vx, e.car.vy),
        lapsDone: e.lap.lapsDone,
        started: e.car.started,
        pit: inPitLane(e),
        finished: e.lap.finished,
        retired: e.lap.retired,
        hits: e.car.damage?.hits ?? 0,
        lost: dmg.lost,
        burst: !!e.car.burst,
        broken: dmg.broken,
      };
    };
    // コンピューターが運転する車を 1 刻みずつそろえて進め、ぶつかりを直す。旗も同じ刻みで進める
    for (let guard = 0; guard < 40; guard++) {
      const rcDue = rc.t + DT <= tRace;
      const active = racers0.filter((e) => e.ai && e.brain && e.simT + DT <= tRace);
      if (!active.length && !rcDue) break;
      if (rcDue) {
        const evs = stepRaceControl(rc, track, racers0.map(rcCar), DT, {
          sky: weather ? skyAt(weather, rc.t + DT) : undefined,
          wet: weather ? wetnessAt(weather, rc.t + DT) : 0,
          chequered: this.chequeredAt > 0,
        });
        if (evs.length) this.announce(evs);
      }
      if (!active.length) continue;
      // 当たりの相手 (ゴール・リタイアした車と、ピットの道の中の車と、まだ一度も位置を送ってこない人の車はすり抜ける)
      const solid = racers0.filter((e) => !e.lap.finished && !e.lap.retired && !inPitLane(e) && (e.ai || e.car.started));
      const bodies = new Map<string, Body>(solid.map((e) => [e.id, bodyOf(e.car, e.stats)]));
      // SC の間に追いかける相手
      let follow: { info: { mode: "sc"; order: string[]; sc?: FollowTarget }; cars: Map<string, FollowTarget> } | null = null;
      if (rc.mode === "sc") {
        const cars = new Map<string, FollowTarget>(racers0.map((e) => [e.id, { dist: e.car.dist, v: Math.hypot(e.car.vx, e.car.vy) }]));
        follow = { info: { mode: "sc", order: scOrder(racers0.map(rcCar)).map((c) => c.id), sc: rc.sc ?? undefined }, cars };
      }
      const cap = flagSpeedCap(rc);
      for (const e of active) {
        const brain = e.brain!;
        if (e.lap.finished || e.lap.retired) {
          e.simT = tRace;
          continue;
        }
        e.car.started = e.car.started || e.simT >= brain.reaction;
        const others: Body[] = [];
        for (const [id, b] of bodies) if (id !== e.id) others.push(b);
        const wet = weather ? wetnessAt(weather, e.simT) : 0;
        if (e.car.started) {
          const totalLaps = this.chequeredAt > 0 ? Math.min(this.laps, e.lap.lapsDone + 1) : this.laps;
          const wetSoon = weather ? wetnessAt(weather, e.simT + BOT_WEATHER_LOOK) : 0;
          updateBotPit(e.car, e.stats, track, brain, { totalLaps, wetNow: wet, wetSoon });
          if (this.fixed?.tireKind === "tournament") this.dryTyreRulePit(e, track.length, track.pit.entry, wet);
        }
        // 作戦の合図「前を譲れ」: 相方 (人の車) がすぐ後ろなら落として前に出す。前に出たら (か、しばらくたったら) 終わり
        let yieldCap: number | undefined;
        if (e.order === "yield") {
          const owner = e.ownerId ? this.entrants.get(e.ownerId) : undefined;
          const oc = owner && !owner.lap.finished && !owner.lap.retired ? { ...owner.car, pit: inPitLane(owner) } : null;
          if (yieldDone(e.car, oc) || e.simT - (e.orderAt ?? e.simT) > TEAM_ORDER.yield.timeoutS) this.setOrder(e, "none");
          else yieldCap = yieldSpeedCap(e.car, oc);
        }
        // 旗に従う: SC の間は一列に並んで自動で、VSC・黄旗の区間は抜かない
        const vscCap = rc.mode === "vsc" ? VSC_SPEED : undefined;
        const input =
          follow && !e.car.pit
            ? scFollowInput(e.car, e.stats, track, scTarget(follow.info, e.id, follow.cars), wet, others)
            : botInput(e.car, e.stats, track, brain, e.simT, others, wet, {
                noPass: !overtakeAllowed(rc, track, e.car.dist),
                speedCap: yieldCap === undefined ? vscCap : Math.min(yieldCap, vscCap ?? Infinity),
              });
        const prevDist = e.car.dist;
        const ev = stepCar(e.car, input, e.stats, track, DT, {
          wetness: wet,
          ...(weather ? { lineWetness: lineWetnessAt(weather, e.simT) } : {}),
          tow: towFactor(e.car, others),
          speedCap: cap,
          boxBusy: this.mateInService(e),
        });
        // DRS: 使えるときは全開の直線で開く
        const otherDists: number[] = [];
        for (const o of solid) if (o !== e) otherDists.push(o.car.dist);
        updateDrs(e.car, track, prevDist, otherDists, rc.drs);
        // オーバーテイクモード: スタートの線で使えるかを決める (使うかは botInput が決める)
        updateOvertake(e.car, track, prevDist, otherDists, !!rc.ot);
        if (input.throttle >= 1 && drsAvailable(e.car, track)) openDrs(e.car, track);
        e.simT += DT;
        const le = updateLaps(e.car, e.lap, ev, e.simT, track.length, this.laps, this.chequeredAt > 0);
        if (le.finished) this.onFinish(now);
      }
      for (const e of active) {
        if (e.lap.finished || e.lap.retired || inPitLane(e)) continue;
        const me = bodyOf(e.car, e.stats);
        for (const o of solid) {
          if (o === e || inPitLane(o)) continue;
          pushApart(e.car, me, bodies.get(o.id) ?? bodyOf(o.car, o.stats), 0.5, e.stats);
        }
      }
    }
    if (tRace < 0) for (const e of racers0) if (e.ai) e.simT = Math.max(e.simT, 0);
    // ピットの回数・タイヤを替えたか・止まっているか (人の車は送ってきた様子から)
    for (const e of racers0) {
      updateStint(
        e.stint,
        {
          inPit: inPitLane(e),
          tire: e.car.tire,
          wear: e.car.wear,
          burst: e.car.burst,
          dist: e.car.dist,
          speed: Math.hypot(e.car.vx, e.car.vy),
          running: tRace > 0 && e.car.started && !e.lap.finished && !e.lap.retired,
        },
        tRace,
      );
    }

    // 決まった部屋 (大会): タイヤの決まりのため、履いたタイヤごとに走った道のりと路面を残す
    if (this.fixed && tRace > 0) {
      const wet = weather ? wetnessAt(weather, tRace) : 0;
      if (wet > this.maxWet) this.maxWet = wet;
      for (const e of racers0) {
        let list = this.stints.get(e.id) ?? [];
        const last = list[list.length - 1];
        if (!last || last.tire !== e.car.tire) list = startStint(list, e.car.tire, wet);
        const prev = this.stintDist.get(e.id) ?? e.car.dist;
        const d = e.car.dist - prev;
        if (d > 0 && d < 500 && !e.lap.finished && !e.lap.retired) list = advanceStint(list, d, wet);
        this.stintDist.set(e.id, e.car.dist);
        this.stints.set(e.id, list);
      }
    }

    if (now - this.lastSnap >= 100) {
      this.lastSnap = now;
      const cars: SnapCar[] = [];
      for (const e of this.entrants.values()) {
        if (e.waiting) continue;
        const flags =
          (e.lap.finished ? 1 : 0) |
          (e.lap.retired ? 2 : 0) |
          (e.ai && !e.bot ? 4 : 0) |
          (inPitLane(e) ? 8 : 0) |
          (e.car.drs?.open ? 16 : 0) |
          (e.car.ot?.active ? SNAP_OT : 0) |
          (damageCount(e.car).broken > 0 ? 32 : 0) |
          (e.car.burst ? 64 : 0) |
          (isStopped(e.stint, tRace) ? 128 : 0);
        cars.push([
          e.id, round2(e.car.x), round2(e.car.y), round3(e.car.heading), round2(e.car.dist), flags, e.lap.lapsDone, round2(e.car.vx), round2(e.car.vy),
          e.car.tire, tyreLaps(e.stint, e.car.dist, track.length), e.stint.pitStops,
        ]);
      }
      // 止まる場所が相方 (コンピューターが走らせる車) の作業で使われている人の車
      const busy: string[] = [];
      for (const e of racers0) if (!e.ai && !e.bot && this.mateInService(e)) busy.push(e.id);
      this.io.broadcast({ t: "snap", now, cars, flag: flagInfo(rc, racers0.map(rcCar)), ...(busy.length ? { busy } : {}) });
    }

    const racers = racers0;
    const allDone = racers.every((e) => e.lap.finished || e.lap.retired);
    if (this.humans() > 0) this.lastHumanAt = now;
    if (this.humans() === 0 && now - this.lastHumanAt > REJOIN_GRACE_MS && !this.fixed) {
      // 誰も戻ってこない
      this.toIdle();
      return;
    }
    if (allDone || (chequered && now - this.chequeredAt > CHEQUERED_MS) || now > this.endsAt) this.endRace(now);
  }

  /** チームの相方が止まる場所で作業中か (相方がコンピューターなら車の様子、人なら画面が送ってきた様子) */
  private mateInService(e: Entrant): boolean {
    const m = e.mateId ? this.entrants.get(e.mateId) : undefined;
    if (!m || m.waiting || m.mateId !== e.id) return false;
    return m.ai ? inService(m.car) : !!m.remoteBox;
  }

  /**
   * サーバーが眠る (hibernation) 前に残す部屋の様子。段階・時刻・顔ぶれ・つなぎ直しの key・結果・天気・コース。
   * レース中の車の位置などは残さない (レースの間はサーバーが起きたままなので)。RaceRoom.restore で戻す
   */
  snapshot(): RoomSnapshot {
    return {
      v: 1,
      laps: this.laps,
      phase: this.phase,
      endsAt: this.endsAt,
      ...(this.phase === "lobby" && !this.fixed ? { lobbyCapAt: this.lobbyCapAt } : {}),
      lightsStartAt: this.lightsStartAt,
      lightsOutAt: this.lightsOutAt,
      chequeredAt: this.chequeredAt,
      trackId: this.trackId,
      trackTurn: this.trackTurn,
      results: this.results,
      nextId: this.nextId,
      weather: this.weather,
      ...(this.fixed ? { fixed: this.fixed } : {}),
      ...(this.custom ? { custom: { ...this.custom } } : {}),
      entrants: [...this.entrants.values()].map((e) => ({
        id: e.id,
        key: e.key,
        name: e.name,
        design: e.design,
        bot: e.bot,
        connected: e.connected,
        waiting: e.waiting,
        color: e.color,
        slot: e.slot,
        ...(e.team && !e.bot ? { team: e.team } : {}),
      })),
    };
  }

  /**
   * snapshot から部屋を戻す。レースの途中で残したもの (途中は残していない) なら、
   * つながっている人だけで待合からやり直す (人がいなければ idle)
   */
  static restore(
    io: RoomIO,
    data: RoomSnapshot,
    now: number,
    rand: () => number = Math.random,
    trackIds: string[] = TRACK_DEFS.map((d) => d.id),
  ): RaceRoom {
    const room = new RaceRoom(io, data.laps, rand, data.custom ? [data.custom.trackId] : trackIds);
    if (data.custom) {
      room.custom = { ...data.custom };
      if (data.custom.trackDef && data.custom.trackDef.id === data.custom.trackId) registerTrackDef(data.custom.trackDef);
    }
    room.phase = data.phase;
    room.endsAt = data.endsAt;
    // 前の作りの snapshot には無い: もう伸ばさない
    room.lobbyCapAt = data.lobbyCapAt ?? data.endsAt;
    room.lightsStartAt = data.lightsStartAt;
    room.lightsOutAt = data.lightsOutAt;
    room.chequeredAt = data.chequeredAt;
    room.trackId = data.trackId;
    room.trackTurn = data.trackTurn;
    room.results = data.results;
    room.nextId = data.nextId;
    room.weather = data.weather;
    if (data.fixed) {
      room.fixed = data.fixed;
      // 大会の組: 待合なら席を戻す。レースの途中で追い出された (ふつうは起きない) なら、並びからやり直す
      if (data.phase === "lobby" || data.phase === "race") {
        const keep = new Map(data.entrants.map((e) => [e.key, e]));
        room.setFixed(data.fixed, now);
        for (const e of room.entrants.values()) if (!e.bot && keep.get(e.key)?.connected) e.connected = true;
        if (data.phase === "race") room.startFixedRace(now);
        else room.endsAt = Math.max(now, data.endsAt);
      }
      return room;
    }
    const track = getTrack(room.trackId);
    for (const s of data.entrants) {
      const stats = computeStats(s.design);
      room.entrants.set(s.id, {
        ...s,
        stats,
        car: createCar(track, stats, s.slot),
        lap: newLapState(),
        brain: null,
        ai: false,
        simT: 0,
        remotePit: false,
        stint: newStint("M", 0, 0),
      });
    }
    if (room.phase === "race") {
      for (const e of [...room.entrants.values()]) if (e.bot || !e.connected) room.entrants.delete(e.id);
      for (const e of room.entrants.values()) e.waiting = false;
      if (room.humans() > 0) room.startLobby(now);
      else room.toIdle();
    }
    return room;
  }
}

/** RaceRoom.snapshot の中身 (JSON にできる) */
export interface RoomSnapshot {
  v: 1;
  laps: number;
  phase: PhaseInfo["phase"];
  endsAt: number;
  /** 待合を伸ばせる一番遅い時刻 (待合のときだけ) */
  lobbyCapAt?: number;
  lightsStartAt: number;
  lightsOutAt: number;
  chequeredAt: number;
  trackId: string;
  trackTurn: number;
  results: ResultRow[] | undefined;
  nextId: number;
  weather: WeatherPlan | null;
  /** 大会の組 (顔ぶれの決まった部屋) */
  fixed?: FixedField;
  /** 開いた部屋 */
  custom?: CustomRoomConfig;
  entrants: Array<{ id: string; key: string; name: string; design: CarDesign; bot: boolean; connected: boolean; waiting: boolean; color: string; slot: number; team?: JoinTeam }>;
}

const SECTOR_NAME = (k: number) => `区間 ${k + 1}`;

/** 人の画面が言ってきた一番速い周を入れる。速くなったら、それを聞いた時刻 (スタートからの秒) を出した時刻にする */
function noteBest(lap: LapState, best: number | null, t: number) {
  if (best !== null && Number.isFinite(best) && (lap.bestLap === null || best < lap.bestLap - 1e-6)) lap.bestAt = t;
  lap.bestLap = best;
}

function cleanName(name: string): string {
  const s = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 12);
  return s || "名無し";
}

function shuffle<T>(a: T[], rand: () => number) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
