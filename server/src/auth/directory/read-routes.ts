/*
 * The own invitation read surface (T04.01 / #545, original task P08;
 * interfaces §3.2's U-class adapter ruling).
 *
 * The two frozen paths live here — `GET /api/enterprise/invitations` (the
 * caller's own currently valid invitations) and `GET /:invitationId` (the
 * landing view). What the ruling fixes, and what this module is:
 *
 * - The BA native GETs stay closed (the ingress X rows never change); THIS
 *   adapter is the only reader. It answers one person's own invitations,
 *   matched by their VERIFIED mailbox — never the company's directory, never
 *   another address's invitations, and an unverified caller's list is empty.
 * - Unauthenticated, `/:invitationId` returns the minimal landing status
 *   (id, status, expired) — no email, no company, no role, no directory —
 *   so an invitation link shows its state without leaking who invited whom.
 *   An authenticated caller is answered from their own verified scope, and
 *   an invitation that is not theirs is answered exactly like a missing one.
 * - The invitee needs no prior membership or company proof to read their own
 *   invitation ("受邀者不需事先 member/proof"), so this surface performs no
 *   member/clock/assurance gate — the verified-email match IS the scope,
 *   and the later business actions keep their own gates.
 *
 * Production mounting arrives with the P10/T08 assembly; this file ships the
 * routes and the reader the assembly consumes.
 */

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../../db/client";
import type { AuthenticatedRequestIdentity } from "../../enterprise/tenancy/store";
import { directorySurfaceErrorResponse } from "../../enterprise/tenancy/workspace-scope-routes";

export const INVITATION_READ_NOT_FOUND = "INVITATION_READ_NOT_FOUND";
export const INVITATION_AUTH_REQUIRED = "AUTH_REQUIRED";

/** The minimal unauthenticated landing status of one invitation. */
export interface InvitationLandingView {
  readonly invitationId: string;
  readonly status: string;
  readonly expired: boolean;
}

/** One of the caller's own, currently valid invitations. */
export interface OwnInvitationView extends InvitationLandingView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly role: string | null;
  readonly teamId: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface OwnInvitationReader {
  landing(invitationId: string): Promise<InvitationLandingView | null>;
  listOwn(userId: string): Promise<readonly OwnInvitationView[]>;
  findOwn(
    userId: string,
    invitationId: string,
  ): Promise<OwnInvitationView | null>;
}

/** Drizzle's execute answers rows directly on Bun SQL; both shapes read the same. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/**
 * The reader over the deployment database. Every read is a plain SELECT —
 * the own scope comes from the verified-email match, never from a gate —
 * and only currently valid invitations (pending, unexpired) are listed.
 */
