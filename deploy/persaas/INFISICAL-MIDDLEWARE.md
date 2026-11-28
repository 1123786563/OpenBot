# 仅管理容器环境变量

2026-11-28 已将 **Persaas Infrastructure → prod** 的 23 份容器 env 拆成 **468 个独立环境变量**，分布在 23 个服务目录。所有变量已读回并与 Compose 解析结果比较一致，旧的整文件变量已删除。迁移未修改本地 env，也未重启容器。

**Persaas Runtime → prod 只保留 `/server`、`/worker`**，分别保存 OpenBot API 和 Worker 的独立应用变量。应用连接中间件所需的 URL、密钥仍属于应用配置，保留在 Runtime。

数据库服务自身的 env 不存入 Infisical：排除 MySQL、ClickHouse、pgvector/PostgreSQL、Redis。应用和中间件作为数据库客户端所需的连接变量继续保留。本地数据库 env 和私有备份保留；后续上传也会排除数据库容器。

Compose、JSON、证书、模型和管理员账号清单不纳入环境变量管理。迁移前的恢复备份仅在 A 的 root 私有 `/opt/persaas/backups/individual-vars-<时间>/` 保留。

## 在 Infisical 中修改

在服务目录中直接编辑变量名和值，例如 `/bifrost` 下的 `BIFROST_SETUP_TOKEN`，或 `/flexprice` 下的 `FLEXPRICE_POSTGRES_PASSWORD`。不再使用 `ENV_FILE` 或 `ENV_<文件名>_<摘要>` 保存整份文件。每个变量的值只填原始内容，不额外添加 dotenv 引号或把 `$` 写成 `$$`；下发脚本会处理转义。

单 env 服务使用 `/bifrost`、`/casdoor`、`/flexprice`、`/temporal` 等目录。多 env 项目使用服务子目录：`/opik/backend`、`/opik/frontend`、`/opik/python-backend`、`/opik/zookeeper` 等。同名变量在不同服务中独立保存。没有容器 env 的项目不创建空目录。

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

`push` 用 Compose 解析本地 env 后，以每个变量的名称和值上传，覆盖 Infisical 中同名变量；从 Infisical 下发修改时使用 `apply`。保存到 Infisical 不会自动热更新容器。`apply` 将目录下的独立变量生成为本地 env，支持新增和删除变量；`check` 比较解析后的值，不把引号或排序变化当作配置差异。`apply` 先备份到 `/opt/persaas/backups/env-apply-<时间>/`，保留属主和权限，并执行 Compose 校验；校验失败恢复本次写入的文件。重建后需单独检查服务健康，工具不自动回滚应用层故障。

未来新增的 Compose 若还内联环境变量，可先执行 `materialize --project NAME`，把当前环境转为 env_file；此命令需要服务器已安装的 PyYAML，只在完整 Compose 展开结果不变时保存修改。它不重启容器。不要把管理员或模型配置重新写入 Bifrost JSON。

`bash /opt/persaas/sync-config.sh` 现在只从 Infrastructure 下发 Temporal、Flexprice。需要生效时，再重建对应服务；`apply --project flexprice --restart` 仅重建 Flexprice，不会连带重建 Temporal。`/collector` 的 8 个独立变量对应 B 节点 Collector；更改后需在 B 上生成 `collector.env` 并重建 Collector，A 的自动发现工具仅覆盖 A 节点，不会自动下发到 B。

旧入口 `archive-panel-config.py` 已改为仅调用 env 上传，不会重新归档 Compose、证书或 JSON 配置。

## Bifrost

`bifrost.json` 已移除 `providers` 和 `auth_config`，保留数据库连接等必要设置，通过 `env.BIFROST_SETUP_TOKEN` 引用 setup token。实际 token 在 `.container-bifrost.env`，其内容已同步到 Infrastructure 的 `/bifrost`。

模型和管理员由 Bifrost 自身的控制台、数据库维护；此次没有清空既有数据库。容器已重新创建，确认 setup token 存在、控制台返回 200、匿名管理 API 返回 401。之前业务复验中真实推理请求返回 400，不属于 env 同步通过的结论，也未声称已修复。

## 验证

```sh
python3 deploy/persaas/tests/test_middleware_config.py
```

需要 Docker Compose。验证覆盖多服务同名变量隔离、排除数据库但保留其备份、引号/美元符/多行/空值/空格的生成与读回、无效变量名拒绝、Compose 校验失败恢复，以及重复下发。线上已逐项核对 23 个服务目录、468 个变量；A 的 22 份 env 语义差异均为 0。
