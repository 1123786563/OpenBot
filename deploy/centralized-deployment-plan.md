# OpenBot 中间件集中部署方案

核对日期：2026-11-27。本文记录目标架构、兼容性结论和迁移验收条件。当前仓库配置尚未按本方案改造，现有服务器也未执行迁移。

## 已确认的部署决策

- 共用 PostgreSQL 服务，各应用使用独立数据库、账号和权限。
- 共用 Redis 主从复制组，使用 Sentinel 自动故障转移，各应用分配不同 database。
- S3 对象存储统一采用 RustFS，替换 Opik 自带 MinIO。
- 计费目标采用 Flexprice，提前规划 Kafka、ClickHouse、Redis、Temporal 及其 PostgreSQL 存储。Lago 后续会被替换，本次不规划其依赖、Sentinel 适配或迁移。
- ClickHouse 以 Opik 和 Flexprice 共用为目标，完成版本和迁移兼容验证后再合并。
- 应用容器保持独立部署和升级。集中部署指共用基础服务，不要求所有服务运行在一台机器上。

## 服务与依赖清单

以 `deploy/1panel/apps/` 当前安装包为现状依据。独立 Compose 与 1Panel 包存在差异，迁移时以实际安装实例为准。

| 应用 | 数据库及其他持久依赖 | 目标部署方式 |
| --- | --- | --- |
| OpenBot API、Worker、迁移任务 | PostgreSQL | 共用 PostgreSQL 中的 openbot 库 |
| Bifrost 2.6.0 | PostgreSQL 配置与日志存储 | 共用 PostgreSQL 中的 bifrost 库 |
| Hindsight 1.3.0 | PostgreSQL、pgvector、模型缓存卷 | 验证 pgvector 后合并，验证前保留自带数据库 |
| Opik 2.3.4 | MySQL 8.4、ClickHouse、Redis、对象存储、ZooKeeper | 共用底层服务，保留独立 Java 和 Python 后端 |
| Infisical 0.167.16 | PostgreSQL、Redis、安装密钥 | 独立库，Redis Sentinel DB 0 |
| OpenObserve 1.2.0 包 | PostgreSQL 元数据、本地日志数据卷 | 共用 PostgreSQL，当前保留本地日志存储 |
| OpenTelemetry Collector | 无独立数据库 | 接收运行日志与审计，写入 OpenObserve |
| SPIRE 1.15.1 | Server 使用 PostgreSQL，Agent 有本地状态 | Server 共用 PostgreSQL，Agent 按运行节点部署 |
| Flexprice，规划 | PostgreSQL、Kafka、ClickHouse、Redis、Temporal | API、Consumer、Temporal Worker 分别运行 |
| Temporal，Flexprice 依赖 | PostgreSQL 持久存储与 visibility 存储 | 独立数据库与账号，复用 PostgreSQL 服务 |
| Agent Bot、Computer、LangGraph、Supervisor | 当前包未另声明数据库，具有配置和工作目录卷 | 各自保留工作卷，不与数据库数据卷混用 |

目标底层共 8 类服务：PostgreSQL、MySQL、Redis、ClickHouse、Kafka、Temporal、RustFS、ZooKeeper。Sentinel 属于 Redis 高可用拓扑，不是第九种数据库。服务类别数不等于进程、容器或物理节点数。

## 数据库合并边界

| 服务 | 合并结论 | 条件 |
| --- | --- | --- |
| PostgreSQL | 优先合并 | 每个应用独立库和账号，独立迁移与备份恢复 |
| MySQL | 保留一套 | Opik 状态存储使用 MySQL，不能直接改接 PostgreSQL |
| Redis | 共用一个主从复制组 | Sentinel、database 分配、全局 noeviction、客户端故障转移验收 |
| ClickHouse | 有条件合并 | Opik 与 Flexprice 独立库和账号，验证双方 schema、集群配置及版本 |
| RustFS | 共用一套 | 应用分 bucket 和凭据，验证实际使用的 S3 操作 |
| Kafka | 共用一套 KRaft 服务 | topic、consumer group、ACL 和保留期按业务划分 |
| Temporal | 共用一套服务 | Flexprice 使用专用 namespace 和 task queue，存储独立 |
| ZooKeeper | 暂保留一套 | 当前 Opik ClickHouse 配置需要，Kafka KRaft 不需要它 |

