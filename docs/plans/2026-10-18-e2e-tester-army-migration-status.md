# 测试全面迁 tester-army e2e · 执行状态

基线：会话开始时 `main` 为 `bbea87ba`；本轮迁移提交 `bced6121f`、`cb636f02`，本文与后续改动在其后。
决策依据：[ADR 0008](../adr/0008-test-runner-tester-army-e2e.md)。运行入口：`bun run test`（= `e2e run --config e2e.unit.config.ts`）、`bun run test:ui`（web target）。

## 全量测量（2026-10-18 18:45 CST，分区为 452 驱动 / 29 组，收口轮）

```
Test Files  34 failed | 550 passed | 17 skipped (601)
     Tests  195 failed | 7925 passed | 74 skipped (8194)
   Duration  645.36s
   Errors    4（全部点名 127.0.0.1:5432 与 127.0.0.1:6333 拒连）
```

18:22 那一轮（450 驱动 / 29 组）是 `8200 · 7931 passed · 195 failed`，结论一致；两轮之间只把
剩下 2 个运行器差异文件挪进驱动层。同一入口在 15:48 那轮（328 驱动、标题与 each 缺陷尚未修完）
是 `9030 discovered · 8521 passed · 426 failed · 10 COLLECTION_ERROR`：修掉标题去重域、`each` 尾随参数、
`bun-compat` 递归与端口快照、`config.ts` 的 `require` 后，失败从 426 降到 195、红文件从 107 降到 34，
并且**收集错误归零**（0 个 COLLECTION_ERROR，report 不再被单个文件拖没）。

驱动层这一轮 29 组：**12 组通过，17 组红**。其中 14 组是 `server/tests part N`，失败文本全是
`Failed query: insert into "users" …` / `PostgresError: Failed to connect` —— 本机 5432 此刻拒连
（`nc -z 127.0.0.1 5432` 失败，跑着的只有并行会话自己的 `*-pg` 容器），不是调度器坏了；
另外 3 组是 Bun 侧真实断言：`app/tests part 1`（21 of 281，TestingLibrary "Found multiple elements"）、
`agent-sandbox/tests`（2 of 17，S4 workspace snapshot 的 keepalive 断言）、以及 `old-runner-unreadable` 的
`agent-sandbox/tests/proxy.test.ts`。也就是说**驱动层还需要一次 Postgres 在跑的复测**才能给出一句结论。


这 195 条失败的构成（逐条判定见下节，报告本身在 `.e2e/final/report.json`）：

- **17 条是驱动组自己的失败**：`tests/bun-suites.test.ts` 里每组一条断言，红的是 Bun 层内部
  真实失败的套件（如 `agent-sandbox/tests: 2 of 17 bun tests failed`）——不是调度器坏了。
- **本机依赖没起**：Postgres `127.0.0.1:5432` 与 Qdrant `127.0.0.1:6333` 此刻 ECONNREFUSED，
  4 条 `HOOK_FAILED` 点名这两个地址；`server/tests/enterprise/*` 与 `server/src/knowledge/*`
  的多数断言失败（`WORKSPACE_FORBIDDEN`、`expected "degraded" to be "hit"`）是这套环境的形状。
- **迁移前就红的套件**仍然红着，这是有意保留的如实结果，不是回归。

## 范围边界（"所有的测试"具体指哪些）

本次覆盖的是 `package.json` 原 `test` 脚本列出的 14 个目录：`app server shared supervisor worker tests scripts deliverables desktop agent-bot agent-sandbox agent-langgraph agent-mastra agent-computer`（937 个 `.test.ts(x)` / `.spec.ts` 文件）。此外三类测试**不在** e2e 框架能承载的范围内，逐项说明而非静默跳过：

