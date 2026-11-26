import { createHash } from "node:crypto";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { seal, unseal } from "../auth/signed-value";
import type { Database } from "../db/client";
import {
  personalIntelligenceRuns,
  personalSaasAccounts,
  personalSaasSessions,
  personalSupportRequests,
  personalWorkspaceAgenticSpaces,
  personalWorkspaceClosures,
  personalWorkspaceIntegrationGrants,
  personalWorkspaces,
  workItems,
} from "../db/schema";
import { accountDecision, type createAccountAccess } from "./account-access";
import {
  agenticStorageLocator,
  onlineCleanupSteps,
} from "./closure-cleanup-contract";
import { reconcileDecisionHistory } from "./decision-access";
import { readIntelligenceInventory } from "./intelligence-inventory";
import { cookieOptions, sessionCookie } from "./session-revocation";
import { createPersonalWorkspace, personalSaasStore } from "./store";
import { page } from "./web-page";
import {
  cleanupConfirmed,
  closureProgress,
  workspaceClosure,
} from "./workspace-closure-record";
import {
  type workspaceComputer,
  workspaceComputerLeaseMs,
} from "./workspace-computer";
import { latestSuspension } from "./workspace-suspension";

const cleanupLabels = {
  postgres: "Workspace database",
  computerVolume: "Computer volume",
  exports: "Export copies",
  caches: "Caches",
  indexes: "Indexes",
  internalServices: "Internal services",
} satisfies Record<(typeof onlineCleanupSteps)[number], string>;

