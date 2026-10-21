# OpenBot 可观测性体系设计（日志跟踪）

> 版本：v1.0 ｜ 日期：2026-10-10
>
> 状态：设计经讨论确认，待实施计划。本文覆盖日志、请求跟踪、链路、指标与全端崩溃上报；告警与 SLO 为后续工作。

## 0. 决策摘要

1. **方案 A：stdout 为本 + 采集器搬运**。应用侧只做两件事：统一 logger 输出 JSON 到 stdout；OTel SDK 产出 traces 推给 Tempo。日志由 Grafana Alloy 收集进 Loki，应用对采集器零依赖。
2. **自托管观测栈进 compose**：Grafana + Loki + Tempo + Prometheus + Alloy + GlitchTip，组成 `observability` profile（沿用 `lago` profile 模式，默认不启动）。
3. **崩溃上报用 GlitchTip**（Sentry SDK 协议兼容、轻量自托管），Web / mobile / 桌面三端接入。
4. **Bun + OTel traces 兼容性是唯一硬风险**，用 spike 前置验证，失败降级为手写 trace id 透传，对外接口不变。
5. **metrics 不赌 OTel metrics SDK**，v1 用 prom-client 暴露 `/metrics`。
6. **全端一步到位**，但按 P1–P5 分期交付，每期独立可合入。

## 1. 背景与现状（2026-10-10 调研结论）

- **无日志框架**：server/worker/supervisor/agent-bot/agent-computer 等全部裸 `console.*`（server 约 150 处，纯文本与 JSON 风格混杂）；runtime-go 用 `log.Printf`。无级别控制；Helm 注入的 `LOG_LEVEL` 无代码消费。
- **无请求级跟踪**：主 app（`server/src/app.ts`）无 requestId、无 access log 中间件；唯一的 `x-request-id` 在企业版 `onError`（`server/src/enterprise/app.ts:68-86`）错误时才生成；server ↔ agent-bot/computer/worker/runtime-go 之间无关联 ID 传播。
- **OTel 覆盖极窄**：仅审计日志经 OTLP Logs 单向导出（`server/src/telemetry/otel.ts`，`OPENBOT_OTEL_EXPORT` 控制）；无 traces、无 metrics。该通路在 Bun 上已验证可行。
- **客户端零可观测**：Web（app/）6 处 console、mobile（Expo）0 处、桌面（Tauri）仅产品遥测（`desktop/TELEMETRY.md`）；三端均无崩溃上报。
- **落点无人管**：容器走 docker 默认 json-file；宿主机进程被 `scripts/start.sh` 重定向到 `.logs/*.log` 且用 `>` 每次覆盖。
- **既有方向**：企业平台设计文档（`2026-10-09-enterprise-ai-platform-design.md` §20）规划 "OpenTelemetry + Prometheus / Grafana + 日志与 Trace 后端"；tenancy 计划（TEN-22）已固化"对外错误含 code/request_id/retryable、日志脱敏、不输出原始 DB 报错"的约定。本设计是该规划在当前部署形态下的落地。

## 2. 目标与非目标

**目标**

1. 任一进程的日志：统一格式、可按级别过滤、带 request/trace 关联 ID、可检索。
2. 一次用户请求（聊天/工具调用）跨 server → agent-* → computer → LLM 端点的完整链路在 Tempo 可见，日志在 Loki 可按 trace_id 串起。
3. 核心 HTTP/LLM 指标进 Prometheus，Grafana 起步 dashboard 开箱即用。
4. Web/mobile/桌面崩溃与错误进 GlitchTip，带版本归因与脱敏，且可整体关闭。
5. 本地裸跑（不起观测栈）时，stdout/`.logs` 仍是完整可用的事实源。

**非目标（本轮不做）**

- 告警规则与 SLO 定义。
- Sentry 全家桶能力（performance/session replay/profile）。
- 第三方镜像（lago、casdoor、open-connector、spire）的日志治理。
- OTel metrics SDK 迁移、日志计费、日志型合规留存策略。
- 客户端性能监控（APM）。

## 3. 架构设计

### 3.1 日志层：统一 logger

