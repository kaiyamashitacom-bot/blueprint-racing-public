// 開いた部屋の一覧と /api/rooms・荒らしを止める・招待の合言葉・走る前の準備 (代走)・雇った運転手のチャンピオンのごほうび
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DRIVERS, SAMPLE_DESIGN, TRACK_DEFS, seasonWindow, type CustomRoomConfig } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { handlePlayersAdminApi } from "../src/admin_players.ts";
import { leagueTeamData } from "../src/league_accounts.ts";
import { CUSTOM_ROOM_EMPTY_MS, CUSTOM_ROOM_GRACE_MS, RoomRegistry, handleRoomsApi, type RoomsApiDeps } from "../src/rooms.ts";
import { SeasonStore, type RaceFeed } from "../src/season.ts";
import { TeamStore, handleTeamApi } from "../src/team.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function makeAll() {
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
  const w = seasonWindow(1);
  const clock = { t: w.startsAt + DAY + 3 * HOUR };
  const now = () => clock.t;
  let season: SeasonStore | null = null;
  const store = new AccountStore({ sql, tx, now, iterations: 1000, adminIds: ["boss"], inviteOnly: () => season!.config().inviteOnly });
  const team = new TeamStore({ sql, tx, now }, store);
  season = new SeasonStore({ sql, tx, now, teamInfo: (acc, d) => team.raceTeam(acc, d), onDriverChampions: (s, ids) => void team.championBonus(s, ids) }, store);
  const rooms = new RoomRegistry({ sql, tx, now });
  const launched: CustomRoomConfig[] = [];
  let launchOk = true;
  const deps: RoomsApiDeps = {
    accounts: store,
    rooms,
    classOf: (acc) => season!.playClass(acc),
    tracks: () => TRACK_DEFS.map((d) => ({ id: d.id, name: d.name })),
    trackDef: (id) => TRACK_DEFS.find((d) => d.id === id) ?? null,
    launch: async (cfg) => {
      launched.push(cfg);
      return launchOk;
    },
  };
  return { db, store, team, season: season!, rooms, deps, launched, clock, setLaunch: (ok: boolean) => (launchOk = ok) };
}
type All = ReturnType<typeof makeAll>;

async function user(all: All, login: string, n: number, extra: Record<string, unknown> = {}) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `9.9.9.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const p = new URL(req.url).pathname;
    const res = p.startsWith("/api/rooms")
      ? await handleRoomsApi(req, p, method, all.deps)
      : /^\/api\/(admin\/(suspend|invites)|register\/info)/.test(p)
        ? await handlePlayersAdminApi(req, p, method, all.store)
        : p.startsWith("/api/team/setup")
          ? await handleTeamApi(req, p, method, all.store, all.team).catch((e) => new Response(JSON.stringify({ error: e.message }), { status: e.status ?? 500 }))
          : await handleApi(req, all.store, undefined, all.team, all.season, {}, undefined, all.rooms);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: login, password: "password1", team: `チーム${n}`, driver: `運転手${n}`, ...extra });
  const id = reg.status === 201 ? Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(login)!.id) : -1;
  return { call, id, reg, setToken: (t: string) => (token = t) };
}

async function anon(all: All) {
  return (method: string, path: string, body?: unknown) => {
    const req = new Request(`http://x${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
    return handleRoomsApi(req, new URL(req.url).pathname, method, all.deps).then(async (r) => ({ status: r.status, data: (await r.json()) as Record<string, any> })); // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

