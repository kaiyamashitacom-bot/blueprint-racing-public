// 雇った運転手の特徴 (タイヤ・燃料の扱い、ミスの多さ) が車と頭に効く。チャンピオンのごほうび (伸びしろ +5)。大会のあとのチームの結果
import { describe, expect, it } from "vitest";
import {
  DRIVERS,
  LOBBY_MS,
  RaceRoom,
  SAMPLE_DESIGN,
  TRACK_DEFS,
  awardChampionBonus,
  botInput,
  championBoost,
  computeStats,
  createCar,
  createDriverPool,
  driverBrain,
  driverCarScales,
  driverTraits,
  getTrack,
  makeBrain,
  stepCar,
  type CarState,
  type FixedField,
  type JoinTeam,
  type TeamRaceReport,
} from "../src/index.ts";

const track = getTrack(TRACK_DEFS[0].id);
const stats = computeStats(SAMPLE_DESIGN);
const LO = { speed: 20, stability: 15, tyreFuel: 10, pitSense: 20 };
const HI = { speed: 80, stability: 90, tyreFuel: 95, pitSense: 80 };

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** 同じ入力で 20 秒走らせる */
function drive(car: CarState) {
  const brain = makeBrain(seeded(3), 1);
  car.started = true;
  for (let i = 0; i < 60 * 20; i++) {
    const inp = botInput(car, stats, track, brain, i / 60);
    stepCar(car, inp, stats, track);
  }
  return car;
}

describe("タイヤと燃料の扱い (wearScale・fuelScale)", () => {
  it("倍率がそのまま減りと燃料に掛かる。なしなら今までと同じ", () => {
    const plain = drive(createCar(track, stats, 0, { tire: "M" }));
    const one = drive(createCar(track, stats, 0, { tire: "M", wearScale: 1, fuelScale: 1 }));
    expect(one.wear).toBe(plain.wear);
    expect(one.fuel).toBe(plain.fuel);
    const worse = drive(createCar(track, stats, 0, { tire: "M", wearScale: 1.2, fuelScale: 1.1 }));
    // 重さ (燃料) と握り (減り) が少し変わるので走りもほんの少し変わる。減りと燃料はほぼ倍率どおり
    expect(Math.abs(worse.dist - plain.dist)).toBeLessThan(2);
    expect(worse.wear / plain.wear).toBeGreaterThan(1.15);
    expect(worse.wear / plain.wear).toBeLessThan(1.25);
    const used = (c: CarState) => stats.fuelCap - c.fuel;
    expect(used(worse) / used(plain)).toBeCloseTo(1.1, 1);
    // 人の車 (倍率なし) にはキーも付かない
    expect("wearScale" in createCar(track, stats, 0)).toBe(false);
  });

  it("扱いの上手い運転手ほど倍率が小さい", () => {
    const lo = driverCarScales(LO);
    const hi = driverCarScales(HI);
    expect(hi.wearScale).toBeLessThan(lo.wearScale);
    expect(hi.fuelScale).toBeLessThan(lo.fuelScale);
    expect(lo).toEqual({ wearScale: driverTraits(LO).wearScale, fuelScale: driverTraits(LO).fuelScale });
  });
});

describe("ミスの多さ (mistakeScale)", () => {
  it("driverBrain に入り、安定の高い運転手ほどミスが少ない。ふつうのコンピューターは 1 のまま", () => {
    expect(makeBrain(seeded(1)).mistakeScale).toBe(1);
    expect(driverBrain(LO, seeded(1)).mistakeScale).toBe(driverTraits(LO).mistakeScale);
    const count = (scale: number) => {
      let n = 0;
      for (let k = 1; k <= 60; k++) {
        const b = { ...makeBrain(seeded(k), 0.75), mistakeScale: scale };
        const car = createCar(track, stats, 0);
        for (let t = 0; t < 120; t += 0.25) {
          const before = b.slipUntil;
          botInput(car, stats, track, b, t);
          if (b.slipUntil !== before) n++;
        }
      }
      return n;
    };
    expect(count(0.6)).toBeLessThan(count(1.4));
    expect(count(0)).toBe(0);
  });
});

