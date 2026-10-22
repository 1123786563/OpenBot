# H04 Task Brief — frontend_implementer（个人设置、连接管理与记忆维护）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#447 票面"尚未授权实施"为旧状态）。
任务前全局检查点：workspace 组合指纹 `c426ff0dd1437785`；HEAD=BASE `203d0f0244b2`（不 commit/push）。

## 必读（按序）

1. `docs/tickets/heroui-migration/issues/h04.md`（范围、AC1–AC5、路由/组件清单）
2. `docs/adr/0008-test-runner-tester-e2e.md`（跑任何测试前）
3. `docs/verification/heroui-migration/h03/REPORT.md` 的「下游 Interface」节
4. `docs/verification/heroui-migration/LEDGER.md` 2026-10-20 段（已知红清单+环境坑）

## 上游 Interface（冻结，只消费不改）

- `app/src/components/ui/*` 全部 27 个 primitives 已 HeroUI v3 化（react-aria-components 内核）。H04 **禁止修改** `ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/tokens*`、`settings-sidebar.tsx`、H03 的 model-access 两文件。若发现 primitive 缺口：在域内做等价 Adapter 或调用端迁移，并在 REPORT 记录 Interface 变更申请（不直接改）。
- Dialog 保持原导出与 props；Select/ComboBox 保持 `value`/`onValueChange` 与领域值合同（不 String() 强转、不 any、保留空值语义）；Dropdown/Tooltip 导出面不变。
- 链接一律 `@/components/ui/router-link` 的 `ButtonLink`（真实 anchor、新标签页、组合键不吞）。

## 现状事实（勿重复探明）

- H04 范围内已 **零** 直连 `@base-ui-components` 导入；业务文件经 `ui/*` 传递消费 HeroUI v3；H02 token 清扫（`bg-muted`→`bg-ob-muted-surface` 族）已覆盖本域 6 个文件（见 `PRE-CHECKPOINT.sha256`）。
- 本域已知红（2026-10-20 全量 native 归因，须修复或单变量归因后明确归属）：`app/tests/user-preferences.test.tsx`（上下文菜单/偏好加载相关断言）。
- 勿追的 pre-existing 红：billing-credits-ui、personal-credits-ui（13 断言）、update-routing/live-screen-mouse wheel、zz-probe-context-menu 8、heroui-spike TextArea、gallery-components、bots-nav-badge、approval-team-settings（后三者属 H13/H06/H07 域）。

## 工作内容

1. 按 h04.md 清单迁移设置/连接/插件/记忆/密码/送达域内仍存在的旧模式：shadcn 风格残留 props、原生元素控件应换成 HeroUI 基座（`ui/*`），保持 WorkBuddy 视觉密度与信息架构。
2. 守住合同：AC2 OAuth 回调与外部跳转不被新按钮事件吞掉（真实 anchor）；AC4 敏感值（token/密码）不回填、pending/取消/空态/错误可观察；AC3 记忆候选确认/编辑/遗忘/来源权限行为不变、不新增自动记忆；AC5 公司/团队切换隔离与中英长标签。
3. 修 `user-preferences.test.tsx` 红（先读失败明细：`docs/verification/heroui-migration/h02/form-primitives/report.json`）。
4. 更新/新增域内测试保持行为覆盖（TDD 优先，测试公共 Seam）。

## 验证（全部执行并记录命令+exit code）

- `cd app && bun run typecheck`（在 app/ 内）
- 域内测试：仓库根 `bunx e2e run --config e2e.unit.config.ts`（可用 `E2E_UNIT_SCOPE` 限域；勿在 app/ 子目录跑=空集）
- `cd app && bun run build`
- 变更文件 lint/format（biome 或仓库 lint 脚本）
- 浏览器证据留待 frontend_validator（你不必做 CDP，但代码不得阻塞其验证）

## 交付

写 `docs/verification/heroui-migration/h04/REPORT.md`：改动文件清单+每文件要点、AC1–AC5 状态与证据、验证命令与 exit code、遗留项。再生成 `POST-CHECKPOINT.sha256`（域内改动文件 sha256 清单）。不 commit。

阻塞时：记录具体证据（命令+输出），继续可做部分，在 REPORT「阻塞」节写明，不猜不改共享文件。