| 位置 | 数量 | 为什么不能迁 | 证据 |
| --- | --- | --- | --- |
| `runtime-go/**/*_test.go`、`agent-trpc/**/*_test.go` | 18 | Go 的测试由 `go test` 编译进二进制；e2e 只有 web 与移动端引擎，没有 Go 引擎，CI 里也是独立 job | `find runtime-go agent-trpc -name '*_test.go'` |
| `bifrost/`（git submodule） | 自带 playwright/mocha 套件 | 子模块的测试属于该仓库与其工具链，主仓库既不调度也不应改写；`bun test` 时代同样不在 14 目录内 | `.gitmodules` |
| `apps/openmuse/`（git submodule） | — | 同上；`biome.json` 也按同一理由排除该路径 | `.gitmodules`、`biome.json` |
| `deliverables/mobile-e2e-qa/**.spec.ts` | 6 | 面向 Appium driver 与真机 bundle id，仓库里没有设备与 appium；迁移前 `bun test` 也不会通过 | 记为 artifacts，见 `docs/verification/e2e-bun-suites.json` |
| `.worktrees/`、`.claude/worktrees/`、`.omc/` | 数百 | 是同一仓库的并行 worktree 与调研快照副本，不是额外套件；收集 glob 不匹配它们（目录名以 `.` 开头且未列入） | `find` 输出 |


## 已完成并且有证据

| 项 | 状态 | 证据 |
| --- | --- | --- |
| `bun:test` 全部退出使用 | 完成 | `grep -rl 'from "bun:test"'` 在 15 个套件目录下只剩 1 个文件，且那处 import 位于交给子 Bun 执行的模板字符串内（`agent-computer/tests/identity.test.ts`）；`support/e2e-compat` 被 908+ 文件 import |
| 运行器能真正收集并执行 | 完成 | `scripts/e2e-file-audit.mjs` 逐文件跑 e2e：936 个套件文件中 **686 个由 e2e 原生收集，注册 9122 条用例**；清单 `docs/verification/e2e-file-audit.json` |
| 兼容层补齐框架不提供的单元语义 | 完成 | `tests/support/e2e-compat.ts`：`toThrow`/`rejects`/`resolves`/`toBeInstanceOf`/type matcher/mock 断言、`test.each`/`describe.each`、`mock`/`spyOn`/假时钟、`mock.module`（Node loader 钩子 + 进程级注册表）、样式与静态资源、bun 的 `test(title, fn, timeoutMs)` 位参、`{retry}`→`{retries}`、标题 512 字节钳制与重名编号、跳过改为运行期跳过（避免 NO_TESTS 让整轮不执行） |
| Bun 运行时专属 API 的 Node 移植 | 完成 | `tests/support/bun-compat.ts` 覆盖 `file/write/spawn/sleep/which/argv/CryptoHasher/serve`；agent-computer 范围实测从「全部收集失败」变为 **393 passed / 46 failed / 48 skipped（47 文件）**，随后 32 条失败被定位为缺失 matcher 并已补齐（未复测，见下） |
| 留在 Bun 的套件由 e2e 调度与报告 | 完成（机制） | `tests/bun-suites.test.ts` 按 `docs/verification/e2e-bun-suites.json` 注册 **229 个文件 / 11 组**，每组跑 `bun test --reporter junit` 并把用例数与失败文本折进一条 e2e 断言；0 条用例判失败 |
| 不可执行产物单列 | 完成 | `deliverables/mobile-e2e-qa/**.spec.ts` 6 个文件（面向 Appium 与真机 bundle，`bun test` 时代也不可执行）记为 artifacts，配置排除，不混进驱动组 |
| 依赖运行中部署的 API 套件分出去 | 完成 | `tests/e2e/api.e2e.test.ts` 43 条断言的是 HTTP 契约，默认 `bun run test` 不再收集它（`OPENBOT_LIVE_API=1` 或 `bun run test:api` 时收集，实测两个方向 0 / 43 条）；它没有任何环境门槛，留在默认入口只会把"没人起服务"报成产品回归 |
| 运行时边界可用导入图判定 | 完成 | `scripts/e2e-import-boundary.mjs`：183 个套件在导入期就需要 Bun（176 个经由 `server/src/db/client.ts` 的 `import { SQL } from "bun"`），与运行器逐文件审计比对，695 个可收集文件里仅 1 个判断不一致；`--apply` 可把结论并入分区 |
| CI 与本地入口切到 e2e | 完成 | `package.json` 的 `test`/`test:smoke`/`test:live-screen`/`test:live-composio`；`scripts/test-ci.ts` 改读 `report.json`，对「有文件没被收集」直接判失败；`.github/workflows/ci.yml`、`desktop.yml` 中 8 处 `bun test` 全部替换（两个 YAML 均通过解析校验） |

