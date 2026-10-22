# L02-F1 聚焦复审（Fix F-1 / reviewer 复验）

- 复审人：independent reviewer（只读；唯一写入为本报告）。日期：2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD `3b4a7c68…`，未提交树）。对象：F-1 修复增量（声称 3 文件：`service.ts`、`db/schema/passwords.ts`、`passwords-sign-in.test.ts`）。
- 方法：catch 分流与 `landUnknown` 逐行对读；错误类层次（Unreachable⊂Unavailable、Stopped⊂Unavailable、HumanHasControl/ProviderError/CapacityError 为普通 Error）全链核对；残余"不可达"主张按 gateway→transport→agent-computer 三层独立验证；4 分支测试逐断言核对 + RED 逻辑自洽性检查；全部复跑亲验（native 32/32 + L01 4/4 = 36、integration 3/3 于 `openbot_l02_verify`@5433、typecheck、biome）；sha256 13 条全量重算；fix 标记物在 after-tracked.diff 中的落点扫描 + 无新增 untracked 文件核对（before/after tracked diff 跨 L02 全程，不能单独隔离 fix delta，范围结论为三角验证）。

## 1. Findings

### F1-R1（Minor，披露准确性）——残余披露中 "HumanHasControlError 实际不可达" 的主张不成立

实施报告 L02-F1 残余段称：signIn/signInCode "直连 transport 不经 action gate，实际不可达该类型"。**两层验证结果一真一假**：

- **服务侧为真**：`gateway.signIn`/`signInCode`（gateway.ts:1079-1098）直接 `post`，不经 `govern` 策略门（仅 navigate 等页动作用它，:1146-1149）。
- **Computer 侧为假**：`/sign-in/fill` 与 `/sign-in/code` 在 `ACTING_PATHS` 内（agent-computer/src/authorisation.ts:72-85，注释原文即 "Refused while they hold the wheel, like any other typing"）。人握方向盘时 `admitBotAction`→`assertBotMayAct` 抛 `ControlError`（control.ts:526-536），外层 catch 以 409 `{humanHasControl:true}` 应答（agent-computer/src/index.ts:1563-1575），服务端 `throwMappedError` 映射为 `HumanHasControlError`（client.ts:455-465，普通 Error）→ service catch 落 `uncertain` → `landUnknown` → failed-unknown。

即该类型**可达**（如：请求行仍在 code_required/filling 时，有人直接在 Computer 侧接管浏览器）。行为方向保守（不重开、不重放、等待轮次被告知），非 Spec 违反，但把可证明未执行的确定性拒绝标注为"结果不明"，且披露句以错误的不可达主张弱化了残余。建议：结案时更正披露措辞；如需细化（该类应确定性回 open 或明确拒绝语义）另立票改 transport 分类，与本修复无关。

### F1-R2（Info）——locate 层确定性拒绝同样落 failed-unknown，实施者未披露

gateway `locate`（gateway.ts:375-387）在任何 fetch 之前：`capacity.reserve` 容量拒（`ComputerCapacityError extends Error`，capacity.ts:30/245）、`provider.locate` 失败（`ProviderError extends Error`，provider.ts:43）、`checkComputerAddress` 拒（`ComputerUnavailableError`，gateway.ts:383-385——该类只有 transport fetch 分类器铸造 Unreachable 子类，此处为父类）。三者在 service 二分下均落 failed-unknown。"可证明未发出→重开"原则实际只在 transport fetch 层生效（ECONNREFUSED 重开），locate 层的可证明未发出被保守收进 failed。与 F1-R1 同向（保守、安全），brief 明令不改 gateway/transport 分类，不构成本修复缺陷；记录供后续票统一。

### F1-R3（Info，吹毛求疵）——uncertain 分支 CAS 失败时 400 与既定 409 文案族不一致

`enterCode`/`fill` uncertain 分支在 `landUnknown` CAS 失败（并发改写，实际仅剩租约清扫胜出的极窄窗口）时回 `SignInRefusedError("changed while it was being entered", 400)`，而确定失败分支同句为 409、既定路径同句为普通 Error。不影响安全性质，仅状态码一致性。

## 2. F-1 解决性逐点核对（核心）

| 核对点 | 结论 | 依据 |
|---|---|---|
| `ComputerUnreachableError` → 确定性重开（code_required/pending 按 tabla） | **通过** | service.ts:387/:505 `instanceof ComputerUnreachableError` → `failure`（确定性分支）；enterCode 回 `code_required`（:399-405，含 :362 back 变量），fill 回 `pending`（:518-524）；测试 :1019-1046/:1081-1112 各含清 fail 后显式重提交 → signed_in、`codes`/`fills` 恰 2 |
| 其余一切 throw（Unavailable/Stopped/未知）→ `landUnknown` | **通过** | `ComputerStoppedError extends ComputerUnavailableError`（client.ts:23）而非 Unreachable → `uncertain`（:388/:506）；`landUnknown`（:299-322）CAS `["filling"]`→`failed` + `resolvedAt` + audit `computer.sign_in_failed`（step + scrubbed 技术原因，无凭据）+ `resolved()` 释放等待轮次 |
| 与租约到期同句、同一机制，非第二套 | **通过** | `UNKNOWN_OUTCOME` 常量（:123-124）被 `load()` 租约分支（:185-189）与 `landUnknown`（:308）共用；CAS from 列表、resolvedAt、`resolved()` 全同；分类仅一个 `instanceof` 判定，沿用 transport 既有类（service.ts:4 唯一 import），无第二套分类 |
| 类层次与判定顺序 | **通过** | Unreachable⊂Unavailable（client.ts:98），先判 Unreachable（:387/:505）——顺序正确；Stopped⊂Unavailable 非 Unreachable，落 failed（中止时字节可能已发出，方向正确） |
| §5 第 5 行：不自动重发 | **通过** | catch 只置 `uncertain`→`landUnknown`→throw，无第二次 gateway 调用；failed 后任何输入路径 409（终态）；测试钉 `codes`/`fills` 长度 1 |
| §5 第 5 行：不报告成功 | **通过** | failed 态、无 `sign_in_completed` audit、`resolved` 释放携带 failed 行；测试显式断言（:1013-1015） |
| §5 第 5 行：结果不明有说明 | **通过** | 行 outcome 与抛给路由的拒绝句均为 UNKNOWN_OUTCOME 全文（"…it is not known whether the login went through. Do not assume it did…"）；`fillingUntil` 清除后租约兜底路径不再依赖（failed 已终态） |
| 凭据边界不回退 | **通过** | uncertain 消息经 `scrub(…,[code])`（enterCode :379-384）/`scrub(…,secrets)`（fill :497-502）进 audit；两新测试均跑 `expectNoCredential`（:1016/:1076） |

