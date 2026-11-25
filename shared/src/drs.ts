// DRS と 風よけ (スリップストリーム) (DECISIONS「車」)。
// DRS: 決まった区間 (直線) の手前の検知の線で、前の車と 1 秒以内なら、その区間でボタンを押すと空気の抵抗が減る。
//   押すと燃料とタイヤが少し減る。ブレーキを踏むか区間が終わると閉じ、その区間ではもう開けない (1 区間 1 回)。
//   旗 (SC・VSC)・雨・最初の周は使えない (レースが決める)。
// 風よけ: どの車でも、すぐ後ろを走ると空気の抵抗が少し減る。
// どちらも決まった計算。画面 (人の車) とサーバー (コンピューターの車) が同じ関数を呼ぶ。数は (仮)。
import type { Body } from "./collide.ts";
import type { CarState } from "./physics.ts";
import type { Track } from "./track.ts";

/** DRS の区間 (道のりはスタートの線からの m。手前はマイナスでもよい) */
export interface DrsZone {
  /** 検知の線 */
  detect: number;
  /** 区間の始まりと終わり */
  start: number;
  end: number;
}

/** コースに書く DRS の区間 (detect を書かなければ start の DRS_DETECT_BEFORE m 手前) */
export interface DrsZoneDef {
  start: number;
  end: number;
  detect?: number;
}

export interface DrsState {
  /** 使える区間の番号 (-1 = なし)。検知の線で前の車と DRS_GAP 秒以内だったとき */
  armed: number;
  /** 開いている */
  open: boolean;
  /** 最後に検知の線を越えたときの、前の車との差 (秒。前に誰もいなければ Infinity → 画面では -1) */
  gap: number;
}

/** 前の車との差がこれ以内なら使える (秒) */
export const DRS_GAP = 1.0;
/** 開いている間の空気の抵抗の割合 */
export const DRS_DRAG = 0.75;
/** 開くたびに使う燃料 (L) とタイヤのすり減り */
export const DRS_FUEL = 0.15;
export const DRS_WEAR = 0.004;
/** 検知の線は区間の始まりの何 m 手前か (書かなければ) */
export const DRS_DETECT_BEFORE = 60;
/** 濡れ具合がこれ以上だと使えない (レースが決めるときの目安) */
export const DRS_WET_MAX = 0.3;

/** 風よけ: 前の車との距離 (m) と横のずれ (m) の範囲、空気の抵抗が一番減る割合、効き始める速さ */
export const TOW_MIN = 2.5;
export const TOW_RANGE = 28;
export const TOW_WIDTH = 2.2;
export const TOW_DRAG = 0.2;
export const TOW_MIN_SPEED = 14;

/** 直線とみなす曲がり具合と長さ (書いていないコースで区間を決める) */
const STRAIGHT_CURV = 1 / 260;
const STRAIGHT_MIN = 150;

const zoneCache = new WeakMap<Track, DrsZone[]>();

/** コースの DRS の区間。コースに書いてなければ長い直線 (2 つまで) から決める */
export function drsZones(track: Track): DrsZone[] {
  const hit = zoneCache.get(track);
  if (hit) return hit;
  let zones: DrsZone[];
  if (track.def.drs) {
    zones = track.def.drs.map((z) => ({ detect: z.detect ?? z.start - DRS_DETECT_BEFORE, start: z.start, end: z.end }));
  } else {
    zones = deriveZones(track);
  }
  zoneCache.set(track, zones);
  return zones;
}

function deriveZones(track: Track): DrsZone[] {
  const n = track.n;
  const straight = (i: number) => Math.abs(track.curv[((i % n) + n) % n]) < STRAIGHT_CURV;
  // 曲がりから始める (輪の切れ目で直線が割れないように)
  let first = -1;
  for (let i = 0; i < n; i++) if (!straight(i)) {
    first = i;
    break;
  }
  if (first < 0) return [{ detect: -DRS_DETECT_BEFORE, start: 0, end: track.length * 0.5 }];
  const runs: Array<{ a: number; len: number }> = [];
  let a = -1;
  for (let k = 1; k <= n; k++) {
    const i = first + k;
    if (straight(i)) {
      if (a < 0) a = i;
    } else if (a >= 0) {
      runs.push({ a, len: (i - a) * track.step });
      a = -1;
    }
  }
  runs.sort((x, y) => y.len - x.len || x.a - y.a);
  return runs
    .filter((r) => r.len >= STRAIGHT_MIN)
    .slice(0, 2)
    .map((r) => {
      // 始まりを -L/2 .. L/2 に (スタートの線をまたぐ直線は手前がマイナス)
      const L = track.length;
      const s0 = mod(r.a * track.step + L / 2, L) - L / 2;
      const start = s0 + 35;
      const end = s0 + r.len - 15;
      return { detect: start - DRS_DETECT_BEFORE, start, end };
    })
    .sort((x, y) => mod(x.start, track.length) - mod(y.start, track.length));
}

