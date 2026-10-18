# MT013 / Issue #57 — 独立复审 Task Brief

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_be2628da62f6` / Dispatch `ctx_9fb9633acb41`，已因平台重启终止结算——coordinator 已核磁盘检查点 34/34 哈希后按检查点受理）无共享会话。

## 背景（如实披露）

实现者经历上游 502 中断与 Orca 重启，死于 worker_done 发出前；全部交付物已完整落盘（archive/plans/multitenancy-execution/reports/MT013.md e552054e… + checkpoints 全套）。coordinator 已按 review-sha256-manifest 独立复算 34/34（两份 manifest 文件的自引用失配为已知形态，不计）。**manifest 格式注意**：`#` 注释分节；deliverables 路径相对 `server/`、checkpoints 相对 `archive/plans/multitenancy-execution/checkpoints/MT013/`、报告相对仓库根——先解析再复算。

## 目标

两个独立结论：(1) Spec compliance——Issue #57 四条验收（显式开关默认关+关闭逐字一致 / 开启时三校验任一失败拒绝启动 / 一条结构化审计记录 / 关闭模式零回退）；(2) Code quality。有效 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- `git rev-parse HEAD` = f0520524（BASE）。预期 git 状态：`M enterprise-tenancy.ts / store.ts / index.ts / config.ts`（前二为 prereq MT004/MT005 交付，index/config 含本票启动段/开关增量）+ 清单内 untracked。
- 按 manifest 复算（双基准路径，见上）；不匹配 → worker_done --outcome failed。
- 增量证明核验：报告声称「逆向剥除本票 hunk 后 index.ts 哈希 = 8c258384…（= prereq manifest 声明值）」——独立复算（从 changes.diff 反向 patch 或手工剥除）。

## 审阅对象

- `server/src/config.ts`（OPENBOT_MULTITENANCY 开关 + inventory/waivers 路径透传）
- `server/src/enterprise/tenancy/startup-checks.ts`（新：三 evaluator + 编排 + verdict）
- `server/src/index.ts`（仅启动序列段接线；MT006 路由段不存在于本树——本树基线为 MT005-era，正常）
- `server/tests/config.test.ts`（新 describe 8 用例）+ `server/tests/multitenancy/startup-checks.test.ts`（33 用例）
- 报告 `archive/plans/multitenancy-execution/reports/MT013.md` 与 `archive/plans/multitenancy-execution/checkpoints/MT013/**`

## 审阅要点

1. **AC1 开关**：默认关；on/true/1、off/false/0、垃圾值拒绝（loadConfig 阶段）；关闭时 index.ts off 分支零执行的增量哈希证明真实性。
2. **AC2 三拒绝路径**：coverage（schemaVersion/装配失败/serve 不平衡/unowned/unclassified + 豁免校验）、devBypass（singleUser + 遗留名 + 垃圾值）、databaseRoles（ob_ent_directory/ob_ent_data 能力角色形态 + 登录角色恰好一成员资格 + 三 URL 齐备）——全部评估完才结论（不短路）；探测只读不写。
3. **AC3 审计记录**：恰好一条 pino 结构化记录（type/mode/accepted/timestamp/checks）；refused → exit(1)；off 模式零新日志（报告 §5-D2 取舍——判定是否可接受）。
4. **AC4 零回退**：181=148+33 全量；相邻套件（config/identity-app-wiring/cull-sweep/shared-wiring）绿。
5. **越权/安全面**： waivers 必须指名真实入口且带非空理由（typo 拒绝）；超级用户 setup URL 冒充运行时 URL 被拒（真实库用例）。
6. **TDD/变异真实性**：RED-1（模块缺失）/RED-2（开关 15 fail）→ GREEN 链；MUT1-4 全部被杀且 RED-restore 后 GREEN 复原（original-hashes 三方一致）。
7. **boot-slice 冒烟证据**（verification/3a-3d jsonl）：无 inventory exit1、真实 539-uncovered exit1、全归属+真实角色 exit0 BOOT_CONTINUED、豁免留痕 exit1。
8. 报告 §5 披露（D1-D?）逐条处置意见。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55465`；起专用库（pgvector/pgvector:pg16，容器名 mt013-review-pg，**用 psql 探针等就绪勿只用 pg_isready**——PG 初始化窗口竞态会静默吞 CREATE）。
2. `TEST_DATABASE_URL=…55465/… ENTERPRISE_TEST_SETUP_DATABASE_URL=… ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=<三登录> bun scripts/enterprise-test-db.ts migrate` + `migrate-test.ts migrate MT004 --apply`（前置，吸取 MT112 L1）。
3. `bun --no-env-file test tests/multitenancy/startup-checks.test.ts --timeout 30000`（预期 33/0；真实库 5 用例需五变量 env）
4. `bun --no-env-file test tests/config.test.ts`（预期含新 describe 全绿）
5. 全量 `MT003_ASSIGNED_TEST_DATABASE_URL=… 其余同上 bun test tests/multitenancy/ --timeout 30000`（预期 **181/0/0skip** = 148 基线 + 33 新增；注意本树基线为 MT005-era，无 MT006/MT112 交付——203 是 EXE 集成树的数，勿混淆）
6. 抽查 boot-slice：node 起 index.ts 切片或按报告 verification/3* 方式复现一次 exit1/exit0（至少 3a 与 3b）。
7. `cd server && bun run typecheck`；`bunx biome check` 五个触及文件（存量比对披露）。
8. 清理容器与凭据。

## 产出

写 `archive/plans/multitenancy-execution/reports/MT013-review.md`（唯一允许新建/修改文件）：Verdicts、findings、命令与退出码、哈希复算、增量证明结论、报告披露处置意见。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。
