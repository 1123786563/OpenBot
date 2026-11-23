import { z } from "zod";
import { createDatabase } from "../src/db/client";
import { createBifrostMarket } from "../src/skill-market/bifrost";
import { bifrostNamespace, skillHubOrigin } from "../src/skill-market/config";
import {
  applySkillMarketReceipt,
  receiptScope,
} from "./skill-migration/receipt";

async function main() {
  const [path, ...extra] = Bun.argv.slice(2);
  if (!path || extra.length)
    throw new Error("Supply one verified receipt file.");
  const env = process.env;
  const expected = receiptScope.parse({
    snapshotId: env.SKILLHUB_MIGRATION_SNAPSHOT_ID,
    source: {
      source: skillHubOrigin(env.SKILLHUB_URL ?? ""),
      namespace: env.SKILLHUB_CATALOG_NAMESPACE,
    },
    target: {
      registryId: env.BIFROST_MIGRATION_REGISTRY_ID,
      namespace: bifrostNamespace,
    },
  });
  const databaseUrl = z.string().min(1).parse(env.DATABASE_URL);
  const readerUrl = z
    .string()
    .min(1)
    .parse(env.BIFROST_SKILL_MARKET_DATABASE_URL);
  const input: unknown = await Bun.file(path).json();
  const database = createDatabase(databaseUrl);
  const market = createBifrostMarket({
    kind: "bifrost",
    namespace: bifrostNamespace,
    databaseUrl: readerUrl,
  });
  try {
    return await applySkillMarketReceipt(database, market, expected, input);
  } finally {
    await Promise.all([market.close(), database.$client.close()]);
  }
}

try {
  process.stdout.write(`${await main()}\n`);
} catch (error) {
  const message =
    error instanceof z.ZodError
      ? `Invalid receipt or settings (${error.issues.map(({ path }) => path.join(".")).join(", ")})`
      : error instanceof Error && error.constructor === Error
        ? error.message
        : "Could not verify or record the cutover receipt.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
