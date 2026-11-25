// 名前のあるコンピューターのライバルチーム。性格 (雨に強い・無理に抜きに来る など) があり、
// 季節を通して点を競う。自動のリーグは 1部〜8部、1 つのリーグは 4 チーム (人 2 + コンピューター 2)。
// コンピューターのチームは 部とリーグの種で決まり、週をまたいで同じリーグに残る。上の部ほど強い。
// 毎日少しずつ育ち、お金をためて部品の段階を上げる (週の合計は前と同じ。季節の切れ目に遅れすぎたら追いつく)。
// 性格は bot.ts の運転に効く数 (RivalStyle) として持つ。BotBrain に入るのは skill と走る線のずれだけで、
// ほかの数 (抜きの強さ・すり減りなど) は bot.ts / physics.ts が使えるように返しておく。
import { makeBrain, type BotBrain } from "./bot.ts";
import type { CarDesign } from "./design.ts";
import { DRIVER_CATALOG, type CatalogDriver } from "./drivercatalog.ts";
import {
  applySpecialties, catalogDriver, driverOverall, driverTraits, growDriver, makeDriver, specCarScales, specialtyEffects, STAT_KEYS, type Driver,
} from "./drivers.ts";
import { pick, seededRand } from "./econ.ts";
import type { DevPartKind, PartDef } from "./parts.ts";
import { ALL_PART_DEFS, anyPartDef } from "./research.ts";
import { emblemFromSeed, type Emblem } from "./team.ts";

/** ライバルの仮の数 */
export const RIVAL = {
  /** 1 つのリーグのコンピューターのチームの数 (4 チームのうち 人 2。league.ts の LEAGUE_CPUS)。人が 1 チームのリーグは 3 を頼む */
  perLeague: 2,
  /** 部の数 (1 部が一番上) */
  divisions: 8,
  /** 部ごとの はじめの部品の段階 (この段階より下には下がらない。添字 = 部) */
  divisionTier: [0, 4, 4, 3, 3, 2, 2, 1, 1] as readonly number[],
  /** 1 部の運転手の能力に足す数 (8 部で 0、部が上がるごとに等しく増える。100 まで) */
  topDivisionStatBonus: 28,
  /** 段階を上げるお金 (添字 = 上げた先の段階) */
  tierCost: { 2: 2000, 3: 6000, 4: 15000, 5: 40000 } as Readonly<Record<number, number>>,
  /** 季節ごとに入るお金 (土台 + 点ごと。遊ぶ人の財布とは別の、ライバルだけの数) */
  seasonIncome: 3000,
  incomePerPoint: 30,
  /** 遊ぶ人の平均の段階より これ以上遅れたら、その差まで追いつく (スポンサーがついた扱い) */
  maxTierLag: 1,
  /** 遊ぶ人の平均の段階より これ以上は先に行かない */
  maxTierLead: 1,
  /** 季節ごとに伸びしろが増える (練習した扱い。100 まで) */
  potentialPerSeason: 3,
  /** 季節の中で育つ回数の上限 (レースの数がこれより多くても) */
  maxGrowthRaces: 30,
  /** skill の範囲 (bot.ts は 0.7..0.95 を想定。ライバルは少し上まで) */
  skillMin: 0.7,
  skillMax: 0.97,
  /** 運転手が名簿 (drivercatalog.ts のふつうの運転手) から来る割合。残りは作りもの (仮) */
  catalogShare: 0.6,
} as const;

export type PersonalityId = "rain" | "aggressive" | "steady" | "saver" | "flier" | "defender";

