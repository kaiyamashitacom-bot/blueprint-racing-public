// 研究開発: お金を入れて時間を待つと新しい部品 (段階 3〜5) ができる。寝ている間も進む
// (始めた時刻から数えるので、刻みで進める必要がない)。
// 元になる部品 (boost) を付けて走ると早く進む。できた部品は お金を払って何個でも作れる。
// 研究は木の形: 段階 3 は お店の部品から、段階 4 は段階 3 から、段階 5 は段階 4 から。
import type { NoticeSources } from "./notify.ts";
import { EVOLVED_PARTS, limitBrokenDef, parseLimitId } from "./evoparts.ts";
import type { PartDef } from "./parts.ts";
import { PARTS, partDef } from "./parts.ts";

/** 研究の仮の数 */
export const RESEARCH = {
  /** 同時に進められる研究の数 */
  slots: 1,
  /** 段階ごとの 研究のお金と待つ時間 (ms)。段階 3 は 3,000 → 2,000 (はじめの何レースかで届くように。QA 2 回目) */
  cost: { 3: 2000, 4: 10000, 5: 30000 } as Readonly<Record<number, number>>,
  durationMs: { 3: 6 * 3600_000, 4: 18 * 3600_000, 5: 48 * 3600_000 } as Readonly<Record<number, number>>,
  /** 1 個作るお金 = 種類の土台 × 段階の倍率 (お店の段階 2 の値段より上になるように) */
  buildKindBase: { seat: 300, frame: 10, engine: 300, tire: 80, tank: 80, wing: 120, brake: 60, cooler: 100, battery: 140, gearbox: 140, susp: 100, ballast: 20 } as Readonly<Record<string, number>>,
  buildTierMul: { 3: 5, 4: 10, 5: 20 } as Readonly<Record<number, number>>,
  /** 元の部品を付けて 1 km 走ると縮む時間 (ms) */
  boostMsPerKm: 10 * 60_000,
  /** 走って縮められるのは 待つ時間のこの割合まで */
  boostCapRatio: 0.5,
  /** 途中でやめたときに返るお金の割合 */
  cancelRefund: 0,
} as const;

export interface ResearchDef {
  id: string;
  /** できる部品 (parts.ts の PartDef と同じ形) */
  part: PartDef;
  /** 先に終わっている要る研究 (段階 3 は null) */
  requires: string | null;
  /** 付けて走ると研究が早く進む部品 (お店の部品か、前の段階の研究の部品) */
  boost: readonly string[];
}

const P = (p: PartDef): PartDef => p;

