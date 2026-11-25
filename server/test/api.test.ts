// アカウントの受け口の試験。DO の SQLite の代わりに node:sqlite を使う
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SAMPLE_DESIGN, STARTING_MONEY, STARTER_BOX, shopPrice } from "@bpr/shared";
import { AccountStore, LOGIN_FAIL_PER_ID, SESSION_MS, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { hashPassword, verifyPassword } from "../src/crypto.ts";

function makeStore(opts: { admins?: string[]; clock?: { t: number } } = {}) {
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
  const clock = opts.clock ?? { t: 1_000_000 };
  const store = new AccountStore({ sql, tx, now: () => clock.t, adminIds: opts.admins ?? [], iterations: 1000 });
  return { store, db, clock };
}

function client(store: AccountStore) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown, ip = "1.2.3.4") => {
    const headers: Record<string, string> = { "cf-connecting-ip": ip };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApi(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), store);
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  return {
    call,
    get token() {
      return token;
    },
    set token(t: string) {
      token = t;
    },
  };
}

const REG = { id: "Kai_01", password: "password1", team: "青図レーシング", driver: "カイ" };

describe("パスワードの印", () => {
  it("同じパスワードでも塩で印が変わり、確かめられる", async () => {
    const a = await hashPassword("secret-pass", 1000);
    const b = await hashPassword("secret-pass", 1000);
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret-pass");
    expect(await verifyPassword("secret-pass", a)).toBe(true);
    expect(await verifyPassword("secret-pasS", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("アカウントの受け口", () => {
  it("登録 → 自分 → 持ち物 (はじめの箱とお金) → ログアウト → ログイン", async () => {
    const { store, db } = makeStore();
    const c = client(store);
    const reg = await c.call("POST", "/api/register", REG);
    expect(reg.status).toBe(201);
    expect(reg.data.me).toMatchObject({ id: "kai_01", team: "青図レーシング", driver: "カイ", money: STARTING_MONEY, namesFree: false, admin: false });
    // 平文のパスワードと合い言葉は保存しない
    const dump = JSON.stringify(db.prepare("SELECT * FROM accounts").all()) + JSON.stringify(db.prepare("SELECT * FROM sessions").all());
    expect(dump).not.toContain("password1");
    expect(dump).not.toContain(c.token);

    expect((await c.call("GET", "/api/me")).data.me.driver).toBe("カイ");
    const inv = await c.call("GET", "/api/inventory");
    expect(inv.data).toEqual({ money: STARTING_MONEY, parts: { ...STARTER_BOX } });

    expect((await c.call("POST", "/api/logout")).status).toBe(200);
    expect((await c.call("GET", "/api/me")).status).toBe(401);
    c.token = "";
    expect((await c.call("POST", "/api/login", { id: "kai_01", password: "wrong-pass" })).status).toBe(401);
    const ok = await c.call("POST", "/api/login", { id: "KAI_01", password: "password1" });
    expect(ok.status).toBe(200);
    expect((await c.call("GET", "/api/me")).status).toBe(200);
  });

  it("同じ ID・同じ表示名は使えない。まちがった入力は 400", async () => {
    const { store } = makeStore();
    const c = client(store);
    await c.call("POST", "/api/register", REG);
    expect((await c.call("POST", "/api/register", { ...REG, team: "別", driver: "別人" })).status).toBe(409);
    expect((await c.call("POST", "/api/register", { ...REG, id: "other", driver: "別人" })).status).toBe(409);
    // 半角のｶｲ は カイ と同じ名前
    expect((await c.call("POST", "/api/register", { ...REG, id: "other", team: "別", driver: "ｶｲ" })).status).toBe(409);
    expect((await c.call("POST", "/api/register", { ...REG, id: "other", team: "別", driver: "カイ2" })).status).toBe(201);
    expect((await c.call("POST", "/api/register", { ...REG, id: "x2", password: "short" })).status).toBe(400);
    expect((await c.call("POST", "/api/register", { ...REG, id: "x3", team: "管理者チーム" })).status).toBe(400);
    expect((await c.call("POST", "/api/register", "not json")).status).toBe(400);
  });

  it("ログインの失敗が続くと止める", async () => {
    const { store, clock } = makeStore();
    const c = client(store);
    await c.call("POST", "/api/register", REG);
    c.token = "";
    for (let i = 0; i < LOGIN_FAIL_PER_ID; i++) expect((await c.call("POST", "/api/login", { id: "kai_01", password: "nope-nope" })).status).toBe(401);
    expect((await c.call("POST", "/api/login", { id: "kai_01", password: "password1" })).status).toBe(429);
    clock.t += 16 * 60_000;
    expect((await c.call("POST", "/api/login", { id: "kai_01", password: "password1" })).status).toBe(200);
  });

  it("ログインは期限で切れる", async () => {
    const { store, clock } = makeStore();
    const c = client(store);
    await c.call("POST", "/api/register", REG);
    clock.t += SESSION_MS + 1;
    expect((await c.call("GET", "/api/me")).status).toBe(401);
  });

  it("お店で買う: お金が減り部品が増える。足りなければ断る", async () => {
    const { store } = makeStore();
    const c = client(store);
    await c.call("POST", "/api/register", REG);
    const shop = await c.call("GET", "/api/shop");
    expect(shop.data.items.find((x: { id: string }) => x.id === "eng_p2").price).toBe(shopPrice("eng_p2"));
    const price = shopPrice("tire_l2")!;
    const buy = await c.call("POST", "/api/shop/buy", { part: "tire_l2", qty: 2 });
    expect(buy.status).toBe(200);
    expect(buy.data.money).toBe(STARTING_MONEY - price * 2);
    expect(buy.data.parts.tire_l2).toBe(2);
    expect((await c.call("POST", "/api/shop/buy", { part: "eng_p2", qty: 1 })).status).toBe(400);
    expect((await c.call("POST", "/api/shop/buy", { part: "nope", qty: 1 })).status).toBe(400);
    expect((await c.call("POST", "/api/shop/buy", { part: "tire_n1", qty: -3 })).status).toBe(400);
    expect((await c.call("GET", "/api/inventory")).data.money).toBe(STARTING_MONEY - price * 2);
  });

  it("設計図: 保存・一覧・上書き・削除。持っていない部品は断る", async () => {
    const { store } = makeStore();
    const c = client(store);
    await c.call("POST", "/api/register", REG);
    const saved = await c.call("POST", "/api/designs", { design: SAMPLE_DESIGN });
    expect(saved.status).toBe(201);
    const id = saved.data.saved.id;
    const list = await c.call("GET", "/api/designs");
    expect(list.data.designs.length).toBe(1);
    expect(list.data.designs[0].design.parts).toEqual(SAMPLE_DESIGN.parts);
    expect((await c.call("PUT", `/api/designs/${id}`, { design: { name: "改", parts: [] } })).data.saved.name).toBe("改");
    const tooMany = { name: "x", parts: [0, 2, 4].map((col) => ({ id: "eng_m1", c: col, r: 0, rot: 0 })) };
    const bad = await c.call("POST", "/api/designs", { design: tooMany });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("中型エンジン ×2");
    expect((await c.call("POST", "/api/designs", { design: { name: "x", parts: [{ id: "seat", c: 9, r: 0, rot: 0 }] } })).status).toBe(400);
    expect((await c.call("DELETE", `/api/designs/${id}`)).status).toBe(200);
    expect((await c.call("DELETE", `/api/designs/${id}`)).status).toBe(404);

    // ほかの人の設計図は消せない
    const other = client(store);
    await other.call("POST", "/api/register", { ...REG, id: "other", team: "別", driver: "別人" });
    const mine = await c.call("POST", "/api/designs", { design: SAMPLE_DESIGN });
    expect((await other.call("DELETE", `/api/designs/${mine.data.saved.id}`)).status).toBe(404);
  });

  it("表示名は季節の切れ目 (names_free) のときだけ変えられる", async () => {
    const { store } = makeStore();
    const c = client(store);
    const reg = await c.call("POST", "/api/register", REG);
    expect((await c.call("PUT", "/api/me/names", { team: "新チーム", driver: "新名" })).status).toBe(403);
    store.allowNameChange("all");
    expect((await c.call("GET", "/api/me")).data.me.namesFree).toBe(true);
    const ch = await c.call("PUT", "/api/me/names", { team: "新チーム", driver: "新名" });
    expect(ch.status).toBe(200);
    expect(ch.data.me).toMatchObject({ team: "新チーム", driver: "新名", namesFree: false });
    expect(reg.data.me.id).toBe("kai_01");
  });

  it("退会: パスワードを確かめて全部消える。同じ ID でまた登録できる", async () => {
    const { store, db } = makeStore();
    const c = client(store);
    await c.call("POST", "/api/register", REG);
    await c.call("POST", "/api/designs", { design: SAMPLE_DESIGN });
    expect((await c.call("DELETE", "/api/me", { password: "wrong-pass" })).status).toBe(401);
    expect((await c.call("DELETE", "/api/me", { password: "password1" })).status).toBe(200);
    expect((await c.call("GET", "/api/me")).status).toBe(401);
    for (const t of ["accounts", "sessions", "inventory", "designs", "wallet_log"]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
    c.token = "";
    expect((await c.call("POST", "/api/register", REG)).status).toBe(201);
  });

  it("管理者だけがパスワードを戻せる。戻すとその人のログインは切れる", async () => {
    const { store } = makeStore({ admins: ["boss"] });
    const user = client(store);
    await user.call("POST", "/api/register", REG);
    const boss = client(store);
    const b = await boss.call("POST", "/api/register", { id: "boss", password: "boss-pass", team: "本部", driver: "ボス" });
    expect(b.data.me.admin).toBe(true);
    expect((await user.call("POST", "/api/admin/reset-password", { id: "boss" })).status).toBe(403);
    const r = await boss.call("POST", "/api/admin/reset-password", { id: "kai_01" });
    expect(r.status).toBe(200);
    expect(r.data.password.length).toBe(12);
    expect((await user.call("GET", "/api/me")).status).toBe(401);
    user.token = "";
    expect((await user.call("POST", "/api/login", { id: "kai_01", password: r.data.password })).status).toBe(200);
    expect((await boss.call("POST", "/api/admin/reset-password", { id: "nobody" })).status).toBe(404);
  });

  it("レース: 合い言葉でアカウントがわかり、賞金は同じレースに 1 回だけ入る", async () => {
    const { store } = makeStore();
    const c = client(store);
    await c.call("POST", "/api/register", REG);
    const entry = await store.raceEntry(c.token, SAMPLE_DESIGN);
    expect(entry.account?.driver).toBe("カイ");
    expect((await store.raceEntry("bad-token", SAMPLE_DESIGN)).account).toBeNull();
    expect((await store.raceEntry(undefined, SAMPLE_DESIGN)).account).toBeNull();
    const cheat = { name: "x", parts: [{ id: "eng_p2", c: 0, r: 0, rot: 0 }] };
    expect((await store.raceEntry(c.token, cheat)).error).toBeTruthy();

    const accId = entry.account!.id;
    const w = store.payPrizes("race-1", [{ accountId: accId, amount: 300, reason: "レース" }]);
    expect(w[accId]).toBe(STARTING_MONEY + 300);
    expect(store.payPrizes("race-1", [{ accountId: accId, amount: 300, reason: "レース" }])).toEqual({});
    expect(store.payPrizes("race-2", [{ accountId: 999, amount: 300, reason: "退会した人" }])).toEqual({});
    expect((await c.call("GET", "/api/inventory")).data.money).toBe(STARTING_MONEY + 300);
  });

  it("知らない道は 404", async () => {
    const { store } = makeStore();
    const c = client(store);
    expect((await c.call("GET", "/api/nothing")).status).toBe(404);
    expect((await c.call("GET", "/api/me")).status).toBe(401);
  });
});
