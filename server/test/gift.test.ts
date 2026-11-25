// ギフトコード (server/src/gift.ts・shared/src/gift.ts) の試験。コードの文字は試験の中で作った作りものだけを使う (本物のコードは書かない)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CREW,
  DIVISION_COUNT,
  GIFT_KINDS,
  GIFT_RANDOM_CHARS,
  GIFT_RANDOM_LEN,
  NO_GIFT_CAPS,
  RESEARCH_DEFS,
  checkGiftItem,
  checkGiftItems,
  feeDiscount,
  giftFieldOptions,
  moveTeamToDivision,
  newLeagueState,
  joinLeague,
  normalizeGiftCode,
  researchDuration,
  scheduledSlotIndex,
  scheduledSlotStart,
  seasonWindow,
  type GiftItem,
} from "@bpr/shared";
import { AccountStore, type SqlRunner, type SqlValue } from "../src/accounts.ts";
import { handleApi } from "../src/api.ts";
import { GIFT_APPLY, GIFT_FAIL_PER_ACCOUNT, GIFT_MSG, GiftStore, handleGiftApi } from "../src/gift.ts";
import { LeagueStore, type LeagueAccountsPort } from "../src/league.ts";
import { leagueAuth, leagueRoster, leagueTeamData } from "../src/league_accounts.ts";
import { SeasonStore } from "../src/season.ts";
import { TeamStore } from "../src/team.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function sqlite() {
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
  return { db, sql, tx };
}

function makeAll(start = seasonWindow(1).startsAt + DAY + 3 * HOUR) {
  const { db, sql, tx } = sqlite();
  const clock = { t: start };
  const now = () => clock.t;
  let gifts: GiftStore | null = null;
  const store = new AccountStore({ sql, tx, now, iterations: 1000, adminIds: ["boss"] });
  const team = new TeamStore({ sql, tx, now }, store);
  const season = new SeasonStore({ sql, tx, now, teamInfo: (acc, d) => team.raceTeam(acc, d), classMoves: () => gifts!.takeClassMoves() }, store);
  gifts = new GiftStore({ sql, tx, now, caps: () => season.config() }, store, team, season);
  return { db, sql, tx, store, team, season, gifts, clock };
}
type All = ReturnType<typeof makeAll>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; data: Record<string, any> };

async function user(all: All, login: string, n: number, money = 1000) {
  let token = "";
  let ip = `9.9.9.${n}`;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const headers: Record<string, string> = { "cf-connecting-ip": ip };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const p = new URL(req.url).pathname;
    const res = /^\/api\/(gift|admin\/gifts)(\/|$)/.test(p) ? await handleGiftApi(req, p, method, all.store, all.gifts) : await handleApi(req, all.store, undefined, all.team, all.season, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as Record<string, any>;
    if (typeof data.token === "string") token = data.token;
    return { status: res.status, data };
  };
  const reg = await call("POST", "/api/register", { id: login, password: "password1", team: `チーム${n}`, driver: `運転手${n}` });
  expect(reg.status).toBe(201);
  const id = Number(all.db.prepare("SELECT id FROM accounts WHERE login = ?").get(login)!.id);
  all.db.prepare("UPDATE accounts SET money = ? WHERE id = ?").run(money, id);
  return {
    call,
    id,
    login,
    redeem: (code: string) => call("POST", "/api/gift", { code }),
    setIp: (v: string) => (ip = v),
    logout: () => (token = ""),
  };
}
type User = Awaited<ReturnType<typeof user>>;

const money = (all: All, id: number) => Number(all.db.prepare("SELECT money FROM accounts WHERE id = ?").get(id)!.money);
const part = (all: All, id: number, partId: string) => Number((all.db.prepare("SELECT n FROM inventory WHERE account_id = ? AND part_id = ?").get(id, partId) as { n: number } | undefined)?.n ?? 0);
const it1 = (kind: GiftItem["kind"], p: GiftItem["p"]): GiftItem => ({ kind, p });

