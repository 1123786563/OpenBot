import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getLogger, type Logger } from "../../../shared/logger";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { PayerRef } from "../billing/payer";
import {
  type AccessGrantService,
  AccessGrantUseError,
} from "../bot-services/access-grants";
import type { BotServiceVariables } from "../bot-services/auth";
import type { BotServiceIdentity } from "../bot-services/types";
import type { Database } from "../db/client";
import { accessGrants, gatewayVirtualKeys } from "../db/schema";
import {
  GatewayAdminCredentialNotConfiguredError,
  gatewayAdminCredentialControls,
} from "./admin-credential";
import {
  buildCredentialBundle,
  type CredentialBundleSources,
  CredentialBundleUnavailableError,
  scrubErrorOfCredentialSecret,
} from "./credential-bundle";
import {
  GatewayCustomerProvisionError,
  type GatewayCustomerProvisionResult,
  provisionCustomer as provisionCustomerForDeployment,
} from "./customer";
import {
  GatewayProvisionOutcomeUnknownError,
  GatewayProvisionRefusedError,
} from "./customer-provision";
import type { GatewayEndpointConfig } from "./endpoint-config";
import { gatewayEndpointControls } from "./endpoint-config";
import {
  resolveVirtualKeyTtlMinutes,
  virtualKeyTtlMinutesProblem,
} from "./key-expiry";
import { outstandingGatewayKeyDriftReasons } from "./key-drift";
import {
  GatewayKeyRenewalError,
  type RenewedGatewayKey,
} from "./key-renewal";
import { GatewayNotReadyError } from "./readiness";

/*
 * The short-lived virtual key issuance module (Bifrost 05.3, AC02/AC08/Q8): one independent
 * key per (user × Bot) authorization, all of one person's keys billing the SAME gateway
 * Customer.
 *
 * THE UNIT IS THE GRANT. 04.5's `access_grants` row is the authorization; this module turns it
 * into a key — and only that. Every issuance runs the grant through 04.5's own use-check seam
 * (`resolveForBot`), so a grantId nobody issued, one that was revoked, one that belongs to
 * another Bot, and one whose Bot was disabled are all the same uniform refusal
 * ({@link AccessGrantUseError}) — cross-Bot claiming (the AC) is not a branch here, it is the
 * seam's own answer. The registry is read live inside that seam, so a Bot disabled after the
 * grant was made is refused here too (Q15).
 *
 * ONE CUSTOMER, NO NEW MONEY. Before anything is created the person's gateway Customer is
 * confirmed through 05.1's idempotent seam (`provisionCustomer`), so two Bots issuing for the
 * same user converge on one mapping row and one remote customer — and every key created here
 * is owned by that customer (`customer_id` on the create, nothing else). The create carries NO
 * budgets, NO rate limits and NO provider configs: spending is governed by the customer at the
 * gateway (scope=customer), so issuing a second key cannot double a balance, and the OpenBot
 * ledger (credit grants, reservations, payer accounts) is untouched by construction.
 *
 * THE PLAINTEXT'S ONLY PATH. The gateway mints the key value (`sk-bf-…`) and answers with it
 * once. It rides out of this module exactly once — as {@link IssuedGatewayKey.secret} to the
 * caller — and the local record stores ONLY its sha256 (`value_hash`), so no database read can
 * ever redeem a key. Because nothing plaintext is stored, a repeated claim of the same grant
 * cannot re-serve the old secret: it issues a NEW key as the grant's next `credentialVersion`
 * (starting at 1, monotonic — the database's unique index arbitrates under concurrency). The
 * response channel (05.4's CredentialBundle boundary) is the only place the plaintext exists
 * after the create; logs, audits and errors carry a four-hex fingerprint, never the value.
 *
 * THE GATE COMES FIRST. Like every paid model capability, issuance refuses on a not-ready
 * gateway before a single remote call or local row — the refusal arrives through 05.1's
 * provisioner, whose first act is the 01.7 gate.
 *
 * EVERY REMOTE FAILURE IS A TYPED REFUSAL. The client adapter classifies what came back into
 * the fixed reason codes below — the same discipline `gateway/customer.ts` keeps: one request,
 * one deadline covering the body read, a byte cap on everything the peer sends, upstream bytes
 * read only to be validated and dropped, and a classification that never quotes the gateway.
 * A failure after the remote create but before the local insert can leave an inert orphan at
 * the gateway (its plaintext was never delivered); issuance names are random-suffixed so a
 * retry self-heals, and remote-only drift is 05.8's to reconcile.
 */

