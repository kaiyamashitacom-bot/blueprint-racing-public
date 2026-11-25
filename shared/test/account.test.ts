import { describe, expect, it } from "vitest";
import {
  LOBBY_MS,
  PARTS,
  RaceRoom,
  SAMPLE_DESIGN,
  STARTER_BOX,
  checkBuy,
  checkDriverName,
  checkLoginId,
  checkPassword,
  checkTeamName,
  cleanDisplayName,
  designFits,
  nameKey,
  normalizeLoginId,
  racePrize,
  remainingFor,
  shopList,
  shopPrice,
  starterInventory,
  type RaceReport,
} from "../src/index.ts";

describe("ID・パスワード・表示名", () => {
  it("ID は英数字と _ - の 3〜20 字、大文字は小文字にそろえる", () => {
    expect(checkLoginId("Kai_01")).toBeNull();
    expect(normalizeLoginId("  Kai_01 ")).toBe("kai_01");
    expect(checkLoginId("ab")).not.toBeNull();
    expect(checkLoginId("a".repeat(21))).not.toBeNull();
    expect(checkLoginId("かい")).not.toBeNull();
    expect(checkLoginId("_kai")).not.toBeNull();
    expect(checkLoginId("kai kai")).not.toBeNull();
    expect(checkLoginId("admin2")).not.toBeNull();
  });

  it("パスワードは 8 文字以上", () => {
    expect(checkPassword("1234567")).not.toBeNull();
    expect(checkPassword("12345678")).toBeNull();
    expect(checkPassword("あいうえおかきく")).toBeNull();
    expect(checkPassword(12345678)).not.toBeNull();
    expect(checkPassword("abc\ndefgh")).not.toBeNull();
    expect(checkPassword("x".repeat(129))).not.toBeNull();
  });

  it("表示名: 長さ・管理者や CPU のふりは断る", () => {
    expect(checkTeamName("青図レーシング")).toBeNull();
    expect(checkDriverName("カイ")).toBeNull();
    expect(checkTeamName("")).not.toBeNull();
    expect(checkTeamName("   ")).not.toBeNull();
    expect(checkTeamName("あ".repeat(17))).not.toBeNull();
    expect(checkDriverName("あ".repeat(13))).not.toBeNull();
    expect(checkDriverName("管理者")).not.toBeNull();
    expect(checkDriverName("ゲーム運営")).not.toBeNull();
    expect(checkDriverName("ＡＤＭＩＮ")).not.toBeNull();
    expect(checkDriverName("Ad min")).not.toBeNull();
    expect(checkDriverName("カイ (CPU)")).not.toBeNull();
    expect(checkTeamName("<b>")).not.toBeNull();
  });

  it("見えない文字を取り、全角と半角・大文字と小文字は同じ名前", () => {
    expect(cleanDisplayName("カ​イ")).toBe("カイ");
    expect(cleanDisplayName("  A   B  ")).toBe("A B");
    expect(nameKey("ＡＢＣ")).toBe(nameKey("abc"));
    expect(nameKey("a b")).toBe(nameKey("AB"));
  });
});

describe("持ち物とお店", () => {
  it("段階 1〜2 の部品は全部お店で売っていて、値段は正の数", () => {
    for (const p of PARTS) {
      const price = shopPrice(p.id);
      if (p.tier <= 2) expect(price).toBeGreaterThan(0);
      else expect(price).toBeNull();
    }
    expect(shopList().length).toBe(PARTS.filter((p) => p.tier <= 2).length);
    expect(shopPrice("nope")).toBeNull();
  });

  it("はじめの箱で見本の車が作れる", () => {
    const inv = starterInventory();
    expect(inv).toEqual(STARTER_BOX);
    expect(designFits(SAMPLE_DESIGN, inv).ok).toBe(true);
  });

  it("足りない部品と数がわかる", () => {
    const d = { name: "x", parts: [0, 1, 2].map((i) => ({ id: "eng_s1", c: i * 2, r: 0, rot: 0 as const })) };
    const fit = designFits(d, starterInventory());
    expect(fit.ok).toBe(false);
    expect(fit.missing).toEqual({ eng_s1: 2 });
    expect(remainingFor(d, starterInventory()).eng_s1).toBe(-2);
    expect(designFits({ name: "y", parts: [{ id: "eng_p2", c: 0, r: 0, rot: 0 }] }, {}).missing).toEqual({ eng_p2: 1 });
  });

  it("買えるか: お金・数・売っていない部品", () => {
    const price = shopPrice("tire_n1")!;
    const ok = checkBuy("tire_n1", 2, price * 2, 4);
    expect(ok).toEqual({ ok: true, cost: price * 2, money: 0, owned: 6 });
    expect(checkBuy("tire_n1", 3, price * 2, 4).ok).toBe(false);
    expect(checkBuy("tire_n1", 0, 99999, 0).ok).toBe(false);
    expect(checkBuy("tire_n1", 1.5, 99999, 0).ok).toBe(false);
    expect(checkBuy("tire_n1", 51, 999999, 0).ok).toBe(false);
    expect(checkBuy("tire_n1", 1, 999999, 999).ok).toBe(false);
    expect(checkBuy("nope", 1, 999999, 0).ok).toBe(false);
  });
});

describe("賞金", () => {
  it("点が多いほど・長いレースほど多く、CPU だけのレースは少なめ", () => {
    const win = { points: 26, finished: true };
    const last = { points: 4, finished: true };
    expect(racePrize(win, { laps: 5, humans: 3 })).toBeGreaterThan(racePrize(last, { laps: 5, humans: 3 }));
    expect(racePrize(win, { laps: 10, humans: 3 })).toBeGreaterThan(racePrize(win, { laps: 5, humans: 3 }));
    expect(racePrize(win, { laps: 5, humans: 1 })).toBeLessThan(racePrize(win, { laps: 5, humans: 2 }));
    expect(racePrize({ points: 0, finished: false }, { laps: 5, humans: 2 })).toBe(0);
    expect(racePrize({ points: 0, finished: true }, { laps: 2, humans: 2 })).toBeGreaterThan(0);
  });

  it("部屋は結果が決まると、人の車ごとの順位と点と key を知らせる", () => {
    let r = 11;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const reports: RaceReport[] = [];
    const room = new RaceRoom({ send: () => {}, broadcast: () => {}, onResults: (rep) => reports.push(rep) }, 1, rand);
    let now = 0;
    const a = room.join("key-a", "A", SAMPLE_DESIGN, now) as { id: string };
    now += LOBBY_MS + 10;
    room.tick(now);
    expect(room.phase).toBe("race");
    // 通信が切れてコンピューターが代わりに走る
    room.leave(a.id, now);
    for (let i = 0; i < 20 * 200 && room.phase === "race"; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.phase).toBe("results");
    expect(reports.length).toBe(1);
    const rep = reports[0];
    expect(rep.humans).toBe(1);
    expect(rep.cars).toBe(8);
    expect(rep.laps).toBe(1);
    expect(rep.rows.length).toBe(1);
    expect(rep.rows[0].id).toBe(a.id);
    expect(rep.rows[0].key).toBe("key-a");
    expect(rep.rows[0].pos).toBeGreaterThanOrEqual(1);
  });
});
