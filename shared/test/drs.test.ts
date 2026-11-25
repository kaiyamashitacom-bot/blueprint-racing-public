import { describe, expect, it } from "vitest";
import {
  DRS_FUEL, DRS_GAP, DRS_WEAR, DT, SAMPLE_DESIGN, TRACK_DEFS, bodyOf, buildTrack, closeDrs, computeStats, createCar, drsAvailable, drsZones,
  getTrack, inDrsZone, isRealCircuitId, openDrs, pointAt, queryTrack, stepCar, towFactor, updateDrs, type CarState, type Track,
} from "../src/index.ts";

const stats = computeStats(SAMPLE_DESIGN);

/** 道の上の位置 s に、道の向きで速さ v の車を置く */
function carAt(track: Track, s: number, v: number, d = 0): CarState {
  const car = createCar(track, stats, 0);
  const p = pointAt(track, s, d);
  const q = queryTrack(track, p.x, p.y);
  car.x = p.x;
  car.y = p.y;
  car.heading = p.heading;
  car.vx = Math.cos(p.heading) * v;
  car.vy = Math.sin(p.heading) * v;
  car.hint = q.index;
  car.lastS = q.s;
  car.dist = s;
  car.started = true;
  return car;
}

describe("DRS の区間", () => {
  it("公式コースは書いた区間を使う。区間は直線の上", () => {
    for (const def of TRACK_DEFS) {
      const t = getTrack(def.id);
      const zones = drsZones(t);
      expect(zones.length, def.id).toBe(def.drs!.length);
      for (const z of zones) {
        expect(z.detect).toBeLessThan(z.start);
        expect(z.end - z.start).toBeGreaterThan(150);
        for (let s = z.start; s <= z.end; s += 5) {
          const i = Math.floor((((s % t.length) + t.length) % t.length) / t.step) % t.n;
          expect(Math.abs(t.curv[i]), `${def.id} s=${s}`).toBeLessThan(1 / 120);
        }
      }
    }
  });
  it("区間を書いていないコースは 長い直線から決める", () => {
    for (const def of TRACK_DEFS) {
      const { drs: _drs, ...rest } = def;
      void _drs;
      const t = buildTrack({ ...rest, id: `${def.id}-nodrs` });
      const zones = drsZones(t);
      expect(zones.length, def.id).toBeGreaterThanOrEqual(1);
      expect(zones.length).toBeLessThanOrEqual(2);
      // スタートの直線 (0 m の少し先) は区間に入る (実在のサーキットは長い直線がほかにあり、選ばれないことがある)
      if (!isRealCircuitId(def.id)) expect(zones.some((z) => inDrsZone(t, z, 100))).toBe(true);
    }
  });
});

describe("DRS の使い方", () => {
  const track = getTrack("aozu");
  const z = drsZones(track)[0];

  function crossDetect(gapM: number, enabled = true) {
    const car = carAt(track, z.detect - 1, 30);
    const prev = car.dist;
    car.dist = z.detect + 1;
    updateDrs(car, track, prev, [car.dist + gapM], enabled);
    return car;
  }

  it("検知の線で 1 秒以内なら、区間に入ると使える。離れていたり、レースが許さなければ使えない", () => {
    const near = crossDetect(30 * DRS_GAP * 0.8);
    expect(near.drs!.armed).toBe(0);
    expect(drsAvailable(near, track)).toBe(false); // まだ区間の手前
    near.dist = z.start + 5;
    expect(drsAvailable(near, track)).toBe(true);
    expect(crossDetect(30 * DRS_GAP * 1.3).drs!.armed).toBe(-1);
    expect(crossDetect(30 * DRS_GAP * 0.5, false).drs!.armed).toBe(-1);
    // 前に誰もいない
    const alone = carAt(track, z.detect - 1, 30);
    updateDrs(alone, track, alone.dist, [], true);
    alone.dist = z.detect + 1;
    updateDrs(alone, track, z.detect - 1, [], true);
    expect(alone.drs!.armed).toBe(-1);
  });

  it("開くと燃料とタイヤが少し減り、直線で速くなる。ブレーキで閉じ、その区間ではもう開けない", () => {
    const run = (drs: boolean) => {
      const car = carAt(track, z.start + 2, 30);
      car.drs = { armed: drs ? 0 : -1, open: false, gap: 0.5 };
      const fuel0 = car.fuel;
      const wear0 = car.wear;
      if (drs) {
        expect(openDrs(car, track)).toBe(true);
        expect(car.fuel).toBeCloseTo(fuel0 - DRS_FUEL, 6);
        expect(car.wear).toBeCloseTo(wear0 + DRS_WEAR, 6);
        expect(openDrs(car, track)).toBe(false); // もう開いている
      }
      for (let i = 0; i < 60 * 4; i++) {
        const prev = car.dist;
        stepCar(car, { steer: 0, throttle: 1, brake: 0 }, stats, track, DT);
        updateDrs(car, track, prev, [], true);
      }
      return car;
    };
    const plain = run(false);
    const open = run(true);
    expect(open.dist).toBeGreaterThan(plain.dist + 2);
    expect(open.drs!.open).toBe(true);
    // ブレーキで閉じる
    stepCar(open, { steer: 0, throttle: 0, brake: 1 }, stats, track, DT);
    expect(open.drs!.open).toBe(false);
    expect(drsAvailable(open, track)).toBe(false);
  });

  it("区間が終わると閉じる。自分で閉じたら開けない", () => {
    const car = carAt(track, z.end - 3, 40);
    car.drs = { armed: 0, open: false, gap: 0.5 };
    expect(openDrs(car, track)).toBe(true);
    for (let i = 0; i < 30; i++) {
      const prev = car.dist;
      stepCar(car, { steer: 0, throttle: 1, brake: 0 }, stats, track, DT);
      updateDrs(car, track, prev, [], true);
    }
    expect(car.drs!.open).toBe(false);
    expect(car.drs!.armed).toBe(-1);

    const c2 = carAt(track, z.start + 10, 30);
    c2.drs = { armed: 0, open: false, gap: 0.5 };
    openDrs(c2, track);
    closeDrs(c2);
    expect(drsAvailable(c2, track)).toBe(false);
  });
});

describe("風よけ", () => {
  const track = getTrack("aozu");
  it("すぐ後ろほど強く、横や前の車・遅いときは効かない", () => {
    const lead = carAt(track, 100, 35);
    const behind = (gap: number, d = 0, v = 35) => towFactor(carAt(track, 100 - gap, v, d), [bodyOf(lead, stats)]);
    expect(behind(6)).toBeGreaterThan(0.5);
    expect(behind(6)).toBeGreaterThan(behind(18));
    expect(behind(40)).toBe(0);
    expect(behind(6, 4)).toBe(0);
    expect(behind(-10)).toBe(0);
    expect(behind(6, 0, 8)).toBe(0);
  });
  it("風よけがあると直線で速い (env.tow)", () => {
    const run = (tow: number) => {
      const car = carAt(track, 10, 30);
      for (let i = 0; i < 60 * 5; i++) stepCar(car, { steer: 0, throttle: 1, brake: 0 }, stats, track, DT, { tow });
      return car.dist;
    };
    expect(run(1)).toBeGreaterThan(run(0) + 2);
  });
});
