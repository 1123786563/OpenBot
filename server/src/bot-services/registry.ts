import type { AuditStore } from "../audit";
import type {
  CredentialSecretReader,
  CredentialStatusReader,
  CredentialStore,
} from "../credentials";
import type { Database } from "../db/client";
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
};

export type BotServiceRegistryDependencies = {
  encryptionKey: string;
  /** What `createCredentialStore` returns: the vault able to find, read and list. */
  credentialStore: CredentialStore & CredentialSecretReader & CredentialStatusReader;
  auditStore: AuditStore;
};

export function createBotServiceRegistry(
  database: Database,
  dependencies: BotServiceRegistryDependencies,
): BotServiceRegistry {
  const store = createBotServiceStore(database);
  return {
    ...store,
    credentials: createBotServiceCredentialService(database, dependencies),
    authenticate: createBotServiceAuthenticator({
      encryptionKey: dependencies.encryptionKey,
      credentialStore: dependencies.credentialStore,
      botServices: store,
    }),
  };
}
