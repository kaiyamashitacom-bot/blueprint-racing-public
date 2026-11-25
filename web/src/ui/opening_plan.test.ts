// オープニングの決めごと (opening_plan.ts) の試験: 設定の読み方・出す形・読み直し・押したあとの行き先・時間
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENING,
  PROMPT_AT,
  PROMPT_DUR,
  SHORT_SCALE,
  effectiveSetting,
  easeOut,
  isSkipKey,
  openingLength,
  openingOnLoad,
  openingPlan,
  parseOpeningPrefs,
  progress,
  promptText,
  screenAfterOpening,
} from "./opening_plan.ts";

describe("設定", () => {
  it("壊れた・空の保存は決まりの値 (auto・まだ見ていない)", () => {
    for (const raw of [null, undefined, "", "{", "null", "3", '{"setting":"loud","seen":"yes"}']) expect(parseOpeningPrefs(raw), String(raw)).toEqual(DEFAULT_OPENING);
    expect(parseOpeningPrefs('{"setting":"off","seen":true}')).toEqual({ setting: "off", seen: true });
  });

  it("auto: はじめは ふつう、見たあとは 短く。選んだらそのまま", () => {
    expect(openingPlan({ setting: "auto", seen: false })).toBe("full");
    expect(openingPlan({ setting: "auto", seen: true })).toBe("short");
    expect(openingPlan({ setting: "full", seen: true })).toBe("full");
    expect(openingPlan({ setting: "short", seen: false })).toBe("short");
    expect(openingPlan({ setting: "off", seen: false })).toBe("none");
    expect(effectiveSetting({ setting: "auto", seen: true })).toBe("short");
    expect(effectiveSetting({ setting: "auto", seen: false })).toBe("full");
  });

  it("動きを減らす設定の人は 動かさず最後の形 (なし はなしのまま)", () => {
    expect(openingPlan({ setting: "full", seen: false }, true)).toBe("still");
    expect(openingPlan({ setting: "off", seen: false }, true)).toBe("none");
  });
});

describe("行き先", () => {
  it("読み直し: 画面の記録が無い・メニューなら出す。ほかの画面の途中なら出さない", () => {
    expect(openingOnLoad(null)).toBe(true);
    expect(openingOnLoad("menu")).toBe(true);
    for (const s of ["builder", "online", "practice", "welcome", "account"]) expect(openingOnLoad(s), s).toBe(false);
  });

  it("押したあと: ログインが残っていればメニュー、無ければログイン。試すを選んだ回はメニュー", () => {
    expect(screenAfterOpening(true, false)).toBe("menu");
    expect(screenAfterOpening(false, false)).toBe("welcome");
    expect(screenAfterOpening(false, true)).toBe("menu");
  });
});

describe("時間", () => {
  it("ふつうは 3〜4 秒、短くは約 1 秒、still は 0", () => {
    const full = openingLength(15, "full");
    expect(full).toBeGreaterThanOrEqual(3);
    expect(full).toBeLessThanOrEqual(4);
    expect(full).toBeCloseTo(PROMPT_AT + PROMPT_DUR, 6);
    expect(openingLength(15, "short")).toBeCloseTo(full * SHORT_SCALE, 6);
    expect(openingLength(15, "short")).toBeLessThanOrEqual(1.2);
    expect(openingLength(15, "still")).toBe(0);
  });

  it("進みは 0..1、始まる前 0・終わったら 1。still はいつも 1", () => {
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeCloseTo(0.875, 6);
    expect(progress(0, 1, 1, 1)).toBe(0);
    expect(progress(2, 1, 1, 1)).toBe(1);
    expect(progress(0.3, 1, 1, 0.3)).toBe(0); // 短く: 0.3 秒から
    expect(progress(0.6, 1, 1, 0.3)).toBe(1);
    expect(progress(0, 5, 1, 0)).toBe(1);
  });

  it("案内の字とキー", () => {
    expect(promptText(true)).toBe("タップしてスタート");
    expect(promptText(false)).toBe("クリック / Enter でスタート");
    expect(isSkipKey("Enter")).toBe(true);
    expect(isSkipKey(" ")).toBe(true);
    expect(isSkipKey("Shift")).toBe(false);
    expect(isSkipKey("Tab")).toBe(false);
  });
});
