# verify.md — Ticket #207 run 2 独立复验证据（worktree issue5-207-2, BASE bab7c0b9）

全部命令于 2026-10-15 在本工作树串行执行；原始输出摘要如下，可按 checkpoint-report.md 的命令原样重跑。

## 1. 转移完整性（12/12 一致）

```
$ shasum -a 256 <12 个实现文件>
45032acb…  server/src/gateway/endpoint.ts          # == f1-repair 终稿（repair 变更文件）
963f082e…  server/src/gateway/config-store.ts
da7e54de…  server/src/gateway/routes.ts
849f9186…  server/src/db/schema/gateway.ts
f8fa962c…  server/src/db/schema/index.ts
16e5456f…  server/drizzle.config.ts
3d3bd74c…  server/src/config.ts                    # == f1-repair 终稿（repair 变更文件）
e452ae4f…  server/drizzle/0122_gateway_endpoint_config.sql
31b406c9…  server/drizzle/meta/0122_snapshot.json
39e657fb…  server/drizzle/meta/_journal.json
9f027dc2…  server/tests/gateway-endpoint-config.test.ts          # repair 变更文件
c29326ee…  server/tests/gateway-endpoint-config.integration.test.ts  # repair 变更文件
```

与 `issue5-207-timeout` 工作树 `checkpoints/207/f1-repair/report.md` 的 Full SHA-256 manifest
逐一比对：12/12 完整 SHA-256 相等（完整值见 file-hashes.txt）。

BASE 兼容性：`git diff f0520524..bab7c0b9 -- server/src/config.ts server/src/db/schema/index.ts
server/drizzle.config.ts server/drizzle/meta/_journal.json` → 空（BASE 差异仅 docs）。

## 2. 测试库初始化（专用库，不触碰他库）

```
$ docker exec openbot-postgres-1 psql -U openbot -d postgres -c "DROP DATABASE IF EXISTS openbot_207_2" -c "CREATE DATABASE openbot_207_2 OWNER openbot"
CREATE DATABASE

$ cd server && DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207_2 bun scripts/migrate.ts
{"type":"migrations-applied","status":"ok"}

$ docker exec openbot-postgres-1 psql -U openbot -d openbot_207_2 -c "\d gateway_configs"
 id | text | not null |  (PK: gateway_configs_pkey)
 base_url | text | not null |
 request_timeout_ms | integer | not null | default 10000
 config_version | integer | not null |
 updated_by | text | not null |
 updated_at | timestamp with time zone | not null | default now()

$ select count(*) from drizzle.__drizzle_migrations  →  123   # 含 0122
```

## 3. 单元测试（16 pass / 0 fail）

```
$ cd server && bun test tests/gateway-endpoint-config.test.ts
 16 pass
 0 fail
 45 expect() calls
Ran 16 tests across 1 file. [674.00ms]
```

覆盖：空/非 http(s)/带凭据/带 path-query-fragment 逐条拒绝并断言文案；timeout 非正整数与
超 int4 上界拒绝（F1）；env 未配置/合法/半配置/非法逐条；非管理员 PUT 403 且不触库
（Proxy 不可触库证明）；非法 PUT 400 带原因且先于写。

## 4. 集成测试（9 pass / 0 fail，专用库 openbot_207_2）

```
$ cd server && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207_2 bun test tests/gateway-endpoint-config.integration.test.ts
 9 pass
 0 fail
 33 expect() calls
Ran 9 tests across 1 file. [630.00ms]
```

覆盖（对应 AC）：
- AC「重启读取一致」：重建 store（新连接 `createDatabase(…, { max: 1 })`）读取与重启前相等
- AC「严格递增且旧版本不可写回」：三次保存 configVersion 严格递增（1→2→3）；输入不携带
  版本字段，重复保存旧值仍只能前进
- AC「只读无凭据字段」：读取形状恰为 {baseUrl, requestTimeoutMs, configVersion}；响应与
  表列名均不匹配 /secret|token|password|credential|api[-_]?key/i
- AC「非法地址拒绝带原因」：PUT 400 + "Gateway base URL must not carry credentials."，
  库内配置不变；timeout 3_000_000_000 → 400（非 500）且不变
- 通知：pg_notify('gateway_config_changed', <version>) 实际送达（LISTEN 断言）
- 权限：管理员 PUT 200 响应为只读三字段；非管理员 PUT 403 且版本不变；非管理员 GET 200 只读形状

## 5. typecheck / lint

```
$ cd server && bun run typecheck
$ tsc --noEmit                                  # exit 0

$ bunx biome lint --error-on-warnings <9 个改动源/测试文件>
Checked 9 files in 91ms. No fixes applied.      # exit 0
```

## 6. 回归与既有失败归因

```
$ cd server && bun test tests/config.test.ts
 140 pass / 1 fail  （"enables Google authentication when its complete deployment contract is present"）
```

BASE 归因（本工作树执行）：临时以 `git show bab7c0b9:server/src/config.ts` 覆盖回 BASE 版
复跑该用例 → 同样 `(fail)`（0 pass / 1 fail）；随后恢复转移版并核对 SHA-256
`3d3bd74c6abe000a761e70fef045ebb2ca24e25c1b175a38e671fd4be866ce11` 一致。该失败为 BASE
既有，与本票改动无关。

## 7. 检查点形态

`git status --porcelain -uall`：4 个 `M`（drizzle.config.ts / _journal.json / config.ts /
schema/index.ts）+ 12 个 `??`（gateway 模块 3 文件、schema/gateway.ts、迁移 SQL+快照、
测试 2 文件、本票计划、ledger 4 文件）；`git diff --cached` 为空（无 staging）；
无 commit、无 push。