/** The virtual key create surface; each consumer owns the paths it calls. */
const VIRTUAL_KEYS_PATH = "/api/governance/virtual-keys";

/** How much of a response body the adapter will read before it stops believing the peer. */
export const GATEWAY_VIRTUAL_KEY_MAX_BODY_BYTES = 512 * 1024;

/**
 * Why a virtual key create refused. Fixed constants of this module, displayable anywhere, none
 * built from upstream data — the same discipline the customer adapter's reason codes keep.
 */
export type GatewayVirtualKeyReasonCode =
  | "gateway_vk_endpoint_not_configured"
  | "gateway_vk_credential_unavailable"
  | "gateway_vk_unreachable"
  | "gateway_vk_timeout"
  | "gateway_vk_unauthenticated"
  | "gateway_vk_invalid_response"
  | "gateway_vk_unexpected_status"
  | "gateway_vk_conflict"
  | "gateway_vk_grant_drift_paused";

export class GatewayVirtualKeyError extends Error {
  readonly reasonCode: GatewayVirtualKeyReasonCode;

  constructor(reasonCode: GatewayVirtualKeyReasonCode, message: string) {
    super(message);
    this.name = "GatewayVirtualKeyError";
    this.reasonCode = reasonCode;
  }
}

/**
 * The transport seam the issuer creates keys through. A create answers the gateway's own id
 * for the new key and its plaintext value exactly once; every failure is one of the typed
 * {@link GatewayVirtualKeyError} reason codes, never a bare throw the caller must parse.
 */
export type GatewayVirtualKeyClient = {
  createVirtualKey: (input: {
    /** The gateway-side name; unique per create (Bifrost holds vk names unique). */
    name: string;
    /** The customer the key bills — the ONLY governance the create carries. */
    customerId: string;
    /** RFC3339: the instant the key stops being usable for new requests (05.5's term).
     * The gateway refuses an expired key on the request path from this instant on. */
    expiresAt: string;
  }) => Promise<{ virtualKeyId: string; value: string }>;
};

/** The local record of one issuance, as every reader sees it. */
export type GatewayKeyRecord = {
  keyId: string;
  grantId: string;
  botId: string;
  /** The customer this key bills — shared by all of the user's keys. */
  customerId: string;
  gatewayVirtualKeyId: string;
  credentialVersion: number;
  status: (typeof gatewayVirtualKeys.$inferSelect)["status"];
  expiresAt: string | null;
  createdAt: string;
};

/** What `issueKeyForGrant` answers: the record, plus the plaintext exactly once. */
export type IssuedGatewayKey = GatewayKeyRecord & {
  /**
   * The plaintext key value. It exists here exactly once — in this answer — and only on the
   * authenticated Bot service channel (05.4's CredentialBundle wraps it). It is in no log, no
   * audit row and no database column.
   */
  secret: string;
};

/**
 * The gateway-side name for one issuance: names the authorization and its version for
 * operators, with a random suffix so a retry after a lost local write cannot collide with
 * the orphaned remote key it follows (the orphan is inert — its plaintext was never
 * delivered — and 05.8's state sync reconciles remote-only drift).
 */
