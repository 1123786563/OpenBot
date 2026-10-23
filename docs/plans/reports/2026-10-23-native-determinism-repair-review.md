# B1 native 确定性修复 — 独立复审报告(2026-10-23)

- Reviewer: 独立只读复审(不修改文件、不跑测试套件;静态核查 + biome check 只读校验)
- 对象: `docs/plans/2026-10-23-native-determinism-repair.md`(需求)与实现报告
  `docs/plans/reports/2026-10-23-native-determinism-repair-impl.md` 所绑定的 10 文件 PRE→POST diff
- 方法: PRE 副本(`docs/verification/workspace-redesign/final-closure-r7/repair/PRE/files/`)与工作树
  逐一 `diff -u`;机制事实源为 `tests/support/e2e-compat.ts`(mock.module 实现 558-680、resolve 钩子)、
  `tests/support/bun-test-compat.ts`(bun:test 纯再导出)、`node_modules/e2e/dist/run/realm.js`(钩子时序)、
  `app/node_modules/@happy-dom/global-registrator`(register/unregister 同步性)、
  `desktop/node_modules/bun-types@1.4.2/test.d.ts`(mock.module 签名)。

## 0. 哈希链核验(复审前提)

- PRE 副本 10 文件 SHA-256 与实现报告 PRE 列**逐字节一致**(本机 `shasum -a 256` 重算)。
- 工作树 10 文件 SHA-256 与实现报告 POST 列**逐字节一致** → 复审对象即验证对象,无中间漂移。
- `git status` 中 10 个 M 文件恰为修复清单;probe 删除与 bisect 工件删除属计划§会话事件记录的既有脏基线,不在本修复 diff 内。

## Findings 汇总

| # | Severity | 位置 | 摘要 |
|---|----------|------|------|
| F1 | low | `app/tests/preload.ts:110-116` | 回退链二次失败时窗口留在注册态(与 PRE 同为致命终态,非回归) |
| F2 | low | `app/tests/admin-*.test.tsx` 守卫处、三个 fixture `:50-53`、`app/src/lib/upload-queue/queue.test.ts:68` | `typeof === "function"` 守卫只对未来"同步函数句柄"自动生效;若 Bun 未来返回 Promise 型 API 则静默保持 inert,注释表述略过诺 |
| F3 | low | `tests/support/e2e-compat.ts:666-669`(既有设计,非本次引入) | 注销句柄按说明符删除、不认所有权;同进程同说明符双安装者交错时先离场者会误删后者的 mock。当前运行器逐文件惰性导入,不可达 |
| F4 | low(文案) | `app/tests/preload.ts:96-97` | "The `await import`s this replaces each parked this module mid-chain" 语法缠绕,难一次读懂 |
| F5 | info | `app/tests/billing-credits-ui.test.tsx:157/234`、`app/tests/personal-credits-ui.test.tsx:141/161` | 文件级 afterAll 按声明逆序执行(realm.js `leaveFinished`):先跑既有 cleanup、后跑注销 — 已核无相互依赖,正确 |

无 critical / high / medium finding。

---

## Spec 轴(逐条判定)

### S1 — 9 处 mock.module 捕获 + 套件结束注销;bun 层守卫如实声明 — **PASS**

计划§修复 A 的 9 个泄漏点共 **13 个 `mock.module` 调用**(grep 全量清点),全部捕获返回值并注册注销:

| 文件 | 调用数 | 层 | 捕获与注销形式 |
|---|---|---|---|
| `app/tests/billing-credits-ui.test.tsx:35` + `:157` | 1 | e2e-compat | `const uninstallDialogMock = mock.module(...)` + `afterAll(() => uninstallDialogMock())` |
| `app/tests/personal-credits-ui.test.tsx:58` + `:141` | 1 | e2e-compat | 同上 |
| `app/tests/admin-credit-grant-ui.test.tsx:20` / `admin-catalog-sync-ui:45` / `admin-gateway-readiness:43` | 各 1 | bun | `const uninstallDialogMock: unknown = ...` + `afterAll` 内 `typeof === "function"` 守卫调用 |
| `app/tests/bot-route-default-agent.fixture.tsx:11-48` + `:50-53` | 4 | bun | 4 句柄收进 `uninstallMocks: unknown[]`,一个 `afterAll` 循环守卫注销 |
| `app/tests/channel-new-error-state.fixture.tsx:11-18` + `:21-25` | 1 | bun | 同 fixture 模式 |
| `app/tests/home-fallback-routing.fixture.tsx:12-31` + `:33-37` | 2 | bun | 同 fixture 模式 |
| `app/src/lib/upload-queue/queue.test.ts:42`(beforeEach)+ `:66-70`(afterEach) | 1 | bun | 模块级 `let uninstallKnowledgeMock: unknown`,每轮重装/守卫注销 |

