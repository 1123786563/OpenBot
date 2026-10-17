import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gte, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createAuditStore } from "../src/audit";
import {
  CREDIT_SERVICE_CREDENTIAL_KEY_ID,
  CREDIT_SERVICE_CREDENTIAL_KIND,
  CREDIT_SERVICE_CREDENTIAL_PROVIDER,
  createCreditServiceAuthenticator,
  creditProtocolRoutes,
  issueCreditServiceCredential,
  mintCreditServiceSecret,
  type CreditServiceVariables,
} from "../src/billing/credit-service-auth";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { auditEvents, botServices, credentials } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost #252 (06.1): the billing protocol's own service identity, on a real PostgreSQL.
 *
 * The billing protocol (Reserve/Status/Settle/Release) is not the Bot-service surface and not a
 * user surface. Its one legitimate caller is the deployment's Bifrost admission extension, holding
 * a credential of its own kind. The questions here are the ticket's own: an unauthenticated call,
 * a wrong credential, a VALID Bot service credential and an authenticated user session are all
 * refused — every refusal is one uniform body that says nothing about accounts, balances or
 * grants — and every call, refused or not, leaves one audit row that binds who called with what.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = randomBytes(32).toString("base64");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore,
});
const prefix = `b5-252-${randomUUID()}`;
/** Audit rows are append-only; every assertion below scopes itself to this run. */
const runStartedAt = new Date();

/**
 * The billing protocol surface under test. 06.2 mounts Reserve on this same factory; here the
 * probe route stands in for the guarded surface, exactly the way 04.2's smoke route does.
 */
const protocolApp = new Hono<{
  Variables: AppVariables & CreditServiceVariables;
}>();
protocolApp.route(
  "/api/credit-protocol",
  creditProtocolRoutes({ authenticate, auditStore }),
);

/**
 * The same protocol surface beside a user-session surface. The stand-in answers like the real
 * requireUser (gateway-admin-routes.test.ts precedent): a presented session cookie authenticates
 * the user, its absence is refused — so "the session is authenticated" is established on this
 * very app before the protocol door refuses the same request.
 */
function userSessionStandIn(
  role: "user" | "anonymous",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const cookie = context.req.header("cookie");
    if (role === "anonymous" || !cookie?.includes("ob_session=")) {
      return context.json({ error: "Authentication required." }, 401);
    }
    const actor: AuthenticatedActor = {
      id: `${prefix}-user`,
      email: `${prefix}@openbot.test`,
      role: "user",
    };
    context.set("actor", actor);
    await next();
  };
}

const sessionApp = new Hono<{
  Variables: AppVariables & CreditServiceVariables;
}>();
sessionApp.get("/api/user-probe", userSessionStandIn("user"), (context) =>
  context.json({ ok: true }),
);
sessionApp.route(
  "/api/credit-protocol",
  creditProtocolRoutes({ authenticate, auditStore }),
);

