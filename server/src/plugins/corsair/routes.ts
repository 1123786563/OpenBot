import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { BotAccessCheck } from "../../agents/profile-policy";
import {
  type ApprovalAction,
  ApprovalNotFoundError,
  ApprovalRefusedError,
  type ApprovalStore,
} from "../../approvals/types";
import {
  type AuditEventInput,
  type AuditStore,
  recordAuditEvent,
} from "../../audit";
import { type AppVariables, requireAdmin } from "../../auth/guards";
import { decryptSecret, encryptSecret } from "../../credentials";
import type { Database } from "../../db/client";
import {
  githubPilotConnections,
  githubPilotDefaults,
  githubPilotGrants,
  githubPilotRepositories,
  githubPilotStates,
} from "../../db/schema/corsair";
import { brokeredAccounts } from "../../db/schema/plugins";
import { type GithubPilotProvider, githubId } from "./github";
import type { VerifiedLegacyGithubDefault } from "./legacy-defaults";

const tool = {
  ref: "corsair/github.create_issue",
  effect: "write",
  identity: "github_app_user",
  resource: "registered_installation_repository",
  permissions: { issues: "write" },
};
const id = z.uuid();
const botId = z.string().trim().min(1).max(200);
const invocation = z.strictObject({
  botId,
  connectionId: id.optional(),
  repositoryId: githubId,
  title: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value.trim().length > 0),
  body: z.string().max(32_000).optional(),
});
type Invocation = z.infer<typeof invocation> & { connectionId: string };
const digest = (value: string, encoding: "hex" | "base64url" = "hex") =>
  createHash("sha256").update(value).digest(encoding);

class PilotRefusal extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409 | 502,
  ) {
    super(message);
  }
}

type Deps = {
  workspaceId: string;
  registration: string;
  database: Database;
  provider: GithubPilotProvider;
  approvals: Pick<
    ApprovalStore,
    "open" | "get" | "decide" | "consume" | "saveResult" | "finish"
  >;
  audit: AuditStore;
  encryptionKey: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  clock?: () => Date;
  legacyDefaults?: readonly VerifiedLegacyGithubDefault[];
};