## 归因结果：这 195 条失败各自是谁的责任

`node scripts/e2e-vs-bun.mjs --report=.e2e/final/report.json --out=docs/verification/e2e-vs-bun-final.json`
对 34 个红文件逐个跑三种组合（判定明细在 `docs/verification/e2e-vs-bun-final.json`）：

| 判定 | 文件数 | 含义 |
| --- | --- | --- |
| `already-red-at-baseline` | 18 | 迁移前整树 + 迁移前套件 + `bun test` 也是红的 → 与本次迁移无关的既有失败 |
| `red-on-old-runner-with-current-code` | 12 | 现网生产代码 + 迁移前套件文本 + `bun test` 也是红的 → 换运行器没有改变结论（这 12 个几乎全是 `server/tests/enterprise/*`，本机 5432/6333 拒连正是它们的依赖） |
| `runner-difference` | 2 | 同一份代码同一份套件文本，旧运行器绿、e2e 红：`app/tests/github-sources-settings.test.tsx`、`app/tests/memory-settings.test.tsx`，共 3 条断言。已按 ADR 0008 的两层制补进驱动层（Bun 执行、e2e 调度与报告），这是本轮唯一剩余的「运行器差异」 |
| `no-pre-migration-suite` | 1 | `tests/bun-suites.test.ts` 本身是迁移产物（驱动层 17 组各一条断言，红的是 Bun 侧套件内部真失败） |
| `old-runner-unreadable` | 1 | `agent-sandbox/tests/proxy.test.ts`：当时读不到结论是因为它无条件绑 4600，与同时在跑的整库运行撞端口。端口空出来后判定完成：同一份代码 + 迁移前套件文本在 `bun test` 下 **25 pass / 0 fail**，在 e2e 下稳定 **24 pass / 1 fail**（`GET /events forwards the directory scope to the upstream`）→ 是运行器差异，已按 ADR 0008 分驱动层，原因未解的地方写在下节 |

也就是说：整条原生层 195 条里，能归到「迁移把它改红了」的只有 3 条，且已处理；
其余要么迁移前就红、要么依赖没起、要么是 Bun 层内部失败被如实上报。

`node scripts/e2e-vs-bun.mjs` 把每个失败文件跑三遍再比对：

| 组合 | 树 | 套件文本 | 运行器 |
| --- | --- | --- | --- |
| 新运行器 | 当前 | 迁移后 | e2e（`report.json`） |
| 旧运行器 | 当前生产代码 | **迁移前** | `bun test` |
| 基线 | 迁移前整树 | 迁移前 | `bun test` |

中间那行才是决定性对照：代码与套件文本都一样，只换运行器。两棵树都是工作树之外的副本
（`git archive` / `rsync` 到 `~/.cache/openbot-e2e/`，node_modules 用符号链接），取证不写这个
共享工作树。旧运行器绿的判为 `runner-difference`，由 `scripts/e2e-route-failures.mjs --verdict=`
分到 Bun 层；旧运行器也红的判为 `already-red-at-baseline`，留在原生层如实报失败。

再往前一轮（15:48，分区 328 驱动时）判出 107 个红文件：其中 **84 个 `runner-difference`** 已由
`--verdict=runner-difference --apply` 全部补进驱动层，**19 个 `already-red-at-baseline`**
（`server/tests/config|schema|copilot|audit|guards|ready`、`tests/compose`、`server/src/knowledge/*`、
`server/tests/enterprise/*`）留在原生层如实报失败，2 个在迁移前不存在（并行会话新增），
1 个旧运行器输出读不出。剩下的 34 个就是上表这一轮。

## 固定监听端口会让 verdict 取决于谁抢到端口

`agent-sandbox/tests/proxy.test.ts` 无条件 `serve({ port: 4600 })`。后果不是它自己红不红，
而是**同一条套件在两个进程里同时跑时，谁晚到谁 EADDRINUSE**：对照跑（`bun test` 该文件）撞上正在
进行的 `bun run test`，旧运行器就直接中止、junit 不写，于是它的归因停在"未判定"。
迁移前后这一点没有区别（`bun test ./agent-sandbox` 时代也一样占住 4600），也不是兼容层该藏的：
让 Node 端口悄悄回落到别的端口，会把"这个套件假设了固定端口"这一事实抹掉。
要它稳定，应由该套件改绑 0 再读实际端口（`serve().port` 已经能读到绑定后的端口，见
`tests/support/bun-compat.ts` 的 `boundPort()`）。

