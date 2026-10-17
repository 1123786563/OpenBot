import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The workbench model picker's read and write (Bifrost 03.10, AC09/AC19) as
 * the model-access settings page drives them.
 *
 * The read is the display contract the server composes from 03.8/03.9/03.2 —
 * the selectable refs with the price status the snapshot holds, and the
 * effective resolution naming the layer it came from. There is nothing here
 * to interpret: an `available: false` verdict rides the stored ref with its
 * closed reason code, and the screen owns the sentence. No caller of this
 * module may fall back to a coarser layer or substitute a model — the server
 * already refuses to, and a client that did would only disagree with it.
 *
 * The write stores one preference layer and answers the server's own result,
 * refusals included: a `ok: false` is a 200-borne business refusal the screen
 * shows, never something this layer retries or papers over.
 */

/** One model the catalog offers: the identity triplet and nothing else. */
export type ModelRefView = {
  provider: string;
  model: string;
  capability: string;
};

/**
 * Why a selection on record may not be offerable right now. The closed
 * five-code vocabulary the server answers — 03.8's four exclusion reasons,
 * plus the ref having left the catalog entirely.
 */
export const MODEL_SELECTION_UNAVAILABLE_REASONS = [
  "model_capability_mismatch",
  "model_not_open",
  "model_price_unknown",
  "model_catalog_stale",
  "model_not_in_catalog",
] as const;

export type ModelSelectionUnavailableReason =
  (typeof MODEL_SELECTION_UNAVAILABLE_REASONS)[number];

/** The three layers a preference can come from, coarsest to most specific. */
export const MODEL_PREFERENCE_SCOPES = [
  "global",
  "bot",
  "conversation",
] as const;

export type ModelPreferenceScope = (typeof MODEL_PREFERENCE_SCOPES)[number];

/** The effective selection: the stored ref with its layer, or an honest unset. */
export type EffectiveModelView =
  | { status: "unset" }
  | {
      status: "resolved";
      ref: ModelRefView;
      source: ModelPreferenceScope;
      available: true;
    }
  | {
      status: "resolved";
      ref: ModelRefView;
      source: ModelPreferenceScope;
      available: false;
      unavailableReasonCode: ModelSelectionUnavailableReason;
    };

/** What `GET /api/model-selection` answers — the picker's whole world. */
export type ModelSelectionView = {
  bot: { botId: string; displayName: string };
  selectable: { ref: ModelRefView; priceStatus: string }[];
  effective: EffectiveModelView;
};

export const modelSelectionKeys = {
  all: ["model-selection"] as const,
  picker: () => [...modelSelectionKeys.all, "picker"] as const,
};

export function modelSelectionQueryOptions() {
  return queryOptions({
    queryKey: modelSelectionKeys.picker(),
    queryFn: async (): Promise<ModelSelectionView> => {
      // The answer is the payload itself — there is no envelope key to unwrap.
      const response = await client("/api/model-selection", {
        fallbackKey: "modelSelection.loadFailed",
      });
      return (await response.json()) as ModelSelectionView;
    },
  });
}

/** What `PUT /api/model-selection/preference` answers — success or the business refusal. */
export type ModelPreferenceWriteResultView =
  | {
      ok: true;
      record: {
        userId: string;
        scope: ModelPreferenceScope;
        botId: string;
        conversationId: string;
        ref: ModelRefView;
        updatedAt: string;
      };
    }
  | {
      ok: false;
      reasonCode: "model_preference_ref_not_selectable";
      detail?: string;
    };

/** What a write carries: the layer to store and the ref — the user is the session's fact. */
export type ModelPreferenceWriteInput = {
  scope: ModelPreferenceScope;
  ref: ModelRefView;
};

/**
 * Store one preference layer. A successful write invalidates the read so the
 * screen shows the server's new truth; a refusal changes nothing server-side,
 * so nothing is invalidated and the screen keeps showing what is actually on
 * record — the refusal sentence is the only new thing on it.
 */
export function setModelPreferenceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      input: ModelPreferenceWriteInput,
    ): Promise<ModelPreferenceWriteResultView> => {
      const response = await client("/api/model-selection/preference", {
        method: "PUT",
        body: input,
        fallbackKey: "modelSelection.writeFailed",
      });
      return (await response.json()) as ModelPreferenceWriteResultView;
    },
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({
          queryKey: modelSelectionKeys.all,
        });
      }
    },
  });
}
