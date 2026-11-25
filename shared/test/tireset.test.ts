import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS, DT, LOBBY_MS, RaceRoom, SAMPLE_DESIGN, TIRE_ORDER, allocRules, allocTotal, applyQualiRun, autoTireAlloc, botInput, botStartSetup,
  changeQualiAlloc, computeStats, createCar, dryKinds, fitAlloc, forecastWetMax, getTrack, lockQuali, makeBrain, newLapState, newQualiTires,
  pickFromSets, qualiRunTire, raceSetupFromQuali, readTireSets, requestPit, returnSet, serviceTime, setOptions, setsCount, setsFromAlloc,
  startFromAlloc, stepCar, swapSet, takeSet, tireSetLimit, updateBotPit, updateLaps, validateAlloc, wetnessAt,
  type CarState, type TireCompound, type TireSets, type WeatherPlan,
} from "../src/index.ts";

const track = getTrack("aozu");
const stats = computeStats(SAMPLE_DESIGN);

function lcg(seed: number) {
  let r = seed;
  return () => ((r = (r * 16807) % 2147483647) / 2147483647);
}

describe("持っていけるタイヤの組の数", () => {
  it("すぐ走る: 2 周 2 組・5 周 3 組・10 周 4 組。練習は決まりなし", () => {
    expect(tireSetLimit("quick", 2)).toBe(2);
    expect(tireSetLimit("quick", 5)).toBe(3);
    expect(tireSetLimit("quick", 10)).toBe(4);
    expect(tireSetLimit("practice", 5)).toBe(Infinity);
    expect(tireSetLimit("quick", 0)).toBe(Infinity);
  });
  it("大会と自分で開く部屋: 周 ÷ 3 + 1 (切り上げ、最大 8)。予選ありは + 2", () => {
    expect(tireSetLimit("tournament", 5)).toBe(3);
    expect(tireSetLimit("custom", 10)).toBe(5);
    expect(tireSetLimit("custom", 7)).toBe(4);
    expect(tireSetLimit("custom", 40)).toBe(8);
    expect(tireSetLimit("tournament", 5, { qualifying: true })).toBe(5);
    expect(tireSetLimit("custom", 40, { qualifying: true })).toBe(10);
  });
});

describe("組の決まりを確かめる", () => {
  it("上限を超える・空はだめ", () => {
    const r = allocRules("quick", 5);
    expect(validateAlloc({ S: 2, M: 1 }, r)).toEqual([]);
    expect(validateAlloc({ S: 2, M: 2 }, r).length).toBe(1);
    expect(validateAlloc({}, r).length).toBe(1);
    expect(validateAlloc({ S: -1, M: 1 }, r).length).toBeGreaterThan(0);
    expect(validateAlloc({ S: 1.5 }, r).length).toBeGreaterThan(0);
  });
  it("雨用は自由 (入れても入れなくてもよい)", () => {
    const r = allocRules("quick", 5);
    expect(validateAlloc({ M: 3 }, r)).toEqual([]);
    expect(validateAlloc({ M: 1, I: 1, W: 1 }, r)).toEqual([]);
  });
  it("大会: 乾いた路面用を 2 種類以上", () => {
    const r = allocRules("tournament", 5);
    expect(r.minDry).toBe(2);
    expect(validateAlloc({ S: 3 }, r).length).toBe(1);
    expect(validateAlloc({ S: 2, I: 1 }, r).length).toBe(1);
    expect(validateAlloc({ S: 2, H: 1 }, r)).toEqual([]);
    expect(validateAlloc({ S: 3 }, allocRules("quick", 5))).toEqual([]);
  });
  it("fitAlloc: 上限まで減らし、大会なら種類を足す", () => {
    const a = fitAlloc({ S: 3, M: 2, I: 1 }, allocRules("quick", 5), "S");
    expect(allocTotal(a)).toBe(3);
    expect(a.S).toBeGreaterThan(0);
    expect(fitAlloc({}, allocRules("quick", 2), "H")).toEqual({ H: 1 });
    const t = fitAlloc({ S: 3 }, allocRules("tournament", 5));
    expect(allocTotal(t)).toBe(3);
    expect(dryKinds(t)).toBe(2);
    const t2 = fitAlloc({ S: 1, I: 1 }, allocRules("tournament", 2));
    expect(validateAlloc(t2, allocRules("tournament", 2))).toEqual([]);
  });
});

