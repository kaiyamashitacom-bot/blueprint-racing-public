// ログイン・はじめる (登録)・自分のチーム・退会・管理者の画面
// ログインしなくても遊べる (この機械の保存だけで)。ログインすると部品と財布がサーバーに残る
import { DRIVER_NAME_MAX, PASSWORD_MIN, TEAM_NAME_MAX, checkDriverName, checkLoginId, checkPassword, checkTeamName, type AccountMe } from "@bpr/shared";
import * as api from "../api.ts";
import type { Go } from "../main.ts";
import { el } from "./dom.ts";
import { fetchRegisterInfo } from "../rooms_api.ts";
import { giftBox } from "./gift.ts";
import "./account.css";

/** toShop = お店の画面へ (ルーターから渡す) */
export function mountAccount(root: HTMLElement, go: Go, toShop?: () => void): () => void {
  const sheet = el("div", { class: "sheet acc" });
  root.append(sheet);
  let alive = true;

  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  sheet.append(el("div", { class: "acc-top" }, back, el("h2", {}, "チーム"), el("span", { class: "label" }, "account")));
  const body = el("div");
  sheet.append(body);

  // 同じ中身なら描き直さない (読み直しのたびに入力中の欄が消えないように)
  let shown = "";
  const render = (force = false) => {
    if (!alive) return;
    const sig = JSON.stringify([api.isLoggedIn(), api.cachedMe()]);
    if (!force && sig === shown) return;
    shown = sig;
    body.innerHTML = "";
    const me = api.cachedMe();
    if (api.isLoggedIn() && me) body.append(loggedIn(me));
    else if (api.isLoggedIn()) body.append(el("div", { class: "frame dim" }, "読みこんでいます…"));
    else body.append(loggedOut());
  };

  // ---------- ログインしていない ----------
  function loggedOut(): HTMLElement {
    const notes = el(
      "div",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "ログインすると"), el("span", { class: "label" }, "notes")),
      el(
        "ul",
        { class: "acc-notes" },
        el("li", {}, "部品と財布がサーバーに残ります。お店で部品を買えます"),
        el("li", {}, "ネットのレースで賞金が入ります (CPU だけのレースは少なめ)"),
        el("li", {}, "ID はほかの人に見えません。見えるのはチーム名と運転手名"),
        el("li", {}, "パスワードを忘れたら管理者に戻してもらいます (メールは使いません)"),
        el("li", {}, "ログインしなくても、この機械の中だけで遊べます"),
      ),
    );
    return el(
      "div",
      { class: "acc-grid" },
      el("div", { class: "frame" }, authForms((kind) => {
        render();
        if (kind === "register") toast("チームができました。はじめの部品の箱が届きました");
      })),
      notes,
    );
  }

  // ---------- ログインしている ----------
  function loggedIn(me: AccountMe): HTMLElement {
    const wrap = el("div", { class: "stack" });
    wrap.append(
      el(
        "div",
        { class: "acc-plate" },
        el("div", { class: "who" }, el("div", { class: "team" }, me.team), el("div", { class: "driver" }, me.driver)),
        el("div", { class: "wallet" }, el("span", { class: "label" }, "財布"), el("span", { class: "acc-money" }, money(me.money))),
      ),
    );

    const grid = el("div", { class: "acc-grid" });
    wrap.append(grid);

    // チームの情報と動き
    const shopBtn = el("button", { class: "go" }, "お店・持ち物") as HTMLButtonElement;
    shopBtn.addEventListener("click", () => toShop?.());
    shopBtn.hidden = !toShop;
    // 交換所 (走行点)
    const xcBtn = el("button", {}, "交換所") as HTMLButtonElement;
    xcBtn.addEventListener("click", () => go({ name: "exchange" }));
    const outBtn = el("button", {}, "ログアウト") as HTMLButtonElement;
    outBtn.addEventListener("click", async () => {
      outBtn.disabled = true;
      await api.logout();
      render();
    });
    grid.append(
      el(
        "div",
        { class: "frame" },
        el("div", { class: "section-title" }, el("h3", {}, "あなたのチーム"), el("span", { class: "label" }, "team")),
        el(
          "dl",
          { class: "acc-kv" },
          el("dt", {}, "チーム名"),
          el("dd", {}, me.team),
          el("dt", {}, "運転手名"),
          el("dd", {}, me.driver),
          el("dt", {}, "ID"),
          el("dd", {}, me.id, el("span", { class: "dim", style: "font-size:11px" }, " (あなただけに見えます)")),
          el("dt", {}, "はじめた日"),
          el("dd", { class: "num" }, dateText(me.createdAt)),
        ),
        el("div", { class: "acc-actions", style: "margin-top:14px" }, shopBtn, xcBtn, outBtn),
      ),
    );

    // 表示名
    grid.append(namesBox(me));
    // ギフトコード
    grid.append(giftBox());

    if (me.admin) grid.append(adminBox());
    grid.append(deleteBox());
    return wrap;
  }

  function namesBox(me: AccountMe): HTMLElement {
    const box = el("div", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "表示名"), el("span", { class: "label" }, "names")));
    if (!me.namesFree) {
      box.append(el("p", { class: "dim", style: "margin:0;font-size:13px" }, "チーム名と運転手名は、季節の切れ目に変えられます。"));
      return box;
    }
    const team = input({ maxlength: String(TEAM_NAME_MAX), value: me.team });
    const driver = input({ maxlength: String(DRIVER_NAME_MAX), value: me.driver });
    const msg = el("div", { class: "acc-msg" });
    const btn = el("button", { class: "primary", type: "submit" }, "変える") as HTMLButtonElement;
    const form = el("form", { class: "acc-form" }, el("div", { class: "callout ok" }, "今なら 1 回だけ変えられます"), field("チーム名", team), field("運転手名", driver), msg, btn) as HTMLFormElement;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const err = checkTeamName(team.value) ?? checkDriverName(driver.value);
      if (err) return say(msg, err, true);
      btn.disabled = true;
      try {
        await api.setNames(team.value, driver.value);
        render();
        toast("表示名を変えました");
      } catch (e) {
        say(msg, errText(e), true);
        btn.disabled = false;
      }
    });
    box.append(form);
    return box;
  }

  function adminBox(): HTMLElement {
    const id = input({ autocapitalize: "none", spellcheck: "false" });
    const pw = input({ autocomplete: "off", placeholder: "空なら自動で作る" });
    const msg = el("div", { class: "acc-msg" });
    const btn = el("button", { class: "primary", type: "submit" }, "パスワードを戻す") as HTMLButtonElement;
    const form = el("form", { class: "acc-form" }, field("その人の ID", id), field("新しいパスワード", pw), msg, btn) as HTMLFormElement;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!id.value.trim()) return say(msg, "ID を入れてください", true);
      if (pw.value && checkPassword(pw.value)) return say(msg, checkPassword(pw.value)!, true);
      if (!confirm(`「${id.value.trim()}」のパスワードを戻しますか? その人のログインは切れます`)) return;
      btn.disabled = true;
      try {
        const p = await api.adminResetPassword(id.value.trim(), pw.value);
        say(msg, `戻しました。新しいパスワード: ${p}`, false, true);
        pw.value = "";
      } catch (e) {
        say(msg, errText(e), true);
      } finally {
        btn.disabled = false;
      }
    });
    return el("div", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "管理者"), el("span", { class: "label" }, "admin")), form);
  }

  function deleteBox(): HTMLElement {
    const pw = input({ type: "password", autocomplete: "current-password" });
    const msg = el("div", { class: "acc-msg" });
    const btn = el("button", { class: "danger", type: "submit" }, "退会する") as HTMLButtonElement;
    const form = el(
      "form",
      { class: "acc-form" },
      el("p", { class: "dim", style: "margin:0;font-size:13px" }, "チーム・部品・設計図・財布が全部消えます。元に戻せません。歴代の記録の名前だけ残ります。"),
      field("パスワード", pw),
      msg,
      btn,
    ) as HTMLFormElement;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!pw.value) return say(msg, "パスワードを入れてください", true);
      if (!confirm("本当に退会しますか? チームも部品も消えて、元に戻せません")) return;
      btn.disabled = true;
      try {
        await api.deleteAccount(pw.value);
        render();
        toast("退会しました");
      } catch (e) {
        say(msg, errText(e), true);
        btn.disabled = false;
      }
    });
    return el("div", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "退会"), el("span", { class: "label" }, "delete")), form);
  }

  const off = api.onAccountChange(() => render());
  render(true);
  // サーバーの最新を読み直す (切れていれば api.ts が合い言葉を消す)
  api.refreshAccount().catch((e) => {
    if (api.isLoggedIn() && !api.cachedMe()) body.replaceChildren(el("div", { class: "callout" }, errText(e)));
  });

  return () => {
    alive = false;
    off();
  };
}

