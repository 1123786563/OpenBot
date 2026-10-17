/**
 * The user's model preference layers (Bifrost 03.9, AC09/design Q16).
 *
 * THREE LAYERS, MOST SPECIFIC WINS. A user's effective model is resolved in the order
 * 用户全局默认 → 用户在该 Bot 的默认 → 当前会话选择 — the first layer that holds a
 * preference answers, and the answer names the layer it came from, so a picker can show
 * "why this model" and a debug session can see which cell to change. A layer with no
 * stored preference falls through to the coarser one; all three empty is an honest
 * `unset`, never an invented default.
 *
 * RESOLUTION DOES NOT SECOND-GUESS THE USER. It answers what is stored, even when that
 * ref has since closed or repriced — Q16 is explicit that an unavailable selection is a
 * visible error or a re-selection, never a silent switch, so falling through to a lower
 * layer on unavailability would be the one behavior this module must not grow. The
 * availability verdict belongs to the caller (03.10's picker, 06.2's admission), which
 * consumes 03.8's filter for exactly that.
 *
 * WRITES GATE ON 03.8, VERBATIM. Every write validates the target ModelRef against
 * `listSelectableModels` for the Bot context the write is made from — capability,
 * open scope, determinable price, freshness, all 03.8's own answers, never re-derived
 * here — and a ref outside the selectable list is refused with one fixed code and the
 * exclusion detail when the filter judged it. Nothing is re-selected: a refused write
 * changes nothing, so the previous preference keeps resolving exactly as before. The
 * Bot's capability set is an input, the same seam 03.8 draws — the routes that mount
 * this service (03.10's picker) resolve it from the Bot registry.
 *
 * ONE CELL PER IDENTITY. The storage key is (user, scope, bot, conversation); a
 * conversation selection is an upsert of exactly its own cell, so it cannot rewrite
 * what `global` or `bot` say — the isolation the AC demands is the key shape itself,
 * and the table's CHECK constraints hold the same line against any writer the service
 * fails to intercept.
 */
import { and, eq } from "drizzle-orm";
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";
import type { Database } from "../db/client";
import { gatewayModelPreferences } from "../db/schema";
import { type ModelCapability, type ModelRef, MODEL_CAPABILITIES, modelRefKey } from "./catalog";
import {
  gatewayModelCapabilityFilterControls,
  type BotCapability,
  type GatewayModelCapabilityFilterService,
  type ModelExclusionReason,
} from "./model-capability-filter";

/** The three layers, coarsest to most specific. A new member is a schema change. */
export const MODEL_PREFERENCE_SCOPES = [
  "global",
  "bot",
  "conversation",
] as const;

export type ModelPreferenceScope = (typeof MODEL_PREFERENCE_SCOPES)[number];

/**
 * Why a write was refused. Fixed codes of this module — displayable anywhere. The
 * vocabulary starts at one member because there is exactly one way a valid-shaped
 * preference write can be refused: the ref is not in the requester's selectable list.
 */
export const MODEL_PREFERENCE_WRITE_REFUSALS = [
  "model_preference_ref_not_selectable",
] as const;

export type ModelPreferenceWriteRefusalReason =
  (typeof MODEL_PREFERENCE_WRITE_REFUSALS)[number];

/** One stored preference: the identity it belongs to and the ModelRef it chose. */
export type ModelPreferenceRecord = {
  userId: string;
  scope: ModelPreferenceScope;
  /** The Bot the layer names — `''` for `global`, which names no Bot. */
  botId: string;
  /** The conversation the layer names — `''` for everything coarser than `conversation`. */
  conversationId: string;
  ref: ModelRef;
  /** When the preference was last written, ISO 8601. */
  updatedAt: string;
};

