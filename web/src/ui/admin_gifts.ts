// 管理者の画面の「ギフト」(admin.ts から使う): コードを作る・直す・止める / 戻す・消す・誰がいつ使ったか。
// 中身の入力欄は shared/src/gift.ts の登録表 (GIFT_KINDS) から作るので、種類を足すとここにも自動で並ぶ。
// コードの文字は画面にもコードにも書かない (作るときに管理者が打つか、おまかせ)
import {
  GIFT_KINDS,
  PARTS,
  giftPartChoices,
  giftFieldOptions,
  giftKind,
  type GiftCaps,
  type GiftFieldDef,
  type GiftItem,
  type GiftKindId,
} from "@bpr/shared";
import { createGiftCode, deleteGiftCode, fetchGiftCodes, fetchGiftLog, fetchGiftOptions, updateGiftCode, type GiftCodeRow, type GiftInput } from "../gift_api.ts";
import { errText, toast } from "./account.ts";
import { el } from "./dom.ts";
import "./gift.css";

type Drivers = Array<{ id: string; name: string; overall: number; team: string | null }>;

const STATE_JP: Record<GiftCodeRow["state"], string> = { active: "使える", paused: "止めている", expired: "期限切れ", used_up: "使い切り" };

/** 日本時間の datetime-local の値 ⇄ ms */
function toLocalInput(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 16);
}
function fromLocalInput(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600_000;
}
const jst = (ms: number) => new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 項目のはじめの値 (大会の景品の入力でも使う) */
export function defaultParams(kind: GiftKindId, drivers: Drivers): GiftItem["p"] {
  const p: GiftItem["p"] = {};
  for (const f of giftKind(kind)!.fields) {
    if (f.def !== undefined) p[f.key] = f.def;
    else if (f.optional) p[f.key] = "";
    else if (f.type === "part") p[f.key] = PARTS[0].id;
    else if (f.type === "driver") p[f.key] = drivers.find((d) => d.team === null)?.id ?? drivers[0]?.id ?? "";
    else if (f.type === "text") p[f.key] = "";
    else p[f.key] = giftFieldOptions(f)[0]?.value ?? "";
  }
  return p;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

/** 項目 1 つの入力欄 (登録表の形から) */
function fieldControl(f: GiftFieldDef, value: string | number, drivers: Drivers, onChange: (v: string | number) => void): HTMLElement {
  let c: HTMLInputElement | HTMLSelectElement;
  if (f.type === "int") {
    c = el("input", { type: "number", inputmode: "numeric", step: "1", min: String(f.min ?? ""), max: String(f.max ?? "") }) as HTMLInputElement;
    c.value = String(value);
    c.addEventListener("input", () => onChange(c.value === "" ? "" : Number(c.value)));
  } else if (f.type === "text") {
    c = el("input", { type: "text", maxlength: String(f.maxLen ?? 40) }) as HTMLInputElement;
    c.value = String(value);
    c.addEventListener("input", () => onChange(c.value));
  } else if (f.type === "color") {
    c = el("input", { type: "color" }) as HTMLInputElement;
    c.value = String(value || "#ffffff");
    c.addEventListener("input", () => onChange(c.value));
  } else {
    const s = el("select", {}) as HTMLSelectElement;
    if (f.optional) s.append(option("", f.hint ?? "なし"));
    if (f.type === "part") {
      for (const tier of [1, 2, 3, 4, 5]) {
        const g = el("optgroup", { label: `段階 ${tier}` });
        // お店・研究・進化の部品と、限界を超えた 5+・5++ (shared の giftPartChoices。部品を足すと自動で並ぶ)
        for (const p of giftPartChoices().filter((x) => x.tier === tier)) g.append(option(p.id, `${p.name} (${p.id})`));
        if (g.childElementCount) s.append(g);
      }
    } else if (f.type === "driver") {
      for (const d of drivers) s.append(option(d.id, `${d.name} · 総合 ${d.overall}${d.team ? ` · 契約中: ${d.team}` : ""}`));
    } else for (const o of giftFieldOptions(f)) s.append(option(o.value, o.label));
    s.value = String(value);
    s.addEventListener("change", () => onChange(s.value));
    c = s;
  }
  c.setAttribute("aria-label", f.label);
  return el("label", {}, el("span", {}, f.label, f.hint && f.type !== "research" ? el("small", { class: "dim" }, ` ${f.hint}`) : null), c);
}

/** 中身の入力 (足す・種類を変える・消す)。items は書きかえて使う。大会の景品の入力 (admin.ts) でも使う */
export function itemsEditor(items: GiftItem[], drivers: Drivers): HTMLElement {
  const box = el("div", { class: "gift-adm-items" });
  const draw = () => {
    box.innerHTML = "";
    items.forEach((it, i) => {
      const def = giftKind(it.kind)!;
      const kindSel = el("select", { "aria-label": "中身の種類" }) as HTMLSelectElement;
      for (const k of GIFT_KINDS) kindSel.append(option(k.id, k.label));
      kindSel.value = it.kind;
      kindSel.addEventListener("change", () => {
        const kind = kindSel.value as GiftKindId;
        items[i] = { kind, p: defaultParams(kind, drivers) };
        draw();
      });
      const fields = el("div", { class: "gift-adm-item-fields" }, el("label", { class: "kind" }, el("span", {}, `中身 ${i + 1}`), kindSel));
      for (const f of def.fields) fields.append(fieldControl(f, it.p[f.key] ?? "", drivers, (v) => (it.p[f.key] = v)));
      fields.append(el("div", { class: "desc" }, def.desc));
      const del = el("button", { class: "small ghost", type: "button", "aria-label": `中身 ${i + 1} を消す` }, "✕");
      del.addEventListener("click", () => {
        items.splice(i, 1);
        draw();
      });
      box.append(el("div", { class: `gift-adm-item${def.deferred ? " deferred" : ""}` }, fields, el("div", {}, del)));
    });
    const add = el("select", { "aria-label": "足す中身の種類" }) as HTMLSelectElement;
    for (const k of GIFT_KINDS) add.append(option(k.id, k.label));
    const addBtn = el("button", { class: "small", type: "button" }, "＋ 中身を足す");
    addBtn.addEventListener("click", () => {
      const kind = add.value as GiftKindId;
      items.push({ kind, p: defaultParams(kind, drivers) });
      draw();
    });
    box.append(el("div", { class: "gift-adm-add" }, add, addBtn));
  };
  draw();
  return box;
}

function capsText(c: GiftCaps): string {
  const bits = [
    c.giftMoneyMax !== null ? `お金 ${c.giftMoneyMax.toLocaleString("ja-JP")} まで` : null,
    c.giftPartTierMax !== null ? `部品 段階 ${c.giftPartTierMax} まで` : null,
    c.giftPartCountMax !== null ? `部品 ${c.giftPartCountMax} 個まで` : null,
    c.giftDiscountMax !== null ? `割引 ${c.giftDiscountMax}% まで` : null,
  ].filter(Boolean);
  return bits.length ? `上限: ${bits.join(" · ")}` : "上限: なし (段階 5 の部品・大金も入れられます)";
}

/** 管理者の画面の「ギフト」のタブ。onChange で読み直す */
export async function giftsSection(onChange: () => void): Promise<HTMLElement> {
  const [{ codes, caps }, { drivers }] = await Promise.all([fetchGiftCodes(), fetchGiftOptions()]);
  const wrap = el("div", { class: "stack" });
  const formBox = el("div");
  let editing: GiftCodeRow | null = null;

  const drawForm = () => {
    formBox.innerHTML = "";
    const g = editing;
    const items: GiftItem[] = g ? g.items.map((x) => ({ kind: x.kind, p: { ...x.p } })) : [{ kind: "money", p: defaultParams("money", drivers) }];
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, g ? `${g.code} を直す` : "ギフトコードを作る"), el("span", { class: "label" }, g ? "Edit" : "New")));
    const code = el("input", { maxlength: "24", autocapitalize: "characters", autocomplete: "off", spellcheck: "false", placeholder: g ? "" : "空ならおまかせ (8 字)", class: "gift-input" }) as HTMLInputElement;
    code.value = g?.code ?? "";
    const uses = el("input", { type: "number", min: "1", inputmode: "numeric", placeholder: "空 = 何人でも" }) as HTMLInputElement;
    uses.value = g?.maxUses === null || g === null ? "" : String(g.maxUses);
    const exp = el("input", { type: "datetime-local" }) as HTMLInputElement;
    exp.value = g?.expiresAt ? toLocalInput(g.expiresAt) : "";
    const targets = el("input", { autocapitalize: "none", spellcheck: "false", placeholder: "空 = 誰でも。ID をカンマで" }) as HTMLInputElement;
    targets.value = g?.targets?.join(", ") ?? "";
    const note = el("input", { maxlength: "60", placeholder: "なくてよい (管理者だけに見える)" }) as HTMLInputElement;
    note.value = g?.note ?? "";
    const field = (label: string, c: HTMLElement, hint = "") => el("label", { class: "ss-field" }, el("span", {}, label, hint ? el("small", { class: "dim" }, ` ${hint}`) : null), c);
    f.append(
      el(
        "div",
        { class: "ss-form" },
        field("コード", code, "英字・数字・_ - で 4〜24 字。大文字小文字は同じ"),
        field("使える人数", uses),
        field("期限", exp, "日本時間。空 = なし"),
        field("使える人", targets, "ログインの ID"),
        field("メモ", note),
      ),
      el("h4", { class: "cfg-group" }, "中身"),
      itemsEditor(items, drivers),
      el("p", { class: "dim ss-foot" }, `${capsText(caps)} · 上限は「数の調整」で付けられます。黄色の縁の中身 (部・級) は次の区切りで効きます`),
    );
    const save = el("button", { class: "go" }, g ? "直す" : "作る") as HTMLButtonElement;
    save.addEventListener("click", async () => {
      const t = exp.value ? fromLocalInput(exp.value) : null;
      if (t !== null && !Number.isFinite(t)) return toast("期限がおかしいです", true);
      const input: GiftInput = {
        code: code.value.trim() || undefined,
        items,
        maxUses: uses.value.trim() ? Number(uses.value) : null,
        expiresAt: t,
        targets: targets.value
          .split(/[,、\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        note: note.value.trim(),
      };
      save.disabled = true;
      try {
        const r = g ? await updateGiftCode(g.id, input) : await createGiftCode(input);
        toast(g ? "直しました" : `作りました: ${r.code.code}`);
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
  wrap.append(formBox);

  // 一覧
  const list = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "ギフトコードの一覧"), el("span", { class: "label" }, `${codes.length}`)));
  if (!codes.length) list.append(el("p", { class: "dim", style: "margin:0" }, "まだありません"));
  for (const g of codes) {
    const logBox = el("div", { class: "gift-adm-log" });
    const edit = el("button", { class: "small" }, "直す");
    edit.addEventListener("click", () => {
      editing = g;
      drawForm();
      formBox.scrollIntoView({ behavior: "smooth" });
    });
    const pause = el("button", { class: "small" }, g.paused ? "戻す" : "止める");
    pause.addEventListener("click", async () => {
      try {
        await updateGiftCode(g.id, { paused: !g.paused });
        toast(g.paused ? "使えるようにしました" : "止めました");
        onChange();
      } catch (e) {
        toast(errText(e), true);
      }
    });
    const log = el("button", { class: "small" }, `使った人 (${g.uses})`);
    log.addEventListener("click", async () => {
      if (logBox.childElementCount) return logBox.replaceChildren();
      try {
        const r = await fetchGiftLog(g.id);
        if (!r.rows.length) return logBox.replaceChildren(el("p", { class: "dim", style: "margin:0" }, "まだ誰も使っていません"));
        const t = el("table", { class: "results ss-table" });
        t.append(el("thead", {}, el("tr", {}, el("th", {}, "いつ"), el("th", {}, "チーム / 運転手"), el("th", {}, "ID"))));
        const tb = el("tbody");
        for (const x of r.rows) tb.append(el("tr", {}, el("td", { class: "num" }, jst(x.at)), el("td", { class: "who" }, x.team, el("small", { class: "dim" }, ` ${x.driver}`)), el("td", { class: "num" }, x.login ?? "(退会)")));
        t.append(tb);
        logBox.replaceChildren(el("div", { class: "ss-scroll" }, t));
      } catch (e) {
        toast(errText(e), true);
      }
    });
    const del = el("button", { class: "small ghost" }, "消す");
    del.addEventListener("click", async () => {
      if (!confirm(`${g.code} を消します。使った人の記録も消えます (受け取ったものはそのまま)。よいですか?`)) return;
      try {
        await deleteGiftCode(g.id);
        toast("消しました");
        onChange();
      } catch (e) {
        toast(errText(e), true);
      }
    });
    const meta = [
      `使った ${g.uses}${g.maxUses === null ? "" : ` / ${g.maxUses}`} 人`,
      g.expiresAt ? `期限 ${jst(g.expiresAt)}` : "期限なし",
      g.targets ? `使える人 ${g.targets.join(", ")}` : "誰でも",
      g.note ? `メモ ${g.note}` : null,
      `作 ${g.createdBy} ${jst(g.createdAt)}`,
    ].filter(Boolean);
    list.append(
      el(
        "div",
        { class: "gift-adm-row" },
        el("div", {}, el("span", { class: "gift-adm-code" }, g.code)),
        el("span", { class: `gift-state ${g.state}` }, STATE_JP[g.state]),
        el("div", { class: "lines" }, g.lines.join(" · ")),
        el("div", { class: "meta" }, meta.join(" · ")),
        el("div", { class: "acts" }, edit, pause, log, del),
        el("div", { style: "grid-column:1/-1" }, logBox),
      ),
    );
  }
  list.append(el("p", { class: "dim ss-foot" }, "コードの文字と使った人の記録はサーバーのデータにだけ残ります。文字を変えても使った人の記録はつながったまま (同じ人はもう受け取れません)"));
  wrap.append(list);
  return wrap;
}
