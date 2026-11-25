import { describe, expect, it } from "vitest";
import {
  RADIO_MIN_GAP,
  RADIO_QUIET_START,
  RADIO_RULES,
  engineerName,
  newRadioState,
  pitNeeds,
  radioCandidates,
  setsFromAlloc,
  stepRadio,
  suggestPit,
  type RadioMessage,
  type RadioSituation,
  type RadioState,
} from "../src/index.ts";

/** ふつうの様子: 10 周のレースの 3 周目、普通のタイヤで少し減った、燃料は十分、晴れ */
function sit(over: Partial<RadioSituation> = {}): RadioSituation {
  return {
    t: 100,
    started: true,
    lapsDone: 2,
    totalLaps: 10,
    lapsLeft: 7.5,
    lapLength: 1500,
    lapTime: 40,
    toPitEntry: 900,
    tire: "M",
    wear: 0.2,
    burst: false,
    tireLife: 9,
    sets: null,
    fuel: 40,
    fuelCap: 60,
    fuelPerLap: 3,
    wet: 0,
    wetSoon: 0,
    forecast: [],
    flag: { mode: "green", drs: true },
    pitBooked: false,
    inPit: false,
    damage: null,
    ...over,
  };
}

/** t から dt ごとに n 回まわして、出た無線を集める */
function run(base: Partial<RadioSituation>, n: number, dt = 0.5, st: RadioState = newRadioState(), t0 = 100) {
  const msgs: RadioMessage[] = [];
  let state = st;
  for (let i = 0; i < n; i++) {
    const r = stepRadio(sit({ ...base, t: t0 + i * dt }), state);
    msgs.push(...r.messages);
    state = r.state;
  }
  return { msgs, state };
}

