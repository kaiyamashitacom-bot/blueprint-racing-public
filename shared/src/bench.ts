// 試走台 (車づくりの磨き): 部品を置くたびに出す 走りの見積もり。
// - 最高速: computeStats の topSpeed (力と空気の抵抗の釣り合い)
// - 曲がり: 決まった半径 (BENCH_RADIUS) の曲がりを 新品の 普通 (M) タイヤで回れる一番速い速さ (握り・羽根・タイヤの特徴)
// - 1 周のタイムと燃料: 一番上手いコンピューター (bot.ts、上手さ 1) が 晴れ・M タイヤ・満タンのまま 2 周走り、
//   2 周目 (勢いのついた周) を測る。画面の外で走らせるだけ (決まった計算なので 毎回同じ答え)
// 数は (仮)。
import { BOT_SKILL_MAX, botInput, makeBrain } from "./bot.ts";
import type { CarStats } from "./design.ts";
import { createCar, DT, stepCar } from "./physics.ts";
import { newLapState, updateLaps } from "./race.ts";
import { NO_TIRE_MODS, tireGrip } from "./tires.ts";
import type { Track } from "./track.ts";

/** 曲がりの速さを測る 曲がりの半径 (m、仮) */
export const BENCH_RADIUS = 30;
/** 速さの記録の間隔 (m) */
export const BENCH_TRACE_STEP = 8;
/** 走らせる周 (2 周目を測る) */
const BENCH_LAPS = 2;

/** 半径 radius (m) の曲がりを 晴れ・新品の M タイヤ・満タンで回れる一番速い速さ (m/s) */
export function cornerSpeed(stats: CarStats, radius = BENCH_RADIUS): number {
  const tm = stats.tireMods ?? NO_TIRE_MODS;
  const g = tireGrip({ tire: "M", wear: 0, burst: false }, 0, tm) * tm.lat;
  const mass = Math.max(1, stats.mass);
  const a0 = stats.gripAccel * g;
  const den = 1 / radius - (stats.downK * g) / mass;
  const vGrip = den > 0 ? Math.sqrt(a0 / den) : 200;
  // ハンドルの速さ (向きを変えられる速さ) でも決まる
  return Math.min(vGrip, stats.turnRate * radius, 200);
}

export interface BenchLap {
  trackId: string;
  /** 勢いのついた 1 周の秒 (走り切れなければ null) */
  lap: number | null;
  /** その周に使った燃料 (L) */
  fuel: number | null;
  /** その周の一番速い速さ (m/s) */
  vmax: number;
  /** その周の速さ (m/s)。スタートの線から BENCH_TRACE_STEP m ごと */
  trace: number[];
}

/** 一番上手いコンピューターに 2 周走らせて、2 周目を測る */
export function benchLap(stats: CarStats, track: Track): BenchLap {
  const out: BenchLap = { trackId: track.def.id, lap: null, fuel: null, vmax: 0, trace: [] };
  if (!(stats.power > 0)) return out;
  const car = createCar(track, stats, 0, { tire: "M" });
  car.started = true;
  const full = car.fuel;
  // 決まった乱数 (上手さ 1 ではミスもふらつきもないので、使われるのは最初だけ)
  const brain = makeBrain(() => 0.5, BOT_SKILL_MAX);
  const st = newLapState();
  const L = track.length;
  const bins = Math.ceil(L / BENCH_TRACE_STEP);
  const trace = new Array<number>(bins).fill(Number.NaN);
  // 遅すぎる車は打ち切る (1 周 平均 4 m/s より遅い)
  const tMax = ((BENCH_LAPS + 0.5) * L) / 4;
  let t = 0;
  let used = 0;
  let laps = 0;
  while (t < tMax && !st.finished && !st.retired) {
    const inp = botInput(car, stats, track, brain, t, [], 0);
    const ev = stepCar(car, inp, stats, track, DT, { damage: false });
    t += DT;
    // 燃料は満タンのまま (重さを変えない)。使った分だけ数える
    if (laps === 1) used += full - car.fuel;
    car.fuel = full;
    if (laps === 1) {
      const v = Math.hypot(car.vx, car.vy);
      const b = Math.floor((car.dist - L) / BENCH_TRACE_STEP);
      if (b >= 0 && b < bins && Number.isNaN(trace[b])) trace[b] = v;
      if (v > out.vmax) out.vmax = v;
    }
    const le = updateLaps(car, st, ev, t, L, BENCH_LAPS, false);
    if (le.lap) {
      laps++;
      if (laps === BENCH_LAPS) {
        out.lap = le.lap.time;
        out.fuel = used;
      }
    }
  }
  // 抜けた所はとなりで埋める
  for (let i = 0; i < bins; i++) if (Number.isNaN(trace[i])) trace[i] = i > 0 ? trace[i - 1] : 0;
  out.trace = out.lap === null ? [] : trace;
  return out;
}
