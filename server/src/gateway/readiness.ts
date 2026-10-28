/**
 * The gateway readiness gate (Bifrost 01.7): the one door every paid model
 * capability passes, and the reason none of them can sneak past it.
 *
 * FIVE CONJUNCTIVE CONDITIONS, ONE VERDICT. The gateway may serve paid work
 * only when the address is configured (01.1), the admin credential resolves
 * (01.2), the last probe succeeded *for the current configuration* (01.5),
 * the credit-admission extension is present at a compatible version (01.6),
 * and the USD→credits conversion rate is configured and legal (01.3/01.4).
 * The conditions are assessed independently and the refusal names every unmet
 * one — an administrator fixing four of five problems should not rediscover
 * the fifth one by trial and error. `billingAdmission()` (conversion-rate.ts)
 * remains the rate branch's own seam; this module is where the branches
 * become one answer.
 *
 * READS, NEVER DIALS. The gate evaluates what is on file: the saved
 * configuration rows and the latest persisted probe result and negotiation
 * verdict. It never opens a network connection on a request path — running a
 * probe or a negotiation is 01.8's administrative surface, and a verdict that
 * predates the current configuration is retired by exactly the rule 01.6's
 * reader uses (`configVersion` must match). "Never probed" is therefore
 * "not ready": an unverified gateway is a closed gateway.
 *
 * NO FALLBACK, NO DEGRADATION. A refusal is an error thrown at the caller
 * (`GatewayNotReadyError`); there is no code path here that downgrades to a
 * provider direct connection, free usage, or a partial capability. The same
 * holds when the gate itself is missing — a process that never installed it
 * refuses paid work (`gateway_readiness_gate_unavailable`) rather than waving
 * it through. Every blocking reason is a fixed constant of this module, and
 * the refusal sentences interpolate nothing but the probe's own sanitized
 * status enum: no address, no credential, no upstream bytes can ride on a
 * refusal.
 *
 * WHO CALLS THIS. Downstream consumers — catalog sync (03.x), key issuance
 * (05.x), reservation (06.x), invocation admission (07.x) — call
 * `assertGatewayReadyForBilling()` and treat the thrown refusal as the end of
 * their path. `tests/gateway-readiness-gate.test.ts` carries the call-site
 * inventory that keeps this true: a production file outside the gateway
 * module and the app wiring cannot reach the condition sources at all.
 */
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { GatewayAdminCredentialNotConfiguredError } from "./admin-credential";
import type { GatewayNegotiationRecord } from "./capability-negotiation";
import { billingAdmission, type ConversionRateState } from "./conversion-rate";
import type { GatewayEndpointConfig } from "./endpoint-config";
import type { GatewayProbeRecord } from "./probe";

/**
 * Why the gate refuses. Every code is displayable (fixed constants, no
 * upstream data) and names one conjunctive condition — or the gate's own
 * absence, which refuses too.
 */
export type GatewayReadinessReasonCode =
  | "gateway_readiness_endpoint_not_configured"
  | "gateway_readiness_endpoint_unavailable"
  | "gateway_readiness_credential_not_configured"
  | "gateway_readiness_credential_unavailable"
  | "gateway_readiness_probe_missing"
  | "gateway_readiness_probe_not_ok"
  | "gateway_readiness_probe_unavailable"
  | "gateway_readiness_extension_not_negotiated"
  | "gateway_readiness_extension_absent"
  | "gateway_readiness_extension_incompatible"
  | "gateway_readiness_extension_unavailable"
  | "gateway_readiness_rate_not_configured"
  | "gateway_readiness_rate_unavailable"
  | "gateway_readiness_gate_unavailable";

/** The contract 01.8's screen and every downstream consumer lock against. */
export type GatewayReadiness = {
  ready: boolean;
  /** Every unmet condition, not just the first. Each is displayable. */
  blockingReasons: readonly GatewayReadinessReasonCode[];
  /**
   * The endpoint configuration version the verdict speaks of — the number a
   * downstream consumer locks so its work cannot be re-labeled by a later
   * configuration change. `0` is the unconfigured (pre-first-save) state.
   */
  configVersion: number;
  /** When the verdict was reached, ISO 8601. */
  checkedAt: string;
};

/** One unmet condition, with the sentence an administrator acts on. */
type Blocking = {
  reason: GatewayReadinessReasonCode;
  message: string;
};

export class GatewayNotReadyError extends Error {
  readonly readiness: GatewayReadiness;

  constructor(readiness: GatewayReadiness, blocking: readonly Blocking[]) {
    super(
      [
        "The model gateway is not ready, so paid model capabilities are refused. There is no fallback: no provider direct connection and no free usage.",
        // Each reason appears as its stable code — machine-checkable in logs —
        // followed by the sentence an administrator acts on.
        ...blocking.map((entry) => `${entry.reason}: ${entry.message}`),
      ].join(" "),
    );
    this.name = "GatewayNotReadyError";
    this.readiness = readiness;
  }
}

