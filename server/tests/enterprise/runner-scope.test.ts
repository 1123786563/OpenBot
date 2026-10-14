import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import type { Database } from "../../src/db/client";
import { intelligenceChannelMappings } from "../../src/db/schema/core";
import { enterpriseConversations } from "../../src/db/schema/enterprise-conversations";
import {
  enterpriseRunAttempts,
  enterpriseRunOutbox,
  enterpriseRuns,
} from "../../src/db/schema/enterprise-runs";
import {
  enterpriseMemberships,
  enterpriseResources,
} from "../../src/db/schema/enterprise-tenancy";
import { mastraMessageIntents } from "../../src/db/schema/mastra-message-intents";
import { createConversationRoutes } from "../../src/enterprise/conversations/routes";
import { createConversationService } from "../../src/enterprise/conversations/service";
import * as runStore from "../../src/enterprise/runs/store";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import * as tenancy from "../../src/enterprise/tenancy/store";
import {
  tenantStorageKey,
  tenantStorageRoleNames,
  tenantStorageSchemaName,
} from "../../src/mastra/contracts";
import { RegistryTenantStorageLookup } from "../../src/mastra/provisioning";
import { testEnvironment } from "../support/environment";

test("single_authorized_thread_match_resolves_scope_candidate", () => {
  expect(typeof tenancy.uniqueThreadMatch).toBe("function");
  const uniqueThreadMatch = tenancy.uniqueThreadMatch as <T>(
    rows: readonly T[],
  ) => T;
  const match = { tenantId: "tenant-a", workspaceId: "workspace-a" };

  expect(uniqueThreadMatch([match])).toBe(match);
});

test("thread_with_no_active_membership_match_is_denied", () => {
  expect(typeof tenancy.uniqueThreadMatch).toBe("function");
  const uniqueThreadMatch = tenancy.uniqueThreadMatch as <T>(
    rows: readonly T[],
  ) => T;

  expect(() => uniqueThreadMatch([])).toThrow("THREAD_SCOPE_NOT_FOUND");
});

test("anonymous_actor_cannot_mint_scope", () => {
  expect(typeof tenancy.requireAuthenticatedIdentity).toBe("function");
  const requireAuthenticatedIdentity = tenancy.requireAuthenticatedIdentity as (
    identity: { actorId: string; entrypoint: "web" } | null,
  ) => { actorId: string; entrypoint: "web" };

  expect(() => requireAuthenticatedIdentity(null)).toThrow("AUTH_REQUIRED");
  expect(() =>
    requireAuthenticatedIdentity({ actorId: "", entrypoint: "web" }),
  ).toThrow("AUTH_REQUIRED");
});

test("duplicate_thread_match_is_denied", () => {
  expect(typeof tenancy.uniqueThreadMatch).toBe("function");
  const uniqueThreadMatch = tenancy.uniqueThreadMatch as <T>(
    rows: readonly T[],
  ) => T;

  expect(() => uniqueThreadMatch([{}, {}])).toThrow("THREAD_SCOPE_AMBIGUOUS");
});

test("runner_lease_renew_release_require_exact_owner_and_generation", () => {
  const isCurrent = (runStore as Record<string, unknown>)
    .isRunnerRequestLeaseCurrent as (
    current: {
      runId: string;
      attemptId: string;
      generation: number;
      ownerToken: string;
      expiresAt: Date;
    },
    expected: {
      runId: string;
      attemptId: string;
      generation: number;
      ownerToken: string;
    },
    now: Date,
  ) => boolean;
  expect(typeof isCurrent).toBe("function");
  const lease = {
    runId: "run-a",
    attemptId: "attempt-a",
    generation: 2,
    ownerToken: "owner-a",
    expiresAt: new Date(10_000),
  };
  expect(isCurrent(lease, lease, new Date(9_000))).toBe(true);
  expect(
    isCurrent(lease, { ...lease, ownerToken: "owner-b" }, new Date(9_000)),
  ).toBe(false);
  expect(isCurrent(lease, { ...lease, generation: 1 }, new Date(9_000))).toBe(
    false,
  );
  expect(isCurrent(lease, lease, new Date(10_000))).toBe(false);
});

test("tenant_suspension_between_candidate_and_thread_lookup_is_denied", async () => {
  let tenantStatus = "active";
  const directory = await verifyDirectoryDatabase(
    controlledDatabase(
      () => [
        {
          tenantId: "tenant-a",
          principalId: "principal-a",
          memberEpoch: 3,
        },
      ],
      () => {},
    ),
  );
  const data = await verifyDataDatabase(
    controlledDatabase(
      () =>
        tenantStatus === "active"
          ? [
              {
                tenantId: "tenant-a",
                workspaceId: "workspace-a",
                principalId: "principal-a",
                tenantStatus,
              },
            ]
          : [
              {
                tenantId: "tenant-a",
                workspaceId: "workspace-a",
                principalId: "principal-a",
                tenantStatus,
              },
            ],
      () => {
        tenantStatus = "suspended";
      },
    ),
  );
  const resolver = tenancy.createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    data,
  });

  await expect(
    resolver.resolveForThread(
      new Request("https://example.invalid"),
      "thread-a",
    ),
  ).rejects.toThrow("THREAD_SCOPE_NOT_FOUND");
});

