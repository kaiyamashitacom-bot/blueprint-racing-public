// 無線の作戦係の札 (中継の「チーム無線」の字幕のように)。中身は shared/src/radio.ts。
// レースの画面 (view.ts) が表示の刻みごとに tick を呼ぶ。ほかの車のタイヤ・周・ピットの回数は snap から (noteSnap)。
// 札は順位の塔の下 (左上) に出し、数秒で消える。ピットのすすめがあれば「そうする」で予約できる (Mac は R)。
// 道・車・計器・ボタン・塔にはかぶせない (塔の下にずらし、幅は画面の半分まで)。
import {
  damageCount,
  overtakeGauge,
  engineerName,
  estimateLapTime,
  forecastAt,
  fuelPerMeter,
  newRadioState,
  stepRadio,
  wetnessAt,
  type CarState,
  type CarStats,
  type FlagInfo,
  type LapState,
  type PitOrder,
  type RadioMessage,
  type RadioRival,
  type RadioSituation,
  type RadioState,
  type TireCompound,
  type Track,
  type WeatherPlan,
} from "@bpr/shared";
import { el } from "../ui/dom.ts";
import { tireLifeLaps } from "../ui/setup.ts";
import { sfx } from "../audio/core.ts";

/** 表示の刻みごとに view.ts から渡すもの */
export interface RadioFeed {
  /** 信号が消えてからの秒 */
  t: number;
  car: CarState;
  stats: CarStats;
  track: Track;
  /** 0 = 練習 */
  laps: number;
  lap: LapState;
  weather: WeatherPlan | null | undefined;
  flag: FlagInfo | null;
  /** 発進した (合図のあと) */
  started: boolean;
}

export interface RadioUIOpts {
  /** 自分の id (snap から自分を除く) */
  myId: string;
  /** 運転手の名前 (作戦係の名前を決める) と色 */
  driver: string;
  color?: string;
  /** 「そうする」: ピットを予約する。予約できなければ false */
  onPit: (order: PitOrder) => boolean | void;
}

/** snap から覚えておく、ほかの車の様子 */
interface OtherNote {
  dist: number;
  flags: number;
  v: number;
  tire: TireCompound | null;
  tyreLaps: number | null;
  pitStops: number | null;
}

/** snap の印 (protocol.ts と同じ) */
const F_FIN = 1;
const F_RET = 2;
const F_PIT = 8;
const F_BURST = 64;

const TIRES = new Set(["S", "M", "H", "I", "W"]);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 予約したと見せる秒 (仮) */
const DONE_MS = 1600;
/** 待たせた無線を捨てるまで (ms、仮) */
const PENDING_MS = 8000;

export class RadioUI {
  private card: HTMLElement;
  private who: HTMLElement;
  private text: HTMLElement;
  private pitRow: HTMLElement;
  private pitLabel: HTMLElement;
  private yes: HTMLButtonElement;
  private state: RadioState = newRadioState();
  private others = new Map<string, OtherNote>();
  private msg: RadioMessage | null = null;
  private pending: { m: RadioMessage; at: number } | null = null;
  private until = 0;
  private topKey = "";
  private destroyed = false;

  constructor(
    private hud: HTMLElement,
    private o: RadioUIOpts,
  ) {
    this.who = el("span", { class: "rc-who" }, `作戦係 ${engineerName(o.driver)}`);
    this.text = el("div", { class: "rc-text" });
    this.pitLabel = el("span", { class: "rc-pl" });
    this.yes = el("button", { class: "rc-yes", tabindex: "-1" }, "そうする") as HTMLButtonElement;
    this.yes.addEventListener("click", (e) => {
      e.preventDefault();
      this.accept();
    });
    this.pitRow = el("div", { class: "rc-pit" }, el("span", { class: "rc-pk" }, "PIT"), this.pitLabel, this.yes);
    this.card = el(
      "div",
      { class: "radio-card", role: "status", "aria-live": "polite" },
      el("div", { class: "rc-head" }, el("b", { class: "rc-tag" }, "RADIO"), this.who, el("span", { class: "rc-wave" }, el("i"), el("i"), el("i"), el("i"))),
      this.text,
      this.pitRow,
    );
    if (o.color) this.card.style.setProperty("--rc", o.color);
    this.card.style.display = "none";
    hud.append(this.card);
    window.addEventListener("keydown", this.onKey);
  }

