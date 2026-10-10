/**
 * The sandbox's configuration, parsed once at start-up.
 *
 * The container refuses to start without a token and without provider credentials: a sandbox that
 * would boot with no auth boundary or no model route is a sandbox that should not exist. Same
 * posture as the computer's COMPUTER_TOKEN refusal.
 */
export type SandboxEnv = {
  /** Every request must present this in `x-sandbox-token`. */
  token: string;
  /** The port the proxy listens on, published by the container. */
  port: number;
  /** The port `opencode serve` listens on, loopback inside the container only. */
  upstreamPort: number;
  /** Where sessions' files live. Mounted from a named volume. */
  workspaceDir: string;
  /** Where the generated opencode.json is written, through XDG_CONFIG_HOME. */
  configDir: string;
  /** The model endpoint opencode's provider points at. */
  providerBaseUrl: string;
  /** The model key opencode's provider authenticates with. */
  providerApiKey: string;
  /** The model id opencode resolves, e.g. `GLM-5.3`. */
  model: string;
  /** The largest upstream body the proxy will relay, in bytes. */
  maxResponseBytes: number;
  /** Idle budget for a per-bot opencode serve before the sweep stops it. */
  upstreamIdleMs: number;
  /**
   * A runtime whose event stream stays silent this long is stalled, not idle: the sweep stops
   * it too (with a `sandbox-runtime-stalled` row), because a stream that produces nothing is a
   * turn that will never finish. Distinct from upstreamIdleMs, which is about no REQUESTS.
   */
  activityTimeoutMs: number;
  /** How often the sweep runs. */
  sweepIntervalMs: number;
  /** First port a per-bot opencode serve may take; ports increment per concurrently-live bot. */
  upstreamPortBase: number;
  /** First port of the per-bot dev server pool (vite et al.); 100 ports from here. */
  devserverPortBase: number;
  /** How many per-bot dev servers may run at once. The next start is refused, not queued. */
  devserverMax: number;
  /** Bot workspace dirs untouched for longer than this are swept. 0 disables (default). */
  workspaceTtlMs: number;
};

const required = (env: Record<string, string | undefined>, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set: the sandbox refuses to start without it.`);
  return value;
};

const optionalNumber = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive number.`);
  return parsed;
};

/** Like optionalNumber, but zero is a legal explicit value (it means "off"). */
const optionalNonNegativeNumber = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${name} must be zero or a positive number.`);
  return parsed;
};

export function sandboxEnvFrom(env: Record<string, string | undefined>): SandboxEnv {
  return {
    token: required(env, "SANDBOX_TOKEN"),
    port: optionalNumber(env, "SANDBOX_PORT", 4300),
    upstreamPort: optionalNumber(env, "SANDBOX_UPSTREAM_PORT", 4399),
    workspaceDir: env.SANDBOX_WORKSPACE_DIR?.trim() || "/workspace",
    configDir: env.SANDBOX_CONFIG_DIR?.trim() || "/config",
    providerBaseUrl: required(env, "SANDBOX_PROVIDER_BASE_URL"),
    providerApiKey: required(env, "SANDBOX_PROVIDER_API_KEY"),
    model: required(env, "SANDBOX_MODEL"),
    maxResponseBytes: optionalNumber(env, "SANDBOX_MAX_RESPONSE_BYTES", 262_144),
    upstreamIdleMs: optionalNumber(env, "SANDBOX_UPSTREAM_IDLE_MS", 600_000),
    activityTimeoutMs: optionalNumber(env, "SANDBOX_ACTIVITY_TIMEOUT_MS", 300_000),
    sweepIntervalMs: optionalNumber(env, "SANDBOX_SWEEP_INTERVAL_MS", 60_000),
    upstreamPortBase: optionalNumber(env, "SANDBOX_UPSTREAM_PORT_BASE", 4400),
    devserverPortBase: optionalNumber(env, "SANDBOX_DEVSERVER_PORT_BASE", 4600),
    devserverMax: Math.floor(optionalNumber(env, "SANDBOX_DEVSERVER_MAX", 8)),
    workspaceTtlMs: optionalNonNegativeNumber(env, "SANDBOX_WORKSPACE_TTL_MS", 0),
  };
}
