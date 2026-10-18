import { describe, expect, test } from "bun:test";
import * as schema from "../src/db/schema";

/**
 * The schema barrel is the one import path for every table (its own header's words).
 * R2-48 (R1-203 re-report): the barrel shipped four of the eight ai-observability
 * schema files and silently forgot the other four — executions, experiments,
 * execution-case-outcomes and retention — so imports through the barrel missed them
 * while direct-path imports kept working. This pins all eight files' tables (and
 * their vocabulary types' presence at runtime where the barrel decides reachability)
 * to the barrel.
 */
describe("the schema barrel carries every ai-observability table", () => {
  test("all eight ai-observability schema files' tables are reachable from the barrel", () => {
    const expected = [
      // ai-observability-bindings.ts
      "aiObservationBindings",
      // ai-observability-datasets.ts
      "aiObservationDatasets",
      "aiObservationDatasetVersions",
      // ai-observability-exports.ts
      "aiObservationExportJobs",
      // ai-observability-id-links.ts
      "aiObservationIdLinks",
      // ai-observability-executions.ts (R2-48)
      "aiObservationExperimentExecutions",
      // ai-observability-experiments.ts (R2-48)
      "aiObservationExperiments",
      // ai-observability-execution-case-outcomes.ts (R2-48)
      "aiObservationExecutionCaseOutcomes",
      // ai-observability-retention.ts (R2-48)
      "aiObservationRetentionOverrides",
      "aiObservationRetentionDeletions",
    ];
    for (const table of expected) {
      expect(schema, `barrel re-export: ${table}`).toHaveProperty(table);
    }
  });
});
