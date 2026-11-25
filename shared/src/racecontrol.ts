// レースの取り締まり: 旗・VSC・先導車 (SC) (DECISIONS「レースの進み方」)。部屋 (room.ts) が毎刻み動かす。決まった計算。
//   黄旗: 強く当たった車・止まった車のいる区間。その区間は追い越し禁止 (抜くと罰の秒)
//   VSC: 軽いとき (止まった車がいる・燃料切れ)。全員が同じ速さの上限で走る (差はそのまま)。自分で運転、追い越し禁止
//   SC: 重いとき (大雨に変わった・部品が落ちた)。一列に並んで自動で走る。差が詰まると SC が入り、先頭がスタートの線を越えたら再開
// 人の車は人の画面が動かす: VSC は flagSpeedCap を stepCar の env.speedCap に、SC は flagInput の入力で自動で走る。
// 数は全部 (仮)。
import { allowedSpeed } from "./bot.ts";
import type { Body } from "./collide.ts";
import { damageEffect } from "./damage.ts";
import type { CarStats } from "./design.ts";
import { racingLine, trackIndex } from "./line.ts";
import type { CarInput, CarState } from "./physics.ts";
import { OT_AFTER_GREEN } from "./overtake.ts";
import { crossesPitEntry } from "./pit.ts";
import { tireGrip } from "./tires.ts";
import { pointAt, type Track } from "./track.ts";
import type { Sky } from "./weather.ts";

export type FlagMode = "green" | "vsc" | "sc";

/** 黄旗の区間の数 (コースを同じ長さに分ける) */
export const FLAG_SECTORS = 10;
/** 黄旗が出ている秒 (強く当たったとき) */
export const YELLOW_TIME = 12;
/** 黄旗・VSC の間に抜いたときの罰 (秒) */
export const YELLOW_PENALTY = 5;
/** VSC の長さ (秒) と、終わりの合図を出す時間 (終わる何秒前か) */
export const VSC_TIME = 22;
export const VSC_ENDING = 6;
/** VSC の速さの上限 (m/s) */
export const VSC_SPEED = 20;
/** SC: 先導車の一番速い速さ・後ろの車の追いつく速さの上限・車どうしの間 (m)・出る位置 (先頭の何 m 前) */
export const SC_SPEED = 24;
export const SC_CATCHUP = 34;
export const SC_GAP = 12;
export const SC_LEAD = 70;
/** SC: 少なくともこの秒は出ている。差が詰まらなくても この秒で入る */
export const SC_MIN_TIME = 25;
export const SC_MAX_TIME = 80;
/** 先導車が曲がりで使う横の加速 (m/s²、濡れていると減らす) と、減速・加速 */
const SC_LAT = 6;
const SC_BRAKE = 5;
const SC_ACCEL = 3.5;
/** 止まったとみなす速さ (m/s) と時間 (秒) */
export const STOP_SPEED = 1;
export const STOP_TIME = 3;
/** 再開してから DRS が使えるまでの秒 */
export const DRS_AFTER_GREEN = 15;

export interface YellowFlag {
  sector: number;
  /** この時刻 (レースの秒) まで。止まった車のぶんは Infinity (その車がいる間) */
  until: number;
  /** 止まった車の id (その車が動いたら消える) */
  car?: string;
}

export interface SafetyCar {
  /** 道のり (車の dist と同じ数え方) と速さ */
  dist: number;
  v: number;
}

export interface RaceControl {
  /** 信号が消えてからの秒 */
  t: number;
  mode: FlagMode;
  since: number;
  /** VSC が終わる時刻 */
  until: number;
  /** 終わりかけ (VSC が明ける・SC がこの周で入る) */
  ending: boolean;
  /** 先導車 (SC の間。入ったら null) */
  sc: SafetyCar | null;
  yellows: YellowFlag[];
  /** 今の旗のわけ (画面用) */
  reason: string;
  /** 黄旗・VSC の間に抜いた罰の合計 (秒、id ごと) */
  pen: Record<string, number>;
  /** 最後に緑になった時刻 */
  greenSince: number;
  /** DRS を使ってよいか */
  drs: boolean;
  /** オーバーテイクモードを使ってよいか (DRS と同じだが雨でも使える。11/25 足した) */
  ot?: boolean;
  /** 覚えておくこと: 前の刻みの道のり・止まっている秒・数えた当たりと落ちた部品・旗を出した止まった車・空 */
  prev: Record<string, number>;
  stopped: Record<string, number>;
  hits: Record<string, number>;
  lost: Record<string, number>;
  flagged: Record<string, true>;
  sky: Sky | null;
}

