// レースの続く音: エンジン (自分 + 近い 3 台)・タイヤのきしみ・縁石・芝・雨・ピットの速さ制限の音。
// 音の部品はレースの最初に 1 回だけ作り、毎こまは数を変えるだけ (毎こま新しいものを作らない)。
import { engineParams, engineParamsGear, fuelHissOn, newEngineOut, newSpatialOut, pickNearest, rumbleHz, spatial, squealLevel } from "./params.ts";

/** 自分以外に鳴らすエンジンの数 (仮) */
export const OTHER_VOICES = 3;
/** 大きさ (仮): 自分のエンジン・ほかの車・きしみ・ほかの車のきしみ・縁石・芝・雨・ピットの音・燃料のホース */
const LV = { me: 0.2, other: 0.11, squeal: 0.09, otherSqueal: 0.05, rumble: 0.22, grass: 0.14, rain: 0.16, limiter: 0.035, fuel: 0.05 };
/** ほかの車のきしみを鳴らす一番小さい強さ (大きさ × 遠さ。これより小さければ鳴らさない、仮) */
const OTHER_SQUEAL_MIN = 0.03;

/** view.ts が毎こま書く入れ物 (作りっぱなし) */
export class RaceFrame {
  /** 自分の車がある */
  me = false;
  speed = 0;
  top = 80;
  throttle = 0;
  brake = 0;
  slip = 0;
  /** 0 道 / 1 縁石 / 2 芝 */
  surface = 0;
  /** 0 なし / 1 ピットの道を走っている / 2 止まって作業 */
  pit = 0;
  /** 雨の強さ 0..1 */
  rain = 0;
  /** マニュアルの本当の段 (1..7) と回転の割合 (gearbox.ts)。0 = オートマ (速さから段を作る) */
  gear = 0;
  rpm = 0;
  wet = 0;
  camX = 0;
  camY = 0;
  camH = 0;
  /** 旗の重さ (params.ts の flagLevel: 0 緑 / 1 黄 / 2 VSC / 3 SC) */
  flag = 0;
  /** 自分の車がゴールした・チェッカーフラッグが出た */
  finished = false;
  chequered = false;
  /** ピットで止まって作業中 (pit = 2) のとき: 止まってからの秒・タイヤの作業の秒 (0 = 替えない)・燃料の作業の秒 (0 = 入れない)・タイヤの数 */
  pitT = 0;
  pitTire = 0;
  pitFuel = 0;
  tires = 4;
  /** ほかの車 (count 台。足りなければ grow) */
  count = 0;
  ox = new Float32Array(32);
  oy = new Float32Array(32);
  ospd = new Float32Array(32);
  otop = new Float32Array(32);
  /** 横滑り (m/s、params.ts の lateralSlip) */
  oslip = new Float32Array(32);
  grow(n: number) {
    if (n <= this.ox.length) return;
    const m = Math.max(n, this.ox.length * 2);
    for (const k of ["ox", "oy", "ospd", "otop", "oslip"] as const) {
      const a = new Float32Array(m);
      a.set(this[k]);
      this[k] = a;
    }
  }
}

interface Voice {
  a: OscillatorNode;
  b: OscillatorNode;
  f: BiquadFilterNode;
  g: GainNode;
  p: StereoPannerNode;
  /** 前のこまの速さ (アクセルを推しはかる) */
  lastSpd: number;
  thr: number;
}

const TC = 0.05;

export class RaceSound {
  private out: GainNode;
  private voices: Voice[] = [];
  private nodes: AudioScheduledSourceNode[] = [];
  private squealF: BiquadFilterNode;
  private squealG: GainNode;
  private rumbleO: OscillatorNode;
  private rumbleG: GainNode;
  private grassG: GainNode;
  private rainG: GainNode;
  private limG: GainNode;
  /** ほかの車のきしみ (近い車のうち一番大きい 1 台だけを 1 つの音で。左右つき) */
  private oSqF: BiquadFilterNode;
  private oSqG: GainNode;
  private oSqP: StereoPannerNode;
  private fuelG: GainNode;
  private eng = newEngineOut();
  private sp = newSpatialOut();
  private idx = new Int32Array(OTHER_VOICES);
  private dist = new Float32Array(OTHER_VOICES);
  /** 前に送った数 (変わらなければ送らない) */
  private last = new Float32Array(64).fill(-1);
  private disposed = false;

