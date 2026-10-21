/**
 * Whether this deployment's model credential can call the model its Bots run on, said once at boot.
 *
 * The tenant package names the model (`model.yaml`'s `default_model`, resolved through
 * `runtimeModelForEnvironment`), and the provider decides whether the key may use it. A key without
 * access to that model passes every check OpenBot makes at start-up and fails at the first message,
 * in front of whoever sent it. One read of the provider's own model endpoint at boot moves that to
 * the log, where the person who can fix it is looking.
 *
 * ONLY LEGITIMATE METADATA IS ASKED. The lookup seam is supplied by the wiring, and the wiring only
 * supplies one where a legitimate one exists: the provider's own metadata endpoint, reached with the
 * deployment's own credential, on the direct model path. An OpenAI-compatible endpoint
 * (`OPENAI_BASE_URL`) often serves no single-model lookup, so a 404 there would say nothing about
 * the model — those are left alone, exactly like a deployment with no key yet: an administrator may
 * still be about to add one. The gateway's catalog has its own synchronized read (gateway/catalog.ts)
 * with its own readiness gate; this check is not a second one and never decides anything — it is
 * advice in the log, never an authorization fact and never a start-up dependency.
 *
 * NO BILLING, NO SECRETS. The lookup is a metadata read, not an inference call: no tokens are spent
 * and no virtual key is bypassed. The response body is never read, so provider bytes cannot reach
 * the log; the key lives only inside the lookup closure and the classification carries fixed
 * sentences plus, at most, a status number and the model's own name.
 *
 * NEVER BLOCKS START-UP. The probe runs inside one 3,000ms budget: the AbortSignal cancels a
 * supporting request at the deadline, and the answer is classified the moment it arrives or the
 * budget ends — whichever is first. `checkModelAvailability` resolves either way and never throws;
 * the result is reported through `log` at most once, and only when there is something to act on.
 */

/** The one budget every start-up probe gets: 3,000ms, once, no retries. */
export const STARTUP_CHECK_BUDGET_MS = 3_000;

/**
 * The safe shape of a start-up diagnostic. `code` names the one thing a person can act on; `message`
 * is a fixed sentence of this module's own making — never provider bytes, never a credential, never
 * a credential-bearing URL.
 */
export type StartupCheckResult = {
  kind: "available" | "skipped" | "warning";
  code?:
    | "unconfigured"
    | "unsupported"
    | "credential-rejected"
    | "model-unavailable"
    | "entitlement-unavailable"
    | "timeout"
    | "unreadable";
  message?: string;
};

/**
 * The one question a metadata channel may be asked: with this signal, may the deployment's key call
 * the model? The answer is a status number and nothing else — bodies stay unread, headers stay
 * unread, and the signal is the budget's cancellation handle.
 */
export type ModelMetadataLookup = (
  signal: AbortSignal,
) => Promise<{ status: number }>;

/**
 * What the budgeted attempt came back as. `timeout` covers every failure after the deadline's abort
 * fired, whoever noticed it first; `failed` is a rejection while the budget was still running.
 */
type BudgetedOutcome<T> =
  | { outcome: "settled"; value: T }
  | { outcome: "timeout" }
  | { outcome: "failed"; reason: unknown };

function abortAnswer(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Run one probe inside the start-up budget. The deadline aborts the signal first — a supporting
 * request is really cancelled, not merely stopped being waited on — and the race is only the second
 * line of defense, so a seam that ignores the signal still cannot hold the check past its budget.
 * Never rejects: a rejection while the budget runs arrives as `failed`.
 */
export async function runWithStartupBudget<T>(
  task: (signal: AbortSignal) => Promise<T>,
): Promise<BudgetedOutcome<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STARTUP_CHECK_BUDGET_MS);
  // A task that settles late — one that ignored the signal — must not become an unhandled
  // rejection somewhere down the boot path.
  const attempt = (async () => task(controller.signal))();
  attempt.catch(() => {});
  try {
    // Whoever answers first wins the race: the probe, or the budget's own abort.
    return await Promise.race([
      attempt.then(
        (value): BudgetedOutcome<T> => ({ outcome: "settled", value }),
      ),
      abortAnswer(controller.signal).then(
        (): BudgetedOutcome<T> => ({ outcome: "timeout" }),
      ),
    ]);
  } catch (error) {
    if (controller.signal.aborted) return { outcome: "timeout" };
    return { outcome: "failed", reason: error };
  } finally {
    clearTimeout(timer);
  }
}

