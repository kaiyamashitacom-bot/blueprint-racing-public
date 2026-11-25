// 部品の強さの倍率 (AdminConfig.partStrength・partKindStrength) と 練習の賞金の確かめ (practiceprize.ts) の試験
import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS,
  BOT_SKILL_MAX,
  DEFAULT_ADMIN_CONFIG,
  DT,
  FUEL_KG,
  RaceRoom,
  SAMPLE_DESIGN,
  TRACK_DEFS,
  benchLap,
  botInput,
  checkPracticeLap,
  checkTaSubmission,
  cleanPartStrength,
  computeStats,
  createCar,
  getTrack,
  isNeutralStrength,
  makeBrain,
  newLapState,
  partStrengthOf,
  practiceLapPay,
  practicePrizeTrackOk,
  simulateRace,
  stepCar,
  taLapFloor,
  taSpeedCeiling,
  updateLaps,
  type CarDesign,
  type PartStrength,
  type TireCompound,
  type Track,
} from "@bpr/shared";

const S = (all: number, kinds: PartStrength["partKindStrength"] = {}): PartStrength => ({ partStrength: all, partKindStrength: kinds });

/** 一番上手いコンピューターの 2 周目を 0.1 秒の目盛りで幽霊に (timeattack.test.ts と同じやり方。タイヤ・燃料・濡れ具合を選べる) */
function botGhost(design: CarDesign, track: Track, o: { strength?: PartStrength | null; tire?: TireCompound; fuel?: number; wet?: number } = {}): { lap: number; pts: number[] } {
  const stats = computeStats(design, o.strength);
  const car = createCar(track, stats, 0, { tire: o.tire ?? "S", fuel: o.fuel ?? stats.fuelCap });
  car.started = true;
  const brain = makeBrain(() => 0.5, BOT_SKILL_MAX);
  const st = newLapState();
  let t = 0;
  let rec: number[] = [];
  let next = 0;
  let laps = 0;
  const fuel0 = car.fuel;
  while (t < 600) {
    const ev = stepCar(car, botInput(car, stats, track, brain, t, [], o.wet ?? 0), stats, track, DT, { damage: false, wetness: o.wet ?? 0 });
    t += DT;
    // 燃料の少ない周: 軽いまま (使った分を戻す。切れて止まらないように)
    if (o.fuel !== undefined) car.fuel = fuel0;
    const le = updateLaps(car, st, ev, t, track.length, 3, false);
    if (t >= next - 1e-9) {
      rec.push(Math.round(car.x * 10) / 10, Math.round(car.y * 10) / 10, Math.round(car.heading * 100) / 100);
      next += 0.1;
    }
    if (le.lap) {
      laps++;
      if (laps === 2) return { lap: le.lap.time, pts: rec };
      rec = [];
      next = st.lapStart;
    }
  }
  throw new Error("走り切れなかった");
}

