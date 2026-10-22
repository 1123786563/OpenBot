# Workspace Redesign B1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`; execute each Task serially, one specialized implementer at a time, then read-only validator and independent reviewer. No commits.

**Goal:** Deliver the first authorized workspace redesign slice T01–T08 for P01–P23 and shared-layer regression smoke checks, including the specifically permitted T03 draft-lifecycle compatibility wiring.

**Architecture:** Keep the existing React/Tailwind/HeroUI architecture. T01 owns token values and native semantic mapping; T02 owns wrapper integration; T03 owns shell and detail behavior; T04–T07 transfer page files serially through the business slices; T08 is evidence and audit only. No server/API/domain changes.

**Tech Stack:** Existing installed React 19, Tailwind 4, HeroUI v3, TanStack, Bun and tester-army e2e. Do not install or upgrade product dependencies.

**Spec:** User-authorized scope in `docs/design/2026-10-20-workspace-redesign/handoff/refinement/code-agent-prompt.md`; exact behavior from `implementation-detail.md`, `implementation-spec.md`, `theme-contract.json`, `route-acceptance.json`, `verification-plan.md`, `layout-contract.md`, `tasks.json`; domain vocabulary from `CONTEXT.md`; test constraints from `docs/adr/0008-test-runner-tester-army-e2e.md`. No new Issue is in scope.

## Global Constraints

- Scope is T01–T08, P01–P23, with shared-layer smoke checks only; do not start T09–T21 or redesign P24/P28.
- T03 compatibility work is limited to existing draft state ownership and necessary prop wiring in the six pre-listed candidate files; transfer ownership in the Ledger before writing.
- Preserve every pre-existing staged, unstaged, and untracked change. Never reset, clean, or stash.
- Do not commit, push, merge, publish/deploy, create an external Issue, or install/upgrade product dependencies.
- Only the current task owner writes a given file; downstream tasks start only after current POST is reviewed and verified.
- Preserve navigation, route/URL/search, permissions, tenant/resource ownership, payment subject, server contracts, confirmation, and existing chat runtime behavior.
- Follow exact tokens, 280/256/64 shell widths, 672/1024/720 max widths, 480px main detail minimum, 400/480px detail widths, and explicit desktop-only preference persistence.
- Distinguish Bot observability guard/outlet/return/error states; preserve chat IME, draft attachments, streaming scroll, stop/retry, Back and control release.
- Every check report is bound to the exact POST checkpoint hash; changed code invalidates affected evidence.
- Skip, zero collection, warning without disposition, and environment-missing evidence are not passes.

## Review Focus

1. **Theme inheritance and portal roots:** verify both themes and computed native/wrapper values, especially muted text vs accent fill; open nested popup and assert ESC/focus return (T01/T02).
2. **Responsive state vs persisted preference:** missing/expanded/collapsed keys; resize and mobile toggles make zero writes while explicit desktop toggle writes once; test 767/768 and compact range (T03).
3. **Detail lifecycle and draft retention:** capture value, dirty status, mount count, scroll and URL at C=960→959→960; resize never closes, sensitive draft never reaches localStorage; verify control release (T03/T07).
4. **Existing role/access/observability gates:** manager vs read-only vs denied Bot; nested route guard, synchronization vs disabled vs upstream failure vs missing data, and Back path (T04–T06).
5. **Chat and responsive input behavior:** IME composition, rejected/upload-failed attachment, first-send failure, stop/retry, streaming scroll, mobile keyboard and computer/workshop URL state (T07).

## Execution Ledger and Checkpoints

Persistent Ledger: `docs/plans/2026-10-20-workspace-redesign-b1-ledger.md`. Full pre-existing working-tree snapshot: `docs/verification/workspace-redesign/execution/checkpoints/baseline/` (BASE SHA, exact tracked patches, untracked path/content hashes). Per-task PRE/POST and incremental packages use the same directory, indexed by this Ledger. Current branch/worktree was verified at `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`, `feat/heroui-v3-migration`, BASE `203d0f0244b2f898218fa12027089c631e8448d9`.

