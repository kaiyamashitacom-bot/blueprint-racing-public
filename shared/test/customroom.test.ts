// 開いた部屋 (11/25 決まり「部屋も開ける (開く人がコース・周回数・級を決める)。合言葉はなし」)
import { describe, expect, it } from "vitest";
import {
  CUSTOM_LOBBY_MS,
  CUSTOM_START_MIN,
  LOBBY_MS,
  RESULTS_MS,
  RaceRoom,
  SAMPLE_DESIGN,
  TRACK_DEFS,
  getTrack,
  tireSetLimit,
  type CustomRoomConfig,
  type RoomSnapshot,
  type ServerMsg,
  type TrackDef,
} from "../src/index.ts";

const CFG: CustomRoomConfig = { id: "abc123def", trackId: TRACK_DEFS[1].id, laps: 7, cls: 3, hostAccount: 42, hostName: "開く人" };

function setup(cfg: CustomRoomConfig = CFG) {
  const sent: Array<{ to: string; msg: ServerMsg }> = [];
  let r = 5;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const io = { send: (to: string, msg: ServerMsg) => sent.push({ to, msg }), broadcast: (msg: ServerMsg) => sent.push({ to: "*", msg }) };
  const room = new RaceRoom(io, cfg.laps, rand);
  room.setCustom(cfg);
  return { room, sent, io };
}

describe("開いた部屋", () => {
  it("待合は CUSTOM_LOBBY_MS。部屋の札 (id・級・開いた人) が info に付く。すぐ走るの部屋には付かない", () => {
    const { room } = setup();
    expect(room.phase).toBe("idle");
    room.join("k1", "A", SAMPLE_DESIGN, 1000);
    expect(room.phase).toBe("lobby");
    const info = room.info();
    expect(info.endsAt).toBe(1000 + CUSTOM_LOBBY_MS);
    expect(info.trackId).toBe(CFG.trackId);
    expect(info.laps).toBe(7);
    expect(info.room).toEqual({ id: CFG.id, cls: 3, host: "開く人" });
    const quick = new RaceRoom({ send: () => {}, broadcast: () => {} }, 2);
    quick.join("k", "Q", SAMPLE_DESIGN, 0);
    expect(quick.info().room).toBeUndefined();
    expect(quick.info().endsAt).toBe(LOBBY_MS);
  });

  it("早めのスタートは人が 2 人から。始めると空きはコンピューターで 8 台、コースは決めたもの", () => {
    const { room } = setup();
    room.join("k1", "A", SAMPLE_DESIGN, 0);
    const one = room.startNow(10);
    expect(one.ok).toBe(false);
    expect(room.phase).toBe("lobby");
    room.join("k2", "B", SAMPLE_DESIGN, 20);
    expect(CUSTOM_START_MIN).toBe(2);
    const ok = room.startNow(30);
    expect(ok.ok).toBe(true);
    expect(room.phase).toBe("race");
    expect(room.roster().length).toBe(8);
    expect(room.info().trackId).toBe(CFG.trackId);
    // レース中はもう早められない
    expect(room.startNow(40).ok).toBe(false);
  });

  it("待合が終われば 1 人でも始まる。次のレースも同じコース。持っていく組は 周 ÷ 3 + 1", () => {
    const { room } = setup();
    let now = 0;
    const a = room.join("k1", "A", SAMPLE_DESIGN, now) as { id: string };
    now += CUSTOM_LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bots = [...((room as any).entrants as Map<string, { bot: boolean; car: { sets: unknown } }>).values()].filter((e) => e.bot);
    const limit = tireSetLimit("custom", 7);
    expect(limit).toBe(Math.ceil(7 / 3) + 1);
    for (const b of bots) {
      const sets = b.car.sets as { fresh: Record<string, number>; used: unknown[] };
      const n = Object.values(sets.fresh).reduce((x, y) => x + (y ?? 0), 0) + sets.used.length + 1;
      expect(n).toBeLessThanOrEqual(limit);
    }
    // 人はゴールしたことにして、残りを終わらせる
    room.onMessage(a.id, { t: "finish", time: 300, lapsDone: 7, best: 40, penalty: 0 }, now + 1000);
    for (let i = 0; i < 40 * 60 * 20 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    now += RESULTS_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("lobby");
    expect(room.info().trackId).toBe(CFG.trackId);
  });

  it("みんな抜けたら閉じ、もう入れない (一覧から選び直す)", () => {
    const { room } = setup();
    const a = room.join("k1", "A", SAMPLE_DESIGN, 0) as { id: string };
    room.leave(a.id, 10);
    expect(room.phase).toBe("idle");
    expect(room.customConfig()?.closed).toBe(true);
    const again = room.join("k1", "A", SAMPLE_DESIGN, 20);
    expect(again.ok).toBe(false);
  });

  it("眠って戻しても開いた部屋のまま (コース・待合の長さ・開いた人)", () => {
    const { room, io } = setup();
    room.join("k1", "A", SAMPLE_DESIGN, 0);
    const snap: RoomSnapshot = JSON.parse(JSON.stringify(room.snapshot()));
    expect(snap.custom?.id).toBe(CFG.id);
    const back = RaceRoom.restore(io, snap, 100);
    expect(back.customConfig()?.hostAccount).toBe(42);
    expect(back.info().room?.id).toBe(CFG.id);
    back.tick(CUSTOM_LOBBY_MS + 10);
    expect(back.phase).toBe("race");
    expect(back.info().trackId).toBe(CFG.trackId);
  });

  it("席の様子: 人と 2 台目の数 (一覧に出す)", () => {
    const { room } = setup();
    room.join("k1", "A", SAMPLE_DESIGN, 0, () => {}, { second: { driverId: "d1", name: "雇い", design: SAMPLE_DESIGN, driver: { speed: 50, stability: 50, tyreFuel: 50, pitSense: 50 } } });
    room.join("k2", "B", SAMPLE_DESIGN, 0);
    expect(room.seatsInfo()).toEqual({ humans: 2, cars: 3 });
  });

  it("みんなのコースの形を渡すと、部屋で getTrack できる (眠って戻しても)", () => {
    const base = TRACK_DEFS[0];
    const def: TrackDef = { ...base, id: "pub:77", name: "みんなの試し", points: base.points.map(([x, y]) => [x * 1.2, y * 1.2] as [number, number]) };
    const { room, io } = setup({ ...CFG, id: "pubroom01", trackId: "pub:77", trackDef: def });
    expect(getTrack("pub:77").def.name).toBe("みんなの試し");
    room.join("k1", "A", SAMPLE_DESIGN, 0);
    const snap: RoomSnapshot = JSON.parse(JSON.stringify(room.snapshot()));
    const back = RaceRoom.restore(io, snap, 10);
    expect(back.info().trackId).toBe("pub:77");
  });
});
