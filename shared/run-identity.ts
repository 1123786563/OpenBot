import { createHash } from "node:crypto";

/** The W3C root span id shared by execution and the optional observation adapter. */
export function runRootSpanId(traceId: string): string {
  const root = createHash("sha256")
    .update(`openbot.run.root:${traceId}`)
    .digest("hex")
    .slice(0, 16);
  return /^0+$/.test(root) ? "0000000000000001" : root;
}
