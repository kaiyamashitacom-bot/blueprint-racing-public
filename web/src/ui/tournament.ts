// 大会の画面: 一覧 → 1 つの大会 (予選のタイヤの組・予選を走る・自分の記録と組・予選の表・決勝の予定・組の並び・結果)。
// 予選の走りは 1 周アタックと同じ RaceView (晴れ・周の終わりなし)。選んだ組のタイヤで走り、減りは次の走りと決勝に持ち越す。
// 決勝は組ごとのサーバーの部屋 (スタートの 10 分前に開く)。来なければ代走が予定のまま走る
import {
  TA_RUN_LAPS,
  TIRE_DEFS,
  TIRE_ORDER,
  TaGhostRecorder,
  allocTotal,
  computeStats,
  dryKinds,
  formatTime,
  getTrack,
  validateDesign,
  type CarDesign,
  type SetOption,
  type SetPick,
  type TireAlloc,
  type TireCompound,
  type TournamentWeather,
  type WeatherPlan,
} from "@bpr/shared";
import { isLoggedIn } from "../api.ts";
import type { Go } from "../main.ts";
import { RaceView } from "../race/view.ts";
import { fetchTournament, fetchTournaments, refreshWallet, sendQualiRun, setQualiTires, setTourPlan, type TourBrief, type TourView } from "../season_api.ts";
import { activeDesign, load, type Ghost } from "../store.ts";
import { errText, toast } from "./account.ts";
import { el } from "./dom.ts";
import { left } from "./teamkit.ts";
import { gradeBadge, prizeFrame, prizeLine, resultGifts } from "./tourprize.ts";
import "./team.css";
import "./season.css";
import { partStrength } from "../race_rules.ts";

const DRY: WeatherPlan = { seed: 1, changes: [{ at: 0, sky: "sun" }], fakes: [], startWet: 0 };
const SKY_JP: Record<string, string> = { sun: "晴れ", light: "小雨", heavy: "大雨" };
export const PHASE_JP: Record<string, string> = { qualifying: "予選中", grid_set: "予選終わり", lobby: "組の部屋が開いた", racing: "決勝中", done: "終わった", cancelled: "取りやめ" };
const FUEL_JP: Record<string, string> = { full: "満タン", race: "レースの分", light: "少なめ" };

