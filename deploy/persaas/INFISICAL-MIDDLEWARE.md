# 仅管理容器环境变量

2026-11-28 已在 A（129.28.39.52）完成：16 个运行项目，共 27 份容器实际引用的 env 文件，已写入 **Persaas Infrastructure → prod** 并逐项读回一致。差异检查均为 0。Compose、证书、配置文件和管理员凭据目录已从此次集中配置中移除，服务器原文件保留。

OpenBot、Worker、Flexprice 和 Temporal 继续使用 **Persaas Runtime → prod** 中原有目录。Flexprice 的 `FLEXPRICE_DEPLOYMENT_MODE`、`GOMEMLIMIT` 也已补入 Runtime。不要把生成的 `runtime/*.env` 再作为第二份可编辑来源上传。

## 在 Infisical 中修改

Infrastructure 的目录对应 Compose 项目名，例如 `/bifrost`、`/casdoor`、`/mysql`、`/redis`、`/opik`、`/lago`、`/kafka`、`/persaas-kafka`、`/rustfs`。每个 `ENV_<文件名>_<路径摘要>` 键保存一份 env 文件的文本，直接编辑其中的 `NAME=value`。没有容器 env_file 的项目目录可以为空。

容器环境已整理到各应用原目录的 `.container-<服务名>.env`，Compose 通过 `env_file` 读取；整理前后完整的 Compose 展开结果比较一致。1Panel 的项目 `.env` 仍保留给面板参数使用，但不会因“默认存在”就上传，只有被服务明确声明为 env_file 的文件才纳入管理。

应用运行身份依然不能读取 Infrastructure（四个身份实测 403）。本机 root 引导凭据保留在 `/opt/persaas/credentials.json`；Infisical 自身及其数据库、Redis 的 env 文件必须保留本地副本，保证停机后可恢复。

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

旧入口 `archive-panel-config.py` 已改为仅调用 env 上传，不会重新归档 Compose、证书或 JSON 配置。

## Bifrost

`bifrost.json` 已移除 `providers` 和 `auth_config`，保留数据库连接等必要设置，通过 `env.BIFROST_SETUP_TOKEN` 引用 setup token。实际 token 在 `.container-bifrost.env`，其内容已同步到 Infrastructure 的 `/bifrost`。

模型和管理员由 Bifrost 自身的控制台、数据库维护；此次没有清空既有数据库。容器已重新创建，确认 setup token 存在、控制台返回 200、匿名管理 API 返回 401。之前业务复验中真实推理请求返回 400，不属于 env 同步通过的结论，也未声称已修复。

## 验证

```sh
python3 deploy/persaas/tests/test_middleware_config.py
```

需要 Docker Compose。覆盖只采集实际引用的 env、拒绝非 env 项、无效 dotenv 恢复，以及有效修改重复下发。生产环境已核对 16 个项目、27 份 env、0 个非 env 项；27 个中间件容器保持运行。
