// 無線の作戦係 (DECISIONS 順番 2 の追加「雨の予報・前の車のタイヤなどを知らせてピットの判断を助ける」)。
// レース中の様子 (RadioSituation、ふつうの値だけ) と前の状態から、新しい無線と次の状態を返す。
// - 大事なものから 1 つずつ (priority の大きい順)
// - 同じ知らせは間をあける (種類ごとの cooldown・同じ中身は一度だけ)・無線どうしも間をあける (MIN_GAP。急ぎは別)
// - タイヤの知らせは 1 本にまとめ、強まるときだけ言い直す (60% → ゴールまで持たない → 80%)
// - DRS・オーバーテイクの知らせは 1 つのタイヤで走る間 (スティント) に相手ごと 1 回まで、まとめて間をあける
// - ピットの判断に使う無線には、すすめるピットの中身 (タイヤ・燃料・修理) を付ける。画面の「そうする」で予約できる
// ここは計算だけ (Math.random・時計を使わない)。同じ入力なら同じ無線。数は全部 (仮)。
import { chooseDryTire } from "./bot.ts";
import type { PitOrder } from "./pit.ts";
import type { FlagMode } from "./racecontrol.ts";
import { TIRE_DEFS, bestTireFor, compoundGrip, tireGrip, type TireCompound } from "./tires.ts";
import { pickFromSets, type TireSets } from "./tireset.ts";
import type { ForecastItem } from "./weather.ts";

// ---- 数 (仮) ----

/** 無線どうしの間 (秒)。急ぎでない無線は 20 秒に 1 つまで (QA 2 回目「無線が多い」11/25) */
export const RADIO_MIN_GAP = 20;
/** 急ぎの無線 (priority がこれ以上) は MIN_GAP を待たない。ただし URGENT_GAP はあける */
export const RADIO_URGENT = 85;
export const RADIO_URGENT_GAP = 2;
/** 大事なピットの知らせ (priority がこれ以上。ピットに入るなら今・壊れた・タイヤ 80%) は IMPORTANT_GAP で言える */
export const RADIO_IMPORTANT = 70;
export const RADIO_IMPORTANT_GAP = 10;
/** タイヤの知らせどうしの間 (秒。強まるときだけ) */
export const RADIO_TIRE_GAP = 25;
/** DRS・オーバーテイクの知らせどうしの間 (秒) */
export const RADIO_DRS_FAMILY_GAP = 60;
/** スタート直後は静かに (秒。破裂などの急ぎは別) */
export const RADIO_QUIET_START = 8;
/** 札を見せる秒 (ピットのすすめ付きは長め) */
export const RADIO_TTL = 5;
export const RADIO_TTL_PIT = 9;
/** タイヤの減りを知らせる所 (0..1) */
export const RADIO_WEAR_WARN = 0.6;
export const RADIO_WEAR_PIT = 0.8;
/** 燃料が「あと少し」の周の数 */
export const RADIO_FUEL_LOW_LAPS = 1.5;
/** 雨の予報を伝える見込み (%) */
export const RADIO_RAIN_CHANCE = 50;
/** DRS の差 (秒、drs.ts の DRS_GAP と同じ) */
export const RADIO_DRS_GAP = 1.0;
/** オーバーテイクモードで仕掛けようと言う 前の車との差 (秒) と、そのとき残っていてほしい目盛り (0..1) */
export const RADIO_OT_ATTACK_GAP = 0.6;
export const RADIO_OT_ATTACK_MIN = 0.25;
/** 前の車のタイヤが傷んでいるとみる減り、と その車との差 (秒) */
export const RADIO_RIVAL_WEAR = 0.6;
export const RADIO_RIVAL_GAP = 4;
/** 「ピットに入るなら今」: 入り口まで (1 周の割合) */
export const RADIO_BOX_WINDOW = 0.35;
/** 新しいタイヤの方がこれだけ握るなら、天気に合わないとみる (bot.ts と同じ 7%) */
const WEATHER_GRIP_GAIN = 1.07;
/** タイヤの使い切りの目安 (bot.ts と同じ) */
const WEAR_LIMIT = 0.88;
/** 練習 (周の終わりなし) で燃料をすすめるときの周の数 (view.ts と同じ 5 周) */
const PRACTICE_FUEL_LAPS = 5;

