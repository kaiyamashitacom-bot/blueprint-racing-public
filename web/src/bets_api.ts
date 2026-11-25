// 賭け (/api/bets/... と管理者の /api/admin/bets) とのやりとり。サーバーは server/src/bets_league.ts と bets.ts。
// 賭けられるのはゲームの中のお金だけ (送るのは raceId・kind・pick・stake・odds だけ)
import { ApiFail, getToken } from "./api.ts";

/** tourwin = 大会の優勝 (/api/tourbets) */
export type BetKind = "win" | "top3" | "pair" | "tourwin";

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
    const err = new ApiFail(res.status, typeof data.error === "string" ? data.error : `うまくいきませんでした (${res.status})`) as ApiFail & { data?: unknown };
    err.data = data;
    throw err;
  }
  return data as T;
}

export interface BetRaceBrief {
  raceId: string;
  league: string;
  division: number;
  /** 自分のチームが出る (賭けられない) */
  mine: boolean;
  teams: Array<{ name: string; human: boolean }>;
}

export interface BetSlot {
  slot: number;
  startsAt: number;
  closesAt: number;
  open: boolean;
  trackId: string;
  trackName: string;
  laps: number;
  races: BetRaceBrief[];
}

export interface BetRaces {
  now: number;
  paused: boolean;
  closeMinutes: number;
  margin: number;
  slots: BetSlot[];
}

export interface BookCarView {
  /** "0/1" = 0 番のチームの 1 台目 */
  car: string;
  driver: string;
  grid: number;
  win: number | null;
  top3: number | null;
  pWin: number;
  pTop3: number;
}

export interface RaceBookView {
  raceId: string;
  league: string;
  division: number;
  startsAt: number;
  closesAt: number;
  open: boolean;
  mine: boolean;
  trackId: string;
  trackName: string;
  laps: number;
  sky: string;
  paused: boolean;
  teams: Array<{ i: string; name: string; human: boolean; cars: BookCarView[] }>;
  pairs: Array<{ a: string; b: string; oddsA: number | null; oddsB: number | null; pA: number }>;
}

export interface BetView {
  id: number;
  raceId: string;
  startsAt: number;
  race: string;
  kind: BetKind;
  label: string;
  stake: number;
  odds: number;
  status: "open" | "won" | "lost" | "void";
  payout: number;
  placedAt: number;
  settledAt: number | null;
}

export interface MyBets {
  open: BetView[];
  history: BetView[];
  todayStaked: number;
  totals: { bets: number; staked: number; back: number };
  limits: { minStake: number; maxStake: number | null; maxPerDay: number | null; maxShareOfMoney: number | null };
  blocked: string | null;
}

export type BetPickView = { car: string } | { first: string; second: string };

export const fetchBetRaces = () => call<BetRaces>("GET", "/api/bets/races");
export const fetchRaceBook = (raceId: string) => call<RaceBookView>("GET", `/api/bets/race/${encodeURIComponent(raceId)}`);
export const fetchMyBets = () => call<MyBets>("GET", "/api/bets/mine");
export const placeBet = (b: { raceId: string; kind: BetKind; pick: BetPickView; stake: number; odds: number }) => call<{ bet: BetView; money: number }>("POST", "/api/bets", b);

// ---- 大会の優勝 (/api/tourbets、サーバーは server/src/bets_tour.ts)

export interface TourBetCarView {
  /** A 組の並びの番号 ("0" = 先頭) */
  car: string;
  driver: string;
  team: string;
  /** A 組の中のスタートの並び (1 から) */
  grid: number;
  /** 予選の記録 (秒、なし = 走っていない) */
  qualiLap: number | null;
  /** 予選の記録の無い車の 強さの見込みの 1 周 (秒) */
  estLap: number | null;
  pWin: number;
  odds: number | null;
}

export interface TourBookView {
  tourId: string;
  name: string;
  trackName: string;
  laps: number;
  startsAt: number;
  closesAt: number;
  open: boolean;
  /** 自分のチームの車が A 組にいる (賭けられない) */
  mine: boolean;
  group: string;
  cars: TourBetCarView[];
}

export interface TourBets {
  now: number;
  paused: boolean;
  margin: number;
  /** 組が決まる = 賭けが開くのはスタートのこの分前 */
  leadMinutes: number;
  tours: TourBookView[];
  upcoming: Array<{ tourId: string; name: string; trackName: string; laps: number; startsAt: number; opensAt: number; allEnter: boolean }>;
}

export const fetchTourBets = () => call<TourBets>("GET", "/api/tourbets");
export const placeTourBet = (b: { tourId: string; car: string; stake: number; odds: number }) => call<{ bet: BetView; money: number }>("POST", "/api/tourbets", b);

export interface BetStatsPart {
  bets: number;
  won: number;
  staked: number;
  paid: number;
  houseTake: number;
}

export interface BetAdminStats {
  all: BetStatsPart;
  today: BetStatsPart;
  open: { bets: number; staked: number };
  refunded: { bets: number; staked: number };
  players: number;
  paused: boolean;
  realMoneyEnabled: boolean;
  margin: number;
}

export const fetchBetStats = () => call<BetAdminStats>("GET", "/api/admin/bets");
export const setBetPaused = (paused: boolean) => call<BetAdminStats>("PUT", "/api/admin/bets", { paused });
