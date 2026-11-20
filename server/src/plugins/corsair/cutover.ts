import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client";
import { auditEvents } from "../../db/schema";
import { dispatchWhileConnected, RevocationRefusal } from "./revocation";

export const corsairApp = z.enum(["github", "slack"]);
type Scope = { workspaceId: string; app: z.infer<typeof corsairApp> };
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Path = "legacy" | "corsair";

const stateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy") }),
  z.object({
    kind: z.literal("observing"),
    until: z.iso.datetime(),
    excluded: z.array(z.string()),
  }),
  z.object({ kind: z.literal("cleanup"), excluded: z.array(z.string()) }),
]);
type State = z.infer<typeof stateSchema>;
const changed = "corsair.migration_route_changed";
const observationMs = 7 * 24 * 60 * 60 * 1000;

export { RevocationRefusal as cutoverRefusal };

export function createCorsairCutover(
  database: Database,
  { workspaceId, app }: Scope,
  drainMs = 5000,
) {
  const scope = JSON.stringify([workspaceId, app]);
  const key = sql`hashtextextended(${`corsair-tool-route:${scope}`}, 0)`;

  async function read(
    db: Pick<Database, "execute"> = database,
  ): Promise<State> {
    const [row] = await db.execute<{ payload: unknown }>(sql`
      select payload from audit_events where event_type = ${changed}
        and target_type = 'corsair_migration_scope' and target_id = ${scope}
      order by created_at desc, id desc limit 1
    `);
    return row ? stateSchema.parse(row.payload) : { kind: "legacy" };
  }

  async function transition(
    actorId: string,
    decide: (current: State, tx: Transaction) => Promise<State | null>,
    evidence?: Record<string, string>,
  ) {
    let acquiring = true;
    try {
      return await database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', ${`${drainMs}ms`}, true)`,
        );
        await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
        acquiring = false;
        const current = await read(tx);
        const next = await decide(current, tx);
        if (!next || next === current) return next;
        await tx.insert(auditEvents).values({
          eventType: changed,
          targetType: "corsair_migration_scope",
          targetId: scope,
          actorUserId: actorId,
          createdAt: sql`clock_timestamp()`,
          payload: { ...next, ...evidence },
        });
        return next;
      });
    } catch (error) {
      const lockTimeout = z.union([
        z.object({ code: z.literal("55P03") }),
        z.object({ errno: z.literal("55P03") }),
      ]);
      const isLockTimeout = (value: unknown) =>
        lockTimeout.safeParse(value).success ||
        (value instanceof Error && lockTimeout.safeParse(value.cause).success);
      if (acquiring && isLockTimeout(error)) return null;
      throw error;
    }
  }

  return {
    read: () => read(),
    review(actorId: string, record: (tx: Transaction) => Promise<boolean>) {
      return transition(actorId, async (current, tx) =>
        (await record(tx)) ? current : null,
      );
    },
    activate(
      actorId: string,
      ready: (tx: Transaction) => Promise<string[] | null>,
    ) {
      return transition(actorId, async (current, tx) => {
        if (current.kind !== "legacy") return current;
        const excluded = await ready(tx);
        if (!excluded) return null;
        return {
          kind: "observing",
          until: new Date(Date.now() + observationMs).toISOString(),
          excluded,
        };
      });
    },
    rollback(
      actorId: string,
      evidence: {
        legacyAuthorizationRef: string;
        currentPermissionsRef: string;
      },
      legacyVerified: (tx: Transaction) => Promise<boolean>,
    ) {
      return transition(
        actorId,
        async (current, tx) => {
          if (
            current.kind !== "observing" ||
            Date.parse(current.until) <= Date.now()
          )
            return null;
          return (await legacyVerified(tx)) ? { kind: "legacy" } : null;
        },
        evidence,
      );
    },
    beginCleanup(actorId: string, evidenceRef: string) {
      return transition(
        actorId,
        async (current) =>
          current.kind === "legacy"
            ? null
            : current.kind === "cleanup"
              ? current
              : { kind: "cleanup", excluded: current.excluded },
        { evidenceRef },
      );
    },
    async disconnectLegacy<T>(
      actorId: string,
      disconnect: () => Promise<T>,
    ): Promise<T> {
      let result: { value: T } | undefined;
      const permitted = await transition(actorId, async (current) => {
        if (current.kind === "observing")
          throw new RevocationRefusal(
            "Mark legacy cleanup before withdrawing the authorization.",
            409,
          );
        result = { value: await disconnect() };
        return current;
      });
      if (!permitted || !result)
        throw new RevocationRefusal("The tool route is still draining.", 409);
      return result.value;
    },
    async dispatch<T>(
      path: Path,
      send: (tx: Transaction, excluded: readonly string[]) => Promise<T>,
    ): Promise<T> {
      return database.transaction(async (tx) => {
        const [lock] = await tx.execute<{ acquired: boolean }>(
          sql`select pg_try_advisory_xact_lock_shared(${key}) as acquired`,
        );
        if (!lock?.acquired)
          throw new RevocationRefusal(
            "The tool route is draining. Retry after the route is settled.",
            409,
          );
        const current = await read(tx);
        const active = current.kind === "legacy" ? "legacy" : "corsair";
        if (active !== path)
          throw new RevocationRefusal(
            `This workspace uses the ${active} route for ${app}.`,
            409,
          );
        return send(tx, current.kind === "legacy" ? [] : current.excluded);
      });
    },
  };
}

