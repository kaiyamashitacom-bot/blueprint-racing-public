// サーバーの /api/... とのやりとり。ログインの合い言葉はこの機械 (localStorage) に置く。
// ログインしていなければ何もしない (この機械の保存 store.ts だけで遊べる)
import { STARTER_BOX, type AccountMe, type CarDesign, type Inventory } from "@bpr/shared";

const TOKEN_KEY = "bpr.token";
/** 持ち物の写し (車づくりがすぐ使えるように。サーバーが正) */
const CACHE_KEY = "bpr.account";

export class ApiFail extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export interface ShopItem {
  id: string;
  price: number;
}

export interface InventoryRes {
  money: number;
  parts: Inventory;
}

export interface SavedDesign {
  id: number;
  name: string;
  design: CarDesign;
  updatedAt: number;
}

interface Cache {
  me: AccountMe | null;
  parts: Inventory | null;
}

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* 保存できない (内緒の窓など) */
  }
}

let cache: Cache | null = null;

function loadCache(): Cache {
  if (cache) return cache;
  cache = { me: null, parts: null };
  try {
    const raw = readStore(CACHE_KEY);
    if (raw) cache = { ...cache, ...(JSON.parse(raw) as Cache) };
  } catch {
    /* 読めなければ空 */
  }
  return cache;
}

function saveCache() {
  writeStore(CACHE_KEY, JSON.stringify(loadCache()));
}

export function getToken(): string | null {
  return readStore(TOKEN_KEY);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

/** 最後に見た自分の情報 (ログインしていなければ null) */
export function cachedMe(): AccountMe | null {
  return isLoggedIn() ? loadCache().me : null;
}

/** ログインしているときの持ち物 (していなければ null) */
export function ownedParts(): Inventory | null {
  return isLoggedIn() ? loadCache().parts : null;
}

/** 車づくりで使う部品の箱: ログインしていれば持ち物、していなければはじめの箱 */
export function partBox(): Readonly<Record<string, number>> {
  return ownedParts() ?? STARTER_BOX;
}

/** 変わったときに呼ぶ (画面を描き直すため) */
const listeners = new Set<() => void>();
export function onAccountChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed() {
  saveCache();
  for (const fn of listeners) fn();
}

function setSession(token: string | null, me: AccountMe | null) {
  writeStore(TOKEN_KEY, token);
  const c = loadCache();
  c.me = me;
  if (!token) c.parts = null;
  changed();
}

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
  if (!res.ok) {
    // ログインが切れていたら、この機械の合い言葉も消す
    if (res.status === 401 && token && path !== "/api/login") setSession(null, null);
    throw new ApiFail(res.status, typeof data.error === "string" ? data.error : `うまくいきませんでした (${res.status})`);
  }
  return data as T;
}

export async function register(input: { id: string; password: string; team: string; driver: string; invite?: string }): Promise<AccountMe> {
  const r = await call<{ token: string; me: AccountMe }>("POST", "/api/register", input);
  setSession(r.token, r.me);
  await fetchInventory().catch(() => {});
  return r.me;
}

export async function login(id: string, password: string): Promise<AccountMe> {
  const r = await call<{ token: string; me: AccountMe }>("POST", "/api/login", { id, password });
  setSession(r.token, r.me);
  await fetchInventory().catch(() => {});
  return r.me;
}

export async function logout(): Promise<void> {
  try {
    if (getToken()) await call("POST", "/api/logout");
  } catch {
    /* サーバーに届かなくても、この機械からは消す */
  }
  setSession(null, null);
}

export async function fetchMe(): Promise<AccountMe> {
  const r = await call<{ me: AccountMe }>("GET", "/api/me");
  loadCache().me = r.me;
  changed();
  return r.me;
}

export async function fetchInventory(): Promise<InventoryRes> {
  const r = await call<InventoryRes>("GET", "/api/inventory");
  const c = loadCache();
  c.parts = r.parts;
  if (c.me) c.me = { ...c.me, money: r.money };
  changed();
  return r;
}

/** 自分の情報と持ち物をまとめて読み直す (ログインしていなければ何もしない) */
export async function refreshAccount(): Promise<void> {
  if (!getToken()) return;
  await fetchMe();
  await fetchInventory();
}

export async function fetchShop(): Promise<ShopItem[]> {
  return (await call<{ items: ShopItem[] }>("GET", "/api/shop")).items;
}

export async function buy(part: string, qty: number): Promise<InventoryRes> {
  const r = await call<InventoryRes>("POST", "/api/shop/buy", { part, qty });
  const c = loadCache();
  c.parts = r.parts;
  if (c.me) c.me = { ...c.me, money: r.money };
  changed();
  return r;
}

export async function setNames(team: string, driver: string): Promise<AccountMe> {
  const r = await call<{ me: AccountMe }>("PUT", "/api/me/names", { team, driver });
  loadCache().me = r.me;
  changed();
  return r.me;
}

export async function deleteAccount(password: string): Promise<void> {
  await call("DELETE", "/api/me", { password });
  setSession(null, null);
}

export async function listDesigns(): Promise<SavedDesign[]> {
  return (await call<{ designs: SavedDesign[] }>("GET", "/api/designs")).designs;
}

/** 設計図を保存する (id があれば上書き) */
export async function saveDesign(design: CarDesign, id?: number): Promise<SavedDesign> {
  const r = id === undefined ? await call<{ saved: SavedDesign }>("POST", "/api/designs", { design }) : await call<{ saved: SavedDesign }>("PUT", `/api/designs/${id}`, { design });
  return r.saved;
}

export async function deleteDesign(id: number): Promise<void> {
  await call("DELETE", `/api/designs/${id}`);
}

/** 管理者: パスワードを戻す (password を空にすると仮のパスワードを作る) */
export async function adminResetPassword(id: string, password?: string): Promise<string> {
  return (await call<{ password: string }>("POST", "/api/admin/reset-password", { id, password: password || undefined })).password;
}
