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
