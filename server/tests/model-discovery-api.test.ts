import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { randomBytes, randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { BotServiceAuthenticator } from "../src/bot-services/auth";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import type {
  BotServiceRecord,
  BotServiceStore,
} from "../src/bot-services/store";
import { createCredentialStore } from "../src/credentials";
import { createDatabase, type Database } from "../src/db/client";
import {
  credentials,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
} from "../src/db/schema";
import {
  createEnterpriseGatewayCatalogStore,
  type CatalogEntry,
  normalizeGatewayModelCatalog,
} from "../src/gateway/catalog";
import {
  createGatewayModelCapabilityFilterService,
  type GatewayModelCapabilityFilterService,
  MODEL_EXCLUSION_REASONS,
} from "../src/gateway/model-capability-filter";
import { createModelDiscoveryRoutes } from "../src/gateway/model-discovery-routes";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
  type PriceSnapshotAppendInput,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import {
  createEnterpriseGatewayModelScopeStore,
  createGatewayModelScopeService,
} from "../src/gateway/model-scope";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 03.11 (#233, AC09/AC19) — the bot-facing model discovery API's
 * public boundary. An authenticated Bot service asks "which models may I use,
 * what do they cost to display, and why is a capability-matching model not
 * offered right now" — and nothing else: no administrator configuration, no
 * credential, no other person's preference ever leaves this route.
 *
 * The response is the frozen downstream contract (consumed by 05.3's key
 * issuance and 07.x's pre-call validation), so its field names are exactly
 * 03.10's display contract (`bot.botId`, `bot.displayName`, `selectable`,
 * `ref`, `priceStatus`) and exactly 03.8's filter result (`selectable`,
 * `excluded`, `reasonCode`) — nothing new is coined here. One deliberate
 * presentation narrowing: a ref whose capability the Bot never declared is
 * never named at all — the whole answer only ever contains refs whose
 * capability the Bot's own registry declaration matches, so
 * `model_capability_mismatch` cannot appear in the reason vocabulary a
 * consumer sees. The judgment itself is never re-derived: 03.8's filter is
 * the only decider, asked with the authenticated Bot's own registry
 * declaration mapped through 03.10's table, attributed as requester kind
 * `bot_service`.
 *
 * What only this file can prove:
 *
 * - the door is 04.2's service guard and nothing else: a bare, malformed,
 *   wrongly-secreted or stranger-botId presentation is one uniform 401 that
 *   says nothing about whether a botId exists, and an unwired door is one
 *   tagged 503 on every path and method (fail closed in both directions);
 * - the answer over a real catalog, real open scopes and real price
 *   snapshots is exactly the capability-matching, open, price-determinable
 *   set plus the capability-matching non-offered set with its one reason
 *   each — a chat bot never sees an image-only model anywhere in the body;
 * - the body is whitelist-shaped: exact key sets at every level, price
 *   statuses only `known`/`free` (03.8 guarantees no unknown is ever
 *   offered), reasons only the 03.8 closed vocabulary minus mismatch — and
 *   planted administrator evidence (an open-scope reason, an actor email,
 *   snapshot provenance) never appears;
 * - a Bot declaring no mappable capability (async only) is refused with the
 *   displayable code, not an empty list dressed as an answer.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** A fresh deployment key per run: ciphertext from an earlier run must not verify. */
const encryptionKey = randomBytes(32).toString("base64");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore,
});
const catalogStore = createEnterpriseGatewayCatalogStore(database);
const priceStore = createEnterpriseGatewayPriceSnapshotStore(database);

/** Monotonic test clock so append-only rows keep a strict order. */
let tick = Date.now();

/** Per-run provider prefix: price snapshots are append-only, so runs isolate by ref. */
const runId = randomUUID().slice(0, 8);
const botPrefix = `b5-233-${runId}`;
const provider = `dsc-${runId}`;
/** Where the planted administrator evidence lives — asserted absent from every body. */
const openReasonMarker = `b5-233-review-${runId}`;
const adminEmailMarker = `b5-233-admin-${runId}@openbot.test`;

