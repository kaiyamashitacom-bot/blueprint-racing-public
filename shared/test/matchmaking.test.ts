import { describe, expect, it } from "vitest";
import {
  CPU_SKILL_RANGE, cpuSeatsFor, cpuSkills, isQuickLaps, JOIN_CUTOFF_MS, joinBlock, listJoinableRooms, pickQuickRoom, quickRoomId, validateCustomRoom,
  type RoomInfo, type Seeker,
} from "../src/matchmaking.ts";

const NOW = 1_000_000;

function room(o: Partial<RoomInfo>): RoomInfo {
  return { id: "r", kind: "quick", cls: 3, laps: 5, trackId: "aozu", open: true, usedSeats: 0, seats: 8, createdAt: 0, closesAt: 0, ...o };
}

const me: Seeker = { teamId: "me", cls: 3 };

describe("すぐ走る", () => {
  it("同じ級・同じ周回数の部屋だけ", () => {
    const rooms = [
      room({ id: "other-class", cls: 2, usedSeats: 6 }),
      room({ id: "other-laps", laps: 10, usedSeats: 6 }),
      room({ id: "custom", kind: "custom", usedSeats: 6 }),
      room({ id: "ok", usedSeats: 2 }),
    ];
    expect(pickQuickRoom(me, 5, rooms, NOW)).toEqual({ action: "join", roomId: "ok" });
  });
  it("一番埋まっている部屋を選び、同じなら古い順", () => {
    const rooms = [room({ id: "a", usedSeats: 2, createdAt: 5 }), room({ id: "b", usedSeats: 4, createdAt: 9 }), room({ id: "c", usedSeats: 4, createdAt: 3 })];
    expect(pickQuickRoom(me, 5, rooms, NOW)).toEqual({ action: "join", roomId: "c" });
  });
  it("2 台分の席が無い・始まった・締まりかけの部屋には入らない", () => {
    expect(joinBlock(me, room({ usedSeats: 7 }), NOW)).toBe("full");
    expect(joinBlock({ ...me, cars: 1 }, room({ usedSeats: 7 }), NOW)).toBeNull();
    expect(joinBlock(me, room({ open: false }), NOW)).toBe("started");
    expect(joinBlock(me, room({ closesAt: NOW + JOIN_CUTOFF_MS - 1 }), NOW)).toBe("closing");
    expect(joinBlock(me, room({ closesAt: NOW + JOIN_CUTOFF_MS }), NOW)).toBeNull();
    expect(joinBlock(me, room({ cls: 4 }), NOW)).toBe("class");
  });
  it("級なしは一番下の級の部屋へ", () => {
    const rooms = [room({ id: "c5", cls: 5 }), room({ id: "c3", cls: 3 })];
    expect(pickQuickRoom({ teamId: "n", cls: null }, 5, rooms, NOW)).toEqual({ action: "join", roomId: "c5" });
  });
  it("入れる部屋が無ければ、使われていない番号で作る", () => {
    const rooms = [room({ id: quickRoomId(3, 2, 0), laps: 2, open: false }), room({ id: quickRoomId(3, 2, 1), laps: 2, usedSeats: 8 })];
    expect(pickQuickRoom(me, 2, rooms, NOW)).toEqual({ action: "create", roomId: "quick-c3-l2-2", cls: 3, laps: 2 });
    expect(pickQuickRoom(me, 10, [], NOW)).toEqual({ action: "create", roomId: "quick-c3-l10-0", cls: 3, laps: 10 });
  });
  it("周回数は 2・5・10 だけ", () => {
    expect([2, 5, 10].every(isQuickLaps)).toBe(true);
    expect(isQuickLaps(3)).toBe(false);
    expect(isQuickLaps("5")).toBe(false);
  });
});

describe("開いた部屋", () => {
  it("同じ級の入れる部屋を古い順に並べる (合言葉なし)", () => {
    const rooms = [
      room({ id: "x", kind: "custom", createdAt: 9 }),
      room({ id: "y", kind: "custom", createdAt: 1 }),
      room({ id: "z", kind: "custom", cls: 1 }),
      room({ id: "q", kind: "quick" }),
    ];
    expect(listJoinableRooms(me, rooms, NOW).map((r) => r.id)).toEqual(["y", "x"]);
  });
  it("部屋を開くときの確かめ", () => {
    expect(validateCustomRoom({ trackId: "aozu", laps: 7, cls: 3 }, me, ["aozu"])).toEqual([]);
    expect(validateCustomRoom({ trackId: "nope", laps: 0, cls: 3 }, me, ["aozu"])).toEqual(["track", "laps"]);
    expect(validateCustomRoom({ trackId: "aozu", laps: 31, cls: 2 }, me)).toEqual(["laps", "host_class"]);
    expect(validateCustomRoom({ trackId: "aozu", laps: 5, cls: 9 as never }, me)).toEqual(["class"]);
    expect(validateCustomRoom({ trackId: "aozu", laps: 5, cls: 5 }, { teamId: "n", cls: null })).toEqual([]);
  });
});

describe("空き埋めのコンピューター", () => {
  it("同じ seed なら同じ・幅の中でばらつく", () => {
    const a = cpuSkills(42, 6, 3);
    expect(cpuSkills(42, 6, 3)).toEqual(a);
    expect(cpuSkills(43, 6, 3)).not.toEqual(a);
    const [lo, hi] = CPU_SKILL_RANGE[3];
    expect(a.every((s) => s >= lo && s <= hi)).toBe(true);
    const sorted = [...a].sort();
    // 層に分けて引くので、下と上の両方が出る
    expect(sorted[0]).toBeLessThan(lo + (hi - lo) / 6);
    expect(sorted[5]).toBeGreaterThan(hi - (hi - lo) / 6);
    expect(cpuSkills(1, 0, 3)).toEqual([]);
  });
  it("上の級ほど強い", () => {
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(avg(cpuSkills(7, 8, 1))).toBeGreaterThan(avg(cpuSkills(7, 8, 5)));
  });
  it("空き席の数", () => {
    expect(cpuSeatsFor(2)).toBe(6);
    expect(cpuSeatsFor(8)).toBe(0);
    expect(cpuSeatsFor(9)).toBe(0);
  });
});
