# Issue #4 终审修复方案（FREV R1 findings）— 2026-10-24

- Run: 2026-10-24-opik-issue4 · 终审报告: `.archive/runs/2026-10-24-opik-issue4/reviews/final-review-codex.md`（总裁决 FAIL：7 阻塞 = 5 high / 2 medium；编排者抽验 FREV-01/03/05/07 代码点全部属实，7/7 裁决有效）
- 修复基线：集成分支 HEAD `0c9af72ba`（每任务从当前已验证 HEAD 派生分支）
- 完成定义：每任务 RED→GREEN + claude 独立审核 0 阻塞 + 集成组合验证（全量 opik 范围 0 真实失败）→ **重做完整 FREV（codex）+ OCR**

## 修复 DAG（按文件所有权分 4 流，流内串行、流间并行）

| 任务 | finding | 核心要求 | owned files（主） | 依赖 |
| --- | --- | --- | --- | --- |
| F5A1 span 正文治理 | FREV-01 (high) | 正文必须携带可信策略/审查证明才入库；无证明则省略（仅指标）；补非正则形状回归（邮箱/短口令经生产 recorder 的反例转绿） | span-support.ts、redaction.ts、model-span.ts（投影面） | — |
| F5A2 绑定前置+工具正文收口 | FREV-02 (high) + F5A1-R1-F2/F3 (medium) | 真实执行写 span 前建立本地权威 run binding（bindings.begin/finish 接入真实 builtin observer 链）；binding 缺失时导出 fail-closed；**tool/retrieval step 正文接入同一 contentApproval 治理**（F5A1-R1-F2：无此收口 FREV-01 不可关闭）；**opik-e2e-ingest 脚本断言更新**：正文 fail-closed 后 safeCanary 断言改走批准路径铸造（F5A1-R1-F3） | model-span.ts、index.ts（:7686/:7737 面）、opik-http.ts（OTLP 写门槛）、bindings.ts 接线、**tool-steps.ts、server/scripts/opik-e2e-ingest.ts** | F5A1 |
| F5B1 scope 稳定化 | FREV-03 (high) | 分离稳定资源 scope 与请求授权/缓存 epoch：数据地址由稳定资源身份派生（Bot 而非 actor+epoch）；访问时在稳定数据范围上重验当前资格（manage gate/所有权）；管理员可汇总管理范围内创建者数据；profile 更新/移交不迁移数据地址 | scope.ts、bindings.ts、wiring.ts、admin-summary.ts、routes/admin-summary.ts、受影响 queries/exports/测试 | — |
| F5C1 取消/准入 | FREV-05 (high) | AbortSignal 贯穿样本模型调用与 Judge（DB 取消可达中断）；inner 完成后启动 Judge 前重检任务未取消+授权未撤（RED：挂起期取消后 Judge 调用数为 0） | executions.ts、execution-runner.ts、scoring/judge.ts | — |
| F5C2 公共执行路径 | FREV-04 (high) | 评测 runner 装配被测 Bot 公共执行引擎/隔离 thread/工具 schema；toolFixtures 真实拦截 callTool 并影响输出与拒绝计数（#29 语义） | execution-runner.ts、execution-boot.ts、executions.ts（runner 面） | F5C1 |
| F5D1 删除完成判定 | FREV-07 (medium) | delete 请求 accepted 与 observed-absent 分离：markUpstreamDone 前必须经验证的有界查无；失败留 pending/failed 重试；定位保留至物理删除完成 | retention.ts、opik-http.ts（deleteTraces/deleteDataset 语义） | — |

## F5E1 真实链路证据（FREV-06，用户已裁决：补证据）

- **2026-10-24 用户裁决**：补完整环境真实执行证据（全套 auth/casdoor/provider + 真实 Agent run），不缩小交付声明。
- Wave 3 派发（F5A2/F5C2 集成后）：证据取自波二集成后的组合树，避免投影/绑定修复使证据失效。
- 验收面：A2（builtin+LangGraph 各一次真实工具/检索执行）、A13（宿主/容器/动态进程跨服务传播+ID 映射）、#22/#23/#43。
- 环境前置（已预检）：主 checkout .env 具备 OPENAI_*/CASDOOR_*/DATABASE_URL 全套；agent-langgraph `bun src/index.ts` 可起；casdir/postgres/opik 栈以独立 compose project（opik4-f5e1-*）隔离；宿主负载门槛 load<5。

## 门禁

- 每任务：修复前 RED 复现（含 finding 给出的反例形状）→ 最小正确修复 → 目标套件绿 → 报告（workers/f5*.md）+ 任务分支提交。
- 集成：编排者串行合并 + 全量 opik 组合验证（1094+/0 基线不回退）+ 受影响面 biome/typecheck。
- 终局：全部集成后重做 codex FREV（新 HEAD 冻结）→ OCR（BASE b117c3c3e..新 HEAD）→ 有效 findings 回环。

## FREV R2（2026-10-25）终裁 FAIL：6 阻塞 → 波四修复

报告 `reviews/final-review-codex-r2.md`：4 项原 finding 关闭（01/02/03/05），3 项部分解决（04/06/07 根验收未关），F5E1 三 finding 升级阻塞 + R2-01 新增。**全部按实现修复路线**（用户已裁决不缩小交付声明）。

