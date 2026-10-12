# OpenConnector Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenConnector (`oomol-lab/open-connector`, self-hosted) as a second broker beside Composio, so brokered apps reachable through a deployment-owned OpenConnector container get the same grants/policy/audit/connect surface Composio apps have.

**Architecture:** Parallel broker transport (spec's Option A). A new `TransportKind "open-connector"` with a REST transport module (`openconnector.ts`), a fetch-based vendor adapter implementing both the transport projection and the `ConnectedAppBroker` interface (`openconnector-adapter.ts`), and a generalization of the composio-hardcoded spots (`access.ts`, `store.ts`, `routes.ts`, admin/connected-accounts UI) into provenance-keyed registries. Per-person connections map to deterministic OpenConnector connection aliases carried in `brokered_connections.vendorUserId` and passed to the transport as `accountHandle`.

**Tech Stack:** Bun monorepo, TypeScript, Hono, drizzle-orm + PostgreSQL, TanStack Router/Query (app), bun test, biome.

**Spec:** `docs/superpowers/specs/2026-10-09-openconnector-integration-design.md`

## Global Constraints

- Repo: `/Users/wuyongjun/trea/OpenBot`. All `bun` commands run from repo root unless stated.
- Gate commands: `bun run typecheck` (all workspaces), `bun test` (all), `bun run lint` (= `bunx biome lint --error-on-warnings .`).
- **Tests never touch the network.** Every vendor seam is a narrow projection interface satisfied by an object literal stub (the composio suite's rule — see `server/tests/composio-transport.test.ts`).
- **Fail-closed everywhere:** an unlabelled action is a write; an unreadable scheme is refused, never guessed; an unknown provenance is not brokered.
- **No credential, alias-minting input, or connect URL may reach a log line, error body, or audit row.** Field *names* only, never values.
- Aliases are minted by OpenBot from system ids (`openbot-u-<user>-<service>` / `openbot-d-<deployment>-<service>`), never taken from request input.
- New env vars: `OPENCONNECTOR_URL` (default `http://localhost:3100`), `OPENCONNECTOR_ADMIN_TOKEN`, `OPENCONNECTOR_RUNTIME_TOKEN`. Unset tokens = supported, fully described state (one inert row under "More apps").
- Phase 1 offers `api_key`, `custom_credential`, `no_auth` providers only; `oauth2` providers map to `unsupported` and are filtered from the picker.
- Comment style in `server/src/plugins/` is long argumentative doc comments; match the idiom for new seams (why the shape is what it is), not inline noise.

---

### Task 1: Widen `brokered_connections.provider` in schema + migration

**Files:**
- Modify: `server/src/db/schema/plugins.ts` (the `brokeredConnections` table, ~line 410; the CHECK at `brokered_connections_provider_check`)
- Create: `server/drizzle/00XX_brokered-connections-open-connector.sql` (generated)

**Interfaces:**
- Consumes: existing `brokeredConnections` table.
- Produces: `brokered_connections.provider` accepting `"composio" | "open-connector"`; migration SQL every later task's inserts rely on.

- [ ] **Step 1: Edit the schema type and CHECK**

In `server/src/db/schema/plugins.ts`, change (keep the surrounding docblocks; extend the `THE SUCCESSOR TO composio_connections` docblock with one sentence: OpenConnector rows carry `provider = 'open-connector'` and hold the OpenConnector connection alias in `vendor_user_id`):

```ts
// before
provider: text("provider").$type<"composio">().notNull(),
// after
provider: text("provider").$type<"composio" | "open-connector">().notNull(),
```

```ts
// before
check(
  "brokered_connections_provider_check",
  sql`${table.provider} IN ('composio')`,
),
// after
check(
  "brokered_connections_provider_check",
  sql`${table.provider} IN ('composio', 'open-connector')`,
),
```

- [ ] **Step 2: Generate the migration**

Run: `grep -n "drizzle" server/package.json` to find the generate script name, then run it from `server/` (fallback: `cd server && bunx drizzle-kit generate`). Name it `brokered_connections_open_connector` when prompted.

Expected: a new numbered SQL file in `server/drizzle/` whose statements drop `brokered_connections_provider_check` and re-add it with both values (`ALTER TABLE ... DROP CONSTRAINT brokered_connections_provider_check;` then `ADD CONSTRAINT ... CHECK (provider IN ('composio', 'open-connector'))`). Postgres cannot alter a CHECK in place; drizzle-kit knows this. If the generated file instead drops/recreates the table, stop and write the two `ALTER` statements by hand in the generated file.

- [ ] **Step 3: Verify**

Run: `bun run --filter server typecheck && bun test server/tests/plugin-store.integration.test.ts`
Expected: PASS (no behavior changed; type widened only).

- [ ] **Step 4: Commit**

```bash
git add server/src/db/schema/plugins.ts server/drizzle/
git commit -m "feat(plugins): widen brokered_connections.provider for a second broker"
```

---

### Task 2: Add `CUSTOM_CREDENTIAL` to the field-scheme vocabulary in `broker.ts`

**Files:**
- Modify: `server/src/plugins/broker.ts:31-52` (`FIELD_SCHEME_NAMES` + docblock)
- Test: `server/tests/composio-connection-kinds.test.ts` (roster extension)

**Interfaces:**
- Consumes: `FieldScheme`, `isFieldScheme`, `schemeKind` (unchanged shapes).
- Produces: `"CUSTOM_CREDENTIAL"` as a valid `FieldScheme`; `schemeKind("CUSTOM_CREDENTIAL") === "key"`. Task 5's broker maps OpenConnector's `custom_credential` auth type onto it.

- [ ] **Step 1: Write the failing test**

In `server/tests/composio-connection-kinds.test.ts`, find the table/roster that enumerates scheme literals (the file reads its rows off a list — see its imports). Add a row asserting `schemeKind("CUSTOM_CREDENTIAL")` answers `"key"` and `isFieldScheme("CUSTOM_CREDENTIAL")` is true. If the file has a "names the whole vocabulary" count test, update the count.

```ts
test("custom_credential is a field scheme the person types", () => {
  expect(isFieldScheme("CUSTOM_CREDENTIAL")).toBe(true);
  expect(schemeKind("CUSTOM_CREDENTIAL")).toBe("key");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test server/tests/composio-connection-kinds.test.ts`
Expected: FAIL (`CUSTOM_CREDENTIAL` not in vocabulary).

- [ ] **Step 3: Extend the list**

In `broker.ts`:

```ts
// before
const FIELD_SCHEME_NAMES = [
  "API_KEY",
  "BASIC",
  "BEARER_TOKEN",
  "BASIC_WITH_JWT",
] as const;
// after
const FIELD_SCHEME_NAMES = [
  "API_KEY",
  "BASIC",
  "BEARER_TOKEN",
  "BASIC_WITH_JWT",
  /** OpenConnector's per-provider field set — a secret (or set of fields) the person already holds. */
  "CUSTOM_CREDENTIAL",
] as const;
```

Also add one sentence to the docblock above it: this member is OpenConnector's, Composio never writes it, and it exists so a provider whose fields are not one secret box still connects through the fields path instead of being refused as unreadable.

- [ ] **Step 4: Run to verify pass**

Run: `bun test server/tests/composio-connection-kinds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/plugins/broker.ts server/tests/composio-connection-kinds.test.ts
git commit -m "feat(plugins): admit CUSTOM_CREDENTIAL as a field scheme (OpenConnector)"
```

---

### Task 3: Shared `BROKERED_PROVENANCES` + app shim

**Files:**
- Create: `shared/src/brokered-provenance.ts`
- Create: `shared/src/brokered-provenance.test.ts`
- Create: `app/src/lib/brokered-provenance.ts` (browser shim)

**Interfaces:**
- Produces (used by Tasks 7, 8, 11):

```ts
export const BROKERED_PROVENANCES = ["composio", "open-connector"] as const;
export type BrokeredProvenance = (typeof BROKERED_PROVENANCES)[number];
export function isBrokeredProvenance(value: string): value is BrokeredProvenance;
```

- [ ] **Step 1: Write the shared module**

`shared/src/brokered-provenance.ts`:

```ts
/**
 * Every provenance value that means "this row was enabled through a broker".
 *
 * ONE LIST IN `shared/` because two processes need it and they share no module: the server reads it
 * to decide whether a row is brokered at all, and the browser reads it to decide whether a
 * connected-accounts row is a brokered one. A second declaration in `app/src` is the drift the
 * composio string checks already suffered — `provenance === "composio"` written four times across
 * two files, each of which a third broker would have to find.
 */
export const BROKERED_PROVENANCES = ["composio", "open-connector"] as const;

export type BrokeredProvenance = (typeof BROKERED_PROVENANCES)[number];

export function isBrokeredProvenance(
  value: string,
): value is BrokeredProvenance {
  return (BROKERED_PROVENANCES as readonly string[]).includes(value);
}
```

`shared/src/brokered-provenance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  BROKERED_PROVENANCES,
  isBrokeredProvenance,
} from "./brokered-provenance";

describe("brokered provenances", () => {
  test("composio and open-connector are the members", () => {
    expect(BROKERED_PROVENANCES).toEqual(["composio", "open-connector"]);
  });
  test("narrows without admitting anything else", () => {
    expect(isBrokeredProvenance("composio")).toBe(true);
    expect(isBrokeredProvenance("open-connector")).toBe(true);
    expect(isBrokeredProvenance("first-party")).toBe(false);
    expect(isBrokeredProvenance("custom")).toBe(false);
    expect(isBrokeredProvenance("openconnector")).toBe(false);
  });
});
```

- [ ] **Step 2: Write the browser shim**

Copy the import-path pattern from `app/src/lib/copilot/markers.ts` (its docblock explains the shim pattern; use the exact relative specifier style that file uses to reach `shared/`). `app/src/lib/brokered-provenance.ts`:

```ts
/**
 * Re-export of `shared/src/brokered-provenance.ts` so browser code imports through `@/` and the
 * path to `shared/` is written once. See `@/lib/copilot/markers` for the pattern.
 */
export {
  BROKERED_PROVENANCES,
  isBrokeredProvenance,
} from "../../../shared/src/brokered-provenance";
export type { BrokeredProvenance } from "../../../shared/src/brokered-provenance";
```

(Adjust the relative prefix to match what `markers.ts` uses — `app/src/lib/` and `app/src/lib/copilot/` are one level apart.)

- [ ] **Step 3: Verify**

Run: `bun test shared/src/brokered-provenance.test.ts && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 4: Commit**

```bash
git add shared/src/brokered-provenance.ts shared/src/brokered-provenance.test.ts app/src/lib/brokered-provenance.ts
git commit -m "feat(shared): one list of brokered provenances for server and browser"
```

---

### Task 4: `openconnector.ts` transport + TransportKind registration

**Files:**
- Create: `server/src/plugins/openconnector.ts`
- Modify: `server/src/plugins/transport.ts:118-148` (`TransportKind`, `CuratedTransportKind`, `TRANSPORTS`) and the `VendorTransport.callTool` connection type (~line 84-108) to add optional `accountHandle`
- Create: `server/tests/openconnector-transport.test.ts`

**Interfaces:**
- Consumes: `VendorTransport`, `ListedTool`, `McpCallResult` (from `./mcp`), `BrokeredProvenance`.
- Produces (Tasks 5, 6, 7, 8 rely on these exact names):

```ts
export type OpenConnectorAction = { id: string; description: string; inputSchema: unknown };
export type OpenConnectorActions = {
  listActions(service: string): Promise<OpenConnectorAction[]>;
  execute(
    call: { service: string; actionId: string; alias: string | null },
    input: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};
export function useOpenConnectorClient(client: OpenConnectorActions | null): void;
export const listNeedsCredential: false;
export function toolkitOf(url: string): string | null;      // openconnector://<service>
export function personalAlias(userId: string, service: string): string;
export function deploymentAlias(deploymentId: string, service: string): string;
export function isAlias(value: string | null | undefined): boolean;
export function listTools(connection: { url: string }): Promise<ListedTool[]>;
export function callTool(
  connection: { url: string; accountHandle?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult>;
```

- [ ] **Step 1: Read the two shapes this module must satisfy**

Read `server/src/plugins/mcp.ts` (the `ListedTool` and `McpCallResult` type definitions and how a call result is constructed) and `server/src/plugins/composio.ts:593-700` (`listTools` result construction) so the code below constructs results the way `composio.ts` does. If `McpCallResult` differs from `{ content: Array<{ type: "text"; text: string }>; isError: boolean }`, adjust the two constructor sites only — test assertions stay behavioural.

- [ ] **Step 2: Write the failing tests**

`server/tests/openconnector-transport.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  deploymentAlias,
  isAlias,
  listTools,
  callTool,
  personalAlias,
  toolkitOf,
  useOpenConnectorClient,
  type OpenConnectorActions,
} from "../src/plugins/openconnector";

const stub: OpenConnectorActions = {
  listActions: async () => [
    { id: "github.get_current_user", description: "Get the authenticated user", inputSchema: { type: "object" } },
  ],
  execute: async (call) => ({ data: { login: "octocat" } }),
};

afterEach(() => useOpenConnectorClient(null));

describe("toolkitOf", () => {
  test("reads the service off an openconnector url", () => {
    expect(toolkitOf("openconnector://github")).toBe("github");
  });
  test("null for anything else, including paths and other schemes", () => {
    expect(toolkitOf("composio://github")).toBeNull();
    expect(toolkitOf("openconnector://github/repo")).toBeNull();
    expect(toolkitOf("openconnector://")).toBeNull();
    expect(toolkitOf("https://example.com")).toBeNull();
  });
});

describe("aliases", () => {
  test("personal and deployment aliases are distinct and deterministic", () => {
    expect(personalAlias("user-1", "github")).toBe(personalAlias("user-1", "github"));
    expect(personalAlias("user-1", "github")).not.toBe(personalAlias("user-2", "github"));
    expect(deploymentAlias("dep-1", "github")).toMatch(/^openbot-d-/);
    expect(personalAlias("user-1", "github")).toMatch(/^openbot-u-/);
  });
  test("characters outside the safe set are escaped, so a service or id cannot forge another", () => {
    expect(personalAlias("user:1/x", "github")).not.toContain(":");
    expect(personalAlias("user-1", "git hub")).not.toContain(" ");
  });
  test("isAlias admits only minted aliases", () => {
    expect(isAlias(personalAlias("u", "github"))).toBe(true);
    expect(isAlias("some-person-id")).toBe(false);
    expect(isAlias(undefined)).toBe(false);
  });
});

describe("listTools", () => {
  test("lists the service's actions once a client is installed", async () => {
    useOpenConnectorClient(stub);
    const tools = await listTools({ url: "openconnector://github" });
    expect(tools.map((tool) => tool.name)).toEqual(["github.get_current_user"]);
  });
  test("refuses without an installed client rather than answering empty", async () => {
    await expect(listTools({ url: "openconnector://github" })).rejects.toThrow(/not configured/i);
  });
  test("refuses a url that is not one of ours rather than asking the vendor", async () => {
    useOpenConnectorClient(stub);
    await expect(listTools({ url: "https://example.com" })).rejects.toThrow();
  });
});

describe("callTool", () => {
  test("dials with the alias handle when one is set", async () => {
    useOpenConnectorClient(stub);
    const result = await callTool(
      { url: "openconnector://github", accountHandle: personalAlias("u1", "github") },
      "github.get_current_user",
      {},
    );
    expect(result.isError).toBe(false);
  });
  test("dials without an alias for a no-auth service (virtual connection)", async () => {
    useOpenConnectorClient(stub);
    const result = await callTool({ url: "openconnector://hackernews" }, "hackernews.get_top_stories", {});
    expect(result.isError).toBe(false);
  });
  test("a non-alias actorId is not sent as an alias", async () => {
    useOpenConnectorClient({
      ...stub,
      execute: async (call) => {
        expect(call.alias).toBeNull();
        return { data: {} };
      },
    });
    await callTool({ url: "openconnector://github" }, "github.get_current_user", {});
  });
  test("refuses a url with no service", async () => {
    useOpenConnectorClient(stub);
    const result = await callTool({ url: "https://example.com" }, "github.get_current_user", {});
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test server/tests/openconnector-transport.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 4: Write the transport module**

`server/src/plugins/openconnector.ts`. The refusals must be `isError: true` results with this deployment's own sentences (mirroring `composio.ts`'s three-failure-kinds comment, abbreviated to this broker's two: refused before dialling, vendor reported failure):

```ts
import type { ListedTool, McpCallResult } from "./mcp";

/**
 * How this deployment calls OpenConnector the TRANSPORT: one service's actions, dialled over REST
 * with a per-person connection alias. Everything about connecting (directory, fields, lifecycle)
 * lives in `./openconnector-adapter`; this module imports no vendor and no fetch, exactly as
 * `./composio` does not.
 *
 * THE ALIAS IS THE ACCOUNT HANDLE. Composio keeps people apart by a user id sent with every call;
 * OpenConnector is single-tenant and keeps them apart by named connections selected per call. The
 * per-person mapping is therefore minted here, deterministically, from ids this deployment already
 * trusts — `openbot-u-<user>-<service>` for a person, `openbot-d-<deployment>-<service>` for a
 * shared account — and rides `brokered_connections.vendorUserId` to the call, arriving as
 * `accountHandle`. A value that is not one of ours is never sent as an alias: the only actorId a
 * call can carry that is not an alias is a person's id on a NO_AUTH service, where OpenConnector
 * uses its virtual connection and no alias may be named.
 */
export type OpenConnectorAction = {
  id: string;
  description: string;
  inputSchema: unknown;
};

export type OpenConnectorActions = {
  listActions(service: string): Promise<OpenConnectorAction[]>;
  execute(
    call: { service: string; actionId: string; alias: string | null },
    input: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};

let installed: OpenConnectorActions | null = null;

/** The seam `index.ts` hands this module its client through, once, at startup. `null` uninstalls. */
export function useOpenConnectorClient(client: OpenConnectorActions | null): void {
  installed = client;
}

export const listNeedsCredential = false;

const SERVICE_SLUG = /^[A-Za-z0-9_-]+$/;

/** Which service this connection is about — `openconnector://github` — or null for anything else. */
export function toolkitOf(url: string): string | null {
  const prefix = "openconnector://";
  if (!url.startsWith(prefix)) return null;
  const slug = url.slice(prefix.length).trim().replace(/\/+$/, "");
  return SERVICE_SLUG.test(slug) ? slug : null;
}

function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (ch) => `~${ch.charCodeAt(0).toString(16)}`);
}

/** The alias one person's connection to one service lives under at the broker. */
export function personalAlias(userId: string, service: string): string {
  return `openbot-u-${segment(userId)}-${segment(service)}`;
}

/** The alias this deployment's own shared connection to one service lives under. */
export function deploymentAlias(deploymentId: string, service: string): string {
  return `openbot-d-${segment(deploymentId)}-${segment(service)}`;
}

/** Whether a value was minted above — the only aliases this transport ever names. */
export function isAlias(value: string | null | undefined): boolean {
  return typeof value === "string" && /^openbot-[ud]-/.test(value);
}

export async function listTools(connection: { url: string }): Promise<ListedTool[]> {
  const service = toolkitOf(connection.url);
  if (!service) {
    throw new Error(`This row's url is not an OpenConnector service address, so there is nothing to list.`);
  }
  if (!installed) {
    throw new Error(
      "OpenConnector is not configured for this deployment, so nothing was asked. Set OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN to make its apps available.",
    );
  }
  const actions = await installed.listActions(service);
  return actions.map((action) => ({
    name: action.id,
    description: action.description,
    inputSchema: action.inputSchema,
  }));
}

export async function callTool(
  connection: { url: string; accountHandle?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const service = toolkitOf(connection.url);
  if (!service) {
    return failure(`This row's url is not an OpenConnector service address, so ${toolName} was not called.`);
  }
  if (!installed) {
    return failure(
      "OpenConnector is not configured for this deployment, so nothing was asked. Set OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN.",
    );
  }
  const alias = isAlias(connection.accountHandle) ? connection.accountHandle : null;
  try {
    const answer = await installed.execute({ service, actionId: toolName, alias }, args);
    return success(JSON.stringify(answer.data ?? null));
  } catch (error) {
    return failure(vendorSentence(error));
  }
}

function vendorSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.trim() === ""
    ? "OpenConnector said nothing about why this action failed. Check its container and its logs."
    : message;
}
```

Add `success`/`failure` helpers constructing `McpCallResult` exactly as `composio.ts` does (Step 1's reading): `failure(text)` → `{ content: [{ type: "text", text }], isError: true }`, `success(text)` → same with `isError: false`.

- [ ] **Step 5: Register the kind in `transport.ts`**

Three edits in `server/src/plugins/transport.ts`:

```ts
// 1. import (beside the composio import)
import * as openConnector from "./openconnector";

// 2. the union (line ~118)
export type TransportKind =
  | "mcp"
  | "google-drive-rest"
  | "builtin-routines"
  | "composio"
  | "open-connector";

// 3. the registry (line ~143)
const TRANSPORTS: Record<TransportKind, VendorTransport> = {
  mcp,
  "google-drive-rest": driveRest,
  "builtin-routines": builtinRoutines,
  composio,
  "open-connector": openConnector,
};
```

And widen the exclusion (line ~141) plus its docblock's one-liner:

```ts
export type CuratedTransportKind = Exclude<TransportKind, "composio" | "open-connector">;
```

Add the optional `accountHandle` field to `VendorTransport`'s `callTool` connection type (beside `actorId`/`botId`), with a docblock: *The broker-side handle of the account this call runs in — OpenConnector's connection alias. Absent for a call that runs on no account of anybody's (a no-auth service), and ignored by every transport whose authorization is a credential rather than an actor.* Extend the existing docblock paragraph about optional superset fields rather than replacing it.

- [ ] **Step 6: Run to verify pass + full typecheck**

Run: `bun test server/tests/openconnector-transport.test.ts && bun run --filter server typecheck`
Expected: PASS / clean (the `TRANSPORTS` record forces the module to satisfy `VendorTransport`; `access.ts` does not know the kind yet, which is fine).

- [ ] **Step 7: Commit**

```bash
git add server/src/plugins/openconnector.ts server/src/plugins/transport.ts server/tests/openconnector-transport.test.ts
git commit -m "feat(plugins): OpenConnector transport and the open-connector TransportKind"
```

---

### Task 5: `openconnector-adapter.ts` — vendor projection, actions client, broker

**Files:**
- Create: `server/src/plugins/openconnector-adapter.ts`
- Create: `server/tests/openconnector-adapter.test.ts`

**Interfaces:**
- Consumes: `OpenConnectorActions`, `useOpenConnectorClient` (Task 4); `ConnectedAppBroker`, `BrokerApp`, `BrokerConnection`, `BrokerField`, `BrokerRefusalError` (broker.ts); `AccountRef` (shared-accounts).
- Produces (Tasks 6, 8, 9 rely on):

```ts
export type OpenConnectorConfig = { url: string; adminToken: string; runtimeToken: string };
export function createOpenConnectorClient(config: OpenConnectorConfig): {
  actions: OpenConnectorActions;
  broker: ConnectedAppBroker;
};
```

- [ ] **Step 1: Write the failing tests**

`server/tests/openconnector-adapter.test.ts`. Style: object-literal vendor stubs; the only network-shaped thing under test is what `createOpenConnectorClient` is allowed to do at construction time (nothing — construction builds closures, no calls), plus the broker's pure mapping decisions. Inject fetch as the vendor seam so no stub needs a socket:

```ts
import { describe, expect, test } from "bun:test";
import { buildOpenConnectorClient } from "../src/plugins/openconnector-adapter";

function clientWith(dial: (path: string, init: { method: string; body?: unknown; headers: Record<string, string> }) => Promise<unknown>) {
  return buildOpenConnectorClient({
    dial: async (path, init) => ({
      ok: true,
      json: async () => dial(path, init),
    }),
  });
}

describe("the broker", () => {
  test("maps auth types onto broker connections, oauth2 to unsupported", async () => {
    const client = clientWith(async (path) => {
      if (path === "/v1/providers") {
        return { data: [
          { service: "github", name: "GitHub", description: "", authType: "api_key" },
          { service: "hackernews", name: "Hacker News", description: "", authType: "no_auth" },
          { service: "example-oauth", name: "Example", description: "", authType: "oauth2" },
        ] };
      }
      if (path === "/v1/actions") return { data: [{ service: "github", id: "github.get_current_user" }, { service: "github", id: "github.create_issue" }] };
      throw new Error(`unexpected ${path}`);
    });
    const apps = await client.broker.listApps();
    const bySlug = Object.fromEntries(apps.map((app) => [app.slug, app]));
    expect(bySlug.github.connection).toEqual({ kind: "fields", authScheme: "API_KEY" });
    expect(bySlug.github.actionCount).toBe(2);
    expect(bySlug.hackernews.connection).toEqual({ kind: "no-auth" });
    expect(bySlug["example-oauth"].connection.kind).toBe("unsupported");
  });

  test("connectWithFields sends the alias as connectionName and values verbatim", async () => {
    const seen: unknown[] = [];
    const client = clientWith(async (path, init) => {
      if (path === "/api/connections/github" && init.method === "PUT") {
        seen.push(init.body);
        return { data: {} };
      }
      throw new Error(`unexpected ${path}`);
    });
    const answer = await client.broker.connectWithFields({
      account: { holder: "person", userId: "user-1", vendorUserId: "openbot-u-user-1-github" },
      toolkit: "github",
      authScheme: "API_KEY",
      values: { apiKey: "ghp_secret" },
    });
    expect(answer.accountId).toBe("openbot-u-user-1-github");
    expect(seen[0]).toEqual({
      authType: "api_key",
      values: { apiKey: "ghp_secret" },
      connectionName: "openbot-u-user-1-github",
    });
  });

  test("authorize refuses: consent apps are not offered, so this is never reachable", async () => {
    const client = clientWith(async () => { throw new Error("should not dial"); });
    await expect(
      client.broker.authorize({ account: { holder: "person", userId: "u", vendorUserId: "a" }, toolkit: "x", returnUrl: "https://openbot.test/settings" }),
    ).rejects.toThrow(/not offered/i);
  });

  test("ensureAuthConfig answers not-needed: key and custom apps have no config at the broker", async () => {
    const client = clientWith(async () => { throw new Error("should not dial"); });
    const outcome = await client.broker.ensureAuthConfig({
      toolkit: "github", name: "GitHub",
      connection: { kind: "fields", authScheme: "API_KEY" },
    });
    expect(outcome).toBe("not-needed");
  });

  test("revoke answers whether the connection was there", async () => {
    let deleted = 0;
    const client = clientWith(async (path, init) => {
      if (path.startsWith("/api/connections/") && init.method === "DELETE") {
        deleted += 1;
        return { data: {} };
      }
      throw new Error(`unexpected ${path}`);
    });
    const gone = await client.broker.revoke({
      account: { holder: "person", userId: "u", vendorUserId: "openbot-u-u-github" },
      toolkit: "github",
    });
    expect(gone).toBe(true);
    expect(deleted).toBe(1);
  });
});

describe("the actions client", () => {
  test("execute reaches /v1/actions/<id> with the alias header and input body", async () => {
    const seen: { path: string; headers: Record<string, string>; body: unknown }[] = [];
    const client = clientWith(async (path, init) => {
      seen.push({ path, headers: init.headers, body: init.body });
      return { data: { login: "octocat" } };
    });
    await client.actions.execute({ service: "github", actionId: "github.get_current_user", alias: "openbot-u-u-github" }, {});
    expect(seen[0].path).toBe("/v1/actions/github.get_current_user");
    expect(seen[0].headers["x-oo-connector-alias"]).toBe("openbot-u-u-github");
    expect(seen[0].body).toEqual({ input: {} });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test server/tests/openconnector-adapter.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Write the adapter**

`server/src/plugins/openconnector-adapter.ts`. Skeleton with the load-bearing parts spelled out:

```ts
import {
  BrokerRefusalError,
  type AuthConfigOutcome,
  type BrokerApp,
  type BrokerConnection,
  type BrokerField,
  type ConnectedAppBroker,
} from "./broker";
import type { AccountRef } from "./shared-accounts";
import type { OpenConnectorAction, OpenConnectorActions } from "./openconnector";

/** The one place tokens exist: in headers this file builds, from config `index.ts` read. */
export type OpenConnectorConfig = { url: string; adminToken: string; runtimeToken: string };

type Wire = {
  ok: boolean;
  status: number;
  json: async () => unknown;
};

/** Injectable so every test is an object literal. Production: `fetch` with redirect: "manual". */
export type WireDial = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Wire>;

/** The vendor as this deployment is allowed to see it — a projection, never their SDK. */
type Vendor = {
  listProviders(): Promise<{ service: string; name: string; description: string; authType: string }[]>;
  listAllActions(): Promise<{ service: string; id: string; description: string; inputSchema: unknown }[]>;
  providerFields(service: string): Promise<{ name: string; label: string | null; description: string | null; required: boolean | null; secret: boolean | null }[]>;
  putConnection(service: string, body: { authType: string; values: Record<string, string>; connectionName: string }): Promise<void>;
  deleteConnection(service: string, connectionName: string): Promise<void>;
  connectionExists(service: string, connectionName: string): Promise<boolean>;
};
```

Implement `buildOpenConnectorClient(vendor-ish input)` in two layers, exactly as `composio-adapter.ts` splits `buildComposioClient(vendor, now)` from `createComposioClient(apiKey)`:

1. `buildOpenConnectorClient({ dial }: { dial: WireDial })` — pure assembly. A `request(path, face, method, body?, alias?)` helper: face `"runtime"` sends `Authorization: Bearer <runtimeToken>` and `/v1` paths; face `"admin"` sends the admin token and `/api` paths; `x-oo-connector-alias` header only when an alias is passed. Response handling: `ok === false` or a body of `{ success: false, message }` → `throw new Error(message)` (the vendor's own sentence; no request object attached, matching the connectWithFields no-`cause` rule); a body that is not JSON → `throw new Error("OpenConnector answered with something this deployment could not read.")`. No redirects are followed (`redirect: "manual"` at the fetch layer).

2. `actions` — map `listActions(service)` from `vendor.listAllActions().filter(a => a.service === service)` (the directory endpoint already fetched everything for `listApps`; the actions client filters rather than re-dials, and the route-level TTL cache keeps that honest), and `execute` from `vendor`'s POST with alias header.

3. `broker: ConnectedAppBroker`:

```ts
const broker: ConnectedAppBroker = {
  async listApps(): Promise<BrokerApp[]> {
    const [providers, actions] = await Promise.all([vendor.listProviders(), vendor.listAllActions()]);
    const counts = new Map<string, number>();
    for (const action of actions) counts.set(action.service, (counts.get(action.service) ?? 0) + 1);
    return providers.map((provider) => ({
      slug: provider.service,
      name: provider.name,
      description: provider.description,
      logo: null,
      categories: [],
      actionCount: counts.get(provider.service) ?? 0,
      connection: connectionFor(provider.authType),
    }));
  },
  async ensureAuthConfig(): Promise<AuthConfigOutcome> { return "not-needed"; },
  async deleteAuthConfig(): Promise<void> { /* nothing was ever created; see docblock */ },
  async authorize(): Promise<{ redirectUrl: string }> {
    throw new BrokerRefusalError(
      "This app connects through a consent screen, and consent apps are not offered through OpenConnector here yet — there is nowhere to hold the OAuth client it would need. Choose an app that connects with a key.",
    );
  },
  async isConnected(request) { return vendor.connectionExists(request.toolkit, aliasOf(request.account, request.toolkit)); },
  async revoke(request) { await vendor.deleteConnection(request.toolkit, aliasOf(request.account, request.toolkit)); return true; },
  async revokeAccount(accountId) { /* accountId IS the alias; split service off it is not possible, so the caller passes both via revoke — this method deletes by alias alone at /api/connections/<service> which needs the service… */ },
  async connectionFields(request) { /* map providerFields to BrokerField; refuse non-text with BrokerRefusalError */ },
  async connectWithFields(request) {
    await vendor.putConnection(request.toolkit, {
      authType: authTypeFor(request.authScheme),
      values: request.values,
      connectionName: request.account.vendorUserId,
    });
    return { accountId: request.account.vendorUserId };
  },
  async accountName() { return null; },
};
```

Write `revokeAccount` properly: it receives only the accountId (the alias). Since the alias embeds the escaped service as its final segment, parse it back: split on the last `-` of the un-escaped tail… **do not parse it.** Instead: keep a `deleteByAlias(alias)` vendor call that hits `GET /api/connections` (admin list), finds the connection whose `connectionName`/stable id matches, and issues the DELETE with its service. That is two admin calls for an undo path that phase 1 never runs (no probes); document it. Simpler and honest: implement `revokeAccount` by scanning `vendor`'s connection list; if nothing matches, throw (`nothing was there, which is a failure on an undo path`).

Helpers:

```ts
function connectionFor(authType: string): BrokerConnection {
  if (authType === "no_auth") return { kind: "no-auth" };
  if (authType === "api_key") return { kind: "fields", authScheme: "API_KEY" };
  if (authType === "custom_credential") return { kind: "fields", authScheme: "CUSTOM_CREDENTIAL" };
  return { kind: "unsupported", reason: `connects through ${authType}, which this deployment does not drive yet` };
}
function authTypeFor(scheme: string): string {
  if (scheme === "CUSTOM_CREDENTIAL") return "custom_credential";
  return "api_key";
}
function aliasOf(account: AccountRef, service: string): string {
  return account.vendorUserId; // minted by the caller from openconnector.ts's personalAlias/deploymentAlias
}
```

Finally `createOpenConnectorClient(config: OpenConnectorConfig)` builds the `dial` from global `fetch` (`redirect: "manual"`, `new URL(path, config.url)`) and returns `buildOpenConnectorClient({ dial })`'s `{ actions, broker }`.

4. Boot-construction test (in the same test file): constructing via `createOpenConnectorClient({ url: "http://localhost:3100", adminToken: "a", runtimeToken: "r" })` performs no request (assert via a `dial` spy injected where possible; construction must only close over config).

- [ ] **Step 4: Run to verify pass**

Run: `bun test server/tests/openconnector-adapter.test.ts && bun run --filter server typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/plugins/openconnector-adapter.ts server/tests/openconnector-adapter.test.ts
git commit -m "feat(plugins): OpenConnector vendor adapter with actions client and broker"
```

---

### Task 6: Config env vars + boot assembly

**Files:**
- Modify: `server/src/config.ts:219` area (type) and `:1283` area (read)
- Modify: `server/src/index.ts:196-197` (imports), `:670-673` (assembly), and the `PluginStore`/routes construction sites (locate by grep)

**Interfaces:**
- Consumes: `createOpenConnectorClient`, `useOpenConnectorClient` (Tasks 4-5).
- Produces: `config.openConnectorUrl` (`string`, default `"http://localhost:3100"`), `config.openConnectorAdminToken` / `config.openConnectorRuntimeToken` (`string | undefined`); an `openConnector` value in `index.ts` passed into the plugin store and routes deps in Tasks 8-9.

- [ ] **Step 1: Add the config fields**

In `config.ts`, beside `composioApiKey: string | undefined;` (~line 219):

```ts
/** Where this deployment's OpenConnector container listens. Set by the deployer, never by a request. */
openConnectorUrl: string;
openConnectorAdminToken: string | undefined;
openConnectorRuntimeToken: string | undefined;
```

Beside `composioApiKey: optional(environment, "COMPOSIO_API_KEY"),` (~line 1283):

```ts
openConnectorUrl:
  optional(environment, "OPENCONNECTOR_URL") ?? "http://localhost:3100",
openConnectorAdminToken: optional(environment, "OPENCONNECTOR_ADMIN_TOKEN"),
openConnectorRuntimeToken: optional(environment, "OPENCONNECTOR_RUNTIME_TOKEN"),
```

- [ ] **Step 2: Assemble at boot**

In `index.ts`, beside the composio block at ~670 (keep its comment's shape; the unconfigured state is equally supported):

```ts
import { useOpenConnectorClient } from "./plugins/openconnector";
import { createOpenConnectorClient } from "./plugins/openconnector-adapter";

const openConnector =
  config.openConnectorAdminToken && config.openConnectorRuntimeToken
    ? createOpenConnectorClient({
        url: config.openConnectorUrl,
        adminToken: config.openConnectorAdminToken,
        runtimeToken: config.openConnectorRuntimeToken,
      })
    : null;
if (openConnector) useOpenConnectorClient(openConnector.actions);
```

Then find where the plugin store and the plugins routes are constructed (`grep -n "composio" server/src/index.ts | grep -iv client` — the store/routes deps objects that receive `composio`): add `openConnector` alongside `composio` in both deps. If the store's deps type does not accept it yet, add `openConnector?: { broker: ConnectedAppBroker }` beside the existing `composio?: { broker: ComposioBroker }` (store deps ~store.ts:204-equivalent — the routes one is `routes.ts:204`). The store's use of it lands in Task 8; passing it now typechecks because the field is optional.

- [ ] **Step 3: Verify + commit**

Run: `bun run --filter server typecheck && bun test server/tests`
Expected: clean / PASS (no behavior reachable yet).

```bash
git add server/src/config.ts server/src/index.ts
git commit -m "feat(plugins): OpenConnector env config and boot assembly"
```

---

### Task 7: Generalize `access.ts` to a provenance-keyed broker registry

**Files:**
- Modify: `server/src/plugins/access.ts`
- Create: `server/tests/openconnector-access.test.ts`
- Modify: `server/tests/composio-access.test.ts` (message assertions if they name composio only)

**Interfaces:**
- Consumes: `toolkitOf` from `./composio` and `./openconnector`; `BROKERED_PROVENANCES` (Task 3).
- Produces (Task 8 relies on): `ServerAccess` gains `broker: BrokeredProvenance | null` (null on every non-brokered answer); `accessFor` resolves `"open-connector"` rows to `{ transport: "open-connector", credential: "brokered", toolkit, broker: "open-connector", ... }`.

- [ ] **Step 1: Write the failing tests**

`server/tests/openconnector-access.test.ts`, mirroring `composio-access.test.ts`'s enumeration style:

```ts
import { describe, expect, test } from "bun:test";
import { accessFor, CatalogueTransportUnroutableError, ServerRowAmbiguousError } from "../src/plugins/access";
import { CATALOGUE } from "../src/plugins/catalogue";

const row = (over: Partial<Parameters<typeof accessFor>[0][0]>) => ({
  provenance: "open-connector",
  url: "openconnector://github",
  authScheme: "API_KEY",
  accountMode: null,
  ...over,
});

describe("accessFor on an open-connector row", () => {
  test("resolves to the brokered open-connector transport with the service as toolkit", () => {
    expect(accessFor(row({}), null)).toMatchObject({
      transport: "open-connector", credential: "brokered", toolkit: "github", broker: "open-connector", reachedAs: "person",
    });
  });
  test("no-auth and shared are reached as the deployment", () => {
    expect(accessFor(row({ authScheme: "NO_AUTH" }), null).reachedAs).toBe("deployment");
    expect(accessFor(row({ authScheme: "API_KEY", accountMode: "shared" }), null).reachedAs).toBe("deployment");
  });
  test("custom_credential is one person's account", () => {
    expect(accessFor(row({ authScheme: "CUSTOM_CREDENTIAL" }), null).reachedAs).toBe("person");
  });
  test("a curated entry and an open-connector provenance refuse in both directions", () => {
    const entry = CATALOGUE.find((candidate) => candidate.key === "notion") ?? null;
    expect(() => accessFor(row({ url: "openconnector://notion" }), entry)).toThrow(ServerRowAmbiguousError);
  });
  test("an entry declaring a broker transport is unroutable for either broker", () => {
    expect(() =>
      accessFor({ provenance: "first-party", url: "https://example.test", authScheme: null }, {
        ...CATALOGUE[0], transport: "open-connector" as never,
      }),
    ).toThrow(CatalogueTransportUnroutableError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test server/tests/openconnector-access.test.ts` — Expected: FAIL.

- [ ] **Step 3: Generalize `access.ts`**

Replace `isBrokerTransport` and the composio branch of `accessFor` (lines ~197-199 and ~237-294). Registry:

```ts
import { toolkitOf as composioToolkitOf } from "./composio";
import { toolkitOf as openConnectorToolkitOf } from "./openconnector";
import type { BrokeredProvenance } from "../../../shared/src/brokered-provenance";

/**
 * Every broker this deployment can dial, keyed by the provenance value that names it on a row.
 *
 * A REGISTRY RATHER THAN A COMPARISON because there are now two brokers and the questions that used
 * to be spelled `=== "composio"` — is this kind a broker's, which app does this row's url name —
 * have one answer per broker. Adding a third broker is a row here plus a TransportKind, and the
 * compiler finishes the job: `BROKERS[row.provenance]` is the only spelling of "which broker".
 */
const BROKERS: Record<
  BrokeredProvenance,
  { transport: TransportKind; toolkitOf: (url: string) => string | null }
> = {
  composio: { transport: "composio", toolkitOf: composioToolkitOf },
  "open-connector": { transport: "open-connector", toolkitOf: openConnectorToolkitOf },
};

function isBrokerTransport(kind: TransportKind): boolean {
  return Object.values(BROKERS).some((broker) => broker.transport === kind);
}
```

In `accessFor`: change the ambiguity check to `if (entry && isBrokeredProvenance(row.provenance))` with the message naming `row.provenance` instead of the literal `composio`; change the brokered branch to:

```ts
const broker = isBrokeredProvenance(row.provenance) ? BROKERS[row.provenance] : null;
if (broker) {
  return {
    transport: broker.transport,
    credential: "brokered",
    reachedAs:
      schemeKind(row.authScheme) === "none" || row.accountMode === "shared"
        ? "deployment"
        : "person",
    toolkit: broker.toolkitOf(row.url),
    broker: row.provenance as BrokeredProvenance,
  };
}
```

Add `broker: BrokeredProvenance | null` to `ServerAccess` (docblock: *Which broker a brokered row was enabled through; null on every other answer. The store reads it to pick the connection table's provider and the right broker client, so a third broker needs no new predicate anywhere.*) and set `broker: null` on the entry branch and the MCP fallback. Import `isBrokeredProvenance` from shared (server imports shared via relative path — copy the specifier from another server file that imports shared, e.g. `grep -rn "shared/src" server/src | head -3`).

Update `CatalogueTransportUnroutableError`'s thrown sentence to say "a broker transport" instead of "the composio transport".

- [ ] **Step 4: Run all access tests + typecheck**

Run: `bun test server/tests/openconnector-access.test.ts server/tests/composio-access.test.ts && bun run --filter server typecheck`
Expected: PASS (fix composio-access assertions that pin the old sentence verbatim by updating them to the new sentence — they are this file's contract, so change them consciously).

- [ ] **Step 5: Commit**

```bash
git add server/src/plugins/access.ts server/tests/openconnector-access.test.ts server/tests/composio-access.test.ts
git commit -m "feat(plugins): provenance-keyed broker registry in access resolution"
```

---

### Task 8: Store generalization — provider predicates, enable path, alias passthrough

**Files:**
- Modify: `server/src/plugins/store.ts` (anchors below)
- Modify: `server/tests/plugin-store.integration.test.ts` (new end-to-end case)

**Interfaces:**
- Consumes: `ServerAccess.broker` (Task 7), `isBrokeredProvenance` (Task 3), `personalAlias`/`deploymentAlias`/`isAlias` (Task 4), store deps gaining `openConnector?: { broker: ConnectedAppBroker }` (Task 6 wired it).
- Produces: `addBrokeredApp` accepting `provider: BrokeredProvenance`; brokered lookups keyed by `access.broker`; `callTool` passing `accountHandle` to the transport; `open-connector-` name reservations.

- [ ] **Step 1: Read the five regions before editing**

`store.ts` is large; read each anchor region before touching it: `:1425-1520` (`toolkit` derivation + `brokeredAppRow`/`accountRow` predicates), `:1580-1700` (`connectionTokenFor` brokered branch), `:2613` (toolkit derivation in the refresh path), `:2907-2950` (name reservations in `addCustomServer`), `:3120-3370` (`addBrokeredApp`).

- [ ] **Step 2: Write the failing integration test**

In `server/tests/plugin-store.integration.test.ts`, copy the existing composio brokered end-to-end case (find it by `grep -n "brokered" server/tests/plugin-store.integration.test.ts | head`), and write its OpenConnector twin with an object-literal `openConnector` deps stub:

```ts
// The OpenConnector twin: same gates, provider 'open-connector', the alias as the account handle.
const openConnectorStub = {
  broker: {
    listApps: async () => [{ slug: "github", name: "GitHub", description: "", logo: null, categories: [], actionCount: 1, connection: { kind: "fields", authScheme: "API_KEY" } }],
    ensureAuthConfig: async () => "not-needed" as const,
    deleteAuthConfig: async () => {},
    authorize: async () => { throw new Error("unreachable"); },
    isConnected: async () => true,
    revoke: async () => true,
    revokeAccount: async () => {},
    connectionFields: async () => [{ name: "apiKey", label: "API key", help: "", required: true, secret: true }],
    connectWithFields: async () => ({ accountId: "openbot-u-<user>-github" }),
    accountName: async () => null,
  },
};
```

Assert, in order: enabling (`addBrokeredApp({ provider: "open-connector", slug: "github", ... })`) writes a row `id: "open-connector-github"`, `url: "openconnector://github"`, `provenance: "open-connector"`, `authScheme: "API_KEY"`, and its actions record `effect: "write"` with `destructive: false` (unlabelled is a write — the fail-closed default, asserted so a future label pass cannot silently flip it); a `connectBrokeredWithFields` writes a `brokered_connections` row `provider: "open-connector"` whose `vendorUserId` is the minted alias and whose listing answer carries `checkable: false`; a granted tool call without a connection is refused; with the connection it dials the stubbed transport and audits `mcp.call_succeeded`; a custom server may not take an id beginning `open-connector-`.

- [ ] **Step 3: Run to verify failure**

Run: `bun test server/tests/plugin-store.integration.test.ts` — Expected: the new case FAILs.

- [ ] **Step 4: Generalize the store**

Edits, in file order (keep each region's docblocks; where a docblock argues `composio` specifically, extend the sentence rather than replacing it):

1. **Toolkit derivation** (`:1439` and `:2613`):
```ts
// before
const toolkit = dialled.provenance === "composio" ? toolkitOf(dialled.url) : null;
// after — dispatch through access.ts's registry so a third broker needs no edit here
const toolkit = brokerToolkitOf(dialled.provenance, dialled.url);
```
Add to `access.ts` (exported, Task 7's registry made this one line):
```ts
/** The app a brokered row names, for whichever broker its provenance names; null for every other row. */
export function brokerToolkitOf(provenance: string, url: string): string | null {
  return isBrokeredProvenance(provenance) ? BROKERS[provenance].toolkitOf(url) : null;
}
```
(the `toolkitOf` import in store.ts may then be unused — remove it if so).

2. **Connection-row predicates** (`:1497`, `:1503`): `eq(brokeredConnections.provider, "composio")` → `eq(brokeredConnections.provider, access.broker ?? "composio")` — but read the surrounding function first: these predicates run where an `access` is in scope; if it is not, thread the broker name down from `requireServer`'s `access.broker`. **The `access.broker` is the only admissible source** — a literal would gate an OpenConnector call against Composio's connections.

3. **`addBrokeredApp`** (`:3120-3370`): add `provider: BrokeredProvenance` to the input type and compose row facts from one map at the top of the function:
```ts
const BROKER_ROW: Record<BrokeredProvenance, { idPrefix: string; urlScheme: string; screenName: string }> = {
  composio: { idPrefix: "composio-", urlScheme: "composio://", screenName: "composio" },
  "open-connector": { idPrefix: "open-connector-", urlScheme: "openconnector://", screenName: "open-connector" },
};
```
Replace `const url = `composio://${toolkit}`` (`:2678` belongs to another function — check; the enable-path composition is at `:3164`), `id: `composio-${input.slug}`` (`:3228`), and `provenance: "composio"` (`:3235`, `:3309`) with the map's values for `input.provider`. The `ensureAuthConfig` call must go to the matching broker's client: where the function reads `this.deps.composio.broker` (or equivalent), resolve `const broker = input.provider === "open-connector" ? this.deps.openConnector?.broker : this.deps.composio?.broker` and refuse with the existing unconfigured refusal when absent.

4. **Name reservations** (`:2913`, `:2943`): the two refusals guarding the `composio` screen name and the `composio-` prefix gain exact twins for `open-connector` / `open-connector-` (same sentences with the names swapped).

5. **Call path alias** (`connectionTokenFor` → `callTool` step 10, ~`:7466` region): where the transport is dialled with `{url, token, actorId, botId}`, add `accountHandle: connection.vendorUserId` (the value the brokered branch already resolves — for OpenConnector rows it is the alias minted at connect; for composio rows it is the vendor user id, which the composio transport ignores).

6. **Connect paths**: `connectBrokeredWithFields` computes the account to connect — where composio's flow derives the vendor user id, the OpenConnector path mints it: `personalAlias(userId, slug)` for personal, `deploymentAlias(deploymentId, slug)` for shared. Find where `mintDeploymentVendorUserId` is used for composio's shared accounts and mint the OpenConnector alias beside it, keyed on the row's `access.broker`. The typed value written to `brokered_connections.vendorUserId` is the alias. On `confirm`/`disconnect`/offboarding (`revokeEach`/`revoke at vendor`), the broker client dispatched must follow the same `access.broker` rule as (3).

7. **Connections read answers `checkable: false` for OpenConnector rows.** The `GET /connections` listing computes `checkable`/`probe` per row for Composio by asking whether the app publishes a safe, argument-less, read-only action. OpenConnector publishes no safety labels, so that question has no honest yes: find the connections-read that derives those two fields (grep `checkable` in store.ts) and make the derivation answer `{ checkable: false, probe: null }` for `provider = 'open-connector'` rows — the Re-check button is then withheld exactly as Composio withholds it for an app with nothing safe to spend a key on, and the row honestly reads *accepted without being checked*. The `POST /servers/:id/connection/recheck` route, reached anyway, must refuse with that same sentence rather than dial a probe.

- [ ] **Step 5: Run the store suites**

Run: `bun test server/tests/plugin-store.integration.test.ts server/tests/composio-connections.test.ts server/tests/composio-broker-seam.test.ts && bun run --filter server typecheck`
Expected: PASS / clean. If `grep -n "composio" server/src/plugins/store.ts` still shows a *predicate* (an `===`/`eq()` comparing provenance/provider) after this task, that is a defect — the only composio literals left in store.ts should be the reservation sentences, the BROKER_ROW map, and docblocks.

- [ ] **Step 6: Commit**

```bash
git add server/src/plugins/store.ts server/src/plugins/access.ts server/tests/plugin-store.integration.test.ts
git commit -m "feat(plugins): provider-general brokered gate, enable path, and alias account handle"
```

---

### Task 9: Routes — `/openconnector/apps` directory, configured flag, connect dispatch

**Files:**
- Modify: `server/src/plugins/routes.ts` (`:204` deps, `:279` flags, `:744-870` directory handlers, `:1188-1333` connect dispatch)

**Interfaces:**
- Consumes: store's generalized `addBrokeredApp` (Task 8), `BrokerUnconfiguredError` (broker.ts).
- Produces (Task 10 consumes): `GET /api/plugins/openconnector/apps?q=` → `{ apps: BrokerApp[] }` (unsupported filtered, same as composio); `POST /api/plugins/openconnector/apps` `{ slug }` → enable; `GET /api/plugins` gains `openConnectorConfigured: boolean` (existing `composioConfigured` unchanged).

- [ ] **Step 1: Add the deps field and flag**

At `routes.ts:204` beside `composio?: { broker: ComposioBroker }` add `openConnector?: { broker: ConnectedAppBroker }` (import the type from `./broker`). At `:279` beside `composioConfigured: Boolean(composio)` add `openConnectorConfigured: Boolean(openConnector)`.

- [ ] **Step 2: Add the directory routes**

Duplicate the `GET /composio/apps` (line 744) and `POST /composio/apps` (line 836) handlers as `/openconnector/apps`, with three differences only: the guard reads `openConnector`, the unconfigured error is `new BrokerUnconfiguredError("OpenConnector")` (its constructor already takes a provider name — verify the sentence reads correctly, else pass a full custom `BrokerRefusalError` naming `OPENCONNECTOR_ADMIN_TOKEN` and `OPENCONNECTOR_RUNTIME_TOKEN`), and the POST's enable call passes `provider: "open-connector"`. The POST's slug validation argument (the docblock at `:826` about `addBrokeredApp` composing the url) now names `openconnector://<slug>`; keep the identical strictness (`/^[A-Za-z0-9_-]+$/`, slug must come from the directory's own answer).

- [ ] **Step 3: Generalize the connect dispatch**

In the `POST /servers/:id/connect` handler region (`:1188-1333`), every `composio` guard/lookup dispatches on the row's broker now: resolve `const brokerClient = access.broker === "open-connector" ? openConnector : composio` once beside the existing `if (!composio)` check (which becomes `if (brokerless(access))` — a helper or an inline check that the row's broker has a client, answering the same 503 with the same `BrokerUnconfiguredError` shape). The `connectionFields` call at `:1333` and every `composio.broker.*` call in the handler go through `brokerClient`. Read the whole handler before editing; its docblocks argue composio's shapes but its logic is broker-generic by design (`ConnectedAppBroker`).

- [ ] **Step 4: Verify + commit**

Run: `bun run --filter server typecheck && bun test server/tests && bun run --filter app typecheck`
Expected: clean / PASS.

```bash
git add server/src/plugins/routes.ts
git commit -m "feat(plugins): OpenConnector app directory routes and broker-generic connect dispatch"
```

---

### Task 10: Frontend data layer + i18n keys

**Files:**
- Modify: `app/src/lib/plugins/queries.ts` (`:179-215` type + keys, `:374-390` query options)
- Modify: `app/src/lib/plugins/mutations.ts` (`:251-265` enable mutation)
- Modify: `app/src/locales/en/admin.json` and `app/src/locales/zh-CN/admin.json` (`plugins.moreApps`)

**Interfaces:**
- Consumes: Task 9's routes.
- Produces (Task 11 consumes): `PluginsPage.openConnectorConfigured: boolean`; `openConnectorApps` query key; `openConnectorAppsQueryOptions(query)` → `{ apps: ComposioApp[] }`-shaped; `enableOpenConnectorAppMutationOptions(queryClient)`.

- [ ] **Step 1: queries.ts**

Beside `composioConfigured: boolean` (~`:185`) add `openConnectorConfigured: boolean;`. Beside `composioApps` (~`:209`) add:

```ts
openConnectorApps: (query: string) => ["plugins", "open-connector", "apps", query] as const,
```

Beside `composioAppsQueryOptions` (~`:379`) add its twin hitting `/api/plugins/openconnector/apps?q=${encodeURIComponent(query)}` and returning `{ apps: ComposioApp[] }` — the listing shape is the same `BrokerApp` wire shape; keep the `ComposioApp` type name for now and note in a one-line comment that the type is the broker directory shape, not Composio's alone.

- [ ] **Step 2: mutations.ts**

Beside `enableComposioAppMutationOptions` (~`:256`) add its twin POSTing `{ slug }` to `/api/plugins/openconnector/apps`, invalidating `["plugins"]`.

- [ ] **Step 3: i18n keys**

In both locale files under `plugins.moreApps` add:

```json
"openConnector": "OpenConnector",
"openConnectorDescription": "Run the open-connector container to enable a self-hosted catalogue of apps. Set OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN on this deployment.",
"openConnectorBrowse": "Browse OpenConnector",
"openConnectorBrowseDescription": "Apps reached through this deployment's own OpenConnector container. Each person connects their own account; credentials stay in this deployment."
```

(Chinese: mirror the composio entry's tone; 描述要点名两个环境变量。) If the composio directory page reads other keys (`plugins.*`), add their OpenConnector twins in the same pass — find them with `grep -n "t(\"plugins\." app/src/routes/_authed/admin/plugins/composio.tsx`.

- [ ] **Step 4: Verify + commit**

Run: `bun run --filter app typecheck && bun test app/tests`
Expected: clean / PASS.

```bash
git add app/src/lib/plugins/queries.ts app/src/lib/plugins/mutations.ts app/src/locales/en/admin.json app/src/locales/zh-CN/admin.json
git commit -m "feat(app): OpenConnector directory queries, enable mutation, and copy"
```

---

### Task 11: Admin UI — More-apps row, directory page — and connected-accounts generalization

**Files:**
- Modify: `app/src/routes/_authed/admin/plugins/index.tsx` (`:253-287` More-apps block)
- Create: `app/src/routes/_authed/admin/plugins/open-connector.tsx`
- Modify: `app/src/routes/_authed/settings/connected-accounts/index.tsx` (`:80`, `:92`) and `$key.tsx` (`:43-49`, `:119`)

**Interfaces:**
- Consumes: Task 10's queries/mutations, `isBrokeredProvenance` shim (Task 3).

- [ ] **Step 1: Duplicate the More-apps block**

In `admin/plugins/index.tsx`, the block at `:253-287` renders one linked row when `composioConfigured` and one inert row otherwise. Duplicate it directly beneath, swapping: testid `plugin-open-connector`, link `/admin/plugins/open-connector`, configured flag `openConnectorConfigured`, keys `plugins.moreApps.openConnector*`. Order: Composio first, OpenConnector second.

- [ ] **Step 2: Create the directory page**

Copy `app/src/routes/_authed/admin/plugins/composio.tsx` to `open-connector.tsx` and change only: the query options to `openConnectorAppsQueryOptions`, the enable mutation to `enableOpenConnectorAppMutationOptions`, the copy keys to the `openConnector*` twins, the page testids to `open-connector-*`, and the route-level file docs. The picker's existing behaviour — search, action counts shown before Add, `unsupported` apps absent — carries over unchanged because the wire shape is identical. Add a page test `app/tests/open-connector-picker.test.tsx` by copying `app/tests/composio-picker.test.tsx` and swapping the query stubs/testids (that test is the template; keep its "unsupported apps are not offered" case — for OpenConnector, oauth2 providers arrive as `unsupported`).

- [ ] **Step 3: Generalize connected-accounts**

`index.tsx:80` and `:92`: `server.provenance === "composio"` → `isBrokeredProvenance(server.provenance)` (import from `@/lib/brokered-provenance`). `$key.tsx:49`: same change; update the comment at `:43` ("A Shared app is also a brokered row — the broker that holds the account is whichever the row names"). `$key.tsx:119`: `configured: plugins.data?.composioConfigured ?? false` — this drives a key-form state; make it `configured: isBrokeredProvenance(server?.provenance ?? "") ? (server?.provenance === "open-connector" ? plugins.data?.openConnectorConfigured : plugins.data?.composioConfigured) ?? false : true` or, cleaner, a small `brokerConfigured(server, plugins.data)` helper in the same file doing exactly that mapping with a two-case comment. `brokered-account-row` and `connection-fields` need no changes (they speak `BrokerField`/connection shapes, not provenance) — verify by running their tests.

- [ ] **Step 4: Verify + commit**

Run: `bun run --filter app typecheck && bun test app/tests`
Expected: clean / PASS (including the copied picker test).

```bash
git add app/src/routes/_authed/admin/plugins/index.tsx app/src/routes/_authed/admin/plugins/open-connector.tsx app/src/routes/_authed/settings/connected-accounts/ app/tests/open-connector-picker.test.tsx
git commit -m "feat(app): OpenConnector directory page and broker-generic connected accounts"
```

---

### Task 12: Compose service, docs, full gate

**Files:**
- Modify: `docker-compose.yml` (new service + volume)
- Create: `docs/plugins/open-connector.md`
- Modify: `docs/plugins/composio.md` is NOT touched (it documents Composio only).

**Interfaces:** None (deployment + docs).

- [ ] **Step 1: Add the compose service**

After the `agent-langgraph` service (before the `networks:` block at `:394`), matching the file's existing env-with-defaults style:

```yaml
  open-connector:
    image: ghcr.io/oomol-lab/open-connector:latest   # pin to a digest when cutting a release
    restart: unless-stopped
    environment:
      OOMOL_CONNECT_ADMIN_TOKEN: ${OPENCONNECTOR_ADMIN_TOKEN:-}
      OOMOL_CONNECT_RUNTIME_TOKEN: ${OPENCONNECTOR_RUNTIME_TOKEN:-}
      OOMOL_CONNECT_ENCRYPTION_KEY: ${OPENCONNECTOR_ENCRYPTION_KEY:-}
    volumes:
      - open-connector-data:/app/data
    ports:
      - "127.0.0.1:3100:3000"

volumes:
  # ...existing volumes...
  open-connector-data:
```

Bind `127.0.0.1` so the broker is reachable from the host-run server (`http://localhost:3100`) and from nothing else. Add the three variables to `.env.example` if the repo has one (`ls .env.example`).

- [ ] **Step 2: Write the docs page**

`docs/plugins/open-connector.md` — follow `composio.md`'s section shape at a third of the length: what the broker is (self-hosted container; credentials stay in this deployment's volume, AES-256-GCM when `OOMOL_CONNECT_ENCRYPTION_KEY` is set); the setup table (deployer sets the three env vars + starts the service; administrator enables an app at `/admin/plugins/open-connector`; each person connects at `/settings/connected-accounts`); what phase 1 offers (key and no-auth apps; OAuth consent apps are not offered, and why — the client-registration non-goal, pointing at composio.md's section); key connections are accepted without being checked (no safety labels to probe with — the row says so); disconnect semantics (the key still works at the vendor — rotate it there); blast radius (one container inside this deployment, its volume and encryption key are the deployment's to protect — contrast with composio.md's cloud sentence).

- [ ] **Step 3: Full gate**

Run: `bun run typecheck && bun test && bun run lint`
Expected: all clean. Then `grep -rn "provenance === \"composio\"" app/src server/src` — the only remaining hits must be comments; any live comparison is a missed generalization: fix it before committing.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docs/plugins/open-connector.md
git commit -m "feat(deploy): OpenConnector compose service and connector docs"
```

---

## Verification against the spec (executor's final checklist)

- [ ] Unset tokens: `bun test` passes with no OpenConnector env; `GET /api/plugins` answers `openConnectorConfigured: false`; admin page shows the inert row (Task 11's block renders the unconfigured branch).
- [ ] A key app end-to-end (integration test, Task 8): enable → connect with fields → alias in `vendor_user_id` → granted call gated → audited.
- [ ] A no-auth app end-to-end: connect refused (no account to make), call passes with no connection row, `reachedAs: "deployment"`.
- [ ] OAuth provider hidden from the picker (`unsupported`).
- [ ] No alias, token, or field value in any log/audit path — grep the new files for the stub secret strings after a test run.
- [ ] Composio suites still green, untouched behaviourally (`bun test server/tests/composio-*.test.ts`).