bun 层守卫的**诚实性**(S1 后半句):三类 bun 层注释(admin-*、三个 fixture、queue.test 中文注释)均明确写出
"as of Bun 1.4.2 it returns no restore handle (probed: undefined), so this registration is inert here and
starts unregistering the day Bun ships the handle"。实现报告偏离 1 同样如实(bun-types 1.4.2
`test.d.ts:50` 签名 `module(id, factory): void | Promise<void>`,本复审独立核到)。守卫是**声明的 no-op**,
不是把 no-op 包装成修复;真实起效面(2 个 e2e-compat 文件 + preload)与全部失败签名对应,由偏离 1 的归因
说明与门禁 1/2/6/7/8 支撑。**无虚假修复表述。**

### S2 — billing/personal-credits 注销真正在文件所有测试结束后执行 — **PASS**

- 注册时机:两文件的 `afterAll(() => uninstallDialogMock())` 均在**模块体顶层、动态 `await import` 组件之前**
  注册(billing `:157` 先于 `:160` 的 consumption-table 导入;personal `:141` 先于 `:144` 的 UsageCreditsView
  导入),即收集期内注册。`node_modules/e2e/dist/run/registry.js:506` 的 `afterAll(fn)` → `requireCollector`
  → `registerHook`,要求收集期调用 — 满足。
- 执行时机:`node_modules/e2e/dist/run/realm.js:101-107` 明确"A scope's afterAll runs when its last runnable
  member leaves it",文件级作用域的 afterAll 在该文件最后一个测试离场后执行;实现报告门禁 1/2
  (billing+detail-panel、personal+detail-panel 配对,w1)证明对静态导入受害者真实生效。
- 闭包引用:句柄是注册点之前初始化的 `const`,闭包直接捕获;e2e-compat 句柄体为
  `moduleMocks.delete(specifier); mocks.delete(specifier)`(e2e-compat.ts:666-669),对已删键重复删除是
  no-op,不抛错。
- 声明逆序的影响(F5):文件级 afterAll 逆序执行 → 既有 cleanup(`:234`/`:161`,settleReactWork/i18n/
  GlobalRegistrator)先跑、注销后跑;注销只触模块注册表,与 DOM/i18n 清理正交,无顺序问题。

### S3 — preload.ts 同步临界区 — **PASS**

- **(a) 无事件循环让出点:`app/tests/preload.ts:104-109` try 块内无任何 `await`**。`createRequire` 同步;
  `nodeRequire(...)` 在 Node 22 为同步 `require(esm)`(实现报告探针 27ms/258ms、无 TLA;若不可用则抛错进
  回退,同样不让出);`GlobalRegistrator.register()` 经类型与实现核验为**同步方法**(d.ts `: void`,JS 实现非
  async、体内无 await);`GlobalRegistrator.unregister()` 虽返回 Promise 且体内有 `await happyDOM.close()`,
  但 globalThis 属性还原与 `#registered = null` 在首个 await 前同步完成(unregister JS 实现 78-86 行),
  且 preload 自身控制流未对其 await。因此临界区内模块自身求值不挂起,并发套件图无插入窗口。
  临界区之后的让出点(i18n 块 `:125` 的 `await import`)处于窗口注册态,react-aria 的一次性
  useLayoutEffect 决策已在 `:108` 的窗口内完成,插进来的图只会看到 document 已定义 — 不变式不破。
  PRE 主路径的 `await import("react-dom/client")`(PRE 行 78)已从主路径删除,仅存于 catch — 竞态让出点
  本体确被移除。
- **(b) 不变式保持**:顺序为 `nodeRequire("react-dom/client")`(:106,窗口外)→ `register()`(:107)→
  `nodeRequire("@heroui/react/modal")`(:108,窗口内)→ `unregister()`(:109)。与 PRE await 链同序;
  react-dom(CJS 底层)与 ESM 实例共享由实现报告探针支撑(createRoot 同引用),scheduler 捕获不变式
  (react-dom 必须先于任何窗口)保持。
