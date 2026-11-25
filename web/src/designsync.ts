// 設計図をサーバー (/api/designs) と合わせる決まり (11/25「設計図はこの機械の中だけ」の続き)。中身は通信なしの計算だけ (試験できる)。
// 呼ぶのは store.ts (保存したとき・ログインしたとき)。
// - 合わせる印は設計図ごと (rid → サーバーの id・最後に合わせた中身・サーバーの更新時刻・この機械で変えた時刻)
// - 両方で変わっていたら、新しく変えた方 (この機械の時刻とサーバーの時刻を比べる)
// - この機械の設計図は消さない (ログインしていない遊びの設計図も、サーバーで消えた設計図も残す)。
//   サーバーで消えた (売った・ほかの機械で捨てた) ものは つながりを切って残し、また直したら新しく送る
// - この機械で捨てた設計図は、サーバーからも消す
import type { CarDesign, Placed } from "@bpr/shared";

/** 1 つの設計図の合わせ具合 */
export interface DesignSyncMeta {
  /** サーバーの設計図の id (なし = まだ送っていない・つながりを切った) */
  sid?: number;
  /** 最後にサーバーと合わせた中身の印 ("" = 一度も合わせていない) */
  key: string;
  /** 最後に合わせたときのサーバーの更新時刻 (ms) */
  srv: number;
  /** この機械で最後に中身が変わった時刻 (ms) と、そのときの中身の印 */
  at: number;
  seen: string;
  /** 送って断られた中身の印 (持っていない部品・数の上限)。中身が変わるまで送り直さない */
  fail?: string;
}

export interface DesignSyncState {
  /** 合わせているアカウント (ログインの ID)。ちがう人がログインしたら印を作り直す */
  owner: string | null;
  /** 設計図の rid → 合わせ具合 */
  meta: Record<string, DesignSyncMeta>;
  /** この機械で捨てた、サーバーにある設計図の id (次に合わせるときに消す) */
  gone: number[];
}

export type SyncDesign = CarDesign & { rid?: string };

export interface ServerDesign {
  id: number;
  name: string;
  design: CarDesign;
  updatedAt: number;
}

export type SyncOp = { kind: "post"; rid: string } | { kind: "put"; rid: string; sid: number } | { kind: "delete"; sid: number };

export function newSyncState(): DesignSyncState {
  return { owner: null, meta: {}, gone: [] };
}

function partsKeyOf(parts: readonly Placed[]): string {
  return parts
    .map((p) => `${p.id}@${p.c},${p.r},${p.rot}`)
    .sort()
    .join("|");
}

