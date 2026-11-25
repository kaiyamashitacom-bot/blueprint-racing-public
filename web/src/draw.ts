// 部品と車の描き方 (車づくり・はじめの画面・レースで使う)。
// 見た目は F1 中継風: 部品は種類ごとの色の札、車は車の色で塗った車体 (塗り分け) にくっきりした縁
import { CELL, GRID_H, GRID_W, anyPartDef as partDef, computeStats, placedSize, type CarDesign, type PartDef, type PartKind } from "@bpr/shared";
import type { Palette } from "./store.ts";
import { partStrength } from "./race_rules.ts";

export interface Ink {
  line: string;
  fill: string;
  accent: string;
}

/** 部品の種類ごとの色 (CSS の --k-… から読む。読めなければ決めた色) */
const KIND_FALLBACK: Record<PartKind, string> = {
  seat: "#ff2b3a",
  engine: "#ff8a1f",
  tire: "#c5cbd6",
  tank: "#ffd21f",
  wing: "#2ec5ff",
  brake: "#b45cff",
  frame: "#7b8496",
  cooler: "#3fe0c5",
  battery: "#7dff4a",
  gearbox: "#ff5fb4",
  susp: "#5f8cff",
  ballast: "#4a4f5c",
};
let kindCache: Record<PartKind, string> | null = null;
export function kindColors(): Record<PartKind, string> {
  if (kindCache) return kindCache;
  const out = { ...KIND_FALLBACK };
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const k of Object.keys(out) as PartKind[]) {
      const v = cs.getPropertyValue(`--k-${k}`).trim();
      if (v) out[k] = v;
    }
  } catch {
    /* 画面のない所 (試験など) では決めた色 */
  }
  kindCache = out;
  return out;
}

/** 部品の札の描き方 */
export interface PartStyle {
  /** 札の色 (省くと種類の色) */
  tint?: string;
  /** 札の面を塗るか (省くと塗る) */
  tile?: boolean;
}

/**
 * 部品 1 つを (x, y, w, h) の四角に、種類の色の札として描く。u は線の太さの単位。
 * ink.line = 絵の明るい線、ink.fill = 札の下地、ink.accent = 差し色
 */
