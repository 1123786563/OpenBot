/**
 * MT055–MT058 (Issues #98/#99/#100/#101) workshop-tenancy fixture support.
 *
 * Wraps the MT027 credentials-ownership fixture (which itself wraps the MT008
 * resource-policy base and the MT002 isolation fixture: two companies, three
 * teams, real provisioning, real restricted roles, real scope issuance) and
 * adds exactly the arrangements the four workshop-domain suites need:
 *
 *   - the real workshop store over the same dedicated enterprise test
 *     database — session/turn/artifact rows are created through the
 *     production store paths, never inserted raw;
 *   - real channel + built_in bot rows for the workshop_sessions double FK
 *     (the mt136 arrangement pattern), real sandbox_instances rows for the
 *     MT057 binding face;
 *   - the four services under test, wired to each other the way the wiring
 *     tickets will wire them: artifactStorage (MT055) + attachments (MT024,
 *     the real service over the same restricted channels) + workshopScope
 *     (MT057) + shareTokens (MT058, injected as the MT057 share-resolution
 *     port) + signedDownload (MT056, one signing key across all families);
 *   - a memory object store for artifact bytes, a recording recycle port,
 *     and a recording invalidation-audit sink.
 *
 * Disposal rides the base chain (fixture users cascade-delete their workshop
 * rows; the association tables cascade from workshop_sessions/sandbox_
 * instances). Belt-and-braces deletes run for any rows that outlived their
 * users (keeps the shared DB clean).
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { agents, channels } from "../../../src/db/schema/core";
import { sandboxInstances } from "../../../src/db/schema/sandbox-instances";
import { workshopArtifacts } from "../../../src/db/schema/workshop";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type ArtifactStorageService,
  createArtifactStorageService,
  enterpriseWorkshopArtifactObjectKey,
} from "../../../src/enterprise/tenancy/artifact-storage";
import {
  type AttachmentService,
  createAttachmentService,
} from "../../../src/enterprise/tenancy/attachments";
import {
  createWorkshopShareService,
  type WorkshopShareService,
} from "../../../src/enterprise/tenancy/share-tokens";
import {
  createWorkshopScopeService,
  type WorkshopScopeService,
} from "../../../src/enterprise/tenancy/workshop-scope";
import {
  createWorkshopStore,
  type WorkshopStore,
} from "../../../src/workshop/store";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  type CredentialsFixture,
  createCredentialsFixture,
} from "./credentials-ownership";

import type { FixtureIdentity } from "./fixture";
import type { TeamKey } from "./resource-policy";

/** Artifact bytes store: put/get/delete over an in-memory map, with logs. */
export class MemoryArtifactStore {
  private readonly blobs = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  readonly deleted: string[] = [];
  readonly deletions: readonly string[] = this.deleted;

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    this.reads.push(key);
    const blob = this.blobs.get(key);
    if (blob === undefined) throw new Error("OBJECT_STORE_MISS");
    return blob;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.blobs.delete(key);
  }

  readCount(): number {
    return this.reads.length;
  }
}

/** One recorded recycle call (the physical port is a test double). */
export interface RecycleCall {
  readonly instanceId: string;
  readonly botId: string;
}

/** One recorded invalidation event (the audit sink is a test double). */
export interface ShareInvalidationEvent {
  readonly eventType: string;
  readonly sessionId: string;
  readonly channelId: string;
  readonly note: string;
}

