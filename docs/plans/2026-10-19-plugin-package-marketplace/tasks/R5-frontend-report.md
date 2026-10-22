# Task Report R5-frontend — OCR round5 修复（R5-5..R5-8）

角色：frontend_implementer。工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`）。**无 commit / push / stash**——全部变更为工作树状态。

结论：**R5-5 done · R5-6 done · R5-7 done · R5-8 done**。验证全绿（native e2e 触碰面 5 套件 55 条用例全过、`bun run --filter app typecheck` 0 错误、触碰 7 文件 biome lint+check 干净）。未改 `server/`、未改 `shared/`、未改 `docs/plans/` 其他文件。

## 先读记录

1. `docs/adr/0008-test-runner-tester-army-e2e.md` — 两层制；本票 UI 测试全部走 native 层（`bunx e2e run --config e2e.unit.config.ts`），证据目录 `E2E_UNIT_OUTPUT=.e2e/r5-frontend-native` 独立指名。
2. `docs/plans/2026-10-19-plugin-package-marketplace/ocr/ocr-fix-plan-round5.md` — 本票范围 R5-5..R5-8（均 medium），Parked 22 low 不扩面。
3. `round4.json` 原始 finding 四条（package-grants.tsx:84、package-experts.tsx:167/99、package-detail.tsx:302）逐一核对后实施。
4. 项目技能 openbot-data-access（精确失效纪律：变更只失效 installDetail 键，读取端向该键对齐，而不是扩失效面）与 openbot-screen-layout（本票未新增屏幕/布局面，对话框沿用既有 fieldset/legend/WbTag 词汇）。

## 变更与 finding→修复映射

### R5-5 [medium·bug] 勾选再播种以身份字段为依据 — done

- `app/src/components/market/package-grants.tsx`：useEffect 依赖从 `[detail.data, trimmedBotId]`（对象引用）改为四个**身份原语**：`trimmedBotId`、`activeGrantRevision`（当前输入 Bot 自己的 grant revision——契约的 CAS 计数器，该 Bot 的任何 grant/revoke 提交都会移动它）、`activeResourceKey`（该 Bot 已授资源 id 排序拼接串）、`installGeneration`（安装世代，grants 不 bump 它）。effect 体内只读 `activeResourceKey`；三个未读依赖是再播种**信号**，带单行 `biome-ignore lint/correctness/useExhaustiveDependencies` 说明（仓库先例：`preview-tab.tsx:856` 同款）。`detail.data` 引用变化（他人 Bot 的 revoke/grant/expert-create 触发的 invalidate→refetch、窗口 refocus）不再清空进行中勾选；输入新 Bot ID 仍从头播种（两个都无 grant 的 Bot 之间切换也会清空，靠 `trimmedBotId` 信号保证）。
- 测试（`app/tests/plugin-package-grants.test.tsx` 新增）：**"revoking one Bot keeps another Bot's in-progress selection"** — fixture 增加 `GRANT_A`（bot-a，r1）与 `botAGrantActive` 旋钮 + bot-a 的 DELETE 处理；先给 bot-b 勾选 notes-skill，再点 bot-a 的 Revoke，settle 出 bot-a 行消失并 `flush()` 多等数轮 refetch，断言 bot-b 的勾选仍为 checked。修复前该用例 RED（`expected false to be true`，旧行为：新 `detail.data` 引用触发 effect → 清空）。

### R5-6 [medium·maint] 成功页改 TanStack Link SPA 导航 — done

- `app/src/components/market/package-experts.tsx`：`render={(anchorProps) => <a {...anchorProps} href={`/bots/${expert.agentId}`} />}` 改为 `render={<Link params={{ agentId: expert.agentId }} to="/bots/$agentId" />}`，与 `agent-card.tsx:60` 既有模式逐字同构；注释同步（客户端导航，不再整页刷新）。
- 测试（`app/tests/plugin-package-experts.test.tsx`）：renderPane 改挂**真 RouterProvider**（decoy 树只注册 `/bots/$agentId` 一条路由，同 `bot-roster.test.tsx` 形状）；既有断言 `link.getAttribute("href") === "/bots/${agentId}"` 不变即绿（Base UI Button 的 Link 渲染为 role=button + href，与 ai-observability-exports.test.tsx 记录的形状一致）。
- **harness 关键事实（见偏差 1）**：native Node runner 下 TanStack Router 的 `RouterProvider` 挂载即崩（`Matches.js:38 reading '0'`），根因是 `@tanstack/router-core` 的 `./isServer` 导出在 `node` condition 下 `NODE_ENV!=="test"` 时返回 `true`（runner 实测 `NODE_ENV=development`），Matches 因此跳过为 `router._rendered` 播种的 Transitioner。仓库已把全部 router 渲染套件（bot-roster、bot-app-grants-screen、ai-observability-exports 等）放进 bun-driven 层，理由字段记录的正是这个错误。本套件保持 native，用该仓库既有的 `mock.module` 纪律把 `@tanstack/router-core/isServer` 钉回 client 真值（`isServer: false` + `loadServerRoute: undefined`，与 client build 逐字段同形），router 相关 import 全部改为 mock 之后、渲染之前的 top-level `await import`（`billing-credits-ui.test.tsx` 模式）。该 mock 值就是 DOM 环境的语义真值，进程内后载文件读到的是同一事实。

### R5-7 [medium·bug] 向导不再把修订全集当"将授予" — done

- `app/src/components/market/package-experts.tsx`：
  - 预创建 fieldset：legend 从「本次创建将授予的包技能」改为「安装版本的技能资源」（`packages.experts.skillsLabel` 新句），列表语义变为**修订全集 = 超集**；其下新增说明行 `packages.experts.skillsSubsetNote`：创建实际授予的是模板声明的技能——上院子集，绝不多授；精确集合由服务器在创建时确认、结果页列出（模板→技能映射不在 wire contract 的 resource summary 上，客户端预创建无法枚举，措辞按 reviewer 建议不承诺授予）。`noSkills` 同步改为「修订未声明技能资源故不授予」语义。
  - 成功视图：新增**回执 fieldset** `packages.experts.grantedSkillsLabel`，列出 `PackageExpertCreatedDTO.resources`（实际授予集的权威来源；空数组不渲染）。文件头注释同步（"Creating grants exactly the skills the template declares … `PackageExpertCreatedDTO.resources`"）。
  - i18n en+zh-CN 各 +2 新键、改 2 键；无孤儿键（新增键都有消费点，改动键测试同步）。
- 测试（`app/tests/plugin-package-experts.test.tsx` 新增 + 既有改断言）：fixture 给修订加第二个技能 `archive-reader`（模板只声明 `notes-writer`，`EXPERT.resources` 本就是单元素）。新用例 **"the wizard lists the revision's skills as the superset and the receipt names the granted subset"** 断言子集场景三段：预创建展示修订两技能 + 子集规则句、不出现旧授予承诺句；创建后回执列出且仅列出 notes-writer；archive-reader 在成功视图完全不出现（旧代码在预创建把它当"将授予"承诺）。既有主流程用例的旧 label 断言改为新 label + 子集说明句。

### R5-8 [medium·bug] 同对话框事实单一来源 — done

- `app/src/components/market/package-detail.tsx`：按 openbot-data-access 精确失效纪律**择"详情框改读 installDetail 查询"**（不扩 mutation 的失效面——三个写操作的 onSuccess 已精确失效受影响的 installDetail 键，读取端向同一键对齐即单一来源）：`PackageDetailWb` 内 `useQuery(pluginPackageInstallDetailQueryOptions(...))`，`installFacts = installDetail.data ?? install`，事实块 `{installFacts ? <PackageInstallFacts install={installFacts} /> : null}`；与 sections 的订阅同键同源，**零新增请求**（同键去重），list 行 install 降级为首次渲染占位。
- **订阅门控**（精确订阅纪律）：`enabled = canInstall && install !== null && install.status !== "uninstalled"`，与 sections 渲染门同一常量 `managesInstall`（两处共用，无重复表达式）。成员视图永不变更 → 不发请求（保住 "a plain company member has no … requests leave" 两条既有约束，首次实现无门控时正是这两条用例抓住了多发的请求）。事实块的 pending/error 分支天然退化：未应答时显示占位 prop（列表事实），查询失败同样回落——成员与失败面均无行为变化。
- 测试（`app/tests/plugin-package-grants.test.tsx` 新增）：**"after a grant the dialog's install facts agree with the fresh install detail, not the stale list row"** — list 端点全程返回陈旧的 needs_grant 行；grant 前 `Needs Bot grant` 可见，grant 后断言 `Needs Bot grant` 消失、`Ready` 出现、grantNotice 句消失。修复前 RED（`expected <span…>Needs Bot grant</span> to be null`——事实块读陈旧 prop）。

## 验证（fresh 跑，证据目录独立）

1. **native 触碰面全套**（命令与输出原文）：

```
E2E_UNIT_OUTPUT=.e2e/r5-frontend-native bunx e2e run --config e2e.unit.config.ts \
  app/tests/packages-page.test.tsx app/tests/plugin-package-grants.test.tsx \
  app/tests/plugin-package-experts.test.tsx app/tests/plugin-package-install.test.tsx \
  app/tests/plugin-package-catalogue.test.tsx

 ✓ |node| app/tests/packages-page.test.tsx (7 tests) 194ms
 ✓ |node| app/tests/plugin-package-catalogue.test.tsx (15 tests) 639ms
 ✓ |node| app/tests/plugin-package-grants.test.tsx (8 tests) 793ms
 ✓ |node| app/tests/plugin-package-experts.test.tsx (8 tests) 921ms
 ✓ |node| app/tests/plugin-package-install.test.tsx (17 tests) 1.57s
 Test Files  5 passed (5)
      Tests  55 passed (55)
