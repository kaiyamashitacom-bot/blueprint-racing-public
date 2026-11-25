// チームの 2 台目への作戦の合図 (teamorder.ts と room.ts)
import { describe, expect, it } from "vitest";
import {
  DT, LOBBY_MS, RaceRoom, SAMPLE_DESIGN, TEAM_ORDER, TRACK_DEFS, applyTeamOrder, botInput, computeStats, createCar, getTrack, isTeamOrder, makeBrain,
  newLapState, stepCar, teamOrderBase, updateBotPit, updateLaps, yieldDone, yieldSpeedCap,
  type JoinTeam, type ServerMsg,
} from "../src/index.ts";

const STATS = { speed: 60, stability: 60, tyreFuel: 50, pitSense: 50 };
const TEAM: JoinTeam = { second: { driverId: "d3", name: "霞谷 ナギ", design: SAMPLE_DESIGN, driver: STATS } };

function setup(laps: number) {
  const sent: Array<{ to: string; msg: ServerMsg }> = [];
  let r = 11;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const room = new RaceRoom({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: "*", msg }) }, laps, rand, [TRACK_DEFS[0].id]);
  return { room, sent };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entrants = (room: RaceRoom) => (room as any).entrants as Map<string, any>;

/** 1 周を走る (コンピューターの頭で)。returns 秒とすり減り */
function lap(order: "none" | "save" | "push") {
  const track = getTrack("aozu");
  const stats = computeStats(SAMPLE_DESIGN);
  const car = createCar(track, stats, 0, { tire: "M" });
  car.started = true;
  const brain = makeBrain(() => 0.5, 0.92);
  applyTeamOrder(brain, car, order, teamOrderBase(brain, car));
  const st = newLapState();
  let t = 0;
  while (t < 200 && st.lapsDone < 1) {
    const ev = stepCar(car, botInput(car, stats, track, brain, t, [], 0), stats, track, DT);
    t += DT;
    updateLaps(car, st, ev, t, track.length, 5, false);
  }
  return { t, wear: car.wear };
}

describe("作戦の合図 (数)", () => {
  it("タイヤを持たせろ は遅く走ってタイヤが長もち。合図を戻すと元の数", () => {
    const plain = lap("none");
    const save = lap("save");
    expect(save.t).toBeGreaterThan(plain.t);
    expect(save.wear).toBeLessThan(plain.wear * 0.9);
    const track = getTrack("aozu");
    const car = createCar(track, computeStats(SAMPLE_DESIGN), 0, { wearScale: 0.9 });
    const brain = makeBrain(() => 0.5, 0.9);
    const base = teamOrderBase(brain, car);
    applyTeamOrder(brain, car, "push", base);
    expect(brain.passAggression).toBeCloseTo(TEAM_ORDER.push.aggression);
    expect(car.wearScale).toBeCloseTo(0.9 * TEAM_ORDER.push.wear);
    applyTeamOrder(brain, car, "none", base);
    expect(brain.passAggression).toBe(1);
    expect(car.wearScale).toBeCloseTo(0.9);
    expect(brain.paceScale).toBeUndefined();
    expect(isTeamOrder("yield")).toBe(true);
    expect(isTeamOrder("drop")).toBe(false);
  });

  it("ピットに入れ: 用がなくても次の入り口で入る予約をし、入ったら消える", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const car = createCar(track, stats, 0, { tire: "M", fuel: stats.fuelCap });
    car.dist = 50;
    const brain = makeBrain(() => 0.5, 0.9);
    updateBotPit(car, stats, track, brain, { totalLaps: 5, wetNow: 0, wetSoon: 0 });
    expect(car.pitOrder).toBeFalsy();
    applyTeamOrder(brain, car, "pit", teamOrderBase(brain, car));
    updateBotPit(car, stats, track, brain, { totalLaps: 5, wetNow: 0, wetSoon: 0 });
    expect(car.pitOrder?.tire).toBeTruthy();
    car.pit = { phase: "in", u: 0, v: 10 } as never;
    updateBotPit(car, stats, track, brain, { totalLaps: 5, wetNow: 0, wetSoon: 0 });
    expect(brain.forcePit).toBeUndefined();
  });

  it("前を譲れ: 相方がすぐ後ろのときだけ落とし、前に出たら済み", () => {
    const track = getTrack("aozu");
    const me = createCar(track, computeStats(SAMPLE_DESIGN), 0);
    me.dist = 1000;
    expect(yieldSpeedCap(me, { dist: 990, vx: 50, vy: 0 })).toBeCloseTo(50 * TEAM_ORDER.yield.capFactor);
    expect(yieldSpeedCap(me, { dist: 900, vx: 50, vy: 0 })).toBeUndefined();
    expect(yieldSpeedCap(me, { dist: 1010, vx: 50, vy: 0 })).toBeUndefined();
    expect(yieldSpeedCap(me, { dist: 990, vx: 50, vy: 0, pit: true })).toBeUndefined();
    expect(yieldSpeedCap(me, { dist: 998, vx: 5, vy: 0 })).toBe(TEAM_ORDER.yield.minCap);
    expect(yieldDone(me, { dist: 1004 })).toBe(true);
    expect(yieldDone(me, { dist: 995 })).toBe(false);
  });
});

