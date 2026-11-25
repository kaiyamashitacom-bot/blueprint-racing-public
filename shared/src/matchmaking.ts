// 組み合わせ (普段のレース): 「すぐ走る」は同じ級で同じ長さ (2・5・10 周) を選んだ人と組む。
// 部屋も開ける (開く人がコース・周回数・級を決める。合言葉はなし)。空きはコンピューターが埋める (強さにばらつき)。
// 開いている部屋の一覧を渡すと、入る部屋を選ぶ (純粋な関数。部屋そのものは server が持つ)。
import { QUICK_LAPS } from "./protocol.ts";
import { MAX_CARS } from "./room.ts";
import { CLASS_IDS, LOWEST_CLASS, type ClassId } from "./season.ts";

export type QuickLaps = (typeof QUICK_LAPS)[number];

export function isQuickLaps(v: unknown): v is QuickLaps {
  return (QUICK_LAPS as readonly unknown[]).includes(v);
}

/** 1 チームが使う席 (自分 + 雇った運転手の 2 台目) */
export const CARS_PER_TEAM = 2;
/** 待合が締まるまでこれより短い部屋には入れない (仮、ms) */
export const JOIN_CUTOFF_MS = 3_000;
/** 開いた部屋の周回数の幅 (仮) */
export const CUSTOM_LAPS_MIN = 1;
export const CUSTOM_LAPS_MAX = 30;
/** 空きを埋めるコンピューターの上手さの幅 (級ごと、仮)。makeBrain(rand, skill) の skill に渡す */
export const CPU_SKILL_RANGE: Readonly<Record<ClassId, readonly [number, number]>> = {
  1: [0.82, 1.0],
  2: [0.78, 0.98],
  3: [0.74, 0.96],
  4: [0.7, 0.94],
  5: [0.66, 0.92],
};

export type RoomKind = "quick" | "custom";

/** server が持っている、まだ始まっていない (または始まった) 部屋の様子 */
export interface RoomInfo {
  id: string;
  kind: RoomKind;
  cls: ClassId;
  laps: number;
  trackId: string;
  /** 待合のとき true (始まったら入れない) */
  open: boolean;
  /** 人のチームが使っている席 */
  usedSeats: number;
  /** 席の数 (ふつう MAX_CARS) */
  seats: number;
  createdAt: number;
  /** 待合が締まる時刻 (ms)。0 = まだ決まっていない */
  closesAt: number;
  /** 開いた人 (custom の部屋だけ) */
  hostTeamId?: string;
}

/** 部屋を探す人 */
export interface Seeker {
  teamId: string;
  /** チームの級。最初の季節は null (一番下の級で走る) */
  cls: ClassId | null;
  /** 使う席 (ふつう CARS_PER_TEAM) */
  cars?: number;
}

export function seekerClass(s: Seeker): ClassId {
  return s.cls ?? LOWEST_CLASS;
}

function seatsOf(s: Seeker): number {
  return Math.max(1, Math.floor(s.cars ?? CARS_PER_TEAM));
}

export type JoinBlock = "started" | "class" | "full" | "closing";

/** 入れるなら null、入れないならわけ */
export function joinBlock(s: Seeker, room: RoomInfo, now: number): JoinBlock | null {
  if (!room.open) return "started";
  if (room.cls !== seekerClass(s)) return "class";
  if (room.usedSeats + seatsOf(s) > room.seats) return "full";
  if (room.closesAt > 0 && room.closesAt - now < JOIN_CUTOFF_MS) return "closing";
  return null;
}

/** すぐ走るの部屋の名前 (server の idFromName に使う) */
export function quickRoomId(cls: ClassId, laps: QuickLaps, n: number): string {
  return `quick-c${cls}-l${laps}-${n}`;
}

export type QuickPick = { action: "join"; roomId: string } | { action: "create"; roomId: string; cls: ClassId; laps: QuickLaps };

/**
 * すぐ走る: 同じ級・同じ周回数の、入れる部屋のうち一番埋まっている部屋へ (同じなら古い順・id 順)。
 * 無ければ新しい部屋 (使われていない一番小さい番号) を作る。
 */
export function pickQuickRoom(s: Seeker, laps: QuickLaps, rooms: readonly RoomInfo[], now: number): QuickPick {
  const cls = seekerClass(s);
  const ok = rooms
    .filter((r) => r.kind === "quick" && r.laps === laps && joinBlock(s, r, now) === null)
    .sort((a, b) => b.usedSeats - a.usedSeats || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ok.length > 0) return { action: "join", roomId: ok[0].id };
  const used = new Set(rooms.map((r) => r.id));
  let n = 0;
  while (used.has(quickRoomId(cls, laps, n))) n++;
  return { action: "create", roomId: quickRoomId(cls, laps, n), cls, laps };
}

/** 開いた部屋のうち、この人が入れるもの (古い順) */
export function listJoinableRooms(s: Seeker, rooms: readonly RoomInfo[], now: number): RoomInfo[] {
  return rooms
    .filter((r) => r.kind === "custom" && joinBlock(s, r, now) === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export interface CustomRoomSpec {
  trackId: string;
  laps: number;
  cls: ClassId;
}

export type RoomSpecIssue = "track" | "laps" | "class" | "host_class";

/**
 * 部屋を開くときの確かめ。knownTrackIds を渡すとコースがあるかも見る。
 * (仮) 開く人も同じ級でないと入れないので、級は開く人の級 (級なしなら一番下) だけ選べる。
 */
export function validateCustomRoom(spec: CustomRoomSpec, host: Seeker, knownTrackIds?: readonly string[]): RoomSpecIssue[] {
  const out: RoomSpecIssue[] = [];
  if (typeof spec.trackId !== "string" || spec.trackId === "" || (knownTrackIds && !knownTrackIds.includes(spec.trackId))) out.push("track");
  if (!Number.isInteger(spec.laps) || spec.laps < CUSTOM_LAPS_MIN || spec.laps > CUSTOM_LAPS_MAX) out.push("laps");
  if (!CLASS_IDS.includes(spec.cls)) out.push("class");
  else if (spec.cls !== seekerClass(host)) out.push("host_class");
  return out;
}

function lcg(seed: number): () => number {
  let s = Math.floor(Math.abs(seed)) % 2147483646 + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * 空き席を埋めるコンピューターの上手さ (0..1) を count 台分。同じ seed なら同じ。
 * 幅をまんべんなく使い (層に分けて 1 つずつ引く)、並びは混ぜる。
 */
export function cpuSkills(seed: number, count: number, cls: ClassId): number[] {
  const n = Math.max(0, Math.floor(count));
  const [lo, hi] = CPU_SKILL_RANGE[cls];
  const r = lcg(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + ((hi - lo) * (i + r())) / n);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 部屋の空き席の数 (コンピューターが埋める数) */
export function cpuSeatsFor(usedSeats: number, seats = MAX_CARS): number {
  return Math.max(0, seats - usedSeats);
}
