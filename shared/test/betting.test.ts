// 賭けの計算 (betting.ts) の試験: 見込みの足し算・取り分・倍率の端・結果の決め方・上限・止め・管理者の数
import { describe, expect, it } from "vitest";
import {
  BET,
  DEFAULT_ADMIN_CONFIG,
  applyAdminPatch,
  betBlockedReason,
  betLimitsOf,
  betOdds,
  betOutcome,
  betPayout,
  betRaceWeather,
  tourBetBook,
  tourBetResult,
  betWeights,
  bookOdds,
  buildBetBook,
  checkBetStake,
  parseBetPick,
  top3Probs,
  winProbs,
  type BetModelCar,
} from "../src/index.ts";

/** 4 チーム 8 台 (速さと上手さとスタートの並びがばらばら) */
function field(): BetModelCar[] {
  const laps = [60.1, 60.1, 61.5, 61.5, 59.4, 59.4, 63, 63];
  const skill = [0.8, 0.86, 0.9, 0.82, 0.88, 0.93, 0.8, 0.75];
  const grid = [3, 6, 0, 5, 7, 1, 2, 4];
  return laps.map((lap, i) => ({ key: `t${i >> 1}/${(i & 1) + 1}`, team: `t${i >> 1}`, lap, skill: skill[i], grid: grid[i] }));
}

describe("見込み", () => {
  it("1 着は足して 1、3 着以内は足して 3、2 チームの順番は両方で 1", () => {
    const book = buildBetBook(field(), 0.1);
    expect(book.cars.reduce((s, c) => s + c.pWin, 0)).toBeCloseTo(1, 10);
    expect(top3Probs(betWeights(field(), BET.model.place)).reduce((s, x) => s + x, 0)).toBeCloseTo(3, 10);
    for (const c of book.cars) {
      expect(c.pTop3).toBeGreaterThanOrEqual(c.pWin);
      expect(c.pTop3).toBeLessThanOrEqual(1);
    }
    expect(book.pairs).toHaveLength(6);
    for (const p of book.pairs) expect(p.pA).toBeGreaterThan(0);
    // 同じ入力なら同じ答え
    expect(buildBetBook(field(), 0.1)).toEqual(book);
  });

  it("速い車・上手い運転手・前のスタートほど見込みが高い", () => {
    const base: BetModelCar[] = [
      { key: "a/1", team: "a", lap: 60, skill: 0.85, grid: 1 },
      { key: "b/1", team: "b", lap: 60, skill: 0.85, grid: 1 },
    ];
    const p = (cars: BetModelCar[]) => winProbs(betWeights(cars, BET.model.win))[0];
    expect(p(base)).toBeCloseTo(0.5, 10);
    expect(p([{ ...base[0], lap: 59 }, base[1]])).toBeGreaterThan(0.5);
    expect(p([{ ...base[0], skill: 0.95 }, base[1]])).toBeGreaterThan(0.5);
    expect(p([{ ...base[0], grid: 0 }, base[1]])).toBeGreaterThan(0.5);
    // 走り切れない車 (lap null) はほぼ勝てない
    expect(p([{ ...base[0], lap: null }, base[1]])).toBeLessThan(0.01);
  });

  it("天気の見込みは決まった数 (同じ seed なら同じ)", () => {
    const w = betRaceWeather(12345, 5);
    expect(w).toEqual(betRaceWeather(12345, 5));
    expect(w.wetAvg).toBeGreaterThanOrEqual(0);
    expect(w.wetAvg).toBeLessThanOrEqual(1);
  });
});

