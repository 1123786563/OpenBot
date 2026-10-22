# HeroUI v3 迁移 Ledger

- 授权：父 Issue #443 委派提示词（2026-10-19）；不 commit/push/merge/deploy。
- 工作区：`.worktrees/heroui-migration` 分支 `feat/heroui-v3-migration`
- BASE：`203d0f0244b2f898218fa12027089c631e8448d9`
- 远端读取：2026-10-19T12:54Z，#443–#458 全部 OPEN，无既有实现。
- 阶段：门禁已恢复——无任何任务 verified。H03 发现 Critical 交互缺陷（ESC 级联），H01 浏览器回路已建立并抓到红点。
- H02 检查点：`d78d04b08a1f39afe94df938cced341ebaa80e65495b1a30f75a9a50ffc96fde`（`h02/CHECKPOINT.files`）。
- 基线（H01）：typecheck/build EXIT 0；native 128 files / 967 tests pass；登录 JS 430,849 gzip、聊天 JS 1,168,268 gzip、CSS 49,906 gzip。

| Task | Issue | 状态 | 检查点指纹 | 验证 | Review/OCR | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| H01 | #444 | in_progress | - | baseline/build/单测已录；浏览器回路已建：token 同页/数值ID/TanStack Link 绿；ESC 级联红 | pending | 见 h01/browser/RUN-2026-10-19.md |
| H02 | #445 | implemented/verified | d78d04b0… | typecheck 0; build 0; native 982/985 (2 isolation-only + 1 baseline-env); CSS +13.7% recorded | pending independent review | 12 wrappers + theme + ButtonLink |
| H03 | #446 | 遗留已收口（待复审） | 见下方 2026-10-19 收口轮指纹 | ESC 七场景矩阵 7/7 PASS（含选项焦点路径、快速连按、焦点返还）；dialog 业务 18 pass + 1 pre-existing 环境失败（单变量对照证无关）；typecheck 0 | 复审待派发 | RUN-2026-10-19.md 修复轮+收口轮 |
| H04 | #447 | pending | - | - | - | blocked by H03 |
| H05 | #448 | pending | - | - | - | blocked by H03 |
| H06 | #449 | pending | - | - | - | blocked by H03 |
| H07 | #450 | pending | - | - | - | blocked by H03,H04,H06 |
| H08 | #451 | pending | - | - | - | blocked by H03 |
| H09 | #452 | pending | - | - | - | blocked by H03 |
| H10 | #453 | pending | - | - | - | blocked by H03,H09 |
| H11 | #454 | pending | - | - | - | blocked by H10 |
| H12 | #455 | pending | - | - | - | blocked by H03,H06 |
| H13 | #456 | pending | - | - | - | blocked by H03 |
| H14 | #457 | pending | - | - | - | blocked by H04-H13 |
| H15 | #458 | pending | - | - | - | blocked by H14 |

## 检查点记录

（每波次追加：时间、diff 清单、指纹、验证命令与结果、Review/OCR 结论、遗留）

## 2026-10-19（浏览器轮）

- 新建隔离 spike 入口：`app/spike.html` + `app/vite.spike.config.ts`（不动生产 vite.config），样式仅导入 `src/styles.css`。
- browser-use 驱动 `window.__runH01`；结果转录：`h01/browser/RUN-2026-10-19.md`。
- **Ruling（缺陷归属）**：ESC 级联关闭判归 H03 `dialog.tsx`（RAC Modal 文档级 ESC 未按层截留），修复方向：弹层内消费 ESC 后 stopPropagation，或 Modal 改受控 close；两次拦截式修复（document capture stopImmediate / onOpenChange 时间窗）均已实验并回退，证据在 RUN 文件。
- **Ruling（门禁）**：H03 未修复并复审前，不派发 H04–H15 任何实现；H01 保持 in_progress（AC3/AC4 未全绿）。
- 现场：spike 服务器已停，dialog.tsx 已回退（typecheck 0），浏览器已还原 3011/sign。
- 2026-10-19 修复轮：ESC 守卫（popup 存在判定+200ms 窗口）与双 rAF 焦点返还落地 dialog.tsx；
  真实键盘（CDP）证据见 RUN 文件修复轮。Ruling：门禁仍保持——H03 两个遗留（option 焦点 ESC 路径、
  焦点返还断言）收口并复审前，不放行 H04–H15。
- 2026-10-19 收口轮：两条 H03 遗留关闭（选项焦点 ESC、焦点返还），新发现快速连按 ESC 边缘并修复
  （守卫 v2：活弹层=任务域 burst 标记；垂死弹层=document capture 代偿关闭；200ms 时间窗删除）。
  证据：ESC 七场景矩阵 7/7 PASS（puppeteer-core+本机 Chrome，CDP 可信输入，环境切换已记录）；
  dialog 业务 18 pass + shared-grant-dialog 1 个 pre-existing 环境失败（单变量对照：HEAD 版
  dialog.tsx 同样挂，registerHooks/node:module，与本轮无关）；typecheck 0。
  收口轮检查点：HEAD `203d0f0244b2`；指纹 = sha256(dialog.tsx)=`750a5e2c…` ⊕ sha256(RUN 文档)=
  `b6dd7a70…` → 组合前缀 `65a4f0ad655761de`。
  Ruling：H03 实现侧遗留清零；复审（Spec compliance + code quality）派发前 H04–H15 仍不放行。

## 2026-10-19（H01/H03 独立审查轮，UTC 17:00 前后）

- **H01 审查**（只读 agent）：Spec compliance **pass（有保留）**、code quality **pass**。
  High：RUN 引用 /tmp 脚本未归档 → 已归档至 `h01/browser/cdp-harness/`（脚本+README+guard-v3 原始输出 log）。
  Medium 待办（归 H01 收口，任务 #4）：21:07 results.json 旧证据与 RUN 矛盾未作废标注；AC3 缺
  Questionnaire/Scroller 到达证据、搜索与清空；AC4 缺 ContextMenu 键/触摸长按；AC1 缺 88 路由
  归属产物、AC5 缺 light+zh 截图与契约矩阵 H01 归属。
- **H03 审查**（只读 agent）：Spec compliance **FAIL**（critical：REPORT 谎称 ComboBox 已迁，
  combobox.tsx 实仍 Base UI，AC4 未达成）、code quality pass with 2 high（嵌套 Dialog stamp 污染、
  role=combobox 声明与证据矛盾）。
- **H03 修复轮**（进行中）：
  - 守卫 v3 已落 dialog.tsx：`openDialogs` 栈（垂死弹层 ESC 只由最内层 open Dialog 代偿，嵌套
    不再误关外层）+ 活弹层选择器扩 grid/tree；typecheck 0；矩阵 A–E 回归全 PASS；**F1 嵌套
    ESC 层级新增 PASS**（2→1→0，焦点逐层返还，`cdp-harness/run-2026-10-19-guard-v3.log`）。
  - ComboBox 迁移（AC4 critical）已派 frontend_implementer 后台执行（combobox.tsx + new.tsx +
    spike fixture + CDP 验证），交付后需 F2（内层 Dialog 内弹层死路径）补跑并更新 REPORT.md
    的 ComboBox/role=combobox 两处失实声明。
  - 哈希配方备注：收口轮指纹 = `sha256sum app/src/components/ui/dialog.tsx docs/.../RUN-2026-10-19.md
    | sha256sum` 的输出前 16 位（两行清单的 sha256）。
