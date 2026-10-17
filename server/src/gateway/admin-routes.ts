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
    return context.json({
      readiness: verdict,
      endpoint: endpoint ?? null,
      credential: credential ?? null,
      probe: probe ?? null,
      extension: extension ?? null,
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
