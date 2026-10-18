import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { createAuditStore } from "../src/audit";
import { createDatabase, type Database } from "../src/db/client";
import {
  type CatalogEntry,
  createEnterpriseGatewayCatalogStore,
  normalizeGatewayModelCatalog,
} from "../src/gateway/catalog";
import {
  createEnterpriseGatewayModelScopeStore,
  createGatewayModelScopeService,
  type GatewayModelScopeService,
} from "../src/gateway/model-scope";
import {
  type ModelExclusionReason,
  MODEL_EXCLUSION_REASONS,
  createGatewayModelCapabilityFilterService,
  type GatewayModelCapabilityFilterService,
} from "../src/gateway/model-capability-filter";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  type PriceSnapshotAppendInput,
  type PriceSnapshotDims,
  mapPriceDims,
} from "../src/gateway/price-snapshot";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 03.8 (#230, AC06/AC09/Q4) — the database half of the bot capability
 * filter, over a real PostgreSQL on TEST_DATABASE_URL (tests/support/database.ts
 * refuses the live database).
 *
 * What only this file can prove:
 *
 * - a chat bot's selectable list never contains a pure image model, however
 *   open and however priced it is (Q4: 按能力筛选);
 * - a model the administrator never opened, and a model whose latest price
 *   basis turned unknown after opening, are both kept out of the list — each
 *   with its one reason code;
 * - the freshness seam excludes with `model_catalog_stale` when it refuses
 *   and excludes nothing when it is absent (03.6 plugs in here later);
 * - the result carries nothing but refs and reason codes: no scope reason,
 *   no operator identity, no upstream bytes — markers planted in all three
 *   places never appear in the answer.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const catalogStore = createEnterpriseGatewayCatalogStore(database);
const priceStore = createEnterpriseGatewayPriceSnapshotStore(database);
const auditStore = createAuditStore(database);

/** Monotonic test clock so append-only rows keep a strict order. */
let tick = Date.now();

function nextId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function chatRef(provider: string, model = "gpt-4o") {
  return { provider, model, capability: "chat" as const };
}

/** The eight wire-priced dimensions, fully known — the shape 03.3 calls fully priced. */
function fullyPricedDims(): PriceSnapshotDims {
  return mapPriceDims({
    id: "openai/gpt-4o",
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

/** No price source at all — every necessary dimension unknown. */
function unpricedDims(): PriceSnapshotDims {
  return mapPriceDims({ id: "openai/gpt-4o" });
}

function appendInput(
  ref: ReturnType<typeof chatRef>,
  dims: PriceSnapshotDims,
): PriceSnapshotAppendInput {
  tick += 1_000;
  return {
    ref,
    dims,
    fetchedAt: new Date(tick).toISOString(),
    source: "gateway:/v1/models",
    configVersion: 7,
    rateVersion: null,
  };
}

/** Replace the whole last-good catalog through the real normalizer. */
async function syncCatalog(
  manifests: {
    id: string;
    methods: string[];
    extraRaw?: Record<string, unknown>;
  }[],
) {
  tick += 1_000;
  const entries: CatalogEntry[] = manifests.flatMap((manifest) =>
    normalizeGatewayModelCatalog({
      data: [
        {
          id: manifest.id,
          supported_methods: manifest.methods,
          ...(manifest.extraRaw ?? {}),
        },
      ],
    }).entries,
  );
  await catalogStore.replaceCatalog({
    entries,
    record: {
      fetchedAt: new Date(tick).toISOString(),
      source: "gateway:/v1/models",
      rawItemCount: manifests.length,
      configVersion: 7,
    },
  });
  return entries;
}

async function priceAll(
  refs: ReturnType<typeof chatRef>[],
  dims: PriceSnapshotDims,
) {
  await priceStore.appendSnapshots(refs.map((ref) => appendInput(ref, dims)));
}

function scopeService(): GatewayModelScopeService {
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

function filterService(options: { fresh?: () => boolean } = {}) {
  return createGatewayModelCapabilityFilterService({
    catalog: catalogStore,
    priceSnapshots: priceStore,
    scopes: scopeService(),
    ...(options.fresh === undefined
      ? {}
      : { isCatalogFresh: options.fresh }),
  });
}

async function openAll(refs: ReturnType<typeof chatRef>[]) {
  const scope = scopeService();
  for (const ref of refs) {
    const opened = await scope.openModel({
      ref,
      reason: "reviewed pricing",
      actor: { userId: "admin-1", email: "admin@openbot.test" },
    });
    expect(opened.ok).toBe(true);
  }
}

function reasonOf(
  result: Awaited<ReturnType<GatewayModelCapabilityFilterService["listSelectableModels"]>>,
  provider: string,
): ModelExclusionReason | undefined {
  return result.excluded.find(
    (entry) => entry.ref.provider === provider,
  )?.reasonCode;
}

beforeAll(async () => {
  // The catalog and scope tables are replaceable/updatable; clear them so the
  // suite starts from a known-empty directory. Price snapshots and audit rows
  // are append-only — unique providers isolate instead.
  const { gatewayModelOpenScopes, gatewayModelCatalogRefs } = await import(
    "../src/db/schema"
  );
  await database.delete(gatewayModelOpenScopes);
  await database.delete(gatewayModelCatalogRefs);
});

afterAll(async () => {
  await database.$client.close();
});

describe("capability matching (聊天 Bot 不拿到纯图像模型)", () => {
  test("a chat bot is offered the open chat model and never the open, fully-priced image-only model", async () => {
    const chatProvider = nextId("flt-chat");
    const imageProvider = nextId("flt-image");
    const multiProvider = nextId("flt-multi");
    await syncCatalog([
      { id: `${chatProvider}/gpt-4o`, methods: ["chat"] },
      { id: `${imageProvider}/dalle`, methods: ["image"] },
      // One upstream model, two capabilities: two refs, judged separately.
      { id: `${multiProvider}/omni`, methods: ["chat", "image"] },
    ]);
    const chatModel = chatRef(chatProvider);
    const imageModel = { ...chatRef(imageProvider, "dalle"), capability: "image" as const };
    const multiChat = chatRef(multiProvider, "omni");
    const multiImage = { ...chatRef(multiProvider, "omni"), capability: "image" as const };
    await priceAll([chatModel, imageModel, multiChat, multiImage], fullyPricedDims());
    await openAll([chatModel, imageModel, multiChat, multiImage]);

    const result = await filterService().listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });

    // The chat ref survives; neither image ref can serve a chat bot.
    // The store orders refs by (provider, model, capability): providers were
    // chosen so flt-chat < flt-image < flt-multi regardless of UUID suffix.
    expect(result.selectable).toEqual([chatModel, multiChat]);
    expect(result.excluded.map((entry) => entry.ref)).toEqual([
      imageModel,
      multiImage,
    ]);
    expect(reasonOf(result, imageProvider)).toBe("model_capability_mismatch");
    expect(reasonOf(result, multiProvider)).toBe("model_capability_mismatch");
  });

  test("an unknown-capability ref can never match a declared bot capability", async () => {
    const provider = nextId("flt-unknown-cap");
    await syncCatalog([
      { id: `${provider}/quantum`, methods: ["quantum_flummox"] },
    ]);
    const result = await filterService().listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });
    expect(result.selectable).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.ref.capability).toBe("unknown");
    expect(result.excluded[0]?.reasonCode).toBe("model_capability_mismatch");
  });
});