/** 取り締まりが見る 1 台 */
export interface RcCar {
  id: string;
  dist: number;
  speed: number;
  lapsDone: number;
  started: boolean;
  /** ピットの道の中 */
  pit: boolean;
  finished: boolean;
  retired: boolean;
  /** 強く当たった回数 (CarDamage.hits) と 落ちた部品の数 */
  hits: number;
  lost: number;
  /** タイヤが破れている・壊れた部品 (落ちたものも入る) の数 (黄旗の間に抜いてよい車。なし = 分からない) */
  burst?: boolean;
  broken?: number;
}

/** 黄旗・VSC の間でも抜いてよい速さの割合: 抜かれる車が抜く車のこれより遅い (仮) */
export const CRIPPLED_PACE = 0.5;

/**
 * 黄旗・VSC の間に a が b を抜いても罰にしない車か。止まりかけ・タイヤが破れた・部品が壊れたか落ちた・
 * ピットの道の中・抜く車よりずっと遅い (CRIPPLED_PACE より下) 車は、よけて抜いてよい
 */
export function passExempt(a: Pick<RcCar, "speed">, b: Pick<RcCar, "speed" | "pit" | "burst" | "broken" | "lost">): boolean {
  if (b.speed < 5 || b.pit || b.burst || (b.broken ?? 0) > 0 || b.lost > 0) return true;
  return b.speed < a.speed * CRIPPLED_PACE;
}

export interface RcEnv {
  /** 今の空と路面の濡れ具合 */
  sky?: Sky;
  wet?: number;
  /** 先頭がゴールした (新しい SC・VSC は出さない) */
  chequered?: boolean;
}

export type RcEvent =
  | { kind: "sc"; reason: string }
  | { kind: "vsc"; reason: string }
  | { kind: "ending"; mode: FlagMode }
  | { kind: "green" }
  | { kind: "yellow"; sector: number; reason: string }
  | { kind: "penalty"; id: string; passed: string; seconds: number };

export function newRaceControl(sky: Sky | null = null): RaceControl {
  return {
    t: 0,
    mode: "green",
    since: 0,
    until: 0,
    ending: false,
    sc: null,
    yellows: [],
    reason: "",
    pen: {},
    greenSince: 0,
    drs: false,
    prev: {},
    stopped: {},
    hits: {},
    lost: {},
    flagged: {},
    sky,
  };
}

const mod = (v: number, L: number) => ((v % L) + L) % L;

/** コースの位置 s の区間の番号 */
export function sectorOf(track: Track, s: number): number {
  return Math.min(FLAG_SECTORS - 1, Math.floor((mod(s, track.length) / track.length) * FLAG_SECTORS));
}

/** 黄旗の区間か */
export function isYellow(rc: Pick<RaceControl, "yellows">, track: Track, s: number): boolean {
  const k = sectorOf(track, s);
  return rc.yellows.some((y) => y.sector === k);
}

/** その位置で追い越してよいか (黄旗の区間・VSC・SC の間は禁止) */
export function overtakeAllowed(rc: Pick<RaceControl, "mode" | "yellows">, track: Track, s: number): boolean {
  return rc.mode === "green" && !isYellow(rc, track, s);
}

/** 走っている車を、並ぶ順 (道のりの多い順) に。ピット・ゴール・リタイアは除く */
export function scOrder(cars: readonly RcCar[]): RcCar[] {
  return cars.filter((c) => !c.pit && !c.finished && !c.retired).sort((a, b) => b.dist - a.dist || (a.id < b.id ? -1 : 1));
}

