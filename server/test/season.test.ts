// 季節・級・大会・管理者の数の保存と受け口の試験。DO の SQLite の代わりに node:sqlite を使う (team.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  BOT_SKILL_MAX,
  DEFAULT_ADMIN_CONFIG,
  DT,
  SAMPLE_DESIGN,
  TA_CONDITIONS,
  botInput,
  computeStats,
  createCar,
  designHash,
  encodeGhost,
  getTrack,
  makeBrain,
  newLapState,
  seasonIndexAt,
  seasonWindow,
  stepCar,
  updateLaps,
  type FixedCarResult,
} from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { TeamStore } from "../src/team.ts";
import { LOBBY_LEAD_MS, SeasonStore, humanDriverId, type RaceFeed } from "../src/season.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function makeAll(admins: string[] = ["boss"]) {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec(q: string, ...b: SqlValue[]) {
      const rows = db.prepare(q).all(...(b as Array<string | number | null>)) as Array<Record<string, SqlValue>>;
      return { toArray: () => rows };
    },
  };
  const tx = <T,>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  // 季節 1 の火曜の昼 (日本時間)
  const w = seasonWindow(1);
  const clock = { t: w.startsAt + DAY + 3 * HOUR };
  const store = new AccountStore({ sql, tx, now: () => clock.t, iterations: 1000, adminIds: admins });
  const team = new TeamStore({ sql, tx, now: () => clock.t }, store);
  const season = new SeasonStore({ sql, tx, now: () => clock.t, teamInfo: (acc, d) => team.raceTeam(acc, d) }, store);
  const ticks: unknown[] = [];
  return { db, store, team, season, clock, ticks };
}

type All = ReturnType<typeof makeAll>;

