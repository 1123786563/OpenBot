import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createAuditStore } from "../src/audit";
import { createDatabase, type Database } from "../src/db/client";
import {
  type CatalogEntry,
  createEnterpriseGatewayCatalogStore,
  normalizeGatewayModelCatalog,
} from "../src/gateway/catalog";
import {
  createGatewayModelCapabilityFilterService,
  type GatewayModelCapabilityFilterService,
} from "../src/gateway/model-capability-filter";
import {
  createEnterpriseGatewayModelPreferenceStore,
  createGatewayModelPreferenceService,
  type EffectiveModelResolution,
  type GatewayModelPreferenceService,
  MODEL_PREFERENCE_SCOPES,
  type ModelPreferenceRecord,
  type ModelPreferenceScope,
} from "../src/gateway/model-preference";
import {
  createEnterpriseGatewayModelScopeStore,
  createGatewayModelScopeService,
  type GatewayModelScopeService,
} from "../src/gateway/model-scope";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
  type PriceSnapshotAppendInput,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { rejectionOf } from "./support/pg-errors";

/*
 * Bifrost 03.9 (#231, AC09/Q16) — the user's model preference layers, over a real
 * PostgreSQL on TEST_DATABASE_URL (tests/support/database.ts refuses the live
 * database) and through the REAL 03.8 capability filter (never a stand-in).
 *
 * What only this file can prove:
 *
 * - the three layers resolve in the order 全局默认 → 该 Bot 默认 → 当前会话选择,
 *   越具体越优先, and a layer with no stored preference falls through to the next
 *   coarser one — while a layer WITH a preference is answered as-is (Q16: the
 *   caller owns the unavailable-model error; resolution never silently switches);
 * - a write whose ModelRef is outside the requester's selectable list is refused
 *   with one fixed code and writes nothing — never a silent re-selection;
 * - a conversation selection touches only its own (user, bot, conversation) cell:
 *   global and bot defaults stay exactly as they were, and other users, other
 *   bots and other conversations read their own layers;
 * - the database itself refuses a row whose scope and identity columns disagree,
 *   so no future writer can smuggle a malformed layer past the service.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const catalogStore = createEnterpriseGatewayCatalogStore(database);
const priceStore = createEnterpriseGatewayPriceSnapshotStore(database);
const auditStore = createAuditStore(database);
const preferenceStore = createEnterpriseGatewayModelPreferenceStore(database);

/** Monotonic test clock so append-only rows keep a strict order. */
let tick = Date.now();

function nextId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function chatRef(model: string, provider = "prefco") {
  return { provider, model, capability: "chat" as const };
}

