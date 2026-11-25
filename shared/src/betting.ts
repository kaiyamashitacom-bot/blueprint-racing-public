// 賭け (DECISIONS 11/25「レースの結果に賭ける」): 2 時間ごとのリーグ戦のレースに、ゲームの中のお金 (accounts.money) だけで賭ける。
// 大事な決まり: 本物のお金で買える物・本物のお金に戻せる物は賭けに使えない。部品・品物・ほかの物も賭けられない (お金だけ)。
// 本物のお金 (課金) を入れたら AdminConfig.realMoneyEnabled を入にする。入の間は賭けを全部止める (法律の確かめと見直しが済むまで)。
//
// ここは画面とサーバーの両方で使う決まった計算だけ (乱数なし・同じ入力なら同じ答え):
// - 勝つ見込み: 車ごとの「速さの見積もり」(試走台の 1 周 benchLap × 運転手の上手さ + スタートの並び) から Plackett–Luce
//   (1 着 = softmax、3 着以内 = 上から 3 台の並びを全部数える、2 チームの順番 = 4 台だけの中で前に出る見込み)。
//   重みと温度は 8 台のレースを画面なしで 480 回走らせて合わせた (試験の外で。数は下の BET.model、仮)
// - 倍率 = (1 − 胴元の取り分) ÷ 見込み。0.01 で切り捨て。1.01 に届かない賭けは出さない。みんなの賭け方では動かさない
// - 賭けた時の倍率をそのまま残し、結果が出たら当たり・外れ・返す (計算できなかった・選んだ車やチームが走らなかった) を決める
//
// 1 着当て・3 着以内は「車ごと」(チームごとだと 3 着以内がほぼ必ず当たって倍率が 1 を切るため。レースの結果も車ごと)。
// 2 チームの順番は「チームごと」(2 台のうち前でゴールした方で比べる)。数は全部 (仮)。
import type { AdminConfig } from "./adminconfig.ts";
import { makeWeatherPlan, skyAt, wetnessAt, type Sky } from "./weather.ts";

export const BET = {
  /** 胴元の取り分 (はじめの値。管理者の数 betMargin) */
  margin: 0.1,
  /** 締め切り: スタートのこれだけ前 (分。管理者の数 betCloseMinutes) */
  closeMinutes: 5,
  /** 1 回の一番小さい額 (管理者の数 betMinStake) */
  minStake: 1,
  /** これより低い倍率の賭けは出さない */
  minOdds: 1.01,
  /** 倍率の上限 */
  maxOdds: 200,
  /** 見込みの下の端 (これより小さくしない。倍率が上限で止まる) */
  probFloor: 0.004,
  /** 走り切れない車の 1 周 (一番速い車のこの倍とみなす) */
  slowLapMul: 1.5,
  /**
   * 速さの見積もりの重みと温度 (仮。8 台 × 480 レースで合わせた)
   * 速さ (%) = 100 × (1 周 × (1 + skillK × (1 − 上手さ)) ÷ 一番速い 1 周 − 1) + gridPct × スタートの並び (0 = ポール)
   * 強さ = − 速さ ÷ tau。win は 1 着と 2 チームの順番、place は 3 着以内に使う (Plackett–Luce は 1 着と 3 着で合う温度が違う)
   */
  model: {
    win: { skillK: 0.09, gridPct: 3.6, tau: 5.4 },
    place: { skillK: 0.13, gridPct: 2.75, tau: 6.1 },
  },
  /** レースの時刻からこれだけ過ぎても結果が来ない賭けは返す (ms) */
  refundAfterMs: 6 * 3_600_000,
  /** 「賭けの記録」に出す数 */
  historyMax: 50,
  /** 1 人が同時に持てる結果待ちの賭け */
  maxOpen: 100,
} as const;

