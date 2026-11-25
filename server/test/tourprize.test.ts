// 大会ごとの景品 (結果と同じ取りまとめで渡す・失格と代走・管理者が決める) と、毎日の自動の大会 (全員参加・代走・サーバーで計算する組) の試験。
// DO の SQLite の代わりに node:sqlite を使う (season.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_CONFIG,
  SAMPLE_DESIGN,
  dailyTourId,
  defaultTournamentPrizes,
  describeGiftItem,
  jstDayStart,
  seasonWindow,
  type FixedCarResult,
  type GiftItem,
} from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { GiftStore } from "../src/gift.ts";
import { leagueTeamData } from "../src/league_accounts.ts";
import { LOBBY_LEAD_MS, SeasonStore, TOUR_PRESENCE_MS, fillerDriverId, humanDriverId, type SeasonDeps } from "../src/season.ts";
import { TeamStore } from "../src/team.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function makeAll(o: { auto?: boolean; grant?: (inner: NonNullable<SeasonDeps["grantPrizes"]>) => SeasonDeps["grantPrizes"] } = {}) {
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
  const clock = { t: seasonWindow(1).startsAt + DAY + 3 * HOUR };
  const now = () => clock.t;
  let gifts: GiftStore | null = null;
  const store = new AccountStore({ sql, tx, now, iterations: 1000, adminIds: ["boss"] });
  const team = new TeamStore({ sql, tx, now }, store);
  const inner: NonNullable<SeasonDeps["grantPrizes"]> = (acc, items, at) => gifts!.grantInTx(acc, items, at);
  const season = new SeasonStore(
    {
      sql,
      tx,
      now,
      teamInfo: (acc, d) => team.raceTeam(acc, d),
      classMoves: () => gifts!.takeClassMoves(),
      grantPrizes: o.grant ? o.grant(inner) : inner,
      teamData: (acc) => leagueTeamData(store, team, String(acc)),
      autoTournaments: o.auto === true,
    },
    store,
  );
  gifts = new GiftStore({ sql, tx, now, caps: () => season.config() }, store, team, season);
  return { db, store, team, season, gifts, clock };
}
type All = ReturnType<typeof makeAll>;

