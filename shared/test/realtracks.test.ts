// 実在のサーキットを似せた公式コース (11/25 決まり「世界中のサーキットを真似して、名前も同じに」)。
// 形の決まり (作る画面と同じ確かめ)・長さ・かんたん操作の 1 周・一番上手いコンピューター・8 台の部屋のレース・コースの回し方。
// 8 台の部屋のレースは 1 本 0.2 秒ほどなので全部のコースで。ぶつかってリタイアする車はまれに出る (20 の種 × 8 コースで 1 回、スパ・種 11) ので、種は 12。
import { describe, expect, it } from "vitest";
import {
  BOT_SKILL_MAX, DT, LOBBY_MS, RaceRoom, REAL_CIRCUIT_IDS, SAMPLE_DESIGN, TRACK_DEFS, TRACK_LIMITS, botInput, checkTrack, computeStats, createCar,
  drsZones, getTrack, makeBrain, newLapState, rampSteer, scheduledSlotIndex, scheduledSlotStart, scheduledTrackId, seasonIndexAt, stepCar, taWeek,
  updateLaps, type ServerMsg,
} from "../src/index.ts";

/** 本物の 1 周 (km、だいたい) */
const REAL_KM: Record<string, number> = {
  suzuka: 5.807, monaco: 3.337, silverstone: 5.891, spa: 7.004, monza: 5.793, interlagos: 4.309,
  montreal: 4.361, redbull: 4.318, hungaroring: 4.381, cota: 5.513, bahrain: 5.412, jeddah: 6.174, melbourne: 5.278, zandvoort: 4.259,
};

const lcg = (seed: number) => {
  let r = seed;
  return () => ((r = (r * 16807) % 2147483647) / 2147483647);
};

/**
 * 1 人で走る。assist = かんたん操作 (上手な人のボタン操作: 左・まっすぐ・右を押す長さで加減。アクセル・ブレーキは押さない)。
 * そうでなければコンピューターがそのまま運転する
 */
function soloLap(trackId: string, o: { assist?: boolean; skill?: number; laps?: number; fixedPress?: boolean }) {
  const track = getTrack(trackId);
  const stats = computeStats(SAMPLE_DESIGN);
  const car = createCar(track, stats, 0);
  car.started = true;
  const brain = makeBrain(lcg(3), o.skill ?? 0.9);
  const st = newLapState();
  let t = 0;
  let grass = 0;
  let walls = 0;
  let held = 0;
  let owe = 0;
  let press = 0;
  let until = 0;
  while (t < 600 && !st.finished && !st.retired) {
    const inp = botInput(car, stats, track, brain, t, [], 0);
    let input = inp;
    if (o.assist && o.fixedPress) {
      // キーを決まった長さで押す人: 0.1 秒ごとに 左・まっすぐ・右を決めて その間押したまま (加減しない)
      if (t >= until) {
        press = Math.abs(inp.steer) > 0.3 ? Math.sign(inp.steer) : 0;
        until = t + 0.1;
      }
      held = rampSteer(held, press, DT);
      input = { steer: held, throttle: 0, brake: 0, assist: true };
    } else if (o.assist) {
      const u = owe + inp.steer;
      held = rampSteer(held, u > 0.5 ? 1 : u < -0.5 ? -1 : 0, DT);
      owe = u - held;
      input = { steer: held, throttle: 0, brake: 0, assist: true };
    }
    const ev = stepCar(car, input, stats, track, DT, { wetness: 0 });
    t += DT;
    if (ev.wall > 3) walls++;
    if (car.surface === "grass") grass += DT;
    updateLaps(car, st, ev, t, track.length, o.laps ?? 2, false);
  }
  return { best: st.bestLap ?? Infinity, finished: st.finished, grass, walls };
}

// 11/25 ハンドルを直したあと「決まった長さで押すキーの人」がモナコのかんたん操作で壁に当たっていた。今は当たらない (ASSIST_MARGIN 0.92 のまま)
describe("かんたん操作 × キーを決まった長さで押す人", () => {
  for (const id of ["monaco", "hungaroring", "suzuka"]) {
    it(`${id}: 壁にも芝にも出ない`, () => {
      for (const skill of [0.8, 0.9, 1]) {
        const r = soloLap(id, { assist: true, fixedPress: true, skill });
        expect(r.finished, `${skill}`).toBe(true);
        expect(r.walls, `${skill}`).toBe(0);
        expect(r.grass, `${skill}`).toBe(0);
      }
    });
  }
});

