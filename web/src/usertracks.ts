// 遊ぶ人が作ったコース (この機械の中に保存)。公開は tracks_api.ts の submitTrack (自分で 1 周 + 管理者の確かめ)
// store.ts の Save とは別の鍵に置く
import { buildTrack, getTrack, type Track, type TrackDef } from "@bpr/shared";

export interface UserTrack {
  /** "user:" を付けない印 */
  id: string;
  def: TrackDef;
  /** 点の間ごとに壁か (flags[i] は 点 i → 点 i+1)。def.walls はここから作る */
  wallSegs: boolean[];
  /** 自分で 1 周走れたか (公開の条件のひとつ)。形を変えると消える */
  lapped: boolean;
  /** 一番速い周 (秒) */
  bestLap?: number;
  /** 自分で置いた DRS の区間 (1 周に対する割合の 始まり・終わり)。なし = 長い直線から自動。空 = DRS なし。def.drs はここから作る */
  drsFr?: Array<[number, number]>;
  created: number;
  updated: number;
}

interface TrackSave {
  v: 1;
  tracks: UserTrack[];
}

const KEY = "bpr.tracks.v1";
export const USER_PREFIX = "user:";

let cache: TrackSave | null = null;

function loadAll(): TrackSave {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as TrackSave;
      if (s && s.v === 1 && Array.isArray(s.tracks)) {
        cache = { v: 1, tracks: s.tracks.filter((t) => t && typeof t.id === "string" && t.def && Array.isArray(t.def.points)) };
        return cache;
      }
    }
  } catch {
    /* 読めなければ空から */
  }
  cache = { v: 1, tracks: [] };
  return cache;
}

function saveAll(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadAll()));
  } catch {
    /* 保存できない (内緒の窓など) */
  }
}

export function listUserTracks(): UserTrack[] {
  return loadAll().tracks.slice().sort((a, b) => b.updated - a.updated);
}

export function isUserTrackId(trackId: string): boolean {
  return trackId.startsWith(USER_PREFIX);
}

function bareId(trackId: string): string {
  return isUserTrackId(trackId) ? trackId.slice(USER_PREFIX.length) : trackId;
}

export function getUserTrack(id: string): UserTrack | null {
  const b = bareId(id);
  return loadAll().tracks.find((t) => t.id === b) ?? null;
}

export function newUserTrackId(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 足す・書きかえる (同じ id なら置きかえ) */
export function putUserTrack(t: UserTrack): void {
  const all = loadAll();
  t.updated = Date.now();
  t.def = { ...t.def, id: USER_PREFIX + t.id };
  const i = all.tracks.findIndex((x) => x.id === t.id);
  if (i >= 0) all.tracks[i] = t;
  else all.tracks.push(t);
  builtCache.delete(USER_PREFIX + t.id);
  saveAll();
}

export function deleteUserTrack(id: string): void {
  const all = loadAll();
  const b = bareId(id);
  all.tracks = all.tracks.filter((t) => t.id !== b);
  builtCache.delete(USER_PREFIX + b);
  saveAll();
}

export function duplicateUserTrack(id: string): UserTrack | null {
  const src = getUserTrack(id);
  if (!src) return null;
  const now = Date.now();
  const copy: UserTrack = {
    id: newUserTrackId(),
    def: { ...src.def, name: `${src.def.name} のコピー`.slice(0, 20), points: src.def.points.map((p) => [p[0], p[1]]) },
    wallSegs: src.wallSegs.slice(),
    ...(src.drsFr ? { drsFr: src.drsFr.map((z) => [z[0], z[1]] as [number, number]) } : {}),
    lapped: false,
    created: now,
    updated: now,
  };
  putUserTrack(copy);
  return copy;
}

/** "user:<id>" (または "<id>") のコースの形。なければ null */
export function userTrackDef(id: string): TrackDef | null {
  const t = getUserTrack(id);
  return t ? { ...t.def, id: USER_PREFIX + t.id } : null;
}

const builtCache = new Map<string, { updated: number; track: Track }>();

/** "user:<id>" のコースを組み立てる。なければ null */
export function userTrack(id: string): Track | null {
  const t = getUserTrack(id);
  if (!t) return null;
  const key = USER_PREFIX + t.id;
  const hit = builtCache.get(key);
  if (hit && hit.updated === t.updated) return hit.track;
  const track = buildTrack({ ...t.def, id: key });
  builtCache.set(key, { updated: t.updated, track });
  return track;
}

/** 練習などで使う: 公式のコースも作ったコースも、id から探す ("pub:<n>" は tracks_api.ts の ensureTrack で先に読んでおく) */
export function resolveTrack(trackId: string): Track {
  if (isUserTrackId(trackId)) {
    const t = userTrack(trackId);
    if (t) return t;
  }
  return getTrack(trackId);
}

/** 1 周走り切れたら呼ぶ (公開の条件の「1 周走れた」)。lapTime は秒 */
export function markUserTrackLapped(trackId: string, lapTime?: number): void {
  if (!isUserTrackId(trackId)) return;
  const t = getUserTrack(trackId);
  if (!t) return;
  t.lapped = true;
  if (lapTime !== undefined && Number.isFinite(lapTime) && (t.bestLap === undefined || lapTime < t.bestLap)) t.bestLap = lapTime;
  // updated は変えない (組み立てた形の写しをそのまま使う)
  saveAll();
}
