/**
 * `/api/model-discovery`: the bot-facing model discovery read (Bifrost 03.11,
 * AC09/AC19/Q4) — the one question an authenticated Bot service may ask this
 * deployment's catalog: which models may I use, what does each cost to
 * display, and why is a capability-matching model not offered right now.
 *
 * THE DOOR IS 04.2'S, NOT A NEW ONE. Every request rides
 * {@link requireBotService} — the same guard the binding codes ride — so a
 * caller is a `BotServiceIdentity` and nothing else, and every failure (no
 * header, a token that is not ours, a wrong secret, a disabled Bot) is the
 * one uniform 401 that never says whether a botId exists. A deployment that
 * never composed the authenticator has this surface mounted but answering a
 * tagged 503 on every path and method, the same degraded shape the
 * `/api/bot-service` door takes — fail closed in both directions.
 *
 * THE ANSWER IS 03.8'S, UNDER 03.10'S NAMES — THE FROZEN CONTRACT. The
 * offered set is 03.8's `selectable`, verbatim: capability-matching, open,
 * price-determinable refs, each annotated with 03.10's `priceStatus` read
 * from the same snapshot store the picker reads (an `unmapped` that could
 * only follow a concurrent catalog change renders as `unmapped`, never as
 * free). The not-offered set is 03.8's `excluded`, with its one closed
 * reason per ref. No field is coined here: `bot.botId`/`bot.displayName`
 * are the picker's Bot context fields, `ref` the `ModelRef` triple,
 * `reasonCode` 03.8's vocabulary. 05.3 (key issuance) and 07.x (pre-call
 * validation) may depend on these names exactly; changing any of them is a
 * contract change that must first be recorded in the ticket's produces
 * section and told to the consumers.
 *
 * THE BOT SEES ONLY ITS OWN BUSINESS. The filter is asked with the
 * authenticated Bot's own registry declaration, mapped through 03.10's
 * table, attributed as requester kind `bot_service` — the judgment is never
 * re-derived here. One presentation narrowing is deliberate: a ref whose
 * capability the Bot never declared is never named at all (not even in
 * `excluded`), so the whole body contains only refs the Bot's own
 * declaration makes its business and `model_capability_mismatch` cannot
 * appear — the bot's capabilities are its own knowledge, and the catalog
 * gains nothing by confirming them. What remains in `excluded` is exactly
 * the actionable answer to "why not": never opened, price turned unknown,
 * catalog stale (03.4/03.6's gate, when connected). No administrator
 * configuration, no scope reason text, no operator identity, no snapshot
 * provenance, no other person's preference, no credential — the whitelist
 * is the shape itself, and the tests pin it key by key.
 *
 * A BOT THAT CAN BE OFFERED NOTHING IS TOLD SO. An `async`-only declaration
 * maps to no catalog capability; the answer is one displayable 409
 * (`bot_capabilities_unmappable`, the picker's code) rather than an empty
 * list dressed up as "no models exist". A Bot record that vanished or was
 * disabled between authentication and this read — a race authentication
 * itself usually closes — answers the door's own tagged 503, never an
 * answer borrowed from a stale declaration.
 */

import { type Context, Hono } from "hono";
import { enterpriseControls } from "../admin/controls";
import type {
  BotServiceAuthenticator,
  BotServiceVariables,
} from "../bot-services/auth";
import { requireBotService } from "../bot-services/auth";
import type { BotServiceStore } from "../bot-services/store";
import type { ModelRef } from "./catalog";
import {
  type GatewayModelCapabilityFilterService,
  gatewayModelCapabilityFilterControls,
  type ModelExclusionReason,
  type ModelSelectionPriceStatus,
} from "./model-capability-filter";
import { mappedModelCapabilities } from "./model-selection-routes";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  type GatewayPriceSnapshotStore,
} from "./price-snapshot";
import { createModelAccessPublic } from "./public";
import { speechTailAvailabilityView } from "../billing/speech-tail-availability";

/** The services the route asks; the real mount resolves the gateway ones lazily per request. */
export type ModelDiscoveryRouteDeps = {
  selectable: () =>
    | Pick<GatewayModelCapabilityFilterService, "listSelectableModels">
    | undefined;
  priceSnapshots: () =>
    | Pick<GatewayPriceSnapshotStore, "listLatestPriceSnapshots">
    | undefined;
};

function defaultDeps(): ModelDiscoveryRouteDeps {
  return {
    selectable: () => gatewayModelCapabilityFilterControls(),
    priceSnapshots: () => {
      const controls = enterpriseControls();
      if (!controls) return undefined;
      return createEnterpriseGatewayPriceSnapshotStore(controls.deps.database);
    },
  };
}

/** One selectable ref with the price display status the picker contract freezes. */
type SelectableModelView = {
  ref: ModelRef;
  priceStatus: ModelSelectionPriceStatus;
};