## 迁移过程中修掉的真实缺陷（不是「让测试变绿」，是原来就坏的地方）

1. **标题去重的域搞错了。** 兼容层按「文件 + 标题」查重并编号，而 e2e 的唯一性域是整条
   title path；于是不同 `describe` 里同名的合法测试被编号，第二遍导入又给出不同后缀。
   `server/tests/config.test.ts` 一个文件就报 125 个失败 / 89 个 COLLECTION_ERROR。改为按
   完整路径判定重复，并在 loader 观察到套件文件再次进入时复位计数。
2. **`each` 标题把没消费完的参数也拼进去了。** bun 的格式化会追加多余参数，套件正依赖这一点：
   `refuses %s before dispatch` 的行是 `[label, token, jwt]`，标题里就带上了含 `exp` 时间戳的
   JWT；另一处带的是 Error，其创建栈记录本次是怎么导入文件的。e2e 的列举与执行是两个进程，
   标题不可能一致 → "disappeared before execution"。改为标题只取模板消费的占位符，测试体照旧
   收到全部参数。`remote-coordination` 24/24、`desktop-connection-failure` 8/8 由红转绿。
3. **`bun-compat` 的 `spawn` 包装自引用。** `Object.assign(child, {kill: () => child.kill()})`
   把自己赋给了被包装的方法 → 无限递归（"Maximum call stack size exceeded"，4 个文件）。
   先 `bind` 原生方法再包装；顺带修 `Bun.file(p).exists`（Bun 是返回 Promise 的方法，不是属性）
   和 `Bun.CryptoHasher.hash` 静态形式。
4. **`serve()` 的 port 是绑定前的快照。** 套件用 `port: 0` 拿临时端口再拼 URL，于是请求打到
   `http://127.0.0.1:0`。改为读 `server.address()`。
5. **生产代码里的 Bun-ism。** `server/src/config.ts` 的 `pemOrFile` 用 Bun 在 ESM 提供的全局
   `require` 读 PEM，Node 没有这个全局 → `payment-config` 22 个失败。换成 `createRequire` 句柄，
   保留「fs 不进即时导入图」的原意。同类问题先前还有 `twilio` 的具名导出探测。
6. **迁移脚本会改到自己的地基。** 它把 `tests/support/bun-test-compat.ts`（专职 re-export
   `bun:test`）和 `bunfig.toml` 的 preload 也重写了，等于让 Bun 层套件去调 e2e 注册表；现在跳过
   兼容层与 preload，`require()` 重写也只处理代码行、不再篡改注释里的说明文字。
7. **驱动层的分组会凭空造失败。** `bun test` 把交给它的文件放进同一个进程，留下全局状态的套件
   会把单独跑全绿的兄弟文件改红。证据：`app/tests/bot-needs-you.test.tsx` 在迁移前整树按目录跑
   是 7 pass / 0 fail，今天单独跑仍是 7 pass / 0 fail，但在按字母切出的 24 文件组里红 18 条，
   而排在前面的正是新合入的 `ai-observability-*` 套件。两处处理：`scripts/lib/e2e-manifest.mjs`
   给这类套件族单独成组（`ISLANDS`），`tests/bun-suites.test.ts` 在组内出现失败时**只把失败文件
   各自重跑一次**，以「独自也红」为真实失败、把「只在共享进程里红」打到 stderr 点名；重跑预算
   （8 个文件 / 300 s）用完按失败处理，不给假绿。
   复核：`PROBE_FILE=tests/bun-suites.test.ts E2E_BUN_ONLY='app/tests' ./node_modules/.bin/e2e run --config e2e.probe.config.ts`
   → `app/tests part 1–4` 全过（其中 4 个文件被点名为进程共享所致），
   `app/tests/ai-observability` 仍判失败（route-chain、runs-list 独自也红，是真实缺陷）。

## 尚未完成（这是"全部测试已在 e2e 上跑起来"这句话还差的部分）

