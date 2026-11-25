// ピット: 「次の周で入る」を予約 (car.pitOrder) すると、入り口の線を越えたときに自動で入る。
// ピットの道は制限速度で自動で走り、止まる場所でタイヤ・燃料・修理を同時にして (一番長いものの時間だけ止まる)、
// 出口まで走ってコースに戻る。止まっている間に内容を変えられる (時間は計算し直す)。
// 持っているタイヤの組 (car.sets、tireset.ts) があれば、その中からしか替えられない。外したタイヤは使った組に戻る。
// 予約は入り口の線までなら取り消せる。ピットの道では燃料は減らず、ほかの車とぶつからない。
// ピットの道の中でも道のり (dist) は増えるので、周はふつうに数えられる。
// チームの 2 台 (11/25 決まり「2 台同じ周なら後が待つ」): 相方が止まる場所で作業中なら、あとから来た車は
// 止まる場所の手前 (PIT_QUEUE_GAP) で待ち、相方の作業が終わってから止まる場所に入る。同じ刻みに着いたら先に計算した車が先。
import { damageCount, repairAll } from "./damage.ts";
import type { CarStats } from "./design.ts";
import type { CarState, StepEvents } from "./physics.ts";
import { TIRE_DEFS, type TireCompound } from "./tires.ts";
import { canTake, swapSet } from "./tireset.ts";
import { pointAt, queryTrack, type PitLane, type Track } from "./track.ts";

/** ピットの道の制限速度 (m/s、仮) */
export const PIT_SPEED = 16;
/** ピットの道での減速と加速 (m/s²、仮) */
const PIT_DECEL = 14;
const PIT_ACCEL = 8;
/** タイヤ交換: もとの時間 + タイヤ部品 1 つごとの時間 (秒、仮) */
export const PIT_TIRE_BASE = 1.5;
export const PIT_TIRE_PER = 0.6;
/** 燃料: 1 L 入れる時間 (秒、仮) */
export const PIT_FUEL_PER_L = 0.2;
/** 修理: もとの時間 + 傷んだ部品 1 つごとの時間 + 落ちた部品を付け直す時間 (秒、仮) */
export const PIT_REPAIR_BASE = 1;
export const PIT_REPAIR_PER = 1.5;
export const PIT_REPAIR_LOST = 2.5;
/** 相方の作業を待つ車が止まる、止まる場所の手前の長さ (m、仮) */
export const PIT_QUEUE_GAP = 8;

export interface PitOrder {
  /** 替えるタイヤ (なし = 替えない) */
  tire?: TireCompound | null;
  /** 持っている組 (car.sets) のうち、使った組の番号 (なし = 新品。新品がなければ一番減っていない使った組) */
  used?: number | null;
  /** 燃料をこの量 (L) まで入れる (なし = 入れない。今より少なければ入れない) */
  fuelTo?: number | null;
  /** 傷を直す (傷んだ部品の数で時間が決まる。傷がなければ 0 秒) */
  repair?: boolean;
}

export interface PitRun {
  /** in = 止まる場所へ・box = 止まって作業中・out = 出口へ */
  phase: "in" | "box" | "out";
  /** ピットの道の上の位置 (スタートの線を 0 とした距離 m) */
  u: number;
  /** 速さ (m/s) */
  v: number;
  /** 入り口を越えたときの横のずれ (ここから道に移る) */
  d0: number;
  /** 道のり dist = base + u */
  base: number;
  /** 止まってからの秒 */
  elapsed: number;
  /** 作業にかかる秒 (内容を変えると計算し直す) */
  service: number;
  /** 相方の作業を待った秒 (待っていなければ なし) */
  waited?: number;
}

/** ピットの予約をする (止まっている間なら作業の内容を変える) */
export function requestPit(car: CarState, order: PitOrder): void {
  car.pitOrder = { tire: order.tire ?? null, fuelTo: order.fuelTo ?? null, repair: !!order.repair };
  if (order.used !== undefined && order.used !== null) car.pitOrder.used = order.used;
}

/** 予約を取り消す。入り口の線を越えたあとは取り消せない (false) */
export function cancelPit(car: CarState): boolean {
  if (car.pit) return false;
  car.pitOrder = null;
  return true;
}

