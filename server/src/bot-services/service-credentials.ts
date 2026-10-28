import { and, desc, eq, isNull } from "drizzle-orm";
import { getLogger } from "@openbot/shared/logger";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  CredentialRefusedError,
  type CredentialSecretReader,
  type CredentialStatusReader,
  type CredentialStore,
  createCredentialAdminService,
} from "../credentials";
import type { Database } from "../db/client";
import { credentials } from "../db/schema";
import { mintBotServiceSecret } from "./auth";
import type { BotServiceRecord } from "./store";
import { createBotServiceStore } from "./store";
import {
  BotServiceCredentialMissingError,
  BotServiceNotFoundError,
} from "./types";

/**
 * The Bot service credentials (Bifrost #235, 04.2).
 *
 * A registered Bot proves which Bot it is by presenting a service secret. The secret is minted
 * here, stored encrypted in the deployment's shared credential vault (server/src/credentials.ts —
 * the same AES-GCM vault, rotation and revocation every other secret uses), and shown in
 * plaintext exactly once, in the response that mints or rotates it. `credentials_active_key_idx`
 * keeps at most one live credential per Bot, which is what lets two concurrent issuances race
 * without ever leaving two live secrets.
 *
 * Nothing here says anything about users or credits. Issuing, rotating and revoking are acts on
 * the Bot's own identity; who may use the Bot and whose balance a call spends are separate
 * decisions (ADR 0002), made by later tickets on top of the identity this proves.
 */

/** The vault kind this module's rows carry. See the enum comment in db/schema/core.ts. */
export const BOT_SERVICE_CREDENTIAL_KIND = "bot_service" as const;

/**
 * The vault provider for Bot service credentials: not a vendor, just the one bucket name that
 * keeps these rows apart from every other credential in "what does this deployment hold".
 */
export const BOT_SERVICE_CREDENTIAL_PROVIDER = "bot-service" as const;

/** What issuing or rotating answers — the only response that ever carries the plaintext. */
export type BotServiceCredentialIssued = {
  botId: string;
  /** The plaintext secret. Shown once, here; never again, anywhere. */
  secret: string;
  issuedAt: string;
  /** True when a live credential already existed and was retired by this issuance. */
  rotated: boolean;
};

