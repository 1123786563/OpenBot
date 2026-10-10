import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";

import { createDatabase } from "../../../src/db/client";
import { sha256 } from "../../../src/enterprise/runs/digest";
import {
  createRunService,
  deriveCapabilitySecret,
} from "../../../src/enterprise/runs/service";
import type { EnterpriseRuntimeConfig } from "../../../src/enterprise/runtime/config";
import { invocationEnvelopeDigest } from "../../../src/enterprise/runtime/envelope-digest";
import { createDirectory } from "../../../src/enterprise/tenancy/directory";
import { resolveScope } from "../../../src/enterprise/tenancy/scope";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * E1-lite service integration: the frozen RunService contract against the
 * REAL ledger through the REAL restricted logins. Skipped when the runs
 * migration + the five capability roles + the restricted-login env vars are
 * absent — the same probe discipline as schema.test.ts.
 *
 * Fixture rows (tenant/principal/membership/workspace/resource/release/
 * route/grants/account) are provisioned through the migration-owner pool —
 * provisioning is OFFLINE by the role contract, which is exactly what this
 * seeds: what a real ob_ent_run_operator runbook would write.
 */

type Probe = { ready: boolean; reason: string };

async function probeRunsDatabase(): Promise<Probe> {
  if (!process.env.TEST_DATABASE_URL) {
    return { ready: false, reason: "TEST_DATABASE_URL missing" };
  }
  let client: import("bun").SQL | undefined;
  try {
    const url = testDatabaseUrlFrom(process.env);
    const opened = new Bun.SQL(url, { max: 1, connectionTimeout: 5 });
    client = opened;
    const tables = await opened.unsafe(
      "select 1 from pg_tables where schemaname = 'public' and tablename = 'enterprise_runs'",
    );
    if (tables.length === 0) {
      return {
        ready: false,
        reason: "migrations not applied to the test database",
      };
    }
    const roles = await opened.unsafe(
      "select rolname from pg_roles where rolname in ('ob_ent_run_writer','ob_ent_runtime_writer')",
    );
    if (roles.length < 2) {
      return {
        ready: false,
        reason:
          "runs capability roles missing; run enterprise-test-db.ts roles",
      };
    }
    for (const variable of [
      "ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL",
      "ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL",
    ]) {
      if (!process.env[variable]) {
        return { ready: false, reason: `${variable} missing` };
      }
    }
    return { ready: true, reason: "" };
  } catch (error) {
    return { ready: false, reason: String((error as Error)?.message ?? error) };
  } finally {
    await client?.close();
  }
}

const dbProbe: Probe = await probeRunsDatabase();
if (!dbProbe.ready) {
  console.warn(
    `[service.test.ts] real-database assertions skipped: ${dbProbe.reason}`,
  );
}
const describeDb = dbProbe.ready ? describe : describe.skip;

