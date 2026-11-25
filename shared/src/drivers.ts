// 雇うコンピューターの運転手 (2 台目)。候補は全チーム共通で、早い者勝ちで契約する。
// 契約金は季節ごと: 雇うときに今の季節の残りの分、季節の切れ目に次の季節の分を払う。
// 季節の途中で手放すと 違約金 (今の季節の契約金の残り) を払う。
// レースに出るほど育つ (育ちきる上限 = 伸びしろ は運転手ごと)。年齢と引退はない。
// 名前: はじめの 40 人 (d0..) と足していく人は作りもの。名簿の運転手 (drivercatalog.ts、c01.. と珍しい rare1..) は
// 実在の運転手を思わせる似た名前 (11/25 ユーザー「似た名前にしよう」)。
// 得意 (SPECIALTIES): 0〜2 つ。雨・予選・タイヤ・抜き・守り・縁石・スタート・燃費。運転 (bot.ts) と車 (physics.ts) に効く。
// 珍しい運転手 (rare) は ふつうの候補に出ない。季節のごほうび (offerRareDriver) とギフトコードでだけ契約できる。
import { FRESH_WEAR, makeBrain, type BotBrain } from "./bot.ts";
import { DRIVER_CATALOG, type CatalogDriver } from "./drivercatalog.ts";
import { fail, pick, seasonRemaining, seededRand, type EconEvent, type Result } from "./econ.ts";
import type { SeasonWindow } from "./season.ts";

/** 運転手の仮の数 */
export const DRIVERS = {
  /** はじめの候補の数 */
  poolSize: 40,
  /** 空いている候補がこれより減ったら足す */
  minFree: 8,
  /** 能力の幅 (0..100) */
  statMin: 15,
  statMax: 80,
  /** 伸びしろ (今の能力 + この幅、100 まで) */
  potentialMin: 8,
  potentialMax: 35,
  /** 1 レースで 伸びしろとの差のこの割合だけ育つ */
  growthPerRace: 0.03,
  /** 総合の重み */
  overallWeights: { speed: 0.4, stability: 0.25, tyreFuel: 0.2, pitSense: 0.15 },
  /** 契約金 (1 季節) = feeBase × (総合 / 50)²、feeRound で丸める */
  feeBase: 1500,
  feeRound: 50,
  /** 季節の途中で雇うとき、最低でも契約金のこの割合は払う */
  minSignRatio: 0.2,
  /** 運転手の能力 → コンピューターの運転 (bot.ts の skill 0.7..0.95) */
  skillMin: 0.7,
  skillMax: 0.95,
  /** ドライバーズチャンピオン (級か総合) になった雇った運転手の、伸びしろ (育ちきる上限) に足す数 (能力ごと、100 まで) */
  championBonus: 5,
  /** 作りものの運転手の得意の数: 乱数がこれより下なら 0 つ / 1 つ、上なら 2 つ */
  specOdds: [0.45, 0.85],
  /** 季節のごほうびの珍しい運転手と ただで契約できる季節の数 (締めた次の季節の終わりまで = 1) */
  prizeSeasons: 1,
} as const;

// ---------------------------------------------------------------- 得意

export type SpecialtyId = "rain" | "quali" | "tyre" | "pass" | "defend" | "kerb" | "start" | "fuel";

export interface SpecialtyDef {
  id: SpecialtyId;
  /** 札の名前 */
  name: string;
  /** 短い説明 (画面) */
  note: string;
  /** 契約金に足す割合 */
  fee: number;
}

