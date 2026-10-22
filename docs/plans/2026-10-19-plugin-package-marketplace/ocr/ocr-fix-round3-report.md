# OCR Round2 medium 分诊修复报告（Round3 修复轮）

执行者：backend/app fixer（单批，未派发子 Agent）。工作区：`.worktrees/plugin-package-market`。
依据：`ocr-fix-plan-round3.md`（F1/F2/F3/F4/F8/F9/F12 必修，F5/F6 核验后修，M7/M10/M11 延后，M13 关闭）。
证据目录：`.e2e/ocr-fix-r3/`（全部为本次新生成）。

## 逐项结果

| 项 | 判定 | 处置 | 结果 |
|---|---|---|---|
| F1 | 有效（round2 时点） | `docs/verification/e2e-bun-suites.json` 用 `scripts/lib/e2e-manifest.mjs` 的 `writeManifest` 原地再生成（非手工排序）；两条款已在有序位（`multitenancy/package-storage.test.ts` @284、`package-install.integration.test.ts` @367，464 条严格有序）。同时把 `writeManifest` 序列化从 1 空格改为 2 空格，消除「脚本再生成 vs 已提交文件」的整文件重排 diff 噪音（round2 M1 指控的根因之一）；再生成后对脚本幂等（byte-identical）已验证 | 完成 |
| F2 | 已在树中生效 | `server/src/index.ts` pluginPackageRoutes 装配处 `createDatabase(operatorUrl)` 已在内层 try 内、失败 `return null`（503 降级、只读保留），与 finding 建议的 diff 逐字一致。本轮核验确认，未重复改动 | 已应用（核验） |
| F3 | 已在树中生效 | `app/src/components/market/package-install-dialog.tsx` buildConfig 已 import 并使用 `PACKAGE_CONFIG_LIMITS`（maxKeys/maxKeyLength/maxValueLength），无裸数字残留 | 已应用（核验） |
| F4 | 已在树中生效 | `app/src/components/market/package-pane.tsx` loadMore 已有 cursor 去重守卫（`cursors[cursors.length-1] === next → return held`） | 已应用（核验） |
| F5 | 核验为真实契约缺口 | 全局搜索确认 `authorizeCompanyManagementAction`/`recordManagementAuditEvent` 在 server/src 无生产调用方（仅 admin-separation.test.ts 消费）——落库不是「上游已做」，而是「无人接线、契约无约束」。按 finding 最小加固：在 `server/src/enterprise/tenancy/admin-separation.ts` 新增组合入口 `authorizeAndRecordCompanyManagementAction(input, tx)`（allow 的审计事件在同一 operator 事务内写入，写入失败即动作失败；deny 不接触事务），模块头注释同步指名该入口为未来接线方的唯一路径。不改既有导出语义 | 完成 |
| F6 | 核验为真实（模块内 fail-open） | `authorizePlatformManagementAction` 原只查 `actor.kind`，空 subject 直接放行。已加空主体拒绝（`PLATFORM_ADMIN_REQUIRED`，与公司面空 tenantId 拒绝对称） | 完成 |
| F8 | 部分已在树中生效 | catalogue.ts `inputInvalid()` 已是 `packageError("INPUT_INVALID")`；本轮补齐 `get()` 内残留的裸 `throw new Error("RESOURCE_NOT_FOUND")` → `packageError("RESOURCE_NOT_FOUND")`（routes errorCodeFor 走 `packageErrorCodeOf` 分支，映射不变） | 完成 |
| F9 | 有效 | `app/src/lib/client.ts` 带 key 解包：key 缺失（JSON 无 undefined 值，缺失即契约漂移）改为抛 `new Error(await fallbackText(options))`，与相邻 malformed-body 守卫同一处理；存储的 `null` 照常透传。新增测试覆盖缺失键（带/不带 fallback）与 null 值两分支；既有「byte-for-byte」用例的空对象 stub 补上所请求的 key | 完成 |
| F12 | 有效 | `server/src/index.ts`：`repeatAfterEach(kick, 2_000)` 句柄提升为模块级 `handoffKickSweep: Repeating | undefined`，SIGINT/SIGTERM 处理器在 deliverySweeps 之后 `handoffKickSweep?.stop()`（能力关闭时为 undefined，与 workOfferedListener 同一判空模式） | 完成 |
| M7 / M10 / M11 | 延后 | 未动（P7 保留策略、P10 重复构造、P11 索引），维持计划记录 | 延后 |
| M13 | 关闭 | 未动 | 关闭 |

