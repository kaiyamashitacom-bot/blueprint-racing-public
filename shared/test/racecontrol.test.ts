import { describe, expect, it } from "vitest";
import {
  DT, LOBBY_MS, RaceRoom, SAMPLE_DESIGN, SC_GAP, SC_MAX_TIME, STOP_TIME, VSC_SPEED, VSC_TIME, YELLOW_PENALTY, computeStats, createCar,
  flagInfo, flagInput, flagSpeedCap, getTrack, isYellow, newRaceControl, overtakeAllowed, passExempt, pointAt, queryTrack, scFollowInput, scOrder,
  scTarget, sectorOf, stepCar, stepRaceControl, type CarState, type FlagInfo, type FollowTarget, type RcCar, type ServerMsg,
} from "../src/index.ts";

const track = getTrack("aozu");
const L = track.length;

function rcCar(id: string, dist: number, speed: number, o: Partial<RcCar> = {}): RcCar {
  return { id, dist, speed, lapsDone: Math.floor(dist / L), started: true, pit: false, finished: false, retired: false, hits: 0, lost: 0, ...o };
}

/** 車を t 秒ぶん同じ速さで進めながら、取り締まりを動かす */
function run(rc: ReturnType<typeof newRaceControl>, cars: RcCar[], sec: number, env = {}) {
  const evs = [];
  for (let i = 0; i < Math.round(sec / DT); i++) {
    for (const c of cars) c.dist += c.speed * DT;
    evs.push(...stepRaceControl(rc, track, cars, DT, env));
  }
  return evs;
}

describe("旗: VSC", () => {
  it("止まった車がいると 黄旗 + VSC。VSC_TIME で緑に戻る", () => {
    const rc = newRaceControl("sun");
    const cars = [rcCar("a", 400, 30), rcCar("b", 300, 30), rcCar("x", 600, 0)];
    run(rc, cars, 5);
    expect(rc.mode).toBe("green");
    const evs = run(rc, cars, STOP_TIME + 0.2);
    expect(rc.mode).toBe("vsc");
    expect(evs.some((e) => e.kind === "vsc")).toBe(true);
    expect(isYellow(rc, track, 600)).toBe(true);
    expect(flagSpeedCap(flagInfo(rc, cars))).toBe(VSC_SPEED);
    const later = run(rc, cars, VSC_TIME);
    expect(later.some((e) => e.kind === "ending")).toBe(true);
    expect(rc.mode).toBe("green");
    expect(flagSpeedCap(flagInfo(rc, cars))).toBeUndefined();
  });

  it("スタート前・ピットの中・ゴールした車が止まっていても出ない", () => {
    const rc = newRaceControl("sun");
    const cars = [rcCar("grid", -20, 0), rcCar("pit", 30, 0, { pit: true }), rcCar("done", 900, 0, { finished: true }), rcCar("a", 100, 30)];
    run(rc, cars, 15);
    expect(rc.mode).toBe("green");
  });
});

describe("旗: 黄旗と追い越し", () => {
  it("強く当たった車の区間は黄旗。その区間で抜くと罰。止まりかけの車を抜くのはよい", () => {
    const rc = newRaceControl("sun");
    const hitter = rcCar("h", 520, 25);
    const a = rcCar("a", 495, 32);
    const b = rcCar("b", 505, 26);
    const cars = [hitter, a, b];
    run(rc, cars, 6);
    hitter.hits = 1;
    hitter.dist = 520;
    hitter.speed = 4;
    a.dist = 480;
    b.dist = 490;
    const evs = run(rc, cars, DT);
    expect(evs.some((e) => e.kind === "yellow")).toBe(true);
    expect(isYellow(rc, track, 520)).toBe(true);
    expect(overtakeAllowed(rc, track, 520)).toBe(false);
    expect(overtakeAllowed(rc, track, 520 + L / 2)).toBe(true);
    // a が b を黄旗の区間で抜く。h (止まりかけ) も抜くが、それは罰なし
    const pens = run(rc, cars, 3).filter((e) => e.kind === "penalty");
    expect(sectorOf(track, 520)).toBe(sectorOf(track, b.dist - 20));
    expect(pens.length).toBe(1);
    expect(pens[0]).toMatchObject({ id: "a", passed: "b", seconds: YELLOW_PENALTY });
    expect(rc.pen.a).toBe(YELLOW_PENALTY);
    expect(flagInfo(rc, cars).pen).toEqual({ a: YELLOW_PENALTY });
  });
});

