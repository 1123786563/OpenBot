# 维护 Persaas 两机部署

此指南用于当前两台服务器。服务清单、已验证内容和未完成项见[部署记录](DEPLOYMENT.md)。

## 登录主站

1. 在 Termius 登录 129.28.39.52。
2. 在服务器查看 `/opt/persaas/credentials.json`。此文件仅 root 可读，不要发到聊天或提交到 Git。
3. 打开 `https://www.persaas.cn/`，选择 Okta 登录。当前连接器名称显示为 Okta，实际跳转到 Casdoor。
4. 在 Persaas 应用中使用用户名 `admin` 和文件中的 `ownerPassword` 登录。

管理登录服务时，打开 `https://casdoor.persaas.cn/`，使用内置组织 `built-in` 的 `admin` 和文件中的 `casdoorPassword`。两种密码不同。

## 集中配置（Infisical）

打开 `https://infisical.persaas.cn/`，使用服务器凭据文件中的 `adminEmail` 和 `infisicalPassword` 登录。选择 **Persaas Runtime → prod**。

| 目录 | 用途 |
| --- | --- |
| `/server` | OpenBot API |
| `/worker` | 后台 Worker |
| `/flexprice` | Flexprice |
| `/temporal` | Temporal |
| `/openobserve` | 日志服务管理凭据 |

API、Worker 启动时读取配置；在 Infisical 保存修改后，在应用节点执行 `docker compose -f /opt/persaas/apps.yml up -d --force-recreate openbot worker`。读取失败时进程退出，不使用旧配置启动。

Flexprice、Temporal 使用导出的私密配置文件。在数据节点更新它们：

```sh
bash /opt/persaas/sync-config.sh
cd /opt/persaas
bash sync-config.sh
docker compose -f data.yml up -d --force-recreate flexprice temporal
```

四个机器身份只有项目读取权限，但可读取该项目内其他目录；不要把无关项目的密钥放入此项目。引导文件 `infisical-*.env` 包含机器身份凭据，仅 root 可读。Infisical 自身的数据库、Redis DB0、加密密钥保存在 1Panel 应用配置中，避免启动循环依赖。旧 `server.env` 等文件仅为恢复快照，修改它们不会更新正在运行的应用。OpenObserve 管理凭据在配置中心留存，其运行配置仍由 1Panel 管理。

## 检查服务

在 129.28.39.52 执行：

```sh
bash /opt/persaas/check.sh data
systemctl list-timers 'persaas-*'
```

预期健康检查成功，匿名主站账号接口返回 401。在 124.221.110.188 执行：

```sh
bash /opt/persaas/check.sh apps
systemctl status persaas-data-link --no-pager
```

## 重启服务

通过 1Panel 的**已安装**页面管理 PostgreSQL、Redis、ClickHouse、Kafka、Casdoor、Infisical 和 OpenObserve。

在数据节点先同步配置，再重建 Docker 服务：

```sh
cd /opt/persaas
bash sync-config.sh
docker compose -f data.yml up -d
docker compose -f data.yml logs --tail 50 flexprice temporal
```

在应用节点重建服务：

```sh
systemctl restart persaas-data-link
cd /opt/persaas
docker compose -f apps.yml up -d
docker compose -f apps.yml logs --tail 50 openbot worker
```

更改数据节点的 PostgreSQL 端口时，同时更新应用节点隧道和数据节点的受限公钥规则。不要直接把数据库端口开放到公网。

## 更新主站

先在开发机或 CI 构建 Linux amd64 镜像，再上传到应用节点。两台服务器均不承担源码构建。

更新 `apps.yml` 的镜像标签后，先备份数据库，再在应用节点执行迁移：

```sh
cd /opt/persaas
docker compose -f apps.yml run --rm --no-deps --interactive=false migrate
docker compose -f apps.yml up -d
bash /opt/persaas/check.sh apps
```

`--interactive=false` 防止通过 SSH 脚本运行时，迁移容器消耗后续脚本输入。迁移失败时停止更新，不要跳过错误。

## 管理证书和代理

主站已在 1Panel 的**网站**中登记。不要只复制一份新的 Nginx `server` 配置；未登记站点可能被面板防护返回 403。

主站代理片段见 `www-proxy.conf`，部署位置为：

```text
/opt/1panel/1panel/www/sites/www.persaas.cn/proxy/root.conf
```

`persaas-certificates.timer` 每天检查两次证书。手工运行检查：

```sh
systemctl start persaas-certificates.service
journalctl -u persaas-certificates.service -n 30 --no-pager
```

## 备份和恢复

在数据节点手工生成一份 PostgreSQL 与私密配置备份：

```sh
bash /opt/persaas/backup-postgres.sh
ls -lh /opt/persaas/backups/
```

首份异机副本位于应用节点：

```text
/opt/persaas/backups/initial-data-backup-20261128.tar.gz
```

在独立数据库中恢复并检查数据后，再规划正式切换。不要把 `roles.sql` 或配置归档直接覆盖到运行中的实例。恢复时使用 PostgreSQL 18 的 `pg_restore`。

归档包含数据库凭据，保存为 root 专用文件。继续配置自动异机复制、对象存储备份及备份保留策略；当前脚本没有自动清理旧备份。

## 接通 CubeSandbox

提供 `https://sandboxes.persaas.cn/` 的现有 API Key 后，先通过 API 核对模板、卷和数据通道。不要把密钥放入前端。

当前浏览器提供者需要 `OPENBOT_CUBE_BROWSER_TEMPLATE`、`OPENBOT_CUBE_BROWSER_URL`、`OPENBOT_CUBE_ENVD_URL`、至少 32 字符的独立签名密钥，以及按用户绑定的 `OPENBOT_CUBE_BROWSER_VOLUMES`。仅有 `/health` 成功不能证明浏览器接入完成。

用户要求不修改 43.136.78.18。若现有 API 没有可用的 OpenBot 浏览器模板，应保留明确的未就绪状态，不能改用共享无鉴权沙箱。

## 运行端到端验收

在数据节点执行：

```sh
python3 /opt/persaas/acceptance.py
```

脚本读取 root 私密凭据，验证 HTTPS、匿名权限、Casdoor 授权码登录、管理员权限、真实模型聊天与持久化、退出会话、Flexprice 和 Infisical。它会保留管理员的专用验收 Bot 与对话，输出不含密钥的 `/opt/persaas/acceptance-report.json`。已执行结果及验收边界见 [TEST-RESULTS.md](TEST-RESULTS.md)。
