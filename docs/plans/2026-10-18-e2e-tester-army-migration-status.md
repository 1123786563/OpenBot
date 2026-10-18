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
| `old-runner-unreadable` | 1 | `agent-sandbox/tests/proxy.test.ts`：旧运行器 junit 读不出计数，不当作通过 |

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