test("authenticated_thread_resolves_scope_only_after_membership", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );

  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  expect(scope).toMatchObject({
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    actorId: "actor-a",
    memberEpoch: 3,
  });
  expect(() => tenancy.assertTrustedScope(scope)).not.toThrow();
});

test("authorized_legacy_mapping_resolves_persisted_channel_scope", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [],
    { actorId: "actor-a", entrypoint: "web" },
    [authorizedLegacyMatch()],
  );

  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid/?tenant=attacker&workspace=attacker"),
    "legacy-thread",
  );

  expect(scope).toMatchObject({
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    actorId: "actor-a",
  });
  expect(() => tenancy.assertTrustedScope(scope)).not.toThrow();
});

test("legacy_scope_denies_foreign_or_stale_mapping_authorization", async () => {
  const invalidMatches = [
    { ...authorizedLegacyMatch(), actorId: "actor-other" },
    { ...authorizedLegacyMatch(), memberId: null },
    { ...authorizedLegacyMatch(), grantPrincipalId: "principal-other" },
    { ...authorizedLegacyMatch(), grantAction: null },
    { ...authorizedLegacyMatch(), channelDeletedAt: new Date(0) },
    { ...authorizedLegacyMatch(), resourceStatus: "deleted" },
  ];
  for (const invalid of invalidMatches) {
    const resolver = await makeResolver(
      [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
      [],
      { actorId: "actor-a", entrypoint: "web" },
      [invalid],
    );
    await expect(
      resolver.resolveForThread(
        new Request(
          "https://example.invalid/?tenant=tenant-a&workspace=workspace-a",
        ),
        "legacy-thread",
      ),
    ).rejects.toThrow("THREAD_SCOPE_NOT_FOUND");
  }
});

test("legacy_scope_rejects_no_match_and_ambiguous_cross_backend_match", async () => {
  const candidates = [
    { tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 },
  ];
  const none = await makeResolver(candidates, [], undefined, []);
  await expect(
    none.resolveForThread(
      new Request("https://example.invalid"),
      "legacy-thread",
    ),
  ).rejects.toThrow("THREAD_SCOPE_NOT_FOUND");

  const noMembership = await makeResolver([], [], undefined, [
    authorizedLegacyMatch(),
  ]);
  await expect(
    noMembership.resolveForThread(
      new Request("https://example.invalid"),
      "legacy-thread",
    ),
  ).rejects.toThrow("THREAD_SCOPE_NOT_FOUND");

  const ambiguous = await makeResolver(
    candidates,
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
    undefined,
    [authorizedLegacyMatch()],
  );
  await expect(
    ambiguous.resolveForThread(
      new Request("https://example.invalid"),
      "legacy-thread",
    ),
  ).rejects.toThrow("THREAD_SCOPE_AMBIGUOUS");
});

test("thread_resolution_requires_verified_data_capability", async () => {
  const directory = await verifyDirectoryDatabase(
    controlledDatabase(
      () => [],
      () => {},
    ),
  );
  const resolver = tenancy.createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
  });

  await expect(
    resolver.resolveForThread(
      new Request("https://example.invalid"),
      "legacy-thread",
    ),
  ).rejects.toThrow("DATA_DATABASE_UNAVAILABLE");
});

test("thread_owned_by_other_principal_is_denied", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [],
  );

  await expect(
    resolver.resolveForThread(
      new Request("https://example.invalid"),
      "foreign-thread",
    ),
  ).rejects.toThrow("THREAD_SCOPE_NOT_FOUND");
});

test("duplicate_thread_match_is_denied_by_resolver", async () => {
  const match = {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    tenantStatus: "active",
  };
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [match, match],
  );

  await expect(
    resolver.resolveForThread(
      new Request("https://example.invalid"),
      "thread-a",
    ),
  ).rejects.toThrow("THREAD_SCOPE_AMBIGUOUS");
});

test("anonymous_actor_cannot_mint_resolver_scope", async () => {
  const resolver = await makeResolver([], [], null);

  await expect(
    resolver.resolveForThread(
      new Request("https://example.invalid"),
      "thread-a",
    ),
  ).rejects.toThrow("AUTH_REQUIRED");
});

test("server_creates_bound_thread_without_client_storage_ids", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    list: async () => [],
    getOrCreate: async (_scope: unknown, input: Record<string, unknown>) => {
      received = input;
      return {
        conversation_id: "conversation-server",
        thread_id: "thread-server",
        title: input.title ?? null,
        storage_backend: "mastra",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        last_message_seq: 0,
      };
    },
  };
  const scopes = { resolve: async () => ({}) };
  const routes = createConversationRoutes(service as never, scopes as never);

  const response = await routes.request("http://example.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "client-thread", title: "New chat" }),
  });

  expect(response.status).toBe(400);
  expect(received).toBeUndefined();
});