export interface WorkshopTenancyFixture {
  readonly base: CredentialsFixture;
  /** Real workshop store (platform channel, production store path). */
  readonly workshop: WorkshopStore;
  readonly platform: Database;
  /** MT055 service under test. */
  readonly artifacts: ArtifactStorageService;
  /** Artifact bytes (memory; read/delete-probing for AC evidence). */
  readonly artifactStore: MemoryArtifactStore;
  /** MT024 attachment service over the same restricted channels (real). */
  readonly attachments: AttachmentService;
  /** MT057 service under test. */
  readonly workshopScopes: WorkshopScopeService;
  /** MT058 service under test. */
  readonly shareTokens: WorkshopShareService;
  /** Recording probes (test doubles for injected ports, disclosed). */
  readonly recycleCalls: readonly RecycleCall[];
  readonly invalidationEvents: readonly ShareInvalidationEvent[];
  readonly signingKey: string;
  /** Issue a real trusted scope for one identity in one team. */
  scopeAs(identity: FixtureIdentity, teamKey: TeamKey): Promise<PlatformScope>;
  /** The OpenBot global user id behind one fixture identity. */
  userIdOf(identity: FixtureIdentity): string;
  /** Real channel + built_in bot rows (workshop_sessions double FK). */
  ensureArrangement(channelId: string, botId: string): Promise<void>;
  /**
   * A real workshop session owned by one identity, created through the
   * production store and pinned into the identity's (company, team) scope.
   */
  ensurePinnedSession(input: {
    readonly owner: FixtureIdentity;
    readonly team: TeamKey;
    /** 显式复用既有 Bot（跨会话同 Bot 场景；缺省新种一个）。 */
    readonly botId?: string;
  }): Promise<{
    readonly channelId: string;
    readonly botId: string;
    readonly sessionId: string;
  }>;
  /** ensurePinnedSession + one artifact row + MT055 pin + stored bytes. */
  ensurePinnedArtifact(input: {
    readonly owner: FixtureIdentity;
    readonly team: TeamKey;
    readonly name?: string;
  }): Promise<{
    readonly channelId: string;
    readonly botId: string;
    readonly sessionId: string;
    readonly artifactId: string;
    readonly enterpriseKey: string;
  }>;
  /** A real sandbox_instances row (platform channel, owner = fixture user). */
  ensureSandboxInstance(input: {
    readonly botId: string;
    readonly owner: FixtureIdentity;
  }): Promise<string>;
  /** A legacy B14 anonymous share row on one session (AC3 sweep face). */
  seedLegacyAnonymousShare(input: {
    readonly channelId: string;
    readonly createdBy: FixtureIdentity;
  }): Promise<string>;
  /** Epoch-bumping company suspension (disclosed stand-in, MT053 same). */
  suspendCompany(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
  ): Promise<void>;
  dispose(): Promise<void>;
}

