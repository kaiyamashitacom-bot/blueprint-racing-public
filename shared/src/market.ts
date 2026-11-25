// 市場: 値段を付けて出す (fixed) と 競り (auction)。売れたら 5% の手数料を引く。
// 出せる物: 部品 (お店・研究でできた部品のどちらも) と 車の設計図 (写しを売る。売った人の手元にも残る)。
// 部品の供給: 研究した (作れる) チームが、別のチームに 季節のあいだ決まった値段で部品を売る約束。
//
// お金と物は 関数が直接さわらず、MoneyMove (財布の出入り) と ItemMove (持ち物の出入り) を返す。
// 競りに入れたお金はその場で財布から預かり (bid_hold)、抜かれたら返す (bid_refund)。だから決着で足りなくならない。
// 出品した部品もその場で持ち物から預かる (remove)。売れなければ戻す (add)。
import type { CarDesign } from "./design.ts";
import { fail, isAmount, type EconEvent, type MoneyMove, type Result } from "./econ.ts";
import { MAX_PER_PART, type Inventory } from "./inventory.ts";
import type { NoticeSources } from "./notify.ts";
import { anyPartDef, canManufacture, manufactureCost, type ResearchState } from "./research.ts";
import type { SeasonWindow } from "./season.ts";

/** 市場の仮の数 (手数料 5% は決めごと) */
export const MARKET = {
  /** 売れたときの手数料の割合 (決めごと: 例 5%)。管理者の数 (adminconfig の marketFeeRate) があれば各関数の feeRate に渡す */
  feeRate: 0.05,
  /** 出品の長さ: 決めなければ 24 時間、最短 1 時間、最長 7 日 */
  defaultDurationMs: 24 * 3600_000,
  minDurationMs: 3600_000,
  maxDurationMs: 7 * 24 * 3600_000,
  /** 1 チームが同時に出せる数 */
  maxOpenListings: 20,
  /** 競りの次の値は 今の値 + max(minStep, 今の値 × stepRate) 以上 */
  minStep: 10,
  stepRate: 0.05,
  /** 1 チームが同時に結べる供給の約束 (売る側) */
  maxSupplies: 10,
} as const;

export type MarketItem =
  | { type: "part"; partId: string; count: number }
  | { type: "design"; design: CarDesign };

export interface Bid {
  teamId: string;
  amount: number;
  at: number;
}

export interface Listing {
  id: string;
  sellerId: string;
  item: MarketItem;
  mode: "fixed" | "auction";
  /** 決めた値段 (fixed) か、競りの始めの値 (auction) */
  price: number;
  createdAt: number;
  endsAt: number;
  status: "open" | "sold" | "expired" | "cancelled";
  /** 競りに入った値 (古い順。最後が一番高い値で、預かり中) */
  bids: Bid[];
  /** 決着したとき */
  buyerId?: string;
  finalPrice?: number;
  closedAt?: number;
}

export interface SupplyContract {
  id: string;
  supplierId: string;
  buyerId: string;
  partId: string;
  /** 1 個の値段と、この季節に買える数 */
  unitPrice: number;
  maxUnits: number;
  delivered: number;
  season: number;
  status: "offered" | "active" | "declined" | "ended";
  createdAt: number;
}

export interface MarketState {
  nextId: number;
  listings: Listing[];
  supplies: SupplyContract[];
}

export interface ItemMove {
  teamId: string;
  item: MarketItem;
  change: "add" | "remove";
}

export interface MarketOut {
  market: MarketState;
  moves: MoneyMove[];
  items: ItemMove[];
  events: EconEvent[];
}

export function newMarket(): MarketState {
  return { nextId: 1, listings: [], supplies: [] };
}

/** 売れた値段から引く手数料 (切り捨て。adminconfig の marketFeeFor と同じ形) */
export function marketFee(price: number, feeRate: number = MARKET.feeRate): number {
  return Math.floor(Math.max(0, price) * feeRate);
}

/** 競りの一番高い値 */
export function topBid(l: Listing): Bid | null {
  return l.bids.length ? l.bids[l.bids.length - 1] : null;
}

