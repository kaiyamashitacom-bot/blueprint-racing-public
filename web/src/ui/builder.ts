// 車づくり (F1 中継風): 7 × 11 のマス目に部品を置く。部品表から選んでマスを押すと置き、置いた部品を押すと外す
// 部品は種類ごとの色の札。重心の印と、車の幅・長さの帯を出す
// 試走台: 部品を置くたびに 最高速・曲がり・1 周の燃料・公式コースの予想タイムを出し、前の形との差を緑 / 赤で見せる (bench.ts)
// 改訂: 走れる形を版 (Rev.A・Rev.B…) として残し、版ごとの一番速い周と性能を並べて比べ、前の版に戻せる (store.ts)
import {
  BENCH_RADIUS,
  CELL,
  GRID_H,
  GRID_W,
  ALL_PART_DEFS,
  BASE_PART_KINDS,
  DEV_PART_KINDS,
  SAMPLE_DESIGN,
  TIRE_TRAITS,
  TRACK_DEFS,
  anyPartDef,
  benchLap,
  canPlace,
  computeStats,
  cornerSpeed,
  countParts,
  formatTime,
  fuelPerMeter,
  getTrack,
  occupancy,
  partDef,
  placedCells,
  placedSize,
  validateDesign,
  type BenchLap,
  type CarDesign,
  type CarStats,
  type PartDef,
  type Placed,
} from "@bpr/shared";
import { drawComMarker, drawDesignGrid, drawPart, kindColors, type Ink } from "../draw.ts";
import type { Go } from "../main.ts";
import { partBox, refreshAccount } from "../api.ts";
import { commitRevision, currentRevision, dropRevisions, load, palette, partsKey, revLabel, revisionsOf, save, type Revision } from "../store.ts";
import { el, fitCanvas } from "./dom.ts";
import { fuelLaps } from "./setup.ts";

/** 試走台の 1 コースの答え (コースの id → 2 周目) */
type BenchSet = Record<string, BenchLap>;
/** 燃料を見るコース (青図) */
const FUEL_TRACK = "aozu";
/** 試走台の計算を待つ時間 (ms、続けて置いている間は待つ) と 覚えておく形の数 (仮) */
const BENCH_WAIT = 140;
const BENCH_CACHE = 80;
const benchCache = new Map<string, BenchSet>();

/** 部品の表に出す部品: お店・研究・進化の部品 (持っているものだけ)。種類の順 (新しい種類は後ろ) */
const KIND_ORDER = [...BASE_PART_KINDS, ...DEV_PART_KINDS];
const ALL_PARTS: readonly PartDef[] = [...ALL_PART_DEFS].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.tier - b.tier);
const KNOWN = new Set(ALL_PARTS.map((p) => p.id));
/** 持ち物の部品の一覧 (表の順 + 限界を超えた 5+・5++ は元の部品のすぐ後ろ)。限界突破の品 (item:…) は入れない */
function boxParts(box: Readonly<Record<string, number>>): PartDef[] {
  const out: PartDef[] = [];
  for (const def of ALL_PARTS) {
    if (def.id in box) out.push(def);
    for (const lv of [1, 2]) {
      const id = `${def.id}_x${lv}`;
      if (id in box && !KNOWN.has(id)) {
        const d = anyPartDef(id);
        if (d) out.push(d);
      }
    }
  }
  return out;
}
/** 段階の札 (限界を超えた部品は 5+ / 5++) */
const tierLabel = (d: PartDef) => `T${d.tier}${"+".repeat(d.limit ?? 0)}`;

/** コースの短い名前 (「サーキット」を外す) */
const shortTrack = (name: string) => name.replace(/サーキット$/, "");

/** 前との差の札。better = 大きいほうが良いか */
function deltaChip(d: number | null, better: "up" | "down", fmt: (v: number) => string, eps: number): HTMLElement {
  if (d === null || !Number.isFinite(d)) return el("i", { class: "d none" }, "");
  if (Math.abs(d) < eps) return el("i", { class: "d same" }, "±0");
  const good = better === "up" ? d > 0 : d < 0;
  return el("i", { class: `d ${good ? "good" : "bad"}` }, `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`);
}

const COLS = "ABCDEFG";
const M = { l: 24, t: 40, r: 40, b: 44 };

