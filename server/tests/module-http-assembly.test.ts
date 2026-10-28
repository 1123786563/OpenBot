import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createApp } from "../src/app";
import type { AuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import type { RoutineRunner } from "../src/routines/runner";
import type { UserInstructionsStore } from "../src/user-instructions";
import { testEnvironment } from "./support/environment";

/*
 * MOD02 (#622): the HTTP assembly matrix.
 *
 * createApp's mount section moved to server/src/assembly/http.ts
 * (assembleHttpApp). These tests go through createApp — the deployment-facing
 * entry every real caller uses — so each one exercises the delegation AND the
 * factory behind it. What MOD02 must not change is pinned here in three
 * faces:
 *
 *   1. the capability three-state matrix: an optional capability with its
 *      dependency absent is UNMOUNTED (404, never an empty success route),
 *      one mounted on an absent store keeps its ORIGINAL refusal (503), and
 *      an enabled one answers real data;
 *   2. the authentication judgments: no session 401, signed-in non-admin on
 *      an administrator route 403, and a deployment with no identity provider
 *      at all stays a 503 guard rather than a fallback identity;
 *   3. the origin floor: one trusted-browser-origin list answers CORS on
 *      /api/* — trusted origins are echoed, everything else (including a
 *      preview-style host) gets no grant.
 *
 * The mount ORDER is pinned at the seams it is load-bearing at: the
 * pre-gate surfaces (/health, /ready, /api/capabilities) answer without any
 * session, while everything below the enterprise gate does not.
 */

const SECRET = "worker-shared-secret";
const TRUSTED_ORIGIN = "https://app.openbot.test";

const MEMBER = {
  id: "member-1",
  email: "member@openbot.test",
  name: "A Member",
  image: null,
};

const noSessionAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => null,
  },
};

function memberSessionAuth() {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({ user: MEMBER }),
    },
  };
}

const memberRoles = { rolesForUser: async () => ["user"] as const };

function stubRunner(): { runner: RoutineRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    runner: {
      run: (id: string) => {
        calls.push(id);
        return Promise.resolve();
      },
    },
    calls,
  };
}

function recordingAuditStore(): { store: AuditStore; rows: unknown[] } {
  const rows: unknown[] = [];
  return {
    store: { insert: async (event: unknown) => void rows.push(event) },
    rows,
  };
}

/** A person's own standing instructions, in memory — the same shape the real store answers. */
function instructionsStore(text: string): UserInstructionsStore {
  return {
    read: async () => text,
    write: async (_userId, next) => next.trim(),
  };
}

interface AppOptions {
  environment?: Record<string, string | undefined>;
  auth?: unknown;
  roleRepository?: unknown;
  auditStore?: AuditStore;
  routineRunner?: RoutineRunner;
  userInstructions?: UserInstructionsStore;
}

/*
 * `createApp` is a fifty-parameter positional function; everything after
 * `config` is optional. Building the argument list explicitly, once, keeps
 * every call site here honest about which slot each dependency lands in —
 * the same discipline routine-endpoint.test.ts and
 * settings-instructions-routes.test.ts hold, extended to the full signature
 * MOD02 froze.
 */
function buildApp(options: AppOptions = {}) {
  const args: Parameters<typeof createApp> = [
    loadConfig(options.environment ?? testEnvironment()),
    options.auth as never, // auth
    options.roleRepository as never, // roleRepository
    undefined, // auditReader
    undefined, // credentialService
    undefined, // packageStatusReader
    undefined, // copilotHandler
    undefined, // computerGateway
    undefined, // computerPolicy
    undefined, // agentProfileStore
    undefined, // channelStore
    undefined, // channelEvents
    options.auditStore as never, // auditStore
    undefined, // componentStore
    undefined, // pluginStore
    undefined, // sandboxedStore
    undefined, // threadIdentity
    undefined, // peopleStore
    undefined, // identityProviders
    undefined, // intentRouter
    undefined, // pageFrames
    options.routineRunner, // routineRunner
    undefined, // routineStore
    undefined, // onboardingStore
    options.userInstructions, // userInstructions
    undefined, // attachmentDatabase
    undefined, // hostAccessBroker
    undefined, // desktopHostToken
    undefined, // deploymentToolCaller
    undefined, // composio
    undefined, // modelProviderProxy
    undefined, // userPreferences
    undefined, // voiceSessions
    undefined, // learning
    undefined, // coworker
    undefined, // selfHostBanner
    undefined, // billing
    undefined, // openConnector
    undefined, // payments
    undefined, // codeRunGatewayFactory
    undefined, // statements
    undefined, // credits
    undefined, // workshopRoutes
    undefined, // publicWorkshopRoutes
    undefined, // craftRoutes
    undefined, // openMuseSeams
    undefined, // identity
    undefined, // identityGithubCallback
    undefined, // botServices
    undefined, // workbenchPayer
  ];
  return createApp(...args);
}

async function postWorkerDispatch(
  app: ReturnType<typeof buildApp>,
  init: RequestInit = {},
) {
  return app.request("http://openbot.local/internal/routines/run", {
    method: "POST",
    ...init,
  });
}

