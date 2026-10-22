# H02 (#445) — HeroUI 基础控件、主题与表单行为

状态：implemented；验证见下（含 2 个独立复跑通过的共享进程隔离失败；1 个在未改动基线上同样失败的既有环境问题）。
检查点：workspace 增量（无 commit），BASE `203d0f0244b2f898218fa12027089c631e8448d9`。

## 变更

- 依赖：`@heroui/react@3.2.6`、`@heroui/styles@3.2.6`（app/package.json + 根 bun.lock）。
- 主题：`app/src/styles.css` 固定 layer 顺序（tailwind → HeroUI → ob-tokens → ob-theme → ob-legacy → ob-app），新增 `styles/tokens.css`、`styles/heroui-theme.css`、`styles/legacy-ui-bridge.css`。`--accent`/`--muted` 的语义冲突按 OpenBot 语义拆分（accent/muted 归 HeroUI；旧 hover 面改为 `--ob-*`）。
- 主题状态：`openbot-theme` 单一来源；`.dark` 与 `[data-theme="dark"]`、`color-scheme` 由同一状态同步，首屏脚本同步修改。
- 基础控件改为 HeroUI：button、checkbox、switch、input、textarea、label、separator、skeleton、item、field、input-group、empty。
- 链接按钮：新增 `components/ui/router-link.tsx`（`ButtonLink`，TanStack Link/原生 anchor + `buttonVariants`，无嵌套 button/a）。
- Button 兼容层：`disabled`→`isDisabled`；`render` 函数形式透传，元素形式做确定性 props 合并；`nativeButton` 接受并忽略。
- 测试基础设施：`app/tests/preload.ts` 预热 react-aria 与 React DOM，修复 RAC overlay 在 happy-dom 中的退出/调度（见文件内注释）。

## 验证

| 项 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck | `bun run --cwd app typecheck` | **EXIT 0** | `h02/verify/typecheck.log` |
| build | `bun run --cwd app build` | **EXIT 0**, 51.8s | `h02/verify/build.log` |
| native app tier | `E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts` | 982 pass / 3 fail（见归因） | `h02/verify/native-final.log` |
| 单文件复跑 | heroui-spike / gallery-components | 15/15、8/8 **pass** | `h02/isolated/*` |
| 既有测试 | button-native / theme-preference / bot-manage / update-routing | pass | `h02/along*/`、`h02/verify/*` |

### 失败归因（不当作迁移通过，也不当作迁移引入）

1. `heroui-spike` TextArea、`gallery-components` form 在整轮共享进程中失败，**单文件复跑通过**。ADR 0008：共享进程失败单独复跑通过不算套件结论；已记录为 harness 隔离问题。
2. `live-screen-mouse` wheel 用例单独失败；在**未改动基线** `/Users/wuyongjun/trea/OpenBot`（无 HeroUI 改动）执行同一命令同样失败 → 既有环境/runner 问题，非本次迁移引入。证据：`h02/verify/native-final.log` + 基线复跑输出（本会话记录）。
3. `update-routing-configured` 曾在未改动基线上同样失败；H02 的 Switch 属性镜像与 aria-label 修复后，工作区版本通过。

## 性能（同环境 gzip）

| 指标 | 基线 | H02 | Δ | 门槛 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| 登录初始 JS | 430,849 | 458,742 | +27,893 (+6.5%) | +43,085 | 通过 |
| 聊天初始 JS | 1,168,268 | 1,200,455 | +32,187 (+2.8%) | +116,827 | 通过 |
| 总 CSS | 49,906 | 56,730 | +6,824 (+13.7%) | +4,991 | **超 10%** |

CSS 评审结论：增量有明确来源（HeroUI base/theme/utilities/variants + 已迁移 8 个组件的独立 CSS）；若整包导入会多约 +37KB gzip，因此采用逐组件导入已是最小化路径。绝对增量 +6.8KB，未发现无用组件 CSS；H14/H15 再按实际迁移面复核，必要时裁剪 base/variants。此结论需独立 reviewer 复核。

## 下游 Interface（H03 消费）

- `Button`：`disabled`/`render`（元素或函数）/`nativeButton` 均可；`ButtonLink` 用于路由链接。
- `Input`/`Textarea`：原生 DOM props（含 `disabled`）直通；一次 change 一次更新。
- `Checkbox`/`Switch`：`checked`/`onCheckedChange`/`disabled`/`indeterminate`；Switch 将 `aria-checked`/`data-checked`/`data-disabled`/`aria-label` 镜像到 `role="switch"` input。
- `Label`/`Field`：`htmlFor`、错误 id 与 `aria-describedby` 保持。
- `Item`：`render` 元素/函数两种形式保留；data-slot 显式输出。

## 遗留

- 整轮 native tier 的 2 个共享进程隔离失败与 1 个既有环境失败，需在 H15 用隔离复跑/基线对比呈报。
- 无提交；回退点 = BASE 或本检查点前快照。
