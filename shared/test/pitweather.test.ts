import { describe, expect, it } from "vitest";
import {
  BURST_MAX_SPEED, DT, LOBBY_MS, PIT_SPEED, RaceRoom, SAMPLE_DESIGN, TRACK_DEFS, botInput, botStartSetup, cancelPit, compoundGrip, computeStats,
  createCar, forecastAt, getTrack, makeBrain, makeWeatherPlan, newLapState, pitLanePath, puddleEffect, puddlesOf, queryTrack, requestPit,
  serviceTime, stepCar, updateBotPit, updateLaps, wallDistance, wetWearFactor, wetnessAt,
  type CarSetup, type PitOrder, type ServerMsg, type TireCompound, type WeatherPlan,
} from "../src/index.ts";

const DRY: WeatherPlan = { seed: 1, changes: [{ at: 0, sky: "sun" }], fakes: [], startWet: 0 };

interface DriveOpts {
  laps: number;
  setup?: CarSetup;
  plan?: WeatherPlan;
  /** コンピューターに ピットを決めさせる */
  botPit?: boolean;
  /** この周を走り終えたら 1 回だけピットを予約 */
  pitAfterLap?: number;
  pitOrder?: PitOrder;
  maxT?: number;
}

function drive(o: DriveOpts) {
  const track = getTrack("aozu");
  const stats = computeStats(SAMPLE_DESIGN);
  const plan = o.plan ?? DRY;
  const car = createCar(track, stats, 0, o.setup);
  car.started = true;
  let r = 5;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const brain = makeBrain(rand, 0.9);
  const st = newLapState();
  let t = 0;
  let pits = 0;
  let pitTime = 0;
  let wasPit = false;
  let requested = false;
  let maxJump = 0;
  let fuelInPit = 0;
  let burstLap = -1;
  let everBurst = false;
  while (t < (o.maxT ?? 1500) && !st.finished && !st.retired) {
    const wet = wetnessAt(plan, t);
    if (o.botPit) updateBotPit(car, stats, track, brain, { totalLaps: o.laps, wetNow: wet, wetSoon: wetnessAt(plan, t + 40) });
    if (o.pitAfterLap !== undefined && !requested && st.lapsDone >= o.pitAfterLap) {
      requestPit(car, o.pitOrder ?? { tire: "S" });
      requested = true;
    }
    const before = car.dist;
    const fuelBefore = car.fuel;
    const ev = stepCar(car, botInput(car, stats, track, brain, t, [], wet), stats, track, DT, { wetness: wet });
    t += DT;
    maxJump = Math.max(maxJump, Math.abs(car.dist - before));
    if (car.pit) pitTime += DT;
    if (car.pit && wasPit) fuelInPit += fuelBefore - car.fuel;
    if (car.pit && !wasPit) pits++;
    wasPit = !!car.pit;
    if (car.burst && burstLap < 0) burstLap = car.dist / track.length;
    everBurst ||= car.burst;
    updateLaps(car, st, ev, t, track.length, o.laps, false);
  }
  return { car, st, t, pits, pitTime, maxJump, fuelInPit, burstLap, everBurst, stats, track };
}

