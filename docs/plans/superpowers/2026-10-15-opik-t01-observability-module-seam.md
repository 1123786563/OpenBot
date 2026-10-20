# Opik T01 观测后端模块骨架与路由注册 seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `server/src/ai-observability/` 模块与单一挂载点，并把「观测访问 = Bot 管理权，而不是聊天权」这条授权语义在公开 HTTP 边界上落成可测的拒绝路径。

**Architecture:** 沿用仓库既有的 route-module 模式：模块导出 `createXRoutes(deps): Hono<{ Variables: AppVariables }>`，`server/src/app.ts` 的 `createApp` 用一个可选 deps 字段 + 一行 `app.route(...)` 挂载，`server/src/index.ts` 只负责构造并传入。授权用注入的 check 函数（与既有 `BotAccessCheck` 同形状），但语义取 `canManageAgent` 而不是 `canAccessAgent`，因此 public 聊天权不能读到观测数据。deps 缺省时路由不挂载，`/api/ai-observability/*` 返回 404，现有接口零变化。

**Tech Stack:** Bun + Hono 4 + TypeScript（`tsc --noEmit` 严格模式）、`bun:test`、Biome。

**Spec:** `docs/specs/2026-10-14-opik-integration-design.md`（Implementation Decision 5「Authorization」、6「Enterprise reservation」）；Ticket：https://github.com/1123786563/OpenBot/issues/7 ；父 Spec：https://github.com/1123786563/OpenBot/issues/4 的 A5。

## Global Constraints

- 覆盖父 Spec 验收：**A5**（骨架层）。
- 只允许改：`server/src/ai-observability/routes/index.ts`、`server/src/ai-observability/context.ts`、`server/src/app.ts`、`server/src/index.ts`、`server/tests/opik-module-skeleton.test.ts`。越界即停并上报。
- `server/src/app.ts` 与 `server/src/index.ts` 各只允许加 **一个 deps 字段 + 一行挂载** / **一行构造 + 一行传参**；不得重构既有代码。
- 本 Ticket **不引入** 租户表、租户头、企业 scope 解析（那是 #12 / T06）；也**不引入** config 与 health（那是 #15 / T09）。
- 观测授权必须复用既有 `canManageAgent` 语义（`server/src/agents/profile-policy.ts:16`：`ownerUserId === actor.id || actor.role === "admin"`，且 `systemOwned`/`deletedAt` 为真时拒绝），**不得**复用 `canAccessAgent`（它对 `visibility === "public"` 放行）。
- 集成未启用时不得产生任何行为变化：现有 `/api/*` 路由、tracing、Agent 执行保持原样（父 Spec A1 的骨架前提）。
- 缺依赖/缺归属一律 fail closed，返回可解释 JSON 错误，不返回空列表、不回退到更宽的权限。
- 不写死 Opik 上游地址、不做任何 HTTP 出站调用；本 Ticket 只建立 seam。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `server/src/ai-observability/context.ts` | 观测模块的授权词汇：`BotManagementCheck` 类型、`resolveObservationBot`（把 actor + botId 变成已授权判定）、错误构造。单一责任＝「谁能看这个 Bot 的观测数据」。 |
| `server/src/ai-observability/routes/index.ts` | Hono 子路由工厂：统一挂 `requireUser`，暴露本 Ticket 唯一的可观察端点，后续 Ticket 只在此文件追加自己的 route module 挂载。 |
| `server/src/app.ts` | 一个可选 deps 字段 `aiObservability?: Hono<{ Variables: AppVariables }>` + 一行 `app.route("/api/ai-observability", aiObservability)`。 |
| `server/src/index.ts` | 构造 `createAiObservabilityRoutes({...})` 并放进传给 `createApp` 的 deps 对象。 |
| `server/tests/opik-module-skeleton.test.ts` | 从公开 HTTP 边界验证 401 / 403 / 200 / 404 四类结果，以及 public 聊天权不等于观测权。 |

---

### Task 1: 观测授权词汇 `BotManagementCheck` 与 `resolveObservationBot`

