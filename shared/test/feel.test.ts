// 11/25 試走の直し: 芝・ボタンのハンドル・かんたん操作・ゴールのあと・大雨のタイヤの組。
// 数は全部 (仮)。前の値は physics.ts の直しの前に はかったもの。
import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS, DT, FINISH_SPEED, SAMPLE_DESIGN, STEER_BUILD, STEER_RETURN, TRACK_DEFS, TIRE_ORDER, allocRules, autoTireAlloc, botInput,
  botStartSetup, computeStats, createCar, finishInput, getTrack, makeBrain, newLapState, pointAt, queryTrack, rampSteer, stepCar,
  updateBotPit, updateLaps, type CarState, type CarStats, type TireCompound, type Track,
} from "../src/index.ts";

const lcg = (seed: number) => {
  let r = seed;
  return () => ((r = (r * 16807) % 2147483647) / 2147483647);
};

/** コースの距離 s・横のずれ d に、向きをそろえて速さ v で置いた車 */
function placeCar(track: Track, stats: CarStats, s: number, d: number, v: number, setup: { tire?: TireCompound; wear?: number } = {}): CarState {
  const car = createCar(track, stats, 0, setup);
  const p = pointAt(track, s, d);
  car.x = p.x;
  car.y = p.y;
  car.heading = p.heading;
  car.vx = Math.cos(p.heading) * v;
  car.vy = Math.sin(p.heading) * v;
  const q = queryTrack(track, car.x, car.y);
  car.hint = q.index;
  car.lastS = q.s;
  car.dist = q.s;
  car.started = true;
  return car;
}

/**
 * 上手な人のボタン操作: コンピューターの切りたい量を、押す長さで加減する (rampSteer を通る)。
 * assist = かんたん操作 (アクセル・ブレーキは押さない)。center = 走る線ではなく 中心からこのずれの線を狙う (へたな人)
 */
function humanLap(trackId: string, o: { assist?: boolean; center?: number; laps?: number; wet?: number; tire?: TireCompound } = {}) {
  const track = getTrack(trackId);
  const stats = computeStats(SAMPLE_DESIGN);
  const car = createCar(track, stats, 0, { tire: o.tire });
  car.started = true;
  const brain = makeBrain(lcg(3), 0.9);
  const st = newLapState();
  const wet = o.wet ?? 0;
  let t = 0;
  let grass = 0;
  let walls = 0;
  let held = 0;
  let owe = 0;
  while (t < 900 && !st.finished && !st.retired) {
    const inp = botInput(car, stats, track, brain, t, [], wet);
    let want = inp.steer;
    if (o.center !== undefined) {
      const tg = pointAt(track, car.lastS + 6 + Math.hypot(car.vx, car.vy) * 0.45, o.center);
      let df = Math.atan2(tg.y - car.y, tg.x - car.x) - car.heading;
      while (df > Math.PI) df -= 2 * Math.PI;
      while (df < -Math.PI) df += 2 * Math.PI;
      want = Math.max(-1, Math.min(1, df * 2.5));
    }
    const u = owe + want;
    held = rampSteer(held, u > 0.5 ? 1 : u < -0.5 ? -1 : 0, DT);
    owe = u - held;
    const input = o.assist
      ? { steer: held, throttle: 0, brake: 0, assist: true }
      : { steer: held, throttle: inp.throttle > 0.5 ? 1 : 0, brake: inp.brake > 0.2 ? 1 : 0 };
    const ev = stepCar(car, input, stats, track, DT, { wetness: wet });
    t += DT;
    if (ev.wall > 3) walls++;
    if (car.surface === "grass") grass += DT;
    updateLaps(car, st, ev, t, track.length, o.laps ?? 3, false);
  }
  return { best: st.bestLap ?? Infinity, finished: st.finished, grass, walls };
}

