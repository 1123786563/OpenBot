# Orca DAG Wave3 — Bifrost 批次第二轮（bf4 worktree）执行报告

- Worktree：`/Users/wuyongjun/orca/workspaces/OpenBot/bf4`，HEAD = main@3b4a7c68，分支 `1123786563/bf4`，全程未 commit / 未 push。
- 执行日期：2026-10-20。顺序：#266 → #267 → #281 → #283。
- 测试库：`postgres://postgres:postgres@127.0.0.1:5566/bf4`（容器 orca-w3-bf-pg 内新建）。建库后以超户执行 `server/ops/enterprise/roles.sql`，再 `DATABASE_URL=... bun server/scripts/migrate.ts`（迁移链 0..0167 全部应用，168 条）。
- bifrost 子模块：本 worktree 原为未初始化 submodule。沿用 bf3 手法：从主 checkout 共享 module store（`/Users/wuyongjun/trea/OpenBot/.git/modules/bifrost`，pinned e44890f8）本地 bare clone，gitdir 放在本 worktree 专属 `.git/worktrees/bf4/modules/bifrost.git`，checkout e44890f8。**子模块零改动**（`git submodule status` 无 `+`/`-`，`git -C bifrost status` 干净）；#266/#267 均为零改动核验。
- Go 工具链：go.mod 1.27.0，缓存 toolchain 直跑（避开 GOSUMDB 网络）：`GOROOT=~/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64 GOTOOLCHAIN=local GOSUMDB=off GOFLAGS=-mod=mod <toolchain>/bin/go test`。

## 票号勘误（对任务指派文本）

任务 Target 行把 #281 标注为 "B08.3 ledger 已结算但 ack 丢失的重放"、#283 标注为 "B08.6 持续异常告警"。实际 tracker 与编排状态一致为：**#281 = Bifrost 08.6 持续异常告警，#283 = Bifrost 08.8 管理员只读核查视图**（证据：运行目录 `issues/281.json`/`283.json` 缓存标题、GitHub live API、`state.json` 的 bf3 strategy "完成解锁 #266/#267（←265）、#281/#283（←280）"）。任务要求的 "B08.3 重放" 真身是 **#278**（open，blocked，不在本批次）。本报告按票号执行：#266、#267、#281、#283。

## 前置核对

任务指定的 receipts 清单 `docs/plans/2026-10-20-orca-dag-wave3/receipts/wave3-delta-r1/sha256.txt` **不存在**（receipts/ 下只有 bf3/hbc3/mt3.json 三份编排派发回执）。替代做法：开工即对当时全部未提交文件计算 sha256 快照（32 项，见本报告附录），以此为前置基线；下文"我自有增量"均为快照之后的差异。前置增量本体（credit-reservations schema、recovery-provider-query.ts、0165/0166、journal 0164-0166）确认在场且未被本 worker 修改语义（仅 credit-reservations.ts / _journal.json / e2e-bun-suites.json 三个文件在前置改动之上叠加了本批次的追加段）。

---

## #266 Bifrost 07.3 未预留 short-circuit 拒绝语义 — **SATISFIED（零改动）**

bifrost@e44890f8 已交付完整实现：`creditrefusal.go`（五类 reasonCode 闭合词汇表：insufficient_balance / authorization_invalid / price_unknown / cap_not_provable / admission_unreachable；门码→类别的全映射，未识别码落 admission_unreachable 不开第六类）+ `creditrefusal_test.go`（拒绝以 LLMPluginShortCircuit 返回、AllowFallbacks=false 断言 fallback 链停止、五类码两两可区分、无 dispatch 承诺/无结算写入（预留未 stamp + refused 标记使 PostLLM 记账为零，含对照组证明 fixture 可测）、响应序列化不含 service secret / Bearer / 他人账户数据 / 他人 reservationId）。

**证据**（命令先 `cd $(git rev-parse --show-toplevel)`；Go 从仓库根进入 bifrost/plugins/governance）：
- `go test -run 'ShortCircuit' ./...` → ok，exit 0（票面 Verification 命令）。
- `go test -run 'CreditRefusal' -v ./...` → 10 条全 PASS（含五类码、fallback 停止、零结算、脱敏四组），exit 0。
- `go test ./...`（governance 全包）→ ok 15.9s，exit 0（回归）。
- `bun run --filter server typecheck` → exit 2，仅 main 既有的 `scripts/bootstrap-local-gateway.ts` 3 处 TS2339（与 bf3 报告一致，非本批次引入；本票零改动无 lint 对象）。

