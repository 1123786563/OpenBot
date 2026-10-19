# 驱动层的逐文件判定：三种进程形状对账（2026-10-19 01:38–02:16 CST）

这是第 6 条（"驱动层的 verdict 等于旧运行器对同一文件的 verdict"）的逐文件版本。测量器
`scripts/e2e-driven-file-equality.mjs`，明细 `docs/verification/e2e-driven-file-equality.json`。

## 形状与被测面

同一棵树、同一份套件文本、同一套库，只换进程形状，全部由 `bun test` 亲自执行，逐文件从 junit 的
`<testcase file=…>` 取数（只认 `<failure>`；`<skipped/>` 记为跳过而不是红）：

| 形状 | 是什么 | 批次 | 判出文件数 |
| --- | --- | --- | --- |
| `corpus` | 迁移前入口的真实形状：`bun test ./app ./agent-bot … ./worker`，十四条路径过滤器、**一个进程**（取自 baseline 的 package.json） | 1 | 445 |
| `directory` | 每个顶层目录一个进程 | 10 | 445 |
| `group` | 驱动层实际用的 GROUP_SIZE 切片（边界直接调 `groupsOf`，不靠本脚本猜） | 30 | 445 |

清单 455 个驱动文件，**三种形状都有读数是 445 个**；其余 10 个任何形状都读不出 junit
（`app/tests/bot-route-default-agent.test.tsx`、`app/tests/channel-new-error-state.test.tsx`、
`app/tests/home-fallback-routing.test.tsx`、`server/tests/multitenancy/legacy-anchor.test.ts`、
`server/tests/multitenancy/membership-model.test.ts`、`server/tests/opik-case-review.integration.test.ts`、
`server/tests/opik-experiments.integration.test.ts`、`server/tests/payment-ordering-migration.integration.test.ts`
等）——记为 **unmeasured，不算绿**。

## 结论：11 个文件与形状有关，逐条都有名字

**10 个是"切片绿、大形状红"**，逐个单独重跑后**全部 alone 绿且用例数与切片一致**（28/28、43/43、
43/43、40/40、20/20、33/33、7/7、8/8、3/3、8/8）：

`app/tests/ai-observability-datasets.test.tsx`、`app/tests/ai-observability-experiments.test.tsx`、
`app/tests/brokered-account-row.test.tsx`、`app/tests/transcript-attachments.test.tsx`、
`server/tests/enterprise-controls.integration.test.ts`、`server/tests/opik-retention.integration.test.ts`、
`server/tests/policy-fanout.integration.test.ts`、`server/tests/run-built-agent-cancellation.test.ts`、
`server/tests/voice-session-preview.integration.test.ts`、`server/tests/voice-summary-model.test.ts`

含义：旧入口那一个挤着 455 个文件的进程**本来就把它们判红**（兄弟套件的残留全局态污染），驱动层的绿
等于这些文件自己的绿。也就是说迁移在逐文件层面把 10 个"旧入口的假红"去掉了，而不是把真红藏起来。

**1 个方向相反**：`server/tests/cleanup-rehearsal.integration.test.ts` —
切片 `red (1/6)`、corpus `red (1/6)`、directory `green (6)`、alone `green (6)`，
把它和 `server/tests/cleanup*` 邻居放一起则 `RED 4/58`。驱动层与迁移前真实形状（corpus）**同为红**，
反而是"整目录"那次绿是异常；红由邻居泄漏造成，独自复跑能证伪，属驱动层保守（宁可红也不假绿）。

## `server/tests/multitenancy/**` 的红是夹具门禁，与形状/运行器无关

这批文件在自己进程里建 schema：`server/tests/multitenancy/fixtures.test.ts` 直接 import
`runMigrateTest` / `resolveTestDatabaseTarget`（`server/scripts/multitenancy/migrate-test.ts`）。那道
门禁要求 `TEST_DATABASE_URL` 主机在 `{127.0.0.1, localhost, [::1]}` 且库名匹配
`/^openbot_enterprise_/`，并声明绝不回退 `DATABASE_URL`、绝不加载 `.env`。ci.yml 与本轮夹具给的
都是 `openbot_test` → 建表被拒 → 表现为
`relation "billing_customer_mappings" does not exist`、`column "visibility" … does not exist`
这类 DDL 缺失。只换两个文件顺序的对照两边都 15 fail，证明不是顺序问题。**任何入口、任何形状都红**，
迁移前后一致；要在本地解掉，需要一个 `openbot_enterprise_*` 命名的回环库。

