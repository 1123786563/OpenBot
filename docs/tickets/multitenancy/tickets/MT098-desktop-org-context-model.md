## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #203 Q 桌面（本 Ticket 是其 sub-issue）

## What to build

桌面端为每个组织连接保存冻结的 authority/用户/公司/团队上下文，原生命令只允许当前已验证的组织连接使用。

## Acceptance criteria

- [ ] 上下文一旦建立即冻结；命令调用携带的上下文与已验证连接不一致时被拒绝。
- [ ] 伪造或过期上下文的命令调用被拒绝并记录。
- [ ] 暴露给前端的 DTO 不含 token 或 secret。
- [ ] 上下文在应用重启后与已验证连接一致，不落到默认组织。

## Blocked by

- #71 OAuth 回调按服务端 state 固定归属（MT028）

## Scope boundary

原生组织上下文模型、冻结语义与原生命令门控；不含凭据命名空间。

## Verification

cargo test --manifest-path desktop/src-tauri/Cargo.toml org_context

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A7, A10, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：前端只消费本 Ticket 的上下文接口，不改 Rust 业务代码（见 MT101）。 （原 Ticket 已按粒度要求拆为 2 段，本段为第 1 段。）
