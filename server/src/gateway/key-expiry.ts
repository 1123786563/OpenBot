/*
 * The short-lived virtual key's TERM (Bifrost 05.5, AC08/Q13/Q18): how long a minted key may
 * start new requests, where the number comes from, and what "expired" means operationally.
 *
 * ONE POLICY, STATED AT COMPOSITION. The term is the deployment's: fifteen minutes unless the
 * environment says otherwise (`BIFROST_VIRTUAL_KEY_TTL_MINUTES`), resolved once where the
 * issuer is composed (`createDeploymentKeyIssuer`) so an illegal value refuses the boot with
 * its reason instead of half-applying at some later request. The legal domain is a whole
 * number of minutes from 1 through {@link MAX_VIRTUAL_KEY_TTL_MINUTES} — zero and negatives
 * would mint keys already expired, fractions have no meaning at the minute grain the config
 * names, and beyond the ceiling the word "short-lived" (the Q13 design these keys exist
 * under) stops being true. The same refusal-sentence discipline the gateway endpoint
 * settings keep applies here: the reason names the variable, so an operator can fix the
 * environment without reading this file.
 *
 * EXPIRY IS A VERDICT, NOT AN ERASER. {@link gatewayKeyUsableForNewRequest} answers one
 * question — may this key start a new request — as a pure read against the record and a
 * caller-supplied clock (`now == expiresAt` is already expired, the boundary Bifrost's
 * `IsExpiredAt` keeps on the request path). It deletes nothing and releases nothing: an
 * expired key's record must survive, because it is part of what an already-incurred
 * consumption's settlement responsibility names (06.8/08.x: a timeout, an expiry, a client
 * cancel and a missing log are never release evidence), and 05.8's sync and 05.10's views
 * still read it. Revocation is a different gate with its own ticket (05.7) and its own
 * verdict; this seam answers expiry only.
 */

/** The term a deployment gets when its environment says nothing: fifteen minutes (Q13). */
export const DEFAULT_VIRTUAL_KEY_TTL_MINUTES = 15;

/**
 * The largest term a deployment may configure, in minutes: 24 hours. These keys are
 * short-lived by design — a term past a day would make "the plaintext rode out once, to an
 * authenticated Bot" a much longer exposure than the design admits.
 */
export const MAX_VIRTUAL_KEY_TTL_MINUTES = 1_440;

/** The environment variable a deployment sets to move the term off the default. */
export const VIRTUAL_KEY_TTL_MINUTES_VARIABLE =
  "BIFROST_VIRTUAL_KEY_TTL_MINUTES";

/**
 * Why a term configuration is illegal, in the voice `gatewayRequestTimeoutProblem` keeps:
 * the caller names the variable, this returns the sentence, or undefined when the value is
 * legal. A whole number of minutes, at least one, at most the ceiling.
 */
export function virtualKeyTtlMinutesProblem(
  name: string,
  value: unknown,
): string | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return `${name} must be a whole number of minutes`;
  }
  if (value <= 0) {
    return `${name} must be a whole number of minutes greater than zero`;
  }
  if (value > MAX_VIRTUAL_KEY_TTL_MINUTES) {
    return `${name} must not exceed ${MAX_VIRTUAL_KEY_TTL_MINUTES} minutes (24 hours): virtual keys are short-lived`;
  }
  return undefined;
}

/**
 * The deployment's term, in minutes: the environment's value when set (refused with its
 * reason when illegal — the composition throws, so a misconfigured deployment does not
 * start), the 15-minute default when the variable is absent or blank.
 */
export function resolveVirtualKeyTtlMinutes(
  environment: Record<string, string | undefined>,
): number {
  const raw = environment[VIRTUAL_KEY_TTL_MINUTES_VARIABLE]?.trim();
  if (!raw) return DEFAULT_VIRTUAL_KEY_TTL_MINUTES;
  const value = Number(raw);
  const problem = virtualKeyTtlMinutesProblem(
    VIRTUAL_KEY_TTL_MINUTES_VARIABLE,
    value,
  );
  if (problem) throw new Error(problem);
  return value;
}

/** Why a key may start no new request: the term has passed. Revocation is 05.7's own verdict. */
export type GatewayKeyExpiredReason = "gateway_key_expired";

/** What the expiry seam answers: usable, or refused with the reason and the instant. */
export type GatewayKeyExpiryVerdict =
  | { usable: true }
  | { usable: false; reason: GatewayKeyExpiredReason; expiredAt: string };

/**
 * Whether this key may start a NEW request, judged against the caller's clock. A pure read:
 * no write, no delete, no release, no status change — an expired record keeps every column
 * it had, because the settlement side of an already-incurred consumption still names it and
 * 05.8/05.10 still read it. The line is the same one the gateway draws: `now == expiresAt`
 * is expired, `expiresAt: null` (a pre-05.5 record) never expires by the clock, and a row
 * the state sync already marked `expired` is refused without consulting the clock at all.
 */
export function gatewayKeyUsableForNewRequest(
  row: { status: string; expiresAt: Date | string | null },
  now: Date,
): GatewayKeyExpiryVerdict {
  if (row.status === "expired") {
    return {
      usable: false,
      reason: "gateway_key_expired",
      expiredAt: toIso(row.expiresAt) ?? now.toISOString(),
    };
  }
  if (row.expiresAt === null) return { usable: true };
  const expiresAtMs = expiryMs(row.expiresAt);
  // Fail closed: past the null check above, an unreadable term is a damaged record, and a
  // damaged term must not read as "never expires" — the expiry gate's one job is refusing.
  if (expiresAtMs === undefined) {
    return {
      usable: false,
      reason: "gateway_key_expired",
      expiredAt: now.toISOString(),
    };
  }
  if (now.getTime() < expiresAtMs) return { usable: true };
  return {
    usable: false,
    reason: "gateway_key_expired",
    expiredAt: new Date(expiresAtMs).toISOString(),
  };
}

function expiryMs(expiresAt: Date | string | null): number | undefined {
  if (expiresAt === null) return undefined;
  if (expiresAt instanceof Date) return expiresAt.getTime();
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toIso(expiresAt: Date | string | null): string | undefined {
  if (expiresAt === null) return undefined;
  if (expiresAt instanceof Date) return expiresAt.toISOString();
  return expiresAt;
}
