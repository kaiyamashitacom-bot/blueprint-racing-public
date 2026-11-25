// 音の入り口。外の音の素材は使わず、全部 Web Audio で作る (仮の音。素材を入れるときは使用条件をユーザーに確かめる)
//   installAudio()            main.ts から 1 回 (最初に触ったら鳴らせるようにする・ボタンの音・裏に回ったら止める)
//   setScreenMusic(style)     画面の曲 (メニュー・車づくり)
//   new RaceAudio()           レースの画面 (view.ts) が毎こま frame() を呼ぶ
//   soundSettingRows()        メニューの設定の 効果音 / 曲 / 音量
import { audioCtx, rawCtx, claimRaceMusic, getSettings, installAudio as installCore, noise, onSettings, setDuck, setSettings, sfx, sfxOut } from "./core.ts";
import { flagCue, impactLevel, lapChime, otherHitStrength, spatial, newSpatialOut, wheelGunTimes } from "./params.ts";
import { RaceFrame, RaceSound } from "./race.ts";
import { el } from "../ui/dom.ts";

export { setScreenMusic, sfx, getSettings, setSettings } from "./core.ts";
export { RaceFrame } from "./race.ts";
export { pitWork } from "./pitwork.ts";
export { flagLevel, lateralSlip } from "./params.ts";

/** 手ざわりの音を出さないボタン (レースの操作と DRS は別の音) */
const NO_CLICK = ".pads, .drs-btn, .ot-btn";

export function installAudio() {
  installCore((e) => {
    const t = e.target as Element | null;
    const b = t?.closest?.("button");
    if (!b || (b as HTMLButtonElement).disabled || b.closest(NO_CLICK)) return;
    sfx.click();
  });
}

/** レースの音の重さを測る (開発のときだけ window.__bprAudio に出す) */
export const audioPerf = { frames: 0, ms: 0, maxMs: 0 };
if (import.meta.env?.DEV && typeof window !== "undefined") (window as unknown as { __bprAudio: unknown }).__bprAudio = { perf: audioPerf, settings: getSettings, ctx: rawCtx };

/** ぶつかりの音を出すしきい (m/s、仮): 壁・車 */
const WALL_THR = 2;
const CAR_THR = 1.2;
/** ほかの車のぶつかり (仮): 大きさの倍 (遠さの大きさにさらに掛ける)・続けて鳴らさない間 (ms)・自分のぶつかりのすぐあとは鳴らさない (ms)・鳴らす一番小さい遠さの大きさ */
const OTHER_HIT_VOL = 0.55;
const OTHER_HIT_GAP = 180;
const OTHER_HIT_AFTER_MINE = 300;
const OTHER_HIT_MIN_GAIN = 0.04;
/** ホイールガンの左右 (仮) */
const GUN_PAN = 0.35;

export class RaceAudio {
  /** view.ts が毎こま書く入れ物 */
  readonly f = new RaceFrame();
  /** このこまのあいだの壁と車のぶつかりの強さ (view.ts の simulate が大きい方を残す) */
  wallHit = 0;
  carHit = 0;
  private sound: RaceSound | null = null;
  private release = claimRaceMusic();
  private prevT = Number.NaN;
  private prevDrs = false;
  private prevOt = false;
  private lastImpact = 0;
  private lastOtherHit = 0;
  /** ほかの車の前の snap (番号ごと。数が変わったら読み直す) */
  private oPrevSpd = new Float32Array(32);
  private oPrevX = new Float32Array(32);
  private oPrevY = new Float32Array(32);
  private oPrevAt = new Float64Array(32);
  private oPrevCount = -1;
  private sp = newSpatialOut();
  private prevFlag = -1;
  private prevFinished = false;
  private prevChequered = false;
  /** ピットの作業: 前のこまの止まってからの秒 (-1 = 止まっていない) とホイールガンの時刻 */
  private prevPitT = -1;
  private guns = new Float32Array(16);
  private offSettings = onSettings(() => {
    if (!getSettings().sfx) this.dropSound();
  });

