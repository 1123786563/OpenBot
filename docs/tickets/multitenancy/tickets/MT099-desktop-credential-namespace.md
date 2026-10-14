## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

桌面凭据按组织命名空间隔离，个人 provider 连接保留独立空间；OAuth state 与恢复绑定发起 authority。

## Acceptance criteria

- [ ] 组织凭据与个人 provider 凭据分命名空间存储，互不可读。
- [ ] 个人连接不会被当作公司付款方或公司业务凭据使用。
- [ ] OAuth state 与恢复绑定发起 authority；回调期间切换组织不改变归属。
- [ ] 命名空间清理只影响目标组织（与切换清理 Ticket 一致）。

## Blocked by

- MT098 桌面原生组织上下文模型与命令门控
- MT069 公司计费 Customer 映射与公司/个人账户类型（expand）

## Scope boundary

凭据命名空间隔离、个人 provider 连接与 OAuth state 绑定 authority；不含上下文门控实现。

## Verification

cargo test --manifest-path desktop/src-tauri/Cargo.toml credential_namespace

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A7, A10, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「桌面原生组织上下文与凭据命名空间」拆出的第 2/2 段；上一段（桌面原生组织上下文模型与命令门控）完成并集成后再领取。
