import { describe, expect, it } from "vitest";
import { CREW, crewServiceFactor, crewSkill, crewPracticeFull, newCrew } from "../src/crew.ts";
import { applyMoneyMoves, seasonRemaining } from "../src/econ.ts";
import { dueNotices } from "../src/notify.ts";
import { PARTS } from "../src/parts.ts";
import {
  anyPartDef, availableResearch, buildCost, canManufacture, projectEta, projectProgress, RESEARCH, RESEARCH_DEFS, RESEARCH_PARTS,
  researchDef, researchDuration, researchNoticeSources,
} from "../src/research.ts";
import { seasonWindow } from "../src/season.ts";
import {
  cancelResearch, createTeam, emblemFromSeed, manufacture, recordPitStops, recordResearchRun, setEmblem, startResearch, tickResearch,
  upgradeCrew, validateEmblem, type Team,
} from "../src/team.ts";

const H = 3600_000;

function newTeam(id = "A"): Team {
  const r = createTeam({ id, now: 0, seed: 1 });
  if (!r.ok) throw new Error(r.error);
  return r.team;
}

describe("チーム", () => {
  it("作ると 紋章・空の 2 台・整備の組・研究がある。JSON にしても同じ", () => {
    const t = newTeam();
    expect(validateEmblem(t.emblem)).toBe(true);
    expect(t.cars).toEqual({ player: null, second: null });
    expect(t.crew).toEqual(newCrew());
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });

  it("紋章は 形 + 印 + 色 2 つ。おかしいものは受けない", () => {
    for (let s = 0; s < 50; s++) expect(validateEmblem(emblemFromSeed(s))).toBe(true);
    const t = newTeam();
    expect(setEmblem(t, { shape: "star" as never, color: "#ffffff", mark: "none", markColor: "#000000" })).toEqual({ ok: false, error: "bad_emblem" });
    expect(setEmblem(t, { shape: "circle", color: "red", mark: "none", markColor: "#000000" }).ok).toBe(false);
    expect(setEmblem(t, { shape: "circle", color: "#112233", mark: "bolt", markColor: "#112233" }).ok).toBe(false);
    expect(validateEmblem(null)).toBe(false);
    const ok = setEmblem(t, { shape: "shield", color: "#e10600", mark: "bolt", markColor: "#ffffff" });
    expect(ok.ok && ok.team.emblem.shape).toBe("shield");
  });

  it("お金の出入りはまとめて当て、どれかが負なら何もしない", () => {
    const w = { A: 100, B: 50 };
    const ok = applyMoneyMoves(w, [{ teamId: "A", amount: -100, reason: "market_buy" }, { teamId: "B", amount: 95, reason: "market_sale" }]);
    expect(ok.ok && ok.wallets).toEqual({ A: 0, B: 145 });
    expect(applyMoneyMoves(w, [{ teamId: "A", amount: -101, reason: "market_buy" }])).toEqual({ ok: false, error: "no_money" });
    expect(applyMoneyMoves(w, [{ teamId: "Z", amount: 1, reason: "prize" }])).toEqual({ ok: false, error: "not_found" });
    expect(applyMoneyMoves(w, [{ teamId: "A", amount: 0.5, reason: "prize" }])).toEqual({ ok: false, error: "bad_amount" });
    expect(w).toEqual({ A: 100, B: 50 });
  });

  it("季節の残り", () => {
    const s = seasonWindow(3);
    expect(seasonRemaining(s, s.startsAt)).toBe(1);
    expect(seasonRemaining(s, s.endsAt)).toBe(0);
    expect(seasonRemaining(s, s.endsAt + 1)).toBe(0);
  });
});

