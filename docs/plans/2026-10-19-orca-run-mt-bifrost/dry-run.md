# Dry-run 报告：多租户 + Bifrost 编排（R0–R4）

运行目录：`docs/plans/2026-10-19-orca-run-mt-bifrost/`（gitignored）
生成：2026-10-19 · 主协调器手工执行（Orca DAG 工具未实施，按计划 R0–R7 流程只读演练）
BASE：main @ `9c8d3933` · scope_revision 1 · 指纹 `677d72cc41d0d793`

## 1. 范围（R1）

根 Issue：**#6 多租户整改** + **#5 Bifrost 严格积分计费**（用户 2026-10-19 指定）。

| 项 | 值 |
| --- | --- |
| 节点总数 | 324（2 根 + 21 聚合 + 293 open 叶 + 8 closed） |
| MT 树 | #6 → 20 聚合（#187–#206）→ MT001–MT143（#44–#186）+ #368（BP 父） |
| Bifrost 树 | #5 → 100 张原生 sub-issue（#207–#306，组 01–13.1）+ 51 张正文链接补录（#307–#357，组 13.2–22.6） |
| BP 树 | #368 → BP01–BP07（#369–#375），依赖跨 MT（#112/#116）与 Bifrost（10.x）两树 |

**完整性缺陷（需用户裁决）**：#307–#357 共 51 张票正文均声明 `Parent: #5`，但未挂为原生 sub-issue。已逐张核验后纳入范围；建议补挂 sub-issue 使树自洽。

## 2. closed 核验（R2）

8 张 closed 票正文验收均未勾选、无关联 PR、由用户手工关闭。代码侧核验结果：

| 分类 | Issue | 证据 |
| --- | --- | --- |
| **satisfied（5）** | #44 MT001 | `server/tests/multitenancy/inventory.test.ts` 在 main（06e3c9bc） |
| | #72 MT029 | `credential-lease.test.ts` 在 main |
| | #141 MT098 | `desktop/src-tauri/src/org_context.rs` 存在 |
| | #142 MT099 | `desktop/src-tauri/src/credential_namespace.rs` 存在 |
| | #269 B07.6 | `e649f43b` conservative input counter；`billing-input-bound.test.ts`（票面文件名已漂移） |
| **unverified_closed（3）** | #106 MT063 | `openmuse-connectors.test.ts` 不存在，无相关提交 |
| | #133 MT090 | `app/tests/multitenancy/` 下无通知/设置测试 |
| | #162 MT119 | `external-runtime-migration.test.ts` 不存在，无相关提交 |

**保守规则**：unverified_closed 不视为 satisfied，其下游保持阻塞（#107←#106、#163←#162；#133 无下游）。
处置需用户裁决：补证据 / 重新打开实施 / 确认作废。

## 3. DAG 结构（R3）

- 依赖仅取自结构化声明（叶票 `## Blocked by`、聚合表格、`## Blocks` 反向校验）：**0 环、0 未解析引用、0 声明不一致**。
- 从当前 5 张 satisfied 出发，**293 张 open 票全部可解锁**；关键路径 30 波，波宽峰值 21——串行性主要由 Bifrost 组链与 MT T 组（迁移/装配/覆盖证据）贡献。
- 产物：`dag.json`（全部节点、依赖边、来源）、`issues/*.json`（324 份正文快照）、`contains.tsv`（322 条父子边，51 条标 body-link）。

## 4. 就绪集合与并行约束（R4 dry-run）

保守就绪 **9 张**（乐观 10 张含 #163，其依赖 #162 属 unverified_closed 已剔除）：

| Issue | 票 | 依赖 | 写入范围 |
| --- | --- | --- | --- |
| #45 | MT002 身份夹具 harness | — | server/tests/multitenancy fixtures |
| #46 | MT003 安全迁移工具 | MT001✓ | 迁移工具 |
| #143 | MT100 桌面组织清理 | MT099✓ | desktop |
| #146 | MT103 移动端基线核对 | — | mobile 报告 |
| #207 | B01.1 网关配置持久化 | — | server/src/gateway/、config.ts、settings-store |
| #209 | B01.3 兑换比例校验 | — | server/src/gateway/、config.ts ← **与 #207 文件冲突** |
| #215 | B02.1 PayerRef 模型 | — | server/src/billing/payer*、db/schema |
| #234 | B04.1 Bot 服务登记 | — | 登记模块、迁移、管理员路由/页面 |
| #270 | B07.7 输出封顶强制 | B07.6✓ | bifrost Go 侧 + 测试 |

**并行判定**：#207/#209 写入范围重叠，同批互斥（二选一）；其余互不重叠。
→ 文件约束下最大并行 = **8**（9 − 1 冲突）。实际并发另受：Worker 预算、TEST_DATABASE_URL 专用库分配（server 集成测试共享 DB 资源）、每票独立 worktree。

## 5. start 前置条件（未满足，等待授权）

1. 3 张 unverified_closed 的处置裁决。
2. 51 张 body-link 票是否补挂 sub-issue（不阻塞 start）。
3. 真实 start 授权：试点切片选择、并发预算（建议 ≤4）、Worker 后端核验（Orca Pi）。
4. 每张就绪票的 Brief 由主协调器按 `writing-plans` 生成后再派发。

**本轮零副作用**：未派发 Worker、未写 GitHub、未改业务代码；产物均在 gitignored 运行目录。