// ---- 入力 ----

/** ほかの車 (前か後ろ)。分からないものは書かない */
export interface RadioRival {
  id: string;
  name?: string;
  /** 自分との差 (秒、いつもプラス) */
  gap: number;
  tire?: TireCompound | null;
  /** タイヤの減りの見積もり (0..1。履いてからの周から出す) */
  wear?: number | null;
  /** 今のタイヤで走った周 */
  tyreLaps?: number | null;
  pitStops?: number | null;
  /** ピットの道の中 */
  inPit?: boolean;
}

/** レース中の様子 (ふつうの値だけ)。画面 (radio-ui.ts) が毎回作る */
export interface RadioSituation {
  /** 信号が消えてからの秒 */
  t: number;
  /** 走り出した (合図のあと) */
  started: boolean;
  finished?: boolean;
  retired?: boolean;
  /** 走り終えた周の数と、レースの周の数 (0 = 練習。ゴールなし) */
  lapsDone: number;
  totalLaps: number;
  /** ゴールまでの周 (端数あり。練習は Infinity) */
  lapsLeft: number;
  /** 1 周の長さ (m) と、およその秒 */
  lapLength: number;
  lapTime: number;
  /** ピットの入り口までの道のり (m。分からなければ なし) */
  toPitEntry?: number | null;
  tire: TireCompound;
  wear: number;
  burst: boolean;
  /** 新品の今のタイヤが持つ周 (setup.ts の tireLifeLaps。すり減り 0.88 まで) */
  tireLife: number;
  /** 持っているタイヤの組 (なし = どれでも履ける) */
  sets?: TireSets | null;
  fuel: number;
  fuelCap: number;
  /** 1 周で使う燃料 (L) */
  fuelPerLap: number;
  /** 今の濡れ具合と、少し先の濡れ具合 */
  wet: number;
  wetSoon: number;
  forecast: readonly ForecastItem[];
  flag?: { mode: FlagMode; ending?: boolean; drs?: boolean } | null;
  pitBooked: boolean;
  inPit: boolean;
  damage?: { damaged: number; broken: number; lost: number } | null;
  /** 次の DRS の区間で使える前の車との差 (秒。使えなければ なし) */
  drsGap?: number | null;
  /** オーバーテイクモード (overtake.ts): この周で使える・今使ってよい・残りの目盛り 0..1。なし = 使えない */
  ot?: { armed: boolean; ok: boolean; energy: number } | null;
  ahead?: RadioRival | null;
  behind?: RadioRival | null;
}

// ---- 出力 ----

export type RadioKey =
  | "burst"
  | "fuel_low"
  | "wrong_tire"
  | "sc_pit"
  | "box_now"
  | "broken"
  | "tire_wear_pit"
  | "fuel_short"
  | "tire_short"
  | "rain_soon"
  | "behind_drs"
  | "ahead_tire"
  | "ahead_pit"
  | "dry_soon"
  | "tire_wear"
  | "damage"
  | "restart"
  | "ahead_drs"
  | "ot_attack"
  | "ot_ready"
  | "last_lap";

/** すすめるピットの中身。label は札に出す短い文 (例「普通 新品・燃料 +6 L」) */
export interface RadioPit {
  order: PitOrder;
  label: string;
}

export interface RadioMessage {
  /** 通し番号 (1 から) */
  id: number;
  key: RadioKey;
  text: string;
  priority: number;
  /** 出した時刻 (信号が消えてからの秒) */
  t: number;
  /** 札を見せる秒 */
  ttl: number;
  pit?: RadioPit | null;
}

