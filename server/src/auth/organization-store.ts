import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { userRoles, users } from "../db/schema";
import { DEV_ACTOR } from "./dev-actor";
import type { AuthenticatedActor } from "./guards";

/** Reconcile only an employee verified by the pinned authority; retain existing local history IDs. */
export function organizationUserStore(database: Database) {
  return async (user: AuthenticatedActor) => {
    if (user.id === DEV_ACTOR.id)
      throw new Error(
        "Organization sign-in cannot use the standalone account.",
      );
    // Reconcile by the LOCAL id first: a person whose email changed at the authority still
    // arrives with their original id, and `ON CONFLICT (email)` does not catch a PRIMARY KEY
    // conflict — the raw 23505 would lock that person out of sign-in with no self-heal path.
    const [local] = await database.transaction(async (tx) => {
      const [byId] = await tx
        .update(users)
        .set({
          email: user.email,
          name: user.name,
          image: user.image,
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, user.id), ne(users.id, DEV_ACTOR.id)))
        .returning({ id: users.id });
      const [row] = byId
        ? [byId]
        : await tx
            .insert(users)
            .values({
              id: user.id,
              email: user.email,
              name: user.name,
              image: user.image,
            })
            .onConflictDoUpdate({
              target: users.email,
              setWhere: ne(users.id, DEV_ACTOR.id),
              set: {
                email: user.email,
                name: user.name,
                image: user.image,
                updatedAt: new Date(),
              },
            })
            .returning({ id: users.id });
      if (!row || row.id === DEV_ACTOR.id)
        throw new Error(
          "Organization sign-in cannot use the standalone account.",
        );
      // The role rides the same transaction as the reconcile (the same two statements
      // `setRole` runs): a row committed without one would be refused with a 403 that
      // reads as a broken deployment and would not heal until the next sign-in.
      await tx
        .delete(userRoles)
        .where(
          and(eq(userRoles.userId, row.id), ne(userRoles.role, user.role)),
        );
      await tx
        .insert(userRoles)
        .values({ userId: row.id, role: user.role })
        .onConflictDoNothing();
      return [row];
    });
    return { ...user, id: local.id };
  };
}
