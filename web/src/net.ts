// サーバーとのつながり。時計を合わせ、満員なら次の部屋へ
import type { ClientMsg, ServerMsg } from "@bpr/shared";

const wallNow = () => performance.timeOrigin + performance.now();

export class Net {
  private ws: WebSocket | null = null;
  private offset = 0;
  private bestRtt = Infinity;
  private pingTimer = 0;
  private closedByMe = false;
  private n = 0;

  constructor(
    private laps: number,
    private hello: () => ClientMsg,
    private onMsg: (m: ServerMsg) => void,
    /** 切れたとき。error = 切れる前にサーバーが送ってきたまちがいの知らせ、reason = 閉じた理由 ("replaced" = 別の画面が同じ席に入った) */
    private onDrop: (why: { reason: string; error?: string }) => void,
    /** つなぐ先に足す (すぐ走るの級 "&cls=3"、大会の組 "&tour=<id>&g=0") */
    private extra = "",
  ) {}

  connect() {
    this.closedByMe = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?laps=${this.laps}&n=${this.n}${this.extra}`);
    this.ws = ws;
    /** このつながりでサーバーが送ってきたまちがい (閉じたときに知らせる) */
    let error: string | undefined;
    ws.addEventListener("open", () => {
      this.send(this.hello());
      for (let i = 0; i < 4; i++) setTimeout(() => this.ping(), i * 300);
      this.pingTimer = window.setInterval(() => this.ping(), 4000);
    });
    ws.addEventListener("message", (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === "pong") {
        const now = wallNow();
        const rtt = now - m.c;
        if (rtt < this.bestRtt * 1.5 || rtt < 120) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.offset = m.s + rtt / 2 - now;
        }
        return;
      }
      if (m.t === "welcome" && this.bestRtt === Infinity) this.offset = m.now - wallNow();
      if (m.t === "error") error = m.msg;
      if (m.t === "full") {
        this.n++;
        this.closedByMe = true;
        ws.close();
        if (this.n < 10) setTimeout(() => this.connect(), 100);
        return;
      }
      this.onMsg(m);
    });
    ws.addEventListener("close", (ev) => {
      clearInterval(this.pingTimer);
      // 古いつながりが閉じた (つなぎ直したあと) なら知らせない
      if (!this.closedByMe && this.ws === ws) this.onDrop({ reason: ev.reason, ...(error !== undefined ? { error } : {}) });
    });
  }

  private ping() {
    this.send({ t: "ping", c: wallNow() });
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** サーバーの時計 (ms) */
  serverNow(): number {
    return wallNow() + this.offset;
  }

  close() {
    this.closedByMe = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
