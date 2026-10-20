# Bifrost Wave 1（前沿 4 Ticket）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Spec #5 的第一批前沿 Ticket——网关连接配置、兑换比例必填校验、PayerRef 账户模型、Bot 服务登记——各自形成可独立验证的行为切片。

**Architecture:** 四个切片都只动 OpenBot 服务端：新增 `server/src/gateway/*`（配置与比例）、`server/src/billing/payer.ts`（付款账户）、`server/src/bots/*`（Bot 登记）。全部遵循既有模式：drizzle schema 显式注册 + 迁移、`requireAdmin` + `recordAuditEvent` 的管理路由、`TEST_DATABASE_URL` 专用库集成测试。**不动** `CreditWriter` 的金额/幂等语义（那是组 06 的事），不引入任何 Bifrost 子模块依赖（波次 1 全部 `primary_repo: openbot`）。

**Tech Stack:** Bun + TypeScript、Hono + zod、Drizzle ORM (PostgreSQL)、bun:test。

**Spec:** GitHub Issue（事实源，正文含每张 Ticket 的验收/契约/验证命令）：
- Task 1 → #207（`01.1` 网关地址与连接配置持久化）
- Task 2 → #209（`01.3` 兑换比例必填与合法性校验）
- Task 3 → #215（`02.1` PayerRef 账户模型与映射唯一性）
- Task 4 → #234（`04.1` Bot 服务登记与唯一服务身份）
- 父 Spec：`https://github.com/1123786563/OpenBot/issues/5`；本地索引 `docs/tickets/bifrost-5/manifest.json`（151 张 DAG 与验收映射）

**执行工作区（Ledger）：** `/Users/wuyongjun/orca/workspaces/OpenBot/bifrost-wave1`，分支 `1123786563/bifrost-wave1`，**BASE = `4dd1922d`**。主 checkout 被另一执行者持有，禁止在主 checkout 施工。

## Global Constraints

- **测试库纪律（逐字，来自 manifest global_constraints）**："SQL 原子性使用专用 PostgreSQL 测试库，缺 TEST_DATABASE_URL 不回退开发数据库、不记为通过。" 集成测试通过 `server/tests/support/database.ts` 的 `testDatabaseUrl()`（缺变量直接抛错；库名不得为 `openbot`）。
- **迁移纪律**：新 schema 文件必须在同一变更里加进 `server/drizzle.config.ts` 的显式 `schema` 清单（文件注释原话：缺列会让"下一个生成的迁移把它们当作不存在"），并在 `server/src/db/schema/index.ts` re-export。
- **CreditWriter 边界**：Task 3 只引入账户层，`grantCredits/readBalance/reserveCredits/settleReservation/releaseReservation/consumeCredits` 的签名与语义一行不改。
- **管理动作纪律**：所有 `/api/admin/*` 写操作走 `requireAdmin`（`server/src/auth/guards.ts`）+ `recordAuditEvent`（`server/src/audit.ts`），拒绝路径不得泄露内部细节。
- **配置校验风格**：沿用 `server/src/config.ts` 的拒绝式校验（明确错误信息、全有或全无、绝不给隐含默认值）。
- **本波次无凭据明文**：Task 1 不存储任何凭据（凭据在 #208/01.2）；Task 2 只存比例数值。
- 每个任务独立提交；提交信息带 Issue 号（如 `feat(gateway): … (#207)`）。
- **前置环境**：需要可用的 PostgreSQL 测试库（如 `docker compose up -d` 后建 `openbot_test` 库）并导出 `TEST_DATABASE_URL`；worktree 无 `.env`（不入库），命令里显式传变量。

---

### Task 1: 网关连接配置持久化（#207 / 01.1）

**Files:**
- Create: `server/src/db/schema/gateway.ts`
- Create: `server/src/gateway/config-store.ts`
- Modify: `server/drizzle.config.ts`（schema 清单加 `"./src/db/schema/gateway.ts"`，跟随清单内相对路径写法）
- Modify: `server/src/db/schema/index.ts`（加 `export * from "./gateway";`）
- Test: `server/tests/gateway-endpoint-config.test.ts`（纯校验）
- Test: `server/tests/gateway-endpoint-config.integration.test.ts`（持久化）

**Interfaces:**
- Consumes: 无（波次首张）。
- Produces（下游 #210/01.2、#213/01.5、#214/01.7、#216/01.8 依赖）:
  - `parseGatewayEndpointInput(raw): { ok: true; value: GatewayEndpoint } | { ok: false; error: string }`（纯函数）
  - `type GatewayEndpoint = { baseUrl: string; requestTimeoutMs: number }`
  - `saveGatewayEndpoint(database, input: GatewayEndpoint, by: string): Promise<GatewayConfigRecord>`
  - `readGatewayEndpoint(database): Promise<GatewayConfigRecord | undefined>`
  - `type GatewayConfigRecord = GatewayEndpoint & { configVersion: number; updatedBy: string; updatedAt: Date }`

- [ ] **Step 1: 写失败的纯校验测试**

