// オーバーテイクモード (overtake.ts) の試験: 使えるかの決まり・目盛りの減りと周ごとの満たし直し・燃料とタイヤの余分・
// 使えない時 (1 周目・旗のあと)・同じ入力なら同じ結果・コンピューターがレースで使う・ひとりの周は変わらない
import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS, DT, bodyOf, LOBBY_MS, OT_AFTER_GREEN, OT_ENERGY, OT_FUEL, OT_GAP, RaceRoom, SAMPLE_DESIGN, SNAP_OT, TRACK_DEFS,
  botInput, computeStats, createCar, flagInfo, getTrack, makeBrain, newLapState, newOvertakeState, newRaceControl, overtakeAvailable, overtakeBoost,
  overtakeGauge, radioCandidates, stepCar, stepRaceControl, updateLaps, updateOvertake, type CarState, type RadioSituation, type RcCar, type ServerMsg,
} from "../src/index.ts";

const track = getTrack("aozu");
const stats = computeStats(SAMPLE_DESIGN);
const L = track.length;

/** スタートの線の少し手前を v m/s で走っている車 */
function carAt(dist: number, v = 50): CarState {
  const car = createCar(track, stats, 0);
  car.started = true;
  car.dist = dist;
  car.vx = Math.cos(car.heading) * v;
  car.vy = Math.sin(car.heading) * v;
  return car;
}

describe("使えるかの決まり (スタートの線で前と 1 秒以内)", () => {
  it("周を終えたとき前の車と OT_GAP 秒以内なら、次の周に目盛りいっぱい", () => {
    const car = carAt(L - 1);
    car.dist = L + 0.5;
    // 前の車は 40 m 前 (50 m/s で 0.8 秒)
    updateOvertake(car, track, L - 1, [L + 40.5], true);
    expect(car.ot!.armed).toBe(true);
    expect(car.ot!.energy).toBe(OT_ENERGY);
    expect(car.ot!.gap).toBeCloseTo(0.8, 5);
    expect(overtakeAvailable(car)).toBe(true);
    expect(overtakeGauge(car)).toBe(1);
  });

  it("前と 1 秒より離れている・前に誰もいない・レースが許していない・ピットの道では使えない", () => {
    for (const [others, enabled] of [[[L + 0.5 + 50 * (OT_GAP + 0.2)], true], [[], true], [[L + 20], false]] as const) {
      const car = carAt(L - 1);
      car.dist = L + 0.5;
      updateOvertake(car, track, L - 1, others, enabled);
      expect(car.ot!.armed).toBe(false);
      expect(overtakeAvailable(car)).toBe(false);
    }
  });

  it("レースの始まり (並びからスタートの線を越える) は周の終わりに数えない = 1 周目は使えない", () => {
    const car = carAt(-2);
    car.dist = 1;
    updateOvertake(car, track, -2, [20], true);
    expect(car.ot!.armed).toBe(false);
  });
});