test("server_conversation_create_accepts_only_optional_title", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    list: async () => [],
    getOrCreate: async (_scope: unknown, input: Record<string, unknown>) => {
      received = input;
      return { thread_id: "server-thread" };
    },
  };
  const routes = createConversationRoutes(
    service as never,
    { resolve: async () => ({}) } as never,
  );

  const titleResponse = await routes.request("http://example.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "New chat" }),
  });
  expect(titleResponse.status).toBe(201);
  expect(received).toEqual({ title: "New chat" });

  for (const extra of [
    { mastraThreadId: "client-thread" },
    { resourceId: "client-resource" },
    { threadId: "client-thread" },
    { unknown: true },
  ]) {
    const response = await routes.request("http://example.invalid/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...extra, title: "New chat" }),
    });
    expect(response.status).toBe(400);
  }
});

test("conversation_message_routes_resolve_scope_from_the_persisted_thread", async () => {
  const resolutions: Array<{ threadId: string; request: Request }> = [];
  const routes = createConversationRoutes(
    {
      list: async () => [],
      getOrCreate: async () => ({ thread_id: "thread-server" }),
      history: async () => ({ items: [] }),
      append: async () => ({ messageId: "message-server" }),
    } as never,
    {
      resolve: async () => {
        throw new Error("SELECTOR_SCOPE_MUST_NOT_AUTHORIZE_EXISTING_THREAD");
      },
      resolveForThread: async (request: Request, threadId: string) => {
        resolutions.push({ request, threadId });
        return {};
      },
    } as never,
  );

  const history = await routes.request(
    "http://example.invalid/thread-server/messages",
  );
  const append = await routes.request(
    "http://example.invalid/thread-server/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMessageKey: "message-key",
        content: "hello",
        attachments: [],
      }),
    },
  );

  expect(history.status).toBe(200);
  expect(append.status).toBe(201);
  expect(resolutions.map(({ threadId }) => threadId)).toEqual([
    "thread-server",
    "thread-server",
  ]);
});

test("mounted_legacy_list_thread_opens_history_with_resolved_scope", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [],
    { actorId: "actor-a", entrypoint: "web" },
    [authorizedLegacyMatch()],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "legacy-thread",
  );
  let historyScope: unknown;
  const routes = createConversationRoutes(
    {
      list: async () => [
        { thread_id: "legacy-thread", storage_backend: "intelligence" },
      ],
      getOrCreate: async () => ({ thread_id: "legacy-thread" }),
      history: async (receivedScope: unknown) => {
        historyScope = receivedScope;
        return { items: [] };
      },
      append: async () => {
        throw new Error("LEGACY_HISTORY_READ_ONLY");
      },
    } as never,
    {
      resolve: async () => scope,
      resolveForThread: resolver.resolveForThread,
    } as never,
  );
  const args: Parameters<typeof createApp> = [
    { ...loadConfig(testEnvironment()), appDistDir: "/nonexistent" },
  ];
  args[34] = { enterpriseConversations: routes } as never;
  const app = createApp(...args);

  const listed = await app.request("/api/enterprise/conversations");
  const history = await app.request(
    "/api/enterprise/conversations/legacy-thread/messages",
  );
  const append = await app.request(
    "/api/enterprise/conversations/legacy-thread/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMessageKey: "legacy-key",
        content: "hello",
        attachments: [],
      }),
    },
  );

  expect(listed.status).toBe(200);
  expect(history.status).toBe(200);
  expect(historyScope).toMatchObject(scope);
  expect(append.status).toBe(409);
  expect(await append.json()).toMatchObject({ error: { code: "read_only" } });
});

test("legacy_append_remains_read_only_after_current_authorization", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [],
    { actorId: "actor-a", entrypoint: "web" },
    [authorizedLegacyMatch()],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "legacy-thread",
  );
  let writes = 0;
  const service = createConversationService({
    data: await verifyDataDatabase(legacyAppendDatabase(() => writes++)),
  });

  await expect(
    service.append(scope, {
      threadId: "legacy-thread",
      clientMessageKey: "legacy-key",
      content: "hello",
      attachments: [],
    }),
  ).rejects.toThrow("LEGACY_HISTORY_READ_ONLY");
  expect(writes).toBe(0);
});

test("thread_scope_and_data_capability_errors_have_safe_statuses", async () => {
  for (const [failure, expectedStatus] of [
    ["THREAD_SCOPE_NOT_FOUND", 404],
    ["THREAD_SCOPE_AMBIGUOUS", 404],
    ["DATA_DATABASE_UNAVAILABLE", 503],
  ] as const) {
    const routes = createConversationRoutes(
      {
        list: async () => [],
        getOrCreate: async () => ({ thread_id: "thread-a" }),
        history: async () => ({ items: [] }),
        append: async () => ({ messageId: "unused" }),
      } as never,
      {
        resolve: async () => {
          throw new Error("SELECTOR_SCOPE_MUST_NOT_AUTHORIZE_EXISTING_THREAD");
        },
        resolveForThread: async () => {
          throw new Error(failure);
        },
      } as never,
    );
    const response = await routes.request(
      "http://example.invalid/thread-a/messages",
    );
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toMatchObject({
      error: {
        code: expectedStatus === 404 ? "not_found" : "unavailable",
        message:
          expectedStatus === 404
            ? "Conversation not found."
            : "Conversation storage unavailable.",
      },
    });
  }
});

