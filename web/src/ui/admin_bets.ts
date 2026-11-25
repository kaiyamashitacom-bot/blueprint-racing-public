// 管理者の画面の「賭け」: 賭けの量と胴元の取り分 (全部・今日)・結果待ち・返した額・一時停止の入/切。
// 上限・取り分・締め切りは「数の調整」の 賭け の組で変える (AdminConfig)
import { fetchBetStats, setBetPaused, type BetAdminStats, type BetStatsPart } from "../bets_api.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";

export async function betsAdminSection(reload: () => void): Promise<HTMLElement> {
  const s: BetAdminStats = await fetchBetStats();
  const box = el("div", { class: "stack" });
  const state = s.realMoneyEnabled ? "止めています (本物のお金を入れたため。見直しが済むまで)" : s.paused ? "一時停止中" : "受けています";
  const toggle = el("button", { class: s.paused ? "primary" : "small" }, s.paused ? "賭けを再開する" : "一時停止する") as HTMLButtonElement;
  toggle.disabled = s.realMoneyEnabled;
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      await setBetPaused(!s.paused);
      toast(s.paused ? "賭けを再開しました" : "賭けを一時停止しました");
      reload();
    } catch (e) {
      toast(errText(e), true);
      toggle.disabled = false;
    }
  });
  box.append(
    el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "賭け"), el("span", { class: "label" }, "Betting")),
      el("p", { style: "margin:0 0 10px" }, `今: ${state} · 胴元の取り分 ${Math.round(s.margin * 100)}% · 賭けた人 ${s.players}`),
      toggle,
      el("p", { class: "dim", style: "margin:10px 0 0;font-size:12px" }, "ゲームの中のお金だけ。上限・取り分・締め切りは「数の調整」の 賭け で変えます。"),
    ),
    statsFrame("今日 (日本時間)", "Today", s.today),
    statsFrame("全部", "All time", s.all),
    el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "結果待ち・返した額"), el("span", { class: "label" }, "Open / refunded")),
      table([
        ["結果待ち", `${s.open.bets} 件 · ${money(s.open.staked)} 円`],
        ["返した (計算できなかった など)", `${s.refunded.bets} 件 · ${money(s.refunded.staked)} 円`],
      ]),
    ),
  );
  return box;
}

function statsFrame(title: string, en: string, p: BetStatsPart): HTMLElement {
  return el(
    "section",
    { class: "frame" },
    el("div", { class: "section-title" }, el("h3", {}, title), el("span", { class: "label" }, en)),
    table([
      ["決まった賭け", `${p.bets} 件 (当たり ${p.won})`],
      ["賭けた額", `${money(p.staked)} 円`],
      ["払った額", `${money(p.paid)} 円`],
      ["胴元の取り分 (賭けた − 払った)", `${p.houseTake >= 0 ? "" : "−"}${money(Math.abs(p.houseTake))} 円${p.staked ? ` (${Math.round((p.houseTake / p.staked) * 1000) / 10}%)` : ""}`],
    ]),
  );
}

function table(rows: Array<[string, string]>): HTMLElement {
  const t = el("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;font-size:14px" });
  for (const [k, v] of rows) t.append(el("span", { class: "dim" }, k), el("b", { class: "tm-num", style: "text-align:right" }, v));
  return t;
}
