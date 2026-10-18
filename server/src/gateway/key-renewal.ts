import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getLogger, type Logger } from "../../../shared/logger";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { PayerRef } from "../billing/payer";
import {
  type AccessGrantService,
  AccessGrantUseError,
} from "../bot-services/access-grants";
import type { BotServiceIdentity } from "../bot-services/types";
import type { Database } from "../db/client";
import { accessGrants, gatewayVirtualKeys } from "../db/schema";
import type { ModelRef } from "./catalog";
import {
  createCatalogFreshnessGate,
  type CatalogFreshnessVerdict,
} from "./catalog-freshness";
import {
  scrubErrorOfCredentialSecret,
} from "./credential-bundle";
import {
  type GatewayCustomerProvisionResult,
  provisionCustomer as provisionCustomerForDeployment,
} from "./customer";
import {
  GatewayAdminCredentialNotConfiguredError,
  gatewayAdminCredentialControls,
} from "./admin-credential";
import { gatewayEndpointControls } from "./endpoint-config";
import {
  createGatewayVirtualKeyClient,
  gatewayVirtualKeyName,
  type GatewayKeyRecord,
  type GatewayVirtualKeyClient,
} from "./key-issuance";
import {
  resolveVirtualKeyTtlMinutes,
  virtualKeyTtlMinutesProblem,
} from "./key-expiry";

/*
 * The short-lived key's RENEWAL (Bifrost 05.6, AC08/Q13/Q18): while the authorization holds,
 * the Bot trades its ageing credentialVersion for the next one — and the renewal is a
 * RE-VERDICT, never a time extension.
 *
 * RE-VERIFIED, NOT ASSUMED. The most common renewal defect is extending a term without
 * looking at what the term stands on. Every renewal here re-runs the whole stack of
 * verdicts the first issuance ran: the grant is still usable (04.5/04.6's own seam —
 * revoked, unknown, cross-Bot and disabled-Bot arrive as the one uniform refusal), the
 * person's gateway account mapping and the readiness gate still hold (05.1's idempotent
 * provisioner, the 01.7 gate inside it), the Bot is still OFFERED models (03.8's selectable
 * set — scope, price and freshness folded), and the catalog evidence those prices stand on
 * is still fresh (03.6's gate, the same single source of truth admission reads). Any "no"
 * ends the renewal with a typed, displayable reason before anything is dialed or stored.
 *
 * ROTATION, NOT MUTATION. A renewed key is a NEW key: the next `credentialVersion` of the
 * same grant (the unique index arbitrates under concurrency, the grant row lock serializes
 * the counter), a new plaintext that rides the one channel out (05.4's bundle), the same
 * customer — and every previous ACTIVE version of the grant stops being one, per 05.7's
 * rule: the remote key is deactivated (`is_active: false`, a 404 reading as "already
 * unavailable"), the local row flips to `revoked` — the sync's word for a version OpenBot
 * itself retired, which no remote answer resurrects. After a renewal the grant holds
 * exactly one active version: the new one. A deactivation the gateway refuses fails the
 * whole renewal with nothing written — a rotation that cannot retire the old version has
 * not happened.
 *
 * NO MONEY MOVES. The renewal touches none of it by construction: no credit grant, no
 * ledger row, no reservation, no release, no new authorization — the version counter and
 * the key table are the only writes in the transaction. Rotation does not reset accounting
 * or free an in-flight reservation (Q13/design §4); the settlement side still names the
 * key records it needs, which is why nothing is deleted anywhere here.
 *
 * THE TERM IS THE DEPLOYMENT'S. The renewed key's expiry is `renewedAt + keyTtlMinutes` —
 * one clock reading shared by the remote key, the local record, the answer and the audit —
 * the same configured term 05.5 resolves at composition. Renewal does not require the old
 * key to be alive: the Bot renews near (or just past) the end of a term, and the grant —
 * not the old key's liveness — is what the renewal trusts.
 */

/**
 * Why a renewal refused. Fixed constants of this module, displayable anywhere, none built
 * from upstream data — the same discipline the issuance and state-sync reason codes keep.
 */
