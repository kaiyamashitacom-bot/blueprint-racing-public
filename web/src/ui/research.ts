// 研究の画面: 進めている研究 (寝ている間も進む)・研究の木 (段階 3 → 4 → 5)・できた部品を作る
// 札 3 つ: 研究の木 (新しい種類 冷却・電池・ギア箱・サスペンション・重り も) / 進化 (持っている部品を育てる・枝分かれ) /
// 限界突破 (限界設計図で 5+・5++、特別指導書、かけら)。DECISIONS 11/25「部品は進化と研究で広げる」「限界突破の品」
import { DEV_PART_KINDS, KIND_NAMES, SHARDS_PER_ITEM, type PartDef, type PartKind } from "@bpr/shared";
import { kindColors } from "../draw.ts";
import * as api from "../api.ts";
import * as tapi from "../team_api.ts";
import type { Go } from "../main.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import { left, loginGate, paintWallet, shortOfMoney, teamSheet, whyNot } from "./teamkit.ts";

const KINDS: PartKind[] = ["engine", "tire", "tank", "wing", "brake", ...DEV_PART_KINDS];
type Tab = "tree" | "evo" | "limit";
const TAB_LABEL: Record<Tab, [string, string]> = { tree: ["研究の木", "Tree"], evo: ["進化", "Evolution"], limit: ["限界突破", "Limit break"] };
/** 最後に開いた札 (この機械に覚える) */
let lastTab: Tab = "tree";

/** 部品の数字を短く */
export function partSpec(p: PartDef): string {
  const out: string[] = [`${p.w}×${p.h}`, `${p.mass} kg`];
  if (p.power !== undefined) out.push(`力 ${p.power}`);
  if (p.fuelUse !== undefined) out.push(`燃費 ×${p.fuelUse}`);
  if (p.grip !== undefined) out.push(`握り ${p.grip}`);
  if (p.fuel !== undefined) out.push(`${p.fuel} L`);
  if (p.downforce !== undefined) out.push(`押しつけ ${p.downforce}`);
  if (p.drag !== undefined) out.push(`抵抗 ${p.drag}`);
  if (p.brake !== undefined) out.push(`止まる ${p.brake}`);
  if (p.cool !== undefined) out.push(`燃料 −${Math.round(p.cool * 1000) / 10}%`);
  if (p.battery !== undefined) out.push(`OT +${p.battery} 秒`);
  if (p.shift !== undefined) out.push(`MT +${Math.round(p.shift * 1000) / 10}%`);
  if (p.susp !== undefined) out.push(`縁石・芝 ${Math.round(p.susp * 100)}%`);
  if (p.sturdy !== undefined) out.push(`頑丈 −${Math.round(p.sturdy * 100)}%`);
  return out.join(" · ");
}

