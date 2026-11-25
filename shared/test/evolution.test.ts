// 部品の進化・研究で開発する新しい種類・限界突破の品 (DECISIONS 11/25「部品は進化と研究で広げる」「限界突破の品」)
import { describe, expect, it } from "vitest";
import {
  ALL_PART_DEFS,
  BOT_DESIGNS,
  COACH_MAX,
  DEV_PART_KINDS,
  EVOLUTIONS,
  GIFT_KINDS,
  ITEM_DEFS,
  ITEM_IDS,
  LIMIT_GAIN,
  OT_ENERGY,
  PRIZE_ITEMS,
  RESEARCH_DEFS,
  SAMPLE_DESIGN,
  SHARDS_PER_ITEM,
  addItem,
  advanceChampionStreak,
  anyPartDef,
  applyImpact,
  canEvolve,
  checkGiftItem,
  cleanInventory,
  coachDriver,
  computeStats,
  convertShards,
  createCar,
  createRivals,
  evolutionsFrom,
  evolvePart,
  evolveCost,
  getTrack,
  giftFieldOptions,
  giftKind,
  giftPartChoices,
  itemCount,
  limitBreak,
  makeDriver,
  newResearch,
  nextLimitId,
  otEnergyMax,
  removeItem,
  rivalDesign,
  stepCar,
  updateOvertake,
  validateDesign,
  type CarDesign,
  type Placed,
} from "../src/index.ts";

const P = (id: string, c: number, r: number, rot: 0 | 1 = 0): Placed => ({ id, c, r, rot });
/** 見本の車の骨組み (3,3) を id に替える */
const withPart = (id: string, c = 3, r = 3): CarDesign => ({ name: id, parts: SAMPLE_DESIGN.parts.map((p) => (p.c === c && p.r === r ? { ...p, id } : { ...p })) });

describe("進化の道すじ", () => {
  it("元も先も本当の部品で、段階は 1〜5、先は元より上", () => {
    for (const r of EVOLUTIONS) {
      const a = anyPartDef(r.from);
      const b = anyPartDef(r.to);
      expect(a, r.id).toBeTruthy();
      expect(b, r.id).toBeTruthy();
      expect(a!.kind).toBe(b!.kind);
      expect(b!.tier).toBeGreaterThan(a!.tier);
      expect(b!.tier).toBeLessThanOrEqual(5);
      if (r.requires) expect(RESEARCH_DEFS.some((d) => d.id === r.requires), r.id).toBe(true);
      expect(evolveCost(r)).toBeGreaterThan(0);
    }
    expect(new Set(EVOLUTIONS.map((r) => r.id)).size).toBe(EVOLUTIONS.length);
  });

  it("枝分かれ: 中型エンジンは 力寄り / 頑丈 に分かれ、性格がちがう", () => {
    const outs = evolutionsFrom("eng_m1");
    expect(outs.map((r) => r.to).sort()).toEqual(["eng_m2", "eng_p2"]);
    expect(outs.map((r) => r.branch).sort()).toEqual(["力寄り", "頑丈"]);
    expect(anyPartDef("eng_m2")!.sturdy).toBeGreaterThan(0);
    expect(anyPartDef("eng_p2")!.power).toBeGreaterThan(anyPartDef("eng_m2")!.power!);
  });

  it("形が変わる進化がある (競技エンジン 2×3 → 詰めた 2×2)", () => {
    const shaped = EVOLUTIONS.filter((r) => {
      const a = anyPartDef(r.from)!;
      const b = anyPartDef(r.to)!;
      return a.w !== b.w || a.h !== b.h;
    });
    expect(shaped.some((r) => r.id === "e_eng_p3_eng_c4")).toBe(true);
  });

  it("お金 + 済んだ研究で 1 つ出て 1 つ入る", () => {
    const inv = { eng_p2: 2, eng_m1: 1 };
    const st = newResearch();
    expect(canEvolve("e_eng_p2_eng_p3", inv, st, 1e6)).toBe("locked");
    const done = { ...st, done: ["r_eng_p3"] };
    const cost = evolveCost(EVOLUTIONS.find((r) => r.id === "e_eng_p2_eng_p3")!);
    expect(canEvolve("e_eng_p2_eng_p3", inv, done, cost - 1)).toBe("no_money");
    const r = evolvePart("e_eng_p2_eng_p3", inv, done, cost);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cost).toBe(cost);
    expect(r.inventory).toEqual({ eng_p2: 1, eng_m1: 1, eng_p3: 1 });
    // 段階 2 の先はお金だけ
    expect(canEvolve("e_eng_m1_eng_m2", inv, st, 1e6)).toBe("ok");
    // 持っていない
    expect(canEvolve("e_eng_s1_eng_s2", inv, st, 1e6)).toBe("no_part");
    expect(canEvolve("nope", inv, st, 1e6)).toBe("not_found");
  });

  it("進化でできた部品も設計図に置けて走れる", () => {
    const d: CarDesign = { name: "x", parts: SAMPLE_DESIGN.parts.map((p) => (p.id === "eng_m1" ? { ...p, id: "eng_m2" } : { ...p })) };
    expect(validateDesign(d)).toEqual([]);
    expect(computeStats(d).power).toBeGreaterThan(computeStats(SAMPLE_DESIGN).power);
  });
});

