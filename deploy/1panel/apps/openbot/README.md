## 产品介绍

OpenBot 是可自托管的 AI 协作应用。此应用包含 Web、API 和浏览器，复用已有 PostgreSQL。

## 主要功能

- 在 Web 中与 Bot 对话，并通过浏览器执行获准的任务。
- 配置模型供应商或接入 Bifrost。
- 使用 Google OAuth 登录。

## 数据库

安装时在「已有 PostgreSQL 实例」下拉框中选择 1Panel 管理的实例，再填写已有数据库名、用户和密码。

PostgreSQL 实例需提供 pgvector。1.0.3 初始化空库时会创建和删除 vector 扩展。临时授予应用专用角色 SUPERUSER，migrate 服务成功退出或安装中止后立即撤销。