/** 管理者がコードを作る (コードの文字はこの試験だけの作りもの) */
async function make(boss: User, body: Record<string, unknown>) {
  const r = await boss.call("POST", "/api/admin/gifts", body);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.code as { id: number; code: string; uses: number; state: string; lines: string[] };
}

/** 登録表の種類ごとの、形の通る中身 (はじめの値と候補の 1 つ目) */
function sampleItem(kind: (typeof GIFT_KINDS)[number]): GiftItem {
  const p: Record<string, string | number> = {};
  for (const f of kind.fields) {
    if (f.def !== undefined) p[f.key] = f.def;
    else if (f.type === "part") p[f.key] = "eng_p5";
    else if (f.type === "driver") p[f.key] = "d1";
    else if (f.type === "text") p[f.key] = "テスト";
    else if (f.optional) p[f.key] = "";
    else p[f.key] = giftFieldOptions(f)[0].value;
  }
  return { kind: kind.id, p };
}

describe("中身の種類の登録表", () => {
  it("種類ごとに 当て方 (サーバー) と 項目の形 があり、はじめの値で形が通る", () => {
    expect(new Set(GIFT_KINDS.map((k) => k.id)).size).toBe(GIFT_KINDS.length);
    expect(Object.keys(GIFT_APPLY).sort()).toEqual(GIFT_KINDS.map((k) => k.id).sort());
    for (const k of GIFT_KINDS) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.fields.length).toBeGreaterThan(0);
      const c = checkGiftItem(sampleItem(k));
      expect(c.ok, `${k.id}: ${JSON.stringify(c)}`).toBe(true);
      if (c.ok) expect(k.describe(c.item.p).length).toBeGreaterThan(0);
    }
    // 部と級は次の区切りで効く
    expect(GIFT_KINDS.filter((k) => k.deferred).map((k) => [k.id, k.deferred])).toEqual([
      ["division", "league_day"],
      ["class", "season"],
    ]);
  });

  it("形のおかしい中身は断る。上限ははじめは無い (段階 5・大金も通る)", () => {
    expect(checkGiftItem(it1("money", { amount: 0 })).ok).toBe(false);
    expect(checkGiftItem(it1("money", { amount: 1.5 })).ok).toBe(false);
    expect(checkGiftItem({ kind: "nope", p: {} }).ok).toBe(false);
    expect(checkGiftItem(it1("part", { part: "nope", count: 1 })).ok).toBe(false);
    expect(checkGiftItem(it1("stamp", { stamp: "nope" })).ok).toBe(false);
    expect(checkGiftItem(it1("emblem", { shape: "circle", color: "#ffffff", mark: "star", markColor: "#ffffff" })).ok).toBe(false);
    expect(checkGiftItem(it1("research", { mode: "advance", node: "", hours: 0 })).ok).toBe(false);
    expect(checkGiftItem(it1("division", { division: DIVISION_COUNT + 1 })).ok).toBe(false);
    expect(checkGiftItem(it1("title", { text: "あ".repeat(13) })).ok).toBe(false);
    expect(checkGiftItems([]).ok).toBe(false);
    expect(checkGiftItems([it1("money", { amount: 1_000_000 }), it1("part", { part: "eng_p5", count: 999 }), it1("driver_discount", { pct: 100 })], NO_GIFT_CAPS).ok).toBe(true);
    // 上限を付けたとき
    const caps = { giftMoneyMax: 5000, giftPartTierMax: 4, giftPartCountMax: 10, giftDiscountMax: 50 };
    expect(checkGiftItem(it1("money", { amount: 5001 }), caps).ok).toBe(false);
    expect(checkGiftItem(it1("money", { amount: 5000 }), caps).ok).toBe(true);
    expect(checkGiftItem(it1("part", { part: "eng_p5", count: 1 }), caps).ok).toBe(false);
    expect(checkGiftItem(it1("part", { part: "eng_p4", count: 10 }), caps).ok).toBe(true);
    expect(checkGiftItem(it1("part", { part: "eng_p4", count: 11 }), caps).ok).toBe(false);
    expect(checkGiftItem(it1("driver_discount", { pct: 51 }), caps).ok).toBe(false);
  });

  it("コードの文字は大文字にそろえ、空白を除く", () => {
    expect(normalizeGiftCode(" ab c-d_9 ")).toBe("ABC-D_9");
    expect(normalizeGiftCode("ab")).toBeNull();
    expect(normalizeGiftCode("ab!cd")).toBeNull();
    expect(feeDiscount(1001, 50)).toBe(500);
  });

  it("部を動かす: 今のリーグから外し、その部の空きに入れる (無ければリーグを足す)", () => {
    let st = newLeagueState(0);
    for (const t of ["a", "b", "c"]) st = joinLeague(st, t);
    const moved = moveTeamToDivision(st, "c", 3);
    expect(moved.leagues.find((l) => l.humans.includes("c"))!.division).toBe(3);
    expect(moved.leagues.flatMap((l) => l.humans).sort()).toEqual(["a", "b", "c"]);
    expect(moved.leagues.every((l) => l.humans.length + l.cpus.length === 4)).toBe(true);
    expect(moveTeamToDivision(st, "zz", 3)).toBe(st);
  });
});

