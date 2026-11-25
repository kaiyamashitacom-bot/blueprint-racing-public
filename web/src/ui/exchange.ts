// 交換所 (F1 中継風): 走行点の残高・今日あとどれだけもらえるか・交換できる物 (値段と回数)・交換の記録 (DECISIONS 11/25「走って点をためて交換」)。
// 走行点がたまるのは自分で走ったレースだけ (すぐ走る・部屋・大会・1 周アタック)。交換の一覧は管理者が決める (admin_rp.ts)
import * as api from "../api.ts";
import * as rapi from "../rp_api.ts";
import type { Go } from "../main.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import { loginGate } from "./teamkit.ts";
import "./account.css";
import "./team.css";
import "./exchange.css";

type Tab = "shop" | "history";

const jst = (ms: number) => new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** まだ交換できないわけ (できるなら null) */
export function rpWhyNot(e: rapi.RpShopView, points: number, on: boolean): string | null {
  if (!on) return "交換所は今 止まっています";
  if (e.limitTotal !== null && e.boughtTotal >= e.limitTotal) return "交換ずみ";
  if (e.limitWeek !== null && e.boughtWeek >= e.limitWeek) return "今週はもう交換できません (月曜に戻ります)";
  if (points < e.price) return `走行点が足りない (あと ${money(e.price - points)})`;
  return null;
}

