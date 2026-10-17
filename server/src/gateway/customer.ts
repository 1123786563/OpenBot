/**
 * The gateway Customer provisioning module (Bifrost 05.1, AC01/Q6/Q7): one OpenBot personal
 * user ↔ one Bifrost governance Customer — the "Bifrost Principal" CONTEXT.md names — mapped
 * once, idempotently, and only through a ready gateway.
 *
 * THE CONTRACT THIS MODULE PRODUCES. `provisionCustomer(ref)` answers `{ customerId,
 * provisionState }` and persists the mapping row (`gateway_customers`) that 05.3's key
 * issuance and 05.8's status sync read instead of asking the gateway. Repeated calls answer
 * the same customerId; a burst of concurrent calls leaves exactly one valid mapping — the
 * database's unique indexes arbitrate, never a read-check — and one remote entity, because the
 * gateway-side name is deterministic per subject (`payerKey`) and Bifrost refuses a duplicate
 * name with a 409 that this module resolves by listing that name. A remote success whose local
 * row never landed (a crash between the two) is exactly the gap 05.2 recovers from: this module
 * only guarantees that a 409-plus-resolve through the live call path adopts the existing entity
 * instead of minting a second one.
 *
 * A MAPPING, NOTHING MORE. Provisioning writes one row in `gateway_customers` and nothing
 * else: no billing customer, no credit grant, no ledger entry, no reservation, no payer
 * account. An account is born empty because it is born *absent* — balances belong to the
 * billing layer (02.x), keys belong to 05.3, and this module touches neither.
 *
 * THE GATE COMES FIRST. The first statement is the 01.7 readiness gate; a gateway that is not
 * ready refuses provisioning before anything is dialed (`GatewayNotReadyError`), and a process
 * with no installed gate refuses too. There is no fallback: no provider direct connection, no
 * free usage, no local-only "provisioned" state.
 *
 * EVERY REMOTE FAILURE IS A TYPED REFUSAL. The adapter classifies what came back into the
 * fixed reason codes below — unreachable, timeout, unauthenticated, invalid response,
 * unexpected status, a 409 the gateway cannot resolve by name — and every one of them refuses
 * loudly with no row written. Upstream bytes never survive a refusal: bodies are read only to
 * be validated and dropped, and no reason code interpolates anything the gateway sent.
 *
 * 05.2 EVOLUTION (migration 0135 — this module is unchanged in its own flow, and learns one
 * thing): the recovery layer may leave a reservation row — provision_state 'pending' or
 * 'recoverable', no gateway_customer_id on file. Such a row is NOT a mapping (the fast path
 * skips it and the create proceeds), and when this module's create lands for a subject whose
 * reservation is on file, the outcome ADOPTS the reservation: the row is completed with the
 * created/resolved id as 'confirmed' — the reservation's missing outcome is exactly this
 * outcome, and no second remote entity can be born (the name is deterministic). Rows 05.1
 * wrote stay 'active' and keep answering as they always have.
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getLogger, type Logger } from "../../../shared/logger";
import { type PayerRef, payerKey } from "../billing/payer";
import type { Database } from "../db/client";
import { gatewayCustomers } from "../db/schema/gateway";
import {
  GatewayAdminCredentialNotConfiguredError,
  gatewayAdminCredentialControls,
} from "./admin-credential";
import type { GatewayEndpointConfig } from "./endpoint-config";
import { gatewayEndpointControls } from "./endpoint-config";
import {
  assertGatewayReadyForBilling,
  type GatewayReadinessService,
} from "./readiness";

/** The subject kinds this module provisions. The gateway Customer is a personal user's principal. */
export type GatewayCustomerSubjectKind = "personal";

/**
 * The provisioning state a mapping row can carry. This module writes 'active'
 * (fresh provisioning); 05.2's recovery layer completes reservations as
 * 'confirmed' — a row in either spelling holds a complete association whose
 * remote id is on file, and readers treat the two as the same fact.
 */
export type GatewayCustomerProvisionState = "active" | "confirmed";

