/*
 * The realtime session identity (Bifrost 15.1, #314): the establishment door a realtime
 * WebSocket (or WebRTC) session is born under, and the durable row its attribution lives
 * in. One establishment = one identity row — and nothing else: no hold, no ledger entry,
 * no provider dispatch (会话建立本身不产生供应商计费派发). The money a session spends moves
 * per billing unit (15.2's own subject), attributed to the account THIS row froze.
 *
 * IDENTITY IS FIXED AT ESTABLISHMENT. The row copies the grant, the payer the door
 * RESOLVED server-side (the grant's own user — never the request's spelling of it), the
 * model cell, and BOTH locked versions. Nothing mid-session re-resolves any of it: a
 * concurrent revocation, a scope change or a new price version changes the NEXT session's
 * establishment, never this row — 会话期间身份与账务基准固定不变. The establishment
 * transaction reads the grant under a share lock the same way the reserve door does, so a
 * racing revocation either committed before the read (the session is refused) or waits
 * until the identity row commits.
 *
 * THE FOUR REFUSAL CLASSES (AC2) — posture, identity, reach, price — each reusing the
 * machinery the earlier doors built. Posture runs first and outside the transaction, so
 * a refusal never leaves a row behind; identity, reach and price run inside ONE
 * transaction whose commit is atomic with the identity row's insert:
 *   授权失效    `grant_invalid` / `payer_conflict` / `payer_unresolved` — the grant, its
 *               bot, its scope and the resolved payer account, checked exactly the way
 *               06.2's revalidation checks them (the same reads, the same codes).
 *   门禁未就绪  `admission_not_ready` — 01.7's readiness verdict, read through the
 *               injected seam because the gate is a process-installed service; a not-ready
 *               deployment refuses new sessions with its blocking reasons carried.
 *   模型不再开放 `model_not_open` — 03.7's own conjunction: an open scope row AND the cell
 *               still in the last-good catalog, checked inside the establishment
 *               transaction.
 *   基线不可定  `catalog_stale` / `catalog_never_synced` / `price_basis_not_found` /
 *               `price_unknown` — 03.6's freshness gate and 03.2/03.3's snapshot
 *               resolution and classification, the single sources of truth both, never a
 *               local predicate.
 *
 * THE REQUEST-SHAPE DISCIPLINE is the credit protocol's own: the payer claim is exactly
 * {kind, id}, and the account-identity and company-scope vocabularies (06.4 + 09.3) are
 * refused on presence — the payer is resolved server-side from the grant, the way every
 * door in the personal-key surface resolves it.
 *
 * RESTORE IS THE RECOVERY INPUT (AC3): `restore` reads one row back as the contract view
 * — after a disconnect or a restart, the same session id answers the same attribution,
 * because the attribution was never derived from anything that restarted.
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  accessGrants,
  botServices,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../db/schema";
import { realtimeSessions } from "../db/schema/credit-reservations";
import { assertCatalogFresh } from "../gateway/catalog-freshness";
import { assertPriceSnapshotDims } from "../gateway/price-snapshot";
import { gatewayPriceSnapshots } from "../db/schema";
import { classifyPriceDims } from "../gateway/price-status";
import { type PayerRef, payerKey } from "./payer";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
} from "./credit-reserve";
import { findCompanyScopeIdentityField } from "./personal-key-isolation";

/** The local session id's prefix — recognisable on sight, like the reservation's `cr-`. */
export const REALTIME_SESSION_ID_PREFIX = "rs-";

/** Why an establishment was refused. Closed vocabulary, displayable. */
export type RealtimeEstablishmentRefusalReasonCode =
  | "request_invalid"
  | "grant_invalid"
  | "payer_conflict"
  | "payer_unresolved"
  | "admission_not_ready"
  | "model_not_open"
  | "catalog_stale"
  | "catalog_never_synced"
  | "price_basis_not_found"
  | "price_unknown";

/** What an establishment answers: the session's identity, or the refusal that names why. */
export type RealtimeEstablishmentOutcome =
  | {
      status: "established";
      session: RealtimeSessionRecord;
    }
  | {
      status: "refused";
      reasonCode: RealtimeEstablishmentRefusalReasonCode;
      detail: Record<string, unknown>;
    };

/** The contract view the ticket's Produces names — what restore answers and tests pin. */
export type RealtimeSessionRecord = {
  sessionId: string;
  grantId: string;
  payer: { kind: string; id: string };
  model: { provider: string; model: string; capability: "realtime" };
  snapshotVersion: number;
  rateVersion: number;
  startedAt: string;
  state: "open" | "closed";
};

