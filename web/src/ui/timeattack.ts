// 1 周アタック (毎週お題のコース): 今週のコースとのこり時間・順位表 (自分を目立たせる)・幽霊を選んで「走る」。
// 走りは練習と同じ RaceView (laps: 0・晴れ・柔らかいタイヤの新品・満タン)。TA_RUN_LAPS 周で終わる。
// 速い周が出たら、ログインしていればサーバーに送って順位を出す。していなければこの機械にだけ残す。
// 幽霊は 3 つまで選べる (はじめは一番速い人)。ほかの人の設計図は見せない: 幽霊は線だけで、絵は見本の車の形 (SAMPLE_DESIGN) で描く。
import {
  TA_CONDITIONS,
  TA_RUN_LAPS,
  TaGhostRecorder,
  SAMPLE_DESIGN,
  TIRE_DEFS,
  checkTaDesign,
  computeStats,
  formatTime,
  getTrack,
  taImproves,
  taLapMs,
  taLeftText,
  taWeekAt,
  validateDesign,
  type CarDesign,
  type TaWeek,
  type WeatherPlan,
} from "@bpr/shared";
import { cachedMe, isLoggedIn, ownedParts } from "../api.ts";
import { drawTrackCard } from "../draw.ts";
import type { Go } from "../main.ts";
import { RaceView, type GhostEntry } from "../race/view.ts";
import { activeDesign, load, palette, useManual, type Ghost } from "../store.ts";
import { fetchTaBoard, fetchTaGhosts, loadLocalTa, saveLocalTa, submitTaLap, taRpText, type TaBoard, type TaGhostRow, type TaSubmitRes } from "../ta_api.ts";
import { el, fitCanvas, transTag } from "./dom.ts";
import { quickLightsClock } from "./lights.ts";
import "./timeattack.css";

/** 一緒に走れる幽霊の数 */
const MAX_GHOSTS = 3;
/** ほかの人の幽霊の色 (選んだ順ではなく、順位の順に当てる) と、自分の幽霊の色 */
const GHOST_COLORS = ["#3ec7ff", "#ffcf3e", "#ff6bd6"];
const MY_GHOST_COLOR = "#f3f5f8";

const DRY: WeatherPlan = { seed: 1, changes: [{ at: 0, sky: "sun" }], fakes: [], startWet: 0 };

/** 日本時間の 月/日 */
function jstDay(ms: number): string {
  return new Date(ms).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" });
}

/** 今回の走りの結果 (画面に出す) */
interface RunResult {
  laps: Array<{ time: number; valid: boolean }>;
  best: number | null;
  /** 送った結果 / 理由 */
  sent: TaSubmitRes | null;
  note: string;
}

