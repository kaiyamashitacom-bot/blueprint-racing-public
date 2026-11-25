// /api/... の受け口。中身は AccountStore。Cloudflare に頼らないので試験でそのまま動かせる
// ログインの合い言葉は Authorization: Bearer <token> で送る
import { partDef, shopList, type AccountMe, type Inventory } from "@bpr/shared";
import { ApiError, AccountStore, type Account } from "./accounts.ts";
import { handleTa, type TaStore } from "./timeattack.ts";
import { handleTeamApi, TEAM_PATH, type TeamStore } from "./team.ts";
import { handleSeasonApi, SEASON_PATH, type SeasonApiOpts, type SeasonStore } from "./season.ts";
import { handleTracksApi, TRACKS_PATH, type TrackStore } from "./tracks.ts";

/** 受け取る本文の大きさの上限 */
const MAX_BODY = 64 * 1024;

export interface ShopItem {
  id: string;
  price: number;
}

/** 返す形 (画面の api.ts と合わせる) */
export interface InventoryRes {
  money: number;
  parts: Inventory;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "送るものが大きすぎます");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下で断る */
  }
  throw new ApiError(400, "送られてきたものが読めません");
}

function clientIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") ?? "local").slice(0, 64);
}

export async function handleApi(
  req: Request,
  store: AccountStore,
  ta?: TaStore,
  team?: TeamStore,
  season?: SeasonStore,
  seasonOpts?: SeasonApiOpts,
  tracks?: TrackStore,
  /** 開いた部屋の一覧 (rooms.ts の RoomRegistry)。退会した人の部屋をすぐ消す */
  rooms?: { forgetAccount(accountId: number): void },
): Promise<Response> {
  try {
    return await route(req, store, ta, team, season, seasonOpts, tracks, rooms);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("api error", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}

async function route(
  req: Request,
  store: AccountStore,
  ta?: TaStore,
  team?: TeamStore,
  season?: SeasonStore,
  seasonOpts?: SeasonApiOpts,
  tracks?: TrackStore,
  rooms?: { forgetAccount(accountId: number): void },
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  // 合い言葉は cookie でなく Authorization で送るので、ほかのサイトから勝手に使われない (CORS も開けない)
  const m = req.method.toUpperCase();

  // 季節があれば級も付ける (すぐ走るの部屋を級で選ぶため)
  const me = (a: Account): AccountMe => (season ? { ...store.me(a), cls: season.classOf(a.id) } : store.me(a));
  const needAuth = async (): Promise<Account> => {
    const a = await store.auth(bearer(req));
    if (!a) throw new ApiError(401, "ログインしてください");
    return a;
  };

  // 1 周アタック (timeattack.ts。順位表と幽霊はログインなしでも見られる)
  if (ta && path.startsWith("/api/ta/")) return handleTa(req, path, m, store, ta);
  // チーム・運転手・研究・市場・知らせ (team.ts。ログインが要る)
  if (team && TEAM_PATH.test(path)) return handleTeamApi(req, path, m, store, team);
  // 季節・大会・管理者の画面 (season.ts)
  if (season && SEASON_PATH.test(path)) return handleSeasonApi(req, path, m, store, season, seasonOpts);
  // みんなのコース (tracks.ts。一覧と形はログインなしでも見られる)
  if (tracks && TRACKS_PATH.test(path)) return handleTracksApi(req, path, m, store, tracks);

  // ログインなしで使えるもの
  if (path === "/api/shop" && m === "GET") {
    const items: ShopItem[] = shopList();
    return json({ items });
  }
  if (path === "/api/register" && m === "POST") {
    const b = await body(req);
    const r = await store.register({ id: b.id, password: b.password, team: b.team, driver: b.driver, invite: b.invite }, clientIp(req));
    return json({ token: r.token, me: me(r.account) }, 201);
  }
  if (path === "/api/login" && m === "POST") {
    const b = await body(req);
    const r = await store.login({ id: b.id, password: b.password }, clientIp(req));
    return json({ token: r.token, me: me(r.account) });
  }

  // ここから先はログインが要る
  if (path === "/api/logout" && m === "POST") {
    const t = bearer(req);
    if (t) await store.logout(t);
    return json({ ok: true });
  }
  if (path === "/api/me" && m === "GET") {
    return json({ me: me(await needAuth()) });
  }
  if (path === "/api/me/names" && m === "PUT") {
    const a = await needAuth();
    const b = await body(req);
    return json({ me: me(store.setNames(a, { team: b.team, driver: b.driver })) });
  }
  if (path === "/api/me" && m === "DELETE") {
    const a = await needAuth();
    const b = await body(req);
    await store.deleteAccount(a, b.password);
    ta?.forgetAccount(a.id);
    team?.forgetAccount(a.id);
    season?.forgetAccount(a.id);
    tracks?.forgetAccount(a.id);
    // 開いた部屋はすぐ一覧から消す (前は誰も来ないまま 3 分残っていた)。部屋の中のレースはそのまま
    rooms?.forgetAccount(a.id);
    return json({ ok: true });
  }
  if (path === "/api/inventory" && m === "GET") {
    const a = await needAuth();
    const res: InventoryRes = { money: a.money, parts: store.inventory(a.id) };
    return json(res);
  }
  if (path === "/api/shop/buy" && m === "POST") {
    const a = await needAuth();
    const b = await body(req);
    if (typeof b.part !== "string" || !partDef(b.part)) throw new ApiError(400, "その部品はありません");
    const res: InventoryRes = store.buy(a, b.part, b.qty ?? 1);
    return json(res);
  }
  if (path === "/api/designs" && m === "GET") {
    const a = await needAuth();
    return json({ designs: store.listDesigns(a.id) });
  }
  if (path === "/api/designs" && m === "POST") {
    const a = await needAuth();
    const b = await body(req);
    return json({ saved: store.saveDesign(a, b.design) }, 201);
  }
  const dm = /^\/api\/designs\/(\d{1,12})$/.exec(path);
  if (dm && (m === "PUT" || m === "DELETE")) {
    const a = await needAuth();
    const id = Number(dm[1]);
    if (m === "DELETE") {
      store.deleteDesign(a, id);
      return json({ ok: true });
    }
    const b = await body(req);
    return json({ saved: store.saveDesign(a, b.design, id) });
  }
  if (path === "/api/admin/reset-password" && m === "POST") {
    const a = await needAuth();
    const b = await body(req);
    return json(await store.adminResetPassword(a, { id: b.id, password: b.password }));
  }
  throw new ApiError(404, "ありません");
}

