/**
 * The Bifrost gateway's admin credential: the deployment's own key for the gateway's management
 * surface, stored encrypted and readable only as a redacted status (Bifrost 01.2, #208).
 *
 * WRITE-ONLY, AND WHAT THAT MEANS HERE. The key arrives once, over the administrator's route, and
 * is encrypted into the shared credential vault (`credentials.ts`) under its own kind. Everything
 * that reads afterwards answers a status — configured or not, a configVersion, the SHA-256
 * fingerprint's last four hex digits, a timestamp — and nothing else. The plaintext exists in
 * exactly one place: {@link GatewayAdminCredentialService.resolveGatewayAdminCredential}, for
 * server-side trusted code (01.5's probe, 07.x's admission extension) to present to the gateway.
 * It is not a route, and no route may grow one: a read path that returns the key has failed the
 * ticket, which is why the resolve entry lives on the service and never on the HTTP surface.
 *
 * THE REFERENCE AND ITS VERSION. `enterprise_settings` holds one row, `gateway_admin_credential`:
 * `{ credentialId, configVersion, fingerprint, updatedAt }` — a pointer into the vault plus the
 * redacted status, never the secret. Every successful save (first write or rotation alike)
 * assigns the next `configVersion` under a transaction-scoped advisory lock, the way the gateway
 * endpoint row (01.1) and the conversion rate (01.3) do; a caller may not write one. A resolver
 * that still holds the previous save's ref — credential id and version together — is refused, so
 * a rotation invalidates the old references the moment it commits: nobody dials the gateway with
 * a key the deployment has already retired.
 *
 * UNCONFIGURED IS ITS OWN ANSWER. With no row (or a row that does not validate, or a pointer to a
 * credential that is gone) the status reads `unconfigured` and resolve refuses — loudly, in the
 * log, but as "not configured", never as "configured but failing", so 01.5's probe can report the
 * truth and 01.8's screen can ask for the key instead of apologizing for it.
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  CredentialRefusedError,
  createCredentialStore,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import { enterpriseSettings } from "../db/schema";

/** The kind this module writes, and the only kind its routes can produce. */
export const GATEWAY_ADMIN_CREDENTIAL_KIND = "gateway_admin";
/** The one provider and key id the deployment's gateway credential is stored under. */
export const GATEWAY_ADMIN_CREDENTIAL_PROVIDER = "bifrost";
export const GATEWAY_ADMIN_CREDENTIAL_KEY_ID = "admin";

/** The `enterprise_settings` row key the write-only reference is stored under. */
export const GATEWAY_ADMIN_CREDENTIAL_KEY = "gateway_admin_credential";

/**
 * A saved credential's reference, as a server-side consumer holds it: which vault row, decided
 * against which revision. Both fields must match for the reference to still be current.
 */
export type GatewayAdminCredentialRef = {
  credentialId: string;
  configVersion: number;
};

/** The redacted status every read path answers. There is deliberately nothing else. */
export type GatewayAdminCredentialStatus = {
  state: "configured";
  configVersion: number;
  /** The key's SHA-256 fingerprint, last four hex digits — identification, not recovery. */
  fingerprint: string;
  /** When the current (or a later) save committed, ISO 8601. */
  updatedAt: string;
};

export type GatewayAdminCredentialRead =
  | GatewayAdminCredentialStatus
  | { state: "unconfigured" };

/**
 * The credential this deployment has not got. Not an error shape on the read path — an
 * administrator asking "is it set up" is asking a question, not committing a fault — but the
 * reason {@link GatewayAdminCredentialService.resolveGatewayAdminCredential} refuses.
 */
export class GatewayAdminCredentialNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAdminCredentialNotConfiguredError";
  }
}

/**
 * A reference the deployment has moved past: the credential was rotated after this ref was
 * resolved, so its version or its credential id no longer matches the current row. The caller
 * re-resolves; the old key will not be decrypted for it even though the vault still holds the
 * (revoked) row.
 */
export class GatewayAdminCredentialStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAdminCredentialStaleError";
  }
}

