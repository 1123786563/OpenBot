## 产品介绍

对话追踪与评测。安装参数与依赖见 OpenBot 的 1Panel 部署说明。

部署配置基于[上游 Compose](https://github.com/comet-ml/opik/tree/2.3.0/deployment/docker-compose)修改。许可证见[上游许可证](LICENSE-upstream)。

## 数据库

安装时在「已有 MySQL 实例」下拉框中选择 1Panel 管理的实例，再填写已有数据库名、用户和密码。

使用 MySQL 8.4。ClickHouse、Redis、ZooKeeper 和 MinIO 随应用安装。API 容器加入共享 1Panel 网络，供可信容器访问。