export function drawPart(ctx: CanvasRenderingContext2D, def: PartDef, x: number, y: number, w: number, h: number, ink: Ink, u: number, style: PartStyle = {}) {
  const tint = style.tint ?? kindColors()[def.kind];
  const pad = Math.max(1, u * 1.1);
  const x0 = x + pad;
  const y0 = y + pad;
  const w0 = w - pad * 2;
  const h0 = h - pad * 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const m = Math.min(w0, h0);
  const a0 = ctx.globalAlpha;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // 札: 下地 + 種類の色を薄く + 縁 + 上の帯
  if (style.tile !== false) {
    ctx.fillStyle = ink.fill;
    ctx.fillRect(x0, y0, w0, h0);
    ctx.globalAlpha = a0 * (def.kind === "frame" ? 0.1 : 0.18);
    ctx.fillStyle = tint;
    ctx.fillRect(x0, y0, w0, h0);
    ctx.lineWidth = u;
    ctx.strokeStyle = tint;
    ctx.globalAlpha = a0 * (def.kind === "frame" ? 0.45 : 0.9);
    ctx.strokeRect(x0 + u / 2, y0 + u / 2, w0 - u, h0 - u);
    ctx.globalAlpha = a0;
    if (def.kind !== "frame") {
      ctx.fillStyle = tint;
      ctx.fillRect(x0, y0, w0, Math.max(2, u * 2.2));
    }
  }

  ctx.lineWidth = u * 1.4;
  ctx.strokeStyle = tint;
  ctx.fillStyle = tint;
  switch (def.kind) {
    case "frame": {
      ctx.globalAlpha = a0 * 0.55;
      ctx.beginPath();
      ctx.moveTo(x0 + w0 * 0.22, y0 + h0 * 0.78);
      ctx.lineTo(x0 + w0 * 0.78, y0 + h0 * 0.22);
      ctx.moveTo(x0 + w0 * 0.22, y0 + h0 * 0.22);
      ctx.lineTo(x0 + w0 * 0.78, y0 + h0 * 0.78);
      ctx.stroke();
      ctx.globalAlpha = a0;
      break;
    }
    case "seat": {
      // 座席の U 字と、白いヘルメットに色の帯
      ctx.beginPath();
      ctx.moveTo(x0 + w0 * 0.2, y0 + h0 * 0.42);
      ctx.lineTo(x0 + w0 * 0.2, y0 + h0 * 0.82);
      ctx.lineTo(x0 + w0 * 0.8, y0 + h0 * 0.82);
      ctx.lineTo(x0 + w0 * 0.8, y0 + h0 * 0.42);
      ctx.stroke();
      const hr = m * 0.27;
      const hy = y0 + h0 * 0.38;
      ctx.fillStyle = ink.line;
      ctx.beginPath();
      ctx.arc(cx, hy, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = tint;
      ctx.fillRect(cx - hr, hy - hr * 0.42, hr * 2, hr * 0.5);
      break;
    }
    case "engine": {
      // シリンダーを 2 列
      const n = Math.max(2, Math.round(h0 / (m * 0.45)));
      ctx.lineWidth = u * 1.2;
      for (let i = 0; i < n; i++) {
        const yy = y0 + h0 * 0.1 + (h0 * 0.85 * (i + 0.5)) / n;
        for (const sx of [-0.2, 0.2]) {
          ctx.beginPath();
          ctx.arc(cx + w0 * sx, yy, m * 0.12, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = ink.line;
      ctx.globalAlpha = a0 * 0.7;
      ctx.beginPath();
      ctx.moveTo(cx, y0 + h0 * 0.16);
      ctx.lineTo(cx, y0 + h0 * 0.9);
      ctx.stroke();
      ctx.globalAlpha = a0;
      if (def.tier >= 2) dot(ctx, x0 + w0 - u * 3.5, y0 + u * 5, u * 1.8, ink.line);
      break;
    }
    case "tire": {
      // 黒いゴムに種類の色の縁と溝
      const tx = x0 + w0 * 0.14;
      const tw = w0 * 0.72;
      const ty = y0 + h0 * 0.08;
      const th = h0 * 0.86;
      roundRect(ctx, tx, ty, tw, th, m * 0.16);
      ctx.fillStyle = "#07080b";
      ctx.fill();
      ctx.lineWidth = u * 1.2;
      ctx.stroke();
      const n = Math.max(3, Math.round(th / (u * 4.5)));
      ctx.globalAlpha = a0 * 0.55;
      ctx.beginPath();
      for (let i = 1; i < n; i++) {
        const yy = ty + (th * i) / n;
        ctx.moveTo(tx + tw * 0.22, yy);
        ctx.lineTo(tx + tw * 0.78, yy);
      }
      ctx.stroke();
      ctx.globalAlpha = a0;
      break;
    }
    case "tank": {
      // 量の目盛り: 下 6 割を塗る
      const tx = x0 + w0 * 0.2;
      const tw = w0 * 0.6;
      const ty = y0 + h0 * 0.2;
      const th = h0 * 0.66;
      ctx.globalAlpha = a0 * 0.75;
      ctx.fillRect(tx, ty + th * 0.4, tw, th * 0.6);
      ctx.globalAlpha = a0;
      ctx.lineWidth = u * 1.2;
      roundRect(ctx, tx, ty, tw, th, m * 0.08);
      ctx.stroke();
      break;
    }
    case "wing": {
      // 太い板と両端の板
      const horiz = w0 >= h0;
      ctx.lineCap = "butt";
      ctx.lineWidth = Math.max(u * 2.6, m * 0.3);
      ctx.beginPath();
      if (horiz) {
        ctx.moveTo(x0 + w0 * 0.08, cy);
        ctx.lineTo(x0 + w0 * 0.92, cy);
      } else {
        ctx.moveTo(cx, y0 + h0 * 0.08);
        ctx.lineTo(cx, y0 + h0 * 0.92);
      }
      ctx.stroke();
      ctx.strokeStyle = ink.line;
      ctx.lineWidth = u * 1.6;
      ctx.beginPath();
      if (horiz) {
        ctx.moveTo(x0 + w0 * 0.08, y0 + h0 * 0.2);
        ctx.lineTo(x0 + w0 * 0.08, y0 + h0 * 0.8);
        ctx.moveTo(x0 + w0 * 0.92, y0 + h0 * 0.2);
        ctx.lineTo(x0 + w0 * 0.92, y0 + h0 * 0.8);
      } else {
        ctx.moveTo(x0 + w0 * 0.2, y0 + h0 * 0.08);
        ctx.lineTo(x0 + w0 * 0.8, y0 + h0 * 0.08);
        ctx.moveTo(x0 + w0 * 0.2, y0 + h0 * 0.92);
        ctx.lineTo(x0 + w0 * 0.8, y0 + h0 * 0.92);
      }
      ctx.stroke();
      break;
    }
    case "brake": {
      ctx.lineWidth = u * 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy + u, m * 0.32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = u * 2;
      ctx.beginPath();
      ctx.arc(cx, cy + u, m * 0.32, -2.3, -0.8);
      ctx.strokeStyle = ink.line;
      ctx.stroke();
      dot(ctx, cx, cy + u, m * 0.09, tint);
      break;
    }
    // ---- 研究で開発する種類 ----
    case "cooler": {
      // 冷却: 縦の放熱のひれと 雪の印
      const n = Math.max(3, Math.round(w0 / (u * 3.2)));
      ctx.lineWidth = u * 1.1;
      ctx.beginPath();
      for (let i = 1; i < n; i++) {
        const xx = x0 + (w0 * i) / n;
        ctx.moveTo(xx, y0 + h0 * 0.22);
        ctx.lineTo(xx, y0 + h0 * 0.88);
      }
      ctx.stroke();
      ctx.strokeStyle = ink.line;
      ctx.lineWidth = u * 1.2;
      const r = m * 0.2;
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3;
        ctx.moveTo(cx - Math.cos(a) * r, cy + u - Math.sin(a) * r);
        ctx.lineTo(cx + Math.cos(a) * r, cy + u + Math.sin(a) * r);
      }
      ctx.stroke();
      break;
    }
    case "battery": {
      // 電池: 箱と 端子と 稲妻
      const bx = x0 + w0 * 0.16;
      const bw = w0 * 0.68;
      const by = y0 + h0 * 0.28;
      const bh = h0 * 0.6;
      ctx.lineWidth = u * 1.2;
      roundRect(ctx, bx, by, bw, bh, m * 0.06);
      ctx.stroke();
      ctx.fillRect(cx - bw * 0.16, by - u * 1.6, bw * 0.32, u * 1.6);
      ctx.fillStyle = ink.line;
      ctx.beginPath();
      ctx.moveTo(cx + m * 0.06, by + bh * 0.12);
      ctx.lineTo(cx - m * 0.12, by + bh * 0.56);
      ctx.lineTo(cx, by + bh * 0.56);
      ctx.lineTo(cx - m * 0.06, by + bh * 0.9);
      ctx.lineTo(cx + m * 0.13, by + bh * 0.42);
      ctx.lineTo(cx + m * 0.01, by + bh * 0.42);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "gearbox": {
      // ギア箱: 歯車
      const r = m * 0.3;
      const gy = cy + u;
      ctx.lineWidth = u * 1.2;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        ctx.moveTo(cx + Math.cos(a) * r * 0.8, gy + Math.sin(a) * r * 0.8);
        ctx.lineTo(cx + Math.cos(a) * r * 1.15, gy + Math.sin(a) * r * 1.15);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, gy, r * 0.85, 0, Math.PI * 2);
      ctx.stroke();
      dot(ctx, cx, gy, r * 0.3, ink.line);
      break;
    }
    case "susp": {
      // サスペンション: ばね (ジグザグ)
      const sx0 = cx - w0 * 0.22;
      const sx1 = cx + w0 * 0.22;
      const ty = y0 + h0 * 0.22;
      const by = y0 + h0 * 0.88;
      const n = Math.max(4, Math.round((by - ty) / (u * 2.2)));
      ctx.lineWidth = u * 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, ty);
      for (let i = 1; i < n; i++) ctx.lineTo(i % 2 ? sx1 : sx0, ty + ((by - ty) * i) / n);
      ctx.lineTo(cx, by);
      ctx.stroke();
      ctx.strokeStyle = ink.line;
      ctx.beginPath();
      ctx.moveTo(sx0, ty);
      ctx.lineTo(sx1, ty);
      ctx.moveTo(sx0, by);
      ctx.lineTo(sx1, by);
      ctx.stroke();
      break;
    }
    case "ballast": {
      // 重り: 台形の分銅 (段階が上がるほど濃く)
      ctx.globalAlpha = a0 * (0.45 + 0.15 * Math.max(0, def.tier - 3));
      ctx.fillStyle = ink.line;
      ctx.beginPath();
      ctx.moveTo(x0 + w0 * 0.3, y0 + h0 * 0.36);
      ctx.lineTo(x0 + w0 * 0.7, y0 + h0 * 0.36);
      ctx.lineTo(x0 + w0 * 0.84, y0 + h0 * 0.86);
      ctx.lineTo(x0 + w0 * 0.16, y0 + h0 * 0.86);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = a0;
      ctx.lineWidth = u * 1.1;
      ctx.beginPath();
      ctx.arc(cx, y0 + h0 * 0.3, m * 0.09, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
  }
  // 限界を超えた部品 (5+・5++): 右上に金の印
  if (def.limit) {
    ctx.globalAlpha = a0;
    for (let i = 0; i < def.limit; i++) dot(ctx, x0 + w0 - u * (3 + i * 3.4), y0 + h0 - u * 3, u * 1.5, "#ffc94a");
  }
  ctx.globalAlpha = a0;
  ctx.lineCap = "butt";
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  addRoundRect(ctx, x, y, w, h, r);
}

/** 今の道に角の丸い四角を足す (beginPath しない。重ねて塗ると合わさった形になる) */
function addRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** 部品のある範囲 (マス) */
export function designBounds(design: CarDesign): { c0: number; r0: number; c1: number; r1: number } | null {
  let c0 = GRID_W;
  let r0 = GRID_H;
  let c1 = -1;
  let r1 = -1;
  for (const p of design.parts) {
    const def = partDef(p.id);
    if (!def) continue;
    const { w, h } = placedSize(p, def);
    c0 = Math.min(c0, p.c);
    r0 = Math.min(r0, p.r);
    c1 = Math.max(c1, p.c + w);
    r1 = Math.max(r1, p.r + h);
  }
  return c1 < 0 ? null : { c0, r0, c1, r1 };
}

/** マス目の座標で車を部品の札で描く (左上が (0,0)、1 マス = cell)。車づくりのマス目用 */
export function drawDesignGrid(ctx: CanvasRenderingContext2D, design: CarDesign, cell: number, ink: Ink, u: number) {
  for (const p of design.parts) {
    const def = partDef(p.id);
    if (!def) continue;
    const { w, h } = placedSize(p, def);
    drawPart(ctx, def, p.c * cell, p.r * cell, w * cell, h * cell, ink, u);
  }
}

/** 塗り分けの車の色 */
export interface Livery {
  /** 車体の色 (チームの色) */
  body: string;
  /** 外側の縁取り (自分の車の印など)。省くと暗い縁だけ */
  outline?: string;
  /** 操縦席・タイヤの暗い色 */
  dark: string;
  /** 帯・ヘルメット・タイヤの縁の明るい色 */
  trim: string;
  /** 光 (自分の車など) */
  glow?: string;
}

interface Piece {
  def: PartDef;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 塗り分けの車を、マス目の座標 (左上 (0,0)、1 マス = cell) で描く。
 * タイヤ以外の部品が合わさって車体になり、車の色で塗る。u は線の太さの単位
 */
export function drawCarLivery(ctx: CanvasRenderingContext2D, design: CarDesign, cell: number, lv: Livery, u: number) {
  const body: Piece[] = [];
  const tires: Piece[] = [];
  for (const p of design.parts) {
    const def = partDef(p.id);
    if (!def) continue;
    const { w, h } = placedSize(p, def);
    const it = { def, x: p.c * cell, y: p.r * cell, w: w * cell, h: h * cell };
    (def.kind === "tire" ? tires : body).push(it);
  }
  const a0 = ctx.globalAlpha;
  const inset = 0;
  // 小さく描くとき (レースで遠い車) は細かい線を省く
  const fine = cell / u > 6;
  // 車体の形 (部品の四角を合わせた形)。羽根は薄い向きを細くする
  const bodyPath = (grow: number) => {
    ctx.beginPath();
    for (const b of body) {
      let ix = inset;
      let iy = inset;
      if (b.def.kind === "wing") {
        if (b.w >= b.h) iy += cell * 0.16;
        else ix += cell * 0.16;
      }
      addRoundRect(ctx, b.x + ix - grow, b.y + iy - grow, b.w - ix * 2 + grow * 2, b.h - iy * 2 + grow * 2, cell * 0.1 + grow);
    }
  };

  // タイヤ (車体の下)
  ctx.lineJoin = "round";
  for (const t of tires) {
    const ix = t.w * 0.1;
    const iy = t.h * 0.05;
    roundRect(ctx, t.x + ix, t.y + iy, t.w - ix * 2, t.h - iy * 2, cell * 0.22);
    ctx.fillStyle = lv.dark;
    ctx.fill();
    ctx.lineWidth = u * 1.2;
    ctx.strokeStyle = lv.trim;
    ctx.globalAlpha = a0 * 0.55;
    ctx.stroke();
    // 溝
    ctx.globalAlpha = fine ? a0 * 0.22 : 0;
    ctx.beginPath();
    const n = Math.max(2, Math.round(t.h / cell) * 2);
    for (let i = 1; i < n; i++) {
      const yy = t.y + iy + ((t.h - iy * 2) * i) / n;
      ctx.moveTo(t.x + t.w * 0.28, yy);
      ctx.lineTo(t.x + t.w * 0.72, yy);
    }
    ctx.stroke();
    ctx.globalAlpha = a0;
  }

  if (!body.length) return;
  // 外側の縁取り (+ 光)、その内に暗い縁
  const edge = Math.max(u * 1.3, cell * 0.05);
  if (lv.outline || lv.glow) {
    bodyPath(edge + u * 1.4);
    if (lv.glow) {
      ctx.shadowColor = lv.glow;
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = lv.outline ?? lv.glow ?? lv.dark;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }
  bodyPath(edge);
  ctx.fillStyle = lv.dark;
  ctx.fill();
  // 車体
  bodyPath(0);
  ctx.fillStyle = lv.body;
  ctx.fill();

  // 帯と細部は車体の中だけに
  ctx.save();
  bodyPath(0);
  ctx.clip();
  // 光の当たり方 (左を少し明るく、右を暗く)
  const g = ctx.createLinearGradient(0, 0, GRID_W * cell, 0);
  g.addColorStop(0, "rgba(255,255,255,0.16)");
  g.addColorStop(0.5, "rgba(255,255,255,0)");
  g.addColorStop(1, "rgba(0,0,0,0.22)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, GRID_W * cell, GRID_H * cell);
  // まん中の帯 2 本
  const mid = (GRID_W * cell) / 2;
  ctx.fillStyle = lv.trim;
  ctx.globalAlpha = a0 * 0.9;
  ctx.fillRect(mid - cell * 0.2, 0, cell * 0.1, GRID_H * cell);
  ctx.fillRect(mid + cell * 0.1, 0, cell * 0.1, GRID_H * cell);
  ctx.globalAlpha = a0;
  for (const b of body) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const m = Math.min(b.w, b.h);
    switch (b.def.kind) {
      case "seat": {
        // 操縦席の穴とヘルメット
        roundRect(ctx, b.x + b.w * 0.16, b.y + b.h * 0.12, b.w * 0.68, b.h * 0.76, cell * 0.3);
        ctx.fillStyle = lv.dark;
        ctx.fill();
        ctx.fillStyle = lv.trim;
        ctx.beginPath();
        ctx.arc(cx, b.y + b.h * 0.42, m * 0.26, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = lv.body;
        ctx.fillRect(cx - m * 0.26, b.y + b.h * 0.42 - m * 0.12, m * 0.52, m * 0.1);
        break;
      }
      case "engine": {
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fillRect(b.x + b.w * 0.12, b.y + b.h * 0.1, b.w * 0.76, b.h * 0.8);
        if (!fine) break;
        ctx.strokeStyle = lv.trim;
        ctx.lineWidth = u;
        ctx.globalAlpha = a0 * 0.45;
        ctx.beginPath();
        const n = Math.max(2, Math.round(b.h / cell) + 1);
        for (let i = 0; i < n; i++) {
          const yy = b.y + b.h * 0.2 + (b.h * 0.6 * i) / Math.max(1, n - 1);
          ctx.moveTo(b.x + b.w * 0.2, yy);
          ctx.lineTo(b.x + b.w * 0.36, yy);
          ctx.moveTo(b.x + b.w * 0.64, yy);
          ctx.lineTo(b.x + b.w * 0.8, yy);
        }
        ctx.stroke();
        ctx.globalAlpha = a0;
        break;
      }
      case "tank": {
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fillRect(b.x + b.w * 0.15, b.y + b.h * 0.15, b.w * 0.7, b.h * 0.7);
        dot(ctx, cx, cy, m * 0.1, lv.trim);
        break;
      }
      case "wing": {
        ctx.fillStyle = lv.dark;
        ctx.globalAlpha = a0 * 0.75;
        if (b.w >= b.h) ctx.fillRect(b.x, cy - b.h * 0.1, b.w, b.h * 0.2);
        else ctx.fillRect(cx - b.w * 0.1, b.y, b.w * 0.2, b.h);
        ctx.globalAlpha = a0;
        break;
      }
      case "brake": {
        ctx.strokeStyle = lv.dark;
        ctx.lineWidth = u * 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, m * 0.24, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      default:
        break;
    }
  }
  ctx.restore();
  ctx.globalAlpha = a0;
}

/**
 * レースで車を描く: 世界の座標 (m) で、向き heading。
 * 車体を ink.accent (車の色) で塗り分け、ink.fill を操縦席・タイヤの暗い色に使う。
 * opts.outline は外側の縁取りの色 (省くと暗い縁だけ)、opts.glow は光
 */
export function drawCarWorld(ctx: CanvasRenderingContext2D, design: CarDesign, x: number, y: number, heading: number, ink: Ink, pxPerM: number, opts: { outline?: string; glow?: string } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading + Math.PI / 2);
  ctx.translate((-GRID_W * CELL) / 2, (-GRID_H * CELL) / 2);
  const u = Math.max(0.035, 1.1 / pxPerM);
  drawCarLivery(ctx, design, CELL, { body: ink.accent, outline: opts.outline, dark: ink.fill || "#07080b", trim: "#f3f5f8", glow: opts.glow }, u);
  ctx.restore();
}

/** 重心の印: 白黒と差し色の 4 つ割りの丸 (計測の印)。label があれば横に札 */
export function drawComMarker(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, p: Palette, label?: string) {
  ctx.save();
  ctx.lineWidth = Math.max(3, r * 0.3);
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, r * 0.14);
  ctx.strokeStyle = p.ink;
  ctx.stroke();
  const q = (a: number, c: string) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r * 0.66, a, a + Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  };
  q(-Math.PI / 2, p.ink);
  q(Math.PI / 2, p.ink);
  q(0, p.accent);
  q(Math.PI, p.accent);
  if (label) {
    const size = Math.max(12, Math.round(r * 0.8));
    ctx.font = `700 ${size}px 'Noto Sans JP', sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const tw = ctx.measureText(label).width;
    const lx = x + r + 6;
    const lh = size + 6;
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.fillRect(lx, y - lh / 2, tw + 12, lh);
    ctx.fillStyle = p.accent;
    ctx.fillRect(lx, y - lh / 2, 3, lh);
    ctx.fillStyle = p.ink;
    ctx.fillText(label, lx + 7, y + 1);
  }
  ctx.restore();
}

/** 字の札 (暗い四角に白い字、左に色の帯)。幅を返す */
export function drawChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, p: Palette, opts: { color?: string; size?: number; align?: "left" | "center" | "right" } = {}): number {
  const size = opts.size ?? 13;
  ctx.save();
  ctx.font = `700 ${size}px 'Barlow Condensed', 'Noto Sans JP', sans-serif`;
  const tw = ctx.measureText(text).width;
  const w = tw + 14;
  const h = size + 8;
  const x0 = opts.align === "center" ? x - w / 2 : opts.align === "right" ? x - w : x;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x0, y - h / 2, w, h);
  ctx.fillStyle = opts.color ?? p.accent;
  ctx.fillRect(x0, y - h / 2, 3, h);
  ctx.fillStyle = p.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x0 + 8, y + 1);
  ctx.restore();
  return w;
}

/**
 * はじめの画面の大きな絵: 上から見た塗り分けの車 + 重心の印 + 大きさの札。
 * (w, h) の中に収める。背景は CSS がかく (ここは透明)
 */
export function drawCarShowcase(ctx: CanvasRenderingContext2D, design: CarDesign | null, w: number, h: number, p: Palette) {
  ctx.clearRect(0, 0, w, h);
  const b = design ? designBounds(design) : null;
  if (!design || !b) {
    ctx.fillStyle = p.dim;
    ctx.font = "500 14px 'Noto Sans JP', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("まだ車がありません", w / 2, h / 2);
    return;
  }
  const cols = b.c1 - b.c0;
  const rows = b.r1 - b.r0;
  const mx = 44;
  const my = 44;
  const cell = Math.max(8, Math.floor(Math.min((w - mx * 2) / cols, (h - my * 2) / rows)));
  const ox = Math.round((w - cols * cell) / 2 - b.c0 * cell);
  const oy = Math.round((h - rows * cell) / 2 + 6 - b.r0 * cell);
  const midX = ox + (GRID_W / 2) * cell;

  // 床の白線 (走る向き)
  ctx.fillStyle = p.ghost;
  for (const dx of [-1, 1]) ctx.fillRect(midX + dx * (cols * cell * 0.5 + 22) - 1, 0, 3, h);

  ctx.save();
  ctx.translate(ox, oy);
  // 影
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.filter = "blur(10px)";
  ctx.fillRect(b.c0 * cell + 6, b.r0 * cell + 12, cols * cell, rows * cell);
  ctx.restore();
  drawCarLivery(ctx, design, cell, { body: p.accent, dark: "#07080b", trim: p.ink }, Math.max(1.2, cell / 22));
  const st = computeStats(design, partStrength());
  drawComMarker(ctx, st.comC * cell, st.comR * cell, Math.max(7, cell * 0.24), p, "重心");
  ctx.restore();

  // 前の印と大きさの札
  ctx.fillStyle = p.accent;
  const fy = oy + b.r0 * cell - 16;
  ctx.beginPath();
  ctx.moveTo(midX, fy - 7);
  ctx.lineTo(midX - 7, fy + 3);
  ctx.lineTo(midX + 7, fy + 3);
  ctx.closePath();
  ctx.fill();
  drawChip(ctx, 10, 20, `幅 ${(cols * CELL).toFixed(1)} m`, p, { color: p.ink2 });
  drawChip(ctx, 10, 44, `長さ ${(rows * CELL).toFixed(1)} m`, p, { color: p.ink2 });
  ctx.font = "700 12px 'Barlow Condensed', sans-serif";
  ctx.fillStyle = p.dim;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("TOP VIEW", w - 10, 12);
}

/** コースの小さな絵 (レースの地図)。線 1 本と、スタートの点 */
export function drawTrackThumb(ctx: CanvasRenderingContext2D, px: Float64Array, py: Float64Array, w: number, h: number, color: string, lineW: number) {
  const f = fitTrack(px, py, w, h, lineW * 3);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.lineJoin = "round";
  traceTrack(ctx, px, py, f);
  ctx.stroke();
  // スタート
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px[0] * f.sc + f.ox, py[0] * f.sc + f.oy, lineW * 1.6, 0, Math.PI * 2);
  ctx.fill();
}

/** 練習のカードのコースの絵: うすく太い道 + 白い線 + 差し色のスタートの棒 */
export function drawTrackCard(ctx: CanvasRenderingContext2D, px: Float64Array, py: Float64Array, w: number, h: number, p: Palette, accent: string) {
  ctx.clearRect(0, 0, w, h);
  const f = fitTrack(px, py, w, h, 12);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  traceTrack(ctx, px, py, f);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = p.ink;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  // スタートの棒 (走る向きに直角)
  const n = px.length;
  const x0 = px[0] * f.sc + f.ox;
  const y0 = py[0] * f.sc + f.oy;
  const dx = px[1 % n] - px[0];
  const dy = py[1 % n] - py[0];
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L;
  const ny = dx / L;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3.5;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(x0 - nx * 7, y0 - ny * 7);
  ctx.lineTo(x0 + nx * 7, y0 + ny * 7);
  ctx.stroke();
}

function fitTrack(px: Float64Array, py: Float64Array, w: number, h: number, pad: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < px.length; i++) {
    minX = Math.min(minX, px[i]);
    maxX = Math.max(maxX, px[i]);
    minY = Math.min(minY, py[i]);
    maxY = Math.max(maxY, py[i]);
  }
  const sc = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
  const ox = (w - (maxX - minX) * sc) / 2 - minX * sc;
  const oy = (h - (maxY - minY) * sc) / 2 - minY * sc;
  return { sc, ox, oy };
}

function traceTrack(ctx: CanvasRenderingContext2D, px: Float64Array, py: Float64Array, f: { sc: number; ox: number; oy: number }) {
  ctx.beginPath();
  for (let i = 0; i <= px.length; i++) {
    const k = i % px.length;
    const x = px[k] * f.sc + f.ox;
    const y = py[k] * f.sc + f.oy;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}