  constructor(
    private ctx: BaseAudioContext,
    dest: AudioNode,
    noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(1, ctx.currentTime, 0.3);
    this.out.connect(dest);
    for (let i = 0; i <= OTHER_VOICES; i++) this.voices.push(this.voice());

    const loop = (f: BiquadFilterType, hz: number, q: number, to: AudioNode = this.out) => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      const bf = ctx.createBiquadFilter();
      bf.type = f;
      bf.frequency.value = hz;
      bf.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      s.connect(bf);
      bf.connect(g);
      g.connect(to);
      s.start(ctx.currentTime, Math.random() * 1.5);
      this.nodes.push(s);
      return { bf, g };
    };
    const sq = loop("bandpass", 1900, 11);
    this.squealF = sq.bf;
    this.squealG = sq.g;
    this.grassG = loop("lowpass", 700, 0.7).g;
    const rain = loop("highpass", 900, 0.5);
    this.rainG = rain.g;
    // 雨は高すぎる音を少し落とす
    const rlp = ctx.createBiquadFilter();
    rlp.type = "lowpass";
    rlp.frequency.value = 6500;
    rain.bf.disconnect();
    rain.bf.connect(rlp);
    rlp.connect(this.rainG);

    // ほかの車のきしみ (1 つだけ。左右は鳴らしている車の場所)
    this.oSqP = ctx.createStereoPanner();
    this.oSqP.connect(this.out);
    const osq = loop("bandpass", 2000, 10, this.oSqP);
    this.oSqF = osq.bf;
    this.oSqG = osq.g;
    // 燃料のホース: こもった「シュー」
    this.fuelG = loop("bandpass", 1100, 0.9).g;

    // 縁石: 低い矩形波のがたがた
    this.rumbleO = ctx.createOscillator();
    this.rumbleO.type = "square";
    this.rumbleO.frequency.value = 30;
    const rf = ctx.createBiquadFilter();
    rf.type = "lowpass";
    rf.frequency.value = 260;
    this.rumbleG = ctx.createGain();
    this.rumbleG.gain.value = 0;
    this.rumbleO.connect(rf);
    rf.connect(this.rumbleG);
    this.rumbleG.connect(this.out);
    this.rumbleO.start();
    this.nodes.push(this.rumbleO);

