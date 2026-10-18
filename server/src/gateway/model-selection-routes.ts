/**
 * `/api/model-selection`: the signed-in person's workbench model picker surface
 * (Bifrost 03.10, AC09/AC19/Q16/Q30) — the read that paints the picker and the
 * one write that stores a layer.
 *
 * THE WORKBENCH MAIN ENTRY, AND ONLY IT. Q30 reuses existing pages for model
 * selection; the picker this serves is mounted on the model-access settings
 * page with the built-in workbench Bot (04.8's `openbot-workbench`) as the Bot
 * context. Chat-embedded pickers and other Bot contexts are later entries
 * (09.1, 22.1's enumeration) — they will call the same two endpoints with
 * their own context, so nothing here may special-case beyond the registry
 * lookup this route performs.
 *
 * THE ANSWER IS THE DISPLAY CONTRACT. `GET` answers the Bot context, the
 * selectable refs with their price display status, and the effective
 * resolution naming the layer it came from. Bifrost 03.11 freezes these field
 * names for the bot-facing discovery API, so the response carries exactly the
 * fields a picker renders — refs, price status, resolution — and nothing that
 * is administrator metadata, a credential, or another person's preference.
 * 03.8 guarantees `selectable` is capability-matching, open and priced; the
 * price status annotated here is 03.3's classification read again for
 * display, and an `unknown` that could only appear through a concurrent
 * catalog change still renders as unknown downstream, never as free.
 *
 * AN UNAVAILABLE SELECTION IS ANSWERED, NOT FIXED. Resolution is 03.9's,
 * verbatim — it never falls through to a coarser layer and never substitutes
 * a model. This route adds only the displayable verdict: is the stored ref in
 * the selectable list right now, and when not, one code from the closed
 * five-reason vocabulary — 03.8's four exclusion reasons, or
 * `model_not_in_catalog` for a ref the last-good directory has already
 * dropped (delisted), the same fallback wording a 03.9 write refusal uses.
 * The screen owns the sentence and the re-selection prompt.
 *
 * THE WRITE IS 03.9'S, AT THE BOUNDARY. `PUT` passes the session's own user
 * id — a body that names a user is refused — into the validated preference
 * write and answers its result untouched, refusals included: a ref outside
 * the requester's selectable list is a 200-borne business refusal the screen
 * shows, not something this layer retries or re-selects.
 *
 * CAPABILITIES CROSS ONE VOCABULARY. The Bot registry (04.1) stores a Bot's
 * declared call kinds; 03.8 asks with the catalog's capability vocabulary.
 * The mapping is table-driven and total — an `audio` Bot is asked for speech
 * and transcription, an `async`-only Bot maps to nothing and is refused with
 * one displayable code rather than fed an empty set the filter's contract
 * refuses. The workbench Bot itself must exist and be active: a deployment
 * that never registered it (or disabled it) gets an explicit tagged error,
 * never an empty list dressed up as an answer.
 */
import type { AppVariables } from "../auth/guards";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { BotServiceStore } from "../bot-services/store";
import type { BotServiceCapability } from "../bot-services/types";
import { WORKBENCH_BOT_ID } from "../bot-services/access-grants";
import {
  type BotCapability,
  type GatewayModelCapabilityFilterService,
  type ModelExclusionReason,
  MODEL_EXCLUSION_REASONS,
  gatewayModelCapabilityFilterControls,
} from "./model-capability-filter";
import {
  type EffectiveModelResolution,
  type GatewayModelPreferenceService,
  type ModelPreferenceScope,
  MODEL_PREFERENCE_SCOPES,
  gatewayModelPreferenceControls,
} from "./model-preference";
import {
  type GatewayPriceSnapshotStore,
  createEnterpriseGatewayPriceSnapshotStore,
} from "./price-snapshot";
import { MODEL_CAPABILITIES, type ModelRef, modelRefKey } from "./catalog";
import { enterpriseControls } from "../admin/controls";

/**
 * Why the selection on record may not be offerable right now. Closed and
 * displayable — the screen maps each code to its sentence, and 03.11 freezes
 * the same vocabulary. 03.8's four exclusion reasons, plus the one case the
 * filter cannot name: the ref has left the last-good catalog entirely.
 */
export const MODEL_SELECTION_UNAVAILABLE_REASONS = [
  ...MODEL_EXCLUSION_REASONS,
  "model_not_in_catalog",
] as const;

export type ModelSelectionUnavailableReason =
  (typeof MODEL_SELECTION_UNAVAILABLE_REASONS)[number];

/**
 * The registry's call kinds mapped into the catalog capabilities the filter
 * is asked with. Total and table-driven: `audio` is the ability to produce or
 * consume audio, which is the catalog's speech (tts) and transcription (stt)
 * capabilities; `async` names a delivery mode, not a capability, and
 * contributes nothing.
 */
