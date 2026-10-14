import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { openmuseAccountDeletions } from "../openmuse-deletion/store";

/*
 * D01's marker read, shared: goals/ideas/memories each carried a verbatim copy of this
 * phase-aware query beside a verbatim copy of the error class, and the three copies could
 * drift — one module's route would then catch its own class while another module's store
 * threw a different one, landing a 500 for the same §9 state. One class, one read, the
 * deletion store's own isDisabled shape (a restored marker re-admits).
 */

/** §9: the owner is disabled — a still-`fenced` deletion marker stands. */
export class OpenMuseOwnerDisabledError extends Error {
  constructor(ownerUserId: string) {
    super(`Owner ${ownerUserId} is disabled.`);
    this.name = "OpenMuseOwnerDisabledError";
  }
}

/** The one phase-aware fence read every personal module's rows seam runs. */
export function createOwnerDisabled(
  database: Database,
): (ownerUserId: string) => Promise<boolean> {
  return async (ownerUserId) => {
    const rows = await database
      .select({ userId: openmuseAccountDeletions.userId })
      .from(openmuseAccountDeletions)
      .where(
        and(
          eq(openmuseAccountDeletions.userId, ownerUserId),
          eq(openmuseAccountDeletions.phase, "fenced"),
        ),
      );
    return rows.length > 0;
  };
}
