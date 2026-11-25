## 产品介绍

OpenObserve 与 OTel Collector 日志采集。安装参数与依赖见 OpenBot 的 1Panel 部署说明。

## 数据库

安装时选择 1Panel 管理的数据库实例。表单会随机填充库名、用户名和密码，1Panel 使用这些值自动建库和建用户。复用已登记的数据库时，填回原库名、用户名和密码。密码含 URI 特殊字符时，在「数据库密码」填原始值，再填写「URL 编码后的数据库密码」。

PostgreSQL 存储 OpenObserve 元数据，日志数据仍需备份应用数据卷。OTel Collector 随应用安装。
