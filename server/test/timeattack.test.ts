// 1 周アタックの受け口の試験。DO の SQLite の代わりに node:sqlite を使う (api.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  BOT_SKILL_MAX,
  DT,
  SAMPLE_DESIGN,
  SEASON_EPOCH_MS,
  SEASON_MS,
  TA_CONDITIONS,
  TA_SUBMIT_GRACE_MS,
  botInput,
  computeStats,
  createCar,
  designHash,
  encodeGhost,
  getTrack,
  makeBrain,
  newLapState,
  stepCar,
  taWeekAt,
  updateLaps,
  type CarDesign,
  DEFAULT_ADMIN_CONFIG,
} from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { TaStore, type TaDeps } from "../src/timeattack.ts";
import { earnTaLap } from "../src/racepoints.ts";

function makeStores(clock: { t: number }, earn?: (sql: SqlRunner) => TaDeps["earn"]) {
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
  const store = new AccountStore({ sql, tx, now: () => clock.t, iterations: 1000 });
  const ta = new TaStore({ sql, tx, now: () => clock.t, earn: earn?.(sql) });
  return { store, ta, db };
}

function client(store: AccountStore, ta: TaStore) {
  let token = "";
  return {
    async call(method: string, path: string, body?: unknown, ip = "1.2.3.4") {
      const headers: Record<string, string> = { "cf-connecting-ip": ip };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), store, ta);
      const data = (await res.json()) as Record<string, any>;
      if (typeof data.token === "string") token = data.token;
      return { status: res.status, data };
    },
    logout() {
      token = "";
    },
  };
}

