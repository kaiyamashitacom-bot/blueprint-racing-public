// 管理者の数の変更の記録 (admin_config_log.ts) と受け口の試験: 管理者だけ・変更ごとに記録 (誰が・前と後)・読みこみの確かめ・
// 取り消し・版に戻す (今の確かめを通す)・200 件だけ残す。DO の SQLite の代わりに node:sqlite (season.test.ts と同じやり方)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, adminExport, seasonWindow } from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { ADMIN_CONFIG_LOG_KEEP } from "../src/admin_config_log.ts";
import { handleApi } from "../src/api.ts";
import { SeasonStore } from "../src/season.ts";
import { TeamStore } from "../src/team.ts";

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
  const clock = { t: seasonWindow(1).startsAt + 30 * 3600_000 };
  const store = new AccountStore({ sql, tx, now: () => clock.t, iterations: 1000, adminIds: ["boss"] });
  const team = new TeamStore({ sql, tx, now: () => clock.t }, store);
  const season = new SeasonStore({ sql, tx, now: () => clock.t }, store);
  return { db, store, team, season, clock };
}
type All = ReturnType<typeof makeAll>;

async function user(all: All, login: string, n: number) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "cf-connecting-ip": `8.8.4.${n}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), all.store, undefined, all.team, all.season, {});
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };
  const reg = await call("POST", "/api/register", { id: login, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  token = reg.data.token;
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(login)!.id);
  return { call, id };
}

describe("数の変更の記録の受け口", () => {
  it("管理者でない人は 403、ログインしていなければ 401 (記録・読みこみ・取り消し・版に戻す)", async () => {
    const all = makeAll();
    await user(all, "boss", 1);
    const p = await user(all, "alice", 2);
    for (const [m, path, b] of [
      ["GET", "/api/admin/config/history", undefined],
      ["POST", "/api/admin/config/import", { config: { prizeFinish: 1 } }],
      ["POST", "/api/admin/config/undo", undefined],
      ["POST", "/api/admin/config/history/1/restore", {}],
      ["PUT", "/api/admin/config", { prizeFinish: 1 }],
    ] as const) {
      expect((await p.call(m, path, b)).status, `${m} ${path}`).toBe(403);
      const anon = await handleApi(new Request(`http://x${path}`, { method: m, body: b ? JSON.stringify(b) : undefined }), all.store, undefined, all.team, all.season, {});
      expect(anon.status, `${m} ${path} (ログインなし)`).toBe(401);
    }
    expect(all.season.config().prizeFinish).toBe(DEFAULT_ADMIN_CONFIG.prizeFinish);
    expect(all.season.configLog.list()).toEqual([]);
  });

  it("保存・はじめに戻す・読みこみを、時刻・管理者・前と後つきで残す。変わらない保存は残さない", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const t0 = all.clock.t;
    expect((await boss.call("PUT", "/api/admin/config", { prizePerPoint: 40, season: { tournamentMul: 12 } })).status).toBe(200);
    expect((await boss.call("PUT", "/api/admin/config", { prizePerPoint: 40 })).status).toBe(200);
    all.clock.t += 60_000;
    const imp = await boss.call("POST", "/api/admin/config/import", adminExport({ ...all.season.config(), marketFeeRate: 0.1 }, 0));
    expect(imp.status).toBe(200);
    expect(imp.data.config.marketFeeRate).toBe(0.1);
    all.clock.t += 60_000;
    expect((await boss.call("POST", "/api/admin/config/reset")).status).toBe(200);

    const h = await boss.call("GET", "/api/admin/config/history");
    expect(h.status).toBe(200);
    const e = h.data.entries;
    expect(e.map((x: any) => x.action)).toEqual(["reset", "import", "save"]);
    expect(e[2]).toMatchObject({ at: t0, admin: "boss", adminId: boss.id, ref: null });
    expect(e[2].changes).toEqual([
      { path: "prizePerPoint", before: 20, after: 40 },
      { path: "season.tournamentMul", before: 10, after: 12 },
    ]);
    expect(e[1].changes).toEqual([{ path: "marketFeeRate", before: DEFAULT_ADMIN_CONFIG.marketFeeRate, after: 0.1 }]);
    expect(e[0].changes.map((c: any) => c.path).sort()).toEqual(["marketFeeRate", "prizePerPoint", "season.tournamentMul"]);
    expect(e[0].at).toBe(t0 + 120_000);
  });

  it("読みこみはサーバーでも確かめる: 悪い物は 400 (日本語のわけ) で、数も記録も変わらない", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const bad = await boss.call("POST", "/api/admin/config/import", { config: { marketFeeRate: 3, prizeFinish: 50 } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("市場の手数料");
    const unknown = await boss.call("POST", "/api/admin/config/import", { config: { foo: 1 } });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toContain("知らない項目: foo");
    expect(all.season.config().prizeFinish).toBe(DEFAULT_ADMIN_CONFIG.prizeFinish);
    expect(all.season.configLog.list()).toEqual([]);
  });

  it("直前の変更を取り消す (取り消しも記録に残る)。記録が無ければ 400", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    expect((await boss.call("POST", "/api/admin/config/undo")).status).toBe(400);
    await boss.call("PUT", "/api/admin/config", { prizeFinish: 50 });
    await boss.call("PUT", "/api/admin/config", { prizeFinish: 70, inviteOnly: true });
    const u = await boss.call("POST", "/api/admin/config/undo");
    expect(u.status).toBe(200);
    expect(u.data.config).toMatchObject({ prizeFinish: 50, inviteOnly: false });
    const e = all.season.configLog.list();
    expect(e[0]).toMatchObject({ action: "undo", ref: e[1].id, admin: "boss" });
    expect(e[0].changes).toEqual([
      { path: "prizeFinish", before: 70, after: 50 },
      { path: "inviteOnly", before: true, after: false },
    ]);
  });

  it("この版に戻す: その変更のあとの数に戻り、記録に残る。無い版は 404", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    await boss.call("PUT", "/api/admin/config", { prizeFinish: 50 });
    const first = all.season.configLog.latestId()!;
    await boss.call("PUT", "/api/admin/config", { prizeFinish: 70, leaguePrize: [500, 200, 100] });
    await boss.call("PUT", "/api/admin/config", { marketFeeRate: 0.2 });
    const r = await boss.call("POST", `/api/admin/config/history/${first}/restore`, {});
    expect(r.status).toBe(200);
    expect(r.data.config).toMatchObject({ prizeFinish: 50, leaguePrize: DEFAULT_ADMIN_CONFIG.leaguePrize, marketFeeRate: DEFAULT_ADMIN_CONFIG.marketFeeRate });
    expect(all.season.configLog.list()[0]).toMatchObject({ action: "restore", ref: first });
    // 前の側 (その変更の前) にも戻せる
    const b = await boss.call("POST", `/api/admin/config/history/${first}/restore`, { side: "before" });
    expect(b.data.config.prizeFinish).toBe(DEFAULT_ADMIN_CONFIG.prizeFinish);
    expect((await boss.call("POST", "/api/admin/config/history/999/restore", {})).status).toBe(404);
  });

  it("版に戻すときも今の確かめを通す: 幅の外の数は断り、今は無い項目は捨てる", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    await boss.call("PUT", "/api/admin/config", { prizeFinish: 50 });
    const id = all.season.configLog.latestId()!;
    // 記録の数を書きかえる (古い決まりのときの数・消えた項目のつもり)
    const after = JSON.parse(String(all.db.prepare("SELECT after FROM admin_config_log WHERE id = ?").get(id)!.after));
    all.db.prepare("UPDATE admin_config_log SET after = ? WHERE id = ?").run(JSON.stringify({ ...after, marketFeeRate: 0.9 }), id);
    await boss.call("PUT", "/api/admin/config", { prizeFinish: 60 });
    const bad = await boss.call("POST", `/api/admin/config/history/${id}/restore`, {});
    expect(bad.status).toBe(400);
    expect(all.season.config().prizeFinish).toBe(60);
    all.db.prepare("UPDATE admin_config_log SET after = ? WHERE id = ?").run(JSON.stringify({ ...after, oldField: 1 }), id);
    const ok = await boss.call("POST", `/api/admin/config/history/${id}/restore`, {});
    expect(ok.status).toBe(200);
    expect(ok.data.config.prizeFinish).toBe(50);
    expect("oldField" in ok.data.config).toBe(false);
  });

  it(`新しい物から ${ADMIN_CONFIG_LOG_KEEP} 件だけ残す`, async () => {
    const all = makeAll();
    const by = { id: 1, login: "boss" };
    for (let i = 1; i <= ADMIN_CONFIG_LOG_KEEP + 5; i++) all.season.setConfig({ prizeFinish: i }, by);
    const e = all.season.configLog.list();
    expect(e.length).toBe(ADMIN_CONFIG_LOG_KEEP);
    expect(e[0].changes[0].after).toBe(ADMIN_CONFIG_LOG_KEEP + 5);
    expect(e[e.length - 1].changes[0].after).toBe(6);
    expect(Number(all.db.prepare("SELECT COUNT(*) AS n FROM admin_config_log").get()!.n)).toBe(ADMIN_CONFIG_LOG_KEEP);
  });
});
