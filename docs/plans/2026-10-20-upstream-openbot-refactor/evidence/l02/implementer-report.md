# L02 实施报告：验证码持久状态、请求租约与恢复（A08 / Issue #496）

- 执行者：backend_implementer。工作区：`.worktrees/upstream-openbot-update`（HEAD `3b4a7c68132c3507300408346a44fb9d56f3c14c`，无 commit/push，未用共享 stash，未派发子 Agent）。
- 前置消费：L01 verified 的 gateway `signInCode`、schema 类型、Computer `POST /sign-in/code`。
- 证据文件：同目录 `after-tracked.diff`（全树 tracked diff，含前批任务在途改动）、`after-status.txt`、`sha256.txt`（11 个改动文件 + diff 的 SHA-256）。

## 1. 改动摘要

| 文件 | 改动 |
|---|---|
| `server/src/passwords/types.ts` | `SignInStatus` 增 `code_required`（pending 列表可见、非终态）。接口签名零改动（`transition` 的 `to` 已含 status/method/outcome/fillingUntil/resumedAt）。 |
| `server/src/passwords/store.ts` | Postgres 与 memory 两个 store 的 `pendingRequests` 状态集从 `pending/taken_over` 扩为 `pending/code_required/taken_over`。`transition` 本就是按 `from` 列表的条件更新（CAS），未改。 |
| `server/src/passwords/service.ts` | 状态机主体：①`load()` 过期 filling 租约由"回 pending 重开"改为 CAS 进入 `failed` + outcome 写明"无法确认是否完成" + `resolvedAt` + 触发既有 `resolved()`（钉死了禁令中的旧行为）；②`fill()` 不再向 gateway 发送 `code`；`signIn` 返回 `codeRequested` 时 CAS `filling→code_required`（清 `fillingUntil`、记 `method`、audit `computer.sign_in_code_requested`、不调 `onResolved`、不恢复 continuation），并把"站点已接受的密码"的保存移到该分支（上游对齐：code 路径完成时密码已不在手上，不改 vault/加密语义）；③新增 `enterCode`（CAS `code_required→filling` 领取 120s 租约→`gateway.signInCode`（origin 取自请求行，同源校验在 Computer 侧 origin 比对）→错 code 且字段仍在回 `code_required`、回密码页回 `pending` 并清 `method`、成功 `signed_in`；所有写回条件更新）与 `submitCode`（trim、空拒绝）；④`takeOver` 从 `pending/code_required` 均可发起；⑤`OPEN` 含 `code_required`（取消/到期覆盖 code 步）；⑥code 步到期文案单列；⑦fill 失败 audit 增 `step:"login"`、code 失败增 `step:"code"`（上游对齐）。 |
| `server/src/passwords/routes.ts` | 新增 `POST /:id/code`（body `{code}`，`field(..., {required, max:64})`）；`/:id/submit` 与 `/:id/use-saved` 不再读取 `code` 字段（旧客户端随密码携带的 code 被忽略，不输入）。错误处理/授权中间件零改动。 |
| `server/src/computer/schema.ts` | **L01 交接义务**：删除 `SignInFillInput.code`（Deprecated 字段）。`codeRequested?`/`SignInCodeInput`/`SignInCodeResult` 是 L01 已验证的未提交改动，本任务未触碰。删除后全树 typecheck 通过。 |
| `server/src/db/schema/passwords.ts` | `sign_in_requests_status_check` 扩入 `'code_required'`（与迁移同步）。 |
| `server/src/audit.ts` | `auditEventTypes` 增 `computer.sign_in_code_requested`（最小增量；载荷只含 actor/bot/request/site/method，经既有 redaction）。 |
| `server/drizzle/0165_sign_in_code_step.sql` | 新建。DROP+ADD 同名 check constraint（只扩 `code_required`，无列变更，expand-only）。未复制上游编号 0056，未改任何现存迁移。 |
| `server/drizzle/meta/_journal.json` | 追加 idx 165 `0165_sign_in_code_step`（`when=1792857600001`，紧随 0164 保持单调；文件尾无换行与 HEAD 一致）。 |
| `server/tests/passwords-sign-in.test.ts` | 28 用例（原 17 + 新 11）。fakeGateway 重构为 fill/code 双参数 + 可选 gate（gate+`letGo()` 钉住"在途/迟到"时序），新增 `withCodeStep`/`untilStatus`（轮询行状态，保证在真实边界交错，不靠猜）。 |
| `server/tests/passwords-store.integration.test.ts` | 3 用例（原 1 + 新 2）：真库上的 code 租约并发 CAS、迟到结果不覆盖取消、`code_required` 进 pending 列表、租约到期 → failed、audit 不含 code。 |
| `docs/verification/e2e-bun-suites.json` | **零改动**——未新增 suite 文件，两个既有 suite 均已在册（446/1035 行）；`node scripts/e2e-coverage-audit.mjs` → "no gaps" 为证。 |
| `server/src/passwords/resume.ts` | **零改动**（owned 但无需改）：恢复只经 `onResolved`（终态才触发），`code_required` 天然不恢复；`signInToolResult` 由行构建、无凭据。 |

