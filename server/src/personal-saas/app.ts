import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { seal, unseal } from "../auth/signed-value";
import type { Database } from "../db/client";
import { browserAttempt, type CasdoorConfig, casdoor } from "./casdoor";
import { personalSaasStore, sessionSeconds } from "./store";

const sessionCookie = "__Host-openbot-personal";
const attemptPrefix = "__Host-openbot-oidc-";
const callbackPath = "/auth/casdoor/callback";
const cookieOptions = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;
const sessionSeal = "personal-saas-access-token";

function reportFailure(
  stage:
    | "sign-in"
    | "casdoor-discovery"
    | "workspace-status"
    | "workspace-setup"
    | "request",
) {
  console.warn(JSON.stringify({ type: "personal-saas-trial-failure", stage }));
}

export type PersonalSaasConfig = {
  origin: string;
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
  const store = personalSaasStore(database);

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
      const token = await store.signIn({
        ...identity,
        encryptedAccessToken: await seal(
          identity.accessToken,
          config.encryptionKey,
          sessionSeal,
        ),
      });
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

  async function authorize(token: string | undefined) {
    if (!token || !/^[\w-]{43}$/.test(token))
      return { kind: "signed-out" } as const;
    const session = await store.session(token);
    if (!session || session.issuer !== config.casdoor.issuer)
      return { kind: "signed-out" } as const;
    const access = await unseal(
      session.encryptedAccessToken,
      config.encryptionKey,
      sessionSeal,
    );
    if (!access) return { kind: "signed-out" } as const;
    try {
      if (await provider.accountActive(access, session.subject))
        return { kind: "authorized", accountId: session.accountId } as const;
      await store.signOut(token);
      return { kind: "signed-out" } as const;
    } catch {
      reportFailure("workspace-status");
      return { kind: "unconfirmed" } as const;
    }
  }

  app.get("/workspace", async (context) => {
    const session = await authorize(getCookie(context, sessionCookie));
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
    const workspace = await store.workspace(session.accountId);
    if (!workspace) return context.html(preparePage());
    return context.html(
      page(
        "Personal Workspace",
        html`<section aria-labelledby="assistant"><h2 id="assistant">${workspace.personalAssistant.name}</h2></section>
      <form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form>`,
      ),
    );
  });

  app.post("/workspace/prepare", async (context) => {
    const session = await authorize(getCookie(context, sessionCookie));
    if (session.kind === "unconfirmed")
      return context.html(preparePage(true), 503);
    if (session.kind === "signed-out")
      return context.redirect("/workspace", 303);
    try {
      await store.provision(session.accountId);
      return context.redirect("/workspace", 303);
    } catch {
      reportFailure("workspace-setup");
      return context.html(preparePage(true), 503);
    }
  });

  app.get("/api/workspace", async (context) => {
    const session = await authorize(getCookie(context, sessionCookie));
    if (session.kind === "unconfirmed")
      return context.json({ error: "account_status_unconfirmed" }, 503);
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    const workspace = await store.workspace(session.accountId);
    return workspace
      ? context.json(workspace)
      : context.json({ status: "preparing" }, 202);
  });

  app.post("/auth/sign-out", async (context) => {
    const token = getCookie(context, sessionCookie);
    if (token) await store.signOut(token);
    deleteCookie(context, sessionCookie, cookieOptions);
    return context.redirect("/", 303);
  });

  return app;
}
