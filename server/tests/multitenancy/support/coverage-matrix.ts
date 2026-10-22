/**
 * Shared helpers for the MT133–MT135 coverage-evidence suites (built on the
 * MT132 identity-matrix runner).
 *
 * The coverage suites map REAL route entrances from the MT001 inventory to
 * REAL scenario observations produced by the domain fixtures, run the matrix
 * runner over that plan, and assert both sides of every mapped entrance are
 * covered. This module keeps the three suites' boilerplate identical: the
 * drift guard for entrance ids and the adapter-from-scenario-map factory.
 */

import type { CoverageInventory } from "../../../../scripts/multitenancy/inventory";
import type { DomainScenarioAdapter, IsolationObservation } from "./scenarios";

/**
 * Asserts an entrance id exists in the real inventory. A renamed or removed
 * route must fail loudly here — silently dropping it from the plan would
 * manufacture coverage that no longer matches the deployed surface.
 */
export function requireEntrance(
  inventory: CoverageInventory,
  entranceId: string,
): void {
  const known = inventory.entrances.some((entry) => entry.id === entranceId);
  if (!known) {
    throw new Error(
      `COVERAGE_ENTRANCE_NOT_IN_INVENTORY:${entranceId}: the route surface changed; update the coverage plan`,
    );
  }
}

/** Scenario map: id -> real observation-producing case. */
export type ScenarioMap = Readonly<
  Record<string, () => Promise<IsolationObservation>>
>;

/**
 * Builds a domain adapter from a scenario map. Unknown ids are loud errors,
 * never synthetic observations — an absent scenario is an uncovered fact.
 */
export function adapterFromScenarios(
  scenarios: ScenarioMap,
): DomainScenarioAdapter {
  return {
    async run(scenarioId: string): Promise<IsolationObservation> {
      const scenario = scenarios[scenarioId];
      if (!scenario) {
        throw new Error(`COVERAGE_SCENARIO_UNKNOWN:${scenarioId}`);
      }
      return scenario();
    },
  };
}
