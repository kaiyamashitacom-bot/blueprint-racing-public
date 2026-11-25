// 部品の進化と限界突破 (DECISIONS 11/25「部品は進化と研究で広げる」「限界突破の品」)。
// - 進化: 持っている部品 1 つを、お金 + 研究の進み (要る研究が済んでいること) で 1 つ上の部品にする。持ち物から 1 つ出て 1 つ入る
//   ところどころで枝分かれ (力寄り / 燃費寄り・軽さ寄り / 頑丈 …)。形 (占めるマス) が少し変わるものもある。段階は 1〜5 のまま
// - 限界突破: 段階 5 の部品 1 つ + 限界設計図 1 つ → 5+ (もう 1 回で 5++)。1 回で主な強さ +4% (evoparts.ts)
// 画面とサーバーの両方で使う。お金のかかる関数は財布 (funds) を受け取り、払うお金 (cost) を返す。数は全部 (仮)。
import { LIMIT_MAX, LIMIT_STAT, limitId, parseLimitId } from "./evoparts.ts";
import { MAX_PER_PART, type Inventory } from "./inventory.ts";
import { ITEM_IDS, itemCount, removeItem } from "./items.ts";
import type { PartDef } from "./parts.ts";
import { anyPartDef, RESEARCH, researchDef, type ResearchState } from "./research.ts";

export interface EvolutionRecipe {
  /** 進化の id ("e_" + 元 + "_" + 先) */
  id: string;
  from: string;
  to: string;
  /** 済んでいる要る研究 (段階 2 の先は null = お金だけ) */
  requires: string | null;
  /** 枝の性格のひとこと (分かれ道のときだけ) */
  branch?: string;
}

/** 進化のお金 = 先の部品の種類の土台 (research.ts の buildKindBase) × 段階の倍率 (作るよりは安い: 元の部品を出すので) */
export const EVOLVE_TIER_MUL: Readonly<Record<number, number>> = { 2: 1.5, 3: 3, 4: 6, 5: 12 };

const R = (from: string, to: string, requires: string | null, branch?: string): EvolutionRecipe => ({ id: `e_${from}_${to}`, from, to, requires, ...(branch ? { branch } : {}) });

