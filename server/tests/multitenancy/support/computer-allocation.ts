/**
 * Shared MT046 fixture (Issue #89, computer/browser allocation + screen /
 * takeover authorization).
 *
 * Builds on the MT002 isolation matrix with the verified restricted-role
 * connections, the REAL MT016 bot-ownership service (bots are registered into
 * companies/teams so the #90 ownership verdict has authoritative rows), and
 * the REAL #90 execution-artifacts service as the authorization seam — the
 * allocation service under test consumes exactly that seam, per the ticket's
 * "reuse, don't rebuild" constraint. The computer surface is a recording port
 * (screenshots, control calls, stop/reset, an in-memory state tree); nothing
 * here mocks the authorization path.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { agents } from "../../../src/db/schema/core";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type BotOwnershipService,
  createBotOwnershipService,
} from "../../../src/enterprise/tenancy/bots-ownership";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createExecutionArtifactsService,
  type ExecutionAuditEvent,
  type ExecutionAuditSink,
} from "../../../src/enterprise/tenancy/execution-artifacts";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import { enterpriseRuntimeDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  createIsolationFixture,
  type FixtureIdentity,
  type IsolationFixture,
} from "./fixture";

export type ComputerCompanyKey = "company-a" | "company-b";
export type ComputerTeamKey = "team-a1" | "team-a2" | "team-b1";

async function openVerified<T extends object>(
  url: string,
  verify: (database: Database) => Promise<T>,
): Promise<T> {
  return verify(createDatabase(url, { max: 2 }) as Database);
}

/** What the recording computer port observed, in order. */
export interface PortRecording {
  readonly screenshots: readonly string[];
  readonly takeControls: readonly {
    botId: string;
    actorId: string;
    requestId: string;
  }[];
  readonly releaseControls: readonly {
    botId: string;
    actorId: string;
    requestId: string;
  }[];
  readonly cancelControls: readonly {
    botId: string;
    actorId: string;
    requestId: string;
  }[];
  readonly closedScreens: readonly string[];
  readonly stops: readonly string[];
  readonly profileResets: readonly string[];
}

/**
 * The computer surface as recorders plus an in-memory state tree keyed by
 * directory. `loginSeeds` models the profile logins: recycle must clear them.
 */
export function recordingPorts() {
  const screenshots: string[] = [];
  const takeControls: { botId: string; actorId: string; requestId: string }[] =
    [];
  const releaseControls: {
    botId: string;
    actorId: string;
    requestId: string;
  }[] = [];
  const cancelControls: {
    botId: string;
    actorId: string;
    requestId: string;
  }[] = [];
  const closedScreens: string[] = [];
  const stops: string[] = [];
  const profileResets: string[] = [];
  const files = new Map<string, Uint8Array>();
  const loginSeeds = new Map<string, string>();

  return {
    ports: {
      async screenshot(botId: string) {
        screenshots.push(botId);
        return {
          base64: Buffer.from(`frame:${loginSeeds.get(botId) ?? ""}`).toString(
            "base64",
          ),
        };
      },
      async takeControl(
        botId: string,
        actor: { id: string },
        requestId: string,
      ) {
        takeControls.push({ botId, actorId: actor.id, requestId });
        return { request: { id: requestId, takenBy: actor.id } };
      },
      async releaseControl(
        botId: string,
        actor: { id: string },
        requestId: string,
      ) {
        releaseControls.push({ botId, actorId: actor.id, requestId });
        return { request: null };
      },
      async cancelControl(
        botId: string,
        actor: { id: string },
        requestId: string,
      ) {
        cancelControls.push({ botId, actorId: actor.id, requestId });
        return { request: null };
      },
      async closeScreen(botId: string) {
        closedScreens.push(botId);
      },
      async stop(botId: string) {
        stops.push(botId);
        return { wasRunning: true };
      },
      async resetProfile(botId: string) {
        profileResets.push(botId);
        // Map.delete answers "was it there": asking has() after delete always sees false.
        return { cleared: loginSeeds.delete(botId) };
      },
      state: {
        async ensure(dir: string) {
          if (!files.has(`${dir}/.keep`))
            files.set(`${dir}/.keep`, new Uint8Array(0));
        },
        async remove(dir: string) {
          for (const key of [...files.keys()]) {
            if (key.startsWith(`${dir}/`)) files.delete(key);
          }
        },
        async list(dir: string) {
          return [...files.keys()]
            .filter((key) => key.startsWith(`${dir}/`))
            .map((key) => key.slice(dir.length + 1))
            .filter((name) => name !== ".keep")
            .sort();
        },
        async write(dir: string, name: string, bytes: Uint8Array) {
          files.set(`${dir}/${name}`, bytes);
        },
      },
    },
    /** Seeds a login marker on a bot's profile (what recycle must clear). */
    seedLogin(botId: string, marker: string) {
      loginSeeds.set(botId, marker);
    },
    loginOf(botId: string): string | undefined {
      return loginSeeds.get(botId);
    },
    fileNames(): readonly string[] {
      return [...files.keys()].sort();
    },
    recording: (): PortRecording => ({
      screenshots,
      takeControls,
      releaseControls,
      cancelControls,
      closedScreens,
      stops,
      profileResets,
    }),
  };
}

export function auditRecorder(): ExecutionAuditSink & {
  events(): readonly ExecutionAuditEvent[];
} {
  const seen: ExecutionAuditEvent[] = [];
  return {
    async record(event) {
      seen.push(event);
    },
    events: () => seen,
  };
}

