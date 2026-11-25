// 季節の画面 (F1 中継風): 自分の級と順位 → 級の順位 (チームと運転手) → 総合 (コンストラクターとドライバーズ) → はんこと記録
import { CLASS_IDS, DEFAULT_SEASON_RULES, type ClassId } from "@bpr/shared";
import { cachedMe, isLoggedIn, refreshAccount } from "../api.ts";
import type { Go } from "../main.ts";
import { fetchMyStamps, fetchSeason, seasonLabel, type MyStamps, type SeasonSummary, type SeasonView } from "../season_api.ts";
import { errText, money } from "./account.ts";
import { el } from "./dom.ts";
import { left } from "./teamkit.ts";
import "./team.css";
import "./season.css";

type Tab = "class" | "overall" | "stamps";
const TAB_KEY = "bpr.season.tab";

export function mountSeason(root: HTMLElement, go: Go): () => void {
  let alive = true;
  let view: SeasonView | null = null;
  let mine: MyStamps | null = null;
  let err = "";
  let tab: Tab = readTab();
  let cls: ClassId | null = null;

  const sheet = el("div", { class: "sheet acc tm ss" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  const when = el("span", { class: "ss-when" });
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, "季節"), el("span", { class: "label" }, "Season · Standings"), when));
  const nav = el("nav", { class: "tm-nav", "aria-label": "季節の画面" });
  sheet.append(nav);
  const body = el("div", { class: "tm-body" });
  sheet.append(body);
  body.append(el("div", { class: "frame dim" }, "読みこんでいます…"));

  function paintWhen() {
    if (!view) return;
    when.innerHTML = "";
    when.append(el("b", {}, seasonLabel(view.season.index)), el("span", { class: "dim" }, ` のこり ${left(view.season.endsAt - Date.now())}`));
  }

  function paintNav() {
    nav.innerHTML = "";
    const tabs: Array<[Tab, string]> = [
      ["class", "級の順位"],
      ["overall", "総合"],
      ["stamps", "はんこと記録"],
    ];
    for (const [t, jp] of tabs) {
      const b = el("button", { class: t === tab ? "on" : "", "aria-current": t === tab ? "page" : "" }, jp) as HTMLButtonElement;
      b.addEventListener("click", () => {
        tab = t;
        saveTab(t);
        render();
      });
      nav.append(b);
    }
  }

  function render() {
    if (!alive) return;
    paintNav();
    paintWhen();
    body.innerHTML = "";
    if (err) body.append(el("div", { class: "frame bad" }, err));
    if (!view) return;
    body.append(mePlate(view));
    if (tab === "class") body.append(classTab(view));
    else if (tab === "overall") body.append(overallTab(view));
    else body.append(stampsTab());
  }

  // ---------- 自分 ----------
  function mePlate(v: SeasonView): HTMLElement {
    const f = el("section", { class: "frame ss-me" });
    if (!v.me) {
      const b = el("button", { class: "small" }, "ログイン");
      b.addEventListener("click", () => go({ name: "account" }));
      f.append(el("div", { class: "ss-me-anon" }, el("span", {}, "ログインするとチームに級が付き、順位に入ります。いまは一番下の 5 級の部屋で走ります。"), b));
      return f;
    }
    const m = v.me;
    const badge = el("div", { class: `ss-cls c${m.playClass}` }, el("b", { class: "tm-num" }, String(m.playClass)), el("span", {}, "級"));
    f.append(
      badge,
      el(
        "div",
        { class: "ss-me-main" },
        el("div", { class: "ss-me-team" }, m.team, el("small", {}, m.driver)),
        el("div", { class: "dim ss-me-note" }, m.cls === null ? "最初の季節 (級なし)。5 級の中で 1 位なら次は 4 級" : `季節の終わりに級の 1 位が上へ、最下位が下へ`),
      ),
      el(
        "div",
        { class: "ss-figs" },
        // 点がまだない (0 点) うちは順位を出さない (QA 2 回目: 0 点で「1 位」と出ていた)
        fig("級の順位", m.classRank && m.points > 0 ? `${m.classRank}` : "—", `/ ${m.classTeams}`),
        fig("チームの点", String(m.points)),
        fig("運転手", m.driverRank && m.driverPoints > 0 ? `${m.driverRank} 位` : "—", `${m.driverPoints} 点`),
        fig("コンストラクター", m.constructorRank && (v.constructors.find((r) => r.me)?.total ?? m.points) > 0 ? `${m.constructorRank} 位` : "—"),
      ),
    );
    return f;
  }

  // ---------- 級の順位 ----------
  function classTab(v: SeasonView): HTMLElement {
    const box = el("div", { class: "stack" });
    const cur: ClassId = cls ?? v.me?.playClass ?? 5;
    const pick = el("div", { class: "ss-clspick", role: "group", "aria-label": "級" });
    for (const c of CLASS_IDS) {
      const n = v.classes.find((x) => x.cls === c)?.teams.length ?? 0;
      const b = el("button", { class: `c${c}${c === cur ? " on" : ""}`, "aria-pressed": String(c === cur) }, el("b", { class: "tm-num" }, String(c)), el("span", {}, `級 · ${n}`)) as HTMLButtonElement;
      b.addEventListener("click", () => {
        cls = c;
        render();
      });
      pick.append(b);
    }
    box.append(pick);
    const data = v.classes.find((x) => x.cls === cur)!;
    const grid = el("div", { class: "tm-grid" });
    grid.append(
      table(
        `${cur} 級のチーム`,
        "Teams",
        ["", "チーム", "点", "大会", "レース"],
        data.teams.map((r, i) => ({
          me: r.me,
          cls: i === 0 && r.points > 0 ? "up" : i === data.teams.length - 1 && data.teams.length > 1 && cur !== 5 ? "down" : "",
          cells: [rankCell(r.rank, r.points), r.name, String(r.points), String(r.tournamentPoints), String(r.races)],
        })),
        "まだ誰も点を取っていません",
      ),
      table(
        `${cur} 級の運転手`,
        "Drivers",
        ["", "運転手", "点", "大会"],
        data.drivers.map((r) => ({ me: r.me, cls: "", cells: [rankCell(r.rank, r.points), whoCell(r.name, r.team, r.hired), String(r.points), String(r.tournamentPoints)] })),
        "まだ誰も点を取っていません",
      ),
    );
    box.append(grid, rulesNote(cur));
    return box;
  }

  function rulesNote(cur: ClassId): HTMLElement {
    const r = DEFAULT_SEASON_RULES;
    return el(
      "p",
      { class: "dim ss-foot" },
      `点: 普段のレース ×${r.everydayMul}・大会 ×${r.tournamentMul}・コンピューターとだけ ×${r.cpuOnlyMul}。` +
        `${cur === 1 ? "" : "級の 1 位は上の級へ。"}${cur === 5 ? "" : "最下位は下の級へ。"}代走の点はチームだけに入ります。`,
    );
  }

  // ---------- 総合 ----------
  function overallTab(v: SeasonView): HTMLElement {
    const box = el("div", { class: "stack" });
    if (v.last) box.append(lastSeason(v.last));
    const grid = el("div", { class: "tm-grid" });
    grid.append(
      table(
        "コンストラクター",
        "Constructors",
        ["", "チーム", "本戦", "リーグ", "合計"],
        v.constructors.map((r) => ({ me: r.me, cls: r.rank === 1 && r.total > 0 ? "gold" : "", cells: [rankCell(r.rank, r.total), r.name, String(r.main), String(r.league), String(r.total)] })),
        "まだ点がありません",
      ),
      table(
        "ドライバーズ",
        "Drivers",
        ["", "運転手", "点", "大会"],
        v.drivers.map((r) => ({ me: r.me, cls: r.rank === 1 && r.points > 0 ? "gold" : "", cells: [rankCell(r.rank, r.points), whoCell(r.name, r.team, r.hired), String(r.points), String(r.tournamentPoints)] })),
        "まだ点がありません",
      ),
    );
    box.append(grid, el("p", { class: "dim ss-foot" }, "コンストラクター = 本戦 (普段のレース + 大会) のチームの点 + リーグ戦の点 (上の部ほど重い)。級ごとと総合で 1 チーム、運転手も級ごとと総合で 1 人"));
    return box;
  }

  function lastSeason(s: SeasonSummary): HTMLElement {
    const f = el("section", { class: "frame ss-last" }, el("div", { class: "section-title" }, el("h3", {}, `${seasonLabel(s.season)}のチャンピオン`), el("span", { class: "label" }, "Champions")));
    const big = el("div", { class: "ss-champs" });
    big.append(
      champCard("総合コンストラクター", s.overallConstructor ? s.overallConstructor.team : "—", s.overallConstructor ? `${s.overallConstructor.points} 点` : "", true),
      champCard("総合ドライバーズ", s.overallDriver ? s.overallDriver.name ?? "" : "—", s.overallDriver ? `${s.overallDriver.team} · ${s.overallDriver.points} 点` : "", true),
    );
    f.append(big);
    const t = el("table", { class: "results ss-table" });
    t.append(el("thead", {}, el("tr", {}, el("th", {}, "級"), el("th", {}, "コンストラクター"), el("th", {}, "ドライバーズ"))));
    const tb = el("tbody");
    for (const c of s.classes) {
      tb.append(el("tr", {}, el("td", { class: "pos num" }, String(c.cls)), el("td", {}, c.constructor?.team ?? "—"), el("td", {}, c.driver ? `${c.driver.name} (${c.driver.team})` : "—")));
    }
    t.append(tb);
    f.append(el("div", { class: "ss-scroll" }, t));
    if (s.moves.length) f.append(el("p", { class: "dim ss-foot" }, s.moves.map((m) => `${m.team} ${m.from ?? "級なし"} → ${m.to} 級`).join("・")));
    return f;
  }

  // ---------- はんこと記録 ----------
  function stampsTab(): HTMLElement {
    const box = el("div", { class: "stack" });
    if (!isLoggedIn()) {
      const b = el("button", { class: "go" }, "ログイン・はじめる");
      b.addEventListener("click", () => go({ name: "account" }));
      box.append(el("div", { class: "frame tm-gate" }, el("p", {}, "ログインすると、はんこと記録が残ります"), b));
      return box;
    }
    if (!mine) {
      box.append(el("div", { class: "frame dim" }, "読みこんでいます…"));
      fetchMyStamps()
        .then((m) => {
          mine = m;
          if (alive && tab === "stamps") render();
        })
        .catch((e) => {
          err = errText(e);
          render();
        });
      return box;
    }
    const sf = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "はんこ帳"), el("span", { class: "label" }, `${mine.stamps.length} 種類`)));
    if (!mine.stamps.length) sf.append(el("p", { class: "dim", style: "margin:0" }, "まだありません。レースで優勝・最速の周・雨で勝つ などで押されます"));
    const grid = el("div", { class: "ss-stamps" });
    for (const s of mine.stamps) {
      grid.append(
        el(
          "div",
          { class: `ss-stamp r${s.rarity}${mine.thisSeason.includes(s.id) ? " now" : ""}`, title: s.desc },
          el("b", {}, s.name),
          el("span", { class: "tm-num" }, `×${s.count}`),
          el("small", {}, s.desc),
        ),
      );
    }
    sf.append(grid);
    box.append(sf);
    const hf = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "季節の記録"), el("span", { class: "label" }, "History")));
    if (!mine.history.length) hf.append(el("p", { class: "dim", style: "margin:0" }, "季節が終わると、ここに残ります"));
    for (const h of mine.history) {
      const star = h.constructor === "overall" || h.driverChampion === "overall";
      const tags: Array<HTMLElement> = [];
      if (h.constructor) tags.push(el("span", { class: `ss-badge${h.constructor === "overall" ? " gold" : ""}` }, h.constructor === "overall" ? "総合コンストラクター" : "級のコンストラクター"));
      if (h.driverChampion) tags.push(el("span", { class: `ss-badge${h.driverChampion === "overall" ? " gold" : ""}` }, h.driverChampion === "overall" ? "総合ドライバーズ" : "級のドライバーズ"));
      if (h.champion) tags.push(el("span", { class: "ss-badge gold" }, "王者"));
      else if (h.title) tags.push(el("span", { class: "ss-badge" }, h.title));
      hf.append(
        el(
          "div",
          { class: `ss-hist${star ? " star" : ""}` },
          el("div", { class: "s" }, seasonLabel(h.season)),
          el(
            "div",
            { class: "m" },
            el("b", {}, h.classRank ? `${h.cls ?? "級なし"}${h.cls ? " 級" : ""} ${h.classRank} 位` : "順位なし", el("span", { class: "dim" }, ` · ${h.points} 点`)),
            el("div", { class: "row" }, ...tags),
            h.stamps.length ? el("small", { class: "dim" }, `はんこ ${h.stamps.length} 個`) : null,
          ),
          el("div", { class: "p" }, h.nextCls ? `→ ${h.nextCls} 級` : "", h.prize > 0 ? el("small", {}, `+${money(h.prize)}`) : null),
        ),
      );
    }
    box.append(hf);
    return box;
  }

  async function reload() {
    try {
      view = await fetchSeason();
      err = "";
    } catch (e) {
      err = errText(e);
    }
    render();
  }

  void reload();
  const timer = setInterval(paintWhen, 30_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

function fig(label: string, v: string, sub = ""): HTMLElement {
  return el("div", { class: "ss-fig" }, el("span", { class: "label" }, label), el("b", { class: "tm-num" }, v), sub ? el("small", { class: "dim" }, ` ${sub}`) : null);
}

function whoCell(name: string, team: string, hired: boolean): string {
  return `${name}\u0000${team}${hired ? " · 雇い" : ""}`;
}

/** 順位のセル: 点がまだなければ「—」(0 点どうしの並びに順位を付けない) */
function rankCell(rank: number, points: number): string {
  return points > 0 ? String(rank) : "—";
}

/** 順位の表 (セルの「名前\0小さな字」は 2 段にする) */
function table(title: string, label: string, head: string[], rows: Array<{ me: boolean; cls: string; cells: string[] }>, empty: string): HTMLElement {
  const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, title), el("span", { class: "label" }, label)));
  if (!rows.length) {
    f.append(el("p", { class: "dim", style: "margin:0" }, empty));
    return f;
  }
  const t = el("table", { class: "results ss-table" });
  t.append(el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { class: i >= 2 ? "r" : "" }, h)))));
  const tb = el("tbody");
  for (const r of rows) {
    const tr = el("tr", { class: `${r.me ? "me" : ""} ${r.cls}` });
    r.cells.forEach((c, i) => {
      if (i === 0) tr.append(el("td", { class: "pos num" }, c));
      else if (i === 1) {
        const [a, b] = c.split("\u0000");
        tr.append(el("td", { class: "who" }, el("span", { class: "bar" }), a, b ? el("small", { class: "dim" }, ` ${b}`) : null, r.me ? el("span", { class: "tag you" }, "あなた") : null));
      } else tr.append(el("td", { class: "r num" }, c));
    });
    tb.append(tr);
  }
  t.append(tb);
  f.append(el("div", { class: "ss-scroll" }, t));
  return f;
}

