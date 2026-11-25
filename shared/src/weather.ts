// 天気: レースごとに種から予定を作る (晴れ・小雨・大雨がレースの途中でも変わる)。
// 路面の濡れ具合 (0 = 乾いている、1 = びしょびしょ) は空に向かって少しずつ動く:
// 降り始めはまだ滑らず、やんでもしばらく濡れたまま。
// 予報は予定から作るが、時間がずれたり、来ない雨を言ったりする (外れることもある)。
// 画面とサーバーが同じ予定から同じ数を出せるように、ここには Math.random を使わない。
import type { TireCompound } from "./tires.ts";
import { TIRE_DEFS } from "./tires.ts";
import type { Track, TrackQuery } from "./track.ts";

export type Sky = "sun" | "light" | "heavy";

export const SKY_NAMES: Readonly<Record<Sky, string>> = { sun: "晴れ", light: "小雨", heavy: "大雨" };

export interface WeatherChange {
  /** 信号が消えてからの秒 */
  at: number;
  sky: Sky;
}

export interface WeatherPlan {
  seed: number;
  /** 空の変わり目 (最初は at = 0) */
  changes: WeatherChange[];
  /** 予報だけに出て、来ない変わり目 (外れる予報) */
  fakes: WeatherChange[];
  /** スタートのときの濡れ具合 */
  startWet: number;
}

/** 空ごとの、路面が向かう濡れ具合 (仮) */
export const SKY_WET: Readonly<Record<Sky, number>> = { sun: 0, light: 0.5, heavy: 0.95 };
/** 濡れていく速さ (1 秒あたり、仮)。小雨は 0 → 0.5 に約 40 秒、大雨は 0 → 0.95 に約 33 秒 */
const RISE: Readonly<Record<Sky, number>> = { sun: 0, light: 1 / 80, heavy: 1 / 35 };
/** 乾く速さ (1 秒あたり、仮)。びしょびしょから乾くまで 約 2 分半 */
const DRY = 1 / 150;

