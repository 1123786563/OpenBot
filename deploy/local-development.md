# 在当前工作区运行 OpenBot

> 新集中部署见[Linux 安装指南](README.md)。本页保留既有部署方式，不会自动迁移数据库、Redis 或对象存储。

本机实例使用仓库中的 Compose 文件。OpenBot API、Web、Worker 以及四个 Agent 服务都从当前工作区的源码构建。每个服务的私有配置放在 Git 忽略的 `deploy/.local/`。主应用使用本地 PostgreSQL 的 `openbot_prod`，Infisical 保持原有本机项目和数据。

| 组件 | 本机入口 | OpenBot 使用的连接 |
| --- | --- | --- |
| PostgreSQL | `127.0.0.1:15432` | `postgres:5432/openbot_prod` |
| OpenBot API、Web、Worker | [OpenBot](http://127.0.0.1:18001) | 单用户管理员，Worker 使用独立共享令牌 |
| Bifrost 及 registry proxy | [Bifrost](http://127.0.0.1:18080) | 模型走 `bifrost-api:8080/v1`，技能目录走只读数据库角色 |
| Infisical | [Infisical](http://127.0.0.1:18082) | 已使用机器身份导出至 `deploy/.local/infisical-export.env` |
| OpenObserve 和 Collector | [OpenObserve](http://127.0.0.1:15080) · OTLP `127.0.0.1:14318` | 审计通过 `otel-collector:4318/v1/logs`，运行日志通过 Docker 日志采集 |
| Hindsight | [健康检查](http://127.0.0.1:18888/health) | `hindsight:8888` |
| Opik | [Opik](http://127.0.0.1:15173) | `opik-frontend:5173/api/` |
| Bot、LangGraph、Computer、Supervisor | `127.0.0.1:4200`、`4201`、`4100`、`4500` | 使用 Agent Compose 内的服务名 |
| SPIRE | Docker 内部 | SPIRE Server 与 Agent 通过工作负载套接字提供本地身份 |

OpenBot 和两个对话 Agent 通过 Bifrost 使用已配置的模型供应商。当前本机 Bifrost 需要配置可用的模型供应商才能处理对话。

## 重建与启动

以下命令使用此工作区中已生成的本机配置。在仓库根目录执行。

```sh
docker build -f deploy/openbot/Dockerfile -t openbot-local-stack:worktree .
./deploy/compose.sh --local agents build
./deploy/compose.sh --local agents up -d --no-build
./deploy/compose.sh --local openbot up -d --no-build --wait
```

查看任一服务组的状态或日志。组件名支持 `postgres`、`bifrost`、`infisical`、`openobserve`、`hindsight`、`opik`、`agents`、`openbot` 和 `spire`。

```sh
./deploy/compose.sh --local openbot ps -a
./deploy/compose.sh --local openobserve logs --tail 50 otel-collector
curl --fail http://127.0.0.1:18001/health
curl --fail http://127.0.0.1:18001/api/me
```

## 本机部署验收记录

- OpenBot 首页、`/health` 和单用户管理员身份已通过 HTTP 检查。数据库迁移成功，API 与 Worker 运行时的数据库角色没有超级用户权限。
- 主应用完成一轮真实模型对话，PostgreSQL 记录为 `completed`，Opik 记录为已投递，并在 `openbot-runs` 查回 Trace。
- Bot 和 LangGraph 均收到经过 Bifrost 的真实模型流。Computer 渲染了 Chromium 截图，Supervisor 创建了有 SPIRE 注册的临时 Computer。
- OpenObserve 查回 API 和 Worker 运行日志以及 OpenBot 审计事件，保留期分别为 30 天和 90 天。
- Hindsight 写入并召回了合成记忆。Worker 可按 [Flexprice 用量对账](docs/flexprice.md)配置零价订阅。
- Infisical 的机器身份导出已验证。
