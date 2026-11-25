// 整備の組 (ピットの組): チームに 1 つ。設備の段 (お金で上げる) と、こなしたピットの数 (慣れ) で腕が決まる。
// 慣れで上がる分には段ごとの上限があり、上限を超えるには設備を上げる (お金 + ピットの両方が要る)。
// 腕からピットで止まる時間の倍率を出す (pit.ts の serviceTime に掛けて使う想定)。

/** 整備の組の仮の数 */
export const CREW = {
  /** 段の数 (1 から) */
  maxLevel: 5,
  /** 段 L から L+1 へ上げるお金 (添字 = 今の段)。1 段目は 1,000 → 800 (はじめのお金で届くように。QA 2 回目) */
  upgradeCost: [0, 800, 2500, 6000, 15000] as readonly number[],
  /** 段ごとの土台の腕 (0..1、添字 = 段) */
  levelSkill: [0, 0, 0.12, 0.28, 0.46, 0.66] as readonly number[],
  /** ピット 1 回で増える慣れ */
  practicePerStop: 0.01,
  /** 慣れの上限 (段 1 で 0.1、1 段ごとに +0.05) */
  practiceCapBase: 0.1,
  practiceCapPerLevel: 0.05,
  /** 止まる時間の倍率: 腕 0 で 1 (今の pit.ts のまま)、腕 1 で 0.6 */
  factorAt0: 1,
  factorAt1: 0.6,
} as const;

export interface CrewState {
  /** 設備の段 (1..maxLevel) */
  level: number;
  /** これまでにこなしたピットの数 (段を上げても消えない) */
  stops: number;
}

export function newCrew(): CrewState {
  return { level: 1, stops: 0 };
}

export function practiceCap(level: number): number {
  return CREW.practiceCapBase + CREW.practiceCapPerLevel * (level - 1);
}

/** 腕 (0..1) */
export function crewSkill(crew: CrewState): number {
  const lv = Math.max(1, Math.min(CREW.maxLevel, crew.level));
  const practice = Math.min(crew.stops * CREW.practicePerStop, practiceCap(lv));
  return Math.max(0, Math.min(1, CREW.levelSkill[lv] + practice));
}

/** ピットで止まる時間の倍率 (小さいほど速い) */
export function crewServiceFactor(crew: CrewState): number {
  return CREW.factorAt0 + (CREW.factorAt1 - CREW.factorAt0) * crewSkill(crew);
}

/** 次の段へ上げるお金 (上げられないとき null) */
export function crewUpgradeCost(crew: CrewState): number | null {
  return crew.level >= CREW.maxLevel ? null : CREW.upgradeCost[crew.level];
}

/** レースでこなしたピットを足す (2 台分まとめてよい) */
export function addPitStops(crew: CrewState, n: number): CrewState {
  if (!(n > 0)) return crew;
  return { ...crew, stops: crew.stops + Math.floor(n) };
}

/** 慣れが今の段の上限に届いているか (届いていたら設備を上げる頃) */
export function crewPracticeFull(crew: CrewState): boolean {
  return crew.stops * CREW.practicePerStop >= practiceCap(crew.level) - 1e-9;
}
