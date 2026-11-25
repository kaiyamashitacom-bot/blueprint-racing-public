// 走りの決まりの数とお知らせをサーバー (/api/race-rules) から読む (11/25 足した)。読めなければ はじめの値のまま。
// manualSpeedBonus = マニュアル (自分で変速) の車の速さの上がり分 (管理者が変えられる。AdminConfig.manualSpeedBonus)
// announcement = 管理者のお知らせ 1 行 (オープニングの隅に出す。AdminConfig.announcement。空 = 出さない)
// partStrength・partKindStrength = 部品の強さの倍率 (AdminConfig。computeStats に渡す。部屋・リーグ・1 周アタックのサーバーと同じ数)
// practicePrizePerLap・practicePrizeDailyLaps = 練習の賞金 (案内用。払うかどうかはサーバーが決める)
import { checkAnnouncement, cleanManualBonus, cleanPartStrength, DEFAULT_ADMIN_CONFIG, DEFAULT_MANUAL_BONUS, isNeutralStrength, type PartStrength } from "@bpr/shared";

let bonus = DEFAULT_MANUAL_BONUS;
let notice = "";
let strength: PartStrength | null = null;
let practice = { perLap: DEFAULT_ADMIN_CONFIG.practicePrizePerLap, dailyLaps: DEFAULT_ADMIN_CONFIG.practicePrizeDailyLaps };
let loading: Promise<void> | null = null;

/** 今のマニュアルの上がり分 */
export function manualBonus(): number {
  return bonus;
}

/** 今のお知らせ (無ければ "") */
export function announcement(): string {
  return notice;
}

/** 部品の強さの倍率 (computeStats の 2 つ目に渡す。全部 1 なら null) */
export function partStrength(): PartStrength | null {
  return strength;
}

/** 練習の賞金 (1 周・1 日の周の上限) */
export function practicePrize(): { perLap: number; dailyLaps: number } {
  return practice;
}

const nonNegInt = (v: unknown, dflt: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : dflt);

/** はじめに 1 回読む (待たなくてよい)。2 回目からは同じ約束を返す (オープニングが読み終わりを待てるように) */
export function loadRaceRules(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch("/api/race-rules");
      if (!res.ok) return;
      const data = (await res.json()) as { manualSpeedBonus?: unknown; announcement?: unknown; practicePrizePerLap?: unknown; practicePrizeDailyLaps?: unknown };
      bonus = cleanManualBonus(data.manualSpeedBonus);
      const a = data.announcement;
      notice = typeof a === "string" && checkAnnouncement(a) === null ? a.trim() : "";
      const s = cleanPartStrength(data);
      strength = isNeutralStrength(s) ? null : s;
      practice = { perLap: nonNegInt(data.practicePrizePerLap, practice.perLap), dailyLaps: nonNegInt(data.practicePrizeDailyLaps, practice.dailyLaps) };
    } catch {
      /* サーバーにつながらない (練習はそのまま走れる) */
    }
  })();
  return loading;
}
