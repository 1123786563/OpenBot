# 集中管理中间件配置

在 A（129.28.39.52）以 root 运行 `middleware-config.py`。配置保存在 **Persaas Infrastructure → prod**，沿用现有项目隔离：OpenBot 和 Worker 的运行身份不能读取基础设施管理凭据。

## 当前迁移状态

同步工具已上传到 A；本轮写入尚未完成。Infisical 对服务器现存管理员凭据返回 `400 Invalid credentials`，需要当前有效的管理员密码。不要将“工具已安装”视为“全部配置已同步”。

## 配置范围

工具按运行容器的 Compose 标签发现项目，采集实际 Compose 文件、项目 `.env`、引用的 `env_file`、挂载的文本配置和证书。包括 PostgreSQL/pgvector、MySQL、ClickHouse、Redis、两套 Kafka、RustFS、Casdoor、Bifrost、Opik（含 ZooKeeper）、Lago、OpenObserve、Infisical、Flexprice/Temporal 和 OpenResty。DBX 如仍在运行也会登记。只采集配置，不采集数据库目录、对象和日志数据。

| Infisical 键 | 用途 |
| --- | --- |
| `COMPOSE_YAML` | 原始 Compose，可编辑环境变量和服务参数 |
| `PANEL_ENV_FILE` | 原始 1Panel `.env`，可编辑面板变量 |
| `CONFIG_<文件名>_<路径摘要>` | 挂载配置、其他 env_file 或证书的原始内容，可编辑 |
| `FILES_MANIFEST_JSON` | 键对应的路径、属主和权限；不要修改 |
| `EFFECTIVE_ENVIRONMENT_JSON` | Compose 展开后的环境变量证据；只供核对，修改不会下发 |

`data-services` 对应 `/opt/persaas/data.yml`。Flexprice 和 Temporal 的实际环境变量继续以 **Persaas Runtime/prod → /flexprice、/temporal** 为唯一来源；生成的 `runtime/*.env` 不作为另一份可编辑配置上传。它们仍使用 `sync-config.sh` 导出。OpenBot、Worker 继续启动时读取 Runtime。

## 初次登记或面板调整后上传

```sh
python3 /opt/persaas/middleware-config.py push
python3 /opt/persaas/middleware-config.py check
```

`push` 会用服务器当前文件更新 Infisical，并逐项读回比较。只有要以本机配置覆盖集中配置时才执行。`check` 只读取并报告差异文件数量，不输出配置值。项目目录名沿用 Compose 项目名（例如 `bifrost`、`opik`、`redis`）；以首次成功上传的报告为准。

## 从 Infisical 下发

1. 在 Infisical 修改源配置键，不修改只读环境摘要或文件清单。
2. 检查差异，再下发指定项目：

```sh
python3 /opt/persaas/middleware-config.py check --project bifrost
python3 /opt/persaas/middleware-config.py apply --project bifrost
```

3. 需要让容器重新读取配置时：

```sh
python3 /opt/persaas/middleware-config.py apply --project bifrost --restart
python3 /opt/persaas/acceptance-middleware.py
```

`apply` 先备份到 `/opt/persaas/backups/vault-<时间>/`，保留文件属主和权限，再执行 Compose 校验；OpenResty 另执行语法检查。校验失败时恢复本次改写的文件。重复下发相同配置不写文件。`--restart` 只允许指定一个项目，不执行全平台批量重建；重建或应用层健康失败需使用备份回滚并再次验收，工具不声称自动恢复业务健康。

1Panel 继续使用原来的 Compose 和文件路径，不增加第二套容器。面板中若修改了参数，应先验收，再执行 `push --project NAME` 更新 Infisical。集中配置保存后不会自动热更新容器。

## 引导与恢复

Infisical 自身、支撑它的 PostgreSQL 和 Redis 必须保留可用的本机配置，不能要求它们启动前先访问 Infisical。集中管理保留这些 root 专用恢复副本。数据库的环境变量密码是部署参数，修改它不会自动修改已初始化数据库中的账号密码；轮换时需同步数据库账号和调用方。

工具使用 A 的 `/opt/persaas/credentials.json` 中现有管理员凭据，不创建新的机器身份或扩大已有应用身份权限。日志只报告项目名和数量。证书续期及 1Panel 网站操作仍由现有机制执行，完成后需要上传更新；不得以旧归档覆盖刚续期的证书。

## 本地验证

在仓库根目录执行（需要 Docker Compose）：

```sh
python3 deploy/persaas/tests/test_middleware_config.py
```

验证无变更不写入、篡改路径被拒绝、无效 Compose 自动恢复，以及有效修改下发和重复执行。
