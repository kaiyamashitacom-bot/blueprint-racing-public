// ギフトコードの中身の種類 (登録表)。画面とサーバーの両方で使う (DECISIONS 11/25「ギフトコード」「全ての概念をいじれるように」)。
// - 種類ごとに id・名前・項目 (形)・確かめ・言い表し を持つ。管理者の画面はこの表から中身の入力欄を作るので、種類を足すと画面に自動で並ぶ
// - 当てる (受け取る) ところはサーバー (server/src/gift.ts の GIFT_APPLY。種類ごとに 1 つ要る、型で確かめる)
// - 中身の上限は無い (管理者が自由に決める)。付けたいときだけ AdminConfig の gift*Max で付ける (はじめは null = 上限なし)
// - コードの文字はここにもどこにも書かない (本番のデータにだけ置く)
// 数は全部 (仮)。
import type { AdminConfig } from "./adminconfig.ts";
import { CREW } from "./crew.ts";
import { STAT_KEYS } from "./drivers.ts";
import { MAX_PER_PART } from "./inventory.ts";
import { DIVISION_COUNT, divisionTitle } from "./league.ts";
import { BOT_DESIGNS, SAMPLE_DESIGN } from "./presets.ts";
import type { CarDesign } from "./design.ts";
import { nextLimitId } from "./evolution.ts";
import { ITEM_DEFS, ITEM_MAX, itemDef } from "./items.ts";
import type { PartDef } from "./parts.ts";
import { ALL_PART_DEFS, RESEARCH_DEFS, anyPartDef, researchDef } from "./research.ts";
import { CLASS_IDS } from "./season.ts";
import { STAMP_DEFS, type StampId } from "./stamps.ts";
import { EMBLEM_MARKS, EMBLEM_SHAPES, validateEmblem } from "./team.ts";

/** コードの文字の長さ (仮) */
export const GIFT_CODE_MIN = 4;
export const GIFT_CODE_MAX = 24;
/** 作るときに決める (おまかせ) コードの長さと字 (見まちがえやすい 0 O 1 I L を除く) */
export const GIFT_RANDOM_LEN = 8;
export const GIFT_RANDOM_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 1 つのコードに入れられる中身の数・メモの長さ・使える人を決めるときの ID の数 (仮) */
export const GIFT_ITEMS_MAX = 20;
export const GIFT_NOTE_MAX = 60;
export const GIFT_TARGETS_MAX = 50;
/** 使える人数の上限の幅 (仮。null = 何人でも) */
export const GIFT_USES_MAX = 1_000_000;
/** お金の 1 つの中身の形の上限 (管理者の上限とは別の、壊れないための幅。仮) */
export const GIFT_MONEY_LIMIT = 10_000_000;
/** 走行点の 1 つの中身の形の上限 (壊れないための幅。仮) */
export const GIFT_RP_LIMIT = 1_000_000;
/** 贈る称号の長さ (仮) */
export const GIFT_TITLE_MAX = 12;
/** 研究を進める時間の幅 (時間、仮) */
export const GIFT_RESEARCH_HOURS_MAX = 10_000;
/** 運転手の能力の上限 */
export const DRIVER_STAT_CAP = 100;

/** 打ちこまれたコードをそろえる (空白を除いて大文字)。形がちがえば null */
export function normalizeGiftCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  if (s.length < GIFT_CODE_MIN || s.length > GIFT_CODE_MAX) return null;
  return /^[A-Z0-9_-]+$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- 項目の形

export type GiftFieldType = "int" | "part" | "stamp" | "driver" | "research" | "select" | "text" | "color";

export interface GiftFieldDef {
  key: string;
  label: string;
  type: GiftFieldType;
  /** int の幅 */
  min?: number;
  max?: number;
  /** text の長さ */
  maxLen?: number;
  /** select の候補 (part・stamp・research の候補は giftFieldOptions が作る) */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** 空でよい (research の「研究中の全部」など) */
  optional?: boolean;
  /** はじめの値 */
  def?: string | number;
  hint?: string;
}

export type GiftKindId =
  | "money"
  | "race_points"
  | "part"
  | "item"
  | "driver_discount"
  | "driver_hire"
  | "driver_stats"
  | "research"
  | "crew"
  | "stamp"
  | "title"
  | "emblem"
  | "design"
  | "division"
  | "class";

