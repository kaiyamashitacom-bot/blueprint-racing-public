// リーグ戦の画面 (F1 中継風): 自分の部と肩書きを大きく (王者は金の枠)・今日の順位・自分のチームの出たレース・次のレースまでの残り・8 つの部の段。
// レースは 2 時間ごとにサーバーが自動で計算する (自分では走らない)。見られるのは自分のチームの出たレースだけ
import { formatTime, PERSONALITIES, TRACK_DEFS, type PersonalityId } from "@bpr/shared";
import * as api from "../api.ts";
import * as lapi from "../league_api.ts";
import type { Go } from "../main.ts";
import { errText } from "./account.ts";
import { el } from "./dom.ts";
import { left, loginGate } from "./teamkit.ts";
import "./account.css";
import "./team.css";
import "./league.css";

const KIND_TEXT: Record<lapi.LeagueRaceCar["kind"], string> = { standin: "代走", hired: "雇った運転手", cpu: "代走 CPU", rival: "CPU" };

export function mountLeague(root: HTMLElement, go: Go): () => void {
  const sheet = el("div", { class: "sheet acc tm lg" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  // 賭けの画面へ (ほかのリーグのレースに、ゲームの中のお金で賭ける)
  const betsBtn = el("button", { class: "small lg-bets" }, "賭け");
  betsBtn.addEventListener("click", () => go({ name: "bets" }));
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, "リーグ戦"), el("span", { class: "label" }, "League · 2h"), betsBtn));
  const body = el("div", { class: "lg-body" });
  sheet.append(body);

  let alive = true;
  let timer = 0;
  let reloadAt = 0;
  let next: lapi.NextRace | null = null;
  let pending = 0;
  const clock = el("b", { class: "lg-clock tm-num" }, "--:--:--");
  const clockSub = el("div", { class: "lg-clock-sub" });

  const tick = () => {
    if (!alive) return;
    if (next) {
      const ms = next.at - Date.now();
      clock.textContent = ms > 0 ? left(ms) : "0:00:00";
      clockSub.textContent = pending > 0 ? `計算中 · あと ${pending} レース` : `${next.trackName} · ${next.laps} 周 · ${hm(next.at)} から`;
      // 時刻が来たら、少し待ってから読み直す (サーバーが 1 レースずつ計算する)
      if (ms <= -8000 && Date.now() > reloadAt) {
        reloadAt = Date.now() + 20_000;
        void load();
      }
    }
  };
  timer = window.setInterval(tick, 1000);

  const nextFrame = () =>
    el(
      "section",
      { class: "frame lg-next" },
      el("div", { class: "section-title" }, el("h3", {}, "次のレース"), el("span", { class: "label" }, "Next race")),
      clock,
      clockSub,
      el("p", { class: "lg-note" }, "2 時間ごとに自動で走ります。あなたの車は代走、2 台目は雇った運転手 (いなければ代走 CPU) が走ります。"),
    );

  async function load() {
    if (!api.isLoggedIn()) {
      body.innerHTML = "";
      body.append(loginGate(go), nextFrame());
      try {
        next = await lapi.fetchNextRace();
        tick();
      } catch {
        /* 時刻だけなので出なくてよい */
      }
      return;
    }
    try {
      const [me, res, ladder] = await Promise.all([lapi.fetchMyLeague(), lapi.fetchLeagueResults(12), lapi.fetchLadder()]);
      if (!alive) return;
      next = me.next;
      pending = me.pending;
      if (pending > 0) reloadAt = 0;
      render(me, res.results, ladder);
      tick();
      if (pending > 0) window.setTimeout(() => alive && void load(), 6000);
    } catch (e) {
      if (!alive) return;
      body.innerHTML = "";
      body.append(el("div", { class: "frame bad" }, errText(e)));
    }
  }

  function render(me: lapi.MyLeague, results: lapi.LeagueRace[], ladder: lapi.Ladder) {
    body.innerHTML = "";
    const main = el("div", { class: "lg-main" });
    const side = el("div", { class: "lg-side" });
    body.append(el("div", { class: "lg-grid" }, main, side));
    main.append(hero(me));
    if (me.league) main.append(today(me));
    main.append(recent(results));
    side.append(nextFrame(), ladderFrame(ladder, me));
  }

  void load();
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

