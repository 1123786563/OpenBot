# Bifrost bf21：#309（13.4）+ #331（17.7）+ #332（17.8）三票实施计划

- 工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/bf21`（分支 `1123786563/bf21`）
- BASE：`bcf51633f`（main@HEAD；前置 13.x 实时链 0203-0206 与 17.x 异步链 0196-0201 已随 e8ea2102a 并入 main，开工核验迁移到 0206、speech/async 模块在树）。开工 git status 中 multitenancy/better-auth 系列为并存他人增量，保留不动。
- 提交策略：无提交授权 — 全部未提交交付；bifrost 子模块 pin `ad9470a5` 零提交（本地克隆，Go 侧改动为未跟踪/未提交覆盖）。
- 测试库：容器 `orca-w3-bf-pg`（127.0.0.1:5566，wave3 共享容器）内新建 `bf21` 库；全链迁移 0206→0207。
- 票号为准：#309=B13.4 尾部不可约束路径不启用、#331=B17.7 取消失败/未知终态保持完整预留、#332=B17.8 任务状态展示与归属不变（gh api 票面已核）。
- 报告：`reports/orca-dag-wave3-bf21.md` + `reports/bf21-increment-files.txt`。

## Task 1 — #309 B13.4 尾部不可约束语音路径不启用

**Consumes**：13.1 `assessSpeechGeneration`（speech-pricing.ts）、13.3 `settleInterruptedSpeech`/`chunkSeconds`（speech-interruption.ts）、14.3 证据登记（audio-capability-evidence.ts）、14.4 门（audio-path-admission.ts）、03.11 发现接口（model-discovery-routes.ts）。

**判定依据（尾部可约束 = 两个问题都有肯定答案）**：
1. 已生成量能否由服务端自己确定 —— 只有 WAV 容器自带可服务端读的时长元数据（`fmt ` byteRate / `data` size；14.1 `parseWavDurationSeconds` 整件、13.3 `chunkSeconds` 逐 chunk）；mp3/opus/aac/flac/pcm 在本网关没有任何服务端可信时长计量。
2. 停止计费能否强制 —— 调用方背书的 duration cap 只有对可计量的输出才能执行（整件实测超 cap 为缺陷拒付、流式在 cap 处切断并按 13.3 只结算已确认尾部）；不可计量的流既无法在 cap 处切断、也无法确认尾部费用。

**交付**：
- 新 `server/src/billing/speech-tail-availability.ts`：闭合格式集（mp3 默认/opus/aac/flac/wav/pcm，缺省=mp3）；`assessSpeechTailConstraint({stream, responseFormat})`；`speechTailAvailabilityView()`（发现接口/管理面投影：仅可约束路径入 enabled，其余带原因）。
- `server/src/billing/audio-path-admission.ts`：`assessAudioPathAvailability`/`AudioPathAdmissionInput` 增 `responseFormat?`；synthesis 族在登记判定后、价格轴之前先过尾部判定；新拒绝码 `speech_tail_unconstrainable`（stage evidence，detail 携格式与两条原因）；`audioPathAvailabilityView` 行对 synthesis 附 per-format 尾部投影（管理面）。
- `server/src/gateway/model-discovery-routes.ts`：GET / 答复新增 `speechPaths`（加法字段，不改既有键）。
- 契约演进记录：`server/tests/audio-path-admission.test.ts` 中 format-less speech 可用性用例补 `responseFormat: "wav"`（原断言的subjects是价格轴，保持）。
- 新测试 `server/tests/speech-tail-availability.test.ts`：默认格式=mp3 拒、wav 放行、其余格式拒（两原因）、发现接口答复携原因、强制调用 reserve/dispatch spy=0、wav 路径走通 admission（结算正确性由既有 speech-settlement/speech-interruption 回归承担）。
- Go 侧（bifrost clone 未提交）：显式转移 bf12 的 `plugins/governance/audiocapability.go`/`audiocapability_test.go` + creditadmission.go 的 AudioCapabilityEvidence hunk；新增 `speechcapability.go` + `speechcapability_test.go`（TestSpeechCapability*）：SpeechRequest/SpeechStreamRequest 按 `Params.ResponseFormat`（缺省 mp3）查闭合尾部约束表，非 wav 在计价分类与 reserve 之前短路拒绝。

**验证**：`cd bifrost/plugins/governance && go test -run SpeechCapability ./...`；`bun test server/tests/capability-availability.test.ts`（须保持绿）；`bun run --filter server typecheck`；governance `go test ./...`；biome lint。

## Task 2 — #331 B17.7 取消失败/未知终态保持完整预留

**Consumes**：17.2 提交链（async-job-submit.ts）、17.4 授权读模式（async-job-status.ts）、17.6 终态结算（async-terminal.ts）、06.11 Release（credit-release.ts，evidence 闭集 provider_error/bound_refused/no_usage）、06.8 unknown（credits-writer.markReservationUnknown）、18.4 先例（batch-cancel.ts）。

**语义**：取消请求≠无费用证明。供应商取消确认（cancelled unbilled）映射 06.11 既有 `no_usage` 证据类（供应商报告任务结束且零用量），reference 携取消回执——不扩 06.11 闭集。取消结果未知 → 06.8 unknown（全额占用）；不支持/失败/接受但无证据 → 保持原 hold 不动。Key 到期/客户端离开不触发释放（结构性：无任何路径监听连接或 Key 生命周期来动钱；17.4 可见性≠准入同规）。

**交付**：
- 迁移 `server/drizzle/0207_async_cancel_semantics.sql` + journal 207 + schema：`async_job_cancellations`（job_id PK/FK、last_request_key、provider_cancel_result 闭集 CHECK、evidence 形状 CHECK（有证据 IFF succeeded_unbilled_evidenced）、conclusion 闭集（released_on_evidence/hold_kept/hold_unknown）、released_credits（NOT NULL IFF released_on_evidence）、reports 计数、首末时间）。
- 新 `server/src/billing/async-cancel.ts`：`createAsyncCancelService`（注入 cancelAtProvider/release/markUnknown/audit）；同 key 重放答已记结论不再打供应商；同 key 不同结果可推进（unsupported→后续有证据释放）；已 settled/released 答已在终态不动钱；release 拒 unknown（06.11 语义透传）→ 结论 hold_unknown（08.9 接手）。
- `server/src/audit.ts`：+`billing.async_job_cancelled`（结论变化落一次审计，重复通知不重复审计——18.4 同规）。
- 新测试 `server/tests/async-cancel-semantics.integration.test.ts`：不支持→全额保持；结果未知→unknown 全额；有证据→释放（spendable 恢复）+审计一次；接受但无证据→保持；Key 撤销后读仍可见且不释放（可见性≠释放）；客户端离开（取消调用不等候结果）结论仍按证据落；重放不重放供应商调用；cancel-unknown 后 17.6 终态 usage 照常结算（writer 允许 unknown→settled）。

**验证**：`TEST_DATABASE_URL=…bf21 bun test server/tests/async-cancel-semantics.integration.test.ts`；server typecheck；`cd bifrost/framework/jobaccounting && go test ./...`（回归）；biome lint。

## Task 3 — #332 B17.8 任务状态展示与归属不变

**Consumes**：17.6/17.7 的结算与取消事实（async-terminal 触发行、0207 取消行）、06.12 用户视图先例（/credits/realtime-sessions 路由 + app/src/lib/billing/realtime.ts 查询封装）、08.8 只读核查先例（routes.ts /recovery-items：拒绝审计、只读、无写方法）。

**码表（与 17.1–17.7 实现一致，按所持事实推导）**：
- `queued`：state=dispatch_unconfirmed（派发确认未回，原因 async_dispatch_answer_lost）；
- `running`：state=submitted 且 hold reserved、无终态触发；
- `pending-settlement`：hold unknown（尾部/取消/派发未确认，原因=unknownReason）；
- `settled`：hold settled（金额=applied）；
- `cancelled`：取消行结论 released_on_evidence（金额=0，原因=证据 reference）；
- `refused`：提交拒绝（17.2 拒绝码；无行——码表成员，列表外）。

**交付**：
- 新 `server/src/billing/async-jobs-view.ts`：本人任务列表读（payer 服务端解析，金额 ×100 整数与 realtime 视图同规）+ 管理员只读读面（任务维度过滤 jobId/status/payer，拒绝审计，无写方法）。
- `server/src/billing/routes.ts`：`GET /credits/async-jobs`（本人）；admin 挂载只读 async-jobs 路由。
- 新 `app/src/lib/billing/async-jobs.ts`（查询封装，不带任何账户参数）+ 页面视图 + 路由 `app/src/routes/_authed/settings/async-jobs.tsx`。
- 新测试 `app/tests/async-jobs-ui.test.tsx`：五种行状态渲染（queued/running/pending-settlement/settled/cancelled）+ 待结算原因 + 金额；请求不含账户字段（越权不可见由服务端归属钉死，UI 断言不发送）；Key 到期（grant revoked）后行仍显示原归属账户。
- 服务端读面归属断言并入 async-jobs 服务端测试（新 `server/tests/async-jobs-view.test.ts` 或并入 cancel 测试——独立文件，driven 登记）。

**验证**：`bun test app/tests/async-jobs-ui.test.tsx`；`bun run --filter app typecheck`；`bun run --filter server typecheck`；`cd bifrost/framework/jobaccounting && go test ./...`；biome lint。

## 收尾

- 三票新测试全部 `node scripts/e2e-add-driven.mjs` 登记 + `node scripts/e2e-coverage-audit.mjs`（no gaps）。
- 报告 `reports/orca-dag-wave3-bf21.md`：逐票 AC 覆盖、验证命令与结果、契约演进记录（audio-path-admission 测试演进、discovery 加法字段、06.11 no_usage 映射论证）、bifrost 零提交口径与 bf12 显式转移清单、遗留与基线红。
- 已知基线红（勿修不报）：以开工跑批核对为准，报告只列本轮相关实测。