/** 中身 1 つ。p は項目の値 (key → 値) */
export interface GiftItem {
  kind: GiftKindId;
  p: Record<string, string | number>;
}

/** 管理者が付けられる上限 (AdminConfig の gift*Max。null = なし) */
export type GiftCaps = Pick<AdminConfig, "giftMoneyMax" | "giftPartTierMax" | "giftPartCountMax" | "giftDiscountMax">;

export const NO_GIFT_CAPS: Readonly<GiftCaps> = { giftMoneyMax: null, giftPartTierMax: null, giftPartCountMax: null, giftDiscountMax: null };

/** 言い表すときに名前を引く (運転手の名前はサーバーにしかない) */
export interface GiftNames {
  driver?(id: string): string | undefined;
}

export interface GiftKindDef {
  id: GiftKindId;
  /** 画面用の名前 */
  label: string;
  /** 管理者向けの説明 */
  desc: string;
  /** すぐでなく次の区切りで効く (部 = 次の日の締め、級 = 次の季節の締め) */
  deferred?: "league_day" | "season";
  fields: readonly GiftFieldDef[];
  /** 項目の形のほかの確かめ (上限など)。悪ければ日本語のわけ */
  check?(p: Record<string, string | number>, caps: Readonly<GiftCaps>): string | null;
  /** 受け取った人に見せる言い表し */
  describe(p: Record<string, string | number>, names?: GiftNames): string;
}

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const STAT_JP: Record<string, string> = { all: "全部", speed: "速さ", stability: "安定", tyreFuel: "タイヤと燃料", pitSense: "ピットの判断" };
const SHAPE_JP: Record<string, string> = { circle: "丸", square: "四角", shield: "盾", diamond: "ひし形", hexagon: "六角", triangle: "三角" };
const MARK_JP: Record<string, string> = { none: "なし", star: "星", bolt: "稲妻", stripe: "帯", cross: "十字", ring: "輪", chevron: "山形", dot: "点", wing: "翼", wave: "波" };

/** 見本の車の設計図 (ギフトで写しを渡せるもの) */
export function giftDesignPresets(): Array<{ value: string; label: string; design: CarDesign }> {
  return [{ value: "sample", label: SAMPLE_DESIGN.name, design: SAMPLE_DESIGN }, ...BOT_DESIGNS.map((d, i) => ({ value: `bot${i}`, label: d.name, design: d }))];
}

export function giftDesignPreset(value: unknown): CarDesign | null {
  return giftDesignPresets().find((x) => x.value === value)?.design ?? null;
}

const n = (v: unknown) => Number(v);