1. **19 个迁移前就红的文件仍然红。** 它们留在原生 e2e 层如实失败（约 90 条断言），需要各自
   owner 处理；本次迁移没有把它们改成跳过或迁到别的运行时。
2. **需要外部服务的套件仍取决于环境。** `HOOK_FAILED` 里 Qdrant（127.0.0.1:6333）与本仓库
   Postgres 连接失败是这台机器没起依赖，不是运行器问题。
3. **`bun run test:ui` 只验到收集层**（28 条 web 用例可收集）；执行需要 dev server 与浏览器栈。
4. **驱动组规模变大**（328 个文件 / 24 组），整组 `bun test` 的墙钟时间显著长于原生层，
   CI 里需要按 `E2E_UNIT_SCOPE` 切目录并行，否则单作业跑完整个 corpus。

5. **留下全局状态的套件仍会互相污染。** 驱动层现已能把「只在共享进程里红」与「独自也红」分开报，
   但污染源头（fetch stub / happy-dom 注册没还原）要由这些套件自己修；`bun test` 一个进程跑多个
   文件是这个运行方式的固有属性，迁移前后都在。
6. **Postgres 没起的这台机器上，驱动层的 server 组无法给出结论。** 独自复跑要先确认
   `tests/bun-suites.test.ts` 的复跑上限判断顺序（现在会先复跑 8 个文件再判超限），
   然后需要一次 `127.0.0.1:5432` 在听的复测；这属于共享设施，动它之前要用户同意。

## 一条已按两层制安置、但根因未定的运行器差异

`agent-sandbox/tests/proxy.test.ts` 在 e2e 下 `GET /events forwards the directory scope to the
upstream` 稳定失败（2 次运行都是 24 pass / 1 fail），而同一份生产代码 + 迁移前套件文本在 `bun test`
下 25 pass / 0 fail。现象是：假上游（`serve({ port: 4600 })`）自己记录的 `eventUpstreamRequests`
是空数组 —— 也就是 `forwardEvents` 那一次 `fetch` 根本没被它记到，可同文件其余 24 条都过。
排查中顺手修掉一个确实存在的移植缺陷：`tests/support/bun-compat.ts` 的 `serve()` 原先
`response.arrayBuffer()` 全量缓冲后再写出，事件流这类"不会结束"的响应永远刷不出来，现在逐块 pipe。
但这条断言的根因还没定位，所以套件按 ADR 0008 留在 Bun 层（分流后 `agent-sandbox/tests` 整组通过），
没有靠猜改生产代码。要接手的人从 `agent-sandbox/src/sse.ts:59` 的 upstream URL 与
`serve()` 的 `Request` 构造两处看起。

## 迁移之外、但卡住 CI 关卡的 main 破损（2026-10-18 19:46 CST 核实）

`cd app && bunx tsc --noEmit` 在 `HEAD=6e024bce`（工作树对 `server/src/config.ts` 无改动）报 6 个错，
全部落在 `server/src/config.ts`，来源是合并 `084642a3 Merge commit '1c2a8413…' into integration/consolidate-all-20261018`：

- 1624 行调用 `parseGatewayBaseUrl(baseUrl)`、1628 行调用 `parseRequestTimeoutMs(...)`，
  但这两个函数在本文件里既没定义也没导入 —— 它们在 `server/src/gateway/endpoint.ts` 里
  （`git grep -c 'function parseGatewayBaseUrl' HEAD -- server/src` → 只有 endpoint.ts 命中）。
  本机 `.env` 没有 `GATEWAY_BASE_URL`，所以测试里看不到它炸；**一旦部署设了这个变量，读配置就会
  ReferenceError**。
- 接口里 `gateway?:` 被声明两次且类型不同（274 行 `GatewayEnvConfig`、466 行 `Config`），
  TS2300/TS2717，连带 2954 行的返回对象不再满足 `DeploymentConfig`。

这不是迁移造成的（`bun test` 时代同样编译不过），但它让 `bun run typecheck` 与 `bun run test:ci`
的关卡无法给出干净结论，所以要由该波次的 owner 修（补 import 或删重复声明），不由测试侧代劳。

## 用独立 Postgres 复测驱动层（2026-10-18 19:54–20:12 CST）

