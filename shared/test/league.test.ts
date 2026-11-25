import { describe, expect, it } from "vitest";
import {
  activeLeagues, addLeagueRace, CHAMPION_TITLE, closeLeagueDay, divisionCpuStrength, divisionOf, divisionTitle, findLeagueOf, joinLeague, LEAGUE_CPUS, LEAGUE_PRIZE_RANKS, LEAGUE_TEAMS, leagueDayAt,
  leagueDayStart, leagueName, leagueStandings, leagueTeams, leaveLeague, newLeagueState, teamTitle, type League, type LeagueState,
} from "../src/league.ts";
import { SEASON_EPOCH_MS, type RaceCar } from "../src/season.ts";
import {
  nextScheduledAt, planScheduledRaces, scheduledQueue, skippedRecord, SCHEDULED_DROP_AFTER_SLOTS, scheduledEntries, scheduledResultsFor, scheduledSlotIndex, scheduledSlotStart, scheduledTrackId,
  shuffleBySeed, type ScheduledRacePlan,
} from "../src/scheduled.ts";
import { RIVAL } from "../src/rivals.ts";

/** リーグのレースの台数 (4 チーム × 2 台) */
const RACE_CARS = LEAGUE_TEAMS * 2;

const H = 3_600_000;
const DAY0 = leagueDayAt(SEASON_EPOCH_MS); // 季節 0 の月曜

function withTeams(n: number, day = DAY0): LeagueState {
  let s = newLeagueState(day);
  for (let i = 0; i < n; i++) s = joinLeague(s, `p${String(i).padStart(2, "0")}`);
  return s;
}

/** 手で作ったリーグの並び */
function manual(day: number, ls: { d: number; i?: number; humans: string[] }[]): LeagueState {
  let s = newLeagueState(day);
  const leagues: League[] = ls.map(({ d, i = 0, humans }) => ({
    id: `d${d}-${i}`,
    division: d,
    index: i,
    humans,
    cpus: Array.from({ length: LEAGUE_TEAMS - humans.length }, (_, k) => `d${d}-${i}-cpu${k}`),
    nextCpu: LEAGUE_TEAMS - humans.length,
  }));
  s = { ...s, leagues };
  return s;
}

/**
 * order の順に 1 位から並んだ 1 レース (各チーム 1 台ずつ)。
 * リーグのレースは 8 台 (4 チーム × 2 台) なので、8 台に足りなければ後ろを名前の無い空き埋め (teamId null) で埋める (点は台数で決まる: 下から 2 台は 0)
 */
function raceOf(order: string[]): RaceCar[] {
  const cars: RaceCar[] = order.map((t, i) => ({ driverId: `${t}#d${i}`, teamId: t, pos: i + 1, finished: true, fastest: false }));
  for (let k = cars.length; k < RACE_CARS; k++) cars.push({ driverId: `fill${k}`, teamId: null, pos: k + 1, finished: true, fastest: false });
  return cars;
}

const slot = (h: number, day = DAY0) => leagueDayStart(day) + h * H;

describe("肩書きと部", () => {
  it("8 部〜1 部の肩書き", () => {
    expect([8, 7, 6, 5, 4, 3, 2, 1].map(divisionTitle)).toEqual(["製図見習い", "製図工", "設計助手", "設計技師", "上級設計技師", "主任設計技師", "技術部長", "技術監督"]);
    expect(divisionTitle(0)).toBe("技術監督");
    expect(divisionTitle(12)).toBe("製図見習い");
  });
  it("上の部ほどコンピューターが強い", () => {
    const s8 = divisionCpuStrength(8);
    const s1 = divisionCpuStrength(1);
    expect(s1.skillMin).toBeGreaterThan(s8.skillMin);
    expect(s1.partTier).toBeGreaterThan(s8.partTier);
    expect(s1.skillMax).toBeLessThanOrEqual(1);
  });
  it("名前: 8 部、8 部 B", () => {
    expect(leagueName({ division: 8, index: 0 })).toBe("8 部");
    expect(leagueName({ division: 8, index: 1 })).toBe("8 部 B");
  });
  it("日の切れ目は日本時間 0:00", () => {
    expect(leagueDayStart(DAY0)).toBe(SEASON_EPOCH_MS);
    expect(leagueDayAt(SEASON_EPOCH_MS - 1)).toBe(DAY0 - 1);
    expect(leagueDayAt(SEASON_EPOCH_MS + 22 * H + 30 * 60_000)).toBe(DAY0);
  });
});

