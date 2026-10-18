## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #206 T 迁移与收尾（本 Ticket 是其 sub-issue）

## What to build

对象存储中的业务文件、附件与产物按归属迁移或建立映射，路径规则与授权一致，迁移幂等可续跑。

## Acceptance criteria

- [ ] 每类文件都有明确归属或进入隔离清单，没有隐式默认归属。
- [ ] 迁移幂等可续跑；失败不留下半迁移状态被业务读取。
- [ ] 迁移后授权与签名下载仍正确（与既有规则一致）。
- [ ] 输出逐类计数与抽样校验报告。

## Blocked by

- #160 跨库一致性校验、断点续跑与回填报告（MT117）
- #98 产物与对象存储路径按归属隔离（MT055）
- #104 OpenMuse 文件、PDF 检视/填写/传输与个人工作区的作用域（MT061）

## Scope boundary

对象存储业务文件、附件与产物的归属迁移或映射；不含运行时状态与向量命名空间。

## Verification

bun test server/tests/multitenancy/external-files-migration.test.ts

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A12, A8, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：外部服务不可用时用确定性 fake 完成本地测试，并显式标记未验证项。 （原 Ticket 已按粒度要求拆为 3 段，本段为第 1 段。）