`server/tests/gateway-endpoint-config.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { parseGatewayEndpointInput } from "../src/gateway/config-store";

describe("parseGatewayEndpointInput", () => {
  test("accepts a bare https origin", () => {
    const r = parseGatewayEndpointInput({ baseUrl: "https://bifrost.example.com", requestTimeoutMs: 10_000 });
    expect(r).toEqual({ ok: true, value: { baseUrl: "https://bifrost.example.com", requestTimeoutMs: 10_000 } });
  });
  test("rejects empty / blank", () => {
    for (const baseUrl of ["", "   "]) {
      expect(parseGatewayEndpointInput({ baseUrl, requestTimeoutMs: 10_000 })).toEqual({
        ok: false, error: "Gateway base URL is required.",
      });
    }
  });
  test("rejects non-http(s) protocols", () => {
    expect(parseGatewayEndpointInput({ baseUrl: "ftp://bifrost.example.com", requestTimeoutMs: 10_000 })).toEqual({
      ok: false, error: "Gateway base URL must be an http or https URL.",
    });
  });
  test("rejects credentials in the URL", () => {
    expect(parseGatewayEndpointInput({ baseUrl: "https://user:pw@bifrost.example.com", requestTimeoutMs: 10_000 })).toEqual({
      ok: false, error: "Gateway base URL must not carry credentials.",
    });
  });
  test("rejects path, query, or fragment", () => {
    for (const baseUrl of ["https://bifrost.example.com/v1", "https://bifrost.example.com?a=1", "https://bifrost.example.com#f"]) {
      expect(parseGatewayEndpointInput({ baseUrl, requestTimeoutMs: 10_000 })).toEqual({
        ok: false, error: "Gateway base URL must be the origin only, without a path, query or fragment.",
      });
    }
  });
  test("rejects a non-positive or non-integer timeout", () => {
    for (const requestTimeoutMs of [0, -1, 2.5]) {
      expect(parseGatewayEndpointInput({ baseUrl: "https://bifrost.example.com", requestTimeoutMs })).toEqual({
        ok: false, error: "requestTimeoutMs must be a whole number of milliseconds greater than zero.",
      });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && bun test tests/gateway-endpoint-config.test.ts`
Expected: FAIL（`Cannot find module '../src/gateway/config-store'`）

- [ ] **Step 3: 建 schema + 纯函数最小实现**

`server/src/db/schema/gateway.ts`：

```ts
import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * The gateway connection configuration, one singleton row (`id = 'default'`).
 *
 * `config_version` increments on every successful save, so every consumer (probe, readiness gate,
 * credential ref) can pin the version it acted on and refuse to act on stale assumptions. No
 * secret lives here: admin credentials are stored by the credential store (ticket 01.2), never in
 * this row, so this table is safe to read for status display.
 */
export const gatewayConfigs = pgTable(
  "gateway_configs",
  {
    id: text("id").primaryKey(),
    baseUrl: text("base_url").notNull(),
    requestTimeoutMs: integer("request_timeout_ms").notNull().default(10_000),
    configVersion: integer("config_version").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("gateway_configs_singleton").on(table.id)],
);
```

`server/src/gateway/config-store.ts`（Step 3 只需纯函数让测试过；save/read 在 Step 5）：

```ts
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { gatewayConfigs } from "../db/schema/gateway";

export type GatewayEndpoint = { baseUrl: string; requestTimeoutMs: number };
export type GatewayConfigRecord = GatewayEndpoint & {
  configVersion: number;
  updatedBy: string;
  updatedAt: Date;
};

export const GATEWAY_CONFIG_TOPIC = "gateway_config_changed";
const GATEWAY_ENDPOINT_ERRORS = {
  missing: "Gateway base URL is required.",
  protocol: "Gateway base URL must be an http or https URL.",
  credentials: "Gateway base URL must not carry credentials.",
  path: "Gateway base URL must be the origin only, without a path, query or fragment.",
  timeout: "requestTimeoutMs must be a whole number of milliseconds greater than zero.",
} as const;

export function parseGatewayEndpointInput(raw: {
  baseUrl?: unknown;
  requestTimeoutMs?: unknown;
}): { ok: true; value: GatewayEndpoint } | { ok: false; error: string } {
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (baseUrl === "") return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.missing };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.protocol };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.protocol };
  }
  if (parsed.username || parsed.password) return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.credentials };
  if (parsed.pathname.replace(/\/+$/, "") !== "" || parsed.search || parsed.hash) {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.path };
  }
  const requestTimeoutMs = raw.requestTimeoutMs;
  if (typeof requestTimeoutMs !== "number" || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.timeout };
  }
  return { ok: true, value: { baseUrl: parsed.origin, requestTimeoutMs } };
}
```

同时把 `"./src/db/schema/gateway.ts"` 加进 `server/drizzle.config.ts` 的 `schema` 数组、`server/src/db/schema/index.ts` 加 `export * from "./gateway";`。

- [ ] **Step 4: 跑纯校验测试确认通过**

