# MT112 — 实现轮 Task Brief（历史部署的「原有公司 + 默认团队」锚点创建）

角色：`backend_implementer`；完成后由全新独立 Pi Reviewer 复审。前置：MT003+MT004 已 verified 并集成到你的工作树（以 `archive/plans/multitenancy-execution/checkpoints/prereq-manifest.txt` 为准，先逐条复算，不符即 worker_done --outcome failed）。

## 目标（Ticket 契约）

为历史部署创建「原有公司」与默认团队，并建立与既有部署身份、计费 Customer 的明确映射，作为后续回填的锚点。

## 验收标准（逐条 TDD 留证）

1. 原有公司与默认团队创建**幂等**；重复执行不产生重复实体。
2. 与既有部署身份及计费 Customer 的映射**唯一且可核验**。
3. 创建过程以 **dry-run 预览、以 manifest 执行 apply**（MT003 工具原生链路）。
4. 创建后既有单租户行为不变（回归测试）。

## 落点指引

- 工具：`server/scripts/multitenancy/migrate-test.ts`（MT003 交付，TASKS 注册表机制 + dry-run/apply/manifest/journal 漂移拒绝）。在 TASKS 追加 `MT112` 任务条目（参照 MT004 条目形状）。
- 本任务含**数据创建**（区别于 MT004 纯 DDL）：创建「原有公司」租户行 + 默认团队 workspace 行 + 成员锚点 + 映射。幂等实现用 `ON CONFLICT … DO NOTHING` / 唯一约束回读校验，**不得**先查后插竞态模式（或说明锁保护）。
- 勘察项（开工前完成并在报告记录）：既有「部署身份」与「计费 Customer」在当前代码中的实际表/列（billing 域 payer/customer 相关 schema、deployment/instance 身份表），映射落在何处由实际结构决定——存在企业域映射表（如 enterprise_resource_grants 或专用映射表）则按其形状；不存在则新增最小映射表（纯追加进 MT112 任务 DDL）。不臆造不存在的表名。
- expand-only：不改 MT001–MT004 交付语义；新表/新步骤全部纯追加。
- 测试库专用（pgvector/pgvector:pg16，端口 55458）+ 受限角色；映射核验用例须证明唯一约束在重复写入时触发拒绝。

## 约束

- 无提交/推送/合并/生产迁移/部署/发布授权；仅未提交检查点。
- 缺 env 显式 skip 带理由；skipped 不算通过；绝不回退开发库。
- RED → GREEN → REFACTOR 全程存档；变异检查至少覆盖幂等键与映射唯一约束。

## 验证命令（全部记录退出码）

1. 新测试套件（建议 `server/tests/multitenancy/legacy-anchor.test.ts`）
2. `MT003_ASSIGNED_TEST_DATABASE_URL=… TEST_DATABASE_URL=… bun test tests/multitenancy/` 全量回归（125 pass 基线 + 新增，0 fail 0 skip）
3. CLI：`migrate-test.ts migrate MT112`（dry-run）→ `generate MT112` → apply → 重复 apply（幂等证据）
4. `cd server && bun run typecheck`；`bunx biome check` 触及文件
5. 清理容器与凭据

## 产出

- `archive/plans/multitenancy-execution/reports/MT112.md`：勘察结论（部署身份/计费 Customer 实际落点）、设计、验收逐条映射、命令与退出码、诚实披露。
- `archive/plans/multitenancy-execution/checkpoints/MT112/`：prereq 复算、before/after 哈希、diff、red-green/、mutation/、review-package.json、sha256-manifest.txt。
- worker_done --outcome succeeded|failed，附 --report-path --files-modified。
