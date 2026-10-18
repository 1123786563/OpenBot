# MT006 / Issue #49 — 独立复审 Task Brief

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_ce1f2edb1025` / Dispatch `ctx_fcaf1191c69c`，已结算）无共享会话。

## 目标

两个独立结论：(1) Spec compliance——Issue #49 四条验收（成员事实列表 / 显式空状态不回退默认 / 公司管理员集中管理 / 管理权不隐含业务读权）；(2) Code quality。有效 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- HEAD = manifest 首行 BASE；`checkpoints/MT006/review-sha256-manifest.txt` 逐文件复算，不匹配 → worker_done --outcome failed。
- 预期 git 状态：`M enterprise-tenancy.ts`（MT004 交付）、`M store.ts`（MT005 交付）、`M index.ts`（MT005+MT006）、`M app.ts`、`M config.ts`（MT006 纯追加）+ 清单内 untracked。用 `git diff` 核验 app.ts/config.ts 为**纯追加**、index.ts 变化 = MT005 头名 + MT006 路由装配段（对照 `checkpoints/MT006/changes.diff`）。

## 审阅对象

- `server/src/enterprise/tenancy/workspace-admin.ts`、`workspace-scope-routes.ts`（新）
- `server/src/index.ts` / `app.ts` / `config.ts`（追加面）
- `server/tests/multitenancy/workspace-scope.test.ts` + `support/workspace-scope.ts`
- 报告 `reports/MT006.md` 与 `checkpoints/MT006/**`

## 审阅要点

1. **AC1 列表来源**：成员资格列表只依据 enterprise_memberships + enterprise_workspace_memberships 有效行（与 MT005 判定同事实源）；不泄露无权公司/团队存在性。
2. **AC2 空状态**：无可用团队 → 明确空态不回退默认（正反用例）；选择经裁决 #1 头。
3. **AC3 集中管理**：创建团队/加入/移除/停用经 workspace-admin 集中入口 + 受限 operator 角色 + RLS；与 MT005 gate 同 advisory 键串行化（移除/停用后 gate 立即可见——串行化证据真实性）。
4. **AC4 管理权不隐含读权**：越权用例证明 admin 自加入/自创建团队后仍无法读业务内容（无 grant 即 403/404 语义正确）。
5. **append-only 核验**：store.ts/scope-gate.ts/MT001-MT005 测试文件哈希与 prereq 一致（报告声称「未触碰（哈希证）」——独立复算）。
6. **D1/D2 替身合理性**：operator DELETE 策略由测试支撑文件供给（生产迁移留后续票）——判定是否可接受或有更好落点；D2 降级通道超级用户替身（判定面走真实 RLS）。
7. **D7 测试自我修正**、D5 存量 lint、D6 0-skip 声明真实性。
8. TDD（RED 存档 34 用例）、5/5 变异、182/0/0skip 回归。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55463`；起专用库（pgvector/pgvector:pg16）+ `enterprise-test-db.ts migrate` + 受限登录（0600 env 用后删）+ MT004 表 apply +（按报告 §1.4/D1 方式）测试支撑 DELETE 策略。
2. `TEST_DATABASE_URL=…55463/… bun test server/tests/multitenancy/workspace-scope.test.ts`（预期 34/0）
3. `MT003_ASSIGNED_TEST_DATABASE_URL=<第二专用库> TEST_DATABASE_URL=… ENTERPRISE_TEST_*… bun test tests/multitenancy/ --timeout 30000`（预期 182/0/0 skip；组合超时按 F4 惯例处理并记录）
4. `cd server && bun run typecheck`；`bunx biome check` 七个触及文件（存量按 D5 比对）
5. 清理。环境阻塞标 blocked + 原因。

## 产出

写 `reports/MT006-review.md`（唯一允许新建/修改文件）：Verdicts、findings、命令与退出码、哈希复算、append-only 结论、D1/D2 处置意见。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。

## 接管说明（coordinator，2026-10-16）

前任 Reviewer（ctx_b5dc7c0a15fb）被平台强制终止（stop_unverified，非任务失败）。本工作树即前任所用树：prereq 快照完好（git status 与上文「预期状态」一致），`reports/MT006-review.md` 仅为占位存根——你完成审阅后**直接覆盖写入**最终报告。专用库容器 `mt006-review-pg`（127.0.0.1:55463）仍在运行，可直接复用（如状态脏可 `docker rm -f mt006-review-pg` 后按 brief 原命令重启）。其余流程按本 brief 原文执行，从快照核验开始。
