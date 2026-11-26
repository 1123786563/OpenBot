import { eq } from "drizzle-orm";
import {
  createLagoUsageExporter,
  type LagoUsageClient,
} from "../src/billing/lago-usage";
import type { Database } from "../src/db/client";
import { lagoUsageEvents } from "../src/db/schema";
import { PilotEvidenceFailure } from "./pilot-matrix-manifest";

export async function reconcilePilotMatrixLago(
  database: Database,
  client: LagoUsageClient,
  operationIds: readonly string[],
) {
  if (operationIds.length !== 2 || new Set(operationIds).size !== 2)
    throw new PilotEvidenceFailure(
      "model_switch_incomplete",
      "The target must settle both model-switch operations before Lago reconciliation.",
    );

  const exporter = createLagoUsageExporter(database, client);
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
        "lago_event_missing",
        `No target Lago event for ${operationId}.`,
      );
    if (rows.length > 1)
      throw new PilotEvidenceFailure(
        "lago_event_unmatched",
        `Multiple target Lago events for ${operationId}.`,
      );
    let result = await exporter.reconcileEvent(row.eventId);
    if (result.result === "unchanged")
      result = await exporter.reconcileEvent(row.eventId);
    if (result.result !== "matched")
      throw new PilotEvidenceFailure(
        "lago_event_unmatched",
        `Lago did not match ${operationId}.`,
      );
    reconciled.push({ operationId, eventId: row.eventId });
  }
  return reconciled;
}
