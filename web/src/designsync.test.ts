// 設計図をサーバーと合わせる決まり (designsync.ts)
import { describe, expect, it } from "vitest";
import { adoptOwner, designKey, markRejected, markUploaded, mergeDesigns, newSyncState, noteLocalEdits, type ServerDesign, type SyncDesign } from "./designsync.ts";

const car = (name: string, c = 0, rid?: string): SyncDesign => ({ name, parts: [{ id: "seat", c, r: 0, rot: 0 }], ...(rid ? { rid } : {}) });
let n = 0;
const rid = () => `r${++n}`;
const srv = (id: number, d: SyncDesign, updatedAt: number): ServerDesign => ({ id, name: d.name, design: { name: d.name, parts: d.parts }, updatedAt });

describe("設計図をサーバーと合わせる", () => {
  it("はじめてのログイン: この機械の設計図を送り、サーバーにしかないものを足す。同じ中身はつなぐ", () => {
    const designs = [car("1 号車", 0, "a"), car("2 号車", 1, "b")];
    const st = newSyncState();
    adoptOwner(designs, st, "alice");
    noteLocalEdits(designs, st, 100);
    const server = [srv(7, car("2 号車", 1), 50), srv(8, car("よそ", 3), 60)];
    const r = mergeDesigns(designs, st, server, rid);
    expect(r.ops).toEqual([{ kind: "post", rid: "a" }]);
    expect(r.added).toBe(1);
    expect(designs.map((d) => d.name)).toEqual(["1 号車", "2 号車", "よそ"]);
    expect(st.meta.b.sid).toBe(7);
    markUploaded(st, "a", designs[0], { id: 9, updatedAt: 110 });
    // もう一度合わせても何もしない
    const again = mergeDesigns(designs, st, [...server, srv(9, designs[0], 110)], rid);
    expect(again).toEqual({ ops: [], added: 0, updated: 0 });
  });

  it("この機械で直したら上書き、サーバーで直されたら取ってくる。両方なら新しい方", () => {
    const designs = [car("x", 0, "a")];
    const st = newSyncState();
    adoptOwner(designs, st, "alice");
    noteLocalEdits(designs, st, 100);
    mergeDesigns(designs, st, [], rid);
    markUploaded(st, "a", designs[0], { id: 1, updatedAt: 100 });
    // この機械で直した
    designs[0].parts[0].c = 2;
    noteLocalEdits(designs, st, 200);
    expect(mergeDesigns(designs, st, [srv(1, car("x", 0), 100)], rid).ops).toEqual([{ kind: "put", rid: "a", sid: 1 }]);
    markUploaded(st, "a", designs[0], { id: 1, updatedAt: 210 });
    // ほかの機械で直された (この機械は変えていない)
    const r = mergeDesigns(designs, st, [srv(1, car("x", 5), 300)], rid);
    expect(r.updated).toBe(1);
    expect(designs[0].parts[0].c).toBe(5);
    // 両方で直した: この機械の方が新しければ上書き、古ければ取ってくる
    designs[0].parts[0].c = 6;
    noteLocalEdits(designs, st, 500);
    expect(mergeDesigns(designs, st, [srv(1, car("x", 7), 400)], rid).ops).toEqual([{ kind: "put", rid: "a", sid: 1 }]);
    expect(designs[0].parts[0].c).toBe(6);
    expect(mergeDesigns(designs, st, [srv(1, car("x", 8), 600)], rid).updated).toBe(1);
    expect(designs[0].parts[0].c).toBe(8);
  });

  it("サーバーで消えたものはこの機械に残し、直すまで送らない。この機械で捨てたものはサーバーからも消す", () => {
    const designs = [car("x", 0, "a"), car("y", 1, "b")];
    const st = newSyncState();
    adoptOwner(designs, st, "alice");
    noteLocalEdits(designs, st, 1);
    mergeDesigns(designs, st, [srv(1, designs[0], 1), srv(2, designs[1], 1)], rid);
    // サーバーで 1 が消えた
    let r = mergeDesigns(designs, st, [srv(2, designs[1], 1)], rid);
    expect(r.ops).toEqual([]);
    expect(designs).toHaveLength(2);
    expect(st.meta.a.sid).toBeUndefined();
    designs[0].name = "x2";
    noteLocalEdits(designs, st, 5);
    expect(mergeDesigns(designs, st, [srv(2, designs[1], 1)], rid).ops).toEqual([{ kind: "post", rid: "a" }]);
    // この機械で 2 を捨てた
    designs.splice(1, 1);
    noteLocalEdits(designs, st, 6);
    expect(st.gone).toEqual([2]);
    r = mergeDesigns(designs, st, [srv(2, car("y", 1), 1)], rid);
    expect(r.ops).toContainEqual({ kind: "delete", sid: 2 });
    expect(r.added).toBe(0);
  });

  it("断られた中身は直すまで送り直さない。別の人がログインしたら前の人とのつながりを切る", () => {
    const designs = [car("x", 0, "a")];
    const st = newSyncState();
    adoptOwner(designs, st, "alice");
    noteLocalEdits(designs, st, 1);
    mergeDesigns(designs, st, [], rid);
    markRejected(st, "a", designs[0], 400);
    expect(mergeDesigns(designs, st, [], rid).ops).toEqual([]);
    designs[0].parts[0].c = 1;
    noteLocalEdits(designs, st, 2);
    expect(mergeDesigns(designs, st, [], rid).ops).toEqual([{ kind: "post", rid: "a" }]);
    markUploaded(st, "a", designs[0], { id: 3, updatedAt: 2 });
    adoptOwner(designs, st, "bob");
    expect(st.meta.a.sid).toBeUndefined();
    expect(st.meta.a.key).toBe(designKey(designs[0]));
    const r = mergeDesigns(designs, st, [srv(10, car("bob の車", 4), 9)], rid);
    expect(r.ops).toEqual([]);
    expect(r.added).toBe(1);
  });
});
