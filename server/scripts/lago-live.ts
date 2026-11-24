import { loadLagoUsageExporter } from "../src/billing/lago-usage";
import { createDatabase } from "../src/db/client";

const [mode, eventId] = process.argv.slice(2);
if (mode !== "flush" && !(mode === "reconcile" && eventId))
  throw new Error("Usage: lago-live.ts flush | reconcile <event-id>");

const database = createDatabase(process.env.DATABASE_URL ?? "");
try {
  const exporter = loadLagoUsageExporter(database, process.env);
  if (!exporter) throw new Error("Lago usage exporter is not configured.");
  const occurredAt = new Date().toISOString();
  if (mode === "reconcile") {
    const result = await exporter.reconcileEvent(eventId);
    console.log(JSON.stringify({ occurredAt, ...result }));
    if (result.result !== "matched") process.exitCode = 1;
  } else {
    const result = await exporter.flush();
    console.log(JSON.stringify({ occurredAt, ...result }));
    if (result.unavailable || result.paused > 0) process.exitCode = 1;
  }
} finally {
  await database.$client.close();
}
