# 1Panel 本地应用商店

> 新集中部署见[Linux 安装指南](../README.md)。本页保留既有部署方式，不会自动迁移数据库、Redis 或对象存储。

[OpenBot 应用包](openbot.tar.gz)运行当前仓库构建的 Web、API 和 Worker 镜像，浏览器由 Agents 应用提供。部署需要 1Panel v2 和 `1panel-network`。先在服务器上构建 Linux amd64 镜像，或填写服务器可拉取的同版本镜像。

```sh
docker build --platform linux/amd64 -f deploy/openbot/Dockerfile -t openbot-server:1panel .
```

此包使用 1Panel 的「本地应用」目录。复制应用包即可加载安装表单。各版本支持的商店入口与自定义仓库设置见 [1Panel 官方文档](https://1panel-dev.github.io/docs/v2/dev_manual/appstore_skills/#8-本地测试)。

## 导入

将 `apps/openbot/` 整个目录复制到服务器 1Panel 数据目录下的 `resource/apps/local/`。默认路径如下。

```text
/opt/1panel/resource/apps/local/openbot/data.yml
/opt/1panel/resource/apps/local/openbot/1.0.3/data.yml
/opt/1panel/resource/apps/local/openbot/1.0.3/docker-compose.yml
```

如果使用打包文件，在服务器上执行以下命令。自定义了 1Panel 数据目录时，替换目标路径。

```sh
tar -xzf openbot.tar.gz -C /opt/1panel/resource/apps/local/
```

进入 **应用商店 → 本地应用**，刷新列表并选择 **OpenBot → 安装**。

此前导入的长名称目录使用旧应用标识，解压新版压缩包不会覆盖它们。清理重复卡片时，将旧目录从 `resource/apps/local/` 移出，再点击 **同步本地应用**。已经安装的实例继续由 **已安装** 页面管理，迁移前先备份数据库和应用数据。

## 填写表单

字段名带「必填」的项目须在安装时提供，可直接使用面板预填值。「启用某服务时必填」的字段按所用服务一起填写。

1. 准备 HTTPS 域名，反向代理上游默认是 `127.0.0.1:18001`。填写管理员邮箱及 Google OAuth 客户端 ID 和密钥，回调地址为 `https://你的域名/api/auth/callback/google`。OpenBot 管理员通过 Google 登录。
2. 选择 1Panel PostgreSQL 实例。新装可使用面板预填的库名、用户名和密码。OpenBot 的加密密钥、会话密钥和 Worker 共享密钥留空时首次启动自动生成。保留 `installation-secrets` 数据卷，迁移既有部署时填原密钥。
3. 先安装 Agents，填写它的 Docker 网络（通常为 `<Agents 容器名>-agents`）。日志采集使用 `openbot-observability`，该网络由 OpenObserve 应用创建，须先安装 OpenObserve。CopilotKit Intelligence 的三个字段一起填写，或全部留空使用内置对话运行时。
4. 按所用服务填写下表。所有服务间地址都以容器可访问的地址为准。首次迁移结束后，访问 `/health`，再用实际域名验证登录和对话。

| 中间件 | OpenBot 安装表单 |
| --- | --- |
| Bifrost | 模型 API 地址（如 `http://openbot-bifrost:8080/v1`）、虚拟密钥、模型名和协议 |
| Agents | LangGraph、Computer、Supervisor 地址及各自令牌。两端复制同一回调令牌，Agents 回调可填写 `http://openbot-api:3001/api/agent-tools/call` |
| Hindsight | API 地址，如 `http://<Hindsight 容器名>:8888`，以及服务启用鉴权时的 API Key |
| Opik | API 地址，如 `http://<Opik 容器名>-backend:8080/`，可填写项目、工作区和 API Key |
| OpenObserve | Collector 日志端点，如 `http://otel-collector:4318/v1/logs`，部署标识与 Collector 一致。可填写 OTLP 请求头和控制台地址 |
| Infisical | 站点地址、项目 ID、环境和 Universal Auth 机器身份。API 启动时读取该环境根路径，表单中已填写的值优先 |
| Redis | 安装 Infisical 或 Opik 时选择 1Panel 托管 Redis。为每个应用准备独立实例，在创建 Redis 时设置独立随机密码，应用安装时复用该密码 |
| SPIRE | 安装 SPIRE 时填 Server 签发的加入令牌。使用独立 Agents 套件时，SPIRE 配置由 Agent/Supervisor 侧管理 |

有初始管理员字段的中间件按各自表单填写。Infisical 新装时填管理员邮箱、密码、名字和组织名称四项，密码至少 14 位。恢复现有实例时可全留空。Infisical 新装时加密密钥和认证密钥留空可自动生成，恢复时填写原值。

### 复用 1Panel 已部署的数据库

下表中的应用使用 1Panel 已管理的数据库实例。新装时由 1Panel 创建专用库和用户。

1. 在应用安装表单选择已有 PostgreSQL 或 MySQL 实例。1Panel 会填入连接主机和端口，随机预填库名、用户名和密码，并在启动容器前建库和建用户。1Panel 2.5.1 的密码默认值带 6 位随机字符，可以覆盖成更长的随机密码。
2. 复用已登记的数据库时，将随机值替换为原库名、用户名和密码。选择登记的远程实例时，其地址和端口也必须对应用容器可达。 [1Panel PostgreSQL 管理文档](https://1panel.cn/docs/v2/user_manual/databases/postgresql/)
3. **数据库密码**填原始值。如果安装表单存在 **URL 编码后的数据库密码**，且原密码含 URI 特殊字符，再填写编码后的值，例如 `@` 填为 `%40`，`%` 填为 `%25`。使用默认随机密码时，该字段可以留空。连接启用了 TLS 的 PostgreSQL 时，按实例要求选择 TLS 模式。

| 带数据库选择器的条目 | 实例 | 安装条件 |
| --- | --- | --- |
| OpenBot | PostgreSQL | 实例需提供 pgvector。1.0.3 首次迁移会创建和删除 `vector` 扩展 |
| Bifrost、Infisical | PostgreSQL | 为每个应用使用独立的库和用户 |
| OpenObserve | PostgreSQL | OpenObserve 将元数据写入 PostgreSQL，日志数据保存在原有数据卷；OTel Collector 随同安装 |
| SPIRE | PostgreSQL | 将服务端数据存入 PostgreSQL；仍须持久化本地密钥和 Agent 数据，并按下文登记加入令牌 |
| Opik | MySQL | 使用 MySQL 8.4。ClickHouse、ZooKeeper 和 MinIO 随同安装 |

Hindsight 1.3.0 自带 PostgreSQL（`pgvector/pgvector:pg17`），默认不使用数据库选择器。要改用 1Panel 实例，把安装表单的「PostgreSQL 主机」填成该实例的容器名：实例需提供 pgvector，复用数据库时确认目标库已启用 `vector` 扩展。1Panel 自带的 PostgreSQL 集群镜像里的 pgvector 按 AVX-512 编译，在没有 AVX-512 的机器上一次向量写入就会让数据库后端崩溃，这种机器请保持默认的自带数据库。

Infisical 和 Opik 在安装表单的「已有 Redis 实例」下拉框中选择 1Panel 管理的 Redis，应用包不再自带 Redis。1Panel 填入 Redis 的容器名和密码，应用通过 `1panel-network` 以端口 6379 连接。Redis 未设密码时，「Redis 密码」留空。密码含 URI 特殊字符时，另填「URL 编码后的 Redis 密码」，编码规则与数据库密码相同。

升级已安装的实例前，先在 1Panel 安装 Redis。旧包自带 Redis 中的数据不会迁移：Opik 的评测任务队列保存在 Redis 中，请在任务处理完后再重建。

Hindsight 和 Opik 将 API 容器接入 `1panel-network`。同一网络中的容器可以访问这些 API，应只在受信任的 1Panel 容器网络上部署。从此前的常规条目迁移时，先备份数据库、应用数据卷和加密密钥，再按各组件的步骤恢复。新安装使用相同的默认端口，切换前请为新实例指定空闲端口或停止旧实例。

1Panel 2.5.1 自动创建的 PostgreSQL 角色带有 `SUPERUSER`。迁移完成或安装中止后，用管理员连接执行 `ALTER ROLE 应用角色 NOSUPERUSER;` 收回权限。数据库会关联到应用安装实例，卸载前备份并检查面板的数据库删除选项。

## 中间件应用包

下表提供每个中间件的独立压缩包。上传所需的包并解压到 1Panel 的本地应用目录后，刷新本地应用列表。条目按 Linux amd64 提供。安装前检查端口占用，从旧实例迁移时请备份原数据。

```sh
# 单独导入 Bifrost
tar -xzf bifrost.tar.gz -C /opt/1panel/resource/apps/local/
```

| 本地应用 | 主机回环端口 | 安装前准备 |
| --- | --- | --- |
| [Bifrost](bifrost.tar.gz) | 18080 | 选择 PostgreSQL 实例，面板预填 Bifrost 初始令牌 |
| [OpenObserve](openobserve.tar.gz) | 15080、14318 | 创建外部观测网络。先配置 OpenObserve 日志流和写入令牌，再开启投递 |
| [Infisical](infisical.tar.gz) | 18082 | 选择 PostgreSQL 和 Redis，并填写初始管理员资料 |
| [Hindsight](hindsight.tar.gz) | 18888、19999 | 准备本地嵌入和重排模型所需的存储 |
| [Opik](opik.tar.gz) | 15173 | 选择 MySQL 和 Redis，面板预填 MinIO 密码。首次安装需等待 MySQL 和 ClickHouse 迁移。此包使用进程执行策略，不启用 Docker-in-Docker |
| [Agents](agents.tar.gz) | 4200、4201、4100、4500 | 在服务器预构建镜像或填写可拉取的镜像标签 |
| [SPIRE](spire.tar.gz) | Docker 内部 | 启动 Server 后生成一次性加入令牌，填入安装实例参数 |

### 准备共享数据库和网络

使用相应组件前，在服务器创建各自的专用 Docker 网络。数据库选择器使用 `1panel-network`。如果已有 1Panel 管理的数据库，可以直接选择对应实例。

```sh
docker network inspect openbot-hindsight >/dev/null 2>&1 || docker network create openbot-hindsight
docker network inspect openbot-opik >/dev/null 2>&1 || docker network create --internal openbot-opik
docker network inspect openbot-spire >/dev/null 2>&1 || docker network create --internal openbot-spire
```

`openbot-observability` 不需手工创建：安装 OpenObserve 应用时由其 Compose 建立为内部网络，须先于 OpenBot 安装。

配置日志流、保留期和采集授权见[观测运维步骤](../operations.md#openobserve-持续日志采集)。表单中授权头保留 `Basic ` 前缀。主应用通过 `openbot-observability` 向 `http://otel-collector:4318/v1/logs` 投递，主应用需加入该网络。

### 接入可选服务

- 在主应用的模型地址填 `http://openbot-bifrost:8080/v1`，并填写 Bifrost 虚拟密钥及模型名。该地址通过 1Panel 网络访问 Bifrost 的 registry proxy。
- Hindsight 的控制台用安装表单中的「控制台访问密钥」登录；Hindsight 的 API 和 Opik 的 API 默认没有登录门禁。应用包保留它们各自的私有 Docker 网络与宿主机回环端口。使用时把 OpenBot API 加入对应的 `openbot-hindsight` 或 `openbot-opik` 网络。配置项见[可选服务接入](../operations.md#hindsight-和-opik)。
- Infisical 的密钥生成和机器身份配置见 [Infisical 说明](../infisical/README.md)。Worker 对账见 [Flexprice 用量对账](../docs/flexprice.md)。
- 需要独立 Agent 时，从仓库根目录运行下列构建命令。使用另一台主机构建时，将镜像推到 1Panel 主机可以拉取的镜像仓库，并在表单填写相应镜像地址。

```sh
docker build -f agent-bot/Dockerfile -t openbot-agent-bot:1panel .
docker build -f agent-langgraph/Dockerfile -t openbot-agent-langgraph:1panel .
docker build -f agent-computer/Dockerfile -t openbot-agent-computer:1panel .
docker build -f supervisor/Dockerfile -t openbot-supervisor:1panel .
```

Agent 保持独立服务令牌。Supervisor 创建的 Computer 使用该安装实例的私有网络。OpenBot 需要访问 Supervisor 或动态 Computer 时，将 API 加入同一网络并填写对应地址。Supervisor 和 SPIRE Agent 需要挂载 Docker socket。

SPIRE Server 健康后，执行 `docker exec <SPIRE主容器名> /opt/spire/bin/spire-server token generate`，将返回的一次性令牌填到 SPIRE 安装实例的参数中并启动 Agent。保留 SPIRE 数据卷。将 Supervisor 接入时，还需共享 SPIRE 的工作负载与管理套接字。Agents 应用包默认独立运行。

## 在 1Panel 创建网站反向代理

在应用所在节点安装并启动应用。先从该节点确认上游端口能响应，再创建网站。下表使用默认端口和示例域名。若安装时改过端口，填入该实例的实际端口。

| 应用 | 示例主域名 | 代理地址 | 应用配套设置 |
| --- | --- | --- | --- |
| OpenBot | `openbot.example.com` | `http://127.0.0.1:18001` | 将 `OPENBOT_PUBLIC_URL` 及 Google OAuth 回调设为实际 HTTPS 域名。保留流式响应，关闭代理缓存和缓冲 |
| Bifrost | `bifrost.example.com` | `http://127.0.0.1:18080` | 保留模型 API 的流式响应，关闭代理缓存和缓冲。模型客户端在网站地址后加 `/v1` |
| OpenObserve | `observe.example.com` | `http://127.0.0.1:15080` | 此地址用于 Web 控制台，Collector 继续通过内部网络接收日志 |
| Infisical | `infisical.example.com` | `http://127.0.0.1:18082` | 将 `SITE_URL` 设为实际 HTTPS 地址 |
| Hindsight 控制台 | `hindsight.example.com` | `http://127.0.0.1:19999` | 登录时输入安装表单中的「控制台访问密钥」 |
| Hindsight | 内部访问域名 | `http://127.0.0.1:18888` | API 默认无登录门禁，仅通过受限网络或带访问控制的站点使用 |
| Opik | 内部访问域名 | `http://127.0.0.1:15173` | 代理前端入口，前端会转发 API。默认无登录门禁，仅通过受限网络或带访问控制的站点使用 |

Agents、SPIRE、数据库、Redis 和 Collector 采集端口用于服务间通信，继续通过 Docker 网络或私有网络访问。

1. 将要使用的域名解析到应用所在的服务器。
2. 在同一节点打开 **网站 → 创建 → 反向代理**。填写 **主域名**、**代号**和表中的**代理地址**。启用 HTTPS 并选择对应证书。 [1Panel 创建反向代理网站](https://1panel-dev.github.io/docs/v2/user_manual/websites/website_create/#3-反向代理)
3. 如果 OpenResty 使用宿主机网络，使用表中的回环地址。如果使用容器网络，改用从 OpenResty 容器能访问的应用网络地址。应用端口可继续绑定回环地址。
4. 从客户端用 HTTPS 打开网站。对 OpenBot，检查 `/health`、OAuth 登录和一次流式对话。如果出现 `502`，先确认应用已启动，再从 OpenResty 所在的网络检查上游地址和端口。
