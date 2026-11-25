// この機械の中に保存する。ログインしているときは設計図だけサーバー (/api/designs) とも合わせる (designsync.ts)
import type { CarDesign, Placed, Sky, TireAlloc, TireCompound } from "@bpr/shared";
import { ApiFail, cachedMe, deleteDesign, getToken, listDesigns, onAccountChange, saveDesign } from "./api.ts";
import { adoptOwner, markRejected, markUploaded, mergeDesigns, newSyncState, noteLocalEdits, type DesignSyncState } from "./designsync.ts";

export interface Ghost {
  lap: number;
  /** 0.1 秒ごとの [x, y, 向き] */
  pts: number[];
  /** その周を走った設計図の版 (例 "Rev.B"。前の記録にはない) */
  rev?: string;
}

/** 設計図の版 (改訂番号 Rev.A・Rev.B…)。車づくりで変えて、走れる形で残すたびに 1 つ増える */
export interface Revision {
  /** 通し番号 (0 = A、25 = Z、26 = AA …) */
  n: number;
  /** 残した時刻 (ms) */
  at: number;
  parts: Placed[];
  /** コースの id → この版の一番速い周 (秒、晴れの練習) */
  best: Record<string, number>;
}

/** 保存する設計図。rid = 版の帳面 (Save.revs) を引く印 (前の保存にはない。要るときに付ける) */
export type StoredDesign = CarDesign & { rid?: string };

/** 1 つの設計図に残す版の数の上限 (仮)。超えたら古い版から消す (一番速い周を持つ版はなるべく残す) */
export const REV_CAP = 26;

/** 走る前の準備 (タイヤと燃料) */
export interface RaceSetup {
  tire: TireCompound;
  /** full = 満タン・race = レースの分だけ (少し余分)・light = 少なめ */
  fuel: "full" | "race" | "light";
  /** 持っていくタイヤの組の好み (種類ごとの数。なし = コンピューターのおすすめ)。レースの上限に合わせて減らして使う */
  alloc?: TireAlloc;
  /**
   * tire をどの路面のために選んだか (setup.ts の fitKind: 乾いた路面 = slick・I・W)。
   * 今の天気がちがえば 合うタイヤをおまかせで選ぶ。なし (前の保存) = tire に合う路面のために選んだ扱い
   */
  tireFor?: "slick" | "I" | "W";
}

/** 練習の天気: 決まった空か、途中で変わる (mix) */
export type PracticeSky = Sky | "mix";

export interface Save {
  v: 1;
  name: string;
  /** つなぎ直しに使う、この機械の印 */
  key: string;
  designs: StoredDesign[];
  active: number;
  /** 設計図の版の帳面: 設計図の rid → 版 (古い順) */
  revs: Record<string, Revision[]>;
  paper: "blue" | "white";
  ghosts: Record<string, Ghost>;
  /** かんたん操作 (アクセル自動 + 曲がりで自動ブレーキ) */
  assist: boolean;
  /** 変速: true = マニュアル (自分で変える。パソコンだけ)。なし・false = オートマ (11/25 足した) */
  manual?: boolean;
  setup: RaceSetup;
  practiceSky: PracticeSky;
  /** 設計図をサーバーと合わせた印 (designsync.ts。ログインしたことがなければ なし) */
  designSync?: DesignSyncState;
}

const KEY = "bpr.save.v1";

function fresh(): Save {
  return {
    v: 1,
    name: "",
    key: randomKey(),
    designs: [],
    active: 0,
    revs: {},
    paper: "blue",
    ghosts: {},
    assist: false,
    setup: { tire: "M", fuel: "full" },
    practiceSky: "sun",
  };
}

function randomKey(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let cache: Save | null = null;

export function load(): Save {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Save;
      if (s && s.v === 1) {
        cache = { ...fresh(), ...s };
        return cache;
      }
    }
  } catch {
    /* 読めなければ新しく */
  }
  cache = fresh();
  return cache;
}