describe("倍率", () => {
  it("取り分 1 割: 倍率 × 見込み は 0.9 (0.01 の切り捨ての分だけ下)", () => {
    const book = buildBetBook(field(), 0.1);
    for (const c of book.cars) {
      for (const [p, o] of [[c.pWin, c.win], [c.pTop3, c.top3]] as const) {
        if (o === null) continue;
        if (o === BET.maxOdds) continue;
        expect(o * p).toBeLessThanOrEqual(0.9 + 1e-9);
        expect((o + 0.01) * p).toBeGreaterThan(0.9);
      }
    }
    // 取り分を変えると倍率も変わる
    expect(betOdds(0.5, 0.1)).toBe(1.8);
    expect(betOdds(0.5, 0.2)).toBe(1.6);
    expect(betOdds(0.5, 0)).toBe(2);
    expect(betOdds(0.1, 0.1)).toBe(9);
  });

  it("1.01 に届かない賭けは出さない。上限は 200 倍", () => {
    expect(betOdds(0.95, 0.1)).toBeNull();
    expect(betOdds(0.89, 0.1)).toBe(1.01);
    expect(betOdds(0.0001, 0.1)).toBe(BET.maxOdds);
    expect(betOdds(1, 0)).toBeNull();
  });

  it("表から選んだ物の倍率 (2 チームの順番は前後どちらも)", () => {
    const book = buildBetBook(field(), 0.1);
    const p = book.pairs[0];
    expect(bookOdds(book, "pair", { first: p.a, second: p.b })).toEqual(p.oddsA === null ? null : { odds: p.oddsA, prob: p.pA });
    expect(bookOdds(book, "pair", { first: p.b, second: p.a })).toEqual(p.oddsB === null ? null : { odds: p.oddsB, prob: 1 - p.pA });
    expect(bookOdds(book, "win", { car: "nope/1" })).toBeNull();
    expect(bookOdds(book, "win", { first: "a", second: "b" })).toBeNull();
  });

  it("送られた選んだ物の形", () => {
    expect(parseBetPick("win", { car: "0/1" })).toEqual({ kind: "win", pick: { car: "0/1" } });
    expect(parseBetPick("pair", { first: "0", second: "1" })).toEqual({ kind: "pair", pick: { first: "0", second: "1" } });
    expect(parseBetPick("pair", { first: "0", second: "0" })).toBeNull();
    expect(parseBetPick("win", { car: "0/1", part: "eng_m1" })).toBeNull();
    expect(parseBetPick("item", { car: "0/1" })).toBeNull();
    expect(parseBetPick("win", null)).toBeNull();
  });
});

describe("結果", () => {
  const res = [
    { key: "a/1", team: "a", pos: 1, finished: true },
    { key: "b/1", team: "b", pos: 2, finished: true },
    { key: "a/2", team: "a", pos: 3, finished: false },
    { key: "b/2", team: "b", pos: 4, finished: true },
  ];
  it("1 着・3 着以内 (ゴールした車だけ)・2 チームの順番 (前の 1 台で比べる)", () => {
    expect(betOutcome("win", { car: "a/1" }, res)).toBe("won");
    expect(betOutcome("win", { car: "b/1" }, res)).toBe("lost");
    expect(betOutcome("top3", { car: "b/1" }, res)).toBe("won");
    expect(betOutcome("top3", { car: "a/2" }, res)).toBe("lost");
    expect(betOutcome("top3", { car: "b/2" }, res)).toBe("lost");
    expect(betOutcome("pair", { first: "a", second: "b" }, res)).toBe("won");
    expect(betOutcome("pair", { first: "b", second: "a" }, res)).toBe("lost");
  });
  it("計算できなかった・走らなかった車やチームは返す", () => {
    expect(betOutcome("win", { car: "a/1" }, null)).toBe("void");
    expect(betOutcome("win", { car: "c/1" }, res)).toBe("void");
    expect(betOutcome("pair", { first: "a", second: "c" }, res)).toBe("void");
  });
  it("払いは 額 × 倍率 の切り捨て (賭けた額を含む)", () => {
    expect(betPayout(100, 3.33)).toBe(333);
    expect(betPayout(7, 1.01)).toBe(7);
    expect(betPayout(1000, 2.57)).toBe(2570);
  });
});

