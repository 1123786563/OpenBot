import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { mcpServers, users } from "../src/db/schema";
import { createCorsairCutover } from "../src/plugins/corsair/cutover";
import { createCorsairReadinessRoutes } from "../src/plugins/corsair/readiness";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 4 });
afterAll(() => database.$client.close());

test("cleanup reconciles remote-only grants and requires both proofs before retirement", async () => {
  const workspaceId = randomUUID();
  const cutover = createCorsairCutover(database, {
    workspaceId,
    app: "github",
  });
  const routes = createCorsairReadinessRoutes({
    database,
    workspaceId,
    registrations: {},
    includeDeploymentLegacy: true,
    requireUser: async (c, next) => {
      c.set("actor", {
        id: "cleanup-admin",
        email: "cleanup-admin@example.test",
        role: "admin",
      });
      await next();
    },
  });
  const path = "/github/legacy-cleanup/composio";
  const post = (body: object) =>
    routes.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenBot-Pilot": "github",
      },
      body: JSON.stringify(body),
    });
  const inventory = {
    kind: "inventory",
    evidenceRef: "broker-inventory",
    entries: [{ ref: "remote-only", impact: ["shared-installation"] }],
  };
  await cutover.activate("cleanup-admin", async () => []);
  expect((await post(inventory)).status).toBe(409);
  await database.execute(sql`insert into audit_events (event_type, target_type, target_id, payload, created_at)
    values ('corsair.migration_route_changed', 'corsair_migration_scope', ${JSON.stringify([workspaceId, "github"])},
      '{"kind":"observing","until":"2000-01-01T00:00:00.000Z","excluded":[]}', clock_timestamp())`);
  await cutover.beginCleanup(
    "cleanup-admin",
    { evidenceRef: "cutover-accepted" },
    async () => true,
  );
  expect((await post(inventory)).status).toBe(200);
  const request = {
    kind: "requested",
    ref: "remote-only",
    evidenceRef: "receipt-1",
  };
  expect((await post(request)).status).toBe(409);
  expect(
    (
      await post({
        kind: "confirm_impact",
        ref: "remote-only",
        impact: ["shared-installation"],
        evidenceRef: "owner-approval",
      })
    ).status,
  ).toBe(200);
  expect((await post(request)).status).toBe(200);
  expect(
    (
      await post({
        kind: "query_failed",
        ref: "remote-only",
        evidenceRef: "timeout",
      })
    ).status,
  ).toBe(200);
  expect(
    (await post({ ...request, evidenceRef: "retry-receipt" })).status,
  ).toBe(200);
  expect(await (await routes.request(path)).json()).toMatchObject({
    entries: [{ ref: "remote-only", status: "pending" }],
  });
  /*
   * RETIREMENT READS THE WHOLE DEPLOYMENT (`includeDeploymentLegacy`): one legacy Composio row
   * anywhere keeps it at 409. Files that ran earlier in this database leave theirs behind, so what
   * is not this test's goes before the answer below is read; the Slack dependency stands in for it.
   */
  await database.execute(
    sql`delete from brokered_connections where provider = 'composio'`,
  );
  await database.execute(
    sql`delete from brokered_accounts where provider = 'composio'`,
  );
  await database.execute(sql`delete from composio_connections`);
  await database.execute(
    sql`delete from mcp_servers where starts_with(lower(url), 'composio://')`,
  );
  const retire = {
    kind: "prepare_retirement",
    dependencyEvidenceRef: "dependency-review",
  };
  expect((await post(retire)).status).toBe(409);
  expect(
    (
      await post({
        kind: "verify",
        ref: "remote-only",
        source: "broker",
        accessEvidenceRef: "access-denied",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post({
        kind: "verify",
        ref: "remote-only",
        source: "external_admin",
        verifierRef: "owner",
        accessEvidenceRef: "access-denied",
        refreshEvidenceRef: "refresh-denied",
      })
    ).status,
  ).toBe(200);
  const dependencyId = randomUUID();
  await database.insert(mcpServers).values({
    id: dependencyId,
    title: "Legacy Slack dependency",
    vendor: "Slack",
    provenance: "composio",
    url: "composio://slack",
    authScheme: "OAUTH2",
  });
  try {
    expect((await post(retire)).status).toBe(409);
  } finally {
    await database.delete(mcpServers).where(eq(mcpServers.id, dependencyId));
  }
  const prepared = await post(retire);
  expect(prepared.status).toBe(200);
  const { evidence } = await prepared.json();
  expect(
    (
      await post({
        ...retire,
        kind: "retire",
        evidenceRef: "credential-disabled",
        preparationRef: evidence.at(-1).id,
      })
    ).status,
  ).toBe(200);
  expect(await (await routes.request(path)).json()).toMatchObject({
    retired: { evidenceRef: "credential-disabled" },
    entries: [{ ref: "remote-only", status: "verified" }],
  });
});

