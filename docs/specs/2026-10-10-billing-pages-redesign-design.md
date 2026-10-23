# 计费三页商业化重设计（权益 / 订阅 / 使用记录）

日期：2026-10-10
状态：已与用户逐节确认

## 背景与目标

Settings 下的三个计费页面（权益 `/settings/billing`、订阅 `/settings/billing/subscribe`、使用记录 `/settings/usage`）功能完整但呈"开发者风格"：权益页只有一排 code 胶囊，订阅页是朴素的单列 radio 行，使用记录是纯文本合计加分页列表。

**目标**：三页升级到商业化产品级（参考 Linear / Vercel / Stripe Billing 的质感），前端后端一起改——UI 不受现有数据形状限制。保持现有信息架构（三页独立、导航不变、URL 不变）。

**非目标**：

- 不做信息架构重组（不合并页面、不改导航结构）
- 不改购买流程的正确性逻辑（轮询、恢复、过期兜底原样保留，只换呈现外壳）
- 不改权限模型（所有人可读，管理员发起购买）
- 不引入营销系统（套餐/权益文案来自部署配置数据，原样展示，不走 i18n）

## 总体视觉方向

- 三页从 `PageShell` 窄列（`max-w-2xl`）切到 **wide**（`max-w-5xl`）。
- 保持单色设计语言：灰阶 token 不动，强调靠 `primary`，语义色 `success` / `destructive`，图表色用已有 `--chart-1~5` token（暗色模式自动适配）。
- 数据层沿用 react-query，`billingKeys` 扩展新端点；`staleTime` 策略沿用现状（usage 类永远新鲜、entitlements 带 TTL）。
- 新增依赖仅 **recharts**（`app/package.json`）。
- i18n：所有新增 UI 文案在 `zh-CN` 与 `en` 的 `settings.json` 双语补齐。例外：套餐名/权益 label 与 description 是部署配置的**数据**，原样展示。

## 1. 权益页 `/settings/billing`

### 布局

```
┌─────────────────────────────────────────────────────┐
│ 当前订阅                                    [生效中] │  ← hero 卡
│ Pro 月付 (pro-monthly)      本周期 10-01 → 11-01    │
├─────────────────────────────────────────────────────┤
│ 套餐包含                                             │
│ ┌───────────────┐  ┌───────────────┐                │
│ │ ⬡ 权益 A      │  │ ⬡ 权益 B      │                │  ← 两列卡片
│ │ 一句描述文案    │  │ 一句描述文案    │                │
│ └───────────────┘  └───────────────┘                │
└─────────────────────────────────────────────────────┘
```

- **hero 卡**：套餐展示名 + code、状态徽章（`active` 用 `success` 色，其余状态灰）、本计费周期起止。
- **权益清单**：两列卡片网格，每项 tabler 图标 + label + description。图标按 code 字符串启发式映射（如含 `model`/`agent`/`skill` 等关键词），认不出用 `ShieldCheck` 兜底。
- **无订阅空态**：空态卡 + 「去订阅」按钮链接到 subscribe 页。

### 数据层（服务端）

- `planEntitlements` 配置从 `ReadonlyMap<string, readonly string[]>` 升级为值形态 `readonly { code: string; label?: string; description?: string }[]`。API 返回同步扩展；`label` / `description` 可选，前端缺省回退展示 code 本身——旧配置（纯字符串数组）继续被接受，向后兼容。
- `GET /api/billing/entitlements` 返回扩展为：

  ```jsonc
  {
    "active": true,
    "planCode": "pro-monthly",
    "codes": [{ "code": "agents.pro", "label": "Pro 代理", "description": "…" }],
    "subscription": {
      "status": "active",
      "currentPeriodStart": "…",
      "currentPeriodEnd": "…"
    }
  }
  ```

