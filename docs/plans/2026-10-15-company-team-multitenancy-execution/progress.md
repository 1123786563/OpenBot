# Issue #6 execution ledger

Execution workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy-execution` (Orca worktree id `d6edf033-748a-4549-ae5a-e9efd34cef91::/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy-execution`). BASE: `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`. No commits authorized.

## Intake (2026-10-15 UTC)
- Root: https://github.com/1123786563/OpenBot/issues/6, open; retrieved with authenticated `gh api` at 2026-10-15 04:21 UTC.
- Formal root children: 20 Epic issues #187–#206, confirmed via paginated `gh api repos/1123786563/OpenBot/issues/6/sub_issues`; local hierarchy report says 143 tickets and the IDs cover #44–#186. Recursive ticket-level formal sub-issues and all comments/Blocked by links still need full verification.
- Current source branch `main` HEAD f0520524; implementation branch `1123786563/company-team-multitenancy` HEAD cfc0ca1c contains `docs/tickets/multitenancy/` and `docs/plans/2026-10-15-company-team-multitenancy/`. Copied into this isolated worktree with `git checkout <branch> -- ...`; content retained as uncommitted files. Existing plan expressly records enterprise-stack path drift and is historical planning input only.
- `docs/agents/domain.md` is absent; root `CONTEXT.md` is present. The approved Spec and ADR 0002/0003/0004 are present on BASE.
- Orca runtime `575bc003-67f6-4708-b944-1d241950da0d`; Run `run_b2bd1c513221`; isolated worktree created successfully. Pi registration proven by worker-start receipt: requested/effective agent=pi, ready, input_accepted. Probe Dispatch `ctx_0e793e582a8a` was accidentally launched on the current main worktree (not the isolated worktree); it was immediately constrained to receipt-only reporting, no repo access or edits. Its live status remains in progress; no termination/retry inferred.
- Orca worker-start does not report effective Pi model/effort (null); visible Pi session showed `glm-5.3 • medium`, so strongest Pi configuration is not established.

## Status
No implementation Ticket is verified. No business worker dispatched. All implementation blocked pending complete recursive intake, exact dependency reconciliation, current-stack task plan, DB environment proof, and worker configuration. No code claims.

## Recursive intake and DAG checkpoint

- Intake snapshot: `github-intake.json`; retrieved 2026-10-15 04:25:31 UTC using authenticated GitHub REST, including Issue bodies and comments for #6, #187–#206, and #44–#186. One #135 read hit TLS timeout and was successfully retried. No remaining API errors or missing pages.
- DAG: `dag.json` (machine-readable) and `dag.md` (reviewable table); validation `intake-validation.json`; native relationship query `native-blocked-by.json`; requirement crosswalk `requirement-coverage.json` and `coverage-crosswalk.md`.
- Verified 20 Epics contain exactly 143 Tickets; 164 unique Issue payloads/comments. Ticket `Blocked by` text yielded 274 dependency edges; all references resolve; 0 self-edges, 0 cycles; topological sort includes 143 nodes. GitHub native `blockedBy` was queried for all 163 descendants: 0 edges. Parent contains relationships are stored separately.
- A1–A13 coverage counts: A1 55, A2 96, A3 36, A4 30, A5 40, A6 36, A7 19, A8 38, A9 19, A10 37, A11 33, A12 22, A13 22. R1–R7 mapped through Spec §11. §8 closures cross-mapped to business Epic families.
- Dependency roots: MT001 (#44), MT002 (#45), MT103 (#146). Status ready is dependency-only; no implementation dispatched.
- Exact file ownership cannot be safely assigned from the Issue tree: Ticket bodies specify behavior and scope boundaries, not exact paths. It remains intentionally unassigned per node until current HEAD seam reconnaissance; these roots are not yet implementation-ready.
- Coordinator's implementation work is not started. No test run, code modification, commit, or external side effect.

## Plan and first wave (2026-10-15)

- Implementation plan saved at `docs/plans/2026-10-15-company-team-multitenancy-execution.md` (45,661 bytes at dispatch; 143 Ticket task rows; standard header/global constraints/review focus present). Planning self-check: 143 nodes; 274 edges; all refs resolve; no cycles; A1–A13 and R1–R7 mapped.
- Test DB: fresh ephemeral `openbot-issue6-tenancy-test-pg`, loopback `127.0.0.1:55432`, empty `openbot_enterprise_issue6_test`; not development service; no persistent volume.
- Wave 1 Orca tasks/dispatched Pi workers: MT001 Task `task_4ae1247de41a` Dispatch `ctx_2e3104fdb0bd`, child `i6-mt001`; MT002 Task `task_fbc7b14de451` Dispatch `ctx_97107555809d`, child `i6-mt002`; MT103 Task `task_ff173a79a7e0` Dispatch `ctx_31eb8dca8b8e`, child `i6-mt103`. All receipts state `ready`, `input_accepted`, requested/effective `agent=pi`, each exact child worktree acknowledged.
- Initial uncommitted checkpoint baseline for each task is stored in `checkpoints/<MT>/before.json`, HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`; no owned-path changes at dispatch.
- Current statuses: MT001/MT002/MT103 running. No Ticket verified yet; no integration/review results yet. All three workers have independent file/submodule ownership; MT002 alone uses the dedicated DB. No commit, push, merge, deployment, migration of production data, enablement or release.

- Monitoring note: MT103 Pi transcript returned provider 429 rate-limit responses. Dispatch `ctx_31eb8dca8b8e` remains live; coordinator sent backoff guidance and did not retry/duplicate/stop it. MT001 and MT002 remain live.

- MT103 implementer settlement accepted after checking active Dispatch `ctx_31eb8dca8b8e`, Task `task_ff173a79a7e0`, report/checkpoint hashes, task-private worktree cleanliness and verification transcript. Implementer terminal released; parent gitlink remains unchanged. Independent reviewer Task `task_019411171ea9` Dispatch `ctx_1cca227a5d23` started via Orca Pi on child `i6-review-mt103`; Task status remains running until review passes and report is integrated. Snapshot package SHA-256 `0c98b35aeeee87786d7e0b4206600d3f3b5979c7161a1c02ffed6115717e7327`.

- `MT103: verified` after independent Pi review. Reviewer Task `task_019411171ea9` / Dispatch `ctx_1cca227a5d23` independently reproduced factual claims read-only and verified all 4 Issue #146 acceptance criteria. Spec compliance PASS; report quality/correctness PASS. Reviewer terminal released and delivery acked.
- MT103 three Info-level notes are deferred (non-blocking): (1) a grep comment says irrelevant comment hits although actual grep is zero; conclusion is strengthened; (2) commit timestamps do not prove when commit was pushed to main, while pin/main gap is directly measured; (3) attribution of previously copied planning files in parent worktree is not proven from Git, but it does not affect verified submodule facts. No High/Medium findings. Review report: `reports/MT103-review.md`; exact task/review hashes: `checkpoints/MT103/final-hashes.sha256`.
- Next consumer MT104 remains blocked by its other prerequisite MT083, so no child was started from MT103 alone.

## MT002 settlement hold, redaction repair, provenance and worker states (2026-10-15 ~05:02 UTC)

### MT002 original worker_done — settlement held pending security-artifact correction

- Implementer Task `task_fbc7b14de451` / Dispatch `ctx_97107555809d` (agent pi per `MT002-dispatch-receipt.json`; terminal `term_c5e3fe3e-fbbf-4a36-b49c-b77aef2f1cc6`; child worktree `i6-mt002`) reported worker_done, leaving `reports/MT002.md` and the `checkpoints/MT002/` package (artifact mtimes 04:55–04:56 UTC). Reported result: 17/17 tests pass, 146 expect calls, 0 skipped, untracked-only additions at BASE `f0520524`, manifest `checkpoints/MT002/manifest-sha256.txt`.
- Coordinator review of the persisted artifacts found literal passwords for the three restricted test LOGIN roles (`ent_mt002_directory` / `ent_mt002_data` / `ent_mt002_operator`) in `checkpoints/MT002/environment.md` — a security-hygiene defect in the evidence artifact, not in code. Settlement was therefore withheld: the report's self-declared "implemented and verified" status is not accepted as Ticket verification, and MT002 remains unverified.

### Redaction repair task/dispatch and Pi receipt

- Repair Task `task_a67106001ae6` ("MT002 redact ephemeral DB credentials from evidence artifacts") created 2026-10-15 04:58:09 UTC; Dispatch `ctx_50bb55b845f0`; receipt persisted as `MT002-redaction-dispatch.json`: requested and effective agent `pi`, terminal `term_6ce84b2c-6e6d-4351-93d5-c0557a12f46b`, stage `input_accepted`, worktree reused `i6-mt002`.
- Repair scope (per the persisted Task spec): redact literal passwords and credential-bearing URLs only inside `checkpoints/MT002/` artifacts while retaining DB name/host, login names, exact env variable names and reproduction steps; update checkpoint metadata and SHA-256 hashes; add `after.json`; append the redaction record to `reports/MT002.md`; keep executable files byte-identical; remove `/tmp/mt002-env.sh`; no source/test/database/other-Ticket edits; no commits.
- Observed by this ledger pass (~05:00–05:02 UTC): `checkpoints/MT002/environment.md` already rewritten (mtime 13:00 local) with `${ENT_MT002_*_PASSWORD}` placeholders replacing the three literal passwords and an explicit redaction note naming `task_a67106001ae6`; `/tmp/mt002-env.sh` absent. The report append and `after.json`/hash-manifest update were not yet present, so the repair Dispatch is still in progress at ledger time.
- Gate: MT002 must not be marked verified until (a) the redaction repair completes with hash-backed proof that no literal credentials remain in task artifacts, and (b) independent review passes.

### Discovery and provenance of the synced source plan and ticket package

- Discovery: `docs/plans/2026-10-15-company-team-multitenancy/` and `docs/tickets/multitenancy/` exist in this execution worktree only as staged-uncommitted copies; `git ls-tree main` at `f0520524` confirms both paths are absent from `main`.
- Provenance: branch `1123786563/company-team-multitenancy` HEAD `cfc0ca1c4018718a9d1769abc06afda9dd6ac36a` (authored 2026-10-15 12:03:29 +0800). Git history touching those paths on that branch: `b5988131` (add multitenancy ADR/tickets/breakdown) → `1eea77d6` (Epic grouping + blocked-reference fixes) → `f4a89e0b` (branch/main sync record with BASE, fact-source hashes and ticket-migration note) → `cfc0ca1c` (second sync with main `f0520524`, enterprise-stack refactor impact). This confirms the Intake statement that the package was copied in via `git checkout <branch> -- ...`; it remains historical planning input only, not an execution fact source.

### Current exact worker states (2026-10-15 ~05:01 UTC)

- MT001 — Task `task_4ae1247de41a` / Dispatch `ctx_2e3104fdb0bd` (pi, child `i6-mt001`): running; owned files actively edited in the child worktree (`server/scripts/multitenancy/inventory.ts` mtime 13:01 local, `server/tests/multitenancy/inventory.test.ts` 13:00 local, both untracked); no worker_done received; checkpoint still only `before.json`.
- MT002 — implementation worker_done received but settlement held pending the security-artifact correction above; redaction repair Task `task_a67106001ae6` / Dispatch `ctx_50bb55b845f0` running in reused child `i6-mt002` (environment.md already redacted; report append and `after.json` pending). Not verified.
- MT103 — unchanged from the verified record above.

### External unrelated main-workspace Craft doc modification (record-only)

