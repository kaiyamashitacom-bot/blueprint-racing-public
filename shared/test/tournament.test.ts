import { describe, expect, it } from "vitest";
import { addRaceToTally, newSeasonTally, SEASON_EPOCH_MS } from "../src/season.ts";
import {
  advanceStint, checkDryTireRule, classifyTournament, DRY_ROAD_MAX_WET, qualifyingTable, qualifyWindow, startStint, tournamentDayStart, tournamentGrid,
  tournamentPhaseAt, tournamentWeatherPlan, validateTournament, type QualifyAttempt, type Stint, type TournamentCarResult, type TournamentSpec,
} from "../src/tournament.ts";

const H = 3_600_000;
// 季節 0 の土曜 20:00 日本時間 (= 11:00 UTC)
const START = SEASON_EPOCH_MS + 5 * 24 * H + 20 * H;
const spec: TournamentSpec = {
  id: "t1",
  name: "土曜の大会",
  createdAt: SEASON_EPOCH_MS + 2 * H,
  startsAt: START,
  trackId: "aozu",
  laps: 12,
  weather: { mode: "fixed", sky: "sun" },
};

describe("大会を組む", () => {
  it("正しい大会は問題なし", () => {
    expect(validateTournament(spec, spec.createdAt, ["aozu"])).toEqual([]);
  });
  it("おかしなところを全部返す", () => {
    const bad: TournamentSpec = { ...spec, name: " ", trackId: "x", laps: 0, weather: { mode: "fixed", sky: "snow" as never } };
    expect(validateTournament(bad, spec.createdAt, ["aozu"])).toEqual(["name", "track", "laps", "weather"]);
    expect(validateTournament(spec, START + 1)).toContain("past");
    // 大会の日の 0:00 の直前に組むと、予選の時間が足りない
    expect(validateTournament({ ...spec, createdAt: tournamentDayStart(START) - H }, spec.createdAt)).toEqual(["no_qualifying_window"]);
  });
  it("予選は大会の前の日の終わり (日本時間 0:00) で締まる", () => {
    const { opensAt, closesAt } = qualifyWindow(spec);
    expect(opensAt).toBe(spec.createdAt);
    expect(closesAt).toBe(START - 20 * H);
    // 大会が 0:30 でも、その日の 0:00 で締まる
    expect(tournamentDayStart(SEASON_EPOCH_MS + 30 * 60_000)).toBe(SEASON_EPOCH_MS);
    expect(tournamentPhaseAt(spec, closesAt - 1)).toBe("qualifying");
    expect(tournamentPhaseAt(spec, closesAt)).toBe("grid_set");
    expect(tournamentPhaseAt(spec, START)).toBe("started");
  });
  it("天気: 決めた空か、seed のおまかせ", () => {
    const fixed = tournamentWeatherPlan({ ...spec, weather: { mode: "fixed", sky: "heavy" } }, 600);
    expect(fixed.changes).toEqual([{ at: 0, sky: "heavy" }]);
    expect(fixed.startWet).toBeGreaterThan(0.9);
    const r1 = tournamentWeatherPlan({ ...spec, weather: { mode: "random", seed: 9 } }, 600);
    expect(tournamentWeatherPlan({ ...spec, weather: { mode: "random", seed: 9 } }, 600)).toEqual(r1);
    expect(tournamentWeatherPlan({ ...spec, weather: { mode: "random", seed: 9, startSky: "light" } }, 600).changes[0].sky).toBe("light");
  });
});