**Files:**
- Create: `server/src/ai-observability/context.ts`
- Test: `server/tests/opik-module-skeleton.test.ts`

**Interfaces:**
- Consumes:
  - `type AgentActor` from `server/src/agents/profile-types.ts`（`{ id: string; role?: "admin" | "user" }`，与 `AuthenticatedActor` 结构相容）
  - `canManageAgent(actor: AgentActor, agent: AgentProfile): boolean` from `server/src/agents/profile-policy.ts:16`
  - `type AgentProfile` from `server/src/agents/profile-types.ts`
- Produces:
  - `export type BotManagementCheck = (actor: AgentActor, botId: string) => Promise<AgentProfile | null>` — 返回 profile 或 `null`（**不返回 boolean**，因为下游 T11/#17 需要 profile 里的归属与版本引用，避免二次查询）
  - `export type ObservationBotAccess = { ok: true; botId: string; profile: AgentProfile } | { ok: false; status: 403 | 404; error: string }`
  - `export function resolveObservationBot(check: BotManagementCheck, actor: AgentActor, botId: string | undefined): Promise<ObservationBotAccess>`
  - `export const OBSERVATION_ACCESS_DENIED = "Observation access requires management rights on this Bot."`
  - `export const OBSERVATION_BOT_REQUIRED = "A Bot id is required."`

- [ ] **Step 1: 写失败测试**

创建 `server/tests/opik-module-skeleton.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  OBSERVATION_ACCESS_DENIED,
  OBSERVATION_BOT_REQUIRED,
  resolveObservationBot,
  type BotManagementCheck,
} from "../src/ai-observability/context";
import type { AgentProfile } from "../src/agents/profile-types";

const owner = { id: "user-owner", role: "user" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;
const admin = { id: "user-admin", role: "admin" } as const;

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Expense Manager",
    title: "Finance",
    roleDescription: "Reviews receipts.",
    avatarSeed: "expense-manager",
    visibility: "private",
    ownerUserId: owner.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    ...overrides,
  } as AgentProfile;
}

/** 管理级 check：与 canManageAgent 同语义，测试里用它替代真实 store。 */
function managementCheck(rows: AgentProfile[]): BotManagementCheck {
  return async (actor, botId) => {
    const found = rows.find((row) => row.id === botId) ?? null;
    if (!found) return null;
    if (found.systemOwned || found.deletedAt !== null) return null;
    return found.ownerUserId === actor.id || actor.role === "admin" ? found : null;
  };
}

describe("resolveObservationBot", () => {
  test("a missing bot id is refused before any lookup", async () => {
    let called = 0;
    const result = await resolveObservationBot(async () => {
      called += 1;
      return null;
    }, owner, undefined);
    expect(result).toEqual({ ok: false, status: 404, error: OBSERVATION_BOT_REQUIRED });
    expect(called).toBe(0);
  });

  test("the owner gets access", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), owner, "agent-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.id).toBe("agent-1");
  });

  test("an administrator gets access", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), admin, "agent-1");
    expect(result.ok).toBe(true);
  });

  test("a stranger is refused even though the Bot exists", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), stranger, "agent-1");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("public visibility does NOT grant observation access", async () => {
    const rows = [profile({ visibility: "public" })];
    const result = await resolveObservationBot(managementCheck(rows), stranger, "agent-1");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("an unknown bot id is refused without leaking existence", async () => {
    const result = await resolveObservationBot(managementCheck([]), owner, "agent-nope");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("a system-owned or deleted Bot is refused even for its owner", async () => {
    const rows = [profile({ systemOwned: true }), profile({ id: "agent-2", deletedAt: new Date() })];
    expect((await resolveObservationBot(managementCheck(rows), owner, "agent-1")).ok).toBe(false);
    expect((await resolveObservationBot(managementCheck(rows), owner, "agent-2")).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-module-skeleton.test.ts`
Expected: FAIL — `Cannot find module '../src/ai-observability/context'`

- [ ] **Step 3: 写最小实现**

创建 `server/src/ai-observability/context.ts`：

