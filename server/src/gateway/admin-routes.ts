/**
 * `/api/admin/gateway`: the administrator's gateway surface (Bifrost 01.8, #214) —
 * the one place an administrator configures the Bifrost gateway and reads
 * whether paid model capabilities may be enabled at all.
 *
 * ONE STATUS READ, THREE ACTIONS. `GET /status` is the read-only diagnostic:
 * the readiness verdict (01.7) with every blocking reason, the saved endpoint
 * and its configVersion (01.1), the redacted credential status (01.2), the
 * rate (01.3/01.4), and the persisted probe (01.5) and negotiation (01.6)
 * records. `PUT /endpoint`, `PUT /rate` and `POST /probe` are the actions the
 * screen drives; the credential itself is written through 01.2's dedicated
 * route, which stays the only writer of key material. The probe action is
 * also what lets an administrator reach a ready gateway: when its probe
 * succeeds, the same action runs the capability negotiation against the same
 * snapshot — without that, `gateway_readiness_extension_not_negotiated`
 * could never clear and "configure, then judge" would end permanently
 * not-ready.
 *
 * NO SECRETS, NO ORDINARY-USER EYES. Every route is administrator-only (the
 * route check guards the surface; the endpoint and credential services
 * re-check the writer's role against the same `user_roles` table — the seam
 * guards itself), the status answers the credential's fingerprint, never its
 * key, and `cache-control: no-store` keeps a status that names which key is
 * current from outliving the request that asked. Services the process never
 * wired answer tagged 503s — a missing gate refuses rather than guesses, the
 * same shape 01.2's routes answer with.
 */
import { type AppVariables, requireAdmin } from "../auth/guards";
import { enterpriseControls } from "../admin/controls";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  type GatewayAdminCredentialService,
  gatewayAdminCredentialControls,
} from "./admin-credential";
import {
  type GatewayCapabilityNegotiationService,
  gatewayCapabilityControls,
} from "./capability-negotiation";
import {
  type ConversionRateStore,
  createConversionRateStore,
} from "./conversion-rate-store";
import { notConfiguredConversionRateState } from "./conversion-rate";
import {
  type GatewayEndpointService,
  gatewayEndpointControls,
} from "./endpoint-config";
import {
  type GatewayProbeService,
  gatewayProbeControls,
} from "./probe";
import {
  gatewayReadinessControls,
  type GatewayReadinessService,
} from "./readiness";
import {
  type GatewayModelScopeService,
  gatewayModelScopeControls,
  MODEL_SCOPE_REASON_MAX_LENGTH,
} from "./model-scope";
import {
  type GatewayCatalogSyncService,
  GATEWAY_CATALOG_SYNC_STATE_ID,
  gatewayCatalogSyncControls,
} from "./catalog-sync";
import { gatewayKeyStateSyncControls } from "./key-state-sync";
import {
  createGatewayKeyDriftStore,
  GATEWAY_KEY_DRIFT_DECISIONS,
  serializeKeyDriftEvent,
  type GatewayKeyDriftStore,
} from "./key-drift";
import { type AuditStore, recordAuditEvent } from "../audit";
import { audioPathAvailabilityView } from "../billing/audio-path-admission";
import { modelRefKey } from "./catalog";
import { gatewayPriceSnapshotControls } from "./price-snapshot";

/**
 * The services this surface drives. Defaults resolve through the installed
 * controls, the way 01.5/01.6/01.7's accessors do — so app.ts mounts this
 * routes module with no new createApp parameter, and a test builds the routes
 * over its own services by handing in closures.
 */
