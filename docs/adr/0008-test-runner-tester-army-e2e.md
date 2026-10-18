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
