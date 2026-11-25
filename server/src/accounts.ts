// アカウント・持ち物・設計図・財布の保存 (SQLite)。Cloudflare に頼らないので試験でそのまま動かせる。
// Durable Object (accounts_do.ts) が中に 1 つ持つ。お金と部品の数を変えるところは await をはさまず一気に書く
import {
  GRID_H,
  GRID_W,
  STARTING_MONEY,
  checkBuy,
  checkDriverName,
  checkLoginId,
  checkPassword,
  checkTeamName,
  cleanDisplayName,
  designFits,
  nameKey,
  normalizeLoginId,
  anyPartDef as partDef,
  starterInventory,
  type AccountMe,
  type CarDesign,
  type Inventory,
  type Placed,
} from "@bpr/shared";
import { PBKDF2_ITERATIONS, hashPassword, randomPassword, randomToken, tokenHash, verifyPassword } from "./crypto.ts";

export type SqlValue = string | number | null | ArrayBuffer;
export type SqlRow = Record<string, SqlValue>;

/** DO の ctx.storage.sql と同じ形 (試験では node:sqlite をかぶせる) */
export interface SqlRunner {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): SqlRow[] };
}

export interface StoreDeps {
  sql: SqlRunner;
  /** 中の書きこみを全部まとめて行う (DO では ctx.storage.transactionSync) */
  tx<T>(fn: () => T): T;
  now?: () => number;
  /** 管理者の ID (ログインの ID、小文字) */
  adminIds?: Iterable<string>;
  /** PBKDF2 の回数 (試験で小さくするとき) */
  iterations?: number;
  /** 招かれた人だけ登録できるか (管理者の数 AdminConfig.inviteOnly。なし = 誰でも) */
  inviteOnly?: () => boolean;
}

/** ログインの長さ (仮) */
export const SESSION_MS = 30 * 24 * 3600_000;
/** 1 人が同時に持てるログインの数 (仮)。多いと古いものから消す */
export const MAX_SESSIONS = 10;
/** ログインの失敗: ID ごと 15 分に 5 回、つなぎ元ごと 15 分に 30 回まで (仮) */
export const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;
export const LOGIN_FAIL_PER_ID = 5;
export const LOGIN_FAIL_PER_IP = 30;
/** 登録: つなぎ元ごと 1 時間に 10 回まで (仮) */
export const REGISTER_WINDOW_MS = 3600_000;
export const REGISTER_PER_IP = 10;
/** 管理者が 1 回に作れる招待の合言葉の数・合言葉の長さ・一覧に出す数 (仮) */
export const INVITE_MAX_BATCH = 20;
export const INVITE_CODE_LEN = 8;
export const INVITE_LIST_MAX = 200;
/** 止めたわけの長さ (仮) */
export const SUSPEND_REASON_MAX = 80;
/** 1 人が持てる設計図の数 (仮) */
export const MAX_DESIGNS = 50;
export const DESIGN_NAME_MAX = 16;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export interface Account {
  id: number;
  login: string;
  team: string;
  driver: string;
  money: number;
  namesFree: boolean;
  createdAt: number;
}

