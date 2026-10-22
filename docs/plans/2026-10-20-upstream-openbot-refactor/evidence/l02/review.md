# L02 独立 Review（Task L02 / AC A08 / Issue #496）

- 审查人：independent reviewer（只读；唯一写入为本报告）。日期：2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD `3b4a7c68…`，未提交树）。对象：L02 增量 = 10 个 tracked 文件 + 新 `server/drizzle/0165_sign_in_code_step.sql`。
- 方法：§5 九条逐条对源码与测试；偏差 2 专项裁决（gateway/client/agent-computer 三层 throw 语义对读）；sha256 全量复算；native/driven 双层复跑；before/after tracked diff 逐文件对账；verify 库直查。所有凭证未落任何报告。

## 1. Findings

### F-1（Major，Spec compliance）——同步网关 throw 中"发出后结果不明"一类回到 open，而非 §5 要求的 failed

**裁决：实施方偏差 2 的"可证明未完成"不成立（对全部 throw 路径而言）。**

证据链（三层对读）：

1. **agent-computer 从不 throw**：`agent-computer/src/sign-in.ts` 的 `fillSignIn`/`fillSignInCode` 内部 catch-all，一切 Playwright 失败都折叠为结构化 `error` 结果返回。因此 service 边界上的 throw 只能来自 transport 层。
2. **transport 自己区分了"可证明未发出"与"发出后失联"**（`server/src/computer/client.ts:297-331`）：
   - `ComputerUnreachableError`：仅在 `provablyNeverReached` 时抛出（client.ts:79-103，注释原文 "a connection that was never established cannot have [landed its bytes]"）——**可证明 pre-dispatch，回 open 符合计划"可证明未完成"分支**；
   - `ComputerUnavailableError`：`TimeoutError`（75s `SIGN_IN_BACKSTOP_MS`，client.ts:310-315 注释原文 "**the request was sent, an answer never came — the write may have landed**"）与 mid-flight 断连（client.ts:329-331，"the write may have committed"）——**这正是 §5 第 5 行"已发出动作但响应无法确认"的定义情形**。
3. **service 的 catch 不做该区分**：`server/src/passwords/service.ts` `enterCode` catch（:334-341）与 `fill` catch（:436-443）把一切异常 scrub 后送入同一条失败路径，`transition(["filling"], {status: "code_required"|"pending", fillingUntil: null, …})` ——请求重开。

**后果（超出字面违规的实质问题）**：throw 重开分支把 `fillingUntil` 清空，**120s 租约→failed 的兜底在该路径上永不生效**（偏差 2 自述"未知性兜底是租约"在其覆盖的场景内不成立）。无人操作时请求最终以 TTL 到期终结，outcome 为 "Nobody entered the verification code for X before the request expired."（code 步）/ "Nobody signed in to X"（密码步）——当 code/密码可能已被输入并被站点接受时，这是**向等待中的模型断言了确定性的假命题**，恰是 §5 "说明结果不明"要防止的。两个硬安全性质未破：无自动重发（重试仅为人的显式再提交，测试断言 `codes`/`fills` 长度不变）、不声称成功。

**报告措辞修正**：偏差 2 的理由"throw 无法区分'未发出'与'响应丢失'"与本仓库自己的分类机制矛盾；计划 L02 检查表原文即要求该区分（"明确密码/code 失败且**可证明未完成**的分支按状态表返回 pending/code_required"——言下之意不可证明者走 failed）。

**修复建议（小范围）**：两个 catch 内按错误类别分流——`ComputerUnreachableError`（含 `locate` 失败）→ 维持现回 open 行为；`ComputerUnavailableError` 及未知类 → CAS `["filling"]`→`failed`，复用租约路径同款"not known whether"outcome 并触发 `resolved()`；配套测试见 F-3。若编排者选择接受现行为，须按 AGENTS.md 回到 Spec 做偏差修订，不得在实现层静默定案。

### F-2（Minor）——`server/src/db/schema/passwords.ts:83` stale comment 应本轮修

注释原文 "past this, the attempt is treated as abandoned and **the request reopens**" 描述的正是本任务 RED 钉死并移除的行为。validator 建议延至 L03/收尾；**本 review 裁定应在本轮（或紧随的小修批次、L03 集成前）顺手修**：该文件在 L02 owned_files 内、同表 check 行本就在本次 diff 中、改动一行，且该注释直接误导迁移审查者对 0165 的理解。

### F-3（Minor）——gateway throw 路径零测试覆盖

