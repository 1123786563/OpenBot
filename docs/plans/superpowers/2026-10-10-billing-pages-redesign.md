# 计费三页商业化重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Settings 下权益/订阅/使用记录三页升级为商业化产品级 UI，后端补结构化数据（订阅上下文、按天用量聚合），保持信息架构与购买流程正确性逻辑不变。

**Architecture:** 服务端先行扩展数据面（配置条目形态 → Lago 客户端订阅周期 → entitlements 上下文 → daily 聚合端点），前端随后重写三个路由页面并新建 `components/billing/` 组件层。所有 UI 文案走 i18n 双语，视觉只用现有 token。

**Tech Stack:** Hono + zod + drizzle（服务端）、React 19 + TanStack Router/Query + recharts（新增）+ motion/react + tailwind v4（前端）、bun:test（两端测试）。

**Spec:** `docs/specs/superpowers/2026-10-10-billing-pages-redesign-design.md`（本计划逐节实现该规格）

## Global Constraints

- 一律用 `/opt/homebrew/bin/bun` 跑命令（系统 bun 1.3.14 有嵌套 spawn 静默失败问题，已验证的绕法是显式路径）。
- 门禁命令（仓库根目录）：`/opt/homebrew/bin/bun run typecheck`、`/opt/homebrew/bin/bun run lint`、`/opt/homebrew/bin/bun test`。脏树上有与本工作无关的既有失败（git status 里 enterprise/payments 的未提交改动），门禁只要求**不新增失败**；提交前用 `git add` 精确暂存本任务文件。
- 每个任务以独立提交收尾；提交信息用中文一行式 `feat/fix/test/refactor(scope): …`。
- 不新增依赖，唯一例外：`recharts`（仅 app 包）。
- 所有新增 UI 文案必须同时写入 `app/src/locales/zh-CN/settings.json` 与 `app/src/locales/en/settings.json`。
- 购买流程正确性代码（5 秒轮询、`MAX_POLL_ATTEMPTS`、刷新恢复、过期兜底轮询、409 重询 catalog、`key={payload}` 防 QR 错位）**原样保留**，只换呈现外壳。
- 视觉只用现有 token（`primary`/`muted`/`success`/`destructive`/`chart-1..5`）；暗色模式靠 token 自动成立；QR 码保持白底。
- 服务端错误答案只含 sentinel code 派生的句子，绝不让 URL/凭据进响应体或日志（沿用 `BillingError` 纪律）。
- i18n 例外：套餐/权益的 `label`、`description` 是配置数据，原样展示、不走 i18n。

---

### Task 1: Lago 实例 spike——确认订阅周期字段名与 events per_page 上限

**Files:**
- 无代码产出。结论回填到本任务下方「结论」区（直接编辑本计划文件）。

**Interfaces:**
- Produces: 后续 Task 3/5 依赖的两个事实——(a) Lago 订阅对象是否带周期字段及其确切名称（预期 `current_period_start` / `current_period_end`）；(b) `GET /api/v1/events` 的 `per_page` 合法上限（计划按 100 写，若上限更小则 Task 5 的 `DAILY_PAGE_SIZE` 改用实测值）。

- [ ] **Step 1: 从 .env 取 Lago 连接信息并发起查询**

```bash
set -a; source /Users/wuyongjun/trea/OpenBot/.env; set +a
# 订阅对象字段（external_customer_id 用部署自己的 key，先查一个存在的订阅）
curl -s -H "Authorization: Bearer $LAGO_API_KEY" \
  "$LAGO_API_URL/api/v1/subscriptions?per_page=1" | head -c 4000
```

在返回的 subscription 对象里找周期字段：`current_period_start` / `current_period_end`（或 `started_at` / `from_datetime` 等替代名）。记录确切字段名。

- [ ] **Step 2: 验证 events per_page 上限**

```bash
set -a; source /Users/wuyongjun/trea/OpenBot/.env; set +a
curl -s -H "Authorization: Bearer $LAGO_API_KEY" \
  "$LAGO_API_URL/api/v1/events?per_page=100&page=1" | python3 -c "import json,sys; b=json.load(sys.stdin); print('events:', len(b.get('events',[])), 'meta:', b.get('meta'))"
```

若 422/400，降到 50 再试，记录可用上限。同时确认 `meta` 含 `total_count/total_pages/next_page`（现有客户端已依赖）。

- [ ] **Step 3: 确认 current_usage 周期字段可用（备选路径）**

```bash
set -a; source /Users/wuyongjun/trea/OpenBot/.env; set +a
CUSTOMER=$(python3 -c "import re;print(re.search(r'LAGO_PLAN_ENTITLEMENTS', open('.env').read()) and open('.env').read().split('OPENBOT_')[0] and '')" 2>/dev/null || true)
# 若上面取不到客户 id，直接从 Step 1 的响应里复制 external_customer_id 再查：
# curl -s -H "Authorization: Bearer $LAGO_API_KEY" "$LAGO_API_URL/api/v1/customers/<EXTERNAL_ID>/current_usage?external_subscription_id=<SUB_ID>"
```

确认 `customer_usage` 里有 `from_datetime` / `to_datetime`（现有 usage 页已在用，此项为双保险）。

- [ ] **Step 4: 回填结论**

在本文件此处记录（并据实调整 Task 3/5 中的字段名与常量）：

> **结论**：订阅周期字段 = `current_billing_period_started_at` / `current_billing_period_ending_at`（本实例的 Lago 版本无 `current_period_start`/`current_period_end`，任务中所有引用须用实测名）；events per_page 上限 = `100`（HTTP 200，meta 含 `current_page/next_page/prev_page/total_pages/total_count`，`DAILY_PAGE_SIZE` 可按 100 写）；current_usage from/to = `可用`（`customer_usage.from_datetime` / `to_datetime` 均返回，且与订阅的 `current_billing_period_*` 值一致）。

（实测依据：2026-10-10 对 `http://127.0.0.1:48889` 的 Lago 实例，订阅 `openbot-deployment-lago-e2e` / plan `openbot-pro`，billing_time=calendar；报告见 `.superpowers/sdd/2026-10-10-billing-pages-redesign/task-1-report.md`。）

### Task 2: 服务端配置——LAGO_PLAN_ENTITLEMENTS 支持条目对象

**Files:**
- Modify: `server/src/billing/types.ts`（新增 `BillingEntitlementEntry`，扩展 `BillingEntitlements`）
- Modify: `server/src/config.ts:1339`（`billingPlanEntitlements` 解析两种形态）
- Modify: `server/src/billing/service.ts:160-170`（entitlement read 组装 entries + subscription 占位）
- Test: `server/tests/billing-config.test.ts`

**Interfaces:**
- Produces: `type BillingEntitlementEntry = { code: string; label?: string; description?: string }`；`BillingEntitlements.codes: readonly BillingEntitlementEntry[]`；config 值类型 `ReadonlyMap<string, readonly BillingEntitlementEntry[]>`。本任务先让 `subscription` 字段进入类型（Task 4 填充数据）。
- 说明：服务端唯一读 `.codes` 的是 `routes.ts:66`（透传），前端类型在 Task 6 才改——两包经 HTTP 解耦，本任务不动前端。

- [ ] **Step 1: 写失败测试（config 解析）**

在 `server/tests/billing-config.test.ts` 依该文件现有构造 environment 的方式追加：

