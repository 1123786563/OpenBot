# 准备 Flexprice 扩展

Flexprice 用于后续替代 Lago，当前 OpenBot 的计费集成尚未切换。默认安装器不启动 Flexprice，不要求新手准备它的镜像、认证和迁移。

底层已预留 Kafka KRaft、Temporal、Flexprice ClickHouse 24.9、专用 PostgreSQL 库与 Redis Sentinel DB 3。Opik ClickHouse 保持 26.3，未经联合兼容验收不合并。

维护人员需要完成以下交付后，才能把 Flexprice 加入默认安装：

1. 从已核对的 revision `ab53a6a7edef647bf9e68440f3f69d0c69fc0028` 或验证过的 release 构建镜像。
2. 准备认证和加密配置，初始化 PostgreSQL、ClickHouse 与 Kafka topics。
3. 验证 Temporal namespace、Worker、事件幂等、重放和账单结果。
4. 接入 OpenBot 用量导出，完成替换与回退设计。

高级 Compose 配置见 [apps/flexprice.yml](../centralized/apps/flexprice.yml) 和[集中部署方案](../centralized-deployment-plan.md)。配置资源存在不代表业务接入已经完成。
