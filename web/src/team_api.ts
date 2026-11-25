// チーム・運転手・研究・市場・知らせの /api/... とのやりとり (サーバーは server/src/team.ts)。どれもログインが要る
import type { CarDesign, Emblem, Inventory, PartDef } from "@bpr/shared";
import { ApiFail, fetchInventory, getToken } from "./api.ts";

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

/** お金や持ち物の変わる動きのあとに、財布と持ち物の写しを読み直す (メニューの財布の表示のため) */
async function after<T>(p: Promise<T>): Promise<T> {
  const r = await p;
  fetchInventory().catch(() => {});
  return r;
}

export interface CarRef {
  id: number;
  name: string;
  ok: boolean;
  fits: boolean;
}

export interface DriverView {
  id: string;
  name: string;
  stats: { speed: number; stability: number; tyreFuel: number; pitSense: number };
  potential: { speed: number; stability: number; tyreFuel: number; pitSense: number };
  overall: number;
  races: number;
  fee: number;
  signCost?: number;
  penalty?: number;
  renew?: boolean;
  fam?: Record<string, number>;
  /** 得意 (shared の SPECIALTIES の id)・国の札・年代 */
  specs?: string[];
  nat?: string;
  era?: number;
  /** 珍しい運転手 */
  rare?: boolean;
  /** 季節のごほうび: ただで契約できる (季節の番号まで) */
  prizeUntil?: number;
}

export interface TeamView {
  now: number;
  name: string;
  driverName: string;
  /** 管理者のギフトコードで贈られた称号 (リーグ戦の肩書きとは別の飾り) */
  giftTitle?: string | null;
  emblem: Emblem;
  money: number;
  held: number;
  cars: { player: CarRef | null; second: CarRef | null };
  crew: { level: number; maxLevel: number; stops: number; skill: number; factor: number; nextCost: number | null; practiceFull: boolean };
  driver: DriverView | null;
  research: Array<{ researchId: string; name: string; progress: number; eta: number }>;
  designs: Array<{ id: number; name: string; ok: boolean }>;
  standInFam: Record<string, number>;
  season: { index: number; endsAt: number };
  unread: number;
}

export interface DriversView {
  now: number;
  money: number;
  season: { index: number; endsAt: number };
  mine: DriverView | null;
  free: DriverView[];
  /** ギフトコードの契約金の割引 (%、次の 1 回。0 = なし) */
  discountPct?: number;
}

export interface ResearchNode {
  id: string;
  part: PartDef;
  requires: string | null;
  requiresName: string | null;
  boost: string[];
  cost: number;
  hours: number;
  buildCost: number;
  state: "done" | "active" | "open" | "busy" | "locked";
}

export interface ResearchView {
  now: number;
  money: number;
  parts: Inventory;
  tree: ResearchNode[];
  active: Array<{ researchId: string; name: string; startedAt: number; boostMs: number; progress: number; eta: number }>;
  manufactureMax: number;
}

/** 進化の画面 (GET /api/research/evolution、server/src/team.ts の evolutionView) */
export interface EvolutionView {
  now: number;
  money: number;
  parts: Inventory;
  items: Array<{ id: string; name: string; note: string; makes: string | null; count: number }>;
  recipes: Array<{
    id: string;
    from: string;
    to: string;
    fromPart: PartDef | null;
    toPart: PartDef | null;
    branch: string | null;
    requires: string | null;
    requiresName: string | null;
    unlocked: boolean;
    cost: number;
    owned: number;
  }>;
  limits: Array<{ id: string; part: PartDef; next: PartDef; owned: number }>;
  driver: { id: string; name: string; coached: number; coachMax: number; potential: Record<string, number> } | null;
}

export interface ListingView {
  id: string;
  mine: boolean;
  seller: string;
  mode: "fixed" | "auction";
  price: number;
  status: "open" | "sold" | "expired" | "cancelled";
  endsAt: number;
  item: { type: "part" | "design"; name: string; partId?: string; count?: number; parts?: number };
  bids: number;
  top: number | null;
  topMine: boolean;
  minNext: number;
  finalPrice?: number;
  boughtByMe?: boolean;
}

export interface SupplyView {
  id: string;
  role: "supplier" | "buyer";
  other: string;
  partId: string;
  name: string;
  unitPrice: number;
  maxUnits: number;
  delivered: number;
  status: "offered" | "active" | "declined" | "ended";
}

