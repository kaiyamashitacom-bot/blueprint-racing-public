// 練習 (ひとり、ネットなし): 走る前にタイヤ・燃料・天気を選び、好きなだけ周回して、一番速い周の幽霊と競う
// 走った設計図の版 (Rev.A…、store.ts) ごとに 晴れの一番速い周を残す (車づくりの「改訂」で比べる)
import { SKY_WET, computeStats, isPublicTrackId, knownTrackDef, makeWeatherPlan, validateDesign, type WeatherPlan } from "@bpr/shared";
import type { Go } from "../main.ts";
import { RaceView } from "../race/view.ts";
import { ReplayDock } from "../race/replay-ui.ts";
import { activeDesign, commitRevision, load, recordRevisionLap, revLabel, save, type PracticeSky } from "../store.ts";
import { el } from "./dom.ts";
import { practiceTire, practiceWet, setupFuel, setupPanel } from "./setup.ts";
import { quickLightsClock } from "./lights.ts";
import { isUserTrackId, markUserTrackLapped, resolveTrack } from "../usertracks.ts";
import { ensureTrack, fetchTrack, likeTrack, recordTrackRun } from "../tracks_api.ts";
import { isLoggedIn } from "../api.ts";
import { errText } from "./account.ts";

/** 練習の天気の予定 */
function practiceWeather(sky: PracticeSky): WeatherPlan {
  if (sky === "mix") return makeWeatherPlan(Math.floor(Math.random() * 1e9), 1800, { rain: 0.8 });
  return { seed: 1, changes: [{ at: 0, sky }], fakes: [], startWet: SKY_WET[sky] };
}

export function mountPractice(root: HTMLElement, go: Go, trackId: string): () => void {
  const design = activeDesign();
  if (!design || validateDesign(design).length) {
    go({ name: "builder" });
    return () => {};
  }
  // みんなのコース ("pub:<n>"): 形を知らなければサーバーから読んでから
  if (isPublicTrackId(trackId) && !knownTrackDef(trackId)) {
    let alive = true;
    let inner: (() => void) | null = null;
    const wait = el("div", { class: "sheet" }, el("div", { class: "frame dim" }, "コースを読みこんでいます…"));
    root.append(wait);
    ensureTrack(trackId)
      .then((def) => {
        if (!alive) return;
        wait.remove();
        if (!def) throw new Error("そのコースは見つかりません");
        inner = mountPracticeOn(root, go, trackId);
      })
      .catch((e) => {
        if (!alive) return;
        wait.innerHTML = "";
        const back = el("button", {}, "もどる");
        back.addEventListener("click", () => go({ name: "menu" }));
        wait.append(el("div", { class: "frame bad" }, errText(e)), el("div", { class: "row", style: "margin-top:10px" }, back));
      });
    return () => {
      alive = false;
      inner?.();
    };
  }
  return mountPracticeOn(root, go, trackId);
}

