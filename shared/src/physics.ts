// 車の動き (1 刻み = 1/60 秒)。入力は ハンドル・アクセル・ブレーキ (11/25 ユーザー「減速加速を付けよう」)。
// ブレーキの強さはブレーキ部品で決まる。握りを超えると滑る。
// かんたん操作 (assist) では、アクセルは自動で、曲がりで握りが足りないときに自動でブレーキ (はじめの版の操作)。
// タイヤ (tires.ts) はすり減り、路面の濡れ具合 (weather.ts) で握りが変わる。ピット (pit.ts) の道の中は自動で走る。
// タイヤの部品の特徴 (tires.ts の TireMods) が 握り・横と縦の握り・すり減り・縁石・水たまり・破裂に効く。
// 壁に強く当たると部品が傷む (damage.ts)。DRS と風よけ (drs.ts) で空気の抵抗が減る。VSC・先導車の間は速さの上限 (racecontrol.ts)。
// オーバーテイクモード (overtake.ts) で力が増える。マニュアル (gearbox.ts、CarInput.gear) では段と回転で力が変わり、速さが少し上がる。
import { allowedSpeed } from "./bot.ts";
import { applyImpact, damageEffect, isWrecked, WALL_DAMAGE_MIN, type CarDamage, type DamageEvent } from "./damage.ts";
import { FUEL_KG, type CarStats } from "./design.ts";
import { drsDragFactor, TOW_DRAG, type DrsState } from "./drs.ts";
import { gearPowerFactor, manualShiftBonus, rpmFraction } from "./gearbox.ts";
import { OT_FUEL, OT_WEAR, overtakeBoost, type OvertakeState } from "./overtake.ts";
import { crossesPitEntry, enterPit, stepPit, type PitOrder, type PitRun } from "./pit.ts";
import { BURST_MAX_SPEED, DEFAULT_TIRE, isTireCompound, KERB_WEAR, NO_TIRE_MODS, TIRE_DEFS, tireGrip, WEAR_K, wetWearFactor, type TireCompound, type TireMods } from "./tires.ts";
import { cloneSets, type TireSets } from "./tireset.ts";
import { normalAt, pointAt, queryTrack, surfaceAt, wallDistance, type Surface, type Track } from "./track.ts";
import { racingLine } from "./line.ts";
import { puddleEffect, wetnessAtLateral } from "./weather.ts";

export const DT = 1 / 60;

export interface CarState {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  fuel: number;
  /** コースの点の番号 (探すときの手がかり) */
  hint: number;
  /** スタートの線からの道のりの合計 (m)。周を重ねると増える。スタート前はマイナス */
  dist: number;
  lastS: number;
  /** アクセルが入ったか (スタートの合図のあと) */
  started: boolean;
  /** 今の周が近道で数えられないか */
  lapInvalid: boolean;
  /** 横滑りの大きさ (見た目用) */
  slip: number;
  surface: Surface["kind"];
  /** 今のタイヤの種類 */
  tire: TireCompound;
  /** タイヤのすり減り (0 = 新品、1 = 限界で破裂) */
  wear: number;
  /** タイヤが破裂している */
  burst: boolean;
  /** 「破裂しにくい」タイヤが すり減りの限界を超えてから減った量 (破裂までの残りを数える。なし = 0) */
  overWear?: number;
  /** タイヤの部品の特徴 (createCar が stats.tireMods から入れる。なし = stepCar が入れる) */
  tireMods?: Readonly<TireMods> | null;
  /** ピットの予約 (なし = null) */
  pitOrder?: PitOrder | null;
  /** ピットの道の中にいる間の様子 (なし = null) */
  pit?: PitRun | null;
  /** 部品の傷み (damage.ts。なし = 無傷) */
  damage?: CarDamage | null;
  /** DRS の様子 (drs.ts。なし = 使えない) */
  drs?: DrsState | null;
  /** オーバーテイクモードの様子 (overtake.ts。なし = 使えない) */
  ot?: OvertakeState | null;
  /** 持っているタイヤの組 (tireset.ts。なし = どのタイヤでも履ける。練習と前からの呼び方) */
  sets?: TireSets | null;
  /** ピットで止まる時間の倍率 (整備の組の腕、crew.ts の crewServiceFactor。なし = 1) */
  serviceFactor?: number;
  /** タイヤのすり減りと燃料の使い方の倍率 (雇った運転手の扱いの上手さ、drivers.ts の driverTraits。なし = 1。人の車には付けない) */
  wearScale?: number;
  fuelScale?: number;
  /** 縁石での握りの落ちと余分なすり減りの倍率 (雇った運転手の得意「縁石がうまい」。なし = 1) */
  kerbScale?: number;
  /** 電池の部品で オーバーテイクの目盛りに足す秒 (createCar が stats.otExtra から入れる。なし = 0) */
  otExtra?: number;
}

