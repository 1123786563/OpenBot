# D01 验证（backend_validator）与独立审查（reviewer）报告

- 验证者/审查者：backend_validator 兼独立 reviewer（只读源码；唯一写入为本报告）。
- 日期：2026-10-20。工作区：`.worktrees/upstream-openbot-update`（未提交树）。
- 对象：Task D01（非阻断启动诊断，AC A09，Issue #497 / 本地 up09）。
- 亲历证据：两 suite 由本人以 `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/model-availability-check.test.ts server/tests/intelligence-entitlement-check.test.ts` 真实执行；coverage audit、typecheck、biome 均为本人复跑；SDK 类型与实现读取 `server/node_modules/@copilotkit/runtime/dist/v2/runtime/intelligence-platform/client.{d.mts,mjs}`。

---

## 第一部分：validator 清单（逐项 PASS/FAIL）

### 1. 行为 — PASS

亲跑两 suite：**2 files / 35 tests 全绿**（21 + 14，runner 输出 `Tests 35 passed (35)`，Duration 218ms）。

分类矩阵抽查（全部在真实执行的 suite 中有对应断言，本人读源逐一核对）：

| 矩阵项 | 测试证据 | 结论 |
|---|---|---|
| 缺 key → skipped/unconfigured 且零探测 | `checkModelAvailability` 首条用例：`enabled:false`、`asked===0`、`calls===[]` | PASS |
| 401/403 → credential-rejected | `test.each([401,403])`：`warning`+`credential-rejected`、log 恰 1 条且与返回值同一对象 | PASS |
| 官方 404 → model-unavailable | 专用用例：`warning`+`model-unavailable`、log 1 条 | PASS |
| 兼容端点无 lookup → skipped/unsupported | `enabled:true` 无 `lookup` 用例：`skipped`+`unsupported`、无 log | PASS |
| >3000ms → timeout 且 signal.aborted | fake 时钟推进整预算：`timeout`、`signals[0].aborted === true`（model 与 entitlement 两 suite 均有）——证明是真取消，非仅 race 弃等 | PASS |
| 忽略 abort 的 seam → 仍在预算内 timeout | 永不 settle 的 lookup/read：预算内回答 timeout（boot 不被悬挂） | PASS |
| 日志每启动至多一条 | 每条 warning 用例断言 `toHaveLength(1)`；skipped/available 均断言零 log；scheduler 用例按 source 过滤各恰 1 条 | PASS |
| 日志无 key/认证 header/含凭据 URL | 两个 suite 各有安全用例：序列化结果不含 fixture 秘钥、`authorization`、`x-api-key`（或 `api-key`）、`https://`；model suite 特意构造携带秘钥的 reject 消息证明 reason 不入日志 | PASS |

### 2. 非阻断 — PASS

- `git diff server/src/index.ts` 实测 **+54 / −0，纯追加**（2 条 import + 1 处装配块）。注：派发单写 "+55"，以 git 实测与实现者报告的 +54 为准（派发文本漂移，非实现问题）。
- **零 top-level await**：唯一的 `await resolveRuntimeModelApiKey()` 在 model factory 异步函数体内，不在模块顶层。
- **resolve（调度返回）先于 check**：`scheduleStartupDiagnostics` 返回 `void` 且用例钉住"两 probe 未决期间后续语句已执行、`calls===[]`"。
- **factory throw 不逃逸**：调度内 async IIFE + `.catch` 兜底；同步 throw（async 函数体内转 rejection）与异步 reject 均有用例，且证明不挡 entitlement 侧、各恰一次报告；log sink throw 被 containment 吞掉（有专测）。
- 诚实限制（实现者已自报，非伪造）：本仓库无以测试方式启动 `server/src/index.ts` 的既有 harness，整机组真实进程启动冒烟未执行；以装配 seam 行为证据 + 零 await diff 替代。brief 明确允许"用现有启动装配测试或最小装配用例证明非阻断——不可伪造启动成功"，未发现伪造。

### 3. 边界 — PASS