describe("持っている組を使う", () => {
  it("新品を使い切ったら、使った組 (一番減っていないもの) を履く", () => {
    let s: TireSets = setsFromAlloc({ S: 1, M: 1 });
    const a = takeSet(s, { tire: "S" })!;
    expect(a.fitted).toEqual({ tire: "S", wear: 0 });
    s = returnSet(a.sets, "S", 0.6);
    s = returnSet(s, "S", 0.3);
    expect(setsCount(s)).toBe(3);
    const b = takeSet(s, { tire: "S" })!;
    expect(b.fitted.wear).toBeCloseTo(0.3);
    const c = takeSet(s, { tire: "S", used: 0 })!;
    expect(c.fitted.wear).toBeCloseTo(0.6);
    expect(takeSet(s, { tire: "H" })).toBeNull();
    expect(takeSet(s, { tire: "M", used: 0 })).toBeNull();
    // 元の組は変わらない
    expect(setsCount(s)).toBe(3);
  });
  it("破裂したタイヤは使った組に戻らない", () => {
    const s = returnSet(setsFromAlloc({}), "S", 1, true);
    expect(s.used.length).toBe(0);
  });
  it("swapSet: 今のタイヤを戻して選んだ組を履く", () => {
    const sw = swapSet(setsFromAlloc({ H: 1 }), { tire: "S", wear: 0.5, burst: false }, { tire: "H" })!;
    expect(sw.fitted).toEqual({ tire: "H", wear: 0 });
    expect(sw.sets.fresh.H ?? 0).toBe(0);
    expect(sw.sets.used).toEqual([{ tire: "S", wear: 0.5 }]);
  });
  it("setOptions: 新品は種類ごと、使った組は 1 つずつ", () => {
    const s: TireSets = { fresh: { M: 2 }, used: [{ tire: "S", wear: 0.4 }, { tire: "M", wear: 0.2 }] };
    const o = setOptions(s);
    expect(o.map((x) => `${x.tire}${x.used ?? "n"}`)).toEqual(["Mn", "S0", "M1"]);
    expect(o[0].count).toBe(2);
  });
  it("readTireSets: おかしいものは読まない", () => {
    expect(readTireSets({ fresh: { S: 2, X: 3 }, used: [{ tire: "M", wear: 2 }] })).toEqual({ fresh: { S: 2 }, used: [{ tire: "M", wear: 1 }] });
    expect(readTireSets({ fresh: {}, used: [{ tire: "Z", wear: 0 }] })).toBeNull();
    expect(readTireSets(null)).toBeNull();
  });
  it("pickFromSets: 雨用がなければ乾いたタイヤのまま (null)。近い種類を選ぶ", () => {
    expect(pickFromSets(setsFromAlloc({ S: 1 }), "W")).toBeNull();
    expect(pickFromSets(setsFromAlloc({ S: 1, I: 1 }), "W")).toEqual({ tire: "I", used: null });
    expect(pickFromSets(setsFromAlloc({ H: 1 }), "S")).toEqual({ tire: "H", used: null });
    expect(pickFromSets({ fresh: {}, used: [{ tire: "M", wear: 0.8 }] }, "M")).toBeNull();
    expect(pickFromSets({ fresh: {}, used: [{ tire: "M", wear: 0.5 }] }, "M")).toEqual({ tire: "M", used: 0 });
  });
});