function addYellow(rc: RaceControl, track: Track, s: number, until: number, car?: string): number {
  const sector = sectorOf(track, s);
  const y = rc.yellows.find((x) => x.sector === sector && x.car === car);
  if (y) y.until = Math.max(y.until, until);
  else rc.yellows.push({ sector, until, car });
  return sector;
}

function startVsc(rc: RaceControl, reason: string, ev: RcEvent[]) {
  if (rc.mode === "sc") return;
  if (rc.mode === "vsc") {
    rc.until = Math.max(rc.until, rc.t + VSC_TIME);
    rc.ending = false;
    return;
  }
  rc.mode = "vsc";
  rc.since = rc.t;
  rc.until = rc.t + VSC_TIME;
  rc.ending = false;
  rc.reason = reason;
  ev.push({ kind: "vsc", reason });
}

function startSc(rc: RaceControl, cars: readonly RcCar[], reason: string, ev: RcEvent[]) {
  if (rc.mode === "sc") {
    // 出ている間にまた何か起きたら、もう少し出しておく
    rc.since = Math.max(rc.since, rc.t - SC_MIN_TIME / 2);
    rc.ending = false;
    if (!rc.sc) {
      const lead = scOrder(cars)[0];
      if (lead) rc.sc = { dist: lead.dist + SC_LEAD, v: Math.min(SC_SPEED, lead.speed) };
    }
    return;
  }
  const lead = scOrder(cars)[0];
  rc.mode = "sc";
  rc.since = rc.t;
  rc.until = 0;
  rc.ending = false;
  rc.reason = reason;
  rc.sc = lead ? { dist: lead.dist + SC_LEAD, v: Math.min(SC_SPEED, Math.max(10, lead.speed)) } : null;
  ev.push({ kind: "sc", reason });
}

function goGreen(rc: RaceControl, ev: RcEvent[]) {
  rc.mode = "green";
  rc.ending = false;
  rc.sc = null;
  rc.reason = "";
  rc.greenSince = rc.t;
  ev.push({ kind: "green" });
}

/** 先導車がその位置で出してよい速さ (m/s) */
export function scSpeedAt(track: Track, s: number, wet = 0): number {
  const line = racingLine(track);
  const lat = SC_LAT * (1 - 0.45 * Math.max(0, Math.min(1, wet)));
  let v = SC_SPEED;
  for (let x = 0; x <= 120; x += 3) {
    const k = Math.abs(line.curv[trackIndex(track, s + x)]);
    if (k < 1e-4) continue;
    const vc = Math.sqrt(lat / k);
    const w = Math.sqrt(vc * vc + 2 * SC_BRAKE * x);
    if (w < v) v = w;
  }
  return v;
}

/**
 * 1 刻み進める。cars = レースに出ている全部の車 (ゴール・リタイアも入れてよい)。
 * 起きたこと (旗が出た・罰など) を返す
 */
