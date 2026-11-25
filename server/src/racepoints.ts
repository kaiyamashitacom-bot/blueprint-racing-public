// 走行点 (DECISIONS 11/25「走って点をためて交換」) の保存・交換所・/api/rp と /api/admin/rp の受け口。
// アカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。点の入り方の決まりと交換所の形は shared/src/racepoints.ts。
// - 残高は rp_wallet (アカウントごと)、出入りは全部 rp_ledger (わけ・数・時刻・種類)
// - レースの点 (earnRacePoints) は季節 (season.ts) と 1 周アタック (timeattack.ts) が、結果と同じ取りまとめの中で呼ぶ。
//   1 日 (日本時間) の上限は rp_wallet の day / day_earned で数える (大会・ギフト・景品は上限の外)
// - 交換は 1 回の取りまとめ: 点を引く → 交換の記録 → 中身をギフトと同じ当て方 (gift.ts の GiftStore.applyInTx) で当てる。
//   1 つでも当てられなければ (研究していない・持てる数を超える など) 全部戻る (点も減らない)
// - 交換の回数の制限: アカウントごと 1 分に RP_BUY_PER_MIN 回 (押しすぎ・道具での連打を止める)
// 数は全部 (仮)。
import {
  DEFAULT_RP_SHOP,
  RP_KIND_JP,
  RP_SHOP_MAX,
  checkRpShopInput,
  jstWeekStart,
  rpCapped,
  rpDay,
  rpForRace,
  rpForTa,
  type AdminConfig,
  type GiftItem,
  type RpKind,
  type RpShopEntry,
  type RpShopInput,
} from "@bpr/shared";
import { ApiError, type Account, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";
import type { GiftStore } from "./gift.ts";

export const RP_PATH = /^\/api\/(rp|admin\/rp)(\/|$)/;

/** 交換: アカウントごと 1 分にこれだけ (仮) */
export const RP_BUY_PER_MIN = 10;
const RP_BUY_WINDOW_MS = 60_000;
/** 画面に返す 交換の記録・帳簿 の数 (仮) */
export const RP_HISTORY_MAX = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rp_wallet (
  account_id INTEGER PRIMARY KEY,
  points INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  day_earned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rp_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rp_ledger_account ON rp_ledger(account_id, at);
CREATE TABLE IF NOT EXISTS rp_shop (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL,
  price INTEGER NOT NULL,
  limit_week INTEGER,
  limit_total INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rp_buys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  lines TEXT NOT NULL DEFAULT '[]',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rp_buys_account ON rp_buys(account_id, entry_id, at);
CREATE TABLE IF NOT EXISTS rp_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

/**
 * 表は 1 つの SQLite に 1 回だけ作る。取りまとめ (transaction) の中で初めて作ると、戻したときに表も消えるので、
 * 使う係 (季節・ギフト・交換所) の作るとき (取りまとめの外) に呼ぶ
 */
const ready = new WeakSet<object>();
export function ensureRpSchema(sql: SqlRunner): void {
  if (ready.has(sql)) return;
  for (const stmt of SCHEMA.split(";")) if (stmt.trim()) sql.exec(stmt);
  ready.add(sql);
}

const one = (sql: SqlRunner, q: string, ...b: SqlValue[]) => sql.exec(q, ...b).toArray()[0];

/** 残高と今日の分 (日が変わっていれば今日の分は 0) */
function walletOf(sql: SqlRunner, accountId: number, at: number): { points: number; dayEarned: number } {
  const r = one(sql, "SELECT points, day, day_earned FROM rp_wallet WHERE account_id = ?", accountId);
  if (!r) return { points: 0, dayEarned: 0 };
  return { points: Number(r.points), dayEarned: Number(r.day) === rpDay(at) ? Number(r.day_earned) : 0 };
}

/** 残高を動かして帳簿に書く。dayAdd = 今日の上限に数える分。動かしたあとの残高 */
function move(sql: SqlRunner, accountId: number, delta: number, kind: RpKind, reason: string, at: number, dayAdd = 0): number {
  const w = walletOf(sql, accountId, at);
  const points = w.points + delta;
  sql.exec(
    "INSERT INTO rp_wallet (account_id, points, day, day_earned) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET points = excluded.points, day = excluded.day, day_earned = excluded.day_earned",
    accountId,
    points,
    rpDay(at),
    w.dayEarned + dayAdd,
  );
  sql.exec("INSERT INTO rp_ledger (account_id, delta, kind, reason, at) VALUES (?, ?, ?, ?, ?)", accountId, delta, kind, reason.slice(0, 80), at);
  return points;
}

const accountExists = (sql: SqlRunner, accountId: number) => !!one(sql, "SELECT id FROM accounts WHERE id = ?", accountId);

/** レースで入った走行点 (画面の知らせ用) */
export interface RpEarn {
  /** 入った点 */
  earned: number;
  /** 上限が無ければ入った点 */
  wanted: number;
  /** 今日あと何点もらえるか (上限の外のものでも今の残り) */
  left: number;
  /** 入ったあとの残高 */
  points: number;
}

/**
 * レース・大会・1 周アタックで走行点を入れる (呼ぶ側の取りまとめの中で)。capped = 1 日の上限に数える。
 * 走行点が切 (rpOn = false) なら 0。アカウントが無ければ null
 */
export function earnRacePoints(
  sql: SqlRunner,
  cfg: Readonly<AdminConfig>,
  accountId: number,
  amount: number,
  o: { kind: RpKind; reason: string; at: number; capped: boolean },
): RpEarn | null {
  ensureRpSchema(sql);
  if (!accountExists(sql, accountId)) return null;
  const w = walletOf(sql, accountId, o.at);
  const wanted = cfg.rpOn ? Math.max(0, Math.floor(amount)) : 0;
  const leftBefore = Math.max(0, cfg.rpDailyCap - w.dayEarned);
  const earned = o.capped ? rpCapped(wanted, w.dayEarned, cfg.rpDailyCap) : wanted;
  const points = earned > 0 ? move(sql, accountId, earned, o.kind, o.reason, o.at, o.capped ? earned : 0) : w.points;
  return { earned, wanted, left: o.capped ? leftBefore - earned : leftBefore, points };
}

/** すぐ走る・部屋の 1 台 (自分で走った車だけ。上限あり) */
export function earnRaceFinish(sql: SqlRunner, cfg: Readonly<AdminConfig>, accountId: number, row: { pos: number; finished: boolean }, laps: number, at: number): RpEarn | null {
  return earnRacePoints(sql, cfg, accountId, rpForRace(cfg, row, { laps, kind: "everyday" }), { kind: "race", reason: `レース ${laps} 周 ${row.pos} 位`, at, capped: true });
}

/** 1 周アタックの 1 周 (上限あり) */
export function earnTaLap(sql: SqlRunner, cfg: Readonly<AdminConfig>, accountId: number, improved: boolean, at: number): RpEarn | null {
  return earnRacePoints(sql, cfg, accountId, rpForTa(cfg, improved), { kind: "ta", reason: improved ? "1 周アタック 記録更新" : "1 周アタック 1 周", at, capped: true });
}

/** ギフトコード・景品で入れる (上限の外。走行点が切でも入る)。入れたあとの残高。アカウントが無ければ null */
export function grantRacePoints(sql: SqlRunner, accountId: number, amount: number, kind: RpKind, reason: string, at: number): number | null {
  ensureRpSchema(sql);
  if (!accountExists(sql, accountId)) return null;
  const n = Math.max(0, Math.floor(amount));
  if (n <= 0) return walletOf(sql, accountId, at).points;
  return move(sql, accountId, n, kind, reason, at);
}

/** 残高 (表が無ければ 0) */
export function racePointsOf(sql: SqlRunner, accountId: number): number {
  ensureRpSchema(sql);
  return Number(one(sql, "SELECT points FROM rp_wallet WHERE account_id = ?", accountId)?.points ?? 0);
}

// ---------------------------------------------------------------- 画面に返す形 (web/src/rp_api.ts と合わせる)

export interface RpShopView {
  id: number;
  name: string;
  note: string;
  lines: string[];
  price: number;
  limitWeek: number | null;
  limitTotal: number | null;
  /** 自分が今週・全部で交換した回数 */
  boughtWeek: number;
  boughtTotal: number;
}

export interface RpStatus {
  on: boolean;
  points: number;
  /** 今日 (日本時間) レースと 1 周アタックでもらった点・あとどれだけ・上限 */
  today: number;
  left: number;
  cap: number;
  /** 点の入り方 (画面の説明用) */
  rates: Pick<AdminConfig, "rpFinish" | "rpPosBonus" | "rpTourMul" | "rpTaLap" | "rpTaBest">;
  shop: RpShopView[];
  buys: Array<{ at: number; name: string; price: number; lines: string[] }>;
  ledger: Array<{ at: number; delta: number; kind: RpKind; kindJp: string; reason: string }>;
}

export interface RpAdminEntry extends RpShopEntry {
  lines: string[];
  /** 交換された回数 (全員) */
  sold: number;
}

export interface RpAdminView {
  on: boolean;
  shop: RpAdminEntry[];
  totals: {
    issued: number;
    spent: number;
    /** みんなの手元に残っている点 */
    outstanding: number;
    holders: number;
    /** 種類ごとの入った点 (issued) と出た点 (spent) */
    byKind: Array<{ kind: RpKind; kindJp: string; issued: number; spent: number }>;
    /** 今日 (日本時間) 入った点 */
    issuedToday: number;
  };
}

export interface RpDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
  config: () => AdminConfig;
}

export class RacePointStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  private now: () => number;
  private config: () => AdminConfig;

  constructor(
    deps: RpDeps,
    private accounts: AccountStore,
    private gifts: GiftStore,
  ) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    this.config = deps.config;
    ensureRpSchema(this.sql);
    this.seed();
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  /** はじめの交換所を 1 回だけ入れる (管理者が全部消しても戻さない) */
  private seed() {
    if (this.row("SELECT v FROM rp_meta WHERE k = 'seeded'")) return;
    this.tx(() => {
      const now = this.now();
      DEFAULT_RP_SHOP.forEach((e, i) => {
        const c = checkRpShopInput(e);
        if (c.ok) this.insert(c.entry, (i + 1) * 10, now);
      });
      this.sql.exec("INSERT OR REPLACE INTO rp_meta (k, v) VALUES ('seeded', ?)", String(now));
    });
  }

  private insert(e: RpShopInput, sort: number, now: number): number {
    const r = this.row(
      "INSERT INTO rp_shop (name, note, items, price, limit_week, limit_total, hidden, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      e.name,
      e.note,
      JSON.stringify(e.items),
      e.price,
      e.limitWeek,
      e.limitTotal,
      e.hidden ? 1 : 0,
      sort,
      now,
    );
    return Number(r!.id);
  }

  private toEntry(r: Record<string, SqlValue>): RpShopEntry {
    return {
      id: Number(r.id),
      name: String(r.name),
      note: String(r.note),
      items: JSON.parse(String(r.items)) as GiftItem[],
      price: Number(r.price),
      limitWeek: r.limit_week === null ? null : Number(r.limit_week),
      limitTotal: r.limit_total === null ? null : Number(r.limit_total),
      hidden: Number(r.hidden) === 1,
      sort: Number(r.sort),
    };
  }

  private entries(withHidden: boolean): RpShopEntry[] {
    return this.rows(`SELECT * FROM rp_shop ${withHidden ? "" : "WHERE hidden = 0"} ORDER BY sort, id`).map((r) => this.toEntry(r));
  }

  private entry(id: number): RpShopEntry | null {
    const r = this.row("SELECT * FROM rp_shop WHERE id = ?", id);
    return r ? this.toEntry(r) : null;
  }

  private bought(accountId: number, entryId: number, now: number): { week: number; total: number } {
    const r = this.row(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS week FROM rp_buys WHERE account_id = ? AND entry_id = ?",
      jstWeekStart(now),
      accountId,
      entryId,
    );
    return { week: Number(r?.week ?? 0), total: Number(r?.total ?? 0) };
  }

  /** 中身の言い表し (運転手の名前つき) */
  private lines(items: readonly GiftItem[]): string[] {
    return this.gifts.describe(items);
  }

  // ---------------------------------------------------------------- 遊ぶ人

  status(acc: Account): RpStatus {
    const now = this.now();
    const cfg = this.config();
    const w = walletOf(this.sql, acc.id, now);
    return {
      on: cfg.rpOn,
      points: w.points,
      today: w.dayEarned,
      left: Math.max(0, cfg.rpDailyCap - w.dayEarned),
      cap: cfg.rpDailyCap,
      rates: { rpFinish: cfg.rpFinish, rpPosBonus: cfg.rpPosBonus, rpTourMul: cfg.rpTourMul, rpTaLap: cfg.rpTaLap, rpTaBest: cfg.rpTaBest },
      shop: this.entries(false).map((e) => {
        const b = this.bought(acc.id, e.id, now);
        return { id: e.id, name: e.name, note: e.note, lines: this.lines(e.items), price: e.price, limitWeek: e.limitWeek, limitTotal: e.limitTotal, boughtWeek: b.week, boughtTotal: b.total };
      }),
      buys: this.rows("SELECT at, name, price, lines FROM rp_buys WHERE account_id = ? ORDER BY at DESC, id DESC LIMIT ?", acc.id, RP_HISTORY_MAX).map((r) => ({
        at: Number(r.at),
        name: String(r.name),
        price: Number(r.price),
        lines: JSON.parse(String(r.lines)) as string[],
      })),
      ledger: this.rows("SELECT at, delta, kind, reason FROM rp_ledger WHERE account_id = ? ORDER BY at DESC, id DESC LIMIT ?", acc.id, RP_HISTORY_MAX).map((r) => ({
        at: Number(r.at),
        delta: Number(r.delta),
        kind: String(r.kind) as RpKind,
        kindJp: RP_KIND_JP[String(r.kind) as RpKind] ?? String(r.kind),
        reason: String(r.reason),
      })),
    };
  }

  /** 交換の回数の制限 (accounts.ts の limits の表。取りまとめの外で数えるので、断られても 1 回に数える) */
  private rateHit(accountId: number) {
    const k = `rpbuy:${accountId}`;
    const now = this.now();
    const r = this.row("SELECT n, reset_at FROM limits WHERE k = ?", k);
    if (!r || Number(r.reset_at) <= now) {
      this.sql.exec("INSERT OR REPLACE INTO limits (k, n, reset_at) VALUES (?, 1, ?)", k, now + RP_BUY_WINDOW_MS);
      return;
    }
    if (Number(r.n) >= RP_BUY_PER_MIN) throw new ApiError(429, "交換が続きすぎています。少し待ってください");
    this.sql.exec("UPDATE limits SET n = n + 1 WHERE k = ?", k);
  }

  /**
   * 交換する (1 回の取りまとめ)。点を引き、記録し、中身を当てる。どこかで断られたら全部戻る。
   * 返すのは 受け取ったもの・次の区切りで効くもの・残りの点・お金
   */
  buy(acc: Account, rawId: unknown): { received: string[]; later: string[]; points: number; money: number } {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) throw new ApiError(400, "交換するものを選んでください");
    if (!this.config().rpOn) throw new ApiError(403, "交換所は今 止まっています");
    this.rateHit(acc.id);
    const now = this.now();
    return this.tx(() => {
      const e = this.entry(id);
      if (!e || e.hidden) throw new ApiError(404, "それは今は交換できません");
      const b = this.bought(acc.id, e.id, now);
      if (e.limitWeek !== null && b.week >= e.limitWeek) throw new ApiError(409, `今週はもう交換できません (週 ${e.limitWeek} 回まで。月曜に戻ります)`);
      if (e.limitTotal !== null && b.total >= e.limitTotal) throw new ApiError(409, `もう交換できません (全部で ${e.limitTotal} 回まで)`);
      const w = walletOf(this.sql, acc.id, now);
      if (w.points < e.price) throw new ApiError(409, `走行点が足りません (あと ${(e.price - w.points).toLocaleString("ja-JP")} 点)`);
      const points = move(this.sql, acc.id, -e.price, "buy", `交換: ${e.name}`, now);
      const buyId = Number(this.row("INSERT INTO rp_buys (account_id, entry_id, name, price, lines, at) VALUES (?, ?, ?, ?, '[]', ?) RETURNING id", acc.id, e.id, e.name, e.price, now)!.id);
      const got = this.gifts.applyInTx(acc.id, e.items, now);
      this.sql.exec("UPDATE rp_buys SET lines = ? WHERE id = ?", JSON.stringify([...got.received, ...got.later]), buyId);
      return { received: got.received, later: got.later, points, money: this.accounts.getAccount(acc.id)?.money ?? 0 };
    });
  }

  // ---------------------------------------------------------------- 管理者

  private assertAdmin(admin: Account) {
    if (!this.accounts.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
  }

  private caps() {
    return this.config();
  }

  adminView(admin: Account): RpAdminView {
    this.assertAdmin(admin);
    const sold = new Map(this.rows("SELECT entry_id, COUNT(*) AS c FROM rp_buys GROUP BY entry_id").map((r) => [Number(r.entry_id), Number(r.c)]));
    const byKind = this.rows(
      "SELECT kind, SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS issued, SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS spent FROM rp_ledger GROUP BY kind ORDER BY kind",
    ).map((r) => ({ kind: String(r.kind) as RpKind, kindJp: RP_KIND_JP[String(r.kind) as RpKind] ?? String(r.kind), issued: Number(r.issued ?? 0), spent: Number(r.spent ?? 0) }));
    const hold = this.row("SELECT COALESCE(SUM(points), 0) AS s, SUM(CASE WHEN points > 0 THEN 1 ELSE 0 END) AS n FROM rp_wallet");
    const today = this.row("SELECT COALESCE(SUM(delta), 0) AS s FROM rp_ledger WHERE delta > 0 AND at >= ?", rpDay(this.now()));
    return {
      on: this.config().rpOn,
      shop: this.entries(true).map((e) => ({ ...e, lines: this.lines(e.items), sold: sold.get(e.id) ?? 0 })),
      totals: {
        issued: byKind.reduce((s, k) => s + k.issued, 0),
        spent: byKind.reduce((s, k) => s + k.spent, 0),
        outstanding: Number(hold?.s ?? 0),
        holders: Number(hold?.n ?? 0),
        byKind,
        issuedToday: Number(today?.s ?? 0),
      },
    };
  }

  create(admin: Account, b: Record<string, unknown>): RpAdminEntry {
    this.assertAdmin(admin);
    const c = checkRpShopInput(b, this.caps());
    if (!c.ok) throw new ApiError(400, c.error);
    return this.tx(() => {
      const n = Number(this.row("SELECT COUNT(*) AS c FROM rp_shop")?.c ?? 0);
      if (n >= RP_SHOP_MAX) throw new ApiError(409, `交換所に並べられるのは ${RP_SHOP_MAX} 個までです`);
      const sort = Number(this.row("SELECT COALESCE(MAX(sort), 0) AS m FROM rp_shop")?.m ?? 0) + 10;
      return this.adminEntry(this.insert(c.entry, sort, this.now()));
    });
  }

  /** 直す (書いた項目だけ)。sort も変えられる。交換された記録は同じ番号のまま (回数の制限も続く) */
  update(admin: Account, id: number, b: Record<string, unknown>): RpAdminEntry {
    this.assertAdmin(admin);
    return this.tx(() => {
      const cur = this.entry(id);
      if (!cur) throw new ApiError(404, "その品は見つかりません");
      const c = checkRpShopInput(b, this.caps(), cur);
      if (!c.ok) throw new ApiError(400, c.error);
      let sort = cur.sort;
      if (b.sort !== undefined) {
        const v = Number(b.sort);
        if (!Number.isInteger(v) || Math.abs(v) > 1_000_000) throw new ApiError(400, "並びがおかしいです");
        sort = v;
      }
      const e = c.entry;
      this.sql.exec(
        "UPDATE rp_shop SET name = ?, note = ?, items = ?, price = ?, limit_week = ?, limit_total = ?, hidden = ?, sort = ?, updated_at = ? WHERE id = ?",
        e.name,
        e.note,
        JSON.stringify(e.items),
        e.price,
        e.limitWeek,
        e.limitTotal,
        e.hidden ? 1 : 0,
        sort,
        this.now(),
        id,
      );
      return this.adminEntry(id);
    });
  }

  /** 消す (交換された記録は名前つきで残る) */
  remove(admin: Account, id: number): { ok: true } {
    this.assertAdmin(admin);
    return this.tx(() => {
      if (!this.row("DELETE FROM rp_shop WHERE id = ? RETURNING id", id)) throw new ApiError(404, "その品は見つかりません");
      return { ok: true as const };
    });
  }

  private adminEntry(id: number): RpAdminEntry {
    const e = this.entry(id)!;
    const sold = Number(this.row("SELECT COUNT(*) AS c FROM rp_buys WHERE entry_id = ?", id)?.c ?? 0);
    return { ...e, lines: this.lines(e.items), sold };
  }
}

// ---------------------------------------------------------------- 受け口

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 32 * 1024) throw new ApiError(413, "送るものが大きすぎます");
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下で断る */
  }
  throw new ApiError(400, "送られてきたものが読めません");
}

