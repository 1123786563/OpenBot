## 产品介绍

OpenBot 是可自托管的 AI 协作应用。此应用包含 Web、API 和 Worker。安装时选择已有 PostgreSQL，并填写 Agents 和其他中间件的连接参数。

## 主要功能

- 在 Web 中与 Bot 对话，并通过浏览器执行获准的任务。
- 配置模型供应商或接入 Bifrost。
- 使用 Google OAuth 登录。

## 数据库

安装时选择 1Panel 管理的数据库实例。表单会随机填充库名、用户名和密码，1Panel 使用这些值自动建库和建用户。复用已登记的数据库时，填回原库名、用户名和密码。密码含 URI 特殊字符时，在「数据库密码」填原始值，再填写「URL 编码后的数据库密码」。

PostgreSQL 实例需提供 pgvector。1.0.3 初始化空库时会创建和删除 vector 扩展。1Panel 自动创建的专用角色已有 SUPERUSER 权限。migrate 服务成功退出或安装中止后立即撤销。
