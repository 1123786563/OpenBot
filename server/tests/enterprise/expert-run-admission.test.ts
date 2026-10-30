import { describe, expect, it } from "../../../tests/support/e2e-compat";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../../src/db/client";
import type {
  ConversationService,
  PlatformScope,
  RunService,
  StartRunInput,
  TrustedRunAdmission,
} from "../../src/enterprise/contracts";
import {
  canonicalizeExpertDefinition,
  type ExpertDefinitionV1,
  ExpertVersionCatalog,
} from "../../src/enterprise/experts/version-catalog";
import {
  createRunService,
  type RunModelRoute,
} from "../../src/enterprise/runs/service";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

type Assert<T extends true> = T;
type StartRunInputHasNoIdentityFields = Assert<
  keyof StartRunInput extends
    | "threadId"
    | "clientMessageKey"
    | "messageDigest"
    | "attachmentRefs"
    | "entrypoint"
    | "forwardedProps"
    ? true
    : false
>;
type RouteCarriesNoExpertIdentity = Assert<
  "expertVersionRef" extends keyof RunModelRoute ? false : true
>;

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

async function trustedScope(): Promise<PlatformScope> {
  const directory = {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () => {
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                tenantId: "tenant-a",
                principalId: "principal-a",
                tenantStatus: "active",
                principalStatus: "active",
                memberStatus: "active",
                memberEpoch: 1,
                status: "active",
              },
            ],
          };
          return query;
        },
      }),
  } as unknown as Database;
  const verified = await verifyDirectoryDatabase(directory);
  const resolver = createScopeResolver(verified, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    selectTenant: () => "tenant-a",
    selectWorkspace: () => "workspace-a",
  });
  return resolver.resolve(new Request("https://example.invalid"));
}

function definition(): ExpertDefinitionV1 {
  return {
    schemaVersion: 1,
    agentId: "bot-a",
    source: "user_profile",
    agentType: "built_in",
    systemPrompt: "Follow the registered Bot instructions.",
    behaviorVersion: "openbot-builtin-v1",
  };
}

function storedRow(tenantId: string, definitionValue: ExpertDefinitionV1) {
  const canonical = canonicalizeExpertDefinition(tenantId, definitionValue);
  return {
    tenant_id: tenantId,
    expert_version_ref: canonical.expertVersionRef,
    schema_version: 1,
    agent_id: canonical.agentId,
    snapshot: canonical.definition,
  };
}

type RecordedEvent =
  | { kind: "execute"; sql: string; params: unknown[] }
  | { kind: "select"; table: string | null }
  | {
      kind: "insert";
      table: string;
      values: Record<string, unknown>;
      conflict: boolean;
    };

interface HarnessState {
  expertRow: unknown;
  intentRow: unknown;
  backend: "platform" | "mastra";
}

const tableName = Symbol.for("drizzle:Name");

/**
 * Records every statement, chained select, and insert one Run admission
 * transaction issues, so tests can prove the Expert verifier, Run/attempt
 * creation, and budget reservation share one transaction handle.
 */
class RecordingTransaction {
  readonly events: RecordedEvent[] = [];
  private runsSelectCount = 0;

  constructor(private readonly state: HarnessState) {}

  async execute(statement: SQL): Promise<unknown> {
    const query = new PgDialect().sqlToQuery(statement);
    this.events.push({ kind: "execute", sql: query.sql, params: query.params });
    if (query.sql.toLowerCase().includes("from enterprise_expert_versions")) {
      const row = this.state.expertRow as Record<string, unknown> | null;
      if (
        row &&
        row.tenant_id === query.params[query.params.length - 2] &&
        row.expert_version_ref === query.params[query.params.length - 1]
      ) {
        return [row];
      }
      return [];
    }
    return [];
  }