describe("ギフトコード: 管理者", () => {
  it("管理者だけが作る・直す・消す・一覧・記録を見られる (ほかの人は 403、ログインなしは 401)", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const g = await make(boss, { items: [it1("money", { amount: 100 })] });
    for (const [m, p, b] of [
      ["GET", "/api/admin/gifts"],
      ["GET", "/api/admin/gifts/options"],
      ["POST", "/api/admin/gifts", { items: [it1("money", { amount: 100 })] }],
      ["PUT", `/api/admin/gifts/${g.id}`, { paused: true }],
      ["DELETE", `/api/admin/gifts/${g.id}`],
      ["GET", `/api/admin/gifts/${g.id}/log`],
    ] as Array<[string, string, unknown?]>) {
      expect((await a.call(m, p, b)).status, `${m} ${p}`).toBe(403);
    }
    a.logout();
    expect((await a.call("GET", "/api/admin/gifts")).status).toBe(401);
    expect((await a.redeem(g.code)).status).toBe(401);
    // 消されていない
    expect((await boss.call("GET", "/api/admin/gifts")).data.codes).toHaveLength(1);
  });

  it("おまかせのコードは 8 字 (0 O 1 I L なし)。決めたコードは大文字にそろえる。同じコードは作れない", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const g = await make(boss, { items: [it1("money", { amount: 100 })] });
    expect(g.code).toHaveLength(GIFT_RANDOM_LEN);
    expect([...g.code].every((c) => GIFT_RANDOM_CHARS.includes(c))).toBe(true);
    const c = await make(boss, { code: "test-code xx", items: [it1("money", { amount: 100 })] });
    expect(c.code).toBe("TEST-CODEXX");
    expect((await boss.call("POST", "/api/admin/gifts", { code: "Test-CodeXX", items: [it1("money", { amount: 1 })] })).status).toBe(409);
    expect((await boss.call("POST", "/api/admin/gifts", { code: "ab", items: [it1("money", { amount: 1 })] })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/gifts", { items: [] })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/gifts", { items: [it1("money", { amount: 1 })], expiresAt: all.clock.t - 1 })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/gifts", { items: [it1("money", { amount: 1 })], targets: ["nobody"] })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/gifts", { items: [it1("driver_hire", { driver: "no-such" })] })).status).toBe(400);
  });

  it("上限は付けたいときだけ (AdminConfig の gift*Max)。はじめは段階 5 の部品も大金も入れられる", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    expect(all.season.config().giftMoneyMax).toBeNull();
    await make(boss, { items: [it1("money", { amount: 1_000_000 }), it1("part", { part: "eng_p5", count: 50 })] });
    all.season.setConfig({ giftMoneyMax: 5000, giftPartTierMax: 4, giftDiscountMax: 50 });
    expect((await boss.call("POST", "/api/admin/gifts", { items: [it1("money", { amount: 5001 })] })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/gifts", { items: [it1("part", { part: "eng_p5", count: 1 })] })).status).toBe(400);
    expect((await boss.call("POST", "/api/admin/gifts", { items: [it1("driver_discount", { pct: 60 })] })).status).toBe(400);
    expect((await boss.call("GET", "/api/admin/gifts")).data.caps).toMatchObject({ giftMoneyMax: 5000, giftPartTierMax: 4, giftPartCountMax: null, giftDiscountMax: 50 });
    expect(() => all.season.setConfig({ giftPartTierMax: 6 })).toThrow();
    all.season.setConfig({ giftMoneyMax: null });
    await make(boss, { items: [it1("money", { amount: 9999 })] });
  });

  it("作ったあとで 中身・人数・期限・コードの文字 を直せる。文字を変えても使った人の記録はつながったまま。止める / 戻す・消す", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const b = await user(all, "bob", 3);
    const g = await make(boss, { code: "OLDTEXT1", items: [it1("money", { amount: 100 })], note: "試し" });
    expect((await a.redeem("oldtext1")).status).toBe(200);
    const up = await boss.call("PUT", `/api/admin/gifts/${g.id}`, { code: "newtext2", items: [it1("money", { amount: 300 })], maxUses: 5, expiresAt: all.clock.t + DAY });
    expect(up.status).toBe(200);
    expect(up.data.code).toMatchObject({ code: "NEWTEXT2", uses: 1, maxUses: 5, lines: ["お金 300"] });
    // 前の文字はもう無い。alice は同じコード (番号) なのでもう受け取れない
    expect((await b.redeem("OLDTEXT1")).data.error).toBe(GIFT_MSG.none);
    expect((await a.redeem("NEWTEXT2")).data.error).toBe(GIFT_MSG.already);
    // 止める → 使えない → 戻す
    expect((await boss.call("PUT", `/api/admin/gifts/${g.id}`, { paused: true })).data.code.state).toBe("paused");
    expect((await b.redeem("NEWTEXT2")).data.error).toBe(GIFT_MSG.paused);
    await boss.call("PUT", `/api/admin/gifts/${g.id}`, { paused: false });
    const got = await b.redeem("NEWTEXT2");
    expect(got.status).toBe(200);
    expect(got.data.received).toEqual(["お金 300"]);
    // 誰がいつ (表示名と、管理者だけに ID)
    const log = await boss.call("GET", `/api/admin/gifts/${g.id}/log`);
    expect(log.data.rows.map((r: { team: string; login: string }) => [r.team, r.login]).sort()).toEqual([
      ["チーム2", "alice"],
      ["チーム3", "bob"],
    ]);
    // ほかの人のコードの文字にはできない
    await make(boss, { code: "OTHERONE", items: [it1("money", { amount: 1 })] });
    expect((await boss.call("PUT", `/api/admin/gifts/${g.id}`, { code: "otherone" })).status).toBe(409);
    // 消す
    expect((await boss.call("DELETE", `/api/admin/gifts/${g.id}`)).status).toBe(200);
    expect((await boss.call("GET", "/api/admin/gifts")).data.codes.map((c: { code: string }) => c.code)).toEqual(["OTHERONE"]);
    expect((await a.redeem("NEWTEXT2")).data.error).toBe(GIFT_MSG.none);
    expect((await boss.call("DELETE", `/api/admin/gifts/${g.id}`)).status).toBe(404);
  });
});