/** The input is one `adminKey` string, or it is nothing. */
export function validateGatewayAdminCredentialInput(
  input: unknown,
): { ok: true; adminKey: string } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error:
        "The gateway admin credential must be a JSON object with an adminKey field.",
    };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || !keys.includes("adminKey")) {
    const unexpected = keys.filter((key) => key !== "adminKey");
    return {
      ok: false,
      error:
        unexpected.length > 0
          ? `Unknown field "${unexpected[0]}": the gateway admin credential accepts only the field "adminKey".`
          : 'The gateway admin credential accepts only the field "adminKey".',
    };
  }
  const raw = record.adminKey;
  if (typeof raw !== "string") {
    return { ok: false, error: "The adminKey must be a string." };
  }
  const adminKey = raw.trim();
  if (!adminKey) {
    return { ok: false, error: "The adminKey must not be empty." };
  }
  if (adminKey.length > 4096) {
    return {
      ok: false,
      error: "The adminKey must be at most 4096 characters.",
    };
  }
  return { ok: true, adminKey };
}

/**
 * The key's fingerprint, last four hex digits of SHA-256. Four digits cannot be carried back to
 * the key; they let a person comparing two screens tell which key is which.
 */
export function adminKeyFingerprint(adminKey: string): string {
  return createHash("sha256").update(adminKey, "utf8").digest("hex").slice(-4);
}

/** The stored reference row's shape, as this module writes it. */
type StoredRefRow = {
  credentialId: string;
  configVersion: number;
  fingerprint: string;
  updatedAt: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isConfigVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Read the stored row strictly: every field must be the right shape, or the row is not a
 * reference. `undefined` for absent and damaged alike — the caller decides which of those it can
 * distinguish (the status read does, by whether a row exists at all, and logs the damage).
 */
export function gatewayAdminCredentialRefFromStored(stored: unknown):
  | {
      ref: GatewayAdminCredentialRef;
      fingerprint: string;
      updatedAt: string;
    }
  | undefined {
  if (stored === null || typeof stored !== "object") return undefined;
  const row = stored as Partial<StoredRefRow>;
  if (
    !isNonEmptyString(row.credentialId) ||
    !isConfigVersion(row.configVersion) ||
    !isNonEmptyString(row.fingerprint) ||
    !isNonEmptyString(row.updatedAt)
  ) {
    return undefined;
  }
  return {
    ref: { credentialId: row.credentialId, configVersion: row.configVersion },
    fingerprint: row.fingerprint,
    updatedAt: row.updatedAt,
  };
}

/**
 * The version the next save continues from, read even from a row too damaged to be a reference:
 * the version field alone stays authoritative, so repairing a broken row cannot silently rewind
 * the numbering under a consumer that saw version N. Absent or nonsense reads as 0.
 */
function nextConfigVersion(stored: unknown): number {
  const version = (stored as Partial<StoredRefRow> | undefined)?.configVersion;
  return isConfigVersion(version) ? version + 1 : 1;
}

export type SaveGatewayAdminCredentialResult =
  | { ok: true; status: GatewayAdminCredentialStatus }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 503;
      error: string;
    };

/**
 * What the service needs. `member` is the same role source `requireAdmin` consults — the
 * service re-asks rather than trusting the route, the way `saveGatewayEndpoint` (01.1) does, so
 * a caller that reached the service without the route cannot skip the check either.
 */
export type GatewayAdminCredentialDeps = {
  database: Database;
  encryptionKey: string;
  member: (userId: string) => Promise<{
    role: "admin" | "user";
    groups: readonly string[];
  }>;
  auditStore?: AuditStore;
  log?: Logger;
};

export type GatewayAdminCredentialService = {
  /**
   * Write or rotate the gateway admin credential, as an administrator.
   *
   * Success answers the redacted status and nothing else — the key has left the request and
   * will not come back out. The first save stores; every later save rotates: the previous
   * credential is revoked and the new one stored in the vault's one atomic write, and the
   * reference row is repointed in the same transaction, so there is no committed moment at
   * which the reference names a credential the vault does not hold live.
   */
  saveGatewayAdminCredential: (
    input: unknown,
    by: { userId: string; email: string },
  ) => Promise<SaveGatewayAdminCredentialResult>;
  /** The redacted status: configured (with fingerprint and version) or unconfigured. */
  readGatewayAdminCredential: () => Promise<GatewayAdminCredentialRead>;
  /**
   * The one decryption entry, for server-side trusted code only (01.5's probe, 07.x's admission
   * extension). Never called from a route; never returned through any HTTP response.
   *
   * Without a ref, resolves the current credential. With one, both its fields must match the
   * current reference — a ref from before the last rotation is refused with
   * {@link GatewayAdminCredentialStaleError}, which is what makes an old reference dead the
   * moment a rotation commits. When nothing usable is configured, refuses with
   * {@link GatewayAdminCredentialNotConfiguredError} — the caller's signal to say "not
   * configured" rather than "authentication failed".
   */
  resolveGatewayAdminCredential: (
    ref?: GatewayAdminCredentialRef,
  ) => Promise<{ adminKey: string; ref: GatewayAdminCredentialRef }>;
};

