# #704 生产首条接线装配 — 实施计划（M-7 + C6）

日期：2026-10-29。Run：`.archive/runs/2026-10-29-tier-cases-1ec4358c/`。BASE=main@efb30cccd。
来源：closure2-debt-ledger M-7 + C6（MOD04 生产接线延后族）；票 #704（GitHub 1123786563/OpenBot）。

## 目标

对 M-7（credentialLease 链不可达 + 无消费者 operator 连接池）与 C6（readPinnedSkills 生产接线）逐项作出**接线或具名移除**的裁决并落地；保 MOD04 门面合同（`RuntimeAssembly` 接口与既有装配语义不变）；每项裁决附行为/钉证据。

## 事实源与约束

- 原始发现：MOD25 收口 OCR r2（`server/src/assembly/runtime.ts:1430-1432` 时代行号）：旧 index.ts 六个 `export const`（personalShareRules、credentialOwnership、pluginCatalog、oauthState、credentialLease、sharedApprovals）迁为 `assembleRuntime()` 函数局部量后无消费者；operator URL 配置时各块独立 `verifyOperatorDatabase(createDatabase(operatorUrl))` 开池。
- 票面验收：每项接线/移除决策 + 行为测试；保 MOD04 门面合同。
- 约束：`server/src/enterprise/tenancy/*` 服务模块与其 multitenancy 套件**不在**移除范围（仅移除 assembly 内不可达构造）；不动 `RuntimeAssembly` 接口形状；不动 #706 已落地的 startup/stop 注册合同。

## 消费面审计（2026-10-29，main@efb30cccd 实测）

| 项 | 现状证据（runtime.ts 行号@BASE） | 裁决 | 依据 |
| --- | --- | --- | --- |
| personalShareRules | :1677 构造；全文件零读取点 | **具名移除** | 无消费者；构造含独立 operator 池（:1681）；服务模块与套件（`server/src/enterprise/tenancy/personal-share-rules.ts`、`server/tests/multitenancy/personal-share-rules.test.ts`）保留，后续票按需重建装配 |
| credentialOwnership | :1703 构造；零外部读取点 | **具名移除** | 同上（MT027/#70 缝在 assembly 层从未可达；credentials-ownership 套件直接构造服务，不受影响） |
| oauthState | :1883 构造；零读取点 | **具名移除** | 同上 |
| credentialLease | :1904 构造；唯一读取=:1945 被 sharedApprovals 引用，而 sharedApprovals 自身零消费者（链式死代码） | **具名移除** | 链整体断裂；credential-lease 套件（support/credential-lease.ts）直接构造，不受影响 |
| sharedApprovals | :1931 构造；零读取点 | **具名移除** | 生产审批流走 createServerApprovalService（approvals/wiring），本块为不可达重复缝 |
| pluginCatalog | :1741 构造；:1776 守卫 + :1807 `catalogDecisions: pluginCatalog.decisions` 实际消费 | **保留（已接线）** | MOD25 时代后已获消费者；移除将破坏插件包市场线 |
| readPinnedSkills（C6） | `enterpriseRunner` 组合 :3561 `readPinnedSkills: packageRuntime.readPinnedSkills` | **保留（已接线，补钉）** | C6 登记时的"仅测试钉"已被后续组合接线消除；行为证据在 `server/tests/multitenancy/package-runtime.test.ts`（452–633 直接实跑）；assembly 侧补源级钉防回归 |

## 任务分解

- **T1 裁决落地**：移除五个死块（含各自 operator 池）；在原址留一行具名移除注释（票号+去向）；pluginCatalog/readPinnedSkills 不动。
- **T2 钉与测试**：新增 `server/tests/module-runtime-wiring.test.ts`（Node 原生收集，源级钉——runtime.ts 不可在 Node 进程加载，ADR 0008 同款两层模式）：
  - 五个死块标识符不再于 runtime.ts 构造；
  - `readPinnedSkills: packageRuntime.readPinnedSkills` 在生产组合内（C6）；
  - pluginCatalog 仍被 `catalogDecisions` 消费；
  - `verifyOperatorDatabase` 剩余调用点数与保留块一致（防止死池回潮）。
- **T3 验证**：server tsc 0；biome 改动文件零新增；受影响六套件（personal-share-rules、credentials-ownership、tool-invocation、public-bot-usage、not-found-semantics、package-runtime）与 module-runtime-lifecycle、module-http-assembly 与 main 基线同形或更绿。
- **T4 独立验证与 Review**：独立会话复核消费面审计（逐名 grep 证伪"零消费者"结论）+ 跑 T3 套件；独立 Spec/质量 Review。报告分列。
- **T5 收尾**：OCR 不适用（用户 2026-10-20 裁决：中间轮不跑 OCR，最终提交前完整范围一次；本轮无最终提交交付）；integration_pending（无推送授权）。

## 风险与回退

- 移除块内含 fail-closed 语义注释（MT027 等）：语义随服务模块保留，assembly 重建时从本计划与 git 历史恢复。
- 若审计结论被独立验证推翻（发现真实消费者），回退对应块并改裁决为接线。
