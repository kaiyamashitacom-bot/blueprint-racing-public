// 見本の車 (はじめの部品の箱だけで作れる) と、コンピューター (NPC) の車
import type { CarDesign, Placed } from "./design.ts";

const P = (id: string, c: number, r: number, rot: 0 | 1 = 0): Placed => ({ id, c, r, rot });

/** 見本の車: はじめての人の案内に使う。部品の箱の中身だけでできている */
export const SAMPLE_DESIGN: CarDesign = {
  name: "見本の車",
  parts: [
    P("wing_s1", 2, 0),
    P("tire_n1", 1, 1),
    P("frame", 2, 1),
    P("seat", 3, 1),
    P("frame", 4, 1),
    P("tire_n1", 5, 1),
    P("brake_1", 2, 3),
    P("frame", 3, 3),
    P("brake_1", 4, 3),
    P("eng_m1", 2, 4),
    P("tank_s1", 4, 4),
    P("tire_w1", 0, 7),
    P("frame", 2, 7),
    P("frame", 3, 7),
    P("frame", 4, 7),
    P("tire_w1", 5, 7),
    P("tank_l1", 2, 8),
    P("wing_s1", 2, 10),
  ],
};

function variant(name: string, swap: (parts: Placed[]) => Placed[]): CarDesign {
  return { name, parts: swap(SAMPLE_DESIGN.parts.map((p) => ({ ...p }))) };
}

/**
 * NPC の車。人と同じく、はじめの部品の箱 (段階 1) で作れる物だけ (11/25 「NPC をなんとかして」)。
 * 強さは車と運転の上手さで少しずつ違う。
 */
export const BOT_DESIGNS: readonly CarDesign[] = [
  SAMPLE_DESIGN,
  // 小型エンジンで軽い
  variant("小型号", (ps) => [...ps.map((p) => (p.id === "eng_m1" ? { ...p, id: "eng_s1" } : p)), P("frame", 2, 6), P("frame", 3, 6)]),
  // 後ろの羽根なし・ブレーキ 1 つ (速いが曲がりで滑る)
  variant("身軽号", (ps) => ps.filter((p) => !(p.id === "wing_s1" && p.r === 10) && !(p.id === "brake_1" && p.c === 4))),
  // 前も太いタイヤにはできないので、細いタイヤを 4 本 (握りは少し弱い)
  variant("細足号", (ps) => ps.map((p) => (p.id === "tire_w1" ? { ...p, id: "tire_n1", c: p.c === 0 ? 1 : 5 } : p))),
];

export const BOT_NAMES = ["ハヤテ", "ミナミ", "コウ", "アオイ", "レン", "ツバサ", "ヒカル", "ソラ", "ナギ", "カイト"];