describe("部品の強さの倍率", () => {
  it("はじめの値 (全部 1) では 今までと同じ性能 (なし・AdminConfig・全部 1 のどれでも)", () => {
    expect(isNeutralStrength(DEFAULT_ADMIN_CONFIG)).toBe(true);
    for (const d of [SAMPLE_DESIGN, ...BOT_DESIGNS]) {
      const base = computeStats(d);
      expect(computeStats(d, DEFAULT_ADMIN_CONFIG)).toEqual(base);
      expect(computeStats(d, S(1))).toEqual(base);
      expect(computeStats(d, null)).toEqual(base);
    }
  });

  it("種類ごとに主な強さだけが変わる (重さ・羽根の抵抗・燃費は変わらない)", () => {
    const base = computeStats(SAMPLE_DESIGN);
    const eng = computeStats(SAMPLE_DESIGN, S(1, { engine: 1.1 }));
    expect(eng.power).toBeCloseTo(base.power * 1.1, 6);
    expect(eng.topSpeed).toBeGreaterThan(base.topSpeed);
    expect(eng.mass).toBe(base.mass);
    expect(eng.fuelRate).toBe(base.fuelRate);
    expect(eng.gripAccel).toBe(base.gripAccel);

    const wing = computeStats(SAMPLE_DESIGN, S(1, { wing: 1.5 }));
    expect(wing.downK).toBeCloseTo(base.downK * 1.5, 6);
    expect(wing.dragK).toBe(base.dragK);

    const brake = computeStats(SAMPLE_DESIGN, S(1, { brake: 2 }));
    // 車そのものの 4 m/s² は変えず、部品の分だけ
    expect(brake.brake - 4).toBeCloseTo((base.brake - 4) * 2, 6);

    const tire = computeStats(SAMPLE_DESIGN, S(1, { tire: 1.2 }));
    expect(tire.gripAccel).toBeGreaterThan(base.gripAccel);
    // 傷み用の割合は 同じ種類が同じだけ強くなるので変わらない
    tire.layout!.forEach((slot, i) => expect(slot.share).toBeCloseTo(base.layout![i].share, 9));

    // タンク: 容量が増え、満タンの燃料の重さも一緒に増える (空の重さは同じ)
    const tank = computeStats(SAMPLE_DESIGN, S(1, { tank: 1.2 }));
    expect(tank.fuelCap).toBeCloseTo(base.fuelCap * 1.2, 6);
    expect(tank.dryMass).toBeCloseTo(base.dryMass, 6);
    expect(tank.mass - base.mass).toBeCloseTo(base.fuelCap * 0.2 * FUEL_KG, 6);

    // 運転席・骨組みは何も変わらない
    expect(computeStats(SAMPLE_DESIGN, S(1, { seat: 3, frame: 3 }))).toEqual(base);
    // 全部の倍率は種類ごとの倍率と掛ける
    expect(computeStats(SAMPLE_DESIGN, S(1.1, { engine: 2 })).power).toBeCloseTo(base.power * 2.2, 6);
  });

  it("エンジン 1.1 倍で 試走台の 1 周が速くなり、1 周アタックの下限もついてきて 本当に走った周は通る", () => {
    const track = getTrack(TRACK_DEFS[0].id);
    const strong = S(1, { engine: 1.1 });
    const base = computeStats(SAMPLE_DESIGN);
    const st = computeStats(SAMPLE_DESIGN, strong);
    const lap0 = benchLap(base, track).lap!;
    const lap1 = benchLap(st, track).lap!;
    expect(lap1).toBeLessThan(lap0);
    // 下限と速さの上限も強い車に合わせて動く
    expect(taLapFloor(st, track)).toBeLessThanOrEqual(taLapFloor(base, track));
    expect(taSpeedCeiling(st)).toBeGreaterThan(taSpeedCeiling(base));
    // 強い車で本当に走った周は、強い車の性能で確かめると通る
    const g = botGhost(SAMPLE_DESIGN, track, { strength: strong });
    expect(g.lap).toBeLessThan(botGhost(SAMPLE_DESIGN, track).lap);
    expect(checkTaSubmission({ lap: g.lap, pts: g.pts, design: SAMPLE_DESIGN }, st, track, null)).toBeNull();
    // 速すぎる周は (強くしても) 断る
    expect(checkTaSubmission({ lap: taLapFloor(st, track) * 0.9, pts: g.pts, design: SAMPLE_DESIGN }, st, track, null)).not.toBeNull();
  });

  it("部品をとても強くした車の周は、ふつうの性能で確かめると断られる (サーバーが倍率を使う意味)", () => {
    const track = getTrack(TRACK_DEFS[0].id);
    const g = botGhost(SAMPLE_DESIGN, track, { strength: S(5) });
    const scaled = computeStats(SAMPLE_DESIGN, S(5));
    expect(checkTaSubmission({ lap: g.lap, pts: g.pts, design: SAMPLE_DESIGN }, scaled, track, null)).toBeNull();
    expect(checkTaSubmission({ lap: g.lap, pts: g.pts, design: SAMPLE_DESIGN }, computeStats(SAMPLE_DESIGN), track, null)).not.toBeNull();
  });

  it("頭のないレース (リーグ戦・大会) にも効く: エンジンを強くすると同じ車が速く走り切る", () => {
    const cars = [{ id: "a", design: SAMPLE_DESIGN, brain: ({ rand }: { rand: () => number }) => makeBrain(rand, BOT_SKILL_MAX) }];
    const dry = { seed: 1, changes: [{ at: 0, sky: "sun" as const }], fakes: [], startWet: 0 };
    const o = { trackId: TRACK_DEFS[0].id, laps: 2, seed: 3, weather: dry };
    const a = simulateRace(cars, o).results[0];
    const b = simulateRace(cars, { ...o, strength: S(1, { engine: 1.3 }) }).results[0];
    expect(a.finished && b.finished).toBe(true);
    expect(b.total).toBeLessThan(a.total);
  });

  it("部屋: 倍率を入れると車の性能に効き、眠って戻しても残る", () => {
    const io = { send() {}, broadcast() {}, onResults() {} };
    const room = new RaceRoom(io as never, 2, () => 0.5);
    room.setPartStrength(S(1, { engine: 1.1 }));
    expect(room.statsOf(SAMPLE_DESIGN).power).toBeCloseTo(computeStats(SAMPLE_DESIGN).power * 1.1, 6);
    const back = RaceRoom.restore(io as never, JSON.parse(JSON.stringify(room.snapshot())), 0, () => 0.5);
    expect(back.statsOf(SAMPLE_DESIGN).power).toBeCloseTo(computeStats(SAMPLE_DESIGN).power * 1.1, 6);
    // 全部 1 に戻すと snapshot にも残さない
    room.setPartStrength(partStrengthOf(DEFAULT_ADMIN_CONFIG));
    expect(room.snapshot().strength).toBeUndefined();
  });

  it("画面が読む数の確かめ: 幅の外・読めない数は 1", () => {
    expect(cleanPartStrength({ partStrength: 1.2, partKindStrength: { engine: 1.1, tire: 99, wing: "x" } })).toEqual({
      partStrength: 1.2,
      partKindStrength: { seat: 1, engine: 1.1, tire: 1, tank: 1, wing: 1, brake: 1, frame: 1 },
    });
    expect(cleanPartStrength(null)).toEqual(partStrengthOf(DEFAULT_ADMIN_CONFIG));
    expect(cleanPartStrength({ partStrength: 0 }).partStrength).toBe(1);
  });
});