function mountPracticeOn(root: HTMLElement, go: Go, trackId: string): () => void {
  const design = activeDesign()!;
  const s = load();
  const track = resolveTrack(trackId);
  // 作ったコースから来たら、もどるでコースづくりへ
  const mine = isUserTrackId(trackId);
  const pub = isPublicTrackId(trackId);
  const backTo = () => go(mine ? { name: "editor" } : { name: "menu" });
  // みんなのコース: 走り終えた周をサーバーへ (はじめの 1 周と、速くなったとき)。いいねを押せるように
  let sentBest = Infinity;
  let pubFinished = false;
  const stats = computeStats(design);
  // 走る版 (同じ形の版がなければ ここで残す)
  const rev = commitRevision(design);
  let view: RaceView | null = null;
  const layer = el("div", { style: "position:fixed;inset:0" });
  const raceRoot = el("div");
  const overlay = el("div", { class: "overlay" });
  layer.append(raceRoot, overlay);
  root.append(layer);
  // 走りの時計を止める (走った線の札を開いている間。かんたん操作でも車が勝手に壁へ行かない)
  let pausedAt: number | null = null;
  let pausedTotal = 0;
  const now = () => (pausedAt ?? performance.now()) - pausedTotal;
  // 1 周走ったら右上に「走った線」ボタン
  const lineDock = new ReplayDock(layer, track, () => (view?.car ? view.replay : null), {
    onOpen: () => {
      pausedAt ??= performance.now();
    },
    onClose: () => {
      if (pausedAt !== null) pausedTotal += performance.now() - pausedAt;
      pausedAt = null;
    },
  });

  const start = () => {
    overlay.style.display = "none";
    view?.destroy();
    // 信号は短く (約 3 秒、lights.ts)
    const { lightsStartT, clock } = quickLightsClock(now);
    // 幽霊は晴れの記録だけ (雨の周と比べても意味がないので)
    const dry = s.practiceSky === "sun";
    view = new RaceView({
      root: raceRoot,
      track,
      laps: 0,
      assist: s.assist,
      me: { info: { id: "me", name: s.name || "あなた", design, color: "#ff2b3a", bot: false }, slot: 0, stats },
      clock,
      lightsStartT,
      ghost: dry ? (s.ghosts[trackId] ?? null) : null,
      weather: practiceWeather(s.practiceSky),
      // タイヤは準備の札に出ているもの (この天気で選んでいなければ 合うもの)
      setup: { tire: practiceTire(s.setup, practiceWet(s.practiceSky)), fuel: setupFuel(stats, track, 0, s.setup.fuel) },
      onNewBestLap: (g) => {
        if (!dry) return;
        s.ghosts[trackId] = { ...g, rev: revLabel(rev.n) };
        save();
      },
      onLap: (time, valid) => {
        if (dry && valid) recordRevisionLap(design, rev.n, trackId, time);
        // 作ったコース: 1 周走れた (公開の条件のひとつ)
        if (valid && mine) markUserTrackLapped(trackId, time);
        if (valid && pub && isLoggedIn() && time < sentBest) {
          sentBest = time;
          recordTrackRun(trackId, true, time)
            .then(() => (pubFinished = true))
            .catch(() => {});
        }
      },
      onRetire: () => {
        setTimeout(() => {
          if (view) showSetup("燃料が切れました");
        }, 1500);
      },
      onQuit: backTo,
    });
  };

  const showSetup = (title = "走る前の準備") => {
    overlay.innerHTML = "";
    overlay.style.display = "flex";
    const goBtn = el("button", { class: "go" }, "走る");
    goBtn.addEventListener("click", start);
    const back = el("button", { class: "ghost" }, mine ? "コースづくりへ" : "もどる");
    back.addEventListener("click", backTo);
    overlay.append(
      el(
        "div",
        { class: "frame bc-frame setup-frame" },
        el(
          "div",
          { class: "bc-head" },
          el("h3", {}, "PRACTICE", el("small", {}, "練習")),
          el("div", { class: "bc-sub" }, el("b", {}, title), el("span", { class: "label" }, track.def.name)),
        ),
        setupPanel({ stats, track, laps: 0, wet: 0, practice: true }),
        pub ? pubRow() : null,
        el("div", { class: "bc-actions" }, back, goBtn),
      ),
    );
  };

  /** みんなのコース: 作った人・いいね (走り終えた人だけ押せる) */
  const pubRow = (): HTMLElement => {
    const box = el("div", { class: "pub-row" }, el("span", { class: "dim" }, "みんなのコース"));
    const likeBtn = el("button", { class: "small" }, "♡ いいね") as HTMLButtonElement;
    likeBtn.disabled = true;
    box.append(likeBtn);
    let liked = false;
    const paint = (likes: number) => {
      likeBtn.textContent = `${liked ? "♥" : "♡"} いいね ${likes}`;
      likeBtn.classList.toggle("on", liked);
    };
    fetchTrack(trackId)
      .then((r) => {
        const m = r.meta;
        if (!m) return;
        liked = !!m.liked;
        paint(m.likes);
        box.firstChild!.textContent = `作: ${m.author}${m.record ? ` · 記録 ${m.record.lap.toFixed(2)} 秒 (${m.record.driver})` : ""}`;
        const can = isLoggedIn() && (m.finished || pubFinished);
        likeBtn.disabled = !can;
        likeBtn.title = can ? "" : isLoggedIn() ? "1 周走り終えると押せます" : "ログインすると押せます";
      })
      .catch(() => {});
    likeBtn.addEventListener("click", async () => {
      try {
        const r = await likeTrack(trackId, !liked);
        liked = r.liked;
        paint(r.likes);
      } catch (e) {
        likeBtn.title = errText(e);
      }
    });
    return box;
  };
  showSetup();
  return () => {
    lineDock.destroy();
    view?.destroy();
  };
}
