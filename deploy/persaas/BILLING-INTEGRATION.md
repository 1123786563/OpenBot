# Bifrost 推理与 Flexprice 用量接入

2026-11-28 的两机部署使用 Bifrost 提供模型推理，OpenBot 账本执行余额结算，Flexprice 接收已结算用量用于计量和对账。Flexprice 专用订阅价格为 0，避免对同一笔消费再次收费。本次接入不包含支付渠道、充值或自动扣款。

## Bifrost

提供商保存在 Bifrost PostgreSQL 中，通过控制台维护。`bifrost.json` 不保存模型、提供商或管理员配置，setup token 继续使用环境变量。

当前提供商 `zhipu` 的基础地址为 `https://open.bigmodel.cn/api/coding/paas/v4`，匹配现有 Coding Plan 密钥。OpenAI 兼容提供商默认会追加 `/v1/chat/completions`；智谱此端点需要在 `custom_provider_config.request_path_overrides` 设置：

```json
{
  "chat_completion": "/chat/completions",
  "chat_completion_stream": "/chat/completions",
  "list_models": "/models"
}
```

OpenBot 专用虚拟密钥绑定 `zhipu`、现有 `code-plan` 密钥及 `glm-4.7`。应用使用 `https://bifrost.persaas.cn/v1` 和 `zhipu/glm-4.7`。不要把虚拟密钥设为允许所有提供商。

## Flexprice

Infrastructure/prod 的 `/flexprice` 管理中间件环境变量。生产与消费主题必须相同：

| 消费配置 | 对应生产配置 |
| --- | --- |
| `FLEXPRICE_EVENT_PROCESSING_TOPIC` | `FLEXPRICE_KAFKA_TOPIC` |
| `FLEXPRICE_METER_USAGE_TRACKING_TOPIC` | `FLEXPRICE_KAFKA_TOPIC` |
| `FLEXPRICE_EVENT_PROCESSING_LAZY_TOPIC` | `FLEXPRICE_KAFKA_TOPIC_LAZY` |
| `FLEXPRICE_METER_USAGE_TRACKING_LAZY_TOPIC` | `FLEXPRICE_KAFKA_TOPIC_LAZY` |

当前普通主题为 `persaas_staging_events`，延迟主题为 `persaas_staging_events_lazy`。`local` 模式在同一进程运行 API、消费者和 Temporal Worker。仅检查 API health 不能证明事件已完成计量。

Runtime/prod 的 `/worker` 单独保存以下六个变量：

- `FLEXPRICE_URL`：`https://flexprice.persaas.cn/`
- `FLEXPRICE_API_KEY`：专用事件导出密钥
- `FLEXPRICE_USAGE_CUSTOMER_ID`
- `FLEXPRICE_USAGE_EXTERNAL_CUSTOMER_ID`：随机外部标识，不使用用户身份
- `FLEXPRICE_USAGE_METER_ID`
- `FLEXPRICE_USAGE_SUBSCRIPTION_ID`

Worker 启用 Flexprice 时移除三个 `LAGO_*` 导出配置；两套同时配置会拒绝启动。Lago 服务及历史记录保留。

专用 customer 和 subscription 使用 UTC；meter 为 `openbot_model_usage`，按 `microcredits` SUM，无过滤或倍率；plan 仅含一项零价 usage price。导出前会核验这些约束。

结算事务继续写入 `lago_usage_events`，作为既有不可变事件来源。新增 `flexprice_usage_deliveries` 保存独立投递状态，避免覆盖 Lago 的历史状态。事件只传递不透明 ID、资源、token 数和 microcredits，不传递账号身份或提示词。金额与 token 数使用十进制字符串。

HTTP 202 仅表示接收。Worker 必须读回相同事件并逐项核对，才能标记 `accepted`；暂时查不到时保留 `pending`，冲突或拒绝则标记 `paused`。运维应调查暂停记录，禁止直接改为 accepted。

## 发布与检查

应用节点先构建 `FlexpriceWorker.Dockerfile` 指定的 Worker 镜像，再执行迁移 0165。镜像以现有 Casdoor 应用镜像为基础，服务器需已具备该基础镜像。

```sh
docker build --network none --pull=false -t openbot-worker:persaas-flexprice-20261128 -f deploy/persaas/FlexpriceWorker.Dockerfile .
docker compose -f /opt/persaas/apps.yml run --rm --no-deps -T worker bun --no-env-file scripts/migrate.ts
docker compose -f /opt/persaas/apps.yml up -d --no-deps --force-recreate worker
docker compose -f /opt/persaas/apps.yml run --rm --no-deps -T worker bun --no-env-file scripts/flexprice-live.ts
```

检查投递状态，并在 Flexprice 查询原始事件和 SUM 聚合值。重复提交相同事件 ID 后，聚合值应保持不变。普通主站聊天验收与计费投递验收是不同检查；只有进入 OpenBot 结算账本的用量才会导出，不能把任意网关调用都当作已计费事件。

回滚 Worker 时保留迁移表和事件记录，恢复原 Worker 镜像及原 Runtime 导出配置。提供商修改前的备份仅保存在入口节点 `/opt/persaas/backups/`，其中可能包含私密配置，禁止提交仓库。

## 使用本地 Flexprice 源码发布

部署源码固定来自 `/Users/wuyj/IdeaProjects/flexprice` 和 `/Users/wuyj/IdeaProjects/flexprice-front`。前端构建包含当前工作目录改动，不修改或提交该仓库已有的未提交文件。

```sh
./deploy/persaas/build-flexprice-local.sh /absolute/empty-release-directory
```

该脚本交叉编译 Linux amd64 后端和迁移工具，构建前端，并打包两个镜像的构建目录。后端基础镜像复用现有 Alpine、Typst、dbmate 和系统依赖；运行的 server/migrate、默认配置、assets 和 migrations 来自本地源码。前端使用 Nginx 托管生产 dist，不运行 Vite 开发服务器。打包结果不包含仓库 `.env`。

将 `release.tar.gz` 上传入口节点，解包后分别执行 `docker build`，以新标签更新 `data.yml`，保留 `runtime/flexprice.env` 和前端反向代理配置挂载。前端 dist 已包含在镜像里，不再挂载旧版 `flexprice-ui-dist`。先备份数据库和 Compose，再核对迁移差异；只有新增迁移时才执行经核对的迁移工具。

2026-11-28 本次后端源提交为 `d7d5c1120`，前端为 `70a95c83` 加当前工作目录改动；运行镜像分别为 `flexprice:persaas-local-d7d5c1120`、`flexprice-front:persaas-local-70a95c83`。Infrastructure `/flexprice` 的 `FLEXPRICE_AUTH_DISABLE_SIGNUP=true` 关闭后端注册入口。发布清单与回滚 Compose 位于服务器 `/opt/persaas/releases/local-flexprice-20261128/` 和 `/opt/persaas/backups/`。
