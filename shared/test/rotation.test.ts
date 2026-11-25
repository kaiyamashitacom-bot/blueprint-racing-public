// リーグ戦 (2 時間ごと) と 1 周アタック (毎週) のコースの回し方は、コースを足しても今の週・今日の枠が変わらない (tracks.ts の TRACK_ROTATION_FROM)。
// 足したコースは決めた先の月曜 0:00 (日本時間) から入り、そこから先の週と枠だけが変わる。
import { describe, expect, it } from "vitest";
import {
  SEASON_MS, TRACK_DEFS, TRACK_ROTATION_FROM, rotationTrackIds, scheduledSlotIndex, scheduledSlotStart, scheduledTrackId, seasonIndexAt, seasonWindow,
  taWeek,
} from "../src/index.ts";

const JST = 9 * 3_600_000;
/** 11/25 に置いたときの回し方 (実在のサーキット 6 本までの 8 本、TRACK_DEFS の順に番号の割り算で回す) */
const BEFORE = ["aozu", "tsuzura", "suzuka", "monaco", "silverstone", "spa", "monza", "interlagos"];
const mod = (i: number, n: number) => ((i % n) + n) % n;

describe("コースの回し方 (足しても今は変わらない)", () => {
  const froms = [...new Set(Object.values(TRACK_ROTATION_FROM))].sort((a, b) => a - b);

  it("回し方に入る時刻は どれも月曜 0:00 (日本時間)。週の切れ目でも日の切れ目 (リーグ戦の枠の始まり) でもある", () => {
    for (const [id, at] of Object.entries(TRACK_ROTATION_FROM)) {
      const d = new Date(at + JST);
      expect(d.getUTCDay(), id).toBe(1);
      expect(d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() + d.getUTCMilliseconds(), id).toBe(0);
      expect(scheduledSlotStart(scheduledSlotIndex(at)), id).toBe(at);
      expect(seasonWindow(seasonIndexAt(at)).startsAt, id).toBe(at);
      expect(TRACK_DEFS.some((d) => d.id === id), id).toBe(true);
    }
  });

  it("入る時刻の前の枠・週は、前の回し方のまま (11/25 から 1 つ目の切れ目まで)", () => {
    const first = froms[0];
    expect(rotationTrackIds(first - 1)).toEqual(BEFORE);
    // 11/25 0:00 (日本時間) から切れ目の前までの 2 時間ごとの枠
    for (let slot = scheduledSlotIndex(Date.UTC(2026, 10, 24, 15)); scheduledSlotStart(slot) < first; slot++) {
      expect(scheduledTrackId(scheduledSlotStart(slot)), `slot ${slot}`).toBe(BEFORE[mod(slot, BEFORE.length)]);
    }
    // 切れ目の前の週 (今の週を含む)
    for (let w = seasonIndexAt(first) - 3; seasonWindow(w).startsAt < first; w++) {
      expect(taWeek(w).trackId, `week ${w}`).toBe(BEFORE[mod(w, BEFORE.length)]);
    }
  });

  it("どの切れ目でも、その前の枠・週は そこで入るコースがなかったときと同じ", () => {
    for (const at of froms) {
      const joining = Object.keys(TRACK_ROTATION_FROM).filter((id) => TRACK_ROTATION_FROM[id] === at);
      const without = (t: number) => rotationTrackIds(t).filter((id) => !joining.includes(id));
      for (let k = 1; k <= 12 * 7; k++) {
        const start = scheduledSlotStart(scheduledSlotIndex(at) - k);
        expect(scheduledTrackId(start)).toBe(scheduledTrackId(start, without(start)));
      }
      const w = seasonIndexAt(at) - 1;
      const ids = without(seasonWindow(w).startsAt);
      expect(taWeek(w).trackId).toBe(ids[mod(w, ids.length)]);
    }
  });

  it("入る時刻からは、全部の公式コースが回し方に入る", () => {
    const last = froms[froms.length - 1];
    const all = TRACK_DEFS.map((d) => d.id);
    expect(rotationTrackIds(last)).toEqual(all);
    const slot0 = scheduledSlotIndex(last);
    const league = new Set(all.map((_, i) => scheduledTrackId(scheduledSlotStart(slot0 + i))));
    const w0 = seasonIndexAt(last);
    const ta = new Set(all.map((_, i) => taWeek(w0 + i).trackId));
    expect([...league].sort()).toEqual([...all].sort());
    expect([...ta].sort()).toEqual([...all].sort());
    // 週は月曜 0:00 から 1 週間 (SEASON_MS)
    expect(taWeek(w0).endsAt - taWeek(w0).startsAt).toBe(SEASON_MS);
  });
});