### Task 1: T01 — 主题变量与样式所有权

**Depends on:** none; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** refinement facts and baseline checkpoint.
**Produces:** - 主题切换、首绘与portal配对；变量循环/未覆盖原生字段是阻塞问题；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- `app/DESIGN.md`
- `app/src/styles.css`
- `app/src/styles/heroui-theme.css`
- `app/src/styles/legacy-ui-bridge.css`
- `app/src/styles/tokens.css`

**Behavior tests / verification scope:**
- `app/tests/theme-preference.test.ts`
- `app/tests/user-preferences.test.tsx`

**Implementation steps:**
- [ ] Step 1: 按 theme-contract.json 覆盖全部39个现有 token，添加 control-border/accent-text/warning 等确定值；保留导入分层和单一主题存储。
- [ ] Step 2: 按 Spec §2 映射完整 HeroUI 原生变量，包括 background/foreground/border/radius/success/field 与 soft/hover；legacy input 改为 control-border。
- [ ] Step 3: 在 DESIGN.md 记录待审阅稿获授权后的实际采用值；用真实 input/button/原生控件与 portal computed style 对照两主题，修复任何 fallback 默认值。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t01/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.

### Task 2: T02 — 公共 wrapper 的状态与尺寸

**Depends on:** T01; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** T01 verified checkpoint 中已审查的 token/公共props/业务组件.
**Produces:** - 表单/ref/原生事件、anchor、portal焦点和嵌套ESC；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- `app/src/components/ui/bubble.tsx`
- `app/src/components/ui/button.tsx`
- `app/src/components/ui/carousel.tsx`
- `app/src/components/ui/checkbox.tsx`
- `app/src/components/ui/combobox.tsx`
- `app/src/components/ui/context-menu.tsx`
- `app/src/components/ui/dialog.tsx`
- `app/src/components/ui/dropdown-menu.tsx`
- `app/src/components/ui/empty.tsx`
- `app/src/components/ui/field.tsx`
- `app/src/components/ui/input-group.tsx`
- `app/src/components/ui/input.tsx`
- `app/src/components/ui/item.tsx`
- `app/src/components/ui/label.tsx`
- `app/src/components/ui/live-waveform.tsx`
- `app/src/components/ui/message-scroller.tsx`
- `app/src/components/ui/message.tsx`
- `app/src/components/ui/questionnaire.tsx`
- `app/src/components/ui/router-link.tsx`
- `app/src/components/ui/select.tsx`
- `app/src/components/ui/separator.tsx`
- `app/src/components/ui/sheet.tsx`
- `app/src/components/ui/skeleton.tsx`
- `app/src/components/ui/switch.tsx`
- `app/src/components/ui/textarea.tsx`
- `app/src/components/ui/tooltip.tsx`

**Behavior tests / verification scope:**
- `app/tests/button-native.test.tsx`
- `app/tests/composing-enter.test.tsx`
- `app/tests/form-submit-controls.test.ts`
- `app/tests/heroui-spike.test.tsx`

**Implementation steps:**
- [ ] Step 1: 按 Spec §3 调整 Button cva 和 RouterLink 同源样式；保留 variant/size/mergeRefs/render 与真实 anchor。
- [ ] Step 2: Input/Textarea/Select/Combobox 去掉抵消 field fill 的中性化类，设置 1px control boundary、8px radius、2px focus；不动 identity/null/onChange。
- [ ] Step 3: Dialog/Sheet scrim 归 --ob-backdrop；菜单/tooltip surface 与 layer 保持；粗指针命中44px，disabled说明保持可读。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t02/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.

### Task 3: T03 — 外壳、PageShell 与通用详情响应式