export function mountBuilder(root: HTMLElement, go: Go): () => void {
  const s = load();
  if (!s.designs.length) {
    s.designs.push({ name: "1 号車", parts: [] });
    s.active = 0;
    save();
  }
  let design: CarDesign = s.designs[s.active] ?? s.designs[0];
  let selected: string | null = design.parts.length ? null : "seat";
  let rot: 0 | 1 = 0;
  let hover: { c: number; r: number } | null = null;
  /** 試走台で比べる相手: 最後に変える前の形 (prev)、または選んだ版 (compare) */
  let prevParts: Placed[] | null = null;
  let compare: Revision | null = null;
  const clone = (ps: readonly Placed[]) => ps.map((p) => ({ ...p }));
  /** 部品を変える前に呼ぶ (差を出すために 前の形を覚える) */
  const beforeEdit = () => {
    prevParts = clone(design.parts);
  };
  const runnable = (d: CarDesign) => d.parts.length > 0 && validateDesign(d).length === 0;
  /** 走れる形なら版として残す (同じ形の版があれば何もしない) */
  const commitIfRunnable = () => {
    if (runnable(design)) commitRevision(design);
  };

  const sheet = el("div", { class: "sheet builder-page" });
  root.append(sheet);

  // 見出しの帯
  const back = el("button", { class: "small" }, "◀ もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  const nameIn = el("input", { maxlength: "16", value: design.name, "aria-label": "車の名前" }) as HTMLInputElement;
  nameIn.addEventListener("input", () => {
    design.name = nameIn.value.slice(0, 16) || "名無しの車";
    save();
    refreshList();
  });
  const list = el("select", { "aria-label": "設計図" }) as HTMLSelectElement;
  list.addEventListener("change", () => switchTo(Number(list.value)));
  const btnNew = el("button", { class: "small" }, "＋ 新しく");
  btnNew.addEventListener("click", () => {
    s.designs.push({ name: `${s.designs.length + 1} 号車`, parts: [] });
    switchTo(s.designs.length - 1);
  });
  const btnCopy = el("button", { class: "small" }, "写す");
  btnCopy.addEventListener("click", () => {
    s.designs.push({ name: `${design.name} の写し`.slice(0, 16), parts: design.parts.map((p) => ({ ...p })) });
    switchTo(s.designs.length - 1);
  });
  const btnDel = el("button", { class: "small" }, "捨てる");
  btnDel.addEventListener("click", () => {
    if (!confirm(`「${design.name}」の設計図を捨てますか? (版も全部消えます。元に戻せません)`)) return;
    dropRevisions(design);
    s.designs.splice(s.active, 1);
    if (!s.designs.length) s.designs.push({ name: "1 号車", parts: [] });
    switchTo(0);
  });
  const switchTo = (i: number) => {
    if (s.designs.includes(design)) commitIfRunnable();
    s.active = i;
    design = s.designs[i];
    prevParts = null;
    compare = null;
    nameIn.value = design.name;
    save();
    refreshList();
    redraw();
  };
  const refreshList = () => {
    list.innerHTML = "";
    s.designs.forEach((d, i) => list.append(el("option", { value: String(i) }, d.name)));
    list.value = String(s.active);
  };
  sheet.append(
    el(
      "header",
      { class: "toolbar" },
      back,
      el("div", { class: "title" }, el("h2", {}, "車づくり"), el("span", { class: "label" }, "Garage")),
      el("div", { class: "pick" }, list, nameIn, btnNew, btnCopy, btnDel),
    ),
  );

  const wrap = el("div", { class: "builder" });
  sheet.append(wrap);

  // 左: マス目
  const canvas = el("canvas", { class: "grid-canvas" }) as HTMLCanvasElement;
  const rotT = el("div", { class: "toggle" });
  const rot0 = el("button", { class: "on" }, "縦向き");
  const rot1 = el("button", {}, "横向き");
  rotT.append(rot0, rot1);
  rot0.addEventListener("click", () => setRot(0));
  rot1.addEventListener("click", () => setRot(1));
  const setRot = (r: 0 | 1) => {
    rot = r;
    rot0.classList.toggle("on", r === 0);
    rot1.classList.toggle("on", r === 1);
    redraw();
  };
  const sampleBtn = el("button", { class: "small" }, "見本を置く");
  sampleBtn.addEventListener("click", () => {
    if (design.parts.length && !confirm("今の部品を外して見本を置きますか?")) return;
    commitIfRunnable();
    beforeEdit();
    design.parts = SAMPLE_DESIGN.parts.map((p) => ({ ...p }));
    selected = null;
    save();
    redraw();
  });
  const clearBtn = el("button", { class: "small" }, "全部外す");
  clearBtn.addEventListener("click", () => {
    if (!design.parts.length || !confirm("部品を全部外しますか?")) return;
    commitIfRunnable();
    beforeEdit();
    design.parts = [];
    save();
    redraw();
  });
  const hint = el("div", { class: "hint" });
  // スマホ: 部品の帯 (横に流せる札。絵と残りの数)。マス目のすぐ下に出して、上下に行き来せずに置けるように。広い画面では右の部品表を使う
  const strip = el("div", { class: "part-strip", role: "listbox", "aria-label": "部品" });
  wrap.append(
    el(
      "section",
      { class: "frame board" },
      el("div", { class: "board-main" }, canvas, strip),
      hint,
      el("div", { class: "row controls" }, el("span", { class: "label" }, "向き (R)"), rotT),
      el("div", { class: "row controls" }, sampleBtn, clearBtn),
    ),
  );

  // 右: 部品表と性能 (試走台) と改訂
  const bomBody = el("tbody");
  const bench = el("div", { class: "bench" });
  const traceCanvas = el("canvas", { class: "trace-canvas", "aria-hidden": "true" }) as HTMLCanvasElement;
  const traceHead = el("div", { class: "trace-head" });
  const vsLine = el("div", { class: "bench-vs" });
  const spec = el("div", { class: "spec" });
  const calls = el("div");
  const testBtn = el("button", { class: "go" }, "練習で試しに走る ▶") as HTMLButtonElement;
  testBtn.addEventListener("click", () => {
    commitIfRunnable();
    go({ name: "practice", trackId: "aozu" });
  });
  const revNow = el("div", { class: "rev-now" });
  const revList = el("div", { class: "rev-list" });
  wrap.append(
    el(
      "div",
      { class: "stack" },
      el(
        "section",
        { class: "frame bom-frame" },
        el("div", { class: "section-title" }, el("h3", {}, "部品表"), el("span", { class: "label" }, "Parts · はじめの箱")),
        el(
          "table",
          { class: "bom" },
          el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "部品"), el("th", {}, "段"), el("th", { class: "r" }, "kg"), el("th", { class: "r" }, "残り"))),
          bomBody,
        ),
      ),
      el(
        "section",
        { class: "frame" },
        el("div", { class: "section-title" }, el("h3", {}, "性能 · 試走台"), el("span", { class: "label" }, "Spec · Test bench")),
        vsLine,
        bench,
        el("div", { class: "trace" }, traceHead, traceCanvas),
        spec,
        calls,
        el("div", { class: "spec-go" }, testBtn),
      ),
      el(
        "section",
        { class: "frame revs" },
        el("div", { class: "section-title" }, el("h3", {}, "改訂"), el("span", { class: "label" }, "Revisions")),
        revNow,
        revList,
      ),
    ),
  );

  let cell = 40;
  let dpr = 1;
  const layout = () => {
    const narrow = window.innerWidth <= 780;
    // スマホの横: マス目の横に部品の帯を縦に並べる (style.css)。高さいっぱいに
    const flat = narrow && window.innerHeight <= 500 && window.innerWidth > window.innerHeight;
    const vw = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
    const maxW = (flat ? vw - 260 : narrow ? vw - 72 : 440) - M.l - M.r;
    const maxH = (flat ? window.innerHeight - 16 : narrow ? window.innerHeight * 0.62 : window.innerHeight - 220) - M.t - M.b;
    cell = Math.max(24, Math.min(50, Math.floor(Math.min(maxW / GRID_W, maxH / GRID_H))));
    dpr = fitCanvas(canvas, M.l + cell * GRID_W + M.r, M.t + cell * GRID_H + M.b);
    strip.style.maxHeight = flat ? `${M.t + cell * GRID_H + M.b}px` : "";
    redraw();
  };

  const remaining = (): Record<string, number> => {
    const used = countParts(design);
    const out: Record<string, number> = {};
    for (const [id, n] of Object.entries(partBox())) out[id] = n - (used[id] ?? 0);
    return out;
  };

  const inkNow = (): Ink => {
    const p = palette();
    return { line: p.ink, fill: p.paper2, accent: p.accent };
  };

  const refreshBom = () => {
    bomBody.innerHTML = "";
    const stripX = strip.scrollLeft;
    const stripY = strip.scrollTop;
    strip.innerHTML = "";
    const rem = remaining();
    const kc = kindColors();
    for (const def of boxParts(partBox())) {
      const sel = selected === def.id;
      const out = rem[def.id] <= 0;
      const pick = () => {
        if (out && !sel) return;
        selected = sel ? null : def.id;
        redraw();
      };
      // 部品の帯の札
      const chipIcon = el("canvas") as HTMLCanvasElement;
      const ck = Math.min(9, 26 / Math.max(def.w, def.h, 1));
      const cw = Math.max(def.w, 1) * ck;
      const chh = Math.max(def.h, 1) * ck;
      const cdpr = fitCanvas(chipIcon, cw, chh);
      const cctx = chipIcon.getContext("2d")!;
      cctx.scale(cdpr, cdpr);
      drawPart(cctx, def, 0, 0, cw, chh, inkNow(), 1);
      const chip = el(
        "button",
        {
          class: `part-chip${sel ? " sel" : ""}${out && !sel ? " out" : ""}`,
          role: "option",
          "aria-selected": String(sel),
          title: def.note,
          style: `--kc:${kc[def.kind]}`,
        },
        el("span", { class: "pc-icon" }, chipIcon),
        el("span", { class: "pc-nm" }, def.name),
        el("span", { class: "pc-rem num" }, `×${rem[def.id]}`),
      ) as HTMLButtonElement;
      chip.disabled = out && !sel;
      chip.addEventListener("click", pick);
      strip.append(chip);
      const tr = el("tr", { class: `part${sel ? " sel" : ""}${out && !sel ? " out" : ""}`, title: def.note, style: `--kc:${kc[def.kind]}` });
      const icon = el("canvas") as HTMLCanvasElement;
      const k = Math.min(14, 40 / Math.max(def.w, def.h, 1));
      const iw = Math.max(def.w, 1) * k;
      const ih = Math.max(def.h, 1) * k;
      const idpr = fitCanvas(icon, iw, ih);
      const ictx = icon.getContext("2d")!;
      ictx.scale(idpr, idpr);
      drawPart(ictx, def, 0, 0, iw, ih, inkNow(), 1);
      tr.append(
        el("td", { style: "width:52px" }, icon),
        el(
          "td",
          {},
          el("div", { class: "nm" }, def.name, def.trait ? el("span", { class: "trait", title: `${TIRE_TRAITS[def.trait].up} / ${TIRE_TRAITS[def.trait].down}` }, TIRE_TRAITS[def.trait].name) : null),
          el("div", { class: "note" }, def.note),
        ),
        el("td", {}, el("span", { class: `tier${def.tier >= 3 ? " hi" : ""}` }, tierLabel(def))),
        el("td", { class: "num r" }, `${def.mass}`),
        el("td", { class: "r" }, el("span", { class: "rem" }, el("small", {}, "×"), String(rem[def.id]))),
      );
      tr.addEventListener("click", pick);
      bomBody.append(tr);
    }
    strip.scrollLeft = stripX;
    strip.scrollTop = stripY;
  };

  const meterRow = (k: string, v: string, frac: number | null, wide = false, delta: HTMLElement | null = null) => {
    const row = el("div", { class: `stat${wide ? " wide" : ""}` }, el("div", { class: "stat-head" }, el("span", {}, k), el("b", {}, v, delta)));
    if (frac !== null) {
      const bar = el("i", { style: `width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%` });
      row.append(el("div", { class: "meter" }, bar));
    }
    spec.append(row);
  };

  // ---- 試走台 ----
  interface Quick {
    st: CarStats;
    /** 最高速と 曲がりの速さ (km/h) */
    top: number;
    corner: number;
    ok: boolean;
  }
  /** 部品の並びから すぐ出せる数 (部品がなければ null) */
  const quick = (parts: Placed[]): Quick | null => {
    if (!parts.length) return null;
    const d: CarDesign = { name: "", parts };
    const st = computeStats(d);
    return { st, top: st.power > 0 ? st.topSpeed * 3.6 : 0, corner: cornerSpeed(st) * 3.6, ok: validateDesign(d).length === 0 };
  };

  // 1 周の見積もりは重いので、少し待ってから 1 コースずつ (画面が止まらないように) 計算して覚えておく
  let benchQueue: Array<{ key: string; parts: Placed[] }> = [];
  let benchTimer: number | undefined;
  let wanted = new Set<string>();
  let curKey = "";
  const benchDone = (set: BenchSet | undefined): set is BenchSet => !!set && TRACK_DEFS.every((t) => set[t.id]);
  const benchOf = (parts: Placed[]): BenchSet | null => {
    const key = partsKey(parts);
    wanted.add(key);
    const hit = benchCache.get(key);
    if (benchDone(hit)) return hit;
    if (!benchQueue.some((q) => q.key === key)) benchQueue.push({ key, parts: clone(parts) });
    if (benchTimer === undefined) benchTimer = window.setTimeout(runBench, BENCH_WAIT);
    return null;
  };
  const runBench = () => {
    benchTimer = undefined;
    benchQueue = benchQueue.filter((q) => wanted.has(q.key));
    // 今の形を先に
    benchQueue.sort((a, b) => Number(b.key === curKey) - Number(a.key === curKey));
    const job = benchQueue[0];
    if (!job) return;
    const set = benchCache.get(job.key) ?? {};
    const def = TRACK_DEFS.find((t) => !set[t.id]);
    if (def) {
      set[def.id] = benchLap(computeStats({ name: "", parts: job.parts }), getTrack(def.id));
      benchCache.delete(job.key);
      benchCache.set(job.key, set);
      while (benchCache.size > BENCH_CACHE) benchCache.delete(benchCache.keys().next().value!);
    }
    if (benchDone(set)) {
      benchQueue.shift();
      refreshBench();
    }
    if (benchQueue.length) benchTimer = window.setTimeout(runBench, 0);
  };

  const tile = (k: string, v: string | null, unit: string, d: HTMLElement | null, sub = "", cls = "") =>
    el(
      "div",
      { class: `tile${cls ? ` ${cls}` : ""}` },
      el("span", { class: "k" }, k),
      el("b", { class: `v${v === null ? " pending" : ""}` }, v ?? "計測中", v !== null && unit ? el("small", {}, unit) : null),
      el("div", { class: "foot" }, d, sub ? el("span", { class: "sub" }, sub) : null),
    );

  const refreshBench = () => {
    const cur = quick(design.parts);
    const refParts = compare ? compare.parts : prevParts;
    const ref = refParts && refParts.length ? quick(refParts) : null;
    wanted = new Set();
    curKey = partsKey(design.parts);
    vsLine.innerHTML = "";
    if (compare) {
      const off = el("button", { class: "small" }, "やめる");
      off.addEventListener("click", () => {
        compare = null;
        refreshBench();
        refreshRevs();
      });
      vsLine.append(el("span", {}, "差は ", el("b", { class: "rev-tag" }, revLabel(compare.n)), " と比べて"), off);
    } else {
      vsLine.append(el("span", {}, ref ? "差は 前の形 (最後に変える前) と比べて" : "部品を置くたびに 前の形との差が出ます"));
    }
    bench.innerHTML = "";
    if (!cur) {
      bench.append(el("div", { class: "empty" }, "部品を置くと 試走台の数が出ます"));
      drawTrace(null, null);
      return;
    }
    const cb = cur.ok ? benchOf(design.parts) : null;
    const rb = ref?.ok && refParts ? benchOf(refParts) : null;
    const dd = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);
    const kmh = (v: number) => `${Math.round(v)} km/h`;
    bench.append(
      tile("最高速", cur.top > 0 ? String(Math.round(cur.top)) : "—", "km/h", deltaChip(ref ? dd(cur.top, ref.top) : null, "up", kmh, 0.5)),
      tile(`曲がり 半径 ${BENCH_RADIUS} m`, String(Math.round(cur.corner)), "km/h", deltaChip(ref ? dd(cur.corner, ref.corner) : null, "up", kmh, 0.5)),
    );
    const fuelTrack = TRACK_DEFS.find((t) => t.id === FUEL_TRACK) ?? TRACK_DEFS[0];
    if (!cur.ok) {
      bench.append(tile(`燃料 1 周 · ${shortTrack(fuelTrack.name)}`, "—", "", null, "走れる形で出ます"));
      for (const t of TRACK_DEFS) bench.append(tile(shortTrack(t.name), "—", "", null, "走れる形で出ます", "lap"));
    } else {
      // 燃料は 走る前の準備やレースの画面と同じ見積もり (fuelPerMeter・setup.ts の fuelLaps) で出す
      const ft = getTrack(fuelTrack.id);
      const f = fuelPerMeter(cur.st) * ft.length;
      const fr = ref?.ok ? fuelPerMeter(ref.st) * ft.length : undefined;
      bench.append(
        tile(
          `燃料 1 周 · ${shortTrack(fuelTrack.name)}`,
          f.toFixed(2),
          "L",
          deltaChip(dd(f, fr), "down", (v) => `${v.toFixed(2)} L`, 0.005),
          `満タンで 約 ${fuelLaps(cur.st, ft, cur.st.fuelCap).toFixed(1)} 周`,
        ),
      );
      for (const t of TRACK_DEFS) {
        const lap = cb ? cb[t.id].lap : undefined;
        const lr = rb ? rb[t.id].lap : undefined;
        bench.append(
          tile(
            shortTrack(t.name),
            cb ? (lap === null || lap === undefined ? "—" : formatTime(lap)) : null,
            "",
            deltaChip(cb && rb ? dd(lap, lr) : null, "down", (v) => `${v.toFixed(3)} s`, 0.0005),
            cb ? (lap === null ? "走り切れません" : "予想タイム") : "",
            "lap",
          ),
        );
      }
    }
    drawTrace(cb ? cb[fuelTrack.id].trace : null, rb ? rb[fuelTrack.id].trace : null, shortTrack(fuelTrack.name), compare ? revLabel(compare.n) : "前");
  };

  /** 速さの線 (1 周の速さ。今 = 白、比べる相手 = 点線、速くなった所は緑・遅くなった所は赤) */
  const drawTrace = (cur: number[] | null, ref: number[] | null, trackName = "", refName = "前") => {
    traceHead.innerHTML = "";
    traceHead.append(
      el("span", {}, `速さ · ${trackName || "青図"} 1 周`),
      el("span", { class: "legend" }, el("i", { class: "cur" }), "今", ref ? el("i", { class: "ref" }) : null, ref ? refName : null),
    );
    const w = Math.max(200, Math.floor(traceCanvas.parentElement?.clientWidth || 300));
    const h = 84;
    const dpr = fitCanvas(traceCanvas, w, h);
    const ctx = traceCanvas.getContext("2d")!;
    const p = palette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const padT = 6;
    const padB = 14;
    const ph = h - padT - padB;
    const all = [...(cur ?? []), ...(ref ?? [])];
    const top = Math.max(50, Math.ceil((Math.max(0, ...all) * 3.6) / 50) * 50);
    const Y = (v: number) => padT + ph - ((v * 3.6) / top) * ph;
    // 目盛り (50 km/h ごと)
    ctx.font = "600 10px 'Barlow Condensed', sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let k = 50; k <= top; k += 50) {
      const y = padT + ph - (k / top) * ph;
      ctx.fillStyle = p.ghost;
      ctx.fillRect(0, Math.round(y), w, 1);
      ctx.fillStyle = p.dim;
      ctx.fillText(String(k), 2, y + 6);
    }
    ctx.fillStyle = p.faint;
    ctx.fillRect(0, padT + ph, w, 1);
    ctx.fillStyle = p.dim;
    ctx.textAlign = "right";
    ctx.fillText("km/h", w - 2, h - 6);
    if (!cur && !ref) {
      ctx.textAlign = "center";
      ctx.font = "500 12px 'Noto Sans JP', sans-serif";
      ctx.fillText(design.parts.length ? (runnable(design) ? "計測中…" : "走れる形になると出ます") : "", w / 2, padT + ph / 2);
      return;
    }
    const n = Math.max(cur?.length ?? 0, ref?.length ?? 0);
    const X = (i: number) => (i / Math.max(1, n - 1)) * w;
    // 速くなった所・遅くなった所
    if (cur && ref && cur.length === ref.length) {
      const bw = w / n + 0.5;
      for (let i = 0; i < n; i++) {
        const d = cur[i] - ref[i];
        if (Math.abs(d) < 0.3) continue;
        ctx.fillStyle = d > 0 ? p.good : p.bad;
        ctx.globalAlpha = 0.38;
        const y0 = Y(cur[i]);
        const y1 = Y(ref[i]);
        ctx.fillRect(X(i) - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0));
      }
      ctx.globalAlpha = 1;
    }
    const line = (vs: number[], color: string, width: number, dash: number[]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      vs.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (ref) line(ref, p.dim, 1.2, [3, 3]);
    if (cur) line(cur, p.ink, 1.6, []);
  };

  const refreshStats = () => {
    const errs = validateDesign(design);
    spec.innerHTML = "";
    calls.innerHTML = "";
    const any = design.parts.length > 0;
    if (!any) {
      spec.append(el("div", { class: "empty" }, "部品を置くと性能が出ます"));
    } else {
      const st = computeStats(design);
      const refParts = compare ? compare.parts : prevParts;
      const ref = refParts && refParts.length ? computeStats({ name: "", parts: refParts }) : null;
      meterRow("重さ", `${Math.round(st.mass)} kg`, st.mass / 600, false, deltaChip(ref ? st.mass - ref.mass : null, "down", (v) => `${Math.round(v)}`, 0.5));
      meterRow("力", `${Math.round(st.power)} kW`, st.power / 140, false, deltaChip(ref ? st.power - ref.power : null, "up", (v) => `${Math.round(v)}`, 0.5));
      meterRow("曲がりの握り", `${st.gripAccel.toFixed(1)} m/s²${st.downK ? " + 羽根" : ""}`, st.gripAccel / 15);
      meterRow("小回り", st.turnRate.toFixed(2), st.turnRate / 3.5);
      meterRow("ブレーキ", `${st.brake.toFixed(0)} m/s²`, st.brake / 20);
      meterRow("燃料", `${st.fuelCap} L · 全開 約 ${st.fuelRate > 0 ? Math.round(st.fuelCap / st.fuelRate) : 0} 秒`, st.fuelCap / 60, true);
      meterRow("重心", st.balance > 0.25 ? "前寄り (曲がりにくい)" : st.balance < -0.25 ? "後ろ寄り (後ろが滑りやすい)" : "まんなか", null, true);
      // 研究で開発する種類 (付いているときだけ)
      const dev: string[] = [];
      if (st.cool) dev.push(`冷却 燃料 −${Math.round(st.cool * 100)}%`);
      if (st.otExtra) dev.push(`電池 OT +${st.otExtra.toFixed(1)} 秒`);
      if (st.shiftBonus) dev.push(`ギア箱 MT +${(st.shiftBonus * 100).toFixed(1)}%`);
      if (st.susp) dev.push(`サス 縁石・芝 ${Math.round(st.susp * 100)}%`);
      if (dev.length) meterRow("研究の部品", dev.join(" · "), null, true);
      if (st.tireTraits?.length) {
        const row = el("div", { class: "stat wide traits" }, el("div", { class: "stat-head" }, el("span", {}, "タイヤの特徴")));
        const chips = el("div", { class: "trait-chips" });
        for (const t of st.tireTraits) {
          const d = TIRE_TRAITS[t.trait];
          chips.append(
            el(
              "span",
              { class: "trait-chip", title: `${d.up} / ${d.down}` },
              el("b", {}, d.name),
              el("small", { class: "num" }, `T${t.tier} · ${Math.round(t.share * 100)}%`),
              el("em", {}, `${d.up} / ${d.down}`),
            ),
          );
        }
        row.append(chips);
        spec.append(row);
      }
    }
    if (errs.length) for (const e of errs) calls.append(el("div", { class: "callout" }, e));
    else calls.append(el("div", { class: "callout ok" }, "走れます"));
    const short = Object.entries(remaining()).filter(([, n]) => n < 0);
    if (short.length) calls.append(el("div", { class: "callout" }, `持っている数より多く置いた部品: ${short.map(([id, n]) => `${anyPartDef(id)?.name ?? id} ${-n}`).join("・")}`));
    testBtn.disabled = errs.length > 0;
    const selDef = selected ? anyPartDef(selected) : undefined;
    hint.textContent = selDef
      ? `「${selDef.name}」${selDef.note}。置くマスを押してください (押したマスが部品の左上)。置いた部品を押すと外れます`
      : "部品を選んでください。置いた部品を押すと外れます";
    refreshBench();
  };

  // ---- 改訂 (版) ----
  const fmtDate = (ms: number) => {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const refreshRevs = () => {
    const list = revisionsOf(design);
    const curRev = currentRevision(design);
    const ok = runnable(design);
    revNow.innerHTML = "";
    const keep = el("button", { class: "small" }, "版を残す") as HTMLButtonElement;
    keep.disabled = !ok || !!curRev;
    keep.addEventListener("click", () => {
      commitRevision(design);
      refreshRevs();
    });
    revNow.append(
      el("span", { class: "label" }, "今の形"),
      el("b", { class: `rev-tag${curRev ? "" : " off"}` }, curRev ? revLabel(curRev.n) : ok ? "まだ残していない" : "走れない形"),
      keep,
    );
    revList.innerHTML = "";
    if (!list.length) {
      revList.append(el("div", { class: "empty" }, "走れる形を 版 (Rev.A・Rev.B…) として残します (練習に出る・ほかの設計図に替える・この画面を出るとき)。練習 (晴れ) の一番速い周が版ごとに付きます"));
      return;
    }
    const bestOf: Record<string, number> = {};
    for (const r of list) for (const [t, v] of Object.entries(r.best)) if (bestOf[t] === undefined || v < bestOf[t]) bestOf[t] = v;
    for (const rev of [...list].reverse()) {
      const q = quick(rev.parts);
      const isCur = rev === curRev;
      const laps = el("div", { class: "rev-laps" });
      for (const t of TRACK_DEFS) {
        const v = rev.best[t.id];
        laps.append(el("span", { class: "rev-lap" }, el("small", {}, shortTrack(t.name)), el("b", { class: `num${v !== undefined && v === bestOf[t.id] ? " best" : ""}` }, v === undefined ? "—" : formatTime(v))));
      }
      const vs = el("button", { class: `small${compare === rev ? " on" : ""}`, "aria-pressed": compare === rev ? "true" : "false" }, "比べる") as HTMLButtonElement;
      vs.disabled = isCur;
      vs.addEventListener("click", () => {
        compare = compare === rev ? null : rev;
        refreshStats();
        refreshRevs();
      });
      const back = el("button", { class: "small" }, "戻す") as HTMLButtonElement;
      back.disabled = isCur;
      back.addEventListener("click", () => {
        if (!confirm(`${revLabel(rev.n)} に戻しますか? (今の形は 走れる形なら版として残します)`)) return;
        commitIfRunnable();
        beforeEdit();
        design.parts = clone(rev.parts);
        compare = null;
        selected = null;
        save();
        redraw();
      });
      revList.append(
        el(
          "div",
          { class: `rev-row${isCur ? " cur" : ""}${compare === rev ? " vs" : ""}` },
          el("div", { class: "rev-id" }, el("b", {}, revLabel(rev.n)), el("small", {}, isCur ? "今の形" : fmtDate(rev.at))),
          laps,
          el(
            "div",
            { class: "rev-stats num" },
            q ? `${Math.round(q.top)} km/h · 曲がり ${Math.round(q.corner)} · ${Math.round(q.st.mass)} kg` : "",
          ),
          el("div", { class: "rev-act" }, vs, back),
        ),
      );
    }
  };

  /** 部品のある範囲 (マス)。研究の部品も入れる */
  const bounds = () => {
    let c0 = GRID_W;
    let r0 = GRID_H;
    let c1 = -1;
    let r1 = -1;
    for (const pl of design.parts) {
      for (const [c, r] of placedCells(pl)) {
        c0 = Math.min(c0, c);
        r0 = Math.min(r0, r);
        c1 = Math.max(c1, c + 1);
        r1 = Math.max(r1, r + 1);
      }
    }
    return c1 < 0 ? null : { c0, r0, c1, r1 };
  };

  /** マス目だけ描き直す (マウスを動かしたとき) */
  const drawBoard = () => {
    const ctx = canvas.getContext("2d")!;
    const p = palette();
    const ink = inkNow();
    const GW = cell * GRID_W;
    const GH = cell * GRID_H;
    const W = M.l + GW + M.r;
    const H = M.t + GH + M.b;
    const u = Math.max(1, cell / 24);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 前の印 (いちばん上)
    ctx.fillStyle = p.accent;
    ctx.font = "700 12px 'Barlow Condensed', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fx = M.l + GW / 2;
    ctx.beginPath();
    ctx.moveTo(fx - 26, 12);
    ctx.lineTo(fx - 20, 5);
    ctx.lineTo(fx - 14, 12);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = p.ink2;
    ctx.fillText("FRONT 前", fx + 8, 9);
    // 見出し (列 A-G・行 1-11)
    ctx.fillStyle = p.dim;
    ctx.font = "600 12px 'Barlow Condensed', sans-serif";
    for (let c = 0; c < GRID_W; c++) ctx.fillText(COLS[c], M.l + (c + 0.5) * cell, M.t - 10);
    ctx.textAlign = "right";
    for (let r = 0; r < GRID_H; r++) ctx.fillText(String(r + 1), M.l - 7, M.t + (r + 0.5) * cell);
    ctx.save();
    ctx.translate(M.l, M.t);
    // 台: 暗い面に、うすい市松
    ctx.fillStyle = "#08090d";
    ctx.fillRect(0, 0, GW, GH);
    ctx.fillStyle = p.ghost;
    for (let r = 0; r < GRID_H; r++) for (let c = (r & 1); c < GRID_W; c += 2) ctx.fillRect(c * cell, r * cell, cell, cell);
    // 中心線と中心の帯は出さない (11/25 ユーザー「設計するときの中心線なくそう」)
    // マス目
    ctx.strokeStyle = p.faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < GRID_W; c++) {
      ctx.moveTo(c * cell + 0.5, 0);
      ctx.lineTo(c * cell + 0.5, GH);
    }
    for (let r = 1; r < GRID_H; r++) {
      ctx.moveTo(0, r * cell + 0.5);
      ctx.lineTo(GW, r * cell + 0.5);
    }
    ctx.stroke();
    // 外枠 (左上の赤い角は 選んだマスの印に見えたのでなくした 11/25)
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-0.5, -0.5, GW + 1, GH + 1);

    drawDesignGrid(ctx, design, cell, ink, u);
    // 研究の部品 (段階 3〜5) は draw.ts の表にないので ここで描く
    for (const pl of design.parts) {
      if (partDef(pl.id)) continue;
      const def = anyPartDef(pl.id);
      if (!def) continue;
      const { w, h } = placedSize(pl, def);
      drawPart(ctx, def, pl.c * cell, pl.r * cell, w * cell, h * cell, ink, u);
    }

    // 置こうとしている部品の影
    if (hover && selected) {
      const def = anyPartDef(selected)!;
      const pl: Placed = { id: selected, c: hover.c, r: hover.r, rot };
      const ok = canPlace(design, pl) && (remaining()[selected] ?? 0) > 0;
      const { w, h } = placedSize(pl, def);
      ctx.globalAlpha = 0.8;
      drawPart(ctx, def, hover.c * cell, hover.r * cell, w * cell, h * cell, ink, u, ok ? {} : { tint: p.bad });
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ok ? p.ink : p.bad;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(hover.c * cell + 1, hover.r * cell + 1, w * cell - 2, h * cell - 2);
      ctx.setLineDash([]);
    }

    if (design.parts.length) {
      const st = computeStats(design);
      // 重心
      drawComMarker(ctx, st.comC * cell, st.comR * cell, Math.max(7, cell * 0.24), p);
      // 車の幅と長さ: 部品のある範囲の帯と札
      const b = bounds();
      if (b) {
        ctx.fillStyle = p.faint;
        ctx.fillRect(0, GH + 10, GW, 3);
        ctx.fillRect(GW + 10, 0, 3, GH);
        ctx.fillStyle = p.ink;
        ctx.fillRect(b.c0 * cell, GH + 10, (b.c1 - b.c0) * cell, 3);
        ctx.fillRect(GW + 10, b.r0 * cell, 3, (b.r1 - b.r0) * cell);
        ctx.font = "700 13px 'Barlow Condensed', 'Noto Sans JP', sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillStyle = p.ink2;
        ctx.fillText(`幅 ${((b.c1 - b.c0) * CELL).toFixed(1)} m`, ((b.c0 + b.c1) / 2) * cell, GH + 26);
        ctx.save();
        ctx.translate(GW + 26, ((b.r0 + b.r1) / 2) * cell);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(`長さ ${((b.r1 - b.r0) * CELL).toFixed(1)} m`, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  };

  const redraw = () => {
    drawBoard();
    refreshBom();
    refreshStats();
    refreshRevs();
  };

  const cellAt = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const c = Math.floor((ev.clientX - r.left - M.l) / cell);
    const rr = Math.floor((ev.clientY - r.top - M.t) / cell);
    if (c < 0 || c >= GRID_W || rr < 0 || rr >= GRID_H) return null;
    return { c, r: rr };
  };

  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerType !== "mouse") return;
    const h = cellAt(ev);
    if (h?.c !== hover?.c || h?.r !== hover?.r) {
      hover = h;
      drawBoard();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    drawBoard();
  });
  canvas.addEventListener("pointerdown", (ev) => {
    const at = cellAt(ev);
    if (!at) return;
    const occ = occupancy(design);
    const idx = occ[at.r * GRID_W + at.c];
    if (idx !== -1) {
      // 置いた部品を外す (その部品を選んだ状態にする)
      beforeEdit();
      const removed = design.parts.splice(idx, 1)[0];
      selected = removed.id;
      setRot(removed.rot);
    } else if (selected) {
      const pl: Placed = { id: selected, c: at.c, r: at.r, rot };
      if (canPlace(design, pl) && (remaining()[selected] ?? 0) > 0) {
        beforeEdit();
        design.parts.push(pl);
        if ((remaining()[selected] ?? 0) <= 0) selected = null;
      }
    }
    save();
    redraw();
  });

  const onKey = (ev: KeyboardEvent) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.key === "r" || ev.key === "R") setRot(rot ? 0 : 1);
    if (ev.key === "Escape") {
      selected = null;
      redraw();
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", layout);

  refreshList();
  layout();
  document.fonts?.ready.then(() => redraw());
  // ログインしていれば、持っている部品の数で作る (していなければ はじめの部品の箱)
  refreshAccount()
    .then(() => {
      refreshBom();
      redraw();
    })
    .catch(() => {});

  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", layout);
    if (benchTimer !== undefined) clearTimeout(benchTimer);
    // この画面を出るとき、走れる形なら版として残す
    if (s.designs.includes(design)) commitIfRunnable();
  };
}
