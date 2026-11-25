// 管理者の数の説明の表 (adminconfig_meta.ts) の試験: 全部の項目に説明がある・幅がサーバーの確かめ (validateAdminConfig) と同じ・
// 違いの出し方・JSON の読みこみの確かめ・例の計算
import { describe, expect, it } from "vitest";
import {
  ADMIN_CONFIG_GROUPS,
  ADMIN_CONFIG_META,
  DEFAULT_ADMIN_CONFIG,
  POINTS,
  adminExport,
  adminLabel,
  adminPreview,
  adminRangeText,
  adminValueText,
  applyAdminPatch,
  ANNOUNCEMENT_MAX,
  checkAdminValue,
  checkAnnouncement,
  cloneAdminConfig,
  diffAdminConfig,
  leaguePrizeFor,
  manualLapGain,
  parseAdminImport,
  racePrizeFor,
  validateAdminConfig,
  type AdminConfig,
  type AdminFieldMeta,
} from "../src/index.ts";

const META = ADMIN_CONFIG_META as Record<string, AdminFieldMeta | undefined>;
const DEFS = DEFAULT_ADMIN_CONFIG as unknown as Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

describe("説明の表", () => {
  it("AdminConfig の全部の項目 (中の項目も) に説明がある。足したら ADMIN_CONFIG_META に 1 つ足す", () => {
    const missing: string[] = [];
    for (const k of Object.keys(DEFS)) {
      const m = META[k];
      if (!m) {
        missing.push(k);
        continue;
      }
      expect(m.label.length, k).toBeGreaterThan(0);
      expect(m.help.length, k).toBeGreaterThan(0);
      if (isObj(DEFS[k])) for (const sk of Object.keys(DEFS[k] as object)) if (!m.sub?.[sk]) missing.push(`${k}.${sk}`);
    }
    expect(missing).toEqual([]);
  });

  it("説明だけ残った古い項目は無い。組は決まった物だけ", () => {
    const groups = new Set(ADMIN_CONFIG_GROUPS.map((g) => g.id));
    for (const [k, m] of Object.entries(META)) {
      expect(k in DEFS, k).toBe(true);
      expect(groups.has(m!.group), k).toBe(true);
      for (const sk of Object.keys(m!.sub ?? {})) expect(sk in (DEFS[k] as object), `${k}.${sk}`).toBe(true);
    }
    // どの組にも 1 つはある
    for (const g of groups) expect(Object.values(META).some((m) => m!.group === g), g).toBe(true);
  });

  it("はじめの数は全部 説明の幅の中", () => {
    for (const k of Object.keys(DEFS)) {
      if (isObj(DEFS[k])) for (const [sk, v] of Object.entries(DEFS[k] as object)) expect(checkAdminValue(`${k}.${sk}`, v), `${k}.${sk}`).toBeNull();
      else expect(checkAdminValue(k, DEFS[k]), k).toBeNull();
    }
  });

  it("説明の幅はサーバーの確かめと同じ (端は通り、少しでも外は落ちる。画面の確かめとサーバーが食い違わない)", () => {
    const serverOk = (k: string, v: unknown) => validateAdminConfig({ ...cloneAdminConfig(DEFAULT_ADMIN_CONFIG), [k]: v }).ok;
    let probes = 0;
    const agree = (k: string, path: string, wrap: (v: unknown) => unknown, v: unknown, want: boolean) => {
      expect(serverOk(k, wrap(v)), `${path} = ${JSON.stringify(v)} (サーバー)`).toBe(want);
      expect(checkAdminValue(path, v) === null, `${path} = ${JSON.stringify(v)} (説明)`).toBe(want);
      probes++;
    };
    const delta = (b: number, int?: boolean) => (int ? 1 : Math.max(1e-6, Math.abs(b) * 1e-6));
    const edges = (k: string, path: string, wrap: (v: unknown) => unknown, m: { min?: number; max?: number; int?: boolean }) => {
      expect(m.min, path).toBeTypeOf("number");
      expect(m.max, path).toBeTypeOf("number");
      agree(k, path, wrap, m.min, true);
      agree(k, path, wrap, m.max, true);
      agree(k, path, wrap, m.min! - delta(m.min!, m.int), false);
      agree(k, path, wrap, m.max! + delta(m.max!, m.int), false);
      agree(k, path, wrap, "1", false);
      if (m.int) agree(k, path, wrap, m.min! + 0.5, false);
    };
    for (const [k, m] of Object.entries(META) as Array<[string, AdminFieldMeta]>) {
      const def = DEFS[k];
      if (m.sub) {
        for (const [sk, s] of Object.entries(m.sub)) edges(k, `${k}.${sk}`, (v) => ({ ...(def as object), [sk]: v }), s);
      } else if (typeof def === "string") {
        // 文字の項目 (お知らせ): 空・上限ちょうどは通り、1 字多い・改行・数は落ちる
        expect(m.maxLen, k).toBeTypeOf("number");
        agree(k, k, (v) => v, "", true);
        agree(k, k, (v) => v, "あ".repeat(m.maxLen!), true);
        agree(k, k, (v) => v, "あ".repeat(m.maxLen! + 1), false);
        agree(k, k, (v) => v, "1 行目\n2 行目", false);
        agree(k, k, (v) => v, 1, false);
        agree(k, k, (v) => v, null, false);
      } else if (typeof def === "boolean") {
        agree(k, k, (v) => v, true, true);
        agree(k, k, (v) => v, false, true);
        agree(k, k, (v) => v, 1, false);
      } else if (m.len) {
        const [lo, hi] = m.len;
        const fill = (n: number, x: number) => Array.from({ length: n }, () => x);
        for (const n of new Set([lo, hi])) {
          agree(k, k, (v) => v, fill(n, m.min!), true);
          agree(k, k, (v) => v, fill(n, m.max!), true);
          if (n > 0) agree(k, k, (v) => v, fill(n, m.max! + delta(m.max!, m.int)), false);
          if (n > 0) agree(k, k, (v) => v, fill(n, m.min! - delta(m.min!, m.int)), false);
          if (n > 0 && m.int) agree(k, k, (v) => v, fill(n, m.min! + 0.5), false);
        }
        agree(k, k, (v) => v, fill(hi + 1, m.min!), false);
        if (lo > 0) agree(k, k, (v) => v, fill(lo - 1, m.min!), false);
        agree(k, k, (v) => v, 5, false);
      } else {
        edges(k, k, (v) => v, m);
        agree(k, k, (v) => v, null, m.nullable === true);
      }
    }
    expect(probes).toBeGreaterThan(150);
  });

  it("名前・値・幅の字", () => {
    expect(adminLabel("season.tournamentMul")).toBe("季節の点の倍率: 大会");
    expect(adminLabel("noSuchField")).toBe("noSuchField");
    expect(adminValueText("prizePerPoint", 1500)).toBe("1,500 円");
    expect(adminValueText("marketFeeRate", 0.05)).toBe("0.05 (5%)");
    expect(adminValueText("leaguePrizeDivisionMul", [1, 1.5])).toBe("1 / 1.5 倍");
    expect(adminValueText("giftMoneyMax", null)).toBe("なし");
    expect(adminValueText("inviteOnly", true)).toBe("入");
    expect(adminRangeText("cpuOnlyPrizeRate")).toBe("0〜1 (0%〜100%)");
    expect(adminRangeText("tournamentPrize")).toContain("8 個");
    expect(adminRangeText("giftPartTierMax")).toContain("空 = なし");
    expect(checkAdminValue("tournamentPrize", [1, 2, 3])).toContain("8 個にしてください");
    expect(checkAdminValue("seasonPrizeClassMul", [1, 1, 99, 1, 1])).toMatch(/^3 級: 大きすぎます/);
    expect(checkAdminValue("prizeFinish", 1.5)).toBe("整数にしてください");
  });
});

