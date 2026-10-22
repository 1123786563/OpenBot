import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  type CatalogEntry,
  GATEWAY_CATALOG_SOURCE,
  MODEL_CAPABILITIES,
  type ModelRef,
  modelRefKey,
  normalizeGatewayModelCatalog,
} from "../src/gateway/catalog";

/*
 * Bifrost 03.1 — ModelRef normalization, at the pure seam (no database, no
 * network). Fixtures are shaped like what the real gateway answers on
 * `GET /v1/models` (`{ data: [Model] }`, `Model.id` always
 * `"<provider>/<model>"`, capability hints on `supported_methods`).
 *
 * What this file pins: the ModelRef triple is the only identity a catalog
 * entry gets — same model name on two providers never merges — and a model
 * whose capability cannot be derived is recorded as `unknown` *with the
 * reason it is unknown*, never silently relabeled a chat model.
 */

/** One raw `/v1/models` entry, the way the gateway sends it. */
function rawModel(overrides: {
  id: string;
  supported_methods?: string[];
  [key: string]: unknown;
}) {
  return overrides;
}

describe("ModelRef identity", () => {
  test("the same model name on two providers produces two ModelRefs — never merged", () => {
    const result = normalizeGatewayModelCatalog({
      data: [
        rawModel({
          id: "openai/gpt-4o",
          supported_methods: ["chat"],
        }),
        rawModel({
          id: "azure/gpt-4o",
          supported_methods: ["chat"],
        }),
      ],
    });

    expect(result.issues).toEqual([]);
    const keys = result.entries.map((entry) => modelRefKey(entry.ref));
    expect(keys).toContain("openai|gpt-4o|chat");
    expect(keys).toContain("azure|gpt-4o|chat");
    expect(result.entries).toHaveLength(2);

    const refs = result.entries.map((entry) => entry.ref);
    expect(refs).toContainEqual({
      provider: "openai",
      model: "gpt-4o",
      capability: "chat",
    } satisfies ModelRef);
    expect(refs).toContainEqual({
      provider: "azure",
      model: "gpt-4o",
      capability: "chat",
    } satisfies ModelRef);
  });

  test("model names may contain slashes after the provider prefix", () => {
    const result = normalizeGatewayModelCatalog({
      data: [
        rawModel({
          id: "together/deepseek-ai/deepseek-r1",
          supported_methods: ["chat"],
        }),
      ],
    });
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.ref).toEqual({
      provider: "together",
      model: "deepseek-ai/deepseek-r1",
      capability: "chat",
    });
  });

  test("identical triples within one fetch are deduplicated", () => {
    const result = normalizeGatewayModelCatalog({
      data: [
        rawModel({ id: "openai/gpt-4o", supported_methods: ["chat"] }),
        rawModel({ id: "openai/gpt-4o", supported_methods: ["chat"] }),
      ],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    // rawItemCount counts what the gateway actually sent, not what survived.
    expect(result.rawItemCount).toBe(2);
  });
});

describe("capability derivation", () => {
  test("a mapped supported_methods entry yields its capability", () => {
    const result = normalizeGatewayModelCatalog({
      data: [
        rawModel({
          id: "openai/text-embedding-3-small",
          supported_methods: ["embed"],
        }),
      ],
    });
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.ref.capability).toBe("embedding");
    expect(result.entries[0]?.capabilitySource).toBe("supported_methods");
    expect(result.entries[0]?.unknownReason).toBeUndefined();
  });

  test("one entry carrying several capabilities yields one ModelRef per capability", () => {
    const result = normalizeGatewayModelCatalog({
      data: [
        rawModel({
          id: "google/gemini-2.5-flash",
          supported_methods: ["embedContent", "generateContent"],
        }),
      ],
    });
    const capabilities = result.entries.map((entry) => entry.ref.capability);
    expect(capabilities).toContain("chat");
    expect(capabilities).toContain("embedding");
    expect(result.entries).toHaveLength(2);
  });

  test("an OCR supported_methods entry yields the ocr capability (Bifrost 11.5, #300)", () => {
    // The wire's own request-type token is "ocr" (schemas.OCRRequest); an entry naming
    // it becomes an ocr ref, so 03.2 can price it and 11.5's dimension mapping can
    // assess it — the closed set's newest member, on the same supported_methods
    // evidence every other capability rides.
    const result = normalizeGatewayModelCatalog({
      data: [
        rawModel({
          id: "mistral/mistral-ocr",
          supported_methods: ["ocr"],
        }),
      ],
    });
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.ref).toEqual({
      provider: "mistral",
      model: "mistral-ocr",
      capability: "ocr",
    });
    expect(MODEL_CAPABILITIES).toContain("ocr");
  });

  test("capability hints that map to nothing stay unknown, with the reason kept — never chat", () => {
    const result = normalizeGatewayModelCatalog({
      data: [
        rawModel({
          id: "openai/some-new-model",
          supported_methods: ["quantum-transmogrify"],
        }),
      ],
    });
    expect(result.entries).toHaveLength(1);
    const entry: CatalogEntry | undefined = result.entries[0];
    expect(entry?.ref).toEqual({
      provider: "openai",
      model: "some-new-model",
      capability: "unknown",
    });
    expect(entry?.unknownReason).toBe("catalog_capability_unrecognized");
    // The one thing the ticket forbids: quietly calling it a text model.
    expect(entry?.ref.capability).not.toBe("chat");
  });

  test("an entry with no capability signal at all stays unknown, with the reason kept", () => {
    const result = normalizeGatewayModelCatalog({
      data: [rawModel({ id: "openai/mystery-model" })],
    });
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.ref.capability).toBe("unknown");
    expect(entry?.unknownReason).toBe("catalog_capability_no_signal");
    expect(entry?.capabilitySource).toBe("none");
  });

  test("the capability set is closed: unknown is a member, nothing outside it is producible", () => {
    expect(MODEL_CAPABILITIES).toContain("unknown");
    const result = normalizeGatewayModelCatalog({
      data: [rawModel({ id: "openai/a", supported_methods: ["chat"] })],
    });
    for (const entry of result.entries) {
      expect(MODEL_CAPABILITIES).toContain(entry.ref.capability);
    }
  });
});

