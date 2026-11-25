// 管理者の画面の「大会」: 格・全員参加・景品 (順位の幅ごとの中身と参加賞) の入力 (admin.ts の大会を組む / 直す から使う)。
// 中身の入力はギフトコードと同じ (admin_gifts.ts の itemsEditor。登録表 GIFT_KINDS に足された物は自動で並ぶ)
import { PRIZE_POS_MAX, PRIZE_TIERS_MAX, TOURNAMENT_GRADES, defaultTournamentPrizes, prizeSummary, type GiftItem, type PrizeTier, type TournamentGrade } from "@bpr/shared";
import { fetchGiftOptions } from "../gift_api.ts";
import type { TourBrief, TourInput } from "../season_api.ts";
import { defaultParams, itemsEditor } from "./admin_gifts.ts";
import { el } from "./dom.ts";
import { prizeFrame } from "./tourprize.ts";
import "./gift.css";
import "./tourprize.css";

type Drivers = Awaited<ReturnType<typeof fetchGiftOptions>>["drivers"];

const clone = (items: readonly GiftItem[]) => items.map((x) => ({ kind: x.kind, p: { ...x.p } }));

/** 格と景品の入力。value() で送る形 (prizes / participation: null = 格のはじめの景品) */
export async function tourPrizeEditor(editing: TourBrief | null): Promise<{ node: HTMLElement; value(): Pick<TourInput, "grade" | "allEnter" | "prizes" | "participation"> }> {
  let drivers: Drivers = [];
  try {
    drivers = (await fetchGiftOptions()).drivers;
  } catch {
    /* 運転手の選びが空になるだけ */
  }
  const spec = editing?.prizeSpec ?? { prizes: null, participation: null };
  let grade: TournamentGrade = editing?.grade ?? "中";
  let tiers: PrizeTier[] | null = spec.prizes ? spec.prizes.map((t) => ({ from: t.from, to: t.to, items: clone(t.items) })) : null;
  let part: GiftItem[] | null = spec.participation ? clone(spec.participation) : null;
  // 全員参加: 新しく組むときは入 (はじめ)、直すときは今のまま
  const all = el("input", { type: "checkbox" }) as HTMLInputElement;
  all.checked = editing ? editing.allEnter === true : true;

  const box = el("div", { class: "tp-adm" });
  const gradeSel = el("select", { "aria-label": "大会の格" }) as HTMLSelectElement;
  for (const g of TOURNAMENT_GRADES) gradeSel.append(el("option", { value: g }, `${g}`));
  gradeSel.value = grade;
  const preview = el("div");
  const tierBox = el("div", { class: "stack" });
  const partBox = el("div", { class: "stack" });
  const useDefTiers = el("input", { type: "checkbox" }) as HTMLInputElement;
  const partMode = el("select", { "aria-label": "参加賞" }) as HTMLSelectElement;
  for (const [v, jp] of [
    ["def", "格のはじめの参加賞"],
    ["none", "なし"],
    ["custom", "決める"],
  ]) partMode.append(el("option", { value: v }, jp));

  const drawPreview = () => {
    preview.replaceChildren(prizeFrame(prizeSummary({ grade, ...(tiers ? { prizes: tiers } : {}), ...(part ? { participation: part } : {}) })) ?? "");
  };
  const drawTiers = () => {
    tierBox.innerHTML = "";
    useDefTiers.checked = tiers === null;
    if (tiers === null) return drawPreview();
    tiers.forEach((t, i) => {
      const from = el("input", { type: "number", min: "1", max: String(PRIZE_POS_MAX), inputmode: "numeric", "aria-label": "何位から" }) as HTMLInputElement;
      const to = el("input", { type: "number", min: "1", max: String(PRIZE_POS_MAX), inputmode: "numeric", "aria-label": "何位まで" }) as HTMLInputElement;
      from.value = String(t.from);
      to.value = String(t.to);
      from.addEventListener("input", () => (t.from = Number(from.value)));
      to.addEventListener("input", () => (t.to = Number(to.value)));
      const del = el("button", { class: "small ghost", type: "button", "aria-label": `${i + 1} 段目を消す` }, "✕");
      del.addEventListener("click", () => {
        tiers!.splice(i, 1);
        drawTiers();
      });
      tierBox.append(
        el(
          "div",
          { class: "tp-adm-tier" },
          el("div", { class: "tp-adm-range" }, el("span", { class: "tp-pos" }, "P"), from, el("span", {}, "〜"), to, el("span", {}, "位"), del),
          itemsEditor(t.items, drivers),
        ),
      );
    });
    if (tiers.length < PRIZE_TIERS_MAX) {
      const add = el("button", { class: "small", type: "button" }, "＋ 順位の段を足す");
      add.addEventListener("click", () => {
        const last = tiers!.reduce((m, t) => Math.max(m, t.to), 0);
        tiers!.push({ from: last + 1, to: last + 1, items: [{ kind: "money", p: defaultParams("money", drivers) }] });
        drawTiers();
      });
      tierBox.append(add);
    }
    drawPreview();
  };
  const drawPart = () => {
    partBox.innerHTML = "";
    partMode.value = part === null ? "def" : part.length === 0 ? "none" : "custom";
    if (part && part.length) partBox.append(itemsEditor(part, drivers));
    drawPreview();
  };
  gradeSel.addEventListener("change", () => {
    grade = gradeSel.value as TournamentGrade;
    drawPreview();
  });
  useDefTiers.addEventListener("change", () => {
    // 決めるときは 今の格のはじめの景品を下書きにする
    tiers = useDefTiers.checked ? null : defaultsAsDraft(grade);
    drawTiers();
  });
  partMode.addEventListener("change", () => {
    part = partMode.value === "def" ? null : partMode.value === "none" ? [] : [{ kind: "money", p: defaultParams("money", drivers) }];
    drawPart();
  });
  const field = (label: string, c: HTMLElement, hint = "") => el("label", { class: "ss-field" }, el("span", {}, label, hint ? el("small", { class: "dim" }, ` ${hint}`) : null), c);
  box.append(
    el("h4", { class: "cfg-group" }, "格と景品"),
    el(
      "div",
      { class: "ss-form" },
      field("格", gradeSel, "小・中・大。景品を決めなければ格のはじめの景品"),
      el("label", { class: "tp-adm-check" }, all, el("span", {}, "全員参加", el("small", { class: "dim" }, " 申し込みなしで全部のチームが 2 台で出る (来ない人は代走)"))),
    ),
    el("label", { class: "tp-adm-check" }, useDefTiers, el("span", {}, "順位の景品: 格のはじめの景品を使う")),
    tierBox,
    field("参加賞 (完走したチームみんな)", partMode),
    partBox,
    el("p", { class: "dim ss-foot" }, "中身はギフトコードと同じ一覧から (上限も同じ)。失格・完走できずはもらえません。代走でもチームがもらいます"),
    preview,
  );
  drawTiers();
  drawPart();
  return {
    node: box,
    value: () => ({ grade, allEnter: all.checked, prizes: tiers, participation: part }),
  };
}

/** 格のはじめの景品を、直せる下書きにする */
function defaultsAsDraft(grade: TournamentGrade): PrizeTier[] {
  return defaultTournamentPrizes(grade).tiers.map((t) => ({ from: t.from, to: t.to, items: clone(t.items) }));
}
