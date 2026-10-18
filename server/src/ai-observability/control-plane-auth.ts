/**
 * Opik control-plane authorization and internal producer authentication (Issue #38 / DAG T32).
 *
 * Two questions, two doors, and no key that opens both:
 *
 *  - WHO reaches the Opik control surface — console, private APIs, connection
 *    config, management diagnostics, credentials — is answered from the same
 *    application identity requireUser already established (T09's seam):
 *    `ControlPlaneActor` is the AuthenticatedActor's id and OpenBotRole, nothing
 *    else. There is no Opik user store here, and no function that reads one: a
 *    human is authorized by the platform role they hold in OpenBot, or not at
 *    all. Today that qualification is the application `admin` role; when the
 *    enterprise Spec lands, `hasPlatformQualification` is the one predicate to
 *    replace — a tenant administrator must not inherit whole-instance access by
 *    sharing this role name.
 *
 *  - WHAT writes into the ingestion path is answered by the internal producer
 *    credential alone. It is minted inside the process, handed once to trusted
 *    wiring, and verified by digest comparison. A session is not ingest
 *    material: `verify` takes no actor. Symmetrically, a producer credential is
 *    not an identity: `authorizeControlPlane` accepts one only so a valid
 *    machine credential can be recognized — and refused — instead of being
 *    mistaken for a missing session. Private APIs therefore cannot bypass the
 *    role check, because the role check is the only path to them.
 *
 * WIRING STATUS (OCR m118): this module is BUILT, NOT WIRED. The T32 deployment
 * boundary shipped as the reverse proxy's loopback binding (opik.yml) instead of
 * an in-process ingest route, so no production caller consults these predicates
 * yet — the only exercise is this module's own suite. They are the reserved seam
 * for the moment a private API passthrough or ingest route lands in-process;
 * until then this header, not the call graph, is where that intent lives.
 *
 * Everything fails closed: missing material, malformed actors, unrecognized
 * resources and wrong credentials are all refusals, with the missing and wrong
 * credential answering identically so nothing distinguishes a near miss. The
 * token rides in no output, no error, and no serialization this module can
 * produce; issuance never reads the environment, so the upstream OPIK_API_KEY
 * can never become an internal credential by accident.
 *
 * Boundary: this module proves policy at this seam. It does not, by itself,
 * protect the deployed Opik endpoint — the reverse proxy's loopback binding and
 * any pass-through wiring are what keep unauthenticated traffic from arriving
 * at Opik at all. See the T32 implementation report for the deployment claim.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import type { OpenBotRole } from "../auth/roles";

/** The application identity, not a new one: exactly what requireUser established. */
export type ControlPlaneActor = Readonly<{
  id: string;
  role: OpenBotRole;
}>;

/** Every Opik surface a human could touch. Adding one is a decision, not a default. */
export type ControlPlaneResource =
  | "console"
  | "private-api"
  | "connection-config"
  | "management-diagnostics"
  | "credentials";

export type ControlPlaneAuthErrorCode =
  | "AUTH_REQUIRED"
  | "PLATFORM_QUALIFICATION_REQUIRED"
  | "PRODUCER_AUTH_REQUIRED"
  | "PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE"
  | "CONTROL_PLANE_RESOURCE_UNKNOWN";

export type ControlPlaneRefusal = {
  ok: false;
  status: 401 | 403;
  error: ControlPlaneAuthErrorCode;
};

export type ControlPlaneAccess =
  | { ok: true; actorId: string }
  | ControlPlaneRefusal;

export type ProducerWriteAuthorization =
  | { ok: true }
  | { ok: false; status: 401; error: "PRODUCER_AUTH_REQUIRED" };

/** The one qualification that opens the whole-instance console. The enterprise seam. */
function hasPlatformQualification(actor: ControlPlaneActor): boolean {
  return actor.role === "admin";
}

const CONTROL_PLANE_RESOURCES: ReadonlySet<string> =
  new Set<ControlPlaneResource>([
    "console",
    "private-api",
    "connection-config",
    "management-diagnostics",
    "credentials",
  ]);

const REDACTED = "internal-producer-credential(redacted)";