- 门禁维持：H04–H15 在 H03 复审通过前不放行。
- **H02 审查**（只读 agent）：Spec compliance **pass（有条件）**、code quality **pass**。
  Medium 待修：M1 `bubble.tsx:33` hover 仍用 `--muted`（AC1 token 漏网，归 H10 波次修）；
  M2 H02 检查点 d78d04b0 为封存快照、7 文件现哈希漂移（预期内，H03 收口后做受影响文件增量复验）；
  M3 亮暗首屏浏览器检查缺 H02 证据（并入 H01 AC5 截图缺口一起补）。Low 五项入 H14/H15 清单
  （switch 镜像非受控 stale、heroui-theme 暗色 OFF 轨道、merge 三拷贝、ob-theme 冗余声明、
  router-link to+href 同传）。
- **H01 AC3/AC4 补证**（CDP ac-reach，归档于 `cdp-harness/run-2026-10-19-ac-reach.log`）：
  Scroller End 键滚到底（182+126=308）**新增 PASS**；Questionnaire 程序化点击、Shift+F10/
  ContextMenu 键、触摸长按在 headless CDP harness 下不触发——环境限制如实记录，转 H15
  in-app browser/a11y 轮复核，不计通过。AC1 产物 `h01/inventory-routes.md` 已生成（88 路由
  逐文件归属 + @base-ui/@heroui 导入清单）；`h01/spike/browser/results-SUPERSEDED.md` 已标注
  旧 token 读数作废。
- **H01 AC1/AC5 产物补齐**（2026-10-19 UTC ~17:10）：`h01/contract-matrix.md`（24 个公共 UI
  处置×波次×实测底座状态：14 ✅ @heroui/react、combobox ⏳ 迁移中、其余 plain=等价自建组合，
  含 H14 @base-ui 残留底稿）；scratch 探针 `tests/__probe-h08`/`__scratch-input` 已删（无引用，
  zz-probe-context-menu 保留为真回归）。H01 待办余量：AC5 light+zh 截图（归 H15 真实 app 页）、
  检查点指纹重算（H03 收口后统一做）。
- **H03 复审检查单**（combobox 迁移交付后逐项核验，全过才放行 H04–H15）：
  1. critical 关闭：combobox.tsx 无 `@base-ui` import（grep 实测）；REPORT.md「ComboBox 已迁」
     声明与新实现一致；AC4 五件套（Modal/Select/ComboBox/Dropdown/Tooltip）全部 @heroui。
  2. high 关闭：守卫 v3 嵌套污染——矩阵 A–E+F1 全 PASS 原始输出在 cdp-harness/；role=combobox
     声明按实测改写（保留 aria-haspopup=listbox 的事实陈述，role 缺失记 H15 a11y 裁决）。
  3. medium 关闭：haspopup 选择器含 grid/tree（dialog.tsx 实读）；矩阵脚本+输出归档
     cdp-harness/；F2（内层 Dialog 内 Select 死弹层路径）补跑 PASS 或如实记录阻塞。
  4. 迁移质量：combobox 迁移报告（h03/combobox-migration.md）的验证命令全部实跑过；typecheck
     0；compose-state/toFieldChange 语义保留或有等价说明；无 String() 强转/any。
  5. 复审形式：只读 reviewer 重审 dialog.tsx+combobox.tsx+REPORT，给 Spec compliance 与
     code quality 双结论；随后主控跑 OCR（workspace 模式，--audience agent）。
- **H01 REPORT.md 落盘**（2026-10-19 UTC ~17:13）：AC1-AC5 对照表 + 基线数字 + 缺陷轨迹 +
  独立审查结论 + 下游 Interface + H15 转办清单。H01 文档面闭合；唯一余项=终态检查点指纹
  （等 H03 收口统一重算）。H01 状态 → implemented/证据汇编完成，verified 判定待 H03 复审
  通过后与 H02/H03 一并由复审结论背书。
- **远端 Issue 进度同步**（2026-10-19 UTC ~17:14，进度评论非关闭）：
  #444 → issuecomment-6272891332；#445 → issuecomment-6272897067；#446 → issuecomment-6272897701。
  内容与本 Ledger 一致；H03 评论明确门禁维持与 ComboBox critical 修复中。
- **h03/REPORT.md 失实声明诚实化**（2026-10-19 UTC ~17:15）：第 9 行 role=combobox 声明改为
  实测事实（aria-haspopup=listbox、role 为空、H15 a11y 裁决）；第 10 行 ComboBox「已迁」改为
  「迁移进行中」（含独立审查发现记录）；迁移完成后更新为终态并附 combobox-migration.md 指针。
- **ComboBox 迁移（主控接手）实现轮**（2026-10-19 UTC ~17:40）：combobox 迁移 agent 26 分钟
  无实质产出已停止；主控按授权接手修复轮。类型研究定案：RAC 1.22 ComboBox 的 multiple 回调
  为 `Key|null` 二等语义（无序、无 reason），不能表达 To 字段顺序合同 → **等价 Adapter**（Spec
  允许）：RAC `Popover + Input + ListBox(multiple) + useFilter` 一等公民组合，`react-aria-components`
  显式化 1.22.1（lock 已有，零新装）。combobox.tsx 第三版 + new.tsx 单组件调用面（顺序合成、
  toFieldChange 保留接线、死代码清理）+ spike MultiSelectFixture。typecheck 0；compose-state
  e2e 层 13/13（bun 直跑 registerHooks 环境失败再证）。
  **浏览器验证（CDP combobox.mjs）**：开→选 Alpha→选 Beta（顺序 b1,b2）→过滤 gam 选 Gamma
  （b1,b2,b3）→ESC 后选择保持——**核心行为 PASS**；**2 项红**：(a) chip remove 点击被吞
  （onPointerDown 前置仍无效，疑 RAC Popover outside-dismiss/backdrop 拦截），(b) ESC/选择后
  弹层关闭时序不符（受控 open 未随 RAC dismiss 联动；真鼠标点击选项后弹层即关）。
  结论：**AC4 实现完成但带 2 项浏览器红，不放行、不关票**；下轮修 Popover 整合（方向：
  shouldCloseOnBlur/hideOnInteractOutside 显式化 + triggerRef 挂载时序 + backdrop 检查），
  修后重跑 combobox.mjs 全绿 + F2 + build + 全量 native，再派 H03 复审。
- **ComboBox 迁移浏览器验证现状（未收敛，诚实入账）**（2026-10-19 UTC ~17:45）：
  合成 click（CDP el.click）路径下核心序列曾全绿（选 Alpha→Beta→过滤 Gamma→b1,b2,b3 顺序、
  ESC 不清空）；切真鼠标后暴露未定位缺陷：真实点击选项后选择被清空（picked=[]，疑 RAC
  ListBox multiple 受控语义——已加 'all' 防御仍未复绿），chip remove 点击被吞。**判定：
  AC4 未达成，H03 不复审，H04+ 不放行。**
  下轮恢复入口：combobox.tsx 第三版（RAC Popover+Input+ListBox+useFilter 等价 Adapter）、
  /tmp/cdp-harness/combobox.mjs（含 DUMP 诊断）、spike MultiSelectFixture。排查方向：
  (a) RAC ListBox multiple 受控 selectedKeys 在真实 pointer 下的 onSelectionChange 实际值
  （先打日志取 keys 实测）；(b) document capture listener 与 RAC press 的时序；(c) 若 RAC
  ListBox 受控多选不可靠，回退 ChipRemove-only 管理选择（选项点击走 onAction）。
  另：server scripts/bootstrap-local-gateway.ts 出现 2 个 TS 错误（GatewayProbeRun.result），
  非本迁移文件、非本会话引入——gateway/H05 域归属待确认。