## 3. 4 分支测试真实性

`fakeGateway.fail`（test :59-93：按名抛错、按引用持有可清除）为真实异常注入，非吞异常的假结构化返回。四测试逐断言核对：

1. code 步 Unavailable（:995-1017）：failed + /not known whether/ + resolvedAt 非空 + resolved ["failed"] + `codes` 恰 1（不重发）+ 无 completed audit + 无凭据。
2. code 步 Unreachable（:1019-1046）：code_required + `fillingUntil` null + resolved 空 + failed audit `step:"code"` + 显式重试 → signed_in、`codes` 恰 2。
3. fill 步 Unavailable（:1048-1079）：failed + unknown 句 + resolved 释放 + **`logins===[]`（save:true 也不存）** + `fills` 恰 1 + 无凭据。
4. fill 步 Unreachable（:1081-1112）：pending + `fillingUntil` null + resolved 空 + 显式重试 → signed_in。

**RED 逻辑自洽性**：旧 catch 一律按确定失败重开 → 两 Unavailable 测试（断言 failed）必红、两 Unreachable 测试（断言重开）必绿；28+4=32 与 "2 failed / 30 passed (32)" 算术吻合；Unreachable 两例保留为过度修正守卫（若一切 throw 落 failed 它们即红）——与 brief RED (a)-(d) 结构一一对应，成立。（RED 现场不可复跑——源码只读，裁决基于逻辑自洽 + GREEN 亲验。）

## 4. 残余主张独立验证

见 F1-R1/F1-R2：服务侧无 action gate 为真；Computer 侧 wheel gate 对两 sign-in 路径生效且 `HumanHasControlError` 可达，"实际不可达该类型"主张不成立（行为保守，非违反）。499 stopped（client.ts 经 :486 落 Unavailable→uncertain→failed）方向正确（动作确在途）。

## 5. F-2、范围、复跑、F-3

- **F-2**：`db/schema/passwords.ts:83-86` 注释已改为 "…ends `failed` as unknown and is never reopened for a replay"，与 L02 已钉死行为一致。**已解决**。
- **范围**：fix 标记物（landUnknown/UNKNOWN_OUTCOME/Unreachable/4 新测试/fail gate）在 after-tracked.diff 中仅现于 service.ts 与 passwords-sign-in.test.ts；F-2 hunk 在 schema 文件；无新增 untracked（after-status − before-status 恰为 L02 十文件 + 0165）；sha256.txt 13 条全量重算 ALL-MATCH（含 3 个 fix 文件与未变的其余 10 个）；gateway/client/store/routes 活读与 L02 审定内容一致。三角验证支持"恰 3 文件"。（before/after diff 跨 L02 全程，无法单独隔离 fix delta——已如实记录为方法边界。）
- **复跑（全部亲验）**：native `passwords-sign-in.test.ts` **32/32**（含 4 新分支）；L01 回归 `computer-sign-in-code.test.ts` **4/4**（合计 36/36）；integration `TEST_DATABASE_URL=…5433/openbot_l02_verify`（亲查 166 entries 含 0165）**3 pass / 0 fail / 27 expect**；typecheck 仅 3 条 BASE 红（bootstrap-local-gateway.ts:106/108/120 TS2339），L02/fix 文件零错；`biome format` 3 文件 exit 0 无需修；`biome check service.ts` 唯一余项 organizeImports :18 —— 与 HEAD :17 同项平移（HEAD 版亲验同规则同错），非修复引入。
- **F-3**：throw 路径测试已随修复补齐——即上述 4 分支矩阵，恰为原 F-3 开列清单（code 步 ambiguous→failed、unreachable→code_required、密码步同型）。**已解决**。

## 6. 结论

F-1 修复真实解决原 Major：分流正确、机制复用、硬性质（不重发/不假成功/不明有说明）齐备且被真实测试钉住；F-2、F-3 同步闭环；范围与证据链完整，全部复跑绿。残余 F1-R1（披露句不可达主张不成立）与 F1-R2（locate 层同类保守收口未披露）均为保守方向的披露/分类瑕疵，不构成 Spec 违反，建议结案更正披露措辞并可另立票细化分类。

Spec compliance: pass
Code quality: pass
