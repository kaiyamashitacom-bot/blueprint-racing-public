// 音の土台: AudioContext (最初に触ったときに作る。スマホはそうしないと鳴らない)・全体/効果音/曲の音量・
// 裏に回ったら止める・曲の切りかえと絞り (無線の札・スタートの信号のあいだ)。
// 外の音の素材は使わない。全部 Web Audio の発振器と雑音で作る (仮の音。あとで素材に替えてよい)
import { MusicPlayer } from "./music.ts";
import { makePattern, type MusicStyle } from "./pattern.ts";
import { loadAudioSettings, saveAudioSettings, type AudioSettings } from "./settings.ts";

/** 曲は効果音より小さく (仮) */
export const MUSIC_LEVEL = 0.3;
export const SFX_LEVEL = 0.85;
/** 無線の札・信号のときの曲の大きさ (仮) */
const DUCK_LEVEL = 0.3;
/** 曲の種 (同じ種なら同じ曲。仮) */
const SEEDS: Record<MusicStyle, number> = { race: 11, menu: 4, builder: 9 };

let ctx: AudioContext | null = null;
let master: GainNode;
let sfxBus: GainNode;
let musicBus: GainNode;
let duck: GainNode;
let noiseBuf: AudioBuffer;
let settings: AudioSettings = loadAudioSettings();
let installed = false;
/** 画面が望む曲 (メニュー・車づくり) と、レースの画面が出ている数 */
let screenStyle: MusicStyle | null = null;
let raceClaims = 0;
let raceRelease: ReturnType<typeof setTimeout> | null = null;
let player: MusicPlayer | null = null;
let ducked = false;
const listeners = new Set<() => void>();

export function getSettings(): Readonly<AudioSettings> {
  return settings;
}

export function setSettings(patch: Partial<AudioSettings>) {
  settings = { ...settings, ...patch };
  saveAudioSettings(settings);
  applyLevels();
  syncMusic();
  for (const f of listeners) f();
}

export function onSettings(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 鳴らせる状態の AudioContext (触る前・止めているときは null) */
export function audioCtx(): AudioContext | null {
  return ctx && ctx.state === "running" ? ctx : null;
}

/** 作ったかどうかと様子を見る (試すとき用。作っていなければ null) */
export function rawCtx(): { state: string; music: string | null; ducked: boolean } | null {
  return ctx ? { state: ctx.state, music: player?.pat.style ?? null, ducked } : null;
}

export function sfxOut(): AudioNode | null {
  return ctx && settings.sfx ? sfxBus : null;
}

export function noise(): AudioBuffer {
  return noiseBuf;
}

/** 一度だけ: 最初に触ったら作る・裏に回ったら止める・ボタンの音 */
export function installAudio(onButton?: (e: Event) => void) {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const unlock = () => {
    if (!ctx) create();
    if (ctx && ctx.state !== "running" && document.visibilityState === "visible") ctx.resume().catch(() => {});
  };
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, unlock, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.visibilityState === "hidden") ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });
  if (onButton) document.addEventListener("click", onButton, { capture: true, passive: true });
}

function create() {
  const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC({ latencyHint: "interactive" });
  } catch {
    return;
  }
  master = ctx.createGain();
  // 大きな音が重なったときの割れ止め
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 4;
  master.connect(comp);
  comp.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  duck = ctx.createGain();
  duck.connect(musicBus);
  musicBus.connect(master);
  noiseBuf = makeNoise(ctx, 2);
  // iOS: 触った中で 1 度鳴らすと、そのあと鳴る
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  s.connect(ctx.destination);
  s.start();
  applyLevels();
  ctx.addEventListener("statechange", () => syncMusic());
  syncMusic();
}