export function createGatewayAdminCredentialService(
  deps: GatewayAdminCredentialDeps,
): GatewayAdminCredentialService {
  const { database, encryptionKey, member } = deps;
  const log = deps.log ?? getLogger("server");
  const vault = createCredentialStore(database);

  const readRefRow = async () => {
    const [row] = await database
      .select({ value: enterpriseSettings.value })
      .from(enterpriseSettings)
      .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY))
      .limit(1);
    return row?.value;
  };

  /**
   * The status, from the reference row, believing it only as far as the vault confirms: a
   * reference to a credential the vault does not hold live is damage (a hand edit, a manual
   * delete), and damage reads as unconfigured with a warning, never as a working credential.
   */
  const readStatus = async (
    stored: unknown,
    rowExists: boolean,
  ): Promise<GatewayAdminCredentialRead> => {
    const parsed = gatewayAdminCredentialRefFromStored(stored);
    if (!parsed) {
      if (rowExists) {
        log.warn(
          "The stored gateway admin credential reference is present but does not validate, so the credential reads as unconfigured. An administrator must save it again.",
        );
      }
      return { state: "unconfigured" };
    }
    if (!(await vault.isLive(parsed.ref.credentialId))) {
      log.warn(
        "The gateway admin credential reference names a credential the vault does not hold live, so the credential reads as unconfigured. An administrator must save it again.",
      );
      return { state: "unconfigured" };
    }
    return {
      state: "configured",
      configVersion: parsed.ref.configVersion,
      fingerprint: parsed.fingerprint,
      updatedAt: parsed.updatedAt,
    };
  };

  return {
    async saveGatewayAdminCredential(input, by) {
      const validated = validateGatewayAdminCredentialInput(input);
      if (!validated.ok) {
        return { ok: false, status: 400, error: validated.error };
      }
      let role: "admin" | "user";
      try {
        role = (await member(by.userId)).role;
      } catch (error) {
        log.error(
          {
            type: "gateway-admin-credential-role-check-failed",
            error: String(error),
          },
          "gateway-admin-credential-role-check-failed",
        );
        return {
          ok: false,
          status: 503,
          error:
            "Your role could not be checked, so the gateway credential was not changed.",
        };
      }
      if (role !== "admin") {
        return {
          ok: false,
          status: 403,
          error: "Only an administrator may change the gateway credential.",
        };
      }

      // Encrypted before the transaction opens, so the expensive part never holds a pooled
      // connection; the same order `rotateCredential` in credentials.ts keeps.
      const encryptedValue = await encryptSecret(
        encryptionKey,
        validated.adminKey,
      );
      const fingerprint = adminKeyFingerprint(validated.adminKey);

      let saved:
        | { id: string; configVersion: number; updatedAt: string }
        | undefined;
      try {
        saved = await database.transaction(async (tx) => {
          // Serialize saves on this one key. Two first-saves both reading "no row" would both
          // claim version 1 without it — the same race the endpoint row's save closes.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${GATEWAY_ADMIN_CREDENTIAL_KEY}))`,
          );
          const [existingRow] = await tx
            .select({ value: enterpriseSettings.value })
            .from(enterpriseSettings)
            .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY))
            .for("update");
          const parsed = gatewayAdminCredentialRefFromStored(
            existingRow?.value,
          );
          const configVersion = nextConfigVersion(existingRow?.value);

          // Rotate when anything live is on file — named by the reference, or found in the
          // vault when the reference row was lost — so at most one live row ever exists for
          // this key, which the vault's partial unique index also enforces.
          const live = await vault.findLiveByKey(
            {
              kind: GATEWAY_ADMIN_CREDENTIAL_KIND,
              provider: GATEWAY_ADMIN_CREDENTIAL_PROVIDER,
              keyId: GATEWAY_ADMIN_CREDENTIAL_KEY_ID,
            },
            tx,
          );
          const previousCredentialId = parsed?.ref.credentialId ?? live?.id;
          const stored = previousCredentialId
            ? await vault.rotate(
                {
                  previousCredentialId,
                  kind: GATEWAY_ADMIN_CREDENTIAL_KIND,
                  provider: GATEWAY_ADMIN_CREDENTIAL_PROVIDER,
                  keyId: GATEWAY_ADMIN_CREDENTIAL_KEY_ID,
                  metadata: {},
                  encryptedValue,
                },
                tx,
              )
            : await vault.create(
                {
                  kind: GATEWAY_ADMIN_CREDENTIAL_KIND,
                  provider: GATEWAY_ADMIN_CREDENTIAL_PROVIDER,
                  keyId: GATEWAY_ADMIN_CREDENTIAL_KEY_ID,
                  metadata: {},
                  encryptedValue,
                },
                tx,
              );

          const updatedAt = new Date().toISOString();
          const value: StoredRefRow = {
            credentialId: stored.id,
            configVersion,
            fingerprint,
            updatedAt,
          };
          await tx
            .insert(enterpriseSettings)
            .values({
              key: GATEWAY_ADMIN_CREDENTIAL_KEY,
              value,
              updatedBy: by.email,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: enterpriseSettings.key,
              set: { value, updatedBy: by.email, updatedAt: new Date() },
            });
          return { id: stored.id, configVersion, updatedAt };
        });
      } catch (error) {
        // The vault refuses a rotation aimed at a credential that is gone or already revoked —
        // a reference row tampered with, in practice, since nothing else writes one. The audit
        // row is written after the transaction has rolled back, and quotes the refusal through
        // `reasonWithoutStatement`: a drizzle failure message binds the encrypted envelope as a
        // parameter, and `audit_events` is append-only, so the envelope must not land there.
        await recordAuditEvent(deps.auditStore ?? auditNullStore, {
          eventType: "gateway_admin_credential.save_refused",
          targetType: "credential",
          targetId: GATEWAY_ADMIN_CREDENTIAL_KEY,
          actorUserId: by.userId,
          payload: { reason: reasonWithoutStatement(error) },
        });
        if (error instanceof CredentialRefusedError) {
          return { ok: false, status: error.status, error: error.message };
        }
        throw error;
      }

      await recordAuditEvent(deps.auditStore ?? auditNullStore, {
        eventType: "gateway_admin_credential.saved",
        targetType: "credential",
        targetId: saved.id,
        actorUserId: by.userId,
        payload: { configVersion: saved.configVersion, fingerprint },
      });
      return {
        ok: true,
        status: {
          state: "configured",
          configVersion: saved.configVersion,
          fingerprint,
          updatedAt: saved.updatedAt,
        },
      };
    },

    async readGatewayAdminCredential() {
      const stored = await readRefRow();
      return readStatus(stored, stored !== undefined);
    },

    async resolveGatewayAdminCredential(ref) {
      const stored = await readRefRow();
      const parsed = gatewayAdminCredentialRefFromStored(stored);
      if (!parsed) {
        if (stored !== undefined) {
          log.warn(
            "The stored gateway admin credential reference is present but does not validate, so the gateway admin credential is treated as not configured.",
          );
        }
        throw new GatewayAdminCredentialNotConfiguredError(
          "The gateway admin credential is not configured.",
        );
      }
      if (
        ref &&
        (ref.configVersion !== parsed.ref.configVersion ||
          ref.credentialId !== parsed.ref.credentialId)
      ) {
        throw new GatewayAdminCredentialStaleError(
          "The gateway admin credential reference is stale: the credential was rotated. Resolve it again.",
        );
      }
      const secret = await vault.readSecret(parsed.ref.credentialId);
      if (!secret || secret.revokedAt) {
        log.warn(
          "The gateway admin credential reference names a credential the vault does not hold live, so the gateway admin credential is treated as not configured.",
        );
        throw new GatewayAdminCredentialNotConfiguredError(
          "The gateway admin credential is not configured.",
        );
      }
      return {
        adminKey: await decryptSecret(encryptionKey, secret.encryptedValue),
        ref: parsed.ref,
      };
    },
  };
}

/**
 * An audit sink that drops events, for callers constructed without a trail (tests, mostly).
 * `recordAuditEvent` needs a store; the credential is never worth failing a save over, and the
 * real deployment always passes one.
 */
const auditNullStore = {
  insert: async () => undefined,
} as unknown as AuditStore;

let installed: GatewayAdminCredentialService | undefined;

/**
 * Install the running service, from the wiring that holds the encryption key. Internal consumers
 * (01.5's probe, 07.x's admission extension) read it back through
 * {@link gatewayAdminCredentialControls} instead of each being handed the key.
 */
export function installGatewayAdminCredentialService(
  service: GatewayAdminCredentialService,
) {
  installed = service;
}

/** The running service, or undefined in a test or script that never installed one. */
export function gatewayAdminCredentialControls():
  | GatewayAdminCredentialService
  | undefined {
  return installed;
}
