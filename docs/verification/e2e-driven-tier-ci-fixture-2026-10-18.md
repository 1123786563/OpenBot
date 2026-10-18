# 驱动层在 CI 等价数据库夹具下的复测（2026-10-18 22:56–23:34 CST）

这条记录把「驱动层整体是否等于旧运行器对同一批文件的判定」这句话（迁移状态文档完成度审计第 6 条）
从"只能由 CI 关门"变成"本地已按 CI 的服务定义复现并测过"。它同时记下夹具的精确形状，
以及这轮复测里**在我自己的驱动里发现的一个标签缺陷**。

## 测量在哪棵树上做

不在共享工作树：2026-10-18 23:00 时主工作树正处在别人发起的 merge 中间
（`.git/MERGE_HEAD` 存在，2587 个暂存新增、193 个 `AA`、4 个 `UU`，冲突文件里含
`scripts/lib/e2e-manifest.mjs`、`scripts/e2e-bun-manifest.mjs`、
`docs/verification/e2e-bun-suites.json`、`docs/verification/e2e-known-broken.json`、
`docs/adr/0008-test-runner-tester-army-e2e.md`、
`docs/plans/2026-10-18-e2e-tester-army-migration-status.md`）。
在这种树上跑出来的任何数字都不是结论，所以测量放在 HEAD 的独立副本里：

```bash
git worktree add --detach ~/.cache/openbot-e2e/d9635100 d9635100
# 各 workspace 的 node_modules 软链回主仓库，.env 不带入（未跟踪文件不会进 worktree，
# 于是环境变量只能显式给，正是这件事要的形状）
```

同一棵副本上 `node scripts/e2e-coverage-audit.mjs` → `no gaps`（1072 套件文件 =
603 native / 454 driven / 10 engine / 5 named exclusions），即分区账本在 HEAD 是完整的。

## 夹具：照 ci.yml `test` job 的服务定义，私有端口

`.github/workflows/ci.yml:362-395` 给两个 `pgvector/pgvector:pg17` 服务。本机复刻时**不碰
5432 / 5435 / 55432**（共享实例，仓库 brief 明令禁用），改用一对私有端口：

```bash
docker run -d --name ob-e2e-pg1 -p 127.0.0.1:55433:5432 \
  -e POSTGRES_DB=openbot_test -e POSTGRES_USER=openbot -e POSTGRES_PASSWORD=openbot \
  pgvector/pgvector:pg17
docker run -d --name ob-e2e-pg2 -p 127.0.0.1:55434:5432 \
  -e POSTGRES_DB=openbot_enterprise_r2_codex_20261009 \
  -e POSTGRES_USER=enterprise_setup -e POSTGRES_PASSWORD=enterprise-setup-only \
  pgvector/pgvector:pg17
```

跑 CI 里那两步 provisioning（同一套 env，只是 host:port 换成 55433/55434）：

```bash
cd <tree>/server && OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on bun scripts/migrate.ts
# → {"type":"migrations-applied","status":"ok"}
cd <tree>/server && bun scripts/enterprise-test-db.ts migrate
# → {"type":"migrations-applied","status":"ok"}
```

夹具落地的证据（直接查 pg2）：`ob_ent_directory|data|operator|identity_operator` 四个能力角色
`rolcanlogin=f`，`enterprise_{setup,directory,data,operator}_login` 四个身份 `rolcanlogin=t`，
public 下 178 张表。上一轮报的 `DATABASE_CAPABILITY_CHECK_FAILED`
（`server/src/enterprise/tenancy/connections.ts` 的 `verifyCapability` 读 pg_roles 目录）
这一轮不再出现——缺的就是这套多库 + 角色布局。

## 结果：驱动层 30 组里 21 组过、9 组红

```
bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts      # 10m08s，exit 1
run.summary = discovered 8158 · selected 30 · executed 30 · passed 21 · failed 9 · skipped 0
```

红的 9 组：`app/tests/ai-observability`、`server/tests part 3 / 4 / 5 / 7 / 8 / 9 / 11 / 14`。
组内独自重跑（驱动的既有机制）给出的"单文件也红"计数：part 3 1/3、part 4 3/6、part 5 2/2、
part 9 2/4、part 11 3/4、part 14 4/6、ai-observability 1/2；part 7 与 part 8 各有 17/22 个文件红、
超过 8 个的上限，因此按设计**不做**独自重跑收口，直接判整组失败（不拿"重跑就绿"给假绿）。