/** tourwin = 大会の優勝 (車ごと。下の「大会の優勝に賭ける」) */
export type BetKind = "win" | "top3" | "pair" | "tourwin";
/** リーグ戦のレースの賭け方 (/api/bets が受けるのはこれだけ) */
export const BET_KINDS: readonly BetKind[] = ["win", "top3", "pair"];
export const BET_KIND_NAMES: Readonly<Record<BetKind, string>> = { win: "1 着当て", top3: "3 着以内", pair: "2 チームの順番", tourwin: "大会の優勝" };

/** 1 着当て・3 着以内 = 車 (key)。2 チームの順番 = first のチームが second のチームより前 */
export type BetPick = { car: string } | { first: string; second: string };

/** 車の key (チーム id と 1 台目 / 2 台目) */
export function betCarKey(teamId: string, n: 1 | 2): string {
  return `${teamId}/${n}`;
}

/** 見込みの計算に渡す 1 台 */
export interface BetModelCar {
  key: string;
  team: string;
  /** 試走台の 1 周 (秒、晴れ・M タイヤ・一番上手い運転)。走り切れなければ null */
  lap: number | null;
  /** 運転の上手さ (bot.ts の skill、慣れを足したあと) */
  skill: number;
  /** スタートの並び (0 = ポール) */
  grid: number;
}

type ModelParams = { skillK: number; gridPct: number; tau: number };

/** 車ごとの強さ (Plackett–Luce の重み、一番強い車が 1) */
export function betWeights(cars: readonly BetModelCar[], p: ModelParams): number[] {
  if (!cars.length) return [];
  const laps = cars.map((c) => (c.lap !== null && Number.isFinite(c.lap) && c.lap > 0 ? c.lap : null));
  const known = laps.filter((x): x is number => x !== null);
  const base = known.length ? Math.min(...known) : 1;
  const pace = cars.map((c, i) => {
    const lap = laps[i] ?? base * BET.slowLapMul;
    const sk = Math.max(0, Math.min(1, c.skill));
    return 100 * ((lap * (1 + p.skillK * (1 - sk))) / base - 1) + p.gridPct * Math.max(0, c.grid);
  });
  const s = pace.map((x) => -x / p.tau);
  const m = Math.max(...s);
  return s.map((x) => Math.exp(x - m));
}

/** 1 着の見込み (足すと 1) */
export function winProbs(w: readonly number[]): number[] {
  const z = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / z);
}

/** 3 着以内の見込み (上から 3 台の並びを全部数える。足すと min(3, 台数)) */
export function top3Probs(w: readonly number[]): number[] {
  const n = w.length;
  const out = new Array<number>(n).fill(0);
  const W = w.reduce((a, b) => a + b, 0);
  for (let a = 0; a < n; a++) {
    const pa = w[a] / W;
    out[a] += pa;
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const pb = (pa * w[b]) / (W - w[a]);
      out[b] += pb;
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        out[c] += (pb * w[c]) / (W - w[a] - w[b]);
      }
    }
  }
  return out;
}

/** 倍率 (0.01 で切り捨て)。minOdds に届かなければ null (その賭けは出さない) */
export function betOdds(p: number, margin: number): number | null {
  const q = Math.max(BET.probFloor, Math.min(1, p));
  const raw = (1 - Math.max(0, Math.min(0.9, margin))) / q;
  const o = Math.min(BET.maxOdds, Math.floor(raw * 100 + 1e-9) / 100);
  return o >= BET.minOdds ? o : null;
}

export interface BookCar {
  key: string;
  team: string;
  grid: number;
  pWin: number;
  pTop3: number;
  win: number | null;
  top3: number | null;
}

export interface BookPair {
  /** チームの組 (a < b、チームの並びの順) */
  a: string;
  b: string;
  /** a が b より前の見込み */
  pA: number;
  /** a が前 / b が前 の倍率 */
  oddsA: number | null;
  oddsB: number | null;
}

export interface BetBook {
  margin: number;
  cars: BookCar[];
  pairs: BookPair[];
}