export const SPECIALTIES: Readonly<Record<SpecialtyId, SpecialtyDef>> = {
  rain: { id: "rain", name: "雨に強い", note: "濡れた路面で速く、ミスも少ない", fee: 0.1 },
  quali: { id: "quali", name: "予選が速い", note: "新しいタイヤの周が速い (予選・1 周アタック向き)", fee: 0.1 },
  tyre: { id: "tyre", name: "タイヤを持たせる", note: "タイヤのすり減りが少ない", fee: 0.1 },
  pass: { id: "pass", name: "追い抜きがうまい", note: "早めに仕掛け、並んでも速さを落とさない", fee: 0.1 },
  defend: { id: "defend", name: "守りが固い", note: "後ろから来る車の線をふさぐ", fee: 0.08 },
  kerb: { id: "kerb", name: "縁石がうまい", note: "縁石で握りが落ちにくく、タイヤも減りにくい", fee: 0.06 },
  start: { id: "start", name: "スタートがうまい", note: "信号への反応が速い", fee: 0.06 },
  fuel: { id: "fuel", name: "燃費がよい", note: "燃料の減りが少ない", fee: 0.08 },
};

export const SPECIALTY_IDS = Object.keys(SPECIALTIES) as SpecialtyId[];

export function isSpecialty(v: unknown): v is SpecialtyId {
  return typeof v === "string" && v in SPECIALTIES;
}

/** 得意の効き目 (仮) */
export const SPECIALTY_FX = {
  /** 雨: 濡れ具合 1 で skill に足す数 (濡れ具合に比例) */
  rainWetSkill: 0.04,
  /** 予選: 新しいタイヤ (すり減り freshWear まで) の間 skill に足す数。予選・1 周アタックの走り (driverBrain の quali) はいつも */
  qualiFreshSkill: 0.025,
  freshWear: FRESH_WEAR,
  /** タイヤ: すり減りの倍率 */
  tyreWear: 0.88,
  /** 抜き: 前の車を見る長さと、並んだときの握りの控え (0.94 → 1 - 0.06 / この数) */
  passAggression: 1.35,
  /** 守り: 後ろの車の側へ寄せる強さ (0..1) */
  defend: 1,
  /** 縁石: 縁石での握りの落ちと、余分なすり減りの倍率 */
  kerbScale: 0.5,
  /** スタート: 信号への反応の倍率 */
  startReaction: 0.55,
  /** 燃費: 燃料の使い方の倍率 */
  fuelScale: 0.9,
} as const;

export interface SpecialtyEffects {
  wetSkill: number;
  freshSkill: number;
  passAggression: number;
  defend: number;
  kerbScale: number;
  reactionScale: number;
  wearScale: number;
  fuelScale: number;
}

/** 得意の効き目をまとめる (なし = 全部 今のまま) */
export function specialtyEffects(specs?: readonly SpecialtyId[] | null): SpecialtyEffects {
  const has = (s: SpecialtyId) => !!specs?.includes(s);
  const F = SPECIALTY_FX;
  return {
    wetSkill: has("rain") ? F.rainWetSkill : 0,
    freshSkill: has("quali") ? F.qualiFreshSkill : 0,
    passAggression: has("pass") ? F.passAggression : 1,
    defend: has("defend") ? F.defend : 0,
    kerbScale: has("kerb") ? F.kerbScale : 1,
    reactionScale: has("start") ? F.startReaction : 1,
    wearScale: has("tyre") ? F.tyreWear : 1,
    fuelScale: has("fuel") ? F.fuelScale : 1,
  };
}

/**
 * 頭 (bot.ts) に得意を入れる。得意がなければ そのまま返す。
 * quali = 予選・1 周アタックの走り: 予選が速い人は 新しいタイヤの分をいつも足す
 */
export function applySpecialties(b: BotBrain, specs?: readonly SpecialtyId[] | null, opts: { quali?: boolean } = {}): BotBrain {
  if (!specs?.length) return b;
  const fx = specialtyEffects(specs);
  const out: BotBrain = {
    ...b,
    reaction: fx.reactionScale === 1 ? b.reaction : Math.max(0.1, b.reaction * fx.reactionScale),
    wetSkill: fx.wetSkill,
    freshSkill: fx.freshSkill,
    passAggression: fx.passAggression,
    defend: fx.defend,
  };
  if (opts.quali && fx.freshSkill > 0) {
    out.skill = Math.min(1, out.skill + fx.freshSkill);
    out.freshSkill = 0;
  }
  return out;
}