describe("リーグに入る・出る", () => {
  it("新しい人は 8 部。1 リーグ 4 チーム = 人 2 + コンピューター 2、足りなければ 8 部 B", () => {
    expect(LEAGUE_TEAMS).toBe(4);
    expect(LEAGUE_CPUS).toBe(2);
    // ライバルのチームの数はリーグのコンピューターの数と同じ
    expect(RIVAL.perLeague).toBe(LEAGUE_CPUS);
    let s = withTeams(1);
    expect(s.leagues).toHaveLength(1);
    expect(s.leagues[0].humans).toEqual(["p00"]);
    expect(s.leagues[0].cpus).toHaveLength(3);
    s = joinLeague(s, "p01");
    expect(s.leagues[0].cpus).toHaveLength(2);
    // 先にいたコンピューターのチームは残る (後から入ったほうから抜ける)
    expect(s.leagues[0].cpus).toEqual(["d8-0-cpu0", "d8-0-cpu1"]);
    s = joinLeague(s, "p02");
    expect(s.leagues.map((l) => [l.id, l.humans.length])).toEqual([
      ["d8-0", 2],
      ["d8-1", 1],
    ]);
    expect(joinLeague(s, "p02")).toBe(s);
    expect(divisionOf(s, "p02")).toBe(8);
    expect(teamTitle(s, "p02")).toBe("製図見習い");
    expect(teamTitle(s, "nobody")).toBeNull();
    expect(leagueTeams(s.leagues[0])).toHaveLength(LEAGUE_TEAMS);
  });
  it("人の空きがある一番下の部に入る", () => {
    const s = manual(DAY0, [
      { d: 8, humans: ["a", "b"] },
      { d: 7, humans: ["c"] },
      { d: 6, humans: ["d"] },
    ]);
    const j = joinLeague(s, "new");
    expect(findLeagueOf(j, "new")!.id).toBe("d7-0");
  });
  it("出たら空きはコンピューター", () => {
    let s = withTeams(2);
    s = leaveLeague(s, "p00");
    expect(s.leagues[0].humans).toEqual(["p01"]);
    expect(s.leagues[0].cpus).toHaveLength(3);
    expect(new Set(s.leagues[0].cpus).size).toBe(3);
    expect(leaveLeague(s, "zz")).toBe(s);
    expect(activeLeagues(leaveLeague(s, "p01"))).toEqual([]);
  });
});

