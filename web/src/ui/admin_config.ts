// 管理者の画面の「数の調整」(admin.ts から使う): AdminConfig の全部の項目を、組ごとに説明つきで並べる。
// 名前・何が変わるか・単位・幅・組は shared の ADMIN_CONFIG_META (adminconfig_meta.ts) に 1 つずつ。説明の無い項目も
// はじめの数 (defaults) の形から「説明なし」で出る (数・数の並び・入/切・上限 (空 = なし)・中の項目のある物)。
// 使いやすさ: 探す・はじめと違う数の印と「はじめに戻す」・入れたそばからの確かめ・保存の前の「変える前と後」・
// 直前の変更の取り消し・変更の記録と「この版に戻す」・JSON の書き出しと読みこみ・小さな例 (いまの数で計算)。
import {
  ADMIN_CONFIG_GROUPS,
  ADMIN_CONFIG_META,
  adminExport,
  adminFieldMeta,
  adminItemLabel,
  adminLabel,
  adminPreview,
  adminRangeText,
  adminValueText,
  adminErrorTexts,
  applyAdminPatch,
  checkAdminValue,
  cloneAdminConfig,
  diffAdminConfig,
  parseAdminImport,
  type AdminChange,
  type AdminConfig,
  type AdminFieldMeta,
} from "@bpr/shared";
import {
  fetchAdminConfig,
  fetchAdminConfigHistory,
  importAdminConfig,
  resetAdminConfig,
  restoreAdminConfig,
  saveAdminConfig,
  undoAdminConfig,
  type AdminConfigLogRow,
} from "../season_api.ts";
import { errText, toast } from "./account.ts";
import { el } from "./dom.ts";
import "./admin_config.css";

type Kind = "num" | "nullable" | "bool" | "text" | "fixedList" | "list" | "object";

function kindOf(def: unknown, meta: AdminFieldMeta | null): Kind {
  if (def === null || meta?.nullable) return "nullable";
  if (typeof def === "boolean") return "bool";
  if (typeof def === "string") return "text";
  if (Array.isArray(def)) return meta?.len && meta.len[0] === meta.len[1] ? "fixedList" : "list";
  if (def && typeof def === "object") return "object";
  return "num";
}

const ACTION_JP: Record<AdminConfigLogRow["action"], string> = { save: "保存", reset: "はじめに戻す", import: "読みこみ", restore: "版に戻す", undo: "取り消し" };

/** 全角の数・カンマ・空白をならして数に (空は NaN) */
function toNum(raw: string): number {
  const s = raw.normalize("NFKC").replace(/[,\s_]/g, "").replace(/^\+/, "");
  return s === "" ? NaN : Number(s);
}
const fmt = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const jst = (ms: number) => new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

interface Field {
  path: string;
  top: string;
  sub: string | null;
  saved: unknown;
  def: unknown;
  read(): { v: unknown; err: string | null };
  set(v: unknown): void;
  root: HTMLElement;
  errEl: HTMLElement;
  exEl: HTMLElement;
  defBtn: HTMLButtonElement;
  search: string;
}

