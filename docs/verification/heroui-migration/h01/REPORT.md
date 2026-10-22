# H01 (#444) — 迁移基线与关键交互兼容验证

状态：implemented / 证据已汇编；最终检查点指纹待 H03 收口后随受影响文件统一重算。
工作区：`.worktrees/heroui-migration`，BASE `203d0f0244b2f898218fa12027089c631e8448d9`，全部未提交。

## 基线（迁移前实测）

- `bun run typecheck` / `build`：EXIT 0（日志见 H02 报告同期产物）。
- native 层：128 files / 967 tests pass（H02 波次后为 982/985，失败归因见 H02 REPORT）。
- bundle（同环境 gzip）：登录 JS 430,849 / 聊天 JS 1,168,268 / 总 CSS 49,906。

## AC 对照（依据 h01.md）

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC1 迁移基线核验 | **达成**（本文件补齐后） | `inventory-routes.md`（88 路由逐文件归属 + @base-ui/@heroui 清单）、`contract-matrix.md`（24 公共 UI 处置×波次×实测底座）、15 个 base-ui 文件清单（执行计划 §2）、Spec §2.2 处置表 |
| AC2 依赖版本核验 | **达成** | `app/package.json` 精确固定 `@heroui/react@3.2.6`、`@heroui/styles@3.2.6`；bun.lock；React≥19/Tailwind≥4 peer |
| AC3 关键交互兼容 | **达成（含收口）** | `browser/RUN-2026-10-19.md`（修复轮+收口轮）：token 同页、数值 ID 303 往返、TanStack Link 真 anchor/meta/路由、ESC 七场景矩阵、嵌套 F1；Scroller End 键到底（`browser/cdp-harness/run-2026-10-19-ac-reach.log`） |
| AC4 指针/键盘浮层交互 | **部分 → 已补主路径** | 右键/Shift+F10/焦点恢复：spike fixture 存在，context-menu pointer 截图 `h01/spike/browser/context-menu-pointer.png`；**ContextMenu 物理键与触摸长按在 headless CDP harness 不触发**（环境限制，`run-2026-10-19-ac-reach.log` 如实记录），转 H15 in-app browser 复核 |
| AC5 主题/性能/视口 | **部分** | 亮/暗 spike 截图（spike-light/dark.png）；CSS/JS gzip 基线与 H02 后对比见 H02 REPORT；**light+zh 组合与 200% 缩放/reduced-motion 留 H15 真实 app 页**（spike 无 i18n 面，如实声明） |

## 缺陷与修复轨迹

- Critical ESC 级联（RAC Modal 与 portalled Select popover 同一 ESC 双关）→ 守卫三轮迭代，
  终态见 `RUN-2026-10-19.md` 修复轮+收口轮与 `browser/cdp-harness/`（脚本+README+原始输出）。
  守卫 v3 当前形态：活弹层=任务域 burst 标记；垂死弹层=最内层受控 Dialog 代偿关闭（`openDialogs`
  栈）；活弹层判定含 listbox/menu/grid/tree。
- 旧 token 读数（21:07 results.json）与 RUN 结论矛盾 → 已标 SUPERSEDED
  （`h01/spike/browser/results-SUPERSEDED.md`），不作现行证据。

## 独立审查

- 只读审查结论：Spec compliance **pass（有保留）**、code quality **pass**（2026-10-19，全文转录于 LEDGER）。
- High（脚本/输出仅存 /tmp）已闭；Medium 产物缺口（AC1 清单、契约矩阵、SUPERSEDED 标注）本轮补齐；
  余项按上表转 H15。

## 下游 Interface（H02/H03 消费）

- spike 基建：`app/spike.html` + `vite.spike.config.ts`（端口 5199，与生产 build 隔离）。
- CDP 可信输入 harness：`browser/cdp-harness/`（复现配方在 README）。
- 迁移基线数字与 bundle 门槛记录于 H02 REPORT 性能表。

## 遗留（转 H15）

1. light+zh、200% 缩放、reduced-motion 浏览器证据（真实 app 页）。
2. ContextMenu 物理键、触摸/长按（in-app browser 复核）。
3. Questionnaire 程序化点击在 headless harness 不触发 change（引擎单测覆盖逻辑层；浏览器侧留 H15）。
4. 最终检查点指纹（等 H03 收口后统一重算，绑定终态 diff）。