export type GatewayReadinessDeps = {
  /** 01.1: the current endpoint snapshot, or undefined when none is configured. */
  readGatewayEndpoint: () => Promise<GatewayEndpointConfig | undefined>;
  /** 01.2's internal resolve — the only place the admin key's plaintext may come from. */
  resolveGatewayAdminCredential: () => Promise<{ adminKey: string }>;
  /** 01.5: the latest persisted probe result, or undefined when none survives. */
  readLastGatewayProbe: () => Promise<GatewayProbeRecord | undefined>;
  /** 01.6: the latest persisted verdict, already retired when the configuration moved. */
  readLastGatewayNegotiation: () => Promise<
    GatewayNegotiationRecord | undefined
  >;
  /** 01.3/01.4: the current conversion-rate state (a corrupt stored row throws). */
  readConversionRate: () => Promise<ConversionRateState>;
  /** Injectable clock for tests. */
  now?: () => Date;
  log?: Logger;
};

export type GatewayReadinessService = {
  /** The verdict, from what is on file. Never dials the network; never throws. */
  evaluateGatewayReadiness: () => Promise<GatewayReadiness>;
  /**
   * The single gate: the readiness when paid work may proceed, and a
   * `GatewayNotReadyError` — carrying every unmet condition — when it may
   * not. Callers treat the throw as the end of their path: no fallback.
   */
  assertGatewayReadyForBilling: () => Promise<GatewayReadiness>;
};

export function createGatewayReadinessService(
  deps: GatewayReadinessDeps,
): GatewayReadinessService {
  const log = deps.log ?? getLogger("server");
  const now = deps.now ?? (() => new Date());

  const evaluate = async (): Promise<{
    readiness: GatewayReadiness;
    blocking: Blocking[];
  }> => {
    const blocking: Blocking[] = [];
    let configVersion = 0;

    // Condition 1: the address is configured.
    let endpoint: GatewayEndpointConfig | undefined;
    // True when the read itself failed. The remaining conditions then cannot say anything
    // about configuration, probing or negotiation — reporting "not configured", "probe
    // missing" or "not negotiated" on top of the failure would be misleading — so only
    // the failure reason is reported.
    let endpointUnreadable = false;
    try {
      endpoint = await deps.readGatewayEndpoint();
    } catch (error) {
      log.error(
        {
          type: "gateway-readiness-condition-failed",
          condition: "endpoint",
          errorName: error instanceof Error ? error.name : String(error),
        },
        "The gateway endpoint configuration could not be read.",
      );
      blocking.push({
        reason: "gateway_readiness_endpoint_unavailable",
        message:
          "The gateway address could not be read, so paid model capabilities are refused until the failure is resolved.",
      });
      endpointUnreadable = true;
    }
    if (!endpointUnreadable && endpoint === undefined) {
      blocking.push({
        reason: "gateway_readiness_endpoint_not_configured",
        message:
          "No gateway address is configured, so paid model capabilities are refused: an administrator must save the gateway endpoint (or set BIFROST_GATEWAY_URL).",
      });
    } else if (endpoint !== undefined) {
      configVersion = endpoint.configVersion;
    }

    // Condition 2: the credential is usable.
    try {
      await deps.resolveGatewayAdminCredential();
    } catch (error) {
      if (error instanceof GatewayAdminCredentialNotConfiguredError) {
        blocking.push({
          reason: "gateway_readiness_credential_not_configured",
          message:
            "No gateway admin credential is configured, so paid model capabilities are refused: an administrator must save the gateway credential.",
        });
      } else {
        log.warn(
          {
            type: "gateway-readiness-condition-failed",
            condition: "credential",
            errorName: error instanceof Error ? error.name : String(error),
          },
          "The gateway admin credential could not be resolved.",
        );
        blocking.push({
          reason: "gateway_readiness_credential_unavailable",
          message:
            "The gateway admin credential could not be resolved, so paid model capabilities are refused until the failure is resolved.",
        });
      }
    }

    // Condition 3: the last probe succeeded, for this configuration. With no
    // configuration there is nothing a probe could answer for, so the
    // condition is unmet by definition — the same answer the negotiation
    // reader gives, and the same "never verified" verdict.
    try {
      const probe = await deps.readLastGatewayProbe();
      if (
        !endpointUnreadable &&
        (endpoint === undefined ||
          probe === undefined ||
          probe.configVersion !== configVersion)
      ) {
        blocking.push({
          reason: "gateway_readiness_probe_missing",
          message:
            "No successful gateway probe is on file for the current gateway configuration, so paid model capabilities are refused: run a probe after configuring the gateway.",
        });
      } else if (
        !endpointUnreadable &&
        probe !== undefined &&
        probe.status !== "ok"
      ) {
        blocking.push({
          reason: "gateway_readiness_probe_not_ok",
          message: `The last gateway probe did not succeed (status: ${probe.status}), so paid model capabilities are refused: fix what the probe reports and probe again.`,
        });
      }
    } catch (error) {
      log.error(
        {
          type: "gateway-readiness-condition-failed",
          condition: "probe",
          errorName: error instanceof Error ? error.name : String(error),
        },
        "The last gateway probe result could not be read.",
      );
      blocking.push({
        reason: "gateway_readiness_probe_unavailable",
        message:
          "The last gateway probe result could not be read, so paid model capabilities are refused until the failure is resolved.",
      });
    }

    // Condition 4: the credit-admission extension is present. The verdict
    // reader retires itself when the configuration moved, so undefined here
    // always means "not negotiated for this configuration".
    try {
      const negotiation = await deps.readLastGatewayNegotiation();
      if (
        !endpointUnreadable &&
        (endpoint === undefined || negotiation === undefined)
      ) {
        blocking.push({
          reason: "gateway_readiness_extension_not_negotiated",
          message:
            "No capability negotiation has completed for the current gateway configuration, so paid model capabilities are refused: negotiate the gateway's extensions.",
        });
      } else if (
        !endpointUnreadable &&
        negotiation !== undefined &&
        negotiation.creditAdmissionExtension === "absent"
      ) {
        blocking.push({
          reason: "gateway_readiness_extension_absent",
          message:
            "The gateway does not expose the OpenBot credit-admission extension, so paid model capabilities are refused: deploy the extension before enabling billing.",
        });
      } else if (
        !endpointUnreadable &&
        negotiation !== undefined &&
        negotiation.creditAdmissionExtension === "incompatible"
      ) {
        blocking.push({
          reason: "gateway_readiness_extension_incompatible",
          message:
            "The gateway's credit-admission extension is outside the supported version range, so paid model capabilities are refused: align the extension version before enabling billing.",
        });
      }
    } catch (error) {
      log.error(
        {
          type: "gateway-readiness-condition-failed",
          condition: "extension",
          errorName: error instanceof Error ? error.name : String(error),
        },
        "The extension negotiation result could not be read.",
      );
      blocking.push({
        reason: "gateway_readiness_extension_unavailable",
        message:
          "The extension negotiation result could not be read, so paid model capabilities are refused until the failure is resolved.",
      });
    }

    // Condition 5: the rate is configured and legal. A corrupt stored row
    // throws from the read itself — the loud refusal the rate module chose —
    // and is a blocking condition here, never a guessed value.
    try {
      const admission = billingAdmission(await deps.readConversionRate());
      if (!admission.enabled) {
        blocking.push({
          reason: "gateway_readiness_rate_not_configured",
          message:
            "The USD→credits conversion rate is not configured, so paid model capabilities are refused: an administrator must save a legal rate (there is no default).",
        });
      }
    } catch (error) {
      log.error(
        {
          type: "gateway-readiness-condition-failed",
          condition: "rate",
          errorName: error instanceof Error ? error.name : String(error),
        },
        "The conversion-rate state could not be read.",
      );
      blocking.push({
        reason: "gateway_readiness_rate_unavailable",
        message:
          "The conversion rate could not be read as a legal value, so paid model capabilities are refused: repair the stored rate before enabling billing.",
      });
    }

    return {
      readiness: {
        ready: blocking.length === 0,
        blockingReasons: blocking.map((entry) => entry.reason),
        configVersion,
        checkedAt: now().toISOString(),
      },
      blocking,
    };
  };

  return {
    async evaluateGatewayReadiness() {
      const { readiness } = await evaluate();
      return readiness;
    },

    async assertGatewayReadyForBilling() {
      const { readiness, blocking } = await evaluate();
      if (!readiness.ready) {
        throw new GatewayNotReadyError(readiness, blocking);
      }
      return readiness;
    },
  };
}

