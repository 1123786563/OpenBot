---
status: accepted
---

# 以 tester-army e2e 作为唯一测试运行器，并用兼容层承载框架未提供的单元断言

仓库原有两套入口：`bun test` 执行 912 个 `bun:test` 文件（单元与集成），`e2e run` 执行 10 个 UI 文件。用户要求把所有测试迁到 tester-army `e2e` 框架，并在两个岔路口选择了代价最高的方案：全量迁移 + 自建兼容层，且允许为让测试跑在 Node 上而移植依赖 Bun 运行时的代码。

`e2e` 的 CLI 只接受 Node（`engines: node ^22.22.3 || >=24.8.0`），其 `expect` 按自身文档刻意不含 `toThrow`、`rejects`、`resolves`、`toBeInstanceOf`、mock 调用断言与 `expect.extend`，也不提供 `test.each`、`mock`/`spyOn`。这些缺口对应仓库里 `toThrow` 260 个文件、`.rejects` 220、`toBeInstanceOf` 122、`.resolves` 74、`test.each`/`describe.each` 120、`mock`/`spyOn` 46 处用法。

因此 `tests/support/e2e-compat.ts` 成为唯一入口：运行器、收集、钩子、locator、报告与缓存全部来自 `e2e`，兼容层只补框架未提供的值断言、参数化注册、Bun 风格的 spy 与假时钟，其余一律转发而不重新实现。`tests/support/bun-compat.ts` 同理，用 Node 的 `child_process`、`fs`、`crypto`、`http` 提供套件实际用到的 `Bun` 子集（`file`、`write`、`spawn`、`sleep`、`which`、`argv`、`CryptoHasher`、`serve`），使"以子进程探测真实行为"的用例在 Node 上仍然是真探测，而不是被删掉。

未选"行为测试进 e2e、白盒单测留 `bun:test`"：这是框架文档自己的建议，代价最小，但用户明确要的是单一框架。未选"e2e 作为聚合入口、内部继续调 `bun test`"：一个命令确实能跑完所有测试且零重写，但单元套件并没有运行在 e2e 上，不符合要求。

代价是三条必须长期守住的约束。第一，兼容层是仓库自维护的代码，框架升级新增或改动 matcher 时由我们同步，不是框架的义务。第二，测试进程不再有 Bun，`desktop/`（156 个文件、1797 处 `Bun.*`）这类强绑 Bun 运行时的套件需要显式移植或以子进程方式验证。第三，`e2e` 的收集按文件容错性差（一个文件求值失败即报 `COLLECTION_ERROR`），所以 `scripts/e2e-collect-triage.mjs` 与 `scripts/e2e-report-summary.mjs` 属于测试基础设施，不是临时脚本。

## 2026-10-18 补充：留在 Bun 运行时的套件由 e2e 统一调度与报告

实施到 server 时撞到一条本 ADR 事先没写清的事实：`server/src/db/client.ts` 用 `import { SQL } from "bun"` 与 `drizzle-orm/bun-sql`，`server/src/index.ts` 用 `serve` from "bun"，另有 10 处 `Bun.serve`。逐文件收集审计（`scripts/e2e-file-audit.mjs`，936 个文件）显示这些以及 Bun 加载器特有的行为（样式/静态资源、可写的 ESM namespace、CJS 与 ESM 双构建的命名导出解析）合计让约 290 个文件无法在 Node 进程里加载。把它们改成 `pg` + `node:http` 等于重写服务的数据层与 HTTP 层，还要重新验证那段针对 Bun SQL/TLS 语义的判定逻辑，已超出"为跑测试而移植"的范围，因此按用户裁决改为：**这些套件继续以 Bun 作为执行运行时，但入口、调度与报告统一归 e2e。**

落点是 `tests/bun-suites.test.ts`：它按 `docs/verification/e2e-bun-suites.json` 的分组各注册一条 e2e 用例，用 `bun test --reporter junit` 执行该组，再把 bun 自己的用例数与失败文本折进一条 e2e 断言；用例数为 0 视为失败，避免"没跑到"被读成"通过"。清单由 `scripts/e2e-bun-manifest.mjs` 从审计结果生成，只收真正依赖 Bun 运行时/加载器的原因（`Cannot find package 'bun'`、`bun:sqlite`、`Bun is not defined`、`Unknown file extension`、`Cannot assign to property … of [object Module]`、CJS 双构建的 `does not provide an export named`）；`deliverables/` 那批面向 Appium 与真机 bundle 的移动端 QA spec 单列为不可执行产物，既不原生收集也不假装驱动。其余收集失败一律留在"待修"清单上当作本仓库 harness 的缺口处理，不许借道另一运行时藏起来。

`e2e.unit.config.ts` 读同一份清单排除这些文件，因此一份测试要么被 e2e 原生收集，要么由 e2e 驱动到 Bun，不会两边都不管，也不会重复计数。清单是快照而非长期方案：随着兼容层补齐，条目应当只减不增。