describe("上限と止め", () => {
  const lim = betLimitsOf(DEFAULT_ADMIN_CONFIG);
  it("はじめは上限なし (全部賭けてよい)。一番小さい額は 1", () => {
    expect(lim).toEqual({ minStake: 1, maxStake: null, maxPerDay: null, maxShareOfMoney: null });
    expect(checkBetStake(5000, 5000, 1_000_000, lim)).toBeNull();
    expect(checkBetStake(5001, 5000, 0, lim)).toBe("お金が足りません");
    expect(checkBetStake(0, 5000, 0, lim)).not.toBeNull();
    expect(checkBetStake(1.5, 5000, 0, lim)).not.toBeNull();
    expect(checkBetStake("10", 5000, 0, lim)).not.toBeNull();
  });
  it("管理者が付けた上限: 1 回・1 日・手元の割合", () => {
    const l2 = { minStake: 10, maxStake: 500, maxPerDay: 800, maxShareOfMoney: 0.2 };
    expect(checkBetStake(9, 5000, 0, l2)).toContain("10 円から");
    expect(checkBetStake(501, 5000, 0, l2)).toContain("500 円まで");
    expect(checkBetStake(400, 5000, 500, l2)).toContain("1 日");
    expect(checkBetStake(300, 5000, 500, l2)).toBeNull();
    expect(checkBetStake(300, 1000, 0, l2)).toContain("20%");
    expect(checkBetStake(200, 1000, 0, l2)).toBeNull();
  });
  it("本物のお金を入れたら止める (realMoneyEnabled はじめは切)。一時停止", () => {
    expect(DEFAULT_ADMIN_CONFIG.realMoneyEnabled).toBe(false);
    expect(betBlockedReason(DEFAULT_ADMIN_CONFIG)).toBeNull();
    expect(betBlockedReason({ realMoneyEnabled: true, betPaused: false })).toContain("本物のお金");
    expect(betBlockedReason({ realMoneyEnabled: false, betPaused: true })).toContain("一時停止");
  });
  it("管理者の数: 上限は空 (null) にも数にもでき、幅の外は断る", () => {
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { betMaxStake: 1000, betMaxShareOfMoney: 0.2 }).ok).toBe(true);
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { betMaxStake: null }).ok).toBe(true);
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { betMargin: 0.6 }).ok).toBe(false);
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { betMinStake: 0 }).ok).toBe(false);
    expect(applyAdminPatch(DEFAULT_ADMIN_CONFIG, { realMoneyEnabled: "no" }).ok).toBe(false);
  });
});

describe("大会の優勝", () => {
  const cars = [
    { key: "h1", team: "1", lap: 80, grid: 0 },
    { key: "h2", team: "2", lap: 80.8, grid: 1 },
    { key: "d7", team: "2", lap: null, grid: 2 },
    { key: "h3", team: "3", lap: 79.5, grid: 3 },
  ];

  it("見込みは足すと 1。速い 1 周・前の並びほど見込みが高い。倍率は取り分のぶん低い", () => {
    const b = tourBetBook(cars, 0.1);
    expect(b.map((c) => c.key)).toEqual(["h1", "h2", "d7", "h3"]);
    expect(b.reduce((s, c) => s + c.pWin, 0)).toBeCloseTo(1, 9);
    expect(b[0].pWin).toBeGreaterThan(b[1].pWin);
    // 1 周の見込みの無い車は一番遅い
    expect(b[2].pWin).toBeLessThan(b[1].pWin);
    for (const c of b) if (c.odds !== null) expect(c.odds * c.pWin).toBeLessThanOrEqual(0.9 + 1e-9);
    // 同じ 1 周なら前の並びが強い
    const same = tourBetBook(
      [
        { key: "a", team: "1", lap: 80, grid: 0 },
        { key: "b", team: "2", lap: 80, grid: 1 },
      ],
      0.1,
    );
    expect(same[0].pWin).toBeGreaterThan(same[1].pWin);
  });

  it("2 台に届かなければ賭けは出さない", () => {
    expect(tourBetBook([cars[0]], 0.1)).toEqual([]);
    expect(tourBetBook([], 0.1)).toEqual([]);
  });

  it("結果: A 組の 1 位が優勝。取りやめ・結果なし・A 組の結果が無い大会は返す (null)。失格は完走に数えない", () => {
    const rows = [
      { finalPos: 1, group: "A", driverId: "h1", teamId: "1", finished: true, dq: false },
      { finalPos: 2, group: "A", driverId: "h3", teamId: "3", finished: true, dq: false },
      { finalPos: 3, group: "B", driverId: "h9", teamId: "9", finished: true, dq: false },
      { finalPos: 4, group: "A", driverId: "h2", teamId: "2", finished: true, dq: true },
    ];
    const r = tourBetResult("done", rows, "A");
    expect(r).not.toBeNull();
    expect(betOutcome("tourwin", { car: "h1" }, r)).toBe("won");
    expect(betOutcome("tourwin", { car: "h3" }, r)).toBe("lost");
    expect(betOutcome("tourwin", { car: "h2" }, r)).toBe("lost");
    // 走らなかった車は返す
    expect(betOutcome("tourwin", { car: "nobody" }, r)).toBe("void");
    expect(tourBetResult("cancelled", rows, "A")).toBeNull();
    expect(tourBetResult("done", [], "A")).toBeNull();
    expect(tourBetResult("done", rows.filter((x) => x.group !== "A"), "A")).toBeNull();
    expect(tourBetResult("running", rows, "A")).toBeNull();
    expect(betOutcome("tourwin", { car: "h1" }, null)).toBe("void");
  });
});
