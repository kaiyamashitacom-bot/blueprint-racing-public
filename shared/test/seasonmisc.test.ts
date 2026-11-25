import { describe, expect, it } from "vitest";
import {
  applyAdminPatch, cloneAdminConfig, DEFAULT_ADMIN_CONFIG, leaguePrizeFor, marketFeeFor, partStrengthFor, racePrizeFor, seasonPrizeFor, validateAdminConfig,
} from "../src/adminconfig.ts";
import { MARKET } from "../src/market.ts";
import { racePrize } from "../src/money.ts";
import { allNotices, dueNotices, nextNoticeAt, NOTICE_STALE_MS, noticesFor, TOURNAMENT_NOTICE_LEADS_MS, type NoticeSources } from "../src/notify.ts";
import { canLikeTrack, LIKE_WEIGHT, likeTrack, newTrackPopularity, popularityScore, rankTracks, recordTrackRun, unlikeTrack } from "../src/popularity.ts";

describe("コースの人気", () => {
  it("走り終えた人だけ「いいね」を押せる、1 人 1 回", () => {
    let p = newTrackPopularity("aozu");
    p = recordTrackRun(p, "a", false);
    expect(likeTrack(p, "a")).toEqual({ ok: false, reason: "not_finished" });
    expect(canLikeTrack(p, "a")).toBe(false);
    p = recordTrackRun(p, "a", true);
    expect(canLikeTrack(p, "a")).toBe(true);
    const r = likeTrack(p, "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.pop;
    expect(likeTrack(p, "a")).toEqual({ ok: false, reason: "already" });
    expect(p.drives).toBe(2);
    expect(p.finishers).toEqual(["a"]);
    expect(popularityScore(p)).toBe(2 + LIKE_WEIGHT);
    p = unlikeTrack(p, "a");
    expect(popularityScore(p)).toBe(2);
    expect(unlikeTrack(p, "a")).toBe(p);
  });
  it("点の順に並べる (同じなら いいね → 回数 → id)", () => {
    const mk = (id: string, drives: number, likes: number) => ({ trackId: id, drives, finishers: [], likes: Array.from({ length: likes }, (_, i) => `p${i}`) });
    const list = [mk("x", 20, 0), mk("y", 10, 1), mk("z", 30, 0), mk("w", 20, 0)];
    expect(rankTracks(list).map((r) => [r.trackId, r.rank, r.score])).toEqual([
      ["z", 1, 30],
      ["y", 2, 20],
      ["w", 3, 20],
      ["x", 4, 20],
    ]);
  });
});

describe("知らせ", () => {
  const H = 3_600_000;
  const src: NoticeSources = {
    tournaments: [{ id: "t1", name: "大会", startsAt: 100 * H }],
    research: [{ jobId: "j1", teamId: "A", partName: "エンジン", doneAt: 90 * H }],
    sales: [{ listingId: "l1", sellerTeamId: "B", itemName: "羽根", price: 500, soldAt: 50 * H }],
    outbids: [{ auctionId: "au1", bidId: "bid7", teamId: "A", itemName: "タイヤ", newPrice: 900, at: 95 * H }],
  };
  it("知らせの id は決まった形", () => {
    expect(allNotices(src).map((n) => n.id)).toEqual(["sold:l1", "tour:t1:86400000", "research:j1", "outbid:au1:bid7:A", "tour:t1:3600000"]);
    expect(TOURNAMENT_NOTICE_LEADS_MS).toEqual([24 * H, H]);
  });
  it("時刻が来て、まだ送っていないものだけ", () => {
    const now = 95 * H;
    expect(dueNotices(src, now).map((n) => n.id)).toEqual(["tour:t1:86400000", "research:j1", "outbid:au1:bid7:A"]);
    // 売れた知らせは 45 時間前 = 古すぎる
    expect(dueNotices(src, now).some((n) => n.id === "sold:l1")).toBe(false);
    expect(dueNotices(src, 50 * H + NOTICE_STALE_MS).map((n) => n.id)).toContain("sold:l1");
    expect(dueNotices(src, now, ["research:j1", "tour:t1:86400000"]).map((n) => n.id)).toEqual(["outbid:au1:bid7:A"]);
    expect(dueNotices(src, now, new Set(["outbid:au1:bid7:A"])).map((n) => n.id)).toEqual(["tour:t1:86400000", "research:j1"]);
  });
  it("大会が始まったあとの「もうすぐ」は送らない", () => {
    expect(dueNotices(src, 100 * H).some((n) => n.kind === "tournament_soon")).toBe(false);
    expect(dueNotices(src, 100 * H - 1).map((n) => n.id)).toContain("tour:t1:3600000");
  });
  it("次の知らせの時刻・宛先で絞る", () => {
    expect(nextNoticeAt(src, 0)).toBe(50 * H);
    expect(nextNoticeAt(src, 95 * H)).toBe(99 * H);
    expect(nextNoticeAt(src, 99 * H)).toBeNull();
    const due = dueNotices(src, 99 * H + 1);
    expect(noticesFor(due, "B").map((n) => n.kind)).toEqual(["tournament_soon", "tournament_soon"]);
    expect(noticesFor(due, "A").map((n) => n.kind)).toEqual(["tournament_soon", "research_done", "outbid", "tournament_soon"]);
  });
});

describe("管理者の数", () => {
  it("初めの値は確かめを通り、ほかの部署の数とそろっている", () => {
    expect(validateAdminConfig(DEFAULT_ADMIN_CONFIG).ok).toBe(true);
    expect(DEFAULT_ADMIN_CONFIG.marketFeeRate).toBe(MARKET.feeRate);
    // 普段のレースの賞金は money.ts と同じ
    for (const [points, finished, laps, humans] of [
      [25, true, 5, 3],
      [0, true, 2, 1],
      [26, true, 10, 1],
      [0, false, 5, 2],
    ] as const) {
      expect(racePrizeFor(DEFAULT_ADMIN_CONFIG, "everyday", { pos: 1, points, finished }, { laps, cpuOnly: humans <= 1 })).toBe(racePrize({ points, finished }, { laps, humans }));
    }
  });
  it("大会・季節・リーグの賞金", () => {
    const c = DEFAULT_ADMIN_CONFIG;
    expect(racePrizeFor(c, "tournament", { pos: 1, points: 25, finished: true }, { laps: 10, cpuOnly: false })).toBe(c.tournamentPrize[0]);
    expect(racePrizeFor(c, "tournament", { pos: 1, points: 25, finished: true, dq: true }, { laps: 10, cpuOnly: false })).toBe(0);
    expect(racePrizeFor(c, "tournament", { pos: 20, points: 0, finished: true }, { laps: 10, cpuOnly: false })).toBe(0);
    expect(seasonPrizeFor(c, 1, 1)).toBeGreaterThan(seasonPrizeFor(c, 5, 1));
    expect(seasonPrizeFor(c, 3, 99)).toBe(0);
    // リーグは下の部ほど多い
    const lg = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => leaguePrizeFor(c, d, 1));
    for (let i = 1; i < lg.length; i++) expect(lg[i]).toBeGreaterThan(lg[i - 1]);
    expect(c.leaguePrizeDivisionMul[0]).toBe(1);
    expect(c.leaguePrizeDivisionMul).toHaveLength(8);
    // 4 チーム中の上位 2 だけ (1 位 300・2 位 150、1 部は倍率 1)
    expect(c.leaguePrize).toEqual([300, 150]);
    expect(leaguePrizeFor(c, 1, 1)).toBe(300);
    expect(leaguePrizeFor(c, 1, 2)).toBe(150);
    expect(leaguePrizeFor(c, 8, 2)).toBe(Math.floor(150 * c.leaguePrizeDivisionMul[7]));
    expect(leaguePrizeFor(c, 1, 3)).toBe(0);
  });
  it("手数料と部品の強さ", () => {
    expect(marketFeeFor(DEFAULT_ADMIN_CONFIG, 1000)).toBe(50);
    expect(marketFeeFor(DEFAULT_ADMIN_CONFIG, -5)).toBe(0);
    const p = applyAdminPatch(DEFAULT_ADMIN_CONFIG, { partStrength: 1.5, partKindStrength: { engine: 2 } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(partStrengthFor(p.config, "engine")).toBe(3);
    expect(partStrengthFor(p.config, "wing")).toBe(1.5);
  });
  it("一部の変更を合わせて確かめる。元は変えない", () => {
    const base = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    const ok = applyAdminPatch(base, { marketFeeRate: 0.1, season: { tournamentMul: 20 } });
    expect(ok.ok && ok.config.marketFeeRate).toBe(0.1);
    expect(ok.ok && ok.config.season).toEqual({ ...base.season, tournamentMul: 20 });
    expect(base.marketFeeRate).toBe(0.05);
    expect(applyAdminPatch(base, { marketFeeRate: 0.9 })).toEqual({ ok: false, errors: ["marketFeeRate"] });
    expect(applyAdminPatch(base, { tournamentPrize: [1, 2, 3] })).toEqual({ ok: false, errors: ["tournamentPrize"] });
    expect(applyAdminPatch(base, { prizePerPoint: 1.5 })).toEqual({ ok: false, errors: ["prizePerPoint"] });
    expect(applyAdminPatch(base, { foo: 1 })).toEqual({ ok: false, errors: ["unknown:foo"] });
    expect(applyAdminPatch(base, null)).toEqual({ ok: false, errors: ["patch"] });
    expect(validateAdminConfig("x")).toEqual({ ok: false, errors: ["config"] });
    expect(applyAdminPatch(base, { partKindStrength: { engine: 0 } })).toEqual({ ok: false, errors: ["partKindStrength"] });
  });
});
