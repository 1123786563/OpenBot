
# H14 REPORT — 移除 Base UI 底座并核对完整迁移覆盖（#457）

- 日期：2026-10-20。工作区 `.worktrees/heroui-migration`，分支 `feat/heroui-v3-migration`，BASE/HEAD `203d0f0244b2f898218fa12027089c631e8448d9`（无 commit；全部为未提交工作树增量）。
- 授权：父 Issue #443 委派提示词 + h14/BRIEF.md。本波为 lockfile/package.json 唯一写入者（继 H02 之后）。
- 输入：BACKLOG-H14-H15.md、LEDGER 2026-10-20 全段、h01/contract-matrix.md、REVIEW-W3A…W6 全部 carry-forward、h04–h13 REPORT。
- 覆盖对账产物：`docs/verification/heroui-migration/coverage.md`（88 路由 + 27 ui 模块 + 组件域 + 保留引擎全清单）。

## 1. AC 对照（h14.md）

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC1 app/src 无 @base-ui、app 直接依赖移除、测试/类型不残留旧契约 | **达成（附两处退场清理）** | (a) 扫描：`grep -rn "@base-ui" app/src` = **0 命中**（H14 前）；(b) 退场清理：`app/tests/preload.ts` 删除 `@base-ui/react/dialog` 预热窗（header 改写为 react-aria/RAC 口径）；`app/spike/main.tsx` 移除 Legacy 对照 fixture、删除 `spike/legacy-button.tsx`/`legacy-input.tsx`（H01 对照证据已归档 h01/browser，fixture 随底座退场）；(c) `app/package.json` 删除 `"@base-ui/react": "^1.6.0"`，`bun install` EXIT 0，根 `bun.lock` diff 仅 @base-ui 族三行（§2）；(d) 终扫描：全仓 `@base-ui` 仅剩 preload/spike 两处历史 why-comment 与 `server/assets/craft/web-template/package.json`（Craft 模板资产，票面明示不迁移，§3）；typecheck EXIT 0、build EXIT 0 |
| AC2 shadcn/tailwind.css 删除；CLI/tw-animate/cva 按实际使用决定 | **部分达成，偏离有据**（§2） | `shadcn/tailwind.css` **未删除且不应删除**：BRIEF 前提「H02 已删该 import」经查不成立——BASE styles.css:3 与现 styles.css:63 逐字相同，从未删除；其导出的 `data-*` custom variants / `no-scrollbar` / `scroll-fade-*` 被已迁移 ui 层活跃消费（ui/sidebar.tsx:478、ui/message-scroller.tsx:43、app-sidebar.tsx:274、field/questionnaire/dropdown/select/context-menu 的 data-* 变体类）。按 AC2 自身「未使用才删除」原则**保留**；CLI/tw-animate/cva 均在用保留 |
| AC3 保留例外有明确原因+主题兼容证据 | **达成** | 全表见 coverage.md §4（@shadcn/react、PromptArea、Streamdown、Recharts、Embla：消费点+Spec §7 原因+styles.css @source 兼容证据+h08/h10/W3C 审查指针） |
| AC4 全部路由与公共 UI 唯一归属，新增/改名重对账 | **达成** | 全量重扫：`app/src/routes/**/*.tsx` 现存 **88 = manifest 88，零新增/改名/删除**；ui 模块 26→27（`ui/router-link.tsx` H02 交付、manifest 未收录，coverage.md 补录）；coverage.md 逐文件归属×处置×证据指针 |
| AC5 lockfile 无关漂移零；typecheck/build + JS/CSS gzip 终测 | **达成（两项超 10% 门槛附评审结论）** | lockfile diff 仅 @base-ui 三条（§2）；typecheck/build EXIT 0；gzip 终测与评审结论见 §7 |

## 2. 依赖手术（本波 package.json/lockfile 全部改动）

**删除：`@base-ui/react`**（app 唯一移除项）。