## #267 Bifrost 07.4 dispatch 承诺持久化与幂等 claim — **SATISFIED（零改动）**

bifrost@e44890f8 已交付：`dispatchcommitment.go` + `dispatchcommitment_test.go`。承诺记录含 { attemptId, reservationId, provider, model, claimedAt } 及恢复所需归属/预留信息（GrantID/PayerKind/PayerID/MaximumCredits/SnapshotVersion/RateVersion + 重试链坐标）；claim 以 attemptId 为幂等键（首次写盘 claimed=true，重复返回既有记录 claimed=false → DecisionDispatchAlreadyClaimed 拒绝二次派发）；store 未接线或写失败一律拒绝派发；pending 承诺不自动重发（ListPending 是 08.x 恢复扫描缝）。四条 AC 各有专属测试：`TestDispatchCommitmentClaimedBeforeDispatchCarriesRecoveryBasis`（先写承诺后派发+恢复基线）、`TestDispatchCommitmentDuplicateClaimReturnsExistingAndBlocksSecondDispatch`（幂等）、`TestDispatchCommitmentSurvivesRestartPendingAndBlocksRedispatch`（崩溃点注入：承诺后未派发，重启不重复派发）、另有 store 失败拒绝派发与并发 claim 单赢家两条加固。

**证据**：
- `go test -run 'DispatchCommitment' -v ./...` → 6 条全 PASS，exit 0（票面 Verification 命令）。
- `go test ./...`（governance 全包）→ ok，exit 0（同 #266 的一次运行覆盖）。
- `bun run --filter server typecheck` → 同 #266（3 处既有错误，零新增；零改动无 lint 对象）。

## #281 Bifrost 08.6 持续异常告警 — **SATISFIED（已实施）**

main 无等价实现（server/src/billing 全目录无告警模块；`recovery-alerting.test.ts` 不存在）。Consumes：RecoveryItem 的 `failure_count`（08.4 计数、08.5 仍未知时 +1）与 `last_reason` 稳定码。"现有告警/通知接线"在 billing 域不存在——以可注入 `AlertSink` 缝隙交付，默认 sink 为稳定码运维日志行。

**交付物**：
1. `server/src/billing/recovery-alerting.ts` — 告警规则与事件模块。双触发（failureCount ≥ 阈值 或 停留 ≥ 时限，任一即触发）；三级阶梯 first → repeat（去重窗口外的再提醒）→ escalated（自首次告警起算的升级，一次性、终态不再重发）；`decideAlertTransition` 纯函数承载阶梯规则（可无 DB 单测）；告警事件含归属账户（写入时即掩码 `maskAccountRef`）、金额上限、停留时长、失败次数、最近原因（闭合稳定码）——不含凭据、不含他账数据、不含供应商应答原文；告警只写 `credit_recovery_alerts`，不碰预留/条目/台账/outbox（AC4 由结构保证并有测试钉住）；阈值全部可配置（默认 3 次 / 6h / 1h / 24h），非正整数拒绝构建。
2. `server/src/db/schema/credit-reservations.ts` — 追加 `credit_recovery_alerts` 表（itemId 唯一索引=持久去重锚；level/trigger CHECK；escalated 与 escalatedAt 成对 CHECK；alertCount ≥ 1）。
3. `server/drizzle/0167_recovery_alerts.sql` + `server/drizzle/meta/_journal.json` — 迁移 idx 167（expand-only），已在 bf4 库应用。
4. `server/tests/recovery-alerting.integration.test.ts` — 9 条集成测试（真实 PostgreSQL + 可控时钟 + 记录型 sink）：双轴触发、去重（同进程与"重启"跨实例）、repeat→escalate→终态静默、升级自 firstAlertedAt 起算、脱敏断言（全量账户键/他账键/Bearer/sk- 均不出现在序列化事件与行）、告警全阶梯跑完后预留/条目逐字节不变且 ledger/outbox 零增量、纯函数阶梯、非法配置拒绝。**文件名按家族惯例带 `.integration` 后缀**（需 TEST_DATABASE_URL，与 08.1/08.2/08.5 一致；等价于票面 `recovery-alerting.test.ts`）。
5. `docs/verification/e2e-bun-suites.json` — 注册该测试（分组 + 扁平清单）。

