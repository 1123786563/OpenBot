# MT080 / Issue #123 设计检查点 — Web 公司与团队选择界面及无资格空状态

实现者：frontend_implementer（Pi，Orca Task `task_28535c9e7ebe` / Dispatch `ctx_5fbc79400700`）。
冻结 BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`。纯前端票：后端零改动。

## 1. 数据契约（选择器数据契约来源）

- 列表事实源：**`GET /api/enterprise/workspace-scope`**（MT006，`server/src/enterprise/tenancy/workspace-scope-routes.ts`，挂载 `server/src/app.ts:900`）。
  响应形状 = `WorkspaceScopeListing`（`workspace-admin.ts:86`）：
  `{ companies: [{ tenantId, name, role, memberEpoch, teams: [{ workspaceId, name }] }] }`。
  服务端钉死：无 current/default/selected/active 字段（MT006 review AC2）；资格 = tenant+principal+membership 三个 active；suspended 公司整公司隐藏、suspended 团队单团队消失（MT006 review AC1）。
- 客户端 wire 类型在本票新模块内本地声明（该端点无 shared schema 文件；`shared/enterprise/mobile-schemas.ts` 是旧的移动端 chooser 契约，不含 teams）。类型漂移由测试钉住 fixture 形状兜底。
- 选择头（MT005 裁决 #1）：`x-openbot-tenant` + `x-openbot-workspace` 只做选择，成员资格由数据库判定。`app/src/lib/client.ts` 现仅支持 `tenantId` 头；本票为其**新增 `workspaceId` 选项**（同一同源纪律：仅相对 enterprise 路径附加，绝不外泄），供本票及后续范围读消费方使用；本票自身页面消费的唯一端点是列表端点（不读选择头）。
- 错误码语义（brief 方法 1 的核实结论）：
  - 列表端点：`AUTH_REQUIRED → 401`；未映射码 → 500；`DATA_DATABASE_UNAVAILABLE → 503`。列表不携带选择头，因此**列表上的 403 不在契约内**。
  - 范围读（`/api/enterprise/conversations` 等）：`TENANT_FORBIDDEN/WORKSPACE_FORBIDDEN → 403`（workspace-scope 路由保留 code；conversations 路由把 `SCOPE_REVOKED` 映射为 403 code "forbidden"）；缺 workspace 头 → `WORKSPACE_REQUIRED`（不自动选唯一团队）。
  - 撤权在事务层：`SCOPE_REVOKED`（公司级 epoch 漂移/停用）/ `WORKSPACE_REVOKED`（团队行删除或停用）（`scope-gate.ts`）。

## 2. 撤权态判定依据

**判定 = 所选 (tenantId, workspaceId) 是否仍出现在新拉取的列表中**，而不是解析业务读的错误码：

- 服务端 lister 本身就是实时资格事实（过滤一切非 active 行），且无存在性泄露（RLS 自读）。
- 撤权后：公司撤 → 整公司从列表消失；团队撤/停用 → 单团队从该公司 teams 消失（MT006 review AC1 钉死的行为）。
- 因此 `selected ∉ listing` ⇔ 被撤权（或选择从未有效），`selected ∈ listing` ⇔ 有效。列表读失败（401/500/503）是**失败态**（可重试），不是撤权态——不把基础设施故障伪造成授权事实。
- 撤权态绝不静默回退：不清除选择、不自动改选其他公司/团队；显示明确界面 + 重试（重拉列表复核）+ 保留选择器供用户显式改选。

## 3. 状态机（纯函数 `selectionState`）

输入：列表读结果（pending | error | success(listing)）+ 当前选择（URL 参数优先，localStorage 兜底；两半齐全才算选择）。

| 状态 | 条件 | 界面 |
| --- | --- | --- |
| `loading` | 列表 pending | 骨架屏 |
| `error` | 列表失败（401/500/503/网络） | 明确失败文案 + 重试按钮（重新拉列表） |
| `empty` | 列表成功且 companies 为空 | 无资格空状态 + 引导（联系公司管理员）；**不渲染选择器** |
| `ready`（未选择） | companies ≥ 1 且无完整选择 | 双选择器均占位，**绝不自动选第一项/默认团队** |
| `selected` | 选择两半均在列表中命中 | 选择器 + 当前范围摘要（公司/团队/角色） |
| `revoked` | 选择的公司消失，或公司在但团队消失 | 明确撤权界面 + 重试 + 可显式改选 |

## 4. 交互与切换纪律（延续既有 chooser + generation 设计，不另造一套）

- **缓存 generation 共用**：`selectWorkspaceScope` 推进与 `selectTenant` **同一个** `tenantKeys.generation(userId)`。跨公司切换直接复用 `selectTenant`（推进 generation + 丢弃旧公司整棵 scope 子树——连带既有 channels 面的缓存）；同公司换团队推进 generation 并仅丢弃旧团队的 `:workspace` 子树。任何切换后，旧范围在途响应按既有 `TenantSelectionChangedError` 语义被拒（用既有 `channelsQueryOptions` 作守卫消费方钉死跨面行为）。
- **选择来源**：URL 参数 `company` / `team` 为权威（可深链、新标签页同规则，A10）；二者皆缺时回退 localStorage（按 userId 隔离、仅记录用户显式选择、损坏即 null）；任一 URL 参数存在则 localStorage 不参与。localStorage 绝不自动生成选择——无存储即无选择。
- **持久化写**：仅在用户显式完成 (公司, 团队) 选择时写 localStorage + URL；公司单选变化只更新 URL 的 `company` 并清空 `team`（URL 权威），scope 不变（选择两半不齐即无 scope），团队下拉绝不自动补位。
- **切换后立即反映**：TanStack Router 客户端导航 + React Query 按选择分键，无整页刷新；摘要直接由新选择的列表事实渲染。

## 5. 文件面（全部前端，后端零改动）

- 新建 `app/src/lib/enterprise/tenant/selection.ts`：wire 类型、`WorkspaceScopeRefusedError`（携带 status + envelope code）、列表 query、`selectionState`/`findSelection` 纯函数、localStorage 持久化、`selectWorkspaceScope`、`:workspace` 缓存键。
- 新建 `app/src/routes/_authed/tenant/selection.tsx`：页面（`validateSearch` 校验 company/team 参数）。
- 扩展 `app/src/lib/client.ts`：`workspaceId` 选项（同源纪律与 `tenantId` 完全一致）。
- 测试 `app/tests/multitenancy/selection.test.tsx`（票面 Verification 命令逐字路径）。
- i18n：`app/src/locales/{en,zh-CN}/tenant.json` 增 `selection.*` 段，键集同步由测试钉死。

## 6. 非目标

- 不 rewiring 既有 `/tenant/channels` 页（其 chooser 属移动契约 F02 面，端点未挂载，不在本票范围）。
- 不实现团队业务读（无既有可挂载端点；`:workspace` 键与 `workspaceId` 头为后续票接口）。
- 后端任何文件改动（若发现后端缺口，escalation 说明，不越权实现）。
