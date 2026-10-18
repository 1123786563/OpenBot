import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createModelSelectionRoutes,
  MODEL_SELECTION_UNAVAILABLE_REASONS,
} from "../src/gateway/model-selection-routes";
import type {
  EffectiveModelResolution,
  GatewayModelPreferenceService,
  ModelPreferenceRecord,
  ModelPreferenceWriteInput,
  ModelPreferenceWriteResult,
} from "../src/gateway/model-preference";
import type {
  GatewayModelCapabilityFilterService,
  ModelSelectionRequester,
  ModelSelectionResult,
} from "../src/gateway/model-capability-filter";
import type { GatewayPriceSnapshotStore } from "../src/gateway/price-snapshot";
import type {
  BotServiceRecord,
  BotServiceStore,
} from "../src/bot-services/store";

/*
 * Bifrost 03.10 (#232, AC09/AC19) — the user-facing workbench model picker's
 * public boundary. The picker screen (app) consumes exactly this contract, and
 * Bifrost 03.11 freezes its field names for the bot-facing discovery API, so
 * this file pins the wire: what a signed-in person may read about their own
 * model selection, and the one write they may make.
 *
 * What only this file can prove:
 *
 * - the picker read is one authenticated GET: the workbench Bot context, the
 *   selectable models with their price display status, and the effective
 *   resolution with the layer it came from — with an explicit available
 *   verdict and a closed five-code reason when the selected model is no
 *   longer offered (Q16: an unavailable selection is a visible error, never
 *   a silent switch, so the verdict rides the stored ref, not a replacement);
 * - the capability set the 03.8 filter is asked with is the workbench Bot's
 *   registry declaration mapped into the catalog's capability vocabulary —
 *   a registry `audio` Bot is asked for speech and transcription, an
 *   `async`-only Bot is refused with one displayable code rather than fed
 *   an empty set the filter's contract refuses;
 * - the preference write passes the session's own user id — never a body
 *   field — into 03.9's validated write and answers its result verbatim,
 *   refusal codes included;
 * - nothing that leaves these routes is administrator metadata, a credential
 *   or another person's preference: the answer carries refs, price status
 *   and the resolution, and nothing else.
 */

const USER: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "picker-person",
    email: "person@example.com",
    role: "user",
  } as never);
  await next();
};

const NOBODY: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  context.json({ error: "Authentication required." }, 401);

const WORKBENCH: BotServiceRecord = {
  botId: "openbot-workbench",
  displayName: "OpenBot Workbench",
  kind: "builtin",
  capabilities: ["chat"],
  status: "active",
  createdAt: new Date("2026-10-15T00:00:00Z"),
  updatedAt: new Date("2026-10-15T00:00:00Z"),
};

const CHAT_REF = { provider: "prefco", model: "pref-chat", capability: "chat" };
const OTHER_CHAT_REF = {
  provider: "prefco",
  model: "pref-chat-mini",
  capability: "chat",
};
const IMAGE_REF = {
  provider: "prefco",
  model: "pref-draw",
  capability: "image",
};

/** A preference service whose answers the test pins per case. */
function fakePreferences(
  overrides: {
    resolve?: (input: {
      userId: string;
      botId: string;
      conversationId: string;
    }) => Promise<EffectiveModelResolution>;
    write?: (
      input: ModelPreferenceWriteInput & {
        scope: "global" | "bot" | "conversation";
        botId?: string;
        conversationId?: string;
      },
    ) => Promise<ModelPreferenceWriteResult>;
  } = {},
): GatewayModelPreferenceService {
  return {
    setGlobalDefault: (input) =>
      (
        overrides.write ??
        (async () => {
          throw new Error("unexpected write");
        })
      )({ ...input, scope: "global" }),
    setBotDefault: (input) =>
      (
        overrides.write ??
        (async () => {
          throw new Error("unexpected write");
        })
      )({ ...input, scope: "bot", botId: input.botId }),
    setConversationSelection: (input) =>
      (
        overrides.write ??
        (async () => {
          throw new Error("unexpected write");
        })
      )({
        ...input,
        scope: "conversation",
        botId: input.botId,
        conversationId: input.conversationId,
      }),
    resolveEffectiveModel:
      overrides.resolve ?? (async () => ({ status: "unset" as const })),
  };
}