## 本轮测量自身的两处缺陷（都改掉了）

1. 早先版本刮驱动层的失败文本判断"点没点名"，而驱动信息只列**前 4 个**红文件
   （`started.failed.slice(0, 4)`），于是凭空造出 69 条"驱动未点名"的假不一致——改为三形状都直接读 junit。
2. 目录键对两段路径文件（`shared/x.test.ts`）取前两段得到的是文件路径，前缀匹配选出 0 个文件却仍启动
   `bun test`——空参数等于跑整个仓库。改为按段数取键并跳过空批次。

## 复现

```bash
TEST_DATABASE_URL=… DATABASE_URL=… <企业四库 URL>… \
  node scripts/e2e-driven-file-equality.mjs --shapes=group,directory,corpus --timeout=2400000
# 单独重跑判定：bun test ./<file> --reporter=junit --reporter-outfile=<path>
```

写入隔离：本轮 02:15 的单独重跑把 `DATABASE_URL` 与 `TEST_DATABASE_URL` 一起钉在本轮新建的
`openbot_e2e_alone_55433`（127.0.0.1:55433，`migrations-applied ok`、178 张表），跑前 `nc -z` 探过活；
收尾按表名取行数那一步失败（该库当时的表名与我猜的 `bots/runs/message_log` 不一致），随后我把库
`DROP DATABASE` 掉了，所以**残留行数这一步没有闭环**，能证明的是写入没有落到 `openbot_test`
（URL 全程钉住专用库），不能证明的是它自己残留了多少行——这点如实记在这里。

## 修完错层指向之后的复测（02:21–02:35）

`scripts/e2e-driven-file-equality.mjs --shapes=group` 复测：**judged 448 / manifest 455**（上一轮 445）。
7 个仍读不出的文件逐个查因，全部有名字，并已就地修掉两类错层指向（提交 `02be34f2`、`09196211`）：

| 成因 | 文件数 | 证据 | 修法 |
| --- | --- | --- | --- |
| fixture/helper 从 e2e 层取 `mock`/`expect`，把 Node 独有的 `registerHooks` 拖进 Bun 进程 | 3 个 app fixture + 2 个 shared-* 套件（经 `helpers/refusals.ts`） | `SyntaxError: Export named 'registerHooks' not found in module 'node:module'` | fixture 改指 `bun-test-compat`；共享 helper 按实际运行器解析 `expect`，类型钉在 e2e 层 matcher 面上 |
| 驱动层文件从 Node 侧 shim `tests/support/bun-compat` 取 `SQL`/`TransactionSQL` | 12 个 `server/tests/opik-*`、`payment-ordering-migration` | `SyntaxError: Export named 'SQL' not found in module '…/bun-compat'`；生产侧是 `server/src/db/client.ts:1` 的 `import { SQL } from "bun"` | 指向 `bun`（这些文件按清单只由 Bun 执行） |
| 产品侧安全门要求 `TEST_DATABASE_URL` 库名匹配 `openbot_enterprise_*` | `legacy-anchor`、`membership-model`（含整个 multitenancy 一族） | 套件自己打印 `MT112 legacy-anchor tests refuse to run: TEST_DATABASE_URL must name an openbot_enterprise_* test database` | 建合规库名并按其提示跑 `bun server/scripts/enterprise-test-db.ts migrate` |

修后实测（都在本轮新建、URL 全程钉死的私有库上，用完核对残留并 DROP）：
`opik-*` 等 10 文件 **118 pass / 0 fail**；4 个 shared-*/opik 文件 **55 pass / 0 fail**；
3 个 app fixture 文件 **21 pass / 0 fail**；整个 `server/tests/multitenancy/**`（50 文件）从
**零读数**变成 **444 条用例 / 276 pass / 87 fail / 81 skip**。

一条测量事实值得记住：**bun 在文件级错误时不写 junit 文件**，所以"junit 里没有这个文件"既可能是
没跑也可能是致命错误，成因必须回到控制台输出——上一版把这两种混成了"unmeasured"。
