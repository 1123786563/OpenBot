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
- Redis 当前为单实例。用户于 2026-11-28 确认本阶段保留单 Redis、后续升级 Sentinel；不再作为本阶段验收阻塞项。当前没有自动故障切换或整个平台高可用。
- 定时业务任务、文件/对象存储业务、其他模型、第三方渠道，以及未启用的 Opik/Hindsight/Bifrost 未做端到端覆盖。
- 备份尚不覆盖对象存储、ClickHouse、Kafka、Redis；每日自动异机复制和保留策略尚未配置。
- 配置中心不可用时，已运行进程继续使用启动时配置；新启动进程会失败。机器身份引导凭据及配置中心自身的加密密钥仍需 root 专用离线备份。

## 中间件扩展复验（同日）

- Bifrost 2.6.0、Opik 2.3.4、Lago 1.57.0 与 MySQL 8.4.11 已通过 1Panel 安装；Infisical、OpenObserve、Flexprice 继续运行。
- `acceptance-middleware.py` 的 16 项检查通过：Bifrost 管理与推理鉴权、受限虚拟密钥真实推理；Opik 鉴权、追踪写入与读回；Lago 登录及健康；Flexprice 原生登录、环境内客户 API、公开注册拒绝；OpenObserve 鉴权、日志写入与查询；Opik、Lago 的 RustFS HTTPS 对象读写。
- 主站已切换到 Bifrost 的 `zhipu/glm-4.7`，重新通过 `acceptance.py` 的 12 项登录、权限、真实聊天与退出验收。Opik API 连接参数已加入主站 Infisical 配置。
- 新增 Bifrost PostgreSQL（91 张 public 表）、Lago PostgreSQL（183 张 public 表）、Opik MySQL（56 张表）的备份均恢复到独立临时库成功，随后移除临时库。
- 新增配置已归档到 Infisical 的独立 Persaas Infrastructure 项目，四个运行身份读取此项目均返回 403、读取各自 Runtime 配置仍成功；1Panel 应用依然使用本机配置，不自动从归档热更新。API、Worker 保持启动时读取 Infisical。
- Flexprice 前端 v2.0.22 完成 TypeScript 与 Vite 生产构建，在回环 18085 端口运行。原生认证与同源 API 通过检查；尚缺 `flexprice.persaas.cn` DNS，未验收公网控制台 HTTPS 或浏览器交互流程。
- 九个公开站点的证书及续期配置已登记；Flexprice 控制台尚未计入其中。

这些结果不覆盖计费对账、收款、真实 Run 的 Opik 追踪投递和主站日志自动采集。CubeSandbox API Key 和完整灾备缺口仍存在；Redis Sentinel 已按用户决定列为后续升级项。

最终归档再次验证九个数据库恢复成功；SHA-256：`80b17bc9ded5cb14ab5467c55f4c1d9ba730938c5f92ce5b2aba8e5ff0177ddb`。自动化结果摘要见 [acceptance-results.json](acceptance-results.json)。

## 真实浏览器业务验收更新

后续真实登录、原生聊天、任务、技能和记忆测试，以及 WAF/Opik 修复、附件与目标失败项，见 [平台功能验收](PLATFORM-ACCEPTANCE.md)。该报告更新了此前“追踪和日志未验”的状态，也明确保留了尚未完成的商业计费、沙箱和高可用工作。

## Flexprice public HTTPS update — 2026-11-28

`https://flexprice.persaas.cn/` now serves the console. TLS validation, HTTP redirect, public native authentication and environment-scoped APIs passed. The browser login page loaded successfully. Certificate renewal and configuration backup coverage were updated; the site is now a 1Panel-managed proxy website (ID 54, Running), with certificate association and HTTP-to-HTTPS redirect. The panel API search and public HTTPS returned 200 after migration. Earlier missing-DNS statements describe the previous acceptance run.
