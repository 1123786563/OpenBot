# R5-frontend 独立复审 — OCR round5 修复（R5-5..R5-8）

角色：frontend reviewer（只读）。工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`，worktree 全部为未提交状态）。复审对象：`R5-frontend-report.md` 所述 R5-5..R5-8 修复与其触碰 7 文件。复审方法：逐条对照 `ocr/ocr-fix-plan-round5.md` 原始 finding、契约原文（`shared/enterprise/plugin-package-contracts.ts`）、服务端 generation 语义（`server/src/enterprise/plugin-packages/`）、既有 mock/测试分层记录（`e2e-bun-suites.json`、`tests/support/e2e-compat.ts`、`e2e` runner 源码），并 fresh 重跑全部门禁与针对性对抗实验（无源文件改动，证据落 `.e2e/r5-frontend-review-*`、`.e2e/r5-fig/*`）。

## 结论

**SPEC: PASS** · **QUALITY: PASS** · blocking findings：**0**

---

## R5-5 [medium·bug] 勾选再播种以身份字段为依据 — PASS

**实现核对**（`app/src/components/market/package-grants.tsx:93-110`）：effect 依赖恰为四个身份原语——`trimmedBotId`、`activeGrantRevision`（该 Bot 自身 CAS 计数）、`activeResourceKey`（该 Bot 已授资源 id 排序拼接）、`installGeneration`（install 的 generation）；effect 体只读 `activeResourceKey`，三个信号依赖以单行 `biome-ignore` 抑制（先例核实：`preview-tab.tsx:856` 同款单行 + "SIGNAL, not a read" 理由句）。

**身份原语的服务端语义核实**（关键，不止采信报告）：
- grant 行的 `generation`（`grants.ts:35-38`，每次 set/revoke 写 `max+1`）与 install DTO 的 `generation` 是**两个概念**；DTO `generation` 仅在 disable/uninstall 时 bump（`grants.ts:772` 注释引 Spec §10），grant/revoke/expert-create 均不动它（`experts.ts` 只 CAS 读 `install.revision`，无 generation 写点；grep 全量核实）。
- 因此跨 Bot 的 revoke/grant/expert-create 只产生新 `detail.data` 对象引用，四个原语全部不动 → 不清空进行中勾选（本票目标场景）；该 Bot 自身任何提交移动 `activeGrantRevision` → 以服务端真值重播种（supersede 语义保持）；install 生命周期变化移动 `installGeneration` → 重播种。与计划的四原语定义逐字吻合。
- `\u0000` join + sort 使资源键对服务端返回顺序不敏感，跨 refetch 稳定。

**RED 证据核实**：`.e2e/r5-frontend-red2/results/plugin-package-grants-test-revoking-one-bot-keeps-another-c7e6f4b26a281321/trace.md` 原文 `ASSERTION_FAILED: expected false to be true`（run `01a1580b`）——与旧行为推演一致（旧 `[detail.data, trimmedBotId]` 依赖下，invalidate→refetch 新引用必触发清空）。RED 可信、非摆拍。测试本身（`plugin-package-grants.test.tsx:580-612`）先勾选 bot-b、bot-a revoke settle 后再 `flush()` 8 轮 outwait 残余 refetch，最后断言勾选仍在——能抓住回归。

**fresh 复跑**：本套件 8/8 过（见验证节）。

## R5-6 [medium·maint] Link 同构 + isServer mock 测试基建 — PASS（附 1 条 low 发现）

**Link 用法**：`package-experts.tsx:197-202` `render={<Link params={{agentId}} to="/bots/$agentId" />}` 与 `agent-card.tsx:60` 逐字同构。生产代码零特殊化（import 静态、无条件分支）。注释同步。

**mock.module 钉 isServer 的重点审查结论——成立**：
1. **根因属实**：`@tanstack/router-core@1.171.27` 的 exports 中 `node`/`bun` condition 指向 `isServer/server.js`：`isServer = NODE_ENV === "test" ? void 0 : true`（文件原文核实）；browser/默认 condition 指向 `client.js`：`isServer=false; loadServerRoute=void 0`。native runner 下 RouterProvider 挂载崩溃（`Cannot read properties of undefined (reading '0')`）与 `e2e-bun-suites.json` 记录的 37 个 router 套件迁层理由**逐字同一错误原文**（bot-roster 条目核实）。RED trace（`.e2e/r5-frontend-red2/...experts.../trace.md`）即该崩溃。
2. **单点**：mock 只在 `plugin-package-experts.test.tsx:48-51` 一处、一个 specifier。交叉核对 `e2e-bun-suites.json` 与全部测试文件 import：**native 层唯一 import `@tanstack/react-router`/`router-core` 的套件就是本套件**（其余 37 个全在 bun 分层，bun 层跑 `bun test`，不经过 e2e 的 Node worker——mock 注册表对彼层不可达）。
3. **不影响其他套件**：mock 是进程级（`e2e-compat.ts:578` 明文"registry level and outlives the file"），但钉回的值与库自己的 browser build **逐字段相同**（`client.js` 原文核对），即 happy-dom DOM 文件的语义真值；无任何 native 套件断言 `isServer===true`，也无 native 套件渲染 router。跨文件传递加载（package-detail→package-experts→react-router）在 grants/install/catalogue/packages-page 四套件中实际发生且全绿。
4. **符合仓库纪律**：与 `billing-credits-ui.test.tsx:35-` 的既有模式同构（mock.module 先行 + mock 后 render 前动态 top-level `await import`）；mock 值"shape-compatible with the real build"的要求满足得更强——就是 browser 变体原文。
5. **更小代价替代均不成立**：`createRouter({isServer:false})` 不充分——`@tanstack/react-router` 的 `Asset.js:5/33/108`、`Match.js:13/24` 直接读模块级 `isServer` 绑定（`isServer ?? router.isServer`，模块值为真即短路），router option 治不了模块级读取；mock Link 组件则丢掉 R5-6 要求的"真 Link 产出真 href"断言价值；迁 bun 层需动 `e2e.unit.config.ts` 排除 + `e2e-manifest.mjs` + `e2e-bun-suites.json` + 整套改 bun:test，超出本票范围（报告偏差 1 的取舍记录属实、合理）。

**Q1（low，非 blocking，见 findings）**：对抗实验发现一个**预先存在的** worker 竞态：与 billing-credits-ui（其组件图经 `page-shell.tsx`/`admin-sidebar.tsx` 传递 import react-router）共槽同进程时，若对方文件先评估，真实 `isServer=true` 模块被进程缓存，本套件 8/8 以同一崩溃失败（3 次复跑 2 次复现）；反转共跑顺序或无 billing 组合则稳定全绿（本套件与触碰面组合 4 次 fresh 全绿）。该隐患属 native worker 跨文件模块单例共享的既有类（`preload.ts` 头注释记录的正是同类问题；37 套件迁层记录的是同一崩溃签名），非本 mock 引入，但 R5-6 使本套件成为 native 层唯一对该隐患敏感者。建议后续 ticket：迁层或上报 runner 隔离问题；OCR round5 全量 native sweep 需知悉此 flake 源。

## R5-7 [medium·bug] 超集/子集表述 — PASS

**契约一致性核实**：
- `PackageExpertTemplateSchema.skills`（contracts:557）注释明示"Must equal the manifest's `expertTemplate.skills`"；manifest superRefine（contracts:134-149）强制模板 skills 引用必须存在于同 manifest 的 skill 资源 ⇒ "模板 skills ⊆ 修订全部 skill 资源"成立，向导列修订全集为"超集"的表述准确。
- wire 资源摘要 `PackageResourceSummarySchema`（contracts:218-226）strict `{id,kind,available}`——**确无模板→技能映射**，客户端预创建无法枚举子集，"列全集+声明规则+回执"是唯一 wire 诚实形态。
- `PackageExpertCreatedDTO.resources`（contracts:601）注释"The template's skill resources granted to the new Bot at creation"——成功视图以之为权威回执（`package-experts.tsx:171-188`），空数组不渲染。

**计划字面偏差（可接受，S1）**：计划原文"展示改为模板声明的 skills"，实现改为"修订全集（标注超集）+ 子集规则句 + 服务端回执"。原因成立：按字面展示模板 skills 需要服务端在 wire 上新增映射（超 frontend 范围、违反只改 app/ 约束）。修复目标（不再把全集承诺为"本次将授予"）达成：旧承诺句已删（grep 无残留），新 label/noSkills/skillsSubsetNote/grantedSkillsLabel 四键语义正确。偏差已在报告记录。

**i18n**：en/zh-CN 键集合逐键对比（plural 形式差异除外）完全一致；四键双语齐、均有消费点；旧"本次创建将授予"措辞 en/zh 均无残留。测试断言字符串与 en 文案逐字核对一致。

## R5-8 [medium·bug] 事实单一来源 — PASS

**实现核对**（`package-detail.tsx:265-271,325-327`）：
- `installFacts = installDetail.data ?? install`，事实块读 installDetail 查询——与 mutations 的失效键（`mutations.ts:166-174/202-209/264-272` 三处均 invalidate `pluginPackageKeys.installDetail(scope, installId)`，原文核对）**同一键同源**，择型符合 openbot-data-access"读取端向既有失效键对齐、不扩失效面"的纪律（扩 list 失效会放大每次写的 refetch 面）。
- 同键去重：对话框订阅与 grants/experts 两个 section 的订阅同键，零新增请求。
- 门控：`enabled: managesInstall`，与 sections 渲染门同一常量（`package-detail.tsx:265-266` vs `:339`，共用无重复表达式）；成员（`canInstall=false`）、未安装（install=null）、uninstalled 三种情况均不发请求——既有成员用例（`plugin-package-grants.test.tsx:570-578`）断言 `DETAIL_PATH` 零请求，守住。

**测试真实性**：新用例（`plugin-package-grants.test.tsx:614-640`）list 端点全程返回陈旧 needs_grant 行、install-detail 端点在 PUT 后翻转为 granted——刷新只能来自 mutation 失效的 installDetail refetch，断言 `Needs Bot grant` 消失 + `Ready` 出现 + grantNotice 消失。RED 原文核实（`.e2e/.../plugin-package-grants-test-after-a-grant-the-dialog-s-*/trace.md`：`expected <span...>Needs Bot grant</span> to be null`）——修复前事实块确实读陈旧 prop。真实、针对性强。

## 越界检查

报告触碰清单 7 文件全部在 `app/`（3 组件 + 2 locale + 2 测试）。worktree 同时含并行 backend 票（R5-1..4）的 `server/`、`scripts/` 改动与 PKG 系列未提交功能改动（报告备注 5 已声明），共享脏工作树上无法按人归因，但 R5-frontend 的修复内容经逐文件核对未越出清单，`shared/` 仅按既有契约消费（contracts 文件属 PKG 既有未提交产物，非本票新建）。无 commit/push/stash。

## fresh 验证（reviewer 亲跑）

1. **触碰面 5 套件 native**：`E2E_UNIT_OUTPUT=.e2e/r5-frontend-review-native bunx e2e run --config e2e.unit.config.ts <5 套件>` → **5 files / 55 tests 全过**（与报告数字一致；报告证据 `.e2e/r5-frontend-native/report.json` 亦核实：status=passed、exit=0、run id `01a15816`）。
2. **typecheck**：`bun run --filter app typecheck` → pretypecheck 0 / typecheck 0。
3. **biome**：lint + check 触碰 7 文件 → 0 错误（含 format）。
4. **对抗实验**（`.e2e/r5-fig/*`、`.e2e/r5-frontend-review-leak|baseline`）：billing 单跑 8/18 红（预先存在）；基线 5 文件组（无 experts）13 红；加入 experts 后 delta 恰为其自身 8 条，无一条他人用例因 experts 改变结局；无 billing 组合两次重复 experts 全绿。

## Findings（编号 / severity / blocking / 位置 / 证据）

| # | severity | blocking | 位置 | 内容 |
|---|---|---|---|---|
| F1 | low | 否 | `app/tests/plugin-package-experts.test.tsx`（套件层） | native worker 跨文件模块缓存竞态：与传递 import react-router 的套件（billing-credits-ui，经 `page-shell.tsx`/`admin-sidebar.tsx`）共槽且对方先评估时，真实 `isServer=true` 被进程缓存，本套件 8/8 以 `Matches` 崩溃失败（3 跑 2 现非确定）。同一崩溃签名即 37 套件迁 bun 层的记录理由；非本票引入，但本套件现为 native 层唯一敏感者。建议后续迁层或上报 runner 隔离；round5 全量 sweep 需知悉。 |
| F2 | low | 否 | `app/tests/billing-credits-ui.test.tsx` | 该套件在 native 层单跑即 8/18 红（zh-CN 文案/语言用例，trace 可见中文渲染）。预先存在、非 R5 触碰面；提请套件 owner 与分层记录核实（疑应随 router/dialog 类同迁或修复语言用例）。 |
| F3 | info | 否 | `R5-frontend-report.md` §验证 2 | 报告引用的第三条 RED 文案（"Unable to find an element with the text: Skill resources…"）与留存的 `.e2e/r5-frontend-red2` experts trace（实为 router 崩溃 `reading '0'`）不一致；与报告自述"harness 中间轮"相符，属引用口径瑕疵，不影响 RED 有效性（R5-7 的 label/回执断言在旧代码上必红）。 |
| F4 | info | 否 | `app/src/components/market/package-detail.tsx:271` | installDetail 读失败时事实块静默回落列表行副本（无错误态）。与报告声明的设计一致，且 sections 各自带错误/重试外壳；可接受，记录在案。 |
| S1 | info | 否 | `package-experts.tsx:257-284` | R5-7 相对计划字面（"展示模板声明的 skills"）的偏差：wire 契约无模板→技能映射，客户端不可枚举；实现取"超集+规则句+服务端回执"，修复意图达成、偏差已记录。SPEC 予以接受。 |

## 复审否决项（reviewer 主动排除的质疑）

- **"installGeneration 会否被 grant 移动导致跨 Bot 清空"**：否——install DTO generation 仅 disable/uninstall bump（`grants.ts:772`），grant 行 generation 是另一概念，服务端全文 grep 无 grant 路径写 install generation。
- **"`createRouter({isServer:false}` 是否更小代价"**：否——`Asset.js`/`Match.js` 直读模块级绑定，option 治不了（证据见 R5-6 节 5）。
- **"mock 是否泄漏伤及他人"**：钉的是 browser 语义真值，native 层无其他 router 消费者；泄漏实验 delta = 0 他人用例。

## 收口

- SPEC：R5-5..R5-8 逐条达成计划意图，必要处（R5-7）的偏差有契约依据且已记录；RED 证据三条全部留痕可查、两条逐字节核实。
- QUALITY：实现与仓库技能（openbot-data-access 精确失效、openbot-screen-layout 既有对话框词汇——本票未新增屏幕/尺寸面）、mock 纪律、biome-ignore 先例一致；门禁 fresh 全绿。
- Blocking findings：0。建议把 F1/F2 交给 OCR round5 全量阶段与后续 ticket 处理。