describe("タイヤ", () => {
  it("柔らかい → 普通 → 硬い の順に長もちし、普通は 4〜6 周で破裂する", () => {
    const laps: Record<string, number> = {};
    for (const tire of ["S", "M", "H"] as TireCompound[]) {
      const d = drive({ laps: 12, setup: { tire }, maxT: 420 });
      laps[tire] = d.burstLap;
      expect(d.burstLap, tire).toBeGreaterThan(0);
    }
    expect(laps.S).toBeLessThan(laps.M);
    expect(laps.M).toBeLessThan(laps.H);
    expect(laps.S).toBeGreaterThan(2.3);
    expect(laps.M).toBeGreaterThan(4);
    expect(laps.M).toBeLessThan(6);
    expect(laps.H).toBeGreaterThan(6);
  });

  it("破裂したら ゆっくりしか走れないが、止まらない", () => {
    const d = drive({ laps: 6, setup: { tire: "S" }, maxT: 260 });
    expect(d.car.burst).toBe(true);
    expect(Math.hypot(d.car.vx, d.car.vy)).toBeLessThan(BURST_MAX_SPEED + 1);
    const after = drive({ laps: 6, setup: { tire: "S" }, maxT: 280 });
    expect(after.car.dist).toBeGreaterThan(d.car.dist + 100);
  });

  it("濡れた路面では溝のないタイヤが滑り、雨用は乾いた路面ですぐ減る", () => {
    expect(compoundGrip("W", 0.9)).toBeGreaterThan(compoundGrip("S", 0.9) * 1.6);
    expect(compoundGrip("S", 0)).toBeGreaterThan(compoundGrip("I", 0));
    expect(compoundGrip("I", 0.5)).toBeGreaterThan(compoundGrip("M", 0.5));
    expect(wetWearFactor("W", 0)).toBeGreaterThan(3);
    expect(wetWearFactor("I", 0)).toBeGreaterThan(2);
    const wetSlick = drive({ laps: 1, setup: { tire: "M" }, plan: { ...DRY, changes: [{ at: 0, sky: "heavy" }], startWet: 0.95 } });
    const wetW = drive({ laps: 1, setup: { tire: "W" }, plan: { ...DRY, changes: [{ at: 0, sky: "heavy" }], startWet: 0.95 } });
    expect(wetW.st.finished && wetSlick.st.finished).toBe(true);
    expect(wetSlick.st.finishTime).toBeGreaterThan(wetW.st.finishTime + 8);
  });

  it("積む燃料とタイヤを選べる (なければ満タン + 普通)", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const def = createCar(track, stats, 0);
    expect(def.fuel).toBe(stats.fuelCap);
    expect(def.tire).toBe("M");
    const light = createCar(track, stats, 0, { fuel: 10, tire: "S" });
    expect(light.fuel).toBe(10);
    expect(light.tire).toBe("S");
    expect(createCar(track, stats, 0, { fuel: 999 }).fuel).toBe(stats.fuelCap);
  });
});

describe("天気", () => {
  const plan: WeatherPlan = { seed: 9, changes: [{ at: 0, sky: "sun" }, { at: 60, sky: "heavy" }, { at: 200, sky: "sun" }], fakes: [], startWet: 0 };

  it("濡れ具合は少しずつ上がり、やんでもしばらく濡れたまま", () => {
    expect(wetnessAt(plan, 30)).toBe(0);
    expect(wetnessAt(plan, 63)).toBeLessThan(0.15);
    expect(wetnessAt(plan, 110)).toBeGreaterThan(0.85);
    expect(wetnessAt(plan, 215)).toBeGreaterThan(0.8);
    expect(wetnessAt(plan, 260)).toBeGreaterThan(0.4);
    expect(wetnessAt(plan, 400)).toBe(0);
    let prev = 0;
    for (let t = 0; t < 420; t += 0.5) {
      const w = wetnessAt(plan, t);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      expect(Math.abs(w - prev)).toBeLessThan(0.02);
      prev = w;
    }
  });

  it("同じ種なら同じ予定 (画面とサーバーで同じ)", () => {
    for (let seed = 1; seed < 30; seed++) {
      const a = makeWeatherPlan(seed * 7919, 600);
      const b = makeWeatherPlan(seed * 7919, 600);
      expect(a).toEqual(b);
      expect(wetnessAt(a, 333.3)).toBe(wetnessAt(b, 333.3));
      expect(forecastAt(a, 50)).toEqual(forecastAt(b, 50));
    }
  });

  it("晴れのレースも雨のレースもある", () => {
    let dry = 0;
    let wet = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const p = makeWeatherPlan(seed * 104729, 300);
      if (p.changes.every((c) => c.at > 300 || c.sky === "sun")) dry++;
      else wet++;
    }
    expect(dry).toBeGreaterThan(10);
    expect(wet).toBeGreaterThan(10);
  });

  it("予報: 「約 N 分後 小雨 60%」の形で、近づくと出る。来ない雨の予報は直前に消える", () => {
    let shown = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const p: WeatherPlan = { ...plan, seed, fakes: [{ at: 150, sky: "light" }] };
      const f = forecastAt(p, 0);
      const real = f.find((x) => x.sky === "heavy");
      if (real) {
        shown++;
        expect(real.text).toMatch(/^(約 \d+ 分後|まもなく) 大雨 \d+%$/);
        expect(Math.abs(real.inSec - 60)).toBeLessThan(30);
      }
      expect(forecastAt(p, 100).some((x) => x.sky === "light")).toBe(true);
      expect(forecastAt(p, 130).some((x) => x.sky === "light")).toBe(false);
      // 30 秒前には必ず出る
      expect(forecastAt(p, 40).some((x) => x.sky === "heavy")).toBe(true);
    }
    expect(shown).toBeGreaterThan(12);
  });

  it("水たまりは道の上の決まった場所にあり、大雨のときだけ効く", () => {
    for (const def of TRACK_DEFS) {
      const track = getTrack(def.id);
      const ps = puddlesOf(track);
      expect(ps.length).toBeGreaterThanOrEqual(3);
      expect(puddlesOf(track)).toBe(ps);
      for (const p of ps) {
        expect(Math.abs(p.d)).toBeLessThan(def.halfWidth);
        const q = { index: Math.floor(p.s / track.step) % track.n, s: p.s, d: p.d };
        expect(puddleEffect(track, q, 0.3, "M").grip).toBe(1);
        expect(puddleEffect(track, q, 0.95, "M").grip).toBeLessThan(0.7);
        expect(puddleEffect(track, q, 0.95, "W").grip).toBeGreaterThan(puddleEffect(track, q, 0.95, "M").grip);
      }
    }
  });
});