export interface RadioState {
  seq: number;
  /** 最後に無線を出した時刻 */
  lastAt: number;
  /** 最後にピットをすすめた時刻 */
  lastPitAt: number;
  /** 種類ごとの、最後に出した時刻と中身の印 */
  said: Partial<Record<RadioKey, { t: number; sig: string }>>;
  /** まとまり (タイヤ・DRS) ごとの、最後に出した時刻と強さ。タイヤを替えると消える */
  fam?: Partial<Record<RadioFamily, { t: number; level: number }>>;
  /** 前に見たもの (タイヤを替えた・燃料を入れた・直した・旗が変わった を見つける) */
  prev: { tire: TireCompound; wear: number; fuel: number; damaged: number; flag: FlagMode } | null;
}

export function newRadioState(): RadioState {
  return { seq: 0, lastAt: -Infinity, lastPitAt: -Infinity, said: {}, fam: {}, prev: null };
}

/** まとめて間をあける知らせ */
export type RadioFamily = "tire" | "drs";
export const RADIO_FAMILY: Readonly<Partial<Record<RadioKey, RadioFamily>>> = {
  tire_wear: "tire",
  tire_short: "tire",
  tire_wear_pit: "tire",
  behind_drs: "drs",
  ahead_drs: "drs",
  ot_attack: "drs",
  ot_ready: "drs",
};

/** 種類ごとの決まり: 大事さ と 同じ種類をまた出すまでの秒 (Infinity = 中身 sig が変わるまで出さない) */
export const RADIO_RULES: Readonly<Record<RadioKey, { priority: number; cooldown: number }>> = {
  burst: { priority: 100, cooldown: Infinity },
  fuel_low: { priority: 95, cooldown: 60 },
  wrong_tire: { priority: 88, cooldown: 60 },
  sc_pit: { priority: 86, cooldown: Infinity },
  box_now: { priority: 80, cooldown: 90 },
  broken: { priority: 75, cooldown: Infinity },
  // タイヤの 3 つは 1 本の知らせ (RADIO_FAMILY)。強まるときだけ言い直す
  tire_wear_pit: { priority: 70, cooldown: Infinity },
  fuel_short: { priority: 65, cooldown: 150 },
  tire_short: { priority: 60, cooldown: Infinity },
  rain_soon: { priority: 58, cooldown: Infinity },
  // DRS・オーバーテイクは 1 つのタイヤで走る間に相手ごと 1 回 (タイヤを替えるとまた言える)
  behind_drs: { priority: 50, cooldown: Infinity },
  ahead_tire: { priority: 45, cooldown: 180 },
  ahead_pit: { priority: 42, cooldown: 120 },
  dry_soon: { priority: 40, cooldown: Infinity },
  tire_wear: { priority: 35, cooldown: Infinity },
  damage: { priority: 32, cooldown: Infinity },
  restart: { priority: 30, cooldown: Infinity },
  ahead_drs: { priority: 28, cooldown: Infinity },
  ot_attack: { priority: 29, cooldown: Infinity },
  ot_ready: { priority: 26, cooldown: Infinity },
  last_lap: { priority: 20, cooldown: Infinity },
};

/** ピットをすすめる種類 (ピットを予約してあれば言わない) */
const PIT_ADVICE: ReadonlySet<RadioKey> = new Set<RadioKey>(["burst", "fuel_low", "fuel_short", "wrong_tire", "sc_pit", "box_now", "broken", "tire_short"]);

/**
 * 最後の周には言わない種類 (急ぎでないタイヤ・燃料・傷の知らせ。もうピットに入っても間に合わない)。
 * 破裂・燃料切れ・天気に合わないタイヤ (RADIO_URGENT 以上) は言う
 */
export const LAST_LAP_QUIET: ReadonlySet<RadioKey> = new Set<RadioKey>(["tire_wear", "tire_wear_pit", "tire_short", "fuel_short", "box_now", "damage"]);