**证据**：
- `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf4 bun test server/tests/recovery-alerting.integration.test.ts` → 9 pass / 0 fail，exit 0（连跑 4 次全绿，跑后库内零残留）。
- `bun run --filter server typecheck` → exit 2，3 处既有 bootstrap 错误之外 0 新增。
- `bunx biome lint --error-on-warnings`（3 个改动源文件）→ exit 0；`bunx biome format` 已应用。
- `TEST_DATABASE_URL=... bun scripts/db-drift-check.ts`（server/ 下）→ 78 problems **全部为 main 既有的"schema 声明但迁移从未创建"**（enterprise_purge_audit 等 9 表，源头 enterprise-purge-restore.ts 等已提交 schema 文件，非本批次触碰）；本次新增 credit_recovery_alerts 无任何 drift 报项。建议对该 main 级 drift 单独立票。
- 回归：recovery-scan + recovery-unacked-replay + recovery-provider-query → 27 pass / 0 fail，exit 0。

**依赖说明**：08.4（重试调度，#279）main 未实现，本票按"规则+事件+持久状态"契约落在 08.1/08.5 已交付的 failure_count/last_reason 原语上，不消费也不阻塞调度切片；sink 未接真实通道（域内无既有接线），缝隙即接线点。

## #283 Bifrost 08.8 管理员只读核查视图 — **SATISFIED（已实施）**

main 无等价实现（admin 路由无 recovery 读取面；`admin-settlement-review.test.ts` 不存在）。

**交付物**：
1. `server/src/billing/routes.ts` — `createBillingAdminRoutes` 新增 `GET /api/admin/billing/recovery-items`：未解决项按状态+停留时长排序（claimed 先、同状态最久先），逐项含归属账户（payer 层不透明键）、金额上限、停留时长（服务端计算 dwellSeconds）、失败次数、最近原因稳定码、状态，及 08.5 证据摘要（每项最新 5 条：结论/来源/摘要/用量对/时间）；**严格只读**（该路径无任何写动词路由，POST/PUT/PATCH/DELETE 全 404，有测试钉住）；非管理员经 requireAdmin 拒绝且**拒绝写审计**（新增 eventType `billing.recovery.review_denied`，payload 仅路径名，不含任何账户数据；成功读取不写审计——读面保持零账务副作用）；无 database 接线时 503 而非假空。
2. `server/src/audit.ts` — 审计事件闭合类型追加 `billing.recovery.review_denied`。
3. `app/src/components/admin/billing-recovery-review-card.tsx` — 只读核查卡片（loading/error/空态/清单；逐项渲染归属账户、上限（÷100）、停留、失败次数、原因码、证据行与结论徽章；无任何按钮/表单/mutation；页脚明示只读）。
4. `app/src/routes/_authed/admin/billing.tsx` — 计费管理页新增"异常结算核查" PageSection。
5. `app/src/locales/{zh-CN,en}/{admin,errors}.json` — `recoveryReview.*` 与 `billing.loadRecoveryReview` 文案（双语键集对齐已验证）。
6. `server/tests/admin-settlement-review.integration.test.ts` — 4 条集成测试：管理员可见全部异常项+证据+排序；严格只读（预留/条目/ledger/outbox/alerts 全快照不变 + 写动词 404）；非管理员 403 且审计行在（按本 run 唯一 member id 断言，免疫 append-only 残留）、未认证 401；响应无凭据形状（Bearer/sk-/Authorization）。**文件名带 `.integration` 后缀**（需 TEST_DATABASE_URL；等价于票面 `admin-settlement-review.test.ts`）。
7. `app/tests/admin-settlement-review-ui.test.tsx` — 3 条 bun 层 UI 测试（沿用 admin-credit-grant-ui 形状）：字段渲染（含 5.00 换算、3h 5m 停留、证据结论与 900/210 用量）、裸 GET-only + 页面零按钮、空态/失败态文案。
8. `docs/verification/e2e-bun-suites.json` — 注册上述两测试文件。

**证据**：
- `TEST_DATABASE_URL=... bun test server/tests/admin-settlement-review.integration.test.ts` → 4 pass / 0 fail，exit 0（连跑 4 次全绿；与 alerting 套件同进程合跑 5 次全绿，跑后零残留）。
- `TEST_DATABASE_URL= bun test app/tests/admin-settlement-review-ui.test.tsx` → 3 pass / 0 fail，exit 0。
- `bun run --filter server typecheck` → 3 处既有错误之外 0 新增；`bun run --filter app typecheck` → exit 0。
- `bunx biome lint --error-on-warnings`（全部 9 个改动文件）→ exit 0。
- 回归：`admin-credit-grant.integration`（11 pass）、`admin-credit-grant-ui`（7 pass）、credit-views + settle-idempotency + billing-credits-writer + recovery 三套件（85 pass），全部 exit 0。