**同一棵树、同一套 env，把这 9 组直接交给旧运行器**（`bun test ./<files>`，不经 e2e）：
9 组全部 `exit 1`。也就是说第 6 条要的"驱动层 verdict = 旧运行器对同一批文件的 verdict"在
组这一级成立：e2e 判红的每一组，`bun test` 自己也是红的；e2e 判绿的 21 组由驱动直接转发
`bun test` 的 0 退出。这 9 组剩下的红，是套件内部真实的失败（例：`ModelUsageSettlementError:
outbox_write_failed`、RLS 下 `insert into "enterprise_resources"` 被拒、
`app/tests/ai-observability-route-chain.test.tsx` 的 `queryClient.ensureQueryData` undefined），
不是迁移引入的判定差异。

## 这轮在我自己驱动里发现的缺陷：blocked 标签乱贴

`tests/bun-suites.test.ts` 那条"没库所以没判"的说明原来 keyed 在
`/ECONNREFUSED|EADDRNOTAVAIL|Failed to connect|Failed query|PostgresError|unreachable|is not available/i`
上。库给全之后，5 个组仍被贴上 `blocked, not judged`，查其文本：

- `Failed query:` 是 drizzle 对**任何**语句错误的包装（这轮是 `insert into "enterprise_resources"`
  被 RLS 拒），属于产品判定，不是环境缺项；
- `is not available` 也出现在普通断言文本里。

已收紧为只认连接级签名，并把据以判定的那条失败原文打印进失败信息（贴不出证据的标签不是证据）。
反例验证：把 `DATABASE_URL/TEST_DATABASE_URL` 指向死端口 55499 跑 `server/tests part 3` 应当仍
标 blocked；库在时跑 `server/tests part 5` 应当不再标 blocked。

第一次收紧**矫枉过正**：死端口那一轮的 `server/tests part 3`（225 条失败 / 18 个文件）不再标
blocked，因为 bun 的 junit 里失败文本以 `Failed query:` 开头，`ECONNREFUSED` 这类连接级原因被
截断在片段之外——只看文本签名会把真故障误判成产品红。最终形状是**双证据**：
文本里有连接级签名，或者驱动自己做一次 TCP 探测（`databaseUnreachable()`，取
TEST_DATABASE_URL/DATABASE_URL 的 host:port，1.5s 超时，URL 里的凭据不回显）确认无人应答、
且失败以语句错误为主；两条都不满足就不贴标签。失败信息里打印用的是哪一条证据。

双向验证都跑过了（同一棵副本树，每组单独一轮）：

| 条件 | 组 | 结果 |
| --- | --- | --- |
| `DATABASE_URL/TEST_DATABASE_URL` 指向死端口 55499 | `server/tests part 3` | 贴出 `218/225 failures are statement errors and the configured database is unreachable (127.0.0.1:55499 answered nothing): this group is blocked, not judged.`，仍然 exit 1（没判的层不许报成功） |
| 私有夹具在跑（55433/55434） | `server/tests part 5` | **不再**贴 blocked：那 2 条是 `Failed query: insert into "enterprise_resources"` 被 RLS 拒，判成产品红 |

## 这两套私有容器现在还在跑

```bash
docker ps --filter name=ob-e2e-pg        # ob-e2e-pg1 127.0.0.1:55433 / ob-e2e-pg2 127.0.0.1:55434
docker rm -f ob-e2e-pg1 ob-e2e-pg2       # 不需要时收回；库是一次性的，随时可重建
```

## 第 6 条现在的口径

机制与整体结论都已有证据：驱动层 30 组在 CI 等价夹具下 21 过 / 9 红，这 9 组在旧运行器上同样全红
（组这一级 verdict 一致），红的每一条要么是单文件也红的真实缺陷、要么是 >8 文件超预算不给假绿。
`DATABASE_CAPABILITY_CHECK_FAILED` 那类"夹具缺项"已被这套多库 + 角色布局消掉。
仍未在 CI 上落过一次，是因为那需要往共享分支推 / 开 PR——尚未获授权。


