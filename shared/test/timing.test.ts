import { describe, expect, it } from "vitest";
import {
  GapTrend,
  LOBBY_MS,
  RaceRoom,
  SAMPLE_DESIGN,
  STILL_SECONDS,
  TIMING_STEP,
  TRACK_DEFS,
  TimingMarks,
  formatGap,
  gapBetween,
  getTrack,
  ghostDelta,
  ghostProfile,
  ghostTimeAt,
  isStopped,
  newStint,
  pointAt,
  readSnapTyre,
  tyreLaps,
  updateStint,
  type RoomSnapshot,
  type ServerMsg,
  type SnapCar,
} from "../src/index.ts";

/** 一定の速さ v (m/s) で走った車の記録 (dt 秒ごと、start 秒に道のり d0) */
function drive(m: TimingMarks, v: number, from: number, to: number, d0 = 0, start = 0, dt = 0.1) {
  const n = Math.round((to - from) / dt);
  for (let i = 0; i <= n; i++) {
    const t = from + i * dt;
    m.push(t, d0 + v * (t - start));
  }
}

describe("タイム差 (印を通った時刻)", () => {
  it("印を通った時刻を、記録の間をまっすぐ割って入れる", () => {
    const m = new TimingMarks(1000);
    m.push(0, 10);
    m.push(1, 60); // 25 と 50 を越えた
    expect(m.at(1)).toBeCloseTo(0.3, 9);
    expect(m.at(2)).toBeCloseTo(0.8, 9);
    expect(m.latest()).toBe(2);
    expect(m.timeAt(37.5)).toBeCloseTo(0.55, 9);
    expect(m.at(3)).toBeNull();
  });

  it("下がっても印は増えず、また進むと続きから", () => {
    const m = new TimingMarks(1000);
    m.push(0, 0);
    m.push(1, 30);
    m.push(2, 20);
    expect(m.latest()).toBe(1);
    m.push(3, 55);
    expect(m.latest()).toBe(2);
    expect(m.at(2)!).toBeGreaterThan(2);
  });

  it("同じ速さで 2 秒あとを走る車との差は 2 秒 (遅い区間でも速い区間でも)", () => {
    const L = 2000;
    const a = new TimingMarks(L);
    const b = new TimingMarks(L);
    // 速さが変わるコース: 前半 30 m/s・後半 60 m/s。b は a の 2 秒あと
    const pos = (t: number) => (t < 20 ? 30 * t : 600 + 60 * (t - 20));
    for (let t = 0; t <= 40; t += 0.1) {
      a.push(t, pos(t));
      if (t >= 2) b.push(t, pos(t - 2));
    }
    const g = gapBetween(a, b, L);
    expect(g?.kind).toBe("time");
    expect((g as { sec: number }).sec).toBeCloseTo(2, 6);
    expect(formatGap(g)).toBe("+2.000");
  });

  it("1 周以上先なら 周の差 (+1 周)", () => {
    const L = 500;
    const a = new TimingMarks(L);
    const b = new TimingMarks(L);
    drive(a, 50, 0, 30); // 1500 m
    drive(b, 30, 0, 30); // 900 m
    expect(gapBetween(a, b, L)).toEqual({ kind: "laps", laps: 1 });
    expect(formatGap(gapBetween(a, b, L))).toBe("+1 周");
  });

  it("覚える量は 2 周分まで (古い印は消える)", () => {
    const L = 500;
    const m = new TimingMarks(L);
    drive(m, 50, 0, 100); // 5000 m = 10 周
    const k = m.latest()!;
    expect(k).toBe(200);
    expect(m.at(k - Math.ceil((2 * L) / TIMING_STEP))).not.toBeNull();
    expect(m.at(0)).toBeNull();
    expect(m.at(k - 100)).toBeNull();
  });

  it("ゴールした車はゴールの線の時刻で比べる", () => {
    const L = 1000;
    const a = new TimingMarks(L);
    const b = new TimingMarks(L);
    drive(a, 50, 0, 20); // 1000 m で 20 秒
    a.push(30, 1010); // ゴールのあと ゆっくり
    drive(b, 40, 0, 26); // 1000 m で 25 秒
    b.push(40, 1040);
    const g = gapBetween(a, b, L, 1000);
    expect((g as { sec: number }).sec).toBeCloseTo(5, 6);
  });

  it("止まった車との差は 時間とともに伸びる (前の車が次の印を通ったあと)", () => {
    const L = 2000;
    const a = new TimingMarks(L);
    const b = new TimingMarks(L);
    drive(a, 50, 0, 10); // 500 m
    drive(b, 50, 1, 5, 0, 1); // 1 秒あと、200 m で止まる
    b.push(8, 200);
    expect((gapBetween(a, b, L) as { sec: number }).sec).toBeCloseTo(8 - 4.5, 6); // a は 225 m を 4.5 秒
    b.push(12, 200);
    expect((gapBetween(a, b, L) as { sec: number }).sec).toBeCloseTo(12 - 4.5, 6);
  });

  it("ゴールの線の少し先で止まった車も、線の時刻が分かる", () => {
    const m = new TimingMarks(1000);
    m.push(0, 990);
    m.push(1, 1010); // 1000 を 0.5 秒で通った
    m.push(5, 1010); // 止まったまま
    expect(m.timeAt(1000)).toBeCloseTo(0.5, 9);
    expect(m.timeAt(1005)).toBeCloseTo(0.75, 9);
    expect(m.timeAt(1011)).toBeNull();
  });

  it("前の車の記録が少し古くても (snap の遅れ)、2 台とも通った印で差が出る", () => {
    const L = 2000;
    const a = new TimingMarks(L);
    const b = new TimingMarks(L);
    drive(a, 40, 0, 9.7); // 前の車: 388 m まで (最後の snap。今はもっと先)
    drive(b, 40, 0.5, 10.6, 0, 0.5); // 後ろの車: 0.5 秒あと。今は 404 m (前の車の最後の記録より先)
    expect(b.latest()!).toBeGreaterThan(a.latest()!);
    expect((gapBetween(a, b, L) as { sec: number }).sec).toBeCloseTo(0.5, 6);
  });

  it("入れかわりのすぐあと (塔の並びと印が逆) は分からない (「—」)。並んで走っても「+0.000」にはしない", () => {
    const L = 2000;
    // 塔では a が前 (今の道のりで並べる) だが、印では b が 0.05 秒先に通っている (抜いた直後)
    const a = new TimingMarks(L);
    const b = new TimingMarks(L);
    drive(a, 40, 0, 10);
    drive(b, 40, 0, 10, 0, -0.05);
    expect(gapBetween(a, b, L)).toBeNull();
    // ほとんど同じ時刻に通った 2 台: 小さいが 0 でない差
    const c = new TimingMarks(L);
    const d = new TimingMarks(L);
    drive(c, 40, 0, 10);
    drive(d, 40, 0, 10, 0, 0.0002);
    const g = gapBetween(c, d, L);
    expect(g).toEqual({ kind: "time", sec: expect.any(Number) });
    expect(formatGap(g)).not.toBe("+0.000");
    expect(formatGap(g)).toBe("+0.001");
  });

  it("まだ印を通っていなければ分からない (null)", () => {
    const a = new TimingMarks(1000);
    const b = new TimingMarks(1000);
    a.push(0, -5);
    b.push(0, -10);
    expect(gapBetween(a, b, 1000)).toBeNull();
    expect(formatGap(null)).toBe("");
  });

  it("差の伸び縮み: 5 秒で 0.5 秒縮むと マイナス", () => {
    const tr = new GapTrend();
    for (let t = 0; t <= 6; t += 0.5) tr.push("x", t, 2 - t * 0.1);
    expect(tr.delta()).toBeCloseTo(-0.5, 6);
    tr.push("y", 7, 1); // 相手が変わると忘れる
    expect(tr.delta()).toBe(0);
  });
});

