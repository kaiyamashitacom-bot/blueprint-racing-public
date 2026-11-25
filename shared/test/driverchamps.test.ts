import { describe, expect, it } from "vitest";
import { driverChampionOverall, driverChampionsByClass, newSeasonTally } from "../src/index.ts";

const d = (teamId: string, points: number) => ({ teamId, points, tournamentPoints: 0, races: 1, finishes: [], lastGainAt: 0 });

describe("ドライバーズチャンピオン", () => {
  it("級ごとに 1 人。雇った運転手もなれる。賞金はいるチームへ。上の級ほど多い", () => {
    const st = newSeasonTally(0);
    st.drivers.alice = d("A", 50);
    st.drivers["hire-7"] = d("A", 60); // A に雇われたコンピューターの運転手
    st.drivers.bob = d("B", 40);
    st.drivers.rival = d("cpuTeam", 999); // 人のチームでない
    const classes = { A: 1, B: null } as const;
    const res = driverChampionsByClass(st, classes);
    expect(res[0].champion?.driverId).toBe("hire-7");
    expect(res[0].champion?.teamId).toBe("A");
    expect(res[4].champion?.driverId).toBe("bob");
    expect(res[0].champion!.prize).toBeGreaterThan(res[4].champion!.prize);
    expect(res[2].champion).toBeNull();
    const all = driverChampionOverall(st, classes);
    expect(all.champion?.driverId).toBe("hire-7");
    expect(all.rows.map((r) => r.id)).not.toContain("rival");
  });
});
