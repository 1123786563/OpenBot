import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  type AccountStatus,
  personalSaasAccounts,
  personalSaasSessions,
  personalWorkspaceIntegrationGrants,
  personalWorkspaces,
} from "../db/schema/personal-saas";

import { reconcileDecisionHistory } from "./decision-access";
import { workspaceClosure } from "./workspace-closure-record";
import { latestSuspension } from "./workspace-suspension";

const cutoffMs = 60_000;
const millis = z.number().int().nonnegative();
const disablement = z.object({ id: z.string().min(1), effectiveAt: millis });
export type AccountDisablement = z.infer<typeof disablement>;

export const accountSnapshot = z
  .object({
    issuer: z.string(),
    subject: z.string(),
    observedAt: millis,
    active: z.boolean(),
    disablements: z.array(disablement),
  })
  .refine(
    ({ observedAt, disablements }) =>
      new Set(disablements.map(({ id }) => id)).size === disablements.length &&
      disablements.every(({ effectiveAt }) => effectiveAt <= observedAt),
  );

export type AccountSnapshot = z.infer<typeof accountSnapshot>;
type Identity = Pick<AccountSnapshot, "issuer" | "subject">;
export type AccountGrant = {
  accountId: string;
  epoch: number;
  expiresAt: number;
};

export function accountDecision(status: AccountStatus | null, now: number) {
  const disabledAt = status?.disablements.at(-1)?.effectiveAt;
  if (status?.source === "disabled" && disabledAt !== undefined) {
    return {
      kind: "denied",
      reason: "account_disabled",
      cutoffAt: disabledAt + cutoffMs,
    } as const;
  }
  const expiresAt =
    status?.confirmedAt == null ? null : status.confirmedAt + cutoffMs;
  if (status?.source !== "active" || expiresAt === null || now >= expiresAt) {
    return {
      kind: "denied",
      reason: "account_status_unconfirmed",
      cutoffAt: expiresAt,
    } as const;
  }
  return { kind: "active", epoch: status.epoch, expiresAt } as const;
}

/** Read under the account lock shared with provider refresh and operator suspension. */
export async function readExecutionAccess(
  tx: Pick<Database, "select">,
  accountId: string,
  now: () => number,
  epoch?: number,
  skipLocked = false,
) {
  const [account] = await tx
    .select({ status: personalSaasAccounts.status })
    .from(personalSaasAccounts)
    .where(eq(personalSaasAccounts.id, accountId))
    .for("share", skipLocked ? { skipLocked: true } : {});
  if (!account) return null;
  const closure = await workspaceClosure(tx, accountId);
  if (closure)
    return {
      kind: "denied",
      reason: "workspace_closed",
      cutoffAt: closure.acceptedAt.getTime(),
    } as const;
  const suspension = await latestSuspension(tx, accountId);
  const invalidation = account.status?.executionCutoffs?.find(
    (event) => epoch !== undefined && event.epoch > epoch,
  );
  if (invalidation) return { kind: "denied", ...invalidation } as const;
  if (suspension?.action === "pause")
    return {
      kind: "denied",
      reason: "workspace_paused",
      cutoffAt: suspension.effectiveAt.getTime(),
    } as const;
  if (
    suspension &&
    (account.status?.observedAt ?? 0) <= suspension.effectiveAt.getTime()
  )
    return {
      kind: "denied",
      reason: "account_status_unconfirmed",
      cutoffAt: suspension.effectiveAt.getTime(),
    } as const;
  const current = accountDecision(account.status, now());
  if (
    current.kind === "active" &&
    epoch !== undefined &&
    epoch !== current.epoch
  )
    return {
      kind: "denied",
      reason: "account_status_unconfirmed",
      cutoffAt: now(),
    } as const;
  return current;
}