describe("実在のサーキット", () => {
  it("公式コースに全部あり、青図・つづら坂のあとに並ぶ", () => {
    const ids = TRACK_DEFS.map((d) => d.id);
    expect(ids.slice(0, 2)).toEqual(["aozu", "tsuzura"]);
    for (const id of REAL_CIRCUIT_IDS) expect(ids, id).toContain(id);
    expect(Object.keys(REAL_KM).sort()).toEqual([...REAL_CIRCUIT_IDS].sort());
  });

  for (const id of REAL_CIRCUIT_IDS) {
    const def = TRACK_DEFS.find((d) => d.id === id)!;
    describe(def.name, () => {
      it("作るコースと同じ確かめを通り、本物の 0.35〜0.5 倍。DRS 2〜3 区間・ピット・セクターあり", () => {
        const c = checkTrack(def);
        expect(c.issues, JSON.stringify(c.issues)).toEqual([]);
        const t = getTrack(id);
        const ratio = t.length / 1000 / REAL_KM[id];
        expect(ratio).toBeGreaterThan(0.35);
        expect(ratio).toBeLessThan(0.5);
        expect(t.length).toBeLessThanOrEqual(TRACK_LIMITS.maxLength);
        expect(def.points.length).toBeLessThanOrEqual(TRACK_LIMITS.maxPoints);
        expect(drsZones(t).length).toBeGreaterThanOrEqual(2);
        expect(drsZones(t).length).toBeLessThanOrEqual(3);
        expect(def.pit).toBeDefined();
        expect(def.sectors).toBeDefined();
      });

      it("かんたん操作で 芝にも壁にも出ずに走り切る (1 周 40〜95 秒)", () => {
        const r = soloLap(id, { assist: true });
        expect(r.finished).toBe(true);
        expect(r.grass).toBe(0);
        expect(r.walls).toBe(0);
        expect(r.best).toBeGreaterThan(40);
        expect(r.best).toBeLessThan(95);
      });

      it("一番上手いコンピューターが 壁に当たらず 2 周走り切る (1 周 40〜90 秒)", () => {
        const r = soloLap(id, { skill: BOT_SKILL_MAX });
        expect(r.finished).toBe(true);
        expect(r.walls).toBe(0);
        expect(r.grass).toBeLessThan(0.5);
        expect(r.best).toBeGreaterThan(40);
        expect(r.best).toBeLessThan(90);
      });
    });
  }

  for (const id of REAL_CIRCUIT_IDS) {
    it(`${TRACK_DEFS.find((d) => d.id === id)!.name}: 8 台の部屋のレース (2 周) を走り切る`, () => {
      const sent: ServerMsg[] = [];
      const room = new RaceRoom({ send: () => {}, broadcast: (m) => sent.push(m) }, 2, lcg(12), [id]);
      let now = 0;
      const a = room.join("k1", "走る人", SAMPLE_DESIGN, now) as { id: string };
      // つながったまま走らない人 (部屋を閉じないため)
      room.join("k2", "見る人", SAMPLE_DESIGN, now);
      now += LOBBY_MS + 10;
      room.tick(now);
      expect(room.phase).toBe("race");
      expect(room.info().trackId).toBe(id);
      expect(room.roster().length).toBe(8);
      room.leave(a.id, now);
      for (let i = 0; i < 20 * 400 && room.phase === "race"; i++) {
        now += 50;
        room.tick(now);
      }
      expect(room.phase).toBe("results");
      const res = (sent.filter((m) => m.t === "phase").pop() as Extract<ServerMsg, { t: "phase" }>).info.results!;
      // 見ているだけの人のほかは全員ゴール
      expect(res.filter((x) => x.finished).length).toBe(7);
    });
  }

  it("すぐ走る・リーグ戦 (2 時間ごと)・1 周アタック (毎週) の回し方に入る", () => {
    const all = TRACK_DEFS.map((d) => d.id);
    // すぐ走るの部屋は、公式コースを順に回す (trackTurn)
    const quick = new RaceRoom({ send: () => {}, broadcast: () => {} }, 1) as unknown as { trackIds: string[] };
    expect(quick.trackIds).toEqual(all);
    // 足したコースが回し方に入ったあと (2027 年) の枠と週
    const slot0 = scheduledSlotIndex(Date.UTC(2027, 0, 1));
    const week0 = seasonIndexAt(Date.UTC(2027, 0, 1));
    const league = new Set(all.map((_, i) => scheduledTrackId(scheduledSlotStart(slot0 + i))));
    const ta = new Set(all.map((_, i) => taWeek(week0 + i).trackId));
    for (const id of REAL_CIRCUIT_IDS) {
      expect(league.has(id), id).toBe(true);
      expect(ta.has(id), id).toBe(true);
    }
  });
});