describe("ピット", () => {
  for (const def of TRACK_DEFS) {
    it(`${def.name}: ピットの道は壁の内側 (芝・砂利の中) にある`, () => {
      const track = getTrack(def.id);
      const half = computeStats(SAMPLE_DESIGN).width / 2;
      for (const d0 of [-def.halfWidth, 0, def.halfWidth]) {
        for (const p of pitLanePath(track, 2, d0)) {
          const q = queryTrack(track, p.x, p.y);
          expect(Math.abs(q.d) + half).toBeLessThan(wallDistance(track, q.index));
        }
      }
      // 止まる場所は道の外
      expect(Math.abs(track.pit.laneD)).toBeGreaterThan(def.halfWidth + half);
    });
  }

  it("作業の時間: タイヤ・燃料・修理のうち一番長いもの", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const car = createCar(track, stats, 0, { fuel: 10 });
    expect(stats.tireCount).toBe(4);
    const tireOnly = serviceTime(car, stats, { tire: "S" });
    expect(tireOnly).toBeGreaterThan(2);
    expect(tireOnly).toBeLessThan(6);
    const fuelOnly = serviceTime(car, stats, { fuelTo: 40 });
    expect(fuelOnly).toBeGreaterThan(tireOnly);
    expect(serviceTime(car, stats, { tire: "S", fuelTo: 40 })).toBe(fuelOnly);
    expect(serviceTime(car, stats, { tire: "S", fuelTo: 11 })).toBe(tireOnly);
  });

  it("予約すると次の入り口で入り、止まって替えて、コースに戻って周を数え続ける", () => {
    const base = drive({ laps: 3 });
    const pit = drive({ laps: 3, pitAfterLap: 1, pitOrder: { tire: "S" } });
    expect(base.st.finished).toBe(true);
    expect(pit.st.finished).toBe(true);
    expect(pit.pits).toBe(1);
    expect(pit.car.tire).toBe("S");
    expect(pit.car.pit).toBeNull();
    expect(pit.car.pitOrder).toBeNull();
    expect(pit.st.lapsDone).toBe(3);
    // 道のりは飛ばない (近道にならない)
    expect(pit.maxJump).toBeLessThan(2);
    expect(pit.st.penalty).toBe(0);
    // ピットの道の長さ (約 210 m) を制限速度で走る分 + 作業 (約 4 秒)
    const lane = pit.track.pit.exit - pit.track.pit.entry;
    expect(pit.pitTime).toBeGreaterThan(lane / PIT_SPEED);
    expect(pit.pitTime).toBeLessThan(lane / PIT_SPEED + 8);
    const loss = pit.st.finishTime - base.st.finishTime;
    expect(loss).toBeGreaterThan(6);
    expect(loss).toBeLessThan(20);
    // ピットの道では燃料が減らない
    expect(pit.fuelInPit).toBe(0);
  });

  it("入り口の線までは取り消せ、越えたら取り消せない。止まっている間は内容を変えられる", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const car = createCar(track, stats, 0, { fuel: 10 });
    car.started = true;
    let r = 5;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const brain = makeBrain(rand, 0.9);
    requestPit(car, { tire: "H" });
    expect(cancelPit(car)).toBe(true);
    expect(car.pitOrder).toBeNull();
    requestPit(car, { tire: "H" });
    let t = 0;
    let boxT = 0;
    let changed = false;
    while (t < 200 && (car.pitOrder || car.pit)) {
      stepCar(car, botInput(car, stats, track, brain, t), stats, track, DT);
      t += DT;
      if (car.pit) expect(cancelPit(car)).toBe(false);
      if (car.pit?.phase === "box") {
        boxT += DT;
        if (!changed && boxT > 1) {
          // 空を見て選び直す + 燃料も入れる
          requestPit(car, { tire: "W", fuelTo: 40 });
          changed = true;
        }
      }
    }
    expect(changed).toBe(true);
    expect(car.tire).toBe("W");
    expect(car.fuel).toBeCloseTo(40, 3);
    expect(boxT).toBeGreaterThan(serviceTime({ ...car, fuel: 10 }, stats, { tire: "W", fuelTo: 40 }) - 0.05);
  });
});