describe("研究で開発する新しい種類", () => {
  it("どの種類も研究の木にあり (お店にない)、段階 3〜5", () => {
    for (const k of DEV_PART_KINDS) {
      const defs = RESEARCH_DEFS.filter((d) => d.part.kind === k);
      expect(defs.length, k).toBeGreaterThanOrEqual(3);
      expect(defs.every((d) => d.part.tier >= 3 && d.part.tier <= 5)).toBe(true);
      expect(defs.some((d) => d.requires === null)).toBe(true);
    }
  });

  it("置いていなければ 性能は前と同じ (新しい数は付かない)", () => {
    for (const d of [SAMPLE_DESIGN, ...BOT_DESIGNS]) {
      const st = computeStats(d);
      expect(st.otExtra).toBeUndefined();
      expect(st.shiftBonus).toBeUndefined();
      expect(st.susp).toBeUndefined();
      expect(st.cool).toBeUndefined();
    }
  });

  it("骨組みと入れ替えても つながりと運転席の決まりはそのまま", () => {
    for (const id of ["cool_3", "batt_3", "gear_3", "susp_3", "ballast_3"]) expect(validateDesign(withPart(id)), id).toEqual([]);
    // 離れたところに置くと つながりで断られる
    const lone: CarDesign = { name: "x", parts: [...SAMPLE_DESIGN.parts.map((p) => ({ ...p })), P("ballast_3", 0, 5)] };
    expect(validateDesign(lone)).toContain("運転席とつながっていない部品があります");
  });

  it("冷却: 燃料の食い方が減る (力は同じ)", () => {
    const a = computeStats(SAMPLE_DESIGN);
    const b = computeStats(withPart("cool_3"));
    expect(b.cool).toBeCloseTo(0.05);
    expect(b.fuelRate).toBeCloseTo(a.fuelRate * 0.95);
    expect(b.power).toBe(a.power);
  });

  it("電池: オーバーテイクの目盛りが増える", () => {
    const track = getTrack("aozu");
    const st = computeStats(withPart("batt_3"));
    expect(st.otExtra).toBeCloseTo(1.5);
    const car = createCar(track, st, 0);
    expect(otEnergyMax(car)).toBeCloseTo(OT_ENERGY + 1.5);
    // 前の車と近くて周を終えたら 目盛りが満タン (+1.5 秒)
    car.dist = track.length - 0.5;
    const prev = car.dist;
    car.dist = track.length + 0.5;
    car.vx = 40;
    updateOvertake(car, track, prev, [track.length + 10], true);
    expect(car.ot!.energy).toBeCloseTo(OT_ENERGY + 1.5);
    expect(otEnergyMax(createCar(track, computeStats(SAMPLE_DESIGN), 0))).toBe(OT_ENERGY);
  });

  it("ギア箱: マニュアルの上がり分を足す。オートマは力がほんの少し", () => {
    const a = computeStats(SAMPLE_DESIGN);
    const b = computeStats(withPart("gear_3"));
    expect(b.shiftBonus).toBeCloseTo(0.01);
    expect(b.power / a.power).toBeCloseTo(1.0015, 4);
    // 同じ速さ・同じ段で マニュアルだと加速が大きい
    const track = getTrack("aozu");
    const run = (st: typeof a) => {
      const car = createCar(track, st, 0);
      car.started = true;
      for (let i = 0; i < 120; i++) stepCar(car, { steer: 0, throttle: 1, brake: 0, gear: 1 }, st, track);
      return Math.hypot(car.vx, car.vy);
    };
    expect(run({ ...b, power: a.power })).toBeGreaterThan(run(a));
  });

  it("サスペンション: 縁石と芝で 握りの落ちが減る", () => {
    const track = getTrack("aozu");
    const a = computeStats(SAMPLE_DESIGN);
    const b = { ...a, susp: 0.5 };
    // 芝の上に置いて 横へ滑らせ、横の速さが消える早さで比べる
    const slide = (st: typeof a) => {
      const car = createCar(track, st, 0);
      car.started = true;
      const nx = Math.cos(car.heading + Math.PI / 2);
      const ny = Math.sin(car.heading + Math.PI / 2);
      car.x += nx * 13;
      car.y += ny * 13;
      car.vx = Math.cos(car.heading) * 15 + nx * 6;
      car.vy = Math.sin(car.heading) * 15 + ny * 6;
      stepCar(car, { steer: 0, throttle: 0, brake: 0 }, st, track);
      // 前へ進む速さ (芝の抵抗が少ないほど落ちない)
      return { surface: car.surface, slip: car.slip, v: car.vx * Math.cos(car.heading) + car.vy * Math.sin(car.heading) };
    };
    const ra = slide(a);
    const rb = slide(b);
    expect(ra.surface).toBe("grass");
    expect(rb.slip).toBeLessThan(ra.slip);
    expect(rb.v).toBeGreaterThan(ra.v);
  });

  it("重り: 重さと重心だけ", () => {
    const a = computeStats(SAMPLE_DESIGN);
    const b = computeStats(withPart("ballast_5"));
    expect(b.mass - a.mass).toBeCloseTo(30 - 4);
    expect(b.power).toBe(a.power);
    expect(b.fuelRate).toBe(a.fuelRate);
    expect(b.comR).not.toBeCloseTo(a.comR, 3);
  });

  it("頑丈: 当たったときの傷みが少ない", () => {
    const st = computeStats(SAMPLE_DESIGN);
    const st2 = { ...st, layout: st.layout!.map((p) => ({ ...p, sturdy: 0.5 })) };
    const track = getTrack("aozu");
    const hit = (s: typeof st) => {
      const car = createCar(track, s, 0);
      const ev = applyImpact(car, s, Math.cos(car.heading), Math.sin(car.heading), 12);
      return car.damage!.parts[ev!.part];
    };
    expect(hit(st2)).toBeCloseTo(hit(st) * 0.5);
  });
});

