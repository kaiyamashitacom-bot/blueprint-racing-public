// 走る前の準備: タイヤと燃料 (と練習なら天気)。待合と練習の前に出す
import {
  TIRE_DEFS,
  TIRE_ORDER,
  allocRules,
  allocTotal,
  autoTireAlloc,
  bestTireFor,
  compoundGrip,
  fitAlloc,
  forecastWetMax,
  fuelPerMeter,
  nominalWearPerM,
  startFromAlloc,
  validateAlloc,
  type AllocRules,
  type CarSetup,
  type CarStats,
  type ForecastItem,
  type TireAlloc,
  type TireCompound,
  type TireRaceKind,
  type Track,
} from "@bpr/shared";
import { load, save, type PracticeSky, type RaceSetup } from "../store.ts";
import { el } from "./dom.ts";
import "./setup.css";

/** タイヤを使い切る目安 (これより減ると危ない) */
const WEAR_LIMIT = 0.88;
/** 練習で「レースの分」にする周の数 */
const PRACTICE_LAPS = 5;

/** そのタイヤが持つおよその周の数 */
export function tireLifeLaps(c: TireCompound, track: Track, wet: number): number {
  return WEAR_LIMIT / Math.max(1e-9, nominalWearPerM(c, wet) * track.length);
}

/** 燃料で走れるおよその周の数 */
export function fuelLaps(stats: CarStats, track: Track, litres: number): number {
  return litres / Math.max(1e-9, fuelPerMeter(stats) * track.length);
}

/** 準備の燃料 (L) */
export function setupFuel(stats: CarStats, track: Track, laps: number, mode: RaceSetup["fuel"]): number {
  const n = laps || PRACTICE_LAPS;
  const need = fuelPerMeter(stats) * (n * track.length + 100) * 1.12 + 1.5;
  if (mode === "full") return stats.fuelCap;
  if (mode === "race") return Math.min(stats.fuelCap, need);
  return Math.min(stats.fuelCap, need * 0.6);
}

/** 濡れ具合に合うタイヤの仲間: 乾いた路面用 (S・M・H) は slick、雨用は I・W */
export function fitKind(c: TireCompound): NonNullable<RaceSetup["tireFor"]> {
  return TIRE_DEFS[c].slick ? "slick" : c === "I" ? "I" : "W";
}

/** 遊ぶ人が この濡れ具合のために最初のタイヤを選んだか (前の保存は 選んだタイヤに合う路面のために選んだ扱い) */
export function choseTireFor(setup: RaceSetup, wet: number): boolean {
  return (setup.tireFor ?? fitKind(setup.tire)) === fitKind(bestTireFor(wet));
}

/** 練習で最初に履くタイヤ: この天気で選んだものがあれば それ、なければ 合うもの (大雨なら W) */
export function practiceTire(setup: RaceSetup, wet: number): TireCompound {
  return choseTireFor(setup, wet) ? setup.tire : bestTireFor(wet);
}

/** 最初のタイヤを選んだことを覚える (どの路面のために選んだかも) */
function pickTire(setup: RaceSetup, c: TireCompound, wet: number): void {
  setup.tire = c;
  setup.tireFor = fitKind(bestTireFor(wet));
}

/** レースの持っていく組を決めるもと */
export interface TireAllocCtx {
  track: Track;
  /** 0 = 練習 (決まりなし) */
  laps: number;
  /** レースの種類 (なし = 周があれば すぐ走る、なければ 練習) */
  kind?: TireRaceKind;
  qualifying?: boolean;
  /** スタートのときの濡れ具合と予報 (おまかせの組に使う) */
  wet: number;
  forecast?: ForecastItem[];
}

export interface RaceTireChoice {
  rules: AllocRules;
  /** 持っていく組 (決まりに合わせたもの) */
  alloc: TireAlloc;
  /** 最初に履く種類 */
  start: TireCompound;
  /** 遊ぶ人が決めた組か (false = おまかせ) */
  custom: boolean;
  /** 決まりに合わないわけ (大会の 2 種類など) */
  errors: string[];
}

