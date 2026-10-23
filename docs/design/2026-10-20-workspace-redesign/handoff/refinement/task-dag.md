# OpenBot Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将76页的既有能力落到统一HeroUI主题与五图布局，首批仅T01–T08。

**Architecture:** tokens→原生映射→wrapper→共享骨架；各业务在现有数据/权限/状态接口上做视觉与明确的布局变化。稳定挂载负责局部多面板切换，领域状态仍由原组件与服务拥有。

**Tech Stack:** React19、Tailwind4、HeroUI v3当前安装版、TanStack、Bun与tester-army e2e。

**Spec:** [implementation-spec.md](./implementation-spec.md)，**待用户审阅，本计划是草案，不构成实施授权**。

第二轮执行补充：[implementation-detail.md](./implementation-detail.md)；正式首批计划必须合并其生命周期验证、兼容修复边界、所有权转移与测试分层。本稿命令列表是可用入口，正式Brief须指定Task实际运行与gate汇总范围。

## Global Constraints

- 不提交/推送/合并/发布、不安装产品依赖、不创建对外Issue。未来实施采用未提交检查点。
- 保护baseline.json中的既有脏基线；只审查真实增量，完整交付范围另行覆盖。
- 保留路由/权限/个人与公司归属；I-01/02/03不进入基础实施；不新增搜索/指标/API。
- 当前所有权仅refinement/，本轮不执行以下生产步骤；用户已授权B1 T01–T08。本文现为历史细化参考，不作为活跃任务状态源；正式执行计划唯一来源：`docs/plans/2026-10-20-workspace-redesign-b1.md`，执行状态唯一来源：`.archive/runs/2026-10-20-workspace-redesign-b1/ledger.md`。范围外T09–T21仍未授权。
- 原H01–H15不是本计划Task，不重新迁移组件底座。批准来源需在未来ledger记录。

## Review Focus

1. T01/T02：portal读错主题或neutralizer抵消原生变量；真实DOM抽样原生与wrapper，嵌套popup ESC两次只关闭相应层。
2. T03：自动布局覆盖用户持久化偏好；resize后存储不变，用户toggle后刷新保留；C边界879/880/959/960。
3. T04/T05/T06：共享成员与管理权限不同，表单/直达子路由不得旁路canManage，敏感值不得进入DOM。
4. T07：IME回车误发、首条失败丢附件、流式滚动跳跃；受控消息序列和可信键盘操作验证。
5. T09/T18：视图隐藏或跨断点卸载导致draft/运行/iframe重建；记录DOM identity与状态前后值。

## DAG、批次和执行状态

完整结构见[tasks.json](./tasks.json)，每个Task含id/source_issues/acceptance/depends_on/owner_role/validator_role/owned_files/Consumes/Produces/verification/status。没有Issue输入，source_issues=[]；source_pages是本轮需求来源，不虚构Issue树。

所有节点pending：尚未批准也未执行；批准后仅前置verified且同一已审查检查点已集成才置ready→running→verified。blocked须具体记原因。不因DAG就绪并行实现；串行单worktree无提交，前后快照、完整untracked内容和hash绑定审查。

| 批次 | 节点 | 独立验收范围 |
| --- | --- | --- |
| B1 推荐首批 | T01–T08 | 主题/公共骨架→Bots/详情与配置/观测链P06–23→聊天P01–05；23页+共享布局 |
| B2 | T09 | Craft P26–28 |
| B3 | T10–T11 | 设置P29–38、个人账务P39–41 |
| B4 | T12–T15、T17–T19 | 技能例行、后台治理/配置/市场/观测/预览 |
| B5 | T16 | 知识库P58–59 |
| B6 | T20 | 独立流程P71–76 |
| B7 | T21 | 全站76页+4布局+7跳转，不用B1宣布全站完成 |

拓扑执行按Task编号；dependency含import得到的共享前置。T01–T03全站影响大，只允许冻结接口后的串行下游；后续任务可按implementation-detail §5在前检查点保存、原写入者停止后登记串行所有权转移；公共接口缺陷另建修复Task。禁止同时写入或未登记越权修改。

## Task内共同完成步骤

- [ ] 捕获前检查点：HEAD、staged/unstaged diff、范围内untracked完整副本/哈希；记录无关修改为基线。
- [ ] 先复现与本Task有关的可观察布局/状态问题；适用行为变更以RED→GREEN→REFACTOR验证，不为纯色值写CSS镜像测试。
- [ ] 执行本Task下列具体步骤；不改变公共事件/领域接口；只在owned_files内写。
- [ ] 执行V-STATIC/NATIVE/DRIVEN/BROWSER与本Task指定案例，预期/环境阻塞见verification-plan；验证者只读。
- [ ] 记录后检查点、任务增量package和验证hash；独立reviewer分别判Spec/quality；有效finding退回原owner，相关验证和review重做。
- [ ] 无提交：以检查点ID代替commit，禁止git add/commit；所有前置verified后才放行下游。

## 具体任务

### Task 1: 主题变量与样式所有权 (T01)

**source_pages:** P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24, P25, P26, P27, P28, P29, P30, P31, P32, P33, P34, P35, P36, P37, P38, P39, P40, P41, P42, P43, P44, P45, P46, P47, P48, P49, P50, P51, P52, P53, P54, P55, P56, P57, P58, P59, P60, P61, P62, P63, P64, P65, P66, P67, P68, P69, P70, P71, P72, P73, P74, P75, P76。**depends_on:** 无。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/DESIGN.md`
- Modify: `app/src/styles.css`
- Modify: `app/src/styles/heroui-theme.css`
- Modify: `app/src/styles/legacy-ui-bridge.css`
- Modify: `app/src/styles/tokens.css`

**Interfaces:**

- Consumes: 当前脏基线；Spec及theme-contract确定值。
- Produces: 主题切换、首绘与portal配对；变量循环/未覆盖原生字段是阻塞问题；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 按 theme-contract.json 覆盖全部39个现有 token，添加 control-border/accent-text/warning 等确定值；保留导入分层和单一主题存储。
- [ ] Step 2: 按 Spec §2 映射完整 HeroUI 原生变量，包括 background/foreground/border/radius/success/field 与 soft/hover；legacy input 改为 control-border。
- [ ] Step 3: 在 DESIGN.md 记录待审阅稿获授权后的实际采用值；用真实 input/button/原生控件与 portal computed style 对照两主题，修复任何 fallback 默认值。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t01`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t01/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t01/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/theme-preference.test.ts`
- `app/tests/user-preferences.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 主题切换、首绘与portal配对；变量循环/未覆盖原生字段是阻塞问题；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 2: 公共 wrapper 的状态与尺寸 (T02)

