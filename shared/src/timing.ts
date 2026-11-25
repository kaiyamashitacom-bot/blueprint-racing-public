// タイム差 (11/25 ユーザー「タイムの差と相手が使ってるタイヤがわかる様にしよう」)。
// コースを TIMING_STEP m ごとに区切った印 (道のり k × STEP) を、各車が通った時刻で覚える。
// 2 台のタイム差 = 後ろの車が最後に通った印を、前の車が通った時刻との差 (同じ場所を通った時刻の差)。
// 道のりから見積もるのではないので、遅い区間・速い区間で差が伸び縮みしない。
// 練習の幽霊は、記録 (0.1 秒ごとの x, y, 向き) をコースの道のりに直し、同じ道のりの時刻と比べる。
// ピットに入った回数・今のタイヤで走った周 (部屋が数えて snap で送る) もここ。数は全部 仮。
import type { TireCompound } from "./tires.ts";
import { queryTrack, type Track } from "./track.ts";

/** 印の間かく (m、仮) */
export const TIMING_STEP = 25;
/** 何周分の印を覚えるか (仮。周回遅れは 1 周以上の差なので、それより先は要らない) */
export const TIMING_LAPS = 2;

/** 1 台の印の記録 (古いものから消える輪の形。覚える量は コースの長さ × TIMING_LAPS ÷ STEP で決まる) */
export class TimingMarks {
  private readonly times: Float64Array;
  private readonly size: number;
  /** 最後に記録した印の番号 (なし = -Infinity) */
  private top = -Infinity;
  /** 記録の数 (印は抜けなく続く: top - count + 1 .. top) */
  private count = 0;
  private lastT = NaN;
  private lastD = NaN;
  /** 一番先の道のり lastD に着いた時刻 (止まっていても進めない) */
  private reachT = NaN;

  constructor(trackLength: number, laps = TIMING_LAPS, readonly step = TIMING_STEP) {
    this.size = Math.max(8, Math.ceil((Math.max(1, trackLength) * laps) / step) + 4);
    this.times = new Float64Array(this.size);
  }

  /** 時刻 t (秒) に道のり dist (m) にいた。前の記録との間で越えた印の時刻を、まっすぐ割って入れる */
  push(t: number, dist: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(dist)) return;
    if (!Number.isFinite(this.lastD)) {
      this.lastT = t;
      this.lastD = dist;
      this.reachT = t;
      return;
    }
    if (dist <= this.lastD) {
      // 下がった・止まった: 一番先まで行った場所は変えず、時刻だけ進める
      this.lastT = Math.max(this.lastT, t);
      return;
    }
    const s = this.step;
    const k0 = Math.floor(this.lastD / s) + 1;
    const k1 = Math.floor(dist / s);
    if (k1 >= k0) {
      // 飛びすぎ (つなぎ直しなど) は覚えられる分だけ
      const from = Math.max(k0, k1 - this.size + 1);
      if (this.count > 0 && from !== this.top + 1) this.count = 0;
      const dt = t - this.lastT;
      const dd = dist - this.lastD;
      for (let k = from; k <= k1; k++) {
        const u = (k * s - this.lastD) / dd;
        this.times[mod(k, this.size)] = this.lastT + dt * u;
        this.top = k;
        this.count = Math.min(this.size, this.count + 1);
      }
    }
    this.lastT = t;
    this.lastD = dist;
    this.reachT = t;
  }

  /** 印 k を通った時刻 (覚えていなければ null) */
  at(k: number): number | null {
    if (this.count === 0 || k > this.top || k <= this.top - this.count) return null;
    return this.times[mod(k, this.size)];
  }

  /** 最後に通った印の番号 (まだなければ null) */
  latest(): number | null {
    return this.count > 0 ? this.top : null;
  }

  /** 最後に記録した時刻 (秒。まだなければ NaN) */
  lastTime(): number {
    return this.lastT;
  }

  /** 一番先まで行った道のり (m。まだなければ NaN) */
  reach(): number {
    return this.lastD;
  }

  /** 道のり d を通った時刻 (前後の印の間をまっすぐ割る。覚えていなければ null) */
  timeAt(d: number): number | null {
    const s = this.step;
    const k = Math.floor(d / s);
    const a = this.at(k);
    if (a === null) return null;
    const b = this.at(k + 1);
    if (b !== null) return a + ((b - a) * (d - k * s)) / s;
    // 次の印の手前で止まった (ゴールで止まったコンピューターなど): 一番先に着いた時刻までで割る
    if (d <= this.lastD && this.lastD > k * s) return a + ((this.reachT - a) * (d - k * s)) / (this.lastD - k * s);
    return Math.abs(d - k * s) < 1e-9 ? a : null;
  }

  clear(): void {
    this.top = -Infinity;
    this.count = 0;
    this.lastT = NaN;
    this.lastD = NaN;
    this.reachT = NaN;
  }
}

