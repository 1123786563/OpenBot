# H15 Task Brief — frontend_validator（全流程、可访问性与独立审查交付验收，只读）

工作目录：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`（只读验证——不修改生产/测试源文件；产出仅限 `docs/verification/heroui-migration/h15/` 与截图/evidence）。
授权来源：父 Issue #443 委派提示词（实施已授权；#458 票面旧状态不适用）。不 commit/push。
前置：H14 完成并复审（读 `h14/REPORT.md` + `coverage.md` + `reviews/` 全部结论 + `BACKLOG-H14-H15.md` 终态）。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h15.md`（AC 全表）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`（分层对账规则）
3. `h01/REPORT.md` + `h01/baseline/`（基线数字：登录 JS 430,849 / 聊天 JS 1,168,268 / CSS 49,906 gzip；native 128 文件/967 测试）
4. `LEDGER.md` 全程 + `BACKLOG-H14-H15.md` 终态处置表
5. `h01/browser/cdp-harness/README`（CDP 配方；CHROME_PATH 可覆盖）

## 验收矩阵（A01–A10 逐项绑定检查点+证据，未判/环境阻塞不计通过）

- **A01** 公共控件 HeroUI 化+Base UI 清零：引用 h14 扫描证据复核（全量 grep 自证一次）。
- **A02** 主题/首屏/portal 无 token 污染：真实 app 页亮暗切换 + computed style 抽查（accent/muted/brand 三 token 在菜单/弹层/portal 的取值）。
- **A03** 业务试点与各组流程：抽验模型访问授权/撤销 + 代表页（settings/admin/billing/chat）主路径。
- **A04** 弹窗/Drawer/菜单/Select 键盘操作+焦点返还：Tab/ESC/方向键/滚动锁——优先复用 spike CDP 矩阵 + 真实 app 抽验。
- **A05** 表单单次提交/错误关联/Link 语义：新标签页与组合键实测。
- **A06** 聊天编辑/附件/流式/滚动：IME 组合期 Enter（中文输入法或 CDP Input.insertText 模拟组合态）、回底部、历史加载锚点。
- **A07** 公司/团队/付款/权限/敏感字段：正反向用例抽验（复用 domain 测试结论 + 浏览器抽验权限拒绝态）。
- **A08** 桌面/窄屏/中英文：**亮暗 × 中英 × 1440×900/1280×720/390×844/320px** 代表页截图 + **200% 缩放 + reduced-motion**（CDP Emulation.setPageScaleFactor/Page.emulateMediaFeatures）。
- **A09** 性能：同环境登录/聊天初始 JS gzip + 总 CSS gzip 对比基线；>10% 附评审结论（H02 已有 CSS +13.7% 结论，按终态复算）。
- **A10** 独立 Review + OCR：主控执行（不在本 Brief）；你提供覆盖输入。

## 执行环境
- dev 栈：postgres（docker）+ Casdoor + `bun run dev`（.env 已就位；端口见 .env APP_PORT/SERVER_PORT）。起不来时如实记 blocked 附证据，不虚构。
- 代表页：登录、模型访问、长表单管理页、计费列表、聊天、窄屏导航。
- 对比度：截图 + computed style 抽查（普通文本 4.5:1、非文本 3:1）；图标按钮具名；错误关联（aria-describedby）抽查。
- H01 转办复核：ContextMenu 物理键（Shift+F10/Menu 键）与触摸长按 in-app；Questionnaire 浏览器侧 change；弹窗外点/scroll lock/短视口/Select 定位；`role=combobox` a11y 裁决建议（给出依据，主控终裁）。

## 测试分层对账（ADR 0008）
- native：`E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=…/h15/native bunx e2e run --config e2e.unit.config.ts`
- driven：`E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=…/h15/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（先核验前缀覆盖）
- `bun run test:ci`（全仓收口；已有失败按域归因，环境阻塞标注证据）
- 变更文件 lint（biome）终扫
- app typecheck/build 终跑 + gzip 测量

## 交付
`h15/REPORT.md`：A01–A10 逐项状态+证据指针+检查点哈希；分层对账表；截图清单；性能对比表；阻塞与遗留（如实）；`role=combobox` 裁决建议。完成后主控执行最终 OCR（workspace 全覆盖）与修复循环，然后交付报告。