export type GatewayAdminRouteDeps = {
  endpointService: () => GatewayEndpointService | undefined;
  credentialService: () => GatewayAdminCredentialService | undefined;
  rateStore: () => ConversionRateStore | undefined;
  probeService: () => GatewayProbeService | undefined;
  negotiationService: () => GatewayCapabilityNegotiationService | undefined;
  readinessService: () => GatewayReadinessService | undefined;
  /** The administrator's model open scope (03.7): the catalog view plus open/close. */
  modelScopeService: () => GatewayModelScopeService | undefined;
  /**
   * The installed catalog/price sync (03.4): the manual trigger calls its
   * `runSync()` so the click shares the timer's single-flight cell and the
   * same failure protection — never a second, unprotected sync (03.5).
   */
  syncService: () => GatewayCatalogSyncService | undefined;
  /** The append-only trail every executed trigger is written to (03.5). */
  auditStore: () => AuditStore | undefined;
  /**
   * The key field-drift events and their dispositions (05.9). Defaults through the
   * installed enterprise controls' database, the way the rate store does.
   */
  keyDriftStore: () => GatewayKeyDriftStore | undefined;
};

function defaultDeps(): GatewayAdminRouteDeps {
  return {
    endpointService: () => gatewayEndpointControls(),
    credentialService: () => gatewayAdminCredentialControls(),
    rateStore: () => {
      const controls = enterpriseControls();
      if (!controls) return undefined;
      return createConversionRateStore({ database: controls.deps.database });
    },
    probeService: () => gatewayProbeControls(),
    negotiationService: () => gatewayCapabilityControls(),
    readinessService: () => gatewayReadinessControls(),
    modelScopeService: () => gatewayModelScopeControls(),
    syncService: () => gatewayCatalogSyncControls(),
    auditStore: () => enterpriseControls()?.deps.auditStore,
    keyDriftStore: () => {
      const controls = enterpriseControls();
      if (!controls) return undefined;
      return createGatewayKeyDriftStore(
        controls.deps.database,
        // The trail write lives in the store — the one writer of dispositions — so the
        // act is audited no matter which surface triggers it.
        controls.deps.auditStore
          ? { auditStore: controls.deps.auditStore }
          : {},
      );
    },
  };
}

