// 限界突破の品 (shared/src/items.ts) を持ち物 (accounts の inventory 表) に入れる。景品 (季節・リーグ戦・大会・1 周アタック) から呼ぶ。
// 呼ぶ側の取りまとめ (transaction) の中で呼ぶ。同じ景品を 2 回入れないのは呼ぶ側 (締めの印) の受け持ち。
// 知らせ (notices 表、team.ts) も 1 つ出す (同じ id は 1 回だけ)。
import { addItem, describeItems, isItemId, type Inventory, type ItemId } from "@bpr/shared";
import type { SqlRunner } from "./accounts.ts";

function inventoryOf(sql: SqlRunner, accountId: number): Inventory {
  const out: Inventory = {};
  for (const r of sql.exec("SELECT part_id, n FROM inventory WHERE account_id = ? AND n > 0", accountId).toArray()) out[String(r.part_id)] = Number(r.n);
  return out;
}

/**
 * 品を入れる (アカウントがなければ何もしない)。持てる数を超える分は入れない。
 * notice = 知らせ (id は景品ごとに決まった文字。同じ id は 1 回だけ)。入れた品を返す
 */
export function grantItems(
  sql: SqlRunner,
  accountId: number,
  items: Partial<Record<ItemId, number>>,
  notice: { id: string; title: string; why: string; at: number } | null,
): Partial<Record<ItemId, number>> {
  if (!sql.exec("SELECT id FROM accounts WHERE id = ?", accountId).toArray().length) return {};
  let inv = inventoryOf(sql, accountId);
  const got: Partial<Record<ItemId, number>> = {};
  for (const [id, n] of Object.entries(items)) {
    if (!isItemId(id) || !(Number(n) >= 1)) continue;
    const r = addItem(inv, id, Math.floor(Number(n)));
    if (!r.ok) continue;
    inv = r.inventory;
    got[id] = Math.floor(Number(n));
    sql.exec("INSERT INTO inventory (account_id, part_id, n) VALUES (?, ?, ?) ON CONFLICT(account_id, part_id) DO UPDATE SET n = excluded.n", accountId, id, inv[id]);
  }
  if (notice && Object.keys(got).length) {
    try {
      sql.exec(
        "INSERT OR IGNORE INTO notices (account_id, id, kind, title, text, at, read) VALUES (?, ?, 'item_prize', ?, ?, ?, 0)",
        accountId,
        notice.id,
        notice.title,
        `${notice.why}: ${describeItems(got)} を受け取りました (持ち物の「限界突破の品」)`,
        notice.at,
      );
    } catch {
      /* 知らせの表がない (試験で チームの係を作っていないとき) */
    }
  }
  return got;
}
