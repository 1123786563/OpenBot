/**
 * The workshop's HTTP surface: /api/workshop/:channelId/**.
 *
 * `canUseBot` is required, not optional — the same reason the computer and codesandbox routes
 * demand it: mounting the workshop without answering "who may act as this Bot" is the one
 * wiring mistake that must not compile.
 *
 * THE AGGREGATE (GET /:channelId) is one request the whole tab renders from — session, turns,
 * artifacts, sandbox readiness, usage — because four round trips to paint a tab is four
 * chances to show a half-loaded workshop. The SSE endpoint (B9) lives here too: replay from
 * the store, live through the bus.
 */
import { Hono, type MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import type { TurnEventBus } from "./bus";
import { streamEventsResponse } from "./events";
import type { WorkshopStore } from "./store";
import type { TurnOrchestrator } from "./orchestrator";
import { listTree, upload, UploadLimitError } from "./files";
import type { SandboxClient } from "../codesandbox/client";

/** The sandbox readiness the snapshot reports, matching F1's WorkshopSandboxStatus. */
type SandboxStatus =
  | { kind: "ready" }
  | { kind: "not_configured"; reason: string }
  | { kind: "busy" };

export type WorkshopRoutesDeps = {
  store: WorkshopStore;
  bus: TurnEventBus;
  orchestrator: TurnOrchestrator;
  /** The Bot's sandbox client, or null where none is configured. */
  clientFor: (botId: string) => SandboxClient | null;
};

export function createWorkshopRoutes(input: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Required: a deployment that has not answered "who may act as this Bot" cannot mount this. */
  canUseBot: BotAccessCheck;
  deps: WorkshopRoutesDeps & { auditStore?: Parameters<typeof upload>[0]["auditStore"] };
}): Hono<{ Variables: AppVariables }> {
  const { store, bus, orchestrator, clientFor, auditStore } = input.deps;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", input.requireUser);

  /** What a route context hands the gate. */
  type GateContext = {
    var: { actor: AppVariables["actor"] };
    req: { param: (name: string) => string };
    json: (body: unknown, status?: number) => Response;
  };
  type SessionRow = NonNullable<
    Awaited<ReturnType<typeof store.sessionByChannel>>
  >;
  type GateOutcome =
    | { ok: false; response: Response }
    | { ok: true; session: SessionRow; actor: AppVariables["actor"] };

  /** Resolve channel → session, gate on the Bot, or answer. */
  const gate = async (context: GateContext): Promise<GateOutcome> => {
    const channelId = context.req.param("channelId");
    const session = await store
      .sessionByChannel(channelId)
      .catch(() => undefined);
    if (!session) {
      return {
        ok: false,
        response: context.json(
          { error: "No workshop session for this channel." },
          404,
        ),
      };
    }
    const actor = context.var.actor;
    if (!(await input.canUseBot(actor, session.botId))) {
      return {
        ok: false,
        response: context.json(
          { error: "You may not use this Bot's workshop." },
          403,
        ),
      };
    }
    return { ok: true, session, actor };
  };

  // ── the aggregate ─────────────────────────────────────────────────────────────
  app.get("/:channelId", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const { session } = gateResult;

    const [turns, artifacts] = await Promise.all([
      store.listTurns(session.id),
      store.listArtifacts(session.id),
    ]);

    // Usage is the sum across turns — a display copy; metering reads code_runs (server-side).
    const total = turns.reduce(
      (sum, turn) => {
        const usage = turn.usage as { inputTokens?: number; outputTokens?: number } | null;
        return {
          inputTokens: sum.inputTokens + (usage?.inputTokens ?? 0),
          outputTokens: sum.outputTokens + (usage?.outputTokens ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0 },
    );

    const client = clientFor(session.botId);
    const sandbox: SandboxStatus = client
      ? { kind: "ready" }
      : { kind: "not_configured", reason: "Code execution is not configured." };

    return context.json({
      session: {
        id: session.id,
        channelId: session.channelId,
        botId: session.botId,
        status: session.status,
        visibility: session.visibility,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      },
      turns: turns.map((turn) => ({
        id: turn.id,
        sessionId: turn.sessionId,
        turnIndex: turn.turnIndex,
        status: turn.status,
        initiator: turn.initiator,
        prompt: turn.prompt,
        error: turn.error,
        usage: turn.usage ?? null,
        startedAt: turn.startedAt.toISOString(),
        finishedAt: turn.finishedAt?.toISOString() ?? null,
      })),
      artifacts,
      sandbox,
      usage: { total },
      share: {
        visibility: session.visibility,
        scope: session.shareScope,
        shareUrl: session.shareTokenHash ? "/share/pending" : null,
        shareExpiresAt: session.shareExpiresAt?.toISOString() ?? null,
        shareRevokedAt: session.shareRevokedAt?.toISOString() ?? null,
      },
    });
  });

  // ── turns ─────────────────────────────────────────────────────────────────────
  app.post("/:channelId/turns", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const { session, actor } = gateResult;

    const body = (await context.req.json().catch(() => undefined)) as
      | { botId?: unknown; prompt?: unknown }
      | undefined;
    // botId must be present and match the session's Bot: the gate above checked the session,
    // but the caller's claim about WHICH Bot is what the orchestrator runs as.
    const botId = typeof body?.botId === "string" ? body.botId : "";
    if (!botId)
      return context.json({ error: "botId is a required string." }, 400);
    if (botId !== session.botId)
      return context.json(
        { error: "botId does not match this channel's Bot." },
        400,
      );
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (!prompt)
      return context.json({ error: "prompt is a required string." }, 400);

    const { turnId } = await orchestrator.enqueue({
      sessionId: session.id,
      prompt,
      actorUserId: actor.id,
      botId: session.botId,
      ownerUserId: session.ownerUserId,
    });
    return context.json({ turnId }, 200);
  });

  app.post("/:channelId/turns/:id/cancel", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const turnId = context.req.param("id");
    const cancelled = await orchestrator.cancel(turnId);
    return context.json({ cancelled }, 200);
  });

  // ── files ─────────────────────────────────────────────────────────────────────
  app.get("/:channelId/files", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const path = context.req.query("path") ?? "";
    const tree = await listTree(
      {
        store: store as never,
        clientFor,
        actorUserId: gateResult.actor.id,
      },
      gateResult.session.id,
      path,
    );
    return context.json(tree);
  });

  app.post("/:channelId/files/upload", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const { session, actor } = gateResult;

    // multipart: the browser streams bytes; the server enforces the limits (B5).
    const form = await context.req.formData().catch(() => null);
    if (!form)
      return context.json(
        { error: "The upload must be multipart form data." },
        400,
      );
    const contents: Array<{ name: string; content: string }> = [];
    for (const entry of form.getAll("files")) {
      if (entry instanceof File) {
        contents.push({ name: entry.name, content: await entry.text() });
      }
    }

    try {
      const result = await upload(
        {
          store: store as never,
          clientFor,
          actorUserId: actor.id,
          ...(auditStore ? { auditStore } : {}),
        },
        session.id,
        contents,
      );
      return context.json(result, 200);
    } catch (error) {
      if (error instanceof UploadLimitError)
        return context.json({ error: error.message }, 413);
      throw error;
    }
  });

  // ── artifacts ─────────────────────────────────────────────────────────────────
  app.get("/:channelId/artifacts/:id/download", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const artifactId = context.req.param("id");
    const artifacts = await store.listArtifacts(gateResult.session.id);
    const artifact = artifacts.find((row) => row.id === artifactId);
    if (!artifact)
      return context.json({ error: "No such artifact." }, 404);

    const client = clientFor(gateResult.session.botId);
    if (!client)
      return context.json(
        { error: "Code execution is not configured." },
        409,
      );
    // Single-file streaming; the directory-zip form arrives with the preview batch.
    const file = await client
      .readFile(artifact.path, 10 * 1024 * 1024)
      .catch(() => null);
    if (!file)
      return context.json(
        { error: "The artifact is no longer in the workspace." },
        410,
      );
    return context.body(file.content, 200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${encodeURIComponent(artifact.name)}"`,
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────────
  app.post("/:channelId/reset", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const client = clientFor(gateResult.session.botId);
    if (!client)
      return context.json(
        { error: "Code execution is not configured." },
        409,
      );
    await client.resetWorkspace();
    return context.json({ sessionId: gateResult.session.id }, 200);
  });

  // ── the stream (B9) ───────────────────────────────────────────────────────────
  app.get("/:channelId/events", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;

    const turns = await store.listTurns(gateResult.session.id);
    const turnIds = turns.slice(-1).map((turn) => turn.id);
    if (turnIds.length === 0)
      return context.json({ error: "This session has no turns yet." }, 404);

    const lastEventIdHeader = context.req.header("last-event-id");
    const lastEventId = lastEventIdHeader
      ? Number.parseInt(lastEventIdHeader, 10)
      : undefined;

    return streamEventsResponse({
      bus,
      store,
      turnIds,
      ...(Number.isFinite(lastEventId) ? { lastEventId } : {}),
      stopSignal: context.req.raw.signal,
    });
  });

  return app;
}
