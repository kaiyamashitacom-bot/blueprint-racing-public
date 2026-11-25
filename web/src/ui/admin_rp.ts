// 管理者の画面の「走行点」(admin.ts から使う): 出した点・使われた点の合計と、交換所の一覧 (足す・直す・並べ替え・しまう / 出す・消す)。
// 中身の入力はギフトコードと同じ (admin_gifts.ts の itemsEditor。登録表 GIFT_KINDS に足された物は自動で並ぶ)。
// 点の入り方・1 日の上限・入 / 切 は「数の調整」の「走行点」の組 (AdminConfig の rp*)
import { RP_LIMIT_MAX, RP_NAME_MAX, RP_NOTE_MAX, RP_PRICE_MAX, rpLimitText, type GiftItem } from "@bpr/shared";
import { fetchGiftOptions } from "../gift_api.ts";
import { createRpEntry, deleteRpEntry, fetchRpAdmin, updateRpEntry, type RpAdminEntry, type RpEntryInput } from "../rp_api.ts";
import { errText, money, toast } from "./account.ts";
import { defaultParams, itemsEditor } from "./admin_gifts.ts";
import { el } from "./dom.ts";
import "./gift.css";
import "./exchange.css";

/** 管理者の画面の「走行点」のタブ。onChange で読み直す */
export async function rpAdminSection(onChange: () => void): Promise<HTMLElement> {
  const [v, drivers] = await Promise.all([fetchRpAdmin(), fetchGiftOptions().then((r) => r.drivers).catch(() => [])]);
  const wrap = el("div", { class: "stack" });

  // ---- 合計
  const t = v.totals;
  const kinds = el("table", { class: "results ss-table" });
  kinds.append(el("thead", {}, el("tr", {}, el("th", {}, "種類"), el("th", { class: "r" }, "出した点"), el("th", { class: "r" }, "使われた点"))));
  const kb = el("tbody");
  for (const k of t.byKind) kb.append(el("tr", {}, el("td", {}, k.kindJp), el("td", { class: "r num" }, money(k.issued)), el("td", { class: "r num" }, money(k.spent))));
  if (!t.byKind.length) kb.append(el("tr", {}, el("td", { colspan: "3", class: "dim" }, "まだ出入りがありません")));
  kinds.append(kb);
  wrap.append(
    el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "走行点の合計"), el("span", { class: "label" }, v.on ? "Race points · ON" : "Race points · OFF")),
      el(
        "div",
        { class: "xc-strip" },
        el("div", { class: "xc-cash" }, el("span", { class: "label" }, "Issued"), el("b", { class: "tm-num" }, money(t.issued)), el("small", {}, `出した点 (今日 ${money(t.issuedToday)})`)),
        el("div", { class: "xc-cash" }, el("span", { class: "label" }, "Spent"), el("b", { class: "tm-num" }, money(t.spent)), el("small", {}, "交換で使われた点")),
        el("div", { class: "xc-cash" }, el("span", { class: "label" }, "Held"), el("b", { class: "tm-num" }, money(t.outstanding)), el("small", {}, `みんなの手元 (${t.holders} 人)`)),
      ),
      el("div", { class: "ss-scroll", style: "margin-top:10px" }, kinds),
      el("p", { class: "dim ss-foot" }, `点の入り方・1 日の上限・入 / 切 は「数の調整」の「走行点」で変えます。${v.on ? "" : "今は 切 (たまらず、交換もできない)。"}`),
    ),
  );

  // ---- 足す / 直す
  const formBox = el("div");
  let editing: RpAdminEntry | null = null;
  const drawForm = () => {
    formBox.innerHTML = "";
    const g = editing;
    const items: GiftItem[] = g ? g.items.map((x) => ({ kind: x.kind, p: { ...x.p } })) : [{ kind: "item", p: defaultParams("item", drivers) }];
    const name = el("input", { maxlength: String(RP_NAME_MAX), placeholder: "交換所に出る名前" }) as HTMLInputElement;
    name.value = g?.name ?? "";
    const note = el("input", { maxlength: String(RP_NOTE_MAX), placeholder: "なくてよい (遊ぶ人に見える説明)" }) as HTMLInputElement;
    note.value = g?.note ?? "";
    const price = el("input", { type: "number", min: "1", max: String(RP_PRICE_MAX), inputmode: "numeric" }) as HTMLInputElement;
    price.value = String(g?.price ?? 100);
    const week = el("input", { type: "number", min: "1", max: String(RP_LIMIT_MAX), inputmode: "numeric", placeholder: "空 = なし" }) as HTMLInputElement;
    week.value = g?.limitWeek == null ? "" : String(g.limitWeek);
    const total = el("input", { type: "number", min: "1", max: String(RP_LIMIT_MAX), inputmode: "numeric", placeholder: "空 = なし" }) as HTMLInputElement;
    total.value = g?.limitTotal == null ? "" : String(g.limitTotal);
    const hidden = el("input", { type: "checkbox" }) as HTMLInputElement;
    hidden.checked = g?.hidden ?? false;
    const field = (label: string, c: HTMLElement, hint = "") => el("label", { class: "ss-field" }, el("span", {}, label, hint ? el("small", { class: "dim" }, ` ${hint}`) : null), c);
    const f = el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, g ? `「${g.name}」を直す` : "交換所に足す"), el("span", { class: "label" }, g ? "Edit" : "New")),
      el(
        "div",
        { class: "ss-form" },
        field("名前", name, `${RP_NAME_MAX} 字まで`),
        field("説明", note),
        field("値段 (走行点)", price),
        field("1 人 週に", week, "回まで (月曜はじまり)"),
        field("1 人 全部で", total, "回まで"),
        field("しまう", hidden, "入 = 交換所に出さない"),
      ),
      el("h4", { class: "cfg-group" }, "中身 (交換した人が受け取る)"),
      itemsEditor(items, drivers),
      el("p", { class: "dim ss-foot" }, "交換は 1 回の取りまとめ: 点を引いて中身を当てる。1 つでも当てられない (研究していない・持てる数を超える など) ときは点も戻ります。黄色の縁の中身 (部・級) は次の区切りで効きます"),
    );
    const save = el("button", { class: "go" }, g ? "直す" : "足す") as HTMLButtonElement;
    save.addEventListener("click", async () => {
      const input: RpEntryInput = {
        name: name.value.trim(),
        note: note.value.trim(),
        items,
        price: Number(price.value),
        limitWeek: week.value.trim() ? Number(week.value) : null,
        limitTotal: total.value.trim() ? Number(total.value) : null,
        hidden: hidden.checked,
      };
      save.disabled = true;
      try {
        if (g) await updateRpEntry(g.id, input);
        else await createRpEntry(input);
        toast(g ? "直しました" : "足しました");
        editing = null;
        onChange();
      } catch (e) {
        toast(errText(e), true);
      } finally {
        save.disabled = false;
      }
    });
    const row = el("div", { class: "row", style: "margin-top:12px" }, save);
    if (g) {
      const cancel = el("button", { class: "ghost" }, "やめる");
      cancel.addEventListener("click", () => {
        editing = null;
        drawForm();
      });
      row.append(cancel);
    }
    f.append(row);
    formBox.append(f);
  };
  drawForm();

  // ---- 一覧
  const list = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "交換所の一覧"), el("span", { class: "label" }, `${v.shop.length}`)));
  if (!v.shop.length) list.append(el("p", { class: "dim", style: "margin:0" }, "まだありません"));
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      onChange();
    } catch (e) {
      toast(errText(e), true);
    }
  };
  v.shop.forEach((g, i) => {
    const edit = el("button", { class: "small" }, "直す");
    edit.addEventListener("click", () => {
      editing = g;
      drawForm();
      formBox.scrollIntoView({ behavior: "smooth" });
    });
    const hide = el("button", { class: "small" }, g.hidden ? "出す" : "しまう");
    hide.addEventListener("click", () => void act(() => updateRpEntry(g.id, { hidden: !g.hidden }), g.hidden ? "出しました" : "しまいました"));
    // 並べ替え: となりと sort を入れかえる
    const swap = (j: number) => {
      const o = v.shop[j];
      if (!o) return;
      const a = g.sort === o.sort ? g.sort + (j < i ? 1 : -1) : g.sort;
      void act(async () => {
        await updateRpEntry(g.id, { sort: o.sort });
        await updateRpEntry(o.id, { sort: a });
      }, "並べ替えました");
    };
    const up = el("button", { class: "small ghost", "aria-label": `${g.name} を上へ` }, "↑") as HTMLButtonElement;
    up.disabled = i === 0;
    up.addEventListener("click", () => swap(i - 1));
    const down = el("button", { class: "small ghost", "aria-label": `${g.name} を下へ` }, "↓") as HTMLButtonElement;
    down.disabled = i === v.shop.length - 1;
    down.addEventListener("click", () => swap(i + 1));
    const del = el("button", { class: "small ghost" }, "消す");
    del.addEventListener("click", () => {
      if (!confirm(`「${g.name}」を交換所から消します (交換された記録は残ります)。よいですか?`)) return;
      void act(() => deleteRpEntry(g.id), "消しました");
    });
    const meta = [`${money(g.price)} 点`, rpLimitText(g) || "回数の制限なし", `交換された ${g.sold} 回`, g.note || null].filter(Boolean);
    list.append(
      el(
        "div",
        { class: "gift-adm-row" },
        el("div", {}, el("span", { class: "gift-adm-code" }, g.name)),
        el("span", { class: `gift-state ${g.hidden ? "paused" : "active"}` }, g.hidden ? "しまっている" : "出している"),
        el("div", { class: "lines" }, g.lines.join(" · ")),
        el("div", { class: "meta" }, meta.join(" · ")),
        el("div", { class: "acts" }, edit, hide, up, down, del),
      ),
    );
  });
  wrap.append(formBox, list);
  return wrap;
}
