import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../db/schema";
import { gatewayPriceSnapshots } from "../db/schema";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../gateway/catalog-sync";
import { MODEL_CAPABILITIES, type ModelRef } from "../gateway/catalog";
import {
  assertPriceSnapshotDims,
} from "../gateway/price-snapshot";
import { classifyPriceDims } from "../gateway/price-status";
import type { Tx } from "./capacity";
import type { CreditServiceVariables } from "./credit-service-auth";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import { CREDIT_SCALE } from "./credits";
import { payerKey, type PayerKind, type PayerRef } from "./payer";

/**
 * The Reserve protocol's transactional revalidation (Bifrost #253, 06.2).
 *
 * ONE TRANSACTION, SIX VERDICTS, ONE WRITE. Before any capacity is held, the same database
 * transaction that would write the hold re-proves every basis admission named in the request
 * contract: the model access grant is still active (and its Bot still registered and active),
 * the payer resolves to a real account, the ref is still cataloged and still administrator-
 * opened, the catalog itself is still fresh, the locked price basis exists and classifies as
 * priced, and the request carries enforceable bound evidence. Any `no` is a refusal with a
 * fixed reason code and ZERO writes — not a partial hold, not a customer floor, nothing.
 * Only after every verdict may the reservation write land, and it lands INSIDE this same
 * transaction, so a revocation (or a scope close, or a sync) either commits before the
 * revalidation reads it or waits until after the reservation is committed — there is no
 * window in which a dead authorization pays for a live hold.
 *
 * HOW THE WRITE SHARES THE TRANSACTION. The credit writer (credits-writer.ts) is the only
 * writer `credit_reservations` has ever had, and it opens its own transaction when called
 * with the pool. Calling it that way from here would put the write on a DIFFERENT
 * connection — exactly the split this module exists to forbid — so the writer is instead
 * constructed OVER the caller's transaction handle. Drizzle issues a SAVEPOINT for a
 * transaction object's own `.transaction()`, so every statement the writer runs — the
 * customer lock, the idempotency read, the grant allocation — lands on this connection,
 * inside this transaction, and becomes visible only when THIS transaction commits. The
 * writer stays the one implementation of the reservation write; nothing about its behavior
 * changes for its existing callers.
 *
 * WHAT A REFUSAL SAYS. One closed reason-code set, displayable on any surface: the five
 * ticket categories (grant_invalid, model_not_open, price_unknown / price_basis_not_found,
 * catalog_stale / catalog_never_synced, bound_evidence_not_enforceable) plus the shapes a
 * protocol request can honestly fail in (request_invalid, payer_unresolved,
 * insufficient_credits, reservation_conflict). A refusal never names another customer's
 * data: the detail carries only the refused request's own basis (which dimensions are
 * unpriced, how stale the catalog is, how much was available).
 *
 * WHAT IS NOT EVIDENCE. The conservative token estimate (ADR 0001, input-bound.ts) is a
 * rejection aid, never an enforceable ceiling: the bound-evidence kinds below are a closed
 * set of MECHANISMS (a provider-enforced output cap, a self-enforced input truncation
 * ceiling), and anything outside the set — estimate-shaped rows included — refuses as
 * `bound_evidence_not_enforceable`. This module does not import the estimator at all, so
 * an estimate cannot creep in by accident.
 *
 * WHO CALLS THIS. The deployment's Bifrost admission extension, authenticated by 06.1's
 * service identity; {@link creditProtocolEndpoints} mounts `POST /reserve` inside that
 * guard. `rateVersion` is validated and carried in the request contract; persisting the
 * locked versions for settlement is 06.5's version locking.
 */

/** The closed refusal vocabulary. A new member is a contract change, never a free string. */
export const RESERVE_REFUSAL_REASONS = [
  "request_invalid",
  "grant_invalid",
  "payer_unresolved",
  "model_not_open",
  "catalog_never_synced",
  "catalog_stale",
  "price_basis_not_found",
  "price_unknown",
  "bound_evidence_not_enforceable",
  "insufficient_credits",
  "reservation_conflict",
] as const;