export async function createWorkshopTenancyFixture(): Promise<WorkshopTenancyFixture> {
  const base = await createCredentialsFixture();
  const platformUrl = enterpriseTestDatabaseUrlFrom();
  const platform: Database = createDatabase(platformUrl, { max: 2 });
  const workshop = createWorkshopStore(platform);

  const run = `mt28-${randomUUID().slice(0, 8)}`;
  const signingKey = `mt28-signing-${run}`;

  // Artifact bytes store (memory; read/delete-probing for AC evidence).
  const artifactStore = new MemoryArtifactStore();

  const recycleCalls: RecycleCall[] = [];
  const invalidationEvents: ShareInvalidationEvent[] = [];

  const identityUserIds = new Map<FixtureIdentity, string>();
  for (const [identity, fact] of Object.entries(
    base.base.isolation.identities,
  )) {
    if (fact.userId)
      identityUserIds.set(identity as FixtureIdentity, fact.userId);
  }
  const userIdOf = (identity: FixtureIdentity): string => {
    const userId = identityUserIds.get(identity);
    if (!userId) throw new Error(`MT28_IDENTITY_UNRESOLVED: ${identity}`);
    return userId;
  };

  const artifacts = createArtifactStorageService({
    data: base.base.data,
    operator: base.base.operator,
    rows: {
      findArtifactById: async (artifactId) => {
        const rowsFound = await platform
          .select()
          .from(workshopArtifacts)
          .where(eq(workshopArtifacts.id, artifactId))
          .limit(1);
        return rowsFound[0];
      },
      findSessionById: async (sessionId) => workshop.sessionById(sessionId),
      listArtifacts: (sessionId) => workshop.listArtifacts(sessionId),
      deleteArtifact: async (artifactId) => {
        const deletedRows = await platform
          .delete(workshopArtifacts)
          .where(eq(workshopArtifacts.id, artifactId))
          .returning({ id: workshopArtifacts.id });
        return deletedRows.length > 0;
      },
    },
    objectStore: artifactStore,
  });

  const attachments = createAttachmentService({
    data: base.base.data,
    operator: base.base.operator,
    signingKey,
  });

  const shareTokens = createWorkshopShareService({
    data: base.base.data,
    operator: base.base.operator,
    rows: {
      findSessionByChannel: (channelId) => workshop.sessionByChannel(channelId),
      findSessionById: (sessionId) => workshop.sessionById(sessionId),
      listSessionsWithLiveLegacyShare: async () => {
        const found = await platform.execute(
          sql`select id as "sessionId", channel_id as "channelId" from workshop_sessions where share_token_hash is not null and share_revoked_at is null and channel_id like ${`${run}-ch-%`}`,
        );
        const rowsOut = Array.isArray(found)
          ? found
          : ((found as { rows?: unknown[] }).rows ?? []);
        return rowsOut as {
          sessionId: string;
          channelId: string;
        }[];
      },
    },
    auditSink: {
      record: async (event) => {
        invalidationEvents.push({
          eventType: event.eventType,
          sessionId: event.sessionId,
          channelId: event.channelId,
          note: event.note,
        });
      },
    },
  });

  const workshopScopes = createWorkshopScopeService({
    data: base.base.data,
    operator: base.base.operator,
    rows: {
      findSessionById: (sessionId) => workshop.sessionById(sessionId),
      findSessionByChannel: (channelId) => workshop.sessionByChannel(channelId),
      listTurns: (sessionId) => workshop.listTurns(sessionId),
      getTurn: (turnId) => workshop.getTurn(turnId),
      listSchedules: async (sessionId) => {
        const schedules = await workshop.listSchedules(sessionId);
        return schedules.map((schedule) => ({
          id: schedule.id,
          prompt: schedule.prompt,
          rrule: schedule.rrule,
          status: schedule.status,
          nextRunAt: schedule.nextRunAt,
          createdAt: schedule.createdAt,
        }));
      },
    },
    instances: {
      findInstanceById: async ({ instanceId }) => {
        const found = await platform
          .select({
            id: sandboxInstances.id,
            botId: sandboxInstances.botId,
            status: sandboxInstances.status,
          })
          .from(sandboxInstances)
          .where(sql`${sandboxInstances.id} = ${instanceId}`)
          .limit(1);
        const row = found[0];
        if (!row) return undefined;
        return { instanceId: row.id, botId: row.botId, status: row.status };
      },
    },
    recyclePort: {
      recycle: async (input) => {
        recycleCalls.push(input);
      },
    },
    shareResolution: shareTokens,
  });

  const ensureArrangement = async (channelId: string, botId: string) => {
    await platform
      .insert(channels)
      .values({
        id: channelId,
        name: `MT28 channel ${channelId}`,
        description: "mt28 workshop tenancy arrangement",
      })
      .onConflictDoNothing();
    await platform
      .insert(agents)
      .values({
        id: botId,
        name: `MT28 bot ${botId}`,
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
  };

  const fixture: WorkshopTenancyFixture = {
    base,
    workshop,
    platform,
    artifacts,
    artifactStore,
    attachments,
    workshopScopes,
    shareTokens,
    recycleCalls,
    invalidationEvents,
    signingKey,
    async scopeAs(identity, teamKey) {
      const fact = base.base.teamOf(identity, teamKey);
      return base.base.scopeFor(identity, {
        tenantId: fact.tenantId,
        workspaceId: fact.workspaceId,
      });
    },
    userIdOf,
    ensureArrangement,
    async ensurePinnedSession(input) {
      const channelId = `${run}-ch-${randomUUID().slice(0, 8)}`;
      const botId = input.botId ?? `${run}-bot-${randomUUID().slice(0, 8)}`;
      await ensureArrangement(channelId, botId);
      const session = await workshop.getOrCreateSession({
        channelId,
        botId,
        ownerUserId: userIdOf(input.owner),
      });
      const scope = await fixture.scopeAs(input.owner, input.team);
      const pinned = await workshopScopes.pinWorkshopSession(scope, {
        channelId,
      });
      if (!("status" in pinned)) {
        throw new Error(`MT28_PIN_FAILED: ${JSON.stringify(pinned)}`);
      }
      return { channelId, botId, sessionId: session.id };
    },
    async ensurePinnedArtifact(input) {
      const arrangement = await fixture.ensurePinnedSession(input);
      const artifact = await workshop.insertArtifact({
        sessionId: arrangement.sessionId,
        type: "file",
        name: input.name ?? `${run}-artifact`,
        path: `/workspace/${run}-out.bin`,
        sizeBytes: 64,
      });
      const scope = await fixture.scopeAs(input.owner, input.team);
      const enterpriseKey = enterpriseWorkshopArtifactObjectKey(
        scope.tenantId,
        scope.workspaceId,
        arrangement.sessionId,
        artifact.id,
      );
      await artifactStore.put(enterpriseKey, new Uint8Array([1, 2, 3, 4]));
      const pinnedArtifact = await artifacts.pinWorkshopArtifact(scope, {
        sessionId: arrangement.sessionId,
        artifactId: artifact.id,
      });
      if (!("status" in pinnedArtifact)) {
        throw new Error(
          `MT28_ARTIFACT_PIN_FAILED: ${JSON.stringify(pinnedArtifact)}`,
        );
      }
      return { ...arrangement, artifactId: artifact.id, enterpriseKey };
    },
    async ensureSandboxInstance(input) {
      const instanceId = `sbx-${run}-${randomUUID().slice(0, 8)}`;
      await platform.insert(sandboxInstances).values({
        id: instanceId,
        botId: input.botId,
        ownerUserId: userIdOf(input.owner),
        status: "ready",
      });
      return instanceId;
    },
    async seedLegacyAnonymousShare(input) {
      const token = `legacytoken-${randomUUID()}`;
      const { createHash } = await import("node:crypto");
      await platform.execute(
        sql`update workshop_sessions set share_token_hash = ${createHash(
          "sha256",
        )
          .update(token)
          .digest(
            "hex",
          )}, share_scope = 'preview', visibility = 'unlisted', share_created_by = ${userIdOf(
          input.createdBy,
        )}, share_created_at = now() where channel_id = ${input.channelId}`,
      );
      return token;
    },
    async suspendCompany(identity, companyKey) {
      await base.setCompanyMembershipStatus(identity, companyKey, "suspended");
    },
    async dispose() {
      // Belt-and-braces: drop any rows whose users outlived the base chain.
      await platform
        .execute(
          sql`delete from enterprise_workshop_share_grants where session_id in (select id from workshop_sessions where channel_id like ${`${run}-ch-%`})`,
        )
        .catch(() => {});
      await platform
        .execute(
          sql`delete from enterprise_workshop_sandbox_bindings where instance_id like ${`sbx-${run}%`}`,
        )
        .catch(() => {});
      await platform
        .execute(
          sql`delete from enterprise_workshop_scopes where channel_id like ${`${run}-ch-%`}`,
        )
        .catch(() => {});
      await platform
        .execute(
          sql`delete from enterprise_artifact_scopes where artifact_id in (select id from workshop_artifacts where session_id in (select id from workshop_sessions where channel_id like ${`${run}-ch-%`}))`,
        )
        .catch(() => {});
      await platform
        .execute(
          sql`delete from workshop_artifacts where session_id in (select id from workshop_sessions where channel_id like ${`${run}-ch-%`})`,
        )
        .catch(() => {});
      await platform
        .execute(
          sql`delete from workshop_sessions where channel_id like ${`${run}-ch-%`}`,
        )
        .catch(() => {});
      await platform
        .execute(
          sql`delete from sandbox_instances where id like ${`sbx-${run}%`}`,
        )
        .catch(() => {});
      await platform
        .execute(sql`delete from channels where id like ${`${run}-ch-%`}`)
        .catch(() => {});
      await platform
        .execute(sql`delete from agents where id like ${`${run}-bot-%`}`)
        .catch(() => {});
      await platform.$client.close().catch(() => {});
      await base.dispose();
    },
  };

  return fixture;
}