## 2. 状态机逐行对照（brief 8 行表）

| # | 当前状态/事件 | 下个状态 | 实现 | 测试证据 |
|---|---|---|---|---|
| 1 | pending 提交密码 | filling | `fill()`：先校验（save/manager），再 `transition(from:["pending"], {status:"filling", fillingUntil: now+120s})` CAS 领取 | 原有 17 用例全绿；integration 用例 1 |
| 2 | filling，网站要求 code | code_required，清 `fillingUntil`，不恢复 agent | `fill()` 的 `result.codeRequested` 分支：`transition(from:["filling"], {status:"code_required", method, fillingUntil:null, outcome:null})`；audit `sign_in_code_requested`；**不调 `resolved()`** | native "moves the request to code_required…"（断言 `resolved` 空、`isFinalSignIn("code_required")===false`、pending 列表含它） |
| 3 | code_required 显式提交 code | filling，CAS 领取，调 L01 gateway `signInCode` | `submitCode`→`enterCode`：状态必须为 `code_required`，`transition(from:["code_required"], {status:"filling", fillingUntil:+120s})`；`gateway.signInCode(botId, {origin: 行 origin, code})`（同源校验由 Computer 在已验证 origin 的当前页定位字段） | native "an explicit code is typed…"（codes==[{origin,code}]，trim 生效）；route 测试（409 提前拒、64 上限、响应不含 code）；integration 用例 3（真库 signed_in、method 存留、audit verificationCode:true） |
| 4 | filling，code 明确错误且字段仍在 | code_required，保留请求允许显式重试 | `enterCode` 失败分支 `back="code_required"`：`transition(from:["filling"], {status:"code_required", fillingUntil:null, outcome})`；audit `sign_in_failed` step:"code" | native "a wrong code keeps the request at the code step…"（第一次拒→仍 code_required→改 fake 结果后显式重试 signed_in；`codes` 恰 2 次＝无自动重发） |
| 5 | filling，回密码页 | pending，明确要求重新登录 | `enterCode` 失败分支 `passwordFieldVisible`→`back="pending"`：`transition(..., {status:"pending", fillingUntil:null, outcome, method:null})` | native "a site that goes back to its login page…"（回 pending、method 清空、随后整段重登成功） |
| 6 | filling，确认完成 | signed_in，执行现有终态恢复 | `transition(from:["filling"], {status:"signed_in", fillingUntil:null, outcome, resolvedAt})`→audit completed→`resolved(done)`（复用现有机制，未建第二套 queue；resume.ts 零改动） | native 显式 code 用例；原 17 用例的终态/恢复路径全绿 |
| 7 | 请求取消/到期 | cancelled/expired，不再接受输入，不自动重放 | `OPEN=[pending,code_required,taken_over]`：取消/到期覆盖 code 步；一切输入路径只从 open/filling 的 CAS 进入，终态后必 409 | native "a code is only taken from…"（pending 拒/cancel 后拒）；"an expired request closes itself"；integration 用例 3（failed 后 submit → 409 no longer open） |
| 8 | 已发送后结果不明/lease 到期 | failed，outcome 写明无法确认；不自动重发、不报成功 | `load()`：过期租约 `transition(from:["filling"], {status:"failed", outcome:"…not known whether…", resolvedAt})` CAS→触发 `resolved()`；**旧"回 pending 重开"已删除**；同步失败（网关 throw/明确未完成）按 4/5 行回 open，仅租约兜底进入 failed | native "an attempt whose lease ran out is failed as unknown…"（RED 钉死旧行为）；"a restart restores state…"；integration 真库租约用例 |

