# MT008 / Issue #51 — 实现轮 Task Brief（资源可见性属性与 workspace-v1 策略版本）

角色：`backend_implementer`；完成后由全新独立 Pi Reviewer 复审。前置已集成（先复算 `archive/plans/multitenancy-execution/checkpoints/prereq-manifest.txt`，不符即 worker_done --outcome failed）。

## 目标

资源可以标记为个人或团队公共，并通过新的策略版本表达团队公共授权；旧策略版本的语义保持不变，历史资源的暴露范围只能经明确迁移或明确选择改变。expand 阶段：本票只做属性、策略版本注册与解析、兼容与显式迁移；具体动作规则（成员可见性变更等）属 MT009/MT010，不做。

## 验收标准（逐条 TDD 留证）

1. 资源具有 private/workspace 可见性；未标记的资源保持既有行为（有回归测试）。
2. 新策略版本独立注册；旧版本判定结果在升级前后完全一致（对照测试：同一输入集在旧版本注册前后逐例断言相同）。
3. 把旧 public 资源迁移为团队公共必须经显式动作（迁移工具/入口只按显式清单执行）；迁移工具不会自动扩大范围（无清单/空清单零写入）。
4. 跨公司资源引用在新策略下永远拒绝（越权用例：A 公司主体引用 B 公司资源，403/404 语义不泄露存在性）。

## 落点与约束

- 勘察后建议落点：`server/src/enterprise/tenancy/` 新文件（如 `resource-policy.ts`：策略版本注册表 + 判定入口 + 可见性属性读取）+ 测试 `server/tests/multitenancy/resource-policy.test.ts`（票面 Verification 指定该路径）。
- 资源表勘察：可见性属性落库涉及 enterprise 域表时遵循 MT004/MT112 惯例（expand-only schema 追加 + RLS + FORCE；migrate-test 新任务注册）。
- **ALLOWED_TASK_IDS 钉死注意**：`migration-tool.test.ts:350` 现断言 `["MT000","MT004","MT112"]`；若需注册新迁移任务 ID，按裁决 #5 先例做窄例外（diff ≤ 裁决 #5 规模、diff 与哈希存档、报告披露），无则不动。
- 判定依赖 MT005 已集成 seam：`createScopeResolver`（enterprise/tenancy/store.ts）+ `scope-gate.ts`（同 advisory 键语义）；本票不改其既有语义（expand-only 纯追加导出可，改语义不可）。
- `server/src/index.ts` 启动段属并行票 MT013（运行中）——勿动；如需路由挂接只在既有路由区追加并披露。
- 专用 pgvector/pgvector:pg16（端口 55461）+ 受限角色；缺 env 显式 skip（五变量：TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL、ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL——见 workspace-scope.test.ts 守卫）；无 env 不回退开发库。
- 无提交/推送/合并/部署授权；未提交检查点 + SHA-256 清单（review-package.json 与 sha256-manifest.txt 同源生成）。

## 验证命令（全部记录退出码）

1. 新套件 `bun test tests/multitenancy/resource-policy.test.ts --timeout 30000` 四条验收逐条
2. 全量 `MT003_ASSIGNED_TEST_DATABASE_URL=… TEST_DATABASE_URL=… ENTERPRISE_TEST_SETUP_DATABASE_URL=… ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=… bun test tests/multitenancy/ --timeout 30000`（**基线 203/0/0skip**，新增后全绿）
3. `cd server && bun run typecheck`；`bunx biome check` 触及文件（存量按 D5 方式比对披露）
4. 清理容器与凭据（容器名固定 mt008-pg，psql 探针等就绪——勿只用 pg_isready，PG 初始化窗口有竞态）

## 产出

- `archive/plans/multitenancy-execution/reports/MT008.md` + `archive/plans/multitenancy-execution/checkpoints/MT008/`（prereq 复算、before/after-hashes、changes.diff、red-green/、mutation/≥3、review-package.json、sha256-manifest.txt——**manifest 必须覆盖全部声明交付物**，含 tests/support/ 下支撑文件，吸取 MT006 F2 教训）
- worker_done --outcome succeeded|failed，附 --report-path --files-modified
