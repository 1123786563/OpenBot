# Ticket #380 独立只读审阅 — 自托管 Hindsight 服务与隐私配置

- **审阅人**：独立只读 Review Agent（Orca 派发）
- **审阅时间**：2026-10-15T17:0x–17:2xZ
- **审阅对象**：工作区 `/Users/wuyongjun/orca/workspaces/OpenBot/hs03-selfhost-service`（HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，tracked diff 为空，11 个未跟踪交付文件 + 1 个 git-ignored 实值 `hindsight.env`）
- **被审报告**：`reports/ticket-380.md`
- **事实源**：Spec `docs/specs/2026-10-15-hindsight-personal-memory-design.md`、ADR 0005、`dag.json` 节点 380、`issue-snapshots/issue-380.json`
- **纪律遵守**：只读；未修改工作区任何文件；未 commit/push；未动运行容器配置（容器 env 只读查看，SQL 仅只读 SELECT，健康场景复测经 env 覆盖与死端口模拟完成，未 stop 容器、未杀 standin）。

## 结论

| 维度 | 结论 |
| --- | --- |
| Spec 合规（逐条验收） | **PASS**（3/3 验收标准均有运行态证据支撑） |
| 代码质量 | **PASS**（无阻塞缺陷；findings 均为 LOW/INFO） |

报告 `ticket-380.md` 的关键声明（哈希表、边界实测、真实 API 形状修复、三态探测输出）经独立复跑**全部复现**，无夸大或失实。

## 独立复跑证据（本审阅亲自执行，非转录报告）

1. **哈希表**：12 个文件 sha256 逐一重算，与报告表格**完全一致**（含 git-ignored 的 `hindsight.env` = `4eab36c5…03afb`）。
2. **测试与类型**：`bun test server/tests/hindsight-config.test.ts server/tests/hindsight-health.test.ts` → **21 pass / 0 fail / 50 expect**；`cd server && bunx tsc --noEmit` → exit 0。
3. **容器与端口**：`docker ps` → `openbot-hindsight Up (healthy)`，`127.0.0.1:8888->8888`；`docker port` → 仅 8888 一条映射，**9999 无发布项**。镜像 digest `sha256:a88678c0…e4c` 与报告/README 一致。
4. **隐私三重证据**：
   - 容器运行 env（`docker exec … env` 实读）：`LLM_TRACE_ENABLED=false`、`OPERATION_RETENTION_DAYS=1`、`CLEANUP_INTERVAL_SECONDS=900`、`ENABLE_BANK_LLM_HEALTH=true`，LLM 与 embeddings base URL 均唯一指向 `http://host.docker.internal:9100/v1`；
   - `GET /version`（带 key）：`api_version 1.0.0`、`features.llm_trace=false`、`bank_llm_health=true`、`audit_log=false`；
   - 内嵌库只读查询：`llm_requests=0`、`async_operations=0`、`documents=0`、`memory_units=0` —— **内容追踪关闭为运行时事实，非仅配置声明**。
5. **鉴权**：无 Authorization `POST /v1/default/banks/default/health/llm` → `401 {"detail":"Authentication failed: Invalid API key"}`。
6. **健康探测复测**（`bun run ../deploy/hindsight/test/verify-health.ts`，standin 9100 在跑）：
   - `happy` → `service_up, version 1.0.0`，exit 0（真实经网关 provider 调用成功，反向证明 gateway 探测路径端到端可用）；
   - `bad-config`（env 覆盖 `TRACE=true` 声明）→ `config_noncompliant, violations=["llm_trace_enabled"]`，exit 0，**未联网、未动容器**；
   - `service-down`（API_URL 指向死端口 59999）→ `service_down`，exit 0；
   - `gateway-down` 未由本审阅强制复现（避免杀共享宿主进程）；由单测两条 gateway_down 用例（连接失败、`ok:false`）+ 报告 16:07Z 实测记录覆盖。
7. **backup 边界复测**（/tmp 临时目录，不触仓库）：`find -mtime +30 -delete` 对 29 天副本保留、31 天副本删除 —— 与报告"29/31 边界实测"一致。
8. **backup.sh 动态解析**：按同法读取容器 `instance.json`，得到 `/home/hindsight/.pg0/installation/18.1.0/bin/` + 用户/密码/库名，解析逻辑与实际布局吻合（版本升级自适配的设计成立）。
9. **密钥隔离**：`git check-ignore -v` 确认 `hindsight.env`、`backups/` 被 `deploy/hindsight/.gitignore` 覆盖；全仓 grep `localtest-hindsight-key` 仅命中 git-ignored 的 `hindsight.env`；`hindsight.env.example` 仅含 `change-me-*` 占位符。**隔离测试值不泄漏进任何将入库的交付物。**

## Spec 合规逐条核验

### AC1 固定真实验证版本；API/控制台不暴露 — PASS

- 镜像 pin `ghcr.io/vectorize-io/hindsight:1.0.0`，index digest 实测一致；compose 无 `latest`。
- 8888 仅 loopback 发布，9999 完全不发布（compose 无条目 + `docker port` 实证）——终端用户与公司管理员均无直连路径。
- 无 key 请求 401 实证；ApiKeyTenantExtension 在容器 env 中生效。

### AC2 模型调用经已批准网关；追踪关；载荷 1 天；备份 ≤30 天 — PASS

