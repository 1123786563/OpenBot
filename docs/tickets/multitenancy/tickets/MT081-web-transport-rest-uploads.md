## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

REST 请求、上传通道与下载签发统一附加当前公司/团队选择，且只发送给已审核的同源业务路径。

## Acceptance criteria

- [ ] 真实 client 调用中业务路径请求带有正确选择标识（传输层测试）。
- [ ] 非同源或未审核路径不附加标识（有反向测试）。
- [ ] 上传与下载签发走同一附加逻辑，不各自实现。
- [ ] 允许路径清单与例外登记可对照核对。

## Blocked by

- MT080 Web 公司与团队选择界面及无资格空状态
- MT056 签名下载与代理访问在签发点和访问点都授权，撤销即停止

## Scope boundary

REST 与上传下载签发的范围附加及允许路径审核；不含流式连接。

## Verification

bun test app/tests/multitenancy/transport-rest.test.tsx

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A10, A6, A3。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：允许路径清单需要与 MT030 的例外登记对照；发现不一致先统一清单。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
