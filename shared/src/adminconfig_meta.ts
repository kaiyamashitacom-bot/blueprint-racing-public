// 管理者の数 (AdminConfig) の説明の表: 名前・何が変わるか・単位・幅・組。管理者の画面 (web/src/ui/admin_config.ts) と
// サーバーの変更の記録 (server/src/admin_config_log.ts) が使う。AdminConfig に項目を足したら ADMIN_CONFIG_META に 1 つ足す
// (足さなくても画面には「説明なし」で出る。試験 adminconfig_meta.test.ts が足し忘れを知らせる)。
// 幅は validateAdminConfig と同じにする (試験で突き合わせる)。ここの幅は画面で先に知らせるためだけで、決めるのはサーバーの確かめ。
import {
  ADMIN_FEE_MAX,
  ADMIN_MUL_MAX,
  ADMIN_MUL_MIN,
  ADMIN_BET_MARGIN_MAX,
  ADMIN_PRIZE_MAX,
  ADMIN_RP_CAP_MAX,
  ADMIN_RP_MAX,
  ANNOUNCEMENT_MAX,
  DEFAULT_ADMIN_CONFIG,
  checkAnnouncement,
  applyAdminPatch,
  leaguePrizeFor,
  marketFeeFor,
  partStrengthFor,
  racePrizeFor,
  seasonPrizeFor,
  type AdminConfig,
} from "./adminconfig.ts";
import { betOdds } from "./betting.ts";
import { MANUAL_BONUS_MAX } from "./gearbox.ts";
import { DIVISION_COUNT } from "./league.ts";
import { BASE_PART_KINDS, KIND_NAMES, type BasePartKind, type PartKind } from "./parts.ts";
import { POINTS } from "./race.ts";
import { rpForRace, rpMonthEstimate } from "./racepoints.ts";
import { MAX_CARS } from "./room.ts";

export type AdminGroupId = "prize" | "points" | "league" | "champion" | "parts" | "market" | "rp" | "bet" | "players";

/** 組 (画面の見出しの順) */
export const ADMIN_CONFIG_GROUPS: ReadonlyArray<{ id: AdminGroupId; label: string; en: string }> = [
  { id: "prize", label: "賞金", en: "Prize" },
  { id: "points", label: "点と重み", en: "Points" },
  { id: "league", label: "リーグ戦", en: "League" },
  { id: "champion", label: "チャンピオン", en: "Champions" },
  { id: "parts", label: "部品と車", en: "Car" },
  { id: "market", label: "市場とギフト", en: "Market" },
  { id: "rp", label: "走行点", en: "Race points" },
  { id: "bet", label: "賭け", en: "Betting" },
  { id: "players", label: "遊ぶ人", en: "Players" },
];

/** 中の項目 (season.everydayMul など) の説明 */
export interface AdminSubMeta {
  label: string;
  help: string;
  /** 円・倍・%・割合 (0.05 = 5%)・段・個 */
  unit: string;
  min: number;
  max: number;
  int?: boolean;
}

export interface AdminFieldMeta {
  label: string;
  /** 何が変わるか (1 行) */
  help: string;
  unit: string;
  group: AdminGroupId;
  min?: number;
  max?: number;
  /** 整数だけ */
  int?: boolean;
  /** 空 (null) = なし を受ける */
  nullable?: boolean;
  /** 数の並び: 長さの幅と、1 つずつの名前 ({n} が 1 から) */
  len?: readonly [number, number];
  item?: string;
  /** 中の項目のある物 (season・partKindStrength) */
  sub?: Readonly<Record<string, AdminSubMeta>>;
  /** 文字の項目 (announcement): 字の上限 */
  maxLen?: number;
}

const mul = (label: string, help: string, min = 0, max = ADMIN_MUL_MAX): AdminSubMeta => ({ label, help, unit: "倍", min, max });
const PART_KIND_SUB = Object.fromEntries(
  BASE_PART_KINDS.map((k) => [k, mul(KIND_NAMES[k], `${KIND_NAMES[k]}の部品の強さに掛ける (全部の倍率とも掛ける)`, ADMIN_MUL_MIN)]),
) as Record<BasePartKind, AdminSubMeta>;

/**
 * 項目ごとの説明。Partial なのは、ほかの人が AdminConfig に項目を足しても型が通るように (足し忘れは試験で見つける)
 */