describe("整備の組", () => {
  it("はじめは今のピットの時間のまま (倍率 1)", () => {
    expect(crewServiceFactor(newCrew())).toBe(1);
  });

  it("ピットをこなすと速くなるが、段ごとの上限で止まる。設備を上げると先へ", () => {
    let t = newTeam();
    t = recordPitStops(t, 5);
    const f5 = crewServiceFactor(t.crew);
    expect(f5).toBeLessThan(1);
    t = recordPitStops(t, 1000);
    expect(crewPracticeFull(t.crew)).toBe(true);
    const capped = crewSkill(t.crew);
    expect(crewSkill(recordPitStops(t, 50).crew)).toBe(capped);
    const up = upgradeCrew(t, CREW.upgradeCost[1]);
    if (!up.ok) throw new Error(up.error);
    expect(up.cost).toBe(CREW.upgradeCost[1]);
    expect(crewSkill(up.team.crew)).toBeGreaterThan(capped);
  });

  it("お金がなければ上げられない、最後の段の先はない", () => {
    const t = newTeam();
    expect(upgradeCrew(t, 0)).toEqual({ ok: false, error: "no_money" });
    let x = t;
    for (let i = 1; i < CREW.maxLevel; i++) {
      const r = upgradeCrew(x, 1e9);
      if (!r.ok) throw new Error(r.error);
      x = r.team;
    }
    expect(x.crew.level).toBe(CREW.maxLevel);
    expect(upgradeCrew(x, 1e9)).toEqual({ ok: false, error: "already" });
    const best = crewServiceFactor(recordPitStops(x, 10000).crew);
    expect(best).toBeGreaterThanOrEqual(CREW.factorAt1);
    expect(best).toBeLessThan(0.7);
  });
});

describe("研究の表", () => {
  it("研究の部品は お店の部品と id が重ならず、PartDef の形で、段階 3〜5", () => {
    const shop = new Set(PARTS.map((p) => p.id));
    for (const p of RESEARCH_PARTS) {
      expect(shop.has(p.id)).toBe(false);
      expect(p.tier).toBeGreaterThanOrEqual(3);
      expect(p.tier).toBeLessThanOrEqual(5);
      expect(p.w).toBeGreaterThanOrEqual(1);
      expect(p.w * p.h).toBeLessThanOrEqual(7 * 11);
      expect(p.note.length).toBeGreaterThan(0);
      expect(anyPartDef(p.id)).toBe(p);
    }
    expect(new Set(RESEARCH_PARTS.map((p) => p.id)).size).toBe(RESEARCH_PARTS.length);
  });

  it("どの研究も前の段階からたどれ、元の部品はある", () => {
    for (const d of RESEARCH_DEFS) {
      if (d.part.tier === 3) expect(d.requires).toBeNull();
      else {
        const req = researchDef(d.requires!);
        expect(req).toBeDefined();
        expect(req!.part.tier).toBe(d.part.tier - 1);
        expect(req!.part.kind).toBe(d.part.kind);
      }
      for (const b of d.boost) expect(anyPartDef(b)).toBeDefined();
      expect(buildCost(d)).toBeGreaterThan(0);
    }
  });
});

