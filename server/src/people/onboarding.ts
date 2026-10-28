import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";

/**
 * Where one person is in first-run onboarding.
 *
 * A null `completedAt` is what gates the app into /onboarding. `step` is stored and served but
 * NOTHING RESUMES FROM IT YET: the wizard keeps its step in browser state while its content is
 * still being designed, so this stays 0 through a whole run. It exists so resuming is a frontend
 * change when the wizard settles, not a migration.
 */
export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

export type OnboardingStore = {
  status: (userId: string) => Promise<OnboardingStatus>;
  setStep: (userId: string, step: number) => Promise<void>;
  complete: (userId: string) => Promise<void>;
};

export function createOnboardingStore(database: Database): OnboardingStore {
  return {
    async status(userId) {
      const [row] = await database
        .select({
          step: users.onboardingStep,
          completedAt: users.onboardingCompletedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      /*
       * No row reads as not started rather than as an error. It should not happen — a session
       * cannot outlive its users row (the foreign key cascades) and the single-user actor's row is
       * seeded at startup — but a guard that throws here would take /api/me down with it.
       */
      return {
        step: row?.step ?? 0,
        completedAt: row?.completedAt ? row.completedAt.toISOString() : null,
      };
    },

    async setStep(userId, step) {
      // Completed is frozen: a step write after completion would disturb "when did they
      // onboard" and the audit order of the two stamps.
      await database
        .update(users)
        .set({ onboardingStep: step, updatedAt: sql`now()` })
        .where(
          and(
            eq(users.id, userId),
            isNull(users.onboardingCompletedAt),
          ),
        );
    },

    async complete(userId) {
      const updated = await database
        .update(users)
        .set({
          // Idempotent: finishing again keeps the first timestamp, so "when did they onboard"
          // stays one answer. Both stamps come from the database clock, so they cannot disagree.
          onboardingCompletedAt: sql`coalesce(${users.onboardingCompletedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      // A users row that is not there must not read as success: the person would be bounced
      // back into /onboarding forever with nothing on any log.
      if (updated.length === 0)
        throw new Error(`The users row ${userId} is missing; cannot complete onboarding.`);
    },
  };
}