const mod = (k: number, n: number) => ((k % n) + n) % n;

/** 見せる差の一番小さい値 (秒)。並んで走る 2 台でも「+0.000」にはしない */
export const GAP_MIN = 0.001;

/** タイム差の答え: 秒 (time)・周 (laps、周回遅れ)・まだ分からない (null) */
export type Gap = { kind: "time"; sec: number } | { kind: "laps"; laps: number } | null;

/**
 * 前の車 ahead と後ろの車 behind のタイム差。
 * 後ろの車が最後に通った印 (atDist を渡せばその道のり。ゴールした車はゴールの線) を、前の車が通った時刻との差。
 * 前の車がもう次の印を通ったのに後ろの車がまだなら、差は少なくとも「今 − 前の車が次の印を通った時刻」(止まった車の差が伸びていく)。
 * 前の車が 1 周以上先なら周の差。
 */
export function gapBetween(ahead: TimingMarks, behind: TimingMarks, trackLength: number, atDist?: number): Gap {
  // 塔の並びは「今の道のり」で決める (view.ts の standings。ほかの車は最後の snap を今まで伸ばす)。
  // ここの印は同じ時計なので、並びと差の向きは合う。逆になるのは並んで走る 2 台が入れかわる間だけ (そのときは分からない = null)
  const ra = ahead.reach();
  const rb = atDist ?? behind.reach();
  if (!Number.isFinite(ra) || !Number.isFinite(rb)) return null;
  if (ra - rb >= trackLength) return { kind: "laps", laps: Math.floor((ra - rb) / trackLength) };
  let tb: number | null;
  let ta: number | null;
  let floor = -Infinity;
  if (atDist !== undefined) {
    tb = behind.timeAt(atDist);
    ta = ahead.timeAt(atDist);
  } else {
    // 2 台とも通った一番先の印で比べる (前の車の記録が snap の遅れで少し古くても、差が「分からない」にならない)
    const kb = behind.latest();
    const ka = ahead.latest();
    if (kb === null || ka === null) return null;
    const k = Math.min(kb, ka);
    tb = behind.at(k);
    ta = ahead.at(k);
    const next = ahead.at(k + 1);
    if (next !== null) floor = behind.lastTime() - next;
  }
  if (ta === null || tb === null) return null;
  const sec = Math.max(tb - ta, floor);
  // 前後が入れかわった (後ろの車が先に通った): 塔の並びと印が食い違う間は分からない (塔は「—」)。
  // 前は 0 にしていて、入れかわりのすぐあとに「+0.000」と出ていた (11/25 検証)
  if (sec < 0) return null;
  return { kind: "time", sec: Math.max(GAP_MIN, sec) };
}

/** 塔の差の字: +1.234 ・ +1:02.3 ・ +1 周 (分からなければ "") */
export function formatGap(g: Gap): string {
  if (!g) return "";
  if (g.kind === "laps") return `+${g.laps} 周`;
  return `+${formatSec(g.sec)}`;
}

/** 秒の字 (60 秒より下は 1.234、上は 1:02.3) */
export function formatSec(sec: number): string {
  const s = Math.abs(sec);
  if (s < 60) return s.toFixed(3);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** 差の伸び縮みを見る時間 (秒、仮) と、変わったとみる幅 (秒、仮) */
export const TREND_WINDOW = 5;
export const TREND_EPS = 0.05;

/** 差の移り変わり (前後の車の大きな表示で ▲▼ を出す) */
export class GapTrend {
  private hist: Array<{ t: number; g: number }> = [];
  private key = "";

  /** 相手が変わったら (key が違えば) 忘れる */
  push(key: string, t: number, sec: number): void {
    if (key !== this.key) {
      this.key = key;
      this.hist = [];
    }
    const h = this.hist;
    if (h.length && t <= h[h.length - 1].t) return;
    h.push({ t, g: sec });
    while (h.length > 2 && h[1].t <= t - TREND_WINDOW) h.shift();
  }

  /** TREND_WINDOW 秒前からの差の変わり (+ = 開いた・− = 縮んだ・0 = 変わらない、分からない) */
  delta(): number {
    const h = this.hist;
    if (h.length < 2) return 0;
    const a = h[0];
    const b = h[h.length - 1];
    if (b.t - a.t < TREND_WINDOW * 0.5) return 0;
    const d = b.g - a.g;
    return Math.abs(d) < TREND_EPS ? 0 : d;
  }
}

// ---- 練習の幽霊との差 ----

/** 幽霊の 1 周を道のりと時刻の表にしたもの (道のりは増える一方) */
export interface GhostProfile {
  s: Float64Array;
  t: Float64Array;
  lap: number;
}

/**
 * 幽霊の記録 (0.1 秒ごとの [x, y, 向き]) を、コースの道のり (周の始まり = 0) と時刻の表にする。
 * 記録の間かくは 周の時間 ÷ 記録の数 とみる (刻みの端数でずれても、周の終わりで合うように)
 */
export function ghostProfile(track: Track, pts: readonly number[], lap: number): GhostProfile | null {
  const n = Math.floor(pts.length / 3);
  if (n < 2 || !(lap > 0)) return null;
  const L = track.length;
  const dt = lap / n;
  const s: number[] = [0];
  const t: number[] = [0];
  let hint = -1;
  let prev = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const q = queryTrack(track, pts[i * 3], pts[i * 3 + 1], hint);
    hint = q.index;
    // 周の始まりのそば: 線の手前 (L の近く) は マイナスに
    let d = q.s;
    if (i === 0 && d > L / 2) d -= L;
    else {
      while (d < prev - L / 2) d += L;
      while (d > prev + L / 2) d -= L;
    }
    prev = d;
    if (d > max + 1e-6) {
      max = d;
      s.push(d);
      t.push(dt * (i + 1));
    }
  }
  if (L > max) {
    s.push(L);
    t.push(lap);
  }
  return { s: Float64Array.from(s), t: Float64Array.from(t), lap };
}

