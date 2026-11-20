import { createHash, randomUUID } from "node:crypto";
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
export const cutoverObservationMs = 7 * 24 * 60 * 60 * 1000;

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
    evidence?: Record<string, unknown>,
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
          payload: { ...evidence, ...next },
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
    review(
      actorId: string,
      record: (tx: Transaction, current: State) => Promise<boolean>,
    ) {
      return transition(actorId, async (current, tx) =>
        (await record(tx, current)) ? current : null,
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
          until: new Date(Date.now() + cutoverObservationMs).toISOString(),
          excluded,
        };
      });
    },
    rollback(
      actorId: string,
      evidence: Record<string, unknown>,
      legacyVerified: (
        tx: Transaction,
        current: Extract<State, { kind: "observing" }>,
      ) => Promise<boolean>,
    ) {
      return transition(
        actorId,
        async (current, tx) => {
          if (
            current.kind !== "observing" ||
            Date.parse(current.until) <= Date.now()
          )
            return null;
          return (await legacyVerified(tx, current))
            ? { kind: "legacy" }
            : null;
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
        if (current.kind === "cleanup")
          throw new RevocationRefusal(
            "Use the legacy cleanup inventory and impact review to withdraw the authorization.",
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

export function legacyCorsairScope(
  workspaceId: string | undefined,
  transport: string,
  url: string,
): Scope | undefined {
  const normalized = url.toLowerCase();
  const selected = corsairApp.safeParse(normalized.split("://")[1]);
  if (
    workspaceId &&
    selected.success &&
    (transport === "composio" || transport === "arcade") &&
    normalized === `${transport}://${selected.data}`
  )
    return { workspaceId, app: selected.data };
}

export function withLegacyCorsairRoute<T>(
  database: Database,
  workspaceId: string | undefined,
  transport: string,
  url: string,
  send: (tx?: Transaction) => Promise<T>,
) {
  const scope = legacyCorsairScope(workspaceId, transport, url);
  return scope
    ? createCorsairCutover(database, scope).dispatch("legacy", send)
    : send();
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

export const writeReconciledEvent = "corsair.migration_write_reconciled";
export function readUnknownWrites(
  db: Pick<Database, "execute">,
  { workspaceId, app }: Scope,
  {
    approvalId,
    excludeAttemptId,
    legacyOnly = false,
  }: {
    approvalId?: string;
    excludeAttemptId?: string;
    legacyOnly?: boolean;
  } = {},
) {
  return db.execute<{
    approvalId: string;
    startedAt: Date;
    route: "legacy" | "corsair";
    targetId: string;
    canReconcile: boolean;
  }>(sql`
      select s.payload->>'approvalId' as "approvalId", s.created_at as "startedAt",
        coalesce(s.payload->>'route', 'corsair') as route,
        s.target_id as "targetId",
        (s.created_at <= clock_timestamp() - interval '30 seconds' or exists (
          select 1 from audit_events u
          where u.event_type = ${`corsair.${app}.write_unconfirmed`}
            and u.payload->>'approvalId' = s.payload->>'approvalId'
        )) as "canReconcile"
      from audit_events s
      where s.event_type = ${`corsair.${app}.write_started`}
        and coalesce(s.payload->>'workspaceId', s.payload->'target'->>'workspaceId') = ${workspaceId}
        and (not ${legacyOnly} or s.payload->>'route' = 'legacy')
        and (${approvalId ?? null}::text is null or s.payload->>'approvalId' = ${approvalId ?? null})
        and s.payload->>'approvalId' is distinct from ${excludeAttemptId ?? null}
        and not exists (
          select 1 from audit_events r
          where r.payload->>'approvalId' = s.payload->>'approvalId'
            and r.created_at >= s.created_at
            and (
              r.event_type in (${`corsair.${app}.write_succeeded`}, ${writeReconciledEvent})
              or (r.event_type = ${`corsair.${app}.write_refused`} and r.payload->>'dispatchRefused' = 'true' and not exists (
                select 1 from audit_events u
                where u.event_type = ${`corsair.${app}.write_unconfirmed`}
                  and u.payload->>'approvalId' = s.payload->>'approvalId'
                  and u.created_at >= s.created_at
              ))
            )
        )
      order by s.created_at desc
      limit 100
    `);
}
export async function dispatchTrackedLegacyWrite<
  T extends {
    isError: boolean;
    accountGone?: true;
    actionNotAllowed?: true;
  },
>(
  database: Database,
  scope: Scope,
  attempt: {
    actorId: string;
    botId: string;
    ref: string;
    provider: "composio" | "arcade";
    vendorUserId: string;
    accountId?: string;
    credentialActorId: string;
    argumentDigest: string;
  },
  send: (
    tx: Transaction,
    invoke: (vendor: () => Promise<T>) => Promise<T>,
  ) => Promise<T>,
): Promise<T> {
  const approvalId = randomUUID();
  const { actorId, ref, ...details } = attempt;
  const log = (outcome: string, extra = {}) =>
    database.insert(auditEvents).values({
      eventType: `corsair.${scope.app}.write_${outcome}`,
      targetType: "mcp_tool",
      targetId: ref,
      actorUserId: actorId,
      createdAt: sql`clock_timestamp()`,
      payload: {
        workspaceId: scope.workspaceId,
        route: "legacy",
        approvalId,
        ...details,
        ...extra,
      },
    });
  // Commit before sending. A process crash must leave the attempt available for reconciliation.
  await log("started");
  let sent = false;
  let result: T;
  try {
    result = await createCorsairCutover(database, scope).dispatch(
      "legacy",
      async (tx) => {
        // The broker and Corsair can represent the same identity and target differently.
        // Until provider history resolves an ambiguous write, fence the whole app.
        const [lock] = await tx.execute<{ acquired: boolean }>(sql`
        select pg_try_advisory_xact_lock(hashtextextended(
          ${JSON.stringify(["corsair-broker-write", scope.workspaceId, scope.app])}, 0
        )) as acquired
      `);
        if (
          !lock?.acquired ||
          (await readUnknownWrites(tx, scope, { excludeAttemptId: approvalId }))
            .length ||
          !(await readUnknownWrites(tx, scope, { approvalId })).length
        )
          throw new RevocationRefusal(
            "A write may already have reached the provider. Check its outcome before retrying.",
            409,
          );
        const [applied] = await tx.execute<{ matching: boolean }>(sql`
          select exists (
            select 1 from audit_events started
            join audit_events review
              on review.event_type = ${writeReconciledEvent}
              and review.payload->>'approvalId' = started.payload->>'approvalId'
              and review.created_at >= started.created_at
              and review.target_id = ${JSON.stringify([scope.workspaceId, scope.app])}
            where started.event_type = ${`corsair.${scope.app}.write_started`}
              and started.payload->>'route' = 'legacy'
              and started.payload->>'workspaceId' = ${scope.workspaceId}
              and started.payload->>'provider' = ${attempt.provider}
              and started.payload->>'argumentDigest' = ${attempt.argumentDigest}
              and review.payload->>'outcome' = 'applied'
          ) as matching
        `);
        if (applied?.matching)
          throw new RevocationRefusal(
            "The matching broker write was confirmed applied. It cannot be retried.",
            409,
          );
        return send(tx, (vendor) => {
          sent = true;
          return vendor();
        });
      },
    );
  } catch (error) {
    if (sent) await log("unconfirmed");
    else await log("refused", { dispatchRefused: true });
    throw error;
  }
  if (result.accountGone || result.actionNotAllowed)
    await log("refused", { dispatchRefused: true });
  else await log(result.isError ? "unconfirmed" : "succeeded");
  return result;
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
      if ((await readUnknownWrites(tx, scope, { legacyOnly: true })).length)
        throw new RevocationRefusal(
          "A broker write may already have reached the provider. Check its outcome before retrying.",
          409,
        );
      const started = `corsair.${scope.app}.write_started`;
      const succeeded = `corsair.${scope.app}.write_succeeded`;
      const refused = `corsair.${scope.app}.write_refused`;
      const unconfirmed = `corsair.${scope.app}.write_unconfirmed`;
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
                or (outcome.event_type = ${writeReconciledEvent} and outcome.payload->>'outcome' = 'not_applied')
                or (outcome.event_type = ${refused} and outcome.payload->>'dispatchRefused' = 'true' and not exists (
                  select 1 from audit_events uncertain
                  where uncertain.event_type = ${unconfirmed}
                    and uncertain.payload->>'approvalId' = previous.payload->>'approvalId'
                ))
              )
          )
      ) or exists (
        select 1 from audit_events review where review.event_type = ${writeReconciledEvent}
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
