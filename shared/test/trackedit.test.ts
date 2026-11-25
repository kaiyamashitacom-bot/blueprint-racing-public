// コースづくりの足し (DRS・ピット・路面・縁石・長さの上限・受け取ったコースを読む・みんなのコースを getTrack で引く)
import { describe, expect, it } from "vitest";
import {
  PUB_TRACK_PREFIX,
  TRACK_DEFS,
  TRACK_LIMITS,
  buildTrack,
  checkTrack,
  checkTrackName,
  drsFromFractions,
  drsZones,
  getTrack,
  isPublicTrackId,
  knownTrackDef,
  parseTrackDef,
  registerTrackDef,
  simplifyPath,
  straightAround,
  trackShapeKey,
  type TrackDef,
} from "../src/index.ts";

/** まっすぐ L m 2 本 + 半径 R m の半円 2 つ (指で引いたように点で) */
function stadium(L: number, R: number, n = 1500): Array<[number, number]> {
  const P = 2 * L + 2 * Math.PI * R;
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    let s = (k / n) * P;
    let x: number;
    let y: number;
    if (s < L) [x, y] = [s, 0];
    else if ((s -= L) < Math.PI * R) [x, y] = [L + R * Math.sin(s / R), R - R * Math.cos(s / R)];
    else if ((s -= Math.PI * R) < L) [x, y] = [L - s, 2 * R];
    else {
      s -= L;
      [x, y] = [-R * Math.sin(s / R), R + R * Math.cos(s / R)];
    }
    out.push([x, y]);
  }
  return out;
}

const aozu = TRACK_DEFS[0];
const base = (over: Partial<TrackDef> = {}): TrackDef => ({ ...aozu, id: "t", name: "ためし", drs: undefined, pit: undefined, ...over });
const codes = (def: TrackDef) => checkTrack(def).issues.map((i) => i.code);

describe("長さの上限 (10 km まで、仮)", () => {
  it("10 km 近いコースは通り、組み立ては速い", () => {
    const pts = simplifyPath(stadium(3900, 300));
    expect(pts.length).toBeLessThanOrEqual(TRACK_LIMITS.maxPoints);
    const def: TrackDef = { id: "long", name: "ながい", halfWidth: 7, runoff: 8, points: pts };
    const t0 = Date.now();
    const c = checkTrack(def);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(c.issues).toEqual([]);
    expect(c.track!.length).toBeGreaterThan(9000);
    expect(c.track!.length).toBeLessThanOrEqual(TRACK_LIMITS.maxLength);
  });

  it("10 km を超えると長すぎ", () => {
    const pts = simplifyPath(stadium(4400, 300));
    expect(codes({ id: "x", name: "x", halfWidth: 7, runoff: 8, points: pts })).toContain("length");
  });
});

describe("DRS の区間", () => {
  it("書かなければ長い直線から決める。空なら DRS なし", () => {
    expect(codes(base())).toEqual([]);
    expect(drsZones(buildTrack(base())).length).toBeGreaterThan(0);
    expect(drsZones(buildTrack(base({ drs: [] })))).toEqual([]);
    expect(codes(base({ drs: [] }))).toEqual([]);
  });

  it("短すぎ・多すぎ・重なり・検知の線の位置はだめ", () => {
    expect(codes(base({ drs: [{ start: 20, end: 60 }] }))).toContain("drs");
    expect(codes(base({ drs: [{ start: 20, end: 200 }, { start: 150, end: 250 }] }))).toContain("drs");
    expect(codes(base({ drs: [{ start: 20, end: 200, detect: 15 }] }))).toContain("drs");
    const four = [0, 1, 2, 3].map((k) => ({ start: k * 300, end: k * 300 + 100 }));
    expect(codes(base({ drs: four }))).toContain("drs");
    expect(codes(base({ drs: [{ start: 20, end: 220 }] }))).toEqual([]);
  });

  it("割合から m に (形を変えても区間がついて来る)", () => {
    expect(drsFromFractions([[0.1, 0.3]], 2000)).toEqual([{ start: 200, end: 600 }]);
    // スタートの線をまたぐ
    expect(drsFromFractions([[0.9, 0.05]], 2000)).toEqual([{ start: 1800, end: 2100 }]);
  });

  it("たたいた所の直線を探す (曲がりの中は null)", () => {
    const t = buildTrack(base());
    const st = straightAround(t, 100)!;
    expect(st.start).toBeLessThanOrEqual(100);
    expect(st.end).toBeGreaterThan(200);
    let corner = -1;
    for (let i = 0; i < t.n; i++) if (Math.abs(t.curv[i]) > 1 / 60) corner = i;
    expect(straightAround(t, corner * t.step)).toBeNull();
  });
});

