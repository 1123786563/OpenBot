# 1Panel 本地应用商店

[OpenBot 应用包](openbot.tar.gz)使用官方 OpenBot 1.0.3 镜像，提供 Web、API 和浏览器，并连接 1Panel 管理的 PostgreSQL。镜像支持 Linux amd64。部署需要已有的 1Panel v2 和 `1panel-network`。

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

1. 为 OpenBot 准备 HTTPS 域名。将已有 HTTPS 入口的上游指向本机 `127.0.0.1:18001`，或使用表单指定的端口。公开地址填写纯 HTTPS 源地址，例如 `https://openbot.example.com`。
2. 在 Google OAuth 客户端登记回调 `https://openbot.example.com/api/auth/callback/google`，使用实际域名。填写客户端 ID、密钥和初始管理员邮箱。
3. 分别执行一次 `openssl rand -base64 32`，生成加密密钥和会话签名密钥。保管好加密密钥，恢复备份时需要使用原值。
4. 填写模型 API 密钥。使用 Bifrost 时，填虚拟密钥、OpenBot 容器可访问的兼容 API 地址和模型名。连接 OpenAI 时，可留空模型 API 地址。
5. 填写 CopilotKit Intelligence 的 HTTP API 地址、WebSocket 地址和项目 API 密钥。当前发布版本启动时需要这三项。
6. 按下文选择 PostgreSQL 实例并填写专用数据库的凭据。
7. 查看应用日志，确认首次迁移完成。访问 `https://openbot.example.com/health`，再通过实际域名检查 Web 登录与一次对话。

工作区和浏览器配置存放在 Docker 命名卷中。迁移时同时备份 PostgreSQL 数据库、应用数据卷和加密密钥。

### 复用 1Panel 已部署的数据库

下表中的应用需要提前准备对应数据库。

