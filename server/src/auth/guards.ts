import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import { userRoles } from "../db/schema";
import type { OpenBotRole } from "./roles";

const log = getLogger("server");

export type AuthenticatedActor = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: OpenBotRole;
};

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
      query?: { disableCookieCache: boolean };
    }) => Promise<{
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
        /** Set only by a server-verified organization authority. */
        role?: OpenBotRole;
      };
    } | null>;
  };
};

export type RoleRepository = {
  rolesForUser: (userId: string) => Promise<OpenBotRole[]>;
};

export type AppVariables = {
  actor: AuthenticatedActor;
};

export function createRoleRepository(database: Database): RoleRepository {
  return {
    rolesForUser: async (userId) => {
      const records = await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      return records.map((record) => record.role);
    },
  };
}

export function createRequireUser(
  auth: AuthService,
  roleRepository: RoleRepository,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    // Auth-backend and role-store faults answer as a named 503, not as a bare 500 from an
    // exception escaping the middleware. Route errors below `next()` are not caught here:
    // those belong to the routers' own error handling.
    let session: Awaited<ReturnType<AuthService["api"]["getSession"]>>;
    try {
      session = await auth.api.getSession({
        headers: context.req.raw.headers,
        query: { disableCookieCache: true },
      });
    } catch (error) {
      log.error(
        { err: error },
        "Could not read the session in the auth guard.",
      );
      return context.json(
        { error: "Sign-in is temporarily unavailable. Try again." },
        503,
      );
    }

    if (!session) {
      return context.json({ error: "Authentication required." }, 401);
    }

    let roles: OpenBotRole[];
    try {
      /*
       * The platform role is read from the deployment's own table, never taken
       * from the session (T05.07): a session-carried role is a company
       * (organization) authority's word about a membership, and the platform
       * gate takes no company's word for who administers the deployment. The
       * read is per request, so a role changed a moment ago applies now.
       */
      roles = await roleRepository.rolesForUser(session.user.id);
    } catch (error) {
      log.error({ err: error }, "Could not read roles in the auth guard.");
      return context.json(
        { error: "Sign-in is temporarily unavailable. Try again." },
        503,
      );
    }
    const role = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : undefined;

    if (!role) {
      return context.json({ error: "Authorization required." }, 403);
    }

    context.set("actor", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      role,
    });
    await next();
  };
}

export function requireAdmin(context: Context<{ Variables: AppVariables }>) {
  if (context.var.actor.role !== "admin") {
    return context.json({ error: "Administrator access required." }, 403);
  }

  return undefined;
}
