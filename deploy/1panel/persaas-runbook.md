# 在 1Panel 部署 OpenBot 到 persaas.cn

本手册用于服务器 `129.28.39.52`。在新服务器从第 1 节开始。在现有服务器继续部署时，先核对下面的交接状态，再执行未完成的步骤。

## 核对现有服务器

- 中间件已通过 1Panel 启动。OpenObserve 已验证公网 HTTPS。Infisical 已验证证书和回源，权威 DNS 已发布。先用第 6 节命令核对当前状态。
- OpenBot 已用当前仓库源码构建为 Linux amd64 镜像。服务器 Compose 在 `/opt/openbot-server`。Web 和 API 监听 `127.0.0.1:18001`，独立 PostgreSQL 和 Worker 已启动。数据库迁移退出码为 0，应用角色已撤销超级用户权限。
- 在服务器回环地址调用 OpenBot 后端，智谱 `glm-4.7` 返回 `OPENBOT_SERVER_OK`，流式请求正常结束。OpenBot 容器访问 Hindsight、Opik 和 OTel Collector 均返回 HTTP 200。
- 当前 OpenBot 以单用户模式运行。正式上线需要配置 OAuth、OpenBot 的 DNS 和 HTTPS 反代。当前模型直连智谱。Bifrost 上游、Agent 真实调用和 Infisical 机器身份仍待配置。
- 部署文件通过临时受限 SSH 密钥上传，密钥设有到期时间。交接时可按第 7 节清理这次上传留下的文件和密钥。

## 1. 安装 1Panel 中间件

1. 安装 1Panel v2、Docker Engine 和 Docker Compose。确认 Docker 网络 `1panel-network` 存在。
2. 在服务器上备份现有数据库及应用数据卷。准备 PostgreSQL 和 MySQL，并为各应用分配独立库和账户。
3. 将所需的独立 `tar.gz` 上传到 `/opt/1panel/resource/apps/local/`，逐包解压。解压后的目录应为 `local/<应用名>/data.yml`。在 1Panel 的 **应用商店 → 本地** 刷新应用列表。
4. 按安装说明创建各组件的 Docker 网络。用 1Panel 表单选择已登记的数据库。新装时使用表单生成的库名、用户名和密码。恢复现有实例时使用原值。[应用包和网络说明](README.md)
5. 按下面的依赖安装。每项通过健康检查后再接入调用方。

| 组件 | 安装和核对 |
| --- | --- |
| Bifrost | 选择 PostgreSQL，保存初始化令牌。内网网关地址为 `http://openbot-bifrost:8080/v1` |
| OpenObserve 和 OTel Collector | 安装 `openobserve.tar.gz`。先创建日志流及专用写入令牌，再启用 Collector。主机端口为 15080 和 14318 |
| Infisical | 选择 PostgreSQL 和 Redis 实例，保存加密密钥及签名密钥。设置 `SITE_URL=https://infisical.persaas.cn` |
| Hindsight | 准备支持 pgvector 的 PostgreSQL。当前服务器使用独立的可移植 pgvector 镜像。记下表单中的控制台访问密钥。安装后检查 `127.0.0.1:18888/health` 并实际写入和召回一条测试记忆 |
| Opik | 选择 MySQL 和 Redis，等待 MySQL 和 ClickHouse 迁移。检查 `127.0.0.1:15173/health` |
| SPIRE | 启动 Server 后签发一次性加入令牌，再启动 Agent。在 Server 中确认 Agent 已注册 |
| Agents | 准备 Bot、LangGraph、Computer 和 Supervisor 镜像。安装后检查四个回环端口 4200、4201、4100、4500 |

Hindsight 在当前服务器的共享 PostgreSQL 上写入时曾触发 `Illegal instruction`。如果在同一台服务器重装，沿用 Hindsight 的独立 PostgreSQL 和持久卷。

## 2. 启动 OpenBot 主应用

现有服务器从 `/opt/openbot-server` 继续。检查 Compose 和已经完成的迁移，避免再启动一个占用同一端口的实例。

```sh
cd /opt/openbot-server
docker compose config --quiet
docker compose ps -a
curl -fsS http://127.0.0.1:18001/health
```

新服务器可从仓库根目录构建镜像。镜像包含 Web、API 和 Worker，浏览器工具由独立 Agent 服务提供。

```sh
docker build -f deploy/openbot/Dockerfile -t openbot-server:local .
```