export const ADMIN_CONFIG_META: Readonly<Partial<Record<keyof AdminConfig, AdminFieldMeta>>> = {
  // ---------------------------------------------------------------- 賞金
  prizePerPoint: {
    label: "普段のレース: 1 点の賞金",
    help: "普段のレースで取った点 1 点ごとのお金。周の数で増える (2 周 ×1・5 周 ×1.75・10 周 ×3)",
    unit: "円",
    group: "prize",
    min: 0,
    max: ADMIN_PRIZE_MAX,
    int: true,
  },
  prizeFinish: {
    label: "普段のレース: 完走の賞金",
    help: "普段のレースで最後まで走ったら、点の賞金に足すお金 (周の倍率も掛かる)",
    unit: "円",
    group: "prize",
    min: 0,
    max: ADMIN_PRIZE_MAX,
    int: true,
  },
  cpuOnlyPrizeRate: {
    label: "コンピューターとだけのレースの割合",
    help: "人のチームが自分だけの普段のレースでは、賞金にこれを掛ける (0.5 = 半分)",
    unit: "割合",
    group: "prize",
    min: 0,
    max: 1,
  },
  tournamentPrize: {
    label: "大会の賞金 (1〜8 位)",
    help: "管理者の組む大会の決勝の順位ごとのお金。完走した車だけ",
    unit: "円",
    group: "prize",
    min: 0,
    max: ADMIN_PRIZE_MAX,
    int: true,
    len: [MAX_CARS, MAX_CARS],
    item: "{n} 位",
  },
  practicePrizePerLap: {
    label: "練習の 1 周の賞金",
    help: "練習で走った 1 周ごとのお金 (サーバーが確かめた周だけ)",
    unit: "円",
    group: "prize",
    min: 0,
    max: ADMIN_PRIZE_MAX,
    int: true,
  },
  seasonPrize: {
    label: "季節の賞金 (級の中の順位)",
    help: "季節の終わりに、級の中の順位ごとにもらえるお金 (1 位から)。下の級の倍率を掛ける",
    unit: "円",
    group: "prize",
    min: 0,
    max: ADMIN_PRIZE_MAX,
    int: true,
    len: [0, 100],
    item: "{n} 位",
  },
  seasonPrizeClassMul: {
    label: "季節の賞金の級の倍率",
    help: "季節の賞金に掛ける、級ごとの倍率 (1 級から 5 級)",
    unit: "倍",
    group: "prize",
    min: 0,
    max: ADMIN_MUL_MAX,
    len: [5, 5],
    item: "{n} 級",
  },
  // ---------------------------------------------------------------- 点と重み
  season: {
    label: "季節の点の倍率",
    help: "レースの点を季節の点に入れるときに掛ける",
    unit: "倍",
    group: "points",
    sub: {
      everydayMul: mul("普段のレース", "普段のレースの点に掛ける", 0, 100),
      tournamentMul: mul("大会", "大会の点に掛ける (はじめ 10 = 普段の 10 倍)", 0, 100),
      cpuOnlyMul: mul("コンピューターとだけ", "人のチームが自分だけの普段のレースで、さらに掛ける", 0, 1),
    },
  },
  constructorLeagueWeight: {
    label: "コンストラクター: リーグ戦の重み",
    help: "リーグ戦の点をコンストラクター (チームのチャンピオン) の点に入れるときに掛ける",
    unit: "倍",
    group: "points",
    min: 0,
    max: ADMIN_MUL_MAX,
  },
  constructorDivisionMul: {
    label: "コンストラクター: 部の倍率",
    help: "リーグ戦の部ごとに、コンストラクターの点に掛ける (上の部で取った点ほど重い)",
    unit: "倍",
    group: "points",
    min: 0,
    max: ADMIN_MUL_MAX,
    len: [DIVISION_COUNT, DIVISION_COUNT],
    item: "{n} 部",
  },
  // ---------------------------------------------------------------- リーグ戦
  leaguePrize: {
    label: "リーグ戦の毎日の賞金 (順位)",
    help: "2 時間ごとのリーグ戦の毎日の締めで、リーグ (4 チーム) の中の順位ごとのお金。人のチームだけ",
    unit: "円",
    group: "league",
    min: 0,
    max: ADMIN_PRIZE_MAX,
    int: true,
    len: [0, 20],
    item: "{n} 位",
  },
  leaguePrizeDivisionMul: {
    label: "リーグ戦の賞金の部の倍率",
    help: "リーグ戦の賞金に掛ける部ごとの倍率 (1 部から 8 部)。下の部ほど多くして追いつけるように",
    unit: "倍",
    group: "league",
    min: 0,
    max: ADMIN_MUL_MAX,
    len: [DIVISION_COUNT, DIVISION_COUNT],
    item: "{n} 部",
  },
  // ---------------------------------------------------------------- チャンピオン
  constructorPrize: {
    label: "級のコンストラクターの賞金",
    help: "季節の終わりに、級ごとのコンストラクターのチャンピオンのお金 (もと)。級の倍率を掛ける",
    unit: "円",
    group: "champion",
    min: 0,
    max: 1e9,
  },
  constructorPrizeClassMul: {
    label: "チャンピオンの賞金の級の倍率",
    help: "級のコンストラクターと級のドライバーズの賞金に掛ける (1 級から 5 級)",
    unit: "倍",
    group: "champion",
    min: 0,
    max: ADMIN_MUL_MAX,
    len: [5, 5],
    item: "{n} 級",
  },
  constructorOverallPrize: {
    label: "総合コンストラクターの賞金",
    help: "全体で 1 チームの、総合のコンストラクターのチャンピオンのお金",
    unit: "円",
    group: "champion",
    min: 0,
    max: 1e9,
  },
  driverChampionPrize: {
    label: "級のドライバーズの賞金",
    help: "級ごとのドライバーズチャンピオン (運転手) のいるチームのお金 (もと)。級の倍率を掛ける",
    unit: "円",
    group: "champion",
    min: 0,
    max: 1e9,
  },
  driverOverallPrize: {
    label: "総合ドライバーズの賞金",
    help: "全体で 1 人の、総合のドライバーズチャンピオンのいるチームのお金",
    unit: "円",
    group: "champion",
    min: 0,
    max: 1e9,
  },
  // ---------------------------------------------------------------- 部品と車
  partStrength: {
    label: "部品の強さ (全部)",
    help: "全部の部品の強さに掛ける。1 より大きいと車が全体に強くなる",
    unit: "倍",
    group: "parts",
    min: ADMIN_MUL_MIN,
    max: ADMIN_MUL_MAX,
  },
  partKindStrength: {
    label: "部品の強さ (種類ごと)",
    help: "種類ごとの部品の強さ。全部の倍率と掛ける",
    unit: "倍",
    group: "parts",
    sub: PART_KIND_SUB,
  },
  manualSpeedBonus: {
    label: "マニュアルの速さの上がり分",
    help: "マニュアル (自分で変速、パソコンだけ) で走ったときの最高速と加速の上がり分 (0.03 = 3%)",
    unit: "割合",
    group: "parts",
    min: 0,
    max: MANUAL_BONUS_MAX,
  },
  // ---------------------------------------------------------------- 市場とギフト
  marketFeeRate: {
    label: "市場の手数料",
    help: "市場で部品が売れたとき、売った人から引く割合 (0.05 = 5%)",
    unit: "割合",
    group: "market",
    min: 0,
    max: ADMIN_FEE_MAX,
  },
  giftMoneyMax: {
    label: "ギフトの上限: お金",
    help: "ギフトコードの中身 1 つのお金の上限。空 = 上限なし",
    unit: "円",
    group: "market",
    min: 0,
    max: ADMIN_PRIZE_MAX,
    int: true,
    nullable: true,
  },
  giftPartTierMax: {
    label: "ギフトの上限: 部品の段階",
    help: "ギフトコードで渡せる部品の段階の上限 (1〜5)。空 = 上限なし",
    unit: "段",
    group: "market",
    min: 1,
    max: 5,
    int: true,
    nullable: true,
  },
  giftPartCountMax: {
    label: "ギフトの上限: 部品の数",
    help: "ギフトコードの中身 1 つの部品の数の上限。空 = 上限なし",
    unit: "個",
    group: "market",
    min: 1,
    max: 999,
    int: true,
    nullable: true,
  },
  giftDiscountMax: {
    label: "ギフトの上限: 契約金の割引",
    help: "ギフトコードの、運転手の契約金の割引の上限。空 = 上限なし",
    unit: "%",
    group: "market",
    min: 0,
    max: 100,
    int: true,
    nullable: true,
  },
  // ---------------------------------------------------------------- 賭け (betting.ts。ゲームの中のお金だけ)
  betPaused: {
    label: "賭け: 一時停止",
    help: "入にすると、新しい賭けを受けない (結果待ちの賭けは、そのまま結果で払う)",
    unit: "",
    group: "bet",
  },
  realMoneyEnabled: {
    label: "本物のお金を入れた",
    help: "本物のお金 (課金) を入れたら入にする。入の間は賭けが全部止まる (見直しと法律の確かめが済むまで)。今は切",
    unit: "",
    group: "bet",
  },
  betMargin: {
    label: "賭け: 胴元の取り分",
    help: "倍率 = (1 − 取り分) ÷ 勝つ見込み。0.1 = 1 割 (ゲームのお金を減らす役目)",
    unit: "割合",
    group: "bet",
    min: 0,
    max: ADMIN_BET_MARGIN_MAX,
  },
  betCloseMinutes: {
    label: "賭け: 締め切り",
    help: "リーグ戦のレースのスタートの何分前まで賭けられるか",
    unit: "分",
    group: "bet",
    min: 1,
    max: 120,
    int: true,
  },
  betMinStake: {
    label: "賭け: 1 回の一番小さい額",
    help: "これより少ない額では賭けられない",
    unit: "円",
    group: "bet",
    min: 1,
    max: ADMIN_PRIZE_MAX,
    int: true,
  },
  betMaxStake: {
    label: "賭けの上限: 1 回",
    help: "1 回に賭けられる額の上限。空 = 上限なし (はじめは無し)",
    unit: "円",
    group: "bet",
    min: 1,
    max: ADMIN_PRIZE_MAX,
    int: true,
    nullable: true,
  },
  betMaxPerDay: {
    label: "賭けの上限: 1 日",
    help: "1 日 (日本時間) に賭けられる額の合計の上限。空 = 上限なし (はじめは無し)",
    unit: "円",
    group: "bet",
    min: 1,
    max: ADMIN_PRIZE_MAX,
    int: true,
    nullable: true,
  },
  betMaxShareOfMoney: {
    label: "賭けの上限: 手元のお金の割合",
    help: "1 回に賭けられるのは手元のお金のこの割合まで (0.2 = 2 割)。空 = 上限なし (はじめは無し。全部賭けてもよい)",
    unit: "割合",
    group: "bet",
    min: 0.01,
    max: 1,
    nullable: true,
  },
  // ---------------------------------------------------------------- 毎日の大会 (賞金の組に並べる)
  autoTourOn: {
    label: "毎日の大会: 開く",
    help: "毎日決まった時刻に、全員参加の大会を自動で開く。管理者が大会を作った日は開かない",
    unit: "",
    group: "prize",
  },
  autoTourHour: {
    label: "毎日の大会: 時",
    help: "スタートの時 (日本時間)。予選は 30 分前まで、組の部屋は 10 分前に開く。リーグ戦は偶数の時ちょうど (と 22 時の締め) なので、その 10 分前〜20 分後は避ける",
    unit: "時",
    group: "prize",
    min: 0,
    max: 23,
    int: true,
  },
  autoTourMinute: {
    label: "毎日の大会: 分",
    help: "スタートの分",
    unit: "分",
    group: "prize",
    min: 0,
    max: 59,
    int: true,
  },
  autoTourGradeWeekday: {
    label: "毎日の大会: 月〜土の格",
    help: "1 = 小・2 = 中・3 = 大。格ではじめの景品が変わる",
    unit: "",
    group: "prize",
    min: 1,
    max: 3,
    int: true,
  },
  autoTourGradeSunday: {
    label: "毎日の大会: 日曜の格",
    help: "1 = 小・2 = 中・3 = 大 (大の 1 位には限界設計図)",
    unit: "",
    group: "prize",
    min: 1,
    max: 3,
    int: true,
  },
  // ---------------------------------------------------------------- 走行点 (racepoints.ts。交換所の一覧は管理者の画面の「走行点」で)
  rpOn: {
    label: "走行点: 使う",
    help: "切にすると、レースで走行点がたまらず、交換所でも交換できない (ギフトコードと大会の景品の走行点は入る)",
    unit: "",
    group: "rp",
  },
  rpFinish: {
    label: "走行点: 完走の点",
    help: "自分で走って完走したときの点 (すぐ走る・部屋・大会)。周の数の倍率を掛ける (2 周 ×1・5 周 ×1.75・10 周 ×3)",
    unit: "点",
    group: "rp",
    min: 0,
    max: ADMIN_RP_MAX,
    int: true,
  },
  rpPosBonus: {
    label: "走行点: 1 位の上乗せ",
    help: "1 位の上乗せ。1 つ下がるごとに 1 減る (5 なら 1 位 +5 … 5 位 +1、6 位から 0)。完走の点と足してから周の倍率を掛ける",
    unit: "点",
    group: "rp",
    min: 0,
    max: 100,
    int: true,
  },
  rpTourMul: {
    label: "走行点: 大会の倍率",
    help: "大会を自分で走ったときに掛ける (代走は 0)。大会は 1 日 1 回なので 1 日の上限に数えない",
    unit: "倍",
    group: "rp",
    min: 0,
    max: ADMIN_MUL_MAX,
  },
  rpTaLap: {
    label: "走行点: 1 周アタックの 1 周",
    help: "1 周アタックで確かめの通った周を送ったときの点 (1 日の上限に数える)",
    unit: "点",
    group: "rp",
    min: 0,
    max: ADMIN_RP_MAX,
    int: true,
  },
  rpTaBest: {
    label: "走行点: 1 周アタックの記録更新",
    help: "1 周アタックで自分の週の記録を縮めたときの点 (1 周の点の代わり。1 日の上限に数える)",
    unit: "点",
    group: "rp",
    min: 0,
    max: ADMIN_RP_MAX,
    int: true,
  },
  rpDailyCap: {
    label: "走行点: 1 日の上限",
    help: "1 日 (日本時間) にレース (すぐ走る・部屋) と 1 周アタックでもらえる点の上限。コンピューターだけの部屋を回して稼ぎすぎないように",
    unit: "点",
    group: "rp",
    min: 0,
    max: ADMIN_RP_CAP_MAX,
    int: true,
  },
  // ---------------------------------------------------------------- 遊ぶ人
  inviteOnly: {
    label: "招かれた人だけ登録できる",
    help: "入にすると、管理者の作った招待の合言葉を持つ人だけが新しく登録できる (今いる人はそのまま)",
    unit: "",
    group: "players",
  },
  announcement: {
    label: "お知らせ (オープニングの 1 行)",
    help: "ゲームを開いたときのオープニングの画面の隅に出す 1 行 (例: 今夜 22:30 の大会は大の格)。空 = 出さない",
    unit: "",
    group: "players",
    maxLen: ANNOUNCEMENT_MAX,
  },
};