describe("目盛り", () => {
  it("押していてアクセルを踏んでいる間だけ減る。なくなったら力は出ない", () => {
    const car = carAt(L + 10);
    car.ot = { ...newOvertakeState(), armed: true, ok: true, energy: OT_ENERGY };
    // 押していない・アクセルなし
    expect(overtakeBoost(car, false, DT)).toBe(1);
    stepCar(car, { steer: 0, throttle: 0, brake: 0, overtake: true }, stats, track);
    expect(car.ot.energy).toBe(OT_ENERGY);
    expect(car.ot.active).toBe(false);
    stepCar(car, { steer: 0, throttle: 1, brake: 0 }, stats, track);
    expect(car.ot.energy).toBe(OT_ENERGY);
    // 押して踏む
    stepCar(car, { steer: 0, throttle: 1, brake: 0, overtake: true }, stats, track);
    expect(car.ot.active).toBe(true);
    expect(car.ot.energy).toBeCloseTo(OT_ENERGY - DT, 9);
    car.ot.energy = DT / 2;
    expect(overtakeBoost(car, true, DT)).toBeGreaterThan(1);
    expect(car.ot.energy).toBe(0);
    expect(overtakeBoost(car, true, DT)).toBe(1);
    expect(overtakeAvailable(car)).toBe(false);
  });

  it("周をまたいで持ち越さない: 次の線で 前と近ければ満たし直し、離れていれば 0", () => {
    const car = carAt(L + 10);
    car.ot = { ...newOvertakeState(), armed: true, ok: true, energy: 1.2 };
    car.dist = 2 * L + 0.5;
    updateOvertake(car, track, 2 * L - 1, [2 * L + 20], true);
    expect(car.ot.energy).toBe(OT_ENERGY);
    car.ot.energy = 2;
    car.dist = 3 * L + 0.5;
    updateOvertake(car, track, 3 * L - 1, [3 * L + 400], true);
    expect(car.ot.armed).toBe(false);
    expect(car.ot.energy).toBe(0);
  });

  it("使っている間は 速く、燃料とタイヤが少し多く減る", () => {
    const run = (use: boolean) => {
      const car = carAt(L + 10, 30);
      car.ot = { ...newOvertakeState(), armed: true, ok: true, energy: OT_ENERGY };
      for (let i = 0; i < 60; i++) stepCar(car, { steer: 0, throttle: 1, brake: 0, overtake: use }, stats, track);
      return car;
    };
    const off = run(false);
    const on = run(true);
    expect(Math.hypot(on.vx, on.vy)).toBeGreaterThan(Math.hypot(off.vx, off.vy) + 0.2);
    expect(off.fuel - on.fuel).toBeGreaterThan(OT_FUEL * 0.9);
    expect(on.wear).toBeGreaterThan(off.wear);
  });

  it("レースが許していなければ (旗のあと など) 目盛りがあっても使えない", () => {
    const car = carAt(L + 10);
    car.ot = { ...newOvertakeState(), armed: true, ok: true, energy: OT_ENERGY };
    updateOvertake(car, track, car.dist - 1, [], false);
    expect(overtakeAvailable(car)).toBe(false);
    expect(overtakeBoost(car, true, DT)).toBe(1);
    expect(car.ot.energy).toBe(OT_ENERGY);
  });
});

describe("レースが許す時 (racecontrol の ot)", () => {
  const cars = (lapsDone: number): RcCar[] => [{ id: "a", dist: lapsDone * L + 10, speed: 50, lapsDone, started: true, pit: false, finished: false, retired: false, hits: 0, lost: 0 }];
  it("1 周目は使えない。先頭が 1 周を終えて、緑から 15 秒たてば使える。雨でも使える (DRS は使えない)", () => {
    const rc = newRaceControl();
    stepRaceControl(rc, track, cars(0), DT, { wet: 0 });
    expect(rc.ot).toBe(false);
    rc.t = 30;
    stepRaceControl(rc, track, cars(1), DT, { wet: 0.8 });
    expect(rc.ot).toBe(true);
    expect(rc.drs).toBe(false);
    expect(flagInfo(rc, cars(1)).ot).toBe(true);
  });
  it("旗が明けて 15 秒の間は使えない", () => {
    const rc = newRaceControl();
    rc.t = 100;
    rc.greenSince = 100;
    stepRaceControl(rc, track, cars(3), DT, { wet: 0 });
    expect(rc.ot).toBe(false);
    rc.t = 100 + OT_AFTER_GREEN + 0.1;
    stepRaceControl(rc, track, cars(3), DT, { wet: 0 });
    expect(rc.ot).toBe(true);
  });
});

/** 1 台を走らせて n 周 (コンピューター、ひとり) */
function soloLaps(trackId: string, design = SAMPLE_DESIGN, withOt = false) {
  const t0 = getTrack(trackId);
  const st0 = computeStats(design);
  const car = createCar(t0, st0, 0);
  car.started = true;
  let r = 5;
  const brain = makeBrain(() => ((r = (r * 16807) % 2147483647) / 2147483647), 1);
  const lap = newLapState();
  let t = 0;
  while (t < 400 && !lap.finished) {
    const inp = botInput(car, st0, t0, brain, t, [], 0);
    const prev = car.dist;
    const ev = stepCar(car, inp, st0, t0, DT, {});
    if (withOt) updateOvertake(car, t0, prev, [], true);
    t += DT;
    updateLaps(car, lap, ev, t, t0.length, 3, false);
  }
  return { best: lap.bestLap, fuel: car.fuel, x: car.x, used: car.ot?.armed ?? false };
}