describe("芝", () => {
  /** 壁の手前の芝に止まった車が、コンピューターの運転で戻る。道に出るまでと 100 km/h までの秒 */
  function fromGrass(tire: TireCompound, wet: number, wear: number, side: 1 | -1) {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const car = placeCar(track, stats, 1100, side * (track.def.halfWidth + track.def.runoff - 1.5), 0, { tire, wear });
    const brain = makeBrain(lcg(5), 1);
    let t = 0;
    let onTrack = Infinity;
    let to100 = Infinity;
    while (t < 30) {
      stepCar(car, botInput(car, stats, track, brain, t + 100, [], wet), stats, track, DT, { wetness: wet });
      t += DT;
      if (onTrack === Infinity && car.surface !== "grass") onTrack = t;
      if (Math.hypot(car.vx, car.vy) >= 100 / 3.6) {
        to100 = t;
        break;
      }
    }
    return { onTrack, to100 };
  }

  it("濡れた芝に止まった車 (溝のないタイヤ) も動き出して道に戻れる (前は動けなかった)", () => {
    for (const tire of ["S", "M", "H"] as const) {
      for (const side of [1, -1] as const) {
        const r = fromGrass(tire, 1, 0, side);
        expect(r.onTrack, `${tire} ${side}`).toBeLessThan(4);
      }
    }
  });

  it("どのタイヤでも (すり減っていても、濡れていても) 止まった芝から道に戻れる", () => {
    for (const tire of TIRE_ORDER) {
      for (const wet of [0, 0.5, 1]) {
        for (const wear of [0, 0.95]) {
          const r = fromGrass(tire, wet, wear, 1);
          expect(r.onTrack, `${tire} wet ${wet} wear ${wear}`).toBeLessThan(5);
        }
      }
    }
  });

  it("乾いた芝に止まってから 100 km/h まで 3〜4 秒くらい (前は 約 5.7 秒)", () => {
    for (const side of [1, -1] as const) {
      const r = fromGrass("M", 0, 0, side);
      expect(r.onTrack).toBeLessThan(2.5);
      expect(r.to100).toBeLessThan(4.3);
    }
  });

  it("速いときの芝は前 (5 m/s²) より強く遅くなる", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const v0 = 140 / 3.6;
    const car = placeCar(track, stats, 60, track.def.halfWidth + 3, v0);
    for (let i = 0; i < 15; i++) stepCar(car, { steer: 0, throttle: 0, brake: 0 }, stats, track, DT);
    expect(car.surface).toBe("grass");
    const decel = (v0 - Math.hypot(car.vx, car.vy)) / (15 * DT);
    expect(decel).toBeGreaterThan(8);
  });
});

describe("ボタンのハンドル", () => {
  it("rampSteer: STEER_BUILD 秒でいっぱい、STEER_RETURN 秒で戻る。同じ押し方なら同じ値", () => {
    let s = 0;
    // 11/25 2 回目: いっぱいまで 0.2 秒 → 0.07 秒 (5 刻み目でいっぱい)
    const up = Math.ceil(STEER_BUILD / DT - 1e-9);
    for (let i = 0; i < up - 1; i++) s = rampSteer(s, 1);
    expect(s).toBeGreaterThan(1 - DT / STEER_BUILD);
    expect(s).toBeLessThan(1);
    s = rampSteer(s, 1);
    expect(s).toBe(1);
    const down = Math.ceil(STEER_RETURN / DT - 1e-9);
    for (let i = 0; i < down; i++) s = rampSteer(s, 0);
    expect(s).toBe(0);
    // 反対へ切るときは まず速く戻る
    s = 1;
    s = rampSteer(s, -1);
    expect(s).toBeCloseTo(1 - DT / STEER_RETURN, 10);
  });

  /** 140 km/h で直線を走り、ms ミリ秒だけ右を押したときの向きの変わり (度、1 秒後) */
  function tap(ms: number): number {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const car = placeCar(track, stats, 60, 0, 140 / 3.6);
    const h0 = car.heading;
    const n = Math.round(ms / 1000 / DT);
    let s = 0;
    for (let i = 0; i < 60; i++) {
      s = rampSteer(s, i < n ? 1 : 0);
      stepCar(car, { steer: s, throttle: 0, brake: 0 }, stats, track, DT);
    }
    return ((car.heading - h0) * 180) / Math.PI;
  }

  // 11/25 2 回目「曲がらなさすぎ」: 1 回目の直しで 約 1.2 度まで抑えたのは効きすぎだったので、約 3 度に戻した (直しの前は 約 6.4 度)。
  // 3 回目「もうちょい」で 約 4.3 度
  it("140 km/h で 50 ms 押すと 約 4 度向きが変わる (直しの前は 約 6.4 度、1 回目 約 1.2 度、2 回目 約 3.1 度)", () => {
    const a = tap(50);
    expect(a).toBeGreaterThan(3.5);
    expect(a).toBeLessThan(5.5);
    // 長く押せば ちゃんと曲がる
    expect(tap(300)).toBeGreaterThan(10);
  });
});

describe("コンピューターの速さは変わらない", () => {
  // 直しの前の 1 周 (上手さ 0.9、4 台の平均、3 周の一番速い周): 青図 34.792・つづら 57.137
  const before: Record<string, number> = { aozu: 34.792, tsuzura: 57.137 };
  // 前の値があるコース (青図・つづら坂) だけ。実在のサーキットは realtracks.test.ts
  for (const def of TRACK_DEFS.filter((d) => d.id in before)) {
    it(`${def.name}: 前との差は 1% より小さい`, () => {
      const track = getTrack(def.id);
      const bests = BOT_DESIGNS.map((d) => {
        const stats = computeStats(d);
        const car = createCar(track, stats, 0);
        car.started = true;
        const brain = makeBrain(lcg(3), 0.9);
        const st = newLapState();
        let t = 0;
        while (t < 900 && !st.finished) {
          const ev = stepCar(car, botInput(car, stats, track, brain, t), stats, track, DT);
          t += DT;
          updateLaps(car, st, ev, t, track.length, 3, false);
        }
        return st.bestLap ?? Infinity;
      });
      const mean = bests.reduce((a, b) => a + b, 0) / bests.length;
      expect(Math.abs(mean / before[def.id] - 1)).toBeLessThan(0.01);
    });
  }
});