describe("ピットのタイヤ交換が組から取る", () => {
  function pitOnce(car: CarState, order: Parameters<typeof requestPit>[1]) {
    requestPit(car, order);
    car.pit = { phase: "box", u: track.pit.box, v: 0, d0: 0, base: 0, elapsed: 99, service: 0 };
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, stats, track, DT);
  }
  it("組があれば組から履き、外したタイヤは使った組に戻る。最初のタイヤは組に入らない", () => {
    const st = startFromAlloc({ S: 2, M: 1 }, "S");
    expect(st.tire).toBe("S");
    expect(st.sets.fresh).toEqual({ S: 1, M: 1 });
    const car = createCar(track, stats, 0, { tire: st.tire, sets: st.sets });
    car.wear = 0.4;
    pitOnce(car, { tire: "M" });
    expect(car.tire).toBe("M");
    expect(car.wear).toBe(0);
    expect(car.sets!.fresh).toEqual({ S: 1 });
    expect(car.sets!.used).toEqual([{ tire: "S", wear: 0.4 }]);
    // また付け替えて、使った S を履く
    car.wear = 0.2;
    pitOnce(car, { tire: "S", used: 0 });
    expect(car.tire).toBe("S");
    expect(car.wear).toBeCloseTo(0.4);
    expect(car.sets!.fresh).toEqual({ S: 1 });
  });
  it("持っていない種類は替えない (作業の時間にも入らない)", () => {
    const car = createCar(track, stats, 0, { tire: "M", sets: setsFromAlloc({ S: 1 }) });
    car.wear = 0.5;
    expect(serviceTime(car, stats, { tire: "W" })).toBe(0);
    expect(serviceTime(car, stats, { tire: "S" })).toBeGreaterThan(0);
    pitOnce(car, { tire: "W" });
    expect(car.tire).toBe("M");
    expect(car.wear).toBe(0.5);
  });
  it("前からの呼び方 (組なし) は今までどおり何でも新品に替えられる", () => {
    const car = createCar(track, stats, 0, { tire: "M" });
    expect(car.sets).toBeNull();
    expect(car.wear).toBe(0);
    car.wear = 0.7;
    pitOnce(car, { tire: "W" });
    expect(car.tire).toBe("W");
    expect(car.wear).toBe(0);
    expect(car.sets).toBeNull();
    expect(botStartSetup(stats, track, 5, 0).sets).toBeUndefined();
  });
  it("createCar に渡した組は写しを持つ (元の組を変えない)", () => {
    const sets = setsFromAlloc({ S: 1 });
    const car = createCar(track, stats, 0, { tire: "M", sets });
    car.sets!.fresh.S = 0;
    expect(sets.fresh.S).toBe(1);
  });
});

describe("コンピューターの組の選び方", () => {
  it("上限ちょうど、決まりに合う。晴れは乾いた路面用だけ", () => {
    for (const laps of [2, 5, 10]) {
      const rules = allocRules("quick", laps);
      const a = autoTireAlloc({ trackLength: track.length, laps, rules, wetStart: 0, wetMax: 0 });
      expect(allocTotal(a.alloc)).toBe(rules.limit);
      expect(validateAlloc(a.alloc, rules)).toEqual([]);
      expect((a.alloc.I ?? 0) + (a.alloc.W ?? 0)).toBe(0);
      expect(a.alloc[a.start]).toBeGreaterThan(0);
    }
  });
  it("雨の見込みがあれば雨用を入れ、濡れたスタートなら雨用から", () => {
    const rules = allocRules("quick", 5);
    const a = autoTireAlloc({ trackLength: track.length, laps: 5, rules, wetStart: 0, wetMax: 0.95 });
    expect(a.alloc.W).toBe(1);
    expect(TIRE_ORDER.includes(a.start)).toBe(true);
    expect(a.start).not.toBe("W");
    const b = autoTireAlloc({ trackLength: track.length, laps: 5, rules, wetStart: 0.5, wetMax: 0.5 });
    expect(b.start).toBe("I");
  });
  it("大会: 乾いた路面用を 2 種類 (雨でも)", () => {
    for (const laps of [2, 5, 10]) {
      const rules = allocRules("tournament", laps);
      for (const w of [0, 0.5, 0.95]) {
        const a = autoTireAlloc({ trackLength: track.length, laps, rules, wetStart: w, wetMax: w });
        expect(validateAlloc(a.alloc, rules)).toEqual([]);
      }
    }
  });
  it("予報: 見込み 50% 以上の雨だけ数える", () => {
    expect(forecastWetMax(0, [{ inSec: 60, sky: "heavy", chance: 30, text: "" }])).toBe(0);
    expect(forecastWetMax(0, [{ inSec: 60, sky: "light", chance: 60, text: "" }])).toBe(0.5);
  });
  it("botStartSetup に決まりを渡すと組を持つ。予定 (alloc) があればそれを使う", () => {
    const s = botStartSetup(stats, track, 5, 0, 0, undefined, { rules: allocRules("quick", 5) });
    expect(s.sets).toBeTruthy();
    expect(setsCount(s.sets!) + 1).toBe(3);
    const p = botStartSetup(stats, track, 5, 0, 0, undefined, { rules: allocRules("quick", 5), alloc: { H: 2, I: 1 } });
    expect(p.tire).toBe("H");
    expect(p.sets).toEqual({ fresh: { H: 1, I: 1 }, used: [] });
  });
});

