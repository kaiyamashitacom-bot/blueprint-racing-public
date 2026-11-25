// 遊ぶ人の管理 (11/25 決まり「パスワードを戻す・荒らしを止める・招く人」) の受け口。中身は accounts.ts の AccountStore。
// パスワードを戻すのは api.ts の /api/admin/reset-password (前からある)。招かれた人だけ登録できるかは AdminConfig.inviteOnly (はじめは切)
import { ApiError, type AccountStore } from "./accounts.ts";

export const PLAYERS_ADMIN_PATH = /^\/api\/(admin\/(suspend|invites)|register\/info)(\/|$)/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 4096) throw new ApiError(413, "送るものが大きすぎます");
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下で断る */
  }
  throw new ApiError(400, "送られてきたものが読めません");
}

/**
 * GET    /api/register/info          { inviteOnly } (ログインなし。登録の札に招待の合言葉の欄を出すか)
 * 管理者だけ:
 * POST   /api/admin/suspend          { id, suspended: boolean, reason? }  荒らしを止める / 戻す
 * GET    /api/admin/invites          招待の合言葉の一覧
 * POST   /api/admin/invites          { count?, note? }  合言葉を作る
 * DELETE /api/admin/invites/:code    使っていない合言葉を消す
 * 招かれた人だけにするかは PUT /api/admin/config { inviteOnly: true|false }
 */
export async function handlePlayersAdminApi(req: Request, path: string, method: string, accounts: AccountStore): Promise<Response> {
  try {
    const M = method.toUpperCase();
    if (path === "/api/register/info" && M === "GET") return json(accounts.registerInfo());
    const a = await accounts.auth(bearer(req));
    if (!a) throw new ApiError(401, "ログインしてください");
    if (!accounts.isAdmin(a)) throw new ApiError(403, "管理者だけができます");
    if (path === "/api/admin/suspend" && M === "POST") {
      const b = await body(req);
      return json(accounts.adminSetSuspended(a, { id: b.id, suspended: b.suspended, reason: b.reason }));
    }
    if (path === "/api/admin/invites" && M === "GET") return json(accounts.adminListInvites(a));
    if (path === "/api/admin/invites" && M === "POST") {
      const b = await body(req);
      return json(accounts.adminCreateInvites(a, { count: b.count, note: b.note }), 201);
    }
    const im = /^\/api\/admin\/invites\/([A-Za-z0-9-]{4,20})$/.exec(path);
    if (im && M === "DELETE") return json(accounts.adminDeleteInvite(a, im[1]));
    throw new ApiError(404, "ありません");
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("players admin", (e as Error)?.message ?? e);
    return json({ error: "サーバーで問題が起きました" }, 500);
  }
}