/** The eight wire-priced dimensions, fully known — the shape 03.3 calls fully priced. */
function fullyPricedDims(): PriceSnapshotDims {
  return mapPriceDims({
    id: "prefco/pref-chat",
    pricing: {
      prompt: "0.0000025000",
      completion: "0.0000100000",
      request: "0.0",
      image: "0.0",
      web_search: "0.0",
      internal_reasoning: "0.0",
      input_cache_read: "0.0",
      input_cache_write: "0.0",
    },
  });
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
  manifests: { id: string; methods: string[] }[],
): Promise<CatalogEntry[]> {
  tick += 1_000;
  const entries: CatalogEntry[] = manifests.flatMap(
    (manifest) =>
      normalizeGatewayModelCatalog({
        data: [{ id: manifest.id, supported_methods: manifest.methods }],
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

/** The REAL 03.8 filter — the write path must consume it verbatim, never a stub. */
function filterService(): GatewayModelCapabilityFilterService {
  return createGatewayModelCapabilityFilterService({
    catalog: catalogStore,
    priceSnapshots: priceStore,
    scopes: scopeService(),
  });
}

function preferenceService(): GatewayModelPreferenceService {
  return createGatewayModelPreferenceService({
    preferences: preferenceStore,
    selectable: filterService(),
  });
}

const CHAT_BOT_CAPABILITIES = ["chat"] as const;

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

/**
 * The directory every test starts from: two selectable chat models, and one
 * chat model excluded for each non-capability reason — never opened, never
 * priced — plus a pure image model the chat bot can never be offered.
 */
const SELECTABLE_CHAT = "pref-chat";
const SELECTABLE_SECOND = "pref-second";
const CLOSED_CHAT = "pref-closed";
const UNPRICED_CHAT = "pref-unpriced";
const IMAGE_ONLY = "pref-image";

beforeAll(async () => {
  // The catalog and scope tables are replaceable/updatable; clear them so the
  // suite starts from a known-empty directory. Price snapshots and audit rows
  // are append-only — the prefco provider namespace isolates instead.
  const { gatewayModelOpenScopes, gatewayModelCatalogRefs } = await import(
    "../src/db/schema"
  );
  await database.delete(gatewayModelOpenScopes);
  await database.delete(gatewayModelCatalogRefs);

  await syncCatalog([
    { id: `prefco/${SELECTABLE_CHAT}`, methods: ["chat"] },
    { id: `prefco/${SELECTABLE_SECOND}`, methods: ["chat"] },
    { id: `prefco/${CLOSED_CHAT}`, methods: ["chat"] },
    { id: `prefco/${UNPRICED_CHAT}`, methods: ["chat"] },
    { id: `prefco/${IMAGE_ONLY}`, methods: ["image"] },
  ]);
  const pricedRefs = [
    chatRef(SELECTABLE_CHAT),
    chatRef(SELECTABLE_SECOND),
    chatRef(CLOSED_CHAT),
    chatRef(UNPRICED_CHAT),
    { provider: "prefco", model: IMAGE_ONLY, capability: "image" as const },
  ];
  for (const ref of pricedRefs) {
    await priceStore.appendSnapshots([appendInput(ref, fullyPricedDims())]);
  }
  await openAll([
    chatRef(SELECTABLE_CHAT),
    chatRef(SELECTABLE_SECOND),
    chatRef(UNPRICED_CHAT),
    { provider: "prefco", model: IMAGE_ONLY, capability: "image" as const },
  ]);
  // The defense-in-depth case 03.8 names: opened while fully priced, the newest
  // snapshot then turned unknown. The filter must answer model_price_unknown for
  // it, which is the detail the preference write refuses with below.
  await priceStore.appendSnapshots([
    appendInput(
      chatRef(UNPRICED_CHAT),
      mapPriceDims({ id: "prefco/pref-chat" }),
    ),
  ]);
});

afterAll(async () => {
  await database.$client.close();
});

function sourceOf(resolution: EffectiveModelResolution) {
  if (resolution.status !== "resolved") {
    throw new Error(
      `Expected a resolved preference, got status ${resolution.status}.`,
    );
  }
  return resolution;
}

describe("三层覆盖优先级 (全局默认 → 该 Bot 默认 → 当前会话)", () => {
  test("没有任何偏好时解析结果如实为 unset", async () => {
    const user = nextId("user");
    const resolution = await preferenceService().resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    expect(resolution).toEqual({ status: "unset" });
  });

  test("只设全局默认时生效来源是 global", async () => {
    const user = nextId("user");
    const written = await preferenceService().setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    expect(written.ok).toBe(true);

    const resolution = await preferenceService().resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("global");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_CHAT));
  });

  // The picker's read has no session: GET /api/model-selection passes no
  // conversationId, and the route hands "" through. An empty session is "no
  // conversation layer to read", never a malformed identity — asking the store
  // for one throws and the route answers 503, which is how this screen died.
  test("不带会话 id 时不读会话层，按下一层如实回答", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const resolution = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("global");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_CHAT));
  });

  test("Bot 默认覆盖全局默认", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const resolution = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("bot");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_SECOND));
  });

  test("会话选择覆盖 Bot 默认", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const resolution = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("conversation");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_CHAT));
  });

  /*
   * Bifrost 03.10 (#232) — the regression review-231's F3 handed here: a stored
   * preference whose model later becomes unavailable is answered AS STORED, on
   * the layer that holds it. Q16 is explicit that unavailability is a visible
   * error or a re-selection — resolution falling through to a coarser layer
   * would silently switch the person's model, the one behavior this module
   * must not grow. The caller (03.10's picker, 06.2's admission) owns the
   * availability verdict.
   */
  test("存量偏好所指模型被关闭后仍按存储回答原层级，不回落也不换模型", async () => {
    // A dedicated model, so the shared fixture other tests read stays intact.
    const f3Model = "pref-f3";
    await syncCatalog([
      { id: `prefco/${SELECTABLE_CHAT}`, methods: ["chat"] },
      { id: `prefco/${SELECTABLE_SECOND}`, methods: ["chat"] },
      { id: `prefco/${CLOSED_CHAT}`, methods: ["chat"] },
      { id: `prefco/${UNPRICED_CHAT}`, methods: ["chat"] },
      { id: `prefco/${IMAGE_ONLY}`, methods: ["image"] },
      { id: `prefco/${f3Model}`, methods: ["chat"] },
    ]);
    const f3Ref = chatRef(f3Model);
    await priceStore.appendSnapshots([appendInput(f3Ref, fullyPricedDims())]);
    await openAll([f3Ref]);

    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: f3Ref,
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    // The selected model becomes unavailable: the administrator closes it.
    const closed = await scopeService().closeModel({
      ref: f3Ref,
      reason: "review withdrawn",
      actor: { userId: "admin-1", email: "admin@openbot.test" },
    });
    expect(closed.ok).toBe(true);

    // The resolution answers the stored ref and its own layer — never the
    // coarser global default that happens to sit underneath it.
    const resolution = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("conversation");
    expect(answered.ref).toEqual(f3Ref);

    // And the filter's own verdict names the reason: the model is closed.
    const selection = await filterService().listSelectableModels(
      CHAT_BOT_CAPABILITIES,
      { kind: "user", id: user },
    );
    expect(
      selection.excluded.find(
        (entry) =>
          entry.ref.model === f3Model && entry.ref.provider === "prefco",
      )?.reasonCode,
    ).toBe("model_not_open");
  });

  test("同 user+bot 的其他会话回落到 Bot 默认", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const otherConversation = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-2",
    });
    const answered = sourceOf(otherConversation);
    expect(answered.source).toBe("bot");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_SECOND));
  });

  test("只设会话选择时它直接覆盖全局默认", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const resolution = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("conversation");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_SECOND));
  });
});

