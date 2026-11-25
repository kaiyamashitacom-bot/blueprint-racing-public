// 操作: ハンドル ◀ ▶・アクセル・ブレーキ (11/25 加速・減速を足した)。
// スマホは画面の下のボタン (◀ ▶ は指をすべらせて切りかえられる)。Mac は ← → (A D)・↑ (W)・↓ (S)。
// かんたん操作ではアクセルは自動。
// ハンドルは押してすぐ いっぱいにならず、0.07 秒で切れて 0.05 秒で戻る (11/25 試走「キーのハンドルが敏感」→ 2 回目「曲がらなさすぎ」で速くした。physics.ts の rampSteer)。
// オーバーテイクモードは Q を押している間 (画面のボタンは view.ts)。
// マニュアル (パソコンだけ): 段を上げる X か Shift、下げる Z か Ctrl (gearbox.ts)。
import { DT, GEAR_COUNT, rampSteer } from "@bpr/shared";
import { el } from "../ui/dom.ts";

type PadName = "left" | "right" | "brake" | "throttle";

export class Controls {
  /** 今のハンドルの切れ (-1..1)。steer() を呼ぶたびに 1 刻み進む */
  private steerNow = 0;
  private pointers = new Map<number, PadName | null>();
  private keys = new Set<string>();
  private goListeners: Array<() => void> = [];
  private cleanup: Array<() => void> = [];
  private pads = new Map<PadName, HTMLElement>();
  /** マニュアルの今の段 (1..7) */
  private gearNow = 1;
  /** 画面のオーバーテイクのボタンを押している (view.ts が書く) */
  otHeld = false;

  constructor(
    host: HTMLElement,
    private assist: boolean,
    /** マニュアル (自分で変速)。なし = オートマ */
    private manual = false,
  ) {
    const box = el("div", { class: "pads" });
    const mk = (name: PadName, ...kids: Array<Node | string>) => {
      const p = el("div", { class: `pad ${name}`, "data-pad": name }, ...kids);
      this.pads.set(name, p);
      box.append(p);
    };
    mk("left", "◀");
    mk("right", "▶");
    if (!assist) {
      mk("brake", "ブレーキ", el("small", {}, "BRAKE"));
      mk("throttle", "アクセル", el("small", {}, "GAS"));
    }
    host.append(box);

    const padAt = (x: number, y: number): PadName | null => {
      const e = document.elementFromPoint(x, y) as HTMLElement | null;
      const p = e?.closest?.(".pad") as HTMLElement | null;
      return (p?.dataset.pad as PadName) ?? null;
    };
    const down = (ev: PointerEvent) => {
      const p = (ev.target as HTMLElement).closest?.(".pad") as HTMLElement | null;
      if (!p) return;
      ev.preventDefault();
      this.pointers.set(ev.pointerId, p.dataset.pad as PadName);
      this.fireGo();
    };
    const move = (ev: PointerEvent) => {
      if (!this.pointers.has(ev.pointerId)) return;
      const cur = this.pointers.get(ev.pointerId);
      const at = padAt(ev.clientX, ev.clientY);
      // ◀ ▶ の間だけ すべらせて切りかえる
      if ((cur === "left" || cur === "right") && (at === "left" || at === "right")) this.pointers.set(ev.pointerId, at);
    };
    const up = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
    };
    const kd = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", "a", "d", "w", "s", " ", "q"].includes(k)) ev.preventDefault();
      if (this.manual && ["x", "z", "shift", "control"].includes(k) && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        if (!ev.repeat) this.shift(k === "x" || k === "shift" ? 1 : -1);
        return;
      }
      if (ev.repeat) return;
      this.keys.add(k);
      if (this.assist || k === "arrowup" || k === "w") this.fireGo();
    };
    const ku = (ev: KeyboardEvent) => this.keys.delete(ev.key.toLowerCase());
    const blur = () => {
      this.keys.clear();
      this.pointers.clear();
    };
    box.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    this.cleanup.push(
      () => box.removeEventListener("pointerdown", down),
      () => window.removeEventListener("pointermove", move),
      () => window.removeEventListener("pointerup", up),
      () => window.removeEventListener("pointercancel", up),
      () => window.removeEventListener("keydown", kd),
      () => window.removeEventListener("keyup", ku),
      () => window.removeEventListener("blur", blur),
      () => box.remove(),
    );
  }

  /** 発進の合図 (アクセルを踏んだ。かんたん操作ではどれかを押した) */
  onGo(fn: () => void) {
    this.goListeners.push(fn);
  }

  private fireGo() {
    if (!this.assist && !this.pressed("throttle")) return;
    for (const f of this.goListeners) f();
  }

  private pressed(name: PadName): boolean {
    for (const p of this.pointers.values()) if (p === name) return true;
    switch (name) {
      case "left":
        return this.keys.has("arrowleft") || this.keys.has("a");
      case "right":
        return this.keys.has("arrowright") || this.keys.has("d");
      case "throttle":
        return this.keys.has("arrowup") || this.keys.has("w");
      case "brake":
        return this.keys.has("arrowdown") || this.keys.has("s") || this.keys.has(" ");
    }
  }

  /** マニュアルの段を 1 つ上げる (+1) / 下げる (-1) */
  shift(d: number) {
    this.gearNow = Math.max(1, Math.min(GEAR_COUNT, this.gearNow + Math.sign(d)));
  }
  /** マニュアルの今の段 (オートマは undefined) */
  gear(): number | undefined {
    return this.manual ? this.gearNow : undefined;
  }
  get isManual() {
    return this.manual;
  }
  /** オーバーテイクモードのボタン (Q か画面のボタン) */
  overtake(): boolean {
    return this.otHeld || this.keys.has("q");
  }

  /** 1 刻み (dt 秒) 進めたハンドルの切れ。刻みごとに 1 回だけ呼ぶ */
  steer(dt = DT): number {
    const target = (this.pressed("left") ? -1 : 0) + (this.pressed("right") ? 1 : 0);
    this.steerNow = rampSteer(this.steerNow, target, dt);
    return this.steerNow;
  }
  throttle(): number {
    return this.pressed("throttle") ? 1 : 0;
  }
  brake(): number {
    return this.pressed("brake") ? 1 : 0;
  }
  get isAssist() {
    return this.assist;
  }

  /** ボタンの見た目 (押している間は明るく) */
  paint() {
    for (const [name, p] of this.pads) p.classList.toggle("on", this.pressed(name));
  }

  destroy() {
    for (const c of this.cleanup) c();
  }
}