/** 保存してある好みから、このレースで持っていく組を決める。練習 (決まりなし) は null */
export function raceTireChoice(setup: RaceSetup, c: TireAllocCtx): RaceTireChoice | null {
  const kind: TireRaceKind = c.kind ?? (c.laps > 0 ? "quick" : "practice");
  const rules = allocRules(kind, c.laps, { qualifying: c.qualifying });
  if (!Number.isFinite(rules.limit)) return null;
  const custom = !!setup.alloc && allocTotal(setup.alloc) > 0;
  const auto = () => autoTireAlloc({ trackLength: c.track.length, laps: c.laps, rules, wetStart: c.wet, wetMax: forecastWetMax(c.wet, c.forecast) });
  const fit = bestTireFor(c.wet);
  const wetFit = !TIRE_DEFS[fit].slick;
  let alloc = custom ? fitAlloc(setup.alloc!, { limit: rules.limit, minDry: 0 }, setup.tire) : auto().alloc;
  // おまかせの組は 雨用を入れ始める濡れ具合が「合う」の印 (bestTireFor) より少し高い。濡れたスタートで合う雨用がなければ 1 組入れる
  if (!custom && wetFit && !(alloc[fit] ?? 0)) alloc = fitAlloc({ ...alloc, [fit]: 1 }, { limit: rules.limit, minDry: rules.minDry }, fit);
  const has = (t: TireCompound) => (alloc[t] ?? 0) > 0;
  // 合う種類のうち持っているもの (乾いた路面なら 選んだ種類 → M → H → S)。濡れていて合う種類がなければ、持っている中で一番握るもの
  const gripBest = () => TIRE_ORDER.filter(has).sort((x, y) => compoundGrip(y, c.wet) - compoundGrip(x, c.wet))[0];
  const fitHave = wetFit ? (has(fit) ? fit : gripBest()) : [setup.tire, "M", "H", "S"].find((t): t is TireCompound => TIRE_DEFS[t as TireCompound].slick && has(t as TireCompound));
  // 最初に履く組: この天気のために自分で選んだ種類があれば それ。なければ (おまかせ・天気が変わった) 合う種類
  const start =
    custom && choseTireFor(setup, c.wet) && has(setup.tire)
      ? setup.tire
      : !custom
        ? wetFit && fitHave
          ? fitHave
          : auto().start
        : (fitHave ?? (has(setup.tire) ? setup.tire : (TIRE_ORDER.find(has) ?? setup.tire)));
  return { rules, alloc, start, custom, errors: validateAlloc(alloc, rules) };
}

/** レースの準備 (最初のタイヤと持っていく組)。練習は組なし */
export function raceTireSetup(setup: RaceSetup, c: TireAllocCtx): Pick<CarSetup, "tire" | "sets"> {
  const ch = raceTireChoice(setup, c);
  if (!ch) return { tire: practiceTire(setup, c.wet) };
  const st = startFromAlloc(ch.alloc, ch.start);
  return { tire: st.tire, sets: st.sets };
}

export interface SetupPanelOpts {
  stats: CarStats;
  track: Track;
  /** 0 = 練習 */
  laps: number;
  /** 持っていく組の決まりの種類 (なし = 周があれば すぐ走る) */
  kind?: TireRaceKind;
  /** スタートのときの濡れ具合 */
  wet: number;
  forecast?: ForecastItem[];
  /** 練習の天気を選ばせる */
  practice?: boolean;
  onChange?: () => void;
}

