/**
 * The client secret a company's identity provider gave us, encrypted at rest.
 *
 * `sso_providers.oidc_config` is a JSON blob Better Auth's SSO plugin writes, and inside it is the
 * OAuth client secret for that company's directory. `saml_config` is the same shape and holds the
 * signing material. The plugin stores both as plaintext text columns, which is out of step with the
 * rest of this deployment: every other secret it keeps goes through `KEY_ENCRYPTION_KEY`, and a
 * database backup, a read replica, or anybody with SELECT on one table should not be one query away
 * from a customer's directory.
 *
 * The plugin gives no hook for this, so the seam is the adapter. Better Auth reads and writes every
 * row through one, so wrapping it is the only place that catches all of them: the register route, the
 * sign-in path that reads the config back, and any listing.
 *
 * Only two fields on one model. Everything else passes through untouched, because a wrapper that
 * tried to be general would be a second, worse copy of the adapter.
 *
 * Reading tolerates plaintext. A deployment that registered a provider before this existed has
 * plaintext in the column, and refusing to read it would lock that company out of their own sign-in
 * at the moment they upgraded. The value is re-encrypted the next time it is written.
 */
import { getLogger } from "../../../shared/logger";
import { decryptSecret, encryptSecret } from "../credentials";

const log = getLogger("server");

/** The model and fields this touches. Named once so nothing drifts. */
const SSO_MODEL = "ssoProvider";
const ENCRYPTED_FIELDS = ["oidcConfig", "samlConfig"] as const;

/**
 * The narrow slice of the adapter this wraps.
 *
 * Typed structurally rather than imported: Better Auth's `DBAdapter` is generic over the whole
 * options object, and naming it here would tie this file to a type that changes shape between minor
 * versions for reasons that have nothing to do with two string fields.
 */
type Rowish = Record<string, unknown>;

type AdapterMethod = (data: never) => Promise<unknown>;

type AdapterLike = {
  create: AdapterMethod;
  update: AdapterMethod;
  updateMany?: AdapterMethod;
  findOne: AdapterMethod;
  findMany: AdapterMethod;
};

/** The four methods, seen as this file needs to see them rather than as Better Auth declares them. */
type RowishAdapter = Record<
  "create" | "update" | "updateMany" | "findOne" | "findMany",
  ((data: Rowish) => Promise<unknown>) | undefined
>;

function isEnvelope(value: string): boolean {
  // What `encryptSecret` produces — checked with the SAME three-field shape `decryptSecret`
  // requires (see credentials.ts's parseEnvelope), not a prefix: a provider config that happens
  // to begin `{"version":1` would otherwise skip encryption on write and fail decryption on
  // read, silently breaking that company's sign-in both ways.
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      iv?: unknown;
      ciphertext?: unknown;
    };
    return (
      parsed?.version === 1 &&
      typeof parsed.iv === "string" &&
      typeof parsed.ciphertext === "string"
    );
  } catch {
    return false;
  }
}

async function encryptFields(
  key: string,
  row: Rowish | undefined,
): Promise<Rowish | undefined> {
  if (!row) return row;
  const next = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    const value = next[field];
    // A field the payload does not carry at all is normal (a provider configures one method).
    // A field that EXISTS but cannot be encrypted is not: this is the one place a customer
    // secret could reach the column in the clear, so it leaves a line saying so.
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string" || !isEnvelope(value)) {
        log.warn(
          {
            type: "sso-config-field-not-encryptable",
            field,
            kind: typeof value,
          },
          "sso-config-field-not-encryptable",
        );
      }
    }
    if (typeof value === "string" && value && !isEnvelope(value)) {
      next[field] = await encryptSecret(key, value);
    }
  }
  return next;
}

