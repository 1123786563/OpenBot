import { marketSkillMethods } from "../skill-market/installations";
import { toolkitOfFor } from "./access";
import { withLegacyCorsairDisconnect } from "./corsair/cutover";
import {
  guardLegacyAuthorization,
  recordLegacyAuthorizationStart,
  recordUnmatchedArcadeReturn,
} from "./corsair/legacy-cleanup";
import { RevocationRefusal } from "./corsair/revocation";
import { accountMethods } from "./plugin-store/accounts";
import { appAccessMethods } from "./plugin-store/app-access";
import { callMethods } from "./plugin-store/calls";
import { connectionMethods } from "./plugin-store/connections";
import { createStoreContext } from "./plugin-store/context";
import { grantMethods } from "./plugin-store/grants";
import {
  PluginRefusedError,
  type PluginStoreOptions,
} from "./plugin-store/model";
import { serverMethods } from "./plugin-store/servers";
import { skillMethods } from "./plugin-store/skills";

export type { CatalogueEntry } from "./catalogue";
export type { BrokeredAccountRecord } from "./plugin-store/accounts";
export type {
  AccessToken,
  BrokeredDisconnectReason,
  BrokeredProbe,
  ConnectionFootprint,
  GrantedPlugins,
  OAuthClient,
  PendingAuthorization,
  PluginDecision,
  PluginKind,
  PluginStoreOptions,
  ServerAddress,
  ServerRecord,
  SkillActor,
  SkillRecord,
  ToolRecord,
  WithdrawnGrant,
} from "./plugin-store/model";
export {
  BROKERED_PROBE_OUTCOMES,
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  connectionSiblings,
  deploymentFaultSentence,
  exchangeRefreshTokenOverHttp,
  INVALID_CLIENT,
  isDeploymentFault,
  OAuthClientReadError,
  PluginInvariantError,
  PluginRefusedError,
  refFromToolName,
  TokenRefusedError,
  toolNameFor,
  unlistedAdvertisedTools,
} from "./plugin-store/model";

export function createPluginStore(options: PluginStoreOptions) {
  const context = createStoreContext(options);
  const connections = connectionMethods(context);
  const accounts = accountMethods(context);
  const servers = serverMethods(context);
  const disconnect = <T>(
    input: { toolkit: string; by: string },
    run: () => Promise<T>,
  ) =>
    withLegacyCorsairDisconnect(
      options.database,
      options.deploymentId,
      input.toolkit,
      input.by,
      run,
    ).catch((error: unknown) => {
      if (error instanceof RevocationRefusal)
        throw new PluginRefusedError(error.message, null);
      throw error;
    });
  // In the order the methods were always declared. Each group's methods call each other through
  // `this`, which is the whole store when a method is called on it.
  return {
    ...serverMethods(context),
    ...skillMethods(context),
    ...marketSkillMethods(context.database),
    ...grantMethods(context),
    ...connections,
    ...callMethods(context),
    ...appAccessMethods(context),
    ...accounts,
    recordLegacyAuthorizationStart(
      input: Parameters<typeof recordLegacyAuthorizationStart>[3],
    ) {
      return recordLegacyAuthorizationStart(
        options.database,
        options.deploymentId,
        context.brokerProvider,
        input,
      );
    },
    async recordUnmatchedLegacyReturn(actor: string, callback: string) {
      if (options.deploymentId)
        await recordUnmatchedArcadeReturn(
          options.database,
          options.deploymentId,
          actor,
          callback,
        );
    },
    async withLegacyAuthorization<T>(
      input: { serverId: string; actor: string; callback?: string },
      run: () => Promise<T>,
    ): Promise<T> {
      if (!options.deploymentId) return run();
      const row = await this.serverAddress(input.serverId);
      if (!row) return run();
      return guardLegacyAuthorization({
        ...input,
        database: options.database,
        workspaceId: options.deploymentId,
        provider: context.brokerProvider,
        url: row.url,
        run,
      });
    },
    async removeServer(serverId: string, by: string) {
      if (!options.deploymentId)
        return servers.removeServer.call(this, serverId, by);
      const row = await this.serverAddress(serverId);
      const toolkit =
        row &&
        (toolkitOfFor("composio", row.url) ?? toolkitOfFor("arcade", row.url));
      return toolkit
        ? withLegacyCorsairDisconnect(
            options.database,
            options.deploymentId,
            toolkit,
            by,
            () => servers.removeServer.call(this, serverId, by),
          )
        : servers.removeServer.call(this, serverId, by);
    },
    disconnectBrokered(
      input: Parameters<typeof connections.disconnectBrokered>[0],
    ) {
      return disconnect(input, () =>
        connections.disconnectBrokered.call(this, input),
      );
    },
    disconnectBrokeredAccount(
      input: Parameters<typeof accounts.disconnectBrokeredAccount>[0],
    ) {
      return disconnect(input, () =>
        accounts.disconnectBrokeredAccount.call(this, input),
      );
    },
  };
}

export type PluginStore = ReturnType<typeof createPluginStore>;