/** 同じ種類で中身が変わったときも、これだけはあける (秒) */
const SAME_KEY_MIN = 20;

/** タイヤ・燃料・修理の印 (状態が変わると種類の記録を消して、また言えるようにする) */
const TIRE_KEYS: RadioKey[] = ["burst", "tire_wear", "tire_wear_pit", "tire_short", "wrong_tire", "box_now", "behind_drs", "ahead_drs", "ot_attack", "ot_ready"];
const FUEL_KEYS: RadioKey[] = ["fuel_low", "fuel_short", "box_now"];
const DAMAGE_KEYS: RadioKey[] = ["broken", "damage"];
const FLAG_KEYS: RadioKey[] = ["sc_pit", "restart"];

export interface RadioCandidate {
  key: RadioKey;
  text: string;
  /** 同じ中身かどうかの印 */
  sig: string;
  priority: number;
  pit?: RadioPit | null;
  /** まとまりの中の強さ (タイヤ: 1 = 60%・2 = ゴールまで持たない・3 = 80%) */
  level?: number;
}

// ---- 見立て ----

const tireKind = (c: TireCompound) => (TIRE_DEFS[c].slick ? "slick" : c);

/** 1 周で減るタイヤの量 */
function wearPerLap(s: RadioSituation): number {
  return WEAR_LIMIT / Math.max(0.5, s.tireLife || 0);
}

/** 今のタイヤで、あと何周 (破裂の手前 0.97 まで) */
export function tireLapsLeft(s: RadioSituation): number {
  if (s.burst) return 0;
  return Math.max(0, (0.97 - s.wear) / wearPerLap(s));
}

/** 燃料で、あと何周 */
export function fuelLapsLeft(s: RadioSituation): number {
  return s.fuel / Math.max(1e-6, s.fuelPerLap);
}

/** 天気に合うタイヤ (合っていれば null) */
export function weatherTire(s: RadioSituation): TireCompound | null {
  const best = bestTireFor(s.wetSoon);
  if (tireKind(best) === tireKind(s.tire)) return null;
  if (compoundGrip(best, s.wetSoon) <= tireGrip({ tire: s.tire, wear: s.wear, burst: s.burst }, s.wetSoon) * WEATHER_GRIP_GAIN) return null;
  return best;
}

export interface PitNeeds {
  /** タイヤを替える理由 */
  tire?: "burst" | "weather" | "wear" | "fresh" | null;
  fuel?: boolean;
  repair?: boolean;
}

/** ピットで直すべきこと (ゴールまでに要るもの) */
export function pitNeeds(s: RadioSituation): PitNeeds {
  const finite = Number.isFinite(s.lapsLeft);
  const wt = weatherTire(s);
  let tire: PitNeeds["tire"] = null;
  if (s.burst) tire = "burst";
  else if (wt && s.lapsLeft > 0.5) tire = "weather";
  else if (finite && s.lapsLeft > 0.6 && s.wear + wearPerLap(s) * s.lapsLeft > 0.97) tire = "wear";
  const fuel = finite ? fuelLapsLeft(s) < s.lapsLeft + 0.15 : fuelLapsLeft(s) < RADIO_FUEL_LOW_LAPS;
  const repair = !!s.damage && s.damage.broken + s.damage.lost > 0;
  return { tire, fuel, repair };
}

const needsAny = (n: PitNeeds) => !!n.tire || !!n.fuel || !!n.repair;

/** ピットでどれだけ燃料を入れるか (view.ts の「残りの分」と同じ見積もり) */
function fuelTarget(s: RadioSituation): number {
  const laps = Number.isFinite(s.lapsLeft) ? s.lapsLeft : PRACTICE_FUEL_LAPS;
  const need = s.fuelPerLap * (laps + 100 / Math.max(1, s.lapLength)) * 1.1 + 1;
  return Math.min(s.fuelCap, Math.ceil(need * 10) / 10);
}