/** One frozen refusal per code: refusals are shared constants, never per-call state. */
const REFUSAL = Object.freeze({
  AUTH_REQUIRED: Object.freeze({
    ok: false,
    status: 401,
    error: "AUTH_REQUIRED",
  }),
  PLATFORM_QUALIFICATION_REQUIRED: Object.freeze({
    ok: false,
    status: 403,
    error: "PLATFORM_QUALIFICATION_REQUIRED",
  }),
  PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE: Object.freeze({
    ok: false,
    status: 403,
    error: "PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE",
  }),
  CONTROL_PLANE_RESOURCE_UNKNOWN: Object.freeze({
    ok: false,
    status: 403,
    error: "CONTROL_PLANE_RESOURCE_UNKNOWN",
  }),
  PRODUCER_AUTH_REQUIRED: Object.freeze({
    ok: false,
    status: 401,
    error: "PRODUCER_AUTH_REQUIRED",
  }),
}) satisfies Record<ControlPlaneAuthErrorCode, ControlPlaneRefusal>;

/**
 * The internal producer credential. Constructed only by its own
 * `InternalProducerCredential.issue`; there is no exported way to build one from
 * chosen material, so a forgery has to beat the random 256 bits it was minted
 * from. The token is readable by trusted wiring exactly once at handoff —
 * serialization, inspection and copies all redact or drop it.
 */
export class InternalProducerCredential {
  #token: string;

  private constructor(token: string) {
    this.#token = token;
  }

  /** Mint the credential trusted wiring hands to the internal producer. */
  static issue(): InternalProducerCredential {
    return new InternalProducerCredential(
      randomBytes(32).toString("base64url"),
    );
  }

  /** Opaque bearer material for the trusted internal producer. Never echo it. */
  get token(): string {
    return this.#token;
  }

  /**
   * The one question the ingestion entry asks. Digests both sides before
   * comparing, so the comparison is constant-time over a fixed length and no
   * wrong-length offer can make it throw. A non-string (including an object
   * with a coercing toString) is refused before any coercion happens.
   */
  verify(offered: unknown): ProducerWriteAuthorization {
    if (typeof offered !== "string" || offered.length === 0) {
      return REFUSAL.PRODUCER_AUTH_REQUIRED;
    }
    const offeredDigest = createHash("sha256").update(offered).digest();
    const expectedDigest = createHash("sha256").update(this.#token).digest();
    if (!timingSafeEqual(offeredDigest, expectedDigest)) {
      return REFUSAL.PRODUCER_AUTH_REQUIRED;
    }
    return { ok: true };
  }

  /** JSON serialization of the credential is a redaction, never the token. */
  toJSON(): string {
    return REDACTED;
  }

  /** Console/inspect output of the credential is a redaction, never the token. */
  [inspect.custom](): string {
    return REDACTED;
  }
}

/**
 * The single decision every control-plane surface consults — console reads,
 * private-API pass-throughs, connection-config and diagnostics views. There is
 * no credential-only path to any resource, so no Opik-side key or internal
 * token can arrive here as authorization.
 */
export function authorizeControlPlane(input: {
  actor: ControlPlaneActor | null | undefined;
  resource: ControlPlaneResource;
  /**
   * Pass the issued credential so a valid producer token can be recognized and
   * refused as an identity. Omitting it changes no outcome: a caller without a
   * session is unauthenticated either way, fail closed.
   */
  producerCredential?: InternalProducerCredential;
  /** Whatever the request offered as producer material, raw. */
  offeredProducerToken?: unknown;
}): ControlPlaneAccess {
  if (!CONTROL_PLANE_RESOURCES.has(input.resource)) {
    return REFUSAL.CONTROL_PLANE_RESOURCE_UNKNOWN;
  }

  const actor = input.actor;
  if (typeof actor !== "object" || actor === null || !actor.id) {
    if (
      input.producerCredential?.verify(input.offeredProducerToken).ok === true
    ) {
      return REFUSAL.PRODUCER_NOT_AUTHORIZED_FOR_CONTROL_PLANE;
    }
    return REFUSAL.AUTH_REQUIRED;
  }

  if (!hasPlatformQualification(actor)) {
    return REFUSAL.PLATFORM_QUALIFICATION_REQUIRED;
  }

  return { ok: true, actorId: actor.id };
}
