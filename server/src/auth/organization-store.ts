import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts, users } from "../db/schema";
import { DEV_ACTOR } from "./dev-actor";
import type { AuthenticatedActor } from "./guards";
import type { RemoteOrganizationIdentity } from "./organization";
import { setRole } from "./roles";

/*
 * T05.09: a remote authority's identity is its (issuer, subject) — the
 * registered authority origin plus the subject it named — never its email.
 * The server-confirmed mapping of one (issuer, subject) to one local user
 * lives in an `accounts` row under the "organization" provider. A same-email
 * local account that predates organization sign-in is adopted once and
 * claimed by that mapping (the controlled historical mapping); from then on
 * the email alone decides nothing, and a different issuer or subject with
 * the same email is refused instead of merged.
 */
const ORGANIZATION_PROVIDER = "organization";

const account = (user: RemoteOrganizationIdentity, userId: string) => ({
  id: randomUUID(),
  accountId: user.id,
  providerId: ORGANIZATION_PROVIDER,
  issuer: user.authority,
  userId,
});

/** Reconcile only an employee verified by the pinned authority; retain existing local history IDs. */
export function organizationUserStore(database: Database) {
  return async (
    user: RemoteOrganizationIdentity,
  ): Promise<AuthenticatedActor> => {
    if (user.id === DEV_ACTOR.id)
      throw new Error(
        "Organization sign-in cannot use the standalone account.",
      );

    const [bound] = await database
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, ORGANIZATION_PROVIDER),
          eq(accounts.accountId, user.id),
          eq(accounts.issuer, user.authority),
        ),
      )
      .limit(1);
    if (bound) {
      // The confirmed mapping: this exact (issuer, subject) already signed
      // in. Profile and role follow the authority's current word; the local
      // id, and with it the local history, never moves again.
      const [local] = await database
        .update(users)
        .set({
          email: user.email,
          name: user.name,
          image: user.image,
          updatedAt: new Date(),
        })
        .where(eq(users.id, bound.userId))
        .returning({ id: users.id });
      if (!local)
        throw new Error(
          "Organization sign-in lost the account its binding names.",
        );
      await setRole(database, local.id, user.role);
      return {
        id: local.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
      };
    }

    const [existing] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, user.email))
      .limit(1);
    if (existing) {
      // The controlled historical mapping: a local account nobody has
      // claimed is adopted once and claimed. The claim is a transaction that
      // first locks the local row: two concurrent same-email first sign-ins
      // serialize there, the loser re-reads the winner's claim and is
      // refused loudly instead of writing a second mapping (r1 F1). Once
      // claimed, a same-email arrival from any other subject or issuer is a
      // loud refusal, never a merge.
      return database.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, existing.id))
          .for("update");
        if (!locked)
          throw new Error(
            "Organization sign-in lost the local account it was adopting.",
          );
        const [claimed] = await tx
          .select({ userId: accounts.userId })
          .from(accounts)
          .where(
            and(
              eq(accounts.providerId, ORGANIZATION_PROVIDER),
              eq(accounts.userId, locked.id),
            ),
          )
          .limit(1);
        if (claimed)
          throw new Error(
            "Organization sign-in cannot adopt an account bound to a different remote identity.",
          );
        await tx.insert(accounts).values(account(user, locked.id));
        await tx
          .update(users)
          .set({ name: user.name, image: user.image, updatedAt: new Date() })
          .where(eq(users.id, locked.id));
        await setRole(tx, locked.id, user.role);
        return {
          id: locked.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        };
      });
    }

    // Nobody yet: a fresh local user, bound to this (issuer, subject) on the
    // spot.
    const id = randomUUID();
    await database.insert(users).values({
      id,
      email: user.email,
      name: user.name,
      image: user.image,
    });
    await database.insert(accounts).values(account(user, id));
    await setRole(database, id, user.role);
    return {
      id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
    };
  };
}
