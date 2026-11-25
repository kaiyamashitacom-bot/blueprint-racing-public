// コンストラクター (チームのチャンピオン)。季節 (1 週間) ごとに、本戦の級 (5 つ) ごとに 1 チーム + 総合で 1 チーム。
// 決まり (ユーザー 11/25):
//   チームの点 = 本戦 (季節の普段のレース + 大会) のチーム合計 + リーグ戦の点 × 部の倍率 (1 部が一番多く、下ほど少ない)
//   級ごとのチャンピオン = 本戦の 5 つの級それぞれで この点が一番多いチーム。総合のチャンピオン = 全チームで一番
//   リーグ戦の部ごとのチャンピオンは作らない (部には称号と王者がある)。コンピューターのチームはどちらにもならない
// 仮: リーグ戦の点 = その日の点 × 重み (0.1) × その日にいた部の倍率 を季節の間 足す。級なし (新しいチーム) は一番下の級で争う。数は管理者が変えられる
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "./adminconfig.ts";
import type { LeagueState } from "./league.ts";
import { CLASS_IDS, playClassOf, type ClassId, type ClassTable, type SeasonTally } from "./season.ts";

/** 季節の間に貯めるリーグ戦の分 (チーム → 点、小数のまま) */
export type ConstructorLeagueAcc = Record<string, number>;

/**
 * 日の締め (closeLeagueDay) の前に呼ぶ: その日の点を部の倍率を掛けて貯める。
 * 人のチームだけ (コンピューターのチームはコンストラクターに出ない)
 */
export function addLeagueDayToConstructors(
  acc: ConstructorLeagueAcc,
  state: LeagueState,
  cfg: Pick<AdminConfig, "constructorLeagueWeight" | "constructorDivisionMul"> = DEFAULT_ADMIN_CONFIG,
): ConstructorLeagueAcc {
  const out = { ...acc };
  for (const l of state.leagues) {
    const tally = state.tally[l.id] ?? {};
    const mul = cfg.constructorDivisionMul[l.division - 1] ?? 1;
    for (const h of l.humans) {
      const pts = tally[h]?.points ?? 0;
      if (pts > 0) out[h] = (out[h] ?? 0) + pts * cfg.constructorLeagueWeight * mul;
    }
  }
  return out;
}

export interface ConstructorRow {
  teamId: string;
  rank: number;
  /** 本戦 (季節の普段のレース + 大会、2 台の合計) */
  main: number;
  /** リーグ戦の分 (丸めたもの) */
  league: number;
  total: number;
}

/** teams の順位。同点は 本戦の点 → チームの id */
export function constructorStandings(season: SeasonTally, leagueAcc: ConstructorLeagueAcc, teams?: Iterable<string>): ConstructorRow[] {
  const ids = teams ? new Set(teams) : new Set([...Object.keys(season.teams), ...Object.keys(leagueAcc)]);
  const rows = [...ids].map((teamId) => {
    const main = season.teams[teamId]?.points ?? 0;
    const league = Math.round(leagueAcc[teamId] ?? 0);
    return { teamId, rank: 0, main, league, total: main + league };
  });
  rows.sort((a, b) => b.total - a.total || b.main - a.main || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

/** 並びの一番 (点が 0 なら なし) */
export function constructorChampion(rows: readonly ConstructorRow[]): string | null {
  return rows.length && rows[0].total > 0 ? rows[0].teamId : null;
}

export interface ClassConstructors {
  cls: ClassId;
  rows: ConstructorRow[];
  champion: string | null;
  /** チャンピオンの賞金 */
  prize: number;
}

/**
 * 級ごとのコンストラクター (季節の終わり、級の入れ替え closeSeason の前に呼ぶ)。
 * classes = 人のチームの級の表 (コンピューターのチームは入れない)。級なしは一番下の級で争う
 */
export function constructorsByClass(
  season: SeasonTally,
  leagueAcc: ConstructorLeagueAcc,
  classes: Readonly<ClassTable>,
  cfg: Pick<AdminConfig, "constructorPrize" | "constructorPrizeClassMul"> = DEFAULT_ADMIN_CONFIG,
): ClassConstructors[] {
  return CLASS_IDS.map((cls) => {
    const members = Object.keys(classes).filter((t) => playClassOf(classes as ClassTable, t) === cls);
    const rows = constructorStandings(season, leagueAcc, members);
    const champion = constructorChampion(rows);
    const prize = champion ? Math.round(cfg.constructorPrize * (cfg.constructorPrizeClassMul[cls - 1] ?? 1)) : 0;
    return { cls, rows, champion, prize };
  });
}

export interface OverallConstructors {
  rows: ConstructorRow[];
  champion: string | null;
  prize: number;
}

/** 総合のコンストラクター (全体で 1 チーム)。classes にある人のチームだけ */
export function constructorsOverall(
  season: SeasonTally,
  leagueAcc: ConstructorLeagueAcc,
  classes: Readonly<ClassTable>,
  cfg: Pick<AdminConfig, "constructorOverallPrize"> = DEFAULT_ADMIN_CONFIG,
): OverallConstructors {
  const rows = constructorStandings(season, leagueAcc, Object.keys(classes));
  const champion = constructorChampion(rows);
  return { rows, champion, prize: champion ? Math.round(cfg.constructorOverallPrize) : 0 };
}
