# Persaas 部署验收

执行日期：2026-11-28（北京时间）。实际两机实例验收，非所有产品功能的覆盖测试。

## 通过

- 五个公开站点 HTTPS 证书有效；主站健康，匿名账号请求返回 401。
- Casdoor 授权码登录成功，登录用户为 OpenBot 管理员，受保护 Bot 列表可读；退出后会话失效。
- 通过 OpenBot 创建私密验收对话，模型 glm-4.7 返回本轮唯一标记，回复写入对话历史。
- API、Worker 从 Infisical prod 配置启动；进程中的配置版本标记符合预期。子进程未继承 Infisical 机器身份密钥。
- 四个机器身份的写入探测均返回 403。Infisical 不可访问时，独立测试容器拒绝启动业务命令。
- Flexprice、Temporal 配置导出成功；包含美元符号、引号、换行和反斜杠的配置通过 Compose 字面值往返验证。
- OpenBot 数据库迁移成功，撤销应用数据库超级用户权限后可再次运行。Worker 数据库清理循环正常。
- Flexprice 健康、ClickHouse 迁移、Kafka 3.9 消费组与 Temporal 工作流通过此前实例检查。
- OpenObserve 强密码修复后运行稳定，认证 streams API 返回 200。
- 原有五个 PostgreSQL 数据库备份恢复验证通过；新增 Infisical 备份恢复到独立临时数据库成功（793 张 public 表），随后删除临时恢复库。
- 六库完整 PostgreSQL 归档复制到应用节点，SHA-256 一致：`69d191aae7170164c65d869f7b02f136a6ba65bd976eedc4a4f836e2d04de971`。

可重复的应用验收命令与报告位置见 [README.md](README.md)。脚本验证登录、真实聊天及退出；基础设施检查中的迁移、恢复、权限探测为本次单独执行。

## 未验收与限制

- CubeSandbox 仅健康接口通过；现有 API Key 缺失，模板、卷、浏览器和数据通道未验收。未修改 43.136.78.18。
- OpenBot 的用量投递仍是 Lago 适配器；Flexprice 套餐、用量对账、收款未完成接入。
- Redis 当前仍是单实例，尚未落实 Sentinel。两台现有主机也未提供整个平台高可用。
- 定时业务任务、文件/对象存储业务、其他模型、第三方渠道，以及未启用的 Opik/Hindsight/Bifrost 未做端到端覆盖。
- 备份尚不覆盖对象存储、ClickHouse、Kafka、Redis；每日自动异机复制和保留策略尚未配置。
- 配置中心不可用时，已运行进程继续使用启动时配置；新启动进程会失败。机器身份引导凭据及配置中心自身的加密密钥仍需 root 专用离线备份。