/** One gateway customer mapping row, as the module answers it. */
export type GatewayCustomerMapping = {
  id: string;
  kind: GatewayCustomerSubjectKind;
  payerId: string;
  /** The id the gateway generated for the Customer — what 05.3 addresses keys with. */
  gatewayCustomerId: string;
  /** The deterministic gateway-side name (= `payerKey`), 05.2's recovery lookup key. */
  gatewayCustomerName: string;
  provisionState: GatewayCustomerProvisionState;
  createdAt: string;
};

/** The contract 05.3/05.8 consume: `provisionCustomer(ref)` answers this. */
export type GatewayCustomerProvisionResult = {
  customerId: string;
  provisionState: GatewayCustomerProvisionState;
};

/**
 * Why a provision refused. Fixed constants of this module, displayable anywhere, none built
 * from upstream data — the same discipline the probe's reason codes keep.
 */
export type GatewayCustomerProvisionReasonCode =
  | "gateway_customer_endpoint_not_configured"
  | "gateway_customer_credential_unavailable"
  | "gateway_customer_unreachable"
  | "gateway_customer_timeout"
  | "gateway_customer_unauthenticated"
  | "gateway_customer_invalid_response"
  | "gateway_customer_unexpected_status"
  | "gateway_customer_remote_conflict_unresolved"
  | "gateway_customer_mapping_conflict";

export class GatewayCustomerProvisionError extends Error {
  readonly reasonCode: GatewayCustomerProvisionReasonCode;

  constructor(reasonCode: GatewayCustomerProvisionReasonCode, message: string) {
    super(message);
    this.name = "GatewayCustomerProvisionError";
    this.reasonCode = reasonCode;
  }
}

/** A `gc-` mapping id: 8 random bytes as hex, the draw size the payer account ids use. */
function generateMappingId(): string {
  return `gc-${randomBytes(8).toString("hex")}`;
}

/** The deterministic gateway-side name for a subject: the payer key itself. Bifrost holds
 * customer names unique, so two racing provisions for one user cannot become two remote
 * entities — one create wins, the others are refused with a 409 and resolve the winner by
 * this name. `payerKey` validates the id (non-empty, no stray whitespace, no `unknown_owner`),
 * and a non-personal kind is refused here: the gateway Customer is the *personal* user's
 * governance principal, and no other payer kind has one.
 */
export function gatewayCustomerName(ref: PayerRef): string {
  return payerKey(personalSubject(ref));
}

/**
 * The subject this module provisions, narrowed. Everything downstream — the mapping read,
 * the insert, the committed re-read — keys on this narrowed kind, so the compiler and the
 * `gateway_customers` kind check agree that only a personal subject ever reaches the table.
 */
function personalSubject(ref: PayerRef): {
  kind: GatewayCustomerSubjectKind;
  id: string;
} {
  if (ref.kind !== "personal") {
    throw new TypeError(
      `provisionCustomer maps a personal OpenBot user to one gateway Customer; payer kind "${String(
        ref.kind,
      )}" has no personal gateway principal.`,
    );
  }
  return { kind: ref.kind, id: ref.id };
}

/** The stored row's shape, read strictly. There is no lenient reading of a mapping. */
function mappingOf(
  row: typeof gatewayCustomers.$inferSelect,
): GatewayCustomerMapping | null {
  // 05.2: a row with no remote id on file is a recovery reservation
  // ('pending'/'recoverable'), not a mapping — the mapping this module answers
  // always names a remote entity, and a reservation reads as "no mapping yet".
  // The fast path below therefore skips reservations and proceeds to the create,
  // whose outcome adopts the reservation.
  if (row.gatewayCustomerId === null) return null;
  return {
    id: row.id,
    kind: row.kind,
    payerId: row.payerId,
    gatewayCustomerId: row.gatewayCustomerId,
    gatewayCustomerName: row.gatewayCustomerName,
    // 05.1's 'active' and recovery's 'confirmed' spell the same fact; the
    // answer normalizes instead of making callers learn both spellings.
    provisionState: row.provisionState === "confirmed" ? "confirmed" : "active",
    createdAt: row.createdAt.toISOString(),
  };
}

