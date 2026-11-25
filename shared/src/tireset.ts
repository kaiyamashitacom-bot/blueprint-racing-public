// 持っていくタイヤの組 (11/25 ユーザー「持っていくタイヤの組を決める」・「予選も含めよう」)。
// 走る前に、そのレースに持っていく組 (例: 柔らかい 2・普通 1) を決める。レース中はその中からしか履けない。
// 外したタイヤは「使った組」として減りを覚えておき、あとでまた履ける (減ったまま)。
// 予選のあるレースは、予選の前に組を決め、予選と決勝を通して同じ組を使う (予選の減りは決勝に持ち越す)。
// ここは計算だけ (画面・サーバーから呼ぶ)。数は全部 仮。
import { NOMINAL_WEAR_PER_M, TIRE_DEFS, TIRE_ORDER, isTireCompound, wetWearFactor, type TireCompound } from "./tires.ts";
import { SKY_WET, type ForecastItem } from "./weather.ts";

/** レースの種類 (組の数の決まりが違う) */
export type TireRaceKind = "practice" | "quick" | "league" | "tournament" | "custom";

/** 持っていく新品の組の数 (種類ごと)。書いていない種類は 0 */
export type TireAlloc = Partial<Record<TireCompound, number>>;

/** 組の数の上限 (大会・自分で開く部屋、仮) */
export const MAX_TIRE_SETS = 8;
/** 予選のあるレースで足す組の数 (仮) */
export const QUALI_EXTRA_SETS = 2;
/** すぐ走るの周の数ごとの組の数 (仮) */
const QUICK_SETS: Readonly<Record<number, number>> = { 2: 2, 5: 3, 10: 4 };

/** 持っていける組の数。練習は決まりなし (Infinity) */
export function tireSetLimit(kind: TireRaceKind, laps: number, opts: { qualifying?: boolean } = {}): number {
  if (kind === "practice" || !(laps > 0)) return Infinity;
  const quickLike = kind === "quick" || kind === "league";
  const base = quickLike && QUICK_SETS[laps] ? QUICK_SETS[laps] : Math.min(MAX_TIRE_SETS, Math.ceil(laps / 3) + 1);
  return base + (opts.qualifying ? QUALI_EXTRA_SETS : 0);
}

export interface AllocRules {
  /** 組の数の上限 (Infinity = 決まりなし) */
  limit: number;
  /** 乾いた路面用 (S・M・H) を何種類以上入れるか (大会 = 2) */
  minDry: number;
}

export function allocRules(kind: TireRaceKind, laps: number, opts: { qualifying?: boolean } = {}): AllocRules {
  return { limit: tireSetLimit(kind, laps, opts), minDry: kind === "tournament" ? 2 : 0 };
}

const DRY: readonly TireCompound[] = ["S", "M", "H"];

/** 組の数の合計 */
export function allocTotal(a: TireAlloc): number {
  let n = 0;
  for (const c of TIRE_ORDER) n += a[c] ?? 0;
  return n;
}

/** 入っている乾いた路面用の種類の数 */
export function dryKinds(a: TireAlloc): number {
  return DRY.filter((c) => (a[c] ?? 0) > 0).length;
}

/** 保存や通信から来たものを、0 以上の整数の組にする */
export function normalizeAlloc(raw: unknown): TireAlloc {
  const out: TireAlloc = {};
  if (!raw || typeof raw !== "object") return out;
  for (const c of TIRE_ORDER) {
    const v = (raw as Record<string, unknown>)[c];
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) out[c] = Math.min(99, Math.floor(v));
  }
  return out;
}

/** 決まりに合っているか。合っていなければ わけ (画面に出す文) を返す */
export function validateAlloc(a: TireAlloc, rules: AllocRules): string[] {
  const errs: string[] = [];
  for (const c of TIRE_ORDER) {
    const v = a[c];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) errs.push(`${TIRE_DEFS[c].name} の組の数がおかしい`);
  }
  const n = allocTotal(a);
  if (n < 1) errs.push("タイヤを 1 組は持っていく");
  if (n > rules.limit) errs.push(`持っていけるのは ${rules.limit} 組まで`);
  if (rules.minDry > 0 && dryKinds(a) < rules.minDry) errs.push(`乾いた路面用 (柔らかい・普通・硬い) を ${rules.minDry} 種類以上入れる`);
  return errs;
}

