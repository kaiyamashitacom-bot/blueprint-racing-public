// はんこ: レースの結果でもらえる印 (優勝・最速の周・雨で勝った など)。遊ぶ人の車の絵に集まる。
// 季節の終わりの順位と、2 時間ごとのリーグ戦の上位でももらえる (季節のごほうびの「記念の色や模様」につながる)。数と条件は全部 (仮)。
import { CHAMPION_TITLE, divisionTitle, type WeekStamp } from "./league.ts";
import type { RaceKind, SeasonClose } from "./season.ts";
import type { TireCompound } from "./tires.ts";

export type StampId =
  | "win"
  | "podium"
  | "fastest_lap"
  | "rain_win"
  | "pole_to_win"
  | "comeback"
  | "no_pit_finish"
  | "long_finish"
  | "clean_win"
  | "one_two"
  | "three_compounds"
  | "tournament_win"
  | "tournament_podium"
  | "class_champion"
  | "promoted"
  | "driver_champion"
  | "div1"
  | "div2"
  | "div3"
  | "div4"
  | "div5"
  | "div6"
  | "div7"
  | "div8";

export interface StampDef {
  id: StampId;
  /** 画面用の名前 */
  name: string;
  /** もらえる条件 (画面用) */
  desc: string;
  /** 珍しさ 1 (よくある)〜3 (珍しい)。絵の縁の色などに */
  rarity: 1 | 2 | 3;
  /** どこでもらえるか */
  from: "race" | "season" | "league";
}

/** 追い上げのはんこに要る、上げた順位の数 (仮) */
export const COMEBACK_GAIN = 4;
/** 雨で勝ったのはんこ: レース中の路面の濡れ具合の一番高いところがこれ以上 (仮。小雨の路面 0.5 の手前) */
export const RAIN_STAMP_WET = 0.35;
/** 長いレースのはんこに要る周回数 (仮。「長い」= 10 周) */
export const LONG_RACE_LAPS = 10;
/** ピットなしで完走のはんこに要る周回数 (仮) */
export const NO_PIT_MIN_LAPS = 5;

function divStamp(d: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, rarity: 1 | 2 | 3): StampDef {
  return { id: `div${d}`, name: divisionTitle(d), desc: `その週にリーグ戦の ${d} 部を走った (一番上の部)`, rarity, from: "league" };
}

export const STAMP_DEFS: Readonly<Record<StampId, StampDef>> = {
  win: { id: "win", name: "優勝", desc: "レースで 1 位", rarity: 1, from: "race" },
  podium: { id: "podium", name: "表彰台", desc: "レースで 3 位以内", rarity: 1, from: "race" },
  fastest_lap: { id: "fastest_lap", name: "最速の周", desc: "レースで一番速い周", rarity: 1, from: "race" },
  rain_win: { id: "rain_win", name: "雨で勝った", desc: "濡れた路面のレースで 1 位", rarity: 2, from: "race" },
  pole_to_win: { id: "pole_to_win", name: "先頭から逃げ切り", desc: "一番前から出て 1 位", rarity: 2, from: "race" },
  comeback: { id: "comeback", name: "追い上げ", desc: `並びから ${COMEBACK_GAIN} つ以上順位を上げて完走`, rarity: 2, from: "race" },
  no_pit_finish: { id: "no_pit_finish", name: "ピットなし", desc: `${NO_PIT_MIN_LAPS} 周以上をピットに入らず完走`, rarity: 2, from: "race" },
  long_finish: { id: "long_finish", name: "長いレースを完走", desc: `${LONG_RACE_LAPS} 周以上のレースを完走`, rarity: 1, from: "race" },
  clean_win: { id: "clean_win", name: "罰なしの優勝", desc: "罰の秒なしで 1 位 + 最速の周", rarity: 3, from: "race" },
  one_two: { id: "one_two", name: "ワンツー", desc: "自分のチームの 2 台で 1 位と 2 位", rarity: 3, from: "race" },
  three_compounds: { id: "three_compounds", name: "タイヤ使い", desc: "3 種類以上のタイヤを使って完走", rarity: 2, from: "race" },
  tournament_win: { id: "tournament_win", name: "大会優勝", desc: "大会で 1 位", rarity: 3, from: "race" },
  tournament_podium: { id: "tournament_podium", name: "大会の表彰台", desc: "大会で 3 位以内", rarity: 2, from: "race" },
  class_champion: { id: "class_champion", name: "級の 1 位", desc: "季節の終わりに級の中で 1 位", rarity: 3, from: "season" },
  promoted: { id: "promoted", name: "昇級", desc: "季節の終わりに上の級へ", rarity: 2, from: "season" },
  driver_champion: { id: "driver_champion", name: "運転手の 1 位", desc: "季節の運転手順位で 1 位", rarity: 3, from: "season" },
  // リーグ戦: 週に 1 つ、その週に走った一番上の部のはんこ (名前は部の肩書き)
  div1: divStamp(1, 3),
  div2: divStamp(2, 3),
  div3: divStamp(3, 2),
  div4: divStamp(4, 2),
  div5: divStamp(5, 2),
  div6: divStamp(6, 1),
  div7: divStamp(7, 1),
  div8: divStamp(8, 1),
};

