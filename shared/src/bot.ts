// コンピューター (NPC) の運転: 走る線 (line.ts、道幅を使って曲がりをゆるくする線) の少し先の点へ向かってハンドルを切る。
// 上手さ (skill) で、走る線の使い方・曲がりで使う握りの割合・ブレーキの遅さ・ふらつき・ときどきのミスが変わる。
// 11/25 ユーザー「NPC をもっと強く」: 中心の線ではなく走る線を通り、限界の近くで曲がり、ブレーキを遅く強くした (数は仮)。
// 前の車に追いついたら、空いている側へずれて抜く (黄旗・VSC の間は抜かない)。
// ピット: 天気とレースの長さで最初のタイヤと燃料を決め、タイヤがすり減ったとき・燃料が足りないとき・
// 天気がタイヤに合わなくなったときに「次の周で入る」を予約する。
import type { Body } from "./collide.ts";
import { damageCount } from "./damage.ts";
import type { CarStats } from "./design.ts";
import type { CarInput, CarSetup, CarState } from "./physics.ts";
import { OT_BOT_RANGE, OT_BOT_WIDTH, overtakeAvailable } from "./overtake.ts";
import { cancelPit, requestPit, type PitOrder } from "./pit.ts";
import { bestTireFor, compoundGrip, NOMINAL_WEAR_PER_M, TIRE_DEFS, tireGrip, wetWearFactor, type TireCompound } from "./tires.ts";
import { autoTireAlloc, pickFromSets, startFromAlloc, type AllocRules, type TireAlloc } from "./tireset.ts";
import { racingLine, trackIndex } from "./line.ts";
import { pointAt, queryTrack, type Track } from "./track.ts";

export interface BotBrain {
  /** 0.8 (へた) 〜 1 (上手)。0.7 くらいまでは走れる */
  skill: number;
  /** 走る線の横のずれ (m) */
  offset: number;
  /** ふらつきの位相 */
  phase: number;
  /** スタートの反応 (秒) */
  reaction: number;
  /** 抜くときに ずれる側 (-1 左 / 1 右) と、いつまで */
  passSide: number;
  passUntil: number;
  /** ミス (反応が遅れる) の間 */
  slipUntil: number;
  nextSlipCheck: number;
  /** 乱数の種 */
  seed: number;
  /** 今のタイヤを付けたときの道のり (NaN = まだ見ていない) と、前の刻みのすり減り */
  tireFrom: number;
  lastWear: number;
  /** ときどきのミスの起きやすさの倍率 (雇った運転手の安定、drivers.ts の driverTraits。なし・1 = 今のまま) */
  mistakeScale?: number;
  // ---- 運転手の得意 (drivers.ts の applySpecialties)。なし・はじめの値 = 今のまま
  /** 雨に強い: 濡れ具合 1 で skill に足す数 (濡れ具合に比例) */
  wetSkill?: number;
  /** 予選が速い: 新しいタイヤ (すり減り FRESH_WEAR まで) の間 skill に足す数 */
  freshSkill?: number;
  /** 追い抜きがうまい: 前の車を見る長さの倍率・並んだときの握りの控えが小さい (1 = 今のまま) */
  passAggression?: number;
  /** 守りが固い: 後ろから詰めてくる車の側へ寄せる強さ (0 = 何もしない) */
  defend?: number;
  /**
   * ピットの判断 (雇った運転手の pitSense、drivers.ts の driverTraits。0..1)。なし = 今のまま (コンピューター・代走)。
   * 高いほど 天気の変わり目を早く読んで替え、タイヤを使い切る手前の良いところで入る
   */
  pitSense?: number;
  // ---- チームの作戦の合図 (teamorder.ts)。なし = 今のまま
  /** 曲がりで使う握りの割合に掛ける (タイヤを持たせろ = 1 より小さい) */
  paceScale?: number;
  /** ピットに入れ: 次に入れる周で入る (入ったら消える) */
  forcePit?: boolean;
}

/** 「予選が速い」が効く 新しいタイヤのすり減り (drivers.ts の SPECIALTY_FX.freshWear と同じ、仮) */
export const FRESH_WEAR = 0.25;

/** コンピューターの上手さの幅 (仮)。makeBrain で skill を渡さなければこの間で決まる */
export const BOT_SKILL_MIN = 0.8;
export const BOT_SKILL_MAX = 1;