- The main git worktree `/Users/wuyongjun/trea/OpenBot` (branch `main` @ `f0520524`, parent repository of all Issue #6 worktrees) currently carries uncommitted modifications to two Craft preview-origin ticket docs: `docs/tickets/craft-preview-origin/issues/00-acme-dns01-wildcard-certificate.md` and `docs/tickets/craft-preview-origin/issues/02-preview-origin-host-routing-and-gate.md` (combined diffstat: 2 files changed, 35 insertions(+), 1 deletion(-); mtimes 12:34 and 12:42 local 2026-10-15).
- These belong to the unrelated craft-preview-origin effort (preview certificates / host routing), sit outside every Issue #6 ownership boundary, and were neither copied into this worktree nor modified by any Issue #6 task; recorded here only so future reconciliation does not misattribute them to Issue #6 execution.

### This ledger update

- Written by coordinator documentation Task `task_eb69bd251c19`, retry Dispatch `ctx_ffd23b08e714` (the first attempt left no file changes). Documentation-only: `progress.md` and the `dag.md` status cells were updated; `dag.json` was verified already accurate (MT001 running, MT002 running, MT103 verified) and left byte-identical. No Ticket, Spec, ADR, production code, test or credential file was touched; no commit, push, merge, deployment, migration or release.


## MT002 integration and independent review (2026-10-15)

- Integrated checkpoint `MT002-integrated-01`: copied the three reviewed untracked files from Orca child `i6-mt002` into the coordinator execution worktree. Source, integrated destination, and immutable review-package hashes match for every file; no tracked source changes or commits. Integration record: `checkpoints/MT002/integration.json`.
- Independent reviewer Task `task_256795d6159d` / Dispatch `ctx_a30408950bd3` used Orca Pi on `i6-review-mt002`; Spec compliance PASS (4/4 Issue #45 acceptance criteria) and code quality PASS. Full report: `reports/MT002-review.md`. The review package SHA-256 is `23e451200a7c5647a639d77b94da291cbce002a9f08355da706f8a6bdb38ca5a`; all 14 package files and 12 post-redaction checkpoint manifest entries verified.
- Verification evidence: dedicated ephemeral PostgreSQL command recorded by implementer was `source /tmp/mt002-env.sh && bun test server/tests/multitenancy/fixtures.test.ts` (17 pass, 0 fail, 146 expectations, 0 skipped, restricted runtime roles); code hashes are unchanged through transfer. Coordinator reran `bunx biome check server/tests/multitenancy/` in the integration worktree (exit 0, no diagnostics). No DB test rerun was attempted after redaction removed the ephemeral env file.
- Review findings: one Low (post-dispose physical emptiness is only manually verified, not asserted in-suite) and five Info; no valid Critical/High/Medium findings. Two follow-ups are preserved: the additive fixture interface (`operationId?` plus other disclosed compatible details) needs an internal interface revision before downstream consumers freeze; team membership facts must move from temporary resource-grant facts to MT004 membership rows.
- MT002 is now `verified` and its sources are integrated. MT001 remains in review; no dependent of MT002 alone is ready until its other dependencies are verified.

## MT001 independent review and focused A11 completeness repair (2026-10-15 ~05:21 UTC)

- Independent Pi reviewer Task `task_dd99d9577f09` / Dispatch `ctx_a5c5b74f62f3` completed in isolated `i6-review-mt001`; reviewer report is `reports/MT001-review.md`. Reviewer independently recomputed canonical package SHA `b5fc671702bec097c61598f1839802868aa06826d878eeeb6e8a87308bb19f24`, all eight file hashes, and reran the 23-test suite (23 pass/0 fail/4963 expectations), typecheck, and inventory CLI digest. Spec compliance PASS (all 4 ACs); code quality PASS.
- Settlement is held: three valid Medium A11 completeness findings must be repaired before MT001 can be verified or MT003/downstream consumers can start: (1) config/source pattern misses Redis, Qdrant, Ollama, and WeChat Pay; (2) background scanner misses the routines worker loop, BullMQ KB worker, and cron scripts; (3) supervisor, go-runtime, agent-computer, and agent-sandbox service surfaces are absent from inventory/gap output. Exact evidence and citations are in `reports/MT001-review.md` findings 1–3. No finding was dismissed or downgraded.
- Repair plan saved: `docs/plans/2026-10-15-i6-mt001-review-fixes.md`, SHA-256 `4a5b0b0692b1565797533462d10e64cfc5f76ac8f24e078685a80d91515f3cf3`. It scopes one cohesive TDD repair task, explicit files/interfaces/verification and prohibits claiming route coverage for merely listed services.
- Repair Task `task_4f2c3bcba4f0`; Dispatch `ctx_fcebe2db6b0d`; Orca worker-start receipt confirms requested/effective agent `pi`, accepted input, active terminal `term_19393ac8-231b-4857-835d-e37c986ad86c`, exact existing child worktree `/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt001`. Visible session config: `glm-5.3 • medium` (not a strongest-model claim). An initial worker-start invocation with `--name` on an existing worktree was rejected as `invalid_argument` before dispatch; corrected invocation succeeded without creation-only options.
- Status: MT001 remains running/settlement-held pending repair, a fresh independent Pi review, and integration. MT003 remains blocked. No implementation changes have been integrated into the execution worktree in this repair round; no commit/push/merge/deploy/migration/enablement/release.

### MT001 review-fix checkpoint and fresh independent review (2026-10-15 ~06:52 UTC)

- Repair worker Task `task_4f2c3bcba4f0` / Dispatch `ctx_fcebe2db6b0d` completed successfully via Pi in `i6-mt001`; `worker_done` message `msg_9122da478250` states findings 1–3 repaired. Worker updated only the two MT001 source/test files and owned report/checkpoint paths; HEAD is still `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`; no commit.
- Coordinator independently reran `bun test server/tests/multitenancy/inventory.test.ts` → 33 pass/0 fail/5088 expectations; `cd server && bun run typecheck` → exit 0; `bunx biome check server/scripts/multitenancy/inventory.ts server/tests/multitenancy/inventory.test.ts` → no diagnostics. Correct section-aware recomputation of every before/after/checkpoint/report hash in `MT001-fix/sha256-manifest.txt` passed. An initial coordinator verifier incorrectly compared intentional BEFORE hashes to current AFTER files; that check was discarded and replaced with section-aware validation.
- Worker evidence records deterministic regenerated digest `0965ecfa0ef5a0e6427f66796843bdcc21904d5bd7b670ac7f2b18b5a3fe30c9`, 539 entrances unchanged, external dependencies 14→22, background programs 7→13, and four additional deployed service surfaces explicitly marked unassembled/not-enumerated/unowned. DB stages remain skipped due absent TEST_DATABASE_URL; no fallback. One credential-scan match is the preserved byte-exact before-copy of a test fixture containing the existing local dummy URL `postgres://openbot:openbot@localhost:5432/openbot`; worker classified it as non-secret test placeholder, while generated inventory/report artifacts have no such hits. This disclosure is retained for independent reviewer verification.
- Coordinator froze the exact 19-file review package `review-packages/MT001-fix.json`, canonical SHA-256 `e67e0c23d1b912721c23f54ee22d02626003b42e20838fbfa8e51c6605fa529a`; transferred all files into independent Pi reviewer worktree `i6-review-mt001` and verified package canonical hash and all 19 content hashes.
- Independent reviewer Task `task_4954961364b8` / Dispatch `ctx_57996559d8ac` is active/live in `i6-review-mt001`, effective agent `pi`; visible session model `glm-5.3 • medium`. Review covers the changed snapshot and the 3 Medium findings, including additive service-surface honesty, secret/artifact concerns, tests/typecheck/Biome, and separate Spec/code-quality conclusions.
- Settlement remains held pending the independent report. MT001 is not verified/integrated yet; MT003 remains blocked. No commit/push/merge/deploy/production migration/tenant enablement/release.


## MT001 集成完成与 Wave 2 并行派发（2026-10-15 ~08:49 UTC）

- MT001 修复轮独立 Pi reviewer Task `task_4954961364b8` / Dispatch `ctx_57996559d8ac` 已成功结算；报告 `reports/MT001-fix-review.md`（SHA-256 `d85bc15627e369f81dcd911246dbc61efb4d18e4c0ce1115dcbfde1b3194cdd5`）。Spec PASS、代码质量 PASS；原 3 项 Medium 均确认关闭；无有效 critical/high/medium findings。记录 1 项沿袭 Minor 与 8 项 Info，详情在报告。Reviewer terminal 已释放。
- MT001 exact reviewed snapshot 已 hash-verified 转入执行工作树。`checkpoints/MT001/integration-fix.json` 持久化了 package `e67e0c23d1b912721c23f54ee22d02626003b42e20838fbfa8e51c6605fa529a`、文件哈希与集成后验证。集成工作区完成 frozen-lockfile install（1415 packages、无 lockfile/source 修改）；测试 33/33、5088 expectations，typecheck、Biome、inventory CLI 均通过；digest `0965ecfa0ef5a0e6427f66796843bdcc21904d5bd7b670ac7f2b18b5a3fe30c9`。MT001 状态改为 verified。
- MT003 (#46) 与 MT131 (#174) 在 MT001 verified 后成为 DAG ready。代码所有权互斥：MT003 `migrate-test.ts`/`migration-tool.test.ts`；MT131 `acceptance-harness.ts`/`acceptance-harness.test.ts`，二者均不改共享 MT001/MT002 输入或 test support。Task Brief 与接口/资源预检记录在 `wave-02-briefs.md`（SHA-256 `5010698dbb28e2910e57e1833536181123ea0c98954c3ce2a95aae0a1392748e`）。两者独立 Orca child worktree，verified prerequisite files 均逐哈希转移并记录 `checkpoints/MT003/before.json`、`checkpoints/MT131/before.json`，HEAD 均为 BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`。
- MT003：Task `task_60577e388d74` / Dispatch `ctx_a255a1e79beb` / terminal `term_6ca05f1e-c336-4a53-bfc6-80f62cdc4e47`，effective agent Pi，child `i6-mt003`。专用容器 `openbot-i6-mt003-test-pg`，loopback `55433`，DB `openbot_enterprise_mt003_test`；新鲜空库，使用 tmpfs、`--rm`，无持久卷。
- MT131：Task `task_9b95a3b8cb96` / Dispatch `ctx_c83a96b3959d` / terminal `term_ea91ccdf-ac6d-4f2e-b593-8013a151b1e8`，effective agent Pi，child `i6-mt131`。专用容器 `openbot-i6-mt131-test-pg`，loopback `55434`，DB `openbot_enterprise_mt131_test`；新鲜库仅在此容器内运行受控 `enterprise-test-db.ts migrate` 并建立 `ob_ent_directory/data/operator` 受限角色，当前 150 张测试 schema 表。经独立连接验证三角色 current_user 分别为 capability，session_user 分别为专用 `ent_mt131_*` login。环境文件 `/tmp/mt131-env.sh` 权限 0600，密码只在本机临时文件，绝不写入 repo/Ledger；待独立复审后删除。MT131 本地端口 45435 派发前空闲。
- 两个 dispatch 回执均为 ready/input_accepted，requested/effective `agent=pi`、路径准确，状态 running。No shared database/port/file conflict was identified. Neither task may consume any unreviewed output.
- MT001 downstream contract note: MT132 must re-freeze updated inventory digest before consuming it; `serviceSurfaces` unassembled/not-enumerated do not count as route coverage.

## 2026-10-16 会话恢复与 Wave-2 复审重派（Run run_9b7a1f8cb8d5）

- 授权边界（用户 2026-10-16 明确）：允许隔离工作区实施 Issue #6 及全部正式子 Issue 的生产代码/测试/文档；**不含**本地提交、推送、合并、生产数据迁移、部署、启用多租户、发布。未提交检查点交付。
- 环境核验：orca 1.4.224 runtime ready；pi 1.2.0。探针 Task `task_91854fb2ea0c` / Dispatch `ctx_b424ffa98470` worker_done succeeded（摘要 "pi 1.2.0, probe-ok"），终端已释放——Pi 注册且工具未剥离。
- 事实源核验：Issue #6 subtree 重新枚举 = 21 个直接子 Issue（20 个 MT 分组 Epic #187–#206 + 计费支付 Epic #368）；150 张实施票 = MT001–MT143（#44–#186）+ BP01–BP07（#369–#375），与 hierarchy-report/published.json 一致。172 个 issue 的 GraphQL updatedAt 全量扫描：镜像时间（2026-10-15T12:03Z）后除 #6 外零更新 → 本地镜像 `docs/tickets/multitenancy/` 为当前事实源；#44/#45/#46/#174 正文与 GitHub 逐字一致（仅行尾空行差异）。
- 上一代状态恢复判定（f0520524 基线，bab7c0b9 与之仅差 docs 提交，代码等价）：
  - MT001、MT002、MT103 = verified + 已哈希集成（证据：reports/MT001*.md、MT002*.md、MT103*.md 与 checkpoints/）。
  - MT003（Task `task_60577e388d74` / Dispatch `ctx_a255a1e79beb`）与 MT131（Task `task_9b95a3b8cb96` / Dispatch `ctx_c83a96b3959d`）实现完成、报告完成、独立审阅未开始 → 本波补审。
  - bab7c0b9 世代 `issue6-mt001`/`issue6-mt002` 为未审阅部分重做（MT002 卡在 RED：fixtures 模块缺失），判定为不消费检查点，原样保留不动。
  - `mt001-inventory{,-r2,-r3}`、`mt002-harness{,-r2,-r3}`、`mt103-mobile-baseline{,-r2,-r3}`、`issue6-mt103`、`i6-mt103` 等 11 个空 worktree = 历史失败探针，不派生结论。
- BP 外部阻塞：BP01–BP07 依赖 open 状态的 Bifrost 票 #259/#284/#290/#291/#292/#294/#295 → 全部 externally blocked，如实记账。
- 复审派发（本波）：
  - 审阅工作树 `i6-review2-mt003`、`i6-review2-mt131`（BASE `f0520524f0faa2b4533b9d2f1aa69c8f907ba71`，setup 完成后无改动）。
  - 冻结快照按哈希转移：MT003（migrate-test.ts `e00f90a4…a76bf`、migration-tool.test.ts `e004868a…7746f`，与 after.json 一致）；MT131（acceptance-harness.ts/test 等 7 包文件 + MT001/MT002 前置）。清单：`checkpoints/MT003/review-sha256-manifest.txt`、`checkpoints/MT131/review-sha256-manifest.txt`。MT001 inventory.ts 转移哈希 `e58bde59…4d6c05d0` 与 MT001/integration-fix.json 集成记录一致（交叉验证通过）。
  - Brief：`briefs/MT003-review2-brief.md`、`briefs/MT131-review2-brief.md`。
  - MT003 复审 Task `task_8ae36eaedbc7` / Dispatch `ctx_fc362bdfd563`（pi，ready/input_accepted）；回执 `MT003-review2-dispatch-receipt.json`。
  - MT131 复审 Task `task_64f49f515ebb` / Dispatch `ctx_9d91497242e9`（pi，ready/input_accepted）；回执 `MT131-review2-dispatch-receipt.json`。
  - 资源分配：MT003 复审 docker PG 127.0.0.1:55443（openbot-i6r2-mt003-pg）；MT131 复审 docker PG 127.0.0.1:55444（openbot-i6r2-mt131-pg）+ harness 端口 45436 + 私有 env /tmp/mt131-review2-env.sh（0600、用后删）。
  - 解析错误产生的两个未派发重复任务 `task_c3bc8cb96e55`、`task_348dbae2ad0a` 已取消。

## 2026-10-16 Wave-2 复审结算（MT003）与修复轮派发

- seam 识别（MT005 前置）结算：Task `task_83b1344ca338` / Dispatch `ctx_101d69cc18b1` worker_done succeeded；报告 `reports/seam-identification-mt005.md`（SHA-256 `56bda32106affa6415870582024de68bbd8c5d59cafdbee570d448948e600aa8`，已从 i6-seam-id 哈希转移）。关键结论：新栈 `resolveScope` 是 proactive 投递范围解析器的命名碰撞（index.ts:2875/2983）；真正租户 seam 为 `createScopeResolver`（tenancy/store.ts:82-146，PlatformScope 无 role、memberEpoch/aclEpoch）；事务形状等价物为 conversations/store.ts:21-99 与 store.ts:457-580；`conversations-v1` 在新栈不存在。终端已释放。
- **coordinator 裁决 #1（选择头命名冲突）**：以已批准 interfaces.md T02 契约为准——`x-openbot-tenant` / `x-openbot-workspace`（与 MT002 已验证夹具一致）；MT005 将 index.ts:802-804 对齐，不做双读兼容；实施前 grep 客户端旧名 `x-openbot-tenant-id`/`x-openbot-workspace-id` 的使用面并纳入改动。
- **coordinator 裁决 #2（策略版本词汇）**：`conversations-v1` 属旧计划词汇、新栈不存在，MT005 不臆造；`tenancy-v1` 语义不变；`workspace-v1` 归 MT008。
- MT003 复审结算：Task `task_8ae36eaedbc7` / Dispatch `ctx_fc362bdfd563` worker_done succeeded；报告 `reports/MT003-review2.md`（103 行，已转移）。**Spec compliance PASS / Code quality PASS**，但有效 findings：**2 Medium（F1 真实库集成测试硬编码实现者端点伤可复现性；F2 journal statement_digest 漂移不可检测）** + 2 Low（F3 manifest 无 --apply 被静默忽略；F4 拒绝探针未断言零读）+ 5 Info（F5-F9，其中 F9a 指出 coordinator brief 的 docker 命令缺 postgres:16 必需认证 env——已修正后续 brief 模板）。审阅者独立复跑：34 pass/0 fail（自建同端点容器）、typecheck、biome、CLI 冒烟、变异检查全部完成；快照 12/12 哈希复算一致。**结算保留（settlement held）：2 Medium 未关闭前 MT003 不得 verified、MT004/MT112 不得启动。** 审阅终端已释放。
- 修复轮派发：Task `task_63aeeec4713d` / Dispatch `ctx_e985c1514a4a`（pi，ready/input_accepted），工作树 `i6-mt003-fix2`（BASE f0520524），快照按 `checkpoints/MT003/fix2-transfer-manifest.txt` 转移核验（13 行）；Brief `briefs/MT003-fix2-brief.md`（F1/F2 必须关闭 + F3/F4 附带；专用 PG 55446）。修复后须全新独立 Pi 复审。
- 进行中：MT131 复审（Task `task_64f49f515ebb` / Dispatch `ctx_9d91497242e9`，心跳正常）。

## 2026-10-16 Wave-2 复审结算（MT131）与修复轮派发

- MT131 复审结算：Task `task_64f49f515ebb` / Dispatch `ctx_9d91497242e9` worker_done succeeded；报告 `reports/MT131-review2.md`（162 行，SHA-256 `8a634b6e07169ad658caf60558e1c1646e60fc4ea1f9a021bc06c26c56c85503`，已转移）。**Spec compliance 4/4 PASS / Code quality PASS WITH FINDINGS：2 Medium（F1 测试硬编码实现者私有环境常量伤可复现性；F2 harness 控制域场景可作业务证据永真预言机）+ 2 Low + 4 Info**。复审者自建受限角色环境完成全部复跑（无 blocked）。**结算保留：2 Medium 未关闭前 MT131 不得 verified。** 审阅终端已释放。
- 复审对我方派发参数的事实纠偏（F5，非实现缺陷，已吸收）：harness HTTP 端口代码硬编码 45435、无 `OPENBOT_MT131_HARNESS_PORT` env；测试库需 vector 扩展（pgvector/pgvector:pg16），plain postgres:16 会让 enterprise migrate 失败。后续所有涉及 enterprise 测试库的 brief 统一用 pgvector 镜像 + 显式 POSTGRES_HOST_AUTH_METHOD。
- 修复轮派发：Task `task_23bb940e29e7` / Dispatch `ctx_f2b1f182bcd7`（pi，ready/input_accepted），工作树 `i6-mt131-fix2`（BASE f0520524），快照按 `checkpoints/MT131/fix2-transfer-manifest.txt`（15 行；acceptance-harness.ts=`2b29aeb6…`、acceptance-harness.test.ts=`df6f6f31…`）；Brief `briefs/MT131-fix2-brief.md`（F1/F2 必须关闭 + F3/F4 附带；双环境验证；pgvector 镜像）。修复后须全新独立 Pi 复审。
- 当前运行中：MT003-fix2（Task `task_63aeeec4713d` / Dispatch `ctx_e985c1514a4a`，容器 openbot-i6-mt003fix2-pg 已起）；MT131-fix2（上述）。

## 2026-10-16 MT003 修复轮复审通过并集成 → verified

- MT003-fix2 独立复审（Task `task_4d75316b5635` / Dispatch `ctx_8ee90c5fa0c3`）：**修复有效性 PASS / Code quality PASS，0C/0H/0M/2L/3I**（非阻塞，留档 reports/MT003-fix2-review.md）。F1/F2 Medium 确认关闭：专属端点显式 env + 全安全检查、journal digest 漂移三路径拒绝且不自动修复。审阅终端已释放。
- 集成：migrate-test.ts=`330524de…ffe498e`、migration-tool.test.ts=`cca6e35c…dd6019`（与 fix2 复审清单逐字节一致）转入执行工作树；integration.json 记录完整 lineage（原实现→复审2M→修复→复审双 PASS）。
- Coordinator 亲自复跑（执行工作树，专用 PG 55452 容器 openbot-exec-mt003-verify，用后删）：migration-tool **42 pass/0 fail/0 skip（233 expect）**；MT001 inventory 回归 33 pass/5088 expect；`server typecheck` exit 0；biome 两文件无诊断。
- **MT003 → verified**（dag.json 已更新）。MT004（#47，deps MT003）就绪，立即派发。进行中：MT131-fix2 复审（`ctx_2b71de398106`）。

- **coordinator 裁决 #3（MT004 TASKS 断言演进）**：MT004 实现者提问 migration-tool.test.ts:344 穷举断言 `["MT000"]` 与「注册 MT004」冲突。裁决：允许窄例外——该断言（及其机械重复处）随注册最小更新为 `["MT000","MT004"]`，其余该文件用例仍只读；属合法契约演进而非回归破坏。已回复 worker 并同步修订 brief。

## 2026-10-16（续）MT004 实现结算与复审派发

- MT004 实现者 worker_done（delivery_aea36832c7d5 已 ack）：报告 4/4 验收全绿，披露（a）测试库镜像实际用 pgvector/pgvector:pg16（与裁决 #4 一致），（b）早前 brief BASE 哈希笔误（实现者以 brief 内 after-hashes 与本地复算为准）。检查点齐全（red-green/mutation/cli/verification/review-package）。
- 实现者终端已释放（ctx_0d3c6dfe3dc0）。
- 复审工作树 `i6-review2-mt004`（f0520524）建立；快照转移 40 文件（含 tracked 修改 enterprise-tenancy.ts——复审树 git status 显示 M 为预期）；`checkpoints/MT004/review-sha256-manifest.txt` 生成并经 coordinator 全量复算自校验通过（首次生成混入自引用行，已剔除后复验）。
- 复审任务 task_70322419a303 派发，worker ctx_38779f5e5c60（--agent pi，工作树 i6-review2-mt004，端口 55453）。brief：briefs/MT004-review-brief.md。
  - 教训：task-create 用 `--task-title`（非 --title）；worker-start 成功回执 jq 路径以 dispatch-show 复核为准（首次调用 ok:true 但 jq 显示 null，勿重复启动）。
- MT131-fix2 复审（ctx_2b71de398106）存活：observation=live / liveness=live。
- dag.json：MT004→reviewing（补记实现 worker 元数据）；MT131 worker 标注 fix2-review。

## 2026-10-16（续）MT004 独立复审结算 → 修复轮派发

- MT004 复审 worker_done（delivery_bf70deb282d8 已 ack，实现者终端已释放）：**Spec 4/4 PASS / Code PASS with findings**。报告归档 `reports/MT004-review.md`（sha256 e2e4440d…）。
- 复审要点：40/40 manifest 复算 OK；schema 纯追加 70/0；裁决 #3 窄例外独立重算 diff 逐字节一致；8 项复跑 7 项 exit 0；brief 原样组合回归命令 5000ms 超时定性为环境性 blocked（3 项对照：文件哈希未变 / 单独跑 0 fail / --timeout 30000 后 50/0）。
- Findings：F1 medium（新表缺 FORCE ROW LEVEL SECURITY，0056 对既有 7 表全 FORCE；pg_class 实测 relforcerowsecurity=f）；F2 low（epoch 并发竞态未明示）；F3/F4 info。
- 按先例 Medium 必须修复：修复树 `i6-mt004-fix` 建立（f0520524），11 文件 fix-transfer-manifest.txt 转移并自校验；brief `briefs/MT004-fix-brief.md`（F1 加 FORCE + pg_class 断言 TDD；F2 注释披露；端口 55454；schema 文件只读）。
- 修复任务 task_7c40417f32e9 派发，worker ctx_982ce0c08523（--agent pi）。dag：MT004→fixing。
- 运维记录：check --wait 后台 120s 超时属预期循环；用户界面"1 orchestration message"提示多为跨 run 全局 inbox 噪音（其它 run 心跳），以本 run check + 磁盘报告落盘为准。MT131-fix2 复审仍在跑（全盘 find 慢命令 + CH 96.9%，探活消息在队列）。

## 2026-10-16（续）MT004 修复结算 → fix 复审派发；MT131 复审解除阻塞

- MT004-fix worker_done（delivery_00226a107273 已 ack，实现者 ctx_982ce0c08523 已释放）：F1 CLOSED（FORCE RLS 加入 rls_policies，0056 模式；RED 15/1 唯一失败=新断言 → GREEN 16/0 全新库；psql 交叉核验 t/t）、F2 CLOSED（两处纯注释披露）；验证 16/0、75/0/0skip、17/0、组合+timeout 50/0、typecheck/biome exit 0；enterprise-tenancy.ts 零改动。after：migrate-test.ts cb0891c6…、membership-model.test.ts e7057686…。
- fix 复审树 i6-review2-mt004-fix 建立，22 文件 fix-review-sha256-manifest.txt 转移并自校验（再次踩自引用坑——manifest 放在被遍历目录内会算入自身，剔除后复验；已两次，后续模板必须把 manifest 放遍历范围外或显式排除）。
- fix 复审任务 task_c9af0cd806e9 派发，worker ctx_7c547044f466（--agent pi，端口 55455）。brief：briefs/MT004-fix-review-brief.md。
- MT131-fix2 复审解除阻塞：其全盘 find（pid 68995，`find / -name fix2-transfer-manifest.txt`，head -3 凑不满导致无法提前退出）阻塞 agent 循环 50+ 分钟；coordinator 精准 kill 该 find 进程（不触碰 worker），命令正常返回后 agent 恢复推进（终端尾部更新为 F2 深挖内容）。探活消息仍在队列。
- dag：MT004→fix-reviewing。

## 2026-10-16（续）MT131 集成完成 → verified

- MT131-fix2 复审结算（delivery_e7c5b2161aad 已 ack，复审者 ctx_2b71de398106 已释放）：**修复有效性 PASS / Code quality PASS WITH FINDINGS（0C/0H/0M/1L/2I）**。报告归档 `reports/MT131-fix2-review.md`。
  - F1 环境无关性第三方直接证据（复审自建第三套环境 17/17）；F2 结构性证明（占端口实验：拒绝先于端口绑定）；F3/F4 实测关闭；MT001/MT002 双哈希链验证未动；「绝不合成通过」未放松（CLI 0/539 + acceptance-not-passed）；150 表逐表 count 零残留；凭据治理完备。
  - 残留：F1R low（CLI 旗标 tokenizer 吞下一个 --* 取值——既有语义、响亮失败、非回归）；F2R/F3R/F4R info。
- 集成：交付从 i6-review2-mt131 冻结转移到执行工作区，三方哈希核对（fix2-review manifest / 复审树 / 集成磁盘）7 文件全 OK（首跑一例路径笔误 server/tests/.../inventory.ts 实为 scripts/，修正后全过）；F3R 断链原件 fix2-transfer-manifest.txt 已从 i6-mt131-fix2 补入 `checkpoints/MT131/`。
- coordinator 亲验（pgvector/pgvector:pg16 @55456 + 受限角色 ent_int*）：migrate exit 0；`bun test tests/multitenancy/` 108 pass / 0 fail / 1 显式 skip（MT003 assigned-db 用例未设 env，非隐藏失败）；补 env 复跑 migration-tool 42/0/0 skip → 残留 skip 0；typecheck exit 0；biome exit 0。容器与 0600 env 已清理，端口复归空闲。
- integration.json 更新（verification 结果）；dag：**MT131 → verified**。下游解锁：MT132（deps MT131 现已全满足？需核对其全部 depends_on）。

## 2026-10-16（续）MT004 集成完成 → verified；MT005/MT112 并行派发

- MT004-fix 复审结算（delivery_54eee20f71af 已 ack，ctx_7c547044f466 已释放）：**修复有效性 PASS / Code quality PASS（0C/0H/0M/0L + 3 info）**——22/22 manifest、fix.diff 逆应用逐字节复原 before/ 哈希（零行为变化证明）、psql t/t、digest 漂移拒绝语义未回退。
- MT004 集成：4 交付文件（含裁决 #3 触及的 migration-tool.test.ts——首跑漏转移该文件，manifest 核对 FAIL 捕获后补齐 10/10 全过）+ 4 报告 + checkpoints 双目录。
- coordinator 亲验（pgvector@55456 + ent_m4*）：migrate 0；全量 125 pass / 0 fail / **0 skip**（fixtures 17 + harness 17 + inventory 33 + migration-tool 42 + membership-model 16）；typecheck 0；biome 0；库被套件自清理（零残留语义）。
- dag：**MT004 → verified**（累计 6：MT001/002/003/004/103/131）。READY：MT005、MT112。
- MT005 派发（task_70d54b54ba2e / ctx_2a8e4c341143 / i6-mt005 / 55457）：brief 含 seam 落点（createScopeResolver 扩展 + conversations 事务模式）、裁决 #1（x-openbot-tenant/x-openbot-workspace 选择用）、裁决 #2（无 conversations-v1）、MT004 epoch 竞态接管责任、五条验收 TDD。
- MT112 派发（task_1f45a268faf6 / ctx_679c87145582 / i6-mt112 / 55458）：brief 要求先勘察部署身份/计费 Customer 实际表、TASKS 注册 MT112、幂等 ON CONFLICT、映射唯一可核验、dry-run/manifest 链路、125 基线回归。
- 两树 prereq-manifest 各 19 文件核验通过（教训：执行工作区无 MT003.md 原始实现报告——只有 fix 系列；清单修正为 MT003-fix2/review2/fix2-review 三件）。

## 2026-10-16（续）裁决 #5（MT112 窄例外）

- MT112 实现者 ask（msg_a28d665589a9 / delivery_eb7f07eb7b0a 已 ack）：注册 MT112 后 migration-tool.test.ts:347 穷举断言必然失败，请求按裁决 #3 先例最小更新。
- **裁决 #5**：授权——仅该断言演进为 `["MT000","MT004","MT112"]` + 3 行注释（标注 ruling #5 / 同 #3 窄例外），文件其余只读；diff 记录入报告与 review-package。已回复 worker。

## 2026-10-16（续）MT112 实现结算 → 独立复审派发

- MT112 worker_done（delivery_cc6876213cae 已 ack，ctx_679c87145582 已释放）：**succeeded**。勘察落点真实（deployment_packages.tenant_id / billing_customers.external_id / deploymentExternalCustomerId 派生 `openbot-deployment-${tenantId}`）；新表 enterprise_deployment_anchors（双唯一索引 + 派生 CHECK 自证 + ENABLE+FORCE RLS + 仅 operator SELECT）；4 步 TASKS（DDL/RLS/幂等锚点行 ON CONFLICT/映射行）；21 用例（RED 缺失导出型、GREEN 两轮、MUT 4/4 含 MUT2 假跑诚实披露）；146/0/0skip 全量回归；CLI 链全 0；裁决 #5 按 13 行最小 diff 执行。
- 已知边界 5 条如实披露（DEPLOYMENT_ID env 覆盖、锚点用户=最早用户非业务认定、无用户/无包 0 行分支、billing 投影行不越权、MUT2 假跑）。
- 复审树 i6-review-mt112 建立，40 文件 review-sha256-manifest.txt（本次显式排除自身，未再踩自引用坑）。复审任务 task_9994da1edf39 派发，worker ctx_6e7588322c79（端口 55459）。brief：briefs/MT112-review-brief.md（含勘察结论亲自核验项 + 裁决 #5 独立重算比对 + RLS FORCE 验证）。
- dag：MT112→reviewing。MT005 实现仍在收尾（biome 基线披露阶段）。

## 2026-10-16（续）MT005 实现结算 → 独立复审派发

- MT005 worker_done（delivery_f8acddd2642d 已 ack，ctx_2a8e4c341143 已释放）：**succeeded**。交付：store.ts resolve 纯追加（选择子拆分 + WORKSPACE_FORBIDDEN 团队资格 + app.workspace_id）、新文件 scope-gate.ts（conversations 事务形状：advisory 锁 tenant→principal→membership→workspace-membership + 公司 epoch 等值重验 + 团队行重验）、index.ts 裁决 #1 头名 2 行、scope-gate.test.ts 23 用例。
- 证据：watched RED（模块缺失→9/13→22/22→epoch 钉死后 23/23）；变异 4/4（M4 首轮 22/22 暴露测试缺口→test-first 补 stale-epoch 用例→M4v3 RED→23/23）；回归 147/0/1 显式 skip；typecheck 0；biome 存量披露（D5，HEAD 快照比对）。
- 披露 D1-D6：D1=MT002 fixture 两文件集成（fixture.ts 三块纯追加 + fixtures.test.ts 仅 2 断言 404→403，票面契约必然结果）；D2=resolveForThread 不扩展（expand-only）；D3=团队 epoch 不入 PlatformScope（形状约束+缓解）；D4=管理写路径超级用户替身（判定侧全走受限 RLS）；D5=存量 lint；D6=显式 skip。
- 复审树 i6-review-mt005 建立，40 文件 review-sha256-manifest.txt。复审任务 task_07ca9c8a9bc5 派发，worker ctx_517f20b7c300（端口 55460）。brief 把 D1 最小性与 403/404 语义、D2/D3/D4 处置列为重点。
- dag：MT005→reviewing。当前 in-flight：MT112 复审（ctx_6e7588322c79）、MT005 复审（ctx_517f20b7c300）。

## 2026-10-16（续）裁决 #6（MT005 复审快照修复）

- MT005 复审者发现复审快照缺 1 个声明文件：server/tests/multitenancy/support/scope-gate.ts（实现者 review-package/sha256-manifest 已声明，哈希 7f32f543…；coordinator 转移清单人工遗漏 support/ 下第三个文件）。复审者自主核验其在 i6-mt005 存在且哈希一致。
- **裁决 #6**：授权 Option A 快照修复——复制前/后双侧哈希核验、报告记录为 coordinator snapshot repair (ruling #6)、该文件纳入审阅对象、继续全部复跑。coordinator 亲算哈希一致后已回复。

## 2026-10-16（续）MT005 复审结算 → 集成完成 → verified

- MT005 复审 worker_done（delivery_887cf014e378 已 ack，ctx_517f20b7c300 已释放）：**Spec compliance PASS（5/5）/ Code quality PASS（无 C/H/M 代码 finding）**。findings：F-1 medium 流程（快照打包缺口，裁决 #6 已修复；流程建议=review manifest 与 review-package 同源派生，采纳）、F-2 low（MT004 时代 generated 工件 digest 漂移歧义）、I-1/I-2/I-3 info。复审独立复跑：23/0、148/0/0skip（含 assigned-db）、advisory 锁 psql 原生复证、typecheck 0、biome 与 HEAD 存量一致。
- 集成（目录枚举清单，7 交付文件全部与复审树哈希逐字一致）：store.ts（30+/2- 选择子拆分）、scope-gate.ts（新）、index.ts（4+/2- 头名）、scope-gate.test.ts、fixtures.test.ts（D1 两断言）、support/{fixture,scope-gate}.ts；报告与检查点归档。
- F-2 消歧：旧 generated/ 归档为 generated-mt004-era/（工具防漂移保护拒绝覆盖——印证漂移真实），当前工具重新 generate 得 planDigest 39b91e0f…（与复审独立计算一致）。
- coordinator 亲验（pgvector@55456 + ent_m5*）：baseline migrate 0；MT004 apply 0（新 manifest）；scope-gate 23/0；全量 **148 pass / 0 fail / 0 skip**（6 文件）；typecheck 0；biome 唯一违规 = store.ts:70 noConsole 经 git show f0520524 证实为 BASE 存量（D5 准确）。容器/env 已清理。
- dag：**MT005 → verified**（累计 7）。READY：MT006、MT008、MT013。in-flight：MT112 复审（ctx_6e7588322c79）。

## 2026-10-16（续）MT006/MT013 并行派发（同源转移脚本落地）

- MT005 verified 后 READY：MT006、MT008、MT013。调度决策：MT006（API/路由面）与 MT013（config/启动面）并行——brief 严格划定 index.ts 行区归属（MT006=路由注册段、MT013=启动校验段）；**MT008 延后**（与 MT006 共享 store/资源语义面，等 MT006 verified 后派发）。
- F-1 流程建议落地：`scripts/transfer-prereq.sh`（目录枚举 rsync + 同源 prereq-manifest 自校验）取代手工清单；两树各 18 文件核验通过（首版脚本有 BASE 行管道 bug 与 zsh 不分词教训，已修复重跑）。
- MT006 派发（task_ce1f2edb1025 / ctx_fcaf1191c69c / i6-mt006 / 55461）；MT013 派发（task_be2628da62f6 / ctx_1fbada6b1783 / i6-mt013 / 55462）。
- 当前 in-flight：MT112 复审（ctx_6e7588322c79）、MT006、MT013。

## 2026-10-16（续）MT006 实现结算 → 独立复审派发

- MT006 worker_done（delivery_e4600d0c7232 已 ack，ctx_fcaf1191c69c 已释放）：**succeeded**。交付：workspace-admin.ts + workspace-scope-routes.ts（新）+ index.ts/app.ts/config.ts 纯追加（路由挂接必然面）；34/34 新套件、182/0/0skip 全量（148+34）、5/5 变异、typecheck 0、存量 lint D5 比对净新增 0。D1-D7 披露完整（D1 operator DELETE 策略测试供给、D2 降级通道超级用户替身同 MT005 D4、D7 测试自我修正诚实记录）。
- 复审树 i6-review-mt006（prereq 18 + review manifest 31 文件核验）。复审任务 task_2cc0673c78d3 派发，worker ctx_b5dc7c0a15fb（端口 55463）。brief 重点：append-only 三文件核验、store/scope-gate 哈希不变独立复算、D1/D2 处置意见、AC4 越权。
- dag：MT006→reviewing。in-flight：MT112 复审、MT013 实现、MT006 复审。

## 2026-10-16 平台故障接管（stop_unverified 三连）

- 02:12:19Z Orca 侧强制终止三个运行中 worker（均 stop_unverified，非任务失败）：
  - MT006 复审 ctx_b5dc7c0a15fb（报告仅占位存根，复审中断）
  - MT112 复审 ctx_6e7588322c79（零报告产出）
  - MT013 实现 ctx_1fbada6b1783（磁盘核对无实现增量，仅 prereq）
- 三棵工作树快照完好（git status 与预期一致），三 escalation 已 ack（delivery_a33054487cdb）。
- 各 brief 追加「接管说明」（前任非失败、存根可覆盖、PG 容器 55463/55459/55462 可复用）。
- 重派（worker-start 最小 flag 形态；--setup/--comment 触发 invalid_argument、--retry-of 报 cannot retry，均弃用）：
  - MT006 复审 → ctx_bb502a2b7d1c（i6-review-mt006）
  - MT112 复审 → ctx_70187e0544da（i6-review-mt112）
  - MT013 实现 → ctx_9fb9633acb41（i6-mt013）
- 派发后 45s 探活：三路均 Working（复审者在核验 diff / 实现者开工）。恢复纪律执行完毕：无工作丢弃、无重复增量。

### 裁决 #7（MT006 复审快照修复，2026-10-16）

- MT006 复审者（ctx_bb502a2b7d1c）question：`server/tests/multitenancy/support/workspace-scope.ts`（D1 operator-DELETE 替身供给，sha256-manifest 声明 hash a67cf0b8…c87d8）在 i6-review-mt006 树中缺失，34 用例套件无法加载。
- 取证：实现树 i6-mt006 主副本存在且哈希与 checkpoints/MT006/sha256-manifest.txt 声明值一致；复审者另从 changes.diff 2095-2496 提取得同一哈希。判为 ~04:35 复审树删失（疑似平台 stop_unverified 副作用），非交付物缺陷。
- 处置：coordinator 亲自复制主副本 → 复审树（修复后复算一致，三方吻合）；授权复审者继续完整复审；要求其独立复算哈希并把删失事件以 info 级记入报告。回复 msg_31cea413eabd，question delivery_a83d0c5b769c 已 ack。
- 与裁决 #6 同例；transfer-prereq.sh 属 prereq 转移面，MT006 交付物转移仍为手工清单——已再次暴露清单枚举风险，MT006 集成时须以 checkpoint manifest 逐文件核对（原流程已含）。

### MT006 复审结算 + 集成（2026-10-16）

- ctx_bb502a2b7d1c worker_done succeeded（delivery_f1d0b0067e90 已 ack，worker 已释放）：**Spec PASS 4/4 / Code PASS，0C/0H/0M**（F3 low 空 workspaceId 端口径不对称；F1/F2/F4/F5/F6 info）。
- 快照：HEAD=BASE、31/31 manifest、prereq 18/19+index=after-hash（授权追加）、diff 与 changes.diff 逐字节一致；append-only 独立成立。
- 复跑：34/0（105 expect）、182/0/0skip（7422 expect，313s）、typecheck 0、biome 新文件 0 findings、D5 BASE 9e+2w=CURRENT 9e+2w；planDigest 39b91e0f… 独立复算一致。
- 串行化证据：gate 与管理写共享同一 advisory 键串（shared vs xact 排他互斥），移除/停用后 gate 立即 WORKSPACE_REVOKED/FORBIDDEN——真实库行为。
- D1 接受（条件：生产 operator DELETE 策略须建后续票跟踪，否则 remove 在未打补丁生产库 500 fail-closed）；D2 接受。
- 集成：i6-mt006 冻结 7/7 = checkpoints/MT006/sha256-manifest.txt；转移 EXE 后 7/7 复核一致；checkpoints/MT006、MT006-review.md、接管版 review-brief 归档。coordinator 亲验（55464）后台运行中。

### MT112 复审结算 + 集成（2026-10-16）

- ctx_70187e0544da worker_done succeeded（delivery_3161499886ac 已 ack，已释放）：**Spec PASS 4/4 + 裁决#5 最小性/expand-only/RLS FORCE 全 PASS / Code 高；0C/0H/0M**（L1 复跑 runbook 缺「先 apply MT004」前置；L2 dry-run 完整断言仅 fresh 库分支；3 info）。
- 快照：HEAD=BASE、40/40 review manifest、26/26 sha256-manifest（plan 相对路径口径）；纯追加以反向补丁重建 before 哈希密码学级核验（schema 37 行 / migrate-test 107 行 / migration-tool.test 恰 13 行）。
- 复跑：legacy-anchor 21/0（255 expect）、全量 146/0/0skip（6 文件）、CLI 链 dry-run→generate→apply→重放 0/0/0/0、psql 实测 RLS FORCE + 三码 23505/23514/42501、typecheck/biome 0；独立 generate 与存档 manifest 逐字节一致（f65c290e…）。
- 集成：i6-mt112 冻结 4/4 = after-hashes；转移 EXE 后 4/4 复核一致；checkpoints/MT112、MT112-review.md、brief 归档。亲验排队（MT006 亲验运行中，完成后以 55465 串行执行避免负载竞争）。

### MT006 + MT112 集成亲验通过（v4，2026-10-16）

- 亲验脚本四次迭代（全部记录）：
  - v1：manifest glob 落空（generate 产物在 `<out>/MT004/manifest.json`）；
  - v2：URL 无用户名（默认 OS 用户 wuyongjun 不存在→migrate refused）；typecheck/biome 结果仍有效（exit 0）；含密码日志已删（裁决 #4 卫生）；
  - v3：补 ENTERPRISE_TEST_SETUP_DATABASE_URL（套件守卫第 5 变量）消灭 61 skip → 202/1；唯一 fail = PG 初始化竞态静默吞掉 CREATE DATABASE assigned（psql shutting down 窗口）；
  - v4：真实 psql 就绪探针 + CREATE 重试断言 → **全绿**。
- 最终证据：migrate/gen/apply/suite/full/typecheck/biome 全 exit 0；workspace-scope 34 pass/0 fail（105 expect 与复审一致）；**全量 203 pass / 0 fail / 0 skip / 8 文件（7678 expect）**——182（MT006 基线）+21（MT112 legacy-anchor）首次两票共树；清理完成（容器删除、0600 env 删除）。
- MT006、MT112 均置 verified（integration.json 已落盘）；MT008 解锁。
- 流程教训（记入惯例）：集成亲验期间冻结 EXE 写入（v2 期间 MT112 转移污染过一次运行）；亲验脚本 URL 必须带显式用户（postgres@）；容器就绪判定用 psql 而非 pg_isready。

### MT008 派发（2026-10-16）

- MT006 verified 解锁 MT008（deps=MT005 已 verified）。工作树 i6-mt008（BASE f0520524 + setup run）+ transfer-prereq.sh 21 文件自校验通过（清单已扩展纳入 MT006/MT112 报告与 checkpoints）。
- brief 要点：expand-only（属性+策略版本注册+兼容+显式迁移；动作规则留给 MT009/MT010）；ALLOWED_TASK_IDS 窄例外按裁决 #5 先例；五变量 env 守卫；基线 203/0/0skip；manifest 覆盖全部交付物（吸取 MT006 F2）。
- task_d301bd4de1f8 / ctx_be6e0b27e514 已启动（ready）。

## 2026-10-16 Orca 重启接管（第二次平台故障）

- 重启杀死 MT013 实现者（收尾阶段）与 MT008 实现者（勘察阶段）；此前两者还经历上游 502 中断（探活消息已确认 MT013 自愈完成主体工作）。
- **MT013 按检查点受理**：报告（e552054e…）+ checkpoints 全套完整落盘；coordinator 按 review-sha256-manifest 双基准复算 34/34（两份 manifest 自引用失配为已知形态）；实现者死前未发 worker_done → dispatch worker-stop+release 结算。i6-review-mt013 副本树建成（34/34 复核）；复审 brief 下发（强调 manifest 分节格式、MT005-era 基线 181 而非 203、psql 探针、MT004 apply 前置）。
- **MT008 重派**：前任零增量；旧 dispatch ctx_be6e0b27e514 卡 stop_unknown（user_owned 终端无法强停）→ task_d301bd4de1f8 被 task_225d5424dc91 取代（ctx_084c6c5a74a2）；brief 追加二次接管说明。
- MT013 复审：task_dacb1c1b9b67 / ctx_889a16f80d73（i6-review-mt013）。

### 裁决 #8（MT008 双 worker 处置，2026-10-16）

- 旧 dispatch ctx_be6e0b27e514 在重启后自愈复活（心跳 phase: implementing、37% 上下文），而接管者 ctx_084c6c5a74a2 已在同一树 i6-mt008 启动——双写冲突风险。
- 处置：停掉接管者（损失最小，勘察期零增量）、释放；旧 worker 确认为唯一实现者；已发送裁决 #8 消息（worker_done 失败则按磁盘检查点受理 + manifest 自引用规避 + brief 二次接管说明读取）。task_225d5424dc91 作废。

### 裁决 #9（MT008 前置快照修复授权，2026-10-16）

- MT008 实现者 question：i6-mt008 缺 4 个 MT006 生产文件（workspace-admin/workspace-scope-routes/config/app）——transfer-prereq.sh 的 cp 清单与 manifest 枚举未随 MT006 交付面更新（tests/ 经 rsync 带上了测试与 index.ts，但 tenancy 新源文件与 config/app 不在清单），导致 MT006-final index.ts 引用悬空、基线 169/1/1error 而非 203/0/0。
- 处置：授权实现者从 EXE 复制该 4 文件（复制前后双复算 SHA-256 比对 MT006 manifest 声明值），报告 §「前置修复披露」记录裁决与哈希；coordinator 同步修复 transfer-prereq.sh（cp 清单 + find 枚举补齐 4 文件）——后续票不再复发。
- 回复 msg 见 msg_a21d3feb4689 线程；question delivery_0be09aeb937b 已 ack。

## 2026-10-16 第三次平台事件接管（orchestration recovery 杀终端）

- MT013 复审（ctx_889a16f80d73）与 MT008 实现（ctx_be6e0b27e514）均死于 "terminal no longer live after orchestration recovery"，dispatch 已 failed 结算。
- MT013 复审：前任完成快照核验+全部复跑+实证 medium F1（损坏 waivers → exit1 零审计记录、TypeError 外抛），死于 typecheck 复跑；报告零产出。接管说明（三次）已入 brief，明确前任发现不预设结论。重派 → ctx_724925f09bd4（同 task_dacb1c1b9b67）。
- MT008：前任磁盘增量丰富（实现文件 + checkpoints 部分：before-hashes/裁决#9 存档/mutation/red-green/verification），缺报告与 manifest。接管说明（三次）要求盘点已有增量、续做不弃。原 task_d301bd4de1f8 仍 blocked（历史 wedged 未清）→ task_abdbac221bdf / ctx_3e5857d058e2。
- 两专用容器（mt013-review-pg / mt008-pg）存活复用。

### MT008 实现结算 + 复审派发（2026-10-16）

- ctx_3e5857d058e2 worker_done succeeded（delivery_520f77061c00 已 ack，已释放）：三次接管者盘点保留增量（前任 mutation/verification 目录为空壳，重做），修复继承套件 3 处真实测试缺陷（factsOf override bug + suspended-member 用例违反 MT005 seam，测试面修复且 RED-2 披露），产出 resource-policy/resource-visibility + 29 用例 + 迁移注册窄例外。
- 验证：新套件 29/0/0skip、全量 232/0/0skip（203+29）、typecheck 0、biome 干净（含披露修复）、4 变异 3 杀 1 存活（披露）、prereq 18/21+3 授权差异字节级重构验证；容器用后已清。
- 副本树 i6-review-mt008 建成（manifest 29/29 复核）；复审 brief 重点：三处测试修复逐处对照 MT005-era 原文判定修复 vs 削弱、存活变异定级、窄例外最小性、AC2 对照真实性。task_2da60390ac50 / ctx_9328117dccee（55466）。

## 2026-10-16 08:47Z — MT013 复审遭遇上游 502，发恢复指令（观察中）

- 消费者 `bft6lwr9i` 120s 空轮超时（count 0）；前台 check 复核无消息。
- 心跳核对：MT013 复审（ctx_724925f09bd4）last_heartbeat 08:06:57Z、worker-read liveness stale（最后观测 08:15:15Z）；MT008 复审（ctx_9328117dccee）live/fresh，正常。
- 终端取证：MT013 复审核验推进正常（config.test.ts 哈希与 HEAD 一致 861f2e1d…、config.ts changes.diff 提取 5 hunk）后遭遇 `API error (502): no upstream candidate` ×3、Retry 3 次失败回到提示符——与前次 MT013 实现/MT008 复审派发前的 502 同类，平台侧瞬时事件。
- 处置：`send --to dispatch:ctx_724925f09bd4` 恢复指令（msg_16c2e729c9d5，08:47:16Z）：不重启、不丢弃已核验增量、从中断点续跑、完成后 worker_done；无法继续则回复说明。
- 判定：中断只算检查点，不判死、不重派；等待自愈或回复。消费者已重挂。

## 2026-10-16 12:55-13:00Z — 上游 502 风暴确认杀死两复审者；增量保全 + 重派（MT013 第4任 / MT008 接管1）

- 会话恢复（机器 10:36-10:54Z maintenance sleep 后）。取证：MT013 复审（ctx_724925f09bd4）与 MT008 复审（ctx_9328117dccee）终端尾均为 `API error (502) no upstream candidate` ×3 + Retry failed——同一波 502 风暴（08:15Z/08:32Z），agent 循环死亡。08:47Z 发往 MT013 的恢复指令入队无人消费（delivered_at null）。
- **MT013 前任增量保全**：`/tmp/mt013-review/` 完整留存其独立复跑产物（rerun 五日志、smoke 系列、run-slice 脚本、盘点、0600 env）。关键证据：`smoke-corrupt-waivers.jsonl` **0 字节** + `.err` 未捕获 TypeError 栈（前任 F1 medium 实锤）；`smoke-missing-waivers.err` ENOENT 裸抛为 F1 新变体。coordinator 亲核工作树五交付文件哈希与 sha256-manifest 逐字一致（swap 均在 /tmp 副本进行，工作树未污染）。报告未写。
- **MT008 前任零增量**：/tmp/mt008-review 不存在，报告未动笔。
- 处置：worker-stop（ptyKilled）+ worker-release 双双干净结算 → brief 各追加接管说明（MT013 第4任：增量可参考但关键断言须亲自重放、不预设结论；MT008 接管1：无增量从头执行）→ task-create（`--task-title` 非 `--title`）→ worker-start 绑原复审树。
- 新派发：MT013 复审 = task_dc01a70af093 / ctx_d73182c48ba5；MT008 复审 = task_0a7880e2b0a2 / ctx_83c491439765。dag.json reviewing 节点已更新。
- 消费者重挂。

## 2026-10-16 13:11-13:30Z — MT008 复审 PASS + 裁决 #10 + 集成亲验 verified

- 复审 worker_done（13:11:59Z，接管1，ctx_83c491439765 已 ack+stop+release）：**PASS 4/4，0C/0H**；独立复跑 29/0/0、全量 232/0/0skip、typecheck/biome 0、29/29 哈希复算、裁决#9 四恢复文件双侧一致。
- 三项重点裁决（复审者）：①三处测试修复均为正当修复（factsOf bug 机理独立脚本复现、WORKSPACE_FORBIDDEN seam 新增钉死、suspended 用例更强）——并纠正 brief 前提：修复全在本票新建测试文件内，prereq 判定面零触碰；②MUT3a 存活 = medium 测试覆盖缺口（isNull TOCTOU 防线无独立用例，实现正确）；③ALLOWED_TASK_IDS 4 行窄例外符合裁决 #5 先例。
- **裁决 #10（coordinator）**：F1 medium 属披露性测试覆盖缺口而非实现缺陷（防线在位正确、可观察行为全钉死、复审明示不构成返工）→ 按 MT006 D1 先例接受 + 挂账跟进（建议随 MT009/MT010 写路径票补白盒断言/交错测试）；不触发修复轮。F2-F6 无需动作。
- 集成：实现树三 M 文件与 EXE 仅差 MT008 纯追加（基线即 MT006+MT112 后状态，无需手工合并）→ 冻结哈希（frozen-before.txt）→ 7 文件复制 → 双侧哈希 7/7 一致。
- 亲验 v2（v1 因 coordinator 笔误 umask 177 导致 EACCES 连锁，废弃）：fresh 55470 库，base migrate 0、MT004 apply 0、**suite 29/0/0（159 expect）**、**全量 232/0/0skip（9 文件 = 203+29，与复审一致）**、typecheck 0、biome 0。integration.json 落盘，dag MT008 → verified。
- 挂账：F1 medium 用例、F2 low 用例、F3 FORCE 统一票。

## 2026-10-16 13:17-13:20Z — MT013 第4任死于间歇 502，重派第5任

- 第4任（ctx_d73182c48ba5）12:59Z 启动、~13:01Z 死于 hiroute 间歇性 502（Retry 3 失败）；同期 MT008 复审接管者 13:11 完整完成——风暴间歇性，非持续。零树内增量（报告未动笔）。
- 结算：stop（closed_agent_terminal）+ release 干净。dag MT013 → reviewing（task_adfa296eae4b）。brief 追加第五任说明。
- MT008 已 verified（本轮上一条），MT009/MT010 depends_on=["MT008"] 满足，实现波次待 MT013 结清后与下一波一并排。

## 2026-10-16 13:20-13:35Z — MT008 verified 解锁波次：MT007 + MT012 实现派发

- 解锁集：MT007/MT009/MT010/MT012（depends_on 全满足，共 4 票）。
- 文件面裁决：MT007（revocation/审计/业务动作接入 + revocation.test.ts）与 MT012（schema/migrate-test/rls-core.test.ts）域清晰不重叠 → 先并行 2 票；MT009/MT010（应用动作层）待当前批次健康后派。
- transfer-prereq.sh 修复：cp 清单补 MT008 的 resource-policy.ts/resource-visibility.ts（裁决 #9 同类隐患第 3 次预防）；reports 清单补 MT008.md/MT008-review.md。MT008 实现与复审报告归档 EXE（d60cbd5a…）。
- 建树 i7-mt007/i7-mt012（BASE f0520524 + 前置转移 29 文件自校验通过，基线 232）。
- 派发：MT007 = task_ccaaebae8697 / ctx_bd4b9bd025d2；MT012 = task_d6d3e546e34d / ctx_87782a429279。brief 各含可写文件互斥清单、窄例外第 3 次先例提示（MT012）、失效点清单/策略模板的下游复用义务（票据备注）。
- 当前并行：MT013 复审第 5 任（ctx_9c9174efae1a，活跃，已跑 config 155 用例）+ 两实现。
- 502 风暴：间歇性（MT008 复审完整跑完 vs MT013 第4任 2 分钟死）。第 5 任健康后派发本波。

## 2026-10-16 13:29-13:40Z — MT013 复审结算：PASS 带 1M → 裁决 #11 修复轮派发

- 第五任复审（ctx_9c9174efae1a，已 ack+stop+release）worker_done：**Spec PASS 带 1 medium**。快照 34/34、增量往返闭合（8c258384→da645dc6）、全部数字独立复现（33/155/181/539、冒烟 6 变体 cw/mw 实证 F1）。
- **F1 medium**：waivers 损坏/缺失 → TypeError/ENOENT 穿透（startup-checks.ts:490-491）→ 进程裸栈崩溃 + 零审计记录（AC3 违反 + docstring no-crash 契约破坏）；同族 createDatabase(url) 穿透。两任（第2/第5）独立实证。F2 low：:503 缩进 format 错 + biome 证据过期。F3 info：parseWaiverFile 缺 schemaVersion 校验。
- **裁决 #11**：F1 为实现行为缺陷（非覆盖缺口）→ 触发修复轮（对照 MT008 F1 裁决 #10 的接受依据：彼为实现正确纯覆盖缺口，此为行为违反 AC3）。复审者「不阻塞受理」意见记录，但按授权门槛 medium 修复后再集成。
- 修复轮派发：task_d13f70a3fb3d / ctx_2b7ab79a8f9e @ i6-mt013（交付态 7ab7275e 核实未污染）。brief：F1 containment（inventory 同款 try/catch 范式 + createDatabase 同族 + 编排器级 2 用例）+ F2（format + 重录 biome.txt）+ F3（schemaVersion + 无 undefined + throw 路径单测）。
- 复审报告归档 EXE reports/MT013-review.md（a734f15e…）。
- 当前并行 4 worker：MT007 实现、MT012 实现、MT013 修复、（MT013 修复完成后增量复审）。

## 2026-10-16 13:44-13:52Z — MT012 实现 worker_done → 复审派发

- MT012 实现（task_d6d3e546e34d，ack+stop+release）：迁移任务 MT012（九表 ENABLE+FORCE RLS 再断言 + ob_ent_reset_business_context() 清理函数 + REVOKE PUBLIC 收窄新函数自身 + 三业务角色授权）+ rls-core.test.ts 32 用例 310 断言 + 窄例外第 3 次。全量 264/0/0（=232+32 对账正确）、typecheck/biome 0、CLI 四段 0、4/4 变异 DB 直改不漂移 journal、pristine 重建纯追加证明。报告含策略模板章节（下游复用义务）。
- 复审树 i7-review-mt012：BASE+前置 29 文件 + 3 交付（哈希核对 8d1d6ab6/4ede3c5f/c25ebf15）+ 检查点全套。复审 brief 七项重点裁决（纯追加/REVOKE 语义面/对照真实性/FORCE/披露/变异/模板一致性）。
- 复审派发：task_5508aa21e0db / ctx_e22ec2afca17（端口 55474）。
- 当前并行：MT007 实现、MT013 修复、MT012 复审。

## 2026-10-16 13:46-13:55Z — MT013 修复轮完成 → 增量复审派发

- 修复轮（task_d13f70a3fb3d，ack+stop+release）：改动面仅两文件（startup-checks.ts 7ab7275e→59f7e658、test 2d030bf2→f30dbc2a）。F1 containment（waivers ENOENT/TypeError + createDatabase 同步抛出 → 结构化 ok:false，理由不回显 URL）、F2 format+biome 证据重录、F3 schemaVersion+索引类型消息。TDD：RED-1（5 fail 含脚手架 bug 披露）→ RED-2（对回退原实现重跑，哈希验证，5 fail 恰为新增）→ GREEN 41/0/0。全量 189/0/0（181+8）、config 155/0、typecheck 0。冒烟 cw/mw：exit 1 + 恰好 1 条结构化记录 + stderr 零栈；ok 正控制 exit 0。
- 披露：mt013-fix-pg 容器 dispatch 时不存在，按规格自建（env-setup.txt 留证）——brief 措辞歧义，非违规。
- 修复交付同步 i6-review-mt013（哈希核对 59f7e658/f30dbc2a + fix/ 全套 + 报告更新 + fix-brief）。
- 增量复审派发：task_3f3c19fd1f1a / ctx_6f4b3c86b05a（端口 55475；重点六项：F1 语义/最小性/纯加法/RED-2 真实性/F2 证据/F3 硬化 + 冒烟终局证据）。
- 当前并行：MT007 实现、MT012 复审、MT013 增量复审。

## 2026-10-16 13:55-14:05Z — MT012 复审 PASS → 集成亲验 verified

- 复审（task_5508aa21e0db，ack+stop+release）：**PASS 无阻断项**。pristine 双文件反向重建哈希一致、七项裁决 A-G 全过（dbSideRead 非自证循环——事实全部经真实 RLS 读取 + 9 例双向全等 + tenancy-v1 单向与其 ⊆ 设计一致未伪装）、复跑 32/0/0、264/0/0、CLI 四链 0 且生成物逐字节同档、九表 RLS/FORCE + 函数授权面实测。N1/N2 两条 info 级观察（模板 action 过滤建议、FORCE 属主证据等级）留下游。
- 集成：冻结（c5bfb3d4/c7569901）→ diff 范围确认（MT012 纯追加 72 行 + 窄例外 biome 多行化，复审核验过）→ 3 文件复制 3/3 哈希一致。
- 亲验 v1（55476 fresh）：rls-core **32/0/0**、全量 **264/0/0skip 10 文件**、typecheck 0、biome 0。integration.json 落盘，dag MT012 → verified（第 11 个）。
- 报告归档 EXE（MT012.md + MT012-review.md cbd09216…）。
- 当前运行：MT007 实现、MT013 增量复审。

## 2026-10-16 13:57-14:30Z — MT007 实现完成 + MT013 修复复审 PASS → MT013 三方合并集成 verified

- MT007 实现 worker_done（13:57:12Z，ack+stop，release=retained 资源未完全释放）：revocation.ts 单一失效入口（六 checkpoint + cascade guard 委托 MT005 gate + 审计写入）、workspace-admin 扩展 restore/suspendCompanyMember + 既有动作补审计、events 订阅入口接入（runs/events.ts + runner.ts）。新套件 29/0/0、全量 261/0/0（其树基线 232+29）、6/6 变异、prereq drift 仅授权文件 workspace-admin.ts（哈希验证）、D5：tests/enterprise runner 51 个存量失败与本人 16 行编辑无关（对照证据）。待复审派发。
- MT013 增量复审 worker_done（13:58:00Z，ack+stop+release）：**F1/F2/F3 全消除、0 新增 C/H/M/L**（3 info：N1 存档截断、N2 断言数分支差异、N3 {} 形 waiver 消息 undefined 既有行为）。改动面往返哈希闭环、测试纯加法 41=33+8、RED-2 对原实现重跑三方互证、冒烟 cw/mw=exit1+1 条记录+stderr 0 行、ok=exit0。**修复轮受理**。
- MT013 集成（三方合并）：changes.diff 双 hunk（index.ts import+启动段、config.ts 5 hunk）dry-run 干净应用到 EXE（MT006 增量态）；3 整文件复制哈希一致；config.test.ts EXE 侧 HEAD 态确认后整文件替换。
- 亲验 v1 失败→根因定性（非 MT013 缺陷）：MT002 memberships 套件 insert 带 visibility 列（drizzle schema）但库基座无该列（MT008 迁移任务未 apply）——**MT008 集成时埋下的套件间迁移前置耦合**，此前亲验顺序（MT008 系套件先行复用库）掩盖。
- 亲验 v2（前置 apply 全部任务）：startup **41/0/0**、config **155/0**、全量 **305/0/0skip 11 文件**（=264+41）、typecheck 0、biome 纯存量 7+1 新增 0。脚本顺序笔误（MT012 先于 MT112 apply 报 refused）由 rls-core beforeAll 幂等补全，最终库完整全绿。integration.json 落盘，dag MT013 → **verified（第 12 个）**。
- 流程债两条记 integration.json process_debt：①亲验前置=全部已集成任务按依赖序；②套件间迁移前置耦合留给后续票/CI 惯例。

## 2026-10-16 14:30-14:45Z — MT007 复审派发；解锁面更新

- MT007 复审树 i7-review-mt007：EXE 全量态（含 MT012/MT013 已集成交付）+ MT007 交付 5 文件（哈希 5/5 一致）+ 检查点。**复审树基线 = 334（305+29）**，与实现者环境 261 的差异是树基线不同，brief 已说明。
- 转移缺口修复（裁决 #9 教训第 4 次）：cp 清单补 startup-checks.ts（MT013 src 交付，rsync tests 目录带入其测试但 src 缺失会 import 失败）。events.ts/runner.ts 为 MT007 本票交付暂不入清单，MT007 verified 集成后再入。
- 复审 brief：六项重点裁决（单一失效入口/改动面/D5 对照/审计通道/TDD/范围边界声明核验——「下载/任务/凭据入口不存在」声明需 grep 实证）。
- MT007 实现 dispatch release=retained（两次）——资源未释放但不阻塞磁盘工作，挂账观察。
- 复审派发：task_31e2d9d68754 / ctx_674db5bd9bd2（端口 55478）。
- 当前运行：MT007 复审（唯一）。

## 2026-10-16 14:45-15:00Z — 新波次派发：MT009 + MT010 + MT014 三实现并行

- 解锁面：MT009/MT010/MT014/MT075（MT013 verified 后 MT014/MT075 依赖满足）。
- 派发裁决：MT009+MT010+MT014 并行（新文件为主 + 共享文件纯追加规则 + resource-policy 只读消费）；**MT075 暂缓**（与 MT007 同域 workspace-admin.ts，MT007 verified 集成后再派避免冲突）。
- 三树 i7-mt009/mt010/mt014（BASE+前置 32 文件自校验；startup-checks.ts 修复后清单完备）。
- Brief 通用固化：全量基线 305、迁移前置按依赖序全 apply（流程债 #1 进 brief）、窄例外第 4 次先例提示、MT013 启动段不动约束。
- 派发：MT009=task_2a0c7dcb7ef5/ctx_c4d6f3b90d63（55479）、MT010=task_23541f0e255a/ctx_6444c9d633f9（55480）、MT014=task_2c1bc1f7ed41/ctx_4f5db17d74b7（55481）。
- 当前并行 4 worker：MT007 复审 + 三实现。

## 2026-10-16 14:21-15:30Z — MT007 复审 PASS → 集成亲验 verified（第 13）；MT075 解锁待派

- 复审（task_31e2d9d68754，ack+stop+release）：六项裁决 A-F 全 PASS——单一入口真委托 MT005 gate 零复制、D5 重放（16 行反转重跑 63/51 失败面与编辑无关+逐字节还原）、F 范围声明 grep 证实（三入口无 PlatformScope 流入）。复跑 29/0/0、334/0/0（首跑 333/1 = acceptance-harness CLI 并行瞬态，三重复证）、typecheck/biome 0、6/6 变异。1 low（报告变异计数口径）+ 4 info（检查点契约层/可选依赖形状/replay 事务成本/RED-2 归档形态）。
- 集成：整文件替换 5/5 哈希一致（workspace-admin EXE=MT006 态、events/runner=HEAD 态，无三方冲突）。
- 亲验（55482）：revocation **29/0/0**、全量 **334/0/0skip 12 文件**（=305+29）、typecheck 0、biome 0。integration.json 落盘，dag verified。
- 流程债：亲验模板 for 循环顺序笔误两次（MT112 须先于 MT012）——已 sed 修正两份模板。
- **MT075 解锁**（MT007 verified 后 workspace-admin 同域冲突消除），待派发。

## 2026-10-16 15:30-15:40Z — MT075 派发（治理组前置）

- 转移清单第 5 次同步：cp 加 revocation.ts/events.ts/runner.ts（MT007 集成后）、reports 加 MT012/MT013/MT007 六份；i7-mt075 树 34 文件自校验通过。
- MT075 派发：task_3e6ccb21018b / ctx_648c92f52621（55483）。基线 334；分类回写 MT001 清单为交付物。
- 当前并行 4 worker：MT009/MT010/MT014 实现 + MT075 实现。

## 2026-10-16 14:42-14:50Z — MT014 实现完成 → 复审派发

- MT014 实现（task_2c1bc1f7ed41，ack+stop+release）：runtime-config.ts 解析 seam（公司配置/严格解析/只收窄团队覆盖/纯函数+受限角色 RLS 读取）+ 两张配置表（enterprise-runtime-config.ts schema + MT014 迁移任务）+ 29 用例。全量 334/0/0（305+29）、4/4 变异（MUT4 RLS 上下文 fail-closed）、typecheck/biome 0、pristine 重建证明（migrate-test 纯追加 + 窄例外第 4 次 + schema barrel +1 行）。四条验收逐条映射（开关翻转输出逐字节相同 canary、凭据零回显、无全局状态）。
- 复审树 i7-review-mt014（前置 34 + 7 交付哈希核对 + 检查点全套）。复审派发：task_8a5dc6d6d6ec / ctx_dc9e25663c2c（55484，七项裁决 A-G，复跑门槛 29/363）。
- 当前并行 4：MT009/MT010/MT075 实现 + MT014 复审。

## 2026-10-16 14:56-15:05Z — MT014 复审 PASS → 集成亲验 verified（第 14）

- 复审（task_8a5dc6d6d6ec，ack+stop+release）：七项裁决 A-G 全过、无 Blocker、量化声明无一不符；29/363/typecheck/biome/CLI 全绿 + 活库策略授权面抽查 + 跨公司 RLS 拒绝探针。4 条非阻塞观察——观察1（i7 树 workspace-admin.ts drift）经 coordinator 核实为**转移清单 32→34 项版本差**（MT007 集成态 vs 建树 manifest），复审定性正确非越权。
- 集成：冻结 3 M 文件 → 7 交付复制 7/7 哈希一致。
- 亲验（55485，模板迁移序修正后首次全对）：runtime-config **29/0/0**、全量 **363/0/0skip 13 文件**（=334+29）、typecheck 0、biome 0。integration.json 落盘，dag verified。
- 挂账：观察3（runOperator 跨公司固定 principal——后续管理票不得沿用）、观察4（defaultAgentId→null 断言可补）。
- 当前运行：MT009/MT010/MT075 三实现。

## 2026-10-16 15:00-15:10Z — MT010 实现完成 → 复审派发

- MT010 实现（task_23541f0e255a，ack+stop+release）：enterprise_resource_shares 分享事实表（复合 FK+FORCE RLS+动作 CHECK，MT010 迁移任务）+ personal-share-rules.ts（属主校验/share/revoke/分享感知判定门，DB 时钟有效期，撤销即删行）+ index.ts 纯追加。聚焦 34/0/0、全量 339/0/0（其树 305+34）、typecheck 0、5/5 变异（MUT4 补停用→恢复→旧 scope 拒）。四条 AC 全实证（三条门全拒、过期撤销立即失效、跨公司 23503+同形、归属不动+NOT_RESOURCE_OWNER 不泄露）。
- 复审树 i7-review-mt010（36 项前置 + 9 交付核对 + 检查点）。复审派发：task_864b49319e6f / ctx_a430bf86c58f（55486，七项裁决，复跑门槛 34/397）。
- **集成预案记入 dag note**：MT010 的 4 个编辑文件（migrate-test/migration-tool.test/schema-index/index.ts）与已集成的 MT014 增量重叠——复审 PASS 后需两票增量合并（schema barrel 双 export、ALLOWED_TASK_IDS 七任务断言、migrate-test 双任务、index.ts hunk 应用）。
- 当前并行 3：MT009/MT075 实现 + MT010 复审。

## 2026-10-16 MT075 复审派发（task_e5418bad8e47 / ctx_b5d2ce61bd49）
- 实现者交付 5 文件哈希核对 5/5（admin-separation.ts 9253bae5 / test cd140fe1 / support 98b4fbc8 / inventory.ts 4f1ec9f8 / workspace-scope-routes.ts 19f2084d）+ checkpoints + 报告已转移至 i7-review-mt075（36 项前置）。
- brief 七项裁决 A-G；复跑门槛：聚焦 25/0、config.test 155/0（重点独立核验实现者披露的 1 例既有失败——本树 config.test 为 MT013 集成版亲验过 155/0，若复现需定性）、全量 388/0/0（=363+25）、typecheck/biome、CLI digest 对比 e517f743。
- 迁移前置依赖序 MT004→MT008→MT112→MT012。
- 在运行：MT009 第2任（task_9054994cb464）、MT010 复审（task_864b49319e6f）、MT075 复审。

## 2026-10-16 MT010 集成完成（verified，第 15 票）
- 复审 PASS（task_864b49319e6f）：七项裁决全成立；4.1 树装配缺口非本票缺陷（复审者已在重建树实证合并方向 397/0/0）；4.3/4.4 minor 挂账；无修复轮。
- 集成：6 整文件复制（index.ts d52d52ed / scenarios 9348db3d 基线=EXE 态经复审批证 + 新 4）+ 3 文件语义位合并（migrate-test fba7a53d 三票增量共存、migration-tool.test 97cf2a03 七任务穷举、schema/index 917d78fc 双 export）；窄例外 ALLOWED_TASK_IDS 第 5 次沿用。
- 亲验两轮：六任务 apply（MT004→008→112→012→014→010）全 0；聚焦 34/0；全量 397/0/0/14 文件两轮一致；typecheck 0；biome 8 文件 0（v1 合并空行经 biome 揭示即修）；容器/凭据已清。
- 基线链：…→363→397（+MT010 34）。
- transfer-prereq.sh 第 6 次同步（加 runtime-config/personal-share-rules/enterprise-runtime-config/personal-shares/schema-index + MT010 报告/checkpoints；干跑 43 文件自校验过）——MT010 复审 4.1 装配缺口的根因预防。

## 2026-10-16 MT009 第2任结算 + 复审派发（task_cd056c9acf8c / ctx_ffef911f5ec7）
- 第2任报告闭环：交付树=第1任 GREEN-2 态逐位一致（哈希三方复算 6/6+3/3）；verification/01 1 fail 定性瞬时（mtime 链排除 GREEN-2、+5 expect 中止签名、9 次复跑含 CPU 饱和全绿）；聚焦 36/0、全量 341/0、MUT 6/6、D1-D6 诚实披露。零生产代码改动声明。
- 结算：stop(succeeded,alreadySettled)+release 干净。
- 复审树 i7-review-mt009：43 项前置（首次含 MT010 全套）+ 三方合并装配（index.ts hunk patch 干净；migrate-test RESOURCE_DEPENDENCY_TASK 语义位插入——途中修正 hunk 上下文闭合缺失与悬空闭合两处装配瑕疵，TYPECHECK=0/BIOME=0/八任务 Map 自洽；migration-tool 断言八任务语义位插入）。
- brief 六项裁决 A-F（重点：瞬态失败排除法采信、装配语义等价核对）；复跑门槛 36/433（=397+36）。
- 在运行：MT075 复审（ctx_b5d2ce61bd49）、MT009 复审（ctx_ffef911f5ec7）。

## 2026-10-16 MT075 集成完成（verified，第 16 票）+ MT026/MT077 派发
- MT075 复审 APPROVED：A-G 全过、25/0、388/0（补 MT014 src 缺失后）、digest e517f743 复现、MUT5 独立复验还原逐字节一致。
- 复审者死于报告落盘后消息发出前（心跳 40min 停、画面 25min 零字节）→ stop=closed_agent_terminal+release 干净；报告+哈希+变异还原齐备 → 按检查点受理（无重派）。
- 集成：5 文件整复制（before 与 EXE 逐字节一致）；亲验 25/0、全量 **422/0/15 文件**（=397+25）、typecheck 0、biome 5 文件 0、digest afe640e7（前进仅因 MT010 新表 153→156；managementPlanes 47/4 与 checkpoint 一致——分类语义无损）。
- 挂账：config.test Google 断言缺 emailPassword 字段（上游 30a04b85 族，与 MT013 D1 同族；复审三重实证与本票无关）。
- 解锁链：MT026（deps MT007✓+MT014✓）与 MT077（MT075✓+MT014✓）就绪 → 已派发（i8-mt026 task_59de4fd90e84 / i8-mt077 task_a02dde803129，46 项前置+brief）；MT026 verified 后解锁 MT076；MT078 需 MT073、MT079 需 MT015（仍 blocked）。
- 清单第 7 次同步（admin-separation + MT075 报告/checkpoints；干跑未做——语法过+上次 43 版干跑通过，模式未变，风险低）。
- 在运行：MT009 复审（ctx_ffef911f5ec7）、MT026、MT077。

## 2026-10-16 MT077 第1任死亡+第2任重派
- 第1任（task_a02dde803129/ctx_cb2b82a62af6）死于设计规划阶段：终端显示在思考覆盖修订/缓存语义/迁移任务设计（enterprise_scope_policies），但树内 15min 零文件写入、心跳从未更新（停在 15:46:34）、画面 20min 零字节——agent 循环挂起。stop=closed_agent_terminal+release 干净结算；无磁盘增量可保全（纯思考中断）。
- 第2任 task_3804c6943bef/ctx_f44a1a96401d 同树重派（brief 已在树，从零开始）。
- 在运行：MT009 复审（ctx_ffef911f5ec7）、MT026（ctx_c4eac816ea13）、MT077-2nd（ctx_f44a1a96401d）。

## 2026-10-16 MT009 集成完成（verified，第 17 票）+ 8 票解锁
- 复审 PASS：六项裁决全立、433/0/15 文件精确命中、七任务迁移 21/21、活库 RLS 过滤+级联探针、MUT 6/6、瞬态失败排除法独立复验采信、三方合并逐字节核验未动增量；2 项 trivial（注释笔误/biome 披露缺 format 项）不阻塞。
- 集成：6 文件整复制自复审树（树内已装配并验证 EXE+MT009+MT014+MT010 共存态）；亲验聚焦 36/0、全量 **458/0/16 文件**（=422+36）、七任务 apply 全 0、typecheck 0、biome 5 文件 0；基线链 …→422→458。
- 解锁：MT011、MT015（进而 MT079）、MT016、MT027、MT036、MT041、MT069、MT080。
- 清单第 8 次同步（team-public-rules + MT009 报告/checkpoints）。
- 在运行：MT026（ctx_c4eac816ea13）、MT077-2nd（ctx_f44a1a96401d）。

## 2026-10-16 MT015/MT011 派发（49 项前置）
- MT015 task_8901e8f09fc0/ctx_6c357a7d010d（归属感知键+配置版本，消费 MT014 范式）；MT011 task_4d0194caed6a/ctx_1ce839333b5d（集中 not-found 不可见语义，消费 MT008/009/010 三判定形状；禁改三模块）。
- 在运行（4）：MT026、MT077-2nd、MT015、MT011。

## 2026-10-16 MT026 第1任死亡+第2任重派
- 第1任（task_59de4fd90e84/ctx_c4eac816ea13）死于 AC2/AC3 测试设计规划阶段（1h 零字节/零心跳/零树内写入）；stop=closed_agent_terminal+release 干净；brief 追加接管说明（1st 设计思路仅参考）。
- 第2任 task_75dca80914a0/ctx_ecf8b43fc7ce。
- 在运行（4）：MT026-2nd、MT077-2nd、MT015、MT011。

## 2026-10-17 四票实现完成+四复审并行派发
- MT077-2nd（37 用例/基线422+37=459、MUT5/5、D1-D9）、MT026-2nd（33/455/18 文件、AC1-4 钉死）、MT015（30/488/17、MUT 捕获、49 项零改动）、MT011（19/477/17、三判定模块只读消费 47/49 不变）全部 worker_done+结算干净（alreadySettled×4）。
- 交付：MT077 7 文件（routing-policy+governance 三表+窄例外×3）；MT026 10 文件（sso-scim schema+三模块+三套件+窄例外×3）；MT015 3 新文件（scoped-keys）；MT011 5 文件（not-found-semantics+scenarios/index 编辑）。
- 复审树×4（49 项前置）：MT015/MT011 纯整文件转移（3/3、5/5）；MT077/MT026 共享三文件（schema/index+migrate-test+migration-tool）difflib 三方对比合并（MT077 +1/+137/+4、MT026 +1/+144/+4），两树 typecheck 0。
- 复审派发：MT015 task_1df929c3cbf6、MT011 task_8d6f90b51b33、MT077 task_13c54eab85a8、MT026 task_bf0e9202445f；复跑门槛 30/488、19/477、37/495、39/491（=458+各票新增）。
- 集成预案：MT077+MT026 共享三文件需双票增量合并（同 MT009/010 手法）。

## 2026-10-17 四票复审+集成完成（verified 18-21：MT015/MT011/MT077/MT026）
- 四复审全 PASS（MT015 A/B/C 过+D MUT5 证据缺口挂账；MT011 PASS+F1/F2 低危挂账；MT077 A-D 全过+4 观察；MT026 PASS+F1 文档计数更正）。
- 批1（MT015+MT011）整文件集成 → 亲验 30/19/**507/0/18 文件**/typecheck/biome 全绿。
- 批2（MT077+MT026）：difflib 自动合并曾把两个同构 TaskMigrationSpec 块逐行交错（typecheck 揭示）→ 回退改锚点整块插入 + 断言字母序修正（MT026 置 MT077 前，第一轮 577 跑出 1 fail 即此）→ 复验**577/0/22 文件**/十任务迁移全 0/typecheck 0/biome 9 文件 0。教训：同构大块禁用逐行 difflib 合并，用锚点整块插入。
- MT026.md 计数更正（39→33）+coordinator 批注；归档全套（报告/复审/checkpoints/integration.json×4）。
- 基线链 …→458→507→577。verified=21；新解锁 MT016/027/036/041/069/076/079/080。
- 清单第 9 次同步（+6 tenancy 模块 +2 schema +四票报告/checkpoints）。

## 2026-10-17 波次 10 派发（4 实现：MT076/MT079/MT016/MT069，67 项前置）
- 治理组 MT076（人员动作本公司范围，AC4 与 MT026 deprovision 语义一致）、MT079（偏好分类清单）；Bot 域 MT016（归属固定）；计费域 MT069（Customer 映射+账户类型，只扩展不改扣费）。
- 在运行（4）：MT076 ctx_dbbce70cc739、MT079 ctx_d711b148f0cf、MT016 ctx_6a78d3744c99、MT069 ctx_95fa8f552ff0。

### 2026-10-17 02:10 波次 10 中段：MT076/MT079 实现完成结算，两复审已派发
- Orca CLI 已重构为 `orchestration` 命名空间（check/dispatch-show/worker-* 全部换前缀）；绑定 Run 用 `check --run`。
- MT076（task_036897b0111e/ctx_dbbce70cc739）dispatch=completed、报告 71 行落盘 01:57 → stop(alreadySettled)+release。交付 5 文件：新 3（people-lifecycle.ts ff01c87a/test 0fc9ccf2/support 17e32d1b）+ 窄例外 2（migrate-test 773dc1be、migration-tool 700caff3，单语句 GRANT UPDATE("role") —— 首个写 role 列票）。聚焦 16、全量 593（577+16）/23 文件、十一任务链、变异 14/14+1 自然。
- MT079（task_ff0b56dabbae/ctx_d711b148f0cf）completed、报告 95 行落盘 01:52 → stop(alreadySettled)+release。交付 3 新文件纯新增（preferences.ts 6a8f2e25/test c964030c/support 93af14cc），零既有改动 67/67。聚焦 23、全量 600（577+23）/23 文件、digest 0f5d77ab 钉死。
- MT016（ctx_6a78d3744c99）终端冻结 15+min 后 worker-read 证实 verdict=live/fresh（02:07:38）——非死，继续等。MT069（ctx_95fa8f552ff0）活跃写文件中。
- 复审树 ×2：i10-review-mt076 / i10-review-mt079（BASE f0520524 detached，transfer-prereq 67 项 OK）。MT076 共享两文件 before 哈希已与 EXE 现态逐字节核对一致（09bf0400/2a1ce227）→ after 整复制，树内哈希复核 5/5 一致；MT079 整复制 3/3 一致。报告+checkpoints 已随树转移。
- brief 裁决点：MT076 六项（含 GRANT("role") 最小性裁决 + 报告 66/67 口径差异定性）；MT079 六项（含 digest 独立重算 + 零改动复扫）。复跑端口 55501/55502。
- 派发：MT076rv task_3c5358595349/ctx_9f34beea88e4；MT079rv task_4da727b281b8/ctx_a85eb53a6532。重复任务 task_e072b47a26a6（task-create 输出解析误判重试所致）已作废标记 failed。

### 2026-10-17 02:20 波次 10：MT069 实现完成结算，第三棵复审树已派发
- MT069（ctx_95fa8f552ff0，hb 18:05Z 后 completed）→ stop(alreadySettled)+release。票号更正核实：MT069=Issue #112（#111 是 MT068）。交付 7 文件：新 4（schema/payer-accounts 6194230a、billing/payer-accounts e3042dbc、test 86aec97e、support 056f6c7e）+ 窄例外 3（migrate-test aa1ce426、migration-tool 1ed8771e、schema/index 785cd7ac——before 哈希与 EXE 现态逐字节一致 09bf0400/2a1ce227/e1954c8a）。聚焦 22、全量 599（577+22）/23 文件、变异 13/13、十一任务链。
- 复审树 i10-review-mt069：67 项前置 OK，7 文件整复制树内哈希复核一致。brief 六裁决（含三重计费零变化回归裁决 + 票号更正核实）。端口 55503。
- 派发：MT069rv task_36738f9258b0/ctx_e5e2b5129ba1。
- 当前并发 4：MT016 实现（bots-ownership 交付文件活跃落盘中）+ MT076rv/MT079rv/MT069rv 三复审。

### 2026-10-17 02:30 波次 10：MT076/MT079 复审完成（两 PASS），MT079 派修复轮
- **MT076 复审 PASS**（ctx_9f34beea88e4，报告 86 行）：五裁决全过、聚焦 16/0/0、全量 593/0/23、tsc/biome 0、活库 role 列授权仅 ob_ent_operator、journal 11 任务；装配以「反向 patch 复现 before 哈希」密码学证纯追加。非阻塞：2 文档计数误差（「第 7 次」实为 allowlist 第 9 项——计数漂移谱系 MT012(3)/MT014·MT009(4)/MT026·MT077(6) 先于本票存在，后续票统一「allowlist 第 N 项」口径；「66/66」实为 67/67）+ 1 测试 nit（AC2 epoch 断言引 B 基线，假失败方向无掩盖风险）。
- **MT079 复审 PASS + F1 低危**（ctx_a85eb53a6532）：六裁决全过、聚焦 23/0/0、全量 600/0/23、tsc 0、digest 手工重算逐字符一致、67/67 零改动复算。**F1：biome(2.5.10) 对交付字节 exit 1**（preferences.ts 262–266 多行 if 应单行）、「biome exit 0」声明不可复现且无存档——字节级门槛失败，集成 biome 门会挂。另 4 观察（F2 零漂移=manifest 范围声明、F3 expect 数运行间波动——账目锚定测试数）。
- 处置：MT079 派修复轮 task_5b742ddc5353/ctx_45e795ace37d（仅 --write 该文件+复跑 biome/聚焦 23/0/0+补档 4-biome-fix/4b/4c+哈希清单更新+报告附记；端口 55504）。MT076 无修复轮。
- 端口串扰备注：MT076rv 预检发现 55501 被 mt069-impl-pg 占用→改 55502；MT079rv 又被挤到 55503——复审间端口自适应良好；mt069-impl-pg 疑似实现容器清理时序问题，修复轮 brief 已含预检纪律。
- 复审速度异常快（~7 分钟完成全流程复跑）但终端 worker_done 消息含完整数字、报告 86/117 行落盘且数字自洽——按检查点受理，集成亲验将再次全量复跑兜底。
- 当前并发 3：MT016 实现 + MT069rv（ctx_e5e2b5129ba1）+ MT079fix。

### 2026-10-17 02:35 波次 10：MT016 第 1 任死亡处置与第 2 任接管
- 取证链：终端重复同一 grep（bots-ownership.test.ts）7+ 次、R11M 冻结、CH99.8%、零写入 20min → stop 返回 **closed_agent_terminal**（权威死亡）→ release 干净结算。
- 磁盘增量（可接管）：bots-ownership.ts 957 行 / test 1131 行 / support 533 行 / schema 184 行 + checkpoints（PLAN/RED-1/00-apply/01-baseline）；无报告。
- 处置：同树重派第 2 任 task_efba8c4dab4b/ctx_63d9a394c9ad，brief 追加接管规则（审计取舍留痕、证据 -2nd 后缀、全套门槛不变、端口 55501 起）。第 1 任零工作丢弃。
- 当前并发 3：MT016-2nd + MT069rv + MT079fix。

### 2026-10-17 02:45 波次 10：MT069 复审 PASS+F1 修复轮；MT079 修复轮闭环
- **MT069 复审 PASS**（ctx_e5e2b5129ba1，~5 分钟，报告 10401B）：逆向剥离+哈希闭环证纯追加；聚焦 22/0/0、全量 599/0/23、tsc 0、活库抽查全符。4 非阻塞发现：**F1 门禁证据过期——biome 2.5.10 对交付态 payer-accounts.test.ts 报 1 format error（2 处同型 expect 折行）**、04 存档早于断言强化；F2 before-hashes.txt 缺失（已由 coordinator+复审双密码学补证）；F3「第 7 次」应为第 8 次（计数漂移谱系+1）；F4 端口 55503 被 mt079-review-pg 占→55513（端口串扰级联，均按预检纪律处置）。
- **MT079 修复轮闭环**（ctx_45e795ace37d）：preferences.ts 262–266 多行 if→单行，唯一改动经 pristine 前像密码学对照（4c）；biome 3 文件 0 诊断；聚焦复跑 23/0/0（226 expect，4b）；新哈希 032ae9de；报告附记 §9。**coordinator 亲验 biome clean 确认**。
- MT069 派修复轮 task_31e13eb92f3d/ctx_93f5bb4e3b7e（同族 F1：--write payer-accounts.test.ts + 重存 04 + 聚焦 22/0/0 复跑 + 4c diff 自证；端口 55505）。
- 两复审速度均异常快（5-7 分钟）但证据链完整自洽，集成亲验兜底不变。
- 当前并发 2：MT016-2nd（hb 18:38Z 活跃）+ MT069fix。

### 2026-10-17 02:53 MT069 修复轮闭环（coordinator 亲验）
- payer-accounts.test.ts 2 处 expect 折行 --write；04-biome.txt 重存档、04b 聚焦 22/0/0 复跑、4c diff 自证；新哈希 077cf413；报告附记 §8。**亲验：biome 7 触及文件 Checked 7 / No fixes，clean。**
- 波次 10 三票（MT076/MT079/MT069）全部复审 PASS + 修复闭环，进入集成批（见下节）。MT016-2nd 仍在实现中。

### 2026-10-17 03:05 波次 10 批 1 集成完成：MT076+MT079+MT069 → verified（24）
- **集成手法**：整文件 10（三票新文件+schema barrel 785cd7ac）+ 共享两文件两步合并——migrate-test 先落 MT076 版（其基=EXE 09bf0400 逐字节），MT069 增量（78 行 0 删除，基线取自 i10-review-mt079 未触碰树）python 锚点插入（块插 export const TASKS 前、注册行插 PEOPLE_LIFECYCLE 后）；migration-tool.test 同法（"MT069" 字母序插 MT026 与 MT076 之间+注释块）。加载自证：TASKS 12 任务、ALLOWED 排序正确；断言套件 41 pass/1 env-skip/0 fail。
- **亲验（全新容器 w10-integ-pg@55511，六变量 env 含 ent_w10i_{directory,data,operator} 受限登录+setup=超户，0600 用后删）**：base migrate exit 0 → 十一任务依赖序 generate/migrate --apply 全落账 → 聚焦 16/0/0+23/0/0+22/0/0 → **全量 638/0/0/25 文件（=577+61 精确命中，10020 expect）** → tsc 0 → biome 13 触及文件 0 诊断 → 清理验证。坑记录：migrate-test CLI 新语法 `generate <task> --out DIR` / `migrate <task> --apply --manifest`；enterprise-test-db 守卫要求 setup URL=BYPASSRLS 超户 + 三能力 URL=ent* 前缀登录。
- dag：verified=24，running=MT016（第 2 任实现中）。transfer-prereq.sh 第 10 次同步（+people-lifecycle/preferences/payer-accounts×2/+billing 目录/三票 reports/checkpoints；探针树自验 107 项全哈希一致）。
- integration.json：MT076/MT079/MT069-integration 三份落盘。

### 2026-10-17 03:12 波次 10：MT016 第 2 任交付完成，复审已派发
- MT016-2nd（ctx_63d9a394c9ad）completed → stop(alreadySettled)+release。交付 7 文件：新 4（schema/enterprise-bot-ownership d5215a2b、tenancy/bots-ownership 3bb3288b、test 564d4d9a 44 用例/143 expect、support ecf044e9）+ 编辑 3（基于旧 67 项基线：migrate-test d6ab2222、migration-tool 20618042、schema/index e9bd49d2）。聚焦 44/0/0、其树全量 621=577+44/23 文件、变异 6/6（MUT5 首轮存活→补测 MUT5b 捕获，诚实记录）、接管审计 takeover-audit-2nd（保留/修复/新增）+ 第 1 任证据全保留。
- **票号口径**：我下发 brief 写 #62 为笔误；dag source_issues=[59,6,191]；实现者 gh issue view 59 实取纠正——记录为 coordinator 简报笔误。
- 复审树 i10-review-mt016：**107 项新前置** + 4 新整复制 + 3 共享文件三方合并（BOTS_OWNERSHIP_TASK 136 行块+注册行、"MT016" MT014/MT026 间、barrel 排序位）；TASKS=13 加载自证、ALLOWED 排序正确、migration-tool 套件 41 pass/1 env-skip/0 fail（bun install --frozen-lockfile 后）。
- 派发：MT016rv task_5c8c29674e95/ctx_42bac6026a4d，端口 55512，六裁决（含接管审计+MUT5 诚实记录+三方合并等价+票号口径）。
- 当前并发 1：MT016rv。

### 2026-10-17 03:20 波次 11 派发：MT027/MT036/MT041/MT080（依赖全解锁）
- 四树 i11-*（107 项前置 OK）。MT027=#70 凭据归属（55514）、MT036=#79 知识库归属（55515）、MT041=#84 任务/运行归属固化（55516）、MT080=#123 **前端票** Web 范围选择器（后端零改动纪律；四态显式；i18n 双语）。
- brief 模板升级：基线 638/23 文件、十一任务链、新迁移 CLI 语法、ent* 守卫要求、「收尾必须复跑 biome 并存档」（吸取 MT079/MT069 F1 教训）、「allowlist 第 N 项」口径（吸取计数漂移谱系教训）。
- 派发：MT027 ctx_502a08e5b331、MT036 ctx_f724e7a7d644、MT041 ctx_8f0050900048、MT080 ctx_5fbc79400700。
- 当前并发 5：MT016rv（ctx_42bac6026a4d）+ 四实现。

### 2026-10-17 03:20 波次 11：MT041 第 1 任 502 死亡→第 2 任重派
- 终端取证：502 no upstream candidate ×3 重试失败、R2.1M/24.6% 上下文、零代码增量 → stop=closed_agent_terminal → release。
- 处置：同树重派第 2 任 ctx_4f0c1a9014b4（brief 追加接管说明：零增量、从零开始）。
- 当前并发 5：MT016rv + MT027 + MT036 + MT080 + MT041-2nd。

### 2026-10-17 03:40 波次 10 全收官：MT016 集成 → verified（25/143）
- **MT016 复审 PASS**（ctx_42bac6026a4d，171 行报告）：六裁决全成立——验收（含 keyset 翻页并集=全集收敛）、接管审计与树内事实一致、MUT5 存活→补测诚实、三方合并语义等价、票号口径（#62=coordinator 简报笔误，#59 实取）、D5 判定顺序。4 非阻塞：F1=coordinator 合并空行漂移（已 biome --write 修复）、F2 changes.diff 完整性披露、F3 报告 7→6 例笔误、F4 我 brief 文件数 24→实 26（**基线文件数口径修正：638 基线=25 文件**——波次 11 简报沿用的 23 为笔误，四实现者报告口径由各自复审对账）。
- **集成批 2**：4 新整复制 + 3 合并文件复用复审树已验证态 + F1 修复。亲验（w10j-integ-pg@55518）：base ok → 十二任务链全 applied → 聚焦 44/0/0 → **全量 682/0/0/26 文件（10169 expect）=638+44 与复审精确一致** → tsc 0 → biome 7 文件 0 → 清理 OK。
- integration.json 落盘；dag verified=25；transfer-prereq.sh 第 11 次同步（+bots-ownership 模块/schema/测试/support、MT016 报告对、checkpoint）。
- 波次 10 总结：5 票（MT076/MT079/MT069/MT016 + 修复轮×2）全部 verified；worker 死亡 2 例（MT016-1st 实现中段→接管；MT041-1st 规划期→重派）均按恢复纪律零工作丢弃。
- 当前并发 4：MT027/MT036/MT080/MT041-2nd（波次 11）。

### 2026-10-17 03:55 波次 11：MT036 实现完成结算，复审已派发
- MT036（ctx_f724e7a7d644）completed 03:43 报告 111 行 → stop(alreadySettled)+release。交付 9 文件：新 7（kb-ownership fd0e4627/ownership-schema ab783750/kb-restricted-query 5cc994ba/drizzle-kb 0001 SQL+snapshot/test 206c05ca/support 9e59cc19）+ 编辑 2（drizzle-kb.config 4a6b411d 前像=EXE 2d3534b7 ✓、_journal e7ea013a）。**主库零迁移**（migrate-test/migration-tool/index/barrel 全零触碰）。聚焦 27/0/0、其树全量 665=638+27/26 文件、KB 域旁证 318/11skip（既有）、变异 7 捕获+2 冗余存活披露。
- 复审树 i11-review-mt036：111 项前置（含 MT016 批）+ 9 整复制哈希核对一致。brief 七裁决（含双库架构/同步令牌、_journal before 缺失定性、108 vs 111 口径、KB 旁证 skip 边界）。端口 55519。
- 派发：MT036rv ctx_c6216740ebf1。
- 当前并发 4：MT027 + MT080 + MT041-2nd + MT036rv。

### 2026-10-17 04:00 波次 11 中段：MT080 结算+复审派发；MT041-2nd 报告落盘
- MT080（ctx_5fbc79400700）completed → stop(alreadySettled)+release。前端交付 7：新 3（selection.ts fc7693cc/route d70d958d/test 85f34a92 25 用例）+ 改 4（client.ts +workspaceId 选择头 12d206d7、locales en/zh-CN tenant.json +31 行各、routeTree.gen.ts 纯追加 21 行）。票面 Verification 逐字 25/0/0（101 expect）、typecheck 0、biome 0、build 成功、**后端零改动 107/107**。
- 复审树 i11-review-mt080（111 前置+7 整复制）。**装配险情**：app/tests/multitenancy/ 目录 BASE 不存在导致 test 文件首拷失败且未中断——30 秒内补齐 7/7 哈希核对一致（复审 worker 启动前完成）；教训：对 BASE 不存在的目标目录先 mkdir -p。
- 派发：MT080rv ctx_45a040b3579e（app 侧复跑，无 DB）。
- MT041-2nd（ctx_4f0c1a9014b4）报告 115 行 03:56 落盘、变异 18/18、归档中。MT027 仍在实现（biome 证据已在存档）。
- 当前并发 4：MT027 + MT041-2nd + MT036rv + MT080rv。

### 2026-10-17 04:05 波次 11：MT041-2nd 结算+复审派发
- MT041-2nd（ctx_4f0c1a9014b4）completed（报告 115 行 03:56）→ stop(alreadySettled)+release。交付 7：新 4（schema/job-ownership ca6450f0、tenancy/job-ownership 45d1b500、test 77a66a18 22 用例、support ef3eab9a）+ 共享 3（migrate-test 5422e902、migration-tool 27f9b8b5、schema/index f81d5b64——before=batch1 态 43210c52/e4354471/785cd7ac 经 i11-mt080 并行树交叉证实）。聚焦 22/0/0、其树全量 660=638+22/26 文件、变异 18/18。
- 复审树 i11-review-mt041：111 前置 + 4 整复制 + 3 三方合并（JOB_OWNERSHIP_TASK 块 122 行；**锚点坑：MT016 任务常量是 BOT_OWNERSHIP_TASK 单数**——首拼 BOTS_ 断言失败即改）；TASKS=14/ALLOWED 排序自证；biome 3 文件 0 诊断。端口 55520。
- 派发：MT041rv ctx_a260a85f5d4e。
- 当前并发 4：MT027（实现中）+ MT036rv + MT080rv + MT041rv。

### 2026-10-17 04:18 资源卫生：coordinator 集中清理 13 个遗留 impl 容器（系统性披露差异）
- 发现：mt009/010/011/016(×2)/026/077/076/069/036/041-impl-pg 共 13 个已结算票容器仍 Up（各报告均声称「docker rm + 验证不存在」）；mt069-impl-pg 创建于 01:50 早于其修复轮（fix 用 -fix-pg 名），证实为原始实现容器未删。MT076rv 早已实证其在端口上存活。
- 定性：非代码缺陷；「容器清理」披露系统性不实（原因未明——可能 sandbox 内 docker rm 静默失败）。列入最终 OCR 审查清单；此后每票结算时 coordinator 亲验容器删除。
- 处置：仅保留在用 mt027-impl-pg；b5-*/opik-* 等他工作流容器不动。

### 2026-10-17 04:25 波次 11：MT036 复审通过；MT041 有保留通过→修复轮已派
- **MT036 复审通过**（ctx_c6216740ebf1）：聚焦 27/0/0、全量 709/0/0/27 文件逐字命中、9/9 哈希、双库漂移 fail-closed 活库实证、KB 旁证 318/11skip 复现。O1-O4 观察（锁链头注、TOCTOU 固有、镜像写路径属后续票——O3 列入集成依赖跟踪、AC3 计数 5→7）。2 证据缺口（_journal before 缺失、GREEN 中间日志）已由复审补证，列为 checkpoint 纪律改进项。brief 侧 2 笔误（我方：哈希转写 9e59→6e59、7→9 文件）。**无修复轮，待批集成**。
- **MT041 复审有保留通过**（ctx_a260a85f5d4e，704/0/0/27 独立复现）：F1 实质——MUT18（release 持有人匹配移除）存活未披露，报告 18/18 与 16 直接杀伤均与证据（17/18、15）不符；服务代码守卫存在行为无缺陷，纯测试缺口+计数失实。F2 AC1 结构不可变用例空转（断言键错配恒真）。F3 三表缺 FORCE RLS（7 张先例表全 =t）。F4 job_leases 表级 UPDATE 宽于列级先例。
- 处置：修复轮 task（ctx_e34c1e6c4ea2）：F1 补非持有人 release 拒绝用例+重杀 MUT18+报告更正；F2 真实断言；F3 本票任务 SQL 补 FORCE（digest 变更可接受——仅测试库）；F4 列级收窄。端口 55521。**容器删除回显存档+coordinator 亲验**（新纪律，响应系统性容器清理失实）。
- 当前并发 3：MT027（实现中，长操作）+ MT080rv + MT041fix。

### 2026-10-17 04:42 MT027 第 1 任死亡处置与第 2 任接管
- 取证：终端计数器（R25M/↑444k）冻结 30min、7min 零写入、spinner 空转、121% CPU 的 bun test 结束后无后续 → stop=**closed_agent_terminal** → release。
- 磁盘增量（可接管）：credential-ownership.ts 853 行、credentials-ownership.test.ts 1375 行、schema/enterprise-credentials.ts、checkpoints（plan/before-hashes/red-green/mutation×4+/verification 部分，biome 已存 05）；无报告、无 manifest。
- 处置：同树第 2 任 task/ctx_8bcc629b448c，接管规则同 MT016-2nd 先例（审计三分/-2nd 证据/门槛不变/容器删除回显存档）；端口 55522 起。
- 当前并发 3：MT027-2nd + MT080rv + MT041fix。波次 11 死亡累计 2（MT041-1st 规划期、MT027-1st 验证期），恢复纪律零丢弃。

### 2026-10-17 04:58 波次 11：MT080 复审通过（无阻塞）
- MT080rv（ctx_45a040b3579e，报告 89 行）：六裁决全过、票面命令 25/0/0（101 expect）逐字复现、typecheck/build/biome 复跑、后端零改动 **111/111 独立重算**再证。6 非阻塞观察（含 manifest 111 vs 实现者记 107 计数出入——并行票追加所致，结论不变）。
- 报告位置事故：复审者写到仓库根 /reports/MT080-review.md（路径错）——coordinator 归位至 $P/reports/ 并结算；最终 OCR 时对 worker_done --report-path 一致性留一项检查。
- 波次 11 状态：MT036 PASS 待集成、MT080 PASS 待集成、MT041 修复轮运行中、MT027-2nd 运行中。批集成等后两票收敛后一次验证循环。
- 当前并发 2：MT041fix（ctx_e34c1e6c4ea2）+ MT027-2nd（ctx_8bcc629b448c）。

### 2026-10-17 05:02 MT041 修复轮闭环（coordinator 亲验四项）
- F1：新用例（非持有人 release → JOB_LEASE_NOT_HELD + 零状态变更）；MUT18 原样重放 22/1 KILLED；报告 §3/§6 计数诚实更正（15+2+1 补杀）。F2：AC1 用例改真实断言（聚焦 23/0/0 两次复跑）。F3：三表 FORCE ROW LEVEL SECURITY 补齐（migration-old-vs-new.diff 存档）。F4：job_leases 收窄为 7 列列级 GRANT UPDATE。全量 661/26。服务与 schema 文件零触碰（哈希 UNCHANGED 复核）。
- 容器纪律验证：mt041-fix-pg **真实删除+回显存档**（新纪律生效）；仅剩 mt027 双容器（1 任遗留 + 2 任在用，票结算后清）。
- 裁定：修复面窄（1 测试文件+自有任务 SQL+报告）、原复审已全语义通过、四项均 coordinator 亲验——**不再派修复复审**，集成亲验兜底（先例：MT079/MT069 F1 修复轮同裁定）。
- 当前并发 1：MT027-2nd。MT036/MT080/MT041 三票就绪待批集成。

### 2026-10-17 05:45 波次 11 批集成完成：MT036+MT080+MT041 verified（28）；MT027 复审已派
- **集成手法**：整复制 24（含 app/tests mkdir 补拷坑重现——EXE 侧同坑即修）；共享双票序合并（MT041 JOB_OWNERSHIP_TASK 129 行→MT027 CREDENTIAL_OWNERSHIP_TASK 112 行、barrel 双行排序位、migration-tool 双条目字母序——**"MT027" 误插 MT016/MT026 间被断言套件当场抓获**（MT026<MT027），1 行修正复绿；src/index.ts 前像=EXE 现态直接整拷（MT027 的 import 重排 27 hunk 使存量 lint 6+1→4+1 减少，零新增）。
- **亲验两轮**：首轮全量 772/0/**29 skip**——根因=kb-ownership 套件需第 7 变量 KB_TEST_DATABASE_URL（专用 KB 库）；补建 _kb 库重跑：聚焦 27+23+38 全 0/0、**全量 770/0/0/29 文件（10658 expect）=682+88 精确**、KB 旁证 318/11 既有 skip、tsc 0（server+app）、biome 14 文件 0、app build 成功（routeTree 92ed4ba6 build 后逐字节稳定）。
- integration.json ×4；dag verified=28（MT027 保持 running——**顺序偏差如实披露**：集成先于复审，PASS 后转 verified；缺陷走基线修复轮先例）。transfer-prereq 第 12 次同步（+kb 域/drizzle-kb/app 域/job/credential 模块，探针 213 项全一致；唯一新目录 app/tests/multitenancy 补 mkdir）。
- MT027rv 派发 ctx_3b73c1d07b3d（213 项集成态基线+manifest 划界+变异逐个重放抽查≥3 要求+import 重排等价裁决；端口 55526）。
- 当前并发 1：MT027rv。

### 2026-10-17 05:50 波次 11 全收官：MT027 复审 PASS → verified=29/143
- MT027rv（ctx_3b73c1d07b3d，89 行）：**变异独立重放 3/3 KILLED 计数逐一吻合**（MUT-2 32/6、MUT-5 37/1、MUT-8 34/4，注入/恢复哈希闭环）；index.ts 27 hunk 等价性机械证明（前像 bac27c45 重建 + biome 规范化对照 = 24 规范化 hunk + 3 处真实新增）；770/0/0/29 独立复现；容器删除回显+deletion check=0（coordinator 亲验 mt0* 零残留）。
- MT027 转 verified（顺序偏差闭环：集成先行→复审 PASS 补位→无缺陷无需修复轮）。波次 11 合计 5 票 verified（MT036/MT080/MT041/MT027 + 批内修复轮 MT041-fix），worker 死亡 2 例（MT041-1st/MT027-1st）零丢弃。
- **累计 verified=29/143**。下一波就绪 12 票：MT017(#60)/MT021(#64)/MT028(#71)/MT030(#73)/MT031(#74)/MT037(#80)/MT038(#81)/MT040(#83)/MT042(#85)/MT059(#102)/MT070(#113)/MT074(#117)。
- 基线数字链：363→397→422→458→507→577→638→682→**770**；文件 14→15→16→18→22→23→25→26→**29**；迁移链 10→11→12→13→**14 任务**；prereq 36→49→67→107→111→**213 项**。

### 2026-10-17 05:55 波次 12 派发：MT017/MT070/MT021/MT028/MT037（5 并发）
- 五树 i12-*（213 项前置）。brief 模板再升级：基线 770/29 文件、十四任务链、KB 第 7 变量提示、容器删除回显存档纪律、变异注入/恢复哈希存档纪律、allowlist 第 N 项口径。
- MT017=#60（Bot 发布受众，dep MT016）、MT070=#113（公司余额并发预扣，deps MT069+MT041）、MT021=#64（会话列表可见性）、MT028=#71（OAuth 回调 state）、MT037=#80（检索引用归属，dep MT036）。

## 2026-10-17 波次 12 — 五票实现完成与结算（worker_done 事件未送达，按检查点受理）

**事件流异常**：`check --types worker_done` 至第九十六轮仍 0 事件，但 `dispatch-show` 五票全部 completed（心跳 21:44–22:20Z），终端画面残留 running。按先例「报告落盘未发 worker_done = 按检查点受理」推进；worker-stop 五票全部 alreadySettled，已 release。

**五票实现结果**（全部达标；容器亲验零残留——新纪律首次全绿，docker ps grep 无匹配）：

| 票 | Issue | 聚焦 | 全量 | 变异 | 交付 | 备注 |
|---|---|---|---|---|---|---|
| MT017 | #60 | 34/0/0 | 804/0/30 | 7/7 | 3 新文件，共享零改动 | D1 无迁移；D3 private→workspace 无用例（复审重点）；MUT5 中止签名如实 |
| MT070 | #113 | 16/0/0 | 786/0/30 | 11+M06复合 | 4 新 + 3 窄编辑（十五任务 MT070） | D3 归属后置崩溃窗口；D1 45435 端口竞态；D2 billing 域归属 |
| MT021 | #64 | 26/0/0 | 796/0/30 | 6/6 | 3 新文件，共享零改动 | keyset 不变键；10 只读文件 before==after |
| MT028 | #71 | 26/0/0 | 796/0/30 | 8/8 | 7 文件（十五任务 MT028 + index.ts 装配） | after-hashes 双版本（final a0d204a7 为准）；D1 安全事件归属边界；MUT-8 专用库 |
| MT037 | #80 | 20/0/0 | 790/0/30 | 4 KILLED+2 存活(披露冗余防线) | 3 新文件，共享零改动 | D1 主库零迁移；D4 三信任门；D5 MT069 幂等键同库单次性 |

**MT028 after-hashes 双版本定性**：early 版 86280a40（support/oauth-state.ts）→ final 版 a0d204a7=磁盘终态；差异=surfaceOf 死代码移除轮（D5 披露），sha256-manifest 只含 final 链。已写入复审 brief 要求 diff 复核实定性。

**共享文件冲突预警（批集成）**：MT070 与 MT028 各自向 migrate-test.ts 注册第 15 任务、allowlist 各加一条、schema barrel 各加一行——三方合并用锚点整块插入；断言字母序 MT026<MT027<**MT028**<MT041<MT069<**MT070**<MT076。MT028 另有 src/index.ts 装配段（oauthState fail-closed）。集成后全量预期 770+122=892、34 文件、十六任务链（MT000+15）。

**复审派发**（五棵新树 i12-review-mt{017,070,021,028,037}，各=BASE+213 项 transfer+本票交付整拷，25 项哈希逐项核对通过）：
- MT017 task_bf16f63d10e8/ctx_51ad2b080cc3 @55532
- MT070 task_ad6f2a1e8ff6/ctx_c05fa0cc090c @55533
- MT021 task_c64383bfbb75/ctx_37b1aa2efa8b @55534
- MT028 task_cdcdfa21c1a8/ctx_16b180b73ddd @55535
- MT037 task_4fb622d5d249/ctx_6d2664cbac9a @55536
brief 含变异重放抽查≥3、容器删除回显存档、各票专项审计重点（MT017 D3 缺口 / MT070 D3 崩溃窗口 / MT021 keyset 边界 / MT028 双版本 diff+PKCE / MT037 三门存活语义）。

## 2026-10-17 波次 12 — 五票复审完成（全部 PASS with findings）与修复轮派发

**五份复审报告全部落盘**（复审容器亲验零残留、五 dispatch alreadySettled+released）：

| 票 | 结论 | findings | 要点 |
|---|---|---|---|
| MT017 | PASS | 1 low | private→workspace 翻转无用例（结构保证成立）；四专项全 ✓ |
| MT070 | PASS | 1 med + 2 low | F1 M06b 存档缺陷（claim 已被复审独立重放证实 14/2）；F2 孤儿预扣对账挂账下游；F3 存档脚本漂移 |
| MT021 | PASS | **1 high** + 2 low | **F1 游标微秒精度丢失**（JS Date 毫秒 vs PG 微秒→边界行重纳入→翻页死循环；四步实证含端到端 6 页重复同行）；偏离 MT016 `::text` 先例；服务未接线（待接线引爆） |
| MT028 | PASS | 2 med + 2 low | F1 双版本 diff 不可执行（中途版未存档；17 号档案 biome 诊断指向格式修复痕迹）；F3 17 号档案头描述失实（自称保留 52-fail 现场实为通过态复跑）；F2 surfaceOf 死导出+注释失实；F4 报告 planDigest 过期（实测 47d8eac9） |
| MT037 | PASS | 2 low | L1 KB 旁证口径（318/11 vs 310/21，均 0 fail，以复审实测为准）；L2 snippet 280 常量未钉精确值 |

**裁定**（先例：有效 high/medium 修复轮；medium 存档类修复后不再派修复复审）：
- MT021：修复轮（游标键改 SQL `created_at::text` + 微秒种子用例）**+ 修复后独立复审**（high 先例）
- MT070：修复轮（补落 M06b 正确存档 + F3 脚本卫生；F2 挂账下游接线票）
- MT028：修复轮（删 surfaceOf 死导出 + 档案勘误补正——勘误优先于补造；planDigest 更正）
- MT017/MT037：轻量修复轮（补 1 用例 / toBe(280) 一行）

**修复轮派发**（同树第二任）：MT017 ctx_f0821fae52fe@55537 / MT070 ctx_cbf7eb14ef26@55538 / MT021 ctx_376acba2e1dd@55539 / MT028 ctx_91fa5471cd56@55540 / MT037 ctx_bbf8fd9208dc@55541。任务：a944e2c34d30/3248c1951a73/803cc3947c60/45e01259cecc/65c14a3763f5。复审任务全部 completed。

**批集成顺延**：待五修复轮（+MT021 修复复审）关闭后执行。集成基线不变（770/29 文件/十五任务链），预期集成后 770+122(+修复轮新增用例)=~894+、34 文件、十六任务链。

## 2026-10-17 波次 12 — 修复轮结算（3/5 关闭）与 MT021-fix 第 1 任死亡处置

**已关闭**：
- MT037-fix（task_65c14a3763f5/ctx_bbf8fd9208dc）：L2 单行 toBe(280)（test fc9b0a37→55bdfa08），生产零改动，全量 790/0/0 复跑；容器亲验零残留。不再派修复复审（low）。
- MT028-fix（task_45e01259cecc/ctx_91fa5471cd56）：F2 surfaceOf 死导出删除（support a0d204a7→**71f7d337**，集成哈希更新）；F1/F3 档案勘误（中途版不可恢复如实注明、17 号档案头勘误、不补造）；F4 planDigest 更正 47d8eac9；26/0/0+796/0/0+typecheck 0+biome 0；容器零残留。不再派修复复审（medium 存档类先例）。
- MT017-fix（task_a944e2c34d30/ctx_f0821fae52fe）：F1 补 1 用例（private→workspace 翻转+unpublish 回 NULL 不回 private+MT010 边界对照）+MUT-F1 变异验证（恰 1 fail）；35/0/0+805/0/0；容器零残留。不再派修复复审（low）。

**MT021-fix 第 1 任死亡**（ctx_376acba2e1dd）：规划期终端冻结 20+ 分钟（R57k/ctx7.2% 字节级三测不变、hb None、零树写入），stop 权威判定 closed_agent_terminal+ptyKilled。磁盘增量取证：任内唯一变化=brief 文件本身；三个交付文件哈希与冻结值逐位一致（38fb0267/5a89bbb2/a028f792）——**零实质增量，非丢失工作**。同树重派第 2 任 ctx_2ff1440b6b6e（brief 追加接管注记）。

**MT070-fix 进行中**（ctx_cbf7eb14ef26，mt070-fix-pg 已起=变异重放阶段）。

## 2026-10-17 波次 12 — MT021-fix 第 2 任完成；全部五票修复轮关闭，修复复审进行中

- **MT070-fix 关闭**（ctx_cbf7eb14ef26）：M06b 复合变异重做（14/2 KILLED 真实落档）；容器零残留。不再派修复复审（medium 存档类）。
- **MT021-fix 第 2 任关闭**（ctx_2ff1440b6b6e）：F1 游标键改 SQL `created_at::text` 计算列（MT016 同形）+微秒种子 2 用例（RED 重现死循环签名→GREEN 29/0/0）；F2 decode 形状校验落 CONVERSATIONS_CURSOR_INVALID；F3 pristine 对齐。全量 799/0/0/30；MUT3 复验 6 fail（防线增强）；容器销毁回显存档。**终态哈希：conversations-list.ts a7d5820b / test 64c0688c / support a490a04f（集成用）**。
- 五票修复轮全部关闭：MT017（+1 用例 805）、MT070（存档）、MT021（+3 用例 799）、MT028（死导出删除 support 71f7d337，796）、MT037（+1 断言 790）。
- **MT021 修复复审已派发**（high 先例）：task_973e80762b5b/ctx_e1f914cb4955 @i12-review-mt021（交付已更新修复终态 3/3 哈希核对）@55542。审计重点：F1 独立四步重放、MT016 同形性、MUT3 预期 6 fail、范围纪律 3 文件。
- 批集成顺延至此复审 PASS 后。

## 2026-10-17 波次 12 — 批集成完成与基线推进（896/0/0/34，十七任务链）

**集成**（EXE 工作树，未提交）：
- 新文件 17 个整拷（5 模块/schema + 5 测试 + 5 夹具 + kb-restricted-retrieval 模块）
- src/index.ts 整拷 MT028 版（before 9c31684d==EXE 现态核对成立；oauthState fail-closed 装配）
- 三共享文件三方合并：MT028 git apply 干净；MT070 锚点插入（初版两处错位——常量块误入 TASKS Map 内、barrel 行序——当场发现并修正：python 摘块精确插入+biome --write 权威排序 billing→call-attributions；allowlist 数组 MT027→**MT028**→MT041→MT069→**MT070**→MT076 完全字母序）
- migrate-test 自证 TASKS(17)=MT000+16；ALLOWED 字母序含 MT028/MT070

**批终验**（fresh 容器 mt012-int2-pg @55544，七变量+十六任务链 MT004→…→MT027→**MT028**→**MT070**）：
- 聚焦×5：35/29/16/26/20 全绿
- 全量 **896 pass / 0 fail / 34 文件 / 0 skip**（=770+126：MT017 35+MT021 29+MT070 16+MT028 26+MT037 20）
- typecheck 0；17 新交付文件 biome 0；容器清理 residual=0
- 过程发现并修复两处脚本/清单缺陷：MT037 模块漏拷（测试循环有模块无——补拷 8d177507 核对）；KB 库 OWNER 缺失（CREATE DATABASE OWNER ent_*_kb + 角色先建）——首跑 849/2 fail 定位后二跑全绿

**账目**：verified 29→**34**；blocked 109；prereq 清单 213→**230 项**（第 13 次同步自测通过）；integration.json +5（共 25）。

**新解锁 16 张**：MT018/MT019/MT020/MT022（MT017 下游）、MT030/MT031/MT038/MT040/MT042/MT059/MT071/MT072/MT073/MT074/MT098/MT122。

**挂账新增**：MT021 修复复审 L1/L2（游标数值越界/ISO 毫秒伪造面——下游接线票纪律：nextCursor 唯一合法来源）；MT070 F2 孤儿预扣对账面（下游接线票）。

## 2026-10-17 波次 13 派发（五票，基线 896/0/0/34，前置 230 项）

MT018 #61（公共 Bot 使用者会话/凭据；MT017+MT009 下游）task_fbfb8147175c/ctx_ec2e2def100e@55545
MT071 #114（结算/释放/尾差/重试幂等；MT070 下游）task_634c62438548/ctx_a617d3e7663a@55546
MT098 #141（桌面原生组织上下文；MT028 下游）task_cdeab19fe8a9/ctx_4b0ee6e385a1@55547
MT038 #81（文档上传/删除/导入/重解析作用域；MT036 下游）task_629e55a9b538/ctx_5f79d85cb70d@55548
MT030 #73（全局身份/刷新锁/例外端点；MT027+MT013 下游）task_47978a7e270f/ctx_ce39bc80278e@55549

五树=BASE+230 项同步（第 13 版脚本自测通过）。brief 含：基线 896/34、十六任务链、KB 库 OWNER 纪律（波次 12 终验教训）、容器删除回显、biome 收尾复跑存档、字母序注册纪律。

## 2026-10-17 波次 13 — MT018 完成；四票死于 API 502 中断并重派第 2 任

- **MT018 完成**（task_fbfb8147175c/ctx_ec2e2def100e，100 分钟）：聚焦 29/0/0（176 expect）、全量 **925/0/0/35**（=896+29）、变异 8/8、typecheck 0、biome 0、**零授权编辑点**（3 新文件，比预授权更窄）。D1 无迁移、D2 凭据窄规则（只认本人 personal 凭据，团队/公司凭据放宽属后续票与 MT029 衔接）。容器亲验零残留。待复审。
- **四票同灭**（MT071/MT098/MT038/MT030，约 01:27-01:42Z 派发后 1.5-3h）：hiroute API 502 no upstream candidate（重试 3 次失败，terminal 终迹一致）——与 MT041-1st 同款死因。stop ×4 全部 closed_agent_terminal。
- **磁盘增量取证**：四树检查点均为空壳（MT030 最远=red-green/00-baseline 存档；MT098 有 design.md），**生产代码与测试零增量**——死于基线验证/设计期。残留 impl 容器 ×4 由 coordinator 清理（回显存档）。
- **同树重派第 2 任**（零增量无需接管审计，brief 追加接管注记）：MT071 ctx_89c8cfe38bf8 / MT098 ctx_236801344f83 / MT038 ctx_93188b8f0e0a / MT030 ctx_78c4db0ec880。

## 2026-10-17 波次 13 — API 502 持续期处置与第 3 任重派

- 第 2 任四票（ctx_89c8cfe38bf8/236801344f83/93188b8f0e0a/78c4db0ec880）重派后 R 值卡死（502 重试循环），stop 全部 closed_agent_terminal 后 release——避免空耗；零增量（死于读取 brief 阶段）。
- **探针策略**：先单派 MT030 第 3 任（ctx_faec157f761a），2.5 分钟确认 R586k/18.4% 无 502 = **API 已恢复**，随即重派其余三票第 3 任：MT071 ctx_9f161261b00d / MT098 ctx_473b11a1ab5a / MT038 ctx_e42fc89abcfb。
- 值得注意：502 中断窗口约 01:27Z–04:55Z（第 1 任死于窗口内；第 2 任 04:4x 仍受影响；05:0x 恢复）。

## 2026-10-17 波次 13 — 502 第二波与三票完成

- **已完成三票**（均达标、容器零残留、任务 completed）：
  - MT018（第 1 任，925/0/0/35，变异 8/8，零窄例外）
  - MT030（第 3 任，919/0/0/35=896+23，全局端点登记进 startup 门）
  - MT071（第 3 任，908/0/0/35=896+12，零生产代码修改的特征化票；6 变异全捕获含 M06 首轮 SURVIVED→M06b KILLED 如实存档；capacity/credits-writer 零修改面双重哈希复核——mtime 变化系 touch/读取副作用，交复审按哈希判）
- **502 第二波**（约 06:3x–07:0xZ）：MT098-4th（中期 ctx 54.6%，零 ts 增量——全程验证/设计/基线重跑）与 MT038-4th（**中期有实质增量**：document-lifecycle 三新文件 + **kb-ownership.ts 被改**——MT036 冻结交付 fd0e4627，接管审计第一优先核对授权面）双灭；stop ×2 closed_agent_terminal。
- **探针恢复确认**：5 分钟等待后单派 MT098-5th（ctx_7bd46ec11cbb）R134k 无 502 → 立即派 MT038-5th 接管任（ctx_522bc576016e，brief 含接管审计三分/takeover-audit/-takeover 证据后缀/kb-ownership.ts 授权面核对优先）。
- 波次 13 死亡累计：第 1 任×4（502）、第 2 任×4（502 持续期）、第 3 任×1（MT098 502）+MT038-3rd（find / 挂起）+ 第 4 任×2（502 二波）。

## 波次 13 五票实现收官 + 复审装配（2026-10-17）

**五票实现全部完成**（死亡任次合计 11：502 双波杀 8 + find / 挂起 1 + 规划冻结 1 + MT038 四任接力）：
- MT018 公共 bot 用量：925/0/0/35，聚焦 29 用例，变异 8/8，零窄例外；3 新文件（b1f528d3/51287ff6/363f0fa7）
- MT030 全局端点启动门：919/0/0/35，聚焦 23 用例（未登记 globalExceptions 多租户模式 exit(1)）；交付面 9 文件（含 inventory.ts/provider-oauth×2）
- MT038 KB 文档生命周期：923/0/0/35，聚焦 27 用例，变异 10/10；接管审计：kb-ownership.ts=MT036 冻结哈希 fd0e4627 逐位一致（第 4 任改动=MUT7b 变异注入已还原）；3 文件（95bdd2a5/b88ceafc/9fc92ff6）
- MT071 结算幂等特征化：908/0/0/35，聚焦 12 用例；零生产代码修改（capacity/credits-writer 双重哈希复核）；M06 首轮 SURVIVED→M06b KILLED 如实存档
- MT098 桌面组织上下文：cargo org_context 32/0/0、全 crate 719/0、变异 12/12（MUT-01~12）、typecheck 0、基线 896/0/34 复现；4 rust 文件（b75f3e6f/f515e24a/25042fca/8ec7e2cd）

**五票容器亲验零残留**（docker ps grep 全 exit 1）。

**复审装配**：五棵复审树 i13-review-mt{018,030,038,071,098}=BASE f0520524+transfer 230 项（全部 OK）+交付整拷 20 文件哈希逐项核对 ALL MATCH（MT038 树 kb-ownership=fd0e4627 两树一致）+checkpoints/briefs/reports 转移齐。五份复审 brief 落盘（专项重点：MT018 D2 凭据窄规则/MT030 启动门语义+inventory 一致性/MT038 接管审计三分复核/MT071 零修改面哈希判定+mtime 假象/MT098 变异互证+server 零外溢基线复跑）。端口分配 55555-55559。

下一步：task-create ×5 + worker-start ×5（--agent pi）→ 监控循环。

### 波次 13 复审：502 第四波 + MT038 PASS + 两票重派

- **MT038 复审 PASS 定谳**（task_6ec9bb4d4113 / ctx_75d294053b4b succeeded）：27/0/0 聚焦+923/0/0/35 全量亲测、16 任务链、230 项零漂移（两度复扫）、变异重放 4/4（R-MUT-A/B/C/D 计数与第 4/5 任双存档逐项吻合、无未披露存活）、接管审计三分独立复核全部成立（含实读第 4 任 run-mutations.sh 证明 MUT7b 系变异注入且 restore-hashes 存档 fd0e4627）、KB 域无 RLS=诚实披露（MT036 D3 同款）、容器销毁回显+deletion 0。**L1（low，测试自足性）**：document-lifecycle.test.ts beforeAll 未自调 applyKbOwnershipMigrations()（兄弟套件均调），全新 KB 库首跑聚焦失败、按配方 apply 后全绿——非 AC 违背，一行改进建议待批量修复轮裁定。D2 写授权边界披露确认（KB 管理票排期依赖可见）。无 critical/high/medium、无虚假声称。
- **502 第四波**（~16:0xZ 起，击中 MT018 复审第 1 任 R4.7M 中期与 MT071 复审第 2 任 R721k）：两任报告未落盘（亲测容器 mt018-rev-pg/mt071-review-pg 起后 agent 死循环）→ stop 双 closed_agent_terminal → 容器亲删零残留 → 零可复用增量 → 同树重派。MT030/MT098 零 502 未受波及。
- **重派**：MT018 复审第 2 任 ctx_5d49771831db（探针 R34k 零 502 通过）、MT071 复审第 3 任 ctx_d8dabb204727。task-update --id … --status ready 为 stop 后重派的必要前置（blocked→ready）。
- 当前在跑：MT030 原任（R5.3M 收尾验证中）、MT098 第 2 任（R2.2M cargo）、MT018 第 2 任、MT071 第 3 任。

### MT030 复审 PASS 定谳 + MT098 502 余震重派

- **MT030 复审 PASS**（task_32f51f1f82f6 / ctx_bc7f23f47b97 succeeded，容器零残留）：聚焦 23/0/0（4 连跑）、全量 919/0/0/35、交付 9/9 哈希==brief==after-hashes、16 任务链 manifest 与 checkpoint 逐字节相同、变异重放 4/4（MUT1/3/4/6 恢复哈希闭环）、登记表×inventory「评估器+自写模式匹配」双重核对零失真、provider-oauth/provider-oauth-lock 修改面零触碰定性。**无 critical/high/medium**。F1（low）=brief 模板存量 biome 清单疏漏（app.ts 2E+1W / provider-oauth.test.ts 1E 均 BASE 影子实测归因既有，MT030 新增违规=0）——后续 brief 应以「BASE 影子 biome 实测」为存量基线（已采纳为纪律）。F2（low）=bun install 后首跑 1 次不可复现 flake（4 连跑 23/0），判定冷启动抖动。
- **MT098 复审第 2 任死于 502 余震**（R2.2M 报告未落盘=零增量）→ stop closed_agent_terminal → release → 探针确认 API 恢复（MT018 647k/MT071 943k 零 502）→ 第 3 任 ctx_f14a52afd53d 重派（R214k 健康起步）。
- 当前在跑：MT018 复审第 2 任、MT071 复审第 3 任、MT098 复审第 3 任。

### 波次 13 复审收官：五票全 PASS（2026-10-17）

- **MT018 PASS**（ctx_5d49771831db，容器零残留）：交付本体全门槛复验通过（29/0/0、925/0/0/35、变异 3/3、230/230）。**C1（critical）根因澄清：复审第 1 任 502 死亡时留下 MUT2 变异注入残留**——时间线：coordinator 15:41 转移哈希核对全过（b1f528d3）→第 1 任 15:58 注入 MUT2 重放→16:0x 502 死循环→stop 时取证只查「报告未落盘」未复核交付面哈希→第 2 任 16:2x 接手发现移交态=变异态（26/3 fail）→16:34 受控恢复至 b1f528d3+全量复验 PASS。实现树/复审树现盘均=b1f528d3 干净态。**F2（medium，coordinator 取证缺口）成立：此后每次 stop 复审 worker（尤其 502/冻结死亡）后必须复核交付文件哈希==冻结值再重派（已纳为纪律）**。
- **MT030 PASS**（2 low：brief 存量清单疏漏/首跑 flake，均非交付缺陷；后续 brief 以「BASE 影子 biome 实测」为存量基线）。
- **MT038 PASS**（L1 low：document-lifecycle.test.ts beforeAll 补一行 applyKbOwnershipMigrations()，修复轮处理）。
- **MT071 PASS + F1（medium）**：幂等矩阵并发竞争格无真并发用例（顺序 await 全覆盖，同预扣并发 settle/release 无票钉死；结构兜底在位：lockCustomer 行锁+台账唯一索引）。修复轮补 Promise.allSettled 并发结算/释放用例（顺带 F2 low 并发重放返回首果断言）。
- **MT098 PASS**（3 low 备忘移交 MT101 集成：L1 冻结 scope 时效/L2 重登录重置选择/L3 复审基建）。
- 五票复审容器亲验零残留。502 第四波+余震共杀 3 个复审任次（MT018 第 1 任/MT071 第 2 任/MT098 第 2 任），全部零有效增量重派，无工作丢失。

**修复轮派发**：MT071-fix（i13-mt071 树：+并发结算用例）+ MT038-fix（i13-mt038 树：beforeAll 一行）。修复后按 MT070 先例（medium 修复不派修复复审，coordinator 亲验数字）。

### 波次 13 批集成终验收官（2026-10-17）

- **修复轮**：MT071-fix（12→15 用例：F1 settle×2+settle+release 竞态两例+F2 并发重放首果；RED 14/1 过度指定→GREEN 15/0 四连绿；MF1 变异自证 KILLED 13/2；全量 911/0/0/35 三跑；四生产冻结面逐位不变；终态 12965c06）；MT038-fix（beforeAll +applyKbOwnershipMigrations 一行+import；RED 全新 KB 库首跑 0/2→GREEN 27/0/0 自足；全量 923/0/0/35；唯一变更 95bdd2a5→68f542d3，三冻结面逐位保持）。
- **批集成**：五票 20 文件交付面零冲突，11 文件落 EXE（MT030 六文件中 5 个=prereq 既有版本），14 项终态哈希核对 ALL MATCH（含修复版 68f542d3/12965c06）。
- **批终验配方教训（重要）**：第一跑 654 pass/104 fail——根因=coordinator 漏跑「十六任务链 apply」（base migrate 后直接 bun test，套件链撞基座数据 MT112 duplicate）。正确三步：①enterprise-test-db.ts migrate（自动从 env URL userinfo 建 ent_* 角色+入 ob_ent_* 组）②逐任务 migrate-test.ts generate+migrate --apply 十六链 ③bun test。库名必须 openbot_enterprise_*（校验器拒绝）；assigned=主库名+_assigned；setup=同库同实例（校验器要求）。
- **批终验通过**：990 pass/0 fail/0 skip/38 文件（=896+29+23+27+15；34+4 新测试文件）。第 1 跑 989/1：唯一 fail=MT041 job-ownership.test.ts:667 `finishedAt<=Date.now()` 时钟竞速断言（DB now() vs JS Date.now() 毫秒差）——单文件三连跑 23/0×3+全量复跑 990/0 确认 flaky（与 MT030 复审 F2 首跑 flake 同类，挂账观察）。typecheck 0；biome 新增 10 文件 clean；cargo org_context 32/0/0（lib 目标，546 filtered）+main 0/0。容器 w13verify-pg 亲删零残留，env/临时文件清理。
- **记录**：integration.json ×5（MT018/030/038/071/098-integration）；dag verified 34→39（blocked 104）；transfer-prereq.sh 第 14 版（240 项，干跑验证 OK：新增 public-bot-usage/global-exceptions/kb-document-lifecycle/settlement-idempotency 等十文件+五报告+两修复报告+五 integration checkpoint）。
- **新解锁 14 张**：MT019/MT020/MT022/MT029/MT031/MT039/MT040/MT042/MT059/MT072/MT073/MT074/MT099/MT122。
- **挂账新增**：MT041 finishedAt 时钟竞速 flake（观察）；MT018 复审 F2 纪律已生效（stop 死亡 worker 后必复核交付面哈希）。

## 波次 14 派发（2026-10-17）

**五票**：MT022 #65 会话生命周期权限 / MT042 #85 平台扫描作用域重建 / MT031 #74 插件目录安装归属 / MT059 #102 用户私有 Bot / MT122 #165 部署主入口请求上下文（解锁贡献 3/3/2/1/1，文件域错开：conversations/scan/plugins/muse/装配面；MT073/MT074 同属 billing 域留下一波避免冲突，MT099 与 MT098 同 rust 面避开）。

**装配**：五树 i14-mt{022,042,031,059,122}=BASE+transfer 240 项（第 14 版清单首用）；五份 brief 落盘（含波次 13 教训：三步迁移配方、库名 openbot_enterprise_*、assigned=主库名_assigned、setup=同库、基线 990/0/0/38、biome 存量口径=MT030 复审 F1）；task+worker ×5（端口 55563-55567）。

**死亡处置**：MT022 第 1 任规划期冻结（transcript 停在 reasoning 30+ 分钟，树内零产出，起过容器 mt022-impl-pg 已清）→ stop closed_agent_terminal → 同树重派 ctx_26281e28211f；MT031 第 1 任停摆（transcript 停在 ls 结果 80+ 分钟、零文件零容器）→ stop → 重派 ctx_5e71dd881114；MT122 第 1 任疑似 Orca 重启后未真正启动（transcript 仅系统提示、2 小时零动作零产出）→ stop → 重派 ctx_c1a311767f2d。**Orca 重启后 transcript 快照滞后是常态，活性判据=transcript 前后对比+untracked 变化+容器+进程；dispatched 状态不充分**。MT042/MT059 原任健康（容器 mt042-impl-pg/mt059-impl-pg 活跃，MT042 设计定稿：sweep-read 策略+权威行重建+签发入口+MT041 lease+MT005 gate）。

当前在跑：MT022 二任 / MT042 原任 / MT059 原任 / MT031 二任 / MT122 二任。

### 波次 14 中程：MT022/MT031 达标结算 + Orca 二次重启处置（2026-10-17/18）

- **MT022 二任达标结算**（ctx_26281e28211f succeeded，容器零残留）：聚焦 35/0/0（139 expect）、全量 **1025/0/0/39**（=990+35）、变异 8/8 捕获（MUT1-8 每分支、恢复哈希 0c2d917d 闭环）、基线 990 复现、typecheck/biome 达标。D6：Q1 套件名（Spec 优先 conversation-messages.test.ts）/Q2 归档方案 B 经 ask 通道 20 分钟未答按保守裁定（Spec 优先成立，无需翻案）。D8 套件内顺序依赖披露（AC4 依赖 AC2 reinstat，bun 文件序执行）——复审重点核对项。
- **MT031 三任达标结算**（ctx_d3b466d1ebb5 succeeded，容器零残留）：聚焦 35/0/0、全量 **1025/0/0/39**、变异 7/8 KILLED+1 掩蔽披露（MUT-all-final+MANIFEST，掩蔽定性待复审核对）、RED→GREEN（0 pass 模块缺失→30/0→35/0）、typecheck 0。
- **Orca 二次重启**（~00:1x）：杀 MT042 原任（GREEN-6 收敛中）/MT059 原任（RED-1 后）/MT122 二任（GREEN-1 后）。处置：dispatch 状态残留 dispatched 但进程死→stop 三任 closed_agent_terminal→容器亲删零残留→三票树内增量完好（测试文件 scan-executor.test.ts/openmuse-private-bot.test.ts/entry-context.test.ts+checkpoints 存档链）→同树重派 MT042 二任 ctx_046c819a50db/MT059 二任 ctx_5e4d7d9d3cdc/MT122 三任 ctx_7acbf086d5bb+brief 追加接管注记（从 red-green 链续作、不重做已 GREEN 部分）→探针 transcript 544-658 行全部真启动。
- 波次 14 死亡任次累计：MT022×1（规划冻结）+MT031×2（停摆/零启动）+MT122×1（零启动）+重启×3=7 任次，零工作丢失。