export function makeNoise(c: BaseAudioContext, sec: number): AudioBuffer {
  const b = c.createBuffer(1, Math.round(c.sampleRate * sec), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function applyLevels() {
  if (!ctx) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(settings.volume, t, 0.03);
  sfxBus.gain.setTargetAtTime(settings.sfx ? SFX_LEVEL : 0, t, 0.03);
  musicBus.gain.setTargetAtTime(settings.music ? MUSIC_LEVEL : 0, t, 0.08);
}

function wantStyle(): MusicStyle | null {
  if (!settings.music) return null;
  return raceClaims > 0 ? "race" : screenStyle;
}

/** 望む曲と鳴っている曲を合わせる (切りかえは絞って入れ替え) */
function syncMusic() {
  if (!ctx || ctx.state !== "running") return;
  const want = wantStyle();
  if ((player?.pat.style ?? null) === want) return;
  player?.stop(want ? 0.9 : 0.5);
  player = null;
  if (!want) return;
  player = new MusicPlayer(ctx, duck, makePattern(SEEDS[want], want), noiseBuf);
  player.start(want === "race" ? 2.5 : 1.6);
}

/** 画面の曲 (main.ts の go から)。null = 曲なし */
export function setScreenMusic(style: MusicStyle | null) {
  screenStyle = style;
  syncMusic();
}

/** レースの画面が出ているあいだはレースの曲 (やり直しで消して作り直すので、離すのは少し待つ) */
export function claimRaceMusic(): () => void {
  if (raceRelease) {
    clearTimeout(raceRelease);
    raceRelease = null;
  }
  raceClaims++;
  syncMusic();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    raceRelease = setTimeout(() => {
      raceRelease = null;
      raceClaims = Math.max(0, raceClaims - 1);
      syncMusic();
    }, 600);
  };
}

/** 曲を絞る (無線の札・スタートの信号) */
export function setDuck(on: boolean) {
  if (on === ducked || !ctx) return;
  ducked = on;
  duck.gain.setTargetAtTime(on ? DUCK_LEVEL : 1, ctx.currentTime, on ? 0.08 : 0.4);
}

// ---- 1 回だけ鳴る効果音 ----

function tone(type: OscillatorType, f0: number, f1: number, at: number, dur: number, peak: number, dest: AudioNode, attack = 0.004) {
  const c = ctx!;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + attack);
  g.gain.setValueAtTime(peak, at + Math.max(attack, dur * 0.6));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g);
  g.connect(dest);
  o.start(at);
  o.stop(at + dur + 0.02);
}