/** 進化の道すじ (元 → 先)。枝分かれは同じ元から 2 つ以上 */
export const EVOLUTIONS: readonly EvolutionRecipe[] = [
  // ---- エンジン ----
  R("eng_s1", "eng_e2", null, "燃費寄り"),
  R("eng_s1", "eng_s2", null, "軽さ寄り"),
  R("eng_m1", "eng_p2", null, "力寄り"),
  R("eng_m1", "eng_m2", null, "頑丈"),
  R("eng_p2", "eng_p3", "r_eng_p3"),
  R("eng_e2", "eng_e3", "r_eng_e3"),
  R("eng_s2", "eng_l3", "r_eng_l3"),
  R("eng_m2", "eng_m3", "r_eng_p3"),
  R("eng_p3", "eng_p4", "r_eng_p4", "力寄り"),
  R("eng_p3", "eng_c4", "r_eng_p4", "小さく (2×2)"),
  R("eng_m3", "eng_m4", "r_eng_p4"),
  R("eng_e3", "eng_e4", "r_eng_e4"),
  R("eng_l3", "eng_l4", "r_eng_l4"),
  R("eng_p4", "eng_p5", "r_eng_p5"),
  R("eng_m4", "eng_p5", "r_eng_p5"),
  R("eng_c4", "eng_b5", "r_eng_b5"),
  R("eng_e4", "eng_b5", "r_eng_b5"),
  R("eng_l4", "eng_b5", "r_eng_b5"),
  // ---- タイヤ ----
  R("tire_n1", "tire_l2", null, "軽さ寄り"),
  R("tire_n1", "tire_n2", null, "頑丈"),
  R("tire_w1", "tire_w2", null),
  R("tire_l2", "tire_n3", "r_tire_n3"),
  R("tire_n2", "tire_n3", "r_tire_n3"),
  R("tire_w2", "tire_w3", "r_tire_w3"),
  R("tire_n3", "tire_n4", "r_tire_n4"),
  R("tire_w3", "tire_w4", "r_tire_w4", "長持ち"),
  R("tire_w3", "tire_x4", "r_tire_w4", "握り寄り (2×3)"),
  R("tire_n4", "tire_n5", "r_tire_n5"),
  R("tire_w4", "tire_w5", "r_tire_w5"),
  R("tire_x4", "tire_w5", "r_tire_w5"),
  // ---- タンク ----
  R("tank_s1", "tank_f2", null),
  R("tank_f2", "tank_f3", "r_tank_f3"),
  R("tank_l1", "tank_l3", "r_tank_l3"),
  R("tank_f3", "tank_f4", "r_tank_f4"),
  R("tank_l3", "tank_l4", "r_tank_l4"),
  R("tank_l4", "tank_l5", "r_tank_l5"),
  // ---- 羽根 ----
  R("wing_s1", "wing_s2", null, "抵抗少なめ"),
  R("wing_s1", "wing_l2", null, "押しつけ (5 マス)"),
  R("wing_s2", "wing_s3", "r_wing_s3"),
  R("wing_l2", "wing_l3", "r_wing_l3"),
  R("wing_s3", "wing_s4", "r_wing_s4", "抵抗少なめ"),
  R("wing_s3", "wing_m4", "r_wing_s4", "釣り合い (4 マス)"),
  R("wing_l3", "wing_l4", "r_wing_l4", "押しつけ"),
  R("wing_l3", "wing_m4", "r_wing_l4", "釣り合い (4 マス)"),
  R("wing_s4", "wing_b5", "r_wing_b5"),
  R("wing_l4", "wing_b5", "r_wing_b5"),
  R("wing_m4", "wing_b5", "r_wing_b5"),
  // ---- ブレーキ ----
  R("brake_1", "brake_2", null),
  R("brake_2", "brake_3", "r_brake_3", "強さ寄り"),
  R("brake_2", "brake_l3", "r_brake_l3", "軽さ寄り"),
  R("brake_2", "brake_t3", "r_brake_3", "頑丈"),
  R("brake_3", "brake_4", "r_brake_4"),
  R("brake_l3", "brake_4", "r_brake_4"),
  R("brake_t3", "brake_4", "r_brake_4"),
  R("brake_4", "brake_5", "r_brake_5"),
  // ---- 新しい種類 (段階 3 は研究で作る。そこから育てる) ----
  R("cool_3", "cool_4", "r_cool_4", "燃費寄り"),
  R("cool_3", "cool_4l", "r_cool_4l", "軽さ寄り"),
  R("cool_4", "cool_5", "r_cool_5"),
  R("cool_4l", "cool_5", "r_cool_5"),
  R("batt_3", "batt_4", "r_batt_4", "量寄り"),
  R("batt_3", "batt_4l", "r_batt_4l", "軽さ寄り"),
  R("batt_4", "batt_5", "r_batt_5"),
  R("batt_4l", "batt_5", "r_batt_5"),
  R("gear_3", "gear_4", "r_gear_4", "速さ寄り"),
  R("gear_3", "gear_4t", "r_gear_4t", "頑丈"),
  R("gear_4", "gear_5", "r_gear_5"),
  R("gear_4t", "gear_5", "r_gear_5"),
  R("susp_3", "susp_4", "r_susp_4", "縁石寄り"),
  R("susp_3", "susp_4l", "r_susp_4l", "軽さ寄り"),
  R("susp_4", "susp_5", "r_susp_5"),
  R("susp_4l", "susp_5", "r_susp_5"),
  R("ballast_3", "ballast_4", "r_ballast_4"),
  R("ballast_4", "ballast_5", "r_ballast_5"),
];

const BY_ID = new Map(EVOLUTIONS.map((r) => [r.id, r]));

export function evolutionRecipe(id: string): EvolutionRecipe | undefined {
  return BY_ID.get(id);
}

/** その部品から進める先 (枝分かれなら 2 つ以上) */
export function evolutionsFrom(partId: string): EvolutionRecipe[] {
  return EVOLUTIONS.filter((r) => r.from === partId);
}

/** その部品へ進める元 */
export function evolutionsTo(partId: string): EvolutionRecipe[] {
  return EVOLUTIONS.filter((r) => r.to === partId);
}

/** 進化のお金 */
export function evolveCost(r: EvolutionRecipe): number {
  const to = anyPartDef(r.to);
  if (!to) return 0;
  return Math.round((RESEARCH.buildKindBase[to.kind] ?? 100) * (EVOLVE_TIER_MUL[to.tier] ?? 12));
}

export type EvolveError = "not_found" | "locked" | "no_part" | "no_money" | "too_many" | "max" | "no_item";

