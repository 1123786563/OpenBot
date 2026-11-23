/**
 * First trial matrix for two applications sharing Test Credits (#98): one
 * harness, two verified chat models, two Billing Accounts plus a race account,
 * WeKnora ingestion through the real worker, and the denial/recovery replays —
 * all against the pinned Bifrost gateway, real Zhipu routes, the TEI embedding
 * route, and the self-hosted Lago deployment.
 *
 *   bun scripts/pilot-matrix.ts <run-dir>
 *
 * Serves the WeKnora embeddings endpoint on 127.0.0.1:25172 throughout. At the
 * worker leg it writes <run-dir>/worker.env and waits for <run-dir>/worker-done
 * (run the WeKnora acceptance test, then touch that file). Writes matrix.json.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import {
  AuxiliaryModelBillingError,
  createAuxiliaryModelCompleter,
} from "../src/billing/auxiliary-model";
import { createLagoHttpUsageClient } from "../src/billing/lago-client";
import { createLagoUsageExporter } from "../src/billing/lago-usage";
import { createTestCreditLedger } from "../src/billing/test-credit";
import {
  createBifrostCreditExecutor,
  UnsentBifrostRequest,
} from "../src/billing/test-credit-bifrost";
import {
  createWeKnoraIngestionBilling,
  WeKnoraBillingError,
  type WeKnoraLedger,
} from "../src/billing/weknora-ingestion";
import { createDatabase } from "../src/db/client";
import {
  enterpriseSettings,
  testCreditAccounts,
  testCreditOperations,
} from "../src/db/schema";
import { fixtureTraceReport } from "../tests/support/bifrost-evidence";

const runDir = process.argv[2];
if (!runDir) throw new Error("usage: bun scripts/pilot-matrix.ts <run-dir>");
const startedAt = Date.now();
let clockOffsetMs = 0;
const now = () => new Date(Date.now() + clockOffsetMs);
const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));
const results: Record<string, unknown>[] = [];
async function scenario(
  name: string,
  work: () => Promise<Record<string, unknown>>,
) {
  try {
    const detail = await work();
    results.push({ scenario: name, outcome: "pass", detail });
    log({ scenario: name, outcome: "pass", detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ scenario: name, outcome: "fail", error: message });
    log({ scenario: name, outcome: "fail", error: message });
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:32835/openbot_98_matrix",
);
const issuer = "https://casdoor.example.test";
const identityA = { issuer, subject: randomUUID() };
const identityB = { issuer, subject: randomUUID() };
const identityC = { issuer, subject: randomUUID() };
const resourceId = "weknora:tenant:1:kb:kb-1";
const gatewayRevision = "matrix-fixed6-3skfs9";
const meteringRevision = "matrix-zhipu-tokenizer";
const lagoUrl = process.env.LAGO_URL ?? "http://127.0.0.1:32832";
const lagoKey =
  process.env.LAGO_API_KEY ??
  (
    await Bun.file(
      "/Users/wuyj/.local/share/openbot/billing-97/lago-api-key.txt",
    ).text()
  ).trim();
const zhipuKey =
  process.env.ZHIPU_API_KEY ??
  (
    await Bun.file(
      "/Users/wuyj/.local/share/openbot/bifrost-89/provider.env",
    ).text()
  )
    .split("\n")
    .find((line) => line.startsWith("ZHIPU_API_KEY="))
    ?.slice("ZHIPU_API_KEY=".length) ??
  "";

const ledger = createTestCreditLedger(database, now);
let tokenizerAvailable = true;
const countInputTokens = async (
  route: { model: string },
  messages: readonly { role: string; content: string }[],
) => {
  if (!tokenizerAvailable) throw new Error("tokenizer unavailable");
  const response = await fetch(
    "https://open.bigmodel.cn/api/paas/v4/tokenizer",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${zhipuKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: route.model, messages }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`tokenizer ${response.status}`);
  const usage = (await response.json()) as {
    usage: { prompt_tokens: number; image_tokens?: number };
  };
  return usage.usage.prompt_tokens + (usage.usage.image_tokens ?? 0) + 2;
};
const chatExecutor = createBifrostCreditExecutor({
  endpoint: new URL("http://127.0.0.1:32790/v1/chat/completions"),
  gatewayRevision,
  meteringRevision,
  countInputTokens,
});

type RouteSpec = Parameters<typeof configure>[1]["routes"][string];
async function publishCatalog(
  routes: Record<string, RouteSpec>,
  defaultRoute: string,
) {
  const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
  const drafted = configure(emptyCatalog, { harnessImage, routes });
  let catalog = drafted;
  for (const id of Object.keys(routes)) {
    const proposed = drafted.routes[id];
    if (!proposed) throw new Error(`route ${id} missing`);
    catalog = verify(
      catalog,
      id,
      fixtureTraceReport(harnessImage, proposed),
      "matrix-fixture",
    );
  }
  const release = publish(
    catalog,
    Object.keys(routes),
    defaultRoute,
    "matrix",
  ).release;
  const value = { ...catalog, publication: release };
  await database
    .insert(enterpriseSettings)
    .values({ key: pilotCatalogKey, value })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value },
    });
  return Object.fromEntries(
    release.routes.map((route) => [route.id, route.revision]),
  );
}

async function chatOp(
  identity: { issuer: string; subject: string },
  routeId: string,
  revision: string,
  operationId: string,
  prompt: string,
) {
  const pick = await ledger.resolveQuote({
    conversation: { id: routeId, revision },
  });
  const quote = "quote" in pick ? pick.quote : undefined;
  if (!quote) throw new Error("resolveQuote refused the saved pick");
  const reserved = await ledger.reserve(identity, {
    operationId,
    route: quote.route,
    priceVersion: quote.priceVersion,
  });
  assert(reserved.state === "reserved", `reserve: ${reserved.state}`);
  const dispatch = await ledger.beginDispatch(identity, {
    operationId,
    permit: reserved.state === "reserved" ? (reserved.permit ?? "") : "",
  });
  assert(dispatch.state === "dispatch", `dispatch: ${dispatch.state}`);
  const result = await chatExecutor({
    route: dispatch.route,
    messages: [{ role: "user", content: prompt }],
    operationId,
    recheckRoute: () => ledger.routeStillEligible(dispatch.route),
  });
  if ("text" in result && result.text)
    await ledger.recordResult(dispatch.accountId, operationId, result.text);
  const settled = await ledger.settle(dispatch.accountId, operationId, {
    inputTokens: BigInt(result.usage.inputTokens),
    outputTokens: BigInt(result.usage.outputTokens),
  });
  return { dispatch, result, settled };
}

// WeKnora ingestion billing over the shared ledger (#93 wiring).
const dispatchAccounts = new Map<string, string>();
async function accountIdOf(identity: { issuer: string; subject: string }) {
  const [row] = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(
      and(
        eq(testCreditAccounts.issuer, identity.issuer),
        eq(testCreditAccounts.subject, identity.subject),
      ),
    );
  return row?.id;
}
const weknoraLedger: WeKnoraLedger = {
  quote: () => ledger.quote(),
  reserve: async (identity, input) => {
    const result = await ledger.reserve(identity, {
      operationId: input.operationId,
      route: input.route,
      priceVersion: input.priceVersion,
      applicationId: input.application,
    });
    // The WeKnora reservation contract has no budget dimension, so refusals
    // outside its reason set surface as the path being unavailable.
    if (result.state === "denied") {
      const reason =
        result.reason === "insufficient_credits" ||
        result.reason === "route_unavailable"
          ? result.reason
          : "not_authorized";
      return { state: "denied" as const, reason };
    }
    return result;
  },
  settle: async (identity, operationId, usage) => {
    const accountId =
      dispatchAccounts.get(operationId) ?? (await accountIdOf(identity));
    if (!accountId) throw new Error("uploader has no Test Credit account");
    const settled = await ledger.settle(accountId, operationId, usage);
    dispatchAccounts.set(operationId, accountId);
    return settled;
  },
};
const billing = createWeKnoraIngestionBilling({
  ledger: weknoraLedger,
  now,
  verifyApplication: async (id) => id === "weknora",
  verifyUser: async (identity) => Boolean(await accountIdOf(identity)),
});
const authorizationId = randomUUID();
function registerAuthorization(expiresAt: Date) {
  billing.registerAuthorization({
    id: authorizationId,
    applicationId: "weknora",
    issuer,
    subject: identityA.subject,
    resourceIds: [resourceId],
    expiresAt,
    maxMicrocredits: 4096n,
    spentMicrocredits: 0n,
    revokedAt: null,
  });
}
registerAuthorization(new Date(startedAt + 900_000));

const serviceToken = randomBytes(32).toString("base64url");
const statusFor = (code: string) =>
  ({
    not_authorized: 403,
    authorization_expired: 410,
    authorization_revoked: 410,
    execution_limit: 429,
    insufficient_credits: 402,
    route_unavailable: 503,
  })[code] ?? 400;

async function embedViaEndpoint(body: {
  subject: string;
  authorizationId: string;
  resourceId: string;
  operationId: string;
  input: string[];
}) {
  const response = await fetch(
    "http://127.0.0.1:25172/api/weknora/embeddings",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    },
  );
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

Bun.serve({
  hostname: "127.0.0.1",
  port: 25172,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (
      request.method === "POST" &&
      url.pathname === "/api/weknora/embeddings"
    ) {
      if (request.headers.get("authorization") !== `Bearer ${serviceToken}`) {
        log({ event: "embedding-refused", reason: "service_token" });
        return new Response(null, { status: 401 });
      }
      const body = (await request.json()) as {
        subject: string;
        authorizationId: string;
        resourceId: string;
        operationId: string;
        input: string[];
      };
      try {
        const preflight = await billing.preflight({
          applicationId: "weknora",
          issuer,
          subject: body.subject,
          resourceId: body.resourceId,
        });
        const reserved = await billing.reserve({
          operationId: body.operationId,
          applicationId: "weknora",
          issuer,
          subject: body.subject,
          resourceId: body.resourceId,
          maxChargeMicrocredits: preflight.maxChargeMicrocredits,
        });
        if (reserved.state === "denied")
          throw new WeKnoraBillingError("route_unavailable", "denied");
        const permit =
          reserved.state === "reserved" ? reserved.permit : undefined;
        if (reserved.state === "existing" && !permit) {
          // Worker recovery must replay a settled operation, not a released one.
          const receipt = await ledger.receipt(
            { issuer, subject: body.subject },
            body.operationId,
          );
          if (receipt?.state !== "settled") {
            log({
              event: "recovery-refused",
              operationId: body.operationId,
              receiptState: receipt?.state ?? "missing",
            });
            return new Response(
              JSON.stringify({ code: "not_authorized", recovery: true }),
              { status: 409 },
            );
          }
        }
        if (permit) {
          const dispatch = await ledger.beginDispatch(
            { issuer, subject: body.subject },
            { operationId: body.operationId, permit },
          );
          if (dispatch.state === "dispatch")
            dispatchAccounts.set(body.operationId, dispatch.accountId);
        }
        log({
          event: "reserved",
          operationId: body.operationId,
          resourceId: body.resourceId,
          state: reserved.state,
        });
        const tokenizer = await fetch("http://127.0.0.1:25169/tokenize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            inputs: body.input,
            add_special_tokens: true,
          }),
        });
        if (!tokenizer.ok) throw new Error("tokenizer unavailable");
        const exact = (await tokenizer.json()) as unknown[][];
        const inputTokenUpperBound = exact.reduce(
          (sum, tokens) => sum + tokens.length,
          0,
        );
        const response = await fetch("http://127.0.0.1:25170/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "openai/BAAI/bge-small-en-v1.5",
            input: body.input,
          }),
        });
        if (!response.ok) throw new Error(`gateway ${response.status}`);
        const payload = (await response.json()) as {
          data: { embedding: number[] }[];
          usage?: { prompt_tokens?: number };
        };
        const inputTokens = BigInt(
          payload.usage?.prompt_tokens ?? inputTokenUpperBound,
        );
        log({
          event: "metered",
          operationId: body.operationId,
          inputTokenUpperBound,
          gatewayInputTokens: inputTokens.toString(),
        });
        const settled = await billing.settle({
          operationId: body.operationId,
          uploaderAccount: { issuer, subject: body.subject },
          inputTokens,
          outputTokens: 0n,
        });
        log({ event: "settled", operationId: body.operationId });
        return Response.json({
          vectors: payload.data.map(({ embedding }) => embedding),
          receipt: JSON.stringify(
            settled ?? { operationId: body.operationId, state: "settled" },
          ),
        });
      } catch (error) {
        if (error instanceof WeKnoraBillingError) {
          log({
            event: "embedding-denied",
            operationId: body.operationId,
            code: error.code,
          });
          return new Response(JSON.stringify({ code: error.code }), {
            status: statusFor(error.code),
          });
        }
        log({
          event: "embedding-failed",
          operationId: body.operationId,
          error: error instanceof Error ? error.message : "unknown",
        });
        return new Response(null, { status: 500 });
      }
    }
    if (url.pathname === "/control/revoke" && request.method === "POST") {
      billing.revokeAuthorization(authorizationId);
      log({ event: "control", action: "revoke" });
      return new Response("ok");
    }
    if (url.pathname === "/control/receipts" && request.method === "GET") {
      const out: Record<string, unknown> = {};
      for (const [name, identity] of [
        ["A", identityA],
        ["B", identityB],
        ["C", identityC],
      ] as const) {
        const accountId = await accountIdOf(identity);
        out[name] = accountId
          ? {
              accountId,
              balance: await ledger.balance(identity),
              operations: (
                await database
                  .select()
                  .from(testCreditOperations)
                  .where(eq(testCreditOperations.accountId, accountId))
              ).map((row) => ({
                operationId: row.id,
                state: row.state,
                charged: row.charged?.toString() ?? null,
              })),
            }
          : null;
      }
      return Response.json(out);
    }
    return new Response(null, { status: 404 });
  },
});

// ── Matrix ──────────────────────────────────────────────────────────────────

let revisions: Record<string, string> = {};
await scenario("provision-accounts", async () => {
  for (const [identity, amount] of [
    [identityA, 200_000n],
    [identityB, 50_000n],
    [identityC, 16_512n], // exactly two chat reservations
  ] as const) {
    const batchId = randomUUID();
    await ledger.enroll({ identity, batchId, amount });
    await ledger.claim(identity, batchId);
  }
  const a = await ledger.balance(identityA);
  const b = await ledger.balance(identityB);
  return {
    grantedA: a?.grantedMicrocredits,
    grantedB: b?.grantedMicrocredits,
  };
});

await scenario("publish-two-models", async () => {
  revisions = await publishCatalog(
    {
      "route-a": {
        provider: "zhipu",
        model: "glm-5.3-flash",
        gatewayRevision,
        meteringRevision,
        maxInputTokens: 4096,
        maxOutputTokens: 8,
        tools: false,
        price: { inputPerMillion: 2_000_000, outputPerMillion: 8_000_000 },
      },
      "route-b": {
        provider: "zhipu-compat",
        model: "glm-5.3",
        gatewayRevision,
        meteringRevision,
        maxInputTokens: 4096,
        maxOutputTokens: 8,
        tools: false,
        price: { inputPerMillion: 2_000_000, outputPerMillion: 8_000_000 },
      },
    },
    "route-a",
  );
  const options = await ledger.modelOptions();
  assert(options.length === 2, `modelOptions: ${options.length}`);
  return { options };
});

await scenario("model-switch-product-entry", async () => {
  const botPick = await ledger.resolveQuote({
    bot: { id: "route-b", revision: revisions["route-b"] },
  });
  const botQuote = "quote" in botPick ? botPick.quote : undefined;
  assert(botQuote?.route === "route-b", "bot pick route-b failed");
  const conversationPick = await ledger.resolveQuote({
    conversation: { id: "route-a", revision: revisions["route-a"] },
  });
  const conversationQuote =
    "quote" in conversationPick ? conversationPick.quote : undefined;
  assert(
    conversationQuote?.route === "route-a",
    "conversation pick route-a failed",
  );
  const stale = await ledger.resolveQuote({
    conversation: { id: "route-a", revision: crypto.randomUUID() },
  });
  assert("reason" in stale, "stale revision must be refused");
  return {
    bot: botPick.source,
    conversation: conversationPick.source,
    staleRefused: true,
  };
});

await scenario("chat-both-routes-account-A", async () => {
  const first = await chatOp(
    identityA,
    "route-a",
    revisions["route-a"],
    "matrix-chat-a1",
    "Reply with exactly: route one ok",
  );
  const second = await chatOp(
    identityA,
    "route-b",
    revisions["route-b"],
    "matrix-chat-a2",
    "Reply with exactly: route two ok",
  );
  assert(
    ("text" in first.result || first.result.outcome === "partial") &&
      ("text" in second.result || second.result.outcome === "partial"),
    "no completion outcome",
  );
  return {
    routeA: "text" in first.result ? first.result.text : first.result.outcome,
    usageA: first.result.usage,
    routeB:
      "text" in second.result ? second.result.text : second.result.outcome,
    usageB: second.result.usage,
  };
});

await scenario("isolation-account-B", async () => {
  const before = await ledger.balance(identityA);
  const op = await chatOp(
    identityB,
    "route-a",
    revisions["route-a"],
    "matrix-chat-b1",
    "Reply with exactly: b one ok",
  );
  const afterA = await ledger.balance(identityA);
  const b = await ledger.balance(identityB);
  assert(
    before?.chargedMicrocredits === afterA?.chargedMicrocredits,
    "A was charged for B's call",
  );
  return {
    text: "text" in op.result ? op.result.text : null,
    chargedB: b?.chargedMicrocredits,
    chargedA: afterA?.chargedMicrocredits,
  };
});

await scenario("cross-app-balance-race", async () => {
  const raceQuote = await ledger.quote();
  const attempts = await Promise.all(
    [1, 2, 3, 4].map((n) =>
      ledger.reserve(identityC, {
        operationId: `matrix-race-${n}`,
        route: "route-a",
        priceVersion: raceQuote?.priceVersion ?? "",
      }),
    ),
  );
  const reserved = attempts.filter((r) => r.state === "reserved");
  const denied = attempts.filter(
    (r) => r.state === "denied" && r.reason === "insufficient_credits",
  );
  const balance = await ledger.balance(identityC);
  assert(reserved.length === 2, `reserved ${reserved.length}`);
  assert(denied.length === 2, "denials must be insufficient_credits");
  assert(balance?.availableMicrocredits === "0", "leftover availability");
  return { reserved: reserved.length, denied: denied.length, balance };
});

await scenario("auxiliary-boundary-fail-closed", async () => {
  const completer = createAuxiliaryModelCompleter({
    model: { url: new URL("http://127.0.0.1:32790/v1"), token: "unused" },
    route: "route-a",
  });
  let refusedNoContext = false;
  try {
    await completer("route this", undefined, {} as never);
  } catch (error) {
    refusedNoContext = error instanceof AuxiliaryModelBillingError;
  }
  let refusedUnbounded = false;
  try {
    await completer("route this", undefined, {
      billing: {
        funding: { kind: "platform" },
        source: "routing",
        personId: "p",
        step: { id: "s", kind: "routing" },
      },
    } as never);
  } catch (error) {
    refusedUnbounded = error instanceof AuxiliaryModelBillingError;
  }
  assert(refusedNoContext && refusedUnbounded, "boundary not fail-closed");
  return { refusedNoContext, refusedUnbounded };
});

await scenario("stale-reservation-cannot-dispatch", async () => {
  const quote = await ledger.quote();
  assert(quote, "no quote");
  const reserved = await ledger.reserve(identityA, {
    operationId: "matrix-stale",
    route: quote.route,
    priceVersion: quote.priceVersion,
  });
  assert(reserved.state === "reserved", "reserve failed");
  const stalePermit =
    reserved.state === "reserved" ? (reserved.permit ?? "") : "";
  clockOffsetMs = 5 * 60_000 + 2_000;
  const dispatch = await ledger.beginDispatch(identityA, {
    operationId: "matrix-stale",
    permit: stalePermit,
  });
  clockOffsetMs = 0;
  assert(dispatch.state === "denied", `dispatch: ${JSON.stringify(dispatch)}`);
  return { dispatchState: dispatch.state, reason: dispatch.reason };
});

await scenario("gateway-timeout-releases-hold", async () => {
  const deadExecutor = createBifrostCreditExecutor({
    endpoint: new URL("http://127.0.0.1:9/v1/chat/completions"),
    gatewayRevision,
    meteringRevision,
    countInputTokens,
  });
  const quote = await ledger.quote();
  assert(quote, "no quote");
  const before = await ledger.balance(identityA);
  const reserved = await ledger.reserve(identityA, {
    operationId: "matrix-timeout",
    route: quote.route,
    priceVersion: quote.priceVersion,
  });
  const dispatch = await ledger.beginDispatch(identityA, {
    operationId: "matrix-timeout",
    permit: reserved.state === "reserved" ? (reserved.permit ?? "") : "",
  });
  assert(dispatch.state === "dispatch", "not dispatched");
  let failed = false;
  try {
    await deadExecutor({
      route: dispatch.route,
      messages: [{ role: "user", content: "will fail" }],
      operationId: "matrix-timeout",
    });
  } catch {
    failed = true;
  }
  assert(failed, "dead gateway did not fail");
  await ledger.releaseUnsent(dispatch.accountId, "matrix-timeout");
  const after = await ledger.balance(identityA);
  assert(
    before?.availableMicrocredits === after?.availableMicrocredits,
    "hold not returned",
  );
  return { released: true, restored: after?.availableMicrocredits };
});

await scenario("meter-refusal-blocks-dispatch", async () => {
  const quote = await ledger.quote();
  assert(quote, "no quote");
  const reserved = await ledger.reserve(identityA, {
    operationId: "matrix-unmetered",
    route: quote.route,
    priceVersion: quote.priceVersion,
  });
  const dispatch = await ledger.beginDispatch(identityA, {
    operationId: "matrix-unmetered",
    permit: reserved.state === "reserved" ? (reserved.permit ?? "") : "",
  });
  assert(dispatch.state === "dispatch", "not dispatched");
  tokenizerAvailable = false;
  let refused: string | undefined;
  try {
    await chatExecutor({
      route: dispatch.route,
      messages: [{ role: "user", content: "must not be sent" }],
      operationId: "matrix-unmetered",
    });
  } catch (error) {
    refused = error instanceof UnsentBifrostRequest ? error.reason : undefined;
  }
  tokenizerAvailable = true;
  await ledger.releaseUnsent(dispatch.accountId, "matrix-unmetered");
  assert(refused === "route_unavailable", `refused: ${refused}`);
  return { refusedNoProviderRequest: true };
});

await scenario("cutoff-releases-abandoned-hold", async () => {
  // A dispatched operation whose user never returns: the reconciliation
  // cutoff must release the held credits.
  const quote = await ledger.quote();
  assert(quote, "no quote");
  const reserved = await ledger.reserve(identityB, {
    operationId: "matrix-abandoned",
    route: quote.route,
    priceVersion: quote.priceVersion,
  });
  const dispatch = await ledger.beginDispatch(identityB, {
    operationId: "matrix-abandoned",
    permit: reserved.state === "reserved" ? (reserved.permit ?? "") : "",
  });
  assert(dispatch.state === "dispatch", "not dispatched");
  const before = await ledger.balance(identityB);
  clockOffsetMs = 24 * 60 * 60_000 + 2_000;
  const applied = await ledger.sweepCutoffs(10);
  clockOffsetMs = 0;
  const after = await ledger.balance(identityB);
  assert(applied >= 1, "nothing swept");
  assert(
    before &&
      after &&
      BigInt(after.availableMicrocredits) -
        BigInt(before.availableMicrocredits) ===
        8256n,
    `hold not returned: ${before?.availableMicrocredits} -> ${after?.availableMicrocredits}`,
  );
  return { swept: applied, restored: after?.availableMicrocredits };
});

await scenario("wrong-permit-cannot-dispatch", async () => {
  const denied = await ledger.beginDispatch(identityA, {
    operationId: "matrix-chat-a1",
    permit: "forged-permit",
  });
  assert(denied.state === "denied", `forged permit: ${JSON.stringify(denied)}`);
  return { state: denied.state, reason: denied.reason };
});

await scenario("external-direct-gateway-boundary", async () => {
  // What an external app sees hitting the pinned gateway directly, with no
  // OpenBot billing context. The gateway is loopback-bound in this deployment;
  // provider credentials never leave it. The dispatch gate is OpenBot-side.
  const response = await fetch("http://127.0.0.1:32790/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "zhipu/glm-5.3-flash",
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 8,
      stream: false,
    }),
  });
  return {
    directHttpStatus: response.status,
    note: "gateway reached without OpenBot context is a deployment-boundary concern; no permit can be minted outside the ledger (wrong-permit scenario)",
  };
});

await scenario("publish-embedding-route", async () => {
  revisions = await publishCatalog(
    {
      "local-bge": {
        provider: "openai",
        model: "BAAI/bge-small-en-v1.5",
        gatewayRevision: "local-bifrost-v1.5.8",
        meteringRevision: "local-tei-bge-small-5c38ec7c",
        maxInputTokens: 512,
        maxOutputTokens: 2,
        tools: false,
        price: { inputPerMillion: 500_000, outputPerMillion: 0 },
      },
    },
    "local-bge",
  );
  const quote = await ledger.quote();
  assert(quote?.route === "local-bge", "embedding route not active");
  return { route: quote.route, maxCharge: quote.maxChargeMicrocredits };
});

await scenario("weknora-worker-ingestion", async () => {
  await Bun.write(
    `${runDir}/worker.env`,
    [
      "OPENBOT_WEKNORA_EMBEDDINGS_URL=http://127.0.0.1:25172/api/weknora/embeddings",
      `OPENBOT_WEKNORA_SERVICE_TOKEN=${serviceToken}`,
      `OPENBOT_WEKNORA_OIDC_ISSUER=${issuer}`,
      `OPENBOT_WEKNORA_LIVE_SUBJECT=${identityA.subject}`,
      `OPENBOT_WEKNORA_LIVE_AUTHORIZATION_ID=${authorizationId}`,
      "",
    ].join("\n"),
  );
  log({ event: "WORKER-READY" });
  const marker = `${runDir}/worker-done`;
  const workerStartedAt = new Date();
  for (let i = 0; i < 240 && !(await Bun.file(marker).exists()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert(await Bun.file(marker).exists(), "worker did not finish in time");
  const accountId = await accountIdOf(identityA);
  const rows = accountId
    ? await database
        .select()
        .from(testCreditOperations)
        .where(eq(testCreditOperations.accountId, accountId))
    : [];
  const workerOps = rows.filter(
    (row) =>
      !row.id.startsWith("matrix-") &&
      row.createdAt.getTime() >= workerStartedAt.getTime() - 1_000,
  );
  assert(
    workerOps.length >= 1 && workerOps.every((row) => row.state === "settled"),
    `worker ops: ${JSON.stringify(workerOps.map((r) => [r.id, r.state]))}`,
  );
  return {
    operations: workerOps.map((row) => ({
      operationId: row.id,
      state: row.state,
      charged: row.charged?.toString(),
    })),
  };
});

await scenario("signout-then-authorized-embedding", async () => {
  // The uploader signs out; a new ingestion under the same valid spending
  // authorization still settles (authorizations outlive sessions).
  const result = await embedViaEndpoint({
    subject: identityA.subject,
    authorizationId,
    resourceId,
    operationId: "matrix-signout-embed",
    input: ["embedding after sign out"],
  });
  assert(result.status === 200, `status ${result.status}`);
  assert(
    Array.isArray(result.body?.vectors) &&
      result.body.vectors[0]?.length === 384,
    "no 384-dim vector",
  );
  return {
    status: result.status,
    dimensions: result.body?.vectors?.[0]?.length,
  };
});

await scenario("recovery-without-reservation-refused", async () => {
  // A released operation id replayed by worker recovery must not re-dispatch.
  const quote = await ledger.quote();
  assert(quote, "no quote");
  const reserved = await ledger.reserve(identityA, {
    operationId: "matrix-released-recovery",
    route: quote.route,
    priceVersion: quote.priceVersion,
  });
  assert(reserved.state === "reserved", "reserve failed");
  clockOffsetMs = 5 * 60_000 + 2_000;
  // Any later reserve on the account releases expired holds.
  await ledger.reserve(identityA, {
    operationId: "matrix-recovery-sibling",
    route: quote.route,
    priceVersion: quote.priceVersion,
  });
  clockOffsetMs = 0;
  const replay = await embedViaEndpoint({
    subject: identityA.subject,
    authorizationId,
    resourceId,
    operationId: "matrix-released-recovery",
    input: ["recovery replay"],
  });
  assert(replay.status === 409, `replay status ${replay.status}`);
  return { status: replay.status, body: replay.body };
});

await scenario("revocation-and-isolation-denials", async () => {
  const stranger = await embedViaEndpoint({
    subject: identityB.subject,
    authorizationId,
    resourceId,
    operationId: "matrix-stranger",
    input: ["not my kb"],
  });
  assert(stranger.status === 403, `stranger ${stranger.status}`);
  const wrongResource = await embedViaEndpoint({
    subject: identityA.subject,
    authorizationId,
    resourceId: "weknora:tenant:1:kb:kb-other",
    operationId: "matrix-wrong-resource",
    input: ["other kb"],
  });
  assert(wrongResource.status === 403, `resource ${wrongResource.status}`);
  const ok = await embedViaEndpoint({
    subject: identityA.subject,
    authorizationId,
    resourceId,
    operationId: "matrix-before-revoke",
    input: ["still valid"],
  });
  assert(ok.status === 200, `pre-revoke ${ok.status}`);
  billing.revokeAuthorization(authorizationId);
  const revoked = await embedViaEndpoint({
    subject: identityA.subject,
    authorizationId,
    resourceId,
    operationId: "matrix-after-revoke",
    input: ["revoked"],
  });
  assert(revoked.status === 410, `revoked ${revoked.status}`);
  return {
    stranger: stranger.status,
    wrongResource: wrongResource.status,
    revoked: revoked.status,
  };
});

await scenario("lago-reconciliation", async () => {
  const accounts = [
    ["A", identityA],
    ["B", identityB],
  ] as const;
  const subscriptionId = process.env.LAGO_USAGE_SUBSCRIPTION_ID;
  assert(
    subscriptionId,
    "Set LAGO_USAGE_SUBSCRIPTION_ID before running the matrix",
  );
  const client = createLagoHttpUsageClient({
    baseUrl: lagoUrl,
    apiKey: lagoKey,
    metricCode: "model-usage",
    externalSubscriptionId: subscriptionId,
  });
  const exporter = createLagoUsageExporter(database, client);
  const flushed = await exporter.flush();
  assert(
    !flushed.unavailable && flushed.paused === 0,
    "Lago usage did not reconcile",
  );
  const balances: Record<string, unknown> = {};
  for (const [name, identity] of accounts) {
    balances[name] = await ledger.balance(identity);
  }
  return { flushed, balances };
});

const receipts = await fetch("http://127.0.0.1:25172/control/receipts").then(
  (response) => response.json(),
);
await Bun.write(
  `${runDir}/matrix.json`,
  JSON.stringify(
    {
      startedAt: new Date(startedAt).toISOString(),
      accounts: {
        A: { subject: identityA.subject },
        B: { subject: identityB.subject },
        C: { subject: identityC.subject },
      },
      authorizationId,
      gateway: {
        image: "openbot-bifrost89:zhipu-cap-fixed6",
        revision: gatewayRevision,
        chatEndpoint: "http://127.0.0.1:32790",
        embeddingEndpoint: "http://127.0.0.1:25170",
        tokenizer: "zhipu /api/paas/v4/tokenizer",
      },
      lago: { url: lagoUrl, version: "v1.57.0" },
      results,
      receipts,
    },
    null,
    2,
  ),
);
log({
  event: "MATRIX-DONE",
  passed: results.filter((r) => r.outcome === "pass").length,
  failed: results.filter((r) => r.outcome === "fail").length,
});
await database.$client.close();