describe("ギフトコード: 受け取る", () => {
  it("大文字小文字を区別しない。お金は財布へ (wallet_log の理由は gift)。1 人 1 回", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2, 1000);
    await make(boss, { code: "CaseTest9", items: [it1("money", { amount: 2500 }), it1("part", { part: "eng_p2", count: 2 })] });
    const r = await a.redeem("  casetest9 ");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ received: ["お金 2,500", "部品: 高回転エンジン ×2"], later: [], money: 3500 });
    expect(r.data.parts.eng_p2).toBe(part(all, a.id, "eng_p2"));
    expect(money(all, a.id)).toBe(3500);
    const log = all.db.prepare("SELECT delta, reason FROM wallet_log WHERE account_id = ? ORDER BY id DESC LIMIT 1").get(a.id);
    expect(log).toEqual({ delta: 2500, reason: "gift" });
    const again = await a.redeem("CASETEST9");
    expect(again.status).toBe(409);
    expect(again.data.error).toBe(GIFT_MSG.already);
    expect(money(all, a.id)).toBe(3500);
  });

  it("使える人数の上限・期限・使える人の指定", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const b = await user(all, "bob", 3);
    const c = await user(all, "carol", 4);
    await make(boss, { code: "ONLYONE1", maxUses: 1, items: [it1("money", { amount: 10 })] });
    expect((await a.redeem("ONLYONE1")).status).toBe(200);
    const used = await b.redeem("ONLYONE1");
    expect([used.status, used.data.error]).toEqual([410, GIFT_MSG.usedUp]);
    await make(boss, { code: "SOONGONE", expiresAt: all.clock.t + HOUR, items: [it1("money", { amount: 10 })] });
    expect((await a.redeem("SOONGONE")).status).toBe(200);
    all.clock.t += HOUR;
    const ex = await b.redeem("SOONGONE");
    expect([ex.status, ex.data.error]).toEqual([410, GIFT_MSG.expired]);
    await make(boss, { code: "FORCAROL", targets: ["Carol"], items: [it1("money", { amount: 10 })] });
    const no = await b.redeem("FORCAROL");
    expect([no.status, no.data.error]).toEqual([403, GIFT_MSG.notForYou]);
    expect((await c.redeem("forcarol")).status).toBe(200);
    expect((await b.redeem("NOSUCHCODE")).data.error).toBe(GIFT_MSG.none);
    const list = (await boss.call("GET", "/api/admin/gifts")).data.codes as Array<{ code: string; uses: number; state: string }>;
    expect(Object.fromEntries(list.map((x) => [x.code, [x.uses, x.state]]))).toEqual({ ONLYONE1: [1, "used_up"], SOONGONE: [1, "expired"], FORCAROL: [1, "active"] });
  });

  it("打ちまちがいはアカウントごとに 15 分に 5 回まで (正しいコードも止まる)。つなぎ元ごとにも数える", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    await make(boss, { code: "REALONE1", items: [it1("money", { amount: 10 })] });
    for (let i = 0; i < GIFT_FAIL_PER_ACCOUNT; i++) expect((await a.redeem(`WRONG${i}XX`)).status).toBe(404);
    const stop = await a.redeem("REALONE1");
    expect([stop.status, stop.data.error]).toEqual([429, GIFT_MSG.limit]);
    all.clock.t += 15 * 60_000;
    expect((await a.redeem("REALONE1")).status).toBe(200);
    // つなぎ元ごと: 6 人が同じつなぎ元から 5 回ずつ → 30 回で止まる
    const users: User[] = [];
    for (let i = 0; i < 7; i++) {
      const u = await user(all, `ip${i}`, 10 + i);
      u.setIp("7.7.7.7");
      users.push(u);
    }
    for (let i = 0; i < 6; i++) for (let k = 0; k < 5; k++) await users[i].redeem(`BAD${k}CODE`);
    expect((await users[6].redeem("REALONE1")).status).toBe(429);
    users[6].setIp("8.8.8.8");
    expect((await users[6].redeem("REALONE1")).status).toBe(200);
  });

  it("中身は 1 回で全部。1 つでも受け取れなければ何も受け取らず、コードも使ったことにならない (打ちまちがいにも数えない)", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2, 200_000);
    const b = await user(all, "bob", 3, 1000);
    const d = (await a.call("GET", "/api/drivers")).data.free[0];
    expect((await a.call("POST", "/api/drivers/hire", { driverId: d.id })).status).toBe(200);
    await make(boss, { code: "TAKENDRV", items: [it1("money", { amount: 500 }), it1("driver_hire", { driver: d.id })] });
    for (let i = 0; i < GIFT_FAIL_PER_ACCOUNT + 1; i++) {
      const r = await b.redeem("TAKENDRV");
      expect(r.status).toBe(409);
      expect(r.data.error).toContain("今は受け取れません");
    }
    expect(money(all, b.id)).toBe(1000);
    expect((await boss.call("GET", "/api/admin/gifts")).data.codes[0].uses).toBe(0);
  });
});

