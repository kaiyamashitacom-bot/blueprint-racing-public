// オーバーテイクモード (DECISIONS 11/25「オーバーテイクモード」)。DRS (drs.ts) は残したまま、別に足す。
// DRS は空気の抵抗を減らす (まっすぐで速い)。オーバーテイクモードはエンジンの力を足す (立ち上がりで速い)。
// - スタートの線 (計測点) で前の車と OT_GAP 秒以内なら、次の 1 周で使える。周ごとに OT_ENERGY 秒ぶんの目盛り
// - ボタンを押している間 (アクセルを踏んでいる間) だけ減る。周をまたいで持ち越さない
// - 使っている間は燃料とタイヤが少し多く減る
// - 1 周目・旗と先導車のあと 15 秒は使えない (レースが enabled で決める)。雨でも使える
// 決まった計算。画面 (人の車) とサーバー (コンピューターの車) が同じ関数を呼ぶ。数は全部 (仮)。
import type { CarState } from "./physics.ts";
import type { Track } from "./track.ts";

export interface OvertakeState {
  /** この周で使える (スタートの線で前と OT_GAP 秒以内だった) */
  armed: boolean;
  /** この周に残っている目盛り (秒) */
  energy: number;
  /** 今の刻みで使っている (力が出ている) */
  active: boolean;
  /** レースが今使ってよいと言っている (旗・1 周目・再開のあと 15 秒) */
  ok: boolean;
  /** 最後にスタートの線を越えたときの、前の車との差 (秒。前に誰もいなければ Infinity) */
  gap: number;
}

/** 前の車との差がこれ以内なら使える (秒) */
export const OT_GAP = 1.0;
/** 1 周の目盛り (力を足せる秒) */
export const OT_ENERGY = 5;
/** 使っている間の力の上がり分 (割合) */
export const OT_POWER = 0.2;
/** 使っている間に余分に使う燃料 (L / 秒) と タイヤのすり減り (/ 秒) */
export const OT_FUEL = 0.04;
export const OT_WEAR = 0.001;
/** 再開してから使えるまでの秒 (DRS と同じ) */
export const OT_AFTER_GREEN = 15;
/** コンピューター: 前の車がこの距離 (m) までにいて、横のずれがこの幅の中なら使う */
export const OT_BOT_RANGE = 45;
export const OT_BOT_WIDTH = 7;

/** 1 周の目盛り (秒)。電池の部品 (car.otExtra) の分だけ多い */
export function otEnergyMax(car: Pick<CarState, "otExtra">): number {
  const x = car.otExtra;
  return OT_ENERGY + (typeof x === "number" && x > 0 && Number.isFinite(x) ? Math.min(10, x) : 0);
}

export function newOvertakeState(): OvertakeState {
  return { armed: false, energy: 0, active: false, ok: false, gap: Infinity };
}

const mod = (v: number, L: number) => ((v % L) + L) % L;

/**
 * 毎刻み stepCar のあとに呼ぶ。prevDist = その刻みの前の道のり、others = ほかの車の道のり (ピット・ゴール・リタイアは除く)。
 * enabled = レースが今オーバーテイクを許しているか (racecontrol.ts の ot)。
 * スタートの線を越えて周を終えたら (1 周目のスタートは数えない)、前の車との差で次の周に使えるかを決め、目盛りを満たす (持ち越さない)
 */
export function updateOvertake(car: CarState, track: Track, prevDist: number, others: readonly number[], enabled: boolean): void {
  const st = (car.ot ??= newOvertakeState());
  const L = track.length;
  st.ok = enabled && !car.pit;
  if (!st.ok) st.active = false;
  if (car.dist > prevDist && car.dist >= L && Math.floor(prevDist / L) < Math.floor(car.dist / L)) {
    let ahead = Infinity;
    for (const o of others) {
      const g = mod(o - car.dist, L);
      if (g > 0.5 && g < ahead) ahead = g;
    }
    const v = Math.max(10, Math.hypot(car.vx, car.vy));
    st.gap = ahead / v;
    st.armed = enabled && !car.pit && st.gap <= OT_GAP;
    st.energy = st.armed ? otEnergyMax(car) : 0;
    st.active = false;
  }
}

/** 今使えるか (ボタンを光らせる) */
export function overtakeAvailable(car: CarState): boolean {
  const st = car.ot;
  return !!st && st.ok && st.armed && st.energy > 0 && !car.pit;
}

/** 残りの目盛り 0..1 (画面用。この周に使えなければ 0) */
export function overtakeGauge(car: CarState): number {
  const st = car.ot;
  return st && st.armed ? Math.max(0, Math.min(1, st.energy / otEnergyMax(car))) : 0;
}

/**
 * stepCar の中で呼ぶ: want = ボタンを押していてアクセルを踏んでいる。使えるなら目盛りを dt 減らし、力の倍率を返す (使わなければ 1)。
 * active もここで決める
 */
export function overtakeBoost(car: CarState, want: boolean, dt: number): number {
  const st = car.ot;
  if (!st) return 1;
  st.active = false;
  if (!want || !overtakeAvailable(car)) return 1;
  st.active = true;
  st.energy = Math.max(0, st.energy - dt);
  return 1 + OT_POWER;
}
