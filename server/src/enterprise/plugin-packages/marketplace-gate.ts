/**
 * PKG11 (#470, Spec §12.4): the deployment switch that gates the package
 * marketplace's WRITE entries — install/upgrade plans, their apply, and new
 * Bot grants — behind `OPENBOT_PACKAGE_MARKETPLACE_ENABLED` plus a precise
 * pilot allowlist `OPENBOT_PACKAGE_PILOT_WORKSPACES`.
 *
 * WHAT IS GATED, AND WHAT IS NOT. Default is OFF: with no environment set,
 * plan/apply/grant answer 503 MARKETPLACE_ENTRY_DISABLED (the same degraded
 * posture Spec §7 established for a missing operator channel — browse stays
 * up, writes refuse), while every READ and every governance path of installs
 * that already exist keeps working: dispatch preparation, per-invocation
 * revalidation, the dispatch ledger, unknown verification, revoke, and the
 * PKG07 lifecycle (disable/enable/uninstall) are NOT consulted here, so an
 * operator closing the entry during a rollback neither pauses existing pinned
 * Runs nor loses a receipt — and never degrades a package Run to a legacy
 * grant (A09).
 *
 * The allowlist is exact tuples only. A wildcard or any other malformed value
 * is a deployment configuration error raised at startup, not a silent
 * empty/whole-world interpretation: "every tenant" is exactly the deployment
 * posture this pilot phase refuses to guess.
 */

/** One exact (tenantId, workspaceId) pair; no wildcards, no defaults. */
export interface PilotWorkspaceEntry {
  readonly tenantId: string;
  readonly workspaceId: string;
}

/** Startup-refused misconfiguration of the pilot allowlist. */
export class MarketplaceGateConfigError extends Error {
  constructor(
    readonly code:
      | "PILOT_WORKSPACES_UNPARSEABLE"
      | "PILOT_WORKSPACES_NOT_ARRAY"
      | "PILOT_WORKSPACES_ENTRY_INVALID"
      | "PILOT_WORKSPACES_DUPLICATE",
    reason: string,
  ) {
    super(`OPENBOT_PACKAGE_PILOT_WORKSPACES ${code}: ${reason}`);
    this.name = "MarketplaceGateConfigError";
  }
}

const WILDCARD = /\*/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Strict `OPENBOT_PACKAGE_MARKETPLACE_ENABLED` parsing, same convention as the
 * other deployment booleans: exactly the string `true` enables; anything else
 * (including unset) leaves the entry closed. A typo'd value does not open the
 * market by accident.
 */
export function parseMarketplaceEnabledFlag(raw: string | undefined): boolean {
  return raw === "true";
}

/**
 * Strict `OPENBOT_PACKAGE_PILOT_WORKSPACES` parsing. The value must be a JSON
 * array whose elements are objects with EXACTLY `tenantId` and `workspaceId`
 * (non-empty strings, no `*` wildcard anywhere). Unset means the empty list:
 * when the entry is enabled, nobody is a pilot until named. Anything else is
 * thrown as a {@link MarketplaceGateConfigError} so the server fails to boot
 * with the reason — never a guessed allowlist.
 */
export function parsePilotWorkspaces(
  raw: string | undefined,
): PilotWorkspaceEntry[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MarketplaceGateConfigError(
      "PILOT_WORKSPACES_UNPARSEABLE",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MarketplaceGateConfigError(
      "PILOT_WORKSPACES_NOT_ARRAY",
      "value must be a JSON array",
    );
  }
  const seen = new Set<string>();
  const entries: PilotWorkspaceEntry[] = [];
  for (const element of parsed) {
    if (element === null || typeof element !== "object") {
      throw new MarketplaceGateConfigError(
        "PILOT_WORKSPACES_ENTRY_INVALID",
        "every element must be an object with tenantId and workspaceId",
      );
    }
    const record = element as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "tenantId" ||
      keys[1] !== "workspaceId"
    ) {
      throw new MarketplaceGateConfigError(
        "PILOT_WORKSPACES_ENTRY_INVALID",
        "elements carry exactly tenantId and workspaceId — no wildcards, no extra fields",
      );
    }
    const { tenantId, workspaceId } = record;
    if (!isNonEmptyString(tenantId) || !isNonEmptyString(workspaceId)) {
      throw new MarketplaceGateConfigError(
        "PILOT_WORKSPACES_ENTRY_INVALID",
        "tenantId and workspaceId must be non-empty strings",
      );
    }
    for (const value of [tenantId, workspaceId]) {
      if (WILDCARD.test(value)) {
        throw new MarketplaceGateConfigError(
          "PILOT_WORKSPACES_ENTRY_INVALID",
          `wildcards are not accepted: ${value}`,
        );
      }
    }
    const tuple = `${tenantId}/${workspaceId}`;
    if (seen.has(tuple)) {
      throw new MarketplaceGateConfigError("PILOT_WORKSPACES_DUPLICATE", tuple);
    }
    seen.add(tuple);
    entries.push({ tenantId, workspaceId });
  }
  return entries;
}

export interface MarketplaceGate {
  /** Whether the deployment switch is on at all. */
  readonly enabled: boolean;
  /** The parsed exact tuples (defensive copy of the assembly input). */
  readonly pilotWorkspaces: readonly PilotWorkspaceEntry[];
  /**
   * True only when the switch is on AND the scope is an exact pilot tuple.
   * An enabled-but-empty allowlist authorizes nobody — that is the pilot
   * posture, not an accident to paper over.
   */
  entryOpenFor(scope: { tenantId: string; workspaceId: string }): boolean;
}

export function createMarketplaceGate(input: {
  enabled: boolean;
  pilotWorkspaces: readonly PilotWorkspaceEntry[];
}): MarketplaceGate {
  const pilot = new Set(
    input.pilotWorkspaces.map(
      (entry) => `${entry.tenantId}/${entry.workspaceId}`,
    ),
  );
  return {
    enabled: input.enabled,
    pilotWorkspaces: input.pilotWorkspaces.map((entry) => ({ ...entry })),
    entryOpenFor(scope) {
      return (
        input.enabled && pilot.has(`${scope.tenantId}/${scope.workspaceId}`)
      );
    },
  };
}