function fakeFilter(
  result: ModelSelectionResult = { selectable: [], excluded: [] },
  spy?: {
    calls: {
      capabilities: readonly string[];
      requester: ModelSelectionRequester;
    }[];
  },
): Pick<GatewayModelCapabilityFilterService, "listSelectableModels"> {
  return {
    async listSelectableModels(botCapabilities, requester) {
      spy?.calls.push({ capabilities: botCapabilities, requester });
      return result;
    },
  };
}

function fakePrices(
  statuses: Record<string, string> = {},
): Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots"> {
  return {
    async listLatestPriceSnapshots() {
      return Object.entries(statuses).map(([key, status]) => {
        const [provider, model, capability] = key.split("|");
        return {
          ref: { provider, model, capability },
          classification: { status },
        } as never;
      });
    },
  };
}

function fakeBots(
  record: BotServiceRecord | null = WORKBENCH,
): Pick<BotServiceStore, "getBotService"> {
  return { getBotService: async () => record };
}

function fixture(
  overrides: {
    requireUser?: MiddlewareHandler<{ Variables: AppVariables }>;
    preferences?: GatewayModelPreferenceService;
    filter?: Pick<GatewayModelCapabilityFilterService, "listSelectableModels">;
    prices?: Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots">;
    bots?: Pick<BotServiceStore, "getBotService">;
    omit?: ("preferences" | "filter" | "prices" | "bots")[];
  } = {},
) {
  // Deps are factories, the admin-routes pattern: the real mount resolves the
  // running controls lazily per request, tests answer per case. The registry
  // rides its own argument, the way every sibling route takes it.
  const app = createModelSelectionRoutes(
    overrides.requireUser ?? USER,
    overrides.omit?.includes("bots")
      ? undefined
      : (overrides.bots ?? fakeBots()),
    {
      ...(overrides.omit?.includes("preferences")
        ? {}
        : { preferences: () => overrides.preferences ?? fakePreferences() }),
      ...(overrides.omit?.includes("filter")
        ? {}
        : { selectable: () => overrides.filter ?? fakeFilter() }),
      ...(overrides.omit?.includes("prices")
        ? {}
        : { priceSnapshots: () => overrides.prices ?? fakePrices() }),
    },
  );
  return app;
}

async function callJson(
  app: ReturnType<typeof createModelSelectionRoutes>,
  path: string,
  init?: RequestInit,
) {
  const response = await app.request(path, init);
  return { response, body: await response.json().catch(() => undefined) };
}

describe("model selection routes — authentication and availability", () => {
  test("an unauthenticated request is refused before anything else", async () => {
    const app = fixture({ requireUser: NOBODY });
    const { response } = await callJson(app, "/");
    expect(response.status).toBe(401);
  });

  test("unwired controls answer a tagged 503, never an empty success", async () => {
    const app = fixture({ omit: ["preferences"] });
    const { response, body } = await callJson(app, "/");
    expect(response.status).toBe(503);
    expect(body.code).toBe("model_selection_unavailable");
  });
});

