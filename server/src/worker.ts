// サーバー: /ws?laps=2|5|10&n=0 で「すぐ走る」の部屋につなぐ。/api/... はアカウント (accounts_do.ts)。ほかは画面のファイル
import { DurableObject } from "cloudflare:workers";
import {
  LOWEST_CLASS,
  QUICK_LAPS,
  RaceRoom,
  isClassId,
  isPublicTrackId,
  quickRoomId,
  wetnessAt,
  type ClassId,
  type ClientMsg,
  type CustomRoomConfig,
  type FixedCarResult,
  type FixedField,
  type JoinTeam,
  type QuickLaps,
  type RaceReport,
  type RoomSnapshot,
  type ServerMsg,
  type TeamRaceReport,
} from "@bpr/shared";
import type { RaceFeed, RaceFeedCar } from "./season.ts";
import { AccountsDO } from "./accounts_do.ts";
import { LeagueDO } from "./league_do.ts";

export { AccountsDO, LeagueDO };

interface Env {
  ROOM: DurableObjectNamespace;
  ACCOUNTS: DurableObjectNamespace<AccountsDO>;
  /** リーグ戦 (2 時間ごとの自動のレース)。全員で 1 つ */
  LEAGUE: DurableObjectNamespace<LeagueDO>;
  ASSETS: Fetcher;
  BPR_ADMIN_IDS?: string;
}

/** リーグ戦の DO は全員で 1 つ */
function league(env: Env) {
  return env.LEAGUE.get(env.LEAGUE.idFromName("league"));
}

/** アカウントの DO は全員で 1 つ */
function accounts(env: Env) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/api/league" || url.pathname.startsWith("/api/league/")) return league(env).fetch(req);
    // 賭け (倍率はリーグの DO、お金はアカウントの DO。管理者の /api/admin/bets はアカウントの DO)
    if (url.pathname === "/api/bets" || url.pathname.startsWith("/api/bets/")) return league(env).fetch(req);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return accounts(env).fetch(req);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
      // 大会の組: /ws?tour=<大会の id>&g=<組の番号>
      const tour = url.searchParams.get("tour");
      if (tour !== null) {
        const g = Math.floor(Number(url.searchParams.get("g")));
        if (!/^[a-z0-9]{1,40}$/.test(tour) || !(g >= 0 && g < 100)) return new Response("bad tour", { status: 400 });
        return env.ROOM.get(env.ROOM.idFromName(`tour-${tour}-${g}`)).fetch(req);
      }
      // 開いた部屋: /ws?room=<部屋の id> (部屋は /api/rooms で開いたときにできている)
      const custom = url.searchParams.get("room");
      if (custom !== null) {
        if (!/^[a-z0-9]{6,24}$/.test(custom)) return new Response("bad room", { status: 400 });
        return env.ROOM.get(env.ROOM.idFromName(`custom-${custom}`)).fetch(req);
      }
      const laps = Number(url.searchParams.get("laps"));
      if (!(QUICK_LAPS as readonly number[]).includes(laps)) return new Response("bad laps", { status: 400 });
      const n = Math.max(0, Math.min(20, Math.floor(Number(url.searchParams.get("n")) || 0)));
      // すぐ走るは級ごとの部屋 (名無しは一番下の級)。級は hello で確かめる
      const c = Number(url.searchParams.get("cls"));
      const cls: ClassId = isClassId(c) ? c : LOWEST_CLASS;
      const id = env.ROOM.idFromName(quickRoomId(cls, laps as QuickLaps, n));
      return env.ROOM.get(id).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
  /** cron (wrangler.toml の triggers): 2 時間ごとにリーグ戦の DO を起こす。計算は DO が alarm で 1 レースずつ */
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(league(env).poke(Date.now()).then(() => undefined));
  },
};

/** レース中の刻み (ms) */
const TICK_MS = 50;
/** レース中の見張りの alarm (刻みが止まっていないか、追い出されていないかを見る) */
const WATCHDOG_MS = 30_000;

/** WebSocket ごとに持つもの (眠っても残る)。id は hello が通ってから。cls = すぐ走るの部屋の級 */
interface SockInfo {
  laps: number;
  id?: string;
  /** 大会の組の部屋 (部屋がなければ作らない) */
  tour?: boolean;
  /** 開いた部屋 (部屋がなければ作らない) */
  custom?: boolean;
}

