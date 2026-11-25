// タイヤ: F1 と同じ 5 種類 (柔らかい・普通・硬い・小雨用・大雨用)。走るとすり減る。
// すり減るほど握りが落ち、限界 (すり減り 1) を超えると破裂 (とても滑り、遅くしか走れない。ピットまでゆっくり戻る)。
// 濡れた路面では、溝のないタイヤ (S・M・H) はよく滑る。雨用 (I・W) は乾いた路面では遅く、すぐすり減る。
// 数は (仮)。青図サーキット (1 周 約 37 秒) で 柔らかい 約 3 周・普通 約 5 周・硬い 約 7 周で破裂する。

export type TireCompound = "S" | "M" | "H" | "I" | "W";

export interface TireDef {
  id: TireCompound;
  /** 名前 (画面用) */
  name: string;
  /** 1 文字 */
  short: string;
  /** 見た目の色 */
  color: string;
  /** 濡れ具合 0・0.35・0.7・1 のときの握りの倍率 (間はまっすぐつなぐ) */
  grip: readonly [number, number, number, number];
  /** すり減りの速さ (普通 = 1) */
  wear: number;
  /** 水たまりの効きにくさ (1 = そのまま効く、小さいほど平気) */
  puddle: number;
  /** 濡れ具合がこれより低いと、すり減りが速くなる (雨用だけ) */
  dryBelow: number;
  /** 乾いた路面でのすり減りの倍率の上乗せ (dryBelow の下で、乾くほど大きく) */
  dryWear: number;
  /** 溝のないタイヤ (乾いた路面用) */
  slick: boolean;
}

export const TIRE_DEFS: Readonly<Record<TireCompound, TireDef>> = {
  S: { id: "S", name: "柔らかい", short: "S", color: "#ef476f", grip: [1.06, 0.8, 0.55, 0.42], wear: 1.55, puddle: 1, dryBelow: 0, dryWear: 0, slick: true },
  M: { id: "M", name: "普通", short: "M", color: "#ffd166", grip: [1.0, 0.76, 0.52, 0.4], wear: 1, puddle: 1, dryBelow: 0, dryWear: 0, slick: true },
  H: { id: "H", name: "硬い", short: "H", color: "#f1f1f1", grip: [0.95, 0.73, 0.5, 0.38], wear: 0.66, puddle: 1, dryBelow: 0, dryWear: 0, slick: true },
  I: { id: "I", name: "小雨用", short: "I", color: "#06d6a0", grip: [0.86, 0.9, 0.8, 0.66], wear: 0.9, puddle: 0.55, dryBelow: 0.25, dryWear: 2, slick: false },
  W: { id: "W", name: "大雨用", short: "W", color: "#4ea8de", grip: [0.78, 0.82, 0.86, 0.85], wear: 0.8, puddle: 0.3, dryBelow: 0.45, dryWear: 3, slick: false },
};

export const TIRE_ORDER: readonly TireCompound[] = ["S", "M", "H", "I", "W"];
export const DEFAULT_TIRE: TireCompound = "M";

/** 破裂したときの握りの倍率と、出せる速さの上限 (m/s) */
export const BURST_GRIP = 0.4;
export const BURST_MAX_SPEED = 13;

/**
 * すり減りの速さのもと (仮)。1 刻みのすり減り = WEAR_K × 種類の倍率 × 路面の倍率 × 働き × 秒
 * 働き = 速さ × (0.4 + 握りの使い方) + 横滑り × 3
 */
export const WEAR_K = 1.28e-4;
/** 普通のタイヤが 1 m で減るおよその量 (コンピューターの見積もり用、仮) */
export const NOMINAL_WEAR_PER_M = 1 / 6300;

