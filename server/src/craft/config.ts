/**
 * Craft's runtime configuration: env → one explicit object, once.
 *
 * Ported from onyx `configs.py` + the non-tunable derivations in `timeouts.py`. Everything a
 * deployment can tune carries an `OPENBOT_CRAFT_*` name; the derived family keeps onyx's
 * arithmetic (roots → derivations) so tuning a root still moves every dependent value with it.
 *
 * Not ported (by the port plan): the k8s/docker backend block, the egress-proxy block, and the
 * user-library block — OpenBot's sandbox is the external agent-sandbox service, and those
 * subsystems are out of the first phase.
 */

/** What `loadCraftConfig` reads. `NodeJS.ProcessEnv` shaped so tests can build fakes. */
export type CraftEnv = Record<string, string | undefined>;

const boolEnv = (env: CraftEnv, name: string, fallback: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
};

const intEnv = (env: CraftEnv, name: string, fallback: number): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

const floatEnv = (env: CraftEnv, name: string, fallback: number): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
};

const stringEnv = (env: CraftEnv, name: string, fallback: string): string => {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
};

export type CraftConfig = {
  /** Total switch (`ENABLE_CRAFT`). Off = the /api/craft tree is not mounted. */
  readonly enabled: boolean;
  /** Gates the built-in browser skill inside the sandbox image (`ENABLE_BROWSER`). */
  readonly enableBrowser: boolean;

  /** Comma-separated opencode tools to disable (`OPENCODE_DISABLED_TOOLS`, default "question"). */
  readonly opencodeDisabledTools: readonly string[];

  // ── uploads ────────────────────────────────────────────────────────────────
  readonly maxUploadFileSizeMb: number;
  readonly maxUploadFileSizeBytes: number;
  readonly maxUploadFilesPerSession: number;
  readonly maxTotalUploadSizeMb: number;
  readonly maxTotalUploadSizeBytes: number;
  /** Where attachments live inside a session workspace; also the prompt-part allow-list root. */
  readonly attachmentsDirectory: string;

  // ── sandbox lifecycle (kept for parity; the reaper itself is a later phase) ─
  readonly sandboxIdleTimeoutSeconds: number;
  readonly sandboxHeartbeatRefreshIntervalSeconds: number;
  readonly sandboxNextjsPortStart: number;
  readonly sandboxNextjsPortEnd: number;

  // ── approvals (window kept: AGENTS.md guidance and the inactivity floor read it) ─
  readonly sandboxApprovalWaitTimeoutSeconds: number;
  /**
   * Margin a client-side wait must add over the approval window so a decision landing at the
   * wire never races the client's own timeout (onyx: SANDBOX_APPROVAL_WAIT_MARGIN_SECONDS).
   */
  readonly sandboxApprovalWaitMarginSeconds: number;

  // ── SSE / opencode-serve ───────────────────────────────────────────────────
  /** SSE + runner-liveness base cadence (SSE_KEEPALIVE_INTERVAL). */
  readonly sseKeepaliveIntervalSeconds: number;
  /**
   * Max time opencode-serve may go without emitting a turn event. Must stay above every
   * in-tool wait (opencode's bash tool defaults to 180s; a parked approval holds the stream
   * silent for the full approval window) — hence the default derivation
   * approval-window + margin, exactly as onyx derives it.
   */
  readonly opencodePromptInactivityTimeoutSeconds: number;
  /** Per-turn deadline stamp for the sandbox-side turn-budget plugin; contract, not a knob. */
  readonly turnBudgetFileName: string;
  /** Prompt-slot lease; renewed on every event, so a dead holder strands it for at most this. */
  readonly promptSlotLeaseSeconds: number;

  /** The sandbox-internal `opencode serve` port (matches the agent-sandbox image's EXPOSE). */
  readonly opencodeServePort: number;
  /**
   * Basic-auth username opencode's serve implementation hard-codes when only the password is
   * set — any other value yields 401 (verified against opencode 1.15.7, per onyx).
   */
  readonly opencodeServerUsername: string;
  readonly opencodeServeConnectTimeoutSeconds: number;
  readonly opencodeServeRequestTimeoutSeconds: number;
  /**
   * Idle timeout for the raw /event SSE connection. Its floor is opencode-serve's own emission
   * cadence — NOT our downstream UI keepalive, which is synthesized after the bus and never
   * reaches this connection.
   */
  readonly opencodeServeEventReadTimeoutSeconds: number;

  /**
   * How the server reaches the agent-sandbox gateway (the OpenBot replacement for onyx's
   * in-cluster pod IP + per-pod password: one token-gated gateway, the codesandbox shape).
   */
  readonly sandboxGatewayBaseUrl: string;
  readonly sandboxGatewayToken: string;

  // ── derived timeout family (timeouts.py) ───────────────────────────────────
  /**
   * A turn runner heartbeats on every consumed event, and the transport emits a keepalive at
   * least every sseKeepaliveIntervalSeconds even while silent — so the runner is dead after k
   * missed keepalives, not after any turn-length-derived time. RUNNER_STALE == 6 × keepalive.
   */
  readonly runnerStaleAfterSeconds: number;
  /** Hard cap for one interactive turn; the executor aborts past it (30 min). */
  readonly interactiveTurnHardCapSeconds: number;
  /**
   * Past the soft budget the sandbox-side turn-budget plugin steers the agent to wrap up; the
   * remainder is the wrap-up window (TURN_SOFT_BUDGET_FRACTION == 0.4 of the hard cap).
   */
  readonly interactiveTurnSoftBudgetSeconds: number;
  /**
   * Redis TTL of the turn record + active-turn pointer. Floor is cap + reclaim slack so a live
   * turn's admission block never evaporates under it (1800s + 900s = 2700s).
   */
  readonly activeTurnTtlSeconds: number;
  /**
   * Post-terminal retention of the turn record + client_request_id dedupe key: an idempotent
   * send-message retry must still resolve after the turn finishes (2700 + 900 = 3600s).
   */
  readonly requestIdTtlSeconds: number;
  /** Poll cadence for every poll-a-fast-local-resource loop (0.5s). */
  readonly pollIntervalSeconds: number;
  /** Prompt-slot acquire policy: a second turn racing a live one bounces fast. */
  readonly promptSlotFastFailAcquireSeconds: number;
  /** A reclaimed turn must wait out a dead holder's full lease before taking the slot. */
  readonly promptSlotWaitOutOrphanSeconds: number;
  /**
   * Ceiling for background prompt-slot renewal by client-paced holders (session delete,
   * subagent turns) — the interactive hard cap: a slot held longer is leaked.
   */
  readonly promptSlotKeepAliveMaxSeconds: number;
  /** Shared fast-poll interval on the attach stream before the live stream opens. */
  readonly liveStreamRunnerRetrySeconds: number;
};

