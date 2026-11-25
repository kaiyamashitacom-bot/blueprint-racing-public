// 走行点と交換所のやりとり (/api/rp・/api/admin/rp。server/src/racepoints.ts と合わせる)
import type { GiftItem, RpKind } from "@bpr/shared";
import { ApiFail, getToken } from "./api.ts";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiFail(0, "サーバーにつながりません");
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 中身なし */
  }
  if (!res.ok) throw new ApiFail(res.status, typeof data.error === "string" ? data.error : `うまくいきませんでした (${res.status})`);
  return data as T;
}

export interface RpShopView {
  id: number;
  name: string;
  note: string;
  lines: string[];
  price: number;
  limitWeek: number | null;
  limitTotal: number | null;
  boughtWeek: number;
  boughtTotal: number;
}

export interface RpStatus {
  on: boolean;
  points: number;
  today: number;
  left: number;
  cap: number;
  rates: { rpFinish: number; rpPosBonus: number; rpTourMul: number; rpTaLap: number; rpTaBest: number };
  shop: RpShopView[];
  buys: Array<{ at: number; name: string; price: number; lines: string[] }>;
  ledger: Array<{ at: number; delta: number; kind: RpKind; kindJp: string; reason: string }>;
}

export interface RpBuyResult {
  received: string[];
  later: string[];
  points: number;
  money: number;
}

export interface RpAdminEntry {
  id: number;
  name: string;
  note: string;
  items: GiftItem[];
  price: number;
  limitWeek: number | null;
  limitTotal: number | null;
  hidden: boolean;
  sort: number;
  lines: string[];
  sold: number;
}

export interface RpAdminView {
  on: boolean;
  shop: RpAdminEntry[];
  totals: {
    issued: number;
    spent: number;
    outstanding: number;
    holders: number;
    byKind: Array<{ kind: RpKind; kindJp: string; issued: number; spent: number }>;
    issuedToday: number;
  };
}

export type RpEntryInput = Partial<Pick<RpAdminEntry, "name" | "note" | "items" | "price" | "limitWeek" | "limitTotal" | "hidden" | "sort">>;

/** 最後に見た残高 (はじめの画面の見出し用。読みなおすまでの間) */
let lastPoints: number | null = null;
export const cachedRacePoints = () => lastPoints;

export async function fetchRp(): Promise<RpStatus> {
  const r = await call<RpStatus>("GET", "/api/rp");
  lastPoints = r.points;
  return r;
}

export async function buyRp(id: number): Promise<RpBuyResult> {
  const r = await call<RpBuyResult>("POST", "/api/rp/buy", { id });
  lastPoints = r.points;
  return r;
}

export const fetchRpAdmin = () => call<RpAdminView>("GET", "/api/admin/rp");
export const createRpEntry = (input: RpEntryInput) => call<{ entry: RpAdminEntry }>("POST", "/api/admin/rp/shop", input);
export const updateRpEntry = (id: number, input: RpEntryInput) => call<{ entry: RpAdminEntry }>("PUT", `/api/admin/rp/shop/${id}`, input);
export const deleteRpEntry = (id: number) => call<{ ok: true }>("DELETE", `/api/admin/rp/shop/${id}`);
