// ギフトコードの欄 (遊ぶ人): アカウントの画面の札 (giftBox) と、はじめの画面の設定の 1 行 (giftMenuRows、ログインしているときだけ)。
// 受け取ったら中身を見せて、財布と持ち物を読み直す
import * as api from "../api.ts";
import { fetchGiftStatus, redeemGift, type GiftRedeemResult } from "../gift_api.ts";
import { errText, toast } from "./account.ts";
import { el } from "./dom.ts";
import "./gift.css";

/** 最後に受け取った中身 (財布が変わって画面が描き直されても 2 分は見せる) */
let last: { r: GiftRedeemResult; at: number } | null = null;
const SHOW_MS = 2 * 60_000;

function codeInput(): HTMLInputElement {
  return el("input", {
    type: "text",
    class: "gift-input",
    autocapitalize: "characters",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: "false",
    maxlength: "40",
    enterkeyhint: "done",
    placeholder: "コードを入れる",
    "aria-label": "ギフトコード",
  }) as HTMLInputElement;
}

async function redeem(code: string): Promise<GiftRedeemResult> {
  const r = await redeemGift(code);
  last = { r, at: Date.now() };
  // 財布と持ち物を読み直す
  await api.refreshAccount().catch(() => {});
  return r;
}

function resultView(r: GiftRedeemResult): HTMLElement {
  const box = el("div", { class: "gift-got", role: "status" }, el("div", { class: "gift-got-head" }, el("span", { class: "label" }, "Received"), el("b", {}, "受け取りました")));
  const ul = el("ul", { class: "gift-lines" });
  for (const line of r.received) ul.append(el("li", {}, line));
  for (const line of r.later) ul.append(el("li", { class: "later" }, line));
  box.append(ul);
  return box;
}

function statusLine(): HTMLElement {
  const p = el("div", { class: "gift-status dim" });
  fetchGiftStatus()
    .then((s) => {
      const bits: string[] = [];
      if (s.title) bits.push(`称号「${s.title}」`);
      if (s.discountPct > 0) bits.push(`運転手の契約金 ${s.discountPct}% 引き (次の 1 回)`);
      for (const m of s.pending) bits.push(m.kind === "division" ? `次の日の締めで リーグ戦 ${m.target} 部へ` : `次の季節の締めで 本戦 ${m.target} 級へ`);
      p.textContent = bits.length ? `持っているもの: ${bits.join(" · ")}` : "";
    })
    .catch(() => {});
  return p;
}

/** アカウントの画面の札 */
export function giftBox(): HTMLElement {
  const input = codeInput();
  const btn = el("button", { class: "go", type: "submit" }, "受け取る") as HTMLButtonElement;
  const msg = el("div", { class: "acc-msg", "aria-live": "polite" });
  const out = el("div");
  if (last && Date.now() - last.at < SHOW_MS) out.append(resultView(last.r));
  const form = el("form", { class: "gift-form" }, el("div", { class: "gift-row" }, input, btn), msg) as HTMLFormElement;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = input.value.trim();
    if (!code) {
      msg.textContent = "コードを入れてください";
      msg.className = "acc-msg bad";
      return;
    }
    btn.disabled = true;
    msg.textContent = "確かめています…";
    msg.className = "acc-msg";
    try {
      const r = await redeem(code);
      input.value = "";
      msg.textContent = "";
      out.replaceChildren(resultView(r));
      toast("ギフトを受け取りました");
    } catch (e) {
      msg.textContent = errText(e);
      msg.className = "acc-msg bad";
    } finally {
      btn.disabled = false;
    }
  });
  return el(
    "div",
    { class: "frame gift-box" },
    el("div", { class: "section-title" }, el("h3", {}, "ギフトコード"), el("span", { class: "label" }, "Gift code")),
    form,
    out,
    statusLine(),
    el("p", { class: "dim gift-foot" }, "1 つのコードは 1 人 1 回まで。大文字と小文字は区別しません"),
  );
}

/** はじめの画面の設定の 1 行 (ログインしていなければ出さない) */
export function giftMenuRows(): HTMLElement[] {
  if (!api.isLoggedIn()) return [];
  const input = codeInput();
  const btn = el("button", { class: "small", type: "submit" }, "受け取る") as HTMLButtonElement;
  const form = el("form", { class: "setting gift-setting" }, el("span", { class: "k" }, "ギフト"), el("div", { class: "gift-row" }, input, btn)) as HTMLFormElement;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    btn.disabled = true;
    try {
      const r = await redeem(code);
      input.value = "";
      toast(`受け取りました: ${[...r.received, ...r.later].join("・")}`.slice(0, 120));
    } catch (e) {
      toast(errText(e), true);
    } finally {
      btn.disabled = false;
    }
  });
  return [form];
}
