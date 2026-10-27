import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { userRoles } from "../db/schema";

export type OpenBotRole = "admin" | "user";

/**
 * The write surface a role or sign-in stamp needs. A drizzle Database and an
 * open transaction both satisfy it, so the sign-in hooks can run on the fixed
 * build's own transaction (T05.06: seedRole/stampSignIn/provisionUser share
 * the command's commit) while the admin-screen writers keep using the pool.
 */
export type RoleDatabase = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "transaction"
>;

/**
 * Whether this address is an administrator by configuration.
 *
 * A floor, not the whole answer. Somebody named here is always an administrator and cannot be
 * demoted from the admin screen, which is what makes it the way back in when the last administrator
 * demotes themselves by accident. Everybody else's role is whatever an administrator has set.
 */
export function isConfiguredAdmin(
  email: string,
  initialAdminEmails: readonly string[],
): boolean {
  const normalizedEmail = email.trim().toLowerCase();

  return initialAdminEmails.some(
    (adminEmail) => adminEmail.trim().toLowerCase() === normalizedEmail,
  );
}

export function roleForEmail(
  email: string,
  initialAdminEmails: readonly string[],
): OpenBotRole {
  return isConfiguredAdmin(email, initialAdminEmails) ? "admin" : "user";
}

/**
 * Give somebody exactly one role.
 *
 * `user_roles` is a set with a `(user_id, role)` primary key and the guard takes `admin` if any row
 * says so, so setting a role means removing the rows that should not be there rather than only
 * inserting one. Both statements inside one transaction: between them a request arriving on another
 * process would find no role at all and be refused with a 403 that reads as a permissions bug.
 */
export async function setRole(
  database: RoleDatabase,
  userId: string,
  role: OpenBotRole,
): Promise<OpenBotRole> {
  await database.transaction(async (tx) => {
    await tx
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), ne(userRoles.role, role)));
    await tx.insert(userRoles).values({ userId, role }).onConflictDoNothing();
  });

  return role;
}

/**
 * The role a brand-new account starts with — the one-time bootstrap.
 *
 * The only moment configuration decides somebody who is not on the list: from here on that person's
 * role belongs to whoever administers the deployment. T05.06 sealed the floor here: a later
 * sign-in never re-applies it, so once an administrator has changed the role the next ordinary
 * login leaves it exactly where the admin screen put it.
 */
export async function seedRole(
  database: RoleDatabase,
  userId: string,
  email: string,
  initialAdminEmails: readonly string[],
): Promise<OpenBotRole> {
  return setRole(database, userId, roleForEmail(email, initialAdminEmails));
}