function nextTickIso(): string {
  tick += 1_000;
  return new Date(tick).toISOString();
}

function chatRef(model: string) {
  return { provider, model, capability: "chat" as const };
}

/** The eight wire-priced dimensions, fully known — the shape 03.3 calls fully priced. */
function fullyPricedDims(): PriceSnapshotDims {
  return mapPriceDims({
    id: `${provider}/alpha`,
    pricing: {
      prompt: "0.0000025000",
      completion: "0.0000100000",
      request: "0.0",
      image: "0.0036130000",
      web_search: "0.0250000000",
      internal_reasoning: "0.0001000000",
      input_cache_read: "0.0000012500",
      input_cache_write: "0.0000031250",
    },
  });
}

/** Every necessary dimension priced at exactly zero — the shape 03.3 calls free. */
function freeDims(): PriceSnapshotDims {
  return mapPriceDims({
    id: `${provider}/delta-free`,
    pricing: {
      prompt: "0.0",
      completion: "0.0",
      request: "0.0",
      image: "0.0",
      web_search: "0.0",
      internal_reasoning: "0.0",
      input_cache_read: "0.0",
      input_cache_write: "0.0",
    },
  });
}

/** No price source at all — every necessary dimension unknown. */
function unpricedDims(): PriceSnapshotDims {
  return mapPriceDims({ id: `${provider}/gamma` });
}

function appendInput(
  ref: { provider: string; model: string; capability: string },
  dims: PriceSnapshotDims,
): PriceSnapshotAppendInput {
  return {
    ref: ref as PriceSnapshotAppendInput["ref"],
    dims,
    fetchedAt: nextTickIso(),
    source: "gateway:/v1/models",
    configVersion: 7,
    rateVersion: null,
  };
}

/** Replace the whole last-good catalog through the real normalizer. */
async function syncCatalog(
  manifests: { id: string; methods: string[] }[],
): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = normalizeGatewayModelCatalog({
    data: manifests.map((manifest) => ({
      id: manifest.id,
      supported_methods: manifest.methods,
    })),
  }).entries;
  await catalogStore.replaceCatalog({
    entries,
    record: {
      fetchedAt: nextTickIso(),
      source: "gateway:/v1/models",
      rawItemCount: manifests.length,
      configVersion: 7,
    },
  });
  return entries;
}

function scopeService() {
  return createGatewayModelScopeService({
    catalog: catalogStore,
    priceSnapshots: priceStore,
    scopes: createEnterpriseGatewayModelScopeStore(database),
    audit: auditStore,
    now: () => {
      tick += 1_000;
      return new Date(tick);
    },
  });
}

/** The real 03.8 filter over the real stores — the only decider this route may have. */
const filter: GatewayModelCapabilityFilterService =
  createGatewayModelCapabilityFilterService({
    catalog: catalogStore,
    priceSnapshots: priceStore,
    scopes: scopeService(),
  });

/** The route under test: the real 04.2 door, the real 03.8 filter behind it. */
const discovery = createModelDiscoveryRoutes(
  { authenticate: registry.authenticate, botServices: registry },
  { selectable: () => filter, priceSnapshots: () => priceStore },
);