describe("ギフトコード: 中身の種類ごと", () => {
  it("部品 (研究の部品・段階 5 も)・はんこ・称号・紋章・見本の設計図・整備の組", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    await make(boss, {
      code: "MANYKINDS",
      items: [
        it1("part", { part: "eng_p5", count: 3 }),
        it1("stamp", { stamp: "tournament_win" }),
        it1("title", { text: "試しの称号" }),
        it1("emblem", { shape: "hexagon", color: "#00a651", mark: "bolt", markColor: "#ffffff" }),
        it1("design", { preset: "sample" }),
        it1("crew", { levels: 2 }),
      ],
    });
    const r = await a.redeem("manykinds");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.received).toHaveLength(6);
    expect(part(all, a.id, "eng_p5")).toBe(3);
    expect(all.season.myStamps(a.id).stamps.map((x) => x.id)).toEqual(["tournament_win"]);
    const t = (await a.call("GET", "/api/team")).data;
    expect(t.giftTitle).toBe("試しの称号");
    expect(t.emblem).toEqual({ shape: "hexagon", color: "#00a651", mark: "bolt", markColor: "#ffffff" });
    expect(t.crew.level).toBe(3);
    expect(t.designs.some((x: { name: string }) => x.name === "見本の車")).toBe(true);
    expect((await a.call("GET", "/api/gift/status")).data).toMatchObject({ title: "試しの称号", discountPct: 0, pending: [] });
    // 整備の組は一番上で止まる
    await make(boss, { code: "CREWMAX1", items: [it1("crew", { levels: CREW.maxLevel - 1 })] });
    expect((await a.redeem("CREWMAX1")).status).toBe(200);
    expect((await a.call("GET", "/api/team")).data.crew.level).toBe(CREW.maxLevel);
  });

  it("運転手: 決めた運転手とただで契約・能力を上げる (100 まで)。運転手がいないと能力は受け取れない", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2, 0);
    await make(boss, { code: "STATSUP1", items: [it1("driver_stats", { stat: "all", amount: 100 })] });
    expect((await a.redeem("STATSUP1")).status).toBe(409);
    const opts = (await boss.call("GET", "/api/admin/gifts/options")).data.drivers as Array<{ id: string; team: string | null }>;
    const d = opts.find((x) => x.team === null)!;
    await make(boss, { code: "FREEHIRE", items: [it1("driver_stats", { stat: "speed", amount: 7 }), it1("driver_hire", { driver: d.id })] });
    const r = await a.redeem("FREEHIRE");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    // 雇ってから上げる (登録表の順に当てる)
    const mine = (await a.call("GET", "/api/drivers")).data.mine;
    expect(mine.id).toBe(d.id);
    expect(money(all, a.id)).toBe(0);
    const before = mine.stats.speed;
    expect((await a.redeem("STATSUP1")).status).toBe(200);
    const after = (await a.call("GET", "/api/drivers")).data.mine;
    expect(Object.values(after.stats)).toEqual([100, 100, 100, 100]);
    expect(Object.values(after.potential)).toEqual([100, 100, 100, 100]);
    expect(before).toBeLessThan(100);
  });

  it("研究: どの節も済ませる (前の節もいっしょに)・研究中のものを進める。研究していないと進める分は受け取れない", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2, 1_000_000);
    const deep = RESEARCH_DEFS.find((d) => d.id === "r_eng_p5")!;
    await make(boss, { code: "FINISHP5", items: [it1("research", { mode: "finish", node: deep.id, hours: 0 })] });
    expect((await a.redeem("FINISHP5")).status).toBe(200);
    const tree = (await a.call("GET", "/api/research")).data;
    const state = Object.fromEntries((tree.tree as Array<{ id: string; state: string }>).map((x) => [x.id, x.state]));
    expect([state.r_eng_p3, state.r_eng_p4, state.r_eng_p5]).toEqual(["done", "done", "done"]);
    // 進める
    await make(boss, { code: "ADVANCE5", items: [it1("research", { mode: "advance", node: "", hours: 5 })] });
    expect((await a.redeem("ADVANCE5")).status).toBe(409);
    expect((await a.call("POST", "/api/research/start", { researchId: "r_tire_n3" })).status).toBe(200);
    expect((await a.redeem("ADVANCE5")).status).toBe(200);
    const t = (await a.call("GET", "/api/team")).data;
    const p = t.research.find((x: { researchId: string }) => x.researchId === "r_tire_n3");
    const total = researchDuration(RESEARCH_DEFS.find((d) => d.id === "r_tire_n3")!);
    expect(p.progress).toBeCloseTo((5 * HOUR) / total, 5);
    // 研究中のものを済ませる
    await make(boss, { code: "FINISHNOW", items: [it1("research", { mode: "finish", node: "", hours: 0 })] });
    expect((await a.redeem("FINISHNOW")).status).toBe(200);
    const st2 = Object.fromEntries(((await a.call("GET", "/api/research")).data.tree as Array<{ id: string; state: string }>).map((x) => [x.id, x.state]));
    expect(st2.r_tire_n3).toBe("done");
  });

  it("契約金の割引: 次に雇うときに 1 回だけ効いて消える (重ねて持つと大きいほう)", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2, 200_000);
    await make(boss, { code: "HALFFEE1", items: [it1("driver_discount", { pct: 50 })] });
    await make(boss, { code: "SMALLFEE", items: [it1("driver_discount", { pct: 10 })] });
    expect((await a.redeem("HALFFEE1")).status).toBe(200);
    expect((await a.redeem("SMALLFEE")).status).toBe(200);
    const v = (await a.call("GET", "/api/drivers")).data;
    expect(v.discountPct).toBe(50);
    const d = v.free[0];
    const before = money(all, a.id);
    const hire = await a.call("POST", "/api/drivers/hire", { driverId: d.id });
    expect(hire.status).toBe(200);
    expect(hire.data.discount).toBe(Math.floor(d.signCost / 2));
    expect(before - money(all, a.id)).toBe(d.signCost - Math.floor(d.signCost / 2));
    expect((await a.call("GET", "/api/drivers")).data.discountPct).toBe(0);
    // 消えたので次はふつうの値
    const d2 = (await a.call("GET", "/api/drivers")).data.free[0];
    const pen = (await a.call("GET", "/api/drivers")).data.mine.penalty;
    const m2 = money(all, a.id);
    const h2 = await a.call("POST", "/api/drivers/hire", { driverId: d2.id });
    expect(h2.data.discount).toBe(0);
    expect(m2 - money(all, a.id)).toBe(d2.signCost + pen);
  });

  it("契約金の割引: 季節の切れ目の契約の更新にも効いて消える", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2, 200_000);
    const d = (await a.call("GET", "/api/drivers")).data.free[0];
    expect((await a.call("POST", "/api/drivers/hire", { driverId: d.id })).status).toBe(200);
    await make(boss, { code: "RENEWOFF", items: [it1("driver_discount", { pct: 30 })] });
    expect((await a.redeem("RENEWOFF")).status).toBe(200);
    const fee = (await a.call("GET", "/api/drivers")).data.mine.fee as number;
    const before = money(all, a.id);
    all.clock.t = seasonWindow(2).startsAt + HOUR;
    const v = (await a.call("GET", "/api/drivers")).data;
    expect(v.mine.id).toBe(d.id);
    expect(before - money(all, a.id)).toBe(fee - feeDiscount(fee, 30));
    expect(v.discountPct).toBe(0);
  });

  it("本戦の級: すぐには変わらず、次の季節の締めで効く", async () => {
    const all = makeAll();
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    all.season.tick();
    await make(boss, { code: "TOPCLASS", items: [it1("class", { cls: 2 })] });
    const r = await a.redeem("TOPCLASS");
    expect(r.data).toMatchObject({ received: [], later: ["本戦 2 級へ (次の季節の締めで)"] });
    expect((await a.call("GET", "/api/gift/status")).data.pending).toEqual([{ kind: "class", target: 2 }]);
    expect(all.season.classOf(a.id)).toBeNull();
    all.clock.t = seasonWindow(2).startsAt + HOUR;
    expect(all.season.tick().closed).toEqual([1]);
    expect(all.season.classOf(a.id)).toBe(2);
    expect((await a.call("GET", "/api/gift/status")).data.pending).toEqual([]);
  });
});

