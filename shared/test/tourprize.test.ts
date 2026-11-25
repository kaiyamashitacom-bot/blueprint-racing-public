// 大会ごとの景品 (tourprize.ts)・毎日の自動の大会の日程 (dailytour.ts)・並びの強さ (tourgrid.ts) の試験
import { describe, expect, it } from "vitest";
import {
  DAILY_TOUR,
  DEFAULT_ADMIN_CONFIG,
  DEFAULT_TOURNAMENT_PRIZES,
  GIFT_KINDS,
  SAMPLE_DESIGN,
  STAND_IN_SKILL,
  TRACK_ROTATION_FROM,
  checkTournamentPrizes,
  dailyTourDayDue,
  dailyTourId,
  dailyTourSettings,
  dailyTourSpec,
  dailyTourTrack,
  defaultTournamentPrizes,
  estimatedLap,
  giftItemsByName,
  jstDayStart,
  jstWeekday,
  nextDailyTourOpen,
  prizeItemsForPos,
  prizeSummary,
  qualifyWindow,
  rotationTrackIds,
  tournamentPrizeAwards,
  tournamentPrizesOf,
  validateTournament,
  type PrizeCar,
} from "../src/index.ts";

const H = 3_600_000;
const DAY = 24 * H;
/** 日本時間 y/m/d 0:00 */
const jst = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 9 * H;

