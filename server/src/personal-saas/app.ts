import { createHmac } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { z } from "zod";
import { createApprovalRoutes } from "../approvals/routes";
import { createApprovalStore } from "../approvals/store";
import { seal, unseal } from "../auth/signed-value";
import type { Database } from "../db/client";
import { createWorkQueue } from "../work/queue";
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
import type { createPersonalBotRuntime } from "./bot-runtime";
import {
  botWorkInput,
  PERSONAL_BOT_WORK,
  personalBotWork,
  recoveryInput,
} from "./bot-work";
import { browserAttempt, type CasdoorConfig, casdoor } from "./casdoor";
import { ensureDecisionActor } from "./decision-actor";
import { bearerSession, type NativeAttempt, nativeAuth } from "./native-auth";
import { sessionEventRoutes } from "./session-events";
import {
  cookieOptions,
  sessionCookie,
  sessionRevocationRoutes,
} from "./session-revocation";
import { personalSaasStore, sessionSeconds } from "./store";
import { supportAccess } from "./support-access";
import { supportRoutes } from "./support-routes";
import { workspaceBotRoutes } from "./workspace-bot-routes";
import { workspaceBots } from "./workspace-bots";
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
const recoveryReason = {
  account_disabled: "The account was disabled.",
  account_status_unconfirmed: "Account status could not be confirmed.",
  workspace_paused: "The workspace was paused.",
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
  encryptionKey: string;
  casdoor: CasdoorConfig;
};

