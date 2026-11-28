# 平台配置资源

第一次安装使用[Linux 安装指南](../README.md)与 `deploy/deploy.sh`。本目录由安装器调用，面向维护配置的开发者，不是第二条新手安装路径。

## 文件归属

| 目录或文件 | 职责 |
| --- | --- |
| `config/` | 生成的私有配置和运行目录，被 Git 忽略 |
| `.env.example` | 安装器内部设置的默认值，普通用户无需逐项填写 |
| `docker-compose.yml` | 共用 PostgreSQL、MySQL、Redis Sentinel、RustFS、ZooKeeper、ClickHouse |
| `apps/` | 每个应用的集中连接、凭据注入和网络 |
| `postgres/` | 可重复执行的独立数据库、账号和扩展初始化 |
| `redis/` | 主从与 Sentinel 启动，保留故障切换重写后的配置 |
| `rustfs/` | bucket、CORS、应用专用服务账号与 bucket 权限 |
| `clickhouse/` | Opik 集群、ZooKeeper 连接和用户设置 |
| `.env.flexprice.example` | 未来 Flexprice 扩展的认证与加密配置模板 |
| `verify.py` | 无服务变更的 Compose 连接契约检查 |
| `smoke-postgres.py` | 临时容器内的重复初始化、权限和 vector 写入验收 |
| `smoke-rustfs.py` | 临时实例内的账号重复初始化、上传下载与跨 bucket 拒绝验收 |
| `smoke-redis.py` | 临时主从与 Sentinel 故障切换验收 |

详细设计见[集中部署方案](../centralized-deployment-plan.md)，故障处理见[排错手册](../docs/troubleshooting.md)。

## 私有配置归属

`platform.py` 只向用户询问 `.env.user` 的四个字段。其余字段由安装器保存并生成各进程自己的输入文件。

| 文件 | 内容 |
| --- | --- |
| `config/.env.user` | 邮箱、模型 API 地址、模型名、API key |
| `config/.env` | 共享服务密码、内部地址、镜像名与端口 |
| `config/.env.server` | 主 API 设置和普通业务数据库外的应用配置 |
| `config/.env.agents` | 模型与 Agent 回调、浏览器令牌 |
| `config/.env.worker` | Worker 扩展设置，首次生成为空 |

数据库管理凭据仅注入数据库初始化与一次性业务迁移容器。API 与 Worker 使用普通业务账号，技能目录使用独立只读账号。Collector 使用独立 OpenObserve editor 账号，权限范围见排错手册。Infisical 的自动建管理员脚本与现有 1Panel 包共用。初装时应用配置仍由本地私有文件提供，尚未自动导入 Infisical 或启用其机器身份同步。

Redis 使用同一主从复制组，三个 Sentinel 监控 `openbot-redis`。Infisical 为 DB 0，Opik 为 DB 2，Flexprice 为 DB 3。DB 编号不隔离资源、权限或 Pub/Sub。持久配置保留在各自数据卷，修改环境文件不会覆盖 Redis 已重写的角色与凭据。

RustFS 的 S3 监听端口与对外隧道端口同为 19000，Docker 网络别名为 `s3.localhost`。应用与浏览器使用相同 endpoint，避免预签名 URL 的主机或端口不一致。Bucket 初始化使用管理凭据，Opik 只得到限定 bucket 的账号。

## 高级 Compose 入口

`deploy/compose.sh --central` 仍可直接操作某个组件。默认环境文件位置面向旧的手工集中配置。安装器调用时显式传入配置目录中的环境文件和应用文件路径。

维护安装器生成的实例时，优先使用 `deploy/deploy.sh logs/status/check/stop`，避免漏加载文件。需要自定义目录时，所有命令都使用相同的 `--config-dir`，例如 `./deploy/deploy.sh --config-dir /opt/openbot-config status`。

底层应用资源复用 `deploy/openbot/`、`deploy/bifrost/`、`deploy/openobserve/` 及现有 1Panel 包的配置文件，不复制每个应用的完整配置。修改这些资源后，同时运行配置检查与安装器测试。

## 运行范围

默认安装是 Linux 单机个人版，通过回环端口和 SSH 隧道访问。三个 Redis 副本节点与 Sentinel 都在同一主机上，不能宣称主机级高可用。其余存储也是单实例，跨故障域和多人公网部署另行设计。

Opik 与 Flexprice 暂时分别使用 ClickHouse 26.3 和 24.9。Flexprice 只预留为扩展，不属于默认安装验收。旧独立 Compose、`--local` 和 1Panel 安装包保持旧行为，安装器不会自动迁移或重建已有实例。
