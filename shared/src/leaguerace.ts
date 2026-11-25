// 画面なしのレース (2 時間ごとのリーグ戦用)。全部の車をコンピューターが運転し、server がまとめて計算して結果だけ残す。
// 中身は部屋 (room.ts) のレース中の刻みと同じ: 旗・VSC・SC (racecontrol.ts)・ぶつかり・DRS と風よけ・ピット・天気・傷み。
// 決めごと (11/25 サーバーの重さの対策): 見ている人がいないので刻みを粗くしてよい (結果が大きく変わらないことを試験で確かめる)。
// 刻み (dt) は外から渡す。LEAGUE_RACE_DT が server の使う刻み (試験 leaguerace.test.ts で 1/60 秒と比べた、仮)。
// 同じ seed・同じ車なら いつも同じ結果 (乱数は seed から)。
import { botInput, botStartSetup, updateBotPit, type BotBrain } from "./bot.ts";
import { bodyOf, pushApart, type Body } from "./collide.ts";
import { damageCount } from "./damage.ts";
import { computeStats, type CarDesign, type CarStats } from "./design.ts";
import { drsAvailable, openDrs, towFactor, updateDrs } from "./drs.ts";
import { updateOvertake } from "./overtake.ts";
import { createCar, stepCar, type CarState } from "./physics.ts";
import { inService, requestPit } from "./pit.ts";
import { prefStartSetup, type RaceSetupPref } from "./standin.ts";
import { newLapState, pickFastest, pointsFor, sortStandings, updateLaps, type LapState } from "./race.ts";
import {
  flagSpeedCap, newRaceControl, overtakeAllowed, scFollowInput, scOrder, scTarget, stepRaceControl, VSC_SPEED,
  type FollowTarget, type RcCar,
} from "./racecontrol.ts";
import { newStint, updateStint, type StintState } from "./timing.ts";
import { allocRules, forecastWetMax, setOptions, type TireSets } from "./tireset.ts";
import { TIRE_DEFS, type TireCompound } from "./tires.ts";
import { advanceStint, startStint, type Stint } from "./tournament.ts";
import { getTrack } from "./tracks.ts";
import { forecastAt, lineWetnessAt, makeWeatherPlan, skyAt, wetnessAt, type WeatherPlan } from "./weather.ts";

/** server が使う刻み (秒、仮)。1/60 秒と比べて差が小さいことを試験で確かめた (leaguerace.test.ts) */
export const LEAGUE_RACE_DT = 1 / 20;
/** 先頭がゴールしてから残りを待つ時間 (秒、room.ts の CHEQUERED_MS と同じ) */
const CHEQUERED_S = 60;
/** 1 周あたりの打ち切りの時間 (秒、room.ts と同じ) */
const LAP_LIMIT_S = 240;
/** コンピューターが天気を見る先の秒 (room.ts と同じ) */
const BOT_WEATHER_LOOK = 40;

export interface HeadlessCarSpec {
  /** レースの中で重ならない id */
  id: string;
  design: CarDesign;
  /** 運転の頭。wetStart = スタートの濡れ具合 (性格で上手さが変わるライバル用)。rand はレースの乱数 */
  brain: (ctx: { wetStart: number; rand: () => number }) => BotBrain;
  /** ピットで止まる時間の倍率 (整備の組の腕。なし = 1) */
  serviceFactor?: number;
  /** タイヤのすり減り・燃料の使い方の倍率 (雇った運転手、drivers.ts の driverCarScales。なし = 1) */
  wearScale?: number;
  fuelScale?: number;
  /** 縁石の倍率 (運転手の得意「縁石がうまい」。なし = 1) */
  kerbScale?: number;
  /** 遊ぶ人の走る前の準備 (代走の車。standin.ts)。なし = コンピューターが決める */
  pref?: RaceSetupPref | null;
  /** チーム (同じチームの 2 台はピットの止まる場所を分け合う。なし = 分け合わない) */
  team?: string;
  /** 走る前の準備をそのまま使う (大会の人の車: 予選の組から。部屋の FixedCar.setup と同じ)。pref より先 */
  setup?: { tire: TireCompound; wear: number; sets: TireSets | null; fuel: number };
}