export const STAMP_ORDER: readonly StampId[] = Object.keys(STAMP_DEFS) as StampId[];

/** はんこを決めるための 1 台の結果と、そのレースの様子 */
export interface StampRaceInput {
  kind: RaceKind;
  /** レースの周回数 */
  laps: number;
  /** 順位 (1 から、失格を除いて詰めたもの) */
  pos: number;
  /** 並び (1 から)。分からなければ null */
  gridPos: number | null;
  finished: boolean;
  dq?: boolean;
  fastest: boolean;
  /** 代走 (人が来なかった) なら、はんこは無し */
  standIn?: boolean;
  /** ピットに入った回数 */
  pitStops: number;
  /** レース中の路面の濡れ具合の一番高いところ (0..1) */
  maxWet: number;
  /** 足された罰の秒 */
  penalty: number;
  /** 同じチームのもう 1 台の順位 (いなければ null) */
  teammatePos?: number | null;
  /** 使ったタイヤ */
  tiresUsed?: readonly TireCompound[];
}

/** 1 台のレースの結果からもらえるはんこ (STAMP_ORDER の順) */
export function raceStamps(r: StampRaceInput): StampId[] {
  if (r.standIn || r.dq || !r.finished) return [];
  const got = new Set<StampId>();
  const win = r.pos === 1;
  if (win) got.add("win");
  if (r.pos <= 3) got.add("podium");
  if (r.fastest) got.add("fastest_lap");
  if (win && r.maxWet >= RAIN_STAMP_WET) got.add("rain_win");
  if (win && r.gridPos === 1) got.add("pole_to_win");
  if (r.gridPos !== null && r.gridPos - r.pos >= COMEBACK_GAIN) got.add("comeback");
  if (r.pitStops === 0 && r.laps >= NO_PIT_MIN_LAPS) got.add("no_pit_finish");
  if (r.laps >= LONG_RACE_LAPS) got.add("long_finish");
  if (win && r.fastest && r.penalty === 0) got.add("clean_win");
  if (r.teammatePos != null && ((r.pos === 1 && r.teammatePos === 2) || (r.pos === 2 && r.teammatePos === 1))) got.add("one_two");
  if (new Set(r.tiresUsed ?? []).size >= 3) got.add("three_compounds");
  if (r.kind === "tournament" && win) got.add("tournament_win");
  if (r.kind === "tournament" && r.pos <= 3) got.add("tournament_podium");
  return STAMP_ORDER.filter((s) => got.has(s));
}

/** 季節を締めたときに、そのチーム (と運転手) がもらうはんこ */
export function seasonStamps(close: SeasonClose, teamId: string, driverId?: string): StampId[] {
  const got = new Set<StampId>();
  for (const rows of Object.values(close.rankings)) {
    const r = rows.find((x) => x.id === teamId);
    if (r && r.rank === 1 && r.points > 0) got.add("class_champion");
  }
  const mv = close.moves.find((m) => m.teamId === teamId);
  if (mv && mv.from !== null && mv.to < mv.from) got.add("promoted");
  if (driverId !== undefined) {
    const d = close.drivers[0];
    if (d && d.id === driverId && d.points > 0) got.add("driver_champion");
  }
  return STAMP_ORDER.filter((s) => got.has(s));
}

