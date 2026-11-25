import "./style.css";
import "./race/race.css";
import { applyPaper } from "./store.ts";
import { mountMenu } from "./ui/menu.ts";
import { mountBuilder } from "./ui/builder.ts";
import { mountPractice } from "./ui/practice.ts";
import { mountOnline } from "./ui/online.ts";
import { mountRooms } from "./ui/rooms.ts";
import { mountAccount } from "./ui/account.ts";
import { mountShop } from "./ui/shop.ts";
import { mountTimeAttack } from "./ui/timeattack.ts";
import { mountTeam } from "./ui/team.ts";
import { mountDrivers } from "./ui/drivers.ts";
import { mountResearch } from "./ui/research.ts";
import { mountMarket } from "./ui/market.ts";
import { mountLeague } from "./ui/league.ts";
import { mountBets } from "./ui/bets.ts";
import { mountExchange } from "./ui/exchange.ts";
import { mountSeason } from "./ui/season.ts";
import { mountTournament } from "./ui/tournament.ts";
import { mountAdmin } from "./ui/admin.ts";
import { mountEditor } from "./ui/editor.ts";
import { mountWelcome, isGuestThisSession } from "./ui/welcome.ts";
import { mountOpening } from "./ui/opening.ts";
import { loadOpeningPrefs, openingOnLoad, openingPlan, saveOpeningPrefs, screenAfterOpening } from "./ui/opening_plan.ts";
import { restoreCachedTracks } from "./tracks_api.ts";
import { isLoggedIn, refreshAccount } from "./api.ts";
import { loadRaceRules } from "./race_rules.ts";
import { installAudio, setScreenMusic } from "./audio/index.ts";

export type Go = (screen: Screen) => void;
export type Screen =
  | { name: "menu" }
  | { name: "builder" }
  | { name: "practice"; trackId: string }
  | { name: "online"; laps: number; tour?: { id: string; g: number }; room?: { id: string; host: boolean } }
  | { name: "rooms" }
  | { name: "account" }
  | { name: "shop" }
  | { name: "timeattack" }
  | { name: "team" }
  | { name: "drivers" }
  | { name: "research" }
  | { name: "market" }
  | { name: "league" }
  | { name: "bets" }
  | { name: "exchange" }
  | { name: "season" }
  | { name: "tournament"; id?: string }
  | { name: "admin" }
  | { name: "editor" }
  /** はじめのログイン (オープニングのあと、ログインが無いとき) */
  | { name: "welcome" };

const root = document.getElementById("app")!;
let unmount: (() => void) | null = null;

const go: Go = (screen) => {
  // 読み直したとき (スマホで裏に回ったときなど) に同じ画面へ戻る
  try {
    sessionStorage.setItem("bpr.screen", JSON.stringify(screen));
  } catch {
    /* 保存できなくてもよい */
  }
  unmount?.();
  unmount = null;
  root.innerHTML = "";
  window.scrollTo(0, 0);
  setScreenMusic(screen.name === "builder" ? "builder" : "menu"); // レースの画面はその上でレースの曲にする
  switch (screen.name) {
    case "menu":
      unmount = mountMenu(root, go);
      break;
    case "builder":
      unmount = mountBuilder(root, go);
      break;
    case "practice":
      unmount = mountPractice(root, go, screen.trackId);
      break;
    case "online":
      unmount = mountOnline(root, go, screen.laps, screen.tour, screen.room);
      break;
    case "rooms":
      unmount = mountRooms(root, go);
      break;
    case "account":
      unmount = mountAccount(root, go, () => go({ name: "shop" }));
      break;
    case "shop":
      unmount = mountShop(root, go, () => go({ name: "account" }));
      break;
    case "timeattack":
      unmount = mountTimeAttack(root, go);
      break;
    case "team":
      unmount = mountTeam(root, go);
      break;
    case "drivers":
      unmount = mountDrivers(root, go);
      break;
    case "research":
      unmount = mountResearch(root, go);
      break;
    case "market":
      unmount = mountMarket(root, go);
      break;
    case "league":
      unmount = mountLeague(root, go);
      break;
    case "bets":
      unmount = mountBets(root, go);
      break;
    case "exchange":
      unmount = mountExchange(root, go);
      break;
    case "season":
      unmount = mountSeason(root, go);
      break;
    case "tournament":
      unmount = mountTournament(root, go, screen.id);
      break;
    case "admin":
      unmount = mountAdmin(root, go);
      break;
    case "editor":
      unmount = mountEditor(root, go);
      break;
    case "welcome":
      unmount = mountWelcome(root, go);
      break;
  }
};

/** 読み直す前の画面 (この回で開いていた画面。無ければ null) */
function lastScreen(): Screen | null {
  try {
    const s = JSON.parse(sessionStorage.getItem("bpr.screen") ?? "null") as Screen | null;
    if (s && ["menu", "builder", "practice", "online", "rooms", "account", "shop", "timeattack", "team", "drivers", "research", "market", "league", "bets", "exchange", "season", "tournament", "admin", "editor", "welcome"].includes(s.name)) return s;
  } catch {
    /* 読めなければ はじめから */
  }
  return null;
}

/**
 * 開いたとき: 画面の途中で読み直したならそのまま戻る。はじめて (またはメニューで読み直した) ならオープニング →
 * (ログインが無ければ) ログインの画面 → メニュー。オープニングの曲は鳴らさない (押して入ったときに go がメニューの曲にする)
 */
function start() {
  const last = lastScreen();
  const next = (): Screen => ({ name: screenAfterOpening(isLoggedIn(), isGuestThisSession()) });
  if (last && !openingOnLoad(last.name)) return go(last);
  const plan = openingPlan(loadOpeningPrefs(), matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (plan === "none") return go(next());
  setScreenMusic(null);
  unmount = mountOpening(root, {
    plan,
    onEnter: () => {
      saveOpeningPrefs({ seen: true });
      go(next());
    },
    onLogin: () => {
      saveOpeningPrefs({ seen: true });
      go({ name: "welcome" });
    },
  });
}

applyPaper();
// 前に読んだみんなのコースの形 (練習の画面を読み直したとき用)
restoreCachedTracks();
installAudio();
refreshAccount().catch(() => {});
void loadRaceRules();
start();