export function makeBrain(rand: () => number, skill?: number): BotBrain {
  const sk = skill ?? BOT_SKILL_MIN + rand() * (BOT_SKILL_MAX - BOT_SKILL_MIN);
  return {
    skill: sk,
    offset: (rand() - 0.5) * 1.6,
    phase: rand() * 100,
    reaction: 0.2 + (1 - sk) * 1.0 + rand() * 0.2,
    passSide: 0,
    passUntil: 0,
    slipUntil: 0,
    nextSlipCheck: 5 + rand() * 10,
    seed: Math.floor(rand() * 2147483646) + 1,
    tireFrom: Number.NaN,
    lastWear: 0,
    mistakeScale: 1,
    wetSkill: 0,
    freshSkill: 0,
    passAggression: 1,
    defend: 0,
  };
}

function brainRand(b: BotBrain): number {
  b.seed = (b.seed * 16807) % 2147483647;
  return b.seed / 2147483647;
}

/** 上手さから決まる運転の数 (仮) */
export function botPace(skill: number) {
  const sk = Math.max(0, Math.min(1, skill));
  return {
    /** 走る線をどれだけ使うか (0 = 中心の線、1 = 走る線そのまま) */
    line: Math.max(0, Math.min(1, -0.2 + 1.2 * sk)),
    /** 曲がりの中で使う握りの割合 */
    use: 0.86 + 0.12 * sk,
    /** ブレーキの強さの見積もり (1 = 限界まで) */
    brake: 0.7 + 0.2 * sk,
  };
}

/** レースの決まりから来る運転の制限 (旗・VSC・先導車) */
export interface BotRules {
  /** 追い越し禁止 (黄旗・VSC)。前の車に追いついたら合わせて走る */
  noPass?: boolean;
  /** 速さの上限 (m/s、VSC) */
  speedCap?: number;
}