```ts
// 旧形态：纯字符串数组，仍被接受
test("LAGO_PLAN_ENTITLEMENTS accepts the legacy list-of-codes form", () => {
  const env = testEnvironment({ LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ "pro": ["agents.pro", "skills.advanced"] }) });
  const plans = env.billing.planEntitlements;
  expect(plans.get("pro")).toEqual([{ code: "agents.pro" }, { code: "skills.advanced" }]);
});

// 新形态：对象条目
test("LAGO_PLAN_ENTITLEMENTS accepts entries with label and description", () => {
  const env = testEnvironment({
    LAGO_PLAN_ENTITLEMENTS: JSON.stringify({
      pro: [{ code: "agents.pro", label: "Pro 代理", description: "不限量代理" }],
    }),
  });
  expect(env.billing.planEntitlements.get("pro")).toEqual([
    { code: "agents.pro", label: "Pro 代理", description: "不限量代理" },
  ]);
});

// 非法：条目既非字符串也非对象 / 对象缺 code / label 非字符串
test("LAGO_PLAN_ENTITLEMENTS rejects malformed entries", () => {
  expect(() =>
    testEnvironment({ LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ pro: [{ label: "no code" }] }) }),
  ).toThrow(/"code"/);
  expect(() =>
    testEnvironment({ LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ pro: [42] }) }),
  ).toThrow();
  expect(() =>
    testEnvironment({ LAGO_PLAN_ENTITLEMENTS: JSON.stringify({ pro: [{ code: "a", label: 3 }] }) }),
  ).toThrow(/label/);
});
```

（`testEnvironment` 换成该文件里真实的构造辅助名——先读文件开头确认；若该文件直接调 `loadConfig`，就照它的现有用例改。）

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test server/tests/billing-config.test.ts`
Expected: 新增 3 条 FAIL（返回的是字符串而非对象 / 错误信息不含 "code"）。

- [ ] **Step 3: 类型 + 解析实现**

`server/src/billing/types.ts`：

```ts
/** One entitlement a plan grants, with optional presentational copy from deployment config. */
export type BillingEntitlementEntry = {
  code: string;
  label?: string;
  description?: string;
};

/** The subscription facts the entitlements read carries beside the plan. */
export type BillingEntitlementSubscriptionContext = {
  status: BillingSubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};

/** What a customer is entitled to, flattened from its plan. */
export type BillingEntitlements = {
  active: boolean;
  planCode?: string;
  codes: readonly BillingEntitlementEntry[];
  subscription?: BillingEntitlementSubscriptionContext | null;
};
```

`server/src/config.ts` 的 `billingPlanEntitlements` 返回类型改为 `ReadonlyMap<string, readonly BillingEntitlementEntry[]>`（import 该类型），循环体改为：

```ts
const entries: BillingEntitlementEntry[] = [];
for (const entry of codes) {
  if (typeof entry === "string") {
    if (entry.length === 0) {
      throw new Error(
        `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" must be a list of non-empty entitlement codes`,
      );
    }
    entries.push({ code: entry });
    continue;
  }
  if (entry === null || typeof entry !== "object") {
    throw new Error(
      `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entries must be codes or objects with a "code"`,
    );
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.code !== "string" || record.code.length === 0) {
    throw new Error(
      `LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entries must carry a non-empty "code"`,
    );
  }
  if (record.label !== undefined && typeof record.label !== "string") {
    throw new Error(`LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entry label must be a string`);
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new Error(`LAGO_PLAN_ENTITLEMENTS plan "${planCode}" entry description must be a string`);
  }
  entries.push({
    code: record.code,
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
  });
}
plans.set(planCode, entries);
```

（外层 `!Array.isArray(codes)` 分支的错误信息保持原有句子不变。）

- [ ] **Step 4: 跑测试与类型检查**

Run: `/opt/homebrew/bin/bun test server/tests/billing-config.test.ts && /opt/homebrew/bin/bun run --filter server typecheck`
Expected: config 测试全 PASS；typecheck 会暴露 `service.ts` 的 `codes` 类型不匹配——把 entitlement read 的组装改为透传 entries（`codes: deps.planEntitlements?.get(active.planCode) ?? []` 不变，值的类型已变为 entries），并在无 active 分支补 `subscription: null`、有 active 分支先补 `subscription: null`（Task 4 换成真数据）。改完 typecheck PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/billing/types.ts server/src/config.ts server/src/billing/service.ts server/tests/billing-config.test.ts
git commit -m "feat(billing): 权益配置支持 label/description 条目形态"
```

### Task 3: lago client——getSubscription 与订阅周期字段

**Files:**
- Modify: `server/src/billing/lago.ts`（`LagoSubscriptionBody` 加可选周期字段、`subscriptionOf` 读取、client 接口与实现加 `getSubscription`）
- Test: `server/tests/billing-lago-client.test.ts`

**Interfaces:**
- Consumes: Task 1 结论的周期字段名（下文以 `current_period_start` / `current_period_end` 写定，若 spike 结论不同则全文替换）。
- Produces: `getSubscription(externalSubscriptionId: string): Promise<LagoResult<LagoSubscriptionBody | null>>`；`LagoSubscriptionBody.currentPeriodStart?/currentPeriodEnd?: string`。

- [ ] **Step 1: 写失败测试**

在 `server/tests/billing-lago-client.test.ts` 按该文件现有的 fetch stub 模式追加（先读文件确认 stub 辅助名，下例以它已有的「注入 Response」惯例为准）：

```ts
test("getSubscription returns the neutralized subscription with period fields", async () => {
  // stub: 200 + 订阅对象（含 current_period_start/end）
  const result = await client.getSubscription("sub-1");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    externalSubscriptionId: "sub-1",
    planCode: "pro",
    status: "active",
    currentPeriodStart: "2026-10-01T00:00:00Z",
    currentPeriodEnd: "2026-11-01T00:00:00Z",
  });
});

test("getSubscription tolerates a body without period fields", async () => {
  // stub: 200 + 订阅对象（无周期字段）
  const result = await client.getSubscription("sub-2");
  expect(result.body?.currentPeriodStart).toBeUndefined();
  expect(result.body?.currentPeriodEnd).toBeUndefined();
});

test("getSubscription answers 404 as a null body", async () => {
  const result = await client.getSubscription("missing");
  expect(result.status).toBe(404);
  expect(result.body).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test server/tests/billing-lago-client.test.ts`
Expected: FAIL（`getSubscription` 不存在）。

- [ ] **Step 3: 实现**

`lago.ts` 类型与中和函数：

```ts
export type LagoSubscriptionBody = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: BillingSubscriptionStatus;
  /** The billing period the provider currently runs, when its API spells one. */
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
};
```

`subscriptionOf` 返回值追加：

```ts
    currentPeriodStart: optionalStringOf(item, "current_period_start"),
    currentPeriodEnd: optionalStringOf(item, "current_period_end"),
```

client 接口声明（与 `getUsage` 同一接口块）加：

```ts
  /** One subscription by its external id; 404 is "gone", answered as a null body. */
  getSubscription(
    externalSubscriptionId: string,
  ): Promise<LagoResult<LagoSubscriptionBody | null>>;
```

实现（放在 `listSubscriptions` 之后，风格对齐 `getCustomer`）：

```ts
    async getSubscription(externalSubscriptionId) {
      const result = await request(
        `/api/v1/subscriptions/${encodeURIComponent(externalSubscriptionId)}`,
      );
      if (result.status === 200) {
        return {
          status: 200,
          body: subscriptionOf(fieldOf(result.body, "subscription")),
        };
      }
      if (result.status === 404) return { status: 404, body: null };
      throw new BillingError("invalid_response");
    },
```

- [ ] **Step 4: 跑测试**

Run: `/opt/homebrew/bin/bun test server/tests/billing-lago-client.test.ts && /opt/homebrew/bin/bun run --filter server typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/billing/lago.ts server/tests/billing-lago-client.test.ts
git commit -m "feat(billing): lago 客户端读取订阅周期"
```

### Task 4: entitlements 订阅上下文（service + route）

**Files:**
- Modify: `server/src/billing/service.ts:160-170`（entitlement read 合并周期）
- Modify: `server/src/billing/routes.ts:62-68`（响应带 `planCode` 与 `subscription`）
- Test: `server/tests/billing-routes.test.ts`（或该文件已覆盖 entitlements 路由的用例处扩展）

**Interfaces:**
- Consumes: Task 3 的 `client.getSubscription`；Task 2 的 `BillingEntitlements.subscription`。
- Produces: `GET /api/billing/entitlements` 响应 `{ active, planCode?, codes: BillingEntitlementEntry[], subscription: { status, currentPeriodStart, currentPeriodEnd } | null }`。