export function mountTimeAttack(root: HTMLElement, go: Go): () => void {
  const s = load();
  let alive = true;
  let week: TaWeek = taWeekAt(Date.now());
  let board: TaBoard | null = null;
  let ghosts: TaGhostRow[] = [];
  let loadErr = "";
  let local = loadLocalTa(week.index);
  let lastRun: RunResult | null = null;
  let cleanupRun: (() => void) | null = null;

  const sheet = el("div", { class: "sheet ta" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  sheet.append(el("div", { class: "ta-top" }, back, el("h2", {}, "1 周アタック"), el("span", { class: "label" }, "Time Attack · Weekly")));
  const body = el("div", { class: "ta-grid" });
  sheet.append(body);

  // ---------- 描く ----------

  const leftEl = el("span", { class: "num" });
  const paintLeft = () => {
    leftEl.textContent = taLeftText(week.endsAt - Date.now());
  };

  function render() {
    if (!alive) return;
    body.innerHTML = "";
    const track = getTrack(week.trackId);
    const tire = TIRE_DEFS[TA_CONDITIONS.tire];

    // 左: 今週のコース + 自分 + 走る
    const course = el("section", { class: "frame ta-course" });
    const thumb = el("canvas") as HTMLCanvasElement;
    paintLeft();
    course.append(
      el("div", { class: "section-title" }, el("h3", {}, "今週のコース"), el("span", { class: "label" }, `${jstDay(week.startsAt)} – ${jstDay(week.endsAt - 1)}`)),
      el(
        "div",
        { class: "ta-course-body" },
        el("div", { class: "ta-thumb" }, thumb),
        el(
          "div",
          { class: "ta-course-meta" },
          el("b", { class: "ta-track" }, week.trackName),
          el("span", { class: "num dim" }, `${(track.length / 1000).toFixed(2)} km`),
          el("div", { class: "ta-left" }, el("span", { class: "label" }, "のこり"), leftEl),
        ),
      ),
      el(
        "div",
        { class: "ta-conds" },
        el("span", { class: "ta-chip" }, "晴れ"),
        el("span", { class: "ta-chip" }, el("i", { class: "ta-tyre", style: `--c:${tire.color}` }, tire.short), `${tire.name}・新品`),
        el("span", { class: "ta-chip" }, "燃料 満タン"),
        el("span", { class: "ta-chip" }, `${TA_RUN_LAPS} 周まで`),
      ),
      el("p", { class: "ta-how dim" }, `止まった所からスタートして ${TA_RUN_LAPS} 周まで走り、一番速い 1 周で競います。`),
    );
    requestAnimationFrame(() => {
      const w = thumb.parentElement?.clientWidth || 160;
      const h = 96;
      const dpr = fitCanvas(thumb, w, h);
      thumb.style.width = "100%";
      const ctx = thumb.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const p = palette();
      drawTrackCard(ctx, track.px, track.py, w, h, p, p.accent);
    });

    const mine = el("section", { class: "frame ta-mine" });
    mine.append(el("div", { class: "section-title" }, el("h3", {}, "あなたの記録"), el("span", { class: "label" }, "Personal best")));
    const myBest = board?.me ?? null;
    const localBest = local.best;
    mine.append(
      el(
        "div",
        { class: "ta-pb" },
        el("div", {}, el("span", { class: "label" }, "Best"), el("b", { class: "num" }, formatTime(myBest?.lap ?? localBest?.lap ?? null))),
        el(
          "div",
          {},
          el("span", { class: "label" }, "順位"),
          el("b", { class: "num" }, myBest ? String(myBest.rank) : "—", el("small", {}, board ? ` / ${board.total}` : "")),
        ),
      ),
    );
    if (!isLoggedIn()) {
      const login = el("button", { class: "small" }, "ログイン");
      login.addEventListener("click", () => go({ name: "account" }));
      mine.append(el("div", { class: "ta-note" }, el("span", {}, "ログインすると記録が順位表に残ります。いまは この機械にだけ残ります。"), login));
    }
    if (loadErr) mine.append(el("div", { class: "callout" }, loadErr));
    if (lastRun) mine.append(resultBox(lastRun));

    // 車
    const design = activeDesign();
    const errs = design ? validateDesign(design) : ["まだ車がありません"];
    const owned = ownedParts();
    const ownErr = design && !errs.length && isLoggedIn() && owned ? checkTaDesign(design, owned) : null;
    mine.append(
      el(
        "div",
        { class: "ta-car" },
        el("span", { class: "label" }, "車"),
        el("b", {}, design?.name ?? "—"),
        el("span", { class: "dim" }, "(メニューで選んだ車)"),
      ),
    );
    if (errs.length) {
      const fix = el("button", { class: "small" }, "車をつくる");
      fix.addEventListener("click", () => go({ name: "builder" }));
      mine.append(el("div", { class: "callout" }, `走るには車を仕上げてください — ${errs[0]}`), fix);
    } else if (ownErr) {
      mine.append(el("div", { class: "callout" }, `${ownErr}。走れますが記録は送れません`));
    }

    // 幽霊を選ぶ
    const picks = ghostChoices();
    if (picks.length) {
      const row = el("div", { class: "ta-ghosts", role: "group", "aria-label": `一緒に走る幽霊 (${MAX_GHOSTS} つまで)` });
      const sel = currentPicks(picks);
      const colors = new Map(chosenEntries(picks).map((e) => [e.key, e.color]));
      const save = (keys: string[]) => {
        local.rival = keys.length ? keys.join(",") : "none";
        saveLocalTa(local);
        render();
      };
      for (const p of picks) {
        const on = sel.includes(p.key);
        const full = !on && sel.length >= MAX_GHOSTS;
        const dot = on ? el("i", { class: "ta-gdot", style: `--c:${colors.get(p.key) ?? MY_GHOST_COLOR}` }) : null;
        const b = el("button", { class: on ? "on" : "", "aria-pressed": String(on) }, dot, p.label) as HTMLButtonElement;
        b.disabled = full;
        b.addEventListener("click", () => save(on ? sel.filter((k) => k !== p.key) : [...sel, p.key]));
        row.append(b);
      }
      const none = el("button", { class: sel.length ? "" : "on", "aria-pressed": String(!sel.length) }, "なし") as HTMLButtonElement;
      none.addEventListener("click", () => save([]));
      row.append(none);
      mine.append(
        el(
          "div",
          { class: "ta-ghost-pick" },
          el("span", { class: "label" }, "幽霊", el("span", { class: "ta-gcount num" }, ` ${sel.length}/${MAX_GHOSTS}`)),
          row,
        ),
      );
    }

    const run = el("button", { class: "go ta-go" }, "走る") as HTMLButtonElement;
    run.disabled = errs.length > 0;
    run.addEventListener("click", () => design && startRun(design));
    mine.append(run);

    const left = el("div", { class: "stack" }, course, mine);

    // 右: 順位表
    const lb = el("section", { class: "frame ta-board" });
    lb.append(el("div", { class: "section-title" }, el("h3", {}, "順位表"), el("span", { class: "label" }, board ? `${board.total} 人` : "Leaderboard")));
    if (!board) {
      lb.append(el("p", { class: "dim ta-empty" }, loadErr ? "読めませんでした" : "読みこみ中…"));
    } else if (!board.top.length) {
      lb.append(el("p", { class: "dim ta-empty" }, "まだ誰も走っていません。一番乗りをどうぞ。"));
    } else {
      const table = el("table", { class: "results ta-table" });
      table.append(el("thead", {}, el("tr", {}, el("th", {}, "順位"), el("th", {}, "運転手"), el("th", { class: "r" }, "タイム"), el("th", { class: "r" }, "差"))));
      const tb = el("tbody");
      const lead = board.top[0].lap;
      const row = (r: { rank: number; driver: string; team: string; lap: number; me: boolean; mt?: boolean }) =>
        el(
          "tr",
          { class: `${r.rank <= 3 ? "podium" : ""} ${r.rank === 1 ? "p1" : ""} ${r.me ? "me" : ""}` },
          el("td", { class: "pos num" }, String(r.rank)),
          el("td", { class: "who" }, el("span", { class: "bar" }), r.driver, el("small", { class: "dim" }, ` ${r.team}`), r.me ? el("span", { class: "tag you" }, "あなた") : null, transTag(r.mt)),
          el("td", { class: "r num" }, formatTime(r.lap)),
          el("td", { class: "r num dim" }, r.lap === lead ? "—" : `+${(r.lap - lead).toFixed(3)}`),
        );
      for (const r of board.top) tb.append(row(r));
      if (board.me && !board.top.some((r) => r.me)) {
        const me = cachedMe();
        tb.append(el("tr", { class: "gap" }, el("td", { colspan: "4" }, "⋯")));
        tb.append(row({ rank: board.me.rank, driver: me?.driver ?? "あなた", team: me?.team ?? "", lap: board.me.lap, me: true }));
      }
      table.append(tb);
      lb.append(table);
    }
    lb.append(el("p", { class: "dim ta-foot" }, "幽霊は走った線だけ。ほかの人の車の設計図は見えません。"));

    body.append(left, lb);
  }

  function resultBox(r: RunResult): HTMLElement {
    const box = el("div", { class: "ta-result" });
    box.append(el("span", { class: "label" }, "今回の走り"));
    const list = el("ol", { class: "ta-laps" });
    r.laps.forEach((l, i) =>
      list.append(
        el(
          "li",
          { class: `${l.valid ? "" : "bad"} ${l.valid && l.time === r.best ? "pb" : ""}` },
          el("span", { class: "label" }, `Lap ${i + 1}`),
          el("b", { class: "num" }, formatTime(l.time)),
          l.valid ? null : el("small", {}, "数えない"),
        ),
      ),
    );
    if (!r.laps.length) list.append(el("li", { class: "dim" }, "周を走り切れませんでした"));
    box.append(list);
    if (r.sent) box.append(el("div", { class: r.sent.improved ? "callout ok" : "callout" }, (r.sent.improved ? `記録しました: ${r.sent.best.rank} 位 / ${r.sent.total} 人` : `前の記録のほうが速い (${r.sent.best.rank} 位)`) + taRpText(r.sent)));
    else if (r.note) box.append(el("div", { class: "callout" }, r.note));
    return box;
  }

  // ---------- 幽霊 ----------

  function myGhost(): Ghost | null {
    const server = ghosts.find((g) => g.me)?.ghost ?? null;
    const lb = local.best;
    if (server && lb) return lb.lap < server.lap ? lb : server;
    return server ?? lb;
  }

  /** 選べる幽霊 (順位の順、最後に自分) */
  function ghostChoices(): Array<{ key: string; label: string; tag: string; ghost: Ghost }> {
    const out: Array<{ key: string; label: string; tag: string; ghost: Ghost }> = [];
    for (const g of ghosts) if (!g.me) out.push({ key: String(g.rank) + ":" + g.driver, label: `${g.rank} 位 ${g.driver}`, tag: `${g.rank} 位 ${g.driver}`, ghost: g.ghost });
    const mg = myGhost();
    if (mg) out.push({ key: "me", label: `自分 ${formatTime(mg.lap)}`, tag: "自分", ghost: mg });
    return out;
  }

  /** 選んでいる幽霊の key (3 つまで)。選んだものが今の表にひとつもなければ、一番速い人 (いなければ自分) */
  function currentPicks(picks: ReturnType<typeof ghostChoices>): string[] {
    if (local.rival === "none") return [];
    const want = local.rival.split(",").filter((k) => picks.some((p) => p.key === k));
    if (want.length) return want.slice(0, MAX_GHOSTS);
    return picks.length ? [picks[0].key] : [];
  }

  /** 選んだ幽霊を、順位の順に色をつけて */
  function chosenEntries(picks: ReturnType<typeof ghostChoices>): Array<GhostEntry & { key: string }> {
    const sel = currentPicks(picks);
    let i = 0;
    return picks
      .filter((p) => sel.includes(p.key))
      .map((p) => ({ key: p.key, ghost: p.ghost, label: p.tag, color: p.key === "me" ? MY_GHOST_COLOR : GHOST_COLORS[i++ % GHOST_COLORS.length] }));
  }

  // ---------- 読みこみ ----------

  async function refresh() {
    try {
      const [b, g] = await Promise.all([fetchTaBoard(), fetchTaGhosts(5).catch(() => [] as TaGhostRow[])]);
      if (!alive) return;
      board = b;
      ghosts = g;
      loadErr = "";
      if (b.week.index !== week.index) {
        week = b.week;
        local = loadLocalTa(week.index);
      }
    } catch (e) {
      if (!alive) return;
      loadErr = `${(e as Error).message}。ひとりで走れます (記録は送れません)`;
    }
    render();
  }

  // ---------- 走る ----------

  function startRun(design: CarDesign) {
    if (validateDesign(design).length) return;
    const track = getTrack(week.trackId);
    const stats = computeStats(design);
    const runWeek = week.index;
    const me = cachedMe();
    const canSend = isLoggedIn() && !(ownedParts() && checkTaDesign(design, ownedParts()));
    let serverBestMs = board?.me ? taLapMs(board.me.lap) : null;
    const result: RunResult = { laps: [], best: null, sent: null, note: "" };
    let sending: Promise<void> = Promise.resolve();

    const layer = el("div", { class: "ta-run", style: "position:fixed;inset:0" });
    const raceRoot = el("div");
    const chip = el("div", { class: "ta-run-chip" });
    chip.style.display = "none";
    layer.append(raceRoot, chip);
    root.append(layer);
    sheet.style.display = "none";

    const showChip = (text: string, ok = true) => {
      chip.textContent = text;
      chip.className = `ta-run-chip ${ok ? "ok" : "bad"}`;
      chip.style.display = "";
    };

    // 幽霊の記録: レースの画面の刻みとは別に、毎こまの車の位置を残して、周が終わったら 0.1 秒の目盛りちょうどに並べ直す
    const rec = new TaGhostRecorder();
    let pending: { start: number; time: number; valid: boolean } | null = null;
    let lapsDone = 0;
    let ended = false;

    // 一緒に走る幽霊。自分の幽霊と走る (選んだとき・まだ誰の幽霊もないとき) なら、速い周が出るたびに入れかえる
    const picks = ghostChoices();
    const chosen = chosenEntries(picks);
    const runGhosts: GhostEntry[] = chosen;
    let myEntry: GhostEntry | null = chosen.find((e) => e.key === "me") ?? null;
    const followMine = !!myEntry || (!picks.length && local.rival !== "none");
    let view: RaceView | null = null;

    // 信号は短く (約 3 秒、lights.ts。周の時間は合図からなので変わらない)
    const quick = quickLightsClock();
    const lightsStartT = quick.lightsStartT;
    let lastT = -Infinity;
    // この走りの変速 (マニュアルの周は MT の印を付けて送る)
    const runManual = useManual();

    const onGhost = (g: Ghost, valid: boolean) => {
      if (!valid) return;
      if (result.best === null || g.lap < result.best) result.best = g.lap;
      if (followMine) {
        if (!myEntry) runGhosts.push((myEntry = { ghost: g, label: "自分", color: MY_GHOST_COLOR }));
        else if (g.lap < myEntry.ghost.lap) myEntry.ghost = g;
      }
      if (!local.best || g.lap < local.best.lap) {
        local.best = g;
        saveLocalTa(local);
      }
      if (!canSend) {
        if (!isLoggedIn()) result.note = "ログインしていないので、記録はこの機械にだけ残りました";
        return;
      }
      if (!taImproves(g.lap, serverBestMs)) return;
      serverBestMs = taLapMs(g.lap);
      sending = sending.then(async () => {
        try {
          const r = await submitTaLap(runWeek, g, design, runManual);
          result.sent = r;
          if (!ended) showChip((r.improved ? `記録しました ${r.best.rank} 位 / ${r.total} 人` : `${r.best.rank} 位のまま`) + taRpText(r));
        } catch (e) {
          result.note = `送れませんでした: ${(e as Error).message}`;
          if (!ended) showChip(result.note, false);
        }
      });
    };

    const clock = () => {
      const t = quick.clock();
      const car = view?.car;
      // このこまで計算が終わった位置 (= 前のこまの時刻の位置)
      if (car && Number.isFinite(lastT)) rec.push(lastT, car.x, car.y, car.heading);
      lastT = t;
      if (pending && rec.lastT() >= pending.start + pending.time) {
        const p = pending;
        pending = null;
        onGhost({ lap: p.time, pts: rec.ghost(p.start, p.time) }, p.valid);
        rec.dropBefore(p.start + p.time - 1);
        if (lapsDone >= TA_RUN_LAPS) setTimeout(() => finish(), 1500);
      }
      return t;
    };

    const opts = {
      root: raceRoot,
      track,
      laps: 0,
      assist: s.assist,
      manual: runManual,
      me: { info: { id: "me", name: s.name || me?.driver || "あなた", design, color: "#ff2b3a", bot: false }, slot: 0, stats },
      clock,
      lightsStartT,
      ghosts: runGhosts,
      // ほかの人の設計図を見せないので、幽霊は全部 見本の車の形
      ghostDesign: SAMPLE_DESIGN,
      modeLabel: "TIME ATTACK",
      weather: DRY,
      setup: { tire: TA_CONDITIONS.tire, fuel: stats.fuelCap, wear: TA_CONDITIONS.wear },
      onLap: (time: number, valid: boolean, lap: { lapStart: number }) => {
        if (ended) return;
        lapsDone++;
        result.laps.push({ time, valid });
        pending = { start: lap.lapStart - time, time, valid };
      },
      onRetire: () => setTimeout(() => finish(), 1500),
      onQuit: () => finish(),
    };
    view = new RaceView(opts);

    async function finish() {
      if (ended) return;
      ended = true;
      view?.destroy();
      view = null;
      chip.textContent = "";
      await sending;
      layer.remove();
      cleanupRun = null;
      if (!alive) return;
      sheet.style.display = "";
      lastRun = result;
      window.scrollTo(0, 0);
      render();
      refresh();
    }
    cleanupRun = () => {
      ended = true;
      view?.destroy();
      layer.remove();
    };
  }

  // ---------- 始める ----------

  render();
  refresh();
  const timer = setInterval(paintLeft, 30_000);
  const onResize = () => {
    if (!cleanupRun) render();
  };
  window.addEventListener("resize", onResize);
  return () => {
    alive = false;
    clearInterval(timer);
    window.removeEventListener("resize", onResize);
    cleanupRun?.();
  };
}

/** メニューに置く入り口 (今週のコースとのこり時間) */
export function taMenuSection(go: Go): HTMLElement {
  const w = taWeekAt(Date.now());
  const b = el(
    "button",
    { class: "ta-entry" },
    el("span", { class: "ta-entry-lap" }, el("b", {}, "1"), el("span", {}, "LAP")),
    el("span", { class: "ta-entry-meta" }, el("b", {}, w.trackName), el("span", { class: "num" }, `のこり ${taLeftText(w.endsAt - Date.now())}`)),
    el("span", { class: "ta-entry-go" }, "▶"),
  );
  b.setAttribute("aria-label", `1 周アタック 今週は ${w.trackName}`);
  b.addEventListener("click", () => go({ name: "timeattack" }));
  return el(
    "section",
    { class: "frame" },
    el("div", { class: "section-title" }, el("h3", {}, "1 周アタック"), el("span", { class: "label" }, "Time Attack · Weekly")),
    el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, `毎週お題のコースを好きなときに。${TA_RUN_LAPS} 周まで走って、一番速い 1 周で競います。上位の幽霊と走れます。`),
    b,
  );
}