/** 上にかぶせる板 (確かめ・記録・読みこみ)。.frame の clip-path で切れないよう body に付ける */
function openSheet(title: string, en: string): { body: HTMLElement; foot: HTMLElement; close: () => void } {
  document.querySelector(".cfg-sheet-wrap")?.remove();
  const wrap = el("div", { class: "cfg-sheet-wrap", role: "dialog", "aria-modal": "true", "aria-label": title });
  const shut = el("button", { class: "small ghost", "aria-label": "閉じる" }, "閉じる ✕") as HTMLButtonElement;
  const body = el("div", { class: "cfg-sheet-body" });
  const foot = el("div", { class: "cfg-sheet-foot row" });
  const sheet = el("div", { class: "cfg-sheet" }, el("div", { class: "section-title" }, el("h3", {}, title), el("span", { class: "label" }, en), shut), body, foot);
  wrap.append(sheet);
  const close = () => {
    wrap.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  shut.addEventListener("click", close);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.append(wrap);
  shut.focus();
  return { body, foot, close };
}

/** 変える前と後の表 */
function changeList(changes: readonly AdminChange[], max = Infinity): HTMLElement {
  if (!changes.length) return el("p", { class: "dim" }, "変わる数はありません");
  const ul = el("ul", { class: "cfg-diff" });
  for (const c of changes.slice(0, max))
    ul.append(
      el(
        "li",
        {},
        el("span", { class: "cfg-diff-name" }, adminLabel(c.path)),
        el("span", { class: "cfg-diff-vals num" }, el("s", { class: "dim" }, adminValueText(c.path, c.before)), " → ", el("b", {}, adminValueText(c.path, c.after))),
      ),
    );
  if (changes.length > max) ul.append(el("li", { class: "dim" }, `ほか ${changes.length - max} 個`));
  return ul;
}

/** 「数の調整」の札。onSaved で読み直す */
export async function configEditor(onSaved: () => void): Promise<HTMLElement> {
  const [{ config, defaults }, hist] = await Promise.all([fetchAdminConfig(), fetchAdminConfigHistory().catch(() => ({ entries: [] as AdminConfigLogRow[] }))]);
  const saved = config as unknown as Record<string, unknown>;
  const defs = defaults as unknown as Record<string, unknown>;
  const meta = ADMIN_CONFIG_META as Record<string, AdminFieldMeta | undefined>;
  const reload = () => {
    document.querySelector(".cfg-sheet-wrap")?.remove();
    onSaved();
  };

  const root = el("div", { class: "cfg" });
  const fields: Field[] = [];

  // ---------------------------------------------------------------- 1 つの項目
  const makeField = (path: string, top: string, sub: string | null, savedV: unknown, defV: unknown): Field => {
    const m = adminFieldMeta(path);
    const topMeta = meta[top] ?? null;
    const kind = sub === null ? kindOf(defV, topMeta) : kindOf(defV, null);
    const label = sub === null ? (m?.label ?? top) : (m?.label ?? sub);
    const unit = m?.unit ?? "";
    const rootEl = el("div", { class: "cfg-field", "data-path": path });
    const head = el(
      "div",
      { class: "cfg-head" },
      el("span", { class: "cfg-name" }, label),
      unit ? el("span", { class: "cfg-unit" }, unit) : null,
      m ? null : el("span", { class: "cfg-tag" }, "説明なし"),
      el("span", { class: "cfg-flag", title: "はじめの数と違う" }, "はじめと違う"),
    );
    rootEl.append(head);
    if (m?.help) rootEl.append(el("p", { class: "cfg-help" }, m.help));
    const errEl = el("div", { class: "cfg-err", role: "alert" });
    const exEl = el("ul", { class: "cfg-ex" });
    const live = el("span", { class: "cfg-live num" });
    let read: Field["read"];
    let set: Field["set"];
    const inp = (v: string, aria: string, cls = "") => {
      const i = el("input", { inputmode: "decimal", autocomplete: "off", "aria-label": aria, class: cls }) as HTMLInputElement;
      i.value = v;
      return i;
    };

    if (kind === "bool") {
      const c = el("input", { type: "checkbox", role: "switch", "aria-label": label }) as HTMLInputElement;
      c.checked = savedV === true;
      const word = el("span", { class: "cfg-switch-word" });
      const paint = () => (word.textContent = c.checked ? "入" : "切");
      c.addEventListener("change", paint);
      paint();
      rootEl.append(el("label", { class: "cfg-switch" }, c, el("span", { class: "cfg-switch-track", "aria-hidden": "true" }), word));
      read = () => ({ v: c.checked, err: null });
      set = (v) => {
        c.checked = v === true;
        paint();
      };
    } else if (kind === "text") {
      // 文字 1 行 (お知らせ)。字の数を横に出す
      const max = topMeta?.maxLen;
      const x = el("input", { type: "text", autocomplete: "off", enterkeyhint: "done", "aria-label": label, class: "cfg-wide", placeholder: "空 = 出さない" }) as HTMLInputElement;
      x.value = typeof savedV === "string" ? savedV : "";
      rootEl.append(el("div", { class: "cfg-inrow" }, x, live));
      read = () => {
        const n = Array.from(x.value).length;
        live.textContent = max ? `${n} / ${max} 字` : `${n} 字`;
        return { v: x.value, err: null };
      };
      set = (v) => (x.value = typeof v === "string" ? v : "");
    } else if (kind === "fixedList") {
      const arr = Array.isArray(savedV) ? savedV : [];
      const n = Array.isArray(defV) ? defV.length : arr.length;
      const grid = el("div", { class: "cfg-grid" });
      const ins: HTMLInputElement[] = [];
      for (let i = 0; i < n; i++) {
        const name = adminItemLabel(path, i);
        const x = inp(fmt(arr[i]), `${label} ${name}`);
        ins.push(x);
        grid.append(el("label", { class: "cfg-cell" }, el("span", { class: "cfg-cell-name" }, name), x));
      }
      rootEl.append(grid);
      read = () => {
        const v = ins.map((x) => toNum(x.value));
        const bad = v.findIndex((x) => !Number.isFinite(x));
        return { v, err: bad >= 0 ? `${adminItemLabel(path, bad)}: 数を入れてください` : null };
      };
      set = (v) => {
        const a = Array.isArray(v) ? v : [];
        ins.forEach((x, i) => (x.value = fmt(a[i])));
      };
    } else if (kind === "list") {
      const x = inp(Array.isArray(savedV) ? savedV.join(", ") : "", label, "cfg-wide");
      x.setAttribute("inputmode", "text");
      x.placeholder = "カンマで区切る (例: 300, 150)";
      rootEl.append(el("div", { class: "cfg-inrow" }, x, live));
      read = () => {
        const parts = x.value.normalize("NFKC").split(/[,、\s]+/).filter(Boolean);
        const v = parts.map((p) => toNum(p));
        const bad = v.findIndex((n) => !Number.isFinite(n));
        live.textContent = `${v.length} 個`;
        return { v, err: bad >= 0 ? `${bad + 1} 個目「${parts[bad]}」が数ではありません` : null };
      };
      set = (v) => (x.value = Array.isArray(v) ? v.join(", ") : "");
    } else {
      // 数 / 上限 (空 = なし)
      const x = inp(fmt(savedV), label);
      if (kind === "nullable") x.placeholder = "空 = なし";
      rootEl.append(el("div", { class: "cfg-inrow" }, x, live));
      read = () => {
        const raw = x.value.trim();
        if (kind === "nullable" && raw === "") {
          live.textContent = "上限なし";
          return { v: null, err: null };
        }
        const v = toNum(raw);
        live.textContent = Number.isFinite(v) && unit === "割合" ? `= ${Math.round(v * 10000) / 100}%` : Number.isFinite(v) && unit === "円" ? `${v.toLocaleString("ja-JP")} 円` : "";
        return { v, err: Number.isFinite(v) ? null : "数を入れてください" };
      };
      set = (v) => (x.value = fmt(v));
    }

    const range = adminRangeText(path);
    const defBtn = el("button", { class: "small ghost cfg-defbtn", type: "button" }, "はじめに戻す") as HTMLButtonElement;
    rootEl.append(
      el("div", { class: "cfg-meta" }, range ? el("span", {}, `幅 ${range}`) : null, el("span", {}, `はじめ ${adminValueText(path, defV)}`), defBtn),
      errEl,
      exEl,
    );
    const f: Field = { path, top, sub, saved: savedV, def: defV, read, set, root: rootEl, errEl, exEl, defBtn, search: `${adminLabel(path)} ${m?.help ?? ""} ${path}`.toLowerCase() };
    defBtn.addEventListener("click", () => {
      f.set(defV);
      refresh();
    });
    rootEl.addEventListener("input", () => refresh());
    rootEl.addEventListener("change", () => refresh());
    return f;
  };

  // ---------------------------------------------------------------- 組ごとに並べる
  const topKeys = Object.keys(defs);
  const groups = [...ADMIN_CONFIG_GROUPS.map((g) => ({ ...g })), { id: "other", label: "その他 (説明なし)", en: "Other" }];
  const groupOf = (k: string) => meta[k]?.group ?? "other";
  const sections: Array<{ sec: HTMLElement; list: HTMLElement; count: HTMLElement; fields: Field[] }> = [];
  const nav = el("nav", { class: "cfg-chips", "aria-label": "数の組" });
  for (const g of groups) {
    // 説明の表の順、そのあとに説明の無い項目
    const keys = [...Object.keys(meta).filter((k) => topKeys.includes(k) && groupOf(k) === g.id), ...topKeys.filter((k) => !meta[k] && g.id === "other")];
    if (!keys.length) continue;
    const list = el("div", { class: "cfg-list" });
    const count = el("span", { class: "cfg-count num" });
    const sec = el("section", { class: "cfg-sec", id: `cfg-g-${g.id}` }, el("h4", { class: "cfg-sec-title" }, el("span", {}, g.label), el("span", { class: "label" }, g.en), count), list);
    const mine: Field[] = [];
    for (const k of keys) {
      const dv = defs[k];
      if (dv && typeof dv === "object" && !Array.isArray(dv)) {
        // 中の項目のある物: 見出しを付けて中ごとに
        const m = meta[k];
        list.append(el("div", { class: "cfg-subhead" }, el("b", {}, m?.label ?? k), m?.help ? el("span", { class: "dim" }, ` ${m.help}`) : null, m ? null : el("span", { class: "cfg-tag" }, "説明なし")));
        const sv = (saved[k] ?? {}) as Record<string, unknown>;
        for (const sk of Object.keys(dv as Record<string, unknown>)) {
          const fl = makeField(`${k}.${sk}`, k, sk, sv[sk], (dv as Record<string, unknown>)[sk]);
          mine.push(fl);
          list.append(fl.root);
        }
      } else {
        const fl = makeField(k, k, null, saved[k], dv);
        mine.push(fl);
        list.append(fl.root);
      }
    }
    fields.push(...mine);
    sections.push({ sec, list, count, fields: mine });
    const chip = el("button", { class: "small", type: "button" }, g.label) as HTMLButtonElement;
    chip.addEventListener("click", () => sec.scrollIntoView({ behavior: "smooth", block: "start" }));
    nav.append(chip);
  }

  // ---------------------------------------------------------------- 上の道具
  const search = el("input", { type: "search", class: "cfg-search", placeholder: "数を探す (例: 賞金・リーグ・手数料)", "aria-label": "数を探す" }) as HTMLInputElement;
  const found = el("span", { class: "dim cfg-found" });
  const btn = (text: string, cls = "small") => el("button", { class: cls, type: "button" }, text) as HTMLButtonElement;
  const undoB = btn("直前の変更を取り消す");
  const histB = btn("変更の記録");
  const expB = btn("JSON で書き出す");
  const impB = btn("JSON を読みこむ");
  const resetB = btn("全部はじめに戻す", "small ghost");
  const last = hist.entries[0];
  undoB.disabled = !last;
  if (last) undoB.title = `${jst(last.at)} の${ACTION_JP[last.action]}を取り消す`;

  root.append(
    el(
      "section",
      { class: "frame cfg-top" },
      el("div", { class: "section-title" }, el("h3", {}, "管理者が変えられる数"), el("span", { class: "label" }, "Config")),
      el("div", { class: "cfg-searchrow" }, search, found),
      nav,
      el("div", { class: "row cfg-tools" }, undoB, histB, expB, impB, resetB),
      el(
        "p",
        { class: "dim cfg-note" },
        `項目 ${topKeys.length} 個。`,
        el("span", { class: "cfg-legend is-custom" }, "はじめと違う"),
        " ",
        el("span", { class: "cfg-legend is-pending" }, "まだ保存していない"),
        last ? ` 最後の変更: ${jst(last.at)} (${last.admin ?? "?"}・${ACTION_JP[last.action]})` : " 変更の記録はまだありません",
      ),
    ),
  );
  for (const s of sections) root.append(s.sec);
  const empty = el("div", { class: "frame dim cfg-empty" }, "その言葉の数はありません");
  empty.hidden = true;
  root.append(empty);

  // 下の帯: 変えた数の数と「変える前と後」
  const barText = el("span", { class: "cfg-bar-text" });
  const reviewB = btn("変える前と後を見る", "go");
  const revertB = btn("入力を戻す", "small ghost");
  const bar = el("div", { class: "cfg-bar" }, barText, el("div", { class: "row" }, revertB, reviewB));
  root.append(bar);

  // ---------------------------------------------------------------- 読む・確かめる・例
  /** 今の入力 → 変えた項目 (patch)・悪い項目・確かめたあとの数 */
  const collect = () => {
    const vals = new Map<Field, { v: unknown; err: string | null }>();
    for (const f of fields) {
      const r = f.read();
      vals.set(f, { v: r.v, err: r.err ?? checkAdminValue(f.path, r.v) });
    }
    const patch: Record<string, unknown> = {};
    const draft = cloneAdminConfig(config) as unknown as Record<string, unknown>;
    for (const k of topKeys) {
      const fs = fields.filter((f) => f.top === k);
      if (!fs.length) continue;
      if (fs[0].sub !== null) {
        const obj = Object.fromEntries(fs.map((f) => [f.sub!, vals.get(f)!.v]));
        if (!same(obj, saved[k])) patch[k] = obj;
        draft[k] = Object.fromEntries(fs.map((f) => [f.sub!, vals.get(f)!.err ? f.saved : vals.get(f)!.v]));
      } else {
        const r = vals.get(fs[0])!;
        if (!same(r.v, saved[k])) patch[k] = r.v;
        if (!r.err) draft[k] = r.v;
      }
    }
    // サーバーと同じ確かめ (説明の幅に無い決まりもここで見つかる)
    const check = Object.keys(patch).length ? applyAdminPatch(config, patch) : null;
    const serverBad = check && !check.ok ? check.errors : [];
    return { vals, patch, draft: draft as unknown as AdminConfig, serverBad, merged: check && check.ok ? check.config : null };
  };

  function refresh() {
    const { vals, patch, draft, serverBad } = collect();
    let bad = 0;
    let pending = 0;
    for (const f of fields) {
      const r = vals.get(f)!;
      const err = r.err ?? (serverBad.includes(f.top) && f.top in patch ? "サーバーの確かめに通りません" : null);
      if (err) bad++;
      const isPending = !same(r.v, f.saved);
      if (isPending) pending++;
      f.errEl.textContent = err ?? "";
      f.root.classList.toggle("is-bad", !!err);
      f.root.classList.toggle("is-pending", isPending);
      f.root.classList.toggle("is-custom", !same(r.v, f.def));
      f.defBtn.hidden = same(r.v, f.def);
      // 例 (いまの入力で)
      const ex = adminPreview(f.path, draft);
      f.exEl.replaceChildren(...ex.map((t) => el("li", {}, t)));
      f.exEl.hidden = !ex.length;
    }
    const changed = Object.keys(patch).length;
    bar.classList.toggle("on", changed > 0);
    barText.replaceChildren(
      changed ? el("b", {}, `変えた数 ${pending} 個`) : el("span", { class: "dim" }, "変えた数はありません"),
      bad ? el("span", { class: "bad" }, ` · 直す所 ${bad} 個`) : "",
    );
    reviewB.disabled = changed === 0;
    revertB.disabled = changed === 0;
  }

  // ---------------------------------------------------------------- 探す
  const applySearch = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const s of sections) {
      let n = 0;
      for (const f of s.fields) {
        const hit = !q || f.search.includes(q);
        f.root.hidden = !hit;
        if (hit) n++;
      }
      // 中の項目の見出しは、その中が 1 つでも出ていれば出す
      for (const h of s.list.querySelectorAll<HTMLElement>(".cfg-subhead")) {
        let next = h.nextElementSibling as HTMLElement | null;
        let any = false;
        while (next && next.classList.contains("cfg-field")) {
          if (!next.hidden) any = true;
          next = next.nextElementSibling as HTMLElement | null;
        }
        h.hidden = !any;
      }
      s.sec.hidden = n === 0;
      s.count.textContent = q ? `${n} / ${s.fields.length}` : `${s.fields.length}`;
      shown += n;
    }
    found.textContent = q ? `${shown} 個` : "";
    empty.hidden = shown > 0;
  };
  search.addEventListener("input", applySearch);

  // ---------------------------------------------------------------- 保存 (変える前と後を見てから)
  reviewB.addEventListener("click", () => {
    const { patch, serverBad, merged, vals } = collect();
    const errs = fields.filter((f) => vals.get(f)!.err).map((f) => `${adminLabel(f.path)}: ${vals.get(f)!.err}`);
    const sh = openSheet("変える前と後", "Review");
    if (errs.length || serverBad.length) {
      sh.body.append(el("p", { class: "bad" }, "直す所があるので、まだ保存できません"), el("ul", { class: "cfg-errs" }, ...(errs.length ? errs : adminErrorTexts(serverBad, patch)).map((t) => el("li", {}, t))));
      const ok = btn("もどって直す", "go");
      ok.addEventListener("click", sh.close);
      sh.foot.append(ok);
      return;
    }
    const changes = merged ? diffAdminConfig(config, merged) : [];
    sh.body.append(el("p", { class: "dim" }, `${changes.length} 個の数を変えます。賞金はこのあとのレースと季節の締めから効きます。記録に残り、あとで取り消せます。`), changeList(changes));
    const save = btn("保存する", "go");
    const cancel = btn("もどる", "ghost");
    cancel.addEventListener("click", sh.close);
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveAdminConfig(patch as Partial<AdminConfig>);
        toast(`保存しました (${changes.length} 個)`);
        reload();
      } catch (e) {
        save.disabled = false;
        toast(errText(e), true);
      }
    });
    sh.foot.append(cancel, save);
  });

  revertB.addEventListener("click", () => {
    for (const f of fields) f.set(f.saved);
    refresh();
  });

  // ---------------------------------------------------------------- 取り消し・記録・版に戻す
  undoB.addEventListener("click", () => {
    if (!last) return;
    const sh = openSheet("直前の変更を取り消す", "Undo");
    sh.body.append(
      el("p", { class: "dim" }, `${jst(last.at)} に ${last.admin ?? "?"} がした「${ACTION_JP[last.action]}」の前の数に戻します。`),
      changeList(last.changes.map((c) => ({ path: c.path, before: c.after, after: c.before }))),
    );
    const go = btn("取り消す", "go");
    const cancel = btn("もどる", "ghost");
    cancel.addEventListener("click", sh.close);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await undoAdminConfig();
        toast("取り消しました");
        reload();
      } catch (e) {
        go.disabled = false;
        toast(errText(e), true);
      }
    });
    sh.foot.append(cancel, go);
  });

  histB.addEventListener("click", async () => {
    const sh = openSheet("変更の記録", "History");
    sh.body.append(el("p", { class: "dim" }, "読みこんでいます…"));
    let rows: AdminConfigLogRow[];
    try {
      rows = (await fetchAdminConfigHistory()).entries;
    } catch (e) {
      sh.body.replaceChildren(el("p", { class: "bad" }, errText(e)));
      return;
    }
    sh.body.replaceChildren(el("p", { class: "dim" }, `新しい物から ${rows.length} 件 (200 件まで残ります)。「この版に戻す」は、その変更のあとの数に戻します (今の確かめを通してから)。`));
    if (!rows.length) sh.body.append(el("p", {}, "まだ記録はありません"));
    const ol = el("ol", { class: "cfg-hist" });
    rows.forEach((r, i) => {
      const back = btn(i === 0 ? "今の版" : "この版に戻す");
      back.disabled = i === 0;
      back.addEventListener("click", async () => {
        if (!confirm(`${jst(r.at)} の「${ACTION_JP[r.action]}」のあとの数に戻します。よいですか?`)) return;
        back.disabled = true;
        try {
          await restoreAdminConfig(r.id);
          toast("その版に戻しました");
          reload();
        } catch (e) {
          back.disabled = false;
          toast(errText(e), true);
        }
      });
      ol.append(
        el(
          "li",
          { class: "cfg-hist-row" },
          el(
            "div",
            { class: "cfg-hist-head" },
            el("span", { class: "num" }, `#${r.id}`),
            el("b", {}, ACTION_JP[r.action] ?? r.action),
            el("span", { class: "dim" }, `${jst(r.at)} · ${r.admin ?? "?"}${r.ref ? ` · #${r.ref} から` : ""}`),
            back,
          ),
          changeList(r.changes, 6),
        ),
      );
    });
    sh.body.append(ol);
  });

  // ---------------------------------------------------------------- 書き出し・読みこみ
  expB.addEventListener("click", () => {
    const now = Date.now();
    const text = JSON.stringify(adminExport(config, now), null, 2);
    const stamp = new Date(now + 9 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: `bpr-config-${stamp}.json` }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("今の数を JSON で書き出しました");
  });

  impB.addEventListener("click", () => {
    const sh = openSheet("JSON を読みこむ", "Import");
    const ta = el("textarea", { class: "cfg-ta", rows: "10", spellcheck: "false", "aria-label": "JSON", placeholder: '{ "config": { "prizePerPoint": 20, … } }  (書き出した物か、その一部)' }) as HTMLTextAreaElement;
    const file = el("input", { type: "file", accept: "application/json,.json", "aria-label": "JSON のファイル" }) as HTMLInputElement;
    const out = el("div", { class: "cfg-imp-out" });
    const checkB = btn("確かめる", "primary");
    const applyB = btn("読みこんで保存", "go");
    applyB.disabled = true;
    let parsed: AdminConfig | null = null;
    const check = () => {
      parsed = null;
      applyB.disabled = true;
      if (!ta.value.trim()) return out.replaceChildren();
      const r = parseAdminImport(ta.value, config);
      if (!r.ok) {
        out.replaceChildren(el("p", { class: "bad" }, "読みこめません"), el("ul", { class: "cfg-errs" }, ...r.errors.map((t) => el("li", {}, t))));
        return;
      }
      parsed = r.config;
      applyB.disabled = r.changes.length === 0;
      out.replaceChildren(el("p", { class: "good" }, `確かめました。${r.changes.length} 個の数が変わります (書いていない項目は今のまま)`), changeList(r.changes));
    };
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      ta.value = await f.text();
      check();
    });
    checkB.addEventListener("click", check);
    ta.addEventListener("input", () => {
      parsed = null;
      applyB.disabled = true;
    });
    applyB.addEventListener("click", async () => {
      if (!parsed) return;
      applyB.disabled = true;
      try {
        await importAdminConfig(parsed);
        toast("読みこんで保存しました");
        reload();
      } catch (e) {
        applyB.disabled = false;
        toast(errText(e), true);
      }
    });
    sh.body.append(el("p", { class: "dim" }, "書き出した JSON を貼るか、ファイルを選びます。保存の前に確かめて、変わる数を見せます。"), ta, el("div", { class: "row" }, file, checkB), out);
    const cancel = btn("もどる", "ghost");
    cancel.addEventListener("click", sh.close);
    sh.foot.append(cancel, applyB);
  });

  resetB.addEventListener("click", () => {
    const changes = diffAdminConfig(config, defaults);
    const sh = openSheet("全部はじめに戻す", "Reset");
    sh.body.append(el("p", { class: "dim" }, "全部の数をはじめの値に戻します。記録に残り、取り消せます。"), changeList(changes));
    const go = btn("はじめに戻す", "go");
    go.disabled = changes.length === 0;
    const cancel = btn("もどる", "ghost");
    cancel.addEventListener("click", sh.close);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await resetAdminConfig();
        toast("はじめの数に戻しました");
        reload();
      } catch (e) {
        go.disabled = false;
        toast(errText(e), true);
      }
    });
    sh.foot.append(cancel, go);
  });

  refresh();
  applySearch();
  return root;
}