export interface HeadlessOptions {
  trackId: string;
  laps: number;
  seed: number;
  /** 刻み (秒)。なし = LEAGUE_RACE_DT */
  dt?: number;
  /** 天気 (なし = seed から) */
  weather?: WeatherPlan;
  /**
   * タイヤの組の決まり (なし = リーグ戦)。"tournament" のときは 部屋と同じく 乾いた路面用を 2 種類使うようにピットに入り、
   * 履いたタイヤごとの区間 (stints) を結果に付ける (大会の 画面に送らない組。server/src/season.ts)
   */
  tireKind?: "league" | "tournament";
}

export interface HeadlessCarResult {
  id: string;
  /** スタートの並び (0 = ポール)。渡した車の順 */
  grid: number;
  pos: number;
  points: number;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  /** ゴールの時間 + 罰 (秒)。ゴールしていなければ その時の時間 */
  total: number;
  penalty: number;
  best: number | null;
  fastest: boolean;
  pitStops: number;
  wallHits: number;
  distM: number;
  /** 付けていた部品の id (研究を早める。重なりなし) */
  partIds: string[];
  /** 最後のタイヤ */
  tire: string;
  /** 履いたタイヤと走った道のり (tireKind "tournament" のときだけ) */
  stints?: Stint[];
}

export interface HeadlessResult {
  trackId: string;
  laps: number;
  /** 順位の順 */
  results: HeadlessCarResult[];
  /** 走った時間 (秒) と刻みの数 */
  raceSeconds: number;
  steps: number;
  /** 一番濡れた濡れ具合 (0..1) */
  wetMax: number;
}

