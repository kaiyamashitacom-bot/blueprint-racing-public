import { describe, expect, it } from "vitest";
import { TRACK_DEFS, buildTrack, type TrackDef } from "../src/index.ts";
import { TRACK_LIMITS, checkTrack, controlFractions, cornerNeedText, simplifyPath, tidyTrack, wallsFromSegments } from "../src/trackcheck.ts";

const base: Omit<TrackDef, "points"> = { id: "t", name: "ためし", halfWidth: 7, runoff: 8 };

/** 角を丸めた長方形 (まっすぐ L m 2 本 + 半径 R m の半円 2 つ) を、指で引いたように点で */
function stadium(L: number, R: number, noise = 0, n = 400): Array<[number, number]> {
  let r = 7;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5) * noise;
  const P = 2 * L + 2 * Math.PI * R;
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n * 1.04; k++) {
    let s = ((k / n) * P) % P;
    let x: number;
    let y: number;
    if (s < L) [x, y] = [s, 0];
    else if ((s -= L) < Math.PI * R) [x, y] = [L + R * Math.sin(s / R), R - R * Math.cos(s / R)];
    else if ((s -= Math.PI * R) < L) [x, y] = [L - s, 2 * R];
    else {
      s -= L;
      [x, y] = [-R * Math.sin(s / R), R + R * Math.cos(s / R)];
    }
    out.push([x + rnd(), y + rnd()]);
  }
  return out;
}

const codes = (def: TrackDef) => checkTrack(def).issues.map((i) => i.code);

describe("作ったコースを確かめる", () => {
  for (const def of TRACK_DEFS) {
    it(`公式の ${def.name} は通る`, () => {
      expect(checkTrack(def).issues).toEqual([]);
    });
  }

  it("8 の字 (道が交わる) はだめ", () => {
    const pts: Array<[number, number]> = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      pts.push([400 * Math.sin(a), 200 * Math.sin(2 * a)]);
    }
    const c = checkTrack({ ...base, points: pts });
    expect(c.issues.map((i) => i.code)).toContain("cross");
    expect(c.issues.find((i) => i.code === "cross")!.message).toMatch(/交わ/);
    expect(c.issues.find((i) => i.code === "cross")!.at).toBeDefined();
  });

  it("きつすぎるヘアピンはだめ", () => {
    // 細長い U の字: 先が半径 10 m ほど
    const def: TrackDef = {
      ...base,
      points: [
        [0, 0],
        [400, 0],
        [430, 10],
        [440, 30],
        [430, 50],
        [400, 60],
        [300, 60],
        [250, 120],
        [150, 160],
        [0, 160],
        [-80, 80],
      ],
    };
    const c = checkTrack(def);
    const corner = c.issues.find((i) => i.code === "corner");
    expect(corner, JSON.stringify(c.issues)).toBeDefined();
    expect(corner!.message).toMatch(/曲がりがきつすぎます。半径 \d+\.\d m → \d+\.\d m 以上に \(あと \d+\.\d m\)。/);
  });

  it("曲がりの半径の文は、今と要る半径が同じ数に見えない (QA 2 回目「半径 12 m、12 m 以上に」)", () => {
    expect(cornerNeedText(11.96, 12.04)).toBe("半径 11.9 m → 12.1 m 以上に (あと 0.2 m)");
    expect(cornerNeedText(12.0, 12.0)).toBe("半径 12.0 m → 12.1 m 以上に (あと 0.1 m)");
    expect(cornerNeedText(8.25, 14.3)).toBe("半径 8.2 m → 14.3 m 以上に (あと 6.1 m)");
  });

  it("短すぎる輪はだめ", () => {
    const def: TrackDef = { ...base, points: simplifyPath(stadium(60, 30)) };
    expect(codes(def)).toContain("length");
    expect(checkTrack(def).issues.find((i) => i.code === "length")!.message).toMatch(/短すぎます/);
  });

  it("道幅が狭すぎるとだめ (8 台が走れる幅)", () => {
    const def = { ...TRACK_DEFS[0], halfWidth: TRACK_LIMITS.minHalfWidth - 1 };
    const c = checkTrack(def);
    expect(c.issues.map((i) => i.code)).toEqual(["width"]);
    expect(c.issues[0].message).toMatch(/道幅が狭すぎます/);
  });

  it("点が足りない・名前がないとだめ", () => {
    expect(codes({ ...base, points: [[0, 0], [100, 0], [50, 80]] })).toContain("points");
    expect(codes({ ...TRACK_DEFS[0], name: "  " })).toContain("name");
  });

  it("スタートの並びが曲がりの中だとだめ", () => {
    // 公式の青図のスタートを曲がりの続く所 (7 番目の点) へずらす
    const p = TRACK_DEFS[0].points;
    const def = { ...TRACK_DEFS[0], points: [...p.slice(6), ...p.slice(0, 6)] };
    expect(codes(def)).toContain("grid");
  });
});

describe("指で引いた線をなめらかにする", () => {
  it("ふるえた線から、走れる輪ができる", () => {
    const pts = simplifyPath(stadium(400, 80, 3));
    expect(pts.length).toBeGreaterThanOrEqual(TRACK_LIMITS.minPoints);
    expect(pts.length).toBeLessThan(60);
    const c = checkTrack({ ...base, points: pts });
    expect(c.issues).toEqual([]);
    // 長さはだいたい元のまま (2 × 400 + 2π × 80 ≈ 1303 m)
    expect(c.track!.length).toBeGreaterThan(1250);
    expect(c.track!.length).toBeLessThan(1350);
  });

  it("スタートはまっすぐの上に置く", () => {
    const pts = simplifyPath(stadium(400, 80, 3));
    const t = buildTrack({ ...base, points: pts });
    // スタートの所はまっすぐ (y がほぼ 0 か 160)
    expect(Math.min(Math.abs(t.py[0]), Math.abs(t.py[0] - 160))).toBeLessThan(5);
  });

  it("点の間ごとの壁を、割合の区間にする", () => {
    const pts = TRACK_DEFS[0].points;
    const fr = controlFractions(pts);
    expect(fr[0]).toBe(0);
    for (let i = 1; i < fr.length; i++) expect(fr[i]).toBeGreaterThan(fr[i - 1]);
    const flags = pts.map((_, i) => i === 2 || i === 3);
    const w = wallsFromSegments(pts, flags);
    expect(w.length).toBe(1);
    expect(w[0][0]).toBeCloseTo(fr[2], 3);
    expect(w[0][1]).toBeCloseTo(fr[4], 3);
    // 最後と最初をまたぐ
    const wrap = wallsFromSegments(pts, pts.map((_, i) => i === 0 || i === pts.length - 1));
    expect(wrap.length).toBe(1);
    expect(wrap[0][0]).toBeGreaterThan(wrap[0][1]);
    expect(wallsFromSegments(pts, pts.map(() => false))).toEqual([]);
  });

  it("細かい直し: 近すぎる点を消し、幅を決まりの中へ", () => {
    const def = tidyTrack({ ...TRACK_DEFS[0], halfWidth: 2, runoff: 99, points: [[0, 0], [1, 1], ...TRACK_DEFS[0].points.slice(1)] });
    expect(def.halfWidth).toBe(TRACK_LIMITS.minHalfWidth);
    expect(def.runoff).toBe(TRACK_LIMITS.maxRunoff);
    expect(def.points.length).toBe(TRACK_DEFS[0].points.length);
  });
});
