# OpenBot 部署运维

从[部署入口](README.md)查看服务拓扑、配置位置和启动顺序。此页记录各服务的配置、迁移和验收。

单用户环境可用 `OPENBOT_SINGLE_USER=true`，多人环境需要注册登录源。OpenBot 的 PostgreSQL 同时承载业务数据和后台任务。Redis 和对象存储由表中使用它们的服务各自管理。Infisical 的密钥需要通过运维流程注入 OpenBot 环境文件。

## 需要外部地址或凭据的集成

| 集成 | 配置入口 |
| --- | --- |
| CopilotKit Intelligence | `INTELLIGENCE_API_URL`、`INTELLIGENCE_GATEWAY_WS_URL`、`INTELLIGENCE_API_KEY` |
| Composio、Corsair Cloud | `COMPOSIO_API_KEY`、`CORSAIR_CLOUD_*`，按连接器注册第三方应用 |
| 转写和实时语音 | `TRANSCRIPTION_*`、`VOICE_*` |
| Twilio、Expo、AWS SES/SNS、OpenTag | 短信、移动推送、入站邮件和语音 Bot 按需配置，见根目录 [.env.example](../.env.example) |
| Webhook、SCIM、渠道应用 | 依对应平台配置回调地址、连接器凭据或目录令牌，见 [OpenBot 配置说明](../docs/configuration.md) |
| WeKnora 托管 Embedding | 使用实现 OpenBot 计费协议的 WeKnora Worker，填写 `OPENBOT_WEKNORA_*`。托管额度还需要与发布版本匹配的计量器和凭据。见 [WeKnora 接入](../docs/billing-weknora-live.md) 和 [试用配置](../docs/billing-test-credit-pilot.md) |

在当前工作区运行全套服务时，见[本地启动和验收](local-development.md)。

## 在新主机启动

使用 Docker Compose 2.24.4 或更新版本。进入所选服务目录，将 `.env.example` 复制为私有 `.env` 并填写凭据。先启动数据库和后端依赖，再启动需要它们的项目。对每个项目运行 `docker compose config --quiet` 和 `docker compose up -d`。

### PostgreSQL 和登录

在 `postgres/` 启动数据库后，用 `docker compose exec postgres psql -U postgres` 进入管理会话。为启用的服务创建独立账户和数据库。先运行 `CREATE ROLE openbot LOGIN;`，用 `\password openbot` 交互设置密码，再运行 `CREATE DATABASE openbot_prod OWNER openbot;`。如果启用 Bifrost，按同样的方式为它创建数据库和账户。OpenBot 的历史迁移会创建并删除 `vector` 扩展，需要具备扩展操作权限的迁移账号。专用本地 PostgreSQL 可在单独运行迁移期间临时提升数据库所有者，启动 API 和 Worker 前撤回权限。

数据库容器在 `openbot-postgres` 网络上的地址是 `postgres:5432`。新主机使用以下配置连接它。

- OpenBot 设置 `MIDDLEWARE_POSTGRES_NETWORK=openbot-postgres`，将 `DATABASE_URL` 指向 `postgres:5432/openbot_prod`。
- Bifrost 复制 PostgreSQL override 模板，设置 `MIDDLEWARE_POSTGRES_NETWORK=openbot-postgres`、`BIFROST_DB_HOST=postgres`。新建的本机数据库没有启用 TLS，在该私有网络内设置 `BIFROST_DB_SSL_MODE=disable`。

### 应用入口和日志

OpenBot API 直接发布在宿主机回环端口 `18001`。Bifrost 是当前技能目录，设置 `BIFROST_SKILL_MARKET_DATABASE_URL` 并按 [Bifrost 接入文档](bifrost/README.md) 配置只读账户。迁移完成的部署可从 OpenBot 私有环境移除 `SKILLHUB_*`。保留旧数据库和技能包归档，供审计与恢复。