这台机器上 `127.0.0.1:5432` 没人监听、`.env` 的 `TEST_DATABASE_URL` 指向 5435（也没有容器发布它）、
项目自己的 `openbot-postgres-1` 现在发布在 **55432**；而本仓库多条 brief 明确要求验证不得用
5432/5435/55432。所以按同样的规矩起了一个自己的实例，只动自己的容器：

```bash
docker run -d --name openbot-e2e-verify-pg -p 127.0.0.1:55433:5432 \
  -e POSTGRES_DB=openbot_enterprise_test -e POSTGRES_USER=openbot \
  -e POSTGRES_HOST_AUTH_METHOD=trust openbot-postgres:latest
docker exec -i openbot-e2e-verify-pg psql -U openbot -d openbot_enterprise_test -v ON_ERROR_STOP=1 \
  < server/ops/enterprise/roles.sql            # migrate.ts 的 role 前置检查要它
(cd server && DATABASE_URL="postgres://openbot@127.0.0.1:55433/openbot_enterprise_test" bun scripts/migrate.ts)
TEST_DATABASE_URL="postgres://openbot@127.0.0.1:55433/openbot_enterprise_test" \
  E2E_UNIT_OUTPUT=.e2e/drivenfull ./node_modules/.bin/e2e run --config e2e.unit.config.ts
```

结果（`.e2e/drivenfull/report.json`，15m33s）：`8192 · 7931 passed · 187 failed`，
**驱动层 30 组从 13 过 / 17 红变成 18 过 / 12 红** —— 证实之前那批 `server/tests part N` 的红
是数据库不在，而不是调度或套件本身。剩下 12 组每条都点名了「各自单独跑也红」的文件，
即迁移前用 `bun test` 单跑该文件同样会红的真实条目：

- `agent-sandbox/tests/sse.test.ts`（2/11，S4 keepalive 帧与 forwardEvents 计数）
- `app/tests/ai-observability-route-chain.test.tsx`（5/5，`queryClient.ensureQueryData` 未定义）
- `server/tests/multitenancy/*`、`server/tests/enterprise/tenancy-rls.integration.test.ts` 等：
  部分要 `ENTERPRISE_TEST_DATA_DATABASE_URL` / `ENTERPRISE_TEST_DIRECTORY_DATABASE_URL`
  与 setup URL 同实例同库（补齐后 part 7 从 8 个红文件降到 7 个），其余是断言本身不过
- `server/tests/cleanup-dry-run.integration.test.ts`（期望 21 实得 29）等取决于库里有什么数据

也就是说：**这 12 组里已无「e2e 或分组造成的」失败**——每条都被"单独跑该文件"复核过。
要把它们变成绿，需要 multitenancy / observability / agent-sandbox 各波次的 owner 补夹具或修断言，
不属于测试框架迁移能替他们决定的范围。复测用完的容器收掉：`docker rm -f openbot-e2e-verify-pg`。

## 「所有测试都在 e2e 上」是一笔可对账的账，不是一句声明

`node scripts/e2e-coverage-audit.mjs`（已接进 `bun run test:ci`，跑在 e2e 之前）逐个文件归类，
落在四个桶之外就报文件名并以非零退出：

```
1073 suite files in the 14 migrated directories · 604 native e2e · 453 driven by e2e (bun runtime) · 10 engine (.e2e.ts, web/mobile) · 6 named exclusions
no gaps: every suite file is scheduled by e2e, or excluded by name with a reason.
```

- `native`：被 e2e 在 Node 上收集并执行（import `support/e2e-compat`）。
- `driven`：由 e2e 调度与报告、由 `bun test` 执行（ADR 0008 的两层制；必须指向
  `support/bun-test-compat` 或原样 import `bun:test`，否则记为 gap）。
- `engine`：`.e2e.ts` 与 `@e2e-dev/*` 的引擎用例（web / 移动端 target）。
- `exclusions`：按名字记录在清单里并写明原因的 —— 现在只剩 6 个 Appium 移动产物
  （`deliverables/mobile-e2e-qa/**.spec.ts`，没有设备与 appium 也跑不动，迁移前一样）。
  第 7 个已经不再需要例外：`server/tests/qa-batch1-migration-0071.test.ts` 读的是
  `../drizzle/0071_billing_idempotency.sql`，而后一批发把 0071 占了给
  `enterprise_model_route_catalog`、billing idempotency 挪到 **0081** —— 导入期 ENOENT 会让整轮
  收集中止。这个探针断言的本来就是 billing idempotency 的内容（列、两条索引、快照与 journal 顺序），
  所以把它指回它真正描述的那一支（0081）后 **8 条断言在 `e2e run` 下全过**，条目移入
  `e2e-known-broken.json` 的 `resolved`，套件重新被收集（`E2E_UNIT_SCOPE=server e2e list` 里能看到 8 条）。

