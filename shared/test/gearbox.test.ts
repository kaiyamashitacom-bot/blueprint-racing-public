// 変速 (gearbox.ts) の試験: オートマは今のまま・マニュアルは上手に変えると manualSpeedBonus の分速い・回しすぎと段の高すぎは遅い・
// 1 周アタックの確かめはマニュアルの周を上がり分だけゆるめる・管理者の数・部屋の結果の AT / MT の印
import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS, DEFAULT_ADMIN_CONFIG, DEFAULT_MANUAL_BONUS, DT, GEAR_COUNT, LOBBY_MS, LUG_MIN, RaceRoom, SAMPLE_DESIGN, TRACK_DEFS, applyAdminPatch, checkTaLap, isRealCircuitId,
  botInput, computeStats, createCar, gearPowerFactor, gearTopSpeed, manualShiftBonus, getTrack, idealGear, makeBrain, newLapState, rpmFraction, stepCar, taLapFloor,
  taSpeedCeiling, updateLaps, validateAdminConfig, type CarDesign, type ServerMsg,
} from "../src/index.ts";

type Shift = "auto" | "ideal" | "late" | "lug";

/** 上手さ 1 のコンピューターの線と踏み方で 3 周。段は shift の決め方で (auto = オートマ) */
function run(trackId: string, design: CarDesign, shift: Shift, bonus = DEFAULT_MANUAL_BONUS) {
  const track = getTrack(trackId);
  const stats = computeStats(design);
  const car = createCar(track, stats, 0);
  car.started = true;
  let r = 3;
  const brain = makeBrain(() => ((r = (r * 16807) % 2147483647) / 2147483647), 1);
  const lap = newLapState();
  let t = 0;
  let gear = 1;
  let atLimit = 0;
  let walls = 0;
  while (t < 600 && !lap.finished) {
    const inp = botInput(car, stats, track, brain, t, [], 0);
    const v = Math.hypot(car.vx, car.vy);
    if (shift === "ideal") gear = idealGear(v, stats, bonus, 0.985);
    else if (shift === "late") {
      // 回しきってから 0.4 秒たって上げる
      atLimit = rpmFraction(v, gear, stats, bonus) >= 0.995 ? atLimit + DT : 0;
      if (atLimit > 0.4 && gear < GEAR_COUNT) (gear++, (atLimit = 0));
      while (gear > 1 && rpmFraction(v, gear, stats, bonus) < 0.45) gear--;
    } else if (shift === "lug") {
      // 早く上げすぎて回転が低いまま
      if (rpmFraction(v, gear, stats, bonus) > 0.7 && gear < GEAR_COUNT) gear++;
      while (gear > 1 && rpmFraction(v, gear, stats, bonus) < 0.3) gear--;
    }
    if (shift !== "auto") inp.gear = gear;
    const ev = stepCar(car, inp, stats, track, DT, { manualBonus: bonus });
    if (ev.wall > 3) walls++;
    t += DT;
    updateLaps(car, lap, ev, t, track.length, 3, false);
  }
  return { best: lap.bestLap ?? Infinity, walls, finished: lap.finished };
}

describe("段と回転", () => {
  it("回しきりで力が切れ、2 速から上で回転が低いと鈍い。1 速は低くても鈍くない", () => {
    expect(gearPowerFactor(1, 3)).toBe(0);
    expect(gearPowerFactor(1.2, 1)).toBe(0);
    expect(gearPowerFactor(0.8, 4)).toBe(1);
    expect(gearPowerFactor(0.1, 1)).toBe(1);
    expect(gearPowerFactor(0, 5)).toBeCloseTo(LUG_MIN);
    expect(gearPowerFactor(0.3, 5)).toBeLessThan(0.6);
  });
  it("段は 7 つ。上の段ほど速く回しきる。7 速はマニュアルの最高速より上まで回る", () => {
    const st = computeStats(SAMPLE_DESIGN);
    for (let g = 2; g <= GEAR_COUNT; g++) expect(gearTopSpeed(st, g)).toBeGreaterThan(gearTopSpeed(st, g - 1));
    expect(gearTopSpeed(st, 7, 0.03)).toBeGreaterThan(st.topSpeed * 1.03 * 1.1);
    expect(idealGear(1, st)).toBe(1);
    expect(idealGear(st.topSpeed, st)).toBe(GEAR_COUNT);
  });
});

describe("回転計とギア箱", () => {
  it("回転の上がり分はギア箱の部品の分も足す。1 速で回しきった速さで回転計がちょうど 1", () => {
    const stats = { ...computeStats(SAMPLE_DESIGN), shiftBonus: 0.022 };
    expect(manualShiftBonus(stats, 0.03)).toBeCloseTo(0.052, 9);
    expect(manualShiftBonus({}, undefined)).toBe(DEFAULT_MANUAL_BONUS);
    const track = getTrack(TRACK_DEFS[0].id);
    const car = createCar(track, stats, 0);
    car.started = true;
    let top = 0;
    for (let i = 0; i < 60 * 8; i++) {
      stepCar(car, { steer: 0, throttle: 1, brake: 0, gear: 1 }, stats, track, DT, { manualBonus: 0.03, damage: false });
      top = Math.max(top, Math.hypot(car.vx, car.vy));
    }
    // 力が切れる (頭打ち) 速さで、画面の回転は 1 (ギア箱の分を入れないと 2% ほど多く出ていた)
    const now = rpmFraction(top, 1, stats, manualShiftBonus(stats, 0.03));
    const old = rpmFraction(top, 1, stats, 0.03);
    expect(now).toBeGreaterThan(0.99);
    expect(old - now).toBeCloseTo((now * 0.022) / 1.03, 3);
    expect(Math.abs(now - 1)).toBeLessThan(Math.abs(old - 1));
  });
});