describe("MOD02 assembly: capability three-state matrix", () => {
  test("worker dispatch with no runner built is unmounted (404), not an empty success route", async () => {
    const app = buildApp({
      environment: testEnvironment({ WORKER_SHARED_SECRET: SECRET }),
    });
    const response = await postWorkerDispatch(app, {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(response.status).toBe(404);
  });

  test("worker dispatch enabled: correct bearer answers 202 and fires the runner once", async () => {
    const { runner, calls } = stubRunner();
    const app = buildApp({
      environment: testEnvironment({ WORKER_SHARED_SECRET: SECRET }),
      routineRunner: runner,
      auditStore: recordingAuditStore().store,
    });
    const response = await postWorkerDispatch(app, {
      body: JSON.stringify({ routineRunId: "rr-1" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(calls).toEqual(["rr-1"]);
  });

  test("worker dispatch with no secret configured keeps the original 401 refusal", async () => {
    const { runner } = stubRunner();
    const app = buildApp({
      environment: testEnvironment({ WORKER_SHARED_SECRET: undefined }),
      routineRunner: runner,
      auditStore: recordingAuditStore().store,
    });
    const response = await postWorkerDispatch(app, {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "This endpoint is the worker's.",
    });
  });

  test("standing instructions with no store keep the mounted 503 refusal", async () => {
    const app = buildApp({
      auth: memberSessionAuth(),
      roleRepository: memberRoles,
    });
    const response = await app.request(
      "http://openbot.local/api/settings/instructions",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Standing instructions are not available.",
    });
  });

  test("standing instructions enabled: the person's own text answers 200", async () => {
    const app = buildApp({
      auth: memberSessionAuth(),
      roleRepository: memberRoles,
      userInstructions: instructionsStore("answer in prose"),
    });
    const response = await app.request(
      "http://openbot.local/api/settings/instructions",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ instructions: "answer in prose" });
  });

  test("transcription off and on project the switch, never the key", async () => {
    const off = await buildApp().request(
      "http://openbot.local/api/capabilities",
    );
    expect((await off.json()).transcription).toBe(false);

    const on = await buildApp({
      environment: testEnvironment({
        TRANSCRIPTION_PROVIDER: "openai-compatible",
        TRANSCRIPTION_BASE_URL: "https://speech.private.example/v1",
        TRANSCRIPTION_MODEL: "private-speech-model",
        TRANSCRIPTION_API_KEY: "private-speech-key",
      }),
    }).request("http://openbot.local/api/capabilities");
    const body = await on.text();
    expect(JSON.parse(body).transcription).toBe(true);
    expect(body).not.toContain("private-speech-key");
  });
});

describe("MOD02 assembly: authentication judgments unchanged", () => {
  test("a protected route with no session answers the guard's 401", async () => {
    const app = buildApp({ auth: noSessionAuth, roleRepository: memberRoles });
    const response = await app.request("http://openbot.local/api/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required.",
    });
  });

  test("a signed-in non-admin on an administrator route answers the guard's 403", async () => {
    const app = buildApp({
      auth: memberSessionAuth(),
      roleRepository: memberRoles,
    });
    const response = await app.request("http://openbot.local/api/admin/status");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Administrator access required.",
    });
  });

  test("a deployment with no identity provider at all stays a 503 guard, not a fallback identity", async () => {
    const app = buildApp();
    const response = await app.request("http://openbot.local/api/me");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "No identity provider is configured.",
    });
  });

  test("pre-gate surfaces still answer with nobody signed in (mount order pin)", async () => {
    const app = buildApp();
    const capabilities = await app.request(
      "http://openbot.local/api/capabilities",
    );
    expect(capabilities.status).toBe(200);
    expect((await capabilities.json()).billing).toEqual({
      enabled: false,
      paid: false,
    });
  });
});

describe("MOD02 assembly: origin floor unchanged", () => {
  function appWithTrustedOrigin() {
    return buildApp({
      environment: testEnvironment({ TRUSTED_ORIGINS: TRUSTED_ORIGIN }),
    });
  }

  test("a trusted browser origin is echoed on /api/*", async () => {
    const response = await appWithTrustedOrigin().request(
      "http://openbot.local/api/capabilities",
      { headers: { origin: TRUSTED_ORIGIN } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      TRUSTED_ORIGIN,
    );
  });

  test("a preview-style untrusted origin gets no CORS grant", async () => {
    const response = await appWithTrustedOrigin().request(
      "http://openbot.local/api/capabilities",
      { headers: { origin: "https://preview.openbot.test" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(null);
  });

  test("a native client without an Origin header gets no CORS header either", async () => {
    const response = await appWithTrustedOrigin().request(
      "http://openbot.local/api/capabilities",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(null);
  });
});

describe("MOD02 assembly: health floors unchanged", () => {
  test("/health answers ok; /ready with no database wired is down, not echoing", async () => {
    const app = buildApp();
    const health = await app.request("http://openbot.local/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const ready = await app.request("http://openbot.local/ready");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "unavailable",
      database: "down",
    });
  });
});