export function createAccountAccess(
  database: Database,
  readSnapshot: (subject: string) => Promise<AccountSnapshot>,
  now: () => number = Date.now,
) {
  const inFlight = new Map<string, Promise<boolean>>();
  const accountFilter = ({ issuer, subject }: Identity) =>
    and(
      eq(personalSaasAccounts.issuer, issuer),
      eq(personalSaasAccounts.subject, subject),
    );

  async function refresh(identity: Identity) {
    const startedAt = now();
    const snapshot = await readSnapshot(identity.subject).catch(
      () => undefined,
    );
    if (
      !snapshot ||
      snapshot.issuer !== identity.issuer ||
      snapshot.subject !== identity.subject ||
      snapshot.observedAt > now()
    )
      return false;

    return database.transaction(async (tx) => {
      const [account] = await tx
        .select({
          id: personalSaasAccounts.id,
          status: personalSaasAccounts.status,
        })
        .from(personalSaasAccounts)
        .where(accountFilter(identity))
        .for("update");
      if (!account) return false;

      const before = account.status;
      const priorHistory = before?.disablements ?? [];
      const events = new Map(priorHistory.map((event) => [event.id, event]));
      let inconsistentEvent = false;
      for (const event of snapshot.disablements) {
        const prior = events.get(event.id);
        if (!prior) events.set(event.id, event);
        else if (prior.effectiveAt !== event.effectiveAt)
          inconsistentEvent = true;
      }
      const history = [...events.values()].sort(
        (a, b) => a.effectiveAt - b.effectiveAt,
      );
      const newDisablement = history.length > priorHistory.length;
      const latestDisablement = history.at(-1)?.effectiveAt;
      const older = before !== null && snapshot.observedAt < before.observedAt;
      if (older && !newDisablement) return false;

      const complete =
        history.length === snapshot.disablements.length && !inconsistentEvent;
      const conflicting =
        before !== null &&
        snapshot.observedAt === before.observedAt &&
        (before.source === "ambiguous" ||
          (before.source === "active") !== snapshot.active);
      const source =
        older || !complete || conflicting
          ? "ambiguous"
          : !snapshot.active
            ? latestDisablement === undefined
              ? "ambiguous"
              : "disabled"
            : latestDisablement !== undefined &&
                latestDisablement >= snapshot.observedAt
              ? "ambiguous"
              : "active";

      if (
        before &&
        before.observedAt === snapshot.observedAt &&
        !newDisablement &&
        source === before.source
      ) {
        return accountDecision(before, now()).kind === "active";
      }
      const confirmedAt = Math.min(startedAt, snapshot.observedAt);
      const epochChanged =
        newDisablement ||
        (before?.source === "active" &&
          (source !== "active" ||
            accountDecision(before, now()).kind === "denied" ||
            (before.confirmedAt !== null &&
              confirmedAt >= before.confirmedAt + cutoffMs)));
      const epoch = (before?.epoch ?? 0) + Number(epochChanged);
      const executionCutoffs = before?.executionCutoffs ?? [];
      if (epochChanged) {
        const newEvent = history.find(
          (event) => !priorHistory.some((prior) => prior.id === event.id),
        );
        executionCutoffs.push({
          epoch,
          reason: newEvent ? "account_disabled" : "account_status_unconfirmed",
          cutoffAt: newEvent
            ? newEvent.effectiveAt + cutoffMs
            : Math.min(now(), (before?.confirmedAt ?? now()) + cutoffMs),
        });
      }
      const status: AccountStatus = {
        source,
        observedAt: Math.max(before?.observedAt ?? 0, snapshot.observedAt),
        confirmedAt:
          source === "active"
            ? Math.max(before?.confirmedAt ?? 0, confirmedAt)
            : (before?.confirmedAt ?? null),
        epoch,
        executionCutoffs,
        disablements: history,
      };
      await tx
        .update(personalSaasAccounts)
        .set({ status })
        .where(eq(personalSaasAccounts.id, account.id));
      if (epochChanged) {
        await tx
          .delete(personalWorkspaceIntegrationGrants)
          .where(
            inArray(
              personalWorkspaceIntegrationGrants.workspaceId,
              tx
                .select({ id: personalWorkspaces.id })
                .from(personalWorkspaces)
                .where(eq(personalWorkspaces.ownerId, account.id)),
            ),
          );
      }
      if (newDisablement || source === "disabled") {
        await tx
          .delete(personalSaasSessions)
          .where(eq(personalSaasSessions.accountId, account.id));
      }
      return accountDecision(status, now()).kind === "active";
    });
  }

  function check(identity: Identity) {
    const key = JSON.stringify([identity.issuer, identity.subject]);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = refresh(identity).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  }

  async function decision(accountId: string) {
    return database.transaction(
      async (tx) =>
        (await readExecutionAccess(tx, accountId, now)) ??
        accountDecision(null, now()),
    );
  }

  return {
    check,
    decision,
    async refreshAccounts(issuer: string) {
      const accounts = await database
        .select({
          id: personalSaasAccounts.id,
          issuer: personalSaasAccounts.issuer,
          subject: personalSaasAccounts.subject,
        })
        .from(personalSaasAccounts)
        .where(eq(personalSaasAccounts.issuer, issuer));
      let failed = false;
      for (let start = 0; start < accounts.length; start += 16) {
        const batch = accounts.slice(start, start + 16);
        const results = await Promise.allSettled(
          batch.map(async ({ id, ...identity }) => {
            try {
              return await check(identity);
            } finally {
              await database.transaction((tx) =>
                reconcileDecisionHistory(tx, id, now),
              );
            }
          }),
        );
        failed ||= results.some((result) => result.status === "rejected");
      }
      if (failed) throw new Error("Could not persist account status");
    },
    async verify(grant: AccountGrant) {
      const current = await decision(grant.accountId);
      if (current.kind === "denied") return current;
      if (now() >= grant.expiresAt || grant.epoch !== current.epoch)
        return {
          kind: "denied",
          reason: "account_grant_invalidated",
          cutoffAt: Math.min(now(), grant.expiresAt),
        } as const;
      return {
        ...current,
        expiresAt: Math.min(current.expiresAt, grant.expiresAt),
      };
    },
  };
}
