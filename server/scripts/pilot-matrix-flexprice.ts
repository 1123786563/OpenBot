import { eq } from "drizzle-orm";
import type { loadFlexpriceUsageExporter } from "../src/billing/flexprice-usage";
import type { Database } from "../src/db/client";
import { lagoUsageEvents } from "../src/db/schema";
import { PilotEvidenceFailure } from "./pilot-matrix-manifest";

export async function reconcilePilotMatrixFlexprice(
  database: Database,
  loadExporter: () => ReturnType<typeof loadFlexpriceUsageExporter>,
  operationIds: readonly string[],
) {
  if (operationIds.length !== 2 || new Set(operationIds).size !== 2)
    throw new PilotEvidenceFailure(
      "model_switch_incomplete",
      "The target must settle both model-switch operations before Flexprice reconciliation.",
    );

  const exporter = loadExporter();
  if (!exporter) throw new Error("Flexprice usage exporter is not configured.");
  const reconciled = [];
  for (const operationId of operationIds) {
    const rows = await database
      .select({ eventId: lagoUsageEvents.eventId })
      .from(lagoUsageEvents)
      .where(eq(lagoUsageEvents.operationId, operationId))
      .limit(2);
    const [row] = rows;
    if (!row)
      throw new PilotEvidenceFailure(
        "flexprice_event_missing",
        `No settled usage event for ${operationId}.`,
      );
    if (rows.length > 1)
      throw new PilotEvidenceFailure(
        "flexprice_event_unmatched",
        `Multiple settled usage events for ${operationId}.`,
      );
    let result = await exporter.reconcileEvent(row.eventId);
    for (let retry = 0; result === "missing" && retry < 4; retry++) {
      await Bun.sleep(1_000);
      result = await exporter.reconcileEvent(row.eventId);
    }
    if (result !== "matched")
      throw new PilotEvidenceFailure(
        "flexprice_event_unmatched",
        `Flexprice did not match ${operationId}.`,
      );
    reconciled.push({ operationId, eventId: row.eventId });
  }
  return reconciled;
}
