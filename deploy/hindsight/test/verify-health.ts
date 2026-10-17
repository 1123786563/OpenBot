/**
 * Four-state health verification runner (ticket #380).
 *
 * Drives server/src/hindsight/health.ts against the real self-hosted instance with the
 * real platform fetch, one scenario per required state. Prints one JSON line per
 * scenario; exits non-zero if a scenario does not produce the expected state.
 *
 * Scenarios (in order):
 *   1. happy           -> service_up        (gateway stand-in up, compliant config)
 *   2. gateway-down    -> gateway_down      (stand-in stopped)
 *   3. bad-config      -> config_noncompliant (privacy declaration broken)
 *   4. service-down    -> service_down      (Hindsight unreachable)
 *
 * Usage: bun run verify-health.ts <scenario>
 *
 * If the connection configuration itself cannot be loaded (missing connection
 * variables or a non-bare-origin URL), a one-line diagnostic goes to stderr and
 * the runner exits 1 — the crash path must not print an uncaught stack trace.
 */
import { loadHindsightConfig } from "../../../server/src/hindsight/config";
import { checkHindsightHealth } from "../../../server/src/hindsight/health";

const expected: Record<string, string> = {
  happy: "service_up",
  "gateway-down": "gateway_down",
  "bad-config": "config_noncompliant",
  "service-down": "service_down",
};

const scenario = process.argv[2];
if (!(scenario in expected)) {
  console.error(
    `usage: bun run verify-health.ts <${Object.keys(expected).join("|")}>`,
  );
  process.exit(2);
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}

// Scenario self-sufficiency: bad-config only needs one broken privacy declaration, and
// validateHindsightPrivacy runs before any network call, so injecting it here reproduces
// config_noncompliant deterministically instead of relying on an operator editing the
// environment out of band (a forgotten edit would report service_up and fail the runner).
// The other three states stay environmental on purpose: gateway-down fundamentally needs
// the stand-in stopped and service-down needs a dead URL — neither can be simulated by an
// env override alone.
if (scenario === "bad-config") {
  env.HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED = "true";
}

// Both calls can throw: loadHindsightConfig on missing connection variables or a
// non-bare http(s) origin, checkHindsightHealth only for unexpected internal
// errors (network failures are normalized into states by design). Without this
// guard the runner would die with an uncaught stack trace and no output,
// conflating "checker crashed" with "scenario result mismatch".
try {
  const config = loadHindsightConfig(env);
  const status = await checkHindsightHealth(config);
  console.log(
    JSON.stringify({ scenario, expected: expected[scenario], ...status }),
  );
  // Assign exitCode instead of calling exit(): a forced exit can truncate stdout still
  // buffered for a pipe (e.g. this line redirected into a report file), so let the
  // process end naturally and flush.
  process.exitCode = status.state === expected[scenario] ? 0 : 1;
} catch (error) {
  console.error(
    `${scenario}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
  );
  process.exitCode = 1;
}