/** 中身の種類の登録表 (この順に当てる: 運転手を雇ってから能力を上げる など) */
export const GIFT_KINDS: readonly GiftKindDef[] = [
  {
    id: "money",
    label: "お金",
    desc: "財布にお金を入れる",
    fields: [{ key: "amount", label: "額", type: "int", min: 1, max: GIFT_MONEY_LIMIT, def: 1000 }],
    check: (p, c) => (c.giftMoneyMax !== null && n(p.amount) > c.giftMoneyMax ? `お金は ${yen(c.giftMoneyMax)} までです (上限)` : null),
    describe: (p) => `お金 ${yen(n(p.amount))}`,
  },
  {
    // 走行点 (racepoints.ts)。大会のはじめの参加賞はこの名前「走行点」で探す (tourprize.ts)。1 日の上限の外
    id: "race_points",
    label: "走行点",
    desc: "走行点を入れる (交換所で使う点。1 日の上限には数えない)",
    fields: [{ key: "amount", label: "点", type: "int", min: 1, max: GIFT_RP_LIMIT, def: 100 }],
    describe: (p) => `走行点 ${yen(n(p.amount))}`,
  },
  {
    id: "part",
    label: "部品",
    desc: "部品を持ち物に入れる (研究の部品・段階 5 も選べる)",
    fields: [
      { key: "part", label: "部品", type: "part" },
      { key: "count", label: "数", type: "int", min: 1, max: MAX_PER_PART, def: 1 },
    ],
    check: (p, c) => {
      const d = anyPartDef(String(p.part));
      if (d && c.giftPartTierMax !== null && d.tier > c.giftPartTierMax) return `部品は段階 ${c.giftPartTierMax} までです (上限)`;
      if (c.giftPartCountMax !== null && n(p.count) > c.giftPartCountMax) return `部品は 1 つの中身で ${c.giftPartCountMax} 個までです (上限)`;
      return null;
    },
    describe: (p) => `部品: ${anyPartDef(String(p.part))?.name ?? p.part} ×${n(p.count)}`,
  },
  {
    id: "item",
    label: "限界突破の品",
    desc: "限界設計図・特別指導書・かけらを持ち物に入れる (お店で買えず、市場でも売れない品)",
    fields: [
      { key: "item", label: "品", type: "select", options: ITEM_DEFS.map((d) => ({ value: d.id, label: d.name })), def: ITEM_DEFS[0].id },
      { key: "count", label: "数", type: "int", min: 1, max: ITEM_MAX, def: 1 },
    ],
    describe: (p) => `${itemDef(String(p.item))?.name ?? p.item} ×${n(p.count)}`,
  },
  {
    id: "driver_discount",
    label: "運転手の契約金の割引",
    desc: "次に運転手を雇う / 契約を続けるときの契約金を 1 回だけ引く (重ねて持つと大きいほう)",
    fields: [{ key: "pct", label: "割引 (%)", type: "int", min: 1, max: 100, def: 20 }],
    check: (p, c) => (c.giftDiscountMax !== null && n(p.pct) > c.giftDiscountMax ? `割引は ${c.giftDiscountMax}% までです (上限)` : null),
    describe: (p) => `運転手の契約金 ${n(p.pct)}% 引き (次の 1 回)`,
  },
  {
    id: "driver_hire",
    label: "運転手と契約",
    desc: "空いている運転手とただで契約する (今の運転手は違約金なしで離れる)。ほかのチームと契約中なら受け取れない",
    fields: [{ key: "driver", label: "運転手", type: "driver" }],
    describe: (p, nm) => `運転手 ${nm?.driver?.(String(p.driver)) ?? p.driver} と契約`,
  },
  {
    id: "driver_stats",
    label: "運転手の能力を上げる",
    desc: "雇っている運転手の能力を上げる (100 まで。育ちきる上限も合わせて上がる)",
    fields: [
      { key: "stat", label: "能力", type: "select", options: [{ value: "all", label: "全部" }, ...STAT_KEYS.map((k) => ({ value: k, label: STAT_JP[k] }))], def: "all" },
      { key: "amount", label: "上げる数", type: "int", min: 1, max: DRIVER_STAT_CAP, def: 5 },
    ],
    describe: (p) => `運転手の能力 (${STAT_JP[String(p.stat)] ?? p.stat}) +${n(p.amount)}`,
  },
  {
    id: "research",
    label: "研究",
    desc: "研究を済ませる (前の節もいっしょに) か、研究中のものを進める",
    fields: [
      { key: "mode", label: "どうする", type: "select", options: [{ value: "finish", label: "済ませる" }, { value: "advance", label: "進める (時間)" }], def: "finish" },
      { key: "node", label: "研究の節", type: "research", optional: true, hint: "空 = 研究中の全部" },
      { key: "hours", label: "進める時間", type: "int", min: 0, max: GIFT_RESEARCH_HOURS_MAX, def: 0, hint: "進めるときだけ" },
    ],
    check: (p) => {
      if (p.mode === "advance" && !(n(p.hours) >= 1)) return "進める時間を 1 時間以上にしてください";
      if (p.mode === "finish" && n(p.hours) > 0) return "済ませるときは時間を 0 にしてください";
      return null;
    },
    describe: (p) => {
      const node = p.node ? (researchDef(String(p.node))?.part.name ?? p.node) : "研究中のもの";
      return p.mode === "finish" ? `研究: ${node} を済ませる` : `研究: ${node} を ${n(p.hours)} 時間進める`;
    },
  },
  {
    id: "crew",
    label: "整備の組の段",
    desc: `整備の設備の段を上げる (${CREW.maxLevel} 段まで)`,
    fields: [{ key: "levels", label: "上げる段", type: "int", min: 1, max: CREW.maxLevel - 1, def: 1 }],
    describe: (p) => `整備の組 +${n(p.levels)} 段`,
  },
  {
    id: "stamp",
    label: "はんこ",
    desc: "はんこ帳にはんこを押す",
    fields: [{ key: "stamp", label: "はんこ", type: "stamp" }],
    describe: (p) => `はんこ: ${STAMP_DEFS[String(p.stamp) as StampId]?.name ?? p.stamp}`,
  },
  {
    id: "title",
    label: "贈られた称号",
    desc: "チーム名の横に出る飾りの称号 (リーグ戦の肩書きとは別。新しいものに置きかわる)",
    fields: [{ key: "text", label: "称号", type: "text", maxLen: GIFT_TITLE_MAX }],
    describe: (p) => `称号「${p.text}」`,
  },
  {
    id: "emblem",
    label: "紋章",
    desc: "チームの紋章をこの形と色にする (形・印・色は誰でも選べるので、贈るのは決めた紋章)",
    fields: [
      { key: "shape", label: "地の形", type: "select", options: EMBLEM_SHAPES.map((s) => ({ value: s, label: SHAPE_JP[s] ?? s })), def: "shield" },
      { key: "color", label: "地の色", type: "color", def: "#e10600" },
      { key: "mark", label: "印", type: "select", options: EMBLEM_MARKS.map((s) => ({ value: s, label: MARK_JP[s] ?? s })), def: "star" },
      { key: "markColor", label: "印の色", type: "color", def: "#ffffff" },
    ],
    check: (p) => (validateEmblem({ shape: p.shape, color: p.color, mark: p.mark, markColor: p.markColor }) ? null : "紋章の形か色がおかしいです (地と印の色は別に)"),
    describe: (p) => `紋章 (${SHAPE_JP[String(p.shape)] ?? p.shape}・${MARK_JP[String(p.mark)] ?? p.mark})`,
  },
  {
    id: "design",
    label: "見本の設計図",
    desc: "見本の車の設計図の写しを設計図に足す (部品は付かない)",
    fields: [{ key: "preset", label: "設計図", type: "select", options: giftDesignPresets().map(({ value, label }) => ({ value, label })), def: "sample" }],
    describe: (p) => `設計図「${giftDesignPreset(p.preset)?.name ?? p.preset}」`,
  },
  {
    id: "division",
    label: "リーグ戦の部",
    desc: "リーグ戦の部を動かす。次の日の締めのあとに効く (その日の点と王者はそのまま)",
    deferred: "league_day",
    fields: [{ key: "division", label: "部", type: "int", min: 1, max: DIVISION_COUNT, def: 7 }],
    describe: (p) => `リーグ戦 ${n(p.division)} 部 (${divisionTitle(n(p.division))}) へ (次の日の締めのあと)`,
  },
  {
    id: "class",
    label: "本戦の級",
    desc: "季節の級を動かす。次の季節の締めで効く (その季節の点とチャンピオンはそのまま)",
    deferred: "season",
    fields: [{ key: "cls", label: "級", type: "int", min: CLASS_IDS[0], max: CLASS_IDS[CLASS_IDS.length - 1], def: 4 }],
    describe: (p) => `本戦 ${n(p.cls)} 級へ (次の季節の締めで)`,
  },
];