describe("entries that cannot become ModelRefs", () => {
  test("an id without a provider prefix is refused with a displayable reason, not guessed", () => {
    const result = normalizeGatewayModelCatalog({
      data: [rawModel({ id: "bare-model-name", supported_methods: ["chat"] })],
    });
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reasonCode).toBe("catalog_entry_provider_missing");
    expect(result.issues[0]?.index).toBe(0);
  });

  test("non-object entries and empty ids are refused with reasons, rawItemCount still counts them", () => {
    const result = normalizeGatewayModelCatalog({
      data: [null, rawModel({ id: "", supported_methods: ["chat"] }), 42],
    });
    expect(result.entries).toEqual([]);
    expect(result.issues.map((issue) => issue.reasonCode)).toEqual([
      "catalog_entry_not_object",
      "catalog_entry_provider_missing",
      "catalog_entry_not_object",
    ]);
    expect(result.rawItemCount).toBe(3);
  });
});

describe("response-level shape", () => {
  test("a payload without a data array is invalid, not an empty catalog", () => {
    expect(normalizeGatewayModelCatalog({ models: [] }).invalid).toBe(true);
    expect(normalizeGatewayModelCatalog("nope").invalid).toBe(true);
    expect(normalizeGatewayModelCatalog(null).invalid).toBe(true);
    expect(normalizeGatewayModelCatalog({ data: "not-an-array" }).invalid).toBe(
      true,
    );
  });

  test("the source the fetch record carries is a fixed constant, never upstream bytes", () => {
    expect(GATEWAY_CATALOG_SOURCE).toBe("gateway:/v1/models");
  });

  test("raw entries are retained on every produced ModelRef for audit and price re-check", () => {
    const raw = rawModel({ id: "openai/gpt-4o", supported_methods: ["chat"] });
    const result = normalizeGatewayModelCatalog({ data: [raw] });
    expect(result.entries[0]?.rawEntry).toEqual(raw);
  });
});