test("mounted_conversation_routes_allow_signed_in_and_deny_unsigned_users", async () => {
  const service = {
    list: async () => [],
    getOrCreate: async () => ({ thread_id: "server-thread" }),
  };
  const routes = createConversationRoutes(
    service as never,
    {
      resolve: async (request: Request) => {
        if (request.headers.get("authorization") !== "Bearer session") {
          throw new Error("AUTH_REQUIRED");
        }
        return {};
      },
    } as never,
  );
  const args: Parameters<typeof createApp> = [
    { ...loadConfig(testEnvironment()), appDistDir: "/nonexistent" },
  ];
  args[34] = { enterpriseConversations: routes } as never;
  const app = createApp(...args);

  const signedIn = await app.request("/api/enterprise/conversations", {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "New chat" }),
  });
  const unsigned = await app.request("/api/enterprise/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "New chat" }),
  });

  expect(signedIn.status).toBe(201);
  expect(unsigned.status).toBe(401);
});

test("mounted_conversation_get_precedes_spa_fallback", async () => {
  const routes = createConversationRoutes(
    {
      list: async () => [{ thread_id: "thread-a" }],
      getOrCreate: async () => ({ thread_id: "thread-a" }),
    } as never,
    { resolve: async () => ({}) } as never,
  );
  const args: Parameters<typeof createApp> = [
    { ...loadConfig(testEnvironment()), appDistDir: "/nonexistent" },
  ];
  args[34] = { enterpriseConversations: routes } as never;
  const app = createApp(...args);

  const response = await app.request("/api/enterprise/conversations");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual([{ thread_id: "thread-a" }]);
});

test("mastra_storage_unavailable_returns_safe_503", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  const service = createConversationService({
    data: await verifyDataDatabase(conversationDatabase()),
  });
  const routes = createConversationRoutes(service, {
    resolve: async () => scope,
  } as never);
  const response = await routes.request("http://example.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "New chat" }),
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "unavailable" },
  });
});

test("tenant_storage_lookup_uses_registry_credentials_and_explicit_runtime", async () => {
  const tenantId = "tenant-a";
  const storageKey = tenantStorageKey(tenantId);
  const roleVersion = 1;
  const runtimeRole = tenantStorageRoleNames(storageKey, roleVersion).runtime;
  const credentialRef =
    "tenant-credential:123e4567-e89b-12d3-a456-426614174000";
  const lookup = new RegistryTenantStorageLookup({
    registry: {
      get: async (requestedTenantId: string) =>
        requestedTenantId === tenantId
          ? {
              receipt: {
                tenantId,
                storageKey,
                roleVersion,
                schemaName: tenantStorageSchemaName(storageKey, roleVersion),
                credentialRef,
              },
              runtimeRole,
            }
          : undefined,
    } as never,
    credentials: {
      get: async (requestedRef: string) =>
        requestedRef === credentialRef ? "decrypted-tenant-secret" : undefined,
    } as never,
    runtimeConnectionString:
      "postgres://bootstrap:ignored@tenant-db.invalid:5432/runtime",
  });

  const location = await lookup.resolveTenantStorage(tenantId);
  const connection = new URL(location.connectionString);

  expect(connection.username).toBe(runtimeRole);
  expect(connection.password).toBe("decrypted-tenant-secret");
  expect(connection.hostname).toBe("tenant-db.invalid");
  expect(connection.searchParams.get("options")).toBe(`-c role=${runtimeRole}`);
});

test("mastra_conversation_creation_validates_tenant_storage_before_binding", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  const data = await verifyDataDatabase(conversationDatabase());
  const bindings: Record<string, unknown>[] = [];
  const storage = {
    getStore: async (_scope: unknown, binding: Record<string, unknown>) => {
      bindings.push(binding);
      return {};
    },
  };
  const service = createConversationService({
    data,
    mastraStorage: storage as never,
  });

  const conversation = await service.getOrCreate(scope, { title: "New chat" });

  expect(conversation.storage_backend).toBe("mastra");
  expect(conversation.thread_id).toBeString();
  expect(bindings).toHaveLength(1);
  expect(bindings[0]).toMatchObject({
    tenantId: "tenant-a",
    threadId: conversation.thread_id,
    backend: "mastra",
  });
});

test("mastra_run_requires_finalized_matching_message_intent", () => {
  expect(typeof runStore.validateMastraRunIntent).toBe("function");
  const validate = runStore.validateMastraRunIntent as (
    intent: Record<string, unknown> | undefined,
    expected: Record<string, unknown>,
  ) => void;
  const expected = {
    tenantId: "tenant-a",
    threadId: "thread-a",
    actorId: "actor-a",
    principalId: "principal-a",
    clientMessageKey: "message-a",
    digest: "digest-a",
    attachmentIds: ["attachment-a"],
    backendVersion: 2,
  };

  expect(() => validate(undefined, expected)).toThrow(
    "RUN_INPUT_NOT_FINALIZED",
  );
  expect(() =>
    validate(
      {
        ...expected,
        state: "pending",
      },
      expected,
    ),
  ).toThrow("RUN_INPUT_NOT_FINALIZED");
  expect(() =>
    validate(
      {
        ...expected,
        state: "finalized",
        actorId: "actor-other",
      },
      expected,
    ),
  ).toThrow("RUN_INPUT_NOT_FINALIZED");
  expect(() =>
    validate({ ...expected, state: "finalized" }, expected),
  ).not.toThrow();
});