**source_pages:** P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24, P25, P26, P27, P28, P29, P30, P31, P32, P33, P34, P35, P36, P37, P38, P39, P40, P41, P42, P43, P44, P45, P46, P47, P48, P49, P50, P51, P52, P53, P54, P55, P56, P57, P58, P59, P60, P61, P62, P63, P64, P65, P66, P67, P68, P69, P70, P71, P72, P73, P74, P75, P76。**depends_on:** T01。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/ui/bubble.tsx`
- Modify: `app/src/components/ui/button.tsx`
- Modify: `app/src/components/ui/carousel.tsx`
- Modify: `app/src/components/ui/checkbox.tsx`
- Modify: `app/src/components/ui/combobox.tsx`
- Modify: `app/src/components/ui/context-menu.tsx`
- Modify: `app/src/components/ui/dialog.tsx`
- Modify: `app/src/components/ui/dropdown-menu.tsx`
- Modify: `app/src/components/ui/empty.tsx`
- Modify: `app/src/components/ui/field.tsx`
- Modify: `app/src/components/ui/input-group.tsx`
- Modify: `app/src/components/ui/input.tsx`
- Modify: `app/src/components/ui/item.tsx`
- Modify: `app/src/components/ui/label.tsx`
- Modify: `app/src/components/ui/live-waveform.tsx`
- Modify: `app/src/components/ui/message-scroller.tsx`
- Modify: `app/src/components/ui/message.tsx`
- Modify: `app/src/components/ui/questionnaire.tsx`
- Modify: `app/src/components/ui/router-link.tsx`
- Modify: `app/src/components/ui/select.tsx`
- Modify: `app/src/components/ui/separator.tsx`
- Modify: `app/src/components/ui/sheet.tsx`
- Modify: `app/src/components/ui/skeleton.tsx`
- Modify: `app/src/components/ui/switch.tsx`
- Modify: `app/src/components/ui/textarea.tsx`
- Modify: `app/src/components/ui/tooltip.tsx`

**Interfaces:**

- Consumes: T01 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 表单/ref/原生事件、anchor、portal焦点和嵌套ESC；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 按 Spec §3 调整 Button cva 和 RouterLink 同源样式；保留 variant/size/mergeRefs/render 与真实 anchor。
- [ ] Step 2: Input/Textarea/Select/Combobox 去掉抵消 field fill 的中性化类，设置 1px control boundary、8px radius、2px focus；不动 identity/null/onChange。
- [ ] Step 3: Dialog/Sheet scrim 归 --ob-backdrop；菜单/tooltip surface 与 layer 保持；粗指针命中44px，disabled说明保持可读。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t02`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t02/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t02/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/button-native.test.tsx`
- `app/tests/composing-enter.test.tsx`
- `app/tests/form-submit-controls.test.ts`
- `app/tests/heroui-spike.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 表单/ref/原生事件、anchor、portal焦点和嵌套ESC；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 3: 外壳、PageShell 与通用详情响应式 (T03)

**source_pages:** P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24, P25, P26, P27, P28, P29, P30, P31, P32, P33, P34, P35, P36, P37, P38, P39, P40, P41, P42, P43, P44, P45, P46, P47, P48, P49, P50, P51, P52, P53, P54, P55, P56, P57, P58, P59, P60, P61, P62, P63, P64, P65, P66, P67, P68, P69, P70, P71, P72, P73, P74, P75, P76。**depends_on:** T02。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/admin/admin-sidebar.tsx`
- Modify: `app/src/components/app-sidebar/app-sidebar.tsx`
- Modify: `app/src/components/app-sidebar/channel-item-content.tsx`
- Modify: `app/src/components/app-sidebar/channel-pagination.tsx`
- Modify: `app/src/components/app-sidebar/channel.tsx`
- Modify: `app/src/components/bot-profile/attention.tsx`
- Modify: `app/src/components/channels/avatar.tsx`
- Modify: `app/src/components/layout/detail-panel.tsx`
- Modify: `app/src/components/layout/page-shell.tsx`
- Modify: `app/src/components/layout/page-skeletons.tsx`
- Modify: `app/src/components/layout/row-mark.tsx`
- Modify: `app/src/components/layout/self-host-banner.tsx`
- Modify: `app/src/components/layout/sidebar-shell.tsx`
- Modify: `app/src/components/layout/sidebar-toggle.tsx`
- Modify: `app/src/components/layout/skip-to-content.tsx`
- Modify: `app/src/components/layout/stagger.tsx`
- Modify: `app/src/components/settings/settings-sidebar.tsx`
- Modify: `app/src/components/ui/sidebar.tsx`
- Modify: `app/src/routes/_authed/_app.tsx`
- Modify: `app/src/routes/_authed/admin/route.tsx`
- Modify: `app/src/routes/_authed/settings/route.tsx`

**Interfaces:**

- Consumes: T02 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 响应式不污染偏好；所有DetailPanel消费者，含Skills/Craft tasks；不改变现有数据与事件公共API。
- 新增可选 `SidebarShell({children,className,width,responsiveCompact?:boolean})`，默认false；显式override仅本次访问，保留原调用方props；DetailPanel签名不改。

**具体步骤:**

- [ ] Step 1: 设置三壳宽280/256/256、轨总宽64、移动Drawer min(280,100vw-32)；PageShell prose672/wide1024，PageRows圆角12。
- [ ] Step 2: SidebarShell 显式偏好与自动布局分离；增加可选 responsiveCompact:boolean=false，仅影响有效open，不写存储；用户本次显式toggle优先。SidebarToggle可达和快捷键合同不变。
- [ ] Step 3: DetailPanel MIN_MAIN_WIDTH=480，默认右栏400，保留调用方宽度；处理跨分支同一打开详情的本地输入状态保留，关闭后仍沿用原卸载策略。
- [ ] Step 4: 遍历全部DetailPanel调用者，C=879/880、959/960处校验Sheet/并排；测试高度受限与底部可达。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t03`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t03/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t03/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/computer-control-button.test.tsx`
- `app/tests/sidebar-preference.test.ts`
- `app/tests/sidebar-shortcut-layouts.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 响应式不污染偏好；所有DetailPanel消费者，含Skills/Craft tasks；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 4: Bots 名册与工作详情 (T04)

