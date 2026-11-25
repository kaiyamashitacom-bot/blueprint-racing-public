// 走りの決まりの数とお知らせをサーバー (/api/race-rules) から読む (11/25 足した)。読めなければ はじめの値のまま。
// manualSpeedBonus = マニュアル (自分で変速) の車の速さの上がり分 (管理者が変えられる。AdminConfig.manualSpeedBonus)
// announcement = 管理者のお知らせ 1 行 (オープニングの隅に出す。AdminConfig.announcement。空 = 出さない)
import { checkAnnouncement, cleanManualBonus, DEFAULT_MANUAL_BONUS } from "@bpr/shared";

let bonus = DEFAULT_MANUAL_BONUS;
let notice = "";
let loading: Promise<void> | null = null;

/** 今のマニュアルの上がり分 */
export function manualBonus(): number {
  return bonus;
}

/** 今のお知らせ (無ければ "") */
export function announcement(): string {
  return notice;
}

/** はじめに 1 回読む (待たなくてよい)。2 回目からは同じ約束を返す (オープニングが読み終わりを待てるように) */
export function loadRaceRules(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch("/api/race-rules");
      if (!res.ok) return;
      const data = (await res.json()) as { manualSpeedBonus?: unknown; announcement?: unknown };
      bonus = cleanManualBonus(data.manualSpeedBonus);
      const a = data.announcement;
      notice = typeof a === "string" && checkAnnouncement(a) === null ? a.trim() : "";
    } catch {
      /* サーバーにつながらない (練習はそのまま走れる) */
    }
  })();
  return loading;
}
