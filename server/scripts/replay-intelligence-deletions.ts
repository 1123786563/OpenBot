import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { replayIntelligenceDeletions } from "../src/recovery/replay-intelligence-deletions";

const authorityUrl = process.env.DELETION_AUTHORITY_DATABASE_URL;
const restoredUrl = process.env.DATABASE_URL;
if (!authorityUrl || !restoredUrl || authorityUrl === restoredUrl) {
  throw new Error(
    "Set DELETION_AUTHORITY_DATABASE_URL and DATABASE_URL to distinct databases",
  );
}

const config = loadConfig(process.env);
const authority = createDatabase(authorityUrl);
const restored = createDatabase(restoredUrl);
try {
  const counts = await replayIntelligenceDeletions({
    authority,
    restored,
    hindsight: config.hindsight,
    opik: config.opikEvaluation?.real,
  });
  console.info(JSON.stringify(counts));
} finally {
  await Promise.all([authority.$client.close(), restored.$client.close()]);
}
