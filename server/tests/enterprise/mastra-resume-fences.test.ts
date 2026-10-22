import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { Database } from "../../src/db/client";
import { users } from "../../src/db/schema";
import {
  enterpriseRunAttempts,
  enterpriseRuns,
} from "../../src/db/schema/enterprise-runs";
import { enterpriseWorkspaceMemberships } from "../../src/db/schema/enterprise-tenancy";
import type {
  PlatformScope,
  RunnerRequestLease,
} from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { messageDigest } from "../../src/enterprise/conversations/store";
import { ExpertVersionCatalog } from "../../src/enterprise/experts/version-catalog";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import { createRunService } from "../../src/enterprise/runs/service";
import {
  createRunStore,
  RunDomainError,
} from "../../src/enterprise/runs/store";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { MastraContinuationRefusal } from "../../src/mastra/continuation-store";
import { tenantStorageKey } from "../../src/mastra/contracts";
import { assertResumeBindingCurrent } from "../../src/mastra/headless";
import { createTenantMastraStorage } from "../../src/mastra/tenant-storage";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME09 fix round 1 — the REAL-PG fence suite for the runs-service surface the
 * durable resume stands on (`markRunSuspended` and
 * `reactivateSuspensionLease`) plus the production wiring's binding-currency
 * gate, driven by facts the real store produced. The disposable me03-style
 * fixture (control plane in ONE database, dropped in teardown) is the same
 * one the governed routines suite uses; every service here is the production
 * instance. What is pinned:
 *
 *  - `markRunSuspended` moves queued/running → waiting ONLY under the exact
 *    live request lease (wrong owner token, expired owner window, expired
 *    attempt, or a run that already left queued/running all refuse false).
 *  - `reactivateSuspensionLease` re-arms ONLY a run still waiting at its
 *    current attempt: a queued run and a settled run refuse RUN_NOT_ACTIVE,
 *    a live request owner refuses RUN_REQUEST_LEASE_HELD (also under
 *    concurrent reactivation — one driver at a time), and the re-armed lease
 *    is capped by the run's createdAt + MAXIMUM_RUN_DURATION (15 min), past
 *    which it refuses RUN_LEASE_EXPIRED.
 *  - The re-activation returns the run's OWN admitted execution facts (the
 *    stored modelRouteRef and ceiling — the API accepts no caller-supplied
 *    route), and the wrapper's binding-currency gate refuses a continuation
 *    whose bound attempt is no longer the re-activated one.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const CEILING = 1024;
const ROUTE: ModelRouteSnapshotInput = {
  agentId: "me09-fence-bot",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me09-fence-tenant-${suffix}`;
const workspaceA = `me09-fence-workspace-${suffix}`;
const ownerActor = `me09-fence-actor-${suffix}`;
const ownerPrincipal = `me09-fence-principal-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let data: Awaited<ReturnType<Me03Fixture["openData"]>>;
let runs: ReturnType<typeof createRunService>;
let runStore: ReturnType<typeof createRunStore>;
let scope: PlatformScope;
let admittedRoute: ReturnType<typeof canonicalizeModelRouteSnapshot>;
let expertVersions: ExpertVersionCatalog;
let runSeq = 0;
let conversations: ReturnType<typeof createConversationService>;

/*
 * The schedule-entrypoint scope shape the governed resume runs under: a
 * fresh Request bound to the owner, resolved by the directory (the
 * conversation row decides tenant/workspace/principal).
 */
const identities = new WeakMap<Request, string>();

async function admittedRun(label: string): Promise<{
  runId: string;
  lease: RunnerRequestLease;
  attemptId: string;
  generation: number;
}> {
  runSeq += 1;
  // ONE ACTIVE RUN PER THREAD: every fence probe runs on its OWN
  // conversation, so a parked (suspended) run from an earlier test never
  // blocks a later admission.
  const conversation = await conversations.getOrCreate(scope, {
    title: `ME09 fence ${label} ${runSeq}`,
  });
  const runThreadId = conversation.thread_id;
  const clientMessageKey = `me09-fence-${label}-${runSeq}-${suffix}`;
  const content = `fence probe ${clientMessageKey}`;
  await conversations.append(scope, {
    threadId: runThreadId,
    clientMessageKey,
    content,
    attachments: [],
  });
  const expertVersionRef = await expertVersions.putOrGet(scope, {
    schemaVersion: 1,
    agentId: "me09-fence-bot",
    source: "tenant_package",
    agentType: "built_in",
    systemPrompt: "Fence probe bot.",
    behaviorVersion: "openbot-routine-v1",
  });
  const run = await runs.start(scope, {
    input: {
      threadId: runThreadId,
      clientMessageKey,
      messageDigest: messageDigest(content, []).digest,
      attachmentRefs: [],
      entrypoint: scope.entrypoint,
      forwardedProps: { maxOutputTokens: CEILING },
    },
    agentId: "me09-fence-bot",
    expertVersionRef,
    routeRef: admittedRoute.routeRef,
  });
  const lease = await runs.acquireRequestLease(scope, run.run_id);
  return {
    runId: run.run_id,
    lease,
    attemptId: lease.attemptId,
    generation: lease.generation,
  };
}

async function runRow(runId: string) {
  const [row] = await admin
    .select()
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.id, runId))
    .limit(1);
  return row ?? null;
}

