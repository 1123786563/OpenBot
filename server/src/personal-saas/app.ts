import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { seal, unseal } from "../auth/signed-value";
import type { Database } from "../db/client";
import {
  type AccountGrant,
  accountDecision,
  createAccountAccess,
} from "./account-access";
import { browserAttempt, type CasdoorConfig, casdoor } from "./casdoor";
import { sessionEventRoutes } from "./session-events";
import {
  cookieOptions,
  sessionCookie,
  sessionRevocationRoutes,
} from "./session-revocation";
import { personalSaasStore, sessionSeconds } from "./store";

const attemptPrefix = "__Host-openbot-oidc-";
const callbackPath = "/auth/casdoor/callback";
const sessionSeal = "personal-saas-access-token";

function reportFailure(
  stage: "sign-in" | "casdoor-discovery" | "workspace-setup" | "request",
) {
  console.warn(JSON.stringify({ type: "personal-saas-trial-failure", stage }));
}

export type PersonalSaasConfig = {
  origin: string;
  now?: () => number;
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
  const now = config.now ?? Date.now;
  const store = personalSaasStore(database, now);
  const accountAccess = createAccountAccess(
    database,
    provider.accountStatus,
    now,
  );

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self' ${config.casdoor.discoveryUrl.origin}; base-uri 'none'; frame-ancestors 'none'`,
    );
    context.header("Referrer-Policy", "same-origin");
    context.header("X-Content-Type-Options", "nosniff");
    if (
      context.req.method === "POST" &&
      context.req.header("origin") !== config.origin
    )
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

  app.get("/auth/casdoor/start", async (context) => {
    try {
      const { authorization, state, attempt } = await provider.start();
      setCookie(
        context,
        `${attemptPrefix}${state}`,
        await seal(JSON.stringify(attempt), config.encryptionKey, state),
        { ...cookieOptions, maxAge: 600 },
      );
      return context.redirect(authorization.href);
    } catch {
      reportFailure("casdoor-discovery");
      return context.html(
        statusPage(
          "Sign-in unavailable",
          "OpenBot couldn't reach Casdoor. Please try again.",
        ),
        503,
      );
    }
  });

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
    if (
      !code ||
      !attempt ||
      (issuer !== undefined && issuer !== config.casdoor.issuer)
    )
      return context.html(retry, 400);
    const parsed = browserAttempt.parse(JSON.parse(attempt));
    if (parsed.expiresAt <= Date.now()) return context.html(retry, 400);

    try {
      const identity = await provider.authenticate(code, parsed);
      if (identity.kind === "unverified")
        return context.html(
          statusPage(
            "Verify your email",
            "Complete email verification in Casdoor, then sign in again.",
          ),
          403,
        );
      if (identity.kind === "inactive")
        return context.html(
          statusPage(
            "Account unavailable",
            "Casdoor hasn't confirmed that your account is active.",
          ),
          403,
        );
      const accountId = await store.bindIdentity(identity);
      if (!(await accountAccess.check(identity)))
        throw new Error("Account status unavailable");
      const token = await store.signIn({
        accountId,
        loginStartedAt: parsed.expiresAt - 10 * 60_000,
        encryptedAccessToken: await seal(
          identity.accessToken,
          config.encryptionKey,
          sessionSeal,
        ),
      });
      if (!token) throw new Error("Account admission changed");
      setCookie(context, sessionCookie, token, {
        ...cookieOptions,
        maxAge: sessionSeconds,
      });
      return context.redirect("/workspace", 303);
    } catch {
      reportFailure("sign-in");
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
      grant: {
        accountId: current.accountId,
        epoch: decision.epoch,
        expiresAt: Math.min(decision.expiresAt, current.expiresAt.getTime()),
      },
    } as const;
  }

  async function stillAuthorized(
    token: string | undefined,
    grant: AccountGrant,
  ) {
    const current = await authorize(token, false);
    return (
      current.kind === "authorized" &&
      current.grant.epoch === grant.epoch &&
      now() < grant.expiresAt
    );
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
    if (session.kind === "signed-out") {
      deleteCookie(context, sessionCookie, cookieOptions);
      return context.redirect("/");
    }
    const workspace = await store.workspace(session.grant.accountId);
    if (!(await stillAuthorized(token, session.grant)))
      return context.redirect("/workspace");
    if (!workspace) return context.html(preparePage());
    return context.html(
      page(
        "Personal Workspace",
        html`<section aria-labelledby="assistant"><h2 id="assistant">${workspace.personalAssistant.name}</h2></section>
      <form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form>
      <form method="post" action="/auth/sign-out-all">
        <p>Verify your identity with Casdoor to require every device to sign in again.</p>
        <button type="submit">Sign out all devices</button>
      </form>
      <script src="/assets/session.js" data-access-ms="${Math.max(0, session.grant.expiresAt - now())}" defer></script>`,
      ),
    );
  });

  app.post("/workspace/prepare", async (context) => {
    const token = getCookie(context, sessionCookie);
    const session = await authorize(token);
    if (session.kind === "unconfirmed")
      return context.html(preparePage(true), 503);
    if (session.kind === "signed-out" || !token)
      return context.redirect("/workspace", 303);
    try {
      if (!(await store.provision(session.grant, token)))
        return context.redirect("/workspace", 303);
      return context.redirect("/workspace", 303);
    } catch {
      reportFailure("workspace-setup");
      return context.html(preparePage(true), 503);
    }
  });

  app.get("/api/workspace", async (context) => {
    const token = getCookie(context, sessionCookie);
    const session = await authorize(token);
    if (session.kind === "unconfirmed")
      return context.json(
        { error: session.reason, cutoffAt: session.cutoffAt },
        503,
      );
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    const workspace = await store.workspace(session.grant.accountId);
    if (!(await stillAuthorized(token, session.grant)))
      return context.json({ error: "authorization_changed" }, 403);
    return workspace
      ? context.json(workspace)
      : context.json({ status: "preparing" }, 202);
  });

  return Object.assign(app, {
    refreshAccounts: () => accountAccess.refreshAccounts(config.casdoor.issuer),
  });
}
