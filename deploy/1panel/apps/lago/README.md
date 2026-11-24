## 产品介绍

模型用量与对账。安装参数与依赖见 OpenBot 的 1Panel 部署说明。

部署配置基于[上游 Compose](https://github.com/getlago/lago/blob/v1.57.0/docker-compose.yml)修改。许可证见[上游许可证](LICENSE-upstream)。

## 数据库

安装时在「已有 PostgreSQL 实例」下拉框中选择 1Panel 管理的实例，再填写已有数据库名、用户和密码。

创建新库时，可在 **1Panel → 数据库 → PostgreSQL → 创建数据库** 使用面板生成的密码，再将同一个密码填入 Lago。也可以运行 `openssl rand -hex 32` 生成一个 URL 安全的密码。复用已有数据库时，使用该库当前的密码。

使用已安装 pg_partman 的 PostgreSQL 15 或更新版本。Lago 1.57.0 初始化空库时需要临时授予应用专用角色 SUPERUSER。迁移完成或安装中止后立即撤销。

## 应用密钥

新安装时，可留空 Rails 签名密钥、RSA 私钥和 3 项加密参数。首次启动会生成并保存这些值到 `lago_secrets` 命名卷，迁移、API、Worker 和 Clock 共用。容器重建时沿用该卷。恢复旧数据库时，填入原密钥或使用原密钥卷，并将密钥卷与数据库一同备份。