/**
 * すすめるピットの中身。タイヤ: 天気に合う種類か、残りの道のりを持つ一番柔らかい乾いたタイヤ。
 * 持っている組の決まりがあれば その中から (なければ替えない)。燃料: 足りなければ残りの分。傷があれば直す。
 * することがなければ null
 */
export function suggestPit(s: RadioSituation, need: PitNeeds): RadioPit | null {
  const L = Math.max(1, s.lapLength);
  const remainM = (Number.isFinite(s.lapsLeft) ? s.lapsLeft : PRACTICE_FUEL_LAPS) * L;
  let tire: TireCompound | null = null;
  let used: number | null = null;
  if (need.tire) {
    const best = bestTireFor(s.wetSoon);
    const want: TireCompound = TIRE_DEFS[best].slick ? chooseDryTire(remainM, 1, s.wetSoon) : best;
    if (s.sets) {
      const weather = tireKind(want) !== tireKind(s.tire);
      const maxWear = s.burst ? 1 : weather ? 0.7 : Math.max(0, Math.min(0.7, s.wear - 0.15));
      const p = pickFromSets(s.sets, want, maxWear);
      tire = p?.tire ?? null;
      used = p?.used ?? null;
    } else {
      tire = want;
    }
  }
  const fuelTo = need.fuel ? fuelTarget(s) : null;
  const add = fuelTo === null ? 0 : Math.max(0, fuelTo - s.fuel);
  const repair = !!s.damage && s.damage.damaged > 0 && (!!need.repair || !!tire || add > 0);
  if (!tire && add <= 0.05 && !repair) return null;
  const parts: string[] = [];
  if (tire) parts.push(`${TIRE_DEFS[tire].name} ${used === null ? "新品" : `使った組`}`);
  if (add > 0.05) parts.push(`燃料 +${add.toFixed(1)} L`);
  if (repair) parts.push("修理");
  const order: PitOrder = { tire, fuelTo: add > 0.05 ? fuelTo : null, repair };
  if (tire && used !== null) order.used = used;
  return { order, label: parts.join("・") };
}

const SKY_WORD: Record<string, string> = { light: "雨", heavy: "大雨", sun: "晴れ" };

/** 予報の時間を「N 周あとに」「まもなく」にする */
function whenText(inSec: number, lapTime: number): string {
  const laps = inSec / Math.max(5, lapTime);
  if (laps < 0.75) return "まもなく";
  return `${Math.max(1, Math.round(laps))} 周あとに`;
}

const fmtGap = (g: number) => (Math.max(0.1, Math.round(g * 10) / 10)).toFixed(1);