**source_pages:** P06, P07。**depends_on:** T03, T02。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/agents/abstract-avatar.tsx`
- Modify: `app/src/components/agents/create-agent-dialog.tsx`
- Modify: `app/src/components/agents/handoff-panel.tsx`
- Modify: `app/src/components/approvals/waiting.tsx`
- Modify: `app/src/components/bot-profile/access.tsx`
- Modify: `app/src/components/bot-profile/activity.tsx`
- Modify: `app/src/components/bot-profile/manage.tsx`
- Modify: `app/src/components/bot-profile/pause-banner.tsx`
- Modify: `app/src/components/bot-profile/profile.tsx`
- Modify: `app/src/components/bot-profile/settings-rows.tsx`
- Modify: `app/src/components/bots/bot-roster.tsx`
- Modify: `app/src/components/plugins/shared-app-notice.tsx`
- Modify: `app/src/components/suggestions/proactive-panel.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.index.tsx`
- Modify: `app/src/routes/_authed/_app/bots.index.tsx`

**Interfaces:**

- Consumes: T03 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 成员/管理员/本人/共享只读，长名称与部分请求失败；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 保留groupRoster分组算法和needsYou/pinned/yours/shared/hidden顺序，仅重排/统一行的视觉层级。
- [ ] Step 2: 32px头像、64px最小行、名称和摘要两层；操作独立44px空间；隐藏区默认折叠，键盘可展开。
- [ ] Step 3: Bot详情身份→待办建议→启用通知→活动→配置→管理，全部配置/管理组展开；保留建议、审批与危险确认。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t04`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t04/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t04/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/bot-manage.test.tsx`
- `app/tests/bot-needs-you.test.tsx`
- `app/tests/bot-profile-active.test.tsx`
- `app/tests/bot-profile-notice.test.tsx`
- `app/tests/bot-roster-groups.test.ts`
- `app/tests/bot-roster.test.tsx`

完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 成员/管理员/本人/共享只读，长名称与部分请求失败；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 5: Bot 配置完整路径 (T05)

**source_pages:** P08, P09, P10, P11, P12, P13, P14, P15。**depends_on:** T04, T02, T03。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/agents/callback-token-panel.tsx`
- Modify: `app/src/components/approvals/bot-rules.tsx`
- Modify: `app/src/components/approvals/rules.tsx`
- Modify: `app/src/components/bot-profile/bot-subpage.tsx`
- Modify: `app/src/components/bot-profile/setup.tsx`
- Modify: `app/src/components/bot-profile/sharing.tsx`
- Modify: `app/src/components/delivery/reaching-you.tsx`
- Modify: `app/src/components/memory/sources.tsx`
- Modify: `app/src/components/responsibilities/new-responsibility-dialog.tsx`
- Modify: `app/src/components/responsibilities/responsibilities.tsx`
- Modify: `app/src/components/responsibilities/responsibility-dialog.tsx`
- Modify: `app/src/components/responsibilities/triggers.tsx`
- Modify: `app/src/components/routines/routines-list.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.access.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.approvals.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.memory.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.reach.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.responsibilities.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.routines.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.setup.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.sharing.tsx`

**Interfaces:**

- Consumes: T04 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 资源归属/可管理能力、保存失败、Dialog内Select与键盘；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 逐页应用672px配置组，按route-acceptance内content_order保留所有字段/入口。
- [ ] Step 2: 职责/投递/记忆/审批/例行/能力/共享/基础设置分别保持当前对象与能力门禁；只修改布局和通用样式override。
- [ ] Step 3: 打开每页的编辑弹窗/授权菜单，在窄屏校验长说明、敏感值掩码、保存失败不丢输入；不扩展模型授权或共享范围。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t05`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t05/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t05/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/bot-access-skills.test.tsx`
- `app/tests/bot-approval-rules.test.tsx`
- `app/tests/bot-memory.test.tsx`
- `app/tests/bot-reaching-you.test.tsx`
- `app/tests/bot-responsibilities.test.tsx`
- `app/tests/bot-setup.test.tsx`

完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 资源归属/可管理能力、保存失败、Dialog内Select与键盘；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 6: Bot 运行、评估与导出链 (T06)