describe("model selection routes — the picker read", () => {
  test("the read answers the workbench bot, selectable refs with price status, and the resolved selection with its layer", async () => {
    const app = fixture({
      preferences: fakePreferences({
        resolve: async () => ({
          status: "resolved",
          ref: CHAT_REF,
          source: "bot",
        }),
      }),
      filter: fakeFilter({
        selectable: [CHAT_REF, OTHER_CHAT_REF],
        excluded: [{ ref: IMAGE_REF, reasonCode: "model_capability_mismatch" }],
      }),
      prices: fakePrices({
        "prefco|pref-chat|chat": "known",
        "prefco|pref-chat-mini|chat": "free",
      }),
    });
    const { response, body } = await callJson(app, "/");
    expect(response.status).toBe(200);
    expect(body.bot).toEqual({
      botId: "openbot-workbench",
      displayName: "OpenBot Workbench",
    });
    expect(body.selectable).toEqual([
      { ref: CHAT_REF, priceStatus: "known" },
      { ref: OTHER_CHAT_REF, priceStatus: "free" },
    ]);
    expect(body.effective).toEqual({
      status: "resolved",
      ref: CHAT_REF,
      source: "bot",
      available: true,
    });
  });

  test("the read never carries administrator metadata, credentials or another person's preferences", async () => {
    const app = fixture({
      preferences: fakePreferences({
        resolve: async () => ({
          status: "resolved",
          ref: CHAT_REF,
          source: "global",
        }),
      }),
      filter: fakeFilter({
        selectable: [CHAT_REF],
        excluded: [{ ref: IMAGE_REF, reasonCode: "model_not_open" }],
      }),
      prices: fakePrices({ "prefco|pref-chat|chat": "known" }),
    });
    const { body } = await callJson(app, "/");
    const wire = JSON.stringify(body);
    for (const leak of [
      "changedBy",
      "changedAt",
      "fingerprint",
      "baseUrl",
      "apiKey",
      "credential",
      "reasonText",
      "picker-person",
    ]) {
      expect(wire).not.toContain(leak);
    }
  });

  test("a selected model the filter excludes answers unavailable with that exact closed reason — never a replacement", async () => {
    const app = fixture({
      preferences: fakePreferences({
        resolve: async () => ({
          status: "resolved",
          ref: CHAT_REF,
          source: "conversation",
        }),
      }),
      filter: fakeFilter({
        selectable: [OTHER_CHAT_REF],
        excluded: [{ ref: CHAT_REF, reasonCode: "model_not_open" }],
      }),
      prices: fakePrices({ "prefco|pref-chat-mini|chat": "known" }),
    });
    const { body } = await callJson(app, "/");
    expect(body.effective).toEqual({
      status: "resolved",
      ref: CHAT_REF,
      source: "conversation",
      available: false,
      unavailableReasonCode: "model_not_open",
    });
  });

  test("a selected model no longer in the catalog at all answers model_not_in_catalog", async () => {
    const app = fixture({
      preferences: fakePreferences({
        resolve: async () => ({
          status: "resolved",
          ref: CHAT_REF,
          source: "global",
        }),
      }),
      filter: fakeFilter({
        selectable: [OTHER_CHAT_REF],
        excluded: [],
      }),
      prices: fakePrices({ "prefco|pref-chat-mini|chat": "known" }),
    });
    const { body } = await callJson(app, "/");
    expect(body.effective.available).toBe(false);
    expect(body.effective.unavailableReasonCode).toBe("model_not_in_catalog");
  });

  test("the unavailable reasons are the closed five-code display vocabulary", () => {
    expect([...MODEL_SELECTION_UNAVAILABLE_REASONS]).toEqual([
      "model_capability_mismatch",
      "model_not_open",
      "model_price_unknown",
      "model_catalog_stale",
      "model_not_in_catalog",
    ]);
  });

  test("no stored preference answers an honest unset", async () => {
    const app = fixture({ preferences: fakePreferences() });
    const { body } = await callJson(app, "/");
    expect(body.effective).toEqual({ status: "unset" });
  });

  test("the conversation id rides through to the resolver", async () => {
    let seen: { userId: string; botId: string; conversationId: string } | null =
      null;
    const app = fixture({
      preferences: fakePreferences({
        resolve: async (input) => {
          seen = input;
          return { status: "unset" };
        },
      }),
    });
    await callJson(app, "/?conversationId=conv-7");
    expect(seen).toEqual({
      userId: "picker-person",
      botId: "openbot-workbench",
      conversationId: "conv-7",
    });
  });

  test("a missing workbench bot registration is an explicit error, not an empty list", async () => {
    const app = fixture({ bots: fakeBots(null) });
    const { response, body } = await callJson(app, "/");
    expect(response.status).toBe(503);
    expect(body.code).toBe("workbench_bot_unavailable");
  });

  test("a disabled workbench bot is the same explicit error", async () => {
    const app = fixture({
      bots: fakeBots({ ...WORKBENCH, status: "disabled" }),
    });
    const { response, body } = await callJson(app, "/");
    expect(response.status).toBe(503);
    expect(body.code).toBe("workbench_bot_unavailable");
  });
});