  select(_selection: unknown) {
    const query = {
      table: null as string | null,
      from(table: unknown) {
        query.table = (table as Record<symbol, string>)[tableName];
        return query;
      },
      innerJoin() {
        return query;
      },
      where() {
        return query;
      },
      for() {
        return query;
      },
      limit: async () => {
        this.events.push({ kind: "select", table: query.table });
        return this.rowsForSelect(query.table);
      },
    };
    return query;
  }

  private rowsForSelect(table: string | null): unknown[] {
    switch (table) {
      case "enterprise_memberships":
        return [
          {
            memberStatus: "active",
            principalStatus: "active",
            tenantStatus: "active",
            memberEpoch: 1,
          },
        ];
      case "enterprise_conversations":
        return [{ storageBackend: this.state.backend, backendVersion: 1 }];
      case "enterprise_messages":
        return [{ id: "message-1", attachments: [] }];
      case "mastra_message_intents":
        return this.state.intentRow ? [this.state.intentRow] : [];
      case "enterprise_runs":
        this.runsSelectCount += 1;
        return this.runsSelectCount >= 3
          ? [{ workspaceId: "workspace-a", principalId: "principal-a" }]
          : [];
      default:
        return [];
    }
  }

  insert(table: unknown) {
    const name = (table as Record<symbol, string>)[tableName];
    const call = {
      table: name,
      values: {} as Record<string, unknown>,
      conflict: false,
    };
    const self = this;
    const builder = {
      values(values: Record<string, unknown>) {
        call.values = values;
        return builder;
      },
      onConflictDoNothing() {
        call.conflict = true;
        return builder;
      },
      returning: async () => self.rowsForInsert(call),
      // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle insert builders being awaitable with or without .returning()
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(self.rowsForInsert(call)).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return builder;
  }

  private rowsForInsert(call: {
    table: string;
    values: Record<string, unknown>;
    conflict: boolean;
  }): unknown[] {
    this.events.push({
      kind: "insert",
      table: call.table,
      values: call.values,
      conflict: call.conflict,
    });
    switch (call.table) {
      case "enterprise_runs":
        return [
          {
            ...call.values,
            createdAt: new Date(),
            updatedAt: new Date(),
            finishedAt: null,
            errorCode: null,
          },
        ];
      case "enterprise_model_budget_reservations":
        return [
          {
            id: "reservation-1",
            runId: call.values.runId,
            modelRouteRef: call.values.modelRouteRef,
            tokenLimit: call.values.tokenLimit,
            isRunCeiling: call.values.isRunCeiling,
            expiresAt: call.values.expiresAt,
          },
        ];
      default:
        return [];
    }
  }
}

async function admissionHarness(
  options: { routeRef?: string; routeMaximumTokens?: number } = {},
) {
  const state: HarnessState = {
    expertRow: storedRow("tenant-a", definition()),
    intentRow: null,
    backend: "platform",
  };
  const routeRef = options.routeRef ?? `mroute:v1:${"b".repeat(64)}`;
  const transactions: RecordingTransaction[] = [];
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (
      operation: (tx: RecordingTransaction) => Promise<unknown>,
    ) => {
      const tx = new RecordingTransaction(state);
      transactions.push(tx);
      return operation(tx);
    },
  } as unknown as Database;
  const data = await verifyDataDatabase(database);
  const conversations = {
    resolveBackend: async () => state.backend,
  } as unknown as ConversationService;
  const runs: RunService = createRunService({
    data,
    conversations,
    expertVersions: new ExpertVersionCatalog(data),
    modelRouteFor: async (): Promise<RunModelRoute> => ({
      routeRef,
      maximumTokens: options.routeMaximumTokens ?? 4000,
    }),
    modelCapabilitySecret:
      "test-only-model-capability-secret-000000000000000000000000000000",
  });
  const scope = await trustedScope();
  const admit = (
    overrides: {
      input?: Partial<StartRunInput>;
      agentId?: string;
      expertVersionRef?: string;
      admissionRouteRef?: string;
    } = {},
  ): TrustedRunAdmission => {
    const canonical = canonicalizeExpertDefinition("tenant-a", definition());
    return {
      input: {
        threadId: "thread-1",
        clientMessageKey: "message-key-1",
        attachmentRefs: [],
        entrypoint: "web",
        forwardedProps: { maxOutputTokens: 1500 },
        ...overrides.input,
      },
      agentId: overrides.agentId ?? canonical.agentId,
      expertVersionRef: (Object.hasOwn(overrides, "expertVersionRef")
        ? overrides.expertVersionRef
        : canonical.expertVersionRef) as TrustedRunAdmission["expertVersionRef"],
      routeRef: overrides.admissionRouteRef ?? routeRef,
    };
  };
  return { runs, scope, state, admit, transactions, routeRef };
}