PostgreSQL 目标基线为 PG17，最终版本在应用迁移测试后锁定。Hindsight 需要可在目标 CPU 上运行的 pgvector。当前包记录的 1Panel 集群镜像 pgvector 使用 AVX-512，在不支持的主机上会导致数据库后端崩溃，因此不能直接把 Hindsight 接入现有共享实例。扩展安装、初始化所需权限和应用日常权限分开管理。

推荐库名为 `openbot`、`bifrost`、`hindsight`、`infisical`、`openobserve`、`spire`、`flexprice`、`temporal`、`temporal_visibility`。Temporal 最终库名以锁定版本的配置和初始化工具为准。

当前 Opik 固定 ClickHouse `26.3.62.3-alpine`，Flexprice 官方 Compose 示例使用 `24.9-alpine`。两者尚未完成共用实例验收。目标实例必须保留 Opik 所需的 ZooKeeper、集群名及复制表配置，并通过两边的迁移、写入、聚合和升级测试。验证前分别部署。

## Redis Sentinel 支持核对

下表是上游源码与配置核对结果，不是已在本项目执行的故障转移测试。库支持 Sentinel 不代表应用的全部连接都已正确接入。

| 应用与核对版本 | Sentinel 支持 | 非零 database 支持 | 部署结论 |
| --- | --- | --- | --- |
| Infisical v0.167.16 | 原生支持，ioredis Sentinel | Sentinel 构造分支未传 db，也未暴露对应配置，使用默认 DB 0 | 分配 DB 0，清除原 REDIS_URL，改配 Sentinel 变量 |
| Opik 2.3.4 Java 后端 | 原生支持，Redisson Sentinel | 从 REDIS_URL 路径读取 | 与 Python 后端同步配置 |
| Opik 2.3.4 Python 后端与 RQ | 原生支持，redis-py Sentinel | 从 REDIS_URL 路径读取 | 与 Java 后端共用同一个 DB |
| Flexprice main，2026-11-27 核对 | 原生支持，go-redis NewFailoverClient | 客户端选项传入 RedisConfig.DB | 部署前锁定包含该实现的 commit 或 release |

其他应用在当前安装包中没有直接 Redis 依赖，无需为了集中部署给它们新增 Redis。

### database 分配

| DB | 使用者 | 说明 |
| --- | --- | --- |
| 0 | Infisical | 原生 Sentinel 模式使用默认 DB，禁止其他应用误用 |
| 1 | 预留 | 不分配给默认连接 |
| 2 | Opik | Java、Python、RQ 保持一致 |
| 3 | Flexprice | API、Consumer、Worker 保持一致 |
| 4–15 | 预留 | 新增应用登记后使用 |

不同 database 只隔离键空间，不隔离内存、CPU、持久化、故障和管理命令。Redis Pub/Sub 频道不按 database 隔离，需要应用级频道前缀。database 也不是账号权限边界，不能只靠 DB 编号隔离不互信的租户。

### Sentinel 拓扑与统一设置

- 一个 master，两个 replica，三个 Sentinel。Sentinel master set 名统一为 `openbot-redis`，quorum 为 2。
- 三个 Sentinel 分布到三个独立故障域。Redis 数据节点同样分散，单机运行多个容器只提供进程级冗余。
- 数据端口 6379，Sentinel 端口 26379，仅可信内网可达。所有 announced 地址必须能从应用容器访问。
- Redis 数据节点凭据与 Sentinel 凭据分开管理，配置主从复制认证。
- 所有数据节点启用 AOF，基线使用 `appendfsync everysec`，并保留恢复备份。统一采用 `maxmemory-policy noeviction`，内存满时写入可能失败，需要监控和容量余量。
- Sentinel 使用可写持久配置，保留运行时重写的拓扑。重建时不能反复覆盖成旧 master。
- 所有客户端写入当前 master。Flexprice 初期关闭副本读，避免计费缓存读取复制延迟数据。
- Redis 异步复制与 Sentinel 不保证已确认写入零丢失。计费事实保留在权威持久存储中，任务和事件处理保持幂等及可重放。

### 应用接入配置

Infisical 使用 `REDIS_SENTINEL_HOSTS`、`REDIS_SENTINEL_MASTER_NAME`、`REDIS_USERNAME`、`REDIS_PASSWORD`、`REDIS_SENTINEL_USERNAME`、`REDIS_SENTINEL_PASSWORD`。不再设置直连 `REDIS_URL`，因为该配置在客户端构造中优先。TLS 按目标环境设置 `REDIS_SENTINEL_ENABLE_TLS` 并核对数据节点 TLS 行为。

