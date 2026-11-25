// 進化でだけできる部品 (枝分かれの性格ちがい) と、限界設計図で段階 5 を超えた部品 (5+・5++) の形。
// 進化の道すじ (どれからどれへ・お金・要る研究) は evolution.ts。ここは部品の形だけ (research.ts の anyPartDef が引く)。
// DECISIONS 11/25「部品は進化と研究で広げる」「限界突破の品」。数は全部 (仮)。
import type { PartDef, PartKind } from "./parts.ts";

const P = (p: PartDef): PartDef => p;

/** 進化でだけできる部品 (お店にも研究の表にもない)。枝分かれの「性格ちがい」 */
export const EVOLVED_PARTS: readonly PartDef[] = [
  // エンジン: 小型 → 軽さ寄り / 中型 → 頑丈の線 / 競技 → 詰めて小さく
  P({ id: "eng_s2", kind: "engine", name: "身軽な小型エンジン", tier: 2, w: 2, h: 2, mass: 58, power: 64, fuelUse: 1, note: "小型エンジンを削って軽く少し強く (軽さ寄り)" }),
  P({ id: "eng_m2", kind: "engine", name: "頑丈な中型エンジン", tier: 2, w: 2, h: 3, mass: 124, power: 104, fuelUse: 0.95, sturdy: 0.4, note: "当たっても傷みにくい (頑丈)" }),
  P({ id: "eng_m3", kind: "engine", name: "頑丈な競技エンジン", tier: 3, w: 2, h: 3, mass: 124, power: 140, fuelUse: 1.3, sturdy: 0.4, note: "競技エンジンほど速くないが 傷みにくく燃料も控えめ (頑丈)" }),
  P({ id: "eng_m4", kind: "engine", name: "鉄の競技エンジン", tier: 4, w: 2, h: 3, mass: 126, power: 163, fuelUse: 1.3, sturdy: 0.45, note: "とても傷みにくい (頑丈)" }),
  P({ id: "eng_c4", kind: "engine", name: "詰めた競技エンジン", tier: 4, w: 2, h: 2, mass: 90, power: 122, fuelUse: 1.45, note: "競技エンジンを 4 マスに詰めた。重くて燃料を食う (形が小さく)" }),
  // タイヤ: 細い → 頑丈 / 太い → 軽く / 競技の太い → 長くして握る
  P({ id: "tire_n2", kind: "tire", name: "芯の強いタイヤ", tier: 2, w: 1, h: 2, mass: 13, grip: 1.08, trait: "tough", sturdy: 0.4, note: "破裂しにくく 当たっても傷みにくい (頑丈)" }),
  P({ id: "tire_w2", kind: "tire", name: "締めた太いタイヤ", tier: 2, w: 2, h: 2, mass: 20, grip: 1.82, trait: "bite", note: "太いタイヤを少し軽く (軽さ寄り)" }),
  P({ id: "tire_x4", kind: "tire", name: "長い競技タイヤ", tier: 4, w: 2, h: 3, mass: 30, grip: 2.3, trait: "bite", note: "6 マスの大きなタイヤ。よく握るが重い (握り寄り・形が伸びる)" }),
  // 羽根: 小さい → 抵抗少なめ / 4 マスの中くらい
  P({ id: "wing_s2", kind: "wing", name: "反った小さい羽根", tier: 2, w: 3, h: 1, mass: 6, downforce: 1.05, drag: 0.065, note: "小さい羽根を反らせて少しよく押しつける" }),
  P({ id: "wing_m4", kind: "wing", name: "中くらいの羽根", tier: 4, w: 4, h: 1, mass: 8, downforce: 2.05, drag: 0.095, note: "4 マスの羽根。押しつけと抵抗の間 (形が変わる)" }),
  // ブレーキ: 頑丈
  P({ id: "brake_t3", kind: "brake", name: "頑丈なブレーキ", tier: 3, w: 1, h: 1, mass: 8, brake: 9.5, sturdy: 0.5, note: "少し重いが傷みにくい (頑丈)" }),
];

// ---------------------------------------------------------------- 限界突破 (5+・5++)

/** 限界設計図で超えられる回数 (1 つの部品に) */
export const LIMIT_MAX = 2;
/** 1 回超えるごとに 主な強さに掛ける倍率 (仮: +4%) */
export const LIMIT_GAIN = 0.04;
/** 限界を超えた部品の id の後ろ ("eng_p5" → "eng_p5_x1"・"eng_p5_x2") */
export const LIMIT_SUFFIX = "_x";

/** 種類ごとの「主な強さ」(限界設計図で上がる数)。ない種類 (運転席・骨組み・重り) は超えられない */
export const LIMIT_STAT: Readonly<Partial<Record<PartKind, keyof PartDef>>> = {
  engine: "power",
  tire: "grip",
  tank: "fuel",
  wing: "downforce",
  brake: "brake",
  cooler: "cool",
  battery: "battery",
  gearbox: "shift",
  susp: "susp",
};

/** 限界を超えた部品の id → 元の id と回数 (形がちがえば null) */
export function parseLimitId(id: string): { base: string; level: number } | null {
  const m = /^(.+)_x([1-9])$/.exec(id);
  if (!m) return null;
  const level = Number(m[2]);
  return level >= 1 && level <= LIMIT_MAX ? { base: m[1], level } : null;
}

export function limitId(base: string, level: number): string {
  return `${base}${LIMIT_SUFFIX}${level}`;
}

/** 段階 5 の部品 base を level 回超えた部品の形 (超えられない部品なら null) */
export function limitBrokenDef(base: PartDef, level: number): PartDef | null {
  const key = LIMIT_STAT[base.kind];
  if (!key || base.tier !== 5 || base.limit || !(level >= 1 && level <= LIMIT_MAX)) return null;
  const v = base[key];
  if (typeof v !== "number") return null;
  const mul = (1 + LIMIT_GAIN) ** level;
  const digits = key === "power" || key === "fuel" ? 10 : 1000;
  return {
    ...base,
    id: limitId(base.id, level),
    name: `${base.name} ${"5" + "+".repeat(level)}`,
    limit: level,
    [key]: Math.round(v * mul * digits) / digits,
    note: `限界設計図で ${level} 回超えた (${base.note})`,
  };
}