export interface DriverStats {
  /** 速さ */
  speed: number;
  /** 安定 (壁に当たらない、むらが少ない) */
  stability: number;
  /** タイヤと燃料の扱い */
  tyreFuel: number;
  /** ピットの判断の上手さ */
  pitSense: number;
}

export type StatKey = keyof DriverStats;
export const STAT_KEYS: readonly StatKey[] = ["speed", "stability", "tyreFuel", "pitSense"];

export interface DriverContract {
  teamId: string;
  /** 今の季節の契約金 (1 季節分) */
  fee: number;
  /** 契約した季節の番号と、今払ってある季節 */
  since: number;
  paidSeason: number;
  /** 季節の切れ目に続けるか */
  renew: boolean;
}

export interface Driver {
  id: string;
  name: string;
  /** 今の能力 (小数。表示は丸める) */
  stats: DriverStats;
  /** 育ちきる上限 */
  potential: DriverStats;
  races: number;
  contract: DriverContract | null;
  /** 得意 (0〜2 つ)。前に保存した候補には無い (upgradeDriverPool で入る) */
  specs?: SpecialtyId[];
  /** 国の札・年代 (名簿の運転手だけ) */
  nat?: string;
  era?: number;
  /** 珍しい運転手 (ふつうの候補に出ない) */
  rare?: boolean;
  /** 季節のごほうび: このチームが ただで契約できる (季節の番号 until まで) */
  offer?: { teamId: string; until: number };
}

export interface DriverPool {
  seed: number;
  /** 次に作る運転手の番号 */
  next: number;
  drivers: Driver[];
  /** 名簿 (DRIVER_CATALOG) のうち 入れた数 (足した分だけ upgradeDriverPool が入れる) */
  cat?: number;
}

// 名前: 作りものの名字 (字 + 字) と、カタカナの名
const FAMILY_A = ["霞", "汐", "柊", "朔", "灯", "砥", "鷺", "椋", "楓", "篝", "雫", "穂", "槙", "葛", "鴫", "蒼"];
const FAMILY_B = ["谷", "浦", "坂", "沢", "瀬", "堂", "森", "崎", "野", "原", "江", "辻"];
const GIVEN_A = ["ナ", "ユ", "ラ", "ソ", "ハ", "ミ", "リ", "セ", "ア", "ト", "キ", "ヨ", "ル", "サ"];
const GIVEN_B = ["ギ", "ズ", "ノ", "ル", "ト", "ヤ", "マ", "オ", "セ", "ク", "ジ", "ラ"];
const GIVEN_C = ["", "", "", "ン", "イ", "ト", "ネ", "ロ"];

