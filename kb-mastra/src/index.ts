/**
 * kb-mastra HTTP 入口：启动自检（迁移 + ensureCollection）→ Bun.serve 挂 Hono app。
 *
 * vectors/storage 均不配（元数据走自建 Drizzle、向量走 Qdrant REST，设计 §3
 * 界定）——Mastra 实例留待 T04+ 的 agent 面再引入，本期十条知识库路由在
 * src/router/app.ts 的 Hono 上自管。
 */

import { getLogger } from "../../shared/logger";
import { loadConfig } from "./config";
import { QdrantClient } from "./infrastructure/qdrant/client";
import { ensureCollection } from "./infrastructure/qdrant/collections";
import { createApp } from "./router/app";

const log = getLogger("kb-mastra");

const config = loadConfig();

/**
 * 启动自检：迁移（pg_advisory_lock 互斥）→ ensureCollection（存在性/维度/
 * distance 校验 + payload 索引幂等声明）。幂等：重复启动安全；失败 fail fast。
 */
async function startupChecks(): Promise<void> {
  const { runMigrations } = await import("./db/migrate");
  await runMigrations();

  const qdrant = new QdrantClient({
    baseUrl: config.qdrantUrl,
    ...(config.qdrantApiKey !== "" ? { apiKey: config.qdrantApiKey } : {}),
  });
  await ensureCollection(qdrant, config.embedDimensions);
}

await startupChecks()
  .then(() => {
    log.info(
      { type: "kb-mastra-starting", port: config.port },
      "kb-mastra-starting",
    );
  })
  .catch((error: unknown) => {
    // 不落抛出值本体；自检错误文案是我们自己写的，无敏感串。
    log.error(
      {
        type: "kb-mastra-startup-failed",
        error: (error as Error).name,
        message: (error as Error).message,
      },
      "kb-mastra-startup-failed",
    );
    process.exit(1);
  });

const app = createApp();

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
});

log.info({ type: "kb-mastra-started", port: server.port }, "kb-mastra-started");

// 优雅退出（compose stop → SIGTERM）。
process.on("SIGTERM", () => {
  log.info({ type: "kb-mastra-stopping" }, "kb-mastra-stopping");
  server.stop(true);
  process.exit(0);
});
process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