/** 研究でできる部品 (段階 3〜5、性格ちがい)。数は仮 */
export const RESEARCH_PARTS: readonly PartDef[] = [
  // エンジン: 高回転の線・節約の線・軽さの線
  P({ id: "eng_p3", kind: "engine", name: "競技エンジン", tier: 3, w: 2, h: 3, mass: 115, power: 150, fuelUse: 1.5, note: "とても速いが燃料を食う" }),
  P({ id: "eng_e3", kind: "engine", name: "長距離エンジン", tier: 3, w: 2, h: 2, mass: 60, power: 78, fuelUse: 0.6, note: "燃料がとても長もち" }),
  P({ id: "eng_l3", kind: "engine", name: "軽量エンジン", tier: 3, w: 2, h: 2, mass: 48, power: 72, fuelUse: 1, note: "軽い。力はほどほど" }),
  P({ id: "eng_p4", kind: "engine", name: "競技エンジン改", tier: 4, w: 2, h: 3, mass: 118, power: 175, fuelUse: 1.5, note: "もっと速い。燃料はやはり食う" }),
  P({ id: "eng_e4", kind: "engine", name: "長距離エンジン改", tier: 4, w: 2, h: 2, mass: 56, power: 95, fuelUse: 0.6, note: "節約したまま力が増えた" }),
  P({ id: "eng_l4", kind: "engine", name: "羽根のようなエンジン", tier: 4, w: 2, h: 2, mass: 40, power: 88, fuelUse: 1, note: "とても軽い。力はほどほど" }),
  P({ id: "eng_p5", kind: "engine", name: "頂点エンジン", tier: 5, w: 2, h: 3, mass: 120, power: 200, fuelUse: 1.45, note: "いちばん速い" }),
  P({ id: "eng_b5", kind: "engine", name: "名機エンジン", tier: 5, w: 2, h: 2, mass: 62, power: 130, fuelUse: 0.85, note: "速さと燃費の釣り合い" }),
  // タイヤ: 細い線・太い線
  P({ id: "tire_n3", kind: "tire", name: "粘るタイヤ", tier: 3, w: 1, h: 2, mass: 11, grip: 1.25, trait: "rain", note: "細いのによく握る。雨に強い" }),
  P({ id: "tire_w3", kind: "tire", name: "軽い太タイヤ", tier: 3, w: 2, h: 2, mass: 18, grip: 1.9, trait: "kerb", note: "太いタイヤを軽く。縁石に強い" }),
  P({ id: "tire_n4", kind: "tire", name: "粘るタイヤ改", tier: 4, w: 1, h: 2, mass: 10, grip: 1.38, trait: "brake", note: "軽くてよく握る。ブレーキに強い" }),
  P({ id: "tire_w4", kind: "tire", name: "競技の太タイヤ", tier: 4, w: 2, h: 2, mass: 20, grip: 2.15, trait: "long", note: "とてもよく握るが重め。長持ち" }),
  P({ id: "tire_n5", kind: "tire", name: "頂点タイヤ", tier: 5, w: 1, h: 2, mass: 9, grip: 1.5, trait: "corner", note: "細いタイヤのいちばん。曲がりに強い" }),
  P({ id: "tire_w5", kind: "tire", name: "頂点の太タイヤ", tier: 5, w: 2, h: 2, mass: 19, grip: 2.4, trait: "bite", note: "太いタイヤのいちばん。よく食いつく" }),
  // タンク
  P({ id: "tank_l3", kind: "tank", name: "軽いタンク", tier: 3, w: 2, h: 2, mass: 8, fuel: 36, note: "36 L。大きいタンクを軽く" }),
  P({ id: "tank_f3", kind: "tank", name: "薄いタンク", tier: 3, w: 1, h: 2, mass: 5, fuel: 18, note: "18 L。小さなすき間に" }),
  P({ id: "tank_l4", kind: "tank", name: "長距離タンク", tier: 4, w: 2, h: 3, mass: 12, fuel: 55, note: "55 L。長いレース用" }),
  P({ id: "tank_f4", kind: "tank", name: "細長いタンク改", tier: 4, w: 1, h: 3, mass: 6, fuel: 28, note: "28 L。すき間に入る" }),
  P({ id: "tank_l5", kind: "tank", name: "頂点タンク", tier: 5, w: 2, h: 2, mass: 8, fuel: 50, note: "50 L を 4 マスに" }),
  // 羽根: 抵抗の少ない線・押しつけの線
  P({ id: "wing_s3", kind: "wing", name: "低抵抗の羽根", tier: 3, w: 3, h: 1, mass: 5, downforce: 1.2, drag: 0.05, note: "最高速を落とさず曲がりやすく" }),
  P({ id: "wing_l3", kind: "wing", name: "強い羽根", tier: 3, w: 5, h: 1, mass: 10, downforce: 2.2, drag: 0.14, note: "よく押しつけるが遅くなる" }),
  P({ id: "wing_s4", kind: "wing", name: "低抵抗の羽根改", tier: 4, w: 3, h: 1, mass: 5, downforce: 1.6, drag: 0.06, note: "速さと曲がりの両方" }),
  P({ id: "wing_l4", kind: "wing", name: "強い羽根改", tier: 4, w: 5, h: 1, mass: 10, downforce: 2.6, drag: 0.13, note: "曲がりの多いコース向け" }),
  P({ id: "wing_b5", kind: "wing", name: "頂点の羽根", tier: 5, w: 4, h: 1, mass: 7, downforce: 2.3, drag: 0.07, note: "押しつけと抵抗の釣り合い" }),
  // ブレーキ
  P({ id: "brake_3", kind: "brake", name: "競技ブレーキ", tier: 3, w: 1, h: 1, mass: 7, brake: 10, note: "よく止まる" }),
  P({ id: "brake_l3", kind: "brake", name: "軽いブレーキ", tier: 3, w: 1, h: 1, mass: 4, brake: 8, note: "軽いがよく止まる" }),
  P({ id: "brake_4", kind: "brake", name: "競技ブレーキ改", tier: 4, w: 1, h: 1, mass: 7, brake: 12, note: "とてもよく止まる" }),
  P({ id: "brake_5", kind: "brake", name: "頂点ブレーキ", tier: 5, w: 1, h: 1, mass: 6, brake: 14, note: "いちばん止まる" }),
  // ---- 研究の木で開発する新しい種類 (お店に並ばない。11/25「部品は進化と研究で広げる」) ----
  // 冷却: 全開での燃料の食い方を減らす (熱のしくみは無いので、燃料の持ちで表す)
  P({ id: "cool_3", kind: "cooler", name: "冷却器", tier: 3, w: 1, h: 1, mass: 5, cool: 0.05, note: "全開での燃料の食い方が 5% 減る" }),
  P({ id: "cool_4", kind: "cooler", name: "大きい冷却器", tier: 4, w: 1, h: 2, mass: 8, cool: 0.09, note: "燃料の食い方が 9% 減る (燃費寄り)" }),
  P({ id: "cool_4l", kind: "cooler", name: "軽い冷却器", tier: 4, w: 1, h: 1, mass: 3, cool: 0.06, note: "軽い。燃料の食い方が 6% 減る (軽さ寄り)" }),
  P({ id: "cool_5", kind: "cooler", name: "頂点の冷却器", tier: 5, w: 1, h: 2, mass: 6, cool: 0.12, note: "燃料の食い方が 12% 減る" }),
  // 電池: オーバーテイクの目盛りを足す
  P({ id: "batt_3", kind: "battery", name: "電池", tier: 3, w: 1, h: 1, mass: 6, battery: 1.5, note: "オーバーテイクの目盛りが 1 周 +1.5 秒" }),
  P({ id: "batt_4", kind: "battery", name: "大きい電池", tier: 4, w: 2, h: 1, mass: 10, battery: 3, note: "目盛り +3 秒。2 マスで重め (量寄り)" }),
  P({ id: "batt_4l", kind: "battery", name: "軽い電池", tier: 4, w: 1, h: 1, mass: 4, battery: 2, note: "目盛り +2 秒。軽い (軽さ寄り)" }),
  P({ id: "batt_5", kind: "battery", name: "頂点の電池", tier: 5, w: 2, h: 1, mass: 7, battery: 4, note: "目盛り +4 秒" }),
  // ギア箱: マニュアルの速さの上がり分を足す (オートマはほんの少し力が上がるだけ)
  P({ id: "gear_3", kind: "gearbox", name: "ギア箱", tier: 3, w: 1, h: 1, mass: 6, shift: 0.01, note: "マニュアルで速さ +1%。オートマはほぼ変わらない" }),
  P({ id: "gear_4", kind: "gearbox", name: "速いギア箱", tier: 4, w: 1, h: 1, mass: 6, shift: 0.016, note: "マニュアルで速さ +1.6% (速さ寄り)" }),
  P({ id: "gear_4t", kind: "gearbox", name: "頑丈なギア箱", tier: 4, w: 1, h: 1, mass: 7, shift: 0.013, sturdy: 0.5, note: "マニュアルで速さ +1.3%。傷みにくい (頑丈)" }),
  P({ id: "gear_5", kind: "gearbox", name: "頂点のギア箱", tier: 5, w: 1, h: 1, mass: 5, shift: 0.022, note: "マニュアルで速さ +2.2%" }),
  // サスペンション: 縁石と芝で握りが落ちにくく、揺れ (抵抗) が少ない
  P({ id: "susp_3", kind: "susp", name: "サスペンション", tier: 3, w: 1, h: 1, mass: 5, susp: 0.25, note: "縁石と芝で握りの落ちと揺れが 25% 減る" }),
  P({ id: "susp_4", kind: "susp", name: "縁石用サスペンション", tier: 4, w: 1, h: 2, mass: 9, susp: 0.4, note: "縁石と芝に強い (40%)。重め (縁石寄り)" }),
  P({ id: "susp_4l", kind: "susp", name: "軽いサスペンション", tier: 4, w: 1, h: 1, mass: 3, susp: 0.3, note: "軽い。30% (軽さ寄り)" }),
  P({ id: "susp_5", kind: "susp", name: "頂点のサスペンション", tier: 5, w: 1, h: 1, mass: 4, susp: 0.5, note: "縁石と芝の落ちが半分" }),
  // 重り: 重心を動かすためだけ (ほかの働きはない)。段階が上がるほど 1 マスに重い
  P({ id: "ballast_3", kind: "ballast", name: "重り", tier: 3, w: 1, h: 1, mass: 10, note: "10 kg。重心を動かすだけ" }),
  P({ id: "ballast_4", kind: "ballast", name: "鉛の重り", tier: 4, w: 1, h: 1, mass: 20, note: "20 kg を 1 マスに" }),
  P({ id: "ballast_5", kind: "ballast", name: "濃い重り", tier: 5, w: 1, h: 1, mass: 30, note: "30 kg を 1 マスに" }),
];

