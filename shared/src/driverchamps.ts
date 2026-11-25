// ドライバーズチャンピオン (運転手のチャンピオン)。季節ごとに、本戦の級ごとに 1 人 + 総合 1 人。
// 決まり (ユーザー 11/25): 点は本戦だけ (普段のレース + 大会、季節の点と同じ重み)。リーグ戦 (代走) と 1 周アタックは入れない。
//   代走の点は運転手の点に入れない (season.ts の集計がもうそうしている)。雇ったコンピューターの運転手も人と同じ順位で争い、チャンピオンになれる。
// 仮: 級は季節の終わり (級の入れ替えの前) に運転手がいるチーム (最後に走ったチーム) の級。契約が途中で変わっても、点は運転手についていく。
//   賞金はそのとき運転手がいるチームへ。数は管理者が変えられる。
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "./adminconfig.ts";
import { CLASS_IDS, playClassOf, rankDrivers, type ClassId, type ClassTable, type RankRow, type SeasonTally } from "./season.ts";

export interface DriverChampion {
  driverId: string;
  /** 賞金を受け取るチーム (季節の終わりにいるチーム) */
  teamId: string;
  points: number;
  prize: number;
}

export interface ClassDriverChampions {
  cls: ClassId;
  rows: RankRow[];
  champion: DriverChampion | null;
}

function pick(season: SeasonTally, rows: RankRow[], prize: number): DriverChampion | null {
  const top = rows[0];
  if (!top || top.points <= 0) return null;
  return { driverId: top.id, teamId: season.drivers[top.id]?.teamId ?? "", points: top.points, prize };
}

/** 人のチーム (classes にあるチーム) に属する運転手だけ */
function driversOf(season: SeasonTally, classes: Readonly<ClassTable>): string[] {
  return Object.keys(season.drivers).filter((d) => season.drivers[d].teamId in classes);
}

/** 級ごとのドライバーズチャンピオン (季節の終わり、closeSeason の前に呼ぶ) */
export function driverChampionsByClass(
  season: SeasonTally,
  classes: Readonly<ClassTable>,
  cfg: Pick<AdminConfig, "driverChampionPrize" | "constructorPrizeClassMul"> = DEFAULT_ADMIN_CONFIG,
): ClassDriverChampions[] {
  const all = driversOf(season, classes);
  return CLASS_IDS.map((cls) => {
    const ids = all.filter((d) => playClassOf(classes as ClassTable, season.drivers[d].teamId) === cls);
    const rows = rankDrivers(season, ids);
    const prize = Math.round(cfg.driverChampionPrize * (cfg.constructorPrizeClassMul[cls - 1] ?? 1));
    return { cls, rows, champion: pick(season, rows, prize) };
  });
}

/** 総合のドライバーズチャンピオン (全体で 1 人) */
export function driverChampionOverall(
  season: SeasonTally,
  classes: Readonly<ClassTable>,
  cfg: Pick<AdminConfig, "driverOverallPrize"> = DEFAULT_ADMIN_CONFIG,
): { rows: RankRow[]; champion: DriverChampion | null } {
  const rows = rankDrivers(season, driversOf(season, classes));
  return { rows, champion: pick(season, rows, Math.round(cfg.driverOverallPrize)) };
}