describe("開いた部屋の一覧 (/api/rooms)", () => {
  it("ログインした人が開ける (1 人 1 部屋)。名無しは見られるが開けない。部屋の DO に決めごとを渡す", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const call = await anon(all);
    expect((await call("POST", "/api/rooms", { trackId: "aozu", laps: 5 })).status).toBe(401);
    const bad = await a.call("POST", "/api/rooms", { trackId: "aozu", laps: 31 });
    expect(bad.status).toBe(400);
    expect((await a.call("POST", "/api/rooms", { trackId: "nope", laps: 3 })).status).toBe(400);
    const made = await a.call("POST", "/api/rooms", { trackId: "tsuzura", laps: 12 });
    expect(made.status).toBe(201);
    expect(made.data.room).toMatchObject({ trackId: "tsuzura", laps: 12, cls: 5, host: "運転手1", mine: true, phase: "idle", block: null });
    expect(all.launched).toEqual([{ id: made.data.room.id, trackId: "tsuzura", laps: 12, cls: 5, hostAccount: a.id, hostName: "運転手1" }]);
    // もう一度開くと同じ部屋
    const again = await a.call("POST", "/api/rooms", { trackId: "aozu", laps: 3 });
    expect(again.status).toBe(200);
    expect(again.data.room.id).toBe(made.data.room.id);
    expect(all.launched.length).toBe(1);
    const list = await call("GET", "/api/rooms");
    expect(list.data.loggedIn).toBe(false);
    expect(list.data.cls).toBe(5);
    expect(list.data.rooms.length).toBe(1);
    expect(list.data.rooms[0].mine).toBe(false);
    expect(list.data.tracks.map((t: { id: string }) => t.id)).toEqual(TRACK_DEFS.map((d) => d.id));
  });

  it("部屋を開けなければ一覧に残らない", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    all.setLaunch(false);
    expect((await a.call("POST", "/api/rooms", { trackId: "aozu", laps: 5 })).status).toBe(503);
    expect(all.rooms.list().length).toBe(0);
  });

  it("級のちがう部屋・レース中・満員・締めかけは入れない (わけつき)", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const b = await user(all, "bob", 2);
    const r = (await a.call("POST", "/api/rooms", { trackId: "aozu", laps: 5 })).data.room;
    expect((await b.call("POST", `/api/rooms/${r.id}/join`)).status).toBe(200);
    // 待合 (部屋からの知らせ)
    all.rooms.update(r.id, { phase: "lobby", humans: 1, cars: 2, endsAt: all.clock.t + 60_000 });
    expect((await b.call("POST", `/api/rooms/${r.id}/join`)).status).toBe(200);
    // 締めかけ
    all.rooms.update(r.id, { phase: "lobby", humans: 1, cars: 2, endsAt: all.clock.t + 1000 });
    const closing = await b.call("POST", `/api/rooms/${r.id}/join`);
    expect(closing.status).toBe(409);
    expect(closing.data.error).toContain("スタート");
    // 満員
    all.rooms.update(r.id, { phase: "lobby", humans: 8, cars: 8, endsAt: all.clock.t + 60_000 });
    expect((await b.call("GET", "/api/rooms")).data.rooms[0].block).toBe("full");
    // レース中
    all.rooms.update(r.id, { phase: "race", humans: 2, cars: 3, endsAt: all.clock.t + 600_000 });
    expect((await b.call("GET", "/api/rooms")).data.rooms[0].block).toBe("started");
    // 級のちがう人 (b を 4 級に)
    all.db.prepare("INSERT INTO season_kv (k, body) VALUES ('classes', ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body").run(JSON.stringify({ [String(b.id)]: 4 }));
    all.rooms.update(r.id, { phase: "lobby", humans: 1, cars: 2, endsAt: all.clock.t + 60_000 });
    const cls = await b.call("POST", `/api/rooms/${r.id}/join`);
    expect(cls.status).toBe(409);
    expect(cls.data.error).toContain("級");
    // ない部屋
    expect((await b.call("POST", "/api/rooms/zzzzzzzz/join")).status).toBe(404);
  });

  it("知らせが来なくなった部屋・誰も来なかった部屋・閉じた部屋は一覧から消える", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const b = await user(all, "bob", 2);
    const r1 = (await a.call("POST", "/api/rooms", { trackId: "aozu", laps: 5 })).data.room;
    const r2 = (await b.call("POST", "/api/rooms", { trackId: "aozu", laps: 2 })).data.room;
    all.rooms.update(r2.id, { phase: "lobby", humans: 1, cars: 1, endsAt: all.clock.t + 90_000 });
    all.clock.t += CUSTOM_ROOM_EMPTY_MS + 1;
    expect(all.rooms.list().map((x) => x.id)).toEqual([r2.id]);
    expect(all.rooms.get(r1.id)).toBeNull();
    all.clock.t += 90_000 + CUSTOM_ROOM_GRACE_MS;
    expect(all.rooms.list().length).toBe(0);
    // 閉じた (idle) らすぐ消える
    const r3 = (await a.call("POST", "/api/rooms", { trackId: "aozu", laps: 5 })).data.room;
    expect(all.rooms.update(r3.id, { phase: "lobby", humans: 1, cars: 1, endsAt: all.clock.t + 1000 })).toBe(true);
    expect(all.rooms.update(r3.id, { phase: "idle", humans: 0, cars: 0, endsAt: 0 })).toBe(false);
    expect(all.rooms.list().length).toBe(0);
  });

  it("退会した人の開いた部屋はすぐ一覧から消える (ほかの人の部屋は残る)", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const b = await user(all, "bob", 2);
    const r1 = (await a.call("POST", "/api/rooms", { trackId: "aozu", laps: 5 })).data.room;
    const r2 = (await b.call("POST", "/api/rooms", { trackId: "aozu", laps: 3 })).data.room;
    expect(all.rooms.list().length).toBe(2);
    expect((await a.call("DELETE", "/api/me", { password: "password1" })).status).toBe(200);
    expect(all.rooms.list().map((x) => x.id)).toEqual([r2.id]);
    // 部屋があとで知らせてきても一覧には戻らない
    expect(all.rooms.update(r1.id, { phase: "lobby", humans: 1, cars: 1, endsAt: all.clock.t + 60_000 })).toBe(false);
    expect(all.rooms.list().map((x) => x.id)).toEqual([r2.id]);
  });
});

