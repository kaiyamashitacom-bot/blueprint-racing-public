// 部品の表。マス目 (横 7 × 縦 11、縦が車の前後) に置く。
// w = 横のマス数、h = 縦のマス数 (回すと入れ替わる)。段階 (tier) と性格 (note) がある。
// 数の単位: 重さ kg・力 kW・燃料 L・ブレーキ m/s²
// タイヤの部品には特徴 (trait、tires.ts の TIRE_TRAITS) が 1 つある。段階が上がるほど 良い所が大きく 悪い所が小さい
import type { TireTrait } from "./tires.ts";

/** はじめからある種類 (お店の部品) */
export type BasePartKind = "seat" | "engine" | "tire" | "tank" | "wing" | "brake" | "frame";
/** 研究の木で開発する種類 (お店に並ばない。evolution.ts・research.ts。DECISIONS 11/25「部品は進化と研究で広げる」) */
export type DevPartKind = "cooler" | "battery" | "gearbox" | "susp" | "ballast";
export type PartKind = BasePartKind | DevPartKind;
export const BASE_PART_KINDS: readonly BasePartKind[] = ["seat", "engine", "tire", "tank", "wing", "brake", "frame"];
export const DEV_PART_KINDS: readonly DevPartKind[] = ["cooler", "battery", "gearbox", "susp", "ballast"];

export interface PartDef {
  id: string;
  kind: PartKind;
  name: string;
  tier: number;
  w: number;
  h: number;
  mass: number;
  /** エンジンの力 (kW) */
  power?: number;
  /** エンジンの燃料の食い方 (1 が普通) */
  fuelUse?: number;
  /** タイヤの握り */
  grip?: number;
  /** タイヤの特徴 (tires.ts の TIRE_TRAITS。なし = 特徴なし) */
  trait?: TireTrait;
  /** タンクの容量 (L) */
  fuel?: number;
  /** 羽根の押しつけ */
  downforce?: number;
  /** 羽根の空気の抵抗 */
  drag?: number;
  /** ブレーキの強さ (m/s²) */
  brake?: number;
  /** 冷却: 全開での燃料の食い方を減らす割合 (0.05 = 5%) */
  cool?: number;
  /** 電池: オーバーテイクの目盛りに足す秒 */
  battery?: number;
  /** ギア箱: マニュアルの速さの上がり分に足す割合 (0.01 = 1%)。オートマは力が この 15% だけ上がる */
  shift?: number;
  /** サスペンション: 縁石と芝で 握りの落ちと揺れ (抵抗) を減らす割合 (0..1) */
  susp?: number;
  /** 頑丈: 当たったときの傷みを減らす割合 (0..1、damage.ts) */
  sturdy?: number;
  /** 限界設計図で超えた回数 (1 = 5+、2 = 5++。evolution.ts) */
  limit?: number;
  /** 性格のひとこと */
  note: string;
}

export const PARTS: readonly PartDef[] = [
  { id: "seat", kind: "seat", name: "運転席", tier: 1, w: 1, h: 2, mass: 90, note: "必ず 1 つ。前に置くほど曲がりの反応がよい。壊れるとリタイア" },
  { id: "frame", kind: "frame", name: "骨組み", tier: 1, w: 1, h: 1, mass: 4, note: "部品どうしをつなぐ軽い骨" },

  { id: "eng_s1", kind: "engine", name: "小型エンジン", tier: 1, w: 2, h: 2, mass: 70, power: 55, fuelUse: 1, note: "軽くて扱いやすい" },
  { id: "eng_m1", kind: "engine", name: "中型エンジン", tier: 1, w: 2, h: 3, mass: 120, power: 95, fuelUse: 1, note: "力はあるが重い" },
  { id: "eng_e2", kind: "engine", name: "節約エンジン", tier: 2, w: 2, h: 2, mass: 65, power: 62, fuelUse: 0.7, note: "燃料が長もち" },
  { id: "eng_p2", kind: "engine", name: "高回転エンジン", tier: 2, w: 2, h: 3, mass: 115, power: 125, fuelUse: 1.4, note: "速いが燃料を食う" },

  { id: "tire_n1", kind: "tire", name: "細いタイヤ", tier: 1, w: 1, h: 2, mass: 12, grip: 1, trait: "tough", note: "ふつうのタイヤ。少し破裂しにくい" },
  { id: "tire_w1", kind: "tire", name: "太いタイヤ", tier: 1, w: 2, h: 2, mass: 22, grip: 1.8, trait: "bite", note: "よく握るが重い。少し食いつく" },
  { id: "tire_l2", kind: "tire", name: "軽いタイヤ", tier: 2, w: 1, h: 2, mass: 8, grip: 1.05, trait: "corner", note: "軽くて少しよく握る。曲がりに少し強い" },

  { id: "tank_s1", kind: "tank", name: "小さいタンク", tier: 1, w: 1, h: 1, mass: 4, fuel: 8, note: "8 L" },
  { id: "tank_l1", kind: "tank", name: "大きいタンク", tier: 1, w: 2, h: 2, mass: 12, fuel: 35, note: "35 L。満タンだと重い" },
  { id: "tank_f2", kind: "tank", name: "細長いタンク", tier: 2, w: 1, h: 3, mass: 7, fuel: 22, note: "22 L。すき間に入る" },

  { id: "wing_s1", kind: "wing", name: "小さい羽根", tier: 1, w: 3, h: 1, mass: 6, downforce: 0.9, drag: 0.06, note: "速いときに曲がりやすく。少し空気の抵抗" },
  { id: "wing_l2", kind: "wing", name: "大きい羽根", tier: 2, w: 5, h: 1, mass: 10, downforce: 1.8, drag: 0.13, note: "よく押しつけるが最高速が落ちる" },

  { id: "brake_1", kind: "brake", name: "ブレーキ", tier: 1, w: 1, h: 1, mass: 5, brake: 5, note: "ブレーキを踏んだときの止まる力を足す" },
  { id: "brake_2", kind: "brake", name: "強いブレーキ", tier: 2, w: 1, h: 1, mass: 7, brake: 8, note: "よく止まる" },
];

const BY_ID = new Map(PARTS.map((p) => [p.id, p]));

export function partDef(id: string): PartDef | undefined {
  return BY_ID.get(id);
}

export const KIND_NAMES: Record<PartKind, string> = {
  seat: "運転席",
  engine: "エンジン",
  tire: "タイヤ",
  tank: "燃料タンク",
  wing: "羽根",
  brake: "ブレーキ",
  frame: "骨組み",
  cooler: "冷却",
  battery: "電池",
  gearbox: "ギア箱",
  susp: "サスペンション",
  ballast: "重り",
};

/** はじめに持っている部品の箱 (段階 1 だけ) */
export const STARTER_BOX: Readonly<Record<string, number>> = {
  seat: 1,
  frame: 14,
  eng_s1: 1,
  eng_m1: 1,
  tire_n1: 4,
  tire_w1: 2,
  tank_s1: 2,
  tank_l1: 1,
  wing_s1: 2,
  brake_1: 2,
};
