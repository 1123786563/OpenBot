import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAppPluginSource } from "../src/craft/connect-app-plugin";
import { webappPluginSource } from "../src/craft/webapp-plugin";

/**
 * F-B (remediation-verification §3(ii)) — the plugins' SDK_TOOL_PATHS must
 * resolve in the DEPLOYED agent-sandbox layout. The verifier proved inside the
 * real container that opencode 1.18.7 materializes `@opencode-ai/plugin`:
 *
 *   - inside the session's own tree: <session>/.opencode/node_modules/
 *     @opencode-ai/plugin/dist/tool.js   (beside the .opencode/plugin/*.ts files
 *     the server ships), and
 *   - under its config dir: /config/opencode/node_modules/... (HOME and
 *     XDG_CONFIG_HOME are both the SANDBOX_CONFIG_DIR volume, /config).
 *
 * while neither onyx-image candidate (/home/sandbox/...) exists there. The
 * fixture below reproduces the deployed shape on disk — the shipped plugin
 * text at .opencode/plugin/, a fake-but-shaped SDK at
 * .opencode/node_modules/@opencode-ai/plugin/dist/tool.js — and imports the
 * plugin from that location, with no env hook set: it must register its tool.
 */

const root = mkdtempSync(join(tmpdir(), "craft-sdk-paths-"));

beforeAll(async () => {
  mkdirSync(join(root, ".opencode/plugin"), { recursive: true });
  mkdirSync(join(root, ".opencode/node_modules/@opencode-ai/plugin/dist"), {
    recursive: true,
  });
  // The SDK stub, shaped like the deployed dist/tool.js (one factory covering
  // every builder chain the two templates chain: number().int()/.optional(),
  // string().optional(), enum()).
  writeFileSync(
    join(root, ".opencode/node_modules/@opencode-ai/plugin/dist/tool.js"),
    [
      "const tool = (definition) => definition;",
      "const describe = (description) => ({ description });",
      "tool.schema = {",
      "  enum: (values) => ({ describe }),",
      "  number: () => ({ int: () => ({ describe }), optional: () => ({ describe }) }),",
      "  string: () => ({ optional: () => ({ describe }) }),",
      "};",
      "export { tool };",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".opencode/plugin/connect-app.ts"),
    await connectAppPluginSource(),
  );
  writeFileSync(
    join(root, ".opencode/plugin/webapp.ts"),
    await webappPluginSource(),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("plugin SDK resolution against the deployed sandbox layout (F-B)", () => {
  test("connect-app registers its tool via the SDK beside the plugin (no env hook)", async () => {
    const plugin = await import(join(root, ".opencode/plugin/connect-app.ts"));
    const factory = await plugin.default();
    const definition = (factory as { tool: Record<string, unknown> }).tool
      .connect_app as { description: string } | undefined;
    expect(definition).toBeDefined();
    expect(definition?.description).toContain("connect an org app");
  });

  test("webapp registers its tool via the SDK beside the plugin (env hook unset)", async () => {
    // The env candidate must NOT be what saves this import: the deployed
    // sandbox has no OPENBOT_PLUGIN_TOOL_HELPER.
    const saved = process.env.OPENBOT_PLUGIN_TOOL_HELPER;
    delete process.env.OPENBOT_PLUGIN_TOOL_HELPER;
    try {
      const plugin = await import(join(root, ".opencode/plugin/webapp.ts"));
      const factory = await plugin.default();
      const definition = (factory as { tool: Record<string, unknown> }).tool
        .webapp as { description: string } | undefined;
      expect(definition).toBeDefined();
      expect(definition?.description).toContain("web-app dev server");
    } finally {
      if (saved !== undefined) process.env.OPENBOT_PLUGIN_TOOL_HELPER = saved;
    }
  });

  test("both shipped sources carry the deployed candidates (and keep onyx's pair)", async () => {
    for (const source of [
      await connectAppPluginSource(),
      await webappPluginSource(),
    ]) {
      // Beside the plugin (relative from its own location — works in both
      // session-directory modes and any configDir mount).
      expect(source).toContain(
        'new URL("../node_modules/@opencode-ai/plugin/dist/tool.js", import.meta.url)',
      );
      // The config-dir materialization the verifier probed live (CONFIG-OK).
      expect(source).toContain(
        '"/config/opencode/node_modules/@opencode-ai/plugin/dist/tool.js"',
      );
      // onyx's image candidates stay (trailing misses are harmless; the list
      // is candidates-in-order for a reason).
      expect(source).toContain(
        '"/home/sandbox/.opencode/node_modules/@opencode-ai/plugin/dist/tool.js"',
      );
      expect(source).toContain(
        '"/home/sandbox/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.js"',
      );
    }
  });
});
