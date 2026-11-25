// 開いた部屋 (11/25 決まり「部屋も開ける (開く人がコース・周回数・級を決める)。合言葉はなし」) の一覧 (SQLite の表 1 つ)。
// AccountsDO が中に持つ。部屋そのものは worker.ts の RaceRoomDO ("custom-<id>")。部屋は段階や人の数が変わるたびに update で知らせる。
// 部屋が知らせてこなくなったとき (落ちた・誰も来なかった) のために、行は expires_at を過ぎたら一覧から消す。
// /api/rooms の受け口もここ。Cloudflare に頼らないので試験でそのまま動かせる
import {
  CUSTOM_LAPS_MAX,
  CUSTOM_LAPS_MIN,
  LOWEST_CLASS,
  MAX_CARS,
  isOfficialTrackId,
  joinBlock,
  validateCustomRoom,
  type ClassId,
  type CustomRoomConfig,
  type JoinBlock,
  type Phase,
  type RoomInfo,
  type RoomSpecIssue,
  type TrackDef,
} from "@bpr/shared";
import { ApiError, type Account, type AccountStore, type SqlRunner, type SqlValue } from "./accounts.ts";

/** 開いたのに誰も入らない部屋を一覧に残す時間 (仮) */
export const CUSTOM_ROOM_EMPTY_MS = 3 * 60_000;
/** 部屋の段階の終わりの時刻を過ぎても知らせがないとき、一覧に残す時間 (仮) */
export const CUSTOM_ROOM_GRACE_MS = 2 * 60_000;
/** 一度に開いていられる部屋の数 (全体、仮) */
export const CUSTOM_ROOMS_MAX = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS custom_rooms (
  id TEXT PRIMARY KEY,
  host_account INTEGER NOT NULL,
  host_name TEXT NOT NULL,
  track TEXT NOT NULL,
  track_name TEXT NOT NULL,
  laps INTEGER NOT NULL,
  cls INTEGER NOT NULL,
  phase TEXT NOT NULL,
  humans INTEGER NOT NULL,
  cars INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS custom_rooms_host ON custom_rooms(host_account);
`;

/** 部屋が知らせてくる様子 */
export interface CustomRoomStatus {
  phase: Phase;
  /** つながっている人の数と、2 台目を合わせた車の数 */
  humans: number;
  cars: number;
  /** 今の段階が終わる時刻 (ms) */
  endsAt: number;
}

export interface CustomRoomRow {
  id: string;
  hostAccount: number;
  hostName: string;
  trackId: string;
  trackName: string;
  laps: number;
  cls: ClassId;
  phase: Phase;
  humans: number;
  cars: number;
  endsAt: number;
  expiresAt: number;
  createdAt: number;
}

/** 画面に返す 1 部屋 */
export interface RoomView {
  id: string;
  trackId: string;
  trackName: string;
  laps: number;
  cls: ClassId;
  host: string;
  phase: Phase;
  humans: number;
  cars: number;
  seats: number;
  endsAt: number;
  createdAt: number;
  /** 自分が開いた部屋 */
  mine: boolean;
  /** 入れないわけ (入れるなら null) */
  block: JoinBlock | null;
}

export interface RoomsDeps {
  sql: SqlRunner;
  tx<T>(fn: () => T): T;
  now?: () => number;
}

function randomRoomId(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += chars[x % chars.length];
  return s;
}

/** 部屋の id の形 (worker.ts の /ws?room= でも確かめる) */
export const ROOM_ID_RE = /^[a-z0-9]{6,24}$/;

export class RoomRegistry {
  private sql: SqlRunner;
  private tx: <T>(fn: () => T) => T;
  readonly now: () => number;

  constructor(deps: RoomsDeps) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? Date.now;
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) this.sql.exec(stmt);
  }

  private rows(q: string, ...b: SqlValue[]) {
    return this.sql.exec(q, ...b).toArray();
  }

  private toRow(r: Record<string, SqlValue>): CustomRoomRow {
    return {
      id: String(r.id),
      hostAccount: Number(r.host_account),
      hostName: String(r.host_name),
      trackId: String(r.track),
      trackName: String(r.track_name),
      laps: Number(r.laps),
      cls: Number(r.cls) as ClassId,
      phase: String(r.phase) as Phase,
      humans: Number(r.humans),
      cars: Number(r.cars),
      endsAt: Number(r.ends_at),
      expiresAt: Number(r.expires_at),
      createdAt: Number(r.created_at),
    };
  }

  /** 古くなった行を消す */
  purge(now = this.now()) {
    this.sql.exec("DELETE FROM custom_rooms WHERE expires_at <= ?", now);
  }

  /** 開いている部屋 (古い順) */
  list(now = this.now()): CustomRoomRow[] {
    this.purge(now);
    return this.rows("SELECT * FROM custom_rooms ORDER BY created_at, id").map((r) => this.toRow(r));
  }

  get(id: string, now = this.now()): CustomRoomRow | null {
    this.purge(now);
    const r = this.rows("SELECT * FROM custom_rooms WHERE id = ?", id)[0];
    return r ? this.toRow(r) : null;
  }

  /** その人が開いていて、まだ開いている部屋 */
  hostedBy(accountId: number, now = this.now()): CustomRoomRow | null {
    this.purge(now);
    const r = this.rows("SELECT * FROM custom_rooms WHERE host_account = ? ORDER BY created_at DESC LIMIT 1", accountId)[0];
    return r ? this.toRow(r) : null;
  }

  /**
   * 部屋を開く (一覧に入れる)。確かめは呼ぶ側 (handleRoomsApi) で済ませておく。
   * 同じ人がもう開いている部屋があれば、それを返す (1 人 1 部屋、仮)
   */
  create(host: { accountId: number; name: string }, spec: { trackId: string; trackName: string; laps: number; cls: ClassId }): { row: CustomRoomRow; created: boolean } {
    const now = this.now();
    return this.tx(() => {
      this.purge(now);
      const mine = this.hostedBy(host.accountId, now);
      if (mine) return { row: mine, created: false };
      const n = Number(this.rows("SELECT COUNT(*) AS c FROM custom_rooms")[0]?.c ?? 0);
      if (n >= CUSTOM_ROOMS_MAX) throw new ApiError(429, "開いている部屋が多すぎます。しばらくしてからもう一度");
      let id = randomRoomId();
      while (this.rows("SELECT id FROM custom_rooms WHERE id = ?", id).length) id = randomRoomId();
      this.sql.exec(
        "INSERT INTO custom_rooms (id, host_account, host_name, track, track_name, laps, cls, phase, humans, cars, ends_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0, 0, ?, ?)",
        id,
        host.accountId,
        host.name,
        spec.trackId,
        spec.trackName,
        spec.laps,
        spec.cls,
        now + CUSTOM_ROOM_EMPTY_MS,
        now,
      );
      return { row: this.get(id, now)!, created: true };
    });
  }

  /** 部屋から: 様子が変わった。phase が idle なら閉じた (一覧から消す)。行がなければ false */
  update(id: string, st: CustomRoomStatus): boolean {
    const now = this.now();
    if (st.phase === "idle") {
      this.remove(id);
      return false;
    }
    const ends = Number.isFinite(st.endsAt) ? st.endsAt : now;
    const r = this.rows(
      "UPDATE custom_rooms SET phase = ?, humans = ?, cars = ?, ends_at = ?, expires_at = ? WHERE id = ? RETURNING id",
      st.phase,
      Math.max(0, Math.floor(st.humans)),
      Math.max(0, Math.floor(st.cars)),
      ends,
      Math.max(now, ends) + CUSTOM_ROOM_GRACE_MS,
      id,
    );
    return r.length > 0;
  }

  remove(id: string) {
    this.sql.exec("DELETE FROM custom_rooms WHERE id = ?", id);
  }

  /** 退会したとき: その人の開いた部屋を一覧から消す (部屋の中のレースはそのまま) */
  forgetAccount(accountId: number) {
    this.sql.exec("DELETE FROM custom_rooms WHERE host_account = ?", accountId);
  }
}

/** 一覧の行 → matchmaking.ts の RoomInfo (入れるかを joinBlock で確かめる) */
export function roomInfoOf(r: CustomRoomRow): RoomInfo {
  return {
    id: r.id,
    kind: "custom",
    cls: r.cls,
    laps: r.laps,
    trackId: r.trackId,
    // 待合 (まだ誰も来ていない部屋と、結果のあとの次の待合を含む) なら入れる。レース中は終わるまで待つ
    open: r.phase !== "race",
    usedSeats: r.humans,
    seats: MAX_CARS,
    createdAt: r.createdAt,
    closesAt: r.phase === "lobby" ? r.endsAt : 0,
    hostTeamId: String(r.hostAccount),
  };
}

/** 入れないわけ (画面に出す文) */
export const JOIN_BLOCK_TEXT: Record<JoinBlock, string> = {
  started: "レース中です。終わったら入れます",
  class: "級がちがう部屋には入れません",
  full: "満員です",
  closing: "もうすぐスタートするので入れません",
};

export const ISSUE_TEXT: Record<RoomSpecIssue, string> = {
  track: "コース",
  laps: `周回 (${CUSTOM_LAPS_MIN}〜${CUSTOM_LAPS_MAX})`,
  class: "級",
  host_class: "級 (開く人の級だけ)",
};

// ---------------------------------------------------------------- /api/rooms

export const ROOMS_PATH = /^\/api\/rooms(\/|$)/;

export interface RoomsApiDeps {
  accounts: AccountStore;
  rooms: RoomRegistry;
  /** そのアカウントの今の級 (season.ts の playClass) */
  classOf: (accountId: number) => ClassId;
  /** 部屋を開けるコース (公式 + 公開中のみんなのコース): id と名前 */
  tracks: () => Array<{ id: string; name: string }>;
  /** コースの形 (公式でないコースは部屋に渡す)。知らなければ null */
  trackDef: (id: string) => TrackDef | null;
  /** 部屋の DO を開く (worker.ts の RaceRoomDO.setupCustom)。開けなければ false か throw */
  launch: (cfg: CustomRoomConfig) => Promise<boolean>;
}

const MAX_BODY = 16 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "送るものが大きすぎます");
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下で断る */
  }
  throw new ApiError(400, "送られてきたものが読めません");
}

/** 一覧に出す形 */
export function roomView(r: CustomRoomRow, seeker: { teamId: string; cls: ClassId }, me: number | null, now: number): RoomView {
  return {
    id: r.id,
    trackId: r.trackId,
    trackName: r.trackName,
    laps: r.laps,
    cls: r.cls,
    host: r.hostName,
    phase: r.phase,
    humans: r.humans,
    cars: r.cars,
    seats: MAX_CARS,
    endsAt: r.endsAt,
    createdAt: r.createdAt,
    mine: me !== null && r.hostAccount === me,
    // 席は 1 台目の分だけ見る (2 台目は空きがあるときだけ出る)
    block: joinBlock({ teamId: seeker.teamId, cls: seeker.cls, cars: 1 }, roomInfoOf(r), now),
  };
}

/**
 * GET  /api/rooms              開いている部屋の一覧 (ログインなしでも見られる。級は名無しなら一番下) と、開くときに選べるもの
 * POST /api/rooms              部屋を開く { trackId, laps } (ログインが要る。級は自分の級)。もう開いていればその部屋
 * POST /api/rooms/:id/join     入れるか確かめる (入るのは /ws?room=<id>)
 */
export async function handleRoomsApi(req: Request, path: string, method: string, d: RoomsApiDeps): Promise<Response> {
  try {
    return await route(req, path, method.toUpperCase(), d);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("rooms api", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}

async function route(req: Request, path: string, M: string, d: RoomsApiDeps): Promise<Response> {
  const acc: Account | null = await d.accounts.auth(bearer(req));
  const now = d.rooms.now();
  const seeker = { teamId: acc ? String(acc.id) : "anon", cls: acc ? d.classOf(acc.id) : LOWEST_CLASS };
  const me = acc?.id ?? null;

  if (path === "/api/rooms" && M === "GET") {
    const rooms = d.rooms.list(now).map((r) => roomView(r, seeker, me, now));
    return json({ rooms, cls: seeker.cls, loggedIn: !!acc, tracks: d.tracks(), laps: { min: CUSTOM_LAPS_MIN, max: CUSTOM_LAPS_MAX } });
  }
  if (path === "/api/rooms" && M === "POST") {
    if (!acc) throw new ApiError(401, "部屋を開くにはログインしてください");
    const b = await body(req);
    const spec = { trackId: String(b.trackId ?? ""), laps: Number(b.laps), cls: seeker.cls };
    const tracks = d.tracks();
    const issues = validateCustomRoom(spec, { teamId: seeker.teamId, cls: seeker.cls }, tracks.map((t) => t.id));
    if (issues.length) throw new ApiError(400, `部屋の決めごとがおかしいです: ${issues.map((i) => ISSUE_TEXT[i]).join("・")}`);
    const def = d.trackDef(spec.trackId);
    if (!def) throw new ApiError(400, "そのコースは使えません");
    const name = tracks.find((t) => t.id === spec.trackId)?.name ?? def.name;
    const made = d.rooms.create({ accountId: acc.id, name: acc.driver }, { trackId: spec.trackId, trackName: name, laps: spec.laps, cls: spec.cls });
    if (made.created) {
      const cfg: CustomRoomConfig = {
        id: made.row.id,
        trackId: spec.trackId,
        laps: spec.laps,
        cls: spec.cls,
        hostAccount: acc.id,
        hostName: acc.driver,
        // みんなのコースは形も渡す (部屋は AccountsDO に聞き直さない)
        ...(!isOfficialTrackId(spec.trackId) ? { trackDef: def } : {}),
      };
      let ok = false;
      try {
        ok = await d.launch(cfg);
      } catch (e) {
        console.error("custom room launch", (e as Error)?.message ?? e);
      }
      if (!ok) {
        d.rooms.remove(made.row.id);
        throw new ApiError(503, "部屋を開けませんでした。もう一度ためしてください");
      }
    }
    return json({ room: roomView(made.row, seeker, me, now), created: made.created }, made.created ? 201 : 200);
  }
  const jm = /^\/api\/rooms\/([a-z0-9]{6,24})\/join$/.exec(path);
  if (jm && M === "POST") {
    const r = d.rooms.get(jm[1], now);
    if (!r) throw new ApiError(404, "その部屋は閉じました");
    const v = roomView(r, seeker, me, now);
    if (v.block) throw new ApiError(409, JOIN_BLOCK_TEXT[v.block]);
    return json({ room: v });
  }
  throw new ApiError(404, "ありません");
}
