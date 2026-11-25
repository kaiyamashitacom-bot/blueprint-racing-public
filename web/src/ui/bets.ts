// 賭けの画面 (F1 中継風): 2 時間ごとのリーグ戦のレースに、ゲームの中のお金だけで賭ける (DECISIONS 11/25「レースの結果に賭ける」)。
// - レース: 枠 (時刻) を選ぶ → リーグのレース → 車ごとの 1 着・3 着以内の倍率、2 チームの順番の倍率 → 額を入れて賭ける
// - 結果待ち・記録 (当たり・外れ・返し と もらったお金)
// 自分のチームの出るレースには賭けられない。締め切りはスタートの数分前 (管理者の数)。倍率は賭けた時のまま
// - 大会: 優勝 (A 組の 1 位) に賭ける。組が決まってからスタートまで。自分のチームが A 組にいる大会は不可 (server/src/bets_tour.ts)
import * as api from "../api.ts";
import * as bapi from "../bets_api.ts";
import type { Go } from "../main.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import { left, loginGate } from "./teamkit.ts";
import "./account.css";
import "./team.css";
import "./bets.css";

type Tab = "races" | "tours" | "open" | "history";
type Pick = { kind: bapi.BetKind; pick: bapi.BetPickView; odds: number; label: string };

const KIND_SHORT: Record<bapi.BetKind, string> = { win: "1 着", top3: "3 着以内", pair: "2 チーム", tourwin: "大会の優勝" };
const STATUS_TEXT: Record<bapi.BetView["status"], string> = { open: "結果待ち", won: "当たり", lost: "外れ", void: "返し" };

