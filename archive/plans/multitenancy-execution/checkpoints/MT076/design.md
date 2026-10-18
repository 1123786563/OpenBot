# MT076 / Issue #119 — 设计（coordinator brief 契约的落地形态）

BASE f0520524。交付为未提交工作树 + `checkpoints/MT076/`。无提交/推送/合并/生产迁移/部署授权行使。

## 模块定位

`server/src/enterprise/tenancy/people-lifecycle.ts`（新文件）：公司范围人员管理动作（提升、降级、离职）的库层服务，消费 MT006 签发的受信 `CompanyAdminContext`（WeakSet 信任标记），运行在受限 `ob_ent_operator` 角色上，全部写经真实 RLS。与 MT006 workspace-admin、MT026 scim-directory 同层同形；无 HTTP 装配面（路由接线属后续票，MT026 先例）。

## 语义裁决（票面四条验收 → 实现面）

1. **离职（offboard）= MT026 SCIM 停用的管理面同义动作**：成员行 `suspended` + `epoch+1` + 该公司资源授权行逐行删除（撤权=删行范式）+ 审计事件，单 operator 事务。**不删团队行**——公司停用经 MT005 事实行走级联失效（Spec §4.1），与 SCIM 通道逐字节一致（AC4 的"不产生两套语义"由此成立）。结构性不触碰：其他公司成员行/授权行、users/sessions/principal（受限角色对部署级身份表无任何 GRANT，MT026 D3 结构事实）。
2. **提升/降级 = 本公司角色迁移**：`member|auditor → tenant_admin`（提升，目标角色封闭、无参数）；`tenant_admin → member|auditor`（降级，目标角色显式）。每次变更推进 `epoch+1`（授权变更版本，Spec §4.1）——被降级管理员的未决上下文在下次管理重验因 epoch 漂移被拒（SCOPE_REVOKED），无缓存。前置条件不满足（目标非在职/角色不匹配）一律 `COMPANY_MEMBER_NOT_FOUND`——与 MT007 管理面先例一致，存在性不可区分。
3. **不可见语义 + 审计（AC3）**：跨公司管理员对公司 A 成员的动作与对不存在 principal 的动作返回同码（COMPANY_MEMBER_NOT_FOUND，测试断言两消息相等）；伪造上下文三个动作全部 UNVERIFIED_ADMIN_CONTEXT；无权主体在真实 MT006 authorizer 处 TENANT_ADMIN_REQUIRED / TENANT_FORBIDDEN。每次**执行**的动作写一条审计（本模块封闭事件集合 `company_member.{promoted,demoted,offboarded}`，写同一张 enterprise_security_events、同一条 RLS INSERT 策略——不改 revocation.ts / scim-directory.ts / admin-separation.ts）。
4. **与 SCIM 一致（AC4）**：同态对照测试——SCIM 停用与管理员离职落同一状态谓词集（suspended、epoch+1、grants 清零、团队行保留）；目录不能解除管理员离职（绑定行 last_deprovision 事实未写、epoch 已漂移，MT026 reprovision 裁决自动拒绝）；管理员离职不能叠加在已 SCIM 停用的成员上（active-only 前置，NOT_FOUND 零写入）。

## 迁移（已授权扩展点）

领取时发现：0056 基线给 `ob_ent_operator` 的 enterprise_memberships 列级 UPDATE 只有 `("status","epoch")`（MT007 停用面）；`role` 列刻意不可写——MT076 是第一个需要写 role 列的已验证票据。按 MT008 列级授权先例，经 brief 授权的 `migrate-test.ts` 追加任务 MT076（单语句 `GRANT UPDATE ("role") ON TABLE "enterprise_memberships" TO ob_ent_operator;`，expand-only，不改任何策略），并在 `migration-tool.test.ts` 穷举断言追加 "MT076"（ruling #5 先例第 7 次，仅断言行 + 裁决注释）。该授权缺失即为 RED 阶段的自然失败（permission denied，见 02-green-first.txt）。

## 事务形状（与 MT006/MT026 完全一致）

read committed + lock/statement timeout + `set_config(…, true)` 事务本地 + advisory 排他锁（键序 tenant → membership(admin) → membership(target)）+ 事务内重验（tenant_admin + epoch + principal active）→ 写中期切换 `app.operator_principal_id` 到目标（MT004 update 策略按该 pin 收紧行）→ 审计 pin `app.operation_id`。基础设施故障原样上抛。

## 明确非目标（票面未要求，不做）

- 最后一个 tenant_admin 的自降级保护（无票面依据；若需要属治理票）。
- 团队级角色/成员动作（MT006/MT007 已覆盖，本票零修改）。
- HTTP 路由装配（库层 seam 交付，同 MT026 交付边界）。
