// 季節・大会・管理者の /api/... とのやりとり (サーバーは server/src/season.ts)。
// 季節の順位と大会の一覧はログインなしでも読める。予選・予定・管理者はログインが要る
import {
  designHash,
  encodeGhost,
  type AdminConfig,
  type CarDesign,
  type ClassId,
  type SetOption,
  type SetPick,
  type StampId,
  type TireAlloc,
  type TireCompound,
  type TireSets,
  type TournamentWeather,
  type GiftItem,
  type PrizeSummary,
  type PrizeTier,
  type TournamentGrade,
} from "@bpr/shared";
import { ApiFail, fetchInventory, getToken } from "./api.ts";
import type { Ghost } from "./store.ts";

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

// ---------------------------------------------------------------- 季節

export interface TeamRow {
  rank: number;
  id: string;
  name: string;
  points: number;
  tournamentPoints: number;
  races: number;
  me: boolean;
}

export interface DriverRow extends TeamRow {
  team: string;
  hired: boolean;
}

export interface ConstructorRow {
  rank: number;
  id: string;
  name: string;
  main: number;
  league: number;
  total: number;
  me: boolean;
}

export interface Champ {
  teamId?: string;
  driverId?: string;
  team: string;
  name?: string;
  points: number;
  prize: number;
}

export interface SeasonSummary {
  season: number;
  at: number;
  overallConstructor: Champ | null;
  overallDriver: Champ | null;
  classes: Array<{ cls: ClassId; constructor: Champ | null; driver: Champ | null; top: { team: string; points: number } | null }>;
  moves: Array<{ team: string; from: ClassId | null; to: ClassId }>;
}

export interface SeasonView {
  now: number;
  season: { index: number; startsAt: number; endsAt: number };
  me: {
    team: string;
    driver: string;
    cls: ClassId | null;
    playClass: ClassId;
    classRank: number | null;
    classTeams: number;
    points: number;
    driverPoints: number;
    driverRank: number | null;
    constructorRank: number | null;
  } | null;
  classes: Array<{ cls: ClassId; teams: TeamRow[]; drivers: DriverRow[] }>;
  constructors: ConstructorRow[];
  drivers: DriverRow[];
  last: SeasonSummary | null;
}

export interface HistoryRow {
  season: number;
  cls: number | null;
  classRank: number | null;
  division: number | null;
  title: string | null;
  champion: boolean;
  stamps: StampId[];
  points: number;
  constructor: "overall" | "class" | null;
  driverChampion: "overall" | "class" | null;
  nextCls: number | null;
  prize: number;
}

export interface MyStamps {
  stamps: Array<{ id: StampId; count: number; name: string; desc: string; rarity: 1 | 2 | 3 }>;
  thisSeason: StampId[];
  history: HistoryRow[];
}

export const fetchSeason = () => call<SeasonView>("GET", "/api/season");
export const fetchMyStamps = () => call<MyStamps>("GET", "/api/season/me");

/** 季節の名前 (季節 0 = 2026-11-30 から) */
export function seasonLabel(index: number): string {
  return index < 0 ? "準備の季節" : `第 ${index + 1} 季`;
}

// ---------------------------------------------------------------- 大会

export type TourPhase = "qualifying" | "grid_set" | "lobby" | "racing" | "done" | "cancelled";

export interface TourBrief {
  id: string;
  name: string;
  trackId: string;
  trackName: string;
  laps: number;
  weather: TournamentWeather;
  startsAt: number;
  createdAt: number;
  qualifyClosesAt: number;
  groupSize: number;
  status: "open" | "running" | "done" | "cancelled";
  phase: TourPhase;
  entries: number;
  /** 格と景品 (11/25「大会ごとの景品」)。前の作りのサーバーからは来ない */
  grade?: TournamentGrade;
  auto?: boolean;
  allEnter?: boolean;
  prizes?: PrizeSummary;
  /** 管理者が直すときの中身 (null = 格のはじめの景品) */
  prizeSpec?: { prizes: PrizeTier[] | null; participation: GiftItem[] | null };
}

export interface TourTires {
  alloc: TireAlloc;
  sets: TireSets;
  locked: boolean;
  runs: number;
  options: SetOption[];
}

export interface TourView {
  now: number;
  tournament: TourBrief;
  rules: { limit: number; minDry: number };
  qualifying: Array<{ pos: number; driver: string; team: string; lap: number; gap: number | null; group: string; me: boolean }>;
  groups: Array<{ letter: string; cars: Array<{ key: string; name: string; team: string; kind: "human" | "hired"; lapTime: number | null; slot: number }> }> | null;
  results: Array<{
    finalPos: number;
    group: string;
    name: string;
    team: string;
    finished: boolean;
    dq: boolean;
    fastest: boolean;
    standIn: boolean;
    best: number | null;
    points: number;
    prize: number;
    /** 受け取った景品 (言い表し) と、受け取れなかったもの */
    gifts?: string[];
    giftsMissed?: string[];
    /** 走行点 (自分で走ったときだけ) */
    rp?: number;
  }> | null;
  me: {
    tires: TourTires | null;
    best: number | null;
    plan: { start: SetPick | null; fuel: "full" | "race" | "light" } | null;
    design: { name: string } | null;
    /** headless = この組はサーバーが計算する (つないでいなかった) */
    group: { index: number; letter: string; slot: number; headless?: boolean } | null;
    raceSetup: { tire: TireCompound; wear: number; sets: TireSets } | null;
  } | null;
}

