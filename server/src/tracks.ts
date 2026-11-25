// みんなのコース: 遊ぶ人が作ったコースの公開 (SQLite) と /api/tracks・/api/admin/tracks の受け口。
// アカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。
// 公開の条件 (DECISIONS「コース」): 自分で 1 周走れた (画面が言う。そのタイムを残す) + 管理者が確かめた (名前も)。
// 公開できる数の上限はない。送る回数と、確かめ待ちの数だけ抑える (管理者の列があふれないように)。
// 人気は shared/src/popularity.ts (走られた回数 + いいね × 10。いいねは走り終えた人だけ)。
// 部屋 (worker.ts) でみんなのコースを走るときは resolveTrackDef (下) で形を読み、getTrack で引けるようにする。
import {
  PUB_TRACK_PREFIX,
  TRACK_DEFS,
  TRACK_LIMITS,
  checkTrack,
  checkTrackName,
  cleanTrackName,
  isPublicTrackId,
  likeTrack,
  newTrackPopularity,
  parseTrackDef,
  popularityScore,
  rankTracks,
  recordTrackRun,
  registerTrackDef,
  trackShapeKey,
  unlikeTrack,
  type TrackDef,
  type TrackPopularity,
} from "@bpr/shared";
import { ApiError, type Account, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  local_id TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  shape_key TEXT NOT NULL,
  length REAL NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  author_lap_ms INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  published_at INTEGER,
  drives INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS user_tracks_local ON user_tracks(account_id, local_id);
CREATE INDEX IF NOT EXISTS user_tracks_status ON user_tracks(status, submitted_at);
CREATE TABLE IF NOT EXISTS track_runs (
  track_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  best_ms INTEGER,
  driver TEXT,
  last_drive_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, account_id)
);
CREATE INDEX IF NOT EXISTS track_runs_best ON track_runs(track_id, best_ms);
CREATE TABLE IF NOT EXISTS track_likes (
  track_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (track_id, account_id)
);
CREATE TABLE IF NOT EXISTS track_rate (
  account_id INTEGER PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
`;

/** 送る回数: 1 人 1 時間に (仮) */
export const TRACK_SUBMIT_PER_HOUR = 10;
/** 確かめ待ちにしておける数: 1 人 (仮。公開の数の上限ではない) */
export const TRACK_PENDING_MAX = 10;
/** 同じ人が同じコースを走った回数は、この間をあけないと数えない (ms、仮。人気を水増しできないように) */
export const TRACK_DRIVE_GAP_MS = 2 * 60_000;
/** 一覧で返す数の上限 (仮) */
export const TRACK_LIST_MAX = 100;
/** 1 周のタイムの下限: 1 周の長さ ÷ この速さ (m/s)。これより速い周は受けつけない (仮) */
export const TRACK_LAP_MAX_SPEED = 100;
/** 1 周のタイムの上限 (秒、仮) */
export const TRACK_LAP_MAX_SEC = 3600;
/** 断るときの理由の長さ */
export const TRACK_REASON_MAX = 120;

export type TrackStatus = "pending" | "public" | "rejected";

/** 自分が出したコース (web/src/tracks_api.ts と合わせる) */
export interface MyTrackRow {
  id: string;
  localId: string;
  name: string;
  status: TrackStatus;
  reason: string | null;
  length: number;
  /** 出したときの自分の周 (秒) */
  authorLap: number;
  submittedAt: number;
  reviewedAt: number | null;
}

/** みんなのコースの一覧の 1 行 */
export interface PublicTrackRow {
  id: string;
  name: string;
  author: string;
  length: number;
  drives: number;
  likes: number;
  score: number;
  rank: number;
  publishedAt: number;
  /** 一番速い周 (秒) と運転手 */
  record: { lap: number; driver: string } | null;
  /** 輪の点 (一覧の小さな絵を描くため) */
  points: Array<[number, number]>;
  /** ログインしていれば: 走り終えたか・いいねしたか */
  finished?: boolean;
  liked?: boolean;
  mine?: boolean;
}

/** 管理者の列の 1 行 (形も返す。絵を描いて確かめるため) */
export interface AdminTrackRow extends MyTrackRow {
  author: string;
  login: string | null;
  def: TrackDef;
  drives: number;
  likes: number;
}

export interface TrackDetail {
  def: TrackDef;
  meta: PublicTrackRow | null;
  status: TrackStatus;
}

export interface TrackDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
}

const HOUR_MS = 3600_000;

/** "pub:12" か "12" → 12 */
export function pubNumber(id: unknown): number | null {
  const s = String(id ?? "");
  const m = /^(?:pub:)?(\d{1,12})$/.exec(s);
  return m ? Number(m[1]) : null;
}

export class TrackStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  private now: () => number;

  constructor(
    deps: TrackDeps,
    private accounts: AccountStore,
  ) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  private hit(accountId: number) {
    const now = this.now();
    const r = this.row("SELECT n, reset_at FROM track_rate WHERE account_id = ?", accountId);
    if (!r || Number(r.reset_at) <= now) {
      this.sql.exec("INSERT OR REPLACE INTO track_rate (account_id, n, reset_at) VALUES (?, 1, ?)", accountId, now + HOUR_MS);
      return;
    }
    if (Number(r.n) >= TRACK_SUBMIT_PER_HOUR) throw new ApiError(429, "送るのが多すぎます。しばらくしてからもう一度");
    this.sql.exec("UPDATE track_rate SET n = n + 1 WHERE account_id = ?", accountId);
  }

  private defOf(r: Record<string, SqlValue>): TrackDef {
    const body = JSON.parse(String(r.body)) as TrackDef;
    return { ...body, id: PUB_TRACK_PREFIX + Number(r.id), name: String(r.name) };
  }

  private mine(r: Record<string, SqlValue>): MyTrackRow {
    return {
      id: PUB_TRACK_PREFIX + Number(r.id),
      localId: String(r.local_id),
      name: String(r.name),
      status: String(r.status) as TrackStatus,
      reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
      length: Math.round(Number(r.length)),
      authorLap: Number(r.author_lap_ms) / 1000,
      submittedAt: Number(r.submitted_at),
      reviewedAt: r.reviewed_at === null || r.reviewed_at === undefined ? null : Number(r.reviewed_at),
    };
  }

  /** 人気を数えるための形 (popularity.ts)。finishers と likes は、聞かれた人 (who) の分だけ入れる (全員分は要らない) */
  private pop(trackId: number, drives: number, likes: number, who: number | null): TrackPopularity {
    const p = newTrackPopularity(PUB_TRACK_PREFIX + trackId);
    p.drives = drives;
    // いいねの数だけの印 (rankTracks と popularityScore は数しか見ない)
    const likeIds: string[] = [];
    const meLiked = who !== null && !!this.row("SELECT 1 AS x FROM track_likes WHERE track_id = ? AND account_id = ?", trackId, who);
    for (let i = 0; i < likes - (meLiked ? 1 : 0); i++) likeIds.push(`#${i}`);
    if (meLiked) likeIds.push(String(who));
    p.likes = likeIds;
    const fin = who !== null && Number(this.row("SELECT finished FROM track_runs WHERE track_id = ? AND account_id = ?", trackId, who)?.finished ?? 0) === 1;
    p.finishers = fin ? [String(who)] : [];
    return p;
  }

  // ---------- 出す ----------

  /**
   * 自分のコースを出す (確かめ待ちにする)。localId = 画面の機械の中の印 (同じものを出し直すと置きかえ)。
   * 公開中のコースの形は変えられない (複製して別のコースとして出す)
   */
  submit(acc: Account, raw: Record<string, unknown>): MyTrackRow {
    const localId = String(raw.localId ?? "");
    if (!/^[0-9a-z_-]{4,40}$/i.test(localId)) throw new ApiError(400, "コースの印が読めません");
    const def = parseTrackDef(raw.def);
    if (!def) throw new ApiError(400, "コースが読めません");
    const nameErr = checkTrackName(def.name);
    if (nameErr) throw new ApiError(400, nameErr);
    def.name = cleanTrackName(def.name);
    const check = checkTrack(def);
    if (!check.ok || !check.track) throw new ApiError(400, `コースに問題があります: ${check.issues[0]?.message ?? ""}`);
    const lap = Number(raw.lapTime);
    const length = check.track.length;
    if (raw.lapped !== true || !Number.isFinite(lap)) throw new ApiError(400, "公開するには、先に自分で 1 周走ってください");
    if (lap < length / TRACK_LAP_MAX_SPEED || lap > TRACK_LAP_MAX_SEC) throw new ApiError(400, "1 周のタイムがおかしいです");
    const shape = trackShapeKey(def);
    const { id: _id, name, ...rest } = def;
    const body = JSON.stringify(rest);
    const now = this.now();
    return this.tx(() => {
      const cur = this.row("SELECT * FROM user_tracks WHERE account_id = ? AND local_id = ?", acc.id, localId);
      if (cur && String(cur.status) === "public") {
        if (String(cur.shape_key) !== shape) throw new ApiError(409, "公開中のコースの形は変えられません。複製して新しいコースとして出してください");
        // 同じ形なら何もしない (公開中の名前を変えるのは管理者だけ)
        return this.mine(cur);
      }
      if (!cur || String(cur.status) !== "pending") {
        const n = Number(this.row("SELECT COUNT(*) AS c FROM user_tracks WHERE account_id = ? AND status = 'pending'", acc.id)?.c ?? 0);
        if (n >= TRACK_PENDING_MAX) throw new ApiError(429, `確かめ待ちのコースが ${TRACK_PENDING_MAX} 本あります。確かめが済んでからもう一度`);
      }
      this.hit(acc.id);
      const lapMs = Math.round(lap * 1000);
      if (cur) {
        // 確かめ待ち・断られたものを出し直した: 置きかえて、確かめ待ちに
        const r = this.row(
          "UPDATE user_tracks SET name = ?, author = ?, body = ?, shape_key = ?, length = ?, status = 'pending', reason = NULL, author_lap_ms = ?, submitted_at = ?, reviewed_at = NULL WHERE id = ? RETURNING *",
          name,
          acc.team,
          body,
          shape,
          length,
          lapMs,
          now,
          Number(cur.id),
        );
        return this.mine(r!);
      }
      const r = this.row(
        "INSERT INTO user_tracks (account_id, local_id, name, author, body, shape_key, length, status, author_lap_ms, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *",
        acc.id,
        localId,
        name,
        acc.team,
        body,
        shape,
        length,
        lapMs,
        now,
      );
      return this.mine(r!);
    });
  }

  listMine(accountId: number): MyTrackRow[] {
    return this.rows("SELECT * FROM user_tracks WHERE account_id = ? ORDER BY submitted_at DESC", accountId).map((r) => this.mine(r));
  }

  /** 自分で取り下げる (どの状態でも)。走った記録といいねも消す */
  withdraw(acc: Account, id: number): void {
    this.tx(() => {
      const r = this.row("DELETE FROM user_tracks WHERE id = ? AND account_id = ? RETURNING id", id, acc.id);
      if (!r) throw new ApiError(404, "そのコースは見つかりません");
      this.sql.exec("DELETE FROM track_runs WHERE track_id = ?", id);
      this.sql.exec("DELETE FROM track_likes WHERE track_id = ?", id);
    });
  }

  // ---------- みんなのコース ----------

  private likesOf(trackId: number): number {
    return Number(this.row("SELECT COUNT(*) AS c FROM track_likes WHERE track_id = ?", trackId)?.c ?? 0);
  }

  private recordOf(trackId: number): { lap: number; driver: string } | null {
    const r = this.row("SELECT best_ms, driver FROM track_runs WHERE track_id = ? AND best_ms IS NOT NULL ORDER BY best_ms, last_drive_at LIMIT 1", trackId);
    return r ? { lap: Number(r.best_ms) / 1000, driver: String(r.driver ?? "") } : null;
  }

  /** 公開中のコース。sort = popular (人気の順) か new (新しい順) */
  listPublic(who: number | null, sort: "popular" | "new" = "popular"): PublicTrackRow[] {
    const list = this.rows(
      "SELECT t.id, t.account_id, t.name, t.author, t.length, t.drives, t.published_at, t.body, (SELECT COUNT(*) FROM track_likes l WHERE l.track_id = t.id) AS likes FROM user_tracks t WHERE t.status = 'public'",
    );
    const pops = list.map((r) => this.pop(Number(r.id), Number(r.drives), Number(r.likes), who));
    const ranks = new Map(rankTracks(pops).map((x) => [x.trackId, x]));
    const out: PublicTrackRow[] = list.map((r, i) => {
      const id = PUB_TRACK_PREFIX + Number(r.id);
      const p = pops[i];
      const row: PublicTrackRow = {
        id,
        name: String(r.name),
        author: String(r.author),
        length: Math.round(Number(r.length)),
        drives: p.drives,
        likes: p.likes.length,
        score: popularityScore(p),
        rank: ranks.get(id)?.rank ?? 0,
        publishedAt: Number(r.published_at ?? 0),
        record: this.recordOf(Number(r.id)),
        points: (JSON.parse(String(r.body)) as TrackDef).points,
      };
      if (who !== null) {
        row.finished = p.finishers.length > 0;
        row.liked = p.likes.includes(String(who));
        row.mine = Number(r.account_id) === who;
      }
      return row;
    });
    out.sort((a, b) => (sort === "new" ? b.publishedAt - a.publishedAt || a.rank - b.rank : a.rank - b.rank));
    return out.slice(0, TRACK_LIST_MAX);
  }

  /** 1 本の形。公開中なら誰でも、確かめ待ち・断られたものは出した人と管理者だけ */
  get(id: number, who: Account | null): TrackDetail {
    const r = this.row("SELECT * FROM user_tracks WHERE id = ?", id);
    const status = r ? (String(r.status) as TrackStatus) : null;
    const allowed = r && (status === "public" || (who && (Number(r.account_id) === who.id || this.accounts.isAdmin(who))));
    if (!r || !allowed) throw new ApiError(404, "そのコースは見つかりません");
    const meta = status === "public" ? (this.listPublicOne(id, who?.id ?? null) ?? null) : null;
    return { def: this.defOf(r), meta, status: status! };
  }

  private listPublicOne(id: number, who: number | null): PublicTrackRow | null {
    return this.listPublic(who).find((x) => x.id === PUB_TRACK_PREFIX + id) ?? null;
  }

  /** 公開中のコースの形 (部屋が使う)。なければ null */
  publicDef(id: string | number): TrackDef | null {
    const n = typeof id === "number" ? id : pubNumber(id);
    if (n === null) return null;
    const r = this.row("SELECT * FROM user_tracks WHERE id = ? AND status = 'public'", n);
    return r ? this.defOf(r) : null;
  }

  /**
   * 走った (練習で 1 周・部屋のレース)。finished = 走り終えた (いいねを押せるようになる)。lap = 一番速い周の候補 (秒)。
   * 走った回数は同じ人なら TRACK_DRIVE_GAP_MS あけないと数えない
   */
  recordRun(accountId: number, driver: string, id: number, finished: boolean, lap?: number): { counted: boolean; best: number | null } {
    return this.tx(() => {
      const t = this.row("SELECT length FROM user_tracks WHERE id = ? AND status = 'public'", id);
      if (!t) throw new ApiError(404, "そのコースは見つかりません");
      const now = this.now();
      const length = Number(t.length);
      const lapOk = lap !== undefined && Number.isFinite(lap) && lap >= length / TRACK_LAP_MAX_SPEED && lap <= TRACK_LAP_MAX_SEC;
      const lapMs = lapOk ? Math.round(lap! * 1000) : null;
      const cur = this.row("SELECT * FROM track_runs WHERE track_id = ? AND account_id = ?", id, accountId);
      const counted = !cur || now - Number(cur.last_drive_at) >= TRACK_DRIVE_GAP_MS;
      // popularity.ts の決まりで数える (走り終えた人の印)
      let pop = this.pop(id, 0, 0, accountId);
      pop = recordTrackRun(pop, String(accountId), finished);
      const fin = pop.finishers.includes(String(accountId)) ? 1 : 0;
      const prevBest = cur && cur.best_ms !== null && cur.best_ms !== undefined ? Number(cur.best_ms) : null;
      const best = lapMs !== null && finished && (prevBest === null || lapMs < prevBest) ? lapMs : prevBest;
      if (!cur) {
        this.sql.exec("INSERT INTO track_runs (track_id, account_id, finished, best_ms, driver, last_drive_at) VALUES (?, ?, ?, ?, ?, ?)", id, accountId, fin, best, driver, now);
      } else {
        this.sql.exec(
          "UPDATE track_runs SET finished = ?, best_ms = ?, driver = ?, last_drive_at = ? WHERE track_id = ? AND account_id = ?",
          fin,
          best,
          driver,
          counted ? now : Number(cur.last_drive_at),
          id,
          accountId,
        );
      }
      if (counted) this.sql.exec("UPDATE user_tracks SET drives = drives + 1 WHERE id = ?", id);
      return { counted, best: best === null ? null : best / 1000 };
    });
  }

  /** いいね (走り終えた人だけ) と、その取り消し */
  like(accountId: number, id: number, on: boolean): { likes: number; liked: boolean } {
    return this.tx(() => {
      const t = this.row("SELECT id FROM user_tracks WHERE id = ? AND status = 'public'", id);
      if (!t) throw new ApiError(404, "そのコースは見つかりません");
      const pop = this.pop(id, 0, this.likesOf(id), accountId);
      if (on) {
        const r = likeTrack(pop, String(accountId));
        if (!r.ok && r.reason === "not_finished") throw new ApiError(403, "いいねは、そのコースを走り終えた人だけが押せます");
        if (r.ok) this.sql.exec("INSERT OR IGNORE INTO track_likes (track_id, account_id, at) VALUES (?, ?, ?)", id, accountId, this.now());
      } else {
        const after = unlikeTrack(pop, String(accountId));
        if (after !== pop) this.sql.exec("DELETE FROM track_likes WHERE track_id = ? AND account_id = ?", id, accountId);
      }
      const liked = !!this.row("SELECT 1 AS x FROM track_likes WHERE track_id = ? AND account_id = ?", id, accountId);
      return { likes: this.likesOf(id), liked };
    });
  }

  // ---------- 管理者 ----------

  adminList(status: TrackStatus | "all"): AdminTrackRow[] {
    const q =
      status === "all"
        ? this.rows("SELECT t.*, a.login FROM user_tracks t LEFT JOIN accounts a ON a.id = t.account_id ORDER BY t.submitted_at DESC LIMIT 500")
        : this.rows(
            `SELECT t.*, a.login FROM user_tracks t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.status = ? ORDER BY t.submitted_at ${status === "pending" ? "ASC" : "DESC"} LIMIT 500`,
            status,
          );
    return q.map((r) => ({
      ...this.mine(r),
      author: String(r.author),
      login: r.login === null || r.login === undefined ? null : String(r.login),
      def: this.defOf(r),
      drives: Number(r.drives),
      likes: this.likesOf(Number(r.id)),
    }));
  }

  /** 確かめる: approve (公開) か reject (断る・公開をやめる)。name を渡すと名前を直す。reason は断る理由 (なくてよい) */
  review(admin: Account, id: number, input: { action: unknown; reason?: unknown; name?: unknown }): AdminTrackRow {
    if (!this.accounts.isAdmin(admin)) throw new ApiError(403, "管理者だけができます");
    const action = input.action;
    if (action !== "approve" && action !== "reject") throw new ApiError(400, "approve か reject を選んでください");
    let name: string | null = null;
    if (input.name !== undefined && input.name !== null && input.name !== "") {
      const err = checkTrackName(input.name, true);
      if (err) throw new ApiError(400, err);
      name = cleanTrackName(input.name);
    }
    const reason = input.reason === undefined || input.reason === null ? "" : String(input.reason).trim().slice(0, TRACK_REASON_MAX);
    const now = this.now();
    this.tx(() => {
      const r = this.row("SELECT id, status FROM user_tracks WHERE id = ?", id);
      if (!r) throw new ApiError(404, "そのコースは見つかりません");
      if (name !== null) this.sql.exec("UPDATE user_tracks SET name = ? WHERE id = ?", name, id);
      if (action === "approve") {
        this.sql.exec("UPDATE user_tracks SET status = 'public', reason = NULL, reviewed_at = ?, published_at = COALESCE(published_at, ?) WHERE id = ?", now, now, id);
      } else {
        this.sql.exec("UPDATE user_tracks SET status = 'rejected', reason = ?, reviewed_at = ? WHERE id = ?", reason || null, now, id);
      }
    });
    return this.adminList("all").find((x) => x.id === PUB_TRACK_PREFIX + id)!;
  }

  /** 退会したとき: 公開中のコースは残す (作った人の名前は残る)。ほかは消す。走った記録・いいね・回数も消す */
  forgetAccount(accountId: number): void {
    this.tx(() => {
      const gone = this.rows("SELECT id FROM user_tracks WHERE account_id = ? AND status != 'public'", accountId).map((r) => Number(r.id));
      for (const id of gone) {
        this.sql.exec("DELETE FROM track_runs WHERE track_id = ?", id);
        this.sql.exec("DELETE FROM track_likes WHERE track_id = ?", id);
      }
      this.sql.exec("DELETE FROM user_tracks WHERE account_id = ? AND status != 'public'", accountId);
      this.sql.exec("UPDATE user_tracks SET account_id = 0, local_id = 'gone-' || id WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM track_runs WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM track_likes WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM track_rate WHERE account_id = ?", accountId);
    });
  }
}