test("transactional_mastra_admission_rejects_each_receipt_mismatch", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  const expectedIntent = {
    tenantId: "tenant-a",
    threadId: "thread-a",
    clientMessageKey: "message-a",
    digest: "digest-a",
    actorId: "actor-a",
    principalId: "principal-a",
    backendVersion: 2,
    attachmentIds: ["attachment-a"],
    state: "finalized",
  };
  for (const mismatch of [
    { tenantId: "tenant-b" },
    { threadId: "thread-b" },
    { clientMessageKey: "message-b" },
    { digest: "digest-b" },
    { actorId: "actor-b" },
    { principalId: "principal-b" },
    { backendVersion: 3 },
    { attachmentIds: ["attachment-b"] },
    { state: "pending" },
  ]) {
    let insertCalls = 0;
    const intent = { ...expectedIntent, ...mismatch };
    const tx = {
      execute: async () => [],
      select: () => {
        const query = Promise.resolve([] as Record<string, unknown>[]);
        let table: unknown;
        return Object.assign(query, {
          from(value: unknown) {
            table = value;
            return this;
          },
          where() {
            return this;
          },
          limit() {
            return Promise.resolve(
              table === enterpriseConversations
                ? [{ storageBackend: "mastra", backendVersion: 2 }]
                : table === mastraMessageIntents
                  ? [intent]
                  : [],
            );
          },
        });
      },
      insert: () => {
        insertCalls += 1;
        throw new Error("unexpected_insert");
      },
    };
    await expect(
      runStore.createRunInTransaction(
        tx as never,
        scope,
        {
          threadId: "thread-a",
          clientMessageKey: "message-a",
          messageDigest: "digest-a",
          attachmentRefs: ["attachment-a"],
          entrypoint: "web",
        },
        "expert-version",
        "model-route",
        128,
        30_000,
      ),
    ).rejects.toThrow("RUN_INPUT_NOT_FINALIZED");
    expect(insertCalls).toBe(0);
  }
});

test("finalized_intent_transaction_admission_writes_run_attempt_outbox", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    execute: async () => [],
    select: () => {
      let table: unknown;
      const query = Promise.resolve([] as Record<string, unknown>[]);
      return Object.assign(query, {
        from(value: unknown) {
          table = value;
          return this;
        },
        where() {
          return this;
        },
        limit() {
          if (table === enterpriseConversations)
            return Promise.resolve([
              { storageBackend: "mastra", backendVersion: 2 },
            ]);
          if (table === mastraMessageIntents)
            return Promise.resolve([
              {
                tenantId: "tenant-a",
                threadId: "thread-a",
                clientMessageKey: "message-a",
                digest: "digest-a",
                actorId: "actor-a",
                principalId: "principal-a",
                backendVersion: 2,
                attachmentIds: ["attachment-a"],
                state: "finalized",
              },
            ]);
          return Promise.resolve([]);
        },
      });
    },
    insert(table: unknown) {
      return {
        values: (values: Record<string, unknown>) => {
          writes.push({ table, values });
          if (table === enterpriseRuns) {
            return {
              returning: async () => [
                {
                  ...values,
                  createdAt: new Date(0),
                  updatedAt: new Date(0),
                  finishedAt: null,
                  errorCode: null,
                },
              ],
            };
          }
          return Promise.resolve([]);
        },
      };
    },
  };
  const result = await runStore.createRunInTransaction(
    tx as never,
    scope,
    {
      threadId: "thread-a",
      clientMessageKey: "message-a",
      messageDigest: "digest-a",
      attachmentRefs: ["attachment-a"],
      entrypoint: "web",
    },
    "expert-version",
    "model-route",
    128,
    30_000,
  );

  expect(result.run.run_id).toBe(result.runId);
  expect(result.runId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(result.attemptId).toBeString();
  expect(writes.map(({ table }) => table)).toEqual([
    enterpriseRuns,
    enterpriseRunAttempts,
    enterpriseRunOutbox,
  ]);
  expect(writes[1]?.values).toMatchObject({
    runId: result.runId,
    id: result.attemptId,
    generation: result.generation,
  });
  expect(writes[2]?.values).toMatchObject({
    runId: result.runId,
    eventType: "run.start",
    payload: {
      runId: result.runId,
      attemptId: result.attemptId,
      generation: result.generation,
    },
  });
});