function write(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    /* 保存できない (内緒の窓など) */
  }
}

export function save(): void {
  write();
  // ログインしていれば、少し待ってから設計図をサーバーと合わせる (続けて保存しても 1 回)
  if (getToken()) scheduleDesignSync(DESIGN_SYNC_DELAY_MS);
}

// ---- 設計図をサーバーと合わせる (ログインしているときだけ) ----

/** 保存してからサーバーに送るまでの待ち (ms、仮) */
const DESIGN_SYNC_DELAY_MS = 2000;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let syncAgain = false;
const syncListeners = new Set<(r: { added: number; updated: number }) => void>();

/** サーバーから設計図が足された・変わったときに呼ぶ (一覧を描き直すため) */
export function onDesignsSynced(fn: (r: { added: number; updated: number }) => void): () => void {
  syncListeners.add(fn);
  return () => syncListeners.delete(fn);
}

function scheduleDesignSync(ms: number) {
  if (typeof window === "undefined") return;
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncDesigns();
  }, ms);
}

/** 今すぐ合わせる (ログインしていなければ何もしない)。サーバーに届かなければ次の保存で */
export async function syncDesigns(): Promise<void> {
  const me = cachedMe();
  if (!getToken() || !me) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    const s = load();
    const st = (s.designSync ??= newSyncState());
    adoptOwner(s.designs, st, me.id);
    noteLocalEdits(s.designs, st, Date.now());
    const server = await listDesigns();
    // 待っている間にログインし直した・別の人になった
    if (cachedMe()?.id !== me.id) return;
    noteLocalEdits(s.designs, st, Date.now());
    const r = mergeDesigns(s.designs, st, server, () => randomKey().slice(0, 12));
    write();
    if (r.added || r.updated) for (const fn of syncListeners) fn(r);
    for (const op of r.ops) {
      if (op.kind === "delete") {
        await deleteDesign(op.sid).catch((e) => {
          if (!(e instanceof ApiFail && e.status === 404)) throw e;
        });
        st.gone = st.gone.filter((x) => x !== op.sid);
      } else {
        const d = s.designs.find((x) => x.rid === op.rid);
        if (!d) continue;
        const sent: CarDesign = { name: d.name, parts: d.parts.map((p) => ({ ...p })) };
        try {
          markUploaded(st, op.rid, sent, await saveDesign(sent, op.kind === "put" ? op.sid : undefined));
        } catch (e) {
          if (!(e instanceof ApiFail) || (e.status !== 400 && e.status !== 404)) throw e;
          markRejected(st, op.rid, sent, e.status);
        }
      }
      write();
    }
  } catch {
    /* つながらない・ログインが切れた: 次の保存かログインで */
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleDesignSync(DESIGN_SYNC_DELAY_MS);
    }
  }
}

// ログインしたら (と、ログインしたまま開いたら) サーバーの設計図を取ってきて合わせる
if (typeof window !== "undefined") {
  let lastToken = getToken();
  onAccountChange(() => {
    const t = getToken();
    if (t && t !== lastToken) scheduleDesignSync(0);
    lastToken = t;
  });
  if (lastToken) scheduleDesignSync(1500);
}