`fakeGateway` 从不 throw；`fill`/`enterCode` 的 catch 分支——F-1 行为的全部所在——没有任何测试。RED 清单中"网络不确定不自动重发"实际由租约用例与结构化 error 用例承担，未触及异常路径。F-1 修复必须补：code 步 throw（ambiguous 类）→ failed(unknown)；unreachable 类 → code_required；密码步同型。

### F-4（Info）——证据文件措辞两处

- 实施报告偏差 2 理由不准确（见 F-1），结案时更正。
- validator 报告 §1 第 8 行"before-tracked.diff 含旧测试"措辞不精确：旧测试未被 L01 触碰，故只存在于文件状态（HEAD:664，断言 `pending` 重开+重提交），before diff 无其 hunk；after diff 以 `-` 行删除（after-tracked.diff 测试段 :232）。实质声明（旧行为已删除并由 failed 测试反向钉死）经本 review 亲核成立。

## 2. Spec §5 九条逐条

| # | §5 要求 | 结论 | 依据 |
|---|---|---|---|
| 1 | 初次不问 code；旧客户端 code 忽略；Computer 实报字段才 code_required | **通过** | `routes.ts` submit/use-saved 不读 `code`（:107-123 注释即约）；service `submit` 签名无 code；`fill()` 仅 `result.codeRequested` 时 CAS→code_required（service.ts:465-505）；agent-computer `parseSignInFill` 明示不读 code |
| 2 | 私有 code 入口沿用 owner/有效期/Bot/origin/服务认证/人工屏障；code 非模型工具参数 | **通过** | `POST /:id/code`（required、max 64、requireUser）；store 全程 owner 作用域（他人 404 有测试）；botId/origin 取自行（`claimed.origin`，Computer 侧同源比对在 agent-computer `fillSignInCode` 入口）；`/api` 之外模型不可达；`signInToolResult` 无凭据字段 |
| 3 | 仅 code_required 可领 lease；条件更新；并发失败 409 | **通过** | `enterCode` 仅 `transition(["code_required"])`（service.ts:305）；Postgres 条件 UPDATE RETURNING / memory includes 判断（store.ts:67-80,176-182）；native "two racing…" + integration 真库 `Promise.all` 双 transition 恰一非空 |
| 4 | 状态链 pending→filling→code_required→filling→signed_in；错 code 回 code_required；回密码页回 pending；取消/到期终态 | **通过** | `back` 分支（service.ts:316-357）；`OPEN` 含 code_required 使取消/到期可覆盖；native 4 个对应用例 + "an expired request closes itself" |
| 5 | 已发出但结果不明/lease 过期→failed 并说明不明；不自动重发、不声称成功 | **部分不通过（F-1）** | 租约半句达标：`load()` CAS→failed + "not known whether"（service.ts:166-186，native + integration 钉死，旧行为已删）；"已发出但响应无法确认"半句不达标：TimeoutError/mid-flight 类 throw 回 open，见 F-1 |
| 6 | 迟到响应不覆盖取消/过期、不存密码、不恢复 Agent；code_required 非终态；终态恢复复用现有机制 | **通过** | 写回全为 `["filling"]` CAS，终态下必 null→`changed while it was being entered`；native 迟到 code/密码两用例（`logins===[]`、`resolved===[]`、无 completed audit）；`isFinalSignIn("code_required")===false` 有断言；`resume.ts` 零 diff，`onResolved` 仅终态触发 |
| 7 | code 不落库/日志/追踪/聊天；密码仅明确保存进 vault | **通过**（UI 清理归 L03） | 表无 code 列（verify 库 information_schema 亲查=0）；gateway 派生字符串一律 `scrub(…,[code])` 含 URL；路由 onError 仅 `error.name`+固定句；audit 载荷仅 actor/bot/request/site/method/step/verificationCode/savedLogin/failure(scrubbed)；`expectNoCredential`（password+code 双值）扫 view/audit/行/AG-UI/模型请求；保存仅显式 save 且 manager on，失败 409 请求不停留 |
| 8 | 只扩状态约束；不复制上游编号；按本地 journal；发布序 schema→Computer→API→UI | **通过** | 0165 全文 2 语句 DROP+ADD 同名 check（8 态，与 db/schema 逐态一致）；journal 仅追加 idx 165（`when=1792857600001` 紧随 0164 单调）；现存迁移零改动；L03 未动故新入口尚未对 UI 开放 |
| 9 | 回滚前停新入口、排空/终结 code_required 与在途 filling、保留扩展 schema 回滚应用；不承诺任意混搭 | **通过** | 0165 注释含 drain/rollback runbook 提示；实施报告 §8 三步回滚（停路由→清 code_required/等租约终结 filling→保留 8 态约束回滚应用）与计划 L02 回滚行一致 |

