# kb-mastra → server 迁移与 docker-compose 拆分

> 2026-10-11 执行。kb-mastra 独立包迁入 server 工作区；单一 docker-compose.yml 按服务组拆分为 5 个文件。
>
> 2026-10-14 更新：四个拆分文件已从仓库根移动到 `docker/compose/`（kb.yml / services.yml / lago.yml / observability.yml），启动命令统一带 `--project-directory .`。本文中的命令为当时记录，当前命令与索引以 [compose.md](compose.md) 为准。

## 一、迁移后形态

**kb 服务本体**：`server/src/kb/`（HTTP `bun run kb:dev` :8082 + 摄取 worker `bun run kb:worker`，宿主进程，与 API server 同形）。OpenBot 侧 `KB_SERVICE_URL=http://localhost:8082` 不变，契约零破坏。

```
server/
├── src/kb/                  # 原 kb-mastra/src 全量（application/config/db/docreader/
│   │                        #   handler/infrastructure/middleware/models/reranking/
│   │                        #   router/tasks + index.ts + worker.ts + README.md）
├── scripts/kb/              # 4 个冒烟脚本（grpc/t03/t05/contract-diff）
├── proto/docreader.proto    # gRPC 契约（docreader/client.ts 引用）
├── drizzle-kb/              # kb 专属迁移（0000_steep_brood + meta/）
└── drizzle-kb.config.ts     # 生成/迁移配置（连 KB_DATABASE_URL，区别于主库 drizzle/）
```

## 二、改动文件清单

### 新增
| 文件 | 说明 |
|---|---|
| `server/src/kb/**`（68 文件） | 原 kb-mastra/src；修正 12 处 `shared/logger` 相对路径（+1 级）、proto 路径、logger 名 `kb-mastra`→`kb`、迁移目录 `./drizzle`→`./drizzle-kb` |
| `server/scripts/kb/{grpc-smoke,t03-smoke,t05-smoke,contract-diff}.ts` | 冒烟脚本；import 路径与用法注释同步更新 |
| `server/proto/docreader.proto` | 原 kb-mastra/proto/ |
| `server/drizzle-kb/{0000_steep_brood.sql,meta/*}` | 原 kb-mastra/drizzle/（journal 原样保留，已迁移过的库无感） |
| `server/drizzle-kb.config.ts` | kb:db:generate 的 drizzle-kit 配置 |
| `docker-compose.kb.yml` | 知识库依赖：qdrant(6333)、kb-redis(宿主 6380)、docreader(50051) |
| `docker-compose.lago.yml` | lago-redis/lago-pdf/lago-migrate/lago-api/lago-front/lago-worker/lago-clock |
| `docker-compose.observability.yml` | loki/tempo/prometheus/alloy/grafana + glitchtip(+自有 pg/redis) |
| `docker-compose.services.yml` | casdoor + open-connector |
| `docs/kb-migration-2026-10-11.md` | 本文档 |

### 修改
| 文件 | 说明 |
|---|---|
| `server/package.json` | +依赖 `@grpc/grpc-js` `@grpc/proto-loader` `bullmq` `p-limit`、+`trustedDependencies:[protobufjs]`、+11 个 `kb:*` scripts |
| `docker-compose.yml` | 移除 kb-mastra/qdrant/docreader/casdoor/lago*/observability*/glitchtip*/open-connector 及其卷声明；保留 postgres（含 40-kb-mastra.sql 初始化挂载）、migrate、agent-*、openbot-redis、supervisor、spire*、go-runtime |
| `.env.example` | 新增「kb 服务本体变量」完整段落；qdrant 段落指向 docker-compose.kb.yml |
| `.env` | 同上（本地实际值：768 维 nomic-embed-text、kb-redis 6380 等） |
| `.gitignore` | +`server/data/`（kb 本地存储后端） |
| `bun.lock` | 依赖合并 |

### 删除
`kb-mastra/` 整目录（git rm；`.env` 已备份至 `/tmp/kb-mastra-env-backup-20261011.env`）。其 Dockerfile/bun.lock/tsconfig/biome.jsonc 随宿主进程化一并废弃。

