// 車の設計図: マス目に部品を置いたもの。正しいかの確かめと、走りの数 (性能) を出す
import type { PartDef, PartKind } from "./parts.ts";
import { anyPartDef } from "./research.ts";
import { blendTireMods, traitMods, type TireMods, type TireTrait } from "./tires.ts";

/** お店の部品 (parts.ts) と研究の部品 (research.ts、段階 3〜5) の両方から探す */
const partDef = anyPartDef;

export const GRID_W = 7;
export const GRID_H = 11;
/** 1 マスの大きさ (m) */
export const CELL = 0.4;
/** 燃料 1 L の重さ (kg) */
export const FUEL_KG = 0.75;

export interface Placed {
  /** 部品の id (parts.ts) */
  id: string;
  /** 左上のマス (列 c: 0..6 左→右、行 r: 0..10 前→後ろ) */
  c: number;
  r: number;
  /** 0 = そのまま、1 = 90 度回す */
  rot: 0 | 1;
}

export interface CarDesign {
  name: string;
  parts: Placed[];
}

export function placedSize(p: Placed, def: PartDef): { w: number; h: number } {
  return p.rot ? { w: def.h, h: def.w } : { w: def.w, h: def.h };
}

export function placedCells(p: Placed): Array<[number, number]> {
  const def = partDef(p.id);
  if (!def) return [];
  const { w, h } = placedSize(p, def);
  const out: Array<[number, number]> = [];
  for (let dc = 0; dc < w; dc++) for (let dr = 0; dr < h; dr++) out.push([p.c + dc, p.r + dr]);
  return out;
}

/** マス目の中身: 各マスに何番目の部品があるか (-1 = 空き) */
export function occupancy(design: CarDesign): Int16Array {
  const occ = new Int16Array(GRID_W * GRID_H).fill(-1);
  design.parts.forEach((p, i) => {
    for (const [c, r] of placedCells(p)) {
      if (c >= 0 && c < GRID_W && r >= 0 && r < GRID_H) occ[r * GRID_W + c] = i;
    }
  });
  return occ;
}

/** その場所に置けるか (はみ出し・重なり) */
export function canPlace(design: CarDesign, p: Placed): boolean {
  const def = partDef(p.id);
  if (!def) return false;
  const occ = occupancy(design);
  for (const [c, r] of placedCells(p)) {
    if (c < 0 || c >= GRID_W || r < 0 || r >= GRID_H) return false;
    if (occ[r * GRID_W + c] !== -1) return false;
  }
  return true;
}

/** 部品の数を数える */
export function countParts(design: CarDesign): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of design.parts) out[p.id] = (out[p.id] ?? 0) + 1;
  return out;
}

/** 設計図のまちがい (空なら走れる) */
export function validateDesign(design: CarDesign): string[] {
  const errs: string[] = [];
  if (!design || !Array.isArray(design.parts)) return ["設計図が読めません"];
  if (design.parts.length > GRID_W * GRID_H) return ["部品が多すぎます"];
  const occ = new Int16Array(GRID_W * GRID_H).fill(-1);
  let overlap = false;
  let outside = false;
  for (let i = 0; i < design.parts.length; i++) {
    const p = design.parts[i];
    const def = partDef(p.id);
    if (!def || (p.rot !== 0 && p.rot !== 1) || !Number.isInteger(p.c) || !Number.isInteger(p.r)) {
      return ["知らない部品があります"];
    }
    for (const [c, r] of placedCells(p)) {
      if (c < 0 || c >= GRID_W || r < 0 || r >= GRID_H) {
        outside = true;
        continue;
      }
      if (occ[r * GRID_W + c] !== -1) overlap = true;
      occ[r * GRID_W + c] = i;
    }
  }
  if (outside) errs.push("マス目からはみ出した部品があります");
  if (overlap) errs.push("重なった部品があります");

  const kinds = design.parts.map((p) => partDef(p.id)!.kind);
  const seats = kinds.filter((k) => k === "seat").length;
  if (seats !== 1) errs.push(seats === 0 ? "運転席を 1 つ置いてください" : "運転席は 1 つだけです");
  if (!kinds.includes("engine")) errs.push("エンジンが要ります");
  if (!kinds.includes("tank")) errs.push("燃料タンクが要ります");

  const tireRows: number[] = [];
  design.parts.forEach((p) => {
    if (partDef(p.id)!.kind === "tire") {
      const cells = placedCells(p);
      const rows = cells.map(([, r]) => r);
      tireRows.push((Math.min(...rows) + Math.max(...rows)) / 2);
    }
  });
  if (tireRows.length < 2) errs.push("タイヤが 2 つ以上要ります");
  else if (Math.max(...tireRows) - Math.min(...tireRows) < 3) errs.push("前と後ろにタイヤを離して置いてください (3 マス以上)");

  // つながり: 運転席から上下左右でたどれない部品があるか
  if (seats === 1 && !outside) {
    const seatIdx = kinds.indexOf("seat");
    const seen = new Set<number>([seatIdx]);
    const stack: Array<[number, number]> = placedCells(design.parts[seatIdx]);
    const visited = new Uint8Array(GRID_W * GRID_H);
    while (stack.length) {
      const [c, r] = stack.pop()!;
      if (visited[r * GRID_W + c]) continue;
      visited[r * GRID_W + c] = 1;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= GRID_W || nr < 0 || nr >= GRID_H) continue;
        const j = occ[nr * GRID_W + nc];
        if (j === -1 || visited[nr * GRID_W + nc]) continue;
        seen.add(j);
        stack.push([nc, nr]);
      }
    }
    if (seen.size < design.parts.length) errs.push("運転席とつながっていない部品があります");
  }
  return errs;
}