export type CreditReserveRefusalReasonCode =
  (typeof RESERVE_REFUSAL_REASONS)[number];

/**
 * The enforceable bound-evidence kinds (ADR 0003: only a call whose cost ceiling can be
 * ENFORCED may be admitted). The conservative estimate is deliberately absent: it can
 * reject a request, never prove one's ceiling.
 */
export const RESERVE_BOUND_EVIDENCE_KINDS = [
  /** The output side is capped by `max_tokens` the provider enforces. */
  "provider_max_tokens",
  /** The input side is truncated to a ceiling before sending (self-enforced bound). */
  "self_enforced_input_truncation",
] as const;

export type ReserveBoundEvidenceKind =
  (typeof RESERVE_BOUND_EVIDENCE_KINDS)[number];

/** One mechanism-level proof that a cost side is capped. */
export type ReserveBoundEvidence = {
  kind: ReserveBoundEvidenceKind;
  /** The ceiling the mechanism enforces, in tokens — a positive whole number. */
  maximumTokens: number;
};

/** The Reserve request contract (the ticket's Produces list, as the wire carries it). */
export type CreditReserveRequest = {
  /** The model access grant this call runs under — re-proved live, never trusted. */
  grantId: string;
  /** The payment account the hold is billed to, resolved through the payer mapping. */
  payer: PayerRef;
  /** The model cell being admitted: catalog identity triple. */
  model: ModelRef;
  /** The price basis version the request locks; it must still resolve. */
  snapshotVersion: number;
  /** The conversion-rate version the request locks (validated here; persisted by 06.5). */
  rateVersion: number;
  /** Non-empty set of enforceable-ceiling proofs; estimates are not a member. */
  boundEvidence: ReserveBoundEvidence[];
  /** The hold ceiling in scaled credit units (×100), a positive 32-bit integer. */
  maximumCredits: number;
  /** The caller's retry identity; a replay answers the original reservation. */
  idempotencyKey: string;
  /** When recovery may release an unanswered hold; default 15 minutes out. */
  expiresAt?: string | Date;
};

/** What a reserve answers: a held reservation, or a refusal that names its reason. */
export type CreditReserveOutcome =
  | {
      status: "reserved";
      /** Trusted-generated attempt identity — minted here, never accepted from a caller. */
      attemptId: string;
      reservationId: string;
      maximumCredits: number;
      snapshotVersion: number;
      rateVersion: number;
    }
    | {
      status: "refused";
      reasonCode: CreditReserveRefusalReasonCode;
      /** The refused request's own basis — never another subject's data. */
      detail: Record<string, unknown>;
    };

/** The environment a transactional reserve runs in. */
export type CreditReserveEnvironment = {
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
  /**
   * How long since the last fully successful sync a new admission may still trust the
   * catalog. Default 15 minutes (the parent spec's freshness cap). 03.6's dedicated
   * freshness gate was not in this worktree's baseline; this module reads the delivered
   * 03.4 sync state directly and its window here is the seam that gate plugs into.
   */
  catalogFreshnessWindowMs?: number;
};

export type CreditReserveServiceDependencies = CreditReserveEnvironment & {
  database: Database;
};

export type CreditReserveService = {
  /** Validate and reserve; every refusal leaves the database exactly as it was. */
  reserve(request: unknown): Promise<CreditReserveOutcome>;
};

/** Largest value a 32-bit PostgreSQL integer column can hold (the hold ceiling's bound). */
const MAX_STORED_UNITS = 2_147_483_647;

/** The default hold TTL: recovery may release an unanswered hold after this long. */
const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1000;

/** The parent spec's default catalog freshness cap. */
export const DEFAULT_CATALOG_FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

