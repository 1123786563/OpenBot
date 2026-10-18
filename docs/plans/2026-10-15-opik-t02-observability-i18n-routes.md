# Opik T02 交接说明：观测 UI i18n 子命名空间与路由约定

Ticket：[#8 [Opik T02] 观测 UI 独立 i18n 子命名空间与路由约定](https://github.com/1123786563/OpenBot/issues/8)
父 Spec：[#4 Opik 自托管集成](https://github.com/1123786563/OpenBot/issues/4)（`docs/specs/2026-10-14-opik-integration-design.md`）
日期：2026-10-15

## i18n 命名空间归属矩阵

四条观测前端链各写各的双语命名空间文件，`obs-` 前缀是归属标记：观测链只写 `obs-*` 文件，任何非 `obs-` 的语言文件（包括既有共享的 `admin.json`、`agents.json` 等）都不属于观测链，需要跨链复用文案时只读不写。

| 前端链 | 命名空间 | en 文件 | zh-CN 文件 | 后续接手的 Ticket |
| --- | --- | --- | --- | --- |
| 运行（列表 / 详情 / 步骤树） | `obs-runs` | `app/src/locales/en/obs-runs.json` | `app/src/locales/zh-CN/obs-runs.json` | T12、T13、T18 |
| 评测集（审查 / 保存 / 版本） | `obs-datasets` | `app/src/locales/en/obs-datasets.json` | `app/src/locales/zh-CN/obs-datasets.json` | T21（案例审查接口 T20 的界面文案也在此） |
| 实验（提交 / 逐样本 / 对比） | `obs-evaluations` | `app/src/locales/en/obs-evaluations.json` | `app/src/locales/zh-CN/obs-evaluations.json` | T30、T31 |
| 管理（汇总 / 采集健康 / 未绑定 / 导出状态） | `obs-admin` | `app/src/locales/en/obs-admin.json` | `app/src/locales/zh-CN/obs-admin.json` | T33、T36 |

Key 约定：

- 每个命名空间顶层有 `title`（页面/链标题）与 `states`（八类状态）。
- 八类状态 key 固定为：`disabled`（配置未开启）、`empty`（无数据）、`forbidden`（无权访问）、`basic`（basic 能力等级，非服务缺失）、`omitted`（脱敏省略）、`truncated`（超长截断）、`syncing`（数据同步中）、`unavailable`（服务不可达）。语义不得互相混用——unavailable 不等于 empty，basic 不等于 unavailable。
- 每个状态含 `title` 与 `description`；en 是 key 的权威源，zh-CN 必须逐键对齐（`app/tests/observability-i18n-namespaces.test.ts` 强制）。
- 链内页面各自的字段文案加在新顶层 key 下（如 `runs.list.*`、`runs.detail.*`），不要塞进 `states`。

命名空间注册处（新增链时才需要改，目前四条链已注册齐）：`app/src/lib/i18n/index.ts`（NAMESPACES + resources）、`app/src/lib/i18n/i18next.d.ts`（类型）。

## 路由约定

Bot 维度（创建者链，挂在 `_authed/_app` 布局下，用 `BotSubpage` 框架）：

| 页面 | 路由文件 | URL |
| --- | --- | --- |
| 运行记录 | `app/src/routes/_authed/_app/bots.$agentId.runs.tsx` | `/bots/$agentId/runs` |
| 评测集 | `app/src/routes/_authed/_app/bots.$agentId.datasets.tsx` | `/bots/$agentId/datasets` |
| 实验 | `app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx` | `/bots/$agentId/evaluations` |

- 子页（详情、步骤树、版本、实验对比）作为上述三页的下级路由继续挂，命名沿用英文单数/复数与 TanStack Router 文件约定（如 `bots.$agentId.runs.$runId.tsx`）。

管理维度（管理链）：

| 页面 | 路由文件 | URL |
| --- | --- | --- |
| AI 可观测性 | `app/src/routes/_authed/admin/observability.tsx` | `/admin/observability` |

- 管理链一切页面挂在 `/admin/observability*` 下，天然继承 `_authed/admin/route.tsx` 的 admin 角色守卫（非 admin 直连即被重定向）。

权限校验（直连 URL 也执行）：

- Bot 维度三页的 `beforeLoad` 统一调用 `requireBotObservabilityAccess(context.queryClient, params.agentId)`（`app/src/lib/observability/route-guard.ts`）：通过 `agentQueryOptions` 读取服务端授权事实 `canManage`，非 true 重定向到 `/bots`。创建者与管理员都由服务端的该标志覆盖，前端不自行推导归属规则。
- 管理维度复用既有 admin 守卫，不新增代码。

占位说明：四个路由文件当前渲染各自命名空间的 `states.disabled` 占位文案，这是 Opik 未配置时的诚实状态；各页面 Ticket 接手时替换组件主体，路由文件与守卫 wiring 已就位。新增/改名路由文件后需重新生成 `app/src/routeTree.gen.ts`（`cd app && bun run build`，或任何 vite dev/build 触发）。

## 验证命令

```sh
cd app
bun test tests/observability-i18n-namespaces.test.ts   # 四命名空间注册 + 双语键对齐 + 八状态齐全
bun test tests/observability-route-guards.test.tsx     # 直连 URL 的 admin 角色与 canManage 守卫
bun run typecheck
```

仓库级：`bun test ./app`（app 全量测试）。
