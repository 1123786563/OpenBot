# MT003-fix2 / Issue #46 — 修复轮报告

- 实现者：`backend_implementer`（Pi，Orca Task `task_63aeeec4713d` / Dispatch `ctx_e985c1514a4a`）。与原实现者（`task_60577e388d74`）和独立复审者（`task_8ae36eaedbc7`）均无共享会话。
- 日期：2026-10-15。冻结 BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（`git rev-parse HEAD` 实测，40 位，与 `fix2-transfer-manifest.txt` 首行一致；brief 文本中的 39 位变体为笔误）。
- 输入：brief `briefs/MT003-fix2-brief.md` + 复审 `reports/MT003-review2.md`（§5 F1–F4）。
- 拥有文件（仅动这些）：`server/scripts/multitenancy/migrate-test.ts`、`server/tests/multitenancy/migration-tool.test.ts`、本报告、`checkpoints/MT003-fix2/**`。

---

## 1. 开工完整性核验（全部通过）

- `git rev-parse HEAD` → `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` ✅
- `fix2-transfer-manifest.txt` 全部 12 项 SHA-256 逐文件复算一致（含两被修文件、inventory 两文件、MT003 报告、brief、MT003 checkpoint 5 件）✅
- `lsof -i :55446` 空闲 ✅ → 专用容器 `openbot-i6-mt003fix2-pg`（127.0.0.1:55446，`POSTGRES_DB=openbot_enterprise_mt003fix2_test`，`POSTGRES_HOST_AUTH_METHOD=trust`，`--rm` 一次性）
- 基线复跑（无 env）：**33 pass / 1 skip / 0 fail，exit 0**（与复审 §4#3 一致）✅

## 2. 逐 Finding TDD 关闭记录（先 RED 后 GREEN，全部命令有存档）

### F1（medium）真实库集成测试端点硬编码 → 显式 env + 全安全检查

- **RED**（`red-F1-env-set-but-still-skipped.txt`）：带 `MT003_ASSIGNED_TEST_DATABASE_URL=…55446/…mt003fix2_test` 运行旧代码 → 仍 **33 pass + 1 skip**（旧 guard 硬编码 `127.0.0.1:55433`+`openbot_enterprise_mt003_test`，专属端点不可配置；skip 即缺陷表现，非 fail）。
- **GREEN**（migration-tool.test.ts 真实库块重写）：
  - 专属库唯一来源 = 显式 env `MT003_ASSIGNED_TEST_DATABASE_URL`；
  - 显式配置时**必须**通过 `resolveTestDatabaseTarget` 全链安全检查（回环、单段库名、`openbot_enterprise_*` 前缀、非 openbot 库名、非法协议/URL、fragment——与主路径同一实现、同一调用点），被拒绝 = 模块级 `throw`（响亮失败，绝不静默降级为 skip）；
  - 未配置 = 显式 `test.skip` + 理由（说明 env 名与要求）；
  - 测试内将 env 显式映射为工具唯一认读的 `TEST_DATABASE_URL`，单一 env 驱动 generate→apply→复验→幂等→dry-run 全链路；库名/端点断言全部改为从解析结果动态取值。
- **验证**（`green-F1-fresh-db-with-env.txt` / `green-F1-second-run-uptodate.txt` / `verify-final-with-env.txt`）：55446 专属库 **42 pass / 0 skip / 0 fail，exit 0**（全新库 applied 分支 233 expect；收敛库复跑 up-to-date 分支 230 expect）——复审指出的「33→34 pass 结构性不可达成」消失。
- **负面证据**（`verify-bad-env-loud-failure.txt`）：`MT003_ASSIGNED_TEST_DATABASE_URL=postgres://…@db.internal.example.com…` → 整套件响亮失败 exit 1，消息含完整安全拒绝理由（loopback 拒绝）；安全检查链与工具主路径共用同一函数。
- **无 env**（`verify-final-no-env.txt`）：**41 pass / 1 skip / 0 fail，exit 0**，skip 理由 = 「MT003_ASSIGNED_TEST_DATABASE_URL is not set; set it to a dedicated loopback openbot_enterprise_* test database…」。