- [ ] **Step 1: 写失败测试**

在 `server/tests/billing-routes.test.ts` 找到 entitlements 路由用例（grep `entitlements`），扩展断言：

```ts
test("GET /entitlements carries the subscription context", async () => {
  // 该文件现有的 service stub：store.readSubscriptions 返回一行 active，
  // client.getSubscription 返回 { status: 200, body: { …, currentPeriodStart: "2026-10-01T00:00:00Z", currentPeriodEnd: "2026-11-01T00:00:00Z" } }
  const response = await app.request("/api/billing/entitlements");
  const body = await response.json();
  expect(body).toEqual({
    active: true,
    planCode: "pro",
    codes: [{ code: "agents.pro" }],
    subscription: {
      status: "active",
      currentPeriodStart: "2026-10-01T00:00:00Z",
      currentPeriodEnd: "2026-11-01T00:00:00Z",
    },
  });
});

test("GET /entitlements degrades to a null subscription when the provider refuses", async () => {
  // client.getSubscription 抛 BillingError("unreachable") 时，读取本身不失败
  const response = await app.request("/api/billing/entitlements");
  const body = await response.json();
  expect(body.subscription).toBeNull();
  expect(body.active).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test server/tests/billing-routes.test.ts`
Expected: 新增用例 FAIL（响应里没有 `planCode`/`subscription`）。

- [ ] **Step 3: 实现**

`service.ts` entitlement read（reader 的 `read` 回调）改为：

```ts
    read: async (externalCustomerId): Promise<BillingEntitlements> => {
      const key = externalCustomerId ?? config.externalCustomerKey;
      const rows: readonly BillingSubscriptionRow[] =
        await store.readSubscriptions(key);
      const active = rows.find((row) => row.status === "active");
      if (!active) return { active: false, codes: [], subscription: null };
      // The subscription read is a courtesy beside the projection: a provider that refuses it
      // must not fail the entitlement read, whose answer gates the deployment.
      let subscription: BillingEntitlementSubscriptionContext | null = null;
      try {
        const remote = await client.getSubscription(active.externalSubscriptionId);
        if (remote.body) {
          subscription = {
            status: remote.body.status,
            currentPeriodStart: remote.body.currentPeriodStart ?? null,
            currentPeriodEnd: remote.body.currentPeriodEnd ?? null,
          };
        }
      } catch {
        subscription = null;
      }
      return {
        active: true,
        planCode: active.planCode,
        codes: deps.planEntitlements?.get(active.planCode) ?? [],
        subscription,
      };
    },
```

（import `BillingEntitlementSubscriptionContext`。）注意：该读有 10 分钟 TTL 缓存，周期随缓存最多滞后 10 分钟——规格已接受。

`routes.ts` entitlements handler：

```ts
  routes.get("/entitlements", async (context) => {
    const entitlements = await deps.service.entitlements();
    return context.json({
      active: entitlements.active,
      ...(entitlements.planCode !== undefined ? { planCode: entitlements.planCode } : {}),
      codes: entitlements.codes,
      subscription: entitlements.subscription ?? null,
    });
  });
```

- [ ] **Step 4: 跑测试与全量 billing 测试**

Run: `/opt/homebrew/bin/bun test server/tests/billing-routes.test.ts server/tests/billing-sync.test.ts && /opt/homebrew/bin/bun run --filter server typecheck`
Expected: PASS（billing-sync 若断言了 entitlement read 形状，补 `subscription: null`）。

- [ ] **Step 5: Commit**

```bash
git add server/src/billing/service.ts server/src/billing/routes.ts server/tests/billing-routes.test.ts server/tests/billing-sync.test.ts
git commit -m "feat(billing): entitlements 接口携带订阅上下文"
```

### Task 5: usage/daily 按天聚合端点

**Files:**
- Modify: `server/src/billing/types.ts`（`BillingUsageDailyBucket` / `BillingUsageDaily`、`BillingService.usageDaily`）
- Modify: `server/src/billing/service.ts`（聚合实现 + 60s TTL 缓存）
- Modify: `server/src/billing/routes.ts`（`GET /usage/daily`）
- Test: `server/tests/billing-usage-daily.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 结论的 `DAILY_PAGE_SIZE`（默认 100）；现有 `client.listEvents(externalSubscriptionId, perPage, page)` 与 `client.getUsage`。
- Produces: `usageDaily(externalCustomerId?: string): Promise<BillingUsageDaily>`；HTTP 响应 `{ fromDatetime?, toDatetime?, days: { date, tokens, inputTokens, outputTokens, calls }[], truncated }`。

- [ ] **Step 1: 写失败测试（新建文件）**

```ts
import { expect, test } from "bun:test";
import { createBillingService } from "../src/billing/service";
// ↑ 若该服务工厂不是这个名字/导出，照 billing-sync.test.ts 的构造方式来。

function event(overrides: Record<string, unknown>) {
  return {
    transactionId: crypto.randomUUID(),
    code: "llm.tokens",
    timestamp: "2026-10-03T12:00:00Z",
    properties: {},
    ...overrides,
  };
}

function serviceWith(events: ReturnType<typeof event>[], pages = 1) {
  const listEventsCalls: number[] = [];
  const service = createBillingService({
    config: { externalCustomerKey: "cust" } as never,
    store: {
      readSubscriptions: async () => [
        {
          externalCustomerId: "cust",
          externalSubscriptionId: "sub-1",
          planCode: "pro",
          status: "active",
        },
      ],
    } as never,
    client: {
      getUsage: async () => ({
        status: 200,
        body: { fromDatetime: "2026-10-01T00:00:00Z", toDatetime: "2026-11-01T00:00:00Z", charges: [] },
      }),
      listEvents: async (_sub: string, _perPage: number, page: number) => {
        listEventsCalls.push(page);
        return {
          status: 200,
          body: {
            events: pages >= page ? events : [],
            totalCount: events.length,
            totalPages: pages,
            currentPage: page,
            nextPage: page < pages ? page + 1 : null,
          },
        };
      },
    } as never,
    planEntitlements: new Map(),
  });
  return { service, listEventsCalls };
}

test("usageDaily buckets events by server-local day", async () => {
  const { service } = serviceWith([
    event({ timestamp: "2026-10-03T12:00:00Z", properties: { tokens: 100, input_tokens: 30, output_tokens: 70 } }),
    event({ timestamp: "2026-10-03T23:30:00Z", properties: { tokens: 50, input_tokens: 20, output_tokens: 30 } }),
    event({ timestamp: "2026-10-04T08:00:00Z", properties: { tokens: 10, input_tokens: 4, output_tokens: 6 } }),
    event({ timestamp: "2026-10-05T08:00:00Z", properties: {} }),
  ]);
  const daily = await service.usageDaily();
  expect(daily.truncated).toBe(false);
  expect(daily.days).toEqual([
    { date: expect.any(String), tokens: 150, inputTokens: 50, outputTokens: 100, calls: 2 },
    { date: expect.any(String), tokens: 10, inputTokens: 4, outputTokens: 6, calls: 1 },
    { date: expect.any(String), tokens: 0, inputTokens: 0, outputTokens: 0, calls: 1 },
  ]);
});

test("usageDaily stops at the page ceiling and reports truncation", async () => {
  // pages=60：50 页后仍有 nextPage
  const { service, listEventsCalls } = serviceWith([event({})], 60);
  const daily = await service.usageDaily();
  expect(daily.truncated).toBe(true);
  expect(listEventsCalls.length).toBe(50);
});

test("usageDaily is cached for the TTL window", async () => {
  const { service, listEventsCalls } = serviceWith([event({})], 1);
  await service.usageDaily();
  await service.usageDaily();
  expect(listEventsCalls.length).toBe(1);
});

