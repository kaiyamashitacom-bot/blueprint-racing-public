// 管理者の画面 (管理者のアカウントだけ): 数の調整 (AdminConfig)・大会を組む / 直す / 取りやめる・遊ぶ人の一覧とパスワードを戻す・
// コースの確かめ (遊ぶ人が出したコースを公開する / 断る。名前も直せる)
import { TOURNAMENT_LAPS_MAX, TOURNAMENT_LAPS_MIN, TRACK_LIMITS, buildTrack, checkTrack, type TournamentWeather } from "@bpr/shared";
import { drawTrackCard } from "../draw.ts";
import { palette } from "../store.ts";
import { fetchAdminTracks, reviewTrack, type AdminTrackRow, type TrackStatus } from "../tracks_api.ts";
import { fitCanvas } from "./dom.ts";
import "./editor.css";
import { adminResetPassword, cachedMe, isLoggedIn } from "../api.ts";
import type { Go } from "../main.ts";
import {
  cancelTournament,
  createTournament,
  fetchAdminTournaments,
  fetchPlayers,
  updateTournament,
  type PlayerRow,
  type TourBrief,
  type TourInput,
} from "../season_api.ts";
import { errText, money, toast } from "./account.ts";
import { el } from "./dom.ts";
import { PHASE_JP, jstTime, weatherText } from "./tournament.ts";
import "./team.css";
import "./season.css";
import { invitesSection, suspendButton, suspendedTag } from "./admin_players.ts";
import { giftsSection } from "./admin_gifts.ts";
import { configEditor } from "./admin_config.ts";
import { tourPrizeEditor } from "./admin_tourprize.ts";
import { gradeBadge } from "./tourprize.ts";
import { betsAdminSection } from "./admin_bets.ts";
import { rpAdminSection } from "./admin_rp.ts";

type Tab = "config" | "tournaments" | "players" | "tracks" | "gifts" | "rp" | "bets";

/** 天気の選びの値 */
function weatherKey(w: TournamentWeather): string {
  return w.mode === "fixed" ? w.sky : (w.rain ?? 0) >= 0.6 ? "random-wet" : "random";
}

/** 日本時間の datetime-local の値 ⇄ ms */
function toLocalInput(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 16);
}
function fromLocalInput(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600_000;
}