/** 準備の札 (押すと store に保存) */
export function setupPanel(o: SetupPanelOpts): HTMLElement {
  const box = el("div", { class: "setup" });
  const draw = () => {
    const s = load();
    box.innerHTML = "";
    const wet = o.practice ? practiceWet(s.practiceSky) : o.wet;
    const rec = bestTireFor(wet);
    const recKind = TIRE_DEFS[rec].slick ? "slick" : rec;

    // タイヤ: レースは 持っていく組の数を + − で決め、その中から最初に履く組を押す。練習は決まりなし
    const choice = o.practice ? null : raceTireChoice(s.setup, { track: o.track, laps: o.laps, kind: o.kind, wet: o.wet, forecast: o.forecast });
    if (choice) {
      box.append(...allocSection(s.setup, choice, o, wet, recKind, () => {
        save();
        draw();
        o.onChange?.();
      }));
    }
    const tires = el("div", { class: "tire-pick" });
    const curTire = practiceTire(s.setup, wet);
    for (const c of choice ? [] : TIRE_ORDER) {
      const d = TIRE_DEFS[c];
      const life = tireLifeLaps(c, o.track, wet);
      const fit = (TIRE_DEFS[c].slick ? "slick" : c) === recKind;
      const b = el(
        "button",
        { class: `tire-opt${curTire === c ? " on" : ""}`, title: d.name },
        tireBadge(c),
        el("span", { class: "nm" }, d.name),
        el("span", { class: "num life" }, life >= 20 ? "20+ 周" : `約 ${life.toFixed(1)} 周`),
        fit ? el("span", { class: "fit" }, "合う") : null,
      );
      b.addEventListener("click", () => {
        pickTire(s.setup, c, wet);
        save();
        draw();
        o.onChange?.();
      });
      tires.append(b);
    }

    // 燃料
    const fuels = el("div", { class: "seg" });
    const modes: Array<[RaceSetup["fuel"], string]> = [
      ["full", "満タン"],
      ["race", o.laps ? "レースの分" : `${PRACTICE_LAPS} 周分`],
      ["light", "少なめ"],
    ];
    for (const [m, label] of modes) {
      const L = setupFuel(o.stats, o.track, o.laps, m);
      // 周の見積もりはレースの計器と同じ (fuelLaps)。「レースの分」は 走る周 + 予備 に分けて見せる
      // (「5 周分」に「約 6.3 周」と出ていて食い違って見えた。予備は 1.12 倍と 1.5 L のゆとり)
      const est = fuelLaps(o.stats, o.track, L);
      const n = o.laps || PRACTICE_LAPS;
      const lapsTxt = m === "race" && est >= n ? `${n} 周 + 予備 ${Math.max(0, est - n).toFixed(1)}` : `約 ${est.toFixed(1)} 周`;
      const b = el(
        "button",
        { class: s.setup.fuel === m ? "on" : "" },
        el("b", {}, label),
        el("span", { class: "num" }, `${L.toFixed(1)} L · ${lapsTxt}`),
      );
      b.addEventListener("click", () => {
        s.setup.fuel = m;
        save();
        draw();
        o.onChange?.();
      });
      fuels.append(b);
    }

    if (!choice) {
      const autoPicked = !choseTireFor(s.setup, wet);
      box.append(el("div", { class: "setup-h" }, el("span", { class: "label" }, "TYRES"), el("span", { class: "dim" }, autoPicked ? "タイヤ · 天気に合うものを選びました" : "タイヤ")), tires);
    }
    box.append(
      el("div", { class: "setup-h" }, el("span", { class: "label" }, "FUEL"), el("span", { class: "dim" }, "燃料 (軽いほど速いが、足りないと止まる)")),
      fuels,
    );

    if (o.practice) {
      const skies = el("div", { class: "seg" });
      const opts: Array<[PracticeSky, string]> = [
        ["sun", "晴れ"],
        ["light", "小雨"],
        ["heavy", "大雨"],
        ["mix", "変わる"],
      ];
      for (const [k, label] of opts) {
        const b = el("button", { class: s.practiceSky === k ? "on" : "" }, el("b", {}, label));
        b.addEventListener("click", () => {
          s.practiceSky = k;
          save();
          draw();
          o.onChange?.();
        });
        skies.append(b);
      }
      box.append(el("div", { class: "setup-h" }, el("span", { class: "label" }, "WEATHER"), el("span", { class: "dim" }, "天気")), skies);
    } else {
      const fc = o.forecast ?? [];
      box.append(
        el("div", { class: "setup-h" }, el("span", { class: "label" }, "FORECAST"), el("span", { class: "dim" }, "予報 (外れることもある)")),
        el(
          "div",
          { class: "forecast-line" },
          el("span", { class: "sky" }, skyLabel(o.wet)),
          ...(fc.length ? fc.slice(0, 3).map((f) => el("span", { class: "fc" }, f.text)) : [el("span", { class: "dim" }, "しばらく変わらない見込み")]),
        ),
      );
    }
  };
  draw();
  return box;
}

