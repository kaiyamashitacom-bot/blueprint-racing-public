// 運転手の画面: 自分の運転手 (2 台目) と、雇える候補。候補は全チーム共通で早い者勝ち。
// 得意の札 (短い説明つき)・珍しい運転手の札・国と年代の札・得意で絞る
import { SPECIALTIES, SPECIALTY_IDS, TRACK_DEFS, type SpecialtyId } from "@bpr/shared";
import * as api from "../api.ts";
import * as tapi from "../team_api.ts";
import type { Go } from "../main.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import { STAT_NAMES, left, loginGate, paintWallet, shortOfMoney, statBar, teamSheet, whyNot } from "./teamkit.ts";
import "./drivers.css";

const KEYS = ["speed", "stability", "tyreFuel", "pitSense"] as const;

const isSpec = (s: string): s is SpecialtyId => s in SPECIALTIES;

/** 得意の札 (名前 + 短い説明) */
function specBadges(specs: readonly string[] | undefined): HTMLElement | null {
  const list = (specs ?? []).filter(isSpec);
  if (!list.length) return null;
  return el(
    "ul",
    { class: "dr-specs", "aria-label": "得意" },
    ...list.map((s) => el("li", { class: `dr-spec s-${s}` }, el("b", {}, SPECIALTIES[s].name), el("span", {}, SPECIALTIES[s].note))),
  );
}

/** 珍しい・国・年代・伸びしろ の札 */
function metaRow(d: tapi.DriverView): HTMLElement {
  const room = Math.round(KEYS.reduce((s, k) => s + Math.max(0, d.potential[k] - d.stats[k]), 0) / KEYS.length);
  return el(
    "div",
    { class: "dr-meta" },
    d.rare ? el("span", { class: "dr-rare", title: "季節のごほうび・ギフトコードでしか会えない" }, "★ 珍しい") : null,
    d.nat ? el("span", { class: "dr-tag" }, d.nat) : null,
    d.era ? el("span", { class: "dr-tag" }, `${d.era}年代`) : null,
    el("span", { class: `dr-tag grow${room >= 25 ? " big" : ""}`, title: "育つ余地 (能力の平均)" }, `伸びしろ +${room}`),
  );
}

