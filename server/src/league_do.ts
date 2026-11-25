// リーグ戦の Durable Object (全員で 1 つ、SQLite)。中身は league.ts の LeagueStore。
// - cron (worker.ts の scheduled、2 時間ごと) が poke で起こす。自分でも次の枠のあとに alarm で起きる (cron の控え)
// - 1 回の alarm で 1 つだけ (1 レースの計算 か 日の締め) 進め、残りがあれば少しあけて次の alarm (無料の CPU の上限に合わせて小分け)
// - /api/league/... は worker.ts からここへ。ログインの確かめ・チームの様子・賞金・育ちはアカウントの DO に RPC で頼む
import { DurableObject } from "cloudflare:workers";
import type { AdminConfig, TeamRaceReport } from "@bpr/shared";
import type { AccountsDO } from "./accounts_do.ts";
import { handleLeagueApi, LeagueStore, type LeagueAccountsPort } from "./league.ts";
import { BETS_PATH, handleBetsApi } from "./bets_league.ts";
import type { SqlRunner } from "./accounts.ts";

export interface LeagueEnv {
  ACCOUNTS: DurableObjectNamespace<AccountsDO>;
  /** "1" のときだけ開発用の受け口 (/api/league/dev/...) を開ける。server/.dev.vars に書く (git に入れない)。本番では書かない */
  BPR_DEV?: string;
}

/** alarm がうまくいかなかったときの待ち (ms、仮) */
const ALARM_RETRY_MS = 60_000;

export class LeagueDO extends DurableObject<LeagueEnv> {
  private store: LeagueStore;
  private port: LeagueAccountsPort;
  private alarmAt: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: LeagueEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql as unknown as SqlRunner;
    const tx = <T,>(fn: () => T): T => ctx.storage.transactionSync(fn);
    const acc = () => env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
    this.port = {
      roster: () => acc().leagueRoster(),
      auth: (token) => acc().leagueAuth(token),
      teams: (ids) => acc().leagueTeams(ids),
      recordRace: async (raceId: string, report: TeamRaceReport, accountOf: Record<string, number>) => {
        await acc().recordTeamRace(raceId, report, accountOf, []);
      },
      payPrizes: async (id, items) => {
        await acc().payPrizes(id, items);
      },
      // 季節の係 (6a) の受け口: コンストラクターの分・その日の部・王者・週のはんこ。同じ dayKey は 1 回だけ
      constructorsDay: async (dayKey, delta, meta) => {
        await acc().addConstructorLeagueDay(dayKey, delta, meta);
      },
      adminConfig: async () => (await acc().adminConfig()) as unknown as AdminConfig,
      // ギフトコードの部の動き (日の締めのあとに当て、当てたものは送る箱から消してもらう)
      moves: () => acc().leagueMoves(),
      ackMoves: async (ids) => {
        await acc().ackLeagueMoves(ids);
      },
      // 賭け (bets_league.ts → アカウントの DO の bets.ts)
      settleBets: async (raceId, result) => {
        await acc().settleBets(raceId, result);
      },
      placeBet: async (input) => acc().placeBet(input),
      myBets: async (accountId) => acc().myBets(accountId),
    };
    this.store = new LeagueStore({ sql, tx }, this.port);
  }

  async fetch(req: Request): Promise<Response> {
    // 賭け (/api/bets/...): 倍率はここで、お金はアカウントの DO で
    if (BETS_PATH.test(new URL(req.url).pathname)) return handleBetsApi(req, this.store, this.port);
    const res = await handleLeagueApi(req, this.store, this.port, { dev: this.env.BPR_DEV === "1", onDevSlot: () => this.arm() });
    if (this.alarmAt === undefined) await this.arm();
    return res;
  }

  /** cron から: 新しい枠を積んで、計算を始める */
  async poke(now = Date.now()): Promise<{ slot: number | null; pending: number }> {
    let slot: number | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      slot = await this.store.poke(now);
    });
    await this.arm();
    return { slot, pending: this.store.pending() };
  }

  async alarm() {
    this.alarmAt = undefined;
    try {
      await this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        // 何も積んでいなければ、新しい枠が来ていないか見る (cron が来なかったときの控え)
        if (!this.store.pending()) await this.store.poke(now);
        await this.store.step(now);
      });
    } catch (e) {
      console.error("league alarm", (e as Error)?.message ?? e);
      await this.setAlarm(Date.now() + ALARM_RETRY_MS);
      return;
    }
    await this.arm();
  }

  /** チームの肩書き (チーム id = アカウントの番号の文字列 → 肩書き)。ほかの画面でチーム名の横に出す用 */
  async titles(teamIds: string[]): Promise<Record<string, string>> {
    return this.store.titles(teamIds.slice(0, 500));
  }

  private async arm() {
    await this.setAlarm(this.store.nextWake(Date.now()));
  }

  private async setAlarm(at: number) {
    if (at === this.alarmAt) return;
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }
}