function burst(at: number, type: BiquadFilterType, f: number, q: number, dur: number, peak: number, dest: AudioNode, pan = 0) {
  const c = ctx!;
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  const bf = c.createBiquadFilter();
  bf.type = type;
  bf.frequency.value = f;
  bf.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(peak, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(bf);
  bf.connect(g);
  if (pan) {
    const p = c.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(dest);
  } else g.connect(dest);
  s.start(at, Math.random() * 1.5);
  s.stop(at + dur + 0.02);
}

function ready(): { c: AudioContext; d: AudioNode } | null {
  const c = audioCtx();
  const d = sfxOut();
  return c && d ? { c, d } : null;
}

export const sfx = {
  /** ボタン */
  click() {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    tone("sine", 1900, 1300, t, 0.035, 0.08, r.d, 0.002);
    burst(t, "highpass", 4000, 0.7, 0.02, 0.05, r.d);
  },
  /** 赤い信号が 1 つ点いた */
  lightBeep() {
    const r = ready();
    if (!r) return;
    tone("square", 620, 620, r.c.currentTime, 0.16, 0.06, r.d);
  },
  /** 信号が全部消えた */
  lightsOut() {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    tone("square", 930, 930, t, 0.09, 0.06, r.d);
    tone("square", 1240, 1240, t + 0.09, 0.32, 0.07, r.d);
  },
  /** DRS の羽根が開く・閉じる */
  drs(open: boolean) {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    burst(t, "bandpass", open ? 2600 : 1800, 3, 0.03, 0.22, r.d);
    tone("triangle", open ? 520 : 760, open ? 760 : 520, t, 0.07, 0.07, r.d);
  },
  /** オーバーテイクモード: 使い始めは上がる音、離すと短く下がる音 */
  overtake(on: boolean) {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    if (on) {
      tone("sawtooth", 330, 990, t, 0.22, 0.05, r.d, 0.01);
      tone("sine", 660, 1980, t + 0.02, 0.2, 0.05, r.d, 0.01);
    } else tone("sine", 880, 520, t, 0.1, 0.04, r.d);
  },
  /** 無線の札が出た */
  radio(urgent = false) {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    burst(t, "bandpass", 2200, 1.4, 0.06, 0.07, r.d);
    tone("sine", 1180, 1180, t + 0.04, 0.06, 0.07, r.d);
    tone("sine", urgent ? 1580 : 1480, urgent ? 1580 : 1480, t + 0.11, 0.08, 0.07, r.d);
  },
  /** 壁や車にぶつかった (level 0..1、pan -1..1、vol = 大きさの倍。ほかの車は小さく) */
  impact(level: number, car: boolean, pan = 0, vol = 1) {
    const r = ready();
    if (!r || level <= 0 || vol <= 0) return;
    const t = r.c.currentTime;
    const v = (0.2 + level * 0.55) * vol;
    tone("sine", car ? 150 : 110, 40, t, 0.18 + level * 0.12, v, r.d, 0.002);
    burst(t, "lowpass", car ? 2400 : 1500, 0.8, 0.12 + level * 0.25, v * 0.8, r.d, pan);
    if (car || level > 0.4) burst(t + 0.01, "bandpass", 3800, 2.5, 0.1, v * 0.35, r.d, pan); // 金属の音
  },
  /** 旗が変わった: 黄・VSC・SC は短い知らせの音 (重いほど回数が多い)、緑は上がる 2 音 */
  flag(cue: "yellow" | "vsc" | "sc" | "green") {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    if (cue === "green") {
      tone("triangle", 784, 784, t, 0.12, 0.07, r.d);
      tone("triangle", 1175, 1175, t + 0.12, 0.26, 0.07, r.d);
      return;
    }
    const n = cue === "sc" ? 3 : 2;
    const hi = cue === "yellow" ? 880 : 988;
    const lo = cue === "yellow" ? 880 : 740;
    for (let i = 0; i < n; i++) tone("square", i % 2 ? lo : hi, i % 2 ? lo : hi, t + i * 0.15, 0.11, 0.045, r.d);
  },
  /** チェッカーフラッグ (ゴール): 上がる 4 音と、残る和音 */
  finish() {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    const notes = [523, 659, 784, 1047];
    for (let i = 0; i < notes.length; i++) tone("triangle", notes[i], notes[i], t + i * 0.09, 0.16, 0.07, r.d);
    for (const f of [523, 659, 784]) tone("sine", f, f, t + 0.36, 0.9, 0.04, r.d, 0.02);
  },
  /** 周のタイム: pb = 自己ベスト (紫) の 2 音、session = その場の一番の 3 音 (明るく高い) */
  lap(kind: "pb" | "session") {
    const r = ready();
    if (!r) return;
    const t = r.c.currentTime;
    const notes = kind === "session" ? [1319, 1568, 2093] : [1175, 1568];
    for (let i = 0; i < notes.length; i++) tone("sine", notes[i], notes[i], t + i * 0.1, 0.42, 0.06, r.d, 0.003);
  },
  /** タイヤ交換の締め具 (ホイールガン) の「ドゥルルッ」1 回。tighten = 締める (短く高め)、pan = 左右 */
  wheelGun(tighten: boolean, pan = 0) {
    const r = ready();
    if (!r) return;
    const c = r.c;
    const t = c.currentTime;
    const dur = tighten ? 0.24 : 0.32;
    const s = c.createBufferSource();
    s.buffer = noiseBuf;
    const bf = c.createBiquadFilter();
    bf.type = "bandpass";
    bf.frequency.value = tighten ? 2600 : 2100;
    bf.Q.value = 2.2;
    const g = c.createGain();
    // がたがた (1 秒に 40 回ほど) は音量の段で作る (揺らす発振器を足さない)
    const per = 1 / 42;
    const peak = 0.16;
    g.gain.setValueAtTime(0.0001, t);
    for (let k = 0, at = t; at < t + dur; k++, at = t + k * per) {
      const fade = 1 - (at - t) / dur;
      g.gain.setValueAtTime(peak * (0.4 + 0.6 * fade), at);
      g.gain.setValueAtTime(peak * 0.12 * fade + 0.0001, at + per * 0.55);
    }
    g.gain.setValueAtTime(0.0001, t + dur);
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    s.connect(bf);
    bf.connect(g);
    g.connect(p);
    p.connect(r.d);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
    // 回る音の高さ (外すときは下がり、締めるときは上がる)
    tone("sawtooth", tighten ? 300 : 360, tighten ? 420 : 240, t, dur, 0.025, r.d);
  },
};