const RP = new Map(RESEARCH_PARTS.map((p) => [p.id, p]));
const rp = (id: string): PartDef => {
  const p = RP.get(id);
  if (!p) throw new Error(`研究の部品がない: ${id}`);
  return p;
};
const D = (partId: string, requires: string | null, boost: string[]): ResearchDef => ({ id: `r_${partId}`, part: rp(partId), requires, boost });

/** 研究の表 (研究の id = "r_" + 部品の id) */
export const RESEARCH_DEFS: readonly ResearchDef[] = [
  D("eng_p3", null, ["eng_p2", "eng_m1"]),
  D("eng_e3", null, ["eng_e2"]),
  D("eng_l3", null, ["eng_s1"]),
  D("eng_p4", "r_eng_p3", ["eng_p3"]),
  D("eng_e4", "r_eng_e3", ["eng_e3"]),
  D("eng_l4", "r_eng_l3", ["eng_l3"]),
  D("eng_p5", "r_eng_p4", ["eng_p4"]),
  D("eng_b5", "r_eng_e4", ["eng_e4", "eng_l4"]),
  D("tire_n3", null, ["tire_l2", "tire_n1"]),
  D("tire_w3", null, ["tire_w1"]),
  D("tire_n4", "r_tire_n3", ["tire_n3"]),
  D("tire_w4", "r_tire_w3", ["tire_w3"]),
  D("tire_n5", "r_tire_n4", ["tire_n4"]),
  D("tire_w5", "r_tire_w4", ["tire_w4"]),
  D("tank_l3", null, ["tank_l1"]),
  D("tank_f3", null, ["tank_f2", "tank_s1"]),
  D("tank_l4", "r_tank_l3", ["tank_l3"]),
  D("tank_f4", "r_tank_f3", ["tank_f3"]),
  D("tank_l5", "r_tank_l4", ["tank_l4"]),
  D("wing_s3", null, ["wing_s1"]),
  D("wing_l3", null, ["wing_l2"]),
  D("wing_s4", "r_wing_s3", ["wing_s3"]),
  D("wing_l4", "r_wing_l3", ["wing_l3"]),
  D("wing_b5", "r_wing_s4", ["wing_s4", "wing_l4"]),
  D("brake_3", null, ["brake_2"]),
  D("brake_l3", null, ["brake_1", "brake_2"]),
  D("brake_4", "r_brake_3", ["brake_3", "brake_l3"]),
  D("brake_5", "r_brake_4", ["brake_4"]),
  // 新しい種類 (段階 3 は根。段階 4 は 2 つに分かれ、段階 5 は片方の先)
  D("cool_3", null, ["eng_p2", "eng_m1"]),
  D("cool_4", "r_cool_3", ["cool_3"]),
  D("cool_4l", "r_cool_3", ["cool_3"]),
  D("cool_5", "r_cool_4", ["cool_4", "cool_4l"]),
  D("batt_3", null, ["eng_e2", "eng_s1"]),
  D("batt_4", "r_batt_3", ["batt_3"]),
  D("batt_4l", "r_batt_3", ["batt_3"]),
  D("batt_5", "r_batt_4", ["batt_4", "batt_4l"]),
  D("gear_3", null, ["eng_m1", "eng_s1"]),
  D("gear_4", "r_gear_3", ["gear_3"]),
  D("gear_4t", "r_gear_3", ["gear_3"]),
  D("gear_5", "r_gear_4", ["gear_4", "gear_4t"]),
  D("susp_3", null, ["tire_w1", "tire_n1"]),
  D("susp_4", "r_susp_3", ["susp_3"]),
  D("susp_4l", "r_susp_3", ["susp_3"]),
  D("susp_5", "r_susp_4", ["susp_4", "susp_4l"]),
  D("ballast_3", null, ["frame"]),
  D("ballast_4", "r_ballast_3", ["ballast_3"]),
  D("ballast_5", "r_ballast_4", ["ballast_4"]),
];