export function createOwnInvitationReader(
  database: Pick<Database, "execute">,
): OwnInvitationReader {
  const reader: OwnInvitationReader = {
    async landing(invitationId) {
      if (!isSafeId(invitationId)) return null;
      const [row] = rowsOf(
        await database.execute(
          sql`SELECT status,
                    expires_at <= now() AS expired
               FROM auth_invitations WHERE id = ${invitationId} LIMIT 1`,
        ),
      );
      if (!row) return null;
      return {
        invitationId,
        status: String(row.status),
        expired: row.expired === true,
      };
    },

    async listOwn(userId) {
      const [user] = rowsOf(
        await database.execute(
          sql`SELECT email, email_verified
                                              FROM users WHERE id = ${userId} LIMIT 1`,
        ),
      );
      if (user?.email_verified !== true) return [];
      const rows = rowsOf(
        await database.execute(
          sql`
            SELECT i.id, i.organization_id, o.name AS organization_name,
                   i.email, i.role, i.team_id,
                   i.expires_at::text AS expires_at,
                   i.created_at::text AS created_at, i.status,
                   i.expires_at <= now() AS expired
              FROM auth_invitations i
              JOIN auth_organizations o ON o.id = i.organization_id
             WHERE lower(i.email) = lower(${String(user.email)})
               AND i.status = 'pending' AND i.expires_at > now()
             ORDER BY i.created_at, i.id`,
        ),
      );
      return rows.map((row) => ({
        invitationId: String(row.id),
        organizationId: String(row.organization_id),
        organizationName: String(row.organization_name ?? ""),
        email: String(row.email),
        role: row.role === null ? null : String(row.role),
        teamId: row.team_id === null ? null : String(row.team_id),
        status: String(row.status),
        expired: row.expired === true,
        expiresAt: String(row.expires_at),
        createdAt: String(row.created_at),
      }));
    },

    async findOwn(userId, invitationId) {
      if (!isSafeId(invitationId)) return null;
      const [user] = rowsOf(
        await database.execute(
          sql`SELECT email, email_verified
                                              FROM users WHERE id = ${userId} LIMIT 1`,
        ),
      );
      if (user?.email_verified !== true) return null;
      const [row] = rowsOf(
        await database.execute(
          sql`
            SELECT i.id, i.organization_id, o.name AS organization_name,
                   i.email, i.role, i.team_id,
                   i.expires_at::text AS expires_at,
                   i.created_at::text AS created_at, i.status,
                   i.expires_at <= now() AS expired
              FROM auth_invitations i
              JOIN auth_organizations o ON o.id = i.organization_id
             WHERE i.id = ${invitationId}
               AND lower(i.email) = lower(${String(user.email)})
               AND i.status = 'pending' AND i.expires_at > now()
             LIMIT 1`,
        ),
      );
      if (!row) return null;
      return {
        invitationId: String(row.id),
        organizationId: String(row.organization_id),
        organizationName: String(row.organization_name ?? ""),
        email: String(row.email),
        role: row.role === null ? null : String(row.role),
        teamId: row.team_id === null ? null : String(row.team_id),
        status: String(row.status),
        expired: row.expired === true,
        expiresAt: String(row.expires_at),
        createdAt: String(row.created_at),
      };
    },
  };
  return Object.freeze(reader);
}

export interface InvitationReadRouteDeps {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  reader: OwnInvitationReader;
}

/**
 * The two U-class routes. `GET /` requires a signed-in caller (401 without
 * one); `GET /:invitationId` serves the minimal landing status without a
 * session and the caller's own full view with one.
 */
export function createInvitationReadRoutes(
  deps: InvitationReadRouteDeps,
): Hono {
  const routes = new Hono();

  routes.get("/", async (context) => {
    try {
      const identity = await deps.authenticate(context.req.raw);
      if (!identity?.actorId) {
        return context.json(
          {
            error: {
              code: INVITATION_AUTH_REQUIRED,
              message: "Request refused.",
            },
          },
          401,
        );
      }
      const invitations = await deps.reader.listOwn(identity.actorId);
      return context.json({ invitations });
    } catch (error) {
      const mapped = directorySurfaceErrorResponse(error);
      return context.json(
        mapped.body,
        mapped.status as 400 | 401 | 403 | 404 | 500 | 503,
      );
    }
  });

  routes.get("/:invitationId", async (context) => {
    try {
      const invitationId = context.req.param("invitationId");
      const identity = await deps.authenticate(context.req.raw);
      if (identity?.actorId) {
        const own = await deps.reader.findOwn(identity.actorId, invitationId);
        if (!own) {
          return context.json(
            {
              error: {
                code: INVITATION_READ_NOT_FOUND,
                message: "Request refused.",
              },
            },
            404,
          );
        }
        return context.json({ invitation: own });
      }
      const landing = await deps.reader.landing(invitationId);
      if (!landing) {
        return context.json(
          {
            error: {
              code: INVITATION_READ_NOT_FOUND,
              message: "Request refused.",
            },
          },
          404,
        );
      }
      return context.json({ invitation: landing });
    } catch (error) {
      const mapped = directorySurfaceErrorResponse(error);
      return context.json(
        mapped.body,
        mapped.status as 400 | 401 | 403 | 404 | 500 | 503,
      );
    }
  });

  return routes;
}