/** 走る前に決めること: 積む燃料 (L) と最初のタイヤ */
export interface CarSetup {
  fuel?: number;
  tire?: TireCompound;
  /** 最初のタイヤのすり減り (予選で使った組。なし = 新品) */
  wear?: number;
  /** 持っているタイヤの組 (最初のタイヤは入れない。tireset.ts の startFromAlloc)。なし = 決まりなし */
  sets?: TireSets | null;
  /** ピットで止まる時間の倍率 (整備の組の腕。なし = 1) */
  serviceFactor?: number;
  /** タイヤのすり減りと燃料の使い方の倍率 (雇った運転手だけ。なし = 1) */
  wearScale?: number;
  fuelScale?: number;
  /** 縁石の倍率 (雇った運転手の得意。なし = 1) */
  kerbScale?: number;
}

/** 刻みのまわりの様子 */
export interface StepEnv {
  /** 路面の濡れ具合 0..1 (weather.ts の wetnessAt) */
  wetness?: number;
  /** 走る線の上の濡れ具合 (weather.ts の lineWetnessAt)。あれば車の横の位置で混ぜる (線の上は先に乾く)。なし = どこも wetness */
  lineWetness?: number;
  /** 風よけの強さ 0..1 (drs.ts の towFactor) */
  tow?: number;
  /** 速さの上限 (m/s)。VSC・先導車の間 (racecontrol.ts の flagSpeedCap)。超えていたら ゆっくり落とす */
  speedCap?: number;
  /** false なら当たっても傷まない (なし = 傷む) */
  damage?: boolean;
  /** チームの相方が止まる場所で作業中 (pit.ts の inService)。ピットの道では手前で待つ */
  boxBusy?: boolean;
  /** マニュアルの速さの上がり分 (AdminConfig.manualSpeedBonus。なし = はじめの値)。CarInput.gear があるときだけ効く */
  manualBonus?: number;
}

export interface CarInput {
  /** -1 = 左、0 = まっすぐ、1 = 右 (コンピューターは間の数も使う) */
  steer: number;
  /** アクセル 0..1 */
  throttle: number;
  /** ブレーキ 0..1。止まっているときに押し続けると ゆっくり下がる */
  brake: number;
  /** かんたん操作: アクセル自動 + 曲がりで自動ブレーキ */
  assist?: boolean;
  /** オーバーテイクモードのボタンを押している (使えるときだけ効く) */
  overtake?: boolean;
  /** マニュアルの段 (1..7)。なし = オートマ (今までの式) */
  gear?: number;
}

/** 下がるときの速さの上限 (m/s) と加速 */
const REVERSE_MAX = 4;
const REVERSE_ACCEL = 3;
/** アクセルを離したときのエンジンブレーキ (m/s²) */
const ENGINE_BRAKE = 1.2;

