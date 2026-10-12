/**
 * The craft managed-content staleness contract — ported from onyx `skills/push.py`
 * (`compute_skill_runtime_hash`), `sandbox/util/mcp_config.py` (`craft_mcp_fingerprint`),
 * and `db/build_session.py` (`session_runtime_stale`).
 *
 * onyx computes these fingerprints during the skills/MCP push and stores them on the *sandbox*
 * row; a live session whose recorded hashes differ from the sandbox's predates the managed
 * content and must reload (rewrite config + dispose). OpenBot ships no managed-content push
 * yet (skills map to the plugins/marketplace surface; the craft MCP set is empty), so this
 * module carries the *semantics* — the two fingerprints and the predicate — while the session
 * row's `skills_hash` / `mcp_config_hash` columns are where a runtime records what it has
 * already picked up.
 */

import { createHash } from "node:crypto";
import type { CraftMCPServerConfig } from "./opencode-config";
import type { CraftSessionRow } from "./store";

/** A length prefix as 8 big-endian bytes — onyx's `len(...).to_bytes(8)`. */
function uint64BigEndian(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value));
  return buf;
}

/**
 * Digest of the skill files plus the app guidance rendered into AGENTS.md. A change makes a
 * live session stale so it hot-reloads — the craft MCP set is tracked separately via
 * `craftMcpFingerprint`. Order-independent over the file map (keys are sorted).
 */
export function computeSkillRuntimeHash(
  files: Record<string, Uint8Array>,
  connectableAppsSection: string,
): string {
  const digest = createHash("sha256");
  const appsBytes = Buffer.from(connectableAppsSection, "utf8");
  digest.update(uint64BigEndian(appsBytes.length));
  digest.update(appsBytes);
  for (const path of Object.keys(files).sort()) {
    const pathBytes = Buffer.from(path, "utf8");
    const content = files[path];
    digest.update(uint64BigEndian(pathBytes.length));
    digest.update(pathBytes);
    digest.update(uint64BigEndian(content.length));
    digest.update(content);
  }
  return digest.digest("hex");
}

/**
 * Stable digest of everything about the craft MCP set that a running session must be rebuilt
 * to pick up: the server set (key + url) and each server's disabled-tool set. Order-independent.
 * Mirrors onyx's `json.dumps(payload, sort_keys=True, separators=(",", ":"))` — the payload has
 * no dicts (sort_keys no-ops) and no separators means no whitespace, so `JSON.stringify` is the
 * exact analog. The element-wise sort below matches Python's `sorted()` list comparison for the
 * (unique-key) `[str, str, str[]]` entries; the third element compares by its JSON form, which
 * is a total order (not Python byte-parity, but determinism + order-independence are all the
 * fingerprint requires).
 */
export function craftMcpFingerprint(
  mcpServers: readonly CraftMCPServerConfig[],
): string {
  const payload = mcpServers
    .map((server): [string, string, string[]] => [
      server.key,
      server.url,
      [...server.disabledTools],
    ])
    .sort(compareMcpEntries);
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function compareMcpEntries(
  a: [string, string, string[]],
  b: [string, string, string[]],
): number {
  const pairs: Array<[string, string]> = [
    [a[0], b[0]],
    [a[1], b[1]],
    [JSON.stringify(a[2]), JSON.stringify(b[2])],
  ];
  for (const [left, right] of pairs) {
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

/**
 * Whether a live runtime predates the deployment's managed content — either the skill/app
 * payload (`skills_hash`) or the craft MCP set (`mcp_config_hash`). Both trigger the same
 * reload (rewrite config + dispose). The guards are onyx's verbatim: only an ACTIVE,
 * INTERACTIVE session with a live opencode id can be stale, and a null "current" hash can
 * never make one stale (nothing was pushed, so there is nothing to fall behind).
 */
export function sessionRuntimeStale(
  session: Pick<
    CraftSessionRow,
    "status" | "origin" | "opencodeSessionId" | "skillsHash" | "mcpConfigHash"
  >,
  currentSkillsHash: string | null,
  currentMcpHash: string | null,
): boolean {
  if (
    !(
      session.status === "active" &&
      session.origin === "INTERACTIVE" &&
      session.opencodeSessionId !== null
    )
  ) {
    return false;
  }
  const skillsChanged =
    currentSkillsHash !== null && session.skillsHash !== currentSkillsHash;
  const mcpChanged =
    currentMcpHash !== null && session.mcpConfigHash !== currentMcpHash;
  return skillsChanged || mcpChanged;
}
