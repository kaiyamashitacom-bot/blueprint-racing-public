// オープニング (ゲームを開いたときの画面。DECISIONS 11/25「オープン画面作ろう」)。
// 設計図の紙に白い線が引かれて上から見た車の図面になり (寸法の線つき)、題名 BLUEPRINT RACING、「タップしてスタート」。
// 絵は SVG の線だけ (画像・外の道具なし)。動きは requestAnimationFrame で opening_plan.ts の時間の割り付けどおり。
// 押す・キー 1 回目 = 最後の形へ飛ぶ、2 回目 (または出そろったあとの 1 回目) = ゲームへ (曲はこの押したときに main.ts の go が鳴らす)。
// 隅: 左上 版・右上 ログインの名前 (無ければ「ログイン / 登録」)・下 管理者のお知らせ 1 行 (読めたら出す。待たない)
import { cachedMe, isLoggedIn, onAccountChange } from "../api.ts";
import { announcement, loadRaceRules } from "../race_rules.ts";
import { APP_VERSION, BUILD_ID } from "../version.ts";
import { el } from "./dom.ts";
import {
  DIM_AT,
  DIM_DUR,
  LINE_DUR,
  LINE_START,
  LINE_STEP,
  PROMPT_AT,
  PROMPT_DUR,
  RULE_AT,
  RULE_DUR,
  TITLE_AT,
  TITLE_DUR,
  isSkipKey,
  openingLength,
  progress,
  promptText,
  timeScale,
  type OpeningPlan,
} from "./opening_plan.ts";
import "./opening.css";

// ---------------------------------------------------------------- 図面 (400 × 700 の紙の上。上が車の前)

const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
const oval = (cx: number, cy: number, rx: number, ry: number) => `M${cx} ${cy - ry}A${rx} ${ry} 0 1 1 ${cx} ${cy + ry}A${rx} ${ry} 0 1 1 ${cx} ${cy - ry}Z`;

/** 車の線 (引く順): 胴・鼻・前の羽根・前のタイヤ・腕・運転席・横の箱・後ろのタイヤ・後ろの羽根 */
const CAR_LINES: readonly string[] = [
  "M180 205C160 262 132 300 132 380L132 520C132 562 162 592 200 592C238 592 268 562 268 520L268 380C268 300 240 262 220 205Z",
  "M186 66L181 205L219 205L214 66Z",
  rr(58, 38, 284, 28, 3),
  "M58 52L40 52M342 52L360 52",
  rr(70, 112, 52, 92, 8),
  rr(278, 112, 52, 92, 8),
  "M122 140L183 168M122 178L182 196M278 140L217 168M278 178L218 196",
  oval(200, 330, 25, 48),
  "M176 300Q200 280 224 300",
  rr(104, 362, 36, 118, 10),
  rr(260, 362, 36, 118, 10),
  "M200 384L200 572M178 420L222 420M178 470L222 470M178 520L222 520",
  rr(54, 470, 62, 108, 9),
  rr(284, 470, 62, 108, 9),
  "M116 500L134 506M116 548L136 540M284 500L266 506M284 548L264 540",
  rr(94, 612, 212, 34, 3),
  "M150 612L172 592M250 612L228 592",
];
/** 寸法の線 (幅・長さ) */
const DIM_LINES: readonly string[] = ["M40 670L360 670M40 662L40 678M360 662L360 678", "M380 38L380 646M372 38L388 38M372 646L388 646"];

function carSvg(): string {
  const s = CAR_LINES.map((d) => `<path class="op-s" d="${d}"/>`).join("");
  const d = DIM_LINES.map((x) => `<path class="op-d" d="${x}"/>`).join("");
  return (
    `<svg class="op-car" viewBox="0 0 400 700" aria-hidden="true"><g class="op-draw">${s}</g><g class="op-dims">${d}` +
    `<text x="200" y="694" text-anchor="middle">2.8 m</text>` +
    `<text x="394" y="342" text-anchor="middle" transform="rotate(90 394 342)">4.4 m</text>` +
    `<text x="6" y="22">BPR-01 · FIG.1</text></g></svg>`
  );
}

export interface OpeningOpts {
  plan: Exclude<OpeningPlan, "none">;
  /** 押して入る (2 回目) */
  onEnter: () => void;
  /** 右上の「ログイン / 登録」 */
  onLogin: () => void;
}