/** 項目 (「season.everydayMul」のように中の項目は . でつなぐ) の説明。無ければ null */
export function adminFieldMeta(path: string): (AdminFieldMeta | AdminSubMeta) & { group?: AdminGroupId } | null {
  const [top, sub] = path.split(".", 2);
  const m = (ADMIN_CONFIG_META as Record<string, AdminFieldMeta | undefined>)[top];
  if (!m) return null;
  if (sub === undefined) return m;
  const s = m.sub?.[sub];
  return s ? { ...s, group: m.group } : null;
}

/** 画面の名前 (説明の無い項目は項目の名前のまま) */
export function adminLabel(path: string): string {
  const [top, sub] = path.split(".", 2);
  const m = (ADMIN_CONFIG_META as Record<string, AdminFieldMeta | undefined>)[top];
  if (sub === undefined) return m?.label ?? top;
  return `${m?.label ?? top}: ${m?.sub?.[sub]?.label ?? sub}`;
}

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const short = (n: number) => String(Math.round(n * 10000) / 10000);
const pct = (n: number) => `${short(n * 100)}%`;

function unitText(unit: string, n: number): string {
  if (unit === "円") return `${yen(n)} 円`;
  if (unit === "倍") return `×${short(n)}`;
  if (unit === "割合") return `${short(n)} (${pct(n)})`;
  if (unit === "%") return `${short(n)}%`;
  if (unit === "") return short(n);
  return `${short(n)} ${unit}`;
}

