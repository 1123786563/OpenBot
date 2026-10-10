/**
 * The standalone enterprise entry, per plan 02 §7 T3-C step 2.
 *
 * This file owns ONLY the process lifecycle: read the configuration, bootstrap the real
 * dependencies (which refuses to return until every login's database roles and the enterprise
 * schema boundary have been verified live), listen, and on SIGTERM/SIGINT drain within the
 * configured window — ready=false first so orchestrators stop routing, then stop accepting and let
 * in-flight requests finish, and only past `shutdownGraceMs` force-close them; the database pools
 * close after the listener either way. It shares no implicit global state with the bootstrap: the
 * three lifecycle handles (`beginDrain`, `close`, and the app behind `fetch`) are everything it
 * touches.
 *
 * Run as `bun run start:enterprise` (or `dev:enterprise` to watch). `--no-env-file` in those
 * scripts keeps this entry from inheriting the legacy deployment's `.env`: its configuration comes
 * from the deployment environment — an operator's injected secret store, or an explicit
 * `--env-file` for local runs — never from a file that happens to sit in the working directory.
 */
import { bootstrapEnterprise } from "./bootstrap";
import { loadEnterpriseConfig } from "./config";

const config = loadEnterpriseConfig(process.env);
const { app, beginDrain, close } = await bootstrapEnterprise(config);
const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: app.fetch,
});
console.info(
  `OpenBot enterprise API listening on http://${config.hostname}:${config.port}`,
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  beginDrain();
  const timer = setTimeout(() => {
    void server.stop(true);
  }, config.shutdownGraceMs);
  try {
    await server.stop(false);
  } finally {
    clearTimeout(timer);
    await close();
  }
}
function requestShutdown(): void {
  void shutdown().catch(() => {
    console.error("ENTERPRISE_SHUTDOWN_FAILED");
    process.exitCode = 1;
  });
}
process.once("SIGTERM", requestShutdown);
process.once("SIGINT", requestShutdown);
