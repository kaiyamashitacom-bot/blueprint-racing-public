// 限界突破の品 (DECISIONS 11/25「限界突破の品」「走って点をためて交換」)。持ち物 (inventory) に部品と並べて「item:…」の id で置く。
// - 限界設計図: 段階 5 の部品を 5+ → 5++ に (evolution.ts の limitBreak)
// - 特別指導書: 雇った運転手の育つ上限 (伸びしろ) を能力ごとに +5 (100 まで)。1 人に 2 回まで
// - 限界突破のかけら 10 個 = 限界設計図 1 つ・指導のかけら 10 個 = 特別指導書 1 つ (走行点の交換で使う予定)
// - 手に入るのは景品とギフトコードだけ。お店で買えず、市場でも売り買いできない。コンピューターのチームは使わない
// 走行点の交換 (あとで別に作る) は addItem・removeItem・convertShards を使う。数は全部 (仮)。
import { STAT_KEYS, type Driver } from "./drivers.ts";
import type { Inventory } from "./inventory.ts";

export const ITEM_IDS = {
  limitBlueprint: "item:limit_bp",
  coachBook: "item:coach_book",
  limitShard: "item:limit_shard",
  coachShard: "item:coach_shard",
} as const;

export type ItemId = (typeof ITEM_IDS)[keyof typeof ITEM_IDS];

export interface ItemDef {
  id: ItemId;
  name: string;
  note: string;
  /** かけらなら できる品 */
  makes?: ItemId;
}

export const ITEM_DEFS: readonly ItemDef[] = [
  { id: ITEM_IDS.limitBlueprint, name: "限界設計図", note: "段階 5 の部品の限界を 1 つ超える (5+ → 5++。1 回で主な強さ +4%)" },
  { id: ITEM_IDS.coachBook, name: "特別指導書", note: "雇った運転手の育つ上限を 能力ごとに +5 (100 まで。1 人に 2 回まで)" },
  { id: ITEM_IDS.limitShard, name: "限界突破のかけら", note: "10 個で 限界設計図 1 つ", makes: ITEM_IDS.limitBlueprint },
  { id: ITEM_IDS.coachShard, name: "指導のかけら", note: "10 個で 特別指導書 1 つ", makes: ITEM_IDS.coachBook },
];

/** かけら何個で 1 つになるか */
export const SHARDS_PER_ITEM = 10;
/** 1 つの品を持てる数 (inventory.ts の MAX_PER_PART と同じ) */
export const ITEM_MAX = 999;
/** 特別指導書: 1 回で伸びしろに足す数・1 人に使える回数・上限 */
export const COACH_GAIN = 5;
export const COACH_MAX = 2;
export const COACH_STAT_CAP = 100;

const DEFS = new Map<string, ItemDef>(ITEM_DEFS.map((d) => [d.id, d]));

export function itemDef(id: string): ItemDef | undefined {
  return DEFS.get(id);
}

export function isItemId(id: unknown): id is ItemId {
  return typeof id === "string" && DEFS.has(id);
}

export function itemLabel(id: string): string {
  return DEFS.get(id)?.name ?? id;
}

/** 持っている数 */
export function itemCount(inv: Readonly<Inventory>, id: ItemId): number {
  return Math.max(0, Math.floor(inv[id] ?? 0));
}

/** 持ち物のうち品だけ (画面用) */
export function inventoryItems(inv: Readonly<Inventory>): Array<{ def: ItemDef; count: number }> {
  return ITEM_DEFS.map((def) => ({ def, count: itemCount(inv, def.id) })).filter((x) => x.count > 0);
}

/** 持ち物のうち部品だけ (品を除く) */
export function inventoryParts(inv: Readonly<Inventory>): Inventory {
  const out: Inventory = {};
  for (const [id, n] of Object.entries(inv)) if (!isItemId(id)) out[id] = n;
  return out;
}

export type ItemError = "bad_item" | "bad_amount" | "no_item" | "too_many" | "max";
export type ItemResult<T> = ({ ok: true } & T) | { ok: false; error: ItemError };

export const ITEM_ERROR_TEXT: Readonly<Record<ItemError, string>> = {
  bad_item: "その品はありません",
  bad_amount: "数がおかしいです",
  no_item: "品が足りません",
  too_many: "持てる数を超えます",
  max: "この運転手にはもう 2 回使いました",
};

const okN = (n: number) => Number.isInteger(n) && n >= 1;

/** 品を足す (新しい持ち物を返す) */
export function addItem(inv: Readonly<Inventory>, id: string, n = 1): ItemResult<{ inventory: Inventory }> {
  if (!isItemId(id)) return { ok: false, error: "bad_item" };
  if (!okN(n)) return { ok: false, error: "bad_amount" };
  const next = itemCount(inv, id) + n;
  if (next > ITEM_MAX) return { ok: false, error: "too_many" };
  return { ok: true, inventory: { ...inv, [id]: next } };
}

/** 品を出す (足りなければ断る) */
export function removeItem(inv: Readonly<Inventory>, id: string, n = 1): ItemResult<{ inventory: Inventory }> {
  if (!isItemId(id)) return { ok: false, error: "bad_item" };
  if (!okN(n)) return { ok: false, error: "bad_amount" };
  const next = itemCount(inv, id) - n;
  if (next < 0) return { ok: false, error: "no_item" };
  const out: Inventory = { ...inv };
  if (next === 0) delete out[id];
  else out[id] = next;
  return { ok: true, inventory: out };
}

