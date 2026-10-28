/*
 * Bun resolves eventsource@3 through its `bun` export before its `require` export. The MCP SDK's
 * CommonJS SSE transport still requires eventsource, so the production process evaluates the ESM
 * module once before the runtime can reach that CJS require. This ordering is Bun-specific (Node
 * would evaluate two separate module instances) and is pinned by
 * server/tests/production-loader-boundary.test.ts — re-run that test when either dependency
 * upgrades.
 */
import "eventsource";

// A bare top-level rejection lands as an unlabelled stack in server.log; name the failure so the
// reason a boot did not complete is findable in the log it is redirected to.
try {
  await import("./index");
} catch (error) {
  process.stderr.write(
    `The server failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