/** 1 レースの倍率の表 */
export function buildBetBook(cars: readonly BetModelCar[], margin: number): BetBook {
  const ww = betWeights(cars, BET.model.win);
  const wp = betWeights(cars, BET.model.place);
  const pw = winProbs(ww);
  const p3 = top3Probs(wp);
  const out: BookCar[] = cars.map((c, i) => {
    // 3 着以内が 1 着より低くならないように (温度が違うので、まれに逆になる)
    const pt = Math.max(p3[i], pw[i]);
    return { key: c.key, team: c.team, grid: c.grid, pWin: pw[i], pTop3: pt, win: betOdds(pw[i], margin), top3: betOdds(pt, margin) };
  });
  const teams = [...new Set(cars.map((c) => c.team))];
  const pairs: BookPair[] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const a = teams[i];
      const b = teams[j];
      // Plackett–Luce では 4 台だけの並びも同じ形: a の 2 台のどちらかが 4 台の中の 1 番になる見込み
      const wa = cars.reduce((s, c, k) => s + (c.team === a ? ww[k] : 0), 0);
      const wb = cars.reduce((s, c, k) => s + (c.team === b ? ww[k] : 0), 0);
      const pA = wa / (wa + wb);
      pairs.push({ a, b, pA, oddsA: betOdds(pA, margin), oddsB: betOdds(1 - pA, margin) });
    }
  }
  return { margin, cars: out, pairs };
}

/** 表からその賭けの倍率と見込み (無い・出していない賭けは null) */
export function bookOdds(book: BetBook, kind: BetKind, pick: BetPick): { odds: number; prob: number } | null {
  if (kind === "pair") {
    if (!("first" in pick)) return null;
    for (const p of book.pairs) {
      if (p.a === pick.first && p.b === pick.second) return p.oddsA === null ? null : { odds: p.oddsA, prob: p.pA };
      if (p.b === pick.first && p.a === pick.second) return p.oddsB === null ? null : { odds: p.oddsB, prob: 1 - p.pA };
    }
    return null;
  }
  if (!("car" in pick)) return null;
  const c = book.cars.find((x) => x.key === pick.car);
  if (!c) return null;
  const odds = kind === "win" ? c.win : c.top3;
  return odds === null ? null : { odds, prob: kind === "win" ? c.pWin : c.pTop3 };
}

/** 送られてきた賭け方と選んだ物の形を確かめる (中身が表にあるかは bookOdds で) */
export function parseBetPick(kind: unknown, raw: unknown): { kind: BetKind; pick: BetPick } | null {
  if (typeof kind !== "string" || !(BET_KINDS as readonly string[]).includes(kind)) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const okId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
  if (kind === "pair") {
    if (Object.keys(r).some((k) => k !== "first" && k !== "second")) return null;
    if (!okId(r.first) || !okId(r.second) || r.first === r.second) return null;
    return { kind, pick: { first: r.first, second: r.second } };
  }
  if (Object.keys(r).some((k) => k !== "car")) return null;
  if (!okId(r.car)) return null;
  return { kind: kind as BetKind, pick: { car: r.car } };
}

// ---------------------------------------------------------------- 結果

/** レースの結果の 1 台 (順位の順でなくてよい) */
export interface BetResultCar {
  key: string;
  team: string;
  pos: number;
  finished: boolean;
}

export type BetOutcome = "won" | "lost" | "void";

/**
 * 賭けの結果。result が null = 計算できなかったレース → 返す (void)。
 * 選んだ車・チームが走らなかった (退会・入れ替わり) ときも返す
 */
