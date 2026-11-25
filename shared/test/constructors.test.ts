import { describe, expect, it } from "vitest";
import { addLeagueDayToConstructors, constructorChampion, constructorStandings, constructorsByClass, constructorsOverall, DEFAULT_ADMIN_CONFIG, newSeasonTally, validateAdminConfig, type LeagueState } from "../src/index.ts";

const day = (div1: number, div8: number): LeagueState =>
  ({
    day: 0,
    leagues: [
      { id: "L1", division: 1, letter: "A", humans: ["top"], cpus: [] },
      { id: "L8", division: 8, letter: "A", humans: ["low"], cpus: [] },
    ],
    tally: {
      L1: { top: { points: div1, wins: 0, races: 12, lastAt: 0, lastPos: 1 } },
      L8: { low: { points: div8, wins: 0, races: 12, lastAt: 0, lastPos: 1 } },
    },
    weekBest: {},
    champion: null,
  }) as unknown as LeagueState;

describe("コンストラクター", () => {
  it("同じリーグ戦の点でも 1 部のほうが多く入る", () => {
    const acc = addLeagueDayToConstructors({}, day(100, 100));
    expect(acc.top).toBeCloseTo(100 * 0.1 * 2);
    expect(acc.low).toBeCloseTo(100 * 0.1 * 0.3);
  });
  it("毎日の分を季節の間 足していく", () => {
    let acc = addLeagueDayToConstructors({}, day(50, 0));
    acc = addLeagueDayToConstructors(acc, day(50, 0));
    expect(acc.top).toBeCloseTo(20);
    expect(acc.low).toBeUndefined();
  });
  it("本戦の点 + リーグ戦の分で並び、同点は本戦の点", () => {
    const st = newSeasonTally(0);
    st.teams.a = { points: 50, tournamentPoints: 0, races: 1, finishes: [], lastGainAt: 0 };
    st.teams.b = { points: 40, tournamentPoints: 0, races: 1, finishes: [], lastGainAt: 0 };
    const rows = constructorStandings(st, { a: 0, b: 10 });
    expect(rows.map((r) => [r.teamId, r.total])).toEqual([
      ["a", 50],
      ["b", 50],
    ]);
    expect(constructorChampion(rows)).toBe("a");
    expect(constructorChampion(constructorStandings(newSeasonTally(0), {}))).toBeNull();
  });
  it("管理者の数の確かめ", () => {
    expect(validateAdminConfig({ ...DEFAULT_ADMIN_CONFIG }).ok).toBe(true);
    expect(validateAdminConfig({ ...DEFAULT_ADMIN_CONFIG, constructorDivisionMul: [1, 2] }).ok).toBe(false);
  });
});

describe("級ごとと総合のコンストラクター", () => {
  const t = (points: number) => ({ points, tournamentPoints: 0, races: 1, finishes: [], lastGainAt: 0 });
  it("級ごとに 1 チーム (級なしは一番下の級)。賞金は上の級ほど多い。総合は全体で 1 チーム", () => {
    const st = newSeasonTally(0);
    st.teams.a = t(30);
    st.teams.b = t(20);
    st.teams.n = t(99);
    st.teams.cpu = t(999);
    const classes = { a: 1, b: 1, n: null } as const;
    const res = constructorsByClass(st, { b: 15 }, classes);
    expect(res.find((r) => r.cls === 1)?.champion).toBe("b");
    expect(res.find((r) => r.cls === 5)?.champion).toBe("n");
    expect(res.find((r) => r.cls === 3)?.champion).toBeNull();
    expect(res[0].prize).toBeGreaterThan(res[4].prize);
    const all = constructorsOverall(st, { b: 15 }, classes);
    expect(all.champion).toBe("n");
    expect(all.rows.map((r) => r.teamId)).not.toContain("cpu");
  });
});