## 3. 偏差 2 专项裁决（validator 提请）

见 F-1。一句话结论：**"可证明未完成"只在 `ComputerUnreachableError`/locate 失败子类成立；TimeoutError（75s backstop）与 mid-flight 断连子类是发出后结果不明，transport 自己的注释已承认这一点，service catch 未分流，回 open 违反 §5 第 5 行前半句，且使租约兜底失效、TTL 到期时向模型输出假确定性 outcome。**"不自动重发"半句未破。列 Major，不列 Blocker：触发面窄（需 75s 超时或中途断连/进程被杀）、无重放与假成功风险、修复局部（一个 catch 分流 + 少量测试），但按"Spec 为准"不得以现状态通过验收。

## 4. 交叉核对（抽查结果）

| 声明 | 复核 |
|---|---|
| sha256.txt 13 条全部对应当前树 | **亲验全 OK**（含 after-tracked.diff 与 implementer-report.md 自身） |
| native 28/28；integration 3/3（27 expect） | **亲跑复现**（native 1.23s；`openbot_l02_verify` integration 3 pass/0 fail/27 expect） |
| L01 回归 4/4 | **亲跑复现**（`computer-sign-in-code.test.ts`） |
| audit.test.ts 7/1 红=BASE | **亲跑复现**：唯一失败 "declares nothing this deployment cannot write"，trace 失败集恰 19 个 `workshop.*`、`sign_in` 出现 0 次 |
| server typecheck 仅 3 条登记 BASE 红 | **亲跑复现**：仅 `scripts/bootstrap-local-gateway.ts` 106/108/120 TS2339，L02 文件零报错 |
| verify 库 8 态/166 迁移/无 code 列 | **亲查**：constraintdef 8 态含 code_required；`__drizzle_migrations`=166；code-like columns=0 |
| diff-of-diffs：L02 恰 10 tracked + 0165 新文件 | **亲验**：28 个两批共有文件中仅 `computer/schema.ts`（删 Deprecated `code` 字段+注释改写）与 `passwords-sign-in.test.ts` 内容变化；`e2e-bun-suites.json` 逐字节相同；`resume.ts` `git diff HEAD` 为空 |
| 旧"lease 过期回 pending 重开"已删并反向钉死 | **亲验**：HEAD:664 旧测试断言 pending+重提交；after diff `-` 删除；新 "failed as unknown, never silently reopened" 断言 failed/409/`fills===[]` |
| 测试结构 = 8 行状态表逐行映射 | 亲读：28 用例（HEAD 17 −1 +12）覆盖 8 行及并发/迟到/重启组合；`untilStatus` 轮询真实 CAS 边界、gate+`letGo` 构造在途时序，无生产代码为测试让步（偏差 9 成立） |
| 偏差 1/3/4/5/6/8 | 均成立且可接受：租约→failed 按 brief/Spec 覆盖上游行为（有反钉测试）；`submitCode` 多 `actor` 与既有 `submit` 同型、audit 需 initiator；takeOver 自 code_required 呼应第 8 行"用户可接管"；密码在 code_required 分支保存（站点已接受、凭据仍在手上，避免跨 code 步持有明文），失败 409 请求停 code_required 有测试；journal `when` 单调；测试基建无生产妥协 |

## 5. Code quality

- **CAS 一致性**：一切状态写回经 `store.transition(from,…)` 单一条件更新缝；claim/failure/done 三段均带 from 列表；两 store 实现语义一致；claim 失败 409 文案统一。无绕过缝的直写（测试里的 store.transition 属测试构造前置态，合理）。
- **audit 最小载荷**：仅一个新类型 `computer.sign_in_code_requested`；载荷字段全部为类别/引用值；`step:"login"|"code"`、`verificationCode:true`、scrubbed failure 与上游对齐且无凭据。
- **秘密边界**：`scrub` 阈值 ≥3 字符、截断 500；error message 不落日志（仅 `error.name`）；RequestView 继续排除 `continuation`/`ownerUserId`，record 无凭据字段。
- **0165 注释质量**：说明状态语义、expand-only 原理、向前兼容依据与回滚 runbook 指引，质量高于平均。
- **扣分项**：F-2 stale comment；F-3 catch 分支无测试。

## 6. 结论

L02 在状态机、并发/迟到/重启安全、秘密边界、迁移纪律与证据绑定（sha256 可复算、diff-of-diffs 对账无溢出）上质量扎实，九条 §5 中八条完全达标；唯一实质问题是 F-1（偏差 2 裁决为不成立），属可局部修复的 Spec 字面违反，修复前不应计入 A08 达成。

Spec compliance: fail
Code quality: pass
