import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECTOR_SPLITS,
  FLAG_SECTORS,
  SectorTimer,
  TRACK_DEFS,
  buildTrack,
  checkTrack,
  formatSector,
  getTrack,
  ghostProfile,
  ghostSectorTimes,
  idealLap,
  lapSectorAt,
  parseTrackDef,
  pointAt,
  sectorColor,
  sectorOf,
  sectorSplitDistances,
  sectorSplitProblem,
  sectorSplits,
  sessionBestSectors,
  type TrackDef,
} from "../src/index.ts";

/** 一定の速さ v (m/s) で from..to 秒を走った記録を渡す (start 秒に道のり d0) */
function drive(st: SectorTimer, v: number, from: number, to: number, d0 = 0, start = from, dt = 0.1) {
  const n = Math.round((to - from) / dt);
  for (let i = 0; i <= n; i++) {
    const t = from + i * dt;
    st.push(t, d0 + v * (t - start));
  }
}

describe("セクターの切れ目", () => {
  it("書かなければ 3 等分", () => {
    expect(sectorSplits({})).toEqual([1 / 3, 2 / 3]);
    expect(DEFAULT_SECTOR_SPLITS).toEqual([1 / 3, 2 / 3]);
  });

  it("おかしい切れ目は 3 等分に戻す", () => {
    expect(sectorSplits({ sectors: [0.6, 0.3] })).toEqual([1 / 3, 2 / 3]);
    expect(sectorSplits({ sectors: [0.3, 0.35] })).toEqual([1 / 3, 2 / 3]);
    expect(sectorSplits({ sectors: [0.3, 0.6] })).toEqual([0.3, 0.6]);
  });

  it("問題の文: 数・順・10% 以上", () => {
    expect(sectorSplitProblem([0.3, 0.6])).toBeNull();
    expect(sectorSplitProblem([0.1, 0.9])).toBeNull();
    expect(sectorSplitProblem([0.3])).not.toBeNull();
    expect(sectorSplitProblem([0.6, 0.3])).not.toBeNull();
    expect(sectorSplitProblem([0.05, 0.5])).not.toBeNull();
    expect(sectorSplitProblem([0.5, 0.95])).not.toBeNull();
    expect(sectorSplitProblem([0.4, 0.45])).not.toBeNull();
    expect(sectorSplitProblem([Number.NaN, 0.5])).not.toBeNull();
    expect(sectorSplitProblem("x")).not.toBeNull();
  });

  it("道のりからセクター (周をまたいでも)", () => {
    const t = getTrack("aozu");
    const [a, b] = sectorSplitDistances(t);
    expect(lapSectorAt(t, 0)).toBe(0);
    expect(lapSectorAt(t, a - 1)).toBe(0);
    expect(lapSectorAt(t, a + 1)).toBe(1);
    expect(lapSectorAt(t, b + 1)).toBe(2);
    expect(lapSectorAt(t, t.length - 1)).toBe(2);
    expect(lapSectorAt(t, t.length + a + 1)).toBe(1);
    expect(lapSectorAt(t, -1)).toBe(2);
  });

  it("旗の区間 (10 区間) とは別", () => {
    const t = getTrack("aozu");
    expect(FLAG_SECTORS).toBe(10);
    // 旗の区間は 10 等分のまま (コースの sectors に関係なし)
    expect(sectorOf(t, t.length * 0.55)).toBe(5);
  });

  it("公式コースの切れ目は決まりに合う (青図とつづら坂は決めてある。書いていないコースは 3 等分)", () => {
    for (const id of ["aozu", "tsuzura"]) expect(TRACK_DEFS.find((d) => d.id === id)?.sectors, id).toBeDefined();
    for (const d of TRACK_DEFS) {
      if (d.sectors !== undefined) expect(sectorSplitProblem(d.sectors), d.id).toBeNull();
      expect(checkTrack(d).issues.filter((i) => i.code === "sectors"), d.id).toEqual([]);
    }
  });
});

describe("コースの確かめ (セクター)", () => {
  const base = (): TrackDef => ({ ...TRACK_DEFS[0], id: "", name: "セクターの試し" });

  it("書かなければ問題なし", () => {
    const d = base();
    delete d.sectors;
    expect(checkTrack(d).issues.filter((i) => i.code === "sectors")).toEqual([]);
  });

  it("順でない・短すぎるセクターは問題", () => {
    for (const s of [[0.6, 0.3], [0.05, 0.5], [0.5, 0.55], [0.3, 0.95], [0.5]]) {
      const c = checkTrack({ ...base(), sectors: s });
      const is = c.issues.filter((i) => i.code === "sectors");
      expect(is.length, JSON.stringify(s)).toBe(1);
      expect(is[0].at).toBeDefined();
      expect(c.ok).toBe(false);
    }
  });

  it("サーバーで読むと残る (割合は 1/1000 まで)", () => {
    const d = parseTrackDef({ ...base(), sectors: [0.33333, 0.7] });
    expect(d?.sectors).toEqual([0.333, 0.7]);
    expect(parseTrackDef({ ...base(), sectors: [0.3, "x"] })).toBeNull();
    expect(parseTrackDef({ ...base(), sectors: [0.3] })).toBeNull();
    expect(parseTrackDef({ ...base(), sectors: undefined })?.sectors).toBeUndefined();
  });
});

