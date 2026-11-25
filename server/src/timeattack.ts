// 1 周アタックの保存 (SQLite) と /api/ta/... の受け口。アカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。
// 週ごと・人ごとに一番速い周だけ (と、その幽霊) を残す。設計図は確かめるだけで残さない (印だけ)。ほかの人には幽霊の線だけ見せる。
// 確かめは shared/src/timeattack.ts (コースと幽霊の点を 1 回なめるだけ。長い計算はしない)。
import {
  TA_CONDITIONS,
  TA_GHOSTS_MAX,
  TA_SUBMIT_PER_HOUR,
  TA_TOP_N,
  DEFAULT_MANUAL_BONUS,
  checkTaSubmission,
  computeStats,
  decodeGhost,
  designHash,
  getTrack,
  rankTa,
  taAcceptsWeek,
  taImproves,
  taLapMs,
  taRankOf,
  taWeek,
  taWeekAt,
  type PartStrength,
  type TaWeek,
} from "@bpr/shared";
import { ApiError, parseDesign, type Account, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";
import { PRIZE_ITEMS } from "@bpr/shared";
import { grantItems } from "./items.ts";

/** 週の 1 位の景品を見る 締め切った週の数 (さかのぼる数。仮) */
export const TA_AWARD_LOOKBACK = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ta_best (
  week INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  lap_ms INTEGER NOT NULL,
  ghost TEXT,
  design_hash TEXT NOT NULL,
  driver TEXT NOT NULL,
  team TEXT NOT NULL,
  at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (week, account_id)
);
CREATE INDEX IF NOT EXISTS ta_best_rank ON ta_best(week, lap_ms, at);
CREATE TABLE IF NOT EXISTS ta_awards (
  week INTEGER PRIMARY KEY,
  account_id INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ta_rate (
  account_id INTEGER PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
`;

const HOUR_MS = 3600_000;

/** 画面に返す形 (web/src/ta_api.ts と合わせる) */
export interface TaRow {
  rank: number;
  driver: string;
  team: string;
  /** 秒 */
  lap: number;
  me: boolean;
  /** マニュアル (自分で変速) の記録 (11/25 足した。前の記録とオートマは false) */
  mt: boolean;
}

export interface TaBoardRes {
  week: TaWeek;
  now: number;
  conditions: typeof TA_CONDITIONS;
  top: TaRow[];
  me: { rank: number; lap: number } | null;
  total: number;
}

export interface TaGhostRow extends TaRow {
  /** 小さくした幽霊 (shared の decodeGhost で戻す) */
  ghost: string;
}

export interface TaSubmitRes {
  improved: boolean;
  /** 走行点 (確かめの通った周ごと / 記録更新。1 日の上限あり)。入らない設定なら無し */
  rp?: { earned: number; left: number; points: number };
  /** 今の自分の記録 */
  best: { rank: number; lap: number };
  total: number;
}

export interface TaDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
  /** マニュアルの速さの上がり分 (AdminConfig.manualSpeedBonus。なし = はじめの値) */
  mtBonus?: () => number;
  /** 部品の強さの倍率 (AdminConfig をそのまま。なし = 全部 1)。下限と速さの上限がこの倍率の性能で決まる */
  strength?: () => Readonly<PartStrength> | null;
  /** 走行点を入れる (racepoints.ts の earnTaLap。同じ取りまとめの中で呼ぶ。なし = 入れない) */
  earn?: (accountId: number, improved: boolean, at: number) => { earned: number; left: number; points: number } | null;
}

export class TaStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  private now: () => number;
  private mtBonus: () => number;
  private earn?: TaDeps["earn"];
  private strength: () => Readonly<PartStrength> | null;

  constructor(deps: TaDeps) {
    this.earn = deps.earn;
    this.strength = deps.strength ?? (() => null);
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    this.mtBonus = deps.mtBonus ?? (() => DEFAULT_MANUAL_BONUS);
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
    // 11/25 足した列: マニュアルの記録 (前の表には無いので足す。前の記録は 0 = オートマ)
    const cols = this.rows("PRAGMA table_info(ta_best)").map((r) => String(r.name));
    if (!cols.includes("mt")) this.sql.exec("ALTER TABLE ta_best ADD COLUMN mt INTEGER NOT NULL DEFAULT 0");
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  /**
   * 締め切った週 (受け付けが終わった週) の 1 位に 限界突破の品 (DECISIONS 11/25)。同じ週は 1 回だけ (ta_awards)。
   * 順位表・送るとき・alarm で呼ぶ (何度呼んでもよい)。品を入れた週の数を返す
   */
  awardDue(now = this.now()): number {
    const cur = taWeekAt(now).index;
    let n = 0;
    for (let w = cur - TA_AWARD_LOOKBACK; w < cur; w++) {
      if (w < 0 || taAcceptsWeek(w, now)) continue;
      if (this.row("SELECT week FROM ta_awards WHERE week = ?", w)) continue;
      this.tx(() => {
        if (this.row("SELECT week FROM ta_awards WHERE week = ?", w)) return;
        const top = this.row("SELECT account_id FROM ta_best WHERE week = ? ORDER BY lap_ms, at LIMIT 1", w);
        const accountId = top ? Number(top.account_id) : null;
        this.sql.exec("INSERT INTO ta_awards (week, account_id, at) VALUES (?, ?, ?)", w, accountId, now);
        if (accountId !== null) {
          const p = PRIZE_ITEMS.timeAttackWeek;
          grantItems(this.sql, accountId, { [p.item]: p.count }, { id: `prize:ta:${w}`, title: "限界突破の品", why: `1 周アタック「${taWeek(w).trackName}」の週の 1 位`, at: now });
          n++;
        }
      });
    }
    return n;
  }

  currentWeek(): TaWeek {
    return taWeekAt(this.now());
  }

  private myBest(week: number, accountId: number): { lapMs: number; at: number } | null {
    const r = this.row("SELECT lap_ms, at FROM ta_best WHERE week = ? AND account_id = ?", week, accountId);
    return r ? { lapMs: Number(r.lap_ms), at: Number(r.at) } : null;
  }

  private rankOf(week: number, lapMs: number): number {
    const r = this.row("SELECT COUNT(*) AS c FROM ta_best WHERE week = ? AND lap_ms < ?", week, lapMs);
    return taRankOf(Number(r?.c ?? 0));
  }

  private total(week: number): number {
    return Number(this.row("SELECT COUNT(*) AS c FROM ta_best WHERE week = ?", week)?.c ?? 0);
  }

  /** 順位表: 上から n 人と、自分の順位 */
  board(weekIndex: number, accountId: number | null, n = TA_TOP_N): TaBoardRes {
    const lim = Math.max(1, Math.min(TA_TOP_N * 5, Math.floor(n)));
    const list = this.rows("SELECT account_id, lap_ms, at, driver, team, mt FROM ta_best WHERE week = ? ORDER BY lap_ms, at LIMIT ?", weekIndex, lim).map((r) => ({
      accountId: Number(r.account_id),
      lapMs: Number(r.lap_ms),
      at: Number(r.at),
      driver: String(r.driver),
      team: String(r.team),
      mt: Number(r.mt) === 1,
    }));
    // 同じタイムは同じ順位 (一覧は上から取っているので、表の中の順位がそのまま全体の順位)
    const top: TaRow[] = rankTa(list).map((e) => ({ rank: e.rank, driver: e.driver, team: e.team, lap: e.lapMs / 1000, me: e.accountId === accountId, mt: e.mt }));
    const mine = accountId === null ? null : this.myBest(weekIndex, accountId);
    return {
      week: taWeek(weekIndex),
      now: this.now(),
      conditions: TA_CONDITIONS,
      top,
      me: mine ? { rank: this.rankOf(weekIndex, mine.lapMs), lap: mine.lapMs / 1000 } : null,
      total: this.total(weekIndex),
    };
  }

  /** 上位の幽霊 (線だけ。設計図は返さない)。ログインしていれば自分の幽霊も (上位に入っていなくても) */
  ghosts(weekIndex: number, accountId: number | null, n = 3): TaGhostRow[] {
    const lim = Math.max(1, Math.min(TA_GHOSTS_MAX, Math.floor(n)));
    const list = this.rows(
      "SELECT account_id, lap_ms, at, driver, team, ghost, mt FROM ta_best WHERE week = ? AND ghost IS NOT NULL ORDER BY lap_ms, at LIMIT ?",
      weekIndex,
      lim,
    );
    const out: TaGhostRow[] = list.map((r) => ({
      rank: this.rankOf(weekIndex, Number(r.lap_ms)),
      driver: String(r.driver),
      team: String(r.team),
      lap: Number(r.lap_ms) / 1000,
      me: Number(r.account_id) === accountId,
      mt: Number(r.mt) === 1,
      ghost: String(r.ghost),
    }));
    if (accountId !== null && !out.some((g) => g.me)) {
      const r = this.row("SELECT lap_ms, driver, team, ghost, mt FROM ta_best WHERE week = ? AND account_id = ? AND ghost IS NOT NULL", weekIndex, accountId);
      if (r) out.push({ rank: this.rankOf(weekIndex, Number(r.lap_ms)), driver: String(r.driver), team: String(r.team), lap: Number(r.lap_ms) / 1000, me: true, mt: Number(r.mt) === 1, ghost: String(r.ghost) });
    }
    return out;
  }

  /** 回数の制限 (1 時間ごと) */
  private hit(accountId: number) {
    const now = this.now();
    const r = this.row("SELECT n, reset_at FROM ta_rate WHERE account_id = ?", accountId);
    if (!r || Number(r.reset_at) <= now) {
      this.sql.exec("INSERT OR REPLACE INTO ta_rate (account_id, n, reset_at) VALUES (?, 1, ?)", accountId, now + HOUR_MS);
      return;
    }
    if (Number(r.n) >= TA_SUBMIT_PER_HOUR) throw new ApiError(429, "送るのが多すぎます。しばらくしてからもう一度");
    this.sql.exec("UPDATE ta_rate SET n = n + 1 WHERE account_id = ?", accountId);
  }

  /**
   * 1 周を送る。確かめて、その週の自分の記録より速ければ入れかえる (幽霊も)。
   * inventory は持ち物 (持っていない部品の車は断る)
   */
  submit(acc: Account, raw: Record<string, unknown>, accounts: AccountStore): TaSubmitRes {
    const now = this.now();
    const weekIndex = Number(raw.week);
    if (!Number.isInteger(weekIndex) || !taAcceptsWeek(weekIndex, now)) throw new ApiError(400, "今週のコースではありません");
    const design = parseDesign(raw.design);
    if (!design) throw new ApiError(400, "設計図が読めません");
    const hash = designHash(design);
    if (raw.designHash !== undefined && raw.designHash !== hash) throw new ApiError(400, "設計図の印が合いません");
    const ghostStr = raw.ghost;
    const pts = decodeGhost(ghostStr);
    if (!pts) throw new ApiError(400, "幽霊が読めません");
    const lap = Number(raw.lap);
    // マニュアル (自分で変速) の周: 速さの上限を上がり分だけゆるめ、記録に印を付ける
    const mt = raw.mt === true;
    const track = getTrack(taWeek(weekIndex).trackId);
    const stats = computeStats(design, this.strength());
    return this.tx(() => {
      this.hit(acc.id);
      const why = checkTaSubmission({ lap, pts, design, mt }, stats, track, accounts.inventory(acc.id), this.mtBonus());
      if (why) throw new ApiError(400, why);
      const lapMs = taLapMs(lap);
      const prev = this.myBest(weekIndex, acc.id);
      const improved = taImproves(lap, prev?.lapMs);
      if (!prev) {
        this.sql.exec(
          "INSERT INTO ta_best (week, account_id, lap_ms, ghost, design_hash, driver, team, at, tries, mt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
          weekIndex,
          acc.id,
          lapMs,
          String(ghostStr),
          hash,
          acc.driver,
          acc.team,
          now,
          mt ? 1 : 0,
        );
      } else if (improved) {
        this.sql.exec(
          "UPDATE ta_best SET lap_ms = ?, ghost = ?, design_hash = ?, driver = ?, team = ?, at = ?, mt = ?, tries = tries + 1 WHERE week = ? AND account_id = ?",
          lapMs,
          String(ghostStr),
          hash,
          acc.driver,
          acc.team,
          now,
          mt ? 1 : 0,
          weekIndex,
          acc.id,
        );
      } else {
        this.sql.exec("UPDATE ta_best SET tries = tries + 1 WHERE week = ? AND account_id = ?", weekIndex, acc.id);
      }
      const bestMs = improved ? lapMs : prev!.lapMs;
      const rp = this.earn?.(acc.id, improved, now) ?? null;
      return {
        improved,
        best: { rank: this.rankOf(weekIndex, bestMs), lap: bestMs / 1000 },
        total: this.total(weekIndex),
        ...(rp ? { rp: { earned: rp.earned, left: rp.left, points: rp.points } } : {}),
      };
    });
  }

  /**
   * 退会したとき: 今の週 (と、受付中の前の週) の記録は消す。
   * 終わった週は 名前だけ残して幽霊は消す (DECISIONS「歴代の記録の名前だけ残る」)
   */
  forgetAccount(accountId: number): void {
    const cur = this.currentWeek().index;
    this.tx(() => {
      this.sql.exec("DELETE FROM ta_best WHERE account_id = ? AND week >= ?", accountId, cur - 1);
      this.sql.exec("UPDATE ta_best SET ghost = NULL WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM ta_rate WHERE account_id = ?", accountId);
    });
  }
}

// ---------------------------------------------------------------- /api/ta/...

/** 受け取る本文の大きさの上限 (幽霊が入るので api.ts と同じ 64 KB) */
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

/**
 * GET  /api/ta/board?week=&n=   今週 (か、終わった週) のコースと順位表。ログインしていれば自分の順位も
 * GET  /api/ta/ghosts?n=        今週の上位の幽霊 (線だけ)。ログインしていれば自分の幽霊も
 * POST /api/ta/submit           1 周を送る (ログインが要る) { week, lap, ghost, design, designHash, mt? }
 * 投げた ApiError は api.ts の handleApi が受けて返す
 */
export async function handleTa(req: Request, path: string, method: string, accounts: AccountStore, ta: TaStore): Promise<Response> {
  const url = new URL(req.url);
  const who = async () => (await accounts.auth(bearer(req)))?.id ?? null;
  const cur = ta.currentWeek().index;
  try {
    ta.awardDue();
  } catch (e) {
    console.error("ta award", (e as Error)?.message ?? e);
  }

  if (path === "/api/ta/board" && method === "GET") {
    const w = url.searchParams.get("week");
    const week = w === null || w === "" ? cur : Number(w);
    if (!Number.isInteger(week) || week > cur || week < cur - 520) throw new ApiError(400, "その週はありません");
    const n = Number(url.searchParams.get("n") ?? TA_TOP_N);
    return json(ta.board(week, await who(), Number.isFinite(n) ? n : TA_TOP_N));
  }
  if (path === "/api/ta/ghosts" && method === "GET") {
    const n = Number(url.searchParams.get("n") ?? 3);
    return json({ week: cur, ghosts: ta.ghosts(cur, await who(), Number.isFinite(n) ? n : 3) });
  }
  if (path === "/api/ta/submit" && method === "POST") {
    const acc = await accounts.auth(bearer(req));
    if (!acc) throw new ApiError(401, "ログインしてください");
    const b = await body(req);
    return json(ta.submit(acc, b, accounts));
  }
  throw new ApiError(404, "ありません");
}