**并发/迟到/重启组合**：并发 code 提交仅一个 CAS 成功、另一个 409——native "two racing code submissions…"（gate+409+release）与 integration 真库 `Promise.all` 双 `transition`（恰一非空）；迟到响应不覆盖终态/不存密码/不恢复 agent——native "a late code response…（cancelled）"、"a late password response…（expired，logins 空、resolved 空）"与 integration cancelled 用例；重启只恢复状态不重调 gateway——native "a restart restores state and types nothing…"（第二实例 0 gateway 调用，显式 code 才打字）。

## 3. RED → GREEN 证据

**RED（实现前，native runner）**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts` → **12 failed / 16 passed (28)**。失败项：code_required 转移（"expected signed_in to be code_required"×3）、submitCode 缺失、code 路由 404、route 兼容断言（fills 仍带 code）、**租约到期回 pending（"expected pending to be failed"——禁令行为被钉住）**。1 例实现前即绿（"a late password response cannot overwrite an expired request"——现有 `changed while it was being entered` throw 的回归钉，非新行为）。

**RED（实现前，driven+DB，fixture 库 0164 schema）**：`bun test ./tests/passwords-store.integration.test.ts` → **2 fail / 1 pass**；`PostgresError … violates check constraint "sign_in_requests_status_check"`（23514，旧 7 态约束拒 `code_required`）+ 租约断言失败。

**GREEN（实现后）**：
- `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts` → **28 passed / 0 failed**（format 后复跑同绿）。
- `TEST_DATABASE_URL=…5433/openbot_l02_fixture bun test ./server/tests/passwords-store.integration.test.ts` → **3 pass / 0 fail**。
- L01 回归：`server/tests/computer-sign-in-code.test.ts` → **4 passed**（schema 删字段后复跑）。
- audit 回归：`server/tests/audit.test.ts` → 7 passed / 1 failed，唯一失败为 BASE 既有漂移（见偏差 7）。
- 覆盖对账：`node scripts/e2e-coverage-audit.mjs` → **no gaps**。

## 4. 迁移 0165 演练（编号=本地 journal 下一个，journal 原 idx 164）

| 路径 | 步骤 | 证据 |
|---|---|---|
| fresh | 新建 `openbot_test-pg:5433/openbot_l02_fresh` → 生产脚本 `bun server/scripts/migrate.ts`（含 0165）一次到底 | `drizzle.__drizzle_migrations` **166 行**（0000+165 文件）；`pg_get_constraintdef`：status IN 8 态含 `code_required` |
| upgrade | 新建 `openbot_l02_upgrade` → 用生产 `migrateWithValidationBoundary` 按剥除 0165 的 journal/SQL 副本（`/tmp/l02-drizzle-0164`，165 条）先迁到 **0164** → 插入旧数据（pending 行 + 用户行）→ 试插 `code_required` **被旧约束拒（23514，证明升级在做事）** → 再跑生产 `migrate.ts` 只应用 0165 | 迁移表 **165→166**；旧 pending 行与 outcome 原样保留；升级后 `code_required` 插入成功；constraintdef 为 8 态 |
| 约束 | 迁移只做 `DROP CONSTRAINT` + `ADD CONSTRAINT` 同名 check（无列变更、无数据改写） | 0165 SQL 全文 2 语句 |
| 未触碰 | 现存迁移文件零改动；编号未复制上游 0056 | `git status`：drizzle 下仅新文件 + journal |

fixture 库（docker `openbot-test-pg:5433`，postgres/openbot，仅供本流程/验证者复用，未动他流库）：`openbot_l02_fresh`、`openbot_l02_upgrade`（演练）、`openbot_l02_fixture`（集成测试用，保留供 validator 复跑）。

## 5. 审计载荷样例（虚构 fixture 值；真实运行经既有 redaction）

`computer.sign_in_code_requested`：
```json
{"actor":"fixture-owner","bot":"fixture-bot","request":"0ba19685-…","site":"https://example.test","method":"typed"}
```
`computer.sign_in_failed`（错 code）：
```json
{"actor":"fixture-owner","bot":"fixture-bot","request":"0ba19685-…","site":"https://example.test","method":"typed","step":"code","failure":"The verification code could not be submitted."}
```
`computer.sign_in_completed`（code 步）：
```json
{"actor":"fixture-owner","bot":"fixture-bot","request":"0ba19685-…","site":"https://example.test","method":"typed","verificationCode":true}
```
载荷仅 actor/bot/request/site/method/step/verificationCode —— 无 username、password、code。native 套件以 `expectNoCredential`（password+code 双值）扫 view/audit/存储行/AG-UI 事件/模型请求；integration 扫 `JSON.stringify(audit)` 与库行。code 不落库（表无新列）、不进日志（路由 500 固定句、error 仅 name）。

## 6. format / typecheck 自查（真实 exit code）

- `bunx biome format` 逐一：**exit 0** —— types.ts、store.ts、service.ts、routes.ts、schema.ts、db/schema/passwords.ts、audit.ts、passwords-sign-in.test.ts（初查 1 处本人新增行折行，`--write` 后 exit 0）。
- **exit 1（BASE 漂移，本人新增行不在差异内）**：`server/tests/passwords-store.integration.test.ts` —— 唯一差异点是第 1 行 import（已用 `git show HEAD` 重放验证：HEAD 版本同 exit 1、同差异；本人新增行已全部 format 清洁，未触碰 BASE 行）。同 L01 gateway.ts 处置先例。
- `server/drizzle/*.sql` 与 `meta/_journal.json`：biome 配置 ignore 的路径（"These paths were provided but ignored"）；journal 另以 stdin 方式验证 format 无差异。SQL 非 biome 支持类型。
- `bunx biome check`（lint）：本人文件 4 处 `organizeImports` + integration format 1 处，**逐一与 HEAD 版本在同文件同行号复现（.l02-head-check 重放，routes.ts:8、service.ts:17、两测试 :1），全部 BASE 既有**；本人新增行零 finding。
- `bun run --filter server typecheck` → 仅 `scripts/bootstrap-local-gateway.ts(106/108/120)` 3 条 TS2339，与台账登记 BASE 红完全一致；本任务文件零报错。

## 7. 偏差与澄清（需编排者/验证者注意）

1. **租约到期 → failed 而非上游的 code_required/pending**：上游 0056 对过期 filling 按 method 回 code 步/密码步；brief 8 行表与 Spec §5（"执行 lease 过期，进入 failed 并说明结果不明"）明确覆盖，按 brief 实现（load() CAS → failed + 不确定 outcome + 释放等待 turn）。上游行为未采纳并已在测试中反向钉死。
2. **同步网关 throw 回 open（上游对齐）而非 failed**：throw 无法区分"未发出"与"响应丢失"；本实现的未知性兜底是租约（120s 无回音 → failed）。回 open 后无任何自动重发（重试是人的显式再提交，测试断言 `codes`/`fills` 长度不变）。若要求 throw 一律 failed，需 Computer 协议增加发送回执，超出本票边界，记录待议。
3. **submitCode 带 `actor` 参数**：brief/计划 I3 签名摘要为 `(owner, id, {code})`；audit 需 initiator，且既有 `submit` 同型——与上游一致取 `(owner, id, actor, {code})`。
4. **takeOver 从 code_required 可发起**（上游行为）：呼应第 8 行"用户可接管"；接管走既有 requestHelp 授权与人工屏障。
5. **密码保存时机**：code_required 分支即保存（上游对齐：站点已接受密码；否则 code 路径永远不保存）。vault、加密、显式保存开关（manager off 拒绝）语义不变；保存失败 409 且请求仍停在 code_required（测试钉住）。
6. **`step:"login"/"code"` 进入 sign_in_failed 载荷**（上游对齐）：brief 所称"category"以此为实现；新增 `sign_in_code_requested` 类型外，未改 audit 结构。
7. **audit.test.ts "declares nothing this deployment cannot write" 红（BASE 既有）**：19 个 `workshop.*` 类型在 HEAD 的 audit.ts 已声明而全树无 writer（walker 排除 audit.ts 本身）。失败集与 HEAD 完全一致（零 `sign_in` 项），本人新增类型有 writer（service.ts）。不触碰，报台账。
8. journal `when=1792857600001`：0164 为手工整值，取其后 1ms 保持单调（drizzle 按数组序执行，`when` 仅记录）。
9. 测试基建两处（native 套件）：`untilStatus` 轮询（在真实 CAS 边界交错，替代 sleep 猜测）与 fakeGateway gate/`letGo`（构造"在途/迟到"时序）；`withCodeStep` 复用同一 setup。无生产代码为测试让步。

## 8. 回滚证据（按 brief §7，演练步骤非生产执行）

1. **停新入口**：关闭 `POST /api/sign-in-requests/:id/code`（路由移除/网关封禁）——旧密码路径不受影响（`submit`/`use-saved` 兼容旧客户端 body）。
2. **排空/终结在途状态**：`code_required` 行 → 取消或补完；在途 `filling`（有租约）→ 等租约到期由 load() 终结为 failed，或运维 CAS 至终态；确认 `SELECT count(*) FROM sign_in_requests WHERE status IN ('code_required')` 为 0 且无 filling 在途。
3. **回滚应用（保留扩展 schema）**：应用回滚到不含 L02 service/routes 的版本；**不回滚 0165 数据库迁移**（8 态 check 对 7 态应用完全兼容——旧应用读不到的 `code_required` 已在第 2 步清空，其余状态全部合法）。0164 时点的旧约束反证已在演练中记录（23514）。
4. 不承诺所有新旧组件任意混搭（兼容矩阵以计划 §7 为准：完整新栈→旧栈必须先执行 1–2 步）。

## 9. 验证命令清单（实跑）

```
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts   # 28 pass（RED 时 12 fail）
bun test ./server/tests/passwords-store.integration.test.ts   # TEST_DATABASE_URL 指向 openbot_l02_fixture，3 pass（RED 时 2 fail/23514）
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/computer-sign-in-code.test.ts  # 4 pass（L01 回归）
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/audit.test.ts                  # 7 pass / 1 BASE 红（偏差 7）
DATABASE_URL=…5433/openbot_l02_fresh bun server/scripts/migrate.ts      # fresh：166 entries
DATABASE_URL=…5433/openbot_l02_upgrade bun server/scripts/migrate.ts    # upgrade：165→166，旧数据保留
bun run --filter server typecheck                                        # 仅 3 条登记 BASE 红
node scripts/e2e-coverage-audit.mjs                                      # no gaps（manifest 零改动）
```

秘密卫生：本报告与全部 fixture 仅含虚构值（`fixture-password-1`、`424242-fixture-only` 等）；无任何真实凭据。

---

# L02-F1 修复段（reviewer Major F-1，主控裁决采纳）

**裁决闭环**：原偏差 2 的"throw 无法区分已发出/未发出"自辩不成立——`server/src/computer/client.ts:297-331` 的 transport 分类早已区分：`ComputerUnreachableError`（provablyNeverReached：ECONNREFUSED/ENOTFOUND/EAI_AGAIN，可证明未发出）与 `ComputerUnavailableError`（TimeoutError/75s backstop/中断连——"the write may have landed"，即 Spec §5"已发出动作但响应无法确认"）；`ComputerStoppedError` 亦属后者（中止时字节可能已发出）。原实现 catch 不分流，一律回 open 清 lease，未知结果被 open 态 + TTL 假确定性终结。

## F1 改动（owned_files 内）

| 文件 | 改动 |
|---|---|
| `server/src/passwords/service.ts` | ①`UNKNOWN_OUTCOME` 常量提取（lease 到期与 throw 不确定分支共用同一句，原 8 行表 row 8 语义不变，`load()` 改用之）；②新增 `landUnknown(owner, id, actor, step, failure)`：CAS `filling→failed` + 不确定 outcome + `resolvedAt` + audit `computer.sign_in_failed`（step + 脱敏技术原因，无凭据）+ `resolved()` 释放等待 turn——复用 L02 既有 failed-with-unknown 机制，非第二套；③`enterCode`/`fill` 的 catch 按传输层既有类别分流：`error instanceof ComputerUnreachableError` → 走原 definite-failure 分支（回 `code_required`/`pending`，可显式重试）；**其余一切 throw**（`ComputerUnavailableError`/`ComputerStoppedError`/未知）→ `landUnknown` 落 `failed`，不重发、不报成功。8 行状态表其余行为零改动。 |
| `server/src/db/schema/passwords.ts` | **F-2**：`fillingUntil` 注释 "the request reopens" → "ends `failed` as unknown and is never reopened for a replay"（与 L02 已改行为一致）。 |
| `server/tests/passwords-sign-in.test.ts` | fakeGateway 增 `fail`（按名抛错、按引用持有可清除）；新增 4 分支测试（见下）。 |

## F1 RED → GREEN

**RED（实现前）**：native **2 failed / 30 passed (32)**——
- (a) `ComputerUnavailableError` × code 步："a code delivery whose answer never came ends the request failed as unknown"（现状回 code_required，断言 failed 失败）；
- (c) `ComputerUnavailableError` × fill 步："a login delivery whose answer never came…"（现状回 pending）。
- (b)(d) `ComputerUnreachableError` 两分支实现前即绿（旧 catch 恰好把它们当可重试）——保留为钉住分支：修复若过度（一切 throw 落 failed）它们即红。

**GREEN（实现后）**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts` → **32 passed / 0 failed**。四分支矩阵：
| throw 类别 | fill 步 | code 步 |
|---|---|---|
| `ComputerUnreachableError`（可证明未发出） | 回 pending、可再次领取（测试：清 fail 后重提交 signed_in，fills 恰 2） | 回 code_required、可再次领取（同法验证） |
| `ComputerUnavailableError`（写可能已落地） | CAS `failed` + /not known whether/ outcome + `resolvedAt` + resolved 释放 + logins 空（save:true 也不存）+ 无 completed audit | 同左（failed、resolved 1、`codes` 恰 1 不重发、无 completed audit、无凭据） |

**复跑**：`server/tests/computer-sign-in-code.test.ts` 4 passed；`TEST_DATABASE_URL=…5433/openbot_l02_verify`（新建 fresh 库，166 entries 含 0165）`bun test ./server/tests/passwords-store.integration.test.ts` → **3 pass / 0 fail**；`bun run --filter server typecheck` → 0 条非 BASE 错误（3 条 bootstrap BASE 红不计入）；`bunx biome format` → `service.ts` exit 0（本人新增行经 --write 后复验；初查 1 处折行）、`db/schema/passwords.ts` exit 0、两测试文件同前次结论（integration 第 1 行 BASE import 漂移不变）；`bunx biome check service.ts` 唯一余项为 BASE 既有 organizeImports（:18，HEAD :17 同项平移）+ 本人初版 `landUnknown` 未用参数已修（noUnusedFunctionParameters 归零）。

**偏差 2 闭环**：原报告 §7 第 2 条撤销，以本段分流实现替代；"未新建第二套分类"成立（仅 `instanceof ComputerUnreachableError` 一个判定，类别与写预算 refund 决策同源）；同步 throw 的不确定分支与 lease 到期共用 `UNKNOWN_OUTCOME` 与 CAS 机制。已知残余边界（记录不阻塞）：gateway 门前的确定性拒绝（如 HumanHasControlError，extend Error 而非 Unavailable 族）在本二分下也落 failed-unknown——偏保守方向，且 signIn/signInCode 直连 transport 不经 action gate，实际不可达该类型；如需细化应另立票改 transport 分类，不在本修复范围。