  /** 毎こま: t = 合図からの秒・ls = 1 つ目の信号の秒・radio = 無線の札が出ている・drs = 羽根が開いている・ot = オーバーテイクモードを使っている */
  frame(t: number, ls: number, radio: boolean, drs: boolean, ot = false) {
    const t0 = performance.now();
    const ctx = audioCtx();
    const out = sfxOut();
    if (ctx && out && !this.sound) this.sound = new RaceSound(ctx, out, noise());
    this.sound?.update(this.f);

    // スタートの信号: 1 つ点くごとに短い音、全部消えたら高い音
    const pt = this.prevT;
    if (pt === pt && t - pt < 0.5) {
      for (let i = 0; i < 5; i++) if (pt < ls + i && t >= ls + i && ls + i < 0) sfx.lightBeep();
      if (pt < 0 && t >= 0) sfx.lightsOut();
    }
    this.prevT = t;
    setDuck(radio || (t >= ls - 1 && t < 0.6));

    if (drs !== this.prevDrs) {
      this.prevDrs = drs;
      sfx.drs(drs);
    }
    if (ot !== this.prevOt) {
      this.prevOt = ot;
      sfx.overtake(ot);
    }
    // ぶつかり (続けて当たったときは 0.12 秒あける)
    const now = t0;
    if ((this.wallHit > WALL_THR || this.carHit > CAR_THR) && now - this.lastImpact > 120) {
      this.lastImpact = now;
      const car = this.carHit > CAR_THR && this.carHit >= this.wallHit * 0.6;
      sfx.impact(car ? impactLevel(this.carHit, CAR_THR) : impactLevel(this.wallHit, WALL_THR), car);
    }
    this.wallHit = 0;
    this.carHit = 0;

    const f = this.f;
    // 旗 (黄・VSC・SC は知らせの音、緑に戻ったら緑の音)
    const cue = flagCue(this.prevFlag, f.flag);
    this.prevFlag = f.flag;
    if (cue !== "none") sfx.flag(cue);
    // ゴール (自分の車)。観戦 (自分の車なし) はチェッカーフラッグが出たとき
    if (f.finished && !this.prevFinished) sfx.finish();
    else if (!f.me && f.chequered && !this.prevChequered) sfx.finish();
    this.prevFinished = f.finished;
    this.prevChequered = f.chequered;
    // ピットの作業: ホイールガン (止まってからの秒が、決まった時刻を越えたら) と燃料のホース (race.ts)
    if (f.me && f.pit === 2) {
      const prev = this.prevPitT < 0 ? -1e-3 : this.prevPitT;
      const n = wheelGunTimes(f.pitTire, f.tires, this.guns);
      const half = n / 2;
      for (let k = 0; k < n; k++) {
        const at = this.guns[k];
        if (prev < at && f.pitT >= at) sfx.wheelGun(k >= half, (k % half) % 2 ? GUN_PAN : -GUN_PAN);
      }
      this.prevPitT = f.pitT;
    } else this.prevPitT = -1;
    this.otherHits(f, now);

    const dt = performance.now() - t0;
    audioPerf.frames++;
    audioPerf.ms += dt;
    if (dt > audioPerf.maxMs) audioPerf.maxMs = dt;
  }

  /** 周を走り終えた (view.ts から 1 周に 1 回): 自己ベストとその場の一番の音。rivalBest = ほかの車の一番速い周 (なし = Infinity) */
  lap(time: number, valid: boolean, rivalBest: number) {
    const kind = lapChime(time, valid, this.myBest, rivalBest);
    if (valid && time > 0 && (this.myBest === null || time < this.myBest)) this.myBest = time;
    if (kind !== "none") sfx.lap(kind);
  }
  private myBest: number | null = null;

