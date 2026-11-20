import { randomUUID } from "node:crypto";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  type AuditStore,
  createAuditStore,
  recordAuditEvent,
  withAuditTransaction,
} from "../../audit";
import type { AppVariables } from "../../auth/guards";
import type { Database } from "../../db/client";
import { corsairAccounts as accounts } from "../../db/schema/corsair-storage";

const evidence = z.enum([
  "unconfirmed",
  "provider",
  "manual",
  "not_applicable",
]);
const progress = z.object({
  disconnectedAt: z.iso.datetime(),
  access: evidence.exclude(["not_applicable"]),
  refresh: evidence,
});
type Progress = z.infer<typeof progress>;
type Capability = "access" | "refresh";
type Account = typeof accounts.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class RevocationRefusal extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
  }
}

export function revocationState(
  config: Account["config"],
): { status: "connected" } | (Progress & { status: "pending" | "revoked" }) {
  const parsed = progress.safeParse(config.openbotRevocation);
  if (!parsed.success) return { status: "connected" as const };
  const state = parsed.data;
  const status = complete(state) ? "revoked" : "pending";
  return { ...state, status };
}

function complete(state: Progress) {
  return state.access !== "unconfirmed" && state.refresh !== "unconfirmed";
}

const config = accounts.config;
export const canReconnect = (authorizedAfter: Date) => sql`
  NOT (${config} ? 'openbotRevocation')
  OR (${config}->'openbotRevocation'->>'access' <> 'unconfirmed'
    AND ${config}->'openbotRevocation'->>'refresh' <> 'unconfirmed'
    AND ${config}->'openbotRevocation'->>'disconnectedAt' < ${authorizedAfter.toISOString()})
`;
export const clearRevocation = sql`${config} - 'openbotRevocation'`;

// The Corsair account trigger derives these keys from the OpenBot account scope.
export const derivedAccountKeys = {
  tenantId: sql`default`,
  integrationId: sql`default`,
};

export async function dispatchWhileConnected<T>(
  database: Database,
  id: string,
  revision: string | undefined,
  dispatch: () => Promise<T>,
  transaction?: Transaction,
) {
  const send = async (tx: Transaction) => {
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, id),
          revision === undefined ? undefined : eq(accounts.revision, revision),
          sql`NOT (${accounts.config} ? 'openbotRevocation')`,
        ),
      )
      .for("share");
    if (!account)
      throw new RevocationRefusal(
        "The authorization changed before dispatch.",
        409,
      );
    return dispatch();
  };
  return transaction ? send(transaction) : database.transaction(send);
}