/** 競りで次に入れられる最低の値 */
export function minNextBid(l: Listing): number {
  const top = topBid(l);
  if (!top) return l.price;
  return top.amount + Math.max(MARKET.minStep, Math.ceil(top.amount * MARKET.stepRate));
}

function validItem(item: MarketItem): boolean {
  if (item.type === "part") return typeof item.partId === "string" && item.partId.length > 0 && Number.isInteger(item.count) && item.count >= 1;
  return !!item.design && Array.isArray(item.design.parts);
}

function putListing(m: MarketState, l: Listing): MarketState {
  return { ...m, listings: m.listings.map((x) => (x.id === l.id ? l : x)) };
}

function putSupply(m: MarketState, s: SupplyContract): MarketState {
  return { ...m, supplies: m.supplies.map((x) => (x.id === s.id ? s : x)) };
}

/** 設計図は写しを売るので、出しても手元から消えない */
const escrows = (item: MarketItem) => item.type === "part";

/**
 * 出品する。部品なら持ち物から預かる (呼ぶ側は 先に持っているか確かめ、返る items を当てる)。
 */
export function createListing(
  market: MarketState,
  sellerId: string,
  item: MarketItem,
  o: { mode: "fixed" | "auction"; price: number; durationMs?: number },
  now: number,
): Result<MarketOut & { listing: Listing }> {
  if (!validItem(item)) return fail("not_allowed");
  if (!isAmount(o.price) || o.price < 1) return fail("bad_amount");
  const dur = o.durationMs ?? MARKET.defaultDurationMs;
  if (!(dur >= MARKET.minDurationMs && dur <= MARKET.maxDurationMs)) return fail("not_allowed");
  if (market.listings.filter((l) => l.sellerId === sellerId && l.status === "open").length >= MARKET.maxOpenListings) return fail("too_many");
  const listing: Listing = {
    id: `L${market.nextId}`,
    sellerId,
    item,
    mode: o.mode,
    price: o.price,
    createdAt: now,
    endsAt: now + dur,
    status: "open",
    bids: [],
  };
  return {
    ok: true,
    listing,
    market: { ...market, nextId: market.nextId + 1, listings: [...market.listings, listing] },
    moves: [],
    items: escrows(item) ? [{ teamId: sellerId, item, change: "remove" }] : [],
    events: [],
  };
}

function openListing(market: MarketState, id: string, now: number): Listing | { error: "not_found" | "closed" } {
  const l = market.listings.find((x) => x.id === id);
  if (!l) return { error: "not_found" };
  if (l.status !== "open" || now >= l.endsAt) return { error: "closed" };
  return l;
}

/** 値段の決まった物を買う。funds は買う人の財布 */
export function buyNow(market: MarketState, listingId: string, buyerId: string, funds: number, now: number, feeRate: number = MARKET.feeRate): Result<MarketOut> {
  const l = openListing(market, listingId, now);
  if ("error" in l) return fail(l.error);
  if (l.mode !== "fixed") return fail("not_allowed");
  if (l.sellerId === buyerId) return fail("not_allowed");
  if (funds < l.price) return fail("no_money");
  const fee = marketFee(l.price, feeRate);
  const sold: Listing = { ...l, status: "sold", buyerId, finalPrice: l.price, closedAt: now };
  return {
    ok: true,
    market: putListing(market, sold),
    moves: [
      { teamId: buyerId, amount: -l.price, reason: "market_buy", ref: l.id },
      { teamId: l.sellerId, amount: l.price - fee, reason: "market_sale", ref: l.id },
    ],
    items: [{ teamId: buyerId, item: l.item, change: "add" }],
    events: [
      { type: "sold", teamId: l.sellerId, listingId: l.id, price: l.price, fee, buyerId, at: now },
      { type: "bought", teamId: buyerId, listingId: l.id, price: l.price, at: now },
    ],
  };
}

/**
 * 競りに値を入れる。入れた値は財布から預かり、前の一番の人には返して「抜かれた」と知らせる。
 * 自分が一番のまま上げるときは、差の分だけ預かる。funds は入れる人の財布 (預け済みの分は含まない)。
 */