export interface ComputerAllocationFixture {
  readonly isolation: IsolationFixture;
  readonly operator: OperatorDatabase;
  readonly data: DataDatabase;
  readonly directory: DirectoryDatabase;
  readonly setup: Database;
  /** The real MT016 bot ownership service (bots registered into teams). */
  readonly bots: BotOwnershipService;
  /** The real #90 service — the authorization seam the ticket mandates reusing. */
  readonly artifacts: ReturnType<typeof createExecutionArtifactsService>;
  /** Issues a trusted PlatformScope through the real scope resolver. */
  scopeAs(
    identity: FixtureIdentity,
    companyKey: ComputerCompanyKey,
    teamKey: ComputerTeamKey,
  ): Promise<PlatformScope>;
  /** Registers a bot in the given team through the real MT016 service. */
  registerBot(input: {
    identity: FixtureIdentity;
    companyKey: ComputerCompanyKey;
    teamKey: ComputerTeamKey;
    label: string;
  }): Promise<{ botId: string; scope: PlatformScope }>;
  /** Company-level suspension through the real provision receipt (epoch bump). */
  suspendCompanyMembership(
    identity: FixtureIdentity,
    companyKey: ComputerCompanyKey,
  ): Promise<void>;
  /** Restores a suspended company membership row (hygiene; epoch stays bumped). */
  restoreCompanyMembership(
    identity: FixtureIdentity,
    companyKey: ComputerCompanyKey,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export async function createComputerAllocationFixture(): Promise<ComputerAllocationFixture> {
  const isolation = await createIsolationFixture("jobs");

  const operator = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("operator" as const, process.env),
    verifyOperatorDatabase,
  );
  const data = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("data" as const, process.env),
    verifyDataDatabase,
  );
  const directory = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("directory" as const, process.env),
    verifyDirectoryDatabase,
  );
  const setup = createDatabase(process.env.TEST_DATABASE_URL ?? "", { max: 2 });

  const bots = createBotOwnershipService({ data, operator });
  const artifacts = createExecutionArtifactsService({
    data,
    audit: { record: () => undefined },
  });

  const sessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string; workspaceId: string }
  >();
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const session = sessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "web" };
    },
    selectTenant: (request) =>
      sessions.get(request)?.tenantId ??
      request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) =>
      sessions.get(request)?.workspaceId ??
      request.headers.get("x-openbot-workspace"),
  });

  const tenantIdOf = (companyKey: ComputerCompanyKey) =>
    isolation.ids[companyKey];
  const workspaceIdOf = (teamKey: ComputerTeamKey) => isolation.ids[teamKey];

  /** execute() result rows: drizzle returns either a row array or { rows }. */
  const rowsOf = (result: unknown): readonly Record<string, unknown>[] =>
    Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

  const principalOf = async (identity: FixtureIdentity) => {
    const rows = rowsOf(
      await setup.execute(sql`
        select p.id from enterprise_principals p
        where p.user_id = ${isolation.ids[`user-${identity}`]}
        limit 1
      `),
    );
    if (rows.length === 0)
      throw new Error(`FIXTURE_PRINCIPAL_MISSING:${identity}`);
    return String(rows[0].id);
  };

  const scopeAs = async (
    identity: FixtureIdentity,
    companyKey: ComputerCompanyKey,
    teamKey: ComputerTeamKey,
  ): Promise<PlatformScope> => {
    const request = new Request("https://tests.invalid/allocation-scope");
    sessions.set(request, {
      userId: isolation.ids[`user-${identity}`],
      tenantId: tenantIdOf(companyKey),
      workspaceId: workspaceIdOf(teamKey),
    });
    return resolver.resolve(request);
  };

  const fixture: ComputerAllocationFixture = {
    isolation,
    operator,
    data,
    directory,
    setup,
    bots,
    artifacts,

    scopeAs,

    async registerBot({ identity, companyKey, teamKey, label }) {
      const scope = await scopeAs(identity, companyKey, teamKey);
      const botId = `${isolation.idPrefix}-mt046-bot-${label}-${randomUUID().slice(0, 8)}`;
      // The legacy agents row the wider workspace still keys on; ownership is
      // the enterprise fact the #90 verdict reads.
      await setup
        .insert(agents)
        .values({
          id: botId,
          name: `MT046 ${label} Bot`,
          type: "built_in",
          configuration: {},
        })
        .onConflictDoNothing();
      const created = await bots.createBot(scope, {
        agentId: botId,
        displayName: `MT046 ${label}`,
        defaultConfig: {},
      });
      if (created.outcome !== "allow") {
        throw new Error(`FIXTURE_BOT_CREATE_FAILED:${String(created.outcome)}`);
      }
      return { botId, scope };
    },

    async suspendCompanyMembership(identity, companyKey) {
      await isolation.suspendCompanyMembership(
        identity,
        tenantIdOf(companyKey),
      );
    },

    async restoreCompanyMembership(identity, companyKey) {
      const principalId = await principalOf(identity);
      await setup.execute(sql`
        update enterprise_memberships
        set status = 'active'
        where tenant_id = ${tenantIdOf(companyKey)} and principal_id = ${principalId}
      `);
    },

    async dispose() {
      const failures: unknown[] = [];
      for (const closeable of [operator, data, directory]) {
        try {
          await closeable.$client.close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await setup.$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await isolation.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Computer allocation fixture disposal failed.",
        );
      }
    },
  };
  return fixture;
}