describe("コンピューターのレースで、どの車も持っている組の中だけで走る", () => {
  const RAINY: WeatherPlan = {
    seed: 3,
    changes: [
      { at: 0, sky: "sun" },
      { at: 90, sky: "heavy" },
      { at: 200, sky: "sun" },
    ],
    fakes: [],
    startWet: 0,
  };
  for (const [laps, plan, name] of [
    [10, { seed: 1, changes: [{ at: 0, sky: "sun" }], fakes: [], startWet: 0 } as WeatherPlan, "晴れ 10 周"],
    [10, RAINY, "途中で大雨 10 周"],
  ] as const) {
    it(name, () => {
      const rand = lcg(7);
      const rules = allocRules("quick", laps);
      const cars = BOT_DESIGNS.slice(0, 4).map((d, i) => {
        const st = computeStats(d);
        // 1 台は雨用を持たない組 (雨が来ても乾いたタイヤのまま)
        const tires = i === 0 ? { rules, alloc: { S: 2, M: 2 } } : { rules, wetMax: i === 1 ? 0 : 0.95 };
        const setup = botStartSetup(st, track, laps, 0, 0, rand, tires);
        const car = createCar(track, st, i, setup);
        car.started = true;
        const alloc = new Map<TireCompound, number>();
        alloc.set(setup.tire!, 1);
        for (const c of TIRE_ORDER) alloc.set(c, (alloc.get(c) ?? 0) + (setup.sets!.fresh[c] ?? 0));
        return { st, car, brain: makeBrain(rand, 0.9), lap: newLapState(), alloc, fitted: new Map(alloc.entries()), pits: 0 };
      });
      for (const c of cars) for (const v of c.fitted.keys()) c.fitted.set(v, 0);
      for (const c of cars) c.fitted.set(c.car.tire, 1);
      let t = 0;
      while (t < 900 && cars.some((c) => !c.lap.finished && !c.lap.retired)) {
        const wet = wetnessAt(plan, t);
        for (const c of cars) {
          if (c.lap.finished || c.lap.retired) continue;
          updateBotPit(c.car, c.st, track, c.brain, { totalLaps: laps, wetNow: wet, wetSoon: wetnessAt(plan, t + 40) });
          const before = { tire: c.car.tire, wear: c.car.wear, n: setsCount(c.car.sets!) };
          const ev = stepCar(c.car, botInput(c.car, c.st, track, c.brain, t, [], wet), c.st, track, DT, { wetness: wet });
          updateLaps(c.car, c.lap, ev, t, track.length, laps, false);
          // 組の数は増えない。替えたら新しい種類は持っていった種類
          expect(setsCount(c.car.sets!) + 1).toBeLessThanOrEqual(rules.limit);
          if (c.car.tire !== before.tire || c.car.wear < before.wear - 1e-9) {
            c.pits++;
            expect(c.alloc.get(c.car.tire) ?? 0).toBeGreaterThan(0);
            if (c.car.wear === 0) c.fitted.set(c.car.tire, (c.fitted.get(c.car.tire) ?? 0) + 1);
          }
        }
        t += DT;
      }
      for (const c of cars) {
        expect(c.lap.finished).toBe(true);
        expect(c.pits).toBeGreaterThan(0);
        // 新品で履いた数は、持っていった数まで
        for (const [tire, n] of c.fitted) expect(n).toBeLessThanOrEqual(c.alloc.get(tire) ?? 0);
      }
      // 雨用を持たない車は雨用を履かない
      expect(cars[0].alloc.get("W") ?? 0).toBe(0);
      expect(cars[0].fitted.get("W") ?? 0).toBe(0);
    });
  }

  it("部屋のコンピューターの車は、すぐ走るの組の数だけ持つ", () => {
    const room = new RaceRoom({ send: () => {}, broadcast: () => {} }, 5, lcg(11));
    let now = 0;
    room.join("k", "テスト", SAMPLE_DESIGN, now);
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    const ents = [...(room as unknown as { entrants: Map<string, { bot: boolean; car: CarState }> }).entrants.values()];
    const bots = ents.filter((e) => e.bot);
    expect(bots.length).toBe(7);
    for (const b of bots) {
      expect(b.car.sets).toBeTruthy();
      expect(setsCount(b.car.sets!) + 1).toBe(3);
    }
    // 人の車は (画面が送ってくるまで) 組なし
    expect(ents.find((e) => !e.bot)!.car.sets).toBeNull();
  });
});

