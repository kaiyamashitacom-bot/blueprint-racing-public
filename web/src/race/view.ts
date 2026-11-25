// レースの画面: 自分の車の計算・ほかの車 (サーバーから届く位置をなめらかに)・ぶつかり・描画・表示
import {
  DT,
  closeDrs,
  drsAvailable,
  drsZones,
  lapSectorAt,
  sectorSplitDistances,
  finishInput,
  flagInput,
  flagSpeedCap,
  scTarget,
  SC_GAP,
  openDrs,
  towFactor,
  updateDrs,
  GEAR_COUNT,
  SHIFT_RPM,
  SNAP_OT,
  displayRpm,
  idealGear,
  overtakeAvailable,
  overtakeGauge,
  rpmFraction,
  manualShiftBonus,
  updateOvertake,
  type FlagInfo,
  type DamageEvent,
  DAMAGE_LOST,
  damageCount,
  repairTime,
  sectorOf,
  JUMP_START_PENALTY,
  SKY_NAMES,
  TIRE_DEFS,
  TIRE_ORDER,
  bestTireFor,
  bodyOf,
  cancelPit,
  carSpeed,
  computeStats,
  createCar,
  forecastAt,
  formatTime,
  fuelPerMeter,
  newLapState,
  pointAt,
  puddleDepth,
  puddlesOf,
  pickFromSets,
  pushApart,
  queryTrack,
  readTireSets,
  requestPit,
  setOptions,
  serviceTime,
  skyAt,
  sortStandings,
  stepCar,
  updateLaps,
  wetnessAt,
  lineWetnessAt,
  racingLine,
  LINE_DRY_CORE,
  LINE_DRY_BAND,
  GapTrend,
  TimingMarks,
  formatGap,
  formatSec,
  gapBetween,
  ghostDelta,
  ghostProfile,
  ghostSectorTimes,
  newStint,
  readSnapTyre,
  tyreLaps,
  updateStint,
  type Gap,
  type GhostProfile,
  type SnapTyre,
  type StintState,
  type Body,
  type CarDesign,
  type CarSetup,
  type CarState,
  type CarStats,
  type LapState,
  type ResumeCar,
  type SnapCar,
  type TireCompound,
  type Track,
  type WeatherPlan,
  TEAM_ORDERS,
  TEAM_ORDER_TEXT,
  type TeamOrder,
} from "@bpr/shared";
import { drawCarWorld, type Ink } from "../draw.ts";
import type { Ghost } from "../store.ts";
import { palette, useManual, type Palette } from "../store.ts";
import { manualBonus, partStrength } from "../race_rules.ts";
import { el } from "../ui/dom.ts";
import { skyLabel, tireBadge } from "../ui/setup.ts";
import { Controls } from "./input.ts";
import { DRS_GREEN, SECTOR_TINTS, SECTOR_TINTS_SOFT, trackPaths } from "./trackdraw.ts";
import { newReplay, recordSample } from "@bpr/shared";
import { RadioUI } from "./radio-ui.ts";
import { RaceAudio, flagLevel, lateralSlip, pitWork } from "../audio/index.ts";
import { SectorHud } from "./sectors-ui.ts";

/** 走る線 (line.ts) の形 (乾きかけの道に描く)。コースごとに 1 回 */
const linePaths = new WeakMap<Track, Path2D>();
function racingLinePath(track: Track): Path2D {
  let p = linePaths.get(track);
  if (p) return p;
  p = new Path2D();
  const line = racingLine(track);
  const n = track.n;
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const pt = pointAt(track, (k / n) * track.length, line.d[k] ?? 0);
    if (i === 0) p.moveTo(pt.x, pt.y);
    else p.lineTo(pt.x, pt.y);
  }
  p.closePath();
  linePaths.set(track, p);
  return p;
}

export interface CarInfo {
  id: string;
  name: string;
  design: CarDesign;
  color: string;
  bot: boolean;
}

/** 一緒に走る幽霊 1 台。ghost は走っている間に差し替えてよい (次のこまから使う) */
export interface GhostEntry {
  ghost: Ghost;
  label: string;
  color?: string;
}

export interface RaceViewOpts {
  root: HTMLElement;
  track: Track;
  /** 0 = 周の終わりなし (練習) */
  laps: number;
  me: { info: CarInfo; slot: number; stats: CarStats } | null;
  /** かんたん操作 (アクセル自動 + 曲がりで自動ブレーキ) */
  assist: boolean;
  /** マニュアル (自分で変速。なし = この機械の設定 useManual()) と その速さの上がり分 (なし = サーバーから読んだ値) */
  manual?: boolean;
  manualBonus?: number;
  /** スタートの合図からの時間 (秒)。合図の前はマイナス */
  clock: () => number;
  /** 1 つ目の赤い信号が点く時間 (秒、マイナス) */
  lightsStartT: number;
  /** ほかの車の位置をなめらかにするための時計 (ms、サーバーの時計) */
  netClock?: () => number;
  isChequered?: () => boolean;
  /** 練習の幽霊 (自分のいちばん速い周。名札なし) */
  ghost?: Ghost | null;
  /** いくつもの幽霊 (1 周アタック)。名札と色つき。周の終わりなし (laps: 0) のときだけ描く */
  ghosts?: GhostEntry[];
  /** 幽霊の車の形 (なし = 自分の設計図)。ほかの人の幽霊には決まった形を渡して、その人の設計図を見せない */
  ghostDesign?: CarDesign;
  /** 塔の見出しの字 (なし = レースは LAP、練習は PRACTICE) */
  modeLabel?: string;
  /** 天気の予定 (なし = ずっと晴れ) */
  weather?: WeatherPlan | null;
  /** 走る前に選んだタイヤと燃料 */
  setup?: CarSetup;
  onGo?: (t: number) => void;
  onLap?: (time: number, valid: boolean, lap: LapState) => void;
  onFinish?: (lap: LapState) => void;
  onRetire?: () => void;
  onNewBestLap?: (ghost: Ghost) => void;
  onQuit: () => void;
  quitLabel?: string;
}

interface Sample {
  t: number;
  x: number;
  y: number;
  h: number;
  dist: number;
  flags: number;
  laps: number;
  vx: number;
  vy: number;
}

interface Other {
  info: CarInfo;
  stats: CarStats;
  buf: Sample[];
  /** タイヤ・ピットの回数など (snap の後ろに足したところ。前のサーバーなら中身は null) */
  ty: SnapTyre | null;
}

/** 塔の 1 行 */
interface Row {
  id: string;
  finished: boolean;
  retired: boolean;
  lapsDone: number;
  finishTime: number;
  penalty: number;
  dist: number;
  name: string;
  color: string;
  me: boolean;
  pit: boolean;
  tire: TireCompound | null;
  wear: number | null;
  tyreLaps: number | null;
  pitStops: number | null;
  burst: boolean;
  stopped: boolean;
}

/** 塔のタイム差: int = 前の車との差・lead = 先頭との差 */
type GapMode = "int" | "lead";
const GAP_MODE_KEY = "bpr.gapMode";
/** 狭い画面 (スマホの縦・横) では塔を縮める: 上の何台 + 自分の前後 (仮) */
const COMPACT_TOP = 3;
const COMPACT_MQ = "(max-width: 560px), (max-height: 500px)";

interface Pose {
  x: number;
  y: number;
  h: number;
  dist: number;
  flags: number;
  laps: number;
  vx: number;
  vy: number;
}

const SKID_MAX = 600;

/** スナップの flags: 1 = ゴール・2 = リタイア・8 = ピットの道 */
const F_FIN = 1;
const F_RET = 2;
const F_PIT = 8;

/** コースの色 (中継の上からの映像のように。ここだけは暗い画面に合わせて決めた色) */
const C = {
  bg: "#0a0d10",
  grass: "#1d3325",
  grassStripe: "#22392a",
  asphalt: "#3a3f48",
  rubber: "rgba(10,11,14,0.16)",
  pitLane: "#33373f",
  pitEdge: "rgba(238,241,245,0.55)",
  pitBox: "rgba(255,210,31,0.14)",
  paint: "#eef1f5",
  wall: "#d5dbe3",
  wall2: "#5d6676",
  kerbRed: "#e5332f",
  kerbWhite: "#f1f1f1",
  board: "#ffd21f",
  /** ブレーキの目安の板の面と字 */
  boardFace: "#eef1f5",
  boardInk: "#0a0c11",
  /** セクターの切れ目の塗った線・DRS の区間の道の端 (使えないとき)・セクターと DRS の札の地と区切り */
  sectorLine: "rgba(238,241,245,0.78)",
  drsEdge: "rgba(34,211,122,0.38)",
  markBg: "rgba(8,10,14,0.86)",
  markDim: "rgba(255,255,255,0.35)",
  /** 壁の外 (仮の色): 暗い芝・ガレージ前の舗装・観客席・タイヤの防護壁 */
  outer: "#121c16",
  outerSpeck: "#17241c",
  outerDark: "#0f1813",
  apron: "#25282e",
  garageLine: "rgba(238,241,245,0.22)",
  stands: "#1a1e26",
  standRow: "rgba(120,140,175,0.32)",
  tyreA: "#08090b",
  tyreB: "#2b2f36",
  /** 雨のときの自分の車の光 */
  rainGlow: "rgba(225,238,255,0.85)",
  skid: "rgba(8,9,12,0.55)",
  wet: "rgba(40,70,115,",
  sheen: "rgba(190,215,255,",
  puddle: "rgba(120,170,235,",
  spray: "rgba(215,228,245,",
  rain: "rgba(200,220,255,",
  tagBg: "rgba(10,12,17,0.9)",
  tagInk: "#f3f5f8",
  tagPos: "#0a0c11",
};

type PitFuel = "none" | "race" | "full";

/** 自分の車にかぶる名札の濃さ (下にずらしてもかぶるとき、仮) */
const TAG_FADE = 0.35;

/**
 * カメラの寄り (1 m が何 px) と、自分の車を置く高さ (画面の上から の割合)。数は全部 仮。
 * 広い画面: 短い辺 ÷ 46、車は上から 64%。
 * スマホの縦: 車が小さすぎた (130 km/h で 約 10×30 px) ので 短い辺 ÷ 31 (約 15×45 px)。前は 約 60 m 見える。速さで引くのは 22% まで。
 * スマホの横: 高さ ÷ 44 (車は少し大きく) で、車を上から 72% (計器の帯の少し上) に置き、前の道を広く見せる (130 km/h で 約 40 m)。
 */
export function cameraFor(w: number, h: number, speed: number): { ppm: number; anchor: number } {
  const low = h <= 500 && w > h;
  const narrow = !low && w <= 560;
  const base = low ? h / 44 : narrow ? Math.min(w, h) / 31 : Math.min(w, h) / 46;
  const out = Math.min(narrow ? 0.22 : 0.3, speed / 160);
  return { ppm: base * (1 - out), anchor: low ? 0.72 : narrow ? 0.66 : 0.64 };
}

export class RaceView {
  readonly car: CarState | null;
  readonly lap: LapState = newLapState();
  private canvas: HTMLCanvasElement;
  private mini: HTMLCanvasElement;
  private controls: Controls;
  private others = new Map<string, Other>();
  private finishOrder: string[] = [];
  private simT: number;
  private goPressed = false;
  private raf = 0;
  private h: Record<string, HTMLElement> = {};
  private toastUntil = 0;
  private lastHud = 0;
  private ghostRec: number[] = [];
  private ghostNext = 0;
  private camX = 0;
  private camY = 0;
  private camH = -Math.PI / 2;
  private dpr = 1;
  private destroyed = false;
  private bigText = "";
  private bigUntil = 0;
  private skids = new Float32Array(SKID_MAX * 4);
  private skidN = 0;
  private lastSkid: [number, number] | null = null;
  private sparks: Array<{ x: number; y: number; t: number }> = [];
  private lastThrottle = 0;
  private lastBrake = 0;
  private miniKey = "";
  /** 地図: セクターごとの線と DRS の区間の線 (地図の座標。大きさが変わったら作り直す) */
  private miniSec: Path2D[] = [];
  private miniDrs: Path2D[] = [];
  private miniTop: HTMLCanvasElement | null = null;
  private wet = 0;
  private pitOpen = false;
  private pitSelTire: TireCompound | null = null;
  /** 選んだ組が使った組なら、その番号 (car.sets.used の何番目。null = 新品) */
  private pitSelUsed: number | null = null;
  private pitSelFuel: PitFuel = "none";
  private pitSelRepair = false;
  private prevPitPhase: string | null = null;
  private prevBurst = false;
  private warnedWear = false;
  private posMap = new Map<string, number>();
  private rainSeed = Math.random() * 1000;
  /** 旗の状態 (サーバーから。練習ではなし) */
  flag: FlagInfo | null = null;
  /** チームの相方 (2 台目) が止まる場所で作業中 (サーバーの snap の busy)。ピットに入ったら手前で待つ */
  boxBusy = false;
  /** 走った線の記録 (replay.ts)・無線の作戦係の札 (radio-ui.ts、自分の車があるときだけ) */
  readonly replay = newReplay();
  radio: RadioUI | null = null;
  /** 傷みの図を描き直す印 (表示だけ) */
  private dmgKey = "-";
  /** 周の時間を光らせる (表示だけ) */
  private flashLaps = 0;
  private flashUntil = 0;
  /** タイム差の印 (車ごと。自分は自分の計算、ほかの車は snap から) */
  private marks = new Map<string, TimingMarks>();
  /** 自分のピットの回数とタイヤの周 */
  private myStint: StintState | null = null;
  private gapMode: GapMode = loadGapMode();
  /** 狭い画面で塔を全部広げている */
  private towerOpen = false;
  private compact: MediaQueryList | null = typeof matchMedia === "function" ? matchMedia(COMPACT_MQ) : null;
  private trendAhead = new GapTrend();
  private trendBehind = new GapTrend();
  private ghostProfs = new WeakMap<Ghost, GhostProfile | null>();
  /** セクター (区間タイム) の帯と計算 (sectors-ui.ts。自分は毎刻み、ほかの車は snap から) */
  readonly sectors: SectorHud;
  private ghostSecs = new WeakMap<Ghost, Array<number | null> | null>();
  /** 音 (audio/。車の様子を読むだけ) */
  private snd = new RaceAudio();
  /** マニュアル (自分で変速) で走っている と その速さの上がり分 */
  readonly manual: boolean;
  private mtBonus: number;
  /** 回転の目盛り (毎こま。変わったときだけ書く) */
  private gearKey = "";