async function user(all: All, login: string, n: number) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `8.8.8.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApi(
      new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      all.store,
      undefined,
      all.team,
      all.season,
      { tick: async () => all.ticks.push(all.season.tick()) },
    );
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: login, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(login)!.id);
  return { call, id };
}

const money = (all: All, id: number) => Number(all.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);

/** 2 人 + コンピューター 6 台のレース。a が 1 位、b が 2 位。b は代走 */
function feed(raceId: string, at: number, a: number, b: number, extra: Partial<RaceFeed> = {}): RaceFeed {
  return {
    raceId,
    at,
    laps: 5,
    trackId: "aozu",
    humans: 2,
    maxWet: 0,
    cars: [
      { id: "p1", pos: 1, finished: true, fastest: true, penalty: 0, accountId: a, gridPos: 1, pitStops: 1 },
      { id: "p2", pos: 2, finished: true, fastest: false, penalty: 0, accountId: b, standIn: true, gridPos: 3, pitStops: 1 },
      ...[3, 4, 5, 6, 7, 8].map((pos) => ({ id: `b${pos}`, pos, finished: true, fastest: false, penalty: 0 })),
    ],
    ...extra,
  };
}

describe("普段のレースを季節に足す", () => {
  it("同じレースは 1 回だけ。点・賞金 (管理者の数)・はんこ・代走はチームだけ", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const b = await user(all, "bob", 2);
    const m0 = money(all, a.id);
    const r1 = all.season.recordRace(feed("r1", all.clock.t, a.id, b.id));
    expect(r1.counted).toBe(true);
    // 優勝 25 + 最速の周 1 = 26 点。賞金 = (26 × 20 + 30) × 1.75
    expect(r1.paid[a.id].car1).toBe(Math.round((26 * 20 + 30) * 1.75));
    expect(money(all, a.id)).toBe(m0 + r1.paid[a.id].car1);
    expect(all.season.recordRace(feed("r1", all.clock.t, a.id, b.id)).counted).toBe(false);
    const t = all.season.tally();
    expect(t.teams[String(a.id)].points).toBe(26);
    expect(t.teams[String(b.id)].points).toBe(18);
    // 代走の点は運転手順位に入らない
    expect(t.drivers[humanDriverId(a.id)].points).toBe(26);
    expect(t.drivers[humanDriverId(b.id)]).toBeUndefined();
    // はんこ: 優勝・表彰台・最速の周・先頭から逃げ切り (代走の b は無し)
    const sa = all.season.myStamps(a.id);
    expect(sa.stamps.map((s) => s.id)).toEqual(expect.arrayContaining(["win", "podium", "fastest_lap", "pole_to_win"]));
    expect(all.season.myStamps(b.id).stamps.length).toBe(0);
    // 管理者が 1 点の値段を変えると賞金も変わる
    all.season.setConfig({ prizePerPoint: 100 });
    const r2 = all.season.recordRace(feed("r2", all.clock.t, a.id, b.id));
    expect(r2.paid[a.id].car1).toBe(Math.round((26 * 100 + 30) * 1.75));
  });

  it("2 台目 (雇った運転手) は運転手順位にも入り、賞金はチームへ", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const f = feed("r3", all.clock.t, a.id, a.id);
    f.cars[1] = { id: "t2", pos: 2, finished: true, fastest: false, penalty: 0, ownerAccountId: a.id, hiredDriverId: "d7" };
    f.humans = 1;
    const r = all.season.recordRace(f);
    expect(r.paid[a.id].car2).toBeGreaterThan(0);
    const t = all.season.tally();
    expect(t.teams[String(a.id)].points).toBe(Math.round((26 + 18) * DEFAULT_ADMIN_CONFIG.season.cpuOnlyMul));
    expect(t.drivers.d7.teamId).toBe(String(a.id));
    // 季節の画面
    const v = await a.call("GET", "/api/season");
    expect(v.status).toBe(200);
    expect(v.data.me.playClass).toBe(5);
    expect(v.data.classes.find((c: any) => c.cls === 5).teams[0].me).toBe(true);
    expect(v.data.drivers.map((d: any) => d.id)).toEqual(expect.arrayContaining(["d7", humanDriverId(a.id)]));
  });
});

describe("季節の締め", () => {
  it("月曜 0 時に 1 回だけ: 級が付き、賞金・チャンピオン・記録・はんこ・表示名を変えてよい印", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const b = await user(all, "bob", 2);
    const c = await user(all, "carol", 3);
    all.season.recordRace(feed("r1", all.clock.t, a.id, b.id));
    all.season.addLeagueDay("day-1", { [String(c.id)]: 30 }, { divisions: { [String(a.id)]: 8 } });
    expect(all.season.addLeagueDay("day-1", { [String(c.id)]: 30 })).toBe(false);
    const before = { a: money(all, a.id), b: money(all, b.id), c: money(all, c.id) };
    const season = all.season.tally().season;
    all.clock.t = seasonWindow(season).endsAt + 1000;
    const r = all.season.tick();
    expect(r.closed).toEqual([season]);
    // もう一度呼んでも同じ季節は締めない
    expect(all.season.tick().closed).toEqual([]);
    expect(all.season.tally().season).toBe(season + 1);
    // 級なしの新しいチームは一番下の級の 1 位なら 4 級、ほかは 5 級
    expect(all.season.classOf(a.id)).toBe(4);
    expect(all.season.classOf(b.id)).toBe(5);
    expect(all.season.classOf(c.id)).toBe(5);
    // 賞金: a は級の 1 位 (30000 × 1) + 級のドライバーズ (2500 × 1) + 総合のドライバーズ (20000)。
    //       コンストラクターはリーグ戦の分が多い c (5 級と総合)
    const cfg = DEFAULT_ADMIN_CONFIG;
    expect(money(all, a.id) - before.a).toBe(cfg.seasonPrize[0] * cfg.seasonPrizeClassMul[4] + cfg.driverChampionPrize + cfg.driverOverallPrize);
    expect(money(all, c.id) - before.c).toBe(cfg.constructorPrize * cfg.constructorPrizeClassMul[4] + cfg.constructorOverallPrize);
    expect(money(all, b.id) - before.b).toBe(cfg.seasonPrize[1] * cfg.seasonPrizeClassMul[4]);
    // 記録とまとめ
    const ha = all.season.myStamps(a.id).history[0];
    expect(ha).toMatchObject({ season, cls: null, classRank: 1, nextCls: 4, driverChampion: "overall", division: 8 });
    expect(ha.stamps).toEqual(expect.arrayContaining(["win", "class_champion", "driver_champion"]));
    expect(all.season.myStamps(c.id).history[0].constructor).toBe("overall");
    const sum = all.season.seasonHistory()[0];
    expect(sum.overallConstructor?.team).toBe("チーム3");
    expect(sum.overallDriver?.name).toBe("運転手1");
    // 表示名を変えてよい
    const me = await a.call("GET", "/api/me");
    expect(me.data.me.namesFree).toBe(true);
    expect(me.data.me.cls).toBe(4);
    // 点は 0 から
    expect(Object.keys(all.season.tally().teams).length).toBe(0);
    // 知らせ
    const n = all.db.prepare("SELECT text FROM notices WHERE account_id = ? AND id = ?").get(a.id, `season:${season}`) as { text: string };
    expect(n.text).toContain("1 位");
  });

  it("何季節も眠っていても 1 季節ずつ締める", async () => {
    const all = makeAll();
    await user(all, "alice", 1);
    const s0 = all.season.tally().season;
    all.clock.t = seasonWindow(s0 + 3).startsAt + 10;
    expect(all.season.tick().closed).toEqual([s0, s0 + 1, s0 + 2]);
    expect(all.season.tally().season).toBe(seasonIndexAt(all.clock.t));
  });
});

describe("管理者", () => {
  it("管理者だけが数を変え、遊ぶ人の一覧を見られる", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const p = await user(all, "alice", 2);
    expect((await p.call("GET", "/api/admin/config")).status).toBe(403);
    const g = await boss.call("GET", "/api/admin/config");
    expect(g.status).toBe(200);
    expect(g.data.config.prizePerPoint).toBe(DEFAULT_ADMIN_CONFIG.prizePerPoint);
    const bad = await boss.call("PUT", "/api/admin/config", { marketFeeRate: 3 });
    expect(bad.status).toBe(400);
    const ok = await boss.call("PUT", "/api/admin/config", { prizePerPoint: 40, season: { tournamentMul: 12 } });
    expect(ok.status).toBe(200);
    expect(ok.data.config.season).toMatchObject({ tournamentMul: 12, everydayMul: 1 });
    expect((await boss.call("POST", "/api/admin/config/reset")).data.config.prizePerPoint).toBe(DEFAULT_ADMIN_CONFIG.prizePerPoint);
    // 走りの決まり (誰でも読める) に 部品の強さの倍率と練習の賞金が出る
    await boss.call("PUT", "/api/admin/config", { partStrength: 1.2, partKindStrength: { engine: 1.1 }, practicePrizeDailyLaps: 30 });
    const rules = (await p.call("GET", "/api/race-rules")).data;
    expect(rules).toMatchObject({ partStrength: 1.2, partKindStrength: { engine: 1.1, tire: 1 }, practicePrizePerLap: DEFAULT_ADMIN_CONFIG.practicePrizePerLap, practicePrizeDailyLaps: 30 });
    const pl = await boss.call("GET", "/api/admin/players");
    expect(pl.data.players.map((x: any) => x.login)).toEqual(["alice", "boss"]);
    expect(pl.data.players.find((x: any) => x.login === "boss").admin).toBe(true);
    // 作るときの時計は devClock を渡したときだけ
    expect((await boss.call("POST", "/api/admin/dev/clock", { offsetMs: 1000 })).status).toBe(404);
  });
});

/** 一番上手なコンピューターの 2 周目 (1 周アタックと同じ確かめを通る周) */
function botLap(trackId: string, skill = BOT_SKILL_MAX): { lap: number; pts: number[] } {
  const track = getTrack(trackId);
  const stats = computeStats(SAMPLE_DESIGN);
  const car = createCar(track, stats, 0, { tire: TA_CONDITIONS.tire, fuel: stats.fuelCap });
  car.started = true;
  const brain = makeBrain(() => 0.5, skill);
  const st = newLapState();
  let t = 0;
  let rec: number[] = [];
  let next = 0;
  let laps = 0;
  while (t < 600) {
    const ev = stepCar(car, botInput(car, stats, track, brain, t, [], 0), stats, track, DT, { damage: false });
    t += DT;
    const le = updateLaps(car, st, ev, t, track.length, 3, false);
    if (t >= next - 1e-9) {
      rec.push(Math.round(car.x * 10) / 10, Math.round(car.y * 10) / 10, Math.round(car.heading * 100) / 100);
      next += 0.1;
    }
    if (le.lap && ++laps === 2) return { lap: le.lap.time, pts: rec };
    if (le.lap) {
      rec = [];
      next = st.lapStart;
    }
  }
  throw new Error("走り切れなかった");
}

describe("大会", () => {
  const fast = botLap("aozu");
  const slow = botLap("aozu", 0.85);
  const run = (l: { lap: number; pts: number[] } | null, pick: unknown, endWear: number) => ({
    pick,
    endWear,
    ...(l ? { lap: l.lap, ghost: encodeGhost(l.pts), designHash: designHash(SAMPLE_DESIGN) } : {}),
    design: SAMPLE_DESIGN,
  });

  it("作る → 予選 (タイヤの組は持ち越し) → 組を開く → 組の結果 → 点 ×10・賞金・失格", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const b = await user(all, "bob", 3);
    const c = await user(all, "carol", 4);
    // 3 日後の 20 時 (日本時間) に 2 周
    const day = seasonWindow(all.season.tally().season).startsAt;
    const startsAt = day + 3 * DAY + 20 * HOUR;
    expect((await a.call("POST", "/api/admin/tournaments", { name: "x", startsAt, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" } })).status).toBe(403);
    const bad = await boss.call("POST", "/api/admin/tournaments", { name: "x", startsAt: all.clock.t - 1, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" } });
    expect(bad.status).toBe(400);
    const cr = await boss.call("POST", "/api/admin/tournaments", { name: "冬の杯", startsAt, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" }, groupSize: 2 });
    expect(cr.status).toBe(201);
    const id = cr.data.tournament.id as string;
    expect(cr.data.groupSize).toBe(2);
    const list = await a.call("GET", "/api/tournaments");
    expect(list.data.tournaments[0]).toMatchObject({ id, phase: "qualifying", laps: 2 });

    // 予選: 先にタイヤの組 (大会 2 周の上限 2 + 予選 2 = 4 組、乾いた路面用 2 種類)
    expect((await a.call("POST", `/api/tournaments/${id}/quali`, run(fast, { tire: "S" }, 0.1))).status).toBe(400);
    expect((await a.call("POST", `/api/tournaments/${id}/tires`, { alloc: { S: 5 } })).status).toBe(400);
    expect((await a.call("POST", `/api/tournaments/${id}/tires`, { alloc: { S: 2, M: 2 } })).status).toBe(200);
    const q1 = await a.call("POST", `/api/tournaments/${id}/quali`, run(slow, { tire: "S" }, 0.12));
    expect(q1.status).toBe(200);
    expect(q1.data).toMatchObject({ improved: true, rank: 1 });
    // 使った組は減ったまま残る。組はもう変えられない
    expect(q1.data.tires.sets.used).toEqual([{ tire: "S", wear: 0.12 }]);
    expect((await a.call("POST", `/api/tournaments/${id}/tires`, { alloc: { S: 1, M: 3 } })).status).toBe(409);
    const q2 = await a.call("POST", `/api/tournaments/${id}/quali`, run(fast, { tire: "S", used: 0 }, 0.2));
    expect(q2.data.improved).toBe(true);
    expect(q2.data.tires.sets.used).toEqual([{ tire: "S", wear: 0.2 }]);
    // ずるの周は断る
    expect((await a.call("POST", `/api/tournaments/${id}/quali`, run({ lap: fast.lap * 0.5, pts: fast.pts }, { tire: "M" }, 0.1))).status).toBe(400);
    // b は遅い周、c は組だけ決めて走らない
    await b.call("POST", `/api/tournaments/${id}/tires`, { alloc: { M: 2, H: 2 } });
    await b.call("POST", `/api/tournaments/${id}/quali`, run(slow, { tire: "M" }, 0.1));
    await c.call("POST", `/api/tournaments/${id}/tires`, { alloc: { M: 2, H: 2 } });
    await c.call("POST", `/api/tournaments/${id}/plan`, { design: SAMPLE_DESIGN, fuel: "full", start: { tire: "H" } });
    const pl = await a.call("POST", `/api/tournaments/${id}/plan`, { start: { tire: "M" }, fuel: "race" });
    expect(pl.data.raceSetup.tire).toBe("M");
    const v = await a.call("GET", `/api/tournaments/${id}`);
    expect(v.data.qualifying.map((r: any) => r.driver)).toEqual(["運転手2", "運転手3"]);
    expect(v.data.qualifying[0]).toMatchObject({ group: "A", me: true });

    // 知らせ (24 時間前)
    all.clock.t = startsAt - 23 * HOUR;
    all.season.tick();
    expect(all.db.prepare("SELECT COUNT(*) AS c FROM notices WHERE kind = 'tournament_soon'").get()!.c).toBe(4);
    all.season.tick();
    expect(all.db.prepare("SELECT COUNT(*) AS c FROM notices WHERE kind = 'tournament_soon'").get()!.c).toBe(4);

    // 予選が締まったら走れない
    all.clock.t = startsAt - 2 * HOUR;
    expect((await a.call("POST", `/api/tournaments/${id}/quali`, run(fast, { tire: "M" }, 0.1))).status).toBe(409);

    // スタートの 10 分前: 組を開く (予選の順: A = a, b / B = c (記録なし))
    all.clock.t = startsAt - LOBBY_LEAD_MS;
    const t1 = all.season.tick();
    expect(t1.launch.map((f) => f.tag)).toEqual([`${id}:0`, `${id}:1`]);
    const fa = t1.launch[0];
    expect(fa.cars.map((x) => x.key)).toEqual([`acc:${a.id}`, `acc:${b.id}`]);
    expect(fa.cars[0].setup).toMatchObject({ tire: "M", wear: 0 });
    // c の予定のタイヤ (硬い) と満タン
    const fc = t1.launch[1].cars[0];
    expect(fc.setup?.tire).toBe("H");
    expect(fc.setup?.fuel).toBe(computeStats(SAMPLE_DESIGN).fuelCap);
    all.season.markPushed(`${id}:0`);
    expect(all.season.tick().launch.map((f) => f.tag)).toEqual([`${id}:1`]);
    all.season.markPushed(`${id}:1`);

    // 組の結果: A は a が 1 位 (乾いた路面用を 2 種類) / b は 2 位 (1 種類だけ = 失格)。B は c (代走) 1 位
    const row = (key: string, team: number, pos: number, stints: FixedCarResult["stints"], standIn = false): FixedCarResult => ({
      key,
      teamId: String(team),
      driverId: humanDriverId(team),
      kind: "human",
      pos,
      gridPos: pos,
      finished: true,
      retired: false,
      lapsDone: 2,
      best: 30 + pos,
      penalty: 0,
      pitStops: stints.length - 1,
      standIn,
      stints,
      maxWet: 0,
    });
    all.clock.t = startsAt + 5 * 60_000;
    expect(
      all.season.recordTournamentGroup(
        `${id}:0`,
        [
          row(`acc:${a.id}`, a.id, 1, [
            { tire: "M", meters: 900, dry: true },
            { tire: "H", meters: 900, dry: true },
          ]),
          row(`acc:${b.id}`, b.id, 2, [{ tire: "M", meters: 1800, dry: true }]),
        ],
        all.clock.t,
      ),
    ).toBe(false);
    const ma = money(all, a.id);
    const mc = money(all, c.id);
    expect(
      all.season.recordTournamentGroup(
        `${id}:1`,
        [
          row(`acc:${c.id}`, c.id, 1, [
            { tire: "H", meters: 900, dry: true },
            { tire: "M", meters: 900, dry: true },
          ], true),
        ],
        all.clock.t,
      ),
    ).toBe(true);
    const res = (await a.call("GET", `/api/tournaments/${id}`)).data;
    expect(res.tournament.phase).toBe("done");
    expect(res.results.map((r: any) => [r.name, r.finalPos, r.dq, r.group])).toEqual([
      ["運転手2", 1, false, "A"],
      ["運転手4", 2, false, "B"],
      ["運転手3", 3, true, "A"],
    ]);
    const cfg = DEFAULT_ADMIN_CONFIG;
    expect(money(all, a.id) - ma).toBe(cfg.tournamentPrize[0]);
    expect(money(all, c.id) - mc).toBe(cfg.tournamentPrize[1]);
    // 点は ×10 (3 台: 1 位だけ 25 点 + 最速の周)。代走の c はチームだけ
    const t = all.season.tally();
    expect(t.teams[String(a.id)].tournamentPoints).toBe(260);
    // 代走の運転手には 1/5 (切り捨て) × 10。2 位 (3 台) は 0 点
    expect(t.drivers[humanDriverId(c.id)]).toMatchObject({ points: 0, races: 1 });
    expect(all.season.myStamps(a.id).stamps.map((s) => s.id)).toEqual(expect.arrayContaining(["tournament_win", "win"]));
    // 2 回目は数えない
    expect(all.season.finalizeTournament(id, true)).toBe(false);
  });

  it("管理者が止めた人のチームは大会に出ない (予選を走っていても)", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const b = await user(all, "bob", 3);
    const day = seasonWindow(all.season.tally().season).startsAt;
    const startsAt = day + 3 * DAY + 20 * HOUR;
    const cr = await boss.call("POST", "/api/admin/tournaments", { name: "杯", startsAt, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" } });
    const id = cr.data.tournament.id as string;
    for (const u of [a, b]) {
      expect((await u.call("POST", `/api/tournaments/${id}/tires`, { alloc: { S: 2, M: 2 } })).status).toBe(200);
      expect((await u.call("POST", `/api/tournaments/${id}/quali`, run(fast, { tire: "S" }, 0.1))).status).toBe(200);
    }
    all.store.adminSetSuspended(all.store.getAccount(boss.id)!, { id: "bob", suspended: true });
    all.clock.t = startsAt - LOBBY_LEAD_MS;
    const t1 = all.season.tick();
    expect(t1.launch.flatMap((f) => f.cars.map((x) => x.key))).toEqual([`acc:${a.id}`]);
  });

  it("締め切りを過ぎたら届いた組だけで決める・取りやめ・直す", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const day = seasonWindow(all.season.tally().season).startsAt;
    const startsAt = day + 2 * DAY + 21 * HOUR;
    const cr = await boss.call("POST", "/api/admin/tournaments", { name: "杯", startsAt, trackId: "aozu", laps: 3, weather: { mode: "random", seed: 5 } });
    const id = cr.data.tournament.id;
    const ed = await boss.call("PUT", `/api/admin/tournaments/${id}`, { laps: 4, name: "春の杯" });
    expect(ed.data.tournament).toMatchObject({ laps: 4, name: "春の杯" });
    await a.call("POST", `/api/tournaments/${id}/tires`, { alloc: { M: 2, H: 2 } });
    await a.call("POST", `/api/tournaments/${id}/plan`, { design: SAMPLE_DESIGN });
    all.clock.t = startsAt - LOBBY_LEAD_MS + 1;
    expect(all.season.tick().launch.length).toBe(1);
    all.clock.t = startsAt + 4 * 4 * 60_000 + 16 * 60_000;
    expect(all.season.tick().finalized).toEqual([id]);
    expect((await a.call("GET", `/api/tournaments/${id}`)).data.tournament.phase).toBe("done");
    // 取りやめ
    const c2 = await boss.call("POST", "/api/admin/tournaments", { name: "中止", startsAt: startsAt + 7 * DAY, trackId: "tsuzura", laps: 2, weather: { mode: "fixed", sky: "light" } });
    expect((await boss.call("DELETE", `/api/admin/tournaments/${c2.data.tournament.id}`)).status).toBe(200);
    expect((await a.call("GET", `/api/tournaments/${c2.data.tournament.id}`)).status).toBe(404);
  });
});