**source_pages:** P16, P17, P18, P19, P20, P21, P22, P23。**depends_on:** T05, T02, T03。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/ai-observability/dataset-detail.tsx`
- Modify: `app/src/components/ai-observability/datasets-list.tsx`
- Modify: `app/src/components/ai-observability/evaluations-page.tsx`
- Modify: `app/src/components/ai-observability/experiment-comparison.tsx`
- Modify: `app/src/components/ai-observability/experiment-results.tsx`
- Modify: `app/src/components/ai-observability/experiments-section.tsx`
- Modify: `app/src/components/ai-observability/exports-status.tsx`
- Modify: `app/src/components/ai-observability/run-detail.tsx`
- Modify: `app/src/components/ai-observability/run-steps.tsx`
- Modify: `app/src/components/ai-observability/runs-list.tsx`
- Modify: `app/src/components/ai-observability/state-notice.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.datasets.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.evaluations.$datasetId.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.exports.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx`
- Modify: `app/src/routes/_authed/_app/bots.$agentId.runs.tsx`

**Interfaces:**

- Consumes: T05 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 父子路由链、canManage拒绝、缺失/禁用/上游故障与下载可用性；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 保留requireBotObservabilityAccess、父Outlet与详情返回链；使用1024px数据列，技术明细内部横滚。
- [ ] Step 2: runs/detail/datasets/evaluations/results/comparison/exports按各页源字段调整层次；先显示可用性再显示数据。
- [ ] Step 3: 比较窄屏上下排且单位/方向/缺失相邻；同步中不当故障、未知不当0；不新增I-01入口组。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t06`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t06/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t06/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/ai-observability-admin-summary.test.tsx`
- `app/tests/ai-observability-datasets.test.tsx`
- `app/tests/ai-observability-experiment-comparison.test.tsx`
- `app/tests/ai-observability-experiments.test.tsx`
- `app/tests/ai-observability-exports.test.tsx`
- `app/tests/ai-observability-route-chain.test.tsx`

完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 父子路由链、canManage拒绝、缺失/禁用/上游故障与下载可用性；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 7: 首页、新会话、单聊与群聊 (T07)

**source_pages:** P01, P02, P03, P04, P05。**depends_on:** T06, T02, T03, T04。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/agents/agent-card.tsx`
- Modify: `app/src/components/agents/agent-profile.tsx`
- Modify: `app/src/components/approvals/inline-approval.tsx`
- Modify: `app/src/components/channels/browser-activity.tsx`
- Modify: `app/src/components/channels/channel-chat.tsx`
- Modify: `app/src/components/channels/chat-transcript.tsx`
- Modify: `app/src/components/channels/composer/attachment-strip.tsx`
- Modify: `app/src/components/channels/composer/collapse.tsx`
- Modify: `app/src/components/channels/composer/composer.tsx`
- Modify: `app/src/components/channels/composer/dictation-controls.tsx`
- Modify: `app/src/components/channels/composer/rejected-files.tsx`
- Modify: `app/src/components/channels/conversation-view.tsx`
- Modify: `app/src/components/channels/group-chat.tsx`
- Modify: `app/src/components/channels/group-people.tsx`
- Modify: `app/src/components/channels/team-bot-consent.tsx`
- Modify: `app/src/components/channels/tool-boundary.tsx`
- Modify: `app/src/components/channels/tool-line.tsx`
- Modify: `app/src/components/channels/voice-call-widget.tsx`
- Modify: `app/src/components/channels/voice-chat-card.tsx`
- Modify: `app/src/components/channels/workshop-artifacts.tsx`
- Modify: `app/src/components/channels/workshop-files.tsx`
- Modify: `app/src/components/channels/workshop-panel.tsx`
- Modify: `app/src/components/channels/workshop-schedules.tsx`
- Modify: `app/src/components/channels/workshop-share.tsx`
- Modify: `app/src/components/channels/workshop-turn.tsx`
- Modify: `app/src/components/channels/workshop-usage.tsx`
- Modify: `app/src/components/computer/activity-log.tsx`
- Modify: `app/src/components/computer/command-output.tsx`
- Modify: `app/src/components/computer/computer-controls.tsx`
- Modify: `app/src/components/computer/computer-panel.tsx`
- Modify: `app/src/components/computer/computer-view.tsx`
- Modify: `app/src/components/computer/demonstration-recorder.tsx`
- Modify: `app/src/components/computer/handoff-resume-notice.tsx`
- Modify: `app/src/components/computer/live-screen.tsx`
- Modify: `app/src/components/icons/waveform.tsx`
- Modify: `app/src/components/skills/skill-fields.tsx`
- Modify: `app/src/components/skills/skill-tools.tsx`
- Modify: `app/src/routes/_authed/_app/bot.tsx`
- Modify: `app/src/routes/_authed/_app/channel/$channelId.tsx`
- Modify: `app/src/routes/_authed/_app/channel/new.tsx`
- Modify: `app/src/routes/_authed/_app/group/$channelId.tsx`
- Modify: `app/src/routes/_authed/_app/index.tsx`

**Interfaces:**

- Consumes: T06 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件；T04 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 输入/流式/滚动/附件、URL与控制释放；真实runtime缺失不得假称通过；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 聊天阅读列720、顶栏48、message区域内部滚动、Composer为底部flex项；首页输入优先，无可用Bot如实呈现。
- [ ] Step 2: 保持settings/watch/workshop互斥与show()和URL/Back；电脑400/工作坊480、容器门槛880/960；不复制任务状态或添加API。
- [ ] Step 3: 保留群聊成员身份；/bot独立入口保留；校验首条失败草稿/附件、IME、stop/retry、上下文切换与电脑控制。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t07`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t07/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t07/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/channel-chat.test.ts`
- `app/tests/channel-event-patch.test.ts`
- `app/tests/channel-history-notice.test.ts`
- `app/tests/channel-history-refresh.test.tsx`
- `app/tests/channel-label.test.ts`
- `app/tests/channel-menu-mutations.test.ts`

完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 输入/流式/滚动/附件、URL与控制释放；真实runtime缺失不得假称通过；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 8: 首批独立验收与Review关卡 (T08)

**source_pages:** P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23。**depends_on:** T07。**状态:** pending。

**角色:** owner_role=frontend_validator；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- 仅未来指定的验证/审查报告目录 `.archive/runs/2026-10-20-workspace-redesign-b1/verification/t08/`；不写生产/测试源文件。

**Interfaces:**