/** この機械でマニュアルを選べるか (細かく指せる指し物とキーボードのあるパソコン。スマホ・タブレットは選べない) */
export function canManual(): boolean {
  return typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** 走るときにマニュアルを使うか (保存がマニュアルでも、選べない機械ではオートマ) */
export function useManual(): boolean {
  return !!load().manual && canManual();
}

export function activeDesign(): CarDesign | null {
  const s = load();
  return s.designs[s.active] ?? s.designs[0] ?? null;
}

// ---- 設計図の版 (改訂番号) ----

/** 版の名前: 0 → "Rev.A"、25 → "Rev.Z"、26 → "Rev.AA" */
export function revLabel(n: number): string {
  let k = Math.max(0, Math.floor(n));
  let out = "";
  do {
    out = String.fromCharCode(65 + (k % 26)) + out;
    k = Math.floor(k / 26) - 1;
  } while (k >= 0);
  return `Rev.${out}`;
}

/** 部品の並びの印 (置いた順は見ない) */
export function partsKey(parts: readonly Placed[]): string {
  return parts
    .map((p) => `${p.id}@${p.c},${p.r},${p.rot}`)
    .sort()
    .join("|");
}

function ridOf(d: StoredDesign): string {
  if (!d.rid) d.rid = randomKey().slice(0, 12);
  return d.rid;
}

/** その設計図の版 (古い順) */
export function revisionsOf(d: CarDesign): Revision[] {
  const rid = (d as StoredDesign).rid;
  return rid ? (load().revs[rid] ?? []) : [];
}

/** 今の部品の並びと同じ版 (なければ null) */
export function currentRevision(d: CarDesign): Revision | null {
  const key = partsKey(d.parts);
  const list = revisionsOf(d);
  for (let i = list.length - 1; i >= 0; i--) if (partsKey(list[i].parts) === key) return list[i];
  return null;
}

/**
 * 今の形を版として残す (同じ形の版があれば それを返す)。走れる形かどうかは呼ぶ側が確かめる。
 * 上限を超えたら 古い版から消す (今の版と、どこかのコースで一番速い周を持つ版はなるべく残す)。保存もする
 */
export function commitRevision(d: CarDesign): Revision {
  const have = currentRevision(d);
  if (have) return have;
  const s = load();
  const rid = ridOf(d as StoredDesign);
  const list = (s.revs[rid] ??= []);
  const n = list.length ? list[list.length - 1].n + 1 : 0;
  const rev: Revision = { n, at: Date.now(), parts: d.parts.map((p) => ({ ...p })), best: {} };
  list.push(rev);
  while (list.length > REV_CAP) {
    const keep = new Set<Revision>([rev]);
    const tracks = new Set(list.flatMap((r) => Object.keys(r.best)));
    for (const t of tracks) {
      let top: Revision | null = null;
      for (const r of list) if (r.best[t] !== undefined && (!top || r.best[t] < top.best[t])) top = r;
      if (top) keep.add(top);
    }
    const i = list.findIndex((r) => !keep.has(r));
    list.splice(i >= 0 ? i : 0, 1);
  }
  save();
  return rev;
}

/** 版 n の、そのコースの一番速い周を記録する (速くなったら true。保存もする) */
export function recordRevisionLap(d: CarDesign, n: number, trackId: string, time: number): boolean {
  if (!(time > 0) || !Number.isFinite(time)) return false;
  const rev = revisionsOf(d).find((r) => r.n === n);
  if (!rev) return false;
  const old = rev.best[trackId];
  if (old !== undefined && old <= time) return false;
  rev.best[trackId] = time;
  save();
  return true;
}

/** 設計図を捨てたときに その版も捨てる */
export function dropRevisions(d: CarDesign): void {
  const rid = (d as StoredDesign).rid;
  if (!rid) return;
  delete load().revs[rid];
}

/** 前の「紙」の設定は使わなくなった (11/25 から F1 中継風の暗い画面 1 つ)。呼ばれても何もしない */
export function applyPaper(): void {
  delete document.documentElement.dataset.paper;
}

/** 画面の色 (キャンバスで使う) */
export interface Palette {
  paper: string;
  paper2: string;
  paper3: string;
  ink: string;
  ink2: string;
  dim: string;
  faint: string;
  ghost: string;
  accent: string;
  bad: string;
  good: string;
}

export function palette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    paper: v("--paper"),
    paper2: v("--paper-2"),
    paper3: v("--paper-3"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    dim: v("--ink-dim"),
    faint: v("--ink-faint"),
    ghost: v("--ink-ghost"),
    accent: v("--accent"),
    bad: v("--bad"),
    good: v("--good"),
  };
}
