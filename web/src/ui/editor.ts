// コースづくり: 指 (マウス) で輪を描く → なめらかな道になる。点を動かして直し、道幅・芝の幅・壁の区間・DRS の区間・ピット・縁石を決める
// 自分で 1 周走れたら「公開を申し込む」(サーバーの tracks.ts へ)。管理者が確かめると みんなのコースに出る
import {
  SECTOR_MIN_FRACTION,
  TRACK_LIMITS,
  buildTrack,
  checkTrack,
  controlFractions,
  drsFromFractions,
  drsZones,
  gridPosition,
  normalAt,
  pitLaneOffset,
  pointAt,
  queryTrack,
  sectorSplits,
  simplifyPath,
  straightAround,
  wallDistance,
  wallsFromSegments,
  type PitDef,
  type Track,
  type TrackCheck,
} from "@bpr/shared";
import { isLoggedIn } from "../api.ts";
import { fetchMyTracks, submitTrack, withdrawTrack, type MyTrackRow } from "../tracks_api.ts";
import { errText } from "./account.ts";
import type { Go } from "../main.ts";
import { load, palette, save } from "../store.ts";
import {
  USER_PREFIX,
  deleteUserTrack,
  duplicateUserTrack,
  getUserTrack,
  listUserTracks,
  newUserTrackId,
  putUserTrack,
  type UserTrack,
} from "../usertracks.ts";
import { el, fitCanvas } from "./dom.ts";
import "./editor.css";
import { DRS_GREEN, SECTOR_TINTS } from "../race/trackdraw.ts";

type Mode = "draw" | "move" | "wall" | "drs" | "pit" | "sector" | "view";
const MODES: Mode[] = ["draw", "move", "wall", "drs", "pit", "sector", "view"];

const MODE_LABEL: Record<Mode, string> = {
  draw: "線を引く",
  move: "点を動かす",
  wall: "壁と芝",
  drs: "DRS",
  pit: "ピット",
  sector: "セクター",
  view: "見わたす",
};

const MODE_HINT: Record<Mode, string> = {
  draw: "指 (マウス) で輪を 1 周描いてください。最後は最初へ自動でつながります。描いた方向に走ります",
  move: "点を引っぱって形を直します。道を 2 回たたくと点が増えます。点を選ぶと下に道具が出ます",
  wall: "道をたたくと、その区間のコースの外が「すぐ壁」と「芝」で切りかわります",
  drs: "直線をたたくと DRS の区間を置きます。区間をたたくと消えます (3 つまで)",
  pit: "スタートの線の近くで道の右か左をたたくと、ピットの側が決まります。入り口・止まる所・出口は下で",
  sector: "道をたたくと、近いほうのセクターの切れ目 (S1|S2・S2|S3) がそこへ動きます。下の目盛りでも動かせます",
  view: "引っぱって動かす・2 本指やホイールで拡大",
};

/** DRS の区間の色・ピットの道の色 (F1 中継風の差し色)。DRS はレースの画面と同じ緑 */
const DRS_COLOR = DRS_GREEN;
const PIT_COLOR = "#2ec5ff";
/** はじめのピット (track.ts の決まった形と同じ) */
const PIT_DEFAULT = { entry: -100, box: 15, exit: 110 };

/** 押した点をつかめる近さ (画面の px) */
const HIT_PX = 22;
/** 開いていたコースを覚えておく所 */
const OPEN_KEY = "bpr.editor.open";
/** これより動いたら「たたく」でなく「引く」 */
const TAP_PX = 8;

interface Snapshot {
  points: Array<[number, number]>;
  wallSegs: boolean[];
  halfWidth: number;
  runoff: number;
  drsFr?: Array<[number, number]>;
  pit?: PitDef;
  kerbs?: boolean;
  sectors?: number[];
}