/**
 * 決まりに合うように直す (保存してあった組が、今のレースの上限より多いときなど)。
 * 多い種類から減らす (keep はなるべく残す)。空なら keep を 1 組。乾いた路面用の種類が足りなければ足す (枠がなければ入れ替える)
 */
export function fitAlloc(a: TireAlloc, rules: AllocRules, keep: TireCompound = "M"): TireAlloc {
  const out = normalizeAlloc(a);
  // 多い種類から 1 組ずつ減らす (keep は同じ数なら残す)
  while (allocTotal(out) > rules.limit) {
    let pick: TireCompound | null = null;
    let best = -1;
    for (const c of TIRE_ORDER) {
      const v = out[c] ?? 0;
      const score = v - (c === keep ? 0.5 : 0);
      if (v > 0 && score > best) {
        best = score;
        pick = c;
      }
    }
    dec(out, pick!);
  }
  if (allocTotal(out) < 1) out[keep] = 1;
  // 乾いた路面用の種類が足りない: 枠が余っていれば足し、なければ 2 組以上ある種類か雨用と入れ替える
  while (dryKinds(out) < rules.minDry) {
    const add = (["M", "H", "S"] as const).find((c) => !(out[c] ?? 0))!;
    if (allocTotal(out) >= rules.limit) {
      const many = TIRE_ORDER.filter((c) => (out[c] ?? 0) > 1).sort((x, y) => (out[y] ?? 0) - (out[x] ?? 0))[0];
      const rain = (["W", "I"] as const).find((c) => (out[c] ?? 0) > 0);
      const from = many ?? rain;
      if (!from) break;
      dec(out, from);
    }
    out[add] = 1;
  }
  return out;
}

function dec(a: TireAlloc, c: TireCompound) {
  const v = (a[c] ?? 0) - 1;
  if (v > 0) a[c] = v;
  else delete a[c];
}

// ---- 車が持っている組 (レース中) ----

export interface UsedSet {
  tire: TireCompound;
  /** すり減り (0..1) */
  wear: number;
}

/** 車が持っている組 (今 履いている組は入らない)。JSON にできる */
export interface TireSets {
  /** 新品の組の数 (種類ごと) */
  fresh: TireAlloc;
  /** 使った組 (外した順) */
  used: UsedSet[];
}

/** どの組を履くか。used = 使った組の番号 (なし = 新品。新品がなければ一番減っていない使った組) */
export interface SetPick {
  tire: TireCompound;
  used?: number | null;
}

/** 履いたタイヤ */
export interface FittedTire {
  tire: TireCompound;
  wear: number;
}

export function setsFromAlloc(a: TireAlloc): TireSets {
  return { fresh: normalizeAlloc(a), used: [] };
}

export function cloneSets(s: TireSets): TireSets {
  return { fresh: { ...s.fresh }, used: s.used.map((u) => ({ ...u })) };
}

/** 新品と使った組を合わせた数 */
export function setsCount(s: TireSets): number {
  return allocTotal(s.fresh) + s.used.length;
}

/** その種類の組を (新品か使った組で) 持っているか */
export function hasSet(s: TireSets, c: TireCompound): boolean {
  return (s.fresh[c] ?? 0) > 0 || s.used.some((u) => u.tire === c);
}

/** その種類の使った組のうち、一番減っていないものの番号 (なければ -1) */
export function leastWornUsed(s: TireSets, c: TireCompound): number {
  let best = -1;
  s.used.forEach((u, i) => {
    if (u.tire === c && (best < 0 || u.wear < s.used[best].wear)) best = i;
  });
  return best;
}

/** その選び方で履ける組があるか */
export function canTake(s: TireSets, pick: SetPick): boolean {
  if (pick.used !== undefined && pick.used !== null) return s.used[pick.used]?.tire === pick.tire;
  return hasSet(s, pick.tire);
}