/** 進化・限界突破・かけらの結果 (できなければ わけ) */
export type EvoResult<T> = ({ ok: true } & T) | { ok: false; error: EvolveError };
const fail = (error: EvolveError): { ok: false; error: EvolveError } => ({ ok: false, error });

/** わけの言葉 (画面とサーバー) */
export const EVOLVE_ERROR_TEXT: Readonly<Record<EvolveError, string>> = {
  not_found: "その進化はありません",
  locked: "まだできません (先に済ませる研究があります)",
  no_part: "その部品を持っていません",
  no_money: "お金が足りません",
  too_many: "持てる数を超えます",
  max: "これ以上は超えられません (5++ まで・段階 5 の部品だけ)",
  no_item: "品が足りません",
};

/** 進化できるか (お金は funds で見る。null なら見ない) */
export function canEvolve(recipeId: string, inv: Readonly<Inventory>, research: Readonly<ResearchState>, funds: number | null): "ok" | EvolveError {
  const r = evolutionRecipe(recipeId);
  if (!r || !anyPartDef(r.from) || !anyPartDef(r.to)) return "not_found";
  if (r.requires && !research.done.includes(r.requires)) return "locked";
  if ((inv[r.from] ?? 0) < 1) return "no_part";
  if ((inv[r.to] ?? 0) + 1 > MAX_PER_PART) return "too_many";
  if (funds !== null && funds < evolveCost(r)) return "no_money";
  return "ok";
}

/** 進化させる: 返る cost を財布から引き、持ち物を inventory に置きかえる (元 −1・先 +1) */
export function evolvePart(recipeId: string, inv: Readonly<Inventory>, research: Readonly<ResearchState>, funds: number): EvoResult<{ cost: number; inventory: Inventory; from: string; to: string }> {
  const can = canEvolve(recipeId, inv, research, funds);
  if (can !== "ok") return fail(can);
  const r = evolutionRecipe(recipeId)!;
  const out: Inventory = { ...inv };
  out[r.from] = (out[r.from] ?? 0) - 1;
  if (out[r.from] <= 0) delete out[r.from];
  out[r.to] = (out[r.to] ?? 0) + 1;
  return { ok: true, cost: evolveCost(r), inventory: out, from: r.from, to: r.to };
}

/** 研究の木の「要る研究」の名前 (画面用) */
export function recipeRequiresName(r: EvolutionRecipe): string | null {
  return r.requires ? (researchDef(r.requires)?.part.name ?? r.requires) : null;
}

// ---------------------------------------------------------------- 限界突破

/** その部品は限界を超えられるか (段階 5・主な強さがある・まだ 2 回でない) */
export function canLimitBreak(partId: string): boolean {
  return nextLimitId(partId) !== null;
}

/** 次の限界の部品の id (超えられなければ null)。"eng_p5" → "eng_p5_x1"、"eng_p5_x1" → "eng_p5_x2" */
export function nextLimitId(partId: string): string | null {
  const p = parseLimitId(partId);
  const base = p ? p.base : partId;
  const level = p ? p.level : 0;
  const def = anyPartDef(base);
  if (!def || def.tier !== 5 || def.limit || !LIMIT_STAT[def.kind] || level >= LIMIT_MAX) return null;
  const id = limitId(base, level + 1);
  return anyPartDef(id) ? id : null;
}

/** 限界の回数 (0 = 超えていない) */
export function limitLevel(def: Pick<PartDef, "limit"> | undefined): number {
  return def?.limit ?? 0;
}

/** 限界を超える: 部品 1 つと限界設計図 1 つを出し、超えた部品 1 つを入れる (お金はかからない) */
export function limitBreak(partId: string, inv: Readonly<Inventory>): EvoResult<{ inventory: Inventory; from: string; to: string }> {
  const def = anyPartDef(partId);
  if (!def) return fail("not_found");
  const to = nextLimitId(partId);
  if (!to) return fail("max");
  if ((inv[partId] ?? 0) < 1) return fail("no_part");
  if (itemCount(inv, ITEM_IDS.limitBlueprint) < 1) return fail("no_item");
  if ((inv[to] ?? 0) + 1 > MAX_PER_PART) return fail("too_many");
  const used = removeItem(inv, ITEM_IDS.limitBlueprint, 1);
  if (!used.ok) return fail("no_item");
  const out = { ...used.inventory };
  out[partId] = (out[partId] ?? 0) - 1;
  if (out[partId] <= 0) delete out[partId];
  out[to] = (out[to] ?? 0) + 1;
  return { ok: true, inventory: out, from: partId, to };
}