export function botInput(
  car: CarState,
  stats: CarStats,
  track: Track,
  brain: BotBrain,
  t: number,
  others: readonly Body[] = [],
  /** 路面の濡れ具合 (0..1)。濡れているほど・タイヤがすり減るほど 曲がりの前でよく減速する */
  wetness = 0,
  rules: BotRules = {},
): CarInput {
  const speed = Math.hypot(car.vx, car.vy);
  const s = car.lastS;
  const hw = track.def.halfWidth;
  // 得意: 雨 (濡れ具合に比例)・予選 (新しいタイヤの間) の分だけ上手く。得意がなければ brain.skill のまま
  const bonus = (brain.wetSkill ?? 0) * Math.max(0, Math.min(1, wetness)) + (car.wear < FRESH_WEAR ? (brain.freshSkill ?? 0) : 0);
  const skill = bonus > 0 ? Math.max(brain.skill, Math.min(1, brain.skill + bonus)) : brain.skill;
  // 得意: 追い抜き (前を見る長さ・並んだときの控え) と守り (後ろの車の側へ寄せる)
  const pa = brain.passAggression ?? 1;
  const def = rules.noPass ? 0 : (brain.defend ?? 0);
  let block = 0;

  // ときどきミス (上手いほど少ない): 少しの間ハンドルが遅れる
  if (t >= brain.nextSlipCheck) {
    brain.nextSlipCheck = t + 4 + brainRand(brain) * 8;
    if (brainRand(brain) < (1 - skill) * 0.6 * (brain.mistakeScale ?? 1)) brain.slipUntil = t + 0.25 + (1 - skill) * 1.2;
  }

  // 前の車をよける (追い越し禁止の間は、ずれずに後ろについて走る)
  const fx = Math.cos(car.heading);
  const fy = Math.sin(car.heading);
  const vF = car.vx * fx + car.vy * fy;
  let follow = Infinity;
  for (const o of others) {
    const dx = o.x - car.x;
    const dy = o.y - car.y;
    const f = dx * fx + dy * fy;
    const l = -dx * fy + dy * fx;
    const look = (5 + speed * 0.6) * pa;
    const wide = (stats.width + o.width) / 2 + 0.8;
    const oF = o.vx * fx + o.vy * fy;
    const closing = vF - oF;
    // 守り: 後ろから詰めてくる車 (並ぶ前) の側へ寄せて 線をふさぐ
    if (def > 0 && f < -(stats.length + o.length) / 2 - 0.5 && f > -(6 + speed * 0.35) && Math.abs(l) < wide + 2 && -closing > 0.3) {
      const sh = Math.max(-2.5, Math.min(2.5, l * 1.2)) * def;
      if (Math.abs(sh) > Math.abs(block)) block = sh;
    }
    if (f > 0 && f < look && Math.abs(l) < wide && closing > 0.5) {
      // 前の車の速さまで落とす (近いほど強く)。追い越し禁止の間はいつも、そうでなければ ぶつかりそうなときだけ
      const room = f - (stats.length + o.length) / 2 - 2;
      const matchV = Math.max(0, oF + Math.max(0, room) * 0.5);
      if (rules.noPass) {
        follow = Math.min(follow, matchV);
        continue;
      }
      if (room < 1 + closing * 0.6) follow = Math.min(follow, matchV);
      // 空いている側へ (道の端に近ければ反対へ)
      const q = queryTrack(track, car.x, car.y, car.hint);
      let side = l >= 0 ? -1 : 1;
      if (Math.abs(q.d + side * 3.5) > hw - 1.5) side = -side;
      if (brain.passUntil < t) brain.passSide = side;
      brain.passUntil = t + 1.2;
    }
  }
  if (brain.passUntil < t || rules.noPass) brain.passSide = 0;

  const pace = botPace(skill);
  const line = racingLine(track);
  const look = 6 + speed * (0.45 + (1 - skill) * 0.3);
  const ahead = trackIndex(track, s + look);
  const guard = brain.passSide === 0 ? block : 0;
  const lateral = Math.max(-(hw - 1.6), Math.min(hw - 1.6, line.d[ahead] * pace.line + brain.offset * (1.2 - pace.line) + brain.passSide * 3.5 + guard));
  const target = pointAt(track, s + look, lateral);
  let diff = Math.atan2(target.y - car.y, target.x - car.x) - car.heading;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  // ミスの間はハンドルを半分しか切らない
  const gain = (1.8 + skill * 0.9) * (t < brain.slipUntil ? 0.4 : 1);
  const wobble = Math.sin(t * 0.7 + brain.phase) * (1 - skill) * 0.25;
  const steer = Math.max(-1, Math.min(1, diff * gain + wobble));

  // 速さ: この先の曲がりに間に合うように減速する (上手いほど攻める)。抜いている間は線を外れるので少し控える (抜きがうまい人は控えが小さい)
  let allow = allowedSpeed(car, stats, track, s, skill, tireGrip(car, wetness), (brain.passSide !== 0 ? (pa === 1 ? 0.94 : 1 - 0.06 / pa) : 1) * (brain.paceScale ?? 1));
  if (rules.speedCap !== undefined) allow = Math.min(allow, rules.speedCap);
  allow = Math.min(allow, follow);
  let throttle = 1;
  let brake = 0;
  if (speed > allow + 0.2) {
    throttle = 0;
    brake = Math.min(1, (speed - allow) / 0.7);
  } else if (speed > allow - 0.8) {
    throttle = 0.35;
  }
  // 前の車にぶつかりそうで、抜く側も空いていないとき
  if (brain.passUntil >= t && brain.passSide === 0) throttle = Math.min(throttle, 0.5);
  // オーバーテイクモード: 使える周に、すぐ前に車がいて全開のとき (立ち上がりと直線)。前に誰もいなければ使わない
  let overtake = false;
  if (throttle >= 1 && !rules.noPass && overtakeAvailable(car)) {
    for (const o of others) {
      const dx = o.x - car.x;
      const dy = o.y - car.y;
      const f = dx * fx + dy * fy;
      if (f > 2 && f < OT_BOT_RANGE && Math.abs(-dx * fy + dy * fx) < OT_BOT_WIDTH) {
        overtake = true;
        break;
      }
    }
  }
  const out: CarInput = { steer: Math.abs(steer) < 0.04 ? 0 : steer, throttle, brake };
  if (overtake) out.overtake = true;
  return out;
}

/**
 * この先の曲がりから見て、今出してよい速さ (m/s)。
 * 曲がり具合は 走る線と中心の線を上手さに合わせて混ぜたもの。margin は握りの割合に掛ける (1 = そのまま)
 */
