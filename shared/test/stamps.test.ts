import { describe, expect, it } from "vitest";
import { closeSeason, newSeasonTally, addRaceToTally, SEASON_EPOCH_MS, type ClassTable } from "../src/season.ts";
import {
  addHistory, addStamps, historyEntry, leagueWeekStamps, mergeStampBooks, raceStamps, seasonStamps, STAMP_DEFS, STAMP_ORDER, stampsForDisplay, weekDivisionStamp,
  type StampRaceInput,
} from "../src/stamps.ts";

const base: StampRaceInput = { kind: "everyday", laps: 5, pos: 4, gridPos: 4, finished: true, fastest: false, pitStops: 1, maxWet: 0, penalty: 0 };

describe("はんこの表", () => {
  it("どのはんこにも名前と説明がある", () => {
    for (const id of STAMP_ORDER) {
      expect(STAMP_DEFS[id].id).toBe(id);
      expect(STAMP_DEFS[id].name.length).toBeGreaterThan(0);
    }
    expect(STAMP_DEFS.div8.name).toBe("製図見習い");
    expect(STAMP_DEFS.div1.name).toBe("技術監督");
  });
});

describe("レースのはんこ", () => {
  it("何もしなければ無し", () => {
    expect(raceStamps(base)).toEqual([]);
  });
  it("優勝・表彰台・最速の周・雨で勝った・逃げ切り・罰なし", () => {
    expect(raceStamps({ ...base, pos: 1, gridPos: 1, fastest: true, maxWet: 0.6 })).toEqual(["win", "podium", "fastest_lap", "rain_win", "pole_to_win", "clean_win"]);
    expect(raceStamps({ ...base, pos: 1, gridPos: 2, fastest: true, penalty: 5 })).toEqual(["win", "podium", "fastest_lap"]);
    expect(raceStamps({ ...base, pos: 1, maxWet: 0.2 })).not.toContain("rain_win");
  });
  it("追い上げ・ピットなし・長いレース・タイヤ使い・ワンツー", () => {
    expect(raceStamps({ ...base, pos: 3, gridPos: 7 })).toEqual(["podium", "comeback"]);
    expect(raceStamps({ ...base, pos: 4, gridPos: 7 })).toEqual([]);
    expect(raceStamps({ ...base, pitStops: 0, laps: 5 })).toEqual(["no_pit_finish"]);
    expect(raceStamps({ ...base, pitStops: 0, laps: 2 })).toEqual([]);
    expect(raceStamps({ ...base, laps: 10 })).toEqual(["long_finish"]);
    expect(raceStamps({ ...base, tiresUsed: ["S", "M", "H"] })).toEqual(["three_compounds"]);
    expect(raceStamps({ ...base, tiresUsed: ["S", "S", "M"] })).toEqual([]);
    expect(raceStamps({ ...base, pos: 2, teammatePos: 1 })).toEqual(["podium", "one_two"]);
    expect(raceStamps({ ...base, pos: 2, teammatePos: 3 })).toEqual(["podium"]);
  });
  it("大会", () => {
    expect(raceStamps({ ...base, kind: "tournament", pos: 1 })).toEqual(["win", "podium", "tournament_win", "tournament_podium"]);
    expect(raceStamps({ ...base, kind: "tournament", pos: 3 })).toEqual(["podium", "tournament_podium"]);
  });
  it("代走・失格・完走していないなら無し", () => {
    const winner = { ...base, pos: 1, fastest: true };
    expect(raceStamps({ ...winner, standIn: true })).toEqual([]);
    expect(raceStamps({ ...winner, dq: true })).toEqual([]);
    expect(raceStamps({ ...winner, finished: false })).toEqual([]);
  });
});

