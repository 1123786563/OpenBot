/**
 * MT053/MT054 (Issues #96/#97) craft-tenancy fixture support.
 *
 * Wraps the MT027 credentials-ownership fixture (which itself wraps the MT008
 * resource-policy base and the MT002 isolation fixture: two companies, three
 * teams, real provisioning, real restricted roles, real scope issuance) and
 * adds exactly the arrangements the craft tenancy suites need:
 *
 *   - the real craft stores (sessions + scheduled tasks) over the same
 *     dedicated enterprise test database — session/task/message/snapshot rows
 *     are created through the production store paths, never inserted raw;
 *   - the MT053 `createCraftSessionsService` and MT054
 *     `createCraftSchedulesService` under test, wired to the REAL MT041 job
 *     ownership service and the REAL MT029 credential lease service (issue +
 *     validate + admin revoke) — no stand-ins on any decision path;
 *   - a machine identity minted through the MT042-style issuance entry and the
 *     schedule-entrypoint scope issuance adapter (real createScopeResolver
 *     behind it — the service never constructs scopes itself);
 *   - a memory object store for snapshot bytes and an epoch-bumping company
 *     suspension stand-in for revocation (disclosed, same as MT027's).
 *
 * Disposal rides the base chain (fixture users cascade-delete their craft
 * rows; the association tables cascade from craft_sessions / their FK chain).
 */

import { randomUUID } from "node:crypto";
import {
  type CraftScheduledTaskStore,
  createCraftScheduledTaskStore,
} from "../../../src/craft/scheduled-tasks";
import { type CraftStore, createCraftStore } from "../../../src/craft/store";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type CraftSchedulesService,
  createCraftSchedulesService,
  issueCraftScheduleMachineIdentity,
} from "../../../src/enterprise/tenancy/craft-schedules";
import {
  type CraftSessionsService,
  createCraftSessionsService,
} from "../../../src/enterprise/tenancy/craft-sessions";
import {
  type CredentialLeaseAdminService,
  type CredentialLeaseService,
  createCredentialLeaseAdminService,
  createCredentialLeaseService,
} from "../../../src/enterprise/tenancy/credential-lease";
import {
  createJobOwnershipService,
  type JobOwnershipService,
} from "../../../src/enterprise/tenancy/job-ownership";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  type CredentialsFixture,
  createCredentialsFixture,
  type MemoryVault,
} from "./credentials-ownership";
import type { FixtureIdentity } from "./fixture";
import type { TeamKey } from "./resource-policy";

/** Memory object store: snapshot bytes keyed by storage path (probe-able). */
export class MemoryObjectStore {
  private readonly blobs = new Map<string, Uint8Array>();
  readonly reads: string[] = [];

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    this.reads.push(key);
    const blob = this.blobs.get(key);
    if (blob === undefined) throw new Error("OBJECT_STORE_MISS");
    return blob;
  }

  readCount(): number {
    return this.reads.length;
  }
}

export interface CraftTenancyFixture {
  readonly base: CredentialsFixture;
  /** Real craft session store (platform channel, production store path). */
  readonly craft: CraftStore;
  /** Real craft scheduled-task store (platform channel, production path). */
  readonly schedules: CraftScheduledTaskStore;
  /** MT053 service under test. */
  readonly sessions: CraftSessionsService;
  /** MT054 service under test. */
  readonly craftSchedules: CraftSchedulesService;
  /** MT041 job ownership/lease service (real). */
  readonly jobs: JobOwnershipService;
  /** MT029 lease services (real): validate on the trigger path. */
  readonly leases: CredentialLeaseService;
  readonly leaseAdmin: CredentialLeaseAdminService;
  /** Snapshot object store (memory; read-probing for AC2 evidence). */
  readonly objectStore: MemoryObjectStore;
  /** MT042-style machine identity for trigger rebuild. */
  readonly machine: object;
  /** Issue a real trusted scope for one identity in one team. */
  scopeAs(identity: FixtureIdentity, teamKey: TeamKey): Promise<PlatformScope>;
  /** Schedule-entrypoint issuance adapter (real resolver behind it). */
  issueScheduleScope(facts: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
  }): Promise<PlatformScope>;
  /** Registers a personal credential + issues a connector-call lease for it. */
  provisionPersonalCredentialWithLease(input: {
    readonly owner: FixtureIdentity;
    readonly team: TeamKey;
    readonly target: string;
    readonly plaintext: string;
  }): Promise<{
    readonly credentialId: string;
    readonly leaseId: string;
  }>;
  /** Registers a personal credential WITHOUT a lease (lease-denied probes). */
  provisionPersonalCredential(input: {
    readonly owner: FixtureIdentity;
    readonly team: TeamKey;
    readonly target: string;
    readonly plaintext: string;
  }): Promise<{ readonly credentialId: string }>;
  /** Epoch-bumping company suspension stand-in (superuser, disclosed). */
  suspendCompany(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
  ): Promise<void>;
  /** The shared memory vault (sealed envelopes carry the plaintext verbatim). */
  readonly vault: MemoryVault;
  dispose(): Promise<void>;
}

