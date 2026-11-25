// ピットの作業の音 (ホイールガン・燃料のホース) のための数を RaceFrame に書く (view.ts の音の入れ物へ。車は読むだけ)。
// 作業の秒は shared/src/pit.ts の serviceTime と同じ分け方: タイヤ = 基本 + 1 輪ごと、燃料 = 入れる量 × 1 L の秒、整備の組の腕を掛ける
import { PIT_FUEL_PER_L, PIT_TIRE_BASE, PIT_TIRE_PER, fuelToAdd, tireChangeable, type CarState, type CarStats } from "@bpr/shared";
import type { RaceFrame } from "./race.ts";

export function pitWork(car: CarState, stats: CarStats, f: RaceFrame): void {
  const run = car.pit;
  const order = car.pitOrder;
  f.tires = Math.max(1, stats.tireCount ?? 4);
  if (!run || run.phase !== "box" || !order) {
    f.pitT = 0;
    f.pitTire = 0;
    f.pitFuel = 0;
    return;
  }
  const k = car.serviceFactor !== undefined && Number.isFinite(car.serviceFactor) ? car.serviceFactor : 1;
  f.pitT = run.elapsed;
  f.pitTire = tireChangeable(car, order) ? (PIT_TIRE_BASE + PIT_TIRE_PER * f.tires) * k : 0;
  f.pitFuel = fuelToAdd(car, stats, order) * PIT_FUEL_PER_L * k;
}