async function makeResolver(
  candidates: readonly Record<string, unknown>[],
  matches: readonly Record<string, unknown>[],
  identity: { actorId: string; entrypoint: "web" } | null = {
    actorId: "actor-a",
    entrypoint: "web",
  },
  legacyMatches: readonly Record<string, unknown>[] = [],
) {
  const directory = await verifyDirectoryDatabase(
    controlledDatabase(
      () => candidates,
      () => {},
    ),
  );
  const data = await verifyDataDatabase(
    controlledDatabase(
      (table) => {
        return table === enterpriseConversations
          ? matches
          : table === intelligenceChannelMappings
            ? legacyMatches
            : [];
      },
      () => {},
    ),
  );
  return tenancy.createScopeResolver(directory, {
    authenticate: async () => identity,
    data,
  });
}

function authorizedLegacyMatch() {
  return {
    actorId: "actor-a",
    threadId: "legacy-thread",
    channelId: "channel-a",
    memberId: "actor-a",
    channelDeletedAt: null,
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    tenantStatus: "active",
    principalStatus: "active",
    membershipStatus: "active",
    memberEpoch: 3,
    resourceKind: "channel",
    resourceStatus: "active",
    grantPrincipalId: "principal-a",
    grantAction: "read",
  };
}

function conversationDatabase(): Database {
  const capabilityCheck = {
    current_user_matches: true,
    capability_attributes_ok: true,
    login_attributes_ok: true,
    login_has_expected_capability: true,
    capability_has_no_escalation_membership: true,
    login_has_no_other_memberships: true,
    no_protected_ownership: true,
    login_has_no_enterprise_privileges: true,
  };
  const tx = {
    execute: async () => [],
    select: () => {
      let table: unknown;
      const query = Promise.resolve([] as Record<string, unknown>[]);
      return Object.assign(query, {
        from(value: unknown) {
          table = value;
          return this;
        },
        leftJoin() {
          return this;
        },
        innerJoin() {
          return this;
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        limit() {
          return Promise.resolve(
            table === enterpriseMemberships
              ? [
                  {
                    memberStatus: "active",
                    memberEpoch: 3,
                    principalStatus: "active",
                    tenantStatus: "active",
                    workspaceId: "workspace-a",
                  },
                ]
              : [],
          );
        },
      });
    },
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        const inserted = { ...values };
        return {
          onConflictDoNothing() {
            return this;
          },
          returning: async () =>
            table === enterpriseConversations
              ? [
                  {
                    id: "conversation-id",
                    ...inserted,
                    lastSeq: 0,
                    createdAt: new Date(0),
                    updatedAt: new Date(0),
                  },
                ]
              : [],
        };
      },
    }),
  };
  return {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (value: unknown) => Promise<unknown>) =>
      operation(tx),
  } as unknown as Database;
}

function legacyAppendDatabase(onWrite: () => void): Database {
  const capabilityCheck = {
    current_user_matches: true,
    capability_attributes_ok: true,
    login_attributes_ok: true,
    login_has_expected_capability: true,
    capability_has_no_escalation_membership: true,
    login_has_no_other_memberships: true,
    no_protected_ownership: true,
    login_has_no_enterprise_privileges: true,
  };
  const tx = {
    execute: async () => [],
    select: () => {
      let table: unknown;
      const query = Promise.resolve([] as Record<string, unknown>[]);
      return Object.assign(query, {
        from(value: unknown) {
          table = value;
          return this;
        },
        innerJoin() {
          return this;
        },
        leftJoin() {
          return this;
        },
        where() {
          return this;
        },
        limit() {
          if (table === enterpriseMemberships)
            return Promise.resolve([
              {
                memberStatus: "active",
                memberEpoch: 3,
                principalStatus: "active",
                tenantStatus: "active",
                workspaceId: "workspace-a",
              },
            ]);
          if (table === intelligenceChannelMappings)
            return Promise.resolve([
              {
                actorId: "actor-a",
                channelId: "channel-a",
                threadId: "legacy-thread",
                liveChannelId: "channel-a",
                channelDeletedAt: null,
                memberId: "actor-a",
              },
            ]);
          if (table === enterpriseResources)
            return Promise.resolve([{ id: "channel-a" }]);
          return Promise.resolve([] as Record<string, unknown>[]);
        },
      });
    },
    insert: () => {
      onWrite();
      throw new Error("unexpected_insert");
    },
  };
  return {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (value: unknown) => Promise<unknown>) =>
      operation(tx),
  } as unknown as Database;
}

function controlledDatabase(
  rows: (table?: unknown) => readonly Record<string, unknown>[],
  beforeTransaction: () => void,
): Database {
  const capabilityCheck = {
    current_user_matches: true,
    capability_attributes_ok: true,
    login_attributes_ok: true,
    login_has_expected_capability: true,
    capability_has_no_escalation_membership: true,
    login_has_no_other_memberships: true,
    no_protected_ownership: true,
    login_has_no_enterprise_privileges: true,
  };
  const transaction = async (operation: (tx: unknown) => Promise<unknown>) => {
    beforeTransaction();
    return operation({
      execute: async () => [],
      select: () => controlledQuery(rows),
    });
  };
  return {
    execute: async () => [capabilityCheck],
    transaction,
  } as unknown as Database;
}

