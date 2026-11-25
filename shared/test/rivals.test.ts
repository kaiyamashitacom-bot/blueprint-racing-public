import { describe, expect, it } from "vitest";
import { makeBrain } from "../src/bot.ts";
import { validateDesign } from "../src/design.ts";
import { driverOverall } from "../src/drivers.ts";
import { seededRand } from "../src/econ.ts";
import { partDef } from "../src/parts.ts";
import { BOT_DESIGNS, BOT_NAMES, SAMPLE_DESIGN } from "../src/presets.ts";
import { anyPartDef } from "../src/research.ts";
import {
  addRivalPoints, advanceRivalDay, advanceRivalSeason, bestPartLike, createRivals, PERSONALITIES, PERSONALITY_IDS, RIVAL, rivalBrain, rivalDesign,
  RIVAL_DAYS_PER_SEASON, rivalDriveParams, rivalEntries, rivalSkill, rivalStandings, type RivalTeam,
} from "../src/rivals.ts";
import { validateEmblem } from "../src/team.ts";

describe("ライバルのチーム", () => {
  it("同じ種なら同じ。名前は重ならず、性格は全部出る", () => {
    const a = createRivals(2026, 3);
    expect(a).toEqual(createRivals(2026, 3));
    expect(a.map((r) => r.name)).not.toEqual(createRivals(2027, 3).map((r) => r.name));
    expect(a).toHaveLength(RIVAL.perLeague);
    expect(new Set(a.map((r) => r.name)).size).toBe(a.length);
    const dn = a.flatMap((r) => r.drivers.map((d) => d.name));
    expect(new Set(dn).size).toBe(dn.length);
    for (const n of dn) expect(BOT_NAMES).not.toContain(n);
    // 性格はリーグの中で重ならない。6 チーム頼めば全部出る
    expect(new Set(a.map((r) => r.personality)).size).toBe(a.length);
    expect(new Set(createRivals(2026, 3, PERSONALITY_IDS.length).map((r) => r.personality))).toEqual(new Set(PERSONALITY_IDS));
    for (const r of a) {
      expect(validateEmblem(r.emblem)).toBe(true);
      expect(r.division).toBe(3);
      expect(r.partTier).toBe(RIVAL.divisionTier[3]);
    }
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it("1 リーグのコンピューターは 2 チーム。人が 1 チームのリーグは 3 チーム頼んでも前の 2 チームは同じ", () => {
    expect(RIVAL.perLeague).toBe(2);
    const two = createRivals(77, 5);
    const three = createRivals(77, 5, 3);
    expect(three).toHaveLength(3);
    expect(three.slice(0, 2)).toEqual(two);
    expect(new Set(three.map((r) => r.personality)).size).toBe(3);
  });

  it("部とリーグの種で決まり、リーグが違えば違うチーム。id はリーグをまたいで重ならない", () => {
    expect(createRivals(10, 2)).toEqual(createRivals(10, 2));
    const ids = new Set<string>();
    for (let d = 1; d <= RIVAL.divisions; d++) for (const seed of [1, 2]) for (const r of createRivals(seed, d)) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
    expect(createRivals(10, 2).map((r) => r.name)).not.toEqual(createRivals(11, 2).map((r) => r.name));
  });

  it("上の部ほど強い (運転手の能力・部品の段階)", () => {
    const avg = (d: number) => {
      let sum = 0;
      let n = 0;
      for (let seed = 0; seed < 10; seed++) for (const r of createRivals(seed, d, 6)) for (const x of r.drivers) { sum += driverOverall(x.stats); n++; }
      return sum / n;
    };
    for (let d = 1; d < RIVAL.divisions; d++) {
      expect(avg(d)).toBeGreaterThan(avg(d + 1));
      expect(createRivals(0, d)[0].partTier).toBeGreaterThanOrEqual(createRivals(0, d + 1)[0].partTier);
    }
    expect(createRivals(0, 1)[0].partTier).toBeGreaterThan(createRivals(0, 8)[0].partTier);
    // 季節が進んでも 部の段階より下がらない
    const next = advanceRivalSeason(createRivals(0, 1), { season: 0, fieldTier: 1 });
    for (const r of next) expect(r.partTier).toBeGreaterThanOrEqual(RIVAL.divisionTier[1]);
  });

  it("雨に強いチームは濡れると速く、乾くと少し遅い", () => {
    const rv: RivalTeam = { ...createRivals(1, 8)[0], personality: "rain" };
    expect(rivalSkill(rv, 0, 1)).toBeGreaterThan(rivalSkill(rv, 0, 0));
    const flier: RivalTeam = { ...rv, personality: "flier" };
    expect(rivalSkill(flier, 0, 0)).toBeGreaterThan(rivalSkill(rv, 0, 0));
    expect(rivalSkill(flier, 0, 1)).toBeLessThan(rivalSkill(rv, 0, 1));
    expect(rivalDriveParams(rv, 0, 0.8).pitSense).toBeGreaterThanOrEqual(PERSONALITIES.rain.style.pitEarly);
  });

  it("無理に抜きに来るチームは 抜きが強く、ミスとすり減りが多い", () => {
    const base = createRivals(1, 8)[0];
    const ag = rivalDriveParams({ ...base, personality: "aggressive" }, 0, 0);
    const st = rivalDriveParams({ ...base, personality: "steady" }, 0, 0);
    expect(ag.passAggression).toBeGreaterThan(1);
    expect(ag.mistakeScale).toBeGreaterThan(st.mistakeScale);
    expect(ag.wearScale).toBeGreaterThan(st.wearScale);
  });

  it("skill は決めた幅に入り、頭は makeBrain と同じ形", () => {
    for (const rv of [1, 4, 8].flatMap((d) => createRivals(5, d))) {
      for (const k of [0, 1] as const) {
        for (const w of [0, 0.5, 1]) {
          const s = rivalSkill(rv, k, w);
          expect(s).toBeGreaterThanOrEqual(RIVAL.skillMin);
          expect(s).toBeLessThanOrEqual(RIVAL.skillMax);
        }
        const b = rivalBrain(rv, k, seededRand(3), 0.2);
        expect(Object.keys(b).sort()).toEqual(Object.keys(makeBrain(seededRand(3))).sort());
        expect(b.skill).toBe(rivalSkill(rv, k, 0.2));
        expect(Math.abs(b.offset)).toBeLessThanOrEqual(1.6);
      }
    }
  });
});

describe("ライバルの車", () => {
  it("同じ形の部品だけで入れ替えるので 段階 1〜2 の車は設計図として正しい", () => {
    for (const rv of createRivals(9, 8)) {
      for (const base of BOT_DESIGNS) {
        const d = rivalDesign({ ...rv, partTier: 2 }, base);
        expect(validateDesign(d)).toEqual([]);
        expect(d.parts.length).toBe(base.parts.length);
        for (const [i, p] of d.parts.entries()) {
          const a = anyPartDef(p.id)!;
          const b = anyPartDef(base.parts[i].id)!;
          expect([a.kind, a.w, a.h, p.c, p.r, p.rot]).toEqual([b.kind, b.w, b.h, base.parts[i].c, base.parts[i].r, base.parts[i].rot]);
          expect(a.tier).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("段階が上がると強い部品に。性格で選ぶ部品が違う", () => {
    const eng = partDef("eng_m1")!;
    const t = PERSONALITIES;
    expect(bestPartLike(eng, 1, t.aggressive.style.parts).id).toBe("eng_m1");
    expect(bestPartLike(eng, 5, t.aggressive.style.parts).id).toBe("eng_p5");
    const small = partDef("eng_s1")!;
    expect(bestPartLike(small, 3, t.saver.style.parts).id).toBe("eng_e3");
    const wing = partDef("wing_s1")!;
    // 雨に強いチームは押しつけ、一発の速さは抵抗の少なさ
    const rainW = anyPartDef(bestPartLike(wing, 4, t.rain.style.parts).id)!;
    const flyW = anyPartDef(bestPartLike(wing, 4, t.flier.style.parts).id)!;
    expect(rainW.downforce! / rainW.drag!).toBeLessThanOrEqual(flyW.downforce! / flyW.drag! + 1e-9);
    // 運転席と骨組みはそのまま
    expect(bestPartLike(partDef("seat")!, 5, t.rain.style.parts).id).toBe("seat");
    const top = rivalDesign({ ...createRivals(1, 8)[0], partTier: 5 }, SAMPLE_DESIGN);
    expect(top.parts.some((p) => anyPartDef(p.id)!.tier >= 3)).toBe(true);
  });
});

describe("季節を通したライバル", () => {
  it("点を足して順位が付き、季節の切れ目に記録を残して点は 0 に", () => {
    let rv = createRivals(4, 8);
    rv = addRivalPoints(rv, rv[1].id, 25);
    rv = addRivalPoints(rv, rv[0].id, 18);
    rv = addRivalPoints(rv, rv[1].id, 10);
    const order = rivalStandings(rv);
    expect(order[0].id).toBe(rv[1].id);
    expect(order[0].seasonPoints).toBe(35);
    expect(order[0].seasonRaces).toBe(2);
    const next = advanceRivalSeason(rv, { season: 0, fieldTier: 1 });
    const top = next.find((x) => x.id === rv[1].id)!;
    expect(top.history).toEqual([{ season: 0, points: 35, rank: 1 }]);
    expect(top.seasonPoints).toBe(0);
    expect(next.every((x) => x.history.length === 1)).toBe(true);
  });

  it("レースに出ると運転手が育ち、お金をためて部品の段階を上げる (先に行きすぎない)", () => {
    let rv = createRivals(8, 8).map((r) => ({ ...r, partTier: 1 }));
    const before = rv.map((r) => driverOverall(r.drivers[0].stats));
    for (let season = 0; season < 6; season++) {
      for (const r of rv) for (let i = 0; i < 20; i++) rv = addRivalPoints(rv, r.id, 10);
      rv = advanceRivalSeason(rv, { season, fieldTier: 3 });
    }
    rv.forEach((r, i) => expect(driverOverall(r.drivers[0].stats)).toBeGreaterThan(before[i]));
    for (const r of rv) {
      expect(r.partTier).toBeGreaterThanOrEqual(3);
      expect(r.partTier).toBeLessThanOrEqual(4);
      expect(r.budget).toBeGreaterThanOrEqual(0);
    }
  });

  it("毎日少しずつ上がり、7 日分と季節の締めを合わせると 週に 1 回まとめて上げたのと同じ", () => {
    let rv = createRivals(8, 8).map((r) => ({ ...r, partTier: 1 }));
    for (const r of rv) for (let i = 0; i < 12; i++) rv = addRivalPoints(rv, r.id, 10);
    const weekly = advanceRivalSeason(rv, { season: 0, fieldTier: 3 });
    let daily = rv;
    const budgets: number[] = [];
    for (let d = 0; d < RIVAL_DAYS_PER_SEASON - 1; d++) {
      daily = advanceRivalDay(daily, { season: 0, fieldTier: 3 });
      budgets.push(daily[0].budget + daily[0].partTier * 1e6);
      expect(daily[0].daily?.days).toBe(d + 1);
      expect(daily[0].history).toHaveLength(0);
    }
    // 1 日目で育ちと点の分、残りの日も土台のお金が少しずつ入る (下がらない)
    expect(daily[0].drivers[0].races).toBe(RIVAL.maxGrowthRaces > 12 ? 12 : RIVAL.maxGrowthRaces);
    for (let i = 1; i < budgets.length; i++) expect(budgets[i]).toBeGreaterThan(budgets[i - 1]);
    expect(advanceRivalDay(rv, { season: 0, fieldTier: 3 })).toEqual(advanceRivalDay(rv, { season: 0, fieldTier: 3 }));
    const closed = advanceRivalSeason(daily, { season: 0, fieldTier: 3 });
    expect(closed).toEqual(weekly);
    expect(closed.every((r) => r.daily === undefined)).toBe(true);
  });

  it("遊ぶ人より遅れすぎたら追いつく", () => {
    const rv = createRivals(8, 8).map((r) => ({ ...r, partTier: 1 }));
    const next = advanceRivalSeason(rv, { season: 0, fieldTier: 4.5 });
    for (const r of next) expect(r.partTier).toBeGreaterThanOrEqual(4);
    // 運転手が弱いと伸びしろを多めに足す
    const weak = advanceRivalSeason(rv, { season: 0, fieldTier: 1, fieldOverall: 100 });
    const plain = advanceRivalSeason(rv, { season: 0, fieldTier: 1 });
    expect(weak[0].drivers[0].potential.speed).toBeGreaterThanOrEqual(plain[0].drivers[0].potential.speed);
    expect(weak.some((r, i) => r.drivers[0].potential.speed > plain[i].drivers[0].potential.speed)).toBe(true);
  });

  it("空きを埋める車は種で決まり、同じチームの 2 台が並ぶ", () => {
    const rv = createRivals(3, 8, 3); // 人が 1 チームのリーグ (コンピューター 3 チーム = 6 台)
    const e = rivalEntries(rv, 5, 77);
    expect(e).toEqual(rivalEntries(rv, 5, 77));
    expect(e).toHaveLength(5);
    expect(e[0].rivalId).toBe(e[1].rivalId);
    expect([e[0].driverIdx, e[1].driverIdx]).toEqual([0, 1]);
    expect(new Set(e.map((x) => `${x.rivalId}:${x.driverIdx}`)).size).toBe(5);
    expect(rivalEntries(rv, 100, 1)).toHaveLength(rv.length * 2);
  });
});
