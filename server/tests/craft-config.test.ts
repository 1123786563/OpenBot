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