describe("練習の幽霊との差", () => {
  const track = getTrack(TRACK_DEFS[0].id);
  const L = track.length;
  /** コースの真ん中を一定の速さ v で 1 周した幽霊 */
  function ghostAt(v: number) {
    const lap = L / v;
    const pts: number[] = [];
    for (let t = 0.1; t < lap; t += 0.1) {
      const p = pointAt(track, v * t, 0);
      pts.push(p.x, p.y, p.heading);
    }
    return { lap, pts };
  }

  it("同じ道のりの時刻と比べる", () => {
    const g = ghostAt(50);
    const p = ghostProfile(track, g.pts, g.lap)!;
    expect(p).not.toBeNull();
    expect(ghostTimeAt(p, L / 2)!).toBeCloseTo(L / 2 / 50, 0);
    // 半周を 1 秒遅れで通った
    expect(ghostDelta(p, L / 2 / 50 + 1, L / 2)!).toBeCloseTo(1, 0);
    // 周の終わりで ぴったり周の時間
    expect(ghostTimeAt(p, L)!).toBeCloseTo(g.lap, 6);
    expect(ghostTimeAt(p, L + 1)).toBeNull();
  });
});

describe("ピットの回数とタイヤの周", () => {
  const obs = (o: Partial<Parameters<typeof updateStint>[1]>) => ({ inPit: false, tire: "M" as const, wear: 0, burst: false, dist: 0, speed: 50, running: true, ...o });

  it("ピットの道に入るたびに 1 回。タイヤを替えると周は 0 から", () => {
    const s = newStint("M", 0, 0);
    updateStint(s, obs({ dist: 1000, wear: 0.2 }), 10);
    expect(tyreLaps(s, 2500, 1000)).toBe(2);
    updateStint(s, obs({ dist: 2600, wear: 0.4, inPit: true }), 40);
    updateStint(s, obs({ dist: 2610, wear: 0.4, inPit: true }), 41);
    expect(s.pitStops).toBe(1);
    // 硬いに替えた
    updateStint(s, obs({ dist: 2620, tire: "H", inPit: true }), 45);
    updateStint(s, obs({ dist: 2700, tire: "H" }), 50);
    expect(s.fitAt).toBe(2620);
    expect(tyreLaps(s, 3500, 1000)).toBe(0);
    expect(tyreLaps(s, 3700, 1000)).toBe(1);
    updateStint(s, obs({ dist: 3700, tire: "H", inPit: true }), 90);
    expect(s.pitStops).toBe(2);
  });

  it("同じ種類でも 減りが戻る・破裂が直る・ピットでもっと減った組に替える と替えたとみる", () => {
    const s = newStint("S", 0.5, 0);
    updateStint(s, obs({ tire: "S", wear: 0.1, dist: 100 }), 1);
    expect(s.fitAt).toBe(100);
    updateStint(s, obs({ tire: "S", wear: 1, burst: true, dist: 200 }), 2);
    updateStint(s, obs({ tire: "S", wear: 1, burst: false, dist: 300, inPit: true }), 3);
    expect(s.fitAt).toBe(300);
    updateStint(s, obs({ tire: "S", wear: 0.2, dist: 400, inPit: true }), 4);
    updateStint(s, obs({ tire: "S", wear: 0.6, dist: 410, inPit: true }), 5);
    expect(s.fitAt).toBe(410);
    // ふつうに走って減っても替えたとはみない
    updateStint(s, obs({ tire: "S", wear: 0.7, dist: 900 }), 9);
    expect(s.fitAt).toBe(410);
  });

  it(`コースの上で ${STILL_SECONDS} 秒止まると「止まっている」`, () => {
    const s = newStint("M", 0, 0);
    updateStint(s, obs({ speed: 0.1 }), 10);
    expect(isStopped(s, 10.5)).toBe(false);
    expect(isStopped(s, 10 + STILL_SECONDS)).toBe(true);
    updateStint(s, obs({ speed: 0.1, inPit: true }), 13);
    expect(isStopped(s, 13)).toBe(false);
  });
});

