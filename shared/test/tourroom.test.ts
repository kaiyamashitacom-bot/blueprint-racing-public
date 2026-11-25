// 顔ぶれの決まった部屋 (大会の組): 来なかった人は代走、雇った運転手はコンピューター、タイヤの区間が結果に付く
import { describe, expect, it } from "vitest";
import {
  RESULTS_MS,
  RaceRoom,
  SAMPLE_DESIGN,
  classifyTournament,
  computeStats,
  fuelPerMeter,
  getTrack,
  newQualiTires,
  raceSetupFromQuali,
  type FixedCarResult,
  type FixedField,
  type RoomSnapshot,
  type ServerMsg,
  type TournamentSpec,
} from "../src/index.ts";

const DRY = { seed: 1, changes: [{ at: 0, sky: "sun" as const }], fakes: [], startWet: 0 };

function field(startAt: number): FixedField {
  const q = newQualiTires({ S: 1, M: 2, H: 1 });
  const st = raceSetupFromQuali(q, { tire: "S" })!;
  return {
    tag: "tx:0",
    trackId: "aozu",
    laps: 2,
    tireKind: "tournament",
    startAt,
    weather: DRY,
    cars: [
      { key: "acc:1", name: "人A", design: SAMPLE_DESIGN, slot: 0, kind: "human", teamId: "1", driverId: "h1", setup: { tire: st.tire, wear: st.wear, sets: st.sets, fuel: 60 } },
      { key: "acc:2", name: "人B", design: SAMPLE_DESIGN, slot: 1, kind: "human", teamId: "2", driverId: "h2" },
      {
        key: "hire:d1",
        name: "雇い",
        design: SAMPLE_DESIGN,
        slot: 2,
        kind: "hired",
        teamId: "1",
        driverId: "d1",
        driver: { speed: 50, stability: 50, tyreFuel: 50, pitSense: 50 },
      },
    ],
  };
}

function setup() {
  const sent: Array<{ to: string; msg: ServerMsg }> = [];
  const results: Array<{ tag: string; rows: FixedCarResult[]; at: number }> = [];
  let r = 11;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const io = {
    send: (to: string, msg: ServerMsg) => sent.push({ to, msg }),
    broadcast: (msg: ServerMsg) => sent.push({ to: "*", msg }),
    onFixedResults: (tag: string, rows: FixedCarResult[], at: number) => results.push({ tag, rows, at }),
    onResults: () => {
      throw new Error("決まった部屋は普段の結果を出さない");
    },
  };
  const room = new RaceRoom(io, 2, rand);
  return { room, sent, results, io, rand };
}