// ---------- 自分の部と肩書き ----------
function hero(me: lapi.MyLeague): HTMLElement {
  const l = me.league;
  if (!l) return el("section", { class: "frame lg-hero" }, el("div", { class: "lg-title" }, "まだリーグに入っていません"));
  const champ = l.isChampion;
  // 同じ部の 2 つ目からのリーグの字 (8 部 B → B)
  const letter = l.name.replace(/^\d+ 部\s?/, "");
  const f = el(
    "section",
    { class: `frame lg-hero${champ ? " champ" : ""}`, "aria-label": `${l.name} ${l.title}` },
    el("div", { class: "lg-div" }, el("b", { class: "tm-num" }, String(l.division)), el("span", {}, "部"), letter ? el("em", { class: "tm-num" }, letter) : null),
    el("div", { class: "lg-titles" }, el("span", { class: "label" }, champ ? "Champion" : "Title"), el("div", { class: "lg-title" }, l.title), champ ? el("div", { class: "lg-sub" }, `1 部の一番 · ${l.divisionTitle}のさらに上`) : el("div", { class: "lg-sub" }, divisionHint(l.division))),
  );
  const last = me.lastDay;
  if (last && last.rank !== null) {
    const bits = [`前の日 ${last.rank} 位`];
    if (last.prize > 0) bits.push(`賞金 +${last.prize.toLocaleString("ja-JP")}`);
    if (last.moved === "up") bits.push("1 つ上の部へ");
    if (last.moved === "down") bits.push("1 つ下の部へ");
    if (last.champion) bits.push("王者に");
    f.append(el("div", { class: `lg-last${last.moved === "up" || last.champion ? " up" : last.moved === "down" ? " down" : ""}` }, bits.join(" · ")));
  }
  return f;
}

function divisionHint(d: number): string {
  if (d === 1) return "一番上の部 · ここで一番なら王者";
  if (d === 8) return "はじめの部 · 毎日 1 チームが上へ";
  return `毎日 上の人は ${d - 1} 部へ、下の人は ${d + 1} 部へ`;
}

// ---------- 今日の順位 ----------
function today(me: lapi.MyLeague): HTMLElement {
  const l = me.league!;
  const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "今日の順位"), el("span", { class: "label" }, `${l.name} · Today`)));
  const table = el("div", { class: "lg-table", role: "table", "aria-label": "今日の順位" });
  table.append(
    el("div", { class: "lg-row head", role: "row" }, el("span", {}, "順"), el("span", {}), el("span", {}, "チーム"), el("span", { class: "n" }, "走"), el("span", { class: "n" }, "勝"), el("span", { class: "n" }, "点")),
  );
  for (const r of l.rows) {
    const tag = r.human
      ? r.title
        ? el("span", { class: `lg-tag${r.title === "王者" ? " champ" : ""}` }, r.title)
        : null
      : el("span", { class: "lg-tag cpu" }, `CPU · ${PERSONALITIES[r.personality as PersonalityId]?.name ?? "コンピューター"}`);
    table.append(
      el(
        "div",
        { class: `lg-row${r.mine ? " mine" : ""}${r.human ? "" : " cpu"}`, role: "row" },
        el("span", { class: "pos tm-num" }, String(r.rank)),
        el("i", { class: "bar" }),
        el("span", { class: "name" }, el("b", {}, r.name), tag),
        el("span", { class: "n tm-num" }, String(r.races)),
        el("span", { class: "n tm-num" }, String(r.wins)),
        el("span", { class: "n pts tm-num" }, String(r.points)),
      ),
    );
  }
  f.append(
    table,
    el("p", { class: "lg-note" }, `毎日 22 時のレースのあとに締めて、点は 0 に。人のチームの上の方は上の部へ、下の方は下の部へ。上位 2 位までの人のチームに賞金 (下の部ほど多い)。`),
  );
  return f;
}