function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · OpenBot</title><link rel="stylesheet" href="/assets/entry.css"></head>
    <body><main><header>OpenBot</header><h1>${title}</h1>${body}</main></body></html>`;
}

function statusPage(
  title: string,
  message: string,
  href = "/",
  action = "Back to sign in",
) {
  return page(
    title,
    html`<p role="status">${message}</p><a href="${href}">${action}</a>`,
  );
}

function preparePage(retry = false) {
  return page(
    retry
      ? "Couldn't prepare your Personal Workspace"
      : "Preparing your Personal Workspace",
    html`
    <p role="status">${retry ? "Try again to open your workspace." : "We're setting up your Personal Assistant. This may take a moment."}</p>
    <form id="prepare" method="post" action="/workspace/prepare">
      <button type="submit">${retry ? "Retry" : "Continue"}</button>
    </form>
    ${retry ? "" : html`<script src="/assets/prepare.js" defer></script>`}
  `,
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
  const runPersonalBot = config.botRuntime?.runTurn ?? config.runPersonalBot;
  const now = config.now ?? Date.now;
  const store = personalSaasStore(database, now);
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
  const botWork = personalBotWork(database, now, computer?.accessForTask);
  const native = nativeAuth({
    database,
    encryptionKey: config.encryptionKey,
    now,
    suspensionSupport: config.suspensionSupport,
  });
  const browserLogin = browserAttempt.extend({
    native: native.attempt.optional(),
  });

  const automation = personalAutomation(database, now, runPersonalBot);

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
    if (/^\/api\/workspaces\/[^/]+\/exports$/.test(context.req.path))
      return Boolean(bearer(context));
    if (
      context.req.path.startsWith("/api/workspace/recovery/") ||
      context.req.path === "/api/workspace/bot-runs"
    )
      return Boolean(bearer(context));
    switch (context.req.path) {
      case "/api/auth/native/exchange":
        return true;
      case "/auth/sign-out":
      case "/workspace/prepare":
      case "/api/workspace/computer/start":
        return Boolean(bearer(context));
      default:
        return false;
    }
  }

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self' ${config.casdoor.discoveryUrl.origin}; base-uri 'none'; frame-ancestors 'none'`,
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

  app.onError((_error, context) => {
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
  app.get(
    "/assets/entry.css",
    () =>
      new Response(
        `
    :root { color-scheme: light dark; font-family: system-ui, sans-serif }
    body { margin: 0; min-height: 100dvh; display: grid; align-items: center }
    main { box-sizing: border-box; width: min(100%, 40rem); margin-inline: auto; padding: 2rem }
    header { font-weight: 700; margin-block-end: 2.5rem }
    h1 { font-size: clamp(1.75rem, 6vw, 2.75rem); line-height: 1.1; margin: 0 0 1rem }
    h2 { font-size: 1.125rem }
    p { line-height: 1.6; margin-block-end: 1.5rem }
    a, button { font: inherit }
    .continue, button { display: inline-block; border: 1px solid; border-radius: .5rem; background: CanvasText; color: Canvas; padding: .65rem 1rem; text-decoration: none; cursor: pointer }
    form { margin-block-start: 1.5rem }
  `,
        { headers: { "content-type": "text/css; charset=utf-8" } },
      ),
  );
  app.get(
    "/assets/prepare.js",
    () =>
      new Response(
        `requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('prepare')?.requestSubmit()));`,
        { headers: { "content-type": "text/javascript; charset=utf-8" } },
      ),
  );

  app.get("/", (context) => {
    if (getCookie(context, sessionCookie))
      return context.redirect("/workspace");
    return context.html(
      page(
        "Open your Personal Workspace",
        html`<p>Sign in or create an account in Casdoor using your email address.</p>
      <a class="continue" href="/auth/casdoor/start">Continue with Casdoor</a>`,
      ),
    );
  });

  app.route("/", native.routes);
  app.get("/auth/casdoor/start", (context) => startBrowser(context));
  app.get("/auth/native/start", async (context) => {
    const request = native.attempt.safeParse(context.req.query());
    if (!request.success)
      return context.text("Invalid native sign-in request", 400);
    return startBrowser(context, request.data);
  });

  async function startBrowser(context: Context, nativeAttempt?: NativeAttempt) {
    try {
      const { authorization, state, attempt } = await provider.start();
      setCookie(
        context,
        `${attemptPrefix}${state}`,
        await seal(
          JSON.stringify({ ...attempt, native: nativeAttempt }),
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
      if (suspension) {
        deleteCookie(context, sessionCookie, cookieOptions);
        return context.html(
          page(
            "Personal Workspace paused",
            html`<p role="status">Your access to this OpenBot workspace is paused.</p>
              ${suspension.reason ? html`<p>${suspension.reason}</p>` : ""}
              <p>Operation ID <code>${suspension.operationId}</code></p>
              ${suspension.supportEmail ? html`<p>Contact support at <a href="mailto:${suspension.supportEmail}">${suspension.supportEmail}</a>.</p>` : ""}
              <a href="/auth/casdoor/start">Sign in again</a>`,
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
      setCookie(context, sessionCookie, token, {
        ...cookieOptions,
        maxAge: sessionSeconds,
      });
      return context.redirect("/workspace", 303);
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
      failurePage: async (status) =>
        new Response(
          await statusPage(
            "Couldn't sign out all devices",
            "OpenBot couldn't verify your identity. Return to your workspace to try again.",
            "/workspace",
            "Back to workspace",
          ),
          { status, headers: { "content-type": "text/html; charset=UTF-8" } },
        ),
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
    ["/api/workspace/computer", "/api/workspace/computer/start"],
    async (context) => {
      const start = context.req.method === "POST";
      if (start !== context.req.path.endsWith("/start"))
        return context.notFound();
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
      if (start) {
        if (!(await stillAuthorized(token, session.grant)))
          return context.json({ error: "authorization_changed" }, 403);
        if (!(await computer.start(workspace.id, session.grant)))
          return context.json({ error: "computer_start_not_accepted" }, 409);
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
      page,
    }),
  );

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
    if (!workspace) return context.html(preparePage());
    const computerStatus = await computer
      ?.status(workspace.id)
      .catch(() => undefined);
    const recovery = await botWork.history(session.grant.accountId);
    const history = await approvalHistory(session.grant.accountId);
    if (!(await remainingAccess(token, session.grant)))
      return context.redirect("/workspace");
    return context.html(
      page(
        "Personal Workspace",
        html`<p id="workspace-access" role="status">Checking your workspace…</p>
      <a id="workspace-retry" href="/workspace" hidden>Retry</a>
      <noscript>Enable JavaScript to verify workspace access.</noscript>
      <div id="protected-workspace" hidden>
      <p><a href="${automationPath}">Routines and inbound bindings</a></p>
      <section aria-labelledby="assistant"><h2 id="assistant">${workspace.personalAssistant.name}</h2></section>
      <section aria-labelledby="conversations"><h2 id="conversations">Recent conversations</h2>
        ${
          conversations.length === 0
            ? html`<p>No conversations yet.</p>`
            : html`<ul>${conversations.map(
                ({ title, preview }) =>
                  html`<li><strong>${title}</strong>${preview ? html`<p>${preview}</p>` : ""}</li>`,
              )}</ul>`
        }
      </section>
      ${
        computerStatus
          ? html`<section aria-labelledby="computer"><h2 id="computer">Computer</h2>
        <p>${
          {
            not_started: "Ready to set up",
            starting: "Starting. Refresh this page to check progress.",
            running: "Running",
            stopping: "Stopping. Refresh this page to check progress.",
            restart_required:
              "Stopped. Your saved files and settings are kept.",
          }[computerStatus.status]
        }</p>
        ${computerStatus.cutoff === "failed" ? html`<p>Computer exit could not be confirmed by the authorization deadline.</p>` : ""}
        ${
          ["not_started", "restart_required"].includes(computerStatus.status)
            ? html`<form method="post" action="/api/workspace/computer/start"><button type="submit">Start Computer</button></form>`
            : ""
        }
      </section>`
          : ""
      }
      <form method="post" action="/api/workspaces/${workspace.id}/exports">
        <button type="submit">Download workspace data</button>
      </form>
      ${
        history.length
          ? html`<section aria-labelledby="approval-history">
        <h2 id="approval-history">Approval history</h2>
        <ul>${history.map((item) => html`<li>${item.tool} · ${item.invalidated ? "Invalidated" : item.status}</li>`)}</ul>
      </section>`
          : ""
      }
      <p><a href="/api/workspaces/${workspace.id}/support-requests/view">Support access</a></p>
      <form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form>
      <form method="post" action="/auth/sign-out-all">
        <p>Verify your identity with Casdoor to require every device to sign in again.</p>
        <button type="submit">Sign out all devices</button>
      </form>
      ${
        recovery.length
          ? html`<section aria-labelledby="work-recovery"><h2 id="work-recovery">Stopped work</h2>
        <ul>${recovery.map(
          (item) => html`<li>
          <p>${item.instruction}</p><p>${recoveryReason[item.reason]}</p>
          ${item.output ? html`<p>Output before interruption</p><pre>${item.output}</pre>` : ""}
          ${item.outcomeUnknown ? html`<p>Check any external actions before retrying. Their outcome is unknown.</p>` : ""}
          ${
            item.recovery
              ? html`<p>${item.recovery.action === "retry" ? "Queued as a new run" : "Cancelled"}</p>`
              : html`<form method="post" action="/api/workspace/recovery/${item.key}">
                ${runPersonalBot && item.outcomeUnknown ? html`<label><input type="checkbox" name="acknowledged" value="true"> I checked the external actions.</label>` : ""}
                ${runPersonalBot ? html`<button name="action" value="retry">${item.outcomeUnknown ? "Retry as a new run" : "Requeue"}</button>` : ""}
                <button name="action" value="cancel">Cancel item</button>
              </form>`
          }
        </li>`,
        )}</ul></section>`
          : ""
      }
      </div>
      <script src="/assets/session.js" data-workspace-view="${workspaceViewBinding(token, session.grant)}" defer></script>`,
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
      if (!(await store.provision(session.grant, token)))
        return isNative
          ? context.json({ error: "authorization_changed" }, 403)
          : context.redirect("/workspace", 303);
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
    const recovery = workspace
      ? await botWork.history(session.grant.accountId)
      : [];
    const accessMs = await remainingAccess(token, session.grant);
    if (!accessMs) return context.json({ error: "authorization_changed" }, 403);
    if (workspace) context.header("OpenBot-Access-Ms", String(accessMs));
    return workspace
      ? context.json(
          recovery.length
            ? {
                ...workspace,
                recovery: recovery.map((item) => ({
                  ...item,
                  reasonMessage: recoveryReason[item.reason],
                })),
                recoveryCanRetry: Boolean(runPersonalBot),
              }
            : workspace,
        )
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
    automationPath,
    workspaceAutomationRoutes({
      automation,
      executionEnabled: Boolean(runPersonalBot),
      getSession: automationSession,
      withAuthorizedSession: store.withAuthorizedSession,
      page,
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
    if (!runPersonalBot)
      return context.json({ error: "bot_execution_unavailable" }, 503);
    const input = botWorkInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!input.success) return context.json({ error: "invalid_request" }, 400);
    const accountId = session.grant.accountId;
    const outcome = await store.withAuthorizedSession(
      session.grant,
      token,
      async (tx) => {
        if (!(await workspaceBots(tx).get({ ...input.data, accountId })))
          return null;
        const key = crypto.randomUUID();
        const offered = await createWorkQueue(tx, now).offer({
          kind: PERSONAL_BOT_WORK,
          key,
          accountId,
          payload: input.data,
        });
        return offered === "queued" ? key : null;
      },
    );
    if (!outcome.authorized)
      return context.json({ error: "authorization_changed" }, 403);
    return outcome.result
      ? context.json({ runId: outcome.result }, 202)
      : context.json({ error: "bot_unavailable" }, 404);
  });

  app.get("/api/workspace/bot-runs/:key", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind !== "authorized")
      return context.json({ error: "authorization_required" }, 403);
    const key = z.uuid().safeParse(context.req.param("key"));
    if (!key.success) return context.json({ error: "work_not_found" }, 404);
    const accountId = session.grant.accountId;
    const queue = createWorkQueue(database, now);
    await queue.reconcilePersonalWork(PERSONAL_BOT_WORK, accountId);
    const result = await queue.personalStatus(
      PERSONAL_BOT_WORK,
      accountId,
      key.data,
    );
    if (!(await stillAuthorized(token, session.grant)))
      return context.json({ error: "authorization_changed" }, 403);
    return result
      ? context.json(result)
      : context.json({ error: "work_not_found" }, 404);
  });

  app.post("/api/workspace/recovery/:key", async (context) => {
    const token = requestSession(context);
    const session = await authorize(token);
    if (session.kind !== "authorized" || !token)
      return context.json({ error: "authorization_required" }, 403);
    const key = z.uuid().safeParse(context.req.param("key"));
    const form = context.req
      .header("content-type")
      ?.startsWith("application/x-www-form-urlencoded");
    const body = form ? await context.req.parseBody() : undefined;
    const input = recoveryInput.safeParse(
      body
        ? { action: body.action, acknowledged: body.acknowledged === "true" }
        : await context.req.json().catch(() => null),
    );
    if (!key.success || !input.success)
      return context.json({ error: "invalid_recovery_request" }, 400);
    const accountId = session.grant.accountId;
    await createWorkQueue(database, now).reconcilePersonalWork(
      PERSONAL_BOT_WORK,
      accountId,
    );
    const outcome = await store.withAuthorizedSession(
      session.grant,
      token,
      (tx) =>
        createWorkQueue(tx, now).recover({
          ...input.data,
          kind: PERSONAL_BOT_WORK,
          accountId,
          key: key.data,
          mayRetry: async (transaction, payload) => {
            const request = botWorkInput.safeParse(payload);
            return Boolean(
              runPersonalBot &&
                request.success &&
                (await workspaceBots(transaction).get({
                  ...request.data,
                  accountId,
                })),
            );
          },
        }),
    );
    if (!outcome.authorized || outcome.result.kind === "forbidden")
      return context.json({ error: "recovery_unavailable" }, 403);
    if (outcome.result.kind === "missing")
      return context.json({ error: "work_not_found" }, 404);
    if (outcome.result.kind === "acknowledgement_required")
      return context.json(
        { error: "external_outcome_acknowledgement_required" },
        409,
      );
    return form
      ? context.redirect("/workspace", 303)
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
    deleteCookie(context, sessionCookie, cookieOptions);
    return context.redirect("/", 303);
  });

  return Object.assign(app, {
    accessWorkspaceComputerForTask: computer?.accessForTask,
    renewWorkspaceComputers: computer?.renew,
    sweepBotWork: () => botWork.sweep(runPersonalBot),
    sweepBotDecisions: () => config.botRuntime?.sweepDecisions(),
    offerAutomationSchedules: automation.offerSchedules,
    sweepAutomationRoutines: automation.sweepRoutines,
    sweepAutomationInbound: automation.sweepInbound,
    refreshAccounts: () => accountAccess.refreshAccounts(config.casdoor.issuer),
  });
}
