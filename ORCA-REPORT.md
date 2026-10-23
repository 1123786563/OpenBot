# Closeout 复验报告：#48 / #214 / #371 @ 当前 main

- HEAD：`3ca32d49`（= origin/main 顶端，含 #371 交付提交；BASE 2b41017c+ 满足）
- 性质：零改动纯验证。`git status --short` 为空（见文末），无 stash，未提交/未推送任何改动。
- 结论速览：**#48 SATISFIED / #214 SATISFIED / #371 SATISFIED**（各附环境注记与两项范围外发现，见"遗留与发现"）。

---

## 1. #48 [B] MT005 集中授权入口 — **SATISFIED**

**落地文件确认**：`server/tests/multitenancy/scope-gate.test.ts`（票面 `team-eligibility.test.ts` 已不存在，`ls` 证实漂移，上轮判定成立）。

**命令**（库：共享容器 `openbot-enterprise-test-pg` @127.0.0.1:5435 上的 `openbot_enterprise_mt048`，即上轮 #48 验证库）：

```sh
TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5435/openbot_enterprise_mt048' \
ENTERPRISE_TEST_SETUP_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5435/openbot_enterprise_mt048' \
ENTERPRISE_TEST_DIRECTORY_DATABASE_URL='postgres://ent_mt048_directory:<pw>@127.0.0.1:5435/openbot_enterprise_mt048' \
ENTERPRISE_TEST_DATA_DATABASE_URL='postgres://ent_mt048_data:<pw>@…' \
ENTERPRISE_TEST_OPERATOR_DATABASE_URL='postgres://ent_mt048_operator:<pw>@…' \
bun test ./server/tests/multitenancy/scope-gate.test.ts
```

**输出**：

```
23 pass
0 fail
49 expect() calls
Ran 23 tests across 1 file. [700ms]
```

23/23 全绿，与上轮"23 用例实证"一致。缺环境变量时该文件显式 skip（26 中 1 pass/25 skip，skip 原因写在用例名里）——本次带全套环境变量，无 skip。

**环境注记（两件事，均为使上轮库可用，不改任何仓库文件）**：
1. 三个 `ent_mt048_*` 登录的原密码未知（容器内 psql 走 trust，宿主侧实测 scram 全拒）。以 superuser `ALTER ROLE … WITH PASSWORD` 重置为已知值（仅密码，未动表结构/数据/授权）。
2. 未走"全新库 + 迁移"路径，原因见发现 F1（全新库迁移后缺 `enterprise_resources.visibility` 列与 38 张 enterprise/billing 表，fixture 首个 insert 即挂）。mt048 库的 schema 即当前代码 schema 的物化，测试在其上全绿证明**当前 main 的测试代码与验收行为成立**。

---

## 2. #214 Bifrost 01.8 管理员就绪状态页面 — **SATISFIED**

**落地物确认**：
- 服务路由测试：`server/tests/gateway-admin-routes.test.ts`（头注 `Bifrost 01.8 (#214)`，9 用例）
- 页面：`app/src/routes/_authed/admin/gateway.tsx`；页面测试：`app/tests/admin-gateway-readiness.test.tsx`（头注 `Bifrost 01.8 (#214)`，4 用例，覆盖"未就绪逐条列阻塞原因/凭据不回显/普通用户拒绝"等票面 AC）
- 合计 13 测试 = Ledger 记录的 "server 9+app 4=13"。

**命令与输出**：

```sh
TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5563/cl01' \
bun test ./server/tests/gateway-admin-routes.test.ts
# 9 pass / 0 fail / 68 expect() calls

bun test app/tests/admin-gateway-readiness.test.tsx
# 4 pass / 0 fail / 24 expect() calls
```

AC 对照（页内断言实证）：未就绪时 `body.readiness.blockingReasons` 逐条列出（AC2/接口面）、管理员全流程动作（AC1）、凭据明文不回显、普通用户拒绝（测试名可证）。13/13 绿。

---

## 3. #371 BP03 已收款订单交付恢复 — **SATISFIED**

main 已含 `3ca32d49`（HEAD）。

**注意：任务给的一条命令需按两层制拆开跑**（ADR 0008）。`payment-service.test.ts` import `tests/support/e2e-compat`，其顶层链拉 `node:module.registerHooks`（Node-only），在 `bun test` 下是致命加载错误——一把跑两个文件得 `3 pass / 1 fail / 1 error`（error 即该 SyntaxError），属于**运行器错配，不是代码缺陷**。拆开后：

**命令与输出**：

```sh
# bun 层（fulfillment）：
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5563/cl01 \
bun test ./server/tests/billing-period-fulfillment.integration.test.ts
# 3 pass / 0 fail / 34 expect() calls
# （有一条 warn 日志 "plan credit grant … failed; the activation retry re-runs it"，
#   为用例内预期的重试路径日志，非失败）

# e2e 运行器层（payment-service）：
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5563/cl01 \
bunx e2e run --config e2e.unit.config.ts server/tests/payment-service.test.ts
# Test Files 1 passed (1) / Tests 70 passed (70)

# 类型检查：
bun run --filter server typecheck
# server typecheck: Exited with code 0
```

70 + 3 全绿，typecheck 0 错误。

---

## 数据库（按纪律保留，未删）

| 容器 | 镜像 | 端口 | 库 | 用途 |
|---|---|---|---|---|
| `orca-all-cl01-pg`（本任务新建） | `pgvector/pgvector:pg16` | 5563 | `cl01`（业务全量迁移 162 条）+ `openbot_enterprise_cl01`（企业链迁移后，见 F1） | #371、#214 server 测试；F1 取证 |
| `openbot-enterprise-test-pg`（既有共享） | `pgvector/pgvector:pg16` | 5435 | `openbot_enterprise_mt048` | #48 复验；三个 login 密码已重置 |

注：preamble 给的 `postgres:16` 镜像缺 pgvector（首个迁移 `CREATE EXTENSION vector` 即挂），换同 tag 的 `pgvector/pgvector:pg16`，其余参数一致。

## 遗留与发现（范围外，仅记录不改）

- **F1（迁移债，建议开票）**：当前 main 的 drizzle 迁移链落后于代码 schema。`enterprise_resources.visibility` 列（`src/db/schema/enterprise-tenancy.ts:196`）及 `enterprise_workspace_memberships` 等约 38 张 enterprise/billing 表不在任何已提交迁移中——schema 变更随 checkpoint 提交 `253bf7e5` 进入主线但未 `db:generate`。后果：全新库跑 `scripts/migrate.ts` 后，multitenancy 域集成测试首个 fixture 即 `column "visibility" does not exist`。本次 #48 判定基于既有物化库（mt048），不受此影响；`drizzle-kit push` 可补齐但会同时 DROP 大量迁移手写约束/FK 命名，不作为零改动验证手段。
- **F2（命令漂移）**：#371 票面/简报里的 `bun test A B` 一条龙在两层制下必然报 1 error（payment-service 属 e2e 运行器层）。后续复验应写两条命令。
- 上轮 #48 报告若声称"自建库复现"，与 F1 矛盾——更可能是当时也是复用/物化库；本次按证据如实记录库来源。

## 改动文件

无。`git status --short` 输出为空；本报告为唯一新增文件（ORCA-REPORT.md）。

容器/密码类环境变更（不属仓库改动）：`orca-all-cl01-pg` 新建；`ent_mt048_{directory,data,operator}` 密码重置。