export function inPit(car: CarState): boolean {
  return !!car.pit;
}

/** 止まる場所で作業中か (チームの相方は、この間 止まる場所に入れない) */
export function inService(car: CarState | null | undefined): boolean {
  return car?.pit?.phase === "box";
}

/** 入る燃料の量 (L) */
export function fuelToAdd(car: CarState, stats: CarStats, order: PitOrder | null | undefined): number {
  if (!order || order.fuelTo === null || order.fuelTo === undefined || !Number.isFinite(order.fuelTo)) return 0;
  return Math.max(0, Math.min(stats.fuelCap, order.fuelTo) - car.fuel);
}

/** 作業にかかる秒 = タイヤ・燃料・修理のうち一番長いもの */
export function serviceTime(car: CarState, stats: CarStats, order: PitOrder | null | undefined): number {
  if (!order) return 0;
  const tire = tireChangeable(car, order) ? PIT_TIRE_BASE + PIT_TIRE_PER * Math.max(1, stats.tireCount ?? 4) : 0;
  const fuel = fuelToAdd(car, stats, order) * PIT_FUEL_PER_L;
  const repair = order.repair ? repairTime(car) : 0;
  // 整備の組の腕 (なし = 1)
  const f = car.serviceFactor !== undefined && Number.isFinite(car.serviceFactor) ? car.serviceFactor : 1;
  return Math.max(tire, fuel, repair) * f;
}

/** 予約のタイヤに替えられるか (持っている組の決まりがあれば、その組を持っているか) */
export function tireChangeable(car: CarState, order: PitOrder | null | undefined): boolean {
  if (!order?.tire || !(order.tire in TIRE_DEFS)) return false;
  return !car.sets || canTake(car.sets, { tire: order.tire, used: order.used });
}

