// 画面とサーバーのやりとり (WebSocket で JSON)
import type { CarDesign } from "./design.ts";
import type { FlagInfo } from "./racecontrol.ts";
import { isTireCompound, type TireCompound } from "./tires.ts";
import type { TeamOrder } from "./teamorder.ts";
import type { TireSets } from "./tireset.ts";
import type { WeatherPlan } from "./weather.ts";

export type Phase = "idle" | "lobby" | "race" | "results";

export interface RosterEntry {
  id: string;
  name: string;
  design: CarDesign;
  bot: boolean;
  color: string;
  slot: number;
  /** チームの 2 台目なら、1 台目 (人の車) の id (11/25 足した。作戦の合図のボタンを出すか) */
  owner?: string;
}

export interface ResultRow {
  id: string;
  name: string;
  color: string;
  bot: boolean;
  pos: number;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  /** ゴールの時間 + 罰 (秒) */
  total: number;
  penalty: number;
  best: number | null;
  points: number;
  fastest: boolean;
  /** 人の車の変速: true = マニュアル (MT)・false = オートマ (AT)。コンピューターと前の画面の人は なし (11/25 足した) */
  mt?: boolean;
}

export interface PhaseInfo {
  phase: Phase;
  trackId: string;
  laps: number;
  /** 今の段階が終わる時刻 (サーバーの時計、ms) */
  endsAt: number;
  /** 信号が点き始める時刻と消える時刻 (サーバーの時計、ms) */
  lightsStartAt: number;
  lightsOutAt: number;
  chequered: boolean;
  results?: ResultRow[];
  /** 天気の予定 (待合のときから。時間は信号が消えてからの秒)。wetnessAt・forecastAt に渡す */
  weather?: WeatherPlan;
  /** 開いた部屋 (11/25 足した。すぐ走るの部屋と大会にはない): 部屋の id・級・開いた人の運転手名 */
  room?: { id: string; cls: number; host: string };
}

/**
 * snap の 1 台: [id, x, y, 向き, 道のり, 印, 周, 速さ x, 速さ y, タイヤ?, タイヤの周?, ピットの回数?]
 * 印: 1 ゴール・2 リタイア・4 コンピューターが代わりに運転・8 ピットの道の中・16 DRS が開いている・32 壊れた (落ちた) 部品がある・
 * 64 タイヤが破裂・128 コースの上で止まっている・256 オーバーテイクモードを使っている (11/25 足した)
 * 後ろの 3 つ (11/25 足した) は前のサーバーからは来ない。前の画面は読まずに捨てる
 */
export type SnapCar = [
  id: string,
  x: number,
  y: number,
  heading: number,
  dist: number,
  flags: number,
  laps: number,
  vx: number,
  vy: number,
  tire?: TireCompound,
  tyreLaps?: number,
  pitStops?: number,
];

/** snap の印 */
export const SNAP_FINISHED = 1;
export const SNAP_RETIRED = 2;
export const SNAP_AI = 4;
export const SNAP_PIT = 8;
export const SNAP_DRS = 16;
export const SNAP_BROKEN = 32;
export const SNAP_BURST = 64;
export const SNAP_STOPPED = 128;
export const SNAP_OT = 256;

/** snap の 1 台の、11/25 に足したところ (前のサーバーからなら tire などは null) */
export interface SnapTyre {
  tire: TireCompound | null;
  tyreLaps: number | null;
  pitStops: number | null;
  burst: boolean;
  stopped: boolean;
}

export function readSnapTyre(c: readonly unknown[]): SnapTyre {
  const flags = typeof c[5] === "number" ? c[5] : 0;
  const tire = isTireCompound(c[9]) ? c[9] : null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  return { tire, tyreLaps: n(c[10]), pitStops: n(c[11]), burst: !!(flags & SNAP_BURST), stopped: !!(flags & SNAP_STOPPED) };
}

export type ServerMsg =
  /** crew = ピットで止まる時間の倍率 (整備の組。ログインした人だけ)、second = 一緒に走る 2 台目の運転手の名前 (いるときだけ) */
  | { t: "welcome"; id: string; now: number; info: PhaseInfo; roster: RosterEntry[]; waiting: boolean; crew?: number; second?: string }
  | { t: "pong"; c: number; s: number }
  | { t: "full" }
  | { t: "error"; msg: string }
  | { t: "roster"; roster: RosterEntry[] }
  | { t: "phase"; info: PhaseInfo }
  /** flag = 旗・VSC・SC の様子 (racecontrol.ts。レース中だけ) */
  | {
      t: "snap";
      now: number;
      cars: SnapCar[];
      flag?: FlagInfo;
      /** 止まる場所がチームの相方の作業で使われている人の車の id (11/25 足した。ピットに入ったら手前で待つ) */
      busy?: string[];
    }
  | { t: "resume"; car: ResumeCar }
  | { t: "info"; text: string };

export interface ResumeCar {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  dist: number;
  fuel: number;
  lapsDone: number;
  lapStart: number;
  bestLap: number | null;
  penalty: number;
  tire?: TireCompound;
  wear?: number;
  burst?: boolean;
  /** 持っているタイヤの組 (tireset.ts。なし = 決まりなし) */
  sets?: TireSets;
  /** 部品の傷み (damage.ts の packDamage。なし = 無傷) と強く当たった回数 */
  dmg?: number[];
  hits?: number;
}

export type ClientMsg =
  /** token = ログインしているときの合い言葉 (なくてもよい。あれば賞金がチームの財布に入る) */
  | { t: "hello"; key: string; name: string; design: CarDesign; token?: string }
  | { t: "ping"; c: number }
  | {
      t: "state";
      x: number;
      y: number;
      h: number;
      vx: number;
      vy: number;
      dist: number;
      fuel: number;
      lapsDone: number;
      lapStart: number;
      best: number | null;
      penalty: number;
      /** タイヤ (なくてもよい) */
      tire?: TireCompound;
      wear?: number;
      burst?: boolean;
      /** ピットの道の中 (ほかの車とぶつからない) */
      pit?: boolean;
      /** 部品の傷み (damage.ts の packDamage。なし = 無傷) と強く当たった回数 (CarDamage.hits) */
      dmg?: number[];
      hits?: number;
      /** DRS が開いている */
      drs?: boolean;
      /** 持っているタイヤの組 (tireset.ts。代走のときに使う。なし = 決まりなし) */
      sets?: TireSets;
      /** 止まる場所で作業中 (pit.ts の inService。チームの 2 台目はこの間 手前で待つ。11/25 足した) */
      box?: boolean;
      /** オーバーテイクモードを使っている (11/25 足した。ほかの画面の名札に出す) */
      ot?: boolean;
      /** マニュアル (自分で変速) で走っている (11/25 足した。結果に AT / MT の印) */
      mt?: boolean;
    }
  | { t: "go"; at: number }
  /** mt = マニュアルで走った (11/25 足した。なし = 分からない) */
  | { t: "finish"; time: number; lapsDone: number; best: number | null; penalty: number; mt?: boolean }
  | { t: "retire" }
  /** 開いた部屋で、開いた人が待合を早めに終える (人が 2 人以上いるとき) */
  | { t: "start" }
  /** チームの 2 台目への作戦の合図 (teamorder.ts。11/25 足した。2 台目がいなければ何もしない) */
  | { t: "order"; order: TeamOrder };

export const CAR_COLORS = ["#ffd166", "#ef476f", "#06d6a0", "#8ecae6", "#f78c6b", "#c77dff", "#b5e48c", "#ffffff"];

export const QUICK_LAPS = [2, 5, 10] as const;
