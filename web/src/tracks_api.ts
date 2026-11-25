// みんなのコースの /api/tracks とのやりとり (サーバーは server/src/tracks.ts)。
// 一覧と形はログインなしでも読める。出す・走った・いいね・管理者はログインが要る。
// 読んだ形は registerTrackDef で getTrack から引けるようにし、この機械にも少し覚えておく (練習の画面を読み直したときのため)
import { PUB_TRACK_PREFIX, isPublicTrackId, knownTrackDef, registerTrackDef, type TrackDef } from "@bpr/shared";
import { ApiFail, getToken } from "./api.ts";

export type TrackStatus = "pending" | "public" | "rejected";

export interface MyTrackRow {
  id: string;
  localId: string;
  name: string;
  status: TrackStatus;
  reason: string | null;
  length: number;
  authorLap: number;
  submittedAt: number;
  reviewedAt: number | null;
}

export interface PublicTrackRow {
  id: string;
  name: string;
  author: string;
  length: number;
  drives: number;
  likes: number;
  score: number;
  rank: number;
  publishedAt: number;
  record: { lap: number; driver: string } | null;
  points: Array<[number, number]>;
  finished?: boolean;
  liked?: boolean;
  mine?: boolean;
}

export interface AdminTrackRow extends MyTrackRow {
  author: string;
  login: string | null;
  def: TrackDef;
  drives: number;
  likes: number;
}

export interface TrackDetail {
  def: TrackDef;
  meta: PublicTrackRow | null;
  status: TrackStatus;
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
  if (!res.ok) throw new ApiFail(res.status, typeof data.error === "string" ? data.error : `うまくいきませんでした (${res.status})`);
  return data as T;
}

/** "pub:12" → "12" (URL の中) */
function num(id: string): string {
  return isPublicTrackId(id) ? id.slice(PUB_TRACK_PREFIX.length) : id;
}

// ---------------------------------------------------------------- この機械に覚えておく形

const CACHE_KEY = "bpr.pubtracks.v1";
/** 覚えておく数 (仮) */
const CACHE_MAX = 30;

function readCache(): TrackDef[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as TrackDef[]).filter((d) => d && typeof d.id === "string" && Array.isArray(d.points)) : [];
  } catch {
    return [];
  }
}

function remember(def: TrackDef) {
  registerTrackDef(def);
  const list = readCache().filter((d) => d.id !== def.id);
  list.unshift(def);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list.slice(0, CACHE_MAX)));
  } catch {
    /* 保存できなくてもよい */
  }
}

/** はじめに 1 回: 覚えておいた形を getTrack で引けるようにする */
export function restoreCachedTracks(): void {
  for (const d of readCache().reverse()) registerTrackDef(d);
}

/**
 * コースの形を用意する (公式ならすぐ。"pub:<n>" は覚えていなければサーバーから読む)。
 * 部屋 (online.ts) でみんなのコースを走るときも、getTrack の前にこれを await する
 */
export async function ensureTrack(id: string): Promise<TrackDef | null> {
  const known = knownTrackDef(id);
  if (known) return known;
  if (!isPublicTrackId(id)) return null;
  const r = await fetchTrack(id);
  return r.def;
}

// ---------------------------------------------------------------- みんなのコース

export const fetchPublicTracks = (sort: "popular" | "new" = "popular") => call<{ tracks: PublicTrackRow[] }>("GET", `/api/tracks?sort=${sort}`).then((r) => r.tracks);

export async function fetchTrack(id: string): Promise<TrackDetail> {
  const r = await call<TrackDetail>("GET", `/api/tracks/${num(id)}`);
  if (r.status === "public") remember(r.def);
  else registerTrackDef(r.def);
  return r;
}

export const fetchMyTracks = () => call<{ tracks: MyTrackRow[] }>("GET", "/api/tracks/mine").then((r) => r.tracks);

/** 自分のコースを出す (確かめ待ちに)。lapTime = 自分の一番速い周 (秒) */
export const submitTrack = (localId: string, def: TrackDef, lapTime: number) =>
  call<{ track: MyTrackRow }>("POST", "/api/tracks", { localId, def, lapped: true, lapTime }).then((r) => r.track);

export const withdrawTrack = (id: string) => call<{ ok: true }>("DELETE", `/api/tracks/${num(id)}`);

/** 走った (練習で 1 周走り終えた・部屋で走り終えた) */
export const recordTrackRun = (id: string, finished: boolean, lap?: number) =>
  call<{ counted: boolean; best: number | null }>("POST", `/api/tracks/${num(id)}/run`, { finished, lap });

export const likeTrack = (id: string, on: boolean) => call<{ likes: number; liked: boolean }>(on ? "POST" : "DELETE", `/api/tracks/${num(id)}/like`);

// ---------------------------------------------------------------- 管理者

export const fetchAdminTracks = (status: TrackStatus | "all" = "pending") => call<{ tracks: AdminTrackRow[] }>("GET", `/api/admin/tracks?status=${status}`).then((r) => r.tracks);

export const reviewTrack = (id: string, action: "approve" | "reject", opts: { reason?: string; name?: string } = {}) =>
  call<{ track: AdminTrackRow }>("POST", `/api/admin/tracks/${num(id)}/review`, { action, ...opts }).then((r) => r.track);
