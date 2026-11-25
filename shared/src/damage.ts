// 傷み: 壁や車に強く当たると、当たった場所に一番近い部品が弱る (DECISIONS「車」)。
// 弱るほど働きが落ち、弱りきる (1) と働かなくなり、もう一度強く当たると外れて落ちる (重さも減る)。
//   羽根 → 押しつけが減る (曲がりにくい)・タイヤ → 握りが減る・エンジン → 力が減る・ブレーキ → 効きが弱い
//   運転席 → 壊れたらリタイア。燃料タンクと骨組みは当たりを受け止めるだけ (働きは変わらない)
// ピットの修理 (pit.ts) で全部直る。時間は傷んだ部品の数で決まる。レースのあとは自動で直る (新しい車で始まる)。
// 数は全部 (仮)。
import type { CarStats, PartSlot } from "./design.ts";
import type { CarState } from "./physics.ts";

/** 部品ごとの傷み。設計図の parts と同じ順 */
export interface CarDamage {
  /** 0 = 無傷 … 1 = 壊れて働かない。DAMAGE_LOST (2) = 外れて落ちた */
  parts: number[];
  /** 強く当たった回数 (STRONG_HIT 以上。旗を出す合図に使う) */
  hits: number;
  /** 運転席が壊れた (リタイア) */
  out?: boolean;
}

/** 外れて落ちた印 */
export const DAMAGE_LOST = 2;
/** 壁に当たってこれより速い (壁へ向かう速さ m/s) と傷む */
export const WALL_DAMAGE_MIN = 6;
/** 車どうしでこれより速くぶつかる (近づく速さ m/s) と傷む */
export const CAR_DAMAGE_MIN = 4;
/** 1 m/s あたりの傷み (しきいを超えた分) */
export const DAMAGE_PER_MS = 0.09;
/** 壊れた部品がこれより強く当たると外れて落ちる (m/s) */
export const DETACH_SPEED = 9;
/** これより強い当たりは「強く当たった」(黄旗) */
export const STRONG_HIT = 12;
/** 傷んだ部品の働き: 傷み h (0..1) で 1 - DAMAGE_EFFECT × h、壊れると 0 */
export const DAMAGE_EFFECT = 0.35;
/** 壊れた・落ちたタイヤの握り (縁で少しは転がる) */
const BROKEN_TIRE = 0.15;

export interface DamageEvent {
  /** 設計図の parts の番号と、部品の種類 */
  part: number;
  kind: PartSlot["kind"];
  /** 当たった強さ (m/s) */
  speed: number;
  /** この当たりで壊れた / 外れて落ちた */
  broke: boolean;
  lost: boolean;
  /** 運転席が壊れた (リタイア) */
  out: boolean;
  /** 強く当たった (STRONG_HIT 以上) */
  strong: boolean;
}

export function newDamage(stats: CarStats): CarDamage {
  return { parts: new Array<number>(stats.layout?.length ?? 0).fill(0), hits: 0 };
}

/** 部品の働きの割合 (0..1) */
export function partWorks(h: number): number {
  if (!(h > 0)) return 1;
  if (h >= 1) return 0;
  return 1 - DAMAGE_EFFECT * h;
}

/** 運転席が壊れてリタイアか */
export function isWrecked(car: Pick<CarState, "damage">, stats?: CarStats): boolean {
  const d = car.damage;
  if (!d) return false;
  if (d.out) return true;
  if (!stats?.layout) return false;
  for (const p of stats.layout) if (p.kind === "seat" && (d.parts[p.index] ?? 0) >= 1) return true;
  return false;
}

/** 傷んだ部品の数 (落ちた部品も入る) と、そのうち壊れた・落ちた数 */
export function damageCount(car: Pick<CarState, "damage">): { damaged: number; broken: number; lost: number } {
  let damaged = 0;
  let broken = 0;
  let lost = 0;
  for (const h of car.damage?.parts ?? []) {
    if (h > 0.001) damaged++;
    if (h >= 1) broken++;
    if (h >= DAMAGE_LOST) lost++;
  }
  return { damaged, broken, lost };
}

export interface DamageEffect {
  /** 握り・押しつけ・力・ブレーキに掛ける割合 */
  grip: number;
  down: number;
  power: number;
  brake: number;
  /** 落ちた部品で減った重さ (kg) と空気の抵抗 */
  mass: number;
  drag: number;
}

const NONE: DamageEffect = { grip: 1, down: 1, power: 1, brake: 1, mass: 0, drag: 0 };

