import { describe, expect, test } from "../../tests/support/e2e-compat";

import { loadCraftConfig } from "../src/craft/config";

describe("loadCraftConfig enablement", () => {
  test("enables craft when OPENBOT_CRAFT_ENABLED is unset", () => {
    expect(loadCraftConfig({}).enabled).toBe(true);
  });

  test("treats empty OPENBOT_CRAFT_ENABLED as the enabled default", () => {
    expect(loadCraftConfig({ OPENBOT_CRAFT_ENABLED: "" }).enabled).toBe(true);
  });

  test("disables craft when explicitly false", () => {
    expect(loadCraftConfig({ OPENBOT_CRAFT_ENABLED: "false" }).enabled).toBe(
      false,
    );
  });

  test("disables craft when explicitly zero", () => {
    expect(loadCraftConfig({ OPENBOT_CRAFT_ENABLED: "0" }).enabled).toBe(false);
  });
});

describe("loadCraftConfig legacy preview switch (#425)", () => {
  test("defaults the legacy same-origin preview ON — existing sessions must not regress (AC7)", () => {
    expect(loadCraftConfig({}).legacyPreviewEnabled).toBe(true);
  });

  test("treats an empty declaration as the ON default", () => {
    expect(
      loadCraftConfig({ OPENBOT_CRAFT_LEGACY_PREVIEW_ENABLED: "" })
        .legacyPreviewEnabled,
    ).toBe(true);
  });

  test("an explicit false closes the legacy form", () => {
    expect(
      loadCraftConfig({ OPENBOT_CRAFT_LEGACY_PREVIEW_ENABLED: "false" })
        .legacyPreviewEnabled,
    ).toBe(false);
  });

  test("an explicit zero closes the legacy form (boolEnv's whole vocabulary)", () => {
    expect(
      loadCraftConfig({ OPENBOT_CRAFT_LEGACY_PREVIEW_ENABLED: "0" })
        .legacyPreviewEnabled,
    ).toBe(false);
  });
});