function champCard(label: string, name: string, sub: string, gold: boolean): HTMLElement {
  return el("div", { class: `ss-champ${gold ? " gold" : ""}` }, el("span", { class: "label" }, label), el("b", {}, name), el("small", { class: "dim" }, sub));
}

function readTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t === "class" || t === "overall" || t === "stamps") return t;
  } catch {
    /* 読めなければはじめ */
  }
  return "class";
}

function saveTab(t: Tab) {
  try {
    localStorage.setItem(TAB_KEY, t);
  } catch {
    /* 保存できなくてよい */
  }
}

/** メニューに置く入り口 (季節と大会と、管理者なら管理。管理者かどうかはアカウントを読み直したら描き直す) */
export function seasonMenuSection(go: Go): HTMLElement {
  const row = el("div", { class: "ss-menu" });
  const paint = () => {
    row.innerHTML = "";
    const items: Array<[string, string, () => void]> = [
      ["季節", "級と順位・はんこ", () => go({ name: "season" })],
      ["大会", "予選と決勝", () => go({ name: "tournament" })],
    ];
    if (isLoggedIn() && cachedMe()?.admin) items.push(["管理", "管理者だけ", () => go({ name: "admin" })]);
    for (const [t, sub, fn] of items) {
      const b = el("button", { class: "ss-menu-btn" }, el("b", {}, t), el("small", {}, sub)) as HTMLButtonElement;
      b.addEventListener("click", fn);
      row.append(b);
    }
  };
  paint();
  refreshAccount().then(paint).catch(() => {});
  return el(
    "section",
    { class: "frame" },
    el("div", { class: "section-title" }, el("h3", {}, "季節と大会"), el("span", { class: "label" }, "Season · Tournament")),
    el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, "1 週間の季節で級を上がる。大会は予選の順に 8 台ずつの組で走ります。"),
    row,
  );
}