// ---- 11/25 試走の直し (数は全部 仮) ----
// 11/25 2 回目「曲がらなさすぎ」: 1 回目の直し (いっぱいまで 0.2 秒・横の力が握りの 1.3 倍まで) が強すぎたので、
// 切れるのを速く・切れ角の上限を遅いほど大きくし、そのかわり「回りすぎ止め」(横滑りの角の上限) で速いときにくるっと回らないようにした。
// 3 回目「もうちょい」: いっぱいに切ったときの回る速さ 1.6 倍 (STEER_GAIN)・上限 3 / 2 倍 → 4.5 / 4.2 倍・回りすぎ止め 8° / 4° → 15° / 6°。
// かんたん操作は少し手前から減速 (ASSIST_MARGIN 0.95 → 0.92。よく回るぶん 外へふくらみやすいので)
/**
 * ハンドルの切れ角の上限: 向きを変える速さを「握りの steerLimit(速さ) 倍の横の力」までに抑える。
 * 遅いとき (STEER_LIMIT_V0 m/s まで) は STEER_LIMIT_LOW 倍、速いとき (STEER_LIMIT_V1 m/s から) は STEER_LIMIT_HIGH 倍、間はまっすぐつなぐ
 */
export const STEER_LIMIT_LOW = 4.5;
export const STEER_LIMIT_HIGH = 4.2;
export const STEER_LIMIT_V0 = 14;
export const STEER_LIMIT_V1 = 42;
export function steerLimit(v: number): number {
  const a = Math.abs(v);
  if (a <= STEER_LIMIT_V0) return STEER_LIMIT_LOW;
  if (a >= STEER_LIMIT_V1) return STEER_LIMIT_HIGH;
  return STEER_LIMIT_LOW + ((STEER_LIMIT_HIGH - STEER_LIMIT_LOW) * (a - STEER_LIMIT_V0)) / (STEER_LIMIT_V1 - STEER_LIMIT_V0);
}
/**
 * 回りすぎ止め: 車の向きが進む向きより この角 (ラジアン) 以上 曲がる側へ向いていたら、それ以上は回さない (滑る角が増えない)。
 * 遅いときは SLIP_MAX_LOW、速いときは SLIP_MAX_HIGH (速さのつなぎは steerLimit と同じ)
 */
export const SLIP_MAX_LOW = (15 * Math.PI) / 180;
export const SLIP_MAX_HIGH = (6 * Math.PI) / 180;
export function slipMax(v: number): number {
  const k = (steerLimit(v) - STEER_LIMIT_LOW) / (STEER_LIMIT_HIGH - STEER_LIMIT_LOW);
  return SLIP_MAX_LOW + (SLIP_MAX_HIGH - SLIP_MAX_LOW) * k;
}
/** ボタンのハンドル (rampSteer): 切り始めから いっぱいまでの秒と、戻す秒 */
export const STEER_BUILD = 0.07;
export const STEER_RETURN = 0.05;
/**
 * 11/25 3 回目「もうちょい」: ハンドルを大きく切ったときに 向きを変える速さを増やす倍率 (車の turnRate に掛ける)。
 * 切れが STEER_GAIN_FROM までは 1 倍 (コンピューターの細かい切れは変わらない)、いっぱいで STEER_GAIN 倍、間はまっすぐつなぐ
 */
export const STEER_GAIN = 1.6;
export const STEER_GAIN_FROM = 0.6;
/** 芝で 止まりかけの抵抗は、握りで出せる押しの この割合まで (どのタイヤ・濡れ具合でも出られる) */
const GRASS_STATIC_SHARE = 0.4;
/** かんたん操作: この先の曲がりに間に合う速さ (bot.ts の allowedSpeed) を見る上手さと、握りの使い方の倍率 */
export const ASSIST_SKILL = 0.8;
export const ASSIST_MARGIN = 0.92;
/** かんたん操作: 曲がりの中で握りが足りないときの自動ブレーキは、この速さ (m/s) より上だけ (芝で止まりきらないように) */
const ASSIST_REACT_MIN = 10;
/** かんたん操作: 曲がりの中の自動ブレーキは 滑る角がこの角 (ラジアン) を超えると効き始め、ASSIST_SLIP_FULL でいっぱい */
const ASSIST_SLIP_FROM = (0.5 * Math.PI) / 180;
const ASSIST_SLIP_FULL = (4 * Math.PI) / 180;