function makeName(rand: () => number): string {
  return `${pick(rand, FAMILY_A)}${pick(rand, FAMILY_B)} ${pick(rand, GIVEN_A)}${pick(rand, GIVEN_B)}${pick(rand, GIVEN_C)}`;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** 番号 i の運転手 (種と番号だけで決まる) */
export function makeDriver(seed: number, i: number, taken: ReadonlySet<string> = new Set()): Driver {
  const r = seededRand(seed, 1000 + i);
  let name = makeName(r);
  for (let k = 0; taken.has(name) && k < 20; k++) name = makeName(r);
  if (taken.has(name)) name = `${name}${i}`;
  const q = r();
  const stat = () => Math.round(clamp(DRIVERS.statMin + (DRIVERS.statMax - DRIVERS.statMin) * (0.6 * q + 0.4 * r()), DRIVERS.statMin, DRIVERS.statMax));
  const stats: DriverStats = { speed: stat(), stability: stat(), tyreFuel: stat(), pitSense: stat() };
  const pot = (v: number) => Math.min(100, v + Math.round(DRIVERS.potentialMin + (DRIVERS.potentialMax - DRIVERS.potentialMin) * r()));
  const potential: DriverStats = { speed: pot(stats.speed), stability: pot(stats.stability), tyreFuel: pot(stats.tyreFuel), pitSense: pot(stats.pitSense) };
  return { id: `d${i}`, name, stats, potential, races: 0, contract: null, specs: rollSpecs(seed, i) };
}

/** 作りものの運転手 i の得意 (名前と能力とは別の乱数。前からいる人の名前と能力は変わらない) */
export function rollSpecs(seed: number, i: number): SpecialtyId[] {
  const r = seededRand(seed, 90_000 + i);
  const x = r();
  const n = x < DRIVERS.specOdds[0] ? 0 : x < DRIVERS.specOdds[1] ? 1 : 2;
  const out: SpecialtyId[] = [];
  while (out.length < n) {
    const s = pick(r, SPECIALTY_IDS);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** 名簿の運転手 1 人 */
export function catalogDriver(e: CatalogDriver): Driver {
  const [speed, stability, tyreFuel, pitSense] = e.s;
  const stats: DriverStats = { speed, stability, tyreFuel, pitSense };
  const potential = { ...stats };
  for (const k of STAT_KEYS) potential[k] = Math.min(100, stats[k] + e.g);
  return { id: e.id, name: e.name, stats, potential, races: 0, contract: null, specs: [...e.specs], nat: e.nat, era: e.era, ...(e.rare ? { rare: true } : {}) };
}

export function catalogEntry(id: string): CatalogDriver | undefined {
  return DRIVER_CATALOG.find((e) => e.id === id);
}

/** 珍しい運転手の id (名簿の順) */
export const RARE_DRIVER_IDS: readonly string[] = DRIVER_CATALOG.filter((e) => e.rare).map((e) => e.id);

/** はじめの候補をつくる (作りもの size 人 + 名簿のふつうの運転手。catalog = false なら作りものだけ) */
export function createDriverPool(seed: number, size: number = DRIVERS.poolSize, catalog = true): DriverPool {
  const p = addDrivers({ seed, next: 0, drivers: [] }, size);
  return catalog ? upgradeDriverPool(p) : p;
}

/**
 * 保存してある候補を今の形にする (足すだけ。前からいる人の id・名前・能力は変えない):
 * 得意の無い作りものの運転手に得意を入れ、名簿の新しいふつうの運転手を末尾に足す。変わらなければ同じものを返す
 */
export function upgradeDriverPool(pool: DriverPool): DriverPool {
  const done = pool.cat ?? 0;
  if (done >= DRIVER_CATALOG.length) return pool;
  const have = new Set(pool.drivers.map((d) => d.id));
  const drivers = pool.drivers.map((d) => {
    if (d.specs) return d;
    const m = /^d(\d+)$/.exec(d.id);
    return { ...d, specs: m ? rollSpecs(pool.seed, Number(m[1])) : [] };
  });
  for (const e of DRIVER_CATALOG.slice(done)) if (!e.rare && !have.has(e.id)) drivers.push(catalogDriver(e));
  return { ...pool, drivers, cat: DRIVER_CATALOG.length };
}

/** 名簿の運転手 (珍しい人も) が候補にいなければ足す (ギフトコード・ごほうび用)。名簿に無い id なら そのまま */
export function withCatalogDriver(pool: DriverPool, id: string): DriverPool {
  if (findDriver(pool, id)) return pool;
  const e = catalogEntry(id);
  return e ? { ...pool, drivers: [...pool.drivers, catalogDriver(e)] } : pool;
}

/** 季節のごほうびで このチームが今 ただで契約できる珍しい運転手 */
export function prizeOffers(pool: DriverPool, teamId: string, season: number): Driver[] {
  return pool.drivers.filter((d) => d.rare && !d.contract && d.offer?.teamId === teamId && d.offer.until >= season);
}

/**
 * 季節のごほうび: 珍しい運転手を 1 人、このチームが ただで契約できるようにする (季節の番号 until まで)。
 * 選ぶのは季節で回る順に、契約していない・ほかのチームへのごほうびになっていない人。いなければ null
 */
export function offerRareDriver(pool: DriverPool, teamId: string, season: number, until: number): { pool: DriverPool; driverId: string } | null {
  const ids = RARE_DRIVER_IDS;
  for (let k = 0; k < ids.length; k++) {
    const id = ids[(((season + k) % ids.length) + ids.length) % ids.length];
    const d = findDriver(pool, id);
    if (d && (d.contract || (d.offer && d.offer.until >= season && d.offer.teamId !== teamId))) continue;
    const next = withCatalogDriver(pool, id);
    return { pool: { ...next, drivers: next.drivers.map((x) => (x.id === id ? { ...x, offer: { teamId, until } } : x)) }, driverId: id };
  }
  return null;
}

/** 部屋の名前の長さ (12 字) に入らない名前は 名字だけに */
export function driverShortName(name: string, max = 12): string {
  if ([...name].length <= max) return name;
  const last = name.split("・").pop() ?? name;
  return [...last].slice(0, max).join("");
}

function addDrivers(pool: DriverPool, n: number): DriverPool {
  const names = new Set(pool.drivers.map((d) => d.name));
  const drivers = [...pool.drivers];
  let next = pool.next;
  for (let k = 0; k < n; k++) {
    const d = makeDriver(pool.seed, next++, names);
    names.add(d.name);
    drivers.push(d);
  }
  return { ...pool, next, drivers };
}

/** 誰でも雇える空いている候補 (珍しい運転手は入らない) */
export function freeDrivers(pool: DriverPool): Driver[] {
  return pool.drivers.filter((d) => !d.contract && !d.rare);
}

/** 空いている候補が minFree より少なければ足す (チームが増えても選べるように) */
export function ensureFreeDrivers(pool: DriverPool, minFree: number = DRIVERS.minFree): DriverPool {
  const free = freeDrivers(pool).length;
  return free >= minFree ? pool : addDrivers(pool, minFree - free);
}

export function findDriver(pool: DriverPool, id: string): Driver | undefined {
  return pool.drivers.find((d) => d.id === id);
}

export function teamDriver(pool: DriverPool, teamId: string): Driver | undefined {
  return pool.drivers.find((d) => d.contract?.teamId === teamId);
}

/** 総合 (0..100) */
export function driverOverall(s: DriverStats): number {
  const w = DRIVERS.overallWeights;
  return s.speed * w.speed + s.stability * w.stability + s.tyreFuel * w.tyreFuel + s.pitSense * w.pitSense;
}

/** 得意の分の契約金の倍率 (1 + 得意ごとの割合の和) */
export function specFeeFactor(specs?: readonly SpecialtyId[] | null): number {
  let f = 1;
  for (const s of specs ?? []) f += SPECIALTIES[s]?.fee ?? 0;
  return f;
}

/** 1 季節の契約金 = feeBase × (総合 / 50)² × (1 + 得意の割合)。今の能力で決まる (育つと次の季節から上がる) */
export function driverFee(d: Driver): number {
  const o = driverOverall(d.stats);
  return Math.max(DRIVERS.feeRound, Math.round((DRIVERS.feeBase * (o / 50) ** 2 * specFeeFactor(d.specs)) / DRIVERS.feeRound) * DRIVERS.feeRound);
}

/** 今雇うと払うお金 (季節の残りの分)。季節のごほうびの珍しい運転手は ただ */
export function signingCost(d: Driver, clock: SeasonWindow, now: number): number {
  if (d.rare && d.offer) return 0;
  return Math.ceil(driverFee(d) * Math.max(DRIVERS.minSignRatio, seasonRemaining(clock, now)));
}

/** 今手放すと払う違約金 (今の季節の契約金の残り) */
export function releasePenalty(d: Driver, clock: SeasonWindow, now: number): number {
  if (!d.contract) return 0;
  return Math.ceil(d.contract.fee * seasonRemaining(clock, now));
}

function replaceDriver(pool: DriverPool, d: Driver): DriverPool {
  return { ...pool, drivers: pool.drivers.map((x) => (x.id === d.id ? d : x)) };
}

/** 契約金の割引 (ギフトコード) で引く額。pct は 0..100 (切り捨て) */
export function feeDiscount(amount: number, pct: number): number {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return Math.floor((Math.max(0, amount) * p) / 100);
}

/**
 * 運転手を雇う。funds はチームの財布。今の運転手がいれば違約金を払って入れ替える (合わせたお金が要る)。
 * 返る cost を財布から引く。discountPct (ギフトコードの割引) は雇うときの契約金だけに効く (違約金には効かない)。discount = 引いた額
 */
export function hireDriver(
  pool: DriverPool,
  teamId: string,
  driverId: string,
  funds: number,
  clock: SeasonWindow,
  now: number,
  discountPct = 0,
): Result<{ pool: DriverPool; cost: number; penalty: number; releasedId: string | null; discount: number }> {
  const d = findDriver(pool, driverId);
  if (!d) return fail("not_found");
  if (d.contract) return fail(d.contract.teamId === teamId ? "already" : "taken");
  // 珍しい運転手は ごほうびをもらったチームだけ (ギフトコードはサーバーが直に契約する)
  if (d.rare && !(d.offer?.teamId === teamId && d.offer.until >= clock.index)) return fail("not_found");
  const cur = teamDriver(pool, teamId);
  const penalty = cur ? releasePenalty(cur, clock, now) : 0;
  const full = signingCost(d, clock, now);
  const discount = feeDiscount(full, discountPct);
  const sign = full - discount;
  if (funds < sign + penalty) return fail("no_money");
  let next = pool;
  if (cur) next = replaceDriver(next, { ...cur, contract: null });
  const { offer: _offer, ...rest } = d;
  next = replaceDriver(next, { ...rest, contract: { teamId, fee: driverFee(d), since: clock.index, paidSeason: clock.index, renew: true } });
  return { ok: true, pool: next, cost: sign + penalty, penalty, releasedId: cur?.id ?? null, discount };
}

/** 季節の途中で手放す (違約金を払う)。返る cost を財布から引く */
export function releaseDriver(pool: DriverPool, teamId: string, funds: number, clock: SeasonWindow, now: number): Result<{ pool: DriverPool; cost: number; driverId: string }> {
  const cur = teamDriver(pool, teamId);
  if (!cur) return fail("not_found");
  const cost = releasePenalty(cur, clock, now);
  if (funds < cost) return fail("no_money");
  return { ok: true, pool: replaceDriver(pool, { ...cur, contract: null }), cost, driverId: cur.id };
}

/** 季節の切れ目に続けるかを決める (続けないなら切れ目で違約金なしに離れる) */
export function setRenew(pool: DriverPool, teamId: string, renew: boolean): Result<{ pool: DriverPool }> {
  const cur = teamDriver(pool, teamId);
  if (!cur || !cur.contract) return fail("not_found");
  return { ok: true, pool: replaceDriver(pool, { ...cur, contract: { ...cur.contract, renew } }) };
}

/**
 * 季節の切れ目: 続ける契約は次の季節の契約金 (育った今の能力で計算) を払う。払えないか続けないなら離れる。
 * wallets はチームの id → 財布。返る charges を財布から引く。
 * discounts はチームの id → 割引 % (ギフトコード)。払う額だけ下がる (契約金そのものは変えない)。charges.discount = 引いた額 (割引があったときだけ)
 */
export function renewContracts(
  pool: DriverPool,
  wallets: Readonly<Record<string, number>>,
  newSeason: number,
  discounts: Readonly<Record<string, number>> = {},
): { pool: DriverPool; charges: Array<{ teamId: string; amount: number; driverId: string; discount?: number }>; events: EconEvent[] } {
  const charges: Array<{ teamId: string; amount: number; driverId: string; discount?: number }> = [];
  const events: EconEvent[] = [];
  const drivers = pool.drivers.map((d) => {
    const c = d.contract;
    if (!c || c.paidSeason >= newSeason) return d;
    const fee = driverFee(d);
    if (!c.renew) {
      events.push({ type: "contract_ended", teamId: c.teamId, driverId: d.id, why: "not_renewed", season: newSeason });
      return { ...d, contract: null };
    }
    const discount = feeDiscount(fee, discounts[c.teamId] ?? 0);
    if ((wallets[c.teamId] ?? 0) < fee - discount) {
      events.push({ type: "contract_ended", teamId: c.teamId, driverId: d.id, why: "no_money", season: newSeason });
      return { ...d, contract: null };
    }
    charges.push(discount > 0 ? { teamId: c.teamId, amount: fee - discount, driverId: d.id, discount } : { teamId: c.teamId, amount: fee, driverId: d.id });
    events.push({ type: "contract_renewed", teamId: c.teamId, driverId: d.id, fee: fee - discount, season: newSeason });
    return { ...d, contract: { ...c, fee, paidSeason: newSeason } };
  });
  return { pool: { ...pool, drivers }, charges, events };
}

/** 1 レースの運転手の結果 (育ち方に使う) */
export interface DriverRaceResult {
  /** 着順 (1 から) と台数 */
  position: number;
  cars: number;
  finished: boolean;
  /** 壁に強く当たった回数 */
  wallHits: number;
  /** 走った周の数・ピットの回数 */
  laps: number;
  pitStops: number;
}

/** 能力ごとの育ち方の倍率 (どう走ったかで変わる) */
export function growthFactors(r: DriverRaceResult): DriverStats {
  const place = r.cars > 1 ? 1 - (r.position - 1) / (r.cars - 1) : 1;
  return {
    speed: r.finished ? 0.7 + 0.6 * place : 0.5,
    stability: !r.finished ? 0.3 : r.wallHits === 0 ? 1.4 : Math.max(0.4, 1 - 0.2 * r.wallHits),
    tyreFuel: 0.5 + Math.min(1, r.laps / 5),
    pitSense: r.pitStops > 0 ? 1.3 : 0.5,
  };
}

/** レースに出た運転手を育てる */
export function growDriver(d: Driver, r: DriverRaceResult): Driver {
  const f = growthFactors(r);
  const stats = { ...d.stats };
  for (const k of STAT_KEYS) {
    const gap = Math.max(0, d.potential[k] - stats[k]);
    stats[k] = Math.min(d.potential[k], stats[k] + gap * DRIVERS.growthPerRace * f[k]);
  }
  return { ...d, stats, races: d.races + 1 };
}

export function recordDriverRace(pool: DriverPool, driverId: string, r: DriverRaceResult): DriverPool {
  const d = findDriver(pool, driverId);
  return d ? replaceDriver(pool, growDriver(d, r)) : pool;
}

/** チャンピオンのごほうび: 伸びしろを能力ごとに amount 上げる (100 まで)。今の能力は変わらず、このあとのレースで育つ */
export function championBoost(d: Driver, amount: number = DRIVERS.championBonus): Driver {
  const potential = { ...d.potential };
  for (const k of STAT_KEYS) potential[k] = Math.min(100, potential[k] + amount);
  return { ...d, potential };
}

/** 季節の締め: チャンピオンになった雇った運転手 (候補にいる人だけ。重なりは 1 回) の伸びしろを上げる */
export function awardChampionBonus(pool: DriverPool, driverIds: readonly string[], amount: number = DRIVERS.championBonus): DriverPool {
  let next = pool;
  for (const id of new Set(driverIds)) {
    const d = findDriver(next, id);
    if (d) next = replaceDriver(next, championBoost(d, amount));
  }
  return next;
}

/** 運転手の能力から、走りに効く数。skill・mistakeScale は driverBrain が bot に、wearScale・fuelScale は driverCarScales が車に入れる。pitSense は driverBrain が bot のピットの判断 (updateBotPit) に入れる */
export interface DriverTraits {
  /** bot.ts の BotBrain.skill (0.7..0.95) */
  skill: number;
  /** ふらつき・ミスの倍率 (安定が高いほど小さい。1 が今の bot のまま) */
  mistakeScale: number;
  /** タイヤのすり減り・燃料の使い方の倍率 (扱いが上手いほど小さい) */
  wearScale: number;
  fuelScale: number;
  /** ピットの判断 (0..1)。天気の変わり目に入る早さ・予報の読みに使う想定 */
  pitSense: number;
}

export function driverTraits(s: DriverStats): DriverTraits {
  const u = (x: number) => clamp(x / 100, 0, 1);
  const pace = 0.75 * u(s.speed) + 0.25 * u(s.stability);
  return {
    skill: DRIVERS.skillMin + (DRIVERS.skillMax - DRIVERS.skillMin) * pace,
    mistakeScale: 1.4 - 0.8 * u(s.stability),
    wearScale: 1.12 - 0.27 * u(s.tyreFuel),
    fuelScale: 1.06 - 0.14 * u(s.tyreFuel),
    pitSense: u(s.pitSense),
  };
}

/**
 * 雇った運転手の頭 (bot.ts の makeBrain をそのまま使い、skill を能力から決める)。
 * スタートの反応は安定が高いほど速い。得意 (specs) は applySpecialties で入れる (quali = 予選・1 周アタックの走り)
 */
export function driverBrain(s: DriverStats, rand: () => number, specs?: readonly SpecialtyId[] | null, opts: { quali?: boolean } = {}): BotBrain {
  const t = driverTraits(s);
  const b = makeBrain(rand, t.skill);
  // ピットの判断は bot.ts の updateBotPit が使う (天気の読み・すり減りの目安)
  return applySpecialties({ ...b, reaction: Math.max(0.15, b.reaction * (0.6 + 0.4 * t.mistakeScale)), mistakeScale: t.mistakeScale, pitSense: t.pitSense }, specs, opts);
}

/** 車に付ける倍率 (physics.ts の CarSetup に重ねる)。kerbScale は縁石がうまい人だけ */
export interface DriverCarScales {
  wearScale: number;
  fuelScale: number;
  kerbScale?: number;
}

/** 得意だけの車の倍率 (ライバルの車用。得意がなければ空 = 今のまま) */
export function specCarScales(specs?: readonly SpecialtyId[] | null): Partial<DriverCarScales> {
  if (!specs?.length) return {};
  const fx = specialtyEffects(specs);
  return {
    ...(fx.wearScale !== 1 ? { wearScale: fx.wearScale } : {}),
    ...(fx.fuelScale !== 1 ? { fuelScale: fx.fuelScale } : {}),
    ...(fx.kerbScale !== 1 ? { kerbScale: fx.kerbScale } : {}),
  };
}

/** 雇った運転手の車に付ける倍率: タイヤのすり減りと燃料の使い方 (能力 × 得意)、縁石 (得意) */
export function driverCarScales(s: DriverStats, specs?: readonly SpecialtyId[] | null): DriverCarScales {
  const t = driverTraits(s);
  const fx = specialtyEffects(specs);
  return { wearScale: t.wearScale * fx.wearScale, fuelScale: t.fuelScale * fx.fuelScale, ...(fx.kerbScale !== 1 ? { kerbScale: fx.kerbScale } : {}) };
}
