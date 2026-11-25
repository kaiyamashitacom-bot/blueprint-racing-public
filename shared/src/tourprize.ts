// 大会ごとの景品 (DECISIONS 11/25「大会ごとの景品」)。賞金 (AdminConfig の tournamentPrize) とは別の、その大会だけの景品。
// - 大会の格は 小・中・大。管理者が順位の幅ごとに中身 (ギフトコードと同じ登録表 GIFT_KINDS) を決める。決めなければ格のはじめの景品
// - 参加賞: 完走した (失格でない) チームみんなに 1 回
// - はじめの景品は「欲しい物」の名前 (限界設計図・限界突破のかけら・走行点) で登録表から探し、まだ登録されていなければお金にする。
//   探すのは渡すとき (と画面に出すとき) なので、あとから登録された物はそのまま使われる
// - 当てるのは server (season.ts が大会を決める取りまとめの中で gift.ts の GIFT_APPLY を使う)
// 数は全部 (仮)。
import { GIFT_ITEMS_MAX, GIFT_KINDS, NO_GIFT_CAPS, checkGiftItem, checkGiftItems, describeGiftItem, giftFieldOptions, type GiftCaps, type GiftItem, type GiftNames } from "./gift.ts";

export type TournamentGrade = "小" | "中" | "大";
export const TOURNAMENT_GRADES: readonly TournamentGrade[] = ["小", "中", "大"];
/** 格が書かれていない (前からある) 大会と、管理者の画面のはじめの格 */
export const DEFAULT_TOURNAMENT_GRADE: TournamentGrade = "中";
/** AdminConfig の数 (1〜3) ⇄ 格 */
export const gradeFromNumber = (n: number): TournamentGrade => TOURNAMENT_GRADES[Math.max(0, Math.min(2, Math.round(n) - 1))];
export function isTournamentGrade(v: unknown): v is TournamentGrade {
  return typeof v === "string" && (TOURNAMENT_GRADES as readonly string[]).includes(v);
}

/** 順位の幅 (from〜to 位、1 から) の景品 */
export interface PrizeTier {
  from: number;
  to: number;
  items: GiftItem[];
}

/** 決まった景品 (はじめの景品も、管理者の決めた景品も同じ形) */
export interface TournamentPrizes {
  tiers: PrizeTier[];
  /** 完走したチームみんなに 1 回 */
  participation: GiftItem[];
}

/** 順位の幅の数と、順位の上限 (仮) */
export const PRIZE_TIERS_MAX = 10;
export const PRIZE_POS_MAX = 999;

// ---------------------------------------------------------------- はじめの景品 (格ごと、仮)

/** 欲しい物: 登録表から名前 (want) で探す。見つからなければ次の候補へ。money は必ずある */
export type PrizeWant = { want: string; count: number } | { money: number };

export interface DefaultPrizeTier {
  from: number;
  to: number;
  /** 上から順に試す */
  alts: readonly PrizeWant[];
}

/**
 * 格ごとのはじめの景品 (仮)。
 * 大: 1 位 限界設計図 (無ければ 30,000)、2 位 限界突破のかけら ×5 (15,000)、3 位 かけら ×3 (10,000)。参加賞 走行点 50 (1,000)
 * 中: 1 位 かけら ×5 (15,000)、2〜3 位 かけら ×2 (5,000)。参加賞 走行点 30 (600)
 * 小: 1 位 8,000、2〜3 位 3,000 (お金だけ。部品は持てる数がいっぱいだと受け取れないので)。参加賞 走行点 20 (300)
 * かけらは 10 個で限界設計図 1 つなので、大の 2 位は半分、中の 1 位も半分。毎日の大会 (月〜土は中) で限界設計図そのものが出すぎないように
 */
export const DEFAULT_TOURNAMENT_PRIZES: Readonly<Record<TournamentGrade, { tiers: readonly DefaultPrizeTier[]; participation: readonly PrizeWant[] }>> = {
  大: {
    tiers: [
      { from: 1, to: 1, alts: [{ want: "限界設計図", count: 1 }, { money: 30_000 }] },
      { from: 2, to: 2, alts: [{ want: "限界突破のかけら", count: 5 }, { money: 15_000 }] },
      { from: 3, to: 3, alts: [{ want: "限界突破のかけら", count: 3 }, { money: 10_000 }] },
    ],
    participation: [{ want: "走行点", count: 50 }, { money: 1_000 }],
  },
  中: {
    tiers: [
      { from: 1, to: 1, alts: [{ want: "限界突破のかけら", count: 5 }, { money: 15_000 }] },
      { from: 2, to: 3, alts: [{ want: "限界突破のかけら", count: 2 }, { money: 5_000 }] },
    ],
    participation: [{ want: "走行点", count: 30 }, { money: 600 }],
  },
  小: {
    tiers: [
      { from: 1, to: 1, alts: [{ money: 8_000 }] },
      { from: 2, to: 3, alts: [{ money: 3_000 }] },
    ],
    participation: [{ want: "走行点", count: 20 }, { money: 300 }],
  },
};