- **未启用 Learning 不探测**：装配 `enabled: learningCanCreate`（index.ts:843，`learningApiOrigin && (learningSetup || cliLoginPresent)`，与 Learning 供给路径同一真实条件）；`enabled:false` 时零探测有用例钉住。
- **不旁路虚拟 Key / 无虚拟探测**：设置了 `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` 的网关部署返回 `{enabled:true}` 无 `lookup` → `skipped/unsupported`，message 明言"兼容端点 404 不判定模型不存在"，对网关零请求。直连路径的 key 走与 intent router / skill 选择完全相同的 `resolveRuntimeModelApiKey()`（credentials.ts:259，credential store → env，缺省返回 null → unconfigured），未铸造、未绕过任何凭据；探测是 `GET /v1/models/{id}` 元数据读，`officialModelMetadataLookup` 从不读响应 body（有 throw-on-read 的钉子用例），零推理计费。
- **偏差 2 一致性判断**：属实且与 Spec §6 第 4 条一致。本人核验 `server/src/config.ts` `runtimeCapabilities`：缺 `INTELLIGENCE_API_URL`/`INTELLIGENCE_GATEWAY_WS_URL`/`INTELLIGENCE_API_KEY` 任一即 `throw "CopilotKit Intelligence is required and is not configured"` —— 本地 Intelligence 是 boot 强制依赖，"未启用 Intelligence 的部署"在本地为空集，该部署契约条款空真。真实可选件是 Learning，探测门控落在 `learningCanCreate` 恰是"entitlement 仅针对实际启用的可选学习依赖"的忠实本地化，符合 brief"配置沿用本地真实条件"。判定：读法正确，非静默重设计，无需升级。
- 诊断不是授权事实/第二 readiness 权威：返回值在装配处被丢弃，仅 log；`model-availability-check.ts` 头注释亦明示 gateway 的 readiness gate 仍是 paid model work 唯一权威。

### 4. 范围 — PASS

- **恰 5 文件**：本人对比 `before-tracked.diff` 与 `after-tracked.diff` 的 `diff --git` 清单，tracked 侧恰新增 `server/src/index.ts` 一项（+54/−0）；另 4 个为 untracked 新建（2 源码 + 2 suite）。D01 足迹合计恰 5 文件。（after-tracked.diff 含此前任务的 43 个 tracked 文件属工作树累计快照，非 D01 范围。）
- **归层**：两 suite 实际 import 仅 `tests/support/e2e-compat` + 两个纯模块（`intelligence-entitlement-check.ts` 只 import 同目录模块；`model-availability-check.ts` 零 import）→ **native（Node）层**；本人以 `|node|` target 真实执行证实。`docs/verification/e2e-bun-suites.json` grep 计 0 处引用——正确，该清单只收 Bun 运行时 driven 套件。
- **对账**：本人复跑 `bun scripts/e2e-coverage-audit.mjs` → exit 0，"no gaps"（1059 files · 566 native · 478 driven · 9 engine · 6 named exclusions），与报告数字逐项一致。
- **typecheck**：本人复跑 `bun run --filter server typecheck` → 仅 `scripts/bootstrap-local-gateway.ts:106/108/120` 三条 TS2339（BASE 预登记同一组；该文件不在 D01 diff 中，不可能由 D01 引入），**零新增**。
- **format/lint**：`bunx biome format` 5 文件全部无需修改；新 4 文件 `biome check` 干净（exit 0）；`index.ts` 的 biome 发现与 `git show HEAD:server/src/index.ts` 副本逐项 1:1 对应（noNonNullAssertion 6706→6760、noUnusedImports 430→432、organizeImports 1:1、noConsole×3，位移恰等于 +2 import/+54 块），**零新增 finding**。

---

## 第二部分：reviewer 段（findings + 严重度）

### Spec §6 四条逐条

1. **"3 秒预算、取消支持、只报告一次、失败不抛回阻断启动" — 符合。** `STARTUP_CHECK_BUDGET_MS = 3_000` 单点定义两处消费；deadline 先 `controller.abort()`（signal-respecting 请求被真取消，`signal.aborted===true` 有断言），race 只是第二道防线；每 check 至多一条 log（仅 warning）；`scheduleStartupDiagnostics` 先于两 check 完成返回，index.ts 零 await。
2. **"只使用允许的官方元数据或已批准网关 metadata；兼容服务无 lookup 则 skipped，不用其 404 判模型不存在" — 符合。** 装配仅直连官方路径供 `officialModelMetadataLookup`（与上游相同端点与 header 形制）；自定义 base URL 一律不供 lookup；skipped message 明示兼容 404 的含义。网关目录（gateway/catalog.ts）未接入 lookup 是符合 brief"无合法探测接口则 skipped"的更保守子集（Spec 用"或"，不用尽不是违反）。
3. **"不为探测绕过虚拟 Key、创建推理 token 调用或扩大供应商权限" — 符合。** 凭据 = 业务同源解析的部署自身凭据，且只活在 lookup 闭包内（index.ts 不持有 key）；元数据读、body 永不读、只有 `{status}` 出闭包。
4. **"entitlement 仅针对实际启用的可选学习依赖；不改变未启用 Intelligence 部署契约；不当授权事实" — 符合（见 validator §3 偏差 2 判定）。**

