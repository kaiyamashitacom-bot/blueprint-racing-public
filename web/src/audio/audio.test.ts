// 音の純粋な計算の試験 (曲の譜面・車の様子 → 音の数・設定の読み書き)
import { describe, expect, it } from "vitest";
import {
  GEARS,
  HEAR_MAX,
  OTHER_HIT_DECEL,
  engineParams,
  flagCue,
  flagLevel,
  fuelHissOn,
  impactLevel,
  lapChime,
  lateralSlip,
  newEngineOut,
  newSpatialOut,
  otherHitStrength,
  pickNearest,
  rumbleHz,
  spatial,
  squealLevel,
  wheelGunTimes,
} from "./params.ts";
import { SCALES, STEPS, degree, makePattern, midiHz, rng, stepSeconds, type MusicStyle } from "./pattern.ts";
import { DEFAULT_AUDIO, parseAudioSettings } from "./settings.ts";

describe("曲の譜面", () => {
  const styles: MusicStyle[] = ["race", "menu", "builder"];

  it("同じ種なら同じ譜面、違う種なら違う譜面", () => {
    for (const s of styles) {
      expect(makePattern(5, s)).toEqual(makePattern(5, s));
      const a = JSON.stringify(makePattern(1, s));
      const differs = [2, 3, 4, 5, 6].some((k) => JSON.stringify(makePattern(k, s)) !== a);
      expect(differs).toBe(true);
    }
  });

  it("速さ: レースは 120〜130、落ち着いた曲は遅い", () => {
    for (let seed = 0; seed < 40; seed++) {
      const r = makePattern(seed, "race").bpm;
      expect(r).toBeGreaterThanOrEqual(120);
      expect(r).toBeLessThanOrEqual(130);
      expect(makePattern(seed, "menu").bpm).toBeLessThan(100);
      expect(makePattern(seed, "builder").bpm).toBeLessThan(90);
    }
  });

  it("どの列も 小節 × 16 の長さで、強さは 0..1", () => {
    for (const s of styles) {
      for (let seed = 0; seed < 20; seed++) {
        const p = makePattern(seed, s);
        const n = p.bars * STEPS;
        for (const arr of [p.kick, p.snare, p.hat, p.bass, p.bassLen, p.arp, p.arpVel]) expect(arr.length).toBe(n);
        for (const arr of [p.kick, p.snare, p.hat, p.arpVel]) for (const v of arr) expect(v >= 0 && v <= 1).toBe(true);
        expect(p.chords.length).toBe(p.bars);
      }
    }
  });

  it("レースは四つ打ち、車づくりは太鼓なし", () => {
    const r = makePattern(11, "race");
    for (let i = 0; i < r.kick.length; i += 4) expect(r.kick[i]).toBeGreaterThan(0);
    const b = makePattern(9, "builder");
    expect(b.kick.every((v) => v === 0) && b.snare.every((v) => v === 0) && b.hat.every((v) => v === 0)).toBe(true);
  });

  it("音は和音の音 (低音は和音の根)", () => {
    for (const s of styles) {
      const p = makePattern(3, s);
      for (let i = 0; i < p.bass.length; i++) {
        const ch = p.chords[Math.floor(i / STEPS)];
        const pcs = ch.map((m) => m % 12);
        if (p.bass[i] >= 0) expect(p.bass[i] % 12).toBe(ch[0] % 12);
        if (p.arp[i] >= 0) expect(pcs).toContain(p.arp[i] % 12);
      }
    }
  });

  it("小さな道具", () => {
    expect(midiHz(69)).toBeCloseTo(440);
    expect(midiHz(81)).toBeCloseTo(880);
    expect(stepSeconds(120)).toBeCloseTo(0.125);
    expect(degree(48, SCALES.ionian, 7)).toBe(60);
    expect(degree(48, SCALES.aeolian, 2)).toBe(51);
    const a = rng(1);
    const b = rng(1);
    for (let i = 0; i < 5; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});

describe("エンジンの音", () => {
  it("速いほど高い段・止まっていれば 1 段で空ぶかし", () => {
    const o = newEngineOut();
    engineParams(0, 80, 0, o);
    expect(o.gear).toBe(1);
    const idle = o.freq;
    engineParams(0, 80, 1, o);
    expect(o.freq).toBeGreaterThan(idle);
    engineParams(80, 80, 1, o);
    expect(o.gear).toBe(GEARS);
    let prevGear = 0;
    for (let v = 0; v <= 80; v += 2) {
      engineParams(v, 80, 1, o);
      expect(o.gear).toBeGreaterThanOrEqual(prevGear);
      expect(o.rpm).toBeGreaterThan(0);
      expect(o.rpm).toBeLessThanOrEqual(1.04);
      expect(o.gain).toBeLessThanOrEqual(1);
      prevGear = o.gear;
    }
  });

  it("段が上がると音が下がる (変速)", () => {
    const o = newEngineOut();
    let drops = 0;
    let prev = 0;
    for (let v = 1; v <= 80; v += 0.5) {
      engineParams(v, 80, 1, o);
      if (o.freq < prev - 5) drops++;
      prev = o.freq;
    }
    expect(drops).toBe(GEARS - 1);
  });

  it("アクセルで明るく大きく", () => {
    const o = newEngineOut();
    engineParams(40, 80, 0, o);
    const c0 = o.cutoff;
    const g0 = o.gain;
    engineParams(40, 80, 1, o);
    expect(o.cutoff).toBeGreaterThan(c0);
    expect(o.gain).toBeGreaterThan(g0);
  });
});

describe("左右と遠さ", () => {
  it("画面の右の車は右から、遠いほど小さい", () => {
    const s = newSpatialOut();
    // camH = -π/2 (上を向いている = 世界の -y)。画面の右 = 世界の +x
    spatial(10, 0, -Math.PI / 2, s);
    expect(s.pan).toBeGreaterThan(0.3);
    spatial(-10, 0, -Math.PI / 2, s);
    expect(s.pan).toBeLessThan(-0.3);
    spatial(0, -10, -Math.PI / 2, s);
    expect(Math.abs(s.pan)).toBeLessThan(1e-9);
    const near = spatial(5, 0, 0, s).gain;
    const far = spatial(60, 0, 0, s).gain;
    expect(near).toBeGreaterThan(far);
    expect(spatial(HEAR_MAX + 1, 0, 0, s).gain).toBe(0);
  });

  it("近い 3 台を近い順に選ぶ", () => {
    const xs = [100, 3, 50, 1, 20, 500, 2];
    const ys = [0, 0, 0, 0, 0, 0, 0];
    const idx = new Int32Array(3);
    const d = new Float32Array(3);
    const n = pickNearest(xs, ys, xs.length, 0, 0, 3, idx, d);
    expect(n).toBe(3);
    expect([...idx]).toEqual([3, 6, 1]);
    expect(pickNearest([1, 600], [0, 0], 2, 0, 0, 3, idx, d)).toBe(1);
    expect(pickNearest([], [], 0, 0, 0, 3, idx, d)).toBe(0);
  });
});

describe("足まわりとぶつかり", () => {
  it("きしみ: 横滑り・強いブレーキで鳴り、芝・遅いときは鳴らない、濡れると小さい", () => {
    expect(squealLevel(0, 0, 40, 0, 0)).toBe(0);
    expect(squealLevel(4, 0, 40, 0, 0)).toBeGreaterThan(0.5);
    expect(squealLevel(0, 1, 40, 0, 0)).toBeGreaterThan(0.3);
    expect(squealLevel(4, 1, 40, 2, 0)).toBe(0);
    expect(squealLevel(4, 1, 2, 0, 0)).toBe(0);
    expect(squealLevel(4, 0, 40, 0, 1)).toBeLessThan(squealLevel(4, 0, 40, 0, 0));
  });

  it("ぶつかりの強さ", () => {
    expect(impactLevel(1, 2)).toBe(0);
    expect(impactLevel(Number.NaN, 2)).toBe(0);
    expect(impactLevel(6, 2)).toBeGreaterThan(0);
    expect(impactLevel(100, 2)).toBe(1);
    expect(impactLevel(10, 2)).toBeGreaterThan(impactLevel(5, 2));
  });

  it("縁石のがたがたは速いほど細かい", () => {
    expect(rumbleHz(30)).toBeGreaterThan(rumbleHz(10));
    expect(rumbleHz(0)).toBeGreaterThan(0);
  });
});

describe("音の設定", () => {
  it("壊れた・ない値は決まりの値", () => {
    expect(parseAudioSettings(null)).toEqual(DEFAULT_AUDIO);
    expect(parseAudioSettings("{bad")).toEqual(DEFAULT_AUDIO);
    expect(parseAudioSettings("42")).toEqual(DEFAULT_AUDIO);
    expect(parseAudioSettings('{"sfx":"no","volume":"x"}')).toEqual(DEFAULT_AUDIO);
  });
  it("読める値は使い、音量は 0..1 に収める", () => {
    expect(parseAudioSettings('{"sfx":false,"music":false,"volume":0.3}')).toEqual({ sfx: false, music: false, volume: 0.3 });
    expect(parseAudioSettings('{"volume":5}').volume).toBe(1);
    expect(parseAudioSettings('{"volume":-1}').volume).toBe(0);
  });
  it("決まり: 曲も効果音も入、音量は控えめ", () => {
    expect(DEFAULT_AUDIO.sfx).toBe(true);
    expect(DEFAULT_AUDIO.music).toBe(true);
    expect(DEFAULT_AUDIO.volume).toBeLessThanOrEqual(0.7);
  });
});

describe("ほかの車・旗・周・ピットの合図", () => {
  it("横滑り: 向きに沿った速さは 0、真横は全部", () => {
    expect(lateralSlip(30, 0, 0)).toBeCloseTo(0);
    expect(lateralSlip(0, 5, 0)).toBeCloseTo(5);
    expect(lateralSlip(0, 30, Math.PI / 2)).toBeCloseTo(0);
    expect(lateralSlip(3, 0, Math.PI / 2)).toBeCloseTo(3);
  });

  it("ほかの車のぶつかり: ブレーキの減り方では鳴らさず、急に落ちたら落ちた分", () => {
    // 0.1 秒で 4 m/s (40 m/s²) はブレーキ
    expect(otherHitStrength(60, 56, 0.1)).toBe(0);
    // 0.1 秒で 20 m/s (200 m/s²) はぶつかり
    expect(otherHitStrength(60, 40, 0.1)).toBe(20);
    expect(otherHitStrength(40, 60, 0.1)).toBe(0);
    expect(otherHitStrength(60, 40, 0)).toBe(0);
    // しきいのすぐ上と下
    expect(otherHitStrength(50, 50 - OTHER_HIT_DECEL * 0.1 * 1.01, 0.1)).toBeGreaterThan(0);
    expect(otherHitStrength(50, 50 - OTHER_HIT_DECEL * 0.1 * 0.99, 0.1)).toBe(0);
  });

  it("旗: 重さ (緑 < 黄 < VSC < SC)。重くなればその旗、緑に戻れば緑、はじめは鳴らさない", () => {
    expect(flagLevel("green", 0)).toBe(0);
    expect(flagLevel("green", 2)).toBe(1);
    expect(flagLevel("vsc", 1)).toBe(2);
    expect(flagLevel("sc", 0)).toBe(3);
    expect(flagLevel(undefined, 0)).toBe(0);
    expect(flagCue(-1, 3)).toBe("none");
    expect(flagCue(0, 0)).toBe("none");
    expect(flagCue(0, 1)).toBe("yellow");
    expect(flagCue(1, 2)).toBe("vsc");
    expect(flagCue(0, 3)).toBe("sc");
    expect(flagCue(3, 0)).toBe("green");
    expect(flagCue(2, 0)).toBe("green");
    expect(flagCue(3, 2)).toBe("none");
  });

  it("周: 自己ベストは紫の音、ほかの車より速ければその場の一番。はじめの周と遅い周・数えない周は鳴らさない", () => {
    expect(lapChime(80, true, null, Infinity)).toBe("none");
    expect(lapChime(80, true, null, 81)).toBe("session");
    expect(lapChime(79, true, 80, Infinity)).toBe("pb");
    expect(lapChime(79, true, 80, 78)).toBe("pb");
    expect(lapChime(77, true, 80, 78)).toBe("session");
    expect(lapChime(81, true, 80, 90)).toBe("none");
    expect(lapChime(70, false, 80, 90)).toBe("none");
  });

  it("ホイールガン: 4 輪なら外す 4 回 + 締める 4 回、全部 作業の中、外すのが先", () => {
    const out = new Float32Array(16);
    expect(wheelGunTimes(0, 4, out)).toBe(0);
    const n = wheelGunTimes(3.9, 4, out);
    expect(n).toBe(8);
    for (let i = 0; i < 4; i++) {
      expect(out[i]).toBeGreaterThan(0);
      expect(out[4 + i]).toBeGreaterThan(out[i]);
      expect(out[4 + i]).toBeLessThan(3.9);
    }
    // 輪の数は入れ物の大きさまで
    expect(wheelGunTimes(5, 20, out)).toBe(16);
    // 作業が短くても、締めるのは外したあと
    wheelGunTimes(0.4, 4, out);
    for (let i = 0; i < 4; i++) expect(out[4 + i]).toBeGreaterThan(out[i]);
  });

  it("燃料のホース: 入れる間だけ", () => {
    expect(fuelHissOn(1, 0)).toBe(false);
    expect(fuelHissOn(0.1, 4)).toBe(false);
    expect(fuelHissOn(2, 4)).toBe(true);
    expect(fuelHissOn(4, 4)).toBe(false);
  });
});
