// 1 周アタックの試験: 今週のコース・下限・幽霊の確かめ・設計図・順位・幽霊を小さくする
import { describe, expect, it } from "vitest";
import {
  BOT_DESIGNS,
  BOT_SKILL_MAX,
  DT,
  SAMPLE_DESIGN,
  SEASON_EPOCH_MS,
  SEASON_MS,
  STARTER_BOX,
  TA_CONDITIONS,
  TA_SUBMIT_GRACE_MS,
  TaGhostRecorder,
  TRACK_DEFS,
  benchLap,
  botInput,
  checkTaDesign,
  checkTaGhost,
  checkTaLap,
  checkTaSubmission,
  computeStats,
  createCar,
  decodeGhost,
  designHash,
  encodeGhost,
  getTrack,
  makeBrain,
  newLapState,
  rankTa,
  stepCar,
  taAcceptsWeek,
  taImproves,
  taLapFloor,
  taLapMs,
  taLeftText,
  taRankOf,
  taTrackFor,
  taWeekAt,
  updateLaps,
  type CarDesign,
  type Track,
} from "@bpr/shared";

/** 一番上手いコンピューターに走らせて、2 周目を レースの画面と同じやり方 (0.1 秒ごと) で幽霊にする */
function botGhost(design: CarDesign, track: Track): { lap: number; pts: number[] } {
  const stats = computeStats(design);
  const car = createCar(track, stats, 0, { tire: TA_CONDITIONS.tire, fuel: stats.fuelCap });
  car.started = true;
  const brain = makeBrain(() => 0.5, BOT_SKILL_MAX);
  const st = newLapState();
  let t = 0;
  let rec: number[] = [];
  let next = 0;
  let laps = 0;
  while (t < 600) {
    const ev = stepCar(car, botInput(car, stats, track, brain, t, [], 0), stats, track, DT, { damage: false });
    t += DT;
    const le = updateLaps(car, st, ev, t, track.length, 3, false);
    // 0.1 秒の目盛りちょうどで記録する (画面の taRecorder と同じ)
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

describe("今週のコース", () => {
  it("週ごとに公式コースを順に回す (前の週も負の番号も)", () => {
    const n = TRACK_DEFS.length;
    expect(taTrackFor(0).id).toBe(TRACK_DEFS[0].id);
    expect(taTrackFor(1).id).toBe(TRACK_DEFS[1 % n].id);
    expect(taTrackFor(n).id).toBe(TRACK_DEFS[0].id);
    expect(taTrackFor(-1).id).toBe(TRACK_DEFS[n - 1].id);
  });

  it("月曜 0:00 (日本時間) で変わる", () => {
    const w0 = taWeekAt(SEASON_EPOCH_MS);
    expect(w0.index).toBe(0);
    expect(w0.startsAt).toBe(SEASON_EPOCH_MS);
    expect(w0.endsAt).toBe(SEASON_EPOCH_MS + SEASON_MS);
    expect(taWeekAt(SEASON_EPOCH_MS - 1).index).toBe(-1);
    expect(taWeekAt(SEASON_EPOCH_MS + SEASON_MS).index).toBe(1);
    expect(taWeekAt(SEASON_EPOCH_MS + SEASON_MS).trackId).not.toBe(w0.trackId);
  });

  it("週が変わってすぐなら前の週の記録も受け付ける", () => {
    const start = SEASON_EPOCH_MS + SEASON_MS;
    expect(taAcceptsWeek(1, start + 1000)).toBe(true);
    expect(taAcceptsWeek(0, start + 1000)).toBe(true);
    expect(taAcceptsWeek(0, start + TA_SUBMIT_GRACE_MS + 1)).toBe(false);
    expect(taAcceptsWeek(2, start + 1000)).toBe(false);
    expect(taAcceptsWeek(-5, start)).toBe(false);
  });

  it("のこり時間の言い方", () => {
    expect(taLeftText((3 * 24 + 4) * 3600_000 + 59_000)).toBe("3 日 4 時間");
    expect(taLeftText(5 * 3600_000 + 12 * 60_000)).toBe("5 時間 12 分");
    expect(taLeftText(12 * 60_000)).toBe("12 分");
    expect(taLeftText(-5)).toBe("0 分");
  });
});

describe("1 周の下限", () => {
  it("見本の車たちでは、一番上手いコンピューターより十分に下 (5〜8 割)", () => {
    for (const def of TRACK_DEFS) {
      const track = getTrack(def.id);
      for (const d of BOT_DESIGNS) {
        const stats = computeStats(d);
        const floor = taLapFloor(stats, track);
        const bench = benchLap(stats, track).lap!;
        expect(floor, `${def.id} ${d.name}`).toBeLessThan(bench * 0.8);
        expect(floor, `${def.id} ${d.name}`).toBeGreaterThan(bench * 0.5);
      }
    }
  });

  it("速すぎる・読めない・長すぎるタイムは断る", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const floor = taLapFloor(stats, track);
    expect(checkTaLap(floor + 0.01, stats, track)).toBeNull();
    expect(checkTaLap(floor - 0.01, stats, track)).toMatch(/出せない/);
    expect(checkTaLap(Number.NaN, stats, track)).not.toBeNull();
    expect(checkTaLap("30", stats, track)).not.toBeNull();
    expect(checkTaLap(1000, stats, track)).toMatch(/長すぎ/);
  });

  it("CPU の時間は短い (サーバーで毎回計算してよい)", () => {
    const track = getTrack("tsuzura");
    const stats = computeStats(SAMPLE_DESIGN);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) taLapFloor(stats, track);
    expect((Date.now() - t0) / 20).toBeLessThan(2);
  });
});

