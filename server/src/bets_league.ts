// 賭けの受け口 /api/bets/... (リーグの DO の中。worker.ts が /api/bets をここへ回す)。
// 倍率はここで出す (レースの組・ライバル・慣れはリーグの DO にあり、チームの車と運転手はアカウントの DO から port.teams で取る)。
// お金を動かすのはアカウントの DO (bets.ts) だけ: ここは倍率を出して port.placeBet に渡す。結果の払いは league.ts の送る箱から。
// - 賭けられるのはゲームの中のお金だけ。送るものは raceId・kind・pick・stake (お金の額)・odds だけ受ける (品物・部品などが入っていたら断る)
// - AdminConfig.realMoneyEnabled が入 (本物のお金を入れた) の間は、ここの受け口は全部断る (見直しと法律の確かめが済むまで)
// - 自分のチームの出るレースには賭けられない。締め切りはスタートの betCloseMinutes 分前
// - ほかのチームの id (アカウントの番号) は返さない: 画面とのやりとりはレースの中のチームの番号 ("0".."3") と車 ("0/1" = 1 台目)
// 数は全部 (仮)。
import {
  BET_KIND_NAMES,
  BOT_DESIGNS,
  DEFAULT_ADMIN_CONFIG,
  SKY_NAMES,
  STAND_IN_SKILL,
  TRACK_DEFS,
  cachedBenchLap,
  betBlockedReason,
  betCarKey,
  betClosesAt,
  betRaceWeather,
  bookOdds,
  buildBetBook,
  driverTraits,
  familiaritySkillBonus,
  leagueDayAt,
  leagueName,
  parseBetPick,
  planScheduledRaces,
  rivalDesign,
  rivalSkill,
  scheduledEntries,
  scheduledSlotIndex,
  scheduledSlotStart,
  type AdminConfig,
  type BetBook,
  type BetModelCar,
  type CarDesign,
  type League,
  type ScheduledPlan,
  type ScheduledRacePlan,
  type TeamDrivers,
} from "@bpr/shared";
import type { LeagueAccountsPort, LeagueStore } from "./league.ts";
import type { LeagueTeamData } from "./league_accounts.ts";

export const BETS_PATH = /^\/api\/bets(\/|$)/;

/** 送ってよい項目 (これ以外 = お金のほかの物を賭けようとした → 断る) */
const PLACE_KEYS = new Set(["raceId", "kind", "pick", "stake", "odds"]);
const MAX_BODY = 2 * 1024;

// ---------------------------------------------------------------- 試走台の 1 周 (重いので覚えておく。tourgrid.ts の cachedBenchLap)

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------- レースの組と倍率

/** 賭けられる枠: 次の枠から、その日 (日本時間) の最後の枠まで */
export function betSlots(now: number): number[] {
  const first = scheduledSlotIndex(now) + 1;
  const day = leagueDayAt(scheduledSlotStart(first));
  const out: number[] = [];
  for (let s = first; leagueDayAt(scheduledSlotStart(s)) === day && out.length < 12; s++) out.push(s);
  return out;
}

interface BookTeam {
  /** 本当のチーム id (画面には出さない) */
  id: string;
  name: string;
  human: boolean;
  cars: Array<{ n: 1 | 2; driver: string; grid: number }>;
}

export interface RaceBook {
  race: ScheduledRacePlan;
  plan: ScheduledPlan;
  league: League;
  teams: BookTeam[];
  book: BetBook;
  sky: string;
  closesAt: number;
}

