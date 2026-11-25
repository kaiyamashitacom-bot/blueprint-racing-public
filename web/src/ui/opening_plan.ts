// オープニング (ゲームを開いたときの画面) の決めごと。画面に触らない小さな計算だけ (試験 opening_plan.test.ts)。
// 設定はこの端末だけ (localStorage の bpr.opening.v1)。数は全部 仮。
//   auto  = はじめて = ふつう、2 回目から = 短く (決まりの値。設定で選ぶと full / short / off を残す)
//   full  = いつも ふつう (約 3.4 秒)・short = いつも 短く (約 1 秒)・off = 出さない

export type OpeningSetting = "auto" | "full" | "short" | "off";
/** 実際に出す形。still = 動かさず最後の形 (動きを減らす設定の人) */
export type OpeningPlan = "full" | "short" | "still" | "none";

export interface OpeningPrefs {
  setting: OpeningSetting;
  /** 一度でも最後まで見た (押して入った) */
  seen: boolean;
}

export const OPENING_KEY = "bpr.opening.v1";
export const DEFAULT_OPENING: Readonly<OpeningPrefs> = { setting: "auto", seen: false };
const SETTINGS: readonly OpeningSetting[] = ["auto", "full", "short", "off"];

/** 保存した文字から読む。壊れていたら決まりの値 */
export function parseOpeningPrefs(raw: string | null | undefined): OpeningPrefs {
  const out: OpeningPrefs = { ...DEFAULT_OPENING };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof OpeningPrefs, unknown>> | null;
    if (!v || typeof v !== "object") return out;
    if (SETTINGS.includes(v.setting as OpeningSetting)) out.setting = v.setting as OpeningSetting;
    if (typeof v.seen === "boolean") out.seen = v.seen;
  } catch {
    /* 決まりの値のまま */
  }
  return out;
}

/** 今回出す形 */
export function openingPlan(p: Readonly<OpeningPrefs>, reducedMotion = false): OpeningPlan {
  const s = effectiveSetting(p);
  if (s === "off") return "none";
  if (reducedMotion) return "still";
  return s;
}

/** 設定の切りかえ (ふつう / 短く / なし) で光らせる物 = 次に開いたときに出る形 */
export function effectiveSetting(p: Readonly<OpeningPrefs>): "full" | "short" | "off" {
  if (p.setting === "auto") return p.seen ? "short" : "full";
  return p.setting;
}

/**
 * 開いたときにオープニングを出すか。読み直した画面 (sessionStorage の bpr.screen の name) が
 * 無い・メニューなら出す。ほかの画面 (車づくり・レース・ログイン …) の途中で読み直したときは出さずにそのまま戻る
 */
export function openingOnLoad(savedScreen: string | null | undefined): boolean {
  return !savedScreen || savedScreen === "menu";
}

/** 押して入ったあと: ログインが残っていればメニュー、無ければログインの画面 (この回で「ログインしないで試す」を選んだ人はメニュー) */
export function screenAfterOpening(loggedIn: boolean, guestThisSession: boolean): "menu" | "welcome" {
  return loggedIn || guestThisSession ? "menu" : "welcome";
}

// ---------------------------------------------------------------- 時間の割り付け (ふつうの秒。短くは SHORT_SCALE を掛ける)

/** 線 1 本ずつの書き始め (秒) と長さ */
export const LINE_START = 0.12;
export const LINE_STEP = 0.11;
export const LINE_DUR = 0.6;
/** 寸法の線・字、題名、赤い線、「スタート」の字 */
export const DIM_AT = 1.95;
export const DIM_DUR = 0.45;
export const TITLE_AT = 2.25;
export const TITLE_DUR = 0.55;
export const RULE_AT = 2.6;
export const RULE_DUR = 0.4;
export const PROMPT_AT = 2.95;
export const PROMPT_DUR = 0.45;
export const SHORT_SCALE = 0.3;

/** 形ごとの時間の倍率 (still は 0 = すぐ最後) */
export function timeScale(plan: OpeningPlan): number {
  return plan === "full" ? 1 : plan === "short" ? SHORT_SCALE : 0;
}

/** 全部が出そろう秒 (線が多ければ線の終わりの方が遅いこともある) */
export function openingLength(lines: number, plan: OpeningPlan): number {
  const k = timeScale(plan);
  const lastLine = LINE_START + Math.max(0, lines - 1) * LINE_STEP + LINE_DUR;
  return Math.max(lastLine, PROMPT_AT + PROMPT_DUR) * k;
}

/** 0..1 に切って、終わりがゆっくりの曲線 (三乗) */
export function easeOut(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return 1 - (1 - x) ** 3;
}

/** 秒 t (今の形の秒) で、ふつうの秒 at から len かけて進む物の進み 0..1。k = 0 (still) は 1 */
export function progress(t: number, at: number, len: number, k: number): number {
  if (k <= 0) return 1;
  return easeOut((t - at * k) / (len * k));
}

/** 下の案内の字。さわる機械 (指) は「タップ」、パソコンは「クリック / Enter」 */
export function promptText(touch: boolean): string {
  return touch ? "タップしてスタート" : "クリック / Enter でスタート";
}

/** 押してもスキップ・スタートに数えないキー (修飾キーだけ・Tab で動かしただけ) */
export function isSkipKey(key: string): boolean {
  return !["Shift", "Control", "Alt", "Meta", "Tab", "CapsLock", "Fn", "OS"].includes(key);
}

// ---------------------------------------------------------------- この端末の保存 (読めない・書けないときは決まりの値で続ける)

export function loadOpeningPrefs(): OpeningPrefs {
  try {
    return parseOpeningPrefs(localStorage.getItem(OPENING_KEY));
  } catch {
    return { ...DEFAULT_OPENING };
  }
}

export function saveOpeningPrefs(patch: Partial<OpeningPrefs>): void {
  try {
    const next = { ...loadOpeningPrefs(), ...patch };
    localStorage.setItem(OPENING_KEY, JSON.stringify(next));
  } catch {
    /* 残せなくても遊べる */
  }
}