  /** snap (ほかの車) を覚える。[id, x, y, 向き, 道のり, 印, 周, 速さ x, 速さ y, タイヤ?, タイヤの周?, ピットの回数?] */
  noteSnap(cars: ReadonlyArray<readonly unknown[]>) {
    for (const c of cars) {
      const id = c[0];
      if (typeof id !== "string" || id === this.o.myId) continue;
      const dist = num(c[4]);
      if (dist === null) continue;
      const tire = typeof c[9] === "string" && TIRES.has(c[9]) ? (c[9] as TireCompound) : null;
      this.others.set(id, {
        dist,
        flags: num(c[5]) ?? 0,
        v: Math.hypot(num(c[7]) ?? 0, num(c[8]) ?? 0),
        tire,
        tyreLaps: num(c[10]),
        pitStops: num(c[11]),
      });
    }
  }

  /** 表示の刻みごと: 様子から無線を決めて、札を出す・消す */
  tick(f: RadioFeed) {
    if (this.destroyed) return;
    // ゴール・リタイアのあとは札を下げる (「最後の周だ」が残らないように)
    if (f.lap.finished || f.lap.retired) {
      this.pending = null;
      if (this.msg) this.hide();
      return;
    }
    this.place();
    const sit = this.situation(f);
    const r = stepRadio(sit, this.state);
    this.state = r.state;
    const now = performance.now();
    const m = r.messages[0];
    if (m) {
      if (!this.msg || now >= this.until || m.priority >= this.msg.priority) this.show(m, now);
      // 今の札より軽い無線は、札が消えたあとに出す (古くなったら捨てる)
      else this.pending = { m, at: now };
    }
    // ピットに入った・予約した あとは、すすめを引っこめる
    if (this.msg?.pit && (f.car.pit || f.car.pitOrder) && this.card.dataset.state !== "done") this.pitRow.style.display = "none";
    if (this.msg && now >= this.until) {
      this.hide();
      const p = this.pending;
      this.pending = null;
      if (p && now - p.at < PENDING_MS && !f.car.pit) this.show(p.m, now);
    }
  }

