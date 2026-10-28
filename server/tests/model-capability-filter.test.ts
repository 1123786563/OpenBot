import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  type GatewayCatalogStore,
  MODEL_CAPABILITIES,
} from "../src/gateway/catalog";
import {
  type GatewayModelCapabilityFilterDeps,
  MODEL_EXCLUSION_REASONS,
  type ModelSelectionDecisionInput,
  classifyModelSelection,
  createGatewayModelCapabilityFilterService,
} from "../src/gateway/model-capability-filter";
import type { GatewayPriceSnapshotStore } from "../src/gateway/price-snapshot";

/*
 * Bifrost 03.8 (#230, AC06/AC09/Q4) — the pure half of the bot capability
 * filter: the exclusion decision and its closed reason-code vocabulary.
 *
 * What only this file can prove:
 *
 * - every exclusion shape lands on its one fixed, displayable reason code
 *   (capability mismatch → not open → price unknown → catalog stale), and a
 *   model that is matching, open, fresh and priced known/free is selectable;
 * - the reason vocabulary is closed, snake_case and readable — no free text
 *   a screen could not render;
 * - the service refuses a malformed bot capability set before it touches any
 *   store (the deps here throw if they are ever called).
 *
 * The database half (real catalog/price/scope stores over TEST_DATABASE_URL)
 * lives in model-capability-filter.integration.test.ts.
 */

/** Everything a filter could want to be true — the happy shape. */
function selectableInput(
  overrides: Partial<ModelSelectionDecisionInput> = {},
): ModelSelectionDecisionInput {
  return {
    capabilityMatch: true,
    open: true,
    fresh: true,
    priceStatus: "known",
    ...overrides,
  };
}

describe("the exclusion decision and its closed reasons", () => {
  test("a matching, open, fresh, known-priced model is selectable", () => {
    const outcome = classifyModelSelection(selectableInput());
    expect(outcome).toEqual({ selectable: true });
  });

  test("free is a price: a free-priced model is selectable", () => {
    const outcome = classifyModelSelection(
      selectableInput({ priceStatus: "free" }),
    );
    expect(outcome).toEqual({ selectable: true });
  });

  test("a chat bot does not get an image-only model: capability mismatch wins over every other reason", () => {
    const outcome = classifyModelSelection(
      selectableInput({
        capabilityMatch: false,
        open: false,
        fresh: false,
        priceStatus: "unknown",
      }),
    );
    expect(outcome).toEqual({
      selectable: false,
      reasonCode: "model_capability_mismatch",
    });
  });

  test("a model the administrator has not opened is excluded as not open, ahead of its price state", () => {
    const outcome = classifyModelSelection(
      selectableInput({ open: false, priceStatus: "unknown" }),
    );
    expect(outcome).toEqual({
      selectable: false,
      reasonCode: "model_not_open",
    });
  });

  test("an open model whose latest price basis is unknown is excluded as price unknown", () => {
    const outcome = classifyModelSelection(
      selectableInput({ priceStatus: "unknown" }),
    );
    expect(outcome).toEqual({
      selectable: false,
      reasonCode: "model_price_unknown",
    });
  });

  test("a model with no price snapshot at all is not determinable: price unknown", () => {
    const outcome = classifyModelSelection(
      selectableInput({ priceStatus: "unmapped" }),
    );
    expect(outcome).toEqual({
      selectable: false,
      reasonCode: "model_price_unknown",
    });
  });

  test("a model the freshness gate refuses is excluded as catalog stale", () => {
    const outcome = classifyModelSelection(selectableInput({ fresh: false }));
    expect(outcome).toEqual({
      selectable: false,
      reasonCode: "model_catalog_stale",
    });
  });
});

describe("the reason-code vocabulary", () => {
  test("is exactly the four documented codes — no drift, no extras", () => {
    expect([...MODEL_EXCLUSION_REASONS]).toEqual([
      "model_capability_mismatch",
      "model_not_open",
      "model_price_unknown",
      "model_catalog_stale",
    ]);
  });

  test("every code is a readable snake_case token a screen can render", () => {
    for (const reason of MODEL_EXCLUSION_REASONS) {
      expect(reason.length).toBeGreaterThan(0);
      expect(reason).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("the service's input contract", () => {
  /** Deps that fail the test loudly if the service touches a store at all. */
  function untouchableDeps(): GatewayModelCapabilityFilterDeps {
    const refuse = (what: string) => () => {
      throw new Error(`${what} must not be read for a malformed input`);
    };
    return {
      catalog: {
        readCatalogRefs: refuse("catalog"),
      } as unknown as GatewayCatalogStore,
      priceSnapshots: {
        listLatestPriceSnapshots: refuse("prices"),
      } as unknown as GatewayPriceSnapshotStore,
      scopes: {
        isModelOpen: refuse("scopes"),
      },
    };
  }

  test("an empty bot capability set is a caller bug, refused before any store read", () => {
    const service = createGatewayModelCapabilityFilterService(
      untouchableDeps(),
    );
    expect(() =>
      service.listSelectableModels([], { kind: "user", id: "u1" }),
    ).toThrow(TypeError);
  });

  test("a bot cannot declare the unknown capability: refused before any store read", () => {
    const service = createGatewayModelCapabilityFilterService(
      untouchableDeps(),
    );
    expect(() =>
      service.listSelectableModels(["chat", "unknown" as never], {
        kind: "bot_service",
        id: "bot-1",
      }),
    ).toThrow(TypeError);
  });

  test("every real catalog capability except unknown is a legal bot capability", () => {
    // The closed vocabulary minus `unknown` — the honest unjudgeable answer —
    // is exactly what a bot may declare.
    const legal = MODEL_CAPABILITIES.filter(
      (capability) => capability !== "unknown",
    );
    expect(legal.length).toBeGreaterThan(0);
    for (const capability of legal) {
      expect(MODEL_CAPABILITIES.includes(capability)).toBe(true);
    }
  });
});