/** The one read every consumer shares: the mapping a subject holds, or null. */
async function readMappingRow(
  database: Database,
  subject: { kind: GatewayCustomerSubjectKind; id: string },
): Promise<GatewayCustomerMapping | null> {
  const [row] = await database
    .select()
    .from(gatewayCustomers)
    .where(
      and(
        eq(gatewayCustomers.kind, subject.kind),
        eq(gatewayCustomers.payerId, subject.id),
      ),
    )
    .limit(1);
  return row ? mappingOf(row) : null;
}

/**
 * The mapping a subject holds, or null when none was ever provisioned — the read 05.3's key
 * issuance and 05.8's status sync use instead of dialing the gateway. Only a personal kind
 * can ever hold one; every other kind answers null, not an error — a read of a mapping that
 * cannot exist is an absence, not a refusal.
 */
export async function readGatewayCustomerMapping(
  database: Database,
  ref: PayerRef,
): Promise<GatewayCustomerMapping | null> {
  if (ref.kind !== "personal") return null;
  return readMappingRow(database, { kind: ref.kind, id: ref.id });
}

/*
 * THE HTTP ADAPTER. The same discipline the probe keeps: one request, one deadline that
 * covers the body read too, a byte cap on everything the peer sends, upstream bytes read
 * only to be validated and dropped, and a classification that never quotes the gateway.
 */

/** How much of a response body the adapter will read before it stops believing the peer. */
export const GATEWAY_CUSTOMER_MAX_BODY_BYTES = 512 * 1024;

/** The management surface's customer paths; each consumer owns the paths it calls. */
const CUSTOMERS_PATH = "/api/governance/customers";

function timeoutError(): Error {
  const error = new Error("The gateway customer request timed out.");
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

/**
 * One authenticated request to the gateway's management surface, classified. Resolves with
 * `{ status, json }` for any status whose body parsed; throws the typed refusal for anything
 * transport-level, unauthenticated, unparseable, oversized — or past the deadline. The body
 * bytes are dropped the moment validation finishes; nothing upstream rides further.
 */
async function gatewayRequest(options: {
  config: GatewayEndpointConfig;
  adminKey: string;
  method: "POST" | "GET";
  path: string;
  body?: unknown;
  fetchImpl: typeof fetch;
}): Promise<{ status: number; json: unknown }> {
  const { config, adminKey, method, path, body, fetchImpl } = options;
  const url = new URL(path, config.baseUrl);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${adminKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new GatewayCustomerProvisionError(
        "gateway_customer_timeout",
        "The gateway did not answer the customer request before the deadline, so provisioning is refused.",
      );
    }
    throw new GatewayCustomerProvisionError(
      "gateway_customer_unreachable",
      "No connection to the gateway's customer surface was established, so provisioning is refused.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    throw new GatewayCustomerProvisionError(
      "gateway_customer_unauthenticated",
      "The gateway refused the admin credential for the customer surface, so provisioning is refused.",
    );
  }

  // The deadline covers the body read too: a peer that sends headers and then trickles
  // forever is a timeout, not a hung provision.
  const remainingMs = config.requestTimeoutMs - (Date.now() - startedAt);
  const capped = await Promise.race([
    readBodyCapped(response, GATEWAY_CUSTOMER_MAX_BODY_BYTES),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(timeoutError()), Math.max(1, remainingMs)),
    ),
  ]).catch((error: unknown) => {
    if (isTimeoutError(error)) return null;
    throw new GatewayCustomerProvisionError(
      "gateway_customer_invalid_response",
      "The gateway's customer response could not be read, so provisioning is refused.",
    );
  });

  if (capped === null) {
    throw new GatewayCustomerProvisionError(
      "gateway_customer_timeout",
      "The gateway did not finish the customer response before the deadline, so provisioning is refused.",
    );
  }
  if (!capped.ok) {
    throw new GatewayCustomerProvisionError(
      "gateway_customer_invalid_response",
      "The gateway's customer response was not a readable management answer, so provisioning is refused.",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(capped.text);
  } catch {
    throw new GatewayCustomerProvisionError(
      "gateway_customer_invalid_response",
      "The gateway's customer response was not JSON, so provisioning is refused.",
    );
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new GatewayCustomerProvisionError(
      "gateway_customer_invalid_response",
      "The gateway's customer response was not a management answer, so provisioning is refused.",
    );
  }
  return { status: response.status, json };
}

