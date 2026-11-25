// はじめの画面の コースの所: 練習に 自分で作ったコース (確かめが通るもの) と「コースをつくる」、
// その下に「みんなのコース」(公開されたもの。人気の順)。押すと練習で走る
import { buildTrack, checkTrack, validateDesign, type Track } from "@bpr/shared";
import { drawTrackCard } from "../draw.ts";
import type { Go } from "../main.ts";
import { activeDesign, palette } from "../store.ts";
import { fetchPublicTracks, type PublicTrackRow } from "../tracks_api.ts";
import { USER_PREFIX, listUserTracks, userTrack } from "../usertracks.ts";
import { errText } from "./account.ts";
import { el, fitCanvas } from "./dom.ts";
import "./editor.css";

/** 練習の札 (公式と同じ形) */
function card(track: Track, name: string, meta: HTMLElement | string, onClick: () => void, color?: string): { button: HTMLButtonElement; paint: () => void } {
  const c = el("canvas") as HTMLCanvasElement;
  const b = el(
    "button",
    { class: "trackcard" },
    c,
    el("span", { class: "tc-meta" }, el("b", {}, name), typeof meta === "string" ? el("span", { class: "num" }, meta) : meta),
  ) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  const paint = () => {
    const w = b.clientWidth || 140;
    const h = 84;
    const dpr = fitCanvas(c, w, h);
    c.style.width = "100%";
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = palette();
    drawTrackCard(ctx, track.px, track.py, w, h, p, color ?? p.accent);
  };
  return { button: b, paint };
}

const km = (m: number) => `${(m / 1000).toFixed(2)} km`;

/** 自分で作ったコースのうち、確かめが通るもの (練習の札)。thumbs に絵を描く関数を足す */
export function userTrackCards(go: Go, thumbs: Array<() => void>): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
  for (const u of listUserTracks()) {
    if (!checkTrack(u.def).ok) continue;
    const t = userTrack(u.id);
    if (!t) continue;
    const meta = el("span", { class: "num" }, km(t.length));
    const c = card(t, u.def.name, meta, () => go({ name: "practice", trackId: USER_PREFIX + u.id }), "#2ec5ff");
    c.button.classList.add("trackcard-mine");
    c.button.title = "自分で作ったコース";
    out.push(c.button);
    thumbs.push(c.paint);
  }
  return out;
}

/** 「コースをつくる」の札 */
export function editorCard(go: Go): HTMLButtonElement {
  const b = el("button", { class: "trackcard trackcard-new" }, el("span", { class: "tc-plus", "aria-hidden": "true" }, "+"), el("span", { class: "tc-meta" }, el("b", {}, "コースをつくる"), el("span", { class: "num" }, "EDITOR"))) as HTMLButtonElement;
  b.addEventListener("click", () => go({ name: "editor" }));
  return b;
}

/** みんなのコース (公開されたもの)。読みこみはあと */
export function communitySection(go: Go): HTMLElement {
  const list = el("div", { class: "trackcards" });
  const note = el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, "遊ぶ人が作り、管理者が確かめたコース。走り終えたら「いいね」を押せます。");
  const sec = el("section", { class: "frame community" }, el("div", { class: "section-title" }, el("h3", {}, "みんなのコース"), el("span", { class: "label" }, "Community")), note, list);
  const thumbs: Array<() => void> = [];
  const canRace = () => {
    const d = activeDesign();
    return !!d && validateDesign(d).length === 0;
  };
  list.append(el("p", { class: "dim", style: "margin:0;grid-column:1 / -1" }, "読みこんでいます…"));
  fetchPublicTracks("popular")
    .then((rows: PublicTrackRow[]) => {
      list.innerHTML = "";
      if (!rows.length) {
        list.append(el("p", { class: "dim", style: "margin:0;grid-column:1 / -1" }, "まだありません。コースをつくって、1 周走ってから公開を申し込めます。"));
        return;
      }
      const ok = canRace();
      for (const r of rows) {
        let t: Track;
        try {
          t = buildTrack({ id: r.id, name: r.name, points: r.points, halfWidth: 7, runoff: 8 });
        } catch {
          continue;
        }
        const meta = el("span", { class: "tc-sub" }, el("span", { class: "num" }, km(r.length)), el("span", { class: "num tc-like" }, `♥ ${r.likes}`), el("small", { class: "dim" }, r.author));
        const c = card(t, r.name, meta, () => go({ name: "practice", trackId: r.id }), "#ffd21f");
        c.button.disabled = !ok;
        c.button.title = `${r.name} — 作: ${r.author}・走られた ${r.drives} 回・いいね ${r.likes}${r.record ? `・記録 ${r.record.lap.toFixed(2)} 秒` : ""}`;
        list.append(c.button);
        thumbs.push(c.paint);
      }
      requestAnimationFrame(() => thumbs.forEach((f) => f()));
    })
    .catch((e) => {
      list.innerHTML = "";
      list.append(el("p", { class: "dim", style: "margin:0;grid-column:1 / -1" }, `読めませんでした (${errText(e)})`));
    });
  const onResize = () => thumbs.forEach((f) => f());
  window.addEventListener("resize", onResize);
  // 画面を離れたら外す (main.ts の #app が入れかわったら)
  const app = document.getElementById("app");
  const mo = new MutationObserver(() => {
    if (!sec.isConnected) {
      window.removeEventListener("resize", onResize);
      mo.disconnect();
    }
  });
  if (app) mo.observe(app, { childList: true });
  return sec;
}
