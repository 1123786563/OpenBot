# HeroUI v3 主应用迁移 — 最终交付报告

日期：2026-10-20。授权来源：父 Issue #443 委派提示词（2026-10-19）；2026-10-20 17:40 用户指示取消最终 OCR 轮。
工作区：`.worktrees/heroui-migration`（分支 `feat/heroui-v3-migration`），BASE `203d0f0244b2`，HEAD 未移动（零提交，全部为未提交工作区交付）。
**终态检查点：`bc6ca3d9a5ef00ed3dc4248aced1a7a484038a82186288a2b334321f1ca3f524`**（142 文件清单 `h15/TERMINAL-CHECKPOINT.sha256`，主控复验 142/142 OK）。

## 1. 已完成的 Issue 与验收

| Issue | 交付 | 独立复审 | 状态 |
| --- | --- | --- | --- |
| H01 #444 | inventory/契约矩阵/基线/浏览器回路（含 ESC 守卫三轮迭代） | W3A pass（保留项） | ✅ 完成 |
| H02 #445 | 主题分层（8 层）/12 基础控件/ButtonLink（+fix-r1 边框基线恢复） | W3A pass（fix-r1） | ✅ 完成 |
| H03 #446 | 守卫 v3 弹层栈 + combobox combo-in-popover 等价 Adapter；CDP 11/11×2 + F2 | 复审 pass with conditions（条件已满足） | ✅ 完成 |
| H04 #447 | preload 根因修复 + 3 测试适配 + checkbox 迁移 | W3A pass；门禁开 | ✅ 完成 |
| H05 #448 | 核验+修正（2 处 Select 强转移除） | W3A pass | ✅ 完成 |
| H06 #449 | 10 文件（5 强转、原生控件迁移、4 既有红定因修复）+ Bot 壳契约 | W3B pass | ✅ 完成 |
| H07 #450 | 域红清零（3 测试文件适配）；18/20 源文件字节同 BASE | W4 pass | ✅ 完成 |
| H08 #451 | 核验轮（billing 红区由 preload 根因修复清零） | W3B pass | ✅ 完成 |
| H09 #452 | 纯核验轮（仅测试适配 25/25；守卫/auth 字节级未动） | W3B pass | ✅ 完成 |
| H10 #453 | zz-probe 8 红定因（测试环境双层）+ recorder 迁移 + CDP 右键 7/7 + F4 修复 | W5 pass（F4 已修） | ✅ 完成 |
| H11 #454 | 4 文件（数字键精确往返、iframe 合同字节保持） | W6 pass | ✅ 完成 |
| H12 #455 | 6 文件（ButtonLink、route-chain 既有红定因修复） | W3C pass | ✅ 完成 |
| H13 #456 | 3 文件（gallery select 迁移、F3 定因纠错） | W3C pass（F1 已修） | ✅ 完成 |
| H14 #457 | **@base-ui/react 移除**（lockfile 零漂移）、coverage 88/88、BACKLOG ~40 项清算 | W7 pass（附条件已处置） | ✅ 完成 |
| H15 #458 | **A01–A10 全 PASS**（42 截图全矩阵、IME CDP 实证、三裁决） | validator 只读验收 | ✅ 完成 |

七轮独立复审（W3A–W7）累计：**0 critical / 0 high**；全部 medium 均已当日修复并复核；low 项全部处置（修复或记录归属）。

## 2. 变更范围与保留依赖

- 范围：`app/` 主 Web 应用（88 路由 × 27 ui 模块全量对账，`h14/coverage.md`）；桌面 WebView 使用面经真实 app 验证（:3011 全矩阵）。
- 明确保留（附 grep/包级证据）：`@shadcn/react`（问卷/消息滚动引擎）、`prompt-area`、`streamdown`、`recharts`、`embla-carousel-react`、`shadcn`（tailwind.css 出口仍被 styles.css:63 消费——W7 裁定保留，设计文档措辞修正建议已记录）、`tw-animate-css`、`class-variance-authority`、`legacy-ui-bridge.css`（629+ 消费者，删除计划保留至后续波次）。
- 移除：`@base-ui/react`（app/src 引用清零 + package.json/lockfile 移除，diff 恰 3 条目）。
- 未动：desktop/ 引导程序、apps/openmuse/、bifrost/ 子模块、Craft 生成模板、服务端业务合同（Payer/金额精度/权限/租户隔离等经字节级/测试级复核零漂移）。

## 3. 实际运行的验证（同版本绑定检查点）

- **native 层**：app 全量 **995/995 EXIT 0**（H14 产出、W7 独立复跑；H15 复用同版本证据）。
- **driven 层**：`E2E_BUN_ONLY=app/tests` 6 组全绿（前缀覆盖先核验）。
- **test:ci**：exit 1 = 194 红全部 server 域/环境阻塞（ECONNREFUSED/CreditGate 签名 21 处归因）+ 2 repo 基建 meta；**app 域贡献 0**。
- **typecheck/build**：EXIT 0（H14/W7/H15 三轮独立复跑）。
- **真实浏览器（H15）**：postgres+Casdoor+server+app 全栈拉起（仅数据/环境级修复，零 repo 改动）；42 截图（亮暗 × 中英 × 1440/1280/390/320 + 200% 缩放 + reduced-motion）；对比度 ≥6.2:1（亮）/≥7.1:1（暗）；portal 菜单 computed token 无污染；pre-paint 主题；IME 组合期 Enter 保护（CDP imeSetComposition 实证）；dialog ESC/焦点返还/滚动锁/85svh；右键菜单 CDP 7/7。
- **biome**：变更文件 clean；记账余噪（context-menu 4 / button-native 2 / approvals 9）全部 BASE 既有。