describe("snap のタイヤ・ピットの回数", () => {
  it("前のサーバーの 9 つの形も読める (足したところは null)", () => {
    const old: SnapCar = ["b1", 0, 0, 0, 10, 8, 0, 0, 0];
    expect(readSnapTyre(old)).toEqual({ tire: null, tyreLaps: null, pitStops: null, burst: false, stopped: false });
    const now: SnapCar = ["b1", 0, 0, 0, 10, 64 | 128, 0, 0, 0, "W", 3, 2];
    expect(readSnapTyre(JSON.parse(JSON.stringify(now)))).toEqual({ tire: "W", tyreLaps: 3, pitStops: 2, burst: true, stopped: true });
    expect(readSnapTyre(["x", 0, 0, 0, 0, 0, 0, 0, 0, "Z", -1, "a"]).tire).toBeNull();
  });

  function setup(laps = 2) {
    const sent: Array<{ to: string; msg: ServerMsg }> = [];
    let r = 11;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const room = new RaceRoom({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: "*", msg }) }, laps, rand);
    return { room, sent };
  }
  const lastSnap = (sent: Array<{ msg: ServerMsg }>) => (sent.filter((s) => s.msg.t === "snap").pop()!.msg as Extract<ServerMsg, { t: "snap" }>).cars;

  it("部屋: 人のピット (pit の false → true) とタイヤの交換を数えて送る。コンピューターのピットも", () => {
    const { room, sent } = setup(5);
    let now = 0;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    const info = room.info();
    now = info.lightsOutAt + 1000;
    const L = getTrack(info.trackId).length;
    const state = (dist: number, o: { pit?: boolean; tire?: "M" | "H"; wear?: number } = {}) => {
      room.onMessage(a.id, { t: "state", x: 0, y: 0, h: 0, vx: 40, vy: 0, dist, fuel: 30, lapsDone: Math.floor(dist / L), lapStart: 0, best: null, penalty: 0, tire: o.tire ?? "M", wear: o.wear ?? 0.1, burst: false, pit: !!o.pit }, now);
      now += 100;
      room.tick(now);
    };
    state(10);
    state(L + 300, { wear: 0.3 });
    let me = lastSnap(sent).find((c) => c[0] === a.id)!;
    expect(readSnapTyre(me)).toMatchObject({ tire: "M", tyreLaps: 1, pitStops: 0 });
    state(2 * L - 50, { wear: 0.4, pit: true });
    state(2 * L - 40, { wear: 0.4, pit: true });
    state(2 * L - 30, { tire: "H", wear: 0, pit: true });
    state(2 * L + 50, { tire: "H", wear: 0.01 });
    me = lastSnap(sent).find((c) => c[0] === a.id)!;
    expect(readSnapTyre(me)).toMatchObject({ tire: "H", tyreLaps: 0, pitStops: 1 });
    expect(me[5] & 8).toBe(0);

    // コンピューターのタイヤを破裂させる → 印 64 が付き、自分でピットに入って替える
    const bots = (room as unknown as { entrants: Map<string, { bot: boolean; car: { burst: boolean; wear: number; sets: unknown } }> }).entrants;
    const bot = [...bots.entries()].find(([, e]) => e.bot)!;
    bot[1].car.sets = null;
    bot[1].car.burst = true;
    bot[1].car.wear = 1;
    now += 100;
    room.tick(now);
    expect(readSnapTyre(lastSnap(sent).find((x) => x[0] === bot[0])!).burst).toBe(true);
    let seen: ReturnType<typeof readSnapTyre> | null = null;
    for (let i = 0; i < 20 * 240; i++) {
      now += 50;
      room.tick(now);
      const c = lastSnap(sent).find((x) => x[0] === bot[0]);
      if (c && !(c[5] & 8) && readSnapTyre(c).pitStops === 1) {
        seen = readSnapTyre(c);
        break;
      }
    }
    expect(seen).toMatchObject({ tyreLaps: 0, pitStops: 1, burst: false });
  });

  it("部屋を残して戻しても (レースの外で) 前と同じ。レース中のピットの回数は残さない", () => {
    const { room } = setup(2);
    const now = 1000;
    room.join("ka", "A", SAMPLE_DESIGN, now);
    const data = JSON.parse(JSON.stringify(room.snapshot())) as RoomSnapshot;
    const back = RaceRoom.restore({ send: () => {}, broadcast: () => {} }, data, now + 10);
    expect(back.snapshot()).toEqual(room.snapshot());
    expect(JSON.stringify(data)).not.toContain("pitStops");
    expect(JSON.stringify(data)).not.toContain("stint");
  });
});
