// チーム・運転手・研究・市場の画面で共通に使うもの: 上の見出しと切りかえ、知らせの印、ログインしていないときの札、紋章の絵、時間の書き方
import type { Emblem } from "@bpr/shared";
import * as api from "../api.ts";
import * as tapi from "../team_api.ts";
import type { Go, Screen } from "../main.ts";
import { el } from "./dom.ts";
import { money } from "./account.ts";
import "./account.css";
import "./team.css";

export type TeamTab = "team" | "drivers" | "research" | "market";

const TABS: Array<[TeamTab, string, string]> = [
  ["team", "チーム", "Team"],
  ["drivers", "運転手", "Drivers"],
  ["research", "研究", "R&D"],
  ["market", "市場", "Market"],
];

/** 画面の台と見出し (もどる・題・切りかえ・財布・知らせ)。body に中身を入れる */
export function teamSheet(root: HTMLElement, go: Go, tab: TeamTab): { sheet: HTMLElement; body: HTMLElement; wallet: HTMLElement; bell: HTMLButtonElement } {
  const sheet = el("div", { class: "sheet acc tm" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  const wallet = el("span", { class: "tm-wallet" });
  const bell = noticeBell(go);
  const title = TABS.find((t) => t[0] === tab)!;
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, title[1]), el("span", { class: "label" }, title[2]), wallet, bell));
  const nav = el("nav", { class: "tm-nav", "aria-label": "チームの画面" });
  for (const [name, jp] of TABS) {
    const b = el("button", { class: name === tab ? "on" : "", "aria-current": name === tab ? "page" : "" }, jp) as HTMLButtonElement;
    b.addEventListener("click", () => go({ name } as Screen));
    nav.append(b);
  }
  sheet.append(nav);
  const body = el("div", { class: "tm-body" });
  sheet.append(body);
  paintWallet(wallet, api.cachedMe()?.money ?? null);
  return { sheet, body, wallet, bell };
}

export function paintWallet(w: HTMLElement, m: number | null, held = 0) {
  w.innerHTML = "";
  if (m === null) return;
  w.append(el("span", { class: "label" }, "財布"), el("b", { class: "tm-num" }, money(m)));
  if (held > 0) w.append(el("small", { class: "dim" }, `競りに預け中 ${money(held)}`));
}

/** お金が足りないときのわけ (例「お金が足りない (あと 2,310)」)。足りていれば null */
export function shortOfMoney(cost: number, have: number): string | null {
  return cost > have ? `お金が足りない (あと ${money(cost - have)})` : null;
}

/**
 * 押せないボタンには わけを付ける: わけがあれば押せなくし、title にも入れて、ボタンの横に出す札を返す (なければ null)。
 * 前の札 (prev) があれば中身を入れ替える
 */
export function whyNot(b: HTMLButtonElement, reason: string | null, prev?: HTMLElement | null): HTMLElement | null {
  b.disabled = !!reason;
  b.title = reason ?? "";
  const tag = prev ?? el("span", { class: "tm-why" });
  tag.textContent = reason ?? "";
  tag.hidden = !reason;
  return reason || prev ? tag : null;
}

/** ログインしていないときの札 */
export function loginGate(go: Go): HTMLElement {
  const b = el("button", { class: "go" }, "ログイン・はじめる");
  b.addEventListener("click", () => go({ name: "account" }));
  return el("div", { class: "frame tm-gate" }, el("p", {}, "ログインすると使えます"), el("div", { class: "row" }, b));
}

/** 知らせのベル (まだ見ていない数の印つき)。押すと知らせの札が開く */
export function noticeBell(go: Go): HTMLButtonElement {
  const b = el("button", { class: "small tm-bell", "aria-label": "知らせ" }, "知らせ") as HTMLButtonElement;
  const badge = el("span", { class: "tm-badge" });
  badge.hidden = true;
  b.append(badge);
  const paint = (n: number) => {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n <= 0;
    b.setAttribute("aria-label", n > 0 ? `知らせ (まだ見ていない ${n})` : "知らせ");
  };
  if (!api.isLoggedIn()) {
    b.hidden = true;
    return b;
  }
  tapi
    .fetchNotices()
    .then((r) => paint(r.unread))
    .catch(() => {});
  b.addEventListener("click", () => openNotices(go, paint));
  (b as HTMLButtonElement & { paint?: (n: number) => void }).paint = paint;
  return b;
}

/** ベルの数を描き直す */
export function setBell(bell: HTMLButtonElement, n: number) {
  (bell as HTMLButtonElement & { paint?: (n: number) => void }).paint?.(n);
}