- 新建 `shared/logger`：pino 封装，各 workspace（server/worker/supervisor/agent-bot/agent-computer 等）统一引用，导入方式随 shared 现有共享机制。
- 级别：`LOG_LEVEL`（兼容 `OPENBOT_LOG_LEVEL` 别名），默认 `info`；Helm 既有注入从此生效。
- 输出：开发态 TTY 走 pino-pretty；落文件/compose 一律 JSON 单行。Bun 上 pino transport（worker 线程）如有问题，回退为"dev 也输出 JSON + 本地用 jq/Grafana 看"，不影响主体。
- 子 logger 携带固定上下文：`service`（进程名）、`request_id`、`trace_id`、`tenant_id`（企业态可用时）。保留现有 `type: "xxx-error"` 事件命名惯例作为约定字段（如 `approval-resume-error`）。
- 现有约 150 处裸 `console.*` 逐步替换为本期或后续清理项；**新代码禁止裸 console**，以 ESLint `no-console`（允许 `console.error` 用于 logger 自身失效的兜底）在 server/worker 等包生效。
- 脱敏沿用 `logRedactedSecurityError`（`server/src/enterprise/bootstrap.ts`）与 TEN-22 约定：不输出原始 DB 报错、密钥、token。

### 3.2 请求跟踪与传播

- 主 Hono app 新增两个全局中间件（注册于 cors 之后）：
  - **requestId**：入站带 `x-request-id` 则沿用，否则 `crypto.randomUUID()`；写回响应头。企业版 `onError` 改为复用该 ID，不再自行生成。
  - **access log**：每请求一行 `method / path / status / duration_ms / request_id / trace_id`，级别 `info`；`/health` 等探针路径静默。
- 跨服务传播用 W3C `traceparent`：server 对 agent-bot / agent-computer / worker / runtime-go 的出站调用统一走 `tracedFetch` 帮手注入头；各服务解析后续接（traces 部分见 3.3，纯日志场景下即使无 OTel 也透传 `x-request-id`）。
- runtime-go 使用官方 `go.opentelemetry.io/otel` SDK 接续 span 并在日志带 trace_id。

### 3.3 OTel traces 与 metrics

- **spike 前置**（P2 第一步，半天盒）：在 Bun 上验证 "Hono 入站中间件起 span + 手动子 span + `traceparent` 解析 + OTLP 导出 Tempo" 全链。auto-instrumentation 不作依赖（Bun fetch 非 undici，大概率不可用）。
  - 通过：server 以 `@opentelemetry/sdk-trace-node` + 手动/中间件 span 落地；LLM 调用、computer 动作、webhook 入口等关键边界打手动 span。
  - 失败：降级为自管 trace id（生成/解析 `traceparent` + ALS 存取），Tempo 中无 span 但 Loki 日志仍按 trace_id 关联；接口（中间件 + `tracedFetch`）不变，后续 Bun 成熟后可无痛升级。
- **metrics**：prom-client 暴露 `/metrics`（仅内网），起手指标：HTTP 请求计数/时延直方图（按路由模板）、LLM 调用计数/时延/tokens（按模型）、agent 队列深度。OTel metrics SDK 待 Bun 支持成熟后再议。
- 审计 OTLP Logs 导出（`OPENBOT_OTEL_EXPORT`）原样保留，与 traces 导出（`OTEL_EXPORTER_OTLP_ENDPOINT`）互不干扰。

### 3.4 采集层与 start.sh 修正

- 新增 **Grafana Alloy** 容器（仅 observability profile）：
  - 经 docker socket（**只读**挂载）收集带发现标签的容器 stdout → Loki；
  - bind-mount `.logs/` tail 宿主机进程文件 → Loki；
  - 打上 `service`（容器名/文件名推断）、`deployment_id` 等标签。
- 修 `scripts/start.sh`：`>` 改 `>>`，不再覆盖历史日志。
- 应用侧对 Alloy 零依赖：观测栈停机时 `docker logs` 与 `.logs` 照常，恢复后仅中间时段缺采集。

### 3.5 observability compose profile

- `docker-compose.yml` 新增 profile `observability`，默认不启动；`docker compose --profile observability up -d` 一键起全栈。
- 组件与端口（避开已占用：3000 web / 3001 server / 8000 casdoor / 8081-8082 openmuse）：

| 组件 | 端口 | 用途 |
|---|---|---|
| Grafana | 3003 | 检索/看板入口 |
| Loki | 3100 | 日志 |
| Tempo | 3200（OTLP 4318） | 链路 |
| Prometheus | 9090 | 指标 |
| Alloy | （内部） | 采集 |
| GlitchTip | 8001 | 崩溃上报（自带独立小 Postgres，不碰主库；celery 用同步模式最小化容器数） |