/** 性格が運転に効く数。1 (倍率) か 0 (足す数) が今の bot のまま */
export interface RivalStyle {
  /** 乾いた路面・濡れた路面で skill に足す数 (濡れ具合で混ぜる) */
  skillDry: number;
  skillWet: number;
  /** ふらつき・ミスの倍率 */
  mistakeScale: number;
  /** タイヤのすり減り・燃料の使い方の倍率 */
  wearScale: number;
  fuelScale: number;
  /** 抜きに行く強さ (前を見る長さ・詰める差・よける幅の倍率)。1.5 なら無理にでも抜きに来る */
  passAggression: number;
  /** 後ろの車を抑える強さ (0 = 何もしない、1 = 線を変えて抑える) */
  defend: number;
  /** 天気が変わるときに タイヤを替えに入る早さ (0 = 今の bot、1 = 予報を見てすぐ) */
  pitEarly: number;
  /** 部品の選び方 (team の車を組むときの重み) */
  parts: PartTaste;
}

export interface PartTaste {
  power: number;
  economy: number;
  grip: number;
  downforce: number;
  lowDrag: number;
  brake: number;
  light: number;
}

export interface PersonalityDef {
  id: PersonalityId;
  name: string;
  note: string;
  style: RivalStyle;
}

const TASTE: PartTaste = { power: 1, economy: 0.3, grip: 1, downforce: 1, lowDrag: 1, brake: 1, light: 0.5 };

export const PERSONALITIES: Readonly<Record<PersonalityId, PersonalityDef>> = {
  rain: {
    id: "rain", name: "雨に強い", note: "濡れた路面で速く、天気の変わり目に早めにタイヤを替える",
    style: { skillDry: -0.01, skillWet: 0.05, mistakeScale: 0.9, wearScale: 1, fuelScale: 1, passAggression: 1, defend: 0.3, pitEarly: 0.9, parts: { ...TASTE, grip: 1.6, downforce: 1.5, lowDrag: 0.6 } },
  },
  aggressive: {
    id: "aggressive", name: "無理に抜きに来る", note: "前の車に詰めて強引に抜く。ミスとすり減りが多い",
    style: { skillDry: 0.02, skillWet: 0, mistakeScale: 1.3, wearScale: 1.12, fuelScale: 1.05, passAggression: 1.6, defend: 0.4, pitEarly: 0.2, parts: { ...TASTE, power: 1.6, brake: 1.5, economy: 0.1 } },
  },
  steady: {
    id: "steady", name: "堅実", note: "速さは控えめだがミスが少なく、壁に当たらない",
    style: { skillDry: -0.01, skillWet: 0.01, mistakeScale: 0.55, wearScale: 0.97, fuelScale: 1, passAggression: 0.8, defend: 0.5, pitEarly: 0.5, parts: { ...TASTE, light: 0.8 } },
  },
  saver: {
    id: "saver", name: "タイヤを持たせる", note: "タイヤと燃料を長く持たせ、ピットを減らす",
    style: { skillDry: -0.015, skillWet: 0, mistakeScale: 0.85, wearScale: 0.82, fuelScale: 0.9, passAggression: 0.9, defend: 0.4, pitEarly: 0.3, parts: { ...TASTE, economy: 1.6, power: 0.8 } },
  },
  flier: {
    id: "flier", name: "一発の速さ", note: "1 周は速いがタイヤを食う。予選が得意",
    style: { skillDry: 0.03, skillWet: -0.02, mistakeScale: 1.15, wearScale: 1.15, fuelScale: 1.05, passAggression: 1.2, defend: 0.2, pitEarly: 0.3, parts: { ...TASTE, power: 1.4, lowDrag: 1.5, downforce: 0.7 } },
  },
  defender: {
    id: "defender", name: "守りが固い", note: "後ろの車に線をふさいで抜かせない",
    style: { skillDry: 0, skillWet: 0, mistakeScale: 0.9, wearScale: 1, fuelScale: 1, passAggression: 0.9, defend: 1, pitEarly: 0.4, parts: { ...TASTE, lowDrag: 1.4, brake: 1.3 } },
  },
};

export const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];

export interface RivalSeasonRecord {
  season: number;
  points: number;
  rank: number;
}

