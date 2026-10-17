# Opik（可选自托管）

Opik 提供 AI 运行追踪与评测。它是**可选**的：不配置 `OPIK_*` 时 OpenBot 的 Agent 执行与既有
OpenTelemetry/Tempo/Grafana 追踪行为完全不变。

## 版本

版本事实源是 [`docker/opik/versions.json`](../docker/opik/versions.json)：每个镜像的 tag 与
digest、Opik SDK 精确版本、对应上游 commit 与验证时间。该文件里不允许出现 `latest` 或任何浮动
tag。`compatibility.status` 只有 #10（契约冒烟）拿到真实 ingest / query / evaluation / id 映射 /
删除证据后才能是 `verified`；在那之前它是 `unverified`，任何页面都不得声称已验证兼容。

上游：<https://github.com/comet-ml/opik>（本栈裁剪自 `deployment/docker-compose/docker-compose.yaml`）。

## 启动

```bash
# 1. 在仓库根 .env 里设置六个 datastore 凭据（compose 用 `:?` 强制要求，缺一个就拒绝启动）：
#    OPIK_MYSQL_PASSWORD / OPIK_MYSQL_ROOT_PASSWORD / OPIK_CLICKHOUSE_PASSWORD
#    OPIK_REDIS_PASSWORD / OPIK_MINIO_ROOT_USER / OPIK_MINIO_ROOT_PASSWORD
#    （MinIO root 密码至少 8 个字符；不要提交真实值）
# 2. 从仓库根启动
docker compose --project-directory . -f docker/compose/opik.yml up -d
```

`--project-directory .` 是必需的：它让根 `.env` 与 `./docker/opik/...` 路径按预期解析。

## 端口

| 用途 | 宿主端口 | 容器端口 | 变量 |
| --- | --- | --- | --- |
| 前端与 API 反代 | 5174 | 5173 | `OPIK_PORT` |
| OTLP HTTP | **5418** | 4318 | `OPIK_OTLP_HTTP_PORT` |
| OTLP gRPC | **5417** | 4317 | `OPIK_OTLP_GRPC_PORT` |

OTLP 宿主端口不是上游默认的 4318/4317：`docker/compose/observability.yml` 里的 Tempo 已经在
loopback 上占用了这两个端口。两个栈抢一个端口的表现很像 Opik 自身故障，所以在这里一次性避开。
后端 API（8080）不对外发布，只经前端 nginx 反代（`http://frontend:5173/api`）。所有发布端口只绑
`127.0.0.1` 与 `[::1]`。

## 健康检查

```bash
docker compose --project-directory . -f docker/compose/opik.yml ps
curl -fsS http://127.0.0.1:5174/api/health-check     # 经前端反代
```

后端容器自身的 healthcheck 是 `curl -f http://localhost:8080/health-check`。**HTTP 200 不等于集成
就绪**：就绪条件由 #15（配置与健康）统一判定，缺必需能力时即使健康也是未就绪。

## 故障排查

- `docker compose ... ps` 里有服务不健康：`docker compose --project-directory . -f docker/compose/opik.yml logs <service>`。
  后端首次启动要跑数据库迁移，healthcheck 变绿可能需要一两分钟。
- 起不来并报 `required variable OPIK_... is missing a value`：`.env` 里还缺上面六个凭据之一，
  这是刻意的拒绝启动（`:?`），不是 bug。
- 宿主上 4317/4318 被 Tempo 占用属预期：Opik 的 OTLP 在 5418/5417，不要把它改回上游默认。
- 彻底重来：`down -v` 删数据卷后重新 `up -d`。

## 停止与数据

```bash
docker compose --project-directory . -f docker/compose/opik.yml down          # 保留数据卷
docker compose --project-directory . -f docker/compose/opik.yml down -v       # 删除数据卷
```

保留期与真实删除的语义见 #41（T35）：隐藏一行不等于删除内容，删除必须在上游确证查不到之后才报完成。

## 未纳入的服务

上游 compose 里的 `demo-data-generator`（会写入示例数据，污染真实验收）与 `jaeger`（本仓库已有
Tempo/Grafana）不在本栈内；`guardrails-backend*` 也不在内。上游的 `clickhouse-init`（`alpine:latest`
浮动 tag）由 `docker/opik/clickhouse-config/` 的直接挂载替代。

## 控制面访问

Opik 控制台与私有 API 的保护属于 #38（T32）。在它完成之前，这个实例只应在 loopback 上运行，
不得暴露到网络，也不得被当作已受保护的控制面。
