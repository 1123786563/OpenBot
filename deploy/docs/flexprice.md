# Flexprice 用量对账

OpenBot 继续预占并结算点数。Worker 将已结算的模型用量投递到 Flexprice 专用零价订阅。默认安装器不启动 Flexprice。Flexprice 的部署配置见 [Compose 扩展](../centralized/apps/flexprice.yml)。

## Worker 配置

在 Persaas Runtime/prod 的 `/worker` 或独立部署的 [.env.worker](../openbot/.env.worker.example) 设置以下变量。使用从 Worker 可访问的 API 源站地址。

| 变量 | 值 |
| --- | --- |
| `FLEXPRICE_URL` | API 源站，如 `https://flexprice.persaas.cn/` |
| `FLEXPRICE_API_KEY` | 专用对账 API 密钥 |
| `FLEXPRICE_USAGE_CUSTOMER_ID` | 已发布的 UTC 客户 ID |
| `FLEXPRICE_USAGE_EXTERNAL_CUSTOMER_ID` | 客户的随机外部 ID |
| `FLEXPRICE_USAGE_METER_ID` | 已发布的 `openbot_model_usage` meter ID，按 `microcredits` 求和，配置中无过滤或倍率 |
| `FLEXPRICE_USAGE_SUBSCRIPTION_ID` | 专用 UTC 活跃订阅 ID，订阅和套餐各只有一项对应 meter 的零价 FIAT 用量价格 |
| `FLEXPRICE_USAGE_START_AT` | 固定的 UTC 切换时点，如 `2026-12-01T00:00:00Z` |

Worker 使用 `lago_usage_events.created_at` 选择从生效时点起写入的记录。账本仍在结算事务中写入该表，Flexprice 投递状态单独保存在 `flexprice_usage_deliveries`。HTTP 202 后继续等待事件读回。读回必须匹配原始事件 ID、客户、时间和数值。若不能读回，同一事件保留待投递状态。遇到冲突或拒绝时暂停该记录并输出 Worker 告警。

## 从 Lago 切换

1. 检查当前 Worker 配置、计划任务、API 请求日志和部署清单，确认 Lago 没有其他活跃消费者。确定切换时点。已经向同一 Flexprice 订阅投递的部署，沿用首次启用该订阅的时点。
2. 使用发布镜像执行 OpenBot 数据库迁移。曾运行部署分支迁移 `0165_flexprice_usage_deliveries` 的环境需先检查迁移日志，确认缺失的上游迁移已通过部署预检处理。发布后，确认 `0165_direct_chat_prompt_attachments` 和 `0166_flexprice_usage_deliveries` 都已生效。
3. 发布新 Worker，注入 Flexprice 配置并清除旧的 `LAGO_URL`、`LAGO_API_KEY` 和 `LAGO_USAGE_SUBSCRIPTION_ID`。确认 Worker 正常启动且没有 `flexprice_usage_export_failed` 告警。
4. 使用授权的计费账户发起一次真实模型调用，记录操作 ID，核对预占、结算及点数差额。通过匹配操作 ID 的事件 ID 核对 Flexprice 原始事件、专用订阅的 meter 聚合增量及账单金额零。重复提交同一事件 ID 后再次核对聚合、账单和 OpenBot 余额。可在带 Worker 环境的容器中运行 `bun --no-env-file scripts/flexprice-live.ts` 触发一批投递。以实际事件及聚合读回为验收依据。
5. 验收通过后，在 1Panel 停止 Lago API、Worker、Clock、PDF 和独立 PostgreSQL，清理专用配置、反代、证书续期条目和定时任务。共享 PostgreSQL、Redis、RustFS、Kafka、ClickHouse 和 Temporal 继续供相关服务使用。保留 OpenBot 账本及原始用量记录。历史 Lago 账单无需迁移或归档。

部署若在切换中失败，暂停停服步骤并恢复上一个 Worker 配置。保留两个投递相关表和固定切换时点以便重试。