1. 参考 [OpenBot Compose](../openbot/docker-compose.yml) 和 [API 环境样例](../openbot/server.env.example) 建立部署目录。填写 `OPENBOT_IMAGE`、`DATABASE_URL` 和 `WORKER_SHARED_SECRET`。将 API 私有变量放进 `.env.server`，两个环境文件权限设为 `600`。
2. 在数据库网络上创建应用专用库和账户。OpenBot 历史迁移会创建并删除 `vector`。若专用实例用临时超级用户执行首次迁移，在启动 Web、API 和 Worker 前撤销该权限。共享实例先由 DBA 核对权限和扩展操作。[数据库准备说明](../operations.md#postgresql-和登录)
3. 启动 Agent 项目和观测网络后，再启动 OpenBot。使用 1Panel 的 Agents 包时，从实际容器查出 Agent 的项目网络名，并填入 OpenBot Compose。为 OpenBot API 保留 `openbot-api` 网络别名。
4. 用 `openssl rand -base64 32` 生成一次 `KEY_ENCRYPTION_KEY`。备份此密钥，重装时沿用。单用户验收使用 `OPENBOT_SINGLE_USER=true`，且只绑定 `127.0.0.1:18001`。
5. 运行 `docker compose config --quiet`。确认外部 PostgreSQL 已就绪。首次安装时，先单独运行迁移。完成第 2 步的权限核对后，再启动 API 和 Worker。

```sh
docker compose up --no-deps --exit-code-from migrate migrate
# 如临时授予了超级用户权限，先用管理员账号执行 ALTER ROLE openbot NOSUPERUSER。
docker compose up -d --no-deps --wait server
docker compose up -d --no-deps worker
docker compose ps -a
```

确认迁移退出码为 0、PostgreSQL 和 API 健康、Worker 持续运行。

仓库中的 `openbot.tar.gz` 可在 1Panel 本地应用里填写中间件参数。表单使用源码构建的服务器镜像，Google OAuth 凭据由管理员填写。参见 [安装表单说明](README.md#填写表单)。

## 3. 配置模型和服务间通信

先验证已在服务器跑通的直连配置。把模型 Key 写入服务器私有环境文件。正式使用前更换测试阶段分享过的 Key。

```dotenv
BOT_PROVIDER=openai
BOT_MODEL=glm-4.7
COPILOTKIT_OPENAI_API=chat
OPENAI_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4
OPENAI_API_KEY=<智谱 API Key>
```

切换到 Bifrost 时，在 Bifrost 创建一个 OpenAI 兼容的智谱上游，填写相同的 Chat Completions 基础地址及模型。创建仅允许所需模型的虚拟密钥。先在内网确认模型列表、普通响应和流式响应，再把 OpenBot 的 `OPENAI_BASE_URL` 改成 `http://openbot-bifrost:8080/v1`。将 `OPENAI_API_KEY` 换成虚拟密钥，并按 Bifrost 返回的模型 ID 设置 `BOT_MODEL`。Agent 服务使用自己获准的虚拟密钥，更新安装时填入的占位值。

| 调用方 | 配置 |
| --- | --- |
| OpenBot API → Agent | 设置 `MANAGED_AGENT_AG_UI_URL`、`AGENT_COMPUTER_URL`、`COMPUTER_SUPERVISOR_URL`。让容器加入可到达这些服务的网络，并使用对应服务令牌 |
| Agent → OpenBot API | 设置 `OPENBOT_TOOL_URL=http://openbot-api:3001/api/agent-tools/call`，两端使用同一 `AGENT_TOOL_TOKEN` |
| OpenBot API → Collector | 加入 `openbot-observability`。设置 `OPENBOT_OTEL_EXPORT=on`，将 `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` 指向 Collector 的 `/v1/logs`。查询端用 `DEPLOYMENT_ID` 过滤日志。[日志流和权限配置](../operations.md#openobserve-持续日志采集) |
| OpenBot API → Hindsight | 加入 `openbot-hindsight`，设置 `OPENBOT_HINDSIGHT_API_URL=http://hindsight:8888` |
| OpenBot API → Opik | 加入 `openbot-opik`，设置 `OPENBOT_OPIK_API_URL=http://opik-frontend:5173/api/` |
| Worker → Flexprice | [Flexprice 用量对账](../docs/flexprice.md) |

Infisical 首位管理员通过服务器回环地址初始化。当前公网反代限制首次管理员注册。可用已授权的 SSH 隧道把服务器 `127.0.0.1:18082` 转发到本机后进入初始化页面。初始化后建立项目和只读 Universal Auth 机器身份。维护 Compose 时，按部署流程将读取的值写入私有环境文件，再重建对应服务。[Infisical 机器身份和同步说明](../infisical/README.md)

## 4. 配置公网登录

1. 在所用登录源注册 OAuth Web 客户端。Google 的回调地址为 `https://openbot.persaas.cn/api/auth/callback/google`。Microsoft 或 Okta 的变量和回调地址见 [仓库环境变量样例](../../.env.example)。
2. 在 OpenBot API 的私有环境文件中填写 `INITIAL_ADMIN_EMAILS`。使用 Google 时，填写 `GOOGLE_OAUTH_CLIENT_ID` 和 `GOOGLE_OAUTH_CLIENT_SECRET`。用 `openssl rand -base64 32` 生成 `BETTER_AUTH_SECRET`。
3. 设置 `OPENBOT_SINGLE_USER=false`。将 `OPENBOT_PUBLIC_URL`、`BETTER_AUTH_URL` 和 `TRUSTED_ORIGINS` 均设为 `https://openbot.persaas.cn`。
4. 用 `docker compose up -d --no-deps --wait server` 应用配置。先从服务器检查 `/health` 返回 200，再确认匿名用户无法访问需要登录的功能。

## 5. 配置 DNS 和 OpenResty

在 DNSPod 的 `persaas.cn` 区域添加所需的 A 记录，目标为 `129.28.39.52`。现有记录正确时直接保留。下表是反代的上游地址，适用于本机 OpenResty 可访问宿主机回环端口的部署。

| 主机记录 | 1Panel 反代地址 |
| --- | --- |
| `openbot` | `http://127.0.0.1:18001` |
| `infisical` | `http://127.0.0.1:18082` |
| `openobserve` | `http://127.0.0.1:15080` |
| `bifrost` | `http://127.0.0.1:18080`，保留现有访问限制 |

1. 在两台 DNSPod 权威服务器上确认目标 A 记录。命令示例为 `dig @lager.dnspod.net openbot.persaas.cn A +short`。
2. 在 1Panel 的 **网站 → 创建 → 反向代理** 选择域名和上游。已有 OpenResty 站点时在原配置上调整，避免一个域名出现两份站点配置。
3. 签发或选择覆盖域名的证书。为 OpenBot 和 Bifrost 关闭响应缓冲和缓存，保留流式响应所需的超时及连接设置。检查 OpenResty 配置并重载。
4. Hindsight、Opik、SPIRE、Agent 和数据库继续使用内网连接。OTel Collector 采集端口留在私有网络。Infisical 的应用内部站点地址应与 HTTPS 域名一致。

## 6. 逐项验收

```sh
curl -fsS https://openbot.persaas.cn/health
curl -fsS https://infisical.persaas.cn/api/status
curl -fsS https://openobserve.persaas.cn/healthz
```

1. 在浏览器用管理员身份登录 OpenBot，再开无痕窗口确认普通访客需要登录。用 General Assistant 发送一条测试消息，确认收到完整流式回复。使用 Agent 工具时，再测试一次工具调用及回调。
2. 搜索本次运行 ID，确认 Opik 能读回追踪。生成带标识的审计事件，在 OpenObserve 查询到同一事件。若启用了记忆，测试写入、召回和撤回。
3. 为 Flexprice 准备零价用量对账订阅。投递一条用量事件，核对数量和金额，再确认重复投递没有新增记录。
4. 用 Infisical 机器身份读取一项无敏感内容的测试配置。确认应用重新加载配置后可以读到新值。

排查 `502` 时，先在服务器用 `curl` 检查上游，再检查 OpenResty 网络。排查模型 `401` 时，在私有命令环境验证所选接口的对应凭据。排查 DNS 时，先查询权威服务器，再检查本机解析缓存。保留证书校验。

## 7. 维护和恢复

- 修改 Compose 或环境变量后，运行 `docker compose config --quiet`，再用 `docker compose up -d <服务名>` 应用变更。用 `docker compose logs --tail 80 <服务名>` 检查启动结果。
- 备份 Compose、私有环境文件、数据库和持久卷。回退应用版本前检查数据库迁移兼容性。需要恢复数据库时，先备份当前数据，再用匹配版本的快照恢复。数据卷由部署保留。
- 登记证书续期任务并检查续期时的 OpenResty 重载。
- 确认 `/opt/openbot-server` 的配置已安全备份后，清理 `/root/openbot-deploy/stage/openbot-bundle.tar.gz` 的临时副本。若 `/root/.ssh/authorized_keys` 中仍有末尾标记 `openbot-server-stage-transfer` 的过期条目，只移除该条目。保留其他登录密钥。
