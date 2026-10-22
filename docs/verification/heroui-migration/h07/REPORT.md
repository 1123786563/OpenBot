# H07 (#450) — 公司成员、权限分享、审批与审计（approvals / bot access·sharing / admin 治理域）迁移报告

状态：implemented（域内红清零，两层测试全绿）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`（无 commit）。
检查点产物：`POST-CHECKPOINT.sha256`（本轮 6 个改动文件）；全量 native 证据 `native/`；域内定向 native 证据 `native-domain/`；命令日志 `evidence/`。

## 域起点事实（决定本轮 delta 形态）

与前几波相同，本域业务组件在早期波已迁到消费 HeroUI v3 化的冻结 `ui/*`，本轮按预期是 **verify-and-fix**：

- 全域 grep（20 个源文件：approvals/* 7 + bot-profile/access·sharing 2 + 路由 11）：`@base-ui`/`@radix-ui` **0 命中**；禁改 token（`bg-muted`/`text-muted`/`bg-accent`/`text-accent`）**0 处**（`text-muted-foreground`/`border-border` 属 legacy bridge 有效 token，不在更名面）；裸 `<select>`/`<input type=checkbox|radio>` **0 处**；`as any`/`: any` **0 处**。
- `git diff 203d0f02` 对照：20 个域内源文件中 **18 个与 BASE 逐字节一致**（含 admin/{approvals,audit,boundaries,enterprise,identity-providers,people}、settings/approvals、`_app/approvals.tsx`、bots.$agentId.{access,approvals,sharing}.tsx 全部路由，及 approvals 其余组件）。三个 Bot 权限路由已按 h06 壳契约消费 `BotSubpage`（render-prop，调用方不自己 useQuery agent），未自建第二套壳。
- 仅有的域内既有差异：`waiting.tsx:128` 一处 `bg-muted→bg-ob-muted-surface`（前波 token 更名，零行为）。

因此本轮改动 = **域内 4 个红测试文件的驱动方式修正 + 1 处 Select cast 清理**。

## 变更清单（本轮 6 文件，终态 sha256 见 POST-CHECKPOINT.sha256）

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/tests/approval-team-settings.test.tsx` | 角色名适配 | `getByRole("combobox", { name: "Commands on members' computers, at most" })` → `getByRole("button", …)`（`:124-131`），why-comment 在案。可访问名来自 `LabelSelect` 的 `aria-label`（rules.tsx `:111`，label=同句翻译键），查询强度不变；option 查询（role="option"）不变。 |
| `app/tests/bot-sharing.test.tsx` | 角色名适配（**H06 交接红，迁移引入须修**） | PublishDialog 内 audience 触发器 `getByRole("combobox", { name: /^Published to/ })` → `getByRole("button", …)`（`:138-142`），why-comment 在案。可访问名来自 `FieldLabel htmlFor` ↔ `SelectTrigger id`（sharing.tsx `:302-314`）。7/7 绿。 |
| `app/tests/approvals-rules.test.tsx` | 角色名适配 ×6 | behaviour 触发器 `combobox` → `button`（`:160` 首处 + why-comment；`:176,192,207,328,349` 跟改——行号经 W4 F5/H14 按现文件校正）。RuleRow 触发器 aria-label=`t("behaviourFor",{tool})`、RuleForm 触发器由 FieldLabel htmlFor 命名（rules.tsx `:183,:300-304`），可访问名逐字保留；负断言（queryByRole null）改为 button 角色后覆盖面更宽、未被削弱。12/12 绿。 |
| `app/tests/bot-approval-rules.test.tsx` | 角色名适配 ×4 | 同一族：`:104,107,110`（首处 + why-comment）、`:156`（W4 F5/H14 校正）。3/3 绿。 |
| `app/src/components/approvals/rules.tsx` | Select cast 清理 | `LabelSelect.onValueChange` 已有 null 守卫（dismiss 落空=草稿保持，AC3 约定同 h05/h06），本轮删除守卫后多余的 `next as T` 窄化（`:107`）——T 已由 `value: T` 推断，删除后无任何 Select 值强转残留。 |
| `app/src/components/approvals/waiting.tsx` | 无本轮改动 | 前波 token 更名（`:128`）核验保留；sha256 入 checkpoint 以固化域内终态。 |

不改动（越权清单均未触碰）：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`preload.ts`、`theme-preference.test.ts`、H04/H05/H06/H08/H09/H12 已改文件、H13（gallery/market/component-preview）与 H10（channels/computer/suggestions）在途文件。并发会话提示：H10 于本轮 14:15 新建未跟踪探针 `app/tests/h10-scratch-menu.test.tsx`（与 `zz-probe-context-menu` 伴生），见「验证」第 1/3 条归因。

## 域内红的单变量归因与处置

以 `git worktree add /tmp/h07-base-tree 203d0f02` 建 BASE 纯净树（bun install 后同命令对照，用毕已删）：

| 文件（红） | 工作区（修复前） | BASE 纯净树 | 归因 | 处置 |
| --- | --- | --- | --- | --- |
| `approval-team-settings`（1 fail） | 红（Ledger 2026-10-20 全量 native 在案；native 层文件，bun 下报 registerHooks 属分层预期） | — | migration-introduced：HeroUI Select.Trigger 丢 `role="combobox"`（H04 已录 Interface 变更申请） | role button + 可访问名，native 2/2 绿，全量 native 该文件 0 失败 |
| `bot-sharing`（1 fail："publishing to specific people sends them and their groups"） | 红 | **7/7 绿** | migration-introduced（H06 交接；单变量在 H02 共享 Select 面） | role button + 可访问名，7/7 绿 |
| `approvals-rules`（4 fail）+ `bot-approval-rules`（2 fail） | 红（单独跑即红，非进程污染） | **两文件全绿（连同其余 3 文件 27/27）** | migration-introduced，同一机制（combobox 角色丢弃）；先前未暴露系 h06 全量 native 的 `E2E_UNIT_SCOPE=app` 只收 native 层文件、driven 层自 H06 后无人重跑本域所致 | role button + 可访问名，12/12 与 3/3 绿 |
| `approval-tools`、`bot-access-skills` | 仅在同进程组跑时红 | 单独跑绿 | ADR 0008 约束二：共享 bun 进程的全局状态污染，非套件结论 | 无需动作（单独跑 1/1 与 4/4 绿；分层运行归 bun-suites 调度器） |

## AC 状态（对照 h07.md）

### AC1 公司成员、团队资格、身份源和边界规则的既有管理流程可用；不能用隐藏控件代替服务端授权 — PASS（组件/单元级）

- 成员管理：`admin/people.tsx` 与 BASE 逐字节一致（useInfiniteQuery 分页 + role Switch/IconLock 行为保留）；`group-people` 3/3、`enterprise-client`/`enterprise-session`/`host-access`/`grant-roster`/`plugin-grants` native 全绿（`native-domain/` 62/62）。
- 身份源/企业配置：`admin/identity-providers.tsx`、`admin/enterprise.tsx` 零 diff，增删走 `ui/Input`+`ui/Button` mutation 路径；`enterprise-client` 2 pass。
- 边界规则：`admin/boundaries.tsx` 零 diff（saveActionPolicy mutation + `isComposing` 合成输入保护保留）；`boundaries-read-failure` 2/2（读失败渲染 role="alert"，不假成功）。
- 无隐藏鉴权：全部管理面按 `me?.role === "admin"` / `agent.canManage` / `agent.mine` 渲染入口（access.tsx `:183,:211`、sharing.tsx `:121,:209`、settings.tsx `:83`、shared-use-requests.tsx `:40-43`），前端只反映服务端角色字段，无本地绕过路径。

### AC2 Bot 授权/分享/撤销及批准/拒绝保持资源与动作含义；取消不产生副作用 — PASS

- 授权/撤销：`access.tsx` YourSkills Switch `grant.mutate({agentId, granted, kind: "skill", ref})`（`:128-139`）资源+动作语义原样；Granted 区只读、admin 行内链接指向既有授权页。`bot-access-skills` 4/4、`bot-app-grants`（native）、`shared-grant-dialog` 3/3。
- 分享/撤销：`sharing.tsx` publish（PUT /publication，audience+emails+groups 原字段）、unpublish（`unpublish.mutate(agent.id)` `:125`）、组指派/移除（POST/DELETE，bot-sharing 5 断言写入体逐字段断言绿）。
- 批准/拒绝：`waiting.tsx` 决策集 `allow_once|allow_always|deny|handled`（`:137,147,161,174,185`）、`inline-approval.tsx` 同一决策集且 `status !== "pending"` 即回退渲染（`:38`）、`shared-use-requests` approve/decline（`:87,96`）——全部保留原动作枚举。
- 取消零副作用：PublishDialog 仅挂载于 `publishing` 态（sharing.tsx `:200-206`），Cancel=`onClose` 卸载丢弃草稿；publish mutation 仅在 form submit 触发且 `onSuccess` 才关窗（`:287-297`）；RuleForm dialog `close()` 重置 draft（rules.tsx `:236-240`）。bot-sharing"取消后不再重发"族断言绿。

### AC3 审批中、已处理、权限撤销、过期和请求失败反馈明确，不把未知状态显示为成功 — PASS

- 审批中/已处理：inbox 只渲染 `request.status === "pending"`（waiting.tsx `:44-46`、inline-approval `:38,101`）；已处理条目从待办面消失即"已处理"，无成功假象。
- 请求失败：`inbox.error ?? decision.error ?? answer.error`（waiting.tsx `:47-54`）、`decide.error`（shared-use-requests `:47-51`）、`publish.error`/`unpublish.error`（sharing.tsx `:78-84,:91-95,:357-361`）均渲染 `role="alert"` destructive 句子，按钮在 `isPending` 禁用防重复提交。
- 未知不冒充成功：shared-use-requests 未知 reason 显示原文 `why ? t(why) : request.reason`（`:70`）；LabelSelect null 守卫（rules.tsx `:107`）使 dismiss 不产生任何写入；audit 行的 refused/failed/allowed 三色判定走 `outcomeOf` 单一事实源（audit.tsx `:294-316,:408-425`）。

### AC4 审计筛选、分页、时间格式与详情读取保持原有行为，不扩大私人内容可见范围 — PASS（文件与 BASE 逐字节一致）

- `admin/audit.tsx` 零 diff：五个 FILTER 保存视图（`:53-71`）、`formatTime(event.createdAt)` 时间格式（`:326`）、CSV 导出含 `x-audit-export-truncated` 截断明示（`:99-101,169-173`）、行详情（routed/discovery/refusal/silence/dry-run 子句）原样。`audit-outcome`/`audit-silence`/`audit-export-url`/`audit-dry-run-label`/`audit-export-truncated` native+driven 全绿。
- 私人内容可见面：审计行只渲染事件 payload 字段，无新增读取路径；`useBotNames` 名称解析与 BASE 相同。

### AC5 切换公司/团队后旧内容和异步结果不串入新范围；键盘能完成确认与取消 — PASS（单元层）

- 范围隔离：本域零 diff 不触碰任何 tenant/workspace 作用域逻辑；`multitenancy/selection` 25/25（driven，H09 修复后复跑确认）；查询键由 `lib/*` 层拥有，组件只消费。
- 键盘完成：确认/取消均为真 `<button>`（ui/Button base），Enter/Space 可触发；PublishDialog footer Cancel+submit（sharing.tsx `:363-377`）、RuleForm Dialog 同构；ESC 分层/焦点返还由 H03 dialog.tsx 冻结面承担（CDP 证据链在案），本域对话框全部受控 `open`+`onOpenChange`。

## 验证（命令 + 真实 exit code，全部在本 worktree 根执行；测试经 ADR 0008 分层）

| 项 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck | `cd app && bun run typecheck` | 首轮（14:12，本轮全部编辑完成后）**EXIT 0 全项目零错误**（W4 F4 注记：首轮无落盘产物，系会话输出；终态由 W4 复审与 H14 复跑证实）；终轮复跑 **EXIT 2，仅 2 条错误且全部位于 H10 并行会话 14:15 新建的未跟踪文件** `tests/h10-scratch-menu.test.tsx(168)` 与 `tests/zz-probe-context-menu.test.tsx(168)`（`TS2588`，与 H10 域文件字节级同源），本轮 6 个改动文件 0 错误 | `evidence/typecheck.log` |
| build | `cd app && bun run build` | **EXIT 0**（`✓ built in 8.00s`；chunk>500kB 警告为既有） | `evidence/build.log` |
| native 全量 app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h07/native bunx e2e run --config e2e.unit.config.ts`（仓库根；在 app/ 内跑=空集） | **EXIT 1**：1006 执行 = 1003 pass / 3 fail；3 失败全部域外且可归因——`h10-scratch-menu` 1 + `zz-probe-context-menu` 1（H10 在途文件）、`heroui-spike` TextArea 1（Brief 列明的已知红）；**本域 native 层 12 个 app/tests 文件 0 失败**（W4 F3 口径修正：21 为 12 native + 9 driven 的跨层总数，原句置于 native 行易误读），`approval-team-settings` 修复后全量轮内绿 | `native/report.json`、`evidence/native-full.log` |
| native 域内定向（12 个 native 层文件） | 同 config + `app/tests/{approval-team-settings,bot-app-grants,shared-grant-dialog,audit-outcome,audit-silence,group-people,enterprise-client,enterprise-session,host-access,grant-roster,plugin-grants,audit-export-url}.test.*` | **EXIT 0**，12 files / **62/62 pass** | `native-domain/`、`evidence-native-domain.log` |
| driven 层（bun-routed 域内文件，逐文件单独跑） | `cd app && bun test tests/<file>` 逐个：approval-tools 1/1、approvals-rules 12/12、bot-approval-rules 3/3、bot-access-skills 4/4、bot-app-grants-screen 6/6、audit-dry-run-label 4/4、audit-export-truncated 2/2、boundaries-read-failure 2/2、bot-sharing 7/7、multitenancy/selection 25/25 | **EXIT 0**（修复后三文件合跑 `bun test tests/bot-sharing.test.tsx tests/approvals-rules.test.tsx tests/bot-approval-rules.test.tsx` = 22 pass / 0 fail；W4 F2 注记：七个逐文件结果当时仅有会话输出，W4 复审已逐一同命令复跑且计数全部吻合，H14 复跑再证） | `evidence/driven-fixed.log` |
| biome（本轮 6 文件） | `bunx biome check <6 files>` | 9 条诊断（4×organizeImports 行宽 + 5×format），对 HEAD 版本同命令得到**完全相同**的 9 条 → 既有噪声（同 H04 结论），非本轮引入；归 H14 lint 清扫 | 会话输出（BASE 对照 /tmp/h07-biome-base，用毕已删） |
| 单变量对照 | BASE 纯净 worktree `bun test` 五文件（approval-tools/approvals-rules/bot-approval-rules/bot-access-skills/bot-sharing） | **27/27 全绿** → 三个域内红均为 migration-introduced；worktree 已删（W4 F1 注记：本轮为会话输出、无落盘产物；`bot-sharing`/`approval-team-settings` 前置红有 W3B/W3A 产物独立佐证，`approvals-rules`/`bot-approval-rules` 两态仅有会话输出——可复现命令=`git worktree add /tmp/base 203d0f02 && cd /tmp/base && bun install && bun test app/tests/approvals-rules.test.tsx app/tests/bot-approval-rules.test.tsx`，H14 记录备考） | 会话输出 |

## 遗留 / 移交

1. **Interface 变更申请（沿 H04 在案记录，无新增）**：HeroUI Select.Trigger 丢 `role="combobox"`，本轮 4 个测试文件按实际契约（button + 可访问名）查询；若 H15 决定恢复 combobox 语义，改 H03 域内 wrapper，不由业务域垫片。
2. **H10 并行会话在途**：`tests/h10-scratch-menu.test.tsx`（未跟踪）本轮造成 typecheck EXIT 2 与全量 native 1 红，连同 `zz-probe-context-menu`（1 红，前账 8 红系 H10 修复中）归 H10 收口；本轮未触碰。
3. `heroui-spike` TextArea 1 红：Brief 列明的 H02 域已知红（H13 复核中），未追。
4. 浏览器级证据（权限拒绝路径、跨团队切换、长标签的真实浏览器走查）按分工归 frontend_validator；本轮代码未引入 portal/focus/滚动自定义逻辑。
5. driven 层既有噪声（approval-tools/bot-access-skills 仅共享进程内红）符合 ADR 0008 约束二的已知形态，bun-suites 调度器的单独重跑机制覆盖，无需套件侧动作。