// ---------- 自分のチームの出たレース ----------
function recent(results: lapi.LeagueRace[]): HTMLElement {
  const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "最近のレース"), el("span", { class: "label" }, "My races")));
  if (!results.length) {
    f.append(el("p", { class: "dim lg-empty" }, "まだ走っていません。次のレースのあとに出ます。"));
    return f;
  }
  const list = el("div", { class: "lg-races" });
  for (const r of results) list.append(raceCard(r));
  f.append(list, el("p", { class: "lg-note" }, "見られるのは自分のチームの出たレースだけです。"));
  return f;
}

function raceCard(r: lapi.LeagueRace): HTMLElement {
  const when = el("span", { class: "when tm-num" }, dayLabel(r.at), " ", hm(r.at));
  const head = el("button", { class: "lg-race-head", "aria-expanded": "false" }, when, el("span", { class: "trk" }, `${trackName(r.trackId)} · ${r.league}${r.wetMax >= 0.3 ? " · 雨" : ""}`));
  const card = el("div", { class: `lg-race${r.status === "done" ? "" : " skip"}` }, head);
  if (r.status !== "done") {
    head.append(el("span", { class: "mycars dim" }, "計算していない (点なし)"));
    head.setAttribute("disabled", "");
    return card;
  }
  const my = r.cars.filter((c) => c.mine);
  const chips = el("span", { class: "mycars" });
  for (const c of my) chips.append(el("span", { class: `lg-chip${c.pos === 1 ? " win" : ""}` }, el("b", { class: "tm-num" }, c.finished ? `P${c.pos}` : "OUT"), ` ${c.points} 点`));
  head.append(chips);
  const detail = el("div", { class: "lg-detail" });
  detail.hidden = true;
  const lead = r.cars[0];
  for (const c of r.cars) {
    detail.append(
      el(
        "div",
        { class: `lg-res${c.mine ? " mine" : ""}${c.human ? "" : " cpu"}` },
        el("span", { class: "pos tm-num" }, String(c.pos)),
        el("span", { class: "who" }, el("b", {}, c.driver), el("small", {}, `${c.team} · ${KIND_TEXT[c.kind]}`)),
        el("span", { class: "gap tm-num" }, gapText(c, lead)),
        el("span", { class: `best tm-num${c.fastest ? " fl" : ""}` }, c.best === null ? "—" : formatTime(c.best)),
        el("span", { class: "pts tm-num" }, c.points ? `${c.points}` : ""),
      ),
    );
  }
  card.append(detail);
  head.addEventListener("click", () => {
    detail.hidden = !detail.hidden;
    head.setAttribute("aria-expanded", String(!detail.hidden));
  });
  return card;
}

function gapText(c: lapi.LeagueRaceCar, lead: lapi.LeagueRaceCar): string {
  if (c.retired) return "リタイア";
  if (!c.finished) return "—";
  if (c === lead) return formatTime(c.total);
  if (c.lapsDone < lead.lapsDone) return `+${lead.lapsDone - c.lapsDone} 周`;
  return `+${(c.total - lead.total).toFixed(3)}`;
}