const mod = (v: number, L: number) => ((v % L) + L) % L;

/** 道のり dist が区間 z の中か */
export function inDrsZone(track: Track, z: DrsZone, dist: number): boolean {
  const L = track.length;
  const len = z.end - z.start;
  return mod(dist - z.start, L) < len;
}

/** 道のり prev → now で、線 at (コースの位置) を越えたか */
function crosses(L: number, at: number, prev: number, now: number): boolean {
  return now > prev && Math.floor((prev - at) / L) < Math.floor((now - at) / L);
}

export function newDrsState(): DrsState {
  return { armed: -1, open: false, gap: Infinity };
}

/**
 * 毎刻み stepCar のあとに呼ぶ。prevDist = その刻みの前の道のり、others = ほかの車の道のり (ピット・ゴール・リタイアは除く)。
 * enabled = レースが DRS を許しているか (旗・雨・最初の周)。検知の線を越えたら前の車との差で使えるかを決める
 */
export function updateDrs(car: CarState, track: Track, prevDist: number, others: readonly number[], enabled: boolean): void {
  const st = (car.drs ??= newDrsState());
  const zones = drsZones(track);
  const L = track.length;
  if (!enabled || car.pit) {
    st.armed = -1;
    st.open = false;
  }
  zones.forEach((z, i) => {
    if (!crosses(L, z.detect, prevDist, car.dist)) return;
    // 前の車まで (コースの上で前にいる一番近い車。周回遅れも数える)
    let ahead = Infinity;
    for (const o of others) {
      const g = mod(o - car.dist, L);
      if (g > 0.5 && g < ahead) ahead = g;
    }
    const v = Math.max(10, Math.hypot(car.vx, car.vy));
    st.gap = ahead / v;
    st.armed = enabled && !car.pit && st.gap <= DRS_GAP ? i : -1;
    st.open = false;
  });
  // 区間を出たら終わり
  if (st.armed >= 0) {
    const z = zones[st.armed];
    if (!z) st.armed = -1;
    else if (!inDrsZone(track, z, car.dist) && mod(car.dist - z.detect, L) > mod(z.end - z.detect, L)) {
      st.armed = -1;
      st.open = false;
    }
  }
  if (st.armed < 0) st.open = false;
}

/** 今 DRS を開けるか (ボタンを光らせる) */
export function drsAvailable(car: CarState, track: Track): boolean {
  const st = car.drs;
  if (!st || st.armed < 0 || st.open || car.pit) return false;
  const z = drsZones(track)[st.armed];
  return !!z && inDrsZone(track, z, car.dist);
}

/** DRS を開く (使えるときだけ。燃料とタイヤが少し減る)。開いたら true */
export function openDrs(car: CarState, track: Track): boolean {
  if (!drsAvailable(car, track)) return false;
  car.drs!.open = true;
  car.fuel = Math.max(0, car.fuel - DRS_FUEL);
  if (!car.burst) car.wear = Math.min(0.999, car.wear + DRS_WEAR);
  return true;
}

/** DRS を閉じる (その区間ではもう開けない) */
export function closeDrs(car: CarState): void {
  if (car.drs?.open) {
    car.drs.open = false;
    car.drs.armed = -1;
  }
}

/** stepCar の中で呼ぶ: ブレーキ・区間の外・ピットで閉じる。開いていれば空気の抵抗の割合を返す */
export function drsDragFactor(car: CarState, track: Track, braking: boolean): number {
  const st = car.drs;
  if (!st || !st.open) return 1;
  const z = drsZones(track)[st.armed];
  if (braking || car.pit || !z || !inDrsZone(track, z, car.dist)) {
    st.open = false;
    st.armed = -1;
    return 1;
  }
  return DRS_DRAG;
}

/** 風よけの強さ 0..1 (すぐ後ろほど強い)。others はほかの車 (ピットの道の中・ゴール・リタイアは除いて渡す) */
export function towFactor(car: Pick<CarState, "x" | "y" | "heading" | "vx" | "vy">, others: readonly Body[]): number {
  const fx = Math.cos(car.heading);
  const fy = Math.sin(car.heading);
  const v = car.vx * fx + car.vy * fy;
  if (v < TOW_MIN_SPEED) return 0;
  let best = 0;
  for (const o of others) {
    const dx = o.x - car.x;
    const dy = o.y - car.y;
    const f = dx * fx + dy * fy;
    if (f < TOW_MIN || f > TOW_RANGE) continue;
    const l = Math.abs(-dx * fy + dy * fx);
    if (l > TOW_WIDTH) continue;
    // 同じ向きに走っている車だけ
    if (Math.cos(o.heading - car.heading) < 0.8) continue;
    const k = (1 - (f - TOW_MIN) / (TOW_RANGE - TOW_MIN)) * (1 - l / TOW_WIDTH);
    if (k > best) best = k;
  }
  return Math.min(1, best * Math.min(1, (v - TOW_MIN_SPEED) / 8 + 0.5));
}