Opik 两个后端都设置 `OPIK_REDIS_SENTINEL_ENABLED=true`、`OPIK_REDIS_SENTINEL_MASTER_NAME=openbot-redis`、`OPIK_REDIS_SENTINEL_NODES` 和 Sentinel 凭据。Sentinel 模式下 `REDIS_URL` 的 host、port 表示首个 Sentinel，路径 `/2` 表示数据节点 DB 2，其中的账号密码属于 Redis 数据节点。附加节点使用相同的 `redis://` 或 `rediss://` scheme。

Flexprice 设置 `FLEXPRICE_REDIS_SENTINEL_MASTER_NAME`、`FLEXPRICE_REDIS_SENTINEL_ADDRS`、`FLEXPRICE_REDIS_SENTINEL_USERNAME`、`FLEXPRICE_REDIS_SENTINEL_PASSWORD`，以及数据节点凭据和 `FLEXPRICE_REDIS_DB=3`。地址列表编码按锁定版本的配置加载器验证。API、Consumer、Worker 使用同一配置。


## RustFS 对象存储

RustFS 是本方案唯一的共享 S3 服务。Opik 当前配置里的 `S3_URL`、访问凭据、bucket 和初始化逻辑需要改为 RustFS。内部服务端 endpoint 与浏览器可访问 endpoint 分别配置，预签名 URL 使用浏览器能够访问且证书有效的域名。

Opik 当前初始化脚本创建 `public` bucket 并设置匿名下载。迁移时先核对实际对象访问方式，再制定 RustFS bucket policy。不能照搬 MinIO 管理命令，也不能直接把对象全部改为私有而不验证前端访问。

各应用使用独立 bucket 和凭据，不向应用分发 RustFS root 凭据。初期明确使用者为 Opik，其他应用仅在启用对应 S3 功能后接入。OpenObserve 当前仍是本地日志模式，不能仅通过新增 RustFS 就视为完成日志对象存储迁移。

验收覆盖上传、下载、删除、对象元数据、Range、CORS、预签名 URL，以及应用实际使用的 multipart 和访问策略。RustFS 官方只承诺支持范围内的 S3 兼容，不能假定所有 AWS S3、MinIO 行为相同。对象迁移通过 S3 API 完成，避免直接复制不同实现的数据目录。

## Flexprice 接入范围

Kafka 使用 KRaft，独立规划 broker 与 controller 的生产拓扑。官方开发 Compose 的单节点、复制因子 1 不作为生产高可用方案。topic、consumer group、事件保留期、重试和死信处理按锁定版本实现登记。

Temporal 使用独立 PostgreSQL 库及专用账号。Temporal UI 和 Kafka UI 是可选管理工具，只向管理网络开放。Temporal namespace、队列和 Worker 版本与 Flexprice 配置一致。

Flexprice 使用独立数据库。OpenBot 的用量导出需要接入 Flexprice，不能只更换 URL。接入验收覆盖客户与价格映射、用量计量、幂等键、事件重放及账单核对。Lago 的历史数据处理和下线安排在后续替换任务中另行制定。

## 网络、持久化与运维

数据库和内部中间件使用私网，公网入口经统一反向代理与 TLS。管理控制台限制在管理网络。跨机器部署不能依赖 Docker 单机 bridge 服务名，需要稳定私网 DNS 和可路由地址。

PostgreSQL、MySQL、ClickHouse、Kafka、Redis、RustFS、ZooKeeper 和应用工作卷各自使用独立持久目录。集中管理备份策略，同时保留按应用恢复的能力。备份写入其他故障域，RustFS 自身的唯一备份不能只存在同一 RustFS 实例里。

Infisical 管理应用凭据。Infisical 自己依赖的数据库、Redis、加密密钥与启动凭据另有离线恢复副本，避免恢复时循环依赖。现有安装密钥在迁移时保持不变。

监控 PostgreSQL 连接及备份、Redis 内存与复制延迟及 Sentinel quorum、ClickHouse 磁盘与查询、Kafka lag、Temporal 待处理任务、RustFS 容量和应用错误率。OpenObserve 日志保留期单独配置，接入 RustFS 不会自动清理日志。