export const fetchTournaments = () => call<{ now: number; tournaments: TourBrief[] }>("GET", "/api/tournaments");
export const fetchTournament = (id: string) => call<TourView>("GET", `/api/tournaments/${encodeURIComponent(id)}`);
export const setQualiTires = (id: string, alloc: TireAlloc) => call<{ tires: TourTires }>("POST", `/api/tournaments/${id}/tires`, { alloc });
export const setTourPlan = (id: string, plan: { start?: SetPick | null; fuel?: "full" | "race" | "light"; design?: CarDesign }) =>
  call<{ plan: unknown }>("POST", `/api/tournaments/${id}/plan`, plan.design ? { ...plan, design: { name: plan.design.name, parts: plan.design.parts } } : plan);

export interface QualiRes {
  improved: boolean;
  best: number | null;
  rank: number | null;
  total: number;
  tires: TourTires;
}

/** 予選の 1 回の走り (速い周があれば幽霊の線つき) */
export function sendQualiRun(id: string, o: { pick: SetPick; endWear: number; burst: boolean; best: Ghost | null; design: CarDesign; mt?: boolean }): Promise<QualiRes> {
  return call<QualiRes>("POST", `/api/tournaments/${id}/quali`, {
    // マニュアル (自分で変速) の走り: サーバーは速さの上限を上がり分だけゆるめる
    ...(o.mt ? { mt: true } : {}),
    pick: o.pick,
    endWear: o.endWear,
    burst: o.burst,
    design: { name: o.design.name, parts: o.design.parts },
    ...(o.best ? { lap: o.best.lap, ghost: encodeGhost(o.best.pts), designHash: designHash(o.design) } : {}),
  });
}

// ---------------------------------------------------------------- 管理者

export interface PlayerRow {
  login: string;
  team: string;
  driver: string;
  money: number;
  cls: number | null;
  createdAt: number;
  lastLogin: number | null;
  admin: boolean;
  /** 止められていれば わけ (空の文字もある)、止められていなければ null */
  suspended?: string | null;
}

export const fetchAdminConfig = () => call<{ config: AdminConfig; defaults: AdminConfig }>("GET", "/api/admin/config");
export const saveAdminConfig = (patch: Partial<AdminConfig>) => call<{ config: AdminConfig }>("PUT", "/api/admin/config", patch);
export const resetAdminConfig = () => call<{ config: AdminConfig }>("POST", "/api/admin/config/reset");
/** 数の変更の記録 1 件 (server/src/admin_config_log.ts) */
export interface AdminConfigLogRow {
  id: number;
  at: number;
  adminId: number | null;
  admin: string | null;
  action: "save" | "reset" | "import" | "restore" | "undo";
  ref: number | null;
  changes: Array<{ path: string; before: unknown; after: unknown }>;
}
export const fetchAdminConfigHistory = () => call<{ entries: AdminConfigLogRow[] }>("GET", "/api/admin/config/history");
export const importAdminConfig = (config: Partial<AdminConfig>) => call<{ config: AdminConfig }>("POST", "/api/admin/config/import", { config });
export const undoAdminConfig = () => call<{ config: AdminConfig }>("POST", "/api/admin/config/undo");
export const restoreAdminConfig = (id: number, side: "after" | "before" = "after") => call<{ config: AdminConfig }>("POST", `/api/admin/config/history/${id}/restore`, { side });
export const fetchPlayers = () => call<{ players: PlayerRow[] }>("GET", "/api/admin/players");
export const fetchAdminTournaments = () => call<{ now: number; tournaments: TourBrief[]; tracks: Array<{ id: string; name: string }> }>("GET", "/api/admin/tournaments");

export interface TourInput {
  name: string;
  startsAt: number;
  trackId: string;
  laps: number;
  weather: TournamentWeather;
  groupSize: number;
  grade?: TournamentGrade;
  allEnter?: boolean;
  /** null = 格のはじめの景品 */
  prizes?: PrizeTier[] | null;
  participation?: GiftItem[] | null;
}

export const createTournament = (t: TourInput) => call<{ tournament: { id: string } }>("POST", "/api/admin/tournaments", t);
export const updateTournament = (id: string, t: Partial<TourInput>) => call<{ tournament: { id: string } }>("PUT", `/api/admin/tournaments/${id}`, t);
export const cancelTournament = (id: string) => call<{ ok: true }>("DELETE", `/api/admin/tournaments/${id}`);

/** お金の動くことのあとに財布の写しを読み直す */
export function refreshWallet() {
  fetchInventory().catch(() => {});
}
