import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client";
import { createAuditStore } from "../../audit";
import { corsairApp, createCorsairCutover } from "./cutover";

import { RevocationRefusal } from "./revocation";

export const legacyBroker = z.enum(["composio", "arcade"]);
const ref = z.string().trim().min(1).max(256);
const impact = z.array(ref).max(100);
const entry = z.strictObject({
  ref,
  impact,
  reopen: z.literal(true).optional(),
});
const observed = { ref, evidenceRef: ref };
const verification = {
  kind: z.literal("verify"),
  ref,
  accessEvidenceRef: ref,
  refreshEvidenceRef: ref,
  terminalAttemptEvidenceRef: ref.optional(),
};
export const cleanupCommand = z.union([
  z.strictObject({
    kind: z.literal("inventory"),
    evidenceRef: ref,
    entries: z.array(entry).max(5000),
  }),
  z.strictObject({
    kind: z.literal("confirm_impact"),
    ...observed,
    impact: impact.min(1),
  }),
  z.strictObject({ kind: z.literal("requested"), ...observed }),
  z.strictObject({ kind: z.literal("query_failed"), ...observed }),
  z.strictObject({ ...verification, source: z.literal("broker") }),
  z.strictObject({
    ...verification,
    source: z.enum(["holder", "external_admin"]),
    verifierRef: ref,
  }),
  z.strictObject({
    kind: z.literal("prepare_retirement"),
    dependencyEvidenceRef: ref,
  }),
  z.strictObject({
    kind: z.literal("retire"),
    evidenceRef: ref,
    dependencyEvidenceRef: ref,
    preparationRef: z.uuid(),
  }),
]);
type Command = z.infer<typeof cleanupCommand>;
type App = z.infer<typeof corsairApp>;
type Broker = z.infer<typeof legacyBroker>;
type Scope = { workspaceId: string; app: App; provider: Broker };
type Reader = Pick<Database, "execute">;
const eventType = "corsair.legacy_cleanup";
const targetType = "corsair_legacy_cleanup";

function sorted(values: string[]) {
  return [...new Set(values)].sort();
}