describe("旗: 傷んだ車を抜くのはよい", () => {
  /** 黄旗を出した区間で a (32 m/s) が b を抜く。罰の数を返す */
  function passIn(b: Partial<RcCar>, bSpeed: number, mode: "yellow" | "vsc" = "yellow") {
    const rc = newRaceControl("sun");
    const a = rcCar("a", 480, 32);
    const slow = rcCar("b", 490, bSpeed, b);
    const cars = [a, slow];
    if (mode === "vsc") {
      rc.mode = "vsc";
      rc.until = rc.t + 60;
    } else for (const d of [480, 520, 560, 600]) rc.yellows.push({ sector: sectorOf(track, d), until: rc.t + 60 });
    return run(rc, cars, 3).filter((e) => e.kind === "penalty").length;
  }

  it("ふつうの速さの車 (8 割) を黄旗・VSC で抜くと罰", () => {
    expect(passIn({}, 26)).toBe(1);
    expect(passIn({}, 18, "vsc")).toBe(1);
  });

  it("タイヤが破れて 13 m/s で走る車・部品が壊れた車・落とした車は抜いてよい", () => {
    expect(passIn({ burst: true }, 13)).toBe(0);
    expect(passIn({ burst: true }, 26)).toBe(0);
    expect(passIn({ broken: 1 }, 20)).toBe(0);
    expect(passIn({ lost: 1 }, 20)).toBe(0);
  });

  it("抜く車の半分より遅い車は抜いてよい", () => {
    expect(passIn({}, 13)).toBe(0);
    expect(passExempt({ speed: 32 }, { speed: 17, pit: false, lost: 0 })).toBe(false);
    expect(passExempt({ speed: 32 }, { speed: 15, pit: false, lost: 0 })).toBe(true);
    expect(passExempt({ speed: 32 }, { speed: 30, pit: true, lost: 0 })).toBe(true);
  });
});

