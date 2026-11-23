import { createHash, createHmac } from "node:crypto";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { createApprovalRoutes } from "../approvals/routes";
import { createApprovalStore } from "../approvals/store";
import { seal, unseal } from "../auth/signed-value";
import type {
  OneTimeTestCreditGrantConfig,
  TestCreditLedger,
} from "../billing/test-credit";
import type { TestCreditExecutor } from "../billing/test-credit-routes";
import type { Database } from "../db/client";
import { createWorkQueue, unattendedWorkLabels } from "../work/queue";
import { backgroundBotKinds } from "../work/unattended-kinds";
import {
  type AccountGrant,
  accountDecision,
  createAccountAccess,
} from "./account-access";
import { personalAutomation } from "./automation";
import {
  automationPath,
  inboundRelay,
  inboundRelayPath,
  workspaceAutomationRoutes,
} from "./automation-routes";
import {
  personalBackgroundWorkers,
  retryBackgroundWork,
} from "./background-work";
import type { createPersonalBotRuntime } from "./bot-runtime";
import {
  botWorkInput,
  PERSONAL_BOT_WORK,
  personalBotWork,
  queuedBotWorkInput,
  recoveryInput,
} from "./bot-work";
import { browserAttempt, type CasdoorConfig, casdoor } from "./casdoor";
import type { ClosureCleanup } from "./closure-cleanup-contract";
import { ensureDecisionActor } from "./decision-actor";
import { integrationGrantRoutes } from "./integration-grant-routes";
import { trackIntelligenceRuns } from "./intelligence-inventory";
import { bearerSession, type NativeAttempt, nativeAuth } from "./native-auth";
import {
  WorkspaceQuotaExceeded,
  type WorkspaceQuotaLimits,
  workspaceQuotaConfig,
  workspaceQuotas,
} from "./quotas";
import { sessionEventRoutes } from "./session-events";
import {
  cookieOptions,
  sessionCookie,
  sessionRevocationRoutes,
} from "./session-revocation";
import { personalSaasStore, sessionSeconds } from "./store";
import { supportAccess } from "./support-access";
import { supportRoutes } from "./support-routes";
import { botRunCreditQuote, personalTestCreditExecution } from "./test-credit";
import { page, pageStyleAttributePolicy, registerPageStyles } from "./web-page";
import {
  type WeKnoraEmbeddingExecutor,
  weknoraEmbeddingRoutes,
} from "./weknora-embedding-routes";
import { weknoraGrantRoutes } from "./weknora-grant-routes";
import {
  workspaceAttachmentDrafts,
  workspaceAttachmentRoutes,
} from "./workspace-attachments";
import { workspaceBotRoutes } from "./workspace-bot-routes";
import { workspaceBots } from "./workspace-bots";
import { workspaceCleanup } from "./workspace-cleanup";
import { workspaceClosureRoutes } from "./workspace-closure";
import { workspaceClosure } from "./workspace-closure-record";
import {
  type WorkspaceComputerConfig,
  workspaceComputer,
} from "./workspace-computer";
import { workspaceExportRoutes } from "./workspace-export-routes";

import {
  pausedWorkspace,
  type SuspensionOperator,
  suspensionRoutes,
} from "./workspace-suspension";

const attemptPrefix = "__Host-openbot-oidc-";
const callbackPath = "/auth/casdoor/callback";
const sessionSeal = "personal-saas-access-token";
const webBotRunsPath = "/workspace/bot-runs";
const botRunRefreshPath = "/assets/bot-run-refresh.js";
const webBotRunInput = botWorkInput.omit({ requiresComputer: true }).extend({
  requestId: z.uuid(),
  ...botRunCreditQuote.shape,
});
const webBotRunKey = z.union([z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)]);
const botRunSubmissionError = {
  authorization_changed: "Your workspace access changed. Sign in to try again.",
  bot_unavailable: "The Personal Assistant is unavailable.",
  insufficient_credits: "Not enough Test Credits to reserve this Bot run.",
  managed_computer_unavailable: "This Bot run can only process text.",
  test_credit_quote_changed:
    "Test Credit pricing changed. Review the current price in your workspace before starting a run.",
  test_credit_route_unavailable:
    "Managed Bot runs are temporarily unavailable.",
};
const botRunSubmissionInput = botWorkInput.extend({
  execution: z.literal("test-credit").optional(),
  quote: botRunCreditQuote.optional(),
});
type BotRunSubmission =
  | { runId: string }
  | {
      error: keyof typeof botRunSubmissionError;
      status: 402 | 403 | 404 | 409 | 422 | 503;
    };
type BotRunCreditAdmission =
  | Extract<BotRunSubmission, { error: string }>
  | { quote: z.infer<typeof botRunCreditQuote> };

const recoveryReason = {
  account_disabled: "The account was disabled.",
  account_status_unconfirmed: "Account status could not be confirmed.",
  workspace_paused: "The workspace was paused.",
  user_stopped: "You stopped this Bot run.",
  workspace_closed: "The workspace was closed.",
  worker_lost: "The worker lost its lease.",
  run_interrupted: "The run was interrupted.",
  computer_unavailable:
    "Start your Computer in your workspace before retrying this task.",
};

function reportFailure(
  stage: "sign-in" | "casdoor-discovery" | "workspace-setup" | "request",
) {
  console.warn(JSON.stringify({ type: "personal-saas-trial-failure", stage }));
}

export type PersonalSaasConfig = {
  origin: string;
  supportSubjects?: readonly string[];
  now?: () => number;
  runPersonalBot?: TurnRunner;
  botRuntime?: ReturnType<typeof createPersonalBotRuntime>;
  inboundRelayToken?: string;
  suspensionOperator?: SuspensionOperator;
  suspensionSupport?: string;
  computer?: WorkspaceComputerConfig;
  closureCleanup?: ClosureCleanup;
  admissionsPaused?: boolean;
  quotas?: Partial<WorkspaceQuotaLimits>;
  encryptionKey: string;
  casdoor: CasdoorConfig;
  testCredits?: {
    ledger: TestCreditLedger;
    execute?: TestCreditExecutor;
    weknora?: {
      serviceToken: string;
      routeId: string;
      execute: WeKnoraEmbeddingExecutor;
    };
    grant: OneTimeTestCreditGrantConfig;
  };
};

type AuthorizedSession = {
  subject: string;
  grant: AccountGrant;
};

function statusPage(
  title: string,
  message: string,
  href = "/",
  action = "Back to sign in",
) {
  return page(
    title,
    <>
      {" "}
      <Text as="p" role="status">
        {message}
      </Text>
      <Link href={href}>{action}</Link>{" "}
    </>,
  );
}

function admissionsPausedPage() {
  return statusPage(
    "Workspace opening temporarily paused",
    "Check back to try opening your Personal Workspace again.",
    "/workspace",
    "Retry",
  );
}

function preparePage(retry = false) {
  return page(
    retry
      ? "Couldn't prepare your Personal Workspace"
      : "Preparing your Personal Workspace",
    <>
      <Text as="p" role="status">
        {retry
          ? "Try again to open your workspace."
          : "We're setting up your Personal Assistant. This may take a moment."}
      </Text>
      <form id="prepare" method="post" action="/workspace/prepare">
        <Button type="submit" label={retry ? "Retry" : "Continue"} />
      </form>
      {retry ? "" : <script src="/assets/prepare.js" defer></script>}
    </>,
  );
}

