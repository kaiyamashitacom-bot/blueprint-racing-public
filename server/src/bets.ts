// 賭け (DECISIONS 11/25「レースの結果に賭ける」) の保存と払い。お金のあるアカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。
// - 賭けられるのはゲームの中のお金 (accounts.money) だけ。部品・品物・ほかの物は賭けられない (受け口も stake = お金の額しか受けない)
// - 本物のお金を入れたら AdminConfig.realMoneyEnabled を入に。入の間は賭けを受けない (betBlockedReason。見直しと法律の確かめが済むまで)
// - 賭けた時の倍率を賭けと一緒に残す。賭けた額はすぐ引き (wallet_log "bet")、当たれば払う ("bet_win")、返すときは "bet_refund"
// - 倍率・自分のチームのレースか・締め切りはリーグの DO (bets_league.ts) が先に見るが、ここでももう一度確かめる (お金を動かすのはここだけ)
// - 結果はリーグの DO から送る箱 (outbox) で来る (settle)。同じレースは 1 回だけ。1 つの取りまとめ (transaction) で全部払う
// - 計算できなかったレース・来なかったレース (refundAfterMs 過ぎ)・選んだ車やチームが走らなかった賭けは返す
// 数は全部 (仮)。
import {
  BET,
  betBlockedReason,
  betClosesAt,
  betLimitsOf,
  betOutcome,
  betPayout,
  checkBetStake,
  leagueDayAt,
  leagueDayStart,
  type AdminConfig,
  type BetKind,
  type BetOutcome,
  type BetPick,
  type BetResultCar,
} from "@bpr/shared";
import { ApiError, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";

export const BETS_ADMIN_PATH = /^\/api\/admin\/bets(\/|$)/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  race_label TEXT NOT NULL,
  teams TEXT NOT NULL,
  kind TEXT NOT NULL,
  pick TEXT NOT NULL,
  label TEXT NOT NULL,
  stake INTEGER NOT NULL,
  odds REAL NOT NULL,
  prob REAL NOT NULL,
  status TEXT NOT NULL,
  payout INTEGER NOT NULL DEFAULT 0,
  placed_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS bets_race ON bets(race_id, status);
CREATE INDEX IF NOT EXISTS bets_account ON bets(account_id, placed_at);
CREATE INDEX IF NOT EXISTS bets_open ON bets(status, starts_at);
CREATE TABLE IF NOT EXISTS bets_settled (
  race_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  computed INTEGER NOT NULL
);
`;

export type BetStatus = "open" | BetOutcome;

/** リーグの DO が送ってくる 1 つの賭け (倍率はリーグの DO が今の表から出したもの) */
export interface PlaceBetInput {
  accountId: number;
  raceId: string;
  startsAt: number;
  /** 画面に出す名前 (「8 部 · 14:00 · 鈴鹿」など) */
  raceLabel: string;
  /** そのレースに出るチーム (自分のチームが入っていれば断る) */
  teams: string[];
  kind: BetKind;
  pick: BetPick;
  /** 画面に出す選んだ物 (「1 着: 運転手 (チーム)」など) */
  label: string;
  /** 賭ける額 (ゲームの中のお金だけ) */
  stake: number;
  odds: number;
  prob: number;
  /** 締め切りの時刻 (この DO の時計で)。なし = スタートの betCloseMinutes 分前 (リーグ戦)。大会の優勝はスタートちょうど (bets_tour.ts) */
  closesAt?: number;
}

/** 画面に返す 1 つの賭け (ほかのチームの id は返さない) */
export interface BetView {
  id: number;
  raceId: string;
  startsAt: number;
  race: string;
  kind: BetKind;
  label: string;
  stake: number;
  odds: number;
  status: BetStatus;
  payout: number;
  placedAt: number;
  settledAt: number | null;
}

export interface BetDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
  config: () => AdminConfig;
}

export class BetStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  private now: () => number;
  private config: () => AdminConfig;

  constructor(
    deps: BetDeps,
    private accounts: AccountStore,
  ) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    this.config = deps.config;
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  /** 今日 (日本時間) もう賭けた額 (返した賭けは数えない) */
  private todayStaked(accountId: number, now: number): number {
    const from = leagueDayStart(leagueDayAt(now));
    const r = this.row("SELECT COALESCE(SUM(stake), 0) AS s FROM bets WHERE account_id = ? AND placed_at >= ? AND status != 'void'", accountId, from);
    return Number(r?.s ?? 0);
  }

  /** 賭ける。お金を引き、賭けを残す (1 つの取りまとめ)。返すのは賭けと残りのお金 */
  place(input: PlaceBetInput): { bet: BetView; money: number } {
    const cfg = this.config();
    // 本物のお金を入れたとき (realMoneyEnabled) と一時停止は、何より先に断る
    const blocked = betBlockedReason(cfg);
    if (blocked) throw new ApiError(503, blocked);
    const now = this.now();
    const closesAt = input.closesAt !== undefined ? Math.min(input.closesAt, input.startsAt) : betClosesAt(input.startsAt, cfg.betCloseMinutes);
    if (!Number.isFinite(input.startsAt) || !Number.isFinite(closesAt) || now >= closesAt) throw new ApiError(409, "このレースはもう締め切りました");
    if (input.teams.includes(String(input.accountId))) throw new ApiError(403, "自分のチームが出るレースには賭けられません");
    if (!(Number.isFinite(input.odds) && input.odds >= BET.minOdds && input.odds <= BET.maxOdds)) throw new ApiError(409, "この賭けは今は受けていません");
    return this.tx(() => {
      if (this.row("SELECT race_id FROM bets_settled WHERE race_id = ?", input.raceId)) throw new ApiError(409, "このレースはもう締め切りました");
      const acc = this.accounts.getAccount(input.accountId);
      if (!acc) throw new ApiError(401, "ログインしてください");
      const open = Number(this.row("SELECT COUNT(*) AS n FROM bets WHERE account_id = ? AND status = 'open'", acc.id)?.n ?? 0);
      if (open >= BET.maxOpen) throw new ApiError(429, `結果待ちの賭けは ${BET.maxOpen} 個までです`);
      const why = checkBetStake(input.stake, acc.money, this.todayStaked(acc.id, now), betLimitsOf(cfg));
      if (why) throw new ApiError(400, why);
      const stake = input.stake;
      const r = this.row("UPDATE accounts SET money = money - ? WHERE id = ? AND money >= ? RETURNING money", stake, acc.id, stake);
      if (!r) throw new ApiError(400, "お金が足りません");
      this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", acc.id, -stake, "bet", now);
      const ins = this.row(
        "INSERT INTO bets (account_id, race_id, starts_at, race_label, teams, kind, pick, label, stake, odds, prob, status, payout, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?) RETURNING id",
        acc.id,
        input.raceId.slice(0, 80),
        input.startsAt,
        input.raceLabel.slice(0, 80),
        JSON.stringify(input.teams.slice(0, 8)),
        input.kind,
        JSON.stringify(input.pick),
        input.label.slice(0, 120),
        stake,
        input.odds,
        input.prob,
        now,
      );
      const bet = this.view(this.row("SELECT * FROM bets WHERE id = ?", Number(ins!.id))!);
      return { bet, money: Number(r.money) };
    });
  }

  /**
   * レースの結果で払う (リーグの DO の送る箱から。同じレースは 1 回だけ)。result が null = 計算できなかった → 全部返す。
   * 1 つの取りまとめで: 賭けの結果・お金・wallet_log ("bet_win" / "bet_refund")
   */
  settle(raceId: string, result: readonly BetResultCar[] | null): { bets: number; won: number; paid: number; refunded: number } {
    const now = this.now();
    return this.tx(() => {
      const out = { bets: 0, won: 0, paid: 0, refunded: 0 };
      if (this.row("SELECT race_id FROM bets_settled WHERE race_id = ?", raceId)) return out;
      this.sql.exec("INSERT INTO bets_settled (race_id, at, computed) VALUES (?, ?, ?)", raceId, now, result ? 1 : 0);
      for (const b of this.rows("SELECT id, account_id, kind, pick, stake, odds FROM bets WHERE race_id = ? AND status = 'open'", raceId)) {
        const outcome = betOutcome(String(b.kind) as BetKind, JSON.parse(String(b.pick)) as BetPick, result);
        this.closeBet(b, outcome, now, out);
      }
      return out;
    });
  }

  private closeBet(b: Record<string, SqlValue>, outcome: BetOutcome, now: number, out: { bets: number; won: number; paid: number; refunded: number }) {
    const stake = Number(b.stake);
    const pay = outcome === "won" ? betPayout(stake, Number(b.odds)) : outcome === "void" ? stake : 0;
    this.sql.exec("UPDATE bets SET status = ?, payout = ?, settled_at = ? WHERE id = ?", outcome, pay, now, Number(b.id));
    out.bets++;
    if (outcome === "won") out.won++;
    if (pay > 0) {
      const r = this.row("UPDATE accounts SET money = money + ? WHERE id = ? RETURNING money", pay, Number(b.account_id));
      // 退会した人には払わない (賭けの行は記録として残る。forgetAccount で消える)
      if (r) this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", Number(b.account_id), pay, outcome === "won" ? "bet_win" : "bet_refund", now);
      if (outcome === "won") out.paid += pay;
      else out.refunded += pay;
    }
  }

  /** この DO の賭けの時計 (本当の時刻。大会の時計とずれていることがある: bets_tour.ts) */
  clock(): number {
    return this.now();
  }

  /** 結果待ちの賭けのあるレース (race_id が prefix で始まるもの。大会の優勝は "tour:") */
  openRaces(prefix: string): string[] {
    return this.rows("SELECT DISTINCT race_id FROM bets WHERE status = 'open' AND substr(race_id, 1, ?) = ?", prefix.length, prefix).map((r) => String(r.race_id));
  }

  /** レースの時刻から refundAfterMs 過ぎても結果の来ない賭けを返す (人のいなくなったリーグなど、レースが組まれなかった) */
  sweep(): number {
    const now = this.now();
    // 退会した人の賭けを消す (退会はお金ごと消える。api.ts の退会からは呼ばれないのでここで)
    this.sql.exec("DELETE FROM bets WHERE account_id NOT IN (SELECT id FROM accounts)");
    const stale = this.rows("SELECT DISTINCT race_id FROM bets WHERE status = 'open' AND starts_at < ?", now - BET.refundAfterMs);
    let n = 0;
    for (const r of stale) n += this.settle(String(r.race_id), null).bets;
    return n;
  }

  private view(r: Record<string, SqlValue>): BetView {
    return {
      id: Number(r.id),
      raceId: String(r.race_id),
      startsAt: Number(r.starts_at),
      race: String(r.race_label),
      kind: String(r.kind) as BetKind,
      label: String(r.label),
      stake: Number(r.stake),
      odds: Number(r.odds),
      status: String(r.status) as BetStatus,
      payout: Number(r.payout),
      placedAt: Number(r.placed_at),
      settledAt: r.settled_at === null ? null : Number(r.settled_at),
    };
  }

  /** 自分の賭け: 結果待ち・記録 (新しい順)・今日賭けた額・今の上限 */
  mine(accountId: number) {
    this.sweep();
    const now = this.now();
    const cfg = this.config();
    const open = this.rows("SELECT * FROM bets WHERE account_id = ? AND status = 'open' ORDER BY starts_at, id", accountId).map((r) => this.view(r));
    const history = this.rows("SELECT * FROM bets WHERE account_id = ? AND status != 'open' ORDER BY settled_at DESC, id DESC LIMIT ?", accountId, BET.historyMax).map((r) => this.view(r));
    const sum = this.row(
      "SELECT COUNT(*) AS n, COALESCE(SUM(stake), 0) AS staked, COALESCE(SUM(payout), 0) AS back FROM bets WHERE account_id = ? AND status IN ('won', 'lost')",
      accountId,
    );
    return {
      open,
      history,
      todayStaked: this.todayStaked(accountId, now),
      totals: { bets: Number(sum?.n ?? 0), staked: Number(sum?.staked ?? 0), back: Number(sum?.back ?? 0) },
      limits: betLimitsOf(cfg),
      blocked: betBlockedReason(cfg),
    };
  }

  /** 管理者の画面: 賭けの量と胴元の取り分 (全部と今日)。void (返した賭け) は数えない */
  stats() {
    const now = this.now();
    const from = leagueDayStart(leagueDayAt(now));
    const sum = (where: string, ...b: SqlValue[]) => {
      const r = this.row(
        `SELECT COUNT(*) AS n, COALESCE(SUM(stake), 0) AS staked, COALESCE(SUM(payout), 0) AS paid, COALESCE(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END), 0) AS won FROM bets WHERE status IN ('won', 'lost') ${where}`,
        ...b,
      );
      const staked = Number(r?.staked ?? 0);
      const paid = Number(r?.paid ?? 0);
      return { bets: Number(r?.n ?? 0), won: Number(r?.won ?? 0), staked, paid, houseTake: staked - paid };
    };
    const open = this.row("SELECT COUNT(*) AS n, COALESCE(SUM(stake), 0) AS staked FROM bets WHERE status = 'open'");
    const refunded = this.row("SELECT COUNT(*) AS n, COALESCE(SUM(stake), 0) AS staked FROM bets WHERE status = 'void'");
    const players = this.row("SELECT COUNT(DISTINCT account_id) AS n FROM bets");
    const cfg = this.config();
    return {
      all: sum(""),
      today: sum("AND settled_at >= ?", from),
      open: { bets: Number(open?.n ?? 0), staked: Number(open?.staked ?? 0) },
      refunded: { bets: Number(refunded?.n ?? 0), staked: Number(refunded?.staked ?? 0) },
      players: Number(players?.n ?? 0),
      paused: cfg.betPaused,
      realMoneyEnabled: cfg.realMoneyEnabled,
      margin: cfg.betMargin,
    };
  }

  /** 退会: その人の賭けを消す (結果待ちの賭けのお金は、アカウントと一緒に無くなる) */
  forgetAccount(accountId: number) {
    this.sql.exec("DELETE FROM bets WHERE account_id = ?", accountId);
  }
}

// ---------------------------------------------------------------- /api/admin/bets

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

/**
 * GET /api/admin/bets         賭けの量と胴元の取り分 (全部・今日)・結果待ち・返した額・一時停止か
 * PUT /api/admin/bets { paused }  一時停止の入・切 (管理者の数 betPaused を変える。変更の記録に残る)
 * 管理者だけ (ほかは 403)
 */
export async function handleBetsAdminApi(
  req: Request,
  path: string,
  method: string,
  accounts: AccountStore,
  bets: BetStore,
  setPaused: (paused: boolean, by: { id: number; login: string }) => void,
): Promise<Response> {
  try {
    const M = method.toUpperCase();
    const a = await accounts.auth(bearer(req));
    if (!a) throw new ApiError(401, "ログインしてください");
    if (!accounts.isAdmin(a)) throw new ApiError(403, "管理者だけができます");
    if (path === "/api/admin/bets" && M === "GET") return json(bets.stats());
    if (path === "/api/admin/bets" && M === "PUT") {
      const text = await req.text();
      if (text.length > 1024) throw new ApiError(413, "送るものが大きすぎます");
      let b: Record<string, unknown> = {};
      try {
        b = JSON.parse(text || "{}") as Record<string, unknown>;
      } catch {
        throw new ApiError(400, "送られてきたものが読めません");
      }
      if (typeof b.paused !== "boolean") throw new ApiError(400, "paused は true か false にしてください");
      setPaused(b.paused, { id: a.id, login: a.login });
      return json(bets.stats());
    }
    throw new ApiError(404, "ありません");
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("bets admin api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}