export function betOutcome(kind: BetKind, pick: BetPick, result: readonly BetResultCar[] | null): BetOutcome {
  if (!result || !result.length) return "void";
  if (kind === "pair") {
    if (!("first" in pick)) return "void";
    const best = (team: string) => {
      const ps = result.filter((c) => c.team === team).map((c) => c.pos);
      return ps.length ? Math.min(...ps) : null;
    };
    const a = best(pick.first);
    const b = best(pick.second);
    if (a === null || b === null) return "void";
    return a < b ? "won" : "lost";
  }
  if (!("car" in pick)) return "void";
  const c = result.find((x) => x.key === pick.car);
  if (!c) return "void";
  if (kind === "win" || kind === "tourwin") return c.pos === 1 && c.finished ? "won" : "lost";
  return c.pos <= 3 && c.finished ? "won" : "lost";
}

/** 当たったときに戻るお金 (賭けた額を含む。1 円未満は切り捨て) */
export function betPayout(stake: number, odds: number): number {
  return Math.floor(stake * odds + 1e-6);
}

// ---------------------------------------------------------------- 上限と止める

export interface BetLimits {
  minStake: number;
  /** null = 上限なし (決まり 11/25: はじめは上限なし。管理者が付けたいときだけ) */
  maxStake: number | null;
  maxPerDay: number | null;
  /** 手元のお金のこの割合まで (null = なし) */
  maxShareOfMoney: number | null;
}

export function betLimitsOf(cfg: Pick<AdminConfig, "betMinStake" | "betMaxStake" | "betMaxPerDay" | "betMaxShareOfMoney">): BetLimits {
  return { minStake: cfg.betMinStake, maxStake: cfg.betMaxStake, maxPerDay: cfg.betMaxPerDay, maxShareOfMoney: cfg.betMaxShareOfMoney };
}

/** 賭ける額を確かめる (だめなら日本語のわけ)。money = 今のお金、todayStaked = 今日 (日本時間) もう賭けた額 */
export function checkBetStake(stake: unknown, money: number, todayStaked: number, lim: BetLimits): string | null {
  if (typeof stake !== "number" || !Number.isInteger(stake) || stake <= 0) return "賭ける額は 1 円以上の整数にしてください";
  if (stake < lim.minStake) return `賭ける額は ${lim.minStake.toLocaleString("ja-JP")} 円からです`;
  if (lim.maxStake !== null && stake > lim.maxStake) return `1 回に賭けられるのは ${lim.maxStake.toLocaleString("ja-JP")} 円までです`;
  if (lim.maxPerDay !== null && todayStaked + stake > lim.maxPerDay) {
    return `1 日に賭けられるのは ${lim.maxPerDay.toLocaleString("ja-JP")} 円までです (今日あと ${Math.max(0, lim.maxPerDay - todayStaked).toLocaleString("ja-JP")} 円)`;
  }
  if (lim.maxShareOfMoney !== null && stake > Math.floor(money * lim.maxShareOfMoney)) {
    return `手元のお金の ${Math.round(lim.maxShareOfMoney * 100)}% (${Math.floor(money * lim.maxShareOfMoney).toLocaleString("ja-JP")} 円) までです`;
  }
  if (stake > money) return "お金が足りません";
  return null;
}

/**
 * 賭けを受けられないわけ (受けられれば null)。
 * realMoneyEnabled: 本物のお金 (課金) を入れたら入にする。入の間は、見直しと法律の確かめが済むまで賭けを全部止める
 */
export function betBlockedReason(cfg: Pick<AdminConfig, "realMoneyEnabled" | "betPaused">): string | null {
  if (cfg.realMoneyEnabled) return "賭けは見直しのため止めています (本物のお金を入れたため)";
  if (cfg.betPaused) return "賭けは今は一時停止中です";
  return null;
}

/** 締め切りの時刻 */
export function betClosesAt(startsAt: number, closeMinutes: number): number {
  return startsAt - Math.max(0, closeMinutes) * 60_000;
}

// ---------------------------------------------------------------- 天気の見込み

/**
 * そのレースの天気の見込み (leaguerace.ts の simulateRace と同じ作り方: レースの seed の最初の乱数で天気の予定を作る)。
 * 平均の濡れ具合はライバルの性格 (雨に強い など) の上手さに使う。画面には始まりの空を出す
 */