const statusCookie = "__Host-openbot-closure-status";
const proofCookie = "__Host-openbot-closure-proof";
const settings = "/workspace/closure";
const lifetime = 10 * 60;
const workspaceToken = z.string().regex(/^[\w-]{43}$/);
const statusClaim = z.object({
  accountId: z.uuid(),
  expiresAt: z.number(),
  operationId: z.uuid().optional(),
});
const closureProof = statusClaim.extend({
  epoch: z.number().int(),
  workspaceId: z.uuid(),
  sessionHash: workspaceToken,
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

export function workspaceClosureRoutes({
  database,
  accounts,
  encryptionKey,
  now,
  computer,
  admissionsPaused,
}: {
  database: Database;
  accounts: Pick<ReturnType<typeof createAccountAccess>, "check">;
  encryptionKey: string;
  now: () => number;
  computer?: Pick<ReturnType<typeof workspaceComputer>, "processStopped">;
  admissionsPaused: boolean;
}) {
  const routes = new Hono();
  const store = personalSaasStore(database, now);

  async function readClaim(context: Context, name: string) {
    const raw = await unseal(getCookie(context, name), encryptionKey, name);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed;
  }

  async function setClaim(context: Context, name: string, data: object) {
    setCookie(
      context,
      name,
      await seal(
        JSON.stringify({ ...data, expiresAt: now() + lifetime * 1000 }),
        encryptionKey,
        name,
      ),
      { ...cookieOptions, maxAge: lifetime },
    );
  }

  async function identity(accountId: string) {
    const [account] = await database
      .select()
      .from(personalSaasAccounts)
      .where(eq(personalSaasAccounts.id, accountId));
    return account;
  }

  async function browserSession(context: Context) {
    const token = workspaceToken.safeParse(getCookie(context, sessionCookie));
    const session = token.success ? await store.session(token.data) : undefined;
    if (session && token.success)
      return { ...session, token: token.data, restricted: false as const };
  }

  async function statusSession(context: Context) {
    const token = getCookie(context, statusCookie);
    const claim = statusClaim.safeParse(await readClaim(context, statusCookie));
    if (!token || !claim.success || claim.data.expiresAt <= now()) return;
    const account = await identity(claim.data.accountId);
    if (account)
      return {
        ...account,
        accountId: account.id,
        operationId: claim.data.operationId,
        token,
        restricted: true as const,
      };
  }

  async function subject(context: Context) {
    const session =
      (await statusSession(context)) ?? (await browserSession(context));
    if (!session || !(await accounts.check(session))) return;
    if (session.restricted) {
      const paused = await latestSuspension(database, session.accountId);
      if (
        paused?.action !== "pause" ||
        (await workspaceClosure(database, session.accountId))
      )
        return;
    }
    const current = await identity(session.accountId);
    const active = accountDecision(current?.status ?? null, now());
    if (active.kind === "active") return { ...session, epoch: active.epoch };
  }

  function denied(context: Context) {
    return context.html(
      page(
        "Workspace closure unavailable",
        <>
          {" "}
          <Text as="p">Sign in and verify your identity to continue.</Text>
          <Link href="/auth/casdoor/start">Sign in</Link>{" "}
        </>,
      ),
      403,
    );
  }

  routes.get(settings, async (context) => {
    const session = await subject(context);
    if (!session) return denied(context);
    const workspace = await store.workspace(session.accountId);
    if (!workspace || !(await subject(context))) return denied(context);
    return context.html(
      page(
        "Close your Personal Workspace",
        <>
          <Text as="p">
            Closing your workspace is permanent. You will lose access and
            OpenBot will stop your work.
          </Text>
          {session.restricted ? (
            ""
          ) : (
            <form
              method="post"
              action={`/api/workspaces/${workspace.id}/exports`}
            >
              <Button type="submit" label="Download workspace data" />
            </form>
          )}
          <form method="post" action="/auth/verify-closure">
            <Button type="submit" label="Verify identity with Casdoor" />
          </form>
        </>,
      ),
    );
  });

  routes.post(`${settings}/confirm`, async (context) => {
    const proof = closureProof.safeParse(await readClaim(context, proofCookie));
    if (!proof.success || proof.data.expiresAt <= now()) return denied(context);
    const normalToken = getCookie(context, sessionCookie);
    const restrictedToken = getCookie(context, statusCookie);
    const tokens = [normalToken, restrictedToken].filter(
      (token) => token !== undefined,
    );
    const token = tokens.find(
      (value) => hash(value) === proof.data.sessionHash,
    );
    if (!token) return denied(context);

    const account = await identity(proof.data.accountId);
    if (!account || !(await accounts.check(account))) return denied(context);
    const record = await database.transaction(async (tx) => {
      const [owner] = await tx
        .select()
        .from(personalSaasAccounts)
        .where(eq(personalSaasAccounts.id, account.id))
        .for("update");
      const access = accountDecision(owner?.status ?? null, now());
      if (!owner?.status || access.kind !== "active") return;
      const [existing] = await tx
        .select()
        .from(personalWorkspaceClosures)
        .where(
          and(
            eq(personalWorkspaceClosures.accountId, account.id),
            eq(personalWorkspaceClosures.workspaceId, proof.data.workspaceId),
          ),
        );
      if (existing) return existing;
      if (access.epoch !== proof.data.epoch) return;
      if (token === normalToken) {
        const live = await personalSaasStore(tx, now).session(token);
        if (live?.accountId !== account.id) return;
      } else if ((await latestSuspension(tx, account.id))?.action !== "pause") {
        return;
      }
      const [workspace] = await tx
        .select()
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.ownerId, account.id));
      if (!workspace || workspace.id !== proof.data.workspaceId) return;
      const acceptedAt = new Date(now());
      const [closure] = await tx
        .insert(personalWorkspaceClosures)
        .values({
          accountId: account.id,
          workspaceId: workspace.id,
          acceptedAt,
          cutoffDeadline: new Date(acceptedAt.getTime() + 60_000),
        })
        .returning();
      if (!closure) throw new Error("Workspace closure was not recorded");
      const epoch = access.epoch + 1;
      await tx
        .update(personalSaasAccounts)
        .set({
          status: {
            ...owner.status,
            epoch,
            executionCutoffs: [
              ...(owner.status.executionCutoffs ?? []),
              {
                epoch,
                reason: "workspace_closed",
                cutoffAt: acceptedAt.getTime(),
              },
            ],
          },
        })
        .where(eq(personalSaasAccounts.id, account.id));
      await tx
        .delete(personalSaasSessions)
        .where(eq(personalSaasSessions.accountId, account.id));
      await tx
        .update(personalSupportRequests)
        .set({ revokedAt: acceptedAt })
        .where(
          and(
            eq(personalSupportRequests.workspaceId, workspace.id),
            isNull(personalSupportRequests.revokedAt),
          ),
        );
      await tx
        .delete(personalWorkspaceIntegrationGrants)
        .where(
          eq(personalWorkspaceIntegrationGrants.workspaceId, workspace.id),
        );
      await tx
        .update(workItems)
        .set({
          interruption: sql`${JSON.stringify({
            reason: "workspace_closed",
            cutoffAt: acceptedAt.getTime(),
            recordedAt: acceptedAt.getTime(),
          })}::text::jsonb || jsonb_build_object('outcomeUnknown', ${workItems.attempts} > 0)`,
          leaseUntil: null,
        })
        .where(
          and(
            eq(workItems.accountId, account.id),
            isNull(workItems.finishedAt),
            isNull(workItems.interruption),
          ),
        );
      await reconcileDecisionHistory(tx, account.id, now);
      return closure;
    });
    if (!record) return denied(context);
    // Keep the paused flow's original status cookie so its retried POST
    // can still authenticate. Normal workspace proofs bind to the other cookie.
    if (token === normalToken)
      await setClaim(context, statusCookie, {
        accountId: account.id,
        operationId: record.id,
      });
    if (context.req.header("accept")?.includes("application/json"))
      return context.json(closureProgress(record));
    return context.redirect(`${settings}/progress`, 303);
  });

  routes.get(`${settings}/progress`, async (context) => {
    const user = await statusSession(context);
    if (!user || !(await accounts.check(user))) return denied(context);
    const active = await workspaceClosure(database, user.accountId);
    const [record] = user.operationId
      ? await database
          .select()
          .from(personalWorkspaceClosures)
          .where(
            and(
              eq(personalWorkspaceClosures.id, user.operationId),
              eq(personalWorkspaceClosures.accountId, user.accountId),
            ),
          )
      : [active];
    if (!record) return denied(context);
    const suspension = await latestSuspension(database, user.accountId);
    const canOpen = active?.id === record.id && cleanupConfirmed(record);
    const progress = closureProgress(record);
    if (context.req.header("accept")?.includes("application/json"))
      return context.json(progress);
    return context.html(
      page(
        "Workspace closure progress",
        <>
          <Text as="p">
            Operation ID <code>{progress.operationId}</code>
          </Text>
          <dl>
            <dt>Application sessions</dt>
            <dd>Revoked</dd>
            <dt>Work cutoff</dt>
            <dd>{progress.executionCutoff.work}</dd>
            <dt>Computer exit</dt>
            <dd>{progress.executionCutoff.computer}</dd>
            <dt>Online data cleanup</dt>
            <dd>
              <List edge="flush" hasDividers>
                {onlineCleanupSteps.map((step) => (
                  <ListItem
                    key={step}
                    label={
                      <VStack gap={2}>
                        {cleanupLabels[step]}:{" "}
                        {progress.onlineCleanup[step]?.status ?? "pending"}
                      </VStack>
                    }
                  />
                ))}
              </List>
            </dd>
            <dt>Third-party revocation</dt>
            <dd>{progress.remoteRevocation.status}</dd>
            <dt>Backup expiration</dt>
            <dd>
              {progress.backups.stores.length ? (
                <List edge="flush" hasDividers>
                  {progress.backups.stores.map((store) => (
                    <ListItem
                      key={store.store}
                      label={
                        <VStack gap={2}>
                          {store.store}: {store.retentionDays} days, expires by{" "}
                          <time dateTime={store.remainingCopiesExpireBy}>
                            {store.remainingCopiesExpireBy}
                          </time>
                        </VStack>
                      }
                    />
                  ))}
                </List>
              ) : (
                "Schedule pending"
              )}
            </dd>
          </dl>
          {canOpen && (admissionsPaused || suspension?.action === "pause") ? (
            <Text as="p" role="status">
              {admissionsPaused
                ? "New workspace openings are temporarily paused. Check back to try again."
                : "Your workspace suspension must be lifted before you can open a new workspace."}
            </Text>
          ) : (
            canOpen && (
              <form method="post" action={`${settings}/reprovision`}>
                <input type="hidden" name="operationId" value={record.id} />
                <Button type="submit" label="Open a new workspace" />
              </form>
            )
          )}
          <Text as="p">
            <Link href={`${settings}/progress`}>Refresh progress</Link>
          </Text>
        </>,
      ),
    );
  });

  routes.post(`${settings}/reprovision`, async (context) => {
    const user = await statusSession(context);
    if (!user?.operationId || !(await accounts.check(user)))
      return denied(context);
    const request = z
      .object({ operationId: z.uuid() })
      .safeParse(await context.req.parseBody().catch(() => undefined));
    if (!request.success || user.operationId !== request.data.operationId)
      return denied(context);

    const result = await database.transaction(async (tx) => {
      const [owner] = await tx
        .select()
        .from(personalSaasAccounts)
        .where(eq(personalSaasAccounts.id, user.accountId))
        .for("update");
      if (accountDecision(owner?.status ?? null, now()).kind !== "active")
        return "denied";
      const active = await workspaceClosure(tx, user.accountId);
      if (active?.id !== request.data.operationId) return "unavailable";
      const suspension = await latestSuspension(tx, user.accountId);
      if (
        suspension &&
        (suspension.action === "pause" ||
          (owner?.status?.observedAt ?? 0) <= suspension.effectiveAt.getTime())
      )
        return "unavailable";
      const [record] = await tx
        .select()
        .from(personalWorkspaceClosures)
        .where(eq(personalWorkspaceClosures.id, active.id))
        .for("update");
      if (!record || !cleanupConfirmed(record)) return "unavailable";
      if (admissionsPaused) return "paused";
      const [storage] = await tx
        .select()
        .from(personalWorkspaceAgenticSpaces)
        .where(
          eq(personalWorkspaceAgenticSpaces.workspaceId, record.workspaceId),
        );
      const storageRecovery =
        record.storageRecovery ??
        (storage
          ? {
              kind: "agenticfs",
              ...agenticStorageLocator.parse(storage),
              released: true,
            }
          : { kind: "none" });
      const inventory = await readIntelligenceInventory(tx, [user.accountId]);
      await tx
        .update(personalWorkspaceClosures)
        .set({
          storageRecovery: sql`${JSON.stringify(storageRecovery)}::text::jsonb`,
          retiredIntelligence: inventory.map(
            ({ agentId, threadId, runId }) => ({ agentId, threadId, runId }),
          ),
        })
        .where(eq(personalWorkspaceClosures.id, record.id));
      await tx
        .delete(personalIntelligenceRuns)
        .where(eq(personalIntelligenceRuns.accountId, user.accountId));
      await tx
        .delete(personalWorkspaces)
        .where(eq(personalWorkspaces.id, record.workspaceId));
      await createPersonalWorkspace(tx, user.accountId);
      return "opened";
    });
    if (result === "denied") return denied(context);
    if (result === "opened")
      return context.redirect("/auth/casdoor/start", 303);
    return context.html(
      page(
        "Workspace opening unavailable",
        <>
          {" "}
          <Text as="p" role="status">
            {result === "paused"
              ? "New workspace openings are temporarily paused. Check back to try again."
              : "This closure is not eligible to open a new workspace."}
          </Text>
          <Link href={`${settings}/progress`}>Check closure progress</Link>{" "}
        </>,
      ),
      result === "paused" ? 503 : 409,
    );
  });

  return {
    routes,
    subject,
    issueStatusCookie(
      context: Context,
      accountId: string,
      operationId?: string,
    ) {
      deleteCookie(context, proofCookie, cookieOptions);
      return setClaim(context, statusCookie, { accountId, operationId });
    },
    clearCookies(context: Context) {
      deleteCookie(context, statusCookie, cookieOptions);
      deleteCookie(context, proofCookie, cookieOptions);
    },
    async verified(
      context: Context,
      proof: { accountId: string; token: string; epoch: number },
    ) {
      const session = await subject(context);
      if (
        !session ||
        session.accountId !== proof.accountId ||
        session.token !== proof.token ||
        session.epoch !== proof.epoch
      )
        return denied(context);
      const workspace = await store.workspace(proof.accountId);
      if (!workspace) return denied(context);
      await setClaim(context, proofCookie, {
        accountId: proof.accountId,
        workspaceId: workspace.id,
        epoch: proof.epoch,
        sessionHash: hash(proof.token),
      });
      return context.html(
        page(
          "Confirm workspace closure",
          <>
            <Text as="p">
              This permanently closes your Personal Workspace and stops OpenBot
              work. Your Casdoor account and shared billing account will remain
              available.
            </Text>
            <form method="post" action={`${settings}/confirm`}>
              <Button
                type="submit"
                variant="destructive"
                label="Permanently close workspace"
              />
            </form>
            <Link href={settings}>Cancel</Link>
          </>,
        ),
      );
    },
    async sweep() {
      const pending = await database
        .select()
        .from(personalWorkspaceClosures)
        .where(
          or(
            isNull(personalWorkspaceClosures.workCutoff),
            isNull(personalWorkspaceClosures.computerCutoff),
          ),
        );
      const results = await Promise.allSettled(
        pending.map(async (closure) => {
          const deadline = closure.cutoffDeadline.getTime();
          async function recordWork() {
            const [unconfirmed] = await database
              .select({ key: workItems.key })
              .from(workItems)
              .where(
                and(
                  eq(workItems.accountId, closure.accountId),
                  or(
                    isNotNull(workItems.claimedBy),
                    sql`(${workItems.interruption}->>'endedAt')::bigint > ${deadline}`,
                  ),
                ),
              )
              .limit(1);
            const workCutoff = unconfirmed
              ? now() >= deadline
                ? "failed"
                : null
              : "confirmed";
            if (workCutoff)
              await database
                .update(personalWorkspaceClosures)
                .set({ workCutoff })
                .where(
                  and(
                    eq(personalWorkspaceClosures.id, closure.id),
                    isNull(personalWorkspaceClosures.workCutoff),
                  ),
                );
          }
          async function recordComputer() {
            // A start approved just before closure may still reach the supervisor.
            // Wait out every such grant before using an absence observation.
            if (
              computer &&
              now() < closure.acceptedAt.getTime() + workspaceComputerLeaseMs
            )
              return;
            const stopped =
              computer &&
              now() < deadline &&
              (await computer
                .processStopped(closure.workspaceId)
                .catch(() => false));
            const computerCutoff = !computer
              ? "confirmed"
              : now() >= deadline
                ? "failed"
                : stopped
                  ? "confirmed"
                  : null;
            if (computerCutoff)
              await database
                .update(personalWorkspaceClosures)
                .set({ computerCutoff })
                .where(
                  and(
                    eq(personalWorkspaceClosures.id, closure.id),
                    isNull(personalWorkspaceClosures.computerCutoff),
                  ),
                );
          }
          await Promise.all([
            closure.workCutoff ? undefined : recordWork(),
            closure.computerCutoff ? undefined : recordComputer(),
          ]);
        }),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Could not record Workspace Closure cutoff");
    },
  };
}