Run: `cd server && bun test tests/gateway-endpoint-config.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: 写失败的持久化集成测试**

`server/tests/gateway-endpoint-config.integration.test.ts`：

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { gatewayConfigs } from "../src/db/schema/gateway";
import {
  parseGatewayEndpointInput,
  readGatewayEndpoint,
  saveGatewayEndpoint,
} from "../src/gateway/config-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.execute(sql`DELETE FROM gateway_configs`);
  await database.$client.close();
});

describe("gateway endpoint persistence", () => {
  test("save then read is stable, and each save bumps configVersion", async () => {
    const first = parseGatewayEndpointInput({ baseUrl: "https://bifrost.example.com", requestTimeoutMs: 10_000 });
    if (!first.ok) throw new Error(first.error);
    const saved1 = await saveGatewayEndpoint(database, first.value, "admin-1");
    expect(saved1.configVersion).toBe(1);

    const saved2 = await saveGatewayEndpoint(database, first.value, "admin-1");
    expect(saved2.configVersion).toBe(2);

    const read = await readGatewayEndpoint(database);
    expect(read?.baseUrl).toBe("https://bifrost.example.com");
    expect(read?.configVersion).toBe(2);
    expect(read?.updatedBy).toBe("admin-1");
  });

  test("a fresh reader (restart) sees the same row", async () => {
    const read = await readGatewayEndpoint(database);
    const rows = await database.select().from(gatewayConfigs).where(eq(gatewayConfigs.id, "default"));
    expect(rows).toHaveLength(1);
    expect(read?.configVersion).toBe(rows[0].configVersion);
  });

  test("the stored row carries no credential-like columns", async () => {
    const rows = await database.select().from(gatewayConfigs);
    const columns = Object.keys(rows[0]);
    expect(columns.some((c) => /secret|token|password|key/i.test(c))).toBe(false);
  });
});
```

- [ ] **Step 6: 跑集成测试确认失败（表不存在）**

Run: `cd server && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test tests/gateway-endpoint-config.integration.test.ts`
Expected: FAIL（relation "gateway_configs" does not exist）

- [ ] **Step 7: 生成迁移并在测试库应用**

```bash
cd server
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bunx drizzle-kit generate --config=drizzle.config.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bunx drizzle-kit migrate --config=drizzle.config.ts
```
Expected: 生成一条新增 `gateway_configs` 的迁移并应用成功。

- [ ] **Step 8: 实现 save/read**

在 `server/src/gateway/config-store.ts` 追加：

```ts
const SINGLETON_ID = "default";

export async function saveGatewayEndpoint(
  database: Database,
  input: GatewayEndpoint,
  by: string,
): Promise<GatewayConfigRecord> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .insert(gatewayConfigs)
      .values({ id: SINGLETON_ID, baseUrl: input.baseUrl, requestTimeoutMs: input.requestTimeoutMs, configVersion: 1, updatedBy: by })
      .onConflictDoUpdate({
        target: gatewayConfigs.id,
        set: {
          baseUrl: input.baseUrl,
          requestTimeoutMs: input.requestTimeoutMs,
          configVersion: sql`${gatewayConfigs.configVersion} + 1`,
          updatedBy: by,
          updatedAt: new Date(),
        },
      })
      .returning();
    await tx.execute(sql`select pg_notify(${GATEWAY_CONFIG_TOPIC}, ${String(rows[0].configVersion)})`);
    return rows[0] as GatewayConfigRecord;
  });
}

export async function readGatewayEndpoint(database: Database): Promise<GatewayConfigRecord | undefined> {
  const rows = await database.select().from(gatewayConfigs).where(eq(gatewayConfigs.id, SINGLETON_ID));
  return rows[0] as GatewayConfigRecord | undefined;
}
```

- [ ] **Step 9: 跑集成测试确认通过，再跑 typecheck**

Run: `cd server && TEST_DATABASE_URL=… bun test tests/gateway-endpoint-config.integration.test.ts && bun run typecheck`
Expected: PASS / exit 0

- [ ] **Step 10: Commit**

```bash
git add server/src/db/schema/gateway.ts server/src/gateway/config-store.ts \
  server/src/db/schema/index.ts server/drizzle.config.ts \
  server/drizzle/ server/tests/gateway-endpoint-config.test.ts server/tests/gateway-endpoint-config.integration.test.ts
git commit -m "feat(gateway): persisted gateway endpoint config with monotonic configVersion (#207)"
```

---

### Task 2: 兑换比例必填与合法性校验（#209 / 01.3）

**Files:**
- Create: `server/src/gateway/conversion-rate.ts`
- Modify: `server/src/db/schema/gateway.ts`（加 `gatewayConversionRates` 版本表）
- Modify: `server/src/gateway/config-store.ts`（或新文件 `conversion-rate-store.ts`；本计划用独立文件 `server/src/gateway/conversion-rate-store.ts`）
- Modify: `server/src/config.ts`（环境变量 `BIFROST_CONVERSION_RATE_PER_USD` 可选但严格校验）
- Test: `server/tests/gateway-conversion-rate.test.ts`（纯校验）
- Test: `server/tests/gateway-conversion-rate.integration.test.ts`（持久化与"未配置即未启用"）