export type GatewayKeyRenewalReasonCode =
  | "renewal_vk_endpoint_not_configured"
  | "renewal_vk_credential_unavailable"
  | "renewal_vk_unreachable"
  | "renewal_vk_timeout"
  | "renewal_vk_unauthenticated"
  | "renewal_vk_invalid_response"
  | "renewal_vk_unexpected_status"
  | "renewal_models_not_available"
  | "renewal_catalog_never_synced"
  | "renewal_catalog_stale";

export class GatewayKeyRenewalError extends Error {
  readonly reasonCode: GatewayKeyRenewalReasonCode;

  /** The freshness facts a catalog refusal carries; absent for every other reason. */
  readonly detail?: Record<string, unknown>;

  constructor(
    reasonCode: GatewayKeyRenewalReasonCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayKeyRenewalError";
    this.reasonCode = reasonCode;
    this.detail = detail;
  }
}

/**
 * The remote deactivation seam a renewal retires previous versions through. The gateway
 * answering 404 is an ANSWER — the key is already unavailable — not a failure; every
 * transport failure is one of the typed {@link GatewayKeyRenewalError} reason codes.
 */
export type GatewayVirtualKeyDeactivationClient = {
  deactivateVirtualKey: (input: {
    gatewayVirtualKeyId: string;
  }) => Promise<void>;
};

/** What `renewKeyForGrant` answers: the new record, its plaintext exactly once, and the
 * credentialVersions this renewal retired. */
export type RenewedGatewayKey = GatewayKeyRecord & {
  /**
   * The plaintext key value. Exactly as 05.3's issuance: it exists here once — in this
   * answer — and only on the authenticated Bot service channel (05.4's bundle wraps it).
   * It is in no log, no audit row and no database column.
   */
  secret: string;
  /** The versions this renewal turned over: every previously active version of the grant. */
  supersededVersions: number[];
};

/** The wall clock, the term's default measure. */
function defaultNow(): Date {
  return new Date();
}

