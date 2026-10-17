import type { AuditStore } from "../audit";
import type {
  CredentialSecretReader,
  CredentialStatusReader,
  CredentialStore,
} from "../credentials";
import type { Database } from "../db/client";
import { CredentialBundleUnavailableError } from "../gateway/credential-bundle";
import { gatewayEndpointControls } from "../gateway/endpoint-config";
import {
  createDeploymentKeyIssuer,
  createKeyIssuanceRoutes,
} from "../gateway/key-issuance";
import { gatewayModelCapabilityFilterControls } from "../gateway/model-capability-filter";
import { mappedModelCapabilities } from "../gateway/model-selection-routes";
import {
  type AccessGrantService,
  createAccessGrantService,
} from "./access-grants";
import { createBotServiceAuthenticator } from "./auth";
import { bindingCodeRoutes, createBindingOfferIssuer } from "./binding-codes";
import type { BotServiceCredentialService } from "./service-credentials";
import { createBotServiceCredentialService } from "./service-credentials";
import type { BotServiceStore } from "./store";
import { createBotServiceStore } from "./store";

/**
 * The bot service registry as app.ts receives it: the 04.1 store every existing reader uses,
 * composed with what 04.2 adds — the credential service an administrator manages credentials
 * through, and the authenticator a Bot's server proves itself through.
 *
 * The composition is structural, not a fork: `BotServiceRegistry` is assignable to
 * `BotServiceStore`, so `botServiceAdminRoutes` and every other 04.1 consumer keep reading the
 * same registry unchanged. A deployment that builds only the bare store (no vault) simply has no
 * `credentials` here, and the credential surfaces answer their tagged 503 — the same degraded
 * shape 04.1 takes when its store is absent.
 */
export type BotServiceRegistry = BotServiceStore & {
  credentials: BotServiceCredentialService;
  authenticate: ReturnType<typeof createBotServiceAuthenticator>;
  /**
   * The binding-code issuance surface (04.3), already composed against this registry's database
   * and audit trail. The bot-facing router mounts it under the same service guard.
   */
  bindingCodes: ReturnType<typeof bindingCodeRoutes>;
  /**
   * The model access authorization service (04.5): the confirmation flow — preview then confirm —
   * that turns a one-time binding code into a grant. Composed here because this factory is where
   * the database, the registry and the audit trail meet; the user-facing router app.ts mounts
   * reads it off the composed registry, the same seam `bindingCodes` rides.
   */
  modelAccess: AccessGrantService;
  /**
   * The short-lived key issuance surface (Bifrost 05.3, #244), composed against this registry's
   * grant service, 05.1's provisioning seam and the installed gateway controls. The bot-facing
   * router mounts it under the same service guard as `bindingCodes`.
   */
  keys: ReturnType<typeof createKeyIssuanceRoutes>;
};

export type BotServiceRegistryDependencies = {
  encryptionKey: string;
  /** What `createCredentialStore` returns: the vault able to find, read and list. */
  credentialStore: CredentialStore &
    CredentialSecretReader &
    CredentialStatusReader;
  auditStore: AuditStore;
};

export function createBotServiceRegistry(
  database: Database,
  dependencies: BotServiceRegistryDependencies,
): BotServiceRegistry {
  const store = createBotServiceStore(database);
  const modelAccess = createAccessGrantService({
    database,
    botServices: store,
    auditStore: dependencies.auditStore,
  });
  return {
    ...store,
    credentials: createBotServiceCredentialService(database, dependencies),
    authenticate: createBotServiceAuthenticator({
      encryptionKey: dependencies.encryptionKey,
      credentialStore: dependencies.credentialStore,
      botServices: store,
    }),
    bindingCodes: bindingCodeRoutes({
      issuer: createBindingOfferIssuer({
        database,
        auditStore: dependencies.auditStore,
      }),
    }),
    modelAccess,
    keys: createKeyIssuanceRoutes({
      issue: createDeploymentKeyIssuer({
        database,
        modelAccess,
        auditStore: dependencies.auditStore,
      }).issueKeyForGrant,
      // 05.4's bundle sides, read live at claim time: the endpoint this deployment answers
      // at (01.1) and the Bot's own selectable refs — 03.11's exact mapping
      // (mappedModelCapabilities over the live registry record, attributed to the Bot
      // service), never a re-derivation. A missing control refuses; nothing is guessed.
      bundle: {
        readGatewayEndpoint: async () =>
          (await gatewayEndpointControls()?.readGatewayEndpoint()) ?? undefined,
        listSelectableModels: async (botId) => {
          const filter = gatewayModelCapabilityFilterControls();
          if (!filter) {
            throw new CredentialBundleUnavailableError(
              "bundle_models_unavailable",
              "The model catalog is not available, so the credential bundle cannot be completed.",
            );
          }
          const bot = await store.getBotService(botId);
          if (bot?.status !== "active") {
            throw new CredentialBundleUnavailableError(
              "bundle_models_unavailable",
              "The bot service record is not readable, so the credential bundle cannot be completed.",
            );
          }
          const selection = await filter.listSelectableModels(
            mappedModelCapabilities(bot.capabilities),
            { kind: "bot_service", id: botId },
          );
          return selection.selectable;
        },
      },
    }),
  };
}
