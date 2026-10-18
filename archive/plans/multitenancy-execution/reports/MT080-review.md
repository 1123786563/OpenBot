# MT080 独立复审报告 —— Web 公司与团队选择界面及无资格空状态（Issue #123）

- 复审者：独立 Pi 会话（Orca Task `task_171b2bf0ebd7` / Dispatch `ctx_45a040b3579e`），与实现者会话无共享上下文。
- 日期：2026-10-17。工作树：Orca 受管 `i11-review-mt080`，BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（与 `checkpoints/prereq-manifest.txt` 首行一致）。
- 审阅对象：本票 7 交付（新 3：`app/src/lib/enterprise/tenant/selection.ts`、`app/src/routes/_authed/tenant/selection.tsx`、`app/tests/multitenancy/selection.test.tsx`；改 4：`app/src/lib/client.ts`、`app/src/locales/{en,zh-CN}/tenant.json`、`app/src/routeTree.gen.ts`）+ server 前置树内 `workspace-scope-routes.ts` / `workspace-admin.ts`（只读契约参考）。
- 授权边界：只读被审文件；唯一新建 = 本报告；未修复、未提交、未推送、未合并。

## 结论

**通过（PASS，无阻塞发现）。** 票面四条验收与父 Spec A3/A6/A10 全部有真实测试与代码路径支撑；数据契约与 server 响应形状逐字段一致；选择头纪律、generation 共用、缓存删除路径逐一核实；i18n 键集同步与 routeTree 纯追加经独立复跑证实；后端零改动经本复审独立复算 **111/111 全部一致** 再证。全部独立复跑命令本会话实际执行并记录于下文。发现 6 条非阻塞观察项（见「发现与建议」），均不影响验收。

## 独立复跑记录（本会话实际执行，证据优先）

| # | 命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| 1 | `cd app && bun install --frozen-lockfile` | 1415 packages installed，无 lockfile 漂移 | OK |
| 2 | `bun test app/tests/multitenancy/selection.test.tsx`（仓库根） | **25 pass / 0 fail / 0 skip / 101 expect()**，exit 0 | 与票面声称 25/0/0（101 expect）逐字一致；0 skip，无「skipped 记为通过」 |
| 3 | `cd app && bun run typecheck` | `tsc --noEmit` exit 0 | OK |
| 4 | `bunx biome check`（本票全部触及文件） | exit 0（routeTree.gen.ts 为生成物被 biome 配置忽略，实查 6 文件） | OK |
| 5 | `cd app && bun run build` | 成功 exit 0（chunk 体积 advisory 为存量提示，非错误） | OK |
| 6 | routeTree 可复现性：build 前 `cp` 存底 → build → `diff` | **逐字节一致**（生成器重写后无漂移） | 「纯追加 21 行」可复现成立 |
| 7 | prereq manifest 独立复算：`awk NR>1` 取清单 → `shasum -a 256` 逐文件重算 → diff | **111/111 全部一致，0 MISSING** | 后端零改动再证成立（见 F 节计数说明） |
| 8 | 测试无 DB/网络依赖核查 | 测试文件 imports 无 server/db/pg；全部用例以 fixture + `global.fetch` 桩驱动（happy-dom + testing-library），无任何用例静默依赖网络或数据库 | OK |

复跑后清理：`app/dist`（build 产物）与全部 /tmp 中间文件已删除；工作树 `git status` 与复审前一致（仅本票 7 文件 + server 前置树既有未提交面）。

## A. 票面四条 + A3/A6/A10 裁决 —— 通过

| 验收 | 代码事实 | 测试证据（本套件内） |
| --- | --- | --- |
| 1 只列真实资格；跨公司用户各自条目 | 列表 = MT006 `GET /api/enterprise/workspace-scope` 唯一事实源；选择器选项即列表原文（`ScopeSelectors` 直接 map `companies`/`teams`），无客户端资格发明 | 契约钉（路径 + 零选择头 + wire 形状）；`a cross-company user sees each of their companies with its own teams`（acme 2 团队 / globex 1 团队各自可见） |
| 2 无资格空状态；不自动选第一项/默认团队 | `selectionState`：空列表 → `empty`（页面不渲染选择器）；有资格未选 → `ready`（双触发器全占位）；`selectionFromSources`：仅 company 的 URL 是不完整范围 = 无选择，绝不用存储半边拼补 | `with no eligibility...no selector at all`；`eligible but nothing chosen: both selectors sit at their placeholders`（断言无 "Acme Inc"、无 "Working in"）；`completing a selection...` 中间态断言存储被清、`Pick a team` 占位保持 |
| 3 加载/失败/撤权三态显式可重试 | `loading`（骨架、无选择器）/`error`（文案 + Retry → `listing.refetch()`）/`revoked`（标题 + 说明 + 「Check again」重拉复核 + 选择器保留供显式改选）；失败绝不读成撤权或空态（`selectionState` 先判 `error` 再看列表） | loading/error/revoked 三态 + 「Retry 后转绿」「Check again 后仍撤权保持撤权脸」+ `error.state never promoted to revocation` 断言 |
| 4 切换后立即反映、无需刷新 | commit 顺序 = `selectWorkspaceScope`（generation++ + 缓存删除）→ `storeSelection` → `navigate`（TanStack 客户端导航）；React Query 按选择分键 | `completing a selection moves the URL, the storage, and the shared generation`（memory router `location.search` + storage + generation + 摘要四处同步）+ 缓存纪律层 5 用例 |
| A3（团队分别使用自己资源；默认不可见） | Web 侧交付 = 选择对（双头）+ 每团队分键缓存；可见性强制在服务端 RLS（MT006 lister 过滤非 active），选择器如实镜像 | 列表契约钉 + 深链/存储恢复用例；不越权web 侧声称 |
| A6（缺上下文/伪造 Scope 不回退默认） | 六态状态机无一「默认」分支；malformed → 类型化拒绝非空态；选择两半不齐 = 无选择 | `a malformed listing is a refusal, never a silent empty answer` + partial-URL 用例 + ready 占位用例 |
| A10（切后不显示旧范围在途/缓存；新标签页同规则） | 选择存 URL（新标签页同规则）；generation 先推后删 + 既有 `TenantSelectionChangedError` 守卫拒在途 | `a response that outlives a company switch...is refused`（真实 `channelsQueryOptions.queryFn` + held promise + release，拒后零落键）+ 深链正/反两用例 |

