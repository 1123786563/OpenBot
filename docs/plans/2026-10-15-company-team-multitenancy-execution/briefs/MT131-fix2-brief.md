# MT131-fix2 / Issue #174 — 修复轮 Task Brief（关闭复审 F1/F2，附带 F3/F4）

角色：`backend_implementer`（修复轮）；完成后由全新独立 Pi Reviewer 复审。你是修复实现者，不是原审阅者。

## 背景与输入

- 原实现（Task `task_9b95a3b8cb96`，已结算）+ 独立复审 `reports/MT131-review2.md`（Spec 4/4 PASS / Code PASS WITH FINDINGS：2 Medium 必须关闭）。
- 复审报告已随快照转移到你的工作树（findings 定义与 file:line 证据见其 §4；复审者自建环境的可复用做法见其 §1-§2）。
- 被修复对象当前哈希（先复算，不符即 worker_done --outcome failed）：
  - `server/scripts/multitenancy/acceptance-harness.ts`（以 checkpoints/MT131/review-sha256-manifest.txt 中记录值为准）
  - `server/tests/multitenancy/acceptance-harness.test.ts`（同上）
- HEAD 必须 = `f0520524f0faa2b4533b9d2f1aa69c8f907ba71`。

## 必须关闭的 Findings（逐条 TDD：先 RED 后 GREEN）

- **F1（medium）**：测试硬编码实现者私有环境常量（acceptance-harness.test.ts:122 `databaseName === "openbot_enterprise_mt131_test"`、:124 `databasePort === 55434`、:302 同）。改为从 `REAL_ENV` 解析推导断言（如 `databaseName === new URL(...).pathname.slice(1)` 且匹配 `/^openbot_enterprise_/`、端口从 URL 推导），或注入 fake env 断言解析输出；`CONSISTENT_FAKE_ENV` 纯解析 fake 可保留。目标：任意合规专用环境（不同库名/端口）下套件全绿。
- **F2（medium）**：harness 控制域场景可作为业务证据的永真预言机。`validateEvidencePlan`（acceptance-harness.ts:436-473）必须拒绝 `HARNESS_CONTROL_DOMAIN` 与 `harness.` 前缀 scenarioId 出现在业务 evidence plan 中（控制场景仅限 harness 内部自检使用）。

## 附带（同文件、低风险，一并修复）

- **F3（low）**：`parseFlags`（acceptance-harness.ts:832-850）旗标缺值时静默接受——取值为 `undefined` 时抛 `HARNESS_FLAG_MISSING_VALUE`。
- **F4（low）**：`tempDir` 创建但从未使用/清理（:137 生成、:576 mkdir 后无引用）——要么实际使用（写 run 元数据），要么删除 mkdir 仅保留命名空间字段；二选一并在报告说明。

## 拥有文件（其余一律不动）

- `server/scripts/multitenancy/acceptance-harness.ts`
- `server/tests/multitenancy/acceptance-harness.test.ts`
- `docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT131-fix2.md`（新建）
- `docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT131-fix2/**`（新建）

## 约束

- 不改 MT001/MT002 交付文件与共享 support；不放松「绝不合成通过」语义（F2 修复只能收紧）。
- 保持全部既有测试通过（含 MT001 inventory 回归不受影响）。
- TDD：RED→GREEN→REFACTOR，诚实披露首跑即绿项。
- 无提交/推送/合并/生产迁移/部署授权；未提交检查点 + SHA-256 清单。

## 测试资源（专用，用后清理；注意复审 F5 事实纠偏）

- 镜像必须含 vector 扩展：`pgvector/pgvector:pg16`（plain postgres:16 会让 enterprise migrate exit 1）。
- `lsof -i :55447` 确认空闲后：
  `docker run --rm -d --name openbot-i6-mt131fix2-pg -e POSTGRES_DB=openbot_enterprise_mt131fix2_test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55447:5432 pgvector/pgvector:pg16`
- 受限角色 env 自建 `/tmp/mt131fix2-env.sh`（0600、随机密码、绝不打印、用后删）：TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL 及三个受限角色 URL 指向 127.0.0.1:55447/openbot_enterprise_mt131fix2_test；受控 migrate/建角色做法参照复审报告 §1-§2 与 `server/scripts/enterprise-test-db.ts`。
- harness 本地 HTTP 端口在代码中硬编码 45435（无 env 覆盖）——运行测试前 `lsof -i :45435` 确认空闲。

## 验证命令（全部记录退出码）

1. `source /tmp/mt131fix2-env.sh && bun test server/tests/multitenancy/acceptance-harness.test.ts`（合规专用环境全绿——F1 修复的直接证据）
2. 换一组不同库名/端口的合规环境（第二个一次性容器，如 55448/`openbot_enterprise_mt131fix2b_test`）重复步骤 1（证明环境无关性）
3. `cd server && bun run typecheck`
4. `bunx biome check` 两个文件
5. 清理容器与 env 文件

## 产出

- `reports/MT131-fix2.md`：修复说明、RED/GREEN 证据、四个 finding 关闭映射、命令与退出码。
- `checkpoints/MT131-fix2/`：before/after 哈希、diff、review-package.json。
- worker_done --outcome succeeded|failed，附 --report-path --files-modified。