export interface CarStats {
  /** 重さ (kg、燃料満タン) */
  mass: number;
  /** 空のときの重さ */
  dryMass: number;
  /** 路面に伝わる力 (kW) */
  power: number;
  /** 燃料の容量 (L) */
  fuelCap: number;
  /** 全開で 1 秒に使う燃料 (L) */
  fuelRate: number;
  /** 握りだけで出せる横の加速 (m/s²) */
  gripAccel: number;
  /** 押しつけ (N / (m/s)²) */
  downK: number;
  /** 空気の抵抗 (N / (m/s)²) */
  dragK: number;
  /** 一番速く回れる向きの変え方 (rad/s) */
  turnRate: number;
  /** ブレーキ (m/s²) */
  brake: number;
  /** 重心の前後の偏り: + 前寄り (曲がりにくい)、- 後ろ寄り (後ろが滑る) */
  balance: number;
  /** 重心 (マス目の座標、列・行。小数) */
  comC: number;
  comR: number;
  /** 車の幅と長さ (m) */
  width: number;
  length: number;
  /** 最高速の目安 (m/s) */
  topSpeed: number;
  /** 車体 (部品のある四角) の中心の、マス目の真ん中からのずれ (m、右と前) */
  bodyLx: number;
  bodyLf: number;
  /** タイヤ部品の数 (多いほどピットのタイヤ交換が長い) */
  tireCount: number;
  /** 部品ごとの位置と働きの割合 (傷み damage.ts が使う。computeStats が入れる) */
  layout?: PartSlot[];
  /** タイヤの部品の特徴を握りの割合で混ぜた倍率 (tires.ts。computeStats が入れる。なし = 特徴なし) */
  tireMods?: TireMods;
  /** 付いているタイヤの特徴と、握りに占める割合 (画面用。同じ特徴・段階はまとめる) */
  tireTraits?: Array<{ trait: TireTrait; tier: number; share: number }>;
  /** 電池: オーバーテイクの目盛りに足す秒 (なし = 0。overtake.ts) */
  otExtra?: number;
  /** ギア箱: マニュアルの速さの上がり分に足す割合 (なし = 0。physics.ts) */
  shiftBonus?: number;
  /** サスペンション: 縁石と芝の 握りの落ちと揺れを減らす割合 (なし = 0。physics.ts) */
  susp?: number;
  /** 冷却: 燃料の食い方を減らした割合 (なし = 0。fuelRate に入っている。画面用) */
  cool?: number;
}

/** 新しい種類の効きの上限 (重ねて置いたとき。仮) */
export const DEV_CAPS = { cool: 0.25, battery: 6, susp: 0.6 } as const;
/** ギア箱: オートマでも力が shift × これ だけ上がる (ほんの少し) */
export const GEARBOX_AUTO_SHARE = 0.15;

/** 車の上の 1 つの部品 (傷みの計算用) */
export interface PartSlot {
  /** 設計図の parts の番号 */
  index: number;
  id: string;
  kind: PartKind;
  /** 部品の真ん中 (m、マス目の真ん中から 右 lx・前 lf) と、大きさの半分 */
  lx: number;
  lf: number;
  hx: number;
  hf: number;
  /** 部品の重さ (kg、燃料は入れない) */
  mass: number;
  /** 全体に占める割合: タイヤ = 握り・羽根 = 押しつけ・エンジン = 力・ブレーキ = 部品のブレーキの強さ。ほかは 0 */
  share: number;
  /** 羽根の空気の抵抗 (落ちると減る) */
  drag?: number;
  /** 頑丈: 当たったときの傷みを減らす割合 (0..1) */
  sturdy?: number;
}

const cellLf = (r: number) => (GRID_H / 2 - (r + 0.5)) * CELL;

