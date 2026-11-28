import { loadFlexpriceUsageExporter } from "../src/billing/flexprice-usage";
import { createDatabase } from "../src/db/client";

const database = createDatabase(process.env.DATABASE_URL ?? "");
try {
  const exporter = loadFlexpriceUsageExporter(database, process.env);
  if (!exporter) throw new Error("Flexprice usage exporter is not configured.");
  const result = await exporter.flush();
  console.log(JSON.stringify(result));
  if (result.unavailable || result.paused) process.exitCode = 1;
} finally {
  await database.$client.close();
}