/** 中身の印 (名前と部品の並びの短いハッシュ。この機械に残すので短く) */
export function designKey(d: CarDesign): string {
  const s = `${d.name}\n${partsKeyOf(d.parts)}`;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}${s.length.toString(36)}`;
}

/**
 * ログインした人に合わせる。はじめてのログイン (owner なし) はこの機械の設計図を全部送る番に。
 * ちがう人に変わったら、前の人のつながりを全部切る (この機械の設計図は、直すまでは新しい人に送らない)
 */
export function adoptOwner(designs: readonly SyncDesign[], st: DesignSyncState, owner: string): void {
  if (st.owner === owner) return;
  if (st.owner !== null) {
    st.meta = {};
    st.gone = [];
    for (const d of designs) if (d.rid) st.meta[d.rid] = { key: designKey(d), srv: 0, at: 0, seen: designKey(d) };
  }
  st.owner = owner;
}

/** この機械で変わった設計図の時刻を進め、捨てた設計図を gone に入れる */
export function noteLocalEdits(designs: readonly SyncDesign[], st: DesignSyncState, now: number): void {
  const live = new Set<string>();
  for (const d of designs) {
    if (!d.rid) continue;
    live.add(d.rid);
    const k = designKey(d);
    const m = st.meta[d.rid];
    if (!m) st.meta[d.rid] = { key: "", srv: 0, at: now, seen: k };
    else if (m.seen !== k) {
      m.seen = k;
      m.at = now;
    }
  }
  for (const [rid, m] of Object.entries(st.meta)) {
    if (live.has(rid)) continue;
    if (m.sid !== undefined && !st.gone.includes(m.sid)) st.gone.push(m.sid);
    delete st.meta[rid];
  }
}

/**
 * サーバーの一覧と合わせる (designs は書きかえる: サーバーで新しくなった中身を入れ、サーバーにしかない設計図を後ろに足す)。
 * 返すのは サーバーに頼むこと (送る・上書き・消す)。newRid = 足す設計図の印を作る
 */
export function mergeDesigns(designs: SyncDesign[], st: DesignSyncState, server: readonly ServerDesign[], newRid: () => string): { ops: SyncOp[]; added: number; updated: number } {
  const ops: SyncOp[] = [];
  let added = 0;
  let updated = 0;
  const gone = new Set(st.gone);
  for (const sid of st.gone) if (server.some((s) => s.id === sid)) ops.push({ kind: "delete", sid });
  st.gone = st.gone.filter((sid) => server.some((s) => s.id === sid));
  const byId = new Map(server.filter((s) => !gone.has(s.id)).map((s) => [s.id, s]));
  const linked = new Set<number>();
  for (const d of designs) {
    const m = d.rid ? st.meta[d.rid] : undefined;
    if (m?.sid !== undefined && byId.has(m.sid)) linked.add(m.sid);
  }
  for (const d of designs) {
    if (!d.rid) d.rid = newRid();
    const k = designKey(d);
    const m = (st.meta[d.rid] ??= { key: "", srv: 0, at: 0, seen: k });
    const dirty = k !== m.key;
    if (m.sid !== undefined) {
      const s = byId.get(m.sid);
      if (!s) {
        // サーバーで消えた: つながりを切って残す (直すまで送り直さない)
        delete m.sid;
        m.key = k;
        m.srv = 0;
        continue;
      }
      const srvChanged = s.updatedAt > m.srv;
      if (srvChanged && (!dirty || s.updatedAt >= m.at)) {
        // サーバーの方が新しい: この機械の中身を替える
        if (designKey(s.design) !== k) {
          d.name = s.design.name;
          d.parts = s.design.parts.map((p) => ({ ...p }));
          updated++;
        }
        const nk = designKey(d);
        Object.assign(m, { key: nk, seen: nk, srv: s.updatedAt, at: s.updatedAt });
        delete m.fail;
      } else if (dirty && m.fail !== k) ops.push({ kind: "put", rid: d.rid, sid: m.sid });
      continue;
    }
    // まだつながっていない: 同じ中身のサーバーの設計図があればつなぐ (チームの車に送った写しなど)
    const same = server.find((s) => !gone.has(s.id) && !linked.has(s.id) && designKey(s.design) === k);
    if (same) {
      linked.add(same.id);
      Object.assign(m, { sid: same.id, key: k, srv: same.updatedAt });
      delete m.fail;
      continue;
    }
    if (dirty && m.fail !== k) ops.push({ kind: "post", rid: d.rid });
  }
  // サーバーにしかない設計図を足す
  for (const s of byId.values()) {
    if (linked.has(s.id)) continue;
    const rid = newRid();
    const d: SyncDesign = { name: s.design.name, parts: s.design.parts.map((p) => ({ ...p })), rid };
    designs.push(d);
    const k = designKey(d);
    st.meta[rid] = { sid: s.id, key: k, srv: s.updatedAt, at: s.updatedAt, seen: k };
    linked.add(s.id);
    added++;
  }
  return { ops, added, updated };
}

/** 送れたとき (post / put) */
export function markUploaded(st: DesignSyncState, rid: string, sent: CarDesign, saved: { id: number; updatedAt: number }): void {
  const m = st.meta[rid];
  if (!m) return;
  m.sid = saved.id;
  m.key = designKey(sent);
  m.srv = saved.updatedAt;
  delete m.fail;
}

/** 断られたとき (400: 持っていない部品・上限)。404 (上書きする先が無い) はつながりを切る */
export function markRejected(st: DesignSyncState, rid: string, sent: CarDesign, status: number): void {
  const m = st.meta[rid];
  if (!m) return;
  if (status === 404) {
    delete m.sid;
    m.srv = 0;
    return;
  }
  m.fail = designKey(sent);
}