/** 一番上手いコンピューターの 2 周目 (0.1 秒の目盛りちょうどで記録)。slow 秒ぶん遅く見せたいときは点を足さずに時間だけ… はできないので、上手さで変える */
function botLap(design: CarDesign, trackId: string, skill = BOT_SKILL_MAX): { lap: number; pts: number[] } {
  const track = getTrack(trackId);
  const stats = computeStats(design);
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

const T0 = SEASON_EPOCH_MS + 3600_000; // 週 0 の月曜 1 時
const W0 = taWeekAt(T0);
const fast = botLap(SAMPLE_DESIGN, W0.trackId);
const slow = botLap(SAMPLE_DESIGN, W0.trackId, 0.8);

function lapBody(l: { lap: number; pts: number[] }, extra: Record<string, unknown> = {}) {
  return { week: W0.index, lap: l.lap, ghost: encodeGhost(l.pts), design: SAMPLE_DESIGN, designHash: designHash(SAMPLE_DESIGN), ...extra };
}

describe("1 周アタックの受け口", () => {
  it("ログインなしでも順位表と幽霊は見られるが、送れない", async () => {
    const { store, ta } = makeStores({ t: T0 });
    const c = client(store, ta);
    const b = await c.call("GET", "/api/ta/board");
    expect(b.status).toBe(200);
    expect(b.data.week).toMatchObject({ index: W0.index, trackId: W0.trackId });
    expect(b.data.conditions).toMatchObject({ sky: "sun", tire: "S" });
    expect(b.data.top).toEqual([]);
    expect(b.data.me).toBeNull();
    expect((await c.call("GET", "/api/ta/ghosts")).data.ghosts).toEqual([]);
    expect((await c.call("POST", "/api/ta/submit", lapBody(slow))).status).toBe(401);
  });

  it("送る → 一番速いのだけ残る → 順位・同じタイム・幽霊 (設計図は返さない)", async () => {
    const clock = { t: T0 };
    const { store, ta, db } = makeStores(clock);
    const a = client(store, ta);
    const b = client(store, ta);
    await a.call("POST", "/api/register", { id: "ta_a", password: "password1", team: "青図A", driver: "エー" });
    await b.call("POST", "/api/register", { id: "ta_b", password: "password1", team: "青図B", driver: "ビー" });

    const r1 = await a.call("POST", "/api/ta/submit", lapBody(slow));
    expect(r1.status).toBe(200);
    expect(r1.data).toMatchObject({ improved: true, best: { rank: 1 }, total: 1 });
    expect(r1.data.best.lap).toBeCloseTo(slow.lap, 3);

    clock.t += 1000;
    const r2 = await b.call("POST", "/api/ta/submit", lapBody(fast));
    expect(r2.data).toMatchObject({ improved: true, best: { rank: 1 }, total: 2 });

    // 遅い周を送っても記録は変わらない
    clock.t += 1000;
    const r3 = await b.call("POST", "/api/ta/submit", lapBody(slow));
    expect(r3.data).toMatchObject({ improved: false, best: { rank: 1 } });
    expect(r3.data.best.lap).toBeCloseTo(fast.lap, 3);

    // A が同じタイムに追いつく → 同じ順位、先に出した B が上
    clock.t += 1000;
    const r4 = await a.call("POST", "/api/ta/submit", lapBody(fast));
    expect(r4.data).toMatchObject({ improved: true, best: { rank: 1 }, total: 2 });
    const board = await a.call("GET", "/api/ta/board");
    expect(board.data.top.map((r: any) => [r.rank, r.driver, r.me])).toEqual([
      [1, "ビー", false],
      [1, "エー", true],
    ]);
    expect(board.data.me).toMatchObject({ rank: 1 });
    // ID と設計図は出さない
    const text = JSON.stringify(board.data) + JSON.stringify((await a.call("GET", "/api/ta/ghosts?n=5")).data);
    expect(text).not.toContain("ta_a");
    expect(text).not.toContain("seat");
    expect(text).not.toContain(designHash(SAMPLE_DESIGN));

    const gh = await b.call("GET", "/api/ta/ghosts?n=1");
    expect(gh.data.ghosts.length).toBe(1);
    expect(gh.data.ghosts[0]).toMatchObject({ rank: 1, driver: "ビー", me: true });
    expect(typeof gh.data.ghosts[0].ghost).toBe("string");
    // 1 位だけ頼んでも、自分の幽霊は付いてくる
    const ga = await a.call("GET", "/api/ta/ghosts?n=1");
    expect(ga.data.ghosts.map((g: any) => g.driver)).toEqual(["ビー", "エー"]);
    // 保存は 1 人 1 行
    expect(db.prepare("SELECT COUNT(*) AS c FROM ta_best").get()).toMatchObject({ c: 2 });
  });

  it("マニュアルの周 (mt) は MT の印で残り、順位表と幽霊に出る。前の表 (mt の列なし) にも列を足す", async () => {
    const clock = { t: T0 };
    const { store, ta, db } = makeStores(clock);
    const a = client(store, ta);
    const b = client(store, ta);
    await a.call("POST", "/api/register", { id: "ta_m", password: "password1", team: "青図M", driver: "エム" });
    await b.call("POST", "/api/register", { id: "ta_n", password: "password1", team: "青図N", driver: "エヌ" });
    expect((await a.call("POST", "/api/ta/submit", lapBody(fast, { mt: true }))).status).toBe(200);
    expect((await b.call("POST", "/api/ta/submit", lapBody(slow))).status).toBe(200);
    const board = await a.call("GET", "/api/ta/board");
    expect(board.data.top.map((r: any) => [r.driver, r.mt])).toEqual([
      ["エム", true],
      ["エヌ", false],
    ]);
    expect((await a.call("GET", "/api/ta/ghosts?n=5")).data.ghosts.map((g: any) => g.mt)).toEqual([true, false]);
    // 速すぎる周は マニュアルでも断る
    expect((await a.call("POST", "/api/ta/submit", lapBody(fast, { lap: fast.lap * 0.5, mt: true }))).status).toBe(400);
    // 前の表: mt の列がなければ足す (前の記録はオートマ)
    db.exec("CREATE TABLE old_copy AS SELECT week, account_id, lap_ms, ghost, design_hash, driver, team, at, tries FROM ta_best");
    db.exec("DROP TABLE ta_best");
    db.exec("ALTER TABLE old_copy RENAME TO ta_best");
    const sql = {
      exec: (q: string, ...v: any[]) => {
        const rows = db.prepare(q).all(...v) as any[];
        return { toArray: () => rows };
      },
    };
    new TaStore({ sql, tx: (fn) => fn(), now: () => clock.t });
    const cols = (db.prepare("PRAGMA table_info(ta_best)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("mt");
  });

  it("おかしな周は断る", async () => {
    const { store, ta } = makeStores({ t: T0 });
    const c = client(store, ta);
    await c.call("POST", "/api/register", { id: "ta_c", password: "password1", team: "青図C", driver: "シー" });
    const bad = async (extra: Record<string, unknown>) => (await c.call("POST", "/api/ta/submit", lapBody(fast, extra))).status;
    expect(await bad({ lap: fast.lap * 0.5 })).toBe(400); // 速すぎ
    expect(await bad({ lap: fast.lap - 1 })).toBe(400); // 点の数と合わない
    expect(await bad({ ghost: "garbage" })).toBe(400);
    expect(await bad({ week: W0.index + 1 })).toBe(400);
    expect(await bad({ designHash: "00000000" })).toBe(400);
    expect(await bad({ design: { name: "x", parts: SAMPLE_DESIGN.parts.slice(1) } })).toBe(400);
    // 持っていない部品 (はじめの箱にない数のタイヤ)
    const more = { name: "x", parts: [...SAMPLE_DESIGN.parts, { id: "tire_w1", c: 0, r: 4, rot: 0 }, { id: "tire_w1", c: 5, r: 4, rot: 0 }] };
    expect(await bad({ design: more, designHash: undefined })).toBe(400);
    expect((await c.call("GET", "/api/ta/board")).data.total).toBe(0);
  });

  it("週が変わってすぐは前の週に送れる。退会すると今週の記録は消える", async () => {
    const clock = { t: SEASON_EPOCH_MS + SEASON_MS - 1000 };
    const { store, ta } = makeStores(clock);
    const c = client(store, ta);
    await c.call("POST", "/api/register", { id: "ta_d", password: "password1", team: "青図D", driver: "ディー" });
    clock.t = SEASON_EPOCH_MS + SEASON_MS + 60_000;
    expect((await c.call("POST", "/api/ta/submit", lapBody(fast))).status).toBe(200);
    clock.t = SEASON_EPOCH_MS + SEASON_MS + TA_SUBMIT_GRACE_MS + 1;
    expect((await c.call("POST", "/api/ta/submit", lapBody(fast))).status).toBe(400);
    expect((await c.call("GET", `/api/ta/board?week=${W0.index}`)).data.total).toBe(1);
    expect((await c.call("GET", `/api/ta/board?week=${W0.index + 5}`)).status).toBe(400);
    expect((await c.call("DELETE", "/api/me", { password: "password1" })).status).toBe(200);
    expect((await c.call("GET", `/api/ta/board?week=${W0.index}`)).data.total).toBe(0);
  });
});

describe("1 周アタックの走行点 (racepoints.ts)", () => {
  it("確かめの通った周で入る: 記録更新 5 点・更新でない周 1 点。確かめの通らない周は 0。ログインなしは送れない", async () => {
    const clock = { t: T0 };
    const { store, ta, db } = makeStores(clock, (sql) => (id, improved, at) => earnTaLap(sql, DEFAULT_ADMIN_CONFIG, id, improved, at));
    const a = client(store, ta);
    await a.call("POST", "/api/register", { id: "ta_rp", password: "password1", team: "青図R", driver: "アール" });
    const r1 = await a.call("POST", "/api/ta/submit", lapBody(slow));
    expect(r1.data).toMatchObject({ improved: true, rp: { earned: 5, left: 145, points: 5 } });
    clock.t += 1000;
    const r2 = await a.call("POST", "/api/ta/submit", lapBody(slow));
    expect(r2.data).toMatchObject({ improved: false, rp: { earned: 1, points: 6 } });
    clock.t += 1000;
    expect((await a.call("POST", "/api/ta/submit", lapBody(fast, { lap: fast.lap * 0.5 }))).status).toBe(400);
    const pts = (db.prepare("SELECT points FROM rp_wallet").get() as { points: number }).points;
    expect(pts).toBe(6);
  });
});