const RD = new Map(RESEARCH_DEFS.map((d) => [d.id, d]));
const RD_BY_PART = new Map(RESEARCH_DEFS.map((d) => [d.part.id, d]));

export function researchDef(id: string): ResearchDef | undefined {
  return RD.get(id);
}

export function researchDefForPart(partId: string): ResearchDef | undefined {
  return RD_BY_PART.get(partId);
}

const EP = new Map(EVOLVED_PARTS.map((p) => [p.id, p]));
const LIMIT_CACHE = new Map<string, PartDef | null>();

/** お店の部品 (parts.ts)・研究の部品・進化でだけできる部品 (evoparts.ts)・限界を超えた部品 (…_x1・…_x2) から探す */
export function anyPartDef(id: string): PartDef | undefined {
  const d = partDef(id) ?? RP.get(id) ?? EP.get(id);
  if (d) return d;
  if (typeof id !== "string") return undefined;
  let lim = LIMIT_CACHE.get(id);
  if (lim === undefined) {
    const p = parseLimitId(id);
    const base = p ? (partDef(p.base) ?? RP.get(p.base) ?? EP.get(p.base)) : undefined;
    lim = base && p ? limitBrokenDef(base, p.level) : null;
    if (LIMIT_CACHE.size < 1000) LIMIT_CACHE.set(id, lim);
  }
  return lim ?? undefined;
}