export function allowedSpeed(car: CarState, stats: CarStats, track: Track, s: number, skill: number, grip = 1, margin = 1): number {
  const pace = botPace(skill);
  const line = racingLine(track);
  const mass = stats.dryMass + car.fuel * 0.75;
  const a0 = stats.gripAccel * grip;
  const dk = (stats.downK * grip) / mass;
  // 曲がりの中で使う握りの割合 (上手いほど限界に近い)
  const use = pace.use * margin;
  const b = Math.min(stats.brake, a0 * 1.25 + 1) * pace.brake;
  let allow = Infinity;
  for (let x = 0; x <= 160; x += 2) {
    const i = trackIndex(track, s + x);
    const k = Math.abs(line.curv[i]) * pace.line + Math.abs(track.curv[i]) * (1 - pace.line);
    if (k < 1e-4) continue;
    // v² κ = use × (a0 + dk v²) → v² = use a0 / (κ - use dk)
    const den = k - use * dk;
    if (den <= 0) continue;
    const vmax2 = (use * a0) / den;
    const v = Math.sqrt(vmax2 + 2 * b * x);
    if (v < allow) allow = v;
  }
  return allow;
}

/** ゴールのあとの自動の運転: 道に沿って この速さ (m/s) まで ゆっくり落として走る (仮) */
export const FINISH_SPEED = 15;
/** ゴールのあとの減速のブレーキの強さ (曲がりの前は botInput のまま強く、仮) */
const FINISH_BRAKE = 0.35;

/**
 * ゴール (リタイア) のあとの人の車の入力 (11/25 試走「ゴールのあと まっすぐ芝へ」)。
 * 上手さ 1 のコンピューターと同じく道に沿い、FINISH_SPEED まで落とす。毎回まっさらの頭で決めるので、同じ様子なら同じ入力
 */
export function finishInput(car: CarState, stats: CarStats, track: Track, t: number, others: readonly Body[] = [], wetness = 0): CarInput {
  const brain = makeBrain(() => 0.5, 1);
  const inp = botInput(car, stats, track, brain, t, others, wetness, { speedCap: FINISH_SPEED });
  // 曲がりに間に合う速さより遅ければ、ブレーキはゆっくり (急に止めない)
  const speed = Math.hypot(car.vx, car.vy);
  if (speed < allowedSpeed(car, stats, track, car.lastS, 1, tireGrip(car, wetness))) inp.brake = Math.min(inp.brake, FINISH_BRAKE);
  return inp;
}

// ---- ピットの作戦 ----

/** 1 周のおよその秒 (少し遅めに見積もる) */
export function estimateLapTime(stats: CarStats, track: Track): number {
  return track.length / (0.62 * Math.max(20, stats.topSpeed));
}

/** 1 m あたりに使うおよその燃料 (L、少し多めに見積もる) */
export function fuelPerMeter(stats: CarStats): number {
  return (stats.fuelRate * 0.75) / (0.62 * Math.max(20, stats.topSpeed));
}

/** そのタイヤが 1 m で減るおよその量 */
export function nominalWearPerM(c: TireCompound, wet: number): number {
  return NOMINAL_WEAR_PER_M * TIRE_DEFS[c].wear * wetWearFactor(c, wet);
}

/** タイヤの使い切りの目安 (これを超える前にピットに入る) */
const WEAR_LIMIT = 0.88;

/** ピットの判断 (BotBrain.pitSense) が効く数 (仮)。pitSense なし = 今のまま */
export const PIT_SENSE = {
  /** 天気の先読み: 少し先の濡れ具合をどれだけ見るか (0 = 今だけ、1 = 少し先そのまま)。判断 0 → 1 */
  lookMin: 0.3,
  lookMax: 1,
  /** 天気で替える: 新しいタイヤの握りが 今の何倍を超えたら替えるか。判断 0 → 1 (今のままは 1.07) */
  swapMarginMin: 1.13,
  swapMarginMax: 1.04,
  /** すり減りで入る目安 (今のままは 0.88)。判断 0 は使い切りすぎ、1 はちょうどよい所 */
  wearLimitMin: 0.95,
  wearLimitMax: 0.88,
};

/** ピットの判断の数 (pitSense なし = 今のまま) */
export function pitSenseParams(pitSense: number | undefined): { look: number; swapMargin: number; wearLimit: number } {
  if (pitSense === undefined || !Number.isFinite(pitSense)) return { look: 1, swapMargin: 1.07, wearLimit: WEAR_LIMIT };
  const p = Math.max(0, Math.min(1, pitSense));
  const mix = (a: number, b: number) => a + (b - a) * p;
  return {
    look: mix(PIT_SENSE.lookMin, PIT_SENSE.lookMax),
    swapMargin: mix(PIT_SENSE.swapMarginMin, PIT_SENSE.swapMarginMax),
    wearLimit: mix(PIT_SENSE.wearLimitMin, PIT_SENSE.wearLimitMax),
  };
}

