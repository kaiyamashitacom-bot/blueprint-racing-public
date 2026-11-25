import { describe, expect, it } from "vitest";
import { applyMoneyMoves, type MoneyMove } from "../src/econ.ts";
import { dueNotices } from "../src/notify.ts";
import { SAMPLE_DESIGN } from "../src/presets.ts";
import { buildCost, newResearch, researchDef, type ResearchState } from "../src/research.ts";
import { seasonWindow } from "../src/season.ts";
import {
  answerSupply, applyPartMoves, buyNow, cancelListing, createListing, endSupplySeason, heldInBids, itemName, MARKET, marketFee,
  marketNoticeSources, minNextBid, newMarket, offerSupply, openListings, orderSupply, placeBid, pruneMarket, settleMarket, topBid,
  type MarketState,
} from "../src/market.ts";

const H = 3600_000;
const S0 = seasonWindow(0);
const PART = { type: "part" as const, partId: "eng_p2", count: 1 };

function must<T>(r: { ok: true } & T | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** 財布を動かしながら市場を回す小さな舞台 */
function stage() {
  let wallets: Record<string, number> = { A: 1000, B: 1000, C: 1000 };
  const pay = (moves: MoneyMove[]) => {
    wallets = must(applyMoneyMoves(wallets, moves)).wallets;
  };
  return { get w() { return wallets; }, pay };
}

describe("値段を付けて売る", () => {
  it("出すと部品を預かり、買うと 値段 - 5% が売り手に", () => {
    const st = stage();
    const l = must(createListing(newMarket(), "A", PART, { mode: "fixed", price: 400 }, 0));
    expect(l.items).toEqual([{ teamId: "A", item: PART, change: "remove" }]);
    expect(l.listing.endsAt).toBe(MARKET.defaultDurationMs);
    const b = must(buyNow(l.market, l.listing.id, "B", st.w.B, 10));
    st.pay(b.moves);
    expect(st.w).toEqual({ A: 1000 + 400 - 20, B: 600, C: 1000 });
    expect(b.items).toEqual([{ teamId: "B", item: PART, change: "add" }]);
    expect(b.events.map((e) => e.type)).toEqual(["sold", "bought"]);
    expect(b.market.listings[0].status).toBe("sold");
    expect(buyNow(b.market, l.listing.id, "C", 1e9, 11)).toEqual({ ok: false, error: "closed" });
  });

  it("手数料は 5% 切り捨て、管理者の割合も渡せる", () => {
    expect(marketFee(1000)).toBe(50);
    expect(marketFee(19)).toBe(0);
    expect(marketFee(1000, 0.1)).toBe(100);
    const l = must(createListing(newMarket(), "A", PART, { mode: "fixed", price: 1000 }, 0));
    const b = must(buyNow(l.market, l.listing.id, "B", 1e9, 1, 0.1));
    expect(b.moves.find((m) => m.teamId === "A")!.amount).toBe(900);
  });

  it("自分のは買えない・お金が足りない・期限切れは買えない", () => {
    const l = must(createListing(newMarket(), "A", PART, { mode: "fixed", price: 400 }, 0));
    expect(buyNow(l.market, l.listing.id, "A", 1e9, 1)).toEqual({ ok: false, error: "not_allowed" });
    expect(buyNow(l.market, l.listing.id, "B", 399, 1)).toEqual({ ok: false, error: "no_money" });
    expect(buyNow(l.market, l.listing.id, "B", 1e9, l.listing.endsAt)).toEqual({ ok: false, error: "closed" });
    expect(buyNow(l.market, "L99", "B", 1e9, 1)).toEqual({ ok: false, error: "not_found" });
  });

  it("おかしい出品は受けない・出せる数に上限", () => {
    const m = newMarket();
    expect(createListing(m, "A", { type: "part", partId: "eng_p2", count: 0 }, { mode: "fixed", price: 1 }, 0).ok).toBe(false);
    expect(createListing(m, "A", PART, { mode: "fixed", price: 0 }, 0)).toEqual({ ok: false, error: "bad_amount" });
    expect(createListing(m, "A", PART, { mode: "fixed", price: 1.5 }, 0)).toEqual({ ok: false, error: "bad_amount" });
    expect(createListing(m, "A", PART, { mode: "fixed", price: 10, durationMs: 60_000 }, 0)).toEqual({ ok: false, error: "not_allowed" });
    let mm: MarketState = m;
    for (let i = 0; i < MARKET.maxOpenListings; i++) mm = must(createListing(mm, "A", PART, { mode: "fixed", price: 10 }, 0)).market;
    expect(createListing(mm, "A", PART, { mode: "fixed", price: 10 }, 0)).toEqual({ ok: false, error: "too_many" });
    expect(createListing(mm, "B", PART, { mode: "fixed", price: 10 }, 0).ok).toBe(true);
  });

  it("やめると部品が戻る。期限が切れても戻り、「期限切れ」", () => {
    const l = must(createListing(newMarket(), "A", PART, { mode: "fixed", price: 400 }, 0));
    expect(cancelListing(l.market, l.listing.id, "B", 1)).toEqual({ ok: false, error: "not_owner" });
    const c = must(cancelListing(l.market, l.listing.id, "A", 1));
    expect(c.items).toEqual([{ teamId: "A", item: PART, change: "add" }]);
    const s = settleMarket(l.market, l.listing.endsAt);
    expect(s.items).toEqual([{ teamId: "A", item: PART, change: "add" }]);
    expect(s.events).toEqual([{ type: "expired", teamId: "A", listingId: l.listing.id, at: l.listing.endsAt }]);
    // 何度呼んでも同じことは起きない
    expect(settleMarket(s.market, l.listing.endsAt + H).events).toEqual([]);
  });

  it("設計図は写しを売る (出しても手元から消えない)", () => {
    const item = { type: "design" as const, design: SAMPLE_DESIGN };
    const l = must(createListing(newMarket(), "A", item, { mode: "fixed", price: 300 }, 0));
    expect(l.items).toEqual([]);
    const b = must(buyNow(l.market, l.listing.id, "B", 300, 1));
    expect(b.items).toEqual([{ teamId: "B", item, change: "add" }]);
    expect(itemName(item)).toContain(SAMPLE_DESIGN.name);
    expect(settleMarket(must(createListing(newMarket(), "A", item, { mode: "fixed", price: 3 }, 0)).market, 1e12).items).toEqual([]);
  });
});

describe("競り", () => {
  it("値を入れると預かり、抜かれたら返して知らせる。期限で一番の人に渡る", () => {
    const st = stage();
    const l = must(createListing(newMarket(), "A", PART, { mode: "auction", price: 100, durationMs: 2 * H }, 0));
    expect(placeBid(l.market, l.listing.id, "B", 99, st.w.B, 1)).toEqual({ ok: false, error: "bid_too_low" });
    const b1 = must(placeBid(l.market, l.listing.id, "B", 100, st.w.B, 1));
    st.pay(b1.moves);
    expect(st.w.B).toBe(900);
    expect(heldInBids(b1.market, "B")).toBe(100);
    const lst = b1.market.listings[0];
    expect(minNextBid(lst)).toBe(110);
    expect(placeBid(b1.market, lst.id, "C", 109, st.w.C, 2)).toEqual({ ok: false, error: "bid_too_low" });
    const b2 = must(placeBid(b1.market, lst.id, "C", 150, st.w.C, 2));
    st.pay(b2.moves);
    expect(st.w).toEqual({ A: 1000, B: 1000, C: 850 });
    expect(b2.events).toEqual([{ type: "outbid", teamId: "B", listingId: lst.id, amount: 150, at: 2 }]);
    // 自分が一番のまま上げると差だけ預かる
    const b3 = must(placeBid(b2.market, lst.id, "C", 200, st.w.C, 3));
    expect(b3.moves).toEqual([{ teamId: "C", amount: -50, reason: "bid_hold", ref: lst.id }]);
    expect(b3.events).toEqual([]);
    st.pay(b3.moves);
    // 期限前は決着しない
    expect(settleMarket(b3.market, 2 * H - 1).events).toEqual([]);
    // 期限を過ぎてから入れられない
    expect(placeBid(b3.market, lst.id, "B", 500, st.w.B, 2 * H)).toEqual({ ok: false, error: "closed" });
    const s = settleMarket(b3.market, 2 * H + 5);
    st.pay(s.moves);
    expect(st.w).toEqual({ A: 1000 + 200 - 10, B: 1000, C: 800 });
    expect(s.items).toEqual([{ teamId: "C", item: PART, change: "add" }]);
    expect(s.events.map((e) => e.type)).toEqual(["sold", "won"]);
    expect(topBid(s.market.listings[0])!.amount).toBe(200);
    expect(heldInBids(s.market, "C")).toBe(0);
    // お金の合計は 手数料の分だけ減る
    expect(st.w.A + st.w.B + st.w.C).toBe(3000 - 10);
  });

  it("誰も入れなければ期限切れで戻る。入ったあとはやめられない", () => {
    const l = must(createListing(newMarket(), "A", PART, { mode: "auction", price: 100 }, 0));
    expect(buyNow(l.market, l.listing.id, "B", 1e9, 1)).toEqual({ ok: false, error: "not_allowed" });
    expect(placeBid(l.market, l.listing.id, "A", 100, 1e9, 1)).toEqual({ ok: false, error: "not_allowed" });
    expect(placeBid(l.market, l.listing.id, "B", 100, 99, 1)).toEqual({ ok: false, error: "no_money" });
    const b = must(placeBid(l.market, l.listing.id, "B", 100, 1000, 1));
    expect(cancelListing(b.market, l.listing.id, "A", 2)).toEqual({ ok: false, error: "locked" });
    const s = settleMarket(l.market, l.listing.endsAt);
    expect(s.events.map((e) => e.type)).toEqual(["expired"]);
    expect(s.items[0].change).toBe("add");
  });

  it("知らせ (notify.ts) につながる: 抜かれた・売れた", () => {
    let m = must(createListing(newMarket(), "A", PART, { mode: "auction", price: 100, durationMs: H }, 0)).market;
    m = must(placeBid(m, "L1", "B", 100, 1e9, 10)).market;
    m = must(placeBid(m, "L1", "C", 120, 1e9, 20)).market;
    m = must(placeBid(m, "L1", "C", 140, 1e9, 25)).market;
    m = must(placeBid(m, "L1", "B", 200, 1e9, 30)).market;
    m = settleMarket(m, H).market;
    const src = marketNoticeSources(m);
    expect(src.outbids!.map((o) => [o.teamId, o.newPrice])).toEqual([["B", 120], ["C", 200]]);
    const due = dueNotices(src, H);
    expect(due.map((n) => [n.kind, n.to])).toEqual([["outbid", "B"], ["outbid", "C"], ["market_sold", "A"]]);
    expect(due[2].data.price).toBe(200);
  });

  it("古い決着は消せる・一覧は開いているものだけ", () => {
    let m = must(createListing(newMarket(), "A", PART, { mode: "fixed", price: 10 }, 0)).market;
    m = must(createListing(m, "A", { type: "design", design: SAMPLE_DESIGN }, { mode: "fixed", price: 10 }, 0)).market;
    m = must(buyNow(m, "L1", "B", 100, 5)).market;
    expect(openListings(m, 6).map((l) => l.id)).toEqual(["L2"]);
    expect(openListings(m, 6, "part")).toEqual([]);
    expect(pruneMarket(m, 6).listings.map((l) => l.id)).toEqual(["L2"]);
    expect(pruneMarket(m, 5)).toBe(m);
  });
});

describe("持ち物へ当てる", () => {
  it("部品を足し引きし、足りなければ何もしない", () => {
    const inv = { eng_p2: 1, tire_n1: 4 };
    const out = must(applyPartMoves(inv, "A", [
      { teamId: "A", item: PART, change: "remove" },
      { teamId: "A", item: { type: "part", partId: "tire_n1", count: 2 }, change: "add" },
      { teamId: "B", item: { type: "part", partId: "tire_n1", count: 9 }, change: "add" },
      { teamId: "A", item: { type: "design", design: SAMPLE_DESIGN }, change: "add" },
    ]));
    expect(out.inventory).toEqual({ tire_n1: 6 });
    expect(applyPartMoves(inv, "A", [{ teamId: "A", item: { type: "part", partId: "eng_p2", count: 2 }, change: "remove" }])).toEqual({ ok: false, error: "not_owner" });
    expect(inv).toEqual({ eng_p2: 1, tire_n1: 4 });
  });
});

describe("部品の供給", () => {
  const done: ResearchState = { active: [], done: ["r_eng_p3"] };

  it("研究したチームだけが申し出られ、受けたら季節の間 決まった値段で買える", () => {
    expect(offerSupply(newMarket(), "A", newResearch(), { buyerId: "B", partId: "eng_p3", unitPrice: 2000, maxUnits: 3 }, S0, 0)).toEqual({ ok: false, error: "locked" });
    expect(offerSupply(newMarket(), "A", done, { buyerId: "A", partId: "eng_p3", unitPrice: 2000, maxUnits: 3 }, S0, 0)).toEqual({ ok: false, error: "not_allowed" });
    const o = must(offerSupply(newMarket(), "A", done, { buyerId: "B", partId: "eng_p3", unitPrice: 2000, maxUnits: 3 }, S0, 0));
    expect(o.events).toEqual([{ type: "supply_offered", teamId: "B", contractId: o.contract.id, at: 0 }]);
    expect(offerSupply(o.market, "A", done, { buyerId: "B", partId: "eng_p3", unitPrice: 1, maxUnits: 1 }, S0, 0)).toEqual({ ok: false, error: "already" });
    // 受ける前は買えない
    expect(orderSupply(o.market, o.contract.id, "B", 1, 1e9, 1e9, 1)).toEqual({ ok: false, error: "closed" });
    expect(answerSupply(o.market, o.contract.id, "C", true, 1)).toEqual({ ok: false, error: "not_owner" });
    const a = must(answerSupply(o.market, o.contract.id, "B", true, 1));
    expect(a.events[0].type).toBe("supply_accepted");

    const unit = buildCost(researchDef("r_eng_p3")!);
    const r = must(orderSupply(a.market, o.contract.id, "B", 2, 4000, 0, 2));
    expect(r.moves).toEqual([
      { teamId: "B", amount: -4000, reason: "supply_buy", ref: o.contract.id },
      { teamId: "A", amount: 4000 - 200, reason: "supply_sale", ref: o.contract.id },
      { teamId: "A", amount: -2 * unit, reason: "supply_build", ref: o.contract.id },
    ]);
    expect(r.items).toEqual([{ teamId: "B", item: { type: "part", partId: "eng_p3", count: 2 }, change: "add" }]);
    expect(orderSupply(r.market, o.contract.id, "B", 2, 1e9, 1e9, 3)).toEqual({ ok: false, error: "too_many" });
    expect(orderSupply(r.market, o.contract.id, "B", 1, 1999, 1e9, 3)).toEqual({ ok: false, error: "no_money" });

    // 季節が変わると終わる
    const e = endSupplySeason(r.market, 1);
    expect(e.events.map((x) => x.teamId).sort()).toEqual(["A", "B"]);
    expect(orderSupply(e.market, o.contract.id, "B", 1, 1e9, 1e9, 4)).toEqual({ ok: false, error: "closed" });
    expect(endSupplySeason(e.market, 1).events).toEqual([]);
  });

  it("作るお金が値段より高く、売る側の財布も足りなければ届かない", () => {
    const unit = buildCost(researchDef("r_eng_p3")!);
    const o = must(offerSupply(newMarket(), "A", done, { buyerId: "B", partId: "eng_p3", unitPrice: 10, maxUnits: 5 }, S0, 0));
    const a = must(answerSupply(o.market, o.contract.id, "B", true, 1));
    expect(orderSupply(a.market, o.contract.id, "B", 1, 1e9, unit - 11, 2)).toEqual({ ok: false, error: "no_money" });
    expect(orderSupply(a.market, o.contract.id, "B", 1, 1e9, unit - 10, 2).ok).toBe(true);
  });

  it("断ることもできる", () => {
    const o = must(offerSupply(newMarket(), "A", done, { buyerId: "B", partId: "eng_p3", unitPrice: 10, maxUnits: 5 }, S0, 0));
    const d = must(answerSupply(o.market, o.contract.id, "B", false, 1));
    expect(d.market.supplies[0].status).toBe("declined");
    expect(answerSupply(d.market, o.contract.id, "B", true, 2)).toEqual({ ok: false, error: "closed" });
  });
});