export interface RivalTeam {
  id: string;
  /** 部 (1..8) */
  division: number;
  name: string;
  emblem: Emblem;
  personality: PersonalityId;
  /** 2 人の運転手 (候補の運転手と同じ形。契約はない) */
  drivers: [Driver, Driver];
  /** 使える部品の段階 (1..5) */
  partTier: number;
  /** 部品に使うお金 */
  budget: number;
  /** 今の季節の点と、今の季節に出たレースの数 */
  seasonPoints: number;
  seasonRaces: number;
  history: RivalSeasonRecord[];
  /** 今の季節に済ませた毎日の小分け (advanceRivalDay)。前に作ったライバルには無い = まだ 0 日 */
  daily?: RivalDailyProgress;
}

/** 毎日の小分けの進み (季節の切れ目で消す) */
export interface RivalDailyProgress {
  /** 済ませた日の数 (0..RIVAL_DAYS_PER_SEASON) */
  days: number;
  /** 育ちに数えたレースの数 */
  grown: number;
  /** お金に換えた点 */
  paidPoints: number;
}

/** 1 季節 (= 1 週) の日の数。毎日の小分けはこの数で割る */
export const RIVAL_DAYS_PER_SEASON = 7;

const NAME_A = ["北辰", "白鴉", "紅鷺", "群青", "銀狐", "黒潮", "琥珀", "鉄紺", "夜鷹", "翠玉", "砂鉄", "朱鷺", "藍染", "霜月"];
const NAME_B = ["レーシング", "モータース", "ワークス", "工房", "自動車部", "製作所", "走行会", "機械団"];

/** 部の強さ (8 部で 0、1 部で 1) */
export function divisionStrength(division: number): number {
  const d = Math.max(1, Math.min(RIVAL.divisions, Math.round(division)));
  return (RIVAL.divisions - d) / (RIVAL.divisions - 1);
}

/**
 * リーグのコンピューターのチームを作る (部とリーグの種が同じなら同じチーム)。
 * 上の部ほど 運転手が強く、部品の段階が高い。性格はリーグの中で重ならない (6 チームまで)。
 * count を増やしても前のほうのチームは同じ (人が 1 チームのリーグは 3 チーム要る)。
 */
export function createRivals(leagueSeed: number, division: number, count: number = RIVAL.perLeague): RivalTeam[] {
  const div = Math.max(1, Math.min(RIVAL.divisions, Math.round(division)));
  const seed = Math.floor(leagueSeed) * 16 + div;
  const r = seededRand(seed, 500);
  const bonus = Math.round(RIVAL.topDivisionStatBonus * divisionStrength(div));
  const pers = [...PERSONALITY_IDS];
  for (let i = pers.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pers[i], pers[j]] = [pers[j], pers[i]];
  }
  const names = new Set<string>();
  const dnames = new Set<string>();
  // 名簿の運転手 (別の乱数なので チーム名・性格・紋章は前と同じ)。リーグの中では重ならない
  const rd = seededRand(seed, 501);
  const cat = DRIVER_CATALOG.filter((e) => !e.rare);
  const order = cat.map((_, j) => j);
  for (let j = order.length - 1; j > 0; j--) {
    const x = Math.floor(rd() * (j + 1));
    [order[j], order[x]] = [order[x], order[j]];
  }
  let ci = 0;
  const out: RivalTeam[] = [];
  for (let i = 0; i < count; i++) {
    let name = `${pick(r, NAME_A)}${pick(r, NAME_B)}`;
    for (let k = 0; names.has(name) && k < 30; k++) name = `${pick(r, NAME_A)}${pick(r, NAME_B)}`;
    if (names.has(name)) name = `${name}${i + 1}`;
    names.add(name);
    const mk = (k: number): Driver => {
      const proc = makeDriver(seed + 7919, i * 2 + k, dnames);
      const d = ci < order.length && rd() < RIVAL.catalogShare ? rivalFromCatalog(cat[order[ci++]], proc) : proc;
      dnames.add(d.name);
      const stats = { ...d.stats };
      const potential = { ...d.potential };
      for (const key of STAT_KEYS) {
        stats[key] = Math.min(100, stats[key] + bonus);
        potential[key] = Math.min(100, potential[key] + bonus);
      }
      return { ...d, id: `rv${div}_${leagueSeed}_${i}_${k}`, stats, potential };
    };
    out.push({
      id: `rv${div}_${leagueSeed}_${i}`,
      division: div,
      name,
      emblem: emblemFromSeed(seed * 31 + i),
      personality: pers[i % pers.length],
      drivers: [mk(0), mk(1)],
      partTier: RIVAL.divisionTier[div],
      budget: 0,
      seasonPoints: 0,
      seasonRaces: 0,
      history: [],
    });
  }
  return out;
}