/** 持っていく組の札 (見出し + 5 種類の板と + −)。板を押すと最初に履く組、+ − で組の数 */
function allocSection(setup: RaceSetup, ch: RaceTireChoice, o: SetupPanelOpts, wet: number, recKind: string, changed: () => void): HTMLElement[] {
  const total = allocTotal(ch.alloc);
  const full = total >= ch.rules.limit;
  const commit = (alloc: TireAlloc, start: TireCompound) => {
    setup.alloc = alloc;
    pickTire(setup, (alloc[start] ?? 0) > 0 ? start : (TIRE_ORDER.find((t) => (alloc[t] ?? 0) > 0) ?? start), wet);
    changed();
  };
  const auto = el("button", { class: `alloc-auto${ch.custom ? "" : " on"}`, title: "コースの長さと予報から決める" }, "おまかせ");
  auto.addEventListener("click", () => {
    delete setup.alloc;
    changed();
  });
  const head = el(
    "div",
    { class: "setup-h" },
    el("span", { class: "label" }, "TYRES"),
    el("span", { class: "dim alloc-hint" }, ch.custom && !choseTireFor(setup, wet) ? "持っていく組 · 最初の組は天気に合わせて選びました" : "持っていく組 · 押して最初に履く組"),
    el("span", { class: `alloc-count num${full ? " full" : ""}` }, `${total}`, el("small", {}, ` / ${ch.rules.limit} 組`)),
    auto,
  );
  const grid = el("div", { class: "tire-pick alloc" });
  for (const c of TIRE_ORDER) {
    const d = TIRE_DEFS[c];
    const n = ch.alloc[c] ?? 0;
    const life = tireLifeLaps(c, o.track, wet);
    const fit = (d.slick ? "slick" : c) === recKind;
    const pick = el(
      "button",
      { class: `tire-opt${ch.start === c ? " on" : ""}${n ? "" : " none"}`, title: n ? `${d.name}: 最初に履く` : `${d.name}: 1 組足して最初に履く` },
      tireBadge(c),
      el("span", { class: "nm" }, d.name),
      el("span", { class: "num life" }, life >= 20 ? "20+ 周" : `約 ${life.toFixed(1)} 周`),
      fit ? el("span", { class: "fit" }, "合う") : null,
    );
    if (!n && full) (pick as HTMLButtonElement).disabled = true;
    pick.addEventListener("click", () => commit(n ? { ...ch.alloc } : { ...ch.alloc, [c]: 1 }, c));
    const minus = el("button", { class: "st", "aria-label": `${d.name} を 1 組減らす` }, "−");
    const plus = el("button", { class: "st", "aria-label": `${d.name} を 1 組足す` }, "+");
    if (!n || total <= 1) (minus as HTMLButtonElement).disabled = true;
    if (full) (plus as HTMLButtonElement).disabled = true;
    minus.addEventListener("click", () => {
      const a = { ...ch.alloc, [c]: n - 1 };
      if (!a[c]) delete a[c];
      commit(a, ch.start);
    });
    plus.addEventListener("click", () => commit({ ...ch.alloc, [c]: n + 1 }, ch.start));
    grid.append(el("div", { class: `tire-slot${n ? "" : " empty"}` }, pick, el("div", { class: "tire-step" }, minus, el("span", { class: "num" }, `×${n}`), plus)));
  }
  if (ch.errors.length) grid.append(el("div", { class: "alloc-err" }, ch.errors[0]));
  else if (!(["I", "W"] as const).some((c) => (ch.alloc[c] ?? 0) > 0)) grid.append(el("div", { class: "alloc-note" }, "雨用なし: 雨になっても乾いたタイヤのまま"));
  return [head, grid];
}

export function practiceWet(sky: PracticeSky): number {
  return sky === "light" ? 0.5 : sky === "heavy" ? 0.95 : 0;
}

/** タイヤの丸い印 (色の輪と 1 文字) */
export function tireBadge(c: TireCompound, wear?: number): HTMLElement {
  const d = TIRE_DEFS[c];
  const b = el("span", { class: "tire-badge", style: `--tc:${d.color}` }, d.short);
  if (wear !== undefined) b.style.setProperty("--wear", String(Math.max(0, Math.min(1, wear))));
  return b;
}

export function skyLabel(wet: number): string {
  if (wet < 0.08) return "☀ 乾いた路面";
  if (wet < 0.4) return "☂ 少し濡れている";
  if (wet < 0.75) return "☂ 濡れている";
  return "☔ びしょびしょ";
}