- 前提证据：`grep -rn "@base-ui" app/src` = 0（H03 ComboBox 迁移后业务域已净）；app 域残余仅 `app/tests/preload.ts` 预热与 `app/spike/legacy-*.tsx` 对照 fixture，两者同波退场（§1 AC1）。
- lockfile 审计（`diff` 前后快照 /tmp/bun.lock.pre-h14 vs bun.lock）：**恰好 3 条删除、零新增、零版本漂移**——`@base-ui/react@1.7.0`、`@base-ui/utils@0.3.2`、scoped `@base-ui/utils/reselect`，加 app 依赖清单一行。`bun install` 输出 `1 package removed`。
- 终态：bun.lock 内 `@base-ui` = 0；app/node_modules 残留 stale 符号链接（bun 懒清理，lockfile 已无引用，→H15 复查）。

**保留（逐项证据）：**

| 包 | 处置 | 依据 |
| --- | --- | --- |
| `@shadcn/react@^0.3.0` | 保留 | AC3 保留引擎：ui/questionnaire.tsx:1、ui/message-scroller.tsx:6（Spec §7） |
| `shadcn@^4.17.0` | 保留 | CLI 零调用（scripts/、.github/、全仓 shadcn add/init/bunx 均无命中）；但其 `./tailwind.css` export 被 styles.css:63 导入且被生产 ui 消费——删包即断生产样式 |
| `tw-animate-css@^1.4.0` | 保留 | styles.css:62 导入；ui/select.tsx:629（animate-in/slide-in/zoom-in 族）、craft/chat-panel.tsx:246 消费 |
| `class-variance-authority@^0.7.1` | 保留 | ui/{field,input-group,empty,item,bubble,sidebar,button,router-link}.tsx 等 8+ 文件在用 |
| `styles/legacy-ui-bridge.css`（ob-legacy 层） | **保留，删除条件未满足** | 碰撞名清扫已闭（bg-muted/bg-accent/text-accent/hover:bg-accent 在 app/src 全部 **0 命中**），但别名词汇仍被大量消费：text-muted-foreground 629、border-border 147、text-foreground 124、bg-card 41、bg-background 35、border-input 21、bg-sidebar 21 等。整体词汇改名是独立决策，非本票范围（→H15） |
| `server/assets/craft/web-template/package.json` 的 @base-ui/react | 保留不动 | Craft 生成模板资产（独立安装宇宙），票面明示不迁移 |

## 3. heroui-spike TextArea 处置（主控 16:58 裁定 + W5 F6 归属 H14）

- **根因复核**：与 H13 F3/H06 族一致——RAC 受控 TextArea 不消费合成 `fireEvent.change`/`user.clear` 的 input 事件，值在下次渲染复活；测试侧问题，**非 ui/textarea.tsx 生产回归**（升级条件未触发）。
- **修复**（app/tests/heroui-spike.test.tsx，唯一测试侧改动）：按 H06/H13 真键击模式改写「TextArea keeps a controlled value and emits changes once」——userEvent.setup({document}) + `{Backspace}".repeat(5)` 清空 + user.type("hi")；断言从「2 次合成 change」改为「每键击恰一次 change：5+2=7」，合同强度等价或更强；附 why-comment 指向 h06/REPORT.md 机制记录。
- **结果**：隔离复跑 h14/spike-isolated：**15 执行 / 13 pass / 2 fail**（pre-fix 隔离基线 12/15；TextArea 转 PASS）。余 2 红 = 已知**隔离条件性** Modal ESC 用例（W3C F2 口径：全量 native 上下文通过；h13/native 与本波 h14/native2 均证）。生产 dialog 不走裸 Modal 路径（ui/dialog 守卫 v3，CDP 证据链独立），保持记录、不视为产品回归。
- **全量账闭环**：h14/native2 = **130 files / 995 tests / 995 pass / 0 fail（EXIT 0）**——LEDGER 993/994 时代唯一红（TextArea）关闭；zz-probe 8/8 维持。

## 4. 全量 sweep 新发现与修复：router 模块期 NODE_ENV 竞态（preload 根因修复）

首轮全量 native（h14/native，产物保留作发现记录）：995 执行 / 990 pass / **5 fail，全部 app/tests/computer-driving-local-fields.test.tsx**（`Cannot read properties of undefined (reading '0')`，即 fix-round-2-f4 文档化的 RouterProvider/Matches 签名）。

