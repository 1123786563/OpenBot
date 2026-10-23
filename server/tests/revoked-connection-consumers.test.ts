import { describe, expect, test } from "../../tests/support/e2e-compat";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * #489 F01-01: where a withdrawn connection still counts, and where it must not.
 *
 * `connectionsFor` REPORTS `revoked` rather than filtering it — upstream's deliberate shape, so
 * every consumer had to decide for itself. This suite pins the two adjudications T7 made over that
 * row shape, reading the boot file the way the R2-59/R5-25 pins do (the composition exists in
 * exactly one place and no injected fake can observe it):
 *
 * KEPT (upstream's own explicit ruling, so no divergence is created):
 *   - the Team Bots wiring — upstream app-access.ts: a Team Bot's call "goes out on the owner's
 *     account wherever the owner has one — connected, withdrawn or refused alike, exactly as
 *     `credentialActorFor` decides from `connectedServers`";
 *   - memory ingestion's existence check and default candidates — upstream connections.ts:
 *     "memory ingestion's existence check keeps the behaviour it had". Those are pinned
 *     behaviourally (against the real store) in memory-defaults.integration.test.ts.
 *
 * FIXED (upstream has no craft surface, so #489 Spec rules: revocation stays effective):
 *   - all three craft resolvers read one shared valid-connection fact that drops revoked rows, so
 *     the offered MCP set stays the forwardable set, a connector skill no longer ships over a
 *     credential no call can use, and the withdrawn app returns to the connectable list.
 */

const hereDir = dirname(fileURLToPath(import.meta.url));
const boot = readFileSync(join(hereDir, "..", "src", "index.ts"), "utf8");

describe("the craft resolvers' shared connection fact (#489 F01-01)", () => {
  test("counts a held row only while its credential is unrevoked; brokered rows always", () => {
    // The one place all three craft surfaces read "is this server usable for this person": the
    // vault side drops revoked rows, the broker side has no revoked state to drop (a brokered
    // disconnect deletes the row). Pinned so the wiring cannot quietly regress to row existence.
    expect(boot).toMatch(
      /const craftConnectedServerIdsFor = async \(\s*userId: string,?\s*\): Promise<Set<string>> => \{[\s\S]*?held\.filter\(\(row\) => !row\.revoked\)\.map\(\(row\) => row\.serverId\),\s*\.\.\.brokered\.map\(\(row\) => row\.serverId\),/,
    );
  });

  test("the connectable list inverts the valid-connection fact, not row existence", () => {
    // A withdrawn credential puts the app back on the connectable list — the reconnect advice
    // the connect flow already gives (a revoked row must not read as "already connected").
    expect(boot).toMatch(
      /personalUnconnectedApps\(\s*servers,\s*await craftConnectedServerIdsFor\(userId\),\s*\);/,
    );
  });

  test("a connector skill ships only over the valid-connection fact", () => {
    // onyx's connected-apps-only rule, read against the same fact: a skill naming a revoked
    // connection's tools would advertise tools no call can execute.
    expect(boot).toMatch(
      /builtinSkillFilesFor\(\{\s*connectedServerIds: await craftConnectedServerIdsFor\(userId\),\s*\}\),/,
    );
  });

  test("the per-user MCP set offers only servers the relay can forward on", () => {
    // mcpWireServersFor's own invariant — the offered set and the forwardable set are the same
    // set — extended to revocation: the relay refuses a withdrawn credential
    // (mcpWireConnectionFor → connectionTokenFor), so a revoked entry would be the permanently
    // failed MCP client that invariant refuses to create.
    expect(boot).toMatch(
      /connectedServerIds: await craftConnectedServerIdsFor\(userId\),\s*relayBaseUrl: craftMcpRelayBaseUrl,/,
    );
  });
});

describe("the Team Bots wiring keeps upstream's row-existence ruling (#489 F01-01)", () => {
  test("connectedServers spreads connectionsFor unfiltered — revoked included, deliberately", () => {
    // Upstream's explicit adjudication for this exact wiring (upstream app-access.ts, describe):
    // "calls go out on the owner's account wherever the owner has one — connected, withdrawn or
    // refused alike, exactly as `credentialActorFor` decides from `connectedServers`", with the
    // upstream boot spreading connectionsFor unfiltered the same way. Filtering here would
    // silently switch a Team Bot's call onto the teammate's account the moment the owner's
    // credential is withdrawn; the call itself still fails closed in the vault. The pin holds the
    // unfiltered composition so a future filter is a conscious decision, not a quiet drift.
    expect(boot).toMatch(
      /connectedServers: async \(userId\) =>\s*new Set\(\s*\[\s*\.\.\.\(await pluginStore\.connectionsFor\(userId\)\),\s*\.\.\.\(await pluginStore\.brokeredConnectionsFor\(userId\)\),\s*\]\.map\(\(connection\) => connection\.serverId\),\s*\),/,
    );
  });
});