describe("違いと読みこみ", () => {
  it("違いは項目ごと。中の項目のある物は中ごとに", () => {
    const b = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    b.prizePerPoint = 40;
    b.season.tournamentMul = 12;
    b.partKindStrength.engine = 1.2;
    b.giftMoneyMax = 5000;
    expect(diffAdminConfig(DEFAULT_ADMIN_CONFIG, b)).toEqual([
      { path: "prizePerPoint", before: 20, after: 40 },
      { path: "season.tournamentMul", before: 10, after: 12 },
      { path: "partKindStrength.engine", before: 1, after: 1.2 },
      { path: "giftMoneyMax", before: null, after: 5000 },
    ]);
    expect(diffAdminConfig(b, b)).toEqual([]);
  });

  it("書き出した物をそのまま読みこめる (変わる数 0)。一部だけでもよい", () => {
    const cur = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    const text = JSON.stringify(adminExport(cur, 1));
    const r = parseAdminImport(text, cur);
    expect(r.ok && r.changes).toEqual([]);
    const part = parseAdminImport(JSON.stringify({ prizeFinish: 50, season: { cpuOnlyMul: 0.25 } }), cur);
    expect(part.ok).toBe(true);
    if (part.ok) {
      expect(part.changes.map((c) => c.path)).toEqual(["prizeFinish", "season.cpuOnlyMul"]);
      expect(part.config.season.tournamentMul).toBe(10);
    }
  });

  it("悪い JSON は日本語のわけつきで断る (読めない・形・知らない項目・幅の外)", () => {
    const cur = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    const bad = (t: string) => {
      const r = parseAdminImport(t, cur);
      expect(r.ok).toBe(false);
      return r.ok ? [] : r.errors;
    };
    expect(bad("{ prizePerPoint: 1 ")[0]).toContain("JSON として読めません");
    expect(bad("[1, 2]")[0]).toContain("数の表");
    expect(bad(JSON.stringify({ config: { foo: 1 } }))).toEqual(["知らない項目: foo"]);
    expect(bad(JSON.stringify({ marketFeeRate: 0.9 }))).toEqual(["市場の手数料: 大きすぎます (0〜0.5 (0%〜50%))"]);
    expect(bad(JSON.stringify({ tournamentPrize: [1, 2] }))[0]).toBe("大会の賞金 (1〜8 位): 8 個にしてください (今 2 個)");
    expect(bad(JSON.stringify({ partKindStrength: { engine: 0 } }))[0]).toMatch(/^部品の強さ \(種類ごと\): エンジン: 小さすぎます/);
    expect(bad(JSON.stringify({ inviteOnly: "yes" }))[0]).toBe("招かれた人だけ登録できる: 入か切にしてください");
  });
});