function controlledQuery(
  rows: (table?: unknown) => readonly Record<string, unknown>[],
) {
  let result = rows();
  const query = Promise.resolve(rows());
  const chain = () => query;
  return Object.assign(query, {
    from(value: unknown) {
      result = rows(value);
      return this;
    },
    innerJoin: chain,
    where: chain,
    limit() {
      return Promise.resolve(result);
    },
  });
}

test("mastra_storage_probe_runs_before_conversation_transaction", async () => {
  const events: string[] = [];
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  const base = conversationDatabase() as unknown as {
    transaction: (
      operation: (tx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const data = await verifyDataDatabase(
    Object.assign(conversationDatabase(), {
      transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        events.push("tx");
        return base.transaction(operation);
      },
    }) as unknown as Parameters<typeof verifyDataDatabase>[0],
  );
  const service = createConversationService({
    data,
    mastraStorage: {
      getStore: async () => {
        events.push("probe");
        return {};
      },
    } as never,
  });

  await service.getOrCreate(scope, { title: "New chat" });

  expect(events[0]).toBe("probe");
});

test("mastra_storage_probe_failure_preserves_cause_and_logs_once", async () => {
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const resolver = await makeResolver(
      [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
      [
        {
          tenantId: "tenant-a",
          workspaceId: "workspace-a",
          principalId: "principal-a",
          tenantStatus: "active",
        },
      ],
    );
    const scope = await resolver.resolveForThread(
      new Request("https://example.invalid"),
      "thread-a",
    );
    const data = await verifyDataDatabase(conversationDatabase());
    const probeFailure = new Error("POOL_TIMEOUT");
    const service = createConversationService({
      data,
      mastraStorage: {
        getStore: async () => {
          throw probeFailure;
        },
      } as never,
    });

    let thrown: unknown;
    try {
      await service.getOrCreate(scope, { title: "New chat" });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe("MASTRA_STORAGE_UNAVAILABLE");
    expect((thrown as { cause?: unknown }).cause).toBe(probeFailure);
    expect(logs).toHaveLength(1);
    expect((logs[0]?.[0] as { error?: unknown })?.error).toBe(
      "MASTRA_STORAGE_PROBE_FAILED",
    );
  } finally {
    console.error = originalError;
  }
});

test("member_candidate_thread_lookups_run_in_parallel", async () => {
  const candidates = [
    { tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 },
    { tenantId: "tenant-b", principalId: "principal-b", memberEpoch: 1 },
  ];
  const directory = await verifyDirectoryDatabase(
    controlledDatabase(
      () => candidates,
      () => {},
    ),
  );
  const capabilityCheck = {
    current_user_matches: true,
    capability_attributes_ok: true,
    login_attributes_ok: true,
    login_has_expected_capability: true,
    capability_has_no_escalation_membership: true,
    login_has_no_other_memberships: true,
    no_protected_ownership: true,
    login_has_no_enterprise_privileges: true,
  };
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  const gated = async (operation: (tx: unknown) => Promise<unknown>) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active >= 2) release();
    try {
      if (active < 2) {
        await Promise.race([
          both,
          new Promise<void>((resolve) => {
            fallbackTimer = setTimeout(resolve, 500);
          }),
        ]);
      }
      return await operation({
        execute: async () => [],
        select: () => controlledQuery(() => []),
      });
    } finally {
      active -= 1;
    }
  };
  const data = await verifyDataDatabase({
    execute: async () => [capabilityCheck],
    transaction: gated,
  } as unknown as Parameters<typeof verifyDataDatabase>[0]);
  const resolver = tenancy.createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    data,
  });

  await resolver
    .resolveForThread(new Request("https://example.invalid"), "thread-a")
    .catch(() => undefined);
  if (fallbackTimer) clearTimeout(fallbackTimer);

  expect(maxActive).toBe(2);
});

// --- OCR R3: expired-lease active runs are reclaimable, live ones conflict (HIGH-3)

