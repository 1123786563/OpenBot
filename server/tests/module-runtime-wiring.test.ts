import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";

/*
 * #704 (M-7 + C6): production wiring decisions for the assembly's enterprise
 * seams. runtime.ts imports `serve` from "bun" and cannot load in a Node test
 * process (ADR 0008), so — like module-runtime-lifecycle.test.ts — its wiring
 * is pinned from source. The behavior those pins guard: every long-lived
 * operator pool the assembly opens has a consumer, the plugin catalog keeps
 * its consumer, and the pinned-skill read stays wired into the production
 * runner composition.
 */
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
const RUNTIME_SOURCE = existsSync(join(hereDir, "../src/assembly/runtime.ts"))
  ? readFileSync(join(hereDir, "../src/assembly/runtime.ts"), "utf8")
  : "";

/** The five assembly locals that were unreachable: removed by name (#704). */
const REMOVED_SEAMS = [
  "personalShareRules",
  "credentialOwnership",
  "oauthState",
  "credentialLease",
  "sharedApprovals",
] as const;

describe("#704 production wiring (source pins)", () => {
  test("the five unreachable enterprise seams are no longer constructed in the assembly", () => {
    for (const name of REMOVED_SEAMS) {
      // The decision record lives in docs/plans/2026-10-29-issue704-production-wiring/
      // and the seam services survive in server/src/enterprise/tenancy/.
      expect(RUNTIME_SOURCE).not.toContain(`const ${name} = `);
    }
  });

  test("every operator pool the assembly opens belongs to a kept, consumed seam (#706 M-7)", () => {
    const pools = RUNTIME_SOURCE.match(/verifyOperatorDatabase\(/g) ?? [];
    // Kept seams that verify an operator database: the enterprise capability
    // bootstrap, the workspace-admin channel, the plugin catalog, and the
    // operator service entry (1482-context). Five dead pools were removed
    // with their blocks; this count is the floor that keeps them gone.
    expect(pools.length).toBeLessThanOrEqual(4);
    expect(pools.length).toBeGreaterThanOrEqual(1);
    // The kept plugin catalog still has its consumer.
    expect(RUNTIME_SOURCE).toContain(
      "catalogDecisions: pluginCatalog.decisions",
    );
    expect(RUNTIME_SOURCE).toContain("const pluginCatalog = ");
  });

  test("readPinnedSkills is wired into the production runner composition (C6)", () => {
    // The composition is what admitted package runs read through; the direct
    // behavior lives in server/tests/multitenancy/package-runtime.test.ts.
    expect(RUNTIME_SOURCE).toContain(
      "readPinnedSkills: packageRuntime.readPinnedSkills",
    );
    expect(RUNTIME_SOURCE).toContain(
      "readPinnedTools: packageRuntime.readPinnedTools",
    );
  });
});