describe("例 (いまの数で)", () => {
  const cfg = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);

  it("普段のレースの賞金は racePrizeFor と同じ数", () => {
    const win = racePrizeFor(cfg, "everyday", { pos: 1, points: POINTS[0], finished: true }, { laps: 5, cpuOnly: false });
    const ex = adminPreview("prizePerPoint", cfg);
    expect(ex[0]).toBe(`5 周で優勝 (${POINTS[0]} 点) → ${win.toLocaleString("ja-JP")} 円`);
    const more: AdminConfig = { ...cfg, prizePerPoint: 40 };
    expect(adminPreview("prizePerPoint", more)[0]).not.toBe(ex[0]);
  });

  it("リーグ戦は 部の倍率を掛ける (leaguePrizeFor)。季節・コンストラクター・市場・部品も出る", () => {
    const c2: AdminConfig = { ...cfg, leaguePrizeDivisionMul: [2, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7] };
    expect(adminPreview("leaguePrizeDivisionMul", c2)[0]).toBe(`1 部の毎日 1 位 → 300 × 2 = ${leaguePrizeFor(c2, 1, 1)} 円`);
    expect(adminPreview("season.tournamentMul", cfg)[1]).toBe(`大会で優勝 → 季節の点 ${POINTS[0] * 10}`);
    expect(adminPreview("marketFeeRate", cfg)[0]).toContain("手数料 500 円");
    expect(adminPreview("partKindStrength.engine", cfg)).toEqual(["エンジンの強さ → 1 × 1 = ×1"]);
    expect(adminPreview("constructorDivisionMul", cfg)[0]).toBe("1 部で 1 日 10 点 → 10 × 0.1 × 2 = 2 点");
    expect(adminPreview("inviteOnly", cfg)).toEqual([]);
  });

  it("マニュアルは測った目安から (3% → 1 周 約 0.6%)", () => {
    expect(manualLapGain(0)).toBe(0);
    expect(manualLapGain(0.03)).toBeCloseTo(0.0063, 6);
    expect(manualLapGain(0.065)).toBeGreaterThan(manualLapGain(0.03));
    expect(adminPreview("manualSpeedBonus", cfg)[0]).toContain("1 周 約 0.6% 速い");
  });
});

