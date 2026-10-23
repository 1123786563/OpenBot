# Hindsight 11（#388）同一授权来源内的派生判断候选 — 实施方案

- Ticket：`1123786563/OpenBot#388`（open，ready-for-agent；blocked-by #378/#383/#387 均已在 wave3 前置增量交付并验证）
- 工作区：`orca/workspaces/OpenBot/hbc7`（main@3c7bad64 + wave3-delta-r5 未提交基线）
- 事实源：父 Spec #376（docs/specs/2026-10-15-hindsight-personal-memory-design.md 第 4 条）、ADR 0005（派生判断段）、CONTEXT.md「Derived Memory / Source-bound Memory」术语、#383 scoped-recall、#384 sync-queue、#387 answer-evidence 交付接口
- 边界：本票只产候选；候选的确认/编辑/拒绝与确认后召回是 #389。无 HTTP 路由接线（与 #381–#387 同口径：seam + 测试交付）。

## 需求 → 设计映射

| AC | 设计落点 |
| --- | --- |
| 1 判断只引用同一授权来源或通用个人记忆内的已确认依据；不跨来源综合 | 依据解析统一 scope：每条依据映射到 `general`（preference）或其 restriction（source-bound）/自身 scope（judgment）；全部一致才成候选，否则 `cross-source-evidence` 拒绝。team 依据另受 #383 询问工作区规则约束（从 B 工作区提出 A 组判断在授权检查即死） |
| 2 候选展示全部依据、来源和时间；任一依据缺失或失权则不提出 | 候选视图携带完整依据链（kind/id/content/provenance/时间字段/scope）；提出时四道门（见下），列示时同一套门实时复核，任一不过即整条不出现 |
| 3 未经本人审核的判断不可跨会话召回，也不能作为下一层判断的依据 | 候选行只在 `derived_judgment_candidates`，无任何 retain（模块不持有 Hindsight config，结构性不可同步）；两条召回 seam 与降级路径只读 preferences/source_bound 表，hdj_ 文档号即使被服务恶意返回也无行可映射；下一层依据解析把 judgment 行按 `derivedJudgmentEligible`（confirmed/edited）门禁，unreviewed 一律 `unconfirmed-evidence` 拒绝 |

## 四道依据门（顺序固定，拒绝理由可区分）

1. `missing-evidence`：文档号解析不到本人在本公司的权威行（含他人行、伪造号、遗忘后 tombstone 之外的空洞）。
2. `cross-source-evidence`：依据 scope 不一致（general 混 restriction、team A 混 team B、source 混 source、source 混 bot）。
3. `unconfirmed-evidence`：行存在但未审核/被遗忘/停用/空内容（复用 `preferenceRecallEligible` / `sourceBoundRecallEligible` / `derivedJudgmentEligible`）。
4. `unauthorized-evidence`：source-bound 行当前授权快照不过（来源停用、成员资格挂起、Bot 失权；复用 #383 `stillAuthorized` + bot 行逐行 `botAuthorized`）。

## 交付物

- 迁移 `0177_hindsight_derived_judgments.sql`：`derived_judgment_candidates`（scope_kind general/team/source/bot + shape CHECK；review_state 四值但本票只写 unreviewed；`hdj_` 文档号唯一；proposal_digest 部分唯一索引折叠重复线索）+ `derived_judgment_evidence`（judgment_id+position 有序完整依据关系，存权威行 record id）。
- schema `server/src/db/schema/hindsight-judgments.ts`（导出并入 schema/index.ts）。
- 模块 `server/src/hindsight/derived-judgments.ts`：
  - `createDerivedJudgmentService(preferences, sourceBound, judgments, authorizations, { now })` —— 构造参数即契约：无 service config，候选路径零远端调用。
  - `proposeDerivedJudgmentCandidate(scope, { judgment, provenance?, evidence: [documentId…] })`：受信 scope → 四道门 → 落候选（unreviewed）；同一线索重复提出按 digest 幂等返回既有候选；依据 ≥2 条不同权威行（“多次已确认经历”）。
  - `listDerivedJudgmentCandidates(scope, { limit? })`：本人待审候选，每条实时复核四道门，任一依据失效整条不出现（失权→不提出，恢复授权→重新出现）。
  - 导出 `derivedJudgmentDocumentIdFor` / `derivedJudgmentEligible` / `judgmentScopeOf` 供 #389 复用。
- 共享策略归位（避免副本）：`scoped-recall.ts` 新增导出 `sourceBoundAuthorizedNow`（bot 行逐行授权复核），`answer-evidence.ts` 改为引用；`sync-queue.ts` 导出 `isUniqueViolation` 供幂等提出复用。
- 测试 `server/tests/hindsight-derived-judgments.integration.test.ts`（bun 驱动层，真实库 + scripted 服务 + 生产式 scope 铸造；describe 按 AC 分组），登记入 `tests/config/e2e-bun-suites.json` 并跑 coverage audit。

## 验证

- 新建库 `hbc7`（容器 orca-w3-hbc-pg@5567，既有共享测试容器，不建不毁）；`DATABASE_URL=…/hbc7 bun --no-env-file server/scripts/migrate.ts` 应用至 0177。
- `TEST_DATABASE_URL=…/hbc7 bun test ./server/tests/hindsight-derived-judgments.integration.test.ts`（新套件）。
- 回归：hindsight 全链既有 bun 套件（bank-scope/config/health 为 e2e 原生层）+ `tsc --noEmit`（对照基线 3 error）+ biome（触碰文件）。
- 合约回归：`deploy/hindsight/test/contract-instance.sh` 起真实例跑既有 hindsight contract 套件（本票无新服务端行为，不新增合约套件，理由记录于报告）。

## 明确不做

- 候选的确认/编辑/拒绝、确认后的 retain 与 sync-work subject 扩展（#389 迁移）。
- Hindsight 观察的拉取接线（服务端无 observation 契约；线索以数据形态进入 seam）。
- 候选过期清理（属敏感候选/过期清理轨道 #378 后续）。