/** One ref this Bot's capabilities match that is not offered right now, and why. */
type ExcludedModelView = {
  ref: ModelRef;
  reasonCode: ModelExclusionReason;
};

export function createModelDiscoveryRoutes(
  /** The 04.2 door: the authenticator and the registry that answers "which Bot". */
  door:
    | {
        authenticate: BotServiceAuthenticator;
        botServices: Pick<BotServiceStore, "getBotService">;
      }
    | undefined,
  deps?: Partial<ModelDiscoveryRouteDeps>,
) {
  const resolved: ModelDiscoveryRouteDeps = { ...defaultDeps(), ...deps };
  const app = new Hono<{ Variables: BotServiceVariables }>();

  if (!door) {
    app.use("*", async (context, next) => {
      context.header("cache-control", "no-store");
      await next();
    });
    app.all("*", (context) =>
      context.json(
        {
          error: "Bot service authentication is not available.",
          code: "bot_service_unavailable",
        },
        503,
      ),
    );
    return app;
  }

  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireBotService({ authenticate: door.authenticate }));

  app.get("/", async (context) => {
    const unavailable = (
      context: Context<{ Variables: BotServiceVariables }>,
      error: string,
      code: string,
      status: 503 | 409 = 503,
    ) => context.json({ error, code }, status);

    const selectable = resolved.selectable();
    const priceSnapshots = resolved.priceSnapshots();
    if (!selectable || !priceSnapshots) {
      return unavailable(
        context,
        "Model discovery is not available.",
        "model_discovery_unavailable",
      );
    }

    // The authenticated identity names the Bot; the registry's live record
    // names its declaration. A record that vanished (or was disabled) between
    // the credential check and this read is the door's own failure, not an
    // empty answer.
    const identity = context.get("botService");
    // A storage failure during the live read is this route's own tagged 503, never a bare
    // 500 that would break the one error shape every path here promises.
    const botRead = await door.botServices
      .getBotService(identity.botId)
      .then((bot) => ({ bot }))
      .catch(() => null);
    if (!botRead) {
      return unavailable(
        context,
        "Model discovery is not available.",
        "model_discovery_unavailable",
      );
    }
    const { bot } = botRead;
    if (bot?.status !== "active") {
      return unavailable(
        context,
        "Bot service authentication is not available.",
        "bot_service_unavailable",
      );
    }
    const capabilities = mappedModelCapabilities(bot.capabilities);
    if (capabilities.length === 0) {
      return unavailable(
        context,
        "The bot declares no capability the model catalog can offer.",
        "bot_capabilities_unmappable",
        409,
      );
    }

    // One decision, 03.8's and only 03.8's; one price read for the display
    // annotation, the same store the picker annotates from — both asked through
    // M06's business facade (Issue #628), the one available-model exit this
    // route now consumes instead of composing the internals itself.
    const modelAccess = createModelAccessPublic({
      models: { selectable, priceSnapshots },
    });
    const answer = await modelAccess
      .availableModels({
        botCapabilities: capabilities,
        requester: { kind: "bot_service", id: identity.botId },
      })
      .catch(() => null);
    if (!answer) {
      return unavailable(
        context,
        "Model discovery is not available.",
        "model_discovery_unavailable",
      );
    }

    // The whole body is the Bot's own business: a capability-mismatched ref
    // is never named, so the mismatch reason cannot appear either.
    const selectableViews: SelectableModelView[] = answer.selectable.map(
      (entry) => ({ ref: entry.ref, priceStatus: entry.priceStatus }),
    );
    const excludedViews: ExcludedModelView[] = answer.excluded
      .filter((entry) => entry.reasonCode !== "model_capability_mismatch")
      .map((entry) => ({ ref: entry.ref, reasonCode: entry.reasonCode }));

    // 11.6 (#301): the three group-11 capabilities' enablement summary now rides
    // `answer.capabilityAvailability` (the facade's answer over the same latest
    // snapshots). This route's wire is unchanged — the field was, and remains,
    // not part of the response — so the migration neither adds nor removes a key.

    return context.json({
      bot: { botId: bot.botId, displayName: bot.displayName },
      selectable: selectableViews,
      excluded: excludedViews,
      /*
       * 13.4 (#309): the speech call modes' tail constraint, answered beside the model
       * list for the same reason the excluded set names its reasons — a caller deciding
       * HOW to call a speech model must see which response formats are usable and why the
       * others are not, before the admission door refuses the call. Pure projection off
       * the same verdict the door consults (speechTailAvailabilityView), so this surface
       * and the door can never disagree. An additive member of the frozen contract,
       * recorded in #309's produces list; every other key keeps its shape.
       */
      speechPaths: speechTailAvailabilityView(),
    });
  });

  return app;
}
