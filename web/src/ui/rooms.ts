// 部屋 (11/25 決まり「部屋も開ける (開く人がコース・周回数・級を決める)。合言葉はなし」)。
// 上に部屋を開く札 (コース・周回。級は自分の級だけ)、下に開いている部屋の一覧 (5 秒ごとに読み直す)。入ると待合へ (online.ts)
import { CUSTOM_LOBBY_MS, getTrack, isPublicTrackId, validateDesign } from "@bpr/shared";
import { drawTrackCard } from "../draw.ts";
import type { Go } from "../main.ts";
import { checkJoinRoom, createRoom, fetchRooms, type RoomView, type RoomsList } from "../rooms_api.ts";
import { activeDesign, palette } from "../store.ts";
import { ensureTrack } from "../tracks_api.ts";
import { errText, toast } from "./account.ts";
import { el, fitCanvas } from "./dom.ts";
import "./team.css";
import "./season.css";
import "./rooms.css";

/** 一覧を読み直す間 (ms、仮) */
const REFRESH_MS = 5000;
/** はじめの周回 (仮) */
const DEFAULT_LAPS = 5;

const PHASE_LABEL: Record<string, string> = { idle: "OPEN", lobby: "GRID", race: "RACE", results: "RESULT" };

export function mountRooms(root: HTMLElement, go: Go): () => void {
  let alive = true;
  let timer = 0;
  let data: RoomsList | null = null;
  let busy = false;
  const sheet = el("div", { class: "sheet acc tm rm" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, "部屋"), el("span", { class: "label" }, "Rooms")));
  const msg = el("div");
  const createBox = el("section", { class: "frame rm-create" });
  const listBox = el("section", { class: "frame rm-list" });
  sheet.append(el("div", { class: "stack" }, msg, createBox, listBox));

  const design = activeDesign();
  const carOk = !!design && validateDesign(design).length === 0;
  if (!carOk) {
    msg.append(el("div", { class: "callout" }, "走れる車がまだありません。先に車をつくってください"));
  }

  /** 部屋に入る (みんなのコースなら形を読んでから) */
  async function enter(r: RoomView, host: boolean) {
    if (busy) return;
    busy = true;
    try {
      if (!host) await checkJoinRoom(r.id);
      if (isPublicTrackId(r.trackId) && !(await ensureTrack(r.trackId))) throw new Error("コースの形が読めません");
      if (!alive) return;
      go({ name: "online", laps: r.laps, room: { id: r.id, host } });
    } catch (e) {
      toast(errText(e), true);
      void refresh();
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- 開く
  let lapsVal = DEFAULT_LAPS;
  let trackVal = "";
  function drawCreate(d: RoomsList) {
    createBox.innerHTML = "";
    createBox.append(el("div", { class: "section-title" }, el("h3", {}, "部屋を開く"), el("span", { class: "label" }, "Host a room")));
    const mine = d.rooms.find((r) => r.mine);
    if (!d.loggedIn) {
      const login = el("button", { class: "small" }, "ログイン・はじめる");
      login.addEventListener("click", () => go({ name: "account" }));
      createBox.append(el("p", { class: "dim rm-note" }, "部屋を開くにはログインがいります。開いている部屋には、ログインしなくても入れます (5 級の部屋だけ)。"), login);
      return;
    }
    if (mine) {
      const b = el("button", { class: "go" }, "自分の部屋にもどる") as HTMLButtonElement;
      b.disabled = !carOk;
      b.addEventListener("click", () => void enter(mine, true));
      createBox.append(el("p", { class: "dim rm-note" }, `開いている部屋があります: ${mine.trackName} · ${mine.laps} 周。1 人が開ける部屋は 1 つです。`), b);
      return;
    }
    if (!trackVal || !d.tracks.some((t) => t.id === trackVal)) trackVal = d.tracks[0]?.id ?? "";
    const thumb = el("canvas", { class: "rm-thumb", "aria-hidden": "true" }) as HTMLCanvasElement;
    const track = el("select", { "aria-label": "コース" }) as HTMLSelectElement;
    for (const t of d.tracks) track.append(el("option", { value: t.id }, isPublicTrackId(t.id) ? `${t.name} (みんなのコース)` : t.name));
    track.value = trackVal;
    const paintThumb = async () => {
      const id = track.value;
      if (isPublicTrackId(id)) await ensureTrack(id).catch(() => null);
      if (!alive || track.value !== id) return;
      const t = getTrack(id);
      const w = Math.min(220, thumb.parentElement?.clientWidth || 220);
      const h = 120;
      const dpr = fitCanvas(thumb, w, h);
      const ctx = thumb.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const p = palette();
      drawTrackCard(ctx, t.px, t.py, w, h, p, p.accent);
      lenEl.textContent = `${(t.length / 1000).toFixed(2)} km`;
    };
    const lenEl = el("span", { class: "num dim" });
    track.addEventListener("change", () => {
      trackVal = track.value;
      void paintThumb();
    });
    // 周回: − 数 + (1〜30)
    const lapsNum = el("b", { class: "tm-num rm-laps-n" }, String(lapsVal));
    const step = (dl: number) => {
      lapsVal = Math.max(d.laps.min, Math.min(d.laps.max, lapsVal + dl));
      lapsNum.textContent = String(lapsVal);
      minus.disabled = lapsVal <= d.laps.min;
      plus.disabled = lapsVal >= d.laps.max;
      timeEl.textContent = `約 ${Math.max(1, Math.round((lapsVal * 42) / 60))} 分`;
    };
    const minus = el("button", { class: "rm-step", "aria-label": "周回を減らす" }, "−") as HTMLButtonElement;
    const plus = el("button", { class: "rm-step", "aria-label": "周回を増やす" }, "+") as HTMLButtonElement;
    minus.addEventListener("click", () => step(-1));
    plus.addEventListener("click", () => step(1));
    const timeEl = el("span", { class: "num dim" });
    step(0);
    const open = el("button", { class: "go rm-open" }, "部屋を開く") as HTMLButtonElement;
    open.disabled = !carOk || !d.tracks.length;
    open.addEventListener("click", async () => {
      if (busy) return;
      open.disabled = true;
      try {
        const r = await createRoom(track.value, lapsVal);
        await enter(r.room, true);
      } catch (e) {
        toast(errText(e), true);
        open.disabled = false;
      }
    });
    createBox.append(
      el(
        "div",
        { class: "rm-form" },
        el("div", { class: "rm-trackpick" }, thumb, el("label", { class: "ss-field" }, el("span", {}, "コース ", lenEl), track)),
        el(
          "div",
          { class: "rm-side" },
          el("div", { class: "ss-field" }, el("span", {}, "周回 ", el("small", { class: "dim" }, `${d.laps.min}〜${d.laps.max}`)), el("div", { class: "rm-laps" }, minus, lapsNum, el("span", { class: "label" }, "LAPS"), plus), timeEl),
          el("div", { class: "ss-field" }, el("span", {}, "級"), el("div", { class: "rm-cls" }, el("b", { class: "tm-num" }, String(d.cls)), el("span", {}, "級"), el("small", { class: "dim" }, "開く人の級だけ"))),
          open,
        ),
      ),
      el(
        "p",
        { class: "dim rm-note" },
        `待合は ${Math.round(CUSTOM_LOBBY_MS / 1000)} 秒。人が 2 人そろえば、開いた人は早めにスタートできます。空きはコンピューターが走ります。合言葉はありません (一覧から誰でも入れます)。結果は季節の点と賞金に入ります。`,
      ),
    );
    requestAnimationFrame(() => void paintThumb());
  }

  // ---------------------------------------------------------------- 一覧
  function drawList(d: RoomsList) {
    listBox.innerHTML = "";
    listBox.append(el("div", { class: "section-title" }, el("h3", {}, "開いている部屋"), el("span", { class: "label" }, `${d.rooms.length} rooms`)));
    if (!d.rooms.length) {
      listBox.append(el("p", { class: "dim rm-note" }, "いま開いている部屋はありません。上で開くと、ここに出ます。"));
      return;
    }
    const ul = el("ul", { class: "rm-rows" });
    const now = Date.now();
    for (const r of d.rooms) {
      const left = Math.max(0, Math.ceil((r.endsAt - now) / 1000));
      const state =
        r.phase === "lobby" ? `あと ${left} 秒` : r.phase === "race" ? "レース中" : r.phase === "results" ? "結果 · 次の待合へ" : "まだ誰もいません";
      const join = el("button", { class: r.block ? "small" : "small go" }, r.mine ? "もどる" : "入る") as HTMLButtonElement;
      join.disabled = !carOk || (!r.mine && r.block !== null);
      join.addEventListener("click", () => void enter(r, r.mine));
      const why = r.block && !r.mine ? BLOCK_TEXT[r.block] : "";
      ul.append(
        el(
          "li",
          { class: `rm-row${r.mine ? " mine" : ""}${r.block && !r.mine ? " blocked" : ""}` },
          el("div", { class: "rm-lapsbig" }, el("b", {}, String(r.laps)), el("span", {}, "LAPS")),
          el(
            "div",
            { class: "rm-what" },
            el("b", { class: "rm-track" }, r.trackName),
            el("span", { class: "rm-meta" }, el("span", { class: "tag" }, `${r.cls} 級`), ` ${r.host}`, r.mine ? el("span", { class: "you" }, "YOU") : null),
            el(
              "span",
              { class: "rm-state" },
              el("span", { class: `rm-phase ${r.phase}` }, PHASE_LABEL[r.phase] ?? r.phase),
              el("span", { class: "num dim", ...(r.phase === "lobby" ? { "data-ends": String(r.endsAt) } : {}) }, state),
              why ? el("small", { class: "dim" }, ` · ${why}`) : null,
            ),
          ),
          el("div", { class: "rm-seats" }, el("b", { class: "tm-num" }, String(r.humans)), el("span", { class: "dim" }, `/ ${r.seats}`), el("small", { class: "label" }, "Drivers")),
          join,
        ),
      );
    }
    listBox.append(ul);
  }

  async function refresh() {
    try {
      const d = await fetchRooms();
      if (!alive) return;
      const first = !data;
      // 開く札は 部屋の有無・ログインが変わったときだけ描き直す (選んでいる途中を消さない)
      const key = (x: RoomsList) => `${x.loggedIn}|${x.cls}|${x.rooms.find((r) => r.mine)?.id ?? ""}|${x.tracks.map((t) => t.id).join(",")}`;
      if (first || key(d) !== key(data!)) drawCreate(d);
      data = d;
      drawList(d);
    } catch (e) {
      if (!alive) return;
      if (!data) {
        createBox.innerHTML = "";
        listBox.innerHTML = "";
        listBox.append(el("div", { class: "bad" }, errText(e)));
      }
    }
  }

  createBox.append(el("div", { class: "dim" }, "読みこんでいます…"));
  void refresh();
  timer = window.setInterval(() => void refresh(), REFRESH_MS);
  // 待合の残りの秒だけ 1 秒ごとに書きかえる (ボタンは作り直さない)
  const tick = window.setInterval(() => {
    for (const n of listBox.querySelectorAll<HTMLElement>("[data-ends]")) {
      n.textContent = `あと ${Math.max(0, Math.ceil((Number(n.dataset.ends) - Date.now()) / 1000))} 秒`;
    }
  }, 1000);
  return () => {
    alive = false;
    clearInterval(timer);
    clearInterval(tick);
  };
}

const BLOCK_TEXT: Record<string, string> = {
  started: "終わったら入れます",
  class: "級がちがいます",
  full: "満員",
  closing: "まもなくスタート",
};