- **单变量定因**：隔离复跑 5/5 绿；与 button-native 双文件合跑 12/12 绿；全量上下文才红。该文件注释自载机制：`@tanstack/router-core/isServer` 经 node condition 在**模块求值期**从 NODE_ENV 决定 client/server；文件在 beforeAll 设 NODE_ENV=test 后才 import——但全量单进程收集中，`button-native.test.tsx`（H02-era、静态 import router、无守卫，mtime Oct 19 21:37 早于 F4 版）先求值 router 模块时 NODE_ENV 未设，缓存的决定被全进程共享；F4 的 beforeAll 守卫只在「自己先求值」时成立，本质是求值顺序竞态。**该红不是 H14 改动引入**（F4 修复后未跑过全量 native；LEDGER 993/994 全量账早于 F4 增测）。
- **根因修复**（app/tests/preload.ts，进程级不变量层）：preload 顶部声明 `process.env.NODE_ENV = "test"`，使 native 层（Node）与 driven 层（bun test 天然 NODE_ENV=test）环境一致，router 按客户端求值——比任何单文件守卫更接近生产形状。computer-driving-local-fields.test.tsx 保留自身 beforeAll 作为 belt-and-suspenders，注释同步改写。
- **复跑**：定向三文件 27 执行 / 25 pass（2 红=spike 隔离条件性 ESC）；全量 h14/native2 **995/995 全绿 EXIT 0**。
- 影响面审计：`grep process.env.NODE_ENV app/src app/tests tests/support`——app/src 与 compat 层 **0 消费者**；driven 层 bun 已设同值，preload 对其 no-op。

## 5. BACKLOG-H14-H15.md 逐项处置