/** 全部の部品 (お店・研究・進化。限界を超えた部品は入れない) */
export const ALL_PART_DEFS: readonly PartDef[] = [...PARTS, ...RESEARCH_PARTS, ...EVOLVED_PARTS];

export const researchCost = (d: ResearchDef): number => RESEARCH.cost[d.part.tier];
export const researchDuration = (d: ResearchDef): number => RESEARCH.durationMs[d.part.tier];
export const buildCost = (d: ResearchDef): number => (RESEARCH.buildKindBase[d.part.kind] ?? 100) * RESEARCH.buildTierMul[d.part.tier];

export interface ResearchProject {
  researchId: string;
  startedAt: number;
  /** 走って縮めた時間 (ms) */
  boostMs: number;
  /** 入れたお金 */
  paid: number;
}

export interface ResearchState {
  active: ResearchProject[];
  /** 終わった研究の id (この部品を作れる) */
  done: string[];
}

export function newResearch(): ResearchState {
  return { active: [], done: [] };
}

/** 終わる時刻 (ms) */
export function projectEta(p: ResearchProject): number {
  const d = researchDef(p.researchId);
  return p.startedAt + (d ? researchDuration(d) : 0) - p.boostMs;
}

/** 進み具合 (0..1) */
export function projectProgress(p: ResearchProject, now: number): number {
  const d = researchDef(p.researchId);
  if (!d) return 1;
  const total = researchDuration(d);
  return Math.max(0, Math.min(1, (now - p.startedAt + p.boostMs) / total));
}