/**
 * 名簿の運転手をライバルに: 名前・国・年代・得意・能力の形 (どれが得意か) は名簿から、
 * 強さ (総合) と伸びしろは その席の作りものの運転手と同じにする (部ごとの強さの釣り合いを前のままに)
 */
function rivalFromCatalog(e: CatalogDriver, proc: Driver): Driver {
  const c = catalogDriver(e);
  const delta = driverOverall(proc.stats) - driverOverall(c.stats);
  const stats = { ...c.stats };
  const potential = { ...c.stats };
  for (const k of STAT_KEYS) {
    stats[k] = Math.max(5, Math.min(100, Math.round(c.stats[k] + delta)));
    potential[k] = Math.min(100, stats[k] + Math.max(0, proc.potential[k] - proc.stats[k]));
  }
  return { ...c, stats, potential };
}

/** ライバルの運転手の得意から来る車の倍率 (得意がなければ空 = 今のまま。性格のすり減りはここに入れない) */
export function rivalCarScales(rv: RivalTeam, driverIdx: 0 | 1) {
  return specCarScales(rv.drivers[driverIdx].specs);
}

export function rivalStyle(rv: RivalTeam): RivalStyle {
  return PERSONALITIES[rv.personality].style;
}

/** その濡れ具合 (0..1) での skill (運転手の能力 + 性格) */
export function rivalSkill(rv: RivalTeam, driverIdx: 0 | 1, wetness: number): number {
  const st = rivalStyle(rv);
  const w = Math.max(0, Math.min(1, wetness));
  const base = driverTraits(rv.drivers[driverIdx].stats).skill;
  return Math.max(RIVAL.skillMin, Math.min(RIVAL.skillMax, base + st.skillDry * (1 - w) + st.skillWet * w));
}

/** 運転に効く数をまとめて (運転手の能力 × 性格) */
export function rivalDriveParams(rv: RivalTeam, driverIdx: 0 | 1, wetness: number) {
  const st = rivalStyle(rv);
  const t = driverTraits(rv.drivers[driverIdx].stats);
  const fx = specialtyEffects(rv.drivers[driverIdx].specs);
  return {
    skill: rivalSkill(rv, driverIdx, wetness),
    mistakeScale: t.mistakeScale * st.mistakeScale,
    wearScale: t.wearScale * st.wearScale * fx.wearScale,
    fuelScale: t.fuelScale * st.fuelScale * fx.fuelScale,
    passAggression: st.passAggression * fx.passAggression,
    defend: Math.max(st.defend, fx.defend),
    pitSense: Math.min(1, Math.max(t.pitSense, st.pitEarly)),
  };
}

/**
 * ライバルの運転手の頭 (bot.ts の makeBrain)。skill はスタートの濡れ具合で決める。
 * 途中で天気が変わったら rivalSkill で brain.skill を直してよい。
 * 無理に抜く性格は走る線のずれを小さく (前の車の真後ろに付く)、守る性格は道の真ん中寄りに。
 */