async function decryptFields<T>(key: string, row: T): Promise<T> {
  if (!row || typeof row !== "object") return row;
  const next = { ...(row as Rowish) };
  for (const field of ENCRYPTED_FIELDS) {
    const value = next[field];
    if (typeof value === "string" && value && isEnvelope(value)) {
      try {
        next[field] = await decryptSecret(key, value);
      } catch (error) {
        /*
         * A row this deployment cannot read.
         *
         * The usual cause is a changed `KEY_ENCRYPTION_KEY`, and the honest answer is to leave the
         * field out rather than hand the plugin ciphertext it will try to parse as JSON. Sign-in
         * through that provider then fails with the plugin's own "not configured" error, which is
         * true, and this line says why.
         */
        log.error(
          {
            type: "sso-config-decrypt-failed",
            field,
            note: "The stored identity provider config cannot be read with this KEY_ENCRYPTION_KEY. Sign-in through that provider will fail until it is re-registered.",
            error: String(error),
          },
          "sso-config-decrypt-failed",
        );
        next[field] = null;
      }
    }
  }
  return next as T;
}

/** Whether this call is about the SSO provider table at all. */
function isSsoModel(data: Rowish): boolean {
  return data.model === SSO_MODEL;
}

/**
 * Wrap an adapter factory so the identity provider config is ciphertext in the database.
 *
 * A factory rather than an adapter, because that is what Better Auth is handed and what it calls
 * once with its own resolved options. Wrapping the factory means the wrapper is in place for every
 * adapter Better Auth ever builds, including the one a plugin asks for.
 *
 * The returned adapter is the same adapter with four methods replaced. Anything Better Auth or a
 * plugin reaches for that is not one of those four is passed straight through, including
 * `transaction`, so this cannot quietly disable a capability by not knowing about it.
 */
export function encryptSsoConfig<Options, Adapter extends AdapterLike>(
  createAdapter: (options: Options) => Adapter,
  encryptionKey: string,
): (options: Options) => Adapter {
  return (options) => wrapAdapter(createAdapter(options), encryptionKey);
}

function wrapAdapter<T extends AdapterLike>(
  adapter: T,
  encryptionKey: string,
): T {
  // One cast, here, rather than at every call below. Better Auth's adapter type is generic over its
  // whole options object and describes each method with a model-specific payload; this file only
  // ever reads `model` and one nested object off it.
  const inner = adapter as unknown as RowishAdapter;
  const wrapped = {
    ...adapter,

    create: async (data: Rowish) => {
      if (!isSsoModel(data)) return inner.create?.(data);
      if (!data.data || typeof data.data !== "object") {
        // The payload key moved or disappeared (a Better Auth upgrade): nothing would be
        // encrypted and nothing would say so. The write proceeds — refusing it could break
        // registration — but the absence is on the record.
        log.warn(
          { type: "sso-config-write-payload-missing", method: "create" },
          "sso-config-write-payload-missing",
        );
      }
      const result = await inner.create?.({
        ...data,
        data: await encryptFields(encryptionKey, data.data as Rowish),
      });
      // Returned to the caller in the clear: the register route answers with what it stored, and the
      // encryption is about the column rather than about the request.
      return decryptFields(encryptionKey, result);
    },

    update: async (data: Rowish) => {
      if (!isSsoModel(data)) return inner.update?.(data);
      const result = await inner.update?.({
        ...data,
        update: await encryptFields(encryptionKey, data.update as Rowish),
      });
      return decryptFields(encryptionKey, result);
    },

    findOne: async (data: Rowish) => {
      const result = await inner.findOne?.(data);
      if (!isSsoModel(data)) return result;
      return decryptFields(encryptionKey, result);
    },

    findMany: async (data: Rowish) => {
      const result = await inner.findMany?.(data);
      if (!isSsoModel(data) || !Array.isArray(result)) return result;
      return Promise.all(
        result.map((row) => decryptFields(encryptionKey, row)),
      );
    },
  };

  if (inner.updateMany) {
    (wrapped as unknown as RowishAdapter).updateMany = async (data: Rowish) => {
      if (!isSsoModel(data)) return inner.updateMany?.(data);
      return inner.updateMany?.({
        ...data,
        update: await encryptFields(encryptionKey, data.update as Rowish),
      });
    };
  }

  return wrapped as unknown as T;
}