export function stepRaceControl(rc: RaceControl, track: Track, cars: readonly RcCar[], dt: number, env: RcEnv = {}): RcEvent[] {
  const ev: RcEvent[] = [];
  const L = track.length;
  rc.t += dt;
  const t = rc.t;
  const calm = !!env.chequered;

  // 大雨に変わった
  if (env.sky) {
    if (rc.sky !== null && env.sky === "heavy" && rc.sky !== "heavy" && !calm) startSc(rc, cars, "大雨", ev);
    rc.sky = env.sky;
  }

  for (const c of cars) {
    const hits0 = rc.hits[c.id] ?? 0;
    const lost0 = rc.lost[c.id] ?? 0;
    rc.hits[c.id] = c.hits;
    rc.lost[c.id] = c.lost;
    if (c.finished) continue;
    // 部品が落ちた → SC
    if (c.lost > lost0) {
      const sector = addYellow(rc, track, c.dist, t + YELLOW_TIME);
      ev.push({ kind: "yellow", sector, reason: "部品が落ちた" });
      if (!calm) startSc(rc, cars, "部品が落ちた", ev);
    } else if (c.hits > hits0) {
      // 強く当たった → 黄旗
      const sector = addYellow(rc, track, c.dist, t + YELLOW_TIME);
      ev.push({ kind: "yellow", sector, reason: "強く当たった車" });
    }
    // 止まった車 (コースの上、スタートの線を越えたあと) → 黄旗 + VSC
    const still = c.started && !c.pit && c.dist > 0 && c.speed < STOP_SPEED && t > 5;
    if (still) rc.stopped[c.id] = (rc.stopped[c.id] ?? 0) + dt;
    else {
      rc.stopped[c.id] = 0;
      // 動き出したら、その車の黄旗は消す
      if (!c.retired) rc.yellows = rc.yellows.filter((y) => y.car !== c.id);
    }
    if ((rc.stopped[c.id] ?? 0) >= STOP_TIME && !rc.flagged[c.id]) {
      rc.flagged[c.id] = true;
      const sector = addYellow(rc, track, c.dist, Infinity, c.id);
      ev.push({ kind: "yellow", sector, reason: c.retired ? "止まった車 (リタイア)" : "止まった車" });
      if (!calm) startVsc(rc, c.retired ? "止まった車 (リタイア)" : "止まった車", ev);
    }
    if (rc.flagged[c.id] && !still && !c.retired) delete rc.flagged[c.id];
  }
  // リタイアして止まった車の黄旗は、VSC・SC が終わるまで
  rc.yellows = rc.yellows.filter((y) => (y.car ? rc.mode !== "green" || t - rc.greenSince < 1 : y.until > t));

  // 黄旗・VSC の間に抜いた車に罰 (止まりかけ・傷んだ・ずっと遅い車・ピットの車を抜くのはよい (passExempt)。SC の間は自動で走るので数えない)
  const live = cars.filter((c) => !c.pit && !c.finished && !c.retired);
  if (rc.mode !== "sc") {
    for (const a of live) {
      const pa = rc.prev[a.id];
      if (pa === undefined) continue;
      for (const b of live) {
        if (a === b || passExempt(a, b)) continue;
        const pb = rc.prev[b.id];
        if (pb === undefined) continue;
        const before = mod(pa - pb + L / 2, L) - L / 2;
        const now = mod(a.dist - b.dist + L / 2, L) - L / 2;
        if (before < 0 && now >= 0 && Math.abs(now) < 30 && Math.abs(before) < 30) {
          if (rc.mode === "vsc" || isYellow(rc, track, a.dist)) {
            rc.pen[a.id] = (rc.pen[a.id] ?? 0) + YELLOW_PENALTY;
            ev.push({ kind: "penalty", id: a.id, passed: b.id, seconds: YELLOW_PENALTY });
          }
        }
      }
    }
  }
  const prevDist = rc.prev;
  rc.prev = {};
  for (const c of live) rc.prev[c.id] = c.dist;

  // VSC
  if (rc.mode === "vsc") {
    if (!rc.ending && t >= rc.until - VSC_ENDING) {
      rc.ending = true;
      ev.push({ kind: "ending", mode: "vsc" });
    }
    if (t >= rc.until) goGreen(rc, ev);
  }

  // SC
  if (rc.mode === "sc") {
    const order = scOrder(cars);
    const sc = rc.sc;
    if (sc) {
      const target = scSpeedAt(track, sc.dist, env.wet ?? 0);
      // 先頭が遠いときは待つ (先頭が SC_LEAD × 2 より離れたら ゆっくり)
      const lead = order[0];
      const wait = lead && sc.dist - lead.dist > SC_LEAD * 2 ? 0.5 : 1;
      const want = target * wait;
      sc.v = sc.v > want ? Math.max(want, sc.v - SC_BRAKE * dt) : Math.min(want, sc.v + SC_ACCEL * dt);
      const before = sc.dist;
      sc.dist += sc.v * dt;
      if (!rc.ending) {
        // 差が詰まった (全員が前の車から SC_GAP × 2.5 以内) か、長く出たら、この周で入る
        let bunched = order.length > 0 && sc.dist - order[0].dist < SC_LEAD * 1.6;
        for (let i = 1; i < order.length && bunched; i++) if (order[i - 1].dist - order[i].dist > SC_GAP * 2.5) bunched = false;
        if (t - rc.since >= SC_MAX_TIME || (t - rc.since >= SC_MIN_TIME && bunched)) {
          rc.ending = true;
          ev.push({ kind: "ending", mode: "sc" });
        }
      } else if (crossesPitEntry(track, before, sc.dist)) {
        // 先導車がピットに入る。先頭がスタートの線を越えたら再開
        rc.sc = null;
      }
    } else if (rc.ending) {
      // 先導車が入ったあと: 先頭がスタートの線を越えたら再開 (先頭の合図)
      const lead = order[0];
      const p = lead ? prevDist[lead.id] : undefined;
      if (!lead) goGreen(rc, ev);
      else if (p !== undefined && Math.floor(p / L) < Math.floor(lead.dist / L)) goGreen(rc, ev);
    } else {
      // 出したときに走っている車がいなかった
      const lead = order[0];
      if (lead) rc.sc = { dist: lead.dist + SC_LEAD, v: Math.min(SC_SPEED, Math.max(10, lead.speed)) };
    }
  }

  // DRS: 緑で、再開から少したって、先頭が 1 周を終え、乾いているとき
  const lead = scOrder(cars)[0];
  rc.drs = rc.mode === "green" && t - rc.greenSince >= DRS_AFTER_GREEN && !!lead && lead.lapsDone >= 1 && (env.wet ?? 0) < 0.3;
  // オーバーテイクモード: DRS と同じだが雨でも使える
  rc.ot = rc.mode === "green" && t - rc.greenSince >= OT_AFTER_GREEN && !!lead && lead.lapsDone >= 1;
  return ev;
}