- **决定性事实（ instrumentation 实测）**：真实鼠标点击 RAC ListBoxItem 时 `onSelectionChange`
  **从不触发**（合成 el.click() 反而能触发）——即真鼠标路径下 RAC ListBox 的选择管线未接通，
  这就是「点击后 picked=[]」的根因，而非 'all' 语义。方向修正：排查 RAC ListBox 在
  `items` + 函数 children 模式下对真实 pointer 的 press 处理（候选：ListBox 需要
  `onSelectionChange` 与非受控混合时的焦点/press 目标；或 ListBoxItem 缺 `textValue` 之外
  还差 `id` 传给 RAC 内部 collection 的方式）。调试日志已移除，代码处于干净可续状态。
- **最终疑点（本轮预算耗尽）**：document click capture 委托（含 [cb-debug] 日志桩，保留在
  combobox.tsx 供下轮直接用）在 fresh-load 页面上从未执行——而独立 seq 证明 click 事件到达
  item 内 SPAN。两事实矛盾指向：vite 对 combobox.tsx 的 HMR/模块图在该 fresh load 中仍供旧
  模块，或 useEffect 挂载前弹层已被某路径重开。下轮第一步：curl 确认 vite 返回的
  combobox.tsx 转换产物含 onItemClick；若模块图陈旧，重启 spike vite 后再跑 combobox.mjs。
  代码当前为干净可续状态（调试桩已标注）；AC4 未达成、门禁维持。
- **预算收束（2026-10-19 UTC ~17:52）**：console 监听补齐后 [cb-debug] 仍零输出——onItemClick
  未执行或未到达，且 DUMP chips 区仅剩 input。已尽本轮诊断预算；调试桩与全部取证脚本
  （combobox.mjs/seq.mjs/seq2.mjs/probe-cb*.mjs）原地保留。下轮从「listener 未执行的矛盾」
  接手：第一动作 = 在 onItemClick 外层再挂一个无条件下 document click 计数器，区分
  「事件没到 document」vs「handler 没绑」。AC4 未达成、门禁维持不变。
- **根因破案 + 核心选择链路打通**（2026-10-19 UTC ~17:54）：真鼠标选择失败根因=委托读了
  RAC 生成的 DOM id（`react-aria…-option-b1`）而非业务 id——修复：ListBoxItem 落
  `data-item-id={getKey(item)}`、委托读 `data-item-id`。重跑 combobox.mjs：
  **选 Alpha→b1、选 Beta→b1,b2（pick 顺序保持）✓ 核心选择/顺序/数据流全通**；
  仍红（同一族弹层交互细节）：chip remove 点击命中 BODY（点击时按钮移位/被盖，picked 不变）、
  ESC 后弹层未关（时序）、empty 态未现。typecheck 0。
  下轮：修 chip remove（去 onPointerDown 改回 onClick+scrollIntoView 后重取坐标已做、疑
  pointerdown preventDefault 与 RAC input focus 抢占）与 ESC 关闭时序；重跑 combobox.mjs
  全绿后 → F2 → build → 全量 native → H03 复审 → OCR → 放行。
- **combobox 实现轮收束**（2026-10-19 UTC ~17:59）：已验证绿——打开/多选/移除/顺序
  （b1→b1,b2→remove Beta=b1）/ESC 不清空选择。**唯一遗留红**：headless 脚本下 keyboard.type
  未更新 query（focus 补丁后 input.value 仍空，疑 RAC/焦点管理在合成焦点后移走；empty 态验证
  随之阻塞；contains 签名已核实为 contains(全文本, 子串)，代码方向正确）。typecheck 0。
  下轮第一步：脚本 type 后立即采样 input.value；若空，改用 page.type 或原生
  input.dispatchEvent(new Event('input'))；过滤绿后跑 empty 态 → F2 → build → 全量 native
  → H03 复审 → OCR → 放行。
- **page.type 亦不更新过滤**（2026-10-19 UTC ~18:00）：排除输入焦点问题（page.type 自带
  聚焦），指向 RAC ListBox 的 `items` prop 更新后弹层内 collection 未重渲染（函数 children +
  items 组合的重渲染管线），或 options 计数含陈旧 DOM。下轮：先确认 filtered 数组本身
  （临时 console 在 useMemo 后打长度），再查 ListBox→collection 的重渲染触发条件。
  **本轮最终绿账**：开弹层、选 Alpha、选 Beta（顺序保持）、移除 Beta、ESC 不清空——
  核心 multi-select 数据合同（领域 id、空值、顺序、移除、ESC 语义）全部真鼠标验证通过。
  遗留红：过滤更新、empty 态、弹层 ESC 关闭时序、chip remove 真实指针命中。
- **过滤不生效根因定案**（2026-10-19 UTC ~18:01）：type 后 DOM input.value=""——RAC Popover
  打开时的 autofocus 把焦点从 chips input 拉进弹层（keystrokes 打在弹层上）；配合 18:00 的
  console 监听补齐（此前「日志未出现」是脚本没监听 console 的假象）。修复方向（下轮）：
  ComboboxContent 渲染后把焦点拉回 input（rAF/无 FocusScope 抢占），或在 Popover 内首元素
  aria-hidden focus 兜底；修后 combobox.mjs 应全绿（选择/移除/顺序/ESC 保持已绿，过滤/empty
  待此修复）。当前代码含调试桩（filtered console），收口时移除。AC4 待过滤绿；门禁维持。
- **焦点拉回尝试未生效**（2026-10-19 UTC ~18:02）：Popover 打开后双 rAF 把焦点拉回 chips input
  无效——DOM input.value 仍空，说明焦点被 react-aria FocusScope（Popover 的 autofocus/焦点
  陷阱）持续占有，rAF 级拉回被其 focus-in 恢复覆盖。下轮方向（按把握排序）：(a) Popover
  打开时不抢焦点的官方路径——RAC Popover 传 `UNSAFE_style` 无关，正确做法是把 Input 纳入
  FocusScope（Popover 内渲染 chips+input，即把整个 chips 行搬进弹层首行，"combo-in-popover"
  官方组合模式）；(b) react-aria FocusScope 的 `contain`/`restoreFocus` props 显式关闭。
  调试桩（filtered console / inputRef / rAF）保留；AC4 过滤+empty 待焦点链路修复。
  门禁维持不变。本轮其余成果（选择/移除/顺序/ESC 保持全绿、H01/H02 收口、守卫 v3+嵌套栈）
  见上方各条。