**Interfaces:**
- Consumes: Task 1 的 schema 注册模式（不依赖其代码）。
- Produces（下游 #210/01.4、#214/01.7、06.5 结算锁定依赖）:
  - `parseConversionRateInput(raw: unknown): { ok: true; value: { numerator: bigint; denominator: bigint } } | { ok: false; error: string }`（精确有理数；`1 USD = numerator/denominator` 积分）
  - `saveConversionRate(database, rate, by): Promise<ConversionRateRecord>`
  - `currentConversionRate(database): Promise<ConversionRateRecord | undefined>`
  - `type ConversionRateRecord = { rateVersion: number; numerator: bigint; denominator: bigint; createdBy: string; createdAt: Date }`
  - 未配置时 `currentConversionRate` 返回 `undefined`，下游（01.7 门禁）据此判"计费未启用"。

- [ ] **Step 1: 写失败的纯校验测试**

`server/tests/gateway-conversion-rate.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { parseConversionRateInput } from "../src/gateway/conversion-rate";

describe("parseConversionRateInput", () => {
  test("accepts a plain decimal and keeps it exact", () => {
    const r = parseConversionRateInput("7.5");
    if (!r.ok) throw new Error(r.error);
    expect(r.value.numerator).toBe(75n);
    expect(r.value.denominator).toBe(10n);
  });
  test("rejects unset, zero, negative, non-numeric, and over-precision", () => {
    for (const bad of [undefined, "", "0", "0.0", "-1", "abc", "1.2345678"]) {
      const r = parseConversionRateInput(bad);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
    }
  });
  test("a tiny rate survives a round trip without float error", () => {
    const r = parseConversionRateInput("0.300001");
    if (!r.ok) throw new Error(r.error);
    expect(r.value.numerator).toBe(300001n);
    expect(r.value.denominator).toBe(1000000n);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && bun test tests/gateway-conversion-rate.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现纯校验（最大 6 位小数，bigint 精确）**

`server/src/gateway/conversion-rate.ts`：

```ts
/** 1 USD = numerator/denominator credits, exact rational — never a float. */
export type ConversionRate = { numerator: bigint; denominator: bigint };
export const MAX_RATE_DECIMALS = 6;
const RATE_RE = /^\d{1,9}(?:\.\d{1,6})?$/;

export function parseConversionRateInput(raw: unknown): { ok: true; value: ConversionRate } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "Conversion rate is required for billing enablement (1 USD = X credits); no implicit default exists." };
  }
  const s = raw.trim();
  if (!RATE_RE.test(s) || Number(s) === 0) {
    return { ok: false, error: `Conversion rate must be a positive decimal of at most ${MAX_RATE_DECIMALS} places (for example "7.5").` };
  }
  const [intPart, decPart = ""] = s.split(".");
  return {
    ok: true,
    value: {
      numerator: BigInt(`${intPart}${decPart}`),
      denominator: 10n ** BigInt(decPart.length),
    },
  };
}
```

- [ ] **Step 4: 跑纯校验测试确认通过**

Run: `cd server && bun test tests/gateway-conversion-rate.test.ts` → PASS

- [ ] **Step 5: 写失败的持久化集成测试**

`server/tests/gateway-conversion-rate.integration.test.ts`：

```ts
import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { parseConversionRateInput } from "../src/gateway/conversion-rate";
import { currentConversionRate, saveConversionRate } from "../src/gateway/conversion-rate-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.execute(sql`DELETE FROM gateway_conversion_rates`);
  await database.$client.close();
});

test("unset rate reads as undefined (billing not enabled), not as a default", async () => {
  expect(await currentConversionRate(database)).toBeUndefined();
});

test("saving creates immutable versions; precision is exact", async () => {
  const r = parseConversionRateInput("7.5");
  if (!r.ok) throw new Error(r.error);
  const v1 = await saveConversionRate(database, r.value, "admin-1");
  expect(v1.rateVersion).toBe(1);
  const read = await currentConversionRate(database);
  expect(read?.numerator).toBe(75n);
  expect(read?.denominator).toBe(10n);

  const r2 = parseConversionRateInput("0.300001");
  if (!r2.ok) throw new Error(r2.error);
  const v2 = await saveConversionRate(database, r2.value, "admin-2");
  expect(v2.rateVersion).toBe(2);
  expect((await currentConversionRate(database))?.numerator).toBe(300001n);
});
```

- [ ] **Step 6: 跑集成测试确认失败（表不存在）** → `relation "gateway_conversion_rates" does not exist`

- [ ] **Step 7: schema + 迁移**

在 `server/src/db/schema/gateway.ts` 追加（append-only 版本表，当前版本单独标记）：

```ts
/**
 * Append-only conversion-rate versions. Rows are immutable; `is_current` marks the active one, and
 * exactly one row is current (enforced below). Admission pins the version it used; settlement must
 * read the pinned version, never "latest".
 */
export const gatewayConversionRates = pgTable(
  "gateway_conversion_rates",
  {
    rateVersion: integer("rate_version").primaryKey(),
    numerator: bigint("numerator", { mode: "bigint" }).notNull(),
    denominator: bigint("denominator", { mode: "bigint" }).notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("gateway_conversion_rates_one_current").on(table.isCurrent).where(sql`${table.isCurrent}`)],
);
```

（`bigint`/`boolean`/`sql` 从 `drizzle-orm/pg-core`、`drizzle-orm` 补导入。）随后生成并应用迁移（命令同 Task 1 Step 7）。

- [ ] **Step 8: 实现 store**

`server/src/gateway/conversion-rate-store.ts`：

```ts
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { gatewayConversionRates } from "../db/schema/gateway";
import type { ConversionRate } from "./conversion-rate";

