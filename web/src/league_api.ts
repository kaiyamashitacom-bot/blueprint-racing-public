// リーグ戦 (2 時間ごとの自動のレース) の /api/league/... とのやりとり (サーバーは server/src/league.ts)。次のレースの時刻のほかはログインが要る
import { ApiFail, getToken } from "./api.ts";

async function call<T>(method: string, path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method, headers });
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

export interface NextRace {
  at: number;
  trackId: string;
  trackName: string;
  laps: number;
}

export interface LeagueRow {
  rank: number;
  name: string;
  mine: boolean;
  human: boolean;
  /** 人のチームの肩書き (王者 か 部の肩書き)。コンピューターは null */
  title: string | null;
  /** コンピューターのチームの性格 (rivals.ts の PersonalityId) */
  personality: string | null;
  points: number;
  wins: number;
  races: number;
}

export interface MyLeague {
  now: number;
  day: number;
  dayStart: number;
  next: NextRace;
  /** 計算を待っているレースの数 */
  pending: number;
  champion: { name: string; mine: boolean } | null;
  league: {
    id: string;
    name: string;
    division: number;
    title: string;
    divisionTitle: string;
    isChampion: boolean;
    rows: LeagueRow[];
  } | null;
  lastDay?: { day: number; rank: number | null; prize: number; moved: "up" | "down" | null; champion: boolean } | null;
}

export interface LeagueRaceCar {
  /** 自分のチームの車 */
  mine: boolean;
  team: string;
  driver: string;
  kind: "standin" | "hired" | "cpu" | "rival";
  human: boolean;
  grid: number;
  pos: number;
  points: number;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  total: number;
  best: number | null;
  fastest: boolean;
  pitStops: number;
  tire: string;
}

export interface LeagueRace {
  raceId: string;
  slot: number;
  at: number;
  leagueId: string;
  league: string;
  division: number;
  trackId: string;
  laps: number;
  status: "done" | "not_computed";
  wetMax: number;
  cars: LeagueRaceCar[];
}

export interface Ladder {
  day: number;
  divisions: Array<{ division: number; title: string; leagues: number; humans: number; mine: boolean }>;
  champion: { name: string; mine: boolean } | null;
  active: number;
}

export const fetchMyLeague = () => call<MyLeague>("GET", "/api/league");
export const fetchLeagueResults = (limit = 12) => call<{ results: LeagueRace[] }>("GET", `/api/league/results?limit=${limit}`);
export const fetchLadder = () => call<Ladder>("GET", "/api/league/ladder");
export const fetchNextRace = () => call<NextRace>("GET", "/api/league/next");