  /** ほかの車のぶつかり: snap の速さが、ブレーキでは出ない速さで落ちた (近い車だけ・小さく・左右つき・続けて鳴らさない) */
  private otherHits(f: RaceFrame, now: number) {
    if (f.count > this.oPrevSpd.length) {
      const m = Math.max(f.count, this.oPrevSpd.length * 2);
      this.oPrevSpd = new Float32Array(m);
      this.oPrevX = new Float32Array(m);
      this.oPrevY = new Float32Array(m);
      this.oPrevAt = new Float64Array(m);
      this.oPrevCount = -1;
    }
    const fresh = f.count !== this.oPrevCount;
    this.oPrevCount = f.count;
    for (let i = 0; i < f.count; i++) {
      const spd = f.ospd[i];
      const x = f.ox[i];
      const y = f.oy[i];
      const ps = this.oPrevSpd[i];
      // 新しい snap が来たときだけ (同じ値のままなら比べない)
      if (!fresh && spd === ps && x === this.oPrevX[i] && y === this.oPrevY[i]) continue;
      const dt = (now - this.oPrevAt[i]) / 1000;
      // 同じ車か (番号がずれたら前の場所から遠く離れる)
      const same = !fresh && Math.hypot(x - this.oPrevX[i], y - this.oPrevY[i]) < ps * dt + 6;
      this.oPrevSpd[i] = spd;
      this.oPrevX[i] = x;
      this.oPrevY[i] = y;
      this.oPrevAt[i] = now;
      if (!same || now - this.lastOtherHit < OTHER_HIT_GAP || now - this.lastImpact < OTHER_HIT_AFTER_MINE) continue;
      const hit = otherHitStrength(ps, spd, dt);
      if (!hit) continue;
      spatial(x - f.camX, y - f.camY, f.camH, this.sp);
      if (this.sp.gain < OTHER_HIT_MIN_GAIN) continue;
      this.lastOtherHit = now;
      sfx.impact(impactLevel(hit, CAR_THR), true, this.sp.pan, OTHER_HIT_VOL * Math.min(1, this.sp.gain * 2));
    }
  }

  private dropSound() {
    this.sound?.dispose();
    this.sound = null;
  }

  destroy() {
    this.dropSound();
    this.offSettings();
    setDuck(false);
    this.release();
  }
}

// ---- メニューの設定 ----

function onOff(value: boolean, set: (v: boolean) => void): HTMLElement {
  const box = el("div", { class: "toggle", role: "group" });
  const on = el("button", {}, "入") as HTMLButtonElement;
  const off = el("button", {}, "切") as HTMLButtonElement;
  const paint = (v: boolean) => {
    on.classList.toggle("on", v);
    off.classList.toggle("on", !v);
    on.setAttribute("aria-pressed", String(v));
    off.setAttribute("aria-pressed", String(!v));
  };
  paint(value);
  on.addEventListener("click", () => (paint(true), set(true)));
  off.addEventListener("click", () => (paint(false), set(false)));
  box.append(on, off);
  return box;
}

/** メニューの「設定と遊び方」に入れる 3 行: 効果音・曲・音量 */
export function soundSettingRows(): HTMLElement[] {
  const s = getSettings();
  const vol = el("input", { type: "range", min: "0", max: "100", step: "5", value: String(Math.round(s.volume * 100)), "aria-label": "音量", class: "vol" }) as HTMLInputElement;
  const pct = el("span", { class: "hint num" }, `${Math.round(s.volume * 100)}%`);
  vol.addEventListener("input", () => {
    pct.textContent = `${vol.value}%`;
    setSettings({ volume: Number(vol.value) / 100 });
  });
  vol.addEventListener("change", () => sfx.click());
  return [
    el("div", { class: "setting" }, el("span", { class: "k" }, "効果音"), onOff(s.sfx, (v) => setSettings({ sfx: v })), el("span", { class: "hint" }, "エンジン・タイヤ・信号・ボタン")),
    el("div", { class: "setting" }, el("span", { class: "k" }, "曲"), onOff(s.music, (v) => setSettings({ music: v })), el("span", { class: "hint" }, "レースは速い電子音、メニューと車づくりは落ち着いた曲")),
    el("div", { class: "setting" }, el("span", { class: "k" }, "音量"), vol, pct),
  ];
}
