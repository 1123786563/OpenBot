import { and, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import { decryptSecret } from "../../credentials";
import type { Database } from "../../db/client";
import {
  githubPilotConnections as connections,
  githubPilotEventReceipts as receipts,
  githubPilotRepositories as repositories,
  githubPilotEventTriggers as triggers,
} from "../../db/schema/corsair";
import { responsibilities } from "../../db/schema/responsibilities";
import { type GithubEventScope, githubPilotEventType } from "./event-ingress";
import { githubId } from "./github";
import { dispatchWhileConnected, RevocationRefusal } from "./revocation";

export type EventTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type GithubEventTrigger = typeof triggers.$inferSelect;
export type GithubReadAccess = "allowed" | "denied" | "retry";
export type CheckGithubEventRepository = (input: {
  token: string;
  userId: string;
  installationId: string;
  repositoryId: string;
  nodeId: string;
}) => Promise<GithubReadAccess>;
const triggerInput = z.strictObject({
  goalId: z.string().min(1).max(128),
  connectionId: z.uuid(),
  installationId: githubId,
  repositoryId: githubId,
  eventTypes: z
    .array(githubPilotEventType)
    .min(1)
    .max(githubPilotEventType.options.length),
});
const exposed = {
  id: triggers.id,
  goalId: triggers.goalId,
  connectionId: triggers.connectionId,
  installationId: triggers.installationId,
  repositoryId: triggers.repositoryId,
  eventTypes: triggers.eventTypes,
  createdAt: triggers.createdAt,
  disabledAt: triggers.disabledAt,
};

export function createGithubEventTriggers({
  database,
  workspaceId,
  registration,
  encryptionKey,
  checkRepository,
}: GithubEventScope & {
  database: Database;
  encryptionKey: string;
  checkRepository: CheckGithubEventRepository;
}) {
  const inScope = and(
    eq(triggers.workspaceId, workspaceId),
    eq(triggers.registration, registration),
  );
  const goalFor = (personId: string, goalId: string) =>
    database
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(
        and(
          eq(responsibilities.id, goalId),
          eq(responsibilities.ownerUserId, personId),
        ),
      );

  async function local(
    db: Database | EventTransaction,
    key: {
      personId: string;
      connectionId: string;
      installationId: string;
      repositoryId: string;
    },
    transaction?: EventTransaction,
  ) {
    const query = db
      .select({ connection: connections, repository: repositories })
      .from(connections)
      .innerJoin(
        repositories,
        and(
          eq(repositories.workspaceId, connections.workspaceId),
          eq(repositories.registration, connections.registration),
          eq(repositories.installationId, key.installationId),
          eq(repositories.repositoryId, key.repositoryId),
        ),
      )
      .where(
        and(
          eq(connections.workspaceId, workspaceId),
          eq(connections.registration, registration),
          eq(connections.id, key.connectionId),
          eq(connections.personId, key.personId),
          sql`${connections.expiresAt} > clock_timestamp()`,
        ),
      );
    const [record] = await (transaction ? query.for("share") : query);
    return record;
  }

  async function verify(
    record: NonNullable<Awaited<ReturnType<typeof local>>>,
  ): Promise<GithubReadAccess> {
    try {
      const token = await decryptSecret(
        encryptionKey,
        record.connection.credential,
      );
      return await dispatchWhileConnected(
        database,
        record.connection.id,
        record.connection.revision,
        () =>
          checkRepository({
            token,
            userId: record.connection.githubUserId,
            installationId: record.repository.installationId,
            repositoryId: record.repository.repositoryId,
            nodeId: record.repository.nodeId,
          }),
      );
    } catch (error) {
      if (error instanceof RevocationRefusal) return "denied";
      return "retry";
    }
  }

  async function currentBinding(
    db: Database | EventTransaction,
    trigger: GithubEventTrigger,
    personId: string,
    transaction?: EventTransaction,
  ) {
    if (
      trigger.disabledAt ||
      trigger.workspaceId !== workspaceId ||
      trigger.registration !== registration
    )
      return undefined;
    const record = await local(db, { ...trigger, personId }, transaction);
    if (
      record?.connection.revision === trigger.connectionRevision &&
      record.repository.nodeId === trigger.repositoryNodeId
    )
      return record;
  }

  return {
    async create(personId: string, input: z.output<typeof triggerInput>) {
      if (!(await goalFor(personId, input.goalId)).length)
        return { kind: "missing" } as const;
      const key = {
        personId,
        connectionId: input.connectionId,
        installationId: String(input.installationId),
        repositoryId: String(input.repositoryId),
      };
      const record = await local(database, key);
      if (!record) return { kind: "denied" } as const;
      const access = await verify(record);
      if (access !== "allowed") return { kind: access } as const;
      return database.transaction(async (tx) => {
        const [goal] = await tx
          .select({ id: responsibilities.id })
          .from(responsibilities)
          .where(
            and(
              eq(responsibilities.id, input.goalId),
              eq(responsibilities.ownerUserId, personId),
            ),
          )
          .for("share");
        if (!goal) return { kind: "missing" } as const;
        const current = await local(tx, key, tx);
        if (
          !current ||
          current.connection.revision !== record.connection.revision ||
          current.repository.nodeId !== record.repository.nodeId
        )
          return { kind: "denied" } as const;
        const [created] = await tx
          .insert(triggers)
          .values({
            workspaceId,
            registration,
            goalId: goal.id,
            connectionId: key.connectionId,
            connectionRevision: current.connection.revision,
            installationId: key.installationId,
            repositoryId: key.repositoryId,
            repositoryNodeId: current.repository.nodeId,
            eventTypes: [...new Set(input.eventTypes)],
          })
          .returning(exposed);
        if (!created) throw new Error("GitHub event trigger was not saved.");
        return { kind: "created", trigger: created } as const;
      });
    },
    async list(personId: string, goalId: string) {
      if (!(await goalFor(personId, goalId)).length) return null;
      return database
        .select(exposed)
        .from(triggers)
        .where(and(inScope, eq(triggers.goalId, goalId)));
    },
    async disable(personId: string, id: string) {
      const [disabled] = await database
        .update(triggers)
        .set({ disabledAt: sql`coalesce(${triggers.disabledAt}, now())` })
        .where(
          and(
            inScope,
            eq(triggers.id, id),
            sql`${triggers.goalId} in (select ${responsibilities.id} from ${responsibilities} where ${responsibilities.ownerUserId} = ${personId})`,
          ),
        )
        .returning({ id: triggers.id });
      return !!disabled;
    },
    async access(
      trigger: GithubEventTrigger,
      personId: string,
    ): Promise<GithubReadAccess> {
      const record = await currentBinding(database, trigger, personId);
      return record ? verify(record) : "denied";
    },
    async canReadEvidence(
      receiptId: string,
      triggerId: string,
      personId: string,
    ) {
      const [binding] = await database
        .select({ trigger: triggers })
        .from(triggers)
        .innerJoin(responsibilities, eq(responsibilities.id, triggers.goalId))
        .innerJoin(
          receipts,
          and(
            eq(receipts.workspaceId, triggers.workspaceId),
            eq(receipts.registration, triggers.registration),
            eq(receipts.installationId, triggers.installationId),
            eq(receipts.repositoryId, triggers.repositoryId),
          ),
        )
        .where(
          and(
            inScope,
            eq(receipts.id, receiptId),
            eq(triggers.id, triggerId),
            eq(responsibilities.ownerUserId, personId),
          ),
        );
      if (
        !binding ||
        (await this.access(binding.trigger, personId)) !== "allowed"
      )
        return false;
      return database.transaction((tx) =>
        this.stillAuthorized(tx, triggerId, personId),
      );
    },
    async stillAuthorized(
      transaction: EventTransaction,
      id: string,
      personId: string,
    ) {
      const [trigger] = await transaction
        .select()
        .from(triggers)
        .where(and(inScope, eq(triggers.id, id)))
        .for("share");
      return (
        !!trigger &&
        !!(await currentBinding(transaction, trigger, personId, transaction))
      );
    },
  };
}

export function createGithubEventTriggerRoutes({
  triggers,
  requireUser,
}: {
  triggers: ReturnType<typeof createGithubEventTriggers>;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("/triggers", requireUser);
  routes.use("/triggers/*", requireUser);
  routes.post("/triggers", async (c) => {
    if (c.req.header("X-OpenBot-Pilot") !== "github")
      return c.json({ error: "Pilot request header is required." }, 403);
    const input = triggerInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: "Invalid GitHub event trigger." }, 400);
    const result = await triggers.create(c.var.actor.id, input.data);
    switch (result.kind) {
      case "created":
        return c.json(result.trigger, 201);
      case "denied":
        return c.json({ error: "GitHub event read access was denied." }, 403);
      case "missing":
        return c.json({ error: "Goal not found." }, 404);
      case "retry":
        return c.json(
          { error: "GitHub event read access could not be checked." },
          503,
        );
    }
  });
  routes.get("/triggers", async (c) => {
    const goalId = c.req.query("goalId");
    if (!goalId) return c.json({ error: "Goal ID is required." }, 400);
    const rows = await triggers.list(c.var.actor.id, goalId);
    return rows ? c.json(rows) : c.json({ error: "Goal not found." }, 404);
  });
  routes.delete("/triggers/:id", async (c) => {
    if (c.req.header("X-OpenBot-Pilot") !== "github")
      return c.json({ error: "Pilot request header is required." }, 403);
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success || !(await triggers.disable(c.var.actor.id, id.data)))
      return c.json({ error: "Trigger not found." }, 404);
    return c.body(null, 204);
  });
  return routes;
}