describe("予選と並び", () => {
  const { closesAt } = qualifyWindow(spec);
  const att = (driverId: string, lapTime: number, at: number, valid = true): QualifyAttempt => ({ driverId, teamId: driverId.toUpperCase(), lapTime, at, valid });
  const attempts = [
    att("a", 40, spec.createdAt + 10),
    att("a", 38.5, spec.createdAt + 20),
    att("b", 38.5, spec.createdAt + 15),
    att("c", 37, spec.createdAt + 30, false), // 近道で数えない
    att("c", 39, spec.createdAt + 31),
    att("d", 30, closesAt), // 締め切りのあと
    att("e", 30, spec.createdAt - 1), // 開く前
  ];
  it("運転手ごとの一番速い、数える記録。同じ時間なら先に出したほう", () => {
    expect(qualifyingTable(spec, attempts).map((r) => [r.driverId, r.lapTime])).toEqual([
      ["b", 38.5],
      ["a", 38.5],
      ["c", 39],
    ]);
  });
  it("記録の無い出場者は後ろ、入りきらない分は控え", () => {
    const { grid, reserves } = tournamentGrid(spec, attempts, [
      { driverId: "z", teamId: "Z" },
      { driverId: "h", teamId: "A" },
      { driverId: "a", teamId: "A" },
    ]);
    expect(grid.map((g) => [g.driverId, g.slot, g.lapTime])).toEqual([
      ["b", 0, 38.5],
      ["a", 1, 38.5],
      ["c", 2, 39],
      ["h", 3, null],
      ["z", 4, null],
    ]);
    expect(reserves).toEqual([]);
    // 強さを渡すと: 記録の無い車は 強い (見込みの周が速い) 車ほど後ろ。同じならチーム id → 運転手 id。見込みの無い車は一番前
    const st = tournamentGrid(
      spec,
      attempts,
      [
        { driverId: "w1", teamId: "W" },
        { driverId: "s1", teamId: "S" },
        { driverId: "m1", teamId: "M" },
        { driverId: "m2", teamId: "L" },
        { driverId: "n1", teamId: "N" },
      ],
      99,
      new Map([
        ["w1", 41],
        ["s1", 35],
        ["m1", 38],
        ["m2", 38],
        ["a", 1], // 記録のある車は記録の順のまま
      ]),
    );
    expect(st.grid.map((g) => g.driverId)).toEqual(["b", "a", "c", "n1", "w1", "m2", "m1", "s1"]);
    const small = tournamentGrid(spec, attempts, [], 2);
    expect(small.grid.map((g) => g.driverId)).toEqual(["b", "a"]);
    expect(small.reserves.map((g) => [g.driverId, g.slot])).toEqual([["c", 2]]);
  });
});

describe("予選の締め切り", () => {
  it("qualifyClosesAt があればそこまで (スタートより後にはしない)", () => {
    expect(qualifyWindow({ ...spec, qualifyClosesAt: START - H / 2 }).closesAt).toBe(START - H / 2);
    expect(qualifyWindow({ ...spec, qualifyClosesAt: START + H }).closesAt).toBe(START);
    expect(tournamentPhaseAt({ ...spec, qualifyClosesAt: START - H / 2 }, START - H)).toBe("qualifying");
    expect(tournamentPhaseAt({ ...spec, qualifyClosesAt: START - H / 2 }, START - H / 4)).toBe("grid_set");
    expect(validateTournament({ ...spec, grade: "特" as never }, spec.createdAt, ["aozu"])).toEqual(["grade"]);
  });
});