/** Upstream bytes are never kept: every refused path drops the body before throwing. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The body of a refused response is worthless; a read failure changes nothing.
  }
}

/** The customer object a create or list answer carries, read strictly. */
function customerIdFrom(json: unknown): string | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const customer = (json as { customer?: unknown }).customer;
  if (customer === null || typeof customer !== "object") return undefined;
  const id = (customer as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function createGatewayCustomer(options: {
  config: GatewayEndpointConfig;
  adminKey: string;
  name: string;
  fetchImpl: typeof fetch;
}): Promise<{ kind: "created"; customerId: string } | { kind: "conflict" }> {
  const { status, json } = await gatewayRequest({
    ...options,
    method: "POST",
    path: CUSTOMERS_PATH,
    body: { name: options.name },
  });
  if (status === 409) {
    // The deterministic name already exists remotely: a concurrent provision won, or a
    // previous attempt created the entity and died before its mapping landed (05.2's gap).
    return { kind: "conflict" };
  }
  if (status < 200 || status > 299) {
    void json; // validated and dropped
    throw new GatewayCustomerProvisionError(
      "gateway_customer_unexpected_status",
      "The gateway answered the customer create with an unexpected status, so provisioning is refused.",
    );
  }
  const customerId = customerIdFrom(json);
  if (!customerId) {
    throw new GatewayCustomerProvisionError(
      "gateway_customer_invalid_response",
      "The gateway's customer create answer carried no customer id, so provisioning is refused.",
    );
  }
  return { kind: "created", customerId };
}

/** Resolve the one customer whose name equals the deterministic name, or undefined. */
async function findGatewayCustomerByName(options: {
  config: GatewayEndpointConfig;
  adminKey: string;
  name: string;
  fetchImpl: typeof fetch;
}): Promise<string | undefined> {
  const { status, json } = await gatewayRequest({
    ...options,
    method: "GET",
    path: `${CUSTOMERS_PATH}?search=${encodeURIComponent(options.name)}&limit=100`,
  });
  if (status < 200 || status > 299) {
    throw new GatewayCustomerProvisionError(
      "gateway_customer_unexpected_status",
      "The gateway answered the customer lookup with an unexpected status, so provisioning is refused.",
    );
  }
  const candidates = (json as { customers?: unknown }).customers;
  if (!Array.isArray(candidates)) {
    throw new GatewayCustomerProvisionError(
      "gateway_customer_invalid_response",
      "The gateway's customer lookup answer carried no customer list, so provisioning is refused.",
    );
  }
  // The search is a substring match at the gateway; the mapping stands on an exact name.
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const entry = candidate as { name?: unknown; id?: unknown };
    if (
      entry.name === options.name &&
      typeof entry.id === "string" &&
      entry.id.length > 0
    ) {
      return entry.id;
    }
  }
  return undefined;
}

export type GatewayCustomerProvisionerDeps = {
  database: Database;
  /** 01.1: the current endpoint snapshot, or undefined when none is configured. */
  readGatewayEndpoint: () => Promise<GatewayEndpointConfig | undefined>;
  /** 01.2's internal resolve — the only place the admin key's plaintext may come from. */
  resolveGatewayAdminCredential: () => Promise<{ adminKey: string }>;
  /**
   * The 01.7 gate. Omitted in production: the installed gate answers through the module
   * entry, and a process that never installed one refuses (`gateway_readiness_gate_unavailable`).
   */
  gate?: GatewayReadinessService;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  log?: Logger;
};