describe("open scope and price state (未开放、价格未知不出现在可选列表)", () => {
  test("a matching, fully-priced model no administrator opened is excluded as not open", async () => {
    const provider = nextId("flt-unopened");
    await syncCatalog([{ id: `${provider}/gpt-4o`, methods: ["chat"] }]);
    await priceAll([chatRef(provider)], fullyPricedDims());

    const result = await filterService().listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });

    expect(result.selectable).toEqual([]);
    expect(reasonOf(result, provider)).toBe("model_not_open");
  });

  test("a model with no price snapshot is not determinable and is excluded", async () => {
    const provider = nextId("flt-unmapped");
    await syncCatalog([{ id: `${provider}/gpt-4o`, methods: ["chat"] }]);
    // Priced? No. Opened? Also impossible — but the answer must be the
    // administrator's reason first: not open.
    const result = await filterService().listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });
    expect(reasonOf(result, provider)).toBe("model_not_open");

    // Now the administrator opens it (03.7 refuses an unknown price, so this
    // needs a priced basis first), and the price basis later turns unknown:
    // the filter must catch it on the price reason, not the scope reason.
    await priceAll([chatRef(provider)], fullyPricedDims());
    await openAll([chatRef(provider)]);
    await priceStore.appendSnapshots([
      appendInput(chatRef(provider), unpricedDims()),
    ]);
    const afterTurn = await filterService().listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });
    expect(reasonOf(afterTurn, provider)).toBe("model_price_unknown");
    expect(afterTurn.selectable).toEqual([]);
  });
});

describe("the freshness seam (目录过期)", () => {
  test("when the freshness gate refuses, survivors are excluded as catalog stale", async () => {
    const provider = nextId("flt-stale");
    await syncCatalog([{ id: `${provider}/gpt-4o`, methods: ["chat"] }]);
    await priceAll([chatRef(provider)], fullyPricedDims());
    await openAll([chatRef(provider)]);

    const stale = filterService({ fresh: () => false });
    const result = await stale.listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });
    expect(result.selectable).toEqual([]);
    expect(reasonOf(result, provider)).toBe("model_catalog_stale");

    // The same directory without the gate (03.6 not yet delivered): nothing
    // is excluded for staleness — the module never guesses freshness.
    const fresh = filterService();
    const ungated = await fresh.listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });
    expect(ungated.selectable).toEqual([chatRef(provider)]);
  });
});

describe("the result carries nothing sensitive (不泄露管理配置或凭据)", () => {
  test("markers planted in the scope reason, the operator identity and the raw upstream bytes never appear", async () => {
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    const provider = nextId("flt-secret");
    await syncCatalog([
      {
        id: `${provider}/gpt-4o`,
        methods: ["chat"],
        extraRaw: {
          internal_note: `raw-upstream-bytes-${marker}`,
          admin_hint: `admin-config-${marker}`,
        },
      },
    ]);
    await priceAll([chatRef(provider)], fullyPricedDims());
    const scope = scopeService();
    const opened = await scope.openModel({
      ref: chatRef(provider),
      reason: `classified-reason-${marker}`,
      actor: { userId: "admin-1", email: `admin-${marker}@openbot.test` },
    });
    expect(opened.ok).toBe(true);

    const result = await filterService().listSelectableModels(["chat"], {
      kind: "user",
      id: "user-1",
    });
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(marker);
    expect(wire).not.toContain(`gateway_model_open_scopes`);
    expect(wire).not.toContain(`postgres`);

    // Selectable entries are bare refs; excluded entries are ref + code —
    // exactly these keys, nothing else.
    for (const ref of result.selectable) {
      expect(Object.keys(ref).sort()).toEqual([
        "capability",
        "model",
        "provider",
      ]);
    }
    for (const entry of result.excluded) {
      expect(Object.keys(entry).sort()).toEqual(["reasonCode", "ref"]);
      expect(Object.keys(entry.ref).sort()).toEqual([
        "capability",
        "model",
        "provider",
      ]);
      expect(MODEL_EXCLUSION_REASONS.includes(entry.reasonCode)).toBe(true);
    }
  });
});