/**
 * ボタンのハンドル (-1 / 0 / 1) を ゆっくり切り、速く戻す。cur = 今の値、target = 押しているボタン。
 * 毎刻み 1 回呼ぶ (dt ごとに決まって進むので、同じ押し方なら同じ結果)
 */
export function rampSteer(cur: number, target: number, dt = DT): number {
  const t = target < -1 ? -1 : target > 1 ? 1 : target;
  // 反対へ切る・戻すときは戻す速さ、同じ向きへ切り増すときは切る速さ
  const back = cur * t < 0 || Math.abs(t) < Math.abs(cur);
  const rate = dt / (back ? STEER_RETURN : STEER_BUILD);
  const d = t - cur;
  // 小数の誤差で 0 や 1 のすぐ手前に残らないように (少しの余り)
  return Math.abs(d) <= rate + 1e-9 ? t : cur + Math.sign(d) * rate;
}

export interface StepEvents {
  /** 壁に当たった強さ (m/s)、なければ 0 */
  wall: number;
  /** 近道した距離 (m)、なければ 0 */
  cut: number;
  /** この刻みで部品が傷んだ (壁) */
  damage?: DamageEvent;
}

/** サスペンション: 芝では 縁石の この割合だけ効く (握り・抵抗。仮) */
export const SUSP_GRASS_GRIP = 0.5;
export const SUSP_GRASS_ROLL = 0.3;

/** 速さの上限を超えていたときに落とす速さ (m/s²、仮) */
export const CAP_DECEL = 7;

/** スタートの並び (slot は 0 から) */
export function gridPosition(track: Track, slot: number): { x: number; y: number; heading: number; s: number } {
  const s = -(10 + slot * 8);
  const d = slot % 2 === 0 ? -3.2 : 3.2;
  const p = pointAt(track, s, d);
  return { x: p.x, y: p.y, heading: p.heading, s };
}

