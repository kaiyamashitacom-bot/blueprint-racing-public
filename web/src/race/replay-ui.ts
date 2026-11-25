// 走った線を図面に重ねる (中身は shared/src/replay.ts)。
// コースの形の上に、自分の走った線を速さの色 (遅い = 青 → 速い = 黄) で描き、ブレーキを踏み始めた所に赤い印を付ける。
// 周を選べる (一番速い周は紫)。ネットのレースは結果の札から、練習は走っている間の「走った線」ボタンから開く。
import { brakePoints, decimate, formatSector, formatTime, idealLap, normalAt, pointAt, replayLaps, replaySamples, sectorSplitDistances, speedRange, type ReplayBuffer, type ReplaySample, type Track } from "@bpr/shared";
import { el } from "../ui/dom.ts";
import { trackPaths } from "./trackdraw.ts";

/** 遅い → 速い の色 (中継の速さの図のように。赤はブレーキの印に使うので入れない) */
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [46, 120, 255]],
  [0.45, [46, 197, 255]],
  [0.75, [120, 230, 140]],
  [1, [255, 210, 31]],
];

export function speedColor(k: number): string {
  const x = Math.max(0, Math.min(1, k));
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i];
    const [a, ca] = STOPS[i - 1];
    if (x <= b) {
      const u = (x - a) / (b - a);
      const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * u));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(255,210,31)";
}

/** 周の選び方: 周の番号、または全部 (-1) */
type LapPick = number;
const ALL = -1;

export interface ReplayPanel {
  close(): void;
}

/**
 * 走った線の札を開く (host の上にかぶせる)。閉じるボタン・Esc・外を押すと閉じる。
 * 走っている途中でも開ける (開いたときの記録を描く。練習は「新しくする」で描き直す)
 */