describe("幽霊の確かめ", () => {
  const track = getTrack("aozu");
  const stats = computeStats(SAMPLE_DESIGN);
  const real = botGhost(SAMPLE_DESIGN, track);

  it("本当に走った周は通る (両方のコース)", () => {
    expect(checkTaGhost(real.pts, real.lap, stats, track)).toBeNull();
    const t2 = getTrack("tsuzura");
    const g2 = botGhost(SAMPLE_DESIGN, t2);
    expect(checkTaGhost(g2.pts, g2.lap, stats, t2)).toBeNull();
    expect(checkTaSubmission({ lap: g2.lap, pts: g2.pts, design: SAMPLE_DESIGN }, stats, t2, { ...STARTER_BOX })).toBeNull();
  });

  it("タイムだけ縮めると点の数が合わない", () => {
    expect(checkTaGhost(real.pts, real.lap * 0.8, stats, track)).toMatch(/タイムと合いません/);
  });

  it("点を間引いて速く見せると、速さの上限を超える", () => {
    const fast: number[] = [];
    for (let i = 0; i < real.pts.length / 3; i += 2) fast.push(real.pts[i * 3], real.pts[i * 3 + 1], real.pts[i * 3 + 2]);
    expect(checkTaGhost(fast, (fast.length / 3) * 0.1, stats, track)).toMatch(/速さ/);
  });

  it("コースから外れた点・半周だけ・途中から・読めない点は断る", () => {
    const off = real.pts.slice();
    off[300] += 80;
    expect(checkTaGhost(off, real.lap, stats, track)).not.toBeNull();
    const half = real.pts.slice(0, Math.floor(real.pts.length / 6) * 3);
    expect(checkTaGhost(half, (half.length / 3) * 0.1, stats, track)).not.toBeNull();
    const mid = real.pts.slice(30 * 3).concat(real.pts.slice(0, 30 * 3));
    expect(checkTaGhost(mid, real.lap, stats, track)).toMatch(/スタート/);
    expect(checkTaGhost([1, 2], 0.1, stats, track)).not.toBeNull();
    expect(checkTaGhost("x", 10, stats, track)).not.toBeNull();
    const nan = real.pts.slice();
    nan[10] = Number.NaN;
    expect(checkTaGhost(nan, real.lap, stats, track)).not.toBeNull();
  });

  it("その場で行ったり来たりしても 1 周にはならない", () => {
    const n = real.pts.length / 3;
    const back: number[] = [];
    const quarter = Math.floor(n / 4);
    for (let i = 0; i < n; i++) {
      const k = i % (2 * quarter);
      const j = k < quarter ? k : 2 * quarter - k;
      back.push(real.pts[j * 3], real.pts[j * 3 + 1], real.pts[j * 3 + 2]);
    }
    expect(checkTaGhost(back, real.lap, stats, track)).not.toBeNull();
  });

  it("CPU の時間は短い", () => {
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) checkTaGhost(real.pts, real.lap, stats, track);
    expect((Date.now() - t0) / 20).toBeLessThan(3);
  });
});

describe("設計図", () => {
  it("仕上がっていて持っている部品だけなら通る", () => {
    expect(checkTaDesign(SAMPLE_DESIGN, { ...STARTER_BOX })).toBeNull();
    expect(checkTaDesign(SAMPLE_DESIGN, null)).toBeNull();
  });
  it("持っていない部品・未完成・知らない部品は断る", () => {
    expect(checkTaDesign(SAMPLE_DESIGN, {})).toMatch(/持っていない/);
    expect(checkTaDesign({ name: "x", parts: SAMPLE_DESIGN.parts.filter((p) => p.id !== "seat") }, null)).toMatch(/仕上がって/);
    expect(checkTaDesign({ name: "x", parts: [...SAMPLE_DESIGN.parts, { id: "nope", c: 0, r: 0, rot: 0 }] }, null)).toMatch(/知らない/);
  });
  it("印は部品の並びだけで決まる (順と名前は見ない)", () => {
    const h = designHash(SAMPLE_DESIGN);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(designHash({ name: "別の名前", parts: [...SAMPLE_DESIGN.parts].reverse() })).toBe(h);
    expect(designHash(BOT_DESIGNS[1])).not.toBe(h);
  });
});

