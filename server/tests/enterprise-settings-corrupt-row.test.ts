import { expect, test } from "../../tests/support/bun-test-compat";
import {
  DEFAULT_ENTERPRISE_SETTINGS,
  createEnterpriseStore,
} from "../src/admin/settings-store";
import type { Database } from "../src/db/client";

/*
 * A corrupted settings row answers the default, and never takes the whole read down.
 *
 * The value column is `{ value }` JSON written only by the validating writer, so a row that
 * does not look like its key is a hand edit or tampering. The boolean and number branches
 * always answered the default for those; the list branch used to read properties straight off
 * whatever was stored, so an explicit null (or a scalar) threw a TypeError out of `settings()`
 * and every caller of the enterprise switches failed with it.
 */

function storeOver(rows: Array<{ key: string; value: unknown }>) {
  const database = {
    select() {
      return {
        from() {
          return Promise.resolve(rows);
        },
      };
    },
  } as unknown as Database;
  return createEnterpriseStore(database);
}

for (const corrupt of [null, 7, "enabled", [1, 2], true]) {
  test(`a list setting stored as ${JSON.stringify(corrupt)} answers its default`, async () => {
    const settings = await storeOver([
      { key: "model_allowlist", value: { value: corrupt } },
      { key: "mcp_allowlist", value: { value: corrupt } },
    ]).settings();
    expect(settings.modelAllowlist).toEqual(
      DEFAULT_ENTERPRISE_SETTINGS.modelAllowlist,
    );
    expect(settings.mcpAllowlist).toEqual(
      DEFAULT_ENTERPRISE_SETTINGS.mcpAllowlist,
    );
    // The rest of the settings still read: a corrupt row does not poison the surface.
    expect(settings.ssoRequired).toBe(DEFAULT_ENTERPRISE_SETTINGS.ssoRequired);
  });
}

test("a well-formed list row is still read, not replaced by the default", async () => {
  const settings = await storeOver([
    {
      key: "model_allowlist",
      value: { value: { enabled: true, models: ["anthropic/claude-test"] } },
    },
  ]).settings();
  expect(settings.modelAllowlist).toEqual({
    enabled: true,
    models: ["anthropic/claude-test"],
  });
});
