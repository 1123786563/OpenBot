# OpenBot 中间件 Docker Compose

每个中间件使用一个独立的 Compose 项目。服务器 129.28.39.52 的部署目录为 `/opt/openbot-middleware`。各服务只把端口发布到服务器本机回环地址。

| 目录 | 本机端口 | 需要的配置 |
| --- | --- | --- |
| `bifrost/` | 18080 | PostgreSQL 连接信息、初始化令牌、模型供应商与 API 密钥 |
| `openobserve/` | 15080 | 初始管理员邮箱和密码 |
| `otel-collector/` | 14318 | 部署 ID、OpenObserve OTLP 日志地址、运行日志和审计日志的授权头 |
| `agents/` | 4100、4200、4201、4500 | OpenBot 源码路径、模型供应商配置和三个服务令牌 |
| `openbot/` | 18001 | 应用镜像、独立 PostgreSQL 数据库、Worker 和 Agent 令牌 |

PostgreSQL、Casdoor 和 OpenResty 由服务器上已有的 1Panel Compose 项目管理。Bifrost 使用现有 PostgreSQL 实例中的 `bifrost` 数据库。OpenObserve 使用持久化卷，Collector 通过名为 `openbot-observability` 的内部 Docker 网络访问 OpenObserve。

## 重启

在服务器上进入对应目录，按需运行以下命令。修改 `.env` 或 Compose 文件后，使用 `docker compose up -d` 应用变更。

```sh
cd /opt/openbot-middleware/bifrost
docker compose restart
docker compose ps
docker compose logs --tail 50
```

`openobserve` 和 `otel-collector` 使用同样的操作。重建容器时保留数据卷。

## 迁移到其他服务器

复制所需的服务目录，从 `.env.example` 创建各自的私有 `.env`。如果复用 1Panel PostgreSQL，将 Bifrost 目录中的 `docker-compose.override.yml.example` 复制为 `docker-compose.override.yml`，并按目标主机填写数据库地址、端口和 SSL 模式。

如果 OpenObserve 与 Collector 同机，执行一次 `docker network create --internal openbot-observability`，并把两个项目各自的 `docker-compose.override.yml.example` 复制为 `docker-compose.override.yml`。将 Collector 的 `OPENOBSERVE_OTLP_LOGS_URL` 设为 `http://openobserve:5080/api/default/v1/logs`。如果分机部署，填写从 Collector 容器可访问的 HTTPS 写入地址。

每个项目都可在自己的目录中执行 `docker compose config --quiet` 校验，以及执行 `docker compose up -d` 启动。

## OpenObserve 持续日志采集

下面的步骤对应服务器 `129.28.39.52` 上已验收的配置。OpenObserve 和 Collector 必须加入同一个外部网络，网络名固定为 `openbot-observability`。

```sh
docker network inspect openbot-observability >/dev/null 2>&1 \
  || docker network create --internal openbot-observability
```

先启动 OpenObserve，再启动 Collector。两个项目都要同时加载基础 Compose 文件和外部网络 override。

```sh
cd /opt/openbot-middleware/openobserve
cp -n .env.example .env
cp -n docker-compose.override.yml.example docker-compose.override.yml
# 编辑 .env，填写唯一的 OPENOBSERVE_ROOT_EMAIL 和 OPENOBSERVE_ROOT_PASSWORD
docker compose -f docker-compose.yml -f docker-compose.override.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
curl --fail http://127.0.0.1:15080/healthz

cd /opt/openbot-middleware/otel-collector
cp -n .env.example .env
cp -n docker-compose.override.yml.example docker-compose.override.yml
# 编辑 .env，填写部署 ID、写入地址和两个 ingestion token 授权头
docker compose -f docker-compose.yml -f docker-compose.override.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --force-recreate
docker compose ps
```

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
cd /opt/openbot-middleware/openobserve
docker compose -f docker-compose.yml -f docker-compose.override.yml config --quiet
curl --fail http://127.0.0.1:15080/healthz

cd /opt/openbot-middleware/otel-collector
docker compose -f docker-compose.yml -f docker-compose.override.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.override.yml run --rm --no-deps \
  --entrypoint /otelcol-contrib otel-collector validate \
  --config=/etc/otelcol-contrib/config.yaml
docker compose ps
docker compose logs --since 10m --no-color otel-collector | \
  grep -E 'Exporting failed|Dropping data|lookup .*openobserve|connection refused' && exit 1 || true
```

生成一个带时间戳的唯一 marker，分别触发一条 OpenBot 运行日志和一条审计事件，然后用管理员查询身份从 `openbot_runtime` 与 `openbot_audit` 读回 marker。验收还应包括一次未授权 OTLP 请求返回 `401`，以及使用 ingestion token 的授权 OTLP 请求成功。保存 Compose 状态、Collector 日志和查询结果作为部署证据。

### 回滚

升级前在服务器保存当前配置和私有环境文件。至少包括两个 Compose 文件、`otel-collector.yaml`、OpenObserve 的 `.env`、Collector 的 `.env` 和 `docker compose config` 输出。

```sh
cd /opt/openbot-middleware/openobserve
docker compose -f docker-compose.yml -f docker-compose.override.yml config > /root/openobserve-compose.before.yml
cp .env /root/openobserve.env.before

