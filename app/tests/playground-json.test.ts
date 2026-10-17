import "./preload";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import i18n from "../src/lib/i18n";
import {
  parseJsonObject,
  validatePlaygroundDraft,
} from "../src/routes/_authed/admin/playground";

// The suite's preload initializes i18n with English, so a fixed-t bound here renders the exact
// sentences these assertions were written against.
const t = i18n.getFixedT(null, "admin");

const draft = {
  slug: "s8_visual_check",
  title: "S8 visual check",
  description: "A draft with explicit JSON editor state.",
  html: "<div></div>",
  css: "",
  jsFunctions: "",
  argumentSchema: '{ "type": "object" }',
  sampleArguments: '{ "title": "Saved exactly" }',
};

describe("playground JSON editors", () => {
  test("reject malformed JSON instead of producing an empty object payload", () => {
    const result = validatePlaygroundDraft(
      { ...draft, sampleArguments: "{" },
      t,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fields.sampleArguments).toContain(
        "Sample arguments must be valid JSON",
      );
    }
  });

  test.each(["[]", "null", '"text"'])(
    "rejects %p because the editors must contain objects",
    (raw) => {
      const result = parseJsonObject(raw, "Sample arguments", t);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("must be a JSON object");
      }
    },
  );

  test("preserves typed object JSON in the save payload", () => {
    const result = validatePlaygroundDraft(draft, t);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.argumentSchema).toEqual({ type: "object" });
      expect(result.input.sampleArguments).toEqual({ title: "Saved exactly" });
    }
  });
});