## B. 数据契约裁决 —— 通过

- **逐字段对照**（client `selection.ts` vs server `workspace-admin.ts:72-88`）：`WorkspaceScopeTeam{workspaceId,name}`、`WorkspaceScopeCompany{tenantId,name,role,memberEpoch,teams[]}`、`WorkspaceScopeListing{companies[]}` —— **完全一致，无多字段无缺字段**；服务端契约无 current/default/selected 字段，客户端类型同样没有。
- **错误 envelope**：client 读 `body.error.code`，与 server `errorResponse` 的 `{error:{code,message}}` 一致；未映射码 → 500、`AUTH_REQUIRED`→401、`DATA_DATABASE_UNAVAILABLE`→503 与设计文档核对相符。
- **坏响应体绝不读成「你没有公司」**：200 但 body 非 `{companies:[...]}`、或条目缺 `tenantId:string`/`teams` 数组 → `WORKSPACE_SCOPE_MALFORMED` 类型化拒绝，有专项测试钉死（`a malformed listing is a refusal, never a silent empty answer`）。
- **wire 类型本地声明 + fixture 钉死的漂移兜底属实**：`shared/enterprise/mobile-schemas.ts` 经 grep 确认不含 teams/workspace-scope 契约（D1 前提成立）；测试 fixture `LISTING` 与 server 接口逐字段一致；漂移=测试失败，如实。

## C. 选择头纪律裁决 —— 通过

- `client.ts` 重构 `tenantSelection`→`scopeSelection`：门禁（`!path.startsWith("/") || path.startsWith("//")` → 丢弃；非 `/api/enterprise/` 前缀 → 丢弃）位于**任何头部附加之前**，`tenantId` 与 `workspaceId` 走同一门禁 —— 纪律是结构性的，不是两份拷贝。`send()` 展开顺序保证 selection 头不可能覆盖 `content-type`。
- 逐测试核实：enterprise 路径双头并行携带 + 非企业路径（`/api/agents`）双头丢弃 + 绝对 URL（cross-origin）双头丢弃（本套件 transport 用例）；`//host` 情形对 tenantId 由既有 `enterprise-client.test.ts:100-113` 钉住（`//other.example/...` 与 `/api/plugins/servers`），workspaceId 因共享同一提前返回的门禁而结构性覆盖。列表读零选择头另有断言（MT005 裁决 #1：列表先于选择存在）。
- 既有 tenantId 行为零回归：`tenantId` 直通路径（无 body 时仅选择头、有 body 时并入 headers）与重构前逐字节等价；typecheck 与既有 client 测试全绿。

## D. generation 语义裁决 —— 通过

- **共用同一 generation**：`selectWorkspaceScope` 读写 `tenantKeys.generation(userId)` —— 与 `selectTenant` 同键；`the selection layer's switch and selectTenant drive one generation` 用例钉死连续 +1。
- **先推 generation 再删缓存**：两条路径（团队切换分支、`selectTenant` 复用分支）均为 `setQueryData(generation, +1)` 先于 `removeQueries`，与 `queries.ts` 既有顺序注释一致。
- **同公司换团队仅丢旧团队子树**：`selectionKeys.workspaceScope(u,t,w) = [...tenantKeys.scope(u,t), ":workspace", w]` 挂在既有 tenant scope 前缀下（键前缀断言测试钉死），删除只命中 `:workspace` 前缀；兄弟团队缓存保留、chooser 不受累均有断言。`:workspace` 前导冒号与 tenantId 字符集（`^[A-Za-z0-9_-]{1,128}$`）不可能碰撞，与 `queries.ts` 既有保留 token 纪律同构。
- **A10 守卫消费方测试真实性**：在途拒绝用例使用**真实** `channelsQueryOptions(...).queryFn`（内含 `guarded()`），held promise + 切换 + release → `rejects.toBeInstanceOf(TenantSelectionChangedError)` 且新公司零落键 —— 消费的是生产读取路径，非测试替身。
- 跨公司切换（含与「无选择」互转）整体复用 `selectTenant`，「不另造缓存一套」在代码层成立（`selection.ts` 仅 import `selectTenant`/`tenantKeys`，无平行机制）。

