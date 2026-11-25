// ログインの ID・パスワード・表示名 (チーム名・運転手名) の確かめ。画面とサーバーの両方で使う
// ID は本人だけが見る。ほかの人に見えるのは表示名だけ

export const LOGIN_ID_MIN = 3;
export const LOGIN_ID_MAX = 20;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const TEAM_NAME_MAX = 16;
/** 運転手名は部屋の名前の長さ (12 字) に合わせる */
export const DRIVER_NAME_MAX = 12;

/** 表示名に使えない言葉 (管理者や運営、コンピューターの車のふりを防ぐ)。くらべるときは NFKC + 小文字 + 空白なし */
const RESERVED = ["管理者", "管理人", "運営", "公式", "admin", "moderator", "official", "cpu"];

/** ID をそろえる (前後の空白を取り、小文字に) */
export function normalizeLoginId(id: unknown): string {
  return String(id ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

/** ID のまちがい (null = よい)。英小文字・数字・_ と - だけ、3〜20 字、英数字で始まる */
export function checkLoginId(raw: unknown): string | null {
  const id = normalizeLoginId(raw);
  if (id.length < LOGIN_ID_MIN) return `ID は ${LOGIN_ID_MIN} 字以上にしてください`;
  if (id.length > LOGIN_ID_MAX) return `ID は ${LOGIN_ID_MAX} 字までです`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return "ID は英字・数字・_ と - だけ (英字か数字で始める)";
  if (isReserved(id)) return "その ID は使えません";
  return null;
}

/** パスワードのまちがい (null = よい) */
export function checkPassword(pw: unknown): string | null {
  if (typeof pw !== "string") return "パスワードを入れてください";
  if ([...pw].length < PASSWORD_MIN) return `パスワードは ${PASSWORD_MIN} 文字以上にしてください`;
  if (pw.length > PASSWORD_MAX) return `パスワードは ${PASSWORD_MAX} 文字までです`;
  if (/[\u0000-\u001f\u007f]/.test(pw)) return "パスワードに使えない文字があります";
  return null;
}

/** 見えない文字 (制御文字・幅のない文字・向きを変える文字) */
const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]", "g");

/** 表示名をそろえる (NFKC・空白をまとめる・見えない文字を取る) */
export function cleanDisplayName(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 同じ名前かをくらべるための形 (大文字小文字と空白を無視) */
export function nameKey(name: string): string {
  return cleanDisplayName(name).toLowerCase().replace(/\s/g, "");
}

function isReserved(name: string): boolean {
  const k = nameKey(name);
  return RESERVED.some((w) => k.includes(w));
}

function checkDisplayName(raw: unknown, what: string, max: number): string | null {
  const s = cleanDisplayName(raw);
  if (!s) return `${what}を入れてください`;
  if ([...s].length > max) return `${what}は ${max} 字までです`;
  if (/[<>]/.test(s)) return `${what}に < > は使えません`;
  if (isReserved(s)) return `${what}に「管理者」「運営」「CPU」などは使えません`;
  return null;
}

export function checkTeamName(raw: unknown): string | null {
  return checkDisplayName(raw, "チーム名", TEAM_NAME_MAX);
}

export function checkDriverName(raw: unknown): string | null {
  return checkDisplayName(raw, "運転手名", DRIVER_NAME_MAX);
}

/** 自分の情報 (サーバーが返す形) */
export interface AccountMe {
  /** ログインの ID (本人だけに見せる) */
  id: string;
  team: string;
  driver: string;
  money: number;
  /** 表示名を今変えられるか (季節の切れ目に true になる予定。今は登録のときだけ) */
  namesFree: boolean;
  admin: boolean;
  createdAt: number;
  /** 季節の級 (1〜5)。null = 最初の季節 (級なし、一番下の級で走る)。なし = サーバーが知らせていない */
  cls?: 1 | 2 | 3 | 4 | 5 | null;
}