| # | 条目 | 处置 | 证据/去向 |
| --- | --- | --- | --- |
| H14-1 | puppeteer-core 声明 | **选 README 注记强化，不声明 devDependency** | cdp-harness 在 docs/ 证据目录而非包；README 补 CHROME_PATH 用法（fix-r1 已让 10 个脚本可移植）+「有意不声明」裁定理由。W3A F7 关闭 |
| H14-2 | CSS 增量复核 | **终态复算 +11,278B gzip（+22.6%）**：H02 裁定部分 +6,824 不变，H03–H13 组件 CSS +4,454 | §7 评审结论 |
| H14-3 | legacy-ui-bridge.css 删除 | **保留**（条件未满足） | §2；coverage.md §5.3；→H15 |
| H14-4a | switch 镜像非受控 stale | **已修**：inputRef 挂 change 监听，非受控切换后镜像不再 stale | bot-profile-active 3/3、update-routing-configured 2/2、spike Switch 绿、全量 native 绿 |
| H14-4b | heroui-theme 暗色 OFF 轨道 | **已修**：.dark/[data-theme=dark] 下 OFF track 12.8% 白 + OFF thumb --ob-foreground（BASE bg-input/80 + dark:data-unchecked:bg-foreground 计算值复原）；置尾保升序，biome 0 | — |
| H14-4c | merge 三拷贝 | **记录**：mergeRefs 三份实现语义不同（tooltip/dropdown 简单循环版 vs bubble 泛型恒等版），跨 H02/H03/H10 冻结文件，合并属设计决策 | →H15 备选 |
| H14-4d | ob-theme 冗余声明 | **已修**：legacy-ui-bridge 移除与 ob-theme 重复的 5 个声明（--background/--foreground/--border/--radius/--success），值恒等零行为差，why-comment 载明 | — |
| H14-4e | router-link to+href 同传 | **记录**：全 src 扫描 0 调用点同传；运行时优先级已有 doc comment；编译期互斥属冻结面接口变更、无现实收益 | →H15 备选 |
| H14-5 | shadcn/tw-animate/cva 去留 | §2 保留表 | — |
| H14-6 | agent-mastra/bun.lock 交付范围 | **保留为交付物**：六个兄弟子包 bun.lock 在 BASE 即为已跟踪，本文件系环境修复补齐的最后一块 | — |
| W3A-F3 | heroui-spike 排除清单复核 | 已由 H13 F3 关闭；本波 §3 全量账闭环 | — |
| W3A-F4 | ui/select.tsx:515-519 注释失实 | **维持 H15**（涉 H03 冻结 adapter；a11y 裁决同区） | — |
| W3A-F5 | bot-memory/bot-reaching-you 注释位置与缩进 | **已修**：biome --write（格式/organize-imports，零行为），复跑 11/11，biome 0 | — |
| W3B-F1 | h06 /tmp 证据路径 | **已回填**：h06/evidence/（typecheck2/build2/driven-final），REPORT 引用改指 evidence/ | — |
| W3B-F2 | h09 sign-in-card/root-drop-guard 计数 | **已修**：1/5（合计 6 不变） | — |
| W3B-F3 | h06 `:247` 行号漂移 | **已修**：早退实为 :174（两处） | — |
| W3B-F4 | h09「21 处」 | **已修**：20 处单行替换 | — |
| W3B-F5 | h06 triggers.tsx 前波 backdrop hunk | **已修**：变更行补记 | — |
| W4-F1 | h07 BASE-pristine 无产物 | **已修**：注记 + 可复现命令落盘 | — |
| W4-F2 | h07 七个逐文件 driven 无产物 | **已修**：注记 + **H14 复跑再证 44/44**（1+4+6+4+2+2+25） | — |
| W4-F3 | h07「21 个」置于 native 行 | **已修**：改「native 层 12 个」（21=跨层总数） | — |
| W4-F4 | h07 首轮 typecheck 无产物 | **已修**：会话输出注记 | — |
| W4-F5 | h07 引用漂移 | **已修**（:160,176,192,207,328,349；:104,107,110,156） | — |
| W5-F1 | h10 AC3 层级误标 | **已修** | — |
| W5-F2 | h10 menu-probe 产物夸大 | **已修**：会话证据口径注记 | — |
| W5-F3 | context-menu.tsx 终态指纹 | **已落**：h14/POST-CHECKPOINT 收录（§10） | — |
| W5-F6 | h10 TextArea「转 H15」stale | **已修**：对齐 H14 + 修复回执 | — |
| W5-F9 | driving-local-fields 框架过宽 | **已修** | — |
| W5-F4 | demonstration-recorder 空选项 | 已由 fix-round-2-f4 修复；本波更新 h10/POST-CHECKPOINT（§10），套件 5/5（隔离+全量）绿 | — |
| W6-F1 | preview-tab「零 diff」措辞 | **已修**（本轮零 diff / 相对 BASE 前波 3 hunk 双口径） | — |
| W6-F2 | h11 AC1 行引用 | **已修**（:559,:570,:578；:600-647） | — |
| W6-F3 | 「130 文件中 0 红」 | **已修**（130=全量 run 文件总数） | — |
| W6-F4 | h11 typecheck/build/biome 会话输出 | **已修**（三行注记） | — |
| W6-F5a | workshop-share token hunk 未列明 | **已修**（REPORT 补记） | — |
| W6-F5b | scheduled-task-editor "sibling" 注释 | **记录**：H11 冻结文件内措辞 nit，改注释即破 checkpoint 哈希，实链已包级证实 | →H15 顺手改 |
| W3C-F1 | h13 exit 0 矛盾 | 已是修正态（W3C 轮已改）；本波复核一致 | — |
| W3C-F2 | 红数隔离条件性未对账 | **已修**：h13 三处补口径 + H14 回执（§3） | — |
| 转H15-1..7 | 浏览器/验收类七条 | 维持 H15 | §9 |

## 6. 覆盖对账（AC4）

coverage.md：路由 **88 = 88**（零新增/改名，逐文件归属 H02–H13 唯一波次）；ui **27** 模块（manifest 26 + router-link 补录）×实测底座（14 @heroui adapter + 1 RAC 等价 Adapter + 9 plain + 2 @shadcn/react 引擎 + 1 Embla）；组件域 17 行归属；保留依赖/引擎 9 行含原因与主题兼容证据。AC4「不以旧清单掩盖遗漏」由全量重扫零 diff + router-link 补录满足。

## 7. 包体终测（同环境 gzip，H01 配方：静态 import 闭包 + 系统 gzip；dist 为终态 build）