async function inventory(db: Reader, { app, provider, workspaceId }: Scope) {
  return db.execute<{ kind: string; parts: string[]; shared: boolean }>(sql`
    select 'connection' as kind, array[vendor_user_id] as parts,
      holder = 'deployment' as shared from brokered_connections
    where provider = ${provider} and lower(btrim(app)) = ${app}
    union
    select 'account', array[vendor_user_id, account_id], false from brokered_accounts
    where provider = ${provider} and lower(btrim(app)) = ${app}
    union
    select 'attempt', array[p.actor_id, p.vendor_user_id, p.created_at::text], p.holder = 'deployment'
    from pending_authorizations p join mcp_servers s on s.id = p.server_id
    where lower(s.url) = ${`${provider}://${app}`}
    union
    select 'historical_connection', array[user_id], false from composio_connections
    where ${provider} = 'composio' and lower(btrim(toolkit)) = ${app}
    union
    select 'authorization_started', array[e.target_id, e.actor_user_id, e.payload->>'vendorUserId', e.created_at::text],
      coalesce(e.payload->>'holder' = 'deployment', false) from audit_events e
    where e.event_type = 'corsair.legacy_authorization_started'
      and e.payload->>'workspaceId' = ${workspaceId} and e.payload->>'app' = ${app}
      and e.payload->>'provider' = ${provider}
    union
    select 'cancelled_attempt', array[e.id::text, e.payload->>'actor'], coalesce(e.payload->>'holder' = 'deployment', false)
    from audit_events e where e.event_type = 'mcp.authorization_cancelled'
      and e.target_id = ${app} and ${provider} = 'arcade'
    union
    select 'late_callback', array[e.target_id, e.actor_user_id], false from audit_events e
    where e.event_type = 'corsair.legacy_callback_blocked'
      and e.payload->>'workspaceId' = ${workspaceId} and e.payload->>'app' = ${app}
      and e.payload->>'provider' = ${provider}
  `);
}

function localRef(row: Awaited<ReturnType<typeof inventory>>[number]) {
  return `local:${row.kind}:${createHash("sha256").update(JSON.stringify(row.parts)).digest("hex")}`;
}

type Entry = {
  ref: string;
  local?: { kind: string; parts: string[] };
  impact: string[];
  confirmed: boolean;
  status: "open" | "pending" | "verified";
};

async function read(db: Reader, scope: Scope) {
  const { workspaceId, app, provider } = scope;
  const target = JSON.stringify([workspaceId, app, provider]);
  const [local, history, [retired], [eligibility]] = await Promise.all([
    inventory(db, scope),
    db.execute<{ payload: unknown; actor: string; at: string; id: string }>(sql`
      select id, payload - 'provider' as payload, actor_user_id as actor, created_at::text as at from audit_events
      where event_type = ${eventType} and target_type = ${targetType} and target_id = ${target}
      order by created_at, id
    `),
    db.execute<{ evidenceRef: string; actor: string; at: string }>(sql`
      select payload->>'evidenceRef' as "evidenceRef", actor_user_id as actor, created_at::text as at
      from audit_events where event_type = ${eventType} and target_type = ${targetType}
        and payload->>'provider' = ${provider} and payload->>'kind' = 'retire'
      order by created_at desc, id desc limit 1
    `),
    db.execute<{ eligible: boolean }>(sql`
      select coalesce((
        select payload->>'kind' = 'cleanup' and (
          select (previous.payload->>'until')::timestamptz <= e.created_at
          from audit_events previous where previous.event_type = e.event_type
            and previous.target_type = e.target_type and previous.target_id = e.target_id
            and (previous.created_at, previous.id) < (e.created_at, e.id)
          order by previous.created_at desc, previous.id desc limit 1
        ) from audit_events e where e.event_type = 'corsair.migration_route_changed'
          and e.target_type = 'corsair_migration_scope' and e.target_id = ${JSON.stringify([workspaceId, app])}
        order by e.created_at desc, e.id desc limit 1
      ), false) as eligible
    `),
  ]);
  const entries = new Map<string, Entry>();
  const evidence = [];
  let covered = new Set<string>();
  for (const row of local) {
    const reference = localRef(row);
    entries.set(reference, {
      ref: reference,
      local: { kind: row.kind, parts: row.parts },
      impact: row.shared ? ["deployment-account"] : [],
      confirmed: false,
      status: "open",
    });
  }
  for (const row of history) {
    const command = cleanupCommand.parse(row.payload);
    evidence.push({ ...command, actor: row.actor, at: row.at, id: row.id });
    if (command.kind === "inventory") {
      covered = new Set(command.entries.map((item) => item.ref));
      for (const item of command.entries) {
        const current = entries.get(item.ref);
        const affected = sorted(item.impact);
        if (
          !current ||
          item.reopen ||
          JSON.stringify(current.impact) !== JSON.stringify(affected)
        ) {
          entries.set(item.ref, {
            ...current,
            ref: item.ref,
            impact: affected,
            confirmed: false,
            status: "open",
          });
        }
      }
    } else if (
      command.kind !== "retire" &&
      command.kind !== "prepare_retirement"
    ) {
      const current = entries.get(command.ref);
      if (!current) continue;
      if (command.kind === "confirm_impact") current.confirmed = true;
      if (command.kind === "requested") current.status = "pending";
      if (command.kind === "verify") current.status = "verified";
    }
  }
  return {
    target,
    entries: [...entries.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
    evidence,
    covered,
    eligible: eligibility?.eligible === true,
    retired: retired ?? null,
    hasInventory: evidence.some((row) => row.kind === "inventory"),
  };
}

export async function readLegacyCleanup(database: Database, scope: Scope) {
  const { target, covered, ...state } = await read(database, scope);
  return {
    ...state,
    unreconciledRefs: state.entries
      .filter((item) => !covered.has(item.ref))
      .map((item) => item.ref),
  };
}

async function mayRetire(db: Reader, scope: Scope) {
  const { provider, workspaceId } = scope;
  const dependencies = await db.execute<{
    app: string;
    workspaceId: string;
  }>(sql`
    with local_apps as (
      select lower(substring(url from position('://' in url) + 3)) as app
      from mcp_servers where starts_with(lower(url), ${`${provider}://`})
      union select lower(btrim(app)) from brokered_connections where provider = ${provider}
      union select lower(btrim(app)) from brokered_accounts where provider = ${provider}
      union select lower(btrim(toolkit)) from composio_connections where ${provider} = 'composio'
      union select ${scope.app}::text
    )
    select app, ${workspaceId}::text as "workspaceId" from local_apps
    union
    select (target_id::jsonb)->>1, (target_id::jsonb)->>0 from audit_events
    where event_type = ${eventType} and target_type = ${targetType} and payload->>'provider' = ${provider}
  `);
  for (const dependency of dependencies) {
    const app = corsairApp.safeParse(dependency.app);
    if (!app.success) return false;
    const reviewed = await read(db, {
      workspaceId: dependency.workspaceId,
      app: app.data,
      provider,
    });
    if (
      !reviewed.eligible ||
      !reviewed.hasInventory ||
      reviewed.entries.some(
        (item) => item.status !== "verified" || !reviewed.covered.has(item.ref),
      )
    )
      return false;
  }
  return true;
}

export async function recordLegacyCleanup(
  database: Database,
  scope: Scope,
  actor: string,
  command: Command,
) {
  return createCorsairCutover(database, scope).review(
    actor,
    async (tx, _current, audit) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`corsair-legacy-cleanup:${scope.provider}`}, 0))`,
      );
      const state = await read(tx, scope);
      if (!state.eligible) return false;
      let payload = command;
      if (command.kind === "inventory") {
        const submitted = new Map(
          command.entries.map((item) => [item.ref, item.impact]),
        );
        if (
          submitted.size !== command.entries.length ||
          state.entries.some(
            (item) =>
              !submitted.has(item.ref) ||
              (item.impact.includes("deployment-account") &&
                !submitted.get(item.ref)?.includes("deployment-account")),
          ) ||
          command.entries.some(
            (item) =>
              item.ref.startsWith("local:") &&
              !state.entries.some((known) => known.ref === item.ref),
          )
        )
          return false;
        payload = {
          ...command,
          entries: command.entries.map((item) => ({
            ...item,
            impact: sorted(item.impact),
          })),
        };
      } else if (
        command.kind === "retire" ||
        command.kind === "prepare_retirement"
      ) {
        if (state.retired || !(await mayRetire(tx, scope))) return false;
        if (command.kind === "retire") {
          const [last] = await tx.execute<{
            id: string;
            dependency: string;
            kind: string;
          }>(sql`
          select id, payload->>'kind' as kind, payload->>'dependencyEvidenceRef' as dependency
          from audit_events where event_type = ${eventType} and target_type = ${targetType}
            and payload->>'provider' = ${scope.provider}
          order by created_at desc, id desc limit 1
        `);
          if (
            last?.kind !== "prepare_retirement" ||
            last.id !== command.preparationRef ||
            last.dependency !== command.dependencyEvidenceRef
          )
            return false;
        }
      } else {
        const item = state.entries.find((item) => item.ref === command.ref);
        if (!item || !state.covered.has(item.ref) || item.status === "verified")
          return false;
        if (
          command.kind === "verify" &&
          /^local:(attempt|cancelled_attempt|authorization_started|late_callback):/.test(
            item.ref,
          ) &&
          !command.terminalAttemptEvidenceRef
        )
          return false;
        if (command.kind === "confirm_impact") {
          if (
            JSON.stringify(item.impact) !==
            JSON.stringify(sorted(command.impact))
          )
            return false;
        } else if (
          command.kind !== "query_failed" &&
          item.impact.length &&
          !item.confirmed
        ) {
          return false;
        }
      }
      await audit.insert({
        eventType,
        targetType,
        targetId: state.target,
        actorUserId: actor,
        createdAt: sql`clock_timestamp()`,
        payload: { ...payload, provider: scope.provider },
      });
      return true;
    },
  );
}