- Consumes: T07 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: T01–T07增量+首批完整交付；不签收未实施的后续页面；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 按verification-plan执行B1全矩阵与受影响页面冒烟，证据绑定B1检查点。
- [ ] Step 2: 独立reviewer分别出Spec compliance/quality结论，再主控按OCR skill覆盖真实增量与完整交付；有效中高问题进入修复计划。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t08`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t08/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t08/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** T01–T07增量+首批完整交付；不签收未实施的后续页面；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 9: Craft 多面板会话与计划任务 (T09)

**source_pages:** P26, P27, P28。**depends_on:** T08, T02, T03。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/craft/attachment-input.tsx`
- Modify: `app/src/components/craft/chat-panel.tsx`
- Modify: `app/src/components/craft/composer.tsx`
- Modify: `app/src/components/craft/message/plan.tsx`
- Modify: `app/src/components/craft/message/text.tsx`
- Modify: `app/src/components/craft/message/thinking.tsx`
- Modify: `app/src/components/craft/message/tool-call.tsx`
- Modify: `app/src/components/craft/message/transcript-entry.tsx`
- Modify: `app/src/components/craft/output-panel/artifacts-tab.tsx`
- Modify: `app/src/components/craft/output-panel/files-tab.tsx`
- Modify: `app/src/components/craft/output-panel/index.tsx`
- Modify: `app/src/components/craft/output-panel/preview-tab.tsx`
- Modify: `app/src/components/craft/sandbox-status-indicator.tsx`
- Modify: `app/src/components/craft/scheduled-task-editor.tsx`
- Modify: `app/src/components/craft/session-sidebar.tsx`
- Modify: `app/src/components/craft/subagent-view.tsx`
- Modify: `app/src/components/craft/tool-cards/diff-body.tsx`
- Create: `app/src/components/craft/workspace-layout.tsx`
- Modify: `app/src/routes/_authed/_app/craft/$sessionId.tsx`
- Modify: `app/src/routes/_authed/_app/craft/index.tsx`
- Modify: `app/src/routes/_authed/_app/craft/tasks.tsx`

**Interfaces:**

- Consumes: T08 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: iframe实例/草稿附件不丢、预览隔离与ticket不变；不改变现有数据与事件公共API。
- 新建 `CraftWorkspaceLayout({sessionId:string})` 组合现有 SessionSidebar/ChatPanel/OutputPanel；ChatPanel/OutputPanel既有 `{sessionId:string}` 不改。route只传当前params；不新增服务接口。

**具体步骤:**

- [ ] Step 1: 新增workspace-layout.tsx稳定挂载单个ChatPanel/OutputPanel，按Spec §6 C阈值与viewport表显示session224/chat480/output420。
- [ ] Step 2: 保持draft/attachments/selected session/subagent/stream；输出tab首次挂载后保留实例，隐藏区inert；保持preview同一iframe及fullscreen定位前提。
- [ ] Step 3: index不自动建session；tasks编辑沿用DetailPanel；逐项验证390→1440→390切换、Sheet互斥、关闭/重开与后台运行。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t09`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t09/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t09/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/craft-files-tab-outputs.test.tsx`
- `app/tests/craft-preview-tab.test.tsx`
- `app/tests/craft-session-title.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** iframe实例/草稿附件不丢、预览隔离与ticket不变；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 10: 个人设置与账号完整路径 (T10)

**source_pages:** P29, P30, P31, P32, P33, P34, P35, P36, P37, P38。**depends_on:** T03, T08, T02, T05。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/approvals/settings.tsx`
- Modify: `app/src/components/component-preview.tsx`
- Modify: `app/src/components/memory/memories.tsx`
- Modify: `app/src/components/plugins/brokered-account-row.tsx`
- Modify: `app/src/components/plugins/connection-fields.tsx`
- Modify: `app/src/components/plugins/plugin-logo.tsx`
- Modify: `app/src/components/settings/background.tsx`
- Modify: `app/src/components/settings/devices.tsx`
- Modify: `app/src/components/settings/github-sources.tsx`
- Modify: `app/src/components/settings/linked-accounts.tsx`
- Modify: `app/src/components/settings/message-list-preference.tsx`
- Modify: `app/src/components/settings/model-access-authorizations.tsx`
- Modify: `app/src/components/settings/model-picker.tsx`
- Modify: `app/src/components/settings/standing-instructions.tsx`
- Modify: `app/src/components/settings/update-routing.tsx`
- Modify: `app/src/components/theme-provider.tsx`
- Modify: `app/src/routes/_authed/settings/approvals.tsx`
- Modify: `app/src/routes/_authed/settings/components-gallery/$name.tsx`
- Modify: `app/src/routes/_authed/settings/components-gallery/index.tsx`
- Modify: `app/src/routes/_authed/settings/connected-accounts/$key.tsx`
- Modify: `app/src/routes/_authed/settings/connected-accounts/index.tsx`
- Modify: `app/src/routes/_authed/settings/index.tsx`
- Modify: `app/src/routes/_authed/settings/memory.tsx`
- Modify: `app/src/routes/_authed/settings/model-access.tsx`
- Modify: `app/src/routes/_authed/settings/notifications.tsx`
- Modify: `app/src/routes/_authed/settings/passwords.tsx`

**Interfaces:**

- Consumes: T03 verified checkpoint 中已审查的 token/公共props/业务组件；T08 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T05 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 个人/共享身份、授权预览确认、保存失败与主题存储；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 按Spec §7设置行和672px列处理偏好/通知/审批/记忆/账号/模型授权/密码；图库保留预览隔离。
- [ ] Step 2: 设置导航256，窄屏标签在前；连接账号保留已有搜索、个人/共享/关联分组；gallery两列到单列。
- [ ] Step 3: 验证绑定码预览再确认、无权限/过期、撤销、密码掩码；不改付款/公司归属或凭空授权。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t10`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t10/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t10/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/gallery-components.test.tsx`
- `app/tests/memory-settings.test.tsx`
- `app/tests/model-picker-ui.test.tsx`
- `app/tests/sign-in-card.test.tsx`
- `app/tests/update-routing-configured.test.tsx`
- `app/tests/update-routing-settings.test.tsx`