export function mountResearch(root: HTMLElement, go: Go): () => void {
  const { body, wallet } = teamSheet(root, go, "research");
  let alive = true;
  if (!api.isLoggedIn()) {
    body.append(loginGate(go));
    return () => {};
  }
  let v: tapi.ResearchView | null = null;
  let ev: tapi.EvolutionView | null = null;
  let tab: Tab = lastTab;
  /** 進化: 持っている部品から進める物だけ見せる */
  let onlyOwned = true;
  let busy = false;
  const qty = new Map<string, number>();
  let timer = 0;
  body.append(el("div", { class: "frame dim" }, "読みこんでいます…"));

  const reload = async () => {
    try {
      [v, ev] = await Promise.all([tapi.fetchResearch(), tapi.fetchEvolution()]);
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

  /** 進み具合だけを 1 秒ごとに描き直す */
  const tickEls: Array<() => void> = [];

  function render() {
    if (!v) return;
    const view = v;
    paintWallet(wallet, view.money);
    body.innerHTML = "";
    tickEls.length = 0;
    clearInterval(timer);

    const tabs = el("div", { class: "tm-tabs", role: "tablist" });
    for (const t of ["tree", "evo", "limit"] as Tab[]) {
      const b = el("button", { role: "tab", class: t === tab ? "on" : "", "aria-selected": String(t === tab) }, el("b", {}, TAB_LABEL[t][0]), el("span", { class: "label" }, TAB_LABEL[t][1])) as HTMLButtonElement;
      b.addEventListener("click", () => {
        tab = lastTab = t;
        render();
      });
      tabs.append(b);
    }
    body.append(tabs);
    if (tab === "evo") return renderEvo();
    if (tab === "limit") return renderLimit();

    // 進めている研究
    const act = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "進めている研究"), el("span", { class: "label" }, "In progress")));
    if (view.active.length) {
      for (const a of view.active) {
        const bar = el("i", {});
        const when = el("b", { class: "tm-num" });
        const pct = el("span", { class: "tm-num dim" });
        const paint = () => {
          const total = a.eta - a.startedAt;
          const p = total > 0 ? Math.max(0, Math.min(1, (Date.now() - a.startedAt) / total)) : 1;
          const prog = Math.max(a.progress, p);
          bar.style.width = `${Math.round(prog * 1000) / 10}%`;
          when.textContent = left(a.eta - Date.now());
          pct.textContent = `${Math.floor(prog * 100)}%`;
          if (a.eta <= Date.now() && alive) {
            clearInterval(timer);
            setTimeout(() => void reload(), 1500);
          }
        };
        paint();
        tickEls.push(paint);
        const cancel = el("button", { class: "danger small" }, "やめる") as HTMLButtonElement;
        cancel.addEventListener("click", () => {
          if (!confirm(`${a.name} の研究をやめます。入れたお金は戻りません。よいですか`)) return;
          void run(() => tapi.cancelResearch(a.researchId), "研究をやめました");
        });
        act.append(
          el(
            "div",
            { class: "tm-active" },
            el("div", { class: "when" }, el("span", { style: "font-weight:900;font-size:18px" }, a.name), el("span", { class: "dim" }, "あと"), when, pct),
            el("div", { class: "tm-progress" }, bar),
            el("div", { class: "row" }, a.boostMs > 0 ? el("span", { class: "dim", style: "font-size:12px" }, `走って ${Math.round(a.boostMs / 60_000)} 分 縮めた`) : null, cancel),
          ),
        );
      }
    } else act.append(el("p", { class: "dim", style: "margin:0" }, "研究はしていません。下の木から選んでください (1 つずつ)"));
    act.append(el("p", { class: "dim", style: "font-size:12px;margin:8px 0 0" }, "研究は寝ている間も進みます。元になる部品を付けて走ると早く進みます (最大で半分の時間)"));
    body.append(act);

    // 研究の木
    for (const kind of KINDS) {
      const nodes = view.tree.filter((n) => n.part.kind === kind);
      if (!nodes.length) continue;
      const dev = (DEV_PART_KINDS as readonly string[]).includes(kind);
      const f = el(
        "section",
        { class: "frame tm-kind", style: `--kc:${kindColors()[kind]}` },
        el("div", { class: "section-title" }, el("h3", { class: "tm-kh" }, KIND_NAMES[kind]), el("span", { class: "label" }, dev ? "New · 研究でだけ開発" : "Tier 3 → 5")),
      );
      const tree = el("div", { class: "tm-tree" });
      for (const tier of [3, 4, 5]) for (const n of nodes.filter((x) => x.part.tier === tier)) tree.append(node(n, view));
      f.append(tree);
      body.append(f);
    }
    clearInterval(timer);
    if (tickEls.length) timer = window.setInterval(() => tickEls.forEach((f) => f()), 1000);
  }

  /** チームの個性: 持っている部品の枝 (力寄り・頑丈 …) の数 */
  function identity(view: tapi.EvolutionView): HTMLElement {
    const tally = new Map<string, number>();
    for (const r of view.recipes) {
      if (!r.branch) continue;
      const n = view.parts[r.to] ?? 0;
      if (n > 0) tally.set(r.to, n);
    }
    const byBranch = new Map<string, number>();
    for (const r of view.recipes) {
      if (!r.branch || !tally.has(r.to)) continue;
      const key = r.branch.replace(/ \(.+\)$/, "");
      byBranch.set(key, (byBranch.get(key) ?? 0) + tally.get(r.to)!);
      tally.delete(r.to);
    }
    const chips = el("div", { class: "tm-ident" });
    for (const [b, n] of [...byBranch.entries()].sort((a, c) => c[1] - a[1])) chips.append(el("span", { class: "chip" }, b, el("b", { class: "tm-num" }, `×${n}`)));
    if (!byBranch.size) chips.append(el("span", { class: "dim" }, "まだ枝を選んでいません。部品を進化させると、選んだ枝がチームの個性になります"));
    return el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "チームの個性"), el("span", { class: "label" }, "Branches taken")), chips);
  }

  function renderEvo() {
    const view = ev;
    if (!view) return;
    body.append(identity(view));
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = onlyOwned;
    const filt = el("label", { class: "tm-filter" }, box, " 持っている部品から進めるものだけ");
    box.addEventListener("change", (e) => {
      onlyOwned = (e.target as HTMLInputElement).checked;
      render();
    });
    body.append(
      el(
        "section",
        { class: "frame" },
        el("p", { class: "dim", style: "margin:0 0 6px;font-size:13px" }, "持っている部品 1 つを お金で 1 つ上に育てます (段階 3 から先は その研究が済んでいること)。枝分かれでは どちらか 1 つを選びます。形が変わる部品もあります"),
        filt,
      ),
    );
    let shown = 0;
    for (const kind of KINDS) {
      const list = view.recipes.filter((r) => r.toPart?.kind === kind && (!onlyOwned || r.owned > 0));
      if (!list.length) continue;
      const f = el("section", { class: "frame tm-kind", style: `--kc:${kindColors()[kind]}` }, el("div", { class: "section-title" }, el("h3", { class: "tm-kh" }, KIND_NAMES[kind]), el("span", { class: "label" }, "Evolution")));
      // 元の部品ごとにまとめる (枝分かれは 1 つの行に並ぶ)
      const froms = [...new Set(list.map((r) => r.from))].sort((a, b) => (list.find((r) => r.from === a)!.fromPart?.tier ?? 0) - (list.find((r) => r.from === b)!.fromPart?.tier ?? 0));
      for (const from of froms) {
        const rs = list.filter((r) => r.from === from);
        const fp = rs[0].fromPart;
        const row = el("div", { class: `tm-evo${rs.length > 1 ? " branch" : ""}` });
        row.append(
          el("div", { class: "src" }, el("span", { class: "tier" }, `T${fp?.tier ?? "?"}`), el("b", {}, fp?.name ?? from), el("span", { class: "tm-num dim" }, ` ×${rs[0].owned}`), rs.length > 1 ? el("span", { class: "fork" }, "枝分かれ") : null),
        );
        const outs = el("div", { class: "outs" });
        for (const r of rs) outs.append(evoCard(r, view));
        row.append(outs);
        f.append(row);
        shown++;
      }
      body.append(f);
    }
    if (!shown) body.append(el("div", { class: "frame dim" }, onlyOwned ? "持っている部品から進める進化はありません (下の印を外すと全部の道すじが見えます)" : "進化はありません"));
  }

  function evoCard(r: tapi.EvolutionView["recipes"][number], view: tapi.EvolutionView): HTMLElement {
    const tp = r.toPart;
    const fp = r.fromPart;
    const shape = tp && fp && (tp.w !== fp.w || tp.h !== fp.h) ? `形 ${fp.w}×${fp.h} → ${tp.w}×${tp.h}` : null;
    const short = shortOfMoney(r.cost, view.money);
    const why = !r.unlocked ? `先に「${r.requiresName ?? ""}」の研究` : r.owned < 1 ? "元の部品がありません" : short;
    const b = el("button", { class: "go small" }, "進化") as HTMLButtonElement;
    whyNot(b, why);
    b.addEventListener("click", () => {
      if (!confirm(`${fp?.name ?? r.from} 1 つを ${money(r.cost)} で ${tp?.name ?? r.to} にします。元の部品はなくなります。よいですか`)) return;
      void run(() => tapi.evolvePart(r.id), `${tp?.name ?? r.to} に進化しました`);
    });
    return el(
      "div",
      { class: `tm-node ${r.unlocked ? (r.owned > 0 ? "open" : "") : "locked"}` },
      el("div", { class: "nm" }, el("span", { class: "tier" }, `T${tp?.tier ?? "?"}`), el("span", {}, tp?.name ?? r.to), r.branch ? el("span", { class: "chip" }, r.branch) : null),
      el("div", { class: "note" }, tp?.note ?? ""),
      el("div", { class: "spec" }, tp ? partSpec(tp) : ""),
      shape ? el("div", { class: "tm-state short" }, shape) : null,
      el("div", { class: `tm-state${why ? " short" : " good"}` }, why ?? "進化できる"),
      el("div", { class: "act" }, el("span", { class: "price tm-num" }, money(r.cost)), el("span", { class: "dim", style: "font-size:12px" }, `持っている ×${view.parts[r.to] ?? 0}`), b),
    );
  }

  function renderLimit() {
    const view = ev;
    if (!view) return;
    const count = (id: string) => view.items.find((x) => x.id === id)?.count ?? 0;
    const BP = "item:limit_bp";
    const BOOK = "item:coach_book";
    // 品の数
    const items = el("div", { class: "tm-items" });
    for (const [id, name, note] of [
      [BP, "限界設計図", "段階 5 の部品を 5+ → 5++ に (1 回 +4%)"],
      [BOOK, "特別指導書", "雇った運転手の伸びしろ +5 (1 人 2 回まで)"],
      ["item:limit_shard", "限界突破のかけら", `${SHARDS_PER_ITEM} 個で 限界設計図`],
      ["item:coach_shard", "指導のかけら", `${SHARDS_PER_ITEM} 個で 特別指導書`],
    ] as const) {
      const n = count(id);
      const cell = el("div", { class: `tm-item${n > 0 ? " have" : ""}` }, el("b", { class: "tm-num" }, `×${n}`), el("span", { class: "nm" }, name), el("span", { class: "note" }, note));
      if (id.endsWith("_shard")) {
        const b = el("button", { class: "small" }, `${SHARDS_PER_ITEM} 個 → 1 つ`) as HTMLButtonElement;
        whyNot(b, n >= SHARDS_PER_ITEM ? null : `あと ${SHARDS_PER_ITEM - n} 個`);
        b.addEventListener("click", () => void run(() => tapi.convertShards(id, 1), "かけらを品にしました"));
        cell.append(b);
      }
      items.append(cell);
    }
    body.append(
      el(
        "section",
        { class: "frame" },
        el("div", { class: "section-title" }, el("h3", {}, "限界突破の品"), el("span", { class: "label" }, "Items")),
        items,
        el("p", { class: "dim", style: "font-size:12px;margin:8px 0 0" }, "景品 (チャンピオン・王者を 7 日・リーグ戦の週の 1 位・大会の優勝・1 周アタックの週の 1 位) でだけ手に入ります。お店で買えず、市場でも売れません"),
      ),
    );
    // 限界設計図
    const lim = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "部品の限界を超える"), el("span", { class: "label" }, "5+ / 5++")));
    if (view.limits.length) {
      const grid = el("div", { class: "tm-tree" });
      for (const l of view.limits) {
        const b = el("button", { class: "go small" }, "超える") as HTMLButtonElement;
        whyNot(b, count(BP) > 0 ? null : "限界設計図がありません");
        b.addEventListener("click", () => {
          if (!confirm(`限界設計図 1 つで ${l.part.name} 1 つを ${l.next.name} にします。よいですか`)) return;
          void run(() => tapi.limitBreakPart(l.id), `${l.next.name} になりました`);
        });
        grid.append(
          el(
            "div",
            { class: "tm-node open", style: `--kc:${kindColors()[l.part.kind]}` },
            el("div", { class: "nm" }, el("span", { class: "tier gold" }, `T5${"+".repeat((l.part.limit ?? 0) + 1)}`), el("span", {}, l.next.name)),
            el("div", { class: "spec" }, partSpec(l.next)),
            el("div", { class: "tm-state" }, `今: ${partSpec(l.part)}`),
            el("div", { class: "act" }, el("span", { class: "dim", style: "font-size:12px;margin-right:auto" }, `持っている ×${l.owned}`), b),
          ),
        );
      }
      lim.append(grid);
    } else lim.append(el("p", { class: "dim", style: "margin:0" }, "段階 5 の部品 (か 5+) を持つと、ここで限界を超えられます (重りは超えられません)"));
    body.append(lim);
    // 特別指導書
    const coach = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "特別指導"), el("span", { class: "label" }, "Coaching")));
    const d = view.driver;
    if (d) {
      const b = el("button", { class: "go small" }, "指導書を使う") as HTMLButtonElement;
      whyNot(b, d.coached >= d.coachMax ? "この運転手にはもう 2 回使いました" : count(BOOK) > 0 ? null : "特別指導書がありません");
      b.addEventListener("click", () => {
        if (!confirm(`${d.name} に特別指導書を使います (伸びしろ 能力ごとに +5、100 まで)。よいですか`)) return;
        void run(() => tapi.coachDriver(), `${d.name} の伸びしろが上がりました`);
      });
      coach.append(el("div", { class: "row", style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, el("b", {}, d.name), el("span", { class: "dim" }, `使った回数 ${d.coached} / ${d.coachMax}`), b));
    } else coach.append(el("p", { class: "dim", style: "margin:0" }, "運転手を雇うと 特別指導書を使えます"));
    body.append(coach);
  }

  function node(n: tapi.ResearchNode, view: tapi.ResearchView): HTMLElement {
    // 始められる研究でも、お金が足りなければ そう書く (QA 2 回目: 「始められる」なのに押せなかった)
    const short = n.state === "open" ? shortOfMoney(n.cost, view.money) : null;
    const STATE: Record<tapi.ResearchNode["state"], string> = {
      done: "できた",
      active: "研究中",
      open: short ?? "始められる",
      busy: "ほかの研究中",
      locked: `先に「${n.requiresName ?? ""}」`,
    };
    const box = el(
      "div",
      { class: `tm-node ${n.state}` },
      el("div", { class: "nm" }, el("span", { class: "tier" }, `T${n.part.tier}`), el("span", {}, n.part.name)),
      el("div", { class: "note" }, n.part.note),
      el("div", { class: "spec" }, partSpec(n.part)),
      el("div", { class: `tm-state${n.state === "done" ? " good" : short ? " short" : ""}` }, STATE[n.state], n.state !== "done" ? ` · 早める部品: ${n.boost.join("・")}` : ""),
    );
    const act = el("div", { class: "act" });
    if (n.state === "open" || n.state === "busy" || n.state === "locked") {
      const b = el("button", { class: "go small" }, "始める") as HTMLButtonElement;
      // 押せないわけは上の札 (tm-state: 先の研究・ほかの研究中・お金が足りない) に出ている。ボタンの title にも入れる
      whyNot(b, n.state === "busy" ? "ほかの研究中 (1 つずつ)" : n.state === "locked" ? STATE.locked : short);
      b.addEventListener("click", () => {
        if (!confirm(`${n.part.name} の研究を ${money(n.cost)} で始めます (${n.hours} 時間)。よいですか`)) return;
        void run(() => tapi.startResearch(n.id), `${n.part.name} の研究を始めました`);
      });
      act.append(el("span", { class: "price tm-num" }, money(n.cost)), el("span", { class: "dim", style: "font-size:12px" }, `${n.hours} 時間`), b);
    } else if (n.state === "done") {
      const k = qty.get(n.part.id) ?? 1;
      const minus = el("button", { "aria-label": "減らす" }, "−") as HTMLButtonElement;
      const plus = el("button", { "aria-label": "増やす" }, "＋") as HTMLButtonElement;
      const num = el("span", {}, String(k));
      const price = el("span", { class: "price tm-num" }, money(n.buildCost * k));
      const make = el("button", { class: "go small" }, "作る") as HTMLButtonElement;
      let why: HTMLElement | null = null;
      const sync = () => {
        const q = qty.get(n.part.id) ?? 1;
        num.textContent = String(q);
        price.textContent = money(n.buildCost * q);
        minus.disabled = q <= 1;
        plus.disabled = q >= view.manufactureMax;
        why = whyNot(make, shortOfMoney(n.buildCost * q, view.money), why);
        if (why && make.parentNode === act && why.parentNode !== act) act.append(why);
      };
      minus.addEventListener("click", () => {
        qty.set(n.part.id, Math.max(1, (qty.get(n.part.id) ?? 1) - 1));
        sync();
      });
      plus.addEventListener("click", () => {
        qty.set(n.part.id, Math.min(view.manufactureMax, (qty.get(n.part.id) ?? 1) + 1));
        sync();
      });
      make.addEventListener("click", () => {
        const q = qty.get(n.part.id) ?? 1;
        void run(() => tapi.manufacture(n.part.id, q), `${n.part.name} を ${q} 個作りました`);
      });
      sync();
      act.append(price, el("div", { class: "shop-step" }, minus, num, plus), make);
      if (why) act.append(why);
      box.append(el("div", { class: "tm-kv" }, el("span", {}, "持っている ", el("b", {}, `×${view.parts[n.part.id] ?? 0}`))));
    }
    box.append(act);
    return box;
  }

  void reload();
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