describe("荒らしを止める・招く", () => {
  it("止めた人はログインもネットのレースもできない。戻すとできる。管理者は止められない", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    expect((await a.call("POST", "/api/admin/suspend", { id: "boss", suspended: true })).status).toBe(403);
    expect((await boss.call("POST", "/api/admin/suspend", { id: "boss", suspended: true })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/suspend", { id: "nobody", suspended: true })).status).toBe(404);
    const token = (await a.call("POST", "/api/login", { id: "alice", password: "password1" })).data.token as string;
    const s = await boss.call("POST", "/api/admin/suspend", { id: "alice", suspended: true, reason: "荒らし" });
    expect(s.status).toBe(200);
    expect(s.data).toEqual({ id: "alice", suspended: true });
    // ログインしたままの合い言葉も使えない
    expect((await a.call("GET", "/api/me")).status).toBe(401);
    const login = await a.call("POST", "/api/login", { id: "alice", password: "password1" });
    expect(login.status).toBe(403);
    expect(login.data.error).toContain("止め");
    const race = await all.store.raceEntry(token, SAMPLE_DESIGN);
    expect(race.account).toBeNull();
    expect(race.error).toContain("止め");
    // 一覧に印
    const players = all.season.players();
    expect(players.find((p) => p.login === "alice")?.suspended).toBe("荒らし");
    expect(players.find((p) => p.login === "boss")?.suspended).toBeNull();
    // 戻す
    expect((await boss.call("POST", "/api/admin/suspend", { id: "alice", suspended: false })).status).toBe(200);
    expect((await a.call("POST", "/api/login", { id: "alice", password: "password1" })).status).toBe(200);
    expect((await all.store.raceEntry(token, SAMPLE_DESIGN)).account?.id).toBe(a.id);
  });

  it("招かれた人だけ (はじめは切): 合言葉が要り、1 つで 1 人。使っていない合言葉は消せる", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    expect(all.season.config().inviteOnly).toBe(false);
    const info = await boss.call("GET", "/api/register/info");
    expect(info.data).toEqual({ inviteOnly: false });
    all.season.setConfig({ inviteOnly: true });
    expect((await boss.call("GET", "/api/register/info")).data).toEqual({ inviteOnly: true });
    const no = await user(all, "carol", 3);
    expect(no.reg.status).toBe(403);
    const made = await boss.call("POST", "/api/admin/invites", { count: 2, note: "友だち" });
    expect(made.status).toBe(201);
    const [c1, c2] = made.data.codes as string[];
    expect(c1).toMatch(/^[A-Z2-9]{8}$/);
    // 小文字・ハイフンでも通る
    const ok = await user(all, "carol", 3, { invite: `${c1.slice(0, 4).toLowerCase()}-${c1.slice(4)}` });
    expect(ok.reg.status).toBe(201);
    const twice = await user(all, "dave", 4, { invite: c1 });
    expect(twice.reg.status).toBe(403);
    const list = await boss.call("GET", "/api/admin/invites");
    const row = list.data.invites.find((x: { code: string }) => x.code === c1);
    expect(row.usedBy).toBe("carol");
    expect(row.note).toBe("友だち");
    expect((await boss.call("DELETE", `/api/admin/invites/${c1}`)).status).toBe(404);
    expect((await boss.call("DELETE", `/api/admin/invites/${c2}`)).status).toBe(200);
    expect((await user(all, "erin", 5, { invite: c2 })).reg.status).toBe(403);
    expect((await boss.call("POST", "/api/admin/invites", { count: 21 })).status).toBe(400);
    // 切に戻すと誰でも
    all.season.setConfig({ inviteOnly: false });
    expect((await user(all, "frank", 6)).reg.status).toBe(201);
  });
});