describe("季節とリーグのはんこ", () => {
  it("級の 1 位・昇級・運転手の 1 位", () => {
    const table: ClassTable = { A: 3, B: 3, C: 3, D: 3, E: 3, F: 3 };
    let t = newSeasonTally(0);
    t = addRaceToTally(t, {
      raceId: "r",
      kind: "everyday",
      at: SEASON_EPOCH_MS + 1,
      cars: [
        { driverId: "a1", teamId: "A", pos: 1, finished: true, fastest: false },
        { driverId: "b1", teamId: "B", pos: 2, finished: true, fastest: false },
      ],
    });
    const close = closeSeason(table, t);
    expect(seasonStamps(close, "A", "a1")).toEqual(["class_champion", "promoted", "driver_champion"]);
    // 上がるのは 1 位の 1 チームだけ (11/25)。2 位の B は上がらない
    expect(seasonStamps(close, "B", "b1")).toEqual([]);
    expect(seasonStamps(close, "F")).toEqual([]);
    // 級なしから級が付いただけでは昇級ではない
    const c2 = closeSeason({ N: null }, newSeasonTally(0));
    expect(seasonStamps(c2, "N")).toEqual([]);
  });
  it("リーグ戦の週のはんこは一番上の部の 1 つ", () => {
    expect(weekDivisionStamp(3)).toBe("div3");
    expect(weekDivisionStamp(9)).toBeNull();
    expect(leagueWeekStamps([{ teamId: "A", division: 2 }, { teamId: "B", division: 8 }], "A")).toEqual(["div2"]);
    expect(leagueWeekStamps([], "A")).toEqual([]);
  });
});

describe("はんこの帳面", () => {
  it("足す・合わせる", () => {
    let b = addStamps({}, ["win", "podium"], 100);
    b = addStamps(b, ["win"], 50);
    expect(b.win).toEqual({ count: 2, firstAt: 50, lastAt: 100 });
    const m = mergeStampBooks(b, { win: { count: 3, firstAt: 10, lastAt: 200 }, div1: { count: 1, firstAt: 5, lastAt: 5 } });
    expect(m.win).toEqual({ count: 5, firstAt: 10, lastAt: 200 });
    expect(m.div1).toEqual({ count: 1, firstAt: 5, lastAt: 5 });
    expect(b.div1).toBeUndefined();
  });
  it("車の絵に並べる順: 珍しい順 → 回数 → 表の順", () => {
    let b = addStamps({}, ["win", "win", "podium", "one_two", "rain_win"], 1);
    b = addStamps(b, ["podium", "podium"], 2);
    expect(stampsForDisplay(b)).toEqual([
      { id: "one_two", count: 1 },
      { id: "rain_win", count: 1 },
      { id: "podium", count: 3 },
      { id: "win", count: 2 },
    ]);
    expect(stampsForDisplay(b, 2).map((x) => x.id)).toEqual(["one_two", "rain_win"]);
  });
});

describe("歴代の記録", () => {
  it("季節の終わりの肩書きとはんこを残す", () => {
    const e = historyEntry({ season: 3, cls: 2, classRank: 1, division: 6, stamps: ["div5", "win", "win"] });
    expect(e).toEqual({ season: 3, cls: 2, classRank: 1, division: 6, title: "設計助手", champion: false, stamps: ["win", "div5"] });
    expect(historyEntry({ season: 3, cls: null, classRank: null, division: null, stamps: [] }).title).toBeNull();
  });
  it("王者は特別な記録", () => {
    const e = historyEntry({ season: 4, cls: 1, classRank: 2, division: 1, champion: true, stamps: ["div1"] });
    expect(e.title).toBe("王者");
    expect(e.champion).toBe(true);
  });
  it("同じ季節は置きかえ、季節の順", () => {
    const a = historyEntry({ season: 2, cls: 3, classRank: 5, division: 8, stamps: [] });
    const b = historyEntry({ season: 1, cls: 3, classRank: 5, division: 8, stamps: [] });
    const a2 = historyEntry({ season: 2, cls: 3, classRank: 4, division: 7, stamps: [] });
    expect(addHistory(addHistory(addHistory([], a), b), a2).map((h) => [h.season, h.title])).toEqual([
      [1, "製図見習い"],
      [2, "製図工"],
    ]);
  });
});