export function mountDrivers(root: HTMLElement, go: Go): () => void {
  const { body, wallet } = teamSheet(root, go, "drivers");
  let alive = true;
  if (!api.isLoggedIn()) {
    body.append(loginGate(go));
    return () => {};
  }
  let v: tapi.DriversView | null = null;
  let busy = false;
  /** 得意で絞る (all = 全部) */
  let filter: SpecialtyId | "all" = "all";
  body.append(el("div", { class: "frame dim" }, "読みこんでいます…"));

  const reload = async () => {
    try {
      v = await tapi.fetchDrivers();
      if (alive) render();
    } catch (e) {
      if (!alive) return;
      body.innerHTML = "";
      body.append(el("div", { class: "frame bad" }, errText(e)));
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

  const card = (d: tapi.DriverView, mine: boolean): HTMLElement => {
    const c = el(
      "div",
      { class: `tm-driver dr-card${mine ? " mine" : ""}${d.rare ? " rare" : ""}${d.prizeUntil !== undefined ? " prize" : ""}` },
      el("div", { class: "head" }, el("span", { class: "nm" }, d.name), el("span", { class: "ovr tm-num" }, el("small", {}, "総合"), String(Math.round(d.overall)))),
      metaRow(d),
      specBadges(d.specs),
      ...KEYS.map((k) => statBar(STAT_NAMES[k], d.stats[k], d.potential[k])),
      el("div", { class: "tm-kv" }, el("span", {}, "レース ", el("b", {}, String(d.races))), el("span", {}, "1 季節 ", el("b", {}, money(d.fee)))),
    );
    return c;
  };

  function render() {
    if (!v) return;
    const view = v;
    paintWallet(wallet, view.money);
    body.innerHTML = "";

    // 自分の運転手
    const mineF = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "あなたの運転手"), el("span", { class: "label" }, "Car 02")));
    if (view.mine) {
      const d = view.mine;
      const c = card(d, true);
      const fam = el("div", { class: "tm-kv" }, el("span", {}, "コースの慣れ"));
      for (const t of TRACK_DEFS) fam.append(el("span", {}, `${t.name} `, el("b", { class: "tm-num" }, `${Math.round((d.fam?.[t.id] ?? 0) * 100)}%`)));
      const renew = el("label", { class: "row", style: "font-size:13px;gap:6px" });
      const box = el("input", { type: "checkbox", style: "min-height:0;width:22px;height:22px" }) as HTMLInputElement;
      box.checked = !!d.renew;
      box.addEventListener("change", () => run(() => tapi.setRenew(box.checked), box.checked ? "次の季節も続けます" : "季節の切れ目で離れます (違約金なし)"));
      renew.append(box, "次の季節も続ける (自動で契約金を払う)");
      const rel = el("button", { class: "danger small" }, `手放す · 違約金 ${money(d.penalty ?? 0)}`) as HTMLButtonElement;
      rel.addEventListener("click", () => {
        if (!confirm(`${d.name} を手放します。違約金 ${money(d.penalty ?? 0)} を払います。よいですか`)) return;
        void run(() => tapi.releaseDriver(), `${d.name} を手放しました`);
      });
      c.append(fam, el("div", { class: "foot" }, renew, rel));
      mineF.append(c);
    } else {
      mineF.append(el("p", { class: "dim", style: "margin:0" }, "まだ雇っていません。下の候補から選ぶと、すぐ走るに 2 台目が出ます"));
    }
    body.append(mineF);

    // 候補
    const listF = el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "雇える運転手"), el("span", { class: "label" }, `${view.free.length} free`)),
      el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, `契約は季節ごと。今雇うと季節の残りの分を払います (季節の残り ${left(view.season.endsAt - Date.now())})。緑の棒は育つ余地`),
      (view.discountPct ?? 0) > 0 ? el("div", { class: "callout ok", style: "margin:0 0 10px" }, `ギフトの割引: 次に雇うときの契約金が ${view.discountPct}% 引き (下の値は引いたあと)`) : null,
    );
    for (const d of view.free.filter((x) => x.prizeUntil !== undefined)) {
      listF.append(el("div", { class: "callout ok dr-prize-note" }, `季節のごほうび: ★ ${d.name} と ただで契約できます (第 ${(d.prizeUntil ?? 0) + 1} 季の終わりまで。次の季節からは契約金がかかります)`));
    }

    // 得意で絞る (数つき)
    const count = (s: SpecialtyId) => view.free.filter((d) => d.specs?.includes(s)).length;
    if (filter !== "all" && count(filter) === 0) filter = "all";
    const chips = el("div", { class: "dr-filter", role: "group", "aria-label": "得意で絞る" });
    const chip = (id: SpecialtyId | "all", label: string, n: number) => {
      const b = el("button", { type: "button", class: `dr-chip${id === "all" ? "" : ` s-${id}`}`, "aria-pressed": String(filter === id) }, label, el("small", { class: "tm-num" }, String(n))) as HTMLButtonElement;
      b.disabled = n === 0;
      b.addEventListener("click", () => {
        filter = filter === id ? "all" : id;
        render();
      });
      return b;
    };
    chips.append(chip("all", "すべて", view.free.length), ...SPECIALTY_IDS.map((s) => chip(s, SPECIALTIES[s].name, count(s))));
    listF.append(chips);
    if (filter !== "all") listF.append(el("p", { class: "dr-filter-note dim" }, `${SPECIALTIES[filter].name}: ${SPECIALTIES[filter].note}`));

    const grid = el("div", { class: "tm-drivers" });
    for (const d of view.free.filter((x) => filter === "all" || x.specs?.includes(filter))) {
      const c = card(d, false);
      const prize = d.prizeUntil !== undefined;
      const full = d.signCost ?? d.fee;
      const cost = full - Math.floor((full * (view.discountPct ?? 0)) / 100);
      const total = cost + (view.mine?.penalty ?? 0);
      const b = el("button", { class: "go small" }, prize ? "ただで契約" : view.mine ? "入れ替える" : "雇う") as HTMLButtonElement;
      const why = whyNot(b, shortOfMoney(total, view.money));
      b.addEventListener("click", () => {
        const what = prize ? `${d.name} と ただで契約します (次の季節から 1 季節 ${money(d.fee)})` : `${d.name} を ${money(cost)} で雇います`;
        const msg = view.mine ? `${view.mine.name} を手放して (違約金 ${money(view.mine.penalty ?? 0)})、${what}。よいですか` : `${what}。よいですか`;
        if (!confirm(msg)) return;
        void run(() => tapi.hireDriver(d.id), `${d.name} を雇いました`);
      });
      c.append(
        el(
          "div",
          { class: "foot" },
          el("span", { class: "price tm-num" }, prize ? "ごほうび" : money(cost)),
          b,
          ...(why ? [why] : []),
        ),
      );
      grid.append(c);
    }
    listF.append(grid);
    body.append(listF);
  }

  void reload();
  return () => {
    alive = false;
  };
}