describe("走る前の準備をサーバーに残す (代走が使う)", () => {
  it("PUT /api/team/setup で残し、リーグ戦の 2 台の様子に入る。読めないものは断る", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    expect(leagueTeamData(all.store, all.team, String(a.id))?.setup).toBeNull();
    expect((await a.call("PUT", "/api/team/setup", { setup: { tire: "Q", fuel: "full" } })).status).toBe(400);
    const r = await a.call("PUT", "/api/team/setup", { setup: { tire: "S", fuel: "race", alloc: { S: 2, M: 1 }, tireFor: "slick" } });
    expect(r.status).toBe(200);
    expect(leagueTeamData(all.store, all.team, String(a.id))?.setup).toEqual({ tire: "S", fuel: "race", alloc: { S: 2, M: 1 }, tireFor: "slick" });
    all.team.forgetAccount(a.id);
    expect(all.team.raceSetup(a.id)).toBeNull();
  });
});

describe("雇った運転手がチャンピオンになったら伸びしろ +5", () => {
  it("季節の締めで 1 回だけ。雇っているチームに知らせる", async () => {
    const all = makeAll();
    const a = await user(all, "alice", 1);
    const b = await user(all, "bob", 2);
    all.db.prepare("UPDATE accounts SET money = 50000 WHERE id = ?").run(a.id);
    const free = (await a.call("GET", "/api/drivers")).data.free as Array<{ id: string; signCost: number }>;
    const d = [...free].sort((x, y) => x.signCost - y.signCost)[0].id;
    expect((await a.call("POST", "/api/drivers/hire", { driverId: d })).status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = () => JSON.parse(String(all.db.prepare("SELECT body FROM econ_kv WHERE k = 'drivers'").get()!.body)) as any;
    const before = pool().drivers.find((x: { id: string }) => x.id === d).potential;
    // 雇った運転手が 1 位、人の運転手 (b) が 2 位
    const feed: RaceFeed = {
      raceId: "r1",
      at: all.clock.t,
      laps: 5,
      trackId: "aozu",
      humans: 2,
      maxWet: 0,
      cars: [
        { id: "t1", pos: 1, finished: true, fastest: true, penalty: 0, ownerAccountId: a.id, hiredDriverId: d },
        { id: "p2", pos: 2, finished: true, fastest: false, penalty: 0, accountId: b.id },
        { id: "p1", pos: 3, finished: true, fastest: false, penalty: 0, accountId: a.id, standIn: true },
        ...[4, 5, 6, 7, 8].map((pos) => ({ id: `b${pos}`, pos, finished: true, fastest: false, penalty: 0 })),
      ],
    };
    all.season.recordRace(feed);
    const season = all.season.tally().season;
    all.clock.t = seasonWindow(season).endsAt + 1000;
    expect(all.season.tick().closed).toEqual([season]);
    const after = pool().drivers.find((x: { id: string }) => x.id === d).potential;
    for (const k of ["speed", "stability", "tyreFuel", "pitSense"]) expect(after[k]).toBe(Math.min(100, before[k] + DRIVERS.championBonus));
    const n = all.db.prepare("SELECT text FROM notices WHERE account_id = ? AND kind = 'driver_bonus'").get(a.id) as { text: string };
    expect(n.text).toContain("+5");
    // もう一度呼んでも 1 回だけ
    expect(all.team.championBonus(season, [d])).toEqual([]);
    expect(pool().drivers.find((x: { id: string }) => x.id === d).potential).toEqual(after);
  });
});