| 任务 | finding | 关闭条件（摘自 R2 §5） | owned files | 流 |
| --- | --- | --- | --- | --- |
| F6A 循环预算强制 | FREV-R2-01 (high) | 每步走受控 billing/admission 或 case 级可强制总额 + 每步剩余输入/输出上界，额度不足不发下一步；真实 gateway 协议测试（第二步调用前拒绝/正常两步结算/取消未知费用按既有账本） | execution-runner.ts、execution-billing.ts、workshop/metering.ts（读取用）、executions.ts（结算面） | 1（前） |
| F6E 公共执行 seam | FREV-04 (high) | 抽出可隔离的公共执行 seam，同一冻结配置验证公共语义/fixture 拦截/零生产副作用（不装生产记忆不绕权限） | execution-runner.ts、execution-boot.ts、executions.ts、可抽出的共享层 | 1（后） |
| F6B 物化+清理定位 | F5E1-F3 (medium) + FREV-07 (medium) | 生产调用 createTrace 物化根/run；权威 reconcile opikTraceId；root span 与父子；retention 对 project=null/ok 不提前完成、保留定位至验证查无；补 project404 残留回归 | opik-http.ts、retention.ts、bindings.ts、queries/runs.ts(读面)、index.ts(接线) | 2 |
| F6C 观测去计费耦合 | F5E1-F1 (medium) | Opik 启用的 stock 启动在 billing 关闭时仍产生受治理事实（独立 observation wrapper），或经批准明确报告不支持（默认走前者） | copilot.ts、index.ts（meter/observation 装配面） | 3（前） |
| F6D remote 预算拨号 | F5E1-F2 (high) | 恢复经可信预算校验的 remote 拨号（不关安全防护）；或经批准范围变更（默认走前者） | copilot.ts、index.ts remote 面、budget 校验相关 | 3（后） |

门禁不变：RED→GREEN + 独立审核 0 阻塞 + 集成组合验证 → 再 FREV(R3) + OCR。

## FREV R3（2026-10-25）终裁 FAIL：5 阻塞 → 波五

报告 `reviews/final-review-codex-r3.md`。R2 六项：4 关闭（04/07/F1/F3 窄），2 部分（R2-01→R3-01、F2→R3-02）。R1 七项：6 关闭，FREV-06→R3-04。仍走实现路线。

| 任务 | finding | 关闭条件（R3 §5） | 流 |
| --- | --- | --- | --- |
| F7A 全量逐步预算 | R3-01 high | 每个实际 doStream 都逐步预算（不按业务白名单）；输入按批准保守口径强制或显式拒绝；输出默认受 policy 约束；空白名单+state 工具 scripted SSE 反例（第二步余额不足不拨号） | 1 |
| F7B 物化意图持久 | R3-05 medium | 确定性上游身份/物化意图持久化并在删除时验证；null 不得推断 local-only；未知 pending/failed；补 create/root 成功+reconcile 失败无后续 fact→过期清理回归 | 2（前） |
| F7C builtin 终态接线 | R3-03 medium | 公共 builtin 事件入口记录真实 start/terminal（success/error 区分）；工具 fact 不提前终结 run；首终态优先；断连才 unknown；补无工具成功/工具后成败/取消/断连/重试的 list/detail/根时间回归 | 2（后） |
| F7D remote 可强制合同 | R3-02 high | 受支持端点接可强制的预算/能力合同（本仓 agent-langgraph 可实现端点侧执行），无法校验仍拒绝；不借 generic policy 配置；补经 OpenBot 默认 LangGraph 真实执行 | 3 |
| F7E 冻结树全链证据 | R3-04 medium | 修复后冻结组合树补完整环境真实证据（stock builtin + 经 OpenBot LangGraph、工具 ID 对应、跨服务父子、多次 run 定位）；缺失保留 GAP 不相加局部 PASS | 4（终） |

## FREV R4（2026-10-25）终裁 FAIL：4 阻塞（全 medium，high/critical=0）→ 波六

R3 五项全部 CLOSED。R4 剩余：R4-01 W3C 跨服务链非确定（3/9）、R4-02 默认系统 Bot 观测域缺席（systemOwned 规则复用到观测域）、R4-03 真实业务工具 call ID 无治理 span、R4-04 A7/A9/A11 实环境证据缺。非阻塞：查询面 usage 聚合（可披露后续）、F7E-F3 low。

| 任务 | finding | 关闭条件（R4 §4） | 流 |
| --- | --- | --- | --- |
| F8A W3C 链确定化 | R4-01 medium | 解释 runtime 调度/上下文断点并使受支持人面执行同链；两类身份（driver 供给 / 派生）+ 默认 Bot 多 run 真实 Opik 验证；保留原始 span 父子与拨号数据；不伪造 trace | 1（前） |
| F8C 业务工具关联 | R4-03 medium | 真实可观察业务工具/检索全链证据；按可信事实记录 proposed/receipt/unobserved（绝不伪造 executed）；真实 call 不得从治理步骤消失 | 1（后，同 copilot.ts 区） |
| F8B 默认 Bot 观测域 | R4-02 medium | 以明确授权边界设计默认 Bot 观测 scope（不牺牲隔离、不放开编辑权）；默认 Bot 查询+上游关联同时恢复 | 2 |
| F8D 终证据波 | R4-04 medium + F8A/B/C 真实复核 | 冻结树补 A7（同冻结集两配置+Judge 真机闭环）、A9（退化回链）、A11（全存储/导出/备份与故障恢复，无备份给拓扑证明）；并对 F8A/B/C 修复做真实环境复核 | 3（终） |