describe("研究開発", () => {
  it("お金を入れて始め、寝ている間も進み、時刻が来たら終わる", () => {
    const t = newTeam();
    const id = "r_eng_p3";
    const cost = RESEARCH.cost[3];
    expect(startResearch(t, id, cost - 1, 0)).toEqual({ ok: false, error: "no_money" });
    const s = startResearch(t, id, cost, 1000);
    if (!s.ok) throw new Error(s.error);
    expect(s.cost).toBe(cost);
    const p = s.team.research.active[0];
    expect(projectEta(p)).toBe(1000 + researchDuration(researchDef(id)!));
    expect(projectProgress(p, 1000 + 3 * H)).toBeCloseTo(0.5);
    // まだ
    const mid = tickResearch(s.team, 1000 + 5 * H);
    expect(mid.events).toEqual([]);
    expect(mid.team).toBe(s.team);
    // 一晩たって開いた
    const done = tickResearch(s.team, 1000 + 30 * H);
    expect(done.events).toEqual([{ type: "research_done", teamId: "A", researchId: id, partId: "eng_p3", at: projectEta(p) }]);
    expect(done.team.research.done).toEqual([id]);
    expect(done.team.research.active).toEqual([]);
    expect(tickResearch(done.team, 1000 + 40 * H).events).toEqual([]);
  });

  it("同時に進められるのは slots 個。前の段階が終わるまで次は始められない", () => {
    const t = newTeam();
    expect(startResearch(t, "r_eng_p4", 1e9, 0)).toEqual({ ok: false, error: "locked" });
    expect(startResearch(t, "nope", 1e9, 0)).toEqual({ ok: false, error: "not_found" });
    const a = startResearch(t, "r_eng_p3", 1e9, 0);
    if (!a.ok) throw new Error();
    expect(startResearch(a.team, "r_eng_p3", 1e9, 0)).toEqual({ ok: false, error: "already" });
    expect(startResearch(a.team, "r_tire_n3", 1e9, 0)).toEqual({ ok: false, error: "busy" });
    const done = tickResearch(a.team, 100 * H).team;
    expect(availableResearch(done.research).map((d) => d.id)).toContain("r_eng_p4");
    expect(startResearch(done, "r_eng_p4", 1e9, 100 * H).ok).toBe(true);
  });

  it("元の部品を付けて走ると早く進む (上限あり)。関係ない部品では進まない", () => {
    const s = startResearch(newTeam(), "r_eng_p3", 1e9, 0);
    if (!s.ok) throw new Error();
    const p0 = s.team.research.active[0];
    expect(recordResearchRun(s.team, ["eng_s1", "tire_n1"], 10_000)).toBe(s.team);
    const t1 = recordResearchRun(s.team, ["eng_m1", "tire_n1"], 10_000);
    expect(projectEta(t1.research.active[0])).toBe(projectEta(p0) - 10 * RESEARCH.boostMsPerKm);
    let t = t1;
    for (let i = 0; i < 100; i++) t = recordResearchRun(t, ["eng_p2"], 50_000);
    const dur = researchDuration(researchDef("r_eng_p3")!);
    expect(projectEta(t.research.active[0])).toBe(dur * (1 - RESEARCH.boostCapRatio));
  });

  it("やめるとお金は返らない (仮)", () => {
    const s = startResearch(newTeam(), "r_eng_p3", 1e9, 0);
    if (!s.ok) throw new Error();
    const c = cancelResearch(s.team, "r_eng_p3");
    expect(c.ok && c.refund).toBe(0);
    expect(c.ok && c.team.research.active).toEqual([]);
    expect(cancelResearch(s.team, "r_x")).toEqual({ ok: false, error: "not_found" });
  });

  it("できた部品は お金を払って何個でも作れる", () => {
    const t0 = newTeam();
    expect(manufacture(t0, "eng_p3", 1, 1e9)).toEqual({ ok: false, error: "locked" });
    const s = startResearch(t0, "r_eng_p3", 1e9, 0);
    if (!s.ok) throw new Error();
    const t = tickResearch(s.team, 100 * H).team;
    expect(canManufacture(t.research, "eng_p3")).toBe(true);
    const unit = buildCost(researchDef("r_eng_p3")!);
    const m = manufacture(t, "eng_p3", 7, 7 * unit);
    expect(m.ok && m.cost).toBe(7 * unit);
    expect(m.ok && m.count).toBe(7);
    expect(manufacture(t, "eng_p3", 7, 7 * unit - 1)).toEqual({ ok: false, error: "no_money" });
    expect(manufacture(t, "eng_p3", 0, 1e9)).toEqual({ ok: false, error: "bad_amount" });
    expect(manufacture(t, "eng_s1", 1, 1e9)).toEqual({ ok: false, error: "locked" });
  });

  it("知らせ (notify.ts) につながる: 終わる時刻に「研究が終わった」", () => {
    const s = startResearch(newTeam(), "r_tire_n3", 1e9, 0);
    if (!s.ok) throw new Error();
    const src = { research: researchNoticeSources([s.team]) };
    const eta = projectEta(s.team.research.active[0]);
    expect(dueNotices(src, eta - 1)).toEqual([]);
    const n = dueNotices(src, eta);
    expect(n).toHaveLength(1);
    expect(n[0].kind).toBe("research_done");
    expect(n[0].to).toBe("A");
    expect(n[0].data.partName).toBe("粘るタイヤ");
  });
});