const WORKBENCH_CAPABILITY_MAPPING: Record<
  BotServiceCapability,
  readonly BotCapability[]
> = {
  chat: ["chat"],
  image: ["image"],
  audio: ["speech", "transcription"],
  embedding: ["embedding"],
  realtime: ["realtime"],
  async: [],
};

/** The model capabilities a registry declaration feeds the filter with. */
export function mappedModelCapabilities(
  capabilities: readonly BotServiceCapability[],
): BotCapability[] {
  const mapped: BotCapability[] = [];
  for (const capability of capabilities) {
    for (const target of WORKBENCH_CAPABILITY_MAPPING[capability] ?? []) {
      if (!mapped.includes(target)) mapped.push(target);
    }
  }
  return mapped;
}

/** The services the routes ask; the real mount resolves the gateway ones lazily per request. */
export type ModelSelectionRouteDeps = {
  preferences: () => GatewayModelPreferenceService | undefined;
  selectable: () =>
    | Pick<GatewayModelCapabilityFilterService, "listSelectableModels">
    | undefined;
  priceSnapshots: () => Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots"> | undefined;
};

function defaultDeps(): ModelSelectionRouteDeps {
  return {
    preferences: () => gatewayModelPreferenceControls(),
    selectable: () => gatewayModelCapabilityFilterControls(),
    priceSnapshots: () => {
      const controls = enterpriseControls();
      if (!controls) return undefined;
      return createEnterpriseGatewayPriceSnapshotStore(controls.deps.database);
    },
  };
}

function unavailable(
  context: Context<{ Variables: AppVariables }>,
  error: string,
  code: string,
  status: 503 | 409 = 503,
) {
  return context.json({ error, code }, status);
}

/** One selectable ref with the price display status the picker renders. */
type SelectableModelView = {
  ref: ModelRef;
  priceStatus: string;
};

/** The effective resolution with its availability verdict — never a replacement. */
type EffectiveModelView =
  | { status: "unset" }
  | {
      status: "resolved";
      ref: ModelRef;
      source: ModelPreferenceScope;
      available: boolean;
      unavailableReasonCode?: ModelSelectionUnavailableReason;
    };