/** 乾いた路面で、残りの道のり (m) を走るタイヤ。持つ中で一番柔らかいもの。持たなければ 2 回に分けて持つもの */
export function chooseDryTire(remainM: number, scale = 1, wet = 0): TireCompound {
  for (const c of ["S", "M", "H"] as const) if (nominalWearPerM(c, wet) * scale * remainM <= WEAR_LIMIT) return c;
  for (const c of ["S", "M"] as const) if ((nominalWearPerM(c, wet) * scale * remainM) / 2 <= WEAR_LIMIT) return c;
  return "H";
}

/** 濡れ具合に合うタイヤ (乾いていれば残りの道のりで決める) */
function tireForWeather(wet: number, remainM: number, scale = 1): TireCompound {
  const best = bestTireFor(wet);
  return best === "M" ? chooseDryTire(remainM, scale, wet) : best;
}

const tireKind = (c: TireCompound) => (TIRE_DEFS[c].slick ? "slick" : c);

/**
 * 走る前: 最初のタイヤと燃料を決める。wetStart = スタートの濡れ具合、wetSoon = 少し先の濡れ具合。
 * rand を渡すと、ときどき 1 段柔らかいタイヤで攻める
 */
export function botStartSetup(
  stats: CarStats,
  track: Track,
  laps: number,
  wetStart: number,
  wetSoon = wetStart,
  rand?: () => number,
  /** 持っていく組の決まり (tireset.ts の allocRules)。渡すと組を決めて sets に入れる。wetMax = 予報で一番濡れる見込み。alloc = 決めてある組 (代走の予定) */
  tires?: { rules: AllocRules; wetMax?: number; alloc?: TireAlloc },
): CarSetup {
  const total = laps * track.length + 100;
  const wet = Math.max(wetStart, wetSoon * 0.8);
  let tire = tireForWeather(wet, total);
  const soft = !!rand && TIRE_DEFS[tire].slick && rand() < 0.3;
  if (soft) tire = tire === "H" ? "M" : "S";
  const fuel = Math.min(stats.fuelCap, fuelPerMeter(stats) * total * 1.12 + 1.5);
  if (!tires || !Number.isFinite(tires.rules.limit)) return { tire, fuel };
  let alloc = tires.alloc;
  let start = tire;
  if (!alloc) {
    const auto = autoTireAlloc({ trackLength: track.length, laps, rules: tires.rules, wetStart: wet, wetMax: tires.wetMax ?? wet });
    alloc = auto.alloc;
    start = auto.start;
    // ときどき 1 段柔らかいタイヤで攻める (持っていく組の中にあれば)
    if (soft && TIRE_DEFS[start].slick) {
      const softer: TireCompound = start === "H" ? "M" : "S";
      if ((alloc[softer] ?? 0) > 0) start = softer;
    }
  }
  const s = startFromAlloc(alloc, start);
  return { tire: s.tire, fuel, sets: s.sets };
}

export interface BotRaceInfo {
  /** レースの周の数 (先頭がゴールしたあとは 今の周 + 1) */
  totalLaps: number;
  /** 今の濡れ具合と、少し先の濡れ具合 */
  wetNow: number;
  wetSoon: number;
}