describe("ギフトコード: リーグ戦の部は次の日の締めで", () => {
  it("部の動きは締めのあとに当たり、アカウントの DO の待ちから消える", async () => {
    // 日本時間 2026-12-03 (木) 0:30
    const all = makeAll(Date.UTC(2026, 11, 2, 15, 30));
    const boss = await user(all, "boss", 1);
    const a = await user(all, "alice", 2);
    const b = await user(all, "bob", 3);
    const l = sqlite();
    const port: LeagueAccountsPort = {
      roster: async () => leagueRoster(all.sql),
      auth: async (t) => leagueAuth(all.store, t),
      teams: async (ids) => ids.map((id) => leagueTeamData(all.store, all.team, id)).filter((x) => x !== null),
      recordRace: async (raceId, report, accountOf) => all.team.recordRace(raceId, report, accountOf),
      payPrizes: async (id, items) => void all.store.payPrizes(id, items),
      constructorsDay: async () => {},
      adminConfig: async () => null,
      moves: async () => all.gifts.leagueMoves(),
      ackMoves: async (ids) => all.gifts.ackLeagueMoves(ids),
    };
    const league = new LeagueStore({ sql: l.sql, tx: l.tx, now: () => all.clock.t }, port);
    await make(boss, { code: "DIVTHREE", items: [it1("division", { division: 3 })] });
    const r = await a.redeem("DIVTHREE");
    expect(r.data.later).toHaveLength(1);
    const dayStart = Date.UTC(2026, 11, 2, 15, 0);
    const slot = (k: number) => scheduledSlotStart(scheduledSlotIndex(dayStart) + k) + 60_000;
    const divOf = (id: number) => league.state().leagues.find((x) => x.humans.includes(String(id)))?.division;
    for (let k = 0; k < 12; k++) {
      all.clock.t = slot(k);
      await league.poke();
      for (let i = 0; i < 20 && (await league.step(all.clock.t)); i++);
      // 締めの前は動かない
      if (k < 11) expect(divOf(a.id)).toBe(8);
    }
    await league.flushOutbox();
    expect(divOf(a.id)).toBe(3);
    expect(divOf(b.id)).toBe(8);
    expect(all.gifts.leagueMoves()).toEqual([]);
    expect((await a.call("GET", "/api/gift/status")).data.pending).toEqual([]);
    void boss;
  });
});
