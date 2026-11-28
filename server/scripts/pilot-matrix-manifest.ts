import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export const pilotDeployment = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  sourceCommit: z.string().regex(/^(?!0+$)(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  buildVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/),
  imageDigest: z.string().regex(/^sha256:(?!0+$)[a-f0-9]{64}$/),
});

export type PilotProvenance =
  | { evidence: "fixture"; deployment?: undefined }
  | { evidence: "deployment"; deployment: z.infer<typeof pilotDeployment> };

const failureReasons = z.enum([
  "scenario_failed",
  "product_request_failed",
  "gateway_boundary_unverified",
  "model_switch_incomplete",
  "flexprice_event_missing",
  "flexprice_event_unmatched",
  "lago_event_missing",
  "lago_event_unmatched",
]);

export type PilotFailureReason = z.infer<typeof failureReasons>;

export class PilotEvidenceFailure extends Error {
  constructor(
    readonly reason: PilotFailureReason,
    message: string,
  ) {
    super(message);
  }
}

export function pilotFailureReason(error: unknown): PilotFailureReason {
  return error instanceof PilotEvidenceFailure
    ? error.reason
    : "scenario_failed";
}

type PilotScenario = {
  scenario: string;
  operationIds: readonly string[];
} & ({ outcome: "pass" } | { outcome: "fail"; reason: PilotFailureReason });

const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

export async function writePilotMatrixManifest(
  runDir: string,
  provenance: PilotProvenance,
  startedAt: number,
  results: readonly PilotScenario[],
) {
  const deployment =
    provenance.evidence === "deployment"
      ? pilotDeployment.parse(provenance.deployment)
      : null;
  // Project the public fields. Error text, payloads, credentials and local paths
  // can occur anywhere in the raw report, including values with innocuous keys.
  const scenarios = results.map((result) => ({
    scenario: safeId.parse(result.scenario),
    outcome: result.outcome,
    operationIds: [
      ...new Set(result.operationIds.map((id) => safeId.parse(id))),
    ],
    ...(result.outcome === "fail"
      ? { reason: failureReasons.parse(result.reason) }
      : {}),
  }));
  const failed = scenarios.filter(({ outcome }) => outcome === "fail").length;
  const report = {
    manifest: "openbot.pilot-matrix/v1",
    ticket: 158,
    evidence: provenance.evidence,
    creditScope: "test",
    deployment,
    startedAt: new Date(startedAt).toISOString(),
    rerun: "bun --no-env-file server/scripts/pilot-matrix.ts <run-dir>",
    passed: scenarios.length - failed,
    failed,
    scenarios,
  };
  const deploymentRef = deployment
    ? `pilot-matrix/${deployment.id}/${deployment.sourceCommit}/${deployment.buildVersion}/${deployment.imageDigest}`
    : null;
  const runDigest = createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex");
  const manifest = {
    ...report,
    deploymentRef,
    rampRef: deploymentRef ? `${deploymentRef}/runs/${runDigest}` : null,
  };
  await Bun.write(
    join(runDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
