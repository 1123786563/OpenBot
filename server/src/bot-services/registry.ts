import type { AuditStore } from "../audit";
import type {
  CredentialSecretReader,
  CredentialStatusReader,
  CredentialStore,
} from "../credentials";
import type { Database } from "../db/client";
import {
  createAccessGrantService,
  type AccessGrantService,
} from "./access-grants";
import { bindingCodeRoutes, createBindingOfferIssuer } from "./binding-codes";
import {
  createDeploymentKeyIssuer,
  createKeyIssuanceRoutes,
} from "../gateway/key-issuance";
import { createBotServiceAuthenticator } from "./auth";
import type { BotServiceCredentialService } from "./service-credentials";
import { createBotServiceCredentialService } from "./service-credentials";
import { createBotServiceStore } from "./store";
import type { BotServiceStore } from "./store";

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
    }),
  };
}
