# H06 Task Brief — frontend_implementer（Bot、技能、知识库与日常任务管理）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#449 票面旧状态不适用）。不 commit/push。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h06.md`（范围、AC1–AC5、路由/组件清单）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `docs/verification/heroui-migration/h03/REPORT.md`「下游 Interface」节
4. `docs/verification/heroui-migration/LEDGER.md` 2026-10-20 段

## 上游 Interface（冻结，只消费不改）
- `ui/*` 27 primitives 已 HeroUI v3 化；禁改 `ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、H03 两文件（model-picker/model-access-authorizations）、H04 已改文件（settings/plugins/memory/passwords/delivery 域——见 h04/POST-CHECKPOINT.sha256，冲突时上报不覆盖）。
- Dialog/Select/ComboBox/Dropdown/Tooltip 合同见 h03 REPORT；链接用 `ButtonLink`。

## 范围（主所有权）
- 路由：agents/index、bot、bots.$agentId.{index,responsibilities,routines,setup}、bots.index、responsibilities、routines、skills、team-bots、admin/knowledge.{index,$kbId}、admin/learning、admin/skills（完整清单见 h06.md）。
- 组件：`agents/*`、`bots/*`、`skills/*`、`knowledge/*`、`bot-profile/*`（access.tsx/sharing.tsx 归 H07 不动）、`responsibilities/*`、`routines/*`。
- **交付 Bot 详情壳稳定 Interface**（bot-subpage/bot-profile 布局），供 H07 权限页与 H12 评估页消费：在 REPORT 增「壳契约」节写明导出、props 与布局语义。

## 合同（AC 对照 h06.md）
- Bot 列表/创建/详情/设置 成功/取消/校验失败路径完整，表单值不丢失。
- 技能创建/编辑/绑定、知识库上传/删除/状态反馈保持；文件控件不误触发页面导航（根级 drop 保护不回退）。
- 职责/定时任务创建/修改/暂停可用，时间与状态语义不变。
- 详情路由/返回/长表单滚动/未保存处理守合同；无权限状态不可操作。
- 上传任务与异步状态来源保留，只替换内部通用交互控件。

## 已知红（须修复或单变量归因）
- `bots-nav-badge` 相关测试红（2026-10-20 归因落本域）。pre-existing 勿追：zz-probe-context-menu 8、heroui-spike TextArea、gallery-components（H13）、approval-team-settings（H07）、billing 族（H08）、user-preferences（H04）。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h06/native bunx e2e run --config e2e.unit.config.ts`
- 变更文件 biome lint/format；浏览器证据留待 validator

## 交付
`h06/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。TDD 优先测公共 Seam。阻塞记录证据继续可做部分。