export function mountAdmin(root: HTMLElement, go: Go): () => void {
  let alive = true;
  let tab: Tab = "config";
  const sheet = el("div", { class: "sheet acc tm ss" });
  root.append(sheet);
  const back = el("button", { class: "small" }, "← もどる");
  back.addEventListener("click", () => go({ name: "menu" }));
  sheet.append(el("div", { class: "acc-top tm-top" }, back, el("h2", {}, "管理"), el("span", { class: "label" }, "Admin")));
  const nav = el("nav", { class: "tm-nav", "aria-label": "管理の画面" });
  const body = el("div", { class: "tm-body" });
  sheet.append(nav, body);

  if (!isLoggedIn() || !cachedMe()?.admin) {
    body.append(el("div", { class: "frame bad" }, "管理者だけが使えます"));
    return () => {};
  }

  const paintNav = () => {
    nav.innerHTML = "";
    for (const [t, jp] of [
      ["config", "数の調整"],
      ["tournaments", "大会"],
      ["players", "遊ぶ人"],
      ["tracks", "コース"],
      ["gifts", "ギフト"],
      ["rp", "走行点"],
      ["bets", "賭け"],
    ] as Array<[Tab, string]>) {
      const b = el("button", { class: t === tab ? "on" : "" }, jp) as HTMLButtonElement;
      b.addEventListener("click", () => {
        tab = t;
        void show();
      });
      nav.append(b);
    }
  };

  async function show() {
    paintNav();
    body.innerHTML = "";
    body.append(el("div", { class: "frame dim" }, "読みこんでいます…"));
    try {
      const node =
        tab === "config" ? await configTab() : tab === "tournaments" ? await tournamentsTab() : tab === "tracks" ? await tracksTab() : tab === "gifts" ? await giftsSection(() => void show()) : tab === "rp" ? await rpAdminSection(() => void show()) : tab === "bets" ? await betsAdminSection(() => void show()) : await playersTab();
      if (!alive) return;
      body.innerHTML = "";
      body.append(node);
    } catch (e) {
      body.innerHTML = "";
      body.append(el("div", { class: "frame bad" }, errText(e)));
    }
  }

  // ---------------------------------------------------------------- 数の調整
  // AdminConfig の全部の項目を組ごとに説明つきで並べる (admin_config.ts)。名前と説明は shared の ADMIN_CONFIG_META
  async function configTab(): Promise<HTMLElement> {
    return configEditor(() => void show());
  }

  // ---------------------------------------------------------------- 大会
  async function tournamentsTab(): Promise<HTMLElement> {
    const { tournaments, tracks } = await fetchAdminTournaments();
    const box = el("div", { class: "stack" });
    let editing: TourBrief | null = null;
    const formBox = el("div");
    const drawForm = () => {
      formBox.innerHTML = "";
      formBox.append(tourForm(tracks, editing, () => {
        editing = null;
        drawForm();
      }));
    };
    drawForm();
    box.append(formBox);
    const list = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "大会の一覧"), el("span", { class: "label" }, `${tournaments.length}`)));
    if (!tournaments.length) list.append(el("p", { class: "dim", style: "margin:0" }, "まだありません"));
    for (const t of tournaments) {
      const edit = el("button", { class: "small" }, "直す") as HTMLButtonElement;
      edit.disabled = t.phase !== "qualifying";
      edit.addEventListener("click", () => {
        editing = t;
        drawForm();
        formBox.scrollIntoView({ behavior: "smooth" });
      });
      const del = el("button", { class: "small ghost" }, "取りやめ") as HTMLButtonElement;
      del.disabled = t.status !== "open";
      del.addEventListener("click", async () => {
        if (!confirm(`「${t.name}」を取りやめます。よいですか?`)) return;
        try {
          await cancelTournament(t.id);
          toast("取りやめました");
          void show();
        } catch (e) {
          toast(errText(e), true);
        }
      });
      const view = el("button", { class: "small" }, "見る") as HTMLButtonElement;
      view.addEventListener("click", () => go({ name: "tournament", id: t.id }));
      list.append(
        el(
          "div",
          { class: "ss-adm-row" },
          el(
            "div",
            {},
            gradeBadge(t.grade),
            " ",
            el("b", {}, t.name),
            el("small", { class: "dim" }, ` ${jstTime(t.startsAt)} · ${t.trackName} · ${t.laps} 周 · ${weatherText(t.weather)} · 組 ${t.groupSize} 台 · 予選 ${t.entries} 人${t.allEnter ? " · 全員参加" : ""}${t.auto ? " · 毎日の自動" : ""}`),
          ),
          el("span", { class: `ss-phase ${t.phase}` }, PHASE_JP[t.phase] ?? t.phase),
          el("div", { class: "row" }, view, edit, del),
        ),
      );
    }
    box.append(list, devClock());
    return box;
  }

  function tourForm(tracks: Array<{ id: string; name: string }>, editing: TourBrief | null, onDone: () => void): HTMLElement {
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, editing ? `「${editing.name}」を直す` : "大会を組む"), el("span", { class: "label" }, editing ? "Edit" : "New")));
    // はじめ: 3 日後の 21 時 (日本時間)
    const d = new Date(Date.now() + 9 * 3600_000 + 3 * 86400_000);
    const defStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21, 0) - 9 * 3600_000;
    const name = el("input", { value: editing?.name ?? "", maxlength: "24", placeholder: "大会の名前" }) as HTMLInputElement;
    const start = el("input", { type: "datetime-local", value: toLocalInput(editing?.startsAt ?? defStart) }) as HTMLInputElement;
    const track = el("select", {}) as HTMLSelectElement;
    for (const t of tracks) track.append(el("option", { value: t.id }, t.name));
    track.value = editing?.trackId ?? tracks[0]?.id ?? "";
    const laps = el("input", { type: "number", min: String(TOURNAMENT_LAPS_MIN), max: String(TOURNAMENT_LAPS_MAX), value: String(editing?.laps ?? 10), inputmode: "numeric" }) as HTMLInputElement;
    const weather = el("select", {}) as HTMLSelectElement;
    for (const [v, jp] of [
      ["sun", "ずっと晴れ"],
      ["light", "ずっと小雨"],
      ["heavy", "ずっと大雨"],
      ["random", "変わる (おまかせ)"],
      ["random-wet", "変わる (雨が多め)"],
    ]) weather.append(el("option", { value: v }, jp));
    weather.value = editing ? weatherKey(editing.weather) : "sun";
    const group = el("input", { type: "number", min: "2", max: "8", value: String(editing?.groupSize ?? 8), inputmode: "numeric" }) as HTMLInputElement;
    const field = (label: string, c: HTMLElement, hint = "") => el("label", { class: "ss-field" }, el("span", {}, label, hint ? el("small", { class: "dim" }, ` ${hint}`) : null), c);
    f.append(
      el(
        "div",
        { class: "ss-form" },
        field("名前", name, "24 字まで"),
        field("スタート", start, "日本時間"),
        field("コース", track),
        field("周回", laps, `${TOURNAMENT_LAPS_MIN}〜${TOURNAMENT_LAPS_MAX}`),
        field("天気", weather),
        field("組の大きさ", group, "2〜8 台"),
      ),
      el("p", { class: "dim ss-foot" }, "予選は組んだときから、大会の日の 0 時 (前の日の終わり) まで。6 時間以上ないと組めません。大会のある日は、その日の毎日の自動の大会は開きません"),
    );
    // 格・全員参加・景品 (中身はギフトの一覧から。読みこんでから出す)
    const prizeBox = el("div", {}, el("p", { class: "dim" }, "景品の入力を読みこんでいます…"));
    let prizeValue: (() => Partial<TourInput>) | null = null;
    f.append(prizeBox);
    void tourPrizeEditor(editing)
      .then((pe) => {
        prizeValue = pe.value;
        prizeBox.replaceChildren(pe.node);
      })
      .catch((e) => prizeBox.replaceChildren(el("p", { class: "bad" }, errText(e))));
    const save = el("button", { class: "go" }, editing ? "直す" : "組む") as HTMLButtonElement;
    save.addEventListener("click", async () => {
      const wv = weather.value;
      const wt: TournamentWeather =
        wv === "random" ? { mode: "random", seed: Math.floor(Math.random() * 1e9), rain: 0.3 } : wv === "random-wet" ? { mode: "random", seed: Math.floor(Math.random() * 1e9), rain: 0.7 } : { mode: "fixed", sky: wv as "sun" | "light" | "heavy" };
      const input: TourInput = {
        name: name.value.trim(),
        startsAt: fromLocalInput(start.value),
        trackId: track.value,
        laps: Number(laps.value),
        weather: wt,
        groupSize: Number(group.value),
        ...(prizeValue ? prizeValue() : {}),
      };
      try {
        // 直すとき、天気の選びが前と同じなら前の天気 (おまかせの種) のまま
        if (editing) await updateTournament(editing.id, wv === weatherKey(editing.weather) ? { ...input, weather: editing.weather } : input);
        else await createTournament(input);
        toast(editing ? "直しました" : "大会を組みました");
        void show();
      } catch (e) {
        toast(errText(e), true);
      }
    });
    const row = el("div", { class: "row", style: "margin-top:10px" }, save);
    if (editing) {
      const cancel = el("button", { class: "ghost" }, "やめる");
      cancel.addEventListener("click", onDone);
      row.append(cancel);
    }
    f.append(row);
    return f;
  }

  /** 作るときだけ: 季節と大会の時計をずらす (サーバーに BPR_DEV_CLOCK=1 がないと 404) */
  function devClock(): HTMLElement {
    const d = el("details", { class: "frame ss-dev" }, el("summary", {}, "時計をずらす (作るときだけ)"));
    const out = el("pre", { class: "dim" });
    const send = async (path: string, body?: unknown) => {
      const token = localStorage.getItem("bpr.token");
      const r = await fetch(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      out.textContent = JSON.stringify(await r.json(), null, 1).slice(0, 1200);
    };
    const offset = el("input", { type: "number", value: "0", "aria-label": "ずらす時間 (時間)" }) as HTMLInputElement;
    const set = el("button", { class: "small" }, "ずらす (時間)");
    set.addEventListener("click", () => void send("/api/admin/dev/clock", { offsetMs: Number(offset.value) * 3600_000 }));
    const tick = el("button", { class: "small" }, "進める");
    tick.addEventListener("click", () => void send("/api/admin/dev/tick"));
    d.append(el("div", { class: "row" }, offset, set, tick), out);
    return d;
  }

  // ---------------------------------------------------------------- 遊ぶ人
  async function playersTab(): Promise<HTMLElement> {
    const { players } = await fetchPlayers();
    const f = el("section", { class: "frame" }, el("div", { class: "section-title" }, el("h3", {}, "遊ぶ人"), el("span", { class: "label" }, `${players.length} 人`)));
    const msg = el("div");
    const t = el("table", { class: "results ss-table" });
    t.append(el("thead", {}, el("tr", {}, el("th", {}, "ID"), el("th", {}, "チーム / 運転手"), el("th", { class: "r" }, "級"), el("th", { class: "r" }, "財布"), el("th", { class: "r" }, "最後"), el("th", {}, ""))));
    const tb = el("tbody");
    const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }) : "—");
    for (const p of players as PlayerRow[]) {
      const reset = el("button", { class: "small" }, "パスワードを戻す") as HTMLButtonElement;
      reset.addEventListener("click", async () => {
        const pw = prompt(`${p.login} の新しいパスワード (8 文字以上。空なら作ります)`, "");
        if (pw === null) return;
        try {
          const got = await adminResetPassword(p.login, pw || undefined);
          msg.innerHTML = "";
          msg.append(el("div", { class: "callout ok" }, `${p.login} の新しいパスワード: `, el("b", { class: "tm-num" }, got), " (本人に伝えてください。ログインは全部切れました)"));
        } catch (e) {
          toast(errText(e), true);
        }
      });
      tb.append(
        el(
          "tr",
          {},
          el("td", { class: "num" }, p.login, p.admin ? el("span", { class: "tag" }, "管理") : null, suspendedTag(p)),
          el("td", { class: "who" }, p.team, el("small", { class: "dim" }, ` ${p.driver}`)),
          el("td", { class: "r num" }, p.cls === null ? "—" : String(p.cls)),
          el("td", { class: "r num" }, money(p.money)),
          el("td", { class: "r num" }, day(p.lastLogin ?? p.createdAt)),
          el("td", {}, el("div", { class: "row" }, reset, suspendButton(p, () => void show()))),
        ),
      );
    }
    t.append(tb);
    f.append(msg, el("div", { class: "ss-scroll" }, t), el("p", { class: "dim ss-foot" }, "ID はほかの人には見せません。止めた人はログインもネットのレースもできません"));
    return el("div", { class: "stack" }, f, await invitesSection(() => void show()));
  }

  // ---------------------------------------------------------------- コースの確かめ
  let trackFilter: TrackStatus | "all" = "pending";
  async function tracksTab(): Promise<HTMLElement> {
    const rows = await fetchAdminTracks(trackFilter);
    const box = el("div", { class: "stack" });
    const filters = el("div", { class: "ed-seg" });
    for (const [k, jp] of [
      ["pending", "確かめ待ち"],
      ["public", "公開中"],
      ["rejected", "断った"],
      ["all", "全部"],
    ] as Array<[TrackStatus | "all", string]>) {
      const b = el("button", { class: `small${k === trackFilter ? " on" : ""}` }, jp) as HTMLButtonElement;
      b.addEventListener("click", () => {
        trackFilter = k;
        void show();
      });
      filters.append(b);
    }
    const f = el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "コースの確かめ"), el("span", { class: "label" }, `${rows.length} 本`)),
      filters,
      el("p", { class: "dim ss-foot" }, "公開の条件: 作った人が自分で 1 周走れた (タイムつき) + ここで確かめる。名前も見て、よくなければ直すか断ってください。断った理由は作った人に見えます"),
    );
    if (!rows.length) f.append(el("p", { class: "dim", style: "margin:0" }, "ありません"));
    const list = el("div", { class: "adm-tracks" });
    for (const r of rows) list.append(trackReviewCard(r));
    f.append(list);
    box.append(f);
    requestAnimationFrame(() => list.querySelectorAll<HTMLElement>("[data-paint]").forEach((c) => c.dispatchEvent(new Event("paint"))));
    return box;
  }

  function trackReviewCard(r: AdminTrackRow): HTMLElement {
    const STATUS_JP: Record<TrackStatus, string> = { pending: "確かめ待ち", public: "公開中", rejected: "断った" };
    const c = el("canvas", { "data-paint": "1" }) as HTMLCanvasElement;
    let issues: string[] = [];
    let len = r.length;
    try {
      const ck = checkTrack(r.def);
      issues = ck.issues.map((i) => i.message);
      len = Math.round(buildTrack(r.def).length);
    } catch {
      issues = ["形が読めません"];
    }
    c.addEventListener("paint", () => {
      const w = c.parentElement?.clientWidth || 260;
      const h = 150;
      const dpr = fitCanvas(c, w, h);
      c.style.width = "100%";
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t = buildTrack(r.def);
      const p = palette();
      drawTrackCard(ctx, t.px, t.py, w, h, p, p.accent);
    });
    const name = el("input", { value: r.name, maxlength: String(TRACK_LIMITS.maxName), "aria-label": "コースの名前" }) as HTMLInputElement;
    const reason = el("input", { placeholder: "断る理由 (なくてよい。作った人に見えます)", maxlength: "120", "aria-label": "断る理由" }) as HTMLInputElement;
    const approve = el("button", { class: "go" }, r.status === "public" ? "名前を直す" : "公開する") as HTMLButtonElement;
    const reject = el("button", { class: "ghost" }, r.status === "public" ? "公開をやめる" : "断る") as HTMLButtonElement;
    const act = async (action: "approve" | "reject") => {
      const nm = name.value.trim();
      if (action === "reject" && !confirm(`「${r.name}」を${r.status === "public" ? "公開から外し" : "断り"}ます。よいですか?`)) return;
      try {
        await reviewTrack(r.id, action, { name: nm && nm !== r.name ? nm : undefined, reason: reason.value.trim() || undefined });
        toast(action === "approve" ? "公開しました" : "断りました");
        void show();
      } catch (e) {
        toast(errText(e), true);
      }
    };
    approve.addEventListener("click", () => void act("approve"));
    reject.addEventListener("click", () => void act("reject"));
    const D = (ms: number | null) => (ms ? new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
    return el(
      "div",
      { class: "adm-track" },
      el("div", { class: "adm-track-pic" }, c),
      el(
        "div",
        { class: "adm-track-body" },
        el("div", { class: "row" }, el("span", { class: `ss-phase ${r.status === "public" ? "racing" : r.status === "pending" ? "grid_set" : ""}` }, STATUS_JP[r.status]), el("b", {}, r.name), el("small", { class: "dim" }, r.id)),
        el(
          "div",
          { class: "dim", style: "font-size:13px" },
          `作: ${r.author}${r.login ? ` (${r.login})` : " (退会)"} · ${(len / 1000).toFixed(2)} km · 作った人の周 ${r.authorLap.toFixed(2)} 秒 · 申し込み ${D(r.submittedAt)}`,
          r.status === "public" ? ` · 走られた ${r.drives} 回 · いいね ${r.likes}` : "",
        ),
        r.reason ? el("div", { class: "dim", style: "font-size:13px" }, `断った理由: ${r.reason}`) : null,
        issues.length ? el("div", { class: "callout" }, `今の決まりでは問題: ${issues[0]}`) : null,
        el("label", { class: "ss-field" }, el("span", {}, "名前", el("small", { class: "dim" }, ` ${TRACK_LIMITS.maxName} 字まで。直すとこの名前で出ます`)), name),
        el("label", { class: "ss-field" }, el("span", {}, "理由"), reason),
        el("div", { class: "row" }, approve, reject),
      ),
    );
  }

  void show();
  return () => {
    alive = false;
  };
}