describe("作戦の合図 (部屋)", () => {
  it("2 台目のいる人だけが送れ、2 台目の頭が変わる。名簿に 2 台目の持ち主が出る", () => {
    const { room, sent } = setup(3);
    let now = 0;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now, () => {}, TEAM) as { id: string };
    const b = room.join("kb", "B", SAMPLE_DESIGN, now) as { id: string };
    // レースの前は何もしない
    room.onMessage(a.id, { t: "order", order: "push" }, now);
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    const second = room.roster().find((x) => x.owner === a.id)!;
    expect(second.name).toBe("霞谷 ナギ");
    expect(room.roster().filter((x) => x.owner).length).toBe(1);
    const mate = entrants(room).get(second.id);
    expect(mate.order).toBeUndefined();
    const wear0 = mate.car.wearScale ?? 1;
    room.onMessage(a.id, { t: "order", order: "save" }, now);
    expect(mate.order).toBe("save");
    expect(mate.brain.paceScale).toBe(TEAM_ORDER.save.pace);
    expect(mate.car.wearScale).toBeCloseTo(wear0 * TEAM_ORDER.save.wear);
    expect(sent.some((s) => s.to === a.id && s.msg.t === "info" && /タイヤを持たせろ/.test(s.msg.text))).toBe(true);
    // 2 台目のいない人・おかしな合図は何もしない
    room.onMessage(b.id, { t: "order", order: "pit" }, now);
    room.onMessage(a.id, { t: "order", order: "fly" as never }, now);
    expect(mate.order).toBe("save");
    room.onMessage(a.id, { t: "order", order: "push" }, now);
    expect(mate.brain.paceScale).toBeUndefined();
    expect(mate.car.wearScale).toBeCloseTo(wear0 * TEAM_ORDER.push.wear);
    // ピットに入れ: 走らせると 2 台目がピットに入る
    room.onMessage(a.id, { t: "order", order: "pit" }, now);
    let pitted = false;
    for (let i = 0; i < 20 * 120 && room.phase === "race" && !pitted; i++) {
      now += 50;
      room.tick(now);
      pitted = !!mate.car.pit;
    }
    expect(pitted).toBe(true);
  });

  it("前を譲れ: 相方が後ろに来なければ しばらくで終わる", () => {
    const { room } = setup(3);
    let now = 0;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now, () => {}, TEAM) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    const mate = entrants(room).get(room.roster().find((x) => x.owner === a.id)!.id);
    room.onMessage(a.id, { t: "order", order: "yield" }, now);
    expect(mate.order).toBe("yield");
    for (let i = 0; i < 20 * (TEAM_ORDER.yield.timeoutS + 15) && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(mate.order).toBe("none");
  });
});
