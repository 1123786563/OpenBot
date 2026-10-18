# 测试全面迁 tester-army e2e · 执行状态

基线：会话开始时 `main` 为 `bbea87ba`；本轮迁移提交 `bced6121f`、`cb636f02`，本文与后续改动在其后。
决策依据：[ADR 0008](../adr/0008-test-runner-tester-army-e2e.md)。运行入口：`bun run test`（= `e2e run --config e2e.unit.config.ts`）、`bun run test:ui`（web target）。

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

## 归因方法：一个失败是不是迁移造成的

`node scripts/e2e-vs-bun.mjs` 对每个失败文件跑三遍再比对，判定落
`docs/verification/e2e-vs-bun.json`：

| 组合 | 树 | 套件文本 | 运行器 |
| --- | --- | --- | --- |
| 新运行器 | 当前 | 迁移后 | e2e（`report.json`） |
| 旧运行器 | 当前生产代码 | **迁移前** | `bun test` |
| 基线 | 迁移前整树 | 迁移前 | `bun test` |

中间那行才是决定性对照：代码与套件文本都一样，只换运行器。两棵树都是工作树之外的副本
（`git archive` / `rsync` 到 `~/.cache/openbot-e2e/`，node_modules 用符号链接），取证不写这个
共享工作树。旧运行器绿的判为 `runner-difference`，由 `scripts/e2e-route-failures.mjs --verdict=`
分到 Bun 层；旧运行器也红的判为 `already-red-at-baseline`，留在原生层如实报失败。

2026-10-18 这一轮的判定：107 个红文件中 **84 个 runner-difference**、**19 个 already-red-at-baseline**
（`server/tests/config|schema|copilot|audit|guards|ready`、`tests/compose`、
`server/src/knowledge/*`、`server/tests/enterprise/*` 等，迁移前就是红的，不是本次改动造成）、
2 个在迁移前不存在（并行会话新增）、1 个旧运行器输出读不出。

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

## 尚未完成（这是"全部测试已在 e2e 上跑起来"这句话还差的部分）

1. **19 个迁移前就红的文件仍然红。** 它们留在原生 e2e 层如实失败（约 90 条断言），需要各自
   owner 处理；本次迁移没有把它们改成跳过或迁到别的运行时。
2. **需要外部服务的套件仍取决于环境。** `HOOK_FAILED` 里 Qdrant（127.0.0.1:6333）与本仓库
   Postgres 连接失败是这台机器没起依赖，不是运行器问题。
3. **`bun run test:ui` 只验到收集层**（28 条 web 用例可收集）；执行需要 dev server 与浏览器栈。
4. **驱动组规模变大**（328 个文件 / 24 组），整组 `bun test` 的墙钟时间显著长于原生层，
   CI 里需要按 `E2E_UNIT_SCOPE` 切目录并行，否则单作业跑完整个 corpus。

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
