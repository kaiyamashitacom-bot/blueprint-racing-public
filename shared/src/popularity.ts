// コースの人気: 走られた回数と「いいね」を合わせて点を付ける。「いいね」はそのコースで走り終えた人だけ押せる。
// 大会には人気のコースも使う (管理者が並びを見て選ぶ)。
/** 「いいね」1 つが走られた回数いくつ分か (仮) */
export const LIKE_WEIGHT = 10;

export interface TrackPopularity {
  trackId: string;
  /** 走られた回数 (人の車 1 台がレースを走るごとに 1、仮) */
  drives: number;
  /** そのコースで走り終えたことのある人 (チーム id) */
  finishers: string[];
  /** 「いいね」を押した人 (チーム id) */
  likes: string[];
}

export function newTrackPopularity(trackId: string): TrackPopularity {
  return { trackId, drives: 0, finishers: [], likes: [] };
}

/** 人がこのコースを走ったときに呼ぶ (走り終えたら finished = true) */
export function recordTrackRun(p: TrackPopularity, playerId: string, finished: boolean): TrackPopularity {
  const finishers = finished && !p.finishers.includes(playerId) ? [...p.finishers, playerId] : p.finishers;
  return { ...p, drives: p.drives + 1, finishers };
}

export type LikeResult = { ok: true; pop: TrackPopularity } | { ok: false; reason: "not_finished" | "already" };

export function likeTrack(p: TrackPopularity, playerId: string): LikeResult {
  if (!p.finishers.includes(playerId)) return { ok: false, reason: "not_finished" };
  if (p.likes.includes(playerId)) return { ok: false, reason: "already" };
  return { ok: true, pop: { ...p, likes: [...p.likes, playerId] } };
}

/** 「いいね」を取り消す (仮: 取り消せる) */
export function unlikeTrack(p: TrackPopularity, playerId: string): TrackPopularity {
  return p.likes.includes(playerId) ? { ...p, likes: p.likes.filter((x) => x !== playerId) } : p;
}

export function canLikeTrack(p: TrackPopularity, playerId: string): boolean {
  return p.finishers.includes(playerId) && !p.likes.includes(playerId);
}

/** 人気の点 = 走られた回数 + いいね × LIKE_WEIGHT */
export function popularityScore(p: TrackPopularity): number {
  return p.drives + p.likes.length * LIKE_WEIGHT;
}

/** 人気の順 (点 → いいね → 走られた回数 → id) */
export function rankTracks(list: readonly TrackPopularity[]): { trackId: string; rank: number; score: number }[] {
  return [...list]
    .sort(
      (a, b) =>
        popularityScore(b) - popularityScore(a) ||
        b.likes.length - a.likes.length ||
        b.drives - a.drives ||
        (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0),
    )
    .map((p, i) => ({ trackId: p.trackId, rank: i + 1, score: popularityScore(p) }));
}
