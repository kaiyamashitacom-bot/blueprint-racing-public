// ギフトコード (DECISIONS 11/25「ギフトコード」「全ての概念をいじれるように」) の保存と /api/gift・/api/admin/gifts の受け口。
// アカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。中身の種類の表 (形・確かめ・言い表し) は shared/src/gift.ts、
// 当てるところはこのファイルの GIFT_APPLY (種類ごとに 1 つ。足し忘れると型で落ちる)。
// - コードの文字と受け取った記録はこの SQLite (本番のデータ) にだけ置く。コード・試験・文書には書かない
// - 受け取るのは 1 人 1 回。大文字小文字は区別しない。打ちまちがい (なし・期限切れ・使い切り・もう受け取った・使えない) は
//   ログインと同じく アカウントごと と つなぎ元ごと に 15 分の回数を数えて止める
// - 中身は 1 回の取りまとめ (transaction) で全部当てる。1 つでも当てられなければ (運転手がほかのチームと契約中 など) 何も受け取らない
//   (このときは打ちまちがいに数えない。コードも使ったことにならない)
// - 部と級の動きはすぐ当てず gift_pending に置く: 部は次の日の締め (LeagueDO が leagueMoves で取りに来て ackLeagueMoves で消す)、
//   級は次の季節の締め (season.ts が takeClassMoves で取る)
// 数は全部 (仮)。
import {
  GIFT_NOTE_MAX,
  GIFT_RANDOM_CHARS,
  GIFT_RANDOM_LEN,
  GIFT_TARGETS_MAX,
  GIFT_USES_MAX,
  ITEM_ERROR_TEXT,
  addItem,
  applyPartMoves,
  checkGiftItems,
  cleanDisplayName,
  describeGiftItem,
  giftDesignPreset,
  giftKind,
  normalizeGiftCode,
  normalizeLoginId,
  sortGiftItems,
  type ClassId,
  type EmblemMark,
  type EmblemShape,
  type GiftCaps,
  type GiftItem,
  type GiftKindId,
  type GiftNames,
  type Inventory,
  type StampId,
} from "@bpr/shared";
import { ApiError, type Account, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";
import { ensureRpSchema, grantRacePoints } from "./racepoints.ts";
import type { SeasonStore } from "./season.ts";
import type { TeamStore } from "./team.ts";

export const GIFT_PATH = /^\/api\/(gift|admin\/gifts)(\/|$)/;

/** 打ちまちがい: アカウントごと 15 分に 5 回、つなぎ元ごと 15 分に 30 回まで (仮。ログインと同じ) */
export const GIFT_FAIL_WINDOW_MS = 15 * 60_000;
export const GIFT_FAIL_PER_ACCOUNT = 5;
export const GIFT_FAIL_PER_IP = 30;
/** 管理者の一覧に出すコードの数・使った人の一覧の数 (仮) */
export const GIFT_LIST_MAX = 500;
export const GIFT_LOG_MAX = 1000;

/** 断るときの言葉 */
export const GIFT_MSG = {
  none: "そのコードはありません",
  expired: "そのコードは期限が切れています",
  usedUp: "そのコードは使い切られました",
  already: "このコードはもう受け取りました",
  notForYou: "このコードは使えません",
  paused: "そのコードは今は止められています",
  limit: "コードの打ちまちがいが多すぎます。15 分ほど待ってください",
} as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gift_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  contents TEXT NOT NULL,
  max_uses INTEGER,
  expires_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  targets TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gift_redemptions (
  gift_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  team TEXT NOT NULL,
  driver TEXT NOT NULL,
  PRIMARY KEY (gift_id, account_id)
);
CREATE TABLE IF NOT EXISTS gift_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target INTEGER NOT NULL,
  gift_id INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gift_pending_kind ON gift_pending(kind);
`;

/** 管理者の一覧の 1 行 */
export interface GiftCodeRow {
  id: number;
  code: string;
  items: GiftItem[];
  /** 中身の言い表し (運転手の名前つき) */
  lines: string[];
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  paused: boolean;
  targets: string[] | null;
  note: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  /** 今使えるか (止めた・期限切れ・使い切りでない) */
  state: "active" | "paused" | "expired" | "used_up";
}

export interface GiftRedeemResult {
  /** 受け取ったもの (言い表し) */
  received: string[];
  /** 次の区切りで効くもの */
  later: string[];
  money: number;
  parts: Inventory;
}

export interface GiftDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
  /** 管理者が付けた上限 (AdminConfig の gift*Max) */
  caps: () => GiftCaps;
}

/** 当てるときに渡すもの */
interface ApplyCtx {
  acc: Account;
  now: number;
  giftId: number;
  sql: SqlRunner;
  accounts: AccountStore;
  team: TeamStore;
  season: SeasonStore;
  pending(kind: "division" | "class", target: number): void;
}

const num = (v: unknown) => Number(v);
const str = (v: unknown) => String(v ?? "");

/**
 * 中身の種類ごとの当て方 (受け取る人の取りまとめの中で呼ぶ)。返すのは受け取った人に見せる言葉。
 * 当てられないときは ApiError(409, "今は受け取れません: …") を投げる (取りまとめごと戻る)
 */
export const GIFT_APPLY: Readonly<Record<GiftKindId, (c: ApplyCtx, p: GiftItem["p"]) => string>> = {
  money: (c, p) => {
    const amount = Math.floor(num(p.amount));
    c.sql.exec("UPDATE accounts SET money = money + ? WHERE id = ?", amount, c.acc.id);
    c.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", c.acc.id, amount, "gift", c.now);
    return describeGiftItem({ kind: "money", p });
  },
  race_points: (c, p) => {
    // ギフトコード (giftId > 0) と景品・交換 (0)。1 日の上限の外 (racepoints.ts)
    if (grantRacePoints(c.sql, c.acc.id, num(p.amount), c.giftId > 0 ? "gift" : "prize", c.giftId > 0 ? "ギフトコード" : "景品", c.now) === null) throw new ApiError(409, "今は受け取れません: アカウントがありません");
    return describeGiftItem({ kind: "race_points", p });
  },
  part: (c, p) => {
    const partId = str(p.part);
    const count = Math.floor(num(p.count));
    const before = c.accounts.inventory(c.acc.id);
    const r = applyPartMoves(before, String(c.acc.id), [{ teamId: String(c.acc.id), item: { type: "part", partId, count }, change: "add" }]);
    if (!r.ok) throw new ApiError(409, "今は受け取れません: 部品が持てる数を超えます");
    c.sql.exec("INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?) ON CONFLICT(account_id, part_id) DO UPDATE SET n = excluded.n", c.acc.id, partId, r.inventory[partId]);
    return describeGiftItem({ kind: "part", p });
  },
  item: (c, p) => {
    const itemId = str(p.item);
    const count = Math.floor(num(p.count));
    const r = addItem(c.accounts.inventory(c.acc.id), itemId, count);
    if (!r.ok) throw new ApiError(409, `今は受け取れません: ${ITEM_ERROR_TEXT[r.error]}`);
    c.sql.exec("INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?) ON CONFLICT(account_id, part_id) DO UPDATE SET n = excluded.n", c.acc.id, itemId, r.inventory[itemId]);
    return describeGiftItem({ kind: "item", p });
  },
  driver_discount: (c, p) => {
    c.team.giftDiscount(c.acc.id, num(p.pct));
    return describeGiftItem({ kind: "driver_discount", p });
  },
  driver_hire: (c, p) => c.team.giftHireDriver(c.acc.id, str(p.driver), c.now),
  driver_stats: (c, p) => c.team.giftDriverStats(c.acc.id, str(p.stat), num(p.amount)),
  research: (c, p) => c.team.giftResearch(c.acc.id, p.mode === "advance" ? "advance" : "finish", str(p.node), num(p.hours), c.now),
  crew: (c, p) => c.team.giftCrew(c.acc.id, num(p.levels)),
  stamp: (c, p) => {
    c.season.grantStamps(c.acc.id, [str(p.stamp) as StampId]);
    return describeGiftItem({ kind: "stamp", p });
  },
  title: (c, p) => {
    c.team.giftTitle(c.acc.id, str(p.text));
    return describeGiftItem({ kind: "title", p });
  },
  emblem: (c, p) => {
    c.team.giftEmblem(c.acc.id, { shape: str(p.shape) as EmblemShape, color: str(p.color), mark: str(p.mark) as EmblemMark, markColor: str(p.markColor) });
    return describeGiftItem({ kind: "emblem", p });
  },
  design: (c, p) => {
    const d = giftDesignPreset(p.preset);
    if (!d) throw new ApiError(409, "今は受け取れません: その設計図はもうありません");
    c.team.giftDesign(c.acc.id, structuredClone(d));
    return describeGiftItem({ kind: "design", p });
  },
  division: (c, p) => {
    c.pending("division", num(p.division));
    return describeGiftItem({ kind: "division", p });
  },
  class: (c, p) => {
    c.pending("class", num(p.cls));
    return describeGiftItem({ kind: "class", p });
  },
};

function randomCode(): string {
  const b = new Uint8Array(GIFT_RANDOM_LEN);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += GIFT_RANDOM_CHARS[x % GIFT_RANDOM_CHARS.length];
  return s;
}

export class GiftStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  private now: () => number;
  private caps: () => GiftCaps;

  constructor(
    deps: GiftDeps,
    private accounts: AccountStore,
    private team: TeamStore,
    private season: SeasonStore,
  ) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    this.caps = deps.caps;
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
    // 走行点の表 (racepoints.ts。結果の取りまとめの中で初めて作ると、戻したときに表ごと消えるので先に)
    ensureRpSchema(this.sql);
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  // ---------------------------------------------------------------- 回数の制限 (accounts.ts の limits の表を使う)

  private limitCount(k: string): number {
    const r = this.row("SELECT n, reset_at FROM limits WHERE k = ?", k);
    if (!r || Number(r.reset_at) <= this.now()) return 0;
    return Number(r.n);
  }

  private limitHit(k: string) {
    const now = this.now();
    const r = this.row("SELECT n, reset_at FROM limits WHERE k = ?", k);
    if (!r || Number(r.reset_at) <= now) this.sql.exec("INSERT OR REPLACE INTO limits (k, n, reset_at) VALUES (?, 1, ?)", k, now + GIFT_FAIL_WINDOW_MS);
    else this.sql.exec("UPDATE limits SET n = n + 1 WHERE k = ?", k);
  }

  private names(): GiftNames {
    return { driver: (id) => this.team.driverName(id) };
  }

  // ---------------------------------------------------------------- 受け取る

  /** コードを受け取る。ip はつなぎ元 (回数の制限) */
  redeem(acc: Account, rawCode: unknown, ip: string): GiftRedeemResult {
    const accKey = `gift:${acc.id}`;
    const ipKey = `giftip:${ip}`;
    if (this.limitCount(accKey) >= GIFT_FAIL_PER_ACCOUNT || this.limitCount(ipKey) >= GIFT_FAIL_PER_IP) throw new ApiError(429, GIFT_MSG.limit);
    const fail = (status: number, msg: string): never => {
      this.limitHit(accKey);
      this.limitHit(ipKey);
      throw new ApiError(status, msg);
    };
    const code = normalizeGiftCode(rawCode);
    if (!code) return fail(404, GIFT_MSG.none);
    const r = this.row("SELECT * FROM gift_codes WHERE code = ?", code);
    if (!r) return fail(404, GIFT_MSG.none);
    const giftId = Number(r.id);
    const now = this.now();
    if (Number(r.paused) === 1) return fail(403, GIFT_MSG.paused);
    if (r.expires_at !== null && now >= Number(r.expires_at)) return fail(410, GIFT_MSG.expired);
    const targets = r.targets === null ? null : (JSON.parse(String(r.targets)) as string[]);
    if (targets && !targets.includes(acc.login)) return fail(403, GIFT_MSG.notForYou);
    if (this.row("SELECT at FROM gift_redemptions WHERE gift_id = ? AND account_id = ?", giftId, acc.id)) return fail(409, GIFT_MSG.already);
    const used = () => Number(this.row("SELECT COUNT(*) AS c FROM gift_redemptions WHERE gift_id = ?", giftId)?.c ?? 0);
    if (r.max_uses !== null && used() >= Number(r.max_uses)) return fail(410, GIFT_MSG.usedUp);
    const items = sortGiftItems(JSON.parse(String(r.contents)) as GiftItem[]);
    // ここから 1 回の取りまとめ。中の確かめは await をはさまないので、上の確かめのあとに変わることはない (念のためもう一度見る)
    return this.tx(() => {
      if (this.row("SELECT at FROM gift_redemptions WHERE gift_id = ? AND account_id = ?", giftId, acc.id)) throw new ApiError(409, GIFT_MSG.already);
      if (r.max_uses !== null && used() >= Number(r.max_uses)) throw new ApiError(410, GIFT_MSG.usedUp);
      const cur = this.accounts.getAccount(acc.id);
      if (!cur) throw new ApiError(401, "ログインしてください");
      this.sql.exec("INSERT INTO gift_redemptions (gift_id, account_id, at, team, driver) VALUES (?, ?, ?, ?, ?)", giftId, acc.id, now, cur.team, cur.driver);
      this.team.giftPrepare(acc.id, now);
      const ctx: ApplyCtx = {
        acc: cur,
        now,
        giftId,
        sql: this.sql,
        accounts: this.accounts,
        team: this.team,
        season: this.season,
        pending: (kind, target) => {
          // 同じ人の同じ種類は新しいものに置きかえる
          this.sql.exec("DELETE FROM gift_pending WHERE account_id = ? AND kind = ?", acc.id, kind);
          this.sql.exec("INSERT INTO gift_pending (account_id, kind, target, gift_id, at) VALUES (?, ?, ?, ?, ?)", acc.id, kind, Math.floor(target), giftId, now);
        },
      };
      const received: string[] = [];
      const later: string[] = [];
      for (const it of items) {
        const line = GIFT_APPLY[it.kind](ctx, it.p);
        (giftKind(it.kind)?.deferred ? later : received).push(line);
      }
      const after = this.accounts.getAccount(acc.id)!;
      return { received, later, money: after.money, parts: this.accounts.inventory(acc.id) };
    });
  }

  /**
   * 景品 (大会の景品など) を渡す。呼ぶ側の取りまとめ (transaction) の中で呼ぶ (ここでは取りまとめを開かない = 結果と同じ取りまとめ)。
   * ギフトコードとちがい、1 つ当てられなくても (部品が持てる数を超える など) 残りは渡し、当てられなかったものは failed に返す
   * (大会の結果を止めないため。当て方 GIFT_APPLY はどれも書きこむ前に断る)。退会していたら null
   */
  grantInTx(accountId: number, items: readonly GiftItem[], now: number): { received: string[]; later: string[]; failed: string[] } | null {
    const acc = this.accounts.getAccount(accountId);
    if (!acc) return null;
    this.team.giftPrepare(accountId, now);
    const ctx: ApplyCtx = {
      acc,
      now,
      giftId: 0,
      sql: this.sql,
      accounts: this.accounts,
      team: this.team,
      season: this.season,
      pending: (kind, target) => {
        this.sql.exec("DELETE FROM gift_pending WHERE account_id = ? AND kind = ?", accountId, kind);
        this.sql.exec("INSERT INTO gift_pending (account_id, kind, target, gift_id, at) VALUES (?, ?, ?, ?, ?)", accountId, kind, Math.floor(target), null, now);
      },
    };
    const received: string[] = [];
    const later: string[] = [];
    const failed: string[] = [];
    for (const it of sortGiftItems(items)) {
      const apply = GIFT_APPLY[it.kind];
      try {
        if (!apply) throw new ApiError(409, "知らない中身です");
        const line = apply(ctx, it.p);
        (giftKind(it.kind)?.deferred ? later : received).push(line);
      } catch (e) {
        failed.push(`${describeGiftItem(it, this.names())} (${String((e as Error)?.message ?? e).replace(/^今は受け取れません: /, "")})`);
      }
    }
    return { received, later, failed };
  }

  /**
   * 交換所 (racepoints.ts) から: 中身を全部当てる。呼ぶ側の取りまとめの中で呼ぶ。
   * ギフトコードと同じく 1 つでも当てられなければ ApiError を投げる (呼ぶ側の取りまとめごと戻る = 点も減らない)
   */
  applyInTx(accountId: number, items: readonly GiftItem[], now: number): { received: string[]; later: string[] } {
    const acc = this.accounts.getAccount(accountId);
    if (!acc) throw new ApiError(401, "ログインしてください");
    this.team.giftPrepare(accountId, now);
    const ctx: ApplyCtx = {
      acc,
      now,
      giftId: 0,
      sql: this.sql,
      accounts: this.accounts,
      team: this.team,
      season: this.season,
      pending: (kind, target) => {
        this.sql.exec("DELETE FROM gift_pending WHERE account_id = ? AND kind = ?", accountId, kind);
        this.sql.exec("INSERT INTO gift_pending (account_id, kind, target, gift_id, at) VALUES (?, ?, ?, ?, ?)", accountId, kind, Math.floor(target), null, now);
      },
    };
    const received: string[] = [];
    const later: string[] = [];
    for (const it of sortGiftItems(items)) {
      const apply = GIFT_APPLY[it.kind];
      if (!apply) throw new ApiError(409, "今は受け取れません: 知らない中身です");
      const line = apply(ctx, it.p);
      (giftKind(it.kind)?.deferred ? later : received).push(line);
    }
    return { received, later };
  }

  /** 中身の言い表し (運転手の名前つき。交換所の一覧用) */
  describe(items: readonly GiftItem[]): string[] {
    const nm = this.names();
    return items.map((it) => describeGiftItem(it, nm));
  }

  /** 自分の贈られた称号・割引・次の区切りで効くもの */
  status(acc: Account): { title: string | null; discountPct: number; pending: Array<{ kind: "division" | "class"; target: number }> } {
    const ex = this.team.giftExtras(acc.id);
    const pending = this.rows("SELECT kind, target FROM gift_pending WHERE account_id = ? ORDER BY id", acc.id).map((r) => ({ kind: String(r.kind) as "division" | "class", target: Number(r.target) }));
    return { title: ex.title, discountPct: ex.discountPct, pending };
  }

  // ---------------------------------------------------------------- 次の区切りで効くもの

  /** 季節の締め (season.ts の取りまとめの中) から: 級の動き (チーム → 級) を取り、消す */
  takeClassMoves(): Record<string, ClassId> {
    const out: Record<string, ClassId> = {};
    for (const r of this.rows("SELECT p.account_id, p.target FROM gift_pending p JOIN accounts a ON a.id = p.account_id WHERE p.kind = 'class' ORDER BY p.id")) {
      out[String(r.account_id)] = Math.max(1, Math.min(5, Number(r.target))) as ClassId;
    }
    this.sql.exec("DELETE FROM gift_pending WHERE kind = 'class'");
    return out;
  }

  /** リーグの DO から (日の締めの前): まだ当てていない部の動き。退会した人の分は消す */
  leagueMoves(): Array<{ id: number; teamId: string; division: number }> {
    this.sql.exec("DELETE FROM gift_pending WHERE kind = 'division' AND account_id NOT IN (SELECT id FROM accounts)");
    return this.rows("SELECT id, account_id, target FROM gift_pending WHERE kind = 'division' ORDER BY id").map((r) => ({ id: Number(r.id), teamId: String(r.account_id), division: Number(r.target) }));
  }

  /** リーグの DO から: 当てた部の動きを消す */
  ackLeagueMoves(ids: readonly number[]): void {
    for (const id of ids.slice(0, 1000)) if (Number.isInteger(id)) this.sql.exec("DELETE FROM gift_pending WHERE id = ? AND kind = 'division'", id);
  }

  // ---------------------------------------------------------------- 管理者

  private assertAdmin(admin: Account) {
    if (!this.accounts.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
  }

  private toRow(r: Record<string, SqlValue>, now: number): GiftCodeRow {
    const items = JSON.parse(String(r.contents)) as GiftItem[];
    const uses = Number(r.uses ?? 0);
    const maxUses = r.max_uses === null ? null : Number(r.max_uses);
    const expiresAt = r.expires_at === null ? null : Number(r.expires_at);
    const paused = Number(r.paused) === 1;
    const nm = this.names();
    return {
      id: Number(r.id),
      code: String(r.code),
      items,
      lines: items.map((it) => describeGiftItem(it, nm)),
      maxUses,
      uses,
      expiresAt,
      paused,
      targets: r.targets === null ? null : (JSON.parse(String(r.targets)) as string[]),
      note: String(r.note),
      createdAt: Number(r.created_at),
      createdBy: String(r.created_by),
      updatedAt: Number(r.updated_at),
      state: paused ? "paused" : expiresAt !== null && now >= expiresAt ? "expired" : maxUses !== null && uses >= maxUses ? "used_up" : "active",
    };
  }

  list(admin: Account): { codes: GiftCodeRow[]; caps: GiftCaps } {
    this.assertAdmin(admin);
    const now = this.now();
    const rows = this.rows(
      "SELECT g.*, (SELECT COUNT(*) FROM gift_redemptions r WHERE r.gift_id = g.id) AS uses FROM gift_codes g ORDER BY g.created_at DESC, g.id DESC LIMIT ?",
      GIFT_LIST_MAX,
    );
    return { codes: rows.map((r) => this.toRow(r, now)), caps: this.caps() };
  }

  private one(id: number): GiftCodeRow {
    const r = this.row("SELECT g.*, (SELECT COUNT(*) FROM gift_redemptions r WHERE r.gift_id = g.id) AS uses FROM gift_codes g WHERE g.id = ?", id);
    if (!r) throw new ApiError(404, "そのコードは見つかりません");
    return this.toRow(r, this.now());
  }

  /** 選びの候補 (運転手は全部。契約中ならチーム名つき) */
  options(admin: Account) {
    this.assertAdmin(admin);
    return { drivers: this.team.driverChoices() };
  }

  /** 作る・直すときの中身を確かめる。patch = 直すとき (無い項目はそのまま) */
  private parseInput(b: Record<string, unknown>, patch: boolean) {
    const out: { code?: string; items?: GiftItem[]; maxUses?: number | null; expiresAt?: number | null; note?: string; targets?: string[] | null; paused?: boolean } = {};
    if (!patch || b.items !== undefined) {
      const c = checkGiftItems(b.items, this.caps());
      if (!c.ok) throw new ApiError(400, c.error);
      for (const it of c.items) {
        if (it.kind === "driver_hire" && !this.team.driverName(String(it.p.driver))) throw new ApiError(400, "運転手と契約: その運転手は見つかりません");
      }
      out.items = c.items;
    }
    if (b.code !== undefined && b.code !== null && b.code !== "") {
      const code = normalizeGiftCode(b.code);
      if (!code) throw new ApiError(400, "コードは 英字・数字・_ - で 4〜24 字です");
      out.code = code;
    }
    if (b.maxUses !== undefined) {
      if (b.maxUses === null || b.maxUses === "") out.maxUses = null;
      else {
        const v = Number(b.maxUses);
        if (!Number.isInteger(v) || v < 1 || v > GIFT_USES_MAX) throw new ApiError(400, `使える人数は 1〜${GIFT_USES_MAX} か「何人でも」です`);
        out.maxUses = v;
      }
    }
    if (b.expiresAt !== undefined) {
      if (b.expiresAt === null || b.expiresAt === "") out.expiresAt = null;
      else {
        const v = Number(b.expiresAt);
        if (!Number.isFinite(v) || v <= 0) throw new ApiError(400, "期限がおかしいです");
        if (!patch && v <= this.now()) throw new ApiError(400, "期限がもう過ぎています");
        out.expiresAt = Math.floor(v);
      }
    }
    if (b.note !== undefined) out.note = cleanDisplayName(typeof b.note === "string" ? b.note : "").slice(0, GIFT_NOTE_MAX);
    if (b.targets !== undefined) {
      if (b.targets === null || (Array.isArray(b.targets) && b.targets.length === 0)) out.targets = null;
      else {
        if (!Array.isArray(b.targets) || b.targets.length > GIFT_TARGETS_MAX) throw new ApiError(400, `使える人は ${GIFT_TARGETS_MAX} 人までです`);
        const ids = [...new Set(b.targets.map((x) => normalizeLoginId(x)).filter(Boolean))];
        for (const id of ids) if (!this.row("SELECT id FROM accounts WHERE login = ?", id)) throw new ApiError(400, `その ID は見つかりません: ${id}`);
        out.targets = ids.length ? ids : null;
      }
    }
    if (b.paused !== undefined) {
      if (typeof b.paused !== "boolean") throw new ApiError(400, "止めるかどうかがおかしいです");
      out.paused = b.paused;
    }
    return out;
  }

  create(admin: Account, b: Record<string, unknown>): GiftCodeRow {
    this.assertAdmin(admin);
    const v = this.parseInput(b, false);
    const now = this.now();
    return this.tx(() => {
      let code = v.code;
      if (code) {
        if (this.row("SELECT id FROM gift_codes WHERE code = ?", code)) throw new ApiError(409, "そのコードはもうあります");
      } else {
        do code = randomCode();
        while (this.row("SELECT id FROM gift_codes WHERE code = ?", code));
      }
      const r = this.row(
        "INSERT INTO gift_codes (code, contents, max_uses, expires_at, paused, targets, note, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        code,
        JSON.stringify(v.items),
        v.maxUses ?? null,
        v.expiresAt ?? null,
        v.paused ? 1 : 0,
        v.targets ? JSON.stringify(v.targets) : null,
        v.note ?? "",
        now,
        admin.login,
        now,
      );
      return this.one(Number(r!.id));
    });
  }

  /** 直す (中身・使える人数・期限・コードの文字・メモ・使える人・止める)。使った人の記録は番号でつながったまま */
  update(admin: Account, id: number, b: Record<string, unknown>): GiftCodeRow {
    this.assertAdmin(admin);
    const v = this.parseInput(b, true);
    return this.tx(() => {
      const cur = this.one(id);
      if (v.code && v.code !== cur.code && this.row("SELECT id FROM gift_codes WHERE code = ? AND id != ?", v.code, id)) throw new ApiError(409, "そのコードはもうあります");
      const set: string[] = [];
      const vals: SqlValue[] = [];
      const put = (col: string, val: SqlValue) => {
        set.push(`${col} = ?`);
        vals.push(val);
      };
      if (v.code) put("code", v.code);
      if (v.items) put("contents", JSON.stringify(v.items));
      if (v.maxUses !== undefined) put("max_uses", v.maxUses);
      if (v.expiresAt !== undefined) put("expires_at", v.expiresAt);
      if (v.note !== undefined) put("note", v.note);
      if (v.targets !== undefined) put("targets", v.targets ? JSON.stringify(v.targets) : null);
      if (v.paused !== undefined) put("paused", v.paused ? 1 : 0);
      if (!set.length) return cur;
      put("updated_at", this.now());
      this.sql.exec(`UPDATE gift_codes SET ${set.join(", ")} WHERE id = ?`, ...vals, id);
      return this.one(id);
    });
  }

  /** 消す (使った人の記録もいっしょに。受け取ったものはそのまま) */
  remove(admin: Account, id: number): { ok: true } {
    this.assertAdmin(admin);
    return this.tx(() => {
      if (!this.row("DELETE FROM gift_codes WHERE id = ? RETURNING id", id)) throw new ApiError(404, "そのコードは見つかりません");
      this.sql.exec("DELETE FROM gift_redemptions WHERE gift_id = ?", id);
      return { ok: true as const };
    });
  }

  /** 誰がいつ使ったか (新しい順)。名前は今の表示名 (退会したら受け取ったときの名前)。ID は管理者だけに見せる */
  log(admin: Account, id: number): { code: string; rows: Array<{ at: number; team: string; driver: string; login: string | null }> } {
    this.assertAdmin(admin);
    const g = this.one(id);
    const rows = this.rows(
      "SELECT r.at, r.team AS team0, r.driver AS driver0, a.team, a.driver, a.login FROM gift_redemptions r LEFT JOIN accounts a ON a.id = r.account_id WHERE r.gift_id = ? ORDER BY r.at DESC LIMIT ?",
      id,
      GIFT_LOG_MAX,
    );
    return {
      code: g.code,
      rows: rows.map((r) => ({
        at: Number(r.at),
        team: r.team === null ? String(r.team0) : String(r.team),
        driver: r.driver === null ? String(r.driver0) : String(r.driver),
        login: r.login === null ? null : String(r.login),
      })),
    };
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
 * POST   /api/gift                      { code }  受け取る → { received, later, money, parts }
 * GET    /api/gift/status               贈られた称号・割引・次の区切りで効くもの
 * 管理者だけ (ほかの人は 403):
 * GET    /api/admin/gifts               コードの一覧 (使われた回数つき) と上限
 * GET    /api/admin/gifts/options       選びの候補 (運転手)
 * POST   /api/admin/gifts               { code?, items, maxUses?, expiresAt?, note?, targets?, paused? }  作る (code が空なら おまかせの 8 字)
 * PUT    /api/admin/gifts/:id           上のどれでも (直す・止める / 戻す)
 * DELETE /api/admin/gifts/:id           消す
 * GET    /api/admin/gifts/:id/log       誰がいつ使ったか
 */
export async function handleGiftApi(req: Request, path: string, method: string, accounts: AccountStore, gifts: GiftStore): Promise<Response> {
  try {
    const M = method.toUpperCase();
    const a = await accounts.auth(bearer(req));
    if (!a) throw new ApiError(401, "ログインしてください");
    if (path === "/api/gift" && M === "POST") {
      const b = await body(req);
      return json(gifts.redeem(a, b.code, (req.headers.get("cf-connecting-ip") ?? "local").slice(0, 64)));
    }
    if (path === "/api/gift/status" && M === "GET") return json(gifts.status(a));
    if (path.startsWith("/api/admin/gifts")) {
      if (!accounts.isAdmin(a)) throw new ApiError(403, "管理者だけができます");
      if (path === "/api/admin/gifts" && M === "GET") return json(gifts.list(a));
      if (path === "/api/admin/gifts/options" && M === "GET") return json(gifts.options(a));
      if (path === "/api/admin/gifts" && M === "POST") return json({ code: gifts.create(a, await body(req)) }, 201);
      const im = /^\/api\/admin\/gifts\/(\d{1,12})(\/log)?$/.exec(path);
      if (im) {
        const id = Number(im[1]);
        if (im[2] && M === "GET") return json(gifts.log(a, id));
        if (!im[2] && M === "PUT") return json({ code: gifts.update(a, id, await body(req)) });
        if (!im[2] && M === "DELETE") return json(gifts.remove(a, id));
      }
    }
    throw new ApiError(404, "ありません");
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("gift api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}