完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 个人/共享身份、授权预览确认、保存失败与主题存储；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 11: 个人账务与账户归属 (T11)

**source_pages:** P39, P40, P41。**depends_on:** T10, T02, T03。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/billing/consumption-table.tsx`
- Modify: `app/src/components/billing/credit-bar.tsx`
- Modify: `app/src/components/billing/credit-grant-list.tsx`
- Modify: `app/src/components/billing/invoice-status.tsx`
- Modify: `app/src/components/billing/orders-view.tsx`
- Modify: `app/src/components/billing/pager.tsx`
- Modify: `app/src/components/billing/personal-balance-card.tsx`
- Modify: `app/src/components/billing/plan-card.tsx`
- Modify: `app/src/components/billing/upgrade-dialog.tsx`
- Modify: `app/src/components/billing/usage-credits-view.tsx`
- Modify: `app/src/components/billing/welcome-banner.tsx`
- Modify: `app/src/routes/_authed/settings/invoices.tsx`
- Modify: `app/src/routes/_authed/settings/orders.tsx`
- Modify: `app/src/routes/_authed/settings/usage.tsx`

**Interfaces:**

- Consumes: T10 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 个人与公司账户不得合并；金额/有效期/幂等与错误态；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 按1024px列重排订阅/个人积分/购买/发放/消费；显式显示原payer和币种，保留整数精度。
- [ ] Step 2: 订单/账单/下载弹窗保持确认与分页；窄屏摘要/具名表格内部横滚，不删金额或状态。
- [ ] Step 3: 测试未启用/无消费/读取异常/支付中与下载不可用，视觉不触发真实扣款。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t11`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t11/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t11/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/billing-credits-ui.test.tsx`
- `app/tests/billing-format.test.tsx`
- `app/tests/billing-invoice-shared.test.tsx`
- `app/tests/billing-payments.test.ts`
- `app/tests/model-billing-paths.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 个人与公司账户不得合并；金额/有效期/幂等与错误态；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 12: 个人技能与跨Bot例行 (T12)

**source_pages:** P24, P25。**depends_on:** T08, T02, T03, T05, T07。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/skills/edit-skill.tsx`
- Modify: `app/src/components/skills/new-skill.tsx`
- Modify: `app/src/components/skills/skill-agents.tsx`
- Modify: `app/src/routes/_authed/_app/routines.tsx`
- Modify: `app/src/routes/_authed/_app/skills.tsx`

**Interfaces:**

- Consumes: T08 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件；T05 verified checkpoint 中已审查的 token/公共props/业务组件；T07 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 长编辑区、保存失败与领域范围；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 保持技能个人/工作区分组与选中编辑，新建/保存/取消在DetailPanel内，C门槛沿用T03。
- [ ] Step 2: 例行任务显示所属Bot/调度/最近运行；与Craft任务和workshop schedules独立。
- [ ] Step 3: 对长指令/编辑失败/无技能与只读进行表单和窄屏复核。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t12`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t12/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t12/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/bot-access-skills.test.tsx`
- `app/tests/skills-read-failure.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 长编辑区、保存失败与领域范围；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 13: 管理目录与模型配置 (T13)

**source_pages:** P42, P43, P44, P45, P46。**depends_on:** T08, T02, T03。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/routes/_authed/admin/bot-services.tsx`
- Modify: `app/src/routes/_authed/admin/credentials.tsx`
- Modify: `app/src/routes/_authed/admin/gateway.tsx`
- Modify: `app/src/routes/_authed/admin/index.tsx`
- Modify: `app/src/routes/_authed/admin/model-catalog.tsx`

**Interfaces:**

- Consumes: T08 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: admin guard、敏感字段、失败不当空数据；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 保留目录型admin首页与现有分组，无聚合指标。
- [ ] Step 2: 凭据/服务/网关/目录使用672px表单或1024px记录列，status先于配置，所有弹窗同主题。
- [ ] Step 3: 验证敏感值掩码、网关未配置/连接或认证失败、模型同步异常，不改变注册和开放权限。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t13`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t13/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t13/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/admin-catalog-sync-ui.test.tsx`
- `app/tests/admin-gateway-readiness.test.tsx`
- `app/tests/model-picker-ui.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** admin guard、敏感字段、失败不当空数据；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 14: 治理、电脑、人员与计费管理 (T14)

**source_pages:** P47, P48, P49, P64, P65, P66, P67, P68。**depends_on:** T13, T02, T03, T05。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/admin/billing-cleanup-execution-card.tsx`
- Modify: `app/src/components/admin/model-billing-paths.tsx`
- Modify: `app/src/components/approvals/shared-use-requests.tsx`
- Modify: `app/src/components/approvals/team-settings.tsx`
- Modify: `app/src/components/billing/admin-credit-grant.tsx`
- Modify: `app/src/routes/_authed/admin/approvals.tsx`
- Modify: `app/src/routes/_authed/admin/audit.tsx`
- Modify: `app/src/routes/_authed/admin/billing.tsx`
- Modify: `app/src/routes/_authed/admin/boundaries.tsx`
- Modify: `app/src/routes/_authed/admin/computers.tsx`
- Modify: `app/src/routes/_authed/admin/enterprise.tsx`
- Modify: `app/src/routes/_authed/admin/identity-providers.tsx`
- Modify: `app/src/routes/_authed/admin/people.tsx`

**Interfaces:**

- Consumes: T13 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件；T05 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 试运行/策略只读、真实维护动作不可因视觉验收触发；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 边界/团队审批/电脑目录按原对象分组，试运行输入与结果相邻、目录长路径可读。
- [ ] Step 2: 人员与身份提供方保留角色/访问/删除确认；admin billing保留发放对象和清理执行状态。
- [ ] Step 3: 审计1024px具名横滚；enterprise保留既有直达URL，I-02入口不新增；不改变策略锁定和付款主体。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t14`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t14/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t14/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/admin-credit-grant-ui.test.tsx`
- `app/tests/approval-team-settings.test.tsx`
- `app/tests/audit-dry-run-label.test.tsx`
- `app/tests/audit-export-truncated.test.tsx`
- `app/tests/audit-export-url.test.ts`
- `app/tests/audit-outcome.test.ts`

完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 试运行/策略只读、真实维护动作不可因视觉验收触发；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 15: 连接器和工具授权 (T15)

**source_pages:** P50, P51, P52, P53, P54, P55。**depends_on:** T14, T02, T03, T10。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/plugins/account-mode-dialog.tsx`
- Modify: `app/src/components/plugins/shared-approval-fields.tsx`
- Modify: `app/src/routes/_authed/admin/plugins/$key.tsx`
- Modify: `app/src/routes/_authed/admin/plugins/$key_.bots.$agentId.tsx`
- Modify: `app/src/routes/_authed/admin/plugins/$key_.tools.$tool.tsx`
- Modify: `app/src/routes/_authed/admin/plugins/composio.tsx`
- Modify: `app/src/routes/_authed/admin/plugins/index.tsx`
- Modify: `app/src/routes/_authed/admin/plugins/open-connector.tsx`