export function placeBid(market: MarketState, listingId: string, bidderId: string, amount: number, funds: number, now: number): Result<MarketOut> {
  const l = openListing(market, listingId, now);
  if ("error" in l) return fail(l.error);
  if (l.mode !== "auction") return fail("not_allowed");
  if (l.sellerId === bidderId) return fail("not_allowed");
  if (!isAmount(amount)) return fail("bad_amount");
  if (amount < minNextBid(l)) return fail("bid_too_low");
  const prev = topBid(l);
  const moves: MoneyMove[] = [];
  const events: EconEvent[] = [];
  if (prev && prev.teamId === bidderId) {
    if (funds < amount - prev.amount) return fail("no_money");
    moves.push({ teamId: bidderId, amount: -(amount - prev.amount), reason: "bid_hold", ref: l.id });
  } else {
    if (funds < amount) return fail("no_money");
    moves.push({ teamId: bidderId, amount: -amount, reason: "bid_hold", ref: l.id });
    if (prev) {
      moves.push({ teamId: prev.teamId, amount: prev.amount, reason: "bid_refund", ref: l.id });
      events.push({ type: "outbid", teamId: prev.teamId, listingId: l.id, amount, at: now });
    }
  }
  const next: Listing = { ...l, bids: [...l.bids, { teamId: bidderId, amount, at: now }] };
  return { ok: true, market: putListing(market, next), moves, items: [], events };
}

/** 出品をやめる (競りは まだ誰も入れていないときだけ)。部品は戻す */
export function cancelListing(market: MarketState, listingId: string, sellerId: string, now: number): Result<MarketOut> {
  const l = market.listings.find((x) => x.id === listingId);
  if (!l) return fail("not_found");
  if (l.sellerId !== sellerId) return fail("not_owner");
  if (l.status !== "open") return fail("closed");
  if (l.bids.length) return fail("locked");
  return {
    ok: true,
    market: putListing(market, { ...l, status: "cancelled", closedAt: now }),
    moves: [],
    items: escrows(l.item) ? [{ teamId: sellerId, item: l.item, change: "add" }] : [],
    events: [],
  };
}

/**
 * 時間の切れた出品を決着させる (見回りで呼ぶ。何度呼んでもよい)。
 * 競りに値があれば一番の人に渡し、売った人に (値 - 手数料)。なければ部品を戻して「期限切れ」。
 */
export function settleMarket(market: MarketState, now: number, feeRate: number = MARKET.feeRate): MarketOut {
  const moves: MoneyMove[] = [];
  const items: ItemMove[] = [];
  const events: EconEvent[] = [];
  let changed = false;
  const listings = market.listings.map((l) => {
    if (l.status !== "open" || now < l.endsAt) return l;
    changed = true;
    const top = topBid(l);
    if (l.mode === "auction" && top) {
      const price = top.amount;
      const fee = marketFee(price, feeRate);
      moves.push({ teamId: l.sellerId, amount: price - fee, reason: "market_sale", ref: l.id });
      items.push({ teamId: top.teamId, item: l.item, change: "add" });
      events.push({ type: "sold", teamId: l.sellerId, listingId: l.id, price, fee, buyerId: top.teamId, at: l.endsAt });
      events.push({ type: "won", teamId: top.teamId, listingId: l.id, price, at: l.endsAt });
      return { ...l, status: "sold" as const, buyerId: top.teamId, finalPrice: price, closedAt: l.endsAt };
    }
    if (escrows(l.item)) items.push({ teamId: l.sellerId, item: l.item, change: "add" });
    events.push({ type: "expired", teamId: l.sellerId, listingId: l.id, at: l.endsAt });
    return { ...l, status: "expired" as const, closedAt: l.endsAt };
  });
  return { market: changed ? { ...market, listings } : market, moves, items, events };
}