export function mountBets(root: HTMLElement, go: Go): () => void {
  const sheet = el("div", { class: "sheet acc tm bt" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← リーグ戦");
  back.addEventListener("click", () => go({ name: "league" }));
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, "賭け"), el("span", { class: "label" }, "Betting · game money")));
  const body = el("div", { class: "bt-body" });
  sheet.append(body);

  let alive = true;
  let tab: Tab = "races";
  let slotIdx = 0;
  let races: bapi.BetRaces | null = null;
  let mine: bapi.MyBets | null = null;
  let tours: bapi.TourBets | null = null;
  let toursErr: string | null = null;
  const openRace = new Set<string>();
  const clocks: Array<{ node: HTMLElement; at: number }> = [];
  const timer = window.setInterval(() => {
    for (const c of clocks) if (c.node.isConnected) c.node.textContent = c.at - Date.now() > 0 ? `締め切りまで ${left(c.at - Date.now())}` : "締め切り";
  }, 1000);

  if (!api.isLoggedIn()) {
    body.append(loginGate(go));
    return () => clearInterval(timer);
  }

  const wallet = el("b", { class: "tm-num" }, "—");
  const today = el("b", { class: "tm-num" }, "—");
  const strip = el(
    "section",
    { class: "frame bt-strip" },
    el("div", { class: "bt-cash" }, el("span", { class: "label" }, "Money"), wallet, el("small", {}, "手元のお金")),
    el("div", { class: "bt-cash" }, el("span", { class: "label" }, "Today"), today, el("small", {}, "今日 賭けた額")),
    el("p", { class: "bt-rule" }, "賭けられるのはゲームの中のお金だけ。本物のお金・部品・品物は賭けられません。"),
  );
  const nav = el("nav", { class: "tm-nav bt-nav", "aria-label": "賭けの画面" });
  const view = el("div", { class: "bt-view" });
  body.append(strip, nav, view);

  const paintCash = () => {
    wallet.textContent = money(api.cachedMe()?.money ?? 0);
    today.textContent = mine ? money(mine.todayStaked) : "—";
  };

  const paintNav = () => {
    nav.innerHTML = "";
    const tabs: Array<[Tab, string]> = [
      ["races", "レース"],
      ["tours", `大会${tours?.tours.length ? ` ${tours.tours.length}` : ""}`],
      ["open", `結果待ち${mine?.open.length ? ` ${mine.open.length}` : ""}`],
      ["history", "記録"],
    ];
    for (const [t, jp] of tabs) {
      const b = el("button", { class: t === tab ? "on" : "" }, jp);
      b.addEventListener("click", () => {
        tab = t;
        paint();
      });
      nav.append(b);
    }
  };

  async function load() {
    try {
      const [r, m, tb] = await Promise.all([
        bapi.fetchBetRaces(),
        bapi.fetchMyBets(),
        // 大会の優勝の賭けが読めなくても、リーグ戦の賭けは出す
        bapi.fetchTourBets().catch((e: unknown) => {
          toursErr = errText(e);
          return null;
        }),
        api.refreshAccount().catch(() => {}),
      ]);
      if (!alive) return;
      races = r;
      mine = m;
      tours = tb;
      if (tb) toursErr = null;
      paint();
    } catch (e) {
      if (!alive) return;
      view.innerHTML = "";
      view.append(el("div", { class: "frame bad" }, errText(e)));
    }
  }

  function paint() {
    paintCash();
    paintNav();
    view.innerHTML = "";
    clocks.length = 0;
    if (tab === "races") view.append(racesView());
    else if (tab === "tours") view.append(toursView());
    else if (tab === "open") view.append(openView());
    else view.append(historyView());
  }

  // ---------- レース ----------
  function racesView(): HTMLElement {
    const box = el("div", { class: "bt-stack" });
    if (!races) return box;
    if (races.paused || mine?.blocked) box.append(el("div", { class: "frame bad" }, mine?.blocked ?? "賭けは今は一時停止中です"));
    if (!races.slots.length) {
      box.append(el("div", { class: "frame dim" }, "今日はもう賭けられるレースがありません"));
      return box;
    }
    slotIdx = Math.min(slotIdx, races.slots.length - 1);
    const chips = el("div", { class: "bt-slots", role: "tablist", "aria-label": "レースの時刻" });
    races.slots.forEach((s, i) => {
      const b = el(
        "button",
        { class: `bt-slot${i === slotIdx ? " on" : ""}${s.open ? "" : " closed"}`, role: "tab", "aria-selected": String(i === slotIdx) },
        el("b", { class: "tm-num" }, hm(s.startsAt)),
        el("small", {}, s.trackName),
      );
      b.addEventListener("click", () => {
        slotIdx = i;
        paint();
      });
      chips.append(b);
    });
    box.append(chips);
    const s = races.slots[slotIdx];
    const head = el(
      "section",
      { class: "frame bt-slothead" },
      el("div", { class: "section-title" }, el("h3", {}, `${hm(s.startsAt)} · ${s.trackName}`), el("span", { class: "label" }, `${s.laps} laps`)),
    );
    const cl = el("div", { class: `bt-close tm-num${s.open ? "" : " shut"}` });
    clocks.push({ node: cl, at: s.closesAt });
    cl.textContent = s.open ? `締め切りまで ${left(s.closesAt - Date.now())}` : "締め切り";
    head.append(cl, el("p", { class: "bt-note" }, `スタートの ${races.closeMinutes} 分前に締め切り。倍率は賭けた時のまま。胴元の取り分 ${Math.round(races.margin * 100)}%。`));
    box.append(head);
    if (!s.races.length) box.append(el("div", { class: "frame dim" }, "この枠のレースはまだありません"));
    for (const r of s.races) box.append(raceCard(r, s));
    return box;
  }

  function raceCard(r: bapi.BetRaceBrief, s: bapi.BetSlot): HTMLElement {
    const card = el("section", { class: `frame bt-race${r.mine ? " mine" : ""}` });
    const head = el(
      "button",
      { class: "bt-race-head", "aria-expanded": String(openRace.has(r.raceId)) },
      el("span", { class: "bt-lg tm-num" }, r.league),
      el("span", { class: "bt-teams" }, r.teams.map((t) => t.name).join(" · ")),
      r.mine ? el("span", { class: "bt-tag" }, "自分のレース") : el("span", { class: "bt-open" }, openRace.has(r.raceId) ? "閉じる" : "倍率"),
    );
    card.append(head);
    if (r.mine) {
      head.setAttribute("disabled", "");
      card.append(el("p", { class: "bt-note" }, "自分のチームが出るレースには賭けられません。"));
      return card;
    }
    const detail = el("div", { class: "bt-detail" });
    card.append(detail);
    const fill = async () => {
      detail.innerHTML = "";
      detail.append(el("p", { class: "dim bt-note" }, "倍率を出しています…"));
      try {
        const book = await bapi.fetchRaceBook(r.raceId);
        if (!alive) return;
        detail.innerHTML = "";
        detail.append(bookView(book, s.open && !races?.paused && !mine?.blocked, fill));
      } catch (e) {
        detail.innerHTML = "";
        detail.append(el("p", { class: "bad bt-note" }, errText(e)));
      }
    };
    head.addEventListener("click", () => {
      if (openRace.has(r.raceId)) openRace.delete(r.raceId);
      else openRace.add(r.raceId);
      paint();
    });
    if (openRace.has(r.raceId)) void fill();
    return card;
  }

  function bookView(book: bapi.RaceBookView, canBet: boolean, refill: () => Promise<void>): HTMLElement {
    const box = el("div", { class: "bt-book" });
    let kind: bapi.BetKind = "win";
    let chosen: Pick | null = null;
    const seg = el("div", { class: "bt-seg", role: "tablist" });
    const list = el("div", { class: "bt-list" });
    const slip = el("div", { class: "bt-slip" });
    box.append(el("div", { class: "bt-meta" }, `${book.trackName} · ${book.laps} 周 · 天気の見込み ${book.sky}`), seg, list, slip);

    const paintSeg = () => {
      seg.innerHTML = "";
      for (const k of ["win", "top3", "pair"] as bapi.BetKind[]) {
        const b = el("button", { class: k === kind ? "on" : "", role: "tab", "aria-selected": String(k === kind) }, KIND_SHORT[k]);
        b.addEventListener("click", () => {
          kind = k;
          chosen = null;
          paintAll();
        });
        seg.append(b);
      }
    };

    const oddsBtn = (odds: number | null, p: Pick | null, aria: string) => {
      const on = !!chosen && !!p && JSON.stringify(chosen.pick) === JSON.stringify(p.pick) && chosen.kind === p.kind;
      const b = el("button", { class: `bt-odds tm-num${on ? " on" : ""}`, "aria-label": aria, "aria-pressed": String(on) }, odds === null ? "—" : odds.toFixed(2)) as HTMLButtonElement;
      if (odds === null || !p || !canBet) b.disabled = true;
      else
        b.addEventListener("click", () => {
          chosen = on ? null : p;
          paintAll();
        });
      return b;
    };

    const paintList = () => {
      list.innerHTML = "";
      if (kind === "pair") {
        list.append(el("div", { class: "bt-hint" }, "どちらのチームが先にゴールするか (2 台のうち前の 1 台で比べる)"));
        for (const pr of book.pairs) {
          const a = book.teams.find((t) => t.i === pr.a)!;
          const b = book.teams.find((t) => t.i === pr.b)!;
          list.append(
            el(
              "div",
              { class: "bt-pair" },
              el("span", { class: "bt-pn a" }, a.name),
              oddsBtn(pr.oddsA, { kind: "pair", pick: { first: a.i, second: b.i }, odds: pr.oddsA ?? 0, label: `${a.name} が先` }, `${a.name} が ${b.name} より前 ${pr.oddsA ?? "なし"} 倍`),
              el("span", { class: "bt-vs" }, "vs"),
              oddsBtn(pr.oddsB, { kind: "pair", pick: { first: b.i, second: a.i }, odds: pr.oddsB ?? 0, label: `${b.name} が先` }, `${b.name} が ${a.name} より前 ${pr.oddsB ?? "なし"} 倍`),
              el("span", { class: "bt-pn b" }, b.name),
            ),
          );
        }
        return;
      }
      list.append(el("div", { class: "bt-row head" }, el("span", {}, "並"), el("span", {}, "運転手 / チーム"), el("span", { class: "n" }, KIND_SHORT[kind])));
      const cars = book.teams.flatMap((t, ti) => t.cars.map((c) => ({ c, t, ti }))).sort((x, y) => x.c.grid - y.c.grid);
      for (const { c, t, ti } of cars) {
        const odds = kind === "win" ? c.win : c.top3;
        list.append(
          el(
            "div",
            { class: `bt-row t${ti}` },
            el("span", { class: "grid tm-num" }, `P${c.grid}`),
            el("span", { class: "who" }, el("b", {}, c.driver), el("small", {}, `${t.name}${t.human ? "" : " · CPU"}`)),
            oddsBtn(odds, { kind, pick: { car: c.car }, odds: odds ?? 0, label: `${c.driver} (${t.name})` }, `${c.driver} ${KIND_SHORT[kind]} ${odds ?? "なし"} 倍`),
          ),
        );
      }
    };

    const paintSlip = () => {
      slip.innerHTML = "";
      if (!canBet) {
        slip.append(el("p", { class: "bt-note" }, book.mine ? "自分のチームが出るレースには賭けられません。" : "このレースは今は賭けられません。"));
        return;
      }
      if (!chosen) {
        slip.append(el("p", { class: "bt-note" }, "倍率を押して選びます。"));
        return;
      }
      slip.append(...stakeSlip(chosen, (stake, c) => bapi.placeBet({ raceId: book.raceId, kind: c.kind, pick: c.pick, stake, odds: c.odds }), refill));
    };

    const paintAll = () => {
      paintSeg();
      paintList();
      paintSlip();
    };
    paintAll();
    return box;
  }

  /** 額を入れて賭ける欄 (リーグ戦と大会で同じ)。409 (倍率が変わった・締め切った) なら refill で出し直す */
  function stakeSlip(c: Pick, place: (stake: number, c: Pick) => Promise<unknown>, refill: () => Promise<void> | void): HTMLElement[] {
    const input = el("input", { type: "number", inputmode: "numeric", min: "1", step: "1", class: "bt-stake tm-num", "aria-label": "賭ける額" }) as HTMLInputElement;
    input.value = String(Math.min(100, api.cachedMe()?.money ?? 0) || "");
    const ret = el("b", { class: "tm-num" });
    const upd = () => {
      const n = Math.floor(Number(input.value) || 0);
      ret.textContent = money(Math.floor(n * c.odds + 1e-6));
    };
    input.addEventListener("input", upd);
    upd();
    const quick = el("div", { class: "bt-quick" });
    for (const [t, v] of [["100", 100], ["1,000", 1000], ["10,000", 10000], ["全部", -1]] as Array<[string, number]>) {
      const b = el("button", { class: "small" }, t);
      b.addEventListener("click", () => {
        input.value = String(v < 0 ? (api.cachedMe()?.money ?? 0) : v);
        upd();
      });
      quick.append(b);
    }
    const go = el("button", { class: "primary bt-go" }, "賭ける") as HTMLButtonElement;
    go.addEventListener("click", async () => {
      const stake = Math.floor(Number(input.value) || 0);
      if (stake <= 0) return toast("額を入れてください", true);
      go.disabled = true;
      try {
        await place(stake, c);
        toast(`賭けました: ${money(stake)} 円 × ${c.odds.toFixed(2)}`);
        await load();
      } catch (e) {
        toast(errText(e), true);
        go.disabled = false;
        // 倍率が変わった・締め切った → 出し直す
        if ((e as { status?: number }).status === 409) void refill();
      }
    });
    return [
      el("div", { class: "bt-slip-pick" }, el("span", { class: "label" }, KIND_SHORT[c.kind]), el("b", {}, c.label), el("span", { class: "bt-x tm-num" }, `× ${c.odds.toFixed(2)}`)),
      el("div", { class: "bt-slip-row" }, input, el("span", { class: "bt-ret" }, el("small", {}, "当たると"), ret, el("small", {}, "円"))),
      quick,
      go,
    ];
  }

  // ---------- 大会の優勝 ----------
  function toursView(): HTMLElement {
    const box = el("div", { class: "bt-stack" });
    if (!tours) {
      box.append(el("div", { class: "frame bad" }, toursErr ?? "大会の賭けを読めませんでした"));
      return box;
    }
    if (tours.paused || mine?.blocked) box.append(el("div", { class: "frame bad" }, mine?.blocked ?? "賭けは今は一時停止中です"));
    box.append(
      el(
        "section",
        { class: "frame bt-slothead" },
        el("div", { class: "section-title" }, el("h3", {}, "大会の優勝"), el("span", { class: "label" }, "Tournament winner")),
        el(
          "p",
          { class: "bt-note" },
          `優勝 = A 組 (予選の上の組) の 1 位。組が決まる スタートの ${tours.leadMinutes} 分前 から スタートまで賭けられます。自分のチームが A 組にいる大会には賭けられません。倍率は予選の記録と強さの見込みから。胴元の取り分 ${Math.round(tours.margin * 100)}%。`,
        ),
      ),
    );
    for (const t of tours.tours) box.append(tourCard(t));
    if (!tours.tours.length) box.append(el("div", { class: "frame dim" }, "今 賭けられる大会はありません"));
    if (tours.upcoming.length) {
      const up = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "これからの大会"), el("span", { class: "label" }, "Upcoming")));
      for (const u of tours.upcoming) {
        up.append(
          el(
            "div",
            { class: "bt-bet" },
            el("span", { class: "bt-st open" }, dayLabel(u.startsAt)),
            el("span", { class: "bt-what" }, el("b", {}, u.name), el("small", {}, `${u.trackName} · ${u.laps} 周${u.allEnter ? " · 全員参加" : ""}`)),
            el("span", { class: "bt-amt tm-num" }, `${hm(u.startsAt)} スタート`),
            el("span", { class: "bt-pay tm-num" }, el("small", {}, "賭けは "), `${hm(u.opensAt)} から`),
          ),
        );
      }
      box.append(up);
    }
    return box;
  }

  function tourCard(t: bapi.TourBookView): HTMLElement {
    const canBet = t.open && !t.mine && !tours?.paused && !mine?.blocked;
    const card = el("section", { class: `frame bt-race${t.mine ? " mine" : ""}` });
    const cl = el("div", { class: `bt-close tm-num${t.open ? "" : " shut"}` });
    clocks.push({ node: cl, at: t.closesAt });
    cl.textContent = t.open ? `締め切りまで ${left(t.closesAt - Date.now())}` : "締め切り";
    card.append(
      el("div", { class: "section-title" }, el("h3", {}, t.name), el("span", { class: "label" }, `${t.trackName} · ${t.laps} laps · ${t.group} 組`)),
      cl,
    );
    let chosen: Pick | null = null;
    const list = el("div", { class: "bt-list" });
    const slip = el("div", { class: "bt-slip" });
    card.append(list, slip);
    const refill = async () => {
      try {
        tours = await bapi.fetchTourBets();
      } catch {
        /* そのまま */
      }
      if (alive) paint();
    };
    const paintCard = () => {
      list.innerHTML = "";
      list.append(el("div", { class: "bt-row head" }, el("span", {}, "並"), el("span", {}, "運転手 / チーム"), el("span", { class: "n" }, "優勝")));
      for (const c of [...t.cars].sort((a, b) => a.grid - b.grid)) {
        const p: Pick = { kind: "tourwin", pick: { car: c.car }, odds: c.odds ?? 0, label: `${c.driver} (${c.team})` };
        const on = chosen?.pick && "car" in chosen.pick && chosen.pick.car === c.car;
        const b = el("button", { class: `bt-odds tm-num${on ? " on" : ""}`, "aria-label": `${c.driver} 優勝 ${c.odds ?? "なし"} 倍`, "aria-pressed": String(!!on) }, c.odds === null ? "—" : c.odds.toFixed(2)) as HTMLButtonElement;
        if (c.odds === null || !canBet) b.disabled = true;
        else
          b.addEventListener("click", () => {
            chosen = on ? null : p;
            paintCard();
          });
        const pace = c.qualiLap !== null ? `予選 ${lapText(c.qualiLap)}` : c.estLap !== null ? `見込み ${lapText(c.estLap)}` : "記録なし";
        list.append(
          el(
            "div",
            { class: "bt-row" },
            el("span", { class: "grid tm-num" }, `P${c.grid}`),
            el("span", { class: "who" }, el("b", {}, c.driver), el("small", {}, `${c.team} · ${pace}`)),
            b,
          ),
        );
      }
      slip.innerHTML = "";
      if (!canBet) slip.append(el("p", { class: "bt-note" }, t.mine ? "自分のチームが A 組 (優勝を決める組) にいるので賭けられません。" : "この大会は今は賭けられません。"));
      else if (!chosen) slip.append(el("p", { class: "bt-note" }, "倍率を押して選びます。"));
      else slip.append(...stakeSlip(chosen, (stake, c) => bapi.placeTourBet({ tourId: t.tourId, car: (c.pick as { car: string }).car, stake, odds: c.odds }), refill));
    };
    paintCard();
    return card;
  }

  // ---------- 結果待ち・記録 ----------
  function openView(): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "結果待ち"), el("span", { class: "label" }, "Open bets")));
    if (!mine?.open.length) {
      f.append(el("p", { class: "dim bt-note" }, "結果待ちの賭けはありません。"));
      return f;
    }
    for (const b of mine.open) f.append(betRow(b));
    f.append(el("p", { class: "bt-note" }, "レースが終わると自動で払われます。計算できなかったレースは返します。"));
    return f;
  }

  function historyView(): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "記録"), el("span", { class: "label" }, "History")));
    if (mine) {
      const net = mine.totals.back - mine.totals.staked;
      f.append(
        el(
          "div",
          { class: "bt-sum" },
          el("span", {}, `${mine.totals.bets} 回`),
          el("span", {}, `賭けた ${money(mine.totals.staked)}`),
          el("span", {}, `戻った ${money(mine.totals.back)}`),
          el("b", { class: `tm-num ${net >= 0 ? "up" : "down"}` }, `${net >= 0 ? "+" : ""}${money(net)}`),
        ),
      );
    }
    if (!mine?.history.length) {
      f.append(el("p", { class: "dim bt-note" }, "まだありません。"));
      return f;
    }
    for (const b of mine.history) f.append(betRow(b));
    return f;
  }

  function betRow(b: bapi.BetView): HTMLElement {
    const right =
      b.status === "open"
        ? el("span", { class: "bt-pay tm-num" }, el("small", {}, "当たると "), money(Math.floor(b.stake * b.odds + 1e-6)))
        : el("span", { class: `bt-pay tm-num ${b.status}` }, b.status === "lost" ? "0" : `+${money(b.payout)}`);
    return el(
      "div",
      { class: `bt-bet ${b.status}` },
      el("span", { class: `bt-st ${b.status}` }, STATUS_TEXT[b.status]),
      el("span", { class: "bt-what" }, el("b", {}, b.label), el("small", {}, `${dayLabel(b.startsAt)} ${b.race}`)),
      el("span", { class: "bt-amt tm-num" }, `${money(b.stake)} × ${b.odds.toFixed(2)}`),
      right,
    );
  }

  void load();
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

/** 1 周の秒 → 1:23.456 */
function lapText(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(3).padStart(6, "0")}`;
}

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
  const t = new Date(n.getTime() + 86_400_000);
  if (d.toDateString() === t.toDateString()) return "あす";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