// ---- 画面とのやりとり ----

/** 画面に送る旗の様子 (snap に付ける) */
export interface FlagInfo {
  mode: FlagMode;
  /** 終わりかけ (VSC が明ける・SC がこの周で入る) */
  ending: boolean;
  /** 速さの上限 (m/s)。VSC と SC の間だけ */
  cap?: number;
  /** 先導車 (SC の間。入ったあとは なし) */
  sc?: SafetyCar;
  /** SC の間に並ぶ順 (id、前から) */
  order?: string[];
  /** 黄旗の区間の番号 (0 .. sectors-1) と区間の数 */
  yellow: number[];
  sectors: number;
  /** DRS を使ってよいか */
  drs: boolean;
  /** オーバーテイクモードを使ってよいか (11/25 足した。前のサーバーからは来ない = 使えない) */
  ot?: boolean;
  /** 旗のわけ */
  reason?: string;
  /** 黄旗・VSC の間に抜いた罰 (秒、id ごと。罰のある車だけ) */
  pen?: Record<string, number>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function flagInfo(rc: RaceControl, cars: readonly RcCar[]): FlagInfo {
  const info: FlagInfo = {
    mode: rc.mode,
    ending: rc.ending,
    yellow: [...new Set(rc.yellows.map((y) => y.sector))].sort((a, b) => a - b),
    sectors: FLAG_SECTORS,
    drs: rc.drs,
  };
  if (rc.ot) info.ot = true;
  const cap = flagSpeedCap(info);
  if (cap !== undefined) info.cap = cap;
  if (rc.mode === "sc") {
    if (rc.sc) info.sc = { dist: r2(rc.sc.dist), v: r2(rc.sc.v) };
    info.order = scOrder(cars).map((c) => c.id);
  }
  if (rc.reason) info.reason = rc.reason;
  if (Object.keys(rc.pen).length) info.pen = { ...rc.pen };
  return info;
}

/** stepCar の env.speedCap に入れる速さの上限 (なければ undefined) */
export function flagSpeedCap(info: Pick<FlagInfo, "mode"> | null | undefined): number | undefined {
  if (!info) return undefined;
  if (info.mode === "vsc") return VSC_SPEED;
  if (info.mode === "sc") return SC_CATCHUP;
  return undefined;
}

/** 追いかける相手 (SC の間): 道のりと速さ。なし = 先導車が入ったあとの先頭 (SC_SPEED で走る) */
export interface FollowTarget {
  dist: number;
  v: number;
}

/**
 * SC の間に、id の車が追いかける相手。order の前の車か先導車。
 * cars = 道のりと速さを引ける表 (画面ではスナップの車、部屋では全部の車)
 */
export function scTarget(info: Pick<FlagInfo, "mode" | "order" | "sc">, id: string, cars: ReadonlyMap<string, FollowTarget>): FollowTarget | null {
  if (info.mode !== "sc") return null;
  const order = info.order ?? [];
  const i = order.indexOf(id);
  if (i > 0) {
    const o = cars.get(order[i - 1]);
    if (o) return o;
  }
  return info.sc ? { dist: info.sc.dist, v: info.sc.v } : null;
}

/**
 * SC の間の自動の運転: 走る線を通り、前の車 (target) から SC_GAP の間をあけてついていく。
 * target なし = 先導車が入ったあとの先頭 (SC_SPEED まで)。
 * others を渡すと、すぐ前にいる車 (周回遅れなど並ぶ順と違う車) にもぶつからないよう合わせる
 */
export function scFollowInput(
  car: CarState,
  stats: CarStats,
  track: Track,
  target: FollowTarget | null,
  wetness = 0,
  others: readonly Body[] = [],
): CarInput {
  const speed = Math.hypot(car.vx, car.vy);
  const s = car.lastS;
  const line = racingLine(track);
  const look = 6 + speed * 0.45;
  const hw = track.def.halfWidth;
  const lateral = Math.max(-(hw - 1.6), Math.min(hw - 1.6, line.d[trackIndex(track, s + look)] * 0.85));
  const p = pointAt(track, s + look, lateral);
  let diff = Math.atan2(p.y - car.y, p.x - car.x) - car.heading;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const steer = Math.max(-1, Math.min(1, diff * 2.6));
  let want: number;
  if (target) {
    const gap = target.dist - car.dist - SC_GAP;
    want = Math.max(0, Math.min(SC_CATCHUP, target.v + Math.max(-12, Math.min(SC_CATCHUP, gap * 0.5))));
  } else {
    want = SC_SPEED;
  }
  const grip = tireGrip(car, wetness) * damageEffect(car, stats).grip;
  want = Math.min(want, allowedSpeed(car, stats, track, s, 0.85, grip));
  const fx = Math.cos(car.heading);
  const fy = Math.sin(car.heading);
  for (const o of others) {
    const dx = o.x - car.x;
    const dy = o.y - car.y;
    const f = dx * fx + dy * fy;
    const l = -dx * fy + dy * fx;
    if (f <= 0 || f > 6 + speed * 0.8 || Math.abs(l) > (stats.width + o.width) / 2 + 0.6) continue;
    const room = f - (stats.length + o.length) / 2 - 3;
    want = Math.min(want, Math.max(0, o.vx * fx + o.vy * fy + Math.max(0, room) * 0.4));
  }
  let throttle = 1;
  let brake = 0;
  if (speed > want + 0.3) {
    throttle = 0;
    brake = Math.min(1, (speed - want) / 1.5);
  } else if (speed > want - 1) {
    throttle = 0.3;
  }
  return { steer: Math.abs(steer) < 0.03 ? 0 : steer, throttle, brake };
}

/**
 * 画面用のまとめ: SC の間なら自動の運転の入力を返す (人の入力の代わりに使う)。それ以外は null。
 * others = ほかの車の道のりと速さ (スナップから)
 */
export function flagInput(
  info: FlagInfo | null | undefined,
  myId: string,
  car: CarState,
  stats: CarStats,
  track: Track,
  others: ReadonlyMap<string, FollowTarget>,
  wetness = 0,
  /** ほかの車の体 (ぶつからないように。なくてもよい) */
  bodies: readonly Body[] = [],
): CarInput | null {
  if (!info || info.mode !== "sc" || car.pit) return null;
  return scFollowInput(car, stats, track, scTarget(info, myId, others), wetness, bodies);
}
