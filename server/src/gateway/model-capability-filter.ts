/**
 * The bot capability filter — which models a bot may be offered (Bifrost 03.8, AC06/AC09/Q4).
 *
 * CATALOG ≠ OPEN ≠ MATCHING ≠ OFFERED. Q4 defines what a key may use by default: models that
 * are configured, enabled and administrator-opened, filtered to the capabilities the bot
 * supports. This module is that filter, and nothing else: it reads 03.1's last-good catalog
 * as the universe, 03.7's `isModelOpen` as the administrator's decision, and 03.3's price
 * classification as the "can this be priced at all" verdict — and answers, for one bot's
 * capability set, which refs are selectable and why every other ref is not. It opens nothing,
 * prices nothing and authorizes nobody; the routes that expose the answer (03.10's picker,
 * 03.11's discovery) own authentication and presentation.
 *
 * ONE REF, ONE REASON. Every catalog ref leaves the filter either selectable or excluded
 * with exactly one code from a closed, displayable vocabulary, decided by a fixed precedence
 * — the coarsest disqualification first:
 *
 *   1. `model_capability_mismatch` — the ref's capability is not one the bot declared. A
 *      ref whose capability is `unknown` can never be proven to match, so it never reaches
 *      a chat bot as a chat model; a chat+image model contributes its chat ref, not its
 *      image one.
 *   2. `model_not_open` — 03.7 says no (never opened, or delisted since). This precedes the
 *      price reason because an administrator cannot open a price-unknown model: when both
 *      are wrong, the actionable answer for the requester is the scope answer, and the
 *      admin view already shows the unmapped price behind it.
 *   3. `model_price_unknown` — the latest price basis classifies `unknown`, or no snapshot
 *      has ever been synced (`unmapped`). Unknown is never a zero cost (03.3); a model
 *      opened while fully priced whose newest snapshot turned unknown is caught here —
 *      the defense-in-depth case the open action cannot see.
 *   4. `model_catalog_stale` — the injected freshness gate refused. The gate itself is
 *      03.6's contract (`assertCatalogFresh`); until 03.4/03.6 deliver it the seam is
 *      absent, and absent means this module never guesses freshness: nothing is excluded
 *      for staleness it did not observe.
 *
 * `free` IS A PRICE, `known` IS A PRICE: both pass the price question. Only indeterminable
 * bases fail it (AC06: 明确免费可与未知区分).
 *
 * THE ANSWER CARRIES NOTHING SENSITIVE. Selectable entries are bare `ModelRef` triples;
 * excluded entries add exactly one reason code. No scope reason, no operator identity, no
 * audit metadata, no upstream bytes, no configuration, no credential — the fields a filter
 * result could not legitimately need are the fields it cannot leak. The `requester` names
 * who asked, for the one structured log line only; it never enters the result.
 *
 * HONEST ABOUT THE COST. `isModelOpen` is consumed literally, once per capability-matching
 * ref, batched with `Promise.all` — scope semantics are 03.7's, never re-derived here. A
 * catalog of thousands pays a query per ref for that fidelity; a batched scope read is
 * 03.7's API to add, not this module's shortcut to take.
 */
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";
import {
  createEnterpriseGatewayCatalogStore,
  type GatewayCatalogStore,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelRef,
  modelRefKey,
} from "./catalog";
import type { GatewayModelScopeService } from "./model-scope";
import { gatewayModelScopeControls } from "./model-scope";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  type GatewayPriceSnapshotStore,
} from "./price-snapshot";

/**
 * Why one ref is not offered. Closed vocabulary — a new member is a contract
 * change (03.10/03.11 map these to display strings), never a free-text value.
 */
export const MODEL_EXCLUSION_REASONS = [
  "model_capability_mismatch",
  "model_not_open",
  "model_price_unknown",
  "model_catalog_stale",
] as const;

export type ModelExclusionReason = (typeof MODEL_EXCLUSION_REASONS)[number];

/**
 * The ref's price question, answered from 03.3's classification: `known` and
 * `free` are determinable prices; `unknown` and `unmapped` (no snapshot ever
 * synced) are not determinable, and a not-determinable price is never offered.
 */
export type ModelSelectionPriceStatus =
  | "known"
  | "free"
  | "unknown"
  | "unmapped";