/** What a write answers — the stored record, or the one fixed refusal and its detail. */
export type ModelPreferenceWriteResult =
  | { ok: true; record: ModelPreferenceRecord }
  | {
      ok: false;
      reasonCode: ModelPreferenceWriteRefusalReason;
      /**
       * 03.8's own reason the ref is not selectable, when the filter judged it —
       * the displayable why. Absent when the ref is unknown to the catalog at all.
       */
      detail?: ModelExclusionReason;
    };

/** What resolution answers: the winning ref with its layer, or that nothing is set. */
export type EffectiveModelResolution =
  | { status: "resolved"; ref: ModelRef; source: ModelPreferenceScope }
  | { status: "unset" };

/** The identity one preference cell belongs to; the parts a scope does not name stay absent. */
export type ModelPreferenceIdentity = {
  userId: string;
  scope: ModelPreferenceScope;
  botId?: string;
  conversationId?: string;
};

/** Where the preferences persist; tests may supply their own. */
export type GatewayModelPreferenceStore = {
  /** The current record for one identity cell, or undefined when nobody ever wrote it. */
  getPreference(identity: ModelPreferenceIdentity): Promise<ModelPreferenceRecord | undefined>;
  /**
   * Write one identity cell — an insert or an overwrite of exactly that cell. The
   * caller owns validation against the selectable list; the store only keeps shape.
   */
  setPreference(
    identity: ModelPreferenceIdentity & { ref: ModelRef },
  ): Promise<ModelPreferenceRecord>;
};

/** Normalize one identity into its storage key, refusing shapes a scope cannot hold. */
function identityKey(identity: ModelPreferenceIdentity): {
  userId: string;
  scope: ModelPreferenceScope;
  botId: string;
  conversationId: string;
} {
  if (
    !MODEL_PREFERENCE_SCOPES.includes(identity.scope) ||
    typeof identity.userId !== "string" ||
    identity.userId.trim() === ""
  ) {
    throw new TypeError(
      `A model preference names a user and one of the scopes ${MODEL_PREFERENCE_SCOPES.join(", ")}.`,
    );
  }
  const botId = identity.botId ?? "";
  const conversationId = identity.conversationId ?? "";
  if (identity.scope === "global" && (botId !== "" || conversationId !== "")) {
    throw new TypeError(
      "The global default names neither a Bot nor a conversation; use the bot or conversation scope for those.",
    );
  }
  if (identity.scope === "bot") {
    if (typeof botId !== "string" || botId.trim() === "") {
      throw new TypeError(
        "A per-Bot default names the Bot it is the default for: botId is required.",
      );
    }
    if (conversationId !== "") {
      throw new TypeError(
        "A per-Bot default is not a conversation preference; use the conversation scope.",
      );
    }
  }
  if (identity.scope === "conversation") {
    if (typeof botId !== "string" || botId.trim() === "") {
      throw new TypeError(
        "A conversation selection names the Bot the session runs with: botId is required.",
      );
    }
    if (typeof conversationId !== "string" || conversationId.trim() === "") {
      throw new TypeError(
        "A conversation selection names the session it selects for: conversationId is required.",
      );
    }
  }
  return { userId: identity.userId, scope: identity.scope, botId, conversationId };
}

