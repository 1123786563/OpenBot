import type { Database } from "../db/client";
import { loadFlexpriceUsageExporter } from "./flexprice-usage";
import { loadLagoUsageExporter } from "./lago-usage";

export function loadUsageExporter(
  database: Database,
  environment: Record<string, string | undefined>,
) {
  const flexprice = Object.keys(environment).some(
    (key) => key.startsWith("FLEXPRICE_") && environment[key],
  );
  if (
    flexprice &&
    [
      environment.LAGO_URL,
      environment.LAGO_API_KEY,
      environment.LAGO_USAGE_SUBSCRIPTION_ID,
    ].some(Boolean)
  )
    throw new Error("Configure exactly one usage billing destination.");
  return flexprice
    ? loadFlexpriceUsageExporter(database, environment)
    : loadLagoUsageExporter(database, environment);
}