**Interfaces:**

- Consumes: T14 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件；T10 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 账号模式/服务身份/Bot身份、异步逐项状态；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 连接器列表→服务→Bot授权→工具规则保持返回链；按672px配置组与状态层次调整。
- [ ] Step 2: Composio/Open Connector保留各自字段、已有搜索、配置及添加操作；异步busy按条目保留。
- [ ] Step 3: 验证共享账号模式影响确认、错误与禁用、普通成员拒绝；不把可连接等同本人已授权。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t15`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t15/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t15/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/approval-tools.test.tsx`
- `app/tests/brokered-account-row.test.tsx`
- `app/tests/composio-picker-add-error.test.tsx`
- `app/tests/composio-picker.test.tsx`
- `app/tests/plugin-grants.test.ts`
- `app/tests/plugin-logo.test.tsx`

完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 账号模式/服务身份/Bot身份、异步逐项状态；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 16: 知识库创建与文档检索 (T16)

**source_pages:** P58, P59。**depends_on:** T08, T02, T03。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/knowledge/upload-tasks-panel.tsx`
- Modify: `app/src/routes/_authed/admin/knowledge.$kbId.tsx`
- Modify: `app/src/routes/_authed/admin/knowledge.index.tsx`

**Interfaces:**

- Consumes: T08 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 上传任务/文档/检索各自状态，不新增切片/命中指标；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 知识库列表保持新建/删除，详情按添加→上传→文档→检索顺序。
- [ ] Step 2: 按Spec §7宽屏C≥1000/viewport≥1280时检索辅助320px，其他单列；文档既有筛选/排序/批删保留。
- [ ] Step 3: 验证上传/处理/失败/空文档/无检索结果分别显示；选择跨行与批量删除确认保持，390px发送/上传可达。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t16`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t16/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t16/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
E2E_BUN_ONLY=app/src E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t16/r01/driven-src bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/composer-upload-group.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 上传任务/文档/检索各自状态，不新增切片/命中指标；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 17: 部署技能、市场与学习配置 (T17)

**source_pages:** P56, P57, P60。**depends_on:** T15, T02, T03, T04, T10。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/market/connectors-pane.tsx`
- Modify: `app/src/components/market/experts-pane.tsx`
- Modify: `app/src/components/market/my-experts-view.tsx`
- Modify: `app/src/components/market/skills-pane.tsx`
- Modify: `app/src/components/market/wb.tsx`
- Modify: `app/src/routes/_authed/admin/learning.tsx`
- Modify: `app/src/routes/_authed/admin/market.tsx`
- Modify: `app/src/routes/_authed/admin/skills.tsx`

**Interfaces:**

- Consumes: T15 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件；T04 verified checkpoint 中已审查的 token/公共props/业务组件；T10 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 部署与个人范围、市场现有操作与容器异常；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 部署技能作用范围清晰，长指令弹窗；市场复用当前专家/技能/连接器Tab与详情，不增加评分/价格。
- [ ] Step 2: 统一market wb组件视觉override；宽屏三列/中两列/窄单列，保留admin能力控制。
- [ ] Step 3: 学习配置按真实设置/目标/容器与投递状态排列；测试字段无效/容器未就绪/保存失败。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t17`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t17/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t17/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/authoring-tool-cards.test.tsx`
- `app/tests/learning-admin.test.tsx`
- `app/tests/proposed-bot-card.test.tsx`
- `app/tests/proposed-skill-card.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 部署与个人范围、市场现有操作与容器异常；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 18: 组件管理与Playground (T18)

**source_pages:** P61, P62, P63。**depends_on:** T17, T02, T03, T10。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/routes/_authed/admin/components/$name.tsx`
- Modify: `app/src/routes/_authed/admin/components/index.tsx`
- Modify: `app/src/routes/_authed/admin/playground.tsx`

**Interfaces:**

- Consumes: T17 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件；T10 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 代码/预览隔离、切换不丢草稿；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 组件目录/详情统一表面，配置Sheet保持原表单与预览实例。
- [ ] Step 2: Playground按C≥960且viewport≥1280双列，否则编辑/预览切换；稳定挂载保留draft，代码区域内部横滚。
- [ ] Step 3: 验证非法输入、渲染失败、readonly/配置错误；不扩大执行或网络权限。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t18`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t18/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t18/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/component-preview.test.tsx`
- `app/tests/gallery-components.test.tsx`
- `app/tests/playground-json.test.ts`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 代码/预览隔离、切换不丢草稿；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 19: 管理可观测性双地址 (T19)

**source_pages:** P69, P70。**depends_on:** T06, T14, T02, T03。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/ai-observability/admin-summary.tsx`
- Modify: `app/src/routes/_authed/admin/ai-observability.tsx`
- Modify: `app/src/routes/_authed/admin/observability.tsx`

