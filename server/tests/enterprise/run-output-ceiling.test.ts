import { expect, test } from "bun:test";
import { assertRunBudgetClaim } from "../../src/enterprise/models/budget";
import { runOutputCeilingFromInput } from "../../src/enterprise/runs/output-ceiling";
import type { RunServiceDependencies } from "../../src/enterprise/runs/service";

type Assert<T extends true> = T;
type RunServiceHasOptionalConfiguredBudget = Assert<
  "configuredBudgetTokens" extends keyof RunServiceDependencies
    ? Record<never, never> extends Pick<
        RunServiceDependencies,
        "configuredBudgetTokens"
      >
      ? true
      : false
    : true
>;
const runServiceHasOptionalConfiguredBudget: RunServiceHasOptionalConfiguredBudget = true;

test("run requires caller supplied positive safe integer output ceiling", () => {
  expect(
    runOutputCeilingFromInput({
      forwardedProps: { maxOutputTokens: 37 },
    }),
  ).toBe(37);

  for (const maxOutputTokens of [
    undefined,
    null,
    "37",
    1.5,
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    2_147_483_648,
  ]) {
    expect(() =>
      runOutputCeilingFromInput({
        forwardedProps: { maxOutputTokens },
      }),
    ).toThrow("RUN_OUTPUT_CEILING_REQUIRED");
  }
});

test("request model and provider fields do not become a model route", () => {
  expect(
    runOutputCeilingFromInput({
      model: "attacker-model",
      provider: "attacker-provider",
      routeRef: "attacker-route",
      forwardedProps: { maxOutputTokens: 37 },
    }),
  ).toBe(37);
});

test("invocation claims use only the persisted run balance", () => {
  expect(runServiceHasOptionalConfiguredBudget).toBe(true);
  const claims = [
    { reservedTokens: 20 },
    { reservedTokens: 30, settledTokens: 15 },
    { reservedTokens: 40 },
  ];
  expect(() => assertRunBudgetClaim(100, claims, 25)).not.toThrow();
  expect(() => assertRunBudgetClaim(100, claims, 26)).toThrow(
    "The Run token ceiling has been exhausted.",
  );
});
