---
status: accepted
---

# 统一使用 Better Auth 管理身份、公司、团队与成员

用户在 2026-10-22 的选型与接入讨论中明确要求完整复用 Better Auth，并确认“把公司、团队及成员管理也纳入 Better Auth”。采用 Better Auth + Better Auth UI + PostgreSQL：Better Auth 管理认证、账户、会话、公司、团队、成员和邀请；Better Auth UI 提供相应产品入口。公司使用 Organization、公司内平级团队使用 Team 表达。公司与团队成员关系最终以 Better Auth 管理的数据为唯一权威，不保留可独立修改的旧成员目录。

本 ADR 确认 Better Auth 的身份及目录选型，以及 OpenBot 保留业务授权与治理的职责。全局 User/Principal、公司与团队的概念、管理权与内容访问分离、公司及个人付款归属分离作为本 ADR 的方向约束；Better Auth 的当前组织/团队选择与组织管理角色不能单独授予业务内容或执行权限。当前不引入 OpenFGA。

适用范围澄清（2026-10-22）：[ADR 0004](0004-company-team-tenancy.md)及[旧多租户规格](../specs/2026-10-14-company-team-multitenancy-design.md)已标记 VOIDED，原 Issue #6 及其全部子 Issue 的需求、验收和排期不能因本 ADR 而复活。此前“修订 ADR 0004、保留其业务合同”的表述不能作为继续实施旧整改的依据。本 ADR 的 accepted 状态仅确认上述选型和职责方向；多公司/多团队的完整交付范围、上线批次及具体安全和迁移合同，须以重新评审批准的 Spec 为准。[接入设计](../specs/2026-10-22-better-auth-full-integration-design.md)目前是独立的待评审候选方案，不继承旧规格的批准状态，也不构成重新立项或实施授权。

保留现有稳定身份和业务归属，避免通过复制用户或重建公司改变历史资源、Run、订单和付款账户。迁移期间旧表只能作为明确受控的兼容读取或待切换数据，不能形成双主写入。具体表结构、兼容层、事务及回滚设计见[接入设计](../specs/2026-10-22-better-auth-full-integration-design.md)。用户确认的是本 ADR 的架构方向；详细 Spec 尚待评审，未授权生产迁移、发布或证明代码已完成。

考虑过只替换登录 UI 并保留旧成员管理，以及独立引入 Casdoor/Keycloak。前者不满足用户完整复用的要求，后者增加身份平台与应用的同步边界。代价是需要迁移成员目录，并证明 Better Auth 的全部写入入口满足原有撤权和隔离合同。