/** The one displayable sentence per refusal code — the same words on every surface. */
const REFUSAL_SENTENCES: Record<CreditReserveRefusalReasonCode, string> = {
  request_invalid: "The reserve request is not a valid reserve request.",
  grant_invalid: "The model access grant cannot be used for this call.",
  payer_unresolved: "The payment account named by the request does not resolve.",
  model_not_open: "The model is not open for new requests.",
  catalog_never_synced:
    "The model catalog has never synced, so no new request can be priced.",
  catalog_stale:
    "The model catalog is stale; new requests are paused until the next successful sync.",
  price_basis_not_found:
    "The locked price basis does not exist for this model.",
  price_unknown: "The model's price is not completely known, so it cannot be billed strictly.",
  bound_evidence_not_enforceable:
    "The request carries no enforceable cost-ceiling evidence; estimates are not evidence.",
  insufficient_credits: "The payment account does not have enough available credits.",
  reservation_conflict:
    "The reservation identity conflicts with an existing reservation.",
};

function refused(
  reasonCode: CreditReserveRefusalReasonCode,
  detail: Record<string, unknown> = {},
): CreditReserveOutcome {
  return { status: "refused", reasonCode, detail };
}

/** An `att-` attempt id: 8 random bytes as hex, the draw size the other billing ids use. */
function generateAttemptId(): string {
  return `att-${randomBytes(8).toString("hex")}`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

const PAYER_KINDS: readonly PayerKind[] = [
  "personal",
  "company",
  "legacy_deployment",
  "unknown_owner",
];

/** Identifier-shaped string: non-empty, bounded, no leading or trailing whitespace. */
function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    isNonEmptyString(value, maxLength) &&
    value.trim() === value
  );
}

/** Validation's discriminated answer: a valid request, or the refusal that replaces it. */
type RequestValidation =
  | { ok: true; request: CreditReserveRequest }
  | { ok: false; outcome: CreditReserveOutcome };

/**
 * Pure shape validation — run BEFORE any database contact, so a malformed request is a
 * refusal with zero reads as well as zero writes. The bound-evidence check lives here too:
 * evidence is a property of the request bytes, not of the database.
 */
function validateRequest(input: unknown, now: Date): RequestValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, outcome: refused("request_invalid", { field: "body" }) };
  }
  const raw = input as Record<string, unknown>;

  if (!isIdentifier(raw.grantId, 512)) {
    return { ok: false, outcome: refused("request_invalid", { field: "grantId" }) };
  }
  const payer = raw.payer as Record<string, unknown> | null | undefined;
  if (
    payer === null ||
    typeof payer !== "object" ||
    !PAYER_KINDS.includes(payer.kind as PayerKind) ||
    !isIdentifier(payer.id, 512)
  ) {
    return { ok: false, outcome: refused("request_invalid", { field: "payer" }) };
  }
  const model = raw.model as Record<string, unknown> | null | undefined;
  if (
    model === null ||
    typeof model !== "object" ||
    !isIdentifier(model.provider, 512) ||
    !isIdentifier(model.model, 512) ||
    !MODEL_CAPABILITIES.includes(model.capability as never)
  ) {
    return { ok: false, outcome: refused("request_invalid", { field: "model" }) };
  }
  if (!isPositiveInteger(raw.snapshotVersion)) {
    return { ok: false, outcome: refused("request_invalid", { field: "snapshotVersion" }) };
  }
  if (!isNonNegativeInteger(raw.rateVersion)) {
    return { ok: false, outcome: refused("request_invalid", { field: "rateVersion" }) };
  }
  if (!isPositiveInteger(raw.maximumCredits) || raw.maximumCredits > MAX_STORED_UNITS) {
    return { ok: false, outcome: refused("request_invalid", { field: "maximumCredits" }) };
  }
  if (!isIdentifier(raw.idempotencyKey, 512)) {
    return { ok: false, outcome: refused("request_invalid", { field: "idempotencyKey" }) };
  }

  // Bound evidence: a non-empty set of mechanism proofs with real ceilings. Anything
  // else — including an estimate-shaped entry — proves nothing enforceable.
  const evidence = raw.boundEvidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      ok: false,
      outcome: refused("bound_evidence_not_enforceable", { field: "boundEvidence" }),
    };
  }
  for (const entry of evidence) {
    const candidate = entry as Record<string, unknown> | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !RESERVE_BOUND_EVIDENCE_KINDS.includes(
        candidate.kind as ReserveBoundEvidenceKind,
      ) ||
      !isPositiveInteger(candidate.maximumTokens)
    ) {
      return {
        ok: false,
        outcome: refused("bound_evidence_not_enforceable", {
          field: "boundEvidence",
        }),
      };
    }
  }

  let expiresAt: Date;
  if (raw.expiresAt === undefined) {
    expiresAt = new Date(now.getTime() + DEFAULT_HOLD_TTL_MS);
  } else {
    const parsed =
      raw.expiresAt instanceof Date
        ? raw.expiresAt
        : typeof raw.expiresAt === "string"
          ? new Date(raw.expiresAt)
          : null;
    if (parsed === null || Number.isNaN(parsed.getTime())) {
      return { ok: false, outcome: refused("request_invalid", { field: "expiresAt" }) };
    }
    expiresAt = parsed;
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, outcome: refused("request_invalid", { field: "expiresAt" }) };
  }

  return {
    ok: true,
    request: {
      grantId: raw.grantId,
      payer: { kind: payer.kind as PayerKind, id: payer.id },
      model: {
        provider: model.provider,
        model: model.model,
        capability: model.capability as ModelRef["capability"],
      },
      snapshotVersion: raw.snapshotVersion,
      rateVersion: raw.rateVersion,
      boundEvidence: evidence as ReserveBoundEvidence[],
      maximumCredits: raw.maximumCredits,
      idempotencyKey: raw.idempotencyKey,
      expiresAt,
    },
  };
}

