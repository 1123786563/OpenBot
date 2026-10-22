# Hindsight 08/10（#385/#387）实施方案

工作区：`orca/workspaces/OpenBot/hbc6`（hbc6 worktree，基线 = main@3c7bad64 + 未提交前置增量
#381 bank-scope、#382 preference-recall、#383 scoped-recall、#384 sync-queue、#386 时间窗口、
0172–0174 迁移；开工 `git status --porcelain` 快照 64 条留存 /tmp/hbc6-baseline-status.txt）。
父 Spec：#376；ADR：0005（分工）、0008（两层测试）。执行证据与逐票结论写
`reports/orca-dag-wave3-hindsight-08-10.md`（本 worktree）。

## 事实源核验结论

- 正式 tracker = `1123786563/OpenBot`（上游撞号，已按票号核对 open/ready-for-agent）。
- 基线等价实现核验：无。#382/#383 的 Unavailable 错误类注释即写明 “the safe-degradation path
  (#385) catches this”——降级路径本身留白；evidence/依据面无任何现存模块（`server/src/memory/`
  的 Intelligence 线不属 Hindsight 轨道）。
- 前置票已以 seam+测试交付（无路由接线，口径沿用），#385/#387 同样以 seam 为交付面。
- PlatformScope.entrypoint ∈ {web, desktop, mobile, schedule}：频道 Bot 与网页、定时 Bot 共用同
  一受信 scope 词汇，entrypoint 不参与召回策略——跨入口同一性在 seam 层即结构性成立。

## 票间依赖与公共决定

- **零迁移**：两票均为既有权威表之上的行为（降级读、依据读、编辑/遗忘操作），无新列新表；
  0175 号段留给后续票。
- 身份纪律不变：一切 placement 经 `bank-scope.ts` 派生；降级路径**复用**既有 recall seam 的故障
  路径（Unavailable 错误）与既有行级复核谓词（同源导出，不复制），不在降级路径新造任何放宽版
  授权判断（fail-safe：故障时宁可无记忆不可错记忆）。
- #385 的恢复补索引消费 #384 的 sync-queue（既有行为，验收时以用例复测）；#387 的授权复核消费
  #383 的 `stillAuthorized`/快照读（hit→原文→来源授权链）。

## #385 Hindsight 故障时的安全降级召回

- 新模块 `server/src/hindsight/degraded-recall.ts`：`createDegradedRecallFacade` 包住两个既有
  seam。正常路径直通（`degraded: false`）；catch 且仅 catch 对应 seam 的
  `*RecallUnavailableError`（超时/宕机/5xx 均归此类）→ SQL 降级（`degraded: true`）。其它错误
  原样抛出。
- SQL 降级 = 结构化查询 + 行级复核，全部沿用主路径谓词（从 seam 模块导出单一来源）：
  - 通用偏好：`loadRecallEligible`（SQL 过滤 confirmed/edited + enabled + 未删除 + 内容非空，
    (tenant, principal) pin）→ 内存复 `preferenceRecallEligible` → 词项 AND 子串匹配（语义排序
    不可得时的诚实降级；查询按空白切词，全部命中才返回）→ `temporallyVisible`/`timeUncertaintyOf`
    （#386 当前/历史两模式语义保留）→ 截 20。
  - 来源受限：`resolveScopedHindsightBankScope` 先算 bank 集（空快照 → 空结果，与主路径一致，
    绝不猜 bank）→ `loadRecallEligible` → 内存复 `stillAuthorized`（询问工作区边界、来源启用、
    Bot 授权，**当前**授权而非确认时授权）→ 词项 AND 匹配 → 截 20。
- 响应携带 `degraded` 标志：降级期间不得声称已完成语义索引（AC2 的表达面）。
- AC2（新确认保留待同步、恢复后补建）：confirm 在故障下 `remoteSynced: false` + #384 `syncStatus`
  = pending（不标 indexed）；服务恢复后 drain 补同步 → indexed。既有行为的 #385 验收用例。
- AC3（跨入口）：entrypoint ∈ {web, desktop, schedule} 三入口铸生产式 scope，断言降级结果与
  撤权过滤逐字段一致。
- 验证：`server/tests/hindsight-degraded-recall.integration.test.ts`（真实库 hbc6 + scripted 服务
  的 up/down/timeout 三态；覆盖候选不可见、来源撤权、同用户跨公司、暂停使用 enabled=false）。

## #387 个人记忆回答的可展开依据

- `scoped-recall.ts` 增补两条人本操作（镜像 #382 的 edit/forget 形状）：
  - `editSourceBoundMemory`：限制目标**当前仍有权**才可编辑（与 confirm 同规；向已失权 bank 的
    retain 不该发生），review act 置 edited，retain replace，失败不失败操作（留 pending）。
  - `forgetSourceBoundMemory`：遗忘不受失权阻挡（移除永远合法）；tombstone（清内容 + 停用 +
    deleted_at）+ 以行自身归属铸 `backgroundTaskBankScope` 对远端文档 best-effort DELETE。
- 新模块 `server/src/hindsight/answer-evidence.ts`：`createAnswerEvidenceService`。
  - `inspectEvidence(scope, { ids })`：逐 id 解析两张权威表（(tenant, principal) pin）。
    可用条目 = 命中（id）→ 原文（重载的已确认内容）→ 来源授权（provenance + 来源受限
    restriction 的**当前**授权复核：team 行须询问工作区成员资格 active、source 行须来源启用、
    bot 行须 bot 仍持有应用权限）。偏好条目带 #386 有效窗口（from/until/supersededBy/
    supersededTimeUnknown/correctedAt）——涉及历史变化的回答由此展开完整链路。
  - 缺失 / 失权 / 未审核 / 已遗忘 / 他人 id → `{ state: "unavailable", id }`：不带内容、不带来源、
    不带限制目标，界面明确不可用，绝不展示推断内容（AC3；不区分缺失原因，避免存在性侧信道）。
  - `availableActions` 声明该条依据入口可发起的操作：偏好 = edit/correct/forget；来源受限 =
    authorized 时 edit + 恒有 forget。
  - `editEvidence` / `correctEvidence` / `forgetEvidence`：按 id 归属表分派到对应 seam（更正仅通
    用偏好——时间窗口是偏好链语义；来源受限事实的更正 = 编辑原文）。操作后的下一次回答
    （recall，含降级路径）反映最新事实与权限（AC2 用例断言）。
- 验证：`server/tests/hindsight-answer-evidence.integration.test.ts`（真实库 + scripted 服务：
  正常/历史回答依据展开、失权不可见无泄露、缺失/孤儿/未审核 → unavailable、编辑/更正/遗忘后下
  一答、跨 principal 操作拒绝）。

## 验证与登记

- 驱动层：`bun test ./server/tests/hindsight-{degraded-recall,answer-evidence}.integration.test.ts`
  + 前置套件回归（source-bound/sync-queue/temporal/preference-recall 四件），TEST_DATABASE_URL
  = `postgres://postgres:postgres@127.0.0.1:5567/hbc6`（库建于既有容器 orca-w3-hbc-pg，不新建
  容器）。
- 新套件 `node scripts/e2e-add-driven.mjs` 登记入 `tests/config/e2e-bun-suites.json`，随后
  `node scripts/e2e-coverage-audit.mjs` 核对无缺口；原生层回归 hindsight 既有 e2e 套件。
- 合约面无新增服务端契约（两票均为 OpenBot 侧行为；scoped-recall 新增的 retain/DELETE 线型与
  既有 seam 完全一致），按约束以 `deploy/hindsight/test/contract-instance.sh` 跑既有三套合约回
  归。
- 类型 `server tsc --noEmit` 与 biome lint 限新增/触碰文件；GitHub 只读；不 commit 不 push。