describe("タイヤの決まり", () => {
  const st = (tire: Stint["tire"], meters: number, dry = true): Stint => ({ tire, meters, dry });
  it("乾いた路面で 1 種類だけは失格", () => {
    expect(checkDryTireRule([st("M", 5000)])).toEqual({ applies: true, ok: false, dryCompounds: ["M"] });
    // 同じ種類に替えても 1 種類
    expect(checkDryTireRule([st("M", 2000), st("M", 3000)]).ok).toBe(false);
  });
  it("乾いた路面用を 2 種類使えばよい", () => {
    expect(checkDryTireRule([st("S", 2000), st("H", 3000)])).toEqual({ applies: true, ok: true, dryCompounds: ["H", "S"] });
  });
  it("雨用は乾いた路面用に数えない", () => {
    expect(checkDryTireRule([st("M", 2000), st("I", 3000)]).ok).toBe(false);
  });
  it("一度でも濡れた路面を走ったら当てはまらない", () => {
    expect(checkDryTireRule([st("M", 2000), st("I", 3000, false)])).toMatchObject({ applies: false, ok: true });
    expect(checkDryTireRule([st("M", 5000, false)])).toMatchObject({ applies: false, ok: true });
  });
  it("0 m の区間は数えない", () => {
    expect(checkDryTireRule([st("M", 5000), st("S", 0)]).ok).toBe(false);
    expect(checkDryTireRule([]).applies).toBe(false);
  });
  it("区間の記録を作る関数", () => {
    let s = startStint([], "M", 0);
    s = advanceStint(s, 1000, 0);
    s = advanceStint(s, 500, 0.05);
    s = startStint(s, "S", 0);
    s = advanceStint(s, 800, DRY_ROAD_MAX_WET); // ここで濡れた
    expect(s).toEqual([
      { tire: "M", meters: 1500, dry: true },
      { tire: "S", meters: 800, dry: false },
    ]);
    expect(advanceStint([], 10, 0)).toEqual([]);
    expect(checkDryTireRule(s).applies).toBe(false);
  });
});

describe("大会の結果", () => {
  const dry2: Stint[] = [
    { tire: "S", meters: 3000, dry: true },
    { tire: "M", meters: 3000, dry: true },
  ];
  const dry1: Stint[] = [{ tire: "M", meters: 6000, dry: true }];
  const res = (driverId: string, teamId: string | null, pos: number, best: number | null, stints: Stint[], o: Partial<TournamentCarResult> = {}): TournamentCarResult => ({
    driverId,
    teamId,
    pos,
    finished: true,
    best,
    stints,
    ...o,
  });
  it("決まりを破った車は失格で後ろへ、ほかは詰める。最速の周は選び直す", () => {
    const { cars, race } = classifyTournament(
      spec,
      [res("a1", "A", 1, 36, dry1), res("b1", "B", 2, 37, dry2), res("c", null, 3, 38, dry2), res("a2", "A", 4, 39, dry2, { finished: false }), res("b2", "B", 5, 40, dry1, { finished: false })],
      START + H,
    );
    expect(cars.map((c) => [c.driverId, c.finalPos, c.dq, c.fastest])).toEqual([
      ["b1", 1, false, true],
      ["c", 2, false, false],
      ["a2", 3, false, false],
      // 走り終えていない車には決まりを当てない
      ["b2", 4, false, false],
      ["a1", 5, true, false],
    ]);
    expect(race.kind).toBe("tournament");
    expect(race.raceId).toBe("tournament-t1");
    let t = newSeasonTally(0);
    t = addRaceToTally(t, race);
    expect(t.teams.B.points).toBe((25 + 1) * 10);
    expect(t.teams.A.points).toBe(0);
  });
  it("雨の大会は 1 種類でもよい", () => {
    const wet: Stint[] = [{ tire: "I", meters: 6000, dry: false }];
    const { cars } = classifyTournament(spec, [res("a1", "A", 1, 40, wet), res("b1", "B", 2, 39, dry2)], START + H);
    expect(cars.map((c) => [c.driverId, c.dq, c.fastest])).toEqual([
      ["a1", false, false],
      ["b1", false, true],
    ]);
  });
  it("代走の印は季節の点に渡る (チームに全部、運転手に 1/5 切り捨て × 10)", () => {
    const { race } = classifyTournament(spec, [res("a1", "A", 1, 40, dry2, { standIn: true }), res("b1", "B", 2, 41, dry2)], START + H);
    expect(race.cars[0].standIn).toBe(true);
    const t = addRaceToTally(newSeasonTally(0), race);
    expect(t.teams.A.points).toBe(260);
    expect(t.drivers.a1.points).toBe(50);
  });
});