**Depends on:** T02; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** T02 verified checkpoint 中已审查的 token/公共props/业务组件.
**Produces:** - 响应式不污染偏好；所有DetailPanel消费者，含Skills/Craft tasks；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- `app/src/components/admin/admin-sidebar.tsx`
- `app/src/components/app-sidebar/app-sidebar.tsx`
- `app/src/components/app-sidebar/channel-item-content.tsx`
- `app/src/components/app-sidebar/channel-pagination.tsx`
- `app/src/components/app-sidebar/channel.tsx`
- `app/src/components/bot-profile/attention.tsx`
- `app/src/components/channels/avatar.tsx`
- `app/src/components/layout/detail-panel.tsx`
- `app/src/components/layout/page-shell.tsx`
- `app/src/components/layout/page-skeletons.tsx`
- `app/src/components/layout/row-mark.tsx`
- `app/src/components/layout/self-host-banner.tsx`
- `app/src/components/layout/sidebar-shell.tsx`
- `app/src/components/layout/sidebar-toggle.tsx`
- `app/src/components/layout/skip-to-content.tsx`
- `app/src/components/layout/stagger.tsx`
- `app/src/components/settings/settings-sidebar.tsx`
- `app/src/components/ui/sidebar.tsx`
- `app/src/routes/_authed/_app.tsx`
- `app/src/routes/_authed/admin/route.tsx`
- `app/src/routes/_authed/settings/route.tsx`

**Behavior tests / verification scope:**
- `app/tests/computer-control-button.test.tsx`
- `app/tests/sidebar-preference.test.ts`
- `app/tests/sidebar-shortcut-layouts.test.tsx`

**Implementation steps:**
- [ ] Step 1: 设置三壳宽280/256/256、轨总宽64、移动Drawer min(280,100vw-32)；PageShell prose672/wide1024，PageRows圆角12。
- [ ] Step 2: SidebarShell 显式偏好与自动布局分离；增加可选 responsiveCompact:boolean=false，仅影响有效open，不写存储；用户本次显式toggle优先。SidebarToggle可达和快捷键合同不变。
- [ ] Step 3: DetailPanel MIN_MAIN_WIDTH=480，默认右栏400，保留调用方宽度；处理跨分支同一打开详情的本地输入状态保留，关闭后仍沿用原卸载策略。
- [ ] Step 4: 遍历全部DetailPanel调用者，C=879/880、959/960处校验Sheet/并排；测试高度受限与底部可达。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t03/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.

### Task 4: T04 — Bots 名册与工作详情

**Depends on:** T03, T02; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** T03 verified checkpoint 中已审查的 token/公共props/业务组件, T02 verified checkpoint 中已审查的 token/公共props/业务组件.
**Produces:** - 成员/管理员/本人/共享只读，长名称与部分请求失败；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- `app/src/components/agents/abstract-avatar.tsx`
- `app/src/components/agents/create-agent-dialog.tsx`
- `app/src/components/agents/handoff-panel.tsx`
- `app/src/components/approvals/waiting.tsx`
- `app/src/components/bot-profile/access.tsx`
- `app/src/components/bot-profile/activity.tsx`
- `app/src/components/bot-profile/manage.tsx`
- `app/src/components/bot-profile/pause-banner.tsx`
- `app/src/components/bot-profile/profile.tsx`
- `app/src/components/bot-profile/settings-rows.tsx`
- `app/src/components/bots/bot-roster.tsx`
- `app/src/components/plugins/shared-app-notice.tsx`
- `app/src/components/suggestions/proactive-panel.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.index.tsx`
- `app/src/routes/_authed/_app/bots.index.tsx`

**Behavior tests / verification scope:**
- `app/tests/bot-manage.test.tsx`
- `app/tests/bot-needs-you.test.tsx`
- `app/tests/bot-profile-active.test.tsx`
- `app/tests/bot-profile-notice.test.tsx`
- `app/tests/bot-roster-groups.test.ts`
- `app/tests/bot-roster.test.tsx`
- `app/tests/bot-settings-rows.test.tsx`

**Implementation steps:**
- [ ] Step 1: 保留groupRoster分组算法和needsYou/pinned/yours/shared/hidden顺序，仅重排/统一行的视觉层级。
- [ ] Step 2: 32px头像、64px最小行、名称和摘要两层；操作独立44px空间；隐藏区默认折叠，键盘可展开。
- [ ] Step 3: Bot详情身份→待办建议→启用通知→活动→配置→管理，全部配置/管理组展开；保留建议、审批与危险确认。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t04/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.