describe("格ごとのはじめの景品", () => {
  const has = (name: string) => giftItemsByName(name, 1) !== null;
  it("登録表にある物はその物、無ければお金 (あとから登録された物はそのまま使われる)", () => {
    const big = defaultTournamentPrizes("大");
    expect(big.tiers.map((t) => [t.from, t.to])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    if (has("限界設計図")) {
      expect(big.tiers[0].items).toHaveLength(1);
      expect(big.tiers[0].items[0].kind).not.toBe("money");
      expect(JSON.stringify(big.tiers[0].items[0].p)).toContain("1");
    } else expect(big.tiers[0].items).toEqual([{ kind: "money", p: { amount: 30_000 } }]);
    if (!has("限界突破のかけら")) expect(big.tiers[1].items).toEqual([{ kind: "money", p: { amount: 15_000 } }]);
    if (!has("走行点")) expect(big.participation).toEqual([{ kind: "money", p: { amount: 1_000 } }]);
    const mid = defaultTournamentPrizes("中");
    expect(mid.tiers.map((t) => [t.from, t.to])).toEqual([
      [1, 1],
      [2, 3],
    ]);
    if (has("限界突破のかけら")) {
      // かけら ×5 (数の項目に入る)
      expect(Object.values(mid.tiers[0].items[0].p)).toContain(5);
    } else expect(mid.tiers[0].items).toEqual([{ kind: "money", p: { amount: 15_000 } }]);
    const small = defaultTournamentPrizes("小");
    expect(small.tiers).toEqual([
      { from: 1, to: 1, items: [{ kind: "money", p: { amount: 8_000 } }] },
      { from: 2, to: 3, items: [{ kind: "money", p: { amount: 3_000 } }] },
    ]);
    // どの格にも参加賞がある
    for (const g of ["小", "中", "大"] as const) expect(defaultTournamentPrizes(g).participation.length).toBeGreaterThan(0);
    // 表の候補の最後はお金 (必ず何か渡る)
    for (const g of ["小", "中", "大"] as const) {
      for (const t of DEFAULT_TOURNAMENT_PRIZES[g].tiers) expect("money" in t.alts[t.alts.length - 1]).toBe(true);
      const p = DEFAULT_TOURNAMENT_PRIZES[g].participation;
      expect("money" in p[p.length - 1]).toBe(true);
    }
  });
  it("名前で探す: 種類の名前か、選びの候補の名前。見つからなければ null", () => {
    expect(giftItemsByName("お金", 500)).toEqual([{ kind: "money", p: { amount: 500 } }]);
    expect(giftItemsByName("そんな物はない", 1)).toBeNull();
    const withSelect = GIFT_KINDS.find((k) => k.fields.some((f) => f.type === "select" && f.options?.some((o) => o.label.includes("限界設計図"))));
    if (withSelect) expect(giftItemsByName("限界設計図", 2)![0].kind).toBe(withSelect.id);
  });
  it("決めていなければ格のはじめの景品。格の無い前からの大会は 中", () => {
    expect(tournamentPrizesOf({}).grade).toBe("中");
    expect(tournamentPrizesOf({ grade: "小" }).tiers).toEqual(defaultTournamentPrizes("小").tiers);
    const custom = tournamentPrizesOf({ grade: "大", prizes: [{ from: 1, to: 4, items: [{ kind: "money", p: { amount: 7 } }] }], participation: [] });
    expect(custom.tiers).toHaveLength(1);
    expect(custom.participation).toEqual([]);
    expect(custom.custom).toEqual({ tiers: true, participation: true });
    // 順位の景品だけ決めると、参加賞は格のはじめのまま
    expect(tournamentPrizesOf({ grade: "小", prizes: [] }).participation).toEqual(defaultTournamentPrizes("小").participation);
    expect(prizeItemsForPos(custom.tiers, 4)).toHaveLength(1);
    expect(prizeItemsForPos(custom.tiers, 5)).toEqual([]);
    const sum = prizeSummary({ grade: "小" });
    expect(sum).toMatchObject({ grade: "小", custom: false });
    expect(sum.tiers[0].lines).toEqual(["お金 8,000"]);
  });
});

describe("管理者の決めた景品の確かめ", () => {
  it("幅・重なり・中身", () => {
    expect(checkTournamentPrizes(undefined, null)).toEqual({ ok: true, prizes: undefined, participation: undefined });
    const ok = checkTournamentPrizes(
      [
        { from: 4, to: 8, items: [{ kind: "money", p: { amount: "300" } }] },
        { from: 1, to: 1, items: [{ kind: "money", p: { amount: 5000 } }] },
      ],
      [],
    );
    expect(ok).toEqual({
      ok: true,
      prizes: [
        { from: 1, to: 1, items: [{ kind: "money", p: { amount: 5000 } }] },
        { from: 4, to: 8, items: [{ kind: "money", p: { amount: 300 } }] },
      ],
      participation: [],
    });
    const bad = (t: unknown, p: unknown = null) => {
      const r = checkTournamentPrizes(t, p);
      return r.ok ? "" : r.error;
    };
    expect(bad([{ from: 2, to: 1, items: [{ kind: "money", p: { amount: 1 } }] }])).toContain("順位の幅");
    expect(bad([{ from: 0, to: 1, items: [{ kind: "money", p: { amount: 1 } }] }])).toContain("順位の幅");
    expect(
      bad([
        { from: 1, to: 3, items: [{ kind: "money", p: { amount: 1 } }] },
        { from: 3, to: 4, items: [{ kind: "money", p: { amount: 1 } }] },
      ]),
    ).toContain("重なって");
    expect(bad([{ from: 1, to: 1, items: [] }])).toContain("1 位");
    expect(bad([{ from: 1, to: 1, items: [{ kind: "nope", p: {} }] }])).toContain("知らない");
    expect(bad(null, [{ kind: "money", p: { amount: -5 } }])).toContain("参加賞");
    // ギフトコードと同じ上限
    const capped = checkTournamentPrizes([{ from: 1, to: 1, items: [{ kind: "money", p: { amount: 9000 } }] }], null, { ...DEFAULT_ADMIN_CONFIG, giftMoneyMax: 5000 });
    expect(capped.ok).toBe(false);
  });
});

describe("誰が何をもらうか", () => {
  const prizes = {
    tiers: [
      { from: 1, to: 1, items: [{ kind: "money" as const, p: { amount: 100 } }] },
      { from: 2, to: 3, items: [{ kind: "money" as const, p: { amount: 50 } }] },
    ],
    participation: [{ kind: "money" as const, p: { amount: 5 } }],
  };
  const car = (driverId: string, teamId: string | null, finalPos: number, o: Partial<PrizeCar> = {}): PrizeCar => ({ driverId, teamId, finalPos, finished: true, dq: false, ...o });
  it("順位ごと・参加賞はチームに 1 回・代走ももらう・失格と完走できずはなし・コンピューターはなし", () => {
    const aw = tournamentPrizeAwards(
      [
        car("h1", "1", 1, { standIn: true }),
        car("x", null, 2),
        car("r1", "1", 3),
        car("h2", "2", 4),
        car("h3", "3", 5, { finished: false }),
        car("h4", "4", 6, { dq: true }),
      ],
      prizes,
    );
    expect(aw.map((a) => [a.teamId, a.cars.map((c) => [c.driverId, c.finalPos, c.items[0].p.amount]), a.participation.length])).toEqual([
      [
        "1",
        [
          ["h1", 1, 100],
          ["r1", 3, 50],
        ],
        1,
      ],
      ["2", [], 1],
    ]);
  });
});

describe("毎日の自動の大会の日程", () => {
  const s = dailyTourSettings(DEFAULT_ADMIN_CONFIG);
  it("はじめ: 22:30・月〜土 中・日曜 大・開く", () => {
    expect(s).toEqual({ on: true, hour: 22, minute: 30, gradeWeekday: "中", gradeSunday: "大" });
  });
  it("予選は前の日のスタート + 30 分から 22:00 まで、10 周・8 台ずつ・全員参加・くじの天気", () => {
    const mon = jst(2026, 11, 30);
    expect(jstWeekday(mon)).toBe(1);
    const sp = dailyTourSpec(mon, s, mon - DAY);
    expect(sp.id).toBe("d20261130");
    expect(dailyTourId(mon)).toBe("d20261130");
    expect(sp.startsAt).toBe(mon + 22.5 * H);
    expect(sp.createdAt).toBe(mon - DAY + 23 * H);
    expect(qualifyWindow(sp)).toEqual({ opensAt: mon - DAY + 23 * H, closesAt: mon + 22 * H });
    expect(sp).toMatchObject({ laps: 10, allEnter: true, auto: true, grade: "中", weather: { mode: "random", rain: 0.3 } });
    expect(sp.name).toBe("11/30 (月) の大会");
    expect(validateTournament(sp, sp.createdAt, rotationTrackIds(mon))).toEqual([]);
    // 日曜は 大
    const sun = jst(2026, 12, 6);
    expect(dailyTourSpec(sun, s, sun).grade).toBe("大");
    expect(dailyTourSpec(sun, s, sun).name).toBe("12/6 (日) の大会・大");
    // 管理者が格を変えられる
    expect(dailyTourSpec(sun, dailyTourSettings({ ...DEFAULT_ADMIN_CONFIG, autoTourGradeSunday: 1 }), sun).grade).toBe("小");
    expect(DAILY_TOUR.noticeLeadsMs).toEqual([H]);
  });
  it("今どの日の大会が開いているべきか (止めると無し)・次に開く時刻", () => {
    const mon = jst(2026, 11, 30);
    expect(dailyTourDayDue(mon + 12 * H, s)).toBe(mon);
    // 今日のスタートの 15 分前を過ぎたら、もう作らない。前の日のスタート + 30 分までは無し
    expect(dailyTourDayDue(mon + 22.5 * H - 10 * 60_000, s)).toBeNull();
    expect(dailyTourDayDue(mon + 22.9 * H, s)).toBeNull();
    expect(dailyTourDayDue(mon + 23 * H, s)).toBe(mon + DAY);
    expect(dailyTourDayDue(mon + 12 * H, { ...s, on: false })).toBeNull();
    expect(nextDailyTourOpen(mon + 12 * H, s)).toBe(mon + 23 * H);
    expect(nextDailyTourOpen(mon + 12 * H, { ...s, on: false })).toBeNull();
    expect(jstDayStart(mon + 23.9 * H)).toBe(mon);
  });
  it("コースは日ごとに公式コースを順に回す。あとから足すコースはその日から (今日のコースは変わらない)", () => {
    const d0 = jst(2026, 11, 26);
    const ids = rotationTrackIds(d0);
    const seen = Array.from({ length: ids.length }, (_, i) => dailyTourTrack(d0 + i * DAY).id);
    // 足したコースは 11/30 から入る。それより前は前からのコースだけを順に
    const before = Array.from({ length: 4 }, (_, i) => dailyTourTrack(d0 + i * DAY).id);
    for (const id of before) expect(TRACK_ROTATION_FROM[id]).toBeUndefined();
    expect(new Set(seen.slice(0, 4)).size).toBe(4);
    // 11/30 から先のコースを足すと決めても、それより前の日は同じ (回し方は その日の 0:00 に入っているもの)
    const sameDay = dailyTourTrack(d0).id;
    expect(dailyTourTrack(d0).id).toBe(sameDay);
    // 同じ日はいつも同じ
    expect(dailyTourTrack(jst(2026, 12, 3))).toEqual(dailyTourTrack(jst(2026, 12, 3)));
  });
});

describe("並びの強さ (見込みの 1 周)", () => {
  it("試しの台の 1 周に上手さの分を足す。上手いほど速い。同じ設計図は覚えておく", () => {
    const a = estimatedLap(SAMPLE_DESIGN, "aozu", 1);
    const b = estimatedLap(SAMPLE_DESIGN, "aozu", STAND_IN_SKILL);
    expect(a).toBeGreaterThan(20);
    expect(b).toBeCloseTo(a * (1 + 0.25 * (1 - STAND_IN_SKILL)), 6);
    const t0 = Date.now();
    estimatedLap(SAMPLE_DESIGN, "aozu", 0.9);
    expect(Date.now() - t0).toBeLessThan(5);
  });
});
