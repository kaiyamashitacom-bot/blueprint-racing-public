// 大会の並びの「強さ」(11/25 ユーザー: 予選を走らなかった車は 予選を走った車の後ろに、強い車ほど後ろ)。
// 強さ (仮) = そのコースの見込みの 1 周の秒: 試しの台 (bench.ts の benchLap、一番上手いコンピューター) の 1 周に、
// 運転する人の上手さの分を足す (人の車 = 代走の上手さ、2 台目 = 雇った運転手の上手さ)。
// benchLap は 2 周走らせるので重い。設計図とコースごとに覚えておく (この機械の中だけ。数に上限)。
import { benchLap } from "./bench.ts";
import { computeStats, isNeutralStrength, partKindMul, type CarDesign, type PartStrength } from "./design.ts";
import { BASE_PART_KINDS } from "./parts.ts";
import { getTrack } from "./tracks.ts";

/** 上手さ 1 から下がった分 × これだけ 1 周が延びる (仮。上手さ 0.8 で +5%) */
export const SKILL_LAP_SLOPE = 0.25;
/** 覚えておく数 (仮) */
export const BENCH_CACHE_MAX = 400;

const cache = new Map<string, number | null>();

/** 設計図とコースの試しの台の 1 周 (秒、走り切れなければ null)。覚えておく */
export function cachedBenchLap(design: CarDesign, trackId: string, strength?: Readonly<PartStrength> | null): number | null {
  const st = isNeutralStrength(strength) ? null : strength!;
  const sk = st ? [st.partStrength, ...BASE_PART_KINDS.map((k) => partKindMul(st, k))].join(",") : "";
  const key = `${trackId}|${sk}|${JSON.stringify(design.parts)}`;
  if (cache.has(key)) {
    const v = cache.get(key)!;
    // 最近使った物を後ろへ
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  let lap: number | null = null;
  try {
    lap = benchLap(computeStats(design, st), getTrack(trackId)).lap;
  } catch {
    lap = null;
  }
  cache.set(key, lap);
  while (cache.size > BENCH_CACHE_MAX) cache.delete(cache.keys().next().value!);
  return lap;
}

/** 見込みの 1 周 (秒)。skill は bot.ts の上手さ (0..1)。走り切れない車は Infinity (一番弱い) */
export function estimatedLap(design: CarDesign, trackId: string, skill: number, strength?: Readonly<PartStrength> | null): number {
  const lap = cachedBenchLap(design, trackId, strength);
  if (lap === null) return Infinity;
  return lap * (1 + SKILL_LAP_SLOPE * Math.max(0, 1 - skill));
}