## E. i18n 与生成物裁决 —— 通过

- en/zh-CN 各 +31 行 `selection.*` 段；键集同步测试为**结构化**叶路径逐键相等（非逐串翻译比对，符合仓库「键集同步」纪律），并有非空内容断言。页面所有文案均走 `t("selection.*")`，无硬编码。
- `routeTree.gen.ts` diff = **21 insertions / 0 deletions**，全部为新路由 `/tenant/selection` 注册（import、update、三个 interface 条目、两条 union 行）；本复审以「存底 → 重 build → diff」独立证实生成物可复现、无其他漂移。

## F. 披露与边界裁决 —— 通过（含一处计数澄清）

- **D1（契约来源）**：属实（见 B 节）。
- **D2（撤权判定 = 新列表在场性）**：`findSelection` 纯函数实现与表述一致；失败态在状态机中先于撤权判定，基础设施故障绝不伪造成授权事实。server 侧依据（lister = 实时资格、无存在性泄露）与 `workspace-scope-routes.ts` 的事实源一致。
- **D3（workspaceId 头暂无页内消费方）**：属实——页面唯一消费端点是列表（契约规定其不读选择头）；头部作为交付接口有测试冻结签名。与 MT079 判例同构。
- **D4（URL 权威 + storage 兜底、写失败静默吞）**：代码与披露一致；损坏/变形存储读作 null 有 3 组变形断言；绝不发明选择。
- **D5（未做变异轮）**：如实披露；GREEN-1 的 5 个真实断言失败记录（`red-green/GREEN-1-first-run-20of25-full.log`）提供了测试可失败性的直接证据，取舍可接受。
- **D6（routeTree 纯追加）**：独立证实（本报告 E 节）。
- **D7（全量套件 4 个既有 fail）**：本复审按 brief 复跑清单执行（聚焦命令 + typecheck + biome + build），未重复全量 196 文件回归；实现者提供的基线对照记录（`7-baseline-without-changes.md`：stash 后同 4 fail，1407+25=1432 账目吻合）在案，逻辑自洽。
- **后端零改动复算（计数澄清）**：`prereq-manifest.txt` 现含 **111 项**；实现者报告与复算存档记录为「107 项 107 OK」。本复审对当前 manifest **全量 111 项**独立重算 SHA-256：**111/111 全部一致、0 缺失**。结论（本票后端零改动）不变；数字出入最可能为并行票向共享 manifest 追加 4 项所致，建议 coordinator 知悉，不影响验收。
- **「不另造缓存一套」**：见 D 节——键树、generation、删除纪律全部复用 `queries.ts` 既有机制，无平行实现。

## 发现与建议（均非阻塞）

1. **【观察】运行时形状守卫为浅层守卫**：`workspaceScopeListingQueryOptions` 只验 `companies` 数组与每项 `tenantId:string`+`teams` 数组；不深验 team 项的 `workspaceId`/`name`、`role`、`memberEpoch`。深层漂移会以破碎文案而非「伪空态」呈现——brief 狙杀的 empty-state 谎言仍被挡住，且 D1 未声称更深守卫。建议后续票为该端点补 shared schema 时一并收敛（与 D1 的既有建议一致）。
2. **【观察】`user.isError` 时 Retry 只重试列表**：页面 error 脸在 `currentUserQueryOptions` 失败时同样呈现，但 Retry 按钮仅 `listing.refetch()`，不会重试 user 查询。该路径下点击无效直至 user 查询自愈；低概率边缘（`_authed` 布局自身处理会话失效），建议后续票将 Retry 语义对齐两个读取。
3. **【观察】计数出入**：manifest 111 项 vs 实现者记录 107 项（见 F 节），结论不受影响。
4. **【观察】`//` 路径拒绝的 workspaceId 专项断言缺位**：由共享门禁结构性覆盖 + 既有 tenantId 测试钉住，可接受；如求显式可在 transport 用例补一行 `//` 断言。
5. **【nit】文档笔误**：`selection.tsx` 顶部注释 "the five kinds" 后列出六种（loading/error/empty/ready/selected/revoked）。
6. **【观察】传输层不强制 (tenant, workspace) 配对**：`workspaceId` 单独在场时仍单独附加该头（注释声明 resolver 拒绝之）。与 MT005 裁决 #1（头只做选择、判定在服务端）一致，属有意设计；记录在案。

## 复核口径说明

- `routeTree.gen.ts` 触及文件 biome 检查：biome 实查 6 文件（生成物被其配置忽略），exit 0 即票面门槛满足。
- 全量 app 套件（1432 pass / 4 既有抖动）未在本复审重复执行：brief 复跑清单未含，且实现者已提供 stash 基线对照证据链（D7）。
