## 产品介绍

对话追踪与评测。安装参数与依赖见 OpenBot 的 1Panel 部署说明。

部署配置基于[上游 Compose](https://github.com/comet-ml/opik/tree/2.3.0/deployment/docker-compose)修改。许可证见[上游许可证](LICENSE-upstream)。

## 数据库

安装时选择 1Panel 管理的数据库实例。表单会随机填充库名、用户名和密码，1Panel 使用这些值自动建库和建用户。复用已登记的数据库时，填回原库名、用户名和密码。

使用 MySQL 8.4。ClickHouse、ZooKeeper 和 MinIO 随应用安装。API 容器加入共享 1Panel 网络，供可信容器访问。

## Redis

安装时在「已有 Redis 实例」下拉框中选择 1Panel 管理的 Redis，「Redis 密码」随所选实例自动带入，未设密码时留空。密码含 URI 特殊字符时，再填写「URL 编码后的 Redis 密码」，编码规则同数据库密码。Opik 用它缓存数据并投递评测后台任务。

从自带 Redis 的旧版本升级时，旧 Redis 中排队的任务不会迁移。