describe("コンピューター", () => {
  it("前に誰もいなければ使わない: ひとりの周はオーバーテイクの計算を入れても同じ", () => {
    for (const def of TRACK_DEFS) {
      const a = soloLaps(def.id);
      const b = soloLaps(def.id, BOT_DESIGNS[0], true);
      const c = soloLaps(def.id, BOT_DESIGNS[0], false);
      expect(b).toEqual(c);
      expect(a.best).toBeGreaterThan(0);
    }
  });

  it("使える周で すぐ前に車がいて全開なら押す。前に誰もいなければ押さない", () => {
    const car = carAt(L + 300, 40);
    car.ot = { ...newOvertakeState(), armed: true, ok: true, energy: OT_ENERGY };
    const brain = makeBrain(() => 0.5, 1);
    const front = carAt(L + 325, 38);
    front.x = car.x + Math.cos(car.heading) * 25;
    front.y = car.y + Math.sin(car.heading) * 25;
    const ahead = bodyOf(front, stats);
    const a = botInput(car, stats, track, brain, 10, [ahead], 0);
    const b = botInput(car, stats, track, makeBrain(() => 0.5, 1), 10, [], 0);
    expect(a.throttle).toBe(1);
    expect(a.overtake).toBe(true);
    expect(b.overtake).toBeUndefined();
  });

  it("部屋のレースでコンピューターが使い (snap の印 256)、同じ入力なら同じ結果", () => {
    const race = () => {
      const sent: ServerMsg[] = [];
      let r = 11;
      const room = new RaceRoom({ send: () => {}, broadcast: (m) => sent.push(m) }, 4, () => ((r = (r * 16807) % 2147483647) / 2147483647));
      let now = 0;
      const a = room.join("k1", "A", SAMPLE_DESIGN, now) as { id: string };
      // つながったまま走らない人 (部屋を閉じないため)
      room.join("k2", "B", SAMPLE_DESIGN, now);
      now += LOBBY_MS + 10;
      room.tick(now);
      room.leave(a.id, now);
      let otSnaps = 0;
      for (let i = 0; i < 20 * 400 && room.phase === "race"; i++) {
        now += 50;
        room.tick(now);
      }
      for (const m of sent) if (m.t === "snap") for (const c of m.cars) if (c[5] & SNAP_OT) otSnaps++;
      const res = (sent.filter((m) => m.t === "phase").pop() as Extract<ServerMsg, { t: "phase" }>).info.results!;
      return { otSnaps, res: res.map((x) => [x.id, x.total.toFixed(3)]) };
    };
    const one = race();
    expect(one.otSnaps).toBeGreaterThan(5);
    expect(race()).toEqual(one);
  });
});

describe("無線", () => {
  const base: RadioSituation = {
    t: 120, started: true, lapsDone: 3, totalLaps: 10, lapsLeft: 7, lapLength: L, lapTime: 35, tire: "M", wear: 0.1, burst: false, tireLife: 20,
    fuel: 30, fuelCap: 40, fuelPerLap: 2, wet: 0, wetSoon: 0, forecast: [], flag: { mode: "green", drs: true }, pitBooked: false, inPit: false,
  };
  it("使える周に「オーバーテイクが使える」、前と 0.6 秒以内なら「仕掛けよう」", () => {
    const ready = radioCandidates({ ...base, ot: { armed: true, ok: true, energy: 1 } });
    expect(ready.some((c) => c.key === "ot_ready" && c.text === "オーバーテイクが使える")).toBe(true);
    const attack = radioCandidates({ ...base, ot: { armed: true, ok: true, energy: 0.8 }, ahead: { id: "x", gap: 0.55 } });
    expect(attack.find((c) => c.key === "ot_attack")?.text).toBe("前の車が 0.6 秒。オーバーテイクで仕掛けよう");
    expect(radioCandidates({ ...base, ot: { armed: true, ok: false, energy: 1 } }).some((c) => c.key.startsWith("ot_"))).toBe(false);
    expect(radioCandidates({ ...base, ot: null }).some((c) => c.key.startsWith("ot_"))).toBe(false);
  });
});