/**
 * The transactional core: every revalidation read and the reservation write on ONE
 * transaction. Exported for the concurrency injections this ticket's tests run and for
 * downstream tickets that compose the same atomic unit — callers own the transaction's
 * commit, which is exactly what makes a concurrent revocation wait for it.
 */
export async function reserveCreditInTransaction(
  tx: Tx,
  request: CreditReserveRequest,
  environment: CreditReserveEnvironment = {},
): Promise<CreditReserveOutcome> {
  const now = environment.now?.() ?? new Date();
  const freshnessWindowMs =
    environment.catalogFreshnessWindowMs ?? DEFAULT_CATALOG_FRESHNESS_WINDOW_MS;

  // 1. The authorization, under a share lock: a concurrent revocation either committed
  //    before this read (we see `revoked` and refuse) or blocks until this transaction
  //    commits (the hold is already atomic with the revalidation). There is no third path.
  const [grant] = await tx
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, request.grantId))
    .for("share");
  if (grant?.status !== "active") {
    return refused("grant_invalid", { grantId: request.grantId });
  }
  const [bot] = await tx
    .select({ status: botServices.status })
    .from(botServices)
    .where(eq(botServices.botId, grant.botId))
    .limit(1);
  if (bot?.status !== "active") {
    return refused("grant_invalid", { grantId: request.grantId });
  }

  // 2. The payer: the request's ref must resolve through the payer-account mapping to
  //    exactly the key its own kind and id derive — no shape-shifting accounts. (The
  //    grant-versus-request payer comparison is 06.4's conflict semantics.)
  if (request.payer.kind === "unknown_owner") {
    return refused("payer_unresolved", { payerKind: request.payer.kind });
  }
  const derivedKey = payerKey(request.payer);
  const [account] = await tx
    .select({
      externalCustomerId: payerAccounts.externalCustomerId,
    })
    .from(payerAccounts)
    .where(
      and(
        eq(payerAccounts.kind, request.payer.kind),
        eq(payerAccounts.payerId, request.payer.id),
      ),
    )
    .limit(1);
  if (!account || account.externalCustomerId !== derivedKey) {
    return refused("payer_unresolved", { payerKind: request.payer.kind });
  }

  // 3. The open scope: an administrator left this exact cell open, AND the cell is still
  //    in the last-good catalog (03.7's own conjunction; a delisted model is not open).
  const [scope] = await tx
    .select({ state: gatewayModelOpenScopes.state })
    .from(gatewayModelOpenScopes)
    .where(
      and(
        eq(gatewayModelOpenScopes.provider, request.model.provider),
        eq(gatewayModelOpenScopes.model, request.model.model),
        eq(gatewayModelOpenScopes.capability, request.model.capability),
      ),
    )
    .limit(1);
  if (scope?.state !== "open") {
    return refused("model_not_open", {
      provider: request.model.provider,
      model: request.model.model,
      capability: request.model.capability,
    });
  }
  const [cataloged] = await tx
    .select({ provider: gatewayModelCatalogRefs.provider })
    .from(gatewayModelCatalogRefs)
    .where(
      and(
        eq(gatewayModelCatalogRefs.provider, request.model.provider),
        eq(gatewayModelCatalogRefs.model, request.model.model),
        eq(gatewayModelCatalogRefs.capability, request.model.capability),
      ),
    )
    .limit(1);
  if (!cataloged) {
    return refused("model_not_open", {
      provider: request.model.provider,
      model: request.model.model,
      capability: request.model.capability,
    });
  }

  // 4. The catalog's freshness: the last FULLY successful sync must be inside the window.
  //    The reason codes say freshness, never model-not-found — the model may be perfectly
  //    open and priced; what expired is the evidence both stand on.
  const [syncState] = await tx
    .select({
      lastSuccessfulSyncAt: gatewayCatalogSyncState.lastSuccessfulSyncAt,
    })
    .from(gatewayCatalogSyncState)
    .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID))
    .limit(1);
  const lastSuccessfulSyncAt = syncState?.lastSuccessfulSyncAt ?? null;
  if (lastSuccessfulSyncAt === null) {
    return refused("catalog_never_synced", {
      freshnessWindowMs,
    });
  }
  const ageMs = now.getTime() - lastSuccessfulSyncAt.getTime();
  if (ageMs > freshnessWindowMs) {
    return refused("catalog_stale", {
      lastSuccessfulSyncAt: lastSuccessfulSyncAt.toISOString(),
      ageMs,
      freshnessWindowMs,
    });
  }

  // 5. The locked price basis: the exact version the request names must still resolve,
  //    and its dims — re-validated through 03.2's own checker, re-classified through
  //    03.3's own classifier, never a copied semantic — must be completely priced.
  //    `free` is a price; `unknown` never is.
  const [snapshot] = await tx
    .select({ dims: gatewayPriceSnapshots.dims })
    .from(gatewayPriceSnapshots)
    .where(
      and(
        eq(gatewayPriceSnapshots.provider, request.model.provider),
        eq(gatewayPriceSnapshots.model, request.model.model),
        eq(gatewayPriceSnapshots.capability, request.model.capability),
        eq(
          gatewayPriceSnapshots.snapshotVersion,
          request.snapshotVersion,
        ),
      ),
    )
    .limit(1);
  if (snapshot === undefined) {
    return refused("price_basis_not_found", {
      snapshotVersion: request.snapshotVersion,
    });
  }
  const dims = assertPriceSnapshotDims(
    snapshot.dims,
    `The reserved price basis ${request.model.provider}/${request.model.model}@${request.snapshotVersion}`,
  );
  const classification = classifyPriceDims(dims);
  if (classification.status === "unknown") {
    return refused("price_unknown", {
      priceStatus: "unknown",
      priceReasonCode: classification.reasonCode,
      missingDimensions: classification.missingDimensions,
      snapshotVersion: request.snapshotVersion,
    });
  }

  // 6. Every verdict said yes: the reservation write rides THIS transaction. The writer
  //    is the reservation table's only writer; constructed over the transaction handle,
  //    its statements run on this connection under this transaction's SAVEPOINT, and the
  //    caller's commit is what makes revalidation + hold visible as one fact.
  const holdExpiresAt =
    request.expiresAt instanceof Date
      ? request.expiresAt
      : typeof request.expiresAt === "string"
        ? new Date(request.expiresAt)
        : new Date(now.getTime() + DEFAULT_HOLD_TTL_MS);
  const writer = createCreditWriter(tx as unknown as Database);
  let reserved: { reserved: true; reservationId: string } | {
    reserved: false;
    availableCents: number;
  };
  try {
    reserved = await writer.reserveCredits({
      externalCustomerId: derivedKey,
      idempotencyKey: request.idempotencyKey,
      maximumCents: request.maximumCredits,
      expiresAt: holdExpiresAt,
    });
  } catch (error) {
    if (error instanceof CreditReservationConflictError) {
      return refused("reservation_conflict", { reason: error.message });
    }
    throw error;
  }
  if (!reserved.reserved) {
    return refused("insufficient_credits", {
      availableCredits: reserved.availableCents / CREDIT_SCALE,
      maximumCredits: request.maximumCredits,
    });
  }
  return {
    status: "reserved",
    attemptId: generateAttemptId(),
    reservationId: reserved.reservationId,
    maximumCredits: request.maximumCredits,
    snapshotVersion: request.snapshotVersion,
    rateVersion: request.rateVersion,
  };
}

