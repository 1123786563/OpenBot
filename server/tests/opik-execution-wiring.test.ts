import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/bun-test-compat";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/**
 * The production wiring guard (T-routes review H1): the one boot assembly in
 * index.ts must hand the experiment submit routes a real execution billing
 * precheck. The review found the call answered without `executionBilling`, so
 * every production submit froze, then refused 402 EXECUTION_BUDGET_REFUSED —
 * the integration suites passed because the routes tests inject a precheck and
 * the boot tests bypass the routes, and nothing covered the seam BETWEEN them.
 * This guard reads the actual assembly source: if the wiring drops (or the
 * precheck stops being built from the deployment's billing machinery), it goes
 * red before a deployment can.
 */
const indexSource = readFileSync(
  join(hereDir, "..", "src", "assembly", "runtime.ts"),
  "utf8",
);

/** The production assembly call, sliced to its own block. */
const callStart = indexSource.indexOf(
  "const aiObservability = createAiObservabilityRoutes({",
);
const callEnd = callStart === -1 ? -1 : indexSource.indexOf("\n});", callStart);
const assemblyBlock =
  callStart === -1 || callEnd === -1
    ? ""
    : indexSource.slice(callStart, callEnd);

describe("the production ai-observability assembly wires the submit billing gate", () => {
  test("the assembly call is found (the guard tracks the real call site)", () => {
    expect(callStart).toBeGreaterThan(-1);
    expect(callEnd).toBeGreaterThan(callStart);
  });

  test("the production routes call passes executionBilling built from the real precheck", () => {
    expect(assemblyBlock).toContain("executionBilling:");
    expect(assemblyBlock).toContain("createExecutionBudgetPrecheck({");
  });

  test("the precheck is built from the deployment's billing machinery, the same parts the worker consumes", () => {
    expect(assemblyBlock).toContain("creditWriter: billing.creditWriter");
    expect(assemblyBlock).toContain(
      "externalCustomerId: billing.externalCustomerKey",
    );
  });

  test("the precheck factory is imported from the execution-billing module", () => {
    expect(indexSource).toMatch(
      /import\s*\{[^}]*createExecutionBudgetPrecheck[^}]*\}\s*from\s*"\.\.?\/ai-observability\/execution-billing"/,
    );
  });
});