```

2. **RED 原文**（修复前，`.e2e/r5-frontend-red2/`、`.e2e/r5-harness-check/`）：

```
FAIL …plugin-package-grants > revoking one Bot keeps another Bot's in-progress selection
ASSERTION_FAILED: expected false to be true
FAIL …plugin-package-grants > after a grant the dialog's install facts …
ASSERTION_FAILED: expected <span …>Needs Bot grant</span> to be null
FAIL …plugin-package-experts > an admin creation POSTs …
Unable to find an element with the text: Skill resources of the installed revision (read-only).
```

（另有 harness 中间轮 6 条用例失败一轮，系 router harness 迭代中间态，最终形态收敛为上述 3 条针对性 RED。）

3. **门禁**：

```
bun run --filter app typecheck   → app pretypecheck: Exited with code 0；app typecheck: Exited with code 0
bunx biome lint   <7 触碰文件>    → Checked 7 files in 4ms. No fixes applied.（0 错误）
bunx biome check  <7 触碰文件>    → Checked 7 files in 10ms. No fixes applied.（0 错误，含 format）
```

4. **证据落盘**：`.e2e/r5-frontend-native/report.json`（status=passed，exit=0，run id `01a15816-2473-7cac-b6f2-6aacc21e8bde`）；RED 证据 `.e2e/r5-frontend-red/`、`.e2e/r5-frontend-red2/`、`.e2e/r5-harness-check/`。

## 偏差与备注

1. **R5-6 的测试层事实（重要，供 reviewer 与后续 OCR 知悉）**：TanStack Router 在 native Node runner 下无法挂载，根因是 `@tanstack/router-core@1.171.27` 的 `./isServer` 导出按 `node` condition 在 `NODE_ENV!=="test"` 时取 `isServer=true`（runner 实测 `NODE_ENV=development`），`Matches.js` 因而不渲染为 `router._rendered` 播种的 Transitioner 并在 `Matches.js:38` 崩溃（`Cannot read properties of undefined (reading '0')`）。仓库对既有 router 套件的裁决是整体移入 bun-driven 层（`docs/verification/e2e-bun-suites.json:1174` 记录的 bot-roster 理由即本错误原文）；本套件**保持 native 不迁移层**（迁移需要整套改写为 bun:test 且要动 `scripts/lib/e2e-manifest.mjs` + `docs/verification/e2e-bun-suites.json`，超出本票范围），改为仓库既有 `mock.module` 纪律钉回 `isServer:false`（单点、与 client build 同形、语义上就是 DOM 环境的真值）。生产代码零特殊化：`package-experts.tsx` 的 `import { Link } from "@tanstack/react-router"` 与 `agent-card.tsx` 完全同构。
2. **R5-8 择型**：按纪律择「详情框改读 installDetail 查询」而非「扩失效 list 键」——三个写 mutation 已精确失效 installDetail 键（openbot-data-access 的既有正确形态），读取端对齐后同一对话框内事实同源；再加 list 失效会扩大每次写操作的 refetch 面，违背精确失效纪律。成员视图不加订阅（无写则无新鲜度需求），由两条既有成员用例守住。
3. **`biome-ignore` 单行形式**：`useExhaustiveDependencies` 的抑制注释必须是紧贴诊断行的**单行**注释（多行块会被读成 `suppressions/unused`），仓库先例 `preview-tab.tsx:856` 即单行长句，本票同形。
4. **测试 fixture 扩面**：experts 套件的修订资源增加 `archive-reader`（第二个 skill）——既有 15 条 catalogue 套件有自己的 fixture，不受影响（已跑绿）；grants 套件新增 `bot-a` grant/DELETE 通道，默认旋钮关闭，既有 6 条用例零改动。
5. **既有工作树状态**：worktree 含 PKG01–04 未提交功能改动与并行 server/ 改动（`git status` 所见均非本票触碰）；本报告全部验证是在该状态之上的 fresh 跑。`.worktrees` 下有一条他人遗留 `stash@{0}`（WIP on main），本票未做任何 stash 操作。
6. Parked 项（i18n 孤儿键、`newIdempotencyKey`/`statusOf`/`serverMessageOf` 三份拷贝、sections 重复的加载/错误外壳等 22 low）按 round5 裁决未扩面。

## 边界确认

- 未改 `server/`、未改 `shared/`（`PackageExpertTemplateSchema.skills`、`PackageExpertCreatedDTO.resources` 仅按现有契约消费）。
- `docs/plans/` 仅新增本报告文件；未改 `scripts/`、`docs/verification/`。
- 无 commit / push / stash。
- 触碰文件清单（7）：`app/src/components/market/package-grants.tsx`、`app/src/components/market/package-experts.tsx`、`app/src/components/market/package-detail.tsx`、`app/src/locales/en/market.json`、`app/src/locales/zh-CN/market.json`、`app/tests/plugin-package-grants.test.tsx`、`app/tests/plugin-package-experts.test.tsx`。