/** ピットの予約を決める (毎刻み呼んでよい)。入れるときは car.pitOrder に予約、要らなくなったら取り消す */
export function updateBotPit(car: CarState, stats: CarStats, track: Track, brain: BotBrain, info: BotRaceInfo): void {
  if (car.pit) {
    brain.tireFrom = Number.NaN;
    // ピットに入れ (作戦の合図) は入ったら済み
    brain.forcePit = undefined;
    return;
  }
  if (Number.isNaN(brain.tireFrom) || car.wear < brain.lastWear - 1e-6) brain.tireFrom = car.dist - car.wear / Math.max(1e-9, nominalWearPerM(car.tire, info.wetNow));
  brain.lastWear = car.wear;
  const L = track.length;
  const remain = info.totalLaps * L - car.dist;
  const toEntry = (((track.pit.entry - car.dist) % L) + L) % L;
  // ゴールの前にもう入り口がない
  if (remain <= 0 || toEntry >= remain) {
    if (car.pitOrder) cancelPit(car);
    return;
  }
  const after = remain - toEntry;
  const nominal = nominalWearPerM(car.tire, info.wetNow);
  const used = car.dist - brain.tireFrom;
  const rate = used > 400 ? Math.max(car.wear / used, nominal * 0.5) : nominal;
  const scale = Math.max(0.5, Math.min(2, rate / Math.max(1e-12, nominal)));

  let tire: TireCompound | null = null;
  // ピットの判断 (雇った運転手だけ): 天気の先読みの深さ・替える思い切り・すり減りの目安
  const ps = pitSenseParams(brain.pitSense);
  const wetSoon = info.wetNow + (info.wetSoon - info.wetNow) * ps.look;
  // 天気がタイヤに合わない (乾き・小雨・大雨の種類が違い、新しいタイヤの方がはっきり握る)
  const best = bestTireFor(wetSoon);
  if (after > L * 0.5 && tireKind(best) !== tireKind(car.tire) && compoundGrip(best, wetSoon) > tireGrip(car, wetSoon) * ps.swapMargin) {
    tire = tireForWeather(wetSoon, after, scale);
  }
  // すり減り: 破裂した、またはゴールまで持たず、次の次の入り口までも持たない
  // (最後の周に入っても得をしないので入らない)
  if (!tire && after > L * 0.5) {
    const atEntry = car.wear + rate * toEntry;
    const atFinish = car.wear + rate * remain;
    if (car.burst || (atFinish > 0.97 && atEntry + rate * L > ps.wearLimit)) {
      tire = TIRE_DEFS[car.tire].slick ? chooseDryTire(after, scale, wetSoon) : bestTireFor(wetSoon);
    }
  }
  // ピットに入れ (作戦の合図): 用がなくても 次の入り口で入って、今の天気に合う新しいタイヤに替える
  const forced = !!brain.forcePit && after > 0;
  if (forced && !tire) tire = tireForWeather(wetSoon, after, scale);
  // 燃料: ゴールまで足りない
  const fpm = fuelPerMeter(stats);
  const fuelShort = car.fuel < fpm * remain + 0.5;
  let fuelTo: number | null = null;
  if (fuelShort || (tire && car.fuel < fpm * after * 1.05 + fpm * toEntry)) fuelTo = Math.min(stats.fuelCap, Math.ceil(fpm * (after * 1.1 + toEntry) + 1));

  // 傷み: 壊れた・落ちた部品があるか、傷みの合計が大きければ直しに入る。ほかの用で入るときは小さな傷も直す
  const dmg = damageCount(car);
  const dmgSum = (car.damage?.parts ?? []).reduce((a, h) => a + Math.min(1, h), 0);
  const mustRepair = !car.damage?.out && after > L * 0.5 && (dmg.broken > 0 || dmgSum > 0.8);

  // 持っている組の決まりがあれば、その中から選ぶ (雨用がなければ乾いたタイヤのまま。今より減った組には替えない)
  let usedSet: number | null = null;
  if (tire && car.sets) {
    const weatherSwap = tireKind(tire) !== tireKind(car.tire);
    let p = pickFromSets(car.sets, tire, car.burst ? 1 : weatherSwap ? 0.7 : forced ? Math.max(0, car.wear - 0.05) : Math.min(0.7, car.wear - 0.15));
    // すり減り (破裂) で替えるのに 同じ仲間の組がない (雨用を使い切った など): 破裂して遅く走り続けるより、残っている別の仲間の組
    if (!p && !weatherSwap) p = pickFromSets(car.sets, TIRE_DEFS[tire].slick ? bestTireFor(1) : "M", car.burst ? 1 : 0.7);
    tire = p?.tire ?? null;
    usedSet = p?.used ?? null;
  }
  if (tire || fuelTo !== null || mustRepair || forced) {
    const repair = dmg.damaged > 0 && !car.damage?.out;
    const want: PitOrder = { tire, used: usedSet, fuelTo, repair };
    const cur = car.pitOrder;
    if (!cur || cur.tire !== want.tire || (cur.used ?? null) !== usedSet || (cur.fuelTo ?? null) !== fuelTo || !!cur.repair !== repair) requestPit(car, want);
  } else if (car.pitOrder) {
    cancelPit(car);
  }
}