describe("予選と決勝を通して同じ組", () => {
  it("予選の前は組を変えられ、走り始めたら決まる", () => {
    const q = newQualiTires({ S: 3, M: 2 });
    expect(changeQualiAlloc(q, { S: 2, H: 3 })!.alloc).toEqual({ S: 2, H: 3 });
    const locked = lockQuali(q);
    expect(locked.locked).toBe(true);
    expect(changeQualiAlloc(locked, { H: 5 })).toBeNull();
  });
  it("予選の減りは組に残り、決勝に持ち越す。減った組からもスタートできる", () => {
    let q = newQualiTires({ S: 3, M: 2 });
    expect(qualiRunTire(q, { tire: "S" })).toEqual({ tire: "S", wear: 0 });
    q = applyQualiRun(q, { tire: "S" }, 0.25)!;
    expect(q.locked).toBe(true);
    expect(q.runs).toBe(1);
    expect(q.sets.fresh).toEqual({ S: 2, M: 2 });
    expect(q.sets.used).toEqual([{ tire: "S", wear: 0.25 }]);
    // 同じ組でもう 1 回: 減りが重なる (走る前より少なくはならない)
    expect(qualiRunTire(q, { tire: "S", used: 0 })).toEqual({ tire: "S", wear: 0.25 });
    q = applyQualiRun(q, { tire: "S", used: 0 }, 0.4)!;
    expect(q.sets.used).toEqual([{ tire: "S", wear: 0.4 }]);
    q = applyQualiRun(q, { tire: "S", used: 0 }, 0.1)!;
    expect(q.sets.used[0].wear).toBeCloseTo(0.4);
    // 持っていない種類は走れない
    expect(applyQualiRun(q, { tire: "H" }, 0.1)).toBeNull();
    // JSON にしても同じ
    q = JSON.parse(JSON.stringify(q));
    // 決勝: 減った S からスタート
    const r = raceSetupFromQuali(q, { tire: "S", used: 0 })!;
    expect(r.tire).toBe("S");
    expect(r.wear).toBeCloseTo(0.4);
    expect(r.sets).toEqual({ fresh: { S: 2, M: 2 }, used: [] });
    const car = createCar(track, stats, 0, { tire: r.tire, wear: r.wear, sets: r.sets });
    expect(car.wear).toBeCloseTo(0.4);
    expect(setsCount(car.sets!)).toBe(4);
  });
  it("予選で破裂した組はなくなる", () => {
    const q = applyQualiRun(newQualiTires({ S: 1, M: 1 }), { tire: "S" }, 1, true)!;
    expect(setsCount(q.sets)).toBe(1);
    expect(raceSetupFromQuali(q, { tire: "S" })).toBeNull();
  });
  it("予選ありの組の数は決勝だけの + 2", () => {
    const r = allocRules("tournament", 5, { qualifying: true });
    expect(r.limit).toBe(5);
    expect(validateAlloc({ S: 3, M: 2 }, r)).toEqual([]);
  });
});
