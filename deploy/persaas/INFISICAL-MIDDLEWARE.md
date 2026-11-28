# 仅管理容器环境变量

2026-11-28 已在 A（129.28.39.52）完成：12 个中间件目录，共 22 份 A 节点容器实际引用的非数据库 env 文件，已写入 **Persaas Infrastructure → prod** 并逐项读回一致。差异检查均为 0。Compose、证书、配置文件和管理员凭据目录已从此次集中配置中移除，服务器原文件保留。

**Persaas Runtime → prod 只保留 `/server`、`/worker`**，分别保存 OpenBot API 和 Worker 的应用配置。Flexprice、Temporal 已迁入 **Persaas Infrastructure → prod** 的 `/flexprice`、`/temporal`，每个目录保存对应 `runtime/<服务>.env` 的全文。目录名 `runtime/` 是本地文件路径，不代表 Infisical 项目归属。应用连接中间件所需的 URL、密钥仍属于应用配置，保留在 Runtime。

Infrastructure 另有 `/collector`，保存 B 节点 OpenTelemetry Collector 的 env 文件；合计 13 个目录、23 份 env。已删除 Runtime 中 8 个旧中间件目录、Infrastructure 的 5 个无用目录和旧同步身份配置。Compose、JSON、证书、模型、管理员账号清单均不存入这两个项目的容器 env 管理目录。清理前的恢复备份仅在 A 的 root 私有 `/opt/persaas/backups/project-boundary-<时间>/` 中保留。

数据库服务自身的 env 不存入 Infisical：已移除 MySQL、ClickHouse、pgvector/PostgreSQL、Redis 的目录，以及 `/lago` 中数据库容器的 env。应用和中间件作为数据库客户端所需的连接变量继续保留。同步工具按容器镜像排除数据库服务，后续 `push` 不会重新上传；数据库本地 env 文件和私有备份保留，备份发现仍包含数据库 env。

## 在 Infisical 中修改

Infrastructure 的目录对应 Compose 项目名，例如 `/bifrost`、`/casdoor`、`/opik`、`/lago`、`/kafka`、`/persaas-kafka`、`/rustfs`。每个 `ENV_<文件名>_<路径摘要>` 键保存一份 env 文件的文本，直接编辑其中的 `NAME=value`。没有容器 env_file 的项目不创建空目录。

容器环境已整理到各应用原目录的 `.container-<服务名>.env`，Compose 通过 `env_file` 读取；整理前后完整的 Compose 展开结果比较一致。1Panel 的项目 `.env` 仍保留给面板参数使用，但不会因“默认存在”就上传，只有被服务明确声明为 env_file 的文件才纳入管理。

OpenBot 和 Worker 使用原有 Runtime 只读身份，不授予 Infrastructure 权限。Flexprice、Temporal 原有的 Runtime 导出容器已移除，`infisical-flexprice.env`、`infisical-temporal.env` 已移入私有备份；下发改由 A 本机管理脚本完成。本机 root 引导凭据保留在 `/opt/persaas/credentials.json`；Infisical 自身及其数据库、Redis 的 env 文件必须保留本地副本，保证停机后可恢复。

## 上传、检查和下发

在 A 以 root 执行：

```sh
# 将服务器当前 env 内容更新到 Infisical，随后读回核对
python3 /opt/persaas/middleware-config.py push
# 只比较，不写入、不重启
python3 /opt/persaas/middleware-config.py check
# 下发一个项目的 env 内容
python3 /opt/persaas/middleware-config.py apply --project bifrost
# 下发并重新创建指定项目的容器
python3 /opt/persaas/middleware-config.py apply --project bifrost --restart
```

`push` 以本机内容为准，会覆盖 Infisical 中同名 env 项；从 Infisical 下发修改时使用 `apply`。保存到 Infisical 不会自动热更新容器。`apply` 先备份到 `/opt/persaas/backups/env-apply-<时间>/`，保留属主和权限，并执行 Compose 校验；校验失败恢复本次写入的文件。重建后需单独检查服务健康，工具不自动回滚应用层故障。

未来新增的 Compose 若还内联环境变量，可先执行 `materialize --project NAME`，把当前环境转为 env_file；此命令需要服务器已安装的 PyYAML，只在完整 Compose 展开结果不变时保存修改。它不重启容器。不要把管理员或模型配置重新写入 Bifrost JSON。

`bash /opt/persaas/sync-config.sh` 现在只从 Infrastructure 下发 Temporal、Flexprice。需要生效时，再重建对应服务；`apply --project flexprice --restart` 仅重建 Flexprice，不会连带重建 Temporal。B 节点的 Collector env 下发后需在 B 上重建 Collector，A 的发现工具只覆盖 A 节点。

旧入口 `archive-panel-config.py` 已改为仅调用 env 上传，不会重新归档 Compose、证书或 JSON 配置。

## Bifrost

`bifrost.json` 已移除 `providers` 和 `auth_config`，保留数据库连接等必要设置，通过 `env.BIFROST_SETUP_TOKEN` 引用 setup token。实际 token 在 `.container-bifrost.env`，其内容已同步到 Infrastructure 的 `/bifrost`。

模型和管理员由 Bifrost 自身的控制台、数据库维护；此次没有清空既有数据库。容器已重新创建，确认 setup token 存在、控制台返回 200、匿名管理 API 返回 401。之前业务复验中真实推理请求返回 400，不属于 env 同步通过的结论，也未声称已修复。

## 验证

```sh
python3 deploy/persaas/tests/test_middleware_config.py
```

需要 Docker Compose。覆盖只采集实际引用的 env、拒绝非 env 项、无效 dotenv 恢复、有效修改重复下发，以及共享 Compose 中 Flexprice/Temporal 的独立下发。生产环境 A 的 12 个中间件目录、22 份 env 差异均为 0；另保留 Infrastructure `/collector` 的 1 份 B 节点 env。