- Grafana datasources（Loki/Tempo/Prom，含 Loki→Tempo 的 trace_id 衍生链接）与一张起步 dashboard 用 provisioning 文件内置：HTTP 错误率/时延、日志量按级别/服务、LLM 调用与 tokens。
- 数据留存给保守默认（Loki/Tempo 各 ~7 天），后续按需调。

### 3.6 全端崩溃上报（GlitchTip）

- SDK 选型：Web `@sentry/react` + Vite sourcemap 上传；mobile `@sentry/react-native`（expo 插件方式配置）；桌面 Rust 侧 sentry crate 抓 panic + webview JS 错误经现有错误边界（`ToolRenderBoundary`）转发。
- DSN 经 env 注入（`VITE_SENTRY_DSN` / `EXPO_PUBLIC_SENTRY_DSN` / 桌面构建配置），指向 GlitchTip。
- 隐私开关：新增 `OPENBOT_CRASH_REPORTING_DISABLED`（呼应现有 `DO_NOT_TRACK` / `COPILOTKIT_TELEMETRY_DISABLED` 惯例），三端统一尊重；`beforeSend` 做 PII 脱敏，未配置 DSN 时静默禁用。
- 已知限制（P3 用测试事件验证）：GlitchTip 对 sourcemap 与原生崩溃为部分支持；不满足时的降级预案：Web sourcemap 仅本地符号化、mobile 原生崩溃接受聚合降级或单独评估。

### 3.7 约定文档

新增 `reference/observability.md`：级别语义、上下文字段约定、脱敏规则（对齐 TEN-22）、trace 传播约定、本地看日志的两条路径（Grafana 3003 / jq 直读）、崩溃上报开关说明。同步更新 `reference/development.md` 与 `.env.example`。

## 4. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| Bun + OTel traces SDK 兼容性未证 | 高 | P2 首项半天 spike；降级路径为自管 trace id 透传，接口不变 |
| pino transport（pretty）在 Bun 的 worker 线程问题 | 低 | 仅影响 dev 美观输出；回退 JSON + jq |
| GlitchTip sourcemap/原生崩溃部分支持 | 中 | P3 以三端真实测试事件验证，预案见 3.6 |
| Alloy 挂载 docker socket 的安全面 | 中 | socket 只读 + 仅 observability profile 启动 + compose 内网 |
| console → logger 替换面广（~150 处） | 低 | 只强制新增代码；存量按 P1 主干路径先换，长尾渐进 |
| 端口冲突 | 低 | 已避开已知占用段；起栈前脚本校验 |

## 5. 分期交付

- **P1 主干**：shared/logger + server/worker 接入 + requestId/access log 中间件 + start.sh 修正 + no-console lint + 文档初稿。纯应用侧，无新组件。
- **P2 链路**：Bun OTel spike → 按结论落地 traces（或降级透传）+ `tracedFetch` + agent-*/runtime-go 接续。
- **P3 起栈**：observability profile（LGTM + Alloy + GlitchTip）+ provisioning + 三端测试事件验证崩溃链路。
- **P4 指标**：prom-client `/metrics` + 起步 dashboard。
- **P5 客户端**：Web/mobile/桌面崩溃上报正式接入 + 隐私开关 + 文档收尾。

每期独立可合入；P1 完成即解决"本地排障"的最低诉求。

## 6. 验收标准

1. **P1**：server/worker 全部日志经 logger 输出 JSON 单行；每个 HTTP 响应带 `x-request-id`；每请求一条 access log；`.logs` 不再被覆盖；新代码 no-console 规则生效。
2. **P2**：spike 结论有据（通过或降级及原因）；一次跨 server→agent-bot→computer 的请求在 Tempo 呈现连续 trace（或降级后 Loki 日志可按 trace_id 串联）。
3. **P3**：`--profile observability up` 后数秒内日志出现在 Loki；Grafana 从日志可跳转 Tempo；Web/mobile/桌面各一条测试崩溃事件出现在 GlitchTip 并带版本号。
4. **P4**：Prometheus 抓到 `/metrics`；dashboard 呈现错误率、时延、LLM 调用量。
5. **P5**：三端崩溃上报带 `OPENBOT_CRASH_REPORTING_DISABLED` 开关验证有效；`reference/observability.md` 发布。