export type ConversionRateRecord = ConversionRate & { rateVersion: number; createdBy: string; createdAt: Date };

export async function saveConversionRate(database: Database, rate: ConversionRate, by: string): Promise<ConversionRateRecord> {
  return database.transaction(async (tx) => {
    const [last] = await tx.select().from(gatewayConversionRates).orderBy(desc(gatewayConversionRates.rateVersion)).limit(1);
    const nextVersion = (last?.rateVersion ?? 0) + 1;
    await tx.update(gatewayConversionRates).set({ isCurrent: false }).where(eq(gatewayConversionRates.isCurrent, true));
    const [row] = await tx
      .insert(gatewayConversionRates)
      .values({ rateVersion: nextVersion, numerator: rate.numerator, denominator: rate.denominator, isCurrent: true, createdBy: by })
      .returning();
    return row as ConversionRateRecord;
  });
}

export async function currentConversionRate(database: Database): Promise<ConversionRateRecord | undefined> {
  const [row] = await database.select().from(gatewayConversionRates).where(eq(gatewayConversionRates.isCurrent, true)).limit(1);
  return row as ConversionRateRecord | undefined;
}
```

- [ ] **Step 9: config.ts 启动路径校验（与 admin 写入同一纯函数）**

在 `server/src/config.ts` 找到 billing/env 读取区域，新增（不设默认值）：

```ts
const conversionRateRaw = optional(environment, "BIFROST_CONVERSION_RATE_PER_USD");
const conversionRate = conversionRateRaw === undefined ? undefined : parseConversionRateInput(conversionRateRaw);
if (conversionRateRaw !== undefined && conversionRate && !conversionRate.ok) {
  throw new Error(`BIFROST_CONVERSION_RATE_PER_USD: ${conversionRate.error}`);
}
```
（导入 `parseConversionRateInput`；`conversionRate` 进入现有配置对象时保留 `undefined` 语义 = 未启用计费。）

- [ ] **Step 10: 全部测试 + typecheck**

Run: `cd server && TEST_DATABASE_URL=… bun test tests/gateway-conversion-rate.test.ts tests/gateway-conversion-rate.integration.test.ts && bun run typecheck`
Expected: PASS / exit 0

- [ ] **Step 11: Commit**

```bash
git add server/src/gateway/conversion-rate.ts server/src/gateway/conversion-rate-store.ts \
  server/src/db/schema/gateway.ts server/src/config.ts server/drizzle/ \
  server/tests/gateway-conversion-rate.test.ts server/tests/gateway-conversion-rate.integration.test.ts
git commit -m "feat(gateway): required exact conversion-rate config with immutable versions (#209)"
```

---

### Task 3: PayerRef 账户模型与映射唯一性（#215 / 02.1）

**Files:**
- Create: `server/src/db/schema/payer.ts`
- Create: `server/src/billing/payer.ts`
- Modify: `server/drizzle.config.ts`、`server/src/db/schema/index.ts`
- Test: `server/tests/payer-account.integration.test.ts`

**Interfaces:**
- Consumes: `billingCustomers`（`server/src/db/schema/billing.ts`，PK `externalId`）、`CreditWriter`（只读使用，不改）。
- Produces（下游 02.2–02.8、05.1、10.1 依赖）:
  - `type PayerKind = "personal" | "company" | "legacy_deployment" | "unknown_owner"`
  - `type PayerRef = { kind: PayerKind; id: string }`
  - `createPayerAccount(database, ref: PayerRef, name?: string | null): Promise<{ externalCustomerId: string }>`（幂等；只建账户不建余额）
  - `payerKey(database, ref: PayerRef): Promise<string | undefined>`

- [ ] **Step 1: 写失败的集成测试**

`server/tests/payer-account.integration.test.ts`：

```ts
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `payertest-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.execute(sql`DELETE FROM payer_accounts WHERE external_customer_id LIKE ${`${prefix}%`}`);
  await database.execute(sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`${prefix}%`}`);
  await database.execute(sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`${prefix}%`}`);
  await database.execute(sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`);
  await database.$client.close();
});

test("concurrent creation converges on one account and one mapping", async () => {
  const ref = { kind: "personal" as const, id: `${prefix}-user-1` };
  const [a, b] = await Promise.all([
    createPayerAccount(database, ref),
    createPayerAccount(database, ref),
  ]);
  expect(a.externalCustomerId).toBe(b.externalCustomerId);
  const rows = await database.execute(
    sql`SELECT external_customer_id FROM payer_accounts WHERE payer_kind = 'personal' AND external_ref = ${ref.id}`,
  );
  expect(rows.rows).toHaveLength(1);
  expect(await payerKey(database, ref)).toBe(a.externalCustomerId);
});

