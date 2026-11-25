// 周の数え方・順位・点。画面 (自分の車) とサーバー (コンピューターの車) の両方で使う
import type { CarState, StepEvents } from "./physics.ts";

/**
 * 点の並び (8 台のとき)。決まり (ユーザー 11/25): 1 位は 25 点、最下位とその 1 つ上 (下から 2 台) は 0 点。
 * 間は 18・15・12・10… を上から順に使う (仮)。台数が少なければ間を短くする (pointsFor)
 */
export const POINTS = [25, 18, 15, 12, 10, 8, 0, 0];
/** 間の点の並び (2 位から。仮) */
export const MIDDLE_POINTS = [18, 15, 12, 10, 8, 6, 4, 2, 1];
export const FASTEST_LAP_POINT = 1;
/** フライングの罰 (秒) */
export const JUMP_START_PENALTY = 5;
/** 近道の罰 (秒) = 3 + 近道した距離 / 20 */
export const cutPenalty = (meters: number) => 3 + meters / 20;

export interface LapState {
  lapsDone: number;
  lapStart: number;
  lastLap: number | null;
  bestLap: number | null;
  /** 一番速い周を出した時刻 (スタートからの秒。一番速い周が同じタイムのとき、先に出した車を選ぶ) */
  bestAt?: number;
  /** 足された罰の秒 */
  penalty: number;
  finished: boolean;
  finishTime: number;
  /** 燃料切れ・運転席が壊れて止まった */
  retired: boolean;
}

export function newLapState(): LapState {
  return { lapsDone: 0, lapStart: 0, lastLap: null, bestLap: null, penalty: 0, finished: false, finishTime: 0, retired: false };
}

export interface LapEvent {
  lap?: { time: number; valid: boolean };
  finished?: boolean;
  cut?: number;
  retired?: boolean;
}

/**
 * 1 刻みごとに呼ぶ。t はスタートの合図からの時間 (秒、刻みの終わり)。
 * chequered = 先頭がゴールした (次に線を越えたら終わり)
 */
export function updateLaps(car: CarState, st: LapState, ev: StepEvents, t: number, trackLength: number, totalLaps: number, chequered: boolean): LapEvent {
  const out: LapEvent = {};
  if (st.finished) return out;
  if (ev.cut) {
    const p = cutPenalty(ev.cut);
    st.penalty += p;
    out.cut = p;
  }
  const laps = Math.floor(car.dist / trackLength);
  if (laps > st.lapsDone) {
    const time = t - st.lapStart;
    const valid = !car.lapInvalid;
    st.lastLap = time;
    if (valid && (st.bestLap === null || time < st.bestLap)) {
      st.bestLap = time;
      st.bestAt = t;
    }
    out.lap = { time, valid };
    car.lapInvalid = false;
    st.lapStart = t;
    st.lapsDone = laps;
    if (st.lapsDone >= totalLaps || chequered) {
      st.finished = true;
      st.finishTime = t;
      out.finished = true;
    }
  }
  // 燃料切れ・運転席が壊れた (damage.ts) で止まったらリタイア
  if (!st.finished && !st.retired && car.started && (car.fuel <= 0 || car.damage?.out) && Math.hypot(car.vx, car.vy) < 0.3) {
    st.retired = true;
    out.retired = true;
  }
  return out;
}

export interface Standing {
  id: string;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  finishTime: number;
  penalty: number;
  dist: number;
}

/** 順位の順に並べる: ゴールした車 (周の多い順・時間+罰の少ない順)、走っている車 (道のりの多い順)、リタイア */
export function sortStandings<T extends Standing>(list: T[]): T[] {
  const rank = (a: T) => (a.finished ? 0 : a.retired ? 2 : 1);
  return [...list].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      if (a.lapsDone !== b.lapsDone) return b.lapsDone - a.lapsDone;
      return a.finishTime + a.penalty - (b.finishTime + b.penalty);
    }
    return b.dist - a.dist;
  });
}

/**
 * 順位 position (0 = 1 位) の点。field = そのレースの台数 (完走できなかった車も数える)。
 * 1 位は 25、下から 2 台は 0、間は MIDDLE_POINTS を上から。2 台以下でも 1 位は 25
 */
export function pointsFor(position: number, field = 8): number {
  if (position < 0 || position >= Math.max(1, field)) return 0;
  if (position === 0) return 25;
  if (position >= field - 2) return 0;
  return MIDDLE_POINTS[position - 1] ?? 0;
}

/**
 * 結果の札の時間の字。1 位は合計、1 位と同じ周の数で終えた車は 1 位との差、周遅れでゴールした車は「+N 周」
 * (周遅れの車の時間の差は意味がない)、ゴールしていなければ周の数かリタイア
 */
export function resultTimeText(
  r: { id: string; finished: boolean; retired: boolean; lapsDone: number; total: number },
  win: { id: string; lapsDone: number; total: number } | undefined,
): string {
  if (!r.finished) return r.retired ? "リタイア" : `${r.lapsDone} 周`;
  if (!win || r.id === win.id) return formatTime(r.total);
  const down = win.lapsDone - r.lapsDone;
  if (down > 0) return `+${down} 周`;
  return `+${Math.max(0, r.total - win.total).toFixed(3)}`;
}

/**
 * 一番速い周の車 (なし = 誰も周を走り終えていない)。list は順位の順に渡す。
 * タイムは 1/1000 秒で比べ、同じなら先に出した車 (bestAt が小さい)、それも同じなら順位が上の車
 */
export function pickFastest(list: ReadonlyArray<{ id: string; best: number | null; bestAt?: number }>): string {
  let id = "";
  let ms = Infinity;
  let at = Infinity;
  for (const c of list) {
    if (c.best === null || !Number.isFinite(c.best)) continue;
    const m = Math.round(c.best * 1000);
    const a = c.bestAt ?? Infinity;
    // 同じ速さで同じ時刻なら、先に並んでいる (順位が上の) 車のまま
    if (m < ms || (m === ms && a < at)) {
      id = c.id;
      ms = m;
      at = a;
    }
  }
  return id;
}

export function formatTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "--:--.---";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