describe("かんたん操作", () => {
  for (const def of TRACK_DEFS) {
    it(`${def.name}: 先の曲がりを見て減速し、芝にも壁にも出ずに走り切る。上手な人のボタン操作より少し遅い`, () => {
      const manual = humanLap(def.id);
      const easy = humanLap(def.id, { assist: true });
      expect(easy.finished).toBe(true);
      expect(easy.grass).toBe(0);
      expect(easy.walls).toBe(0);
      expect(easy.best).toBeGreaterThan(manual.best);
      expect(easy.best).toBeLessThan(manual.best * 1.12);
    });
    it(`${def.name}: 走る線を通らない人 (中心・外寄り・内寄り) でも、雨でも 走り切る`, () => {
      for (const center of [0, 3, -3]) {
        const r = humanLap(def.id, { assist: true, center, laps: 2 });
        expect(r.finished, `${center}`).toBe(true);
        expect(r.grass, `${center}`).toBe(0);
      }
      for (const [wet, tire] of [[0.5, "I"], [0.95, "W"], [0.6, "M"]] as const) {
        const r = humanLap(def.id, { assist: true, laps: 2, wet, tire });
        expect(r.finished, `${wet} ${tire}`).toBe(true);
        expect(r.grass, `${wet} ${tire}`).toBe(0);
      }
    });
  }
});

describe("ゴールのあと", () => {
  it("finishInput: 道に沿ってゆっくり走る (芝へまっすぐ出ない)", () => {
    for (const def of TRACK_DEFS) {
      const track = getTrack(def.id);
      const stats = computeStats(SAMPLE_DESIGN);
      const car = placeCar(track, stats, 5, 0, 70);
      let t = 0;
      let grass = 0;
      while (t < 40) {
        stepCar(car, finishInput(car, stats, track, t), stats, track, DT);
        t += DT;
        if (car.surface === "grass") grass += DT;
      }
      expect(grass, def.id).toBe(0);
      expect(car.dist, def.id).toBeGreaterThan(400);
      expect(Math.hypot(car.vx, car.vy), def.id).toBeLessThan(FINISH_SPEED + 1);
    }
  });
});

describe("大雨のタイヤの組 (11/25 リーグ「大雨のつづら坂で ほとんど燃料切れ」)", () => {
  it("濡れたスタートの長いレースでは、雨用をゴールまで持つ数だけ持っていく", () => {
    const track = getTrack("tsuzura");
    const rules = allocRules("league", 8);
    const a = autoTireAlloc({ trackLength: track.length, laps: 8, rules, wetStart: 0.95, wetMax: 0.95 });
    expect(a.start).toBe("W");
    expect(a.alloc.W ?? 0).toBeGreaterThanOrEqual(2);
    expect((a.alloc.S ?? 0) + (a.alloc.M ?? 0) + (a.alloc.H ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("雨用を使い切って破裂したら、破裂のまま走らず 残っている乾いた路面用に替える", () => {
    const track = getTrack("tsuzura");
    const stats = computeStats(SAMPLE_DESIGN);
    const car = placeCar(track, stats, 300, 0, 13, { tire: "W", wear: 0.99 });
    car.wear = 1;
    car.burst = true;
    car.sets = { fresh: { M: 1 }, used: [] };
    updateBotPit(car, stats, track, makeBrain(lcg(3), 0.9), { totalLaps: 8, wetNow: 0.95, wetSoon: 0.95 });
    expect(car.pitOrder?.tire).toBe("M");
  });

  it("大雨のつづら坂 8 周: どの車も燃料切れにならずに走り切る (前は全部 燃料切れ)", () => {
    const track = getTrack("tsuzura");
    const laps = 8;
    const wet = 0.95;
    for (const d of BOT_DESIGNS) {
      const stats = computeStats(d);
      const rand = lcg(3);
      const setup = botStartSetup(stats, track, laps, wet, wet, rand, { rules: allocRules("league", laps), wetMax: wet });
      const car = createCar(track, stats, 0, setup);
      const brain = makeBrain(rand, 0.9);
      const st = newLapState();
      let t = 0;
      while (t < laps * 240 && !st.finished && !st.retired) {
        car.started = true;
        updateBotPit(car, stats, track, brain, { totalLaps: laps, wetNow: wet, wetSoon: wet });
        const ev = stepCar(car, botInput(car, stats, track, brain, t, [], wet), stats, track, DT, { wetness: wet });
        t += DT;
        updateLaps(car, st, ev, t, track.length, laps, false);
      }
      expect(st.finished, d.name).toBe(true);
      expect(st.retired, d.name).toBe(false);
    }
  });
});