export function createPersonalSaasApp(
  config: PersonalSaasConfig,
  database: Database,
) {
  const app = new Hono();
  const provider = casdoor(
    config.casdoor,
    new URL(callbackPath, config.origin).href,
  );
  const now = config.now ?? Date.now;
  const managedCredits = config.testCredits?.execute
    ? { ledger: config.testCredits.ledger, execute: config.testCredits.execute }
    : undefined;
  if (managedCredits && (config.botRuntime || config.runPersonalBot))
    throw new Error("Configure one Personal SaaS Bot runtime");
  const executeManaged =
    managedCredits &&
    personalTestCreditExecution(
      database,
      managedCredits.ledger,
      managedCredits.execute,
    );
  const runPersonalBot =
    config.botRuntime?.runTurn ??
    (config.runPersonalBot &&
      trackIntelligenceRuns(database, now, config.runPersonalBot));
  const store = personalSaasStore(database, now);
  async function testCreditStatus(session: AuthorizedSession) {
    if (!config.testCredits) return undefined;
    try {
      const identity = {
        issuer: config.casdoor.issuer,
        subject: session.subject,
      };
      const grant = await config.testCredits.ledger.ensureOneTimeGrant(
        identity,
        config.testCredits.grant,
      );
      const balance = await config.testCredits.ledger.balance(identity);
      const quote =
        managedCredits &&
        (await managedCredits.ledger.quote().catch(() => undefined));
      return {
        ...grant,
        ...(quote ? { quote } : {}),
        balance: balance ?? {
          creditType: "test" as const,
          grantedMicrocredits: "0",
          reservedMicrocredits: "0",
          chargedMicrocredits: "0",
          availableMicrocredits: "0",
        },
        usedUp:
          grant.state === "issued" &&
          (balance?.availableMicrocredits ?? "0") === "0",
      };
    } catch {
      console.warn(
        JSON.stringify({ type: "personal-saas-test-credit-failure" }),
      );
      return undefined;
    }
  }
  const approvals = createApprovalStore(database, now);
  async function approvalHistory(owner: string) {
    return (await approvals.list(owner)).map((request) => ({
      id: request.id,
      status: request.status,
      tool: request.action.toolRef,
      createdAt: request.createdAt,
      invalidated: request.action.executionInvalidated === true,
    }));
  }
  const accountAccess = createAccountAccess(
    database,
    provider.accountStatus,
    now,
  );
  const computer =
    config.computer &&
    workspaceComputer(config.computer, database, accountAccess, now);
  const quotaLimits = workspaceQuotaConfig.parse(config.quotas ?? {});
  const quotas = workspaceQuotas(quotaLimits);
  const botWork = personalBotWork(
    database,
    now,
    quotas,
    computer?.accessForTask,
  );
  const closure = workspaceClosureRoutes({
    database,
    accounts: accountAccess,
    encryptionKey: config.encryptionKey,
    now,
    computer,
    admissionsPaused: config.admissionsPaused ?? false,
  });
  const sweepCleanup = workspaceCleanup({
    database,
    now,
    reconcile: config.closureCleanup,
    stopped: computer?.stopped,
    eraseComputer: computer?.eraseStorage,
    eraseThread: config.botRuntime?.eraseThread,
  });
  const native = nativeAuth({
    database,
    encryptionKey: config.encryptionKey,
    now,
    suspensionSupport: config.suspensionSupport,
  });
  const browserLogin = browserAttempt.extend({
    native: native.attempt.optional(),
    closure: z.literal(true).optional(),
  });

  const automation = personalAutomation(database, now, quotas, runPersonalBot);
  const backgroundWorkers =
    runPersonalBot &&
    personalBackgroundWorkers(
      database,
      now,
      config.encryptionKey,
      runPersonalBot,
      quotas,
    );

  function bearer(context: Context) {
    return bearerSession(context.req.header("authorization"));
  }

  function requestSession(context: Context) {
    return context.req.header("authorization") === undefined
      ? getCookie(context, sessionCookie)
      : bearer(context);
  }

  function acceptsNativePost(context: Context) {
    if (
      /^\/api\/(?:support\/)?workspaces\/[^/]+\/(?:support-requests|tickets)\//.test(
        context.req.path,
      )
    )
      return Boolean(bearer(context));
    if (context.req.path.startsWith("/api/approvals/"))
      return Boolean(bearer(context));
    if (context.req.path.startsWith("/api/operator/workspaces/")) return true;
    if (context.req.path === inboundRelayPath) return true;
    if (context.req.path.startsWith(`${automationPath}/`))
      return Boolean(bearer(context));
    if (
      /^\/api\/workspaces\/[^/]+\/(?:exports|bots\/[^/]+\/integration-grants(?:\/[^/]+\/revoke)?)$/.test(
        context.req.path,
      )
    )
      return Boolean(bearer(context));
    if (
      context.req.path.startsWith("/api/workspace/recovery/") ||
      context.req.path.startsWith("/api/workspace/attachments") ||
      context.req.path === "/api/workspace/bot-runs" ||
      context.req.path.startsWith("/api/workspace/bot-runs/")
    )
      return Boolean(bearer(context));
    switch (context.req.path) {
      case "/api/auth/native/exchange":
        return true;
      case "/auth/sign-out":
      case "/workspace/prepare":
      case "/api/workspace/computer/start":
      case "/api/workspace/computer/stop":
        return Boolean(bearer(context));
      default:
        return false;
    }
  }

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'self'; ${pageStyleAttributePolicy}; script-src 'self'; connect-src 'self'; form-action 'self' ${config.casdoor.discoveryUrl.origin}; base-uri 'none'; frame-ancestors 'none'`,
    );
    context.header("Referrer-Policy", "same-origin");
    context.header("X-Content-Type-Options", "nosniff");
    const origin = context.req.header("origin");
    const isPost = context.req.method === "POST";
    if (
      context.req.path.startsWith("/api/approvals") &&
      !["GET", "HEAD"].includes(context.req.method) &&
      origin !== config.origin &&
      (origin !== undefined || !bearer(context))
    )
      return context.text("Invalid request origin", 403);

    if (
      origin !== undefined &&
      origin !== config.origin &&
      (isPost || context.req.header("authorization") !== undefined)
    )
      return context.text("Invalid request origin", 403);
    if (isPost && origin === undefined && !acceptsNativePost(context))
      return context.text("Invalid request origin", 403);
    await next();
  });

  app.onError((error, context) => {
    if (error instanceof WorkspaceQuotaExceeded) {
      if (
        context.req.header("accept")?.includes("text/html") &&
        !bearer(context)
      )
        return context.html(
          statusPage(
            "Workspace limit reached",
            error.message,
            "/workspace",
            "Back to workspace",
          ),
          429,
        );
      return context.json(error.body(), 429);
    }
    reportFailure("request");
    if (context.req.path.startsWith("/api/"))
      return context.json({ error: "workspace_unavailable" }, 503);
    return context.html(
      statusPage(
        "Workspace unavailable",
        "OpenBot couldn't reach the workspace. Please try again.",
        "/workspace",
        "Retry",
      ),
      503,
    );
  });

  app.route("/", suspensionRoutes(database, config.suspensionOperator, now));
  app.get("/health", (context) => context.json({ status: "ok" }));
  registerPageStyles(app);
  app.get(
    "/assets/prepare.js",
    () =>
      new Response(
        `requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('prepare')?.requestSubmit()));`,
        { headers: { "content-type": "text/javascript; charset=utf-8" } },
      ),
  );
  app.get(
    botRunRefreshPath,
    () =>
      new Response("setTimeout(() => window.location.reload(), 3000);", {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }),
  );

  app.get("/", (context) => {
    if (getCookie(context, sessionCookie))
      return context.redirect("/workspace");
    return context.html(
      page(
        "Open your Personal Workspace",
        <>
          {" "}
          <Text as="p">
            Sign in or create an account in Casdoor using your email address.
          </Text>
          <Button
            variant="primary"
            href="/auth/casdoor/start"
            label="Continue with Casdoor"
          />{" "}
        </>,
      ),
    );
  });

  app.route("/", native.routes);
  app.get("/auth/casdoor/start", (context) => startBrowser(context));
  app.get("/auth/closure/start", (context) =>
    startBrowser(context, undefined, true),
  );
  app.get("/auth/native/start", async (context) => {
    const request = native.attempt.safeParse(context.req.query());
    if (!request.success)
      return context.text("Invalid native sign-in request", 400);
    return startBrowser(context, request.data);
  });

  async function startBrowser(
    context: Context,
    nativeAttempt?: NativeAttempt,
    closureRequested?: true,
  ) {
    try {
      const { authorization, state, attempt } = await provider.start();
      setCookie(
        context,
        `${attemptPrefix}${state}`,
        await seal(
          JSON.stringify({
            ...attempt,
            native: nativeAttempt,
            closure: closureRequested,
          }),
          config.encryptionKey,
          state,
        ),
        { ...cookieOptions, maxAge: 600 },
      );
      return context.redirect(authorization.href);
    } catch {
      reportFailure("casdoor-discovery");
      if (nativeAttempt)
        return context.redirect(
          native.fail(nativeAttempt, "sign_in_incomplete"),
        );
      return context.html(
        statusPage(
          "Sign-in unavailable",
          "OpenBot couldn't reach Casdoor. Please try again.",
        ),
        503,
      );
    }
  }

  app.get(callbackPath, async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const issuer = context.req.query("iss");
    const retry = statusPage(
      "Sign-in incomplete",
      "Start sign-in again to enter your Personal Workspace.",
    );
    if (!state || !/^[\w-]{32}$/.test(state)) return context.html(retry, 400);
    const cookieName = `${attemptPrefix}${state}`;
    const encrypted = getCookie(context, cookieName);
    deleteCookie(context, cookieName, cookieOptions);
    const attempt = await unseal(encrypted, config.encryptionKey, state);
    if (!attempt) return context.html(retry, 400);
    const result = browserLogin.safeParse(JSON.parse(attempt));
    if (!result.success) return context.html(retry, 400);
    const parsed = result.data;
    const nativeAttempt = parsed.native;
    if (nativeAttempt) context.header("Referrer-Policy", "no-referrer");
    if (
      !code ||
      context.req.query("error") !== undefined ||
      parsed.expiresAt <= Date.now() ||
      (issuer !== undefined && issuer !== config.casdoor.issuer)
    ) {
      if (nativeAttempt)
        return context.redirect(
          native.fail(nativeAttempt, "sign_in_incomplete"),
        );
      return context.html(retry, 400);
    }

    try {
      const identity = await provider.authenticate(code, parsed);
      if (identity.kind === "unverified") {
        if (nativeAttempt)
          return context.redirect(
            native.fail(nativeAttempt, "email_unverified"),
          );
        return context.html(
          statusPage(
            "Verify your email",
            "Complete email verification in Casdoor, then sign in again.",
          ),
          403,
        );
      }
      if (identity.kind === "inactive") {
        if (nativeAttempt)
          return context.redirect(
            native.fail(nativeAttempt, "account_unavailable"),
          );
        return context.html(
          statusPage(
            "Account unavailable",
            "Casdoor hasn't confirmed that your account is active.",
          ),
          403,
        );
      }
      const accountId = await store.bindIdentity(identity);
      if (!(await accountAccess.check(identity)))
        throw new Error("Account status unavailable");
      const suspension = nativeAttempt
        ? undefined
        : await pausedWorkspace(database, accountId, config.suspensionSupport);
      const closedWorkspace =
        !nativeAttempt && (await workspaceClosure(database, accountId));
      if (closedWorkspace) {
        deleteCookie(context, sessionCookie, cookieOptions);
        await closure.issueStatusCookie(context, accountId, closedWorkspace.id);
        return context.redirect("/workspace/closure/progress", 303);
      }
      if (suspension) {
        await closure.issueStatusCookie(context, accountId);
        deleteCookie(context, sessionCookie, cookieOptions);
        return context.html(
          page(
            "Personal Workspace paused",
            <>
              {" "}
              <Text as="p" role="status">
                Your access to this OpenBot workspace is paused.
              </Text>
              {suspension.reason ? <Text as="p">{suspension.reason}</Text> : ""}
              <Text as="p">
                Operation ID <code>{suspension.operationId}</code>
              </Text>
              {suspension.supportEmail ? (
                <Text as="p">
                  Contact support at{" "}
                  <Link href={`mailto:${suspension.supportEmail}`}>
                    {suspension.supportEmail}
                  </Link>
                  .
                </Text>
              ) : (
                ""
              )}
              <Text as="p">
                <Link href="/workspace/closure">Close my workspace</Link>
              </Text>
              <Link href="/auth/casdoor/start">Sign in again</Link>{" "}
            </>,
          ),
          403,
        );
      }
      const sessionIdentity = {
        accountId,
        loginStartedAt: parsed.expiresAt - 10 * 60_000,
        encryptedAccessToken: await seal(
          identity.accessToken,
          config.encryptionKey,
          sessionSeal,
        ),
      };
      if (nativeAttempt)
        return context.redirect(
          await native.complete(nativeAttempt, sessionIdentity),
        );
      const token = await store.signIn(sessionIdentity);
      if (!token) throw new Error("Account admission changed");
      closure.clearCookies(context);
      setCookie(context, sessionCookie, token, {
        ...cookieOptions,
        maxAge: sessionSeconds,
      });
      return context.redirect(
        parsed.closure ? "/workspace/closure" : "/workspace",
        303,
      );
    } catch {
      reportFailure("sign-in");
      if (nativeAttempt)
        return context.redirect(
          native.fail(nativeAttempt, "sign_in_incomplete"),
        );
      return context.html(
        statusPage(
          "Sign-in unavailable",
          "OpenBot couldn't confirm your account with Casdoor. Please try again.",
        ),
        503,
      );
    }
  });

  async function authorize(token: string | undefined, refresh = true) {
    if (!token || !/^[\w-]{43}$/.test(token))
      return { kind: "signed-out" } as const;
    const session = await store.session(token);
    if (!session || session.issuer !== config.casdoor.issuer)
      return { kind: "signed-out" } as const;
    if (refresh) await accountAccess.check(session);
    const current = refresh ? await store.session(token) : session;
    if (!current) return { kind: "signed-out" } as const;
    const decision = accountDecision(current.status, now());
    if (decision.kind === "denied")
      return {
        kind: "unconfirmed",
        reason: decision.reason,
        cutoffAt: decision.cutoffAt,
      } as const;
    return {
      kind: "authorized",
      subject: current.subject,
      grant: {
        accountId: current.accountId,
        epoch: decision.epoch,
        expiresAt: Math.min(decision.expiresAt, current.expiresAt.getTime()),
      },
    } as const;
  }

  async function remainingAccess(
    token: string | undefined,
    grant: AccountGrant,
  ) {
    const current = await authorize(token, false);
    if (current.kind !== "authorized" || current.grant.epoch !== grant.epoch)
      return 0;
    return Math.max(
      0,
      Math.floor(Math.min(current.grant.expiresAt, grant.expiresAt) - now()),
    );
  }

  async function stillAuthorized(
    token: string | undefined,
    grant: AccountGrant,
  ) {
    return (await remainingAccess(token, grant)) > 0;
  }

  function workspaceViewBinding(token: string, { epoch }: AccountGrant) {
    return createHmac("sha256", config.encryptionKey)
      .update(`personal-saas-workspace-view:${token}:${epoch}`)
      .digest("base64url");
  }

  async function refreshSession(token: string) {
    const session = await store.session(token);
    if (session?.issuer === config.casdoor.issuer)
      await accountAccess.check(session);
  }

  app.route(
    "/",
    sessionRevocationRoutes({
      ...config,
      store,
      closure,
      failurePage: async (status) =>
        new Response(
          await statusPage(
            "Identity verification incomplete",
            "OpenBot couldn't verify your identity. Return to your workspace to try again.",
            "/workspace",
            "Back to workspace",
          ),
          { status, headers: { "content-type": "text/html; charset=UTF-8" } },
        ),
    }),
  );
  app.route("/", closure.routes);
  app.route(
    "/api",
    integrationGrantRoutes({ database, now, store, requestSession, authorize }),
  );
  if (config.testCredits)
    app.route(
      "/api/weknora/ingestion-grants",
      weknoraGrantRoutes({
        issuer: config.casdoor.issuer,
        store,
        requestSession: (context) => getCookie(context, sessionCookie),
        authorize,
        now,
      }),
    );
  if (config.testCredits?.weknora)
    app.route(
      "/api/weknora/embeddings",
      weknoraEmbeddingRoutes({
        ...config.testCredits.weknora,
        issuer: config.casdoor.issuer,
        ledger: config.testCredits.ledger,
      }),
    );
  app.route(
    "/",
    sessionEventRoutes({
      cookieName: sessionCookie,
      authorize,
      refreshSession,
      now,
    }),
  );
  app.route(
    "/api/workspaces",
    workspaceBotRoutes(
      database,
      (context) => authorize(getCookie(context, sessionCookie)),
      (context, grant) =>
        stillAuthorized(getCookie(context, sessionCookie), grant),
      async (context, grant, input) => {
        const token = getCookie(context, sessionCookie);
        if (!token) return { authorized: false };
        return store.withAuthorizedSession(grant, token, (tx) =>
          workspaceBots(tx).rename(input),
        );
      },
    ),
  );

  app.on(
    ["GET", "POST"],
    [
      "/api/workspace/computer",
      "/api/workspace/computer/start",
      "/api/workspace/computer/stop",
    ],
    async (context) => {
      const operation = context.req.path.split("/").at(-1);
      const change = operation === "start" || operation === "stop";
      if (change !== (context.req.method === "POST")) return context.notFound();
      const token = requestSession(context);
      const session = await authorize(token);
      if (session.kind === "signed-out")
        return context.json({ error: "sign_in_required" }, 401);
      if (
        session.kind !== "authorized" ||
        (await accountAccess.verify(session.grant)).kind !== "active"
      ) {
        return context.json({ error: "workspace_access_denied" }, 403);
      }
      if (!computer)
        return context.json({ error: "computer_unavailable" }, 503);
      const workspace = await store.workspace(session.grant.accountId);
      if (!workspace)
        return context.json({ error: "workspace_preparing" }, 409);
      if (change) {
        if (!(await stillAuthorized(token, session.grant)))
          return context.json({ error: "authorization_changed" }, 403);
        if (operation === "start") {
          const current = await computer.status(workspace.id);
          quotas.check("computer", computerQuotaUsed(current.status));
          if (quotaLimits.computerStorage === 0)
            return context.json({ error: "computer_storage_unavailable" }, 503);
          await database.transaction((tx) =>
            quotas.admitStorage(tx, session.grant.accountId, workspace.id, 0),
          );
          if (
            !(await computer.start(
              workspace.id,
              session.grant,
              quotaLimits.computerStorage,
            ))
          ) {
            const latest = await computer.status(workspace.id);
            quotas.check("computer", computerQuotaUsed(latest.status));
            return context.json({ error: "computer_start_not_accepted" }, 409);
          }
        } else if (!(await computer.stop(workspace.id, session.grant))) {
          return context.json({ error: "computer_stop_not_accepted" }, 409);
        }
        if (context.req.header("accept")?.includes("text/html"))
          return context.redirect("/workspace", 303);
        return context.body(null, 202);
      }
      const status = await computer.status(workspace.id);
      if (
        !(await stillAuthorized(token, session.grant)) ||
        (await accountAccess.verify(session.grant)).kind !== "active"
      )
        return context.json({ error: "authorization_changed" }, 403);
      return context.json(status);
    },
  );

  app.route(
    "/",
    workspaceExportRoutes({
      database,
      encryptionKey: config.encryptionKey,
      now,
      authorize: (context) => authorize(requestSession(context)),
      stillAuthorized: async (context, grant) =>
        (await accountAccess.verify(grant)).kind === "active" &&
        stillAuthorized(requestSession(context), grant),
    }),
  );

  app.route(
    "/",
    supportRoutes({
      database,
      async authorize(context) {
        const token = requestSession(context);
        if (!token) return { kind: "signed-out" };
        const session = await authorize(token);
        if (session.kind !== "authorized") return session;
        const { grant, subject } = session;
        return {
          kind: "authorized",
          accountId: grant.accountId,
          subject,
          isLive: () => stillAuthorized(token, grant),
          remainingMs: () => Math.max(0, grant.expiresAt - now()),
          async run(operation) {
            const outcome = await store.withAuthorizedSession(
              grant,
              token,
              (tx) => operation(supportAccess(tx)),
            );
            return outcome.authorized ? outcome.result : undefined;
          },
        };
      },
      subjects: config.supportSubjects ?? [],
    }),
  );

  async function unattendedHistory(accountId: string) {
    const queue = createWorkQueue(database, now);
    const history = await Promise.all(
      Object.entries(unattendedWorkLabels).map(async ([kind, label]) => {
        await queue.reconcilePersonalWork(kind, accountId);
        return (await queue.interrupted(kind, accountId)).flatMap((item) => {
          if (!item.interruption) return [];
          const summary =
            item.payload.reason ?? item.payload.task ?? item.payload.text;
          return [
            {
              key: item.key,
              kind,
              label,
              summary:
                typeof summary === "string" ? summary.slice(0, 500) : undefined,
              output: item.output,
              ...item.interruption,
              recovery: item.recovery,
              recoveryCanRetry:
                Boolean(backgroundWorkers) &&
                kind !== "delivery.outbound" &&
                !(kind === "bot.message" && item.payload.answerIn),
              reasonMessage: recoveryReason[item.interruption.reason],
            },
          ];
        });
      }),
    );
    return history.flat().sort((a, b) => b.recordedAt - a.recordedAt);
  }

  app.get("/workspace", async (context) => {
    const token = getCookie(context, sessionCookie);
    const session = await authorize(token);
    if (session.kind === "unconfirmed")
      return context.html(
        statusPage(
          "Workspace unavailable",
          "OpenBot couldn't confirm your account status. Please try again.",
          "/workspace",
          "Retry",
        ),
        503,
      );
    if (session.kind === "signed-out" || !token) {
      deleteCookie(context, sessionCookie, cookieOptions);
      return context.redirect("/");
    }
    const workspace = await store.workspace(session.grant.accountId);
    const conversations = workspace
      ? await store.recentConversations(session.grant.accountId)
      : [];
    if (!(await remainingAccess(token, session.grant)))
      return context.redirect("/workspace");
    if (!workspace)
      return config.admissionsPaused
        ? context.html(admissionsPausedPage(), 503)
        : context.html(preparePage());
    const computerStatus = await computer
      ?.status(workspace.id)
      .catch(() => undefined);
    const [recovery, unattended, history] = await Promise.all([
      botWork.history(session.grant.accountId),
      unattendedHistory(session.grant.accountId),
      approvalHistory(session.grant.accountId),
    ]);
    const drafts = await workspaceAttachmentDrafts(database, workspace.id);
    const usage = await workspaceQuotaUsage(
      session.grant.accountId,
      workspace.id,
      computerStatus,
    );
    const testCredits = await testCreditStatus(session);
    const stoppedBotWork = recovery.map((item) => {
      const quote = item.managed ? testCredits?.quote : undefined;
      return {
        item,
        quote,
        canRetry: item.managed ? Boolean(quote) : Boolean(runPersonalBot),
      };
    });
    if (!(await remainingAccess(token, session.grant)))
      return context.redirect("/workspace");
    return context.html(
      page(
        "Personal Workspace",
        <>
          {" "}
          <Text as="p" id="workspace-access" role="status">
            Checking your workspace…
          </Text>
          <aside id="workspace-retry" hidden>
            <Link href="/workspace">Retry</Link>
          </aside>
          <noscript>Enable JavaScript to verify workspace access.</noscript>
          <section id="protected-workspace" hidden>
            <VStack gap={6}>
              <section aria-labelledby="workspace-usage">
                <Heading level={2} id="workspace-usage">
                  Workspace usage
                </Heading>
                <List edge="flush" hasDividers>
                  <ListItem
                    label={
                      <VStack gap={2}>
                        Bot runs: {usage.bot.used} / {usage.bot.limit}
                      </VStack>
                    }
                  />
                  <ListItem
                    label={
                      <VStack gap={2}>
                        Computers: {usage.computer.used ?? "Unavailable"} /{" "}
                        {usage.computer.limit}
                      </VStack>
                    }
                  />
                  <ListItem
                    label={
                      <VStack gap={2}>
                        Workspace storage: {usage.storage.used ?? "Unavailable"}{" "}
                        / {usage.storage.limit} bytes
                      </VStack>
                    }
                  />
                  {usage.storage.attachmentUsed !== undefined && (
                    <ListItem
                      label={
                        <VStack gap={2}>
                          Attachments: {usage.storage.attachmentUsed} bytes ·
                          Computer files:{" "}
                          {usage.storage.computerUsed === null
                            ? "Unavailable"
                            : `${usage.storage.computerUsed} bytes`}{" "}
                          · Computer reservation:{" "}
                          {usage.storage.computerReserved} bytes
                        </VStack>
                      }
                    />
                  )}
                  <ListItem
                    label={
                      <VStack gap={2}>
                        Automation triggers: {usage.automation.used} /{" "}
                        {usage.automation.limit} per minute
                      </VStack>
                    }
                  />
                </List>
                {drafts.length ? (
                  <>
                    {" "}
                    <Heading level={3}>Draft attachments</Heading>
                    <List edge="flush" hasDividers>
                      {drafts.map((draft) => (
                        <ListItem
                          key={draft.id}
                          label={
                            <VStack gap={2}>
                              {draft.name} ({draft.sizeBytes} bytes)
                              <form
                                action={
                                  "/api/workspace/attachments/" +
                                  draft.id +
                                  "/withdraw"
                                }
                                method="post"
                              >
                                <Button
                                  type="submit"
                                  label={`Withdraw ${draft.name}`}
                                />
                              </form>
                            </VStack>
                          }
                        />
                      ))}
                    </List>{" "}
                  </>
                ) : (
                  ""
                )}
              </section>
              <Text as="p">
                <Link href={automationPath}>Routines and inbound bindings</Link>
              </Text>
              <section aria-labelledby="assistant">
                <Heading level={2} id="assistant">
                  {workspace.personalAssistant.name}
                </Heading>
              </section>
              <section aria-labelledby="conversations">
                <Heading level={2} id="conversations">
                  Recent conversations
                </Heading>
                {conversations.length === 0 ? (
                  <Text as="p">No conversations yet.</Text>
                ) : (
                  <List edge="flush" hasDividers>
                    {conversations.map(({ id, title, preview }) => (
                      <ListItem
                        key={id}
                        label={
                          <VStack gap={2}>
                            <strong>{title}</strong>
                            {preview ? <Text as="p">{preview}</Text> : ""}
                          </VStack>
                        }
                      />
                    ))}
                  </List>
                )}
              </section>
              {testCredits ? (
                <section aria-labelledby="test-credits">
                  <Heading level={2} id="test-credits">
                    Test Credits
                  </Heading>
                  <Text as="p">
                    {testCredits.state === "issued"
                      ? `Granted ${testCredits.amountMicrocredits} microcredits. Available ${testCredits.balance.availableMicrocredits}.`
                      : "Your Test Credits are pending while the trial budget is restored."}
                  </Text>
                  {testCredits.usedUp ? (
                    <Text as="p">Your Test Credits are used up.</Text>
                  ) : (
                    ""
                  )}
                  {testCredits.quote ? (
                    <>
                      <Text as="p">
                        {testCredits.quote.model} costs{" "}
                        {testCredits.quote.price.inputPerMillion} microcredits
                        per million input tokens and{" "}
                        {testCredits.quote.price.outputPerMillion} microcredits
                        per million output tokens.
                      </Text>
                      <Text as="p">
                        Maximum reservation per run:{" "}
                        {testCredits.quote.maxChargeMicrocredits} microcredits.{" "}
                        {testCredits.quote.usageDisclosure}
                      </Text>
                      {testCredits.state === "issued" &&
                      BigInt(testCredits.balance.availableMicrocredits) >=
                        BigInt(testCredits.quote.maxChargeMicrocredits) ? (
                        <form action={webBotRunsPath} method="post">
                          <input
                            type="hidden"
                            name="workspaceId"
                            value={workspace.id}
                          />
                          <input
                            type="hidden"
                            name="botId"
                            value={workspace.personalAssistant.id}
                          />
                          <input
                            type="hidden"
                            name="requestId"
                            value={crypto.randomUUID()}
                          />
                          <input
                            type="hidden"
                            name="route"
                            value={testCredits.quote.route}
                          />
                          <input
                            type="hidden"
                            name="priceVersion"
                            value={testCredits.quote.priceVersion}
                          />
                          <VStack gap={3}>
                            <TextArea
                              label="Message to Personal Assistant"
                              htmlName="instruction"
                              value=""
                              isRequired
                              htmlMaxLength={20_000}
                            />
                            <Button
                              variant="primary"
                              type="submit"
                              label="Send to Personal Assistant"
                            />
                          </VStack>
                        </form>
                      ) : testCredits.state === "issued" &&
                        !testCredits.usedUp ? (
                        <Text as="p">
                          Not enough Test Credits to reserve another Bot run.
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    managedCredits && (
                      <Text as="p">
                        Managed Bot runs are temporarily unavailable.
                      </Text>
                    )
                  )}
                </section>
              ) : (
                ""
              )}
              {computerStatus ? (
                <section aria-labelledby="computer">
                  <Heading level={2} id="computer">
                    Computer
                  </Heading>
                  <Text as="p">
                    {
                      {
                        not_started: "Ready to set up",
                        starting:
                          "Starting. Refresh this page to check progress.",
                        running: "Running",
                        stopping:
                          "Stopping. Refresh this page to check progress.",
                        restart_required:
                          "Stopped. Your saved files and settings are kept.",
                      }[computerStatus.status]
                    }
                  </Text>
                  {computerStatus.cutoff === "failed" ? (
                    <Text as="p">
                      Computer exit could not be confirmed by the authorization
                      deadline.
                    </Text>
                  ) : (
                    ""
                  )}
                  {["not_started", "restart_required"].includes(
                    computerStatus.status,
                  ) ? (
                    <form method="post" action="/api/workspace/computer/start">
                      <Button type="submit" label="Start Computer" />
                    </form>
                  ) : (
                    <form method="post" action="/api/workspace/computer/stop">
                      <Button type="submit" label="Stop Computer" />
                    </form>
                  )}
                </section>
              ) : (
                ""
              )}
              <form
                method="post"
                action={`/api/workspaces/${workspace.id}/exports`}
              >
                <Button type="submit" label="Download workspace data" />
              </form>
              {history.length ? (
                <section aria-labelledby="approval-history">
                  <Heading level={2} id="approval-history">
                    Approval history
                  </Heading>
                  <List edge="flush" hasDividers>
                    {history.map((item) => (
                      <ListItem
                        key={item.id}
                        label={
                          <VStack gap={2}>
                            {item.tool} ·{" "}
                            {item.invalidated ? "Invalidated" : item.status}
                          </VStack>
                        }
                      />
                    ))}
                  </List>
                </section>
              ) : (
                ""
              )}
              <Text as="p">
                <Link
                  href={`/api/workspaces/${workspace.id}/support-requests/view`}
                >
                  Support access
                </Link>
              </Text>
              <Text as="p">
                <Link href="/workspace/closure">Close my workspace</Link>
              </Text>
              <form method="post" action="/auth/sign-out">
                <Button type="submit" label="Sign out" />
              </form>
              <form method="post" action="/auth/sign-out-all">
                <Text as="p">
                  Verify your identity with Casdoor to require every device to
                  sign in again.
                </Text>
                <Button type="submit" label="Sign out all devices" />
              </form>
              {recovery.length ? (
                <section aria-labelledby="work-recovery">
                  <Heading level={2} id="work-recovery">
                    Stopped work
                  </Heading>
                  <List edge="flush" hasDividers>
                    {stoppedBotWork.map(({ item, quote, canRetry }) => (
                      <ListItem
                        key={item.key}
                        label={
                          <VStack gap={2}>
                            <Text as="p">{item.instruction}</Text>
                            <Text as="p">{recoveryReason[item.reason]}</Text>
                            {item.output ? (
                              <>
                                {" "}
                                <Text as="p">Output before interruption</Text>
                                <pre>{item.output}</pre>{" "}
                              </>
                            ) : (
                              ""
                            )}
                            {item.outcomeUnknown ? (
                              <Text as="p">
                                Check any external actions before retrying.
                                Their outcome is unknown.
                              </Text>
                            ) : (
                              ""
                            )}
                            {item.recovery ? (
                              <Text as="p">
                                {item.recovery.action === "retry"
                                  ? "Queued as a new run"
                                  : "Cancelled"}
                              </Text>
                            ) : (
                              <form
                                method="post"
                                action={
                                  "/api/workspace/recovery/" +
                                  encodeURIComponent(item.key)
                                }
                              >
                                {quote ? (
                                  <>
                                    <Text as="p">
                                      {quote.model} costs{" "}
                                      {quote.price.inputPerMillion} microcredits
                                      per million input tokens and{" "}
                                      {quote.price.outputPerMillion}{" "}
                                      microcredits per million output tokens.{" "}
                                      Maximum reservation for the new run:{" "}
                                      {quote.maxChargeMicrocredits}{" "}
                                      microcredits. {quote.usageDisclosure}
                                    </Text>
                                    <input
                                      type="hidden"
                                      name="route"
                                      value={quote.route}
                                    />
                                    <input
                                      type="hidden"
                                      name="priceVersion"
                                      value={quote.priceVersion}
                                    />
                                  </>
                                ) : null}
                                {canRetry && item.outcomeUnknown ? (
                                  <label>
                                    <input
                                      type="checkbox"
                                      name="acknowledged"
                                      value="true"
                                    />{" "}
                                    I checked the external actions.
                                  </label>
                                ) : (
                                  ""
                                )}
                                {canRetry ? (
                                  <Button
                                    type="submit"
                                    name="action"
                                    value="retry"
                                    label={
                                      quote
                                        ? item.outcomeUnknown
                                          ? "Retry with Test Credits"
                                          : "Requeue with Test Credits"
                                        : item.outcomeUnknown
                                          ? "Retry as a new run"
                                          : "Requeue"
                                    }
                                  />
                                ) : (
                                  ""
                                )}
                                <Button
                                  type="submit"
                                  name="action"
                                  value="cancel"
                                  label="Cancel item"
                                />
                              </form>
                            )}
                          </VStack>
                        }
                      />
                    ))}
                  </List>
                </section>
              ) : (
                ""
              )}
              {unattended.length ? (
                <section aria-labelledby="unattended-work">
                  <Heading level={2} id="unattended-work">
                    Stopped background work
                  </Heading>
                  <List edge="flush" hasDividers>
                    {unattended.map((item) => (
                      <ListItem
                        key={item.key}
                        label={
                          <VStack gap={2}>
                            <Text as="p">
                              <strong>{item.label}</strong>
                            </Text>
                            {item.summary ? (
                              <Text as="p">{item.summary}</Text>
                            ) : (
                              ""
                            )}
                            <Text as="p">{item.reasonMessage}</Text>
                            {item.output ? (
                              <>
                                {" "}
                                <Text as="p">Output before interruption</Text>
                                <pre>{item.output}</pre>{" "}
                              </>
                            ) : (
                              ""
                            )}
                            {item.outcomeUnknown ? (
                              <Text as="p">
                                Check any external actions before starting new
                                work. Their outcome is unknown.
                              </Text>
                            ) : (
                              ""
                            )}
                            {item.recovery ? (
                              <Text as="p">
                                {item.recovery.action === "retry"
                                  ? "Started as fresh work"
                                  : "Cancelled"}
                              </Text>
                            ) : (
                              <form
                                method="post"
                                action={
                                  "/api/workspace/recovery/" +
                                  encodeURIComponent(item.key)
                                }
                              >
                                {item.recoveryCanRetry &&
                                item.outcomeUnknown ? (
                                  <label>
                                    <input
                                      type="checkbox"
                                      name="acknowledged"
                                      value="true"
                                    />{" "}
                                    I checked the external actions.
                                  </label>
                                ) : (
                                  ""
                                )}
                                {item.recoveryCanRetry ? (
                                  <Button
                                    type="submit"
                                    name="action"
                                    value="retry"
                                    label="Start fresh work"
                                  />
                                ) : (
                                  ""
                                )}
                                <Button
                                  type="submit"
                                  name="action"
                                  value="cancel"
                                  label="Cancel item"
                                />
                              </form>
                            )}
                          </VStack>
                        }
                      />
                    ))}
                  </List>
                </section>
              ) : (
                ""
              )}
            </VStack>
          </section>
          <script
            src="/assets/session.js"
            data-workspace-view={workspaceViewBinding(token, session.grant)}
            defer
          ></script>{" "}
        </>,
      ),
    );
  });

  app.post("/workspace/prepare", async (context) => {
    const token = requestSession(context);
    const isNative = context.req.header("authorization") !== undefined;
    const session = await authorize(token);
    if (isNative) {
      if (session.kind === "unconfirmed")
        return context.json({ error: "account_status_unconfirmed" }, 503);
      if (session.kind === "signed-out")
        return context.json({ error: "sign_in_required" }, 401);
    }
    if (session.kind === "unconfirmed")
      return context.html(preparePage(true), 503);
    if (session.kind === "signed-out" || !token)
      return context.redirect("/workspace", 303);
    try {
      const result = await store.provision(
        session.grant,
        token,
        config.admissionsPaused ?? false,
      );
      if (result === "paused")
        return isNative
          ? context.json({ error: "workspace_admissions_paused" }, 503)
          : context.html(admissionsPausedPage(), 503);
      if (result !== "prepared")
        return isNative
          ? context.json({ error: "authorization_changed" }, 403)
          : context.redirect("/workspace", 303);
      await testCreditStatus(session);
      if (isNative) return context.body(null, 204);
      return context.redirect("/workspace", 303);
    } catch {
      reportFailure("workspace-setup");
      if (isNative)
        return context.json({ error: "workspace_unavailable" }, 503);
      return context.html(preparePage(true), 503);
    }
  });

  app.get("/api/auth/session/access", async (context) => {
    const token = getCookie(context, sessionCookie);
    const session = await authorize(token);
    if (session.kind === "signed-out" || !token)
      return context.json({ error: "sign_in_required" }, 401);
    if (session.kind === "unconfirmed")
      return context.json({ error: session.reason }, 503);
    if (
      context.req.header("OpenBot-Workspace-View") !==
      workspaceViewBinding(token, session.grant)
    )
      return context.json({ error: "authorization_changed" }, 403);
    const accessMs = await remainingAccess(token, session.grant);
    if (!accessMs) return context.json({ error: "authorization_changed" }, 403);
    context.header("OpenBot-Access-Ms", String(accessMs));
    return context.body(null, 204);
  });

  function computerQuotaUsed(
    status: Awaited<
      ReturnType<NonNullable<typeof computer>["status"]>
    >["status"],
  ) {
    return Number(["starting", "running", "stopping"].includes(status));
  }

  async function workspaceQuotaUsage(
    accountId: string,
    workspaceId: string,
    status:
      | Awaited<ReturnType<NonNullable<typeof computer>["status"]>>
      | undefined,
  ) {
    const used = !computer
      ? 0
      : status
        ? computerQuotaUsed(status.status)
        : null;
    const computerStorageUsed =
      quotaLimits.computerStorage > 0
        ? await computer
            ?.storageUsage(workspaceId, quotaLimits.computerStorage)
            .catch(() => null)
        : null;
    return database.transaction((tx) =>
      quotas.usage(
        tx,
        accountId,
        workspaceId,
        used,
        computerStorageUsed ?? null,
      ),
    );
  }

  app.get("/api/workspace", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind === "unconfirmed")
      return context.json(
        { error: session.reason, cutoffAt: session.cutoffAt },
        503,
      );
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    const workspace = await store.workspace(session.grant.accountId);
    const [recovery, unattended] = workspace
      ? await Promise.all([
          botWork.history(session.grant.accountId),
          unattendedHistory(session.grant.accountId),
        ])
      : [[], []];
    const native = workspace && bearer(context);
    const [computerStatus, nativeAutomation, invalidatedApprovals] = workspace
      ? await Promise.all([
          computer?.status(workspace.id).catch(() => undefined),
          native
            ? store.withAuthorizedSession(session.grant, native, (tx) =>
                automation.list(tx, session.grant.accountId),
              )
            : undefined,
          native
            ? approvalHistory(session.grant.accountId).then((requests) =>
                requests.filter((request) => request.invalidated),
              )
            : undefined,
        ])
      : [];
    const automationOverview = nativeAutomation?.authorized
      ? nativeAutomation.result
      : undefined;
    const quotaUsage = workspace
      ? await workspaceQuotaUsage(
          session.grant.accountId,
          workspace.id,
          computerStatus,
        )
      : undefined;
    const testCredits = workspace ? await testCreditStatus(session) : undefined;
    const accessMs = await remainingAccess(token, session.grant);
    if (!accessMs) return context.json({ error: "authorization_changed" }, 403);
    if (workspace) context.header("OpenBot-Access-Ms", String(accessMs));
    return workspace
      ? context.json({
          ...workspace,
          ...(testCredits ? { testCredits } : {}),
          quotas: quotaUsage,
          ...(native && computer ? { computer: computerStatus ?? null } : {}),
          ...(automationOverview &&
          (automationOverview.routines.length ||
            automationOverview.bindings.length)
            ? { automation: automationOverview }
            : {}),
          ...(invalidatedApprovals?.length ? { invalidatedApprovals } : {}),
          ...(unattended.length
            ? { interruptedBackgroundWork: unattended }
            : {}),
          ...(recovery.length || unattended.length
            ? {
                recovery: recovery.map((item) => ({
                  ...item,
                  reasonMessage: recoveryReason[item.reason],
                })),
                recoveryCanRetry: Boolean(runPersonalBot),
              }
            : {}),
        })
      : config.admissionsPaused
        ? context.json({ error: "workspace_admissions_paused" }, 503)
        : context.json({ status: "preparing" }, 202);
  });

  if (config.botRuntime) {
    app.route(
      "/api/approvals",
      createApprovalRoutes(
        config.botRuntime.approvals,
        async (context, next) => {
          const token = requestSession(context);
          const session = await authorize(token);
          if (session.kind !== "authorized" || !token)
            return context.json({ error: "authorization_required" }, 403);
          const { accountId } = session.grant;
          const admitted = await store.withAuthorizedSession(
            session.grant,
            token,
            (tx) => ensureDecisionActor(tx, accountId),
          );
          if (!admitted.authorized)
            return context.json({ error: "authorization_changed" }, 403);
          context.set("actor", { id: accountId, email: "", role: "user" });
          await next();
        },
      ),
    );
  }

  app.get("/api/workspace/approvals", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind !== "authorized")
      return context.json({ error: "authorization_required" }, 403);
    const history = await approvalHistory(session.grant.accountId);
    if (!(await stillAuthorized(token, session.grant)))
      return context.json({ error: "authorization_changed" }, 403);
    return context.json({ requests: history });
  });
  const automationSession = async (context: Context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    return token && session.kind === "authorized"
      ? { token, grant: session.grant }
      : null;
  };
  app.route(
    "/api/workspace/attachments",
    workspaceAttachmentRoutes({
      quotas,
      getSession: automationSession,
      withAuthorizedSession: store.withAuthorizedSession,
    }),
  );

  app.route(
    automationPath,
    workspaceAutomationRoutes({
      automation,
      executionEnabled: Boolean(runPersonalBot),
      getSession: automationSession,
      stillAuthorized,
      withAuthorizedSession: store.withAuthorizedSession,
    }),
  );
  if (config.inboundRelayToken)
    app.route(
      inboundRelayPath,
      inboundRelay(automation, config.inboundRelayToken, now),
    );

  app.post("/api/workspace/bot-runs", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind !== "authorized" || !token)
      return context.json({ error: "authorization_required" }, 403);
    if (!runPersonalBot && !executeManaged)
      return context.json({ error: "bot_execution_unavailable" }, 503);
    const input = botRunSubmissionInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!input.success) return context.json({ error: "invalid_request" }, 400);
    const { execution, quote, ...work } = input.data;
    if ((execution === "test-credit" || quote) && !managedCredits)
      return context.json({ error: "bot_execution_unavailable" }, 503);
    const retryKey = managedCredits
      ? context.req.header("Idempotency-Key")
      : undefined;
    const requestId = z.uuid().optional().safeParse(retryKey);
    if (!requestId.success)
      return context.json({ error: "invalid_idempotency_key" }, 400);
    const result = await submitBotRun({
      token,
      session,
      input: work,
      requestId: requestId.data,
      disclosedQuote: quote,
    });
    return "runId" in result
      ? context.json({ runId: result.runId }, 202)
      : context.json({ error: result.error }, result.status);
  });

  async function managedBotAdmission(
    session: AuthorizedSession,
    disclosedQuote?: z.infer<typeof botRunCreditQuote>,
  ): Promise<BotRunCreditAdmission> {
    if (!managedCredits)
      return { error: "test_credit_route_unavailable", status: 503 };
    const identity = {
      issuer: config.casdoor.issuer,
      subject: session.subject,
    };
    const { ledger } = managedCredits;
    try {
      const [quote, balance] = await Promise.all([
        ledger.quote(),
        ledger.balance(identity),
      ]);
      if (!quote)
        return { error: "test_credit_route_unavailable", status: 503 };
      if (
        disclosedQuote &&
        (quote.route !== disclosedQuote.route ||
          quote.priceVersion !== disclosedQuote.priceVersion)
      )
        return { error: "test_credit_quote_changed", status: 409 };
      if (
        BigInt(balance?.availableMicrocredits ?? "0") <
        BigInt(quote.maxChargeMicrocredits)
      )
        return { error: "insufficient_credits", status: 402 };
      return { quote: botRunCreditQuote.parse(quote) };
    } catch {
      return { error: "test_credit_route_unavailable", status: 503 };
    }
  }

  async function submitBotRun({
    token,
    session,
    input,
    requestId,
    disclosedQuote,
  }: {
    token: string;
    session: AuthorizedSession;
    input: z.infer<typeof botWorkInput>;
    requestId?: string;
    disclosedQuote?: z.infer<typeof botRunCreditQuote>;
  }): Promise<BotRunSubmission> {
    const accountId = session.grant.accountId;
    const key = requestId
      ? createHash("sha256")
          .update(
            JSON.stringify([
              PERSONAL_BOT_WORK,
              accountId,
              requestId.toLowerCase(),
            ]),
          )
          .digest("hex")
      : crypto.randomUUID();
    const admission = managedCredits
      ? input.requiresComputer
        ? ({ error: "managed_computer_unavailable", status: 422 } as const)
        : await managedBotAdmission(session, disclosedQuote)
      : undefined;
    const outcome = await store.withAuthorizedSession(
      session.grant,
      token,
      async (tx): Promise<BotRunSubmission> => {
        const queue = createWorkQueue(tx, now);
        if (
          requestId &&
          (await queue.personalStatus(PERSONAL_BOT_WORK, accountId, key))
        )
          return { runId: key };
        if (!(await workspaceBots(tx).get({ ...input, accountId })))
          return { error: "bot_unavailable", status: 404 } as const;
        if (admission && "error" in admission) return admission;
        await quotas.admitBot(tx, accountId);
        const offered = await queue.offer({
          kind: PERSONAL_BOT_WORK,
          key,
          accountId,
          payload: {
            ...input,
            ...(admission ? { testCredit: admission.quote } : {}),
          },
        });
        return offered === "queued"
          ? { runId: key }
          : ({ error: "bot_unavailable", status: 404 } as const);
      },
    );
    if (!outcome.authorized)
      return { error: "authorization_changed", status: 403 } as const;
    return outcome.result;
  }

  const webRunError = (
    context: Context,
    message: string,
    status: 400 | 402 | 403 | 404 | 409 | 422 | 503,
  ) =>
    context.html(
      statusPage(
        "Couldn't submit Bot run",
        message,
        "/workspace",
        "Back to workspace",
      ),
      status,
    );

  app.post(webBotRunsPath, async (context) => {
    const token = getCookie(context, sessionCookie);
    const session = await authorize(token);
    if (!token || session.kind !== "authorized")
      return webRunError(context, "Sign in to submit a Bot run.", 403);
    if (!managedCredits)
      return webRunError(
        context,
        botRunSubmissionError.test_credit_route_unavailable,
        503,
      );
    const form = webBotRunInput.safeParse(
      await context.req.parseBody().catch(() => null),
    );
    if (!form.success)
      return webRunError(
        context,
        "Enter a message of 1 to 20,000 characters.",
        400,
      );
    const { route, priceVersion, requestId, ...input } = form.data;
    const result = await submitBotRun({
      token,
      session,
      input,
      requestId,
      disclosedQuote: { route, priceVersion },
    });
    if ("runId" in result)
      return context.redirect(`${webBotRunsPath}/${result.runId}`, 303);
    return webRunError(
      context,
      botRunSubmissionError[result.error],
      result.status,
    );
  });

  app.post("/api/workspace/bot-runs/:key/stop", async (context) => {
    const session = await automationSession(context);
    if (!session) return context.json({ error: "authorization_required" }, 403);
    const key = z
      .union([z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)])
      .safeParse(context.req.param("key"));
    if (!key.success) return context.notFound();
    const result = await store.withAuthorizedSession(
      session.grant,
      session.token,
      (tx) =>
        createWorkQueue(tx, now).requestPersonalStop(
          PERSONAL_BOT_WORK,
          session.grant.accountId,
          key.data,
        ),
    );
    if (!result.authorized)
      return context.json({ error: "authorization_changed" }, 403);
    if (!result.result) return context.notFound();
    return context.body(null, 202);
  });

  app.get("/api/workspace/bot-runs/:key", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind !== "authorized")
      return context.json({ error: "authorization_required" }, 403);
    const key = z.string().min(1).max(1024).safeParse(context.req.param("key"));
    if (!key.success) return context.json({ error: "work_not_found" }, 404);
    const result = await readBotRun(token, session, key.data);
    if (!result.authorized)
      return context.json({ error: "authorization_changed" }, 403);
    return result.run
      ? context.json(result.run)
      : context.json({ error: "work_not_found" }, 404);
  });

  async function readBotRun(
    token: string | undefined,
    session: AuthorizedSession,
    key: string,
  ) {
    const accountId = session.grant.accountId;
    const queue = createWorkQueue(database, now);
    await queue.reconcilePersonalWork(PERSONAL_BOT_WORK, accountId);
    const result = await queue.personalStatus(
      PERSONAL_BOT_WORK,
      accountId,
      key,
    );
    const testCredit =
      result &&
      (await config.testCredits?.ledger
        .receipt(
          {
            issuer: config.casdoor.issuer,
            subject: session.subject,
          },
          key,
        )
        .catch(() => undefined));
    if (!(await stillAuthorized(token, session.grant)))
      return { authorized: false } as const;
    return {
      authorized: true,
      run: result && { ...result, ...(testCredit ? { testCredit } : {}) },
    } as const;
  }

  app.get(`${webBotRunsPath}/:key`, async (context) => {
    const token = getCookie(context, sessionCookie);
    const session = await authorize(token);
    if (session.kind === "signed-out") return context.redirect("/");
    if (session.kind !== "authorized") return context.redirect("/workspace");
    const key = webBotRunKey.safeParse(context.req.param("key"));
    if (!key.success) return context.notFound();
    const result = await readBotRun(token, session, key.data);
    if (!result.authorized) return context.redirect("/workspace");
    if (!result.run) return context.notFound();
    const { state, output, interruption, testCredit } = result.run;
    const active =
      state === "queued" || state === "running" || state === "waiting";
    const statuses = {
      queued: "Your Bot run is queued.",
      running: "The Personal Assistant is working on your message.",
      waiting: "Your Bot run is waiting.",
      completed: "Your Bot run is complete.",
      stopped: interruption
        ? recoveryReason[interruption.reason]
        : "Your Bot run stopped.",
    };
    return context.html(
      page(
        "Personal Assistant Bot run",
        <>
          <Text as="p" role="status">
            {statuses[state]}
          </Text>
          {output ? <pre>{output}</pre> : null}
          {testCredit ? (
            <section aria-labelledby="bot-run-receipt">
              <Heading level={2} id="bot-run-receipt">
                Test Credit receipt
              </Heading>
              <Text as="p">{testCredit.model}</Text>
              <Text as="p">
                Reserved: {testCredit.reservedMicrocredits} microcredits
              </Text>
              {testCredit.heldMicrocredits !== "0" ? (
                <Text as="p">
                  Held: {testCredit.heldMicrocredits} microcredits
                </Text>
              ) : null}
              {testCredit.chargedMicrocredits !== null ? (
                <Text as="p">
                  Charged: {testCredit.chargedMicrocredits} microcredits
                </Text>
              ) : null}
              {testCredit.releasedMicrocredits !== null ? (
                <Text as="p">
                  Released: {testCredit.releasedMicrocredits} microcredits
                </Text>
              ) : null}
              {testCredit.state === "pending" ? (
                <Text as="p">Final charge is pending.</Text>
              ) : null}
            </section>
          ) : null}
          {active || testCredit?.state === "pending" ? (
            <Link href={`${webBotRunsPath}/${key.data}`}>
              Refresh run status
            </Link>
          ) : null}
          {active ? <script src={botRunRefreshPath} defer /> : null}
          <Link href="/workspace">Back to workspace</Link>
        </>,
      ),
    );
  });

  app.post("/api/workspace/recovery/:key", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind !== "authorized" || !token)
      return context.json({ error: "authorization_required" }, 403);
    const key = z.string().min(1).max(1024).safeParse(context.req.param("key"));
    const form = context.req
      .header("content-type")
      ?.startsWith("application/x-www-form-urlencoded");
    const body = form ? await context.req.parseBody() : undefined;
    const input = recoveryInput.safeParse(
      body
        ? {
            action: body.action,
            acknowledged: body.acknowledged === "true",
            ...(body.action === "retry" && (body.route || body.priceVersion)
              ? {
                  quote: { route: body.route, priceVersion: body.priceVersion },
                }
              : {}),
          }
        : await context.req.json().catch(() => null),
    );
    if (!key.success || !input.success)
      return context.json({ error: "invalid_recovery_request" }, 400);
    const { action, quote, acknowledged } = input.data;
    const admission =
      action === "retry" && quote
        ? await managedBotAdmission(session, quote)
        : undefined;
    let creditError:
      | Extract<BotRunCreditAdmission, { error: string }>
      | { error: "test_credit_quote_required"; status: 400 }
      | undefined;
    const accountId = session.grant.accountId;
    await createWorkQueue(database, now).reconcilePersonalWork(
      PERSONAL_BOT_WORK,
      accountId,
    );
    const outcome = await store.withAuthorizedSession(
      session.grant,
      token,
      async (tx) => {
        const queue = createWorkQueue(tx, now);
        const kind = await queue.interruptedKind(accountId, key.data);
        if (
          !kind ||
          (kind !== PERSONAL_BOT_WORK &&
            !Object.hasOwn(unattendedWorkLabels, kind))
        )
          return { kind: "missing" } as const;
        return queue.recover({
          action,
          acknowledged,
          kind,
          accountId,
          key: key.data,
          ...(kind === PERSONAL_BOT_WORK
            ? {
                async startFresh(transaction, payload) {
                  const request = queuedBotWorkInput.safeParse(payload);
                  if (!request.success) return;
                  const {
                    testCredit,
                    workspaceId,
                    botId,
                    instruction,
                    requiresComputer,
                  } = request.data;
                  const work = {
                    workspaceId,
                    botId,
                    instruction,
                    requiresComputer,
                  };
                  if (testCredit) {
                    if (!admission) {
                      creditError = {
                        error: "test_credit_quote_required",
                        status: 400,
                      };
                      return;
                    }
                    if ("error" in admission) {
                      creditError = admission;
                      return;
                    }
                    if (work.requiresComputer) return;
                  } else if (!runPersonalBot || quote) {
                    return;
                  }
                  if (
                    !(await workspaceBots(transaction).get({
                      ...work,
                      accountId,
                    }))
                  )
                    return;
                  await quotas.admitBot(transaction, accountId);
                  const newKey = crypto.randomUUID();
                  const offered = await createWorkQueue(transaction, now).offer(
                    {
                      kind,
                      key: newKey,
                      accountId,
                      payload: {
                        ...work,
                        ...(testCredit && admission && "quote" in admission
                          ? {
                              testCredit: admission.quote,
                              rerunOfOperationId: key.data,
                            }
                          : {}),
                      },
                    },
                  );
                  return offered === "queued" ? newKey : undefined;
                },
              }
            : {
                async startFresh(transaction, payload) {
                  if (!runPersonalBot || !backgroundBotKinds.includes(kind))
                    return;
                  await quotas.admitBot(transaction, accountId);
                  return retryBackgroundWork(
                    transaction,
                    now,
                    accountId,
                    kind,
                    payload,
                    runPersonalBot,
                  );
                },
              }),
        });
      },
    );
    if (!outcome.authorized)
      return context.json({ error: "recovery_unavailable" }, 403);
    if (outcome.result.kind === "forbidden") {
      if (!creditError)
        return context.json({ error: "recovery_unavailable" }, 403);
      const { error, status } = creditError;
      return form
        ? webRunError(
            context,
            error === "test_credit_quote_required"
              ? "Review the current Test Credit price in your workspace before retrying."
              : botRunSubmissionError[error],
            status,
          )
        : context.json({ error }, status);
    }
    if (outcome.result.kind === "missing")
      return context.json({ error: "work_not_found" }, 404);
    if (outcome.result.kind === "acknowledgement_required")
      return context.json(
        { error: "external_outcome_acknowledgement_required" },
        409,
      );
    return form
      ? context.redirect(
          action === "retry" &&
            quote &&
            outcome.result.recovery.action === "retry"
            ? `${webBotRunsPath}/${outcome.result.recovery.key}`
            : "/workspace",
          303,
        )
      : context.json(outcome.result.recovery);
  });

  app.get("/api/workspace/conversations", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind === "unconfirmed")
      return context.json(
        { error: session.reason, cutoffAt: session.cutoffAt },
        503,
      );
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    const conversations = await store.recentConversations(
      session.grant.accountId,
    );
    const accessMs = await remainingAccess(token, session.grant);
    if (!accessMs) return context.json({ error: "authorization_changed" }, 403);
    context.header("OpenBot-Access-Ms", String(accessMs));
    return context.json({ conversations });
  });

  app.post("/auth/sign-out", async (context) => {
    const token = requestSession(context);
    if (token) await store.signOut(token);
    if (context.req.header("authorization") !== undefined)
      return context.body(null, 204);
    closure.clearCookies(context);
    deleteCookie(context, sessionCookie, cookieOptions);
    return context.redirect("/", 303);
  });

  return Object.assign(app, {
    accessWorkspaceComputerForTask: computer?.accessForTask,
    renewWorkspaceComputers: computer?.renew,
    async sweepWorkspaceClosures() {
      await closure.sweep();
      await sweepCleanup();
    },
    sweepBotWork: () => botWork.sweep(runPersonalBot, executeManaged),
    sweepBotDecisions: () => config.botRuntime?.sweepDecisions(quotas),
    offerAutomationSchedules: automation.offerSchedules,
    sweepAutomationRoutines: automation.sweepRoutines,
    sweepAutomationInbound: automation.sweepInbound,
    backgroundWorkers,
    refreshAccounts: () => accountAccess.refreshAccounts(config.casdoor.issuer),
  });
}
