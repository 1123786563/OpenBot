# H06 (#449) — Bot、技能、知识库与日常任务管理（agents/bots/skills/knowledge/bot-profile/responsibilities/routines 域）迁移报告

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本轮 10 个改动文件）；全量 native 证据 `native/report.json`；域内定向 native 证据 `native-domain/`。

## 域起点事实（决定本轮 delta 形态）

H02/H03 波已把本域业务组件迁到消费 HeroUI v3 化的 `ui/*`（导出面冻结），本轮按预期是 **verify-and-fix**：

- 全域 grep `@base-ui`/`@radix-ui`：0 命中。
- 禁改 token 面（`bg-muted`/`text-muted`/`bg-accent`/`text-accent`，即 styles 注释里刻意缺席的两个语义冲突名）：全域 0 处（早期波已把 4 处 `bg-muted*` 换成 `bg-ob-muted-surface` 族；`text-muted-foreground`/`border-border` 属 legacy bridge 仍有效 token，不在更名面）。
- 裸表单元素残留：仅 `admin/learning.tsx`（1 个原生 checkbox + 2 个原生 select）与 `admin/knowledge.$kbId.tsx`（3 个原生 select）——本轮全部迁入 `ui/Checkbox`/`ui/Select`。域内其余 `<button>` 均为 `Item render={<button>}` 列表行组合（BASE 既有 screen-layout 模式，非表单控件），不属替换对象。

因此本轮改动 = **Select 域值合同修正（5 处 cast-through）+ 2 个文件的原生控件迁移 + 4 个测试文件的驱动方式适配**。