按下文设置 OpenObserve 日志流、保留期和 Collector 授权。OpenBot 主应用使用 `openbot-observability` 和 Agent 网络，启动前创建观测网络并启动 Agent 项目。Compose 引用的外部网络须先存在。将 `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` 设为 `http://otel-collector:4318/v1/logs`，并按需求启用 `OPENBOT_OTEL_EXPORT`。

### Hindsight、Opik 和 Lago

Hindsight 的初始配置仅启用本地索引和召回。首次启动需要下载本地模型。将 OpenBot 连接到 `openbot-hindsight` 网络后，使用 `OPENBOT_HINDSIGHT_API_URL=http://hindsight:8888`。启用 Reflect、删除重放或恢复前，按 [配置说明](../docs/configuration.md#personal-memory-recall-and-reflect) 设置和验收。

Opik 和 Lago 引用各自的上游 Compose。进入对应目录后检出固定版本，再用该目录的 `.env` 和 Compose 启动。见 [Opik 自托管文档](https://www.comet.com/docs/opik/self-host/local_deployment) 和 [Lago 部署文档](https://github.com/getlago/lago/tree/v1.57.0#deploy-lago)。

```sh
# 在 opik/ 目录
git clone --depth 1 --branch 2.3.0 https://github.com/comet-ml/opik.git upstream
docker compose config --quiet
docker compose up -d --no-build

# 在 lago/ 目录
git clone --depth 1 --branch v1.57.0 https://github.com/getlago/lago.git upstream
docker compose config --quiet
docker compose up -d --no-build
```

Opik 的 `MINIO_ROOT_PASSWORD` 使用独立随机密码。OpenBot API 连接 `openbot-opik` 网络后，可配置 `OPENBOT_OPIK_API_URL=http://opik-frontend:5173/api/`。真实样本评测需要另建私有实例，使用不同的 `-p` 项目名、`OPIK_PORT`、`OPIK_CLIENT_NETWORK`、`OPIK_CLIENT_HOSTNAME` 和独立卷。按 [真实样本评测说明](../docs/configuration.md#authorized-real-samples) 配置访问和撤回流程后，再启用 `OPENBOT_OPIK_REAL_EVAL_API_URL`。

Lago 的数据库密码可用 `openssl rand -hex 32` 生成，Rails 签名密钥用 `openssl rand -hex 64`，三个加密值分别用 `openssl rand -hex 16`。用 `openssl genrsa 2048 | openssl base64 -A` 生成 `LAGO_RSA_PRIVATE_KEY`。按 [用量投递配置](../docs/billing-lago-usage-export.md) 创建 API 凭据和用量订阅后，将 OpenBot Worker 连接到 `openbot-lago` 网络，填写 `LAGO_URL=http://lago-api:3000`、`LAGO_API_KEY` 和 `LAGO_USAGE_SUBSCRIPTION_ID`。

连接可选中间件时，用 OpenBot 项目的本地 Compose override 给实际调用方加网。下面以 Hindsight 为例。Opik 同样连接 `server`，Lago 则连接 `worker`。保持 Agent 和 Computer 在自身网络内。

```yaml
services:
  server:
    networks: [hindsight]
networks:
  hindsight:
    external: true
    name: openbot-hindsight
```

在当前 OpenBot 部署目录创建 `docker-compose.override.yml` 后，运行 `docker compose config --quiet`，再运行 `docker compose up -d`。回环端口供主机访问，从其他容器调用时使用服务的私有网络地址或容器可达的 HTTPS 地址。

Infisical 原先使用 18080。已有实例升级配置时，在 Infisical 的私有 `.env` 同步修改 `INFISICAL_PORT` 和 `SITE_URL`，再重建容器。保留原项目名和卷。

## 重启

在服务器上进入对应目录，按需运行以下命令。修改 `.env` 或 Compose 文件后，使用 `docker compose up -d` 应用变更。

```sh
cd /opt/openbot/deploy/bifrost
docker compose restart
docker compose ps
docker compose logs --tail 50
```

观测项目在 `openobserve/` 中执行同样的操作。可用 `docker compose restart otel-collector` 单独重启 Collector。

## 迁移到其他服务器

复制所需的服务目录，从 `.env.example` 创建各自的私有 `.env`。如果复用 1Panel PostgreSQL，将 Bifrost 目录中的 `docker-compose.override.yml.example` 复制为 `docker-compose.override.yml`，并按目标主机填写数据库地址、端口和 SSL 模式。

每个项目都可在自己的目录中执行 `docker compose config --quiet` 校验，以及执行 `docker compose up -d` 启动。

## OpenObserve 持续日志采集

在 `openobserve/` 统一管理 OpenObserve 和 Collector。Collector 默认通过 Compose 内部地址 `http://openobserve:5080/api/default/v1/logs` 写入。OpenBot 通过外部网络 `openbot-observability` 访问 Collector。两者的宿主机端口均只绑定回环地址。

```sh
docker network inspect openbot-observability >/dev/null 2>&1 \
  || docker network create --internal openbot-observability

cd /opt/openbot/deploy/openobserve
cp -n .env.example .env
# 在 .env 填写初始管理员邮箱、密码和 OPENBOT_DEPLOYMENT_ID。
docker compose config --quiet
docker compose up -d openobserve
curl --fail --retry 12 --retry-all-errors --retry-delay 1 http://127.0.0.1:15080/healthz
# 按下文配置日志流和 ingestion token 后启动 Collector。
docker compose up -d
docker compose ps
```

### 从两个 Compose 项目合并

1. 备份旧项目的配置文件、私有环境文件和 OpenObserve 数据卷。记录现有项目名及数据卷实际名称。合并配置默认沿用 `openbot-openobserve` 和 `openbot-middleware_openobserve-data`。已有自定义名称时继续使用原项目名和 `OPENOBSERVE_VOLUME`。
2. 用旧 Collector 项目和原来的 Compose 文件执行 `docker compose stop otel-collector`，释放 14318。将旧 Collector 的配置值合并到 `openobserve/.env`。若旧的 `OPENBOT_RUNTIME_LOG_DIR` 是相对路径，改成原日志目录的绝对路径。将 `OPENOBSERVE_OTLP_LOGS_URL` 改为上面的内部地址。
3. 保留外部观测网络，将旧的 `docker-compose.override.yml` 挪到备份目录，再更新 `openobserve/` 的配置与 Collector YAML。执行 `docker compose config --quiet` 和 `docker compose up -d`，然后完成下方验收。

Collector 使用 `user: "0:0"`，并以只读方式挂载 `/var/lib/docker/containers`。这是读取 Docker `json-file` 日志所需的主机权限。`OPENBOT_DOCKER_LOG_GLOB` 的默认值为 `/docker-containers/*/*-json.log`。如果目标主机使用其他日志目录，应在 Collector 的私有 `.env` 中覆盖该变量。

### Token 和角色隔离

OpenObserve 的 root 邮箱和密码只用于管理控制台、创建流和配置权限。Collector 使用单独的 ingestion token。把 token 编码为 `:` 加 token 本身的 Base64，并将结果作为 `Basic ` 授权头写入两个私有环境变量。

```sh
printf ':%s' "$OPENOBSERVE_INGESTION_TOKEN" | base64
```

将相同的 ingestion token 分别配置到 `OPENOBSERVE_RUNTIME_AUTHORIZATION` 和 `OPENOBSERVE_AUDIT_AUTHORIZATION`。查询人员使用 root 或 OIDC 查询身份，不要把 root 密码放进 Collector。创建或更新 token 后，重建 Collector 使环境变量生效。

### 流和保留期

在 OpenObserve 管理界面为默认组织创建以下两个日志流。

| 流 | 保留期 | `store_original_data` | `index_original_data` |
| --- | ---: | --- | --- |
| `openbot_runtime` | 30 天 | `false` | `false` |
| `openbot_audit` | 90 天 | `false` | `false` |

保留期修改只影响后续清理任务，不需要删除数据卷。提交配置变更后，使用管理身份确认两个流的设置，并使用查询接口确认 ingestion token 不能读取 Streams 或 Search API。匿名查询应返回 `401`。

### 验收清单

```sh
cd /opt/openbot/deploy/openobserve
docker compose config --quiet
curl --fail http://127.0.0.1:15080/healthz
docker compose run --rm --no-deps \
  --entrypoint /otelcol-contrib otel-collector validate \
  --config=/etc/otelcol-contrib/config.yaml
docker compose ps
docker compose logs --since 10m --no-color otel-collector
```

分别触发一条带唯一标识的 OpenBot 运行日志和审计事件，用管理员身份在 `openbot_runtime` 和 `openbot_audit` 中读回。确认 Collector 日志没有导出失败、丢弃数据、DNS 解析失败或连接拒绝。

### 回滚

先从合并项目停止 Collector。恢复两个旧项目的 Compose、override、Collector YAML 和私有环境文件。先启动旧 OpenObserve，确认 `/healthz` 正常，再启动旧 Collector 并重复验收。保留数据卷和外部观测网络，避免执行 `docker compose down -v`。

## Agent 服务

以下示例假定源码检出到 `/opt/openbot`。Agent Compose 项目名为 `openbot-agents`。在 `agents/.env` 中将 `OPENBOT_AGENT_SOURCE` 设为源码绝对路径，并填写镜像标签、模型地址、模型名称和服务令牌。

| 服务 | 服务器回环地址 | Compose 网络内地址 |
| --- | --- | --- |
| `agent-bot` | `127.0.0.1:4200/ag-ui` | `http://agent-bot:4200/ag-ui` |
| `agent-langgraph` | `127.0.0.1:4201/ag-ui` | `http://agent-langgraph:4201/ag-ui` |
| `agent-computer` | `127.0.0.1:4100` | `http://agent-computer:4100` |
| `supervisor` | `127.0.0.1:4500` | `http://supervisor:4300` |

```sh
cd /opt/openbot/deploy/agents
docker compose config --quiet
docker compose restart
docker compose ps
```

修改 `.env` 后运行 `docker compose up -d --no-build`，重建镜像时运行 `docker compose build`。Supervisor 创建的 Computer 加入 `openbot-agents_default`，调用动态 Computer 的 OpenBot API 也需要加入该网络。要启用 LangGraph 工具回调，在两端配置相同的 `AGENT_TOOL_TOKEN`，并将 `OPENBOT_TOOL_URL` 指向 Agent 容器可访问的 OpenBot API。此部署的 SPIRE 集成处于关闭状态。

部署后检查四个服务的健康状态。对两个对话 Agent 各发一条带鉴权的 AG-UI 请求，确认流式响应结束。用 Computer 获取一张 Chromium 截图，并确认 Supervisor 能创建独立 Computer。

## OpenBot 主应用

服务器部署目录为 `/opt/openbot/deploy/openbot`，Compose 项目名为 `openbot-server`。首次启动先运行 `migrate`，迁移成功后启动 API、Web 和 Worker。数据库使用专用的 `openbot_prod`，可由本仓库 Compose 或已有的 PostgreSQL 实例承载。服务配置保存在服务器的 `.env` 和 `.env.server`。新部署从 [API 环境样例](openbot/server.env.example) 创建 `.env.server`。完整参数见[应用配置项](../.env.example)。

```sh
cd /opt/openbot/deploy/openbot
docker compose up -d --remove-orphans
docker compose ps -a
curl --fail http://127.0.0.1:18001/health
```

单用户部署通过服务器回环地址的 `18001` 端口提供页面。升级旧部署前，先释放原代理占用的 18001 监听端口。通过 SSH 转发后，在浏览器打开 `http://127.0.0.1:18001/`。

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18001:127.0.0.1:18001 user@server
```

LangGraph 的回调地址为 `http://openbot-api:3001/api/agent-tools/call`，仅供 Docker 网络内的服务使用。验收时确认回调路由可达，缺少运行签名的请求会被拒绝。