async function registeredBot(
  suffix: string,
  capabilities: BotServiceRecord["capabilities"],
): Promise<string> {
  const botId = `${botPrefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: "Discovery Bot",
    kind: "external",
    capabilities,
  });
  return botId;
}

async function credentialedBot(
  suffix: string,
  capabilities: BotServiceRecord["capabilities"],
) {
  const botId = await registeredBot(suffix, capabilities);
  const issued = await registry.credentials.issue(botId);
  return { botId, secret: issued.secret };
}

beforeAll(async () => {
  // The catalog and scope tables are replaceable/updatable; clear them so the
  // suite starts from a known-empty directory. Price snapshots and audit rows
  // are append-only — the per-run provider prefix isolates instead.
  await database.delete(gatewayModelOpenScopes);
  await database.delete(gatewayModelCatalogRefs);
  await syncCatalog([
    { id: `${provider}/alpha`, methods: ["chat"] }, // priced + opened → selectable, known
    { id: `${provider}/beta`, methods: ["chat"] }, // priced, never opened → model_not_open
    { id: `${provider}/gamma`, methods: ["chat"] }, // opened, newest basis unknown → model_price_unknown
    { id: `${provider}/delta-free`, methods: ["chat"] }, // all-zero basis + opened → selectable, free
    { id: `${provider}/epsilon`, methods: ["image"] }, // image-only: never named to a chat bot
  ]);
  const pricedRefs = [
    chatRef("alpha"),
    chatRef("beta"),
    chatRef("gamma"),
    chatRef("delta-free"),
    { provider, model: "epsilon", capability: "image" },
  ];
  await priceStore.appendSnapshots(
    pricedRefs.map((ref) => appendInput(ref, fullyPricedDims())),
  );
  await priceStore.appendSnapshots([
    appendInput(chatRef("delta-free"), freeDims()),
  ]);

  const scope = scopeService();
  // The planted evidence: the open actions carry a review reason and an actor
  // identity that must never leave the discovery route.
  for (const ref of [chatRef("alpha"), chatRef("delta-free")]) {
    const opened = await scope.openModel({
      ref,
      reason: openReasonMarker,
      actor: { userId: "admin-1", email: adminEmailMarker },
    });
    expect(opened.ok).toBe(true);
  }
  // Opening gamma needs a determinable price at open time; the newest basis
  // turns unknown only afterwards — 03.8's defense-in-depth case.
  const openedGamma = await scope.openModel({
    ref: chatRef("gamma"),
    reason: openReasonMarker,
    actor: { userId: "admin-1", email: adminEmailMarker },
  });
  expect(openedGamma.ok).toBe(true);
  await priceStore.appendSnapshots([
    appendInput(chatRef("gamma"), unpricedDims()),
  ]);
});

afterAll(async () => {
  await database
    .delete(credentials)
    .where(like(credentials.keyId, `${botPrefix}%`));
  await database.$client.close();
});

/** Sort by model name so assertions never depend on the store's row order. */
function byModel<T extends { ref: { model: string } }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.ref.model.localeCompare(b.ref.model));
}

describe("the door is the 04.2 service guard, and nothing else", () => {
  test("an unauthenticated, malformed or wrongly-secreted presentation is one uniform 401", async () => {
    const { botId, secret } = await credentialedBot("door", ["chat"]);
    const wrong = `obot_bsvc_${botId}~${randomBytes(32).toString("base64url")}`;
    const stranger = `obot_bsvc_${botPrefix}-ghost~${randomBytes(32).toString("base64url")}`;
    const responses = await Promise.all([
      discovery.request("/"),
      discovery.request("/", {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      }),
      discovery.request("/", {
        headers: { authorization: `Bearer ${wrong}` },
      }),
      discovery.request("/", {
        headers: { authorization: `Bearer ${stranger}` },
      }),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (let i = 0; i < responses.length; i += 1) {
      expect(responses[i].status).toBe(401);
      expect(responses[i].headers.get("cache-control")).toBe("no-store");
      const body = JSON.parse(bodies[i]) as Record<string, unknown>;
      expect(body.code).toBe("bot_service_auth_failed");
    }
    // One refusal, byte for byte — no answer distinguishes a wrong secret
    // from a botId nobody registered.
    expect(new Set(bodies).size).toBe(1);
    // The valid secret, by contrast, opens the read.
    const ok = await discovery.request("/", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(ok.status).toBe(200);
  });

  test("an unwired door answers one tagged 503 on every path and method", async () => {
    const closed = createModelDiscoveryRoutes(undefined);
    const responses = await Promise.all([
      closed.request("/"),
      closed.request("/anything"),
      closed.request("/", { method: "POST" }),
      closed.request("/", {
        headers: { authorization: "Bearer obot_bsvc_someone~secret" },
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Bot service authentication is not available.",
        code: "bot_service_unavailable",
      });
    }
  });

  test("absent gateway services answer a tagged 503 behind a valid credential", async () => {
    const botId = await registeredBot("nogateway", ["chat"]);
    const authenticate: BotServiceAuthenticator = async () => ({
      botId,
      status: "active",
    });
    const app = createModelDiscoveryRoutes(
      {
        authenticate,
        botServices: registry,
      },
      { selectable: () => undefined, priceSnapshots: () => undefined },
    );
    const response = await app.request("/", {
      headers: { authorization: "Bearer whatever" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Model discovery is not available.",
      code: "model_discovery_unavailable",
    });
  });
});

describe("the read is 03.8's answer, presented under 03.10's names", () => {
  test("the filter is asked with the Bot's own mapped declaration and bot_service attribution", async () => {
    let asked: { capabilities: unknown; requester: unknown } | undefined;
    const fakeRef = {
      provider: "fakeco",
      model: "fake-chat",
      capability: "chat",
    };
    const app = createModelDiscoveryRoutes(
      {
        authenticate: (async () => ({
          botId: "audio-bot",
          status: "active",
        })) satisfies BotServiceAuthenticator,
        botServices: {
          getBotService: async () =>
            ({
              botId: "audio-bot",
              displayName: "Audio Bot",
              kind: "builtin",
              capabilities: ["audio"],
              status: "active",
              createdAt: new Date(0),
              updatedAt: new Date(0),
            }) satisfies BotServiceRecord,
        } satisfies Pick<BotServiceStore, "getBotService">,
      },
      {
        selectable: () => ({
          listSelectableModels: async (capabilities, requester) => {
            asked = { capabilities, requester };
            return { selectable: [fakeRef], excluded: [] };
          },
        }),
        priceSnapshots: () => ({
          listLatestPriceSnapshots: async () => [
            {
              ref: fakeRef,
              snapshotVersion: 1,
              dims: mapPriceDims({ id: "fakeco/fake-chat" }),
              classification: { status: "free" },
              fetchedAt: "2026-10-15T00:00:00.000Z",
              source: "gateway:/v1/models",
              configVersion: 7,
              rateVersion: null,
            },
          ],
        }),
      },
    );
    const response = await app.request("/", {
      headers: { authorization: "Bearer whatever" },
    });
    expect(response.status).toBe(200);
    // An `audio` registry declaration asks the filter for speech and
    // transcription (03.10's table, verbatim) and attributes the ask to the
    // Bot service itself (03.8's requester vocabulary) — never to a user.
    expect(asked).toEqual({
      capabilities: ["speech", "transcription"],
      requester: { kind: "bot_service", id: "audio-bot" },
    });
    expect(await response.json()).toEqual({
      bot: { botId: "audio-bot", displayName: "Audio Bot" },
      selectable: [{ ref: fakeRef, priceStatus: "free" }],
      excluded: [],
    });
  });

  test("a chat bot's discovery answer over the real catalog, scopes and prices", async () => {
    const { botId, secret } = await credentialedBot("chat-answer", ["chat"]);
    const response = await discovery.request("/", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      bot: Record<string, unknown>;
      selectable: { ref: Record<string, unknown>; priceStatus: string }[];
      excluded: { ref: Record<string, unknown>; reasonCode: string }[];
    };

    // The offered set: exactly the capability-matching, open, priced models,
    // each with the price display status the picker contract freezes. A
    // chat bot sees its chat models — never the image-only one, not even as
    // an exclusion (its own declaration already tells it that).
    expect(body.bot).toEqual({ botId, displayName: "Discovery Bot" });
    expect(byModel(body.selectable)).toEqual([
      {
        ref: { provider, model: "alpha", capability: "chat" },
        priceStatus: "known",
      },
      {
        ref: { provider, model: "delta-free", capability: "chat" },
        priceStatus: "free",
      },
    ]);
    // The not-offered set, with one closed-vocabulary reason each: never
    // opened, and priced-then-unpriced. The image-only ref is named nowhere.
    expect(byModel(body.excluded)).toEqual([
      {
        ref: { provider, model: "beta", capability: "chat" },
        reasonCode: "model_not_open",
      },
      {
        ref: { provider, model: "gamma", capability: "chat" },
        reasonCode: "model_price_unknown",
      },
    ]);
    const rendered = JSON.stringify(body);
    expect(rendered).not.toContain("epsilon");
    expect(rendered).not.toContain("image");
    expect(rendered).not.toContain("model_capability_mismatch");
  });

  test("the body is whitelist-shaped at every level — the frozen downstream contract", async () => {
    const { secret } = await credentialedBot("shape", ["chat"]);
    const response = await discovery.request("/", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["bot", "excluded", "selectable"]);
    expect(Object.keys(body.bot as object).sort()).toEqual([
      "botId",
      "displayName",
    ]);
    const allowedReasons = MODEL_EXCLUSION_REASONS.filter(
      (reason) => reason !== "model_capability_mismatch",
    );
    for (const entry of body.selectable as {
      ref: Record<string, unknown>;
      priceStatus: string;
    }[]) {
      expect(Object.keys(entry).sort()).toEqual(["priceStatus", "ref"]);
      expect(Object.keys(entry.ref).sort()).toEqual([
        "capability",
        "model",
        "provider",
      ]);
      // 03.8 never offers an indeterminable price, so the display status a
      // consumer can observe here is `known` or `free` — never `unknown`,
      // never `unmapped` (structure makes "unknown offered" unrepresentable).
      expect(["known", "free"]).toContain(entry.priceStatus);
    }
    for (const entry of body.excluded as {
      ref: Record<string, unknown>;
      reasonCode: string;
    }[]) {
      expect(Object.keys(entry).sort()).toEqual(["reasonCode", "ref"]);
      expect(Object.keys(entry.ref).sort()).toEqual([
        "capability",
        "model",
        "provider",
      ]);
      expect(allowedReasons).toContain(entry.reasonCode);
    }
  });

  test("no administrator evidence, credential or provenance rides in the body", async () => {
    const { secret } = await credentialedBot("leak", ["chat"]);
    const response = await discovery.request("/", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(200);
    const rendered = await response.text();
    // Planted through the open-scope actions above: the review reason and the
    // administrator actor identity live one layer below this route and must
    // never surface through it.
    expect(rendered).not.toContain(openReasonMarker);
    expect(rendered).not.toContain(adminEmailMarker);
    // Snapshot provenance: the sync's source constant, config version,
    // fetched-at and rate-version columns are internal configuration.
    expect(rendered).not.toContain("gateway:/v1/models");
    expect(rendered).not.toMatch(
      /"configVersion"|"fetchedAt"|"source"|"snapshotVersion"|"rateVersion"|"reason"|"actor"/,
    );
    // And no credential-shaped field of any kind.
    expect(rendered).not.toMatch(
      /secret|credential|password|apikey|api_key|encryption|privatekey|token/i,
    );
  });

  test("a bot with no mappable capability is refused with the displayable code", async () => {
    const { secret } = await credentialedBot("async-only", ["async"]);
    const response = await discovery.request("/", {
      headers: { authorization: `Bearer ${secret}` },
    });
    // `async` names a delivery mode, not a catalog capability: the answer is
    // one explicit refusal, never an empty list dressed as "no models exist".
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The bot declares no capability the model catalog can offer.",
      code: "bot_capabilities_unmappable",
    });
  });
});
