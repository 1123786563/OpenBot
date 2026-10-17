# Opik 上游契约（VerifiedOpikContract）

这是 Issue #10 / DAG T04 对 **自托管 Opik `2.2.100`**（上游 commit
`c8231ef8cdabb6fc5223c8dece17959e8af461ce`，镜像 digest 见
[`docker/opik/versions.json`](../docker/opik/versions.json)）实测得到的上游 HTTP 契约。
后续所有 Opik 序列化 adapter 以本文件和
`docs/plans/evidence/2026-10-15-issue4/opik-contract/` 下的 manifest/fixture 为唯一依据；
manifest（`VerifiedOpikContract`）只在每条真实断言都通过时产出，fixture 本身不能作为验证通过的证明。

验证方式：`bun server/scripts/opik-contract.ts --target <api-base> --evidence <dir>
--compose-project opik-issue4-validation --secrets-env /tmp/opik-issue4-validation.env`，
runner 校验失败退出非零、不写 manifest。parser 测试（`server/tests/opik-contract.test.ts`）
只覆盖校验器/构造器，不触网。

## 基础事实

- API 基址是前端反代：`http://127.0.0.1:5174/api`（见 `docs/opik.md`）。后端 8080 不发布。
- 请求/响应体都是 **snake_case** JSON；查询串也是 snake_case（`project_id`、`trace_id`、`from_time`…）。
- 自托管默认 workspace 无需 API key；OTLP 端点与 REST 一样走 `/api` 反代。
- compose 里的 `otel-collector`（宿主 5418/5417）是**栈自身遥测**管道（exporter 只有
  debug），**不是**应用数据的摄取入口。应用 OTLP 走下面的后端端点。
- 异步性：OTLP 写入→可查询、数据集版本落库、删除→404 都可能延迟数秒；一律轮询，
  不要 sleep 一次就断言。

## 已验证端点

| 能力 | 方法与路径 | 关键请求语义 | 实测响应 |
| --- | --- | --- | --- |
| 健康 | `GET /health-check` | — | 200 |
| OTLP 写入 | `POST /v1/private/otel/v1/traces`（`Content-Type: application/json`） | OTLP HTTP/JSON；`traceId` 32 hex、`spanId`/`parentSpanId` 16 hex；纳秒时间戳为字符串；**路由项目来自 `projectName` 请求头**（缺省 Default Project） | 200 空体 |
| 建 trace（可选自选 id） | `POST /v1/private/traces` | `id` 可传 UUIDv7；**项目字段是 `project_name`（没有 `project_id`）**；`thread_id`、`start_time` ISO | 201 |
| trace 列表 | `GET /v1/private/traces?project_id=&size=` | 分页 `page/size/total/content` | 200 |
| trace 详情 | `GET /v1/private/traces/{id}?project_id=` | | 200 / 删除后 404 |
| span 列表 | `GET /v1/private/spans?project_id=&trace_id=` | **必须 `project_id`**（不接受 project_name） | 200 |
| span 详情 | `GET /v1/private/spans/{id}?project_id=` | | 200 / 删除后 404；`DELETE` 该路径是 501 未实现 |
| 项目查询 | `POST /v1/private/projects/retrieve` body `{name}` | GET+query 也存在，SDK 用 POST | 200 / 404 |
| 数据集创建 | `POST /v1/private/datasets` `{name, project_id}` | | 201 |
| 数据集查询 | `GET /v1/private/datasets?project_id=&name=` | | 200 |
| 样本写入/开版本 | `PUT /v1/private/datasets/items` `{dataset_id或dataset_name, items:[{source:"sdk", data}], batch_group_id?}` | **无 `batch_group_id` = 修改最新版本；带新 `batch_group_id` = 新开不可变版本** | 204 |
| 版本列表 | `GET /v1/private/datasets/{id}/versions` | | 200（`version_name/v1`、`version_hash`、`items_total`） |
| 版本内样本 | `GET /v1/private/datasets/{id}/items?version=<version_hash>` | `version` 参数是 **hash 不是 vN** | 200 |
| 实验创建 | `POST /v1/private/experiments` `{name, dataset_name, project_id}` | | 201 |
| 实验查询 | `GET /v1/private/experiments?project_id=&name=`、`GET /v1/private/experiments/{id}` | | 200 |
| 实验条目 | `POST /v1/private/experiments/items` `{experiment_items:[{experiment_id, dataset_item_id, trace_id}]}` | | 204 |
| 删除 trace | `POST /v1/private/traces/delete` `{ids, project_id}` | 连同 span 一起删（异步） | 204 |
| 删除实验/数据集/项目 | `POST /v1/private/experiments/delete` `{ids}`、`POST /v1/private/datasets/delete-batch` `{ids}`、`POST /v1/private/projects/delete` `{ids}` | | 204，随后查询 404 |