/** 値を単位つきの字に (記録と「変える前と後」に使う) */
export function adminValueText(path: string, v: unknown): string {
  if (v === null || v === undefined) return "なし";
  if (typeof v === "boolean") return v ? "入" : "切";
  if (typeof v === "string") return v === "" ? "(空)" : `「${v}」`;
  const m = adminFieldMeta(path);
  const unit = m?.unit ?? "";
  if (typeof v === "number") return unitText(unit, v);
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "number" && unit === "円" ? yen(x) : String(x))).join(" / ") + (unit === "円" ? " 円" : unit === "倍" ? " 倍" : "") : "(なし)";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${String(x)}`).join("・");
  return String(v);
}

/** 幅の字 (例: 「0〜1 (0〜100%)」「8 個・1 つ 0〜10」) */
export function adminRangeText(path: string): string {
  const m = adminFieldMeta(path);
  if (m && "maxLen" in m && m.maxLen !== undefined) return `${m.maxLen} 字まで・1 行・空 = 出さない`;
  if (!m || m.min === undefined || m.max === undefined) return "";
  const r = m.unit === "割合" ? `${short(m.min)}〜${short(m.max)} (${pct(m.min)}〜${pct(m.max)})` : `${unitText(m.unit, m.min)}〜${unitText(m.unit, m.max)}`;
  const len = "len" in m ? m.len : undefined;
  const lenText = len ? (len[0] === len[1] ? `${len[0]} 個` : `${len[0]}〜${len[1]} 個`) : "";
  return [lenText, `${len ? "1 つ " : ""}${r}${m.int ? "・整数" : ""}`, "nullable" in m && m.nullable ? "空 = なし" : ""].filter(Boolean).join("・");
}

/** 並びの 1 つずつの名前 (i は 0 から) */
export function adminItemLabel(path: string, i: number): string {
  const m = adminFieldMeta(path);
  const t = m && "item" in m && m.item ? m.item : "{n}";
  return t.replace("{n}", String(i + 1));
}

/**
 * 1 つの値を説明の幅で確かめる。よければ null、悪ければわけ (日本語)。説明の無い項目は確かめない (サーバーが確かめる)
 */
export function checkAdminValue(path: string, v: unknown): string | null {
  const m = adminFieldMeta(path);
  if (!m) return null;
  const isTop = !path.includes(".");
  const fm = isTop ? (m as AdminFieldMeta) : null;
  if (fm?.sub) return null;
  if (fm?.nullable && v === null) return null;
  const def = isTop ? (DEFAULT_ADMIN_CONFIG as unknown as Record<string, unknown>)[path] : undefined;
  if (typeof def === "boolean") return typeof v === "boolean" ? null : "入か切にしてください";
  if (typeof def === "string") return path === "announcement" ? checkAnnouncement(v) : typeof v === "string" ? null : "文字を入れてください";
  const one = (x: unknown): string | null => {
    if (typeof x !== "number" || !Number.isFinite(x)) return "数を入れてください";
    if (m.int && !Number.isInteger(x)) return "整数にしてください";
    if (m.min !== undefined && x < m.min) return `小さすぎます (${adminRangeText(path)})`;
    if (m.max !== undefined && x > m.max) return `大きすぎます (${adminRangeText(path)})`;
    return null;
  };
  if (fm?.len) {
    if (!Array.isArray(v)) return "数の並びにしてください";
    const [lo, hi] = fm.len;
    if (v.length < lo || v.length > hi) return lo === hi ? `${lo} 個にしてください (今 ${v.length} 個)` : `${lo}〜${hi} 個にしてください (今 ${v.length} 個)`;
    for (let i = 0; i < v.length; i++) {
      const e = one(v[i]);
      if (e) return `${adminItemLabel(path, i)}: ${e}`;
    }
    return null;
  }
  return one(v);
}

export interface AdminChange {
  /** 項目 (中の項目は「season.everydayMul」) */
  path: string;
  before: unknown;
  after: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 2 つの数の違い (中の項目のある物は中ごとに) */
export function diffAdminConfig(before: Readonly<Record<string, unknown>> | Readonly<AdminConfig>, after: Readonly<Record<string, unknown>> | Readonly<AdminConfig>): AdminChange[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const out: AdminChange[] = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    if (same(a[k], b[k])) continue;
    if (isObj(a[k]) && isObj(b[k])) {
      const sa = a[k] as Record<string, unknown>;
      const sb = b[k] as Record<string, unknown>;
      for (const sk of [...new Set([...Object.keys(sa), ...Object.keys(sb)])]) if (!same(sa[sk], sb[sk])) out.push({ path: `${k}.${sk}`, before: sa[sk] ?? null, after: sb[sk] ?? null });
    } else out.push({ path: k, before: a[k] ?? null, after: b[k] ?? null });
  }
  return out;
}

/** 書き出しの形 (読みこみはこれも、AdminConfig そのままも受ける) */
export const ADMIN_EXPORT_KIND = "bpr-admin-config";

export function adminExport(cfg: Readonly<AdminConfig>, at: number): { kind: string; at: number; config: AdminConfig } {
  return { kind: ADMIN_EXPORT_KIND, at, config: cfg as AdminConfig };
}

export type AdminImportCheck = { ok: true; config: AdminConfig; changes: AdminChange[] } | { ok: false; errors: string[] };

/**
 * 貼りつけた JSON を確かめる (サーバーと同じ applyAdminPatch)。書いてある項目だけ替える。
 * errors は日本語 (どの項目がなぜ)
 */
export function parseAdminImport(text: string, current: Readonly<AdminConfig>): AdminImportCheck {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["JSON として読めません (かっこや , を確かめてください)"] };
  }
  if (isObj(x) && isObj(x.config)) x = x.config;
  if (!isObj(x)) return { ok: false, errors: ["数の表 ({ … }) ではありません"] };
  const r = applyAdminPatch(current, x);
  if (!r.ok) return { ok: false, errors: adminErrorTexts(r.errors, x) };
  return { ok: true, config: r.config, changes: diffAdminConfig(current, r.config) };
}

/** applyAdminPatch の errors (項目の名前) → 日本語。patch があれば値も見てわけを足す */
export function adminErrorTexts(errors: readonly string[], patch?: Readonly<Record<string, unknown>>): string[] {
  return errors.map((e) => {
    if (e.startsWith("unknown:")) return `知らない項目: ${e.slice(8)}`;
    if (e === "patch" || e === "config") return "数の表 ({ … }) ではありません";
    const v = patch?.[e];
    const m = ADMIN_CONFIG_META[e as keyof AdminConfig];
    let why: string | null = null;
    if (m?.sub && isObj(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        const w = checkAdminValue(`${e}.${sk}`, sv);
        if (w) {
          why = `${m.sub[sk]?.label ?? sk}: ${w}`;
          break;
        }
      }
    } else if (patch && e in patch) why = checkAdminValue(e, v);
    return `${adminLabel(e)}: ${why ?? "形か幅がおかしい"}`;
  });
}

// ---------------------------------------------------------------- 例 (いまの数で計算した小さな目安)

/**
 * マニュアルの上がり分 → 1 周が何 % 速いかの目安 (はじめの車・コンピューターの上手な変速・全部のコースの平均。11/25 に測った)。
 * 間は線でつなぐ。速さが上がる分のうち 1 周に効くのは 2 割ほど (曲がりとブレーキは同じなので)
 */
export const MANUAL_LAP_GAIN: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.03, 0.0063],
  [0.1, 0.0191],
  [0.3, 0.0485],
];

export function manualLapGain(bonus: number): number {
  const t = MANUAL_LAP_GAIN;
  if (bonus <= 0) return 0;
  for (let i = 1; i < t.length; i++) {
    if (bonus <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      return y0 + ((bonus - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return t[t.length - 1][1];
}

const x = (n: number) => short(n);

/** 項目の例 (いまの数 cfg で)。無ければ [] */
export function adminPreview(path: string, cfg: Readonly<AdminConfig>): string[] {
  const top = path.split(".")[0];
  const win = POINTS[0];
  const sixth = POINTS[5];
  switch (top) {
    case "prizePerPoint":
    case "prizeFinish":
    case "cpuOnlyPrizeRate": {
      const p = (pos: number, points: number, cpuOnly: boolean) => racePrizeFor(cfg, "everyday", { pos, points, finished: true }, { laps: 5, cpuOnly });
      return [
        `5 周で優勝 (${win} 点) → ${yen(p(1, win, false))} 円`,
        `5 周で 6 位完走 (${sixth} 点) → ${yen(p(6, sixth, false))} 円`,
        `コンピューターとだけ 5 周で優勝 → ${yen(p(1, win, true))} 円`,
      ];
    }
    case "tournamentPrize": {
      const t = cfg.tournamentPrize;
      return [`大会の 1 位 → ${yen(t[0] ?? 0)} 円・${t.length} 位 → ${yen(t[t.length - 1] ?? 0)} 円 (1 大会の合計 ${yen(t.reduce((s, v) => s + v, 0))} 円)`];
    }
    case "practicePrizePerLap":
      return [`練習を 10 周 → ${yen(cfg.practicePrizePerLap * 10)} 円`];
    case "seasonPrize":
    case "seasonPrizeClassMul":
      return [1, 5].map((c) => `${c} 級の 1 位 → ${yen(cfg.seasonPrize[0] ?? 0)} × ${x(cfg.seasonPrizeClassMul[c - 1])} = ${yen(seasonPrizeFor(cfg, c as 1 | 5, 1))} 円`);
    case "leaguePrize":
    case "leaguePrizeDivisionMul":
      return [1, DIVISION_COUNT].map((d) => `${d} 部の毎日 1 位 → ${yen(cfg.leaguePrize[0] ?? 0)} × ${x(cfg.leaguePrizeDivisionMul[d - 1] ?? 0)} = ${yen(leaguePrizeFor(cfg, d, 1))} 円`);
    case "season": {
      const s = cfg.season;
      return [
        `普段のレースで優勝 (${win} 点) → 季節の点 ${Math.round(win * s.everydayMul)}`,
        `大会で優勝 → 季節の点 ${Math.round(win * s.tournamentMul)}`,
        `コンピューターとだけで優勝 → 季節の点 ${Math.round(win * s.everydayMul * s.cpuOnlyMul)}`,
      ];
    }
    case "constructorLeagueWeight":
    case "constructorDivisionMul":
      return [1, DIVISION_COUNT].map((d) => {
        const m = cfg.constructorDivisionMul[d - 1] ?? 1;
        return `${d} 部で 1 日 10 点 → 10 × ${x(cfg.constructorLeagueWeight)} × ${x(m)} = ${x(10 * cfg.constructorLeagueWeight * m)} 点`;
      });
    case "constructorPrize":
    case "constructorPrizeClassMul":
    case "driverChampionPrize":
      return [1, 5].map((c) => {
        const m = cfg.constructorPrizeClassMul[c - 1] ?? 1;
        return `${c} 級のチャンピオン → コンストラクター ${yen(cfg.constructorPrize * m)} 円・ドライバーズ ${yen(cfg.driverChampionPrize * m)} 円 (×${x(m)})`;
      });
    case "constructorOverallPrize":
    case "driverOverallPrize":
      return [`総合のチャンピオン → コンストラクター ${yen(cfg.constructorOverallPrize)} 円・ドライバーズ ${yen(cfg.driverOverallPrize)} 円`];
    case "partStrength":
    case "partKindStrength": {
      const kinds = (path.includes(".") ? [path.split(".")[1]] : ["engine", "tire"]) as PartKind[];
      return kinds.filter((k) => k in cfg.partKindStrength).map((k) => `${KIND_NAMES[k]}の強さ → ${x(cfg.partStrength)} × ${x(cfg.partKindStrength[k as BasePartKind])} = ×${x(partStrengthFor(cfg, k))}`);
    }
    case "announcement":
      return cfg.announcement ? [`オープニングの隅に「${cfg.announcement}」(${Array.from(cfg.announcement).length} / ${ANNOUNCEMENT_MAX} 字)`] : ["空なので出しません"];
    case "manualSpeedBonus": {
      const b = cfg.manualSpeedBonus;
      return [`マニュアル +${pct(b)} → 最高速と加速が ${pct(b)} 上がり、1 周 約 ${pct(Math.round(manualLapGain(b) * 1000) / 1000)} 速い (はじめの車・上手な変速の目安)`];
    }
    case "betMargin": {
      const o = (p: number) => betOdds(p, cfg.betMargin);
      return [`勝つ見込み 50% → 倍率 ${o(0.5) ?? "出さない"}・見込み 10% → 倍率 ${o(0.1) ?? "出さない"}`];
    }
    case "rpOn":
    case "rpFinish":
    case "rpPosBonus":
    case "rpTourMul": {
      const r = (pos: number, laps: number, kind: "everyday" | "tournament") => rpForRace(cfg, { pos, finished: true }, { laps, kind });
      return [`5 周で優勝 → ${r(1, 5, "everyday")} 点・5 周で 6 位完走 → ${r(6, 5, "everyday")} 点・10 周で優勝 → ${r(1, 10, "everyday")} 点`, `大会 (10 周) で優勝 → ${r(1, 10, "tournament")} 点・8 位完走 → ${r(8, 10, "tournament")} 点`];
    }
    case "rpTaLap":
    case "rpTaBest":
      return [`1 周アタックを 20 周 (うち記録更新 2 回) → ${cfg.rpTaLap * 18 + cfg.rpTaBest * 2} 点 (1 日の上限まで)`];
    case "rpDailyCap": {
      const m = rpMonthEstimate(cfg);
      return [
        `5 周で 3 位なら ${rpForRace(cfg, { pos: 3, finished: true }, { laps: 5, kind: "everyday" }) ? Math.ceil(cfg.rpDailyCap / rpForRace(cfg, { pos: 3, finished: true }, { laps: 5, kind: "everyday" })) : "—"} レースで上限`,
        `毎日上限まで + 毎日の大会 → 30 日で約 ${yen(m.total)} 点 (上限 ${yen(m.capped)}・大会 ${yen(m.tour)}・参加賞 ${yen(m.prize)})`,
      ];
    }
    case "marketFeeRate": {
      const f = marketFeeFor(cfg, 10000);
      return [`10,000 円で売れた → 手数料 ${yen(f)} 円 (売った人に ${yen(10000 - f)} 円)`];
    }
    default:
      return [];
  }
}