/** 決着した出品を古いものから消す (closedAt が before より前) */
export function pruneMarket(market: MarketState, before: number): MarketState {
  const listings = market.listings.filter((l) => l.status === "open" || (l.closedAt ?? Infinity) >= before);
  const supplies = market.supplies.filter((s) => s.status === "offered" || s.status === "active" || s.createdAt >= before);
  return listings.length === market.listings.length && supplies.length === market.supplies.length ? market : { ...market, listings, supplies };
}

/** 開いている出品 (画面の一覧に。kind で部品か設計図かに絞れる) */
export function openListings(market: MarketState, now: number, type?: MarketItem["type"]): Listing[] {
  return market.listings.filter((l) => l.status === "open" && now < l.endsAt && (!type || l.item.type === type));
}

/** 競りで預けているお金の合計 (財布の横に「預け中」と出す) */
export function heldInBids(market: MarketState, teamId: string): number {
  return market.listings.reduce((s, l) => {
    const top = topBid(l);
    return l.status === "open" && top?.teamId === teamId ? s + top.amount : s;
  }, 0);
}

// ---- 部品の供給 ----

/** 研究したチームが、別のチームに この季節の供給を申し出る */
export function offerSupply(
  market: MarketState,
  supplierId: string,
  supplierResearch: ResearchState,
  o: { buyerId: string; partId: string; unitPrice: number; maxUnits: number },
  clock: SeasonWindow,
  now: number,
): Result<MarketOut & { contract: SupplyContract }> {
  if (o.buyerId === supplierId) return fail("not_allowed");
  if (!canManufacture(supplierResearch, o.partId)) return fail("locked");
  if (!isAmount(o.unitPrice) || o.unitPrice < 1 || !Number.isInteger(o.maxUnits) || o.maxUnits < 1) return fail("bad_amount");
  const live = market.supplies.filter((s) => s.supplierId === supplierId && (s.status === "offered" || s.status === "active"));
  if (live.length >= MARKET.maxSupplies) return fail("too_many");
  if (live.some((s) => s.buyerId === o.buyerId && s.partId === o.partId)) return fail("already");
  const contract: SupplyContract = {
    id: `S${market.nextId}`,
    supplierId,
    buyerId: o.buyerId,
    partId: o.partId,
    unitPrice: o.unitPrice,
    maxUnits: o.maxUnits,
    delivered: 0,
    season: clock.index,
    status: "offered",
    createdAt: now,
  };
  return {
    ok: true,
    contract,
    market: { ...market, nextId: market.nextId + 1, supplies: [...market.supplies, contract] },
    moves: [],
    items: [],
    events: [{ type: "supply_offered", teamId: o.buyerId, contractId: contract.id, at: now }],
  };
}

/** 申し出を受ける・断る (買う側) */
export function answerSupply(market: MarketState, contractId: string, buyerId: string, accept: boolean, now: number): Result<MarketOut> {
  const s = market.supplies.find((x) => x.id === contractId);
  if (!s) return fail("not_found");
  if (s.buyerId !== buyerId) return fail("not_owner");
  if (s.status !== "offered") return fail("closed");
  const next: SupplyContract = { ...s, status: accept ? "active" : "declined" };
  return {
    ok: true,
    market: putSupply(market, next),
    moves: [],
    items: [],
    events: accept ? [{ type: "supply_accepted", teamId: s.supplierId, contractId: s.id, at: now }] : [],
  };
}

/**
 * 約束に沿って部品を注文する (買う側)。その場で作って届く:
 * 買う側は 値段 × 数、売る側は (値段 × 数 - 手数料) を受け取り、作るお金を払う。
 * 売る側の財布が作るお金に足りないときはできない (supplierFunds)。
 */