export function rivalBrain(rv: RivalTeam, driverIdx: 0 | 1, rand: () => number, wetness = 0): BotBrain {
  const st = rivalStyle(rv);
  const b = makeBrain(rand, rivalSkill(rv, driverIdx, wetness));
  const offset = b.offset / Math.max(0.5, st.passAggression) * (1 - 0.5 * st.defend);
  // 運転手の得意 (前に作って保存したライバルには無い = 今のまま)
  return applySpecialties({ ...b, offset }, rv.drivers[driverIdx].specs);
}

// ---- 部品と車 ----

/** 性格から見た部品の点 (同じ種類・同じ形どうしで比べる) */
export function partScore(p: PartDef, t: PartTaste): number {
  const light = -p.mass * 0.05 * t.light;
  switch (p.kind) {
    case "engine": {
      const power = p.power ?? 0;
      return power * t.power - power * ((p.fuelUse ?? 1) - 1) * 0.6 * t.economy + light;
    }
    case "tire":
      return (p.grip ?? 0) * 60 * t.grip + light;
    case "tank":
      return (p.fuel ?? 0) * (0.5 + 0.5 * t.economy) + light;
    case "wing":
      return (p.downforce ?? 0) * 20 * t.downforce - (p.drag ?? 0) * 200 * t.lowDrag + light;
    case "brake":
      return (p.brake ?? 0) * 3 * t.brake + light;
    // 研究で開発する種類 (rivalDesign が骨組みと入れ替える)
    case "cooler":
      return (p.cool ?? 0) * 300 * t.economy + light;
    case "battery":
      return (p.battery ?? 0) * 8 * t.power + light;
    case "gearbox":
      return (p.shift ?? 0) * 400 * t.power + light;
    case "susp":
      return (p.susp ?? 0) * 40 * t.grip + light;
    default:
      return light;
  }
}

/** ライバルが選べる部品: お店・研究・進化の部品 (限界を超えた部品は使わない。DECISIONS 11/25「コンピューターのチームは使わない」) */
const ALL_PARTS: readonly PartDef[] = ALL_PART_DEFS.filter((p) => !p.limit);

/** 段階 tier までの、同じ種類・同じ形の部品から いちばん好みのもの */
export function bestPartLike(def: PartDef, tier: number, t: PartTaste): PartDef {
  if (def.kind === "seat" || def.kind === "frame") return def;
  let best = def;
  let bestS = def.tier <= tier ? partScore(def, t) : -Infinity;
  for (const p of ALL_PARTS) {
    if (p.kind !== def.kind || p.w !== def.w || p.h !== def.h || p.tier > tier) continue;
    const s = partScore(p, t);
    if (s > bestS + 1e-9) {
      best = p;
      bestS = s;
    }
  }
  return best;
}

/**
 * ライバルの車: 元の設計図 (presets の BOT_DESIGNS など) の部品を、
 * 使える段階までの 同じ形の部品に性格で選んで置き換える (形が同じなので置き方は正しいまま)。
 */
export function rivalDesign(rv: RivalTeam, base: CarDesign): CarDesign {
  const taste = rivalStyle(rv).parts;
  const parts = base.parts.map((pl) => {
    const def = anyPartDef(pl.id);
    return def ? { ...pl, id: bestPartLike(def, rv.partTier, taste).id } : { ...pl };
  });
  // 段階 3 から (研究の木が開ける部): 性格の好きな新しい種類を 1 つ、骨組み 1 マスと入れ替える (同じ 1 マスなので つながりはそのまま)
  const kind = RIVAL_DEV_KIND[rv.personality];
  if (rv.partTier >= RIVAL_DEV_FROM_TIER && kind) {
    const pick = bestDevPart(kind, rv.partTier, taste);
    const fi = parts.findIndex((pl) => pl.id === "frame");
    if (pick && fi >= 0) parts[fi] = { ...parts[fi], id: pick.id, rot: 0 };
  }
  return { name: `${rv.name}`, parts };
}