/** 設計図から走りの数を出す。設計図は正しい (validateDesign が空) とする */
export function computeStats(design: CarDesign): CarStats {
  const occ = occupancy(design);
  let mass = 0;
  let fuelCap = 0;
  let sumC = 0;
  let sumR = 0;
  let grip = 0;
  let downforce = 0;
  let wingDrag = 0;
  let brake = 4;
  // 新しい種類 (研究で開発。置いていなければ全部 0 で、今までと同じ)
  let cool = 0;
  let battery = 0;
  let shift = 0;
  let suspKeep = 1;
  const tireCenters: Array<{ c: number; r: number }> = [];
  const tireParts: PartDef[] = [];
  const tireCellSet = new Set<number>();
  let seatR = GRID_H / 2;
  let minC = GRID_W;
  let maxC = -1;
  let minR = GRID_H;
  let maxR = -1;

  for (const p of design.parts) {
    const def = partDef(p.id)!;
    const cells = placedCells(p);
    const fuel = def.fuel ?? 0;
    const m = def.mass + fuel * FUEL_KG;
    let cc = 0;
    let rr = 0;
    for (const [c, r] of cells) {
      cc += c + 0.5;
      rr += r + 0.5;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
    cc /= cells.length;
    rr /= cells.length;
    mass += m;
    sumC += cc * m;
    sumR += rr * m;
    fuelCap += fuel;
    if (def.kind === "tire") {
      grip += def.grip ?? 0;
      tireParts.push(def);
      tireCenters.push({ c: cc, r: rr });
      for (const [c, r] of cells) tireCellSet.add(r * GRID_W + c);
    }
    if (def.kind === "wing") {
      downforce += def.downforce ?? 0;
      wingDrag += def.drag ?? 0;
    }
    if (def.kind === "brake") brake += def.brake ?? 0;
    if (def.kind === "seat") seatR = rr;
    if (def.kind === "cooler") cool += def.cool ?? 0;
    if (def.kind === "battery") battery += def.battery ?? 0;
    if (def.kind === "gearbox") shift = Math.max(shift, def.shift ?? 0);
    if (def.kind === "susp") suspKeep *= 1 - Math.max(0, Math.min(1, def.susp ?? 0));
  }
  if (mass <= 0) mass = 1;
  const comC = sumC / mass;
  const comR = sumR / mass;

  // エンジンの力: タイヤから遠いほど伝わりにくい (部品をたどった歩数)
  let power = 0;
  let fuelRate = 0;
  design.parts.forEach((p, i) => {
    const def = partDef(p.id)!;
    if (def.kind !== "engine") return;
    const steps = stepsToTire(occ, placedCells(p), i, tireCellSet);
    const eff = steps < 0 ? 0 : Math.max(0.6, 1 - 0.08 * (steps - 1));
    power += (def.power ?? 0) * eff;
    fuelRate += (def.power ?? 0) * (def.fuelUse ?? 1) * 0.0006;
  });

  const width = (maxC - minC + 1) * CELL;
  const length = (maxR - minR + 1) * CELL;

  // 握り: タイヤの握りの合計を重さで割ったもの (多いほどよいが、重さも増える)
  const gripRatio = Math.min(1.6, Math.max(0.45, Math.sqrt((grip * 120) / mass)));
  const gripAccel = 9.81 * 0.78 * gripRatio;

  // 前後のタイヤの間 (ホイールベース): 短いと小回り、長いとまっすぐ安定
  let wheelbase = 1;
  let tireMid = GRID_H / 2;
  if (tireCenters.length >= 2) {
    const rows = tireCenters.map((t) => t.r);
    wheelbase = Math.max(0.8, (Math.max(...rows) - Math.min(...rows)) * CELL);
    tireMid = (Math.max(...rows) + Math.min(...rows)) / 2;
  }
  // 運転席が前にあるほど反応がよい
  const seatFront = maxR > minR ? (maxR + 1 - seatR) / (maxR + 1 - minR) : 0.5;
  const turnRate = 2.1 * Math.sqrt(2.4 / wheelbase) * (0.88 + 0.24 * seatFront);

  // 重心の偏り (行は前が小さいので向きを逆に)
  const half = Math.max(0.5, (wheelbase / CELL) / 2);
  const balance = Math.max(-1, Math.min(1, (tireMid - comR) / half));

  // 部品ごとの位置と割合 (傷み用)
  const enginePower = new Map<number, number>();
  design.parts.forEach((p, i) => {
    const def = partDef(p.id)!;
    if (def.kind !== "engine") return;
    const steps = stepsToTire(occ, placedCells(p), i, tireCellSet);
    enginePower.set(i, (def.power ?? 0) * (steps < 0 ? 0 : Math.max(0.6, 1 - 0.08 * (steps - 1))));
  });
  const brakeParts = brake - 4;
  const layout: PartSlot[] = design.parts.map((p, i) => {
    const def = partDef(p.id)!;
    const { w, h } = placedSize(p, def);
    const lx = (p.c + w / 2 - GRID_W / 2) * CELL;
    const lf = (GRID_H / 2 - (p.r + h / 2)) * CELL;
    let share = 0;
    if (def.kind === "tire") share = grip > 0 ? (def.grip ?? 0) / grip : 0;
    else if (def.kind === "wing") share = downforce > 0 ? (def.downforce ?? 0) / downforce : 0;
    else if (def.kind === "engine") share = power > 0 ? (enginePower.get(i) ?? 0) / power : 0;
    else if (def.kind === "brake") share = brakeParts > 0 ? (def.brake ?? 0) / brakeParts : 0;
    const slot: PartSlot = { index: i, id: p.id, kind: def.kind, lx, lf, hx: (w * CELL) / 2, hf: (h * CELL) / 2, mass: def.mass, share };
    if (def.kind === "wing") slot.drag = def.drag ?? 0;
    if (def.sturdy) slot.sturdy = def.sturdy;
    return slot;
  });

  // タイヤの特徴: 握りの割合で混ぜる
  const tireMods = blendTireMods(tireParts.map((d) => ({ mods: traitMods(d.trait, d.tier), weight: d.grip ?? 0 })));
  const traitShares = new Map<string, { trait: TireTrait; tier: number; share: number }>();
  for (const d of tireParts) {
    if (!d.trait || !(grip > 0)) continue;
    const k = `${d.trait}:${d.tier}`;
    const cur = traitShares.get(k) ?? { trait: d.trait, tier: d.tier, share: 0 };
    cur.share += (d.grip ?? 0) / grip;
    traitShares.set(k, cur);
  }

  // 新しい種類の効き: 冷却 = 燃料の食い方・ギア箱 = オートマはほんの少し力 (マニュアルの分は physics.ts)
  cool = Math.min(DEV_CAPS.cool, cool);
  if (cool > 0) fuelRate *= 1 - cool;
  if (shift > 0) power *= 1 + shift * GEARBOX_AUTO_SHARE;
  const susp = Math.min(DEV_CAPS.susp, 1 - suspKeep);
  battery = Math.min(DEV_CAPS.battery, battery);

  const dragK = 0.17 * width + wingDrag;
  const downK = downforce * 0.8;
  const topSpeed = power > 0 ? Math.cbrt((power * 1000) / Math.max(0.05, dragK)) : 0;

  const extra: Partial<CarStats> = {};
  if (battery > 0) extra.otExtra = battery;
  if (shift > 0) extra.shiftBonus = shift;
  if (susp > 0) extra.susp = susp;
  if (cool > 0) extra.cool = cool;

  return {
    mass,
    dryMass: mass - fuelCap * FUEL_KG,
    power,
    fuelCap,
    fuelRate,
    gripAccel,
    downK,
    dragK,
    turnRate,
    brake,
    balance,
    comC,
    comR,
    width,
    length,
    topSpeed,
    bodyLx: maxC >= minC ? ((minC + maxC + 1) / 2 - GRID_W / 2) * CELL : 0,
    bodyLf: maxR >= minR ? (GRID_H / 2 - (minR + maxR + 1) / 2) * CELL : 0,
    tireCount: tireCenters.length,
    layout,
    tireMods,
    tireTraits: [...traitShares.values()].sort((a, b) => b.share - a.share),
    ...extra,
  };
}

/** エンジンからタイヤまで、部品の上をたどって何歩か (つながっていなければ -1) */
function stepsToTire(occ: Int16Array, start: Array<[number, number]>, self: number, tires: Set<number>): number {
  const dist = new Int16Array(GRID_W * GRID_H).fill(-1);
  const queue: number[] = [];
  for (const [c, r] of start) {
    dist[r * GRID_W + c] = 0;
    queue.push(r * GRID_W + c);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const c = cur % GRID_W;
    const r = (cur - c) / GRID_W;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= GRID_W || nr < 0 || nr >= GRID_H) continue;
      const k = nr * GRID_W + nc;
      if (dist[k] !== -1 || occ[k] === -1) continue;
      const step = occ[k] === self ? dist[cur] : dist[cur] + 1;
      if (tires.has(k)) return Math.max(1, step);
      dist[k] = step;
      queue.push(k);
    }
  }
  return -1;
}

/** 設計図の前後 (lf) と左右 (lx) の位置 (m)。描くときに使う */
export function cellLocal(c: number, r: number): { lx: number; lf: number } {
  return { lx: (c + 0.5 - GRID_W / 2) * CELL, lf: cellLf(r) };
}