function skipped(
  code: "unconfigured" | "unsupported",
  message: string,
): StartupCheckResult {
  return { kind: "skipped", code, message };
}

function warning(
  code: "credential-rejected" | "model-unavailable" | "timeout" | "unreadable",
  message: string,
): StartupCheckResult {
  return { kind: "warning", code, message };
}

/**
 * Ask the model question once and report what was found. Resolves either way and never throws; the
 * log hears at most one line, and only when there is something a person can act on — a skip is left
 * alone, because an administrator may still be about to configure what it needs.
 */
export async function checkModelAvailability(options: {
  enabled: boolean;
  model: string;
  lookup?: ModelMetadataLookup;
  log: (result: StartupCheckResult) => void;
}): Promise<StartupCheckResult> {
  if (!options.enabled) {
    return skipped(
      "unconfigured",
      "Model availability was not checked: this deployment has no model credential yet.",
    );
  }
  const { lookup } = options;
  if (!lookup) {
    return skipped(
      "unsupported",
      `Model availability was not checked for ${options.model}: this model path serves no metadata lookup, and a compatible endpoint's 404 would say nothing about the model.`,
    );
  }
  const answer = await runWithStartupBudget((signal) => lookup(signal));
  let result: StartupCheckResult;
  switch (answer.outcome) {
    case "settled": {
      const { status } = answer.value;
      if (status >= 200 && status < 300) {
        result = { kind: "available" };
      } else if (status === 401 || status === 403) {
        result = warning(
          "credential-rejected",
          `The model provider refused this deployment's credential for ${options.model} (HTTP ${status}), so model calls will fail until it is replaced.`,
        );
      } else if (status === 404) {
        result = warning(
          "model-unavailable",
          `The provider answered that this deployment's key cannot call ${options.model} (HTTP 404), so every Bot turn on it will fail. Give the key access to ${options.model}, use another key, or change the tenant package's default model.`,
        );
      } else {
        result = warning(
          "unreadable",
          `The provider did not give a readable answer about ${options.model} (HTTP ${status}). This is often temporary.`,
        );
      }
      break;
    }
    case "timeout": {
      result = warning(
        "timeout",
        `The model availability check for ${options.model} did not answer within ${STARTUP_CHECK_BUDGET_MS / 1000}s and was cancelled. This is often temporary.`,
      );
      break;
    }
    case "failed": {
      result = warning(
        "unreadable",
        `The provider could not be asked whether ${options.model} is available. This is often temporary.`,
      );
      break;
    }
  }
  if (result.kind === "warning") options.log(result);
  return result;
}

const MODEL_METADATA_ENDPOINTS: Record<
  "openai" | "anthropic",
  (model: string) => string
> = {
  openai: (model) =>
    `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
  anthropic: (model) =>
    `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`,
};

/**
 * The one legitimate model metadata channel: the provider's own single-model read, reached with the
 * deployment's own credential. The key and the URL stay inside this closure; only `{ status }` ever
 * comes out, and the response body is never read, so provider bytes cannot ride into the log.
 */
export function officialModelMetadataLookup(options: {
  provider: "openai" | "anthropic";
  model: string;
  key: string;
  fetch?: typeof fetch;
}): ModelMetadataLookup {
  const url = MODEL_METADATA_ENDPOINTS[options.provider](options.model);
  const headers: Record<string, string> =
    options.provider === "anthropic"
      ? { "x-api-key": options.key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${options.key}` };
  const request = options.fetch ?? fetch;
  return async (signal) => {
    const response = await request(url, { headers, signal });
    return { status: response.status };
  };
}