export interface SavedDesign {
  id: number;
  name: string;
  design: CarDesign;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,
  pw TEXT NOT NULL,
  team TEXT NOT NULL,
  team_key TEXT NOT NULL UNIQUE,
  driver TEXT NOT NULL,
  driver_key TEXT NOT NULL UNIQUE,
  money INTEGER NOT NULL,
  names_free INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS inventory (
  account_id INTEGER NOT NULL,
  part_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (account_id, part_id)
);
CREATE TABLE IF NOT EXISTS designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS designs_account ON designs(account_id);
CREATE TABLE IF NOT EXISTS limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_log_account ON wallet_log(account_id);
CREATE TABLE IF NOT EXISTS races_paid (
  race_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS suspended (
  account_id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER
);
`;

export class AccountStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  private now: () => number;
  private admins: Set<string>;
  private iterations: number;
  private inviteOnly: () => boolean;
  /** ない ID でも同じくらい時間をかけるための、使い捨ての印 */
  private dummyHash: Promise<string> | null = null;

  constructor(deps: StoreDeps) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    this.admins = new Set([...(deps.adminIds ?? [])].map(normalizeLoginId).filter(Boolean));
    this.iterations = deps.iterations ?? PBKDF2_ITERATIONS;
    this.inviteOnly = deps.inviteOnly ?? (() => false);
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
  }

  private rows(q: string, ...b: SqlValue[]): SqlRow[] {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]): SqlRow | undefined {
    return this.rows(q, ...b)[0];
  }

  // ---------- 回数の制限 ----------

  private limitCount(k: string): number {
    const r = this.row("SELECT n, reset_at FROM limits WHERE k = ?", k);
    if (!r || Number(r.reset_at) <= this.now()) return 0;
    return Number(r.n);
  }

  private limitHit(k: string, windowMs: number) {
    const now = this.now();
    const r = this.row("SELECT n, reset_at FROM limits WHERE k = ?", k);
    if (!r || Number(r.reset_at) <= now) this.sql.exec("INSERT OR REPLACE INTO limits (k, n, reset_at) VALUES (?, 1, ?)", k, now + windowMs);
    else this.sql.exec("UPDATE limits SET n = n + 1 WHERE k = ?", k);
  }

  private limitClear(k: string) {
    this.sql.exec("DELETE FROM limits WHERE k = ?", k);
  }

  // ---------- アカウント ----------

  private toAccount(r: SqlRow): Account {
    return {
      id: Number(r.id),
      login: String(r.login),
      team: String(r.team),
      driver: String(r.driver),
      money: Number(r.money),
      namesFree: Number(r.names_free) === 1,
      createdAt: Number(r.created_at),
    };
  }

  getAccount(id: number): Account | null {
    const r = this.row("SELECT * FROM accounts WHERE id = ?", id);
    return r ? this.toAccount(r) : null;
  }

  isAdmin(acc: Account): boolean {
    return this.admins.has(acc.login);
  }

  me(acc: Account): AccountMe {
    return { id: acc.login, team: acc.team, driver: acc.driver, money: acc.money, namesFree: acc.namesFree, admin: this.isAdmin(acc), createdAt: acc.createdAt };
  }

  private checkNamesFree(team: string, driver: string, exceptId: number) {
    const t = this.row("SELECT id FROM accounts WHERE team_key = ? AND id != ?", nameKey(team), exceptId);
    if (t) throw new ApiError(409, "そのチーム名はもう使われています");
    const d = this.row("SELECT id FROM accounts WHERE driver_key = ? AND id != ?", nameKey(driver), exceptId);
    if (d) throw new ApiError(409, "その運転手名はもう使われています");
  }

  /** 招かれた人だけ登録できるか (画面が登録の札に合言葉の欄を出すため) */
  registerInfo(): { inviteOnly: boolean } {
    return { inviteOnly: this.inviteOnly() };
  }

  async register(input: { id: unknown; password: unknown; team: unknown; driver: unknown; invite?: unknown }, ip: string): Promise<{ token: string; account: Account }> {
    const err = checkLoginId(input.id) ?? checkPassword(input.password) ?? checkTeamName(input.team) ?? checkDriverName(input.driver);
    if (err) throw new ApiError(400, err);
    // 招かれた人だけ (管理者が決めたとき): 使っていない合言葉が要る。使うのは登録が通ったとき
    const invite = this.inviteOnly() ? normalizeInvite(input.invite) : null;
    if (this.inviteOnly() && (!invite || !this.row("SELECT code FROM invites WHERE code = ? AND used_by IS NULL", invite))) {
      throw new ApiError(403, "今は招かれた人だけが登録できます。招待の合言葉を確かめてください");
    }
    const ipKey = `reg:${ip}`;
    if (this.limitCount(ipKey) >= REGISTER_PER_IP) throw new ApiError(429, "登録が多すぎます。しばらくしてからもう一度");
    const login = normalizeLoginId(input.id);
    const team = cleanDisplayName(input.team);
    const driver = cleanDisplayName(input.driver);
    if (this.row("SELECT id FROM accounts WHERE login = ?", login)) throw new ApiError(409, "その ID はもう使われています");
    this.checkNamesFree(team, driver, -1);
    const pw = await hashPassword(String(input.password), this.iterations);
    // await のあいだに同じ ID が入ったかもしれないので、もう一度確かめてから一気に書く
    const id = this.tx(() => {
      if (this.row("SELECT id FROM accounts WHERE login = ?", login)) throw new ApiError(409, "その ID はもう使われています");
      this.checkNamesFree(team, driver, -1);
      const r = this.row(
        "INSERT INTO accounts (login, pw, team, team_key, driver, driver_key, money, names_free, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING id",
        login,
        pw,
        team,
        nameKey(team),
        driver,
        nameKey(driver),
        STARTING_MONEY,
        this.now(),
      );
      const id = Number(r!.id);
      if (invite && !this.row("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL RETURNING code", id, this.now(), invite)) {
        throw new ApiError(403, "その招待の合言葉はもう使われました");
      }
      for (const [part, n] of Object.entries(starterInventory())) this.sql.exec("INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?)", id, part, n);
      this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", id, STARTING_MONEY, "はじめのお金", this.now());
      this.limitHit(ipKey, REGISTER_WINDOW_MS);
      return id;
    });
    const token = await this.newSession(id);
    return { token, account: this.getAccount(id)! };
  }

  async login(input: { id: unknown; password: unknown }, ip: string): Promise<{ token: string; account: Account }> {
    const login = normalizeLoginId(input.id);
    const pw = typeof input.password === "string" ? input.password : "";
    const idKey = `login:${login}`;
    const ipKey = `loginip:${ip}`;
    if (this.limitCount(idKey) >= LOGIN_FAIL_PER_ID || this.limitCount(ipKey) >= LOGIN_FAIL_PER_IP) {
      throw new ApiError(429, "ログインの失敗が多すぎます。15 分ほど待ってください");
    }
    const r = login ? this.row("SELECT id, pw FROM accounts WHERE login = ?", login) : undefined;
    let ok = false;
    if (r && pw.length <= 1024) ok = await verifyPassword(pw, String(r.pw));
    else await verifyPassword(pw.slice(0, 1024), await (this.dummyHash ??= hashPassword("dummy-password", this.iterations)));
    if (!ok) {
      this.limitHit(idKey, LOGIN_FAIL_WINDOW_MS);
      this.limitHit(ipKey, LOGIN_FAIL_WINDOW_MS);
      throw new ApiError(401, "ID かパスワードがちがいます");
    }
    this.limitClear(idKey);
    const id = Number(r!.id);
    if (this.isSuspended(id)) throw new ApiError(403, "このアカウントは管理者が止めています");
    const token = await this.newSession(id);
    return { token, account: this.getAccount(id)! };
  }

  private async newSession(accountId: number): Promise<string> {
    const token = randomToken();
    const h = await tokenHash(token);
    const now = this.now();
    this.tx(() => {
      this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
      this.sql.exec("INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)", h, accountId, now + SESSION_MS, now);
      // 多すぎるログインは古いものから消す
      this.sql.exec(
        "DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?)",
        accountId,
        accountId,
        MAX_SESSIONS,
      );
    });
    return token;
  }

  /** 合い言葉からアカウント (期限切れ・ない・止められているなら null) */
  async auth(token: string | null | undefined): Promise<Account | null> {
    const a = await this.authAny(token);
    return a && !this.isSuspended(a.id) ? a : null;
  }

  /** 合い言葉からアカウント (止められていても返す) */
  private async authAny(token: string | null | undefined): Promise<Account | null> {
    if (!token || token.length > 200) return null;
    const h = await tokenHash(token);
    const r = this.row("SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?", h, this.now());
    return r ? this.toAccount(r) : null;
  }

  isSuspended(accountId: number): boolean {
    return !!this.row("SELECT account_id FROM suspended WHERE account_id = ?", accountId);
  }

  async logout(token: string): Promise<void> {
    const h = await tokenHash(token);
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", h);
  }

  /** 表示名を変える (季節の切れ目に names_free = 1 になったときだけ。変えたらまた閉じる) */
  setNames(acc: Account, input: { team: unknown; driver: unknown }): Account {
    const err = checkTeamName(input.team) ?? checkDriverName(input.driver);
    if (err) throw new ApiError(400, err);
    const team = cleanDisplayName(input.team);
    const driver = cleanDisplayName(input.driver);
    return this.tx(() => {
      const cur = this.getAccount(acc.id);
      if (!cur) throw new ApiError(401, "ログインしてください");
      if (!cur.namesFree) throw new ApiError(403, "表示名は季節の切れ目にだけ変えられます");
      this.checkNamesFree(team, driver, cur.id);
      this.sql.exec("UPDATE accounts SET team = ?, team_key = ?, driver = ?, driver_key = ?, names_free = 0 WHERE id = ?", team, nameKey(team), driver, nameKey(driver), cur.id);
      return this.getAccount(cur.id)!;
    });
  }

  /** 表示名を変えてよい印を付ける (季節の切れ目に使う予定) */
  allowNameChange(accountId: number | "all"): void {
    if (accountId === "all") this.sql.exec("UPDATE accounts SET names_free = 1");
    else this.sql.exec("UPDATE accounts SET names_free = 1 WHERE id = ?", accountId);
  }

  /** 退会: パスワードを確かめて、チーム・部品・設計図・財布・ログインを全部消す */
  async deleteAccount(acc: Account, password: unknown): Promise<void> {
    const r = this.row("SELECT pw FROM accounts WHERE id = ?", acc.id);
    if (!r) throw new ApiError(401, "ログインしてください");
    if (typeof password !== "string" || password.length > 1024 || !(await verifyPassword(password, String(r.pw)))) {
      throw new ApiError(401, "パスワードがちがいます");
    }
    this.tx(() => {
      for (const t of ["sessions", "inventory", "designs", "wallet_log", "suspended"]) this.sql.exec(`DELETE FROM ${t} WHERE account_id = ?`, acc.id);
      this.sql.exec("DELETE FROM accounts WHERE id = ?", acc.id);
    });
  }

  /** 管理者がパスワードを戻す。new が無ければ仮のパスワードを作って返す。その人のログインは全部切る */
  async adminResetPassword(admin: Account, input: { id: unknown; password?: unknown }): Promise<{ password: string }> {
    if (!this.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
    const login = normalizeLoginId(input.id);
    const target = this.row("SELECT id FROM accounts WHERE login = ?", login);
    if (!target) throw new ApiError(404, "その ID は見つかりません");
    const pw = input.password === undefined || input.password === "" ? randomPassword() : input.password;
    const err = checkPassword(pw);
    if (err) throw new ApiError(400, err);
    const hash = await hashPassword(String(pw), this.iterations);
    this.tx(() => {
      this.sql.exec("UPDATE accounts SET pw = ? WHERE id = ?", hash, Number(target.id));
      this.sql.exec("DELETE FROM sessions WHERE account_id = ?", Number(target.id));
      this.limitClear(`login:${login}`);
    });
    return { password: String(pw) };
  }

  /**
   * 管理者が荒らしを止める / 戻す。止めるとログインもネットのレースもできない (ログインしたままの合い言葉も使えなくなる)。
   * 管理者は止められない
   */
  adminSetSuspended(admin: Account, input: { id: unknown; suspended: unknown; reason?: unknown }): { id: string; suspended: boolean } {
    if (!this.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
    const login = normalizeLoginId(input.id);
    const target = this.row("SELECT id, login FROM accounts WHERE login = ?", login);
    if (!target) throw new ApiError(404, "その ID は見つかりません");
    if (typeof input.suspended !== "boolean") throw new ApiError(400, "止めるか戻すかを送ってください");
    if (input.suspended && this.admins.has(String(target.login))) throw new ApiError(400, "管理者は止められません");
    const id = Number(target.id);
    if (input.suspended) {
      const reason = cleanDisplayName(typeof input.reason === "string" ? input.reason : "").slice(0, SUSPEND_REASON_MAX);
      this.sql.exec("INSERT INTO suspended (account_id, reason, at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET reason = excluded.reason, at = excluded.at", id, reason, this.now());
    } else {
      this.sql.exec("DELETE FROM suspended WHERE account_id = ?", id);
    }
    return { id: login, suspended: input.suspended };
  }

  /** 管理者が招待の合言葉を作る (1 つにつき 1 人が登録できる) */
  adminCreateInvites(admin: Account, input: { count?: unknown; note?: unknown }): { codes: string[] } {
    if (!this.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
    const n = input.count === undefined ? 1 : Number(input.count);
    if (!Number.isInteger(n) || n < 1 || n > INVITE_MAX_BATCH) throw new ApiError(400, `1 回に作れるのは 1〜${INVITE_MAX_BATCH} 個です`);
    const note = cleanDisplayName(typeof input.note === "string" ? input.note : "").slice(0, 40);
    return this.tx(() => {
      const codes: string[] = [];
      while (codes.length < n) {
        const code = randomInviteCode();
        if (this.row("SELECT code FROM invites WHERE code = ?", code)) continue;
        this.sql.exec("INSERT INTO invites (code, note, created_at) VALUES (?, ?, ?)", code, note, this.now());
        codes.push(code);
      }
      return { codes };
    });
  }

  /** 招待の合言葉の一覧 (新しい順)。使った人の ID も */
  adminListInvites(admin: Account): { invites: Array<{ code: string; note: string; createdAt: number; usedBy: string | null; usedAt: number | null }> } {
    if (!this.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
    const rows = this.rows(
      "SELECT i.code, i.note, i.created_at, i.used_at, a.login AS used_login, i.used_by FROM invites i LEFT JOIN accounts a ON a.id = i.used_by ORDER BY i.created_at DESC, i.code LIMIT ?",
      INVITE_LIST_MAX,
    );
    return {
      invites: rows.map((r) => ({
        code: String(r.code),
        note: String(r.note),
        createdAt: Number(r.created_at),
        usedBy: r.used_by === null ? null : r.used_login === null ? "(退会)" : String(r.used_login),
        usedAt: r.used_at === null ? null : Number(r.used_at),
      })),
    };
  }

  /** まだ使っていない招待の合言葉を消す */
  adminDeleteInvite(admin: Account, code: unknown): { ok: true } {
    if (!this.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
    const c = normalizeInvite(code);
    if (!c || !this.row("DELETE FROM invites WHERE code = ? AND used_by IS NULL RETURNING code", c)) throw new ApiError(404, "その合言葉はないか、もう使われました");
    return { ok: true };
  }

  // ---------- 持ち物とお店 ----------

  inventory(accountId: number): Inventory {
    const out: Inventory = {};
    for (const r of this.rows("SELECT part_id, n FROM inventory WHERE account_id = ? AND n > 0", accountId)) out[String(r.part_id)] = Number(r.n);
    return out;
  }

  buy(acc: Account, part: unknown, qty: unknown): { money: number; parts: Inventory } {
    const partId = String(part ?? "");
    const n = Number(qty ?? 1);
    return this.tx(() => {
      const cur = this.getAccount(acc.id);
      if (!cur) throw new ApiError(401, "ログインしてください");
      const owned = this.inventory(cur.id)[partId] ?? 0;
      const res = checkBuy(partId, n, cur.money, owned);
      if (!res.ok) throw new ApiError(400, res.msg);
      this.sql.exec("UPDATE accounts SET money = money - ? WHERE id = ?", res.cost, cur.id);
      this.sql.exec(
        "INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?) ON CONFLICT(account_id, part_id) DO UPDATE SET n = excluded.n",
        cur.id,
        partId,
        res.owned,
      );
      this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", cur.id, -res.cost, `買う: ${partId} ×${n}`, this.now());
      return { money: res.money, parts: this.inventory(cur.id) };
    });
  }

  // ---------- 設計図 ----------

  listDesigns(accountId: number): SavedDesign[] {
    return this.rows("SELECT id, name, body, updated_at FROM designs WHERE account_id = ? ORDER BY id", accountId).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      design: JSON.parse(String(r.body)) as CarDesign,
      updatedAt: Number(r.updated_at),
    }));
  }

  /** 設計図を保存する (id があれば上書き)。持っていない部品があれば断る。仕上がっていない設計図も保存できる */
  saveDesign(acc: Account, raw: unknown, id?: number): SavedDesign {
    const design = parseDesign(raw);
    if (!design) throw new ApiError(400, "設計図が読めません");
    return this.tx(() => {
      const fit = designFits(design, this.inventory(acc.id));
      if (!fit.ok) throw new ApiError(400, `持っていない部品があります (${missingText(fit.missing)})`);
      const now = this.now();
      const body = JSON.stringify(design);
      if (id !== undefined) {
        const r = this.row("UPDATE designs SET name = ?, body = ?, updated_at = ? WHERE id = ? AND account_id = ? RETURNING id", design.name, body, now, id, acc.id);
        if (!r) throw new ApiError(404, "その設計図は見つかりません");
        return { id, name: design.name, design, updatedAt: now };
      }
      const count = Number(this.row("SELECT COUNT(*) AS c FROM designs WHERE account_id = ?", acc.id)?.c ?? 0);
      if (count >= MAX_DESIGNS) throw new ApiError(400, `設計図は ${MAX_DESIGNS} 個までです`);
      const r = this.row("INSERT INTO designs (account_id, name, body, updated_at) VALUES (?, ?, ?, ?) RETURNING id", acc.id, design.name, body, now);
      return { id: Number(r!.id), name: design.name, design, updatedAt: now };
    });
  }

  deleteDesign(acc: Account, id: number): void {
    const r = this.row("DELETE FROM designs WHERE id = ? AND account_id = ? RETURNING id", id, acc.id);
    if (!r) throw new ApiError(404, "その設計図は見つかりません");
  }

  // ---------- レース ----------

  /**
   * レースに入るときの確かめ (部屋の DO から呼ぶ)。
   * 合い言葉がない・切れているなら account = null (名無しで走る)。持っていない部品を使っていたら error
   */
  async raceEntry(token: string | undefined, raw: unknown): Promise<{ account: { id: number; driver: string } | null; error?: string }> {
    const acc = await this.authAny(token);
    if (acc && this.isSuspended(acc.id)) return { account: null, error: "このアカウントは管理者が止めています" };
    const design = parseDesign(raw);
    // 読めない設計図は部屋のほうで断る
    if (!acc || !design) return { account: null };
    const fit = designFits(design, this.inventory(acc.id));
    if (!fit.ok) return { account: null, error: `持っていない部品を使っています (${missingText(fit.missing)})` };
    return { account: { id: acc.id, driver: acc.driver } };
  }

  /** 賞金を払う。同じ raceId は 1 回だけ。払ったあとの財布 (アカウント id → お金) を返す */
  payPrizes(raceId: string, items: Array<{ accountId: number; amount: number; reason: string }>): Record<number, number> {
    return this.tx(() => {
      const out: Record<number, number> = {};
      if (this.row("SELECT race_id FROM races_paid WHERE race_id = ?", raceId)) return out;
      this.sql.exec("INSERT INTO races_paid (race_id, at) VALUES (?, ?)", raceId, this.now());
      for (const it of items) {
        const amount = Math.max(0, Math.floor(it.amount));
        if (!amount) continue;
        const r = this.row("UPDATE accounts SET money = money + ? WHERE id = ? RETURNING money", amount, it.accountId);
        if (!r) continue; // 退会した
        this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", it.accountId, amount, it.reason.slice(0, 80), this.now());
        out[it.accountId] = Number(r.money);
      }
      return out;
    });
  }
}

/** 招待の合言葉の字 (見まちがえやすい 0 O 1 I L を除く) */
const INVITE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomInviteCode(): string {
  const b = new Uint8Array(INVITE_CODE_LEN);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += INVITE_CHARS[x % INVITE_CHARS.length];
  return s;
}

/** 打ちこまれた招待の合言葉をそろえる (大文字・空白とハイフンなし)。形がちがえば null */
export function normalizeInvite(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toUpperCase().replace(/[\s-]/g, "");
  return s.length === INVITE_CODE_LEN && [...s].every((c) => INVITE_CHARS.includes(c)) ? s : null;
}

function missingText(missing: Record<string, number>): string {
  return Object.entries(missing)
    .map(([id, n]) => `${partDef(id)?.name ?? id} ×${n}`)
    .join("・");
}

/** 送られてきた設計図の形を確かめる (仕上がっているかは見ない) */
export function parseDesign(raw: unknown): CarDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { name?: unknown; parts?: unknown };
  if (!Array.isArray(d.parts) || d.parts.length > GRID_W * GRID_H) return null;
  const parts: Placed[] = [];
  for (const p of d.parts as unknown[]) {
    if (!p || typeof p !== "object") return null;
    const { id, c, r, rot } = p as Record<string, unknown>;
    if (typeof id !== "string" || !partDef(id)) return null;
    if (!Number.isInteger(c) || !Number.isInteger(r) || (c as number) < 0 || (c as number) >= GRID_W || (r as number) < 0 || (r as number) >= GRID_H) return null;
    if (rot !== 0 && rot !== 1) return null;
    parts.push({ id, c: c as number, r: r as number, rot });
  }
  const name = cleanDisplayName(d.name).slice(0, DESIGN_NAME_MAX) || "名無しの車";
  return { name, parts };
}
