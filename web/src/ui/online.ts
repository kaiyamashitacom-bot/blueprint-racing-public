// すぐ走る (ネットで大勢): 待合 → レース → 結果 をサーバーに合わせて見せる
import { CUSTOM_START_MIN, TIRE_DEFS, computeStats, forecastAt, formatTime, getTrack, inPit, inService, packDamage, readDamage, resultTimeText, validateDesign, wetnessAt, type PhaseInfo, type RosterEntry, type ServerMsg, type TireCompound, type TireSets } from "@bpr/shared";
import type { Go } from "../main.ts";
import { cachedMe, getToken, isLoggedIn } from "../api.ts";
import { fetchTournament } from "../season_api.ts";
import { Net } from "../net.ts";
import { RaceView } from "../race/view.ts";
import { replayButton, type ReplayPanel } from "../race/replay-ui.ts";
import { sectorResults, type SectorSummary } from "../race/sectors-ui.ts";
import { closeReplay, replayLength, type ReplayBuffer } from "@bpr/shared";
import { activeDesign, load } from "../store.ts";
import { el, transTag } from "./dom.ts";
import { raceTireSetup, setupFuel, setupPanel } from "./setup.ts";
import { syncRaceSetup } from "../rooms_api.ts";

export function mountOnline(
  root: HTMLElement,
  go: Go,
  laps: number,
  tour?: { id: string; g: number },
  /** 開いた部屋 (部屋の一覧から)。host = 自分が開いた (早めに始められる) */
  room?: { id: string; host: boolean },
): () => void {
  const design = activeDesign();
  if (!design || validateDesign(design).length) {
    go({ name: "builder" });
    return () => {};
  }
  const s = load();
  const stats = computeStats(design);

  let myId = "";
  let waiting = false;
  let info: PhaseInfo | null = null;
  let roster: RosterEntry[] = [];
  let view: RaceView | null = null;
  /** 終わったレースの走った線 (結果の札から開く) */
  let lastLine: { buf: ReplayBuffer; trackId: string } | null = null;
  /** 終わったレースの全員の一番速いセクター (画面で数えたもの。結果の札に出す) */
  let lastSectors: SectorSummary[] = [];
  /** 開いている走った線の札 (結果が終わったら閉じる。開いたままだと次の待合とレースが隠れる) */
  let replayPanel: ReplayPanel | null = null;
  /** 今のレースのコース (待合は次のコースを見せるので、走った線はこちらで覚える) */
  let raceTrackId = "";
  let viewKey = 0;
  let stateTimer = 0;
  let uiTimer = 0;
  let finishedSent = false;
  let dropped = false;
  let quitting = false;
  /** サーバーに断られた・別の画面に席を渡した (自動ではつなぎ直さない) */
  let stopped = false;
  /** 待合の準備の札 (待合のあいだ同じものを使う。毎回作り直すと押しにくい) */
  let setupEl: HTMLElement | null = null;
  let setupKey = "";
  /** 結果の札 (結果のあいだ 1 度だけ作り、残りの秒の字だけ変える。作り直すと「走った線」が押せないことがある) */
  let resultsKey = "";
  let resultsLeft: HTMLElement | null = null;
  /** 結果のあとに届いた 賞金と走行点 (サーバーの info)。結果の札の下に出す */
  let reward = "";
  const rewardEl = el("div", { class: "results-reward", role: "status" });
  rewardEl.hidden = true;
  /** ピットで止まる時間の倍率 (整備の組。ログインしていてサーバーが教えてくれたとき) と 2 台目の運転手の名前 */
  let crew: number | undefined;
  let second: string | undefined;
  /** 大会の組: 予選から持ち越したタイヤの組と、決勝の予定の燃料 (サーバーから) */
  let tourSetup: { tire: TireCompound; wear: number; sets: TireSets; fuel: "full" | "race" | "light" } | null = null;
  if (tour) {
    fetchTournament(tour.id)
      .then((v) => {
        const r = v.me?.raceSetup;
        if (r) tourSetup = { ...r, fuel: v.me?.plan?.fuel ?? "race" };
      })
      .catch(() => {});
  }

  const layer = el("div", { style: "position:fixed;inset:0" });
  const raceRoot = el("div");
  const overlay = el("div", { class: "overlay" });
  layer.append(raceRoot, overlay);
  root.append(layer);

  const quit = () => {
    quitting = true;
    go(room ? { name: "rooms" } : { name: "menu" });
  };
  /** 持っていくタイヤの組の決まり (開いた部屋は 周 ÷ 3 + 1) */
  const tireKind = room ? ("custom" as const) : undefined;

  const net = new Net(
    laps,
    () => ({ t: "hello", key: s.key, name: s.name || "名無し", design, token: getToken() ?? undefined }),
    (m) => onMsg(m),
    (why) => {
      if (quitting) return;
      dropped = true;
      // サーバーが断った (部屋が閉じた・級が違う・入れない): その知らせを見せたまま、つなぎ直さない
      if (why.error !== undefined) {
        stopped = true;
        showPanel(el("h3", {}, "入れませんでした"), el("div", { class: "bad" }, why.error));
        return;
      }
      // 同じ席に別の画面 (別のタブ・別の機械) が入った: 取り合わないように、ここでは止める
      if (why.reason === "replaced") {
        stopped = true;
        const again = el("button", { class: "small go" }, "この画面で続ける");
        again.addEventListener("click", () => {
          stopped = false;
          showPanel(el("h3", {}, "つないでいます…"), el("div", { class: "dim" }, "サーバーにつないでいます"));
          net.connect();
        });
        showPanel(el("h3", {}, "別の画面で入りました"), el("div", { class: "dim" }, "同じ席に別の画面 (別のタブか機械) が入ったので、こちらは止めました"), el("div", { class: "bc-actions" }, again));
        return;
      }
      showPanel(el("h3", {}, "通信が切れました"), el("div", { class: "dim" }, "つなぎ直しています… (レース中ならコンピューターが代わりに運転しています)"));
      setTimeout(() => {
        if (!quitting && !stopped) net.connect();
      }, 1500);
    },
    // 大会は組の部屋へ。開いた部屋はその部屋へ。すぐ走るは自分の級の部屋へ (名無しは一番下の 5 級)
    tour ? `&tour=${encodeURIComponent(tour.id)}&g=${tour.g}` : room ? `&room=${encodeURIComponent(room.id)}` : `&cls=${isLoggedIn() ? (cachedMe()?.cls ?? 5) : 5}`,
  );
  showPanel(el("h3", {}, "つないでいます…"), el("div", { class: "dim" }, "サーバーにつないでいます"));
  net.connect();

  function showPanel(...children: Array<Node | string>) {
    resultsKey = "";
    resultsLeft = null;
    overlay.innerHTML = "";
    overlay.style.display = "flex";
    const quitBtn = el("button", { class: "small ghost" }, "やめる");
    quitBtn.addEventListener("click", quit);
    overlay.append(el("div", { class: "frame bc-frame" }, ...children, el("div", { class: "bc-actions" }, quitBtn)));
  }
  function hidePanel() {
    resultsKey = "";
    resultsLeft = null;
    overlay.innerHTML = "";
    overlay.style.display = "none";
  }

  function onMsg(m: ServerMsg) {
    switch (m.t) {
      case "welcome":
        myId = m.id;
        crew = typeof m.crew === "number" && Number.isFinite(m.crew) ? m.crew : undefined;
        second = typeof m.second === "string" ? m.second : undefined;
        waiting = m.waiting;
        roster = m.roster;
        dropped = false;
        setPhase(m.info);
        break;
      case "roster":
        roster = m.roster;
        if (waiting && roster.some((r) => r.id === myId)) waiting = false;
        view?.setOthers(roster.map(toInfo));
        syncTeamOrders();
        render();
        break;
      case "phase":
        if (m.info.phase === "lobby") waiting = false;
        setPhase(m.info);
        break;
      case "snap":
        if (view) {
          // チームの 2 台目が止まる場所で作業中: ピットに入ったら手前で待つ
          const busy = !!m.busy?.includes(myId);
          if (busy && !view.boxBusy && view.car?.pit) view.toast("2 台目の作業が終わるまで待ちます", 2500);
          view.boxBusy = busy;
        }
        view?.pushSnap(m.now, m.cars);
        view?.radio?.noteSnap(m.cars);
        view?.setFlag(m.flag);
        break;
      case "resume":
        view?.resume(m.car);
        if (view?.car && (m.car.dmg || m.car.hits)) view.car.damage = readDamage(m.car.dmg, m.car.hits, stats);
        break;
      case "info":
        view?.toast(m.text, /走行点/.test(m.text) ? 5000 : 2500);
        // 賞金と走行点 (結果のあと) は結果の札にも残す
        if (/賞金|走行点/.test(m.text)) {
          reward = m.text;
          rewardEl.textContent = reward;
          rewardEl.hidden = false;
        }
        break;
      case "error":
        showPanel(el("h3", {}, "入れませんでした"), el("div", { class: "bad" }, m.msg));
        break;
      default:
        break;
    }
  }

  /** チームの 2 台目が同じレースにいれば、作戦の合図のボタンを出す */
  function syncTeamOrders() {
    if (!view) return;
    const mate = waiting ? undefined : roster.find((r) => r.owner === myId && r.bot);
    view.setTeamOrders(mate ? { id: mate.id, name: mate.name, color: mate.color } : null, (order) => net.send({ t: "order", order }));
  }

  function toInfo(r: RosterEntry) {
    return { id: r.id, name: r.name, design: r.design, color: r.color, bot: r.bot };
  }

  function setPhase(next: PhaseInfo) {
    info = next;
    // 結果から先へ進んだら走った線の札を閉じる (次の待合の準備・レースの信号が見えるように)
    if (info.phase !== "results" && replayPanel) {
      replayPanel.close();
      replayPanel = null;
    }
    if (info.phase !== "race" && view) {
      if (view.lap.finished) closeReplay(view.replay);
      lastLine = view.car ? { buf: view.replay, trackId: raceTrackId || info.trackId } : null;
      lastSectors = view.sectors.summary();
      view.destroy();
      view = null;
      viewKey = 0;
      clearInterval(stateTimer);
    }
    if (info.phase === "race" && viewKey !== info.lightsOutAt) startView();
    render();
  }

  function startView() {
    if (!info) return;
    view?.destroy();
    clearInterval(stateTimer);
    finishedSent = false;
    viewKey = info.lightsOutAt;
    raceTrackId = info.trackId;
    lastSectors = [];
    const track = getTrack(info.trackId);
    const meEntry = waiting ? undefined : roster.find((r) => r.id === myId);
    const lightsOutAt = info.lightsOutAt;
    // 走る前の準備をサーバーにも残す (リーグ戦の代走が使う)
    if (meEntry && !tour) syncRaceSetup(s.setup);
    const v = new RaceView({
      root: raceRoot,
      track,
      laps: info.laps,
      assist: s.assist,
      weather: info.weather ?? null,
      setup: {
        // 持っていくタイヤの組 (待合の準備の札で決めたもの。決めていなければおまかせ)
        // 大会は予選から持ち越した組と予定の燃料
        ...(tourSetup
          ? { tire: tourSetup.tire, wear: tourSetup.wear, sets: tourSetup.sets }
          : raceTireSetup(s.setup, { track, laps: info.laps, kind: tireKind, wet: info.weather ? wetnessAt(info.weather, 0) : 0, forecast: info.weather ? forecastAt(info.weather, 0) : [] })),
        fuel: setupFuel(stats, track, info.laps, tourSetup?.fuel ?? s.setup.fuel),
        // 整備の組の腕 (ピットで止まる時間)
        ...(crew !== undefined ? { serviceFactor: crew } : {}),
      },
      me: meEntry ? { info: toInfo(meEntry), slot: meEntry.slot, stats } : null,
      clock: () => (net.serverNow() - lightsOutAt) / 1000,
      lightsStartT: (info.lightsStartAt - info.lightsOutAt) / 1000,
      netClock: () => net.serverNow(),
      isChequered: () => !!info?.chequered,
      onGo: (t) => net.send({ t: "go", at: t }),
      onFinish: (lap) => {
        if (finishedSent) return;
        finishedSent = true;
        net.send({ t: "finish", time: lap.finishTime, lapsDone: lap.lapsDone, best: lap.bestLap, penalty: lap.penalty, mt: v.manual });
        v.toast("ゴール! ほかの車を待っています", 4000);
      },
      onRetire: () => net.send({ t: "retire" }),
      onQuit: quit,
    });
    view = v;
    v.setOthers(roster.map(toInfo));
    syncTeamOrders();
    if (meEntry) {
      stateTimer = window.setInterval(() => {
        const c = v.car;
        if (!c || v.lap.finished || dropped) return;
        net.send({
          t: "state",
          x: c.x,
          y: c.y,
          h: c.heading,
          vx: c.vx,
          vy: c.vy,
          dist: c.dist,
          fuel: c.fuel,
          lapsDone: v.lap.lapsDone,
          lapStart: v.lap.lapStart,
          best: v.lap.bestLap,
          penalty: v.lap.penalty,
          tire: c.tire,
          wear: c.wear,
          burst: c.burst,
          pit: inPit(c),
          box: inService(c),
          dmg: packDamage(c.damage),
          hits: c.damage?.hits ?? 0,
          drs: !!c.drs?.open,
          ot: !!c.ot?.active,
          mt: v.manual,
          sets: c.sets ?? undefined,
        });
      }, 100);
    }
  }

  /** 開いた部屋の待合: 開いた人・級と、開いた人の「今すぐスタート」 */
  function roomLobbyBox(r: NonNullable<PhaseInfo["room"]>, humans: number): HTMLElement {
    const box = el("div", { class: "lobby-hint rm-lobby" }, el("span", {}, `開いた人: ${r.host} · ${r.cls} 級 · 空きはコンピューター`));
    if (room?.host) {
      const ok = humans >= CUSTOM_START_MIN;
      const b = el("button", { class: "small go" }, "今すぐスタート") as HTMLButtonElement;
      b.disabled = !ok;
      b.title = ok ? "待合を終えてスタートします" : `人が ${CUSTOM_START_MIN} 人そろうと押せます`;
      b.addEventListener("click", () => {
        b.disabled = true;
        net.send({ t: "start" });
      });
      box.append(b);
      if (!ok) box.append(el("small", { class: "dim" }, `${CUSTOM_START_MIN} 人そろうと押せます`));
    }
    return box;
  }

  function render() {
    // 断られた・席を渡した知らせは、待合の秒の書きかえで消さない
    if (!info || stopped) return;
    const left = Math.max(0, Math.ceil((info.endsAt - net.serverNow()) / 1000));
    const trackName = getTrack(info.trackId).def.name;
    // 中継の見出し: 赤い札 (英字 + 日本語) と、コースの名前・周の数
    const head = (title: string, jp: string) =>
      el("div", { class: "bc-head" }, el("h3", {}, title, el("small", {}, jp)), el("div", { class: "bc-sub" }, el("b", {}, trackName), el("span", { class: "label" }, `${info!.laps} LAPS`)));
    if (info.phase === "lobby") {
      const humans = roster.filter((r) => !r.bot);
      const cpu = Math.max(0, 8 - humans.length);
      const track = getTrack(info.trackId);
      const key = `${info.trackId}|${info.laps}|${info.lightsOutAt}`;
      if (!setupEl || setupKey !== key) {
        setupKey = key;
        const plan = info.weather;
        setupEl = tour
          ? el(
              "div",
              { class: "lobby-hint" },
              tourSetup
                ? `大会の予定: スタートは ${TIRE_DEFS[tourSetup.tire].name}${tourSetup.wear > 0 ? ` (減り ${Math.round(tourSetup.wear * 100)}%)` : ""}・持っている組 ${tourSetup.sets.used.length + Object.values(tourSetup.sets.fresh).reduce((a, b) => a + (b ?? 0), 0)}。並びは予選の順`
                : "大会の予定のタイヤで走ります。並びは予選の順",
            )
          : setupPanel({ stats, track, laps: info.laps, kind: tireKind, wet: plan ? wetnessAt(plan, 0) : 0, forecast: plan ? forecastAt(plan, 0) : [], onChange: () => syncRaceSetup(load().setup, true) });
      }
      // 出る車の札 (並びはスタートのときにくじで決まるので、番号は入った順)
      const slot = (n: number) => el("span", { class: "slot num" }, String(n).padStart(2, "0"));
      showPanel(
        head("GRID", "待合"),
        el(
          "div",
          { class: "lobby-body" },
          el(
            "div",
            {},
            el("div", { class: "countdown-box" }, el("div", { class: "countdown num" }, String(left)), el("div", {}, el("div", { class: "k" }, "LIGHTS OUT IN"), el("div", { class: "dim" }, "秒でスタート"))),
            el(
              "ul",
              { class: "lobby-list" },
              ...humans.map((r, i) =>
                el(
                  "li",
                  { class: r.id === myId ? "me" : "", style: r.id === myId ? "--tc:var(--accent)" : "" },
                  slot(i + 1),
                  el("span", { class: "bar" }),
                  el("span", { class: "nm" }, r.name, r.id === myId ? el("span", { class: "you" }, "YOU") : null),
                ),
              ),
              ...Array.from({ length: cpu }, (_, i) => el("li", { class: "cpu" }, slot(humans.length + i + 1), el("span", { class: "bar" }), el("span", { class: "nm" }, "CPU"))),
            ),
            second ? el("div", { class: "lobby-hint" }, `2 台目: ${second} も走ります (席が空いていれば)`) : null,
            info.room ? roomLobbyBox(info.room, humans.length) : null,
            el("div", { class: "lobby-hint" }, s.assist ? "赤い信号が全部消えたら、どこかを押して発進" : "赤い信号が全部消えたらアクセル。早すぎるとフライング +5 秒"),
          ),
          setupEl,
        ),
      );
      overlay.querySelector(".frame")?.classList.add("lobby-frame");
      return;
    }
    if (info.phase === "race") {
      reward = "";
      rewardEl.hidden = true;
      hidePanel();
      return;
    }
    if (info.phase === "results" && info.results) {
      const key = `${info.lightsOutAt}|${info.endsAt}|${info.results.length}`;
      if (key === resultsKey && resultsLeft) {
        resultsLeft.textContent = `次の待合まで ${left} 秒`;
        return;
      }
      const win = info.results.find((r) => r.pos === 1 && r.finished);
      const rows = info.results.map((r) => {
        // 時間: 1 位は合計、ほかは 1 位との差 (周遅れは「+1 周」)。ゴールしていなければ周の数かリタイア
        const time = resultTimeText(r, win);
        return el(
          "tr",
          { class: `${r.id === myId ? "me" : ""}${r.pos <= 3 ? " podium" : ""}${r.pos === 1 ? " p1" : ""}` },
          el("td", { class: "num pos" }, String(r.pos)),
          el("td", { class: "who" }, el("span", { class: "bar", style: `background:${r.color}` }), r.name, r.id === myId ? el("span", { class: "you" }, "YOU") : null, transTag(r.mt)),
          el("td", { class: `num r t${!r.finished && r.retired ? " out" : ""}` }, time, r.penalty ? el("span", { class: "pen" }, `罰 +${r.penalty.toFixed(0)}`) : null),
          el("td", { class: `num r fl${r.fastest ? " purple" : ""}` }, formatTime(r.best)),
          el("td", { class: "num pts" }, String(r.points)),
        );
      });
      const leftEl = el("span", { class: "num" }, `次の待合まで ${left} 秒`);
      showPanel(
        head("RESULT", "結果"),
        el(
          "table",
          { class: "results" },
          el("tr", {}, el("th", {}, "POS"), el("th", {}, "DRIVER"), el("th", { class: "r" }, "TIME"), el("th", { class: "r" }, "BEST LAP"), el("th", {}, "PTS")),
          ...rows,
        ),
        ...[sectorResults(lastSectors, info.results, myId)].filter((x): x is HTMLElement => !!x),
        rewardEl,
        el(
          "div",
          { class: "results-note" },
          el("span", {}, el("i", { class: "fl-key" }), "一番速い周 (+1 点)"),
          leftEl,
          lastLine && replayLength(lastLine.buf)
            ? replayButton(layer, getTrack(lastLine.trackId), () => lastLine?.buf ?? null, undefined, (p) => {
                replayPanel?.close();
                replayPanel = p;
              })
            : null,
        ),
      );
      overlay.querySelector(".frame")?.classList.add("results-frame");
      resultsKey = key;
      resultsLeft = leftEl;
    }
  }

  uiTimer = window.setInterval(() => {
    if (info && info.phase !== "race") render();
  }, 500);

  return () => {
    quitting = true;
    replayPanel?.close();
    clearInterval(uiTimer);
    clearInterval(stateTimer);
    view?.destroy();
    net.close();
  };
}
