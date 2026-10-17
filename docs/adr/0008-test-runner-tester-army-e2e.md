---
status: accepted
---

# 以 tester-army e2e 作为唯一测试运行器，并用兼容层承载框架未提供的单元断言

仓库原有两套入口：`bun test` 执行 912 个 `bun:test` 文件（单元与集成），`e2e run` 执行 10 个 UI 文件。用户要求把所有测试迁到 tester-army `e2e` 框架，并在两个岔路口选择了代价最高的方案：全量迁移 + 自建兼容层，且允许为让测试跑在 Node 上而移植依赖 Bun 运行时的代码。

`e2e` 的 CLI 只接受 Node（`engines: node ^22.22.3 || >=24.8.0`），其 `expect` 按自身文档刻意不含 `toThrow`、`rejects`、`resolves`、`toBeInstanceOf`、mock 调用断言与 `expect.extend`，也不提供 `test.each`、`mock`/`spyOn`。这些缺口对应仓库里 `toThrow` 260 个文件、`.rejects` 220、`toBeInstanceOf` 122、`.resolves` 74、`test.each`/`describe.each` 120、`mock`/`spyOn` 46 处用法。

因此 `tests/support/e2e-compat.ts` 成为唯一入口：运行器、收集、钩子、locator、报告与缓存全部来自 `e2e`，兼容层只补框架未提供的值断言、参数化注册、Bun 风格的 spy 与假时钟，其余一律转发而不重新实现。`tests/support/bun-compat.ts` 同理，用 Node 的 `child_process`、`fs`、`crypto`、`http` 提供套件实际用到的 `Bun` 子集（`file`、`write`、`spawn`、`sleep`、`which`、`argv`、`CryptoHasher`、`serve`），使"以子进程探测真实行为"的用例在 Node 上仍然是真探测，而不是被删掉。

未选"行为测试进 e2e、白盒单测留 `bun:test`"：这是框架文档自己的建议，代价最小，但用户明确要的是单一框架。未选"e2e 作为聚合入口、内部继续调 `bun test`"：一个命令确实能跑完所有测试且零重写，但单元套件并没有运行在 e2e 上，不符合要求。

代价是三条必须长期守住的约束。第一，兼容层是仓库自维护的代码，框架升级新增或改动 matcher 时由我们同步，不是框架的义务。第二，测试进程不再有 Bun，`desktop/`（156 个文件、1797 处 `Bun.*`）这类强绑 Bun 运行时的套件需要显式移植或以子进程方式验证。第三，`e2e` 的收集按文件容错性差（一个文件求值失败即报 `COLLECTION_ERROR`），所以 `scripts/e2e-collect-triage.mjs` 与 `scripts/e2e-report-summary.mjs` 属于测试基础设施，不是临时脚本。

单元与集成套件在 `e2e.unit.config.ts` 的 tools-only target（无 engine，因此不开浏览器、不调用模型）上运行，UI 套件留在 `e2e.config.ts` 的 web target，两者用 `--config` 选择；`bunfig` 预加载与 `bun test` 不再是测试入口。
