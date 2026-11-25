// チームの 2 台目・整備の腕 (ピットの時間)・慣れ の試験
import { describe, expect, it } from "vitest";
import {
  FAMILIARITY,
  LOBBY_MS,
  MAX_CARS,
  RaceRoom,
  SAMPLE_DESIGN,
  applyFamiliarity,
  computeStats,
  createCar,
  familiarityAfterRace,
  familiarityAt,
  familiarityNow,
  familiaritySkillBonus,
  getTrack,
  makeBrain,
  recordFamiliarity,
  serviceTime,
  TRACK_DEFS,
  type JoinTeam,
  type RaceReport,
  type ServerMsg,
  type TeamRaceReport,
} from "../src/index.ts";

const DAY = 24 * 3600_000;

describe("慣れ", () => {
  it("1 回ごとに残りの 10% ずつ近づき、1 を超えない", () => {
    let f = familiarityAfterRace(null, 0);
    expect(f.v).toBeCloseTo(0.1, 6);
    f = familiarityAfterRace(f, 0);
    expect(f.v).toBeCloseTo(0.19, 6);
    for (let i = 0; i < 200; i++) f = familiarityAfterRace(f, 0);
    expect(f.v).toBeLessThanOrEqual(1);
    expect(f.v).toBeGreaterThan(0.99);
  });

  it("走らないと 7 日で半分に戻る", () => {
    const f = { v: 0.8, at: 1000 };
    expect(familiarityAt(f, 1000)).toBeCloseTo(0.8, 6);
    expect(familiarityAt(f, 1000 + 7 * DAY)).toBeCloseTo(0.4, 6);
    expect(familiarityAt(f, 1000 + 14 * DAY)).toBeCloseTo(0.2, 6);
    // 減ったところから足す
    expect(familiarityAfterRace(f, 1000 + 7 * DAY).v).toBeCloseTo(0.4 + 0.6 * 0.1, 6);
    expect(familiarityAt(null, 5)).toBe(0);
  });

  it("上手さに足す分: 雇った運転手は最大 +0.02、代走は最大 +0.05", () => {
    expect(familiaritySkillBonus(1)).toBeCloseTo(FAMILIARITY.maxSkillBonus, 9);
    expect(familiaritySkillBonus(1, true)).toBeCloseTo(FAMILIARITY.standInMaxBonus, 9);
    expect(familiaritySkillBonus(0.5)).toBeCloseTo(0.01, 9);
    const b = makeBrain(() => 0.5, 0.9);
    applyFamiliarity(b, 1, true);
    expect(b.skill).toBeCloseTo(0.95, 9);
    const top = makeBrain(() => 0.5, 0.99);
    applyFamiliarity(top, 1, true);
    expect(top.skill).toBe(1);
  });

  it("地図: コースごとに残し、今の値だけを出す", () => {
    let m = recordFamiliarity({}, "a", 0);
    m = recordFamiliarity(m, "a", 0);
    m = recordFamiliarity(m, "b", 0);
    const now = familiarityNow(m, 7 * DAY);
    expect(now.a).toBeCloseTo(0.095, 4);
    expect(now.b).toBeCloseTo(0.05, 4);
  });
});

describe("整備の腕でピットの時間が変わる", () => {
  it("serviceFactor がピットで止まる時間に掛かる (なし = 今まで)", () => {
    const track = getTrack(TRACK_DEFS[0].id);
    const stats = computeStats(SAMPLE_DESIGN);
    const plain = createCar(track, stats, 0);
    expect("serviceFactor" in plain).toBe(false);
    const fast = createCar(track, stats, 0, { serviceFactor: 0.6 });
    const order = { tire: "H" as const };
    expect(serviceTime(fast, stats, order)).toBeCloseTo(serviceTime(plain, stats, order) * 0.6, 9);
  });
});

function setup(laps = 1) {
  const sent: Array<{ to: string; msg: ServerMsg }> = [];
  const reports: RaceReport[] = [];
  const teams: TeamRaceReport[] = [];
  let r = 11;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const room = new RaceRoom(
    {
      send: (to, msg) => sent.push({ to, msg }),
      broadcast: (msg) => sent.push({ to: "*", msg }),
      onResults: (x) => reports.push(x),
      onTeamResults: (x) => teams.push(x),
    },
    laps,
    rand,
  );
  return { room, sent, reports, teams };
}