export function createRevocation({
  database,
  verify,
  refreshApplicable = true,
  clock = () => new Date(),
}: {
  database: Database;
  verify: (account: Account, capability: Capability) => Promise<boolean>;
  refreshApplicable?: boolean;
  clock?: () => Date;
}) {
  const find = async (scope: SQL | undefined, tx?: Transaction) => {
    const query = (tx ?? database).select().from(accounts).where(scope);
    const [row] = await (tx ? query.for("update") : query);
    if (!row) throw new RevocationRefusal("Authorization unavailable.", 404);
    return row;
  };

  async function save(
    tx: Transaction,
    audit: AuditStore,
    actorId: string,
    row: Account,
    state: Progress,
    eventType:
      | "corsair.authorization.disconnected"
      | "corsair.authorization.revocation_checked",
    evidenceRef?: string,
  ) {
    const config = { ...row.config, openbotRevocation: state };
    await tx
      .update(accounts)
      .set({
        config,
        ...(complete(state) && row.credential !== null
          ? { credential: "" }
          : {}),
        ...(eventType === "corsair.authorization.disconnected"
          ? { revision: randomUUID() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, row.id));
    const result = revocationState(config);
    await recordAuditEvent(audit, {
      eventType,
      actorUserId: actorId,
      targetType: row.kind === "slack-shared" ? "installation" : "connection",
      targetId: row.id,
      payload: {
        ...result,
        workspaceId: row.workspaceId ?? row.sharedWorkspaceId,
        registration: row.registration,
        ...(evidenceRef ? { evidenceRef } : {}),
      },
    });
    return result;
  }

  async function disconnect(scope: SQL | undefined, actorId: string) {
    return withAuditTransaction(database, async (tx, deferTap) => {
      const audit = createAuditStore(tx, deferTap);
      const row = await find(scope, tx);
      const current = revocationState(row.config);
      if (current.status !== "connected") return current;
      return save(
        tx,
        audit,
        actorId,
        row,
        {
          disconnectedAt: clock().toISOString(),
          access: "unconfirmed",
          refresh: refreshApplicable ? "unconfirmed" : "not_applicable",
        },
        "corsair.authorization.disconnected",
      );
    });
  }

  async function verifyCapability(row: Account, capability: Capability) {
    try {
      return await verify(row, capability);
    } catch {
      return false;
    }
  }

  async function retry(
    scope: SQL | undefined,
    actorId: string,
    confirmedScope?: (tx: Transaction) => Promise<Account[]>,
  ) {
    return withAuditTransaction(database, async (tx, deferTap) => {
      const audit = createAuditStore(tx, deferTap);
      const affected = await confirmedScope?.(tx);
      const row = await find(scope, tx);
      const current = revocationState(row.config);
      if (current.status === "connected")
        throw new RevocationRefusal("Disconnect the authorization first.", 409);
      if (current.status === "revoked") return current;
      for (const related of affected ?? []) {
        if (
          related.id !== row.id &&
          revocationState(related.config).status === "connected"
        )
          await save(
            tx,
            audit,
            actorId,
            related,
            {
              disconnectedAt: clock().toISOString(),
              access: "unconfirmed",
              refresh: "not_applicable",
            },
            "corsair.authorization.disconnected",
          );
      }
      const { status: _, ...state } = current;
      for (const capability of ["access", "refresh"] as const) {
        if (
          state[capability] === "unconfirmed" &&
          (await verifyCapability(row, capability))
        )
          state[capability] = "provider";
      }
      return save(
        tx,
        audit,
        actorId,
        row,
        state,
        "corsair.authorization.revocation_checked",
      );
    });
  }

  const manualEvidence = z.strictObject({
    capability: z.enum(["access", "refresh"]),
    evidenceRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/),
  });

  async function recordManualEvidence(
    scope: SQL | undefined,
    actorId: string,
    input: z.infer<typeof manualEvidence>,
  ) {
    return withAuditTransaction(database, async (tx, deferTap) => {
      const audit = createAuditStore(tx, deferTap);
      const row = await find(scope, tx);
      const current = revocationState(row.config);
      if (current.status === "connected")
        throw new RevocationRefusal("Disconnect the authorization first.", 409);
      const { status: _, ...state } = current;
      if (state[input.capability] !== "unconfirmed") return current;
      state[input.capability] = "manual";
      return save(
        tx,
        audit,
        actorId,
        row,
        state,
        "corsair.authorization.revocation_checked",
        input.evidenceRef,
      );
    });
  }

  async function list(scope: SQL | undefined) {
    const rows = await database
      .select({
        id: accounts.id,
        label: accounts.label,
        config: accounts.config,
      })
      .from(accounts)
      .where(and(scope, sql`${accounts.config} ? 'openbotRevocation'`));
    return rows.map(({ config, ...row }) => ({
      ...row,
      revocation: revocationState(config),
    }));
  }

  return {
    find,
    list,
    disconnect,
    retry,
    recordManualEvidence,
    manualEvidence,
  };
}

export function personalRevocationRoutes(
  service: ReturnType<typeof createRevocation>,
  scope: SQL | undefined,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const id = (value: string) => eq(accounts.id, z.uuid().parse(value));
  const lookup = (actor: AppVariables["actor"], connectionId: string) =>
    and(
      scope,
      id(connectionId),
      actor.role === "admin" ? undefined : eq(accounts.personId, actor.id),
    );

  routes.get("/revocations", async (c) =>
    c.json({
      connections: await service.list(
        and(scope, eq(accounts.personId, c.var.actor.id)),
      ),
    }),
  );
  routes.get("/:connectionId/revocation", async (c) => {
    const row = await service.find(
      lookup(c.var.actor, c.req.param("connectionId")),
    );
    return c.json(revocationState(row.config));
  });
  routes.delete("/:connectionId/revocation", async (c) => {
    const query = lookup(c.var.actor, c.req.param("connectionId"));
    await service.disconnect(query, c.var.actor.id);
    return c.json(await service.retry(query, c.var.actor.id));
  });
  routes.post("/:connectionId/revocation", async (c) =>
    c.json(
      await service.retry(
        lookup(c.var.actor, c.req.param("connectionId")),
        c.var.actor.id,
      ),
    ),
  );
  routes.put("/:connectionId/revocation/evidence", async (c) => {
    if (c.var.actor.role !== "admin")
      throw new RevocationRefusal("Administrator required.", 403);
    return c.json(
      await service.recordManualEvidence(
        lookup(c.var.actor, c.req.param("connectionId")),
        c.var.actor.id,
        service.manualEvidence.parse(await c.req.json()),
      ),
    );
  });
  return routes;
}
