// セクター (区間タイム) の表示 (計算は shared/src/sectors.ts)。
// 時間の下の帯: S1・S2・S3 の今の周 (済んだ区間は色: 紫 = その場で一番・緑 = 自己ベスト・黄 = 遅い) と前の周。
// 切れ目を通ると少しのあいだ区間のタイムと差を出す (レースは自己ベストとの差、練習は幽霊か自己ベストとの差)。
// ほかの車のタイムは snap (道のりと時刻) から数える (view.ts の印と同じ)。塔の行の下にも小さな色の帯。数は全部 (仮)。
import {
  LAP_SECTORS,
  SectorTimer,
  formatSector,
  formatSectorDelta,
  formatTime,
  sectorColor,
  sectorSplits,
  sessionBestSectors,
  type SectorColor,
  type SectorCross,
  type Track,
} from "@bpr/shared";
import { el } from "../ui/dom.ts";
import { SECTOR_TINTS } from "./trackdraw.ts";

/** 切れ目を通ったときの札を出す時間 (ms、仮) */
const FLASH_MS = 3000;

/** 結果の札に渡す 1 台分 */
export interface SectorSummary {
  id: string;
  best: Array<number | null>;
  ideal: number | null;
}

export class SectorHud {
  private timers = new Map<string, SectorTimer>();
  private readonly splits: [number, number];
  readonly bar: HTMLElement;
  private flashEl: HTMLElement;
  private cells: Array<{ box: HTMLElement; now: HTMLElement; sub: HTMLElement }> = [];
  private idealEl: HTMLElement;
  private flashUntil = 0;
  /** 練習の差の相手の札 (GHOST / BEST) */
  private refKind: "GHOST" | "BEST" | "" = "";
  /** 切れ目ごとの差 (今の周。練習で帯に出す) */
  private deltas = new Map<string, number>();
  /** 練習の幽霊の 3 つのタイム (紫の基準に入れる: 幽霊より速い区間が紫) */
  private ghost: ReadonlyArray<number | null> | null = null;

  constructor(
    hud: HTMLElement,
    private track: Track,
    private opts: { practice: boolean; myId: string | null },
  ) {
    this.splits = sectorSplits(track.def);
    this.bar = el("div", { class: `secbar${opts.practice ? " practice" : ""}` });
    for (let i = 0; i < LAP_SECTORS; i++) {
      const now = el("span", { class: "sv num" }, "--.---");
      const sub = el("span", { class: "ss num" });
      const box = el("div", { class: "sc" }, el("span", { class: "sk", style: `--tint:${SECTOR_TINTS[i]}` }, `S${i + 1}`), now, sub);
      this.cells.push({ box, now, sub });
      this.bar.append(box);
    }
    this.idealEl = el("span", { class: "sv num" }, "--:--.---");
    this.bar.append(el("div", { class: "sc ideal", title: "一番速いセクターの合計 (理論上の一番速い周)" }, el("span", { class: "sk" }, "IDEAL"), this.idealEl, el("span", { class: "ss" })));
    this.flashEl = el("div", { class: "secflash" });
    this.bar.style.display = opts.myId ? "" : "none";
    hud.append(this.bar, this.flashEl);
  }

  timer(id: string): SectorTimer {
    let t = this.timers.get(id);
    // 自分の車は スタートの線を刻みの時刻で (周の時間と合計が合う)。ほかの車は snap の間を割る
    if (!t) this.timers.set(id, (t = new SectorTimer(this.track.length, this.splits, 0, id === this.opts.myId)));
    return t;
  }

  /** ほかの車の snap (時刻はスタートの合図からの秒) */
  pushOther(id: string, t: number, dist: number) {
    this.timer(id).push(t, dist);
  }

  /**
   * 自分の車 (毎刻み)。ghost = 練習の幽霊の 3 つのタイム (なければ null、自己ベストと比べる)。
   * 切れ目を通ったら札を出し、越えた切れ目を返す
   */
  pushMine(id: string, t: number, dist: number, valid: boolean, ghost: ReadonlyArray<number | null> | null): SectorCross[] {
    if (this.opts.practice) this.ghost = ghost;
    const tm = this.timer(id);
    const prevBest = tm.best.slice();
    const cs = tm.push(t, dist, valid);
    for (const c of cs) this.flash(id, c, ghost, prevBest);
    return cs;
  }