/** 幽霊が周の道のり d を通った時刻 (秒、周の始まりから)。表の外は null */
export function ghostTimeAt(p: GhostProfile, d: number): number | null {
  const s = p.s;
  if (!(d >= s[0]) || d > s[s.length - 1]) return null;
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = s[hi] - s[lo];
  const u = span > 0 ? (d - s[lo]) / span : 0;
  return p.t[lo] + (p.t[hi] - p.t[lo]) * u;
}

/** 幽霊との差 (秒。+ = 幽霊より遅い・− = 速い)。周の始まりからの時間 lapT と、周の道のり lapDist */
export function ghostDelta(p: GhostProfile, lapT: number, lapDist: number): number | null {
  const g = ghostTimeAt(p, lapDist);
  return g === null ? null : lapT - g;
}

// ---- ピットの回数とタイヤの周 (部屋が数える) ----

/** 止まったとみる速さ (m/s) と時間 (秒、仮) */
export const STILL_SPEED = 0.5;
export const STILL_SECONDS = 2;

export interface StintState {
  /** ピットの道に入った回数 */
  pitStops: number;
  inPit: boolean;
  tire: TireCompound;
  wear: number;
  burst: boolean;
  /** 今のタイヤを履いたときの道のり (m) */
  fitAt: number;
  /** 止まり始めた時刻 (秒。動いていれば null) */
  stillSince: number | null;
}

export interface StintObs {
  inPit: boolean;
  tire: TireCompound;
  wear: number;
  burst: boolean;
  dist: number;
  speed: number;
  /** 止まったか数えるか (走り出したあと・ゴールとリタイアの前・ピットの外) */
  running: boolean;
}

export function newStint(tire: TireCompound, wear: number, dist: number): StintState {
  return { pitStops: 0, inPit: false, tire, wear, burst: false, fitAt: dist, stillSince: null };
}

/**
 * 1 回分の様子を見て、ピットに入った回数・タイヤを替えたか・止まっているかを更新する。t は秒。
 * タイヤを替えたとみるのは: 種類が変わった・減りが戻った (0.02 より多く)・破裂が直った・ピットの中で減りが 0.05 より多く増えた (もっと減った組に替えた)
 */
export function updateStint(s: StintState, o: StintObs, t: number): void {
  if (o.inPit && !s.inPit) s.pitStops++;
  const changed = o.tire !== s.tire || o.wear < s.wear - 0.02 || (s.burst && !o.burst) || (o.inPit && o.wear > s.wear + 0.05);
  if (changed) s.fitAt = o.dist;
  s.inPit = o.inPit;
  s.tire = o.tire;
  s.wear = o.wear;
  s.burst = o.burst;
  if (o.running && !o.inPit && o.speed < STILL_SPEED) s.stillSince ??= t;
  else s.stillSince = null;
}

/** 今のタイヤで走った周の数 (履いてからの道のり ÷ コースの長さ、切り捨て) */
export function tyreLaps(s: StintState, dist: number, trackLength: number): number {
  return Math.max(0, Math.floor((dist - s.fitAt) / trackLength));
}

export function isStopped(s: StintState, t: number): boolean {
  return s.stillSince !== null && t - s.stillSince >= STILL_SECONDS;
}