if (dbProbe.ready) {
  const ownerUrl = testDatabaseUrlFrom(process.env);
  const owner = createDatabase(ownerUrl, { max: 2 });
  const runWriter = createDatabase(
    testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL,
    }),
    { max: 2 },
  );
  const runtimeWriter = createDatabase(
    testDatabaseUrlFrom({
      TEST_DATABASE_URL:
        process.env.ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL,
    }),
    { max: 2 },
  );

  const TENANT = "e1lite-tenant";
  const PRINCIPAL = "e1lite-principal";
  const USER = "e1lite-user";
  const WORKSPACE = "e1lite-workspace";
  const RESOURCE = "e1lite-resource";
  const RELEASE = "e1lite-release";
  const ROUTE = "e1lite-route";
  const ALIAS = "e1lite-alias";
  const KEY_ENCRYPTION_KEY = "dGVzdC1vbmx5LTMyLWJ5dGVzLWtleS1lbmNyeXB0aW9u"; // base64 of 32 bytes

  const runtimeConfig: EnterpriseRuntimeConfig = {
    serviceCredential: "test-shared-secret",
    serviceId: "runtime-go-test",
    executionUrl:
      "http://127.0.0.1:4202/internal/enterprise/v1/runtime/execution",
    cancelUrl: "http://127.0.0.1:4202/internal/enterprise/v1/runtime/cancel",
    runWriterDatabaseUrl: "unused-here",
    runtimeWriterDatabaseUrl: "unused-here",
    modelBaseUrl: "https://model.example/v4",
    modelAlias: ALIAS,
    modelRouteRef: "e1lite-model-route-ref",
    expertVersion: "assistant-v1",
    expertInstructionPath: "/unused/instruction.txt",
    governedTools: [{ name: "enterprise_echo", installationVersion: "v1" }],
    budgetCapMicros: 500_000,
    budgetCurrency: "USD",
    leaseTtlMs: 600_000,
    capabilityTtlMs: 300_000,
  };

  /** Scopes are minted through the real directory path — assertScope refuses hand-built ones. */
  async function issuedScope(
    userId: string,
  ): Promise<Awaited<ReturnType<typeof resolveScope>>> {
    return resolveScope(createDirectory(owner), userId, TENANT);
  }

  const service = createRunService({
    runWriterDatabase: runWriter,
    runtimeWriterDatabase: runtimeWriter,
    runtime: runtimeConfig,
    keyEncryptionKey: KEY_ENCRYPTION_KEY,
  });

  async function seed(): Promise<void> {
    await owner.$client.begin(async (tx) => {
      await tx.unsafe(
        `insert into enterprise_tenants (id, name) values ($1, 'E1Lite Tenant')
         on conflict (id) do nothing`,
        [TENANT],
      );
      await tx.unsafe(
        `insert into users (id, name, email, email_verified, created_at, updated_at)
         values ($1, 'E1 Lite', 'e1lite@example.test', false, now(), now())
         on conflict (id) do nothing`,
        [USER],
      );
      await tx.unsafe(
        `insert into enterprise_principals (id, user_id, status)
         values ($1, $2, 'active')
         on conflict (id) do nothing`,
        [PRINCIPAL, USER],
      );
      await tx.unsafe(
        `insert into enterprise_memberships (tenant_id, principal_id, role, status, epoch)
         values ($1, $2, 'member', 'active', 1)
         on conflict (tenant_id, principal_id) do nothing`,
        [TENANT, PRINCIPAL],
      );
      await tx.unsafe(
        `insert into enterprise_workspaces (tenant_id, id, name) values ($1, $2, 'E1Lite Workspace')
         on conflict (tenant_id, id) do nothing`,
        [TENANT, WORKSPACE],
      );
      await tx.unsafe(
        `insert into enterprise_resources (tenant_id, id, workspace_id, kind, status)
         values ($1, $2, $3, 'expert', 'active')
         on conflict (tenant_id, id) do nothing`,
        [TENANT, RESOURCE, WORKSPACE],
      );
      await tx.unsafe(
        `insert into enterprise_run_releases (tenant_id, id, resource_id, version_digest,
           runtime_compatibility, expert_version, model_route_ref, input_limit_bytes,
           max_model_calls, max_run_micros, currency, tool_manifest_digest, tool_count)
         values ($1, $2, $3, 'release-digest-abc', 'go-candidate-1', 'assistant-v1', $4,
           32768, 4, 1000000, 'USD', 'manifest-digest', 1)
         on conflict (tenant_id, id) do nothing`,
        [TENANT, RELEASE, RESOURCE, runtimeConfig.modelRouteRef],
      );
      await tx.unsafe(
        `insert into enterprise_run_grants (tenant_id, release_id, principal_id, action, revision)
         values ($1, $2, $3, 'start', 1)
         on conflict (tenant_id, release_id, principal_id, action) do nothing`,
        [TENANT, RELEASE, PRINCIPAL],
      );
      await tx.unsafe(
        `insert into enterprise_model_routes (tenant_id, id, alias, revision, resource_id,
           target_ref, price_revision, currency, input_unit_micros, output_unit_micros,
           per_request_micros, max_input_tokens, max_output_tokens, max_request_bytes,
           protocol_profile, usage_profile)
         values ($1, $2, $3, 1, $4, 'glm-proxy', 1, 'USD', 1000, 2000, 0, 8192, 4096, 65536,
           'openai-chat', 'standard')
         on conflict (tenant_id, id) do nothing`,
        [TENANT, ROUTE, ALIAS, RESOURCE],
      );
      await tx.unsafe(
        `insert into enterprise_model_grants (tenant_id, route_id, principal_id, revision, status)
         values ($1, $2, $3, 1, 'active')
         on conflict (tenant_id, route_id, principal_id) do nothing`,
        [TENANT, ROUTE, PRINCIPAL],
      );
      await tx.unsafe(
        `insert into enterprise_budget_accounts (tenant_id, id, scope_kind, scope_ref, period_id,
           starts_at, ends_at, currency, limit_micros, revision)
         values ($1, $2, 'workspace', $3, 'e1lite-period', now(), now() + interval '30 days', 'USD', 10000000, 0)
         on conflict (tenant_id, id) do nothing`,
        [TENANT, "e1lite-account", WORKSPACE],
      );
    });
  }

  beforeAll(async () => {
    // Self-cleaning: a previous invocation's rows would flip idempotency
    // tests into replays. Reset the tenant slice and the account hold.
    await owner.$client.begin(async (tx) => {
      await tx.unsafe(
        `delete from enterprise_capabilities where tenant_id = $1`,
        [TENANT],
      );
      await tx.unsafe(
        `delete from enterprise_run_events where tenant_id = $1`,
        [TENANT],
      );
      await tx.unsafe(
        `delete from enterprise_run_attempts where tenant_id = $1`,
        [TENANT],
      );
      await tx.unsafe(
        `delete from enterprise_budget_bindings where tenant_id = $1`,
        [TENANT],
      );
      await tx.unsafe(
        `delete from enterprise_budget_reservations where tenant_id = $1`,
        [TENANT],
      );
      await tx.unsafe(`delete from enterprise_runs where tenant_id = $1`, [
        TENANT,
      ]);
      await tx.unsafe(`delete from enterprise_threads where tenant_id = $1`, [
        TENANT,
      ]);
      await tx.unsafe(
        `update enterprise_budget_accounts set held_micros = 0 where tenant_id = $1`,
        [TENANT],
      );
    });
    await seed();
    // The second principal exists from the start: the no-grant and the
    // foreign-principal tests both need a scope for it, regardless of order.
    await owner.$client.begin(async (tx) => {
      await tx.unsafe(
        `insert into users (id, name, email, email_verified, created_at, updated_at)
         values ('e1lite-user-2', 'No Grant', 'e1lite-2@example.test', false, now(), now())
         on conflict (id) do nothing`,
      );
      await tx.unsafe(
        `insert into enterprise_principals (id, user_id, status)
         values ('e1lite-principal-2', 'e1lite-user-2', 'active')
         on conflict (id) do nothing`,
      );
      await tx.unsafe(
        `insert into enterprise_memberships (tenant_id, principal_id, role, status, epoch)
         values ($1, 'e1lite-principal-2', 'member', 'active', 1)
         on conflict (tenant_id, principal_id) do nothing`,
        [TENANT],
      );
    });
  });

  afterAll(async () => {
    await owner.$client.close();
    await runWriter.$client.close();
    await runtimeWriter.$client.close();
  });

  const REQUEST = {
    workspace_id: WORKSPACE,
    expert_release_id: RELEASE,
    model_alias: ALIAS,
    input: { text: "打开企业运行时的大门" },
  } as const;

  describeDb("createRunService.createE1", () => {
    test("creates the full run bundle: run, attempt, two capabilities, budget hold", async () => {
      const scope = await issuedScope(USER);
      const created = await service.createE1({
        scope,
        key: "idem-1",
        request: REQUEST,
      });

      expect(created.replayed).toBe(false);
      expect(created.run.status).toBe("queued");
      /* invocation 可选（RunView 合同外的派生视图）；匹配器参数类型以左值收窄，
       * invocation 缺席时实参运行时仍为 undefined、断言照旧失败——类型表达，不改断言语义。 */
      expect(created.execution.runId).toBe(
        created.invocation?.turn_id as string,
      );
      // The invocation vouches for exactly the frozen input digest.
      expect(created.invocation?.input_digest).toBe(created.inputDigest);
      expect(created.invocation?.model_route_ref).toBe(
        runtimeConfig.modelRouteRef,
      );
      expect(created.invocation?.expert_version).toBe("assistant-v1");
      // The two capability secrets derive deterministically from the key.
      expect(created.capabilities.runtime).toBe(
        deriveCapabilitySecret(
          KEY_ENCRYPTION_KEY,
          "runtime",
          TENANT,
          created.run.run_id,
        ),
      );

      const runId = created.run.run_id;
      const rows = await owner.$client.unsafe(
        `select r.status, r.budget_reservation_id, r.input_text, a.lease_id, a.fencing_token,
                a.status as attempt_status
         from enterprise_runs r
         join enterprise_run_attempts a on a.tenant_id = r.tenant_id and a.run_id = r.id
         where r.tenant_id = $1 and r.id = $2`,
        [TENANT, runId],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row?.status).toBe("queued");
      expect(row?.attempt_status).toBe("active");
      expect(row?.input_text).toBe(REQUEST.input.text);
      // The invocation's lease is the attempt's lease — one lease, not two.
      expect(created.invocation?.lease_id).toBe(
        row?.lease_id as string | undefined,
      );

      const caps = await owner.$client.unsafe(
        `select audience, token_hash, envelope_digest from enterprise_capabilities
         where tenant_id = $1 and run_id = $2 order by audience`,
        [TENANT, runId],
      );
      expect(caps.length).toBe(2);
      for (const cap of caps as Array<Record<string, unknown>>) {
        const secret =
          cap.audience === "runtime"
            ? created.capabilities.runtime
            : created.capabilities.control;
        expect(cap.token_hash).toBe(
          createHash("sha256").update(String(secret), "utf8").digest("hex"),
        );
        expect(cap.envelope_digest).toBe(
          invocationEnvelopeDigest(created.invocation!),
        );
      }

      // The budget account holds exactly the cap; the reservation mirrors it.
      const account = (
        await owner.$client.unsafe(
          `select held_micros from enterprise_budget_accounts where tenant_id = $1 and id = 'e1lite-account'`,
          [TENANT],
        )
      )[0] as Record<string, unknown> | undefined;
      expect(String(account?.held_micros)).toBe("500000");
      const reservation = (
        await owner.$client.unsafe(
          `select run_id, cap_micros, status from enterprise_budget_reservations where tenant_id = $1 and id = $2`,
          [TENANT, created.run.run_id ? row?.budget_reservation_id : ""],
        )
      )[0] as Record<string, unknown> | undefined;
      expect(reservation?.run_id).toBe(runId);
      expect(String(reservation?.cap_micros)).toBe("500000");
    });

    test("the same Idempotency-Key replays the same run without re-dialing", async () => {
      const scope = await issuedScope(USER);
      const first = await service.createE1({
        scope,
        key: "idem-2",
        request: REQUEST,
      });
      const second = await service.createE1({
        scope,
        key: "idem-2",
        request: REQUEST,
      });
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.run.run_id).toBe(first.run.run_id);
      expect(second.invocation).toBeUndefined();
    });

    test("the same key with different content is a 409, never a second run", async () => {
      const scope = await issuedScope(USER);
      await service.createE1({ scope, key: "idem-3", request: REQUEST });
      expect(
        service.createE1({
          scope,
          key: "idem-3",
          request: { ...REQUEST, input: { text: "different content" } },
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    test("a principal without the start grant is refused 403", async () => {
      const scope = await issuedScope(USER);
      const scopeNoGrant = await issuedScope("e1lite-user-2");
      // Either authorization refusal is 403: the preflight model-ledger check
      // (runtime-writer pool) runs before the release-grant check by design,
      // so the principal with NEITHER grant hits the model one first.
      await expect(
        service.createE1({
          scope: scopeNoGrant,
          key: "idem-4",
          request: REQUEST,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    test("a run past the workspace's remaining budget is refused, the account untouched", async () => {
      const scope = await issuedScope(USER);
      // Drain the account below the cap with a direct offline hold.
      await owner.$client.unsafe(
        `update enterprise_budget_accounts set held_micros = limit_micros - 100000
         where tenant_id = $1 and id = 'e1lite-account'`,
        [TENANT],
      );
      await expect(
        service.createE1({ scope, key: "idem-5", request: REQUEST }),
      ).rejects.toMatchObject({ status: 403, code: "BUDGET_EXHAUSTED" });
      const account = (
        await owner.$client.unsafe(
          `select held_micros from enterprise_budget_accounts where tenant_id = $1 and id = 'e1lite-account'`,
          [TENANT],
        )
      )[0] as Record<string, unknown> | undefined;
      // Restore for any later assertions.
      await owner.$client.unsafe(
        `update enterprise_budget_accounts set held_micros = 0 where tenant_id = $1 and id = 'e1lite-account'`,
        [TENANT],
      );
      expect(String(account?.held_micros)).toBe(String(10_000_000 - 100_000));
    });

    test("cancel flips the run to cancel_requested exactly once", async () => {
      const scope = await issuedScope(USER);
      const created = await service.createE1({
        scope,
        key: "idem-6",
        request: REQUEST,
      });
      const view = await service.command(scope, created.run.run_id, {
        command_id: "cmd-1",
        expected_revision: "0",
        kind: "cancel",
      });
      expect(view.status).toBe("cancel_requested");
      const again = await service.command(scope, created.run.run_id, {
        command_id: "cmd-2",
        expected_revision: "0",
        kind: "cancel",
      });
      expect(again.status).toBe("cancel_requested");
    });

    test("events append in seq order and read back through the pinned login", async () => {
      const scope = await issuedScope(USER);
      const created = await service.createE1({
        scope,
        key: "idem-7",
        request: REQUEST,
      });
      const runId = created.run.run_id;
      await service.appendEvent({
        tenantId: TENANT,
        runId,
        attemptId: created.invocation!.attempt_id,
        turnId: created.invocation!.turn_id,
        sourceEventId: "evt-go-1",
        sourceDigest: sha256("one"),
        eventType: "run.started",
        payload: { type: "RUN_STARTED" },
      });
      await service.appendEvent({
        tenantId: TENANT,
        runId,
        attemptId: created.invocation!.attempt_id,
        turnId: created.invocation!.turn_id,
        sourceEventId: "evt-go-2",
        sourceDigest: sha256("two"),
        eventType: "run.succeeded",
        payload: { type: "RUN_FINISHED" },
      });
      await service.markTerminal({
        tenantId: TENANT,
        runId,
        status: "succeeded",
      });

      const events = await service.readEventsPinned({
        tenantId: TENANT,
        runId,
        after: 0,
        limit: 10,
      });
      expect(events.map((event) => event.type)).toEqual([
        "run.started",
        "run.succeeded",
      ]);
      expect(events[0]?.payload).toEqual({ type: "RUN_STARTED" });
      const view = await service.get(scope, runId);
      expect(view.status).toBe("succeeded");
    });

    test("a foreign principal cannot even see the run", async () => {
      const scope = await issuedScope(USER);
      const created = await service.createE1({
        scope,
        key: "idem-8",
        request: REQUEST,
      });
      const stranger = await issuedScope("e1lite-user-2");
      await expect(
        service.get(stranger, created.run.run_id),
      ).rejects.toMatchObject({
        status: 404,
      });
    });
  });
}
