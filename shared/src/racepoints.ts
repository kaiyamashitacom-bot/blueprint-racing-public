// 走行点 (DECISIONS 11/25「走って点をためて交換」)。レースを自分で走ってためる点と、交換所 (交換できる物の一覧) の形と確かめ。
// - たまるのは自分で走ったレースだけ: すぐ走る・部屋・大会 (代走でないとき)・1 周アタック (送った周ごと / 自分の記録を縮めたとき)。
//   リーグ戦 (いつも代走) と、大会や部屋の代走の車・雇った運転手の 2 台目は入らない
// - 完走で点、順位が良いほど少し多め。周の数で増える (money.ts の lapsFactor と同じ: 2 周 ×1・5 周 ×1.75・10 周 ×3)
// - 1 日 (日本時間) の上限: すぐ走る・部屋・1 周アタックの合計。大会は 1 日 1 回で稼げないので上限に数えない。
//   ギフトコードと大会の参加賞 (景品) も上限の外
// - 交換所の中身はギフトコードと同じ登録表 (gift.ts の GIFT_KINDS)。当てるのはサーバー (server/src/racepoints.ts → gift.ts の GIFT_APPLY)
// 保存と受け口は server/src/racepoints.ts、数 (点の入り方・上限・入 / 切) は AdminConfig の rp*。数は全部 (仮)。
import type { AdminConfig } from "./adminconfig.ts";
import { jstDayStart, jstWeekday } from "./dailytour.ts";
import { NO_GIFT_CAPS, checkGiftItems, describeGiftItem, type GiftCaps, type GiftItem, type GiftNames } from "./gift.ts";
import { ITEM_IDS, SHARDS_PER_ITEM } from "./items.ts";
import { lapsFactor } from "./money.ts";

const DAY_MS = 24 * 3600_000;

/** 点の名前 (ギフトの登録表と大会の景品はこの名前で探す) */
export const RP_NAME = "走行点";

export type RpConfig = Pick<AdminConfig, "rpOn" | "rpFinish" | "rpPosBonus" | "rpTourMul" | "rpTaLap" | "rpTaBest" | "rpDailyCap">;

/** 帳簿の種類: レース (すぐ走る・部屋)・大会・1 周アタック・ギフトコード・景品 (大会の参加賞など)・交換 */
export type RpKind = "race" | "tour" | "ta" | "gift" | "prize" | "buy";
export const RP_KIND_JP: Readonly<Record<RpKind, string>> = { race: "レース", tour: "大会", ta: "1 周アタック", gift: "ギフトコード", prize: "景品", buy: "交換" };

/**
 * 自分で走った 1 台の走行点 (上限の前)。完走していない・失格は 0。
 * (完走の点 + 順位の上乗せ) × 周の数の倍率 (× 大会の倍率)。順位の上乗せは 1 位 = rpPosBonus、1 つ下がるごとに 1 減る
 */
export function rpForRace(cfg: Readonly<RpConfig>, row: { pos: number; finished: boolean; dq?: boolean }, race: { laps: number; kind: "everyday" | "tournament" }): number {
  if (!cfg.rpOn || !row.finished || row.dq) return 0;
  const bonus = Math.max(0, cfg.rpPosBonus + 1 - Math.max(1, Math.floor(row.pos)));
  const mul = race.kind === "tournament" ? cfg.rpTourMul : 1;
  return Math.max(0, Math.round((cfg.rpFinish + bonus) * lapsFactor(race.laps) * mul));
}

/** 1 周アタックの 1 周 (確かめが通った周)。自分の記録を縮めたら rpTaBest、ほかは rpTaLap */
export function rpForTa(cfg: Readonly<RpConfig>, improved: boolean): number {
  if (!cfg.rpOn) return 0;
  return Math.max(0, Math.floor(improved ? cfg.rpTaBest : cfg.rpTaLap));
}

/** 上限のあるものの実際に入る数 (今日もうもらった数 earnedToday) */
export function rpCapped(amount: number, earnedToday: number, cap: number): number {
  return Math.max(0, Math.min(Math.floor(amount), Math.floor(cap) - Math.floor(earnedToday)));
}

/** 上限の日 (日本時間のその日の 0:00) */
export const rpDay = (t: number) => jstDayStart(t);