  constructor(private o: RaceViewOpts) {
    this.manual = o.manual ?? useManual();
    this.mtBonus = this.manual ? (o.manualBonus ?? manualBonus()) : 0;
    const root = o.root;
    root.classList.add("race-root");
    this.canvas = el("canvas", { class: "main" }) as HTMLCanvasElement;
    root.append(this.canvas);

    const hud = el("div", { class: "hud" });
    this.h.hud = hud;
    // 左上: 順位の塔
    this.h.lapHead = el("b", { class: "num" });
    this.h.tower = el("ol");
    this.h.gapMode = el("span", { class: "tw-mode" });
    // 前と後ろの車 (練習は幽霊) との差: 広い画面は計器の上、スマホの縦は右の地図の下、スマホの横は上の真ん中 (race.css)
    this.h.duel = el("div", { class: "duel" });
    // 上の真ん中: 時間
    this.h.time = el("div", { class: "v num" });
    this.h.last = el("div", { class: "v num" });
    this.h.best = el("div", { class: "v num" });
    this.h.bestK = el("div", { class: "k" }, "BEST");
    const quit = el("button", { class: "quit" }, o.quitLabel ?? "✕");
    quit.title = "やめる";
    quit.addEventListener("click", () => o.onQuit());
    // 右上: 地図・天気
    this.mini = el("canvas") as HTMLCanvasElement;
    this.h.wx = el("div", { class: "wx" });
    // 下: タイヤ・速さ・ペダル・燃料・ピット
    this.h.pos = el("div", { class: "pos num" });
    this.h.tire = el("div", { class: "tyre" });
    this.h.spd = el("div", { class: "spd num" });
    this.h.thr = el("i");
    this.h.brk = el("i");
    this.h.fuel = el("i");
    this.h.fuelTxt = el("span", { class: "num" });
    this.h.dmg = el("canvas", { class: "dmg", title: "車の傷み" });
    // DRS: 大きな字と、下の行に今の様子 (OFF・検知の線での前との差と使えるか・ZONE・OPEN)
    this.h.drsSt = el("small", {}, "OFF");
    this.h.drs = el("button", { class: "drs-btn off", "aria-label": "DRS" }, el("b", {}, "DRS"), this.h.drsSt);
    this.h.drs.addEventListener("click", () => this.pressDrs());
    // オーバーテイクモード: 押している間だけ力が増える。目盛りはこの周の残り
    this.h.otFill = el("i");
    this.h.ot = el("button", { class: "ot-btn off", "aria-label": "オーバーテイク" }, el("b", {}, "OT"), el("span", { class: "ot-gauge" }, this.h.otFill), el("small", {}, "OFF"));
    const otDown = (ev: PointerEvent) => {
      ev.preventDefault();
      this.controls.otHeld = true;
    };
    const otUp = () => (this.controls.otHeld = false);
    this.h.ot.addEventListener("pointerdown", otDown);
    this.h.ot.addEventListener("pointerup", otUp);
    this.h.ot.addEventListener("pointercancel", otUp);
    this.h.ot.addEventListener("pointerleave", otUp);
    this.h.ot.addEventListener("contextmenu", (ev) => ev.preventDefault());
    // 段と回転 (マニュアルは自分の段、オートマは見た目の段)
    this.h.gear = el("b", { class: "gear-n num" }, "1");
    this.h.rpmFill = el("i");
    this.h.gearbox = el(
      "div",
      { class: `gearbox${this.manual ? " mt" : ""}`, title: this.manual ? "マニュアル: X / Shift で上げる、Z / Ctrl で下げる" : "オートマ" },
      el("span", { class: "gear-k" }, this.manual ? "MT" : "AT"),
      this.h.gear,
      el("span", { class: "rpm" }, this.h.rpmFill),
    );
    this.h.flagBar = el("div", { class: "flag-bar" });
    this.h.pitBtn = el("button", { class: "pit-btn" }, "PIT");
    this.h.pitBtn.addEventListener("click", () => this.togglePit());
    this.h.pitPanel = el("div", { class: "pit-panel" });
    // 信号・大きな字・お知らせ
    this.h.gantry = el("div", { class: "gantry" });
    for (let i = 0; i < 5; i++) this.h.gantry.append(el("span", {}, el("i"), el("i")));
    this.h.big = el("div", { class: "bigmsg" });
    this.h.toast = el("div", { class: "toast" });

    hud.append(
      (this.h.towerBox = el("div", { class: "tower" }, el("div", { class: "tw-head" }, el("span", { class: "k" }, o.modeLabel ?? (o.laps ? "LAP" : "PRACTICE")), this.h.gapMode, this.h.lapHead), this.h.tower)),
      el(
        "div",
        { class: "timing" },
        el("div", { class: "cell now" }, el("div", { class: "k" }, "LAP TIME"), this.h.time),
        el("div", { class: "cell" }, el("div", { class: "k" }, "LAST"), this.h.last),
        el("div", { class: "cell" }, this.h.bestK, this.h.best),
        quit,
      ),
      el("div", { class: "side" }, el("div", { class: "mini" }, this.mini), this.h.wx, this.h.duel),
      el(
        "div",
        { class: "dash" },
        this.h.flagBar,
        this.h.drs,
        this.h.ot,
        this.h.pos,
        this.h.dmg,
        this.h.tire,
        el("div", { class: "speed" }, this.h.spd, el("div", { class: "unit" }, "KM/H")),
        this.h.gearbox,
        el("div", { class: "pedal-meters" }, el("span", { class: "brk" }, this.h.brk), el("span", { class: "thr" }, this.h.thr)),
        el("div", { class: "fuel" }, el("span", { class: "k" }, "FUEL"), this.h.fuelTxt, el("div", { class: "bar" }, this.h.fuel)),
        this.h.pitBtn,
      ),
      this.h.pitPanel,
      this.h.gantry,
      this.h.big,
      this.h.toast,
      el(
        "div",
        { class: "keys" },
        o.assist
          ? el("span", {}, el("kbd", {}, "←"), el("kbd", {}, "→"), " ハンドル (アクセル自動) ", ...this.extraKeys())
          : el("span", {}, el("kbd", {}, "←"), el("kbd", {}, "→"), " ハンドル ", el("kbd", {}, "↑"), " アクセル ", el("kbd", {}, "↓"), " ブレーキ・下がる ", ...this.extraKeys()),
      ),
    );
    root.append(hud);
    this.h.towerBox.addEventListener("click", this.onTowerClick);
    window.addEventListener("keydown", this.onKey);

    this.controls = new Controls(root, o.assist, this.manual);
    this.controls.onGo(() => this.pressGo());

    if (o.me) {
      this.car = createCar(o.track, o.me.stats, o.me.slot, o.setup ?? {});
      this.camX = this.car.x;
      this.camY = this.car.y;
      this.camH = this.car.heading;
      this.myStint = newStint(this.car.tire, this.car.wear, this.car.dist);
    } else {
      this.car = null;
      root.querySelector(".pads")?.remove();
      root.querySelector(".dash")?.remove();
      this.h.pitPanel.remove();
    }
    this.simT = o.clock();
    this.sectors = new SectorHud(hud, o.track, { practice: !o.laps, myId: o.me?.info.id ?? null });
    if (o.me) this.radio = new RadioUI(hud, { myId: o.me.info.id, driver: o.me.info.name, color: o.me.info.color, onPit: (order) => !!this.car && (requestPit(this.car, order), true) });
    window.addEventListener("resize", this.resize);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  setOthers(list: CarInfo[]) {
    const keep = new Set(list.map((c) => c.id));
    for (const id of [...this.others.keys()]) if (!keep.has(id)) this.others.delete(id);
    for (const info of list) {
      if (info.id === this.o.me?.info.id) continue;
      const cur = this.others.get(info.id);
      if (cur) cur.info = info;
      else this.others.set(info.id, { info, stats: computeStats(info.design, partStrength()), buf: [], ty: null });
    }
  }

  /** 旗の状態 (snap に付いてくる) */
  setFlag(f: FlagInfo | null | undefined) {
    const prev = this.flag?.mode ?? "green";
    this.flag = f ?? null;
    const mode = this.flag?.mode ?? "green";
    if (mode !== prev) {
      if (mode === "sc") this.big("SAFETY CAR — 一列に並んで自動で走ります", 3000);
      else if (mode === "vsc") this.big(`VSC — 時速 ${Math.round((this.flag?.cap ?? 20) * 3.6)} km まで`, 3000);
      else this.big("GREEN — レース再開", 2000);
    }
  }

  /** DRS を開く (ボタン・キー) */
  pressDrs() {
    const car = this.car;
    if (!car) return;
    if (car.drs?.open) closeDrs(car);
    else if (openDrs(car, this.o.track)) this.toast("DRS 開", 700);
  }

  /** 操作の案内の後ろ: 変速 (マニュアル)・DRS・オーバーテイク・ピット */
  private extraKeys(): Array<Node | string> {
    const k = (t: string) => el("kbd", {}, t);
    return [
      ...(this.manual ? [k("X"), "/", k("Shift"), " 上げ ", k("Z"), "/", k("Ctrl"), " 下げ "] : []),
      k("E"),
      " DRS ",
      k("Q"),
      " オーバーテイク ",
      k("P"),
      " ピット",
    ];
  }

  /** 検知の線を越えてから、その区間の終わりまでにいるか */
  private inDrsWindow(car: CarState): boolean {
    const L = this.o.track.length;
    const mod = (v: number) => ((v % L) + L) % L;
    return drsZones(this.o.track).some((z) => mod(car.dist - z.detect) <= mod(z.end - z.detect));
  }

  /** 今 DRS が使えるか (画面の光) */
  drsReady(): boolean {
    return !!this.car && drsAvailable(this.car, this.o.track);
  }

  pushSnap(now: number, cars: SnapCar[]) {
    // snap の時刻 (サーバーの ms) をスタートの合図からの秒に直す (自分の車の印と同じ時計)
    const raceT = this.o.netClock ? (now - this.o.netClock()) / 1000 + this.o.clock() : null;
    for (const c of cars) {
      const [id, x, y, h, dist, flags, laps, vx, vy] = c;
      const o = this.others.get(id);
      if (!o) continue;
      o.buf.push({ t: now, x, y, h, dist, flags, laps, vx: vx ?? 0, vy: vy ?? 0 });
      if (o.buf.length > 30) o.buf.shift();
      o.ty = readSnapTyre(c);
      if (raceT !== null) this.markOf(id).push(raceT, dist);
      if (raceT !== null) this.sectors.pushOther(id, raceT, dist);
      if (flags & 1 && !this.finishOrder.includes(id)) this.finishOrder.push(id);
    }
  }

  /** 練習の幽霊 (一番速い幽霊) の 3 つのセクターのタイム。なければ null */
  private ghostSectorRef(): Array<number | null> | null {
    const list = this.ghostList();
    if (!list.length) return null;
    const g = list.reduce((a, b) => (b.ghost.lap < a.ghost.lap ? b : a)).ghost;
    let v = this.ghostSecs.get(g);
    if (v === undefined) {
      let p = this.ghostProfs.get(g);
      if (p === undefined) {
        p = ghostProfile(this.o.track, g.pts, g.lap);
        this.ghostProfs.set(g, p);
      }
      v = p ? ghostSectorTimes(p, this.o.track) : null;
      this.ghostSecs.set(g, v);
    }
    return v;
  }

  private markOf(id: string): TimingMarks {
    let m = this.marks.get(id);
    if (!m) this.marks.set(id, (m = new TimingMarks(this.o.track.length)));
    return m;
  }

  /** つなぎ直したとき、サーバーが持っていた続きから走る */
  resume(rc: ResumeCar) {
    if (!this.car) return;
    Object.assign(this.car, { x: rc.x, y: rc.y, heading: rc.heading, vx: rc.vx, vy: rc.vy, dist: rc.dist, fuel: rc.fuel, started: true, pit: null });
    if (rc.tire) this.car.tire = rc.tire;
    if (rc.wear !== undefined) this.car.wear = rc.wear;
    if (rc.burst !== undefined) this.car.burst = rc.burst;
    if (rc.sets) this.car.sets = readTireSets(rc.sets);
    const q = queryTrack(this.o.track, rc.x, rc.y);
    this.car.hint = q.index;
    this.car.lastS = q.s;
    this.lap.lapsDone = rc.lapsDone;
    this.lap.lapStart = rc.lapStart;
    this.lap.bestLap = rc.bestLap;
    this.lap.penalty = rc.penalty;
    if (this.myStint) Object.assign(this.myStint, { tire: this.car.tire, wear: this.car.wear, burst: this.car.burst, fitAt: Math.min(this.myStint.fitAt, rc.dist) });
    this.goPressed = true;
    this.simT = this.o.clock();
    this.toast("つなぎ直しました。続きから");
  }

  /** チームの 2 台目への作戦の合図のボタン (右の列の下) */
  private teamBox: HTMLElement | null = null;
  private teamKey = "";

  /**
   * チームの 2 台目への作戦の合図 (11/25)。2 台目が同じレースを走っているときだけ出す (mate = null で消す)。
   * 「タイヤを持たせろ」「攻めろ」は続く合図なので、もう一度押すと「ふつうに走れ」に戻す
   */
  setTeamOrders(mate: { id: string; name: string; color: string } | null, send: (o: TeamOrder) => void) {
    const key = mate && this.car ? `${mate.id}|${mate.name}|${mate.color}` : "";
    if (key === this.teamKey) return;
    this.teamKey = key;
    this.teamBox?.remove();
    this.teamBox = null;
    if (!mate || !this.car) return;
    let mode: TeamOrder = "none";
    const btns = new Map<TeamOrder, HTMLButtonElement>();
    const mark = () => {
      for (const [o, b] of btns) b.classList.toggle("on", o === mode);
    };
    const row = el("div", { class: "to-btns" });
    for (const o of TEAM_ORDERS) {
      const b = el("button", { class: `to-b to-${o}`, type: "button" }, TEAM_ORDER_TEXT[o]) as HTMLButtonElement;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        b.blur();
        const next: TeamOrder = (o === "save" || o === "push") && mode === o ? "none" : o;
        if (o === "save" || o === "push" || next === "none") mode = next;
        mark();
        // 一度きりの合図 (ピット・譲れ) は押した印を少しだけ光らせる
        if (o === "pit" || o === "yield") {
          b.classList.add("sent");
          setTimeout(() => b.classList.remove("sent"), 900);
        }
        send(next);
      });
      btns.set(o, b);
      row.append(b);
    }
    this.teamBox = el(
      "div",
      { class: "team-orders", role: "group", "aria-label": "2 台目への作戦" },
      el("div", { class: "to-head" }, el("i", { class: "to-dot", style: `background:${mate.color}` }), el("span", { class: "to-k" }, "2 台目へ"), el("span", { class: "to-nm" }, mate.name)),
      row,
    );
    (this.h.hud.querySelector(".side") ?? this.h.hud).append(this.teamBox);
  }

  toast(text: string, ms = 2200) {
    this.h.toast.textContent = text;
    this.toastUntil = performance.now() + ms;
  }

  big(text: string, ms = 1500) {
    this.bigText = text;
    this.bigUntil = performance.now() + ms;
  }

  private pressGo() {
    if (!this.car || this.goPressed) return;
    const t = this.o.clock();
    if (t < this.o.lightsStartT - 0.5) return; // 信号が出る前は数えない
    this.goPressed = true;
    this.car.started = true;
    if (t < 0) {
      this.lap.penalty += JUMP_START_PENALTY;
      this.toast(`フライング +${JUMP_START_PENALTY} 秒`, 3000);
    } else {
      this.big(`反応 ${t.toFixed(2)} 秒`, 1200);
    }
    this.o.onGo?.(t);
  }

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    const m = Math.round(Math.min(150, Math.max(96, Math.min(w, h) * 0.24)));
    this.mini.style.width = `${m}px`;
    this.mini.style.height = `${m}px`;
    this.mini.width = Math.round(m * this.dpr);
    this.mini.height = Math.round(m * this.dpr);
    this.miniKey = "";
  };

  private frame = () => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const t = this.o.clock();
    this.simulate(t);
    this.render(t);
    this.sound(t);
    this.controls.paint();
    if (this.car && this.o.me) {
      this.paintGearbox(this.car, this.o.me.stats);
      // オーバーテイクは押している間すぐ光らせる (計器の書きかえは 0.1 秒ごと)
      if (!!this.car.ot?.active !== this.h.ot.classList.contains("active")) this.paintOvertake(this.car);
    }
    const now = performance.now();
    if (now - this.lastHud > 100) {
      this.lastHud = now;
      this.updateHud(t);
    }
  };

  private simulate(t: number) {
    const car = this.car;
    const me = this.o.me;
    if (!car || !me) return;
    if (t - this.simT > 1) this.simT = t - 1;
    // かんたん操作では、合図のあと 3 秒たっても押さなければ自動で発進
    if (!this.goPressed && this.o.assist && t > 3) this.pressGo();
    const track = this.o.track;
    const solid = this.solidOthers();
    let steps = 0;
    while (this.simT + DT <= t && steps < 90) {
      steps++;
      const done = this.lap.finished || this.lap.retired;
      let input = done
        ? finishInput(car, me.stats, track, this.simT, solid, this.wet) // ゴールのあとは道に沿ってゆっくり
        : {
            steer: this.controls.steer(),
            throttle: this.controls.throttle(),
            brake: this.controls.brake(),
            assist: this.o.assist,
            ...(this.controls.overtake() ? { overtake: true } : {}),
            ...(this.manual ? { gear: this.controls.gear() } : {}),
          };
      // SC の間は一列に並んで自動で走る
      if (!done && car.started) {
        const auto = flagInput(this.flag, me.info.id, car, me.stats, track, this.followMap(), this.wet, solid);
        if (auto) input = auto;
      }
      if (!done && !this.goPressed && input.throttle > 0) this.pressGo();
      this.lastThrottle = this.o.assist ? (car.started ? 1 : 0) : input.throttle;
      this.lastBrake = input.brake;
      this.wet = this.o.weather ? wetnessAt(this.o.weather, this.simT) : 0;
      const prevDist = car.dist;
      const ev = stepCar(car, input, me.stats, track, DT, {
        wetness: this.wet,
        // 走る線の上は先に乾く
        ...(this.o.weather ? { lineWetness: lineWetnessAt(this.o.weather, this.simT) } : {}),
        tow: car.pit ? 0 : towFactor(car, solid),
        speedCap: flagSpeedCap(this.flag),
        boxBusy: this.boxBusy,
        ...(this.manual ? { manualBonus: this.mtBonus } : {}),
      });
      if (ev.wall > this.snd.wallHit) this.snd.wallHit = ev.wall; // 音 (読むだけ)
      this.simT += DT;
      if (!done && car.started) recordSample(this.replay, this.simT, car.x, car.y, carSpeed(car), input.brake, this.lap.lapsDone);
      this.watchPit(car);
      this.markOf(me.info.id).push(this.simT, car.dist);
      // セクター (周の数え直しより先に: 近道の印 lapInvalid がまだその周のもの)
      if (!done && this.sectors.pushMine(me.info.id, this.simT, car.dist, !car.lapInvalid, this.ghostSectorRef()).length) this.replay.sectors = this.sectors.record(me.info.id);
      if (this.myStint) {
        updateStint(this.myStint, { inPit: !!car.pit, tire: car.tire, wear: car.wear, burst: car.burst, dist: car.dist, speed: carSpeed(car), running: car.started && !done }, this.simT);
      }
      const dists = this.otherDists();
      updateDrs(car, track, prevDist, dists, !!this.flag?.drs);
      updateOvertake(car, track, prevDist, dists, !!this.flag?.ot);
      if (ev.damage) this.onDamage(ev.damage);

      // ほかの車とのぶつかり (ゴール・リタイアした車とピットの道の車はすり抜ける)
      if (!done && !car.pit) {
        const myBody = bodyOf(car, me.stats);
        for (const b of solid) {
          const hit = pushApart(car, myBody, b, 0.5, me.stats, (d) => this.onDamage(d));
          if (hit > this.snd.carHit) this.snd.carHit = hit; // 音 (読むだけ)
          if (hit > 2.5) {
            this.toast("接触!", 700);
            this.sparks.push({ x: (car.x + b.x) / 2, y: (car.y + b.y) / 2, t: performance.now() });
          }
        }
      }
      // 横滑りのあと
      if (car.slip > 2.2 || (this.lastBrake > 0 && carSpeed(car) > 12 && car.surface !== "grass")) this.addSkid(car.x, car.y);
      else this.lastSkid = null;

      if (done) continue;
      if (ev.wall > 4) {
        this.toast("壁!", 600);
        this.sparks.push({ x: car.x, y: car.y, t: performance.now() });
      }
      const le = updateLaps(car, this.lap, ev, this.simT, track.length, this.o.laps || Infinity, this.o.isChequered?.() ?? false);
      if (le.cut) this.toast(`近道: この周は数えません +${le.cut.toFixed(1)} 秒`, 3000);
      if (car.started && this.simT >= this.ghostNext) {
        this.ghostRec.push(round1(car.x), round1(car.y), Math.round(car.heading * 100) / 100);
        this.ghostNext += 0.1; // ちょうど 0.1 秒ごと (simT + 0.1 だと刻みの端数で間が延び、再生が速くなる)
      }
      if (le.lap) {
        const { time, valid } = le.lap;
        this.snd.lap(time, valid, this.sectors.fastestOtherLap(me.info.id)); // 音 (読むだけ)
        this.big(`${valid ? "" : "(数えない) "}${formatTime(time)}`, 2000);
        if (valid && this.o.onNewBestLap) {
          const prev = this.o.ghost;
          if (!prev || time < prev.lap) {
            const g = { lap: time, pts: this.ghostRec.slice() };
            this.o.ghost = g;
            this.o.onNewBestLap(g);
            this.toast("自己ベスト!", 2000);
          }
        }
        this.ghostRec = [];
        this.ghostNext = this.simT;
        this.o.onLap?.(time, valid, this.lap);
      }
      if (le.finished) {
        this.big("ゴール!", 4000);
        this.o.onFinish?.(this.lap);
      }
      if (le.retired) {
        this.big("燃料切れ リタイア", 4000);
        this.o.onRetire?.();
      }
    }
  }

  private addSkid(x: number, y: number) {
    if (this.lastSkid) {
      const k = (this.skidN % SKID_MAX) * 4;
      this.skids[k] = this.lastSkid[0];
      this.skids[k + 1] = this.lastSkid[1];
      this.skids[k + 2] = x;
      this.skids[k + 3] = y;
      this.skidN++;
    }
    this.lastSkid = [x, y];
  }

  private onDamage(d: DamageEvent) {
    const name: Record<string, string> = { seat: "運転席", engine: "エンジン", tire: "タイヤ", tank: "燃料タンク", wing: "羽根", brake: "ブレーキ", frame: "骨組み" };
    const n = name[d.kind] ?? "部品";
    if (d.out) this.big("運転席が壊れた — リタイア", 4000);
    else if (d.lost) this.toast(`${n}が外れて落ちた! ピットで直せます`, 3000);
    else if (d.broke) this.toast(`${n}が壊れた! ピットで直せます`, 2600);
    else if (d.strong) this.toast(`${n}が傷んだ`, 1500);
  }

  /** ほかの車の道のり (DRS の 1 秒差を見るため。ピット・ゴール・リタイアの車は除く) */
  private otherDists(): number[] {
    const out: number[] = [];
    for (const o of this.others.values()) {
      const l = o.buf[o.buf.length - 1];
      if (l && !(l.flags & (F_FIN | F_RET | F_PIT))) out.push(l.dist);
    }
    return out;
  }

  /** SC の列のための、ほかの車の道のりと速さ */
  private followMap(): Map<string, { dist: number; v: number }> {
    const m = new Map<string, { dist: number; v: number }>();
    for (const [id, o] of this.others) {
      const l = o.buf[o.buf.length - 1];
      if (l) m.set(id, { dist: l.dist, v: Math.hypot(l.vx, l.vy) });
    }
    return m;
  }

  /** ぶつかりの相手 (少し先まで伸ばした今の位置) */
  private solidOthers(): Body[] {
    const out: Body[] = [];
    const now = this.o.netClock?.() ?? 0;
    for (const o of this.others.values()) {
      const last = o.buf[o.buf.length - 1];
      if (!last || last.flags & (F_FIN | F_RET | F_PIT)) continue;
      const ahead = Math.max(0, Math.min(0.2, (now - last.t) / 1000));
      out.push({
        x: last.x + last.vx * ahead,
        y: last.y + last.vy * ahead,
        heading: last.h,
        vx: last.vx,
        vy: last.vy,
        mass: o.stats.mass,
        width: o.stats.width,
        length: o.stats.length,
        bodyLx: o.stats.bodyLx,
        bodyLf: o.stats.bodyLf,
      });
    }
    return out;
  }

  /** ほかの車の今の位置 (少し前の時刻で 2 つの記録の間をとる) */
  private otherPose(o: Other): Pose | null {
    const b = o.buf;
    if (!b.length) return null;
    const rt = (this.o.netClock?.() ?? 0) - 120;
    if (rt <= b[0].t) return b[0];
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1];
      const c = b[i];
      if (a.t <= rt && rt <= c.t) {
        const u = (rt - a.t) / Math.max(1, c.t - a.t);
        let dh = c.h - a.h;
        if (dh > Math.PI) dh -= 2 * Math.PI;
        if (dh < -Math.PI) dh += 2 * Math.PI;
        return { x: a.x + (c.x - a.x) * u, y: a.y + (c.y - a.y) * u, h: a.h + dh * u, dist: a.dist + (c.dist - a.dist) * u, flags: c.flags, laps: c.laps, vx: c.vx, vy: c.vy };
      }
    }
    // 記録より先: 速さで少しだけ伸ばす
    const l = b[b.length - 1];
    const ahead = Math.min(0.2, (rt - l.t) / 1000);
    return { ...l, x: l.x + l.vx * ahead, y: l.y + l.vy * ahead };
  }

  private standings(): Row[] {
    const list: Row[] = [];
    if (this.car && this.o.me) {
      const ms = this.myStint;
      list.push({
        id: this.o.me.info.id,
        finished: this.lap.finished,
        retired: this.lap.retired,
        lapsDone: this.lap.lapsDone,
        finishTime: this.lap.finished ? this.finishRank(this.o.me.info.id) : 0,
        penalty: 0,
        dist: this.car.dist,
        name: this.o.me.info.name,
        color: this.o.me.info.color,
        me: true,
        pit: !!this.car.pit,
        tire: this.car.tire,
        wear: this.car.wear,
        tyreLaps: ms ? tyreLaps(ms, this.car.dist, this.o.track.length) : null,
        pitStops: ms ? ms.pitStops : null,
        burst: this.car.burst,
        stopped: false,
      });
    }
    // ほかの車の並び: 描くための位置 (otherPose、120 ms 前) ではなく、最後の snap を今まで伸ばした道のりで比べる。
    // 自分の道のりは今のものなので、120 ms 前どうしで比べると すぐ前の車を後ろに並べてしまい、
    // タイム差の印 (snap の時刻で記録) と向きが食い違って「+0.000」になっていた
    const netNow = this.o.netClock?.() ?? 0;
    for (const o of this.others.values()) {
      const p = o.buf[o.buf.length - 1];
      if (!p) continue;
      const ty = o.ty;
      const age = p.flags & (F_FIN | F_RET) ? 0 : Math.max(0, Math.min(0.25, (netNow - p.t) / 1000));
      list.push({
        id: o.info.id,
        finished: !!(p.flags & 1),
        retired: !!(p.flags & 2),
        lapsDone: p.laps,
        finishTime: this.finishRank(o.info.id),
        penalty: 0,
        dist: p.dist + Math.hypot(p.vx, p.vy) * age,
        name: o.info.name,
        color: o.info.color,
        me: false,
        pit: !!(p.flags & F_PIT),
        tire: ty?.tire ?? null,
        wear: null,
        tyreLaps: ty?.tyreLaps ?? null,
        pitStops: ty?.pitStops ?? null,
        burst: !!ty?.burst,
        stopped: !!ty?.stopped && !(p.flags & (F_FIN | F_RET)),
      });
    }
    return sortStandings(list);
  }

  private finishRank(id: string): number {
    if (this.o.me && id === this.o.me.info.id && this.lap.finished && !this.finishOrder.includes(id)) this.finishOrder.push(id);
    const i = this.finishOrder.indexOf(id);
    return i < 0 ? 999 : i;
  }

  private updateHud(t: number) {
    const ls = this.o.lightsStartT;
    const showLights = t >= ls - 1 && t < 0.6;
    const gd = showLights ? "flex" : "none";
    if (this.h.gantry.style.display !== gd) this.h.gantry.style.display = gd;
    [...this.h.gantry.children].forEach((l, i) => l.classList.toggle("on", t >= ls + i && t < 0));
    let big = performance.now() < this.bigUntil ? this.bigText : "";
    if (!big && this.car && !this.goPressed) {
      if (t < ls) big = "まもなくスタート";
      else if (t < 0) big = this.o.assist ? "信号が全部消えたら押して発進" : "信号が全部消えたらアクセル";
      else big = this.o.assist ? "押して発進!" : "アクセル!";
    }
    if (!big && this.car?.pit?.phase === "box") big = `作業中 ${Math.max(0, this.car.pit.service - this.car.pit.elapsed).toFixed(1)}`;
    // 大きな字の種類: 周の時間 (自己ベストは紫)・ピット・ゴール・困ったこと・スタート前
    const lapStr = this.lap.lastLap !== null ? formatTime(this.lap.lastLap) : "";
    let kind = "";
    if (big && lapStr && big === this.bigText && big.endsWith(lapStr)) kind = big !== lapStr ? "lap void" : this.lap.lastLap === this.lap.bestLap ? "lap pb" : "lap";
    else if (big.startsWith("作業中")) kind = "pit";
    else if (big === "ゴール!") kind = "fin";
    else if (big.includes("破裂") || big.includes("リタイア")) kind = "bad";
    else if (big && !this.goPressed) kind = "start";
    setClass(this.h.big, `bigmsg${kind ? ` ${kind}` : ""}`);
    setText(this.h.big, big);
    this.h.big.style.display = big ? "block" : "none";
    this.h.toast.style.display = performance.now() < this.toastUntil ? "block" : "none";

    const st = this.standings();
    const leader = st[0];
    // 順位の塔
    this.renderTower(st);
    this.renderDuel(st, t);

    const lead = leader ? Math.min(leader.lapsDone + 1, this.o.laps || Infinity) : 1;
    if (this.car && this.o.me) {
      const lapNow = Math.max(1, Math.min(this.lap.lapsDone + 1, this.o.laps || Infinity));
      setText(this.h.lapHead, this.o.laps ? `${lapNow}/${this.o.laps}` : String(lapNow));
      const cur = this.lap.finished ? null : this.goPressed ? Math.max(0, t - this.lap.lapStart) : null;
      setText(this.h.time, formatTime(cur));
      setText(this.h.last, formatTime(this.lap.lastLap));
      // 周が終わったら LAST を 3 秒光らせる (自己ベストは紫)
      if (this.lap.lapsDone !== this.flashLaps) {
        this.flashLaps = this.lap.lapsDone;
        if (this.lap.lastLap !== null) this.flashUntil = performance.now() + 3000;
      }
      const flash = performance.now() < this.flashUntil;
      const lastCell = this.h.last.parentElement!;
      lastCell.classList.toggle("flash", flash);
      lastCell.classList.toggle("pb", flash && this.lap.lastLap !== null && this.lap.lastLap === this.lap.bestLap);
      const ghostLaps = this.ghostList().map((e) => e.ghost.lap);
      const ghostBest = ghostLaps.length ? Math.min(...ghostLaps) : null;
      setText(this.h.bestK, ghostBest !== null && (this.lap.bestLap === null || ghostBest < this.lap.bestLap) ? "GHOST" : "BEST");
      const best = this.lap.bestLap === null ? ghostBest : ghostBest === null ? this.lap.bestLap : Math.min(ghostBest, this.lap.bestLap);
      setText(this.h.best, formatTime(best));
      this.h.best.classList.toggle("purple", this.lap.bestLap !== null && best === this.lap.bestLap);

      this.updateRaceRules(this.car, this.o.me.info.id);
      this.sectors.paint(t, this.o.me.info.id, this.goPressed);
      this.radio?.tick({ t, car: this.car, stats: this.o.me.stats, track: this.o.track, laps: this.o.laps, lap: this.lap, weather: this.o.weather, flag: this.flag, started: this.goPressed });
      const myPos = this.posMap.get(this.o.me.info.id) ?? 0;
      this.h.pos.style.display = st.length > 1 && myPos ? "" : "none";
      const posKey = `${myPos}/${st.length}`;
      if (this.h.pos.dataset.k !== posKey) {
        this.h.pos.dataset.k = posKey;
        this.h.pos.replaceChildren(el("small", {}, "P"), String(myPos), el("small", {}, `/${st.length}`));
      }
      const car = this.car;
      setText(this.h.spd, String(Math.round(carSpeed(car) * 3.6)));
      this.h.thr.style.height = `${Math.round(this.lastThrottle * 100)}%`;
      this.h.brk.style.height = `${Math.round(this.lastBrake * 100)}%`;
      const ff = car.fuel / Math.max(1, this.o.me.stats.fuelCap);
      this.h.fuel.style.width = `${Math.round(ff * 100)}%`;
      this.h.fuel.classList.toggle("low", this.fuelLapsLeft() < 1.3);
      setText(this.h.fuelTxt, `${car.fuel.toFixed(1)} L · ${this.fuelLapsLeft().toFixed(1)} 周`);
      // タイヤ
      const wearPct = Math.round(car.wear * 100);
      const tireKey = `${car.tire}|${wearPct}|${car.burst ? 1 : 0}`;
      if (this.h.tire.dataset.k !== tireKey) {
        this.h.tire.dataset.k = tireKey;
        this.h.tire.replaceChildren(
        tireBadge(car.tire, car.wear),
        el("div", {}, el("div", { class: "k" }, TIRE_DEFS[car.tire].name), el("div", { class: `num w${car.burst ? " burst" : car.wear > 0.75 ? " worn" : ""}` }, car.burst ? "破裂" : `${100 - wearPct}`, car.burst ? null : el("small", {}, "%"))),
        );
      }
      // ピットのボタン
      const pb = this.h.pitBtn;
      const ph = car.pit?.phase;
      setClass(pb, `pit-btn${car.pitOrder && !ph ? " booked" : ""}${ph ? " active" : ""}`);
      setText(pb, ph === "in" ? "PIT IN" : ph === "box" ? "STOP" : ph === "out" ? "PIT OUT" : car.pitOrder ? "PIT ✓" : "PIT");
      if (this.pitOpen) this.updatePitStatus();
    } else {
      setText(this.h.lapHead, leader ? `${lead}/${this.o.laps}` : "-");
      setText(this.h.time, "観戦中");
      setText(this.h.last, "—");
      setText(this.h.best, "—");
    }
    this.updateWeather(t);
  }

  /** 2 台のタイム差 (前の車 a、後ろの車 b)。ゴールした車はゴールの線で比べる */
  private gapOf(a: Row, b: Row): Gap {
    const ma = this.marks.get(a.id);
    const mb = this.marks.get(b.id);
    if (!ma || !mb) return null;
    return gapBetween(ma, mb, this.o.track.length, b.finished ? b.lapsDone * this.o.track.length : undefined);
  }

  private onTowerClick = (e: Event) => {
    // 狭い画面: 並びを押すと広げる・閉じる、見出しを押すと差の種類を切りかえ。広い画面: どこを押しても切りかえ
    const inList = (e.target as HTMLElement).closest?.("ol");
    if (this.compact?.matches && inList) this.towerOpen = !this.towerOpen;
    else {
      this.gapMode = this.gapMode === "int" ? "lead" : "int";
      saveGapMode(this.gapMode);
    }
    this.lastHud = 0;
  };

  /**
   * 順位の塔: 順位・名前・タイム差・タイヤ (色の丸と周)・ピットの回数・PIT / 止まった / 破裂の印。
   * 行の要素は残しておき、変わった字と class だけ書きかえる (毎回作り直すと 0.1 秒ごとに 200 ほどの要素が入れかわっていた)
   */
  private renderTower(st: Row[]) {
    const tower = this.h.tower;
    const box = this.h.towerBox;
    const flag = this.flag?.mode ?? "green";
    if (box.dataset.flag !== flag) box.dataset.flag = flag;
    const race = !!this.o.laps;
    box.classList.toggle("tappable", race || !!this.compact?.matches);
    setText(this.h.gapMode, race ? (this.gapMode === "int" ? "INTERVAL ⇄" : "LEADER ⇄") : "");
    this.posMap.clear();
    st.forEach((s, i) => this.posMap.set(s.id, i + 1));
    // 狭い画面では 上の COMPACT_TOP 台 + 自分の前後だけ (押すと全部)
    const meIdx = st.findIndex((s) => s.me);
    const compact = !!this.compact?.matches && !this.towerOpen && st.length > COMPACT_TOP + 3;
    const show = (i: number) => !compact || i < COMPACT_TOP || (meIdx >= 0 && Math.abs(i - meIdx) <= 1) || (meIdx < 0 && i < COMPACT_TOP + 3);
    let hidden = 0;
    let skipped = false;
    let n = 0;
    // n 番目の子を kind の要素にする (違う種類なら作って差しかえる)
    const slot = (kind: "row" | "sep" | "more"): HTMLElement => {
      const cur = tower.children[n] as HTMLElement | undefined;
      n++;
      if (cur && cur.dataset.kind === kind) return cur;
      const e = kind === "row" ? this.newTowerRow() : el("li", { class: kind, "data-kind": kind }, el("span", {}, kind === "sep" ? "⋯" : ""));
      if (cur) cur.replaceWith(e);
      else tower.append(e);
      return e;
    };
    st.forEach((s, i) => {
      if (!show(i)) {
        hidden++;
        skipped = true;
        return;
      }
      if (skipped) {
        slot("sep");
        skipped = false;
      }
      this.fillTowerRow(slot("row"), st, s, i);
    });
    const more = compact && hidden ? `▾ 全 ${st.length} 台` : this.compact?.matches && this.towerOpen && st.length > COMPACT_TOP + 3 ? "▴ 閉じる" : "";
    if (more) setText(slot("more").firstElementChild as HTMLElement, more);
    while (tower.children.length > n) tower.lastElementChild!.remove();
  }

  /** 塔の 1 行の入れ物 (中身は fillTowerRow) */
  private newTowerRow(): HTMLElement {
    return el(
      "li",
      { "data-kind": "row" },
      el("span", { class: "p num" }),
      el("span", { class: "bar" }),
      el("span", { class: "nm" }),
      el("span", { class: "gap num" }),
      el("span", { class: "tw-none" }),
      el("span", { class: "tl num" }),
      el("span", { class: "ps" }),
      el("span", { class: "sm" }),
    );
  }

  private fillTowerRow(li: HTMLElement, st: Row[], s: Row, i: number) {
    let gap = "";
    let gk = "";
    if (s.retired) {
      gap = "OUT";
      gk = "out";
    } else if (s.pit) {
      gap = "PIT";
      gk = "pit";
    } else if (s.stopped) {
      gap = "STOP";
      gk = "stop";
    } else if (i === 0) {
      gap = s.finished ? "FIN" : this.o.laps ? "LEADER" : "";
      gk = "lead";
    } else {
      const ahead = this.gapMode === "int" ? st[i - 1] : st[0];
      const g = this.gapOf(ahead, s);
      gap = g ? formatGap(g) : "—";
      gk = g?.kind === "laps" ? "laps" : "";
    }
    setClass(li, `${s.me ? "me" : ""}${s.retired ? " out" : ""}${s.pit ? " pit" : ""}${s.stopped ? " stop" : ""}`);
    const [p, bar, nm, gapEl, tyreEl, tl, pips, mini] = li.children as unknown as HTMLElement[];
    if (mini) this.sectors.paintMini(mini, s.id);
    setText(p, String(i + 1));
    if (bar.dataset.c !== s.color) {
      bar.dataset.c = s.color;
      bar.style.background = s.color;
    }
    setText(nm, s.name);
    setText(gapEl, gap);
    setClass(gapEl, `gap num${gk ? ` ${gk}` : ""}`);
    // タイヤ: 色の丸 (自分は減りの輪も)・破裂は赤い「!」。前のサーバーで分からなければ空き。中身が変わったときだけ作り直す
    const tk = s.burst ? "!" : s.tire ? `${s.tire}|${s.wear === null ? "" : Math.round(s.wear * 100)}|${s.tyreLaps ?? ""}` : "";
    if (tyreEl.dataset.k !== tk) {
      let tyre: HTMLElement;
      if (s.burst) tyre = el("span", { class: "tire-badge burst", title: "タイヤが破裂" }, "!");
      else if (s.tire) {
        tyre = tireBadge(s.tire, s.wear ?? undefined);
        tyre.title = `${TIRE_DEFS[s.tire].name}${s.tyreLaps !== null ? ` ${s.tyreLaps} 周` : ""}`;
      } else tyre = el("span", { class: "tw-none" });
      tyre.dataset.k = tk;
      tyreEl.replaceWith(tyre);
    }
    setText(tl, s.tire && s.tyreLaps !== null ? String(s.tyreLaps) : "");
    const stops = s.pitStops ?? 0;
    const pk = s.pitStops === null ? "-" : String(stops);
    if (pips.dataset.k !== pk) {
      pips.dataset.k = pk;
      pips.title = s.pitStops === null ? "" : `ピット ${stops} 回`;
      pips.replaceChildren();
      if (stops > 3) pips.append(el("b", { class: "num" }, String(stops)));
      else for (let k = 0; k < stops; k++) pips.append(el("i"));
    }
  }

  /** 計器の上の大きな表示: レースは前と後ろの車との差 (▲ 開いた・▼ 縮んだ)、練習は幽霊との差。札は残して字だけ変える */
  private renderDuel(st: Row[], t: number) {
    const box = this.h.duel;
    const want: HTMLElement[] = [];
    if (!this.o.laps) {
      const gg = this.ghostGap(t);
      if (gg) {
        const { d, e } = gg;
        const card = this.duelSlot("ghost", `${e.label}|${e.color ?? ""}`, () => {
          const name = e.label ? el("span", { class: "gn", style: e.color ? `--gc:${e.color}` : "" }, e.label) : null;
          return el("div", { class: `dl ghost${name ? " named" : ""}` }, el("span", { class: "dk" }, "GHOST", name), el("span", { class: "dv num" }, ""));
        });
        setClass(card, `dl ghost ${d < 0 ? "good" : "bad"}${e.label ? " named" : ""}`);
        setText(card.querySelector<HTMLElement>(".dv")!, `${d < 0 ? "−" : "+"}${formatSec(d)}`);
        want.push(card);
      }
    } else {
      const mi = st.findIndex((s) => s.me);
      const me = st[mi];
      const live = (s: Row | undefined) => !!s && !s.retired && !s.finished;
      if (me && live(me) && this.car?.started) {
        const a = st[mi - 1];
        const b = st[mi + 1];
        if (a && !a.retired) {
          const g = this.gapOf(a, me);
          if (g?.kind === "time") this.trendAhead.push(a.id, t, g.sec);
          want.push(this.duelCard("AHEAD", mi, a, g, this.trendAhead.delta(), false));
        }
        if (live(b)) {
          const g = this.gapOf(me, b!);
          if (g?.kind === "time") this.trendBehind.push(b!.id, t, g.sec);
          want.push(this.duelCard("BEHIND", mi + 2, b!, g, this.trendBehind.delta(), true));
        }
      }
    }
    const disp = want.length ? "" : "none";
    if (box.style.display !== disp) box.style.display = disp;
    const kids = box.children;
    if (kids.length !== want.length || want.some((c, i) => kids[i] !== c)) box.replaceChildren(...want);
  }

  /** 前後の札の入れ物 (種類と相手が同じなら同じ要素) */
  private duelCards = new Map<string, { key: string; el: HTMLElement }>();
  private duelSlot(kind: string, key: string, make: () => HTMLElement): HTMLElement {
    const cur = this.duelCards.get(kind);
    if (cur && cur.key === key) return cur.el;
    const e = make();
    this.duelCards.set(kind, { key, el: e });
    return e;
  }

  private duelCard(label: string, pos: number, s: Row, g: Gap, delta: number, behind: boolean): HTMLElement {
    // 差が縮む: 前の車なら 追いついている (緑)、後ろの車なら 追われている (赤)
    const shrink = delta < 0;
    const good = delta === 0 ? "" : shrink !== behind ? " good" : " bad";
    const arrow = delta === 0 ? "" : `${shrink ? "▼" : "▲"}${Math.abs(delta).toFixed(1)}`;
    const v = !g ? "—" : g.kind === "laps" ? `${g.laps} 周` : formatSec(g.sec);
    const card = this.duelSlot(label, `${s.id}|${s.color}|${s.name}|${s.tire ?? ""}`, () =>
      el(
        "div",
        { class: "dl" },
        el("span", { class: "dk" }, label),
        el("span", { class: "dp num" }),
        el("span", { class: "bar", style: `background:${s.color}` }),
        el("span", { class: "dn" }, s.name),
        s.tire ? tireBadge(s.tire) : el("span", { class: "tw-none" }),
        el("span", { class: "dv num" }),
        el("span", { class: "dt num" }),
      ),
    );
    setClass(card, `dl ${behind ? "behind" : "ahead"}${good}`);
    setText(card.querySelector<HTMLElement>(".dp")!, `P${pos}`);
    setText(card.querySelector<HTMLElement>(".dv")!, v);
    setText(card.querySelector<HTMLElement>(".dt")!, arrow);
    return card;
  }

  /** 一緒に走る幽霊 (練習の ghost + 1 周アタックの ghosts)。周の終わりがあるレースでは なし */
  private ghostList(): GhostEntry[] {
    if (this.o.laps) return [];
    const out: GhostEntry[] = [];
    if (this.o.ghost) out.push({ ghost: this.o.ghost, label: "" });
    if (this.o.ghosts) out.push(...this.o.ghosts);
    return out;
  }

  /**
   * 幽霊との差 (秒。− = 幽霊より速い)。周の道のりが幽霊の記録の中にあるときだけ。
   * いくつもいるときは「追いかけている幽霊」: すぐ前にいる幽霊 (差が + でいちばん小さい)。全部を抜いていたら、すぐ後ろの幽霊。
   * 抜くまで同じ幽霊と比べるので、札がちらちら入れかわらない。
   */
  private ghostGap(t: number): { d: number; e: GhostEntry } | null {
    const car = this.car;
    const list = this.ghostList();
    if (!list.length || !car || !car.started || car.pit || this.lap.finished) return null;
    const L = this.o.track.length;
    const lapDist = car.dist - this.lap.lapsDone * L;
    if (lapDist < 25 || lapDist > L) return null;
    let ahead: { d: number; e: GhostEntry } | null = null;
    let behind: { d: number; e: GhostEntry } | null = null;
    for (const e of list) {
      const g = e.ghost;
      let p = this.ghostProfs.get(g);
      if (p === undefined) {
        p = ghostProfile(this.o.track, g.pts, g.lap);
        this.ghostProfs.set(g, p);
      }
      if (!p) continue;
      const d = ghostDelta(p, t - this.lap.lapStart, lapDist);
      if (d === null) continue;
      if (d >= 0) {
        if (!ahead || d < ahead.d) ahead = { d, e };
      } else if (!behind || d > behind.d) behind = { d, e };
    }
    return ahead ?? behind;
  }

  /** オーバーテイクのボタン: 灰 = この周は使えない・縁 = 使える周だが今は使えない (旗のあと)・光る = 押せる・明るい = 使っている・目盛り = 残り */
  private paintOvertake(car: CarState) {
    const st = car.ot;
    const active = !!st?.active;
    const ready = !active && overtakeAvailable(car);
    const armed = !!st?.armed && (st.energy ?? 0) > 0;
    const key = active ? "active" : ready ? "ready" : armed ? "armed" : "off";
    setClass(this.h.ot, `ot-btn ${key}`);
    const g = overtakeGauge(car);
    const w = `${Math.round(g * 100)}%`;
    if (this.h.otFill.style.width !== w) this.h.otFill.style.width = w;
    setText(this.h.ot.lastElementChild as HTMLElement, active ? "BOOST" : ready ? "READY" : armed ? "WAIT" : "OFF");
  }

  /** 段と回転の目盛り (毎こま。マニュアルは変えどきで光り、回しきると赤) */
  private paintGearbox(car: CarState, stats: CarStats) {
    const v = carSpeed(car);
    const gear = this.manual ? (this.controls.gear() ?? 1) : idealGear(v, stats, 0);
    // マニュアルの回転はギア箱の部品の分も入れる (physics.ts と同じ数)
    const rpm = Math.min(1.02, rpmFraction(v, gear, stats, this.manual ? manualShiftBonus(stats, this.mtBonus) : 0));
    const shift = this.manual && gear < GEAR_COUNT && rpm >= SHIFT_RPM;
    const limit = this.manual && rpm >= 0.995;
    const pct = Math.round(Math.min(1, rpm) * 50) * 2;
    const key = `${gear}|${pct}|${shift ? 1 : 0}|${limit ? 1 : 0}`;
    if (key === this.gearKey) return;
    this.gearKey = key;
    setText(this.h.gear, String(gear));
    this.h.rpmFill.style.width = `${pct}%`;
    setClass(this.h.gearbox, `gearbox${this.manual ? " mt" : ""}${shift ? " shift" : ""}${limit ? " limit" : ""}`);
    this.h.gearbox.title = `${this.manual ? "マニュアル" : "オートマ"} ${gear} 速 · ${displayRpm(rpm)} rpm`;
  }

  /** DRS のボタン・旗の帯・傷みの図 (表示だけ) */
  private updateRaceRules(car: CarState, myId: string) {
    // DRS: 灰 = 使えない、緑の縁 = 次の区間で使える (前との差)、緑 = 今開ける、明るい緑 = 開いている
    const st = car.drs;
    const open = !!st?.open;
    const ready = !open && this.drsReady();
    const armed = !open && !ready && !!st && st.armed >= 0;
    // 検知の線を越えてから区間の終わりまでは、その線での前との差を出す (使えない差でも)
    const win = !open && !ready && !armed && !!st && !!this.flag?.drs && this.inDrsWindow(car);
    const drsKey = open ? "open" : ready ? "ready" : armed ? "armed" : win ? "no" : "off";
    setClass(this.h.drs, `drs-btn ${drsKey}`);
    const gapTxt = (g: number) => (Number.isFinite(g) ? `+${g.toFixed(1)}` : "前なし");
    setText(this.h.drsSt, open ? "OPEN" : ready ? "ZONE" : armed ? `${gapTxt(st!.gap)} → 可` : win ? `${gapTxt(st!.gap)} → 不可` : "OFF");
    this.paintOvertake(car);

    // 旗の帯: SC・VSC (速さの上限)・今いる区間の黄旗・自分の罰
    const f = this.flag;
    const sec = f ? sectorOf(this.o.track, car.dist) : -1;
    const yellowHere = !!f && f.yellow.includes(sec);
    const cap = f?.cap ? `${Math.round(f.cap * 3.6)} km/h` : "";
    const pen = f?.pen?.[myId] ?? 0;
    let kind = "";
    let tag = "";
    let text = "";
    let sub = "";
    if (f?.mode === "sc") {
      kind = "sc";
      tag = "SC";
      text = f.ending ? "SC IN THIS LAP" : "SAFETY CAR";
      // 上限 (cap) は列に追いつくための速さなので見せない。列の中なら先導車の速さ (5 km/h きざみ)、離れていれば「SC の後ろへ」
      const target = scTarget(f, myId, this.followMap()) ?? (f.sc ? { dist: f.sc.dist, v: f.sc.v } : null);
      const behind = target ? target.dist - car.dist : 0;
      const catching = !!target && behind > SC_GAP * 2.5;
      const scKmh = f.sc ? `SC ${Math.round((f.sc.v * 3.6) / 5) * 5} km/h` : "";
      sub = f.ending ? "この周で再開" : catching ? "SC の後ろへ · 自動で並ぶ" : `${scKmh ? `${scKmh} · ` : ""}自動で並ぶ`;
    } else if (f?.mode === "vsc") {
      kind = "vsc";
      tag = "VSC";
      text = f.ending ? "VSC ENDING" : "VIRTUAL SC";
      sub = f.ending ? "まもなく再開" : `${cap} まで · 追い越し禁止`;
    } else if (yellowHere) {
      kind = "yellow";
      tag = "⚑";
      text = `YELLOW S${sec + 1}`;
      sub = "追い越し禁止";
    }
    const key = `${kind}|${text}|${sub}|${pen}`;
    if (this.h.flagBar.dataset.k !== key) {
      this.h.flagBar.dataset.k = key;
      this.h.flagBar.innerHTML = "";
      this.h.flagBar.className = `flag-bar${kind ? ` ${kind}` : ""}`;
      if (kind) this.h.flagBar.append(el("b", { class: "tag" }, tag), el("span", { class: "tx" }, el("b", {}, text), el("small", {}, sub)));
      if (pen) this.h.flagBar.append(el("span", { class: "pen num" }, `罰 +${pen.toFixed(0)}s`));
      this.h.flagBar.style.display = kind || pen ? "" : "none";
    }

    // 傷みの図
    const parts = car.damage?.parts;
    const dk = parts ? parts.map((v) => (v >= DAMAGE_LOST ? "L" : v >= 1 ? "B" : String(Math.round(v * 4)))).join("") : "";
    if (dk !== this.dmgKey) {
      this.dmgKey = dk;
      this.drawDamage(parts ?? []);
      const n = damageCount(car);
      this.h.dmg.classList.toggle("hurt", n.damaged > 0);
      this.h.dmg.title = n.damaged ? `傷 ${n.damaged}${n.broken ? `・壊れ ${n.broken}` : ""}${n.lost ? `・落ち ${n.lost}` : ""}` : "傷なし";
    }
  }

  /** 上から見た小さな車: 部品を傷みで色分け (琥珀 = 傷んだ・赤 = 壊れた・点線 = 落ちた) */
  private drawDamage(parts: number[]) {
    const layout = this.o.me?.stats.layout;
    const c = this.h.dmg as HTMLCanvasElement;
    const W = 24;
    const H = 36;
    const d = this.dpr;
    c.width = Math.round(W * d);
    c.height = Math.round(H * d);
    const g = c.getContext("2d")!;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!layout || !layout.length) return;
    let x0 = Infinity;
    let x1 = -Infinity;
    let f0 = Infinity;
    let f1 = -Infinity;
    for (const q of layout) {
      x0 = Math.min(x0, q.lx - q.hx);
      x1 = Math.max(x1, q.lx + q.hx);
      f0 = Math.min(f0, q.lf - q.hf);
      f1 = Math.max(f1, q.lf + q.hf);
    }
    const sc = Math.min((W - 2) / (x1 - x0), (H - 2) / (f1 - f0));
    const ox = W / 2 - ((x0 + x1) / 2) * sc;
    const oy = H / 2 + ((f0 + f1) / 2) * sc;
    for (const q of layout) {
      const v = parts[q.index] ?? 0;
      const x = ox + (q.lx - q.hx) * sc + 0.5;
      const y = oy - (q.lf + q.hf) * sc + 0.5;
      const w = q.hx * 2 * sc - 1;
      const h = q.hf * 2 * sc - 1;
      if (v >= DAMAGE_LOST) {
        g.strokeStyle = "rgba(255,90,95,0.7)";
        g.lineWidth = 1;
        g.setLineDash([2, 2]);
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        g.setLineDash([]);
        continue;
      }
      g.fillStyle = v >= 1 ? "#ff3b3b" : v > 0.05 ? `rgba(255,170,30,${(0.55 + v * 0.45).toFixed(2)})` : "rgba(243,245,248,0.42)";
      g.fillRect(x, y, w, h);
    }
  }

  private fuelLapsLeft(): number {
    if (!this.car || !this.o.me) return 0;
    return this.car.fuel / Math.max(1e-9, fuelPerMeter(this.o.me.stats) * this.o.track.length);
  }

  private updateWeather(t: number) {
    const plan = this.o.weather;
    const wet = plan ? wetnessAt(plan, Math.max(0, t)) : 0;
    const sky = plan ? skyAt(plan, Math.max(0, t)) : "sun";
    const fc = plan ? forecastAt(plan, Math.max(0, t)).slice(0, 2) : [];
    const key = `${sky}|${Math.round(wet * 20)}|${fc.map((f) => f.text).join("/")}`;
    if (this.h.wx.dataset.k === key) return;
    this.h.wx.dataset.k = key;
    this.h.wx.innerHTML = "";
    this.h.wx.append(
      el("div", { class: "wx-now" }, el("span", { class: `sky ${sky}` }, SKY_NAMES[sky]), el("span", { class: "dim" }, skyLabel(wet).replace(/^\S+ /, ""))),
      el("div", { class: "wetbar" }, el("i", { style: `width:${Math.round(wet * 100)}%` })),
      ...fc.map((f) => el("div", { class: "fc" }, f.text)),
    );
  }

  // ---- ピット ----

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.key === "p" || e.key === "P") this.togglePit();
    else if (e.key === "e" || e.key === "E") this.pressDrs();
    else if (this.pitOpen && e.key === "Enter") this.bookPit();
    else if (this.pitOpen && e.key === "Escape") this.togglePit(false);
  };

  private togglePit(open = !this.pitOpen) {
    const car = this.car;
    if (!car || !this.o.me) return;
    this.pitOpen = open;
    if (open) {
      const o = car.pitOrder;
      if (o) {
        this.pitSelTire = o.tire ?? null;
        this.pitSelUsed = o.used ?? null;
        this.pitSelFuel = o.fuelTo === null || o.fuelTo === undefined ? "none" : o.fuelTo >= this.o.me.stats.fuelCap - 0.01 ? "full" : "race";
        this.pitSelRepair = !!o.repair;
      } else {
        this.pitSelRepair = damageCount(car).damaged > 0;
        const sug = this.suggestTire();
        this.pitSelTire = sug?.tire ?? null;
        this.pitSelUsed = sug?.used ?? null;
        this.pitSelFuel = this.fuelLapsLeft() < this.lapsLeft() + 0.3 ? "race" : "none";
      }
    }
    this.renderPitPanel();
  }

  /** 残りの周 (練習は 5 周とみる) */
  private lapsLeft(): number {
    if (!this.car) return 0;
    if (!this.o.laps) return 5;
    return Math.max(0, this.o.laps - this.car.dist / this.o.track.length);
  }

  /** ピットの札を開いたときに選んでおくタイヤ。持っている組の決まりがあれば、その中から (なければ替えない = null) */
  private suggestTire(): { tire: TireCompound; used: number | null } | null {
    const car = this.car!;
    const t = this.o.clock();
    const soon = this.o.weather ? Math.max(wetnessAt(this.o.weather, t), wetnessAt(this.o.weather, t + 60) * 0.9) : 0;
    const best = bestTireFor(soon);
    const want: TireCompound = !TIRE_DEFS[best].slick ? best : !TIRE_DEFS[car.tire].slick ? "M" : car.tire;
    if (!car.sets) return { tire: want, used: null };
    const p = pickFromSets(car.sets, want, 1);
    return p ? { tire: p.tire, used: p.used ?? null } : null;
  }

  private fuelTarget(mode: PitFuel): number | null {
    if (!this.o.me || mode === "none") return null;
    if (mode === "full") return this.o.me.stats.fuelCap;
    const need = fuelPerMeter(this.o.me.stats) * (this.lapsLeft() * this.o.track.length + 100) * 1.1 + 1;
    return Math.min(this.o.me.stats.fuelCap, need);
  }

  private bookPit() {
    const car = this.car;
    if (!car) return;
    requestPit(car, { tire: this.pitSelTire, used: this.pitSelTire ? this.pitSelUsed : null, fuelTo: this.fuelTarget(this.pitSelFuel), repair: this.pitSelRepair });
    if (!car.pit) this.toast("ピットを予約しました。入り口で自動で入ります", 2200);
    else this.toast("作業の内容を変えました", 1500);
    this.renderPitPanel();
  }

  private renderPitPanel() {
    const panel = this.h.pitPanel;
    panel.style.display = this.pitOpen ? "block" : "none";
    this.h.hud.classList.toggle("pit-open", this.pitOpen);
    if (!this.pitOpen || !this.car || !this.o.me) return;
    const car = this.car;
    panel.innerHTML = "";
    const tires = el("div", { class: "pp-tires" });
    const none = el("button", { class: `pp-t${this.pitSelTire === null ? " on" : ""}` }, el("span", { class: "tire-badge none" }, "–"), el("span", { class: "nm" }, "替えない"));
    none.addEventListener("click", () => {
      this.pitSelTire = null;
      this.pitSelUsed = null;
      this.renderPitPanel();
    });
    tires.append(none);
    if (car.sets) {
      // 持っている組だけ: 新品 (種類ごとに数) と、使った組 (残り %)
      const opts = setOptions(car.sets);
      for (const op of opts) {
        const on = this.pitSelTire === op.tire && (this.pitSelUsed ?? null) === op.used;
        const b = el(
          "button",
          { class: `pp-t${on ? " on" : ""}${op.used === null ? "" : " used"}`, title: `${TIRE_DEFS[op.tire].name} ${op.used === null ? "新品" : `使った組 残り ${Math.round((1 - op.wear) * 100)}%`}` },
          tireBadge(op.tire, op.wear),
          el("span", { class: "nm" }, op.used === null ? `新品 ×${op.count}` : `残り ${Math.round((1 - op.wear) * 100)}%`),
        );
        b.addEventListener("click", () => {
          this.pitSelTire = op.tire;
          this.pitSelUsed = op.used;
          this.renderPitPanel();
        });
        tires.append(b);
      }
      if (!opts.length) tires.append(el("div", { class: "pp-nosets" }, "替えのタイヤはもうない"));
    } else {
      for (const c of TIRE_ORDER) {
        const b = el("button", { class: `pp-t${this.pitSelTire === c ? " on" : ""}` }, tireBadge(c), el("span", { class: "nm" }, TIRE_DEFS[c].name));
        b.addEventListener("click", () => {
          this.pitSelTire = c;
          this.pitSelUsed = null;
          this.renderPitPanel();
        });
        tires.append(b);
      }
    }
    const fuels = el("div", { class: "pp-fuel" });
    const fopts: Array<[PitFuel, string]> = [
      ["none", "入れない"],
      ["race", this.o.laps ? "残りの分" : "5 周分"],
      ["full", "満タン"],
    ];
    for (const [m, label] of fopts) {
      const target = this.fuelTarget(m);
      const add = target === null ? 0 : Math.max(0, target - car.fuel);
      const b = el("button", { class: this.pitSelFuel === m ? "on" : "" }, el("b", {}, label), el("span", { class: "num" }, m === "none" ? "" : `+${add.toFixed(1)} L`));
      b.addEventListener("click", () => {
        this.pitSelFuel = m;
        this.renderPitPanel();
      });
      fuels.append(b);
    }
    // 修理: 傷があれば「直す」を選べる。かかる秒を見せる
    const rsec = repairTime(car);
    const dc = damageCount(car);
    const fix = el(
      "button",
      { class: `pp-fix${this.pitSelRepair && rsec > 0 ? " on" : ""}` },
      el("b", {}, rsec > 0 ? "直す" : "傷なし"),
      el("span", { class: "num" }, rsec > 0 ? `${rsec.toFixed(1)} 秒` : ""),
    );
    if (rsec > 0) fix.title = `傷 ${dc.damaged}${dc.broken ? `・壊れ ${dc.broken}` : ""}${dc.lost ? `・落ち ${dc.lost}` : ""}`;
    else (fix as HTMLButtonElement).disabled = true;
    fix.addEventListener("click", () => {
      this.pitSelRepair = !this.pitSelRepair;
      this.renderPitPanel();
    });
    const order = { tire: this.pitSelTire, used: this.pitSelUsed, fuelTo: this.fuelTarget(this.pitSelFuel), repair: this.pitSelRepair && rsec > 0 };
    const secs = serviceTime(car, this.o.me.stats, order);
    const booked = !!car.pitOrder;
    const book = el("button", { class: "go" }, car.pit ? "内容を変える" : booked ? "予約を変える" : "ピットを予約");
    book.addEventListener("click", () => this.bookPit());
    const cancel = el("button", {}, "取り消す");
    cancel.addEventListener("click", () => {
      if (cancelPit(car)) this.toast("ピットの予約を取り消しました", 1500);
      else this.toast("もう入り口を越えたので取り消せません", 1800);
      this.renderPitPanel();
    });
    if (!booked || car.pit) (cancel as HTMLButtonElement).disabled = true;
    const close = el("button", { class: "ghost" }, "閉じる");
    close.addEventListener("click", () => this.togglePit(false));
    this.h.pitStatus = el("div", { class: "pp-status" });
    panel.append(
      el(
        "div",
        { class: "pp-head" },
        el("b", {}, "PIT STOP"),
        el("span", { class: "pp-secs" }, el("small", {}, "作業 約"), el("span", { class: "num" }, secs.toFixed(1)), el("small", {}, "秒")),
      ),
      this.h.pitStatus,
      el(
        "div",
        { class: "pp-body" },
        el("div", {}, el("div", { class: "pp-k" }, car.sets ? "タイヤ (持っている組)" : "タイヤ"), tires),
        el("div", { class: "pp-row2" }, el("div", {}, el("div", { class: "pp-k" }, "燃料"), fuels), el("div", {}, el("div", { class: "pp-k" }, "修理"), fix)),
      ),
      el("div", { class: "pp-actions" }, book, cancel, close),
    );
    this.updatePitStatus();
  }

  private updatePitStatus() {
    const car = this.car;
    const s = this.h.pitStatus;
    if (!car || !s) return;
    const ph = car.pit?.phase;
    s.textContent =
      ph === "in"
        ? "ピットの道を走っています (制限速度で自動)"
        : ph === "box"
          ? `作業中 あと ${Math.max(0, car.pit!.service - car.pit!.elapsed).toFixed(1)} 秒 (まだ内容を変えられます)`
          : ph === "out"
            ? "出口へ向かっています"
            : car.pitOrder
              ? "予約済み: 次にピットの入り口を通ると入ります"
              : "予約すると、次にピットの入り口を通るとき自動で入ります";
  }

  /** ピットの出入りとタイヤのようすを見て、知らせる */
  private watchPit(car: CarState) {
    const ph = car.pit?.phase ?? null;
    if (ph !== this.prevPitPhase) {
      if (ph === "in" && !this.prevPitPhase) this.toast("ピットに入ります", 1500);
      if (ph === "out" && this.prevPitPhase === "box") this.toast(`作業おわり → ${TIRE_DEFS[car.tire].name}・燃料 ${car.fuel.toFixed(1)} L`, 2500);
      if (!ph && this.prevPitPhase) {
        this.toast("コースに戻りました", 1500);
        this.warnedWear = false;
        if (this.pitOpen) this.togglePit(false);
      }
      this.prevPitPhase = ph;
      if (this.pitOpen) this.renderPitPanel();
    }
    if (car.burst && !this.prevBurst) {
      this.big("タイヤが破裂!", 2500);
      this.toast("ゆっくりピットへ。PIT を押して予約", 3500);
    }
    this.prevBurst = car.burst;
    if (!this.warnedWear && car.wear > 0.75 && !car.burst) {
      this.warnedWear = true;
      this.toast("タイヤがすり減ってきました", 2200);
    }
  }

  private render(t: number) {
    const ctx = this.canvas.getContext("2d")!;
    const p = palette();
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const track = this.o.track;
    const paths = trackPaths(track);
    const plan = this.o.weather;
    const tw = Math.max(0, t);
    const wet = plan ? wetnessAt(plan, tw) : 0;
    const sky = plan ? skyAt(plan, tw) : "sun";

    // カメラ: 自分の車 (観戦は先頭) を追い、車の向きに合わせて回す
    let tx = this.camX;
    let ty = this.camY;
    let th = this.camH;
    let speed = 0;
    if (this.car) {
      tx = this.car.x;
      ty = this.car.y;
      th = this.car.heading;
      speed = carSpeed(this.car);
    } else {
      const lead = this.standings()[0];
      const o = lead ? this.others.get(lead.id) : undefined;
      const pose = o ? this.otherPose(o) : null;
      if (pose) {
        tx = pose.x;
        ty = pose.y;
        th = pose.h;
      } else {
        tx = track.px[0];
        ty = track.py[0];
        th = Math.atan2(track.ty[0], track.tx[0]);
      }
    }
    this.camX += (tx - this.camX) * 0.3;
    this.camY += (ty - this.camY) * 0.3;
    let dh = th - this.camH;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    this.camH += dh * 0.12;

    const cam = cameraFor(w, h, speed);
    const ppm = cam.ppm;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h * cam.anchor);
    ctx.rotate(-Math.PI / 2 - this.camH);
    ctx.scale(ppm, ppm);
    ctx.translate(-this.camX, -this.camY);

    // 壁の外: 暗い芝 (細かい模様)・スタートの直線のガレージ前と観客席・タイヤの防護壁
    {
      const r = Math.hypot(w, h) / ppm;
      ctx.fillStyle = this.outerPattern(ctx);
      ctx.fillRect(this.camX - r, this.camY - r, r * 2, r * 2);
      ctx.fillStyle = C.apron;
      ctx.fill(paths.apron);
      ctx.strokeStyle = C.garageLine;
      ctx.lineWidth = 0.25;
      ctx.stroke(paths.garages);
      ctx.fillStyle = C.stands;
      ctx.fill(paths.stands);
      ctx.strokeStyle = C.standRow;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([0.7, 0.5]);
      ctx.stroke(paths.standRows);
      ctx.setLineDash([]);
      ctx.lineJoin = "round";
      ctx.strokeStyle = C.tyreA;
      ctx.lineWidth = 1.3;
      ctx.stroke(paths.barrier);
      ctx.strokeStyle = C.tyreB;
      ctx.lineWidth = 0.75;
      ctx.setLineDash([0.65, 0.65]);
      ctx.stroke(paths.barrier);
      ctx.setLineDash([]);
    }

    // 芝 (壁の内側)。刈ったあとの縞
    ctx.fillStyle = this.grassPattern(ctx);
    ctx.fill(paths.runoff, "evenodd");
    // ピットの道: 白い縁 + 道 + 真ん中の点線
    ctx.lineJoin = "round";
    ctx.strokeStyle = C.pitEdge;
    ctx.lineWidth = 6.3;
    ctx.stroke(paths.pitLane);
    ctx.strokeStyle = C.pitLane;
    ctx.lineWidth = 5.7;
    ctx.stroke(paths.pitLane);
    ctx.strokeStyle = "rgba(255,210,31,0.35)";
    ctx.lineWidth = 0.18;
    ctx.setLineDash([1.6, 1.6]);
    ctx.stroke(paths.pitLane);
    ctx.setLineDash([]);
    {
      // 止まる場所: 黄色の枠と、うすい黄色の床
      const b = paths.pitBox;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.heading);
      ctx.fillStyle = C.pitBox;
      ctx.fillRect(-3, -1.8, 6, 3.6);
      ctx.strokeStyle = C.board;
      ctx.lineWidth = 0.25;
      ctx.strokeRect(-3, -1.8, 6, 3.6);
      ctx.fillStyle = C.board;
      ctx.fillRect(2.6, -1.8, 0.4, 3.6);
      ctx.restore();
    }
    // 道 + タイヤのゴムがついた走りの線
    ctx.fillStyle = C.asphalt;
    ctx.fill(paths.asphalt, "evenodd");
    ctx.strokeStyle = C.rubber;
    ctx.lineWidth = track.def.halfWidth * 0.55;
    ctx.stroke(paths.center);
    if (wet > 0.02) {
      // 濡れた道: 暗くして、真ん中に空の照り返し
      ctx.fillStyle = `${C.wet}${(wet * 0.45).toFixed(3)})`;
      ctx.fill(paths.asphalt, "evenodd");
      ctx.strokeStyle = `${C.sheen}${(wet * 0.07).toFixed(3)})`;
      ctx.lineWidth = track.def.halfWidth * 1.3;
      ctx.stroke(paths.center);
      ctx.strokeStyle = `${C.sheen}${(wet * 0.1).toFixed(3)})`;
      ctx.lineWidth = track.def.halfWidth * 0.35;
      ctx.stroke(paths.center);
      // 乾きかけ: みんなが走る線から先に乾く (physics.ts と同じ lineWetnessAt)。乾いた分だけ線の上の暗さを戻す
      const dryer = plan ? wet - lineWetnessAt(plan, tw) : 0;
      if (dryer > 0.02) {
        const a = Math.min(0.55, dryer * 0.5);
        ctx.strokeStyle = C.asphalt;
        ctx.lineCap = "round";
        ctx.globalAlpha = a * 0.6;
        ctx.lineWidth = (LINE_DRY_CORE + LINE_DRY_BAND * 0.6) * 2;
        ctx.stroke(racingLinePath(track));
        ctx.globalAlpha = a;
        ctx.lineWidth = LINE_DRY_CORE * 2;
        ctx.stroke(racingLinePath(track));
        ctx.globalAlpha = 1;
      }
    }
    // 水たまり
    const depth = puddleDepth(wet);
    if (depth > 0) {
      for (const pd of puddlesOf(track)) {
        const pt = pointAt(track, pd.s, pd.d);
        const rx = (pd.len / 2) * (0.6 + depth * 0.4);
        const ry = (pd.wide / 2) * (0.6 + depth * 0.4);
        ctx.fillStyle = `${C.puddle}${(0.15 + depth * 0.35).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(pt.x, pt.y, rx, ry, pt.heading, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `${C.sheen}${(0.1 + depth * 0.2).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(pt.x, pt.y, rx * 0.55, ry * 0.3, pt.heading, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 縁石
    ctx.fillStyle = C.kerbWhite;
    ctx.fill(paths.kerbA);
    ctx.fillStyle = C.kerbRed;
    ctx.fill(paths.kerbB);
    // 滑ったあと
    if (this.skidN) {
      ctx.strokeStyle = C.skid;
      ctx.lineWidth = 0.45;
      ctx.lineCap = "round";
      ctx.beginPath();
      const n = Math.min(this.skidN, SKID_MAX);
      for (let i = 0; i < n; i++) {
        const k = i * 4;
        ctx.moveTo(this.skids[k], this.skids[k + 1]);
        ctx.lineTo(this.skids[k + 2], this.skids[k + 3]);
      }
      ctx.stroke();
    }
    // 白線・壁
    ctx.strokeStyle = C.paint;
    ctx.lineWidth = 0.28;
    ctx.stroke(paths.edges);
    ctx.strokeStyle = C.wall;
    ctx.lineWidth = 0.7;
    ctx.stroke(paths.walls);
    ctx.strokeStyle = C.wall2;
    ctx.lineWidth = 0.35;
    ctx.stroke(paths.walls2);
    // ブレーキの目安の板 (字は あとで画面の座標で)
    for (const b of paths.boardMarks) {
      if (Math.abs(b.x - this.camX) > 120 || Math.abs(b.y - this.camY) > 120) continue;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.heading);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(-0.75, -1.45, 1.7, 3.1);
      ctx.fillStyle = C.boardFace;
      ctx.fillRect(-0.85, -1.55, 1.7, 3.1);
      ctx.fillStyle = C.board;
      ctx.fillRect(-0.85, -1.55, 0.35, 3.1);
      ctx.restore();
    }
    ctx.fillStyle = C.kerbWhite;
    ctx.fill(paths.startA);
    ctx.fillStyle = "#111";
    ctx.fill(paths.startB);
    ctx.strokeStyle = C.paint;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 0.22;
    ctx.stroke(paths.gridBoxes);
    ctx.globalAlpha = 1;
    // セクターの切れ目 (塗った線)
    ctx.fillStyle = C.sectorLine;
    ctx.fill(paths.sectorLines);
    // DRS: 区間の道の端 (使える・開いている区間は濃い緑)・検知の線 (点線)・始まりの線・終わりの線 (点線)
    {
      const st = this.car?.drs;
      ctx.lineJoin = "round";
      ctx.lineCap = "butt";
      paths.drs.forEach((z, k) => {
        const hot = !!st && st.armed === k;
        ctx.strokeStyle = hot ? DRS_GREEN : C.drsEdge;
        ctx.lineWidth = hot ? (st.open ? 0.7 : 0.5) : 0.3;
        ctx.stroke(z.edge);
        ctx.fillStyle = DRS_GREEN;
        ctx.fill(z.detect);
        ctx.fill(z.start);
        ctx.globalAlpha = 0.7;
        ctx.fill(z.end);
        ctx.globalAlpha = 1;
      });
    }

    // 雨の暗さは道までにかける (車にはかけない。大雨でも車が沈まないように)。雨の筋は最後に上から
    if (sky !== "sun") {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.renderRainShade(ctx, w, h, sky === "heavy" ? 1 : 0.45);
      ctx.restore();
    }

    // 幽霊 (練習・1 周アタック): 透けた車。形は ghostDesign (なし = 自分の設計図)
    const ghostTags: Array<{ x: number; y: number; text: string; color: string }> = [];
    if (this.car && this.car.started && this.o.me) {
      const k = Math.floor((t - this.lap.lapStart) / 0.1) * 3;
      const shape = this.o.ghostDesign ?? this.o.me.info.design;
      for (const { ghost, label, color } of this.ghostList()) {
        if (k < 0 || k + 2 >= ghost.pts.length) continue;
        const [gx, gy, gh] = [ghost.pts[k], ghost.pts[k + 1], ghost.pts[k + 2]];
        ctx.globalAlpha = 0.35;
        drawCarWorld(ctx, shape, gx, gy, gh, color ? { line: color, fill: p.paper, accent: color } : { line: p.ink, fill: p.paper, accent: p.dim }, ppm);
        ctx.globalAlpha = 1;
        if (label) ghostTags.push({ x: gx, y: gy, text: label, color: color ?? p.ink });
      }
    }

    // ほかの車の位置
    const poses: Array<{ o: Other; pose: Pose }> = [];
    for (const o of this.others.values()) {
      const pose = this.otherPose(o);
      if (pose) poses.push({ o, pose });
    }
    // 濡れた道の水しぶき (車の後ろ)
    if (wet > 0.2) {
      for (const { o, pose } of poses) if (!(pose.flags & (F_FIN | F_RET))) this.drawSpray(ctx, pose.x, pose.y, pose.h, Math.hypot(pose.vx, pose.vy), o.stats.length, o.stats.width, wet);
      if (this.car && this.o.me) this.drawSpray(ctx, this.car.x, this.car.y, this.car.heading, speed, this.o.me.stats.length, this.o.me.stats.width, wet);
    }
    // ほかの車
    const labels: Array<{ x: number; y: number; text: string; color: string; pos: number; flags: number }> = [];
    for (const { o, pose } of poses) {
      const ink: Ink = { line: o.info.color, fill: "#07080b", accent: o.info.color };
      ctx.globalAlpha = pose.flags & (F_FIN | F_RET) ? 0.4 : 1;
      drawCarWorld(ctx, o.info.design, pose.x, pose.y, pose.h, ink, ppm);
      ctx.globalAlpha = 1;
      labels.push({ x: pose.x, y: pose.y, text: o.info.name, color: o.info.color, pos: this.posMap.get(o.info.id) ?? 0, flags: pose.flags });
    }
    // 先導車 (SC): 銀の車体に琥珀の光の棒
    let scAt: { x: number; y: number } | null = null;
    if (this.flag?.sc) {
      const L = track.length;
      const q = pointAt(track, ((this.flag.sc.dist % L) + L) % L, 0);
      scAt = { x: q.x, y: q.y };
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(q.heading);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(-2.3, -0.85, 4.8, 1.9);
      ctx.fillStyle = "#d9dde3";
      ctx.beginPath();
      ctx.roundRect(-2.4, -0.95, 4.8, 1.9, 0.6);
      ctx.fill();
      ctx.fillStyle = "#1b1e25";
      ctx.fillRect(0.4, -0.75, 0.9, 1.5);
      ctx.fillRect(-1.6, -0.7, 0.6, 1.4);
      const blink = Math.floor(performance.now() / 250) % 2;
      ctx.fillStyle = blink ? "#ffb21f" : "#6b4a00";
      ctx.fillRect(-0.5, -0.8, 0.45, 0.8);
      ctx.fillStyle = blink ? "#6b4a00" : "#ffb21f";
      ctx.fillRect(-0.5, 0, 0.45, 0.8);
      ctx.restore();
    }
    // 自分の車
    if (this.car && this.o.me) {
      drawCarWorld(ctx, this.o.me.info.design, this.car.x, this.car.y, this.car.heading, { line: p.ink, fill: p.paper2, accent: this.o.me.info.color }, ppm, { outline: p.ink, glow: sky === "sun" ? "rgba(255,255,255,0.35)" : C.rainGlow });
    }
    // 火花
    const nowMs = performance.now();
    this.sparks = this.sparks.filter((s) => nowMs - s.t < 350);
    for (const s of this.sparks) {
      const a = 1 - (nowMs - s.t) / 350;
      ctx.strokeStyle = "#ffb347";
      ctx.globalAlpha = a;
      ctx.lineWidth = 2 / ppm;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2 + s.t;
        const r0 = 0.6 + (1 - a) * 1.5;
        ctx.moveTo(s.x + Math.cos(ang) * r0, s.y + Math.sin(ang) * r0);
        ctx.lineTo(s.x + Math.cos(ang) * (r0 + 1), s.y + Math.sin(ang) * (r0 + 1));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const m = ctx.getTransform();
    ctx.restore();

    // 文字は画面の座標で (回らない)
    const toScreen = (x: number, y: number) => {
      const pt = m.transformPoint(new DOMPoint(x, y));
      return [pt.x / this.dpr, pt.y / this.dpr];
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "italic 700 13px 'Barlow Condensed', sans-serif";
    for (const c of paths.corners) {
      const [sx, sy] = toScreen(c.x, c.y);
      if (sx < -30 || sy < -30 || sx > w + 30 || sy > h + 30) continue;
      ctx.fillStyle = "rgba(255,255,255,0.32)";
      ctx.fillText(c.label, sx, sy);
    }
    {
      const [sx, sy] = toScreen(paths.pitBox.x, paths.pitBox.y);
      if (sx > -30 && sy > -30 && sx < w + 30 && sy < h + 30) {
        ctx.fillStyle = C.board;
        ctx.fillText("PIT", sx, sy);
      }
    }
    // ブレーキの目安の板の字 (100 / 50)。板が小さすぎる (遠い・狭い画面) ときは字を省く
    if (ppm >= 6) {
      ctx.font = `italic 800 ${Math.round(Math.min(12, Math.max(9, ppm * 0.95)))}px 'Barlow Condensed', sans-serif`;
      ctx.fillStyle = C.boardInk;
      for (const b of paths.boardMarks) {
        const [sx, sy] = toScreen(b.x, b.y);
        if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
        ctx.fillText(b.label, sx, sy + 0.5);
      }
    }
    // セクターと DRS の札 (画面の座標の小さな札。回らない)
    ctx.font = "italic 800 11px 'Barlow Condensed', sans-serif";
    for (const mk of paths.sectorMarks) {
      const [sx, sy] = toScreen(mk.x, mk.y);
      if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue;
      const a = `S${mk.k + 1}`;
      const b2 = `S${mk.k + 2}`;
      const wa = ctx.measureText(a).width;
      const wb = ctx.measureText(b2).width;
      const bw = wa + wb + 22;
      const x0 = Math.round(sx - bw / 2);
      const y0 = Math.round(sy - 8);
      ctx.fillStyle = C.markBg;
      ctx.fillRect(x0, y0, bw, 16);
      ctx.fillStyle = SECTOR_TINTS[mk.k];
      ctx.fillRect(x0, y0, bw / 2, 2);
      ctx.fillStyle = SECTOR_TINTS[mk.k + 1];
      ctx.fillRect(x0 + bw / 2, y0, bw / 2, 2);
      ctx.textAlign = "left";
      ctx.fillStyle = SECTOR_TINTS[mk.k];
      ctx.fillText(a, x0 + 5, y0 + 9);
      ctx.fillStyle = C.markDim;
      ctx.fillRect(x0 + 5 + wa + 5, y0 + 5, 1, 8);
      ctx.fillStyle = SECTOR_TINTS[mk.k + 1];
      ctx.fillText(b2, x0 + 5 + wa + 11, y0 + 9);
      ctx.textAlign = "center";
    }
    for (const z of paths.drs) {
      for (const mk of z.marks) {
        const [sx, sy] = toScreen(mk.x, mk.y);
        if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) continue;
        const text = mk.kind === "detect" ? "DRS DETECT" : mk.kind === "start" ? "DRS" : "DRS END";
        const bw = ctx.measureText(text).width + 12;
        const x0 = Math.round(sx - bw / 2);
        const y0 = Math.round(sy - 8);
        const solid = mk.kind === "start";
        ctx.fillStyle = solid ? DRS_GREEN : C.markBg;
        ctx.fillRect(x0, y0, bw, 16);
        if (!solid) {
          ctx.strokeStyle = DRS_GREEN;
          ctx.lineWidth = 1;
          ctx.setLineDash(mk.kind === "detect" ? [3, 2] : []);
          ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw - 1, 15);
          ctx.setLineDash([]);
        }
        ctx.fillStyle = solid ? "#04140b" : DRS_GREEN;
        ctx.fillText(text, sx, y0 + 9);
        if (mk.kind === "end") {
          // 終わり: 字に斜めの線
          ctx.strokeStyle = DRS_GREEN;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x0 + 3, y0 + 13);
          ctx.lineTo(x0 + bw - 3, y0 + 3);
          ctx.stroke();
        }
      }
    }
    // 自分の車のまわり (画面の座標)。名札がかぶったら車の下にずらし、それでもかぶるなら薄くする
    const meBox = this.car && this.o.me ? (() => {
      const [mx, my] = toScreen(this.car!.x, this.car!.y);
      const r = Math.max(12, (this.o.me!.stats.length * ppm) / 2 + 4);
      return { x0: mx - r, y0: my - r, x1: mx + r, y1: my + r };
    })() : null;
    const hitsMe = (x0: number, y0: number, x1: number, y1: number) => !!meBox && x0 < meBox.x1 && x1 > meBox.x0 && y0 < meBox.y1 && y1 > meBox.y0;
    /** 名札の上の端 (ふつうは車の上、自分の車にかぶるなら車の下) と 濃さ */
    const tagPlace = (sx: number, sy: number, tw: number, th: number, above: number): { y0: number; below: boolean; alpha: number } => {
      const x0 = sx - tw / 2;
      const up = Math.round(sy - above);
      if (!hitsMe(x0, up, x0 + tw, sy - 8)) return { y0: up, below: false, alpha: 1 };
      const down = Math.round(sy + above - th);
      if (!hitsMe(x0, sy + 8, x0 + tw, down + th)) return { y0: down, below: true, alpha: 1 };
      return { y0: up, below: false, alpha: TAG_FADE };
    };
    // 幽霊の名札: 小さく透けた札 (色の帯 + 名前)。本物の車の名札より控えめに
    ctx.font = "600 10px 'Noto Sans JP', sans-serif";
    for (const l of ghostTags) {
      const [sx, sy] = toScreen(l.x, l.y);
      if (sx < -60 || sy < -60 || sx > w + 60 || sy > h + 60) continue;
      const tw2 = 3 + 6 + ctx.measureText(l.text).width + 10;
      const th2 = 15;
      const x0 = Math.round(sx - tw2 / 2);
      const tp = tagPlace(sx, sy, tw2, th2, 36);
      const y0 = tp.y0;
      ctx.globalAlpha = 0.72 * tp.alpha;
      ctx.fillStyle = C.tagBg;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + tw2, y0);
      ctx.lineTo(x0 + tw2 - 5, y0 + th2);
      ctx.lineTo(x0, y0 + th2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = l.color;
      ctx.fillRect(x0, y0, 3, th2);
      ctx.fillRect(Math.round(sx) - 1, tp.below ? y0 - 5 : y0 + th2, 2, 5);
      ctx.fillStyle = C.tagInk;
      ctx.textAlign = "left";
      ctx.fillText(l.text, x0 + 3 + 5, y0 + th2 / 2 + 0.5);
      ctx.textAlign = "center";
      ctx.globalAlpha = 1;
    }
    // 名札: 白い順位の四角 + チームの色の帯 + 名前 (右の角を斜めに切る)
    for (const l of labels) {
      const [sx, sy] = toScreen(l.x, l.y);
      if (sx < -60 || sy < -60 || sx > w + 60 || sy > h + 60) continue;
      ctx.font = "600 11px 'Noto Sans JP', sans-serif";
      const nw = ctx.measureText(l.text).width;
      const bw = 19;
      const th2 = 18;
      const tw2 = bw + 4 + nw + 14;
      const x0 = Math.round(sx - tw2 / 2);
      const tp = tagPlace(sx, sy, tw2, th2, 44);
      const y0 = tp.y0;
      ctx.globalAlpha = tp.alpha;
      ctx.fillStyle = C.tagBg;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + tw2, y0);
      ctx.lineTo(x0 + tw2 - 6, y0 + th2);
      ctx.lineTo(x0, y0 + th2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = C.tagInk;
      ctx.fillRect(x0, y0, bw, th2);
      ctx.fillStyle = l.color;
      ctx.fillRect(x0 + bw, y0, 4, th2);
      ctx.fillStyle = C.tagPos;
      ctx.font = "italic 800 13px 'Barlow Condensed', sans-serif";
      ctx.fillText(l.pos ? String(l.pos) : "", x0 + bw / 2, y0 + th2 / 2 + 0.5);
      ctx.fillStyle = C.tagInk;
      ctx.textAlign = "left";
      ctx.font = "600 11px 'Noto Sans JP', sans-serif";
      ctx.fillText(l.text, x0 + bw + 9, y0 + th2 / 2 + 0.5);
      ctx.textAlign = "center";
      // 車へ向かう小さな線
      ctx.fillStyle = l.color;
      ctx.fillRect(Math.round(sx) - 1, tp.below ? y0 - 6 : y0 + th2, 2, 6);
      // 札の右に小さな印: DRS が開いている (緑)・部品が壊れた / 落ちた (琥珀)
      let cx = x0 + tw2 - 2;
      ctx.font = "italic 800 11px 'Barlow Condensed', sans-serif";
      for (const [bit, label, bg, ink] of [
        [16, "DRS", "#22d37a", "#04140b"],
        [SNAP_OT, "OT", "#3fb7ff", "#021320"],
        [32, "!", "#ffaa1e", "#1a1000"],
      ] as const) {
        if (!(l.flags & bit)) continue;
        const cw = label.length > 1 ? 26 : 14;
        ctx.fillStyle = bg;
        ctx.fillRect(cx, y0 + 2, cw, th2 - 4);
        ctx.fillStyle = ink;
        ctx.fillText(label, cx + cw / 2, y0 + th2 / 2 + 0.5);
        cx += cw + 2;
      }
      ctx.globalAlpha = 1;
    }
    if (scAt) {
      const [sx, sy] = toScreen(scAt.x, scAt.y);
      if (sx > -40 && sy > -40 && sx < w + 40 && sy < h + 40) {
        ctx.fillStyle = C.board;
        ctx.beginPath();
        ctx.moveTo(sx - 15, sy - 40);
        ctx.lineTo(sx + 19, sy - 40);
        ctx.lineTo(sx + 15, sy - 24);
        ctx.lineTo(sx - 15, sy - 24);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(sx - 1, sy - 24, 2, 6);
        ctx.fillStyle = "#1a1400";
        ctx.font = "italic 800 13px 'Barlow Condensed', sans-serif";
        ctx.fillText("SC", sx + 1, sy - 31.5);
      }
    }

    // 雨の筋 (暗さは車の前にかけた)
    if (sky !== "sun") this.renderRain(ctx, w, h, sky === "heavy" ? 1 : 0.45, nowMs);

    this.renderMini(p);
  }

  /** 雨の暗さ: 大雨は空を暗くして、まわりを落とす (車を描く前に呼ぶ) */
  private renderRainShade(ctx: CanvasRenderingContext2D, w: number, h: number, k: number) {
    if (k > 0.8) {
      ctx.fillStyle = "rgba(8,14,26,0.28)";
      ctx.fillRect(0, 0, w, h);
      const g = ctx.createRadialGradient(w / 2, h * 0.6, Math.min(w, h) * 0.35, w / 2, h * 0.6, Math.max(w, h) * 0.8);
      g.addColorStop(0, "rgba(4,8,16,0)");
      g.addColorStop(1, "rgba(4,8,16,0.55)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = "rgba(14,22,36,0.1)";
      ctx.fillRect(0, 0, w, h);
    }
  }

  /** 雨の筋 (いちばん上に) */
  private renderRain(ctx: CanvasRenderingContext2D, w: number, h: number, k: number, nowMs: number) {
    const tt = nowMs / 1000;
    const wind = 0.22;
    // 遠い雨 (細く短く) と近い雨 (太く長く) の 2 段
    const layers: Array<[number, number, number, number]> = [
      // [本数, 長さ, 太さ, 濃さ]
      [Math.round(60 + k * 120), 10 + k * 6, 1, 0.14 + k * 0.12],
      [Math.round(14 + k * 40), 22 + k * 14, 1.6, 0.18 + k * 0.16],
    ];
    layers.forEach(([n, len, lw, a], li) => {
      ctx.strokeStyle = `${C.rain}${a.toFixed(2)})`;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.beginPath();
      const fall = li ? 900 : 560;
      for (let i = 0; i < n; i++) {
        const q = i + li * 1000;
        const a1 = Math.sin(q * 12.9898 + this.rainSeed) * 43758.5453;
        const r1 = a1 - Math.floor(a1);
        const b1 = Math.sin(q * 78.233 + this.rainSeed) * 12345.678;
        const r2 = b1 - Math.floor(b1);
        const v = fall * (0.8 + r1 * 0.4);
        const y = (r2 * (h + len) + tt * v) % (h + len) - len;
        const x = (((r1 * w - y * wind) % w) + w) % w;
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * wind, y + len);
      }
      ctx.stroke();
    });
  }

  private sprayImg: HTMLCanvasElement | null = null;

  /** 濡れた道の水しぶき: 後ろのタイヤから広がる白いもや (ぼかした丸の絵を重ねる) */
  private drawSpray(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, v: number, len: number, wide: number, wet: number) {
    if (v < 10) return;
    if (!this.sprayImg) {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      rg.addColorStop(0, `${C.spray}1)`);
      rg.addColorStop(0.45, `${C.spray}0.45)`);
      rg.addColorStop(1, `${C.spray}0)`);
      g.fillStyle = rg;
      g.fillRect(0, 0, 64, 64);
      this.sprayImg = c;
    }
    const k = Math.min(1, (v - 10) / 40) * Math.min(1, wet);
    const fx = Math.cos(heading);
    const fy = Math.sin(heading);
    const rx = -fy;
    const ry = fx;
    const back = len * 0.45;
    const prevA = ctx.globalAlpha;
    for (let i = 0; i < 7; i++) {
      const d = back + i * (0.8 + k * 0.9);
      const r = 0.8 + i * (0.3 + k * 0.4);
      const side = wide * 0.35 + i * 0.12;
      ctx.globalAlpha = prevA * k * 0.16 * (1 - i / 7);
      for (const sd of [-side, side]) {
        const cx = x - fx * d + rx * sd;
        const cy = y - fy * d + ry * sd;
        ctx.drawImage(this.sprayImg, cx - r, cy - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = prevA;
  }

  private grassPat: CanvasPattern | null = null;
  private outerPat: CanvasPattern | null = null;

  /** 壁の外の暗い芝: 細かいまだら (世界の座標で 6 m の繰り返し。1 度だけ作る) */
  private outerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
    if (!this.outerPat) {
      const c = document.createElement("canvas");
      c.width = c.height = 48;
      const g = c.getContext("2d")!;
      g.fillStyle = C.outer;
      g.fillRect(0, 0, 48, 48);
      // 決まった並びのまだら (乱数を使わない)
      for (let i = 0; i < 90; i++) {
        const a = Math.sin(i * 12.9898) * 43758.5453;
        const b = Math.sin(i * 78.233) * 12345.678;
        const x = (a - Math.floor(a)) * 48;
        const y = (b - Math.floor(b)) * 48;
        g.fillStyle = i % 3 ? C.outerSpeck : C.outerDark;
        g.fillRect(Math.floor(x), Math.floor(y), 2 + (i % 2), 1 + (i % 3 === 0 ? 1 : 0));
      }
      const pat = ctx.createPattern(c, "repeat");
      if (!pat) return C.outer;
      pat.setTransform(new DOMMatrix().scale(6 / 48));
      this.outerPat = pat;
    }
    return this.outerPat;
  }

  /** 芝の縞 (世界の座標で 7 m ごと) */
  private grassPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
    if (!this.grassPat) {
      const c = document.createElement("canvas");
      c.width = 8;
      c.height = 1;
      const g = c.getContext("2d")!;
      g.fillStyle = C.grass;
      g.fillRect(0, 0, 4, 1);
      g.fillStyle = C.grassStripe;
      g.fillRect(4, 0, 4, 1);
      const pat = ctx.createPattern(c, "repeat");
      if (!pat) return C.grass;
      pat.setTransform(new DOMMatrix().rotate(35).scale(1.75));
      this.grassPat = pat;
    }
    return this.grassPat;
  }

  private miniBase: HTMLCanvasElement | null = null;

  private renderMini(p: Palette) {
    const c = this.mini;
    const ctx = c.getContext("2d")!;
    const track = this.o.track;
    const b = trackPaths(track).bounds;
    const W = c.width;
    const H = c.height;
    const d = this.dpr;
    const pad = 9 * d;
    const sc = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxY - b.minY));
    const ox = (W - (b.maxX - b.minX) * sc) / 2 - b.minX * sc;
    const oy = (H - (b.maxY - b.minY) * sc) / 2 - b.minY * sc;
    // コースの絵は 1 度だけ描いておく。下: 太い影 + セクターごとの薄い色の線。上: DRS の区間 (緑)・セクターの切れ目の印・赤いスタートの棒
    const key = `${W}x${H}:${p.ink}`;
    const X = (x: number) => x * sc + ox;
    const Y = (y: number) => y * sc + oy;
    if (key !== this.miniKey || !this.miniBase || !this.miniTop) {
      this.miniKey = key;
      const L = track.length;
      // 道のり a..b の線 (地図の座標。点は多くても 1 周 400 ほどに間引く)
      const stepM = Math.max(track.step, L / 400);
      const line = (a: number, b: number) => {
        const path = new Path2D();
        for (let s = a; ; s += stepM) {
          const q = pointAt(track, (((Math.min(s, b) % L) + L) % L), 0);
          if (s === a) path.moveTo(X(q.x), Y(q.y));
          else path.lineTo(X(q.x), Y(q.y));
          if (s >= b) break;
        }
        return path;
      };
      const [s1, s2] = sectorSplitDistances(track);
      this.miniSec = [line(0, s1), line(s1, s2), line(s2, L)];
      this.miniDrs = drsZones(track).map((z) => line(z.start, z.end));
      const base = document.createElement("canvas");
      base.width = W;
      base.height = H;
      const g = base.getContext("2d")!;
      g.lineJoin = "round";
      g.beginPath();
      for (let i = 0; i <= track.n; i++) {
        const k = i % track.n;
        if (i === 0) g.moveTo(X(track.px[k]), Y(track.py[k]));
        else g.lineTo(X(track.px[k]), Y(track.py[k]));
      }
      g.closePath();
      g.strokeStyle = "rgba(255,255,255,0.09)";
      g.lineWidth = 7 * d;
      g.stroke();
      g.lineWidth = 2 * d;
      this.miniSec.forEach((path, k) => {
        g.strokeStyle = SECTOR_TINTS_SOFT[k];
        g.stroke(path);
      });
      this.miniBase = base;
      const top = document.createElement("canvas");
      top.width = W;
      top.height = H;
      const u = top.getContext("2d")!;
      u.lineJoin = "round";
      u.lineCap = "butt";
      u.strokeStyle = DRS_GREEN;
      u.lineWidth = 2.6 * d;
      u.globalAlpha = 0.85;
      for (const path of this.miniDrs) u.stroke(path);
      u.globalAlpha = 1;
      // 切れ目の印: 道に直角の短い白い線 (外に黒いふち)
      const tick = (s: number, color: string, half: number, wd: number) => {
        const q = pointAt(track, s, 0);
        const nx = -Math.sin(q.heading);
        const ny = Math.cos(q.heading);
        u.beginPath();
        u.moveTo(X(q.x) - nx * half * d, Y(q.y) - ny * half * d);
        u.lineTo(X(q.x) + nx * half * d, Y(q.y) + ny * half * d);
        u.strokeStyle = "rgba(8,10,14,0.9)";
        u.lineWidth = (wd + 1.5) * d;
        u.stroke();
        u.strokeStyle = color;
        u.lineWidth = wd * d;
        u.stroke();
      };
      tick(s1, p.ink, 4.5, 1.5);
      tick(s2, p.ink, 4.5, 1.5);
      tick(0, p.accent, 5.5, 2.5);
      this.miniTop = top;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.miniBase, 0, 0);
    // 今いるセクター: 濃い色で太く
    if (this.car) {
      const k = lapSectorAt(track, this.car.dist);
      ctx.lineJoin = "round";
      ctx.lineCap = "butt";
      ctx.strokeStyle = SECTOR_TINTS[k];
      ctx.lineWidth = 3.2 * d;
      ctx.stroke(this.miniSec[k]);
    }
    ctx.drawImage(this.miniTop, 0, 0);
    // 使える・開いている DRS の区間は明るく太く
    const dst = this.car?.drs;
    if (dst && dst.armed >= 0 && this.miniDrs[dst.armed]) {
      ctx.strokeStyle = dst.open ? "#8dffbf" : DRS_GREEN;
      ctx.lineWidth = 4 * d;
      ctx.stroke(this.miniDrs[dst.armed]);
    }
    const dot = (x: number, y: number, color: string, r: number, ring: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x * sc + ox, y * sc + oy, r * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ring;
      ctx.lineWidth = 1.5 * d;
      ctx.stroke();
    };
    for (const o of this.others.values()) {
      const pose = this.otherPose(o);
      if (pose) dot(pose.x, pose.y, o.info.color, 3, "rgba(8,10,14,0.9)");
    }
    // 黄旗の区間は黄色の線、先導車は琥珀の点
    const f = this.flag;
    if (f && f.yellow.length) {
      const L = track.length;
      ctx.strokeStyle = "#ffd21f";
      ctx.lineWidth = 3.5 * d;
      ctx.lineCap = "round";
      for (const k of f.yellow) {
        const s0 = (k / f.sectors) * L;
        const s1 = ((k + 1) / f.sectors) * L;
        ctx.beginPath();
        for (let s = s0; s <= s1 + 0.01; s += (s1 - s0) / 16) {
          const q = pointAt(track, Math.min(s, L - 0.01), 0);
          if (s === s0) ctx.moveTo(q.x * sc + ox, q.y * sc + oy);
          else ctx.lineTo(q.x * sc + ox, q.y * sc + oy);
        }
        ctx.stroke();
      }
    }
    if (f?.sc) {
      const L = track.length;
      const q = pointAt(track, ((f.sc.dist % L) + L) % L, 0);
      dot(q.x, q.y, "#ffb21f", 3.5, "#1a1400");
    }
    if (this.car) dot(this.car.x, this.car.y, this.o.me?.info.color ?? p.accent, 4.5, p.ink);
  }

  /** 音: 車の様子を読んで audio/ に渡すだけ (毎こま。新しいものを作らない) */
  private sound(t: number) {
    const f = this.snd.f;
    const car = this.car;
    f.me = !!car && !!this.o.me;
    if (car && this.o.me) {
      f.speed = carSpeed(car);
      f.top = this.o.me.stats.topSpeed;
      f.throttle = this.lastThrottle;
      f.brake = this.lastBrake;
      // マニュアルはエンジンの音を本当の段と回転で
      const g = this.manual ? this.controls.gear() : undefined;
      f.gear = g ?? 0;
      f.rpm = g ? rpmFraction(f.speed, g, this.o.me.stats, manualShiftBonus(this.o.me.stats, this.mtBonus)) : 0;
      f.slip = car.slip;
      f.surface = car.surface === "kerb" ? 1 : car.surface === "grass" ? 2 : 0;
      f.pit = !car.pit ? 0 : car.pit.phase === "box" ? 2 : 1;
      pitWork(car, this.o.me.stats, f);
    }
    const plan = this.o.weather;
    const sky = plan ? skyAt(plan, Math.max(0, t)) : "sun";
    f.rain = sky === "heavy" ? 1 : sky === "light" ? 0.45 : 0;
    f.wet = this.wet;
    f.camX = this.camX;
    f.camY = this.camY;
    f.camH = this.camH;
    f.count = 0;
    f.grow(this.others.size);
    this.others.forEach(this.soundOther);
    f.flag = flagLevel(this.flag?.mode, this.flag?.yellow.length ?? 0);
    f.finished = this.lap.finished;
    f.chequered = this.o.isChequered?.() ?? false;
    this.snd.frame(t, this.o.lightsStartT, this.radio?.visible ?? false, !!car?.drs?.open, !!car?.ot?.active);
  }

  private soundOther = (o: Other) => {
    const l = o.buf[o.buf.length - 1];
    if (!l || l.flags & F_RET) return;
    const f = this.snd.f;
    const i = f.count++;
    f.ox[i] = l.x;
    f.oy[i] = l.y;
    f.ospd[i] = Math.hypot(l.vx, l.vy);
    f.otop[i] = o.stats.topSpeed;
    f.oslip[i] = l.flags & F_PIT ? 0 : lateralSlip(l.vx, l.vy, l.h);
  };

  destroy() {
    this.snd.destroy();
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.controls.destroy();
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKey);
    this.radio?.destroy();
    this.o.root.innerHTML = "";
    this.o.root.classList.remove("race-root");
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function loadGapMode(): GapMode {
  try {
    return localStorage.getItem(GAP_MODE_KEY) === "lead" ? "lead" : "int";
  } catch {
    return "int";
  }
}

function saveGapMode(m: GapMode) {
  try {
    localStorage.setItem(GAP_MODE_KEY, m);
  } catch {
    /* 覚えられなくてもよい */
  }
}

/** 字・class は変わったときだけ書く (同じ字でも textContent を入れると中の字の要素が作り直される) */
function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}
function setClass(e: HTMLElement, c: string) {
  if (e.className !== c) e.className = c;
}
