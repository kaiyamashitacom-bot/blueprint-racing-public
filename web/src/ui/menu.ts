// はじめの画面 (F1 中継風): 左に自分の車 (番号・運転手の札・塗り分けの車・数字の札) とチーム、右に走る (すぐ走る・練習・…)・設定
// まだ走れる車がなければ、一番上に「まず車をつくる」の案内を 1 つだけ出す。
// スマホ (縦 1 列) では 案内 → 走る → あなたの車 → チーム → 設定 の順 (style.css の .hero の order)
import { QUICK_LAPS, TRACK_DEFS, computeStats, getTrack, isRealCircuitId, validateDesign } from "@bpr/shared";
import { drawCarShowcase, drawTrackCard } from "../draw.ts";
import { cachedMe, isLoggedIn, refreshAccount } from "../api.ts";
import type { Go } from "../main.ts";
import { load, palette, save } from "../store.ts";
import { manualBonus } from "../race_rules.ts";
import { el, fitCanvas } from "./dom.ts";
import { taMenuSection } from "./timeattack.ts";
import { teamMenuRow } from "./team.ts";
import { leagueMenuSection } from "./league.ts";
import { seasonMenuSection } from "./season.ts";
import { communitySection, editorCard, userTrackCards } from "./tracks.ts";
import { soundSettingRows } from "../audio/index.ts";
import { giftMenuRows } from "./gift.ts";
import { rpChip } from "./exchange.ts";
import { effectiveSetting, loadOpeningPrefs, saveOpeningPrefs } from "./opening_plan.ts";
import { APP_VERSION } from "../version.ts";

const LAP_LABEL: Record<number, string> = { 2: "短い", 5: "普通", 10: "長い" };