describe("限界突破", () => {
  it("段階 5 だけ、2 回 (5+・5++) まで、1 回 +4%", () => {
    expect(nextLimitId("eng_p3")).toBeNull();
    expect(nextLimitId("ballast_5")).toBeNull();
    expect(nextLimitId("eng_p5")).toBe("eng_p5_x1");
    expect(nextLimitId("eng_p5_x1")).toBe("eng_p5_x2");
    expect(nextLimitId("eng_p5_x2")).toBeNull();
    const base = anyPartDef("eng_p5")!;
    const x2 = anyPartDef("eng_p5_x2")!;
    expect(x2.limit).toBe(2);
    expect(x2.tier).toBe(5);
    expect(x2.power).toBeCloseTo(base.power! * (1 + LIMIT_GAIN) ** 2, 1);
    expect(x2.w).toBe(base.w);
    expect(anyPartDef("eng_p5_x3")).toBeUndefined();
    expect(anyPartDef("eng_p3_x1")).toBeUndefined();
  });

  it("部品 1 つ + 限界設計図 1 つ → 超えた部品 1 つ", () => {
    const inv = { eng_p5: 1, [ITEM_IDS.limitBlueprint]: 1 };
    const r = limitBreak("eng_p5", inv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inventory).toEqual({ eng_p5_x1: 1 });
    const again = limitBreak("eng_p5_x1", r.inventory);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("no_item");
    expect(limitBreak("eng_p3", { eng_p3: 1, [ITEM_IDS.limitBlueprint]: 1 })).toEqual({ ok: false, error: "max" });
    // 置けて走れる
    const d: CarDesign = { name: "x", parts: SAMPLE_DESIGN.parts.map((p) => (p.id === "eng_m1" ? { ...p, id: "eng_p5_x2" } : { ...p })) };
    expect(validateDesign(d)).toEqual([]);
  });
});