export async function createCraftTenancyFixture(): Promise<CraftTenancyFixture> {
  const base = await createCredentialsFixture();
  const platformUrl = enterpriseTestDatabaseUrlFrom();
  const platform: Database = createDatabase(platformUrl, { max: 2 });
  const craft = createCraftStore(platform);
  const scheduleStore = createCraftScheduledTaskStore(platform);
  const objectStore = new MemoryObjectStore();

  const jobs = createJobOwnershipService(base.base.operator, base.base.data);
  const leases = createCredentialLeaseService(base.base.data);
  const leaseAdmin = createCredentialLeaseAdminService(base.base.operator);

  const machine = issueCraftScheduleMachineIdentity();

  // Schedule-entrypoint issuance adapter: the service hands over the
  // association-row facts; the adapter resolves the identity behind actorId
  // (fixture-fact lookup) and goes through the REAL resolver — the service
  // never constructs scopes itself, and the eligibility gate still applies.
  const identityByUserId = new Map<string, FixtureIdentity>();
  for (const [identity, fact] of Object.entries(
    base.base.isolation.identities,
  )) {
    if (fact.userId)
      identityByUserId.set(fact.userId, identity as FixtureIdentity);
  }
  const issueScheduleScope = async (facts: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
  }) => {
    const identity = identityByUserId.get(facts.actorId);
    if (!identity) throw new Error("SCHEDULE_IDENTITY_UNRESOLVED");
    return base.base.scopeFor(identity, {
      tenantId: facts.tenantId,
      workspaceId: facts.workspaceId,
    });
  };

  const sessions = createCraftSessionsService({
    data: base.base.data,
    operator: base.base.operator,
    rows: {
      findSession: (sessionId, userId) => craft.findSession(sessionId, userId),
      findSessionById: (sessionId) => craft.findSessionById(sessionId),
      findSessionsByIds: (sessionIds) => craft.findSessionsByIds(sessionIds),
      updateSession: (sessionId, patch) =>
        craft.updateSession(sessionId, patch),
      deleteSession: (sessionId, userId) =>
        craft.deleteSession(sessionId, userId),
      getMessages: (sessionId) => craft.getMessages(sessionId),
      listSnapshots: (sessionId) => craft.listSnapshots(sessionId),
    },
    objectStore,
  });

  const craftSchedules = createCraftSchedulesService({
    data: base.base.data,
    operator: base.base.operator,
    rows: {
      getTask: (id, userId) => scheduleStore.getTask(id, userId),
      getTaskById: (id) => scheduleStore.getTaskById(id),
      softDeleteTask: (id, userId) => scheduleStore.softDeleteTask(id, userId),
      updateTask: (id, patch) => scheduleStore.updateTask(id, patch),
      listTasks: (userId) => scheduleStore.listTasks(userId),
    },
    jobs,
    leases,
    issueScheduleScope,
  });

  const fixture: CraftTenancyFixture = {
    base,
    craft,
    schedules: scheduleStore,
    sessions,
    craftSchedules,
    jobs,
    leases,
    leaseAdmin,
    objectStore,
    machine,
    vault: base.vault,
    async scopeAs(identity, teamKey) {
      const fact = base.base.teamOf(identity, teamKey);
      return base.base.scopeFor(identity, {
        tenantId: fact.tenantId,
        workspaceId: fact.workspaceId,
      });
    },
    issueScheduleScope,
    async provisionPersonalCredential({ owner, team, target, plaintext }) {
      const fact = await base.provisionCredential({
        kind: "connection",
        classification: "personal",
        owner,
        team,
        target,
        label: `craft-conn-${randomUUID().slice(0, 8)}`,
        plaintext,
      });
      return { credentialId: fact.credentialId };
    },
    async provisionPersonalCredentialWithLease(input) {
      const { credentialId } = await fixture.provisionPersonalCredential(input);
      const scope = await fixture.scopeAs(input.owner, input.team);
      const lease = await leases.issue(scope, {
        credentialId,
        purpose: "connector-call",
      });
      if (!("outcome" in lease) || lease.outcome !== "allow") {
        throw new Error(`LEASE_ISSUE_DENIED: ${JSON.stringify(lease)}`);
      }
      return { credentialId, leaseId: lease.leaseId };
    },
    async suspendCompany(identity, companyKey) {
      await base.setCompanyMembershipStatus(identity, companyKey, "suspended");
    },
    async dispose() {
      // Craft rows cascade from their fixture users; the base chain removes
      // them. Belt-and-braces: drop any association rows whose session/task
      // objects outlived their users (defensive, keeps the shared DB clean).
      await platform.$client
        .unsafe(
          "delete from enterprise_craft_scopes where session_id like 'cs-%'",
        )
        .catch(() => {});
      await platform.$client
        .unsafe(
          "delete from enterprise_craft_schedule_scopes where object_id like 'cst-%' or object_id like 'mt054-%'",
        )
        .catch(() => {});
      await platform.$client.close().catch(() => {});
      await base.dispose();
    },
  };

  return fixture;
}