/**
 * 名前 (例「限界設計図」) の物を登録表から探して、count 個の中身にする。見つからない・形が作れなければ null。
 * 種類の名前に含むものか、select の候補の名前に含むもの (「かけら」の種類の中の 1 つ など)。
 * 数は最初の整数の項目に入れる (幅に収める)。整数の項目が無ければ同じ中身を count 個並べる
 */
export function giftItemsByName(name: string, count: number, caps: Readonly<GiftCaps> = NO_GIFT_CAPS): GiftItem[] | null {
  const cands: Array<{ kindIdx: number; selKey?: string; selVal?: string }> = [];
  GIFT_KINDS.forEach((k, i) => {
    if (k.label.includes(name)) cands.push({ kindIdx: i });
  });
  GIFT_KINDS.forEach((k, i) => {
    for (const f of k.fields) {
      if (f.type !== "select") continue;
      const o = giftFieldOptions(f).find((x) => x.label.includes(name));
      if (o) cands.push({ kindIdx: i, selKey: f.key, selVal: o.value });
    }
  });
  for (const c of cands) {
    const k = GIFT_KINDS[c.kindIdx];
    const p: GiftItem["p"] = {};
    let qty = false;
    let ok = true;
    for (const f of k.fields) {
      if (c.selKey === f.key) p[f.key] = c.selVal!;
      else if (f.type === "int" && !qty) {
        p[f.key] = Math.max(f.min ?? 1, Math.min(f.max ?? count, count));
        qty = true;
      } else if (f.def !== undefined) p[f.key] = f.def;
      else if (f.optional) p[f.key] = "";
      else if (f.type === "select" && giftFieldOptions(f).length) p[f.key] = giftFieldOptions(f)[0].value;
      else ok = false;
    }
    if (!ok) continue;
    const chk = checkGiftItem({ kind: k.id, p }, caps);
    if (!chk.ok) continue;
    return qty ? [chk.item] : Array.from({ length: Math.max(1, Math.min(GIFT_ITEMS_MAX, count)) }, () => chk.item);
  }
  return null;
}

function resolveWants(alts: readonly PrizeWant[]): GiftItem[] {
  for (const a of alts) {
    if ("money" in a) return [{ kind: "money", p: { amount: a.money } }];
    const items = giftItemsByName(a.want, a.count);
    if (items) return items;
  }
  return [];
}

/** 格のはじめの景品 (今の登録表で) */
export function defaultTournamentPrizes(grade: TournamentGrade): TournamentPrizes {
  const d = DEFAULT_TOURNAMENT_PRIZES[grade];
  return {
    tiers: d.tiers.map((t) => ({ from: t.from, to: t.to, items: resolveWants(t.alts) })).filter((t) => t.items.length > 0),
    participation: resolveWants(d.participation),
  };
}

/** 大会の景品の書き方 (TournamentSpec の一部) */
export interface TournamentPrizeSpec {
  grade?: TournamentGrade;
  /** 順位ごと。なし = 格のはじめの景品 */
  prizes?: PrizeTier[];
  /** 参加賞。なし = 格のはじめの参加賞、[] = なし */
  participation?: GiftItem[];
}

/** その大会で実際に渡す景品 */
export function tournamentPrizesOf(spec: TournamentPrizeSpec): TournamentPrizes & { grade: TournamentGrade; custom: { tiers: boolean; participation: boolean } } {
  const grade = isTournamentGrade(spec.grade) ? spec.grade : DEFAULT_TOURNAMENT_GRADE;
  const def = spec.prizes === undefined || spec.participation === undefined ? defaultTournamentPrizes(grade) : null;
  return {
    grade,
    tiers: spec.prizes ?? def!.tiers,
    participation: spec.participation ?? def!.participation,
    custom: { tiers: spec.prizes !== undefined, participation: spec.participation !== undefined },
  };
}

/** 順位 pos (1 から) の景品 (幅は重ならないので 0 か 1 つ) */
export function prizeItemsForPos(tiers: readonly PrizeTier[], pos: number): GiftItem[] {
  return tiers.find((t) => pos >= t.from && pos <= t.to)?.items ?? [];
}

/**
 * 管理者が送ってきた景品を確かめる。undefined / null = はじめの景品 (その項目は書かない)。
 * 順位の幅は 1〜PRIZE_POS_MAX の整数で重ならない。中身は登録表で確かめる (ギフトコードと同じ上限)
 */