export function openReplay(host: HTMLElement, track: Track, get: () => ReplayBuffer | null, opts: { title?: string; onClose?: () => void } = {}): ReplayPanel {
  const layer = el("div", { class: "overlay replay-layer" });
  const canvas = el("canvas", { class: "rp-canvas" }) as HTMLCanvasElement;
  const laps = el("div", { class: "rp-laps" });
  // 選んだ周のセクターのタイム (走った周の中で一番速い区間は紫)
  const secs = el("div", { class: "rp-secs" });
  const info = el("div", { class: "rp-info" });
  const legend = el(
    "div",
    { class: "rp-legend" },
    el("span", { class: "rp-grad" }, el("small", { class: "num rp-min" }), el("i"), el("small", { class: "num rp-max" })),
    el("span", { class: "rp-key" }, el("i", { class: "rp-tick" }), "ブレーキ"),
  );
  const close = el("button", { class: "small ghost" }, "閉じる");
  const refresh = el("button", { class: "small ghost" }, "新しくする");
  const frame = el(
    "div",
    { class: "frame bc-frame rp-frame" },
    el("div", { class: "bc-head" }, el("h3", {}, "LINE", el("small", {}, "走った線")), el("div", { class: "bc-sub" }, el("b", {}, opts.title ?? track.def.name), el("span", { class: "label" }, "速さの色とブレーキの所"))),
    laps,
    secs,
    el("div", { class: "rp-stage" }, canvas),
    el("div", { class: "rp-foot" }, legend, info),
    el("div", { class: "bc-actions" }, refresh, close),
  );
  layer.append(frame);
  host.append(layer);

  let pick: LapPick | null = null;
  let buf: ReplayBuffer | null = null;

  const done = () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", draw);
    layer.remove();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done();
    }
  };
  close.addEventListener("click", done);
  refresh.addEventListener("click", () => load());
  layer.addEventListener("pointerdown", (e) => {
    if (e.target === layer) done();
  });
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", draw);

  function load() {
    buf = get();
    const list = buf ? replayLaps(buf) : [];
    // はじめは 最後に走り終えた周 (なければ今の周)
    if (pick === null || (pick !== ALL && !list.some((l) => l.lap === pick))) {
      const full = list.filter((l) => l.time !== null);
      pick = (full[full.length - 1] ?? list[list.length - 2] ?? list[list.length - 1])?.lap ?? ALL;
    }
    renderLaps();
    draw();
  }

  function renderLaps() {
    laps.innerHTML = "";
    const list = buf ? replayLaps(buf) : [];
    const best = list.reduce<number | null>((m, l) => (l.time !== null && (m === null || l.time < m) ? l.time : m), null);
    const chip = (p: LapPick, label: string, sub: string, cls = "") => {
      const b = el("button", { class: `rp-chip${pick === p ? " on" : ""}${cls}` }, el("b", {}, label), sub ? el("span", { class: "num" }, sub) : null);
      b.addEventListener("click", () => {
        pick = p;
        renderLaps();
        draw();
      });
      laps.append(b);
    };
    for (const l of list) chip(l.lap, `L${l.lap + 1}`, l.time === null ? (l.lap === 0 ? "スタート" : "走行中") : formatTime(l.time), l.time !== null && l.time === best ? " best" : "");
    if (list.length > 1) chip(ALL, "全部", "");
    renderSectors();
  }

  /** セクターのタイム: 周を選んだらその周、全部なら走った周の中の一番速い区間と合計 */
  function renderSectors() {
    secs.innerHTML = "";
    const rec = buf?.sectors;
    if (!rec || !Object.keys(rec).length) {
      secs.hidden = true;
      return;
    }
    secs.hidden = false;
    const best: Array<number | null> = [null, null, null];
    for (const v of Object.values(rec)) v.forEach((x, k) => x !== null && (best[k] === null || x < best[k]!) && (best[k] = x));
    const row = pick === ALL || pick === null ? best : (rec[pick] ?? [null, null, null]);
    for (let k = 0; k < 3; k++) {
      const v = row[k] ?? null;
      secs.append(el("span", { class: `rp-sec${v !== null && v === best[k] ? " best" : ""}` }, el("b", {}, `S${k + 1}`), el("span", { class: "num" }, formatSector(v))));
    }
    if (pick === ALL || pick === null) secs.append(el("span", { class: "rp-sec ideal" }, el("b", {}, "IDEAL"), el("span", { class: "num" }, formatTime(idealLap(best)))));
  }

  function draw() {
    const stage = canvas.parentElement!;
    const paths = trackPaths(track);
    const bx = paths.bounds;
    const pad = 14;
    const tw = bx.maxX - bx.minX;
    const th = bx.maxY - bx.minY;
    // 横幅に合わせ、高さは画面の高さの残りまで
    const availW = Math.max(200, stage.clientWidth);
    const availH = Math.max(160, Math.min(window.innerHeight * 0.62, window.innerHeight - 230));
    const sc = Math.min((availW - pad * 2) / tw, (availH - pad * 2) / th);
    const cw = Math.round(tw * sc + pad * 2);
    const chh = Math.round(th * sc + pad * 2);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${chh}px`;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(chh * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, chh);
    // 図面のマス目
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;
    for (let x = 0.5; x < cw; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, chh);
      ctx.stroke();
    }
    for (let y = 0.5; y < chh; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cw, y);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(pad - bx.minX * sc, pad - bx.minY * sc);
    ctx.scale(sc, sc);
    const px = 1 / sc;
    // コース: 道の面・縁の線・スタートの線
    ctx.fillStyle = "rgba(58,63,72,0.75)";
    ctx.fill(paths.asphalt, "evenodd");
    ctx.strokeStyle = "rgba(238,241,245,0.55)";
    ctx.lineWidth = 1.2 * px;
    ctx.stroke(paths.edges);
    ctx.strokeStyle = "rgba(238,241,245,0.2)";
    ctx.lineWidth = 1 * px;
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.stroke(paths.pitLane);
    ctx.setLineDash([]);
    ctx.fillStyle = "#eef1f5";
    ctx.fill(paths.startA);
    // セクターの切れ目 (黄の線)
    const splitAt = sectorSplitDistances(track).map((d) => pointAt(track, d, 0));
    ctx.strokeStyle = "#ffd21f";
    ctx.lineWidth = Math.max(1.5, 2 * px);
    for (const p of splitAt) {
      const [nx, ny] = normalAt(track, p.index);
      const h = track.def.halfWidth + 3;
      ctx.beginPath();
      ctx.moveTo(p.x - nx * h, p.y - ny * h);
      ctx.lineTo(p.x + nx * h, p.y + ny * h);
      ctx.stroke();
    }

    const all = buf ? replaySamples(buf, pick === ALL || pick === null ? undefined : pick) : [];
    const range = speedRange(all);
    const lw = Math.max(2, Math.min(4, track.def.halfWidth * 0.5 * sc)) * px;
    // 周ごとに分けて描く (全部のときに周の変わり目を線でつながない)
    const byLap = new Map<number, ReplaySample[]>();
    for (const s of all) {
      const a = byLap.get(s.lap);
      if (a) a.push(s);
      else byLap.set(s.lap, [s]);
    }
    let ticks = 0;
    ctx.lineCap = "round";
    for (const seg of byLap.values()) {
      const pts = decimate(seg, Math.max(0.5, 2.5 * px));
      // ブレーキの区間: 下に赤い太い線
      ctx.strokeStyle = "rgba(255,59,59,0.55)";
      ctx.lineWidth = lw * 2.2;
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i].brake) continue;
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      // 速さの色の線
      ctx.lineWidth = lw;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (Math.hypot(b.x - a.x, b.y - a.y) > 40) continue; // ピットや記録の切れ目
        ctx.strokeStyle = speedColor(((a.v + b.v) / 2 - range.min) / (range.max - range.min));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // ブレーキの踏み始め: 走る向きに直角な赤い印
      const half = (track.def.halfWidth + 1.5) * 1;
      ctx.strokeStyle = "#ff3b3b";
      ctx.lineWidth = Math.max(2, 2.5 * px);
      ctx.lineCap = "butt";
      for (const b of brakePoints(seg)) {
        ticks++;
        const nx = -Math.sin(b.dir);
        const ny = Math.cos(b.dir);
        ctx.beginPath();
        ctx.moveTo(b.x - nx * half, b.y - ny * half);
        ctx.lineTo(b.x + nx * half, b.y + ny * half);
        ctx.stroke();
      }
      ctx.lineCap = "round";
    }
    // 曲がりの番号
    ctx.restore();
    ctx.fillStyle = "rgba(243,245,248,0.7)";
    ctx.font = `700 11px ${getComputedStyle(document.body).getPropertyValue("--f-num") || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const c of paths.corners) ctx.fillText(c.label, pad + (c.x - bx.minX) * sc, pad + (c.y - bx.minY) * sc);
    // セクターの切れ目の名前 (道の外側に)
    ctx.fillStyle = "#ffd21f";
    splitAt.forEach((p, k) => {
      const [nx, ny] = normalAt(track, p.index);
      const o = (track.def.halfWidth + 3) * sc + 12;
      ctx.fillText(`S${k + 2}`, pad + (p.x - bx.minX) * sc + nx * o, pad + (p.y - bx.minY) * sc + ny * o);
    });

    (legend.querySelector(".rp-min") as HTMLElement).textContent = all.length ? `${Math.round(range.min * 3.6)}` : "–";
    (legend.querySelector(".rp-max") as HTMLElement).textContent = all.length ? `${Math.round(range.max * 3.6)} km/h` : "–";
    info.textContent = all.length ? `ブレーキ ${ticks} か所` : "まだ記録がありません (1 周走ると出ます)";
  }

  load();
  // 札が並んでから大きさを合わせ直す
  requestAnimationFrame(() => draw());
  return { close: done };
}