## 变更清单（本轮 10 文件，终态 sha256 见 POST-CHECKPOINT.sha256）

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/src/components/bot-profile/profile.tsx` | Select 空值守卫 + biome 格式 | 删除 `next as BotNotify` 强转：`onValueChange` 的 null（Select 的「未选择」= 关闭弹层）直接丢弃，保持已保存答案（AC1/AC3；与 H05 admin 域修正同一约定）。T 从 `value={lifecycle.data.notify}` 正确推断，无需 cast。`:160-167` |
| `app/src/components/bot-profile/setup.tsx` | 同上 | 删除 `next as AgentProfile["visibility"]` 强转 + null 守卫 `:186-192`；失败路径保留 `setError`/不关 dialog。 |
| `app/src/components/responsibilities/triggers.tsx` | ×2 Select 空值守卫 | kind（`:623-628`）与 Slack mode（`:662-668`）删除 `value as TriggerKind/SlackMode` 强转，null 落空=草稿保持（AC3）。本文件 diff 还含前波（H03 族）nested-dialog backdrop 注释改写与 `bg-black/20!` important 后缀，非本轮行为改动，特此补记（W3B F5）。 |
| `app/src/components/responsibilities/new-responsibility-dialog.tsx` | Select 空值守卫 | event source 删除 `value as Source` 强转，保留 `value in SOURCE_KEYS` 运行时成员校验语义（`:250-255`）。conversation/bot 两处 Select 原本已是 `value ?? ""` null 语义，未动。 |
| `app/src/routes/_authed/admin/learning.tsx` | 原生控件迁移 | 原生 `<input type="checkbox">` → `ui/Checkbox`（`:246-252`，可见文字走 Checkbox children，避免 label 嵌套）；每 Bot 参与模式原生 `<select>` → `ui/Select`（`:289-337`，`PARTICIPATION_LABEL` 键面 `:39`）；Review 检视对象原生 `<select>` → `ui/Select`（`:379-417`，""（部署默认）是真实选项，触发器文案由 placeholder 呈现 `:383-385,:397-399`）；删除裸 `selectClass`。label 走 `htmlFor`+trigger `id`（`:290,:321,:379,:396`）。数据流零改动：`change()`/`save`/draft 语义保持。 |
| `app/src/routes/_authed/admin/knowledge.$kbId.tsx` | 原生控件迁移 | 添加文档 type 选择、文档列表 type 筛选、status 筛选三处原生 `<select>` → `ui/Select`（`:194-217`、`:461-492`、`:495-527`）；`ADD_TYPE_LABEL` 键面 `:79-83`；删除裸 `select` 样式常量。删除 `as "text"\|"url"\|"file"` / `as KnowledgeDocumentFilter["type"\|"status"]` 三处 cast（T 由 `value` 推断）。**文件控件零改动**：`<Input type="file" multiple>` 的 onChange→上传队列、`event.target.value=""` 重选触发、`submit()` 对 type=file 早退（`:255-271` onChange/上传队列块，早退在 `:174`）原样保留；根级 drop 保护在 `__root.tsx:29-56`（未触碰）。 |
| `app/tests/bot-setup.test.tsx` | 驱动方式适配 | `rename()` 的 `user.clear` → Backspace 键链（`:150-166`，why-comment 在案）。 |
| `app/tests/composing-enter.test.tsx` | 驱动方式适配 | `type()` helper 同上（`:122-136`，空字段零退格防 `user.type("")` 抛错）。 |
| `app/tests/bot-responsibilities.test.tsx` | 角色名适配 | `getByRole("combobox")` → `getByRole("button")`（`:130-138`），与 H04 已记录的 Interface 变更（HeroUI 丢弃 wrapper 转发的 `role="combobox"`）及 bot-memory.test 注释约定一致。 |
| `app/tests/learning-admin.test.tsx` | 驱动方式适配 | 原生 select 的 `fireEvent.change` → ui Select 惯例（click trigger + click option，`:64-77`），补 `userEvent` import。验证合同不变（排除 Bot 后保存，default/pause 状态不丢）。 |

不改动（越权清单均未触碰）：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、H03 两文件、H04 已改文件、H07 的 `bot-profile/access.tsx` 与 `bot-profile/sharing.tsx`。

## bots-nav-badge 红的单变量归因（Brief 指定项）

- 结论：**非本域代码缺陷、非 BASE 固有**——是迁移测试基建（`app/tests/preload.ts`）的问题，且已在此前波次修复；本轮实测绿。
- 证据链：
  1. `git diff 203d0f02 -- app/src/components/bot-profile/attention.tsx app/tests/bots-nav-badge.test.tsx` 为空——测试与组件与 BASE 逐字节一致，本域源码无变量。
  2. h02/form-primitives/report.json 中该文件 4 条全部 `skip: filtered`（该轮只选 8 条），红来自 Ledger 2026-10-20 全量 native 轮；H05 REPORT 已记「bots-nav-badge 已不在失败清单（前轮修复生效）」。
  3. 期间唯一相关的共享改动是 `app/tests/preload.ts`（+44 行，comment 明确记载根因：happy-dom 窗口期求值 react-dom/react-aria 会把 scheduler 定时器捕获进已关闭的窗口，「findBy\* reports element not found for content already in the query cache」正是 badge 测试的症状；warm-up 修复在 H04 期验证）。
  4. 本轮复跑：native 定向 4/4（EXIT 0）、全量 native 该文件 0 失败。
- 归因：migration-introduced（harness），已修复，无需本域代码动作。

## 其余域内红的单变量归因与处置

以 `git worktree add /tmp/h06-base-tree 203d0f02` 建 BASE 纯净树（bun install 后同命令对照，用毕已删）：

| 文件 | 工作区 | BASE 纯净树 | 归因 | 处置 |
| --- | --- | --- | --- | --- |
| `bot-setup.test.tsx`（2 fail） | 红 | **3/3 绿** | migration-introduced：H02 Input 换 React Aria 后，`user.clear`/`fireEvent.change` 的合成 input 事件不被 RAC 受控值处理，受控值在下一次渲染复活（探针实测：clear 后 DOM="" 但 state 仍 "Expenses"；真实键击路径是唯一让 state 跟走的路径） | 测试驱动改为 Backspace 键链（键盘真路径），3/3 绿 |
| `composing-enter.test.tsx`（1 fail） | 红 | **3/3 绿** | 同上（EditTextDialog Input） | 同 helper 改法，3/3 绿 |
| `bot-responsibilities.test.tsx`（1 fail） | 红 | **2/2 绿** | migration-introduced：HeroUI Trigger 丢 `role="combobox"`（H04 已录 Interface 变更申请） | 按 bot-memory.test 既有约定改按 role button，2/2 绿 |
| `learning-admin.test.tsx`（1 fail） | 红 | 8/8 绿 | **本轮引入**：原生 select → ui Select 后 `fireEvent.change` 不再适用 | 按本仓 Select 测试惯例改 click trigger + click option，8/8 绿 |
| `bot-sharing.test.tsx`（1 fail："publishing to specific people sends them and their groups"） | 红 | **7/7 绿** | migration-introduced，但被测组件 `bot-profile/sharing.tsx` 归 **H07**（本轮未触碰，单变量在 H07/H02 共享面） | 如实记录，转 H07 收口；不代改 |
| `bots-nav-badge`（历史红） | 绿 | 绿（组件/测试与 BASE 全等） | 见上节 | 无需动作 |

## AC 状态

### AC1 Bot 列表、创建、详情和设置的成功/取消/校验失败路径完整，既有表单值不丢失 — PASS（组件/单元级）

- 列表/创建：`bots.index.tsx` 创建入口 = search-param 态（roster 保持挂载，Back 关闭不丢页面态）；`create-agent-dialog.tsx` 自 BASE 零 diff，取消/失败路径语义原样（composing-enter 3/3、agents.test native 绿）。
- 详情：`bots.$agentId.index.tsx` PageShell backButton + BotProfile/ManageSection/BotSettingsRows 组合与 BASE 同构；`profile.tsx` notify/pause 开关 mutation 保留，Select 修正后 null 不再铸值（`:160-167`）。
- 设置：`setup.tsx` EditTextDialog 保存成功才 `onClose`，失败 `setError` 且不关 dialog（`:250-266`）；VisibilityRow 失败保留 error 并可重试（`:186-201`）；取消即 `setEditing(null)`（draft 弃置=BASE 行为）。bot-setup（改名 + endpoint 合同）3/3、bot-settings-rows 5/5、bot-route-default-agent 11/11（driven 层）。

### AC2 技能创建/编辑/绑定和知识库上传/删除/状态反馈保持原有能力；文件控件不会误触发页面导航 — PASS

- 技能：skill-form 10/10、skill-proposal 23/23、skill-creator-slug 3/3、proposed-skill-card（driven）全绿；`proposed-skill.tsx` 仅 token 更名（前波）。
- 知识库：`knowledge.$kbId.tsx` 上传队列（`uploadCommands.enqueue` + `useUploadTasksFor` 轮询 + settle 刷新 `:130-149`）、批量删除、筛选/排序全部保留；三处 Select 只换控件壳，`filter` state 契约（`ParseStatus | ""`、`source | ""`，"" = 不过滤）原样流入流出。learning-admin 8/8（driven）。
- 文件控件：file `<Input multiple>` onChange 入队、`event.target.value=""` 允许重选同名（`:255-271`）；`submit()` 对 type=file 早退（`:174`）；根级 drop 保护 `__root.tsx:29-56` 完好未触碰。

### AC3 职责与定时任务的已有创建/修改/暂停等动作可用，时间与状态含义保持不变 — PASS

- 创建/修改/暂停：`new-responsibility-dialog`、`responsibility-dialog`（run/complete 动作 `:203-260`）、`triggers` 各 mutation 路径保留；bot-responsibilities 2/2，写入体 agentId/channelId/title 断言绿。
- 时间与状态语义：`routines-list.tsx` 本轮零改动（仅前波 dialog backdrop 注释/`!` 修正）；status→dot 样式映射的 `bg-muted-foreground*` 是有效 bridge token，未动。routines-no-worker native 绿。
- Select null 语义：dismiss 不清空草稿 kind/mode/source（见变更清单），无 String() 强转、无 any。

### AC4 详情路由、返回、长表单滚动和未保存内容处理遵守当前合同；无权限状态不可操作 — PASS（组件级）

- 详情路由/返回：`BotSubpage` backButton=Bot 名回 `/bots/$agentId`，pending→null、error→`role="alert"` 句子（`bot-subpage.tsx:26-42`）；deep-link 由路由级 `agentQueryOptions` 承担（BASE 同构）。`bot.tsx` 不存在的命名 Bot 回句子不崩（`:104-122`）。
- 长表单滚动/未保存：Dialog Body 独立滚动、`max-h-[85svh]` 由 H03 冻结 dialog.tsx 承担（本域全部受控 `open`+`onOpenChange`）；未保存处理与 BASE 逐点相同（EditTextDialog draft 弃置、CreateAgentDialog search-param 态）。
- 无权限不可操作：`setup.tsx` 非管理者行无编辑按钮（`:93`）且 VisibilityRow 渲染只读文本（`:214-219`）；`manage.tsx` Delete 仅 `agent.canManage`（`:289`）；bot-setup 无权限测试（cannot open an editor）绿。

### AC5 Bot 详情公共壳交付稳定 Interface，权限页与评估页消费该壳，不各自改写 — PASS（见下节壳契约）

## Bot 详情壳契约（H07 权限页 / H12 评估页消费）

### 1. `BotSubpage` — `app/src/components/bot-profile/bot-subpage.tsx`（唯一子页壳）

```tsx
export function BotSubpage({ agentId, title, description, children }: {
  agentId: string;                                  // 路由 $agentId 原样传入
  title: string;                                    // 页标题（调用方翻译）
  description: string;                              // 页描述（调用方翻译）
  children: (agent: AgentProfile) => React.ReactNode; // render-prop：仅在加载成功后调用
});
```

布局语义：包 `PageShell`（**默认 prose 宽**，backButton={label: `agent.data?.name ?? t("botSubpage.titleFallback")`, linkProps: {params:{agentId}, to:"/bots/$agentId"}}，`:27-33`）。三态合同（`:35-41`）：`agent.isPending` → 渲染 null；`agent.error` → `<p role="alert" class="mt-6 text-destructive text-sm">{t("botSubpage.unreachable")}`；成功 → `children(agent.data)`。**调用方永远不自己 useQuery agent**——壳保证 agent 非空才进 children。

既有消费者（H07/H12 照抄此形）：`bots.$agentId.{access,sharing,approvals,datasets,memory,reach,responsibilities,routines,runs,setup}.tsx` 均为 `Route → BotSubpage(title, description) → {(agent) => <XSection .../>}`。`bots.$agentId.evaluations*`（H12）当前未消费壳，迁移时按同形接入，不得自写第二套壳。

### 2. `BotProfile` — `app/src/components/bot-profile/profile.tsx:56`（详情主页专用，非通用壳）

```tsx
export function BotProfile({ agent, settings?, manage? }: {
  agent: AgentProfile;
  settings?: React.ReactNode;  // 「Settings for this Bot」卡片（= <BotSettingsRows agent/>）
  manage?: React.ReactNode;    // Pin/Hide/Duplicate/Reset/Delete（= <ManageSection .../>）
});
```

自带：头像+title/roleDescription 头（`:89-97`）、`BotPausedBanner`（`:99`）、`BotNeedsYou`+`SuggestionsInbox`（`:102-103`）、「For you」区（pause Switch + notify Select + 浏览器通知，`:105-179`）、`BotActivitySections`。仅被 `bots.$agentId.index.tsx` 消费；H07/H12 **不要**复用它做子页，用 BotSubpage。

### 3. 区块组件导出面（冻结，只消费）

- `BotSettingsRows({ agent }: { agent: AgentProfile })` — settings-rows.tsx:65。每配置区一行，行内自带当前值陈述；`Item render={<Link params to>}` 负责导航（`:195`），Sharing/Access 行已指向 H07 的页面。
- `ManageSection({ agent, onHidden, onDuplicated, onDeleted }: { agent: AgentProfile; onHidden: () => void; onDuplicated: (copyId: string) => void; onDeleted: () => void })` — manage.tsx:166。**导航归调用方**（index 路由的 toRoster/copyId navigate，`bots.$agentId.index.tsx:22-31`）；delete/reset 对话框受控（`open`+`onOpenChange`）。
- `SetupSections({ agent }: { agent: AgentProfile })` — setup.tsx:73。身份字段行点击开 `EditTextDialog`（受控、Zod 校验、Enter 合成字符保护）；VisibilityRow 无权限渲染只读文本。
- `BotActivitySections({ agentId }: { agentId: string })` — activity.tsx:184。
- `BotPausedBanner({ agentId }: { agentId: string })` — pause-banner.tsx:15。**自含查询与恢复 mutation**；非暂停或加载中渲染 null（任意表面可放）。
- `BotsNavBadge()` — attention.tsx:76（侧栏徽标，非壳件）；另导出 `needsInput(bot)`、`attentionSummary(bot, t)`。

### 4. 壳的冻结约束

- 壳内禁改：返回/三态/宽度语义属 AC5 合同；H07/H12 需要新布局能力时走 Interface 变更申请，不在各自页面另起壳。
- 壳下游全部走 `@/components/ui/*`（Dialog/Select/Switch/Item/ButtonLink 等），Select 域值 null 合同见本轮修正样例。
- 权限判定统一读 `agent.canManage`（AgentProfile 字段），不要在页面里二次鉴权。

## 验证（命令 + 真实 exit code）

| 项 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck | `cd app && bun run typecheck` | **EXIT 0**（一次中间 EXIT 2 系本轮测试 helper 的 `HTMLElement.value` TS 错，已修后复跑 0） | `evidence/h06-typecheck2.log`（H14 自 /tmp 回填） |
| build | `cd app && bun run build` | **EXIT 0**（`✓ built in 9.73s`） | `evidence/h06-build2.log`（H14 自 /tmp 回填） |
| native 全量 app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h06/native bunx e2e run --config e2e.unit.config.ts`（仓库根；在 app/ 内跑=空集） | **EXIT 1**：994 执行 = 983 pass / 11 fail / 0 skip；11 失败全部为已知域外既有红（见下）；本域文件 0 失败 | `native/report.json` |
| native 域内定向（改动后复跑） | 同 config + 定位本域 13 个 native 文件 | **EXIT 0**，12 文件 78/78 pass | `native-domain/` |
| driven 层（e2e-bun-suites 清单内，按 ADR 0008 由 Bun 执行） | `bun test app/tests/{agent-roster-error,bot-profile-active,bot-profile-notice,bot-responsibilities,bot-route-default-agent,proposed-bot-card,proposed-skill-card,skills-read-failure,bot-roster,bot-settings-rows,bot-setup,learning-admin,composing-enter}.test.tsx` | **EXIT 0**，13 文件 71/71 pass | `evidence/h06-driven-final.log`（H14 自 /tmp 回填） |
| biome（本轮 10 个改动文件） | `bunx biome check <10 files>`（先 `--write` 格式化） | **EXIT 0** | 会话输出 |
| 单变量对照 | BASE 纯净 worktree `bun test` 同三文件 | 3 文件全绿（对照表见上） | 会话输出，worktree 已删 |

native 11 失败归因（单变量：均非本任务引入，均不在本域）：`zz-probe-context-menu` 8（既有真回归）、`approval-team-settings` 1（H07）、`gallery-components` 1（H13）、`heroui-spike` TextArea 1（H02 域）。对照 H05 轮：`user-preferences` 已绿（H04 收口效果）、`bots-nav-badge` 继续绿。

## 遗留 / Interface 变更申请

- **共享 Interface 观察一条（转 H14 裁决，不阻塞）**：React Aria 的受控 Input 在 happy-dom/node 测试层不处理合成 input 事件（`user.clear`、`fireEvent.change` 均被吞，受控值在下次渲染复活）；真实键击路径正常，真实浏览器无此问题。本轮以测试驱动适配收口（2 个 helper + why-comment）。若后续波次大量撞到，可考虑 ui/input.tsx 提供测试可见的等价路径——属 ui/* 冻结面，须走 Interface 变更。
- **H07 转办**：`bot-sharing.test.tsx` "publishing to specific people sends them and their groups" 在工作区 1 fail（BASE 纯净树 7/7 绿）——被测 `bot-profile/sharing.tsx` 归 H07，本轮零触碰，请 H07 verify 轮按其改动面收口。
- 浏览器级证据（Select 弹层定位、ESC 分层、焦点返回、外点关闭、scroll lock、上传按钮真实点击、权限拒绝路径的真实浏览器走查）按分工留待 frontend_validator；本域 Dialog/Select 组合与 H03 已 CDP 实测形态同构。
- `server/scripts/bootstrap-local-gateway.ts` 2 个 TS 错误：server 域 pre-existing（Ledger 在案），不在本任务。
- 已知红未追清单（按 Brief）：zz-probe-context-menu 8、heroui-spike TextArea、gallery-components（H13）、approval-team-settings（H07）、billing 族（H08）、user-preferences（已转绿）。