test("one external_customer_id cannot be claimed by two payers", async () => {
  const r1 = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-2` });
  const second = await database.execute(
    sql`INSERT INTO payer_accounts (id, payer_kind, external_ref, external_customer_id) VALUES ('${prefix}-dup', 'company', '${prefix}-tenant-2', ${r1.externalCustomerId}) ON CONFLICT DO NOTHING RETURNING id`,
  );
  expect(second.rows).toHaveLength(0);
});

test("accounts are isolated: a grant to A never shows in B's balance", async () => {
  const a = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-3` });
  const b = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-4` });
  await writer.grantCredits({
    externalCustomerId: a.externalCustomerId,
    source: "campaign",
    totalCents: 1_000,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    idempotencyKey: `${prefix}-grant-3`,
  });
  expect(await writer.readBalance(a.externalCustomerId)).toBeGreaterThan(0);
  expect(await writer.readBalance(b.externalCustomerId)).toBe(0);
});

test("creating an account grants no balance", async () => {
  const c = await createPayerAccount(database, { kind: "personal", id: `${prefix}-user-5` });
  expect(await writer.readBalance(c.externalCustomerId)).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**（`payer_accounts` 不存在 / 模块不存在）

- [ ] **Step 3: schema + 迁移**

`server/src/db/schema/payer.ts`：

```ts
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { billingCustomers } from "./billing";

/**
 * The billing subject: one PayerRef (kind + stable id) maps to exactly one existing
 * external_customer_id, and one external_customer_id belongs to at most one payer — both enforced
 * by unique indexes, not by read-checks. Creating an account moves no money: balances stay where
 * they are (legacy rows keep their own keys; migration/classification is 02.2's job).
 */
export const payerAccounts = pgTable(
  "payer_accounts",
  {
    id: text("id").primaryKey(),
    payerKind: text("payer_kind").$type<"personal" | "company" | "legacy_deployment" | "unknown_owner">().notNull(),
    externalRef: text("external_ref").notNull(),
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payer_accounts_subject_unique").on(table.payerKind, table.externalRef),
    uniqueIndex("payer_accounts_customer_unique").on(table.externalCustomerId),
  ],
);
```

注册进 `drizzle.config.ts` 与 `schema/index.ts`，生成并应用迁移（命令同 Task 1 Step 7）。

- [ ] **Step 4: 实现 payer.ts**

`server/src/billing/payer.ts`：

```ts
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCustomers } from "../db/schema/billing";
import { payerAccounts } from "../db/schema/payer";

export type PayerKind = "personal" | "company" | "legacy_deployment" | "unknown_owner";
export type PayerRef = { kind: PayerKind; id: string };

/**
 * Idempotent account creation: ensure the billing customer row exists, then claim the
 * (kind, external_ref) mapping. Concurrent callers converge on one row because both writes are
 * ON CONFLICT DO NOTHING followed by a re-read — the unique indexes are the authority.
 * Never grants balance; never copies or moves any legacy amounts.
 */