export interface MarketView {
  now: number;
  money: number;
  held: number;
  feeRate: number;
  listings: ListingView[];
  mine: ListingView[];
  supplies: SupplyView[];
  sellable: { parts: Inventory; designs: Array<{ id: number; name: string }>; made: string[] };
  limits: { minHours: number; maxHours: number; defaultHours: number };
}

export interface NoticeView {
  id: string;
  kind: string;
  title: string;
  text: string;
  at: number;
  read: boolean;
}

export const fetchTeam = () => call<TeamView>("GET", "/api/team");
export const saveEmblem = (emblem: Emblem) => call<{ emblem: Emblem }>("PUT", "/api/team/emblem", { emblem });
/** 1 台目・2 台目の設計図 (この機械の設計図を送るか、サーバーの設計図の id。null で外す) */
export const setCar = (slot: "player" | "second", o: { design?: CarDesign; designId?: number | null }) =>
  call<{ cars: TeamView["cars"] }>("PUT", "/api/team/cars", { slot, ...o });
export const upgradeCrew = () => after(call<{ level: number; cost: number; money: number }>("POST", "/api/team/crew"));

export const fetchDrivers = () => call<DriversView>("GET", "/api/drivers");
export const hireDriver = (driverId: string) => after(call<{ cost: number; penalty: number; money: number }>("POST", "/api/drivers/hire", { driverId }));
export const releaseDriver = () => after(call<{ penalty: number; money: number }>("POST", "/api/drivers/release"));
export const setRenew = (renew: boolean) => call<{ renew: boolean }>("PUT", "/api/drivers/renew", { renew });

export const fetchResearch = () => call<ResearchView>("GET", "/api/research");
export const startResearch = (researchId: string) => after(call<{ cost: number; money: number }>("POST", "/api/research/start", { researchId }));
export const cancelResearch = (researchId: string) => after(call<{ refund: number; money: number }>("POST", "/api/research/cancel", { researchId }));
export const manufacture = (partId: string, count: number) => after(call<{ cost: number; money: number; parts: Inventory }>("POST", "/api/research/manufacture", { partId, count }));

export const fetchEvolution = () => call<EvolutionView>("GET", "/api/research/evolution");
export const evolvePart = (recipeId: string) => after(call<{ cost: number; from: string; to: string; money: number; parts: Inventory }>("POST", "/api/research/evolve", { recipeId }));
export const limitBreakPart = (partId: string) => after(call<{ from: string; to: string; parts: Inventory }>("POST", "/api/research/limit", { partId }));
export const convertShards = (shard: string, count = 1) => after(call<{ made: string; count: number; parts: Inventory }>("POST", "/api/team/items/convert", { shard, count }));
export const coachDriver = () => after(call<{ driverId: string; coached: number; parts: Inventory }>("POST", "/api/team/items/coach"));

export const fetchMarket = (type?: "part" | "design") => call<MarketView>("GET", `/api/market${type ? `?type=${type}` : ""}`);
export const listItem = (o: { item: { type: "part"; partId: string; count: number } | { type: "design"; designId: number }; mode: "fixed" | "auction"; price: number; hours: number }) =>
  after(call<{ id: string }>("POST", "/api/market/list", o));
export const buyListing = (id: string) => after(call<{ money: number }>("POST", `/api/market/${id}/buy`));
export const bidListing = (id: string, amount: number) => after(call<{ money: number }>("POST", `/api/market/${id}/bid`, { amount }));
export const cancelListing = (id: string) => after(call<{ ok: boolean }>("POST", `/api/market/${id}/cancel`));
export const offerSupply = (o: { team: string; partId: string; unitPrice: number; maxUnits: number }) => call<{ id: string }>("POST", "/api/market/supply/offer", o);
export const answerSupply = (id: string, accept: boolean) => call<{ ok: boolean }>("POST", `/api/market/supply/${id}/answer`, { accept });
export const orderSupply = (id: string, count: number) => after(call<{ money: number }>("POST", `/api/market/supply/${id}/order`, { count }));

export const fetchNotices = () => call<{ notices: NoticeView[]; unread: number }>("GET", "/api/notices");
export const readNotices = () => call<{ unread: number }>("POST", "/api/notices/read");
