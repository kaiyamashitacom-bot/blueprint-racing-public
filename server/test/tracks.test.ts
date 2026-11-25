// みんなのコース (tracks.ts) の試験。DO の SQLite の代わりに node:sqlite (api.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LIKE_WEIGHT, TRACK_DEFS, buildTrack, getTrack, knownTrackDef, type TrackDef } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { TRACK_DRIVE_GAP_MS, TRACK_PENDING_MAX, TRACK_SUBMIT_PER_HOUR, TrackStore, resolveTrackDef } from "../src/tracks.ts";

function makeStores(clock: { t: number }) {
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
  const store = new AccountStore({ sql, tx, now: () => clock.t, adminIds: ["boss"], iterations: 1000 });
  const tracks = new TrackStore({ sql, tx, now: () => clock.t }, store);
  return { store, tracks };
}

function client(store: AccountStore, tracks: TrackStore) {
  let token = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const headers: Record<string, string> = { "cf-connecting-ip": "1.2.3.4" };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await handleApi(
        new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        tracks,
      );
      const data = (await res.json()) as Record<string, any>;
      if (typeof data.token === "string") token = data.token;
      return { status: res.status, data };
    },
  };
}

async function setup() {
  const clock = { t: Date.UTC(2026, 10, 25, 3) };
  const { store, tracks } = makeStores(clock);
  const boss = client(store, tracks);
  const amy = client(store, tracks);
  const ben = client(store, tracks);
  const anon = client(store, tracks);
  expect((await boss.call("POST", "/api/register", { id: "boss", password: "password1", team: "管轄チーム", driver: "ボス" })).status).toBe(201);
  expect((await amy.call("POST", "/api/register", { id: "amy", password: "password1", team: "アミー組", driver: "アミー" })).status).toBe(201);
  expect((await ben.call("POST", "/api/register", { id: "ben", password: "password1", team: "ベン組", driver: "ベン" })).status).toBe(201);
  return { clock, store, tracks, boss, amy, ben, anon };
}

/** 公式の青図の形を借りた、通るコース */
function shape(name = "まわり道", k = 1): Omit<TrackDef, "id"> {
  const a = TRACK_DEFS[0];
  return { name, points: a.points.map(([x, y]) => [x * k, y * k]), halfWidth: 7, runoff: 9 };
}

const lap = 70;