export function createModelSelectionRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** The Bot service registry (04.1), passed in like every sibling route takes it. */
  botServices?: Pick<BotServiceStore, "getBotService">,
  deps?: Partial<ModelSelectionRouteDeps>,
) {
  const resolved: ModelSelectionRouteDeps = { ...defaultDeps(), ...deps };
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);

  const resolveContext = async () => {
    const preferences = resolved.preferences();
    const selectable = resolved.selectable();
    const priceSnapshots = resolved.priceSnapshots();
    if (!preferences || !selectable || !priceSnapshots || !botServices) {
      return { error: "model_selection_unavailable" as const };
    }
    // The Bot context is the built-in workbench Bot, resolved live in the
    // registry: a deployment that never registered it, or disabled it, has no
    // picker context and is told so — an empty list would read as "no models
    // exist", which is a different untruth.
    const bot = await botServices.getBotService(WORKBENCH_BOT_ID);
    if (bot?.status !== "active") {
      return { error: "workbench_bot_unavailable" as const };
    }
    // Registry declaration → catalog vocabulary. An empty mapping is a
    // deployment declaration problem, refused with its own code rather than
    // handed to a filter whose contract refuses empty sets.
    const capabilities = mappedModelCapabilities(bot.capabilities);
    if (capabilities.length === 0) {
      return { error: "bot_capabilities_unmappable" as const };
    }
    return {
      error: null,
      preferences,
      selectable,
      priceSnapshots,
      bot,
      capabilities,
    };
  };

  app.get("/", async (context) => {
    const ready = await resolveContext();
    if (ready.error === "model_selection_unavailable") {
      return unavailable(
        context,
        "Model selection is not available.",
        ready.error,
      );
    }
    if (ready.error === "workbench_bot_unavailable") {
      return unavailable(
        context,
        "The workbench bot is not available for model selection.",
        ready.error,
      );
    }
    if (ready.error === "bot_capabilities_unmappable") {
      return unavailable(
        context,
        "The workbench bot declares no capability the model catalog can offer.",
        ready.error,
        409,
      );
    }

    const conversationId = context.req.query("conversationId") ?? "";
    const userId = context.var.actor.id;

    // One answer each: the offered list (03.8, verbatim) and the stored
    // resolution (03.9, verbatim — it never falls through or substitutes).
    const [selection, effective, snapshots] = await Promise.all([
      ready.selectable.listSelectableModels(ready.capabilities, {
        kind: "user",
        id: userId,
      }),
      ready.preferences.resolveEffectiveModel({
        userId,
        botId: WORKBENCH_BOT_ID,
        conversationId,
      }),
      ready.priceSnapshots.listLatestPriceSnapshots(),
    ]);
    const priceStatusByRef = new Map(
      snapshots.map((snapshot) => [
        modelRefKey(snapshot.ref),
        snapshot.classification.status,
      ]),
    );
    const selectableViews: SelectableModelView[] = selection.selectable.map(
      (ref) => ({
        ref,
        priceStatus: priceStatusByRef.get(modelRefKey(ref)) ?? "unmapped",
      }),
    );

    return context.json({
      bot: { botId: ready.bot.botId, displayName: ready.bot.displayName },
      selectable: selectableViews,
      effective: effectiveView(effective, selection),
    });
  });

  app.put("/preference", async (context) => {
    const ready = await resolveContext();
    if (ready.error === "model_selection_unavailable") {
      return unavailable(
        context,
        "Model selection is not available.",
        ready.error,
      );
    }
    if (ready.error === "workbench_bot_unavailable") {
      return unavailable(
        context,
        "The workbench bot is not available for model selection.",
        ready.error,
      );
    }
    if (ready.error === "bot_capabilities_unmappable") {
      return unavailable(
        context,
        "The workbench bot declares no capability the model catalog can offer.",
        ready.error,
        409,
      );
    }

    const body = await context.req.json().catch(() => undefined);
    if (typeof body !== "object" || body === null) {
      return context.json({ error: "A preference write names a scope and a model ref." }, 400);
    }
    const payload = body as Record<string, unknown>;

    // The user is the session's; a body that names one is refused at the
    // boundary rather than ignored, so a client can never believe it chose.
    if ("userId" in payload) {
      return context.json(
        { error: "A preference write never names a user; the session does." },
        400,
      );
    }
    const scope = payload.scope;
    if (
      typeof scope !== "string" ||
      !MODEL_PREFERENCE_SCOPES.includes(scope as ModelPreferenceScope)
    ) {
      return context.json(
        { error: `A preference write names one of the scopes ${MODEL_PREFERENCE_SCOPES.join(", ")}.` },
        400,
      );
    }
    // The Bot context is this route's own — the workbench bot — so a body
    // that tries to name one is refused at the boundary, the same way a body
    // that names a user is.
    if (payload.botId !== undefined) {
      return context.json(
        { error: "The Bot context is the workbench bot and is never a body field." },
        400,
      );
    }
    const conversationId =
      scope === "conversation" && typeof payload.conversationId === "string"
        ? payload.conversationId.trim()
        : "";
    if (scope === "conversation" && conversationId === "") {
      return context.json(
        { error: "A conversation preference names its session." },
        400,
      );
    }
    const ref = payload.ref as ModelRef | undefined;
    if (
      typeof ref !== "object" ||
      ref === null ||
      typeof ref.provider !== "string" ||
      ref.provider.trim() === "" ||
      typeof ref.model !== "string" ||
      ref.model.trim() === "" ||
      typeof ref.capability !== "string" ||
      !MODEL_CAPABILITIES.includes(ref.capability as never)
    ) {
      return context.json(
        { error: "A preference write names a complete model ref: provider, model, capability." },
        400,
      );
    }

    const input = {
      userId: context.var.actor.id,
      ref,
      // The Bot context the write is validated against is this route's own:
      // registry-declared capabilities mapped into the filter's vocabulary,
      // the same answer the read served the list with.
      botCapabilities: ready.capabilities,
    };
    switch (scope) {
      case "global":
        return context.json(await ready.preferences.setGlobalDefault(input));
      case "bot":
        return context.json(
          await ready.preferences.setBotDefault({
            ...input,
            botId: WORKBENCH_BOT_ID,
          }),
        );
      case "conversation":
        return context.json(
          await ready.preferences.setConversationSelection({
            ...input,
            botId: WORKBENCH_BOT_ID,
            conversationId,
          }),
        );
    }
  });

  return app;
}

/** Attach the availability verdict to 03.9's answer — the ref is never changed. */
function effectiveView(
  effective: EffectiveModelResolution,
  selection: { selectable: ModelRef[]; excluded: { ref: ModelRef; reasonCode: ModelExclusionReason }[] },
): EffectiveModelView {
  if (effective.status === "unset") return { status: "unset" };
  const key = modelRefKey(effective.ref);
  if (selection.selectable.some((ref) => modelRefKey(ref) === key)) {
    return {
      status: "resolved",
      ref: effective.ref,
      source: effective.source,
      available: true,
    };
  }
  const excludedReason = selection.excluded.find(
    (entry) => modelRefKey(entry.ref) === key,
  )?.reasonCode;
  return {
    status: "resolved",
    ref: effective.ref,
    source: effective.source,
    available: false,
    unavailableReasonCode: excludedReason ?? "model_not_in_catalog",
  };
}