test("expired_lease_active_run_does_not_block_new_run_and_is_terminalized", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  const now = Date.now();
  const expiredRun = {
    id: "run-old",
    tenantId: "tenant-a",
    threadId: "thread-a",
    status: "running",
    attemptGeneration: 1,
    leaseExpiresAt: new Date(now - 5_000),
  };
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const updates: {
    table: unknown;
    values: Record<string, unknown>;
  }[] = [];
  const outbox: { eventType: string }[] = [];
  let runsSelects = 0;
  const tx = {
    execute: async () => [],
    select: () => {
      let table: unknown;
      const query = Promise.resolve([] as Record<string, unknown>[]);
      return Object.assign(query, {
        from(value: unknown) {
          table = value;
          return this;
        },
        where() {
          return this;
        },
        limit() {
          if (table === enterpriseConversations)
            return Promise.resolve([
              { storageBackend: "mastra", backendVersion: 2 },
            ]);
          if (table === mastraMessageIntents)
            return Promise.resolve([
              {
                tenantId: "tenant-a",
                threadId: "thread-a",
                clientMessageKey: "message-a",
                digest: "digest-a",
                actorId: "actor-a",
                principalId: "principal-a",
                backendVersion: 2,
                attachmentIds: ["attachment-a"],
                state: "finalized",
              },
            ]);
          if (table === enterpriseRuns) {
            runsSelects += 1;
            // First enterprise_runs select is the idempotency probe (no
            // prior submission); the second is the active-run conflict probe.
            return Promise.resolve(
              runsSelects === 2 ? [{ ...expiredRun }] : [],
            );
          }
          return Promise.resolve([]);
        },
      });
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table, values });
          return this;
        },
        where() {
          return this;
        },
        returning: async () => [{}],
      };
    },
    insert(table: unknown) {
      return {
        values: (values: Record<string, unknown>) => {
          writes.push({ table, values });
          if ((table as { name?: string })?.name === undefined) {
            // The drizzle table symbol path used by the existing harness is
            // not available here; classify by the outbox event value below.
          }
          if (values.eventType)
            outbox.push({ eventType: String(values.eventType) });
          if (values.status === "queued") {
            return {
              returning: async () => [
                {
                  ...values,
                  createdAt: new Date(0),
                  updatedAt: new Date(0),
                  finishedAt: null,
                  errorCode: null,
                },
              ],
            };
          }
          return Promise.resolve([]);
        },
      };
    },
  };
  const result = await runStore.createRunInTransaction(
    tx as never,
    scope,
    {
      threadId: "thread-a",
      clientMessageKey: "message-a",
      messageDigest: "digest-a",
      attachmentRefs: ["attachment-a"],
      entrypoint: "web",
    },
    "expert-version",
    "model-route",
    128,
    30_000,
  );
  // The stale row no longer blocks: a new run is created.
  expect(result.runId).toBeString();
  // The stale row is terminalized in the same transaction: cancelled with
  // timeout semantics, its active attempt closed, exactly one outbox event.
  const runUpdate = updates.find(
    (update) => (update.table as unknown) === enterpriseRuns,
  );
  expect(runUpdate?.values.status).toBe("cancelled");
  expect(runUpdate?.values.errorCode).toBe("CANCELLED_TIMEOUT");
  const attemptUpdate = updates.find(
    (update) => (update.table as unknown) === enterpriseRunAttempts,
  );
  expect(attemptUpdate?.values.status).toBe("cancelled");
  expect(
    outbox.filter((event) => event.eventType === "run.cancel"),
  ).toHaveLength(1);
});

test("live_leased_active_run_still_conflicts", async () => {
  const resolver = await makeResolver(
    [{ tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 }],
    [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ],
  );
  const scope = await resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
  const liveRun = {
    id: "run-live",
    tenantId: "tenant-a",
    threadId: "thread-a",
    status: "running",
    attemptGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 120_000),
  };
  let runsSelects = 0;
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    execute: async () => [],
    select: () => {
      let table: unknown;
      const query = Promise.resolve([] as Record<string, unknown>[]);
      return Object.assign(query, {
        from(value: unknown) {
          table = value;
          return this;
        },
        where() {
          return this;
        },
        limit() {
          if (table === enterpriseConversations)
            return Promise.resolve([
              { storageBackend: "mastra", backendVersion: 2 },
            ]);
          if (table === mastraMessageIntents)
            return Promise.resolve([
              {
                tenantId: "tenant-a",
                threadId: "thread-a",
                clientMessageKey: "message-a",
                digest: "digest-a",
                actorId: "actor-a",
                principalId: "principal-a",
                backendVersion: 2,
                attachmentIds: ["attachment-a"],
                state: "finalized",
              },
            ]);
          if (table === enterpriseRuns) {
            runsSelects += 1;
            return Promise.resolve(runsSelects === 2 ? [{ ...liveRun }] : []);
          }
          return Promise.resolve([]);
        },
      });
    },
    update() {
      throw new Error("unexpected_update");
    },
    insert(table: unknown) {
      return {
        values: (values: Record<string, unknown>) => {
          writes.push({ table, values });
          return Promise.resolve([]);
        },
      };
    },
  };
  let conflict: unknown;
  try {
    await runStore.createRunInTransaction(
      tx as never,
      scope,
      {
        threadId: "thread-a",
        clientMessageKey: "message-a",
        messageDigest: "digest-a",
        attachmentRefs: ["attachment-a"],
        entrypoint: "web",
      },
      "expert-version",
      "model-route",
      128,
      30_000,
    );
  } catch (error) {
    conflict = error;
  }
  expect((conflict as { code?: string })?.code).toBe("ACTIVE_RUN_CONFLICT");
  expect(writes).toHaveLength(0);
});

test("invocation_capability_fk_keeps_the_default_drizzle_name", async () => {
  const source = readFileSync(
    new URL("../../src/db/schema/enterprise-runs.ts", import.meta.url),
    "utf8",
  );
  const capabilityTable = source.slice(
    source.indexOf("enterprise_model_invocation_capabilities"),
    source.indexOf("enterprise_run_outbox"),
  );
  // The capability table's attempt FK was created by 0059 under the default
  // long name; an explicit name here would drift from every snapshot (OCR H2).
  expect(capabilityTable).not.toContain('name: "enterprise_runner_events');
});
