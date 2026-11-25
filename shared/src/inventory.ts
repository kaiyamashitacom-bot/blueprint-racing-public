// 持ち物 (部品の数) とお店の値段。画面とサーバーの両方で使う
// 部品の箱の数は設計図 1 つごとに数える (設計図どうしで取り合わない。README の「仮にしてあること」と同じ)
import type { CarDesign } from "./design.ts";
import { countParts } from "./design.ts";
import { PARTS, STARTER_BOX, partDef } from "./parts.ts";
import { isItemId } from "./items.ts";
import { anyPartDef } from "./research.ts";

/** 部品の id → 持っている数 */
export type Inventory = Record<string, number>;

/**
 * はじめのお金 (仮)。500 → 1,000 (QA 2 回目 11/25「始めた人が何も買えない」)。
 * 整備の 1 段目 (800) はすぐ、いちばん安い運転手 (1,400 くらい) は 2〜3 レース、段階 3 の研究 (2,000) は 5 レースくらいで届く
 */
export const STARTING_MONEY = 1000;
/** 1 つの部品を持てる数の上限 (仮) */
export const MAX_PER_PART = 999;
/** 1 回に買える数 (仮) */
export const MAX_BUY = 50;
/** 公式のお店が売る段階 */
export const SHOP_MAX_TIER = 2;

/**
 * 公式のお店の値段 (仮)。段階 1〜2 の部品だけ。
 * 表にない段階 1〜2 の部品は shopPrice が種類と段階から決める
 */
const PRICE_TABLE: Readonly<Record<string, number>> = {
  seat: 300,
  frame: 10,
  eng_s1: 250,
  eng_m1: 400,
  eng_e2: 900,
  eng_p2: 1200,
  tire_n1: 60,
  tire_w1: 120,
  tire_l2: 220,
  tank_s1: 40,
  tank_l1: 120,
  tank_f2: 260,
  wing_s1: 100,
  wing_l2: 450,
  brake_1: 60,
  brake_2: 220,
};

const KIND_BASE: Record<string, number> = { seat: 300, frame: 10, engine: 300, tire: 80, tank: 80, wing: 120, brake: 60 };

/** お店の値段 (お店で売っていない部品は null) */
export function shopPrice(partId: string): number | null {
  const def = partDef(partId);
  if (!def || def.tier > SHOP_MAX_TIER) return null;
  return PRICE_TABLE[partId] ?? Math.round((KIND_BASE[def.kind] ?? 100) * (def.tier >= 2 ? 2.5 : 1));
}

/** お店の品ぞろえ (部品の表の順) */
export function shopList(): Array<{ id: string; price: number }> {
  const out: Array<{ id: string; price: number }> = [];
  for (const p of PARTS) {
    const price = shopPrice(p.id);
    if (price !== null) out.push({ id: p.id, price });
  }
  return out;
}

/** はじめの持ち物 = はじめの部品の箱 */
export function starterInventory(): Inventory {
  return { ...STARTER_BOX };
}

/** 知らない部品や変な数を取り除いた持ち物 (研究・進化・限界を超えた部品と、限界突破の品 items.ts も持てる) */
export function cleanInventory(inv: Record<string, unknown>): Inventory {
  const out: Inventory = {};
  for (const [id, n] of Object.entries(inv ?? {})) {
    if (!anyPartDef(id) && !isItemId(id)) continue;
    const v = Math.floor(Number(n));
    if (Number.isFinite(v) && v > 0) out[id] = Math.min(MAX_PER_PART, v);
  }
  return out;
}

/** 設計図 1 つに使える残りの数 (持っている数 − その設計図に置いた数)。マイナスは足りない */
export function remainingFor(design: CarDesign, inv: Inventory): Record<string, number> {
  const used = countParts(design);
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(inv)) out[id] = n;
  for (const [id, n] of Object.entries(used)) out[id] = (out[id] ?? 0) - n;
  return out;
}

/** 設計図が持ち物で作れるか。missing = 足りない部品と数 */
export function designFits(design: CarDesign, inv: Inventory): { ok: boolean; missing: Record<string, number> } {
  const missing: Record<string, number> = {};
  for (const [id, n] of Object.entries(remainingFor(design, inv))) if (n < 0) missing[id] = -n;
  return { ok: Object.keys(missing).length === 0, missing };
}

/** 買えるか (買えないときは理由)。qty 個買ったあとの数とお金も返す */
export function checkBuy(
  partId: string,
  qty: number,
  money: number,
  owned: number,
): { ok: true; cost: number; money: number; owned: number } | { ok: false; msg: string } {
  const price = shopPrice(partId);
  if (price === null) return { ok: false, msg: "お店で売っていない部品です" };
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, msg: "数がおかしいです" };
  if (qty > MAX_BUY) return { ok: false, msg: `1 回に買えるのは ${MAX_BUY} 個までです` };
  if (owned + qty > MAX_PER_PART) return { ok: false, msg: `1 つの部品は ${MAX_PER_PART} 個までしか持てません` };
  const cost = price * qty;
  if (cost > money) return { ok: false, msg: "お金が足りません" };
  return { ok: true, cost, money: money - cost, owned: owned + qty };
}
