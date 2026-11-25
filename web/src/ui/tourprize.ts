// 大会の格と景品の見せ方 (DECISIONS 11/25「大会ごとの景品」)。大会の一覧・1 つの大会・予選・結果で使う。
// 中継の順位の塔のように: 順位の札 (P1・P2–3) と中身の行、格の札 (大 = 赤・中 = 青・小 = 灰)
import type { PrizeSummary, TournamentGrade } from "@bpr/shared";
import { el } from "./dom.ts";
import "./tourprize.css";

const GRADE_EN: Record<TournamentGrade, string> = { 大: "GRAND", 中: "MAJOR", 小: "MINOR" };

/** 格の札 */
export function gradeBadge(grade: TournamentGrade | undefined): HTMLElement | null {
  if (!grade) return null;
  return el("span", { class: `tp-grade g${grade === "大" ? 3 : grade === "中" ? 2 : 1}`, title: `格: ${grade}` }, el("b", {}, grade), el("small", {}, GRADE_EN[grade]));
}

const posLabel = (from: number, to: number) => (from === to ? `P${from}` : `P${from}–${to}`);

/** 一覧と予選の 1 行: 一番上の景品と参加賞 */
export function prizeLine(p: PrizeSummary | undefined): HTMLElement | null {
  if (!p) return null;
  const top = p.tiers[0];
  const bits: Array<HTMLElement | string> = [];
  if (top) bits.push(el("span", { class: "tp-pos" }, posLabel(top.from, top.to)), el("span", { class: "tp-what" }, top.lines.join("・")));
  if (p.participation.length) bits.push(el("span", { class: "tp-pos part" }, "参加賞"), el("span", { class: "tp-what" }, p.participation.join("・")));
  if (!bits.length) return null;
  return el("span", { class: "tp-line", "aria-label": "この大会の景品" }, el("span", { class: "tp-gift" }, "景品"), ...bits);
}

/** 「この大会の景品」の枠 */
export function prizeFrame(p: PrizeSummary | undefined): HTMLElement | null {
  if (!p) return null;
  const f = el(
    "section",
    { class: "frame tp-frame" },
    el("div", { class: "section-title" }, el("h3", {}, "この大会の景品"), gradeBadge(p.grade), el("span", { class: "label" }, "Prizes")),
  );
  const list = el("ol", { class: "tp-list" });
  for (const t of p.tiers) list.append(el("li", { class: `tp-row${t.from === 1 ? " p1" : t.from <= 3 ? " pod" : ""}` }, el("span", { class: "tp-pos" }, posLabel(t.from, t.to)), el("span", { class: "tp-what" }, t.lines.join("・"))));
  if (p.participation.length) list.append(el("li", { class: "tp-row part" }, el("span", { class: "tp-pos part" }, "参加賞"), el("span", { class: "tp-what" }, p.participation.join("・"), el("small", { class: "dim" }, " 完走したチームみんな"))));
  if (!list.childElementCount) list.append(el("li", { class: "dim" }, "この大会は景品なし (賞金だけ)"));
  f.append(
    list,
    el(
      "p",
      { class: "dim ss-foot" },
      `${p.custom ? "管理者が決めた景品" : `格「${p.grade}」のはじめの景品`}。賞金とは別。失格・完走できずはもらえません。代走でもチームがもらいます`,
    ),
  );
  return f;
}

/** 結果の行の景品 */
export function resultGifts(gifts: string[] | undefined, missed: string[] | undefined): HTMLElement | null {
  if (!gifts?.length && !missed?.length) return null;
  return el(
    "span",
    { class: "tp-got" },
    ...(gifts ?? []).map((g) => el("span", { class: `tp-chip${g.startsWith("参加賞") ? " part" : ""}` }, g)),
    ...(missed ?? []).map((g) => el("span", { class: "tp-chip miss", title: "受け取れなかった" }, `× ${g}`)),
  );
}
