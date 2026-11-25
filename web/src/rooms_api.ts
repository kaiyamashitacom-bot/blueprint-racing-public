// 開いた部屋 (/api/rooms)・走る前の準備をサーバーに残す (/api/team/setup)・遊ぶ人の管理 (止める・招く) とのやりとり
import type { ClassId, Phase } from "@bpr/shared";
import { ApiFail, getToken, isLoggedIn } from "./api.ts";
import type { RaceSetup } from "./store.ts";

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

// ---------------------------------------------------------------- 開いた部屋

export type JoinBlock = "started" | "class" | "full" | "closing";

export interface RoomView {
  id: string;
  trackId: string;
  trackName: string;
  laps: number;
  cls: ClassId;
  host: string;
  phase: Phase;
  humans: number;
  cars: number;
  seats: number;
  endsAt: number;
  createdAt: number;
  mine: boolean;
  block: JoinBlock | null;
}

export interface RoomsList {
  rooms: RoomView[];
  /** 自分の級 (名無しは一番下) */
  cls: ClassId;
  loggedIn: boolean;
  tracks: Array<{ id: string; name: string }>;
  laps: { min: number; max: number };
}

export const fetchRooms = () => call<RoomsList>("GET", "/api/rooms");
export const createRoom = (trackId: string, laps: number) => call<{ room: RoomView; created: boolean }>("POST", "/api/rooms", { trackId, laps });
export const checkJoinRoom = (id: string) => call<{ room: RoomView }>("POST", `/api/rooms/${encodeURIComponent(id)}/join`);

// ---------------------------------------------------------------- 走る前の準備 (代走が使う)

let lastSent = "";
let timer = 0;

/**
 * 走る前の準備をサーバーに残す (リーグ戦の代走がこのタイヤと燃料で走る)。ログインしているときだけ。
 * 変わっていなければ送らない。soon = 少し待ってまとめて送る (札を押している間)
 */
export function syncRaceSetup(setup: RaceSetup, soon = false): void {
  if (!isLoggedIn()) return;
  const body = JSON.stringify({ tire: setup.tire, fuel: setup.fuel, alloc: setup.alloc, tireFor: setup.tireFor });
  if (body === lastSent) return;
  clearTimeout(timer);
  const send = () => {
    lastSent = body;
    call("PUT", "/api/team/setup", { setup: JSON.parse(body) }).catch(() => {
      lastSent = "";
    });
  };
  if (soon) timer = window.setTimeout(send, 1500);
  else send();
}

// ---------------------------------------------------------------- 遊ぶ人の管理 (管理者)

export interface InviteRow {
  code: string;
  note: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

export const fetchRegisterInfo = () => call<{ inviteOnly: boolean }>("GET", "/api/register/info");
export const setSuspended = (id: string, suspended: boolean, reason?: string) => call<{ id: string; suspended: boolean }>("POST", "/api/admin/suspend", { id, suspended, reason });
export const fetchInvites = () => call<{ invites: InviteRow[] }>("GET", "/api/admin/invites");
export const createInvites = (count: number, note: string) => call<{ codes: string[] }>("POST", "/api/admin/invites", { count, note });
export const deleteInvite = (code: string) => call<{ ok: true }>("DELETE", `/api/admin/invites/${encodeURIComponent(code)}`);