### Task 5: T05 — Bot 配置完整路径

**Depends on:** T04, T02, T03; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** T04 verified checkpoint 中已审查的 token/公共props/业务组件, T02 verified checkpoint 中已审查的 token/公共props/业务组件, T03 verified checkpoint 中已审查的 token/公共props/业务组件.
**Produces:** - 资源归属/可管理能力、保存失败、Dialog内Select与键盘；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- `app/src/components/agents/callback-token-panel.tsx`
- `app/src/components/approvals/bot-rules.tsx`
- `app/src/components/approvals/rules.tsx`
- `app/src/components/bot-profile/bot-subpage.tsx`
- `app/src/components/bot-profile/setup.tsx`
- `app/src/components/bot-profile/sharing.tsx`
- `app/src/components/delivery/reaching-you.tsx`
- `app/src/components/memory/sources.tsx`
- `app/src/components/responsibilities/new-responsibility-dialog.tsx`
- `app/src/components/responsibilities/responsibilities.tsx`
- `app/src/components/responsibilities/responsibility-dialog.tsx`
- `app/src/components/responsibilities/triggers.tsx`
- `app/src/components/routines/routines-list.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.access.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.approvals.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.memory.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.reach.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.responsibilities.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.routines.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.setup.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.sharing.tsx`

**Behavior tests / verification scope:**
- `app/tests/bot-access-skills.test.tsx`
- `app/tests/bot-approval-rules.test.tsx`
- `app/tests/bot-memory.test.tsx`
- `app/tests/bot-reaching-you.test.tsx`
- `app/tests/bot-responsibilities.test.tsx`
- `app/tests/bot-setup.test.tsx`
- `app/tests/bot-sharing.test.tsx`

**Implementation steps:**
- [ ] Step 1: 逐页应用672px配置组，按route-acceptance内content_order保留所有字段/入口。
- [ ] Step 2: 职责/投递/记忆/审批/例行/能力/共享/基础设置分别保持当前对象与能力门禁；只修改布局和通用样式override。
- [ ] Step 3: 打开每页的编辑弹窗/授权菜单，在窄屏校验长说明、敏感值掩码、保存失败不丢输入；不扩展模型授权或共享范围。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t05/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.

### Task 6: T06 — Bot 运行、评估与导出链

**Depends on:** T05, T02, T03; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** T05 verified checkpoint 中已审查的 token/公共props/业务组件, T02 verified checkpoint 中已审查的 token/公共props/业务组件, T03 verified checkpoint 中已审查的 token/公共props/业务组件.
**Produces:** - 父子路由链、canManage拒绝、缺失/禁用/上游故障与下载可用性；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- `app/src/components/ai-observability/dataset-detail.tsx`
- `app/src/components/ai-observability/datasets-list.tsx`
- `app/src/components/ai-observability/evaluations-page.tsx`
- `app/src/components/ai-observability/experiment-comparison.tsx`
- `app/src/components/ai-observability/experiment-results.tsx`
- `app/src/components/ai-observability/experiments-section.tsx`
- `app/src/components/ai-observability/exports-status.tsx`
- `app/src/components/ai-observability/run-detail.tsx`
- `app/src/components/ai-observability/run-steps.tsx`
- `app/src/components/ai-observability/runs-list.tsx`
- `app/src/components/ai-observability/state-notice.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.datasets.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.evaluations.$datasetId.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.exports.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx`
- `app/src/routes/_authed/_app/bots.$agentId.runs.tsx`

**Behavior tests / verification scope:**
- `app/tests/ai-observability-admin-summary.test.tsx`
- `app/tests/ai-observability-datasets.test.tsx`
- `app/tests/ai-observability-experiment-comparison.test.tsx`
- `app/tests/ai-observability-experiments.test.tsx`
- `app/tests/ai-observability-exports.test.tsx`
- `app/tests/ai-observability-route-chain.test.tsx`
- `app/tests/ai-observability-routes.test.tsx`
- `app/tests/ai-observability-run-detail.test.tsx`
- `app/tests/ai-observability-run-steps.test.tsx`
- `app/tests/ai-observability-runs-list.test.tsx`
- `app/tests/observability-route-guards.test.tsx`