describe("非法偏好写入拒绝 (只接受可选列表内的 ModelRef)", () => {
  test("未开放模型被拒绝且不落行", async () => {
    const user = nextId("user");
    const refused = await preferenceService().setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(CLOSED_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the closed model write should refuse");
    expect(refused.reasonCode).toBe("model_preference_ref_not_selectable");
    expect(refused.detail).toBe("model_not_open");

    const stored = await preferenceStore.getPreference({
      userId: user,
      scope: "bot",
      botId: "bot-1",
    });
    expect(stored).toBeUndefined();
  });

  test("能力不符的模型被拒绝", async () => {
    const user = nextId("user");
    const refused = await preferenceService().setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: { provider: "prefco", model: IMAGE_ONLY, capability: "image" },
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the image ref write should refuse");
    expect(refused.reasonCode).toBe("model_preference_ref_not_selectable");
    expect(refused.detail).toBe("model_capability_mismatch");
  });

  test("价格未知的模型被拒绝", async () => {
    const user = nextId("user");
    const refused = await preferenceService().setGlobalDefault({
      userId: user,
      ref: chatRef(UNPRICED_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the unpriced model write should refuse");
    expect(refused.reasonCode).toBe("model_preference_ref_not_selectable");
    expect(refused.detail).toBe("model_price_unknown");
  });

  test("不在目录里的模型被拒绝且没有排除细节可给", async () => {
    const user = nextId("user");
    const refused = await preferenceService().setGlobalDefault({
      userId: user,
      ref: { provider: "nowhere", model: "ghost", capability: "chat" },
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the uncataloged ref write should refuse");
    expect(refused.reasonCode).toBe("model_preference_ref_not_selectable");
    expect(refused.detail).toBeUndefined();
  });

  test("拒绝之后旧偏好原样保留 (不静默改选)", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    const refused = await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(CLOSED_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    expect(refused.ok).toBe(false);

    const resolution = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("bot");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_CHAT));
  });

  test("空的 Bot 能力集无法构造可选列表, 写入被拒绝", async () => {
    const user = nextId("user");
    // The 03.8 filter refuses an empty capability set as a caller bug (TypeError);
    // the write must surface that rejection, never swallow it into a silent success.
    expect(
      preferenceService().setGlobalDefault({
        userId: user,
        ref: chatRef(SELECTABLE_CHAT),
        botCapabilities: [],
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("会话覆盖隔离 (会话选择只影响该会话)", () => {
  test("会话选择不改变全局或 Bot 默认", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    const globalBefore = await preferenceStore.getPreference({
      userId: user,
      scope: "global",
    });
    const botBefore = await preferenceStore.getPreference({
      userId: user,
      scope: "bot",
      botId: "bot-1",
    });

    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const globalAfter = await preferenceStore.getPreference({
      userId: user,
      scope: "global",
    });
    const botAfter = await preferenceStore.getPreference({
      userId: user,
      scope: "bot",
      botId: "bot-1",
    });
    expect(globalAfter).toEqual(globalBefore);
    expect(botAfter).toEqual(botBefore);
  });

  test("其他用户的同名会话读到自己的层", async () => {
    const user = nextId("user");
    const stranger = nextId("user");
    const service = preferenceService();
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const resolution = await service.resolveEffectiveModel({
      userId: stranger,
      botId: "bot-1",
      conversationId: "conv-1",
    });
    expect(resolution).toEqual({ status: "unset" });
  });

  test("同一用户其他 Bot 的同名会话不被波及", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const resolution = await service.resolveEffectiveModel({
      userId: user,
      botId: "bot-2",
      conversationId: "conv-1",
    });
    const answered = sourceOf(resolution);
    expect(answered.source).toBe("global");
    expect(answered.ref).toEqual(chatRef(SELECTABLE_CHAT));
  });

  test("重写会话选择只影响该会话单元格", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const rewritten = sourceOf(
      await service.resolveEffectiveModel({
        userId: user,
        botId: "bot-1",
        conversationId: "conv-1",
      }),
    );
    expect(rewritten.ref).toEqual(chatRef(SELECTABLE_SECOND));

    const untouched = sourceOf(
      await service.resolveEffectiveModel({
        userId: user,
        botId: "bot-1",
        conversationId: "conv-2",
      }),
    );
    expect(untouched.source).toBe("bot");
    expect(untouched.ref).toEqual(chatRef(SELECTABLE_SECOND));
  });

  test("覆盖 Bot 默认不改变全局默认", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    await service.setBotDefault({
      userId: user,
      botId: "bot-1",
      ref: chatRef(SELECTABLE_SECOND),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });

    const global = await preferenceStore.getPreference({
      userId: user,
      scope: "global",
    });
    expect(global?.ref).toEqual(chatRef(SELECTABLE_CHAT));
  });
});

describe("形状非法的写入是调用方错误 (TypeError)", () => {
  test("Bot 默认缺 botId", async () => {
    expect(
      preferenceService().setBotDefault({
        userId: "user-1",
        botId: "",
        ref: chatRef(SELECTABLE_CHAT),
        botCapabilities: CHAT_BOT_CAPABILITIES,
      }),
    ).rejects.toThrow(TypeError);
  });

  test("会话选择缺 conversationId", async () => {
    expect(
      preferenceService().setConversationSelection({
        userId: "user-1",
        botId: "bot-1",
        conversationId: "",
        ref: chatRef(SELECTABLE_CHAT),
        botCapabilities: CHAT_BOT_CAPABILITIES,
      }),
    ).rejects.toThrow(TypeError);
  });

  test("未知 scope 无法构造", () => {
    // The scope vocabulary is closed at the type level; this pins it at runtime.
    expect(MODEL_PREFERENCE_SCOPES).toEqual(["global", "bot", "conversation"]);
    const scopes: readonly ModelPreferenceScope[] = MODEL_PREFERENCE_SCOPES;
    expect(scopes).not.toContain("workspace");
  });
});

describe("数据库防线 (scope 与身份列一致由 CHECK 强制)", () => {
  test("conversation 行缺 conversation_id 被拒绝", async () => {
    const rejection = await rejectionOf(() =>
      database.$client.unsafe(
        `INSERT INTO gateway_model_preferences
           (user_id, scope, bot_id, conversation_id, provider, model, capability)
         VALUES ('check-user', 'conversation', 'bot-1', '', 'prefco', 'pref-chat', 'chat')`,
      ),
    );
    expect(rejection.code).toBe("23514");
  });

  test("未知 capability 被拒绝", async () => {
    const rejection = await rejectionOf(() =>
      database.$client.unsafe(
        `INSERT INTO gateway_model_preferences
           (user_id, scope, bot_id, conversation_id, provider, model, capability)
         VALUES ('check-user', 'global', '', '', 'prefco', 'pref-chat', 'teleport')`,
      ),
    );
    expect(rejection.code).toBe("23514");
  });
});

describe("存储往返 (记录形状)", () => {
  test("写入返回的记录带完整身份与 ModelRef, 读取一致", async () => {
    const user = nextId("user");
    const service = preferenceService();
    const written = await service.setConversationSelection({
      userId: user,
      botId: "bot-1",
      conversationId: "conv-1",
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("the selectable write should succeed");
    const record: ModelPreferenceRecord = written.record;
    expect(record.userId).toBe(user);
    expect(record.scope).toBe("conversation");
    expect(record.botId).toBe("bot-1");
    expect(record.conversationId).toBe("conv-1");
    expect(record.ref).toEqual(chatRef(SELECTABLE_CHAT));
    expect(typeof record.updatedAt).toBe("string");

    const stored = await preferenceStore.getPreference({
      userId: user,
      scope: "conversation",
      botId: "bot-1",
      conversationId: "conv-1",
    });
    expect(stored).toEqual(record);
  });

  test("全局默认行的身份列为空串, scope 为 global", async () => {
    const user = nextId("user");
    const service = preferenceService();
    await service.setGlobalDefault({
      userId: user,
      ref: chatRef(SELECTABLE_CHAT),
      botCapabilities: CHAT_BOT_CAPABILITIES,
    });
    const stored = await preferenceStore.getPreference({
      userId: user,
      scope: "global",
    });
    expect(stored?.scope).toBe("global");
    expect(stored?.botId).toBe("");
    expect(stored?.conversationId).toBe("");
  });
});