gap 的两种形态正是入口坏掉的原因：写着 `bun:test` 却没被分到驱动层的文件会让**整轮收集中止**
（一个文件就没有 report），两个 runner 都没 import 的文件会**静默不跑**。所以这一项先跑、失败即停。

## CI 入口那一轮（`bun scripts/test-ci.ts`，20:22–20:44 CST）

先跑覆盖对账（`no gaps · 604 native / 453 driven / 10 engine / 6 exclusions`，含入口检查：
`package.json` 与各 workflow 里没有任何 `bun test`），再跑 e2e：

```
Test Files  32 failed | 550 passed | 17 skipped (599)
     Tests  192 failed | 7926 passed | 74 skipped (8192)
   Duration  1319.85s (22m 0s)
   Errors  4  ← 全部点名 127.0.0.1:5432 / 6333 拒连（这台机器上项目的 Postgres 实际发布在 55432）
```

关卡按设计判失败（红点存在就该失败），报告与红点归属都落在 `.e2e/cigate/report.json` 与
`docs/verification/e2e-red-inventory.md`。同一份账在数据库可达时的那轮（19:54）是
`7931 passed / 187 failed`、驱动层 18/30 组过。

## 修好挂退与墙钟之后的那一轮（21:21 CST）

`E2E_UNIT_OUTPUT=.e2e/exitcheck ./node_modules/.bin/e2e run --config e2e.unit.config.ts`：

```
Test Files  31 failed | 552 passed | 17 skipped (600)
     Tests  177 failed | 7933 passed | 90 skipped (8200)
   Duration  1491.37s (24m 51s)   ← 汇总末尾被我中断，按打印出的汇总记录
```

两点观察：

1. **退出是干净的**：进程终止后 `127.0.0.1:4600` 立刻释放、没有残留的 `e2e run` 进程，
   `serve()` 的 `unref()` 与驱动组的 840 s 墙钟都在生效。
2. **一轮的墙钟从 11 分钟涨到 25 分钟**，代价来自"失败文件各自重跑一次"（正确性换时间）。
   因此在 CI 里应当按 `E2E_UNIT_SCOPE` 切目录并行跑，而不是让单个作业等整库；
   单作业超过 40 分钟就会被 `timeout` 截断（这次 2400 s 的预算刚好卡在边界）。

失败数从 192 降到 177、红文件从 32 到 31，差的就是分流掉的 `account-mode-dialog` 与
驱动层判定收紧的结果。

## 本地跑这件事的数据库前提（以及为什么我这台机器上少测了 14 组）

CI 的 `test` job 自带两个数据库服务：`postgres`（镜像带 pgvector，因为知识 schema 用扩展）与
`enterprise-postgres`，并把 `DATABASE_URL` 指到 `localhost:5432/openbot_test`，所以企业/多租户那批
集成套件在 CI 里是真的有库可跑。本地不一样：

- 这台机器上项目的 Postgres 容器实际发布在 **55432**（`.env` 里 `POSTGRES_PORT=55432`），
- 而 `.env` 的 `TEST_DATABASE_URL` 指向 **5435**，那个端口现在没有任何容器在听，
- 默认回落的 `localhost:5432` 也没人监听 → 报告里 4 个 `HOOK_FAILED` 与 14 组 `server/tests part N`
  的红就是这么来的，不是套件坏也不是调度坏。

本地要测到同一批，三选一：起项目自己的栈并把 `TEST_DATABASE_URL` 改成实际端口；照本文
「用独立 Postgres 复测驱动层」一节自建一个私有实例；或者接受这 14 组只在 CI 上有结论。
判定规则不变：这些红都在 `bun test` 单文件复跑里复现，因此与运行器无关。