// ---------- ログイン・登録の入力 (アカウントの画面と、はじめのログインの画面 welcome.ts で使う) ----------

/** ログイン / はじめる (登録) の切りかえと入力。済んだら done (どちらで入ったか) */
export function authForms(done: (kind: "login" | "register") => void, first: "login" | "register" = "login"): HTMLElement {
  let mode = first;
  const tabs = el("div", { class: "acc-tabs" });
  const tLogin = el("button", { type: "button" }, "ログイン") as HTMLButtonElement;
  const tReg = el("button", { type: "button" }, "はじめる") as HTMLButtonElement;
  tabs.append(tLogin, tReg);
  const formBox = el("div");
  const draw = () => {
    tLogin.classList.toggle("on", mode === "login");
    tReg.classList.toggle("on", mode === "register");
    formBox.innerHTML = "";
    formBox.append(mode === "login" ? loginForm(() => done("login")) : registerForm(() => done("register")));
  };
  tLogin.addEventListener("click", () => {
    mode = "login";
    draw();
  });
  tReg.addEventListener("click", () => {
    mode = "register";
    draw();
  });
  draw();
  return el("div", { class: "acc-auth" }, tabs, formBox);
}

function loginForm(done: () => void): HTMLElement {
  const id = input({ autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
  const pw = input({ type: "password", autocomplete: "current-password" });
  const msg = el("div", { class: "acc-msg" });
  const btn = el("button", { class: "go", type: "submit" }, "ログイン") as HTMLButtonElement;
  const form = el("form", { class: "acc-form" }, field("ID", id), field("パスワード", pw), msg, btn) as HTMLFormElement;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!id.value.trim() || !pw.value) return say(msg, "ID とパスワードを入れてください", true);
    btn.disabled = true;
    say(msg, "確かめています…");
    try {
      await api.login(id.value, pw.value);
      done();
    } catch (e) {
      say(msg, errText(e), true);
    } finally {
      btn.disabled = false;
    }
  });
  return form;
}

