// リーグ戦 (league.ts の LeagueDO) がアカウントの DO に聞くこと。アカウントの DO (accounts_do.ts) の RPC から呼ぶ。
// Cloudflare に頼らないので試験でそのまま使える (試験ではリーグの側からこれを直接呼ぶ)。
// - 全部のチーム (アカウント) の一覧: リーグに自動で入れる・退会したチームを外す
// - ログインの確かめ
// - 2 時間ごとのレースに出す 2 台の様子: 代走の車 (1 台目に決めた設計図か、最後に直した走れる設計図)・代走の慣れ・
//   雇った運転手 (能力・慣れ・2 台目の設計図)・整備の腕
import { designFits, SAMPLE_DESIGN, validateDesign, type CarDesign, type DriverStats, type Emblem, type RaceSetupPref, type SpecialtyId } from "@bpr/shared";
import type { AccountStore, SqlRunner } from "./accounts.ts";
import type { TeamStore } from "./team.ts";

/** リーグのチーム id = アカウントの番号の文字列 (team.ts と同じ) */
export interface LeagueMember {
  teamId: string;
  name: string;
}

/** 2 時間ごとのレースに出す 1 チームの様子 */
export interface LeagueTeamData {
  teamId: string;
  name: string;
  /** 本人の運転手名 (代走の車に出す) */
  driver: string;
  emblem: Emblem | null;
  /** 代走が走らせる車 */
  design: CarDesign;
  /** 2 台目に決めた設計図 (走れて部品が足りるときだけ。なければ代走の車と同じ) */
  secondDesign: CarDesign;
  /** 代走の慣れ (コース → 0..1) */
  standInFam: Record<string, number>;
  /** ピットの作業の倍率 */
  serviceFactor: number;
  /** 雇った運転手 (いなければ null。そのときの 2 台目はコンピューターの代走) */
  hired: { driverId: string; name: string; stats: DriverStats; specs?: SpecialtyId[]; fam: Record<string, number> } | null;
  /** 遊ぶ人の最後の走る前の準備 (代走の車のタイヤと燃料。なし = コンピューターが決める。前の作りの DO からは来ない) */
  setup?: RaceSetupPref | null;
}

/** 全部のアカウント (id の順) */
export function leagueRoster(sql: SqlRunner): LeagueMember[] {
  return sql
    .exec("SELECT id, team FROM accounts ORDER BY id")
    .toArray()
    .map((r) => ({ teamId: String(r.id), name: String(r.team) }));
}

export async function leagueAuth(store: AccountStore, token: string | null | undefined): Promise<LeagueMember | null> {
  const acc = await store.auth(token ?? null);
  return acc ? { teamId: String(acc.id), name: acc.team } : null;
}

/** 走れて、部品が足りる設計図 */
function usable(store: AccountStore, accountId: number, d: CarDesign | null | undefined): d is CarDesign {
  return !!d && validateDesign(d).length === 0 && designFits(d, store.inventory(accountId)).ok;
}

/**
 * 代走の車 (仮): チームの画面で 1 台目に決めた設計図 → 最後に直した走れる設計図 → 見本の車。
 * (「設計図は最後に選んでいた物」。選んでいた物はこの機械の中にしかないので、サーバーにある物から選ぶ)
 */
function playerDesign(store: AccountStore, team: TeamStore, accountId: number): CarDesign {
  const designs = store.listDesigns(accountId);
  const picked = team.loadTeam(accountId)?.cars.player;
  const chosen = picked ? designs.find((d) => String(d.id) === picked) : undefined;
  if (chosen && usable(store, accountId, chosen.design)) return chosen.design;
  const latest = [...designs].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id).find((d) => usable(store, accountId, d.design));
  return latest ? latest.design : SAMPLE_DESIGN;
}

/** チームの 2 台の様子 (アカウントがない・管理者が止めているときは null) */
export function leagueTeamData(store: AccountStore, team: TeamStore, teamId: string): LeagueTeamData | null {
  const accountId = Number(teamId);
  if (!Number.isInteger(accountId)) return null;
  const acc = store.getAccount(accountId);
  if (!acc) return null;
  // 管理者が止めている人のチームは、止めている間 リーグ戦の代走にも出さない (リーグの席は残す)
  if (store.isSuspended(accountId)) return null;
  const design = playerDesign(store, team, accountId);
  const jt = team.raceTeam(accountId, design);
  const secondId = team.loadTeam(accountId)?.cars.second;
  const second = secondId ? store.listDesigns(accountId).find((d) => String(d.id) === secondId)?.design : undefined;
  return {
    teamId,
    name: acc.team,
    driver: acc.driver,
    emblem: team.loadTeam(accountId)?.emblem ?? null,
    design,
    secondDesign: jt.second?.design ?? (usable(store, accountId, second) ? second : design),
    standInFam: jt.standInFam ?? {},
    serviceFactor: jt.serviceFactor ?? 1,
    hired: jt.second ? { driverId: jt.second.driverId, name: jt.second.name, stats: jt.second.driver, ...(jt.second.specs?.length ? { specs: jt.second.specs } : {}), fam: jt.second.fam ?? {} } : null,
    setup: team.raceSetup(accountId),
  };
}
