# Issue #4 A1–A13 证据映射 — 2026-10-24

| A | 内容摘要 | 覆盖子票 | 代码/测试指针 | 本轮证据状态 |
| --- | --- | --- | --- | --- |
| A1 | 禁用零影响 + 启用时真实实例收到有效安全记录 | #9,#10,#13,#14,#15 | opik-deployment.test.ts、opik-health.test.ts、opik-port.test.ts | E2E:禁用套件+启用接收(进行中) |
| A2 | 内置/LangGraph 层级与服务关联；其他远程路径 basic 标记 | #16,#19,#20,#21,#22,#23,#24 | opik-run-lifecycle.test.ts、opik-model-span.test.ts、opik-trace-chain.test.ts、opik-run-steps.test.ts | VBASE 绿 |
| A3 | 成功/失败/断流/取消/重试真实反映；早期返回不截断；提议≠执行 | #16,#19,#20,#21,#24 | opik-run-lifecycle.test.ts、opik-tool-steps.test.ts（fix4c 后 42/0） | VBASE 绿（tool-steps 待 fix4c 集成复核） |
| A4 | 秘密/canary/凭据/敏感字段不入存储、视图、样本、Judge、导出 | #11,#14,#20,#21,#26,#27,#29,#33,#38,#40 | opik-redaction.test.ts、opik-judge-scoring*.test.ts、opik-export*.test.ts | E2E:存储 canary 检查(进行中) |
| A5 | 创建者仅可达可管理 Bot；伪造/猜测/公开聊天不越权 | #7,#8,#12,#13,#16,#17,#18,#19,#24,#27,#34,#36,#38,#39,#42 | opik-scope.test.ts、observability-authz.test.ts(fix4d 在途)、opik-runs-query.test.ts、app route-chain/routes 测试(环境冻结) | VBASE 绿 + app 环境受限 |
| A6 | 汇总限权；移交/撤权影响历史查询、缓存、下载、排队 | #17,#18,#30,#39,#40,#41,#42 | opik-bindings*.test.ts、opik-export*.test.ts、opik-admin-summary*.test.ts(fix4b 在途) | VBASE 绿 |
| A7 | 同冻结数据集两配置可比；规则/Judge 可溯源；执行/评分失败可见 | #25,#26,#27,#28,#32,#33,#34,#36 | opik-datasets*.test.ts(fix4a 后绿)、opik-scoring-rules.test.ts、opik-judge-scoring*.test.ts、opik-results*.test.ts | VBASE 绿 |
| A8 | 评测不写生产数据；生产写工具拒绝；准入/预算/结算有证据 | #29,#31,#33,#36 | opik-execution-runner.test.ts、opik-execution-boot*.test.ts、opik-execution-billing*.test.ts、opik-executions*.test.ts | VBASE 绿 |
| A9 | 仅兼容实验可比；有效样本数、回归与底层执行可查 | #28,#32,#34,#35,#37 | opik-experiments*.test.ts、opik-comparison*.test.ts、opik-results*.test.ts | VBASE 绿 |
| A10 | Opik 故障/延迟/饱和不改正常结果；drop/ingest 故障可见 | #14,#15,#16,#18,#19,#30,#39,#40,#42 | opik-health.test.ts、opik-port.test.ts、admin-summary 故障边界(fix4b 在途) | VBASE 绿 |
| A11 | 保留/删除覆盖上游记录与导出；删除后私有 API/旧链接不可取 | #10,#13,#25,#40,#41,#42 | opik-retention*.test.ts、opik-export*.test.ts、0157/0158/0160 | VBASE 绿 + E2E 删除语义(进行中) |
| A12 | 双测试 scope 无租户表；同 ID 互不串；未知企业 scope 拒绝 | #12,#13,#25,#30,#39,#41 | opik-scope.test.ts、observability-authz.test.ts(fix4d 在途)、opik-bindings*.test.ts | VBASE 绿 |
| A13 | 宿主/容器/动态进程冒烟 + 真实 Opik 证明跨服务映射与父子关系 | #10,#14,#22,#23,#38 | opik-trace-chain.test.ts、opik-id-links*.test.ts | E2E:ID 映射冒烟(进行中) |

注：「VBASE 绿」= 2026-10-24 组合树服务器套件通过（明细 verification/）；「E2E(进行中)」= 真实自托管 Opik 2.2.100 取证（workers/e2e-real-instance-report.md）；app 渲染套件环境受限（见 ledger）。

「覆盖子票」口径 = GitHub Issue 号（#7–#43）。票面标题自带 T 序号（#n 即 [Opik T(n−6)]，与 DAG `2026-10-16-opik-issue4-dag.md` 节点 T 序号一一对应）；T37/#43 为终验节点，映射为整段 A1–A13，不在逐行单列。
