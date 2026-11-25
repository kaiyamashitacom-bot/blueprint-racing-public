import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** 版の印 (オープニングの隅に出す): 組み立てたときの git の短い番号。git が無ければ "dev" */
function buildId(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

// 作るとき: npm run dev で 5273 (画面) と 8797 (サーバー) が同時に動く。/ws と /api はサーバーへ回す
export default defineConfig({
  define: { __BPR_BUILD__: JSON.stringify(buildId()) },
  server: {
    port: 5273,
    strictPort: true,
    proxy: { "/ws": { target: "ws://localhost:8797", ws: true }, "/api": { target: "http://localhost:8797" } },
  },
});