/**
 * The Reserve service: pure request validation, then one transaction for the five
 * revalidations and the write. A refusal — validation's or the transaction's — never
 * reaches a write.
 */
export function createCreditReserveService(
  dependencies: CreditReserveServiceDependencies,
): CreditReserveService {
  const environment: CreditReserveEnvironment = {
    now: dependencies.now,
    catalogFreshnessWindowMs: dependencies.catalogFreshnessWindowMs,
  };
  return {
    async reserve(request: unknown): Promise<CreditReserveOutcome> {
      const now = dependencies.now?.() ?? new Date();
      const validated = validateRequest(request, now);
      if (!validated.ok) return validated.outcome;
      return dependencies.database.transaction((tx) =>
        reserveCreditInTransaction(tx, validated.request, environment),
      );
    },
  };
}

/** The endpoints the 06.1 guard mounts: today exactly one — `POST /reserve`. */
export type CreditProtocolEndpointDependencies = {
  service: CreditReserveService;
};

/**
 * The Reserve surface, mounted inside `creditProtocolRoutes`'s `endpoints` slot so no
 * path here exists without the deployment's billing identity (06.1). A refused reserve
 * is one 422 with its reason code; a held one is a 201 carrying the trusted attempt id.
 * A defect (a tampered price row, a writer bug) is deliberately NOT mapped: it throws
 * and answers 500, because pricing a defect would be the one wrong answer.
 */
export function creditProtocolEndpoints(
  dependencies: CreditProtocolEndpointDependencies,
): Hono<{ Variables: CreditServiceVariables }> {
  const app = new Hono<{ Variables: CreditServiceVariables }>();
  app.post("/reserve", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: REFUSAL_SENTENCES.request_invalid,
          code: "request_invalid",
          detail: { field: "body" },
        },
        422,
      );
    }
    const outcome = await dependencies.service.reserve(body);
    if (outcome.status === "reserved") {
      return context.json(
        {
          attemptId: outcome.attemptId,
          reservationId: outcome.reservationId,
          maximumCredits: outcome.maximumCredits,
          snapshotVersion: outcome.snapshotVersion,
          rateVersion: outcome.rateVersion,
        },
        201,
      );
    }
    return context.json(
      {
        error: REFUSAL_SENTENCES[outcome.reasonCode],
        code: outcome.reasonCode,
        detail: outcome.detail,
      },
      422,
    );
  });
  return app;
}
