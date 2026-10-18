# MT099 独立复审 brief
角色：独立复审者（只读；变异重放除外）。树=r15-mt099（BASE+272[含 rust 四文件基线 b75f3e6f/f515e24a/25042fca/8ec7e2cd]+增量 5：lib.rs/organization_auth.rs/org_context.rs[修改]+credential_namespace.rs[新]+entry-context.test.ts[令牌版]）。报告：archive/plans/multitenancy-execution/reports/MT099.md；证据：archive/plans/multitenancy-execution/checkpoints/MT099/。
## 必做
1. 三步配方（openbot_enterprise_r15e_*，端口 55590；bun install+cargo 可用性）。
2. bun 基线+全量（1124/0/43 零新增）+**cargo 票面**（credential_namespace 21/0）+**全量 cargo**（741/0）。
3. 变异抽验 ≥3（RUST 源码注入→cargo 聚焦捕获→字节复原→复绿；必含 MUT-5 指针不落盘+MUT-4 恢复不核对 authority）。
4. 冻结面核对（272 项；entry-context.test.ts 令牌差异=已披露整改）。
## 专项
- AC1 组织/个人凭据分命名空间**互不可读**（结构性与行为双层）。
- AC2 组织命名空间无个人 provider 槽位（闭集拒绝：org_remember/org_recall 对 is_personal_credential 闭集一律拒绝+零值回显）。
- AC3 OAuth state 绑定发起 authority：**回调期间切换组织不改变归属**（时序用例真实性）。
- AC4 命名空间清理只影响目标组织（与切换清理一致性）。
- changes.md 逐项披露（rust 三修改文件的 diff 范围核对，无夹带）。
## 输出
archive/plans/multitenancy-execution/reports/MT099-review.md+worker_done。