export function checkTournamentPrizes(
  rawTiers: unknown,
  rawParticipation: unknown,
  caps: Readonly<GiftCaps> = NO_GIFT_CAPS,
): { ok: true; prizes: PrizeTier[] | undefined; participation: GiftItem[] | undefined } | { ok: false; error: string } {
  let prizes: PrizeTier[] | undefined;
  if (rawTiers !== undefined && rawTiers !== null) {
    if (!Array.isArray(rawTiers) || rawTiers.length > PRIZE_TIERS_MAX) return { ok: false, error: `順位の景品は ${PRIZE_TIERS_MAX} 段までです` };
    prizes = [];
    for (const t of rawTiers) {
      const r = (t && typeof t === "object" ? t : {}) as { from?: unknown; to?: unknown; items?: unknown };
      const from = Number(r.from);
      const to = Number(r.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > PRIZE_POS_MAX) return { ok: false, error: `順位の幅がおかしいです (1〜${PRIZE_POS_MAX} 位、はじめ ≦ おわり)` };
      const c = checkGiftItems(r.items, caps);
      if (!c.ok) return { ok: false, error: `${from === to ? `${from} 位` : `${from}〜${to} 位`}: ${c.error}` };
      prizes.push({ from, to, items: c.items });
    }
    prizes.sort((a, b) => a.from - b.from);
    for (let i = 1; i < prizes.length; i++) if (prizes[i].from <= prizes[i - 1].to) return { ok: false, error: "順位の幅が重なっています" };
  }
  let participation: GiftItem[] | undefined;
  if (rawParticipation !== undefined && rawParticipation !== null) {
    if (Array.isArray(rawParticipation) && rawParticipation.length === 0) participation = [];
    else {
      const c = checkGiftItems(rawParticipation, caps);
      if (!c.ok) return { ok: false, error: `参加賞: ${c.error}` };
      participation = c.items;
    }
  }
  return { ok: true, prizes, participation };
}

// ---------------------------------------------------------------- 誰が何をもらうか

export interface PrizeCar {
  driverId: string;
  teamId: string | null;
  finalPos: number;
  finished: boolean;
  dq: boolean;
  standIn?: boolean;
}

export interface TeamPrizeAward {
  teamId: string;
  /** 車ごと (順位の景品。2 台とも幅に入ればそれぞれ) */
  cars: Array<{ driverId: string; finalPos: number; items: GiftItem[] }>;
  /** 参加賞 (チームに 1 回) */
  participation: GiftItem[];
}

/**
 * 大会の結果から、チームごとにもらう物を決める (当てるのは server)。
 * - 完走して失格でない車だけ (失格・完走できずは何もない。賞金と同じ)
 * - 代走でももらう (仮): 代走はチームの車が走った結果で、チームの点にも賞金にも入っている。人が来られなかっただけで景品を外すと、
 *   全員参加の毎日の大会で来られない人がいつも損をするので
 * - 空きを埋めたコンピューター (teamId なし) は何もない
 */
export function tournamentPrizeAwards(cars: readonly PrizeCar[], prizes: TournamentPrizes): TeamPrizeAward[] {
  const by = new Map<string, TeamPrizeAward>();
  for (const c of [...cars].sort((a, b) => a.finalPos - b.finalPos)) {
    if (!c.teamId || c.dq || !c.finished) continue;
    let a = by.get(c.teamId);
    if (!a) {
      a = { teamId: c.teamId, cars: [], participation: prizes.participation.map((x) => ({ kind: x.kind, p: { ...x.p } })) };
      by.set(c.teamId, a);
    }
    const items = prizeItemsForPos(prizes.tiers, c.finalPos);
    if (items.length) a.cars.push({ driverId: c.driverId, finalPos: c.finalPos, items: items.map((x) => ({ kind: x.kind, p: { ...x.p } })) });
  }
  return [...by.values()].filter((a) => a.cars.length > 0 || a.participation.length > 0);
}

/** 画面に出す形 (言い表し) */
export interface PrizeSummary {
  grade: TournamentGrade;
  tiers: Array<{ from: number; to: number; lines: string[] }>;
  participation: string[];
  custom: boolean;
}

export function prizeSummary(spec: TournamentPrizeSpec, names?: GiftNames): PrizeSummary {
  const p = tournamentPrizesOf(spec);
  return {
    grade: p.grade,
    tiers: p.tiers.map((t) => ({ from: t.from, to: t.to, lines: t.items.map((it) => describeGiftItem(it, names)) })),
    participation: p.participation.map((it) => describeGiftItem(it, names)),
    custom: p.custom.tiers || p.custom.participation,
  };
}
