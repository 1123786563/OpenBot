## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

每次业务访问都由集中授权入口判定「有效公司成员资格 + 有效团队成员资格」，并在同一业务事务内重验；撤权后的下一次请求立即失效。客户端提交的公司/团队标识只用于选择，不作为授权依据。

## Acceptance criteria

- [ ] 只有签发入口能产生 Scope；伪造或反序列化的 Scope 被拒绝（有专门测试）。
- [ ] 缺少公司或团队上下文时明确拒绝，不回退默认公司或第一个团队。
- [ ] 团队成员被移除或停用后，同一事务后续步骤与下一次请求都被拒绝。
- [ ] 公司成员被暂停后，其在该公司的全部团队资格立即失效，但在其他公司的资格不受影响。
- [ ] 授权判定只依赖服务端事实；请求头里的公司/团队值被篡改不改变结果。

## Blocked by

- MT002 多公司多团队测试身份夹具与受限角色数据库 harness
- MT004 团队成员关系数据模型与复合约束

## Scope boundary

可信公司 Scope 签发、团队资格校验、事务内重验与版本比较。

## Verification

bun test server/tests/multitenancy/team-eligibility.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A5, A6。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：这是全系统授权 seam 的落点；下游 Ticket 只调用它，不要另造可见性判断。