物理机器分配、存储容量、CPU 和内存配额待工作负载与可用服务器清单确认后确定。现阶段不把所有持久服务集中到单一故障域，也不为未测负载给出生产容量保证。

## 实施阶段与验收条件

| 阶段 | 交付内容 | 完成条件 |
| --- | --- | --- |
| 1. 记录现状 | 实际版本、连接、库、卷、凭据位置和备份清单 | 能恢复现有实例，确认与仓库包的差异 |
| 2. 建立底层服务 | PostgreSQL、MySQL、Redis Sentinel、RustFS；规划 Kafka、Temporal | 备份恢复、权限和内网连通通过 |
| 3. 接入 Redis | 修改安装包，配置 DB、Sentinel 和全部进程 | 不重启应用触发主从切换后，业务恢复且 DB 不串用 |
| 4. 迁移现有应用 | 数据库、对象、应用配置分批迁移 | 每个应用先验收再迁移下一个，旧副本保留回退窗口 |
| 5. 接入 Flexprice | Kafka、Temporal、计费集成 | 重复事件、重放、故障恢复及账单对账通过 |
| 6. 合并 ClickHouse | 锁定共同版本，迁移独立库 | Opik 与 Flexprice 迁移、查询、写入及资源竞争验收通过 |
| 7. 退出重复服务 | MinIO、重复数据库 | 无旧连接、队列清空、归档与回退窗口完成 |

Redis 验收必须覆盖 Infisical 后台任务、Opik Java 与 Python 评测任务、Flexprice 三类进程。通过 `CLIENT LIST`、各 DB 的键和应用操作确认编号，不只检查 PING。测试主节点失联、Sentinel 单节点失联、应用启动时一个 seed 不可达、旧 master 回归，以及认证失败。数据库隔离测试还需核对 Pub/Sub 频道。

每次迁移在切换前完成数据同步和备份，切换时暂停相关写入并完成最后同步，验收后再开放写入。回退要先确定唯一写入方并处理切换后的新增数据，不能直接把连接改回过期副本。

## 待实施事项

- 修改 1Panel 表单与 Compose，提供 Sentinel seed、master set、认证和 DB 配置。
- Infisical 使用 DB 0，移除直连 URL 的优先级冲突。
- Opik 同时修改 Java、Python、初始化任务和 RustFS 接入。
- Flexprice 锁定包含 Sentinel 实现的版本并验证所有 Redis 使用点。
- 验证目标 CPU 上的 pgvector。
- 完成 ClickHouse 共用兼容测试、RustFS 对象迁移测试及故障演练。

## 核对来源

- [当前 1Panel 包](1panel/apps/)及各应用 README。
- [Infisical v0.167.16 Redis 客户端](https://github.com/Infisical/infisical/blob/v0.167.16/backend/src/lib/config/redis.ts)与[环境配置](https://github.com/Infisical/infisical/blob/v0.167.16/backend/src/lib/config/env.ts)。
- [Opik 2.3.4 Java Sentinel 配置](https://github.com/comet-ml/opik/blob/2.3.4/apps/opik-backend/src/main/java/com/comet/opik/infrastructure/RedisSentinelConfig.java)、[Python Sentinel 配置](https://github.com/comet-ml/opik/blob/2.3.4/apps/opik-python-backend/src/opik_backend/utils/redis_sentinel_settings.py)及[官方 Sentinel 文档](https://www.comet.com/docs/opik/self-host/configure/redis-sentinel)。
- [Flexprice Redis 客户端](https://github.com/flexprice/flexprice/blob/ab53a6a7edef647bf9e68440f3f69d0c69fc0028/internal/redis/client.go)、[配置](https://github.com/flexprice/flexprice/blob/ab53a6a7edef647bf9e68440f3f69d0c69fc0028/internal/config/config.go)及[官方 Compose](https://github.com/flexprice/flexprice/blob/ab53a6a7edef647bf9e68440f3f69d0c69fc0028/docker-compose.yml)。Redis 客户端与配置核对 revision 为 `ab53a6a7edef647bf9e68440f3f69d0c69fc0028`。部署镜像必须包含对应实现。
- [Redis Sentinel 官方文档](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)、[SELECT 限制](https://redis.io/docs/latest/commands/select/)及[Pub/Sub database 范围](https://redis.io/docs/latest/develop/pubsub/#database--scoping)。
- [RustFS S3 兼容范围](https://docs.rustfs.com/en/reference/s3-compatibility)。