describe("お知らせ (announcement、オープニングの 1 行)", () => {
  it("はじめは空。説明は遊ぶ人の組に、字の上限つきである", () => {
    expect(DEFAULT_ADMIN_CONFIG.announcement).toBe("");
    const m = META.announcement!;
    expect(m.group).toBe("players");
    expect(m.maxLen).toBe(ANNOUNCEMENT_MAX);
    expect(ANNOUNCEMENT_MAX).toBe(80);
    expect(adminRangeText("announcement")).toBe("80 字まで・1 行・空 = 出さない");
  });

  it("字は見た目の 1 字で数える。改行・制御の字は落ちる", () => {
    expect(checkAnnouncement("今夜 22:30 の大会は大の格")).toBeNull();
    expect(checkAnnouncement("🏁".repeat(ANNOUNCEMENT_MAX))).toBeNull(); // 絵文字 1 つ = 1 字 (UTF-16 では 2)
    expect(checkAnnouncement("x".repeat(ANNOUNCEMENT_MAX + 1))).toContain("長すぎます");
    expect(checkAnnouncement("a\tb")).toContain("改行");
    expect(checkAnnouncement(5)).toBe("文字を入れてください");
  });

  it("管理者の画面の変更 (applyAdminPatch) で入れられ、悪い値は名前つきで断る", () => {
    const ok = applyAdminPatch(DEFAULT_ADMIN_CONFIG, { announcement: "明日 9 時から 30 分 止めます" });
    expect(ok.ok && ok.config.announcement).toBe("明日 9 時から 30 分 止めます");
    const bad = applyAdminPatch(DEFAULT_ADMIN_CONFIG, { announcement: "x".repeat(81) });
    expect(bad).toEqual({ ok: false, errors: ["announcement"] });
    // 前に保存した表 (お知らせが無い) も、はじめの値と合わせれば通る (サーバーの読み方)
    const { announcement: _drop, ...old } = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    expect(validateAdminConfig({ ...cloneAdminConfig(DEFAULT_ADMIN_CONFIG), ...old }).ok).toBe(true);
  });

  it("値の字・違い・例", () => {
    expect(adminValueText("announcement", "")).toBe("(空)");
    expect(adminValueText("announcement", "大会あり")).toBe("「大会あり」");
    const b = cloneAdminConfig(DEFAULT_ADMIN_CONFIG);
    b.announcement = "大会あり";
    expect(diffAdminConfig(DEFAULT_ADMIN_CONFIG, b)).toEqual([{ path: "announcement", before: "", after: "大会あり" }]);
    expect(adminPreview("announcement", b)[0]).toContain("4 / 80 字");
    expect(adminPreview("announcement", DEFAULT_ADMIN_CONFIG)[0]).toBe("空なので出しません");
  });
});