describe("無線の作戦係: 何を言うか", () => {
  it("ふつうのときは何も言わない", () => {
    expect(radioCandidates(sit())).toEqual([]);
    expect(run({}, 200).msgs).toEqual([]);
  });

  it("走る前・ゴールのあと・リタイア・ピットの道の中は黙る", () => {
    const bad = { burst: true };
    expect(radioCandidates(sit({ ...bad, started: false }))).toEqual([]);
    expect(radioCandidates(sit({ ...bad, finished: true }))).toEqual([]);
    expect(radioCandidates(sit({ ...bad, retired: true }))).toEqual([]);
    expect(radioCandidates(sit({ ...bad, inPit: true }))).toEqual([]);
  });

  it("破裂はいちばん大事で、ピットのすすめが付く", () => {
    const c = radioCandidates(sit({ burst: true, wear: 1 }));
    expect(c[0].key).toBe("burst");
    expect(c[0].text).toContain("破裂");
    expect(c[0].pit?.order.tire).toBeTruthy();
  });

  it("燃料: ゴールまで足りなければ知らせ、あと少しなら急ぎで", () => {
    const short = radioCandidates(sit({ fuel: 15 })); // 5 周分、残り 7.5 周
    const fs = short.find((c) => c.key === "fuel_short")!;
    expect(fs.text).toBe("燃料はあと 5 周。ゴールまで足りない");
    expect(fs.pit?.order.fuelTo).toBeGreaterThan(15);
    expect(fs.pit?.order.fuelTo).toBeLessThanOrEqual(60);
    expect(fs.pit?.label).toContain("燃料 +");
    const low = radioCandidates(sit({ fuel: 4 }));
    expect(low[0].key).toBe("fuel_low");
    expect(low[0].text).toBe("燃料はあと 1 周。ピットへ");
    expect(radioCandidates(sit({ fuel: 2 }))[0].text).toBe("燃料がもう 1 周もない。ピットへ");
  });

  it("燃料: ゴールまで足りていれば、少なくても言わない (最後の周)", () => {
    const c = radioCandidates(sit({ fuel: 4, lapsLeft: 0.8, lapsDone: 9 }));
    expect(c.some((x) => x.key.startsWith("fuel"))).toBe(false);
  });

  it("練習 (ゴールなし) では「ゴールまで」は言わず、燃料があと少しのときだけ", () => {
    const base = { totalLaps: 0, lapsLeft: Infinity };
    expect(radioCandidates(sit({ ...base, fuel: 15 })).some((c) => c.key === "fuel_short")).toBe(false);
    const low = radioCandidates(sit({ ...base, fuel: 3 }));
    expect(low[0].key).toBe("fuel_low");
    expect(low[0].pit?.order.fuelTo).toBeGreaterThan(3);
  });

  it("タイヤの減り 60% は知らせだけ、80% はピットのすすめ付き", () => {
    const w6 = radioCandidates(sit({ wear: 0.65, tireLife: 30 }));
    expect(w6.find((c) => c.key === "tire_wear")?.text).toBe("タイヤの減り 60%");
    expect(w6.find((c) => c.key === "tire_wear")?.pit).toBeNull();
    const w8 = radioCandidates(sit({ wear: 0.83 }));
    const c = w8.find((x) => x.key === "tire_wear_pit")!;
    expect(c.text).toBe("タイヤの減り 80%・あと 1 周");
    expect(c.pit?.order.tire).toBeTruthy();
  });

  it("練習 (周の終わりなし) でも、80% にはタイヤを替えるすすめが付く", () => {
    const c = radioCandidates(sit({ totalLaps: 0, lapsLeft: Infinity, wear: 0.83 })).find((x) => x.key === "tire_wear_pit")!;
    expect(c.pit?.order.tire).toBeTruthy();
    expect(c.pit?.label).toContain("新品");
  });

  it("タイヤの知らせは強いものだけ 1 つ (60% でゴールまで持たなければ 1 本にまとめる)", () => {
    const keys = (o: Partial<RadioSituation>) => radioCandidates(sit(o)).filter((c) => c.key.startsWith("tire_")).map((c) => c.key);
    expect(keys({ wear: 0.65 })).toEqual(["tire_short"]);
    expect(radioCandidates(sit({ wear: 0.65 })).find((c) => c.key === "tire_short")?.text).toBe("タイヤの減り 60%・あと 3 周。ゴールまで持たない");
    expect(keys({ wear: 0.83 })).toEqual(["tire_wear_pit"]);
    expect(keys({ wear: 0.65, tireLife: 30 })).toEqual(["tire_wear"]);
  });

  it("タイヤがゴールまで持たなければ「あと N 周」", () => {
    // 1 周 0.88/9 ≈ 0.098 減る。減り 0.45 → あと 5 周、残り 7.5 周
    const c = radioCandidates(sit({ wear: 0.45 })).find((x) => x.key === "tire_short")!;
    expect(c.text).toBe("タイヤはあと 5 周。ゴールまで持たない");
    expect(c.pit?.order.tire).toBeTruthy();
    // 残りが短ければ言わない
    expect(radioCandidates(sit({ wear: 0.45, lapsLeft: 4 })).some((x) => x.key === "tire_short")).toBe(false);
  });

  it("雨の予報: 乾いたタイヤのとき「N 周あとに雨 70%」", () => {
    const c = radioCandidates(sit({ forecast: [{ inSec: 200, sky: "light", chance: 70, text: "" }] })).find((x) => x.key === "rain_soon")!;
    expect(c.text).toBe("5 周あとに雨 70%");
    expect(c.pit).toBeNull();
    expect(radioCandidates(sit({ forecast: [{ inSec: 20, sky: "heavy", chance: 80, text: "" }] }))[0].text).toBe("まもなく大雨 80%");
    // 見込みが低い・雨用を履いている・ゴールのあと は言わない
    expect(radioCandidates(sit({ forecast: [{ inSec: 200, sky: "light", chance: 40, text: "" }] }))).toEqual([]);
    expect(radioCandidates(sit({ tire: "I", wet: 0.5, wetSoon: 0.5, forecast: [{ inSec: 200, sky: "light", chance: 70, text: "" }] })).some((x) => x.key === "rain_soon")).toBe(false);
    expect(radioCandidates(sit({ lapsLeft: 2, forecast: [{ inSec: 200, sky: "light", chance: 70, text: "" }] })).some((x) => x.key === "rain_soon")).toBe(false);
  });

  it("雨用で走っていて晴れの予報なら「N 周あとに晴れ」", () => {
    const c = radioCandidates(sit({ tire: "I", wet: 0.5, wetSoon: 0.5, forecast: [{ inSec: 80, sky: "sun", chance: 60, text: "" }] }));
    expect(c.find((x) => x.key === "dry_soon")?.text).toBe("2 周あとに晴れ 60%");
  });

  it("天気にタイヤが合わない: 替えるタイヤをすすめる", () => {
    const wet = radioCandidates(sit({ wet: 0.5, wetSoon: 0.55 }));
    expect(wet[0].key).toBe("wrong_tire");
    expect(wet[0].text).toBe("路面が濡れてきた。小雨用に替えよう");
    expect(wet[0].pit?.order.tire).toBe("I");
    const dry = radioCandidates(sit({ tire: "W", wet: 0.05, wetSoon: 0 }));
    expect(dry[0].key).toBe("wrong_tire");
    expect(dry[0].text).toBe("乾いてきた。乾いたタイヤに替えよう");
    expect(["S", "M", "H"]).toContain(dry[0].pit?.order.tire);
  });

  it("持っている組に雨用がなければ「雨用の組はない」と言い、替えをすすめない", () => {
    const c = radioCandidates(sit({ wet: 0.5, wetSoon: 0.55, sets: setsFromAlloc({ M: 1 }) })).find((x) => x.key === "wrong_tire")!;
    expect(c.text).toBe("路面が濡れてきた。雨用の組はない");
    expect(c.pit?.order.tire ?? null).toBeNull();
  });

  it("持っている組があれば、その中から選ぶ (新品を先に)", () => {
    const sets = setsFromAlloc({ H: 1, I: 1 });
    const p = suggestPit(sit({ wear: 0.85, sets }), { tire: "wear" })!;
    expect(p.order.tire).toBe("H");
    expect(p.order.used ?? null).toBeNull();
    expect(p.label).toContain("硬い 新品");
  });

  it("VSC・SC の間は「ピットのチャンス」(タイヤが減っているとき)", () => {
    const vsc = radioCandidates(sit({ wear: 0.45, tireLife: 30, flag: { mode: "vsc" } }));
    expect(vsc[0].key).toBe("sc_pit");
    expect(vsc[0].text).toBe("VSC だ。ピットのチャンス");
    expect(vsc[0].pit?.order.tire).toBeTruthy();
    const sc = radioCandidates(sit({ wear: 0.45, tireLife: 30, flag: { mode: "sc" } }));
    expect(sc[0].text).toBe("SC だ。ピットのチャンス");
    // タイヤが新しく燃料も足りていれば言わない。終わりかけなら「準備を」
    expect(radioCandidates(sit({ flag: { mode: "vsc" } })).some((x) => x.key === "sc_pit")).toBe(false);
    expect(radioCandidates(sit({ flag: { mode: "vsc", ending: true } }))[0].text).toBe("VSC が明ける。準備を");
  });

  it("ピットに入るなら今: 要るものがあって、入り口が近いとき", () => {
    const near = radioCandidates(sit({ fuel: 15, toPitEntry: 300 }));
    expect(near.some((c) => c.key === "box_now" && c.text === "ピットに入るなら今" && !!c.pit)).toBe(true);
    expect(radioCandidates(sit({ fuel: 15, toPitEntry: 1000 })).some((c) => c.key === "box_now")).toBe(false);
    expect(radioCandidates(sit({ toPitEntry: 300 })).some((c) => c.key === "box_now")).toBe(false);
  });

  it("ピットを予約してあれば、ピットのすすめは言わない (知らせは言う)", () => {
    const c = radioCandidates(sit({ fuel: 15, wear: 0.83, pitBooked: true, toPitEntry: 300 }));
    expect(c.some((x) => ["fuel_short", "box_now"].includes(x.key))).toBe(false);
    const w = c.find((x) => x.key === "tire_wear_pit")!;
    expect(w.pit).toBeNull();
  });

  it("後ろの車が DRS 圏内・前の車のタイヤ・前の車がピット", () => {
    const b = radioCandidates(sit({ behind: { id: "x", gap: 0.84 } }));
    expect(b[0].text).toBe("後ろの車が 0.8 秒差で DRS 圏内");
    // DRS が使えない (旗・雨) なら言わない
    expect(radioCandidates(sit({ flag: { mode: "green", drs: false }, behind: { id: "x", gap: 0.8 } }))).toEqual([]);
    expect(radioCandidates(sit({ behind: { id: "x", gap: 1.6 } }))).toEqual([]);
    const a = radioCandidates(sit({ ahead: { id: "y", gap: 2.1, tire: "S", wear: 0.7 } }));
    expect(a[0].text).toBe("前の車のタイヤが傷んでいる");
    expect(radioCandidates(sit({ ahead: { id: "y", gap: 6, wear: 0.9 } }))).toEqual([]);
    expect(radioCandidates(sit({ ahead: { id: "y", gap: 3, inPit: true, pitStops: 1 } }))[0].text).toBe("前の車がピットに入った");
    expect(radioCandidates(sit({ drsGap: 0.7 }))[0].text).toBe("前と 0.7 秒。DRS が使える");
  });

  it("傷: 壊れた・落ちた部品は修理をすすめ、小さな傷は知らせだけ", () => {
    const br = radioCandidates(sit({ damage: { damaged: 2, broken: 1, lost: 0 } }))[0];
    expect(br.text).toBe("部品が壊れた。ピットで直せる");
    expect(br.pit?.order.repair).toBe(true);
    expect(radioCandidates(sit({ damage: { damaged: 1, broken: 0, lost: 1 } }))[0].text).toBe("部品が落ちた。ピットで直せる");
    const small = radioCandidates(sit({ damage: { damaged: 1, broken: 0, lost: 0 } }))[0];
    expect(small.key).toBe("damage");
    expect(small.pit).toBeNull();
  });

  it("最後の周", () => {
    expect(radioCandidates(sit({ lapsDone: 9, lapsLeft: 0.9 }))[0].text).toBe("最後の周だ。押していこう");
  });

  it("最後の周は、急ぎでないタイヤ・燃料・傷の知らせを言わない (破裂・燃料切れは言う)", () => {
    const last = { lapsDone: 9, lapsLeft: 0.9 };
    const keys = (o: Partial<RadioSituation>) => radioCandidates(sit({ ...last, ...o })).map((c) => c.key);
    expect(keys({ wear: 0.65, tireLife: 30 })).not.toContain("tire_wear");
    expect(keys({ wear: 0.83 })).not.toContain("tire_wear_pit");
    expect(keys({ damage: { damaged: 1, broken: 0, lost: 0 } })).not.toContain("damage");
    expect(keys({ toPitEntry: 200, wear: 0.9 })).not.toContain("box_now");
    expect(keys({ burst: true })).toContain("burst");
    expect(keys({ fuel: 1 })).toContain("fuel_low");
    // 最後の周の前なら言う
    expect(radioCandidates(sit({ wear: 0.65, tireLife: 30, lapsDone: 8, lapsLeft: 1.9 })).map((c) => c.key)).toContain("tire_wear");
  });

  it("大事な順に並ぶ", () => {
    const c = radioCandidates(sit({ burst: true, fuel: 4, wear: 1, behind: { id: "x", gap: 0.5 }, lapsDone: 9, lapsLeft: 0.9 }));
    const p = c.map((x) => x.priority);
    expect([...p].sort((a, b) => b - a)).toEqual(p);
    expect(c[0].key).toBe("burst");
  });

  it("pitNeeds: 燃料・タイヤ・修理", () => {
    expect(pitNeeds(sit())).toEqual({ tire: null, fuel: false, repair: false });
    expect(pitNeeds(sit({ fuel: 10 })).fuel).toBe(true);
    expect(pitNeeds(sit({ wear: 0.5 })).tire).toBe("wear");
    expect(pitNeeds(sit({ burst: true })).tire).toBe("burst");
    expect(pitNeeds(sit({ damage: { damaged: 1, broken: 1, lost: 0 } })).repair).toBe(true);
  });
});

