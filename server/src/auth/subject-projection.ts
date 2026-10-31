/*
 * #715 OpenBot side of the identity-center contract: the center owns identity
 * writes, OpenBot keeps only a controlled compatibility projection (its own
 * userId plus principalId) and the company/team permissions it already held.
 *
 * Two rules shape this module:
 *
 * 1. The verified identity comes from the center, never from an email or a
 *    display name. `SubjectRef` is what the center returned for a verified
 *    (issuer, subject); nothing here searches by email or creates a user.
 *
 * 2. A projection is only created against a *fresh* center answer. The center
 *    is asked for the subject's status on every projection: an unreachable
 *    center is a refusal (fail-closed), and a missing subject is refused
 *    rather than guessed — a stale or absent state must never create a
 *    principal.
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts } from "../db/schema";
import { ensurePrincipal } from "./directory/principal-registry";
import type { AuthenticatedActor, AuthService, RoleRepository } from "./guards";
import type { OpenBotRole } from "./roles";

export type SubjectRef = Readonly<{
  subjectId: string;
  issuer: string;
  subject: string;
  generation: number;
}>;

export const SUBJECT_PROJECTION_UNKNOWN_ACCOUNT =
  "SUBJECT_PROJECTION_UNKNOWN_ACCOUNT";
export const SUBJECT_PROJECTION_UNKNOWN_SUBJECT =
  "SUBJECT_PROJECTION_UNKNOWN_SUBJECT";
export const SUBJECT_PROJECTION_DISABLED = "SUBJECT_PROJECTION_DISABLED";
export const SUBJECT_PROJECTION_GENERATION_CHANGED =
  "SUBJECT_PROJECTION_GENERATION_CHANGED";

export class SubjectProjectionRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "SubjectProjectionRefusal";
  }
}

/** The center's current answer for one subject. Throwing means "unavailable". */
export type CenterStatusReader = {
  status(
    subjectId: string,
  ): Promise<{ active: boolean; generation: number } | null>;
};

/** The local projection facts: the account the center issued, and the principal. */
export type SubjectProjectionStore = {
  accountForSubject: (
    subjectId: string,
  ) => Promise<{ userId: string } | undefined>;
  subjectForUser: (
    userId: string,
  ) => Promise<{ subjectId: string } | undefined>;
  ensurePrincipal: (userId: string) => Promise<{ principalId: string }>;
};

/** HTTP client for the center's internal subject API (Bearer service token). */
export function createCenterStatusClient(options: {
  issuer: string;
  internalToken: string;
}): CenterStatusReader {
  const base = options.issuer.replace(/\/$/, "");
  const call = async (
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.internalToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      if (payload.error?.code === "SUBJECT_UNKNOWN") return {};
      throw new Error(`identity center refused ${path} with 404`);
    }
    if (!response.ok) {
      throw new Error(
        `identity center answered ${path} with ${response.status}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    async status(subjectId) {
      const body = await call("/internal/subjects/status", { subjectId });
      if (body.active === undefined) return null;
      return {
        active: body.active === true,
        generation: Number(body.generation),
      };
    },
  };
}

export function createDrizzleSubjectProjectionStore(
  database: Database,
  options: { providerId?: string } = {},
): SubjectProjectionStore {
  const providerId = options.providerId ?? "identity-center";
  return {
    async accountForSubject(subjectId) {
      const [row] = await database
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(
          and(
            eq(accounts.providerId, providerId),
            eq(accounts.accountId, subjectId),
          ),
        )
        .limit(1);
      return row;
    },
    async subjectForUser(userId) {
      const [row] = await database
        .select({ subjectId: accounts.accountId })
        .from(accounts)
        .where(
          and(eq(accounts.providerId, providerId), eq(accounts.userId, userId)),
        )
        .limit(1);
      return row;
    },
    async ensurePrincipal(userId) {
      return database.transaction(async (tx) => {
        const principal = await ensurePrincipal(tx, userId);
        return { principalId: principal.principalId };
      });
    },
  };
}

export type SubjectProjection = {
  /**
   * Map a verified center subject onto this deployment's userId + principalId.
   * `generation` comes from the verified token/ref; a different current
   * generation means the projection must be re-verified, not reused.
   */
  projectVerifiedSubject(
    ref: SubjectRef,
  ): Promise<{ userId: string; principalId: string }>;
  /** The actor of an identity-center session, or null when this request is not one. */
  resolveCenterActor(request: Request): Promise<AuthenticatedActor | null>;
};

export function createSubjectProjection(deps: {
  center: CenterStatusReader;
  store: SubjectProjectionStore;
  auth: AuthService;
  roles: RoleRepository;
}): SubjectProjection {
  const project = async (
    subjectId: string,
    expectedGeneration: number | null,
  ): Promise<{ userId: string; principalId: string }> => {
    const account = await deps.store.accountForSubject(subjectId);
    if (!account) {
      throw new SubjectProjectionRefusal(
        SUBJECT_PROJECTION_UNKNOWN_ACCOUNT,
        `subject ${subjectId} has no identity-center account in this deployment`,
      );
    }
    // Fresh center answer first: an outage or an unknown subject never creates anything.
    const status = await deps.center.status(subjectId);
    if (!status) {
      throw new SubjectProjectionRefusal(
        SUBJECT_PROJECTION_UNKNOWN_SUBJECT,
        `the identity center does not know subject ${subjectId}`,
      );
    }
    if (!status.active) {
      throw new SubjectProjectionRefusal(
        SUBJECT_PROJECTION_DISABLED,
        `subject ${subjectId} is disabled at the identity center`,
      );
    }
    if (
      expectedGeneration !== null &&
      status.generation !== expectedGeneration
    ) {
      throw new SubjectProjectionRefusal(
        SUBJECT_PROJECTION_GENERATION_CHANGED,
        `subject ${subjectId} is at generation ${status.generation}, not ${expectedGeneration}`,
      );
    }
    const principal = await deps.store.ensurePrincipal(account.userId);
    return { userId: account.userId, principalId: principal.principalId };
  };

  const roleOf = (roles: OpenBotRole[]): OpenBotRole | undefined =>
    roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : undefined;

  return {
    async projectVerifiedSubject(ref) {
      return project(ref.subjectId, ref.generation);
    },

    async resolveCenterActor(request) {
      let session: Awaited<ReturnType<AuthService["api"]["getSession"]>>;
      try {
        session = await deps.auth.api.getSession({ headers: request.headers });
      } catch {
        // An unreadable session is not an absent one; answer as unauthenticated
        // here and let the guard's 503 path stay the one that names the outage.
        return null;
      }
      if (!session) return null;
      const subject = await deps.store.subjectForUser(session.user.id);
      if (!subject) return null;
      // The center's current generation is the verified one for this request.
      const status = await deps.center.status(subject.subjectId);
      if (!status?.active) return null;
      const roles = await deps.roles.rolesForUser(session.user.id);
      const role = roleOf(roles);
      if (!role) return null;
      const projected = await project(subject.subjectId, status.generation);
      return {
        id: projected.userId,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
        role,
      };
    },
  };
}