| 指标 | H01 基线 | H02 | **H14 终态** | Δ vs H01（门槛=+10%） | Δ vs H02 |
| --- | ---: | ---: | ---: | --- | ---: |
| 登录初始 JS | 430,849 | 458,742 | **476,457** | +45,608（**+10.58%**，超 +43,085 门槛 2,523B） | +17,715 |
| 聊天初始 JS | 1,168,268 | 1,200,455 | **1,184,734** | +16,466（+1.41%，**远内** +116,827） | −15,721 |
| 总 CSS（3 文件和） | 49,906 | 56,730 | **61,184** | +11,278（**+22.6%**，超 +4,991 门槛） | +4,454 |

**评审结论（两项超门槛）：**

1. **登录 JS +10.58%**：增量几乎全部在共享入口 chunk（index 374,460→约 419,969 gzip；route-sign 自身 1,449→1,450 近零增长）。机制：迁移后全部 14 个 ui adapter 共享的 HeroUI 运行时 + react-aria 原语被静态入口携带，登录页作为消费最少的路由同样承担这份共享运行时——是「公共控件统一由 HeroUI 承担」（A01）的一次性结构成本，非登录页新增面。H02 已裁定同机制前半段（+27,893/+6.5% 通过）；后半 +17,715 来自 H03–H13 的 overlay/collection adapter（dialog/select/dropdown/tooltip/combobox/sheet/context-menu 及 RAC 依赖）在入口 chunk 的 hoist。旁证：聊天侧 H02→H14 反而 −15,721（@base-ui 删除 + chunk 重分布），总量未单调膨胀。**残余优化（→H15 备选）**：评估 manualChunks 将 HeroUI/RAC 运行时与 auth 路由分离，或入口侧动态化非首屏 adapter——属构建配置变更，须独立评审。
2. **CSS +22.6%**：H02 裁定部分 +6,824（+13.7%）维持原结论（逐组件导入为最小路径；整包 @heroui/styles 将再多约 +37KB，h02/build-css-probe.log）。新增部分 +4,454 = H03–H13 迁移组件 CSS（styles.css:44-59 注释块自证：modal/close-button/select/list-box/popover/combo-box/dropdown/menu/menu-item/menu-section/surface/tooltip/drawer/description/field-error），每个 import 与一个已迁移 ui wrapper 一一对应，未发现无消费者组件 CSS。「裁剪 base/variants」复核：base/theme/utilities/variants 为全组件共享原语，本波无可裁项；进一步压缩属独立性能任务（→H15 备选）。
3. 方法与 H01 完全一致（h01/baseline/bundle-sizes.md 配方；entry=index.html 引用 index-*.js + route chunk 的静态 import 闭包，gzip -c 默认级；CSS=3 产物 gzip 和）。