describe("練習の賞金", () => {
  it("1 周ごとに払い、1 日の上限を超えたら 0", () => {
    const cfg = { practicePrizePerLap: 5, practicePrizeDailyLaps: 20 };
    expect(practiceLapPay(cfg, 0)).toEqual({ amount: 5, left: 19 });
    expect(practiceLapPay(cfg, 19)).toEqual({ amount: 5, left: 0 });
    expect(practiceLapPay(cfg, 20)).toEqual({ amount: 0, left: 0 });
    expect(practiceLapPay({ practicePrizePerLap: 0, practicePrizeDailyLaps: 20 }, 0).amount).toBe(0);
    expect(practiceLapPay({ practicePrizePerLap: 5, practicePrizeDailyLaps: 0 }, 0).amount).toBe(0);
  });

  it("賞金の出るコース: 公式とみんなのコースだけ (この機械で作っただけのコースは出ない)", () => {
    expect(practicePrizeTrackOk(TRACK_DEFS[0].id)).toBe(true);
    expect(practicePrizeTrackOk("pub:12")).toBe(true);
    expect(practicePrizeTrackOk("user:abc")).toBe(false);
    expect(practicePrizeTrackOk(42)).toBe(false);
  });

  it("練習の条件 (燃料が少ない・硬いタイヤ・雨で雨用タイヤ) で本当に走った周も、1 周アタックと同じ確かめで通る", () => {
    for (const def of TRACK_DEFS.slice(0, 3)) {
      const track = getTrack(def.id);
      for (const design of [SAMPLE_DESIGN, BOT_DESIGNS[0]]) {
        const st = computeStats(design);
        const runs = [
          botGhost(design, track, { tire: "S", fuel: Math.max(2, st.fuelCap * 0.15) }),
          botGhost(design, track, { tire: "H" }),
          botGhost(design, track, { tire: "I", wet: 0.5 }),
          botGhost(design, track, { tire: "W", wet: 0.9 }),
        ];
        for (const g of runs) {
          expect(checkPracticeLap({ lap: g.lap, pts: g.pts, design }, st, track, null)).toBeNull();
          // 下限からはまだ余裕がある (下限 ÷ 周 が 0.8 より下)
          expect(taLapFloor(st, track) / g.lap).toBeLessThan(0.8);
        }
      }
    }
  });
});