function lcg(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface Runner {
  spec: HeadlessCarSpec;
  grid: number;
  stats: CarStats;
  car: CarState;
  lap: LapState;
  brain: BotBrain;
  stint: StintState;
  simT: number;
  /** 大会のタイヤの決まり用 */
  stints: Stint[];
  stintDist: number;
}

/** 大会のタイヤの決まり (乾いた路面用を 2 種類): まだ 1 種類なら、半周以上残るうちにピットへ (room.ts の dryTyreRulePit と同じ考え) */
function dryRulePit(r: Runner, laps: number, L: number, entry: number, wet: number) {
  const car = r.car;
  if (car.pit || !car.sets || wet >= 0.1 || !TIRE_DEFS[car.tire].slick) return;
  const used = new Set(r.stints.filter((x) => TIRE_DEFS[x.tire].slick).map((x) => x.tire));
  used.add(car.tire);
  if (used.size >= 2) return;
  if (car.pitOrder?.tire && car.pitOrder.tire !== car.tire && TIRE_DEFS[car.pitOrder.tire].slick) return;
  const total = laps * L;
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

/**
 * 1 レースを最後まで計算する。cars の並びがスタートの並び (1 番目がポール)。
 * 走れない設計図の車は呼ぶ側で外しておく (computeStats が通ればここでは確かめない)
 */
export function simulateRace(cars: readonly HeadlessCarSpec[], o: HeadlessOptions): HeadlessResult {
  const dt = o.dt ?? LEAGUE_RACE_DT;
  const track = getTrack(o.trackId);
  const rand = lcg(o.seed);
  const weather = o.weather ?? makeWeatherPlan(1 + Math.floor(rand() * 2147483645), o.laps * 75);
  const wet0 = wetnessAt(weather, 0);
  const tour = o.tireKind === "tournament";
  const rules = allocRules(tour ? "tournament" : "league", o.laps);
  const wetMaxFc = forecastWetMax(wet0, forecastAt(weather, 0));
  const runners: Runner[] = cars.map((spec, grid) => {
    const stats = computeStats(spec.design);
    const base = botStartSetup(stats, track, o.laps, wet0, wetnessAt(weather, 60), rand, { rules, wetMax: wetMaxFc });
    const setup = spec.setup
      ? { tire: spec.setup.tire, wear: spec.setup.wear, sets: spec.setup.sets, fuel: spec.setup.fuel }
      : spec.pref
        ? prefStartSetup(spec.pref, base, { stats, track, laps: o.laps, rules, wet: Math.max(wet0, wetnessAt(weather, 60) * 0.8), wetMax: wetMaxFc })
        : base;
    const car = createCar(track, stats, grid, {
      ...setup,
      ...(spec.serviceFactor !== undefined ? { serviceFactor: spec.serviceFactor } : {}),
      ...(spec.wearScale !== undefined ? { wearScale: spec.wearScale } : {}),
      ...(spec.fuelScale !== undefined ? { fuelScale: spec.fuelScale } : {}),
      ...(spec.kerbScale !== undefined ? { kerbScale: spec.kerbScale } : {}),
    });
    return {
      spec,
      grid,
      stats,
      car,
      lap: newLapState(),
      brain: spec.brain({ wetStart: wet0, rand }),
      stint: newStint(car.tire, car.wear, car.dist),
      simT: 0,
      stints: tour ? startStint([], car.tire, wet0) : [],
      stintDist: car.dist,
    };
  });
  const rc = newRaceControl(skyAt(weather, 0));
  const inPit = (r: Runner) => !!r.car.pit;
  const rcCar = (r: Runner): RcCar => {
    const dmg = damageCount(r.car);
    return {
      id: r.spec.id,
      dist: r.car.dist,
      speed: Math.hypot(r.car.vx, r.car.vy),
      lapsDone: r.lap.lapsDone,
      started: r.car.started,
      pit: inPit(r),
      finished: r.lap.finished,
      retired: r.lap.retired,
      hits: r.car.damage?.hits ?? 0,
      lost: dmg.lost,
      burst: !!r.car.burst,
      broken: dmg.broken,
    };
  };
  const limit = o.laps * LAP_LIMIT_S;
  let t = 0;
  let steps = 0;
  let chequeredAt = -1;
  let wetMax = wet0;
  while (true) {
    const tNext = t + dt;
    const wet = wetnessAt(weather, t);
    // 走る線の上は先に乾く (physics.ts が車の横の位置で混ぜる)
    const lineWet = lineWetnessAt(weather, t);
    if (wet > wetMax) wetMax = wet;
    stepRaceControl(rc, track, runners.map(rcCar), dt, { sky: skyAt(weather, tNext), wet: wetnessAt(weather, tNext), chequered: chequeredAt >= 0 });
    const solid = runners.filter((r) => !r.lap.finished && !r.lap.retired && !inPit(r));
    const bodies = new Map<string, Body>(solid.map((r) => [r.spec.id, bodyOf(r.car, r.stats)]));
    let follow: { info: { mode: "sc"; order: string[]; sc?: FollowTarget }; cars: Map<string, FollowTarget> } | null = null;
    if (rc.mode === "sc") {
      const fc = new Map<string, FollowTarget>(runners.map((r) => [r.spec.id, { dist: r.car.dist, v: Math.hypot(r.car.vx, r.car.vy) }]));
      follow = { info: { mode: "sc", order: scOrder(runners.map(rcCar)).map((c) => c.id), sc: rc.sc ?? undefined }, cars: fc };
    }
    const cap = flagSpeedCap(rc);
    const totalLaps = (r: Runner) => (chequeredAt >= 0 ? Math.min(o.laps, r.lap.lapsDone + 1) : o.laps);
    for (const r of runners) {
      if (r.lap.finished || r.lap.retired) continue;
      const brain = r.brain;
      r.car.started = r.car.started || r.simT >= brain.reaction;
      const others: Body[] = [];
      for (const [id, b] of bodies) if (id !== r.spec.id) others.push(b);
      if (r.car.started) {
        updateBotPit(r.car, r.stats, track, brain, { totalLaps: totalLaps(r), wetNow: wet, wetSoon: wetnessAt(weather, r.simT + BOT_WEATHER_LOOK) });
        if (tour) dryRulePit(r, o.laps, track.length, track.pit.entry, wet);
      }
      const input =
        follow && !r.car.pit
          ? scFollowInput(r.car, r.stats, track, scTarget(follow.info, r.spec.id, follow.cars), wet, others)
          : botInput(r.car, r.stats, track, brain, r.simT, others, wet, {
              noPass: !overtakeAllowed(rc, track, r.car.dist),
              speedCap: rc.mode === "vsc" ? VSC_SPEED : undefined,
            });
      const prevDist = r.car.dist;
      // チームの相方が止まる場所で作業中なら手前で待つ
      const mate = r.spec.team !== undefined ? runners.find((x) => x !== r && x.spec.team === r.spec.team) : undefined;
      const ev = stepCar(r.car, input, r.stats, track, dt, { wetness: wet, lineWetness: lineWet, tow: towFactor(r.car, others), speedCap: cap, boxBusy: !!mate && inService(mate.car) });
      const otherDists: number[] = [];
      for (const x of solid) if (x !== r) otherDists.push(x.car.dist);
      updateDrs(r.car, track, prevDist, otherDists, rc.drs);
      updateOvertake(r.car, track, prevDist, otherDists, !!rc.ot);
      if (input.throttle >= 1 && drsAvailable(r.car, track)) openDrs(r.car, track);
      r.simT = tNext;
      const le = updateLaps(r.car, r.lap, ev, r.simT, track.length, o.laps, chequeredAt >= 0);
      if (le.finished && chequeredAt < 0) chequeredAt = tNext;
    }
    for (const r of runners) {
      if (r.lap.finished || r.lap.retired || inPit(r)) continue;
      const me = bodyOf(r.car, r.stats);
      for (const x of solid) {
        if (x === r || inPit(x)) continue;
        pushApart(r.car, me, bodies.get(x.spec.id) ?? bodyOf(x.car, x.stats), 0.5, r.stats);
      }
    }
    if (tour) {
      const wetN = wetnessAt(weather, tNext);
      for (const r of runners) {
        const last = r.stints[r.stints.length - 1];
        if (!last || last.tire !== r.car.tire) r.stints = startStint(r.stints, r.car.tire, wetN);
        const d = r.car.dist - r.stintDist;
        if (d > 0 && d < 500 && !r.lap.finished && !r.lap.retired) r.stints = advanceStint(r.stints, d, wetN);
        r.stintDist = r.car.dist;
      }
    }
    for (const r of runners) {
      updateStint(
        r.stint,
        {
          inPit: inPit(r),
          tire: r.car.tire,
          wear: r.car.wear,
          burst: r.car.burst,
          dist: r.car.dist,
          speed: Math.hypot(r.car.vx, r.car.vy),
          running: r.car.started && !r.lap.finished && !r.lap.retired,
        },
        tNext,
      );
    }
    t = tNext;
    steps++;
    const allDone = runners.every((r) => r.lap.finished || r.lap.retired);
    if (allDone || (chequeredAt >= 0 && t - chequeredAt > CHEQUERED_S) || t > limit) break;
  }
  return { trackId: o.trackId, laps: o.laps, results: finish(runners, rc.pen, t, tour), raceSeconds: t, steps, wetMax };
}

/** 順位・点・一番速い周 (room.ts の endRace と同じ決まり) */
function finish(runners: Runner[], pen: Readonly<Record<string, number>>, t: number, withStints = false): HeadlessCarResult[] {
  const sorted = sortStandings(
    runners.map((r) => ({
      r,
      id: r.spec.id,
      finished: r.lap.finished,
      retired: r.lap.retired,
      lapsDone: r.lap.lapsDone,
      finishTime: r.lap.finishTime,
      penalty: r.lap.penalty + (pen[r.spec.id] ?? 0),
      dist: r.car.dist,
    })),
  );
  // 一番速い周: 同じタイムなら先に出した車、それも同じなら順位が上の車
  const fastestId = pickFastest(sorted.map((s) => ({ id: s.id, best: s.r.lap.bestLap, bestAt: s.r.lap.bestAt })));
  return sorted.map((s, i) => {
    const r = s.r;
    const p = pointsFor(i, sorted.length);
    return {
      id: s.id,
      grid: r.grid,
      pos: i + 1,
      points: s.finished ? p + (s.id === fastestId && p > 0 ? 1 : 0) : 0,
      finished: s.finished,
      retired: s.retired,
      lapsDone: s.lapsDone,
      total: Math.round(((s.finished ? s.finishTime : t) + s.penalty) * 1000) / 1000,
      penalty: Math.round(s.penalty * 1000) / 1000,
      best: r.lap.bestLap === null ? null : Math.round(r.lap.bestLap * 1000) / 1000,
      fastest: s.id === fastestId,
      pitStops: r.stint.pitStops,
      wallHits: r.car.damage?.hits ?? 0,
      distM: Math.max(0, Math.round(r.car.dist)),
      partIds: [...new Set(r.spec.design.parts.map((x) => x.id))],
      tire: r.car.tire,
      ...(withStints ? { stints: r.stints } : {}),
    };
  });
}