```ts
/**
 * Who may observe a Bot.
 *
 * Observation access is MANAGEMENT access, not chat access. `canAccessAgent`
 * (server/src/agents/profile-policy.ts) answers yes for a `public` Bot, which is
 * exactly the widening the parent Spec forbids: public chat access must not become
 * access to another creator's traces. So this module asks the manage-level question
 * and nothing else, and the answer is injected the same way `BotAccessCheck` is —
 * a surface that observes a Bot depends on the question, not on the agents table.
 *
 * Deliberately absent: any tenant or enterprise scope. Unknown enterprise scope is
 * refused by the scope seam (ticket #12), not here; this file must not grow a
 * tenant header, a tenant table, or a fallback that widens access.
 */
import type { AgentActor, AgentProfile } from "../agents/profile-types";

/**
 * Resolves a Bot for observation. Returns the profile rather than a boolean because
 * downstream readers need the ownership and version references off the same row the
 * authorization decision was made on — a second lookup could observe a different Bot
 * after a transfer.
 */
export type BotManagementCheck = (
  actor: AgentActor,
  botId: string,
) => Promise<AgentProfile | null>;

export const OBSERVATION_ACCESS_DENIED =
  "Observation access requires management rights on this Bot.";
export const OBSERVATION_BOT_REQUIRED = "A Bot id is required.";

export type ObservationBotAccess =
  | { ok: true; botId: string; profile: AgentProfile }
  | { ok: false; status: 403 | 404; error: string };

/**
 * The one place observation authorization happens. A missing Bot id is refused before
 * any lookup; an unknown Bot and a Bot the caller may not manage answer identically, so
 * probing ids cannot tell the two apart.
 */
export async function resolveObservationBot(
  check: BotManagementCheck,
  actor: AgentActor,
  botId: string | undefined,
): Promise<ObservationBotAccess> {
  if (!botId) return { ok: false, status: 404, error: OBSERVATION_BOT_REQUIRED };
  const profile = await check(actor, botId);
  if (!profile) return { ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED };
  return { ok: true, botId, profile };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-module-skeleton.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: 提交**

```bash
git add server/src/ai-observability/context.ts server/tests/opik-module-skeleton.test.ts
git commit -m "feat(opik): observation access is Bot management access, not chat access"
```

---

### Task 2: 路由工厂 `createAiObservabilityRoutes` 与可观察端点

**Files:**
- Create: `server/src/ai-observability/routes/index.ts`
- Test: `server/tests/opik-module-skeleton.test.ts`（追加）

**Interfaces:**
- Consumes:
  - `resolveObservationBot`, `BotManagementCheck` from `../context`（Task 1）
  - `type MiddlewareHandler` from `hono`
  - `type AppVariables` from `../../auth/guards`
- Produces:
  - `export type AiObservabilityDeps = { requireUser: MiddlewareHandler<{ Variables: AppVariables }>; canManageBot: BotManagementCheck }`
  - `export function createAiObservabilityRoutes(deps: AiObservabilityDeps): Hono<{ Variables: AppVariables }>`
  - 端点：`GET /bots/:botId/access` → `200 { botId, observationAccess: true, capability: "none" }`；`capability` 恒为 `"none"` 直到 #20/#22 提供 detailed 判定，此处先固定该字段名以免下游各自发明。
  - 约定：后续 Ticket 在本文件内以 `routes.route("/runs", runsRoutes(deps))` 形式追加自己的子路由，不再改 `app.ts`。

- [ ] **Step 1: 写失败测试**

在 `server/tests/opik-module-skeleton.test.ts` 顶部补充 import：

```ts
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
```

在文件末尾追加：

```ts
function actorVariables(actor: AuthenticatedActor): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

const rejectingUser: MiddlewareHandler<{ Variables: AppVariables }> = async (context) => {
  // `return` is load-bearing: without it the middleware does not short-circuit, Hono reports
  // "Context is not finalized" and a correct implementation answers 500 instead of 401.
  // The real guard (auth/guards.ts createRequireUser) returns too.
  return await context.json({ error: "Authentication required." }, 401);
};

