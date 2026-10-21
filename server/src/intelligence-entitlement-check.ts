/**
 * Whether Intelligence confirms this deployment's entitlement, said once at boot — and only where
 * the optional learning dependency is actually enabled.
 *
 * A self-hosted Intelligence without a valid licence, or a managed one that cannot resolve this
 * project right now, answers every entitlement read with a refusal, and the features it gates —
 * memory, Learning — are then refused quietly: conversations still run, nothing fails loudly, and
 * nothing in OpenBot's own log says why recall is empty. One read at boot moves that to the log,
 * where the person who can fix it is looking.
 *
 * WHO GETS ASKED. Only a deployment that actually enabled the optional learning dependency — the
 * same real condition the Learning provisioning path uses. A deployment without it keeps its exact
 * current contract: the diagnostic does not probe at all. Hindsight and ordinary chat never wait on
 * this check, and the answer is advice in the log — never an authorization fact, and never a second
 * readiness authority (the gateway's gate stays the only one for paid model work).
 *
 * NEVER BLOCKS START-UP. The read runs inside the shared 3,000ms budget; the AbortSignal is handed
 * to the read seam for cancellation, and the check answers the moment the read settles or the
 * budget ends — whichever is first. `reportIntelligenceEntitlement` resolves either way and never
 * throws; the log hears at most one line, and only when there is something to act on.
 */
import {
  checkModelAvailability,
  type ModelMetadataLookup,
  runWithStartupBudget,
  STARTUP_CHECK_BUDGET_MS,
  type StartupCheckResult,
} from "./model-availability-check";

/**
 * The one question an entitlement channel may be asked: is this deployment's entitlement active?
 * The signal is the budget's cancellation handle; the answer is a boolean and nothing else.
 */
export type EntitlementRead = (
  signal: AbortSignal,
) => Promise<{ active: boolean }>;

function skipped(
  code: "unconfigured" | "unsupported",
  message: string,
): StartupCheckResult {
  return { kind: "skipped", code, message };
}

/**
 * Ask the entitlement question once and report what was found. Resolves either way and never
 * throws; the log hears at most one line, and only when there is something a person can act on.
 */
export async function reportIntelligenceEntitlement(options: {
  enabled: boolean;
  read?: EntitlementRead;
  log: (result: StartupCheckResult) => void;
}): Promise<StartupCheckResult> {
  if (!options.enabled) {
    return skipped(
      "unconfigured",
      "Learning is not enabled on this deployment, so Intelligence's entitlement was not asked.",
    );
  }
  const { read } = options;
  if (!read) {
    return skipped(
      "unsupported",
      "Intelligence's entitlement was not checked: no read channel for the entitlement answer is wired.",
    );
  }
  const answer = await runWithStartupBudget((signal) => read(signal));
  let result: StartupCheckResult;
  switch (answer.outcome) {
    case "settled": {
      const { active } = answer.value;
      if (typeof active !== "boolean") {
        result = {
          kind: "warning",
          code: "unreadable",
          message:
            "Intelligence's entitlement answer was not readable; licensed features may be refused until it answers clearly.",
        };
      } else if (active) {
        result = { kind: "available" };
      } else {
        result = {
          kind: "warning",
          code: "entitlement-unavailable",
          message:
            "Intelligence answered that this deployment's entitlement is not active, so licensed features such as memory may be refused.",
        };
      }
      break;
    }
    case "timeout": {
      result = {
        kind: "warning",
        code: "timeout",
        message: `Intelligence's entitlement check did not answer within ${STARTUP_CHECK_BUDGET_MS / 1000}s and was cancelled. This is often temporary.`,
      };
      break;
    }
    case "failed": {
      result = {
        kind: "warning",
        code: "entitlement-unavailable",
        message:
          "Intelligence could not be asked about this deployment's entitlement; licensed features may be refused until it answers. This is often temporary.",
      };
      break;
    }
  }
  if (result.kind === "warning") options.log(result);
  return result;
}

/**
 * What the boot wiring knows about the model question. Resolved lazily — the credential may live in
 * the credential store — and answered with the deployment's real condition: `enabled: false` is the
 * no-credential case, `enabled: true` without a lookup is the compatible-endpoint case where no
 * legitimate metadata channel exists.
 */
export type StartupModelDiagnostic = () => Promise<{
  enabled: boolean;
  name: string;
  lookup?: ModelMetadataLookup;
}>;

/**
 * Fire both boot diagnostics and walk away.
 *
 * This is the whole assembly contract: it returns before either check finishes (no promise to
 * await, nothing for boot to wait on), runs each check at most once, reports at most one warning
 * line per check through `log`, and turns an unexpected defect in a check itself into one final
 * warning — never a rejection, never a start-up failure. A log sink that throws is contained here.
 */
export function scheduleStartupDiagnostics(options: {
  model: StartupModelDiagnostic;
  entitlement: { enabled: boolean; read?: EntitlementRead };
  log: (source: "model" | "entitlement", result: StartupCheckResult) => void;
}): void {
  const report = (
    source: "model" | "entitlement",
    result: StartupCheckResult,
  ) => {
    try {
      options.log(source, result);
    } catch {
      // A throwing log sink must not turn diagnostics into a boot failure.
    }
  };
  void (async () => {
    const model = await options.model();
    return checkModelAvailability({
      enabled: model.enabled,
      model: model.name,
      ...(model.lookup ? { lookup: model.lookup } : {}),
      log: (result) => report("model", result),
    });
  })().catch(() =>
    report("model", {
      kind: "warning",
      code: "unreadable",
      message:
        "The model availability check itself failed; this is a defect in the diagnostic, not in the model request path.",
    }),
  );
  void reportIntelligenceEntitlement({
    enabled: options.entitlement.enabled,
    ...(options.entitlement.read ? { read: options.entitlement.read } : {}),
    log: (result) => report("entitlement", result),
  }).catch(() =>
    report("entitlement", {
      kind: "warning",
      code: "unreadable",
      message:
        "The entitlement check itself failed; this is a defect in the diagnostic, not in a request path.",
    }),
  );
}