// ---------------------------------------------------------------- 部屋から使う

/** 公開中のコースの形を返すもの (AccountsDO の RPC publicTrackDef) */
export interface TrackSource {
  publicTrackDef(id: string): Promise<TrackDef | null> | TrackDef | null;
}

/**
 * 部屋 (worker.ts の RaceRoomDO) がレースの前に呼ぶ: コースの id から形を返し、getTrack で引けるようにする。
 * 公式のコースはそのまま。"pub:<n>" は AccountsDO から読む (公開中のものだけ)。知らない id は null (部屋は断る)。
 *   const def = await resolveTrackDef(trackId, accountsStub);  // accountsStub = env.ACCOUNTS.get(idFromName("accounts"))
 *   if (!def) …断る…;  // このあとは今までどおり getTrack(trackId) で引ける
 * DO が眠って起きたあとも、レースを続ける前にもう一度呼ぶ (getTrack の覚えは DO の中だけ)
 */
export async function resolveTrackDef(id: string, src: TrackSource): Promise<TrackDef | null> {
  const official = TRACK_DEFS.find((d) => d.id === id);
  if (official) return official;
  if (!isPublicTrackId(id)) return null;
  const def = await src.publicTrackDef(id);
  if (!def) return null;
  registerTrackDef(def);
  return def;
}

