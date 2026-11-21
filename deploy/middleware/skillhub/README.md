# SkillHub

SkillHub 使用 OpenBot 技能市场已验收的 `v0.2.28` 官方镜像。Compose 启动 Web、API、Redis 和发布扫描器。API 通过 `1panel-network` 连接现有 PostgreSQL，技能 ZIP 和 Redis 数据分别保存在命名卷。

## 配置与启动

1. 在现有 PostgreSQL 实例创建专用数据库 `skillhub` 和同名角色，令该角色拥有数据库，以便 SkillHub 执行迁移。
2. 复制 `.env.example` 为 `.env`。将 JDBC URL 中的 `postgres` 替换成数据库容器在共享网络中的别名，填写数据库密码、管理员邮件地址和独立密码。用 `openssl rand -hex 32` 生成 `SKILLHUB_DOWNLOAD_ANON_COOKIE_SECRET`。
3. 在现有 1Panel OpenResty 中为 `skillhub.persaas.cn` 配置 HTTPS，将 `openresty-location.conf` 中的配置加入该站点的 `server` 块。在服务器上通过 `nginx -t` 后重载 OpenResty。如使用其他域名或端口，同步修改 `.env` 和代理配置。

```sh
docker compose config --quiet
docker compose up -d --wait --wait-timeout 300
docker compose ps
curl -fsS http://127.0.0.1:18090/nginx-health
```

首次启动时，使用用户名 `admin` 和配置的初始密码登录。确认登录后可将 `SKILLHUB_BOOTSTRAP_ADMIN_ENABLED` 改为 `false`，再运行 `docker compose up -d`。备份时同时保存 PostgreSQL 数据库和 `skillhub_storage` 卷。

## 接入 OpenBot

在 SkillHub 中创建专用团队命名空间。用独立的普通账号加入该命名空间，签发仅有 `skill:read` 权限的 API Token。技能版本审核通过后以命名空间可见方式发布。

在 OpenBot 服务的私有环境配置中填写以下变量，然后重新应用 OpenBot 服务配置。`SKILLHUB_URL` 必须能从 OpenBot 容器访问，并且只包含协议、主机和可选端口。

```dotenv
SKILLHUB_URL=https://skillhub.persaas.cn
SKILLHUB_CATALOG_NAMESPACE=openbot-catalog
SKILLHUB_READ_TOKEN=<catalog-reader-token>
```

OpenBot 从同一 SkillHub 地址直接下载版本 ZIP，因此本 Compose 使用本地存储。版本安装前的兼容性确认流程见 OpenBot 的 `docs/skill-market.md`。