export function loadCraftConfig(env: CraftEnv = process.env): CraftConfig {
  // Roots first — derivations read the resolved roots, never the env twice.
  const sseKeepaliveIntervalSeconds = floatEnv(
    env,
    "OPENBOT_CRAFT_SSE_KEEPALIVE_INTERVAL",
    15,
  );
  const sandboxApprovalWaitTimeoutSeconds = intEnv(
    env,
    "OPENBOT_CRAFT_SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS",
    180,
  );
  const sandboxApprovalWaitMarginSeconds = 20; // fixed margin, onyx parity
  const promptSlotLeaseSeconds = floatEnv(
    env,
    "OPENBOT_CRAFT_PROMPT_SLOT_LEASE_SECONDS",
    120,
  );
  const interactiveTurnHardCapSeconds = 30 * 60;
  const turnReclaimSlackSeconds = 15 * 60;
  const turnRetentionSeconds = 15 * 60;

  const disabledToolsRaw = stringEnv(env, "OPENBOT_CRAFT_OPENCODE_DISABLED_TOOLS", "question");

  const maxUploadFileSizeMb = intEnv(env, "OPENBOT_CRAFT_MAX_UPLOAD_FILE_SIZE_MB", 50);
  const maxTotalUploadSizeMb = intEnv(env, "OPENBOT_CRAFT_MAX_TOTAL_UPLOAD_SIZE_MB", 200);

  return {
    enabled: boolEnv(env, "OPENBOT_CRAFT_ENABLED", false),
    enableBrowser: boolEnv(env, "OPENBOT_CRAFT_ENABLE_BROWSER", true),

    opencodeDisabledTools: disabledToolsRaw
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0),

    maxUploadFileSizeMb,
    maxUploadFileSizeBytes: maxUploadFileSizeMb * 1024 * 1024,
    maxUploadFilesPerSession: intEnv(
      env,
      "OPENBOT_CRAFT_MAX_UPLOAD_FILES_PER_SESSION",
      20,
    ),
    maxTotalUploadSizeMb,
    maxTotalUploadSizeBytes: maxTotalUploadSizeMb * 1024 * 1024,
    attachmentsDirectory: "attachments",

    sandboxIdleTimeoutSeconds: intEnv(
      env,
      "OPENBOT_CRAFT_SANDBOX_IDLE_TIMEOUT_SECONDS",
      3600,
    ),
    sandboxHeartbeatRefreshIntervalSeconds: 60,
    sandboxNextjsPortStart: intEnv(env, "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START", 3010),
    sandboxNextjsPortEnd: intEnv(env, "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END", 3100),

    sandboxApprovalWaitTimeoutSeconds,
    sandboxApprovalWaitMarginSeconds,

    sseKeepaliveIntervalSeconds,
    opencodePromptInactivityTimeoutSeconds: floatEnv(
      env,
      "OPENBOT_CRAFT_OPENCODE_PROMPT_INACTIVITY_TIMEOUT_SECONDS",
      sandboxApprovalWaitTimeoutSeconds + sandboxApprovalWaitMarginSeconds,
    ),
    turnBudgetFileName: ".onyx-turn-budget.json",
    promptSlotLeaseSeconds,

    opencodeServePort: intEnv(env, "OPENBOT_CRAFT_OPENCODE_SERVE_PORT", 4096),
    opencodeServerUsername: "opencode",
    opencodeServeConnectTimeoutSeconds: floatEnv(
      env,
      "OPENBOT_CRAFT_OPENCODE_SERVE_CONNECT_TIMEOUT",
      5,
    ),
    opencodeServeRequestTimeoutSeconds: floatEnv(
      env,
      "OPENBOT_CRAFT_OPENCODE_SERVE_REQUEST_TIMEOUT",
      30,
    ),
    opencodeServeEventReadTimeoutSeconds: floatEnv(
      env,
      "OPENBOT_CRAFT_OPENCODE_SERVE_EVENT_READ_TIMEOUT",
      60,
    ),

    sandboxGatewayBaseUrl: stringEnv(env, "OPENBOT_CRAFT_SANDBOX_GATEWAY_URL", ""),
    sandboxGatewayToken: stringEnv(env, "OPENBOT_CRAFT_SANDBOX_GATEWAY_TOKEN", ""),

    // ── derived family: arithmetic over the roots, exactly onyx's ──
    runnerStaleAfterSeconds: 6 * sseKeepaliveIntervalSeconds, // 90s at the default
    interactiveTurnHardCapSeconds,
    interactiveTurnSoftBudgetSeconds: Math.floor(0.4 * interactiveTurnHardCapSeconds), // 720s
    activeTurnTtlSeconds: interactiveTurnHardCapSeconds + turnReclaimSlackSeconds, // 2700s
    requestIdTtlSeconds:
      interactiveTurnHardCapSeconds + turnReclaimSlackSeconds + turnRetentionSeconds, // 3600s
    pollIntervalSeconds: 0.5,
    promptSlotFastFailAcquireSeconds: 10,
    promptSlotWaitOutOrphanSeconds: promptSlotLeaseSeconds + 10,
    promptSlotKeepAliveMaxSeconds: interactiveTurnHardCapSeconds,
    liveStreamRunnerRetrySeconds: 5,
  };
}