describe("旗: SC", () => {
  it("部品が落ちたら SC。先導車は先頭の前に出る。大雨に変わっても SC", () => {
    const rc = newRaceControl("sun");
    const cars = [rcCar("a", 400, 30), rcCar("b", 300, 30)];
    run(rc, cars, 6);
    cars[1].lost = 1;
    const evs = run(rc, cars, DT);
    expect(evs.some((e) => e.kind === "sc")).toBe(true);
    expect(rc.mode).toBe("sc");
    expect(rc.sc!.dist).toBeGreaterThan(cars[0].dist);
    const info = flagInfo(rc, cars);
    expect(info.order).toEqual(["a", "b"]);
    expect(info.cap).toBeGreaterThan(VSC_SPEED);

    cars[1].lost = 0;
    const rain = newRaceControl("light");
    run(rain, cars, 1, { sky: "light" });
    expect(rain.mode).toBe("green");
    run(rain, cars, DT, { sky: "heavy" });
    expect(rain.mode).toBe("sc");
    // 先頭がゴールしたあとは出さない
    const late = newRaceControl("light");
    run(late, cars, 1, { sky: "heavy", chequered: true });
    expect(late.mode).toBe("green");
  });

  it("SC の間は一列に並んで自動で走り、差が詰まると SC が入って、先頭がスタートの線を越えたら再開", () => {
    const stats = computeStats(SAMPLE_DESIGN);
    const n = 5;
    const cars: CarState[] = [];
    for (let k = 0; k < n; k++) {
      // ばらばらの間で並べる (先頭 600 m、後ろほど離れる)
      const s = 600 - k * (20 + k * 25);
      const car = createCar(track, stats, k);
      const p = pointAt(track, s, (k % 2 ? 1 : -1) * 2);
      const q = queryTrack(track, p.x, p.y);
      Object.assign(car, { x: p.x, y: p.y, heading: p.heading, vx: Math.cos(p.heading) * 30, vy: Math.sin(p.heading) * 30, hint: q.index, lastS: q.s, dist: s, started: true });
      cars.push(car);
    }
    const ids = cars.map((_, k) => `c${k}`);
    const rcCars = () => cars.map((c, k) => rcCar(ids[k], c.dist, Math.hypot(c.vx, c.vy), { lapsDone: Math.floor(c.dist / L), lost: k === 3 ? 1 : 0 }));
    const rc = newRaceControl("sun");
    // 1 回目は覚えるだけ、2 回目で c3 の部品が落ちたことに気づく
    stepRaceControl(rc, track, cars.map((c, k) => rcCar(ids[k], c.dist, 30)), DT);
    stepRaceControl(rc, track, rcCars(), DT);
    expect(rc.mode).toBe("sc");
    let order0: string[] = [];
    let sawEnding = false;
    let wentIn = -1;
    let minGap = Infinity;
    let walls = 0;
    for (let i = 0; i < 60 * (SC_MAX_TIME + 80) && rc.mode === "sc"; i++) {
      const info = flagInfo(rc, rcCars());
      if (!order0.length) order0 = info.order!;
      const table = new Map<string, FollowTarget>(cars.map((c, k) => [ids[k], { dist: c.dist, v: Math.hypot(c.vx, c.vy) }]));
      cars.forEach((c, k) => {
        const inp = flagInput(info, ids[k], c, stats, track, table)!;
        expect(inp).not.toBeNull();
        const ev = stepCar(c, inp, stats, track, DT, { speedCap: flagSpeedCap(info) });
        if (ev.wall > 3) walls++;
      });
      stepRaceControl(rc, track, rcCars(), DT);
      sawEnding ||= rc.ending;
      if (rc.ending && !rc.sc && wentIn < 0) wentIn = rc.t;
      if (rc.t > 40) for (let k = 1; k < n; k++) minGap = Math.min(minGap, cars[k - 1].dist - cars[k].dist);
    }
    expect(sawEnding).toBe(true);
    expect(wentIn).toBeGreaterThan(0);
    expect(rc.mode).toBe("green");
    // 順番は変わらず、詰まっていて、ぶつかっていない
    const finalOrder = scOrder(rcCars()).map((c) => c.id);
    expect(finalOrder).toEqual(order0);
    expect(minGap).toBeGreaterThan(SC_GAP * 0.5);
    for (let k = 1; k < n; k++) expect(cars[k - 1].dist - cars[k].dist).toBeLessThan(SC_GAP * 3);
    expect(walls).toBe(0);
  });

  it("scTarget: 前の車、先頭は先導車。SC でなければ null", () => {
    const table = new Map<string, FollowTarget>([
      ["a", { dist: 100, v: 20 }],
      ["b", { dist: 80, v: 21 }],
    ]);
    const info: FlagInfo = { mode: "sc", ending: false, yellow: [], sectors: 10, drs: false, order: ["a", "b"], sc: { dist: 130, v: 22 } };
    expect(scTarget(info, "b", table)).toEqual({ dist: 100, v: 20 });
    expect(scTarget(info, "a", table)).toEqual({ dist: 130, v: 22 });
    expect(scTarget({ ...info, mode: "vsc" }, "a", table)).toBeNull();
    const car = createCar(track, computeStats(SAMPLE_DESIGN), 0);
    expect(flagInput({ ...info, mode: "green" }, "a", car, computeStats(SAMPLE_DESIGN), track, table)).toBeNull();
    expect(scFollowInput(car, computeStats(SAMPLE_DESIGN), track, null).throttle).toBeGreaterThan(0);
  });
});

describe("速さの上限 (VSC)", () => {
  it("stepCar の env.speedCap を超えない (超えていたら落とす)", () => {
    const stats = computeStats(SAMPLE_DESIGN);
    const car = createCar(track, stats, 0);
    const p = pointAt(track, 20);
    Object.assign(car, { x: p.x, y: p.y, heading: p.heading, vx: Math.cos(p.heading) * 40, vy: Math.sin(p.heading) * 40, dist: 20, started: true });
    for (let i = 0; i < 60 * 4; i++) stepCar(car, { steer: 0, throttle: 1, brake: 0 }, stats, track, DT, { speedCap: VSC_SPEED });
    expect(Math.hypot(car.vx, car.vy)).toBeLessThanOrEqual(VSC_SPEED + 0.01);
    expect(Math.hypot(car.vx, car.vy)).toBeGreaterThan(VSC_SPEED - 1);
  });
});