    // ピットの速さ制限: 高い音を 1 秒に 4 回 切る
    const lim = ctx.createOscillator();
    lim.type = "square";
    lim.frequency.value = 1320;
    const gate = ctx.createGain();
    gate.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = 4;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth);
    depth.connect(gate.gain);
    this.limG = ctx.createGain();
    this.limG.gain.value = 0;
    lim.connect(gate);
    gate.connect(this.limG);
    this.limG.connect(this.out);
    lim.start();
    lfo.start();
    this.nodes.push(lim, lfo);
  }

  private voice(): Voice {
    const c = this.ctx;
    const a = c.createOscillator();
    a.type = "sawtooth";
    const b = c.createOscillator();
    b.type = "square";
    const bg = c.createGain();
    bg.gain.value = 0.5;
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 3;
    const g = c.createGain();
    g.gain.value = 0;
    const p = c.createStereoPanner();
    a.connect(f);
    b.connect(bg);
    bg.connect(f);
    f.connect(g);
    g.connect(p);
    p.connect(this.out);
    a.frequency.value = 40;
    b.frequency.value = 20;
    a.start();
    b.start();
    this.nodes.push(a, b);
    return { a, b, f, g, p, lastSpd: 0, thr: 0 };
  }

  /** 前と少しでも違うときだけ数を送る (k は送り先の番号) */
  private set(k: number, param: AudioParam, v: number, eps: number, tc = TC) {
    if (Math.abs(this.last[k] - v) < eps) return;
    this.last[k] = v;
    param.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  private setVoice(k: number, v: Voice, speed: number, top: number, thr: number, gain: number, pan: number, gear = 0, rpm = 0) {
    const e = gear > 0 ? engineParamsGear(gear, rpm, speed, thr, this.eng) : engineParams(speed, top, thr, this.eng);
    const base = k * 5;
    this.set(base, v.a.frequency, e.freq, 0.3, 0.03);
    this.set(base + 1, v.b.frequency, e.freq * 0.5, 0.15, 0.03);
    this.set(base + 2, v.f.frequency, e.cutoff, 20);
    this.set(base + 3, v.g.gain, e.gain * gain, 0.002);
    this.set(base + 4, v.p.pan, pan, 0.02);
  }

  update(f: RaceFrame) {
    if (this.disposed) return;
    // 自分の車
    const mv = this.voices[0];
    if (f.me) this.setVoice(0, mv, f.speed, f.top, f.pit === 2 ? 0 : f.throttle, LV.me, 0, f.pit ? 0 : f.gear, f.rpm);
    else this.set(3, mv.g.gain, 0, 0.001);
    // 近い 3 台
    const n = pickNearest(f.ox, f.oy, f.count, f.camX, f.camY, OTHER_VOICES, this.idx, this.dist);
    let sqBest = 0;
    let sqPan = 0;
    let sqSlip = 0;
    for (let j = 0; j < OTHER_VOICES; j++) {
      const v = this.voices[j + 1];
      const k = j + 1;
      if (j >= n) {
        this.set(k * 5 + 3, v.g.gain, 0, 0.001, 0.15);
        continue;
      }
      const i = this.idx[j];
      const spd = f.ospd[i];
      // アクセルは速さの増え方から推しはかる
      const acc = spd - v.lastSpd;
      v.lastSpd = spd;
      v.thr += ((acc > 0.01 ? 1 : acc < -0.05 ? 0.1 : 0.55) - v.thr) * 0.15;
      spatial(f.ox[i] - f.camX, f.oy[i] - f.camY, f.camH, this.sp);
      this.setVoice(k, v, spd, f.otop[i], v.thr, LV.other * this.sp.gain, this.sp.pan);
      // きしみ: 近い車のうち一番大きい 1 台
      const sq = squealLevel(f.oslip[i], 0, spd, 0, f.wet) * this.sp.gain;
      if (sq > sqBest) {
        sqBest = sq;
        sqPan = this.sp.pan;
        sqSlip = f.oslip[i];
      }
    }
    const oSq = sqBest >= OTHER_SQUEAL_MIN ? Math.min(1, sqBest * 2) * LV.otherSqueal : 0;
    this.set(38, this.oSqG.gain, oSq, 0.002, 0.05);
    if (oSq > 0) {
      this.set(39, this.oSqP.pan, sqPan, 0.03);
      this.set(40, this.oSqF.frequency, 1800 + Math.min(6, sqSlip) * 90, 25);
    }
    // 自分の車の足まわり
    const on = f.me && f.pit === 0;
    this.set(30, this.squealG.gain, on ? squealLevel(f.slip, f.brake, f.speed, f.surface, f.wet) * LV.squeal : 0, 0.002, 0.04);
    this.set(31, this.squealF.frequency, 1700 + Math.min(6, f.slip) * 90, 25);
    const rum = on && f.surface === 1 && f.speed > 3 ? Math.min(1, f.speed / 25) * LV.rumble : 0;
    this.set(32, this.rumbleG.gain, rum, 0.003, 0.03);
    this.set(33, this.rumbleO.frequency, rumbleHz(f.speed), 1);
    this.set(34, this.grassG.gain, on && f.surface === 2 ? Math.min(1, f.speed / 30) * LV.grass : 0, 0.003, 0.06);
    this.set(35, this.rainG.gain, f.rain * LV.rain, 0.002, 0.8);
    this.set(36, this.limG.gain, f.me && f.pit === 1 ? LV.limiter : 0, 0.001, 0.02);
    this.set(37, this.fuelG.gain, f.me && f.pit === 2 && fuelHissOn(f.pitT, f.pitFuel) ? LV.fuel : 0, 0.001, 0.06);
  }

  /** 絞って片付ける */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.08);
    const nodes = this.nodes;
    const out = this.out;
    setTimeout(() => {
      for (const s of nodes) {
        try {
          s.stop();
        } catch {
          /* もう止まっている */
        }
      }
      out.disconnect();
    }, 500);
  }
}
