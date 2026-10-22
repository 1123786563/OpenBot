# Task Brief R4-backend — OCR round3 修复（后端 R4-1..R4-6）

角色：backend_implementer。工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`，BASE `9057aeeb`）。**无 commit/push/stash 授权**；只改 server/ 与 shared/ 之外不涉及（本票不改 shared/、不改 app/、不改 docs/plans 除你的报告文件）。

## 先读（按序）

1. `docs/adr/0008-test-runner-tester-army-e2e.md` — 两层制测试与已知坑（E2E_BUN_ONLY 用真实 group.name；独立报告目录；零测试/收集失败≠通过）。
2. `docs/plans/2026-10-19-plugin-package-marketplace/ocr/ocr-fix-plan-round4.md` — 你的范围 R4-1..R4-6 与全部裁决。
3. `docs/specs/2026-10-19-plugin-package-marketplace-design.md` §7（DDL 权威=migrate-test.ts 任务，镜像是 typed/query-visible 投影）。

## 修复项（finding 原文见 attempt4 JSON；此处为裁决后执行口径）

- **R4-1 [high]** `server/src/db/schema/enterprise-plugin-packages.ts`：镜像补 `enterprise_package_install_scope_id_uq`（`enterprise_package_installs` (tenant_id,workspace_id,id) 唯一索引；权威在 migrate-test.ts PKG03 `package_grant_table` 步）。
- **R4-2 [medium]** 同文件 `:451-460` + `server/scripts/multitenancy/migrate-test.ts` PKG03 任务：grants PK `(tenant,install,generation,bot,resource)` 缺 `tool_ref`，与活跃唯一索引（含 tool_ref）及其"one connector resource grants per tool"注释矛盾。裁决：**在 PKG03 任务 steps 末尾追加新步骤**（如 slug `package_grant_pk_tool_ref`）：`ALTER TABLE … DROP CONSTRAINT enterprise_package_grant_pk` + 重建为 6 列 PK（含 tool_ref）。既有行 tool_ref 全为 ''，对存量等价、唯一性放宽。镜像同步（primaryKey 加 tool_ref）；`server/tests/schema-drizzle-parity.test.ts` 期望更新；pkg03 驱动组加正测：同一 (install,generation,bot,resource) 下两条不同 tool_ref 的 connectorTool 活跃授权可共存（skill 行为不变）。
- **R4-3 [medium]** `server/src/enterprise/plugin-packages/install-service.ts` apply()（~:640）：写 linkRows 前在**同一事务**内复验 `canonical.connectorInstalls` 映射到的 connector install 仍存在；缺失 → 品牌化 packageError（错误码建议 `CONNECTOR_INSTALL_MISSING`，路由层映射到 4xx，不得裸 FK 500）。驱动组新增测试：plan 成功后经 setup 连接删除该 connector install 行 → apply 被拒、零 link 行、错误可解释。
- **R4-4 [medium]** `migrate-test.ts` PKG04 任务：`openbot_create_package_expert` 的敏感键防线仅顶层 `?|` 且大小写敏感。裁决：**追加新步骤**用 `CREATE OR REPLACE FUNCTION` 发布强化版（不得编辑已应用步骤文本）：递归扫描（对齐文件内 package_hardening 既有递归 CHECK 风格）+ 键名大小写不敏感；保留 `agentType='built_in'` 判定。驱动组新增直调测试（operator 角色真实调用函数）：`{"remote":{"endpoint":"…"}}`、`{"Token":"x"}`、`{"nested":{"apiKey":"x"}}` 均 `PKG_EXPERT_REMOTE_FORBIDDEN`；正常模板 default_config 仍可创建。
- **R4-5 [medium]** `server/src/index.ts` ~:1149：marketplace 索引路径改由 config 提供：`server/src/config.ts` 新增 `pluginMarketplaceIndexPath`（env `OPENBOT_PLUGIN_MARKETPLACE_INDEX`；默认= 现解析 `new URL("../../plugins/marketplace.json", import.meta.url)` 的等价绝对路径，行为不变；对照同文件 `pluginArtifactRoot` ~:2947 的既有模式）。Docker COPY 缺口不在本票（PKG11 受阻票已记录）。
- **R4-6 [medium]** 镜像 `:785-788` changes.action CHECK 对齐权威（含 `createExpert`；权威步骤 `package_changes_create_expert_action`）；`:29` 头注释表数/编号对齐实际八表；`server/drizzle.config.ts:40` 与镜像头注释的定位矛盾按 F1 既定裁决改写（parity 守卫下的受控 generate 源）。随 R4-1 同文件一并处理。

## 环境（已就绪，勿动他人容器）

- 企业测试库**全新重建**：容器 `openbot-enterprise-test-pg`（127.0.0.1:5435，`openbot_enterprise_test`，`openbot` 超级用户，trust），已跑 `bun server/scripts/enterprise-test-db.ts migrate`（migrations-applied ok + ent_* 角色已建）。首次驱动跑会重建全部 fixture（较慢，正常）。`openbot-test-pg` 等其他容器属其他会话，禁止触碰。
- env 来自仓库根 `.env`（bun 自动加载；勿 source）。

## 验证（全部 fresh 跑，证据目录独立命名）

- native（Node 层）：`E2E_UNIT_OUTPUT=.e2e/r4-backend-native bunx e2e run --config e2e.unit.config.ts server/tests/schema-drizzle-parity.test.ts server/tests/package-install-routes.test.ts server/tests/package-storage.test.ts server/tests/package-catalogue.test.ts server/tests/package-artifact.test.ts`（按实际触碰面增减）。
- driven（Bun 层，真实受限角色）：`E2E_BUN_ONLY='server/tests/multitenancy pkg02' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（输出目录用 `E2E_UNIT_OUTPUT=.e2e/r4-backend-driven-pkg02` 等）；pkg03 / pkg03b / pkg04 同法。R4-2/3/4 的新用例放进对应组文件。
- 门禁：`bun run --filter server typecheck`（允许且仅允许既有 3 个 bootstrap 错误——引用原文对比，不得新增）；触碰文件 `bunx biome lint <files>` 干净。

## 报告与边界

- 报告写 `docs/plans/2026-10-19-plugin-package-marketplace/tasks/R4-backend-report.md`：变更清单、每条 finding→修复映射、证据目录与关键输出原文、偏差与遗留。
- 迁移 journal/parity 架构若阻碍你：STOP 并在报告中写明具体阻碍，不得静默改已应用步骤或绕过 parity。
- 不发明产品范围；不改 app/、docs/plans 其他文件；接近 turn 上限时先把已完成部分+清单写进报告。
