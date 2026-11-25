// 車どうしの当たり (11/25 ユーザー「当たり判定追加」。それまでは すり抜け)
// 車体は前後に並べた円でおおう。重なったら押し分け、ぶつかる速さは重さに応じて跳ね返す。
// ネットでは それぞれの車が自分の側だけ直す (自分の画面で自分の車、サーバーでコンピューターの車)。
// 押し分けは半分ずつ、速さの変化は自分の分だけ (相手も同じ計算をするので合わせると正しくなる)。
import { applyImpact, CAR_DAMAGE_MIN, type DamageEvent } from "./damage.ts";
import { FUEL_KG, type CarStats } from "./design.ts";
import type { CarState } from "./physics.ts";

export interface Body {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  mass: number;
  width: number;
  length: number;
  bodyLx: number;
  bodyLf: number;
}

/** 跳ね返りの強さ (0 = くっつく、1 = よく跳ねる) */
export const RESTITUTION = 0.35;

export function bodyOf(car: CarState, stats: CarStats): Body {
  return {
    x: car.x,
    y: car.y,
    heading: car.heading,
    vx: car.vx,
    vy: car.vy,
    mass: stats.dryMass + car.fuel * FUEL_KG,
    width: stats.width,
    length: stats.length,
    bodyLx: stats.bodyLx,
    bodyLf: stats.bodyLf,
  };
}

function circles(b: Body): Array<[number, number, number]> {
  const r = (Math.min(b.width, b.length) / 2) * 0.95;
  const n = Math.max(1, Math.ceil(b.length / Math.max(0.1, b.width)) + (b.length > b.width ? 1 : 0));
  const fx = Math.cos(b.heading);
  const fy = Math.sin(b.heading);
  const rx = -fy;
  const ry = fx;
  const cx = b.x + rx * b.bodyLx + fx * b.bodyLf;
  const cy = b.y + ry * b.bodyLx + fy * b.bodyLf;
  const span = Math.max(0, b.length / 2 - r);
  const out: Array<[number, number, number]> = [];
  for (let k = 0; k < n; k++) {
    const u = n === 1 ? 0 : -span + (2 * span * k) / (n - 1);
    out.push([cx + fx * u, cy + fy * u, r]);
  }
  return out;
}

export interface Contact {
  /** b から a へ向かう向き */
  nx: number;
  ny: number;
  depth: number;
}

export function contact(a: Body, b: Body): Contact | null {
  // 遠ければ調べない
  const reach = (Math.max(a.length, a.width) + Math.max(b.length, b.width)) / 2 + 1.5;
  const dx0 = a.x - b.x;
  const dy0 = a.y - b.y;
  if (dx0 * dx0 + dy0 * dy0 > reach * reach) return null;
  let best: Contact | null = null;
  for (const [ax, ay, ar] of circles(a)) {
    for (const [bx, by, br] of circles(b)) {
      const dx = ax - bx;
      const dy = ay - by;
      const d = Math.hypot(dx, dy);
      const depth = ar + br - d;
      if (depth > 0 && (!best || depth > best.depth)) {
        const l = d > 1e-6 ? d : 1;
        best = d > 1e-6 ? { nx: dx / l, ny: dy / l, depth } : { nx: Math.cos(a.heading + Math.PI / 2), ny: Math.sin(a.heading + Math.PI / 2), depth };
      }
    }
  }
  return best;
}

/**
 * 自分の車 (me) を相手 (other) から押し分ける。自分の分だけ直す。
 * 戻り値はぶつかった速さ (m/s、ぶつかっていなければ 0)。
 * stats を渡すと、強くぶつかったとき (CAR_DAMAGE_MIN 超え) に当たった側の部品が傷む (damage.ts)。onDamage で何が傷んだかを受け取れる
 */
export function pushApart(me: CarState, meBody: Body, other: Body, share = 0.5, stats?: CarStats, onDamage?: (ev: DamageEvent) => void): number {
  const c = contact(meBody, other);
  if (!c) return 0;
  me.x += c.nx * c.depth * share;
  me.y += c.ny * c.depth * share;
  const rel = (meBody.vx - other.vx) * c.nx + (meBody.vy - other.vy) * c.ny;
  if (rel >= 0) return 0;
  const j = (-(1 + RESTITUTION) * rel) / (1 / meBody.mass + 1 / other.mass);
  me.vx += (j / meBody.mass) * c.nx;
  me.vy += (j / meBody.mass) * c.ny;
  // こすれる分だけ少し遅く
  me.vx *= 0.99;
  me.vy *= 0.99;
  if (stats && -rel > CAR_DAMAGE_MIN) {
    // 当たった向き = 相手の側 (c は相手から自分への向き)
    const ev = applyImpact(me, stats, -c.nx, -c.ny, -rel, CAR_DAMAGE_MIN);
    if (ev && onDamage) onDamage(ev);
  }
  return -rel;
}