/** A `gvk-` record id: 8 random bytes as hex, the draw size the other gateway ids use. */
function generateKeyId(): string {
  return `gvk-${randomBytes(8).toString("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type GatewayKeyRenewalDeps = {
  database: Database;
  /**
   * 04.5's authorization-use seam (`resolveForBot`), the only grant verdict this module
   * trusts: unknown, revoked, cross-Bot and disabled-Bot renewals arrive as one uniform
   * refusal — the same silence issuance keeps, so a prober learns nothing here either.
   */
  resolveForBot: AccessGrantService["resolveForBot"];
  /**
   * 05.1's idempotent provisioning seam: confirms the user's gateway Customer (the 01.7
   * gate runs inside it), answering the customerId the renewed key bills — the account
   * re-verification and the gate in one seam.
   */
  provisionCustomer: (ref: PayerRef) => Promise<GatewayCustomerProvisionResult>;
  /**
   * The Bot's own selectable refs (03.8's filter — scope, price and freshness folded).
   * An empty set is the "models are no longer open" verdict; a throw is the seam's own
   * unavailability, never a silent pass.
   */
  listSelectableModels: (botId: string) => Promise<ModelRef[]>;
  /**
   * 03.6's freshness verdict — the same gate admission reads, so a stale catalog refuses
   * a renewal with the exact facts (cap, last good sync, age) an operator acts on.
   */
  assertCatalogFresh: (
    modelRef: ModelRef,
    now?: Date,
  ) => Promise<CatalogFreshnessVerdict>;
  /** The mint transport (05.3's create — renewal mints, it does not patch terms). */
  createClient: GatewayVirtualKeyClient;
  /** The deactivation transport (see {@link GatewayVirtualKeyDeactivationClient}). */
  deactivationClient: GatewayVirtualKeyDeactivationClient;
  /**
   * The renewed key's term in minutes (05.5): measured from the renewal instant. The
   * composition states the policy explicitly — an illegal TTL refuses here, before any
   * renewal runs.
   */
  keyTtlMinutes: number;
  /** The clock the term is measured on; the wall clock unless a test injects another. */
  now?: () => Date;
  auditStore?: AuditStore;
  log?: Logger;
};

export type GatewayKeyRenewalService = {
  /**
   * The one entry point: re-verify everything, then rotate — retire every active version
   * of this authorization (gateway-side deactivation first, then the local flip) and mint
   * the next credentialVersion. Answers the new record, its plaintext (exactly once, this
   * channel only) and the retired versions. The accounting layer is not touched: no credit
   * grant, no ledger row, no reservation, no new authorization exists on any path here.
   */
  renewKeyForGrant: (
    grantId: string,
    identity: BotServiceIdentity,
  ) => Promise<RenewedGatewayKey>;
};

export function createGatewayKeyRenewalService(
  deps: GatewayKeyRenewalDeps,
): GatewayKeyRenewalService {
  // The term is policy, not a suggestion — the same composition-time refusal 05.3 keeps.
  const ttlProblem = virtualKeyTtlMinutesProblem(
    "keyTtlMinutes",
    deps.keyTtlMinutes,
  );
  if (ttlProblem) throw new Error(ttlProblem);
  const log = deps.log ?? getLogger("server");

  /** The whole flow, exactly as built; the returned wrapper adds 05.4's leash. */
  async function renewForGrant(
    grantId: string,
    identity: BotServiceIdentity,
    onMinted?: (secret: string) => void,
  ) {
    // 1. The authorization still holds — 04.5's own verdict, the uniform refusal. A grant
    // revoked mid-flight is caught again inside the transaction below (the row lock).
    const grant = await deps.resolveForBot(grantId, identity);

    // 2. The account mapping and the readiness gate, re-confirmed through 05.1's idempotent
    // seam: the renewed key bills the SAME customer, and a deployment whose gateway is not
    // ready renews nothing.
    const { customerId } = await deps.provisionCustomer({
      kind: "personal",
      id: grant.userId,
    });

    // 3. The models must still be open: the Bot's own selectable set under the current
    // scope, prices and freshness (03.8's answer). An empty set is the "no longer open"
    // verdict — a renewal serving a key for nothing offered would be a lie with a term.
    const modelRefs = await deps.listSelectableModels(identity.botId);
    const [firstSelectableRef] = modelRefs;
    if (firstSelectableRef === undefined) {
      throw new GatewayKeyRenewalError(
        "renewal_models_not_available",
        "No model is currently open to this bot, so the key renewal is refused.",
      );
    }

    // 4. The freshness of the evidence those prices stand on — 03.6's own gate, the same
    // verdict admission reads. The catalog's state is deployment-wide (one sync row), so
    // the first selectable ref is the verdict's named subject and every ref shares it.
    const verdict = await deps.assertCatalogFresh(
      firstSelectableRef,
      deps.now?.() ?? defaultNow(),
    );
    if (!verdict.fresh) {
      throw new GatewayKeyRenewalError(
        verdict.reasonCode === "catalog_stale"
          ? "renewal_catalog_stale"
          : "renewal_catalog_never_synced",
        "The model catalog's evidence is not fresh, so the key renewal is refused.",
        { ...verdict.detail },
      );
    }

    // 5. The rotation transaction: the grant row is locked and re-verified here, so a
    // revocation that committed while the verdicts ran still wins — nothing is rotated for
    // a dead authorization. The lock also serializes two renewals of one grant; the
    // version counter's unique index is the backstop. The term is measured from ONE clock
    // reading, shared by the remote key, the local record, the answer and the audit.
    const renewedAt = deps.now?.() ?? defaultNow();
    const expiresAt = new Date(renewedAt.getTime() + deps.keyTtlMinutes * 60_000);
    const renewed = await deps.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.grantId, grant.grantId))
        .for("update");
      if (row?.status !== "active" || row.botId !== identity.botId) {
        throw new AccessGrantUseError();
      }

      // The versions this renewal retires, read under the grant's lock.
      const actives = await tx
        .select({
          id: gatewayVirtualKeys.id,
          gatewayVirtualKeyId: gatewayVirtualKeys.gatewayVirtualKeyId,
          credentialVersion: gatewayVirtualKeys.credentialVersion,
        })
        .from(gatewayVirtualKeys)
        .where(
          and(
            eq(gatewayVirtualKeys.grantId, grant.grantId),
            eq(gatewayVirtualKeys.status, "active"),
          ),
        );

      // 05.7's rule, gateway side first: a version is retired at the gateway before
      // anything local moves, so the refusal paths leave the previous state exactly as it
      // was. A 404 is the gateway answering "already unavailable" — the goal met.
      for (const active of actives) {
        await deps.deactivationClient.deactivateVirtualKey({
          gatewayVirtualKeyId: active.gatewayVirtualKeyId,
        });
      }

      const [counter] = await tx
        .select({
          maxVersion: sql<number>`coalesce(max(${gatewayVirtualKeys.credentialVersion}), 0)`,
        })
        .from(gatewayVirtualKeys)
        .where(eq(gatewayVirtualKeys.grantId, grant.grantId));
      const credentialVersion = Number(counter?.maxVersion ?? 0) + 1;

      // The mint: ownership and the term — customerId, a name, the expiry, and nothing
      // else governed here (no budgets, no rate limits, no provider configs; the customer
      // owns those; the ledger is untouched by construction). `delete_after_expire: false`
      // keeps the retired versions nameable for the settlement side.
      const created = await deps.createClient.createVirtualKey({
        name: gatewayVirtualKeyName(grant.grantId, credentialVersion),
        customerId,
        expiresAt: expiresAt.toISOString(),
      });
      onMinted?.(created.value);

      // The local retirement: every previously active version flips to `revoked`, each
      // update guarded on the status it was decided against. The sync never reads a
      // revoked row, so no remote answer can undo OpenBot's own retirement.
      const supersededVersions: number[] = [];
      for (const active of actives) {
        const [flipped] = await tx
          .update(gatewayVirtualKeys)
          .set({ status: "revoked" })
          .where(
            and(
              eq(gatewayVirtualKeys.id, active.id),
              eq(gatewayVirtualKeys.status, "active"),
            ),
          )
          .returning({ version: gatewayVirtualKeys.credentialVersion });
        if (flipped) supersededVersions.push(flipped.version);
      }

      // The new record: no plaintext column exists; the sha256 identifies, never redeems.
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
        throw new GatewayKeyRenewalError(
          "renewal_vk_invalid_response",
          "The renewed virtual key record could not be stored, so the renewal is refused.",
        );
      }
      return {
        record: inserted,
        secret: created.value,
        supersededVersions,
      };
    });

    // 6. After the commit, fail-closed like every other capability act: a renewal the
    // trail cannot name is a renewal that failed. The payload names the act — never the
    // secret, never a reducible piece of one (a four-hex fingerprint at most).
    if (deps.auditStore) {
      await recordAuditEvent(deps.auditStore, {
        eventType: "gateway.key_renewed",
        targetType: "gateway_virtual_key",
        targetId: renewed.record.id,
        payload: {
          grantId: renewed.record.grantId,
          botId: renewed.record.botId,
          customerId: renewed.record.gatewayCustomerId,
          gatewayVirtualKeyId: renewed.record.gatewayVirtualKeyId,
          credentialVersion: renewed.record.credentialVersion,
          expiresAt: renewed.record.expiresAt?.toISOString() ?? null,
          supersededVersions: renewed.supersededVersions,
          fingerprint: sha256(renewed.secret).slice(-4),
        },
      });
    }
    log.info(
      {
        type: "gateway-key-renewed",
        keyId: renewed.record.id,
        grantId: renewed.record.grantId,
        botId: renewed.record.botId,
        credentialVersion: renewed.record.credentialVersion,
        supersededVersions: renewed.supersededVersions,
      },
      "Renewed a short-lived virtual key onto its next credential version.",
    );

    return {
      keyId: renewed.record.id,
      grantId: renewed.record.grantId,
      botId: renewed.record.botId,
      customerId: renewed.record.gatewayCustomerId,
      gatewayVirtualKeyId: renewed.record.gatewayVirtualKeyId,
      credentialVersion: renewed.record.credentialVersion,
      status: renewed.record.status,
      expiresAt: renewed.record.expiresAt?.toISOString() ?? null,
      createdAt: renewed.record.createdAt.toISOString(),
      secret: renewed.secret,
      supersededVersions: renewed.supersededVersions,
    };
  }

  return {
    async renewKeyForGrant(grantId, identity) {
      // The plaintext's containment leash (05.4): from the moment the remote create
      // answers, `minted` names the secret, and every failure this method lets fly is
      // scoured of it first — an error path must never become the plaintext's second
      // channel. Before the mint there is nothing to scrub, so the wrapper is a no-op.
      let minted: string | undefined;
      try {
        return await renewForGrant(grantId, identity, (secret) => {
          minted = secret;
        });
      } catch (error) {
        throw scrubErrorOfCredentialSecret(error, minted);
      }
    },
  };
}

/*
 * THE HTTP ADAPTER. The same discipline the issuance and state-sync adapters keep: one
 * request, one deadline that covers the body read too, a byte cap on everything the peer
 * sends, upstream bytes read only to be validated and dropped, and a classification that
 * never quotes the gateway. The deactivation needs no body content: statuses decide.
 */

/** How much of a response body the adapter will read before it stops believing the peer. */
export const GATEWAY_KEY_RENEWAL_MAX_BODY_BYTES = 512 * 1024;

function timeoutError(): Error {
  const error = new Error("The gateway virtual key deactivation timed out.");
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

export type GatewayVirtualKeyDeactivationClientDeps = {
  /** 01.1: the current endpoint snapshot, or undefined when none is configured. */
  readGatewayEndpoint: () => Promise<
    { baseUrl: string; requestTimeoutMs: number } | undefined
  >;
  /** 01.2's internal resolve — the only place the admin key's plaintext may come from. */
  resolveGatewayAdminCredential: () => Promise<{ adminKey: string }>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

/**
 * The production transport for {@link GatewayVirtualKeyDeactivationClient}: one
 * authenticated update (`PUT`, `is_active: false`) of one key's governance record, classified
 * into the module's fixed reason codes. A 404 is the deletion answer — the key is already
 * unavailable, which is the deactivation's whole goal — and is returned as success. The
 * answer's bytes are read only to be capped and dropped: the local verdict needs no body.
 */
export function createGatewayVirtualKeyDeactivationClient(
  deps: GatewayVirtualKeyDeactivationClientDeps,
): GatewayVirtualKeyDeactivationClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async deactivateVirtualKey({ gatewayVirtualKeyId }) {
      const config = await deps.readGatewayEndpoint();
      if (!config) {
        throw new GatewayKeyRenewalError(
          "renewal_vk_endpoint_not_configured",
          "No gateway address is configured, so the virtual key deactivation is refused.",
        );
      }
      let adminKey: string;
      try {
        adminKey = (await deps.resolveGatewayAdminCredential()).adminKey;
      } catch {
        throw new GatewayKeyRenewalError(
          "renewal_vk_credential_unavailable",
          "The gateway admin credential could not be resolved, so the virtual key deactivation is refused.",
        );
      }

      const url = new URL(
        `/api/governance/virtual-keys/${encodeURIComponent(gatewayVirtualKeyId)}`,
        config.baseUrl,
      );
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${adminKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ is_active: false }),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new GatewayKeyRenewalError(
            "renewal_vk_timeout",
            "The gateway did not answer the virtual key deactivation before the deadline, so the renewal is refused.",
          );
        }
        throw new GatewayKeyRenewalError(
          "renewal_vk_unreachable",
          "No connection to the gateway's virtual key surface was established, so the renewal is refused.",
        );
      }

      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        throw new GatewayKeyRenewalError(
          "renewal_vk_unauthenticated",
          "The gateway refused the admin credential for the virtual key surface, so the renewal is refused.",
        );
      }
      // The deletion answer: nothing to deactivate, the unavailability already holds.
      if (response.status === 404) {
        await discardBody(response);
        return;
      }

      const remainingMs = config.requestTimeoutMs - (Date.now() - startedAt);
      let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
      const capped = await Promise.race([
        readBodyCapped(response, GATEWAY_KEY_RENEWAL_MAX_BODY_BYTES),
        new Promise<never>((_, reject) => {
          deadlineHandle = setTimeout(
            () => reject(timeoutError()),
            Math.max(1, remainingMs),
          );
        }),
      ])
        .finally(() => {
          if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
        })
        .catch((error: unknown) => {
          if (isTimeoutError(error)) return null;
          throw new GatewayKeyRenewalError(
            "renewal_vk_invalid_response",
            "The gateway's virtual key deactivation response could not be read, so the renewal is refused.",
          );
        });

      if (capped === null) {
        throw new GatewayKeyRenewalError(
          "renewal_vk_timeout",
          "The gateway did not finish the virtual key deactivation response before the deadline, so the renewal is refused.",
        );
      }
      if (!capped.ok) {
        throw new GatewayKeyRenewalError(
          "renewal_vk_invalid_response",
          "The gateway's virtual key deactivation response was not a readable management answer, so the renewal is refused.",
        );
      }
      // The body is validated as bytes and dropped: statuses decide, contents never reach
      // a verdict here.
      void capped.text;
      if (response.status < 200 || response.status > 299) {
        throw new GatewayKeyRenewalError(
          "renewal_vk_unexpected_status",
          "The gateway answered the virtual key deactivation with an unexpected status, so the renewal is refused.",
        );
      }
    },
  };
}

/**
 * The deployment-composed renewal service: zero configuration, the installed controls answer
 * (endpoint 01.1, credential 01.2, gate 01.7 through the provisioner, the production grant
 * service, the 03.6 freshness gate over the shared database). The Bot's selectable-model
 * read is composed by the caller — the same source the claim answer's bundle reads, so a
 * renewal and a claim can never disagree about what is open. Missing pieces refuse — the
 * same fail-closed discipline the deployment issuer keeps.
 */
export function createDeploymentKeyRenewalService(options: {
  database: Database;
  modelAccess: AccessGrantService;
  /**
   * The Bot's own selectable refs, read live — wired to the exact same source the
   * CredentialBundle's `listSelectableModels` reads (the deployment composition), so the
   * re-verification and the answer name the same open set.
   */
  listSelectableModels: (botId: string) => Promise<ModelRef[]>;
  auditStore?: AuditStore;
  /** The environment the term resolves from; `process.env` unless a test injects another. */
  environment?: Record<string, string | undefined>;
}): GatewayKeyRenewalService {
  const keyTtlMinutes = resolveVirtualKeyTtlMinutes(
    options.environment ?? process.env,
  );
  const endpointControls = gatewayEndpointControls();
  const credentialControls = gatewayAdminCredentialControls();
  const readEndpoint = async () =>
    endpointControls ? endpointControls.readGatewayEndpoint() : undefined;
  const resolveCredential = async () => {
    if (!credentialControls) {
      throw new GatewayAdminCredentialNotConfiguredError(
        "The gateway admin credential is not configured.",
      );
    }
    return credentialControls.resolveGatewayAdminCredential();
  };
  return createGatewayKeyRenewalService({
    database: options.database,
    resolveForBot: options.modelAccess.resolveForBot,
    provisionCustomer: (ref) =>
      provisionCustomerForDeployment(options.database, ref),
    listSelectableModels: options.listSelectableModels,
    assertCatalogFresh: (modelRef, now) =>
      // The freshness gate over the shared database, the deployment's cap, the app clock —
      // the exact verdict 06.x's admission will read. Nothing is cached.
      createCatalogFreshnessGate({ database: options.database }).assertCatalogFresh(
        modelRef,
        now,
      ),
    createClient: createGatewayVirtualKeyClient({
      readGatewayEndpoint: readEndpoint,
      resolveGatewayAdminCredential: resolveCredential,
    }),
    deactivationClient: createGatewayVirtualKeyDeactivationClient({
      readGatewayEndpoint: readEndpoint,
      resolveGatewayAdminCredential: resolveCredential,
    }),
    keyTtlMinutes,
    auditStore: options.auditStore,
  });
}

/*
 * THE HTTP MAPPING NOTE. The renewal's refusals reach the Bot as: the grant seam's uniform
 * 403 (`model_access_grant_refused`), the gate's 503 (`gateway_not_ready`), the models
 * verdict's 403 (`renewal_models_not_available`), the freshness verdict's 503
 * (`renewal_catalog_stale` / `renewal_catalog_never_synced`, with the freshness facts),
 * the transport classifications' 502 (`renewal_vk_*`), and the provisioner's own 502s —
 * the route in `key-issuance.ts` owns that mapping, this module owns the vocabulary.
 */