export function mountOpening(root: HTMLElement, opts: OpeningOpts): () => void {
  const k = timeScale(opts.plan);
  const fine = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;

  const art = el("div", { class: "op-art" });
  art.innerHTML = carSvg();
  const logo = el("div", { class: "op-logo" }, el("span", { class: "op-bpr" }, "BPR"), el("span", { class: "op-name" }, "BLUEPRINT ", el("em", {}, "RACING")));
  const rule = el("div", { class: "op-rule" });
  const prompt = el("div", { class: "op-prompt" }, promptText(!fine));
  const title = el("div", { class: "op-title" }, el("h1", { class: "op-h1" }, logo), rule, prompt);

  // 隅
  const who = el("div", { class: "op-corner op-who" });
  const news = el("div", { class: "op-news", role: "status" });
  news.hidden = true;
  const ver = el("div", { class: "op-corner op-ver num" }, `${APP_VERSION} · ${BUILD_ID}`);

  const box = el(
    "div",
    { class: "op", role: "button", tabindex: "0", "aria-label": `Blueprint Racing — ${promptText(!fine)}` },
    el("div", { class: "op-paper", "aria-hidden": "true" }, el("div", { class: "op-grid" })),
    el("div", { class: "op-top" }, ver, who),
    el("div", { class: "op-stage" }, art, title),
    news,
  );
  root.append(box);

  // ---------------------------------------------------------------- 隅の中身
  let alive = true;
  const paintWho = () => {
    who.innerHTML = "";
    if (isLoggedIn()) {
      const me = cachedMe();
      if (me) who.append(el("span", { class: "label" }, "Driver"), el("b", {}, me.driver));
      return;
    }
    const b = el("button", { class: "op-link", type: "button" }, "ログイン / 登録") as HTMLButtonElement;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onLogin();
    });
    who.append(b);
  };
  paintWho();
  const offAcct = onAccountChange(paintWho);
  // お知らせ: 読めたら出す (はじめの絵は待たない)
  loadRaceRules().then(() => {
    const a = announcement();
    if (!alive || !a) return;
    news.replaceChildren(el("span", { class: "op-news-tag" }, "お知らせ"), el("span", { class: "op-news-text" }, a));
    news.hidden = false;
  });

  // ---------------------------------------------------------------- 動き
  const lines = [...art.querySelectorAll<SVGPathElement>(".op-s")];
  const dims = [...art.querySelectorAll<SVGPathElement>(".op-d")];
  const dimTexts = [...art.querySelectorAll<SVGTextElement>("text")];
  const svg = art.querySelector<SVGSVGElement>("svg")!;
  const lens = new Map<SVGPathElement, number>();
  for (const p of [...lines, ...dims]) {
    let n = 1000;
    try {
      n = p.getTotalLength() || n;
    } catch {
      /* 長さが取れなければ大きめに */
    }
    lens.set(p, n);
    p.style.strokeDasharray = `${n} ${n}`;
  }
  const draw = (p: SVGPathElement, u: number) => {
    const n = lens.get(p)!;
    p.style.strokeDashoffset = String(n * (1 - u));
    p.style.opacity = u > 0 ? "1" : "0";
  };
  const length = openingLength(lines.length, opts.plan);
  let raf = 0;
  let t0 = 0;
  let done = false;

  const render = (t: number) => {
    lines.forEach((p, i) => draw(p, progress(t, LINE_START + i * LINE_STEP, LINE_DUR, k)));
    const du = progress(t, DIM_AT, DIM_DUR, k);
    dims.forEach((p) => draw(p, du));
    const tu = progress(t, DIM_AT + 0.2, DIM_DUR, k);
    for (const x of dimTexts) x.style.opacity = String(tu);
    // 書いているあいだは少し寄っていて、引いて止まる
    svg.style.transform = `scale(${1.05 - 0.05 * progress(t, 0, TITLE_AT, k)})`;
    const lu = progress(t, TITLE_AT, TITLE_DUR, k);
    logo.style.opacity = String(lu);
    logo.style.clipPath = `inset(0 ${(1 - lu) * 100}% 0 0)`;
    logo.style.transform = `translateX(${(1 - lu) * -6}%) skewX(${(1 - lu) * -8}deg)`;
    rule.style.transform = `scaleX(${progress(t, RULE_AT, RULE_DUR, k)})`;
    const pu = progress(t, PROMPT_AT, PROMPT_DUR, k);
    prompt.style.opacity = String(pu);
    prompt.style.transform = `translateY(${(1 - pu) * 40}%)`;
    box.style.setProperty("--op-shade", String(0.45 * lu));
  };
  const finish = () => {
    done = true;
    cancelAnimationFrame(raf);
    render(Number.POSITIVE_INFINITY);
    box.classList.add("op-done");
  };
  const frame = (now: number) => {
    if (!t0) t0 = now;
    const t = (now - t0) / 1000;
    if (t >= length) return finish();
    render(t);
    raf = requestAnimationFrame(frame);
  };
  if (length <= 0) finish();
  else {
    render(0);
    raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- 押す
  let entered = false;
  const press = () => {
    if (entered) return;
    if (!done) return finish();
    entered = true;
    opts.onEnter();
  };
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0) return;
    press();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || !isSkipKey(e.key)) return;
    if ((e.target as Element | null)?.closest?.(".op-link")) return; // 右上の「ログイン」に指したまま Enter はそのボタン
    e.preventDefault();
    press();
  };
  box.addEventListener("click", onClick);
  window.addEventListener("keydown", onKey);
  box.focus({ preventScroll: true });

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    box.removeEventListener("click", onClick);
    window.removeEventListener("keydown", onKey);
    offAcct();
  };
}