describe("無線の作戦係: うるさくしない", () => {
  it("同じ知らせはくり返さない (中身が同じなら一度だけ)", () => {
    const { msgs } = run({ wear: 0.65, tireLife: 30 }, 400);
    expect(msgs.map((m) => m.key)).toEqual(["tire_wear"]);
  });

  it("種類ごとの間 (cooldown) をあけて、また言う", () => {
    const { msgs } = run({ ahead: { id: "y", gap: 2, wear: 0.7 } }, 800, 0.5); // 400 秒
    expect(msgs.length).toBe(3);
    for (let i = 1; i < msgs.length; i++) expect(msgs[i].t - msgs[i - 1].t).toBeGreaterThanOrEqual(RADIO_RULES.ahead_tire.cooldown);
  });

  it("DRS は 1 つのタイヤで走る間に 1 回 (同じ相手)。タイヤを替えるとまた言える", () => {
    let { msgs, state } = run({ behind: { id: "x", gap: 0.8 } }, 600, 0.5); // 300 秒
    expect(msgs.map((m) => m.key)).toEqual(["behind_drs"]);
    // 相手が替わっても、DRS の知らせどうしは間をあける
    const two = run({ behind: { id: "z", gap: 0.8 } }, 20, 0.5, state, 400);
    expect(two.msgs.map((m) => m.key)).toEqual(["behind_drs"]);
    const soon = run({ behind: { id: "w", gap: 0.8 } }, 78, 0.5, two.state, 420); // 420〜458.5 秒
    expect(soon.msgs).toEqual([]);
    // 新しいタイヤ
    state = stepRadio(sit({ t: 500, tire: "H", wear: 0 }), soon.state).state;
    expect(run({ tire: "H", wear: 0, behind: { id: "x", gap: 0.8 } }, 4, 0.5, state, 501).msgs.map((m) => m.key)).toEqual(["behind_drs"]);
  });

  it("DRS の知らせ (後ろ・前・オーバーテイク) は、まとめて間をあける", () => {
    const { msgs } = run({ behind: { id: "x", gap: 0.8 }, drsGap: 0.7, ahead: { id: "y", gap: 0.5 }, ot: { armed: true, ok: true, energy: 1 } }, 240, 0.5); // 120 秒
    const drs = msgs.filter((m) => ["behind_drs", "ahead_drs", "ot_attack", "ot_ready"].includes(m.key));
    expect(drs.length).toBe(2);
    expect(drs[1].t - drs[0].t).toBeGreaterThanOrEqual(60);
  });

  it("無線どうしは間をあけ (急ぎでなければ 20 秒に 1 つ)、1 回に 1 つ。大事なものから", () => {
    const { msgs } = run({ wear: 0.83, behind: { id: "x", gap: 0.8 }, damage: { damaged: 1, broken: 0, lost: 0 } }, 120, 0.5);
    expect(msgs[0].key).toBe("tire_wear_pit");
    for (let i = 1; i < msgs.length; i++) expect(msgs[i].t - msgs[i - 1].t).toBeGreaterThanOrEqual(RADIO_MIN_GAP);
    expect(msgs.map((m) => m.key)).toEqual(["tire_wear_pit", "behind_drs", "damage"]);
    expect(RADIO_MIN_GAP).toBeGreaterThanOrEqual(20);
  });

  it("タイヤは強まるときだけ言い直す (60% → 持たない → 80% が続けて出ない)", () => {
    // 減りが 0.6 から 0.85 へ 1 秒に 0.01 ずつ進む (QA: 24 秒で 3 つ出た)
    const msgs: RadioMessage[] = [];
    let state = newRadioState();
    for (let i = 0; i < 60; i++) {
      const r = stepRadio(sit({ t: 100 + i, wear: Math.min(0.9, 0.6 + i * 0.01), lapsLeft: 6 }), state);
      msgs.push(...r.messages);
      state = r.state;
    }
    const tire = msgs.filter((m) => m.key.startsWith("tire_"));
    expect(tire.map((m) => m.key)).toEqual(["tire_short", "tire_wear_pit"]);
    expect(tire[1].t - tire[0].t).toBeGreaterThanOrEqual(25);
    // 同じ強さはくり返さない
    const after = run({ wear: 0.9, lapsLeft: 6 }, 400, 0.5, state, 200);
    expect(after.msgs.filter((m) => m.key.startsWith("tire_"))).toEqual([]);
  });

  it("急ぎの無線は間を待たない (破裂)", () => {
    const { msgs, state } = run({ wear: 0.65, tireLife: 30 }, 2);
    expect(msgs.map((m) => m.key)).toEqual(["tire_wear"]);
    const r = stepRadio(sit({ t: 102, burst: true, wear: 1 }), state);
    expect(r.messages[0]?.key).toBe("burst");
  });

  it("74 秒・2 周のレースで、ふつうの様子が続いても無線は 4 つまで", () => {
    const msgs: RadioMessage[] = [];
    let state = newRadioState();
    for (let i = 0; i < 148; i++) {
      const t = i * 0.5;
      const r = stepRadio(
        sit({
          t,
          lapsDone: t < 37 ? 0 : 1,
          totalLaps: 2,
          lapsLeft: 2 - t / 37,
          lapTime: 37,
          tireLife: 3,
          wear: Math.min(0.95, (t / 37) * 0.29),
          behind: { id: i % 40 < 20 ? "a" : "b", gap: 0.7 },
          drsGap: 0.6,
          ahead: { id: "c", gap: 0.5 },
          ot: { armed: true, ok: true, energy: 1 },
        }),
        state,
      );
      msgs.push(...r.messages);
      state = r.state;
    }
    expect(msgs.length).toBeLessThanOrEqual(4);
    expect(msgs.filter((m) => ["behind_drs", "ahead_drs", "ot_attack", "ot_ready"].includes(m.key)).length).toBeLessThanOrEqual(2);
  });

  it("スタート直後は静か (急ぎは別)", () => {
    expect(run({ behind: { id: "x", gap: 0.5 } }, 10, 0.5, newRadioState(), 0).msgs).toEqual([]);
    const urgent = run({ burst: true }, 2, 0.5, newRadioState(), 1).msgs;
    expect(urgent[0].key).toBe("burst");
    expect(urgent[0].t).toBeLessThan(RADIO_QUIET_START);
  });

  it("タイヤを替えたら、減りの知らせをまた言える", () => {
    let { state } = run({ wear: 0.65, tireLife: 30 }, 4);
    expect(state.said.tire_wear).toBeTruthy();
    // 新しいタイヤ
    state = stepRadio(sit({ t: 200, wear: 0.01 }), state).state;
    expect(state.said.tire_wear).toBeUndefined();
    const again = stepRadio(sit({ t: 300, wear: 0.62, tireLife: 30 }), state);
    expect(again.messages[0]?.key).toBe("tire_wear");
  });

  it("前の状態は変えない・同じ入力なら同じ無線", () => {
    const st = newRadioState();
    const copy = JSON.stringify(st);
    const a = stepRadio(sit({ burst: true }), st);
    const b = stepRadio(sit({ burst: true }), st);
    expect(JSON.stringify(st)).toBe(copy);
    expect(a).toEqual(b);
    expect(a.messages[0].id).toBe(1);
    expect(a.messages[0].ttl).toBeGreaterThan(5);
  });

  it("予報の同じ変わり目は、時間が進んでも一度だけ", () => {
    const msgs: RadioMessage[] = [];
    let state = newRadioState();
    for (let i = 0; i < 120; i++) {
      const t = 100 + i;
      const r = stepRadio(sit({ t, forecast: [{ inSec: 230 - i, sky: "light", chance: 70, text: "" }] }), state);
      msgs.push(...r.messages);
      state = r.state;
    }
    expect(msgs.length).toBe(1);
  });
});

describe("作戦係の名前", () => {
  it("同じ名前ならいつも同じ", () => {
    expect(engineerName("あなた")).toBe(engineerName("あなた"));
    expect(engineerName("").length).toBeGreaterThan(0);
  });
});