function lcg(seed: number): () => number {
  let s = Math.floor(Math.abs(seed)) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** 種と番号から 0..1 の数 (予報のずれに使う。何度呼んでも同じ) */
function hash01(seed: number, k: number): number {
  let h = (Math.floor(seed) ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export interface WeatherOptions {
  /** 雨が降る見込みの強さ (0 = いつも晴れ、1 = 雨がち)。ふだんは 0.5 (仮) */
  rain?: number;
  /** 最初の空を決める */
  startSky?: Sky;
}

/** 天気の予定を作る。raceSeconds はレースのおよその長さ (秒)。その先まで少し余分に作る */
export function makeWeatherPlan(seed: number, raceSeconds: number, opts: WeatherOptions = {}): WeatherPlan {
  const r = lcg(seed);
  const rain = Math.max(0, Math.min(1, opts.rain ?? 0.5));
  const horizon = Math.max(120, raceSeconds * 1.4 + 120);
  let sky: Sky = opts.startSky ?? (r() < 0.75 - 0.35 * rain ? "sun" : r() < 0.7 ? "light" : "heavy");
  const changes: WeatherChange[] = [{ at: 0, sky }];
  const fakes: WeatherChange[] = [];
  // 半分くらいは、レースの間ずっと同じ空 (仮)
  const steady = r() < 0.6 - 0.3 * rain;
  let t = 0;
  while (!steady && t < horizon) {
    const len = sky === "sun" ? 120 + r() * 280 : 60 + r() * 160;
    if (sky === "sun" && r() < 0.5) {
      // 晴れの間に、来ない雨の予報をはさむ
      const at = t + len * (0.4 + r() * 0.5);
      fakes.push({ at, sky: r() < 0.8 ? "light" : "heavy" });
    }
    t += len;
    const x = r();
    if (sky === "sun") sky = x < 0.82 ? "light" : "heavy";
    else if (sky === "light") sky = x < 0.55 ? "sun" : "heavy";
    else sky = x < 0.8 ? "light" : "sun";
    // 晴れに戻りにくい日もある
    if (sky === "sun" && r() < rain * 0.3) sky = "light";
    if (changes[changes.length - 1].sky !== sky) changes.push({ at: Math.round(t), sky });
  }
  if (steady && sky === "sun" && r() < 0.5) {
    fakes.push({ at: Math.round(60 + r() * Math.max(60, raceSeconds - 60)), sky: "light" });
  }
  return { seed: Math.floor(seed), changes, fakes, startWet: SKY_WET[changes[0].sky] };
}

/** ずっと晴れの予定 (練習など) */
export function dryPlan(): WeatherPlan {
  return { seed: 1, changes: [{ at: 0, sky: "sun" }], fakes: [], startWet: 0 };
}

/** t 秒 (信号が消えてから) の空 */
export function skyAt(plan: WeatherPlan, t: number): Sky {
  let sky = plan.changes[0]?.sky ?? "sun";
  for (const c of plan.changes) {
    if (c.at > t) break;
    sky = c.sky;
  }
  return sky;
}

function approach(w: number, sky: Sky, sec: number, dryMul = 1): number {
  const target = SKY_WET[sky];
  if (sec <= 0) return w;
  if (w < target) return Math.min(target, w + RISE[sky] * sec);
  return Math.max(target, w - DRY * dryMul * sec);
}

// ---- みんなが走る線から先に乾く (DECISIONS「みんなが走る線から先に乾く」、数は仮) ----

/** 乾くとき (雨がやんだ・弱まった)、走る線 (line.ts) の上は これだけ速く乾く。降るときは同じ */
export const LINE_DRY_MULT = 2.5;
/** 走る線から この横の距離 (m) までは線の上と同じ。そこから LINE_DRY_BAND m かけて まわりの濡れ具合に戻る */
export const LINE_DRY_CORE = 1.2;
export const LINE_DRY_BAND = 2.5;

/** t 秒の 走る線の上の濡れ具合 (wetnessAt 以下。乾くときだけ速い) */
export function lineWetnessAt(plan: WeatherPlan, t: number): number {
  const ch = plan.changes;
  if (!ch.length) return 0;
  let w = plan.startWet;
  const tt = Math.max(0, t);
  for (let i = 0; i < ch.length; i++) {
    const from = ch[i].at;
    if (from >= tt) break;
    const to = i + 1 < ch.length ? Math.min(ch[i + 1].at, tt) : tt;
    w = approach(w, ch[i].sky, to - from, LINE_DRY_MULT);
  }
  return Math.min(w, wetnessAt(plan, t));
}

/** 走る線から横に gap (m) 離れた所の濡れ具合 (wet = まわり、lineWet = 走る線の上) */
export function wetnessAtLateral(wet: number, lineWet: number, gap: number): number {
  if (!(lineWet < wet)) return wet;
  const k = Math.max(0, Math.min(1, (Math.abs(gap) - LINE_DRY_CORE) / LINE_DRY_BAND));
  return lineWet + (wet - lineWet) * k * k * (3 - 2 * k);
}

/** t 秒 (信号が消えてから) の路面の濡れ具合 (0..1)。最初から計算しても軽い */
export function wetnessAt(plan: WeatherPlan, t: number): number {
  const ch = plan.changes;
  if (!ch.length) return 0;
  let w = plan.startWet;
  const tt = Math.max(0, t);
  for (let i = 0; i < ch.length; i++) {
    const from = ch[i].at;
    if (from >= tt) break;
    const to = i + 1 < ch.length ? Math.min(ch[i + 1].at, tt) : tt;
    w = approach(w, ch[i].sky, to - from);
  }
  return w;
}

export interface ForecastItem {
  /** 何秒後か (予報の数。ずれていることがある) */
  inSec: number;
  sky: Sky;
  /** 当たる見込み (%) */
  chance: number;
  /** 例: 「約 2 分後 小雨 60%」 */
  text: string;
}

/** 予報で先を見る長さ (秒、仮) */
export const FORECAST_HORIZON = 240;

/**
 * t 秒 (信号が消えてから) の予報。先 horizon 秒の空の変わり目を、見込み (%) 付きで返す。
 * 時間のずれと見込みは予定の種から決まるので、画面とサーバーで同じになる。
 * 本当の変わり目のうち少しは直前まで出ない。来ない変わり目 (fakes) は 30 秒前に消える。
 */
export function forecastAt(plan: WeatherPlan, t: number, horizon = FORECAST_HORIZON): ForecastItem[] {
  const out: ForecastItem[] = [];
  const tt = Math.max(0, t);
  const items: Array<{ c: WeatherChange; k: number; fake: boolean }> = [];
  plan.changes.forEach((c, i) => {
    if (i > 0) items.push({ c, k: i, fake: false });
  });
  plan.fakes.forEach((c, i) => items.push({ c, k: 100 + i, fake: true }));
  for (const { c, k, fake } of items) {
    const until = c.at - tt;
    if (until <= 0 || until > horizon) continue;
    const h1 = hash01(plan.seed, k * 3);
    const h2 = hash01(plan.seed, k * 3 + 1);
    const h3 = hash01(plan.seed, k * 3 + 2);
    if (fake && until < 30) continue;
    // 当たる予報でも 15% は直前 (30 秒前) まで出ない
    if (!fake && h3 < 0.15 && until > 30) continue;
    const far = until / horizon;
    const err = (h1 - 0.5) * 2 * 45 * far;
    const inSec = Math.max(0, until + err);
    const chance = fake ? 30 + Math.round(h2 * 3) * 10 : Math.min(90, 50 + Math.round(h2 * 3) * 10 + Math.round((1 - far) * 2) * 10);
    out.push({ inSec, sky: c.sky, chance, text: forecastText(inSec, c.sky, chance) });
  }
  out.sort((a, b) => a.inSec - b.inSec);
  return out;
}

export function forecastText(inSec: number, sky: Sky, chance: number): string {
  const when = inSec < 45 ? "まもなく" : `約 ${Math.max(1, Math.round(inSec / 60))} 分後`;
  return `${when} ${SKY_NAMES[sky]} ${chance}%`;
}

// ---- 水たまり ----

export interface Puddle {
  /** コースの距離 (中心) */
  s: number;
  /** 横のずれ (中心) */
  d: number;
  /** 前後の長さと横の幅 (m) */
  len: number;
  wide: number;
}

/** 水たまりが効き始める濡れ具合と、一番深いときの効き (仮) */
export const PUDDLE_FROM = 0.55;
const PUDDLE_GRIP_LOSS = 0.45;
const PUDDLE_DRAG = 2.5;

const puddleCache = new WeakMap<Track, Puddle[]>();

/** コースの水たまり (コースの id から決まる。毎回同じ場所) */
export function puddlesOf(track: Track): Puddle[] {
  let ps = puddleCache.get(track);
  if (ps) return ps;
  let seed = 7;
  for (const ch of track.def.id) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647;
  const r = lcg(seed);
  const L = track.length;
  const hw = track.def.halfWidth;
  const n = 3 + Math.floor(r() * 3);
  ps = [];
  for (let i = 0; i < n; i++) {
    // スタートの並び (線の手前 80 m) とピットの近くは避けて、ばらして置く
    const s = 120 + ((L - 240) * (i + 0.2 + r() * 0.6)) / n;
    ps.push({ s, d: (r() * 2 - 1) * (hw - 2), len: 7 + r() * 6, wide: 3 + r() * 2 });
  }
  puddleCache.set(track, ps);
  return ps;
}

/** 水たまりの深さ (0..1)。濡れ具合が高いときだけ */
export function puddleDepth(wet: number): number {
  return Math.max(0, Math.min(1, (wet - PUDDLE_FROM) / 0.35));
}

/**
 * その場所の水たまりの効き: 握りの倍率と、水の抵抗 (m/s²)。
 * resist = タイヤの部品の特徴 (「雨に強い」) による効きの倍率 (1 = そのまま、小さいほど平気。tires.ts の TireMods.puddle)
 */
export function puddleEffect(track: Track, q: TrackQuery, wet: number, tire: TireCompound, resist = 1): { grip: number; drag: number } {
  const depth = puddleDepth(wet);
  if (depth <= 0) return { grip: 1, drag: 0 };
  const L = track.length;
  for (const p of puddlesOf(track)) {
    let ds = q.s - p.s;
    if (ds > L / 2) ds -= L;
    else if (ds < -L / 2) ds += L;
    const a = ds / (p.len / 2);
    const b = (q.d - p.d) / (p.wide / 2);
    if (a * a + b * b < 1) {
      const k = depth * TIRE_DEFS[tire].puddle * resist;
      return { grip: 1 - PUDDLE_GRIP_LOSS * k, drag: PUDDLE_DRAG * depth };
    }
  }
  return { grip: 1, drag: 0 };
}