describe("SectorTimer", () => {
  const L = 1200;

  it("一定の速さ: 区間の長さ ÷ 速さ (切れ目は前後の記録の間を割る)", () => {
    const st = new SectorTimer(L, [0.25, 0.6], null);
    // 0.1 秒ごと、33 m/s (切れ目はちょうど記録の間に来る)
    drive(st, 33, 0, 80, 5);
    const lap0 = st.lap(0)!;
    // 道のり 5 から始めたので、1 周目の S1 は始まりが分からない
    expect(lap0.times[0]).toBeNull();
    expect(lap0.times[1]).toBeCloseTo((0.35 * L) / 33, 6);
    expect(lap0.times[2]).toBeCloseTo((0.4 * L) / 33, 6);
    const lap1 = st.lap(1)!;
    expect(lap1.times[0]).toBeCloseTo((0.25 * L) / 33, 6);
    expect(st.best[0]).toBeCloseTo((0.25 * L) / 33, 6);
    expect(st.ideal()).toBeCloseTo(L / 33, 6);
  });

  it("スタートの線の手前から: 1 周目の S1 は合図 (raceStart) から数え、3 つの合計 = 周の時間", () => {
    const st = new SectorTimer(L, [1 / 3, 2 / 3], 0);
    // 合図の前は止まっている
    st.push(-2, -30);
    st.push(-1, -30);
    // 合図から 30 m 手前を一定の速さ 40 m/s
    drive(st, 40, 0, 40, -30, 0);
    const l = st.lap(0)!;
    const lapTime = (L + 30) / 40;
    expect(l.times[0]! + l.times[1]! + l.times[2]!).toBeCloseTo(lapTime, 6);
    expect(l.times[0]).toBeCloseTo((L / 3 + 30) / 40, 6);
  });

  it("越えた切れ目を返す (周・セクター・タイム)", () => {
    const st = new SectorTimer(L, [0.5, 0.75], null);
    st.push(0, 0);
    const a = st.push(10, 610);
    expect(a.map((c) => [c.lap, c.sector])).toEqual([[0, 0]]);
    const t600 = (10 * 600) / 610;
    expect(a[0].at).toBeCloseTo(t600, 9);
    const b = st.push(20, 1210);
    expect(b.map((c) => [c.lap, c.sector])).toEqual([
      [0, 1],
      [0, 2],
    ]);
    const t900 = 10 + (10 * (900 - 610)) / 600;
    expect(b[0].time).toBeCloseTo(t900 - t600, 9);
  });

  it("最初の記録がちょうど切れ目の上なら、そこから数える", () => {
    const st = new SectorTimer(L, [0.5, 0.75], null);
    st.push(0, 0);
    const a = st.push(10, 700);
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ lap: 0, sector: 0 });
    expect(a[0].time).toBeCloseTo(600 / 70, 6);
  });

  it("止まったあとに走り出した: 止まっていた時間はその区間に入る", () => {
    const st = new SectorTimer(L, [0.5, 0.75], null);
    st.push(0, 0);
    st.push(5, 300);
    st.push(15, 300); // 10 秒止まる
    st.push(20, 900);
    // 300 → 600 の 300 m を 15 → 20 秒の割合で: 15 + 2.5 = 17.5 秒
    expect(st.lap(0)!.times[0]).toBeCloseTo(17.5, 6);
  });

  it("近道した周 (valid = false) は記録するが、自己ベストにしない", () => {
    const st = new SectorTimer(L, [1 / 3, 2 / 3], null);
    st.push(0, 0);
    st.push(10, 400, false);
    expect(st.lap(0)!.valid[0]).toBe(false);
    expect(st.lap(0)!.times[0]).toBeCloseTo(10, 6);
    expect(st.best[0]).toBeNull();
    st.push(20, 800, true);
    expect(st.best[1]).toBeCloseTo(10, 6);
    expect(st.toRecord()[0]).toEqual([null, 10, null]);
  });

  it("大きく飛んだ (つなぎ直し) 間の切れ目は分からない", () => {
    const st = new SectorTimer(L, [1 / 3, 2 / 3], null);
    st.push(0, 0);
    st.push(1, 30);
    st.push(2, 30 + L * 0.5); // 1 秒で 600 m 飛ぶ
    expect(st.lap(0)).toBeNull();
    st.push(10, 1000);
    // 2 つ目の切れ目 (800) は飛んだ間ではない: でも始まり (400) が分からないので S2 も分からない
    expect(st.lap(0)?.times[1] ?? null).toBeNull();
    st.push(20, 1300);
    expect(st.lap(0)!.times[2]).not.toBeNull();
  });

  it("今のセクター", () => {
    const st = new SectorTimer(L, [1 / 3, 2 / 3], 0);
    expect(st.current()).toBeNull();
    st.push(0, -20);
    expect(st.current()).toEqual({ lap: 0, sector: 0, start: 0 });
    st.push(10, 500);
    expect(st.current()).toMatchObject({ lap: 0, sector: 1 });
    st.push(30, 1300);
    expect(st.current()).toMatchObject({ lap: 1, sector: 0 });
  });

  it("自分の車の周の時間と、セクターの合計が合う (コースの上を走らせる)", () => {
    const t = getTrack("tsuzura");
    const st = new SectorTimer(t.length, sectorSplits(t.def), 0);
    // 合図の前に 50 m 手前・合図から 0.05 秒ごとに速さが変わる走り
    let d = -50;
    st.push(-1, d);
    let lapEnd = NaN;
    for (let k = 1; k <= 4000; k++) {
      const time = k * 0.05;
      const before = d;
      d += 0.05 * (25 + 15 * Math.sin(time * 0.7));
      st.push(time, d);
      if (before < t.length && d >= t.length) lapEnd = time - (0.05 * (d - t.length)) / (d - before);
    }
    const l = st.lap(0)!;
    expect(l.times.every((x) => x !== null)).toBe(true);
    expect(l.times[0]! + l.times[1]! + l.times[2]!).toBeCloseTo(lapEnd, 6);
  });
});

