# MT006 / Issue #49 — 实现轮 Task Brief（工作范围选择与团队管理）

角色：`backend_implementer`；完成后由全新独立 Pi Reviewer 复审。前置已集成（先复算 `checkpoints/prereq-manifest.txt`，不符即 worker_done --outcome failed）。

## 目标

用户登录后能列出自己有权进入的公司与团队并选择当前工作范围；公司管理员能管理本公司的团队与成员名单，但不会因此获得业务内容读取权。没有可用团队时返回明确的空状态而不是默认团队。

## 验收标准（逐条 TDD 留证）

1. 登录用户可列出其有资格的公司与团队（依据 = 有效 enterprise_memberships + enterprise_workspace_memberships 行，即 MT005 判定同一事实源）。
2. 选择当前工作范围：经裁决 #1 头（`x-openbot-tenant`/`x-openbot-workspace`）选择；无可用团队时返回明确空状态，**不回退默认团队**。
3. 公司管理员可管理本公司团队与成员名单（创建团队、成员加入/移除/停用——经 MT005 的 scope gate 或等价集中入口执行，不绕过）。
4. 管理权不隐含业务内容读取权（管理角色无资源读路径授权——越权用例证明）。

## 落点与约束

- 依据 seam 报告与 MT005 交付：判定/签发走 `enterprise/tenancy/store.ts` 的 createScopeResolver + `scope-gate.ts`；本票新增 API/服务面（建议新文件，如 `enterprise/tenancy/workspace-admin.ts` + 路由挂接）。
- `server/src/index.ts` 只允许追加路由注册段（MT013 并行票拥有启动校验段——勿动对方区域；你只在既有路由区追加）。
- expand-only：store.ts/scope-gate.ts 只在必要时纯追加导出（不改既有语义）；MT001-MT005 交付测试文件只读。
- 管理操作写路径走受限 operator 角色 + RLS（参照 MT004 表策略与 MT005 gate 的 set_config 模式）。
- 专用 pgvector/pgvector:pg16（端口 55461）+ 受限角色；缺 env 显式 skip；无 env 不回退开发库。
- 无提交/推送/合并/部署授权；未提交检查点 + SHA-256 清单（用实现者惯例：review-package.json 的 files 与 sha256-manifest.txt 同源生成——coordinator 流程要求）。

## 验证命令（全部记录退出码）

1. 新套件（建议 `server/tests/multitenancy/workspace-scope.test.ts`）四条验收逐条
2. `MT003_ASSIGNED_TEST_DATABASE_URL=… TEST_DATABASE_URL=… ENTERPRISE_TEST_*… bun test tests/multitenancy/` 全量（148 基线 + 新增，0 fail 0 skip）
3. `cd server && bun run typecheck`；`bunx biome check` 触及文件（存量按 D5 方式比对披露）
4. 清理容器与凭据

## 产出

- `reports/MT006.md` + `checkpoints/MT006/`（prereq 复算、before/after、diff、red-green/、mutation/≥3、review-package.json、sha256-manifest.txt）
- worker_done --outcome succeeded|failed，附 --report-path --files-modified