/** 週の切れ目のリーグ戦のはんこ (closeLeagueDay の weekStamps から)。部の外なら null */
export function weekDivisionStamp(division: number): StampId | null {
  return Number.isInteger(division) && division >= 1 && division <= 8 ? (`div${division}` as StampId) : null;
}

/** そのチームの週のはんこ */
export function leagueWeekStamps(weekStamps: readonly WeekStamp[], teamId: string): StampId[] {
  const w = weekStamps.find((x) => x.teamId === teamId);
  const s = w ? weekDivisionStamp(w.division) : null;
  return s ? [s] : [];
}

/** 集めたはんこ: はんこ → 回数と最初・最後にもらった時刻 */
export type StampBook = Partial<Record<StampId, { count: number; firstAt: number; lastAt: number }>>;

/** もらったはんこを帳面に足す (新しい帳面を返す) */
export function addStamps(book: StampBook, stamps: readonly StampId[], at: number): StampBook {
  const out: StampBook = { ...book };
  for (const s of stamps) {
    const cur = out[s];
    out[s] = cur ? { count: cur.count + 1, firstAt: Math.min(cur.firstAt, at), lastAt: Math.max(cur.lastAt, at) } : { count: 1, firstAt: at, lastAt: at };
  }
  return out;
}

/** 2 つの帳面を合わせる (回数は足す) */
export function mergeStampBooks(a: StampBook, b: StampBook): StampBook {
  const out: StampBook = { ...a };
  for (const id of STAMP_ORDER) {
    const y = b[id];
    if (!y) continue;
    const x = out[id];
    out[id] = x ? { count: x.count + y.count, firstAt: Math.min(x.firstAt, y.firstAt), lastAt: Math.max(x.lastAt, y.lastAt) } : { ...y };
  }
  return out;
}

/** 車の絵に並べる順 (珍しい順 → 回数の多い順 → 表の順)。max 個まで */
export function stampsForDisplay(book: StampBook, max = 8): { id: StampId; count: number }[] {
  return STAMP_ORDER.filter((id) => (book[id]?.count ?? 0) > 0)
    .map((id, i) => ({ id, count: book[id]!.count, i }))
    .sort((a, b) => STAMP_DEFS[b.id].rarity - STAMP_DEFS[a.id].rarity || b.count - a.count || a.i - b.i)
    .slice(0, max)
    .map(({ id, count }) => ({ id, count }));
}

// ---------------------------------------------------------------- 歴代の記録

/** 季節ごとのチームの記録 (季節の切れ目に 1 つ足す)。肩書きは、その季節の終わりにいたリーグの部のもの (王者なら 王者) */
export interface TeamHistoryEntry {
  season: number;
  /** 級 (季節を締めたときの級。級なしなら null) と 級の中の順位 */
  cls: number | null;
  classRank: number | null;
  /** リーグ戦の部と肩書き (リーグにいなければ null) */
  division: number | null;
  title: string | null;
  /** 季節の終わりに王者だった (特別な記録) */
  champion: boolean;
  /** この季節にもらったはんこ (表の順、重なりなし) */
  stamps: StampId[];
}

/** 季節の切れ目に、チームの記録を 1 つ作る */
export function historyEntry(o: {
  season: number;
  cls: number | null;
  classRank: number | null;
  division: number | null;
  champion?: boolean;
  stamps: readonly StampId[];
}): TeamHistoryEntry {
  const set = new Set(o.stamps);
  return {
    season: o.season,
    cls: o.cls,
    classRank: o.classRank,
    division: o.division,
    title: o.champion ? CHAMPION_TITLE : o.division === null ? null : divisionTitle(o.division),
    champion: o.champion === true,
    stamps: STAMP_ORDER.filter((s) => set.has(s)),
  };
}

/** 記録に足す (同じ季節があれば置きかえる。季節の順) */
export function addHistory(history: readonly TeamHistoryEntry[], e: TeamHistoryEntry): TeamHistoryEntry[] {
  return [...history.filter((h) => h.season !== e.season), e].sort((a, b) => a.season - b.season);
}