单元与集成套件在 `e2e.unit.config.ts` 的 tools-only target（无 engine，因此不开浏览器、不调用模型）上运行，UI 套件留在 `e2e.config.ts` 的 web target，两者用 `--config` 选择；`bunfig` 预加载与 `bun test` 不再是测试入口。

## 2026-10-18 补充二：标题是身份、分组不是证据、覆盖要能对账

第一轮全量测量（9235 条用例里 1125 条失败）暴露出三条本 ADR 事先没写的硬约束，它们现在是要长期
守住的规则，而不是一次性修 bug 的记录。

**一、标题是测试的身份，而 e2e 的列举与执行是两个进程。** 运行器会先把文件列一遍再执行一遍，
并要求两遍注册的是同一组标识；`report.json` 里 `pid` 不同证明这两遍不在同一进程。因此：
唯一性域是**整条 title path**，不同 `describe` 下的同名叶子标题不是重复，给它编号会让第二遍报出
不同后缀（一个 `config.test.ts` 就这样报了 125 个失败）；标题必须是**声明的函数**，不能含导入期
生成的数据 —— 三个套件把运行期生成的 Ed25519 JWK 或随机 id 写进 `each` 标题，于是两遍永远对不上。
兼容层因此只取模板消费的占位符（bun 的格式化会把没用完的行参数也拼进标题，而 `each` 的行里就带着
含 `exp` 的 JWT 和 Error 的创建栈），并把计数按文件复位。结论性的口径：**e2e 的失败不是"迁移改了
结论"的证据**，要用 `scripts/e2e-vs-bun.mjs` 在同一份生产代码上把迁移前的套件文本交给旧运行器再跑
一遍，只有"旧运行器绿、新运行器红"才算运行器差异。

**二、`bun test` 把交给它的文件放进同一个进程，所以驱动层的分组会自己造失败。** 留下全局状态的
套件能让单独跑全绿的兄弟文件变红（`app/tests/bot-needs-you.test.tsx`：迁移前按目录跑 7 pass、
今天单独跑 7 pass、在 24 文件组里红 18 条）。驱动层不得把这种红当作套件的结论：
`scripts/lib/e2e-manifest.mjs` 的 `ISLANDS` 让已知会污染进程状态的套件族单独成组，
`tests/bun-suites.test.ts` 在组内出现失败时把失败文件**各自重跑一次**，只有"独自也红"算失败，
"只在共享进程里红"用 stderr 点名；重跑上限（8 个文件 / 300 s）用完按失败处理，绝不给假绿。

**三、"所有测试都在 e2e 上"必须可对账。** `scripts/e2e-coverage-audit.mjs` 把 14 个目录里的每个套件
文件归入 `native / driven / engine / 按名字写明原因的排除` 四个桶，落不进任何一类就非零退出，并已接进
`bun run test:ci` 先于执行运行：写着 `bun:test` 却没进驱动层的文件会让**整轮收集中止**（一个文件就没有
report），两个 runner 都没 import 的文件会**静默不跑**。并行会话会持续合入新的 `bun:test` 套件，所以
分区不是记忆而是重扫（`scripts/e2e-batch-drive-bun-test.mjs`）。同一入口的 report 目录也要能指名
（`E2E_UNIT_OUTPUT`），否则并发运行的后写者会覆盖前一次的 `report.json`。

## 2026-10-19 补充三：「这一层没判」是环境结论，必须由环境证据支撑；1xx Response 是 Bun 耦合语义

两件在这轮实测里才浮出来的约束：

**一、blocked 与 judged 的区分不能用失败文本当证据。** 驱动层原先把
`Failed query` / `is not available` 之类文本算作"没库"，于是 RLS 拒插入这种真实产品判定被贴成了
"环境缺项"；只认连接级签名后又反向失效 —— `bun test --reporter=junit` 的失败文本以 drizzle 的
`Failed query:` 开头，`ECONNREFUSED` 被截断在片段之外，真故障反而不标 blocked。规则定为：**标签
要么 keyed 在不可误读的连接级签名上，要么由驱动自己探测一次环境**（取
`TEST_DATABASE_URL`/`DATABASE_URL` 的 host:port 做 TCP 连接），并且把所用的证据原文打印进失败
信息。贴不出证据的标签不算证据。

**二、Node 的 `Response` 构造器拒绝 1xx，Bun 允许。** `new Response(null, {status: 101})` 在 Node
抛 `RangeError: init["status"] must be in the range of 200 to 599`，在 Bun 正常构造。因此断言
"websocket 透传返回 101"这类套件属于 Bun 耦合的 HTTP 语义，按本 ADR 的两层制送回 Bun 运行时由
e2e 调度与报告；**不为了在 Node 上跑绿而改生产代码，也不在兼容层伪造状态码** —— 伪造出来的 101
验证不了任何东西，等于把这条断言悄悄删掉。分区清单里这类条目必须写下点得出名字的根因，
`runner reported` 这种只复述现象的归因不合格。
