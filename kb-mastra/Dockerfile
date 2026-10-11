# kb-mastra：WeKnora 知识库域的 TypeScript + Mastra 移植。
# Bun 基础镜像（Mastra server 自带 HTTP，bun 原生跑 TS 无需构建步骤——与 agent-mastra
# 的 `mastra build` 不同：本服务不用 mastra CLI bundle，直接 bun 起 src/index.ts，
# 因为我们的 apiRoutes/middleware 都是标准 Mastra server 配置）。
FROM oven/bun:1.3-alpine

# runner 需要 ca-certificates：postgres/qdrant/docreader 都可能走 TLS（自签或云上）。
RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY kb-mastra/package.json ./
RUN bun install --frozen-lockfile || bun install

# shared/logger 经相对路径引入（agent-mastra 同款）。
COPY shared/logger.ts /shared/logger.ts

COPY kb-mastra/src ./src
COPY kb-mastra/drizzle ./drizzle
COPY kb-mastra/proto ./proto

# 元数据文件卷（local 存储后端）
VOLUME ["/app/data"]

ENV KB_PORT=8082
EXPOSE 8082

# 启动时先跑迁移（migrate.ts 内含 pg_advisory_lock 互斥，多实例安全）再起 HTTP。
CMD ["bun", "src/index.ts"]