/** ライバルが新しい種類の部品を使い始める段階 (仮) */
export const RIVAL_DEV_FROM_TIER = 3;
/** 性格ごとに好きな新しい種類 (仮。重りと ギア箱はコンピューター (オートマ) にはほぼ効かないので使わない) */
export const RIVAL_DEV_KIND: Readonly<Record<PersonalityId, DevPartKind>> = {
  rain: "susp",
  aggressive: "battery",
  steady: "susp",
  saver: "cooler",
  flier: "battery",
  defender: "cooler",
};

/** 段階 tier までの その種類の 1 マスの部品から いちばん好みのもの */
export function bestDevPart(kind: DevPartKind, tier: number, t: PartTaste): PartDef | null {
  let best: PartDef | null = null;
  let bestS = -Infinity;
  for (const p of ALL_PARTS) {
    if (p.kind !== kind || p.w !== 1 || p.h !== 1 || p.tier > tier) continue;
    const s = partScore(p, t);
    if (s > bestS + 1e-9) {
      best = p;
      bestS = s;
    }
  }
  return best;
}

// ---- 季節 ----

/** レースの点を足す (普段のレース・大会のどちらも。2 台分の合計を渡す) */
export function addRivalPoints(rivals: readonly RivalTeam[], rivalId: string, points: number): RivalTeam[] {
  return rivals.map((rv) => (rv.id === rivalId ? { ...rv, seasonPoints: rv.seasonPoints + points, seasonRaces: rv.seasonRaces + 1 } : rv));
}

/** 季節の順位 (点の多い順、同じなら id 順) */
export function rivalStandings(rivals: readonly RivalTeam[]): RivalTeam[] {
  return [...rivals].sort((a, b) => b.seasonPoints - a.seasonPoints || a.id.localeCompare(b.id));
}

export interface RivalSeasonInput {
  /** 終わった季節の番号 */
  season: number;
  /** 遊ぶ人のチームの 部品の段階の平均 (例: 車に付いている部品の段階の平均) と、雇った運転手の総合の平均 */
  fieldTier: number;
  fieldOverall?: number;
}

/** total を RIVAL_DAYS_PER_SEASON 日に分けたときの k 日目 (0 から) の分。7 日分を足すと total ちょうど */
function daySlice(total: number, k: number): number {
  const n = RIVAL_DAYS_PER_SEASON;
  if (k < 0 || k >= n) return 0;
  return Math.floor(((k + 1) * total) / n) - Math.floor((k * total) / n);
}

/** 1 チームの 1 日分 (order = 今の季節の順位、n = チームの数) */
function rivalDayStep(rv: RivalTeam, rank: number, n: number, o: RivalSeasonInput): RivalTeam {
  const prog: RivalDailyProgress = rv.daily ?? { days: 0, grown: 0, paidPoints: 0 };
  const k = prog.days;
  const place = n > 1 ? 1 - (rank - 1) / (n - 1) : 1;
  // 運転手: その日までに出たレースの分だけ育つ (季節の上限まで)
  const races = Math.max(0, Math.min(RIVAL.maxGrowthRaces, rv.seasonRaces) - prog.grown);
  const grow = (d: Driver): Driver => {
    let x = d;
    for (let i = 0; i < races; i++) {
      x = growDriver(x, { position: Math.round(1 + (1 - place) * 7), cars: 8, finished: true, wallHits: rv.personality === "aggressive" ? 1 : 0, laps: 5, pitStops: 1 });
    }
    // 伸びしろ: 季節の分を日に分けて足す (遊ぶ人の運転手より弱ければ多めに)
    const behind = o.fieldOverall !== undefined && driverOverall(x.stats) < o.fieldOverall - 5;
    const add = daySlice(RIVAL.potentialPerSeason * (behind ? 2 : 1), k);
    if (!add) return x;
    const potential = { ...x.potential };
    for (const key of STAT_KEYS) potential[key] = Math.min(100, potential[key] + add);
    return { ...x, potential };
  };
  // お金: 土台を日に分けて + その日までに取った点の分。たまったら部品の段階を上げる (先に行きすぎない)
  let budget = rv.budget + daySlice(RIVAL.seasonIncome, k) + Math.max(0, rv.seasonPoints - prog.paidPoints) * RIVAL.incomePerPoint;
  let partTier = rv.partTier;
  const maxTier = Math.min(5, Math.max(1, Math.floor(o.fieldTier + RIVAL.maxTierLead)));
  while (partTier < maxTier && budget >= RIVAL.tierCost[partTier + 1]) {
    budget -= RIVAL.tierCost[partTier + 1];
    partTier++;
  }
  return {
    ...rv,
    drivers: [grow(rv.drivers[0]), grow(rv.drivers[1])],
    partTier,
    budget,
    daily: { days: k + 1, grown: prog.grown + races, paidPoints: Math.max(prog.paidPoints, rv.seasonPoints) },
  };
}

