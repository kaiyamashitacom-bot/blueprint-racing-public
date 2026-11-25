// 練習の賞金 (shared/src/practiceprize.ts): POST /api/practice/lap で送られてきた練習の 1 周を 1 周アタックと同じ安い確かめで見て、
// 通った周ごとに AdminConfig.practicePrizePerLap を払う (1 日 = 日本時間で practicePrizeDailyLaps 周まで)。
// アカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。数は全部 (仮)。
import {
  checkPracticeLap,
  computeStats,
  decodeGhost,
  designHash,
  getTrack,
  isOfficialTrackId,
  jstDayStart,
  practiceLapPay,
  practicePrizeTrackOk,
  PRACTICE_SUBMIT_PER_HOUR,
  registerTrackDef,
  type AdminConfig,
  type TrackDef,
} from "@bpr/shared";
import { ApiError, parseDesign, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";

export const PRACTICE_PATH = /^\/api\/practice(\/|$)/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS practice_pay (
  account_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  laps INTEGER NOT NULL,
  paid INTEGER NOT NULL,
  last_ghost TEXT,
  PRIMARY KEY (account_id, day)
);
CREATE TABLE IF NOT EXISTS practice_rate (
  account_id INTEGER PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
`;

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
/** 残しておく日の数 (古い日の行は消す) */
const KEEP_DAYS = 3;
/** 受け取る本文の大きさの上限 (幽霊が入るので 1 周アタックと同じ 64 KB) */
const MAX_BODY = 64 * 1024;

export interface PracticeLapRes {
  /** この周の賞金 (上限を超えていれば 0) */
  earned: number;
  /** 今日あと何周 払うか */
  left: number;
  /** 払ったあとのお金 */
  money: number;
}

export interface PracticeDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
  config: () => Readonly<AdminConfig>;
  /** みんなのコースの形 (tracks.ts の publicDef)。なし = 公式のコースだけ */
  trackDef?: (id: string) => TrackDef | null;
}

export class PracticeStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  private now: () => number;
  private config: () => Readonly<AdminConfig>;
  private trackDef: (id: string) => TrackDef | null;

  constructor(deps: PracticeDeps) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    this.config = deps.config;
    this.trackDef = deps.trackDef ?? (() => null);
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray()[0];
  }

  /** 回数の制限 (1 時間ごと) */
  private hit(accountId: number, now: number) {
    const r = this.row("SELECT n, reset_at FROM practice_rate WHERE account_id = ?", accountId);
    if (!r || Number(r.reset_at) <= now) {
      this.sql.exec("INSERT OR REPLACE INTO practice_rate (account_id, n, reset_at) VALUES (?, 1, ?)", accountId, now + HOUR_MS);
      return;
    }
    if (Number(r.n) >= PRACTICE_SUBMIT_PER_HOUR) throw new ApiError(429, "送るのが多すぎます。しばらくしてからもう一度");
    this.sql.exec("UPDATE practice_rate SET n = n + 1 WHERE account_id = ?", accountId);
  }

  /** 今日 (日本時間) もう払った周の数 */
  paidToday(accountId: number, now = this.now()): number {
    const r = this.row("SELECT paid FROM practice_pay WHERE account_id = ? AND day = ?", accountId, jstDayStart(now));
    return r ? Number(r.paid) : 0;
  }

  /** 練習の 1 周を送る: { trackId, lap, ghost, design, designHash?, mt? }。確かめて、上限まで払う */
  submitLap(accountId: number, raw: Record<string, unknown>, accounts: AccountStore): PracticeLapRes {
    const now = this.now();
    const trackId = raw.trackId;
    if (!practicePrizeTrackOk(trackId)) throw new ApiError(400, "このコースの練習には賞金が出ません");
    if (!isOfficialTrackId(trackId)) {
      const def = this.trackDef(trackId);
      if (!def) throw new ApiError(400, "そのコースは見つかりません");
      registerTrackDef(def);
    }
    const design = parseDesign(raw.design);
    if (!design) throw new ApiError(400, "設計図が読めません");
    if (raw.designHash !== undefined && raw.designHash !== designHash(design)) throw new ApiError(400, "設計図の印が合いません");
    const ghost = typeof raw.ghost === "string" ? raw.ghost : "";
    const pts = decodeGhost(ghost);
    if (!pts) throw new ApiError(400, "幽霊が読めません");
    const lap = Number(raw.lap);
    const mt = raw.mt === true;
    const cfg = this.config();
    const track = getTrack(trackId);
    const stats = computeStats(design, cfg);
    return this.tx(() => {
      this.hit(accountId, now);
      const why = checkPracticeLap({ lap, pts, design, mt }, stats, track, accounts.inventory(accountId), cfg.manualSpeedBonus);
      if (why) throw new ApiError(400, why);
      const day = jstDayStart(now);
      this.sql.exec("DELETE FROM practice_pay WHERE day < ?", day - KEEP_DAYS * DAY_MS);
      const cur = this.row("SELECT laps, paid, last_ghost FROM practice_pay WHERE account_id = ? AND day = ?", accountId, day);
      // 同じ周を 2 回送っても 1 回だけ
      if (cur && String(cur.last_ghost ?? "") === ghost) throw new ApiError(409, "その周はもう送りました");
      const paid = cur ? Number(cur.paid) : 0;
      const pay = practiceLapPay(cfg, paid);
      this.sql.exec(
        "INSERT INTO practice_pay (account_id, day, laps, paid, last_ghost) VALUES (?, ?, 1, ?, ?) ON CONFLICT(account_id, day) DO UPDATE SET laps = laps + 1, paid = excluded.paid, last_ghost = excluded.last_ghost",
        accountId,
        day,
        paid + (pay.amount > 0 ? 1 : 0),
        ghost,
      );
      let money = Number(this.row("SELECT money FROM accounts WHERE id = ?", accountId)?.money ?? 0);
      if (pay.amount > 0) {
        const r = this.row("UPDATE accounts SET money = money + ? WHERE id = ? RETURNING money", pay.amount, accountId);
        if (!r) throw new ApiError(404, "アカウントがありません");
        this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", accountId, pay.amount, "練習の賞金", now);
        money = Number(r.money);
      }
      return { earned: pay.amount, left: pay.left, money };
    });
  }
}

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

/** POST /api/practice/lap  練習の 1 周を送る (ログインが要る) { trackId, lap, ghost, design, designHash?, mt? } → PracticeLapRes */
export async function handlePracticeApi(req: Request, path: string, method: string, accounts: AccountStore, practice: PracticeStore): Promise<Response> {
  try {
    if (path === "/api/practice/lap" && method.toUpperCase() === "POST") {
      const a = await accounts.auth(bearer(req));
      if (!a) throw new ApiError(401, "ログインしてください");
      const text = await req.text();
      if (text.length > MAX_BODY) throw new ApiError(413, "送るものが大きすぎます");
      let b: unknown;
      try {
        b = JSON.parse(text || "{}");
      } catch {
        b = null;
      }
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError(400, "送られてきたものが読めません");
      return json(practice.submitLap(a.id, b as Record<string, unknown>, accounts));
    }
    throw new ApiError(404, "ありません");
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("practice api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}