describe("大会の組の部屋", () => {
  it("待合は始まりの時刻まで、人がいなくても閉じない。出場者でない人は入れない", () => {
    const { room } = setup();
    let now = 1000;
    room.setFixed(field(now + 60_000), now);
    expect(room.isFixed()).toBe(true);
    expect(room.phase).toBe("lobby");
    expect(room.roster().length).toBe(3);
    now += 1000;
    room.tick(now);
    expect(room.phase).toBe("lobby");
    const bad = room.join("acc:9", "だれ", SAMPLE_DESIGN, now);
    expect(bad.ok).toBe(false);
    const a = room.join("acc:1", "人A", SAMPLE_DESIGN, now);
    expect(a.ok).toBe(true);
    // 待合で抜けても席は残る
    room.leave((a as { id: string }).id, now);
    expect(room.roster().length).toBe(3);
    expect(room.phase).toBe("lobby");
  });

  it("来なかった人は代走、雇った運転手はコンピューター。結果にタイヤの区間と並びが付き、決勝の結果を決められる", () => {
    const { room, results } = setup();
    let now = 0;
    room.setFixed(field(30_000), now);
    now = 30_000;
    room.tick(now);
    expect(room.phase).toBe("race");
    for (let i = 0; i < 20 * 600 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    expect(results.length).toBe(1);
    const rows = results[0].rows;
    expect(results[0].tag).toBe("tx:0");
    expect(rows.length).toBe(3);
    const a = rows.find((x) => x.key === "acc:1")!;
    const h = rows.find((x) => x.key === "hire:d1")!;
    expect(a.standIn).toBe(true);
    expect(h.standIn).toBe(false);
    expect(a.gridPos).toBe(1);
    // 人A は予定どおり柔らかいタイヤで出た
    expect(a.stints[0].tire).toBe("S");
    expect(a.stints.reduce((s, x) => s + x.meters, 0)).toBeGreaterThan(100);
    expect(a.stints.every((x) => x.dry)).toBe(true);
    // 大会の決まり (乾いた路面で 2 種類): コンピューターは半分を過ぎたら別の種類に替えに入るので、失格にならない
    const spec: TournamentSpec = { id: "tx", name: "x", createdAt: 0, startsAt: 30_000, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" } };
    const c = classifyTournament(
      spec,
      rows.map((x) => ({ driverId: x.driverId, teamId: x.teamId, pos: x.pos, finished: x.finished, best: x.best, stints: x.stints, standIn: x.standIn })),
      now,
    );
    for (const car of c.cars) {
      if (!car.finished) continue;
      expect(car.tireRule.dryCompounds.length).toBeGreaterThanOrEqual(2);
      expect(car.dq).toBe(false);
    }
    // 1 種類で走り切った車は失格
    const one = classifyTournament(spec, [{ driverId: "x", teamId: "1", pos: 1, finished: true, best: 30, stints: [{ tire: "M", meters: 2000, dry: true }] }], now);
    expect(one.cars[0].dq).toBe(true);
    // 結果のあとは閉じる (次の待合はない)
    now += RESULTS_MS + 1000;
    room.tick(now);
    expect(room.phase).toBe("idle");
    expect(room.join("acc:1", "人A", SAMPLE_DESIGN, now).ok).toBe(false);
  });

  it("来た人は自分で走り (代走でない)、眠って戻しても席が残る", () => {
    const { room, io } = setup();
    let now = 0;
    room.setFixed(field(30_000), now);
    const a = room.join("acc:2", "人B", SAMPLE_DESIGN, now);
    expect(a.ok).toBe(true);
    const snap: RoomSnapshot = JSON.parse(JSON.stringify(room.snapshot()));
    expect(snap.fixed?.tag).toBe("tx:0");
    const back = RaceRoom.restore(io, snap, now + 1000);
    expect(back.isFixed()).toBe(true);
    expect(back.phase).toBe("lobby");
    expect(back.roster().map((x) => x.id)).toEqual(room.roster().map((x) => x.id));
    expect(back.humans()).toBe(1);
  });

  // QA 2 回目 (11/25): 試しの杯で代走 2 台が乾いたタイヤ 1 種類のまま走り切り、失格 (タイヤ) になっていた。
  // そのときの組 (青図・2 周・晴れ、2 台とも普通で出て、組に別の乾いたタイヤがある) を、今の中身で走らせる
  const QA_SETS: Array<Record<string, number>> = [
    { S: 2, M: 1 },
    { M: 1, H: 2 },
  ];
  for (const laps of [2, 5]) {
    it(`代走とコンピューターは、乾いた大会 (${laps} 周) で乾いたタイヤを 2 種類使い、失格にならない`, () => {
      const { room, results } = setup();
      const cars: FixedField["cars"] = QA_SETS.map((alloc, i) => {
        const st = raceSetupFromQuali(newQualiTires(alloc), { tire: "M" })!;
        // 燃料は「レースの分」(server/src/season.ts と同じ見積もり)
        const stats = computeStats(SAMPLE_DESIGN);
        const fuel = Math.min(stats.fuelCap, fuelPerMeter(stats) * (laps * getTrack("aozu").length + 100) * 1.12 + 1.5);
        return { key: `acc:${i + 1}`, name: `代走${i + 1}`, design: SAMPLE_DESIGN, slot: i, kind: "human" as const, teamId: String(i + 1), driverId: `h${i + 1}`, setup: { tire: st.tire, wear: st.wear, sets: st.sets, fuel } };
      });
      // 予定のない人 (コンピューターの決め方で出る) と、雇った運転手
      cars.push({ key: "acc:3", name: "予定なし", design: SAMPLE_DESIGN, slot: 2, kind: "human", teamId: "3", driverId: "h3" });
      cars.push({ key: "hire:d1", name: "雇い", design: SAMPLE_DESIGN, slot: 3, kind: "hired", teamId: "1", driverId: "d1", driver: { speed: 50, stability: 50, tyreFuel: 50, pitSense: 50 } });
      let now = 0;
      room.setFixed({ tag: "qa:0", trackId: "aozu", laps, tireKind: "tournament", startAt: 30_000, weather: DRY, cars }, now);
      now = 30_000;
      room.tick(now);
      for (let i = 0; i < 20 * 60 * 30 && room.phase === "race"; i++) {
        now += 50;
        room.tick(now);
      }
      expect(room.phase).toBe("results");
      const rows = results[0].rows;
      expect(rows.length).toBe(4);
      const spec: TournamentSpec = { id: "qa", name: "試しの杯", createdAt: 0, startsAt: 30_000, trackId: "aozu", laps, weather: { mode: "fixed", sky: "sun" } };
      const c = classifyTournament(
        spec,
        rows.map((x) => ({ driverId: x.driverId, teamId: x.teamId, pos: x.pos, finished: x.finished, best: x.best, stints: x.stints, standIn: x.standIn })),
        now,
      );
      for (const r of rows) expect(r.kind === "hired" || r.standIn).toBe(true);
      for (const car of c.cars) {
        expect(car.finished).toBe(true);
        expect(car.tireRule.applies).toBe(true);
        expect(car.tireRule.dryCompounds.length).toBeGreaterThanOrEqual(2);
        expect(car.dq).toBe(false);
      }
      for (const r of rows) expect(r.pitStops).toBeGreaterThanOrEqual(1);
    });
  }
});