- **combo-in-popover 实施设计（下轮第一个动作，预算收束前固化）**：解决 FocusScope 焦点
  抢占的正解是把 chips 行搬进弹层内首行（react-aria 官方 combo+popover 组合），焦点链路
  自然闭合。具体改动：
  1. combobox.tsx：Combobox 渲染改为「触发区（只读按钮/摘要，点击 setOpen(true)）+ Popover
     （首行=chips 容器含 chips+ComboBoxInput，下接 ListBox+Empty）」；Input 留在 Popover 内，
     FocusScope 焦点进弹层后直接落在 input，typing 天然工作；删除 rAF 拉回 hack 与
     document 级 Escape/外点监听（FocusScope+RAC dismiss 原生接管；dialog 守卫依赖的
     aria-haspopup/expanded 挪到触发按钮上）。
  2. new.tsx：调用结构随 wrapper 调整（数据流/顺序合成/toFieldChange 不变）。
  3. 验证：combobox.mjs 全流程（开→选×2→过滤→移除→ESC）+F2（嵌套内 Select 死弹层）+build
     +全量 native → 移除全部调试桩 → H03 复审 → OCR → 放行 H04–H15。
  当前 combobox.tsx/new.tsx 为干净可续状态（调试桩已标注、typecheck 0）。

## 2026-10-20（combo-in-popover 实施轮）

- **结构重构落地**（combobox.tsx 全量重写）：触发区=只读摘要按钮（`aria-haspopup="listbox"` +
  `aria-expanded` + chevron，dialog 守卫 v3 依赖的属性在此）；Popover 首行=chips 行（chips +
  filter Input `autoFocus`），下接 ListBox(multiple)+Empty。关键依据（Popover.mjs 实读）：
  RAC Popover 打开时仅当「焦点不在其内部」才聚焦容器（`!isFocusWithin` → focusSafely），
  故 Input `autoFocus` 先拿焦点 → 容器自聚焦被跳过 → typing 天然可用。
  删除项：rAF 焦点拉回、document 级 Escape/外点/item-click 三个监听、removeBusyRef、
  onPointerDown 双绑、全部 [cb-debug] 调试桩；onSelectionChange 改原生 RAC（前轮「真鼠标不
  触发」的根因即自家外点 pointerdown 监听与 press 管线竞争，删除后原生管线可靠）。
  `commit` 签名 `Iterable<Key>`：Set<Key> 直接进入 .has 查询，ordered 输出仍为 string[]——
  无 String() 强转、无 any。new.tsx：删除 autoFocusInput prop（关闭态无 input，defaultOpen
  覆盖自动聚焦），数据流/顺序合成/toFieldChange 不变。typecheck 0。
- **选择后焦点返还**：真指针选择后 RAC 把焦点落在 item 上，immediate `inputRef.focus()` 会被
  press 收尾覆盖（S2/S3 实测 focusOn=combobox-item）→ 改 `requestAnimationFrame` 内拉回，
  过滤链路 typing 保持（S4 value="gam" options=1 实测绿）。
- **浏览器证据（CDP 可信输入，全部 ALL PASS）**：
  - `combobox.mjs` 11/11（开/选序/过滤/清过滤/chip 移除/空态/ESC 层级/重开保留/无调试桩
    残留）：`cdp-harness/run-2026-10-20-combobox.log`；
  - `combobox-dialog.mjs` 11/11（新增）：Dialog 内 Combobox ESC 逐层（弹层→Dialog）、快速
    连按分层、重开 chips 保留、footer close；**F2 关闭**——嵌套 Dialog 内层 Select 死弹层
    路径（option 焦点 ESC→背靠背二次 ESC→内层关外层活→末次关外层，焦点逐层返还）：
    `cdp-harness/run-2026-10-20-combobox-dialog.log`。脚本已归档 cdp-harness/。
    脚本坑（如实记）：HeroUI Button 不透传 DOM id → 定位须按 text/selector 且先
    scrollIntoView（视口外点击坐标落空假红过一轮）；死弹层窗口=两键背靠背，间隔 120ms 会
    落进「焦点已被收到隐藏 input、退场未完」死区（dying 分支不触发、Modal 也不收）。
  - 回归：matrix.mjs（A–E）exit 0；matrix-nested.mjs（F1）PASS——dialog.tsx 本轮未改动。
- **build**：`bun run build` exit 0（/tmp/app-build.log）。全量 native（worktree 根
  `bunx e2e run --config e2e.unit.config.ts`）结果待录；注：在 app/ 子目录跑会收空集
  （config 在仓库根），首轮空跑已排除。
- H03 复审检查单状态：critical ①（combobox 无 @base-ui + REPORT 一致性）与 medium ③（F2
  补跑）已具备关闭条件，待 native 绿后统一核验并派只读复审（Spec + code quality 双结论）。
  门禁维持：H03 复审 + OCR 通过前 H04–H15 不放行。