## 4. 独立 Review 与 OCR 状态

- 七轮独立复审全 PASS（`reviews/REVIEW-W3A…W7-2026-10-20.md`），各轮含独立复跑与哈希复核（累计 49+ checkpoint 链）。
- **OCR**：三次运行均因 LLM 配额（429/5 小时上限）失败或中止；中止会话的部分发现（1 high 全局边框基线删除、1 medium 主题测试覆盖、脚本可移植性）已由 fix-round-1 修复并经 W3A 复审关闭；**最终全量轮经用户指示取消**（Ledger 2026-10-20 17:40 授权变更）。

## 5. 性能对比（H01 基线 → 终态，同方法）

| 指标 | 基线 gzip | 终态 gzip | Δ | 结论 |
| --- | ---: | ---: | --- | --- |
| 登录 JS | 430,849 | 476,457 | **+10.58%** | 入口 HeroUI/RAC 共享运行时 2,523B 一次性结构成本（route-sign 本体 +28B）；W7 复算背书 ACCEPT；manualChunks 缓解经评估不建议（静态链无法减少首载） |
| 聊天 JS | 1,168,268 | 1,184,734 | +1.41% | 门槛内 |
| 总 CSS | 49,906 | 61,184 | +22.6% | 构成分解：H02 裁定 6,824 + H03–H13 组件 CSS 4,454；逐组件导入已是最小路径（整包导入会多 ~37KB） |

## 6. 遗留限制（如实）

1. A03 正向授权路径与 A06 流式/滚动 in-app 验证需 workbench bot/agent 运行时——以负路径 in-app + 引擎级测试补偿（REPORT §8）。
2. `test:ui` engine 层因既有端口冲突（.env PORT=3001 vs 套件硬编码 :3010）+ agent-bot :4200 未启动而 BLOCKED——已由 in-app CDP 矩阵补偿；属环境项非迁移项。
3. in-app 频道右键菜单与触摸长按需频道存在（无 agent 运行时）——spike CDP 全绿 + h10 生产 adapter 证据背书。
4. 设计文档（spec §7.1/AC2 措辞）与 shadcn 保留事实的修正建议——归 spec owner 后续编辑。
5. legacy-ui-bridge.css（ob-legacy 层）删除计划保留至后续波次（629+ 消费者）。
6. dev 栈（pg :55432 / Casdoor :8000 / server :3002 / app :3011）验证后保持运行供人工复核——不需要时自行停止。

## 7. 回退点

- 零提交交付：`git checkout -- .` + 清单内 untracked 删除即回 BASE `203d0f02`（142 文件清单见 TERMINAL-CHECKPOINT.files.txt）。
- 波次级回退：各 hXX/POST-CHECKPOINT.sha256 保留原始哈希（H14 触碰文件的历史行保留在注释中）。
- 集成路径：`feat/heroui-v3-migration` 分支工作区可直接 `git add -A && git commit`（未获提交授权，未执行）。

## 8. 证据索引

- Ledger（全程决策与事件）：`docs/verification/heroui-migration/LEDGER.md`
- 各波次：`docs/verification/heroui-migration/h01…h15/`（REPORT + CHECKPOINT + 证据目录）
- 复审：`docs/verification/heroui-migration/reviews/REVIEW-W3A…W7-2026-10-20.md`
- 三裁决：`h15/{AC2-RATIFICATION,MANUALCHUNKS-EVALUATION,A11Y-COMBOBOX-VERDICT}.md`
- 覆盖对账：`h14/coverage.md`；终态指纹：`h15/TERMINAL-CHECKPOINT.sha256`

## 9. 后续波次 R：HeroUI 原生视觉重设计（#502，2026-10-20）

用户在迁移交付后确认视觉基线切换（决策记录：LEDGER 2026-10-20 R 节；预览 v2 即视觉稿）：
- 三项决策：主操作色=HeroUI 蓝 accent `oklch(0.6204 0.195 253.83)`（品牌青绿 #00c29a/#3dd9b6 退役并跟随 accent）；根字号 15→16px；圆角 0.6→0.5rem + HeroUI 亮暗阶梯与阴影。
- 实现（组件/路由/测试零改动——token 架构红利）：`tokens.css` --ob-* 全组重映射（ground truth=@heroui/styles themes/default/variables.css）+ `heroui-theme.css` 桥收敛 179→39 行（28 删 0 留）+ R1b 别名拆分（legacy --input 指 border 发丝线、HeroUI 字段保持无边框填充，21 调用点/15 文件全数恢复描边）+ 图表 5 色重做（双底 ≥3:1，13/13 对比度经复审独立复算）+ DESIGN.md 全文改写 + spec §11 修订注记。
- 验证：typecheck/build/biome 0；浏览器 QA 26/26 + 20/20（accent/canvas/border/radius 双主题 computed 证实、青绿与黑主色零残留、描边恢复断言）；对比度实测：body 16.25/19.79、snow-on-accent 3.59（**库默认权衡，如实记录未改 accent**）、accent-on-white 3.68/暗 4.81。
- 复审：REVIEW-R 三 PASS（0 high/medium，3 low 文档项已收口修订）。
- 接受的权衡与遗留：snow-on-accent 3.59:1（HeroUI 库默认）；暗色 switch OFF 白色拇指（原生形态）；muted-on-canvas 4.43 观察项；styles.css:158 陈旧阴影注释（下次触碰时清）。
- **R 终态检查点：`50517fd8…`（143 文件，h15/TERMINAL-CHECKPOINT-R.*）**；迁移基线 `bc6ca3d9…` 保留为历史锚点。回退：`git checkout -- <143 清单内文件>` + 清 untracked。