---

## 我自有增量（快照之后的差异）与 sha256

新增文件（6）：
```
e578fb8f7ad30a105ad4741c2ce23c179ca8a8db27b31fb43f18dff0e73f1a34  server/src/billing/recovery-alerting.ts
343ca55f2bdb3c6065fb20ef90e719fd60fbb08a01a71786d0c837b9b25b9863  server/drizzle/0167_recovery_alerts.sql
6a6fc48a58c1e9786a087dadb15d0b86510d9f8044914ea7230b224af1828a83  server/tests/recovery-alerting.integration.test.ts
833861d768a19f69caea1e5bb261b6ec6d6d264db649bcb175561a0d6bb71c10  server/tests/admin-settlement-review.integration.test.ts
321457d0754dffb0d6a42faf825165ae70a99818c18b7a88fac36983f76a4a21  app/tests/admin-settlement-review-ui.test.tsx
ff0cf8e179cd7dfba1bdff2497868a010193fd146ceb4931ed5d9552e036d187  app/src/components/admin/billing-recovery-review-card.tsx
```

修改文件（10，当前 sha；其中标 ★ 的三个同时承载前置增量，前置基线 sha 见下）：
```
344558bd238137d51a85e96401f7527d7024460f0192fd0b5ec427fa621bb320  server/src/billing/routes.ts
5b561aa0a47bbe512604d796e13fa0c14be7a0d5a2f62d031d7306d6d7647452  server/src/audit.ts
3752b869ee12f48fe2e81dbae67beafb4b55d176de2bc392e723442fbe7afb62  app/src/routes/_authed/admin/billing.tsx
3e8c910ba390e2a8896b9ca6ac657b8989b475dbf99355a3becf1ae74c7f9c07  app/src/locales/zh-CN/admin.json
aa70a1a43106c91f5c2e6ae078b6ffe7e3685564edf6f885506c2d07eb1a91fd  app/src/locales/en/admin.json
999eaf041f3e76b8ce387c954397c2802170954c303dde19b8db62886fe3f93a  app/src/locales/zh-CN/errors.json
2ee67ec2b3ba2713e252f3da4570966f2a510f49bd145af42488a7c448c0d43a  app/src/locales/en/errors.json
15558e5b8bfc4511e7cab5cc13f6e68c0780b3fa96827041f60f6af950ce8724 ★ server/src/db/schema/credit-reservations.ts
e174ac1dc51bd4ae25f3a58bb96591949b63a32ebc3994c4f4004f1afc558d95 ★ server/drizzle/meta/_journal.json
be65a0d4893fb7047b13692264c1f843f04de90dd0a377e2534762eb87b13732 ★ docs/verification/e2e-bun-suites.json
```
★ 前置基线（开工快照）sha：
```
e2b9dc46194297023270909e9d5b25f797b22a22240c4d1f56dea1d2209f56e1  server/src/db/schema/credit-reservations.ts
b695a9f151837dc953b7562fd3b90363d42ecef056eb03d37113201113d7f9aa  server/drizzle/meta/_journal.json
827e765c4388cf95996229131b4bcb6015bfeea3a23c6370b11eb5d8132210c9  docs/verification/e2e-bun-suites.json
```
本批次在这三个文件上的差异仅为追加段：credit-reservations.ts 追加 `creditRecoveryAlerts` 表；journal 追加 idx 167；bun-suites 清单追加本批次 3 个测试文件（分组 + 扁平两处，`directoryIslands` 顺序与前置基线保持一致）。其余 22+14 项快照内文件未改动。

## 遗留与移交

- **票号标签勘误**：见文首；B08.3（#278）仍 open/blocked，不在本批次。
- **main 级 db drift**：9 个已声明表（enterprise_*、billing_company_manage_grants）无迁移创建（#436 同类），建议单独立票；本批次新增表无 drift。
- **main 级 typecheck 红**：`server/scripts/bootstrap-local-gateway.ts` 3 处 TS2339（bf3 报告已记录，gateway probe 线）。
- **测试名后缀偏差**：#281/#283 票面测试名无 `.integration` 后缀，按家族惯例与 TEST_DATABASE_URL 依赖落为 `.integration.test.ts`（bf3 #280 同款先例）。
- 环境产物（非代码增量）：bf4 测试库、worktree 专属 bifrost submodule gitdir（.git 下，内容零改动）、根 node_modules（bun install --frozen-lockfile，锁文件未变）。
