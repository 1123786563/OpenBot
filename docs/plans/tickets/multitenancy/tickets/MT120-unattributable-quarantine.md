## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

无法唯一归属的外部状态进入可运维查看的隔离清单，并在清单非空时阻断多租户启用。

## Acceptance criteria

- [ ] 隔离清单列出对象、原因、发现时间与建议处置，可被运维查看。
- [ ] 清单非空时就绪判定失败并给出具体条目（与启动就绪强制一致）。
- [ ] 处置（归属或销毁）后清单相应更新，且处置留审计。
- [ ] 不会为了清空清单而按猜测分配归属（有反向测试）。

## Blocked by

- #162 外部线程、浏览器状态与向量命名空间迁移（MT119）

## Scope boundary

无法归属外部状态的隔离清单、处置流程与启用阻断；不含具体迁移实现。

## Verification

bun test server/tests/multitenancy/quarantine-list.test.ts + 隔离清单报告

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A8, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「外部状态迁移：文件、线程、浏览器、向量与无法归属隔离」拆出的第 3/3 段；上一段（外部线程、浏览器状态与向量命名空间迁移）完成并集成后再领取。