cd /opt/openbot-middleware/otel-collector
docker compose -f docker-compose.yml -f docker-compose.override.yml config > /root/otel-collector-compose.before.yml
cp .env /root/otel-collector.env.before
cp otel-collector.yaml /root/otel-collector.yaml.before
```

回滚时恢复备份的模板和私有环境文件，然后按原顺序重新创建容器。不要执行 `docker compose down -v`，也不要删除 `openobserve-data` 卷。这样可以保留已经采集的运行日志和审计数据。

```sh
cd /opt/openbot-middleware/otel-collector
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --force-recreate

cd /opt/openbot-middleware/openobserve
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --force-recreate
curl --fail http://127.0.0.1:15080/healthz
```

如果只回滚 Docker 文件日志接收器，先停止并重建 Collector，保留 OpenObserve 数据卷和两个日志流。回滚后重新执行健康检查、匿名查询 `401`、授权写入、两个流的 marker 查询，以及 Collector 错误日志检查。

## Agent 服务

服务器使用 `/opt/openbot-middleware/agents`，Compose 项目名为 `openbot-agents`。私有 `.env` 通过 `OPENBOT_AGENT_SOURCE` 指向已上传的 OpenBot 源码，并配置镜像标签、模型地址和服务令牌。两个对话 Agent 通过智谱接口请求 `glm-4.6`。

| 服务 | 服务器回环地址 | Compose 网络内地址 |
| --- | --- | --- |
| `agent-bot` | `127.0.0.1:4200/ag-ui` | `http://agent-bot:4200/ag-ui` |
| `agent-langgraph` | `127.0.0.1:4201/ag-ui` | `http://agent-langgraph:4201/ag-ui` |
| `agent-computer` | `127.0.0.1:4100` | `http://agent-computer:4100` |
| `supervisor` | `127.0.0.1:4500` | `http://supervisor:4300` |

```sh
cd /opt/openbot-middleware/agents
docker compose config --quiet
docker compose restart
docker compose ps
```

修改 `.env` 后运行 `docker compose up -d --no-build`，重建镜像时运行 `docker compose build`。Supervisor 创建的 Computer 加入 `openbot-agents_default`，调用动态 Computer 的 OpenBot API 也需要加入该网络。要启用 LangGraph 工具回调，在两端配置相同的 `AGENT_TOOL_TOKEN`，并将 `OPENBOT_TOOL_URL` 指向 Agent 容器可访问的 OpenBot API。此部署的 SPIRE 集成处于关闭状态。

服务器上已重启四个服务并验证健康状态。两个对话 Agent 均通过鉴权和 AG-UI 流式对话测试。独立 Computer 和 Supervisor 创建的临时 Computer 均生成了 Chromium 截图，临时实例及数据卷已清理。

## OpenBot 主应用

服务器部署目录为 `/opt/openbot-middleware/openbot`，Compose 项目名为 `openbot-server`。首次启动先运行 `migrate`，迁移成功后启动 API、Web 和 Worker。数据库为 1Panel PostgreSQL 上独立的 `openbot_prod`。服务配置保存在服务器的 `.env` 和 `.env.server`。

```sh
cd /opt/openbot-middleware/openbot
docker compose restart server worker local-access
docker compose ps -a
curl --fail http://127.0.0.1:18001/health
```

应用采用单用户模式。1Panel OpenResty 仅在服务器回环地址的 `18001` 端口提供页面。通过 SSH 转发后，在浏览器打开 `http://127.0.0.1:18001/`。

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18001:127.0.0.1:18001 root@129.28.39.52
```

LangGraph 的回调地址为 `http://openbot-api:3001/api/agent-tools/call`，仅供 Docker 网络内的服务使用。已验证回调路由可达并拒绝缺少运行签名的请求。

`persaas.cn` 的 OpenResty 站点将首页和 `/api/*` 转发到同一个 OpenBot 服务。当前仅允许服务器回环访问。可在服务器上验证域名路由。

```sh
curl --fail --resolve persaas.cn:80:127.0.0.1 http://persaas.cn/health
curl --fail --resolve persaas.cn:80:127.0.0.1 http://persaas.cn/api/me
```

公网启用需要确认 DNSPod 上另一条 A 记录的用途、解除腾讯云拦截、签发 `persaas.cn` 的证书并启用登录认证。

## 1Panel OpenResty

三个子域名共用 OpenResty 的 80 端口，按 HTTP Host 转发。当前虚拟主机仅接受服务器回环访问。公网请求被腾讯云拦截，公网 HTTPS 尚未启用。

| 域名 | 上游 |
| --- | --- |
| `bifrost.persaas.cn` | `127.0.0.1:18080` |
| `openobserve.persaas.cn` | `127.0.0.1:15080` |
| `otel.persaas.cn` | `127.0.0.1:14318` |

服务器上的站点配置位于 `/opt/1panel/1panel/www/conf.d/openbot-middleware.conf`，公共代理头位于 `/opt/1panel/1panel/www/openbot-middleware/proxy-headers.conf`。OTel 入口只接受携带有效 Bearer 令牌的 `POST /v1/logs`。私有令牌文件位于 `/opt/1panel/1panel/www/openbot-middleware/private/otlp-token.conf`。

在服务器上验证或重载配置。

```sh
docker exec 1Panel-openresty-k1Ke nginx -t
docker exec 1Panel-openresty-k1Ke nginx -s reload
curl --fail --resolve bifrost.persaas.cn:80:127.0.0.1 http://bifrost.persaas.cn/health
```
