import { describe, expect, it } from "vitest";
import {
  addRaceToTally, baseRacePoints, classRanking, closeSeason, DEFAULT_SEASON_RULES, isCpuOnlyRace, LOWEST_CLASS, moveCounts, newSeasonTally,
  playClassOf, racePointAwards, rankDrivers, rankTeams, registerTeam, SEASON_EPOCH_MS, SEASON_MS, seasonClockAt, seasonIndexAt, seasonWindow, standInDriverPoints,
  teamsInClass, type ClassId, type ClassTable, type CountedRace, type RaceCar, type SeasonTally,
} from "../src/season.ts";

const T0 = SEASON_EPOCH_MS + 3_600_000; // 季節 0 の中

/** チーム x の 2 台 = x1・x2 */
function car(driverId: string, teamId: string | null, pos: number, o: Partial<RaceCar> = {}): RaceCar {
  return { driverId, teamId, pos, finished: true, fastest: false, ...o };
}

/** 1 レース。点は台数で決まる (下から 2 台は 0) ので、8 台に足りなければ後ろを空き埋めのコンピューター (teamId null) で埋める */
function race(cars: RaceCar[], o: Partial<CountedRace> = {}): CountedRace {
  const all = [...cars];
  for (let k = all.length; k < 8; k++) all.push(car(`fill${k}`, null, k + 1));
  return { raceId: "r", kind: "everyday", at: T0, cars: all, ...o };
}

describe("季節の時間", () => {
  it("1 週間ごとに番号が上がる", () => {
    expect(seasonIndexAt(SEASON_EPOCH_MS)).toBe(0);
    expect(seasonIndexAt(SEASON_EPOCH_MS + SEASON_MS - 1)).toBe(0);
    expect(seasonIndexAt(SEASON_EPOCH_MS + SEASON_MS)).toBe(1);
    expect(seasonIndexAt(SEASON_EPOCH_MS - 1)).toBe(-1);
    expect(SEASON_MS).toBe(7 * 24 * 3_600_000);
    const w = seasonWindow(3);
    expect(w.endsAt - w.startsAt).toBe(SEASON_MS);
    expect(seasonIndexAt(w.startsAt)).toBe(3);
  });
  it("季節 0 は日本時間の月曜 0:00 に始まる", () => {
    const d = new Date(SEASON_EPOCH_MS + 9 * 3_600_000);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
  });
  it("SeasonClock の形を作れる", () => {
    const c = seasonClockAt(SEASON_EPOCH_MS + SEASON_MS + 5);
    expect(c).toEqual({ index: 1, startMs: SEASON_EPOCH_MS + SEASON_MS, endMs: SEASON_EPOCH_MS + 2 * SEASON_MS });
  });
});

describe("1 レースの点", () => {
  it("F1 の点 + 最速の周。ゴールしていない・失格は 0", () => {
    expect(baseRacePoints(car("a", "A", 1))).toBe(25);
    expect(baseRacePoints(car("a", "A", 1, { fastest: true }))).toBe(26);
    expect(baseRacePoints(car("a", "A", 2, { fastest: true }))).toBe(19);
    expect(baseRacePoints(car("a", "A", 6))).toBe(8);
    // 8 台なら下から 2 台 (7 位・8 位) は 0。最速の周の 1 点も点のある車だけ
    expect(baseRacePoints(car("a", "A", 7))).toBe(0);
    expect(baseRacePoints(car("a", "A", 7, { fastest: true }))).toBe(0);
    expect(baseRacePoints(car("a", "A", 8))).toBe(0);
    expect(baseRacePoints(car("a", "A", 9))).toBe(0);
    // 台数が少なければ間が短くなる: 4 台なら 2 位まで、3 台なら 1 位だけ
    expect(baseRacePoints(car("a", "A", 2), 4)).toBe(18);
    expect(baseRacePoints(car("a", "A", 2), 3)).toBe(0);
    expect(baseRacePoints(car("a", "A", 1, { finished: false, fastest: true }))).toBe(0);
    expect(baseRacePoints(car("a", "A", 1, { dq: true }))).toBe(0);
  });
  it("人のチームが 1 つだけならコンピューターだけのレース (2 台目は同じチーム)", () => {
    expect(isCpuOnlyRace([car("a1", "A", 1), car("a2", "A", 2), car("c", null, 3)])).toBe(true);
    expect(isCpuOnlyRace([car("a1", "A", 1), car("b1", "B", 2)])).toBe(false);
  });
  it("大会は普段の 10 倍、コンピューターだけは半分", () => {
    const two = [car("a1", "A", 1, { fastest: true }), car("b1", "B", 2), car("c", null, 3)];
    expect(racePointAwards(race(two)).map((a) => a.points)).toEqual([26, 18]);
    expect(racePointAwards(race(two, { kind: "tournament" })).map((a) => a.points)).toEqual([260, 180]);
    const solo = [car("a1", "A", 1), car("a2", "A", 2), car("c", null, 3)];
    expect(racePointAwards(race(solo)).map((a) => a.points)).toEqual([13, 9]);
    // 空き埋めのコンピューターには点が付かない
    expect(racePointAwards(race(solo)).some((a) => a.driverId === "c")).toBe(false);
  });
});