describe("順位", () => {
  it("速い順・同じタイムは同じ順位で、先に出した人が上", () => {
    const r = rankTa([
      { id: "c", lapMs: 33_000, at: 5 },
      { id: "a", lapMs: 32_100, at: 9 },
      { id: "b", lapMs: 33_000, at: 3 },
      { id: "d", lapMs: 34_000, at: 1 },
    ]);
    expect(r.map((e) => [e.id, e.rank])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 2],
      ["d", 4],
    ]);
    expect(taRankOf(0)).toBe(1);
    expect(taRankOf(3)).toBe(4);
  });
  it("ms に丸めて比べる (同じ ms は記録を更新しない)", () => {
    expect(taLapMs(32.1234)).toBe(32_123);
    expect(taImproves(32.1234, null)).toBe(true);
    expect(taImproves(32.1234, 32_123)).toBe(false);
    expect(taImproves(32.1, 32_123)).toBe(true);
  });
});

describe("幽霊を小さくする", () => {
  it("元に戻せて、JSON より小さい", () => {
    const g = botGhost(SAMPLE_DESIGN, getTrack("aozu"));
    const s = encodeGhost(g.pts);
    const back = decodeGhost(s)!;
    expect(back.length).toBe(g.pts.length);
    for (let i = 0; i < back.length; i++) expect(back[i]).toBeCloseTo(g.pts[i], 6);
    expect(s.length).toBeLessThan(JSON.stringify(g.pts).length / 2);
  });
  it("負の数・大きな跳び・空も戻る", () => {
    const pts = [-123.4, 5000.1, -3.14, 0, 0, 3.14, 99999.9, -99999.9, 0.01];
    expect(decodeGhost(encodeGhost(pts))).toEqual(pts);
    expect(decodeGhost(encodeGhost([]))).toEqual([]);
  });
  it("壊れた文字列・長すぎるものは null", () => {
    expect(decodeGhost("x")).toBeNull();
    expect(decodeGhost("g1.!!!")).toBeNull();
    expect(decodeGhost(42)).toBeNull();
    expect(decodeGhost("g1.gA")).toBeNull(); // 続きのある数で終わる
    expect(decodeGhost(encodeGhost(new Array(30).fill(1)), 9)).toBeNull();
  });
});

describe("幽霊の記録 (画面のこまごと → 0.1 秒の目盛り)", () => {
  it("こまの間隔がばらばらでも、点の数と位置が合い、確かめを通る", () => {
    const track = getTrack("aozu");
    const stats = computeStats(SAMPLE_DESIGN);
    const car = createCar(track, stats, 0, { tire: TA_CONDITIONS.tire, fuel: stats.fuelCap });
    car.started = true;
    const brain = makeBrain(() => 0.5, BOT_SKILL_MAX);
    const st = newLapState();
    const rec = new TaGhostRecorder();
    // 本当の位置 (刻みごと) を覚えておいて比べる
    const truth: Array<[number, number, number]> = [];
    let simT = 0;
    let frame = 0;
    let lastFrame = -Infinity;
    let pending: { start: number; time: number } | null = null;
    const ghosts: Array<{ lap: number; pts: number[]; start: number }> = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    while (ghosts.length < 2 && frame < 60 * 200) {
      // こまの時刻: 12〜30 ms のばらつき
      const t = (lastFrame === -Infinity ? 0 : lastFrame) + 0.012 + rnd() * 0.018;
      if (Number.isFinite(lastFrame)) rec.push(lastFrame, car.x, car.y, car.heading);
      lastFrame = t;
      if (pending && rec.lastT() >= pending.start + pending.time) {
        ghosts.push({ lap: pending.time, pts: rec.ghost(pending.start, pending.time), start: pending.start });
        rec.dropBefore(pending.start + pending.time - 1);
        pending = null;
      }
      while (simT + DT <= t) {
        const ev = stepCar(car, botInput(car, stats, track, brain, simT, [], 0), stats, track, DT, { damage: false });
        simT += DT;
        truth.push([simT, car.x, car.y]);
        const le = updateLaps(car, st, ev, simT, track.length, 9, false);
        if (le.lap) pending = { start: st.lapStart - le.lap.time, time: le.lap.time };
      }
      frame++;
    }
    expect(ghosts.length).toBe(2);
    for (const g of ghosts) {
      expect(g.pts.length / 3).toBe(Math.floor(g.lap / 0.1 + 1e-6) + 1);
      expect(checkTaGhost(g.pts, g.lap, stats, track)).toBeNull();
    }
    // 2 周目の点 k は、時刻 start + 0.1 k の本当の位置に近い (こまの遅れ 1 こま分まで)
    const g = ghosts[1];
    for (let k = 0; k < g.pts.length / 3; k += 37) {
      const tt = g.start + k * 0.1;
      const near = truth.reduce((a, b) => (Math.abs(b[0] - tt) < Math.abs(a[0] - tt) ? b : a));
      expect(Math.hypot(near[1] - g.pts[k * 3], near[2] - g.pts[k * 3 + 1])).toBeLessThan(2.5);
    }
  });
});
