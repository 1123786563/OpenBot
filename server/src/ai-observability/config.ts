/**
 * The Opik configuration toggle (Issue #15 / DAG T09).
 *
 * This module reads exactly the environment names T03 pinned for this ticket —
 * OPIK_ENABLED, OPIK_BASE_URL, OPIK_API_KEY, OPIK_WORKSPACE_NAME, OPIK_PORT,
 * OPIK_OTLP_HTTP_PORT, OPIK_OTLP_GRPC_PORT — and nothing else. Absent env means
 * disabled and unconfigured: the integration stays off and every existing behavior
 * is preserved. Parsing is strict and fails closed: only the literal `true`
 * enables, and anything that is not a clean value stays `null` rather than being
 * guessed at.
 *
 * The API key is held here for the port wiring but is never a health output —
 * readiness projections carry booleans, counters and one enumerated reason (see
 * health.ts). The OTLP and reverse-proxy ports are held for the exporter wiring
 * tickets; this module records them, it does not consume them.
 */

/** The minimal env surface: injectable so tests never touch process.env. */
export type OpikEnvSource = Readonly<Record<string, string | undefined>>;

/** Deployment-level Opik settings, resolved once at boot and read-only after. */
export type OpikConfig = Readonly<{
  /** Only the literal `true` enables the integration. Every other value disables. */
  enabled: boolean;
  /** The verified API base (reverse proxy). `null` means unconfigured. */
  baseUrl: string | null;
  /** Held for port wiring; never echoed into any health or readiness output. */
  apiKey: string | null;
  workspaceName: string | null;
  /** Reverse-proxy port (default 5174, per the T03 deployment contract). */
  port: number;
  /** OTLP HTTP port (default 5418). Held for the exporter wiring; not consumed here. */
  otlpHttpPort: number;
  /** OTLP gRPC port (default 5417). Held for the exporter wiring; not consumed here. */
  otlpGrpcPort: number;
}>;

const DEFAULT_PORT = 5174;
const DEFAULT_OTLP_HTTP_PORT = 5418;
const DEFAULT_OTLP_GRPC_PORT = 5417;

/** Trimmed non-empty value, or `null`. Blank is unconfigured, not defaulted. */
const text = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Positive integer port, or the default. Anything unparsable keeps the default. */
const port = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : fallback;
};

export function opikConfigFromEnv(env: OpikEnvSource): OpikConfig {
  return {
    enabled: env.OPIK_ENABLED === "true",
    baseUrl: text(env.OPIK_BASE_URL),
    apiKey: text(env.OPIK_API_KEY),
    workspaceName: text(env.OPIK_WORKSPACE_NAME),
    port: port(env.OPIK_PORT, DEFAULT_PORT),
    otlpHttpPort: port(env.OPIK_OTLP_HTTP_PORT, DEFAULT_OTLP_HTTP_PORT),
    otlpGrpcPort: port(env.OPIK_OTLP_GRPC_PORT, DEFAULT_OTLP_GRPC_PORT),
  };
}