/** その研究を始められるか (お金は別に見る) */
export function canStartResearch(state: ResearchState, researchId: string): "ok" | "not_found" | "already" | "locked" | "busy" {
  const d = researchDef(researchId);
  if (!d) return "not_found";
  if (state.done.includes(researchId) || state.active.some((p) => p.researchId === researchId)) return "already";
  if (d.requires && !state.done.includes(d.requires)) return "locked";
  if (state.active.length >= RESEARCH.slots) return "busy";
  return "ok";
}

/** 今始められる研究の一覧 (画面の表に) */
export function availableResearch(state: ResearchState): ResearchDef[] {
  return RESEARCH_DEFS.filter((d) => canStartResearch(state, d.id) === "ok");
}

/** 研究を進める (時刻を見て終わったものを done へ)。いつ呼んでもよい (寝ている間の分もまとめて) */
export function advanceResearch(state: ResearchState, teamId: string, now: number): { state: ResearchState; events: Array<{ type: "research_done"; teamId: string; researchId: string; partId: string; at: number }> } {
  const events: Array<{ type: "research_done"; teamId: string; researchId: string; partId: string; at: number }> = [];
  const still: ResearchProject[] = [];
  const done = [...state.done];
  for (const p of state.active) {
    const eta = projectEta(p);
    if (eta <= now) {
      done.push(p.researchId);
      events.push({ type: "research_done", teamId, researchId: p.researchId, partId: researchDef(p.researchId)?.part.id ?? "", at: eta });
    } else still.push(p);
  }
  if (!events.length) return { state, events };
  return { state: { active: still, done }, events };
}

/**
 * レースや練習で走った分を研究に足す。usedPartIds は車に付いていた部品の id (重なってよい)、distanceM は走った道のり (m)。
 * 付いていた部品が研究の boost にあれば、待つ時間が縮む (上限あり)。
 */
export function addResearchRun(state: ResearchState, usedPartIds: readonly string[], distanceM: number): ResearchState {
  if (!(distanceM > 0) || !state.active.length) return state;
  const used = new Set(usedPartIds);
  let changed = false;
  const active = state.active.map((p) => {
    const d = researchDef(p.researchId);
    if (!d || !d.boost.some((id) => used.has(id))) return p;
    const cap = researchDuration(d) * RESEARCH.boostCapRatio;
    const boostMs = Math.min(cap, p.boostMs + (distanceM / 1000) * RESEARCH.boostMsPerKm);
    if (boostMs === p.boostMs) return p;
    changed = true;
    return { ...p, boostMs };
  });
  return changed ? { ...state, active } : state;
}

/** その部品を作れるか (研究が終わっている) */
export function canManufacture(state: ResearchState, partId: string): boolean {
  const d = researchDefForPart(partId);
  return !!d && state.done.includes(d.id);
}

/** count 個作るお金 (研究の部品でなければ null) */
export function manufactureCost(partId: string, count: number): number | null {
  const d = researchDefForPart(partId);
  if (!d || !(count > 0) || !Number.isInteger(count)) return null;
  return buildCost(d) * count;
}

/** notify.ts の知らせの もと (研究が終わった)。teams はチームの id と研究 */
export function researchNoticeSources(teams: ReadonlyArray<{ id: string; research: ResearchState }>): NonNullable<NoticeSources["research"]> {
  const out: Array<{ jobId: string; teamId: string; partName: string; doneAt: number }> = [];
  for (const t of teams) {
    for (const p of t.research.active) {
      out.push({ jobId: `${t.id}:${p.researchId}:${p.startedAt}`, teamId: t.id, partName: researchDef(p.researchId)?.part.name ?? p.researchId, doneAt: projectEta(p) });
    }
  }
  return out;
}