export function createGithubPilotRoutes({
  workspaceId,
  registration,
  database,
  provider,
  approvals,
  audit,
  encryptionKey,
  requireUser,
  canUseBot,
  clock = () => new Date(),
  legacyDefaults = [],
}: Deps) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    if (
      context.req.method !== "GET" &&
      context.req.header("X-OpenBot-Pilot") !== "github"
    )
      return context.json(
        { error: "The GitHub pilot request header is required." },
        403,
      );
    await next();
  });
  routes.onError((error, context) => {
    if (error instanceof PilotRefusal)
      return context.json({ error: error.message }, error.status);
    if (error instanceof ApprovalNotFoundError)
      return context.json({ error: "Approval unavailable." }, 404);
    if (error instanceof ApprovalRefusedError)
      return context.json(
        { error: "Approval unavailable for this action." },
        409,
      );
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return context.json({ error: "Invalid GitHub pilot request." }, 400);
    return context.json(
      { error: "The GitHub pilot could not complete the request." },
      500,
    );
  });

  const connectionScope = (personId: string) =>
    and(
      eq(githubPilotConnections.workspaceId, workspaceId),
      eq(githubPilotConnections.registration, registration),
      eq(githubPilotConnections.personId, personId),
    );
  const repositoryScope = (repositoryId: number) =>
    and(
      eq(githubPilotRepositories.workspaceId, workspaceId),
      eq(githubPilotRepositories.registration, registration),
      eq(githubPilotRepositories.repositoryId, String(repositoryId)),
    );
  const grantScope = (bot: string) =>
    and(
      eq(githubPilotGrants.workspaceId, workspaceId),
      eq(githubPilotGrants.registration, registration),
      eq(githubPilotGrants.botId, bot),
      eq(githubPilotGrants.toolRef, tool.ref),
    );
  const publicIdentity = {
    id: githubPilotConnections.id,
    githubUserId: githubPilotConnections.githubUserId,
    login: githubPilotConnections.login,
    expiresAt: githubPilotConnections.expiresAt,
  };

  const matchesDefault = and(
    eq(githubPilotDefaults.workspaceId, githubPilotConnections.workspaceId),
    eq(githubPilotDefaults.personId, githubPilotConnections.personId),
    eq(githubPilotDefaults.registration, githubPilotConnections.registration),
    eq(githubPilotDefaults.githubUserId, githubPilotConnections.githubUserId),
  );

  async function defaultConnectionId(personId: string) {
    const [row] = await database
      .select({ id: githubPilotConnections.id })
      .from(githubPilotConnections)
      .innerJoin(githubPilotDefaults, matchesDefault)
      .where(connectionScope(personId));
    return row?.id ?? null;
  }

  async function credential(personId: string, connectionId: string) {
    const [row] = await database
      .select()
      .from(githubPilotConnections)
      .where(
        and(
          connectionScope(personId),
          eq(githubPilotConnections.id, connectionId),
        ),
      );
    if (!row || row.expiresAt <= clock())
      throw new PilotRefusal(
        "This GitHub Connection requires authorization.",
        403,
      );
    return row;
  }

  async function permitted(actor: AppVariables["actor"], input: Invocation) {
    if (!(await canUseBot(actor, input.botId)))
      throw new PilotRefusal("This Bot is unavailable.", 403);
    const [grant] = await database
      .select({ bot: githubPilotGrants.botId })
      .from(githubPilotGrants)
      .where(grantScope(input.botId));
    if (!grant)
      throw new PilotRefusal("This Bot needs a GitHub pilot grant.", 403);
    const [repository] = await database
      .select()
      .from(githubPilotRepositories)
      .where(repositoryScope(input.repositoryId));
    if (!repository)
      throw new PilotRefusal(
        "This repository is outside the pilot scope.",
        403,
      );
    return {
      repository,
      connection: await credential(actor.id, input.connectionId),
    };
  }

  async function verifiedRepository(
    personId: string,
    connectionId: string,
    installationId: number,
    repositoryId: number,
  ) {
    const connection = await credential(personId, connectionId);
    try {
      const token = await decryptSecret(encryptionKey, connection.credential);
      const identity = await provider.identity(token);
      if (String(identity.id) !== connection.githubUserId)
        throw new Error("GitHub identity changed.");
      const repo = await provider.repository({
        token,
        installationId,
        repositoryId,
      });
      return { connection, token, repo };
    } catch {
      throw new PilotRefusal(
        "GitHub could not verify the user and repository permissions.",
        403,
      );
    }
  }

  routes.post("/connect", async (c) => {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const now = clock();
    await database
      .delete(githubPilotStates)
      .where(
        and(
          eq(githubPilotStates.workspaceId, workspaceId),
          eq(githubPilotStates.personId, c.var.actor.id),
          lt(githubPilotStates.expiresAt, now),
        ),
      );
    await database.insert(githubPilotStates).values({
      workspaceId,
      registration,
      personId: c.var.actor.id,
      stateHash: digest(state),
      verifier: await encryptSecret(encryptionKey, verifier),
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    return c.json(
      {
        authorizationUrl: provider.authorizationUrl({
          state,
          challenge: digest(verifier, "base64url"),
        }),
      },
      201,
    );
  });

  routes.get("/callback", async (c) => {
    const { state, code } = z
      .object({
        state: z.string().regex(/^[\w-]{43}$/),
        code: z.string().min(1).max(1024),
      })
      .parse(c.req.query());
    const [pending] = await database
      .delete(githubPilotStates)
      .where(
        and(
          eq(githubPilotStates.stateHash, digest(state)),
          eq(githubPilotStates.workspaceId, workspaceId),
          eq(githubPilotStates.registration, registration),
          eq(githubPilotStates.personId, c.var.actor.id),
          gt(githubPilotStates.expiresAt, clock()),
        ),
      )
      .returning({ verifier: githubPilotStates.verifier });
    if (!pending)
      throw new PilotRefusal(
        "This authorization attempt is invalid, expired, or already used.",
        409,
      );
    let verified: Awaited<ReturnType<GithubPilotProvider["exchange"]>>;
    try {
      verified = await provider.exchange({
        code,
        verifier: await decryptSecret(encryptionKey, pending.verifier),
      });
    } catch {
      throw new PilotRefusal(
        "GitHub could not verify the authorized user.",
        502,
      );
    }
    const { token, identity, expiresAt } = verified;
    const update = {
      login: identity.login,
      credential: await encryptSecret(encryptionKey, token),
      expiresAt,
      revision: randomUUID(),
    };
    const personId = c.var.actor.id;
    const githubUserId = String(identity.id);
    // Brokered accounts carry no workspace or verified GitHub subject. Both come from the evidence.
    const [evidence, conflictingEvidence] = legacyDefaults.filter(
      (entry) =>
        entry.workspaceId === workspaceId &&
        entry.registration === registration &&
        entry.personId === personId,
    );
    const { connection, inheritedFrom } = await database.transaction(
      async (tx) => {
        const [connection] = await tx
          .insert(githubPilotConnections)
          .values({
            workspaceId,
            registration,
            personId,
            githubUserId,
            ...update,
          })
          .onConflictDoUpdate({
            target: [
              githubPilotConnections.workspaceId,
              githubPilotConnections.personId,
              githubPilotConnections.registration,
              githubPilotConnections.githubUserId,
            ],
            set: update,
          })
          .returning(publicIdentity);
        if (!connection) throw new Error("Connection was not saved.");
        if (conflictingEvidence || evidence?.githubUserId !== identity.id)
          return { connection };
        const [legacy] = await tx
          .select({ id: brokeredAccounts.id })
          .from(brokeredAccounts)
          .where(
            and(
              eq(brokeredAccounts.id, evidence.brokeredAccountId),
              eq(brokeredAccounts.userId, personId),
              eq(brokeredAccounts.app, "github"),
              eq(brokeredAccounts.isDefault, true),
            ),
          )
          .for("share");
        if (!legacy) return { connection };
        const [inherited] = await tx
          .insert(githubPilotDefaults)
          .values({ workspaceId, registration, personId, githubUserId })
          .onConflictDoNothing()
          .returning({ githubUserId: githubPilotDefaults.githubUserId });
        return {
          connection,
          inheritedFrom: inherited ? evidence.evidenceRef : undefined,
        };
      },
    );
    await recordAuditEvent(audit, {
      eventType: "corsair.github.connected",
      actorUserId: c.var.actor.id,
      targetType: "connection",
      targetId: connection.id,
      payload: {
        workspaceId,
        githubUserId: identity.id,
        login: identity.login,
        ...(inheritedFrom
          ? { inheritedDefaultEvidenceRef: inheritedFrom }
          : {}),
      },
    });
    return c.json({ connectionId: connection.id, identity });
  });

  routes.get("/connections", async (c) => {
    const rows = await database
      .select({
        ...publicIdentity,
        defaultUserId: githubPilotDefaults.githubUserId,
      })
      .from(githubPilotConnections)
      .leftJoin(githubPilotDefaults, matchesDefault)
      .where(connectionScope(c.var.actor.id));
    return c.json({
      connections: rows.map(
        ({ defaultUserId: _defaultUserId, ...connection }) => connection,
      ),
      defaultConnectionId:
        rows.find((row) => row.defaultUserId !== null)?.id ?? null,
    });
  });

  routes.put("/connections/default", async (c) => {
    const { connectionId } = z
      .strictObject({ connectionId: id })
      .parse(await c.req.json());
    const personId = c.var.actor.id;
    const { githubUserId } = await credential(personId, connectionId);
    await database
      .insert(githubPilotDefaults)
      .values({ workspaceId, registration, personId, githubUserId })
      .onConflictDoUpdate({
        target: [
          githubPilotDefaults.workspaceId,
          githubPilotDefaults.personId,
          githubPilotDefaults.registration,
        ],
        set: { githubUserId },
      });
    return c.json({ defaultConnectionId: connectionId });
  });

  routes.post("/repositories", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const input = z
      .strictObject({
        connectionId: id,
        installationId: githubId,
        repositoryId: githubId,
      })
      .parse(await c.req.json());
    const { repo } = await verifiedRepository(
      c.var.actor.id,
      input.connectionId,
      input.installationId,
      input.repositoryId,
    );
    const row = {
      workspaceId,
      registration,
      repositoryId: String(repo.id),
      nodeId: repo.node_id,
      installationId: String(input.installationId),
      name: `${repo.owner.login}/${repo.name}`,
    };
    await database
      .insert(githubPilotRepositories)
      .values(row)
      .onConflictDoUpdate({
        target: [
          githubPilotRepositories.workspaceId,
          githubPilotRepositories.registration,
          githubPilotRepositories.repositoryId,
        ],
        set: {
          installationId: row.installationId,
          nodeId: row.nodeId,
          name: row.name,
        },
      });
    await recordAuditEvent(audit, {
      eventType: "corsair.github.repository_registered",
      actorUserId: c.var.actor.id,
      targetType: "github_repository",
      targetId: row.repositoryId,
      payload: row,
    });
    return c.json({
      repository: {
        id: repo.id,
        installationId: input.installationId,
        name: row.name,
      },
    });
  });

  routes.get("/repositories", async (c) =>
    c.json({
      repositories: await database
        .select({
          id: githubPilotRepositories.repositoryId,
          name: githubPilotRepositories.name,
        })
        .from(githubPilotRepositories)
        .where(
          and(
            eq(githubPilotRepositories.workspaceId, workspaceId),
            eq(githubPilotRepositories.registration, registration),
          ),
        ),
    }),
  );

  routes.delete("/repositories/:repositoryId", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const repositoryId = z.coerce
      .number()
      .pipe(githubId)
      .parse(c.req.param("repositoryId"));
    await database
      .delete(githubPilotRepositories)
      .where(repositoryScope(repositoryId));
    await recordAuditEvent(audit, {
      eventType: "corsair.github.repository_removed",
      actorUserId: c.var.actor.id,
      targetType: "github_repository",
      targetId: String(repositoryId),
      payload: { workspaceId, registration },
    });
    return c.body(null, 204);
  });

  routes.put("/bots/:botId/grant", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const bot = botId.parse(c.req.param("botId"));
    if (!(await canUseBot(c.var.actor, bot)))
      throw new PilotRefusal("This Bot is unavailable.", 403);
    const { enabled } = z
      .strictObject({ enabled: z.boolean() })
      .parse(await c.req.json());
    if (enabled)
      await database
        .insert(githubPilotGrants)
        .values({ workspaceId, registration, botId: bot, toolRef: tool.ref })
        .onConflictDoNothing();
    else await database.delete(githubPilotGrants).where(grantScope(bot));
    await recordAuditEvent(audit, {
      eventType: "corsair.github.grant_changed",
      actorUserId: c.var.actor.id,
      targetType: "bot",
      targetId: bot,
      payload: { workspaceId, tool: tool.ref, enabled },
    });
    return c.json({ enabled });
  });

  routes.get("/bots/:botId/tools", async (c) => {
    const bot = botId.parse(c.req.param("botId"));
    if (!(await canUseBot(c.var.actor, bot))) return c.json({ tools: [] });
    const [grant] = await database
      .select({ bot: githubPilotGrants.botId })
      .from(githubPilotGrants)
      .where(grantScope(bot));
    return c.json({ tools: grant ? [tool] : [] });
  });

  function actionFor(
    personId: string,
    input: Invocation,
    { connection, repository }: Awaited<ReturnType<typeof permitted>>,
    actionId: string,
  ): ApprovalAction {
    const target = {
      workspaceId,
      registration,
      connectionId: connection.id,
      credentialRevision: connection.revision,
      githubUserId: connection.githubUserId,
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
      repositoryNodeId: repository.nodeId,
      repository: repository.name,
    };
    const { title, body } = input;
    const args = { title, ...(body === undefined ? {} : { body }) };
    const binding = {
      actorId: personId,
      botId: input.botId,
      toolRef: tool.ref,
      effect: tool.effect,
      scope: workspaceId,
      target,
      args,
    };
    return {
      ...binding,
      dispatch: "explicit",
      account: connection.login,
      actionDigest: digest(JSON.stringify(binding)),
      runId: actionId,
      toolCallId: actionId,
      threadId: actionId,
      policy: {
        behaviour: "ask",
        source: "safety",
        closed: true,
        reason: "GitHub pilot issue creation requires one-time Approval.",
      },
      declined: {
        eventType: "corsair.github.write_refused",
        actorUserId: personId,
        targetType: "github_repository",
        targetId: repository.repositoryId,
        payload: {
          reason: "Person denied the Approval.",
          botId: input.botId,
          tool: tool.ref,
          target,
        },
      },
    };
  }

  routes.post("/approvals", async (c) => {
    const selection = invocation.parse(await c.req.json());
    const actor = c.var.actor;
    const connectionId =
      selection.connectionId ?? (await defaultConnectionId(actor.id));
    if (!connectionId)
      throw new PilotRefusal(
        "Choose a default from your newly authorized GitHub Connections or select one for this action.",
        409,
      );
    const input = { ...selection, connectionId };
    const action = actionFor(
      actor.id,
      input,
      await permitted(actor, input),
      randomUUID(),
    );
    const approval = await approvals.open(action);
    return c.json(
      {
        id: approval.id,
        status: approval.status,
        action: {
          tool,
          args: action.args,
          target: action.target,
          account: action.account,
        },
      },
      201,
    );
  });

  async function ownedApproval(personId: string, approvalId: string) {
    const record = await approvals.get(personId, approvalId);
    if (
      record.action.dispatch !== "explicit" ||
      record.action.toolRef !== tool.ref ||
      record.action.scope !== workspaceId ||
      !z
        .object({ registration: z.literal(registration) })
        .safeParse(record.action.target).success
    )
      throw new ApprovalNotFoundError();
    return record;
  }

  routes.post("/approvals/:id/decision", async (c) => {
    const approvalId = id.parse(c.req.param("id"));
    const actor = c.var.actor;
    await ownedApproval(actor.id, approvalId);
    const { decision } = z
      .strictObject({ decision: z.enum(["allow_once", "deny"]) })
      .parse(await c.req.json());
    const record = await approvals.decide(actor.id, approvalId, decision);
    return c.json({ id: record.id, status: record.status });
  });

  routes.post("/approvals/:id/execute", async (c) => {
    const approvalId = id.parse(c.req.param("id"));
    const invocationArgs = invocation.parse(await c.req.json());
    const actor = c.var.actor;
    const record = await ownedApproval(actor.id, approvalId);
    const pinned = z
      .object({ connectionId: id, repositoryId: z.string() })
      .parse(record.action.target);
    const input = { ...invocationArgs, connectionId: pinned.connectionId };
    const trail = (
      eventType: AuditEventInput["eventType"],
      payload: Record<string, unknown>,
    ) =>
      recordAuditEvent(audit, {
        eventType,
        actorUserId: actor.id,
        targetType: "github_repository",
        targetId: pinned.repositoryId,
        payload: {
          workspaceId,
          approvalId,
          botId: record.action.botId,
          tool: tool.ref,
          connectionId: input.connectionId,
          ...payload,
        },
      });
    let verified: Awaited<ReturnType<typeof verifiedRepository>>;
    try {
      if (record.status !== "approved" || record.decision !== "allow_once")
        throw new PilotRefusal("A current one-time Approval is required.", 409);
      if (
        invocationArgs.connectionId !== undefined &&
        invocationArgs.connectionId !== pinned.connectionId
      )
        throw new PilotRefusal(
          "The GitHub Connection no longer matches its Approval.",
          409,
        );
      const current = await permitted(actor, input);
      if (
        actionFor(actor.id, input, current, record.action.runId)
          .actionDigest !== record.action.actionDigest
      )
        throw new PilotRefusal(
          "The GitHub action no longer matches its Approval.",
          409,
        );
      verified = await verifiedRepository(
        actor.id,
        input.connectionId,
        Number(current.repository.installationId),
        input.repositoryId,
      );
      const recheck = await permitted(actor, input);
      if (
        verified.repo.node_id !== recheck.repository.nodeId ||
        verified.connection.revision !== recheck.connection.revision ||
        actionFor(actor.id, input, recheck, record.action.runId)
          .actionDigest !== record.action.actionDigest
      )
        throw new PilotRefusal("The GitHub authorization changed.", 409);
      if (
        !(await approvals.consume(
          actor.id,
          approvalId,
          record.action.actionDigest,
        ))
      )
        throw new PilotRefusal("This Approval is no longer available.", 409);
    } catch (error) {
      await trail("corsair.github.write_refused", {
        reason:
          error instanceof PilotRefusal
            ? error.message
            : "Authorization could not be verified.",
        target: record.action.target,
      });
      throw error;
    }
    const evidence = {
      target: record.action.target,
      githubUserId: verified.connection.githubUserId,
    };
    await trail("corsair.github.write_started", evidence);
    let result: Awaited<ReturnType<GithubPilotProvider["createIssue"]>>;
    try {
      result = await provider.createIssue({
        token: verified.token,
        repositoryNodeId: verified.repo.node_id,
        title: input.title,
        body: input.body,
      });
      if (String(result.user.id) !== verified.connection.githubUserId)
        throw new Error("GitHub returned an unexpected operator.");
    } catch {
      const reason =
        "GitHub did not confirm the write and its operator. Check the repository before requesting another Approval.";
      await trail("corsair.github.write_unconfirmed", evidence);
      await approvals.saveResult(actor.id, approvalId, {
        content: reason,
        error: reason,
      });
      await approvals.finish(actor.id, approvalId);
      throw new PilotRefusal(reason, 502);
    }
    await trail("corsair.github.write_succeeded", {
      ...evidence,
      issueId: result.id,
      issueNumber: result.number,
      url: result.htmlUrl,
    });
    await approvals.saveResult(actor.id, approvalId, {
      content: result.htmlUrl,
    });
    await approvals.finish(actor.id, approvalId);
    return c.json({ issue: result });
  });
  return routes;
}