// ---------- 8 つの部の段 ----------
function ladderFrame(ladder: lapi.Ladder, me: lapi.MyLeague): HTMLElement {
  const f = el("section", { class: "frame lg-ladder" }, el("div", { class: "section-title" }, el("h3", {}, "部の段"), el("span", { class: "label" }, "Divisions")));
  const champ = ladder.champion ?? (me.champion ? { name: me.champion.name, mine: me.champion.mine } : null);
  f.append(
    el(
      "div",
      { class: `lg-step champ${champ?.mine ? " mine" : ""}` },
      el("span", { class: "d tm-num" }, "★"),
      el("span", { class: "t" }, el("b", {}, "王者"), el("small", {}, champ ? champ.name : "まだいません")),
    ),
  );
  for (const d of ladder.divisions) {
    f.append(
      el(
        "div",
        { class: `lg-step${d.mine ? " mine" : ""}` },
        el("span", { class: "d tm-num" }, String(d.division)),
        el("span", { class: "t" }, el("b", {}, d.title), el("small", {}, d.leagues ? `リーグ ${d.leagues} · 人 ${d.humans}` : "まだ誰もいない")),
        d.mine ? el("span", { class: "you" }, "あなた") : null,
      ),
    );
  }
  return f;
}

// ---------- メニューとほかの画面 ----------

/** はじめの画面の札: 自分の肩書き・次のレースまで・リーグ戦の画面へ */
export function leagueMenuSection(go: Go): HTMLElement {
  const tag = el("span", { class: "lg-tag" }, api.isLoggedIn() ? "…" : "ログインで参加");
  const count = el("b", { class: "tm-num lg-menu-clock" }, "--:--:--");
  const open = el("button", { class: "primary" }, "リーグ戦を見る") as HTMLButtonElement;
  open.addEventListener("click", () => go({ name: "league" }));
  const bets = el("button", { class: "small lg-menu-bets" }, "賭け") as HTMLButtonElement;
  bets.addEventListener("click", () => go({ name: "bets" }));
  const box = el(
    "section",
    { class: "frame lg-menu" },
    el("div", { class: "section-title" }, el("h3", {}, "リーグ戦"), el("span", { class: "label" }, "League · every 2h")),
    el("div", { class: "lg-menu-row" }, tag, el("span", { class: "dim" }, "次のレースまで"), count),
    el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, "2 時間ごとに自動で走ります (代走と雇った運転手)。毎日 部が入れ替わります。"),
    el("div", { class: "lg-menu-btns" }, open, bets),
  );
  let at = 0;
  const t = window.setInterval(() => {
    if (!box.isConnected) return clearInterval(t);
    if (at) count.textContent = left(at - Date.now());
  }, 1000);
  lapi
    .fetchNextRace()
    .then((n) => {
      at = n.at;
      count.textContent = left(at - Date.now());
    })
    .catch(() => {});
  if (api.isLoggedIn()) {
    myTitle()
      .then((t) => {
        tag.textContent = t ? t.title : "リーグ戦";
        tag.classList.toggle("champ", !!t?.champion);
      })
      .catch(() => (tag.textContent = "リーグ戦"));
  }
  return box;
}

let titleCache: { at: number; v: Promise<{ title: string; champion: boolean } | null> } | null = null;

/** 自分の肩書き (1 分覚えておく) */
function myTitle(): Promise<{ title: string; champion: boolean } | null> {
  if (titleCache && Date.now() - titleCache.at < 60_000) return titleCache.v;
  const v = lapi.fetchMyLeague().then((m) => (m.league ? { title: m.league.title, champion: m.league.isChampion } : null));
  titleCache = { at: Date.now(), v };
  v.catch(() => (titleCache = null));
  return v;
}

/** チーム名の横に出す肩書きの札 (あとから入る。ログインしていなければ空) */
export function leagueTitleTag(): HTMLElement {
  const tag = el("span", { class: "lg-tag lg-inline" });
  tag.hidden = true;
  if (!api.isLoggedIn()) return tag;
  myTitle()
    .then((t) => {
      if (!t) return;
      tag.textContent = t.title;
      tag.classList.toggle("champ", t.champion);
      tag.hidden = false;
    })
    .catch(() => {});
  return tag;
}

// ---------- 小さな道具 ----------
function hm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const n = new Date();
  if (d.toDateString() === n.toDateString()) return "今日";
  const y = new Date(n.getTime() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return "きのう";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function trackName(id: string): string {
  return TRACK_DEFS.find((d) => d.id === id)?.name ?? id;
}