describe("部屋の 2 台目と大会の雇った運転手に倍率が付く (人の車には付かない)", () => {
  it("すぐ走るの 2 台目", () => {
    const team: JoinTeam = { second: { driverId: "d1", name: "雇い", design: SAMPLE_DESIGN, driver: LO } };
    const room = new RaceRoom({ send: () => {}, broadcast: () => {} }, 2, seeded(9));
    const a = room.join("k1", "A", SAMPLE_DESIGN, 0, () => {}, team) as { id: string };
    room.tick(LOBBY_MS + 10);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ents = [...((room as any).entrants as Map<string, { id: string; ownerId?: string; car: CarState }>).values()];
    const second = ents.find((e) => e.ownerId === a.id)!;
    const me = ents.find((e) => e.id === a.id)!;
    expect(second.car.wearScale).toBeCloseTo(driverTraits(LO).wearScale, 9);
    expect(second.car.fuelScale).toBeCloseTo(driverTraits(LO).fuelScale, 9);
    expect(me.car.wearScale).toBeUndefined();
  });
});

describe("大会のあと: チームごとの 2 台の結果 (運転手の育ち・慣れ)", () => {
  it("来なかった人の車は代走、雇った運転手は 2 台目として onTeamResults に出る", () => {
    const teams: TeamRaceReport[] = [];
    const room = new RaceRoom({ send: () => {}, broadcast: () => {}, onFixedResults: () => {}, onTeamResults: (r) => teams.push(r) }, 2, seeded(11));
    const field: FixedField = {
      tag: "tz:0",
      trackId: TRACK_DEFS[0].id,
      laps: 2,
      tireKind: "tournament",
      startAt: 1000,
      weather: { seed: 1, changes: [{ at: 0, sky: "sun" }], fakes: [], startWet: 0 },
      cars: [
        { key: "acc:5", name: "人", design: SAMPLE_DESIGN, slot: 0, kind: "human", teamId: "5", driverId: "h5" },
        { key: "hire:d2", name: "雇い", design: SAMPLE_DESIGN, slot: 1, kind: "hired", teamId: "5", driverId: "d2", driver: HI },
        { key: "acc:6", name: "人2", design: SAMPLE_DESIGN, slot: 2, kind: "human", teamId: "6", driverId: "h6" },
      ],
    };
    let now = 0;
    room.setFixed(field, now);
    now = 1000;
    room.tick(now);
    expect(room.phase).toBe("race");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hired = [...((room as any).entrants as Map<string, { key: string; car: CarState }>).values()].find((e) => e.key === "hire:d2")!;
    expect(hired.car.wearScale).toBeCloseTo(driverTraits(HI).wearScale, 9);
    for (let i = 0; i < 20 * 600 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    expect(teams.length).toBe(1);
    const t = teams[0];
    expect(t.trackId).toBe(TRACK_DEFS[0].id);
    expect(t.humans).toBe(0);
    const five = t.teams.find((x) => x.key === "acc:5")!;
    expect(five.car1.standIn).toBe(true);
    expect(five.car2?.driverId).toBe("d2");
    expect(five.car2?.distM).toBeGreaterThan(0);
    const six = t.teams.find((x) => x.key === "acc:6")!;
    expect(six.car2).toBeNull();
  });
});

describe("チャンピオンのごほうび (伸びしろ +5)", () => {
  it("伸びしろだけ上がり (100 まで)、今の能力は変わらない。同じ人は 1 回", () => {
    const pool = createDriverPool(123, 5);
    const d = pool.drivers[0];
    const up = championBoost(d);
    expect(DRIVERS.championBonus).toBe(5);
    expect(up.potential.speed).toBe(Math.min(100, d.potential.speed + 5));
    expect(up.stats).toEqual(d.stats);
    const capped = championBoost({ ...d, potential: { speed: 98, stability: 100, tyreFuel: 50, pitSense: 0 } });
    expect(capped.potential).toEqual({ speed: 100, stability: 100, tyreFuel: 55, pitSense: 5 });
    const next = awardChampionBonus(pool, [d.id, d.id, "nobody"]);
    expect(next.drivers[0].potential.speed).toBe(up.potential.speed);
    expect(next.drivers[1]).toEqual(pool.drivers[1]);
  });
});