- 运行 env 唯一模型出口 = 9100 网关端点（LLM + embeddings 双确认；reranker 进程内）；standin 日志（报告）证明调用确实经该端点，无旁路。
- 追踪关闭：声明（env）+ feature 开关（/version）+ 行为零留存（llm_requests=0）三重证据成立。
- `OPERATION_RETENTION_DAYS=1` 运行 env 实证。
- 备份：脚本拒绝 >30 与非数字（exit 1，报告实测）；sweep 边界 29 留 / 31 删复测一致。**boundary 注记见 F1**：`-mtime +30` 语义下副本最长存活约 31 天（日 cron 最坏 ~32 天），声明的 30 天窗口是"删除 >30 天副本"，不是"存在期 ≤30 天"；报告如实记录了实测边界，不构成失实，但如需严格"存在期 ≤30 天"应改 `-mtime +29`。
- 网关为 standin 而非 Bifrost：符合计划前提（bifrost-5/01.1 未交付、子模块未部署），standin 头注 + README 双处声明仅限隔离本地验证、"Never point production at it"，生产切换清单（真实 Bifrost URL/key、强随机 API key）已列入报告遗留项。本票证明的是"单出口 + 协议路径 + 隐私行为"，与 Spec"复用已批准网关"的实施分阶段一致。

### AC3 健康检查区分服务可用/网关不可用/配置不合规，且不返回记忆内容 — PASS

- 四态实现：三态必备 + 诚实的 `service_down`（呼应 Handoff notes"不把服务不可用误报为网关问题"的反向要求：不把服务 down 混入网关结论）。恢复语义：报告含 stop→up 循环实测；本审阅复见容器 healthy + happy 复测通过。
- 合规优先序合理：noncompliant 无需联网即可报（本审阅实证）；service 可达才下网关结论。
- "不返回记忆内容"断言充分：状态对象仅 `state/checkedAt/version/violations`；单测显式断言精确键集 + 不含 token/gateway key；网关探测经 Hindsight 自有 bank health 端点，仅回状态不回 provider/key/原文；违规只报规则名不报配置值。探测真实发起一次 provider 调用（经 9100 实证），"gateway reachable"语义是"Hindsight 能真跑模型调用"而非"端口开着"。

## Findings（分级）

| # | 级别 | 发现 |
| --- | --- | --- |
| F1 | LOW | **备份边界语义**：`find -mtime +30` 仅在 floor(年龄)≥31 天时匹配，副本最长存活 ~31 天（日 cron 最坏 ~32 天）。声明值 30 与 Spec"至多 30 天保留窗口"一致，sweep 机制存在且实测有效；若后续票据要求严格"存在期 ≤30 天"，改 `-mtime +29` 并补一条 shell 边界测试。 |
| F2 | LOW | **合规判断基于镜像声明而非运行时认证**：`config_noncompliant` 读 OpenBot 侧 `HINDSIGHT_PRIVACY_*`，容器若声明与实践漂移（声明 false、运行 true）不会在 health 中暴露——`/version` 的 `features.llm_trace` 已被取回但仅用于展示。AC 字面满足（且三重运行证据已人工闭环），建议 Wave 2 在 health 中交叉核对 runtime features 与声明，把镜像漂移升级为 noncompliant。 |
| F3 | LOW | **example 默认网关 URL 是容器内不可达值**：`hindsight.env.example` 默认 `http://127.0.0.1:9100/v1`，容器内 127.0.0.1 指容器自身；本机实测可用值是 `host.docker.internal:9100/v1`。照抄 example 会得到连接拒绝（fail loud，安全方向），但 README/example 宜加一句 host-gateway 提示。 |
| F4 | INFO | 计划 dag.json files 列含 `client.ts 骨架`，未交付；dag 的 interfaces_produced 与验收均不要求它，属无害范围偏差，建议在 ledger 记录一句。 |
| F5 | INFO | standin 无鉴权、固定响应，符合其定位；默认绑 127.0.0.1，容器可达需显式 `--host 0.0.0.0`（仅本机隔离场景）；README 明令生产禁用。生产清单（Bifrost URL/key、强随机 API key、9999 不发布复核、backup cron）已在报告遗留项中。 |
| F6 | INFO | 小测试空隙：`operations=[]` → gateway_down 的保守路径与 version 缺失路径无用例；backup.sh 无 bun 层测试（shell 实测证据在报告）。不阻塞。 |
| F7 | INFO | 探测 URL 硬编码 `/v1/default/` 段，1.0.0 pin 下实测有效；版本 pin 正是该耦合的对策。 |

## 与事实源的一致性

- 交付物全部落在 dag 380 声明的所有权范围（`deploy/hindsight/**`、`server/src/hindsight/**`、`server/tests/hindsight-*.test.ts`），未触碰 `server/src/memory/**`。
- Spec/ADR 0005 的隐私底线（追踪关、载荷 1 天、备份 ≤30 天、显式声明缺失即不合规）在 config.ts 中逐条硬编码并有测试；"不把服务可用误报为租户隔离/召回可用"在 README Explicit non-goals 中显式声明，与 #380 Handoff notes 一致。
- ADR 0005 的分阶段要求（"受控副本清除完成"需实际清理+备份过期+恢复重放证据）被正确列为后续票据，本票只交付配置与 sweep 机制，无越权宣称。

## 最终判定

- **Spec 合规：PASS** — 三条验收标准均以可复现的运行态证据闭环（本审阅独立复跑成功）。
- **代码质量：PASS** — 模块边界清晰（声明/校验/探测分层）、fail-loud 错误处理、超时控制（AbortSignal）、状态对象防泄漏设计良好；无阻塞缺陷。
- 建议将 F1/F2 作为 Wave 2 的小改进项带入后续票据；F3 一句话补文档即可。