/**
 * 日の締め (11/25「毎日少しずつ」): 季節の分 (運転手の育ち・伸びしろ・お金・部品の段階) を 7 日に分けて 1 日分進める。
 * 種を使わないので同じ入力なら同じ。季節の切れ目の advanceRivalSeason が残りの日を済ませるので、週の合計は前と同じ。
 * 季節の日の数を超えて呼んでも、土台のお金と伸びしろは足さない (育ちと点の分だけ)
 */
export function advanceRivalDay(rivals: readonly RivalTeam[], o: RivalSeasonInput): RivalTeam[] {
  const order = rivalStandings(rivals);
  return rivals.map((rv) => rivalDayStep(rv, order.findIndex((x) => x.id === rv.id) + 1, rivals.length, o));
}

/**
 * 季節の切れ目: 残りの日の分を済ませ (毎日の小分けを 1 回も呼んでいなければ 7 日分 = 前の週ごとの上げ方と同じ)、
 * 遊ぶ人より遅れすぎたら追いつき、記録を残して点を 0 に戻す。
 */
export function advanceRivalSeason(rivals: readonly RivalTeam[], o: RivalSeasonInput): RivalTeam[] {
  const order = rivalStandings(rivals);
  const n = rivals.length;
  return rivals.map((rv0) => {
    const rank = order.findIndex((x) => x.id === rv0.id) + 1;
    let rv = rv0;
    do rv = rivalDayStep(rv, rank, n, o);
    while ((rv.daily?.days ?? 0) < RIVAL_DAYS_PER_SEASON);
    let partTier = rv.partTier;
    const minTier = Math.min(5, Math.max(RIVAL.divisionTier[rv.division] ?? 1, Math.ceil(o.fieldTier - RIVAL.maxTierLag)));
    if (partTier < minTier) partTier = minTier;
    const { daily: _done, ...rest } = rv;
    return {
      ...rest,
      partTier,
      seasonPoints: 0,
      seasonRaces: 0,
      history: [...rv.history, { season: o.season, points: rv0.seasonPoints, rank }],
    };
  });
}

/**
 * レースの空きを埋めるライバルの車を選ぶ (種で決まる)。同じチームの 2 台はなるべく一緒に出す。
 * 返すのは [ライバルの id, 運転手の番号]。
 */
export function rivalEntries(rivals: readonly RivalTeam[], slots: number, seed: number): Array<{ rivalId: string; driverIdx: 0 | 1 }> {
  const r = seededRand(seed, 900);
  const order = [...rivals];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out: Array<{ rivalId: string; driverIdx: 0 | 1 }> = [];
  for (const rv of order) {
    for (const k of [0, 1] as const) if (out.length < slots) out.push({ rivalId: rv.id, driverIdx: k });
  }
  return out;
}
