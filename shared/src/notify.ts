// 知らせ (通知): 大会の前・研究が終わった・市場で売れた・競りで抜かれた。
// server が持つ「もと」(大会の予定・研究・売れた記録・抜かれた記録) と、送った知らせの id を渡すと、今送る知らせを返す。
// 知らせの id は決まった形なので、同じ知らせを 2 回送らない (sent に入れておく)。時刻は ms。
export type NoticeKind = "tournament_soon" | "research_done" | "market_sold" | "outbid";

/** 大会の何 ms 前に知らせるか (仮: 1 日前と 1 時間前) */
export const TOURNAMENT_NOTICE_LEADS_MS: readonly number[] = [24 * 3_600_000, 3_600_000];
/** 期限を過ぎてもこれより古い知らせは送らない (仮。server が長く止まっていたとき用) */
export const NOTICE_STALE_MS = 24 * 3_600_000;
/** 画面用の見出し (言葉の表、仮) */
export const NOTICE_TITLES: Readonly<Record<NoticeKind, string>> = {
  tournament_soon: "大会がもうすぐ",
  research_done: "研究が終わった",
  market_sold: "市場で売れた",
  outbid: "競りで抜かれた",
};

export interface Notice {
  id: string;
  kind: NoticeKind;
  /** 宛先のチーム。"all" = 全員 */
  to: string | "all";
  /** 送ってよくなる時刻 */
  at: number;
  /** 画面で文にするための材料 */
  data: Record<string, string | number>;
}

export interface NoticeSources {
  /** leads = 知らせる時刻 (スタートの何 ms 前。なし = TOURNAMENT_NOTICE_LEADS_MS。毎日の大会は 1 時間前だけ) */
  tournaments?: readonly { id: string; name: string; startsAt: number; leads?: readonly number[] }[];
  research?: readonly { jobId: string; teamId: string; partName: string; /** 今の見込みの終わる時刻 */ doneAt: number }[];
  sales?: readonly { listingId: string; sellerTeamId: string; itemName: string; price: number; soldAt: number }[];
  outbids?: readonly { auctionId: string; bidId: string; /** 抜かれたチーム */ teamId: string; itemName: string; newPrice: number; at: number }[];
}

/** もとから作れる知らせを全部 (時刻の順、同じなら id 順) */
export function allNotices(src: NoticeSources): Notice[] {
  const out: Notice[] = [];
  for (const t of src.tournaments ?? []) {
    for (const lead of t.leads ?? TOURNAMENT_NOTICE_LEADS_MS) {
      out.push({ id: `tour:${t.id}:${lead}`, kind: "tournament_soon", to: "all", at: t.startsAt - lead, data: { tournamentId: t.id, name: t.name, startsAt: t.startsAt } });
    }
  }
  for (const r of src.research ?? []) {
    out.push({ id: `research:${r.jobId}`, kind: "research_done", to: r.teamId, at: r.doneAt, data: { jobId: r.jobId, partName: r.partName } });
  }
  for (const s of src.sales ?? []) {
    out.push({ id: `sold:${s.listingId}`, kind: "market_sold", to: s.sellerTeamId, at: s.soldAt, data: { listingId: s.listingId, itemName: s.itemName, price: s.price } });
  }
  for (const o of src.outbids ?? []) {
    out.push({ id: `outbid:${o.auctionId}:${o.bidId}:${o.teamId}`, kind: "outbid", to: o.teamId, at: o.at, data: { auctionId: o.auctionId, itemName: o.itemName, newPrice: o.newPrice } });
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isLive(n: Notice, now: number): boolean {
  if (n.kind === "tournament_soon") {
    // 大会が始まったあとの「もうすぐ」は送らない
    return now < Number(n.data.startsAt);
  }
  return true;
}

/** 今 (now) 送る知らせ: 時刻が来ていて、まだ送っていなくて、古すぎないもの */
export function dueNotices(src: NoticeSources, now: number, sent: ReadonlySet<string> | readonly string[] = []): Notice[] {
  const done = sent instanceof Set ? sent : new Set(sent as readonly string[]);
  return allNotices(src).filter((n) => n.at <= now && now - n.at <= NOTICE_STALE_MS && !done.has(n.id) && isLive(n, now));
}

/** 次に知らせが来る時刻 (server の目覚まし用)。無ければ null */
export function nextNoticeAt(src: NoticeSources, now: number, sent: ReadonlySet<string> | readonly string[] = []): number | null {
  const done = sent instanceof Set ? sent : new Set(sent as readonly string[]);
  let best: number | null = null;
  for (const n of allNotices(src)) {
    if (n.at > now && !done.has(n.id) && (best === null || n.at < best)) best = n.at;
  }
  return best;
}

/** このチームあての知らせだけ ("all" も含む) */
export function noticesFor(list: readonly Notice[], teamId: string): Notice[] {
  return list.filter((n) => n.to === "all" || n.to === teamId);
}