  private flash(id: string, c: SectorCross, ghost: ReadonlyArray<number | null> | null, prevBest: Array<number | null>) {
    const g = this.opts.practice ? (ghost?.[c.sector] ?? null) : null;
    const ref = g ?? prevBest[c.sector];
    this.refKind = g !== null ? "GHOST" : ref !== null ? "BEST" : "";
    const d = ref !== null && c.valid ? c.time - ref : null;
    this.deltas.set(`${c.lap}|${c.sector}`, d ?? NaN);
    const color = this.colorOf(id, c.time, c.valid, c.sector);
    this.flashEl.className = `secflash ${color}`;
    const kids = [
      el("b", {}, `S${c.sector + 1}`),
      el("span", { class: "num ft" }, formatSector(c.time)),
      d === null ? null : el("span", { class: `num fd ${d <= 0 ? "good" : "bad"}` }, formatSectorDelta(d)),
      d === null ? null : el("small", {}, this.refKind === "GHOST" ? "GHOST" : "BEST"),
      c.valid ? null : el("small", {}, "数えない"),
    ];
    this.flashEl.replaceChildren(...kids.filter((k): k is HTMLElement => k !== null));
    this.flashUntil = performance.now() + FLASH_MS;
  }

  /** ほかの車の一番速い周 (3 区間とも数えた周の合計、秒。なければ Infinity)。音の「その場の一番」に使う。周を走り終えたときだけ呼ぶ */
  fastestOtherLap(myId: string | null): number {
    let best = Infinity;
    for (const [id, tm] of this.timers) {
      if (id === myId) continue;
      for (const l of tm.laps.values()) {
        const [a, b, c] = l.times;
        if (a === null || b === null || c === null || !l.valid[0] || !l.valid[1] || !l.valid[2]) continue;
        if (a + b + c < best) best = a + b + c;
      }
    }
    return best;
  }

  /** その場の一番 (全員の自己ベストから。練習は幽霊も入れる) */
  private sessionBest() {
    const list = [...this.timers].map(([id, t]) => ({ id, best: t.best }));
    if (this.ghost) list.push({ id: "\u0000ghost", best: [...this.ghost] });
    return sessionBestSectors(list);
  }

  private colorOf(id: string, time: number, valid: boolean, k: number, sb = this.sessionBest()): SectorColor {
    return sectorColor(time, valid, this.timers.get(id)?.best[k] ?? null, sb[k]?.time ?? null);
  }

  /** 帯を書きかえる (0.1 秒ごと)。t = 今の時刻 (合図からの秒) */
  paint(t: number, id: string, running: boolean) {
    const show = running ? "" : "none";
    if (this.bar.style.display !== show) this.bar.style.display = show;
    const fs = performance.now() < this.flashUntil ? "flex" : "none";
    if (this.flashEl.style.display !== fs) this.flashEl.style.display = fs;
    if (!running) return;
    const tm = this.timer(id);
    const cur = tm.current();
    const sb = this.sessionBest();
    const lap = cur ? Math.max(0, cur.lap) : 0;
    const now = tm.lap(lap);
    const last = tm.lap(lap - 1);
    for (let k = 0; k < LAP_SECTORS; k++) {
      const c = this.cells[k];
      const v = now?.times[k] ?? null;
      let txt = "";
      let cls = "sc";
      if (v !== null) {
        txt = formatSector(v);
        cls += ` ${this.colorOf(id, v, now!.valid[k], k, sb)}`;
      } else if (cur && cur.lap === lap && cur.sector === k && cur.start !== null && t >= cur.start) {
        txt = formatSector(t - cur.start);
        cls += " live";
      } else {
        txt = "—";
        cls += " wait";
      }
      setText(c.now, txt);
      setClass(c.box, cls);
      // 下の字: 練習は差 (幽霊か自己ベスト)、レースは前の周
      let sub = "";
      let subCls = "ss num";
      const dk = this.deltas.get(`${lap}|${k}`);
      if (this.opts.practice && v !== null && dk !== undefined && Number.isFinite(dk)) {
        sub = formatSectorDelta(dk);
        subCls += dk <= 0 ? " good" : " bad";
      } else {
        const lv = last?.times[k] ?? null;
        if (lv !== null) {
          sub = formatSector(lv);
          subCls += ` ${this.colorOf(id, lv, last!.valid[k], k, sb)}`;
        }
      }
      setText(c.sub, sub);
      setClass(c.sub, subCls);
    }
    const ideal = tm.ideal();
    setText(this.idealEl, ideal === null ? "--:--.---" : formatTime(ideal));
  }