afterAll(async () => {
  await database
    .delete(credentials)
    .where(eq(credentials.kind, CREDIT_SERVICE_CREDENTIAL_KIND));
  await database
    .delete(credentials)
    .where(like(credentials.keyId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

/**
 * One observable refusal. Every rejection below must be THIS body and nothing else: exact object
 * equality, so a balance, a grant id, an available figure or any other account field in the
 * response fails the test instead of riding along.
 */
async function refusedResponse(
  response: Promise<Response> | Response,
): Promise<void> {
  const res = await response;
  const body = (await res.json()) as unknown;
  expect(res.status).toBe(401);
  expect(body).toEqual({
    error: "Credit service authentication failed.",
    code: "credit_service_auth_failed",
  });
}

/** The refused rows this run wrote, however many calls produced them. */
async function refusedRows() {
  return database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "credit_service.refused"),
        gte(auditEvents.createdAt, runStartedAt),
      ),
    );
}

test("a deployment with no credit service credential on file refuses, uniformly", async () => {
  // Order-independent: whatever an earlier run left behind, this test owns the unconfigured case.
  await database
    .delete(credentials)
    .where(eq(credentials.kind, CREDIT_SERVICE_CREDENTIAL_KIND));
  await refusedResponse(
    protocolApp.request("/api/credit-protocol", {
      headers: { authorization: `Bearer ${mintCreditServiceSecret()}` },
    }),
  );
  const rows = await refusedRows();
  const unconfigured = rows.filter(
    (row) => row.payload.reason === "unconfigured",
  );
  expect(unconfigured.length).toBe(1);
});

test("a call with no credential at all is refused the same way", async () => {
  await refusedResponse(
    protocolApp.request("/api/credit-protocol", { method: "POST" }),
  );
  const rows = await refusedRows();
  const missing = rows.filter((row) => row.payload.reason === "missing-header");
  expect(missing.length).toBe(1);
});

test("a valid Bot service credential is refused at the protocol door", async () => {
  const botId = `${prefix}-bot`;
  await registry.register({
    botId,
    displayName: "Auth Bot",
    kind: "external",
    capabilities: ["chat"],
  });
  const issued = await registry.credentials.issue(botId);
  // The credential really is a working Bot credential — it passes at its own door. The test's
  // point is that "valid Bot credential" and "trusted billing caller" are different questions.
  expect(await registry.authenticate(issued.secret)).toEqual({
    botId,
    status: "active",
  });
  await refusedResponse(
    protocolApp.request("/api/credit-protocol", {
      headers: { authorization: `Bearer ${issued.secret}` },
    }),
  );
});

test("an authenticated user session is refused at the protocol door", async () => {
  const sessionCookie = "ob_session=a-real-session-token";
  // On this app the same cookie IS an authenticated user session.
  const probe = await sessionApp.request("/api/user-probe", {
    headers: { cookie: sessionCookie },
  });
  expect(probe.status).toBe(200);
  // The protocol door does not take sessions: one uniform refusal, and nothing about accounts.
  await refusedResponse(
    sessionApp.request("/api/credit-protocol", {
      headers: { cookie: sessionCookie },
    }),
  );
});

test("the trusted gateway credential is the one caller that passes", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  const res = await protocolApp.request("/api/credit-protocol", {
    headers: { authorization: `Bearer ${issued.secret}` },
  });
  expect(res.status).toBe(200);
  expect((await res.json()) as unknown).toEqual({
    creditService: {
      kind: CREDIT_SERVICE_CREDENTIAL_KIND,
      provider: CREDIT_SERVICE_CREDENTIAL_PROVIDER,
      keyId: CREDIT_SERVICE_CREDENTIAL_KEY_ID,
    },
  });
  const rows = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "credit_service.called"),
        gte(auditEvents.createdAt, runStartedAt),
      ),
    );
  const called = rows.at(-1);
  expect(called).toBeDefined();
  // The row binds the proven caller identity with the request it came with.
  expect(called?.payload.method).toBe("GET");
  expect(called?.payload.path).toBe("/api/credit-protocol");
  expect(called?.payload.provider).toBe(CREDIT_SERVICE_CREDENTIAL_PROVIDER);
  expect(called?.payload.keyId).toBe(CREDIT_SERVICE_CREDENTIAL_KEY_ID);
});

test("a wrong credential is refused the same way", async () => {
  // A credential is now live (the test above issued it), so these are real mismatches against
  // it: well-shaped but never stored, and then garbage. Both are one refusal on the wire, and
  // the trail names both `mismatch`.
  await refusedResponse(
    protocolApp.request("/api/credit-protocol", {
      headers: { authorization: `Bearer ${mintCreditServiceSecret()}` },
    }),
  );
  await refusedResponse(
    protocolApp.request("/api/credit-protocol", {
      headers: { authorization: "Bearer not-even-ours" },
    }),
  );
  const rows = await refusedRows();
  const mismatch = rows.filter((row) => row.payload.reason === "mismatch");
  expect(mismatch.length).toBeGreaterThanOrEqual(2);
});

test("issuing again rotates: the previous secret dies on its very next call", async () => {
  const first = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  const alive = await protocolApp.request("/api/credit-protocol", {
    headers: { authorization: `Bearer ${first.secret}` },
  });
  expect(alive.status).toBe(200);

  const second = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  await refusedResponse(
    protocolApp.request("/api/credit-protocol", {
      headers: { authorization: `Bearer ${first.secret}` },
    }),
  );
  const rotated = await protocolApp.request("/api/credit-protocol", {
    headers: { authorization: `Bearer ${second.secret}` },
  });
  expect(rotated.status).toBe(200);
});

test("every refusal this run wrote stays within its vocabulary and names no account", async () => {
  // The tests above made exactly seven refusal calls: unconfigured(1), missing-header(1),
  // wrong credential(2), bot credential(1), user session(1), rotated-away secret(1). Each one
  // must have left exactly one row, and no row may say more than the reason and the request
  // shape — never a balance, a grant, a customer or a credential fragment.
  const rows = await refusedRows();
  for (const row of rows) {
    expect(Object.keys(row.payload).sort()).toEqual(
      ["method", "note", "path", "reason"].sort(),
    );
    expect(["unconfigured", "missing-header", "mismatch"]).toContain(
      row.payload.reason,
    );
    expect(row.initiatorKind).toBe("deployment");
  }
  expect(rows.length).toBe(7);
});