/** Everything the decision needs, already resolved — the pure seam above the stores. */
export type ModelSelectionDecisionInput = {
  /** The ref's capability is one the bot declared (an `unknown`-capability ref never is). */
  capabilityMatch: boolean;
  /** 03.7's `isModelOpen` answer. */
  open: boolean;
  /** The injected freshness gate's answer; `true` while no gate is connected. */
  fresh: boolean;
  /** The latest snapshot's classification status, or `unmapped`. */
  priceStatus: ModelSelectionPriceStatus;
};

export type ModelSelectionDecision =
  | { selectable: true }
  | { selectable: false; reasonCode: ModelExclusionReason };

/**
 * The exclusion decision and its precedence: capability mismatch → not open →
 * price unknown → catalog stale. Pure — no store, no network, no clock — so the
 * vocabulary and the order are pinned by plain unit tests, independent of SQL.
 */
export function classifyModelSelection(
  input: ModelSelectionDecisionInput,
): ModelSelectionDecision {
  if (!input.capabilityMatch) {
    return { selectable: false, reasonCode: "model_capability_mismatch" };
  }
  if (!input.open) {
    return { selectable: false, reasonCode: "model_not_open" };
  }
  if (input.priceStatus !== "known" && input.priceStatus !== "free") {
    return { selectable: false, reasonCode: "model_price_unknown" };
  }
  if (!input.fresh) {
    return { selectable: false, reasonCode: "model_catalog_stale" };
  }
  return { selectable: true };
}

/** A capability a bot may declare: the catalog's closed set, minus the honest `unknown`. */
export type BotCapability = Exclude<ModelCapability, "unknown">;

/** Who is asking. Attribution for the log line only — never part of the answer. */
export const MODEL_SELECTION_REQUESTER_KINDS = ["user", "bot_service"] as const;

export type ModelSelectionRequesterKind =
  (typeof MODEL_SELECTION_REQUESTER_KINDS)[number];

export type ModelSelectionRequester = {
  kind: ModelSelectionRequesterKind;
  id: string;
};

/** One ref the bot cannot be offered, and the one fixed reason why. */
export type ModelExclusionEntry = {
  ref: ModelRef;
  reasonCode: ModelExclusionReason;
};

/** The whole answer: offered refs, and every other ref with its reason. */
export type ModelSelectionResult = {
  /** Bare ModelRefs — no metadata rides along (nothing to leak). */
  selectable: ModelRef[];
  excluded: ModelExclusionEntry[];
};

/** What the filter consumes: 03.1's catalog, 03.2/03.3's prices, 03.7's scope answer. */
export type GatewayModelCapabilityFilterDeps = {
  catalog: GatewayCatalogStore;
  priceSnapshots: GatewayPriceSnapshotStore;
  /** 03.7's service — `isModelOpen` is consumed literally, never re-derived. */
  scopes: Pick<GatewayModelScopeService, "isModelOpen">;
  /**
   * 03.6's freshness gate, once it delivers `assertCatalogFresh`; absent means
   * staleness is not observable, and nothing is excluded for it. Never guessed.
   */
  isCatalogFresh?: (ref: ModelRef) => boolean | Promise<boolean>;
  log?: Logger;
};

export type GatewayModelCapabilityFilterService = {
  /**
   * Which catalog refs this bot may be offered: capability-matching, open,
   * price-determinable (and fresh, when a gate is connected), with every other
   * ref excluded under its one reason code. Refuses a malformed capability set
   * or requester before touching a store. Store failures throw — never a
   * silently empty answer.
   */
  listSelectableModels(
    botCapabilities: readonly BotCapability[],
    requester: ModelSelectionRequester,
  ): Promise<ModelSelectionResult>;
};

/** A bot cannot declare the honest `unknown`, and cannot declare nothing. */
function assertBotCapabilities(
  value: readonly unknown[],
): asserts value is readonly BotCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      "A bot's capability set must be a non-empty subset of the catalog's capability vocabulary.",
    );
  }
  for (const capability of value) {
    if (
      typeof capability !== "string" ||
      !MODEL_CAPABILITIES.includes(capability as ModelCapability) ||
      capability === "unknown"
    ) {
      throw new TypeError(
        `A bot cannot declare capability ${JSON.stringify(capability)}: declare a non-empty subset of ${MODEL_CAPABILITIES.filter((entry) => entry !== "unknown").join(", ")}.`,
      );
    }
  }
}

