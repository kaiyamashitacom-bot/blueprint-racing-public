// 市場の画面: 見る・買う・競る / 出す (値段を決めて・競り) / 自分の出品と競り / 部品の供給の約束
import { anyPartDef, type CarDesign } from "@bpr/shared";
import * as api from "../api.ts";
import * as tapi from "../team_api.ts";
import type { Go } from "../main.ts";
import { load, save } from "../store.ts";
import { errText, field, input, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import { emptyOption } from "./teamkit.ts";
import { left, loginGate, paintWallet, shortOfMoney, teamSheet, whyNot } from "./teamkit.ts";

type Tab = "browse" | "sell" | "mine" | "supply";
const TAB_NAMES: Array<[Tab, string]> = [
  ["browse", "見る・買う"],
  ["sell", "出す"],
  ["mine", "自分の"],
  ["supply", "部品の供給"],
];

export function mountMarket(root: HTMLElement, go: Go): () => void {
  const { body, wallet } = teamSheet(root, go, "market");
  let alive = true;
  if (!api.isLoggedIn()) {
    body.append(loginGate(go));
    return () => {};
  }
  let v: tapi.MarketView | null = null;
  let tab: Tab = "browse";
  let filter: "all" | "part" | "design" = "all";
  let busy = false;
  const sub = el("div", { class: "tm-sub", role: "group", "aria-label": "市場の中の切りかえ" });
  const content = el("div", { class: "tm-body" });
  body.append(sub, content);
  content.append(el("div", { class: "frame dim" }, "読みこんでいます…"));

  const reload = async () => {
    try {
      v = await tapi.fetchMarket();
      if (alive) render();
    } catch (e) {
      if (!alive) return;
      content.innerHTML = "";
      content.append(el("div", { class: "frame bad" }, errText(e)));
    }
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
      toast(ok);
    } catch (e) {
      toast(errText(e), true);
    } finally {
      busy = false;
      await reload();
    }
  };

  function render() {
    if (!v) return;
    const view = v;
    paintWallet(wallet, view.money, view.held);
    sub.innerHTML = "";
    for (const [t, label] of TAB_NAMES) {
      const b = el("button", { class: `small${t === tab ? " on" : ""}`, "aria-pressed": String(t === tab) }, label) as HTMLButtonElement;
      b.addEventListener("click", () => {
        tab = t;
        render();
      });
      sub.append(b);
    }
    content.innerHTML = "";
    if (tab === "browse") content.append(browse(view));
    else if (tab === "sell") content.append(sell(view));
    else if (tab === "mine") content.append(mine(view));
    else content.append(supply(view));
  }

  // ---------- 見る・買う ----------
  function browse(view: tapi.MarketView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "出ている物"), el("span", { class: "label" }, `${view.listings.length} listings`)));
    const fl = el("div", { class: "tm-sub", style: "margin-bottom:10px" });
    for (const [k, label] of [
      ["all", "全部"],
      ["part", "部品"],
      ["design", "設計図"],
    ] as const) {
      const b = el("button", { class: `small${filter === k ? " on" : ""}` }, label);
      b.addEventListener("click", () => {
        filter = k;
        render();
      });
      fl.append(b);
    }
    f.append(fl);
    const list = view.listings.filter((l) => filter === "all" || l.item.type === filter);
    if (!list.length) f.append(el("div", { class: "tm-empty" }, "今は何も出ていません"));
    const box = el("div", { class: "tm-list" });
    for (const l of list) box.append(row(l, view, true));
    f.append(box, el("p", { class: "dim", style: "font-size:12px;margin:10px 0 0" }, `売れたときに売った人から手数料 ${Math.round(view.feeRate * 100)}% を引きます。競りに入れたお金は預かり、抜かれたら戻ります`));
    return f;
  }

  function row(l: tapi.ListingView, view: tapi.MarketView, canAct: boolean): HTMLElement {
    const part = l.item.partId ? anyPartDef(l.item.partId) : null;
    const meta = [
      l.mine ? "あなたの出品" : l.seller,
      l.item.type === "design" ? `設計図 · 部品 ${l.item.parts ?? 0} 個` : part ? `T${part.tier} · ${part.note}` : "",
      l.status === "open" ? `あと ${left(l.endsAt - Date.now())}` : l.status === "sold" ? "売れた" : l.status === "expired" ? "期限切れ" : "やめた",
    ].filter(Boolean);
    const info = el(
      "div",
      {},
      el("div", { class: "nm" }, l.item.name, el("span", { class: `tm-mode${l.mode === "auction" ? " auction" : ""}` }, l.mode === "auction" ? "競り" : "即決"), l.topMine && l.status === "open" ? el("span", { class: "tm-mode top" }, "一番") : null),
      el("div", { class: "meta" }, meta.join(" · ")),
    );
    const side = el("div", { class: "tm-side" });
    const shown = l.finalPrice ?? (l.mode === "auction" ? (l.top ?? l.price) : l.price);
    side.append(el("span", { class: "price tm-num" }, money(shown), el("small", {}, l.finalPrice !== undefined ? (l.boughtByMe ? "買った値" : "決まった値") : l.mode === "auction" ? (l.top ? `今の値 · ${l.bids} 件` : "始めの値") : "値段")));
    if (canAct && l.status === "open") {
      if (l.mine) {
        const c = el("button", { class: "small" }, "やめる") as HTMLButtonElement;
        c.disabled = l.bids > 0;
        c.title = l.bids > 0 ? "競りに値が入ったらやめられません" : "";
        c.addEventListener("click", () => run(() => tapi.cancelListing(l.id), "出品をやめました"));
        side.append(c);
      } else if (l.mode === "fixed") {
        const b = el("button", { class: "go small" }, "買う") as HTMLButtonElement;
        const why = whyNot(b, shortOfMoney(l.price, view.money));
        b.addEventListener("click", () => {
          if (!confirm(`${l.item.name} を ${money(l.price)} で買います。よいですか`)) return;
          void run(() => tapi.buyListing(l.id), `${l.item.name} を買いました`);
        });
        side.append(b);
        if (why) side.append(why);
      } else {
        const amt = input({ type: "number", inputmode: "numeric", min: String(l.minNext), step: "10", value: String(l.minNext), "aria-label": "入れる値" });
        const b = el("button", { class: "go small" }, l.topMine ? "上げる" : "値を入れる") as HTMLButtonElement;
        b.addEventListener("click", () => {
          const n = Math.floor(Number(amt.value));
          if (!(n >= l.minNext)) return toast(`${money(l.minNext)} 以上にしてください`, true);
          void run(() => tapi.bidListing(l.id, n), `${money(n)} を入れました`);
        });
        side.append(amt, b);
        // 一番の値を入れていない人は、次の値の分のお金が要る
        const why = l.topMine ? null : whyNot(b, shortOfMoney(l.minNext, view.money));
        if (why) side.append(why);
      }
    }
    return el("div", { class: "tm-item" }, el("div", { class: `bar${l.item.type === "design" ? " design" : ""}` }), info, side);
  }

  // ---------- 出す ----------
  function sell(view: tapi.MarketView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "市場に出す"), el("span", { class: "label" }, "Sell")));
    const kind = el("select", { "aria-label": "出す物" }) as HTMLSelectElement;
    kind.append(el("option", { value: "part" }, "部品"), el("option", { value: "design" }, "設計図 (写しを売る。手元にも残る)"));
    const what = el("select", { "aria-label": "品" }) as HTMLSelectElement;
    const count = input({ type: "number", inputmode: "numeric", min: "1", value: "1" });
    const mode = el("select", { "aria-label": "売り方" }) as HTMLSelectElement;
    mode.append(el("option", { value: "fixed" }, "値段を決めて出す (即決)"), el("option", { value: "auction" }, "競り (一番高い値の人に)"));
    const price = input({ type: "number", inputmode: "numeric", min: "1", value: "100" });
    const hours = el("select", { "aria-label": "出す長さ" }) as HTMLSelectElement;
    for (const h of [1, 6, 12, 24, 48, 72, 168]) if (h >= view.limits.minHours && h <= view.limits.maxHours) hours.append(el("option", { value: String(h) }, h < 24 ? `${h} 時間` : `${h / 24} 日`));
    hours.value = String(view.limits.defaultHours);
    const countField = field("数", count);
    const fee = el("div", { class: "dim wide", style: "font-size:13px" });
    const fill = () => {
      what.innerHTML = "";
      if (kind.value === "part") {
        const owned = Object.entries(view.sellable.parts).filter(([, n]) => n > 0);
        for (const [id, n] of owned) what.append(el("option", { value: id }, `${anyPartDef(id)?.name ?? id} (×${n})`));
        if (!owned.length) what.append(emptyOption("— 部品がありません —"));
        countField.hidden = false;
      } else {
        for (const d of view.sellable.designs) what.append(el("option", { value: String(d.id) }, d.name));
        if (!view.sellable.designs.length) what.append(emptyOption("— サーバーに設計図がありません —"));
        countField.hidden = true;
      }
      paintFee();
    };
    const paintFee = () => {
      const p = Math.max(0, Math.floor(Number(price.value) || 0));
      const cut = Math.floor(p * view.feeRate);
      fee.textContent = `${mode.value === "auction" ? "始めの値" : "値段"} ${money(p)} · 売れたら手数料 ${money(cut)} を引いて ${money(p - cut)} が入ります${mode.value === "auction" ? " (競りは高くなればその分)" : ""}`;
    };
    kind.addEventListener("change", fill);
    price.addEventListener("input", paintFee);
    mode.addEventListener("change", paintFee);
    const go2 = el("button", { class: "go" }, "出す") as HTMLButtonElement;
    go2.addEventListener("click", () => {
      if (!what.value) return toast("出す物を選んでください", true);
      const p = Math.floor(Number(price.value));
      if (!(p >= 1)) return toast("値段は 1 以上にしてください", true);
      const item = kind.value === "part" ? { type: "part" as const, partId: what.value, count: Math.floor(Number(count.value)) || 1 } : { type: "design" as const, designId: Number(what.value) };
      void run(async () => {
        await tapi.listItem({ item, mode: mode.value as "fixed" | "auction", price: p, hours: Number(hours.value) });
        tab = "mine";
      }, "市場に出しました");
    });
    f.append(
      el(
        "div",
        { class: "tm-form" },
        field("出す物", kind),
        field("品", what),
        countField,
        field("売り方", mode),
        field("値段", price),
        field("出す長さ", hours),
        fee,
        el("div", { class: "wide row" }, go2),
      ),
      el("p", { class: "dim", style: "font-size:12px;margin:10px 0 0" }, "部品は出したときに持ち物から預かり、売れなければ戻ります。設計図はサーバーに残した物を出せます (チームの画面で 1 台目・2 台目に決めると残ります)"),
    );
    fill();
    return f;
  }

  // ---------- 自分の ----------
  function mine(view: tapi.MarketView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "自分の出品と競り"), el("span", { class: "label" }, "Mine")));
    if (!view.mine.length) f.append(el("div", { class: "tm-empty" }, "まだありません"));
    const box = el("div", { class: "tm-list" });
    for (const l of view.mine) box.append(row(l, view, true));
    f.append(box);
    // 買った設計図をこの機械の車づくりへ
    const d = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "サーバーの設計図"), el("span", { class: "label" }, "Designs")));
    d.append(el("p", { class: "dim", style: "font-size:13px;margin:0 0 8px" }, "市場で買った設計図はサーバーに入ります。車づくりで使うには、この機械に入れてください"));
    const dl = el("div", { class: "tm-list" });
    for (const s of view.sellable.designs) {
      const b = el("button", { class: "small" }, "この機械に入れる") as HTMLButtonElement;
      b.addEventListener("click", () =>
        run(async () => {
          const all = await api.listDesigns();
          const found = all.find((x) => x.id === s.id);
          if (!found) throw new Error("見つかりません");
          const st = load();
          st.designs.push(structuredClone(found.design) as CarDesign);
          save();
        }, `「${s.name}」をこの機械に入れました`),
      );
      dl.append(el("div", { class: "tm-item" }, el("div", { class: "bar design" }), el("div", { class: "nm" }, s.name), el("div", { class: "tm-side" }, b)));
    }
    if (!view.sellable.designs.length) dl.append(el("div", { class: "tm-empty" }, "サーバーに設計図はありません"));
    d.append(dl);
    const wrap = el("div", { class: "tm-body" }, f, d);
    return wrap;
  }

  // ---------- 部品の供給 ----------
  function supply(view: tapi.MarketView): HTMLElement {
    const f = el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "部品の供給の約束"), el("span", { class: "label" }, "Supply")),
      el("p", { class: "dim", style: "font-size:13px;margin:0 0 10px" }, "研究した部品を、決めた値段で別のチームに売る約束 (この季節のあいだ)。注文が来ると、その場で作って届けます"),
    );
    const box = el("div", { class: "tm-list" });
    const STATUS: Record<tapi.SupplyView["status"], string> = { offered: "返事待ち", active: "約束中", declined: "断られた", ended: "終わった" };
    for (const s of view.supplies) {
      const side = el("div", { class: "tm-side" });
      if (s.role === "buyer" && s.status === "offered") {
        const yes = el("button", { class: "go small" }, "受ける");
        const no = el("button", { class: "small" }, "断る");
        yes.addEventListener("click", () => run(() => tapi.answerSupply(s.id, true), "供給を受けました"));
        no.addEventListener("click", () => run(() => tapi.answerSupply(s.id, false), "断りました"));
        side.append(yes, no);
      } else if (s.role === "buyer" && s.status === "active" && s.delivered < s.maxUnits) {
        const n = input({ type: "number", inputmode: "numeric", min: "1", max: String(s.maxUnits - s.delivered), value: "1", "aria-label": "注文する数" });
        const b = el("button", { class: "go small" }, "注文") as HTMLButtonElement;
        b.addEventListener("click", () => {
          const k = Math.floor(Number(n.value));
          if (!(k >= 1)) return toast("数は 1 以上", true);
          if (!confirm(`${s.name} ×${k} を ${money(k * s.unitPrice)} で注文します。よいですか`)) return;
          void run(() => tapi.orderSupply(s.id, k), `${s.name} ×${k} が届きました`);
        });
        side.append(n, b);
      }
      box.append(
        el(
          "div",
          { class: "tm-item" },
          el("div", { class: "bar" }),
          el(
            "div",
            {},
            el("div", { class: "nm" }, s.name, el("span", { class: "tm-mode" }, s.role === "supplier" ? "売る側" : "買う側")),
            el("div", { class: "meta" }, `${s.other} · 1 個 ${money(s.unitPrice)} · ${s.delivered} / ${s.maxUnits} 個 · ${STATUS[s.status]}`),
          ),
          side,
        ),
      );
    }
    if (!view.supplies.length) box.append(el("div", { class: "tm-empty" }, "約束はまだありません"));
    f.append(box);

    // 申し出る (研究の終わった部品があるとき)
    const o = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "供給を申し出る"), el("span", { class: "label" }, "Offer")));
    if (!view.sellable.made.length) {
      o.append(el("p", { class: "dim", style: "margin:0;font-size:13px" }, "研究が終わった部品がまだありません"));
    } else {
      const team = input({ placeholder: "相手のチーム名", maxlength: "16" });
      const part = el("select", { "aria-label": "部品" }) as HTMLSelectElement;
      for (const id of view.sellable.made) part.append(el("option", { value: id }, anyPartDef(id)?.name ?? id));
      const unit = input({ type: "number", inputmode: "numeric", min: "1", value: "1000" });
      const max = input({ type: "number", inputmode: "numeric", min: "1", value: "5" });
      const b = el("button", { class: "go" }, "申し出る") as HTMLButtonElement;
      b.addEventListener("click", () => {
        if (!team.value.trim()) return toast("相手のチーム名を入れてください", true);
        void run(() => tapi.offerSupply({ team: team.value.trim(), partId: part.value, unitPrice: Math.floor(Number(unit.value)), maxUnits: Math.floor(Number(max.value)) }), "申し出ました");
      });
      o.append(el("div", { class: "tm-form" }, field("相手のチーム名", team), field("部品", part), field("1 個の値段", unit), field("この季節の数の上限", max), el("div", { class: "wide row" }, b)));
      o.append(el("p", { class: "dim", style: "font-size:12px;margin:10px 0 0" }, `注文が来たら、作るお金はあなたが払い、売れた値から手数料 ${Math.round(view.feeRate * 100)}% を引いて受け取ります`));
    }
    return el("div", { class: "tm-body" }, f, o);
  }

  void reload();
  // 時間の表示と決着を拾うため、ときどき読み直す
  const poll = window.setInterval(() => {
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement;
    if (!busy && !typing && document.visibilityState === "visible" && tab !== "sell") void reload();
  }, 30_000);
  return () => {
    alive = false;
    clearInterval(poll);
  };
}