export function gatewayAdminRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps?: Partial<GatewayAdminRouteDeps>,
) {
  const resolved: GatewayAdminRouteDeps = { ...defaultDeps(), ...deps };
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  app.get("/status", async (context) => {
    const readiness = resolved.readinessService();
    if (!readiness) {
      return unavailable(
        context,
        "The gateway readiness gate is not available.",
        "gateway_readiness_gate_unavailable",
      );
    }
    // The verdict is the answer; every detail below is the evidence an
    // administrator acts on, and each is read independently — a read that
    // fails shows as an absent detail while the verdict's own blocking
    // reasons (the *_unavailable codes) carry the authoritative truth.
    const verdict = await readiness.evaluateGatewayReadiness();
    const endpoint = await readDetail(async () =>
      (await resolved.endpointService())?.readGatewayEndpoint(),
    );
    const credential = await readDetail(async () =>
      (await resolved.credentialService())?.readGatewayAdminCredential(),
    );
    const probe = await readDetail(async () =>
      (await resolved.probeService())?.readLastGatewayProbe(),
    );
    const extension = await readDetail(async () =>
      (await resolved.negotiationService())?.readLastGatewayNegotiation(),
    );
    const rateStore = resolved.rateStore();
    const rate = await (rateStore
      ? readDetailWith(
          () => rateStore.readConversionRate(),
          notConfiguredConversionRateState(),
        )
      : Promise.resolve(notConfiguredConversionRateState()));
    // 14.4 (#313): the audio path availability projection — the registry's structural
    // gaps verbatim plus, per audio-capable cell's LATEST snapshot, whether that basis
    // enables the path. Read independently like every other detail: the projection is
    // absent when no price snapshot service is wired, and the door's refusal (the
    // admission gate) stays the authority either way.
    const audioPaths = await readDetail(async () => {
      const snapshots = gatewayPriceSnapshotControls();
      if (!snapshots) return undefined;
      const latest = await snapshots.listLatestPriceSnapshots();
      return audioPathAvailabilityView(
        latest
          .filter(
            (snapshot) =>
              snapshot.ref.capability === "speech" ||
              snapshot.ref.capability === "transcription",
          )
          .map((snapshot) => ({
            ref: modelRefKey(snapshot.ref),
            dims: snapshot.dims,
          })),
      );
    });
    return context.json({
      readiness: verdict,
      endpoint: endpoint ?? null,
      credential: credential ?? null,
      probe: probe ?? null,
      extension: extension ?? null,
      audioPaths: audioPaths ?? null,
      // The exact rational is bigint in memory; JSON carries it as the
      // decimal strings the save input and every display use. A number would
      // round — the one thing a price basis must never do.
      rate:
        rate.configured && typeof rate.numerator === "bigint"
          ? {
              ...rate,
              numerator: rate.numerator.toString(),
              denominator: rate.denominator.toString(),
            }
          : rate,
    });
  });

  app.put("/endpoint", async (context) => {
    const endpoint = resolved.endpointService();
    if (!endpoint) {
      return unavailable(
        context,
        "The gateway endpoint configuration is not available.",
        "gateway_endpoint_unavailable",
      );
    }
    const input = await context.req.json().catch(() => null);
    const result = await endpoint.saveGatewayEndpoint(input, {
      userId: context.var.actor.id,
      email: context.var.actor.email,
    });
    if (!result.ok) {
      return context.json({ error: result.error }, result.status);
    }
    return context.json({ endpoint: result.config });
  });

  app.put("/rate", async (context) => {
    const rateStore = resolved.rateStore();
    if (!rateStore) {
      return unavailable(
        context,
        "The conversion rate configuration is not available.",
        "gateway_rate_unavailable",
      );
    }
    const input = await context.req.json().catch(() => null);
    const result = await rateStore.save(input, context.var.actor.email);
    if (!result.ok) {
      return context.json(
        {
          error: result.issues.map((issue) => issue.message).join("; "),
          issues: result.issues,
        },
        400,
      );
    }
    return context.json({
      // The exact rational leaves as decimal strings — bigint would fail to
      // serialize, and a number would round.
      rate: {
        numerator: result.numerator.toString(),
        denominator: result.denominator.toString(),
        rateVersion: result.rateVersion,
      },
    });
  });

  app.post("/probe", async (context) => {
    const probe = resolved.probeService();
    if (!probe) {
      return unavailable(
        context,
        "The gateway probe is not available.",
        "gateway_probe_unavailable",
      );
    }
    const run = await probe.probeGateway();
    if (!run.ready) {
      return context.json(
        {
          error:
            "The probe did not run: the gateway address or admin credential is missing.",
          code: run.reasonCode,
        },
        409,
      );
    }
    // A successful probe is the negotiation's own precondition, so the same
    // action completes the verdict an administrator needs; a probe that did
    // not succeed leaves the stored verdict alone (01.6 reads and retires it
    // itself — nothing here re-labels history).
    const negotiationService = resolved.negotiationService();
    const negotiation =
      run.result.status === "ok" && negotiationService
        ? await negotiationService.negotiateGatewayCapabilities()
        : null;
    return context.json({ probe: run.result, negotiation });
  });

  /**
   * The model catalog as the administrator's open-scope page reads it (03.7): every
   * last-good ref with its price classification and current scope decision. A ref with
   * no scope decision is closed — the default a sync must arrive at — and the answer
   * says so with `scope: null` rather than inventing a decision nobody made.
   */
  app.get("/models", async (context) => {
    const modelScope = resolved.modelScopeService();
    if (!modelScope) {
      return unavailable(
        context,
        "The model open scope is not available.",
        "gateway_model_scope_unavailable",
      );
    }
    const models = await modelScope.listAdminCatalog();
    return context.json({ models });
  });

  /**
   * Open or close one ModelRef (03.7). The state and the reason travel together — a
   * change without a why is not a change this surface accepts — and every accepted
   * change is audited by the service. A refusal carries its fixed displayable code.
   */
  app.put("/models/scope", async (context) => {
    const modelScope = resolved.modelScopeService();
    if (!modelScope) {
      return unavailable(
        context,
        "The model open scope is not available.",
        "gateway_model_scope_unavailable",
      );
    }
    const input = (await context.req.json().catch(() => null)) as {
      provider?: unknown;
      model?: unknown;
      capability?: unknown;
      state?: unknown;
      reason?: unknown;
    } | null;
    if (
      !input ||
      typeof input.provider !== "string" ||
      input.provider.trim() === "" ||
      typeof input.model !== "string" ||
      input.model.trim() === "" ||
      typeof input.capability !== "string" ||
      (input.state !== "open" && input.state !== "closed") ||
      typeof input.reason !== "string"
    ) {
      return context.json(
        {
          error:
            "The scope change needs provider, model, capability, state (open or closed) and a reason.",
          code: "model_scope_input_invalid",
        },
        400,
      );
    }
    if (input.reason.trim().length > MODEL_SCOPE_REASON_MAX_LENGTH) {
      return context.json(
        {
          error: `The reason must be at most ${MODEL_SCOPE_REASON_MAX_LENGTH} characters.`,
          code: "model_scope_reason_too_long",
        },
        400,
      );
    }
    const result =
      input.state === "open"
        ? await modelScope.openModel({
            ref: {
              provider: input.provider,
              model: input.model,
              capability: input.capability as never,
            },
            reason: input.reason,
            actor: { userId: context.var.actor.id, email: context.var.actor.email },
          })
        : await modelScope.closeModel({
            ref: {
              provider: input.provider,
              model: input.model,
              capability: input.capability as never,
            },
            reason: input.reason,
            actor: { userId: context.var.actor.id, email: context.var.actor.email },
          });
    if (!result.ok) {
      // Input problems are the caller's (400); a ref the catalog does not hold is
      // not there (404); a price basis that cannot be opened against is a state
      // the administrator resolves (409).
      const status =
        result.reasonCode === "model_scope_ref_not_in_catalog"
          ? 404
          : result.reasonCode === "model_scope_price_missing" ||
              result.reasonCode === "model_scope_price_unknown"
            ? 409
            : 400;
      return context.json(
        { error: result.reasonCode, code: result.reasonCode },
        status,
      );
    }
    return context.json({ scope: result.record });
  });

  /**
   * Sync now (03.5): the administrator's immediate catalog/price sync. The
   * action is the installed sync service's own `runSync()` — the same
   * implementation, single-flight and failure protection the timer runs —
   * and its outcome is the answer, success or the failing layer's fixed
   * reason code. Every executed trigger is audited before the outcome is
   * answered: an unaudited trigger is not a success.
   */
  app.post("/catalog/sync", async (context) => {
    const sync = resolved.syncService();
    const audit = resolved.auditStore();
    if (!sync || !audit) {
      return unavailable(
        context,
        "The catalog sync service is not available.",
        "gateway_catalog_sync_unavailable",
      );
    }
    const outcome = await sync.runSync();
    await recordAuditEvent(audit, {
      eventType: "gateway.catalog_sync_triggered",
      targetType: "gateway_catalog",
      targetId: GATEWAY_CATALOG_SYNC_STATE_ID,
      actorUserId: context.var.actor.id,
      payload:
        outcome.status === "ok"
          ? {
              trigger: "manual",
              outcome: "ok",
              syncedAt: outcome.syncedAt,
              appended: outcome.appended,
              skipped: outcome.skipped,
              configVersion: outcome.record.configVersion,
            }
          : {
              trigger: "manual",
              outcome: "failed",
              stage: outcome.stage,
              reasonCode: outcome.reasonCode,
              failedAt: outcome.failedAt,
            },
    });
    return context.json({ result: outcome });
  });

  // The key state sync's manual trigger (Bifrost 05.8, #249): the same single-flight cell
  // the scheduler runs on, answered here for an administrator who wants the pass now —
  // a key the gateway just disabled stops being usable on the answer, not the next tick.
  app.post("/keys/sync", async (context) => {
    const controls = gatewayKeyStateSyncControls();
    if (!controls) {
      return unavailable(
        context,
        "The key state sync is not running in this deployment.",
        "gateway_key_sync_unavailable",
      );
    }
    const outcome = await controls.runSync();
    const audit = resolved.auditStore();
    if (audit) {
      await recordAuditEvent(audit, {
        eventType: "gateway.key_state_sync_triggered",
        targetType: "gateway_key_sync",
        targetId: "singleton",
        actorUserId: context.var.actor.id,
        payload: {
          trigger: "manual",
          outcome: outcome.status,
        },
      });
    }
    return context.json({ result: outcome });
  });

  // The key drift surface (Bifrost 05.9, #250): the field-drift events the sync records,
  // and the one human act that ends each one. A list for "what drifted and what is still
  // outstanding", and a disposal that writes the operator's decision exactly once — the
  // pause is the outstanding event, so disposing of it is what lifts the pause.
  app.get("/key-drift", async (context) => {
    const store = resolved.keyDriftStore();
    if (!store) {
      return unavailable(
        context,
        "The key drift surface is not available in this deployment.",
        "gateway_key_drift_unavailable",
      );
    }
    const grantId = context.req.query("grantId");
    const keyId = context.req.query("keyId");
    const outstandingOnly = context.req.query("outstanding") === "true";
    const events = await store.listEvents({
      ...(grantId ? { grantId } : {}),
      ...(keyId ? { keyId } : {}),
      ...(outstandingOnly ? { outstandingOnly: true } : {}),
    });
    return context.json({ events: events.map(serializeKeyDriftEvent) });
  });

  app.post("/key-drift/:eventId/dispose", async (context) => {
    const store = resolved.keyDriftStore();
    if (!store) {
      return unavailable(
        context,
        "The key drift surface is not available in this deployment.",
        "gateway_key_drift_unavailable",
      );
    }
    const eventId = context.req.param("eventId");
    const input = (await context.req.json().catch(() => null)) as {
      decision?: unknown;
      note?: unknown;
    } | null;
    if (
      !input ||
      typeof input.decision !== "string" ||
      !GATEWAY_KEY_DRIFT_DECISIONS.includes(
        input.decision as never,
      )
    ) {
      return context.json(
        {
          error: `The disposal needs a decision: one of ${GATEWAY_KEY_DRIFT_DECISIONS.join(", ")}.`,
          code: "gateway_key_drift_decision_invalid",
        },
        400,
      );
    }
    if (input.note !== undefined && typeof input.note !== "string") {
      return context.json(
        {
          error: "The disposal note, when given, must be a string.",
          code: "gateway_key_drift_note_invalid",
        },
        400,
      );
    }
    const existing = await store.getEvent(eventId);
    if (!existing) {
      return context.json(
        { error: "No such key drift event.", code: "gateway_key_drift_event_unknown" },
        404,
      );
    }
    const result = await store.dispose({
      eventId,
      decision: input.decision as never,
      disposedBy: context.var.actor.id,
      ...(typeof input.note === "string" && input.note.trim() !== ""
        ? { note: input.note }
        : {}),
    });
    if (!result.disposed) {
      // The decision is written exactly once: a second disposal of the same event
      // changes nothing and says so.
      return context.json(
        {
          error: "The key drift event is already disposed of.",
          code: "gateway_key_drift_already_disposed",
        },
        409,
      );
    }
    const disposed = await store.getEvent(eventId);
    return context.json({
      event: disposed ? serializeKeyDriftEvent(disposed) : null,
      keyRevoked: result.keyRevoked,
    });
  });

  return app;
}

async function readDetail<T>(read: () => Promise<T | undefined>): Promise<T | null> {
  try {
    return (await read()) ?? null;
  } catch {
    // The verdict's own blocking reasons carry this; the detail is evidence,
    // not truth, and a failed read must not fail the whole status answer.
    return null;
  }
}

async function readDetailWith<T>(
  read: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

function unavailable(
  context: Context<{ Variables: AppVariables }>,
  error: string,
  code: string,
) {
  return context.json({ error, code }, 503);
}