## ID 映射（OTel ↔ Opik）

后端 `OpenTelemetryMapper` 有两条路径，两条都已实测：

1. **派生路径**（无 `opik.*` 属性）：Opik trace/span id 是由 OTel id 派生的 **UUIDv7**
   （SHA-256 + 时间戳），**绝不等于** OTel id。每次写入的映射必须事后查询拿回
   （按唯一 span name 定位，读取响应中的 `id`/`parent_span_id`）。
2. **显式路径**（span 属性 `opik.trace_id` / `opik.span_id` / `opik.parent_span_id`，
   值为带连字符的 UUIDv7 字符串）：后端原样采用。**override span 不会自建 trace 行**——
   需先 `POST /v1/private/traces` 用自选 UUIDv7 建 trace，再把 OTLP span 挂进去。
   这就是跨服务身份策略：服务端 REST 建 trace（自己的 UUIDv7），运行期 span 用
   override 附加。

属性映射规则（`GeneralMappingRules`）：`input*`/`output*` 前缀 → input/output（后缀成
JSON 键，如 `input.value` → `input.value`）；`thread_id` → thread；`opik.tags`/`opik.metadata.*`
→ tags/metadata；`opik.*` id 属性不入库。父/子用 OTel `parentSpanId`（派生路径）或
`opik.parent_span_id`（显式路径）都验证了链接成立。

## 数据集版本语义

- PUT items 不带 `batch_group_id`：**修改最新版本**（不是新版本）。
- 带新 `batch_group_id`：**新开一个不可变版本**（旧版本 hash 与 `items_total` 不变，
  旧版本 items 查询拿不到新写入）。
- `version` 查询参数用 `version_hash`；`v1` 这样的名字会 404。

## 删除与正文上限（实测值）

- 删除 trace 会异步连带 span；删除后逐条查询最终全部 404（本 runner 轮询 ≤30s）。
- OTLP 请求体上限：**≥ 64 MiB（67,109,377 字节实测接受）未被拒绝**，探针到 64 MiB 封顶
  （nginx `client_max_body_size 2G`、Jackson `JACKSON_MAX_STRING_LENGTH 100M` 均高于此）。
  后续 adapter 不应依赖超过实测值的上限。

## Canary 策略

- 安全 canary（随机标记）必须出现在存储的 span 数据里，证明是真实往返而非 fixture。
- 禁止 canary（数据源凭据值 + 私钥头/假 token/假账号/原始附件标记，均不发送）必须
  不出现在任何请求、响应、诊断或落盘证据里；runner 对全部落盘证据做扫描，命中即失败。
  证据文件里只出现 canary 的**标签**（如 `env:OPIK_MYSQL_PASSWORD`），永不出现值。

## 关联

- Spec：`docs/specs/2026-10-14-opik-integration-design.md`（A1/A4/A11/A13）。
- 计划：`docs/superpowers/plans/2026-10-15-opik-t04-verified-contract.md`。
- 证据：`docs/plans/evidence/2026-10-15-issue4/opik-contract/`（manifest 在
  `47-manifest.json`；`attempts/` 保留了迭代过程中的失败证据）。
- `docker/opik/versions.json` 的 `compatibility.status` 仍为 `unverified`；本 manifest
  即 #10 允许翻转该状态的依据（翻转动作不在本任务文件所有权内）。