## 完成度审计：每条标准对应什么证据，以及哪几条还没过

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 14 个目录里每个套件文件都由 e2e 调度或按名排除 | 过 | `node scripts/e2e-coverage-audit.mjs` → `no gaps`（603 native / 454 driven / 10 engine / 6 exclusions） |
| 2 | 没有任何测试入口还跑 `bun test` | 过 | 同一审计的 ENTRY-POINT 检查（package.json 与各 workflow），且 `bun run test:ci` 就是 ci.yml `test` job 第 443 行那一步。入口实跑过：`bun run test` → `pretest`(generate:app-config) → `e2e run --config e2e.unit.config.ts`，21:36–21:54 走完 8175 条（7912 passed / 189 failed / 4 env errors），打印汇总后**自行退出**（exit 1，`ps` 里没有残留 e2e 进程，端口释放） |
| 3 | 收集不再被单个文件拖没 | 过（当时） | 19:24 / 21:21 两轮 `0 COLLECTION_ERROR`；新加套件由 `e2e-batch-drive-bun-test` 与分区循环兜住 |
| 4 | 全量通过率被测出来并逐条归因 | 过 | `.e2e/*/report.json` + `scripts/e2e-vs-bun.mjs` 的 `e2e-vs-bun*.json`，汇总见上；红点派单表 `docs/verification/e2e-red-dispatch.md` |
| 5 | 原生层不存在"迁移把它改红了"的条目 | 过（最后一次判定） | 逐条 runner-difference 都已修或分流；最后一条 `proxy.test.ts` 有 25/0 对 24/1 的证据并写入 ADR 两层制 |
| 6 | 驱动层的 verdict 等于旧运行器对同一文件的 verdict | 结构上过，运行结果未全绿 | 驱动层用 `bun test` 执行且对失败文件各自重跑；`agent-sandbox/tests` 分流后整组通过；30 组在数据库可达时 18 组过（其余红点都是"单独跑也红"的既有失败） |
| 7 | 引擎层（`tests/e2e/*.e2e.ts`，28 条）跑通过 | **未过** | 只验到收集。需要 app 起在 3010 与 `.env` 里那个 OpenAI 兼容端点（agent 驱动、花真钱、结果不完全确定），尚未获得启动许可 |
| 8 | `bun run test` 绿 | **未过** | 21:54 那一轮 30 个文件红 / 189 条失败：其中约 18 个文件迁移前就红、12 个用现网代码 + 迁移前套件文本在 `bun test` 上也红、其余是本机 5432/6333 依赖没起（含 14 组驱动组）。这些红在旧运行器上同样复现，不是迁移造成的，但也不该被改成绿 |
| 9 | `bun run typecheck` 绿 | **未过（非迁移原因）** | 合并 `084642a3` 让 `server/src/config.ts` 调用未导入的帮助函数且重复声明 `gateway?:` |
| 10 | 决策与约束进了 ADR / 文档 | 过 | ADR 0008 两节补充（标题即身份、分组不造 verdict、覆盖可对账）+ 本文 |

第 6、7、8、9 条没过，所以这件事现在不能称"完成"。

## 复核方式

```bash
node scripts/e2e-file-audit.mjs --jobs=8      # 逐文件收集真值 → docs/verification/e2e-file-audit.json
node scripts/e2e-bun-manifest.mjs             # 分区 → docs/verification/e2e-bun-suites.json
bun run test                                  # 原生套件 + 驱动组，一次入口
E2E_UNIT_OUTPUT=.e2e/final ./node_modules/.bin/e2e run --config e2e.unit.config.ts
                                              # 这个 checkout 上多个会话会同时跑 e2e，
                                              # 共用输出目录会互相覆盖 report.json；测量要指名自己的目录
node scripts/e2e-report-summary.mjs .e2e/unit/report.json   # 按失败原因分组
node scripts/e2e-vs-bun.mjs --jobs=5          # 逐个失败文件对比旧运行器 → docs/verification/e2e-vs-bun.json
node scripts/e2e-route-failures.mjs --verdict=runner-difference --apply   # 按判定分流
E2E_UNIT_SCOPE=app bun run test               # 只收集某目录，把回合从几分钟压到秒级
E2E_COMPAT_DEBUG=1 ...                        # 兼容层把测试体的抛错栈打到 stderr（runner 只给一行消息）
```