## 8. 验证账（全部实跑，命令 + exit code）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| typecheck（终态） | `cd app && bun run typecheck` | **EXIT 0**（多轮；最后一轮在全部编辑后） |
| build（终态） | `cd app && bun run build` | **EXIT 0**（✓ built in 8.22s，/tmp/h14-build-final2.log） |
| bun install | 根 `bun install` | **EXIT 0**，1 package removed；lockfile diff = 仅 @base-ui 3 条 |
| 全量 native | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h14/native2 bunx e2e run --config e2e.unit.config.ts`（仓库根） | **EXIT 0：130 files / 995 tests / 995 pass / 0 fail**（首轮 h14/native 5 红=§4 竞态发现+修复，产物保留作发现记录） |
| driven | `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h14/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | **EXIT 0**，6 组全过（part 1–4 + ai-observability + multitenancy = 87 个 app 文件，与 H10 账一致；执行前核验 E2E_BUN_ONLY 前缀与清单 app 组覆盖一致——app/src 组 2 文件按既有口径不在本范围） |
| spike 隔离 | `E2E_UNIT_OUTPUT=…/h14/spike-isolated bunx e2e run --config e2e.unit.config.ts app/tests/heroui-spike.test.tsx` | 15 执行 / 13 pass / 2 fail（隔离条件性 Modal ESC，全量绿；exit 1 为预期口径）；TextArea PASS |
| 定向回归 | switch/billing 五文件 native；bot-profile-active driven；bot-memory+bot-reaching-you driven；h07 七 driven 文件 | 43 执行/41 pass（2=spike ESC）；3/3；11/11；**44/44** |
| test:ci（收口轮） | 根 `bun run test:ci` | **EXIT 1**：599 文件 / 7968 tests = 7700 pass / 194 fail / 74 skip；**app 域 0 失败**。31 个失败文件逐域归属：server/src/knowledge + server/tests/*（28 文件，enterprise/knowledge/craft/compose 域——LEDGER 2026-10-20 环境修复节已记的同类 BASE 漂移/环境红：日志含 21 处 ECONNREFUSED/Failed query/UnmeterableModelError/CreditGateError 环境签名，本迁移零触碰 server 域）；tests/compose.test.ts（1，部署编排域）；tests/bun-suites.test.ts（1 组失败=含上述 server 文件的组，驱动器 ISLANDS 单文件重跑机制已按 ADR 0008 运作——app 文件 account-mode-dialog/approvals-rules/bot-approval-rules/bot-memory 均为「仅共享进程红」并已转绿）；scripts/test-ci.test.ts（1，spawn 环境敏感 meta-test：合成子进程 exit 1≠7，零 repo 依赖、零 app 关联）。环境阻塞有证据、不计通过 |
| biome | `bunx biome check <本波触及文件>` | 触及的 7 个 ts/tsx + 2 个 css **0 诊断**；唯余 upgrade-dialog.tsx 2 条 useExhaustiveDependencies——**BASE 既有、保留**（修之即改结算轮询依赖数组语义，H08 判定+本波复核维持；同文件 useOptionalChain warning 已按恒等变换修复） |

## 9. 遗留（→ H15）

1. sign JS +10.58% / CSS +22.6% 残余优化评估（§7）：manualChunks 运行时分离、base/variants 深挖——构建配置/性能任务。
2. ui/select.tsx:515-519 注释失实修正 + role=combobox 缺失 a11y 裁决（W3A F4，H15 既有项）。
3. legacy-ui-bridge.css 词汇级改名决策（629+ 处消费点）。
4. mergeRefs 三拷贝合并（语义差异需设计决策）；router-link to+href 编译期互斥类型。
5. scheduled-task-editor.tsx:543-545 "sibling" 注释措辞（下次触碰该文件顺手改）。
6. app/node_modules/@base-ui/react stale 符号链接（bun 懒清理；lockfile 已无引用，下次 install 后复查）。
7. BACKLOG 转H15 七条浏览器/验收项 + 检查点债（H01 终态指纹重算、H02 d78d04b0 7 文件漂移对账）不变。

## 10. 检查点（POST-CHECKPOINT.sha256）

h14/POST-CHECKPOINT.sha256 = 本波触及的源/测试/基建文件终态 sha256：app/package.json、bun.lock、app/tests/preload.ts、app/spike/main.tsx、app/src/components/ui/switch.tsx、app/src/styles/heroui-theme.css、app/src/styles/legacy-ui-bridge.css、app/src/components/billing/upgrade-dialog.tsx、app/src/components/ui/context-menu.tsx（W5 F3 终态 pin）、app/tests/heroui-spike.test.tsx、app/tests/bot-reaching-you.test.tsx、app/tests/bot-memory.test.tsx、app/tests/computer-driving-local-fields.test.tsx、app/tests/button-native.test.tsx（§4 定因参照）、app/src/components/computer/demonstration-recorder.tsx（F4 终态）、docs/verification/heroui-migration/h10/POST-CHECKPOINT.sha256、coverage.md、本 REPORT。

**h10/POST-CHECKPOINT.sha256 更新记录**（F4 修复后哈希漂移，授权更新）：demonstration-recorder.tsx = 1c409071…（与授权值一致）；computer-driving-local-fields.test.tsx 授权值 3456ec13… 为 F4 完成态，现哈希 e6ff33a5…——差异仅为 H14 §4 的注释改写（NODE_ENV 事实归位说明），零测试逻辑变化；zz-probe 与 cdp 脚本两行复验未变。