### Findings

- **F1（low，报告文字漂移）**：`implementer-report.md` §1 称 model suite "13 个 test 声明"——实测 16 个声明（12+4）但 **21 条实例正确**；称 entitlement suite "4 条 scheduler 装配用例"——实测 scheduler describe 含 **5** 条（返回先于完成 / factory 异步失败 / 至多探测一次 / factory 同步 throw / log sink throw）但 **14 条实例正确**；依赖行号 `learningCanCreate:~845`（实 843）、`credentialStore:939`（实 941）±2。全部为计数/行号笔误，不影响任何结论性声明。
- **F2（low，已披露的残余缺口）**：up09 第 6 条"由真实启动装配验证非阻断"目前最强证据是装配 seam 行为 + 零 await diff，缺真实进程整机组冒烟（仓库无该 harness）。非伪造、非 silent skip，建议最终全范围 OCR（A11）时以真实启动日志补一条观察证据。
- **F3（info，偏差 3 经独立核实为准确）**：SDK `getRuntimeEntitlements(): Promise<RuntimeEntitlementResponse>` 确无参数（client.d.mts:508），AbortSignal 无处传入；但本人读 SDK 实现证实其内部 `#fetchRuntimeEntitlements` 自建 controller + `RUNTIME_ENTITLEMENTS_REQUEST_TIMEOUT_MS` 超时并传 signal 给 fetch（请求有界、可取消），且"Concurrent calls share one request；30s/5s TTL"注释逐字属实——"不遗留无限网络请求"在 SDK 侧也成立。
- **F4（info，偏差 1 必要且最小）**：5 个额外导出各有单一职责：预算常量+内核避免两文件复制 3s 语义；`officialModelMetadataLookup` 把 key 封在诊断文件内（index.ts 全程不接触明文 key）；`scheduleStartupDiagnostics` 使装配 seam 可测，才有诚实的非阻断证据。两函数 I5 签名逐字一致，无合约变更。
- **F5（info，预算内核正确）**：deadline abort 与 race 兜底的双层设计正确；`catch` 内以 `signal.aborted` 区分 abort 触发的 rejection（→timeout）与预算内自身失败（→unreadable/unconfigured 语义外的一切 rejection），事件监听器注册顺序保证 abort-respecting seam 确定性落 timeout；`attempt.catch(()=>{})` + race 内部 handler 双保险，无 unhandled rejection；永不 settle 的 promise 图在 check 返回后可 GC，无泄漏。
- **F6（info，本地比上游更安全）**：上游两条诊断都会把 `error.message` / 供应商 `error.message` 内插进日志行；本地改为固定句式 + 至多 status 数字与 model 名（tenant 配置），并在装配处把非 ready status 折进闭词表错误。日志泄漏面严格小于上游，超出"行为对齐"的合理加固。

### 测试真实度

fake 只注入 I5 seam（lookup/read/log/fetch/假时钟）——这本身就是生产注入面，被测的是真实调度、真实分类、真实预算内核与真实 lookup 闭包；`officialModelMetadataLookup` 用捕获型 fake fetch 钉住 URL/header/signal 同一性/body-never-read。无"只 mock 合约"的空转：35 条断言均落在公共 seam 的可观察行为上。未发现测生产路径的用例被偷换成测 fake 自身。

---

## 结论

Validator 四项全 PASS；Spec §6 四条逐条符合；代码质量 findings 无 blocker/major（2 low + 4 info，均已定性）。偏差 1/2/3 经独立核实全部成立且处理得当。

Validator: pass
Spec compliance: pass
Code quality: pass
结论摘要：D01 通过——35/35 亲测全绿，五文件范围、非阻断装配、边界与日志安全全部属实，三条偏差经独立核实成立；无阻断 finding，仅报告计数笔误与缺整机启动冒烟两项 low 事项。
