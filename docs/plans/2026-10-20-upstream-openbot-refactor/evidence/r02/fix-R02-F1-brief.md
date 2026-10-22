# Fix Brief R02-F1：技能保存路径放行逻辑研究角色 ref

- **来源**：R03 实现者升级的真实冲突（主控核实）：`server/src/plugins/store.ts` 技能保存路径（~:5054 `knownToolRefs(declared)`）把 `@research/search` 拆成 serverId "@research" 查 `mcpTools` 表，查无 → `PluginRefusedError` → `POST /skills` 400。R02 已在 selection 求交（`researchRoleOf` 语义），但未放行保存校验——up10 criterion 5"共享工具角色同时用于引导语、技能选择和对话摘要"端到端在此断开。
- **裁决（主控）**：合法逻辑角色 ref（`researchRoleOf(ref) !== null`，即恰 `@research/search`/`@research/fetch`）是声明性引用，授权在选择时与实际 granted refs 求交（R02 已落地），保存校验应视为 known，不查 DB、不要求 server 行。错拼/多斜杠仍按未知拒绝。

## owner_role: backend_implementer
## owned_files
- `server/src/plugins/store.ts`（仅技能保存校验路径的最小改动；不碰 connect-prompt/callTool/其他）
- `server/tests/plugin-store.integration.test.ts`（扩展）或新建 route 级测试文件（如更合适，登记对账）

## 要求（RED→GREEN）
1. **RED**：技能声明含 `@research/search`（或 fetch）→ 保存成功且持久化该 ref（DB 用 fixture 库，可复用/新建 `openbot_r02f1_test` 迁移库）；先跑证明当前 400。负例：`@research/searh`、`@research/`、`research/search`（无 @）→ 仍 400 拒绝。
2. **GREEN**：最小实现——`knownToolRefs` 调用处（或其内部）对 `researchRoleOf(ref) !== null` 的 ref 直接视为 known（复用 `shared/research.ts` 的 `researchRoleOf`，消费侧护栏同 R02 模式）；不改变对真实 `serverId/tool` ref 的 DB 校验语义；审计不新增泄漏。
3. **回归**：`TEST_DATABASE_URL=<库> bun test ./server/tests/plugin-store.integration.test.ts` 全绿（含 R02 既有 141）；selection 求交用例不受影响；`bun run --filter server typecheck`（3 条 BASE 红不计入）；`bunx biome format` 两文件真实 exit 0。
4. 报告追加 `evidence/r02/implementer-report.md` 的 R02-F1 段。

## 禁止
- 不改 selection/tools/catalogue/shared；不授予任何新权限（角色 ref 的授权仍在求交层）；无 commit/stash。