/** 今言えること (大事な順)。止まる・ゴールのあとは なし */
export function radioCandidates(s: RadioSituation): RadioCandidate[] {
  const out: RadioCandidate[] = [];
  if (!s.started || s.finished || s.retired || s.inPit || s.t < 0) return out;
  const finite = Number.isFinite(s.lapsLeft) && s.totalLaps > 0;
  const lastLap = finite && s.lapsLeft <= 1;
  const add = (key: RadioKey, text: string, sig: string, pit?: RadioPit | null, level?: number) => {
    // ピットを予約してあれば、ピットをすすめる無線は言わない (もう決めてある)
    if (s.pitBooked && PIT_ADVICE.has(key)) return;
    if (lastLap && LAST_LAP_QUIET.has(key)) return;
    const c: RadioCandidate = { key, text, sig, priority: RADIO_RULES[key].priority, pit: s.pitBooked ? null : (pit ?? null) };
    if (level !== undefined) c.level = level;
    out.push(c);
  };
  const needs = pitNeeds(s);
  const sugg = (n: PitNeeds) => suggestPit(s, n);
  const fuelLaps = fuelLapsLeft(s);
  const mode = s.flag?.mode ?? "green";

  // 破裂
  if (s.burst) add("burst", "タイヤが破裂。ゆっくりピットへ", "burst", sugg({ ...needs, tire: "burst" }));

  // 燃料
  if (fuelLaps <= RADIO_FUEL_LOW_LAPS && (!finite || fuelLaps < s.lapsLeft)) {
    const text = fuelLaps < 1 ? "燃料がもう 1 周もない。ピットへ" : `燃料はあと ${Math.floor(fuelLaps)} 周。ピットへ`;
    add("fuel_low", text, "low", sugg({ ...needs, fuel: true }));
  } else if (finite && needs.fuel && !lastLap) {
    add("fuel_short", `燃料はあと ${Math.max(1, Math.floor(fuelLaps))} 周。ゴールまで足りない`, "short", sugg(needs));
  }

  // 天気とタイヤ
  const wt = weatherTire(s);
  if (wt && s.lapsLeft > 0.5 && !s.burst) {
    const p = sugg({ ...needs, tire: "weather" });
    // 持っている組に合うタイヤがなければ、そう言う (替えをすすめない)
    const none = !!s.sets && !p?.order.tire;
    const text =
      wt === "W" ? (none ? "雨が強い。大雨用の組はない" : "雨が強い。大雨用に替えよう")
      : wt === "I" ? (none ? "路面が濡れてきた。雨用の組はない" : "路面が濡れてきた。小雨用に替えよう")
      : none ? "乾いてきた。乾いたタイヤの組はない" : "乾いてきた。乾いたタイヤに替えよう";
    add("wrong_tire", text, `${wt}${none ? "-none" : ""}`, p);
  }

  // 旗: VSC・SC の間はピットが安い
  if (mode === "vsc" || mode === "sc") {
    const useful = needsAny(needs) || (s.wear >= 0.4 && (!finite || s.lapsLeft >= 2));
    if (useful && !s.flag?.ending && (!finite || s.lapsLeft > 1)) {
      const p = sugg({ ...needs, tire: needs.tire ?? (s.wear >= 0.4 ? "fresh" : null) });
      if (p) add("sc_pit", mode === "vsc" ? "VSC だ。ピットのチャンス" : "SC だ。ピットのチャンス", mode, p);
    }
    if (s.flag?.ending) add("restart", mode === "vsc" ? "VSC が明ける。準備を" : "この周で再開。準備を", `${mode}-end`);
  }

  // ピットに入るなら今 (入り口が近く、ゴールまでに要るとき)
  if (needsAny(needs) && !s.pitBooked && s.toPitEntry !== null && s.toPitEntry !== undefined) {
    const L = Math.max(1, s.lapLength);
    const after = finite ? s.lapsLeft * L - s.toPitEntry : Infinity;
    const p = sugg(needs);
    if (p && s.toPitEntry > 30 && s.toPitEntry < RADIO_BOX_WINDOW * L && after > L * 0.3) add("box_now", "ピットに入るなら今", "box", p);
  }

  // 傷み
  if (s.damage && s.damage.broken + s.damage.lost > 0) add("broken", s.damage.lost > 0 ? "部品が落ちた。ピットで直せる" : "部品が壊れた。ピットで直せる", `${s.damage.broken}/${s.damage.lost}`, sugg({ ...needs, repair: true }));
  else if (s.damage && s.damage.damaged > 0) add("damage", "傷がある。次のピットで直そう", String(s.damage.damaged));

  // タイヤの減り: 1 本の知らせが強まっていく (いちばん強いものだけ出す)
  // 3 = 減り 80% (ピットのすすめ付き。練習でも)・2 = ゴールまで持たない・1 = 減り 60% (知らせだけ)
  if (!s.burst) {
    const pct = `${Math.floor(s.wear * 10) * 10}%`;
    const left = tireLapsLeft(s);
    if (s.wear >= RADIO_WEAR_PIT) {
      const rest = left < 1 ? "もう 1 周もたない" : `あと ${Math.floor(left)} 周`;
      const p = !finite || s.lapsLeft > 1 ? sugg({ ...needs, tire: needs.tire ?? "wear" }) : null;
      add("tire_wear_pit", `タイヤの減り ${pct}・${rest}`, "3", p, 3);
    } else if (finite && needs.tire === "wear") {
      const head = s.wear >= RADIO_WEAR_WARN ? `タイヤの減り ${pct}・あと` : "タイヤはあと";
      add("tire_short", `${head} ${Math.max(1, Math.floor(left))} 周。ゴールまで持たない`, "2", sugg(needs), 2);
    } else if (s.wear >= RADIO_WEAR_WARN) add("tire_wear", `タイヤの減り ${pct}`, "1", null, 1);
  }

  // 予報 (今のタイヤに関わるものだけ。乾いたタイヤで雨、雨用で晴れ)
  const slick = TIRE_DEFS[s.tire].slick;
  for (const f of s.forecast) {
    if (f.chance < RADIO_RAIN_CHANCE) continue;
    if (finite && f.inSec / Math.max(5, s.lapTime) > s.lapsLeft) continue;
    // 同じ変わり目は一度だけ (予報の時刻を 30 秒の幅でまとめる)
    const sig = `${f.sky}@${Math.round((s.t + f.inSec) / 30)}`;
    if (f.sky !== "sun" && (slick || (f.sky === "heavy" && s.tire === "I")) && s.wet < 0.3 + (f.sky === "heavy" ? 0.4 : 0)) {
      add("rain_soon", `${whenText(f.inSec, s.lapTime)}${SKY_WORD[f.sky]} ${f.chance}%`, sig);
      break;
    }
    if (f.sky === "sun" && !slick) {
      add("dry_soon", `${whenText(f.inSec, s.lapTime)}晴れ ${f.chance}%`, sig);
      break;
    }
  }

  // ほかの車
  const drsOk = !!s.flag?.drs && mode === "green";
  const b = s.behind;
  if (b && drsOk && !b.inPit && b.gap > 0 && b.gap <= RADIO_DRS_GAP) add("behind_drs", `後ろの車が ${fmtGap(b.gap)} 秒差で DRS 圏内`, b.id);
  const a = s.ahead;
  if (a && a.inPit) add("ahead_pit", "前の車がピットに入った", `${a.id}:${a.pitStops ?? ""}`);
  else if (a && a.gap <= RADIO_RIVAL_GAP && (a.wear ?? 0) >= RADIO_RIVAL_WEAR) add("ahead_tire", "前の車のタイヤが傷んでいる", a.id);
  if (drsOk && s.drsGap !== null && s.drsGap !== undefined && s.drsGap >= 0 && s.drsGap <= RADIO_DRS_GAP) add("ahead_drs", `前と ${fmtGap(s.drsGap)} 秒。DRS が使える`, a?.id ?? "drs");
  // オーバーテイクモード (旗の間・1 周目・再開のあとは ok が false)
  const ot = s.ot;
  if (ot && ot.armed && ot.ok && mode === "green" && ot.energy > 0) {
    if (a && !a.inPit && a.gap > 0 && a.gap <= RADIO_OT_ATTACK_GAP && ot.energy >= RADIO_OT_ATTACK_MIN) add("ot_attack", `前の車が ${fmtGap(a.gap)} 秒。オーバーテイクで仕掛けよう`, a.id);
    else if (ot.energy >= 0.99) add("ot_ready", "オーバーテイクが使える", "ready");
  }

  // 最後の周
  if (finite && s.totalLaps >= 2 && s.lapsDone === s.totalLaps - 1) add("last_lap", "最後の周だ。押していこう", "last");

  out.sort((x, y) => y.priority - x.priority);
  return out;
}

