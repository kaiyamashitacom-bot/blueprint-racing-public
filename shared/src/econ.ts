// チームとお金の中身で共通に使うもの: 結果の形・お金の動き・知らせ・種からの乱数。
// どれも JSON にそのまま保存できる形。時刻はいつも外から ms で渡す (中で Date.now() を読まない)。
// 財布 (お金) は持たない。お金はサーバーの accounts.money (チームの財布) にあり、ここの関数は
// 「今の財布 (funds)」を受け取って、払うお金 (cost) か MoneyMove (出入り) を返す。
import type { SeasonWindow } from "./season.ts";

/** できなかった理由 (画面で言葉に直す) */
export type EconError =
  | "no_money"
  | "bad_amount"
  | "not_found"
  | "taken"
  | "not_owner"
  | "not_allowed"
  | "already"
  | "busy"
  | "locked"
  | "closed"
  | "bid_too_low"
  | "too_many"
  | "bad_name"
  | "bad_emblem";

export type Result<T> = ({ ok: true } & T) | { ok: false; error: EconError };

export function fail(error: EconError): { ok: false; error: EconError } {
  return { ok: false, error };
}

/** チームの財布のお金の出入り (+ 入る / - 出る) */
export interface MoneyMove {
  teamId: string;
  amount: number;
  reason: MoneyReason;
  /** 関わる物の id (出品・契約・研究など) */
  ref?: string;
}

export type MoneyReason =
  | "prize"
  | "driver_fee"
  | "driver_penalty"
  | "crew_upgrade"
  | "research"
  | "manufacture"
  | "market_buy"
  | "market_sale"
  | "bid_hold"
  | "bid_refund"
  | "supply_buy"
  | "supply_sale"
  | "supply_build"
  | "evolve";

/** 知らせ (通知) の元。teamId は知らせを受けるチーム */
export type EconEvent =
  | { type: "research_done"; teamId: string; researchId: string; partId: string; at: number }
  | { type: "contract_renewed"; teamId: string; driverId: string; fee: number; season: number }
  | { type: "contract_ended"; teamId: string; driverId: string; why: "not_renewed" | "no_money"; season: number }
  | { type: "outbid"; teamId: string; listingId: string; amount: number; at: number }
  | { type: "sold"; teamId: string; listingId: string; price: number; fee: number; buyerId: string; at: number }
  | { type: "bought"; teamId: string; listingId: string; price: number; at: number }
  | { type: "won"; teamId: string; listingId: string; price: number; at: number }
  | { type: "expired"; teamId: string; listingId: string; at: number }
  | { type: "supply_offered"; teamId: string; contractId: string; at: number }
  | { type: "supply_accepted"; teamId: string; contractId: string; at: number }
  | { type: "supply_order"; teamId: string; contractId: string; count: number; at: number }
  | { type: "supply_ended"; teamId: string; contractId: string; season: number };

/** 季節の残りの割合 (0..1)。季節は season.ts の seasonWindow */
export function seasonRemaining(w: SeasonWindow, now: number): number {
  const len = w.endsAt - w.startsAt;
  if (len <= 0) return 0;
  return Math.max(0, Math.min(1, (w.endsAt - now) / len));
}

/**
 * お金の出入りをまとめて財布 (チームの id → お金) に当てる。どれかが負になるなら何も変えない。
 * サーバーは返った wallets を accounts.money に、moves を wallet_log に書く。
 */
export function applyMoneyMoves(wallets: Readonly<Record<string, number>>, moves: readonly MoneyMove[]): Result<{ wallets: Record<string, number> }> {
  const out: Record<string, number> = { ...wallets };
  for (const m of moves) {
    if (!(m.teamId in out)) return fail("not_found");
    if (!Number.isInteger(m.amount)) return fail("bad_amount");
    out[m.teamId] += m.amount;
  }
  for (const m of moves) if (out[m.teamId] < 0) return fail("no_money");
  return { ok: true, wallets: out };
}

/** お金はいつも整数 */
export function isAmount(x: number): boolean {
  return Number.isInteger(x) && x >= 0;
}

/** 種と番号から 何度呼んでも同じ 乱数の列 (mulberry32) */
export function seededRand(seed: number, salt = 0): () => number {
  let a = (Math.imul(Math.floor(seed) | 0, 0x9e3779b1) ^ Math.imul(salt + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length) % list.length];
}