describe("model selection routes — the registry capability mapping", () => {
  test("registry capabilities map into the catalog vocabulary before the filter is asked", async () => {
    const spy = { calls: [] as { capabilities: readonly string[] }[] };
    const app = fixture({
      bots: fakeBots({ ...WORKBENCH, capabilities: ["audio", "chat"] }),
      filter: fakeFilter({ selectable: [], excluded: [] }, spy as never),
    });
    await callJson(app, "/");
    expect([...spy.calls[0].capabilities].sort()).toEqual([
      "chat",
      "speech",
      "transcription",
    ]);
  });

  test("a bot whose declarations map to no catalog capability is refused with one displayable code", async () => {
    const app = fixture({
      bots: fakeBots({ ...WORKBENCH, capabilities: ["async"] }),
    });
    const { response, body } = await callJson(app, "/");
    expect(response.status).toBe(409);
    expect(body.code).toBe("bot_capabilities_unmappable");
  });
});

describe("model selection routes — the preference write", () => {
  const record: ModelPreferenceRecord = {
    userId: "picker-person",
    scope: "bot",
    botId: "openbot-workbench",
    conversationId: "",
    ref: CHAT_REF,
    updatedAt: "2026-10-17T00:00:00.000Z",
  };

  test("a global write passes the session user and the registry-mapped capabilities into 03.9 and answers its success verbatim", async () => {
    const writes: unknown[] = [];
    const app = fixture({
      preferences: fakePreferences({
        write: async (input) => {
          writes.push(input);
          return { ok: true, record: { ...record, scope: "global" } };
        },
      }),
      filter: fakeFilter({
        selectable: [CHAT_REF],
        excluded: [],
      }),
    });
    const { response, body } = await callJson(app, "/preference", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        ref: CHAT_REF,
      }),
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      record: { ...record, scope: "global" },
    });
    expect(writes[0]).toMatchObject({
      userId: "picker-person",
      scope: "global",
      ref: CHAT_REF,
    });
  });

  test("a bot-scoped write names the workbench bot; a conversation write names its session", async () => {
    const writes: unknown[] = [];
    const app = fixture({
      preferences: fakePreferences({
        write: async (input) => {
          writes.push(input);
          return { ok: true, record };
        },
      }),
    });
    await callJson(app, "/preference", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "bot", ref: CHAT_REF }),
    });
    await callJson(app, "/preference", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "conversation",
        conversationId: "conv-9",
        ref: CHAT_REF,
      }),
    });
    expect(writes[0]).toMatchObject({
      scope: "bot",
      botId: "openbot-workbench",
    });
    expect(writes[1]).toMatchObject({
      scope: "conversation",
      botId: "openbot-workbench",
      conversationId: "conv-9",
    });
  });

  test("a 03.9 refusal passes through untouched — the screen shows the server's own sentence", async () => {
    const app = fixture({
      preferences: fakePreferences({
        write: async () => ({
          ok: false,
          reasonCode: "model_preference_ref_not_selectable",
          detail: "model_price_unknown",
        }),
      }),
    });
    const { response, body } = await callJson(app, "/preference", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", ref: CHAT_REF }),
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: false,
      reasonCode: "model_preference_ref_not_selectable",
      detail: "model_price_unknown",
    });
  });

  test("a body that names a user, a malformed scope or an incomplete ref is a 400, never a silent fix", async () => {
    const app = fixture();
    const cases: [string, unknown][] = [
      [
        "userId in body",
        { scope: "global", userId: "someone-else", ref: CHAT_REF },
      ],
      ["unknown scope", { scope: "workspace", ref: CHAT_REF }],
      [
        "global naming a bot",
        { scope: "global", botId: "other-bot", ref: CHAT_REF },
      ],
      [
        "bot scope naming a bot",
        { scope: "bot", botId: "other-bot", ref: CHAT_REF },
      ],
      [
        "conversation scope without session",
        { scope: "conversation", ref: CHAT_REF },
      ],
      ["incomplete ref", { scope: "global", ref: { provider: "prefco" } }],
      [
        "unknown capability",
        {
          scope: "global",
          ref: { provider: "prefco", model: "m", capability: "telepathy" },
        },
      ],
      ["missing ref", { scope: "global" }],
    ];
    for (const [name, payload] of cases) {
      const { response } = await callJson(app, "/preference", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status, name).toBe(400);
    }
    // A body that is not JSON at all is the same refusal.
    const { response: malformed } = await callJson(app, "/preference", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(malformed.status).toBe(400);
  });

  test("an unauthenticated write is refused", async () => {
    const app = fixture({ requireUser: NOBODY });
    const { response } = await callJson(app, "/preference", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", ref: CHAT_REF }),
    });
    expect(response.status).toBe(401);
  });
});