## 门禁结果（证据均在 `.e2e/ocr-fix-r3/`）

| 门禁 | 命令 | 结果 |
|---|---|---|
| server typecheck | `cd server && bun run typecheck`（tsc --noEmit） | exit 2，恰好 3 条 `scripts/bootstrap-local-gateway.ts` 既有错误（106/108/120），无新增 |
| app typecheck | `cd app && bun run typecheck` | exit 0 |
| biome（改动文件） | `bunx biome check` 逐一 | client.ts、enterprise-client.test.ts、catalogue.ts、admin-separation.ts、admin-separation.test.ts、e2e-manifest.mjs 全部 0 findings（测试文件先 `--write` 格式化）。两个例外见下「已知既有」 |
| app client 套件 | `E2E_UNIT_OUTPUT=.e2e/ocr-fix-r3/app-client bunx e2e run --config e2e.unit.config.ts app/tests/enterprise-client.test.ts` | exit 0，9/9（含 F9 新增用例） |
| server package 套件 | 同上，`server/tests/package-{catalogue,grants-routes,expert-routes,read-routes,install-routes}.test.ts` | exit 0，5 文件 99/99 |
| admin-separation 套件（unit 半区） | `cd server && bun --env-file=../.env test tests/multitenancy/admin-separation.test.ts` | 22 pass / 0 fail，含 F6 新增空主体用例与 F5 组合入口收集 |
| admin-separation 套件（真实 DB 半区） | 同上 + `ENTERPRISE_TEST_SETUP_DATABASE_URL=$TEST_DATABASE_URL` | **环境阻塞**：fixture beforeAll 的能力校验连不上 `127.0.0.1:5435` —— `remaining connection slots are reserved for roles with the SUPERUSER attribute`。端口 5435 的 97 个连接被并发残留进程占用（PID 58527，`bun --env-file=/tmp/pkg-server-fc1.env src/index.ts`，09:24 启动，fc1 轮的 env 文件）；非本修复引入（失败点在 `support/fixture.ts:836` → `connections.ts verifyCapability`，先于任何被改代码执行）。两次尝试均复现，证据：`mt-admin-separation/run.log`、`run-retry.log` |

### 已知既有（非本轮引入，未修改）

- `server/src/index.ts` 的 5 条 biome 报错（`noNonNullAssertion` ×2 @5397/@6956、`noConsole` ×3 @1014/@1042/@1076）——经 `git show HEAD` 核对全部存在于 HEAD（HEAD 行号 5298/6856/1004/1032/1066），本轮对该文件的全部改动（handoffKickSweep 三处）不产生任何新 finding。
- `docs/verification/e2e-bun-suites.json` 对 biome formatter 的「单元素数组折叠」差异——HEAD 版本同样不满足（stdin 校验证实），且无任何仓库门禁执行它（`lint` = biome lint、`test:ci` = coverage audit + e2e run）。2 空格序列化已把再生成 diff 压到最小。

## 测试覆盖说明

- F5 新增 DB 用例（`authorizeAndRecordCompanyManagementAction` allow→落库读回 / deny→无写入）与既有 AC1 审计落库用例同属被阻塞的 DB 半区；其两个组成部分各自已被覆盖：判定逻辑由 22 条 unit 测试覆盖（本轮 0 fail），`recordManagementAuditEvent` 的插入路径由既有 AC1 用例覆盖（代码未改）。组合本身由 tsc 类型检查约束。DB 半区恢复后可直接重跑同一命令验证。
- F12 的行为（优雅停机不再 claim 新租约）无直接单测覆盖；改动为句柄持有 + 信号处理器 stop，与既有 15 个具名 sweep 同构，由 server typecheck 把关签名与作用域。

## 文件清单（本轮实际改动）

1. `docs/verification/e2e-bun-suites.json`（F1，writeManifest 再生成）
2. `scripts/lib/e2e-manifest.mjs`（F1，序列化 2 空格对齐 formatter）
3. `app/src/lib/client.ts`（F9）
4. `app/tests/enterprise-client.test.ts`（F9 用例 + stub 修正 + 格式化）
5. `server/src/plugin-packages/catalogue.ts`（F8）
6. `server/src/enterprise/tenancy/admin-separation.ts`（F5 组合入口 + F6 空主体拒绝 + 头注释）
7. `server/tests/multitenancy/admin-separation.test.ts`（F5/F6 用例 + import）
8. `server/src/index.ts`（F12：handoffKickSweep 声明/赋值/stop）