/** かけらを品にする: かけら SHARDS_PER_ITEM × count 個 → 品 count 個 */
export function convertShards(inv: Readonly<Inventory>, shardId: string, count = 1): ItemResult<{ inventory: Inventory; made: ItemId; count: number }> {
  const def = itemDef(shardId);
  if (!def?.makes) return { ok: false, error: "bad_item" };
  if (!okN(count)) return { ok: false, error: "bad_amount" };
  const r = removeItem(inv, def.id, SHARDS_PER_ITEM * count);
  if (!r.ok) return r;
  const a = addItem(r.inventory, def.makes, count);
  if (!a.ok) return a;
  return { ok: true, inventory: a.inventory, made: def.makes, count };
}

/** 今 作れる数 (かけらの数 ÷ 10) */
export function shardsReady(inv: Readonly<Inventory>, shardId: ItemId): number {
  return Math.floor(itemCount(inv, shardId) / SHARDS_PER_ITEM);
}

// ---------------------------------------------------------------- 特別指導書

/** 特別指導書を使った回数 (Driver に足した coached。無ければ 0) */
export function coachedCount(d: Driver): number {
  const v = (d as Driver & { coached?: number }).coached;
  return typeof v === "number" && v > 0 ? Math.floor(v) : 0;
}

/** 運転手に特別指導書を使う: 伸びしろを能力ごとに +5 (100 まで)。今の能力は変わらず、このあと育つ */
export function coachDriver(d: Driver): ItemResult<{ driver: Driver }> {
  const used = coachedCount(d);
  if (used >= COACH_MAX) return { ok: false, error: "max" };
  const potential = { ...d.potential };
  for (const k of STAT_KEYS) potential[k] = Math.min(COACH_STAT_CAP, potential[k] + COACH_GAIN);
  return { ok: true, driver: { ...d, potential, coached: used + 1 } as Driver };
}

// ---------------------------------------------------------------- 景品

export type PrizeKey =
  | "classConstructor"
  | "overallConstructor"
  | "classDriver"
  | "overallDriver"
  | "championStreak"
  | "leagueWeek"
  | "tournamentWin"
  | "timeAttackWeek";

/** 景品ごとの品と数 (DECISIONS 11/25: 景品ごとに どちらかを決める。仮) */
export const PRIZE_ITEMS: Readonly<Record<PrizeKey, { item: ItemId; count: number; label: string }>> = {
  classConstructor: { item: ITEM_IDS.limitBlueprint, count: 1, label: "級のチャンピオン" },
  overallConstructor: { item: ITEM_IDS.limitBlueprint, count: 2, label: "総合のチャンピオン" },
  classDriver: { item: ITEM_IDS.coachBook, count: 1, label: "級のドライバーズチャンピオン" },
  overallDriver: { item: ITEM_IDS.coachBook, count: 2, label: "総合のドライバーズチャンピオン" },
  championStreak: { item: ITEM_IDS.coachBook, count: 1, label: "王者を 7 日続けて守った" },
  leagueWeek: { item: ITEM_IDS.coachBook, count: 1, label: "リーグ戦の週の 1 位" },
  tournamentWin: { item: ITEM_IDS.limitBlueprint, count: 1, label: "大会の優勝" },
  timeAttackWeek: { item: ITEM_IDS.limitBlueprint, count: 1, label: "1 周アタックの週の 1 位" },
};

/** 王者を何日続けて守ると景品か */
export const CHAMPION_STREAK_DAYS = 7;

export interface ChampionStreak {
  teamId: string | null;
  days: number;
}

/**
 * 日の締めの王者で 続けて守った日を数える。7 日ごと (7・14・21…) に award = true。
 * champion = その日の王者 (null = いない)。レースの無かった日は呼ばない
 */
export function advanceChampionStreak(prev: ChampionStreak | null, champion: string | null): { streak: ChampionStreak; award: boolean } {
  if (!champion) return { streak: { teamId: null, days: 0 }, award: false };
  const days = prev?.teamId === champion ? prev.days + 1 : 1;
  return { streak: { teamId: champion, days }, award: days % CHAMPION_STREAK_DAYS === 0 };
}

/** 景品をまとめる: チーム → 品 → 数 */
export type PrizeGrants = Record<string, Partial<Record<ItemId, number>>>;

export function addPrize(out: PrizeGrants, teamId: string | null | undefined, key: PrizeKey): PrizeGrants {
  if (!teamId) return out;
  const p = PRIZE_ITEMS[key];
  const cur = { ...(out[teamId] ?? {}) };
  cur[p.item] = (cur[p.item] ?? 0) + p.count;
  return { ...out, [teamId]: cur };
}

/** 景品の言い表し (「限界設計図 ×2・特別指導書 ×1」) */
export function describeItems(items: Partial<Record<ItemId, number>>): string {
  return ITEM_DEFS.filter((d) => (items[d.id] ?? 0) > 0)
    .map((d) => `${d.name} ×${items[d.id]}`)
    .join("・");
}