/** 日本時間の週の始め (月曜 0:00)。交換の「週に何回」はここから数える */
export function jstWeekStart(t: number): number {
  return jstDayStart(t) - ((jstWeekday(t) + 6) % 7) * DAY_MS;
}

// ---------------------------------------------------------------- 交換所

/** 一覧の数・名前と説明の長さ・値段と回数の幅 (仮) */
export const RP_SHOP_MAX = 60;
export const RP_NAME_MAX = 24;
export const RP_NOTE_MAX = 80;
export const RP_PRICE_MAX = 1_000_000;
export const RP_LIMIT_MAX = 999;

/** 交換所の 1 つ (管理者が作る・直す形) */
export interface RpShopInput {
  name: string;
  note: string;
  items: GiftItem[];
  price: number;
  /** 1 人が 1 週 (月曜はじまり、日本時間) に交換できる回数。null = 何回でも */
  limitWeek: number | null;
  /** 1 人が全部で交換できる回数。null = 何回でも */
  limitTotal: number | null;
  /** 一覧に出さない (しまっておく) */
  hidden: boolean;
}

export interface RpShopEntry extends RpShopInput {
  id: number;
  /** 並び (小さいほど上) */
  sort: number;
}

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? [...v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, "").trim()].slice(0, max).join("") : "";

/**
 * 交換所の 1 つを確かめる。base があれば直すとき (無い項目は base のまま)。
 * 中身はギフトコードと同じ確かめ (checkGiftItems、管理者の上限 caps も)
 */
export function checkRpShopInput(raw: unknown, caps: Readonly<GiftCaps> = NO_GIFT_CAPS, base?: Readonly<RpShopInput>): { ok: true; entry: RpShopInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "中身が読めません" };
  const b = raw as Record<string, unknown>;
  const out: RpShopInput = base ? { ...base, items: base.items.map((x) => ({ kind: x.kind, p: { ...x.p } })) } : { name: "", note: "", items: [], price: 0, limitWeek: null, limitTotal: null, hidden: false };
  if (!base || b.name !== undefined) {
    const name = clean(b.name, RP_NAME_MAX);
    if (!name) return { ok: false, error: `名前は 1〜${RP_NAME_MAX} 字です` };
    out.name = name;
  }
  if (b.note !== undefined) out.note = clean(b.note, RP_NOTE_MAX);
  if (!base || b.items !== undefined) {
    const c = checkGiftItems(b.items, caps);
    if (!c.ok) return c;
    out.items = c.items;
  }
  if (!base || b.price !== undefined) {
    const v = typeof b.price === "string" ? Number(b.price) : b.price;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > RP_PRICE_MAX) return { ok: false, error: `値段は 1〜${RP_PRICE_MAX.toLocaleString("ja-JP")} 点の整数です` };
    out.price = v;
  }
  for (const [key, label] of [
    ["limitWeek", "週の回数"],
    ["limitTotal", "全部の回数"],
  ] as const) {
    if (b[key] === undefined) continue;
    if (b[key] === null || b[key] === "") {
      out[key] = null;
      continue;
    }
    const v = typeof b[key] === "string" ? Number(b[key]) : b[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > RP_LIMIT_MAX) return { ok: false, error: `${label}は 1〜${RP_LIMIT_MAX} か「なし」です` };
    out[key] = v;
  }
  if (b.hidden !== undefined) {
    if (typeof b.hidden !== "boolean") return { ok: false, error: "しまうかどうかがおかしいです" };
    out.hidden = b.hidden;
  }
  return { ok: true, entry: out };
}

/** 中身の言い表し (「限界突破のかけら ×1」など) */
export function rpShopLines(items: readonly GiftItem[], names?: GiftNames): string[] {
  return items.map((it) => describeGiftItem(it, names));
}

/** 回数の言い表し (「週 3 回まで・全部で 1 回まで」)。なければ "" */
export function rpLimitText(e: Pick<RpShopInput, "limitWeek" | "limitTotal">): string {
  const bits: string[] = [];
  if (e.limitWeek !== null) bits.push(`週 ${e.limitWeek} 回まで`);
  if (e.limitTotal !== null) bits.push(`全部で ${e.limitTotal} 回まで`);
  return bits.join("・");
}