export function betRaceWeather(seed: number, laps: number): { sky: Sky; wetStart: number; wetAvg: number } {
  let s = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  s = (s * 16807) % 2147483647;
  const r0 = (s - 1) / 2147483646;
  const secs = laps * 75;
  const plan = makeWeatherPlan(1 + Math.floor(r0 * 2147483645), secs);
  let sum = 0;
  const n = 20;
  for (let i = 0; i <= n; i++) sum += wetnessAt(plan, (secs * i) / n);
  return { sky: skyAt(plan, 0), wetStart: wetnessAt(plan, 0), wetAvg: sum / (n + 1) };
}

// ---------------------------------------------------------------- 大会の優勝に賭ける (11/25)
//
// 大会の順位は 組の順 (A の 1〜8 位 → B …) なので、優勝は A 組 (予選の上の組) の 1 位。賭けられるのは A 組の車だけ。
// 賭けられる間 = 組が決まってから (スタートの LOBBY_LEAD_MS 前に組を開く) スタートまで。
// 自分のチームの車が A 組にいれば、その大会には賭けられない (優勝を決めるレースに出ている = リーグ戦の「自分のレースは不可」と同じ考え)。
// 全員参加の毎日の大会でも、A 組の外のチーム・出ていないチームは賭けられる。
// 見込み: 車ごとの 1 周 = 予選の記録 (あれば) か 強さの見込み (tourgrid.ts の estimatedLap。運転手の上手さ込み) を、
// リーグ戦の 1 着当てと同じ重み (BET.model.win の gridPct・tau) で Plackett–Luce に。上手さは 1 周に入っているので skill = 1 として渡す。数は全部 (仮)。

/** 大会の優勝の見込みに渡す 1 台 */
export interface TourBetCar {
  /** 運転手 id (結果の driverId と同じ) */
  key: string;
  team: string;
  /** 予選の記録 (秒) か 強さの見込みの 1 周。走り切れない・分からない = null */
  lap: number | null;
  /** A 組の中のスタートの並び (0 = ポール) */
  grid: number;
}

export interface TourBookCar {
  key: string;
  team: string;
  grid: number;
  pWin: number;
  /** 倍率 (出さない賭けは null) */
  odds: number | null;
}

/** 大会の優勝の倍率の表 (A 組の車だけを渡す)。2 台に届かなければ空 (賭けは出さない) */
export function tourBetBook(cars: readonly TourBetCar[], margin: number): TourBookCar[] {
  if (cars.length < 2) return [];
  const w = betWeights(
    cars.map((c) => ({ key: c.key, team: c.team, lap: c.lap !== null && Number.isFinite(c.lap) && c.lap > 0 ? c.lap : null, skill: 1, grid: c.grid })),
    BET.model.win,
  );
  const p = winProbs(w);
  return cars.map((c, i) => ({ key: c.key, team: c.team, grid: c.grid, pWin: p[i], odds: betOdds(p[i], margin) }));
}

/** 大会の結果の 1 行 (season.ts の TourResultRow の要るところだけ) */
export interface TourBetResultRow {
  finalPos: number;
  group: string;
  driverId: string;
  teamId: string;
  finished: boolean;
  dq: boolean;
}

/**
 * 大会の結果 → 賭けの結果の形。取りやめた大会 (status cancelled) と、優勝を決める組 (firstGroup = "A") の結果が無い大会は null (全部返す)
 */
export function tourBetResult(status: string, rows: readonly TourBetResultRow[] | null | undefined, firstGroup: string): BetResultCar[] | null {
  if (status !== "done" || !rows?.length) return null;
  if (!rows.some((r) => r.group === firstGroup)) return null;
  return rows.map((r) => ({ key: r.driverId, team: r.teamId, pos: r.finalPos, finished: r.finished && !r.dq }));
}
