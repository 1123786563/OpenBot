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
import { eventsStreamBody, SSE_HEADERS } from "./events";
import type { WorkshopStore } from "./store";
import {
  draftForCreate,
  nextRunAt,
  parsePreapproval,
  WorkshopScheduleRefusedError,
} from "./schedule";
import { recordAuditEvent } from "../audit";
import type { TurnOrchestrator } from "./orchestrator";
import { listTree, upload, UploadLimitError } from "./files";
import type { SandboxClient } from "../codesandbox/client";
import type { ShareScope, ShareService } from "./sharing";
import { translate } from "./events";

/** The sandbox readiness the snapshot reports, matching F1's WorkshopSandboxStatus. */
type SandboxStatus =
  | { kind: "ready" }
  | { kind: "not_configured"; reason: string }
  | { kind: "busy" };

/**
 * What app.ts mounts: the routes factory closes over the wiring (store, lock, bus,
 * orchestrator, sandbox clients) at the boot file, and receives the auth pair here. canUseBot
 * stays a required parameter of THIS factory — the deployment must answer "who may act as
 * this Bot" in the same breath as it mounts the workshop.
 */
export type WorkshopRoutesFactory = (input: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
}) => Hono<{ Variables: AppVariables }>;

export type WorkshopRoutesDeps = {
  store: WorkshopStore;
  bus: TurnEventBus;
  orchestrator: TurnOrchestrator;
  /** The Bot's sandbox client, or null where none is configured. */
  clientFor: (botId: string) => SandboxClient | null;
  /**
   * The share service the owner-side share endpoints ride (F8's contract). The public anonymous
   * surface mounts its own instance in public-routes.ts; this one exists because the panel's
   * "创建链接" button has to reach createShare/revokeShare through the same gate as everything
   * else — sharing.ts's resolveShareActor stays the ONLY canUseBot bypass, and it is not here.
   */
  sharing?: ShareService;
};

