/**
 * The TLS renewal-status file's admission verdict (#411, AC6/AC8).
 *
 * `tls/renewal-status.json` is the durable scalar record the TLS sidecar's renewal guard
 * writes (health, healthReason, daysLeft, attempt/success/alert audit — see
 * reference/tls-certs.md). The preview origin's HOST form terminates TLS in front of the
 * server: while that certificate is missing, expired, or mid-first-issuance, the origin's
 * addresses would answer browser TLS failures, so admission closes with the reason the
 * record names instead of handing out addresses nobody can load. The DEV form never
 * consults this gate — its addresses are plain http on a local port, no certificate
 * anywhere in the path.
 *
 * The verdict is FAIL-CLOSED at every seam: a missing file, an unreadable or malformed
 * one, or an unknown health value all close the origin, because each of those means
 * certificate health cannot be judged, and an unjudgeable certificate is not a healthy
 * one. `starting` is special only in its sentence: a fresh deployment's first issuance
 * is minutes of DNS-01 propagation, not a failure, but the honest answer is still
 * "closed while the first certificate is being issued".
 *
 * The gate re-judges WITHOUT a restart: every verdict call stats the file, and a new
 * mtime or size (either alone — coarse filesystems round mtimes) re-reads and re-parses.
 * The cache holds exactly the last read's (mtime, size) → verdict; an unchanged stat is
 * the cached answer, so the per-request cost is one statSync of a file the sidecar
 * rewrites only on renewal events.
 */

import { readFileSync, statSync } from "node:fs";

/** Where the main compose mounts the sidecar's tls/ directory (read-only). */
export const DEFAULT_TLS_STATUS_FILE = "/etc/openbot/tls/renewal-status.json";

/** The gate's answer: open, or closed with the sentence a person can read. */
export type TlsStatusVerdict = { ok: true } | { ok: false; reason: string };

/** The record's scalar health vocabulary (renewal-guard.sh's bands, plus failed). */
export type TlsStatusHealth =
  | "starting"
  | "ok"
  | "warn"
  | "critical"
  | "failed";

/** The record's shape as this gate reads it: the scalars the verdict turns on. */
export type TlsStatusRecord = {
  health?: unknown;
  healthReason?: unknown;
  daysLeft?: unknown;
};

/**
 * The pure mapping from one record's JSON text to the verdict — the one place the
 * vocabulary is judged, kept free of filesystem so the five health bands and every
 * malformed shape are testable without touching a disk.
 */
export function tlsStatusVerdictOf(json: string): TlsStatusVerdict {
  let record: TlsStatusRecord;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") {
      return unreadable("it does not hold a JSON object");
    }
    record = parsed as TlsStatusRecord;
  } catch {
    return unreadable("it is not valid JSON");
  }
  const health = record.health;
  if (health === "ok" || health === "warn") {
    // daysLeft is the authority even on a green band: the health word is the
    // guard's last classification, the remaining days are the fact. A warn at
    // 3 days left is still open (renewal is expected before the band turns),
    // a stale "ok" with the certificate already past its date is not.
    const daysLeft = record.daysLeft;
    if (
      typeof daysLeft === "number" &&
      Number.isFinite(daysLeft) &&
      daysLeft > 0
    ) {
      return { ok: true };
    }
    return closed(
      "the TLS certificate has no days left",
      record.healthReason,
      health,
    );
  }
  if (health === "starting") {
    return {
      ok: false,
      reason:
        "The preview origin is closed while the first TLS certificate is being issued (renewal-status.json health=starting).",
    };
  }
  if (health === "critical" || health === "failed") {
    return closed(
      `the TLS certificate is ${health === "critical" ? "in the critical renewal band" : "failing to renew"}`,
      record.healthReason,
      health,
    );
  }
  return unreadable(`its health is "${String(health)}", not a known band`);
}

function closed(
  what: string,
  healthReason: unknown,
  health: TlsStatusHealth,
): TlsStatusVerdict {
  const detail =
    typeof healthReason === "string" && healthReason.trim().length > 0
      ? ` The renewal guard's reason: ${healthReason.trim()}`
      : "";
  return {
    ok: false,
    reason: `The preview origin is closed: ${what} (renewal-status.json health=${health}).${detail}`,
  };
}

function unreadable(what: string): TlsStatusVerdict {
  return {
    ok: false,
    reason: `The preview origin is closed: the TLS status file cannot be judged — ${what}. Check the TLS sidecar (docker/compose/certs.yml) and OPENBOT_TLS_STATUS_FILE.`,
  };
}

/** One stat+read of the status file: null text means the file is absent/unreadable. */
export type TlsStatusFileRead = {
  mtimeMs: number;
  size: number;
  text: string | null;
};

/**
 * The gate: `verdict()` answers the current admission decision, re-reading the file only
 * when its (mtime, size) moved. `read` is injectable for hermetic tests; production
 * reads synchronously — the admission path is synchronous by contract, the stat is the
 * per-request cost, and the file is a sidecar-maintained scalar record, not a hot path.
 */
export function createTlsStatusGate(deps: {
  statusFile: string;
  read?: (path: string) => TlsStatusFileRead;
}): { verdict(): TlsStatusVerdict } {
  const read =
    deps.read ??
    ((path: string): TlsStatusFileRead => {
      try {
        const stats = statSync(path);
        return {
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          text: readFileSync(path, "utf8"),
        };
      } catch {
        // Absent is unreadable is closed: the verdict names the file, not the errno.
        return { mtimeMs: -1, size: -1, text: null };
      }
    });
  let cache: {
    mtimeMs: number;
    size: number;
    verdict: TlsStatusVerdict;
  } | null = null;
  return {
    verdict() {
      const current = read(deps.statusFile);
      if (
        cache !== null &&
        cache.mtimeMs === current.mtimeMs &&
        cache.size === current.size
      ) {
        return cache.verdict;
      }
      const verdict =
        current.text === null
          ? unreadable("it is missing")
          : tlsStatusVerdictOf(current.text);
      cache = {
        mtimeMs: current.mtimeMs,
        size: current.size,
        verdict,
      };
      return verdict;
    },
  };
}
