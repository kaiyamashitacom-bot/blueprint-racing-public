import { describe, expect, it } from "vitest";
import { BOT_DESIGNS, LATE_JOIN_CAP_MS, LATE_JOIN_MS, LOBBY_MS, RESULTS_MS, RaceRoom, SAMPLE_DESIGN, computeStats, type RoomSnapshot, type ServerMsg } from "../src/index.ts";

function setup(laps = 1) {
  const sent: Array<{ to: string; msg: ServerMsg }> = [];
  let r = 7;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const room = new RaceRoom({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: "*", msg }) }, laps, rand);
  return { room, sent };
}

describe("部屋", () => {
  it("コンピューターの車の強さに幅がある", () => {
    const tops = BOT_DESIGNS.map((d) => computeStats(d).topSpeed);
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(3);
  });

  it("1 人入ると待合 → レース (空きはコンピューター) → 結果 → 待合", () => {
    const { room, sent } = setup(1);
    let now = 1000;
    const j = room.join("k1", "テスト", SAMPLE_DESIGN, now);
    expect(j.ok).toBe(true);
    expect(room.phase).toBe("lobby");
    // もう 1 人 (つながったまま、位置は送ってこない)
    room.join("k2", "見る人", SAMPLE_DESIGN, now);
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    expect(room.roster().length).toBe(8);
    // 1 人目は通信が切れて、コンピューターが代わりに運転
    room.leave((j as { id: string }).id, now);
    for (let i = 0; i < 20 * 200 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    const res = (sent.filter((s) => s.msg.t === "phase").pop()!.msg as Extract<ServerMsg, { t: "phase" }>).info.results!;
    expect(res.length).toBe(8);
    expect(res[0].finished).toBe(true);
    expect(res[0].points).toBeGreaterThanOrEqual(25);
    const me = res.find((x) => x.name === "テスト")!;
    expect(me.finished).toBe(true);
    now += RESULTS_MS + 1000;
    room.tick(now);
    expect(room.phase).toBe("lobby");
  });

  it("同じ key でつなぎ直すと続きから走れる", () => {
    const { room, sent } = setup(2);
    let now = 0;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now) as { id: string };
    room.join("kb", "B", SAMPLE_DESIGN, now);
    now += LOBBY_MS + 10;
    room.tick(now);
    now += 12_000;
    room.tick(now);
    room.leave(a.id, now);
    for (let i = 0; i < 100; i++) {
      now += 50;
      room.tick(now);
    }
    const again = room.join("ka", "A", SAMPLE_DESIGN, now) as { id: string };
    expect(again.id).toBe(a.id);
    const resume = sent.find((s) => s.to === a.id && s.msg.t === "resume");
    expect(resume).toBeTruthy();
  });

  it("1 人だけで切れても 60 秒以内なら続きから", () => {
    const { room, sent } = setup(2);
    let now = 0;
    const a = room.join("solo", "ひとり", SAMPLE_DESIGN, now) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    now += 12_000;
    room.tick(now);
    room.leave(a.id, now);
    now += 20_000;
    room.tick(now);
    expect(room.phase).toBe("race");
    room.join("solo", "ひとり", SAMPLE_DESIGN, now);
    expect(sent.some((s) => s.to === a.id && s.msg.t === "resume")).toBe(true);
  });

  it("全員切れて 60 秒たつと部屋は休む", () => {
    const { room } = setup(2);
    let now = 0;
    const a = room.join("solo", "ひとり", SAMPLE_DESIGN, now) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    room.leave(a.id, now);
    now += 61_000;
    room.tick(now);
    expect(room.phase).toBe("idle");
  });

  it("待合で見せるコースが、そのまま走るコース (次の待合は次のコース)", () => {
    const { room, sent } = setup(1);
    let now = 0;
    room.join("k1", "A", SAMPLE_DESIGN, now);
    const lobby1 = room.info().trackId;
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    expect(room.info().trackId).toBe(lobby1);
    for (let i = 0; i < 20 * 400 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    // 結果はまだ走ったコース
    expect(room.info().trackId).toBe(lobby1);
    now += RESULTS_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("lobby");
    const lobby2 = room.info().trackId;
    expect(lobby2).not.toBe(lobby1);
    // 待合の知らせにも次のコースが載る
    const last = sent.filter((x) => x.msg.t === "phase").pop()!.msg as Extract<ServerMsg, { t: "phase" }>;
    expect(last.info.trackId).toBe(lobby2);
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    expect(room.info().trackId).toBe(lobby2);
  });

  it("待合の終わり近くに入った人にも、準備の時間を LATE_JOIN_MS 残す (伸ばすのは LATE_JOIN_CAP_MS まで)", () => {
    const { room } = setup(1);
    room.join("k1", "A", SAMPLE_DESIGN, 0);
    const end0 = room.info().endsAt;
    expect(end0).toBe(LOBBY_MS);
    // 残り 8 秒で入る: 10 秒に伸びる
    room.join("k2", "B", SAMPLE_DESIGN, LOBBY_MS - 8000);
    expect(room.info().endsAt).toBe(LOBBY_MS - 8000 + LATE_JOIN_MS);
    // 残り十分なら伸ばさない (つなぎ直しも伸ばさない)
    room.join("k1", "A", SAMPLE_DESIGN, LOBBY_MS - 7000);
    expect(room.info().endsAt).toBe(LOBBY_MS - 8000 + LATE_JOIN_MS);
    // 何度も遅れて入っても、はじめの終わり + LATE_JOIN_CAP_MS まで
    let now = room.info().endsAt - 1000;
    for (let i = 3; i < 7; i++) {
      room.tick(now);
      expect(room.phase).toBe("lobby");
      room.join(`k${i}`, `P${i}`, SAMPLE_DESIGN, now);
      now = room.info().endsAt - 500;
    }
    expect(room.info().endsAt).toBe(end0 + LATE_JOIN_CAP_MS);
    room.tick(end0 + LATE_JOIN_CAP_MS + 1);
    expect(room.phase).toBe("race");
  });

  it("まちがった設計図は入れない", () => {
    const { room } = setup();
    const j = room.join("k", "x", { name: "x", parts: [] }, 0);
    expect(j.ok).toBe(false);
  });
});

describe("部屋を残して戻す (サーバーが眠ったあと)", () => {
  /** JSON を通して戻す (storage に入れて出すのと同じ) */
  function roundTrip(room: RaceRoom, now: number) {
    const data = JSON.parse(JSON.stringify(room.snapshot())) as RoomSnapshot;
    const sent: Array<{ to: string; msg: ServerMsg }> = [];
    const back = RaceRoom.restore({ send: (to, msg) => sent.push({ to, msg }), broadcast: (msg) => sent.push({ to: "*", msg }) }, data, now);
    return { back, sent, data };
  }

  it("待合: 段階・時刻・顔ぶれ・天気が戻り、同じ key でつなぎ直せて、時刻が来ればレースになる", () => {
    const { room } = setup(2);
    let now = 1000;
    const a = room.join("ka", "A", SAMPLE_DESIGN, now) as { id: string };
    room.join("kb", "B", SAMPLE_DESIGN, now);
    const { back } = roundTrip(room, now + 500);
    expect(back.info()).toEqual(room.info());
    expect(back.roster()).toEqual(room.roster());
    expect(back.snapshot()).toEqual(room.snapshot());
    const shown = back.info().trackId;
    expect((back.join("ka", "A", SAMPLE_DESIGN, now + 600) as { id: string }).id).toBe(a.id);
    // 新しく入った人の id はかぶらない
    const c = back.join("kc", "C", SAMPLE_DESIGN, now + 700) as { id: string };
    expect(["p1", "p2"]).not.toContain(c.id);
    now += LOBBY_MS + 10;
    back.tick(now);
    expect(back.phase).toBe("race");
    expect(back.info().weather).toEqual(room.info().weather);
    // 待合で見せていたコースのまま走る
    expect(back.info().trackId).toBe(shown);
    expect(back.roster().length).toBe(8);
  });

  it("結果: 結果が戻り、時刻が来れば待合へ (コンピューターは外れる)", () => {
    const { room } = setup(1);
    let now = 0;
    room.join("k1", "A", SAMPLE_DESIGN, now);
    now += LOBBY_MS + 10;
    room.tick(now);
    for (let i = 0; i < 20 * 400 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    const { back } = roundTrip(room, now + 1000);
    expect(back.phase).toBe("results");
    expect(back.info()).toEqual(room.info());
    expect(back.info().results!.length).toBe(8);
    back.tick(now + 1000);
    expect(back.phase).toBe("results");
    back.tick(now + RESULTS_MS + 10);
    expect(back.phase).toBe("lobby");
    expect(back.roster().map((r) => r.name)).toEqual(["A"]);
    // コースは順番どおり次へ
    back.tick(now + RESULTS_MS + 10 + LOBBY_MS + 10);
    room.tick(now + RESULTS_MS + 10);
    room.tick(now + RESULTS_MS + 10 + LOBBY_MS + 10);
    expect(back.info().trackId).toBe(room.info().trackId);
  });

  it("レースの途中で残したものは、つながっている人だけで待合からやり直す", () => {
    const { room } = setup(2);
    let now = 0;
    room.join("ka", "A", SAMPLE_DESIGN, now);
    const b = room.join("kb", "B", SAMPLE_DESIGN, now) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    room.leave(b.id, now);
    const { back, sent } = roundTrip(room, now + 100);
    expect(back.phase).toBe("lobby");
    expect(back.info().endsAt).toBe(now + 100 + LOBBY_MS);
    expect(back.roster().map((r) => r.name)).toEqual(["A"]);
    expect(sent.length).toBe(0);
  });

  it("誰もつながっていないレースを戻すと休む", () => {
    const { room } = setup(2);
    const a = room.join("ka", "A", SAMPLE_DESIGN, 0) as { id: string };
    room.tick(LOBBY_MS + 10);
    room.leave(a.id, LOBBY_MS + 10);
    const { back } = roundTrip(room, LOBBY_MS + 100);
    expect(back.phase).toBe("idle");
    expect(back.roster().length).toBe(0);
  });
});