function clearKeys(said: RadioState["said"], keys: RadioKey[]) {
  for (const k of keys) delete said[k];
}

/** この種類を今 出してよいか */
function allowed(st: RadioState, c: RadioCandidate, t: number): boolean {
  const fam = RADIO_FAMILY[c.key];
  const f = fam ? st.fam?.[fam] : undefined;
  if (fam && f) {
    // タイヤ: 前より強いときだけ。どちらも まとまりの間をあける
    if (fam === "tire" && (c.level ?? 0) <= f.level) return false;
    if (t - f.t < (fam === "tire" ? RADIO_TIRE_GAP : RADIO_DRS_FAMILY_GAP)) return false;
  }
  const last = st.said[c.key];
  if (!last) return true;
  const since = t - last.t;
  if (since >= RADIO_RULES[c.key].cooldown) return true;
  return c.sig !== last.sig && since >= SAME_KEY_MIN;
}

/**
 * 1 回ぶん: 様子を見て、出す無線 (0 か 1 つ) と次の状態を返す。何度呼んでもよい (画面の表示の刻みごと)。
 * 前の状態は変えない
 */
export function stepRadio(s: RadioSituation, prev: RadioState): { messages: RadioMessage[]; state: RadioState } {
  const st: RadioState = { ...prev, said: { ...prev.said }, fam: { ...(prev.fam ?? {}) } };
  const fam = st.fam!;
  // タイヤを替えた・燃料を入れた・直した・旗が変わった → 関わる種類をまた言えるように
  const damaged = s.damage?.damaged ?? 0;
  const mode = s.flag?.mode ?? "green";
  const p = prev.prev;
  if (p) {
    if (s.tire !== p.tire || s.wear < p.wear - 0.05) {
      // 新しいタイヤ = 新しいスティント。タイヤ・DRS の知らせをまた言える
      clearKeys(st.said, TIRE_KEYS);
      delete fam.tire;
      delete fam.drs;
    }
    if (s.fuel > p.fuel + 0.5) clearKeys(st.said, FUEL_KEYS);
    if (damaged < p.damaged) clearKeys(st.said, DAMAGE_KEYS);
    if (mode !== p.flag) clearKeys(st.said, FLAG_KEYS);
  }
  st.prev = { tire: s.tire, wear: s.wear, fuel: s.fuel, damaged, flag: mode };

  const messages: RadioMessage[] = [];
  const list = radioCandidates(s);
  for (const c of list) {
    if (!allowed(st, c, s.t)) continue;
    // ピットをすすめる無線は、少し前にすすめたばかりなら控える (破裂・燃料切れ・旗は別)
    if (c.pit && c.key === "box_now" && s.t - st.lastPitAt < 20) continue;
    const urgent = c.priority >= RADIO_URGENT;
    const gap = urgent ? RADIO_URGENT_GAP : c.priority >= RADIO_IMPORTANT ? RADIO_IMPORTANT_GAP : RADIO_MIN_GAP;
    if (s.t - st.lastAt < gap) break;
    if (!urgent && s.t < RADIO_QUIET_START) break;
    st.seq++;
    st.lastAt = s.t;
    if (c.pit) st.lastPitAt = s.t;
    st.said[c.key] = { t: s.t, sig: c.sig };
    const fk = RADIO_FAMILY[c.key];
    if (fk) fam[fk] = { t: s.t, level: Math.max(c.level ?? 0, fam[fk]?.level ?? 0) };
    messages.push({ id: st.seq, key: c.key, text: c.text, priority: c.priority, t: s.t, ttl: c.pit ? RADIO_TTL_PIT : RADIO_TTL, pit: c.pit ?? null });
    break;
  }
  return { messages, state: st };
}

// ---- 作戦係の名前 ----

/** 作戦係の名前 (仮。運転手の名前から決まる。いつも同じ) */
export const ENGINEER_NAMES: readonly string[] = ["ミナト", "カサイ", "ヒビキ", "ナギサ", "トウマ", "シオリ"];

export function engineerName(seed: string): string {
  let h = 7;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ENGINEER_NAMES[h % ENGINEER_NAMES.length];
}
