// 走った線の記録 (DECISIONS 順番 2 の追加「レースのあとに走った線とブレーキの所を図面に重ねる」)。
// 自分の車の位置・速さ・ブレーキを 0.1 秒ごとに残す。残すのは今の周と、その前の数周だけ (古い周は捨てる)。
// 画面 (web/src/race/replay-ui.ts) が、図面の上に速さの色の線とブレーキの印を描く。
// ここは計算だけ。Math.random は使わない (同じ入力なら同じ記録)。数は全部 (仮)。

/** 記録の間かく (秒、仮) */
export const REPLAY_STEP = 0.1;
/** 今の周のほかに残す、走り終えた周の数 (仮) */
export const REPLAY_KEEP_LAPS = 3;
/** 記録の数の上限 (周が終わらないまま長く走ったとき用、仮。0.1 秒ごとで 10 分) */
export const REPLAY_MAX_SAMPLES = 6000;
/** ブレーキとみる踏み込み (0..1、仮) */
export const BRAKE_INPUT_MIN = 0.1;
/** ペダルを踏んでいなくても、これより強く減速したらブレーキとみる (m/s²、かんたん操作の自動ブレーキ用、仮) */
export const BRAKE_DECEL_MIN = 6;

/** 1 つの記録の並び: [時刻, x, y, 速さ, 印 (1 = ブレーキ) + 周 × 2] */
const STRIDE = 5;

export interface ReplayBuffer {
  /** 記録 (STRIDE ずつ並べた数の列。JSON にできる) */
  data: number[];
  /** 次に残す時刻 */
  next: number;
  /** 前の刻みの時刻と速さ (減速を測る) */
  prevT: number;
  prevV: number;
  /** 前の記録のあとにブレーキがあったか */
  braked: boolean;
  /** 周ごとの始まりの時刻 (周の番号 → 秒) */
  lapStart: Record<number, number>;
  /** 最後に見た周 */
  lap: number;
  /** 周ごとのセクターのタイム (周の番号 → S1・S2・S3 の秒、分からない・数えないは null)。画面が sectors.ts で数えて入れる */
  sectors?: Record<number, Array<number | null>>;
}

export interface ReplaySample {
  t: number;
  x: number;
  y: number;
  /** 速さ (m/s) */
  v: number;
  brake: boolean;
  /** 走り終えた周の数 (この記録の周は lap + 1 周目) */
  lap: number;
}