/** Strict read of one stored row; a damaged row is skipped, not repaired. */
function recordFromRow(row: {
  userId: string;
  scope: string;
  botId: string;
  conversationId: string;
  provider: string;
  model: string;
  capability: string;
  updatedAt: Date;
}): ModelPreferenceRecord | undefined {
  if (!MODEL_PREFERENCE_SCOPES.includes(row.scope as ModelPreferenceScope)) {
    return undefined;
  }
  if (!MODEL_CAPABILITIES.includes(row.capability as ModelCapability)) {
    return undefined;
  }
  return {
    userId: row.userId,
    scope: row.scope as ModelPreferenceScope,
    botId: row.botId,
    conversationId: row.conversationId,
    ref: {
      provider: row.provider,
      model: row.model,
      capability: row.capability as ModelCapability,
    },
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The preference store over `gateway_model_preferences` — the sibling pattern of the scope store. */
export function createEnterpriseGatewayModelPreferenceStore(
  database: Database,
): GatewayModelPreferenceStore {
  return {
    async getPreference(identity) {
      const key = identityKey(identity);
      const rows = await database
        .select()
        .from(gatewayModelPreferences)
        .where(
          and(
            eq(gatewayModelPreferences.userId, key.userId),
            eq(gatewayModelPreferences.scope, key.scope),
            eq(gatewayModelPreferences.botId, key.botId),
            eq(gatewayModelPreferences.conversationId, key.conversationId),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? recordFromRow(row) : undefined;
    },

    async setPreference(identity) {
      const key = identityKey(identity);
      const { ref } = identity;
      if (
        typeof ref?.provider !== "string" ||
        ref.provider.trim() === "" ||
        typeof ref.model !== "string" ||
        ref.model.trim() === "" ||
        !MODEL_CAPABILITIES.includes(ref.capability)
      ) {
        throw new TypeError(
          "A model preference names a complete ModelRef: provider, model and a capability from the catalog's closed set.",
        );
      }
      const [row] = await database
        .insert(gatewayModelPreferences)
        .values({
          userId: key.userId,
          scope: key.scope,
          botId: key.botId,
          conversationId: key.conversationId,
          provider: ref.provider,
          model: ref.model,
          capability: ref.capability,
        })
        .onConflictDoUpdate({
          target: [
            gatewayModelPreferences.userId,
            gatewayModelPreferences.scope,
            gatewayModelPreferences.botId,
            gatewayModelPreferences.conversationId,
          ],
          set: {
            provider: ref.provider,
            model: ref.model,
            capability: ref.capability,
            updatedAt: new Date(),
          },
        })
        .returning();
      const record = recordFromRow(row);
      if (!record) {
        throw new TypeError(
          `The stored preference row for ${key.userId}/${key.scope} came back outside the closed vocabularies; the table has been tampered with.`,
        );
      }
      return record;
    },
  };
}

/** What every write carries besides the identity: the ref and the 03.8 context. */
export type ModelPreferenceWriteInput = {
  userId: string;
  ref: ModelRef;
  /**
   * The target Bot's capability set — the context the selectable list is computed
   * from, the same seam 03.8 draws. The routes resolve it from the Bot registry.
   */
  botCapabilities: readonly BotCapability[];
};

export type GatewayModelPreferenceDeps = {
  /** The three-layer store. */
  preferences: GatewayModelPreferenceStore;
  /** 03.8's filter — the selectable list is consumed verbatim, never re-derived. */
  selectable: Pick<GatewayModelCapabilityFilterService, "listSelectableModels">;
  log?: Logger;
};

export type GatewayModelPreferenceService = {
  /**
   * The user's default everywhere, validated for the Bot context the write is made
   * from. One cell per user: an overwrite replaces, a refusal changes nothing.
   */
  setGlobalDefault(
    input: ModelPreferenceWriteInput,
  ): Promise<ModelPreferenceWriteResult>;
  /** The user's default for one Bot. */
  setBotDefault(
    input: ModelPreferenceWriteInput & { botId: string },
  ): Promise<ModelPreferenceWriteResult>;
  /** One session's selection, scoped to (user, bot, conversation) and nothing else. */
  setConversationSelection(
    input: ModelPreferenceWriteInput & {
      botId: string;
      conversationId: string;
    },
  ): Promise<ModelPreferenceWriteResult>;
  /**
   * The most specific layer that holds a preference, with the layer it came from —
   * or `unset` when none does. Never falls through on unavailability: the ref is
   * answered as stored, and the caller owns the unavailable-model error (Q16).
   */
  resolveEffectiveModel(input: {
    userId: string;
    botId: string;
    conversationId: string;
  }): Promise<EffectiveModelResolution>;
};

export function createGatewayModelPreferenceService(
  deps: GatewayModelPreferenceDeps,
): GatewayModelPreferenceService {
  const log = deps.log ?? getLogger("server");

  async function write(
    identity: ModelPreferenceIdentity,
    input: ModelPreferenceWriteInput,
  ): Promise<ModelPreferenceWriteResult> {
    // Shape first: a malformed call is a caller bug, refused before any read.
    const key = identityKey(identity);
    if (typeof input.ref !== "object" || input.ref === null) {
      throw new TypeError(
        "A model preference names a complete ModelRef: provider, model and a capability from the catalog's closed set.",
      );
    }

    // The one business question: is this ref in the requester's selectable list?
    // 03.8 answers — capability, scope, price and freshness are its verdicts, not
    // re-derived here. The requester is the user whose preference this is.
    const selection = await deps.selectable.listSelectableModels(
      input.botCapabilities,
      { kind: "user", id: key.userId },
    );
    const wanted = modelRefKey(input.ref);
    if (!selection.selectable.some((ref) => modelRefKey(ref) === wanted)) {
      const detail = selection.excluded.find(
        (entry) => modelRefKey(entry.ref) === wanted,
      )?.reasonCode;
      log.info(
        {
          type: "gateway-model-preference-write-refused",
          userId: key.userId,
          scope: key.scope,
          reasonCode: "model_preference_ref_not_selectable",
          detail: detail ?? "model_not_in_catalog",
        },
        "Model preference write refused: the ref is outside the requester's selectable list.",
      );
      return {
        ok: false,
        reasonCode: "model_preference_ref_not_selectable",
        ...(detail === undefined ? {} : { detail }),
      };
    }

    const record = await deps.preferences.setPreference({ ...identity, ref: input.ref });
    // Counts and layer only: the chosen ref is the user's own answer, and the log
    // line exists to trace refusals and layer churn, not to duplicate the table.
    log.info(
      {
        type: "gateway-model-preference-written",
        userId: key.userId,
        scope: key.scope,
      },
      "Model preference stored.",
    );
    return { ok: true, record };
  }

  return {
    setGlobalDefault(input) {
      return write({ userId: input.userId, scope: "global" }, input);
    },

    setBotDefault(input) {
      return write(
        { userId: input.userId, scope: "bot", botId: input.botId },
        input,
      );
    },

    setConversationSelection(input) {
      return write(
        {
          userId: input.userId,
          scope: "conversation",
          botId: input.botId,
          conversationId: input.conversationId,
        },
        input,
      );
    },

    async resolveEffectiveModel({ userId, botId, conversationId }) {
      // Three reads, one answer: the most specific cell that exists. The identity
      // checks run per read, so a malformed user id or session id is still a
      // caller bug even on the resolution path.
      const [conversation, bot, global] = await Promise.all([
        deps.preferences.getPreference({
          userId,
          scope: "conversation",
          botId,
          conversationId,
        }),
        deps.preferences.getPreference({ userId, scope: "bot", botId }),
        deps.preferences.getPreference({ userId, scope: "global" }),
      ]);
      if (conversation) {
        return { status: "resolved", ref: conversation.ref, source: "conversation" };
      }
      if (bot) {
        return { status: "resolved", ref: bot.ref, source: "bot" };
      }
      if (global) {
        return { status: "resolved", ref: global.ref, source: "global" };
      }
      return { status: "unset" };
    },
  };
}

/**
 * The running preference service, resolved through the installed enterprise controls so
 * the downstream routes (03.10's picker, 09.1's workbench calls) need no wiring of their
 * own: the preference store over the shared database and 03.8's filter. Undefined in a
 * test or script that never installed the controls — the same answer the sibling
 * accessors give.
 */
export function gatewayModelPreferenceControls():
  | GatewayModelPreferenceService
  | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  const selectable = gatewayModelCapabilityFilterControls();
  if (!selectable) return undefined;
  return createGatewayModelPreferenceService({
    preferences: createEnterpriseGatewayModelPreferenceStore(controls.deps.database),
    selectable,
    log: getLogger("server"),
  });
}