describe("コンピューターのピット", () => {
  it("柔らかいタイヤで 10 周: 1 回以上ピットに入り、破裂せずに走り切る", () => {
    const d = drive({ laps: 10, setup: { tire: "S" }, botPit: true });
    expect(d.st.finished).toBe(true);
    expect(d.pits).toBeGreaterThanOrEqual(1);
    expect(d.everBurst).toBe(false);
  });

  it("雨が降ってきたら雨用のタイヤに替え、乾いたら戻す", () => {
    const plan: WeatherPlan = { seed: 3, changes: [{ at: 0, sky: "sun" }, { at: 80, sky: "heavy" }, { at: 250, sky: "sun" }], fakes: [], startWet: 0 };
    const d = drive({ laps: 10, setup: { tire: "H" }, botPit: true, plan });
    expect(d.st.finished).toBe(true);
    expect(d.pits).toBeGreaterThanOrEqual(2);
    expect(["S", "M", "H"]).toContain(d.car.tire);
  });

  it("走る前: 雨なら雨用、晴れなら長さに合うタイヤ。燃料はゴールまで + 少し", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    expect(botStartSetup(stats, track, 10, 0.95).tire).toBe("W");
    expect(botStartSetup(stats, track, 10, 0.4).tire).toBe("I");
    expect(botStartSetup(stats, track, 2, 0).tire).toBe("S");
    const s = botStartSetup(stats, track, 5, 0);
    expect(s.fuel!).toBeLessThan(stats.fuelCap);
    const d = drive({ laps: 5, setup: s });
    expect(d.st.finished).toBe(true);
    expect(d.car.fuel).toBeGreaterThan(0.5);
  });

  it("部屋: 天気の予定が待合から送られ、5 周のレースを走り切る", () => {
    const sent: Array<{ to: string; msg: ServerMsg }> = [];
    let r = 11;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const room = new RaceRoom({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: "*", msg }) }, 5, rand);
    let now = 0;
    const j = room.join("k", "テスト", SAMPLE_DESIGN, now) as { id: string };
    // もう 1 人 (つながったまま見ているだけ)
    room.join("k2", "見る人", SAMPLE_DESIGN, now);
    expect(room.info().weather?.changes.length).toBeGreaterThan(0);
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    const plan = room.info().weather!;
    expect(plan).toBeTruthy();
    room.leave(j.id, now);
    for (let i = 0; i < 20 * 600 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    const res = (sent.filter((s) => s.msg.t === "phase").pop()!.msg as Extract<ServerMsg, { t: "phase" }>).info.results!;
    // 見ているだけの人のほかは全員ゴール
    expect(res.filter((x) => x.finished).length).toBe(7);
  });
});