describe("ピット", () => {
  it("入り口・止まる所・出口の順と範囲", () => {
    expect(codes(base({ pit: { side: 1, entry: -100, box: 15, exit: 110 } }))).toEqual([]);
    expect(codes(base({ pit: { entry: -20 } }))).toContain("pit");
    expect(codes(base({ pit: { exit: 500 } }))).toContain("pit");
    expect(codes(base({ pit: { entry: -100, box: -90, exit: 110 } }))).toContain("pit");
    expect(codes(base({ pit: { side: 2 as 1 } }))).toContain("pit");
  });

  it("ピットの道の所が曲がりすぎならだめ", () => {
    expect(codes(base({ pit: { entry: -300, box: 15, exit: 300 } }))).toContain("pit");
  });

  it("左右を選べる", () => {
    expect(buildTrack(base({ pit: { side: -1 } })).pit.side).toBe(-1);
    expect(buildTrack(base({ pit: { side: 1 } })).pit.side).toBe(1);
  });
});

describe("路面と縁石", () => {
  it("縁石なしにできる (書かなければあり)", () => {
    expect(buildTrack(base()).kerb.some((k) => k !== 0)).toBe(true);
    expect(buildTrack(base({ kerbs: false })).kerb.every((k) => k === 0)).toBe(true);
  });
  it("路面は今はアスファルトだけ", () => {
    expect(codes(base({ surface: "asphalt" }))).toEqual([]);
    expect(codes(base({ surface: "ice" as "asphalt" }))).toContain("surface");
  });
});

describe("受け取ったコースを読む", () => {
  it("知らない項目は捨て、おかしな形は null", () => {
    const d = parseTrackDef({ ...base({ drs: [{ start: 10.4, end: 200 }], pit: { side: -1, entry: -90 }, kerbs: false }), evil: "<script>" }, "pub:1")!;
    expect(d.id).toBe("pub:1");
    expect((d as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(d.drs).toEqual([{ start: 10, end: 200 }]);
    expect(d.pit).toEqual({ side: -1, entry: -90 });
    expect(d.kerbs).toBe(false);
    expect(parseTrackDef(null)).toBeNull();
    expect(parseTrackDef({ ...base(), points: [[0, "x"]] })).toBeNull();
    expect(parseTrackDef({ ...base(), halfWidth: Infinity })).toBeNull();
    expect(parseTrackDef({ ...base(), pit: { side: 3 } })).toBeNull();
    expect(parseTrackDef({ ...base(), surface: "lava" })).toBeNull();
    expect(parseTrackDef({ ...base(), points: new Array(TRACK_LIMITS.maxPoints * 2 + 1).fill([0, 0]) })).toBeNull();
  });

  it("形の印: 名前と id は見ない。DRS やピットは見る", () => {
    expect(trackShapeKey(base({ name: "a", id: "1" }))).toBe(trackShapeKey(base({ name: "b", id: "2" })));
    expect(trackShapeKey(base())).not.toBe(trackShapeKey(base({ drs: [] })));
    expect(trackShapeKey(base())).not.toBe(trackShapeKey(base({ pit: { side: -1 } })));
    expect(trackShapeKey(base())).toBe(trackShapeKey(base({ kerbs: true })));
  });

  it("名前の決まり", () => {
    expect(checkTrackName("わたしの道")).toBeNull();
    expect(checkTrackName("  ")).toMatch(/名前/);
    expect(checkTrackName("公式コース")).toMatch(/公式/);
    expect(checkTrackName("公式コース", true)).toBeNull();
    expect(checkTrackName("<b>")).toMatch(/</);
    expect(checkTrackName("あ".repeat(TRACK_LIMITS.maxName + 1))).toMatch(/字まで/);
  });
});

describe("みんなのコースを getTrack で引く", () => {
  it("入れる前は 1 本目の公式、入れたあとはそのコース", () => {
    const id = `${PUB_TRACK_PREFIX}9999`;
    expect(isPublicTrackId(id)).toBe(true);
    expect(isPublicTrackId("aozu")).toBe(false);
    expect(getTrack(id).def.id).toBe(TRACK_DEFS[0].id);
    registerTrackDef({ ...base({ name: "みんなの" }), id, points: aozu.points.map(([x, y]) => [x * 1.2, y * 1.2]) });
    expect(knownTrackDef(id)?.name).toBe("みんなの");
    expect(getTrack(id).def.id).toBe(id);
    expect(getTrack(id).length).toBeGreaterThan(getTrack("aozu").length * 1.1);
    // 公式の id は上書きできない
    registerTrackDef({ ...base(), id: "aozu", name: "にせもの" });
    expect(getTrack("aozu").def.name).toBe(aozu.name);
  });
});
