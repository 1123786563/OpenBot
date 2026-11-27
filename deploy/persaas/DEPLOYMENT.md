# Persaas 两机部署记录

核验日期：2026-11-28。此目录记录已部署实例，不是通用安装器。私密环境文件保存在服务器 `/opt/persaas/`，不进入 Git。

## 服务位置

| 主机 | 配置 | 服务 |
| --- | --- | --- |
| 129.28.39.52 | 8 核、16GB、200GB 系统盘 | 1Panel OpenResty、pgvector PostgreSQL 18、Redis 8、ClickHouse 26.11、Casdoor 4.31、Infisical 0.167.16、OpenObserve 1.2.0、Bifrost 2.6.0、Opik 2.3.4、Lago 1.57.0（含独立 PG15）、MySQL 8.4.11、Flexprice 专用 Kafka 3.9；Docker Temporal 1.26.2、Flexprice 2.1.52 与控制台 2.0.22 |
| 124.221.110.188 | 4 核、4GB、40GB 系统盘 | OpenBot API、Worker、受限 SSH 服务隧道 |
| 43.136.78.18 | 既有实例 | CubeSandbox；本次不修改该服务器 |

OpenBot 镜像为 `openbot-server:persaas-20261128`，从本次工作区构建为 Linux amd64。Flexprice 从官方 `v2.1.52` 源码构建；运行镜像增加 `internal/config -> config` 链接，修复上游镜像缺少 RBAC 相对路径的问题，见 `Flexprice.Dockerfile`。

主站 `https://www.persaas.cn/`、登录服务 `https://casdoor.persaas.cn/`、沙箱 API `https://sandboxes.persaas.cn/` 均由 129.28.39.52 的 1Panel OpenResty 代理。另有 `https://infisical.persaas.cn/` 和 `https://openobserve.persaas.cn/`；新增 Bifrost、Opik、Lago、Lago API，共九个站点均使用有效 Let's Encrypt 证书。

## 网络与权限

两台机器位于不同私网，不能直接使用各自的私网 IP 互通。124.221.110.188 上的 `persaas-data-link.service` 建立 SSH 加密隧道：

- 应用容器经 `172.30.96.1:15432` 访问数据节点回环地址的 PostgreSQL 5432。
- 数据节点的 `127.0.0.1:18001` 经反向隧道访问应用节点回环地址的 18001。
- 服务专用公钥只允许上述端口转发，不允许执行命令、PTY、代理转发或任意端口转发。它与本次操作员临时部署公钥不同。
- 应用节点只向 `persaas-apps` 容器子网开放隧道数据库端口，没有把数据库监听到公网。
- PostgreSQL 分离 OpenBot、Casdoor、Flexprice、Temporal、Infisical 的账号和数据库；迁移完成后撤销应用角色的超级用户权限。
- Flexprice 使用独立 ClickHouse 账号和 `flexprice` 数据库、Redis database 3，以及 `persaas_` 前缀的 Kafka topic。topic 保留七天，单节点复制因子为 1。

## Kafka 与 1Panel

现有 Kafka 4.0 保留原状。Flexprice 的旧 Sarama 消费组协议与其不兼容，会触发 `JoinGroup unsupported version 1` 和高 CPU 重连。

Kafka 3.9 的远程应用包下载返回 426/403，故通过此目录下的 `1panel/persaas-kafka` 本地应用包安装。该包复用现有 Bitnami KRaft 配方，固定为 `bitnamilegacy/kafka:3.9.0`，使用独立数据目录。它仍由 1Panel 管理，不覆盖 Kafka 4.0 数据。

## 已验证

- 主站、Casdoor OIDC discovery、CubeSandbox `/health` 均通过标准 HTTPS 验证。
- 匿名 `/api/me` 返回 401。
- Casdoor 管理员初始化使用随机密码；Persaas 用户完成授权码登录，OpenBot 会话和受保护的 Bot 列表访问成功。
- PostgreSQL pgvector 向量运算成功，OpenBot 与 Flexprice 的数据库迁移完成。
- Flexprice ClickHouse 基础表、后续迁移及 Kafka topic 初始化完成，消费组为 Stable，Temporal 工作流成功执行。
- 已配置的模型 API 最小请求成功。
- 五个 PostgreSQL 备份逐一恢复到临时数据库成功；临时恢复库已移除。应用迁移在撤销超级用户权限后重复执行成功。

Infisical 的 prod 项目集中保存运行配置与中间件恢复归档。API、Worker 通过 SDK 在启动时加载；Flexprice、Temporal 通过受限机器身份导出配置。实际登录和聊天验收通过，详见 [TEST-RESULTS.md](TEST-RESULTS.md)。

## 备份范围

`persaas-postgres-backup.timer` 每天 04:15（主机时区）备份八个 PostgreSQL 数据库、Opik MySQL、Lago 加密密钥、角色及部署私密配置。首份备份已复制到 124.221.110.188；后续每日备份目前仅落在数据节点，需要继续配置自动异机复制及保留策略。

备份不包含 RustFS 对象、ClickHouse 明细数据、Kafka 日志和 Redis 持久化文件。它不是整个平台的完整灾备方案。

## 尚未完成

- CubeSandbox `/templates` 和 `/sandboxes` 返回 401，待提供现有 API Key。浏览器模板、持久卷和数据通道尚未验收，OpenBot 暂未启用 CubeSandbox 浏览器提供者。
- Redis 当前按用户于 2026-11-28 确认的经济方案保留单实例，按应用分 DB；Sentinel 留待后续升级，不作为本阶段验收阻塞项。当前没有 Redis 自动故障切换，两台跨地域机器也不构成三个独立故障节点。
- Flexprice 服务已运行，但仓库仍使用 Lago 用量投递代码。套餐、用量投递、对账与收款没有完成替换。
- Casdoor 注册暂未开放，只创建测试管理员。新增用户需由管理员在 Casdoor 中管理。
- Hindsight 等配套服务未启用；Opik 自动追踪与 OpenObserve 自动日志采集尚未完成业务验收。
- 当前不提供全平台高可用，也未验证任一主机故障后业务仍可用。

Bifrost、Opik、Lago 的运行拓扑与配置归档方式见 [中间件指南](extensions/README.md)。主站模型已切至 Bifrost，并重新通过实际登录和聊天验收。