describe("部屋と旗", () => {
  function setup(laps = 3) {
    const sent: Array<{ to: string; msg: ServerMsg }> = [];
    let r = 21;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const room = new RaceRoom({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: "*", msg }) }, laps, rand, ["aozu"]);
    return { room, sent };
  }
  const snaps = (sent: Array<{ msg: ServerMsg }>) => sent.map((s) => s.msg).filter((m): m is Extract<ServerMsg, { t: "snap" }> => m.t === "snap");

  it("人の車が止まると VSC。コンピューターは速さの上限を守り、snap の flag で知らせる。罰は結果に入る", () => {
    const { room, sent } = setup(2);
    let now = 0;
    const a = room.join("ka", "止まる人", SAMPLE_DESIGN, now) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    const lightsOut = room.info().lightsOutAt;
    // 信号が消えて 8 秒たつまで進める (人は位置を送らない)
    while (now < lightsOut + 8000) {
      now += 50;
      room.tick(now);
    }
    // 人の車がコースの途中 (600 m) で止まっていると送ってくる (傷みも)
    const p = pointAt(track, 600, 3);
    const stats = computeStats(SAMPLE_DESIGN);
    const dmg = stats.layout!.map((_, i) => (i === 0 ? 1 : 0));
    let sawVsc = false;
    let maxBotSpeed = 0;
    for (let i = 0; i < 20 * 15; i++) {
      now += 50;
      room.onMessage(a.id, { t: "state", x: p.x, y: p.y, h: p.heading, vx: 0, vy: 0, dist: 600, fuel: 10, lapsDone: 0, lapStart: 0, best: null, penalty: 0, dmg, hits: 1 }, now);
      room.tick(now);
      const last = snaps(sent).pop();
      if (last?.flag?.mode === "vsc") {
        if (!sawVsc) {
          sawVsc = true;
          expect(last.flag.yellow).toContain(sectorOf(track, 600));
          expect(last.flag.cap).toBe(VSC_SPEED);
        }
        // VSC になって 4 秒たったら、コンピューターはみな上限以下
        if (i > 0 && snaps(sent).filter((s) => s.flag?.mode === "vsc").length > 40) {
          for (const c of last.cars) if (c[0] !== a.id && !(c[5] & 8)) maxBotSpeed = Math.max(maxBotSpeed, Math.hypot(c[7], c[8]));
        }
      }
    }
    expect(sawVsc).toBe(true);
    expect(maxBotSpeed).toBeGreaterThan(5);
    expect(maxBotSpeed).toBeLessThanOrEqual(VSC_SPEED + 0.6);
    // 壊れた部品のある車には印 32
    const mine = snaps(sent).pop()!.cars.find((c) => c[0] === a.id)!;
    expect(mine[5] & 32).toBe(32);
    expect(sent.some((s) => s.msg.t === "info" && s.msg.text.startsWith("VSC"))).toBe(true);
  });

  it("同じ種なら同じレース (旗も含めて決まった計算)", () => {
    const race = () => {
      const { room, sent } = setup(2);
      let now = 0;
      const a = room.join("ka", "A", SAMPLE_DESIGN, now) as { id: string };
      room.join("kb", "B", SAMPLE_DESIGN, now);
      now += LOBBY_MS + 10;
      room.tick(now);
      room.leave(a.id, now);
      for (let i = 0; i < 20 * 400 && room.phase === "race"; i++) {
        now += 50;
        room.tick(now);
      }
      const res = (sent.filter((s) => s.msg.t === "phase").pop()!.msg as Extract<ServerMsg, { t: "phase" }>).info.results!;
      return res.map((r) => [r.id, r.total.toFixed(4), r.penalty, r.best]);
    };
    const one = race();
    expect(one.length).toBe(8);
    expect(race()).toEqual(one);
  });
});
