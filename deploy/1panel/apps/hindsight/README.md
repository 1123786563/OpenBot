## 产品介绍

个人记忆索引与召回。安装参数与依赖见 OpenBot 的 1Panel 部署说明。

## 数据库

安装时在「已有 PostgreSQL 实例」下拉框中选择 1Panel 管理的实例，再填写已有数据库名、用户和密码。

PostgreSQL 实例需提供 pgvector。请管理员在目标库执行 `CREATE EXTENSION IF NOT EXISTS vector;`。API 容器加入共享 1Panel 网络，供可信容器访问。