/** 走った線を開くボタン (結果の札などに置く) */
export function replayButton(host: HTMLElement, track: Track, get: () => ReplayBuffer | null, label = "走った線", onOpen?: (panel: ReplayPanel) => void): HTMLElement {
  const b = el("button", { class: "small ghost rp-open" }, label);
  b.addEventListener("click", () => {
    const panel = openReplay(host, track, get);
    onOpen?.(panel);
  });
  return b;
}

/**
 * 練習で使う: 1 周走り終えたら画面の右上 (地図と天気の下) に「走った線」ボタンを出す。
 * get は今の記録 (走り直すと変わる)。destroy で消す
 */
export class ReplayDock {
  private btn: HTMLElement;
  private timer = 0;
  private panel: ReplayPanel | null = null;

  constructor(
    private host: HTMLElement,
    private track: Track,
    private get: () => ReplayBuffer | null,
    /** 札を開いた・閉じたとき (練習は走りを止めておく) */
    private hooks: { onOpen?: () => void; onClose?: () => void } = {},
  ) {
    this.btn = el("button", { class: "rp-dock", tabindex: "-1" }, el("b", {}, "LINE"), el("span", {}, "走った線"));
    this.btn.style.display = "none";
    this.btn.addEventListener("click", () => {
      this.btn.blur();
      this.panel?.close();
      this.hooks.onOpen?.();
      this.panel = openReplay(this.host, this.track, this.get, {
        onClose: () => {
          this.panel = null;
          this.hooks.onClose?.();
        },
      });
    });
    host.append(this.btn);
    this.timer = window.setInterval(() => this.update(), 500);
  }

  private update() {
    const buf = this.get();
    const ok = !!buf && replayLaps(buf).some((l) => l.lap >= 1);
    this.btn.style.display = ok ? "" : "none";
    if (!ok) return;
    // 地図と天気の下に置く
    const side = this.host.querySelector<HTMLElement>(".hud .side");
    if (side) {
      const r = side.getBoundingClientRect();
      const hr = this.host.getBoundingClientRect();
      this.btn.style.top = `${Math.round(r.bottom - hr.top + 6)}px`;
    }
  }

  destroy() {
    clearInterval(this.timer);
    this.panel?.close();
    this.btn.remove();
  }
}