describe("限界突破の品", () => {
  it("持ち物に入り、cleanInventory でも残る", () => {
    const a = addItem({ seat: 1 }, ITEM_IDS.coachBook, 2);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(itemCount(a.inventory, ITEM_IDS.coachBook)).toBe(2);
    expect(cleanInventory({ ...a.inventory, nope: 3 })).toEqual({ seat: 1, [ITEM_IDS.coachBook]: 2 });
    expect(removeItem(a.inventory, ITEM_IDS.coachBook, 3)).toEqual({ ok: false, error: "no_item" });
    expect(addItem({}, "eng_p5", 1)).toEqual({ ok: false, error: "bad_item" });
  });

  it("かけら 10 個 = 品 1 つ", () => {
    const inv = { [ITEM_IDS.limitShard]: SHARDS_PER_ITEM * 2 + 3 };
    const r = convertShards(inv, ITEM_IDS.limitShard, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.made).toBe(ITEM_IDS.limitBlueprint);
    expect(r.inventory).toEqual({ [ITEM_IDS.limitShard]: 3, [ITEM_IDS.limitBlueprint]: 2 });
    expect(convertShards(r.inventory, ITEM_IDS.limitShard, 1)).toEqual({ ok: false, error: "no_item" });
    const c = convertShards({ [ITEM_IDS.coachShard]: 10 }, ITEM_IDS.coachShard);
    expect(c.ok && c.inventory).toEqual({ [ITEM_IDS.coachBook]: 1 });
    expect(convertShards(inv, ITEM_IDS.limitBlueprint).ok).toBe(false);
  });

  it("特別指導書: 伸びしろ +5 (100 まで)、1 人に 2 回まで", () => {
    let d = makeDriver(1, 0);
    d = { ...d, potential: { ...d.potential, speed: 98 } };
    const a = coachDriver(d);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.driver.potential.speed).toBe(100);
    expect(a.driver.potential.stability).toBe(d.potential.stability + 5 > 100 ? 100 : d.potential.stability + 5);
    expect(a.driver.stats).toEqual(d.stats);
    let x = a.driver;
    for (let i = 1; i < COACH_MAX; i++) {
      const r = coachDriver(x);
      expect(r.ok).toBe(true);
      if (r.ok) x = r.driver;
    }
    expect(coachDriver(x)).toEqual({ ok: false, error: "max" });
  });

  it("王者を 7 日続けて守ると景品 (7・14 日目)", () => {
    let s = null as ReturnType<typeof advanceChampionStreak>["streak"] | null;
    const awards: number[] = [];
    for (let day = 1; day <= 15; day++) {
      const r = advanceChampionStreak(s, "5");
      s = r.streak;
      if (r.award) awards.push(day);
    }
    expect(awards).toEqual([7, 14]);
    expect(advanceChampionStreak(s, "6").streak.days).toBe(1);
    expect(advanceChampionStreak(s, null).streak.days).toBe(0);
  });

  it("景品の表: 設計図か指導書、数は DECISIONS のとおり", () => {
    expect(PRIZE_ITEMS.overallConstructor.count).toBe(2);
    expect(PRIZE_ITEMS.overallDriver.count).toBe(2);
    expect(PRIZE_ITEMS.classConstructor.count).toBe(1);
    for (const p of Object.values(PRIZE_ITEMS)) expect([ITEM_IDS.limitBlueprint, ITEM_IDS.coachBook]).toContain(p.item);
  });
});

describe("ギフトコードの登録表", () => {
  it("品・かけらが中身に選べる", () => {
    const k = giftKind("item")!;
    expect(GIFT_KINDS.some((x) => x.id === "item")).toBe(true);
    const opts = giftFieldOptions(k.fields[0]).map((o) => o.value);
    for (const d of ITEM_DEFS) expect(opts).toContain(d.id);
    const c = checkGiftItem({ kind: "item", p: { item: ITEM_IDS.limitShard, count: 10 } });
    expect(c.ok).toBe(true);
  });

  it("進化の部品・新しい種類・限界を超えた部品も 部品の中身に並ぶ", () => {
    const ids = giftPartChoices().map((p) => p.id);
    for (const id of ["eng_m2", "tire_x4", "cool_3", "batt_5", "gear_4t", "susp_5", "ballast_4", "eng_p5_x1", "eng_p5_x2", "batt_5_x2"]) expect(ids, id).toContain(id);
    expect(ids).not.toContain("ballast_5_x1");
    expect(ALL_PART_DEFS.every((p) => ids.includes(p.id))).toBe(true);
    expect(checkGiftItem({ kind: "part", p: { part: "eng_p5_x2", count: 1 } }).ok).toBe(true);
  });
});

describe("コンピューターのチーム", () => {
  it("上の部は 進化・新しい種類の部品を使い、限界を超えた部品は使わない", () => {
    const base = BOT_DESIGNS[0];
    for (const div of [1, 4, 8]) {
      for (const rv of createRivals(3, div, 6)) {
        const d = rivalDesign(rv, base);
        expect(validateDesign(d), `${div} ${rv.personality}`).toEqual([]);
        const defs = d.parts.map((p) => anyPartDef(p.id)!);
        expect(defs.some((x) => x.limit)).toBe(false);
        const dev = defs.some((x) => (DEV_PART_KINDS as readonly string[]).includes(x.kind));
        expect(dev).toBe(rv.partTier >= 3);
      }
    }
  });
});
