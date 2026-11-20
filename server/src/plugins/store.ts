import { RevocationRefusal } from "./corsair/revocation";
import { withLegacyCorsairDisconnect } from "./corsair/cutover";
import { PluginRefusedError } from "./plugin-store/model";
import { accountMethods } from "./plugin-store/accounts";
import { appAccessMethods } from "./plugin-store/app-access";
import { callMethods } from "./plugin-store/calls";
import { connectionMethods } from "./plugin-store/connections";
import { createStoreContext } from "./plugin-store/context";
import { grantMethods } from "./plugin-store/grants";
import type { PluginStoreOptions } from "./plugin-store/model";
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
    ...grantMethods(context),
    ...connections,
    ...callMethods(context),
    ...appAccessMethods(context),
    ...accounts,
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
