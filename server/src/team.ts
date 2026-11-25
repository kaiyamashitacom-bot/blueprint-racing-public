// チーム・運転手・整備・研究・市場・知らせの保存 (SQLite) と /api/team|drivers|research|market|notices の受け口。
// アカウントの DO (accounts_do.ts) の中で、同じ SQLite に表を足して使う。中身の計算は shared (team.ts・drivers.ts・research.ts・market.ts …)。
// - お金はいつも accounts.money と wallet_log を 1 つの取りまとめ (transaction) の中で動かす (applyMoneyMoves)
// - 部品は inventory を applyPartMoves で動かす
// - 時間で進むもの (研究・市場の締め切り・季節の切れ目) は、呼ばれたとき (と alarm) にまとめて進める (寝ている間の分も)
// - 無料の CPU の上限に合わせ、1 つの動きは取りまとめ 1 回、長い繰り返しはしない (alarm でも 1 回に進めるチームは数に上限)
// チームの id は アカウントの番号の文字列 (String(account_id))。ほかの人に返すときはチーム名に直す。
import {
  DRIVERS,
  awardChampionBonus,
  cleanSetupPref,
  type RaceSetupPref,
  MARKET,
  NOTICE_TITLES,
  RESEARCH_DEFS,
  STAT_KEYS,
  anyPartDef,
  applyMoneyMoves,
  applyPartMoves,
  answerSupply,
  buildCost,
  buyNow,
  canStartResearch,
  cancelListing,
  cancelResearch,
  createDriverPool,
  createListing,
  createTeam,
  crewServiceFactor,
  crewSkill,
  crewUpgradeCost,
  crewPracticeFull,
  CREW,
  designFits,
  driverFee,
  driverOverall,
  endSupplySeason,
  ensureFreeDrivers,
  familiarityNow,
  findDriver,
  freeDrivers,
  heldInBids,
  hireDriver,
  itemName,
  manufacture,
  minNextBid,
  nameKey,
  newMarket,
  offerSupply,
  orderSupply,
  placeBid,
  projectEta,
  projectProgress,
  pruneMarket,
  recordDriverRace,
  recordFamiliarity,
  recordPitStops,
  recordResearchRun,
  releaseDriver,
  releasePenalty,
  renewContracts,
  researchCost,
  researchDef,
  researchDuration,
  seasonIndexAt,
  seasonWindow,
  setCarDesign,
  setEmblem,
  setRenew,
  settleMarket,
  signingCost,
  startResearch,
  teamDriver,
  tickResearch,
  topBid,
  upgradeCrew,
  validateDesign,
  validateEmblem,
  DRIVER_STAT_CAP,
  type CarDesign,
  type Driver,
  type DriverPool,
  type DriverStats,
  type Emblem,
  type EconError,
  type EconEvent,
  type FamiliarityMap,
  type ItemMove,
  type JoinTeam,
  type Listing,
  type MarketItem,
  type MarketState,
  type MoneyMove,
  type MoneyReason,
  type SeasonWindow,
  type SupplyContract,
  type Team,
  type TeamRaceReport,
} from "@bpr/shared";
import { ApiError, MAX_DESIGNS, parseDesign, type Account, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";
import {
  EVOLUTIONS,
  EVOLVE_ERROR_TEXT,
  ITEM_ERROR_TEXT,
  ITEM_IDS,
  coachDriver,
  coachedCount,
  convertShards,
  evolvePart,
  evolveCost,
  inventoryItems,
  inventoryParts,
  isItemId,
  limitBreak,
  nextLimitId,
  recipeRequiresName,
  removeItem,
  COACH_MAX,
  type Inventory,
} from "@bpr/shared";
// 運転手の名簿・得意・珍しい運転手 (drivers.ts・drivercatalog.ts)
import { RARE_DRIVER_IDS, catalogDriver, catalogEntry, driverShortName, offerRareDriver, prizeOffers, upgradeDriverPool, withCatalogDriver } from "@bpr/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  account_id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  next_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS teams_next ON teams(next_at);
CREATE TABLE IF NOT EXISTS econ_kv (
  k TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
  account_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS notices_at ON notices(account_id, at);
CREATE TABLE IF NOT EXISTS familiarity (
  who TEXT NOT NULL,
  track TEXT NOT NULL,
  v REAL NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (who, track)
);
CREATE TABLE IF NOT EXISTS team_races (
  race_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS race_setup (
  account_id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_gifts (
  account_id INTEGER PRIMARY KEY,
  title TEXT,
  discount_pct INTEGER NOT NULL DEFAULT 0
);
`;

/** 運転手の候補をつくる種 (全チーム共通。仮) */
export const DRIVER_POOL_SEED = 20261125;
/** 知らせを 1 チームに残す数・日数 (仮) */
export const NOTICES_KEEP = 100;
export const NOTICES_KEEP_MS = 30 * 24 * 3600_000;
/** 決着した出品を残す時間 (仮。「自分の出品」に出す) */
export const MARKET_KEEP_MS = 7 * 24 * 3600_000;
/** alarm 1 回で研究を進めるチームの数の上限 (仮。CPU の上限のため) */
export const ALARM_TEAMS_MAX = 50;
/** 1 回に作れる数の上限 (仮) */
export const MANUFACTURE_MAX = 50;

const ERR_TEXT: Record<EconError, [number, string]> = {
  no_money: [400, "お金が足りません"],
  bad_amount: [400, "数かお金がおかしいです"],
  not_found: [404, "見つかりません"],
  taken: [409, "ほかのチームが先に契約しました"],
  not_owner: [400, "持っていないか、自分のものではありません"],
  not_allowed: [400, "それはできません"],
  already: [409, "もう済んでいます"],
  busy: [409, "研究は 1 つずつです。今の研究が終わるまで待ってください"],
  locked: [400, "まだできません (先に終わらせる研究があります)"],
  closed: [409, "もう締め切られています"],
  bid_too_low: [400, "値が低すぎます"],
  too_many: [400, "数が多すぎます"],
  bad_name: [400, "名前がおかしいです"],
  bad_emblem: [400, "紋章がおかしいです"],
};

function econFail(e: EconError): never {
  const [status, msg] = ERR_TEXT[e] ?? [400, "うまくいきませんでした"];
  throw new ApiError(status, msg);
}

const REASON_TEXT: Record<MoneyReason, string> = {
  prize: "賞金",
  driver_fee: "運転手の契約金",
  driver_penalty: "運転手の違約金",
  crew_upgrade: "整備の設備",
  research: "研究",
  manufacture: "部品を作る",
  market_buy: "市場で買う",
  market_sale: "市場で売れた",
  bid_hold: "競りに預ける",
  bid_refund: "競りの預けを戻す",
  supply_buy: "供給の部品を買う",
  supply_sale: "供給の部品が売れた",
  supply_build: "供給の部品を作る",
  evolve: "部品の進化",
};

const tid = (accountId: number) => String(accountId);
const aid = (teamId: string) => Number(teamId);
const r1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- 画面に返す形 (web/src/team_api.ts と合わせる)

export interface DriverView {
  id: string;
  name: string;
  /** 今の能力 (丸めた) と、育ちきる上限 */
  stats: Record<string, number>;
  potential: Record<string, number>;
  overall: number;
  races: number;
  /** 1 季節の契約金 */
  fee: number;
  /** 今雇うと払うお金 (空いている運転手だけ) */
  signCost?: number;
  /** 今手放すと払う違約金 (自分の運転手だけ) */
  penalty?: number;
  renew?: boolean;
  /** コースの id → 慣れ (0..1、自分の運転手だけ) */
  fam?: Record<string, number>;
  /** 得意 (drivers.ts の SPECIALTIES の id)・国の札・年代 (名簿の運転手だけ) */
  specs?: string[];
  nat?: string;
  era?: number;
  /** 珍しい運転手 */
  rare?: boolean;
  /** 季節のごほうび: ただで契約できる (季節の番号 until まで) */
  prizeUntil?: number;
}

export interface ListingView {
  id: string;
  mine: boolean;
  seller: string;
  mode: "fixed" | "auction";
  price: number;
  status: Listing["status"];
  endsAt: number;
  item: { type: "part" | "design"; name: string; partId?: string; count?: number; parts?: number };
  bids: number;
  top: number | null;
  topMine: boolean;
  minNext: number;
  finalPrice?: number;
  boughtByMe?: boolean;
}

export interface SupplyView {
  id: string;
  role: "supplier" | "buyer";
  other: string;
  partId: string;
  name: string;
  unitPrice: number;
  maxUnits: number;
  delivered: number;
  status: SupplyContract["status"];
}

export interface NoticeView {
  id: string;
  kind: string;
  title: string;
  text: string;
  at: number;
  read: boolean;
}

export interface TeamDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
  /** 市場の手数料の割合 (AdminConfig.marketFeeRate。なし = MARKET.feeRate) */
  marketFeeRate?: () => number;
}

export class TeamStore {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  readonly now: () => number;
  private feeRateOf: () => number;

  constructor(
    deps: TeamDeps,
    private accounts: AccountStore,
  ) {
    this.feeRateOf = deps.marketFeeRate ?? (() => MARKET.feeRate);
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
  }

  /** 今の市場の手数料の割合 (管理者の数。読めない・幅の外なら MARKET.feeRate) */
  feeRate(): number {
    const r = this.feeRateOf();
    return Number.isFinite(r) && r >= 0 && r <= 1 ? r : MARKET.feeRate;
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private row(q: string, ...b: SqlValue[]) {
    return this.rows(q, ...b)[0];
  }

  // ---------------------------------------------------------------- 保存

  private kvGet<T>(k: string): T | null {
    const r = this.row("SELECT body FROM econ_kv WHERE k = ?", k);
    return r ? (JSON.parse(String(r.body)) as T) : null;
  }

  private kvPut(k: string, v: unknown) {
    this.sql.exec("INSERT INTO econ_kv (k, body) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body", k, JSON.stringify(v));
  }

  loadTeam(accountId: number): Team | null {
    const r = this.row("SELECT body FROM teams WHERE account_id = ?", accountId);
    return r ? (JSON.parse(String(r.body)) as Team) : null;
  }

  private saveTeam(team: Team) {
    let next: number | null = null;
    for (const p of team.research.active) {
      const eta = projectEta(p);
      if (next === null || eta < next) next = eta;
    }
    this.sql.exec(
      "INSERT INTO teams (account_id, body, next_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET body = excluded.body, next_at = excluded.next_at, updated_at = excluded.updated_at",
      aid(team.id),
      JSON.stringify(team),
      next,
      this.now(),
    );
  }

  /** チーム (なければ作る) */
  private teamOf(accountId: number): Team {
    const t = this.loadTeam(accountId);
    if (t) return t;
    const r = createTeam({ id: tid(accountId), now: this.now(), seed: accountId * 7919 + 13 });
    if (!r.ok) econFail(r.error);
    this.saveTeam(r.team);
    return r.team;
  }

  private pool(): DriverPool {
    const saved = this.kvGet<DriverPool>("drivers");
    if (!saved) return ensureFreeDrivers(createDriverPool(DRIVER_POOL_SEED));
    // 前に保存した候補に 名簿の運転手と得意を足す (前からいる人の id と能力はそのまま。変わったら 1 回だけ保存)
    const up = upgradeDriverPool(saved);
    if (up !== saved) this.savePool(up);
    return up;
  }

  private savePool(p: DriverPool) {
    this.kvPut("drivers", p);
  }

  private market(): MarketState {
    return this.kvGet<MarketState>("market") ?? newMarket();
  }

  private saveMarket(m: MarketState) {
    this.kvPut("market", pruneMarket(m, this.now() - MARKET_KEEP_MS));
  }

  private clock(now = this.now()): SeasonWindow {
    return seasonWindow(seasonIndexAt(now));
  }

  private money(accountId: number): number {
    return Number(this.row("SELECT money FROM accounts WHERE id = ?", accountId)?.money ?? 0);
  }

  private exists(accountId: number): boolean {
    return !!this.row("SELECT id FROM accounts WHERE id = ?", accountId);
  }

  private teamNames(ids: Iterable<string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) {
      const r = this.row("SELECT team FROM accounts WHERE id = ?", aid(id));
      out.set(id, r ? String(r.team) : "(退会したチーム)");
    }
    return out;
  }

  // ---------------------------------------------------------------- お金・持ち物・知らせ (取りまとめの中で呼ぶ)

  /**
   * お金の出入りを財布に当てる。strict なら足りないときに断る (呼ぶ側の取りまとめごと戻る)。
   * strict でない (決着・季節の切れ目) ときは、退会したチームの分を飛ばす。
   */
  private applyMoney(moves: readonly MoneyMove[], strict = true) {
    if (!moves.length) return;
    const wallets: Record<string, number> = {};
    for (const m of moves) {
      if (m.teamId in wallets) continue;
      const r = this.row("SELECT money FROM accounts WHERE id = ?", aid(m.teamId));
      if (r) wallets[m.teamId] = Number(r.money);
    }
    const use = strict ? moves : moves.filter((m) => m.teamId in wallets);
    const res = applyMoneyMoves(wallets, use);
    if (!res.ok) econFail(res.error);
    const now = this.now();
    for (const [id, money] of Object.entries(res.wallets)) this.sql.exec("UPDATE accounts SET money = ? WHERE id = ?", money, aid(id));
    for (const m of use) {
      if (!m.amount) continue;
      const why = `${REASON_TEXT[m.reason] ?? m.reason}${m.ref ? ` (${m.ref})` : ""}`;
      this.sql.exec("INSERT INTO wallet_log (account_id, delta, reason, at) VALUES (?, ?, ?, ?)", aid(m.teamId), m.amount, why.slice(0, 80), now);
    }
  }

  /** 物の出入りを持ち物に当てる (部品は inventory、設計図は designs に写しを足す) */
  private applyItems(items: readonly ItemMove[], strict = true) {
    const byTeam = new Map<string, ItemMove[]>();
    for (const it of items) {
      if (it.item.type === "design") {
        if (it.change === "add" && this.exists(aid(it.teamId))) this.insertDesign(aid(it.teamId), it.item.design);
        continue;
      }
      const list = byTeam.get(it.teamId) ?? [];
      list.push(it);
      byTeam.set(it.teamId, list);
    }
    for (const [teamId, list] of byTeam) {
      const id = aid(teamId);
      if (!this.exists(id)) {
        if (strict) econFail("not_found");
        continue;
      }
      const before = this.accounts.inventory(id);
      const res = applyPartMoves(before, teamId, list);
      if (!res.ok) {
        if (strict) econFail(res.error);
        continue;
      }
      const after = res.inventory;
      for (const part of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const n = after[part] ?? 0;
        if (n === (before[part] ?? 0)) continue;
        if (n <= 0) this.sql.exec("DELETE FROM inventory WHERE account_id = ? AND part_id = ?", id, part);
        else this.sql.exec("INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?) ON CONFLICT(account_id, part_id) DO UPDATE SET n = excluded.n", id, part, n);
      }
    }
  }

  private insertDesign(accountId: number, design: CarDesign): number {
    const r = this.row("INSERT INTO designs (account_id, name, body, updated_at) VALUES (?, ?, ?, ?) RETURNING id", accountId, design.name, JSON.stringify(design), this.now());
    return Number(r!.id);
  }

  private designCount(accountId: number): number {
    return Number(this.row("SELECT COUNT(*) AS c FROM designs WHERE account_id = ?", accountId)?.c ?? 0);
  }

  private loadDesign(accountId: number, id: number): { id: number; name: string; design: CarDesign } | null {
    const r = this.row("SELECT id, name, body FROM designs WHERE id = ? AND account_id = ?", id, accountId);
    if (!r) return null;
    const design = parseDesign(JSON.parse(String(r.body)));
    return design ? { id: Number(r.id), name: String(r.name), design } : null;
  }

  /** 出来事を知らせにして残す (同じ id は 1 回だけ) */
  private notify(events: readonly EconEvent[], market?: MarketState, pool?: DriverPool) {
    if (!events.length) return;
    const m = market ?? this.market();
    const p = pool ?? null;
    const listing = (id: string) => m.listings.find((l) => l.id === id);
    const supply = (id: string) => m.supplies.find((s) => s.id === id);
    const lname = (id: string) => {
      const l = listing(id);
      return l ? itemName(l.item) : "品物";
    };
    const pname = (partId: string) => anyPartDef(partId)?.name ?? partId;
    const dname = (id: string) => (p ? findDriver(p, id)?.name : null) ?? "運転手";
    const names = this.teamNames(events.flatMap((e) => ("contractId" in e ? [supply(e.contractId)?.supplierId ?? "", supply(e.contractId)?.buyerId ?? ""] : [])).filter(Boolean));
    const now = this.now();
    for (const ev of events) {
      let kind: string = ev.type;
      let title = "";
      let text = "";
      let id = "";
      let at = now;
      switch (ev.type) {
        case "research_done":
          kind = "research_done";
          title = NOTICE_TITLES.research_done;
          text = `${pname(ev.partId)} ができました。研究の画面で作れます`;
          id = `research:${ev.teamId}:${ev.researchId}`;
          at = ev.at;
          break;
        case "sold":
          kind = "market_sold";
          title = NOTICE_TITLES.market_sold;
          text = `${lname(ev.listingId)} が ${ev.price.toLocaleString("ja-JP")} で売れました (手数料 ${ev.fee.toLocaleString("ja-JP")})`;
          id = `sold:${ev.listingId}`;
          at = ev.at;
          break;
        case "outbid":
          kind = "outbid";
          title = NOTICE_TITLES.outbid;
          text = `${lname(ev.listingId)} の競りで ${ev.amount.toLocaleString("ja-JP")} に抜かれました。入れたお金は戻りました`;
          id = `outbid:${ev.listingId}:${ev.teamId}:${ev.at}`;
          at = ev.at;
          break;
        case "won":
          title = "競りで落とした";
          text = `${lname(ev.listingId)} を ${ev.price.toLocaleString("ja-JP")} で落としました`;
          id = `won:${ev.listingId}`;
          at = ev.at;
          break;
        case "expired": {
          const l = listing(ev.listingId);
          title = "売れなかった";
          text = `${lname(ev.listingId)} は売れずに期限が切れました${l?.item.type === "part" ? "。持ち物に戻しました" : ""}`;
          id = `expired:${ev.listingId}`;
          at = ev.at;
          break;
        }
        case "bought":
          continue; // 自分で買ったので知らせない
        case "contract_renewed":
          title = "契約を続けた";
          text = `${dname(ev.driverId)} の契約を次の季節も続けました (${ev.fee.toLocaleString("ja-JP")})`;
          id = `renewed:${ev.driverId}:${ev.season}`;
          break;
        case "contract_ended":
          title = "契約が切れた";
          text = `${dname(ev.driverId)} の契約が季節の切れ目で終わりました${ev.why === "no_money" ? " (お金が足りなかった)" : ""}`;
          id = `ended:${ev.driverId}:${ev.season}`;
          break;
        case "supply_offered": {
          const s = supply(ev.contractId);
          title = "供給の申し出";
          text = s ? `${names.get(s.supplierId)} から ${pname(s.partId)} の供給の申し出 (1 個 ${s.unitPrice.toLocaleString("ja-JP")}・${s.maxUnits} 個まで)` : "部品の供給の申し出がありました";
          id = `offer:${ev.contractId}`;
          at = ev.at;
          break;
        }
        case "supply_accepted": {
          const s = supply(ev.contractId);
          title = "供給を受けた";
          text = s ? `${names.get(s.buyerId)} が ${pname(s.partId)} の供給を受けました` : "供給の申し出が受けられました";
          id = `accepted:${ev.contractId}`;
          at = ev.at;
          break;
        }
        case "supply_order": {
          const s = supply(ev.contractId);
          title = "供給の注文";
          text = s ? `${names.get(s.buyerId)} から ${pname(s.partId)} ×${ev.count} の注文。作って届けました` : `供給の注文 ×${ev.count}`;
          id = `order:${ev.contractId}:${ev.at}:${ev.count}`;
          at = ev.at;
          break;
        }
        case "supply_ended": {
          const s = supply(ev.contractId);
          title = "供給の約束が終わった";
          text = `${s ? pname(s.partId) : "部品"} の供給の約束が季節の切れ目で終わりました`;
          id = `supend:${ev.contractId}:${ev.teamId}`;
          break;
        }
      }
      const acc = aid(ev.teamId);
      if (!title || !this.exists(acc)) continue;
      this.sql.exec("INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) VALUES (?, ?, ?, ?, ?, ?, 0)", acc, id, kind, title, text.slice(0, 200), at);
    }
  }

  // ---------------------------------------------------------------- 時間で進むもの

  /** 季節の切れ目: 運転手の契約を続ける (お金を払う) か終える。供給の約束を終える */
  private seasonRollover(now: number) {
    const cur = seasonIndexAt(now);
    const last = this.kvGet<number>("season");
    if (last === null) {
      this.kvPut("season", cur);
      return;
    }
    if (cur <= last) return;
    let pool = this.pool();
    const wallets: Record<string, number> = {};
    for (const d of pool.drivers) if (d.contract && !(d.contract.teamId in wallets)) wallets[d.contract.teamId] = this.money(aid(d.contract.teamId));
    // ギフトコードの契約金の割引 (使ったら消える)
    const discounts: Record<string, number> = {};
    for (const r of this.rows("SELECT account_id, discount_pct FROM team_gifts WHERE discount_pct > 0")) discounts[tid(Number(r.account_id))] = Number(r.discount_pct);
    const ren = renewContracts(pool, wallets, cur, discounts);
    pool = ren.pool;
    this.applyMoney(
      ren.charges.map((c) => ({ teamId: c.teamId, amount: -c.amount, reason: "driver_fee" as const, ref: c.discount ? `${c.driverId} 割引 ${c.discount}` : c.driverId })),
      false,
    );
    for (const c of ren.charges) if (c.discount) this.sql.exec("UPDATE team_gifts SET discount_pct = 0 WHERE account_id = ?", aid(c.teamId));
    const sup = endSupplySeason(this.market(), cur);
    this.savePool(ensureFreeDrivers(pool));
    this.saveMarket(sup.market);
    this.notify([...ren.events, ...sup.events], sup.market, pool);
    this.kvPut("season", cur);
  }

  /** 締め切りの来た出品を決着させる */
  private settle(now: number) {
    const m = this.market();
    const out = settleMarket(m, now, this.feeRate());
    if (out.market === m) return;
    this.applyMoney(out.moves, false);
    this.applyItems(out.items, false);
    this.saveMarket(out.market);
    this.notify(out.events, out.market);
  }

  private tickTeam(accountId: number, now: number) {
    const team = this.loadTeam(accountId);
    if (!team) return;
    const r = tickResearch(team, now);
    if (r.team !== team) this.saveTeam(r.team);
    this.notify(r.events);
  }

  /** 呼ばれたときにまとめて進める (取りまとめの中で) */
  private tickIn(now: number, accountId?: number) {
    this.seasonRollover(now);
    this.settle(now);
    if (accountId !== undefined) this.tickTeam(accountId, now);
  }

  /** 取りまとめ 1 回: 進めてから fn */
  private act<T>(accountId: number, fn: (now: number) => T): T {
    const now = this.now();
    return this.tx(() => {
      this.tickIn(now, accountId);
      return fn(now);
    });
  }

  /** alarm から: 時間の来たものを進める。研究は時刻の来たチームだけ (数に上限) */
  tickAll(): void {
    const now = this.now();
    this.tx(() => {
      this.tickIn(now);
      for (const r of this.rows("SELECT account_id FROM teams WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?", now, ALARM_TEAMS_MAX)) {
        this.tickTeam(Number(r.account_id), now);
      }
    });
  }

  /** 次に起きる時刻 (研究が終わる・出品が締め切られる・季節の切れ目のうち一番早いもの) */
  nextWake(): number | null {
    let best: number | null = null;
    const take = (t: number | null | undefined) => {
      if (t !== null && t !== undefined && Number.isFinite(t) && (best === null || t < best)) best = t;
    };
    take(Number(this.row("SELECT MIN(next_at) AS t FROM teams WHERE next_at IS NOT NULL")?.t ?? NaN));
    for (const l of this.market().listings) if (l.status === "open") take(l.endsAt);
    const pool = this.kvGet<DriverPool>("drivers");
    const m = this.kvGet<MarketState>("market");
    if (pool?.drivers.some((d) => d.contract) || m?.supplies.some((s) => s.status === "active" || s.status === "offered")) take(this.clock().endsAt);
    return best;
  }

  // ---------------------------------------------------------------- ギフトコード (server/src/gift.ts から。呼ぶ側の取りまとめの中で)

  /** 贈られた称号と、契約金の割引 (%) */
  giftExtras(accountId: number): { title: string | null; discountPct: number } {
    const r = this.row("SELECT title, discount_pct FROM team_gifts WHERE account_id = ?", accountId);
    return { title: r && r.title !== null ? String(r.title) : null, discountPct: r ? Number(r.discount_pct) : 0 };
  }

  private giftDiscountPct(accountId: number): number {
    return this.giftExtras(accountId).discountPct;
  }

  /** 受け取る前に: 時間で進むもの (研究の終わり・季節の切れ目) を進め、チームが無ければ作る */
  giftPrepare(accountId: number, now: number): void {
    this.tickIn(now, accountId);
    this.teamOf(accountId);
  }

  /** 契約金の割引を持たせる (重ねて持つと大きいほう) */
  giftDiscount(accountId: number, pct: number): void {
    this.sql.exec(
      "INSERT INTO team_gifts (account_id, title, discount_pct) VALUES (?, NULL, ?) ON CONFLICT(account_id) DO UPDATE SET discount_pct = MAX(discount_pct, excluded.discount_pct)",
      accountId,
      Math.max(0, Math.min(100, Math.floor(pct))),
    );
  }

  /** 贈られた称号 (新しいものに置きかわる) */
  giftTitle(accountId: number, title: string): void {
    this.sql.exec("INSERT INTO team_gifts (account_id, title, discount_pct) VALUES (?, ?, 0) ON CONFLICT(account_id) DO UPDATE SET title = excluded.title", accountId, title);
  }

  /** 運転手の名前 (いなければ undefined) */
  driverName(driverId: string): string | undefined {
    return findDriver(this.pool(), driverId)?.name ?? catalogEntry(driverId)?.name;
  }

  /** 空いている運転手の一覧 (管理者の画面の選び用。契約中も印を付けて全部。珍しい運転手は まだ候補にいなくても並ぶ) */
  driverChoices(): Array<{ id: string; name: string; overall: number; team: string | null }> {
    const pool = ensureFreeDrivers(this.pool());
    const names = this.teamNames(pool.drivers.flatMap((d) => (d.contract ? [d.contract.teamId] : [])));
    const rares = RARE_DRIVER_IDS.filter((id) => !findDriver(pool, id)).map((id) => catalogDriver(catalogEntry(id)!));
    return [...pool.drivers, ...rares]
      .map((d) => ({ id: d.id, name: d.rare ? `★ ${d.name} (珍しい)` : d.name, overall: r1(driverOverall(d.stats)), team: d.contract ? (names.get(d.contract.teamId) ?? null) : null }))
      .sort((a, b) => b.overall - a.overall);
  }

  /** 決めた運転手とただで契約する。今の運転手は違約金なしで離れる。ほかのチームと契約中なら断る (取りまとめごと戻る)。珍しい運転手も (名簿から足す) */
  giftHireDriver(accountId: number, driverId: string, now: number): string {
    const pool = ensureFreeDrivers(withCatalogDriver(this.pool(), driverId));
    const d = findDriver(pool, driverId);
    if (!d) throw new ApiError(409, "今は受け取れません: その運転手は見つかりません");
    const me = tid(accountId);
    if (d.contract?.teamId === me) return `${d.name} とはもう契約しています`;
    if (d.contract) throw new ApiError(409, `今は受け取れません: ${d.name} はほかのチームと契約しています`);
    const clock = this.clock(now);
    const cur = teamDriver(pool, me);
    const drivers = pool.drivers.map((x) =>
      x.id === d.id ? { ...x, offer: undefined, contract: { teamId: me, fee: driverFee(x), since: clock.index, paidSeason: clock.index, renew: true } } : cur && x.id === cur.id ? { ...x, contract: null } : x,
    );
    this.savePool(ensureFreeDrivers({ ...pool, drivers }));
    return `運転手 ${d.name} と契約しました`;
  }

  /** 雇っている運転手の能力を上げる (100 まで。育ちきる上限も合わせる)。運転手がいなければ断る */
  giftDriverStats(accountId: number, stat: string, amount: number): string {
    const pool = this.pool();
    const d = teamDriver(pool, tid(accountId));
    if (!d) throw new ApiError(409, "今は受け取れません: 先に運転手を雇ってください");
    const keys = stat === "all" ? STAT_KEYS : STAT_KEYS.filter((k) => k === stat);
    const stats = { ...d.stats } as DriverStats;
    const potential = { ...d.potential } as DriverStats;
    for (const k of keys) {
      stats[k] = Math.min(DRIVER_STAT_CAP, stats[k] + amount);
      potential[k] = Math.min(DRIVER_STAT_CAP, Math.max(potential[k], stats[k]));
    }
    this.savePool({ ...pool, drivers: pool.drivers.map((x) => (x.id === d.id ? { ...x, stats, potential } : x)) });
    return `${d.name} の能力が上がりました`;
  }

  /** 研究を済ませる (前の節もいっしょに) か、研究中のものを進める。node = "" なら研究中の全部 */
  giftResearch(accountId: number, mode: "finish" | "advance", node: string, hours: number, now: number): string {
    let team = this.teamOf(accountId);
    const st = team.research;
    if (mode === "finish" && node) {
      // 前の節からたどって、まだのものを全部済ませる
      const chain: string[] = [];
      for (let id: string | null = node; id; id = researchDef(id)?.requires ?? null) if (!st.done.includes(id)) chain.unshift(id);
      if (!chain.length) return `${researchDef(node)?.part.name ?? node} の研究はもう済んでいます`;
      team = { ...team, research: { active: st.active.filter((p) => !chain.includes(p.researchId)), done: [...st.done, ...chain] } };
      this.saveTeam(team);
      this.notify(chain.map((id) => ({ type: "research_done" as const, teamId: team.id, researchId: id, partId: researchDef(id)?.part.id ?? "", at: now })));
      return `研究 ${chain.map((id) => researchDef(id)?.part.name ?? id).join("・")} が済みました`;
    }
    const targets = st.active.filter((p) => !node || p.researchId === node);
    if (!targets.length) throw new ApiError(409, node ? "今は受け取れません: その研究を始めてから受け取ってください" : "今は受け取れません: 研究を始めてから受け取ってください");
    const add = mode === "finish" ? Infinity : hours * 3600_000;
    const active = st.active.map((p) => (targets.includes(p) ? { ...p, boostMs: Number.isFinite(add) ? p.boostMs + add : p.boostMs + Math.max(0, projectEta(p) - now) } : p));
    const r = tickResearch({ ...team, research: { ...st, active } }, now);
    this.saveTeam(r.team);
    this.notify(r.events);
    return `研究 ${targets.map((p) => researchDef(p.researchId)?.part.name ?? p.researchId).join("・")} が${mode === "finish" ? "済みました" : ` ${hours} 時間進みました`}`;
  }

  /** 整備の設備の段を上げる (一番上まで) */
  giftCrew(accountId: number, levels: number): string {
    const team = this.teamOf(accountId);
    const level = Math.min(CREW.maxLevel, team.crew.level + levels);
    if (level === team.crew.level) return "整備の組はもう一番上の段です";
    this.saveTeam({ ...team, crew: { ...team.crew, level } });
    return `整備の組が ${level} 段になりました`;
  }

  giftEmblem(accountId: number, emblem: Emblem): void {
    if (!validateEmblem(emblem)) throw new ApiError(400, "紋章がおかしいです");
    this.saveTeam({ ...this.teamOf(accountId), emblem });
  }

  /** 設計図の写しを足す (数の上限を超えるなら断る) */
  giftDesign(accountId: number, design: CarDesign): void {
    const count = Number(this.row("SELECT COUNT(*) AS c FROM designs WHERE account_id = ?", accountId)?.c ?? 0);
    if (count >= MAX_DESIGNS) throw new ApiError(409, `今は受け取れません: 設計図が ${MAX_DESIGNS} 個あります。1 つ消してから受け取ってください`);
    this.insertDesign(accountId, design);
  }

  // ---------------------------------------------------------------- チーム

  private driverView(d: Driver, opts: { mine?: boolean; now: number }): DriverView {
    const round = (s: Record<string, number>) => Object.fromEntries(STAT_KEYS.map((k) => [k, Math.round(s[k])]));
    const v: DriverView = {
      id: d.id,
      name: d.name,
      stats: round(d.stats as unknown as Record<string, number>),
      potential: round(d.potential as unknown as Record<string, number>),
      overall: r1(driverOverall(d.stats)),
      races: d.races,
      fee: driverFee(d),
      specs: [...(d.specs ?? [])],
      ...(d.nat ? { nat: d.nat } : {}),
      ...(d.era ? { era: d.era } : {}),
      ...(d.rare ? { rare: true } : {}),
      ...(d.rare && d.offer && !d.contract ? { prizeUntil: d.offer.until } : {}),
    };
    const clock = this.clock(opts.now);
    if (opts.mine && d.contract) {
      v.penalty = releasePenalty(d, clock, opts.now);
      v.renew = d.contract.renew;
      v.fee = d.contract.fee;
      v.fam = familiarityNow(this.famMap(`d:${d.id}`), opts.now);
    } else if (!d.contract) v.signCost = signingCost(d, clock, opts.now);
    return v;
  }

  private carRef(accountId: number, id: string | null) {
    if (!id) return null;
    const d = this.loadDesign(accountId, Number(id));
    if (!d) return null;
    return { id: d.id, name: d.name, ok: validateDesign(d.design).length === 0, fits: designFits(d.design, this.accounts.inventory(accountId)).ok };
  }

  private unread(accountId: number): number {
    return Number(this.row("SELECT COUNT(*) AS c FROM notices WHERE account_id = ? AND read = 0", accountId)?.c ?? 0);
  }

  teamView(acc: Account) {
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      const pool = this.pool();
      const d = teamDriver(pool, team.id);
      const market = this.market();
      const clock = this.clock(now);
      return {
        now,
        name: acc.team,
        driverName: acc.driver,
        /** 管理者のギフトコードで贈られた称号 (リーグ戦の肩書きとは別の飾り) */
        giftTitle: this.giftExtras(acc.id).title,
        emblem: team.emblem,
        money: this.money(acc.id),
        held: heldInBids(market, team.id),
        cars: { player: this.carRef(acc.id, team.cars.player), second: this.carRef(acc.id, team.cars.second) },
        crew: {
          level: team.crew.level,
          maxLevel: CREW.maxLevel,
          stops: team.crew.stops,
          skill: Math.round(crewSkill(team.crew) * 1000) / 1000,
          factor: Math.round(crewServiceFactor(team.crew) * 1000) / 1000,
          nextCost: crewUpgradeCost(team.crew),
          practiceFull: crewPracticeFull(team.crew),
        },
        driver: d ? this.driverView(d, { mine: true, now }) : null,
        research: team.research.active.map((p) => ({ researchId: p.researchId, name: researchDef(p.researchId)?.part.name ?? p.researchId, progress: projectProgress(p, now), eta: projectEta(p) })),
        designs: this.accounts.listDesigns(acc.id).map((x) => ({ id: x.id, name: x.name, ok: validateDesign(x.design).length === 0 })),
        standInFam: familiarityNow(this.famMap(`s:${acc.id}`), now),
        season: { index: clock.index, endsAt: clock.endsAt },
        unread: this.unread(acc.id),
      };
    });
  }

  setEmblem(acc: Account, emblem: unknown) {
    return this.act(acc.id, () => {
      const r = setEmblem(this.teamOf(acc.id), emblem as Team["emblem"]);
      if (!r.ok) econFail(r.error);
      this.saveTeam(r.team);
      return { emblem: r.team.emblem };
    });
  }

  /**
   * 1 台目・2 台目の設計図を決める。designId (サーバーの設計図) か design (この機械の設計図を送る) のどちらか。
   * design を送ったときは、その台がもう指している設計図を上書きする (もう 1 台と同じ設計図なら新しく作る)。null で外す
   */
  setCar(acc: Account, slot: unknown, b: Record<string, unknown>) {
    if (slot !== "player" && slot !== "second") throw new ApiError(400, "1 台目か 2 台目を選んでください");
    return this.act(acc.id, () => {
      const team = this.teamOf(acc.id);
      let id: string | null = null;
      if (b.design !== undefined && b.design !== null) {
        const design = parseDesign(b.design);
        if (!design) throw new ApiError(400, "設計図が読めません");
        const errs = validateDesign(design);
        if (errs.length) throw new ApiError(400, `走れる車にしてください (${errs[0]})`);
        const fit = designFits(design, this.accounts.inventory(acc.id));
        if (!fit.ok) throw new ApiError(400, "持っていない部品を使っています");
        const cur = team.cars[slot];
        const other = team.cars[slot === "player" ? "second" : "player"];
        const curRow = cur && cur !== other ? this.loadDesign(acc.id, Number(cur)) : null;
        if (curRow) {
          this.sql.exec("UPDATE designs SET name = ?, body = ?, updated_at = ? WHERE id = ? AND account_id = ?", design.name, JSON.stringify(design), this.now(), curRow.id, acc.id);
          id = String(curRow.id);
        } else {
          if (this.designCount(acc.id) >= MAX_DESIGNS) throw new ApiError(400, `設計図は ${MAX_DESIGNS} 個までです`);
          id = String(this.insertDesign(acc.id, design));
        }
      } else if (b.designId !== undefined && b.designId !== null) {
        const d = this.loadDesign(acc.id, Number(b.designId));
        if (!d) throw new ApiError(404, "その設計図は見つかりません");
        id = String(d.id);
      }
      const next = setCarDesign(team, slot, id);
      this.saveTeam(next);
      return { cars: { player: this.carRef(acc.id, next.cars.player), second: this.carRef(acc.id, next.cars.second) } };
    });
  }

  upgradeCrew(acc: Account) {
    return this.act(acc.id, () => {
      const team = this.teamOf(acc.id);
      const r = upgradeCrew(team, this.money(acc.id));
      if (!r.ok) econFail(r.error);
      this.applyMoney([{ teamId: team.id, amount: -r.cost, reason: "crew_upgrade", ref: `L${r.team.crew.level}` }]);
      this.saveTeam(r.team);
      return { level: r.team.crew.level, cost: r.cost, money: this.money(acc.id) };
    });
  }

  // ---------------------------------------------------------------- 運転手

  driversView(acc: Account) {
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      let pool = this.pool();
      const ensured = ensureFreeDrivers(pool);
      if (ensured !== pool || !this.kvGet("drivers")) this.savePool((pool = ensured));
      const mine = teamDriver(pool, team.id);
      const clock = this.clock(now);
      return {
        now,
        money: this.money(acc.id),
        season: { index: clock.index, endsAt: clock.endsAt },
        mine: mine ? this.driverView(mine, { mine: true, now }) : null,
        // 季節のごほうびの珍しい運転手 (このチームだけ、ただ) を先頭に
        free: [...prizeOffers(pool, team.id, clock.index), ...freeDrivers(pool)]
          .map((d) => this.driverView(d, { now }))
          .sort((a, b) => Number(!!b.prizeUntil) - Number(!!a.prizeUntil) || b.overall - a.overall),
        skill: { min: DRIVERS.skillMin, max: DRIVERS.skillMax },
        /** ギフトコードの契約金の割引 (%、次の 1 回。0 = なし) */
        discountPct: this.giftDiscountPct(acc.id),
      };
    });
  }

  hire(acc: Account, driverId: unknown) {
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      const pct = this.giftDiscountPct(acc.id);
      const r = hireDriver(this.pool(), team.id, String(driverId ?? ""), this.money(acc.id), this.clock(now), now, pct);
      if (!r.ok) econFail(r.error);
      // ギフトコードの割引は 1 回使ったら消える
      if (r.discount > 0) this.sql.exec("UPDATE team_gifts SET discount_pct = 0 WHERE account_id = ?", acc.id);
      const moves: MoneyMove[] = [];
      if (r.penalty > 0) moves.push({ teamId: team.id, amount: -r.penalty, reason: "driver_penalty", ref: r.releasedId ?? undefined });
      if (r.cost - r.penalty > 0) moves.push({ teamId: team.id, amount: -(r.cost - r.penalty), reason: "driver_fee", ref: String(driverId) });
      this.applyMoney(moves);
      this.savePool(ensureFreeDrivers(r.pool));
      return { cost: r.cost, penalty: r.penalty, discount: r.discount, money: this.money(acc.id) };
    });
  }

  release(acc: Account) {
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      const r = releaseDriver(this.pool(), team.id, this.money(acc.id), this.clock(now), now);
      if (!r.ok) econFail(r.error);
      this.applyMoney([{ teamId: team.id, amount: -r.cost, reason: "driver_penalty", ref: r.driverId }]);
      this.savePool(ensureFreeDrivers(r.pool));
      return { penalty: r.cost, money: this.money(acc.id) };
    });
  }

  setRenew(acc: Account, renew: unknown) {
    if (typeof renew !== "boolean") throw new ApiError(400, "続けるかどうかを選んでください");
    return this.act(acc.id, () => {
      const r = setRenew(this.pool(), tid(acc.id), renew);
      if (!r.ok) econFail(r.error);
      this.savePool(r.pool);
      return { renew };
    });
  }

  // ---------------------------------------------------------------- 研究

  researchView(acc: Account) {
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      const st = team.research;
      const tree = RESEARCH_DEFS.map((d) => {
        const can = canStartResearch(st, d.id);
        const state = st.done.includes(d.id) ? "done" : st.active.some((p) => p.researchId === d.id) ? "active" : can === "ok" ? "open" : can === "busy" ? "busy" : "locked";
        return {
          id: d.id,
          part: d.part,
          requires: d.requires,
          requiresName: d.requires ? (researchDef(d.requires)?.part.name ?? d.requires) : null,
          boost: d.boost.map((id) => anyPartDef(id)?.name ?? id),
          cost: researchCost(d),
          hours: researchDuration(d) / 3600_000,
          buildCost: buildCost(d),
          state,
        };
      });
      return {
        now,
        money: this.money(acc.id),
        parts: this.accounts.inventory(acc.id),
        tree,
        active: st.active.map((p) => ({ researchId: p.researchId, name: researchDef(p.researchId)?.part.name ?? p.researchId, startedAt: p.startedAt, boostMs: p.boostMs, progress: projectProgress(p, now), eta: projectEta(p) })),
        manufactureMax: MANUFACTURE_MAX,
      };
    });
  }

  startResearch(acc: Account, researchId: unknown) {
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      const r = startResearch(team, String(researchId ?? ""), this.money(acc.id), now);
      if (!r.ok) econFail(r.error);
      this.applyMoney([{ teamId: team.id, amount: -r.cost, reason: "research", ref: String(researchId) }]);
      this.saveTeam(r.team);
      return { cost: r.cost, money: this.money(acc.id) };
    });
  }

  cancelResearch(acc: Account, researchId: unknown) {
    return this.act(acc.id, () => {
      const team = this.teamOf(acc.id);
      const r = cancelResearch(team, String(researchId ?? ""));
      if (!r.ok) econFail(r.error);
      if (r.refund > 0) this.applyMoney([{ teamId: team.id, amount: r.refund, reason: "research", ref: String(researchId) }]);
      this.saveTeam(r.team);
      return { refund: r.refund, money: this.money(acc.id) };
    });
  }

  manufacture(acc: Account, partId: unknown, count: unknown) {
    const n = Number(count ?? 1);
    if (!Number.isInteger(n) || n < 1 || n > MANUFACTURE_MAX) throw new ApiError(400, `1 回に作れるのは 1〜${MANUFACTURE_MAX} 個です`);
    return this.act(acc.id, () => {
      const team = this.teamOf(acc.id);
      const r = manufacture(team, String(partId ?? ""), n, this.money(acc.id));
      if (!r.ok) econFail(r.error);
      this.applyMoney([{ teamId: team.id, amount: -r.cost, reason: "manufacture", ref: `${r.partId}×${r.count}` }]);
      this.applyItems([{ teamId: team.id, item: { type: "part", partId: r.partId, count: r.count }, change: "add" }]);
      return { cost: r.cost, money: this.money(acc.id), parts: this.accounts.inventory(acc.id) };
    });
  }

  // ---------------------------------------------------------------- 進化・限界突破・品 (evolution.ts・items.ts)

  /** 持ち物を書きかえる (before → after の差だけ) */
  private writeInventory(accountId: number, before: Readonly<Inventory>, after: Readonly<Inventory>) {
    for (const part of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const n = after[part] ?? 0;
      if (n === (before[part] ?? 0)) continue;
      if (n <= 0) this.sql.exec("DELETE FROM inventory WHERE account_id = ? AND part_id = ?", accountId, part);
      else this.sql.exec("INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?) ON CONFLICT(account_id, part_id) DO UPDATE SET n = excluded.n", accountId, part, n);
    }
  }

  /** 進化の木・限界突破できる部品・品・雇った運転手の指導の回数 (研究の画面の「進化」) */
  evolutionView(acc: Account) {
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      const inv = this.accounts.inventory(acc.id);
      const done = team.research.done;
      const recipes = EVOLUTIONS.map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        fromPart: anyPartDef(r.from) ?? null,
        toPart: anyPartDef(r.to) ?? null,
        branch: r.branch ?? null,
        requires: r.requires,
        requiresName: recipeRequiresName(r),
        unlocked: !r.requires || done.includes(r.requires),
        cost: evolveCost(r),
        owned: inv[r.from] ?? 0,
      }));
      const limits = Object.keys(inv)
        .filter((id) => (inv[id] ?? 0) > 0 && nextLimitId(id))
        .map((id) => ({ id, part: anyPartDef(id)!, next: anyPartDef(nextLimitId(id)!)!, owned: inv[id] }));
      const d = teamDriver(this.pool(), tid(acc.id));
      return {
        now,
        money: this.money(acc.id),
        parts: inventoryParts(inv),
        items: inventoryItems(inv).map((x) => ({ id: x.def.id, name: x.def.name, note: x.def.note, makes: x.def.makes ?? null, count: x.count })),
        recipes,
        limits,
        driver: d ? { id: d.id, name: d.name, coached: coachedCount(d), coachMax: COACH_MAX, potential: d.potential } : null,
      };
    });
  }

  /** 部品を進化させる (お金 + 済んだ研究)。持ち物から 1 つ出て 1 つ入る */
  evolve(acc: Account, recipeId: unknown) {
    return this.act(acc.id, () => {
      const team = this.teamOf(acc.id);
      const before = this.accounts.inventory(acc.id);
      const r = evolvePart(String(recipeId ?? ""), before, team.research, this.money(acc.id));
      if (!r.ok) throw new ApiError(r.error === "not_found" ? 404 : 400, EVOLVE_ERROR_TEXT[r.error]);
      this.applyMoney([{ teamId: team.id, amount: -r.cost, reason: "evolve", ref: `${r.from}→${r.to}` }]);
      this.writeInventory(acc.id, before, r.inventory);
      return { cost: r.cost, from: r.from, to: r.to, money: this.money(acc.id), parts: this.accounts.inventory(acc.id) };
    });
  }

  /** 限界設計図で段階 5 の部品の限界を超える (5+・5++) */
  limitBreak(acc: Account, partId: unknown) {
    return this.act(acc.id, () => {
      const before = this.accounts.inventory(acc.id);
      const r = limitBreak(String(partId ?? ""), before);
      if (!r.ok) throw new ApiError(r.error === "not_found" ? 404 : 400, EVOLVE_ERROR_TEXT[r.error]);
      this.writeInventory(acc.id, before, r.inventory);
      return { from: r.from, to: r.to, parts: this.accounts.inventory(acc.id) };
    });
  }

  /** かけら 10 個を 品 1 つに (count 回) */
  convertShards(acc: Account, shardId: unknown, count: unknown) {
    const n = count === undefined ? 1 : Number(count);
    return this.act(acc.id, () => {
      const before = this.accounts.inventory(acc.id);
      const r = convertShards(before, String(shardId ?? ""), n);
      if (!r.ok) throw new ApiError(400, ITEM_ERROR_TEXT[r.error]);
      this.writeInventory(acc.id, before, r.inventory);
      return { made: r.made, count: r.count, parts: this.accounts.inventory(acc.id) };
    });
  }

  /** 特別指導書を雇っている運転手に使う (伸びしろ +5。1 人に 2 回まで) */
  coachDriver(acc: Account) {
    return this.act(acc.id, () => {
      const pool = this.pool();
      const d = teamDriver(pool, tid(acc.id));
      if (!d) throw new ApiError(400, "先に運転手を雇ってください");
      const before = this.accounts.inventory(acc.id);
      const used = removeItem(before, ITEM_IDS.coachBook, 1);
      if (!used.ok) throw new ApiError(400, ITEM_ERROR_TEXT[used.error]);
      const c = coachDriver(d);
      if (!c.ok) throw new ApiError(400, ITEM_ERROR_TEXT[c.error]);
      this.savePool({ ...pool, drivers: pool.drivers.map((x) => (x.id === d.id ? c.driver : x)) });
      this.writeInventory(acc.id, before, used.inventory);
      return { driverId: d.id, coached: coachedCount(c.driver), potential: c.driver.potential, parts: this.accounts.inventory(acc.id) };
    });
  }

  // ---------------------------------------------------------------- 市場

  private listingView(l: Listing, me: string, names: Map<string, string>, now: number): ListingView {
    const top = topBid(l);
    const item: ListingView["item"] =
      l.item.type === "part"
        ? { type: "part", name: itemName(l.item), partId: l.item.partId, count: l.item.count }
        : { type: "design", name: itemName(l.item), parts: l.item.design.parts.length };
    return {
      id: l.id,
      mine: l.sellerId === me,
      seller: names.get(l.sellerId) ?? "",
      mode: l.mode,
      price: l.price,
      status: l.status === "open" && now >= l.endsAt ? "expired" : l.status,
      endsAt: l.endsAt,
      item,
      bids: l.bids.length,
      top: top?.amount ?? null,
      topMine: top?.teamId === me,
      minNext: minNextBid(l),
      ...(l.finalPrice !== undefined ? { finalPrice: l.finalPrice } : {}),
      ...(l.buyerId === me ? { boughtByMe: true } : {}),
    };
  }

  marketView(acc: Account, type?: string | null) {
    return this.act(acc.id, (now) => {
      const me = tid(acc.id);
      const m = this.market();
      const names = this.teamNames([...m.listings.map((l) => l.sellerId), ...m.supplies.flatMap((s) => [s.supplierId, s.buyerId])]);
      const open = m.listings.filter((l) => l.status === "open" && now < l.endsAt && (!type || l.item.type === type));
      const mine = m.listings.filter((l) => l.sellerId === me || l.buyerId === me || l.bids.some((b) => b.teamId === me));
      const supplies: SupplyView[] = m.supplies
        .filter((s) => s.supplierId === me || s.buyerId === me)
        .map((s) => ({
          id: s.id,
          role: s.supplierId === me ? "supplier" : "buyer",
          other: names.get(s.supplierId === me ? s.buyerId : s.supplierId) ?? "",
          partId: s.partId,
          name: anyPartDef(s.partId)?.name ?? s.partId,
          unitPrice: s.unitPrice,
          maxUnits: s.maxUnits,
          delivered: s.delivered,
          status: s.status,
        }));
      const team = this.teamOf(acc.id);
      return {
        now,
        money: this.money(acc.id),
        held: heldInBids(m, me),
        feeRate: this.feeRate(),
        listings: open.map((l) => this.listingView(l, me, names, now)).sort((a, b) => a.endsAt - b.endsAt),
        mine: mine.map((l) => this.listingView(l, me, names, now)).sort((a, b) => b.endsAt - a.endsAt),
        supplies,
        sellable: {
          // 限界突破の品と 限界を超えた部品 (5+・5++) は売れない (DECISIONS 11/25「市場でも売り買いできない」)
          parts: Object.fromEntries(Object.entries(this.accounts.inventory(acc.id)).filter(([id]) => !isItemId(id) && !anyPartDef(id)?.limit)),
          designs: this.accounts.listDesigns(acc.id).map((d) => ({ id: d.id, name: d.name })),
          /** 研究が終わって作れる部品 (供給の約束に出せる) */
          made: team.research.done.map((id) => researchDef(id)?.part.id).filter((x): x is string => !!x),
        },
        limits: { minHours: MARKET.minDurationMs / 3600_000, maxHours: MARKET.maxDurationMs / 3600_000, defaultHours: MARKET.defaultDurationMs / 3600_000 },
      };
    });
  }

  createListing(acc: Account, b: Record<string, unknown>) {
    const mode = b.mode === "auction" ? "auction" : b.mode === "fixed" ? "fixed" : null;
    if (!mode) throw new ApiError(400, "値段を決めて出すか、競りかを選んでください");
    const price = Number(b.price);
    const hours = b.hours === undefined ? MARKET.defaultDurationMs / 3600_000 : Number(b.hours);
    if (!Number.isFinite(hours)) throw new ApiError(400, "出す長さがおかしいです");
    const raw = (b.item ?? {}) as Record<string, unknown>;
    return this.act(acc.id, (now) => {
      const me = tid(acc.id);
      let item: MarketItem;
      if (raw.type === "part") {
        const partId = String(raw.partId ?? "");
        if (!anyPartDef(partId)) throw new ApiError(400, "その部品はありません");
        if (anyPartDef(partId)?.limit) throw new ApiError(400, "限界を超えた部品は市場に出せません");
        item = { type: "part", partId, count: Number(raw.count ?? 1) };
      } else if (raw.type === "design") {
        const d = this.loadDesign(acc.id, Number(raw.designId));
        if (!d) throw new ApiError(404, "その設計図は見つかりません");
        item = { type: "design", design: d.design };
      } else throw new ApiError(400, "出す物を選んでください");
      const r = createListing(this.market(), me, item, { mode, price, durationMs: Math.round(hours * 3600_000) }, now);
      if (!r.ok) econFail(r.error);
      this.applyItems(r.items);
      this.saveMarket(r.market);
      return { id: r.listing.id };
    });
  }

  buy(acc: Account, listingId: string) {
    return this.act(acc.id, (now) => {
      const me = tid(acc.id);
      const m = this.market();
      const l = m.listings.find((x) => x.id === listingId);
      if (l?.item.type === "design" && this.designCount(acc.id) >= MAX_DESIGNS) throw new ApiError(400, `設計図は ${MAX_DESIGNS} 個までです`);
      const r = buyNow(m, listingId, me, this.money(acc.id), now, this.feeRate());
      if (!r.ok) econFail(r.error);
      this.applyMoney(r.moves);
      this.applyItems(r.items);
      this.saveMarket(r.market);
      this.notify(r.events, r.market);
      return { money: this.money(acc.id) };
    });
  }

  bid(acc: Account, listingId: string, amount: unknown) {
    return this.act(acc.id, (now) => {
      const me = tid(acc.id);
      const r = placeBid(this.market(), listingId, me, Number(amount), this.money(acc.id), now);
      if (!r.ok) econFail(r.error);
      this.applyMoney(r.moves);
      this.saveMarket(r.market);
      this.notify(r.events, r.market);
      return { money: this.money(acc.id) };
    });
  }

  cancelListing(acc: Account, listingId: string) {
    return this.act(acc.id, (now) => {
      const r = cancelListing(this.market(), listingId, tid(acc.id), now);
      if (!r.ok) econFail(r.error);
      this.applyItems(r.items);
      this.saveMarket(r.market);
      return { ok: true };
    });
  }

  offerSupply(acc: Account, b: Record<string, unknown>) {
    const name = typeof b.team === "string" ? b.team : "";
    const buyer = name ? this.row("SELECT id FROM accounts WHERE team_key = ?", nameKey(name)) : undefined;
    if (!buyer) throw new ApiError(404, "そのチーム名は見つかりません");
    return this.act(acc.id, (now) => {
      const team = this.teamOf(acc.id);
      const r = offerSupply(
        this.market(),
        team.id,
        team.research,
        { buyerId: tid(Number(buyer.id)), partId: String(b.partId ?? ""), unitPrice: Number(b.unitPrice), maxUnits: Number(b.maxUnits) },
        this.clock(now),
        now,
      );
      if (!r.ok) econFail(r.error);
      this.saveMarket(r.market);
      this.notify(r.events, r.market);
      return { id: r.contract.id };
    });
  }

  answerSupply(acc: Account, contractId: string, accept: unknown) {
    if (typeof accept !== "boolean") throw new ApiError(400, "受けるか断るかを選んでください");
    return this.act(acc.id, (now) => {
      const r = answerSupply(this.market(), contractId, tid(acc.id), accept, now);
      if (!r.ok) econFail(r.error);
      this.saveMarket(r.market);
      this.notify(r.events, r.market);
      return { ok: true };
    });
  }

  orderSupply(acc: Account, contractId: string, count: unknown) {
    return this.act(acc.id, (now) => {
      const m = this.market();
      const s = m.supplies.find((x) => x.id === contractId);
      if (!s) econFail("not_found");
      if (!this.exists(aid(s.supplierId))) econFail("closed");
      const r = orderSupply(m, contractId, tid(acc.id), Number(count), this.money(acc.id), this.money(aid(s.supplierId)), now, this.feeRate());
      if (!r.ok) econFail(r.error);
      this.applyMoney(r.moves);
      this.applyItems(r.items);
      this.saveMarket(r.market);
      this.notify(r.events, r.market);
      return { money: this.money(acc.id) };
    });
  }

  // ---------------------------------------------------------------- 知らせ

  notices(acc: Account, limit = 50) {
    return this.act(acc.id, () => {
      // 古い知らせを消す
      this.sql.exec("DELETE FROM notices WHERE account_id = ? AND at < ?", acc.id, this.now() - NOTICES_KEEP_MS);
      this.sql.exec(
        "DELETE FROM notices WHERE account_id = ? AND id NOT IN (SELECT id FROM notices WHERE account_id = ? ORDER BY at DESC LIMIT ?)",
        acc.id,
        acc.id,
        NOTICES_KEEP,
      );
      const list: NoticeView[] = this.rows("SELECT id, kind, title, text, at, read FROM notices WHERE account_id = ? ORDER BY at DESC, id LIMIT ?", acc.id, Math.max(1, Math.min(NOTICES_KEEP, limit))).map(
        (r) => ({ id: String(r.id), kind: String(r.kind), title: String(r.title), text: String(r.text), at: Number(r.at), read: Number(r.read) === 1 }),
      );
      return { notices: list, unread: this.unread(acc.id) };
    });
  }

  readNotices(acc: Account) {
    this.sql.exec("UPDATE notices SET read = 1 WHERE account_id = ? AND read = 0", acc.id);
    return { unread: 0 };
  }

  // ---------------------------------------------------------------- 慣れ

  private famMap(who: string): FamiliarityMap {
    const out: FamiliarityMap = {};
    for (const r of this.rows("SELECT track, v, at FROM familiarity WHERE who = ?", who)) out[String(r.track)] = { v: Number(r.v), at: Number(r.at) };
    return out;
  }

  private famRecord(who: string, trackId: string, now: number) {
    const f = recordFamiliarity(this.famMap(who), trackId, now)[trackId];
    this.sql.exec("INSERT INTO familiarity (who, track, v, at) VALUES (?, ?, ?, ?) ON CONFLICT(who, track) DO UPDATE SET v = excluded.v, at = excluded.at", who, trackId, f.v, f.at);
  }

  // ---------------------------------------------------------------- レース (部屋の DO から RPC で)

  /**
   * ネットのレースに入るときのチームの様子: 整備の腕・2 台目 (雇った運転手がいれば)・代走の慣れ。
   * 2 台目の設計図は「2 台目」に決めたもの。決めていない・走れない・部品が足りないときは 1 台目と同じ設計図 (仮)
   */
  raceTeam(accountId: number, design1: CarDesign): JoinTeam {
    return this.act(accountId, (now) => {
      const team = this.teamOf(accountId);
      const out: JoinTeam = { serviceFactor: crewServiceFactor(team.crew), standInFam: familiarityNow(this.famMap(`s:${accountId}`), now) };
      const d = teamDriver(this.pool(), team.id);
      if (d) {
        let design = design1;
        const saved = team.cars.second ? this.loadDesign(accountId, Number(team.cars.second)) : null;
        if (saved && !validateDesign(saved.design).length && designFits(saved.design, this.accounts.inventory(accountId)).ok) design = saved.design;
        out.second = { driverId: d.id, name: driverShortName(d.name), design, driver: { ...d.stats }, ...(d.specs?.length ? { specs: [...d.specs] } : {}), fam: familiarityNow(this.famMap(`d:${d.id}`), now) };
      }
      return out;
    });
  }

  /**
   * レースのあと: 整備の慣れ (2 台のピットの数)・研究 (付けていた部品と道のり)・運転手の育ち・慣れ を残す。同じ raceId は 1 回だけ。
   * accountOf = 1 台目の部屋の id → アカウントの番号
   */
  recordRace(raceId: string, report: TeamRaceReport, accountOf: Readonly<Record<string, number>>): void {
    const now = this.now();
    this.tx(() => {
      if (this.row("SELECT race_id FROM team_races WHERE race_id = ?", raceId)) return;
      this.sql.exec("INSERT INTO team_races (race_id, at) VALUES (?, ?)", raceId, now);
      this.sql.exec("DELETE FROM team_races WHERE at < ?", now - 30 * 24 * 3600_000);
      let pool = this.pool();
      let poolChanged = false;
      for (const t of report.teams) {
        const accountId = accountOf[t.id];
        if (accountId === undefined || !this.exists(accountId)) continue;
        let team = this.teamOf(accountId);
        team = recordPitStops(team, t.car1.pitStops + (t.car2?.pitStops ?? 0));
        team = recordResearchRun(team, t.car1.partIds, t.car1.distM);
        if (t.car2) team = recordResearchRun(team, t.car2.partIds, t.car2.distM);
        this.saveTeam(team);
        if (t.car1.standIn) this.famRecord(`s:${accountId}`, report.trackId, now);
        if (t.car2) {
          const d = findDriver(pool, t.car2.driverId);
          if (d && d.contract?.teamId === team.id) {
            pool = recordDriverRace(pool, d.id, {
              position: t.car2.pos,
              cars: report.cars,
              finished: t.car2.finished,
              wallHits: t.car2.wallHits,
              laps: t.car2.lapsDone,
              pitStops: t.car2.pitStops,
            });
            poolChanged = true;
          }
          this.famRecord(`d:${t.car2.driverId}`, report.trackId, now);
        }
      }
      if (poolChanged) this.savePool(pool);
    });
  }

  // ---------------------------------------------------------------- 走る前の準備 (代走が使う)

  /** 遊ぶ人の最後の走る前の準備を残す (画面がレースのときと変えたときに送る)。代走 (リーグ戦) が使う */
  setRaceSetup(acc: Account, raw: unknown): { setup: RaceSetupPref } {
    const setup = cleanSetupPref(raw);
    if (!setup) throw new ApiError(400, "準備が読めません");
    this.sql.exec(
      "INSERT INTO race_setup (account_id, body, at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET body = excluded.body, at = excluded.at",
      acc.id,
      JSON.stringify(setup),
      this.now(),
    );
    return { setup };
  }

  /** 残してある走る前の準備 (なければ null = コンピューターが決める) */
  raceSetup(accountId: number): RaceSetupPref | null {
    const r = this.row("SELECT body FROM race_setup WHERE account_id = ?", accountId);
    if (!r) return null;
    try {
      return cleanSetupPref(JSON.parse(String(r.body)));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- 季節の締め (season.ts から)

  /**
   * 総合のコンストラクターズチャンピオンのごほうび: 珍しい運転手を 1 人、ただで契約できるようにする
   * (次の季節の終わりまで。DRIVERS.prizeSeasons)。同じ季節は 1 回だけ。知らせを出す。ごほうびにした運転手の id (なければ null)
   */
  rarePrize(season: number, teamId: string): string | null {
    const key = `rare_prize:${season}`;
    if (!/^\d+$/.test(teamId)) return null;
    return this.tx(() => {
      if (this.kvGet<string>(key) !== null) return null;
      const r = offerRareDriver(this.pool(), teamId, season, season + DRIVERS.prizeSeasons);
      this.kvPut(key, r?.driverId ?? "");
      if (!r) return null;
      this.savePool(r.pool);
      const d = findDriver(r.pool, r.driverId)!;
      this.sql.exec(
        "INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) VALUES (?, ?, 'driver_prize', ?, ?, ?, 0)",
        Number(teamId),
        `rare_prize:${season}`,
        "珍しい運転手と契約できます",
        `総合のコンストラクターズチャンピオンのごほうび: ${d.name} と ただで契約できます (第 ${season + DRIVERS.prizeSeasons + 1} 季の終わりまで。運転手の画面から)`,
        this.now(),
      );
      return r.driverId;
    });
  }

  /**
   * ドライバーズチャンピオンになった雇った運転手の伸びしろを上げる (DRIVERS.championBonus)。同じ季節は 1 回だけ。
   * 雇っているチームに知らせる。上げた運転手の id を返す
   */
  championBonus(season: number, driverIds: readonly string[]): string[] {
    const key = `champ_bonus:${season}`;
    return this.tx(() => {
      if (this.kvGet<string[]>(key)) return [];
      const pool = this.pool();
      const ids = [...new Set(driverIds)].filter((id) => findDriver(pool, id));
      this.kvPut(key, ids);
      if (!ids.length) return [];
      this.savePool(awardChampionBonus(pool, ids));
      for (const id of ids) {
        const d = findDriver(pool, id)!;
        const teamId = d.contract?.teamId;
        if (!teamId || !/^\d+$/.test(teamId)) continue;
        this.sql.exec(
          "INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) VALUES (?, ?, 'driver_bonus', ?, ?, ?, 0)",
          Number(teamId),
          `champ:${season}:${id}`,
          "運転手がチャンピオンに",
          `${d.name} がドライバーズチャンピオンになり、伸びしろが +${DRIVERS.championBonus} 上がりました (これから育ちます)`,
          this.now(),
        );
      }
      return ids;
    });
  }

  // ---------------------------------------------------------------- 退会

  /** 退会したとき: チーム・運転手の契約 (違約金なし)・出品・供給・知らせ・慣れを片付ける */
  forgetAccount(accountId: number): void {
    const me = tid(accountId);
    const now = this.now();
    this.tx(() => {
      this.sql.exec("DELETE FROM teams WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM notices WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM familiarity WHERE who = ?", `s:${accountId}`);
      this.sql.exec("DELETE FROM race_setup WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM team_gifts WHERE account_id = ?", accountId);
      const pool = this.kvGet<DriverPool>("drivers");
      if (pool?.drivers.some((d) => d.contract?.teamId === me)) {
        this.savePool({ ...pool, drivers: pool.drivers.map((d) => (d.contract?.teamId === me ? { ...d, contract: null } : d)) });
      }
      const m = this.kvGet<MarketState>("market");
      if (!m) return;
      const items: ItemMove[] = [];
      const moves: MoneyMove[] = [];
      const listings = m.listings.map((l) => {
        if (l.status !== "open") return l;
        const top = topBid(l);
        if (l.sellerId === me) {
          // 預かっている競りのお金は返す
          if (top) moves.push({ teamId: top.teamId, amount: top.amount, reason: "bid_refund", ref: l.id });
          return { ...l, status: "cancelled" as const, closedAt: now };
        }
        if (top?.teamId === me) {
          // 一番の値を入れた人がいなくなった: 出品をやめて部品を売る人に戻す
          if (l.item.type === "part") items.push({ teamId: l.sellerId, item: l.item, change: "add" });
          return { ...l, status: "cancelled" as const, closedAt: now };
        }
        return l;
      });
      const supplies = m.supplies.map((s) => ((s.supplierId === me || s.buyerId === me) && (s.status === "active" || s.status === "offered") ? { ...s, status: "ended" as const } : s));
      this.applyMoney(moves, false);
      this.applyItems(items, false);
      this.saveMarket({ ...m, listings, supplies });
    });
  }
}

// ---------------------------------------------------------------- /api/team|drivers|research|market|notices

const MAX_BODY = 64 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "送るものが大きすぎます");
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下で断る */
  }
  throw new ApiError(400, "送られてきたものが読めません");
}

/** この受け口が受け持つ道 */
export const TEAM_PATH = /^\/api\/(team|drivers|research|market|notices)(\/|$)/;

/**
 * GET  /api/team                        チーム (紋章・2 台・財布・整備・運転手・研究の進み・知らせの数)
 * PUT  /api/team/emblem                 { emblem }
 * PUT  /api/team/cars                   { slot: "player"|"second", designId?: number|null, design?: CarDesign }
 * POST /api/team/crew                   整備の設備を 1 段上げる
 * PUT  /api/team/setup                  { setup: { tire, fuel, alloc?, tireFor? } } 最後の走る前の準備 (代走が使う)
 * GET  /api/drivers                     空いている運転手と自分の運転手
 * POST /api/drivers/hire                { driverId } (今の運転手がいれば違約金を払って入れ替え)
 * POST /api/drivers/release             手放す (違約金)
 * PUT  /api/drivers/renew               { renew: boolean } 季節の切れ目に続けるか
 * GET  /api/research                    研究の木・進み
 * POST /api/research/start|cancel       { researchId }
 * POST /api/research/manufacture        { partId, count }
 * GET  /api/research/evolution          進化の道すじ・限界を超えられる部品・品・運転手の指導の回数
 * POST /api/research/evolve             { recipeId } 部品を進化 (お金 + 済んだ研究。1 つ出て 1 つ入る)
 * POST /api/research/limit              { partId } 限界設計図で 5+・5++ に
 * POST /api/team/items/convert          { shard, count? } かけら 10 個 → 品 1 つ
 * POST /api/team/items/coach            特別指導書を雇った運転手に (伸びしろ +5)
 * GET  /api/market?type=part|design     出品・自分の出品と競り・供給の約束
 * POST /api/market/list                 { item: {type:"part",partId,count}|{type:"design",designId}, mode: "fixed"|"auction", price, hours }
 * POST /api/market/L1/buy|bid|cancel    bid は { amount }
 * POST /api/market/supply/offer         { team (チーム名), partId, unitPrice, maxUnits }
 * POST /api/market/supply/S1/answer     { accept: boolean }
 * POST /api/market/supply/S1/order      { count }
 * GET  /api/notices                     知らせ (新しい順) と まだ見ていない数
 * POST /api/notices/read                全部見たことにする
 * どれもログインが要る。投げた ApiError は api.ts の handleApi が受けて返す
 */
export async function handleTeamApi(req: Request, path: string, method: string, accounts: AccountStore, team: TeamStore): Promise<Response> {
  const acc = await accounts.auth(bearer(req));
  if (!acc) throw new ApiError(401, "ログインしてください");
  const url = new URL(req.url);
  const M = method;

  if (path === "/api/team" && M === "GET") return json(team.teamView(acc));
  if (path === "/api/team/emblem" && M === "PUT") return json(team.setEmblem(acc, (await body(req)).emblem));
  if (path === "/api/team/cars" && M === "PUT") {
    const b = await body(req);
    return json(team.setCar(acc, b.slot, b));
  }
  if (path === "/api/team/crew" && M === "POST") return json(team.upgradeCrew(acc));
  if (path === "/api/team/setup" && M === "PUT") return json(team.setRaceSetup(acc, (await body(req)).setup));

  if (path === "/api/drivers" && M === "GET") return json(team.driversView(acc));
  if (path === "/api/drivers/hire" && M === "POST") return json(team.hire(acc, (await body(req)).driverId));
  if (path === "/api/drivers/release" && M === "POST") return json(team.release(acc));
  if (path === "/api/drivers/renew" && M === "PUT") return json(team.setRenew(acc, (await body(req)).renew));

  if (path === "/api/research" && M === "GET") return json(team.researchView(acc));
  if (path === "/api/research/start" && M === "POST") return json(team.startResearch(acc, (await body(req)).researchId));
  if (path === "/api/research/cancel" && M === "POST") return json(team.cancelResearch(acc, (await body(req)).researchId));
  if (path === "/api/research/evolution" && M === "GET") return json(team.evolutionView(acc));
  if (path === "/api/research/evolve" && M === "POST") return json(team.evolve(acc, (await body(req)).recipeId));
  if (path === "/api/research/limit" && M === "POST") return json(team.limitBreak(acc, (await body(req)).partId));
  if (path === "/api/team/items/convert" && M === "POST") {
    const b = await body(req);
    return json(team.convertShards(acc, b.shard, b.count));
  }
  if (path === "/api/team/items/coach" && M === "POST") return json(team.coachDriver(acc));
  if (path === "/api/research/manufacture" && M === "POST") {
    const b = await body(req);
    return json(team.manufacture(acc, b.partId, b.count));
  }

  if (path === "/api/market" && M === "GET") {
    const t = url.searchParams.get("type");
    return json(team.marketView(acc, t === "part" || t === "design" ? t : null));
  }
  if (path === "/api/market/list" && M === "POST") return json(team.createListing(acc, await body(req)), 201);
  if (path === "/api/market/supply/offer" && M === "POST") return json(team.offerSupply(acc, await body(req)), 201);
  const sm = /^\/api\/market\/supply\/(S\d{1,9})\/(answer|order)$/.exec(path);
  if (sm && M === "POST") {
    const b = await body(req);
    return json(sm[2] === "answer" ? team.answerSupply(acc, sm[1], b.accept) : team.orderSupply(acc, sm[1], b.count));
  }
  const lm = /^\/api\/market\/(L\d{1,9})\/(buy|bid|cancel)$/.exec(path);
  if (lm && M === "POST") {
    if (lm[2] === "buy") return json(team.buy(acc, lm[1]));
    if (lm[2] === "cancel") return json(team.cancelListing(acc, lm[1]));
    return json(team.bid(acc, lm[1], (await body(req)).amount));
  }

  if (path === "/api/notices" && M === "GET") return json(team.notices(acc));
  if (path === "/api/notices/read" && M === "POST") return json(team.readNotices(acc));
  throw new ApiError(404, "ありません");
}