/** What every read after that first one answers. No secret material, by construction. */
export type BotServiceCredentialStatusView = {
  botId: string;
  live: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BotServiceCredentialService = {
  /** Mint the Bot's credential, retiring any live one atomically through the vault. */
  issue: (
    botId: string,
    actorUserId?: string,
  ) => Promise<BotServiceCredentialIssued>;
  /** Rotate explicitly. Refused when the Bot has no live credential to retire. */
  rotate: (
    botId: string,
    actorUserId?: string,
  ) => Promise<BotServiceCredentialIssued>;
  /** Revoke the live credential. Refused, not idempotent-faked, when there is none. */
  revoke: (
    botId: string,
    actorUserId?: string,
  ) => Promise<{ botId: string; revokedAt: string }>;
  /** The masked status an administrator reads afterwards. Never any secret material. */
  status: (botId: string) => Promise<BotServiceCredentialStatusView>;
};

/** What the vault must offer this module: find live rows, read ciphertext, and list for admin. */
export type BotServiceCredentialVault = CredentialStore &
  CredentialSecretReader &
  CredentialStatusReader;

export type BotServiceCredentialDependencies = {
  encryptionKey: string;
  credentialStore: BotServiceCredentialVault;
  auditStore: AuditStore;
};

export function createBotServiceCredentialService(
  database: Database,
  dependencies: BotServiceCredentialDependencies,
): BotServiceCredentialService {
  // The vault's own admin service: it performs the encrypted write, the atomic rotation and the
  // vault's credential.* audit rows. This module adds only what the Bot registry needs around it.
  const vault = createCredentialAdminService(
    dependencies.encryptionKey,
    dependencies.credentialStore,
    dependencies.auditStore,
  );
  const store = dependencies.credentialStore;
  const records = createBotServiceStore(database);

  const vaultKey = (botId: string) => ({
    kind: BOT_SERVICE_CREDENTIAL_KIND,
    provider: BOT_SERVICE_CREDENTIAL_PROVIDER,
    keyId: botId,
  });

  /** The registered Bot, or the registry's own "never heard of it". */
  async function requireRecord(botId: string): Promise<BotServiceRecord> {
    const record = await records.getBotService(botId);
    if (!record) throw new BotServiceNotFoundError();
    return record;
  }

  /**
   * A rotate or revoke refused because the row it named was retired a moment ago (a concurrent
   * issue/rotate/revoke won the vault first) is the same race arriving by the other door: it
   * answers as "no live credential" — the contract both endpoints already document — and never
   * leaks the vault's internal refusal wording.
   */
  function retireRace(error: unknown): never {
    if (error instanceof CredentialRefusedError)
      throw new BotServiceCredentialMissingError();
    throw error;
  }

  /**
   * Make a freshly minted secret the Bot's one live credential.
   *
   * Two racers can both arrive believing nothing is live; the vault's partial index then rejects
   * the loser's plain insert. Reconciliation is always the same shape — read who is live now,
   * rotate from them — and is retried a bounded number of times, so both callers end with an
   * honest answer and the vault ends with exactly one live credential. A rotation refused
   * because the row it named was retired a moment ago is the same race arriving by the other
   * door, and is retried the same way.
   */
  async function mintLive(
    botId: string,
    actorUserId: string | undefined,
  ): Promise<{ rotated: boolean; secret: string }> {
    const input = {
      ...vaultKey(botId),
      metadata: {},
      actorUserId,
    };
    let lastRaceError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const secret = mintBotServiceSecret(botId);
      const previous = await store.findLiveByKey(vaultKey(botId));
      try {
        if (previous) {
          await vault.rotate({
            ...input,
            plaintext: secret,
            previousCredentialId: previous.id,
          });
          return { rotated: true, secret };
        }
        await vault.create({ ...input, plaintext: secret });
        return { rotated: false, secret };
      } catch (error) {
        const refused =
          error instanceof CredentialRefusedError && error.status === 409;
        if (!refused && !isUniqueViolation(error)) throw error;
        lastRaceError = error;
      }
    }
    throw new Error(
      "The bot service credential could not be written after repeated races.",
      { cause: lastRaceError },
    );
  }

  /** The vault mutation is already committed (and for issue, the one-time secret is
   * already in the response path); an audit failure must not report a live credential
   * as failed. */
  const auditSoftly = async (event: Parameters<typeof recordAuditEvent>[1]) => {
    try {
      await recordAuditEvent(dependencies.auditStore, event);
    } catch (error) {
      getLogger("server").warn(
        {
          type: "bot-service-credential-audit-error",
          errorType: error instanceof Error ? error.name : "unknown",
          context: { eventType: event.eventType, targetId: event.targetId },
          timestamp: new Date().toISOString(),
        },
        "bot-service-credential-audit-error",
      );
    }
  };

  return {
    async issue(botId, actorUserId) {
      const record = await requireRecord(botId);
      const { rotated, secret } = await mintLive(botId, actorUserId);
      await auditSoftly({
        eventType: "bot_service.credential_issued",
        targetType: "bot_service",
        targetId: record.botId,
        actorUserId,
        payload: { actor: actorUserId, rotated },
      });
      return {
        botId: record.botId,
        secret,
        issuedAt: new Date().toISOString(),
        rotated,
      };
    },

    async rotate(botId, actorUserId) {
      const record = await requireRecord(botId);
      const previous = await store.findLiveByKey(vaultKey(botId));
      if (!previous) throw new BotServiceCredentialMissingError();
      const secret = mintBotServiceSecret(botId);
      await vault
        .rotate({
          ...vaultKey(botId),
          metadata: {},
          plaintext: secret,
          actorUserId,
          previousCredentialId: previous.id,
        })
        .catch(retireRace);
      await auditSoftly({
        eventType: "bot_service.credential_rotated",
        targetType: "bot_service",
        targetId: record.botId,
        actorUserId,
        payload: { actor: actorUserId },
      });
      return {
        botId: record.botId,
        secret,
        issuedAt: new Date().toISOString(),
        rotated: true,
      };
    },

    async revoke(botId, actorUserId) {
      const record = await requireRecord(botId);
      const live = await store.findLiveByKey(vaultKey(botId));
      if (!live) throw new BotServiceCredentialMissingError();
      const { revokedAt } = await vault
        .revoke(live.id, actorUserId)
        .catch(retireRace);
      await auditSoftly({
        eventType: "bot_service.credential_revoked",
        targetType: "bot_service",
        targetId: record.botId,
        actorUserId,
        payload: { actor: actorUserId },
      });
      return { botId: record.botId, revokedAt: revokedAt.toISOString() };
    },

    async status(botId) {
      await requireRecord(botId);
      const byKey = and(
        eq(credentials.kind, BOT_SERVICE_CREDENTIAL_KIND),
        eq(credentials.provider, BOT_SERVICE_CREDENTIAL_PROVIDER),
        eq(credentials.keyId, botId),
      );
      const [live] = await database
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(byKey, isNull(credentials.revokedAt)));
      const [latest] = await database
        .select({
          createdAt: credentials.createdAt,
          updatedAt: credentials.updatedAt,
        })
        .from(credentials)
        .where(byKey)
        .orderBy(desc(credentials.createdAt), desc(credentials.id))
        .limit(1);
      return {
        botId,
        live: live !== undefined,
        createdAt: latest?.createdAt.toISOString() ?? null,
        updatedAt: latest?.updatedAt.toISOString() ?? null,
      };
    },
  };
}

/** The vault's verdict on a lost insert race: Postgres unique_violation, however wrapped. */
function isUniqueViolation(error: unknown): boolean {
  const visited = new Set<unknown>();
  for (
    let node: unknown = error;
    node !== null && node !== undefined && !visited.has(node);
    node = (node as { cause?: unknown }).cause
  ) {
    visited.add(node);
    const driver = node as { code?: unknown; errno?: unknown };
    // The drivers put the SQLSTATE on `code` (node-postgres, postgres-js); `errno`
    // is kept for a wrapper that repackages the driver error under that name.
    if (driver.code === "23505" || driver.errno === "23505") return true;
  }
  return false;
}