1. 在 1Panel 的 **数据库** 页面找到已部署的实例，为应用单独创建数据库和用户。使用已有库时，准备该库的名称、用户名和密码。数据库用户需要有权限在自己的库中建表和迁移。
2. 在应用安装表单的 **已有 PostgreSQL 实例** 或 **已有 MySQL 实例** 下拉框中选择实例。1Panel 会填入连接主机和端口。填写库名、用户和密码。1Panel 安装的数据库通过 `1panel-network` 访问，选择登记的远程实例时，其地址和端口也必须对应用容器可达。 [1Panel PostgreSQL 管理文档](https://1panel.cn/docs/v2/user_manual/databases/postgresql/)
3. 密码字段标有「特殊字符需 URL 编码」时，按 URI 规则编码密码里的特殊字符，例如 `@` 填为 `%40`，`%` 填为 `%25`。十六进制密码可以直接填写。连接启用了 TLS 的 PostgreSQL 时，按实例要求选择 TLS 模式。

| 带数据库选择器的条目 | 实例 | 安装条件 |
| --- | --- | --- |
| OpenBot | PostgreSQL | 实例需提供 pgvector。1.0.3 首次迁移会创建和删除 `vector` 扩展，空库初始化时临时给该应用的专用角色授予 `SUPERUSER`，安装成功后立即撤销 |
| Hindsight | PostgreSQL | 实例需提供 pgvector。先由管理员在目标库执行 `CREATE EXTENSION IF NOT EXISTS vector;` |
| Bifrost、Infisical | PostgreSQL | 为每个应用使用独立的库和用户 |
| Lago | PostgreSQL | 使用 PostgreSQL 15 或更新版本，且实例已安装 `pg_partman`。1.57.0 空库初始化需要临时授予专用角色 `SUPERUSER`，安装成功后立即撤销 |
| OpenObserve | PostgreSQL | OpenObserve 将元数据写入 PostgreSQL，日志数据保存在原有数据卷；OTel Collector 随同安装 |
| SPIRE | PostgreSQL | 将服务端数据存入 PostgreSQL；仍须持久化本地密钥和 Agent 数据，并按下文登记加入令牌 |
| Opik | MySQL | 使用 MySQL 8.4。ClickHouse、Redis、ZooKeeper 和 MinIO 随同安装 |

Hindsight 和 Opik 将 API 容器接入 `1panel-network`。同一网络中的容器可以访问这些 API，应只在受信任的 1Panel 容器网络上部署。从此前的常规条目迁移时，先备份数据库、应用数据卷和加密密钥，再按各组件的步骤恢复。新安装使用相同的默认端口，切换前请为新实例指定空闲端口或停止旧实例。

OpenBot 和 Lago 空库初始化时，用管理员连接执行 `ALTER ROLE 应用角色 SUPERUSER;`，安装完成或中止后执行 `ALTER ROLE 应用角色 NOSUPERUSER;`。Lago 的建库脚本会自行安装扩展到目标库。OpenBot 的 `migrate` 服务成功退出后才启动 API。

## 中间件应用包

下表提供每个中间件的独立压缩包。上传所需的包并解压到 1Panel 的本地应用目录后，刷新本地应用列表。条目按 Linux amd64 提供。安装前检查端口占用，从旧实例迁移时请备份原数据。

```sh
# 单独导入 Bifrost
tar -xzf bifrost.tar.gz -C /opt/1panel/resource/apps/local/
```

| 本地应用 | 主机回环端口 | 安装前准备 |
| --- | --- | --- |
| [Bifrost](bifrost.tar.gz) | 18080 | 创建 `bifrost` 数据库和角色，填写其凭据和 Bifrost 初始令牌 |
| [OpenObserve](openobserve.tar.gz) | 15080、14318 | 创建外部观测网络。先配置 OpenObserve 日志流和写入令牌，再开启投递 |
| [Infisical](infisical.tar.gz) | 18082 | 生成加密密钥、会话密钥和十六进制 PostgreSQL 密码 |
| [Hindsight](hindsight.tar.gz) | 18888 | 准备本地嵌入和重排模型所需的存储 |
| [Opik](opik.tar.gz) | 15173 | 生成 MinIO 密码，首次安装需等待 MySQL 和 ClickHouse 迁移。此包使用进程执行策略，不启用 Docker-in-Docker |
| [Lago](lago.tar.gz) | 13001、13000 | 创建数据库时可由 1Panel 生成密码，再填入安装表单。新装时留空 Rails、RSA 和加密参数可在首次启动时生成 |
| [Agents](agents.tar.gz) | 4200、4201、4100、4500 | 在服务器预构建镜像或填写可拉取的镜像标签 |
| [SPIRE](spire.tar.gz) | Docker 内部 | 启动 Server 后生成一次性加入令牌，填入安装实例参数 |

### 准备共享数据库和网络

使用相应组件前，在服务器创建各自的专用 Docker 网络。数据库选择器使用 `1panel-network`。如果已有 1Panel 管理的数据库，可以直接选择对应实例。

```sh
docker network inspect openbot-hindsight >/dev/null 2>&1 || docker network create openbot-hindsight
docker network inspect openbot-opik >/dev/null 2>&1 || docker network create --internal openbot-opik
docker network inspect openbot-spire >/dev/null 2>&1 || docker network create --internal openbot-spire
```

安装观测组之前创建外部网络。

```sh
docker network inspect openbot-observability >/dev/null 2>&1 \
  || docker network create --internal openbot-observability
```

配置日志流、保留期和采集授权见[观测运维步骤](../operations.md#openobserve-持续日志采集)。表单中授权头保留 `Basic ` 前缀。主应用通过 `openbot-observability` 向 `http://otel-collector:4318/v1/logs` 投递，主应用需加入该网络。

### 接入可选服务

- 在主应用的模型地址填 `http://openbot-bifrost:8080/v1`，并填写 Bifrost 虚拟密钥及模型名。该地址通过 1Panel 网络访问 Bifrost 的 registry proxy。
- Hindsight 和 Opik 的 API 默认没有登录门禁。应用包保留它们各自的私有 Docker 网络与宿主机回环端口。使用时把 OpenBot API 加入对应的 `openbot-hindsight` 或 `openbot-opik` 网络。Lago 的用量投递需要独立 Worker，连接 `openbot-lago`。配置项见[可选服务接入](../operations.md#hindsightopik-和-lago)。
- Infisical 的密钥生成和机器身份配置见 [Infisical 说明](../infisical/README.md)。Lago 的密钥要求和用量订阅见[用量投递说明](../../docs/billing-lago-usage-export.md)。
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
| Lago 前端 | `lago.example.com` | `http://127.0.0.1:13001` | 将 `LAGO_FRONT_URL` 设为此 HTTPS 地址 |
| Lago API | `lago-api.example.com` | `http://127.0.0.1:13000` | 将 `LAGO_API_URL` 设为此 HTTPS 地址 |
| Hindsight | 内部访问域名 | `http://127.0.0.1:18888` | API 默认无登录门禁，仅通过受限网络或带访问控制的站点使用 |
| Opik | 内部访问域名 | `http://127.0.0.1:15173` | 代理前端入口，前端会转发 API。默认无登录门禁，仅通过受限网络或带访问控制的站点使用 |

Agents、SPIRE、数据库、Redis 和 Collector 采集端口用于服务间通信，继续通过 Docker 网络或私有网络访问。

1. 将要使用的域名解析到应用所在的服务器。
2. 在同一节点打开 **网站 → 创建 → 反向代理**。填写 **主域名**、**代号**和表中的**代理地址**。启用 HTTPS 并选择对应证书。 [1Panel 创建反向代理网站](https://1panel-dev.github.io/docs/v2/user_manual/websites/website_create/#3-反向代理)
3. 如果 OpenResty 使用宿主机网络，使用表中的回环地址。如果使用容器网络，改用从 OpenResty 容器能访问的应用网络地址。应用端口可继续绑定回环地址。
4. 从客户端用 HTTPS 打开网站。对 OpenBot，检查 `/health`、OAuth 登录和一次流式对话。如果出现 `502`，先确认应用已启动，再从 OpenResty 所在的网络检查上游地址和端口。