export type GatewayCustomerProvisioner = {
  /**
   * Idempotent, race-safe provisioning: the gate first, then the fast path over the local
   * mapping, then the gateway create (a 409 resolves the existing entity by its unique
   * deterministic name), then one insert-or-nothing against the subject's unique index and
   * a committed-state re-read. Concurrent callers leave exactly one mapping row and answer
   * the one customerId. Creates the mapping and nothing else — no grant, no ledger row, no
   * balance, no payer account.
   */
  provisionCustomer: (ref: PayerRef) => Promise<GatewayCustomerProvisionResult>;
  /** The mapping this subject holds, or null. */
  readGatewayCustomerMapping: (
    ref: PayerRef,
  ) => Promise<GatewayCustomerMapping | null>;
};

export function createGatewayCustomerProvisioner(
  deps: GatewayCustomerProvisionerDeps,
): GatewayCustomerProvisioner {
  const log = deps.log ?? getLogger("server");
  const fetchImpl = deps.fetchImpl ?? fetch;

  const provisionCustomer = async (
    ref: PayerRef,
  ): Promise<GatewayCustomerProvisionResult> => {
    // 1. The gate comes first, always: a gateway that is not ready refuses provisioning
    // before anything is dialed, and a process with no installed gate refuses too.
    if (deps.gate) {
      await deps.gate.assertGatewayReadyForBilling();
    } else {
      await assertGatewayReadyForBilling();
    }

    const subject = personalSubject(ref);
    const name = gatewayCustomerName(subject);

    // 2. The fast path: an already-committed mapping answers as-is, with no remote call.
    const existing = await readMappingRow(deps.database, subject);
    if (existing) {
      return {
        customerId: existing.gatewayCustomerId,
        provisionState: existing.provisionState,
      };
    }

    // 3. The remote create. The snapshot the gate just vouched for is the snapshot this
    // request dials; a configuration change mid-flight retires itself into a typed refusal.
    const config = await deps.readGatewayEndpoint();
    if (!config) {
      throw new GatewayCustomerProvisionError(
        "gateway_customer_endpoint_not_configured",
        "No gateway address is configured, so provisioning is refused.",
      );
    }
    let adminKey: string;
    try {
      adminKey = (await deps.resolveGatewayAdminCredential()).adminKey;
    } catch {
      throw new GatewayCustomerProvisionError(
        "gateway_customer_credential_unavailable",
        "The gateway admin credential could not be resolved, so provisioning is refused.",
      );
    }

    const created = await createGatewayCustomer({
      config,
      adminKey,
      name,
      fetchImpl,
    });
    let customerId: string;
    if (created.kind === "created") {
      customerId = created.customerId;
    } else {
      // 4. The name was taken remotely: converge on that entity or refuse — never mint
      // a second one, never guess an id.
      const resolved = await findGatewayCustomerByName({
        config,
        adminKey,
        name,
        fetchImpl,
      });
      if (!resolved) {
        throw new GatewayCustomerProvisionError(
          "gateway_customer_remote_conflict_unresolved",
          "The gateway refused the customer create as a duplicate but could not resolve the existing customer by its name, so provisioning is refused.",
        );
      }
      customerId = resolved;
    }

    // 5. The mapping, committed by the database's unique indexes and not by a read-check:
    // the insert-or-nothing races every concurrent provision for this subject, and the
    // losers re-read the committed row and answer the winner's customerId.
    const [inserted] = await deps.database
      .insert(gatewayCustomers)
      .values({
        id: generateMappingId(),
        kind: subject.kind,
        payerId: subject.id,
        gatewayCustomerId: customerId,
        gatewayCustomerName: name,
        provisionState: "active",
      })
      // No conflict target: DO NOTHING absorbs the race on any of the three unique
      // indexes, and the re-reads below sort out which one it was.
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      log.info(
        {
          type: "gateway-customer-provisioned",
          payerId: subject.id,
          mappingId: inserted.id,
        },
        "Provisioned the gateway customer mapping for a personal user.",
      );
      return {
        customerId,
        provisionState: "active",
      };
    }

    const [committed] = await deps.database
      .select()
      .from(gatewayCustomers)
      .where(
        and(
          eq(gatewayCustomers.kind, subject.kind),
          eq(gatewayCustomers.payerId, subject.id),
        ),
      )
      .limit(1);
    if (!committed) {
      // The insert lost one of the unique indexes and no committed mapping
      // answers this subject: the deterministic identity (remote id or name) is held
      // by another subject's row — reachable only through a hand-placed row, and
      // answered loudly — never by borrowing or minting a second mapping.
      throw new GatewayCustomerProvisionError(
        "gateway_customer_mapping_conflict",
        "The mapping insert lost a unique index and no committed mapping answers this subject, so the subject's gateway identity is held elsewhere; provisioning is refused.",
      );
    }
    if (committed.gatewayCustomerId === null) {
      // 05.2: the committed row is a recovery reservation left by the
      // crash-recovery layer — no outcome was on file, and THIS create's outcome
      // is the missing one. Adopt the reservation: complete it with the created
      // (or 409-resolved) id as 'confirmed'. The reservation's name must agree —
      // both are the same deterministic derivation, and anything else is a
      // hand-placed row answered loudly.
      if (committed.gatewayCustomerName !== name) {
        throw new GatewayCustomerProvisionError(
          "gateway_customer_mapping_conflict",
          "A committed gateway customer reservation holds this subject under a different deterministic name, so provisioning is refused.",
        );
      }
      const [adopted] = await deps.database
        .update(gatewayCustomers)
        .set({ gatewayCustomerId: customerId, provisionState: "confirmed" })
        .where(
          and(
            eq(gatewayCustomers.id, committed.id),
            isNull(gatewayCustomers.gatewayCustomerId),
          ),
        )
        .returning();
      if (adopted) {
        log.info(
          {
            type: "gateway-customer-reservation-adopted",
            payerId: subject.id,
            mappingId: adopted.id,
          },
          "Adopted the recovery reservation for a personal user's gateway customer.",
        );
        return { customerId, provisionState: "confirmed" };
      }
      // Lost the adoption race: another caller completed the same reservation
      // against the same deterministic entity; answer the completed row.
      const [winner] = await deps.database
        .select()
        .from(gatewayCustomers)
        .where(eq(gatewayCustomers.id, committed.id))
        .limit(1);
      if (winner && winner.gatewayCustomerId === customerId) {
        return { customerId, provisionState: "confirmed" };
      }
      throw new GatewayCustomerProvisionError(
        "gateway_customer_mapping_conflict",
        "A committed gateway customer reservation for this subject was completed under a different remote entity, so provisioning is refused.",
      );
    }
    // The committed row answers a different remote entity than the create resolved:
    // the same hand-placed-row case, answered the same loud way.
    if (committed.gatewayCustomerId !== customerId) {
      throw new GatewayCustomerProvisionError(
        "gateway_customer_mapping_conflict",
        "A committed gateway customer mapping already holds this subject or its deterministic name under a different remote entity, so provisioning is refused.",
      );
    }
    return {
      customerId,
      provisionState:
        committed.provisionState === "confirmed" ? "confirmed" : "active",
    };
  };

  return {
    provisionCustomer,
    readGatewayCustomerMapping: (ref) => {
      if (ref.kind !== "personal") return Promise.resolve(null);
      return readMappingRow(deps.database, { kind: ref.kind, id: ref.id });
    },
  };
}

/**
 * The production entry 05.3's authorization path calls: zero configuration, the installed
 * controls answer (endpoint 01.1, credential 01.2, gate 01.7). Missing pieces refuse — the
 * same fail-closed discipline the zero-arg gate entry keeps.
 */
export async function provisionCustomer(
  database: Database,
  ref: PayerRef,
): Promise<GatewayCustomerProvisionResult> {
  const endpointControls = gatewayEndpointControls();
  const credentialControls = gatewayAdminCredentialControls();
  const provisioner = createGatewayCustomerProvisioner({
    database,
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
  });
  return provisioner.provisionCustomer(ref);
}
