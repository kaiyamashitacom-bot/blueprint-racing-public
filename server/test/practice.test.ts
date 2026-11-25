// 練習の賞金の受け口 (practice.ts) の試験。DO の SQLite の代わりに node:sqlite を使う (timeattack.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  BOT_SKILL_MAX,
  DEFAULT_ADMIN_CONFIG,
  DT,
  SAMPLE_DESIGN,
  TRACK_DEFS,
  botInput,
  cloneAdminConfig,
  computeStats,
  createCar,
  designHash,
  encodeGhost,
  getTrack,
  makeBrain,
  newLapState,
  stepCar,
  updateLaps,
  type AdminConfig,
  type CarDesign,
  type PartStrength,
  type TrackDef,
} from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { PracticeStore, handlePracticeApi } from "../src/practice.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 11, 3, 3); // 日本時間の昼

function makeStores(clock: { t: number }, cfg: AdminConfig, trackDef?: (id: string) => TrackDef | null) {
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
  const practice = new PracticeStore({ sql, tx, now: () => clock.t, config: () => cfg, trackDef });
  return { store, practice, db };
}

async function login(store: AccountStore, id: string): Promise<string> {
  const res = await handleApi(
    new Request("http://x/api/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" }, body: JSON.stringify({ id, password: "password1", team: `T${id}`, driver: `D${id}` }) }),
    store,
  );
  return ((await res.json()) as { token: string }).token;
}

async function send(store: AccountStore, practice: PracticeStore, token: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handlePracticeApi(new Request("http://x/api/practice/lap", { method: "POST", headers, body: JSON.stringify(body) }), "/api/practice/lap", "POST", store, practice);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

/** 一番上手いコンピューターの 2 周目 (雨なら濡れた路面と雨用タイヤ) */
function botLap(design: CarDesign, trackId: string, o: { strength?: PartStrength; wet?: number; skill?: number } = {}): { lap: number; pts: number[] } {
  const track = getTrack(trackId);
  const stats = computeStats(design, o.strength);
  const wet = o.wet ?? 0;
  const car = createCar(track, stats, 0, { tire: wet > 0.3 ? "I" : "M", fuel: stats.fuelCap });
  car.started = true;
  const brain = makeBrain(() => 0.5, o.skill ?? BOT_SKILL_MAX);
  const st = newLapState();
  let t = 0;
  let rec: number[] = [];
  let next = 0;
  let laps = 0;
  while (t < 600) {
    const ev = stepCar(car, botInput(car, stats, track, brain, t, [], wet), stats, track, DT, { damage: false, wetness: wet });
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

const body = (trackId: string, l: { lap: number; pts: number[] }, extra: Record<string, unknown> = {}) => ({
  trackId,
  lap: l.lap,
  ghost: encodeGhost(l.pts),
  design: SAMPLE_DESIGN,
  designHash: designHash(SAMPLE_DESIGN),
  ...extra,
});

const TR = TRACK_DEFS.slice(0, 3).map((d) => d.id);
const laps = TR.map((id) => botLap(SAMPLE_DESIGN, id));

describe("練習の賞金の受け口", () => {
  it("ログインした人の確かめの通った周に 1 周ごと払い、1 日の上限で止まり、次の日にまた払う", async () => {
    const clock = { t: T0 };
    const cfg = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    cfg.practicePrizePerLap = 7;
    cfg.practicePrizeDailyLaps = 2;
    const { store, practice, db } = makeStores(clock, cfg);
    expect((await send(store, practice, null, body(TR[0], laps[0]))).status).toBe(401);
    const tok = await login(store, "prac1");
    const money0 = Number(db.prepare("SELECT money FROM accounts WHERE login = 'prac1'").get()!.money);

    const r1 = await send(store, practice, tok, body(TR[0], laps[0]));
    expect(r1.status).toBe(200);
    expect(r1.data).toEqual({ earned: 7, left: 1, money: money0 + 7 });
    // 同じ周をもう一度は断る
    expect((await send(store, practice, tok, body(TR[0], laps[0]))).status).toBe(409);
    const r2 = await send(store, practice, tok, body(TR[1], laps[1]));
    expect(r2.data).toEqual({ earned: 7, left: 0, money: money0 + 14 });
    // 上限を超えた周は確かめるが 0
    const r3 = await send(store, practice, tok, body(TR[2], laps[2]));
    expect(r3.status).toBe(200);
    expect(r3.data).toEqual({ earned: 0, left: 0, money: money0 + 14 });
    const log = db.prepare("SELECT delta, reason FROM wallet_log WHERE reason = '練習の賞金'").all();
    expect(log.length).toBe(2);
    // 次の日 (日本時間) はまた払う
    clock.t += DAY;
    expect((await send(store, practice, tok, body(TR[0], laps[0]))).data.earned).toBe(7);
  });

  it("ありえない周・幽霊の無い周・賞金の出ないコースは断る", async () => {
    const { store, practice } = makeStores({ t: T0 }, cloneAdminConfig(DEFAULT_ADMIN_CONFIG));
    const tok = await login(store, "prac2");
    const tooFast = await send(store, practice, tok, body(TR[0], { lap: laps[0].lap * 0.5, pts: laps[0].pts }));
    expect(tooFast.status).toBe(400);
    expect((await send(store, practice, tok, body(TR[0], { lap: laps[0].lap, pts: [] }))).status).toBe(400);
    expect((await send(store, practice, tok, body("user:mine", laps[0]))).status).toBe(400);
    // 別のコースの幽霊
    expect((await send(store, practice, tok, body(TR[1], laps[0]))).status).toBe(400);
    // みんなのコースは形が見つかるときだけ
    expect((await send(store, practice, tok, body("pub:999", laps[0]))).status).toBe(400);
  });

  it("みんなのコースも払う (形はコースの表から)", async () => {
    const def = { ...TRACK_DEFS[1], id: "pub:7", name: "みんなの試し" } as TrackDef;
    const { store, practice } = makeStores({ t: T0 }, cloneAdminConfig(DEFAULT_ADMIN_CONFIG), (id) => (id === "pub:7" ? def : null));
    const tok = await login(store, "prac3");
    const r = await send(store, practice, tok, body("pub:7", laps[1]));
    expect(r.status).toBe(200);
    expect(r.data.earned).toBe(DEFAULT_ADMIN_CONFIG.practicePrizePerLap);
  });

  it("雨の周 (濡れた路面・小雨用タイヤ) も払う", async () => {
    const { store, practice } = makeStores({ t: T0 }, cloneAdminConfig(DEFAULT_ADMIN_CONFIG));
    const tok = await login(store, "prac4");
    const wet = botLap(SAMPLE_DESIGN, TR[0], { wet: 0.6 });
    expect(wet.lap).toBeGreaterThan(laps[0].lap);
    expect((await send(store, practice, tok, body(TR[0], wet))).data.earned).toBe(DEFAULT_ADMIN_CONFIG.practicePrizePerLap);
  });

  it("部品の強さの倍率 (管理者の数) で確かめる: 強くした車の周も通る", async () => {
    const cfg = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    cfg.partStrength = 5;
    const { store, practice } = makeStores({ t: T0 }, cfg);
    const tok = await login(store, "prac5");
    const strong = botLap(SAMPLE_DESIGN, TR[0], { strength: { partStrength: 5, partKindStrength: {} } });
    expect((await send(store, practice, tok, body(TR[0], strong))).status).toBe(200);
    // 倍率を戻すと、その周はこの車では出せない
    cfg.partStrength = 1;
    const again = await send(store, practice, tok, body(TR[0], strong, { lap: strong.lap }));
    expect(again.status).toBe(400);
  });
});
