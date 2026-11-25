// チーム: 1 人 = 1 チーム (アカウント 1 つ)。自分 (代表で運転手) と、お金で雇うコンピューターの運転手の 2 台で出る。
// ゲームのお金はチームの財布だけ。財布と表示名 (チーム名・運転手名) はアカウント (account.ts・サーバーの accounts) にあるので、
// ここでは持たない。ここにあるのは 紋章・2 台の設計図・整備の組・研究開発。
// お金のかかる関数は 今の財布 (funds) を受け取り、払うお金 (cost) を返す。呼ぶ側が財布から引く。
// 紋章は 色 + 簡単な形の組み合わせ (データだけ。描くのは画面)。
import { addPitStops, crewUpgradeCost, newCrew, type CrewState } from "./crew.ts";
import { fail, pick, seededRand, type Result } from "./econ.ts";
import {
  addResearchRun, advanceResearch, canManufacture, canStartResearch, manufactureCost, newResearch, researchCost, researchDef,
  RESEARCH, type ResearchState,
} from "./research.ts";

export const EMBLEM_SHAPES = ["circle", "square", "shield", "diamond", "hexagon", "triangle"] as const;
export const EMBLEM_MARKS = ["none", "star", "bolt", "stripe", "cross", "ring", "chevron", "dot", "wing", "wave"] as const;
export type EmblemShape = (typeof EMBLEM_SHAPES)[number];
export type EmblemMark = (typeof EMBLEM_MARKS)[number];

/** 紋章の色の候補 (仮。ほかの色も "#rrggbb" で使える) */
export const EMBLEM_COLORS = ["#e10600", "#ff8000", "#ffd400", "#00a651", "#00b5e2", "#0047bb", "#7a2bd6", "#ff4fa3", "#ffffff", "#9aa0a6", "#202124", "#00d2be"] as const;

export interface Emblem {
  /** 地の形と色 */
  shape: EmblemShape;
  color: string;
  /** 上に重ねる印と色 */
  mark: EmblemMark;
  markColor: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function validateEmblem(e: unknown): e is Emblem {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    (EMBLEM_SHAPES as readonly unknown[]).includes(x.shape) &&
    (EMBLEM_MARKS as readonly unknown[]).includes(x.mark) &&
    typeof x.color === "string" &&
    typeof x.markColor === "string" &&
    HEX.test(x.color) &&
    HEX.test(x.markColor) &&
    (x.mark === "none" || x.color.toLowerCase() !== x.markColor.toLowerCase())
  );
}

/** 種から紋章 (はじめの案・ライバルのチーム用) */
export function emblemFromSeed(seed: number): Emblem {
  const r = seededRand(seed, 77);
  const color = pick(r, EMBLEM_COLORS);
  let markColor = pick(r, EMBLEM_COLORS);
  if (markColor === color) markColor = color === "#ffffff" ? "#202124" : "#ffffff";
  return { shape: pick(r, EMBLEM_SHAPES), color, mark: pick(r, EMBLEM_MARKS.slice(1)), markColor };
}

export interface Team {
  /** アカウントの id (サーバーの accounts の id。ほかの人には見せない表示名とは別) */
  id: string;
  emblem: Emblem;
  /** 2 台の設計図 (設計図の保存は持ち物の番。ここでは id だけ) */
  cars: { player: string | null; second: string | null };
  crew: CrewState;
  research: ResearchState;
  createdAt: number;
}

export function createTeam(o: { id: string; now: number; emblem?: Emblem; seed?: number }): Result<{ team: Team }> {
  const emblem = o.emblem ?? emblemFromSeed(o.seed ?? o.now);
  if (!validateEmblem(emblem)) return fail("bad_emblem");
  return {
    ok: true,
    team: { id: o.id, emblem, cars: { player: null, second: null }, crew: newCrew(), research: newResearch(), createdAt: o.now },
  };
}

export function setEmblem(team: Team, emblem: Emblem): Result<{ team: Team }> {
  return validateEmblem(emblem) ? { ok: true, team: { ...team, emblem } } : fail("bad_emblem");
}

export function setCarDesign(team: Team, slot: "player" | "second", designId: string | null): Team {
  return { ...team, cars: { ...team.cars, [slot]: designId } };
}

// ---- 整備の組 ----

/** 整備の設備を 1 段上げる。返る cost を財布から引く */
export function upgradeCrew(team: Team, funds: number): Result<{ team: Team; cost: number }> {
  const cost = crewUpgradeCost(team.crew);
  if (cost === null) return fail("already");
  if (funds < cost) return fail("no_money");
  return { ok: true, team: { ...team, crew: { ...team.crew, level: team.crew.level + 1 } }, cost };
}

/** レースでこなしたピットの数を足す (2 台分まとめて) */
export function recordPitStops(team: Team, n: number): Team {
  const crew = addPitStops(team.crew, n);
  return crew === team.crew ? team : { ...team, crew };
}

// ---- 研究開発 ----

/** 研究を始める。返る cost を財布から引く */
export function startResearch(team: Team, researchId: string, funds: number, now: number): Result<{ team: Team; cost: number }> {
  const can = canStartResearch(team.research, researchId);
  if (can !== "ok") return fail(can);
  const cost = researchCost(researchDef(researchId)!);
  if (funds < cost) return fail("no_money");
  const research: ResearchState = { ...team.research, active: [...team.research.active, { researchId, startedAt: now, boostMs: 0, paid: cost }] };
  return { ok: true, team: { ...team, research }, cost };
}

/** 進めている研究をやめる (入れたお金は RESEARCH.cancelRefund の割合だけ返る。返る refund を財布に足す) */
export function cancelResearch(team: Team, researchId: string): Result<{ team: Team; refund: number }> {
  const p = team.research.active.find((x) => x.researchId === researchId);
  if (!p) return fail("not_found");
  const refund = Math.floor(p.paid * RESEARCH.cancelRefund);
  const research: ResearchState = { ...team.research, active: team.research.active.filter((x) => x !== p) };
  return { ok: true, team: { ...team, research }, refund };
}

/** 時刻を見て研究を進める (チームを開いたとき・知らせの見回りのときに呼ぶ。何度呼んでもよい) */
export function tickResearch(team: Team, now: number) {
  const r = advanceResearch(team.research, team.id, now);
  return { team: r.state === team.research ? team : { ...team, research: r.state }, events: r.events };
}

/** レース・練習で走ったあとに呼ぶ (付けていた部品と道のり m) */
export function recordResearchRun(team: Team, usedPartIds: readonly string[], distanceM: number): Team {
  const research = addResearchRun(team.research, usedPartIds, distanceM);
  return research === team.research ? team : { ...team, research };
}

/** 研究の終わった部品を count 個作る。返る cost を財布から引き、partId を count 個 持ち物に足す */
export function manufacture(team: Team, partId: string, count: number, funds: number): Result<{ cost: number; partId: string; count: number }> {
  if (!canManufacture(team.research, partId)) return fail("locked");
  const cost = manufactureCost(partId, count);
  if (cost === null) return fail("bad_amount");
  if (funds < cost) return fail("no_money");
  return { ok: true, cost, partId, count };
}