/** 組を 1 つ取り出す (s は変えない)。なければ null */
export function takeSet(s: TireSets, pick: SetPick): { sets: TireSets; fitted: FittedTire } | null {
  if (!isTireCompound(pick.tire)) return null;
  const out = cloneSets(s);
  let idx = pick.used ?? null;
  if (idx === null) {
    if ((out.fresh[pick.tire] ?? 0) > 0) {
      dec(out.fresh, pick.tire);
      return { sets: out, fitted: { tire: pick.tire, wear: 0 } };
    }
    idx = leastWornUsed(out, pick.tire);
  }
  const u = out.used[idx];
  if (!u || u.tire !== pick.tire) return null;
  out.used.splice(idx, 1);
  return { sets: out, fitted: { tire: u.tire, wear: u.wear } };
}

/** 破裂した・使い切ったタイヤは「使った組」に戻さない (捨てる) */
export const USED_DISCARD_WEAR = 1;

/** 外したタイヤを「使った組」に戻す (s は変えない) */
export function returnSet(s: TireSets, tire: TireCompound, wear: number, burst = false): TireSets {
  const out = cloneSets(s);
  const w = Math.max(0, Math.min(1, Number.isFinite(wear) ? wear : 1));
  if (!burst && w < USED_DISCARD_WEAR) out.used.push({ tire, wear: w });
  return out;
}

/** ピットでのタイヤ交換: 今のタイヤを使った組に戻し、選んだ組を履く。選んだ組がなければ null (替えない) */
export function swapSet(s: TireSets, current: { tire: TireCompound; wear: number; burst: boolean }, pick: SetPick): { sets: TireSets; fitted: FittedTire } | null {
  const t = takeSet(s, pick);
  if (!t) return null;
  return { sets: returnSet(t.sets, current.tire, current.wear, current.burst), fitted: t.fitted };
}

/** 画面に並べる選べる組: 種類ごとの新品 (数つき) と、使った組 1 つずつ */
export interface SetOption {
  tire: TireCompound;
  /** 使った組の番号 (null = 新品) */
  used: number | null;
  wear: number;
  /** 新品の数 (使った組は 1) */
  count: number;
}

export function setOptions(s: TireSets): SetOption[] {
  const out: SetOption[] = [];
  for (const c of TIRE_ORDER) {
    const n = s.fresh[c] ?? 0;
    if (n > 0) out.push({ tire: c, used: null, wear: 0, count: n });
  }
  const used = s.used.map((u, i) => ({ tire: u.tire, used: i, wear: u.wear, count: 1 }));
  used.sort((a, b) => TIRE_ORDER.indexOf(a.tire) - TIRE_ORDER.indexOf(b.tire) || a.wear - b.wear);
  return out.concat(used);
}

/** 通信や保存から来たものを読む (おかしければ null) */
export function readTireSets(raw: unknown): TireSets | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { fresh?: unknown; used?: unknown };
  if (!Array.isArray(r.used) || r.used.length > 40) return null;
  const used: UsedSet[] = [];
  for (const u of r.used) {
    if (!u || typeof u !== "object") return null;
    const { tire, wear } = u as { tire?: unknown; wear?: unknown };
    if (!isTireCompound(tire) || typeof wear !== "number" || !Number.isFinite(wear)) return null;
    used.push({ tire, wear: Math.max(0, Math.min(1, wear)) });
  }
  return { fresh: normalizeAlloc(r.fresh), used };
}

/** 組から最初のタイヤを取り出して、走る前の準備 (CarSetup の tire・wear・sets) にする */
export function startFromSets(s: TireSets, pick: SetPick): { tire: TireCompound; wear: number; sets: TireSets } | null {
  const t = takeSet(s, pick);
  return t ? { tire: t.fitted.tire, wear: t.fitted.wear, sets: t.sets } : null;
}

/** 持っていく組と最初のタイヤから、走る前の準備を作る。最初のタイヤが組にない種類なら、組の最初の種類にする */
export function startFromAlloc(a: TireAlloc, start: TireCompound): { tire: TireCompound; wear: number; sets: TireSets } {
  const sets = setsFromAlloc(a);
  const first = (hasSet(sets, start) ? start : TIRE_ORDER.find((c) => hasSet(sets, c))) ?? start;
  return startFromSets(sets, { tire: first }) ?? { tire: start, wear: 0, sets };
}

