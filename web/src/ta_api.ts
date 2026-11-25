// 1 周アタックの /api/ta/... とのやりとり (サーバーは server/src/timeattack.ts)。
// 順位表と幽霊はログインなしでも読める。送るのはログインしているときだけ。
// ログインしていないときの自分の記録は、この機械にだけ置く (bpr.ta.v1)
import { decodeGhost, designHash, encodeGhost, type CarDesign, type TaWeek, type TireCompound } from "@bpr/shared";
import { ApiFail, getToken } from "./api.ts";
import type { Ghost } from "./store.ts";

export interface TaRow {
  rank: number;
  driver: string;
  team: string;
  lap: number;
  me: boolean;
  /** マニュアル (自分で変速) の記録 (前のサーバーからは来ない) */
  mt?: boolean;
}

export interface TaBoard {
  week: TaWeek;
  now: number;
  conditions: { sky: "sun"; tire: TireCompound; wear: number; fuel: "full" };
  top: TaRow[];
  me: { rank: number; lap: number } | null;
  total: number;
}

export interface TaGhostRow extends TaRow {
  ghost: Ghost;
}

export interface TaSubmitRes {
  improved: boolean;
  best: { rank: number; lap: number };
  total: number;
  /** 走行点 (server/src/racepoints.ts。入らない設定なら無し) */
  rp?: { earned: number; left: number; points: number };
}

/** 走行点の言い表し (「 · 走行点 +5」。入らなければ "") */
export function taRpText(r: TaSubmitRes): string {
  if (!r.rp) return "";
  return r.rp.earned > 0 ? ` · 走行点 +${r.rp.earned}` : r.rp.left <= 0 ? " · 走行点は今日の上限" : "";
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

export function fetchTaBoard(): Promise<TaBoard> {
  return call<TaBoard>("GET", "/api/ta/board");
}

/** 上位の幽霊 (線だけ)。ログインしていれば自分の幽霊も付く */
export async function fetchTaGhosts(n = 5): Promise<TaGhostRow[]> {
  const r = await call<{ ghosts: Array<TaRow & { ghost: string }> }>("GET", `/api/ta/ghosts?n=${n}`);
  const out: TaGhostRow[] = [];
  for (const g of r.ghosts) {
    const pts = decodeGhost(g.ghost);
    if (pts) out.push({ ...g, ghost: { lap: g.lap, pts } });
  }
  return out;
}

/** mt = マニュアル (自分で変速) で走った周 (サーバーは速さの上限を上がり分だけゆるめ、記録に MT の印) */
export function submitTaLap(week: number, ghost: Ghost, design: CarDesign, mt = false): Promise<TaSubmitRes> {
  return call<TaSubmitRes>("POST", "/api/ta/submit", {
    ...(mt ? { mt: true } : {}),
    week,
    lap: ghost.lap,
    ghost: encodeGhost(ghost.pts),
    design: { name: design.name, parts: design.parts },
    designHash: designHash(design),
  });
}

/** 練習の賞金の返事 (server/src/practice.ts の PracticeLapRes) */
export interface PracticeLapRes {
  earned: number;
  left: number;
  money: number;
}

/** 練習の 1 周を送る (ログインが要る)。サーバーが 1 周アタックと同じ確かめをして、1 日の上限まで賞金を払う */
export function submitPracticeLap(trackId: string, ghost: Ghost, design: CarDesign, mt = false): Promise<PracticeLapRes> {
  return call<PracticeLapRes>("POST", "/api/practice/lap", {
    ...(mt ? { mt: true } : {}),
    trackId,
    lap: ghost.lap,
    ghost: encodeGhost(ghost.pts),
    design: { name: design.name, parts: design.parts },
    designHash: designHash(design),
  });
}

// ---- この機械の記録 (週ごとの自分の一番速い周と幽霊、選んだ幽霊) ----

interface LocalTa {
  week: number;
  best: Ghost | null;
  /** 選んだ幽霊 (3 つまで、"," でつなぐ): "順位:名前" = その人・"me" = 自分・"none" = なし・"top" (はじめ) = 一番速い人 */
  rival: string;
}

const KEY = "bpr.ta.v1";

export function loadLocalTa(week: number): LocalTa {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as LocalTa & { best: { lap: number; pts: string } | null };
      if (v && v.week === week) {
        const pts = v.best ? decodeGhost(v.best.pts) : null;
        return { week, best: v.best && pts ? { lap: v.best.lap, pts } : null, rival: typeof v.rival === "string" ? v.rival : "top" };
      }
      if (v && typeof v.rival === "string") return { week, best: null, rival: v.rival };
    }
  } catch {
    /* 読めなければ新しく */
  }
  return { week, best: null, rival: "top" };
}

export function saveLocalTa(v: LocalTa): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ week: v.week, rival: v.rival, best: v.best ? { lap: v.best.lap, pts: encodeGhost(v.best.pts) } : null }));
  } catch {
    /* 保存できない (内緒の窓など) */
  }
}