/**
 * ログインが要る:
 * GET    /api/rp                  残高・今日の分と上限・交換所 (自分の回数つき)・交換の記録・帳簿
 * POST   /api/rp/buy              { id }  交換する → { received, later, points, money }
 * 管理者だけ (ほかの人は 403):
 * GET    /api/admin/rp            交換所の全部 (しまった物も)・合計 (出した点・使われた点・残り)
 * POST   /api/admin/rp/shop       { name, note?, items, price, limitWeek?, limitTotal?, hidden? }  足す
 * PUT    /api/admin/rp/shop/:id   上のどれでも + sort  直す
 * DELETE /api/admin/rp/shop/:id   消す
 */
export async function handleRacePointsApi(req: Request, path: string, method: string, accounts: AccountStore, rp: RacePointStore): Promise<Response> {
  try {
    const M = method.toUpperCase();
    const a = await accounts.auth(bearer(req));
    if (!a) throw new ApiError(401, "ログインしてください");
    if (path === "/api/rp" && M === "GET") return json(rp.status(a));
    if (path === "/api/rp/buy" && M === "POST") {
      const b = await body(req);
      return json(rp.buy(a, b.id));
    }
    if (path.startsWith("/api/admin/rp")) {
      if (!accounts.isAdmin(a)) throw new ApiError(403, "管理者だけができます");
      if (path === "/api/admin/rp" && M === "GET") return json(rp.adminView(a));
      if (path === "/api/admin/rp/shop" && M === "POST") return json({ entry: rp.create(a, await body(req)) }, 201);
      const im = /^\/api\/admin\/rp\/shop\/(\d{1,12})$/.exec(path);
      if (im) {
        const id = Number(im[1]);
        if (M === "PUT") return json({ entry: rp.update(a, id, await body(req)) });
        if (M === "DELETE") return json(rp.remove(a, id));
      }
    }
    throw new ApiError(404, "ありません");
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("rp api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}