const STATS = { speed: 60, stability: 60, tyreFuel: 50, pitSense: 50 };
const TEAM: JoinTeam = {
  serviceFactor: 0.7,
  second: { driverId: "d3", name: "霞谷 ナギ", design: SAMPLE_DESIGN, driver: STATS, fam: { [TRACK_DEFS[0].id]: 0.5 } },
  standInFam: { [TRACK_DEFS[0].id]: 1 },
};

describe("チームの 2 台目", () => {
  it("ログインした人に雇った運転手がいれば、2 台目が席を 1 つ使って走り、チームの結果が出る", () => {
    const { room, sent, reports, teams } = setup(1);
    let now = 0;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now, () => {}, TEAM) as { id: string };
    const welcome = sent.find((s) => s.to === a.id && s.msg.t === "welcome")!.msg as Extract<ServerMsg, { t: "welcome" }>;
    expect(welcome.crew).toBe(0.7);
    expect(welcome.second).toBe("霞谷 ナギ");
    room.join("kb", "B", SAMPLE_DESIGN, now);
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    const roster = room.roster();
    expect(roster.length).toBe(MAX_CARS);
    const second = roster.find((x) => x.name === "霞谷 ナギ")!;
    expect(second).toBeTruthy();
    expect(second.bot).toBe(true);
    // 並びの場所はみんなちがう (同じくじから)
    expect(new Set(roster.map((x) => x.slot)).size).toBe(MAX_CARS);
    // CPU は 8 - 人 2 - 2 台目 1 = 5 台
    expect(roster.filter((x) => x.name.endsWith("(CPU)")).length).toBe(5);
    // 人は切れて代走に
    room.leave(a.id, now);
    for (let i = 0; i < 20 * 200 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    // 賞金の知らせは今までどおり人だけ
    expect(reports[0].rows.every((x) => x.id !== second.id)).toBe(true);
    expect(teams.length).toBe(1);
    const t = teams[0].teams;
    expect(t.length).toBe(1);
    expect(t[0].id).toBe(a.id);
    expect(t[0].car1.standIn).toBe(true);
    expect(t[0].car2?.driverId).toBe("d3");
    expect(t[0].car2?.distM).toBeGreaterThan(0);
    expect(t[0].car2?.partIds).toContain("seat");
    expect(teams[0].trackId).toBe(TRACK_DEFS[0].id);
  });

  it("満員 (人が 8 人) なら 1 台目だけ", () => {
    const { room } = setup(1);
    const now = 0;
    room.join("k0", "P0", SAMPLE_DESIGN, now, () => {}, TEAM);
    for (let i = 1; i < MAX_CARS; i++) room.join(`k${i}`, `P${i}`, SAMPLE_DESIGN, now);
    room.tick(now + LOBBY_MS + 10);
    expect(room.phase).toBe("race");
    const roster = room.roster();
    expect(roster.length).toBe(MAX_CARS);
    expect(roster.some((x) => x.name === "霞谷 ナギ")).toBe(false);
  });

  it("名無し (チームなし) は今までどおり: 2 台目は出ず、チームの結果も出ない", () => {
    const { room, teams, sent } = setup(1);
    let now = 0;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now) as { id: string };
    const welcome = sent.find((s) => s.to === a.id && s.msg.t === "welcome")!.msg as Extract<ServerMsg, { t: "welcome" }>;
    expect(welcome.crew).toBeUndefined();
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.roster().filter((x) => x.name.endsWith("(CPU)")).length).toBe(MAX_CARS - 1);
    room.leave(a.id, now);
    for (let i = 0; i < 20 * 200 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    expect(teams.length).toBe(0);
  });

  it("眠って戻っても待合のチームの様子は残る", () => {
    const { room } = setup(1);
    room.join("ka", "A", SAMPLE_DESIGN, 0, () => {}, TEAM);
    const snap = JSON.parse(JSON.stringify(room.snapshot()));
    expect(snap.entrants[0].team.second.driverId).toBe("d3");
    const back = RaceRoom.restore({ send: () => {}, broadcast: () => {} }, snap, 10);
    back.tick(LOBBY_MS + 20);
    expect(back.roster().some((x) => x.name === "霞谷 ナギ")).toBe(true);
  });
});