function registerForm(done: () => void): HTMLElement {
  const id = input({ autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: "20" });
  const pw = input({ type: "password", autocomplete: "new-password" });
  const pw2 = input({ type: "password", autocomplete: "new-password" });
  const team = input({ maxlength: String(TEAM_NAME_MAX) });
  const driver = input({ maxlength: String(DRIVER_NAME_MAX) });
  // 招待の合言葉 (管理者が「招かれた人だけ」にしているときだけ出す)
  const invite = input({ autocapitalize: "characters", autocomplete: "off", spellcheck: "false", maxlength: "12" });
  const inviteField = field("招待の合言葉", invite, "今は招かれた人だけが登録できます。管理者からもらった 8 字");
  inviteField.style.display = "none";
  let inviteOnly = false;
  fetchRegisterInfo()
    .then((r) => {
      inviteOnly = r.inviteOnly;
      inviteField.style.display = inviteOnly ? "" : "none";
    })
    .catch(() => {});
  const msg = el("div", { class: "acc-msg" });
  const btn = el("button", { class: "go", type: "submit" }, "チームをつくる") as HTMLButtonElement;
  const form = el(
    "form",
    { class: "acc-form" },
    inviteField,
    field("ID", id, "英字・数字・_ - で 3〜20 字。ほかの人には見えません"),
    field("パスワード", pw, `${PASSWORD_MIN} 文字以上`),
    field("パスワード (もう一度)", pw2),
    field("チーム名", team, `${TEAM_NAME_MAX} 字まで。みんなに見えます`),
    field("運転手名", driver, `${DRIVER_NAME_MAX} 字まで。みんなに見えます`),
    el("div", { class: "dim", style: "font-size:12px" }, "チーム名と運転手名は、季節の切れ目まで変えられません"),
    msg,
    btn,
  ) as HTMLFormElement;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err =
      checkLoginId(id.value) ??
      checkPassword(pw.value) ??
      (pw.value !== pw2.value ? "パスワードが 2 つで違います" : null) ??
      checkTeamName(team.value) ??
      checkDriverName(driver.value);
    if (err) return say(msg, err, true);
    btn.disabled = true;
    say(msg, "つくっています…");
    try {
      await api.register({ id: id.value, password: pw.value, team: team.value, driver: driver.value, ...(inviteOnly ? { invite: invite.value } : {}) });
      done();
    } catch (e) {
      say(msg, errText(e), true);
    } finally {
      btn.disabled = false;
    }
  });
  return form;
}

// ---------- 小さな道具 (shop.ts でも使う) ----------

export function input(attrs: Record<string, string> = {}): HTMLInputElement {
  return el("input", { type: "text", ...attrs }) as HTMLInputElement;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el("label", { class: "acc-field" }, el("span", {}, label), control, hint ? el("small", {}, hint) : null);
}

export function say(box: HTMLElement, text: string, bad = false, good = false) {
  box.textContent = text;
  box.className = `acc-msg${bad ? " bad" : good ? " good" : ""}`;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : "うまくいきませんでした";
}

export function money(n: number): string {
  return Math.round(n).toLocaleString("ja-JP");
}

function dateText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

let toastTimer = 0;
export function toast(text: string, bad = false) {
  document.querySelector(".acc-toast")?.remove();
  const t = el("div", { class: `acc-toast${bad ? " bad" : ""}`, role: "status" }, text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 2600);
}