### F2（medium）journal statement_digest 与当前计划漂移比对

- **RED**（`red-F2-journal-digest-drift.txt`）：新增 `validateJournalAgainstPlan` 导入 + 单元/行为测试 → 模块导出不存在，`SyntaxError: Export named 'validateJournalAgainstPlan' not found`，exit 1（功能缺失型 RED）。行为测试覆盖 apply / dry-run / up-to-date 三条路径的漂移拒绝与「不自动修复」断言。
- **GREEN**（migrate-test.ts）：
  - `readJournalNumbers` → `readJournalEntries`：`SELECT number, statement_digest …`（42P01 缺表仍视作空 journal）；
  - 新增 `JournalEntry` / `validateJournalAgainstPlan`：先沿用 `validateJournalNumbers` 查编号连续前缀，再逐步骤比对 `statement_digest`；漂移 → `ok:false`，reason 含步骤名、两侧 digest 前缀、「journal and the current plan have drifted apart — manual review is required; the tool never rewrites or replays already-journaled steps」；
  - `runMigrate` 在 `connect` 之后、任何执行/分支之前调用该检查——**dry-run、apply、up-to-date 全部经过**；漂移即 `refused(stage:"journal")`，无事务、无步骤语句、无 journal 写入/改写（不自动修复/重放）。
- **过渡披露**：GREEN 第一版把 `plan.steps` 误传给期望 `MigrationPlan` 的参数，本轮 8 个测试当场失败（`undefined is not an object (evaluating 'plan.steps.length')`），修正为 `plan` 后全绿——失败被测试抓住本身即网有效性证据。
- **真实库冒烟**（专用库，psql 篡改 + 还原）：
  - 篡改 number=2 digest → dry-run `refused (journal): … drifted apart — manual review …`，exit 1；
  - 篡改 number=3 + **合法 manifest** apply → `refused (manifest 门禁通过后) refused (journal)`，exit 1（apply 路径同样拒绝）；
  - 还原后 dry-run exit 0；终态 journal 3 行 digest `66e51f…/852f77…/99e216…` 与计划及复审 apply-lifecycle 记录逐字一致。
- **单元/伪连接**：`green-F2.txt` **42 pass / 0 fail，exit 0**（含漂移拒绝、健康收敛、编号错误优先于 digest 比较、无自修复查询断言）。

### F3（low）`--manifest` 无 `--apply` 静默忽略 → 显式拒绝

- **RED**（`red-F3-manifest-without-apply.txt`）：新用例断言 `refused(args)` → 旧代码照常进入 dry-run 走到 `connect`（migrate-test.ts:928）触发探针 `connect must not be called on a refused run`，exit 1。
- **GREEN**：`parseArgs` 新增 `manifestPath && !apply` → `refused(args)`，消息「--manifest requires --apply; without --apply the command stays a dry-run and a provided manifest would be silently ignored, so it is refused instead」（与既有 args 拒绝风格一致，含 USAGE 提示风格不变）。
- **验证**：`green-F3.txt` 34 pass / 0 fail，exit 0；CLI 冒烟 `migrate MT000 --manifest /tmp/m.json` → `refused (args): …`，exit 1。

### F4（low）拒绝路径断言 `reads==[]`

- **RED**（`red-F4-helper-no-reads-assertion.txt`）：元测试构造含 `reads:["readFile:/tmp/tampered.json"]` 的 effects 断言 helper 抛错 → 旧 helper 静默放行（`Received value: undefined`），exit 1——正是复审指出的盲区。
- **GREEN**：`expectNoSideEffects` 追加 `expect(effects.reads).toEqual([])`；元测试转绿；全部既有拒绝用例（args/database-config 各路径）在强化 helper 下仍全过（证明当前拒绝路径确实零读），35 pass / 0 fail，exit 0。

## 3. 最终验证命令与退出码（全部实际执行）

