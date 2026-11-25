// 大会の優勝に賭ける (11/25)。受け口 /api/tourbets/... はアカウントの DO の中 (大会 season.ts と お金 bets.ts が同じ DO にある)。
// 決まりは shared/src/betting.ts の「大会の優勝に賭ける」:
// - 賭けられるのは A 組 (優勝を決める組) の車だけ。組が決まってから (スタートの LOBBY_LEAD_MS 前) スタートまで
// - 自分のチームの車が A 組にいる大会には賭けられない (全員参加の毎日の大会でも、A 組の外のチームは賭けられる)
// - 倍率は 予選の記録 と 強さの見込み (tourgrid.ts の estimatedLap) から。賭けた時の倍率のまま
// - 大会が決まったら払う (season.ts の finalizeTournament → onTournamentClosed)。取りやめ・A 組の結果が無い大会は返す
// - お金・上限・一時停止・本物のお金の止めは リーグ戦の賭けと同じ (bets.ts の place と betBlockedReason、管理者の数)
// 賭けの行は リーグ戦と同じ表 (bets)。race_id = "tour:<大会の id>"。数は全部 (仮)。
import {
  BET_KIND_NAMES,
  STAND_IN_SKILL,
  TRACK_DEFS,
  betBlockedReason,
  driverTraits,
  estimatedLap,
  tourBetBook,
  tourBetResult,
  type AdminConfig,
  type TourBetCar,
  type TourBookCar,
} from "@bpr/shared";
import { ApiError, type AccountStore } from "./accounts.ts";
import type { BetStore } from "./bets.ts";
import { LOBBY_LEAD_MS, type SeasonStore, type TourRow } from "./season.ts";

export const TOUR_BETS_PATH = /^\/api\/tourbets(\/|$)/;
export const TOUR_BET_PREFIX = "tour:";
export const tourBetRaceId = (tourId: string) => `${TOUR_BET_PREFIX}${tourId}`;

/** 送ってよい項目 (これ以外 = お金のほかの物を賭けようとした → 断る) */
const PLACE_KEYS = new Set(["tourId", "car", "stake", "odds"]);
const MAX_BODY = 2 * 1024;

export interface TourBookView {
  tourId: string;
  name: string;
  trackName: string;
  laps: number;
  startsAt: number;
  /** 締め切り = スタート */
  closesAt: number;
  open: boolean;
  /** 自分のチームの車が A 組にいる (賭けられない) */
  mine: boolean;
  group: string;
  cars: Array<{ car: string; driver: string; team: string; grid: number; qualiLap: number | null; estLap: number | null; pWin: number; odds: number | null }>;
}

interface TourBook {
  t: TourRow;
  teams: string[];
  cars: Array<TourBookCar & { slot: number; name: string; team: string; qualiLap: number | null; estLap: number | null }>;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** 1 大会の倍率の表 (A 組の車)。組が決まっていない・A 組が 2 台に届かなければ null */
export function tourBook(t: TourRow, margin: number): TourBook | null {
  const g = t.groups?.[0];
  if (t.status !== "running" || !g || g.cars.length < 2) return null;
  const fixed = t.fields?.[0]?.cars ?? [];
  const cars: TourBetCar[] = [];
  const extra: Array<{ slot: number; name: string; team: string; qualiLap: number | null; estLap: number | null }> = [];
  for (const c of [...g.cars].sort((a, b) => a.slot - b.slot)) {
    let est: number | null = null;
    if (c.lapTime === null) {
      // 予選の記録の無い車: 強さの見込み (組を作ったときと同じ。人の車は代走の上手さ、2 台目は雇った運転手の上手さ)
      const f = fixed.find((x) => x.driverId === c.driverId);
      if (f) {
        const skill = f.driver ? driverTraits(f.driver).skill : STAND_IN_SKILL;
        const v = estimatedLap(f.design, t.spec.trackId, skill);
        est = Number.isFinite(v) ? v : null;
      }
    }
    cars.push({ key: c.driverId, team: c.teamId, lap: c.lapTime ?? est, grid: c.slot });
    extra.push({ slot: c.slot, name: c.name, team: c.team, qualiLap: c.lapTime, estLap: est });
  }
  const book = tourBetBook(cars, margin);
  if (!book.length) return null;
  return { t, teams: [...new Set(g.cars.map((c) => c.teamId))], cars: book.map((b, i) => ({ ...b, ...extra[i] })) };
}

function view(b: TourBook, myTeam: string, now: number): TourBookView {
  const s = b.t.spec;
  return {
    tourId: s.id,
    name: s.name,
    trackName: TRACK_DEFS.find((d) => d.id === s.trackId)?.name ?? s.trackId,
    laps: s.laps,
    startsAt: s.startsAt,
    closesAt: s.startsAt,
    open: now < s.startsAt,
    mine: b.teams.includes(myTeam),
    group: b.t.groups?.[0]?.letter ?? "A",
    cars: b.cars.map((c) => ({
      car: String(c.slot),
      driver: c.name,
      team: c.team,
      grid: c.grid + 1,
      qualiLap: c.qualiLap,
      estLap: c.estLap === null ? null : round3(c.estLap),
      pWin: round3(c.pWin),
      odds: c.odds,
    })),
  };
}

/** 大会が決まった・取りやめた → その大会の賭けを払う・返す (まだ決まっていなければ何もしない)。大会が無くなっていたら返す */
export function settleTourBets(season: SeasonStore, bets: BetStore, tourId: string): number {
  const t = season.tourForBets(tourId);
  if (t && t.status !== "done" && t.status !== "cancelled") return 0;
  const result = t ? tourBetResult(t.status, t.results ?? null, t.groups?.[0]?.letter ?? "A") : null;
  return bets.settle(tourBetRaceId(tourId), result).bets;
}

/** 結果待ちの大会の賭けを見直す (alarm と一覧のとき。onTournamentClosed を取りこぼしても払う) */
export function reconcileTourBets(season: SeasonStore, bets: BetStore): number {
  let n = 0;
  for (const rid of bets.openRaces(TOUR_BET_PREFIX)) n += settleTourBets(season, bets, rid.slice(TOUR_BET_PREFIX.length));
  return n;
}

// ---------------------------------------------------------------- /api/tourbets

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

/**
 * GET  /api/tourbets                         賭けられる大会 (組が決まってスタート前) の A 組の倍率と、これから組の決まる大会
 * POST /api/tourbets { tourId, car, stake, odds }   賭ける (car = A 組の並びの番号 "0"..。odds = 画面で見た倍率。変わっていたら 409 で今の表)
 * 自分の賭けの一覧は リーグ戦と同じ /api/bets/mine (同じ表)
 */
export async function handleTourBetsApi(req: Request, path: string, method: string, accounts: AccountStore, season: SeasonStore, bets: BetStore): Promise<Response> {
  try {
    const M = method.toUpperCase();
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: "送るものが大きすぎます" }, 413);
    const me = await accounts.auth(bearer(req));
    if (!me) return json({ error: "ログインしてください" }, 401);
    const cfg: AdminConfig = season.config();
    // 本物のお金を入れたら (realMoneyEnabled)、見直しが済むまで受け口を全部閉じる
    if (cfg.realMoneyEnabled) return json({ error: betBlockedReason(cfg) }, 503);
    const myTeam = String(me.id);
    const now = season.now();
    const p = path.replace(/\/+$/, "");