export function giftKind(id: unknown): GiftKindDef | undefined {
  return GIFT_KINDS.find((k) => k.id === id);
}

/** part・stamp・research・select の候補 (画面用) */
export function giftFieldOptions(f: GiftFieldDef): Array<{ value: string; label: string }> {
  if (f.options) return [...f.options];
  if (f.type === "stamp") return Object.values(STAMP_DEFS).map((s) => ({ value: s.id, label: s.name }));
  if (f.type === "research") return RESEARCH_DEFS.map((d) => ({ value: d.id, label: `${d.part.name} (段階 ${d.part.tier})` }));
  if (f.type === "part") return giftPartChoices().map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }));
  return [];
}

/**
 * ギフトで渡せる部品の全部 (お店・研究・進化の部品と、段階 5 の限界を超えた 5+・5++)。
 * 新しい部品を research.ts / evoparts.ts に足すと ここ (管理者の画面) に自動で並ぶ
 */
export function giftPartChoices(): PartDef[] {
  const out: PartDef[] = [];
  for (const p of ALL_PART_DEFS) {
    out.push(p);
    for (let id = nextLimitId(p.id); id; id = nextLimitId(id)) {
      const d = anyPartDef(id);
      if (d) out.push(d);
    }
  }
  return out;
}

/** 項目 1 つの形を確かめて、そろえた値を返す (悪ければ { error }) */
function checkField(f: GiftFieldDef, raw: unknown): { v: string | number } | { error: string } {
  const bad = { error: `${f.label} がおかしいです` };
  const empty = raw === undefined || raw === null || raw === "";
  if (empty && f.optional) return { v: "" };
  if (empty && f.def !== undefined && f.type === "int") return { v: Number(f.def) };
  switch (f.type) {
    case "int": {
      const v = typeof raw === "string" ? Number(raw.trim()) : raw;
      if (typeof v !== "number" || !Number.isInteger(v) || v < (f.min ?? -Infinity) || v > (f.max ?? Infinity)) return { error: `${f.label} は ${f.min ?? ""}〜${f.max ?? ""} の整数です` };
      return { v };
    }
    case "part":
      return typeof raw === "string" && anyPartDef(raw) ? { v: raw } : bad;
    case "stamp":
      return typeof raw === "string" && raw in STAMP_DEFS ? { v: raw } : bad;
    case "research":
      return typeof raw === "string" && researchDef(raw) ? { v: raw } : bad;
    case "driver":
      return typeof raw === "string" && /^[A-Za-z0-9_:-]{1,32}$/.test(raw) ? { v: raw } : bad;
    case "select":
      return typeof raw === "string" && (f.options ?? []).some((o) => o.value === raw) ? { v: raw } : bad;
    case "color":
      return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? { v: raw.toLowerCase() } : bad;
    case "text": {
      if (typeof raw !== "string") return bad;
      // 見えない字・まわりの空白を除く
      const v = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, "").trim();
      if (!v || [...v].length > (f.maxLen ?? 40)) return { error: `${f.label} は 1〜${f.maxLen ?? 40} 字です` };
      return { v };
    }
  }
}

