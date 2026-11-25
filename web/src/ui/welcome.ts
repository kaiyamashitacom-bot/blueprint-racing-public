// はじめのログインの画面 (DECISIONS 11/25「で、最初はログイン」)。オープニングのあと、この機械にログインが無い人だけ通る。
// ログイン / はじめる (登録) はアカウントの画面と同じ入力 (account.ts の authForms)。済んだらメニューへ。
// 下に小さく「ログインしないで試す」(記録はこの機械だけ。賞金・走行点・季節・リーグ戦・賭け・交換所は無し = 今のログインしていないとき と同じ)
import { isLoggedIn } from "../api.ts";
import type { Go } from "../main.ts";
import { authForms, toast } from "./account.ts";
import { el } from "./dom.ts";
import "./welcome.css";

/** この回 (タブを閉じるまで) は「試す」を選んだ: 読み直してもログインの画面に戻さない */
export const GUEST_KEY = "bpr.guest";

export function isGuestThisSession(): boolean {
  try {
    return sessionStorage.getItem(GUEST_KEY) === "1";
  } catch {
    return false;
  }
}

export function mountWelcome(root: HTMLElement, go: Go): () => void {
  // 読み直したときに もうログインしていれば、そのままメニューへ (go の中で go を呼ばないよう 1 拍おく)
  if (isLoggedIn()) {
    queueMicrotask(() => go({ name: "menu" }));
    return () => {};
  }
  const sheet = el("div", { class: "sheet welcome" });
  root.append(sheet);

  const toMenu = () => go({ name: "menu" });
  const guest = el("button", { class: "welcome-guest", type: "button" }, "ログインしないで試す", el("small", {}, "記録はこの機械だけ")) as HTMLButtonElement;
  guest.addEventListener("click", () => {
    try {
      sessionStorage.setItem(GUEST_KEY, "1");
    } catch {
      /* 残せなくても進む */
    }
    toMenu();
  });

  sheet.append(
    el(
      "header",
      { class: "welcome-head" },
      el("span", { class: "brand-mark", "aria-hidden": "true" }, "BPR"),
      el("div", {}, el("h1", {}, "BLUEPRINT ", el("em", {}, "RACING")), el("p", { class: "dim" }, "ログインして、あなたのチームで走りましょう")),
    ),
    el(
      "section",
      { class: "frame welcome-box" },
      authForms((kind) => {
        if (kind === "register") toast("チームができました。はじめの部品の箱が届きました");
        toMenu();
      }),
      el("p", { class: "welcome-note" }, "パスワードを忘れたら管理者が戻します (メールは使いません)"),
    ),
    el("div", { class: "welcome-foot" }, guest, el("p", { class: "dim" }, "試すだけなら 練習と すぐ走る (賞金・走行点・季節・リーグ戦・賭け・交換所 は無し)。あとからいつでも登録できます")),
  );
  return () => {};
}