export function createWorkshopRoutes(input: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Required: a deployment that has not answered "who may act as this Bot" cannot mount this. */
  canUseBot: BotAccessCheck;
  deps: WorkshopRoutesDeps & {
    auditStore?: Parameters<typeof upload>[0]["auditStore"];
  };
}): Hono<{ Variables: AppVariables }> {
  const { store, bus, orchestrator, clientFor, auditStore, sharing } =
    input.deps;
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
        const usage = turn.usage as {
          inputTokens?: number;
          outputTokens?: number;
        } | null;
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
        // The plaintext never exists after creation (only the hash is stored), so the aggregate
        // can only say a link is live — the URL itself was handed out once, at mint time.
        shareUrl:
          session.shareTokenHash && !session.shareRevokedAt ? "live" : null,
        shareExpiresAt: session.shareExpiresAt?.toISOString() ?? null,
        shareRevokedAt: session.shareRevokedAt?.toISOString() ?? null,
      },
    });
  });

  // ── share (owner surface: mint and revoke; F8's contract) ────────────────────
  app.post("/:channelId/share", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const { session, actor } = gateResult;
    if (!sharing)
      return context.json({ error: "Sharing is not configured." }, 503);
    const body = (await context.req.json().catch(() => undefined)) as
      | { scope?: unknown; expiresInDays?: unknown }
      | undefined;
    const scope: ShareScope =
      body?.scope === "preview_download" ? "preview_download" : "preview";
    const expiresInDays =
      typeof body?.expiresInDays === "number" &&
      Number.isInteger(body.expiresInDays) &&
      body.expiresInDays > 0
        ? body.expiresInDays
        : undefined;
    const handle = await sharing.createShare({
      channelId: session.channelId,
      scope,
      expiresInDays,
      createdBy: actor.id,
    });
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "workshop.share_created",
        targetType: "workshop_session",
        targetId: session.id,
        actorUserId: actor.id,
        // The plaintext token never enters the trail (sharing.ts's rule); the handle is gone
        // the moment this response is written, so the row says a link was minted, not what it is.
        payload: { channel: session.channelId, scope },
      });
    }
    return context.json(
      {
        token: handle.token,
        shareUrl: handle.shareUrl,
        scope: handle.scope,
        expiresAt: handle.expiresAt?.toISOString() ?? null,
      },
      201,
    );
  });

  app.delete("/:channelId/share", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const { session, actor } = gateResult;
    if (!sharing)
      return context.json({ error: "Sharing is not configured." }, 503);
    await sharing.revokeShare(session.channelId);
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "workshop.share_revoked",
        targetType: "workshop_session",
        targetId: session.id,
        actorUserId: actor.id,
        payload: { channel: session.channelId },
      });
    }
    return context.json({ revoked: true });
  });

  // ── a settled turn's history, straight from the store (no stream) ────────────
  // The live SSE only runs while a turn is running; once it settles, the panel still owes
  // the reader the transcript. This reads the same rows the SSE would have delivered and
  // answers them in the same wire shape, so the view renders history and live identically.
  app.get("/:channelId/turns/:id/events", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const { session } = gateResult;
    const turnId = context.req.param("id");
    // The turn must belong to THIS session — a turn id from another channel is a 404, not a
    // cross-session read.
    const rows = await store.readEventsSince(turnId, 0, 5_000);
    if (rows.length === 0) {
      const turns = await store.listTurns(session.id);
      if (!turns.some((t) => t.id === turnId)) {
        return context.json({ error: "No such turn." }, 404);
      }
    }
    const events = rows.map((row) =>
      translate(row.seq, row.type, row.payload ?? {}),
    );
    return context.json({ turnId, events });
  });

  // ── turns ─────────────────────────────────────────────────────────────────────
  app.post("/:channelId/turns", async (context) => {
    const channelId = context.req.param("channelId");
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => undefined)) as
      | { botId?: unknown; prompt?: unknown }
      | undefined;
    // botId first, before anything is gated or created: the turn's Bot is the caller's claim,
    // and every check below reads it.
    const botId = typeof body?.botId === "string" ? body.botId : "";
    if (!botId)
      return context.json({ error: "botId is a required string." }, 400);
    if (!(await input.canUseBot(actor, botId)))
      return context.json(
        { error: "You may not run a turn as this Bot." },
        403,
      );
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (!prompt)
      return context.json({ error: "prompt is a required string." }, 400);

    // The session is created on first turn: a channel has no workshop until somebody turns to
    // the Bot in it, and the turn's own botId is the Bot the session binds to.
    const session = await store.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: actor.id,
    });
    if (session.botId !== botId)
      return context.json(
        { error: "botId does not match this channel's Bot." },
        400,
      );

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
    if (!artifact) return context.json({ error: "No such artifact." }, 404);

    const client = clientFor(gateResult.session.botId);
    if (!client)
      return context.json({ error: "Code execution is not configured." }, 409);
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
      return context.json({ error: "Code execution is not configured." }, 409);
    await client.resetWorkspace();
    return context.json({ sessionId: gateResult.session.id }, 200);
  });

  // ── the stream (B9) ───────────────────────────────────────────────────────────
  // ── schedules (B17b): CRUD behind the same gate every workshop route holds ─────
  app.get("/:channelId/schedules", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const [schedules, runs] = await Promise.all([
      store.listSchedules(gateResult.session.id),
      store.listScheduleRuns(gateResult.session.id),
    ]);
    return context.json({
      schedules: schedules.map((row) => ({
        id: row.id,
        prompt: row.prompt,
        rrule: row.rrule,
        timezone: row.timezone,
        status: row.status,
        preapproved: row.preapproved ?? null,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      runs: runs.map((run) => ({
        id: run.id,
        scheduleId: run.scheduleId,
        scheduledFor: run.scheduledFor.toISOString(),
        turnId: run.turnId,
        status: run.status,
        note: run.note,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post("/:channelId/schedules", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const body = (await context.req.json().catch(() => null)) as {
      prompt?: unknown;
      mode?: unknown;
      timezone?: unknown;
      preapproval?: unknown;
    } | null;
    const timezone =
      typeof body?.timezone === "string" && body.timezone.trim()
        ? body.timezone.trim()
        : "UTC";
    if (typeof body?.prompt !== "string" || !body?.prompt.trim()) {
      return context.json({ error: "A schedule needs a prompt." }, 400);
    }
    const mode = body?.mode;
    const shaped =
      mode && typeof mode === "object" && "kind" in mode
        ? (mode as { kind: string } & Record<string, unknown>)
        : null;
    if (!shaped) {
      return context.json({ error: "A schedule needs a mode." }, 400);
    }
    try {
      const draft = draftForCreate({
        prompt: body.prompt,
        mode: shaped as Parameters<typeof draftForCreate>[0]["mode"],
        timezone,
        preapproval: body?.preapproval,
      });
      const id = `sc-${crypto.randomUUID()}`;
      await store.createSchedule({
        id,
        sessionId: gateResult.session.id,
        createdBy: gateResult.actor.id,
        prompt: draft.prompt,
        rrule: draft.rrule,
        timezone,
        preapproved: draft.preapproval,
        nextRunAt: nextRunAt(draft.rrule, timezone, Date.now()),
      });
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "workshop.schedule_created",
          targetType: "workshop_schedule",
          targetId: id,
          actorUserId: gateResult.actor.id,
          payload: { session: gateResult.session.id, rrule: draft.rrule },
        });
      }
      return context.json(
        { id, rrule: draft.rrule, status: draft.status },
        201,
      );
    } catch (error) {
      if (error instanceof WorkshopScheduleRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.patch("/:channelId/schedules/:id", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const id = context.req.param("id");
    const existing = await store.scheduleById(id, gateResult.session.id);
    if (!existing) {
      return context.json({ error: "No such schedule." }, 404);
    }
    const body = (await context.req.json().catch(() => null)) as {
      prompt?: unknown;
      mode?: unknown;
      timezone?: unknown;
      preapproval?: unknown;
      enabled?: unknown;
    } | null;

    try {
      // The toggle alone is its own route's worth of intent: no recurrence change, no
      // preapproval change, just "stop firing" or "start again".
      if (
        typeof body?.enabled === "boolean" &&
        !body?.prompt &&
        !body?.mode &&
        !body?.preapproval
      ) {
        const status = body.enabled ? "enabled" : "paused";
        await store.updateSchedule(id, {
          status,
          // Paused holds no due moment; re-enabling recomputes one from the rule.
          nextRunAt: body.enabled
            ? nextRunAt(existing.rrule, existing.timezone ?? "UTC", Date.now())
            : null,
        });
        if (auditStore) {
          await recordAuditEvent(auditStore, {
            eventType: "workshop.schedule_enabled_toggled",
            targetType: "workshop_schedule",
            targetId: id,
            actorUserId: gateResult.actor.id,
            payload: { enabled: body.enabled },
          });
        }
        return context.json({ id, status });
      }

      const timezone =
        typeof body?.timezone === "string" && body.timezone.trim()
          ? body.timezone.trim()
          : (existing.timezone ?? "UTC");
      if (typeof body?.prompt !== "string" || !body.prompt.trim()) {
        return context.json({ error: "A schedule needs a prompt." }, 400);
      }
      let rrule = existing.rrule;
      if (body?.mode && typeof body.mode === "object" && "kind" in body.mode) {
        const draft = draftForCreate({
          prompt: body.prompt,
          mode: body.mode as Parameters<typeof draftForCreate>[0]["mode"],
          timezone,
          preapproval: body?.preapproval ?? existing.preapproved,
        });
        rrule = draft.rrule;
      }
      // The updated rule is validated by deriving its next occurrence — a rule that
      // cannot advance is a rule that will never fire.
      const next = nextRunAt(rrule, timezone, Date.now());
      await store.updateSchedule(id, {
        prompt: body.prompt.trim(),
        rrule,
        timezone,
        ...(body?.preapproval !== undefined
          ? { preapproved: parsePreapproval(body.preapproval) }
          : {}),
        nextRunAt: next,
      });
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "workshop.schedule_updated",
          targetType: "workshop_schedule",
          targetId: id,
          actorUserId: gateResult.actor.id,
          payload: { rrule },
        });
      }
      return context.json({ id, rrule, nextRunAt: next.toISOString() });
    } catch (error) {
      if (error instanceof WorkshopScheduleRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.delete("/:channelId/schedules/:id", async (context) => {
    const gateResult = await gate(context);
    if (!gateResult.ok) return gateResult.response;
    const id = context.req.param("id");
    const existing = await store.scheduleById(id, gateResult.session.id);
    if (!existing) {
      return context.json({ error: "No such schedule." }, 404);
    }
    await store.deleteSchedule(id);
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "workshop.schedule_deleted",
        targetType: "workshop_schedule",
        targetId: id,
        actorUserId: gateResult.actor.id,
        payload: {},
      });
    }
    return context.json({ ok: true, id });
  });

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

    // Through context.body rather than a bare Response: the middleware chain (CORS among
    // them) rebuilds bare responses in a shape Bun will not stream, and context.body keeps
    // the stream as the body it hands onward — verified live against the mounted chain.
    return context.body(
      eventsStreamBody({
        bus,
        store,
        turnIds,
        ...(Number.isFinite(lastEventId) ? { lastEventId } : {}),
        stopSignal: context.req.raw.signal,
      }),
      200,
      SSE_HEADERS,
    );
  });

  return app;
}