/** 中身 1 つを確かめて、そろえた形を返す */
export function checkGiftItem(raw: unknown, caps: Readonly<GiftCaps> = NO_GIFT_CAPS): { ok: true; item: GiftItem } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "中身が読めません" };
  const r = raw as { kind?: unknown; p?: unknown };
  const def = giftKind(r.kind);
  if (!def) return { ok: false, error: "知らない中身の種類です" };
  const src = r.p && typeof r.p === "object" && !Array.isArray(r.p) ? (r.p as Record<string, unknown>) : {};
  const p: Record<string, string | number> = {};
  for (const f of def.fields) {
    const c = checkField(f, src[f.key]);
    if ("error" in c) return { ok: false, error: `${def.label}: ${c.error}` };
    p[f.key] = c.v;
  }
  const why = def.check?.(p, caps) ?? null;
  if (why) return { ok: false, error: `${def.label}: ${why}` };
  return { ok: true, item: { kind: def.id, p } };
}

/** 中身の全部を確かめる (1〜GIFT_ITEMS_MAX 個) */
export function checkGiftItems(raw: unknown, caps: Readonly<GiftCaps> = NO_GIFT_CAPS): { ok: true; items: GiftItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "中身を 1 つ以上入れてください" };
  if (raw.length > GIFT_ITEMS_MAX) return { ok: false, error: `中身は ${GIFT_ITEMS_MAX} 個までです` };
  const items: GiftItem[] = [];
  for (const x of raw) {
    const c = checkGiftItem(x, caps);
    if (!c.ok) return c;
    items.push(c.item);
  }
  return { ok: true, items };
}

/** 登録表の順 (当てる順) に並べる */
export function sortGiftItems(items: readonly GiftItem[]): GiftItem[] {
  const order = new Map(GIFT_KINDS.map((k, i) => [k.id, i]));
  return items.map((it, i) => ({ it, i })).sort((a, b) => (order.get(a.it.kind)! - order.get(b.it.kind)!) || a.i - b.i).map((x) => x.it);
}

export function describeGiftItem(item: GiftItem, names?: GiftNames): string {
  return giftKind(item.kind)?.describe(item.p, names) ?? item.kind;
}
