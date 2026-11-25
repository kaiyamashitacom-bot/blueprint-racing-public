// ギフトコードのやりとり (/api/gift・/api/admin/gifts。server/src/gift.ts と合わせる)。コードの文字はここにも書かない
import type { GiftCaps, GiftItem, Inventory } from "@bpr/shared";
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

export interface GiftRedeemResult {
  received: string[];
  later: string[];
  money: number;
  parts: Inventory;
}

export interface GiftStatus {
  title: string | null;
  discountPct: number;
  pending: Array<{ kind: "division" | "class"; target: number }>;
}

export interface GiftCodeRow {
  id: number;
  code: string;
  items: GiftItem[];
  lines: string[];
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  paused: boolean;
  targets: string[] | null;
  note: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  state: "active" | "paused" | "expired" | "used_up";
}

export interface GiftInput {
  code?: string;
  items?: GiftItem[];
  maxUses?: number | null;
  expiresAt?: number | null;
  note?: string;
  targets?: string[] | null;
  paused?: boolean;
}

export interface GiftLogRow {
  at: number;
  team: string;
  driver: string;
  login: string | null;
}

export const redeemGift = (code: string) => call<GiftRedeemResult>("POST", "/api/gift", { code });
export const fetchGiftStatus = () => call<GiftStatus>("GET", "/api/gift/status");

export const fetchGiftCodes = () => call<{ codes: GiftCodeRow[]; caps: GiftCaps }>("GET", "/api/admin/gifts");
export const fetchGiftOptions = () => call<{ drivers: Array<{ id: string; name: string; overall: number; team: string | null }> }>("GET", "/api/admin/gifts/options");
export const createGiftCode = (input: GiftInput) => call<{ code: GiftCodeRow }>("POST", "/api/admin/gifts", input);
export const updateGiftCode = (id: number, input: GiftInput) => call<{ code: GiftCodeRow }>("PUT", `/api/admin/gifts/${id}`, input);
export const deleteGiftCode = (id: number) => call<{ ok: true }>("DELETE", `/api/admin/gifts/${id}`);
export const fetchGiftLog = (id: number) => call<{ code: string; rows: GiftLogRow[] }>("GET", `/api/admin/gifts/${id}/log`);