    if (p === "/api/tourbets" && M === "GET") {
      reconcileTourBets(season, bets);
      const tours = season
        .toursForBets(now)
        .map((t) => tourBook(t, cfg.betMargin))
        .filter((b): b is TourBook => b !== null)
        .map((b) => view(b, myTeam, now));
      // これから組の決まる大会 (賭けはスタートの LOBBY_LEAD_MS 前から)
      const upcoming = season
        .listTournaments()
        .tournaments.filter((t) => t.status === "open")
        .slice(0, 3)
        .map((t) => ({ tourId: t.id, name: t.name, trackName: t.trackName, laps: t.laps, startsAt: t.startsAt, opensAt: t.startsAt - LOBBY_LEAD_MS, allEnter: t.allEnter }));
      return json({ now, paused: cfg.betPaused, margin: cfg.betMargin, leadMinutes: Math.round(LOBBY_LEAD_MS / 60_000), tours, upcoming });
    }

    if (p === "/api/tourbets" && M === "POST") {
      let b: Record<string, unknown>;
      try {
        const v = JSON.parse(text || "null");
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
        b = v as Record<string, unknown>;
      } catch {
        return json({ error: "送られてきたものが読めません" }, 400);
      }
      // 賭けられるのはゲームの中のお金 (stake) だけ。部品・品物・ほかの物が入っていたら断る
      if (Object.keys(b).some((k) => !PLACE_KEYS.has(k)) || typeof b.stake !== "number") return json({ error: "賭けられるのはゲームの中のお金だけです" }, 400);
      const blocked = betBlockedReason(cfg);
      if (blocked) return json({ error: blocked }, 503);
      if (typeof b.tourId !== "string" || b.tourId.length > 60) return json({ error: "その大会はありません" }, 404);
      const t = season.tourForBets(b.tourId);
      if (!t || t.status === "cancelled") return json({ error: "その大会はありません" }, 404);
      if (t.status === "open") return json({ error: `賭けは組が決まってから (スタートの ${Math.round(LOBBY_LEAD_MS / 60_000)} 分前から) です` }, 409);
      if (t.status !== "running" || now >= t.spec.startsAt) return json({ error: "この大会はもう締め切りました" }, 409);
      const book = tourBook(t, cfg.betMargin);
      if (!book) return json({ error: "この大会は賭けを受けていません" }, 409);
      if (book.teams.includes(myTeam)) return json({ error: "自分のチームが A 組 (優勝を決める組) にいる大会には賭けられません" }, 403);
      const slot = typeof b.car === "string" && /^\d{1,2}$/.test(b.car) ? Number(b.car) : -1;
      const c = book.cars.find((x) => x.slot === slot);
      if (!c) return json({ error: "選んだものが分かりません" }, 400);
      if (c.odds === null) return json({ error: "この賭けは今は受けていません" }, 409);
      if (b.odds !== undefined && b.odds !== c.odds) return json({ error: `倍率が変わりました (今は ${c.odds.toFixed(2)} 倍)`, book: view(book, myTeam, now) }, 409);
      // 大会の時計 (season.now) と賭けの時計 (bets、本当の時刻) の差を直して渡す (作るときに時計をずらしていることがある)
      const shift = bets.clock() - now;
      try {
        const r = bets.place({
          accountId: me.id,
          raceId: tourBetRaceId(t.spec.id),
          startsAt: t.spec.startsAt + shift,
          closesAt: t.spec.startsAt + shift,
          raceLabel: `大会「${t.spec.name}」`,
          teams: book.teams,
          kind: "tourwin",
          pick: { car: c.key },
          label: `${BET_KIND_NAMES.tourwin}: ${c.name} (${c.team})`,
          stake: b.stake,
          odds: c.odds,
          prob: c.pWin,
        });
        return json({ bet: r.bet, money: r.money }, 201);
      } catch (e) {
        if (e instanceof ApiError) return json({ error: e.message }, e.status);
        throw e;
      }
    }
    return json({ error: "ありません" }, 404);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("tour bets api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}