describe("色・一番速いセクター・理論上の一番速い周", () => {
  it("紫 = その場で一番・緑 = 自己ベスト・黄 = 遅い・灰 = 数えない", () => {
    expect(sectorColor(20, true, 20, 20)).toBe("purple");
    expect(sectorColor(20.0004, true, 20, 20)).toBe("purple");
    expect(sectorColor(21, true, 21, 20)).toBe("green");
    expect(sectorColor(21, true, null, 20)).toBe("green");
    expect(sectorColor(22, true, 21, 20)).toBe("yellow");
    expect(sectorColor(19, false, 21, 20)).toBe("void");
  });

  it("その場の一番は全員から (同じタイムなら先に並んだ車)", () => {
    const sb = sessionBestSectors([
      { id: "a", best: [20, 31, null] },
      { id: "b", best: [19.5, 31, 40] },
      { id: "c", best: [null, 30.9, 41] },
    ]);
    expect(sb[0]).toEqual({ time: 19.5, id: "b" });
    expect(sb[1]).toEqual({ time: 30.9, id: "c" });
    expect(sb[2]).toEqual({ time: 40, id: "b" });
    expect(sessionBestSectors([{ id: "a", best: [20, 20, 20] }, { id: "b", best: [20, 20, 20] }])[0]?.id).toBe("a");
    expect(sessionBestSectors([])).toEqual([null, null, null]);
  });

  it("理論上の一番速い周は 3 つそろったときだけ", () => {
    expect(idealLap([20, 30, 40])).toBe(90);
    expect(idealLap([20, null, 40])).toBeNull();
    expect(idealLap([])).toBeNull();
  });

  it("字", () => {
    expect(formatSector(23.4567)).toBe("23.457");
    expect(formatSector(62.5)).toBe("1:02.500");
    expect(formatSector(null)).toBe("--.---");
  });
});

describe("幽霊のセクター", () => {
  it("幽霊の記録から 3 つのタイム (合計 = 幽霊の周)", () => {
    const t = getTrack("aozu");
    const lap = 60;
    const pts: number[] = [];
    const n = 600;
    for (let i = 0; i < n; i++) {
      const p = pointAt(t, ((i + 1) / n) * t.length, 0);
      pts.push(p.x, p.y, p.heading);
    }
    const prof = ghostProfile(t, pts, lap)!;
    const g = ghostSectorTimes(prof, t);
    const [a, b] = sectorSplits(t.def);
    expect(g[0]).toBeCloseTo(a * lap, 0);
    expect(g[1]).toBeCloseTo((b - a) * lap, 0);
    expect(g[0]! + g[1]! + g[2]!).toBeCloseTo(lap, 6);
  });

  it("切れ目はコースの形の長さに合わせる (建て直しても同じ割合)", () => {
    const def = { ...TRACK_DEFS[0], sectors: [0.2, 0.7] };
    const t = buildTrack(def);
    expect(sectorSplitDistances(t)[0]).toBeCloseTo(0.2 * t.length, 6);
  });
});

describe("自分の車: 周の時間と合計が合う", () => {
  it("lineAtPush: スタートの線は越えた刻みの時刻 (updateLaps と同じ)", () => {
    const L = 1000;
    const st = new SectorTimer(L, [1 / 3, 2 / 3], 0, true);
    const dt = 1 / 60;
    let d = -20;
    let lapEnd = NaN;
    st.push(0, d);
    for (let k = 1; k < 60 * 60; k++) {
      const before = d;
      d += dt * 37.3;
      st.push(k * dt, d);
      if (before < L && d >= L) lapEnd = k * dt;
    }
    const l = st.lap(0)!;
    expect(l.times[0]! + l.times[1]! + l.times[2]!).toBeCloseTo(lapEnd, 9);
    const l1 = st.lap(1)!;
    expect(l1.times.every((x) => x !== null)).toBe(true);
  });
});