**Interfaces:**

- Consumes: T06 verified checkpoint 中已审查的 token/公共props/业务组件；T14 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 同组件双地址、能力缺失/同步/上游故障；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 两个URL保留同一ObservationAdminSummaryPage，按采集就绪/健康→范围→已有汇总顺序。
- [ ] Step 2: 窄屏逐行展开，未知数量不归零；保持非管理员拒绝与原时间范围。
- [ ] Step 3: 分别直达两地址及刷新返回，不能只测其中一个；I-02不改。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t19`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t19/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t19/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/ai-observability-admin-summary.test.tsx`
- `app/tests/observability-route-guards.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 同组件双地址、能力缺失/同步/上游故障；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 20: 认证、引导、租户与公开分享 (T20)

**source_pages:** P71, P72, P73, P74, P75, P76。**depends_on:** T08, T02, T03, T07。**状态:** pending。

**角色:** owner_role=frontend_implementer；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- Modify: `app/src/components/agents/orb/agent-orb.tsx`
- Modify: `app/src/components/agents/orb/ai-core.tsx`
- Modify: `app/src/components/auth/provider-logo.tsx`
- Modify: `app/src/components/computer/desktop-illustration.tsx`
- Modify: `app/src/components/computer/placeholder.tsx`
- Modify: `app/src/components/passwords/sign-in-form.tsx`
- Modify: `app/src/routes/_authed/onboarding.tsx`
- Modify: `app/src/routes/_authed/sign-in/$requestId.tsx`
- Modify: `app/src/routes/_authed/tenant/channels.tsx`
- Modify: `app/src/routes/_authed/tenant/selection.tsx`
- Modify: `app/src/routes/share.$token.tsx`
- Modify: `app/src/routes/sign.tsx`

**Interfaces:**

- Consumes: T08 verified checkpoint 中已审查的 token/公共props/业务组件；T02 verified checkpoint 中已审查的 token/公共props/业务组件；T03 verified checkpoint 中已审查的 token/公共props/业务组件；T07 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 重定向/登录目标/租户隔离/公共分享泄露；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 登录384px、引导/服务登录/选择公司团队672px、分享1024px；沿用现有步骤和公共/私有边界。
- [ ] Step 2: 平台登录和为Bot登录服务明确来源；租户公司/团队两层不合并；分享不显示内部导航。
- [ ] Step 3: 验证无提供方/请求过期/成员撤销/分享失效、长内容和200%缩放，不修改授权或执行维护动作。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t20`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t20/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t20/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**

- `app/tests/home-fallback-routing.test.tsx`
- `app/tests/root-drop-guard.test.tsx`
- `app/tests/sign-in-card.test.tsx`

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 重定向/登录目标/租户隔离/公共分享泄露；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

### Task 21: 全站验收与兼容收口 (T21)

**source_pages:** P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24, P25, P26, P27, P28, P29, P30, P31, P32, P33, P34, P35, P36, P37, P38, P39, P40, P41, P42, P43, P44, P45, P46, P47, P48, P49, P50, P51, P52, P53, P54, P55, P56, P57, P58, P59, P60, P61, P62, P63, P64, P65, P66, P67, P68, P69, P70, P71, P72, P73, P74, P75, P76。**depends_on:** T09, T11, T12, T16, T18, T19, T20。**状态:** pending。

**角色:** owner_role=frontend_validator；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。

**Files / owned_files:**

- 仅未来指定的验证/审查报告目录 `.archive/runs/2026-10-20-workspace-redesign-b1/verification/t21/`；不写生产/测试源文件。

**Interfaces:**

- Consumes: T09 verified checkpoint 中已审查的 token/公共props/业务组件；T11 verified checkpoint 中已审查的 token/公共props/业务组件；T12 verified checkpoint 中已审查的 token/公共props/业务组件；T16 verified checkpoint 中已审查的 token/公共props/业务组件；T18 verified checkpoint 中已审查的 token/公共props/业务组件；T19 verified checkpoint 中已审查的 token/公共props/业务组件；T20 verified checkpoint 中已审查的 token/公共props/业务组件。
- Produces: 原始交付全范围与本次相对脏基线真实增量，全部有效中高finding清零；不改变现有数据与事件公共API。

**具体步骤:**

- [ ] Step 1: 重扫76/4/7及所有route-acceptance，兼容跳转按参数/返回/权限验收。
- [ ] Step 2: 按独立检查点执行全站测试/类型/构建/静态检查/浏览器证据；逐页签收，不能以代表页签76页。
- [ ] Step 3: 独立Spec/quality review与完整OCR，真实中高问题修复复审；记录低风险延期、环境阻塞及所有权范围后再收尾。

**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `t21`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。


```bash
bun run --cwd app typecheck
bun run --cwd app build
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t21/r01/native bunx e2e run --config e2e.unit.config.ts
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t21/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
bun run test:ci
```

**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。

**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。

**Review范围:** 原始交付全范围与本次相对脏基线真实增量，全部有效中高finding清零；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。

## 计划自检与共享文件预检

- 76个页面均有一个主实现owner；4布局与7跳转分开；覆盖由validate-docs.py实际验证。
- task id唯一、dependency存在、无自环/环，编号序即有效拓扑；所有leaf可达T21。
- 每个生产文件同一时刻仅一个owner；后续串行转移按implementation-detail登记；复用组件的初始读写依赖已补边；只读gate不取得生产所有权。
- 共享接口：theme-contract→T01、wrapper既有props→T02、SidebarShell可选props/DetailPanel不变→T03、Craft稳定组合→T09；不改变服务器/Query返回类型。
- 任务内部检查：owned文件/步骤/source_pages一致；各异常与权限由route-acceptance绑定，五条Review Focus在指定Task中有浏览器案例。
- 跑测前核验ADR0008、manifest与实际checkpoint；旧H15证据不跨主题改动复用。
