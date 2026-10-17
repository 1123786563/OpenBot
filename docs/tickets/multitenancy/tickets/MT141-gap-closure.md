## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

汇总全部覆盖证据中的缺口与未验证项，关闭可修复缺口，并把真实阻塞项显式列出。

## Acceptance criteria

- [ ] 缺口清单逐项有处置结论：已修复并重验、或标记为阻塞项。
- [ ] 存在真实阻塞项时不进入后续审查与候选包阶段。
- [ ] 隔离清单与未验证项被完整列出，不含隐式豁免。
- [ ] 处置证据可被独立复核。

## Blocked by

- #164 冻结写入、备份恢复、失败隔离与回退程序（含演练）（MT121）
- #173 Worker 与后台装配去默认公司（MT130）
- #177 覆盖证据：插件审批、知识与记忆（MT134）
- #179 覆盖证据：Craft/Workshop、OpenMuse 与删除恢复（MT136）
- #181 覆盖证据：治理、审计与观测出口（MT138）
- #183 覆盖证据：桌面与移动端（MT140）

## Scope boundary

缺口与未验证项汇总、可修复缺口关闭与阻塞项清单；不含审查与候选包。

## Verification

bun test server/tests/multitenancy/gap-closure.test.ts + 缺口清单文档

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：这是唯一可以声称「统一上线就绪」的 Ticket；证据优先于结论。 （原 Ticket 已按粒度要求拆为 3 段，本段为第 1 段。）
