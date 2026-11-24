import type { Database } from "../db/client";
import { users } from "../db/schema";

/** Satisfy the shared decision store's owner foreign keys without linking a legacy identity. */
export async function ensureDecisionActor(
  database: Pick<Database, "insert">,
  accountId: string,
) {
  await database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@personal-saas.invalid` })
    .onConflictDoNothing({ target: users.id });
}