  /** 今のレースの様子 (radio.ts に渡す) */
  situation(f: RadioFeed): RadioSituation {
    const { car, stats, track } = f;
    const L = track.length;
    const t = Math.max(0, f.t);
    const plan = f.weather ?? null;
    const wet = plan ? wetnessAt(plan, t) : 0;
    const wetSoon = plan ? Math.max(wet, wetnessAt(plan, t + 60) * 0.9) : 0;
    const lapTime = f.lap.lastLap ?? estimateLapTime(stats, track);
    const mySpeed = Math.hypot(car.vx, car.vy);
    const avg = L / Math.max(5, lapTime);
    // 前と後ろ: コースの上で一番近い車 (道のりの差を 1 周の中に直す)
    let ahead: { id: string; d: number; n: OtherNote } | null = null;
    let behind: { id: string; d: number; n: OtherNote } | null = null;
    for (const [id, n] of this.others) {
      if (n.flags & (F_FIN | F_RET)) continue;
      let d = (n.dist - car.dist) % L;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      if (d > 0 && (!ahead || d < ahead.d)) ahead = { id, d, n };
      if (d <= 0 && (!behind || d > behind.d)) behind = { id, d, n };
    }
    const rival = (r: { id: string; d: number; n: OtherNote } | null, v: number): RadioRival | null => {
      if (!r) return null;
      const n = r.n;
      let wear: number | null = null;
      if (n.flags & F_BURST) wear = 1;
      else if (n.tire && n.tyreLaps !== null) wear = Math.min(1, ((n.tyreLaps + 0.5) / Math.max(0.5, tireLifeLaps(n.tire, track, wet))) * 0.88);
      return { id: r.id, gap: Math.abs(r.d) / Math.max(10, (v + avg) / 2), tire: n.tire, tyreLaps: n.tyreLaps, pitStops: n.pitStops, wear, inPit: !!(n.flags & F_PIT) };
    };
    const drs = car.drs;
    const dc = damageCount(car);
    return {
      t: f.t,
      started: f.started && car.started,
      finished: f.lap.finished,
      retired: f.lap.retired,
      lapsDone: f.lap.lapsDone,
      totalLaps: f.laps,
      lapsLeft: f.laps ? Math.max(0, f.laps - car.dist / L) : Infinity,
      lapLength: L,
      lapTime,
      toPitEntry: (((track.pit.entry - car.dist) % L) + L) % L,
      tire: car.tire,
      wear: car.wear,
      burst: car.burst,
      tireLife: tireLifeLaps(car.tire, track, wet),
      sets: car.sets ?? null,
      fuel: car.fuel,
      fuelCap: stats.fuelCap,
      fuelPerLap: fuelPerMeter(stats) * L,
      wet,
      wetSoon,
      forecast: plan ? forecastAt(plan, t) : [],
      flag: f.flag ? { mode: f.flag.mode, ending: f.flag.ending, drs: f.flag.drs } : null,
      pitBooked: !!car.pitOrder,
      inPit: !!car.pit,
      damage: car.damage?.out ? null : dc,
      drsGap: drs && !drs.open && drs.armed >= 0 && Number.isFinite(drs.gap) ? drs.gap : null,
      ot: car.ot ? { armed: car.ot.armed, ok: car.ot.ok, energy: overtakeGauge(car) } : null,
      ahead: rival(ahead, mySpeed),
      behind: rival(behind, behind ? behind.n.v : mySpeed),
    };
  }

  private show(m: RadioMessage, now: number) {
    this.msg = m;
    this.until = now + m.ttl * 1000;
    this.card.dataset.state = "";
    this.card.dataset.k = m.key;
    this.card.className = `radio-card${m.priority >= 85 ? " urgent" : ""}`;
    this.text.textContent = m.text;
    if (m.pit) {
      this.pitLabel.textContent = m.pit.label;
      this.yes.textContent = "そうする";
      this.yes.disabled = false;
      this.pitRow.style.display = "";
    } else {
      this.pitRow.style.display = "none";
    }
    this.card.style.display = "";
    sfx.radio(m.priority >= 85);
    // 出るときの動き (やり直す)
    this.card.classList.remove("in");
    void this.card.offsetWidth;
    this.card.classList.add("in");
  }

  /** 札が出ている (音: 曲を絞る) */
  get visible(): boolean {
    return this.msg !== null && !this.destroyed;
  }

  private hide() {
    this.msg = null;
    this.card.style.display = "none";
  }

  /** 「そうする」: すすめのピットを予約する */
  private accept() {
    const m = this.msg;
    if (!m?.pit || this.yes.disabled) return;
    const ok = this.o.onPit(m.pit.order);
    this.yes.blur();
    this.yes.disabled = true;
    this.card.dataset.state = "done";
    this.yes.textContent = ok === false ? "できない" : "予約した ✓";
    this.until = performance.now() + DONE_MS;
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat || this.card.style.display === "none") return;
    if ((e.key === "r" || e.key === "R") && this.msg?.pit && this.pitRow.style.display !== "none") this.accept();
  };

  /** 塔の下に置く (塔の高さは画面の幅や行の数で変わる) */
  private place() {
    const tower = this.hud.querySelector<HTMLElement>(".tower");
    const top = tower && tower.offsetParent ? tower.offsetTop + tower.offsetHeight + 8 : 0;
    const key = String(top);
    if (key === this.topKey) return;
    this.topKey = key;
    if (top) this.card.style.top = `${top}px`;
    else this.card.style.removeProperty("top");
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener("keydown", this.onKey);
    this.card.remove();
  }
}