export async function guardLegacyAuthorization<T>({
  database,
  workspaceId,
  provider,
  url,
  actor,
  callback,
  run,
}: {
  database: Database;
  workspaceId: string | undefined;
  provider: Broker;
  url: string;
  actor: string;
  callback?: string;
  run: () => Promise<T>;
}): Promise<T> {
  const app = corsairApp.safeParse(url.toLowerCase().split("://")[1]);
  if (
    !workspaceId ||
    !app.success ||
    url.toLowerCase() !== `${provider}://${app.data}`
  )
    return run();
  const scope = { workspaceId, app: app.data, provider };
  const cutover = createCorsairCutover(database, scope);
  try {
    return await cutover.dispatch("legacy", run);
  } catch (error) {
    if (!(error instanceof RevocationRefusal) || callback === undefined)
      throw error;
    await recordBlockedReturn(database, scope, actor, callback);
    throw error;
  }
}

async function recordBlockedReturn(
  database: Database,
  scope: Scope,
  actor: string,
  callback: string,
) {
  const targetId = createHash("sha256")
    .update(JSON.stringify([scope, actor, callback]))
    .digest("hex");
  await createCorsairCutover(database, scope).review(
    actor,
    async (tx, state, audit) => {
      if (state.kind === "legacy") return false;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`corsair-legacy-cleanup:${scope.provider}`}, 0))`,
      );
      const existing = await tx.execute(sql`
        select 1 from audit_events where event_type = 'corsair.legacy_callback_blocked'
          and target_type = ${targetType} and target_id = ${targetId} limit 1
      `);
      if (!existing.length)
        await audit.insert({
          eventType: "corsair.legacy_callback_blocked",
          targetType,
          targetId,
          actorUserId: actor,
          payload: scope,
        });
      return true;
    },
  );
}

export async function recordUnmatchedArcadeReturn(
  database: Database,
  workspaceId: string,
  actor: string,
  callback: string,
) {
  const candidates = await database.execute<{ app: unknown }>(sql`
    select substring(lower(s.url) from 10) as app
    from pending_authorizations p join mcp_servers s on s.id = p.server_id
    where p.actor_id = ${actor} and lower(s.url) in ('arcade://github', 'arcade://slack')
    union
    select payload->>'app' from audit_events
    where event_type = 'corsair.legacy_authorization_started'
      and actor_user_id = ${actor} and payload->>'provider' = 'arcade'
      and payload->>'workspaceId' = ${workspaceId}
    union
    select target_id from audit_events
    where event_type = 'mcp.authorization_cancelled' and payload->>'actor' = ${actor}
      and target_id in ('github', 'slack')
  `);
  for (const candidate of candidates) {
    const app = corsairApp.safeParse(candidate.app);
    if (app.success)
      await recordBlockedReturn(
        database,
        { workspaceId, app: app.data, provider: "arcade" },
        actor,
        callback,
      );
  }
}

export async function recordLegacyAuthorizationStart(
  database: Database,
  workspaceId: string | undefined,
  provider: Broker,
  input: {
    toolkit: string;
    actor: string;
    holder: string;
    vendorUserId: string;
    action: string | null;
  },
) {
  const app = corsairApp.safeParse(input.toolkit.toLowerCase());
  if (!workspaceId || !app.success) return;
  await createAuditStore(database).insert({
    eventType: "corsair.legacy_authorization_started",
    targetType,
    targetId: randomUUID(),
    actorUserId: input.actor,
    payload: {
      workspaceId,
      app: app.data,
      provider,
      holder: input.holder,
      vendorUserId: input.vendorUserId,
      action: input.action,
    },
  });
}