describe("1 日の点と順位", () => {
  it("その日の点の合計で並ぶ", () => {
    let s = manual(DAY0, [{ d: 8, humans: ["a", "b"] }]);
    const L = "d8-0";
    const cpu = (k: number) => `d8-0-cpu${k}`;
    // レース 1: a 1 位 (25)、b 2 位 (18)
    s = addLeagueRace(s, L, raceOf(["a", "b", cpu(0), cpu(1)]), slot(0));
    // レース 2: b 1 位 (25)、cpu0 2 位、a 3 位 (15) → a 40、b 43
    s = addLeagueRace(s, L, raceOf(["b", cpu(0), "a", cpu(1)]), slot(2));
    let rows = leagueStandings(s, L);
    expect(rows.slice(0, 2).map((r) => [r.id, r.points, r.wins])).toEqual([
      ["b", 43, 1],
      ["a", 40, 1],
    ]);
    s = addLeagueRace(s, L, raceOf(["x", "y", "a", "z", "w", "b"]), slot(4)); // a +15 = 55、b +8 = 51 (x … はリーグの外なので数えない)
    rows = leagueStandings(s, L);
    expect(rows.slice(0, 2).map((r) => [r.id, r.points, r.races])).toEqual([
      ["a", 55, 3],
      ["b", 51, 3],
    ]);
    expect(rows).toHaveLength(LEAGUE_TEAMS);
    // 今日の外のレースは足さない
    expect(addLeagueRace(s, L, raceOf(["a"]), slot(0, DAY0 + 1))).toBe(s);
    expect(addLeagueRace(s, "nope", raceOf(["a"]), slot(8))).toBe(s);
  });
  it("同点同勝ちは最後のレースの良いほう", () => {
    let s = manual(DAY0, [{ d: 8, humans: ["a", "b"] }]);
    s = addLeagueRace(s, "d8-0", raceOf(["a", "b"]), slot(0)); // a 25 b 18
    s = addLeagueRace(s, "d8-0", raceOf(["q", "w", "e", "r", "t", "u", "b", "a"]), slot(2)); // 下から 2 台は 0: a 25 b 18 のまま
    s = addLeagueRace(s, "d8-0", raceOf(["b", "a"]), slot(4)); // b 25 → 43、a 18 → 43 (どちらも 1 勝)
    const r = leagueStandings(s, "d8-0").filter((x) => x.human);
    expect(r.map((x) => [x.id, x.points, x.wins])).toEqual([
      ["b", 43, 1],
      ["a", 43, 1],
    ]); // 最後のレースで上だった b が上 (id の順なら a)
  });
});