- **全量 native 收集面修复 + 首次全貌**（2026-10-20 UTC ~01:54）：
  - 环境修复（均未提交）：agent-computer/agent-bot/agent-langgraph/agent-mastra/agent-sandbox/
    desktop/supervisor 七个独立子包（不在根 workspaces）补 `bun install`；e2e-bun-suites.json
    补录孤儿条目 `server/tests/billing-period-fulfillment.integration.test.ts`（bun-test-compat
    层，旧清单缺失致 node 层收集撞 bun: 协议、COLLECTION_ERROR 使整轮报废；来源=BASE 清单岛，
    main e875a1e1 修的是另一批同族岛）。修复后收集面 985→7966 tests。
  - 全貌账：**7703 pass / 187 fail / 76 skip**（599 文件）。分域归因：server 161
    （enterprise/* 与 knowledge 域，本迁移零触碰，判 BASE 相对 main 的固有漂移红，归属 H05/
    H12 等域 verify 轮）；tests 层 10（bun-suites 调度器与 compose）；app 域 15——zz-probe-
    context-menu 8（既有真回归）、其余 7 落 H02 域组件（heroui-spike TextArea、
    gallery-components 表单、user-preferences 上下文菜单、bots-nav-badge、approval-team-
    settings），均不在 H03 改动面（dialog.tsx/combobox.tsx/new.tsx/spike），dialog 业务
    25/25 与 compose-state 13/13（前轮）继续有效；channel/new 与 combobox 相关 e2e 无失败。
    单变量归因与逐域修复归 H04+ verify 轮，不阻塞 H03 复审派发。
  - 检查点：HEAD 仍 `203d0f0244b2`（无 commit）；本轮组合指纹 = sha256(combobox.tsx,
    dialog.tsx, new.tsx, spike/main.tsx, h03/REPORT.md, h01/contract-matrix.md,
    e2e-bun-suites.json) 的 sha256 前 16 位 = `bc9a4990717bf6f0`。
- **OCR 执行状态（2026-10-20 UTC 02:31 起）**：首轮 workspace 模式（concurrency 4）10 分钟
  后 116/116 文件全败——HTTP 429 限流（30/46 请求受影响，重试 9 次恢复），LLM 连通性本身
  正常（`ocr llm test` 通过）；`--resume` 不支持 workspace 模式。已以 concurrency 1
  重新全量发起（log `/tmp/ocr-review3.log`），结果待录。
- **H03 复审结论（REVIEW-2026-10-20.md，2026-10-20 UTC ~02:25）**：Spec compliance =
  **pass with conditions**、code quality = **pass**；a–f 核验全过（无 @base-ui、顺序合同/
  无 String()/any、守卫 v3 正确性、无调试残留、toFieldChange 保留、证据链无虚报）；native
  归因无矛盾。条件 M1（REPORT.md:3/:33 与 2026-10-20 证据未收敛，纯文档）**已修**：状态行
  改为 CDP 证据闭环口径、未完成清单收窄为「外点关闭/scroll lock/短视口滚动/Select popover
  定位」（转 H15）。Low 四项（maxSelected=0 边界、document 级探测、effect 闭包、hidden-
  coworker parity 点检）记录不阻塞，归 H04+ verify 轮点检。复审建议：**H04–H15 可放行**
  （条件=M1 修复[已完成]+接口冻结维持）；OCR 门禁按流程补跑。

## 2026-10-20（会话恢复 + H04 放行决策）

- **会话恢复**：新主控会话 12:44 CST 接手。误建的新 worktree（`.claude/worktrees/heroui-migration`，BASE 2306caaa）已核验为空并删除；本 worktree 为唯一执行区，BASE `203d0f0244b2` 不变。恢复依据：本 Ledger + h01–h03 全部产物 + `h04/BRIEF.md`（12:29 备好未派发）。
- **OCR 状态核实**：3 个历史会话（10:31 全灭 429 / 11:03 103 失败 / 12:03 中止于 15 文件）。中止会话已有发现：**1 high**（styles.css 删除全局 `border-border` 基线，112 文件裸 border 回退 currentColor——主控已对照 BASE 证实删除属实、三个样式文件无替代）、1 medium（theme.ts setRootTheme 无测试覆盖）、证据脚本可移植性 medium/low。12:47 已重启 OCR（concurrency 3，/tmp/ocr-review4.log）。
- **H04 放行决策**：依据 H03 复审结论「H04–H15 可放行（条件=M1 已修+接口冻结维持）」，在 OCR 补跑期间放行 H04 实现派发（文件集与 OCR 修复轮不重叠）。若本轮 OCR 或复审发现 critical/high，按流程进修复循环——接口冻结不变。
- **并行派发**：(A) OCR-fix-r1：styles.css 边框基线恢复（@layer base）+ theme-preference 补 setRootTheme/boot 断言 + 证据脚本可移植性（env/__dirname/包名 require；不动 package.json/lockfile——puppeteer-core 声明记为 H14 Interface 变更申请）。(B) H04 implementer 按 h04/BRIEF.md 执行。
- **429 事件与处置（12:52–12:58）**：发现两个 OCR 进程并发（12:45 `--format json` 来源不明——疑似上一会话残留；12:47 本会话 concurrency 3），与两个实现 Agent 共用同一 GLM 账户触发 429（`ocr llm test` 实测限流；H04 agent 一次 API 429 早退）。处置：杀掉全部 OCR 进程让配额给实现 Agent；`ocr llm test` 复测通过；H04 agent 已恢复继续。**OCR 策略调整：实现波次进行中不再并行跑 OCR；改在各实现轮完成、配额空闲后单独串行执行（concurrency ≤2）**。bf320157 会话（12:47:39 aborted/0 files）作废。
- **fix-round-1 完成（13:10）**：① styles.css:230-244 恢复 `@layer base { * { @apply border-border outline-ring/60 } }`（build 产物证实编译进 base 层）——OCR high 关闭；② theme-preference.test.ts 补 setRootTheme 双极性 + index.html boot dataset.theme 断言（突变法证 RED 后还原，lib/theme.ts 终态零改动）——OCR medium 关闭；③ 11 个证据脚本可移植性（CHROME_PATH/PLAYWRIGHT_CHROMIUM/__dirname/包名 require，node --check 全过）。验证：typecheck 0、native 8/8、build 0、biome 编辑行 0（5 条 harness 脚本 pre-existing 留 H14 lint 清扫，明细 ocr/fix-round-1.md）。H14 Interface 申请：puppeteer-core 声明（已入 BACKLOG-H14-H15.md）。复审方式：并入最终 OCR workspace 复审轮。
- **H05 派发（13:11）**：fix-round-1 释放配额，H05 implementer 与 H04 并行（文件集不重叠：admin 域 vs settings 域）。
- **H05 完成（13:27）**：核验+修正轮（域内四路由+model-billing-paths 在 BASE 已消费 HeroUI 化 ui/*）。改动 4 文件：credentials.tsx+bot-services.tsx 移除 2 处 Select `as` 强转（onValueChange null 落空=AC3 修正）；gateway/model-catalog 仅 biome 格式化。验证：typecheck 0（一次 exit 2 系并行 H04 的 h04-* 草稿文件在途，与本域零重叠）、build 0、域 native 3/3、driven 8/8+6/6（admin-catalog-sync-ui/admin-gateway-readiness/router.test）、biome 0、checkpoint 校验 0。全 app native 13 fail 全部域外既有（8 zz-probe + 4 H02 域 + 1 h04-probe）。AC1–AC4 组件级 PASS。遗留：浏览器级证据归 validator；server bootstrap-local-gateway 2 个 TS 错误 pre-existing 已记录。独立复审并入 H04 完成后的批量 reviewer 轮（fix-r1 + H05 + H04）。
- **H04 完成（13:47）**：根因修复轮。① preload.ts：react-dom/client 预热移到首次 GlobalRegistrator.register() 之前（bisect 证明：register 后求值的 react-dom 捕获死 window 的 setTimeout，杀掉全部定时器/微任务重渲染——此前 user-preferences/devices-settings/update-routing-settings 的 DOM 冻结即此因）；② 3 个测试文件 getByRole("combobox")→button+可访问名（HeroUI Select.Trigger 不转发 role=combobox，结构依赖成立）；③ shared-approval-fields.tsx 原生 checkbox→ui/checkbox；audience 单选组保留原生。验证：域 native 16 文件/53 测试 0、linked-accounts 31/31、driven 域 0、H03 回归 30/30、build 0；typecheck exit 2 仅因并行 H06 草稿文件（非本域）。Interface 申请：select trigger role→H15 a11y 裁决；ui/radio-group 缺口→主控裁决（若仅 H04 用原生单选则记明确保留）；preload.ts 顺序→并入批量复审核查。OAuth/敏感值/记忆行为合同未动。
- **批量复审 W3A 派发（13:48）**：只读 reviewer 覆盖 fix-round-1 + H05 + H04 三交付（Spec compliance + code quality 双结论）。**H08 同步派发**。
- **H08 完成（14:00）**：核验+修正轮。billing 红区（billing-credits-ui 18/18 + personal-credits-ui 8/8）已被 H04 preload 修复顺带解决——归因记录：红因=preload 顺序 bug 而非域内缺陷。域内改动仅 billing.tsx+usage.tsx 格式化（零行为）；5 文件 token 改名系前波已有。验证：typecheck 0、build 0、域 native 46 测试 0、driven admin-credit-grant-ui 7/7、biome 仅 upgrade-dialog.tsx 2 条 BASE 既有诊断（污染轮询逻辑，改则违 AC5 红线，转 H14）。剩余全量 native 红 11（8 zz-probe + heroui-spike/gallery/approval-team 3，均 brief 列明域外）。AC1–AC5 组件级 PASS。Payer/金额精度/状态区分/QR/Recharts 合同零 diff。
- **429 二次事件（13:43）**：H06 收尾阶段被打断（多 Agent 并发峰值）；13:45 配额恢复，H06 已恢复收尾。运行中：W3A reviewer + H06。
- **W3A 复审完成（14:20，reviews/REVIEW-W3A-2026-10-20.md）**：fix-round-1 Spec PASS/质量好（baseline 与 BASE 字节一致且在 @layer base 内）；H05 Spec PASS/质量好（null 守卫为真修复，格式化-only 经空白剥离比对证实，checkpoint 4/4 哈希吻合）；H04 Spec PASS/质量好（preload 修复经包级根因证实：react-dom 求值期捕获 scheduleTimeout + react-aria filterDOMProps 无 role 白名单；选择器替换等强或更强；OAuth/敏感值/无 any 全净；reviewer 独立复跑 native 6/6 + driven 20/20 + typecheck 0）。发现 0C/0H/1M/6L。F1（medium，h05 REPORT typecheck 声明与日志矛盾）已修正（含 F2 计数、F6 行号）；F3/F4/F5/F7 入 BACKLOG。**H04 域门禁开启：H07 可放行**（待 H06 完成+复审后一起派发，二者都是 H07 前置）。radio-group 裁决：仅 H04 一处原生单选，记明确保留，不建 ui/radio-group。
- **H06 完成（14:40）**：10 文件——5 处 Select as 强转移除（null 守卫）；admin/learning + knowledge.$kbId 原生控件迁移 ui/*；4 测试适配（RAC input 吞 user.clear 合成事件=需真键击；role=combobox 丢弃同 H04 记录）。bots-nav-badge 归因=preload harness 问题（已修，4/4 绿）。**4 个 driven 既有红经纯净 BASE worktree 对照定因为迁移引入**（bot-setup ×2、composing-enter、bot-responsibilities）并以测试驱动适配修复；learning-admin 1 红系本域 select 迁移引入已修。H07 交接：bot-sharing.test.tsx 1 红（BASE 绿，sharing.tsx 归 H07）。验证：typecheck 0、build 0、biome 0、域 native 78/78、driven 13 文件 71/71、全量 native 11 红全域外。Bot 详情壳契约（BotSubpage/BotProfile 导出、三态+返回语义、冻结约束）见 h06/REPORT.md。**H12/H13 即时放行；H07 待 W3B 复审（H06 需复审通过）**。
- **H09 完成（15:05）**：纯核验轮——域内组件零改动（已消费冻结 ui/*；4 文件前波 ButtonLink/token 改名核验保留）。唯一修复：multitenancy/selection.test.tsx 21 处 trigger 查询适配（role=combobox 丢弃，同 H04 模式），17/8 fail→25/25。合同字节级验证：守卫/深链/热键/侧栏偏好/DetailPanel 非模态/根级 drop 保护（root-drop-guard 3/3）。typecheck 0、build 0、点名测试全绿（theme 8/sidebar 4/shortcut 3/sign-in 6/selection 25 等）、biome 0、checkpoint 0。遗留：Drawer/320px/200% 浏览器证据→H15。**W3B 复审即时派发（H06+H08+H09），通过即放行 H07+H10**。
- **H12 完成（15:25）**：核验+修正轮，6 文件——run-detail/runs-list 的 Button render Link→ButtonLink（真实 anchor）；computers.tsx bg-muted→bg-ob-muted-surface/40；route-chain.test.tsx substantive 修复（无 context 建路由致 requireBotObservabilityAccess 崩 5 深链测试，纯净 BASE worktree 定因=守卫 bce0bce7 后测试未跟进的既有问题；测试侧修复=production-shaped context+seeded cache，链路过真实 beforeLoad）。验证：typecheck 0、build 0、域 native 0 红、driven 228/228、biome 0、checkpoint 6/6。__probe-h08 COLLECTION_ERROR 已消（清单修复生效）。域内 0 Select/Recharts/表格，lib/ai-observability 零 diff。
- **W3B 复审完成（15:40，reviews/REVIEW-W3B-2026-10-20.md）**：H06/H08/H09 全部 Spec PASS / 质量好。0C/0H/0M/5L（全为报告引用/计数小项：/tmp 证据路径、1+5≠3+3、行号引用、20≠21、未列明背景改动——批量归 H14 文档清扫）。关键核验：22 个 checkpoint 哈希全吻合、H04/H05 冻结面仍吻合、HEAD 未动；H06 null 守卫/迁移等价性/测试适配正当性/纯净 BASE 定因法均证实；H08 格式化-only 与 billing 复跑 26/26 证实；H09 守卫/auth 字节级一致、selection 25/25。三份全量 native 报告呈同一账：994/983 pass/11 fail（zz-probe 8 + approval-team-settings + gallery-components + heroui-spike）。**门禁：H06→H07 OPEN；H09→H10 OPEN。**
- **H07 + H10 已派发（15:42）**，与 H13 并行（三实现者）。
- **429 第三次（15:55）**：H13 biome 清理阶段被打断；16:00 配额恢复并续跑。三实现者并发为当前安全上限，后续派发维持 ≤3。
- **H13 完成（16:20）**：3 文件——gallery/form.tsx 原生 select→ui/Select（领域值 key 往返、无 String()/any、null 守卫、label htmlFor+id、error-focus getElementById）；decisions.tsx input→ui/Input；gallery-components 测试修复（RAC 受控值复活→Backspace 键击链，同 H06 根因族）。**F3 结论（重要，纠正 W3A stale 信息）**：heroui-spike 两层均无排除条目、原生运行 12/15；TextArea import-order 理论被驳——真因=RAC 合成 change 吞噬（H06 族）；其 3 红（TextArea+2 raw-Modal ESC）属 H02/H01 域，H13 未动（文件只读）。全量 native 131 文件/1002 测试=999 pass/3 fail（域外：zz-probe[H10 修]、h10 草稿探针、heroui-spike TextArea）。gallery-components 8/8。driven 4/4、typecheck/build/biome 0。generative-ui.ts 零改动（调色板比对证明 BASE==HEAD；pre-BASE 漂移记后续项）。新 harness 项：18 行 act-environment stderr（BASE 0）→ H14/H15。**W3C 复审派发（H12+H13）**。
- **H07 完成（16:55）**：6 文件——bot-sharing（H06 交接）+ approval-team-settings（账面红）+ 新浮现 approvals-rules ×6/bot-approval-rules ×4 全部角色适配修复（同 H04 模式，FieldLabel↔SelectTrigger id 保可访问名）；rules.tsx 残余 `next as T` 移除。域扫描：18/20 源文件与 BASE 字节一致、0 残留。纯净 BASE 定因：5 受影响测试文件 27/27 绿→红均迁移引入（测试侧）。验证：typecheck 0（末次 2 仅 H10 在途草稿）、build 0、域 native 62/62、driven 全绿（selection 25/25、shared-grant 3/3、fixed-trio 22/22）、全量 1006/1003 pass/3 fail（域外 H10 ×2 + heroui-spike ×1）。biome 9 条均 BASE 既有。**heroui-spike TextArea 红归属裁定：H02/H01 域、根因=RAC 合成事件吞噬（测试侧，H06 族）→ 转入 H14 处置清单**（若证实为 ui/textarea 真回归则升级 Interface 变更）。
- **W3C 复审完成（17:15，reviews/REVIEW-W3C-2026-10-20.md）**：H12 Spec PASS/质量好（ButtonLink 真锚点、route-chain 修复经深查=production-shaped 接线+真实 beforeLoad 守卫、无旁路）；H13 Spec PASS（F1 修正后）/质量好（零 String()/any、key 往返无损、forHtml↔id 真实、焦点落在可聚焦 RAC trigger）。发现 0C/0H/1M/2L：F1（h13 REPORT 两处 exit 0 与 report.json exitCode 1 矛盾）**已修正**；F2（heroui-spike 红数隔离条件性 14/1 vs 12/15）入 BACKLOG；F3 nit。独立复跑：driven 49/49、native gallery 8/8、driven component-preview 4/4。**门禁：H12→H14 OPEN；H13→H14 OPEN（F1 已修）。全部 40 个 checkpoint 哈希复核吻合、HEAD 未动、冻结面净。**
- **W4 复审派发（17:16）**：H07 独立复审（H10 仍在实现中）。
- **W4 复审完成（17:40，reviews/REVIEW-W4-2026-10-20.md）**：H07 Spec PASS/质量好（0C/0H/5L：BASE 27/27 运行无落盘产物、两处措辞/引用小项等——carry 入 H14）。四测试文件适配模式合规（等强或更强、可访问名不变）；rules.tsx 零行为变化（BASE 已有 null 守卫）；18/20 字节一致复现；权限红线构造性成立；biome 9/9 BASE 既有复现。reviewer 独立复跑两层全部计数吻合（12 native + 10 driven 文件 0 失败）；bot-sharing H06 交接红确认关闭。**门禁：H07→H14 OPEN。**
- 复审通过榜（9/9）：fix-r1、H04、H05、H06、H07、H08、H09、H12、H13——累计 0 critical / 0 high。待办实现：H10（进行中）→ H11 → H14 → H15。
- **H10 完成（18:35）**：3 文件——① zz-probe 8 红修复，定因双层非产品回归：native 层 `screen` 模块期绑定（document 不存在即抛）+ happy-dom 下 RAC popover 退场不完备（data-exiting 卡滞，raw HeroUI Dropdown 对照复现）；断言重定向至「close 恰好请求一次」合同并引 CDP 证明；探针 8/8，ui/context-menu 零改动、诊断字节回退、0 Interface 申请；② demonstration-recorder 2 原生 select→ui/select（H05/H06 null 守卫模式）；③ 新 CDP `h10/browser/cdp-context-menu.mjs` 7/7（指针定位/单次动作/卸载/ESC+焦点返还/Shift+F10/键盘激活）。新 H15 项：popover wrapper 上 ArrowDown 需焦点先入菜单。bubble.tsx 遗留项证实已被前波 token 清扫关闭。验证：typecheck×3 0、build 0、全量 native 993/994（唯一红=heroui-spike TextArea，spike 测试侧→H14）、driven 87 文件 0、live-screen-mouse 5/5、update-routing 复跑绿、biome clean、CDP 0。AC1–AC6 全 PASS。**H11 + H10 复审（W5）并行派发**。
- **W5 复审完成（19:10，reviews/REVIEW-W5-2026-10-20.md）**：H10 Spec PASS/质量好（1M+8L，0C/0H）。zz-probe 双层根因经包源码+trace 证实；重定向断言守真合同非同义反复；**CDP 脚本被 reviewer 独立重跑 7/7 字节一致**——真浏览器卸载/ESC 焦点返还/Shift+F10/键盘激活在生产 adapter 上成立。F4（medium）：demonstration-recorder 丢失 BASE 空选项重选行为→**即时修复轮派发**。F5 BACKLOG 已回填；F6 TextArea 归属裁定 H14；F1/F2/F9 归 H14 文档清扫。46 个前波 checkpoint 复核吻合。**门禁：H10→H14 OPEN（待 H11 + F4 修复）**。
- **H11 完成（19:55）**：4 文件——workshop-share 2 原生 select→ui/Select（scope 字符串联合 + days 数字键 7/30/0 精确往返，删原生 Number() stringify）；workshop-schedules 1 处 as 强转移除；scheduled-task-editor 3 处强转+原生 checkbox→ui/Checkbox（id 挂 inputRef 保 sibling label htmlFor）；session-sidebar 内联 rename input→ui/Input。保留项有据：preview-tab 零 diff（放大=wrapper 重定位非 portal；iframe 单帧/key/sandbox/ticket 合同字节一致）；craft composer textarea+隐藏 file input 属 PromptArea 引擎族；75 处 raw-button 规范不动。验证：typecheck 0、build 0、域 native 改前 80/80+改后 80/80、driven 0、全量 993/994（唯一红=heroui-spike→H14）、biome clean、零测试适配。**业务波次 H04–H13 全部实现完毕；W6 复审（H11）派发**。
- **W6 复审完成（20:30，reviews/REVIEW-W6-2026-10-20.md）**：H11 Spec PASS/质量好（0C/0H/0M/5L 措辞/引用小项）。包级核验：days 数字键往返无 stringify、BASE 服务端负载字节一致、0=永久保留为真实选项（**H10 F4 失败模式确认不复发**）；checkbox id-rides-inputRef 链在 RAC dist 证实（外层 htmlFor 触达真实控件）；preview-tab 本轮零 delta（前波 3 个 token hunk 除外，iframe 合同行逐字）。reviewer 复跑：native 80/80、driven 2/2、typecheck 0、biome 0；checkpoint 4/4 + 前波 49/49。**门禁：H11→H14 OPEN——H04–H13 全部 PASS（10/10 业务波次+fix-r1）**。待 F4-fix 落地核验后 H14 启动。
- **F4 修复完成（21:00，ocr/fix-round-2-f4.md）**：空选项按 BASE 字面 `ONLY_CONVERSATION=""` 恢复为真实 SelectItem；value 直传无 `||null` 强转；null 守卫仅司 dismissal；items 记录按 W3B 验证约定补（trigger 显示 channel 名）。TDD 双 RED（缺项断言+文本断言）→5/5 绿。新哈希：component 1c409071…、test 3456ec13…（h10/POST-CHECKPOINT 待 H14 更新）。Harness 发现：native 层 @tanstack/router-core 模块期读 NODE_ENV（node condition）致 RouterProvider 崩——本套件以 beforeAll 设 NODE_ENV=test 保持 native（文档化于测试+报告）；该签名即 e2e-bun-suites.json:1131 路由其他 router 套件到 driven 的原因。**H14 启动**。
- **5 小时用量上限事件（15:53）**：H14 在最终验证阶段（driven 6/6 组绿后）被 1308 用量上限打断（重置点 19:24 CST）。16:13 配额恢复，H14 已从全量 native 续跑。注：本 Ledger 各条目时间为近似值（相对顺序为准）。
- **H14 完成**：① `@base-ui/react` 移除（lockfile diff 恰 3 条目：本体+utils+scoped reselect，零漂移）；前置清理=preload.ts 的 @base-ui 预热块 + spike legacy fixtures。② 保留项附 grep 证据：shadcn（tailwind.css 出口仍喂 styles.css:63——**"H02 已删"前提被证伪，BASE→现在从未删除**）、tw-animate-css、cva、@shadcn/react、legacy-ui-bridge（629+ 别名消费者，冲突名残留 0）。③ heroui-spike TextArea 测试侧修复（真键击模式；隔离 13/15，余 2=隔离条件性 Modal ESC 全量绿）。④ 新根因修复：preload.ts 全局 NODE_ENV=test——消除 button-native 静态导入 @tanstack/react-router 的模块期竞态（全量 5 红→0）。⑤ **全量 native exit 0：130 文件/995 测试/995 pass/0 失败**；driven 6/6 组绿（前缀覆盖先核验）；test:ci exit 1=194 红全 server 域/环境（ECONNREFUSED/CreditGate/Unmeterable，21 处签名）+2 repo 基建 meta，**app 贡献 0**。⑥ gzip：sign JS 476,457（+10.58%，超预算 2,523B，入口 HeroUI/RAC 运行时，评审结论已录）、chat JS +1.41%、CSS 61,184（+22.6%=H02 裁定 6,824+H03–H13 组件 CSS 4,454）。⑦ coverage.md：88 路由对账 88、27 ui 模块（含 router-link 新增）。⑧ BACKLOG 处置表 ~40 项（H02 五 low 中 3 项修复含 switch 镜像/暗色 OFF 轨道/冗余声明；W3A–W6 文档项全修/回填；44/44 h07 driven 复证）。⑨ h10 checkpoint 哈希链更新（e6ff33a5=3456ec13+注释变更，已文档化）。**W7 复审（H14）派发——通过即进 H15 终验收。**
- **W7 复审完成（reviews/REVIEW-W7-2026-10-20.md）**：H14 Spec PASS（附条件）/质量好（0C/0H/1M/5L）。lockfile 手术独立复算=恰 3 条目零漂移；shadcn 保留裁定：styles.css:63 import 在 BASE:3 原样存在（"H02 已删"前提证伪），预设**零未分层 :root token**——保留获背书；NODE_ENV 修复经包源证实、爆炸半径净；**全量 native 995/995 EXIT 0 + driven 6/6 由 reviewer 独立复跑**；test:ci 194 红归因经产物核验（app 0）。**gzip ACCEPT**：三数字逐字节复算（476,457/1,184,734/61,184），+10.58% sign-JS=入口 HeroUI/RAC 共享运行时 2,523B 一次性结构成本（route-sign 本体 +28B；chat 自 H02 反而 −15,721），manualChunks 缓解记 H15。F1（medium）**已修**：h04/h08 检查点刷新批注（新哈希入档，原始行保留）；F6 AC2 措辞批准归 H15。biome 余噪（context-menu 4/button-native 2/approvals 9）先记账。**门禁：H14→H15 OPEN。H15 终验收派发。**
- **授权变更（用户指示，17:40）**：**不再使用 OCR 进行扫描**——最终 OCR 轮取消。背景：OCR 三次全灭/中止（429 限流 + 5 小时用量上限 ×2），已取得的部分发现（1 high 边框基线 + 1 medium 主题测试覆盖 + 脚本可移植性）已由 fix-round-1 修复并经 W3A 复审关闭。终局验收依据调整为：W3A–W7 七轮独立复审（全 PASS）+ H15 终验收 + 分层测试对账；OCR 章节以「部分发现已修复、全量轮经用户指示取消」收口。
- **429 用量上限第四次（17:32）**：H15 validator 在真实 app 暗色主题测试阶段被打断（dev 栈已拉起——env bring-up 成功）；重置点 21:12。恢复续跑。
- **H15 完成 + 终收口**：A01–A10 全 PASS（42 截图全矩阵、IME CDP、三裁决：AC2 批准/manualChunks 不建议/role=combobox 接受）；环境级修复零 repo 改动；阻塞项均有补偿证据。**终态检查点 bc6ca3d9…（142 文件）经主控复验 142/142 OK**。DELIVERY-REPORT.md 落盘。OCR 终轮按用户指示取消（部分发现已由 fix-r1 修复）。全部 15 个子 Issue 与父 Issue #443 满足关闭条件（W3A–W7 复审全 PASS + A01–A10 + 检查点链），执行关闭。迁移交付完成。

## 2026-10-20（视觉重设计波次 R——用户决策）

- **用户决策（确认预览 v2 三项）**：①主操作色=HeroUI 蓝 accent oklch(0.6204 0.195 253.83)；②品牌青绿跟随 accent 统一；③根字号 16px + HeroUI 原生舒展密度。圆角 0.5rem、暗色换 HeroUI 阶梯、图表 5 色重做对比度。视觉基线从 WorkBuddy 保留切换为 HeroUI 原生（预览即视觉稿：/tmp/raw-heroui-preview2 + orca 内嵌页）。
- 实施方式（利用迁移后架构）：改 `styles/tokens.css`（--ob-* 全组重映射至 @heroui/styles themes/default 真实值）+ `styles.css`（html 15→16px）+ `heroui-theme.css` 收敛（与默认重复的覆盖删除、纯 WorkBuddy 视觉覆盖退役、结构必要的保留）+ 图表色复算 + DESIGN.md/spec 修订注记。业务组件零改动。
- 检查点：迁移终态 bc6ca3d9… 仍是已交付基线；R 波次自带 POST-CHECKPOINT，完成后重算新终态。
- **R1 完成（#502 实现轮）**：7 文件——tokens.css 全组重映射（ground truth=本机 variables.css；青绿退役、action/brand/focus/chart-1=accent 蓝、radius 0.5rem、HeroUI 阴影）；styles.css 根 16px；heroui-theme.css 桥收敛 179→~40 行（**28 删/0 留**：复现默认的删、WorkBuddy 专属视觉退役、结构覆盖留空层）；DESIGN.md+spec §11 修订注记。组件/路由/测试零改动。验证：typecheck/build/biome 0；spike 2 红=文档化既有隔离项；**浏览器 QA 26/26 PASS**（accent/canvas/border/radius 双主题 computed 证实、青绿与黑主色零残留）；对比度实测：body 16.25/19.79、snow-on-accent 3.59（<4.5，库默认权衡已记录不改 accent）、accent-on-white 3.68/暗 4.81、图表 5 色 ≥3:1 双底。遗留→R1b 即时修复：--input 透明化使 21 处 border-input 描边丢失（别名拆分：legacy --input 指 border 发丝线，HeroUI 字段保持无边框）。暗色 switch OFF 白色拇指=原生形态接受。
- **R1b 完成**：--input 别名拆分（legacy 指向 border 发丝线阶梯，HeroUI 字段链保持 transparent+0 宽）；21 调用点/15 文件全数分类为真实描边语义（含暗色 bg-input/30 系染色同步恢复）；验证 typecheck/build/biome 0 + **浏览器 20/20 PASS**（select trigger/outline button/Input/问卷选择卡与指示环双主题断言）；4 截图 + cdp-r1b.mjs 归档；checkpoint 注记式更新（8 新哈希验通，3 行陈旧按 W7-F1 模式批注）。**R 波次独立复审派发（R1+R1b 一体）。**
- **R 复审通过 + 收口**：Spec/Quality/Verification 三 PASS（REVIEW-R-2026-10-20.md）。30+ token 值与 ground truth 逐点吻合；13/13 对比度独立复算一致；桥收敛 39 行全结构必要；R1b 20/20 由 reviewer 现场复跑；泄漏检查：迁移终态 138/142，差异=R 的 4 个样式文件（零越界）。3 low（DESIGN.md scrim/input 行陈旧、侧栏暗色措辞）已按复审建议做收口修订（DESIGN.md 3 处 + tokens.css 注释 1 处）。INFO-4（styles.css:158 陈旧阴影注释）留下次触碰 styles 时清；INFO-5（CopilotKit dev toast）为环境项已由复审定因。
- **R 终态检查点**：`50517fd83dc1f4f960f12d3a138128a6c4b1bb2c5517780ca1a8c4de55a9f1f1`（143 文件=原 142 源码面配方 + app/DESIGN.md；`h15/TERMINAL-CHECKPOINT-R.{sha256,files.txt}`）。迁移基线 bc6ca3d9… 保留为 R 前历史锚点。#502 关闭。