export function createCar(track: Track, stats: CarStats, slot: number, setup: CarSetup = {}): CarState {
  const g = gridPosition(track, slot);
  const fuel = setup.fuel !== undefined && Number.isFinite(setup.fuel) ? Math.max(0, Math.min(stats.fuelCap, setup.fuel)) : stats.fuelCap;
  const q = queryTrack(track, g.x, g.y);
  return {
    x: g.x,
    y: g.y,
    heading: g.heading,
    vx: 0,
    vy: 0,
    fuel,
    hint: q.index,
    dist: g.s,
    lastS: q.s,
    started: false,
    lapInvalid: false,
    slip: 0,
    surface: "asphalt",
    tire: isTireCompound(setup.tire) ? setup.tire : DEFAULT_TIRE,
    wear: setup.wear !== undefined && Number.isFinite(setup.wear) ? clamp(setup.wear, 0, 0.999) : 0,
    burst: false,
    tireMods: stats.tireMods ?? null,
    pitOrder: null,
    pit: null,
    damage: null,
    drs: null,
    sets: setup.sets ? cloneSets(setup.sets) : null,
    ...(setup.serviceFactor !== undefined && Number.isFinite(setup.serviceFactor) ? { serviceFactor: clamp(setup.serviceFactor, 0.3, 2) } : {}),
    ...(setup.wearScale !== undefined && Number.isFinite(setup.wearScale) ? { wearScale: clamp(setup.wearScale, 0.5, 1.5) } : {}),
    ...(setup.fuelScale !== undefined && Number.isFinite(setup.fuelScale) ? { fuelScale: clamp(setup.fuelScale, 0.5, 1.5) } : {}),
    ...(setup.kerbScale !== undefined && Number.isFinite(setup.kerbScale) ? { kerbScale: clamp(setup.kerbScale, 0.2, 1.5) } : {}),
    ...(stats.otExtra && stats.otExtra > 0 ? { otExtra: stats.otExtra } : {}),
  };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function stepCar(car: CarState, input: CarInput, stats: CarStats, track: Track, dt = DT, env: StepEnv = {}): StepEvents {
  // ピットの道の中は自動で走る (燃料は減らない)
  if (car.pit) return stepPit(car, stats, track, dt, !!env.boxBusy);
  const ev: StepEvents = { wall: 0, cut: 0 };
  const distBefore = car.dist;
  const wetAround = Math.max(0, Math.min(1, env.wetness ?? 0));
  const q0 = queryTrack(track, car.x, car.y, car.hint);
  // 乾きかけの道: 走る線に近いほど乾いている
  const wet =
    env.lineWetness !== undefined && env.lineWetness < wetAround
      ? wetnessAtLateral(wetAround, Math.max(0, env.lineWetness), q0.d - (racingLine(track).d[q0.index] ?? 0))
      : wetAround;
  const surf0 = surfaceAt(track, q0);
  car.surface = surf0.kind;
  if (!isTireCompound(car.tire)) car.tire = DEFAULT_TIRE;
  if (car.tireMods === undefined) car.tireMods = stats.tireMods ?? null;
  const tm = car.tireMods ?? NO_TIRE_MODS;
  const puddle = puddleEffect(track, q0, wet, car.tire, tm.puddle);
  // 縁石: 特徴「縁石に強い」なら 握りの落ちが小さい
  // 運転手の得意「縁石がうまい」(car.kerbScale) は 部品の特徴に重ねる
  const kerbK = car.kerbScale === undefined ? tm.kerb : tm.kerb * car.kerbScale;
  let roadGrip = surf0.kind === "kerb" && kerbK !== 1 ? 1 - (1 - surf0.grip) * kerbK : surf0.grip;
  let roadRoll = surf0.roll;
  // サスペンション (研究の部品): 縁石は 握りの落ちと揺れ (抵抗) が susp の割合だけ減る。芝は その半分 (握り) と 3 割 (抵抗)
  const susp = stats.susp ?? 0;
  if (susp > 0 && surf0.kind !== "asphalt") {
    const k = surf0.kind === "kerb" ? susp : susp * SUSP_GRASS_GRIP;
    roadGrip = 1 - (1 - roadGrip) * (1 - k);
    roadRoll *= 1 - (surf0.kind === "kerb" ? susp : susp * SUSP_GRASS_ROLL);
  }
  // 路面 × タイヤ (種類・すり減り・濡れ具合・部品の特徴) × 水たまり
  const surf = { grip: roadGrip * tireGrip(car, wet, tm) * puddle.grip, roll: roadRoll + puddle.drag };
  // 傷み: 働かない部品の分だけ 握り・押しつけ・力・ブレーキが落ち、落ちた部品の分だけ軽い
  const dm = damageEffect(car, stats);
  const mass = Math.max(50, stats.dryMass - dm.mass) + car.fuel * FUEL_KG;

  let fx = Math.cos(car.heading);
  let fy = Math.sin(car.heading);
  let vF = car.vx * fx + car.vy * fy;

  // 握りで出せる加速。横は 特徴「曲がりに強い / ブレーキに強い」の倍率を掛ける
  const aGrip = (stats.gripAccel * dm.grip + (stats.downK * dm.down * vF * vF) / mass) * surf.grip;
  const aLat = tm.lat === 1 ? aGrip : aGrip * tm.lat;

  // 向きを変える
  const steer = clamp(input.steer, -1, 1);
  // 止まりかけでも少しは向きを変えられる (壁に鼻先を向けて動けなくならないように)
  // 大きく切ったときだけ よく回る (STEER_GAIN)
  const sa = Math.abs(steer);
  const g = sa <= STEER_GAIN_FROM ? 1 : 1 + ((STEER_GAIN - 1) * (sa - STEER_GAIN_FROM)) / (1 - STEER_GAIN_FROM);
  let omega = steer * g * stats.turnRate * clamp(Math.abs(vF) / 7, 0.4, 1) * (vF >= -0.5 ? 1 : -1);
  // 速いときは切れ角を抑える (横の力が握りの steerLimit 倍まで)
  let omegaMax = (steerLimit(vF) * aLat) / Math.max(Math.abs(vF), 1);
  // 回りすぎ止め: 曲がる側へ滑る角が slipMax を超えないように (前へ進んでいるときだけ)
  if (vF > 3 && omega !== 0) {
    const vL0 = -car.vx * fy + car.vy * fx;
    // 左へ回す (omega > 0) と 横の速さは右 (マイナス) へ増える
    const slipIn = Math.atan2(omega > 0 ? -vL0 : vL0, vF);
    const room = (slipMax(vF) - slipIn) / dt + aLat / vF;
    omegaMax = Math.min(omegaMax, Math.max(0, room));
  }
  if (omega > omegaMax) omega = omegaMax;
  else if (omega < -omegaMax) omega = -omegaMax;
  const need = Math.abs(vF * omega);
  if (need > aLat) {
    const o = Math.min(1, (need - aLat) / Math.max(aLat, 0.5));
    // 前寄り = 曲がりにくい (アンダー)、後ろ寄り = 回りすぎる (オーバー)
    omega *= stats.balance > 0 ? 1 - 0.45 * o * stats.balance : 1 + 0.55 * o * -stats.balance;
  }
  car.heading += omega * dt;
  if (car.heading > Math.PI) car.heading -= 2 * Math.PI;
  else if (car.heading < -Math.PI) car.heading += 2 * Math.PI;

  fx = Math.cos(car.heading);
  fy = Math.sin(car.heading);
  const rx = -fy;
  const ry = fx;
  vF = car.vx * fx + car.vy * fy;
  let vL = car.vx * rx + car.vy * ry;

  const assist = !!input.assist;
  let throttle = assist ? 1 : clamp(input.throttle, 0, 1);
  let brakeIn = clamp(input.brake, 0, 1);
  if (assist && car.started) {
    // かんたん操作: この先の曲がりを見て、間に合うように減速する (コンピューターと同じ見積もり、少し控えめ)
    const allow = allowedSpeed(car, stats, track, car.lastS, ASSIST_SKILL, tireGrip(car, wet, tm) * dm.grip, ASSIST_MARGIN);
    if (vF > allow + 0.2) {
      throttle = 0;
      brakeIn = Math.max(brakeIn, Math.min(1, (vF - allow) / 0.7));
    } else if (vF > allow - 0.8) throttle = 0.35;
    // 曲がりの中で握りが足りずに滑っているときも (止まりかけでは効かせない)。
    // 11/25 2 回目: 鼻先は握りより大きく回せるようにしたので、切っているだけでなく 実際に滑る角 (ASSIST_SLIP_FROM から ASSIST_SLIP_FULL で強く) で見る
    if (steer !== 0 && need > aLat * 0.85 && vF > ASSIST_REACT_MIN) {
      const slipA = Math.atan2(car.slip, vF);
      const k = clamp((slipA - ASSIST_SLIP_FROM) / (ASSIST_SLIP_FULL - ASSIST_SLIP_FROM), 0, 1);
      if (k > 0) brakeIn = Math.max(brakeIn, Math.abs(steer) * k);
    }
  }
  const wrecked = isWrecked(car, stats);
  if (!car.started || car.fuel <= 0 || wrecked) throttle = 0;
  const cap = env.speedCap !== undefined && Number.isFinite(env.speedCap) ? Math.max(0, env.speedCap) : Infinity;
  if (vF > cap) throttle = 0;

  // ブレーキは握りより強くは効かない
  const brakeMax = tm.brake === 1 ? Math.min(stats.brake * dm.brake, aGrip * 1.25 + 1) : Math.min(stats.brake * dm.brake, aGrip * 1.25 + 1) * tm.brake;
  let reverse = 0;
  let brake = brakeIn * brakeMax;
  if (brakeIn > 0 && throttle === 0 && vF < 0.6 && car.started && car.fuel > 0 && !wrecked) {
    // 止まりかけでブレーキを押し続けると下がる
    brake = 0;
    reverse = vF > -REVERSE_MAX ? REVERSE_ACCEL * brakeIn : 0;
  }

  // マニュアル: 段と回転で力が変わり、速さ (力と最高速) が manualBonus だけ上がる
  const manual = input.gear !== undefined && input.gear !== null && Number.isFinite(input.gear);
  // ギア箱 (研究の部品) はマニュアルの上がり分を足す
  const mb = manual ? manualShiftBonus(stats, env.manualBonus ?? undefined) : 0;
  // オーバーテイクモード: 押していてアクセルを踏んでいる間だけ (目盛りが減る)
  const otMul = car.ot ? overtakeBoost(car, !!input.overtake && throttle > 0, dt) : 1;
  let drive = 0;
  if (throttle > 0) {
    let pw = stats.power * dm.power;
    if (otMul !== 1) pw *= otMul;
    if (mb > 0) pw *= 1 + mb;
    drive = (pw * 1000) / (mass * Math.max(vF, 4));
    drive = Math.min(drive, stats.gripAccel * dm.grip * 1.15 * surf.grip) * throttle;
    if (manual) drive *= gearPowerFactor(rpmFraction(vF, input.gear!, stats, mb), input.gear!);
    // 破裂したタイヤでは ゆっくりしか走れない
    if (car.burst && vF > BURST_MAX_SPEED) drive = 0;
    car.fuel = Math.max(0, car.fuel - stats.fuelRate * throttle * dt * (car.fuelScale ?? 1));
    if (otMul !== 1) car.fuel = Math.max(0, car.fuel - OT_FUEL * dt);
  }
  // 空気の抵抗: 落ちた羽根の分は減る。風よけと DRS でも減る
  const tow = Math.max(0, Math.min(1, env.tow ?? 0));
  let dragK = Math.max(0.05, stats.dragK - dm.drag) * (1 - TOW_DRAG * tow) * drsDragFactor(car, track, brakeIn > 0.05);
  // マニュアル: 最高速がちょうど × (1 + manualBonus) になるように
  if (mb > 0) dragK /= (1 + mb) * (1 + mb);
  const dragA = (dragK * vF * Math.abs(vF)) / mass;
  const scrub = Math.min(Math.abs(vL), 8) * 0.35;
  const engineBrake = throttle === 0 && car.started ? ENGINE_BRAKE : 0;
  const burstDrag = car.burst && vF > BURST_MAX_SPEED ? 4 : 0;
  // 路面の抵抗: 芝は速さに比べて増える。止まりかけの分は 握りで出せる押しより いつも小さく (出られなくならないように)
  let roll = surf.roll;
  if (surf0.rollV) {
    const driveGrip = stats.gripAccel * dm.grip * 1.15 * surf.grip;
    roll = Math.min(roll, GRASS_STATIC_SHARE * driveGrip) + surf0.rollV * Math.abs(vF);
  }
  const resist = roll + brake + scrub + engineBrake + burstDrag;
  let newVF = vF + (drive - reverse - dragA) * dt;
  // 抵抗は止まるところまで (逆向きには押さない)
  const dec = resist * dt;
  if (reverse === 0) {
    if (Math.abs(newVF) <= dec) newVF = 0;
    else newVF -= Math.sign(newVF) * dec;
  }
  // 速さの上限 (VSC・先導車): 超えていたら CAP_DECEL で落とし、超えないように
  if (newVF > cap) newVF = vF > cap ? Math.max(cap, vF - CAP_DECEL * dt) : cap;
  vF = newVF;

  // 横の滑りは握りで消す (足りなければ滑る)
  const corr = aLat * dt;
  vL = Math.abs(vL) <= corr ? 0 : vL - Math.sign(vL) * corr;
  car.slip = Math.abs(vL);

  // タイヤのすり減り: 速く走るほど・握りを使うほど・滑るほど減る。縁石の上は余分に減る
  if (!car.burst) {
    const use = Math.min(1.5, (Math.min(need, aLat) + brake + drive * 0.5) / Math.max(aLat, 1));
    const work = Math.abs(vF) * (0.4 + use) + Math.min(car.slip, 6) * 3;
    const kerbWear = surf0.kind === "kerb" ? 1 + (KERB_WEAR - 1) * kerbK : 1;
    car.wear += WEAR_K * TIRE_DEFS[car.tire].wear * wetWearFactor(car.tire, wet) * tm.wear * kerbWear * work * dt * (car.wearScale ?? 1);
    if (otMul !== 1) car.wear += OT_WEAR * dt;
    // 新しいタイヤに替えたら 限界を超えた分は数え直し
    if (car.overWear && car.wear < 0.9) car.overWear = 0;
    if (car.wear >= 1) {
      if (tm.tough > 0) {
        // 「破裂しにくい」: 限界を超えても tough の分だけ走れる (握りは限界のまま)
        const over = (car.overWear ?? 0) + (car.wear - 1);
        car.wear = 1;
        if (over >= tm.tough) {
          car.burst = true;
          car.overWear = 0;
        } else car.overWear = over;
      } else {
        car.wear = 1;
        car.burst = true;
      }
    }
  }

  car.vx = fx * vF + rx * vL;
  car.vy = fy * vF + ry * vL;
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // 壁
  const q = queryTrack(track, car.x, car.y, q0.index);
  const wd = wallDistance(track, q.index) - stats.width / 2;
  if (Math.abs(q.d) > wd) {
    const [nx, ny] = normalAt(track, q.index);
    const side = Math.sign(q.d);
    const excess = Math.abs(q.d) - wd;
    car.x -= nx * side * excess;
    car.y -= ny * side * excess;
    const vn = (car.vx * nx + car.vy * ny) * side;
    if (vn > 0) {
      // 壁へ向かう速さは跳ね返し、当たった強さに応じて沿う速さも落とす
      car.vx -= nx * side * vn * 1.3;
      car.vy -= ny * side * vn * 1.3;
      const keep = 1 - Math.min(0.5, vn * 0.04);
      car.vx *= keep;
      car.vy *= keep;
      ev.wall = vn;
      // 強く当たると、壁の側の部品が傷む
      if (env.damage !== false && vn > WALL_DAMAGE_MIN) {
        const hit = applyImpact(car, stats, nx * side, ny * side, vn, WALL_DAMAGE_MIN);
        if (hit) ev.damage = hit;
      }
    }
    // こすっている間は少しずつ遅くなる
    car.vx *= 0.995;
    car.vy *= 0.995;
  }

  // 道のり
  const qa = ev.wall ? queryTrack(track, car.x, car.y, q.index) : q;
  const L = track.length;
  let ds = qa.s - car.lastS;
  if (ds > L / 2) ds -= L;
  else if (ds < -L / 2) ds += L;
  if (Math.abs(ds) > 25) {
    ev.cut = Math.abs(ds);
    car.lapInvalid = true;
  }
  car.dist += ds;
  car.lastS = qa.s;
  car.hint = qa.index;
  // 予約があって入り口の線を越えたら、ピットに入る
  if (car.pitOrder && car.started && !ev.cut && crossesPitEntry(track, distBefore, car.dist)) enterPit(car, track, qa.d);
  return ev;
}

export function carSpeed(car: CarState): number {
  return Math.hypot(car.vx, car.vy);
}