/**
 * コンピューター (と代走) がピットで履く組を選ぶ。want = 本当は履きたい種類。
 * 同じ種類の新品 → 同じ種類の使った組 (一番減っていないもの) → 同じ仲間 (乾いた路面用どうし・雨用どうし) の近いもの。
 * 雨用がなければ乾いたタイヤのまま (null)。maxWear より減った組は選ばない
 */
export function pickFromSets(s: TireSets, want: TireCompound, maxWear = 0.7): SetPick | null {
  const ok = (c: TireCompound): SetPick | null => {
    if ((s.fresh[c] ?? 0) > 0) return { tire: c, used: null };
    const i = leastWornUsed(s, c);
    return i >= 0 && s.used[i].wear <= maxWear ? { tire: c, used: i } : null;
  };
  const slick = TIRE_DEFS[want].slick;
  const near = (slick ? DRY : (["I", "W"] as const)).slice().sort((x, y) => Math.abs(TIRE_ORDER.indexOf(x) - TIRE_ORDER.indexOf(want)) - Math.abs(TIRE_ORDER.indexOf(y) - TIRE_ORDER.indexOf(want)));
  // 新品を先に (近い種類の新品は、減った同じ種類より良い)
  for (const c of near) if ((s.fresh[c] ?? 0) > 0) return { tire: c, used: null };
  for (const c of near) {
    const p = ok(c);
    if (p) return p;
  }
  return null;
}

// ---- 予選 (予選と決勝を通して同じ組) ----

/** 予選の前に決めた組と、その減り。JSON にできる (サーバーに残せる) */
export interface QualiTires {
  v: 1;
  /** 決めた組 (はじめの数) */
  alloc: TireAlloc;
  /** 今の組 (予選で使った組は減りつきで used に入る) */
  sets: TireSets;
  /** 最初の予選の走りを始めたら true。そのあとは組を変えられない */
  locked: boolean;
  /** 予選を走った回数 */
  runs: number;
}

/** 予選の前の組を作る (まだ変えられる) */
export function newQualiTires(a: TireAlloc): QualiTires {
  const alloc = normalizeAlloc(a);
  return { v: 1, alloc, sets: setsFromAlloc(alloc), locked: false, runs: 0 };
}

/** 組を変える (決まったあと = 予選を走り始めたあとは null) */
export function changeQualiAlloc(q: QualiTires, a: TireAlloc): QualiTires | null {
  if (q.locked) return null;
  return newQualiTires(a);
}

/** 予選の走りを始める: 組が決まる (locked) */
export function lockQuali(q: QualiTires): QualiTires {
  return { ...q, sets: cloneSets(q.sets), locked: true };
}

/** 予選の走りで履くタイヤ (CarSetup の tire・wear に入れる)。その組がなければ null */
export function qualiRunTire(q: QualiTires, pick: SetPick): FittedTire | null {
  return takeSet(q.sets, pick)?.fitted ?? null;
}

/**
 * 予選の走りの減りを組に入れる。pick の組を取り出し、走り終えたときの減り (endWear。走る前より少なくはならない) で
 * 使った組に戻す。破裂したら その組はなくなる。組が決まっていなければ決める
 */
export function applyQualiRun(q: QualiTires, pick: SetPick, endWear: number, burst = false): QualiTires | null {
  const t = takeSet(q.sets, pick);
  if (!t) return null;
  const wear = Math.max(t.fitted.wear, Number.isFinite(endWear) ? endWear : 1);
  return { ...q, locked: true, runs: q.runs + 1, sets: returnSet(t.sets, t.fitted.tire, wear, burst) };
}

/** 予選の組を決勝に持ち込む: 最初のタイヤ (減ったものも選べる) を取り出し、残りを CarSetup の sets に */
export function raceSetupFromQuali(q: QualiTires, start: SetPick): { tire: TireCompound; wear: number; sets: TireSets } | null {
  return startFromSets(q.sets, start);
}

/** 予報を読み取ったときの、レース中の一番濡れる見込み (見込み 50% 以上の予報だけ数える) */
export function forecastWetMax(wetStart: number, forecast: readonly ForecastItem[] = []): number {
  let w = wetStart;
  for (const f of forecast) if (f.chance >= 50) w = Math.max(w, SKY_WET[f.sky]);
  return w;
}

// ---- コンピューターの組の選び方 ----

