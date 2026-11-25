// 管理者の数 (AdminConfig) の変更の記録: いつ・誰が・どの項目を・前と後。保存・はじめに戻す・読みこみ・取り消し・版に戻す の全部を残す。
// 新しい物から ADMIN_CONFIG_LOG_KEEP 件だけ残す。版に戻すときは、その版の数を今の確かめ (applyAdminPatch) に通してから入れる (season.ts)
import { diffAdminConfig, type AdminChange, type AdminConfig } from "@bpr/shared";
import type { SqlRunner } from "./accounts.ts";

/** 残す件数 */
export const ADMIN_CONFIG_LOG_KEEP = 200;

export type AdminConfigAction = "save" | "reset" | "import" | "restore" | "undo";

export const ADMIN_CONFIG_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_config_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  admin_id INTEGER,
  admin_login TEXT,
  action TEXT NOT NULL,
  ref INTEGER,
  changes TEXT NOT NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL
)`;

/** 画面に返す 1 件 (前と後の数の全部は返さない。戻すときはサーバーが読む) */
export interface AdminConfigLogEntry {
  id: number;
  at: number;
  adminId: number | null;
  admin: string | null;
  action: AdminConfigAction;
  /** 戻した元の記録の id (restore・undo のとき) */
  ref: number | null;
  changes: AdminChange[];
}

export interface AdminBy {
  id: number;
  login: string;
}

export class AdminConfigLog {
  constructor(private sql: SqlRunner) {
    this.sql.exec(ADMIN_CONFIG_LOG_SCHEMA);
  }

  /** 1 件残す (違いが無ければ残さない)。残した id か null */
  add(at: number, by: AdminBy | null, action: AdminConfigAction, before: Readonly<AdminConfig>, after: Readonly<AdminConfig>, ref: number | null = null): number | null {
    const changes = diffAdminConfig(before, after);
    if (!changes.length) return null;
    this.sql.exec(
      "INSERT INTO admin_config_log (at, admin_id, admin_login, action, ref, changes, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      at,
      by?.id ?? null,
      by?.login ?? null,
      action,
      ref,
      JSON.stringify(changes),
      JSON.stringify(before),
      JSON.stringify(after),
    );
    const id = Number(this.sql.exec("SELECT MAX(id) AS id FROM admin_config_log").toArray()[0]?.id ?? 0);
    this.sql.exec("DELETE FROM admin_config_log WHERE id <= ?", id - ADMIN_CONFIG_LOG_KEEP);
    return id;
  }

  /** 新しい物から */
  list(limit = ADMIN_CONFIG_LOG_KEEP): AdminConfigLogEntry[] {
    const n = Math.max(1, Math.min(ADMIN_CONFIG_LOG_KEEP, Math.floor(limit)));
    return this.sql
      .exec("SELECT id, at, admin_id, admin_login, action, ref, changes FROM admin_config_log ORDER BY id DESC LIMIT ?", n)
      .toArray()
      .map((r) => ({
        id: Number(r.id),
        at: Number(r.at),
        adminId: r.admin_id === null ? null : Number(r.admin_id),
        admin: r.admin_login === null ? null : String(r.admin_login),
        action: String(r.action) as AdminConfigAction,
        ref: r.ref === null ? null : Number(r.ref),
        changes: JSON.parse(String(r.changes)) as AdminChange[],
      }));
  }

  /** その記録の前と後の数 (保存したままの形。確かめる前) */
  versions(id: number): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
    const r = this.sql.exec("SELECT before, after FROM admin_config_log WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    return { before: JSON.parse(String(r.before)), after: JSON.parse(String(r.after)) };
  }

  /** 一番新しい記録の id */
  latestId(): number | null {
    const r = this.sql.exec("SELECT MAX(id) AS id FROM admin_config_log").toArray()[0];
    return r && r.id !== null && r.id !== undefined ? Number(r.id) : null;
  }
}
