// 管理者の画面の「遊ぶ人」の続き: 荒らしを止める / 戻す・招かれた人だけ登録できるようにする・招待の合言葉 (admin.ts から使う)
import { fetchAdminConfig, saveAdminConfig } from "../season_api.ts";
import { createInvites, deleteInvite, fetchInvites, setSuspended } from "../rooms_api.ts";
import { errText, toast } from "./account.ts";
import { el } from "./dom.ts";
import "./rooms.css";

/** 1 人の「止める / 戻す」ボタン。押して変わったら onDone (表を読み直す) */
export function suspendButton(p: { login: string; admin: boolean; suspended?: string | null }, onDone: () => void): HTMLElement | null {
  if (p.admin) return null;
  const on = p.suspended !== null && p.suspended !== undefined;
  const b = el("button", { class: on ? "small" : "small ghost adm-stop" }, on ? "止めるのをやめる" : "止める") as HTMLButtonElement;
  b.addEventListener("click", async () => {
    let reason: string | undefined;
    if (!on) {
      const r = prompt(`${p.login} を止めます (ログインもネットのレースもできなくなります)。わけ (なくてもよい、本人には見えません)`, "");
      if (r === null) return;
      reason = r;
    } else if (!confirm(`${p.login} を止めるのをやめますか?`)) return;
    try {
      await setSuspended(p.login, !on, reason);
      toast(on ? "戻しました" : "止めました");
      onDone();
    } catch (e) {
      toast(errText(e), true);
    }
  });
  return b;
}

/** 止められている印 */
export function suspendedTag(p: { suspended?: string | null }): HTMLElement | null {
  if (p.suspended === null || p.suspended === undefined) return null;
  return el("span", { class: "tag adm-stopped", title: p.suspended || "わけなし" }, "停止");
}

/** 招く人: 招かれた人だけ登録できる (はじめは切) と、招待の合言葉を作る・一覧・消す */
export async function invitesSection(onChange: () => void): Promise<HTMLElement> {
  const [{ config }, { invites }] = await Promise.all([fetchAdminConfig(), fetchInvites()]);
  const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "招く人"), el("span", { class: "label" }, "Invites")));
  const only = el("input", { type: "checkbox", "aria-label": "招かれた人だけ登録できる" }) as HTMLInputElement;
  only.checked = config.inviteOnly;
  only.addEventListener("change", async () => {
    try {
      await saveAdminConfig({ inviteOnly: only.checked });
      toast(only.checked ? "招かれた人だけが登録できます" : "誰でも登録できます");
      onChange();
    } catch (e) {
      only.checked = !only.checked;
      toast(errText(e), true);
    }
  });
  f.append(
    el(
      "label",
      { class: "adm-switch" },
      only,
      el("span", {}, el("b", {}, "招かれた人だけ登録できる"), el("small", { class: "dim" }, ` 今: ${config.inviteOnly ? "招かれた人だけ" : "誰でも (URL を知っている人)"}`)),
    ),
  );
  // 合言葉を作る
  const count = el("input", { type: "number", min: "1", max: "20", value: "1", inputmode: "numeric", "aria-label": "作る数", class: "adm-count" }) as HTMLInputElement;
  const note = el("input", { maxlength: "40", placeholder: "だれ向け (メモ、なくてよい)", "aria-label": "メモ" }) as HTMLInputElement;
  const make = el("button", { class: "go small" }, "合言葉を作る") as HTMLButtonElement;
  const out = el("div");
  make.addEventListener("click", async () => {
    try {
      const r = await createInvites(Number(count.value), note.value.trim());
      out.innerHTML = "";
      out.append(el("div", { class: "callout ok" }, "作りました: ", el("b", { class: "tm-num adm-code" }, r.codes.join("  ")), " (1 つで 1 人が登録できます。登録の札の「招待の合言葉」に入れてもらう)"));
      note.value = "";
      onChange();
    } catch (e) {
      toast(errText(e), true);
    }
  });
  f.append(el("div", { class: "row adm-invite-form" }, count, note, make), out);
  // 一覧
  const t = el("table", { class: "results ss-table" });
  t.append(el("thead", {}, el("tr", {}, el("th", {}, "合言葉"), el("th", {}, "メモ"), el("th", {}, "使った人"), el("th", {}, ""))));
  const tb = el("tbody");
  const day = (ms: number) => new Date(ms).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" });
  for (const iv of invites) {
    let del: HTMLElement | null = null;
    if (!iv.usedBy) {
      del = el("button", { class: "small ghost" }, "消す");
      del.addEventListener("click", async () => {
        if (!confirm(`合言葉 ${iv.code} を消しますか?`)) return;
        try {
          await deleteInvite(iv.code);
          onChange();
        } catch (e) {
          toast(errText(e), true);
        }
      });
    }
    tb.append(
      el(
        "tr",
        {},
        el("td", { class: "num adm-code" }, iv.code),
        el("td", { class: "who" }, iv.note || "—", el("small", { class: "dim" }, ` ${day(iv.createdAt)}`)),
        el("td", {}, iv.usedBy ? `${iv.usedBy} (${day(iv.usedAt ?? iv.createdAt)})` : el("span", { class: "dim" }, "まだ")),
        el("td", {}, del),
      ),
    );
  }
  t.append(tb);
  if (invites.length) f.append(el("div", { class: "ss-scroll" }, t));
  else f.append(el("p", { class: "dim", style: "margin:8px 0 0" }, "まだ合言葉はありません"));
  f.append(el("p", { class: "dim ss-foot" }, "決まり: 誰でも登録できる (最初は URL を身内にだけ教える)。荒らしが来たら、ここで招かれた人だけにできます"));
  return f;
}