test("usageDaily answers empty days without an active subscription", async () => {
  const service = createBillingService({
    config: { externalCustomerKey: "cust" } as never,
    store: { readSubscriptions: async () => [] } as never,
    client: {} as never,
    planEntitlements: new Map(),
  });
  const daily = await service.usageDaily();
  expect(daily).toEqual({ days: [], truncated: false });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test server/tests/billing-usage-daily.test.ts`
Expected: FAIL（`usageDaily` 不存在；若服务工厂签名不同，先照真实签名修正测试构造再确认 FAIL 是"缺方法"）。

- [ ] **Step 3: 实现**

`types.ts`：

```ts
/** One server-local day of metered usage, aggregated from the provider's event log. */
export type BillingUsageDailyBucket = {
  /** Local `yyyy-mm-dd`. */
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

/** The billing period's usage, bucketed by day, for a chart. */
export type BillingUsageDaily = {
  fromDatetime?: string;
  toDatetime?: string;
  days: readonly BillingUsageDailyBucket[];
  /** True when the page ceiling stopped the read before the provider ran out of events. */
  truncated: boolean;
};
```

`BillingService` 接口在 `usageEvents` 后追加：

```ts
  /** The active subscription's current-period usage bucketed by day, 60s-cached. */
  usageDaily(externalCustomerId?: string): Promise<BillingUsageDaily>;
```

`service.ts` 常量与实现（放在 `usageEvents` 实现之后）：

```ts
/** The daily aggregation's read window: per page, the ceiling, and how long an answer is reused. */
const DAILY_PAGE_SIZE = 100; // Task 1 实测上限不同则改此值
const DAILY_MAX_PAGES = 50;
const DAILY_TTL_MS = 60_000;

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
```

在服务工厂闭包内：

```ts
  const dailyCache = new Map<string, { value: BillingUsageDaily; expiresAt: number }>();
```

`usageDaily` 实现：

```ts
    async usageDaily(externalCustomerId) {
      const key = externalCustomerId ?? config.externalCustomerKey;
      const cached = dailyCache.get(key);
      if (cached && Date.now() < cached.expiresAt) return cached.value;
      const value = await (async (): Promise<BillingUsageDaily> => {
        const rows = await store.readSubscriptions(key);
        const active = rows.find((row) => row.status === "active");
        if (!active) return { days: [], truncated: false };
        const usage = await client.getUsage(key, active.externalSubscriptionId);
        const buckets = new Map<string, BillingUsageDailyBucket>();
        let truncated = false;
        for (let page = 1; page <= DAILY_MAX_PAGES; page += 1) {
          const result = await client.listEvents(active.externalSubscriptionId, DAILY_PAGE_SIZE, page);
          const body = result.body;
          if (!body) break;
          for (const event of body.events) {
            const when = new Date(event.timestamp);
            const date = dayKey(when);
            const bucket = buckets.get(date) ?? { date, tokens: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
            bucket.tokens += event.tokens ?? 0;
            bucket.inputTokens += event.inputTokens ?? 0;
            bucket.outputTokens += event.outputTokens ?? 0;
            bucket.calls += 1;
            buckets.set(date, bucket);
          }
          if (body.nextPage === null) break;
          if (page === DAILY_MAX_PAGES) truncated = true;
        }
        const days = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
        return {
          ...(usage.body?.fromDatetime !== undefined ? { fromDatetime: usage.body.fromDatetime } : {}),
          ...(usage.body?.toDatetime !== undefined ? { toDatetime: usage.body.toDatetime } : {}),
          days,
          truncated,
        };
      })();
      dailyCache.set(key, { value, expiresAt: Date.now() + DAILY_TTL_MS });
      return value;
    },
```

`routes.ts`（`/usage/events` 之后）：

```ts
  routes.get("/usage/daily", async (context) => {
    return context.json(await deps.service.usageDaily());
  });
```

- [ ] **Step 4: 跑测试**

Run: `/opt/homebrew/bin/bun test server/tests/billing-usage-daily.test.ts server/tests/billing-routes.test.ts && /opt/homebrew/bin/bun run --filter server typecheck`
Expected: PASS（「按服务器本地日分桶」断言里 `expect.any(String)` 已规避时区脆弱性；跨天事件同桶断言依赖测试机时区固定即可，无需 tz 设置）。

- [ ] **Step 5: Commit**

```bash
git add server/src/billing/types.ts server/src/billing/service.ts server/src/billing/routes.ts server/tests/billing-usage-daily.test.ts
git commit -m "feat(billing): 按天用量聚合端点 /usage/daily"
```

### Task 6: 前端基建——类型、共享格式化与 BillingEmpty

**Files:**
- Modify: `app/src/lib/billing/queries.ts`（类型对齐 + daily 查询）
- Create: `app/src/lib/billing/format.ts`（`money` / `period` / `totalTokensOf`）
- Create: `app/src/components/billing/billing-empty.tsx`
- Modify: `app/src/routes/_authed/settings/billing.tsx:42-50`（旧页对 entries 的最小兼容，一行改 `code.code`；Task 7 整文件重写）
- Test: `app/tests/billing-format.test.tsx`、`app/tests/billing-empty.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 HTTP 响应形状。
- Produces: `BillingEntitlementEntry` / `BillingEntitlements`（前端版）；`billingUsageDailyQueryOptions`（queryKey `["billing","usage-daily"]`，staleTime 0）；`money(cents, currency?)` / `period(from?, to?)` / `totalTokensOf(charges)`；`<BillingEmpty message />`。

- [ ] **Step 1: 写失败测试**

`app/tests/billing-format.test.tsx`：

```tsx
import { describe, expect, test } from "bun:test";
import { money, period, totalTokensOf } from "@/lib/billing/format";

describe("money", () => {
  test("formats cents in the plan's currency", () => {
    expect(money(19900, "CNY")).toContain("199");
  });
  test("tolerates a missing currency", () => {
    expect(money(100, undefined)).toBeTruthy();
  });
});

describe("period", () => {
  test("joins both ends with an en dash", () => {
    const text = period("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
    expect(text).toContain("–");
  });
  test("answers empty for a missing period", () => {
    expect(period(undefined, undefined)).toBe("");
  });
});

describe("totalTokensOf", () => {
  test("sums the units of every charge", () => {
    expect(totalTokensOf([{ units: "1.5" }, { units: "2" }])).toBe(3.5);
  });
  test("treats a non-numeric unit as zero", () => {
    expect(totalTokensOf([{ units: "abc" }])).toBe(0);
  });
});
```

`app/tests/billing-empty.test.tsx`：

```tsx
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, screen } from "@testing-library/react";
import { BillingEmpty } from "@/components/billing/billing-empty";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("BillingEmpty renders the message and a link to subscribe", () => {
  render(<BillingEmpty message="这个部署没有生效中的套餐。" />);
  expect(screen.getByText("这个部署没有生效中的套餐。")).toBeTruthy();
  const link = screen.getByRole("link", { name: /订阅/ });
  expect(link.getAttribute("href")).toContain("/settings/billing/subscribe");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test app/tests/billing-format.test.tsx app/tests/billing-empty.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`app/src/lib/billing/format.ts`：

```ts
/** Whole currency units from cents, in the reader's own locale and the plan's own currency. */
export function money(cents: number, currency?: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    ...(currency ? { currency } : {}),
  }).format(cents / 100);
}

/** The period as one line: "Oct 1 – Oct 31, 2026", in the reader's locale. */
export function period(from?: string, to?: string): string {
  if (from === undefined && to === undefined) return "";
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const fromPart = from === undefined ? "" : format.format(new Date(from));
  const toPart = to === undefined ? "" : format.format(new Date(to));
  return fromPart && toPart ? `${fromPart} – ${toPart}` : fromPart || toPart;
}

/** A charge's `units` is a string decimal; the token total is the sum across charges. */
export function totalTokensOf(charges: readonly { units: string }[]): number {
  return charges.reduce((sum, charge) => sum + (Number(charge.units) || 0), 0);
}
```

`app/src/lib/billing/queries.ts` 类型与查询：

```ts
export type BillingEntitlementEntry = {
  code: string;
  label?: string;
  description?: string;
};

export type BillingEntitlementSubscription = {
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};

export type BillingEntitlements = {
  active: boolean;
  planCode?: string;
  codes: BillingEntitlementEntry[];
  subscription?: BillingEntitlementSubscription | null;
};

export type BillingUsageDailyBucket = {
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

export type BillingUsageDaily = {
  fromDatetime?: string;
  toDatetime?: string;
  days: BillingUsageDailyBucket[];
  truncated: boolean;
};
```

`billingKeys` 加 `usageDaily: ["billing", "usage-daily"] as const`；查询：

```ts
/** The period's daily buckets. Always fresh, like every usage answer. */
export const usageDailyQueryOptions = queryOptions({
  queryKey: billingKeys.usageDaily,
  staleTime: 0,
  queryFn: async (): Promise<BillingUsageDaily> => {
    const response = await client("/api/billing/usage/daily", {
      fallback: "Your daily usage could not be loaded.",
    });
    return response.json();
  },
});
```

`app/src/components/billing/billing-empty.tsx`：

```tsx
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

/** The one empty state all three billing pages share: a sentence and the way out. */
export function BillingEmpty({ message }: { message: string }) {
  const { t } = useTranslation("settings");
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{message}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button
          render={(props) => (
            <Link to="/settings/billing/subscribe" {...props} />
          )}
        >
          {t("billing.goSubscribe")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
```

旧 `billing.tsx` 第 43 行 `{entitlements.data.codes.map((code) => (` 内的 `{code}` 改为 `{code.code}`、`key={code}` 改为 `key={code.code}`（整文件 Task 7 重写，此处只保 typecheck 绿）。

- [ ] **Step 4: 跑测试与 app 类型检查**

Run: `/opt/homebrew/bin/bun test app/tests/billing-format.test.tsx app/tests/billing-empty.test.tsx && /opt/homebrew/bin/bun run --filter app typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/billing/queries.ts app/src/lib/billing/format.ts app/src/components/billing/billing-empty.tsx app/src/routes/_authed/settings/billing.tsx app/tests/billing-format.test.tsx app/tests/billing-empty.test.tsx
git commit -m "feat(app): 计费前端基建——类型/格式化/空态"
```

### Task 7: 权益页重写

**Files:**
- Create: `app/src/components/billing/subscription-hero.tsx`
- Create: `app/src/components/billing/entitlement-icon.tsx`
- Rewrite: `app/src/routes/_authed/settings/billing.tsx`
- Modify: `app/src/locales/zh-CN/settings.json`、`app/src/locales/en/settings.json`
- Test: `app/tests/billing-hero.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `BillingEntitlements` / `BillingEmpty` / `money` / `period`。
- Produces: `<SubscriptionHero planCode status currentPeriodStart currentPeriodEnd />`；`entitlementIconFor(code: string)` 返回 tabler 图标组件。

- [ ] **Step 1: 写失败测试**

`app/tests/billing-hero.test.tsx`：

```tsx
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, screen } from "@testing-library/react";
import { SubscriptionHero } from "@/components/billing/subscription-hero";
import { entitlementIconFor } from "@/components/billing/entitlement-icon";
import { IconShieldCheck } from "@tabler/icons-react";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("SubscriptionHero shows the plan, the active badge and the period", () => {
  render(
    <SubscriptionHero
      planCode="pro-monthly"
      status="active"
      currentPeriodStart="2026-10-01T00:00:00Z"
      currentPeriodEnd="2026-11-01T00:00:00Z"
    />,
  );
  expect(screen.getByText("pro-monthly")).toBeTruthy();
  expect(screen.getByText("生效中")).toBeTruthy();
  expect(screen.getByText(/–/)).toBeTruthy();
});

test("SubscriptionHero marks a non-active status without a period", () => {
  render(<SubscriptionHero planCode="pro" status="canceled" currentPeriodStart={null} currentPeriodEnd={null} />);
  expect(screen.getByText("未生效")).toBeTruthy();
});

test("entitlementIconFor falls back to the shield", () => {
  expect(entitlementIconFor("weird.custom.code")).toBe(IconShieldCheck);
  expect(entitlementIconFor("agents.pro")).not.toBe(IconShieldCheck);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test app/tests/billing-hero.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现组件与页面**

`app/src/components/billing/entitlement-icon.tsx`：

```tsx
import {
  IconBolt,
  IconDatabase,
  IconDeviceDesktopAnalytics,
  IconPlug,
  IconRobot,
  IconShieldCheck,
  IconSparkles,
} from "@tabler/icons-react";
import type * as React from "react";

const RULES: readonly (readonly [RegExp, React.ComponentType<{ className?: string }>])[] = [
  [/agent|bot/i, IconRobot],
  [/model|llm|token/i, IconSparkles],
  [/skill|tool/i, IconBolt],
  [/connector|integration|link/i, IconPlug],
  [/computer|browser|sandbox|run/i, IconDeviceDesktopAnalytics],
  [/data|storage|knowledge/i, IconDatabase],
];

/** A code's own words pick its icon; an unrecognized code earns the shield. */
export function entitlementIconFor(code: string): React.ComponentType<{ className?: string }> {
  for (const [pattern, icon] of RULES) {
    if (pattern.test(code)) return icon;
  }
  return IconShieldCheck;
}
```

`app/src/components/billing/subscription-hero.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { period } from "@/lib/billing/format";
import { cn } from "@/lib/utils";

/** The deployment's current subscription, one card: what, how alive, until when. */
export function SubscriptionHero({
  planCode,
  status,
  currentPeriodStart,
  currentPeriodEnd,
}: {
  planCode: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}) {
  const { t } = useTranslation("settings");
  const active = status === "active";
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t("billing.heroTitle")}</p>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-medium",
            active
              ? "bg-success/10 text-success"
              : "bg-muted text-muted-foreground",
          )}
        >
          {active ? t("billing.statusActive") : t("billing.statusOther")}
        </span>
      </div>
      <p className="mt-1 font-mono text-lg font-semibold">{planCode}</p>
      {currentPeriodStart && currentPeriodEnd ? (
        <p className="text-muted-foreground mt-1 text-sm tabular-nums">
          {t("billing.periodLabel")} · {period(currentPeriodStart, currentPeriodEnd)}
        </p>
      ) : null}
    </div>
  );
}
```

`app/src/routes/_authed/settings/billing.tsx` 整文件：

```tsx
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { entitlementIconFor } from "@/components/billing/entitlement-icon";
import { BillingEmpty } from "@/components/billing/billing-empty";
import { SubscriptionHero } from "@/components/billing/subscription-hero";
import {
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { entitlementsQueryOptions } from "@/lib/billing/queries";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authed/settings/billing")({
  component: RouteComponent,
});

/**
 * What this deployment is entitled to.
 *
 * The hero is the server's subscription word; the grid is the plan's own copy, verbatim from the
 * deployment's configuration. An administrator changes the plan (Admin → Billing → Sync, or at
 * the provider); everybody else reads the result here.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const entitlements = useQuery(entitlementsQueryOptions);

  return (
    <PageShell
      title={t("billing.title")}
      description={t("billing.description")}
      width="wide"
    >
      {entitlements.isPending ? (
        <div className="mt-4 space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : entitlements.error ? (
        <div className="mt-4">
          <p className="text-destructive text-sm">{(entitlements.error as Error).message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void entitlements.refetch()}
          >
            {t("billing.retry")}
          </Button>
        </div>
      ) : !entitlements.data.active ? (
        <div className="mt-4">
          <BillingEmpty message={t("billing.inactive")} />
        </div>
      ) : (
        <>
          <SubscriptionHero
            planCode={entitlements.data.planCode ?? ""}
            status={entitlements.data.subscription?.status ?? "active"}
            currentPeriodStart={entitlements.data.subscription?.currentPeriodStart ?? null}
            currentPeriodEnd={entitlements.data.subscription?.currentPeriodEnd ?? null}
          />
          <div className="mt-6">
            <PageSection
              title={t("billing.includedTitle")}
              description={t("billing.includedDescription")}
            >
              {entitlements.data.codes.length === 0 ? (
                <p className="text-muted-foreground mt-2 text-sm">{t("billing.noCodes")}</p>
              ) : (
                <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {entitlements.data.codes.map((entry) => {
                    const Icon = entitlementIconFor(entry.code);
                    return (
                      <li
                        key={entry.code}
                        className="flex items-start gap-3 rounded-xl border bg-card p-4"
                      >
                        <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{entry.label ?? entry.code}</p>
                          {entry.description ? (
                            <p className="text-muted-foreground mt-0.5 text-sm">
                              {entry.description}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </PageSection>
          </div>
        </>
      )}
    </PageShell>
  );
}
```

i18n 追加（zh-CN 在 `billing` 对象内；en 对应翻译）：

```jsonc
// zh-CN
"heroTitle": "当前订阅",
"statusActive": "生效中",
"statusOther": "未生效",
"periodLabel": "本周期",
"goSubscribe": "去订阅",
"retry": "重试"
// en
"heroTitle": "Current subscription",
"statusActive": "Active",
"statusOther": "Not active",
"periodLabel": "Billing period",
"goSubscribe": "Subscribe now",
"retry": "Retry"
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `/opt/homebrew/bin/bun test app/tests/billing-hero.test.tsx && /opt/homebrew/bin/bun run --filter app typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/components/billing/subscription-hero.tsx app/src/components/billing/entitlement-icon.tsx app/src/routes/_authed/settings/billing.tsx app/src/locales/zh-CN/settings.json app/src/locales/en/settings.json app/tests/billing-hero.test.tsx
git commit -m "feat(app): 权益页商业化重写——hero 卡与权益清单"
```

### Task 8: 订阅页重写

**Files:**
- Create: `app/src/components/billing/price-card.tsx`
- Create: `app/src/components/billing/provider-segmented.tsx`
- Create: `app/src/components/billing/checkout-card.tsx`
- Rewrite: `app/src/routes/_authed/settings/billing_.subscribe.tsx`（轮询/恢复/取消等逻辑原样搬移）
- Modify: 两个 `settings.json`
- Test: `app/tests/billing-subscribe-ui.test.tsx`

**Interfaces:**
- Consumes: `payments.ts` 现有类型与查询（零改动）；`money`。
- Produces: `<PriceCard entry selected onSelect disabled />`；`<ProviderSegmented providers value onChange />`；`<CheckoutCard view now onCancel cancelPending cancelError onDismiss />`。

- [ ] **Step 1: 写失败测试**

`app/tests/billing-subscribe-ui.test.tsx`：

```tsx
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PriceCard } from "@/components/billing/price-card";
import { ProviderSegmented } from "@/components/billing/provider-segmented";
import { CheckoutCard } from "@/components/billing/checkout-card";
import type { PurchaseOrderView } from "@/lib/billing/payments";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const entry = { planCode: "pro", amountCents: 19900, currency: "CNY" as const, periodMonths: 1 };

test("PriceCard toggles selection on click", () => {
  let selected = false;
  const { rerender } = render(
    <PriceCard entry={entry} selected={selected} onSelect={() => { selected = true; rerender(
      <PriceCard entry={entry} selected={selected} onSelect={() => {}} disabled={false} />,
    ); }} disabled={false} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /pro/ }));
  expect(screen.getByRole("button", { name: /pro/ }).getAttribute("aria-pressed")).toBe("true");
});

test("CheckoutCard shows a destructive countdown under 20% remaining", () => {
  const createdAt = "2026-10-10T10:00:00Z";
  const expiresAt = "2026-10-10T10:15:00Z";
  const view: PurchaseOrderView = {
    orderId: "o1", planCode: "pro", provider: "alipay", amountCents: 19900, currency: "CNY",
    status: "pending", activationState: "pending",
    checkout: { kind: "qrcode", payload: "https://qr.example/pay" },
    expiresAt, periodEnd: null, createdAt,
  };
  const { container } = render(
    <CheckoutCard view={view} now={Date.parse("2026-10-10T10:14:30Z")}
      onCancel={() => {}} cancelPending={false} cancelError={null} onDismiss={() => {}} />,
  );
  const bar = container.querySelector('[role="progressbar"]');
  expect(bar).toBeTruthy();
  // 剩 30 秒 / 总 15 分钟 = ~3.3% < 20% → destructive
  expect(bar?.getAttribute("aria-valuenow")).toBe("3");
  expect(bar?.firstChild?.className).toContain("bg-destructive");
});

test("CheckoutCard shows the success state for a paid order", () => {
  const view: PurchaseOrderView = {
    orderId: "o2", planCode: "pro", provider: "alipay", amountCents: 19900, currency: "CNY",
    status: "paid", activationState: "applied", checkout: null,
    expiresAt: "2026-10-10T10:15:00Z", periodEnd: null, createdAt: "2026-10-10T10:00:00Z",
  };
  render(
    <CheckoutCard view={view} now={Date.parse("2026-10-10T10:05:00Z")}
      onCancel={() => {}} cancelPending={false} cancelError={null} onDismiss={() => {}} />,
  );
  expect(screen.getByText("已收到付款，套餐已生效。")).toBeTruthy();
});

test("ProviderSegmented renders one option per configured channel", () => {
  render(<ProviderSegmented providers={["alipay", "wechat"]} value="alipay" onChange={() => {}} />);
  expect(screen.getByRole("button", { name: "支付宝" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "微信支付" })).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test app/tests/billing-subscribe-ui.test.tsx`
Expected: FAIL（三个组件不存在）。

- [ ] **Step 3: 实现三个组件**

`app/src/components/billing/price-card.tsx`：

```tsx
import { IconCircleCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { money } from "@/lib/billing/format";
import type { PurchasePlanEntry } from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/** One plan as a card: its code, its price, and whether it is the one being bought. */
export function PriceCard({
  entry,
  selected,
  onSelect,
  disabled,
}: {
  entry: PurchasePlanEntry;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "relative rounded-xl border bg-card p-4 text-left transition-colors",
        selected ? "border-primary ring-primary/30 ring-2" : "hover:border-foreground/20",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <span className="font-mono text-sm">{entry.planCode}</span>
      <span className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">
          {money(entry.amountCents, entry.currency)}
        </span>
        <span className="text-muted-foreground text-sm">
          /{t("subscribe.perMonthShort")}
        </span>
      </span>
      {selected ? (
        <IconCircleCheck className="text-primary absolute top-3 right-3 size-5" />
      ) : null}
    </button>
  );
}
```

`app/src/components/billing/provider-segmented.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import type { PurchaseProvider } from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/** The channels this deployment configured, as one segmented row. */
export function ProviderSegmented({
  providers,
  value,
  onChange,
}: {
  providers: PurchaseProvider[];
  value: PurchaseProvider;
  onChange: (provider: PurchaseProvider) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div
      role="radiogroup"
      aria-label={t("subscribe.providerTitle")}
      className="border-input inline-flex rounded-lg border p-0.5"
    >
      {providers.map((provider) => (
        <button
          key={provider}
          type="button"
          role="radio"
          aria-checked={value === provider}
          onClick={() => onChange(provider)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm transition-colors",
            value === provider
              ? "bg-foreground/5 font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`subscribe.provider.${provider}`)}
        </button>
      ))}
    </div>
  );
}
```

`app/src/components/billing/checkout-card.tsx`：

```tsx
import { IconCircleCheck } from "@tabler/icons-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { QrCode } from "@/components/billing/qr-code";
import type { PurchaseOrderView } from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/** mm:ss against the QR's own expiry. */
function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The order in flight, from QR to outcome: presentation only — the polling that keeps this honest
 * lives in the page that owns the order.
 */
export function CheckoutCard({
  view,
  now,
  onCancel,
  cancelPending,
  cancelError,
  onDismiss,
}: {
  view: PurchaseOrderView;
  now: number;
  onCancel: () => void;
  cancelPending: boolean;
  cancelError: string | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("settings");

  if (view.status !== "pending") {
    const paid = view.status === "paid";
    const text = (() => {
      if (paid) {
        if (view.activationState === "applied") return t("subscribe.statusPaid");
        if (view.activationState === "pending") return t("subscribe.statusPaidActivating");
        return t("subscribe.statusPaidFailed");
      }
      if (view.status === "canceled") return t("subscribe.statusCanceled");
      if (view.status === "expired") return t("subscribe.statusExpired");
      return t("subscribe.statusBlocked");
    })();
    const good = paid && view.activationState === "applied";
    return (
      <div className="flex flex-col items-center py-8 text-center">
        {good ? (
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
          >
            <IconCircleCheck className="text-success size-12" />
          </motion.div>
        ) : null}
        <p className="mt-3 text-sm">{text}</p>
        <Button size="sm" className="mt-4" onClick={onDismiss}>
          {t("subscribe.backToPlans")}
        </Button>
      </div>
    );
  }

  const expiredLocally = Date.parse(view.expiresAt) <= now;
  const qr =
    view.checkout?.kind === "qrcode" && !expiredLocally ? view.checkout : null;

  if (expiredLocally) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <p className="text-sm">{t("subscribe.statusExpired")}</p>
        <Button size="sm" className="mt-4" onClick={onDismiss}>
          {t("subscribe.backToPlans")}
        </Button>
      </div>
    );
  }

  // The bar's denominator is the order's own lifetime, so a resumed order starts mid-bar.
  const totalMs = Math.max(1, Date.parse(view.expiresAt) - Date.parse(view.createdAt));
  const remainingMs = Math.max(0, Date.parse(view.expiresAt) - now);
  const pct = Math.max(0, Math.min(1, remainingMs / totalMs));

  return (
    <div className="flex flex-col items-center py-4">
      {qr ? <QrCode payload={qr.payload} /> : null}
      <div
        role="progressbar"
        aria-label={t("subscribe.countdownAria")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
        className="bg-muted mt-4 h-1.5 w-full max-w-xs overflow-hidden rounded-full"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-1000 ease-linear",
            pct < 0.2 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <p className="mt-2 text-sm tabular-nums">
        {t("subscribe.expiresIn", { time: remaining(view.expiresAt, now) })}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">{t("subscribe.statusPending")}</p>
      <div className="mt-4">
        <Button variant="outline" size="sm" disabled={cancelPending} onClick={onCancel}>
          {t("subscribe.cancel")}
        </Button>
        {cancelError ? (
          <p className="text-destructive mt-2 text-sm">{cancelError}</p>
        ) : null}
      </div>
    </div>
  );
}
```

`app/src/components/billing/qr-code.tsx`：把现有 `billing_.subscribe.tsx:158-203` 的 `QrCode` 组件**原样搬入**（含 `key={payload}` 防错位约束与占位骨架），仅删除文件内局部化处理。

- [ ] **Step 4: 重写页面（逻辑原样、外壳更新）**

`billing_.subscribe.tsx` 重写规则（执行者须先读旧文件再动手）：

1. 保留：`POLL_INTERVAL_MS`、`MAX_POLL_ATTEMPTS`、`PurchaseFlow` 的全部轮询/失效/恢复逻辑、`RouteComponent` 的恢复 effect、`PlanChooser` 的预选/预选渠道/409 处理/setQueryData 种子。
2. 删除：`PlanRow`、`ProviderRow`、`QrCode`、`OutcomeCard`、本地 `money`/`remaining`（改从 `@/lib/billing/format` 与 `CheckoutCard` 来）。
3. 新外壳：
   - `PageShell width="wide"`；
   - 有 activePlanCode 时渲染状态卡（`rounded-xl border bg-card p-5`：`t("subscribe.statusCardTitle")` + planCode + 指向 `/settings/billing` 的链接 `t("subscribe.viewEntitlements")`）；
   - `PlanChooser` 里 `PageSection` 下用 `grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3` 渲染 `<PriceCard>`；渠道区渲染 `<ProviderSegmented>`；
   - 分隔线（`<hr className="my-6" />`）下意向条：`flex items-center justify-between`——左侧 `{planCode} · {money(amountCents, currency)}`（`text-sm tabular-nums`，planCode 未选时显示 `t("subscribe.noPlans")` 不渲染价格），右侧现有 `<Button>` 继续支付 + `create.error` 文案；
   - `canPurchase=false` 时 PriceCard 全部 `disabled`（替换现有 `notAdmin` 整页空态，文案保留在卡片上方一行）；
   - `PurchaseFlow` 渲染 `<CheckoutCard view={view} now={now} onCancel={() => cancel.mutate()} cancelPending={cancel.isPending} cancelError={cancel.error ? (cancel.error as Error).message : null} onDismiss={dismiss} />`（秒级 `now` state 原样保留在 PurchaseFlow 内）。

i18n 追加：

```jsonc
// zh-CN（subscribe 对象内）
"statusCardTitle": "当前订阅",
"viewEntitlements": "查看权益",
"perMonthShort": "月",
"countdownAria": "支付剩余时间"
// en
"statusCardTitle": "Current subscription",
"viewEntitlements": "View entitlements",
"perMonthShort": "mo",
"countdownAria": "Time left to pay"
```

- [ ] **Step 5: 跑测试、类型检查与全量相关测试**

Run: `/opt/homebrew/bin/bun test app/tests/billing-subscribe-ui.test.tsx && /opt/homebrew/bin/bun run --filter app typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add app/src/components/billing/price-card.tsx app/src/components/billing/provider-segmented.tsx app/src/components/billing/checkout-card.tsx app/src/components/billing/qr-code.tsx app/src/routes/_authed/settings/billing_.subscribe.tsx app/src/locales/zh-CN/settings.json app/src/locales/en/settings.json app/tests/billing-subscribe-ui.test.tsx
git commit -m "feat(app): 订阅页商业化重写——价格卡与卡片化支付流程"
```

### Task 9: 使用记录页重写（含 recharts）

**Files:**
- Modify: `app/package.json`（`bun add recharts`）
- Create: `app/src/components/billing/kpi-card.tsx`
- Create: `app/src/components/billing/usage-chart.tsx`
- Rewrite: `app/src/routes/_authed/settings/usage.tsx`（`?eventsPage=` search 校验、pager、staleTime 0 语义原样）
- Modify: 两个 `settings.json`
- Test: `app/tests/billing-usage-ui.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `/api/billing/usage/daily`（经 `usageDailyQueryOptions`）；Task 6 的 `money`/`period`/`totalTokensOf`。
- Produces: `<KpiCard label value hint? />`；`fillDays(from, to, days)`（补零日序列，纯函数）；`<UsageChart daily />`。

- [ ] **Step 1: 安装 recharts**

```bash
cd /Users/wuyongjun/trea/OpenBot/app && /opt/homebrew/bin/bun add recharts
```

- [ ] **Step 2: 写失败测试**

`app/tests/billing-usage-ui.test.tsx`：

```tsx
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, screen } from "@testing-library/react";
import { KpiCard } from "@/components/billing/kpi-card";
import { fillDays } from "@/components/billing/usage-chart";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("KpiCard renders label and value", () => {
  render(<KpiCard label="总 tokens" value="1,204,556" />);
  expect(screen.getByText("总 tokens")).toBeTruthy();
  expect(screen.getByText("1,204,556")).toBeTruthy();
});

describe("fillDays", () => {
  test("fills the missing days with zero buckets", () => {
    const filled = fillDays(
      "2026-10-01T00:00:00Z",
      "2026-10-04T00:00:00Z",
      [{ date: "2026-10-02", tokens: 5, inputTokens: 2, outputTokens: 3, calls: 1 }],
    );
    expect(filled.map((day) => day.date)).toEqual([
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
    expect(filled[1].tokens).toBe(5);
    expect(filled[0].tokens).toBe(0);
  });
  test("caps a pathological span at 62 days", () => {
    const filled = fillDays("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", []);
    expect(filled.length).toBeLessThanOrEqual(62);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `/opt/homebrew/bin/bun test app/tests/billing-usage-ui.test.tsx`
Expected: FAIL。

- [ ] **Step 4: 实现组件**

`app/src/components/billing/kpi-card.tsx`：

```tsx
/** One number a person reads first: the label says what it counts, the value says how much. */
export function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-muted-foreground text-sm">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}
```

`app/src/components/billing/usage-chart.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BillingUsageDaily } from "@/lib/billing/queries";

/** Zero-filled local days from the period start to its end, capped at 62. */
export function fillDays(
  from: string | undefined,
  to: string | undefined,
  days: BillingUsageDaily["days"],
): BillingUsageDaily["days"] {
  if (from === undefined || to === undefined) return [...days];
  const byDate = new Map(days.map((day) => [day.date, day]));
  const filled: BillingUsageDaily["days"] = [];
  const cursor = new Date(from);
  const end = new Date(to);
  const empty = (date: string) => ({ date, tokens: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
  while (cursor.getTime() <= end.getTime() && filled.length < 62) {
    const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    filled.push(byDate.get(date) ?? empty(date));
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

/** The period's daily tokens, one bar per day, in the design system's own chart token. */
export function UsageChart({ daily }: { daily: BillingUsageDaily }) {
  const { t } = useTranslation("settings");
  const data = fillDays(daily.fromDatetime, daily.toDatetime, daily.days);
  if (data.length === 0) {
    return <p className="text-muted-foreground mt-2 text-sm">{t("usagePage.chartEmpty")}</p>;
  }
  return (
    <div className="mt-4">
      <div role="img" aria-label={t("usagePage.trendTitle")} className="h-60 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11 }}
              tickFormatter={(value: string, index: number) =>
                index === 0 || index === data.length - 1 || value.endsWith("-01")
                  ? value.slice(5)
                  : ""
              }
            />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={48} />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.4 }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="rounded-lg border bg-card px-3 py-2 text-xs">
                    <p className="font-medium tabular-nums">{String(label)}</p>
                    <p className="text-muted-foreground mt-1 tabular-nums">
                      {t("usagePage.eventTokens")}: {payload[0]?.value as number}
                    </p>
                    <p className="text-muted-foreground tabular-nums">
                      {t("usagePage.eventIn")}: {(payload[0]?.payload as { inputTokens: number }).inputTokens} · {t("usagePage.eventOut")}: {(payload[0]?.payload as { outputTokens: number }).outputTokens}
                    </p>
                  </div>
                ) : null
              }
            />
            <Bar dataKey="tokens" fill="var(--chart-2)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {daily.truncated ? (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("usagePage.trendTruncated", {
            total: daily.days.reduce((sum, day) => sum + day.calls, 0),
          })}
        </p>
      ) : null}
    </div>
  );
}
```

`usage.tsx` 重写规则（执行者先读旧文件）：

1. 保留：`validateSearch`、`EventsPager`、staleTime 0 的两个查询；`money`/`period` 改 import `@/lib/billing/format`。
2. 新结构（`PageShell width="wide"`）：
   - 无订阅 → `BillingEmpty`（`t("usagePage.noSubscription")`）；
   - KPI 行：`grid grid-cols-1 gap-3 md:grid-cols-3`——合计 `money(totalAmountCents, currency)`（label 用新 key `t("usagePage.kpiTotal")`，不动旧 key `totalThisPeriod`）、`totalTokensOf(charges)` 千分位（`Intl.NumberFormat().format`）、事件数 `events.data.pagination.totalCount`；
   - 趋势卡：`PageSection title={t("usagePage.trendTitle")} description={period(from, to)}` 内 `<UsageChart daily={daily.data} />`（daily 用 `usageDailyQueryOptions`；isPending 时 Skeleton `h-60`；error 时沿用错误+重试模式）；
   - charges 表：`<table className="w-full text-sm">` 表头 计费项/`t("usagePage.eventTokens")`/金额，数字列 `text-right tabular-nums`（金额用 `money(charge.amountCents, currency)`，units 原样字符串）；
   - 事件表：表头 `columnTime/columnMetric/eventIn/eventOut/eventTokens`，行渲染时间（现有 DateTimeFormat 短格式）、`metricCode`（`font-mono`）、in/out/tokens 右对齐；`EventsPager` 原样置于表下；
   - loading：KPI 三张 Skeleton 卡 + `h-60` Skeleton + 表格 Skeleton 行；
   - 错误：`usage.error` / `daily.error` / `events.error` 各自渲染「message（`text-destructive text-sm`）+ 重试按钮（`variant="outline" size="sm"`，`onClick={() => void query.refetch()}`）」，与 Task 7 权益页同一模式。
3. `usage.data.active === false` 时**不请求** daily/events（保持现有条件渲染顺序，daily 查询放在 active 分支内的子组件或 `enabled` 由调用处控制——用子组件 `<UsageBody usage={usage.data} eventsPage={eventsPage} />` 承载，内部再挂 daily/events 两个 useQuery，天然满足条件）。

i18n 追加：

```jsonc
// zh-CN（usagePage 对象内）
"kpiTotal": "本周期合计",
"kpiTokens": "总 tokens",
"kpiEvents": "计量事件",
"trendTitle": "用量趋势（按天）",
"trendTruncated": "图内仅含最近 {{total}} 条事件",
"chartEmpty": "本周期还没有按天用量。",
"columnTime": "时间",
"columnMetric": "指标"
// en
"kpiTotal": "Total this period",
"kpiTokens": "Total tokens",
"kpiEvents": "Metered events",
"trendTitle": "Daily usage",
"trendTruncated": "Chart covers the most recent {{total}} events only",
"chartEmpty": "No daily usage in this period yet.",
"columnTime": "Time",
"columnMetric": "Metric"
```

- [ ] **Step 5: 跑测试、类型检查**

Run: `/opt/homebrew/bin/bun test app/tests/billing-usage-ui.test.tsx && /opt/homebrew/bin/bun run --filter app typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add app/package.json bun.lock app/src/components/billing/kpi-card.tsx app/src/components/billing/usage-chart.tsx app/src/routes/_authed/settings/usage.tsx app/src/locales/zh-CN/settings.json app/src/locales/en/settings.json app/tests/billing-usage-ui.test.tsx
git commit -m "feat(app): 使用记录页商业化重写——KPI 与按天趋势图"
```

### Task 10: e2e 断言更新与全量门禁

**Files:**
- Modify: `tests/e2e/browser.e2e.ts:885-895` 附近（billing 断言适配新结构）
- 无新测试文件。

**Interfaces:**
- Consumes: 全部前序任务的最终 UI 结构。

- [ ] **Step 1: 更新 e2e 断言**

现有断言（`gotoRetry(page, …/settings/billing)` 后等待页面文本可见）保持路由不变；把等待文本从旧文案换成新结构里稳定存在的 `权益`（页面 title 不变，多数情况无需改动），并追加一步：

```ts
await step("使用记录页呈现 KPI 与趋势", async () => {
  await gotoRetry(page, `${APP_URL}/settings/usage`);
  const kpi = page.getByText(/总 tokens|Total tokens/);
  await kpi.first().waitFor({ state: "visible", timeout: 20000 });
});
```

（沿用该文件 `step` 辅助的实际签名——先读文件头再落笔；若部署无活跃订阅，该步看到的是空态而非 KPI，断言改为「KPI 或 空态文案 二者其一可见」。）

- [ ] **Step 2: 全量门禁**

Run（仓库根目录，依序）:

```bash
/opt/homebrew/bin/bun run typecheck
/opt/homebrew/bin/bun run lint
/opt/homebrew/bin/bun test
```

Expected: 与工作开始前的基线相比无新增失败（脏树上 enterprise/payments 的既有失败不算）。

- [ ] **Step 3: 人工验收（若 dev 栈在跑）**

`bun run dev` 已在跑时，浏览器过一遍三页：暗/亮色、中文文案、（若配了 Lago 沙箱）订阅 QR 流程取消一次。记录截图位置与结果于提交说明之外，不入库。

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/browser.e2e.ts
git commit -m "test(e2e): 计费三页断言适配商业化结构"
```
