// 代走 (リーグ戦の 2 時間ごとのレース) が使う、遊ぶ人の走る前の準備 (タイヤと燃料)。
// 走る前の準備は遊ぶ人の機械に保存してあるので、レースのときと変えたときに サーバーにも送って残す (チームごとに 1 つ)。
// 代走はそれを使う。なければ今までどおりコンピューターが決める (bot.ts の botStartSetup)。
import type { CarStats } from "./design.ts";
import { fuelPerMeter } from "./bot.ts";
import type { CarSetup } from "./physics.ts";
import { bestTireFor, compoundGrip, isTireCompound, TIRE_DEFS, TIRE_ORDER, type TireCompound } from "./tires.ts";
import { allocTotal, autoTireAlloc, fitAlloc, normalizeAlloc, startFromAlloc, type AllocRules, type TireAlloc } from "./tireset.ts";
import type { Track } from "./track.ts";

export type FuelPlan = "full" | "race" | "light";

/** 遊ぶ人の走る前の準備 (web の store.ts の RaceSetup と同じ形) */
export interface RaceSetupPref {
  /** 最初に履きたいタイヤ */
  tire: TireCompound;
  /** full = 満タン・race = レースの分 (少し余分)・light = 少なめ */
  fuel: FuelPlan;
  /** 持っていくタイヤの組の好み (なし = おまかせ) */
  alloc?: TireAlloc;
  /** tire をどの路面のために選んだか (乾いた路面 = slick・小雨 = I・大雨 = W) */
  tireFor?: "slick" | "I" | "W";
}

const isFuelPlan = (v: unknown): v is FuelPlan => v === "full" || v === "race" || v === "light";

/** 送られてきた準備を確かめて形をそろえる (読めなければ null) */
export function cleanSetupPref(raw: unknown): RaceSetupPref | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isTireCompound(r.tire) || !isFuelPlan(r.fuel)) return null;
  const out: RaceSetupPref = { tire: r.tire, fuel: r.fuel };
  const alloc = normalizeAlloc(r.alloc);
  if (allocTotal(alloc) > 0) out.alloc = alloc;
  if (r.tireFor === "slick" || r.tireFor === "I" || r.tireFor === "W") out.tireFor = r.tireFor;
  return out;
}

/** 準備の燃料 (L)。web の setup.ts の setupFuel と同じ式 */
export function planFuel(stats: CarStats, track: Track, laps: number, mode: FuelPlan): number {
  const n = laps || 5;
  const need = fuelPerMeter(stats) * (n * track.length + 100) * 1.12 + 1.5;
  if (mode === "full") return stats.fuelCap;
  if (mode === "race") return Math.min(stats.fuelCap, need);
  return Math.min(stats.fuelCap, need * 0.6);
}

const fitKind = (c: TireCompound): "slick" | "I" | "W" => (TIRE_DEFS[c].slick ? "slick" : c === "I" ? "I" : "W");

/**
 * 代走のスタートの準備: 遊ぶ人の準備 (pref) から燃料・持っていく組・最初のタイヤを決める。
 * base はコンピューターの準備 (botStartSetup の結果。乱数の使い方をほかの車と同じにするため、呼ぶ側で先に作る)。
 * 選び方は web の raceTireChoice と同じ考え: 組の好みがあれば決まりの数に合わせて減らし、なければおまかせの組。
 * 最初のタイヤは、今の路面のために選んだものを持っていればそれ、なければ路面に合うもの
 */
export function prefStartSetup(
  pref: RaceSetupPref,
  base: CarSetup,
  ctx: { stats: CarStats; track: Track; laps: number; rules: AllocRules; wet: number; wetMax: number },
): CarSetup {
  const fuel = planFuel(ctx.stats, ctx.track, ctx.laps, pref.fuel);
  if (!Number.isFinite(ctx.rules.limit)) return { ...base, fuel };
  const custom = !!pref.alloc && allocTotal(pref.alloc) > 0;
  const alloc = custom
    ? fitAlloc(pref.alloc!, { limit: ctx.rules.limit, minDry: ctx.rules.minDry }, pref.tire)
    : autoTireAlloc({ trackLength: ctx.track.length, laps: ctx.laps, rules: ctx.rules, wetStart: ctx.wet, wetMax: ctx.wetMax }).alloc;
  const has = (t: TireCompound) => (alloc[t] ?? 0) > 0;
  const fit = bestTireFor(ctx.wet);
  const wetFit = !TIRE_DEFS[fit].slick;
  const chose = (pref.tireFor ?? fitKind(pref.tire)) === fitKind(fit);
  let start: TireCompound | undefined;
  if (chose && has(pref.tire)) start = pref.tire;
  else if (wetFit) start = has(fit) ? fit : [...TIRE_ORDER].filter(has).sort((x, y) => compoundGrip(y, ctx.wet) - compoundGrip(x, ctx.wet))[0];
  else start = ([pref.tire, "M", "H", "S"] as TireCompound[]).find((t) => TIRE_DEFS[t].slick && has(t));
  const st = startFromAlloc(alloc, start ?? TIRE_ORDER.find(has) ?? base.tire ?? "M");
  return { ...base, fuel, tire: st.tire, sets: st.sets };
}