test("mounted legacy connection routes refuse late returns and retain incomplete attempts", async () => {
  const workspaceId = randomUUID();
  const actor = {
    id: randomUUID(),
    email: "late@example.test",
    role: "admin",
  } as const;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    c.set("actor", actor);
    await next();
  };
  const serverId = randomUUID();
  const scope = { workspaceId, app: "slack", provider: "arcade" } as const;
  const store = createPluginStore({
    database,
    deploymentId: workspaceId,
    brokerProvider: "arcade",
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(database),
    encryptionKey: `${"A".repeat(43)}=`,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  });
  const plugins = createPluginRoutes(store, requireUser, async () => true);
  const cutover = createCorsairCutover(database, scope);
  const migration = createCorsairReadinessRoutes({
    database,
    workspaceId,
    registrations: {},
    includeDeploymentLegacy: true,
    requireUser,
  });
  try {
    await database
      .insert(users)
      .values({ id: actor.id, name: "Late", email: actor.email });
    await database.insert(mcpServers).values({
      id: serverId,
      title: "Legacy Slack",
      vendor: "Slack",
      provenance: "arcade",
      url: "arcade://slack",
      authScheme: "OAUTH2",
    });
    await store.claimAuthorizationAttempt({
      actorId: actor.id,
      serverId,
      action: null,
      account: {
        holder: "person",
        userId: actor.id,
        vendorUserId: "fixture-legacy-user",
      },
    });
    await database.execute(sql`
      update pending_authorizations set created_at = now() - interval '1 day' where actor_id = ${actor.id}
    `);
    await cutover.activate(actor.id, async () => []);
    for (const path of [
      "connect",
      "authorize",
      "connection/confirm",
      "connection/recheck",
    ]) {
      expect(
        (
          await plugins.request(`/servers/${serverId}/${path}`, {
            method: "POST",
          })
        ).status,
      ).toBe(409);
    }
    const callback = "/arcade/verify?flow_id=opaque-fixture-handle";
    expect((await plugins.request(callback)).status).toBe(303);
    expect((await plugins.request(callback)).status).toBe(303);
    const response = await migration.request("/slack/legacy-cleanup/arcade");
    expect(response.status).toBe(200);
    const state = await response.json();
    const actorEntries = state.entries.filter(
      (item: { local: { parts: string[] } }) =>
        item.local.parts.includes(actor.id),
    );
    expect(
      actorEntries
        .map((item: { local: { kind: string } }) => item.local.kind)
        .sort(),
    ).toEqual(["attempt", "late_callback", "late_callback"]);
    expect(JSON.stringify(state)).not.toContain("opaque-fixture-handle");
    expect(
      actorEntries.every((item: { ref: string }) =>
        state.unreconciledRefs.includes(item.ref),
      ),
    ).toBe(true);
  } finally {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database.delete(users).where(eq(users.id, actor.id));
  }
});