/**
 * はじめの交換所 (仮。はじめて開いたときに 1 回だけ入る。あとは管理者が直す)。
 * 値段のもと: 熱心な人が毎日上限 (はじめ 150) までためると 30 日で 4,500 点。毎日の大会を自分で走ると 1 回 30〜45 点 (10 周 ×3)、
 * 参加賞 (中 30・日曜の大 50) が 30 日で約 980 点。合わせて月に約 6,400 点。
 * 限界突破のかけら 600 点 × 10 個 = 6,000 点 ≒ 1 か月で限界設計図 1 つ。週 3 個まで (月に 12〜13 個が上限) にして、ためこんだ点で一気に買えないようにする
 */
export const DEFAULT_RP_SHOP: readonly RpShopInput[] = [
  {
    name: "限界突破のかけら",
    note: `${SHARDS_PER_ITEM} 個で限界設計図 1 つ (持ち物の「限界突破の品」で作る)`,
    items: [{ kind: "item", p: { item: ITEM_IDS.limitShard, count: 1 } }],
    price: 600,
    limitWeek: 3,
    limitTotal: null,
    hidden: false,
  },
  {
    name: "指導のかけら",
    note: `${SHARDS_PER_ITEM} 個で特別指導書 1 つ`,
    items: [{ kind: "item", p: { item: ITEM_IDS.coachShard, count: 1 } }],
    price: 500,
    limitWeek: 3,
    limitTotal: null,
    hidden: false,
  },
  {
    name: "研究を 3 時間進める",
    note: "研究中のもの全部を 3 時間進める (研究していないときは交換できない)",
    items: [{ kind: "research", p: { mode: "advance", node: "", hours: 3 } }],
    price: 120,
    limitWeek: 5,
    limitTotal: null,
    hidden: false,
  },
  {
    name: "進化の資金 3,000",
    note: "部品の進化などに使えるお金 (財布に入る)",
    items: [{ kind: "money", p: { amount: 3000 } }],
    price: 150,
    limitWeek: 5,
    limitTotal: null,
    hidden: false,
  },
  {
    name: "紋章「金の盾」",
    note: "チームの紋章を 金の盾に黒い星 にする",
    items: [{ kind: "emblem", p: { shape: "shield", color: "#c9a227", mark: "star", markColor: "#111111" } }],
    price: 400,
    limitWeek: null,
    limitTotal: 1,
    hidden: false,
  },
  {
    name: "紋章「夜の六角」",
    note: "チームの紋章を 紺の六角に緑の稲妻 にする",
    items: [{ kind: "emblem", p: { shape: "hexagon", color: "#121826", mark: "bolt", markColor: "#39d353" } }],
    price: 400,
    limitWeek: null,
    limitTotal: 1,
    hidden: false,
  },
  {
    name: "称号「走りこみ職人」",
    note: "チーム名の横に出る称号",
    items: [{ kind: "title", p: { text: "走りこみ職人" } }],
    price: 800,
    limitWeek: null,
    limitTotal: 1,
    hidden: false,
  },
  {
    name: "称号「サーキットの主」",
    note: "チーム名の横に出る称号",
    items: [{ kind: "title", p: { text: "サーキットの主" } }],
    price: 3000,
    limitWeek: null,
    limitTotal: 1,
    hidden: false,
  },
];

/**
 * 1 か月 (30 日) の目安 (管理者の画面の例と試験で使う)。毎日 上限までためて、毎日の大会を自分で走って真ん中あたりで完走した人。
 * prizePerDay = 大会の参加賞の 1 日の平均 (はじめ: 中 30 × 6 日 + 大 50 × 1 日 ÷ 7 ≒ 33)
 */
export function rpMonthEstimate(cfg: Readonly<RpConfig>, o: { tourLaps?: number; tourPos?: number; prizePerDay?: number } = {}): { capped: number; tour: number; prize: number; total: number } {
  const capped = Math.max(0, cfg.rpDailyCap) * 30;
  const tour = rpForRace(cfg, { pos: o.tourPos ?? 8, finished: true }, { laps: o.tourLaps ?? 10, kind: "tournament" }) * 30;
  const prize = Math.round((o.prizePerDay ?? (30 * 6 + 50) / 7) * 30);
  return { capped, tour, prize, total: capped + tour + prize };
}