export function mountMenu(root: HTMLElement, go: Go): () => void {
  const s = load();
  const sheet = el("div", { class: "sheet menu" });
  root.append(sheet);

  // 見出し
  sheet.append(
    el(
      "header",
      { class: "topbar" },
      el("div", { class: "brand" }, el("span", { class: "brand-mark", "aria-hidden": "true" }, "BPR"), el("h1", {}, "Blueprint Racing", el("small", {}, "マス目に部品を並べて車を作り、みんなで走る"))),
      // 走行点の残高 (ログインしているときだけ。押すと交換所)
      rpChip(go),
      el("span", { class: "tag" }, APP_VERSION),
    ),
  );

  const hero = el("div", { class: "hero" });
  sheet.append(hero);

  // 左: あなたの車
  const garage = el("section", { class: "frame garage" });
  const canvas = el("canvas") as HTMLCanvasElement;
  const showcase = el("div", { class: "showcase" }, canvas);
  const stats = el("div", { class: "stats" });
  const nameIn = el("input", { placeholder: "名前 (12 字まで)", maxlength: "12", value: s.name, "aria-label": "運転手の名前" }) as HTMLInputElement;
  nameIn.addEventListener("input", () => {
    if (nameIn.readOnly) return;
    s.name = nameIn.value;
    save();
  });
  // ログインしていれば アカウントの運転手名 (ここでは変えられない。サーバーもこの名前で走らせる)
  const nameNote = el("div", { class: "name-note" });
  const paintName = () => {
    const me = cachedMe();
    const acct = isLoggedIn() && me?.driver ? me.driver : "";
    nameIn.readOnly = !!acct;
    nameIn.classList.toggle("locked", !!acct);
    nameIn.value = acct || s.name;
    nameIn.title = acct ? "運転手名はアカウントの画面で決めます" : "";
    nameNote.textContent = acct ? "ログイン中はアカウントの運転手名で走ります。変えるのはアカウントの画面で" : "";
    nameNote.hidden = !acct;
  };
  const carSel = el("select", { "aria-label": "走る車" }) as HTMLSelectElement;
  carSel.addEventListener("change", () => {
    s.active = Number(carSel.value);
    save();
    refresh();
  });
  const carNo = el("b", {}, "01");
  const buildBtn = el("button", { class: "primary buildbtn" }, "車をつくる・直す") as HTMLButtonElement;
  buildBtn.addEventListener("click", () => go({ name: "builder" }));
  const status = el("div");
  const accBtn = el("button", {}) as HTMLButtonElement;
  accBtn.addEventListener("click", () => go({ name: "account" }));
  const shopBtn = el("button", {}, "お店・持ち物") as HTMLButtonElement;
  shopBtn.addEventListener("click", () => go({ name: "shop" }));
  // 交換所 (走行点。ログインしているときだけ)
  const xcBtn = el("button", {}, "交換所") as HTMLButtonElement;
  xcBtn.addEventListener("click", () => go({ name: "exchange" }));
  xcBtn.hidden = !isLoggedIn();
  const paintAccount = () => {
    const me = cachedMe();
    accBtn.textContent = isLoggedIn() && me ? `${me.driver} · 財布 ${me.money.toLocaleString("ja-JP")}` : "ログイン・はじめる";
  };
  paintAccount();
  paintName();
  refreshAccount()
    .then(() => {
      paintAccount();
      paintName();
    })
    .catch(() => {});
  garage.append(
    el("div", { class: "section-title" }, el("h3", {}, "あなたの車"), el("span", { class: "label" }, "Driver · Car")),
    el(
      "div",
      { class: "driver" },
      el("div", { class: "carno" }, el("span", { class: "label" }, "No."), carNo),
      el("div", { class: "plate" }, el("span", { class: "label" }, "運転手"), nameIn, el("span", { class: "label" }, "車"), carSel),
    ),
    nameNote,
    showcase,
    stats,
    status,
    buildBtn,
  );
  // はじめての人への案内 (走れる車がないときだけ。refresh で中身を入れる)
  const startCta = el("section", { class: "frame start-here" });
  // チーム: チーム・運転手・研究・市場、お店・アカウント
  const teamGroup = el(
    "div",
    { class: "menu-group menu-team" },
    groupHead("チーム", "Team"),
    el("section", { class: "frame" }, teamMenuRow(go), el("div", { class: "row account-row" }, accBtn, shopBtn, xcBtn)),
  );
  hero.append(el("div", { class: "stack menu-col-left" }, startCta, garage, teamGroup));

  // 右: 走る (すぐ走る・練習・1 周アタック・リーグ戦・季節と大会)
  const right = el("div", { class: "stack menu-col-right" });
  hero.append(right);
  right.append(groupHead("走る", "Race"));
  const raceButtons: HTMLButtonElement[] = [];

  const quick = el("div", { class: "cards" });
  for (const laps of QUICK_LAPS) {
    const b = el(
      "button",
      { class: `card ${laps === 5 ? "primary" : ""}` },
      el("span", { class: "laps" }, el("b", {}, String(laps)), el("span", {}, "LAPS")),
      el("span", { class: "what" }, LAP_LABEL[laps] ?? `${laps} 周`),
      el("span", { class: "num" }, `約 ${Math.max(1, Math.round((laps * 42) / 60))} 分`),
    ) as HTMLButtonElement;
    b.setAttribute("aria-label", `すぐ走る ${laps} 周`);
    b.addEventListener("click", () => go({ name: "online", laps }));
    raceButtons.push(b);
    quick.append(b);
  }
  right.append(
    el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "すぐ走る"), el("span", { class: "label" }, "Online · 8 cars")),
      el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, "同じ長さを選んだ人と組みます。空きはコンピューター (CPU) が走ります。"),
      quick,
      roomsRow(),
    ),
  );
  // 部屋 (コース・周回を決めて開く / 開いている部屋に入る)
  function roomsRow(): HTMLElement {
    const b = el("button", { class: "rooms-btn" }, el("b", {}, "部屋"), el("span", { class: "dim" }, "コースと周回を決めて開く・開いている部屋に入る"), el("span", { class: "label" }, "Rooms")) as HTMLButtonElement;
    b.addEventListener("click", () => go({ name: "rooms" }));
    raceButtons.push(b);
    return b;
  }
  // 練習 (すぐ走るの次。はじめての人が迷わないように 上に)
  const tracks = el("div", { class: "trackcards" });
  const thumbs: Array<() => void> = [];
  // 公式コースは「公式」と「実在のサーキット」に分けて見出しを付ける (カードの並びの 1 行を使う)
  const group = (text: string) => tracks.append(el("div", { class: "label", style: "grid-column:1/-1;margin-top:4px" }, text));
  for (const [i, def] of TRACK_DEFS.entries()) {
    if (i === 0 || isRealCircuitId(def.id) !== isRealCircuitId(TRACK_DEFS[i - 1].id)) group(isRealCircuitId(def.id) ? "実在のサーキット" : "公式コース");
    const t = getTrack(def.id);
    const c = el("canvas") as HTMLCanvasElement;
    const b = el(
      "button",
      { class: "trackcard" },
      c,
      el("span", { class: "tc-meta" }, el("b", {}, def.name), el("span", { class: "num" }, `${(t.length / 1000).toFixed(2)} km`)),
    ) as HTMLButtonElement;
    b.addEventListener("click", () => go({ name: "practice", trackId: def.id }));
    raceButtons.push(b);
    tracks.append(b);
    thumbs.push(() => {
      const w = b.clientWidth || 140;
      const h = 84;
      const dpr = fitCanvas(c, w, h);
      c.style.width = "100%";
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const p = palette();
      drawTrackCard(ctx, t.px, t.py, w, h, p, p.accent);
    });
  }
  // 自分で作ったコース (確かめが通るもの) と「コースをつくる」 (ui/tracks.ts)
  group("自分のコース");
  for (const b of userTrackCards(go, thumbs)) {
    raceButtons.push(b);
    tracks.append(b);
  }
  tracks.append(editorCard(go));
  requestAnimationFrame(() => thumbs.forEach((f) => f()));
  right.append(
    el(
      "section",
      { class: "frame" },
      el("div", { class: "section-title" }, el("h3", {}, "練習"), el("span", { class: "label" }, "Solo · Offline")),
      el("p", { class: "dim", style: "margin:0 0 10px;font-size:13px" }, "ひとりで好きなだけ周回。一番速い周が幽霊になって一緒に走ります。"),
      tracks,
    ),
  );
  // みんなのコース (公開されたもの)
  right.append(communitySection(go));
  // 1 周アタック (毎週お題のコース)
  right.append(taMenuSection(go));
  // リーグ戦 (2 時間ごとの自動のレース)
  right.append(leagueMenuSection(go));
  // 季節と大会 (管理者なら管理も)
  right.append(seasonMenuSection(go));

  // 設定と遊び方 (紙の色の切りかえは F1 中継風にしたのでなくした)
  const assistT = toggle(
    [
      ["manual", "ふつう"],
      ["assist", "かんたん"],
    ],
    s.assist ? "assist" : "manual",
    (v) => {
      s.assist = v === "assist";
      save();
    },
  );
  const transT = toggle(
    [
      ["at", "オートマ"],
      ["mt", "マニュアル"],
    ],
    s.manual ? "mt" : "at",
    (v) => {
      s.manual = v === "mt";
      save();
    },
  );
  // オープニング (ゲームを開いたときの画面): ふつう (約 3 秒) / 短く (約 1 秒) / なし。光るのは次に開いたときの形
  const openingT = toggle(
    [
      ["full", "ふつう"],
      ["short", "短く"],
      ["off", "なし"],
    ],
    effectiveSetting(loadOpeningPrefs()),
    (v) => saveOpeningPrefs({ setting: v as "full" | "short" | "off" }),
  );
  right.append(
    el(
      "section",
      { class: "frame menu-settings" },
      el("div", { class: "section-title" }, el("h3", {}, "設定と遊び方"), el("span", { class: "label" }, "Settings")),
      el("div", { class: "setting" }, el("span", { class: "k" }, "操作"), assistT, el("span", { class: "hint" }, "かんたん = アクセル自動・曲がりで自動ブレーキ")),
      // 変速 (パソコンだけ。さわる機械では出さず、走るときもオートマ)
      el(
        "div",
        { class: "setting fine-only" },
        el("span", { class: "k" }, "変速"),
        transT,
        el("span", { class: "hint" }, `マニュアル = X / Shift で上げ、Z / Ctrl で下げる。上手に変えると速さ +${Math.round(manualBonus() * 100)}%`),
      ),
      ...soundSettingRows(),
      el("div", { class: "setting" }, el("span", { class: "k" }, "オープニング"), openingT, el("span", { class: "hint" }, "ゲームを開いたときの図面と題名。押すと飛ばせます")),
      // ギフトコード (ログインしているときだけ)
      ...giftMenuRows(),
      el(
        "ul",
        { class: "notes" },
        el("li", {}, "ハンドル ◀ ▶、アクセル、ブレーキ (Mac は ← → と ↑ ↓)"),
        el("li", {}, "前の車と 1 秒以内でスタートの線を越えると、次の周にオーバーテイク (Q・OT のボタン) で力を足せます"),
        el("li", {}, "赤い信号が全部消えたらアクセル。早すぎるとフライングで +5 秒"),
        el("li", {}, "止まっているときにブレーキを押し続けると下がれます"),
        el("li", {}, "車どうしはぶつかります。壁に当たると遅くなります"),
        el("li", {}, "燃料が切れるとリタイア。長いレースは大きいタンクを"),
      ),
    ),
  );

  function refresh() {
    carSel.innerHTML = "";
    s.designs.forEach((d, i) => {
      const bad = validateDesign(d).length > 0;
      carSel.append(el("option", { value: String(i) }, `${d.name}${bad ? " (未完成)" : ""}`));
    });
    if (!s.designs.length) carSel.append(el("option", { value: "0" }, "— まだありません —"));
    carSel.value = String(Math.min(s.active, Math.max(0, s.designs.length - 1)));
    const d = s.designs[s.active] ?? null;
    const errs = d ? validateDesign(d) : ["まだ車がありません"];
    carNo.textContent = String((s.active ?? 0) + 1).padStart(2, "0");
    status.innerHTML = "";
    status.append(el("div", { class: errs.length ? "callout" : "callout ok" }, errs.length ? `走るには車を仕上げてください — ${errs[0]}` : "走れます"));
    for (const b of raceButtons) b.disabled = errs.length > 0;
    buildBtn.textContent = s.designs.length ? "車をつくる・直す" : "はじめての車をつくる";
    // はじめての人への案内: 車がなければ「まず車をつくる」、あるけれど走れなければ「車を仕上げる」。走れるなら出さない
    startCta.innerHTML = "";
    startCta.hidden = errs.length === 0;
    if (errs.length) {
      const fresh = !d || !d.parts.length;
      const cta = el("button", { class: "go start-go" }, fresh ? "まず車をつくる ▶" : "車を仕上げる ▶");
      cta.addEventListener("click", () => go({ name: "builder" }));
      startCta.append(
        el("div", { class: "section-title" }, el("h3", {}, fresh ? "はじめに" : "もう少しで走れます"), el("span", { class: "label" }, "Start here")),
        el(
          "p",
          { class: "start-text" },
          fresh ? "マス目に部品を並べて車をつくります。車づくりの「見本を置く」を押せば すぐ走れる形になります。" : `走るには: ${errs[0]}`,
        ),
        cta,
        el("p", { class: "start-next dim" }, "車ができたら「すぐ走る」でみんなと、「練習」でひとりで走れます。"),
      );
    }

    // 数字の札
    stats.innerHTML = "";
    const st = d && !errs.length ? computeStats(d) : null;
    stats.classList.toggle("empty", !st);
    for (const [k, v, unit] of [
      ["重さ", st ? String(Math.round(st.mass)) : "—", "kg"],
      ["力", st ? String(Math.round(st.power)) : "—", "kW"],
      ["最高速", st ? String(Math.round(st.topSpeed * 3.6)) : "—", "km/h"],
      ["燃料", st ? String(st.fuelCap) : "—", "L"],
    ]) {
      stats.append(el("div", {}, el("span", { class: "label" }, k), el("b", {}, v), el("small", {}, unit)));
    }

    // 車の絵
    const w = Math.max(240, showcase.clientWidth - 2);
    const h = Math.round(Math.max(220, Math.min(window.innerHeight * 0.46, w * 0.92)));
    const dpr = fitCanvas(canvas, w, h);
    canvas.style.width = "100%";
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCarShowcase(ctx, d && d.parts.length ? d : null, w, h, palette());
  }

  const onResize = () => {
    refresh();
    thumbs.forEach((f) => f());
  };
  window.addEventListener("resize", onResize);
  refresh();
  // 字体が読めたら絵をかき直す
  document.fonts?.ready.then(() => onResize());
  return () => window.removeEventListener("resize", onResize);
}

/** まとまりの見出し (走る・チーム) */
function groupHead(jp: string, en: string): HTMLElement {
  return el("div", { class: "menu-group-head" }, el("h2", {}, jp), el("span", { class: "label" }, en));
}

function toggle(options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLElement {
  const box = el("div", { class: "toggle", role: "group" });
  const buttons: HTMLButtonElement[] = [];
  for (const [v, label] of options) {
    const b = el("button", { class: v === value ? "on" : "", "aria-pressed": String(v === value) }, label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      for (const x of buttons) {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      }
      onChange(v);
    });
    buttons.push(b);
    box.append(b);
  }
  return box;
}