/** The environment the establishment door runs in. */
export type RealtimeSessionDependencies = {
  database: Database;
  /**
   * 01.7's readiness verdict (门禁未就绪), read through a seam because the gate is a
   * process-installed service: answers whether paid capabilities may be established at
   * all, and when not, the blocking reasons the verdict itself carries.
   */
  readReadiness: () => Promise<{
    ready: boolean;
    reasonCode?: string;
    blockingReasons?: string[];
  }>;
  /** 03.6's freshness window; defaults to the same default the reserve door uses. */
  catalogFreshnessWindowMs?: number;
  now?: () => Date;
};

function refused(
  reasonCode: RealtimeEstablishmentRefusalReasonCode,
  detail: Record<string, unknown>,
): RealtimeEstablishmentOutcome {
  return { status: "refused", reasonCode, detail };
}

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/**
 * Pure shape validation, the protocol doors' own discipline: closed fields, the payer
 * claim exactly {kind, id}, and the account/company-scope vocabulary refused on presence.
 */
function validateEstablishmentRequest(
  input: unknown,
): { ok: true; request: RealtimeEstablishmentInput } | { ok: false; detail: Record<string, unknown> } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, detail: { field: "body" } };
  }
  const raw = input as Record<string, unknown>;
  if (!isIdentifier(raw.grantId, 512)) {
    return { ok: false, detail: { field: "grantId" } };
  }
  const payer = raw.payer as Record<string, unknown> | null | undefined;
  if (
    payer === null ||
    typeof payer !== "object" ||
    typeof payer.kind !== "string" ||
    !isIdentifier(payer.id, 512)
  ) {
    return { ok: false, detail: { field: "payer" } };
  }
  const extraPayerKey = Object.keys(payer).find(
    (key) => key !== "kind" && key !== "id",
  );
  if (extraPayerKey !== undefined) {
    return { ok: false, detail: { field: `payer.${extraPayerKey}` } };
  }
  const forbidden = new Set(
    RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(raw)) {
    if (forbidden.has(key.toLowerCase()) || findCompanyScopeIdentityField({ [key]: true })) {
      return { ok: false, detail: { field: key } };
    }
  }
  const model = raw.model as Record<string, unknown> | null | undefined;
  if (
    model === null ||
    typeof model !== "object" ||
    !isIdentifier(model.provider, 512) ||
    !isIdentifier(model.model, 512) ||
    model.capability !== "realtime"
  ) {
    return { ok: false, detail: { field: "model" } };
  }
  if (
    !Number.isSafeInteger(raw.snapshotVersion) ||
    (raw.snapshotVersion as number) < 1 ||
    !Number.isSafeInteger(raw.rateVersion) ||
    (raw.rateVersion as number) < 0
  ) {
    return { ok: false, detail: { field: "snapshotVersion" } };
  }
  return {
    ok: true,
    request: {
      grantId: raw.grantId,
      payer: { kind: payer.kind, id: payer.id },
      model: {
        provider: model.provider,
        model: model.model,
        capability: "realtime",
      },
      snapshotVersion: raw.snapshotVersion as number,
      rateVersion: raw.rateVersion as number,
    },
  };
}

/** One establishment request's server-verified shape. */
export type RealtimeEstablishmentInput = {
  readonly grantId: string;
  /** A claim the door verifies against the grant's server-side resolution (06.4). */
  readonly payer: { kind: string; id: string };
  readonly model: {
    provider: string;
    model: string;
    capability: "realtime";
  };
  readonly snapshotVersion: number;
  readonly rateVersion: number;
};

function recordOf(row: typeof realtimeSessions.$inferSelect): RealtimeSessionRecord {
  return {
    sessionId: row.sessionId,
    grantId: row.grantId,
    payer: { kind: row.payerKind, id: row.payerId },
    model: {
      provider: row.provider,
      model: row.model,
      capability: row.capability as "realtime",
    },
    snapshotVersion: row.snapshotVersion,
    rateVersion: row.rateVersion,
    startedAt: row.startedAt.toISOString(),
    state: row.state,
  };
}

/**
 * The establishment door. Order is the contract: shape → identity (grant, bot, payer) →
 * posture (readiness) → reach (open scope, still cataloged) → price basis (fresh catalog,
 * resolvable snapshot, no unknown dimension) → one identity row. A refusal at any step
 * answers with that step's own reason code and writes nothing.
 */
