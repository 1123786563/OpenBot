import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { z } from "zod";
import { seal, unseal } from "../auth/signed-value";
import type { Database } from "../db/client";
import {
  personalSaasAccounts,
  personalSaasSessions,
  personalSupportRequests,
  personalWorkspaceClosures,
  personalWorkspaceIntegrationGrants,
  personalWorkspaces,
  workItems,
} from "../db/schema";
import { accountDecision, type createAccountAccess } from "./account-access";
import { reconcileDecisionHistory } from "./decision-access";
import { cookieOptions, sessionCookie } from "./session-revocation";
import { personalSaasStore } from "./store";
import { closureProgress, workspaceClosure } from "./workspace-closure-record";
import {
  type workspaceComputer,
  workspaceComputerLeaseMs,
} from "./workspace-computer";
import { latestSuspension } from "./workspace-suspension";

const statusCookie = "__Host-openbot-closure-status";
const proofCookie = "__Host-openbot-closure-proof";
const settings = "/workspace/closure";
const lifetime = 10 * 60;
const workspaceToken = z.string().regex(/^[\w-]{43}$/);
const statusClaim = z.object({ accountId: z.uuid(), expiresAt: z.number() });
const closureProof = statusClaim.extend({
  epoch: z.number().int(),
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
  page,
}: {
  database: Database;
  accounts: Pick<ReturnType<typeof createAccountAccess>, "check">;
  encryptionKey: string;
  now: () => number;
  computer?: Pick<ReturnType<typeof workspaceComputer>, "stopped">;
  page: (
    title: string,
    body: ReturnType<typeof html>,
  ) => ReturnType<typeof html>;
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
        html`<p>Sign in and verify your identity to continue.</p><a href="/auth/casdoor/start">Sign in</a>`,
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
        html`
      <p>Closing your workspace is permanent. You will lose access and OpenBot will stop your work.</p>
      ${
        session.restricted
          ? ""
          : html`<form method="post" action="/api/workspaces/${workspace.id}/exports">
        <button type="submit">Download workspace data</button>
      </form>`
      }
      <form method="post" action="/auth/verify-closure">
        <button type="submit">Verify identity with Casdoor</button>
      </form>
    `,
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
      const existing = await workspaceClosure(tx, account.id);
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
      if (!workspace) return;
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
          })}::jsonb || jsonb_build_object('outcomeUnknown', ${workItems.attempts} > 0)`,
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
      await setClaim(context, statusCookie, { accountId: account.id });
    if (context.req.header("accept")?.includes("application/json"))
      return context.json(closureProgress(record));
    return context.redirect(`${settings}/progress`, 303);
  });

  routes.get(`${settings}/progress`, async (context) => {
    const user = await statusSession(context);
    if (!user || !(await accounts.check(user))) return denied(context);
    const record = await workspaceClosure(database, user.accountId);
    if (!record) return denied(context);
    const progress = closureProgress(record);
    if (context.req.header("accept")?.includes("application/json"))
      return context.json(progress);
    return context.html(
      page(
        "Workspace closure progress",
        html`
      <p>Operation ID <code>${progress.operationId}</code></p>
      <dl>
        <dt>Application sessions</dt><dd>Revoked</dd>
        <dt>Work cutoff</dt><dd>${progress.executionCutoff.work}</dd>
        <dt>Computer exit</dt><dd>${progress.executionCutoff.computer}</dd>
        <dt>Online data cleanup</dt><dd>${progress.onlineCleanup}</dd>
        <dt>Third-party revocation</dt><dd>${progress.remoteRevocation}</dd>
        <dt>Backup expiration</dt><dd>${progress.backups}</dd>
      </dl>
      <p><a href="${settings}/progress">Refresh progress</a></p>
    `,
      ),
    );
  });

  return {
    routes,
    subject,
    issueStatusCookie(context: Context, accountId: string) {
      deleteCookie(context, proofCookie, cookieOptions);
      return setClaim(context, statusCookie, { accountId });
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
      await setClaim(context, proofCookie, {
        accountId: proof.accountId,
        epoch: proof.epoch,
        sessionHash: hash(proof.token),
      });
      return context.html(
        page(
          "Confirm workspace closure",
          html`
        <p>This permanently closes your Personal Workspace and stops OpenBot work. Your Casdoor account and shared billing account will remain available.</p>
        <form method="post" action="${settings}/confirm"><button type="submit">Permanently close workspace</button></form>
        <a href="${settings}">Cancel</a>
      `,
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
              (await computer.stopped(closure.workspaceId).catch(() => false));
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