export function isTireCompound(v: unknown): v is TireCompound {
  return typeof v === "string" && v in TIRE_DEFS;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** 新品のタイヤの、濡れ具合 wet (0..1) での握りの倍率 */
export function compoundGrip(c: TireCompound, wet: number): number {
  const g = TIRE_DEFS[c].grip;
  const x = clamp(wet, 0, 1) / 0.35;
  if (x >= 2) {
    const u = (clamp(wet, 0, 1) - 0.7) / 0.3;
    return g[2] + (g[3] - g[2]) * u;
  }
  const i = Math.floor(x);
  const u = x - i;
  return g[i] + (g[i + 1] - g[i]) * u;
}

/** すり減りによる握りの倍率 (0 → 1、1 → 0.7)。0.7 を過ぎると急に落ちる */
export function wearGrip(wear: number): number {
  const w = clamp(wear, 0, 1);
  const cliff = Math.max(0, (w - 0.7) / 0.3);
  return 1 - 0.08 * w - 0.22 * cliff * cliff;
}

export interface TireLike {
  tire: TireCompound;
  wear: number;
  burst: boolean;
  /** タイヤの部品の特徴 (下の TireMods。なし = 特徴なし) */
  tireMods?: Readonly<TireMods> | null;
}

/** 今のタイヤの握りの倍率 (路面の種類・水たまりは別)。部品の特徴 (握り・雨) も掛ける。横・縦の向きの違いは physics.ts */
export function tireGrip(car: TireLike, wet: number, mods: Readonly<TireMods> | null | undefined = car.tireMods): number {
  if (car.burst) return BURST_GRIP;
  return compoundGrip(car.tire, wet) * wearGrip(car.wear) * traitGrip(mods, wet);
}

/** 路面の濡れ具合によるすり減りの倍率 */
export function wetWearFactor(c: TireCompound, wet: number): number {
  const d = TIRE_DEFS[c];
  if (d.slick) return 1 - 0.4 * clamp(wet, 0, 1);
  if (wet >= d.dryBelow) return 1;
  return 1 + d.dryWear * ((d.dryBelow - wet) / d.dryBelow);
}

/** その濡れ具合で一番握るタイヤ (乾いた路面は 普通 を代わりに使う) */
export function bestTireFor(wet: number): TireCompound {
  let best: TireCompound = "M";
  let g = compoundGrip("M", wet);
  for (const c of ["I", "W"] as const) {
    const x = compoundGrip(c, wet);
    if (x > g) {
      g = x;
      best = c;
    }
  }
  return best;
}

// ---- タイヤの部品の特徴 (11/25 ユーザー「タイヤにも特徴をつけよう」、DECISIONS の最後の項) ----
// 種類 (S・M・H・I・W) とは別に、タイヤの部品 (parts.ts の trait) に特徴が 1 つある。種類の効きに掛け合わせで効く。
// 段階 (1〜5) が上がるほど 良い所が大きく、悪い所が小さい。車に別々の特徴のタイヤを付けると、握りの割合で混ざる。
// 数は全部 (仮)。

export type TireTrait = "long" | "bite" | "rain" | "kerb" | "tough" | "corner" | "brake";

export interface TireTraitDef {
  id: TireTrait;
  /** 名前 (画面用) */
  name: string;
  /** 良い所と悪い所のひとこと */
  up: string;
  down: string;
  /** 段階 1〜5 の 良い所の大きさ (割合。tough だけは 限界を超えて走れる すり減りの量) */
  good: readonly [number, number, number, number, number];
  /** 段階 1〜5 の 悪い所の大きさ (割合) */
  bad: readonly [number, number, number, number, number];
}

export const TIRE_TRAITS: Readonly<Record<TireTrait, TireTraitDef>> = {
  long: { id: "long", name: "長持ち", up: "すり減りが遅い", down: "握りが少し低い", good: [0.1, 0.14, 0.2, 0.25, 0.3], bad: [0.025, 0.02, 0.015, 0.01, 0.006] },
  bite: { id: "bite", name: "食いつき", up: "握りが高い", down: "早くすり減る", good: [0.02, 0.028, 0.04, 0.05, 0.06], bad: [0.08, 0.07, 0.055, 0.04, 0.03] },
  rain: { id: "rain", name: "雨に強い", up: "濡れた路面と水たまりで滑りにくい", down: "乾いた路面で少し遅い", good: [0.05, 0.07, 0.1, 0.13, 0.16], bad: [0.025, 0.02, 0.015, 0.01, 0.006] },
  kerb: { id: "kerb", name: "縁石に強い", up: "縁石で握りが落ちにくく、減りにくい", down: "硬い作りで握りが少し低い", good: [0.3, 0.4, 0.55, 0.7, 0.85], bad: [0.012, 0.01, 0.008, 0.006, 0.004] },
  tough: { id: "tough", name: "破裂しにくい", up: "すり減りの限界を超えても少し走れる", down: "少し早くすり減る", good: [0.06, 0.08, 0.11, 0.14, 0.18], bad: [0.03, 0.025, 0.02, 0.015, 0.01] },
  corner: { id: "corner", name: "曲がりに強い", up: "横の握りが高い", down: "止まる力が少し低い", good: [0.025, 0.035, 0.05, 0.065, 0.08], bad: [0.05, 0.04, 0.03, 0.02, 0.012] },
  brake: { id: "brake", name: "ブレーキに強い", up: "止まる力が高い", down: "横の握りが少し低い", good: [0.04, 0.06, 0.09, 0.12, 0.15], bad: [0.025, 0.02, 0.015, 0.01, 0.006] },
};

export const TIRE_TRAIT_ORDER: readonly TireTrait[] = ["long", "bite", "rain", "kerb", "tough", "corner", "brake"];

/** 雨に強い: 水たまりの効きを減らす割合 = 良い所 × これ (仮) */
export const RAIN_PUDDLE_K = 2.5;
/** 縁石の上では すり減りがこの倍 (DECISIONS「縁石: 跳ねてタイヤが減る」、仮) */
export const KERB_WEAR = 1.5;

/** タイヤの部品の特徴が 走りに効く倍率 (車 1 台分。computeStats が混ぜて CarStats.tireMods に入れる) */
export interface TireMods {
  /** 握りの倍率 (どの路面でも) */
  grip: number;
  /** 乾いた路面 (濡れ具合 0) と 濡れた路面 (0.7 以上) の握りの倍率。間はまっすぐつなぐ */
  dry: number;
  wet: number;
  /** すり減りの速さの倍率 */
  wear: number;
  /** 水たまりの効きの倍率 (小さいほど平気) */
  puddle: number;
  /** 縁石の悪さ (握りが落ちる・余分に減る) の残る割合 (小さいほど平気) */
  kerb: number;
  /** すり減りの限界 (1) を超えて走れる量 (0 = すぐ破裂) */
  tough: number;
  /** 横の握り・止まる力の倍率 */
  lat: number;
  brake: number;
}

export const NO_TIRE_MODS: Readonly<TireMods> = Object.freeze({ grip: 1, dry: 1, wet: 1, wear: 1, puddle: 1, kerb: 1, tough: 0, lat: 1, brake: 1 });

export function isTireTrait(v: unknown): v is TireTrait {
  return typeof v === "string" && v in TIRE_TRAITS;
}

/** 特徴の 良い所・悪い所の大きさ (段階は 1〜5 に丸める) */
export function traitSize(trait: TireTrait, tier: number): { good: number; bad: number } {
  const d = TIRE_TRAITS[trait];
  const i = Math.max(0, Math.min(4, Math.round(tier) - 1));
  return { good: d.good[i], bad: d.bad[i] };
}

/** タイヤの部品 1 つの特徴の倍率 */
export function traitMods(trait: TireTrait | undefined, tier: number): TireMods {
  const m: TireMods = { ...NO_TIRE_MODS };
  if (!trait || !isTireTrait(trait)) return m;
  const { good, bad } = traitSize(trait, tier);
  switch (trait) {
    case "long":
      m.wear = 1 - good;
      m.grip = 1 - bad;
      break;
    case "bite":
      m.grip = 1 + good;
      m.wear = 1 + bad;
      break;
    case "rain":
      m.wet = 1 + good;
      m.dry = 1 - bad;
      m.puddle = Math.max(0, 1 - RAIN_PUDDLE_K * good);
      break;
    case "kerb":
      m.kerb = 1 - good;
      m.grip = 1 - bad;
      break;
    case "tough":
      m.tough = good;
      m.wear = 1 + bad;
      break;
    case "corner":
      m.lat = 1 + good;
      m.brake = 1 - bad;
      break;
    case "brake":
      m.brake = 1 + good;
      m.lat = 1 - bad;
      break;
  }
  return m;
}

/** いくつかのタイヤの特徴を、重み (握りの割合) で混ぜる。重みの合計が 0 なら特徴なし */
export function blendTireMods(list: ReadonlyArray<{ mods: TireMods; weight: number }>): TireMods {
  let total = 0;
  for (const x of list) total += Math.max(0, x.weight);
  if (!(total > 0)) return { ...NO_TIRE_MODS };
  const out: TireMods = { grip: 0, dry: 0, wet: 0, wear: 0, puddle: 0, kerb: 0, tough: 0, lat: 0, brake: 0 };
  const keys = Object.keys(out) as Array<keyof TireMods>;
  for (const x of list) {
    const w = Math.max(0, x.weight) / total;
    for (const k of keys) out[k] += x.mods[k] * w;
  }
  // みな同じ特徴のときに 1 からずれないように、ほぼ 1 なら 1 に
  for (const k of keys) if (k !== "tough" && Math.abs(out[k] - 1) < 1e-12) out[k] = 1;
  return out;
}

/** 特徴による握りの倍率 (濡れ具合 wet で 乾いた路面 → 濡れた路面) */
export function traitGrip(m: Readonly<TireMods> | null | undefined, wet: number): number {
  if (!m) return 1;
  const u = clamp(wet, 0, 1) / 0.7;
  const k = u >= 1 ? m.wet : m.dry + (m.wet - m.dry) * u;
  return m.grip * k;
}