describe("みんなのコース: 出す", () => {
  it("ログイン・1 周・コースの決まり・名前を確かめる", async () => {
    const { amy, anon } = await setup();
    expect((await anon.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: lap })).status).toBe(401);
    expect((await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: false })).status).toBe(400);
    // 速すぎる周
    expect((await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: 3 })).status).toBe(400);
    // 小さすぎる (600 m より短い)
    const small = await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape("ちび", 0.2), lapped: true, lapTime: lap });
    expect(small.status).toBe(400);
    expect(small.data.error).toMatch(/問題/);
    expect((await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape("公式サーキット"), lapped: true, lapTime: lap })).status).toBe(400);
    expect((await amy.call("POST", "/api/tracks", { localId: "abcd01", def: { ...shape(), points: "x" }, lapped: true, lapTime: lap })).status).toBe(400);
    const ok = await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: lap });
    expect(ok.status).toBe(201);
    expect(ok.data.track).toMatchObject({ localId: "abcd01", name: "まわり道", status: "pending", authorLap: lap });
    expect(ok.data.track.id).toMatch(/^pub:\d+$/);
  });

  it("確かめ待ちは みんなの一覧に出ず、出した人と管理者だけが形を見られる", async () => {
    const { amy, ben, boss, anon } = await setup();
    const id = (await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: lap })).data.track.id as string;
    const n = id.slice(4);
    expect((await anon.call("GET", "/api/tracks")).data.tracks).toEqual([]);
    expect((await ben.call("GET", `/api/tracks/${n}`)).status).toBe(404);
    expect((await amy.call("GET", `/api/tracks/${n}`)).status).toBe(200);
    expect((await boss.call("GET", `/api/tracks/${n}`)).data.status).toBe("pending");
    expect((await amy.call("GET", "/api/tracks/mine")).data.tracks.map((t: any) => t.status)).toEqual(["pending"]);
  });

  it("管理者が名前を直して公開 → みんなの一覧に出る。管理者でなければ確かめられない", async () => {
    const { amy, ben, boss, anon } = await setup();
    const id = (await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: lap })).data.track.id as string;
    const n = id.slice(4);
    expect((await amy.call("GET", "/api/admin/tracks")).status).toBe(403);
    expect((await ben.call("POST", `/api/admin/tracks/${n}/review`, { action: "approve" })).status).toBe(403);
    const q = await boss.call("GET", "/api/admin/tracks?status=pending");
    expect(q.data.tracks).toHaveLength(1);
    expect(q.data.tracks[0]).toMatchObject({ id, author: "アミー組", login: "amy" });
    expect(q.data.tracks[0].def.points.length).toBeGreaterThan(4);
    expect((await boss.call("POST", `/api/admin/tracks/${n}/review`, { action: "maybe" })).status).toBe(400);
    const r = await boss.call("POST", `/api/admin/tracks/${n}/review`, { action: "approve", name: "ひろい道" });
    expect(r.status).toBe(200);
    expect(r.data.track).toMatchObject({ status: "public", name: "ひろい道" });
    const list = (await anon.call("GET", "/api/tracks")).data.tracks;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: "ひろい道", author: "アミー組", drives: 0, likes: 0, rank: 1 });
    const one = await anon.call("GET", `/api/tracks/${n}`);
    expect(one.data.def).toMatchObject({ id, name: "ひろい道", halfWidth: 7 });
    expect(buildTrack(one.data.def).length).toBeGreaterThan(600);
  });

  it("断る (理由つき) → 直して出し直すと また確かめ待ち", async () => {
    const { amy, boss } = await setup();
    const id = (await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: lap })).data.track.id as string;
    await boss.call("POST", `/api/admin/tracks/${id}/review`, { action: "reject", reason: "名前がよくない" });
    expect((await amy.call("GET", "/api/tracks/mine")).data.tracks[0]).toMatchObject({ status: "rejected", reason: "名前がよくない" });
    const again = await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape("よい名前"), lapped: true, lapTime: lap });
    expect(again.data.track).toMatchObject({ id, status: "pending", reason: null, name: "よい名前" });
  });

  it("公開中の形は変えられない (同じ形なら何もしない)", async () => {
    const { amy, boss } = await setup();
    const id = (await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: lap })).data.track.id as string;
    await boss.call("POST", `/api/admin/tracks/${id}/review`, { action: "approve" });
    expect((await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape("まわり道", 1.1), lapped: true, lapTime: lap })).status).toBe(409);
    const same = await amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape("べつの名前"), lapped: true, lapTime: lap });
    expect(same.data.track).toMatchObject({ status: "public", name: "まわり道" });
  });

  it("送る回数と確かめ待ちの数を抑える (公開の数には上限なし)", async () => {
    const { amy, clock, boss } = await setup();
    for (let i = 0; i < TRACK_PENDING_MAX; i++) {
      expect((await amy.call("POST", "/api/tracks", { localId: `trk${i}xx`, def: shape(`道 ${i}`), lapped: true, lapTime: lap })).status).toBe(201);
    }
    const full = await amy.call("POST", "/api/tracks", { localId: "trkMore", def: shape("もう 1 本"), lapped: true, lapTime: lap });
    expect(full.status).toBe(429);
    expect(full.data.error).toMatch(/確かめ待ち/);
    // 全部公開すると、また出せる
    for (const t of (await boss.call("GET", "/api/admin/tracks")).data.tracks) await boss.call("POST", `/api/admin/tracks/${t.id}/review`, { action: "approve" });
    clock.t += 3600_000;
    for (let i = 0; i < TRACK_SUBMIT_PER_HOUR; i++) {
      const r = await amy.call("POST", "/api/tracks", { localId: "trkMore", def: shape(`直し ${i}`), lapped: true, lapTime: lap });
      expect(r.status).toBe(201);
    }
    expect((await amy.call("POST", "/api/tracks", { localId: "trkMore", def: shape("直し 11"), lapped: true, lapTime: lap })).status).toBe(429);
    expect((await amy.call("GET", "/api/tracks")).data.tracks).toHaveLength(TRACK_PENDING_MAX);
  });
});