// ---------------------------------------------------------------- /api/tracks

const MAX_BODY = 64 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "送るものが大きすぎます");
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下で断る */
  }
  throw new ApiError(400, "送られてきたものが読めません");
}

export const TRACKS_PATH = /^\/api\/(tracks|admin\/tracks)(\/|$)/;

/**
 * GET    /api/tracks?sort=popular|new   みんなのコース (公開中)。ログインしていれば 走り終えたか・いいねしたか も
 * GET    /api/tracks/mine               自分が出したコース (状態と断られた理由)
 * POST   /api/tracks                    自分のコースを出す { localId, def, lapped: true, lapTime } (ログイン)
 * GET    /api/tracks/:n                 1 本の形 (公開中なら誰でも)
 * DELETE /api/tracks/:n                 自分のコースを取り下げる
 * POST   /api/tracks/:n/run             走った { finished, lap? } (ログイン)
 * POST   /api/tracks/:n/like            いいね (走り終えた人だけ)。DELETE で取り消し
 * GET    /api/admin/tracks?status=pending|public|rejected|all   管理者の列
 * POST   /api/admin/tracks/:n/review    { action: "approve" | "reject", reason?, name? }
 */
export async function handleTracksApi(req: Request, path: string, method: string, accounts: AccountStore, tracks: TrackStore): Promise<Response> {
  const url = new URL(req.url);
  const who = () => accounts.auth(bearer(req));
  const needAuth = async () => {
    const a = await who();
    if (!a) throw new ApiError(401, "ログインしてください");
    return a;
  };

  if (path === "/api/admin/tracks" && method === "GET") {
    const a = await needAuth();
    if (!accounts.isAdmin(a)) throw new ApiError(403, "管理者だけができます");
    const s = url.searchParams.get("status") ?? "pending";
    if (!["pending", "public", "rejected", "all"].includes(s)) throw new ApiError(400, "その状態はありません");
    return json({ tracks: tracks.adminList(s as TrackStatus | "all") });
  }
  const rv = /^\/api\/admin\/tracks\/(?:pub:)?(\d{1,12})\/review$/.exec(path);
  if (rv && method === "POST") {
    const a = await needAuth();
    const b = await body(req);
    return json({ track: tracks.review(a, Number(rv[1]), { action: b.action, reason: b.reason, name: b.name }) });
  }

  if (path === "/api/tracks" && method === "GET") {
    const sort = url.searchParams.get("sort") === "new" ? "new" : "popular";
    return json({ tracks: tracks.listPublic((await who())?.id ?? null, sort), limits: { maxLength: TRACK_LIMITS.maxLength } });
  }
  if (path === "/api/tracks/mine" && method === "GET") {
    const a = await needAuth();
    return json({ tracks: tracks.listMine(a.id) });
  }
  if (path === "/api/tracks" && method === "POST") {
    const a = await needAuth();
    const b = await body(req);
    return json({ track: tracks.submit(a, b) }, 201);
  }
  const one = /^\/api\/tracks\/(?:pub:)?(\d{1,12})(?:\/(run|like))?$/.exec(path);
  if (one) {
    const id = Number(one[1]);
    const sub = one[2];
    if (!sub && method === "GET") return json(tracks.get(id, await who()));
    if (!sub && method === "DELETE") {
      tracks.withdraw(await needAuth(), id);
      return json({ ok: true });
    }
    if (sub === "run" && method === "POST") {
      const a = await needAuth();
      const b = await body(req);
      const lap = b.lap === undefined || b.lap === null ? undefined : Number(b.lap);
      return json(tracks.recordRun(a.id, a.driver, id, b.finished === true, lap));
    }
    if (sub === "like" && (method === "POST" || method === "DELETE")) {
      const a = await needAuth();
      return json(tracks.like(a.id, id, method === "POST"));
    }
  }
  throw new ApiError(404, "ありません");
}