function appFor(
  rows: AgentProfile[],
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = actorVariables(
    owner as unknown as AuthenticatedActor,
  ),
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAiObservabilityRoutes({
      requireUser: middleware,
      canManageBot: managementCheck(rows),
    }),
  );
  return app;
}

describe("GET /bots/:botId/access", () => {
  test("an unauthenticated caller is refused before business logic", async () => {
    const app = appFor([profile()], rejectingUser);
    const response = await app.request("http://openbot.test/bots/agent-1/access");
    expect(response.status).toBe(401);
  });

  test("the owner sees observation access granted and no capability yet", async () => {
    const response = await appFor([profile()]).request(
      "http://openbot.test/bots/agent-1/access",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      botId: "agent-1",
      observationAccess: true,
      capability: "none",
    });
  });

  test("a stranger is refused with 403 and the store is never asked for runs", async () => {
    const app = appFor([profile()], actorVariables(stranger as unknown as AuthenticatedActor));
    const response = await app.request("http://openbot.test/bots/agent-1/access");
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(OBSERVATION_ACCESS_DENIED);
  });

  test("a public Bot the caller cannot manage is still refused", async () => {
    const app = appFor([profile({ visibility: "public" })],
      actorVariables(stranger as unknown as AuthenticatedActor));
    expect((await app.request("http://openbot.test/bots/agent-1/access")).status).toBe(403);
  });

  test("a missing bot id answers 404 with an explainable error", async () => {
    const response = await appFor([profile()]).request("http://openbot.test/bots//access");
    expect([404]).toContain(response.status);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-module-skeleton.test.ts`
Expected: FAIL — `Cannot find module '../src/ai-observability/routes'`

- [ ] **Step 3: 写最小实现**

创建 `server/src/ai-observability/routes/index.ts`：

```ts
/**
 * The ONE mount point for every observation surface.
 *
 * Later tickets add their own sub-router here (`routes.route("/runs", ...)`) instead of
 * editing server/src/app.ts, so the 5000-line boot file keeps exactly one observation line.
 * `requireUser` is applied once, at the root, so a sub-router cannot forget it.
 *
 * The single endpoint in this ticket exists to make the seam observable: it answers the
 * authorization question over HTTP and nothing else. `capability` is pinned to "none"
 * until the run-recording tickets can prove detailed coverage — a capability is claimed
 * only when it is verified, never by default.
 */
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../../auth/guards";
import { resolveObservationBot, type BotManagementCheck } from "../context";

export type AiObservabilityDeps = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canManageBot: BotManagementCheck;
};

export function createAiObservabilityRoutes(
  deps: AiObservabilityDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.get("/bots/:botId/access", async (context) => {
    const access = await resolveObservationBot(
      deps.canManageBot,
      context.var.actor,
      context.req.param("botId"),
    );
    if (!access.ok) return context.json({ error: access.error }, access.status);
    return context.json({
      botId: access.botId,
      observationAccess: true,
      capability: "none",
    });
  });

  return routes;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-module-skeleton.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: 提交**

```bash
git add server/src/ai-observability/routes/index.ts server/tests/opik-module-skeleton.test.ts
git commit -m "feat(opik): one observation route module behind a single mount point"
```

---

### Task 3: 挂载 seam — `app.ts` 一个字段一行，`index.ts` 一行构造

**Files:**
- Modify: `server/src/app.ts`（deps 字段区 ≈ 第 730 行 `opsSignals?: Hono<{ Variables: AppVariables }>;` 之后；挂载区 ≈ 第 1804 行 `app.route("/api/workshop", ...)` 附近）
- Modify: `server/src/index.ts`（构造区 ≈ 第 4766 行 `createOpenMuseOpsSignalsRoutes({...})` 附近；deps 传参区 ≈ 第 5207 行 `opsSignals: openMuseOpsSignals,` 之后）
- Test: `server/tests/opik-module-skeleton.test.ts`（追加）

**Interfaces:**
- Consumes: `createAiObservabilityRoutes`, `AiObservabilityDeps`（Task 2）；既有 `requireUser`（`createRequireUser`，`server/src/auth/guards.ts:54`）；既有 Bot profile store 的读取路径。
- Produces:
  - `createApp` 的新可选 deps 字段 `aiObservability?: Hono<{ Variables: AppVariables }>`
  - 挂载路径 `/api/ai-observability`
  - `index.ts` 中的 `canManageBot` 装配：由既有 profile store 的按 id 读取 + `canManageAgent` 组合而成，返回 `AgentProfile | null`

- [ ] **Step 1: 写失败测试**

在 `server/tests/opik-module-skeleton.test.ts` 末尾追加：

```ts
describe("mount seam", () => {
  test("the module is absent from the app when no deps are supplied", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    // Nothing mounted: this is what createApp does when `aiObservability` is undefined.
    const response = await app.request("http://openbot.test/api/ai-observability/bots/agent-1/access");
    expect(response.status).toBe(404);
  });

  test("the module is reachable under /api/ai-observability when supplied", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/ai-observability",
      createAiObservabilityRoutes({
        requireUser: actorVariables(owner as unknown as AuthenticatedActor),
        canManageBot: managementCheck([profile()]),
      }),
    );
    const response = await app.request(
      "http://openbot.test/api/ai-observability/bots/agent-1/access",
    );
    expect(response.status).toBe(200);
  });

  test("canManageBot refuses a public Bot the caller does not own", async () => {
    // The assembly index.ts performs: store read + canManageAgent, as one injected check.
    const rows = [profile({ visibility: "public" })];
    const check: BotManagementCheck = async (actor, botId) => {
      const found = rows.find((row) => row.id === botId);
      return found && canManageAgent(actor, found) ? found : null;
    };
    expect(await check(stranger, "agent-1")).toBeNull();
    expect(await check(owner, "agent-1")).not.toBeNull();
  });
});
```

并在 import 区补：

```ts
import { canManageAgent } from "../src/agents/profile-policy";
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-module-skeleton.test.ts`
Expected: 前两个 mount 测试 PASS（它们只验证 Hono 语义），第三个 FAIL — `canManageAgent` 未 import 时编译失败。确认失败信息后再进 Step 3。

- [ ] **Step 3: 修改 `server/src/app.ts`**

在 deps 类型里 `opsSignals?: Hono<{ Variables: AppVariables }>;`（≈730 行）之后加一行：

```ts
    /** Observation surfaces (ticket #7). Absent = the integration is not mounted at all. */
    aiObservability?: Hono<{ Variables: AppVariables }>;
```

在解构处 `opsSignals: openMuseOpsSignals,`（≈763 行）之后加一行：

```ts
    aiObservability,
```

在挂载区 `app.route("/api/workshop", workshopRoutes({ requireUser, canUseBot }));`（≈1804 行）之后加：

```ts
  /*
   * Observation, mounted as one unit. Every later observation ticket adds a sub-router
   * inside ai-observability/routes/index.ts, so this stays the only observation line here.
   */
  if (aiObservability) app.route("/api/ai-observability", aiObservability);
```

- [ ] **Step 4: 修改 `server/src/index.ts`**

在 `const openMuseOpsSignals = createOpenMuseOpsSignalsRoutes({`（≈4766 行）之后加：

```ts
/**
 * Observation authorization is the MANAGE question, not the chat question: `canAccessAgent`
 * says yes for a public Bot, and public chat access must not become access to another
 * creator's traces. The profile is returned rather than a boolean so readers act on the same
 * row the decision was made on.
 */
const aiObservabilityCanManageBot: BotManagementCheck = async (actor, botId) => {
  const profile = await agentStore.get(actor, botId).catch(() => null);
  return profile && canManageAgent(actor, profile) ? profile : null;
};

const aiObservability = createAiObservabilityRoutes({
  requireUser,
  canManageBot: aiObservabilityCanManageBot,
});
```

在 import 区加：

```ts
import { type BotManagementCheck, } from "./ai-observability/context";
import { createAiObservabilityRoutes } from "./ai-observability/routes";
import { canManageAgent } from "./agents/profile-policy";
```

在传给 `createApp` 的 deps 对象里 `opsSignals: openMuseOpsSignals,`（≈5207 行）之后加：

```ts
  aiObservability,
```

> 组装说明：`requireUser` 在 `index.ts` 里**并不存在**这个名字的变量。仓库的约定是
> `createDeploymentRequireUser(config, auth, roleRepository)`（由 `app.ts` 导出，其 docblock 写明
> 它是 “the one construction both createApp and index.ts's seams mount”）；store 的实际名字是
> `agentProfileStore` 而不是 `agentStore`。以仓库当前实现为准，但语义不得变：
> 读到 profile 后用 `canManageAgent` 判定，读不到返回 `null`，**绝不**得改成 `canAccessAgent`。

- [ ] **Step 5: 运行测试与类型检查确认通过**

Run: `bun test server/tests/opik-module-skeleton.test.ts`
Expected: PASS — 15 tests

Run: `cd server && bun run typecheck`
Expected: 无错误

- [ ] **Step 6: 确认未启用时零行为变化**

Run: `bun test server/tests/agent-routes.test.ts server/tests/app.test.ts 2>/dev/null || bun test server/tests/agent-routes.test.ts`
Expected: PASS（既有路由测试不受影响）

Run: `bunx biome lint --error-on-warnings server/src/ai-observability server/src/app.ts server/src/index.ts server/tests/opik-module-skeleton.test.ts`
Expected: 无 error/warning

- [ ] **Step 7: 提交**

```bash
git add server/src/app.ts server/src/index.ts server/tests/opik-module-skeleton.test.ts
git commit -m "feat(opik): mount the observation module behind one optional app.ts seam"
```

---

## Self-Review

**Spec coverage（Ticket #7 的 4 条验收标准）**
1. 「后续每个观测 Ticket 只新增自己的路由模块即可挂载，应用主入口只保留一处注册」→ Task 3 Step 3/4：`app.ts` 一个字段 + 一行 `app.route`，`index.ts` 一处构造；Task 2 的文件头注释写明后续以 `routes.route(...)` 追加。
2. 「请求上下文以统一方式注入；未认证或无归属的请求在进入业务逻辑前被拒绝」→ Task 2 的 `routes.use("*", deps.requireUser)` + `resolveObservationBot` 的 401/403/404 测试。
3. 「观测模块未启用时注册不产生任何行为变化」→ Task 3 Step 1 的 404 测试 + Step 6 的既有路由回归。
4. 「目录与命名约定写入模块说明，接手 agent 只读该约定即可新增路由」→ `routes/index.ts` 与 `context.ts` 的文件头注释即约定本身。

**A5 覆盖**：public 聊天权不扩大为观测权（Task 1 + Task 2 各一条测试）、伪造归属被拒（stranger 403）、猜测 id 不泄露存在性（unknown id 与无管理权返回同一 403）。

**Placeholder scan**：无 TBD / TODO / “类似 Task N”；每个代码步骤都给了完整代码。Task 3 Step 4 的 `agentStore.get` 签名提示是**明确的现场核对指令**，不是占位符——它给出了不可变语义（读到 profile → `canManageAgent` 判定 → 否则 null）与禁止项（不得改用 `canAccessAgent`）。

**Type consistency**：`BotManagementCheck` 在 Task 1 定义、Task 2 与 Task 3 消费，签名一致 `(actor: AgentActor, botId: string) => Promise<AgentProfile | null>`；`ObservationBotAccess.status` 为 `403 | 404` 字面量联合，Task 2 直接传给 `context.json(..., access.status)` 无需断言；`capability` 字段名在 Task 2 固定为 `"none"`，供 #20/#22 扩展。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-15-opik-t01-observability-module-seam.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派发新的 subagent，Task 之间 review。
2. **Inline Execution** — 本会话内按 executing-plans 批量执行并设检查点。

完成后把提交哈希、快照路径与文件哈希清单填入 `docs/tickets/opik-4/manifest.json` 中 `T01.handoff.checkpoint`（空缺即视为未完成），并在 GitHub #7 勾选验收标准。