### 未动（特意）
- `server/src/knowledge/*`——OpenBot 消费侧（client/middleware/tools），只认 `KB_SERVICE_URL`，与 kb 服务本体分属两层
- `docker/kb-mastra/init-db.sql`——kb_mastra 库仍在主栈 postgres 上初始化
- `tests/e2e/knowledge.e2e.ts`——E2E 仍打 localhost:8082，行为不变

## 三、compose 拆分要点

1. **同一 project**：5 个文件都声明 `name: openbot`，共享 `openbot_data` 网络与 `openbot_*` 数据卷——**已有卷（qdrant-data 等）原样继承，无需数据迁移**。已验证 `docker compose config` 解析出 `openbot_qdrant-data`/`openbot_lago-*` 等同名资源。
2. **跨文件依赖**：Compose 不解析跨文件 `depends_on`。lago/casdoor/open-connector 对 postgres 的依赖改为「主栈先起 + restart: unless-stopped 兜底」；文件头注释已写明。
3. **端口/连接不变**：casdoor 8000、open-connector 3100、lago 48889/48890、grafana 3003、loki 3102、tempo 3200/4318/4317、prometheus 9090、qdrant 6333、docreader 50051（此前容器内未发布，现为宿主进程改为 loopback 发布）。
4. **kb-redis 用 6380**：与主栈 openbot-redis（6379，纯内存）分离——BullMQ 队列需持久化语义，生命周期独立。`KB_REDIS_URL=redis://localhost:6380`。
5. **容器内互访**：data 网络内仍按服务名（`postgres:5432`/`qdrant:6333`/`docreader:50051`/`kb-redis:6379`）。

## 四、启动顺序

```bash
# 1. 主栈（postgres 是其余文件的前置）
docker compose up -d                # postgres/migrate/openbot-redis/agent-*/supervisor…

# 2. 按需启动拆分组
docker compose -f docker-compose.kb.yml up -d            # 知识库依赖
docker compose -f docker-compose.services.yml up -d      # casdoor + open-connector
docker compose -f docker-compose.lago.yml up -d          # 计费（lago-migrate 先行，文件内已编排）
docker compose -f docker-compose.observability.yml up -d # 监控/日志

# 3. kb 服务本体（宿主，server 工作区）
cd server
bun run kb:db:migrate   # 首次：kb_mastra 库建表（幂等，advisory lock）
bun run kb:dev          # HTTP :8082
bun run kb:worker       # 另一终端：摄取 worker

# 4. OpenBot 主进程
bash scripts/start.sh   # 或各进程分别 dev
```

## 五、验证方式

```bash
# 静态
cd server && bunx tsc --noEmit                    # kb 零错误（craft 的错误是并行 WIP，与本次无关）
bun test src/kb/                                   # 310 pass / 21 skip(live) / 0 fail
for f in ../docker-compose*.yml; do docker compose -f $f config --quiet && echo OK; done

# 服务面（栈起好后）
curl -fsS http://localhost:8082/health             # kb HTTP
curl -fsS http://localhost:6333/healthz            # qdrant
redis-cli -p 6380 ping                             # kb-redis
cd server && bun run kb:grpc-smoke                 # docreader gRPC 三级结论
bun run kb:t03-smoke                               # 摄取数据面（mock embedding）
bun run kb:t05-smoke                               # 十路由全序列（含越权/PDF 全链）
docker compose -f docker-compose.kb.yml ps         # 三容器 healthy
```

## 六、已知边界与回退

- **回退 kb**：`KB_SERVICE_URL` 指回 `http://localhost:8081`（Go kb-service 契约对照位）。
- **server/tests 回归**：`bun test server/tests/` 有 23 个失败，已用 git stash 对照验证为**迁移前既有**（用户并行 craft WIP：0058 快照不一致、compatibility-report、voice/craft 超时类），与本次迁移无关；kb 迁移零新增失败。
- **docreader 首次宿主发布 50051**：此前仅容器内互访；若宿主已有 50051 占用，设 `DOCREADER_PORT` 覆盖。
- **BM25 降级纯向量**等 P1 边界不变，见 `server/src/kb/README.md`。
