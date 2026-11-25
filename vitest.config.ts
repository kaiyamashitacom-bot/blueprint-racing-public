import { defineConfig } from "vitest/config";
// 重い試験 (リーグ戦の 8 台のレースなど) は 1 つで 3〜4 秒かかるので、待ちを 20 秒に (5 秒だとまれに落ちる)
export default defineConfig({ test: { include: ["shared/test/**/*.test.ts", "server/test/**/*.test.ts", "web/src/**/*.test.ts"], testTimeout: 20000 } });