/** 部屋の DO が storage に残すもの */
interface Saved {
  room: RoomSnapshot;
  /** 部屋の id → アカウント id (賞金を払う先。切れた人にも払うので WebSocket とは別に残す) */
  acc: Array<[string, number]>;
  /** すぐ走るの部屋の級 */
  cls?: ClassId;
}

function sockInfo(ws: WebSocket): SockInfo {
  const a = ws.deserializeAttachment() as SockInfo | null;
  return a && typeof a.laps === "number" ? a : { laps: 2 };
}

/**
 * 部屋 1 つ。WebSocket は Hibernation API (ctx.acceptWebSocket) で受ける。
 * 50 ms の刻みはレース中だけ回す。待合・結果は alarm で終わりの時刻に起き、それまでは眠れる (時間の課金がない)。
 * 段階が変わるたびに部屋の様子 (snapshot) を storage に残し、眠ったあとに起きたら戻す
 */
export class RaceRoomDO extends DurableObject<Env> {
  private room: RaceRoom | null = null;
  private saved: Saved | null = null;
  /** 部屋の id → WebSocket (起きたら getWebSockets から作り直す) */
  private sockets = new Map<string, WebSocket>();
  /** 部屋の id → ログインしている人のアカウント id (賞金を払う先) */
  private accountOf = new Map<string, number>();
  private helloBusy = new WeakSet<WebSocket>();
  private closed = new WeakSet<WebSocket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 置いた alarm の時刻 (null = なし、undefined = わからない) */
  private alarmAt: number | null | undefined = undefined;
  private lastSaved = "";
  private lastSavedPhase = "";
  /** すぐ走るの部屋の級 (なし = 前の作りの部屋。確かめない) */
  private roomCls: ClassId | undefined;
  /** 結果が決まったときの、チームごとの 2 台の様子 (onTeamResults から。すぐあとの季節への知らせに使う) */
  private pendingTeam: TeamRaceReport | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const ws of ctx.getWebSockets()) {
      const id = sockInfo(ws).id;
      if (id) this.sockets.set(id, ws);
    }
    void ctx.blockConcurrencyWhile(async () => {
      this.saved = (await ctx.storage.get<Saved>("room")) ?? null;
      if (this.saved) {
        this.roomCls = this.saved.cls;
        this.lastSaved = JSON.stringify(this.saved);
        this.lastSavedPhase = this.saved.room.phase;
      }
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    const url = new URL(req.url);
    if (url.searchParams.has("tour")) {
      // 大会の組: 管理者の作った組の部屋があるときだけ入れる
      const room = this.ensureRoom();
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      if (!room || !room.isFixed()) {
        server.accept();
        safeSend(server, JSON.stringify({ t: "error", msg: "組の部屋はまだ開いていません (スタートの 10 分前に開きます)" } satisfies ServerMsg));
        server.close(1000, "not open");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ laps: room.laps, tour: true } satisfies SockInfo);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.searchParams.has("room")) {
      // 開いた部屋: /api/rooms で開いた部屋があって、閉じていないときだけ入れる
      const room = this.ensureRoom();
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const cfg = room?.customConfig();
      if (!room || !cfg || cfg.closed) {
        server.accept();
        safeSend(server, JSON.stringify({ t: "error", msg: "この部屋は閉じました。部屋の一覧から選び直してください" } satisfies ServerMsg));
        server.close(1000, "closed");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ laps: room.laps, custom: true } satisfies SockInfo);
      return new Response(null, { status: 101, webSocket: client });
    }
    const laps = Number(url.searchParams.get("laps")) || 2;
    const c = Number(url.searchParams.get("cls"));
    if (this.roomCls === undefined && isClassId(c)) this.roomCls = c;
    this.ensureRoom(laps);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ laps } satisfies SockInfo);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : "");
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const a = sockInfo(ws);
    const room = this.ensureRoom(a.tour || a.custom ? undefined : a.laps);
    if (!room) {
      safeSend(ws, JSON.stringify({ t: "error", msg: "部屋が閉じました" } satisfies ServerMsg));
      ws.close(1000, "closed");
      return;
    }
    if (!a.id) {
      if (msg.t === "ping") {
        safeSend(ws, JSON.stringify({ t: "pong", c: msg.c, s: Date.now() } satisfies ServerMsg));
        return;
      }
      if (msg.t !== "hello" || this.helloBusy.has(ws)) return;
      this.helloBusy.add(ws);
      try {
        await this.hello(ws, msg, a.laps, !!a.tour, !!a.custom);
      } finally {
        this.helloBusy.delete(ws);
        this.afterEvent();
      }
      return;
    }
    if (msg.t === "start") {
      // 開いた部屋: 開いた人だけが待合を早めに終えられる
      const cfg = room.customConfig();
      if (!cfg || this.accountOf.get(a.id) !== cfg.hostAccount) {
        safeSend(ws, JSON.stringify({ t: "info", text: "早めに始められるのは部屋を開いた人だけです" } satisfies ServerMsg));
        return;
      }
      const r = room.startNow(Date.now());
      if (!r.ok) safeSend(ws, JSON.stringify({ t: "info", text: r.msg } satisfies ServerMsg));
      this.afterEvent();
      return;
    }
    room.onMessage(a.id, msg, Date.now());
    this.afterEvent();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.onClose(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* もう閉じている */
    }
  }

  async webSocketError(ws: WebSocket) {
    this.onClose(ws);
  }

  /** 待合・結果の終わりの時刻 (と、レース中の見張り) */
  async alarm() {
    this.alarmAt = undefined;
    const room = this.ensureRoom();
    if (!room) return;
    // レース中は刻みが進める。alarm は見張りだけ
    if (room.phase !== "race") room.tick(Date.now());
    this.afterEvent();
  }

  private async hello(ws: WebSocket, hello: Extract<ClientMsg, { t: "hello" }>, laps: number, tour = false, custom = false) {
    // ログインしていれば、アカウントを確かめて運転手名で走る (届かなければ名無しで走る)
    let account: { id: number; driver: string } | null = null;
    // ログインした人のチーム (2 台目・整備の腕・代走の慣れ)。名無しなら なし (今までどおり)
    let team: JoinTeam | null = null;
    // 季節の級 (名無しは一番下)
    let cls: ClassId = LOWEST_CLASS;
    if (typeof hello.token === "string" && hello.token) {
      try {
        const r = await accounts(this.env).raceEntry(hello.token.slice(0, 200), hello.design);
        if (r.error) {
          safeSend(ws, JSON.stringify({ t: "error", msg: r.error } satisfies ServerMsg));
          ws.close(1000, "bad");
          return;
        }
        account = r.account;
        team = r.team ?? null;
        if (r.account && r.cls) cls = r.cls;
      } catch (e) {
        console.error("accounts", (e as Error)?.message ?? e);
      }
    }
    if (this.closed.has(ws)) return;
    const room = this.ensureRoom(tour || custom ? undefined : laps);
    const fail = (msg: string) => {
      safeSend(ws, JSON.stringify({ t: "error", msg } satisfies ServerMsg));
      ws.close(1000, "bad");
    };
    if (!room) return fail("部屋が閉じました");
    // 席の key: ログインしていればアカウント (1 つの機械に 2 つのアカウントでも別の席、別の機械の同じアカウントは同じ席でつなぎ直し)。
    // 名無しは機械の key (bpr.save.v1) のまま
    let key = account ? `acc:${account.id}` : String(hello.key).slice(0, 64);
    if (room.isFixed()) {
      // 大会の組: ログインした出場者だけ。席はアカウントで決まる
      if (!account) return fail("大会はログインして入ります");
    } else if (this.roomCls !== undefined && cls !== this.roomCls) {
      return fail(`この部屋は ${this.roomCls} 級です (あなたは ${cls} 級)。メニューからもう一度入ってください`);
    }
    const res = room.join(key, account ? account.driver : hello.name, hello.design, Date.now(), (id) => {
      const old = this.sockets.get(id);
      if (old && old !== ws) {
        // 古いほうは id を外してから閉じる (閉じたときに leave しない)
        old.serializeAttachment({ laps, ...(tour ? { tour: true } : {}), ...(custom ? { custom: true } : {}) } satisfies SockInfo);
        try {
          old.close(1000, "replaced");
        } catch {
          /* もう閉じている */
        }
      }
      ws.serializeAttachment({ laps, id, ...(tour ? { tour: true } : {}), ...(custom ? { custom: true } : {}) } satisfies SockInfo);
      this.sockets.set(id, ws);
      if (account) this.accountOf.set(id, account.id);
      else this.accountOf.delete(id);
    }, account ? team : undefined);
    if (!res.ok) {
      safeSend(ws, JSON.stringify((res.reason === "full" ? { t: "full" } : { t: "error", msg: res.msg }) satisfies ServerMsg));
      ws.close(1000, res.reason);
    }
  }

  private onClose(ws: WebSocket) {
    if (this.closed.has(ws)) return;
    this.closed.add(ws);
    const a = sockInfo(ws);
    if (a.id && this.sockets.get(a.id) === ws) {
      this.sockets.delete(a.id);
      this.ensureRoom(a.custom ? undefined : a.laps)?.leave(a.id, Date.now());
    }
    this.afterEvent();
  }

  /** 部屋を出す。眠ったあとなら storage から戻す。laps がなく、残したものもなければ null */
  private ensureRoom(laps?: number): RaceRoom | null {
    if (this.room) return this.room;
    const io = {
      send: (id: string, msg: ServerMsg) => this.sendTo(id, msg),
      broadcast: (msg: ServerMsg) => {
        const text = JSON.stringify(msg);
        for (const ws of this.sockets.values()) safeSend(ws, text);
      },
      onResults: (report: RaceReport) => this.onResults(report),
      onTeamResults: (report: TeamRaceReport) => this.recordTeam(report),
      onFixedResults: (tag: string, rows: FixedCarResult[], endedAt: number) => this.recordTournament(tag, rows, endedAt),
    };
    const saved = this.saved;
    if (saved) {
      const now = Date.now();
      const wasRace = saved.room.phase === "race";
      const room = RaceRoom.restore(io, saved.room, now);
      this.room = room;
      this.accountOf = new Map(saved.acc);
      // 眠っている間に切れた人 (WebSocket のない人) を外す
      for (const e of saved.room.entrants) if (!e.bot && e.connected && room.phase !== "idle" && !this.sockets.has(e.id)) room.leave(e.id, now);
      if (wasRace) {
        // レースの途中で追い出された (ふつうは起きない): 待合からやり直す
        io.broadcast({ t: "roster", roster: room.roster() });
        io.broadcast({ t: "phase", info: room.info() });
      }
      return room;
    }
    if (laps === undefined) return null;
    this.room = new RaceRoom(io, laps);
    return this.room;
  }

  /** 何か起きたあと: レース中なら刻みを回し、ほかは刻みを止めて alarm を置き、部屋の様子を残す */
  private afterEvent() {
    const room = this.room;
    if (!room) return;
    if (room.phase === "race") {
      if (!this.timer) this.timer = setInterval(() => this.onTick(), TICK_MS);
      if (this.alarmAt === undefined || this.alarmAt === null) this.setAlarm(Date.now() + WATCHDOG_MS);
    } else {
      this.stopTimer();
      this.setAlarm(room.phase === "lobby" || room.phase === "results" ? room.info().endsAt : null);
    }
    this.save();
    this.pushCustom();
  }

  /** 開いた部屋: 段階・人の数が変わったら一覧 (AccountsDO) に知らせる。閉じたら (idle) 一覧から消える */
  private lastCustom = "";
  private pushCustom() {
    const room = this.room;
    const cfg = room?.customConfig();
    if (!room || !cfg) return;
    // まだ誰も来ていない (開いたばかり) は知らせない
    if (room.phase === "idle" && !cfg.closed) return;
    const seats = room.seatsInfo();
    const status = { phase: room.phase, humans: seats.humans, cars: seats.cars, endsAt: room.info().endsAt };
    const key = JSON.stringify(status);
    if (key === this.lastCustom) return;
    this.lastCustom = key;
    accounts(this.env)
      .updateCustomRoom(cfg.id, status)
      .catch((e) => console.error("custom room status", (e as Error)?.message ?? e));
  }

  private onTick() {
    const room = this.room;
    if (!room) return this.stopTimer();
    room.tick(Date.now());
    if (room.phase !== "race") this.afterEvent();
  }

  private setAlarm(at: number | null) {
    if (at === this.alarmAt) return;
    this.alarmAt = at;
    if (at === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(at);
  }

  /** 部屋の様子を storage に残す (レース中は始まりの 1 回だけ。変わっていなければ書かない) */
  private save() {
    const room = this.room;
    if (!room) return;
    if (room.phase === "race" && this.lastSavedPhase === "race") return;
    const snap = room.snapshot();
    const ids = new Set(snap.entrants.map((e) => e.id));
    const data: Saved = { room: snap, acc: [...this.accountOf].filter(([id]) => ids.has(id)), ...(this.roomCls !== undefined ? { cls: this.roomCls } : {}) };
    const text = JSON.stringify(data);
    this.lastSavedPhase = room.phase;
    if (text === this.lastSaved) return;
    this.lastSaved = text;
    this.saved = data;
    void this.ctx.storage.put("room", data);
  }

  /**
   * 結果が決まったら: 季節の点・賞金 (管理者の数)・はんこをアカウントの DO に送る (recordRace。同じレースは 1 回だけ)。
   * onTeamResults (2 台目と代走の様子) は同じ刻みのすぐあとに来るので、少し待ってからまとめて送る
   */
  private onResults(report: RaceReport) {
    if (!report.rows.some((r) => this.accountOf.has(r.id))) return;
    queueMicrotask(() => this.feedSeason());
  }

  private feedSeason() {
    const room = this.room;
    if (!room) return;
    const info = room.info();
    const results = info.results ?? [];
    const team = this.pendingTeam;
    this.pendingTeam = null;
    const slot = new Map(room.roster().map((r) => [r.id, r.slot]));
    const car1 = new Map((team?.teams ?? []).map((t) => [t.id, t.car1]));
    const car2 = new Map((team?.teams ?? []).filter((t) => t.car2).map((t) => [t.car2!.id, { owner: t.id, c: t.car2! }]));
    const cars: RaceFeedCar[] = results.map((r) => {
      const acc = r.bot ? undefined : this.accountOf.get(r.id);
      const sec = car2.get(r.id);
      const owner = sec ? this.accountOf.get(sec.owner) : undefined;
      const s = slot.get(r.id);
      return {
        id: r.id,
        pos: r.pos,
        finished: r.finished,
        fastest: r.fastest,
        penalty: r.penalty,
        gridPos: s === undefined ? null : s + 1,
        pitStops: car1.get(r.id)?.pitStops ?? sec?.c.pitStops ?? 0,
        ...(acc !== undefined ? { accountId: acc, standIn: car1.get(r.id)?.standIn ?? false } : {}),
        ...(sec && owner !== undefined ? { ownerAccountId: owner, hiredDriverId: sec.c.driverId } : {}),
      };
    });
    // レース中の一番の濡れ具合 (雨のはんこ)
    let maxWet = 0;
    const raceSec = Math.max(0, (Date.now() - info.lightsOutAt) / 1000);
    if (info.weather) for (let t = 0; t <= raceSec + 5; t += 5) maxWet = Math.max(maxWet, wetnessAt(info.weather, t));
    const feed: RaceFeed = {
      raceId: `room:${this.ctx.id.toString()}:${info.lightsOutAt}`,
      at: Date.now(),
      laps: info.laps,
      trackId: info.trackId,
      humans: results.filter((r) => !r.bot).length,
      maxWet: Math.round(maxWet * 1000) / 1000,
      cars,
    };
    // みんなのコース (開いた部屋だけ): 走った回数・走り終えたか・一番速い周
    if (isPublicTrackId(info.trackId)) {
      const runs = results
        .filter((r) => !r.bot && this.accountOf.has(r.id))
        .map((r) => ({ accountId: this.accountOf.get(r.id)!, driver: r.name, finished: r.finished, ...(r.best !== null ? { bestLap: r.best } : {}) }));
      if (runs.length) accounts(this.env).recordTrackRaceRuns(info.trackId, runs).catch((e) => console.error("track runs", (e as Error)?.message ?? e));
    }
    const roomOf = new Map<number, string>();
    for (const c of cars) if (c.accountId !== undefined) roomOf.set(c.accountId, c.id);
    accounts(this.env)
      .recordRace(feed)
      .then((paid) => {
        for (const [acc, p] of Object.entries(paid)) {
          const id = roomOf.get(Number(acc));
          if (!id) continue;
          const yen = (n: number) => n.toLocaleString("ja-JP");
          // 賞金・2 台目の賞金・走行点 (racepoints.ts) を 1 つの知らせに (続けて送ると画面の札が上書きされるので)
          const parts: string[] = [];
          if (p.car1 > 0) parts.push(`賞金 +${yen(p.car1)} (財布 ${yen(p.money)})`);
          if (p.car2 > 0) parts.push(`2 台目の賞金 +${yen(p.car2)}`);
          if (p.rp && p.rp.wanted > 0) {
            const r = p.rp;
            parts.push(
              r.earned <= 0
                ? "走行点は今日の上限に届いています (0 時に戻ります)"
                : `走行点 +${yen(r.earned)}${r.earned < r.wanted ? " (今日の上限まで)" : ""} · 今日あと ${yen(r.left)} · 手元 ${yen(r.points)}`,
            );
          }
          if (parts.length) this.sendTo(id, { t: "info", text: parts.join(" ／ ") });
        }
      })
      .catch((e) => console.error("season race", (e as Error)?.message ?? e));
  }

  /** チームの 2 台目と代走の様子を覚え (季節へ)、整備・研究・運転手の育ち・慣れを残す (賞金は recordRace で払う) */
  private recordTeam(report: TeamRaceReport) {
    // 大会の組: 季節へは大会の結果で入る。来なかった人 (代走) もいるので、アカウントは席の印 "acc:<番号>" から
    const fixed = !!this.room?.isFixed();
    if (!fixed) this.pendingTeam = report;
    const accountOf: Record<string, number> = {};
    for (const t of report.teams) {
      const m = fixed ? /^acc:(\d{1,12})$/.exec(t.key) : null;
      const acc = this.accountOf.get(t.id) ?? (m ? Number(m[1]) : undefined);
      if (acc !== undefined) accountOf[t.id] = acc;
    }
    if (!Object.keys(accountOf).length) return;
    accounts(this.env)
      .recordTeamRace(crypto.randomUUID(), report, accountOf, [])
      .catch((e) => console.error("team race", (e as Error)?.message ?? e));
  }

  /** 大会の組の結果をアカウントの DO へ (全部の組がそろったら大会が決まる) */
  private recordTournament(tag: string, rows: FixedCarResult[], endedAt: number) {
    accounts(this.env)
      .recordTournamentGroup(tag, rows, endedAt)
      .catch((e) => console.error("tournament", (e as Error)?.message ?? e));
  }

  /**
   * アカウントの DO から: 大会の組の部屋を開く (待合はスタートまで)。もう開いていれば何もしない (true)。
   * 来た人は WebSocket で /ws?tour=<id>&g=<組> に入る
   */
  async setupTournament(field: FixedField): Promise<boolean> {
    const room = this.ensureRoom(field.laps)!;
    if (room.isFixed()) return true;
    room.setFixed(field, Date.now());
    this.afterEvent();
    return true;
  }

  /**
   * アカウントの DO から: 開いた部屋を作る (コース・周回・級・開いた人)。人が入ると待合が始まる。もう作ってあれば何もしない (true)。
   * 来た人は WebSocket で /ws?room=<id> に入る
   */
  async setupCustom(cfg: CustomRoomConfig): Promise<boolean> {
    const cur = this.ensureRoom();
    if (cur) return cur.customConfig()?.id === cfg.id;
    const room = this.ensureRoom(cfg.laps)!;
    room.setCustom(cfg);
    if (room.customConfig()?.id !== cfg.id) return false;
    this.roomCls = isClassId(cfg.cls) ? cfg.cls : LOWEST_CLASS;
    this.afterEvent();
    return true;
  }

  private sendTo(id: string, msg: ServerMsg) {
    const ws = this.sockets.get(id);
    if (ws) safeSend(ws, JSON.stringify(msg));
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function safeSend(ws: WebSocket, text: string) {
  try {
    ws.send(text);
  } catch {
    /* 閉じかけ */
  }
}