**Implementation steps:**
- [ ] Step 1: 保留requireBotObservabilityAccess、父Outlet与详情返回链；使用1024px数据列，技术明细内部横滚。
- [ ] Step 2: runs/detail/datasets/evaluations/results/comparison/exports按各页源字段调整层次；先显示可用性再显示数据。
- [ ] Step 3: 比较窄屏上下排且单位/方向/缺失相邻；同步中不当故障、未知不当0；不新增I-01入口组。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t06/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.

### Task 7: T07 — 首页、新会话、单聊与群聊

**Depends on:** T06, T02, T03, T04; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** T06 verified checkpoint 中已审查的 token/公共props/业务组件, T02 verified checkpoint 中已审查的 token/公共props/业务组件, T03 verified checkpoint 中已审查的 token/公共props/业务组件, T04 verified checkpoint 中已审查的 token/公共props/业务组件.
**Produces:** - 输入/流式/滚动/附件、URL与控制释放；真实runtime缺失不得假称通过；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- `app/src/components/agents/agent-card.tsx`
- `app/src/components/agents/agent-profile.tsx`
- `app/src/components/approvals/inline-approval.tsx`
- `app/src/components/channels/browser-activity.tsx`
- `app/src/components/channels/channel-chat.tsx`
- `app/src/components/channels/chat-transcript.tsx`
- `app/src/components/channels/composer/attachment-strip.tsx`
- `app/src/components/channels/composer/collapse.tsx`
- `app/src/components/channels/composer/composer.tsx`
- `app/src/components/channels/composer/dictation-controls.tsx`
- `app/src/components/channels/composer/rejected-files.tsx`
- `app/src/components/channels/conversation-view.tsx`
- `app/src/components/channels/group-chat.tsx`
- `app/src/components/channels/group-people.tsx`
- `app/src/components/channels/team-bot-consent.tsx`
- `app/src/components/channels/tool-boundary.tsx`
- `app/src/components/channels/tool-line.tsx`
- `app/src/components/channels/voice-call-widget.tsx`
- `app/src/components/channels/voice-chat-card.tsx`
- `app/src/components/channels/workshop-artifacts.tsx`
- `app/src/components/channels/workshop-files.tsx`
- `app/src/components/channels/workshop-panel.tsx`
- `app/src/components/channels/workshop-schedules.tsx`
- `app/src/components/channels/workshop-share.tsx`
- `app/src/components/channels/workshop-turn.tsx`
- `app/src/components/channels/workshop-usage.tsx`
- `app/src/components/computer/activity-log.tsx`
- `app/src/components/computer/command-output.tsx`
- `app/src/components/computer/computer-controls.tsx`
- `app/src/components/computer/computer-panel.tsx`
- `app/src/components/computer/computer-view.tsx`
- `app/src/components/computer/demonstration-recorder.tsx`
- `app/src/components/computer/handoff-resume-notice.tsx`
- `app/src/components/computer/live-screen.tsx`
- `app/src/components/icons/waveform.tsx`
- `app/src/components/skills/skill-fields.tsx`
- `app/src/components/skills/skill-tools.tsx`
- `app/src/routes/_authed/_app/bot.tsx`
- `app/src/routes/_authed/_app/channel/$channelId.tsx`
- `app/src/routes/_authed/_app/channel/new.tsx`
- `app/src/routes/_authed/_app/group/$channelId.tsx`
- `app/src/routes/_authed/_app/index.tsx`