async function user(all: All, login: string, n: number) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `7.7.7.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), all.store, undefined, all.team, all.season, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
const notices = (all: All, id: number, kind: string) =>
  all.db.prepare("SELECT title, text FROM notices WHERE account_id = ? AND kind = ?").all(id, kind) as Array<{ title: string; text: string }>;
const cash = (amount: number): GiftItem => ({ kind: "money", p: { amount } });
const dry2 = [
  { tire: "M" as const, meters: 900, dry: true },
  { tire: "H" as const, meters: 900, dry: true },
];
const row = (team: number, pos: number, o: Partial<FixedCarResult> = {}): FixedCarResult => ({
  key: `acc:${team}`,
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
  pitStops: 1,
  standIn: false,
  stints: dry2,
  maxWet: 0,
  ...o,
});

/** 管理者が大会を作り、users が予定 (設計図) を決めて出場。スタートの 10 分前まで進めて組を開く (1 組) */
async function tourWith(all: All, boss: Awaited<ReturnType<typeof user>>, users: Array<Awaited<ReturnType<typeof user>>>, extra: Record<string, unknown> = {}) {
  const day = seasonWindow(1).startsAt;
  const startsAt = day + 3 * DAY + 20 * HOUR;
  const cr = await boss.call("POST", "/api/admin/tournaments", { name: "景品の杯", startsAt, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" }, groupSize: 8, ...extra });
  expect(cr.status).toBe(201);
  const id = cr.data.tournament.id as string;
  for (const u of users) {
    expect((await u.call("POST", `/api/tournaments/${id}/tires`, { alloc: { M: 2, H: 2 } })).status).toBe(200);
    expect((await u.call("POST", `/api/tournaments/${id}/plan`, { design: SAMPLE_DESIGN })).status).toBe(200);
  }
  all.clock.t = startsAt - LOBBY_LEAD_MS;
  all.season.tick();
  all.clock.t = startsAt + 5 * MIN;
  return { id, startsAt };
}

describe("大会の景品", () => {
  it("管理者の決めた景品: 順位ごと・参加賞・失格はなし・完走できずはなし・代走はもらう・知らせ・結果に出す", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const [a, b, c, d] = await Promise.all([user(all, "alice", 2), user(all, "bob", 3), user(all, "carol", 4), user(all, "dave", 5)]);
    const { id } = await tourWith(all, boss, [a, b, c, d], {
      grade: "大",
      prizes: [
        { from: 1, to: 1, items: [cash(50_000)] },
        { from: 2, to: 3, items: [cash(20_000)] },
      ],
      participation: [cash(700)],
    });
    const m0 = [a, b, c, d].map((u) => money(all, u.id));
    // a 1 位 (代走) / b 2 位 だがタイヤ 1 種類 = 失格 / c 3 位 → 失格が後ろへ行くので 2 位 / d 完走できず
    expect(
      all.season.recordTournamentGroup(
        `${id}:0`,
        [row(a.id, 1, { standIn: true }), row(b.id, 2, { stints: [{ tire: "M", meters: 1800, dry: true }] }), row(c.id, 3), row(d.id, 4, { finished: false, lapsDone: 1 })],
        all.clock.t,
      ),
    ).toBe(true);
    const cfg = DEFAULT_ADMIN_CONFIG;
    // 賞金 (管理者の表) + 景品
    expect(money(all, a.id) - m0[0]).toBe(cfg.tournamentPrize[0] + 50_000 + 700);
    expect(money(all, c.id) - m0[2]).toBe(cfg.tournamentPrize[1] + 20_000 + 700);
    expect(money(all, b.id) - m0[1]).toBe(0);
    expect(money(all, d.id) - m0[3]).toBe(0);
    expect(notices(all, a.id, "tournament_prize")).toEqual([{ title: "大会の景品を受け取りました", text: expect.stringContaining("お金 50,000") }]);
    expect(notices(all, c.id, "tournament_prize")).toHaveLength(1);
    expect(notices(all, b.id, "tournament_prize")).toEqual([]);
    expect(notices(all, d.id, "tournament_prize")).toEqual([]);
    const v = (await a.call("GET", `/api/tournaments/${id}`)).data;
    expect(v.results.map((r: any) => [r.name, r.finalPos, r.dq, r.standIn, r.gifts ?? []])).toEqual([
      ["運転手2", 1, false, true, ["お金 50,000", "参加賞: お金 700"]],
      ["運転手4", 2, false, false, ["お金 20,000", "参加賞: お金 700"]],
      ["運転手5", 3, false, false, []],
      ["運転手3", 4, true, false, []],
    ]);
    expect(v.tournament.prizes).toMatchObject({ grade: "大", custom: true, participation: ["お金 700"] });
    // 2 回目は渡さない
    expect(all.season.finalizeTournament(id, true)).toBe(false);
    expect(money(all, a.id) - m0[0]).toBe(cfg.tournamentPrize[0] + 50_000 + 700);
  });

  it("決めていなければ格のはじめの景品 (小 = お金)。1 つ受け取れなくても残りは渡し、知らせに書く", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const b = await user(all, "bob", 3);
    const { id } = await tourWith(all, boss, [a, b], { grade: "小" });
    const def = defaultTournamentPrizes("小");
    const m0 = money(all, a.id);
    const mb = money(all, b.id);
    all.season.recordTournamentGroup(`${id}:0`, [row(a.id, 1), row(b.id, 2)], all.clock.t);
    const cash1 = Number(def.tiers[0].items[0].p.amount);
    const part = def.participation[0].kind === "money" ? Number(def.participation[0].p.amount) : 0;
    expect(money(all, a.id) - m0).toBe(DEFAULT_ADMIN_CONFIG.tournamentPrize[0] + cash1 + part);
    expect(money(all, b.id) - mb).toBe(DEFAULT_ADMIN_CONFIG.tournamentPrize[1] + Number(def.tiers[1].items[0].p.amount) + part);

    // 受け取れない中身 (研究を始めていないのに「研究を進める」) は飛ばして、残りは渡す
    const all2 = makeAll();
    const boss2 = await user(all2, "boss", 1);
    const x = await user(all2, "xavier", 2);
    const { id: id2 } = await tourWith(all2, boss2, [x], {
      prizes: [{ from: 1, to: 1, items: [{ kind: "research", p: { mode: "advance", node: "", hours: 5 } }, cash(1234)] }],
      participation: [],
    });
    const mx = money(all2, x.id);
    all2.season.recordTournamentGroup(`${id2}:0`, [row(x.id, 1)], all2.clock.t);
    expect(money(all2, x.id) - mx).toBe(DEFAULT_ADMIN_CONFIG.tournamentPrize[0] + 1234);
    const n = notices(all2, x.id, "tournament_prize")[0];
    expect(n.text).toContain("お金 1,234");
    expect(n.text).toContain("受け取れなかったもの");
    const v = (await x.call("GET", `/api/tournaments/${id2}`)).data;
    expect(v.results[0].giftsMissed[0]).toContain("研究");
  });

  it("景品は結果と同じ取りまとめ: 途中で落ちたら賞金も景品も結果も戻る (あとでやり直せる)", async () => {
    let boom = true;
    const all = makeAll({
      grant: (inner) => (acc, items, at) => {
        const r = inner(acc, items, at);
        if (boom) throw new Error("落ちた");
        return r;
      },
    });
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const { id } = await tourWith(all, boss, [a], { prizes: [{ from: 1, to: 1, items: [cash(999)] }] });
    const m0 = money(all, a.id);
    expect(() => all.season.recordTournamentGroup(`${id}:0`, [row(a.id, 1)], all.clock.t)).toThrow("落ちた");
    expect(money(all, a.id)).toBe(m0);
    expect(notices(all, a.id, "tournament_prize")).toEqual([]);
    expect((await a.call("GET", `/api/tournaments/${id}`)).data.tournament.status).toBe("running");
    boom = false;
    expect(all.season.finalizeTournament(id, true)).toBe(true);
    expect(money(all, a.id) - m0).toBe(DEFAULT_ADMIN_CONFIG.tournamentPrize[0] + 999 + Number(defaultTournamentPrizes("中").participation[0].p.amount ?? 0) * (defaultTournamentPrizes("中").participation[0].kind === "money" ? 1 : 0));
  });

  it("管理者: 格と景品を作る・直す・はじめの景品に戻す。管理者でなければ 403。おかしな景品は 400", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const startsAt = seasonWindow(1).startsAt + 3 * DAY + 20 * HOUR;
    const base = { name: "杯", startsAt, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" } };
    expect((await a.call("POST", "/api/admin/tournaments", { ...base, grade: "大" })).status).toBe(403);
    expect((await boss.call("POST", "/api/admin/tournaments", { ...base, grade: "特" })).status).toBe(400);
    const badTier = await boss.call("POST", "/api/admin/tournaments", { ...base, prizes: [{ from: 1, to: 3, items: [cash(1)] }, { from: 2, to: 2, items: [cash(1)] }] });
    expect(badTier.status).toBe(400);
    expect(badTier.data.error).toContain("重なって");
    const cr = await boss.call("POST", "/api/admin/tournaments", { ...base, grade: "中", allEnter: false, prizes: [{ from: 1, to: 1, items: [cash(5000)] }], participation: [] });
    expect(cr.status).toBe(201);
    const id = cr.data.tournament.id;
    expect(cr.data.tournament).toMatchObject({ grade: "中", allEnter: false, prizes: [{ from: 1, to: 1, items: [cash(5000)] }], participation: [] });
    expect((await a.call("PUT", `/api/admin/tournaments/${id}`, { grade: "大" })).status).toBe(403);
    // 格だけ直す: 景品はそのまま
    const e1 = await boss.call("PUT", `/api/admin/tournaments/${id}`, { grade: "大" });
    expect(e1.data.tournament).toMatchObject({ grade: "大", prizes: [{ from: 1, to: 1, items: [cash(5000)] }], participation: [] });
    // 順位の景品を はじめの景品に戻す (null)。参加賞は「なし」のまま
    const e2 = await boss.call("PUT", `/api/admin/tournaments/${id}`, { prizes: null });
    expect(e2.data.tournament.prizes).toBeUndefined();
    expect(e2.data.tournament.participation).toEqual([]);
    const list = (await a.call("GET", "/api/tournaments")).data.tournaments;
    const t = list.find((x: any) => x.id === id);
    expect(t.grade).toBe("大");
    expect(t.prizes.tiers.map((x: any) => x.lines)).toEqual(defaultTournamentPrizes("大").tiers.map((x) => x.items.map((it) => describeGiftItem(it))));
    expect(t.prizes.participation).toEqual([]);
    expect(t.prizeSpec).toEqual({ prizes: null, participation: [] });
    // 参加賞もはじめに戻す
    await boss.call("PUT", `/api/admin/tournaments/${id}`, { participation: null });
    const t2 = (await a.call("GET", `/api/tournaments/${id}`)).data.tournament;
    expect(t2.prizes.custom).toBe(false);
    expect(t2.prizes.participation.length).toBe(1);
  });
});

describe("毎日の自動の大会", () => {
  /** 季節 1 の月曜 (日本時間) */
  const mon = () => seasonWindow(1).startsAt;

  it("1 日 1 つだけ作る (何度呼んでも)。月〜土は 中・日曜は 大。知らせは 1 時間前だけ。止めると作らない", async () => {
    const all = makeAll({ auto: true });
    await user(all, "alice", 2);
    all.clock.t = mon() + 12 * HOUR;
    const id = all.season.ensureDailyTournament();
    expect(id).toBe(dailyTourId(mon()));
    expect(all.season.ensureDailyTournament()).toBeNull();
    all.season.tick();
    expect(all.db.prepare("SELECT COUNT(*) AS c FROM tournaments").get()!.c).toBe(1);
    const t = all.season.listTournaments().tournaments[0];
    expect(t).toMatchObject({ id, grade: "中", auto: true, allEnter: true, laps: 10, groupSize: 8, startsAt: mon() + 22.5 * HOUR, qualifyClosesAt: mon() + 22 * HOUR, phase: "qualifying" });
    // 知らせは 1 時間前だけ
    all.clock.t = mon() + 21.5 * HOUR;
    all.season.tick();
    expect(all.db.prepare("SELECT id FROM notices WHERE kind = 'tournament_soon'").all().map((r: any) => r.id)).toEqual([`tour:${id}:${HOUR}`]);
    // 前の日のスタート + 30 分から次の日の大会の予選が開く
    all.clock.t = mon() + 23 * HOUR;
    expect(all.season.ensureDailyTournament()).toBe(dailyTourId(mon() + DAY));
    // 日曜は 大
    all.clock.t = mon() + 5 * DAY + 23 * HOUR;
    expect(all.season.ensureDailyTournament()).toBe(dailyTourId(mon() + 6 * DAY));
    expect(all.season.tournamentView(dailyTourId(mon() + 6 * DAY), null).tournament.grade).toBe("大");
    // 目覚まし: 次に開く時刻
    all.clock.t = mon() + 6 * DAY + 3 * HOUR;
    expect(all.season.nextWake()).toBeLessThanOrEqual(mon() + 6 * DAY + 22.5 * HOUR);
    // 止める
    all.season.setConfig({ autoTourOn: false });
    all.clock.t = mon() + 6 * DAY + 23 * HOUR;
    expect(all.season.ensureDailyTournament()).toBeNull();
    all.season.setConfig({ autoTourOn: true, autoTourHour: 21, autoTourMinute: 0, autoTourGradeWeekday: 1 });
    const id3 = all.season.ensureDailyTournament();
    expect(id3).toBe(dailyTourId(mon() + 7 * DAY));
    expect(all.season.tournamentView(id3!, null).tournament).toMatchObject({ grade: "小", startsAt: mon() + 7 * DAY + 21 * HOUR });
    // AccountsDO 以外 (autoTournaments なし) は作らない
    const off = makeAll();
    off.clock.t = mon() + 12 * HOUR;
    expect(off.season.ensureDailyTournament()).toBeNull();
  });

  it("管理者が作った大会がある日は開かない (取りやめた大会は数えない)。一度作った日は取りやめても作り直さない", async () => {
    const all = makeAll({ auto: true });
    const boss = await user(all, "boss", 1);
    all.clock.t = mon() - DAY + 12 * HOUR;
    // 火曜と水曜に管理者の大会。水曜のは取りやめる
    const tue = mon() + DAY;
    const mk = (startsAt: number) => boss.call("POST", "/api/admin/tournaments", { name: "管理者の杯", startsAt, trackId: "aozu", laps: 2, weather: { mode: "fixed", sky: "sun" } });
    const cr = await mk(tue + 20 * HOUR);
    expect(cr.status).toBe(201);
    expect(cr.data.tournament.allEnter).toBeUndefined();
    const wed = await mk(tue + DAY + 20 * HOUR);
    expect((await boss.call("DELETE", `/api/admin/tournaments/${wed.data.tournament.id}`)).status).toBe(200);
    all.clock.t = tue - 30 * MIN;
    expect(all.season.ensureDailyTournament()).toBeNull();
    all.clock.t = tue + 12 * HOUR;
    expect(all.season.ensureDailyTournament()).toBeNull();
    // 水曜は (管理者の大会を取りやめたので) 自動の大会を開く
    all.clock.t = tue + 23 * HOUR;
    const wedId = all.season.ensureDailyTournament();
    expect(wedId).toBe(dailyTourId(tue + DAY));
    // 管理者が自動の大会を取りやめたら、その日はもう作らない
    expect((await boss.call("DELETE", `/api/admin/tournaments/${wedId}`)).status).toBe(200);
    expect(all.season.ensureDailyTournament()).toBeNull();
  });

  it("全員参加: 予選を走らなかったチームも 2 台で出る (代走・埋め草)、強い車ほど後ろ、つないでいない組はサーバーで計算して 1 つの結果に", async () => {
    const all = makeAll({ auto: true });
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    await user(all, "bob", 3);
    all.clock.t = mon() + 12 * HOUR;
    const startsAt = mon() + 2 * DAY + 20 * HOUR;
    // 管理者の全員参加の大会 (組 2 台)。a だけが予定を決める
    const cr = await boss.call("POST", "/api/admin/tournaments", { name: "全員の杯", startsAt, trackId: "aozu", laps: 1, weather: { mode: "fixed", sky: "sun" }, groupSize: 2, allEnter: true });
    const id = cr.data.tournament.id as string;
    await a.call("POST", `/api/tournaments/${id}/tires`, { alloc: { M: 1, H: 2 } });
    await a.call("POST", `/api/tournaments/${id}/plan`, { design: SAMPLE_DESIGN });
    // a はスタートの 10 分前 の少し前に画面を開いている (つないでいる)
    all.clock.t = startsAt - LOBBY_LEAD_MS - TOUR_PRESENCE_MS + MIN;
    await a.call("GET", `/api/tournaments/${id}`);
    all.clock.t = startsAt - LOBBY_LEAD_MS;
    const t1 = all.season.tick();
    const v1 = all.season.tournamentView(id, a.id);
    // 3 チーム × 2 台 = 6 台、3 組
    const cars = v1.groups!.flatMap((g) => g.cars);
    expect(cars).toHaveLength(6);
    expect(new Set(cars.map((c) => c.teamId)).size).toBe(3);
    expect(cars.filter((c) => /^s\d+$/.test(c.driverId))).toHaveLength(3);
    // 記録の無い車の並び: 見込みの 1 周の遅い順 (同じ設計図と上手さなら チーム id → 運転手 id)
    expect(cars.every((c) => c.lapTime === null)).toBe(true);
    // a のいる組だけ部屋に渡す
    const aGroup = v1.me!.group!;
    expect(aGroup.headless).toBe(false);
    expect(t1.launch.map((f) => f.tag)).toEqual([`${id}:${aGroup.index}`]);
    // スタート: サーバーで計算する組は alarm 1 回に 1 組
    all.clock.t = startsAt + MIN;
    expect(all.season.runHeadlessGroup()).not.toBeNull();
    expect(all.season.runHeadlessGroup()).not.toBeNull();
    expect(all.season.runHeadlessGroup()).toBeNull();
    // 締め切りを過ぎても、サーバーの組が残っていれば待つ (ここでは全部済んだ) → 部屋の組の結果で決まる
    const live = all.season.tournamentView(id, a.id).groups![aGroup.index].cars;
    expect(
      all.season.recordTournamentGroup(
        `${id}:${aGroup.index}`,
        live.map((c, i) => ({ ...row(Number(c.teamId), i + 1), key: c.key, driverId: c.driverId, kind: c.kind, standIn: false })),
        startsAt + 4 * MIN,
      ),
    ).toBe(true);
    const res = all.season.tournamentView(id, a.id).results!;
    expect(res).toHaveLength(6);
    expect(res.map((r) => r.finalPos)).toEqual([1, 2, 3, 4, 5, 6]);
    // 予選を走らなかった人の車は代走
    expect(res.filter((r) => /^h\d+$/.test(r.driverId) && r.teamId !== String(a.id)).every((r) => r.standIn)).toBe(true);
    // 埋め草の車は運転手の順位に入らない。代走の人は 1/5
    const tally = all.season.tally();
    for (const r of res) if (/^s\d+$/.test(r.driverId)) expect(tally.drivers[r.driverId]).toBeUndefined();
    expect(Object.keys(tally.teams).sort()).toEqual([String(boss.id), String(a.id), String(boss.id + 2)].sort());
    expect(fillerDriverId(a.id)).toBe(`s${a.id}`);
  });

  it("毎日の大会: 誰もつないでいなければ全部の組をサーバーで計算する。代走の点は運転手に 1/5", async () => {
    const all = makeAll({ auto: true });
    const a = await user(all, "alice", 2);
    const b = await user(all, "bob", 3);
    all.clock.t = mon() + 12 * HOUR;
    const id = all.season.ensureDailyTournament()!;
    const t = all.season.tournamentView(id, null).tournament;
    all.clock.t = t.startsAt - LOBBY_LEAD_MS;
    expect(all.season.tick().launch).toEqual([]);
    expect(all.season.tournamentView(id, a.id).groups!.map((g) => g.cars.length)).toEqual([4]);
    all.clock.t = t.startsAt + MIN;
    // tick が 1 組ずつ走らせ、全部そろったら決まる
    all.season.tick();
    const v = all.season.tournamentView(id, a.id);
    expect(v.tournament.phase).toBe("done");
    expect(v.results!.filter((r) => /^h/.test(r.driverId)).every((r) => r.standIn)).toBe(true);
    const tally = all.season.tally();
    for (const r of v.results!) {
      if (!/^h/.test(r.driverId)) continue;
      const d = tally.drivers[r.driverId];
      expect(d.points, r.name).toBe(Math.floor(r.points / 10 / 5) * 10);
      expect(tally.teams[r.teamId].points).toBeGreaterThanOrEqual(r.points);
    }
    expect([a.id, b.id].every((x) => notices(all, x, "tournament_result").length === 1)).toBe(true);
    expect(jstDayStart(t.startsAt)).toBe(mon());
  });
});
