# MT005 / Issue #48 — 实现轮 Task Brief（集中授权入口）

角色：`backend_implementer`；完成后由全新独立 Pi Reviewer 复审。前置：MT002+MT004 已 verified 并集成到你的工作树（以 `archive/plans/multitenancy-execution/checkpoints/prereq-manifest.txt` 为准，先逐条复算，不符即 worker_done --outcome failed）。

## 目标（Ticket 契约）

每次业务访问都由集中授权入口判定「有效公司成员资格 + 有效团队成员资格」，并在同一业务事务内重验；撤权后的下一次请求立即失效。客户端提交的公司/团队标识只用于选择，不作为授权依据。

## 验收标准（Issue #48 五条，逐条 TDD 留证）

1. 只有签发入口能产生 Scope；伪造或反序列化的 Scope 被拒绝（专门测试：构造器私有/brand 类型/`assertTrustedScope` 类信任边界 + 直接反序列化对象被拒）。
2. 缺少公司或团队上下文时明确拒绝（明确错误码/类型），**不回退默认公司或第一个团队**。
3. 团队成员被移除或停用后，同一事务后续步骤与下一次请求都被拒绝。
4. 公司成员被暂停后，其在该公司的全部团队资格立即失效，但在其他公司的资格不受影响（跨公司隔离正反两测）。
5. 授权判定只依赖服务端事实；请求头里的公司/团队值被篡改不改变结果（头只做选择，判定走服务端状态）。

## Seam 落点（已完成独立识别，`archive/plans/multitenancy-execution/reports/seam-identification-mt005.md` 为权威）

- 真正的租户 seam 是 **`createScopeResolver`**（`server/src/enterprise/tenancy/store.ts:82-146`）：PlatformScope 无 role 字段、memberEpoch/aclEpoch 双 epoch、WeakSet 信任 + `assertTrustedScope`。扩展点在此，不在别处。
- 事务等价物参照 **`server/src/conversations/store.ts:21-99` 与 `:457-580`**：`set_config('app.*', …, true)` 事务本地 + advisory locks 顺序 `tenant → principal → membership[→ resource]`。撤权即拒绝必须落在同事务内重验。
- **裁决 #1**：请求头对齐契约为 `x-openbot-tenant` / `x-openbot-workspace`（选择用，非授权依据——验收 5）。
- **裁决 #2**：新栈不存在 `conversations-v1` 策略；不要臆造该名字，RLS 会话契约以 enterprise 域现有 `app.*` settings 为准。
- `index.ts:2875/2983` 的 `resolveScope` 是 proactive 投递范围的命名碰撞，**不是**本 Ticket 的落点，勿改。

## 数据模型（MT004 交付，已集成）

`enterprise_workspace_memberships`：复合 PK `(tenant_id, workspace_id, principal_id)`、双复合 FK、status `active/suspended`、epoch `>0`（read-then-increase 并发竞态已披露：串行化/重试责任归本入口——验收 3/4 的实现须在判定路径处理）。哈希以 `archive/plans/multitenancy-execution/checkpoints/MT004/fix-review-sha256-manifest.txt` 与 `archive/plans/multitenancy-execution/checkpoints/prereq-manifest.txt` 为准，不内联。

## 约束

- expand-only：不改 MT001–MT004 交付文件的既有语义；新增文件或纯追加扩展 seam。
- 头上下文缺失/无效：明确拒绝（好于猜测）；跨公司数据不可见语义，错误不泄露存在性。
- 专用测试 PostgreSQL（pgvector/pgvector:pg16）+ 受限业务角色；缺 env 显式 skip 带理由，skipped 不算通过；无 env 时绝不回退开发库。
- RED → GREEN → REFACTOR，全部记录退出码与存档。
- 无提交/推送/合并/生产迁移/部署/发布授权；未提交检查点 + SHA-256 清单。

## 测试资源（分配端口见派发 spec；镜像必须 pgvector/pgvector:pg16）

受控基线：`bun scripts/enterprise-test-db.ts migrate`；受限角色 LOGIN 自建（0600 env、随机密码、用后删、不入库不打印）。

## 验证命令（全部记录退出码）

1. 新测试套件（建议 `server/tests/multitenancy/scope-gate.test.ts` 或按现有命名习惯）——五条验收逐条用例
2. `bun test tests/multitenancy/` 全量回归（fixtures/harness/inventory/migration-tool 0 fail；MT003 assigned-db 用例需 env）
3. `cd server && bun run typecheck`；`bunx biome check` 触及文件
4. 清理容器与凭据

## 产出

- `archive/plans/multitenancy-execution/reports/MT005.md`：设计要点（签发入口/信任边界/事务内重验/advisory lock 顺序）、验收逐条证据映射、命令与退出码、诚实披露项。
- `archive/plans/multitenancy-execution/checkpoints/MT005/`：prereq 复算、before/after 哈希、diff、red-green/、mutation/（关键判定逻辑至少 3 个变异被测试捕获）、review-package.json、sha256-manifest.txt。
- worker_done --outcome succeeded|failed，附 --report-path --files-modified。