/** 修理にかかる秒 (傷がなければ 0) */
export function repairTime(car: CarState): number {
  const n = damageCount(car);
  if (n.damaged === 0) return 0;
  return PIT_REPAIR_BASE + PIT_REPAIR_PER * n.damaged + PIT_REPAIR_LOST * n.lost;
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const smoothD = (x: number) => (x <= 0 || x >= 1 ? 0 : 6 * x * (1 - x));

/** ピットの道の上の横のずれと、その傾き (d の u による変わり方) */
export function pitLaneOffset(lane: PitLane, u: number, d0: number = lane.laneD): { d: number; slope: number } {
  const a = (u - lane.entry) / lane.inLen;
  if (a < 1) return { d: d0 + (lane.laneD - d0) * smooth(a), slope: ((lane.laneD - d0) * smoothD(a)) / lane.inLen };
  const b = (u - (lane.exit - lane.outLen)) / lane.outLen;
  if (b > 0) return { d: lane.laneD + (lane.outD - lane.laneD) * smooth(b), slope: ((lane.outD - lane.laneD) * smoothD(b)) / lane.outLen };
  return { d: lane.laneD, slope: 0 };
}

/** ピットの道を描くための点 (入り口から出口まで、約 step m ごと)。d0 は入り口で道のどこにいるか */
export function pitLanePath(track: Track, step = 4, d0 = 0): Array<{ x: number; y: number }> {
  const lane = track.pit;
  const out: Array<{ x: number; y: number }> = [];
  for (let u = lane.entry; u <= lane.exit + 1e-6; u += step) {
    const p = pointAt(track, u, pitLaneOffset(lane, u, d0).d);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** 止まる場所の位置と向き */
export function pitBoxPoint(track: Track): { x: number; y: number; heading: number } {
  const p = pointAt(track, track.pit.box, track.pit.laneD);
  return { x: p.x, y: p.y, heading: p.heading };
}

/** 入り口の線を越えたか (道のり prev → now)。越えたらピットに入る */
export function crossesPitEntry(track: Track, prev: number, now: number): boolean {
  const L = track.length;
  const e = track.pit.entry;
  return Math.floor((prev - e) / L) < Math.floor((now - e) / L);
}

/** ピットに入る (stepCar から呼ぶ) */
export function enterPit(car: CarState, track: Track, dOnTrack: number): void {
  const L = track.length;
  const lane = track.pit;
  const n = Math.floor((car.dist - lane.entry) / L);
  const base = n * L;
  const u = Math.min(lane.box, car.dist - base);
  const lim = track.def.halfWidth + track.def.runoff - 1;
  car.pit = {
    phase: "in",
    u,
    v: Math.hypot(car.vx, car.vy),
    d0: Math.max(-lim, Math.min(lim, dOnTrack)),
    base,
    elapsed: 0,
    service: 0,
  };
}

/** 作業が終わったときに、予約の中身を車に入れる */
function applyOrder(car: CarState, stats: CarStats, order: PitOrder | null | undefined) {
  if (!order) return;
  if (order.tire && order.tire in TIRE_DEFS) {
    if (car.sets) {
      // 持っている組から履き、外したタイヤは使った組に戻す。その組がなければ替えない
      const sw = swapSet(car.sets, car, { tire: order.tire, used: order.used });
      if (sw) {
        car.sets = sw.sets;
        car.tire = sw.fitted.tire;
        car.wear = sw.fitted.wear;
        car.burst = false;
      }
    } else {
      car.tire = order.tire;
      car.wear = 0;
      car.burst = false;
    }
  }
  car.fuel += fuelToAdd(car, stats, order);
  if (order.repair) repairAll(car, stats);
}

/**
 * ピットの道の中の 1 刻み (自動で走る)。
 * boxBusy = チームの相方が止まる場所で作業中 (inService)。そのあいだは止まる場所の手前で待つ (もう手前を過ぎていたら止まる場所で待つ)
 */
export function stepPit(car: CarState, stats: CarStats, track: Track, dt: number, boxBusy = false): StepEvents {
  const run = car.pit!;
  const lane = track.pit;
  if (run.phase === "in") {
    const stop = boxBusy && run.u < lane.box - PIT_QUEUE_GAP ? lane.box - PIT_QUEUE_GAP : lane.box;
    const toBox = Math.max(0, stop - run.u);
    const target = Math.min(PIT_SPEED, Math.sqrt(2 * PIT_DECEL * toBox));
    run.v = run.v > target ? Math.max(target, run.v - PIT_DECEL * dt) : Math.min(target, run.v + PIT_ACCEL * dt);
    // 止まる直前で動けなくならないように、少しは進む
    const move = Math.max(run.v, Math.min(1.5, toBox / dt)) * dt;
    run.u = Math.min(stop, run.u + move);
    if (run.u >= stop - 1e-6) {
      run.u = stop;
      run.v = 0;
      if (boxBusy) {
        run.waited = (run.waited ?? 0) + dt;
      } else {
        run.phase = "box";
        run.elapsed = 0;
      }
    }
  } else if (run.phase === "box") {
    run.v = 0;
    run.elapsed += dt;
    run.service = serviceTime(car, stats, car.pitOrder);
    if (run.elapsed >= run.service) {
      applyOrder(car, stats, car.pitOrder);
      car.pitOrder = null;
      run.phase = "out";
    }
  } else {
    run.v = Math.min(PIT_SPEED, run.v + PIT_ACCEL * dt);
    run.u += run.v * dt;
  }

  const off = pitLaneOffset(lane, run.u, run.d0);
  const p = pointAt(track, run.u, off.d);
  const heading = p.heading + Math.atan(off.slope);
  car.heading = heading > Math.PI ? heading - 2 * Math.PI : heading < -Math.PI ? heading + 2 * Math.PI : heading;
  car.x = p.x;
  car.y = p.y;
  car.vx = Math.cos(car.heading) * run.v;
  car.vy = Math.sin(car.heading) * run.v;
  car.slip = 0;
  car.surface = "asphalt";
  car.dist = run.base + run.u;
  const L = track.length;
  car.lastS = ((run.u % L) + L) % L;
  car.hint = p.index;

  if (run.phase === "out" && run.u >= lane.exit) {
    // コースに戻る: ここからふつうの動き
    car.pit = null;
    const q = queryTrack(track, car.x, car.y, p.index);
    car.hint = q.index;
    car.lastS = q.s;
    car.dist = run.base + lane.exit + (((q.s - lane.exit) % L) + L + L / 2) % L - L / 2;
  }
  return { wall: 0, cut: 0 };
}
