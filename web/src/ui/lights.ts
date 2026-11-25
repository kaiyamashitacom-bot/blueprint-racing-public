// 練習と 1 周アタックのスタートの信号を短くする (11/25 遊んだ人「走るたびに信号を 7 秒待つ」)。
// 信号の 5 つの灯りは view.ts が信号の時計で 1 秒ごとに点けるので、合図 (0 秒) までは時計を QUICK_LIGHTS_RATE 倍で進める。
// 合図からあとは普通の速さ (反応の時間・周の時間はそのまま)。待つのは約 3 秒 (仮)。ネットのレースはサーバーの時計なので使わない
export const QUICK_LIGHTS_RATE = 2;

/**
 * 短い信号の時計。now = 今の時刻 (ms。止められる時計を渡してもよい)。
 * 返す clock は合図からの秒 (前はマイナス)、lightsStartT は 1 つ目の灯りが点く時刻 (信号の時計)
 */
export function quickLightsClock(now: () => number = () => performance.now()): { lightsStartT: number; clock: () => number } {
  // 全部点いてから消えるまでの間 (信号の時計で 0.2〜1.0 秒、毎回変わる)
  const hold = 0.2 + Math.random() * 0.8;
  const lightsStartT = -(5 + hold);
  // 灯りが点く前の「まもなくスタート」(信号の時計で)
  const lead = 0.6;
  const preReal = (-lightsStartT + lead) / QUICK_LIGHTS_RATE;
  const t0 = now();
  return {
    lightsStartT,
    clock: () => {
      const r = (now() - t0) / 1000;
      return r < preReal ? (r - preReal) * QUICK_LIGHTS_RATE : r - preReal;
    },
  };
}