- **(c) 回退路径安全**:`:111` 的 `if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister()`
  守卫了"register 已执行"的部分成功态(unregister 对未注册会抛,守卫正确挡掉);register 抛错时若已部分
  注册,同一守卫覆盖;unregister 的注册表清空是同步完成,`await` 返回后 `isRegistered` 必为 false,故
  `:113` 的再次 register 不会因重复注册抛错逃逸。Bun 路径(无同步 require(esm))按设计走回退,
  与实现报告偏离 5 一致。
- **(d) `void nodeRequire(...)` 用法正确**:一元 `void` 求值即弃,纯副作用;nodeRequire 同步返回模块
  namespace,无 floating promise 问题;同时满足 biome 的 noUnusedExpressions。

### S4 — 无越界改动;biome 格式化抽查 — **PASS**

- 全量 diff 复核:10 文件的语义改动仅含 (i) 句柄捕获 + afterAll/afterEach 注册,(ii) 注释修正,
  (iii) preload 同步化 + `createRequire` import,(iv) import 排序与格式化。无任何测试断言、组件逻辑、
  fixture 渲染内容改动。
- **抽查 3 文件(admin-credit-grant / admin-catalog-sync / admin-gateway-readiness)逐 hunk 核验**:
  每个"格式化" hunk 均为**逐 token 等价的换行重排**,包括:`installFetchStub` 签名、`json({...}, 403)`
  实参、`toContain("2")`/`toContain("2026")`/`toContain("unavailable")` 断言、disabled-button 的
  `waitFor` 嵌套、`credential` 类型字面量、`configVersion` const、`userEvent.type(...)` 调用。无一例
  token 增删。
- `import "./preload"`(queue.test 为 `../../../tests/preload`)在全部 9 个套件文件保持第一行,逐文件核过。
- import 重排的副作用面:billing/personal 中 e2e-compat import 后移 — 其副作用(node:module registerHooks
  + bun-compat shim)在 `mock.module` 调用时也会自装(e2e-compat.ts:663),且被 mock 说明符均在重排后
  才解析;fixtures 中 bun-test-compat 与 react 的换位无副作用(bun-test-compat 为纯再导出,无 side-effect
  import)。
- 只读复跑 `bunx biome check <10 文件>`:Checked 10 files, 0 错误、无需修复 — 与实现报告门禁 4 一致。

### S5 — 注释表述与机制事实一致 — **PASS**