describe("季節の集計と順位", () => {
  it("チームは 2 台の合計、運転手は自分の点だけ", () => {
    let t = newSeasonTally(0);
    t = addRaceToTally(t, race([car("a1", "A", 1), car("b1", "B", 2), car("a2", "A", 3), car("b2", "B", 4)]));
    expect(t.teams.A.points).toBe(25 + 15);
    expect(t.teams.B.points).toBe(18 + 12);
    expect(t.teams.A.races).toBe(1);
    expect(t.drivers.a2.points).toBe(15);
    expect(rankTeams(t).map((r) => r.id)).toEqual(["A", "B"]);
    expect(rankDrivers(t).map((r) => r.id)).toEqual(["a1", "b1", "a2", "b2"]);
  });
  it("元の集計は変えない・季節の外のレースは足さない", () => {
    const t0 = newSeasonTally(0);
    const t1 = addRaceToTally(t0, race([car("a1", "A", 1), car("b1", "B", 2)]));
    expect(t0.teams).toEqual({});
    const t2 = addRaceToTally(t1, race([car("a1", "A", 1), car("b1", "B", 2)], { at: SEASON_EPOCH_MS + SEASON_MS }));
    expect(t2).toBe(t1);
    expect(t1.teams.A.points).toBe(25);
  });
  it("同点は 大会の点 → 1 位の数 → 先に着いた → id の順", () => {
    let t = newSeasonTally(0);
    t = addRaceToTally(t, race([car("a1", "A", 1), car("b1", "B", 2), car("x1", "X", 3)], { kind: "tournament" })); // A 250, B 180
    t = addRaceToTally(t, race([car("b1", "B", 1, { fastest: true }), car("z1", "Z", 2)])); // B +26 = 206
    // 点が同じチームの並び (Q は大会の点、P は 1 位の数、S・U・R は先に着いた順 → id)
    const same: SeasonTally = {
      season: 0,
      drivers: {},
      teams: {
        P: { points: 50, tournamentPoints: 0, races: 2, finishes: [2, 0, 0, 0, 0, 0, 0, 0], lastGainAt: 10 },
        Q: { points: 50, tournamentPoints: 50, races: 1, finishes: [0, 0, 0, 0, 0, 0, 0, 0], lastGainAt: 20 },
        R: { points: 50, tournamentPoints: 0, races: 2, finishes: [1, 1, 0, 0, 0, 0, 0, 0], lastGainAt: 5 },
        S: { points: 50, tournamentPoints: 0, races: 2, finishes: [1, 1, 0, 0, 0, 0, 0, 0], lastGainAt: 1 },
        U: { points: 50, tournamentPoints: 0, races: 2, finishes: [1, 1, 0, 0, 0, 0, 0, 0], lastGainAt: 1 },
      },
    };
    expect(rankTeams(same).map((r) => r.id)).toEqual(["Q", "P", "S", "U", "R"]);
    expect(rankTeams(t, ["A", "B", "new"]).map((r) => [r.id, r.rank])).toEqual([
      ["A", 1],
      ["B", 2],
      ["new", 3],
    ]);
  });
  it("大会 1 回の重さ: 普段のレースで 10 回勝つのと大会 1 回の優勝が同じ", () => {
    let t = newSeasonTally(0);
    for (let i = 0; i < 10; i++) t = addRaceToTally(t, race([car("a1", "A", 1), car("b1", "B", 2)], { raceId: `e${i}`, at: T0 + i }));
    t = addRaceToTally(t, race([car("b1", "B", 1), car("a1", "A", 2)], { kind: "tournament", at: T0 + 100 }));
    expect(t.teams.A.points).toBe(250 + 180);
    expect(t.teams.B.points).toBe(180 + 250);
    // 同点なら大会の点が多い B が上
    expect(rankTeams(t)[0].id).toBe("B");
    expect(DEFAULT_SEASON_RULES.tournamentMul / DEFAULT_SEASON_RULES.everydayMul).toBe(10);
  });
});