**Behavior tests / verification scope:**
- `app/tests/channel-chat.test.ts`
- `app/tests/channel-event-patch.test.ts`
- `app/tests/channel-history-notice.test.ts`
- `app/tests/channel-history-refresh.test.tsx`
- `app/tests/channel-label.test.ts`
- `app/tests/channel-menu-mutations.test.ts`
- `app/tests/channel-new-error-state.test.tsx`
- `app/tests/channel-order.test.ts`
- `app/tests/channel-pagination.test.tsx`
- `app/tests/channel-search.test.ts`
- `app/tests/channel-socket-message.test.ts`
- `app/tests/channel-unread.test.ts`
- `app/tests/composer-attachment-lifecycle.test.tsx`
- `app/tests/composer-attachment-strip.test.tsx`
- `app/tests/composer-attachments-ui.test.tsx`
- `app/tests/composer-attachments.test.ts`
- `app/tests/composer-collapse.test.tsx`
- `app/tests/composer-dictation.test.tsx`
- `app/tests/composer-drop-guard.test.tsx`
- `app/tests/composer-dropped-attachments.test.tsx`
- `app/tests/composer-inflight-removal.test.tsx`
- `app/tests/composer-insecure-context.test.tsx`
- `app/tests/composer-paste.test.tsx`
- `app/tests/composer-queue-attachments.test.tsx`
- `app/tests/composer-rejected-files-gap.test.tsx`
- `app/tests/composer-rejected-files.test.tsx`
- `app/tests/composer-send-failure.test.tsx`
- `app/tests/composer-unnamed-mime.test.tsx`
- `app/tests/composer-upload-group.test.tsx`
- `app/tests/composing-enter.test.tsx`
- `app/tests/computer-activity.test.ts`
- `app/tests/computer-control-button.test.tsx`
- `app/tests/computer-driving-local-fields.test.tsx`
- `app/tests/computer-handoff-rejoin.test.ts`
- `app/tests/computer-handoff.test.ts`
- `app/tests/computer-preview-visibility.test.tsx`
- `app/tests/computer-reset-clears-activity.test.ts`
- `app/tests/computer-tool-refusals.test.ts`
- `app/tests/failed-send-attachments.test.tsx`
- `app/tests/mark-open-channel-read.test.tsx`
- `app/tests/stopped-turn.test.ts`
- `app/tests/transcript-attachments.test.tsx`

**Implementation steps:**
- [ ] Step 1: 聊天阅读列720、顶栏48、message区域内部滚动、Composer为底部flex项；首页输入优先，无可用Bot如实呈现。
- [ ] Step 2: 保持settings/watch/workshop互斥与show()和URL/Back；电脑400/工作坊480、容器门槛880/960；不复制任务状态或添加API。
- [ ] Step 3: 保留群聊成员身份；/bot独立入口保留；校验首条失败草稿/附件、IME、stop/retry、上下文切换与电脑控制。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t07/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.

### Task 8: T08 — 首批独立验收与Review关卡

**Depends on:** T07; execute serially in T01→T08 order.
**Owner / validator / independent reviewer:** `frontend_validator` / `frontend_validator` / `reviewer` (Spec + quality).
**Checkpoint policy:** no commits. Capture PRE and POST HEAD, status, tracked staged/unstaged patch, task-scope untracked contents and SHA-256; generate a real incremental package including add/delete paths. Existing baseline is excluded by byte/hash comparison.
**Consumes:** T07 verified checkpoint 中已审查的 token/公共props/业务组件.
**Produces:** - T01–T07增量+首批完整交付；不签收未实施的后续页面；不改变现有数据与事件公共API

**Files (exclusive writer for this task):**
- Validation/evidence files only; no production or test source writes.

**Behavior tests / verification scope:**
- Browser matrix and evidence artifacts in `docs/verification/workspace-redesign/t08/`.

**Implementation steps:**
- [ ] Step 1: 按verification-plan执行B1全矩阵与受影响页面冒烟，证据绑定B1检查点。
- [ ] Step 2: 独立reviewer分别出Spec compliance/quality结论，再主控按OCR skill覆盖真实增量与完整交付；有效中高问题进入修复计划。

