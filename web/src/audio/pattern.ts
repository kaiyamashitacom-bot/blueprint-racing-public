// 曲の譜面を種 (seed) から作る (純粋な計算、試験あり)。音にするのは music.ts。
// レース: 電子音で緊張感 (短調、四つ打ち、16 分の低音)。メニュー・車づくり: 落ち着いた長調。数は全部 仮。

export type MusicStyle = "race" | "menu" | "builder";

export const STEPS = 16;

export interface Pattern {
  style: MusicStyle;
  bpm: number;
  bars: number;
  /** 1 小節ごとの和音 (MIDI の番号、低い順) */
  chords: number[][];
  /** 以下は bars × STEPS の長さ。0 = 鳴らさない、0..1 = 強さ */
  kick: number[];
  snare: number[];
  hat: number[];
  /** 低音の高さ (MIDI、-1 = 休み) と長さ (16 分いくつぶん) */
  bass: number[];
  bassLen: number[];
  /** 上の細かい音 (MIDI、-1 = 休み) と強さ */
  arp: number[];
  arpVel: number[];
  /** 小節の頭で鳴らすやわらかい和音の強さ (0 = なし) */
  pad: number;
}

/** 小さな乱数 (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCALES: Record<string, number[]> = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

/** 音階の何番目 (0..) を MIDI に (7 を超えたら上の 8 度) */
export function degree(root: number, scale: number[], d: number): number {
  const o = Math.floor(d / scale.length);
  const i = ((d % scale.length) + scale.length) % scale.length;
  return root + o * 12 + scale[i];
}

/** 音階の d 番目からの 3 和音 (calm は 7 の音も足す) */
function chordOf(root: number, scale: number[], d: number, seventh: boolean): number[] {
  const c = [degree(root, scale, d), degree(root, scale, d + 2), degree(root, scale, d + 4)];
  if (seventh) c.push(degree(root, scale, d + 6));
  return c;
}

const RACE_PROGS = [
  [0, 0, 5, 6],
  [0, 5, 3, 4],
  [0, 3, 5, 4],
  [0, 6, 5, 6],
];
const CALM_PROGS = [
  [0, 5, 3, 4],
  [0, 3, 5, 3],
  [0, 2, 3, 4],
  [3, 4, 0, 5],
];

/** 種と曲の種類から譜面を作る。同じ種なら同じ譜面 (つなぎ目なく繰り返せる長さ) */
export function makePattern(seed: number, style: MusicStyle): Pattern {
  const r = rng(seed * 7919 + (style === "race" ? 1 : style === "menu" ? 2 : 3));
  const race = style === "race";
  const bars = 8;
  const n = bars * STEPS;
  const bpm = race ? 122 + Math.floor(r() * 7) : style === "menu" ? 84 + Math.floor(r() * 5) : 74 + Math.floor(r() * 5);
  const scale = race ? (r() < 0.5 ? SCALES.aeolian : SCALES.phrygian) : r() < 0.6 ? SCALES.ionian : SCALES.lydian;
  // 根の音: レースは A1..D2 あたり、落ち着いた曲は C2..F2 あたり (低音の 8 度)
  const root = race ? 33 + Math.floor(r() * 6) : 36 + Math.floor(r() * 6);
  const progs = race ? RACE_PROGS : CALM_PROGS;
  const prog = progs[Math.floor(r() * progs.length)];
  const chords: number[][] = [];
  for (let b = 0; b < bars; b++) chords.push(chordOf(root + 24, scale, prog[Math.floor(b / 2) % prog.length], !race));

  const kick = new Array<number>(n).fill(0);
  const snare = new Array<number>(n).fill(0);
  const hat = new Array<number>(n).fill(0);
  const bass = new Array<number>(n).fill(-1);
  const bassLen = new Array<number>(n).fill(0);
  const arp = new Array<number>(n).fill(-1);
  const arpVel = new Array<number>(n).fill(0);

  if (race) {
    // 低音の刻み (1 小節の型を 1 つ作り、全部の小節で使う)
    const mask: boolean[] = [];
    const oct: boolean[] = [];
    for (let s = 0; s < STEPS; s++) {
      mask.push(s === 0 || (s % 4 !== 0 ? r() < 0.62 : r() < 0.85));
      oct.push(s !== 0 && r() < 0.2);
    }
    // 上の細かい音の型: 和音の音を上下に (2 小節で 1 回り)
    const arpMask: boolean[] = [];
    const arpOrder: number[] = [];
    for (let s = 0; s < STEPS * 2; s++) {
      arpMask.push(r() < (s % 2 === 0 ? 0.7 : 0.35));
      arpOrder.push(Math.floor(r() * 4));
    }
    for (let b = 0; b < bars; b++) {
      const ch = chords[b];
      const last = b === bars - 1;
      for (let s = 0; s < STEPS; s++) {
        const i = b * STEPS + s;
        if (s % 4 === 0) kick[i] = 1;
        if (last && s === 14 && r() < 0.7) kick[i] = 0.7;
        if (s === 4 || s === 12) snare[i] = 0.8;
        if (s === 15 && r() < 0.25) snare[i] = 0.3;
        if (s % 4 === 2) hat[i] = 0.6;
        else if (r() < 0.45) hat[i] = 0.22;
        if (mask[s]) {
          bass[i] = ch[0] - 24 + (oct[s] ? 12 : 0);
          bassLen[i] = 1;
        }
        // 最初の 2 小節は上の音を出さない (入りを静かに)
        if (b >= 2 && arpMask[(b % 2) * STEPS + s]) {
          const k = arpOrder[(b % 2) * STEPS + s];
          arp[i] = k === 3 ? ch[0] + 12 : ch[k] + 12;
          arpVel[i] = s % 4 === 0 ? 0.9 : 0.6;
        }
      }
    }
  } else {
    const builder = style === "builder";
    for (let b = 0; b < bars; b++) {
      const ch = chords[b];
      for (let s = 0; s < STEPS; s++) {
        const i = b * STEPS + s;
        if (!builder) {
          if (s === 0 || s === 8) kick[i] = 0.35;
          if (s % 4 === 2) hat[i] = 0.14;
        }
        if (s === 0 || (!builder && s === 8 && r() < 0.5)) {
          bass[i] = ch[0] - 24;
          bassLen[i] = s === 0 && builder ? 16 : 8;
        }
        // まばらな はじく音 (8 分の上で)
        if (s % 2 === 0 && r() < (builder ? 0.22 : 0.32)) {
          const k = Math.floor(r() * ch.length);
          arp[i] = ch[k] + 12;
          arpVel[i] = 0.4 + r() * 0.4;
        }
      }
    }
  }
  return { style, bpm, bars, chords, kick, snare, hat, bass, bassLen, arp, arpVel, pad: race ? 0.35 : 0.8 };
}

/** 16 分 1 つの長さ (秒) */
export function stepSeconds(bpm: number): number {
  return 60 / bpm / 4;
}

/** MIDI の番号 → Hz */
export function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