describe("代走", () => {
  it("普段のレースの代走の点はチームに全部入り、運転手には入らない", () => {
    let t = newSeasonTally(0);
    t = addRaceToTally(t, race([car("a1", "A", 1, { standIn: true, fastest: true }), car("b1", "B", 2), car("a2", "A", 3), car("b2", "B", 4)]));
    expect(t.teams.A.points).toBe(26 + 15);
    expect(t.drivers.a1).toBeUndefined();
    expect(t.drivers.a2.points).toBe(15);
    expect(rankDrivers(t).map((r) => r.id)).toEqual(["b1", "a2", "b2"]);
    // 運転手順位に名前を入れて呼ぶと 0 点で一番下
    expect(rankDrivers(t, ["a1", "b1"]).map((r) => [r.id, r.points])).toEqual([
      ["b1", 18],
      ["a1", 0],
    ]);
    expect(racePointAwards(race([car("a1", "A", 1, { standIn: true })]))[0].standIn).toBe(true);
  });
  it("大会の代走: チームには全部、運転手には 1/5 (切り捨て) × 10。1 位の数には数えない (11/25 ユーザー)", () => {
    expect(standInDriverPoints("tournament", 25, 10)).toBe(50);
    expect(standInDriverPoints("tournament", 18, 10)).toBe(30);
    expect(standInDriverPoints("tournament", 4, 10)).toBe(0);
    expect(standInDriverPoints("tournament", 26, 10)).toBe(50);
    expect(standInDriverPoints("everyday", 25, 1)).toBeNull();
    let t = newSeasonTally(0);
    t = addRaceToTally(
      t,
      race([car("a1", "A", 1, { standIn: true, fastest: true }), car("b1", "B", 2), car("a2", "A", 3), car("b2", "B", 4, { standIn: true })], { kind: "tournament" }),
    );
    // チーム: 代走も全部 (26 + 15) × 10
    expect(t.teams.A.points).toBe(260 + 150);
    expect(t.teams.B.points).toBe(180 + 120);
    // 運転手: a1 は 26 → 5 → 50、b2 は 12 → 2 → 20
    expect(t.drivers.a1).toMatchObject({ points: 50, tournamentPoints: 50, races: 1 });
    expect(t.drivers.a1.finishes[0]).toBe(0);
    expect(t.drivers.b2.points).toBe(20);
    expect(t.drivers.a2.points).toBe(150);
    expect(rankDrivers(t).map((r) => [r.id, r.points])).toEqual([
      ["b1", 180],
      ["a2", 150],
      ["a1", 50],
      ["b2", 20],
    ]);
    const aw = racePointAwards(race([car("a1", "A", 4, { standIn: true }), car("x", "A", 1, { filler: true })], { kind: "tournament" }));
    expect(aw.map((a) => [a.driverId, a.points, a.driverPoints])).toEqual([
      ["a1", 120, 20],
      ["x", 250, null],
    ]);
    // 埋め草の車 (運転手なし) は運転手順位に入らない
    t = addRaceToTally(newSeasonTally(0), race([car("x", "A", 1, { filler: true })], { kind: "tournament" }));
    expect(t.drivers.x).toBeUndefined();
    expect(t.teams.A.points).toBe(250);
  });
  it("代走で走った次のレースで自分が走れば、運転手の点はそこから入る", () => {
    let t = newSeasonTally(0);
    t = addRaceToTally(t, race([car("a1", "A", 1, { standIn: true }), car("b1", "B", 2)], { raceId: "1" }));
    t = addRaceToTally(t, race([car("a1", "A", 2), car("b1", "B", 1)], { raceId: "2", at: T0 + 1 }));
    expect(t.drivers.a1.points).toBe(18);
    expect(t.drivers.a1.races).toBe(1);
    expect(t.teams.A.points).toBe(25 + 18);
    expect(t.teams.A.races).toBe(2);
  });
});