  /** 塔の行の下の小さな帯 (今の周の済んだ区間の色) */
  paintMini(box: HTMLElement, id: string) {
    const tm = this.timers.get(id);
    const cur = tm?.current();
    let key = "";
    if (tm && cur) {
      const l = tm.lap(Math.max(0, cur.lap));
      const sb = this.sessionBest();
      for (let k = 0; k < LAP_SECTORS; k++) {
        const v = l?.times[k] ?? null;
        key += v === null ? (cur.sector === k && cur.lap >= 0 ? "l" : "-") : this.colorOf(id, v, l!.valid[k], k, sb)[0];
      }
    }
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    const name: Record<string, string> = { p: "purple", g: "green", y: "yellow", v: "void", l: "live", "-": "" };
    if (box.children.length !== LAP_SECTORS) box.replaceChildren(el("i"), el("i"), el("i"));
    [...box.children].forEach((c, k) => ((c as HTMLElement).className = name[key[k] ?? "-"] ?? ""));
  }

  /** 結果の札: 走った車の一番速いセクター */
  summary(): SectorSummary[] {
    return [...this.timers].map(([id, t]) => ({ id, best: t.best.slice(), ideal: t.ideal() }));
  }

  /** 走った線の記録に付ける 周ごとのタイム */
  record(id: string): Record<number, Array<number | null>> {
    return this.timer(id).toRecord();
  }
}

/**
 * 結果の札のセクター: 自分の一番速いセクターと理論上の一番速い周の 1 行。押すと全員の表。
 * 紫 = その場で一番。names = 車の id → 名前 (並びは結果の順)
 */
export function sectorResults(list: SectorSummary[], order: Array<{ id: string; name: string; color: string }>, myId: string): HTMLElement | null {
  const by = new Map(list.map((s) => [s.id, s]));
  const rows = order.filter((o) => by.get(o.id)?.best.some((b) => b !== null));
  if (!rows.length) return null;
  const sb = sessionBestSectors(rows.map((o) => by.get(o.id)!));
  const cell = (s: SectorSummary, k: number) => {
    const v = s.best[k];
    return el("td", { class: `num r${v !== null && sb[k] && sb[k]!.id === s.id ? " purple" : ""}` }, formatSector(v));
  };
  const mine = by.get(myId);
  const line = el(
    "div",
    { class: "sec-mine" },
    el("span", { class: "k" }, "BEST SECTORS"),
    ...(mine
      ? [
          ...[0, 1, 2].map((k) => el("span", { class: `num${mine.best[k] !== null && sb[k]?.id === myId ? " purple" : ""}` }, el("small", {}, `S${k + 1} `), formatSector(mine.best[k]))),
          el("span", { class: "num" }, el("small", {}, "IDEAL "), formatTime(mine.ideal)),
        ]
      : [el("span", { class: "dim" }, "—")]),
  );
  const table = el(
    "table",
    { class: "results sec-table" },
    el("tr", {}, el("th", {}, "DRIVER"), el("th", { class: "r" }, "S1"), el("th", { class: "r" }, "S2"), el("th", { class: "r" }, "S3"), el("th", { class: "r" }, "IDEAL")),
    ...rows.map((o) => {
      const s = by.get(o.id)!;
      return el(
        "tr",
        { class: o.id === myId ? "me" : "" },
        el("td", { class: "who" }, el("span", { class: "bar", style: `background:${o.color}` }), o.name),
        cell(s, 0),
        cell(s, 1),
        cell(s, 2),
        el("td", { class: "num r" }, formatTime(s.ideal)),
      );
    }),
  );
  table.hidden = true;
  const toggle = el("button", { class: "small ghost sec-toggle" }, "全員のセクター");
  toggle.addEventListener("click", () => {
    table.hidden = !table.hidden;
    toggle.textContent = table.hidden ? "全員のセクター" : "閉じる";
  });
  return el("div", { class: "sec-results" }, el("div", { class: "sec-line" }, line, toggle), table);
}

function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}
function setClass(e: HTMLElement, c: string) {
  if (e.className !== c) e.className = c;
}
