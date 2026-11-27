# 当前中间件实例

这些 Compose 文件是 2026-11-28 在 1Panel 中运行的拓扑快照。它们依赖已安装应用的 `.env`、配置文件和数据卷，不要在另一个目录直接启动第二套实例。私密配置保存在 Infisical **Persaas Infrastructure → prod**，不在 Git 中。

| 服务 | 入口 | 登录凭据在 A 的 credentials.json 中的字段 |
| --- | --- | --- |
| Bifrost 2.6.0 | https://bifrost.persaas.cn | `admin` / `bifrostPassword` |
| Opik 2.3.4 | https://opik.persaas.cn | HTTP Basic：`admin` / `opikPassword` |
| Infisical 0.167.16 | https://infisical.persaas.cn | `adminEmail` / `infisicalPassword` |
| OpenObserve 1.2.0 | https://openobserve.persaas.cn | `openobserveEmail` / `openobservePassword` |
| Lago 1.57.0 | https://lago.persaas.cn | `adminEmail` / `lagoPassword` |
| Lago API | https://lago-api.persaas.cn | 管理登录由前端处理 |
| Flexprice API 2.1.52、控制台 2.0.22 | A 的 `127.0.0.1:18085` | `adminEmail` / `flexpriceOwnerPassword` |

Flexprice 控制台已构建并启动，原生登录与环境内客户 API 验证成功。公网 `flexprice.persaas.cn` 尚缺 DNS A 记录，暂未配置该域名的 HTTPS。可在 Termius 建立本地端口转发：本机 `127.0.0.1:18085` → A 的 `127.0.0.1:18085`，再打开本机地址。不要把服务端口直接开放到公网。

## 在 1Panel 中管理

A 的 **应用商店 → 已安装** 可管理 `bifrost`、`opik`、`lago`、`mysql`、`infisical`、`openobserve`。Bifrost、Opik、Lago 来自仓库本地应用包；MySQL 使用 1Panel 官方包 8.4.11。Flexprice 和 Temporal 继续由 `/opt/persaas/data.yml` 管理。

1. 先运行 `bash /opt/persaas/backup-postgres.sh`。
2. 在已安装页面查看容器状态，按需重启或更改参数。不要使用会替换现有拓扑的默认重装；Opik、Lago 的共享资源调整保存在这些 Compose 快照中。
3. 检查服务后，在 A 运行 `python3 /opt/persaas/archive-panel-config.py`，将最新 1Panel 配置归档到 Infisical 的 Persaas Infrastructure 项目。
4. 运行 `bash /opt/persaas/check.sh data`，再运行 `python3 /opt/persaas/acceptance-middleware.py`。

Infisical **Persaas Infrastructure → prod** 下的 `/bifrost`、`/opik`、`/lago`、`/mysql` 保存管理员凭据、完整运行环境 JSON、1Panel `.env` 和 Compose；`/openobserve` 保存日志服务管理凭据，`/flexprice-admin` 保存控制台凭据与版本。四个运行身份均被验证无法读取此项目（403），只能读取 Runtime 项目。这些是恢复归档，1Panel 应用目前仍读取本机配置；修改归档不会自动更新容器。OpenBot、Worker 的启动配置及 Flexprice、Temporal 的配置同步方法见上级 [README.md](../README.md)。

## 共享资源与隔离

- Bifrost 使用共享 PostgreSQL 的独立 `bifrost` 库和非超级用户。主站已通过受限虚拟密钥访问 `zhipu/glm-4.7`，未开放匿名推理。
- Opik 使用 1Panel MySQL 的独立 `opik` 库、共享 ClickHouse 的 `opik` 库及专用账号。其 Liquibase 元数据另占 `default.DATABASECHANGELOG`、`DATABASECHANGELOG1`、`DATABASECHANGELOGLOCK`、`DATABASECHANGELOGLOCK1`，不要让其他实例复用这些表。
- Opik 使用独立持久化 ZooKeeper 卷 `persaas-opik-20261128-zookeeper`。迁移与运行驱动均关闭 ClickHouse HTTP 压缩，以兼容现有 26.11.3。ClickHouse 配置样例为 `opik-clickhouse.xml.example`、`opik-user.xml.example`；需从私密配置填入密码及其 SHA-256，不能直接挂载带占位符的样例。不要移除 JDBC URL 的 `/default?compress=0` 或运行时的 `compress=0`。
- Redis：Infisical DB0、Opik DB2、Flexprice DB3、Lago 作业 DB6、缓存 DB7、Cable DB8。当前仍是单 Redis，Sentinel 尚未落实。
- Lago 使用独立 PostgreSQL 15 + pg_partman；现有 PG18 没有该扩展，不在其上强行安装或降级。Lago API、Worker、Clock、PDF 均已启动。
- S3 使用现有 RustFS，Opik 与 Lago 分别使用私有 bucket 和受限服务密钥。HTTPS 桶路径分别为 `opik.persaas.cn/opik/`、`lago-api.persaas.cn/lago/`，保留原始路径与 Host 以验证 S3 签名；不代理 RustFS 管理 API。
- Opik 和 Lago 的匿名注册已关闭；Flexprice 控制台代理也拒绝公开 signup。

[provision-rustfs.py](../provision-rustfs.py) 可重复核对 bucket、受限密钥、读写和跨 bucket 拒绝访问。它在 A 上读取现有 RustFS 管理凭据，不输出密钥。

## Flexprice 控制台构建与更新

在开发机使用 Node.js 22.22 或更高版本，执行：

```sh
bash deploy/persaas/build-flexprice-ui.sh /tmp/flexprice-ui-v2.0.22.tar.gz
```

上传归档到 A 的 `/opt/persaas/`，解压到 `/opt/persaas/flexprice-ui-dist/`，然后执行：

```sh
cd /opt/persaas
docker compose -f data.yml up -d flexprice-ui
curl -fsS http://127.0.0.1:18085/healthz
```

构建使用官方前端 v2.0.22、锁定依赖、原生 Flexprice 认证、同源 `/v1` API，关闭第三方统计。没有把密钥构建进前端。后端 signup 只在服务器回环 API 可用，公开控制台代理关闭该路由。

## 验收边界

服务启动不等于计费业务已接入。Lago 与 Flexprice 并行运行；OpenBot 的计费投递、套餐、账单、收款尚未配置完成。Flexprice 发票 S3 和支付渠道尚未验收。Opik API 已接入主站配置，但真实 Run 的追踪授权/投递流程仍需单独验收；OpenObserve 已验证日志接口，尚未启用主站自动日志采集。

本地每日备份现覆盖八个 PostgreSQL 库、Opik MySQL 和 Lago 加密密钥，已验证新增三库恢复。仍不包含 ClickHouse、ZooKeeper、RustFS 对象和 OpenObserve 日志数据，不是完整灾备；也没有自动每日异机复制。

兼容性参考：[Opik 架构](https://www.comet.com/docs/opik/self-host/architecture)、[Bifrost 部署契约](https://github.com/maximhq/bifrost/blob/transports/v2.6.0/docs/deployment-guides/runtime-contract.mdx)、[Flexprice 控制台](https://github.com/flexprice/flexprice-front/tree/v2.0.22)。
