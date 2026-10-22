# Fix Brief L02-F1：按错误类别分流 throw 的终态（Spec §5 第 5 行）

- **来源**：L02 reviewer F-1（Major），主控采纳其裁决：`server/src/computer/client.ts:297-331` 已区分 `ComputerUnreachableError`（provablyNeverReached，可证明未发出）与 `ComputerUnavailableError`（TimeoutError/75s backstop/mid-flight 断连——"the write may have landed"，即 §5"已发出动作但响应无法确认"）；而 `service.ts` 的 `enterCode`（:334-341）与 `fill`（:436-443）catch 不分流，一律 CAS 回 open 并清 lease——未知结果被 open 态 + TTL 假确定性终结（outcome "Nobody entered the verification code…" 在 code 可能已被接受时是假断言）。无自动重发、无假成功（两硬性质未破），但按"Spec 为准"不得以现状计入 A08。
- **裁决（主控，入 ledger §7）**：实现者偏差 2 的"throw 无法区分"自辩不成立（transport 已区分）；须修复。

## owner_role: backend_implementer（原 L02 实现者）
## owned_files
- `server/src/passwords/service.ts`
- `server/src/db/schema/passwords.ts`（仅 F-2 stale comment :83 修正）
- `server/tests/passwords-sign-in.test.ts`、`server/tests/passwords-store.integration.test.ts`（补测试）

## 要求（RED→GREEN）
1. **RED**：新增测试——(a) code 提交后 gateway throw `ComputerUnavailableError`（或其 TimeoutError 成因）→ 请求 CAS 进 `failed`，outcome 明确"无法确认是否完成"类语义（不含秘密），无自动重发、无成功报告；(b) 同路径 throw `ComputerUnreachableError` → 回 open（code_required/pending 按 tabla），可再次领取；(c) 密码 fill 路径同两分支（Spec §5 同样覆盖密码提交）；(d) 两分支均不再调用 gateway。先跑证明失败。
2. **GREEN**：`enterCode`/`fill` 的 catch 按错误类别分流（import/识别沿用 transport 已有错误类型，不新建第二套分类）；未知结果分支复用 L02 已有的 failed-with-unknown-outcome 机制（与 lease 到期同语义）；不改 8 行状态表其余行为。
3. **F-2**：修正 `db/schema/passwords.ts:83` "the request reopens" stale 注释为 failed 语义。
4. **复跑**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts`（全绿，含新增）；`TEST_DATABASE_URL=<openbot_l02_verify> bun test ./server/tests/passwords-store.integration.test.ts` 3/3；`server/tests/computer-sign-in-code.test.ts` 回归；typecheck（3 条 BASE 红不计入）；`bunx biome format` 三个文件真实 exit 0（新增行）。
5. 报告追加 `evidence/l02/implementer-report.md` 的 L02-F1 段（RED/GREEN、F-2、偏差闭环说明）。

## 禁止
- 不改 gateway/transport/client.ts 分类（它们是对的）；不改迁移；不动状态表其他行为；无 commit/stash。