export function gatewayVirtualKeyName(
  grantId: string,
  version: number,
): string {
  const suffix = randomBytes(4).toString("hex");
  return `openbot:${grantId}:v${version}:${suffix}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The wall clock, the term's default measure. */
function defaultNow(): Date {
  return new Date();
}

/** A `gvk-` record id: 8 random bytes as hex, the draw size the other gateway ids use. */
function generateKeyId(): string {
  return `gvk-${randomBytes(8).toString("hex")}`;
}

export type GatewayKeyIssuerDeps = {
  database: Database;
  /**
   * 04.5's authorization-use seam (`resolveForBot`), the only grant verdict this module
   * trusts: unknown, revoked, cross-Bot and disabled-Bot uses arrive as one uniform refusal.
   */
  resolveForBot: AccessGrantService["resolveForBot"];
  /**
   * 05.1's idempotent provisioning seam: confirms the user's gateway Customer (the 01.7 gate
   * runs inside it), answering the customerId every key of this user bills.
   */
  provisionCustomer: (ref: PayerRef) => Promise<GatewayCustomerProvisionResult>;
  /** The virtual key create transport (see {@link GatewayVirtualKeyClient}). */
  client: GatewayVirtualKeyClient;
  /**
   * The key's term in minutes (05.5): every minted key expires this long after its mint.
   * The composition states the policy explicitly — the deployment issuer resolves it from
   * the configured environment, so a deployment never silently mints keys with no term.
   */
  keyTtlMinutes: number;
  /** The clock the term is measured on; the wall clock unless a test injects another. */
  now?: () => Date;
  auditStore?: AuditStore;
  log?: Logger;
};

export type GatewayKeyIssuer = {
  /**
   * The one entry point: mint an independent virtual key for this (user × Bot) authorization.
   *
   * The flow is resolve → provision → (lock, re-verify, version) → create → record: the grant
   * is re-verified inside the insert transaction under a row lock, so a revocation that
   * commits mid-issuance still wins — no key is born for a dead authorization. The remote
   * create carries the customerId and nothing else; the local insert is one row, plaintext-
   * free, versioned per grant. The audit event goes out after the commit, fail-closed like
   * 04.5's: an issuance the trail cannot name is an issuance that failed — the key already
   * exists, so the caller's retry becomes the next credentialVersion rather than a silent
   * unaudited key.
   */
  issueKeyForGrant: (
    grantId: string,
    identity: BotServiceIdentity,
  ) => Promise<IssuedGatewayKey>;
};

export function createGatewayKeyIssuer(
  deps: GatewayKeyIssuerDeps,
): GatewayKeyIssuer {
  // The term is policy, not a suggestion: a composition handing the issuer an illegal
  // TTL (zero, negative, fractional, past the ceiling) is refused here rather than left
  // to mint keys that are born expired — the same fail-closed answer the deployment's
  // own configuration check gives, one layer down.
  const ttlProblem = virtualKeyTtlMinutesProblem(
    "keyTtlMinutes",
    deps.keyTtlMinutes,
  );
  if (ttlProblem) throw new Error(ttlProblem);
  const log = deps.log ?? getLogger("server");

  /** The whole flow, exactly as 05.3 built it; the returned wrapper adds 05.4's leash. */
  async function issueForGrant(
    grantId: string,
    identity: BotServiceIdentity,
    onMinted?: (secret: string) => void,
  ): Promise<IssuedGatewayKey> {
    // 1. The authorization-use check is 04.5's, not a re-derivation: one uniform refusal for
    // everything a probe could distinguish, and the live registry verdict inside it.
    const grant = await deps.resolveForBot(grantId, identity);

    // 1.5. The 05.9 drift pause: an authorization whose key's owner, scope or term at the
    // gateway no longer matches what this deployment recorded issues nothing until a human
    // disposes of the drift — a new key would extend a disagreement about WHO it bills and
    // WHAT it may call. The check is a read against the drift table, before anything is
    // dialed or provisioned; the outstanding set is empty for every healthy grant, so the
    // fast path is one indexed query.
    const driftReasons = await outstandingGatewayKeyDriftReasons(
      deps.database,
      grant.grantId,
    );
    if (driftReasons.length > 0) {
      throw new GatewayVirtualKeyError(
        "gateway_vk_grant_drift_paused",
        `The authorization has an unresolved key drift (${driftReasons.join(", ")}), so issuance is paused until an administrator disposes of the drift event.`,
      );
    }

    // 2. The one customer all of this user's keys bill. Idempotent, and the 01.7 readiness
    // gate runs inside the seam before anything is dialed or stored.
    const { customerId } = await deps.provisionCustomer({
      kind: "personal",
      id: grant.userId,
    });

    // 3. The issuance transaction: the grant row is locked and re-verified here, so a
    // revocation that committed while the customer was being provisioned still wins — the
    // key is never born for a dead authorization. The row lock also serializes the version
    // counter per grant; the unique index is the backstop. The term (05.5) is measured from
    // one clock reading taken before the create, so the remote key, the local record, the
    // answer and the audit all name the same instant.
    const issuedAt = (deps.now ?? defaultNow)();
    const expiresAt = new Date(issuedAt.getTime() + deps.keyTtlMinutes * 60_000);
    const issued = await deps.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.grantId, grant.grantId))
        .for("update");
      if (row?.status !== "active" || row.botId !== identity.botId) {
        throw new AccessGrantUseError();
      }
      const [counter] = await tx
        .select({
          maxVersion: sql<number>`coalesce(max(${gatewayVirtualKeys.credentialVersion}), 0)`,
        })
        .from(gatewayVirtualKeys)
        .where(eq(gatewayVirtualKeys.grantId, grant.grantId));
      const credentialVersion = Number(counter?.maxVersion ?? 0) + 1;

      // 4. The remote create: ownership and the term — customerId, a name, the expiry, and
      // nothing else governed here (no budgets, no rate limits, no provider configs; the
      // customer owns those). `delete_after_expire: false` keeps the gateway's cleanup job
      // from deleting the record once the term passes: the expired key is the settlement
      // and state-sync side's name for what happened here, not litter (05.5/06.8/08.x).
      const created = await deps.client.createVirtualKey({
        name: gatewayVirtualKeyName(grant.grantId, credentialVersion),
        customerId,
        expiresAt: expiresAt.toISOString(),
      });
      onMinted?.(created.value);

      // 5. The local record: no plaintext column exists; the sha256 identifies, never redeems.
      // `expires_at` records the term the key was minted under — the same instant the remote
      // key was given — so every local reader (bundle, status views, the expiry verdict) and
      // the gateway agree on when the key stops starting new requests.
      const [inserted] = await tx
        .insert(gatewayVirtualKeys)
        .values({
          id: generateKeyId(),
          grantId: grant.grantId,
          botId: grant.botId,
          gatewayCustomerId: customerId,
          gatewayVirtualKeyId: created.virtualKeyId,
          valueHash: sha256(created.value),
          credentialVersion,
          status: "active",
          expiresAt,
        })
        .returning();
      if (!inserted) {
        throw new GatewayVirtualKeyError(
          "gateway_vk_invalid_response",
          "The virtual key record could not be stored, so the issuance is refused.",
        );
      }
      return { record: inserted, secret: created.value };
    });

    // 6. After the commit, fail-closed like every other issuance of a capability: an
    // issuance the trail cannot name is an issuance that failed. The payload names the act —
    // never the secret, never a reducible piece of one (a four-hex fingerprint at most).
    if (deps.auditStore) {
      await recordAuditEvent(deps.auditStore, {
        eventType: "gateway.key_issued",
        targetType: "gateway_virtual_key",
        targetId: issued.record.id,
        payload: {
          grantId: issued.record.grantId,
          botId: issued.record.botId,
          customerId: issued.record.gatewayCustomerId,
          gatewayVirtualKeyId: issued.record.gatewayVirtualKeyId,
          credentialVersion: issued.record.credentialVersion,
          expiresAt: issued.record.expiresAt?.toISOString() ?? null,
          fingerprint: sha256(issued.secret).slice(-4),
        },
      });
    }
    log.info(
      {
        type: "gateway-key-issued",
        keyId: issued.record.id,
        grantId: issued.record.grantId,
        botId: issued.record.botId,
        credentialVersion: issued.record.credentialVersion,
      },
      "Issued a short-lived virtual key for a user × Bot authorization.",
    );

    return {
      keyId: issued.record.id,
      grantId: issued.record.grantId,
      botId: issued.record.botId,
      customerId: issued.record.gatewayCustomerId,
      gatewayVirtualKeyId: issued.record.gatewayVirtualKeyId,
      credentialVersion: issued.record.credentialVersion,
      status: issued.record.status,
      expiresAt: issued.record.expiresAt?.toISOString() ?? null,
      createdAt: issued.record.createdAt.toISOString(),
      secret: issued.secret,
    };
  }

  return {
    async issueKeyForGrant(grantId, identity) {
      // The plaintext's containment leash (05.4): from the moment the remote create answers,
      // `minted` names the secret, and every failure this method lets fly is scoured of it
      // first — an error path must never become the plaintext's second channel. Before the
      // mint there is nothing to scrub, so the wrapper is a no-op there.
      let minted: string | undefined;
      try {
        return await issueForGrant(grantId, identity, (secret) => {
          minted = secret;
        });
      } catch (error) {
        throw scrubErrorOfCredentialSecret(error, minted);
      }
    },
  };
}

/*
 * THE HTTP ADAPTER. The same discipline the customer adapter keeps: one request, one deadline
 * that covers the body read too, a byte cap on everything the peer sends, upstream bytes read
 * only to be validated and dropped, and a classification that never quotes the gateway.
 */

function timeoutError(): Error {
  const error = new Error("The gateway virtual key request timed out.");
  error.name = "TimeoutError";
  return error;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

type CappedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "unreadable" };

async function readBodyCapped(
  response: Response,
  capBytes: number,
): Promise<CappedBody> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > capBytes) {
    return { ok: false, reason: "too_large" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, reason: "unreadable" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      void reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The body of a refused response is worthless; a read failure changes nothing.
  }
}

/** The virtual key object a create answer carries, read strictly. */
function createdKeyFrom(json: unknown):
  | {
      virtualKeyId: string;
      value: string;
    }
  | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const key = (json as { virtual_key?: unknown }).virtual_key;
  if (key === null || typeof key !== "object") return undefined;
  const id = (key as { id?: unknown }).id;
  const value = (key as { value?: unknown }).value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof value !== "string" ||
    value.length === 0
  ) {
    return undefined;
  }
  return { virtualKeyId: id, value };
}

export type GatewayVirtualKeyClientDeps = {
  /** 01.1: the current endpoint snapshot, or undefined when none is configured. */
  readGatewayEndpoint: () => Promise<GatewayEndpointConfig | undefined>;
  /** 01.2's internal resolve — the only place the admin key's plaintext may come from. */
  resolveGatewayAdminCredential: () => Promise<{ adminKey: string }>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

/**
 * The production transport for {@link GatewayVirtualKeyClient}: one authenticated request to
 * the gateway's virtual key create surface, classified into the module's fixed reason codes.
 * The plaintext the answer carries is returned to the caller and never written anywhere here.
 */
export function createGatewayVirtualKeyClient(
  deps: GatewayVirtualKeyClientDeps,
): GatewayVirtualKeyClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async createVirtualKey({ name, customerId, expiresAt }) {
      const config = await deps.readGatewayEndpoint();
      if (!config) {
        throw new GatewayVirtualKeyError(
          "gateway_vk_endpoint_not_configured",
          "No gateway address is configured, so the virtual key create is refused.",
        );
      }
      let adminKey: string;
      try {
        adminKey = (await deps.resolveGatewayAdminCredential()).adminKey;
      } catch {
        throw new GatewayVirtualKeyError(
          "gateway_vk_credential_unavailable",
          "The gateway admin credential could not be resolved, so the virtual key create is refused.",
        );
      }

      const url = new URL(VIRTUAL_KEYS_PATH, config.baseUrl);
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${adminKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name,
            customer_id: customerId,
            allow_all_providers: true,
            expires_at: expiresAt,
            delete_after_expire: false,
          }),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new GatewayVirtualKeyError(
            "gateway_vk_timeout",
            "The gateway did not answer the virtual key create before the deadline, so issuance is refused.",
          );
        }
        throw new GatewayVirtualKeyError(
          "gateway_vk_unreachable",
          "No connection to the gateway's virtual key surface was established, so issuance is refused.",
        );
      }

      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        throw new GatewayVirtualKeyError(
          "gateway_vk_unauthenticated",
          "The gateway refused the admin credential for the virtual key surface, so issuance is refused.",
        );
      }

      const remainingMs = config.requestTimeoutMs - (Date.now() - startedAt);
      const capped = await Promise.race([
        readBodyCapped(response, GATEWAY_VIRTUAL_KEY_MAX_BODY_BYTES),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(timeoutError()), Math.max(1, remainingMs)),
        ),
      ]).catch((error: unknown) => {
        if (isTimeoutError(error)) return null;
        throw new GatewayVirtualKeyError(
          "gateway_vk_invalid_response",
          "The gateway's virtual key response could not be read, so issuance is refused.",
        );
      });

      if (capped === null) {
        throw new GatewayVirtualKeyError(
          "gateway_vk_timeout",
          "The gateway did not finish the virtual key response before the deadline, so issuance is refused.",
        );
      }
      if (!capped.ok) {
        throw new GatewayVirtualKeyError(
          "gateway_vk_invalid_response",
          "The gateway's virtual key response was not a readable management answer, so issuance is refused.",
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(capped.text);
      } catch {
        throw new GatewayVirtualKeyError(
          "gateway_vk_invalid_response",
          "The gateway's virtual key response was not JSON, so issuance is refused.",
        );
      }
      if (response.status === 409) {
        void json; // validated and dropped
        throw new GatewayVirtualKeyError(
          "gateway_vk_conflict",
          "The gateway refused the virtual key create as a duplicate name, so issuance is refused.",
        );
      }
      if (response.status < 200 || response.status > 299) {
        void json; // validated and dropped
        throw new GatewayVirtualKeyError(
          "gateway_vk_unexpected_status",
          "The gateway answered the virtual key create with an unexpected status, so issuance is refused.",
        );
      }
      const created = createdKeyFrom(json);
      if (!created) {
        throw new GatewayVirtualKeyError(
          "gateway_vk_invalid_response",
          "The gateway's virtual key create answer carried no key id or value, so issuance is refused.",
        );
      }
      return created;
    },
  };
}

/**
 * The deployment-composed issuer: zero configuration, the installed controls answer (endpoint
 * 01.1, credential 01.2, gate 01.7 through the provisioner, the production grant service).
 * Missing pieces refuse — the same fail-closed discipline the zero-arg customer entry keeps.
 * The key's term (05.5) resolves from the environment here — an illegal configured term
 * throws at composition, refusing the boot with its reason, so a deployment never runs
 * half-configured while minting termless keys.
 */
export function createDeploymentKeyIssuer(options: {
  database: Database;
  modelAccess: AccessGrantService;
  auditStore?: AuditStore;
  /** The environment the term resolves from; `process.env` unless a test injects another. */
  environment?: Record<string, string | undefined>;
}): GatewayKeyIssuer {
  const keyTtlMinutes = resolveVirtualKeyTtlMinutes(
    options.environment ?? process.env,
  );
  const endpointControls = gatewayEndpointControls();
  const credentialControls = gatewayAdminCredentialControls();
  return createGatewayKeyIssuer({
    database: options.database,
    resolveForBot: options.modelAccess.resolveForBot,
    provisionCustomer: (ref) =>
      provisionCustomerForDeployment(options.database, ref),
    keyTtlMinutes,
    client: createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () =>
        endpointControls ? endpointControls.readGatewayEndpoint() : undefined,
      resolveGatewayAdminCredential: async () => {
        if (!credentialControls) {
          throw new GatewayAdminCredentialNotConfiguredError(
            "The gateway admin credential is not configured.",
          );
        }
        return credentialControls.resolveGatewayAdminCredential();
      },
    }),
    auditStore: options.auditStore,
  });
}

/** The key as the issuance record half of the claim answer carries it; the bundle half (05.4)
 * repeats the secret by construction — both fields ride the one authenticated channel. The
 * renewal route answers the same record shape (its caller may add the retired versions). */
export function serializeKey(key: IssuedGatewayKey) {
  return {
    keyId: key.keyId,
    grantId: key.grantId,
    botId: key.botId,
    customerId: key.customerId,
    gatewayVirtualKeyId: key.gatewayVirtualKeyId,
    credentialVersion: key.credentialVersion,
    status: key.status,
    expiresAt: key.expiresAt,
    createdAt: key.createdAt,
    secret: key.secret,
  };
}

export type KeyIssuanceRoutesDeps = {
  /** The issuer's one entry point, already composed (see {@link createGatewayKeyIssuer}). */
  issue: GatewayKeyIssuer["issueKeyForGrant"];
  /**
   * The renewal service's one entry point (Bifrost 05.6, see {@link createGatewayKeyRenewalService}),
   * already composed. A deployment that does not compose it answers `renewal_unavailable` —
   * the same tagged 503 a missing issuer takes, never a silent absence.
   */
  renew?: (
    grantId: string,
    identity: BotServiceIdentity,
  ) => Promise<RenewedGatewayKey>;
  /**
   * Where the claim answer's bundle reads its non-secret sides from (05.4). A deployment
   * that does not compose it refuses every claim BEFORE minting — a bundle nobody can
   * complete must not become a key nobody can use — through the same tagged 503 door a
   * missing surface takes.
   */
  bundle?: CredentialBundleSources;
};

/**
 * The Bot-facing key issuance router (Bifrost 05.3): mounted under 04.2's service guard
 * (`/api/bot-service/keys`, the same door 04.3's binding codes ride), so only an
 * authenticated Bot service identity reaches it. One route — claim a key for a grant.
 *
 * The ANSWER carries the plaintext `secret` exactly once; that channel (an authenticated Bot
 * server) is the only one it ever travels on, and 05.4's CredentialBundle is the only shape
 * it rides: the claim answer is `{ key, bundle }` — `key` the issuance record, `bundle` the
 * frozen five-field contract ({@link CredentialBundle}) naming the endpoint to dial, the
 * Bot's own selectable ModelRefs, the secret and the key's term. Every refusal is tagged and
 * plaintext-free: the grant use check's uniform 403
 * (which never says whether a grantId exists, whose it is, or what state it is in), the door's
 * own 401, the gate's 503, the classified 502s of the two remote seams, the bundle-side 503
 * (no endpoint configured) and 502 (model refs unreadable) — both bundle failures arrive
 * after the mint, so their orphan is inert and a retry becomes the next credentialVersion.
 * A malformed body is a plain 400, and an unexpected failure is the fixed 500 below — never
 * a rethrow into the framework's default error output.
 */
export function createKeyIssuanceRoutes(
  deps: KeyIssuanceRoutesDeps | undefined,
) {
  const app = new Hono<{ Variables: BotServiceVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  if (!deps) {
    app.all("*", (context) =>
      context.json(
        {
          error: "Key issuance is not available.",
          code: "key_issuance_unavailable",
        },
        503,
      ),
    );
    return app;
  }

  const claimInput = z.strictObject({ grantId: z.string() });

  // The bundle's own error door: a failure completing the bundle answers a fixed refusal —
  // never the framework's default error output, which an unexpected error would otherwise
  // reach (and a refusal after the mint names no key: the orphan is inert, the retry the
  // next credentialVersion).
  app.onError((error, context) => {
    if (error instanceof CredentialBundleUnavailableError) {
      const status =
        error.reasonCode === "bundle_endpoint_unconfigured" ? 503 : 502;
      return context.json(
        { error: error.message, code: error.reasonCode },
        status,
      );
    }
    return context.json(
      {
        error: "The key claim failed unexpectedly, so the answer is refused.",
        code: "key_issuance_unexpected",
      },
      500,
    );
  });

  app.post("/", async (context) => {
    const parsed = claimInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        {
          error: "Send the grantId of the authorization to claim a key for.",
          code: "key_issuance_invalid_request",
        },
        400,
      );
    }
    // Fail-closed BEFORE minting: without the bundle's sources this channel could answer a
    // plaintext with no complete contract around it.
    if (!deps.bundle) {
      return context.json(
        {
          error:
            "The credential bundle is not available, so key issuance is refused.",
          code: "credential_bundle_unavailable",
        },
        503,
      );
    }
    const identity = context.get("botService");
    try {
      const key = await deps.issue(parsed.data.grantId, identity);
      // The bundle's non-secret sides, read live: the endpoint this deployment answers at
      // and the Bot's own selectable refs. A missing endpoint or a failed read refuses — a
      // bundle that is not the whole contract is not the contract. Each seam's failures are
      // translated INTO that seam's typed refusal (whatever the source threw — the sources
      // are per-deployment composition), so an operational bundle failure is its classified
      // 503/502 and only a genuine bug reaches the fixed 500 below.
      const endpointConfig = await deps.bundle
        .readGatewayEndpoint()
        .catch((error) => {
          if (error instanceof CredentialBundleUnavailableError) throw error;
          throw new CredentialBundleUnavailableError(
            "bundle_endpoint_unconfigured",
            "No gateway address is configured, so the credential bundle cannot be completed.",
          );
        });
      if (!endpointConfig) {
        throw new CredentialBundleUnavailableError(
          "bundle_endpoint_unconfigured",
          "No gateway address is configured, so the credential bundle cannot be completed.",
        );
      }
      const modelRefs = await deps.bundle
        .listSelectableModels(identity.botId)
        .catch((error) => {
          if (error instanceof CredentialBundleUnavailableError) throw error;
          throw new CredentialBundleUnavailableError(
            "bundle_models_unavailable",
            "The model catalog is not available, so the credential bundle cannot be completed.",
          );
        });
      const bundle = buildCredentialBundle({
        endpointConfig,
        modelRefs,
        issued: key,
      });
      return context.json({ key: serializeKey(key), bundle });
    } catch (error) {
      if (error instanceof AccessGrantUseError) {
        return context.json({ error: error.message, code: error.code }, 403);
      }
      if (error instanceof GatewayNotReadyError) {
        return context.json(
          {
            error:
              "The model gateway is not ready, so key issuance is refused.",
            code: "gateway_not_ready",
          },
          503,
        );
      }
      if (error instanceof GatewayVirtualKeyError) {
        // The drift pause is a conflict between the gateway's record and OpenBot's own,
        // pending a human decision — a 409 an operator acts on, not a gateway failure.
        return context.json(
          { error: error.message, code: error.reasonCode },
          error.reasonCode === "gateway_vk_grant_drift_paused" ? 409 : 502,
        );
      }
      if (error instanceof GatewayCustomerProvisionError) {
        return context.json(
          { error: error.message, code: error.reasonCode },
          502,
        );
      }
      if (
        error instanceof GatewayProvisionOutcomeUnknownError ||
        error instanceof GatewayProvisionRefusedError
      ) {
        return context.json({ error: error.message, code: error.code }, 502);
      }
      throw error;
    }
  });

  /*
   * THE RENEWAL ROUTE (Bifrost 05.6): `POST /keys/renew` with `{ grantId }`, under the same
   * service guard, answering the same `{ key, bundle }` shape plus `supersededVersions` —
   * the retired credentialVersions. The plaintext rides the same one channel under the
   * same leash; every refusal is tagged and plaintext-free: the grant seam's uniform 403
   * (revocation included — a revoked grant renews nothing), the gate's 503, the models
   * verdict's 403, the freshness verdict's 503 with its facts, the transport 502s, and the
   * fixed 500 for the genuinely unexpected — never the framework's default error output.
   */
  app.post("/renew", async (context) => {
    const parsed = claimInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        {
          error: "Send the grantId of the authorization to renew a key for.",
          code: "key_renewal_invalid_request",
        },
        400,
      );
    }
    if (!deps.renew) {
      return context.json(
        {
          error: "Key renewal is not available.",
          code: "renewal_unavailable",
        },
        503,
      );
    }
    // Fail-closed BEFORE minting: without the bundle's sources this channel could answer a
    // plaintext with no complete contract around it.
    if (!deps.bundle) {
      return context.json(
        {
          error:
            "The credential bundle is not available, so key renewal is refused.",
          code: "credential_bundle_unavailable",
        },
        503,
      );
    }
    const identity = context.get("botService");
    try {
      const renewed = await deps.renew(parsed.data.grantId, identity);
      // The bundle's non-secret sides, read live — the same reads the claim answer makes,
      // so a renewal and a claim name the same endpoint and the same open set.
      const endpointConfig = await deps.bundle
        .readGatewayEndpoint()
        .catch((error) => {
          if (error instanceof CredentialBundleUnavailableError) throw error;
          throw new CredentialBundleUnavailableError(
            "bundle_endpoint_unconfigured",
            "No gateway address is configured, so the credential bundle cannot be completed.",
          );
        });
      if (!endpointConfig) {
        throw new CredentialBundleUnavailableError(
          "bundle_endpoint_unconfigured",
          "No gateway address is configured, so the credential bundle cannot be completed.",
        );
      }
      const modelRefs = await deps.bundle
        .listSelectableModels(identity.botId)
        .catch((error) => {
          if (error instanceof CredentialBundleUnavailableError) throw error;
          throw new CredentialBundleUnavailableError(
            "bundle_models_unavailable",
            "The model catalog is not available, so the credential bundle cannot be completed.",
          );
        });
      const bundle = buildCredentialBundle({
        endpointConfig,
        modelRefs,
        issued: renewed,
      });
      return context.json({
        key: serializeKey(renewed),
        bundle,
        supersededVersions: renewed.supersededVersions,
      });
    } catch (error) {
      if (error instanceof AccessGrantUseError) {
        return context.json({ error: error.message, code: error.code }, 403);
      }
      if (error instanceof GatewayNotReadyError) {
        return context.json(
          {
            error:
              "The model gateway is not ready, so key renewal is refused.",
            code: "gateway_not_ready",
          },
          503,
        );
      }
      if (error instanceof GatewayKeyRenewalError) {
        if (error.reasonCode === "renewal_models_not_available") {
          return context.json(
            { error: error.message, code: error.reasonCode },
            403,
          );
        }
        if (error.reasonCode === "renewal_grant_drift_paused") {
          // A conflict pending a human decision — the same 409 the issuance pause takes.
          return context.json(
            { error: error.message, code: error.reasonCode },
            409,
          );
        }
        if (
          error.reasonCode === "renewal_catalog_stale" ||
          error.reasonCode === "renewal_catalog_never_synced"
        ) {
          return context.json(
            {
              error: error.message,
              code: error.reasonCode,
              ...(error.detail === undefined ? {} : { detail: error.detail }),
            },
            503,
          );
        }
        return context.json(
          { error: error.message, code: error.reasonCode },
          502,
        );
      }
      if (error instanceof GatewayCustomerProvisionError) {
        return context.json(
          { error: error.message, code: error.reasonCode },
          502,
        );
      }
      if (
        error instanceof GatewayProvisionOutcomeUnknownError ||
        error instanceof GatewayProvisionRefusedError
      ) {
        return context.json({ error: error.message, code: error.code }, 502);
      }
      throw error;
    }
  });

  return app;
}