/** 日本時間の 月/日 (曜) 時:分 */
export function jstTime(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function weatherText(w: TournamentWeather): string {
  if (w.mode === "fixed") return `ずっと${SKY_JP[w.sky] ?? w.sky}`;
  return `変わる${w.rain !== undefined ? ` (雨 ${Math.round(w.rain * 100)}%)` : ""}`;
}

function tyre(c: TireCompound, extra = ""): HTMLElement {
  return el("i", { class: "ta-tyre ss-tyre", style: `--c:${TIRE_DEFS[c].color}`, title: TIRE_DEFS[c].name }, TIRE_DEFS[c].short + extra);
}

export function mountTournament(root: HTMLElement, go: Go, id?: string): () => void {
  let alive = true;
  const sheet = el("div", { class: "sheet acc tm ss" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => (id ? go({ name: "tournament" }) : go({ name: "menu" })));
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, "大会"), el("span", { class: "label" }, id ? "Tournament" : "Tournaments")));
  const body = el("div", { class: "tm-body" });
  sheet.append(body);
  body.append(el("div", { class: "frame dim" }, "読みこんでいます…"));
  let cleanupRun: (() => void) | null = null;

  if (!id) {
    fetchTournaments()
      .then((r) => alive && renderList(r.tournaments))
      .catch((e) => {
        body.innerHTML = "";
        body.append(el("div", { class: "frame bad" }, errText(e)));
      });
    return () => {
      alive = false;
    };
  }

  function renderList(list: TourBrief[]) {
    body.innerHTML = "";
    if (!list.length) {
      body.append(el("div", { class: "frame dim" }, "いまは大会がありません。管理者が組むと、ここに出ます"));
      return;
    }
    for (const t of list) {
      const b = el(
        "button",
        { class: `ss-tcard ${t.phase}` },
        el("span", { class: "ss-tdate" }, el("b", { class: "tm-num" }, jstTime(t.startsAt))),
        el(
          "span",
          { class: "ss-tname" },
          gradeBadge(t.grade),
          el("b", {}, t.name),
          el("small", { class: "dim" }, `${t.trackName} · ${t.laps} 周 · ${weatherText(t.weather)}${t.allEnter ? " · 全員参加" : ""}`),
        ),
        el("span", { class: `ss-phase ${t.phase}` }, PHASE_JP[t.phase] ?? t.phase),
        el("span", { class: "ss-tentries dim" }, `予選 ${t.entries} 人`),
        prizeLine(t.prizes),
      );
      b.addEventListener("click", () => go({ name: "tournament", id: t.id }));
      body.append(b);
    }
  }

  // ---------------------------------------------------------------- 1 つの大会

  let v: TourView | null = null;
  let draft: TireAlloc | null = null;
  let pick: SetPick | null = null;
  let lastRun: string | null = null;
  let busy = false;

  async function reload() {
    try {
      v = await fetchTournament(id!);
      if (!alive) return;
      render();
    } catch (e) {
      if (!alive) return;
      body.innerHTML = "";
      body.append(el("div", { class: "frame bad" }, errText(e)));
    }
  }

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
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
    if (!alive || !v) return;
    const t = v.tournament;
    body.innerHTML = "";
    const track = getTrack(t.trackId);
    body.append(
      el(
        "section",
        { class: "frame ss-thead" },
        el("div", { class: "ss-thead-main" }, el("span", { class: `ss-phase ${t.phase}` }, PHASE_JP[t.phase] ?? t.phase), el("h3", {}, t.name), gradeBadge(t.grade)),
        el(
          "div",
          { class: "ss-figs" },
          fig("スタート", jstTime(t.startsAt)),
          fig("コース", t.trackName, `${(track.length / 1000).toFixed(2)} km`),
          fig("周回", `${t.laps}`, "LAPS"),
          fig("天気", weatherText(t.weather)),
        ),
        el(
          "p",
          { class: "dim ss-foot" },
          (t.phase === "qualifying"
            ? `予選の締め切り ${jstTime(t.qualifyClosesAt)} (のこり ${left(t.qualifyClosesAt - Date.now())})。予選の順に ${t.groupSize} 台ずつの組 (A・B…) で走ります`
            : `予選の順に ${t.groupSize} 台ずつの組で走ります。大会の順位は A 組 → B 組 … の順`) +
            (t.allEnter
              ? "。全員参加: 申し込みなしで全部のチームが 2 台で出ます (予選を走らなかった車は後ろ、強い車ほど後ろ)。組の部屋が開くとき (スタートの 10 分前) にこの画面を開いている人の組は部屋で走り、ほかの組は代走でサーバーが計算します"
              : ""),
        ),
      ),
    );
    const pf = prizeFrame(t.prizes);
    const grid = el("div", { class: "tm-grid" });
    body.append(grid);
    const left1 = el("div", { class: "stack" });
    const right1 = el("div", { class: "stack" });
    grid.append(left1, right1);
    if (t.phase === "done" && v.results) right1.append(resultsFrame(v));
    // この大会の景品 (終わるまでは左の上、終わったら結果の下)
    if (pf && t.phase === "done") right1.append(pf);
    else if (pf) left1.append(pf);
    if (v.groups) right1.append(groupsFrame(v));
    right1.append(qualiTable(v));
    if (!isLoggedIn()) {
      const b = el("button", { class: "go" }, "ログイン・はじめる");
      b.addEventListener("click", () => go({ name: "account" }));
      left1.append(el("div", { class: "frame tm-gate" }, el("p", {}, "予選を走るにはログイン"), b));
      return;
    }
    if (v.me?.group && (t.phase === "lobby" || t.phase === "racing")) left1.append(joinFrame(v));
    left1.append(myFrame(v));
    if (t.status === "open") left1.append(planFrame(v));
  }

  // ---------- 自分: タイヤの組と予選 ----------
  function myFrame(v: TourView): HTMLElement {
    const t = v.tournament;
    const me = v.me!;
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "あなたの予選"), el("span", { class: "label" }, "Qualifying")));
    const rank = v.qualifying.find((r) => r.me);
    f.append(
      el(
        "div",
        { class: "ss-figs" },
        fig("Best", formatTime(me.best)),
        fig("順位", rank ? `${rank.pos}` : "—", rank ? `/ ${v.qualifying.length} · ${rank.group} 組` : ""),
        fig("走った回数", String(me.tires?.runs ?? 0)),
      ),
    );
    // この大会の景品 (1 行)
    const pl = prizeLine(t.prizes);
    if (pl) f.append(el("div", { class: "tp-inq" }, pl));
    if (lastRun) f.append(el("div", { class: "callout ok" }, lastRun));
    const qualifying = t.phase === "qualifying";
    if (!me.tires) {
      if (!qualifying) {
        f.append(el("p", { class: "dim", style: "margin:0" }, "予選に出ていません"));
        return f;
      }
      f.append(allocEditor(v));
      return f;
    }
    // 持っている組
    f.append(el("span", { class: "label" }, me.tires.locked ? "持っている組 (決まった)" : "持っている組 (最初の走りまで変えられる)"));
    const opts = me.tires.options;
    const list = el("div", { class: "ss-sets", role: "group", "aria-label": "予選で履く組" });
    const cur = pick && opts.some((o) => samePick(o, pick!)) ? pick : opts[0] ? { tire: opts[0].tire, used: opts[0].used } : null;
    for (const o of opts) {
      const on = !!cur && samePick(o, cur);
      const b = el(
        "button",
        { class: on ? "on" : "", "aria-pressed": String(on) },
        tyre(o.tire),
        el("span", {}, o.used === null ? `新品 ×${o.count}` : `減り ${Math.round(o.wear * 100)}%`),
      ) as HTMLButtonElement;
      b.disabled = !qualifying;
      b.addEventListener("click", () => {
        pick = { tire: o.tire, used: o.used };
        render();
      });
      list.append(b);
    }
    if (!opts.length) list.append(el("span", { class: "dim" }, "組が残っていません"));
    f.append(list);
    if (qualifying && !me.tires.locked) {
      const ch = el("button", { class: "small ghost" }, "組を決め直す");
      ch.addEventListener("click", () => {
        draft = { ...me.tires!.alloc };
        f.replaceWith(allocEditorFrame(v));
      });
      f.append(ch);
    }
    if (qualifying) {
      const design = activeDesign();
      const errs = design ? validateDesign(design) : ["まだ車がありません"];
      f.append(el("div", { class: "ss-car" }, el("span", { class: "label" }, "車"), el("b", {}, design?.name ?? "—"), el("span", { class: "dim" }, "(メニューで選んだ車)")));
      if (errs.length) f.append(el("div", { class: "callout" }, `走るには車を仕上げてください — ${errs[0]}`));
      const runB = el("button", { class: "go" }, `予選を走る (${TA_RUN_LAPS} 周まで)`) as HTMLButtonElement;
      runB.disabled = !!errs.length || !cur;
      runB.addEventListener("click", () => design && cur && startRun(v, design, cur, opts.find((o) => samePick(o, cur))!));
      f.append(runB, el("p", { class: "dim ss-foot" }, "いつも晴れ。走るたびに選んだ組がすり減り、減ったまま次の走りと決勝に持ち越します"));
    }
    return f;
  }

  function allocEditorFrame(v: TourView): HTMLElement {
    return el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "予選のタイヤの組"), el("span", { class: "label" }, "Tyre sets")), allocEditor(v));
  }

  function allocEditor(v: TourView): HTMLElement {
    const r = v.rules;
    const a: TireAlloc = draft ?? { S: 1, M: 2, H: 1 };
    draft = a;
    const box = el("div", { class: "ss-alloc" });
    const draw = () => {
      box.innerHTML = "";
      box.append(el("p", { class: "dim", style: "margin:0 0 8px;font-size:13px" }, `予選と決勝を通して使う組を決めます。${r.limit} 組まで・乾いた路面用 (S・M・H) を ${r.minDry} 種類以上`));
      for (const c of TIRE_ORDER) {
        const n = a[c] ?? 0;
        const minus = el("button", { class: "small", "aria-label": `${TIRE_DEFS[c].name} を減らす` }, "−") as HTMLButtonElement;
        const plus = el("button", { class: "small", "aria-label": `${TIRE_DEFS[c].name} を増やす` }, "+") as HTMLButtonElement;
        minus.disabled = n <= 0;
        plus.disabled = allocTotal(a) >= r.limit;
        minus.addEventListener("click", () => {
          if (n <= 1) delete a[c];
          else a[c] = n - 1;
          draw();
        });
        plus.addEventListener("click", () => {
          a[c] = n + 1;
          draw();
        });
        box.append(el("div", { class: "ss-arow" }, tyre(c), el("span", {}, TIRE_DEFS[c].name), minus, el("b", { class: "tm-num" }, String(n)), plus));
      }
      const ok = allocTotal(a) >= 1 && dryKinds(a) >= r.minDry;
      const save = el("button", { class: "go" }, `この組にする (${allocTotal(a)} / ${r.limit})`) as HTMLButtonElement;
      save.disabled = !ok;
      save.addEventListener("click", () =>
        act(async () => {
          await setQualiTires(v.tournament.id, a);
          draft = null;
        }, "タイヤの組を決めました"),
      );
      box.append(save);
      if (!ok) box.append(el("div", { class: "callout" }, `乾いた路面用を ${r.minDry} 種類以上入れてください`));
    };
    draw();
    return box;
  }

  // ---------- 決勝の予定 ----------
  function planFrame(v: TourView): HTMLElement {
    const me = v.me!;
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "決勝の予定"), el("span", { class: "label" }, "Race plan")));
    if (!me.tires) {
      f.append(el("p", { class: "dim", style: "margin:0" }, "先に予選のタイヤの組を決めてください"));
      return f;
    }
    f.append(el("p", { class: "dim", style: "margin:0 0 8px;font-size:13px" }, "来られないときは、代走のコンピューターがこの予定のまま走ります (チームの点だけ入ります)"));
    const sel = el("select", { "aria-label": "スタートのタイヤ" }) as HTMLSelectElement;
    sel.append(el("option", { value: "" }, "おまかせ (普通の新品から)"));
    me.tires.options.forEach((o, i) => sel.append(el("option", { value: String(i) }, `${TIRE_DEFS[o.tire].name} ${o.used === null ? `新品 ×${o.count}` : `減り ${Math.round(o.wear * 100)}%`}`)));
    const p = me.plan?.start ?? null;
    const idx = p ? me.tires.options.findIndex((o) => samePick(o, p)) : -1;
    sel.value = idx >= 0 ? String(idx) : "";
    sel.addEventListener("change", () => {
      const o = sel.value === "" ? null : me.tires!.options[Number(sel.value)];
      void act(() => setTourPlan(v.tournament.id, { start: o ? { tire: o.tire, used: o.used } : null }), "スタートのタイヤを決めました");
    });
    const fuel = el("div", { class: "toggle", role: "group", "aria-label": "燃料" });
    for (const k of ["full", "race", "light"] as const) {
      const b = el("button", { class: (me.plan?.fuel ?? "race") === k ? "on" : "" }, FUEL_JP[k]) as HTMLButtonElement;
      b.addEventListener("click", () => act(() => setTourPlan(v.tournament.id, { fuel: k }), `燃料: ${FUEL_JP[k]}`));
      fuel.append(b);
    }
    const design = activeDesign();
    const useCar = el("button", { class: "small" }, design ? `「${design.name}」で出る` : "車がありません") as HTMLButtonElement;
    useCar.disabled = !design || validateDesign(design).length > 0;
    useCar.addEventListener("click", () => design && act(() => setTourPlan(v.tournament.id, { design }), "決勝の車を決めました"));
    f.append(
      el("div", { class: "ss-plan" }, el("span", { class: "label" }, "スタート"), sel),
      el("div", { class: "ss-plan" }, el("span", { class: "label" }, "燃料"), fuel),
      el("div", { class: "ss-plan" }, el("span", { class: "label" }, "車"), el("b", {}, me.design?.name ?? "まだ (予選を走った車)"), useCar),
    );
    return f;
  }

  // ---------- 組の部屋 ----------
  function joinFrame(v: TourView): HTMLElement {
    const g = v.me!.group!;
    const t = v.tournament;
    if (g.headless) {
      return el(
        "section",
        { class: "frame ss-join" },
        el("div", { class: "section-title" }, el("h3", {}, `${g.letter} 組 · ${g.slot + 1} 番グリッド`), el("span", { class: "label" }, "Server race")),
        el("p", { class: "tp-headless" }, "組の部屋が開くときにこの画面を開いていなかったので、この組は代走でサーバーが計算します。結果はスタートのあとにここに出ます"),
      );
    }
    const b = el("button", { class: "go" }, `${g.letter} 組の部屋に入る`) as HTMLButtonElement;
    b.addEventListener("click", () => go({ name: "online", laps: t.laps, tour: { id: t.id, g: g.index } }));
    return el(
      "section",
      { class: "frame ss-join" },
      el("div", { class: "section-title" }, el("h3", {}, `${g.letter} 組 · ${g.slot + 1} 番グリッド`), el("span", { class: "label" }, "Race room")),
      el("p", { class: "dim", style: "margin:0 0 8px" }, t.phase === "lobby" ? `スタートまで ${left(t.startsAt - Date.now())}` : "決勝中。入れば途中から自分で運転できます"),
      b,
    );
  }

  function groupsFrame(v: TourView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "決勝の組と並び"), el("span", { class: "label" }, "Grid")));
    for (const g of v.groups ?? []) {
      const t = el("table", { class: "results ss-table" });
      t.append(el("thead", {}, el("tr", {}, el("th", {}, `${g.letter}`), el("th", {}, "運転手"), el("th", { class: "r" }, "予選"))));
      const tb = el("tbody");
      for (const c of g.cars) {
        const mine = v.me?.group?.letter === g.letter && v.me.group.slot === c.slot;
        tb.append(
          el(
            "tr",
            { class: mine ? "me" : "" },
            el("td", { class: "pos num" }, String(c.slot + 1)),
            el("td", { class: "who" }, el("span", { class: "bar" }), c.name, el("small", { class: "dim" }, ` ${c.team}${c.kind === "hired" ? " · 雇い" : ""}`)),
            el("td", { class: "r num" }, c.lapTime === null ? "—" : formatTime(c.lapTime)),
          ),
        );
      }
      t.append(tb);
      f.append(el("div", { class: "ss-scroll" }, t));
    }
    return f;
  }

  function qualiTable(v: TourView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "予選の順位"), el("span", { class: "label" }, `${v.qualifying.length} 人`)));
    if (!v.qualifying.length) {
      f.append(el("p", { class: "dim", style: "margin:0" }, "まだ誰も走っていません"));
      return f;
    }
    const t = el("table", { class: "results ss-table" });
    t.append(el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "運転手"), el("th", { class: "r" }, "タイム"), el("th", { class: "r" }, "差"), el("th", { class: "r" }, "組"))));
    const tb = el("tbody");
    for (const r of v.qualifying) {
      tb.append(
        el(
          "tr",
          { class: `${r.pos <= 3 ? "podium" : ""} ${r.pos === 1 ? "p1" : ""} ${r.me ? "me" : ""}` },
          el("td", { class: "pos num" }, String(r.pos)),
          el("td", { class: "who" }, el("span", { class: "bar" }), r.driver, el("small", { class: "dim" }, ` ${r.team}`), r.me ? el("span", { class: "tag you" }, "あなた") : null),
          el("td", { class: "r num" }, formatTime(r.lap)),
          el("td", { class: "r num dim" }, r.gap === null ? "—" : `+${r.gap.toFixed(3)}`),
          el("td", { class: "r" }, r.group),
        ),
      );
    }
    t.append(tb);
    f.append(el("div", { class: "ss-scroll" }, t));
    return f;
  }

  function resultsFrame(v: TourView): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "結果"), el("span", { class: "label" }, "Result")));
    const t = el("table", { class: "results ss-table" });
    t.append(el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "運転手"), el("th", { class: "r" }, "点"), el("th", { class: "r" }, "賞金"))));
    const tb = el("tbody");
    for (const r of v.results ?? []) {
      const note = r.dq ? "失格 (タイヤ)" : !r.finished ? "完走できず" : r.standIn ? "代走" : "";
      tb.append(
        el(
          "tr",
          { class: `${r.finalPos <= 3 && !r.dq ? "podium" : ""} ${r.finalPos === 1 ? "p1" : ""} ${r.dq ? "dq" : ""}` },
          el("td", { class: "pos num" }, String(r.finalPos)),
          el(
            "td",
            { class: "who" },
            el("span", { class: "bar" }),
            r.name,
            el("small", { class: "dim" }, ` ${r.team} · ${r.group} 組`),
            note ? el("span", { class: `tag${r.dq ? " bad" : ""}` }, note) : null,
            r.fastest ? el("span", { class: "tag fl" }, "最速") : null,
            resultGifts(r.rp ? [...(r.gifts ?? []), `走行点 +${r.rp} (走った分)`] : r.gifts, r.giftsMissed),
          ),
          el("td", { class: "r num" }, String(r.points)),
          el("td", { class: "r num" }, r.prize ? r.prize.toLocaleString("ja-JP") : "—"),
        ),
      );
    }
    t.append(tb);
    f.append(el("div", { class: "ss-scroll" }, t), el("p", { class: "dim ss-foot" }, "点は大会の 10 倍で季節に入ります。乾いた路面で 2 種類のタイヤを使わないと失格"));
    return f;
  }

  // ---------- 予選を走る ----------
  function startRun(v: TourView, design: CarDesign, use: SetPick, opt: SetOption) {
    const s = load();
    const t = v.tournament;
    const track = getTrack(t.trackId);
    const stats = computeStats(design, partStrength());
    const layer = el("div", { class: "ta-run", style: "position:fixed;inset:0" });
    const raceRoot = el("div");
    layer.append(raceRoot);
    root.append(layer);
    sheet.style.display = "none";
    const rec = new TaGhostRecorder();
    let pending: { start: number; time: number; valid: boolean } | null = null;
    let lapsDone = 0;
    let ended = false;
    let best: Ghost | null = null;
    let view: RaceView | null = null;
    const hold = 0.3 + Math.random() * 1.5;
    const lightsStartT = -(5 + hold);
    const t0 = performance.now() + (-lightsStartT + 1.5) * 1000;
    let lastT = -Infinity;
    const clock = () => {
      const now = (performance.now() - t0) / 1000;
      const car = view?.car;
      if (car && Number.isFinite(lastT)) rec.push(lastT, car.x, car.y, car.heading);
      lastT = now;
      if (pending && rec.lastT() >= pending.start + pending.time) {
        const p = pending;
        pending = null;
        if (p.valid && (!best || p.time < best.lap)) best = { lap: p.time, pts: rec.ghost(p.start, p.time) };
        rec.dropBefore(p.start + p.time - 1);
        if (lapsDone >= TA_RUN_LAPS) setTimeout(() => finish(), 1500);
      }
      return now;
    };
    view = new RaceView({
      root: raceRoot,
      track,
      laps: 0,
      assist: s.assist,
      me: { info: { id: "me", name: s.name || "あなた", design, color: "#ff2b3a", bot: false }, slot: 0, stats },
      clock,
      lightsStartT,
      modeLabel: "QUALIFYING",
      weather: DRY,
      // 選んだ組のタイヤで (減りつき)。ほかの組には替えられない (空の組)
      setup: { tire: use.tire, wear: opt.wear, fuel: stats.fuelCap, sets: { fresh: {}, used: [] } },
      onLap: (time, valid, lap) => {
        if (ended) return;
        lapsDone++;
        pending = { start: lap.lapStart - time, time, valid };
      },
      onRetire: () => setTimeout(() => finish(), 1500),
      onQuit: () => finish(),
    });
    async function finish() {
      if (ended) return;
      ended = true;
      const car = view?.car;
      const endWear = car ? car.wear : opt.wear;
      const burst = !!car?.burst;
      const mt = !!view?.manual;
      view?.destroy();
      view = null;
      layer.remove();
      cleanupRun = null;
      if (!alive) return;
      sheet.style.display = "";
      window.scrollTo(0, 0);
      try {
        const r = await sendQualiRun(t.id, { pick: use, endWear, burst, best, design, mt });
        lastRun = best
          ? r.improved
            ? `記録しました ${formatTime(r.best)} · ${r.rank} 位 / ${r.total} 人`
            : `${formatTime(best.lap)}。前の記録 ${formatTime(r.best)} のほうが速い`
          : "数える周がありませんでした (タイヤは減りました)";
        pick = null;
        refreshWallet();
      } catch (e) {
        lastRun = null;
        toast(`送れませんでした: ${errText(e)}`, true);
      }
      await reload();
    }
    cleanupRun = () => {
      ended = true;
      view?.destroy();
      layer.remove();
    };
  }

  void reload();
  const timer = setInterval(() => {
    if (!cleanupRun && v && (v.tournament.phase === "lobby" || v.tournament.phase === "grid_set" || v.tournament.phase === "racing")) void reload();
  }, 30_000);
  return () => {
    alive = false;
    clearInterval(timer);
    cleanupRun?.();
  };
}

function samePick(o: { tire: TireCompound; used: number | null }, p: SetPick): boolean {
  return o.tire === p.tire && (o.used ?? null) === (p.used ?? null);
}

function fig(label: string, val: string, sub = ""): HTMLElement {
  return el("div", { class: "ss-fig" }, el("span", { class: "label" }, label), el("b", { class: "tm-num" }, val), sub ? el("small", { class: "dim" }, ` ${sub}`) : null);
}