export function newReplay(): ReplayBuffer {
  return { data: [], next: -Infinity, prevT: Number.NaN, prevV: 0, braked: false, lapStart: {}, lap: -1 };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 1 刻みぶんを見て、間かく (REPLAY_STEP) ごとに 1 つ残す。毎刻み呼んでよい。
 * brake = ブレーキの踏み込み (0..1)。lap = 走り終えた周の数。残したら true
 */
export function recordSample(buf: ReplayBuffer, t: number, x: number, y: number, v: number, brake: number, lap: number): boolean {
  if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const speed = Number.isFinite(v) ? Math.max(0, v) : 0;
  const dt = t - buf.prevT;
  const decel = dt > 1e-6 ? (buf.prevV - speed) / dt : 0;
  if (brake > BRAKE_INPUT_MIN || decel > BRAKE_DECEL_MIN) buf.braked = true;
  buf.prevT = t;
  buf.prevV = speed;
  if (lap !== buf.lap) {
    if (!(lap in buf.lapStart)) buf.lapStart[lap] = t;
    buf.lap = lap;
    // 古い周を捨てる
    const keepFrom = lap - REPLAY_KEEP_LAPS;
    if (buf.data.length && sampleLap(buf.data, 0) < keepFrom) {
      let i = 0;
      while (i < buf.data.length && sampleLap(buf.data, i) < keepFrom) i += STRIDE;
      buf.data.splice(0, i);
      for (const k of Object.keys(buf.lapStart)) if (Number(k) < keepFrom) delete buf.lapStart[Number(k)];
    }
  }
  if (t + 1e-6 < buf.next) return false;
  // 間かくを保つ (遅れすぎたとき・最初は今から数え直す)
  buf.next = t - buf.next > REPLAY_STEP ? t + REPLAY_STEP : buf.next + REPLAY_STEP;
  buf.data.push(r2(t), r2(x), r2(y), r2(speed), (buf.braked ? 1 : 0) + Math.max(0, Math.floor(lap)) * 2);
  buf.braked = false;
  if (buf.data.length > REPLAY_MAX_SAMPLES * STRIDE) buf.data.splice(0, buf.data.length - REPLAY_MAX_SAMPLES * STRIDE);
  return true;
}

function sampleLap(d: readonly number[], i: number): number {
  return Math.floor(d[i + 4] / 2);
}

/** ゴールしたとき: 最後の周を走り終えたことにする (周の時間が出るように。最後の刻みの時刻を使う) */
export function closeReplay(buf: ReplayBuffer): void {
  if (buf.lap >= 0 && Number.isFinite(buf.prevT) && !(buf.lap + 1 in buf.lapStart)) buf.lapStart[buf.lap + 1] = buf.prevT;
}

/** 記録の数 */
export function replayLength(buf: ReplayBuffer): number {
  return Math.floor(buf.data.length / STRIDE);
}

/** 記録を取り出す (lap を渡すとその周だけ) */
export function replaySamples(buf: Pick<ReplayBuffer, "data">, lap?: number): ReplaySample[] {
  const out: ReplaySample[] = [];
  const d = buf.data;
  for (let i = 0; i + STRIDE <= d.length; i += STRIDE) {
    const l = sampleLap(d, i);
    if (lap !== undefined && l !== lap) continue;
    out.push({ t: d[i], x: d[i + 1], y: d[i + 2], v: d[i + 3], brake: (d[i + 4] & 1) === 1, lap: l });
  }
  return out;
}

export interface ReplayLapInfo {
  /** 走り終えた周の数 (表示は lap + 1 周目) */
  lap: number;
  /** その周の時間 (秒。走っている途中の周・始まりがわからない周は null) */
  time: number | null;
  /** 記録の数 */
  samples: number;
}

/** 残っている周 (古い順) */
export function replayLaps(buf: ReplayBuffer): ReplayLapInfo[] {
  const count = new Map<number, number>();
  const d = buf.data;
  for (let i = 0; i + STRIDE <= d.length; i += STRIDE) {
    const l = sampleLap(d, i);
    count.set(l, (count.get(l) ?? 0) + 1);
  }
  const laps = [...count.keys()].sort((a, b) => a - b);
  return laps.map((lap) => {
    const a = buf.lapStart[lap];
    const b = buf.lapStart[lap + 1];
    // 最初の周 (lap 0) はスタートの並びから。周の時間は 1 周目からの数え方と違うので出さない
    const time = lap > 0 && a !== undefined && b !== undefined ? b - a : null;
    return { lap, time, samples: count.get(lap) ?? 0 };
  });
}

/**
 * 描くための間引き: 前に残した点から minDist (m) 以上離れた点だけ残す。
 * ブレーキの始まりと終わり・周の変わり目・最後の点は必ず残す (印がずれないように)
 */
export function decimate(samples: readonly ReplaySample[], minDist = 2): ReplaySample[] {
  if (samples.length <= 2) return samples.slice();
  const out: ReplaySample[] = [samples[0]];
  const m2 = minDist * minDist;
  for (let i = 1; i < samples.length - 1; i++) {
    const s = samples[i];
    const last = out[out.length - 1];
    const prev = samples[i - 1];
    const edge = s.brake !== prev.brake || s.lap !== prev.lap;
    const dx = s.x - last.x;
    const dy = s.y - last.y;
    if (edge || dx * dx + dy * dy >= m2) out.push(s);
  }
  out.push(samples[samples.length - 1]);
  return out;
}

export interface BrakePoint {
  x: number;
  y: number;
  /** 走っていた向き (ラジアン) */
  dir: number;
  /** 踏み始めの速さ (m/s) */
  v: number;
  /** 何 m 踏んだか */
  len: number;
}

/** ブレーキを踏み始めた所 (印を描く)。短く途切れたもの (gap 個以下の記録) はつなげて 1 つにする */
export function brakePoints(samples: readonly ReplaySample[], gap = 1): BrakePoint[] {
  const out: BrakePoint[] = [];
  let off = Infinity;
  let cur: BrakePoint | null = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const p = samples[i - 1];
    if (s.brake) {
      if (!cur || off > gap) {
        const n = samples[i + 1] ?? s;
        const from = p && p.lap === s.lap ? p : s;
        const to = from === s ? n : s;
        const dir = Math.atan2(to.y - from.y, to.x - from.x);
        cur = { x: s.x, y: s.y, dir: Number.isFinite(dir) ? dir : 0, v: p && p.lap === s.lap ? Math.max(p.v, s.v) : s.v, len: 0 };
        out.push(cur);
      } else if (p) {
        cur.len += Math.hypot(s.x - p.x, s.y - p.y);
      }
      off = 0;
    } else {
      off++;
      if (off > gap) cur = null;
    }
  }
  return out;
}

/** 速さの幅 (色分け用)。少し外れた値に引っぱられないよう、下と上の 3% は除く */
export function speedRange(samples: readonly ReplaySample[]): { min: number; max: number } {
  if (!samples.length) return { min: 0, max: 1 };
  const v = samples.map((s) => s.v).sort((a, b) => a - b);
  const k = Math.floor(v.length * 0.03);
  const min = v[k];
  const max = v[v.length - 1 - k];
  return max - min < 1 ? { min, max: min + 1 } : { min, max };
}
