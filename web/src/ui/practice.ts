// 練習 (ひとり、ネットなし): 走る前にタイヤ・燃料・天気を選び、好きなだけ周回して、一番速い周の幽霊と競う
// 走った設計図の版 (Rev.A…、store.ts) ごとに 晴れの一番速い周を残す (車づくりの「改訂」で比べる)
import { SKY_WET, TaGhostRecorder, computeStats, isPublicTrackId, knownTrackDef, makeWeatherPlan, practicePrizeTrackOk, validateDesign, type WeatherPlan } from "@bpr/shared";
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
import { errText, toast } from "./account.ts";
import { submitPracticeLap } from "../ta_api.ts";
import { practicePrize } from "../race_rules.ts";
import { partStrength } from "../race_rules.ts";

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
  const stats = computeStats(design, partStrength());
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
    const quick = quickLightsClock(now);
    const lightsStartT = quick.lightsStartT;
    // 練習の賞金 (ログインしていて、公式かみんなのコース): 正しい周を 1 周アタックと同じ形 (周の秒と幽霊) でサーバーに送る。
    // 幽霊は 1 周アタックと同じく、毎こまの車の位置を残して 周が終わったら 0.1 秒の目盛りに並べ直す
    const prize = practicePrize();
    const paying = isLoggedIn() && practicePrizeTrackOk(trackId) && prize.perLap > 0 && prize.dailyLaps > 0;
    const rec = paying ? new TaGhostRecorder() : null;
    let pending: { start: number; time: number } | null = null;
    let lastT = -Infinity;
    let prizeStop = false;
    let sending: Promise<void> = Promise.resolve();
    const runManual = (): boolean => view?.manual ?? false;
    const sendLap = (lap: number, pts: number[]) => {
      if (prizeStop) return;
      sending = sending.then(async () => {
        if (prizeStop) return;
        try {
          const r = await submitPracticeLap(trackId, { lap, pts }, design, runManual());
          if (r.earned > 0) toast(`練習の賞金 +${r.earned} 円${r.left > 0 ? "" : " (今日の分はここまで)"}`);
          else {
            prizeStop = true;
            toast("練習の賞金は今日の上限です");
          }
        } catch (e) {
          // 確かめが通らない周 (持っていない部品など) は 1 回だけ知らせて、この走りでは送らない
          prizeStop = true;
          toast(`練習の賞金: ${errText(e)}`, true);
        }
      });
    };
    const clock = () => {
      const t = quick.clock();
      const car = view?.car;
      if (rec) {
        if (car && Number.isFinite(lastT)) rec.push(lastT, car.x, car.y, car.heading);
        lastT = t;
        if (pending && rec.lastT() >= pending.start + pending.time) {
          const p = pending;
          pending = null;
          sendLap(p.time, rec.ghost(p.start, p.time));
          rec.dropBefore(p.start + p.time - 1);
        }
      }
      return t;
    };
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
      onLap: (time, valid, lap) => {
        if (rec && valid && !prizeStop) pending = { start: lap.lapStart - time, time };
        else rec?.dropBefore(lap.lapStart - 1);
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
        prizeHint(),
        pub ? pubRow() : null,
        el("div", { class: "bc-actions" }, back, goBtn),
      ),
    );
  };

  /** 練習の賞金の案内 (出るときだけ) */
  const prizeHint = (): HTMLElement | null => {
    const p = practicePrize();
    if (!practicePrizeTrackOk(trackId) || !(p.perLap > 0 && p.dailyLaps > 0)) return null;
    return el(
      "div",
      { class: "hint" },
      isLoggedIn() ? `練習の賞金: 正しく走った 1 周ごとに ${p.perLap} 円 (1 日 ${p.dailyLaps} 周まで。サーバーが確かめた周だけ)` : `ログインすると 練習の 1 周ごとに ${p.perLap} 円 (1 日 ${p.dailyLaps} 周まで)`,
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