/** タイヤを使い切る目安 (bot.ts と同じ) */
const WEAR_LIMIT = 0.88;

const wearPerM = (c: TireCompound, wet = 0) => NOMINAL_WEAR_PER_M * TIRE_DEFS[c].wear * wetWearFactor(c, wet);

export interface AutoAllocOpts {
  /** 1 周の長さ (m) */
  trackLength: number;
  laps: number;
  rules: AllocRules;
  /** スタートの濡れ具合と、レース中に一番濡れる見込み */
  wetStart: number;
  wetMax?: number;
  /** すり減りの速さの見込みの倍率 (車ごと、なし = 1) */
  scale?: number;
}

/** 雨用を入れる濡れ具合 (仮) */
const RAIN_FROM = 0.3;
const HEAVY_FROM = 0.7;

/**
 * コンピューターが持っていく組と最初のタイヤを決める (コースの長さと予報から)。
 * 乾いた路面: 何回に分けて走るかを少ない順に試し、その長さを持つ一番柔らかい種類。余った枠は隣の種類 (予備) と同じ種類を交互に。
 * 雨の見込みがあれば雨用を 1 組 (スタートから濡れていれば ゴールまで持つ数、乾いた路面用を 1 組は残す)。大会では乾いた路面用を 2 種類以上
 */
export function autoTireAlloc(o: AutoAllocOpts): { alloc: TireAlloc; start: TireCompound } {
  const limit = Number.isFinite(o.rules.limit) ? Math.max(1, o.rules.limit) : 4;
  const total = Math.max(1, o.laps) * o.trackLength + 100;
  const scale = o.scale ?? 1;
  const wetMax = Math.max(o.wetStart, o.wetMax ?? o.wetStart);
  const alloc: TireAlloc = {};
  const startWet = o.wetStart >= RAIN_FROM;
  let rain: TireCompound | null = null;
  let rainN = 0;
  if (wetMax >= RAIN_FROM && (limit >= 2 || startWet)) {
    rain = (startWet ? o.wetStart : wetMax) >= HEAVY_FROM ? "W" : "I";
    rainN = startWet && o.laps >= 10 && limit >= 4 ? 2 : 1;
    // 濡れたスタート: 雨用だけでゴールまで持つ組の数 (乾いた路面用を 1 組は残す)。
    // 11/25 リーグ「大雨のつづら坂で ほとんど燃料切れ」: 雨用 1 組では途中で破裂し、替えがなくて遅く走り続けて燃料が尽きた
    if (startWet && limit >= 2) {
      const need = Math.ceil((wearPerM(rain, o.wetStart) * scale * total) / WEAR_LIMIT);
      rainN = Math.max(rainN, Math.min(need, limit - 1));
    }
  }
  let dry = limit - rainN;
  // 大会: 乾いた路面用 2 種類を入れる枠がなければ、雨用を減らす
  while (rainN > 0 && dry < o.rules.minDry) {
    rainN--;
    dry++;
  }
  if (rain && rainN > 0) alloc[rain] = rainN;
  let planned: TireCompound = "M";
  if (dry > 0) {
    let plan: TireCompound = "H";
    let stints = dry;
    for (let n = 1; n <= dry; n++) {
      const c = DRY.find((x) => wearPerM(x) * scale * (total / n) <= WEAR_LIMIT);
      if (c) {
        plan = c;
        stints = n;
        break;
      }
    }
    alloc[plan] = stints;
    // 余った枠: 隣の種類 (柔らかい・硬い → 普通、普通 → 硬い) を予備に
    const spare: TireCompound = plan === "M" ? "H" : "M";
    for (let i = 0; i < dry - stints; i++) {
      const c = i % 2 === 0 ? spare : plan;
      alloc[c] = (alloc[c] ?? 0) + 1;
    }
    planned = plan;
  }
  const fitted = fitAlloc(alloc, { limit, minDry: o.rules.minDry }, rain && startWet ? rain : "M");
  const has = (c: TireCompound | null): c is TireCompound => !!c && (fitted[c] ?? 0) > 0;
  const start = startWet && has(rain) ? rain : has(planned) ? planned : (DRY.find(has) ?? TIRE_ORDER.find(has) ?? "M");
  return { alloc: fitted, start };
}