describe("オートマとマニュアルの速さ", () => {
  it("上がり分 0 で上手に変えると、オートマとちょうど同じ (オートマ = いつも一番よい段)", () => {
    for (const def of TRACK_DEFS) expect(run(def.id, SAMPLE_DESIGN, "ideal", 0).best).toBe(run(def.id, SAMPLE_DESIGN, "auto").best);
  });

  it("上がり分 3%: 上手に変えると速いが 1 周で 1.5% まで。回しすぎ・段が高すぎは上手な人より遅い", () => {
    // 青図・つづら坂だけ (重い。実在のサーキットの速いコース、たとえばジェッダでは 段が高すぎても遅くならない車がある)
    for (const def of TRACK_DEFS.filter((d) => !isRealCircuitId(d.id))) {
      for (const d of BOT_DESIGNS) {
        const auto = run(def.id, d, "auto");
        const ideal = run(def.id, d, "ideal");
        const late = run(def.id, d, "late");
        const lug = run(def.id, d, "lug");
        const label = `${def.id} ${d.name}`;
        expect(ideal.finished && ideal.walls === 0, label).toBe(true);
        expect(ideal.best, label).toBeLessThan(auto.best * 0.998);
        expect(ideal.best, label).toBeGreaterThan(auto.best * 0.985);
        expect(late.best, label).toBeGreaterThan(ideal.best);
        expect(lug.best, label).toBeGreaterThan(ideal.best);
      }
    }
  });

  it("まっすぐの最高速はマニュアルで ちょうど × (1 + 上がり分) 近く", () => {
    const track = getTrack("aozu");
    const st = computeStats(SAMPLE_DESIGN);
    const top = (manual: boolean) => {
      const car = createCar(track, st, 0);
      car.started = true;
      let v = 0;
      // 道に沿わず まっすぐ (壁の計算は気にしない: 速さだけ見る)
      for (let i = 0; i < 60 * 90; i++) {
        car.x = 0;
        car.y = 0;
        car.hint = 0;
        v = Math.hypot(car.vx, car.vy);
        stepCar(car, { steer: 0, throttle: 1, brake: 0, gear: manual ? idealGear(v, st, 0.03, 0.985) : undefined }, st, track, DT, { manualBonus: 0.03 });
        car.fuel = st.fuelCap;
      }
      return Math.hypot(car.vx, car.vy);
    };
    const a = top(false);
    const m = top(true);
    expect(m / a).toBeGreaterThan(1.02);
    expect(m / a).toBeLessThan(1.04);
  });
});

describe("1 周アタックの確かめ", () => {
  it("マニュアルの周は 速さの上限と 1 周の下限を上がり分だけゆるめる。オートマは今のまま", () => {
    const st = computeStats(SAMPLE_DESIGN);
    const track = getTrack("aozu");
    expect(taSpeedCeiling(st, 0.03) / taSpeedCeiling(st)).toBeCloseTo(1.03, 9);
    expect(taSpeedCeiling(st, 0)).toBe(taSpeedCeiling(st));
    expect(taLapFloor(st, track, 0.03)).toBeLessThan(taLapFloor(st, track));
    // オートマの下限とマニュアルの下限の間の周: オートマでは断り、マニュアルなら受ける
    const mid = (taLapFloor(st, track) + taLapFloor(st, track, 0.03)) / 2;
    expect(checkTaLap(mid, st, track)).not.toBeNull();
    expect(checkTaLap(mid, st, track, 0.03)).toBeNull();
    // 上手に変えたマニュアルの周は、マニュアルの下限より遅い
    expect(run("aozu", SAMPLE_DESIGN, "ideal").best).toBeGreaterThan(taLapFloor(st, track, 0.03));
  });
});

describe("管理者の数", () => {
  it("manualSpeedBonus: はじめ 0.03、0〜0.3 だけ受ける", () => {
    expect(DEFAULT_ADMIN_CONFIG.manualSpeedBonus).toBe(0.03);
    expect(validateAdminConfig(DEFAULT_ADMIN_CONFIG).ok).toBe(true);
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { manualSpeedBonus: 0.1 }).ok).toBe(true);
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { manualSpeedBonus: 0.5 }).ok).toBe(false);
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { manualSpeedBonus: -0.01 }).ok).toBe(false);
  });
});

describe("部屋の結果の印", () => {
  it("人が mt を送れば結果に AT / MT。コンピューターと送らない画面は なし", () => {
    const sent: ServerMsg[] = [];
    let r = 7;
    const room = new RaceRoom({ send: () => {}, broadcast: (m) => sent.push(m) }, 1, () => ((r = (r * 16807) % 2147483647) / 2147483647));
    let now = 0;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now) as { id: string };
    const b = room.join("kb", "B", SAMPLE_DESIGN, now) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    for (let i = 0; i < 20 * 200 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
      if (i === 300) {
        room.onMessage(a.id, { t: "finish", time: 40, lapsDone: 1, best: 40, penalty: 0, mt: true }, now);
        room.onMessage(b.id, { t: "finish", time: 41, lapsDone: 1, best: 41, penalty: 0, mt: false }, now);
      }
    }
    const res = (sent.filter((m) => m.t === "phase").pop() as Extract<ServerMsg, { t: "phase" }>).info.results!;
    expect(res.find((r) => r.id === a.id)?.mt).toBe(true);
    expect(res.find((r) => r.id === b.id)?.mt).toBe(false);
    expect(res.filter((r) => r.bot).every((r) => r.mt === undefined)).toBe(true);
  });
});