- 周期数据来源：服务端用已有 Lago client 的 `getSubscription`（`GET /api/v1/subscriptions/{externalSubscriptionId}`）读取周期字段，与本地 projection（`billing_subscriptions` 的 status / planCode）合并。**验证点**：Lago v1.53 订阅响应的周期字段名（预期 `current_period_start` / `current_period_end`），实施时对照本地 Lago 实例确认；字段缺席时 `subscription` 相关字段返回 `null`，前端 hero 卡降级为只显示套餐与状态。
- 该读服务端已有 TTL 缓存（`entitlement.ts`），扩展字段随缓存一起，无需新缓存。

## 2. 订阅页 `/settings/billing/subscribe`

### 选购视图

```
┌─────────────────────────────────────────────────────────┐
│ 选择套餐                                                 │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│ │ starter     │ │▐ pro ★选中  │ │ enterprise  │         │  ← 价格卡网格
│ │ ¥49 /月     │ │ ¥199 /月    │ │ ¥999 /月    │         │
│ └─────────────┘ └─────────────┘ └─────────────┘         │
│ 支付方式   [支付宝] [微信支付]     ← 横向 segmented      │
│ ─────────────────────────────────────────────           │
│ pro · ¥199/月                        [ 继续支付 ]        │  ← 意向条
└─────────────────────────────────────────────────────────┘
```

- **价格卡网格**：响应式 1/2/3 列（`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`）。每卡：套餐 code（大字）、价格（大号 `tabular-nums`）、周期单位。选中卡 `ring-primary` + 角标勾选；未选卡 hover 提升边框。单套餐目录保持现状语义（预选中、目录仍显示该单卡）。
- **支付渠道**：纵向两行 radio 改为横向 segmented 控件，展示渠道名与内联标识。
- **意向条**：分隔线之下一行——左侧所选套餐 + 价格合计，右侧「继续支付」主按钮。价格在点击前可读。
- **已有订阅**：现 `activeSubscriptionNotice` 纯文本升级为状态卡（套餐名 + 状态徽章 + 指向权益页链接）。`canPurchase=false`（非管理员）时目录以禁用态展示，不再只是替换成一句话空态。

### 支付流程视图

- QR 卡片化：二维码居中（256px，白底内边距保持现有可扫性）、**倒计时进度条**（长度随过期时间线性收缩，剩余 < 20% 时转 `destructive` 色）、状态文案、取消按钮。秒级倒计时与 QR payload 与 countdown 不许错位的现有约束（`key={payload}` 等）原样保留。
- 支付成功态：`success` 色对勾图标 + 简短出现动效（用已有 `motion` 依赖），文案沿用现有 i18n key。
- **正确性逻辑零改动**：5 秒轮询、`MAX_POLL_ATTEMPTS` 上限、刷新后恢复未完成订单、过期后继续轮询兜底、409 后重询 catalog——这些只被重新包装进新外壳。

## 3. 使用记录页 `/settings/usage`

### 布局

```
┌─────────────────────────────────────────────────────┐
│ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│ │ 本周期合计 │ │ 总 tokens │ │ 事件数    │             │  ← KPI 行
│ │ ¥12.34   │ │ 1,204,556│ │ 342      │              │
│ └──────────┘ └──────────┘ └──────────┘              │
│ 用量趋势（按天）      本周期 10-01 → 11-01            │
│ ▂▄▆█▅▂▁ ▃▅▇█▆▄▂ ← recharts 柱状图                │
│ 计费项                  tokens × 单价 = 金额         │  ← charges 表
│ 用量明细（分页保留） 时间│指标│输入│输出│tokens       │  ← 表格化
└─────────────────────────────────────────────────────┘
```

- **KPI 行**（3 卡）：本周期合计金额、总 tokens、计量事件数。数据同源现有接口，不做全量求和：合计金额与总 tokens 都取自 `/api/billing/usage` 的 charges（tokens 类计费项的 `units` 即 token 总量，与金额同一来源）；事件数取自 `/api/billing/usage/events` 首页响应的 `pagination.totalCount`。
- **趋势图**：recharts `BarChart`，按天 tokens，柱色 `--chart-2`；tooltip 展示日期与输入/输出拆分。X 轴只标首尾与月边界，避免拥挤。
- **charges 汇总**：从 Item 行升级为表格（计费项 / units / 金额，数字列右对齐等宽）。
- **事件日志**：表格化（时间 / 指标 / 输入 / 输出 / tokens 五列，等宽数字）。`?eventsPage=` URL 分页语义不变。
- **骨架屏**：loading 从渲染 `null` 升级为 skeleton 占位（KPI 卡 / 图表 / 表格各有形状）。

