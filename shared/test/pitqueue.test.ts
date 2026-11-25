// チームの 2 台のピット (11/25 決まり「2 台同じ周なら後が待つ」): 相方が止まる場所で作業中なら、あとから来た車は手前で待つ
import { describe, expect, it } from "vitest";
import {
  LOBBY_MS,
  PIT_QUEUE_GAP,
  RaceRoom,
  SAMPLE_DESIGN,
  TRACK_DEFS,
  computeStats,
  createCar,
  enterPit,
  getTrack,
  inService,
  requestPit,
  stepCar,
  type CarState,
  type JoinTeam,
  type ServerMsg,
} from "../src/index.ts";

const track = getTrack(TRACK_DEFS[0].id);
const stats = computeStats(SAMPLE_DESIGN);

/** ピットの入り口を越えたところの車 (タイヤ交換の予約つき) */
function carInLane(offset: number): CarState {
  const car = createCar(track, stats, 0, { tire: "M" });
  car.started = true;
  car.dist = track.length + track.pit.entry + offset;
  requestPit(car, { tire: "S" });
  enterPit(car, track, 0);
  car.pit!.v = 14;
  return car;
}

/** 2 台を同じ刻みで進める (相方が作業中なら待つ)。a を先に計算する */
function run(a: CarState, b: CarState, seconds: number) {
  const log: Array<{ t: number; a: string; b: string; ua: number; ub: number }> = [];
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) {
    for (const [me, mate] of [
      [a, b],
      [b, a],
    ] as const) {
      if (me.pit) stepCar(me, { steer: 0, throttle: 0, brake: 0 }, stats, track, dt, { boxBusy: inService(mate) });
    }
    log.push({ t: i * dt, a: a.pit?.phase ?? "track", b: b.pit?.phase ?? "track", ua: a.pit?.u ?? -1, ub: b.pit?.u ?? -1 });
  }
  return log;
}

describe("ピットの止まる場所を 2 台で分け合う", () => {
  it("前の車の作業中は、後の車が止まる場所の手前で待ち、終わってから入る。2 台が同時に作業することはない", () => {
    const a = carInLane(25);
    const b = carInLane(0);
    const log = run(a, b, 30);
    // 同時に作業しない
    expect(log.some((x) => x.a === "box" && x.b === "box")).toBe(false);
    // 後の車は待った (手前で止まった)
    expect(log.some((x) => x.a === "box" && x.b === "in" && Math.abs(x.ub - (track.pit.box - PIT_QUEUE_GAP)) < 1e-6)).toBe(true);
    // 両方とも作業を終えてコースに戻り、タイヤが替わった
    expect(a.pit).toBeNull();
    expect(b.pit).toBeNull();
    expect(a.tire).toBe("S");
    expect(b.tire).toBe("S");
    // 後の車は前の車が出てから作業を始めた
    const aOut = log.findIndex((x) => x.a === "out");
    const bBox = log.findIndex((x) => x.b === "box");
    expect(bBox).toBeGreaterThanOrEqual(aOut);
  });

  it("同じ刻みに着いたら、先に計算した車が先 (いつも同じ結果)", () => {
    const one = run(carInLane(0), carInLane(0), 20);
    const two = run(carInLane(0), carInLane(0), 20);
    expect(one).toEqual(two);
    const firstBox = one.find((x) => x.a === "box" || x.b === "box")!;
    expect(firstBox.a).toBe("box");
    expect(firstBox.b).not.toBe("box");
    expect(one.some((x) => x.a === "box" && x.b === "box")).toBe(false);
  });

  it("相方がいなければ今までどおり (待たない)", () => {
    const a = carInLane(0);
    const lone = carInLane(0);
    const dt = 1 / 60;
    for (let i = 0; i < 20 * 60; i++) {
      if (a.pit) stepCar(a, { steer: 0, throttle: 0, brake: 0 }, stats, track, dt, { boxBusy: false });
      if (lone.pit) stepCar(lone, { steer: 0, throttle: 0, brake: 0 }, stats, track, dt);
    }
    expect(a.tire).toBe("S");
    expect(lone.tire).toBe("S");
    expect(a.dist).toBeCloseTo(lone.dist, 9);
  });
});

describe("部屋の中のチームの 2 台", () => {
  const STATS = { speed: 60, stability: 60, tyreFuel: 50, pitSense: 50 };
  const TEAM: JoinTeam = { second: { driverId: "d3", name: "霞谷 ナギ", design: SAMPLE_DESIGN, driver: STATS } };

  function start() {
    const sent: Array<{ to: string; msg: ServerMsg }> = [];
    let r = 7;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const room = new RaceRoom({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: "*", msg }) }, 2, rand);
    const a = room.join("ka", "A", SAMPLE_DESIGN, 0, () => {}, TEAM) as { id: string };
    room.tick(LOBBY_MS + 10);
    expect(room.phase).toBe("race");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ents = (room as any).entrants as Map<string, { id: string; car: CarState; mateId?: string; ownerId?: string }>;
    const second = [...ents.values()].find((e) => e.ownerId === a.id)!;
    return { room, sent, a, ents, second };
  }

  it("2 台目 (コンピューター) が作業中なら、人の画面に snap の busy で知らせる", () => {
    const { room, sent, a, ents, second } = start();
    expect(ents.get(a.id)!.mateId).toBe(second.id);
    expect(second.mateId).toBe(a.id);
    second.car.pit = { phase: "box", u: track.pit.box, v: 0, d0: 0, base: 0, elapsed: 0, service: 5 };
    room.tick(LOBBY_MS + 10 + 200);
    const snap = [...sent].reverse().find((s) => s.msg.t === "snap")!.msg as Extract<ServerMsg, { t: "snap" }>;
    expect(snap.busy).toEqual([a.id]);
    second.car.pit = null;
    room.tick(LOBBY_MS + 10 + 400);
    const snap2 = [...sent].reverse().find((s) => s.msg.t === "snap")!.msg as Extract<ServerMsg, { t: "snap" }>;
    expect(snap2.busy).toBeUndefined();
  });

  it("人の車が作業中 (state の box) なら、2 台目は手前で待つ", () => {
    const { room, a, second } = start();
    const c = ents(room).get(a.id)!.car;
    room.onMessage(a.id, { t: "state", x: c.x, y: c.y, h: c.heading, vx: 0, vy: 0, dist: 0, fuel: 10, lapsDone: 0, lapStart: 0, best: null, penalty: 0, pit: true, box: true }, LOBBY_MS + 20);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const busy = (room as any).mateInService(second) as boolean;
    expect(busy).toBe(true);
    // ピットの道を出たら (pit: false) 待たない
    room.onMessage(a.id, { t: "state", x: c.x, y: c.y, h: c.heading, vx: 0, vy: 0, dist: 0, fuel: 10, lapsDone: 0, lapStart: 0, best: null, penalty: 0, pit: false, box: true }, LOBBY_MS + 30);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((room as any).mateInService(second)).toBe(false);
  });
});

function ents(room: RaceRoom) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (room as any).entrants as Map<string, { id: string; car: CarState }>;
}