/** 傷みが走りにどれだけ効くか */
export function damageEffect(car: Pick<CarState, "damage">, stats: CarStats): DamageEffect {
  const d = car.damage;
  const layout = stats.layout;
  if (!d || !layout || !d.parts.some((h) => h > 0)) return NONE;
  let grip = 0;
  let down = 0;
  let power = 0;
  let brakeParts = 0;
  let mass = 0;
  let drag = 0;
  let hasGrip = false;
  let hasDown = false;
  let hasPower = false;
  for (const p of layout) {
    const h = d.parts[p.index] ?? 0;
    const w = partWorks(h);
    if (h >= DAMAGE_LOST) {
      mass += p.mass;
      drag += p.drag ?? 0;
    }
    if (p.kind === "tire") {
      hasGrip = true;
      grip += p.share * (h >= 1 ? BROKEN_TIRE : w);
    } else if (p.kind === "wing") {
      hasDown = true;
      down += p.share * w;
    } else if (p.kind === "engine") {
      hasPower = true;
      power += p.share * w;
    } else if (p.kind === "brake") {
      brakeParts += p.share * (1 - w);
    }
  }
  // ブレーキ: 部品の分 (stats.brake のうち部品の割合) だけ弱る。もとの 4 m/s² は残る
  const partBrake = Math.max(0, stats.brake - 4);
  const brake = stats.brake > 0 ? (stats.brake - partBrake * brakeParts) / stats.brake : 1;
  return {
    // 握りは タイヤの握りの合計の平方根に比例する (design.ts)
    grip: hasGrip ? Math.max(0.35, Math.sqrt(grip)) : 1,
    down: hasDown ? down : 1,
    power: hasPower ? power : 1,
    brake,
    mass,
    drag,
  };
}

/**
 * 当たりを受ける。dirX/dirY = 車の真ん中から見た当たった向き (向きの長さ 1、世界の座標)。
 * speed = 当たった強さ (m/s)、min = 傷み始めるしきい。傷めば何が起きたかを返す
 */
export function applyImpact(car: CarState, stats: CarStats, dirX: number, dirY: number, speed: number, min = WALL_DAMAGE_MIN): DamageEvent | null {
  const layout = stats.layout;
  if (!layout || !layout.length || !(speed > min)) return null;
  if (!car.damage || car.damage.parts.length !== layout.length) car.damage = newDamage(stats);
  const dmg = car.damage;
  // 当たった点: 車体の四角の縁の、当たった向きの所 (車の前 f・右 r の座標)
  const fx = Math.cos(car.heading);
  const fy = Math.sin(car.heading);
  const df = dirX * fx + dirY * fy;
  const dr = dirX * -fy + dirY * fx;
  const hw = stats.width / 2;
  const hl = stats.length / 2;
  const t = Math.min(Math.abs(dr) > 1e-6 ? hw / Math.abs(dr) : Infinity, Math.abs(df) > 1e-6 ? hl / Math.abs(df) : Infinity);
  const pr = stats.bodyLx + dr * t;
  const pf = stats.bodyLf + df * t;
  // 一番近い部品 (落ちた部品は除く)
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < layout.length; k++) {
    const p = layout[k];
    if ((dmg.parts[p.index] ?? 0) >= DAMAGE_LOST) continue;
    const ex = Math.max(0, Math.abs(pr - p.lx) - p.hx);
    const ef = Math.max(0, Math.abs(pf - p.lf) - p.hf);
    const dd = ex * ex + ef * ef;
    if (dd < bestD - 1e-9) {
      bestD = dd;
      best = k;
    }
  }
  if (best < 0) return null;
  const p = layout[best];
  const before = dmg.parts[p.index] ?? 0;
  // 頑丈な部品 (進化・研究) は傷みが sturdy の割合だけ少ない
  let after = Math.min(1, before + (speed - min) * DAMAGE_PER_MS * (1 - Math.max(0, Math.min(0.9, p.sturdy ?? 0))));
  // 壊れていた部品に、もう一度強く当たると外れて落ちる (運転席は落ちない)
  if (before >= 1 && speed >= DETACH_SPEED && p.kind !== "seat") after = DAMAGE_LOST;
  else if (before >= 1) after = before;
  dmg.parts[p.index] = after;
  const strong = speed >= STRONG_HIT;
  if (strong) dmg.hits++;
  if (p.kind === "seat" && after >= 1) dmg.out = true;
  return {
    part: p.index,
    kind: p.kind,
    speed,
    broke: before < 1 && after >= 1,
    lost: before < DAMAGE_LOST && after >= DAMAGE_LOST,
    out: p.kind === "seat" && after >= 1,
    strong,
  };
}

/** 全部直す (ピットの修理) */
export function repairAll(car: CarState, stats: CarStats): void {
  if (car.damage?.out) return;
  const hits = car.damage?.hits ?? 0;
  car.damage = newDamage(stats);
  car.damage.hits = hits;
}

/** やりとり用: 傷みを 0.01 刻みに丸めた配列 (なければ undefined) */
export function packDamage(d: CarDamage | null | undefined): number[] | undefined {
  if (!d || !d.parts.some((h) => h > 0)) return undefined;
  return d.parts.map((h) => Math.round(h * 100) / 100);
}

/** やりとりで受け取った傷みを読む (おかしな値は捨てる) */
export function readDamage(parts: unknown, hits: unknown, stats: CarStats): CarDamage {
  const n = stats.layout?.length ?? 0;
  const out = newDamage(stats);
  if (Array.isArray(parts) && parts.length === n) {
    for (let i = 0; i < n; i++) {
      const v = Number(parts[i]);
      out.parts[i] = Number.isFinite(v) ? Math.max(0, Math.min(DAMAGE_LOST, v)) : 0;
    }
  }
  if (typeof hits === "number" && Number.isFinite(hits)) out.hits = Math.max(0, Math.floor(hits));
  out.out = isWrecked({ damage: out }, stats);
  return out;
}
