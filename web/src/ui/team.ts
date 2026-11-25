// チームの画面: 紋章・2 台 (自分と雇った運転手) の設計図・財布・整備の組。研究の進みと知らせもここから
import { EMBLEM_COLORS, EMBLEM_MARKS, EMBLEM_SHAPES, TRACK_DEFS, validateDesign, type Emblem } from "@bpr/shared";
import * as api from "../api.ts";
import * as tapi from "../team_api.ts";
import type { Go } from "../main.ts";
import { load } from "../store.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import { emblemSvg, emptyOption, left, loginGate, noticeBell, paintWallet, setBell, shortOfMoney, teamSheet, whyNot } from "./teamkit.ts";
import { leagueTitleTag } from "./league.ts";
import "./gift.css";

const SHAPE_NAMES: Record<string, string> = { circle: "丸", square: "四角", shield: "盾", diamond: "ひし形", hexagon: "六角", triangle: "三角" };
const MARK_NAMES: Record<string, string> = { none: "なし", star: "星", bolt: "稲妻", stripe: "帯", cross: "十字", ring: "輪", chevron: "山形", dot: "点", wing: "翼", wave: "波" };

export function mountTeam(root: HTMLElement, go: Go): () => void {
  const { body, wallet, bell } = teamSheet(root, go, "team");
  let alive = true;
  if (!api.isLoggedIn()) {
    body.append(loginGate(go));
    return () => {};
  }
  let t: tapi.TeamView | null = null;
  let draft: Emblem | null = null;
  let busy = false;
  body.append(el("div", { class: "frame dim" }, "読みこんでいます…"));

  const reload = async () => {
    try {
      t = await tapi.fetchTeam();
      if (!alive) return;
      render();
    } catch (e) {
      if (!alive) return;
      body.innerHTML = "";
      body.append(el("div", { class: "frame bad" }, errText(e)));
    }
  };

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(errText(e), true);
    } finally {
      busy = false;
      await reload();
    }
  };

  function render() {
    if (!t) return;
    const v = t;
    paintWallet(wallet, v.money, v.held);
    setBell(bell, v.unread);
    body.innerHTML = "";
    const em = draft ?? v.emblem;

    // 札: 紋章 + チーム名 + 運転手名
    body.append(
      el(
        "div",
        { class: "frame tm-plate" },
        emblemSvg(em, 76),
        el("div", { class: "names" }, el("div", { class: "team" }, v.name, leagueTitleTag(), v.giftTitle ? el("span", { class: "gift-title-tag", title: "贈られた称号" }, v.giftTitle) : null), el("div", { class: "sub" }, `代表で運転手 ${v.driverName} · 季節の残り ${left(v.season.endsAt - Date.now())}`)),
      ),
    );

    const grid = el("div", { class: "tm-grid" });
    body.append(grid);
    grid.append(carsFrame(v), crewFrame(v));
    grid.append(emblemFrame(v), statusFrame(v));
  }

  // ---------- 2 台 ----------
  function carsFrame(v: tapi.TeamView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "2 台の車"), el("span", { class: "label" }, "Cars")));
    const s = load();
    const local = s.designs.map((d, i) => ({ i, d, ok: validateDesign(d).length === 0 })).filter((x) => x.ok);
    const card = (slot: "player" | "second", no: string, who: HTMLElement, ref: tapi.CarRef | null, hint: string) => {
      const sel = el("select", { "aria-label": `${no} の設計図` }) as HTMLSelectElement;
      sel.append(emptyOption(slot === "player" ? "— 決めない (走るときに選んだ車) —" : "— 決めない (1 台目と同じ車) —"));
      if (ref) sel.append(el("option", { value: `s${ref.id}` }, `今: ${ref.name}${ref.fits ? "" : " (部品が足りない)"}`));
      for (const x of local) sel.append(el("option", { value: `l${x.i}` }, `この機械: ${x.d.name}`));
      sel.value = ref ? `s${ref.id}` : "";
      sel.addEventListener("change", () => {
        const val = sel.value;
        if (!val) return run(() => tapi.setCar(slot, { designId: null }), `${no} の設計図を外しました`);
        if (val.startsWith("l")) {
          const d = s.designs[Number(val.slice(1))];
          return run(() => tapi.setCar(slot, { design: d }), `${no} を「${d.name}」にしました`);
        }
      });
      return el("div", { class: `tm-car${slot === "second" ? " second" : ""}` }, el("span", { class: "no tm-num" }, no), who, sel, el("div", { class: "hint" }, hint));
    };
    f.append(
      card("player", "01", el("div", { class: "who" }, v.driverName, el("small", {}, "あなた")), v.cars.player, "すぐ走るでは、走るときに選んだ車で出ます。ここで決めた車は、来られないときの代走用"),
    );
    const hireBtn = el("button", { class: "small" }, "運転手を雇う");
    hireBtn.addEventListener("click", () => go({ name: "drivers" }));
    f.append(
      card(
        "second",
        "02",
        v.driver ? el("div", { class: "who" }, v.driver.name, el("small", {}, `雇った運転手 · 総合 ${Math.round(v.driver.overall)}`)) : el("div", { class: "who" }, "運転手がいません ", hireBtn),
        v.cars.second,
        v.driver ? "すぐ走るで席が空いていれば、一緒に走ってチームにお金と点を入れます" : "運転手を雇うと、すぐ走るに 2 台目も出ます",
      ),
    );
    if (!local.length) f.append(el("div", { class: "callout" }, "この機械に走れる車がありません。車づくりで作ってください"));
    return f;
  }

  // ---------- 整備の組 ----------
  function crewFrame(v: tapi.TeamView): HTMLElement {
    const c = v.crew;
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "整備の組"), el("span", { class: "label" }, "Pit crew")));
    const pips = el("div", { class: "tm-pips", "aria-label": `設備 ${c.level} 段 / ${c.maxLevel}` });
    for (let i = 1; i <= c.maxLevel; i++) pips.append(el("i", { class: i <= c.level ? "on" : "" }));
    f.append(
      pips,
      el(
        "div",
        { class: "tm-figs" },
        el("div", { class: "tm-fig" }, el("span", { class: "label" }, "設備"), el("b", { class: "tm-num" }, `${c.level}`), el("small", { class: "dim" }, ` / ${c.maxLevel}`)),
        el("div", { class: "tm-fig" }, el("span", { class: "label" }, "腕"), el("b", { class: "tm-num" }, `${Math.round(c.skill * 100)}`)),
        el("div", { class: "tm-fig" }, el("span", { class: "label" }, "止まる時間"), el("b", { class: `tm-num${c.factor < 1 ? " good" : ""}` }, `×${c.factor.toFixed(2)}`)),
      ),
      el("div", { class: "tm-kv" }, el("span", {}, "こなしたピット ", el("b", {}, String(c.stops))), c.practiceFull && c.nextCost !== null ? el("span", { class: "good" }, "慣れは上限。設備を上げる頃です") : null),
    );
    const up = el("button", { class: "go", style: "margin-top:12px" }, c.nextCost === null ? "いちばん上の段です" : `設備を上げる · ${money(c.nextCost)}`) as HTMLButtonElement;
    const why = whyNot(up, c.nextCost === null ? "いちばん上の段です" : shortOfMoney(c.nextCost, v.money));
    up.addEventListener("click", () => run(() => tapi.upgradeCrew(), "整備の設備を上げました"));
    f.append(up);
    if (why && c.nextCost !== null) f.append(el("p", { class: "tm-why", style: "text-align:left;margin:6px 0 0" }, why.textContent ?? ""));
    f.append(el("p", { class: "dim", style: "font-size:12px;margin:8px 0 0" }, "腕はお金で上げる設備と、ピットをこなした慣れで決まります。2 台ともピットの時間が短くなります"));
    return f;
  }

  // ---------- 紋章 ----------
  function emblemFrame(v: tapi.TeamView): HTMLElement {
    const e: Emblem = { ...(draft ?? v.emblem) };
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "紋章"), el("span", { class: "label" }, "Emblem")));
    const preview = el("div", {}, emblemSvg(e, 96));
    const set = (patch: Partial<Emblem>) => {
      draft = { ...e, ...patch };
      if (draft.mark !== "none" && draft.color.toLowerCase() === draft.markColor.toLowerCase()) draft.markColor = draft.color === "#ffffff" ? "#202124" : "#ffffff";
      render();
    };
    const picks = (label: string, items: readonly string[], cur: string, show: (x: string) => Node, onPick: (x: string) => void, cls = "") => {
      const box = el("div", { class: `tm-picks ${cls}`, role: "group", "aria-label": label });
      for (const x of items) {
        const b = el("button", { class: x === cur ? "on" : "", "aria-pressed": String(x === cur) }, show(x)) as HTMLButtonElement;
        b.addEventListener("click", () => onPick(x));
        box.append(b);
      }
      return el("div", {}, el("span", { class: "label" }, label), box);
    };
    const shapeIcon = (x: string) => emblemSvg({ shape: x as Emblem["shape"], color: "#c5cbd6", mark: "none", markColor: "#000000" }, 28);
    const markIcon = (x: string) => (x === "none" ? document.createTextNode("なし") : emblemSvg({ shape: "square", color: "#232838", mark: x as Emblem["mark"], markColor: "#f3f5f8" }, 28));
    const sw = (x: string) => el("span", { class: "sw", style: `background:${x}` });
    const edit = el(
      "div",
      {},
      picks("形", EMBLEM_SHAPES, e.shape, shapeIcon, (x) => set({ shape: x as Emblem["shape"] })),
      picks("地の色", EMBLEM_COLORS, e.color.toLowerCase(), sw, (x) => set({ color: x }), "colors"),
      picks("印", EMBLEM_MARKS, e.mark, markIcon, (x) => set({ mark: x as Emblem["mark"] })),
      e.mark !== "none" ? picks("印の色", EMBLEM_COLORS.filter((c) => c !== e.color.toLowerCase()), e.markColor.toLowerCase(), sw, (x) => set({ markColor: x }), "colors") : null,
    );
    for (const b of edit.querySelectorAll<HTMLButtonElement>(".tm-picks button")) {
      const name = b.parentElement?.getAttribute("aria-label");
      if (name === "形") b.title = SHAPE_NAMES[EMBLEM_SHAPES[[...b.parentElement!.children].indexOf(b)]] ?? "";
      if (name === "印") b.title = MARK_NAMES[EMBLEM_MARKS[[...b.parentElement!.children].indexOf(b)]] ?? "";
    }
    f.append(el("div", { class: "tm-em-edit" }, preview, edit));
    const save = el("button", { class: "go" }, "紋章を残す") as HTMLButtonElement;
    save.disabled = !draft;
    save.addEventListener("click", () =>
      run(async () => {
        await tapi.saveEmblem(e);
        draft = null;
      }, "紋章を残しました"),
    );
    const undo = el("button", { class: "ghost" }, "戻す") as HTMLButtonElement;
    undo.disabled = !draft;
    undo.addEventListener("click", () => {
      draft = null;
      render();
    });
    f.append(el("div", { class: "row" }, save, undo));
    return f;
  }

  // ---------- 研究・慣れ ----------
  function statusFrame(v: tapi.TeamView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "研究と慣れ"), el("span", { class: "label" }, "R&D · Track")));
    if (v.research.length) {
      for (const r of v.research) {
        f.append(
          el(
            "div",
            { class: "tm-active" },
            el("div", { class: "when" }, el("b", {}, r.name), el("span", { class: "dim" }, `あと ${left(r.eta - Date.now())}`)),
            el("div", { class: "tm-progress" }, el("i", { style: `width:${Math.round(r.progress * 100)}%` })),
          ),
        );
      }
    } else f.append(el("p", { class: "dim", style: "margin:0 0 8px" }, "研究はしていません"));
    const rb = el("button", { class: "small", style: "margin:10px 0 14px" }, "研究の画面へ");
    rb.addEventListener("click", () => go({ name: "research" }));
    f.append(rb);
    const fam = el("div", { class: "tm-kv" }, el("span", {}, "コースの慣れ (代走)"));
    for (const d of TRACK_DEFS) fam.append(el("span", {}, `${d.name} `, el("b", { class: "tm-num" }, `${Math.round((v.standInFam[d.id] ?? 0) * 100)}%`)));
    f.append(fam, el("p", { class: "dim", style: "font-size:12px;margin:6px 0 0" }, "通信が切れたときに代わりに走るコンピューターも、チームで走るほどコースに慣れます"));
    return f;
  }

  void reload();
  return () => {
    alive = false;
  };
}

/** はじめの画面に置く、チームの 4 つのボタン (知らせの印つき) */
export function teamMenuRow(go: Go): HTMLElement {
  const box = el("div", { class: "tm-menu" });
  const items: Array<[string, "team" | "drivers" | "research" | "market"]> = [
    ["チーム", "team"],
    ["運転手", "drivers"],
    ["研究", "research"],
    ["市場", "market"],
  ];
  for (const [label, name] of items) {
    const b = el("button", {}, label) as HTMLButtonElement;
    b.addEventListener("click", () => go({ name }));
    box.append(b);
  }
  // 知らせの印は チーム のボタンに
  const bell = noticeBell(go);
  if (!bell.hidden) {
    const badge = bell.querySelector(".tm-badge");
    if (badge) box.firstElementChild?.append(badge);
  }
  return box;
}