describe("みんなのコース: 走る・いいね (popularity.ts)", () => {
  async function published() {
    const s = await setup();
    const id = (await s.amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape(), lapped: true, lapTime: lap })).data.track.id as string;
    await s.boss.call("POST", `/api/admin/tracks/${id}/review`, { action: "approve" });
    return { ...s, id, n: id.slice(4) };
  }

  it("いいねは走り終えた人だけ。取り消せる。人気の点 = 走った回数 + いいね × 10", async () => {
    const { ben, n, anon } = await published();
    expect((await anon.call("POST", `/api/tracks/${n}/like`)).status).toBe(401);
    expect((await ben.call("POST", `/api/tracks/${n}/like`)).status).toBe(403);
    expect((await ben.call("POST", `/api/tracks/${n}/run`, { finished: false })).data.counted).toBe(true);
    expect((await ben.call("POST", `/api/tracks/${n}/like`)).status).toBe(403);
    const run = await ben.call("POST", `/api/tracks/${n}/run`, { finished: true, lap: 65.4 });
    expect(run.data).toEqual({ counted: false, best: 65.4 });
    expect((await ben.call("POST", `/api/tracks/${n}/like`)).data).toEqual({ likes: 1, liked: true });
    expect((await ben.call("POST", `/api/tracks/${n}/like`)).data).toEqual({ likes: 1, liked: true });
    const row = (await ben.call("GET", "/api/tracks")).data.tracks[0];
    expect(row).toMatchObject({ drives: 1, likes: 1, score: 1 + LIKE_WEIGHT, finished: true, liked: true, mine: false, record: { lap: 65.4, driver: "ベン" } });
    expect((await ben.call("DELETE", `/api/tracks/${n}/like`)).data).toEqual({ likes: 0, liked: false });
    expect((await anon.call("GET", "/api/tracks")).data.tracks[0].finished).toBeUndefined();
  });

  it("同じ人が続けて走っても、間をあけないと回数に数えない。速すぎる周は記録しない", async () => {
    const { ben, n, clock } = await published();
    await ben.call("POST", `/api/tracks/${n}/run`, { finished: true, lap: 2 });
    expect((await ben.call("GET", "/api/tracks")).data.tracks[0]).toMatchObject({ drives: 1, record: null });
    await ben.call("POST", `/api/tracks/${n}/run`, { finished: true, lap: 80 });
    clock.t += TRACK_DRIVE_GAP_MS;
    await ben.call("POST", `/api/tracks/${n}/run`, { finished: true, lap: 90 });
    expect((await ben.call("GET", "/api/tracks")).data.tracks[0]).toMatchObject({ drives: 2, record: { lap: 80 } });
  });

  it("人気の順に並ぶ", async () => {
    const s = await published();
    const id2 = (await s.ben.call("POST", "/api/tracks", { localId: "benb01", def: shape("ベンの道"), lapped: true, lapTime: lap })).data.track.id as string;
    await s.boss.call("POST", `/api/admin/tracks/${id2}/review`, { action: "approve" });
    await s.amy.call("POST", `/api/tracks/${id2.slice(4)}/run`, { finished: true, lap: 70 });
    await s.amy.call("POST", `/api/tracks/${id2.slice(4)}/like`);
    const list = (await s.anon.call("GET", "/api/tracks")).data.tracks;
    expect(list.map((t: any) => [t.id, t.rank])).toEqual([
      [id2, 1],
      [s.id, 2],
    ]);
    expect((await s.anon.call("GET", "/api/tracks?sort=new")).data.tracks).toHaveLength(2);
  });

  it("断ると一覧から消え、走れない", async () => {
    const { ben, boss, n, anon } = await published();
    await boss.call("POST", `/api/admin/tracks/${n}/review`, { action: "reject", reason: "壁が多すぎ" });
    expect((await anon.call("GET", "/api/tracks")).data.tracks).toEqual([]);
    expect((await ben.call("POST", `/api/tracks/${n}/run`, { finished: true })).status).toBe(404);
  });

  it("取り下げ・退会", async () => {
    const s = await published();
    // 退会: 公開中は残り、確かめ待ちは消える
    await s.amy.call("POST", "/api/tracks", { localId: "pend01", def: shape("待ち"), lapped: true, lapTime: lap });
    expect((await s.amy.call("DELETE", "/api/me", { password: "password1" })).status).toBe(200);
    const all = (await s.boss.call("GET", "/api/admin/tracks?status=all")).data.tracks;
    expect(all.map((t: any) => [t.status, t.author, t.login])).toEqual([["public", "アミー組", null]]);
    // ベンが出して取り下げる
    const id2 = (await s.ben.call("POST", "/api/tracks", { localId: "benb01", def: shape("ベンの道"), lapped: true, lapTime: lap })).data.track.id as string;
    expect((await s.amy.call("DELETE", `/api/tracks/${id2.slice(4)}`)).status).toBe(401);
    expect((await s.boss.call("DELETE", `/api/tracks/${id2.slice(4)}`)).status).toBe(404);
    expect((await s.ben.call("DELETE", `/api/tracks/${id2.slice(4)}`)).status).toBe(200);
    expect((await s.ben.call("GET", "/api/tracks/mine")).data.tracks).toEqual([]);
  });
});

describe("部屋から: resolveTrackDef", () => {
  it("公式はそのまま、pub は公開中だけ読んで getTrack で引けるようにする", async () => {
    const s = await setup();
    const id = (await s.amy.call("POST", "/api/tracks", { localId: "abcd01", def: shape("大きな道", 1.3), lapped: true, lapTime: lap })).data.track.id as string;
    const src = { publicTrackDef: (x: string) => s.tracks.publicDef(x) };
    expect(await resolveTrackDef("aozu", src)).toBe(TRACK_DEFS[0]);
    expect(await resolveTrackDef(id, src)).toBeNull();
    expect(await resolveTrackDef("nope", src)).toBeNull();
    await s.boss.call("POST", `/api/admin/tracks/${id}/review`, { action: "approve" });
    const def = await resolveTrackDef(id, src);
    expect(def?.id).toBe(id);
    expect(knownTrackDef(id)?.name).toBe("大きな道");
    const t = getTrack(id);
    expect(t.def.id).toBe(id);
    expect(t.length).toBeGreaterThan(getTrack("aozu").length * 1.2);
  });
});