function runInserts(tx: RecordingTransaction) {
  return tx.events.filter(
    (event): event is Extract<RecordedEvent, { kind: "insert" }> =>
      event.kind === "insert" && event.table === "enterprise_runs",
  );
}

function budgetInserts(tx: RecordingTransaction) {
  return tx.events.filter(
    (event): event is Extract<RecordedEvent, { kind: "insert" }> =>
      event.kind === "insert" &&
      event.table === "enterprise_model_budget_reservations",
  );
}

function expertVerifyIndex(tx: RecordingTransaction): number {
  return tx.events.findIndex(
    (event) =>
      event.kind === "execute" &&
      event.sql.toLowerCase().includes("from enterprise_expert_versions"),
  );
}

describe("trusted Expert Run admission", () => {
  it("keeps client run input and route identity free of Expert authority", () => {
    const startRunInputHasNoIdentityFields =
      true as StartRunInputHasNoIdentityFields;
    const routeCarriesNoExpertIdentity = true as RouteCarriesNoExpertIdentity;
    expect(startRunInputHasNoIdentityFields).toBe(true);
    expect(routeCarriesNoExpertIdentity).toBe(true);
  });

  it("verifies the Expert in the Run transaction and persists distinct refs with the exact caller ceiling", async () => {
    const { runs, scope, admit, transactions } = await admissionHarness();
    const admission = admit();

    const run = await runs.start(scope, admission);

    expect(transactions).toHaveLength(1);
    const tx = transactions[0];
    const persisted = runInserts(tx);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].values.expertVersionRef).toBe(
      admission.expertVersionRef,
    );
    expect(persisted[0].values.modelRouteRef).toBe(admission.routeRef);
    expect(persisted[0].values.expertVersionRef).not.toBe(
      persisted[0].values.modelRouteRef,
    );
    expect(persisted[0].values.modelRouteMaximumTokens).toBe(1500);

    for (const bad of [0, NaN, 2_147_483_648]) {
      const rejected = await admissionHarness({
        routeMaximumTokens: bad,
      });
      await expect(
        rejected.runs.start(scope, rejected.admit()),
      ).rejects.toThrow("MODEL_ROUTE_UNAVAILABLE");
    }
    // A route cap below the caller ceiling clamps the persisted route limit
    // while the budget reservation keeps the full caller ceiling — the
    // service-level contract runs.integration pins end to end.
    const tightened = await admissionHarness({
      routeMaximumTokens: 100,
    });
    const tightenedRun = await tightened.runs.start(scope, tightened.admit());
    expect(tightenedRun).toBeDefined();
    const tightenedTx = tightened.transactions[0];
    expect(runInserts(tightenedTx)[0].values.modelRouteMaximumTokens).toBe(100);
    expect(budgetInserts(tightenedTx)[0].values.tokenLimit).toBe(1500);
    // A cap exactly at the ceiling is the identity case production always
    // produces.
    const exact = await admissionHarness({
      routeMaximumTokens: 1500,
    });
    const exactRun = await exact.runs.start(scope, exact.admit());
    expect(exactRun).toBeDefined();
    expect(
      runInserts(exact.transactions[0])[0].values.modelRouteMaximumTokens,
    ).toBe(1500);
    const reservation = budgetInserts(tx);
    expect(reservation).toHaveLength(1);
    expect(reservation[0].values.tokenLimit).toBe(1500);
    expect(reservation[0].values.modelRouteRef).toBe(admission.routeRef);
    expect(reservation[0].values.isRunCeiling).toBe(true);
    expect(run.thread_id).toBe(admission.input.threadId);
    // The trusted scope recheck, the Expert verification, Run creation, and the
    // budget reservation all issue through the one shared transaction handle.
    expect(
      tx.events.some(
        (event) =>
          event.kind === "select" && event.table === "enterprise_memberships",
      ),
    ).toBe(true);
    const runInsertIndex = tx.events.findIndex(
      (event) => event.kind === "insert" && event.table === "enterprise_runs",
    );
    expect(expertVerifyIndex(tx)).toBeGreaterThanOrEqual(0);
    expect(expertVerifyIndex(tx)).toBeLessThan(runInsertIndex);
  });

  it("changes only the route ref when the model route changes", async () => {
    const first = await admissionHarness();
    const second = await admissionHarness({
      routeRef: `mroute:v1:${"c".repeat(64)}`,
    });

    await first.runs.start(first.scope, first.admit());
    await second.runs.start(second.scope, second.admit());

    const firstRun = runInserts(first.transactions[0])[0];
    const secondRun = runInserts(second.transactions[0])[0];
    expect(firstRun.values.expertVersionRef).toBe(
      secondRun.values.expertVersionRef,
    );
    expect(firstRun.values.modelRouteRef).not.toBe(
      secondRun.values.modelRouteRef,
    );
    expect(firstRun.values.modelRouteRef).toBe(first.routeRef);
    expect(secondRun.values.modelRouteRef).toBe(second.routeRef);
  });

  it.each([undefined, "", "expert:v1:not-a-digest"] as const)(
    "rejects absent or malformed Expert ref without persisting: %s",
    async (expertVersionRef) => {
      const { runs, scope, admit, transactions } = await admissionHarness();
      const admission = admit({ expertVersionRef });

      await expect(runs.start(scope, admission)).rejects.toThrow(
        "EXPERT_VERSION_REF_INVALID",
      );
      const tx = transactions[0];
      expect(runInserts(tx)).toHaveLength(0);
      expect(budgetInserts(tx)).toHaveLength(0);
    },
  );

  it("rejects a cross-tenant Expert ref before Run or budget persistence", async () => {
    const { runs, scope, admit, state, transactions } =
      await admissionHarness();
    const foreign = storedRow("tenant-b", definition());
    state.expertRow = foreign;

    await expect(
      runs.start(
        scope,
        admit({ expertVersionRef: foreign.expert_version_ref }),
      ),
    ).rejects.toThrow("EXPERT_VERSION_NOT_FOUND");
    const tx = transactions[0];
    expect(runInserts(tx)).toHaveLength(0);
    expect(budgetInserts(tx)).toHaveLength(0);
  });

  it.each([
    {
      label: "tampered snapshot",
      row: () => ({
        ...storedRow("tenant-a", definition()),
        snapshot: {
          ...definition(),
          systemPrompt: "altered after catalog issuance",
        },
      }),
    },
    {
      label: "agent id mismatch",
      row: () => ({
        ...storedRow("tenant-a", definition()),
        agent_id: "bot-b",
      }),
    },
  ])("rejects a corrupt Expert row: $label", async ({ row }) => {
    const { runs, scope, admit, state, transactions } =
      await admissionHarness();
    state.expertRow = row();

    await expect(runs.start(scope, admit())).rejects.toThrow(
      "EXPERT_VERSION_CORRUPT",
    );
    const tx = transactions[0];
    expect(runInserts(tx)).toHaveLength(0);
    expect(budgetInserts(tx)).toHaveLength(0);
  });

  it("rejects a route ref that the independent selector did not issue", async () => {
    const { runs, scope, admit, transactions } = await admissionHarness();

    await expect(
      runs.start(
        scope,
        admit({ admissionRouteRef: `mroute:v1:${"d".repeat(64)}` }),
      ),
    ).rejects.toThrow("RUN_ROUTE_MISMATCH");
    expect(transactions).toHaveLength(0);
  });

  it("rejects an Expert ref minted for a different selected Bot", async () => {
    const { runs, scope, admit, transactions } = await admissionHarness();

    await expect(
      runs.start(scope, admit({ agentId: "bot-b" })),
    ).rejects.toThrow("EXPERT_AGENT_MISMATCH");
    const tx = transactions[0];
    expect(runInserts(tx)).toHaveLength(0);
    expect(budgetInserts(tx)).toHaveLength(0);
  });

  it.each([
    { forwardedProps: {} },
    { forwardedProps: { maxOutputTokens: 0 } },
    { forwardedProps: { maxOutputTokens: 2_147_483_648 } },
  ])(
    "rejects an invalid caller ceiling before any transaction: %j",
    async (input) => {
      const { runs, scope, admit, transactions } = await admissionHarness();

      await expect(
        runs.start(scope, admit({ input: input as Partial<StartRunInput> })),
      ).rejects.toThrow("RUN_OUTPUT_CEILING_REQUIRED");
      expect(transactions).toHaveLength(0);
    },
  );

  it("ignores client-issued identity fields in the run input", async () => {
    const { runs, scope, admit, transactions } = await admissionHarness();
    const admission = admit({
      input: {
        forwardedProps: {
          maxOutputTokens: 1500,
          botId: "attacker-bot",
          expertVersionRef: "attacker-expert",
          routeRef: "attacker-route",
        },
      },
    });

    await runs.start(scope, admission);

    const persisted = runInserts(transactions[0])[0];
    expect(persisted.values.expertVersionRef).toBe(admission.expertVersionRef);
    expect(persisted.values.modelRouteRef).toBe(admission.routeRef);
  });

  it("still requires a finalized matching Mastra intent and persists when it matches", async () => {
    const { runs, scope, admit, state, transactions } = await admissionHarness({
      routeRef: `mroute:v1:${"e".repeat(64)}`,
    });
    state.backend = "mastra";
    const finalizedIntent = {
      id: "intent-1",
      tenantId: "tenant-a",
      threadId: "thread-1",
      clientMessageKey: "message-key-1",
      digest: "a".repeat(64),
      actorId: "actor-a",
      principalId: "principal-a",
      backendVersion: 1,
      attachmentIds: [],
      state: "finalized",
    };

    await expect(
      runs.start(scope, admit({ input: { messageDigest: undefined } })),
    ).rejects.toThrow("RUN_INPUT_NOT_FINALIZED");
    state.intentRow = { ...finalizedIntent, state: "pending" };
    await expect(
      runs.start(
        scope,
        admit({ input: { messageDigest: finalizedIntent.digest } }),
      ),
    ).rejects.toThrow("RUN_INPUT_NOT_FINALIZED");
    state.intentRow = { ...finalizedIntent, digest: "b".repeat(64) };
    await expect(
      runs.start(
        scope,
        admit({ input: { messageDigest: finalizedIntent.digest } }),
      ),
    ).rejects.toThrow("RUN_INPUT_NOT_FINALIZED");
    for (const tx of transactions) {
      expect(runInserts(tx)).toHaveLength(0);
      expect(budgetInserts(tx)).toHaveLength(0);
    }

    state.intentRow = finalizedIntent;
    const run = await runs.start(
      scope,
      admit({ input: { messageDigest: finalizedIntent.digest } }),
    );
    const tx = transactions[transactions.length - 1];
    expect(run.thread_id).toBe("thread-1");
    expect(runInserts(tx)).toHaveLength(1);
    expect(budgetInserts(tx)).toHaveLength(1);
  });
});