### 新端点 `GET /api/billing/usage/daily`

- 服务端复用 `lago.listEvents` 分页拉取**本计费周期**事件（周期取自 `getUsage` 的 `from/to`），按天分桶为 `{ date, tokens, inputTokens, outputTokens, calls }` 数组。
- 分页拉取上限 **50 页**；达到上限时响应带 `truncated: true`，前端图注显示「仅含最近 N 条」。
- 时区：按服务器本地日分桶（与 Lago 周期边界的现有语义一致）。
- 短 TTL 缓存 60 秒（页面本就 `staleTime: 0`，聚合有成本，60 秒内重复访问共享一次聚合）。
- 鉴权与现有 usage 端点一致（登录即可读，服务端按部署 customer key 读取）。

## 4. 横切关注点

- **空态统一**：三页无订阅时用同一个空态组件 + 「去订阅」CTA（新组件 `BillingEmpty`）。
- **错误**：保留 message 直显，每个错误态补「重试」按钮（react-query `refetch`）。
- **无障碍**：价格卡为真实 `button`（沿用 `Item render` 模式）；图表附 `role="img"` + aria-label；进度条有 `aria-valuenow`。
- **暗色模式**：图表与卡片只用 token 色，暗色自动成立；QR 码保持白底。

## 5. 测试

- **服务端单测**：daily 聚合（分桶边界 / 跨天事件 / 分页上限截断 / 周期缺失降级）；entitlements 扩展契约（新旧配置形态、周期字段缺席降级）。
- **前端组件测试**：沿现有 testing-library 模式——价格卡选中态、意向条联动、KPI 渲染、daily 图空数据态、entitlements 缺省 label 回退。
- **e2e**：`tests/e2e/browser.e2e.ts` 相关断言更新到新结构；支付流程冒烟路径（创建订单 → QR 出现 → 取消）保持通过。
- **门禁**：沿用仓库既有 typecheck / test / lint 命令。

## 6. 文件面

**前端（app/）**：

- 重写：`routes/_authed/settings/billing.tsx`、`billing_.subscribe.tsx`、`usage.tsx`
- 新增：`components/billing/`（`SubscriptionHero`、`PriceCard`、`ProviderSegmented`、`CheckoutCard`、`KpiCard`、`UsageChart`、`BillingEmpty`、表格行组件）
- 修改：`lib/billing/queries.ts`（entitlements 新形状 + daily 端点）、`lib/billing/payments.ts`（类型微调，如需）
- i18n：`locales/{zh-CN,en}/settings.json` 全量新增 key
- 依赖：`app/package.json` 加 `recharts`

**服务端（server/）**：

- `billing/routes.ts`：新增 `/usage/daily`；entitlements 响应扩展
- `billing/service.ts`：entitlement 读取合并订阅上下文
- `billing/lago.ts`：subscription 周期字段接入（wire 类型扩展）
- `billing/types.ts`：`BillingEntitlements` 等类型扩展
- 配置读取处：`planEntitlements` 新旧形态兼容解析

**测试**：`server/tests/billing/*`、`tests/e2e/*` 对应更新。

## 7. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Lago v1.53 订阅周期字段名与假设不符 | 实施第一步先对照本地实例验证；缺席则降级为 hero 卡不显示周期 |
| 事件量大时 daily 聚合慢 | 50 页上限 + `truncated` 标记 + 60s TTL 缓存；页面本身异步加载不阻塞 KPI |
| 旧部署的 `planEntitlements` 纯数组配置 | 服务端两种形态都解析，前端对缺省 label/description 回退展示 code |
| recharts 包体积 | 仅 usage 页路由加载；图表色复用 token，无额外主题配置 |
| e2e 断言脆弱 | 支付流程逻辑零改动，仅展示层断言更新 |
