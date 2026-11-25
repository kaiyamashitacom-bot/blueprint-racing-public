// パスワードの印 (PBKDF2-SHA256、1 人ずつ別の塩) と、ログインの合い言葉 (ランダム)。WebCrypto だけ使う
// 平文のパスワードは保存しない・書き出さない

/** Workers の WebCrypto の PBKDF2 は 100,000 回までなので、その上限にする */
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function derive(pw: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

/** 保存する形: pbkdf2-sha256$回数$塩$印 */
export async function hashPassword(pw: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pw, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const want = unb64(parts[3]);
  const got = await derive(pw, unb64(parts[2]), iterations);
  return sameBytes(got, want);
}

/** 長さが同じなら、どこで違っても同じ時間でくらべる */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** ログインの合い言葉 (32 バイトのランダム) */
export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 合い言葉はそのまま保存せず、SHA-256 の印で持つ */
export async function tokenHash(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token)));
  return b64url(d);
}

/** 管理者が戻すときの仮のパスワード (12 文字。まぎらわしい字は使わない) */
export function randomPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const a = crypto.getRandomValues(new Uint8Array(12));
  return [...a].map((b) => chars[b % chars.length]).join("");
}