describe("級と上がり下がり", () => {
  it("級なしは一番下で走る", () => {
    let table: ClassTable = { A: 2 };
    table = registerTeam(table, "N");
    expect(table.N).toBeNull();
    expect(registerTeam(table, "A")).toBe(table);
    expect(playClassOf(table, "N")).toBe(LOWEST_CLASS);
    expect(playClassOf(table, "unknown")).toBe(LOWEST_CLASS);
    expect(playClassOf(table, "A")).toBe(2);
  });
  it("上がるのは 1 位の 1 チーム、下がるのは最下位の 1 チーム。1 チームだけの級はそのチームが上がる", () => {
    expect(moveCounts(3, 10)).toEqual({ up: 1, down: 1 });
    expect(moveCounts(1, 10)).toEqual({ up: 0, down: 1 });
    expect(moveCounts(5, 10)).toEqual({ up: 1, down: 0 });
    expect(moveCounts(3, 2)).toEqual({ up: 1, down: 1 });
    expect(moveCounts(3, 1)).toEqual({ up: 1, down: 0 });
    expect(moveCounts(3, 0)).toEqual({ up: 0, down: 0 });
  });
  it("1 位が上へ、最下位が下へ。級なしは一番下の順位に混ざる", () => {
    const table: ClassTable = {};
    const ids: Record<number, string[]> = {};
    for (const c of [1, 2, 3, 4, 5] as ClassId[]) {
      ids[c] = [];
      for (let i = 0; i < 8; i++) {
        const id = `c${c}t${i}`;
        table[id] = c;
        ids[c].push(id);
      }
    }
    table.newbie = null;
    table.lazy = null;
    let t = newSeasonTally(0);
    // 各級で t0 が一番、t7 が一番下になるよう点を付ける
    let at = T0;
    for (const c of [1, 2, 3, 4, 5] as ClassId[]) {
      ids[c].forEach((id, i) => {
        for (let k = 0; k < 8 - i; k++) t = addRaceToTally(t, race([car(`${id}d`, id, 1), car("x", "other", 2)], { raceId: `${id}-${k}`, at: at++ }));
      });
    }
    // 新しいチームが一番下の級で 1 番の成績
    for (let k = 0; k < 20; k++) t = addRaceToTally(t, race([car("nd", "newbie", 1), car("x", "other", 2)], { at: at++ }));
    expect(teamsInClass(table, 5)).toContain("newbie");
    expect(classRanking(table, t, 5)[0].id).toBe("newbie");
    const close = closeSeason(table, t);
    expect(close.next.c1t0).toBe(1);
    expect(close.next.c1t7).toBe(2);
    expect(close.next.c1t6).toBe(1);
    expect(close.next.c3t0).toBe(2);
    expect(close.next.c3t1).toBe(3);
    expect(close.next.c3t6).toBe(3);
    expect(close.next.c3t7).toBe(4);
    expect(close.next.c5t7).toBe(5);
    // 新しいチーム: 一番下の級の 1 位なら 4 級、そうでなければ 5 級
    expect(close.next.newbie).toBe(4);
    expect(close.next.lazy).toBe(5);
    expect(close.moves).toContainEqual({ teamId: "newbie", from: null, to: 4 });
    expect(close.moves).toContainEqual({ teamId: "lazy", from: null, to: 5 });
    // 2〜5 級で 1 つずつ上がる (5 級の 1 つは級なしの newbie なので from = null)
    expect(close.moves.filter((m) => m.from !== null && m.to < m.from)).toHaveLength(1 * 4 - 1);
    // 全員に級が付く・点は 0 から
    expect(Object.values(close.next).every((c) => c !== null)).toBe(true);
    expect(close.nextTally).toEqual(newSeasonTally(1));
    expect(close.rankings[1]).toHaveLength(8);
    expect(close.rankings[5]).toHaveLength(10);
  });
  it("同じ入力なら同じ結果 (決まった並べ方)", () => {
    const table: ClassTable = { b: 3, a: 3, c: 3, d: 3, e: 3, f: 3 };
    const t = newSeasonTally(0);
    const x = closeSeason(table, t);
    const y = closeSeason({ f: 3, e: 3, d: 3, c: 3, b: 3, a: 3 }, t);
    expect(x.next).toEqual(y.next);
    // 全員 0 点なら id 順: a が上へ、f が下へ、ほかは残る
    expect([x.next.a, x.next.b, x.next.e, x.next.f]).toEqual([2, 3, 3, 4]);
  });
});