export function createRealtimeSessionService(
  dependencies: RealtimeSessionDependencies,
) {
  const { database, readReadiness } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const freshnessWindowMs = dependencies.catalogFreshnessWindowMs;

  return {
    async establish(input: unknown): Promise<RealtimeEstablishmentOutcome> {
      const validated = validateEstablishmentRequest(input);
      if (!validated.ok) {
        return refused("request_invalid", validated.detail);
      }
      const request = validated.request;

      // 1. The posture question first, OUTSIDE the establishment transaction: 01.7's
      //    verdict is a process-level read through the injected seam, so it runs before
      //    the row could exist — a not-ready deployment refuses the session with the
      //    gate's own blocking reasons carried, and writes nothing at all.
      const readiness = await readReadiness();
      if (!readiness.ready) {
        return refused("admission_not_ready", {
          reasonCode: readiness.reasonCode ?? "gateway_readiness_not_ready",
          blockingReasons: readiness.blockingReasons ?? [],
        });
      }

      // 2–3. The identity half, on one transaction whose commit is atomic with the row
      //      write: the grant under a share lock (a racing revocation either precedes the
      //      read or waits for the commit), the bot active, the scope resolvable, the
      //      payer claim verified against the SERVER's resolution, and the resolved
      //      account present — the same reads and codes 06.2's revalidation uses.
      const establishment = await database.transaction(async (tx) => {
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
        if (grant.scope !== "model-access") {
          return refused("grant_invalid", {
            grantId: request.grantId,
            scope: grant.scope,
          });
        }
        const resolvedPayer: PayerRef = { kind: "personal", id: grant.userId };
        if (
          request.payer.kind !== resolvedPayer.kind ||
          request.payer.id !== resolvedPayer.id
        ) {
          return refused("payer_conflict", {
            stage: "establishment",
            requestedPayer: { kind: request.payer.kind, id: request.payer.id },
            resolvedPayer,
          });
        }
        const [account] = await tx
          .select({ externalCustomerId: payerAccounts.externalCustomerId })
          .from(payerAccounts)
          .where(
            and(
              eq(payerAccounts.kind, resolvedPayer.kind),
              eq(payerAccounts.payerId, resolvedPayer.id),
            ),
          )
          .limit(1);
        if (
          !account ||
          account.externalCustomerId !== payerKey(resolvedPayer)
        ) {
          return refused("payer_unresolved", {
            payerKind: resolvedPayer.kind,
          });
        }

        // 4. The reach (03.7's own conjunction) — an open scope row AND the cell still in
        //    the last-good catalog. A delisted model is not open, whatever its scope row
        //    says.
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

        // 5. The price basis: 03.6's freshness gate (the single source of truth, read
        //    inside this transaction the way the reserve door reads it) and 03.2/03.3's
        //    snapshot resolution and classification — `free` is a price, `unknown` never
        //    is, and a session cannot be born on a basis the door cannot name.
        const freshness = await assertCatalogFresh(tx, {
          modelRef: {
            provider: request.model.provider,
            model: request.model.model,
            capability: request.model.capability,
          },
          now: now(),
          ...(freshnessWindowMs === undefined ? {} : { windowMs: freshnessWindowMs }),
        });
        if (!freshness.fresh) {
          return refused(
            freshness.reasonCode === "catalog_never_synced"
              ? "catalog_never_synced"
              : "catalog_stale",
            freshness.detail,
          );
        }
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
          `The realtime session basis ${request.model.provider}/${request.model.model}@${request.snapshotVersion}`,
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

        // 6. The identity row — and nothing else. No hold, no ledger, no dispatch: the
        //    establishment's own AC. The row's payer is the SERVER's resolution.
        const sessionId = `${REALTIME_SESSION_ID_PREFIX}${randomBytes(16).toString("hex")}`;
        const [row] = await tx
          .insert(realtimeSessions)
          .values({
            sessionId,
            grantId: request.grantId,
            payerKind: resolvedPayer.kind,
            payerId: resolvedPayer.id,
            provider: request.model.provider,
            model: request.model.model,
            capability: request.model.capability,
            snapshotVersion: request.snapshotVersion,
            rateVersion: request.rateVersion,
            state: "open",
          })
          .returning();
        return { status: "established" as const, session: recordOf(row) };
      });
      return establishment;
    },

    /** The recovery input (AC3): one session's frozen identity, or undefined. */
    async restore(sessionId: string): Promise<RealtimeSessionRecord | undefined> {
      const [row] = await database
        .select()
        .from(realtimeSessions)
        .where(eq(realtimeSessions.sessionId, sessionId))
        .limit(1);
      return row === undefined ? undefined : recordOf(row);
    },
  };
}

export type RealtimeSessionService = ReturnType<
  typeof createRealtimeSessionService
>;