export function withLegacyCorsairRoute<T>(
  database: Database,
  workspaceId: string | undefined,
  transport: string,
  url: string,
  send: (tx?: Transaction) => Promise<T>,
) {
  const selected = corsairApp.safeParse(url.toLowerCase().split("://")[1]);
  if (
    !workspaceId ||
    !selected.success ||
    (transport !== "composio" && transport !== "arcade") ||
    url.toLowerCase() !== `${transport}://${selected.data}`
  )
    return send();
  return createCorsairCutover(database, {
    workspaceId,
    app: selected.data,
  }).dispatch("legacy", send);
}

export function withLegacyCorsairDisconnect<T>(
  database: Database,
  workspaceId: string | undefined,
  toolkit: string,
  actorId: string,
  disconnect: () => Promise<T>,
) {
  const app = corsairApp.safeParse(toolkit.toLowerCase());
  return workspaceId && app.success
    ? createCorsairCutover(database, {
        workspaceId,
        app: app.data,
      }).disconnectLegacy(actorId, disconnect)
    : disconnect();
}

export function corsairWriteKey(
  actorId: string,
  providerSubject: string,
  targetId: string,
  args: unknown,
) {
  return createHash("sha256")
    .update(JSON.stringify([actorId, providerSubject, targetId, args]))
    .digest("hex");
}

export function dispatchCorsairWrite<T>(
  database: Database,
  scope:
    | (Scope & {
        botId: string;
        registration: string;
        grant: string;
        approvalId: string;
        writeKey: string;
        binding: "personal" | "shared";
      })
    | undefined,
  connectionId: string,
  revision: string | undefined,
  send: () => Promise<T>,
) {
  if (!scope)
    return dispatchWhileConnected(database, connectionId, revision, send);
  return createCorsairCutover(database, scope).dispatch(
    "corsair",
    async (tx, excluded) => {
      if (excluded.length) {
        const [mapping] = await tx.execute<{ legacyTool: string | null }>(sql`
        select payload->>'legacyTool' as "legacyTool" from audit_events
        where event_type = 'corsair.migration_policy_copied'
          and target_type = 'corsair_migration_policy'
          and target_id = ${JSON.stringify([scope.workspaceId, scope.app, scope.registration, scope.botId, scope.binding])}
      `);
        if (
          excluded.includes(scope.grant) ||
          (mapping?.legacyTool &&
            (excluded.includes(`tool:${mapping.legacyTool}`) ||
              excluded.includes(`audit:${mapping.legacyTool}`)))
        )
          throw new RevocationRefusal(
            "This capability was excluded from cutover.",
            409,
          );
      }
      const started = `corsair.${scope.app}.write_started`;
      const succeeded = `corsair.${scope.app}.write_succeeded`;
      const refused = `corsair.${scope.app}.write_refused`;
      const unconfirmed = `corsair.${scope.app}.write_unconfirmed`;
      const resolution = "corsair.migration_write_reconciled";
      const [lock] = await tx.execute<{ acquired: boolean }>(sql`
      select pg_try_advisory_xact_lock(hashtextextended(
        ${JSON.stringify(["corsair-write", scope.workspaceId, scope.app, scope.writeKey])}, 0
      )) as acquired
    `);
      if (!lock?.acquired)
        throw new RevocationRefusal(
          "A matching write is dispatching. Check its outcome first.",
          409,
        );
      const [earlier] = await tx.execute<{ blocked: boolean }>(sql`
      select exists (
        select 1 from audit_events current_attempt
        join audit_events previous on previous.event_type = ${started}
          and previous.payload->>'writeKey' = ${scope.writeKey}
          and coalesce(previous.payload->>'workspaceId', previous.payload->'target'->>'workspaceId') = ${scope.workspaceId}
          and (previous.created_at, previous.id) < (current_attempt.created_at, current_attempt.id)
        where current_attempt.event_type = ${started}
          and current_attempt.payload->>'approvalId' = ${scope.approvalId}
          and not exists (
            select 1 from audit_events outcome
            where outcome.payload->>'approvalId' = previous.payload->>'approvalId'
              and outcome.created_at >= previous.created_at
              and (
                outcome.event_type = ${succeeded}
                or (outcome.event_type = ${resolution} and outcome.payload->>'outcome' = 'not_applied')
                or (outcome.event_type = ${refused} and outcome.payload->>'dispatchRefused' = 'true' and not exists (
                  select 1 from audit_events uncertain
                  where uncertain.event_type = ${unconfirmed}
                    and uncertain.payload->>'approvalId' = previous.payload->>'approvalId'
                ))
              )
          )
      ) or exists (
        select 1 from audit_events review where review.event_type = ${resolution}
          and review.payload->>'approvalId' = ${scope.approvalId}
      ) as blocked
    `);
      if (earlier?.blocked)
        throw new RevocationRefusal(
          "Review the outcome of the matching write before retrying.",
          409,
        );
      return dispatchWhileConnected(database, connectionId, revision, send, tx);
    },
  );
}
