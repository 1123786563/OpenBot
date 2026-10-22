import type { Database } from "../db/client";
import type { CreditGrantResult, CreditWriter } from "./credits-writer";
import type { PayerAccount } from "./payer";
import {
  type PersonalUserIdentity,
  resolvePersonalPayerAccount,
} from "./payer-personal";
import type { CreditGrantSource } from "./types";

/**
 * The reward path's attribution and idempotency wiring (Bifrost 10.4, AC14): a reward — a
 * check-in, a campaign handout — is granted to the CLAIMER'S OWN personal account, once per
 * reward period, whatever the client asks for.
 *
 * The two properties the ticket names live in the composition, not in checks:
 *
 * - ATTRIBUTION: the target account is `resolvePersonalPayerAccount`'s answer for the
 *   authenticated user, the same branch the personal credit reads resolve through (02.4). No
 *   account identity is an input here — there is no parameter a forged `userId` or
 *   `externalCustomerId` could ride, so a redirect is not refused, it is unrepresentable.
 * - IDEMPOTENCY: one occurrence is named by user + reward type + period, laid into the
 *   `reward:` key the ledger's unique index fences with. A replayed claim reads the row that
 *   already exists (`inserted: false` and the original grant) — the same committed-state
 *   answer `grantCredits` gives every retry; the next period is a different key and a
 *   genuinely new grant.
 *
 * Deliberately NOT here: an activity system. The definitions below are the minimal server-owned
 * policy (amount, lifetime, trail reason) the claim route serves; a campaign that needs more
 * grows definitions, never client-named inputs.
 */

/** The sources a reward can come from: the reward side of `CreditGrantSource`, never "plan". */
export type RewardType = Extract<CreditGrantSource, "promo" | "signin">;

/** The reward types the claim route serves. Minimal: the check-in. Grows with the catalog. */
export const REWARD_TYPES = ["signin"] as const;

/** One reward's server-owned policy: what it pays, how long it lives, why the ledger says. */
export type RewardDefinition = {
  /** Scaled credit units (×100) — the ledger's integer discipline, never a client number. */
  totalCents: number;
  /** The grant's life, in days from the claim. */
  ttlDays: number;
  /** The ledger row's reason — the operator's own words stand in for the campaign's. */
  reason: string;
};

/**
 * The reward catalog. Amount and lifetime are DEPLOYMENT POLICY, decided here and nowhere else:
 * a request names the reward type and nothing else, so "how much am I worth" is never a number
 * the client supplied.
 */
export const rewardDefinitions: Record<
  (typeof REWARD_TYPES)[number],
  RewardDefinition
> = {
  // One credit a day, alive a year — the same default life a manual grant gets. Both numbers
  // are the minimal honest policy; a real campaign tunes them here or adds a type here.
  signin: { totalCents: 100, ttlDays: 365, reason: "每日签到奖励" },
};

/**
 * One reward occurrence's stable name: `reward:<type>:<period>:<user>`. The user rides the key
 * itself, so two claimers in the same period are two occurrences by construction — the period
 * fence is per-person, and no cross-user collision or claim-over is even expressible. The
 * `reward:` prefix keeps the namespace beside `plan:` and `admin-personal:` on the one unique
 * index every grant idempotency key shares.
 */
export function rewardIdempotencyKey(input: {
  userId: string;
  rewardType: RewardType;
  period: string;
}): string {
  return `reward:${input.rewardType}:${input.period}:${input.userId}`;
}

/**
 * The UTC calendar day of `at` — the signin reward's period. The client never supplies a
 * period: the "same period" in the once-per-period rule is the deployment's clock's answer,
 * so a client cannot shop for a day it already claimed (or one it hasn't earned).
 */
export function rewardPeriodOfDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** One claim as the granter answers it: the ledger row, the resolved account, the key. */
export type RewardGrantResult = {
  /** `false` = a replay; the grant is the original occurrence, unchanged. */
  inserted: boolean;
  grant: CreditGrantResult;
  account: PayerAccount;
  idempotencyKey: string;
};

export type RewardGranter = {
  /**
   * Grant one reward occurrence to the claimer's own personal account. `period` is the
   * server-owned fence token (the route derives it from its clock); `totalCents` and
   * `expiresAt` come from the server's reward definition, never from a request.
   */
  grantReward(input: {
    user: PersonalUserIdentity;
    rewardType: RewardType;
    period: string;
    totalCents: number;
    expiresAt: Date;
    reason?: string | null;
  }): Promise<RewardGrantResult>;
};

export function createRewardGranter(deps: {
  database: Database;
  creditWriter: CreditWriter;
}): RewardGranter {
  return {
    async grantReward(input) {
      // The period rides inside the idempotency key verbatim, so a broken one would silently
      // fence the wrong occurrences; refuse loudly at the seam instead.
      if (
        typeof input.period !== "string" ||
        input.period.length === 0 ||
        input.period.length > 100 ||
        input.period.trim() !== input.period
      ) {
        throw new TypeError(
          "grantReward needs a period token of 1-100 characters with no surrounding whitespace (e.g. rewardPeriodOfDay's YYYY-MM-DD).",
        );
      }
      // THE resolution: the claimer's own personal account, from the authenticated identity
      // alone. Created idempotently on first claim — an account is a mapping row, born empty.
      const account = await resolvePersonalPayerAccount(
        deps.database,
        input.user,
      );
      const idempotencyKey = rewardIdempotencyKey({
        userId: input.user.id,
        rewardType: input.rewardType,
        period: input.period,
      });
      // The write is the ledger's own insert-or-nothing: a replay lands nothing new and reads
      // the original grant; a first claim inserts one row. A refusal (bad amount, ledger
      // unavailable) leaves no grant behind — the only earlier write is the empty account
      // mapping, which is identity, not credits.
      const { inserted, grant } = await deps.creditWriter.grantCredits({
        externalCustomerId: account.externalCustomerId,
        source: input.rewardType,
        totalCents: input.totalCents,
        expiresAt: input.expiresAt,
        reason: input.reason ?? null,
        idempotencyKey,
      });
      return { inserted, grant, account, idempotencyKey };
    },
  };
}