let installed: GatewayReadinessService | undefined;

/**
 * Install the running gate, from the wiring that holds the deployment
 * configuration (app.ts). Internal consumers read it back through
 * {@link gatewayReadinessControls}; `undefined` uninstalls (tests).
 */
export function installGatewayReadinessService(
  service: GatewayReadinessService | undefined,
) {
  installed = service;
}

/** The running gate, or undefined in a process that never installed one. */
export function gatewayReadinessControls():
  | GatewayReadinessService
  | undefined {
  return installed;
}

/**
 * The single entry every paid model capability path calls. Zero arguments in
 * production — the installed gate answers. No gate installed is itself a
 * refusal (`gateway_readiness_gate_unavailable`): a process that cannot
 * check readiness does not get to skip the check.
 */
export async function assertGatewayReadyForBilling(
  gate?: GatewayReadinessService,
): Promise<GatewayReadiness> {
  const service = gate ?? gatewayReadinessControls();
  if (!service) {
    const readiness: GatewayReadiness = {
      ready: false,
      blockingReasons: ["gateway_readiness_gate_unavailable"],
      configVersion: 0,
      checkedAt: new Date().toISOString(),
    };
    throw new GatewayNotReadyError(readiness, [
      {
        reason: "gateway_readiness_gate_unavailable",
        message:
          "The gateway readiness gate is not installed in this process, so paid model capabilities are refused.",
      },
    ]);
  }
  return service.assertGatewayReadyForBilling();
}
