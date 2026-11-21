import { sql } from "drizzle-orm";

/** A lossless scope key, including registrations or IDs that contain separators. */
export function corsairGrantRef(
  workspaceId: string,
  registration: string,
  tool: string,
) {
  return sql<string>`jsonb_build_array(${workspaceId}::text, ${registration}::text, ${tool}::text)::text`;
}