export function mountExchange(root: HTMLElement, go: Go): () => void {
  const sheet = el("div", { class: "sheet acc tm xc" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, "交換所"), el("span", { class: "label" }, "Exchange · race points")));
  const body = el("div", { class: "xc-body" });
  sheet.append(body);

  let alive = true;
  let tab: Tab = "shop";
  let st: rapi.RpStatus | null = null;
  /** 2 回押しで交換 (1 回目で「もう一度押すと交換」) */
  let arm: { id: number; until: number } | null = null;
  let busy = false;

  if (!api.isLoggedIn()) {
    body.append(loginGate(go));
    return () => {};
  }

  const pts = el("b", { class: "tm-num xc-big" }, "—");
  const todayN = el("b", { class: "tm-num" }, "—");
  const leftN = el("small", {}, "");
  const bar = el("i", { class: "xc-bar-fill" });
  const rule = el("p", { class: "xc-rule" });
  const strip = el(
    "section",
    { class: "frame xc-strip" },
    el("div", { class: "xc-cash" }, el("span", { class: "label" }, "Race points"), pts, el("small", {}, "手元の走行点")),
    el("div", { class: "xc-cash" }, el("span", { class: "label" }, "Today"), todayN, leftN, el("div", { class: "xc-bar", "aria-hidden": "true" }, bar)),
    rule,
  );
  const nav = el("nav", { class: "tm-nav xc-nav", "aria-label": "交換所の画面" });
  const view = el("div", { class: "xc-view" });
  body.append(strip, nav, view);

  async function load() {
    try {
      const r = await rapi.fetchRp();
      if (!alive) return;
      st = r;
      paint();
    } catch (e) {
      if (!alive) return;
      view.innerHTML = "";
      view.append(el("div", { class: "frame bad" }, errText(e)));
    }
  }

  function paintStrip() {
    if (!st) return;
    pts.textContent = money(st.points);
    todayN.textContent = `${money(st.today)} / ${money(st.cap)}`;
    leftN.textContent = st.left > 0 ? `今日あと ${money(st.left)} 点もらえる` : "今日の上限に届きました (0 時に戻ります)";
    bar.style.width = `${st.cap > 0 ? Math.min(100, (st.today / st.cap) * 100) : 100}%`;
    const r = st.rates;
    rule.textContent = st.on
      ? `自分で走ったレースでたまる: 完走 ${r.rpFinish} 点 + 1 位 ${r.rpPosBonus} 点〜5 位 1 点、周の数で ×1〜×3。大会 ×${r.rpTourMul} (上限の外)。1 周アタック 1 周 ${r.rpTaLap} 点・記録更新 ${r.rpTaBest} 点。リーグ戦と代走ではたまりません。`
      : "走行点は今 止まっています (たまらず、交換もできません)。";
  }

  function paintNav() {
    nav.innerHTML = "";
    for (const [t, jp] of [
      ["shop", "交換"],
      ["history", "記録"],
    ] as Array<[Tab, string]>) {
      const b = el("button", { class: t === tab ? "on" : "", "aria-current": t === tab ? "page" : "" }, jp);
      b.addEventListener("click", () => {
        tab = t;
        paint();
      });
      nav.append(b);
    }
  }

  function paint() {
    paintStrip();
    paintNav();
    view.innerHTML = "";
    if (!st) return;
    view.append(tab === "shop" ? shopView(st) : historyView(st));
  }

  function shopView(s: rapi.RpStatus): HTMLElement {
    const box = el("div", { class: "xc-grid" });
    if (!s.on) box.append(el("div", { class: "frame bad xc-wide" }, "交換所は今 止まっています"));
    if (!s.shop.length) box.append(el("div", { class: "frame dim xc-wide" }, "今は交換できる物がありません"));
    for (const e of s.shop) box.append(card(e, s));
    return box;
  }

  function card(e: rapi.RpShopView, s: rapi.RpStatus): HTMLElement {
    const why = rpWhyNot(e, s.points, s.on);
    const done = e.limitTotal !== null && e.boughtTotal >= e.limitTotal;
    const limits: string[] = [];
    if (e.limitWeek !== null) limits.push(`今週 ${e.boughtWeek} / ${e.limitWeek}`);
    if (e.limitTotal !== null) limits.push(`全部で ${e.boughtTotal} / ${e.limitTotal}`);
    const armed = arm && arm.id === e.id && arm.until > Date.now();
    const btn = el("button", { class: armed ? "go xc-buy armed" : "xc-buy" }, armed ? `もう一度押すと交換 (${money(e.price)} 点)` : "交換する") as HTMLButtonElement;
    btn.disabled = !!why || busy;
    btn.title = why ?? "";
    btn.addEventListener("click", () => void press(e));
    return el(
      "section",
      { class: `frame xc-item${done ? " done" : ""}` },
      el("div", { class: "xc-item-head" }, el("h3", {}, e.name), el("span", { class: "xc-price" }, el("b", { class: "tm-num" }, money(e.price)), el("small", {}, "点"))),
      el("ul", { class: "xc-lines" }, ...e.lines.map((l) => el("li", {}, l))),
      e.note ? el("p", { class: "xc-note" }, e.note) : null,
      el(
        "div",
        { class: "xc-foot" },
        el("span", { class: "xc-limit" }, limits.join("・") || "回数の制限なし"),
        btn,
      ),
      why && !done ? el("div", { class: "tm-why xc-why" }, why) : null,
    );
  }

  async function press(e: rapi.RpShopView) {
    if (busy) return;
    if (!arm || arm.id !== e.id || arm.until <= Date.now()) {
      arm = { id: e.id, until: Date.now() + 4000 };
      paint();
      window.setTimeout(() => {
        if (alive && arm?.id === e.id && arm.until <= Date.now()) {
          arm = null;
          paint();
        }
      }, 4100);
      return;
    }
    arm = null;
    busy = true;
    paint();
    try {
      const r = await rapi.buyRp(e.id);
      toast(`交換しました: ${[...r.received, ...r.later].join("・")}`.slice(0, 120));
      await api.refreshAccount().catch(() => {});
    } catch (err) {
      toast(errText(err), true);
    } finally {
      busy = false;
      await load();
    }
  }

  function historyView(s: rapi.RpStatus): HTMLElement {
    const box = el("div", { class: "xc-hist" });
    const buys = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "交換の記録"), el("span", { class: "label" }, "Exchanged")));
    if (!s.buys.length) buys.append(el("p", { class: "dim xc-note" }, "まだ交換していません"));
    else
      buys.append(
        el(
          "ul",
          { class: "xc-log" },
          ...s.buys.map((b) =>
            el("li", {}, el("span", { class: "xc-when tm-num" }, jst(b.at)), el("span", { class: "xc-what" }, b.name, el("small", {}, b.lines.join("・"))), el("b", { class: "tm-num xc-minus" }, `−${money(b.price)}`)),
          ),
        ),
      );
    const ledger = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "走行点の出入り"), el("span", { class: "label" }, "Ledger")));
    if (!s.ledger.length) ledger.append(el("p", { class: "dim xc-note" }, "まだありません。すぐ走る・部屋・大会・1 周アタックを走るとたまります"));
    else
      ledger.append(
        el(
          "ul",
          { class: "xc-log" },
          ...s.ledger.map((l) =>
            el(
              "li",
              {},
              el("span", { class: "xc-when tm-num" }, jst(l.at)),
              el("span", { class: "xc-what" }, l.reason, el("small", {}, l.kindJp)),
              el("b", { class: `tm-num ${l.delta < 0 ? "xc-minus" : "xc-plus"}` }, `${l.delta < 0 ? "−" : "+"}${money(Math.abs(l.delta))}`),
            ),
          ),
        ),
      );
    box.append(buys, ledger);
    return box;
  }

  void load();
  return () => {
    alive = false;
  };
}

/** はじめの画面の見出しの札 (ログインしているときだけ。押すと交換所) */
export function rpChip(go: Go): HTMLElement | null {
  if (!api.isLoggedIn()) return null;
  const n = el("b", { class: "tm-num" }, rapi.cachedRacePoints() === null ? "—" : money(rapi.cachedRacePoints()!));
  const b = el("button", { class: "xc-chip", "aria-label": "走行点 (交換所へ)" }, el("span", { class: "label" }, "走行点"), n) as HTMLButtonElement;
  b.addEventListener("click", () => go({ name: "exchange" }));
  rapi
    .fetchRp()
    .then((r) => {
      n.textContent = money(r.points);
      b.setAttribute("aria-label", `走行点 ${money(r.points)} (交換所へ)`);
    })
    .catch(() => {});
  return b;
}