/** The requester is log attribution; its shape is still part of this module's contract. */
function assertRequester(value: ModelSelectionRequester): void {
  if (
    !MODEL_SELECTION_REQUESTER_KINDS.includes(value?.kind as never) ||
    typeof value?.id !== "string" ||
    value.id.trim() === ""
  ) {
    throw new TypeError(
      `A model selection requester names who asks: kind ${MODEL_SELECTION_REQUESTER_KINDS.join(" or ")}, non-empty id.`,
    );
  }
}

export function createGatewayModelCapabilityFilterService(
  deps: GatewayModelCapabilityFilterDeps,
): GatewayModelCapabilityFilterService {
  const log = deps.log ?? getLogger("server");

  return {
    async listSelectableModels(botCapabilities, requester) {
      // Input contract first: a malformed call is a caller bug, refused before
      // any store is touched.
      assertBotCapabilities(botCapabilities);
      assertRequester(requester);

      // One read each: the universe (03.1's last-good refs) and the price
      // verdict per ref (03.2's latest snapshot, 03.3's classification).
      const [refs, snapshots] = await Promise.all([
        deps.catalog.readCatalogRefs(),
        deps.priceSnapshots.listLatestPriceSnapshots(),
      ]);
      const priceStatusByRef = new Map(
        snapshots.map((snapshot) => [
          modelRefKey(snapshot.ref),
          snapshot.classification.status as ModelSelectionPriceStatus,
        ]),
      );

      const capabilitySet = new Set<string>(botCapabilities);
      const judged = refs.map((entry) => {
        const capabilityMatch = capabilitySet.has(entry.ref.capability);
        const priceStatus =
          priceStatusByRef.get(modelRefKey(entry.ref)) ?? "unmapped";
        return { ref: entry.ref, capabilityMatch, priceStatus };
      });

      // Capability-mismatched refs are already decided; the rest need 03.7's
      // answer (and, when connected, the freshness gate's). Both batched.
      const needingScope = judged.filter(
        (decision) => decision.capabilityMatch,
      );
      const freshness = deps.isCatalogFresh;
      const [openFlags, freshFlags] = await Promise.all([
        Promise.all(
          needingScope.map((decision) => deps.scopes.isModelOpen(decision.ref)),
        ),
        freshness
          ? Promise.all(
              needingScope.map((decision) =>
                Promise.resolve(freshness(decision.ref)),
              ),
            )
          : Promise.resolve(undefined),
      ]);

      const selectable: ModelRef[] = [];
      const excluded: ModelExclusionEntry[] = [];
      let cursor = 0;
      for (const decision of judged) {
        if (!decision.capabilityMatch) {
          excluded.push({
            ref: decision.ref,
            reasonCode: "model_capability_mismatch",
          });
          continue;
        }
        const open = openFlags[cursor] === true;
        const fresh = freshFlags === undefined || freshFlags[cursor] === true;
        cursor += 1;
        const outcome = classifyModelSelection({
          capabilityMatch: true,
          open,
          fresh,
          priceStatus: decision.priceStatus,
        });
        if (outcome.selectable) {
          selectable.push(decision.ref);
        } else {
          excluded.push({ ref: decision.ref, reasonCode: outcome.reasonCode });
        }
      }

      // Counts only: refs are directory metadata, the requester's id stays out
      // of any result, and the log line names no model.
      log.info(
        {
          type: "gateway-model-selection",
          requesterKind: requester.kind,
          requesterId: requester.id,
          catalogRefs: refs.length,
          selectableCount: selectable.length,
          excludedCount: excluded.length,
        },
        "Model selection computed for the bot's capabilities.",
      );

      // The store's (provider, model, capability) order flows through: the
      // answer is deterministic for the same directory state.
      return { selectable, excluded };
    },
  };
}

/**
 * The running filter, resolved through the installed enterprise controls so the downstream
 * routes (03.10/03.11) need no wiring of their own: the catalog and price stores over the
 * shared database and 03.7's scope service. Undefined in a test or script that never
 * installed the controls — the same answer the sibling accessors give. The freshness seam
 * stays unconnected until 03.4/03.6 deliver the gate.
 */
export function gatewayModelCapabilityFilterControls():
  | GatewayModelCapabilityFilterService
  | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  const scopes = gatewayModelScopeControls();
  if (!scopes) return undefined;
  return createGatewayModelCapabilityFilterService({
    catalog: createEnterpriseGatewayCatalogStore(controls.deps.database),
    priceSnapshots: createEnterpriseGatewayPriceSnapshotStore(
      controls.deps.database,
    ),
    scopes,
    log: getLogger("server"),
  });
}