function hm(ms: number): string {
  // 日本時間の時:分
  const d = new Date(ms + 9 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function trackName(id: string): string {
  return TRACK_DEFS.find((d) => d.id === id)?.name ?? id;
}

/** 1 レースの倍率の表を作る (チームの様子はアカウントの DO から) */
export async function raceBook(store: LeagueStore, port: LeagueAccountsPort, cfg: AdminConfig, raceId: string, now: number): Promise<RaceBook | null> {
  const m = /^sched-(-?\d+)-(.+)$/.exec(raceId);
  if (!m) return null;
  const slot = Number(m[1]);
  if (!betSlots(now).includes(slot)) return null;
  const state = store.state(now);
  const plan = planScheduledRaces(scheduledSlotStart(slot), state);
  const race = plan.races.find((r) => r.raceId === raceId);
  const league = state.leagues.find((l) => l.id === m[2]);
  if (!race || !league) return null;
  const data: LeagueTeamData[] = league.humans.length ? await port.teams(league.humans) : [];
  const byTeam = new Map(data.map((d) => [d.teamId, d]));
  // league.ts の runRace と同じ組み方 (来なかった人のチームは走らない)
  const teams = race.teams.filter((t) => byTeam.has(t) || league.cpus.includes(t));
  const drivers: TeamDrivers[] = data.map((d) => ({ teamId: d.teamId, ownDriverId: `own:${d.teamId}`, hiredDriverId: d.hired?.driverId ?? `cpu:${d.teamId}` }));
  const entries = scheduledEntries({ ...race, teams }, drivers);
  const weather = betRaceWeather(race.seed, plan.laps);
  const track = plan.trackId;
  const out = new Map<string, BookTeam>();
  const cars: BetModelCar[] = [];
  entries.forEach((e, grid) => {
    let design: CarDesign;
    let skill: number;
    let driver: string;
    let n: 1 | 2;
    let name: string;
    if (e.rival) {
      const rv = store.rival(e.teamId, league);
      const k = e.driverId.endsWith("#1") ? 1 : 0;
      n = k === 0 ? 1 : 2;
      design = rivalDesign(rv, BOT_DESIGNS[hashStr(rv.id) % BOT_DESIGNS.length]);
      const fam = store.famNow(`rv:${rv.drivers[k].id}`, now)[track] ?? 0;
      skill = rivalSkill(rv, k, weather.wetAvg) + familiaritySkillBonus(fam);
      driver = rv.drivers[k].name;
      name = rv.name;
    } else {
      const d = byTeam.get(e.teamId)!;
      name = d.name;
      if (e.standIn) {
        n = 1;
        design = d.design;
        skill = STAND_IN_SKILL + familiaritySkillBonus(d.standInFam[track] ?? 0, true);
        driver = d.driver;
      } else {
        n = 2;
        design = d.secondDesign;
        if (d.hired) {
          skill = driverTraits(d.hired.stats).skill + familiaritySkillBonus(d.hired.fam[track] ?? 0);
          driver = d.hired.name;
        } else {
          skill = STAND_IN_SKILL;
          driver = "代走 CPU";
        }
      }
    }
    const t = out.get(e.teamId) ?? { id: e.teamId, name, human: !e.rival, cars: [] };
    t.cars.push({ n, driver, grid });
    out.set(e.teamId, t);
    cars.push({ key: betCarKey(e.teamId, n), team: e.teamId, lap: cachedBenchLap(design, track, cfg), skill: Math.min(1, skill), grid });
  });
  const ordered = teams.map((t) => out.get(t)!).filter(Boolean);
  for (const t of ordered) t.cars.sort((a, b) => a.n - b.n);
  return { race, plan, league, teams: ordered, book: buildBetBook(cars, cfg.betMargin), sky: SKY_NAMES[weather.sky], closesAt: betClosesAt(plan.startsAt, cfg.betCloseMinutes) };
}

/** 画面に出す形 (チームはレースの中の番号で) */
function bookView(rb: RaceBook, myTeam: string, now: number) {
  const idx = new Map(rb.teams.map((t, i) => [t.id, String(i)]));
  return {
    raceId: rb.race.raceId,
    league: leagueName(rb.league),
    division: rb.league.division,
    startsAt: rb.plan.startsAt,
    closesAt: rb.closesAt,
    open: now < rb.closesAt,
    mine: rb.race.teams.includes(myTeam),
    trackId: rb.plan.trackId,
    trackName: trackName(rb.plan.trackId),
    laps: rb.plan.laps,
    sky: rb.sky,
    teams: rb.teams.map((t, i) => ({
      i: String(i),
      name: t.name,
      human: t.human,
      cars: t.cars.map((c) => {
        const bc = rb.book.cars.find((x) => x.key === betCarKey(t.id, c.n))!;
        return { car: `${i}/${c.n}`, driver: c.driver, grid: c.grid + 1, win: bc.win, top3: bc.top3, pWin: round3(bc.pWin), pTop3: round3(bc.pTop3) };
      }),
    })),
    pairs: rb.book.pairs.map((p) => ({ a: idx.get(p.a)!, b: idx.get(p.b)!, oddsA: p.oddsA, oddsB: p.oddsB, pA: round3(p.pA) })),
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** 画面の選んだ物 ("0/1" や "2") を本当のチーム id に */
function toServerPick(rb: RaceBook, kind: unknown, raw: unknown) {
  const p = parseBetPick(kind, raw);
  if (!p) return null;
  const team = (i: string) => (/^\d$/.test(i) ? rb.teams[Number(i)] : undefined);
  if ("car" in p.pick) {
    const mm = /^(\d)\/([12])$/.exec(p.pick.car);
    const t = mm ? team(mm[1]) : undefined;
    const c = t?.cars.find((x) => x.n === Number(mm![2]));
    if (!t || !c) return null;
    const label = `${BET_KIND_NAMES[p.kind]}: ${c.driver} (${t.name})`;
    return { kind: p.kind, pick: { car: betCarKey(t.id, c.n as 1 | 2) }, label };
  }
  const a = team(p.pick.first);
  const b = team(p.pick.second);
  if (!a || !b || a === b) return null;
  return { kind: p.kind, pick: { first: a.id, second: b.id }, label: `${BET_KIND_NAMES.pair}: ${a.name} が ${b.name} より前` };
}

// ---------------------------------------------------------------- /api/bets/...

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

/**
 * GET  /api/bets/races          賭けられるレース (次の枠からその日の最後の枠まで。リーグごとに 4 チームの名前)
 * GET  /api/bets/race/:raceId   1 レースの倍率 (車ごとの 1 着・3 着以内、2 チームの順番)
 * POST /api/bets { raceId, kind, pick, stake, odds }   賭ける (odds = 画面で見た倍率。変わっていたら 409 で今の表を返す)
 * GET  /api/bets/mine           自分の賭け (結果待ち・記録)
 * 一時停止の入・切と量の集計は管理者の /api/admin/bets (アカウントの DO、bets.ts)
 */
export async function handleBetsApi(req: Request, store: LeagueStore, port: LeagueAccountsPort): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const M = req.method.toUpperCase();
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: "送るものが大きすぎます" }, 413);
    const me = await port.auth(bearer(req));
    if (!me) return json({ error: "ログインしてください" }, 401);
    let cfg: AdminConfig = DEFAULT_ADMIN_CONFIG as AdminConfig;
    try {
      cfg = (await port.adminConfig()) ?? cfg;
    } catch (e) {
      console.error("bets admin config", (e as Error)?.message ?? e);
      return json({ error: "今は賭けを受けられません" }, 503);
    }
    // 本物のお金を入れたら (realMoneyEnabled)、見直しが済むまで受け口を全部閉じる
    if (cfg.realMoneyEnabled) return json({ error: betBlockedReason(cfg) }, 503);
    const now = store.now();

    if (path === "/api/bets/races" && M === "GET") {
      const state = store.state(now);
      const slots = betSlots(now).map((slot) => {
        const startsAt = scheduledSlotStart(slot);
        const plan = planScheduledRaces(startsAt, state);
        const closesAt = betClosesAt(startsAt, cfg.betCloseMinutes);
        return {
          slot,
          startsAt,
          closesAt,
          open: now < closesAt,
          trackId: plan.trackId,
          trackName: trackName(plan.trackId),
          laps: plan.laps,
          races: plan.races.map((r) => {
            const lg = state.leagues.find((l) => l.id === r.leagueId)!;
            return {
              raceId: r.raceId,
              league: leagueName(lg),
              division: r.division,
              mine: r.teams.includes(me.teamId),
              teams: r.teams.map((t) => (lg.cpus.includes(t) ? { name: store.rival(t, lg).name, human: false } : { name: store.teamNameOf(t) ?? "チーム", human: true })),
            };
          }),
        };
      });
      return json({ now, paused: cfg.betPaused, closeMinutes: cfg.betCloseMinutes, margin: cfg.betMargin, slots });
    }

    const rm = /^\/api\/bets\/race\/([\w-]{1,80})$/.exec(path);
    if (rm && M === "GET") {
      const rb = await raceBook(store, port, cfg, rm[1], now);
      if (!rb) return json({ error: "そのレースはありません" }, 404);
      return json({ ...bookView(rb, me.teamId, now), paused: cfg.betPaused });
    }

    if (path === "/api/bets/mine" && M === "GET") {
      if (!port.myBets) return json({ error: "今は賭けを受けられません" }, 503);
      return json(await port.myBets(Number(me.teamId)));
    }

    if (path === "/api/bets" && M === "POST") {
      let b: Record<string, unknown>;
      try {
        const v = JSON.parse(text || "null");
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
        b = v as Record<string, unknown>;
      } catch {
        return json({ error: "送られてきたものが読めません" }, 400);
      }
      // 賭けられるのはゲームの中のお金 (stake) だけ。部品・品物・ほかの物が入っていたら断る
      if (Object.keys(b).some((k) => !PLACE_KEYS.has(k))) return json({ error: "賭けられるのはゲームの中のお金だけです" }, 400);
      if (typeof b.stake !== "number") return json({ error: "賭けられるのはゲームの中のお金だけです" }, 400);
      const blocked = betBlockedReason(cfg);
      if (blocked) return json({ error: blocked }, 503);
      if (typeof b.raceId !== "string") return json({ error: "そのレースはありません" }, 404);
      const rb = await raceBook(store, port, cfg, b.raceId, now);
      if (!rb) return json({ error: "そのレースはありません" }, 404);
      if (rb.race.teams.includes(me.teamId)) return json({ error: "自分のチームが出るレースには賭けられません" }, 403);
      if (now >= rb.closesAt) return json({ error: "このレースはもう締め切りました" }, 409);
      const sp = toServerPick(rb, b.kind, b.pick);
      if (!sp) return json({ error: "選んだものが分かりません" }, 400);
      const o = bookOdds(rb.book, sp.kind, sp.pick);
      if (!o) return json({ error: "この賭けは今は受けていません" }, 409);
      // 画面で見た倍率と今の倍率が違えば、賭けずに今の表を返す (賭けた時の倍率を決めるのはサーバー)
      if (b.odds !== undefined && b.odds !== o.odds) return json({ error: `倍率が変わりました (今は ${o.odds.toFixed(2)} 倍)`, book: bookView(rb, me.teamId, now) }, 409);
      if (!port.placeBet) return json({ error: "今は賭けを受けられません" }, 503);
      const r = await port.placeBet({
        accountId: Number(me.teamId),
        raceId: rb.race.raceId,
        startsAt: rb.plan.startsAt,
        raceLabel: `${leagueName(rb.league)} · ${hm(rb.plan.startsAt)} · ${trackName(rb.plan.trackId)}`,
        teams: [...rb.race.teams],
        kind: sp.kind,
        pick: sp.pick,
        label: sp.label,
        stake: b.stake,
        odds: o.odds,
        prob: o.prob,
      });
      if (!r.ok) return json({ error: r.error }, r.status);
      return json({ bet: r.bet, money: r.money }, 201);
    }
    return json({ error: "ありません" }, 404);
  } catch (e) {
    console.error("bets api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}

