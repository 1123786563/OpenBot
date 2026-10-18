# MT005 / Issue #48 — 独立复审 Task Brief

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_70d54b54ba2e` / Dispatch `ctx_2a8e4c341143`，已结算）无共享会话。

## 目标

两个独立结论：(1) Spec compliance——Issue #48 五条验收（签发入口独占 Scope 产生 / 缺上下文明确拒绝不回退 / 撤权即拒含同事务 / 公司暂停跨公司隔离 / 判定只依赖服务端事实）；(2) Code quality。有效 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- `git rev-parse HEAD` = f0520524 开头（完整值以 `checkpoints/MT005/review-sha256-manifest.txt` 首行为准）。
- 逐条复算该 manifest 每个文件 SHA-256；不匹配 → worker_done --outcome failed。
- 预期 git 状态：`server/src/db/schema/enterprise-tenancy.ts` tracked ` M`（MT004 交付，本票零改动）；其余清单内 untracked。

## 审阅对象

- `server/src/enterprise/tenancy/store.ts`（createScopeResolver.resolve 纯追加扩展：TENANT_REQUIRED/WORKSPACE_REQUIRED 拆分 + 团队资格判定 WORKSPACE_FORBIDDEN + app.workspace_id set_config）
- `server/src/enterprise/tenancy/scope-gate.ts`（新建 createWorkspaceGate：conversations 事务形状复刻）
- `server/src/index.ts`（裁决 #1 头名 2 行改动）
- `server/tests/multitenancy/scope-gate.test.ts`（新建 23 用例）
- `server/tests/multitenancy/support/fixture.ts` + `fixtures.test.ts`（**D1 集成——重点**）
- 报告 `reports/MT005.md` 与 `checkpoints/MT005/**`

## 审阅要点

1. **seam 落点**（对照 `reports/seam-identification-mt005.md`）：扩展确在 createScopeResolver；proactive 侧 resolveScope（index.ts:2875/2983 附近）未被触碰；裁决 #2 无 conversations-v1 常量。
2. **D1 重点**（MT002 交付文件的集成是否最小且语义正确）：
   - fixture.ts：三块是否均为纯追加（头注释、经受限 operator 角色插 MT004 团队成员行、ROUTE_ERROR_STATUS 追加两映射）；无既有语句删除/改写。
   - fixtures.test.ts：diff 是否仅 2 处断言（跨团队读取、company-admin 读取：404 RESOURCE_NOT_FOUND → 403 WORKSPACE_FORBIDDEN）；该语义变化是否正确——403 对「认证身份对已知团队无资格」是否比 404 更符合「不泄露存在性」契约（对照 MT002 原断言意图与父 Spec）。
   - 其余 19 个 MT002 断言逐条未动（对照 prereq-manifest 中 before 哈希重建 diff）。
3. **gate 事务形状**：advisory 锁顺序 tenant→principal→membership→workspace-membership 与 conversations/store.ts 一致；set_config 全部事务本地（true）；公司重验含 memberStatus/principalStatus/tenantStatus + epoch === scope.memberEpoch；团队重验行存在 + active；operation 在全部校验后执行。
4. **撤权即拒**（验收 3）：同事务后续 + 下一次请求 + 串行化证明（lock_timeout 探针）证据真实性。
5. **跨公司隔离**（验收 4）：公司 A 暂停 → A 全团队失效、B 不受影响；stale-epoch 用例（M4 暴露后 test-first 补写）真实存在且被变异捕获。
6. **头只做选择**（验收 5/裁决 #1）：篡改头被 WORKSPACE_FORBIDDEN/TENANT_FORBIDDEN 拒；头名改动后旧头名残面检查（runner-production.test.ts 两处故意伪造断言依旧成立的理由）。
7. **D2/D3/D4 披露合理性**：resolveForThread 不扩展（expand-only 论证）；团队 epoch 不入 PlatformScope（形状约束）与缓解措施；管理写路径超级用户替身（判定侧全走受限角色 RLS）——判定这些边界是否可接受或应升级 finding。
8. TDD 真实性（RED-1/RED-2/GREEN 存档链）、M4 变异自暴露缺口的处理（M4v3 RED → green-stage5 23/23）、biome 存量比对（D5）。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55460`；起专用库（必须 pgvector/pgvector:pg16）：
   `docker run --rm -d --name openbot-i6r2-mt005-pg -e POSTGRES_DB=openbot_enterprise_mt005_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55460:5432 pgvector/pgvector:pg16`
2. `bun scripts/enterprise-test-db.ts migrate`（env 指向 55460）；MT004 表按报告方式 apply（受限登录自建 0600 env、用后删）。
3. `TEST_DATABASE_URL=…55460/… bun test server/tests/multitenancy/scope-gate.test.ts`（预期 23/0）
4. `MT003_ASSIGNED_TEST_DATABASE_URL=<同库> TEST_DATABASE_URL=<同库> ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=<三登录> bun test tests/multitenancy/`（预期 147/0/0 skip；组合超时按 MT004 F4 加 --timeout 30000 并如实记录）
5. 抽查 advisory 锁串行化语义（可复用测试内探针或独立 psql 会话对锁行为做一次实证）
6. `cd server && bun run typecheck`；`bunx biome check` 触及文件（存量按 D5 比对方式处理）
7. 清理容器与 env。环境阻塞项标 blocked + 原因。

## 产出

写 `reports/MT005-review.md`（本工作树唯一允许新建/修改的文件）：Verdicts、findings、命令与退出码、哈希复算、D1 集成最小性与语义正确性结论、D2/D3/D4 处置意见。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。