export function orderSupply(
  market: MarketState,
  contractId: string,
  buyerId: string,
  count: number,
  buyerFunds: number,
  supplierFunds: number,
  now: number,
  feeRate: number = MARKET.feeRate,
): Result<MarketOut> {
  const s = market.supplies.find((x) => x.id === contractId);
  if (!s) return fail("not_found");
  if (s.buyerId !== buyerId) return fail("not_owner");
  if (s.status !== "active") return fail("closed");
  if (!Number.isInteger(count) || count < 1) return fail("bad_amount");
  if (s.delivered + count > s.maxUnits) return fail("too_many");
  const price = s.unitPrice * count;
  const fee = marketFee(price, feeRate);
  const build = manufactureCost(s.partId, count);
  if (build === null) return fail("not_allowed");
  if (buyerFunds < price) return fail("no_money");
  if (supplierFunds + price - fee < build) return fail("no_money");
  return {
    ok: true,
    market: putSupply(market, { ...s, delivered: s.delivered + count }),
    moves: [
      { teamId: buyerId, amount: -price, reason: "supply_buy", ref: s.id },
      { teamId: s.supplierId, amount: price - fee, reason: "supply_sale", ref: s.id },
      { teamId: s.supplierId, amount: -build, reason: "supply_build", ref: s.id },
    ],
    items: [{ teamId: buyerId, item: { type: "part", partId: s.partId, count }, change: "add" }],
    events: [{ type: "supply_order", teamId: s.supplierId, contractId: s.id, count, at: now }],
  };
}

/** 季節の切れ目: その季節の約束と申し出を終わらせる (約束は季節ごとに結び直す) */
export function endSupplySeason(market: MarketState, newSeason: number): { market: MarketState; events: EconEvent[] } {
  const events: EconEvent[] = [];
  let changed = false;
  const supplies = market.supplies.map((s) => {
    if (s.season >= newSeason || (s.status !== "active" && s.status !== "offered")) return s;
    changed = true;
    if (s.status === "active") {
      events.push({ type: "supply_ended", teamId: s.supplierId, contractId: s.id, season: newSeason });
      events.push({ type: "supply_ended", teamId: s.buyerId, contractId: s.id, season: newSeason });
    }
    return { ...s, status: "ended" as const };
  });
  return { market: changed ? { ...market, supplies } : market, events };
}

// ---- 持ち物と知らせへのつなぎ ----

/**
 * 部品の出入りを持ち物 (inventory.ts の Inventory) に当てる。設計図の出入りは飛ばす (設計図の保存は呼ぶ側)。
 * 足りない部品を出す・上限を超えるときは何も変えない。
 */
export function applyPartMoves(inv: Readonly<Inventory>, teamId: string, items: readonly ItemMove[]): Result<{ inventory: Inventory }> {
  const out: Inventory = { ...inv };
  for (const m of items) {
    if (m.teamId !== teamId || m.item.type !== "part") continue;
    const cur = out[m.item.partId] ?? 0;
    const next = m.change === "add" ? cur + m.item.count : cur - m.item.count;
    if (next < 0) return fail("not_owner");
    if (next > MAX_PER_PART) return fail("too_many");
    if (next === 0) delete out[m.item.partId];
    else out[m.item.partId] = next;
  }
  return { ok: true, inventory: out };
}

/** 画面用の品の名前 */
export function itemName(item: MarketItem): string {
  if (item.type === "design") return `設計図「${item.design.name}」`;
  const name = anyPartDef(item.partId)?.name ?? item.partId;
  return item.count > 1 ? `${name} ×${item.count}` : name;
}

/** notify.ts の知らせの もと (市場で売れた・競りで抜かれた) */
export function marketNoticeSources(market: MarketState): Pick<NoticeSources, "sales" | "outbids"> {
  const sales: Array<NonNullable<NoticeSources["sales"]>[number]> = [];
  const outbids: Array<NonNullable<NoticeSources["outbids"]>[number]> = [];
  for (const l of market.listings) {
    const name = itemName(l.item);
    if (l.status === "sold" && l.finalPrice !== undefined && l.closedAt !== undefined) {
      sales.push({ listingId: l.id, sellerTeamId: l.sellerId, itemName: name, price: l.finalPrice, soldAt: l.closedAt });
    }
    for (let i = 1; i < l.bids.length; i++) {
      const prev = l.bids[i - 1];
      const cur = l.bids[i];
      if (prev.teamId !== cur.teamId) outbids.push({ auctionId: l.id, bidId: String(i), teamId: prev.teamId, itemName: name, newPrice: cur.amount, at: cur.at });
    }
  }
  return { sales, outbids };
}