- billing 头注释(PRE "registry-level and OUTLIVES THIS FILE" → POST "registry level, but this file
  unregisters the handle in its afterAll, so later files in the same process get the real module back")与
  resolve 钩子的原始说明符匹配机制(e2e-compat.ts:599)+ afterAll 注销语义完全一致;"while this file holds
  the mock" 保住了自身测试仍跑在 mock 下的不变式表述。
- "EVERY export, because the mock module is generated from the factory's returned keys alone" 与 load 钩子
  实现(`Object.keys(moduleMocks.get(key)?.() ?? {})` 生成导出,e2e-compat.ts:628-635)一致。
- personal 头注释 "each installer unregisters its handle at its own afterAll, so the passthrough never
  outlives the file that set it" 同样机制准确。
- 全 10 文件 grep `OUTLIVES|outlives|process-lifetime|permanen|inevitab`:仅剩 personal `:54` 修正后句子中的
  "never outlives"(否定式,正确)。**无残留"永久/不可避免"表述。**
- bun 层 "inert on this runtime ... runs (and pass) under it" 表述与 Bun 1.4.2 实测(probed: undefined;
  restore 不还原 module mock)一致,未把 no-op 说成已修复。

---

## Quality 轴

### Q1 — 重复注册/泄漏(fixture 被 import 两次) — **PASS,附 info 级观察**

- fixture 只有一个宿主套件(grep 核验:bot→bot-route-default-agent.test.tsx、channel→channel-new-error-state.test.tsx、home→home-fallback-routing.test.tsx),且 ESM 模块缓存下每进程求值一次 → afterAll 每进程至多注册一次。
- bun 层句柄现为 undefined,守卫跳过;数组与 `let` 均为模块作用域,无累积、无泄漏。
- native 层:即使运行器对套件文件双导入(列清单+执行,e2e-compat.ts:564-569 注释),重复的 `mock.module` 覆盖同键、重复的 afterAll 各自调用同一句柄 — 删除幂等,安全。
- F3(info):e2e-compat 句柄按说明符删除、不认所有权 — 若未来出现同进程同说明符双安装者交错,先离场者的 afterAll 会误删后者的 mock。当前逐文件惰性导入(探针证明)+ 文件间 afterAll 边界下不可达,且属 e2e-compat 既有设计、非本次引入。

### Q2 — queue.test.ts beforeEach/afterEach 交错在失败用例中途的安全性 — **PASS**

- 用例中途抛错:bun 语义保证 afterEach 仍执行 → 守卫注销(今日 no-op)→ `mock.restore()`(只还原 spy,
  与 module mock 注销独立,顺序无关紧要)。PRE 行为未变。
- beforeEach 中途抛错:句柄赋值是该函数第二条语句,mock.module 工厂体只定义函数,无可抛点;极端情况下
  句柄滞留上一轮值,守卫重复调用幂等(e2e 语义)/今日 undefined 无害。
- 首轮前句柄为 undefined,`typeof undefined === "function"` 为 false,不会误调用。
- F2(low):守卫只对未来**函数型**句柄生效;若 Bun 未来返回 Promise 型注销 API,`typeof === "function"`
  不匹配,守卫将静默保持 inert — 注释"starts unregistering the day Bun ships the handle"在该形态下过诺。
  建议措辞改为限定"函数句柄"(不阻塞)。

### Q3 — preload try/catch 部分成功态 — **PASS,附 low 级 finding F1**

逐一分析部分成功态:

1. `createRequire` 抛(非 Node 运行时):try 未产生副作用 → 回退等价 PRE 原链,安全。
2. `nodeRequire("react-dom/client")` 抛(ESM 求值中途失败):该模块在 ESM 注册表被标记为 errored,回退的
   `await import` 将复抛同一错误并逃逸 — 属不可恢复致命态,运行失败响亮,无静默不一致。
3. `register()` 抛:catch 的 isRegistered 守卫覆盖"已注册"分支并先注销(注册表清空同步完成),回退链重建
   干净窗口;若 preload 因运行器重导入而再次求值,该链路也能自愈(PRE/POST 的 warm+i18n 块均以
   unregister 收尾,重复求值安全)。
4. `nodeRequire("@heroui/react/modal")` 抛(register 已执行):catch 先 `await unregister()` 移除窗口 →
   `await import("react-dom/client")` 命中 require(esm) 已填的同一 ESM 实例(无窗口,不变式保持)→
   register → `await import(modal)`;若 modal 再次抛错,**错误逃逸出 catch,`:115` 的最终 unregister 不执行,
   happy-dom 窗口留在全局注册态** — 即 F1。该终态与 PRE(register → import 抛 → 无 unregister)完全相同,
   且 preload 导入失败本身使整个 run 致命,无"带病继续"路径。**非回归,severity low。**

### Q4 — 注释可读性与风格 — **PASS,附 F4**

- 新注释均解释 why:泄漏机制(原始说明符匹配 + passthrough 滞后)、运行时探针结果(probed: undefined)、
  queue.test 的"restore 不还原 module mock,所以单独收口"、preload 的"await import 停车点 = 竞态窗口"。
- 风格一致:测试文件沿用英文块注释;queue.test.ts 用中文 JSDoc,与该文件既有中文头注释一致。
- F4(low,文案):`preload.ts:96-97` "The `await import`s this replaces each parked this module mid-chain"
  语法缠绕(建议如 "each `await import` this replaces used to park this module mid-chain"),不影响正确性。

---

## 无 finding 轴的检查记录

- Spec 轴全部 5 条均给出独立机制证据(非转述实现报告):13 处调用全量清点、bun-types 1.4.2 签名、
  e2e-compat 句柄体、realm.js afterAll 时序、GlobalRegistrator register 同步性、load 钩子导出生成逻辑、
  残留措辞 grep。
- 哈希链:PRE 副本与 POST 工作树均以本机 shasum 重算,与实现报告逐字节一致 → 复审、实现、验证三方绑定
  同一内容。
- 边界:复审未修改任何文件(bulk biome check 为只读校验,No fixes applied)、未执行任何 git 写命令、
  未重跑测试套件(验证归 validator)。

## 结论

- **Spec compliance: PASS**(S1-S5 全过;9 泄漏点 13 调用全捕获,注销注册时机与闭包正确,preload 临界区
  无让出且不变式保持,回退安全,void 用法正确,无越界改动,注释与机制一致)
- **Code quality: PASS**(Q1-Q4 全过;5 条 low/info 级观察,均不阻塞:F1 回退终态与 PRE 同为致命、
  F2 守卫对未来 API 形态的措辞、F3 e2e-compat 既有句柄语义、F4 文案、F5 已核正确的逆序说明)
