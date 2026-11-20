import { asc } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { personalWorkspaceClosures } from "../src/db/schema";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "DATABASE_URL must point to the authoritative closure journal",
  );

const database = createDatabase(url);
try {
  const { id, accountId, workspaceId, acceptedAt } = personalWorkspaceClosures;
  const operations = await database
    .select({ id, accountId, workspaceId, acceptedAt })
    .from(personalWorkspaceClosures)
    .orderBy(asc(acceptedAt), asc(id));
  await Bun.write(Bun.stdout, JSON.stringify({ version: 1, operations }));
} finally {
  await database.$client.close();
}
