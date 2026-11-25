// 公式のお店 (段階 1〜2 の部品をいつでも買える) と持ち物。買うにはログインが要る
import { KIND_NAMES, MAX_BUY, PARTS, anyPartDef, inventoryItems, shopList, type Inventory, type PartKind } from "@bpr/shared";
import * as api from "../api.ts";
import type { Go } from "../main.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import "./account.css";

const KIND_ORDER: PartKind[] = ["seat", "engine", "tire", "tank", "wing", "brake", "frame"];

/** toAccount = ログインの画面へ (ルーターから渡す) */
export function mountShop(root: HTMLElement, go: Go, toAccount?: () => void): () => void {
  const sheet = el("div", { class: "sheet acc" });
  root.append(sheet);
  let alive = true;
  // 値段はサーバーの表を使う (読めないあいだは同じ式の手元の表)
  let prices = new Map(shopList().map((x) => [x.id, x.price]));
  const qty = new Map<string, number>();
  let busy = false;

  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  sheet.append(el("div", { class: "acc-top" }, back, el("h2", {}, "お店"), el("span", { class: "label" }, "parts shop · tier 1–2")));
  const head = el("div");
  const list = el("div");
  sheet.append(head, list);

  // 同じ中身なら描き直さない (読み直しのたびに押したボタンが消えないように)
  let shown = "";
  const render = (force = false) => {
    if (!alive) return;
    const sig = JSON.stringify([api.isLoggedIn(), api.cachedMe(), api.ownedParts(), [...prices]]);
    if (!force && sig === shown) return;
    shown = sig;
    const me = api.cachedMe();
    const parts = api.ownedParts();
    const logged = api.isLoggedIn();
    head.innerHTML = "";
    list.innerHTML = "";

    if (!logged) {
      const b = el("button", { class: "go" }, "ログイン・はじめる") as HTMLButtonElement;
      b.addEventListener("click", () => toAccount?.());
      b.hidden = !toAccount;
      head.append(el("div", { class: "frame", style: "margin-bottom:14px" }, el("div", { class: "callout" }, "部品を買うにはログインが要ります。見るだけならこのままで"), el("div", { class: "row", style: "margin-top:10px" }, b)));
    } else {
      head.append(
        el(
          "div",
          { class: "acc-plate", style: "margin-bottom:14px" },
          el("div", { class: "who" }, el("div", { class: "team" }, me?.team ?? ""), el("div", { class: "driver" }, me?.driver ?? "…")),
          el("div", { class: "wallet" }, el("span", { class: "label" }, "財布"), el("span", { class: "acc-money" }, me ? money(me.money) : "…")),
        ),
      );
    }

    const frame = el("div", { class: "frame" });
    frame.append(
      el("div", { class: "section-title" }, el("h3", {}, "部品"), el("span", { class: "label" }, logged ? "持っている数 · 値段" : "値段")),
      el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, "部品は使っても減りません。設計図ごとに、持っている数まで置けます。"),
    );
    for (const kind of KIND_ORDER) {
      const defs = PARTS.filter((p) => p.kind === kind && prices.has(p.id));
      if (!defs.length) continue;
      frame.append(el("div", { class: "shop-kind" }, KIND_NAMES[kind]));
      const box = el("div", { class: "shop-list" });
      for (const def of defs) box.append(row(def.id, parts, me?.money ?? 0, logged));
      frame.append(box);
    }
    list.append(frame);

    // 限界突破の品 (景品・ギフトコードでだけ手に入る。売り買いできない)
    const items = parts ? inventoryItems(parts) : [];
    if (items.length) {
      const box = el("div", { class: "shop-list" });
      for (const { def, count } of items) {
        box.append(
          el(
            "div",
            { class: "shop-row" },
            el("div", { class: "bar", style: "background:#ffc94a" }),
            el("div", { class: "info" }, el("div", { class: "name" }, el("span", {}, def.name)), el("div", { class: "note" }, def.note), el("div", { class: "owned" }, "持っている ", el("b", {}, `×${count}`))),
          ),
        );
      }
      list.append(
        el(
          "div",
          { class: "frame", style: "margin-top:14px" },
          el("div", { class: "section-title" }, el("h3", {}, "限界突破の品"), el("span", { class: "label" }, "items")),
          el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, "使うのは 研究 → 限界突破 の札から。お店で買えず、市場でも売れません"),
          box,
        ),
      );
    }

    // お店で売っていない持ち物 (研究開発・進化・市場で手に入れた部品)
    const others = parts ? Object.entries(parts).filter(([id, n]) => n > 0 && !prices.has(id) && !!anyPartDef(id)) : [];
    if (others.length) {
      const box = el("div", { class: "shop-list" });
      for (const [id] of others) box.append(row(id, parts, 0, false));
      list.append(el("div", { class: "frame", style: "margin-top:14px" }, el("div", { class: "section-title" }, el("h3", {}, "ほかの持ち物"), el("span", { class: "label" }, "inventory")), box));
    }
  };

  function row(id: string, parts: Inventory | null, wallet: number, canBuy: boolean): HTMLElement {
    const def = anyPartDef(id)!;
    const price = prices.get(id);
    const owned = parts?.[id] ?? 0;
    const n = qty.get(id) ?? 1;
    const info = el(
      "div",
      { class: "info" },
      el("div", { class: "name" }, el("span", {}, def.name), el("span", { class: `tier t${def.tier}` }, `T${def.tier}${"+".repeat(def.limit ?? 0)}`)),
      el("div", { class: "note" }, `${def.note} · ${def.w}×${def.h} マス · ${def.mass} kg`),
      parts ? el("div", { class: "owned" }, "持っている ", el("b", {}, `×${owned}`)) : null,
    );
    const r = el("div", { class: "shop-row" }, el("div", { class: `bar k-${def.kind}` }), info);
    if (price === undefined) return r;

    const priceEl = el("span", { class: "price" }, money(price * n));
    const buyBox = el("div", { class: "shop-buy" });
    if (canBuy) {
      const minus = el("button", { "aria-label": "減らす" }, "−") as HTMLButtonElement;
      const plus = el("button", { "aria-label": "増やす" }, "＋") as HTMLButtonElement;
      const num = el("span", {}, String(n));
      const buyBtn = el("button", { class: "go" }, "買う") as HTMLButtonElement;
      const sync = () => {
        const k = qty.get(id) ?? 1;
        num.textContent = String(k);
        priceEl.textContent = money(price * k);
        minus.disabled = k <= 1;
        plus.disabled = k >= MAX_BUY;
        buyBtn.disabled = busy || price * k > wallet;
        buyBtn.title = price * k > wallet ? `お金が足りない (あと ${money(price * k - wallet)})` : "";
      };
      minus.addEventListener("click", () => {
        qty.set(id, Math.max(1, (qty.get(id) ?? 1) - 1));
        sync();
      });
      plus.addEventListener("click", () => {
        qty.set(id, Math.min(MAX_BUY, (qty.get(id) ?? 1) + 1));
        sync();
      });
      buyBtn.addEventListener("click", async () => {
        const k = qty.get(id) ?? 1;
        busy = true;
        buyBtn.disabled = true;
        try {
          await api.buy(id, k);
          qty.set(id, 1);
          toast(`${def.name} ×${k} を買いました`);
        } catch (e) {
          toast(errText(e), true);
        } finally {
          busy = false;
          render(true);
        }
      });
      sync();
      buyBox.append(priceEl, el("div", { class: "shop-step" }, minus, num, plus), buyBtn);
    } else {
      buyBox.append(priceEl);
    }
    r.append(buyBox);
    return r;
  }

  const off = api.onAccountChange(() => render());
  render(true);
  api
    .fetchShop()
    .then((items) => {
      prices = new Map(items.map((x) => [x.id, x.price]));
      render();
    })
    .catch(() => {});
  api.refreshAccount().catch((e) => {
    if (alive && api.isLoggedIn()) toast(errText(e), true);
  });

  return () => {
    alive = false;
    off();
  };
}