| # | 命令 | 结果 / 退出码 | 存档 |
| --- | --- | --- | --- |
| 1 | `MT003_ASSIGNED_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55446/openbot_enterprise_mt003fix2_test bun test server/tests/multitenancy/migration-tool.test.ts`（全新库） | **42 pass / 0 skip / 0 fail，exit 0**（233 expect） | green-F1-fresh-db-with-env.txt |
| 2 | 同上（收敛库复跑） | **42 pass / 0 fail，exit 0**（230 expect，up-to-date 分支） | green-F1-second-run-uptodate.txt |
| 3 | 无 env 同命令 | **41 pass / 1 skip / 0 fail，exit 0**（skip 理由正确） | verify-final-no-env.txt |
| 4 | 非法 env（非回环 host） | **响亮失败，exit 1**（完整安全拒绝理由） | verify-bad-env-loud-failure.txt |
| 5 | `cd server && bun run typecheck` | **exit 0** | — |
| 6 | `bunx biome check server/scripts/multitenancy/migrate-test.ts server/tests/multitenancy/migration-tool.test.ts` | **exit 0**（Checked 2 files, No fixes applied） | — |
| 7 | `bun test server/tests/multitenancy/inventory.test.ts`（MT001 回归） | **33 pass / 0 fail，exit 0** | — |
| 8 | CLI 冒烟：F3 拒绝 / 健康 dry-run / F2 篡改→拒绝（dry-run 与合法 manifest apply）/ 还原→收敛 | exit 依次 1 / 0 / 1 / 1 / 0 | 本报告 §2 |
| 9 | `docker rm -f openbot-i6-mt003fix2-pg` | 容器删除，端口复查无监听 | §5 |

## 4. 约束核对

- **TASKS 注册表**：仍仅 `MT000`（`ALLOWED_TASK_IDS` 恰为 `["MT000"]` 断言持续通过）；未编写任何业务迁移。
- **安全拒绝零放宽**：criterion 1/2 全部既有拒绝用例原样保留且通过，且现在同时断言零读（F4）；F1 的 env 路径复用同一 `resolveTestDatabaseTarget`，安全强度只增不减。
- **基线不回退**：旧 34 用例全保留；34 pass 基线 → 42 pass（带 env）/ 41+1 skip（无 env）。
- **CLI 兼容**：除 F3 显式收紧外行为不变（dry-run 默认、apply 门禁、generate 语义、退出码语义均未动）。
- **无提交/推送/合并**：`git status` 仅 untracked 产物路径，无 tracked 修改。
- **测试资源清理**：见 §5。

## 5. 资源清理

- `docker rm -f openbot-i6-mt003fix2-pg`（`--rm` 一次性容器，用后删除）；`lsof -i :55446` 复查无监听。

## 6. 产出物清单（未提交，SHA-256 见 `checkpoints/MT003-fix2/`）

- 修改：`server/scripts/multitenancy/migrate-test.ts`（after `330524de…`）、`server/tests/multitenancy/migration-tool.test.ts`（after `cca6e35c…`）；before 哈希与转移 manifest 一致（`e00f90a4…` / `e004868a…`）。
- 新建：本报告、`checkpoints/MT003-fix2/{before.json, after.json, review-package.json, migrate-test.diff, migration-tool.test.diff, red-*.txt ×4, green-*.txt ×5, verify-*.txt ×4}`。
- diff 说明：两文件为 untracked，`git diff` 不可用；`*.diff` 由 before 副本（逆向本轮全部编辑重建，**SHA-256 与转移 manifest 逐字节核验相等**后生成）对 after 生成。

## 7. 结论

四个 finding（F1/F2 medium、F3/F4 low）全部按 RED→GREEN 关闭并留档；复审 F1 要求的「指定 URL 必须能真实运行集成测试」已在 55446 专属库以 42 pass / 0 skip 证实；F2 的漂移拒绝在伪连接与真实库（dry-run、合法 manifest apply）双路径复现；34 pass 基线无回退、TASKS 仍仅 MT000、无任何安全拒绝放宽。等待全新独立 Pi Reviewer 复审。