describe("毎日の締め: 部の境の入れ替え", () => {
  /** 上から順に点を付ける: order の i 番目に (順位 i+1 の点) を 1 回 */
  function score(s: LeagueState, leagueId: string, order: string[]): LeagueState {
    return addLeagueRace(s, leagueId, raceOf(order), slot(0, s.day));
  }
  it("上のリーグの下の人と、下のリーグの上の人が入れ替わる。1 部の一番上と 8 部の一番下は動かない", () => {
    let s = manual(DAY0, [
      { d: 1, humans: ["a1", "a2"] },
      { d: 2, humans: ["b1", "b2"] },
      { d: 3, humans: ["c1", "c2"] },
    ]);
    s = score(s, "d1-0", ["a1", "a2"]);
    s = score(s, "d2-0", ["b1", "b2"]);
    s = score(s, "d3-0", ["c2", "c1"]);
    const c = closeLeagueDay(s);
    expect(c.swaps.map((x) => [x.up.teamId, x.down.teamId])).toEqual([
      ["b1", "a2"],
      ["c2", "b2"],
    ]);
    const hum = (id: string) => c.next.leagues.find((l) => l.id === id)!.humans;
    expect(hum("d1-0")).toEqual(["a1", "b1"]);
    expect(hum("d2-0")).toEqual(["a2", "c2"]);
    expect(hum("d3-0")).toEqual(["c1", "b2"]);
    // 点は 0 に戻る、日が進む
    expect(c.next.tally).toEqual({});
    expect(c.next.day).toBe(DAY0 + 1);
    // コンピューターのチームはそのまま
    expect(c.next.leagues.find((l) => l.id === "d1-0")!.cpus).toEqual(s.leagues.find((l) => l.id === "d1-0")!.cpus);
  });
  it("人が 1 チームのリーグ: 上半分 (1〜2 位) なら上の境に、下半分 (3〜4 位) なら下の境に出る。相手がいなければ入れ替えなし", () => {
    const cpu = (d: number, k: number) => `d${d}-0-cpu${k}`;
    let s = manual(DAY0, [
      { d: 6, humans: ["u1", "u2"] },
      { d: 7, humans: ["m"] },
      { d: 8, humans: ["l1", "l2"] },
    ]);
    // m は 7 部で 1 位 (上半分) → 6 部との境に出る。7↔8 の境では 7 部側に下へ行く人がいない
    s = score(s, "d7-0", ["m", cpu(7, 0)]);
    s = score(s, "d6-0", ["u1", "u2"]);
    s = score(s, "d8-0", ["l1", "l2"]);
    let c = closeLeagueDay(s);
    expect(c.swaps.map((x) => [x.up.teamId, x.down.teamId])).toEqual([["m", "u2"]]);
    // 2 位もまだ上半分
    s = manual(DAY0, [
      { d: 6, humans: ["u1", "u2"] },
      { d: 7, humans: ["m"] },
      { d: 8, humans: ["l1", "l2"] },
    ]);
    s = score(s, "d7-0", [cpu(7, 0), "m", cpu(7, 1)]);
    s = score(s, "d6-0", ["u1", "u2"]);
    s = score(s, "d8-0", ["l1", "l2"]);
    c = closeLeagueDay(s);
    expect(c.standings["d7-0"].find((r) => r.id === "m")!.rank).toBe(2);
    expect(c.swaps.map((x) => [x.up.teamId, x.down.teamId])).toEqual([["m", "u2"]]);
    // m が下半分 (3 位) なら 7↔8 の境へ (8 部の上の人と入れ替え)、6↔7 は相手なし
    s = manual(DAY0, [
      { d: 6, humans: ["u1", "u2"] },
      { d: 7, humans: ["m"] },
      { d: 8, humans: ["l1", "l2"] },
    ]);
    s = score(s, "d7-0", [cpu(7, 0), cpu(7, 1), "m", cpu(7, 2)]);
    s = score(s, "d8-0", ["l2", "l1"]);
    c = closeLeagueDay(s);
    expect(c.standings["d7-0"].find((r) => r.id === "m")!.rank).toBe(3);
    expect(c.swaps.map((x) => [x.up.teamId, x.down.teamId])).toEqual([["l2", "m"]]);
  });
  it("同じ字どうし A↔A・B↔B で組む", () => {
    let s = manual(DAY0, [
      { d: 7, i: 0, humans: ["a1", "a2"] },
      { d: 7, i: 1, humans: ["b1", "b2"] },
      { d: 8, i: 0, humans: ["c1", "c2"] },
      { d: 8, i: 1, humans: ["e1", "e2"] },
    ]);
    for (const [id, order] of [["d7-0", ["a1", "a2"]], ["d7-1", ["b1", "b2"]], ["d8-0", ["c1", "c2"]], ["d8-1", ["e1", "e2"]]] as const) s = score(s, id, [...order]);
    const c = closeLeagueDay(s);
    expect(c.swaps.map((x) => [x.up.from, x.up.teamId, x.down.from, x.down.teamId]).sort()).toEqual([
      ["d8-0", "c1", "d7-0", "a2"],
      ["d8-1", "e1", "d7-1", "b2"],
    ]);
  });
  it("8 部が 3 つ・7 部が 1 つ: 上に同じ字が無くても順番に組む。人は 2 人のまま、日ごとにどのリーグも上がれる", () => {
    const layout = [
      { d: 7, i: 0, humans: ["a1", "a2"] },
      { d: 8, i: 0, humans: ["b1", "b2"] },
      { d: 8, i: 1, humans: ["c1", "c2"] },
      { d: 8, i: 2, humans: ["e1", "e2"] },
    ];
    const lowerIds = ["d8-0", "d8-1", "d8-2"];
    const movedUpFrom = new Set<string>();
    for (let k = 0; k < 3; k++) {
      let s = manual(DAY0 + k, layout);
      for (const l of layout) s = score(s, `d${l.d}-${l.i}`, [...l.humans]);
      const c = closeLeagueDay(s);
      // 7 部 A は 2 人とも出せる (上に 6 部が無いので a1 は上がらない) → 入れ替えは 2 つ
      expect(c.swaps).toHaveLength(2);
      expect(new Set(c.swaps.map((x) => x.down.teamId))).toEqual(new Set(["a1", "a2"]));
      expect(c.swaps.every((x) => x.up.to === "d7-0" && lowerIds.includes(x.up.from))).toBe(true);
      // 下のほうの人 (a2) が先に下へ
      expect(c.swaps[0].down.teamId).toBe("a2");
      for (const x of c.swaps) movedUpFrom.add(x.up.from);
      // どのリーグも人は 2 人のまま、4 チームのまま
      for (const l of c.next.leagues) {
        expect(l.humans).toHaveLength(2);
        expect(leagueTeams(l)).toHaveLength(LEAGUE_TEAMS);
      }
      // 同じ人は 1 日に 2 回動かない
      const ids = c.swaps.flatMap((x) => [x.up.teamId, x.down.teamId]);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // 3 日のうちに、3 つの 8 部のリーグがどれも上に送れた
    expect(movedUpFrom).toEqual(new Set(lowerIds));
  });
  it("1 部の一番上は、下の部のリーグが多くても下がらない", () => {
    let s = manual(DAY0, [
      { d: 1, i: 0, humans: ["a1", "a2"] },
      { d: 2, i: 0, humans: ["b1", "b2"] },
      { d: 2, i: 1, humans: ["c1", "c2"] },
    ]);
    for (const [id, order] of [["d1-0", ["a1", "a2"]], ["d2-0", ["b1", "b2"]], ["d2-1", ["c1", "c2"]]] as const) s = score(s, id, [...order]);
    const c = closeLeagueDay(s);
    expect(c.swaps).toHaveLength(1);
    expect(c.swaps[0].down.teamId).toBe("a2");
    expect(c.next.leagues.find((l) => l.id === "d1-0")!.humans).toContain("a1");
  });
  it("4 チーム中の上位 2 の人のチームに賞金 (3 位は無し、点が 0 は無し)", () => {
    expect(LEAGUE_PRIZE_RANKS).toBe(2);
    let s = manual(DAY0, [
      { d: 5, humans: ["a", "b"] },
      { d: 6, humans: ["c", "d"] },
    ]);
    s = score(s, "d5-0", ["d5-0-cpu0", "a", "b", "d5-0-cpu1"]); // a 2 位 18、b 3 位 15
    // 6 部は走っていない: c・d は 1・2 位だが 0 点
    const c = closeLeagueDay(s);
    expect(c.standings["d6-0"].slice(0, 2).map((r) => [r.id, r.points])).toEqual([
      ["c", 0],
      ["d", 0],
    ]);
    expect(c.awards).toEqual([{ teamId: "a", leagueId: "d5-0", division: 5, rank: 2, points: 18 }]);
  });
});

describe("王者", () => {
  it("1 部の人のチームで一番の 1 チーム。コンピューターはなれない", () => {
    let s = manual(DAY0, [{ d: 1, humans: ["a", "b"] }]);
    s = addLeagueRace(s, "d1-0", raceOf(["d1-0-cpu0", "b", "a"]), slot(0));
    const c = closeLeagueDay(s);
    expect(c.champion).toBe("b");
    expect(c.next.champion).toBe("b");
    expect(teamTitle(c.next, "b")).toBe(CHAMPION_TITLE);
    // 王者でない 1 部のチームは 技術監督 (b に負けた a は下へ行かない: 2 部が無いので入れ替えなし)
    expect(teamTitle(c.next, "a")).toBe("技術監督");
  });
  it("1 部のリーグが何個もあれば、その日の点 → 勝った数で比べる", () => {
    let s = manual(DAY0, [
      { d: 1, i: 0, humans: ["a", "b"] },
      { d: 1, i: 1, humans: ["c", "d"] },
    ]);
    // a: 25 + 18 = 43 (1 勝、最後 2 位)、b: 15 + 25 = 40、c: 18 + 25 = 43 (1 勝、最後 1 位)、d: 25 + 18 = 43 (最後 2 位) → c
    s = addLeagueRace(s, "d1-0", raceOf(["a", "x", "b"]), slot(0));
    s = addLeagueRace(s, "d1-0", raceOf(["b", "a"]), slot(2));
    s = addLeagueRace(s, "d1-1", raceOf(["d", "c"]), slot(0));
    s = addLeagueRace(s, "d1-1", raceOf(["c", "d"]), slot(2));
    expect(closeLeagueDay(s).champion).toBe("c");
    // 同じ点なら勝った数が多いほう: e は 1 勝、a は 0 勝
    let t = manual(DAY0, [
      { d: 1, i: 0, humans: ["a"] },
      { d: 1, i: 1, humans: ["e"] },
    ]);
    t = addLeagueRace(t, "d1-0", raceOf(["x", "a"]), slot(0)); // a 18
    t = addLeagueRace(t, "d1-0", raceOf(["x", "y", "z", "q", "r", "a"]), slot(2)); // a +8 = 26 (0 勝)
    t = addLeagueRace(t, "d1-1", raceOf(["e"]), slot(0)); // e 25 (1 勝)
    t = addLeagueRace(t, "d1-1", raceOf(["x", "y", "z", "q", "r", "s", "w", "v", "e"]), slot(2)); // e +0 (下から 2 台) → 25 … 勝った数より点が先: a の勝ち
    expect(closeLeagueDay(t).champion).toBe("a");
    t = addLeagueRace(t, "d1-1", raceOf(["x", "y", "z", "q", "r", "s", "w", "v", "u", "e", "o", "p"]), slot(4)); // 12 台の 10 位は 1 点: e 26 = a 26
    expect(closeLeagueDay(t).champion).toBe("e"); // 同じ点なら勝った数 (e 1 勝、a 0 勝)
  });
  it("1 部に人がいなければ王者なし。出たら王者もいなくなる", () => {
    const s = manual(DAY0, [{ d: 2, humans: ["a"] }]);
    expect(closeLeagueDay(s).champion).toBeNull();
    const t = { ...manual(DAY0, [{ d: 1, humans: ["a"] }]), champion: "a" };
    expect(leaveLeague(t, "a").champion).toBeNull();
  });
});

describe("週のはんこ", () => {
  it("週の終わりの日だけ、その週に走った一番上の部", () => {
    let s = manual(DAY0, [
      { d: 3, humans: ["a", "b"] },
      { d: 4, humans: ["c", "d"] },
    ]);
    s = addLeagueRace(s, "d4-0", raceOf(["c", "d"]), slot(0));
    s = addLeagueRace(s, "d3-0", raceOf(["a", "b"]), slot(0));
    const c = closeLeagueDay(s); // 月曜を締める: c が 3 部へ、b が 4 部へ
    expect(c.weekStamps).toEqual([]);
    expect(c.next.weekBest).toEqual({ a: 3, b: 3, c: 4, d: 4 });
    // 日曜まで進める
    let st = c.next;
    for (let i = 0; i < 5; i++) st = closeLeagueDay(st).next;
    expect(st.day).toBe(DAY0 + 6);
    const end = closeLeagueDay(st);
    // b は月曜に 3 部を走った、c は火曜から 3 部
    expect(end.weekStamps).toEqual([
      { teamId: "a", division: 3 },
      { teamId: "b", division: 3 },
      { teamId: "c", division: 3 },
      { teamId: "d", division: 4 },
    ]);
    expect(end.next.weekBest).toEqual({});
  });
});

describe("2 時間ごとのレース", () => {
  it("日本時間 0・2・4 … 22 時", () => {
    const t = SEASON_EPOCH_MS; // 月曜 0:00 日本時間
    expect(nextScheduledAt(t)).toBe(t + 2 * H);
    expect(nextScheduledAt(t - 1)).toBe(t);
    expect(nextScheduledAt(t + 2 * H - 1)).toBe(t + 2 * H);
    const n = nextScheduledAt(t + 23 * H);
    expect(n).toBe(t + 24 * H);
    for (let k = 0; k < 12; k++) {
      const at = scheduledSlotStart(scheduledSlotIndex(t) + k);
      expect(new Date(at + 9 * H).getUTCHours()).toBe(2 * k);
    }
  });
  it("コースは公式コースを順番に回す", () => {
    const ids = ["x", "y", "z"];
    const t = SEASON_EPOCH_MS;
    const seq = [0, 1, 2, 3, 4].map((k) => scheduledTrackId(t + k * 2 * H, ids));
    expect(seq[1]).not.toBe(seq[0]);
    expect(seq[3]).toBe(seq[0]);
    expect(new Set(seq.slice(0, 3)).size).toBe(3);
    expect(() => scheduledTrackId(t, [])).toThrow();
  });
  it("くじ (seed で混ぜる): 同じ seed なら同じ、元は変えない、全部残る", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const g = shuffleBySeed(items, 5);
    expect(shuffleBySeed(items, 5)).toEqual(g);
    expect(items).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect([...g].sort()).toEqual(items);
    const seen = new Set<string>();
    for (let seed = 1; seed < 30; seed++) seen.add(shuffleBySeed(items, seed).join());
    expect(seen.size).toBeGreaterThan(5);
  });
  it("予定: 人のいるリーグごとに 1 レース、4 チーム全員 (8 台)、名前の無いコンピューターは要らない", () => {
    const s = withTeams(3);
    const at = SEASON_EPOCH_MS + 4 * H;
    const plan = planScheduledRaces(at, s);
    expect(plan.startsAt).toBe(at);
    expect(plan.laps).toBe(5);
    expect(plan.races.map((r) => [r.leagueId, r.teams.length, r.fillerCars])).toEqual([
      ["d8-0", 4, 0],
      ["d8-1", 4, 0],
    ]);
    // リーグの 4 チームが全員そろう (くじで分けない)
    for (const r of plan.races) expect([...r.teams].sort()).toEqual(leagueTeams(s.leagues.find((l) => l.id === r.leagueId)!).sort());
    expect(new Set(plan.races.map((r) => r.raceId)).size).toBe(plan.races.length);
    expect(planScheduledRaces(at, s)).toEqual(plan);
    // 人は運転しない: 自分の車は代走、2 台目は雇った運転手、ライバルは 2 台
    const r0 = plan.races[0];
    const humans = r0.teams.filter((t) => t.startsWith("p"));
    const entries = scheduledEntries(
      r0,
      humans.map((t) => ({ teamId: t, ownDriverId: `${t}-me`, hiredDriverId: `${t}-hired` })),
    );
    expect(entries).toHaveLength(RACE_CARS);
    for (const h of humans) {
      expect(entries.filter((e) => e.teamId === h).sort((x, y) => (x.driverId < y.driverId ? -1 : 1))).toEqual([
        { driverId: `${h}-hired`, teamId: h, standIn: false, rival: false },
        { driverId: `${h}-me`, teamId: h, standIn: true, rival: false },
      ]);
    }
    expect(entries.filter((e) => e.rival)).toHaveLength(2 * (LEAGUE_TEAMS - humans.length));
    expect(entries.filter((e) => e.rival).every((e) => !e.standIn)).toBe(true);
    // 自分の結果だけ
    expect(scheduledResultsFor(plan.races, "p02").map((r) => r.leagueId)).toEqual(["d8-1"]);
  });
  it("スタートの並びはくじ: 同じレースならいつも同じ、渡す並びに左右されない、枠が変われば変わる", () => {
    const s = withTeams(2);
    const at = SEASON_EPOCH_MS + 4 * H;
    const drivers = ["p00", "p01"].map((t) => ({ teamId: t, ownDriverId: `${t}-me`, hiredDriverId: `${t}-hired` }));
    const grid = (r: ScheduledRacePlan, ds = drivers) => scheduledEntries(r, ds).map((e) => e.driverId);
    const r0 = planScheduledRaces(at, s).races[0];
    const g = grid(r0);
    expect(g).toHaveLength(RACE_CARS);
    // 同じレース (作り直しても) は同じ並び
    expect(grid(planScheduledRaces(at, s).races[0])).toEqual(g);
    expect(grid({ ...r0, teams: [...r0.teams].reverse() })).toEqual(g);
    expect(grid(r0, [...drivers].reverse())).toEqual(g);
    // くじなので、チームの順 (人が先・2 台ずつ) のままではない枠がある。枠ごとに並びが変わる
    const grids = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => grid(planScheduledRaces(at + k * 2 * H, s).races[0]).join());
    expect(new Set(grids).size).toBeGreaterThan(4);
    const plain = r0.teams.flatMap((t) => (t.startsWith("p") ? [`${t}-me`, `${t}-hired`] : [`${t}#0`, `${t}#1`])).join();
    expect(grids.some((x) => x !== plain)).toBe(true);
    // ポール (1 番目) も枠によって変わる
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map((k) => grid(planScheduledRaces(at + k * 2 * H, s).races[0])[0])).size).toBeGreaterThan(1);
  });
  it("計算の順: 1 部から 8 部、同じ部は A から", () => {
    const s = manual(DAY0, [
      { d: 8, i: 1, humans: ["e"] },
      { d: 3, i: 0, humans: ["c"] },
      { d: 8, i: 0, humans: ["d"] },
      { d: 1, i: 0, humans: ["a"] },
      { d: 3, i: 1, humans: ["f"] },
      { d: 5, i: 0, humans: [] },
    ]);
    const plan = planScheduledRaces(SEASON_EPOCH_MS, s);
    expect(plan.races.map((r) => r.leagueId)).toEqual(["d1-0", "d3-0", "d3-1", "d8-0", "d8-1"]);
    expect(plan.races.every((r) => r.slot === plan.slot)).toBe(true);
  });
  it("追いつかないとき: 前の枠の残りが先、そのあと今の枠を 1 部から。2 枠 (4 時間) 以上古い残りは落とす", () => {
    const s = manual(DAY0, [
      { d: 1, humans: ["a"] },
      { d: 2, humans: ["b"] },
    ]);
    const at = SEASON_EPOCH_MS + 4 * H;
    const p0 = planScheduledRaces(at - 4 * H, s); // 2 枠前
    const p1 = planScheduledRaces(at - 2 * H, s); // 前の枠
    const p2 = planScheduledRaces(at, s); // 今の枠
    expect(SCHEDULED_DROP_AFTER_SLOTS).toBe(2);
    // リーグにつき 1 レース: 1 部・2 部
    expect(p2.races.map((r) => r.leagueId)).toEqual(["d1-0", "d2-0"]);
    // 前の枠は 2 部が残り、2 枠前も 2 部が残った
    const leftovers = [p0.races[1], p1.races[1]];
    const q = scheduledQueue(leftovers, p2.races, p2.slot);
    expect(q.run.map((r) => r.raceId)).toEqual([p1.races[1], ...p2.races].map((r) => r.raceId));
    expect(q.run[0].division).toBe(2);
    expect(q.run[1].division).toBe(1);
    expect(q.dropped.map((r) => r.raceId)).toEqual([p0.races[1].raceId]);
    expect(skippedRecord(q.dropped[0])).toEqual({ raceId: p0.races[1].raceId, slot: p0.slot, leagueId: "d2-0", teams: p0.races[1].teams, status: "not_computed" });
    // 同じレースを 2 回入れても 1 回
    expect(scheduledQueue([...p2.races, ...p2.races], p2.races, p2.slot).run).toHaveLength(p2.races.length);
    // 残りが無ければ今の枠だけ
    expect(scheduledQueue([], p2.races, p2.slot)).toEqual({ run: p2.races, dropped: [] });
  });
});