export function mountEditor(root: HTMLElement, go: Go): () => void {
  // ---- 今作っているコース
  let cur: UserTrack = openFirst();
  let stored = !!getUserTrack(cur.id);
  let mode: Mode = cur.def.points.length >= TRACK_LIMITS.minPoints ? "move" : "draw";
  let selected = -1;
  let check: TrackCheck = checkTrack(cur.def);
  let track: Track | null = check.track;
  let undo: Snapshot[] = [];
  let toastTimer = 0;
  /** サーバーに出したコース (この機械の印 → 状態)。ログインしていなければ空 */
  let pubRows = new Map<string, MyTrackRow>();
  let pubLoaded = false;
  let pubBusy = false;
  let alive = true;

  // ---- 見ている所 (m) と大きさ (1 m が何 px)
  const view = { cx: 0, cy: 0, scale: 1 };
  let cssW = 300;
  let cssH = 300;
  let dpr = 1;
  let sized = false;

  // ---- 画面の部品
  const scr = el("div", { class: "ed" });
  root.append(scr);

  const back = el("button", { class: "small ed-back" }, "← メニュー") as HTMLButtonElement;
  back.addEventListener("click", () => go({ name: "menu" }));
  const pick = el("select", { class: "ed-pick", "aria-label": "コースを選ぶ" }) as HTMLSelectElement;
  const nameIn = el("input", { class: "ed-name", maxlength: String(TRACK_LIMITS.maxName), placeholder: "コースの名前", "aria-label": "コースの名前" }) as HTMLInputElement;
  const savedTag = el("span", { class: "ed-saved dim" });

  const modeBtns = new Map<Mode, HTMLButtonElement>();
  const modes = el("div", { class: "ed-modes", role: "tablist" });
  for (const m of MODES) {
    const b = el("button", { role: "tab" }, MODE_LABEL[m]) as HTMLButtonElement;
    b.addEventListener("click", () => setMode(m));
    modeBtns.set(m, b);
    modes.append(b);
  }

  const canvas = el("canvas", { class: "ed-canvas" }) as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const hint = el("div", { class: "ed-hint" });
  const toast = el("div", { class: "ed-toast" });
  const zoomIn = el("button", { class: "small", "aria-label": "拡大" }, "+") as HTMLButtonElement;
  const zoomOut = el("button", { class: "small", "aria-label": "縮小" }, "−") as HTMLButtonElement;
  const fitBtn = el("button", { class: "small" }, "全体") as HTMLButtonElement;
  zoomIn.addEventListener("click", () => zoomAt(cssW / 2, cssH / 2, 1.4));
  zoomOut.addEventListener("click", () => zoomAt(cssW / 2, cssH / 2, 1 / 1.4));
  fitBtn.addEventListener("click", () => {
    fitView();
    draw();
  });
  const zoomBox = el("div", { class: "ed-zoom" }, zoomIn, zoomOut, fitBtn);
  const stage = el("div", { class: "ed-stage" }, canvas, hint, toast, zoomBox);

  // 選んだ点の道具
  const ptAdd = el("button", { class: "small" }, "点を足す") as HTMLButtonElement;
  const ptDel = el("button", { class: "small" }, "点を消す") as HTMLButtonElement;
  const ptSmooth = el("button", { class: "small" }, "ゆるく") as HTMLButtonElement;
  const ptStart = el("button", { class: "small" }, "ここをスタートに") as HTMLButtonElement;
  const ptTools = el("div", { class: "ed-row ed-pt" }, el("span", { class: "dim" }, "選んだ点:"), ptAdd, ptDel, ptSmooth, ptStart);
  ptAdd.addEventListener("click", () => selected >= 0 && insertAfter(selected));
  ptDel.addEventListener("click", () => selected >= 0 && deletePoint(selected));
  ptSmooth.addEventListener("click", () => selected >= 0 && smoothPoint(selected));
  ptStart.addEventListener("click", () => selected >= 0 && startAt(selected));

  // 形の道具
  const undoBtn = el("button", { class: "small" }, "もどす") as HTMLButtonElement;
  const bigger = el("button", { class: "small" }, "大きく") as HTMLButtonElement;
  const smaller = el("button", { class: "small" }, "小さく") as HTMLButtonElement;
  const reverse = el("button", { class: "small" }, "逆回り") as HTMLButtonElement;
  undoBtn.addEventListener("click", popUndo);
  bigger.addEventListener("click", () => scaleShape(1.1));
  smaller.addEventListener("click", () => scaleShape(1 / 1.1));
  reverse.addEventListener("click", reverseLoop);
  const shapeTools = el("div", { class: "ed-row" }, undoBtn, bigger, smaller, reverse);

  // 幅
  const L = TRACK_LIMITS;
  const widthIn = el("input", { type: "range", min: String(L.minHalfWidth * 2), max: String(L.maxHalfWidth * 2), step: "1" }) as HTMLInputElement;
  const widthVal = el("span", { class: "num" });
  const runoffIn = el("input", { type: "range", min: String(L.minRunoff), max: String(L.maxRunoff), step: "1" }) as HTMLInputElement;
  const runoffVal = el("span", { class: "num" });
  let sliderUndo = false;
  const sliderStart = () => {
    if (!sliderUndo) pushUndo();
    sliderUndo = true;
  };
  widthIn.addEventListener("input", () => {
    sliderStart();
    cur.def.halfWidth = Number(widthIn.value) / 2;
    changed(true, false);
  });
  runoffIn.addEventListener("input", () => {
    sliderStart();
    cur.def.runoff = Number(runoffIn.value);
    changed(true, false);
  });
  for (const s of [widthIn, runoffIn]) {
    s.addEventListener("change", () => {
      sliderUndo = false;
      persist();
    });
  }
  // 路面 (今はアスファルトだけ。仮) と縁石
  const surfaceSel = el("select", { "aria-label": "路面" }, el("option", { value: "asphalt" }, "アスファルト"), el("option", { value: "gravel", disabled: "true" }, "砂利の道 (あとで)")) as HTMLSelectElement;
  const kerbOn = el("button", { class: "small" }, "あり") as HTMLButtonElement;
  const kerbOff = el("button", { class: "small" }, "なし") as HTMLButtonElement;
  const setKerbs = (on: boolean) => {
    if ((cur.def.kerbs !== false) === on) return;
    pushUndo();
    cur.def = { ...cur.def, kerbs: on ? undefined : false };
    changed(true);
  };
  kerbOn.addEventListener("click", () => setKerbs(true));
  kerbOff.addEventListener("click", () => setKerbs(false));
  const sliders = el(
    "div",
    { class: "ed-sliders" },
    el("label", {}, el("span", {}, "道幅"), widthVal, widthIn),
    el("label", {}, el("span", {}, "芝の幅"), runoffVal, runoffIn),
    el("div", { class: "ed-line" }, el("span", {}, "路面"), surfaceSel),
    el("div", { class: "ed-line" }, el("span", {}, "縁石"), el("div", { class: "ed-seg" }, kerbOn, kerbOff)),
    el("div", { class: "dim ed-note" }, `道幅は ${L.minHalfWidth * 2} m 以上 (8 台が走れる幅)。芝の外は壁です。「壁と芝」でたたいた区間は芝がなく、すぐ壁になります。路面は今はアスファルトだけです`),
  );

  // DRS の区間
  const drsState = el("div", { class: "ed-info" });
  const drsList = el("ul", { class: "ed-list" });
  const drsAuto = el("button", { class: "small" }, "自動に戻す") as HTMLButtonElement;
  const drsNone = el("button", { class: "small" }, "DRS なし") as HTMLButtonElement;
  drsAuto.addEventListener("click", () => setDrs(undefined));
  drsNone.addEventListener("click", () => setDrs([]));
  const drsTools = el("div", { class: "ed-row" }, drsAuto, drsNone);

  // ピット
  const pitSide = new Map<"auto" | 1 | -1, HTMLButtonElement>();
  const pitSides = el("div", { class: "ed-seg" });
  for (const [k, jp] of [
    ["auto", "自動"],
    [1, "右"],
    [-1, "左"],
  ] as Array<["auto" | 1 | -1, string]>) {
    const b = el("button", { class: "small" }, jp) as HTMLButtonElement;
    b.addEventListener("click", () => setPit({ side: k === "auto" ? undefined : k }));
    pitSide.set(k, b);
    pitSides.append(b);
  }
  const pitSlider = (label: string, min: number, max: number) => {
    const input = el("input", { type: "range", min: String(min), max: String(max), step: "5", "aria-label": label }) as HTMLInputElement;
    const val = el("span", { class: "num" });
    return { input, val, row: el("label", {}, el("span", {}, label), val, input) };
  };
  const pitEntry = pitSlider("入り口", L.pitMin, L.pitMax);
  const pitBox = pitSlider("止まる所", -L.pitMax, L.pitMax);
  const pitExit = pitSlider("出口", L.pitMin, L.pitMax);
  let pitUndo = false;
  for (const [sl, key] of [
    [pitEntry, "entry"],
    [pitBox, "box"],
    [pitExit, "exit"],
  ] as const) {
    sl.input.addEventListener("input", () => {
      if (!pitUndo) pushUndo();
      pitUndo = true;
      const v = Number(sl.input.value);
      setPit({ [key]: key === "entry" ? -v : v } as Partial<PitDef>, false);
    });
    sl.input.addEventListener("change", () => {
      pitUndo = false;
      persist();
    });
  }
  const pitReset = el("button", { class: "small" }, "はじめの形に") as HTMLButtonElement;
  pitReset.addEventListener("click", () => {
    if (!cur.def.pit) return;
    pushUndo();
    cur.def = { ...cur.def, pit: undefined };
    changed(false);
  });
  const pitBoxEl = el(
    "div",
    { class: "ed-sliders" },
    el("div", { class: "ed-line" }, el("span", {}, "側"), pitSides),
    pitEntry.row,
    pitBox.row,
    pitExit.row,
    el("div", { class: "ed-row" }, pitReset),
    el("div", { class: "dim ed-note" }, `入り口はスタートの線の手前、出口は先 (どちらも ${L.pitMin}〜${L.pitMax} m)。止まる所は線からの距離 (− は手前)。ピットの道は芝の中を通ります`),
  );

  // セクター (区間タイム) の切れ目: 1 周の割合 (%)。1 つのセクターは SECTOR_MIN_FRACTION 以上
  const secSlider = (label: string) => {
    const input = el("input", { type: "range", min: "10", max: "90", step: "0.5", "aria-label": label }) as HTMLInputElement;
    const val = el("span", { class: "num" });
    return { input, val, row: el("label", {}, el("span", {}, label), val, input) };
  };
  const secA = secSlider("S1 | S2");
  const secB = secSlider("S2 | S3");
  let secUndo = false;
  for (const [sl, k] of [
    [secA, 0],
    [secB, 1],
  ] as const) {
    sl.input.addEventListener("input", () => {
      if (!secUndo) pushUndo();
      secUndo = true;
      setSplit(k, Number(sl.input.value) / 100, false);
    });
    sl.input.addEventListener("change", () => {
      secUndo = false;
      persist();
    });
  }
  const secReset = el("button", { class: "small" }, "3 等分に戻す") as HTMLButtonElement;
  secReset.addEventListener("click", () => {
    if (!cur.def.sectors) return;
    pushUndo();
    cur.def = { ...cur.def, sectors: undefined };
    changed(false);
  });
  const secLens = el("div", { class: "ed-info" });
  const sectorEl = el(
    "div",
    { class: "ed-sliders" },
    secA.row,
    secB.row,
    secLens,
    el("div", { class: "ed-row" }, secReset),
    el("div", { class: "dim ed-note" }, `1 周を 3 つのセクター (区間タイム) に分けます。切れ目はスタートの線からの割合で、1 つのセクターは 1 周の ${Math.round(SECTOR_MIN_FRACTION * 100)}% 以上。旗の区間とは別です`),
  );

  const info = el("div", { class: "ed-info" });
  const problems = el("ul", { class: "ed-problems" });

  const drive = el("button", { class: "primary" }, "試しに走る") as HTMLButtonElement;
  const dupBtn = el("button", { class: "small" }, "複製") as HTMLButtonElement;
  const delBtn = el("button", { class: "small" }, "削除") as HTMLButtonElement;
  drive.addEventListener("click", () => {
    if (!check.ok) return;
    persist();
    go({ name: "practice", trackId: USER_PREFIX + cur.id });
  });
  dupBtn.addEventListener("click", () => {
    persist();
    const c = duplicateUserTrack(cur.id);
    if (c) {
      openTrack(c);
      showToast("複製しました");
    }
  });
  delBtn.addEventListener("click", () => {
    if (!confirm(`「${cur.def.name || "名前なし"}」を消しますか? もとに戻せません`)) return;
    deleteUserTrack(cur.id);
    const rest = listUserTracks();
    openTrack(rest[0] ?? blank());
    showToast("消しました");
  });
  // 公開 (自分で 1 周 + 管理者の確かめ)
  const publishNote = el("div", { class: "ed-pub-state" });
  const publishBtn = el("button", { class: "go" }, "公開を申し込む") as HTMLButtonElement;
  const withdrawBtn = el("button", { class: "small ghost" }, "取り下げる") as HTMLButtonElement;
  const loginBtn = el("button", { class: "small" }, "ログインする") as HTMLButtonElement;
  loginBtn.addEventListener("click", () => {
    persist();
    go({ name: "account" });
  });
  publishBtn.addEventListener("click", () => void publish());
  withdrawBtn.addEventListener("click", () => void withdraw());
  const publishRow = el("div", { class: "ed-row" }, publishBtn, withdrawBtn, loginBtn);

  const box = (title: string, label: string, ...children: Array<Node | null>) =>
    el("section", { class: "ed-box" }, el("div", { class: "ed-box-head" }, el("h3", {}, title), el("span", { class: "label" }, label)), ...children);
  const shapeBox = box("形", "Shape", shapeTools, ptTools);
  const roadBox = box("道", "Road", sliders);
  const drsBox = box("DRS の区間", "DRS zones", drsState, drsList, drsTools);
  const pitPanel = box("ピット", "Pit lane", pitBoxEl);
  const sectorBox = box("セクター", "Sectors", sectorEl);
  const checkBox = box("確かめ", "Check", info, problems, el("div", { class: "ed-row" }, drive, dupBtn, delBtn));
  const publishBox = box("公開", "Publish", publishNote, publishRow);
  const side = el("div", { class: "ed-side" }, shapeBox, roadBox, drsBox, pitPanel, sectorBox, checkBox, publishBox);

  scr.append(
    el(
      "header",
      { class: "ed-head" },
      back,
      el("h2", { class: "ed-title" }, "コースづくり", el("small", { class: "label" }, "Track editor")),
      el("div", { class: "ed-pickrow" }, pick),
    ),
    el("div", { class: "ed-namebar" }, el("span", { class: "label" }, "Name"), nameIn, savedTag),
    modes,
    el("div", { class: "ed-main" }, stage, side),
  );

  nameIn.addEventListener("input", () => {
    cur.def.name = nameIn.value;
    changed(false, false);
  });
  nameIn.addEventListener("change", persist);
  pick.addEventListener("change", () => {
    persist();
    if (pick.value === "__new") {
      openTrack(blank());
    } else {
      const t = getUserTrack(pick.value);
      if (t) openTrack(t);
    }
  });

  // ---------------------------------------------------------------------------
  // コースを開く・保存する

  function blank(): UserTrack {
    const now = Date.now();
    const n = listUserTracks().length + 1;
    return {
      id: newUserTrackId(),
      def: { id: "", name: `わたしのコース ${n}`, points: [], halfWidth: 7, runoff: 8 },
      wallSegs: [],
      lapped: false,
      created: now,
      updated: now,
    };
  }

  /** 前に開いていたコース (練習から戻ったときなど)。なければ一番新しいもの */
  function openFirst(): UserTrack {
    let last: string | null = null;
    try {
      last = sessionStorage.getItem(OPEN_KEY);
    } catch {
      /* 読めなくてもよい */
    }
    const t = (last && getUserTrack(last)) || listUserTracks()[0];
    return clone(t ?? blank());
  }

  function remember() {
    try {
      sessionStorage.setItem(OPEN_KEY, cur.id);
    } catch {
      /* 保存できなくてもよい */
    }
  }

  function clone(t: UserTrack): UserTrack {
    return { ...t, def: { ...t.def, points: t.def.points.map((p) => [p[0], p[1]]) }, wallSegs: fitFlags(t.wallSegs.slice(), t.def.points.length) };
  }

  function openTrack(t: UserTrack) {
    cur = clone(t);
    stored = !!getUserTrack(cur.id);
    selected = -1;
    undo = [];
    mode = cur.def.points.length >= L.minPoints ? "move" : "draw";
    rebuild();
    fitView();
    refreshAll();
    remember();
  }

  function fitFlags(f: boolean[], m: number): boolean[] {
    while (f.length < m) f.push(false);
    f.length = m;
    return f;
  }

  /** 組み立て直して確かめる (壁の区間と DRS の区間は、点の間ごとの印と割合から作る) */
  function rebuild() {
    cur.wallSegs = fitFlags(cur.wallSegs, cur.def.points.length);
    const walls = wallsFromSegments(cur.def.points, cur.wallSegs);
    cur.def = { ...cur.def, walls: walls.length ? walls : undefined, drs: undefined };
    if (cur.drsFr && cur.def.points.length >= 3) {
      const len = buildTrack({ ...cur.def, halfWidth: Math.max(1, cur.def.halfWidth) }).length;
      cur.def.drs = drsFromFractions(cur.drsFr, len);
    }
    check = checkTrack(cur.def);
    track = check.track ?? (cur.def.points.length >= 3 ? buildTrack({ ...cur.def, halfWidth: Math.max(1, cur.def.halfWidth) }) : null);
  }

  /** 何かが変わった。shape = 走る形が変わった (1 周走れた印が消える)。DRS・ピット・名前は形ではない */
  function changed(shape: boolean, save = true) {
    rebuild();
    if (shape) {
      if (cur.lapped || cur.bestLap !== undefined) {
        cur.lapped = false;
        cur.bestLap = undefined;
      }
      dropGhost();
    }
    savedTag.textContent = "";
    refreshPanel();
    draw();
    if (save) persist();
  }

  function dropGhost() {
    const s = load();
    const key = USER_PREFIX + cur.id;
    if (s.ghosts[key]) {
      delete s.ghosts[key];
      save();
    }
  }

  function persist() {
    // 点が足りないうちは保存しない (空のコースが並ばないように)
    if (cur.def.points.length < L.minPoints) return;
    putUserTrack(clone(cur));
    const keep = getUserTrack(cur.id);
    if (keep) cur.updated = keep.updated;
    if (!stored) {
      stored = true;
      refreshPick();
    }
    savedTag.textContent = "保存しました";
  }

  // ---------------------------------------------------------------------------
  // もどす

  function pushUndo() {
    undo.push({
      points: cur.def.points.map((p) => [p[0], p[1]]),
      wallSegs: cur.wallSegs.slice(),
      halfWidth: cur.def.halfWidth,
      runoff: cur.def.runoff,
      drsFr: cur.drsFr?.map((z) => [z[0], z[1]]),
      pit: cur.def.pit ? { ...cur.def.pit } : undefined,
      kerbs: cur.def.kerbs,
      sectors: cur.def.sectors?.slice(),
    });
    if (undo.length > 60) undo.shift();
    undoBtn.disabled = false;
  }

  function popUndo() {
    const s = undo.pop();
    if (!s) return;
    cur.def = { ...cur.def, points: s.points, halfWidth: s.halfWidth, runoff: s.runoff, pit: s.pit, kerbs: s.kerbs, sectors: s.sectors };
    cur.wallSegs = s.wallSegs;
    cur.drsFr = s.drsFr;
    selected = -1;
    changed(true);
    refreshAll();
  }

  // ---------------------------------------------------------------------------
  // 形の道具

  function setPoints(points: Array<[number, number]>, flags: boolean[]) {
    cur.def = { ...cur.def, points };
    cur.wallSegs = flags;
  }

  function insertAfter(i: number, at?: [number, number]) {
    const p = cur.def.points;
    if (p.length >= L.maxPoints) return showToast(`点は ${L.maxPoints} までです`);
    pushUndo();
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const q: [number, number] = at ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const pts = p.slice();
    pts.splice(i + 1, 0, [round1(q[0]), round1(q[1])]);
    const f = cur.wallSegs.slice();
    f.splice(i + 1, 0, f[i] ?? false);
    setPoints(pts, f);
    selected = i + 1;
    changed(true);
  }

  function deletePoint(i: number) {
    const p = cur.def.points;
    if (p.length <= L.minPoints) return showToast(`点は ${L.minPoints} つより減らせません`);
    pushUndo();
    const pts = p.slice();
    pts.splice(i, 1);
    const f = cur.wallSegs.slice();
    f.splice(i, 1);
    setPoints(pts, f);
    selected = -1;
    changed(true);
  }

  /** その所 (m) にいちばん近い点の番号 (点がなければ -1) */
  function nearestPoint(at: readonly [number, number]): number {
    let best = -1;
    let bd = Infinity;
    cur.def.points.forEach((q, i) => {
      const d = Math.hypot(q[0] - at[0], q[1] - at[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  function smoothPoint(i: number) {
    const p = cur.def.points;
    const m = p.length;
    pushUndo();
    const a = p[(i - 1 + m) % m];
    const b = p[(i + 1) % m];
    const pts = p.slice();
    pts[i] = [round1(p[i][0] * 0.5 + (a[0] + b[0]) * 0.25), round1(p[i][1] * 0.5 + (a[1] + b[1]) * 0.25)];
    setPoints(pts, cur.wallSegs);
    changed(true);
  }

  function startAt(i: number) {
    if (i === 0) return;
    pushUndo();
    const p = cur.def.points;
    const f = cur.wallSegs;
    // DRS の区間は同じ所に残す (割合をずらす)
    if (cur.drsFr) {
      const f0 = controlFractions(p)[i];
      cur.drsFr = cur.drsFr.map(([a, b]) => [mod1(a - f0), mod1(b - f0)]);
    }
    setPoints([...p.slice(i), ...p.slice(0, i)], [...f.slice(i), ...f.slice(0, i)]);
    selected = 0;
    changed(true);
  }

  function reverseLoop() {
    const p = cur.def.points;
    const m = p.length;
    if (m < 3) return;
    pushUndo();
    // スタートの点はそのまま、向きだけ逆に。間 j は もとの間 (m - j - 1) だった
    const pts = p.map((_, j) => p[(m - j) % m]);
    const f = p.map((_, j) => cur.wallSegs[(m - j - 1 + m) % m] ?? false);
    setPoints(pts, f);
    // DRS の区間とピットも向きに合わせる (スタートの線はそのまま)
    if (cur.drsFr) cur.drsFr = cur.drsFr.map(([a, b]) => [mod1(1 - b), mod1(1 - a)]);
    const pit = cur.def.pit;
    if (pit) {
      cur.def.pit = {
        ...(pit.side ? { side: (pit.side === 1 ? -1 : 1) as 1 | -1 } : {}),
        ...(pit.exit !== undefined || pit.entry !== undefined ? { entry: -(pit.exit ?? PIT_DEFAULT.exit), exit: -(pit.entry ?? PIT_DEFAULT.entry) } : {}),
        ...(pit.box !== undefined ? { box: -pit.box } : {}),
      };
    }
    selected = -1;
    changed(true);
    showToast("逆回りにしました");
  }

  function centroid(): [number, number] {
    const p = cur.def.points;
    let x = 0;
    let y = 0;
    for (const q of p) {
      x += q[0];
      y += q[1];
    }
    return [x / Math.max(1, p.length), y / Math.max(1, p.length)];
  }

  function scaleShape(k: number, record = true) {
    const p = cur.def.points;
    if (p.length < 3) return;
    if (record) pushUndo();
    const [cx, cy] = centroid();
    setPoints(
      p.map((q) => [round1(cx + (q[0] - cx) * k), round1(cy + (q[1] - cy) * k)]),
      cur.wallSegs,
    );
    changed(true);
  }

  /** 描き終わった線をコースにする */
  function finishDrawing(raw: Array<[number, number]>) {
    if (raw.length < 8) return;
    let pts = simplifyPath(raw);
    if (pts.length < L.minPoints) return showToast("輪になるように、もう少し大きく描いてください");
    pushUndo();
    // 小さすぎたら大きくする (拡大して描いたときなど)
    const len = buildTrack({ ...cur.def, points: pts }).length;
    let grew = false;
    if (len < L.minLength) {
      const k = (L.minLength * 1.4) / len;
      let cx = 0;
      let cy = 0;
      for (const q of pts) {
        cx += q[0] / pts.length;
        cy += q[1] / pts.length;
      }
      pts = pts.map((q) => [round1(cx + (q[0] - cx) * k), round1(cy + (q[1] - cy) * k)]);
      grew = true;
    }
    setPoints(pts, pts.map(() => false));
    // 描き直したら DRS とピットははじめから
    cur.drsFr = undefined;
    cur.def = { ...cur.def, pit: undefined };
    selected = -1;
    changed(true);
    if (grew) {
      fitView();
      showToast("小さかったので大きくしました");
    }
    setMode("move");
  }

  // ---------------------------------------------------------------------------
  // DRS の区間とピット

  /** DRS の区間を決める (undefined = 自動、[] = なし) */
  function setDrs(fr: Array<[number, number]> | undefined) {
    pushUndo();
    cur.drsFr = fr?.slice().sort((a, b) => a[0] - b[0]);
    changed(false);
  }

  /** 今の DRS の区間 (割合)。自動なら長い直線から決めたもの */
  function currentDrsFr(t: Track): Array<[number, number]> {
    if (cur.drsFr) return cur.drsFr.map((z) => [z[0], z[1]]);
    const L = t.length;
    return drsZones(t).map((z) => [mod1(z.start / L), mod1(z.end / L)]);
  }

  function tapDrs(s: number) {
    const t = track;
    if (!t) return;
    const Lm = t.length;
    let fr = currentDrsFr(t);
    const f = mod1(s / Lm);
    const inside = fr.findIndex(([a, b]) => mod1(f - a) < mod1(b - a));
    if (inside >= 0) {
      fr = fr.filter((_, k) => k !== inside);
      setDrs(fr);
      return showToast(fr.length ? "DRS の区間を消しました" : "DRS の区間がなくなりました");
    }
    if (fr.length >= L.maxDrsZones) return showToast(`DRS の区間は ${L.maxDrsZones} つまでです`);
    const st = straightAround(t, s);
    if (!st || st.end - st.start < L.minDrsLength + 50) return showToast("ここは直線が短すぎます。長い直線をたたいてください");
    // 直線に入って少し先から、出口の少し手前まで (自動と同じ)
    const a = mod1((st.start + 35) / Lm);
    const b = mod1((st.end - 15) / Lm);
    const len = mod1(b - a);
    const hits = fr.some(([a2, b2]) => mod1(a2 - a) < len || mod1(a - a2) < mod1(b2 - a2));
    if (hits) return showToast("ほかの区間と重なります");
    setDrs([...fr, [mod1(round4(a)), mod1(round4(b))]]);
    showToast(`DRS の区間を置きました (${Math.round(len * Lm)} m)`);
  }

  /** ピットを変える (足りない所は今の形のまま)。undefined の項目は「決まった形」に戻す */
  function setPit(patch: Partial<PitDef>, record = true) {
    if (record) pushUndo();
    const next: PitDef = { ...(cur.def.pit ?? {}), ...patch };
    const lane = track?.pit;
    // 入り口・出口を決めるときは、ほかの数も今の値で書いておく (止まる所が外れないように)
    if (lane && ("entry" in patch || "exit" in patch || "box" in patch)) {
      next.entry ??= lane.entry;
      next.exit ??= lane.exit;
      next.box ??= lane.box;
      next.box = Math.max(next.entry + 40, Math.min(next.exit - 45, next.box));
    }
    for (const k of Object.keys(next) as Array<keyof PitDef>) if (next[k] === undefined) delete next[k];
    cur.def = { ...cur.def, pit: Object.keys(next).length ? next : undefined };
    changed(false, record);
  }

  /** セクターの切れ目 k (0 = S1|S2、1 = S2|S3) を周の割合 f に (となりと SECTOR_MIN_FRACTION 以上あける) */
  function setSplit(k: 0 | 1, f: number, record = true): boolean {
    const sp = sectorSplits(cur.def);
    const m = SECTOR_MIN_FRACTION;
    const lo = k === 0 ? m : sp[0] + m;
    const hi = k === 0 ? sp[1] - m : 1 - m;
    const v = Math.round(Math.max(lo, Math.min(hi, f)) * 1000) / 1000;
    if (record) pushUndo();
    sp[k] = v;
    cur.def = { ...cur.def, sectors: [sp[0], sp[1]] };
    changed(false, record);
    return Math.abs(v - f) < 0.002;
  }

  function tapSector(s: number) {
    const t = track;
    if (!t) return;
    const f = mod1(s / t.length);
    const sp = sectorSplits(cur.def);
    const k: 0 | 1 = Math.abs(f - sp[0]) <= Math.abs(f - sp[1]) ? 0 : 1;
    const ok = setSplit(k, f);
    showToast(ok ? `${k === 0 ? "S1 | S2" : "S2 | S3"} の切れ目を動かしました` : `セクターは 1 周の ${Math.round(SECTOR_MIN_FRACTION * 100)}% 以上にします (できるところまで動かしました)`);
  }

  function tapPit(q: { s: number; d: number }) {
    const t = track;
    if (!t) return;
    const u = q.s > t.length / 2 ? q.s - t.length : q.s;
    if (u < t.pit.entry - 80 || u > t.pit.exit + 80) return showToast("スタートの線の近くの、道の右か左をたたいてください");
    const side: 1 | -1 = q.d >= 0 ? 1 : -1;
    setPit({ side });
    showToast(side === 1 ? "ピットを右側にしました" : "ピットを左側にしました");
  }

  // ---------------------------------------------------------------------------
  // 公開

  async function loadPub() {
    if (!isLoggedIn()) {
      pubRows = new Map();
      pubLoaded = true;
      if (alive) refreshPanel();
      return;
    }
    try {
      const rows = await fetchMyTracks();
      pubRows = new Map(rows.map((r) => [r.localId, r]));
    } catch {
      /* 読めなくても作れる */
    }
    pubLoaded = true;
    if (alive) refreshPanel();
  }

  async function publish() {
    if (!check.ok || !cur.lapped || cur.bestLap === undefined || pubBusy) return;
    persist();
    pubBusy = true;
    refreshPanel();
    try {
      const r = await submitTrack(cur.id, cur.def, cur.bestLap);
      pubRows.set(cur.id, r);
      showToast(r.status === "public" ? "公開中です" : "申し込みました。管理者の確かめを待ちます");
    } catch (e) {
      showToast(errText(e));
    }
    pubBusy = false;
    if (alive) refreshPanel();
  }

  async function withdraw() {
    const r = pubRows.get(cur.id);
    if (!r || pubBusy) return;
    if (!confirm(`「${r.name}」の公開${r.status === "public" ? "" : "の申し込み"}を取り下げますか? 走った記録といいねも消えます`)) return;
    pubBusy = true;
    try {
      await withdrawTrack(r.id);
      pubRows.delete(cur.id);
      showToast("取り下げました");
    } catch (e) {
      showToast(errText(e));
    }
    pubBusy = false;
    if (alive) refreshPanel();
  }

  // ---------------------------------------------------------------------------
  // 見る所

  function toScreen(x: number, y: number): [number, number] {
    return [(x - view.cx) * view.scale + cssW / 2, (y - view.cy) * view.scale + cssH / 2];
  }
  function toWorld(sx: number, sy: number): [number, number] {
    return [(sx - cssW / 2) / view.scale + view.cx, (sy - cssH / 2) / view.scale + view.cy];
  }

  function fitView() {
    const p = cur.def.points;
    if (!track || p.length < 3) {
      view.cx = 0;
      view.cy = 0;
      view.scale = cssW / 900;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < track.n; i++) {
      minX = Math.min(minX, track.px[i]);
      maxX = Math.max(maxX, track.px[i]);
      minY = Math.min(minY, track.py[i]);
      maxY = Math.max(maxY, track.py[i]);
    }
    const pad = 40 + cur.def.halfWidth + cur.def.runoff;
    view.cx = (minX + maxX) / 2;
    view.cy = (minY + maxY) / 2;
    view.scale = Math.min(cssW / (maxX - minX + pad * 2), cssH / (maxY - minY + pad * 2));
  }

  function zoomAt(sx: number, sy: number, k: number) {
    const [wx, wy] = toWorld(sx, sy);
    view.scale = Math.max(0.05, Math.min(20, view.scale * k));
    // 指の下の所が動かないように
    view.cx = wx - (sx - cssW / 2) / view.scale;
    view.cy = wy - (sy - cssH / 2) / view.scale;
    draw();
  }

  function resize() {
    const wrapW = stage.clientWidth || 300;
    const wide = window.innerWidth >= 900;
    // スマホ横 (editor.css と同じ条件): 絵を道具の帯の下から画面の下まで (画面は巻き取らない)
    const landscape = !wide && window.innerWidth > window.innerHeight && window.innerHeight <= 520;
    const h = wide
      ? Math.max(360, window.innerHeight - 190)
      : landscape
        ? Math.max(160, window.innerHeight - stage.getBoundingClientRect().top - 8)
        : Math.max(300, Math.min(window.innerHeight * 0.6, wrapW * 1.1));
    const first = !sized;
    sized = true;
    cssW = Math.floor(wrapW);
    cssH = Math.floor(h);
    dpr = fitCanvas(canvas, cssW, cssH);
    // はじめだけ全体が入るように。あとは大きさも真ん中もそのまま
    if (first) fitView();
    draw();
  }

  // ---------------------------------------------------------------------------
  // 指とマウス

  const pointers = new Map<number, { x: number; y: number }>();
  type Gesture =
    | { kind: "none" }
    | { kind: "draw"; raw: Array<[number, number]> }
    | { kind: "drag"; index: number; moved: boolean; sx: number; sy: number }
    | { kind: "pan"; sx: number; sy: number; cx: number; cy: number; moved: boolean }
    | { kind: "pinch"; dist: number; mx: number; my: number; scale: number; cx: number; cy: number };
  let gesture: Gesture = { kind: "none" };
  let lastTap = { t: 0, x: 0, y: 0 };

  const local = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function pinchStart() {
    const ps = [...pointers.values()];
    const [a, b] = ps;
    gesture = {
      kind: "pinch",
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      scale: view.scale,
      cx: view.cx,
      cy: view.cy,
    };
  }

  function hitPoint(sx: number, sy: number): number {
    let best = -1;
    let bestD = HIT_PX;
    cur.def.points.forEach((p, i) => {
      const [x, y] = toScreen(p[0], p[1]);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** 画面の点が道 (と芝) の上なら、どの点の間か */
  function hitSegment(sx: number, sy: number): { seg: number; at: [number, number] } | null {
    if (!track || cur.def.points.length < 3) return null;
    const [wx, wy] = toWorld(sx, sy);
    const q = queryTrack(track, wx, wy);
    const reach = wallDistance(track, q.index) + HIT_PX / view.scale;
    if (Math.abs(q.d) > reach) return null;
    const f = q.index / track.n;
    const fr = controlFractions(cur.def.points);
    let seg = 0;
    for (let i = 0; i < fr.length; i++) if (fr[i] <= f) seg = i;
    return { seg, at: [track.px[q.index], track.py[q.index]] };
  }

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    // 最初の指 (マウス) なら、離したのに残った古い指は忘れる
    if (e.isPrimary) {
      pointers.clear();
      gesture = { kind: "none" };
    }
    pointers.set(e.pointerId, { x: sx, y: sy });
    if (pointers.size === 2) {
      // 2 本目の指: 描きかけ・引きかけはやめて、拡大と移動に
      if (gesture.kind === "drag" && gesture.moved) popUndo();
      pinchStart();
      draw();
      return;
    }
    if (pointers.size > 2) return;
    if (mode === "draw") {
      gesture = { kind: "draw", raw: [toWorld(sx, sy)] };
    } else if (mode === "move") {
      const i = hitPoint(sx, sy);
      if (i >= 0) {
        selected = i;
        gesture = { kind: "drag", index: i, moved: false, sx, sy };
        refreshPanel();
        draw();
      } else {
        gesture = { kind: "pan", sx, sy, cx: view.cx, cy: view.cy, moved: false };
      }
    } else {
      gesture = { kind: "pan", sx, sy, cx: view.cx, cy: view.cy, moved: false };
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const [sx, sy] = local(e);
    pointers.set(e.pointerId, { x: sx, y: sy });
    const g = gesture;
    if (g.kind === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      view.scale = Math.max(0.05, Math.min(20, (g.scale * d) / g.dist));
      // 始めの真ん中の所 (世界) が今の真ん中に来るように
      const wx = (g.mx - cssW / 2) / g.scale + g.cx;
      const wy = (g.my - cssH / 2) / g.scale + g.cy;
      view.cx = wx - (mx - cssW / 2) / view.scale;
      view.cy = wy - (my - cssH / 2) / view.scale;
      draw();
    } else if (g.kind === "draw") {
      const w = toWorld(sx, sy);
      const last = g.raw[g.raw.length - 1];
      if (Math.hypot(w[0] - last[0], w[1] - last[1]) * view.scale > 2) g.raw.push(w);
      draw();
    } else if (g.kind === "drag") {
      if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < TAP_PX) return;
      if (!g.moved) pushUndo();
      g.moved = true;
      const [wx, wy] = toWorld(sx, sy);
      const pts = cur.def.points.slice();
      pts[g.index] = [round1(wx), round1(wy)];
      cur.def = { ...cur.def, points: pts };
      changed(true, false);
    } else if (g.kind === "pan") {
      if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < TAP_PX) return;
      g.moved = true;
      view.cx = g.cx - (sx - g.sx) / view.scale;
      view.cy = g.cy - (sy - g.sy) / view.scale;
      draw();
    }
  };

  const onUp = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const [sx, sy] = local(e);
    pointers.delete(e.pointerId);
    const g = gesture;
    if (g.kind === "pinch") {
      // 指が 1 本残ったら、その指で動かせるように
      if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        gesture = { kind: "pan", sx: p.x, sy: p.y, cx: view.cx, cy: view.cy, moved: true };
      } else if (pointers.size === 0) gesture = { kind: "none" };
      return;
    }
    if (pointers.size > 0) return;
    gesture = { kind: "none" };
    if (e.type === "pointercancel") {
      draw();
      return;
    }
    if (g.kind === "draw") {
      g.raw.push(toWorld(sx, sy));
      finishDrawing(g.raw);
      draw();
    } else if (g.kind === "drag") {
      if (g.moved) persist();
    } else if (g.kind === "pan" && !g.moved) {
      onTap(sx, sy);
    }
  };

  function onTap(sx: number, sy: number) {
    const now = performance.now();
    const dbl = now - lastTap.t < 350 && Math.hypot(sx - lastTap.x, sy - lastTap.y) < 30;
    lastTap = { t: dbl ? 0 : now, x: sx, y: sy };
    if (mode === "move") {
      const hit = hitSegment(sx, sy);
      if (dbl && hit) {
        insertAfter(hit.seg, hit.at);
        return;
      }
      if (selected >= 0) {
        selected = -1;
        refreshPanel();
        draw();
      }
    } else if (mode === "wall") {
      const hit = hitSegment(sx, sy);
      if (!hit) return;
      pushUndo();
      const f = cur.wallSegs.slice();
      f[hit.seg] = !f[hit.seg];
      cur.wallSegs = f;
      changed(true);
    } else if (mode === "drs" || mode === "pit" || mode === "sector") {
      if (!track || cur.def.points.length < 3) return;
      const [wx, wy] = toWorld(sx, sy);
      const q = queryTrack(track, wx, wy);
      if (Math.abs(q.d) > wallDistance(track, q.index) + HIT_PX / view.scale) return;
      if (mode === "drs") tapDrs(q.s);
      else if (mode === "sector") tapSector(q.s);
      else tapPit(q);
    }
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [sx, sy] = [e.offsetX, e.offsetY];
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    else {
      view.cx += e.deltaX / view.scale;
      draw();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) {
      e.preventDefault();
      deletePoint(selected);
    } else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      popUndo();
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);
  window.addEventListener("resize", resize);

  // ---------------------------------------------------------------------------
  // 描く

  function draw() {
    const c = palette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#090b0f";
    ctx.fillRect(0, 0, cssW, cssH);
    drawGrid("rgba(255,255,255,0.05)");

    // ここから世界の座標 (m)
    const s = view.scale;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (cssW / 2 - view.cx * s), dpr * (cssH / 2 - view.cy * s));
    const px = 1 / s;
    const t = track;
    const drawing = gesture.kind === "draw";
    if (t && cur.def.points.length >= 3 && !drawing) {
      const hw = cur.def.halfWidth;
      const wallD = (i: number) => wallDistance(t, i) - 0.3;
      const at = (i: number, d: number): [number, number] => {
        const [nx, ny] = normalAt(t, i);
        return [t.px[i] + nx * d, t.py[i] + ny * d];
      };
      const loop = (p: Path2D, f: (i: number) => [number, number]) => {
        for (let i = 0; i <= t.n; i++) {
          const [x, y] = f(i % t.n);
          if (i === 0) p.moveTo(x, y);
          else p.lineTo(x, y);
        }
        p.closePath();
      };
      // 芝
      const run = new Path2D();
      loop(run, (i) => at(i, -wallD(i)));
      loop(run, (i) => at(i, wallD(i)));
      ctx.fillStyle = "rgba(34, 211, 122, 0.13)";
      ctx.fill(run, "evenodd");
      // 道
      const road = new Path2D();
      loop(road, (i) => at(i, -hw));
      loop(road, (i) => at(i, hw));
      ctx.fillStyle = "#2a2f3a";
      ctx.fill(road, "evenodd");
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.5 * px;
      ctx.stroke(road);
      // 縁石 (赤と白)
      if (cur.def.kerbs !== false) {
        for (const sd of [-1, 1]) {
          const kp = new Path2D();
          let open = false;
          for (let i = 0; i <= t.n; i++) {
            const k = i % t.n;
            if (t.kerb[k] === sd) {
              const [x, y] = at(k, sd * (hw - 0.7));
              if (!open) kp.moveTo(x, y);
              else kp.lineTo(x, y);
              open = true;
            } else open = false;
          }
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = "#ff2b3a";
          ctx.stroke(kp);
          ctx.strokeStyle = "#f3f5f8";
          ctx.setLineDash([2, 2]);
          ctx.stroke(kp);
          ctx.setLineDash([]);
        }
      }
      // 壁 (芝の外。すぐ壁の区間は太く)
      for (const side of [-1, 1]) {
        let open = false;
        let thick = false;
        const flush = () => {
          if (!open) return;
          ctx.strokeStyle = thick ? c.ink : c.dim;
          ctx.lineWidth = (thick ? 3 : 1.2) * px;
          ctx.setLineDash(thick ? [] : [6 * px, 4 * px]);
          ctx.stroke();
          open = false;
        };
        for (let i = 0; i <= t.n; i++) {
          const k = i % t.n;
          const w = t.runoff[k] === 0;
          if (open && w !== thick) {
            const [x, y] = at(k, side * wallD(k));
            ctx.lineTo(x, y);
            flush();
          }
          const [x, y] = at(k, side * wallD(k));
          if (!open) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            open = true;
            thick = w;
          } else ctx.lineTo(x, y);
        }
        flush();
      }
      ctx.setLineDash([]);
      // 壁と芝を選ぶとき: 点の間ごとに色を変えて、たたける所を見せる
      if (mode === "wall") {
        const fr = controlFractions(cur.def.points);
        for (let k = 0; k < fr.length; k++) {
          const from = Math.floor(fr[k] * t.n);
          const to = k + 1 < fr.length ? Math.floor(fr[k + 1] * t.n) : t.n;
          ctx.beginPath();
          for (let i = from; i <= to; i++) {
            const q = i % t.n;
            if (i === from) ctx.moveTo(t.px[q], t.py[q]);
            else ctx.lineTo(t.px[q], t.py[q]);
          }
          ctx.strokeStyle = cur.wallSegs[k] ? c.accent : c.dim;
          ctx.lineWidth = (k % 2 === 0 ? 4 : 2) * px;
          ctx.stroke();
        }
      } else {
        // 中心の線
        ctx.beginPath();
        for (let i = 0; i <= t.n; i += 2) {
          const q = i % t.n;
          if (i === 0) ctx.moveTo(t.px[q], t.py[q]);
          else ctx.lineTo(t.px[q], t.py[q]);
        }
        ctx.closePath();
        ctx.strokeStyle = c.faint;
        ctx.lineWidth = 1 * px;
        ctx.setLineDash([8 * px, 8 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // DRS の区間 (自動のときは点線)
      const autoDrs = cur.drsFr === undefined;
      drsZones(t).forEach((z, k) => {
        ctx.beginPath();
        for (let s = z.start; s <= z.end; s += 3) {
          const p = pointAt(t, s, 0);
          if (s === z.start) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = DRS_COLOR;
        ctx.globalAlpha = mode === "drs" ? 0.5 : 0.28;
        ctx.lineWidth = hw * 1.5;
        ctx.lineCap = "butt";
        ctx.setLineDash(autoDrs ? [10, 6] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // 検知の線
        const d = pointAt(t, z.detect, 0);
        const [nx, ny] = normalAt(t, d.index);
        ctx.beginPath();
        ctx.moveTo(d.x - nx * hw, d.y - ny * hw);
        ctx.lineTo(d.x + nx * hw, d.y + ny * hw);
        ctx.strokeStyle = DRS_COLOR;
        ctx.lineWidth = Math.max(1.2, 2 * px);
        ctx.setLineDash([3 * px, 3 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
        // 始まり (実線) と終わり (点線) の線 (レースの画面と同じ形)
        for (const [s, dash] of [[z.start, false], [z.end, true]] as const) {
          const q = pointAt(t, s, 0);
          const [qx, qy] = normalAt(t, q.index);
          ctx.beginPath();
          ctx.moveTo(q.x - qx * hw, q.y - qy * hw);
          ctx.lineTo(q.x + qx * hw, q.y + qy * hw);
          ctx.lineWidth = Math.max(1.5, (dash ? 1.5 : 2.5) * px);
          ctx.setLineDash(dash ? [2 * px, 2 * px] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (mode === "drs" || view.scale > 0.6) {
          const m = pointAt(t, (z.start + z.end) / 2, 0);
          label(m.x, m.y, `DRS ${k + 1}`, DRS_COLOR, px);
        }
      });
      // ピットの道
      const lane = t.pit;
      ctx.beginPath();
      for (let u = lane.entry; u <= lane.exit; u += 2) {
        const p = pointAt(t, u, pitLaneOffset(lane, u, lane.outD).d);
        if (u === lane.entry) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = PIT_COLOR;
      ctx.globalAlpha = mode === "pit" ? 1 : 0.55;
      ctx.lineWidth = Math.max(2 * px, 3.2);
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.globalAlpha = 1;
      {
        const b = pointAt(t, lane.box, lane.laneD);
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.heading);
        ctx.fillStyle = PIT_COLOR;
        ctx.fillRect(-3, -2, 6, 4);
        ctx.restore();
        if (mode === "pit") {
          const e = pointAt(t, lane.entry, 0);
          const x = pointAt(t, lane.exit, 0);
          label(e.x, e.y, "IN", PIT_COLOR, px);
          label(x.x, x.y, "OUT", PIT_COLOR, px);
          label(b.x, b.y, "BOX", PIT_COLOR, px);
        }
      }
      // セクターの切れ目 (セクターの道具のときは濃く、名前も)
      {
        const sp = sectorSplits(cur.def);
        const on = mode === "sector";
        ctx.globalAlpha = on ? 1 : 0.5;
        for (const f of sp) {
          const p = pointAt(t, f * t.length, 0);
          const [snx, sny] = normalAt(t, p.index);
          ctx.beginPath();
          ctx.moveTo(p.x - snx * hw * 1.3, p.y - sny * hw * 1.3);
          ctx.lineTo(p.x + snx * hw * 1.3, p.y + sny * hw * 1.3);
          ctx.strokeStyle = c.ink; // レースの画面の道に塗った白い線に合わせる (名前はセクターの色)
          ctx.lineWidth = Math.max(1.5, (on ? 3 : 2) * px);
          ctx.setLineDash(on ? [] : [4 * px, 3 * px]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
        if (on) {
          const edges = [0, sp[0], sp[1], 1];
          for (let k = 0; k < 3; k++) {
            const m = pointAt(t, ((edges[k] + edges[k + 1]) / 2) * t.length, 0);
            label(m.x, m.y, `S${k + 1}`, SECTOR_TINTS[k], px);
          }
        }
      }
      // スタートの並び
      ctx.strokeStyle = c.dim;
      ctx.lineWidth = 1 * px;
      for (let slot = 0; slot < 8; slot++) {
        const g = gridPosition(t, slot);
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.heading);
        ctx.strokeRect(-2.2, -1.1, 4.4, 2.2);
        ctx.restore();
      }
      // スタートの線と走る向き
      const [nx, ny] = normalAt(t, 0);
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = Math.max(2, 3 * px);
      ctx.beginPath();
      ctx.moveTo(t.px[0] - nx * hw, t.py[0] - ny * hw);
      ctx.lineTo(t.px[0] + nx * hw, t.py[0] + ny * hw);
      ctx.stroke();
      const ax = t.px[0] + t.tx[0] * 14;
      const ay = t.py[0] + t.ty[0] * 14;
      const arrow = Math.max(4, 10 * px);
      ctx.beginPath();
      ctx.moveTo(ax + t.tx[0] * arrow, ay + t.ty[0] * arrow);
      ctx.lineTo(ax - nx * arrow * 0.6, ay - ny * arrow * 0.6);
      ctx.lineTo(ax + nx * arrow * 0.6, ay + ny * arrow * 0.6);
      ctx.closePath();
      ctx.fillStyle = c.accent;
      ctx.fill();
    }

    // 描いている線
    if (gesture.kind === "draw") {
      const raw = gesture.raw;
      ctx.beginPath();
      raw.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 3 * px;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      if (raw.length > 0) {
        // 最初の所 (ここへ戻ると輪がとじる)
        ctx.beginPath();
        ctx.arc(raw[0][0], raw[0][1], 10 * px, 0, Math.PI * 2);
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1.5 * px;
        ctx.stroke();
      }
    }

    // ここから画面の座標 (px)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!drawing) {
      // 点
      if (mode === "move" || mode === "draw") {
        cur.def.points.forEach((p, i) => {
          const [x, y] = toScreen(p[0], p[1]);
          ctx.beginPath();
          ctx.arc(x, y, i === selected ? 9 : 6, 0, Math.PI * 2);
          ctx.fillStyle = i === selected ? c.accent : c.paper;
          ctx.fill();
          ctx.strokeStyle = i === 0 ? c.accent : c.ink;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        });
      }
      // 問題のある所
      for (const is of check.issues) {
        if (!is.at) continue;
        const [x, y] = toScreen(is.at[0], is.at[1]);
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = c.bad;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = c.bad;
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("!", x, y);
      }
    }
    // 物差し
    drawScale(c.dim);
  }

  function drawGrid(color: string) {
    // 50 m ごと (遠いときは 250 m ごと)
    const stepM = view.scale * 50 < 14 ? 250 : 50;
    const [x0, y0] = toWorld(0, 0);
    const [x1, y1] = toWorld(cssW, cssH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(x0 / stepM) * stepM; x <= x1; x += stepM) {
      const [sx] = toScreen(x, 0);
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, cssH);
    }
    for (let y = Math.floor(y0 / stepM) * stepM; y <= y1; y += stepM) {
      const [, sy] = toScreen(0, y);
      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(cssW, Math.round(sy) + 0.5);
    }
    ctx.stroke();
  }

  /** 世界の座標 (m) に、画面の大きさで読める小さな札 */
  function label(x: number, y: number, text: string, color: string, px: number) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(px, px);
    ctx.font = "800 11px 'Barlow Condensed', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = "rgba(9, 11, 15, 0.85)";
    ctx.fillRect(-w / 2, -8, w, 16);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0.5);
    ctx.restore();
  }

  function drawScale(color: string) {
    const nice = [10, 20, 50, 100, 200, 500, 1000];
    const m = nice.find((v) => v * view.scale >= 60) ?? 1000;
    const w = m * view.scale;
    const x = 12;
    const y = cssH - 14;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y - 5);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${m} m`, x + 4, y - 3);
  }

  // ---------------------------------------------------------------------------
  // 文字の所を新しくする

  function setMode(m: Mode) {
    mode = m;
    if (m !== "move") selected = -1;
    refreshPanel();
    draw();
  }

  function refreshPick() {
    pick.innerHTML = "";
    const all = listUserTracks();
    for (const t of all) pick.append(el("option", { value: t.id }, `${t.def.name || "名前なし"}${t.lapped ? " (1 周済み)" : ""}`));
    if (!stored) pick.append(el("option", { value: cur.id }, `${cur.def.name || "名前なし"} (まだ保存していません)`));
    pick.append(el("option", { value: "__new" }, "+ 新しいコース"));
    pick.value = cur.id;
  }

  function refreshAll() {
    nameIn.value = cur.def.name;
    savedTag.textContent = stored ? "保存しました" : "";
    refreshPick();
    refreshPanel();
    draw();
  }

  function refreshPanel() {
    for (const [m, b] of modeBtns) {
      b.classList.toggle("on", m === mode);
      b.setAttribute("aria-selected", String(m === mode));
    }
    hint.textContent = MODE_HINT[mode];
    const has = cur.def.points.length >= L.minPoints;
    ptTools.hidden = !(mode === "move" && selected >= 0);
    undoBtn.disabled = undo.length === 0;
    for (const b of [bigger, smaller, reverse]) b.disabled = !has;
    dupBtn.disabled = !stored;
    delBtn.disabled = !stored;

    widthIn.value = String(cur.def.halfWidth * 2);
    widthVal.textContent = `${cur.def.halfWidth * 2} m`;
    runoffIn.value = String(cur.def.runoff);
    runoffVal.textContent = `${cur.def.runoff} m`;
    surfaceSel.value = cur.def.surface ?? "asphalt";
    kerbOn.classList.toggle("on", cur.def.kerbs !== false);
    kerbOff.classList.toggle("on", cur.def.kerbs === false);

    // 道具の板は今の道具に合うものだけ (スマホで下に長くならないように)
    shapeBox.hidden = !(mode === "draw" || mode === "move" || mode === "view");
    roadBox.hidden = !(mode === "move" || mode === "wall" || mode === "view");
    drsBox.hidden = mode !== "drs";
    pitPanel.hidden = mode !== "pit";
    sectorBox.hidden = mode !== "sector";
    {
      const sp = sectorSplits(cur.def);
      secA.input.value = String(sp[0] * 100);
      secB.input.value = String(sp[1] * 100);
      secA.val.textContent = `${(sp[0] * 100).toFixed(1)}%`;
      secB.val.textContent = `${(sp[1] * 100).toFixed(1)}%`;
      const lens = [sp[0], sp[1] - sp[0], 1 - sp[1]];
      const Lm = has && track ? track.length : 0;
      secLens.textContent = `${cur.def.sectors ? "自分で決めた切れ目" : "3 等分 (はじめのまま)"}・${lens.map((x, i) => `S${i + 1} ${Lm ? `${Math.round(x * Lm)} m` : `${Math.round(x * 100)}%`}`).join(" / ")}`;
    }
    refreshDrsPit(has);
    refreshPublish(has);

    info.innerHTML = "";
    if (has && track) {
      const walls = cur.wallSegs.filter((f) => f).length;
      info.append(
        el("div", {}, `1 周 `, el("span", { class: "num" }, `${Math.round(track.length)} m`), ` (${L.minLength} m〜${L.maxLength / 1000} km)・点 ${cur.def.points.length}・壁の区間 ${walls}`),
        el(
          "div",
          { class: cur.lapped ? "good" : "dim" },
          cur.lapped ? `1 周走れました${cur.bestLap !== undefined ? ` (一番速い周 ${fmtLap(cur.bestLap)})` : ""}` : "まだ 1 周走っていません",
        ),
      );
    } else {
      info.append(el("div", { class: "dim" }, "まだ形がありません。「線を引く」で輪を描いてください"));
    }

    problems.innerHTML = "";
    const issues = has ? check.issues : check.issues.filter((i) => i.code === "name");
    if (has && issues.length === 0) problems.append(el("li", { class: "good" }, "問題はありません。試しに走れます"));
    for (const is of issues) {
      const li = el("li", { class: "bad" }, is.message);
      if (is.at) {
        li.classList.add("ed-jump");
        li.title = "その所を見て、近い点を選ぶ";
        const at = is.at;
        li.addEventListener("click", () => {
          view.cx = at[0];
          view.cy = at[1];
          view.scale = Math.max(view.scale, 1.2);
          // 近い点を選ぶ (「点を動かす」にして、ゆるく・消す などの道具を出す。QA 2 回目: 見るだけで ゆるく に届かなかった)
          const near = nearestPoint(at);
          if (near >= 0) {
            if (mode !== "move") mode = "move";
            selected = near;
            refreshPanel();
            // 板を巻き取っていても、選んだ点の道具 (ゆるく など) が見えるように
            ptTools.scrollIntoView({ block: "nearest" });
          }
          draw();
        });
      }
      problems.append(li);
    }
    drive.disabled = !check.ok;
  }

  function refreshDrsPit(has: boolean) {
    const t = has ? track : null;
    // DRS
    drsList.innerHTML = "";
    if (!t) {
      drsState.textContent = "形ができると置けます";
    } else {
      const zones = drsZones(t);
      drsState.innerHTML = "";
      drsState.append(
        cur.drsFr === undefined
          ? el("div", {}, el("b", {}, "自動"), ` — 長い直線から ${zones.length} 区間`)
          : zones.length
            ? el("div", {}, el("b", {}, `${zones.length} 区間`), " — 自分で置いた区間")
            : el("div", {}, el("b", {}, "DRS なし")),
      );
      zones.forEach((z, k) => {
        const del = el("button", { class: "small ghost" }, "消す") as HTMLButtonElement;
        del.addEventListener("click", () => {
          const fr = currentDrsFr(t).filter((_, j) => j !== k);
          setDrs(fr);
        });
        drsList.append(
          el(
            "li",
            {},
            el("span", { class: "ed-chip", style: `--chip:${DRS_COLOR}` }, `DRS ${k + 1}`),
            el("span", { class: "num" }, `${Math.round(z.end - z.start)} m`),
            el("small", { class: "dim" }, `検知 ${Math.round(z.start - z.detect)} m 手前`),
            del,
          ),
        );
      });
    }
    drsAuto.disabled = !t || cur.drsFr === undefined;
    drsNone.disabled = !t || (cur.drsFr !== undefined && cur.drsFr.length === 0);
    // ピット
    const lane = t?.pit;
    const side = cur.def.pit?.side ?? "auto";
    for (const [k, b] of pitSide) {
      b.classList.toggle("on", k === side);
      b.disabled = !t;
    }
    for (const sl of [pitEntry, pitBox, pitExit]) sl.input.disabled = !t;
    pitReset.disabled = !t || !cur.def.pit;
    if (lane) {
      pitEntry.input.value = String(-lane.entry);
      pitEntry.val.textContent = `${-lane.entry} m 手前`;
      pitExit.input.value = String(lane.exit);
      pitExit.val.textContent = `${lane.exit} m 先`;
      pitBox.input.min = String(lane.entry + 40);
      pitBox.input.max = String(lane.exit - 45);
      pitBox.input.value = String(lane.box);
      pitBox.val.textContent = `${lane.box >= 0 ? "+" : ""}${lane.box} m`;
    }
  }

  function refreshPublish(has: boolean) {
    const row = pubRows.get(cur.id);
    const logged = isLoggedIn();
    publishNote.innerHTML = "";
    loginBtn.hidden = logged;
    withdrawBtn.hidden = !row;
    publishBtn.hidden = !logged || row?.status === "public";
    const ready = has && check.ok && cur.lapped && cur.bestLap !== undefined;
    publishBtn.disabled = !ready || pubBusy || !pubLoaded;
    publishBtn.textContent = row ? (row.status === "rejected" ? "直して出し直す" : "出し直す") : "公開を申し込む";
    const line = (cls: string, ...kids: Array<Node | string>) => publishNote.append(el("div", { class: cls }, ...kids));
    if (row) {
      const when = new Date(row.reviewedAt ?? row.submittedAt).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
      if (row.status === "public") line("ed-pub public", el("b", {}, "公開中"), ` 「${row.name}」 · ${when} から みんなのコースに出ています`);
      else if (row.status === "pending") line("ed-pub pending", el("b", {}, "確かめ待ち"), ` 「${row.name}」 · ${when} に申し込み。管理者が名前と形を確かめます`);
      else line("ed-pub rejected", el("b", {}, "断られました"), ` ${row.reason ? `— ${row.reason}` : ""} (${when})`);
      if (row.status === "public") line("dim ed-note", "公開中のコースの形は変えられません。変えるときは「複製」して新しいコースとして出してください");
    }
    if (!logged) line("dim ed-note", "公開するにはログインが要ります (コースはこの機械に保存されています)");
    else if (!row || row.status === "rejected") {
      line(
        cur.lapped ? "good ed-note" : "dim ed-note",
        cur.lapped
          ? `1 周走れました${cur.bestLap !== undefined ? ` (${fmtLap(cur.bestLap)})` : ""}。公開を申し込めます`
          : "公開の条件: 問題をなくす → 「試しに走る」で自分で 1 周 → 申し込む → 管理者が確かめる",
      );
    }
  }

  function showToast(text: string) {
    toast.textContent = text;
    toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("on"), 1800);
  }

  // はじめ
  rebuild();
  refreshAll();
  remember();
  requestAnimationFrame(resize);
  void loadPub();

  return () => {
    alive = false;
    persist();
    clearTimeout(toastTimer);
    ro.disconnect();
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", onKey);
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** 0..1 に回す */
function mod1(v: number): number {
  return ((v % 1) + 1) % 1;
}

function fmtLap(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

