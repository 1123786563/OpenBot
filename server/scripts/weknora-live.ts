/**
 * Live acceptance for WeKnora ingestion billing (#93): serves the WeKnora
 * worker's managed-embeddings endpoint on top of the real Test Credit ledger
 * and the published Bifrost/TEI embedding route, so the real Go worker can
 * upload a TXT and be charged through a Spending Authorization.
 *
 *   bun scripts/weknora-live.ts <run-dir>
 *
 * Writes <run-dir>/worker.env for the WeKnora worker test and keeps serving
 * until killed. Control routes drive the denial scenarios:
 *   POST /control/revoke  POST /control/expire  GET /control/receipts
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
import { createTestCreditLedger } from "../src/billing/test-credit";
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
if (!runDir) throw new Error("usage: bun scripts/weknora-live.ts <run-dir>");
const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:32835/openbot_93_weknora",
);
const startedAt = Date.now();
const now = () => new Date(startedAt + (Date.now() - startedAt));
const issuer = "https://casdoor.example.test";
const subject = randomUUID();
const resourceId = "weknora:tenant:1:kb:kb-1";
const authorizationId = randomUUID();
const gatewayRevision = "local-bifrost-v1.5.8";
const meteringRevision = "local-tei-bge-small-5c38ec7c";
const gatewayModel = "openai/BAAI/bge-small-en-v1.5";
const routeId = "local-bge";

const ledger = createTestCreditLedger(database, now);
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
  // Uploader attribution: the identity must be a real enrolled account.
  verifyUser: async (identity) => Boolean(await accountIdOf(identity)),
});

// Seed the pilot catalog with the live embedding route, verified by the
// fixture report. Reservations below charge against this publication only.
const drafted = configure(emptyCatalog, {
  harnessImage: `agent-langgraph-agui@sha256:${"b".repeat(64)}`,
  routes: {
    [routeId]: {
      provider: "openai",
      model: "BAAI/bge-small-en-v1.5",
      gatewayRevision,
      meteringRevision,
      maxInputTokens: 512,
      maxOutputTokens: 2,
      tools: false,
      price: { inputPerMillion: 500_000, outputPerMillion: 0 },
    },
  },
});
const proposed = drafted.routes[routeId];
if (!proposed) throw new Error("fixture route missing");
const verified = verify(
  drafted,
  routeId,
  fixtureTraceReport(drafted.harnessImage ?? "", proposed),
  "local-fixture",
);
const { catalog } = publish(verified, [routeId], routeId, "local-fixture");
await database
  .insert(enterpriseSettings)
  .values({ key: pilotCatalogKey, value: catalog })
  .onConflictDoNothing();

// The uploader's Test Credit account and the WeKnora Spending Authorization.
const batchId = randomUUID();
await ledger.enroll({ identity: { issuer, subject }, batchId, amount: 8192n });
await ledger.claim({ issuer, subject }, batchId);
function registerAuthorization(expiresAt: Date) {
  billing.registerAuthorization({
    id: authorizationId,
    applicationId: "weknora",
    issuer,
    subject,
    resourceIds: [resourceId],
    expiresAt,
    maxMicrocredits: 4096n,
    spentMicrocredits: 0n,
    revokedAt: null,
  });
}
registerAuthorization(new Date(startedAt + 600_000));

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

async function embeddings(input: string[]) {
  // Exact input metering through the same tokenizer the provider runs.
  const tokenizer = await fetch("http://127.0.0.1:25169/tokenize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: input, add_special_tokens: true }),
  });
  if (!tokenizer.ok) throw new Error("tokenizer unavailable");
  const exact = (await tokenizer.json()) as unknown[][];
  const inputTokenUpperBound = exact.reduce(
    (sum, tokens) => sum + tokens.length,
    0,
  );
  const response = await fetch("http://127.0.0.1:25170/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-unused",
      "x-openbot-operation-id": "",
    },
    body: JSON.stringify({ model: gatewayModel, input }),
  });
  if (!response.ok)
    throw new Error(`gateway rejected embeddings: ${response.status}`);
  const body = (await response.json()) as {
    data: { embedding: number[] }[];
    usage?: { prompt_tokens?: number };
  };
  return {
    vectors: body.data.map(({ embedding }) => embedding),
    inputTokens: BigInt(body.usage?.prompt_tokens ?? inputTokenUpperBound),
    inputTokenUpperBound,
  };
}

Bun.serve({
  hostname: "127.0.0.1",
  port: 25171,
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
        if (reserved.permit) {
          const dispatch = await ledger.beginDispatch(
            { issuer, subject: body.subject },
            { operationId: body.operationId, permit: reserved.permit },
          );
          if (dispatch.state === "dispatch")
            dispatchAccounts.set(body.operationId, dispatch.accountId);
        }
        log({
          event: "reserved",
          operationId: body.operationId,
          resourceId: body.resourceId,
          authorizationId: body.authorizationId,
          state: reserved.state,
        });
        const result = await embeddings(body.input);
        log({
          event: "metered",
          operationId: body.operationId,
          inputTokenUpperBound: result.inputTokenUpperBound,
          gatewayInputTokens: result.inputTokens.toString(),
        });
        const settled = await billing.settle({
          operationId: body.operationId,
          uploaderAccount: { issuer, subject: body.subject },
          inputTokens: result.inputTokens,
          outputTokens: 0n,
        });
        log({ event: "settled", operationId: body.operationId });
        return Response.json({
          vectors: result.vectors,
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
    if (url.pathname === "/control/expire" && request.method === "POST") {
      registerAuthorization(new Date(startedAt - 1_000));
      log({ event: "control", action: "expire" });
      return new Response("ok");
    }
    if (url.pathname === "/control/receipts" && request.method === "GET") {
      const accountId = await accountIdOf({ issuer, subject });
      const rows = accountId
        ? await database
            .select()
            .from(testCreditOperations)
            .where(eq(testCreditOperations.accountId, accountId))
        : [];
      return Response.json({
        accountId,
        operations: rows.map((row) => ({
          operationId: row.id,
          state: row.state,
          inputTokens: row.inputTokens?.toString() ?? null,
          outputTokens: row.outputTokens?.toString() ?? null,
          chargedMicrocredits: row.charged?.toString() ?? null,
          reservedMicrocredits: row.reserved.toString(),
        })),
        balance: await ledger.balance({ issuer, subject }),
      });
    }
    return new Response(null, { status: 404 });
  },
});

await Bun.write(
  `${runDir}/worker.env`,
  [
    "OPENBOT_WEKNORA_EMBEDDINGS_URL=http://127.0.0.1:25171/api/weknora/embeddings",
    `OPENBOT_WEKNORA_SERVICE_TOKEN=${serviceToken}`,
    `OPENBOT_WEKNORA_OIDC_ISSUER=${issuer}`,
    `OPENBOT_WEKNORA_LIVE_SUBJECT=${subject}`,
    `OPENBOT_WEKNORA_LIVE_AUTHORIZATION_ID=${authorizationId}`,
    "",
  ].join("\n"),
);
log({ event: "ready", resourceId, subject, authorizationId });