/** 知らせの札 (下から出る)。開いたら全部見たことにする */
function openNotices(go: Go, paint: (n: number) => void) {
  document.querySelector(".tm-sheet-bg")?.remove();
  const list = el("div", { class: "tm-notices" }, el("div", { class: "dim" }, "読みこんでいます…"));
  const close = el("button", { class: "small" }, "閉じる");
  const panel = el("div", { class: "tm-sheet", role: "dialog", "aria-label": "知らせ" }, el("div", { class: "section-title" }, el("h3", {}, "知らせ"), el("span", { class: "label" }, "Notices"), close), list);
  const bg = el("div", { class: "tm-sheet-bg" }, panel);
  const shut = () => bg.remove();
  close.addEventListener("click", shut);
  bg.addEventListener("click", (e) => {
    if (e.target === bg) shut();
  });
  document.body.append(bg);
  tapi
    .fetchNotices()
    .then(async (r) => {
      list.innerHTML = "";
      if (!r.notices.length) list.append(el("div", { class: "dim" }, "知らせはまだありません"));
      for (const n of r.notices) {
        const to = noticeScreen(n.kind);
        const row = el(
          "button",
          { class: `tm-notice${n.read ? "" : " new"}` },
          el("span", { class: "t" }, n.title),
          el("span", { class: "x" }, n.text),
          el("span", { class: "when tm-num" }, ago(n.at)),
        );
        row.addEventListener("click", () => {
          shut();
          if (to) go(to);
        });
        list.append(row);
      }
      if (r.unread > 0) {
        await tapi.readNotices().catch(() => {});
        paint(0);
      }
    })
    .catch((e) => {
      list.innerHTML = "";
      list.append(el("div", { class: "bad" }, e instanceof Error ? e.message : "読めませんでした"));
    });
}

function noticeScreen(kind: string): Screen | null {
  if (kind === "research_done") return { name: "research" };
  if (kind.startsWith("contract")) return { name: "drivers" };
  return { name: "market" };
}

/** 何分前・何時間前 */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "今";
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 時間前`;
  return `${Math.floor(s / 86400)} 日前`;
}

/** 残り時間 (例 5:42:10・2 日 3 時間) */
export function left(ms: number): string {
  if (ms <= 0) return "まもなく";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 日 ${h} 時間`;
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- 紋章 (SVG)

const SVG = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const SHAPES: Record<string, string> = {
  circle: "M50 4 A46 46 0 1 1 49.9 4 Z",
  square: "M8 8 H92 V92 H8 Z",
  shield: "M50 4 L92 16 V48 C92 74 72 90 50 97 C28 90 8 74 8 48 V16 Z",
  diamond: "M50 3 L97 50 L50 97 L3 50 Z",
  hexagon: "M27 7 H73 L96 50 L73 93 H27 L4 50 Z",
  triangle: "M50 5 L96 92 H4 Z",
};

const MARKS: Record<string, (c: string) => SVGElement[]> = {
  none: () => [],
  star: (c) => [svg("path", { d: "M50 22 L57.6 41.6 L78.5 42.2 L62 55 L67.6 75.3 L50 63.6 L32.4 75.3 L38 55 L21.5 42.2 L42.4 41.6 Z", fill: c })],
  bolt: (c) => [svg("path", { d: "M56 18 L32 54 H48 L42 82 L68 44 H52 Z", fill: c })],
  stripe: (c) => [svg("path", { d: "M20 64 L64 20 H80 L36 80 H20 Z", fill: c })],
  cross: (c) => [svg("path", { d: "M43 22 H57 V43 H78 V57 H57 V78 H43 V57 H22 V43 H43 Z", fill: c })],
  ring: (c) => [svg("circle", { cx: 50, cy: 50, r: 22, fill: "none", stroke: c, "stroke-width": 9 })],
  chevron: (c) => [svg("path", { d: "M22 38 L50 62 L78 38 V54 L50 78 L22 54 Z", fill: c })],
  dot: (c) => [svg("circle", { cx: 50, cy: 50, r: 15, fill: c })],
  wing: (c) => [svg("path", { d: "M14 56 C30 34 52 30 86 32 C70 38 60 44 56 52 C44 50 30 52 14 56 Z M24 66 C40 56 56 54 76 56 C62 60 52 64 48 70 Z", fill: c })],
  wave: (c) => [svg("path", { d: "M18 52 C28 38 38 38 50 52 C62 66 72 66 82 52", fill: "none", stroke: c, "stroke-width": 9, "stroke-linecap": "round" })],
};

/** 紋章の絵 */
export function emblemSvg(e: Emblem, size = 64): SVGSVGElement {
  const root = svg("svg", { viewBox: "0 0 100 100", width: size, height: size, role: "img", "aria-label": "紋章" }) as SVGSVGElement;
  root.classList.add("tm-emblem");
  root.append(svg("path", { d: SHAPES[e.shape] ?? SHAPES.circle, fill: e.color, stroke: "rgba(255,255,255,0.35)", "stroke-width": 2 }));
  for (const m of (MARKS[e.mark] ?? MARKS.none)(e.markColor)) root.append(m);
  return root;
}

/** 能力の棒 (今と伸びしろ) */
export function statBar(label: string, v: number, pot?: number): HTMLElement {
  const bar = el("span", { class: "tm-bar" }, el("i", { style: `width:${Math.max(0, Math.min(100, v))}%` }));
  if (pot !== undefined && pot > v) bar.prepend(el("i", { class: "pot", style: `width:${Math.max(0, Math.min(100, pot))}%` }));
  return el("div", { class: "tm-stat" }, el("span", { class: "k" }, label), bar, el("b", { class: "tm-num" }, String(Math.round(v))));
}

export const STAT_NAMES: Record<string, string> = { speed: "速さ", stability: "安定", tyreFuel: "タイヤ・燃料", pitSense: "ピットの判断" };

/** 値が空の選択肢 (dom.ts の el は空の属性を飛ばすので、value を後から入れる) */
export function emptyOption(text: string): HTMLOptionElement {
  const o = el("option", {}, text) as HTMLOptionElement;
  o.value = "";
  return o;
}