**Verification:** run the applicable task test files through the ADR0008 `e2e.unit.config.ts` native or driven partition (single-file `bun test` only for diagnosis), plus `bunx biome check` on only actual changed source files. Commands, collected/pass/fail/skip counts, exits, checkpoint SHA and artifacts go in `docs/verification/workspace-redesign/t08/`. T01–T03 receive targeted checks; the public-layer gate runs full app native + driven once after T03. T04–T07 run their targeted files; T08 runs app typecheck/build, affected static checks, both full app test layers and acceptance review. Browser requirements follow `verification-plan.md`; unavailable safe test identity/runtime is `blocked`, never pass.

**Expected result / failure handling:** all listed task assertions and source acceptance are met; no skipped/zero-collected test counts as pass. Attribute failures against the PRE baseline. Only the current owner may repair; downstream waits until verified. Any dependency/fixture blocker gets exact evidence and remains blocked.
### T03 bounded compatibility substep (authorized)

**Allowed additional files only if lifecycle RED proves necessary:** `app/src/routes/_authed/_app/skills.tsx`, `app/src/components/skills/new-skill.tsx`, `app/src/components/skills/edit-skill.tsx`, `app/src/components/skills/skill-fields.tsx`, `app/src/routes/_authed/_app/craft/tasks.tsx`, `app/src/components/craft/scheduled-task-editor.tsx`.

**Transfer records:** before any edit, record per-path `path/from_task/to_task/prior_checkpoint/change_reason/allowed_change/review_scope` in the Ledger; current default owners are T07 for `skill-fields.tsx`, T12 for Skills route/new/edit, and T09 for Craft tasks/editor. Transfers occur serially only after the previous writer stops and PRE is captured. Scope is only moving existing `SkillFormValues` / `FormState` or scheduled editor draft ownership above the inline/Sheet branch and necessary prop wiring; no new storage, data model, business protocol, feature, or P24/P28 visual redesign. Validate dirty/value preservation at 960→959→960 and computer-control release independently.

## Scope Coverage and Dependency Audit

- T01→T02→T03 is the shared foundation chain; T04 consumes it; T05 consumes T04; T06 consumes T05; T07 consumes T02/T03/T04/T06; T08 consumes completed T07 and validates all preceding P01–P23. This is the declared serial quality order, not an added product dependency.
- T01–T08 IDs are unique and every dependency resolves within the planned tasks. No self-edge or cycle exists; the authorized topological order is T01,T02,T03,T04,T05,T06,T07,T08.
- The per-page requirement mapping lives in `route-acceptance.json`; T04=P06–P07, T05=P08–P15, T06=P16–P23, T07=P01–P05; T01–T03 are shared layers and not page visual signoffs. T08 must carry one explicit pass/fail/blocked row per P01–P23.
- Shared file ownership and any serial handoff are captured by task checkpoints and Ledger; integration occurs only in this worktree.

## Consistency Preflight

| Check | Result before implementation | Evidence/action |
|---|---|---|
| T01–T08 task IDs and declared dependencies | pass | `tasks.json`; audited above; old `task-dag.md` is historical only and points to this plan. |
| Task ownership conflicts | pass with gated transfers | Initial `file_owners` are respected; T03 six-file compatibility allowlist requires explicit transfer record and current writer stop. |
| Shared interfaces | pass | HeroUI theme variables → T01; existing wrapper props and callbacks → T02; existing `SidebarShell` props plus optional `responsiveCompact`, `DetailPanel` contracts → T03; existing Bot/observability/chat route data → T04–T07. No server API changes. |
| Task files, tests, and page acceptance mapping | pass | Each task section lists exact `tasks.json` files/tests and links to per-page acceptance. |
| Existing unstaged migration baseline | recorded | Full file path/status/hash manifest and binary tracked patches captured before plan creation. |

## Finish Gate

After T08, run independent Spec and code-quality review bound to final checkpoint, then OCR workspace review for the actual new delta and complete delivery; if any real committed delta appears despite the explicit no-commit constraint, also cover its true BASE..HEAD. Effective critical/high/medium findings require a numbered repair plan, specialized implementation, affected verification, independent resreview and OCR rerun. Stop after T08; preserve the worktree and do not integrate.