async function attemptRow(attemptId: string) {
  const [row] = await admin
    .select()
    .from(enterpriseRunAttempts)
    .where(eq(enterpriseRunAttempts.id, attemptId))
    .limit(1);
  return row ?? null;
}

beforeAll(async () => {
  fixture = await createMe03Fixture();
  admin = fixture.openDatabase(fixture.adminUrl);
  data = await fixture.openData();
  const directory = await fixture.openDirectory();

  const provisioner = fixture.provisioner();
  await provisioner.provision({
    tenantId: tenantA,
    storageKey: tenantStorageKey(tenantA),
    roleVersion: 1,
  });
  await admin.insert(users).values({
    id: ownerActor,
    email: `${ownerActor}@example.invalid`,
    name: "ME09 fence owner",
  });
  const { enterprisePrincipals } = await import(
    "../../src/db/schema/enterprise-tenancy"
  );
  await admin
    .insert(enterprisePrincipals)
    .values({ id: ownerPrincipal, userId: ownerActor });
  const operator = await fixture.openOperator();
  const { provisionDeployment } = await import(
    "../../src/enterprise/tenancy/provision"
  );
  await provisionDeployment(operator, {
    operationId: `me09-fence-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME09 fence tenant" },
    workspace: { id: workspaceA, name: "ME09 fence workspace" },
    members: [
      { principalId: ownerPrincipal, userId: ownerActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  // MT005: the workspace-membership row is the resolver's team-eligibility
  // fact (the routines suite's precedent).
  await admin.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: tenantA,
      workspaceId: workspaceA,
      principalId: ownerPrincipal,
    },
  ]);

  const storage = createTenantMastraStorage(fixture.lookup());
  conversations = createConversationService({ data, mastraStorage: storage });
  // The first scope selects the fixture's tenant/workspace; the conversation
  // is created under it and every later run reuses the thread.
  const resolver = createScopeResolver(directory, {
    data,
    authenticate: async (request) => {
      const actor = identities.get(request);
      return actor ? { actorId: actor, entrypoint: "schedule" } : null;
    },
    selectTenant: () => tenantA,
    selectWorkspace: () => workspaceA,
  });
  const probe = new Request("https://me09-fence.invalid/probe");
  identities.set(probe, ownerActor);
  scope = await resolver.resolve(probe);

  admittedRoute = canonicalizeModelRouteSnapshot(scope.tenantId, ROUTE, SECRET);
  expertVersions = new ExpertVersionCatalog(data);
  runs = createRunService({
    data,
    conversations,
    expertVersions,
    modelRouteFor: async () => ({
      routeRef: admittedRoute.routeRef,
      maximumTokens: CEILING,
    }),
    modelCapabilitySecret: SECRET,
  });
  runStore = createRunStore(data);
}, 240_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    await fixture?.drop();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "ME09 fence fixture teardown failed");
  }
});

test("markRunSuspended_holds_the_exact_live_lease_and_refuses_a_wrong_owner_token", async () => {
  const admitted = await admittedRun("owner");
  // A fabricated lease naming another (valid-uuid) owner fences out: no row
  // moves.
  const impostor: RunnerRequestLease = {
    ...admitted.lease,
    ownerToken: randomUUID(),
  };
  await expect(
    runs.markRunSuspended(scope, { lease: impostor, status: "suspended" }),
  ).resolves.toBe(false);
  expect((await runRow(admitted.runId))?.status).toBe("queued");
  // The exact lease the driver holds moves the run to the waiting status.
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  expect((await runRow(admitted.runId))?.status).toBe("suspended");
  // The run PARKED ACTIVE: the attempt is untouched, so the resume keeps
  // minting against the same attempt.
  const attempt = await attemptRow(admitted.attemptId);
  expect(attempt?.status).toBe("active");
}, 120_000);

test("markRunSuspended_refuses_a_lease_whose_owner_window_has_expired", async () => {
  const admitted = await admittedRun("expired-owner");
  // The owner window lapsed on the attempt: the same lease object is no
  // longer a live owner, so the fence refuses.
  await admin
    .update(enterpriseRunAttempts)
    .set({ requestOwnerExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(enterpriseRunAttempts.id, admitted.attemptId));
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(false);
  expect((await runRow(admitted.runId))?.status).toBe("queued");
}, 120_000);

test("markRunSuspended_refuses_a_lease_whose_attempt_is_no_longer_active", async () => {
  const admitted = await admittedRun("dead-attempt");
  // The scheduler expired the lease: the old attempt is gone (a new
  // generation exists), so the held lease fences out. The expiry clock is
  // pushed past the run's own lease the way the runs suite drives it.
  await runStore.expireLease(
    scope,
    admitted.runId,
    new Date(Date.now() + 60_000),
  );
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(false);
  expect((await runRow(admitted.runId))?.status).toBe("queued");
}, 120_000);

test("markRunSuspended_refuses_a_run_that_already_left_queued_running", async () => {
  const admitted = await admittedRun("twice");
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  // The run is waiting now: a second transition from the same lease refuses.
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(false);
  expect((await runRow(admitted.runId))?.status).toBe("suspended");
}, 120_000);

test("reactivateSuspensionLease_refuses_a_run_that_is_not_waiting_or_is_terminal", async () => {
  const fresh = await admittedRun("not-waiting");
  // A queued (never-waiting) run has no suspension to re-arm.
  let thrown: unknown;
  try {
    await runs.reactivateSuspensionLease(scope, fresh.runId);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RunDomainError);
  expect((thrown as RunDomainError).code).toBe("RUN_NOT_ACTIVE");

  // And a run that settled terminal refuses the same way: the settled-run
  // capability fence stays authoritative.
  const settled = await admittedRun("settled");
  await expect(
    runs.markRunSuspended(scope, {
      lease: settled.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  await runStore.transitionTerminal(scope, {
    runId: settled.runId,
    attemptId: settled.attemptId,
    generation: settled.generation,
    status: "succeeded",
  });
  let terminalThrown: unknown;
  try {
    await runs.reactivateSuspensionLease(scope, settled.runId);
  } catch (error) {
    terminalThrown = error;
  }
  expect(terminalThrown).toBeInstanceOf(RunDomainError);
  expect((terminalThrown as RunDomainError).code).toBe("RUN_NOT_ACTIVE");
}, 120_000);

test("reactivateSuspensionLease_refuses_a_live_request_owner", async () => {
  const admitted = await admittedRun("live-owner");
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  // The pausing driver's lease is STILL live: one driver at a time.
  let thrown: unknown;
  try {
    await runs.reactivateSuspensionLease(scope, admitted.runId);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RunDomainError);
  expect((thrown as RunDomainError).code).toBe("RUN_REQUEST_LEASE_HELD");
  expect((thrown as RunDomainError).status).toBe(409);
}, 120_000);

test("concurrent_reactivations_admit_exactly_one_driver", async () => {
  const admitted = await admittedRun("race");
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  // Two drivers race the released suspension (the claim-takeover shape):
  // exactly one re-arms; the other refuses RUN_REQUEST_LEASE_HELD — the
  // pre-check/CAS fence, whichever arm observes the winner.
  await expect(runs.releaseRequestLease(scope, admitted.lease)).resolves.toBe(
    true,
  );
  const settled = await Promise.allSettled([
    runs.reactivateSuspensionLease(scope, admitted.runId),
    runs.reactivateSuspensionLease(scope, admitted.runId),
  ]);
  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  const rejected = settled.filter(
    (s) => s.status === "rejected",
  ) as PromiseRejectedResult[];
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toBeInstanceOf(RunDomainError);
  expect((rejected[0].reason as RunDomainError).code).toBe(
    "RUN_REQUEST_LEASE_HELD",
  );
}, 120_000);

test("reactivateSuspensionLease_honors_the_maximum_run_duration_cap", async () => {
  const admitted = await admittedRun("cap");
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  await expect(runs.releaseRequestLease(scope, admitted.lease)).resolves.toBe(
    true,
  );
  // A run created beyond the maximum run duration can re-arm NOTHING: the
  // cap mints an already-expired lease, which refuses by name.
  await admin
    .update(enterpriseRuns)
    .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
    .where(eq(enterpriseRuns.id, admitted.runId));
  let thrown: unknown;
  try {
    await runs.reactivateSuspensionLease(scope, admitted.runId);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RunDomainError);
  expect((thrown as RunDomainError).code).toBe("RUN_LEASE_EXPIRED");
  // The refusal left the run waiting — an isolation, not a settlement.
  expect((await runRow(admitted.runId))?.status).toBe("suspended");
}, 120_000);

test("reactivation_re_arms_the_same_attempt_with_the_runs_own_route_facts", async () => {
  const admitted = await admittedRun("facts");
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  await expect(runs.releaseRequestLease(scope, admitted.lease)).resolves.toBe(
    true,
  );
  const reactivated = await runs.reactivateSuspensionLease(
    scope,
    admitted.runId,
  );
  // SAME attempt, SAME generation: the resume premise — a re-arm, never a
  // re-opened attempt (which would move the generation the continuation
  // binds).
  expect(reactivated.lease.runId).toBe(admitted.runId);
  expect(reactivated.lease.attemptId).toBe(admitted.attemptId);
  expect(reactivated.lease.generation).toBe(admitted.generation);
  expect(reactivated.lease.ownerToken).toBeTruthy();
  expect(reactivated.lease.ownerToken).not.toBe(admitted.lease.ownerToken);
  expect(reactivated.lease.expiresAt.getTime()).toBeGreaterThan(Date.now());
  // The run's OWN admitted facts — read back from the row, and equal to
  // what admission stored (the API accepts no caller-supplied route).
  const row = await runRow(admitted.runId);
  expect(row?.modelRouteRef).toBe(admittedRoute.routeRef);
  expect(reactivated.modelRouteRef).toBe(row?.modelRouteRef);
  expect(reactivated.maximumTokens).toBe(row?.modelRouteMaximumTokens);
  expect(reactivated.maximumTokens).toBe(CEILING);
}, 120_000);

test("a_continuation_bound_to_a_moved_attempt_refuses_the_reactivated_lease", async () => {
  const admitted = await admittedRun("stale-binding");
  await expect(
    runs.markRunSuspended(scope, {
      lease: admitted.lease,
      status: "suspended",
    }),
  ).resolves.toBe(true);
  await expect(runs.releaseRequestLease(scope, admitted.lease)).resolves.toBe(
    true,
  );
  // The scheduler expired the lease while the run waited: the run is STILL
  // suspended, but its current attempt moved (generation + 1).
  await runStore.expireLease(
    scope,
    admitted.runId,
    new Date(Date.now() + 60_000),
  );
  const reactivated = await runs.reactivateSuspensionLease(
    scope,
    admitted.runId,
  );
  expect(reactivated.lease.generation).toBeGreaterThan(admitted.generation);
  // The production wiring's gate (index.ts, ONE definition extracted to
  // headless.ts): a continuation binding the OLD attempt refuses by name.
  let thrown: unknown;
  try {
    assertResumeBindingCurrent(reactivated, {
      attemptId: admitted.attemptId,
      generation: admitted.generation,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MastraContinuationRefusal);
  expect((thrown as MastraContinuationRefusal).code).toBe(
    "MASTRA_CONTINUATION_GENERATION_STALE",
  );
  // A continuation binding the CURRENT re-activated attempt passes the gate.
  expect(() =>
    assertResumeBindingCurrent(reactivated, {
      attemptId: reactivated.lease.attemptId,
      generation: reactivated.lease.generation,
    }),
  ).not.toThrow();
}, 120_000);
