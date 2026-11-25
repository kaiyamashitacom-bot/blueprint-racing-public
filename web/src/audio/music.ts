// 譜面 (pattern.ts) を電子音で鳴らす。少し先 (LOOKAHEAD) まで予約して鳴らす普通のやり方。
// 外の音の素材は使わない (全部 発振器・雑音・フィルターで作る)。
import { STEPS, midiHz, stepSeconds, type Pattern } from "./pattern.ts";

const LOOKAHEAD = 0.16;
const TICK_MS = 30;

export class MusicPlayer {
  /** この曲だけの音量 (切りかえのときに絞る) */
  readonly out: GainNode;
  private delay: DelayNode;
  private step = 0;
  private next = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private ctx: BaseAudioContext,
    dest: AudioNode,
    readonly pat: Pattern,
    private noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    // 上の音だけに薄く掛けるこだま (付点 8 分)
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = stepSeconds(pat.bpm) * 3;
    const fb = ctx.createGain();
    fb.gain.value = pat.style === "race" ? 0.28 : 0.38;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.delay.connect(fb);
    fb.connect(this.delay);
    this.delay.connect(wet);
    wet.connect(this.out);
  }

  /** 鳴らしはじめる (fade 秒で大きく) */
  start(fade = 1.2) {
    const t = this.ctx.currentTime;
    this.next = t + 0.08;
    this.step = 0;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(1, t + fade);
    this.timer = setInterval(() => this.pump(), TICK_MS);
    this.pump();
  }

  /** 絞って止める */
  stop(fade = 0.8) {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + fade);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    setTimeout(() => this.out.disconnect(), (fade + 1.5) * 1000);
  }

  /** 先まで予約する。裏に回って遅れたら、今から数え直す */
  pump(until = this.ctx.currentTime + LOOKAHEAD) {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    if (this.next < now - 0.2) this.next = now + 0.05;
    const dt = stepSeconds(this.pat.bpm);
    while (this.next < until) {
      this.play(this.step, this.next, dt);
      this.next += dt;
      this.step = (this.step + 1) % (this.pat.bars * STEPS);
    }
  }

  private play(i: number, t: number, dt: number) {
    const p = this.pat;
    if (p.kick[i]) this.kick(t, p.kick[i]);
    if (p.snare[i]) this.snare(t, p.snare[i]);
    if (p.hat[i]) this.hat(t, p.hat[i]);
    if (p.bass[i] >= 0) this.bass(t, p.bass[i], p.bassLen[i] * dt);
    if (p.arp[i] >= 0) this.pluck(t, p.arp[i], p.arpVel[i]);
    if (i % STEPS === 0 && p.pad > 0) this.padChord(t, p.chords[Math.floor(i / STEPS)], dt * STEPS, p.pad);
  }

  private env(t: number, peak: number, attack: number, decay: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.out);
    return g;
  }

  private kick(t: number, v: number) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    o.connect(this.env(t, 0.9 * v, 0.003, 0.28));
    o.start(t);
    o.stop(t + 0.32);
  }

  private noiseHit(t: number, type: BiquadFilterType, f: number, q: number, peak: number, decay: number) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const bf = this.ctx.createBiquadFilter();
    bf.type = type;
    bf.frequency.value = f;
    bf.Q.value = q;
    s.connect(bf);
    bf.connect(this.env(t, peak, 0.002, decay));
    s.start(t, Math.random() * 1.5);
    s.stop(t + decay + 0.05);
  }

  private snare(t: number, v: number) {
    this.noiseHit(t, "bandpass", 1700, 0.9, 0.42 * v, 0.14);
  }

  private hat(t: number, v: number) {
    this.noiseHit(t, "highpass", 7500, 0.7, 0.2 * v, 0.035 + v * 0.03);
  }

  private bass(t: number, m: number, len: number) {
    const o = this.ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = midiHz(m);
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 6;
    const race = this.pat.style === "race";
    f.frequency.setValueAtTime(race ? 900 : 500, t);
    f.frequency.exponentialRampToValueAtTime(race ? 160 : 220, t + Math.min(len, 0.4));
    o.connect(f);
    f.connect(this.env(t, race ? 0.32 : 0.26, 0.004, Math.max(0.08, len * 0.92)));
    o.start(t);
    o.stop(t + len + 0.05);
  }

  private pluck(t: number, m: number, v: number) {
    const o = this.ctx.createOscillator();
    const race = this.pat.style === "race";
    o.type = race ? "square" : "triangle";
    o.frequency.value = midiHz(m);
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(race ? 2600 : 3200, t);
    f.frequency.exponentialRampToValueAtTime(600, t + 0.2);
    o.connect(f);
    const g = this.env(t, (race ? 0.07 : 0.12) * v, 0.004, race ? 0.16 : 0.6);
    f.connect(g);
    g.connect(this.delay);
    o.start(t);
    o.stop(t + (race ? 0.22 : 0.7));
  }

  private padChord(t: number, chord: number[], len: number, v: number) {
    const race = this.pat.style === "race";
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = race ? 700 : 1100;
    const g = this.ctx.createGain();
    const peak = (race ? 0.035 : 0.05) * v;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + len * 0.3);
    g.gain.setValueAtTime(peak, t + len * 0.75);
    g.gain.linearRampToValueAtTime(0.0001, t + len * 1.02);
    f.connect(g);
    g.connect(this.out);
    for (const m of chord) {
      for (const det of [-6, 6]) {
        const o = this.ctx.createOscillator();
        o.type = race ? "sawtooth" : "triangle";
        o.frequency.value = midiHz(m);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + len * 1.05);
      }
    }
  }
}