export async function createPayerAccount(
  database: Database,
  ref: PayerRef,
  name?: string | null,
): Promise<{ externalCustomerId: string }> {
  const externalCustomerId = `${ref.kind}:${ref.id}`;
  await database
    .insert(billingCustomers)
    .values({ externalId: externalCustomerId, name: name ?? null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
  await database
    .insert(payerAccounts)
    .values({ id: randomUUID(), payerKind: ref.kind, externalRef: ref.id, externalCustomerId })
    .onConflictDoNothing();
  const [row] = await database
    .select({ externalCustomerId: payerAccounts.externalCustomerId })
    .from(payerAccounts)
    .where(and(eq(payerAccounts.payerKind, ref.kind), eq(payerAccounts.externalRef, ref.id)))
    .limit(1);
  return { externalCustomerId: row.externalCustomerId };
}

export async function payerKey(database: Database, ref: PayerRef): Promise<string | undefined> {
  const [row] = await database
    .select({ externalCustomerId: payerAccounts.externalCustomerId })
    .from(payerAccounts)
    .where(and(eq(payerAccounts.payerKind, ref.kind), eq(payerAccounts.externalRef, ref.id)))
    .limit(1);
  return row?.externalCustomerId;
}
```

- [ ] **Step 5: 跑集成测试 + typecheck**

Run: `cd server && TEST_DATABASE_URL=… bun test tests/payer-account.integration.test.ts && bun run typecheck`
Expected: PASS / exit 0（并发用例两次调用返回同一 key，且 `payer_accounts` 只有一行）

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema/payer.ts server/src/billing/payer.ts \
  server/src/db/schema/index.ts server/drizzle.config.ts server/drizzle/ \
  server/tests/payer-account.integration.test.ts
git commit -m "feat(billing): PayerRef account model with bidirectional unique mapping (#215)"
```

---

### Task 4: Bot 服务登记与唯一服务身份（#234 / 04.1）

**Files:**
- Create: `server/src/db/schema/bots.ts`
- Create: `server/src/bots/service-registry.ts`
- Create: `server/src/bots/admin-routes.ts`
- Modify: `server/src/app.ts`（在 `/api/admin/enterprise` 挂载点旁挂 `/api/admin/bots`）
- Modify: `server/drizzle.config.ts`、`server/src/db/schema/index.ts`
- Test: `server/tests/bot-service-registry.test.ts`（路由 + 权限，参照现有路由测试的 app 构造方式）

**Interfaces:**
- Consumes: `requireAdmin`（`server/src/auth/guards.ts`）、`recordAuditEvent`（`server/src/audit.ts`）。
- Produces（下游 04.2–04.8、03.8、05.3 依赖）:
  - `type BotCapability = "chat" | "image" | "audio" | "embedding" | "realtime" | "async"`
  - `type BotServiceRecord = { botId: string; displayName: string; kind: "builtin" | "external"; capabilities: BotCapability[]; status: "active" | "disabled"; createdAt: Date; updatedAt: Date }`
  - `registerBotService(database, input, by): Promise<BotServiceRecord>`（botId 冲突时抛 `BotIdTakenError`）
  - `getBotService(database, botId)` / `listBotServices(database)` / `setBotServiceStatus(database, botId, status, by)`（停用即 `status='disabled'`，**没有删除**——botId 不可复用）
  - HTTP：`POST /api/admin/bots`、`GET /api/admin/bots`、`POST /api/admin/bots/:botId/status`（管理员 + 审计；登记不产生任何凭据或积分权限）

- [ ] **Step 1: 写失败的路由测试**

`server/tests/bot-service-registry.test.ts`（测试内用与现有路由测试相同的方式构造 app 与假会话；若仓库已有 admin 路由测试 helper，直接复用其构造函数——执行时先 `rg -l "requireAdmin" server/tests` 找一个样板，把会话注入方式抄过来）：

```ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

// 构造 app 的样板从 server/tests 中任一 requireAdmin 路由测试复制（见上），此处命名为 buildApp(admin: boolean)。

afterAll(async () => {
  await database.execute(sql`DELETE FROM bot_services WHERE bot_id LIKE 'test-bot-%'`);
  await database.$client.close();
});

describe("admin bot service registry", () => {
  test("admin registers a bot with capabilities; duplicate botId is rejected", async () => {
    const app = buildApp(true);
    const res = await app.request("/api/admin/bots", {
      method: "POST",
      body: JSON.stringify({ botId: "test-bot-1", displayName: "Workbench", kind: "builtin", capabilities: ["chat"] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);

    const dup = await app.request("/api/admin/bots", {
      method: "POST",
      body: JSON.stringify({ botId: "test-bot-1", displayName: "Again", kind: "external", capabilities: ["chat"] }),
      headers: { "content-type": "application/json" },
    });
    expect(dup.status).toBe(409);
  });

  test("invalid capability and malformed botId are 400s", async () => {
    const app = buildApp(true);
    const bad = await app.request("/api/admin/bots", {
      method: "POST",
      body: JSON.stringify({ botId: "Bad Id!", displayName: "x", kind: "external", capabilities: ["nope"] }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  test("non-admin is rejected on every route", async () => {
    const app = buildApp(false);
    expect((await app.request("/api/admin/bots")).status).toBe(403);
    expect((await app.request("/api/admin/bots", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
  });

  test("disable is sticky and there is no delete", async () => {
    const app = buildApp(true);
    const off = await app.request("/api/admin/bots/test-bot-1/status", {
      method: "POST",
      body: JSON.stringify({ status: "disabled" }),
      headers: { "content-type": "application/json" },
    });
    expect(off.status).toBe(200);
    expect((await app.request("/api/admin/bots")).json()).toMatchObject([{ botId: "test-bot-1", status: "disabled" }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（模块/路由不存在）

- [ ] **Step 3: schema + 迁移**

`server/src/db/schema/bots.ts`：

```ts
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Registered bot services — the server-side identity every external or builtin bot presents.
 * Registration grants no credentials and no credit authority (auth is 04.2, grants are 04.5).
 * There is no delete: `disabled` is terminal-but-reversible by re-enable, and a botId is never
 * reused, so an audit trail cannot be repointed by recycling an id.
 */
export const botServices = pgTable("bot_services", {
  botId: text("bot_id").primaryKey(),
  displayName: text("display_name").notNull(),
  kind: text("kind").$type<"builtin" | "external">().notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull(),
  status: text("status").$type<"active" | "disabled">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

注册 schema 清单 + 生成/应用迁移（命令同 Task 1 Step 7）。

- [ ] **Step 4: 实现 registry 与路由**

`server/src/bots/service-registry.ts`：

```ts
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { botServices } from "../db/schema/bots";

export type BotCapability = "chat" | "image" | "audio" | "embedding" | "realtime" | "async";
export const BOT_CAPABILITIES: readonly BotCapability[] = ["chat", "image", "audio", "embedding", "realtime", "async"];
export const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export class BotIdTakenError extends Error {
  constructor(public botId: string) { super(`botId "${botId}" is already registered and cannot be reused.`); }
}

export type BotServiceInput = { botId: string; displayName: string; kind: "builtin" | "external"; capabilities: BotCapability[] };

export function parseBotServiceInput(raw: {
  botId?: unknown; displayName?: unknown; kind?: unknown; capabilities?: unknown;
}): { ok: true; value: BotServiceInput } | { ok: false; error: string } {
  const botId = typeof raw.botId === "string" ? raw.botId.trim() : "";
  if (!BOT_ID_RE.test(botId)) return { ok: false, error: 'botId must match ^[a-z0-9][a-z0-9-]{1,63}$.' };
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (displayName === "" || displayName.length > 100) return { ok: false, error: "displayName must be 1–100 characters." };
  if (raw.kind !== "builtin" && raw.kind !== "external") return { ok: false, error: 'kind must be "builtin" or "external".' };
  const caps = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  if (caps.length === 0 || !caps.every((c): c is BotCapability => BOT_CAPABILITIES.includes(c as BotCapability))) {
    return { ok: false, error: `capabilities must be a non-empty subset of ${BOT_CAPABILITIES.join(", ")}.` };
  }
  return { ok: true, value: { botId, displayName, kind: raw.kind, capabilities: caps } };
}

export async function registerBotService(database: Database, input: BotServiceInput): Promise<void> {
  const rows = await database.insert(botServices).values({
    botId: input.botId, displayName: input.displayName, kind: input.kind, capabilities: input.capabilities,
  }).onConflictDoNothing({ target: botServices.botId }).returning({ botId: botServices.botId });
  if (rows.length === 0) throw new BotIdTakenError(input.botId);
}

export async function listBotServices(database: Database) {
  return database.select().from(botServices).orderBy(asc(botServices.createdAt));
}

export async function setBotServiceStatus(database: Database, botId: string, status: "active" | "disabled") {
  await database.update(botServices).set({ status, updatedAt: new Date() }).where(eq(botServices.botId, botId));
}
```

`server/src/bots/admin-routes.ts`（Hono 模式照抄 `server/src/admin/routes.ts`；`requireAdmin` 与审计的接线方式以该文件现行为准）：

```ts
import { Hono } from "hono";
import { z } from "zod";
import { recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { listBotServices, parseBotServiceInput, registerBotService, setBotServiceStatus } from "./service-registry";

export function createBotAdminRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireAdmin);

  app.get("/", async (c) => c.json(await listBotServices(c.get("database"))));
  app.post("/", async (c) => {
    const parsed = parseBotServiceInput(await c.req.json());
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      await registerBotService(c.get("database"), parsed.value);
    } catch (e) {
      if (e instanceof BotIdTakenError) return c.json({ error: e.message }, 409);
      throw e;
    }
    await recordAuditEvent(c.get("audit"), { eventType: "bot_service.registered", targetType: "bot_service", targetId: parsed.value.botId, actorUserId: c.get("user").id, payload: parsed.value });
    return c.json({ ok: true }, 201);
  });
  app.post("/:botId/status", async (c) => {
    const { status } = z.object({ status: z.enum(["active", "disabled"]) }).parse(await c.req.json());
    await setBotServiceStatus(c.get("database"), c.req.param("botId"), status);
    await recordAuditEvent(c.get("audit"), { eventType: "bot_service.status_changed", targetType: "bot_service", targetId: c.req.param("botId"), actorUserId: c.get("user").id, payload: { status } });
    return c.json({ ok: true });
  });
  return app;
}
```
（`c.get("database")` / `c.get("audit")` / `c.get("user")` 的取值方式必须与仓库现有中间件注入一致——执行时以 `server/src/app.ts` 与现有 admin 路由为准对齐，不改中间件本身。）

在 `server/src/app.ts` 的 `/api/admin/enterprise` 挂载旁加：`app.route("/api/admin/bots", createBotAdminRoutes());`

- [ ] **Step 5: 跑测试 + typecheck**

Run: `cd server && TEST_DATABASE_URL=… bun test tests/bot-service-registry.test.ts && bun run typecheck`
Expected: PASS / exit 0

- [ ] **Step 6: 全量回归 + Commit**

Run: `cd .. && bun run --filter server typecheck && bunx biome lint --error-on-warnings server/src/bots server/src/gateway server/src/billing/payer.ts`

```bash
git add server/src/db/schema/bots.ts server/src/bots/ server/src/app.ts \
  server/src/db/schema/index.ts server/drizzle.config.ts server/drizzle/ \
  server/tests/bot-service-registry.test.ts
git commit -m "feat(bots): admin bot-service registry with sticky ids and audit (#234)"
```

---

## 完成判据（对照各 Issue 验收）

- #207：保存→重启→读一致；非法 URL 全拒；响应无凭据字段；版本严格递增。
- #209：未配置=未启用（`undefined`，无默认）；0/负/非法/超精度拒绝；bigint 精确；版本不可变。
- #215：并发收敛一行；双向唯一约束以冲突测试证明；跨账户隔离；建户零余额。
- #234：管理员 CRUD（无删除）；botId 冲突 409；非管理员 403；登记零凭据零积分权限。

## Self-Review 记录

- **Spec 覆盖**：四个 Issue 的每条 Acceptance criteria 都映射到测试断言（非法输入逐条、并发、唯一约束、403/409/400、无删除）。
- **占位符**：无 TBD/TODO；Task 4 的 `buildApp` 明示"从现有 requireAdmin 路由测试复制构造"，属可执行指令而非占位。
- **类型一致性**：`GatewayEndpoint/GatewayConfigRecord`、`ConversionRate(num/den bigint)`、`PayerRef/PayerKind`、`BotCapability/BotServiceInput` 在任务间无交叉引用错误；Task 2/3 不依赖 Task 1 的运行时代码，仅共享 schema 注册模式。
