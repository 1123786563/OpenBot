import type { Database } from "../db/client";
import type { AuditStore } from "../audit";
import { DEPLOYMENT_INITIATOR, recordAuditEvent } from "../audit";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  type CreditReserveOutcome,
  type CreditReserveRequest,
} from "./credit-reserve";
import {
  computeReservationCeiling,
  type ReservationBoundQuantities,
} from "./reserve-bound";
import { findCompanyScopeIdentityField } from "./personal-key-isolation";
import {
  TOOL_SURCHARGE_ENTRIES,
  assessToolSurchargeEnablement,
  type ToolSurchargeEntryIdForIdentity,
} from "./tool-surcharge-pricing";
import {
  attemptIdForReservation,
} from "./reservation-status";
import {
  listToolCallChargesByGrant,
  recordToolCallCharge,
} from "./tool-call-charge";
import type { PriceDimension } from "../gateway/price-snapshot";
import { PRICE_DIMENSIONS } from "../gateway/price-snapshot";

/*
 * The tool admission door (Bifrost 20.4, #344): the entry EVERY tool call lands on —
 * isolation before pricing, pricing before any hold, hold before any dispatch — so an
 * unpriced tool cannot be executed at zero cost (未定价工具不得旁路计费) and a personal
 * model key cannot reach a company tool (模型 Key 不授予公司工具权限).
 *
 * THREE STAGES, EACH ABLE TO REFUSE ALONE.
 *
 *   1. ISOLATION (the 09.3 lane). This door's caller surface is the personal-key face:
 *      a company-scope selector PRESENT anywhere in the request is the elevation attempt
 *      itself (presence is the attempt, whatever the value spells — the same boundary the
 *      credit protocol doors keep), and a tool the deployment marks company-scoped is
 *      refused for a personal model-access grant before any price is read. Both refusals
 *      audit as `billing.tool_overreach_refused`: the overreach is the fact the trail
 *      keeps, and it never names another tenant's data.
 *
 *   2. ENABLEMENT (20.1's verdict, wired in FIRST). The locked basis must price EVERY
 *      surcharge dimension the entrance bills: one unknown refuses the call naming the
 *      dimension and its reason — unknown is never a zero cost, so an unpriced tool is
 *      NOT enabled, not executed at zero (Q20). The refusal audits as
 *      `billing.tool_bypass_refused`, and the proof is structural: the reserve door is
 *      never called, the dispatch never runs, no hold forms — a hold is the dispatch
 *      commitment, so "tool execution count 0" starts from an account that provably never
 *      committed to the call.
 *
 *   3. THE HOLD (the 06.x lane). A priced call certifies its ceiling through 06.5's own
 *      conversion — the call count IS the payload, one unit of the entrance's dimension,
 *      self-enforced by refusal exactly like the async submit's entry count — and sends
 *      ONE reserve request under the tool call's own idempotency key. The door's refusals
 *      (insufficient credits above all) pass through untouched and audit the same bypass
 *      event: nothing dispatched, nothing held. A basis priced exactly zero dispatches
 *      hold-free — free is a price, and a hold of zero is not a hold.
 *
 * EVERY REAL CALL GETS ITS IDENTITY. Whatever the outcome, one tool_call_charges row
 * lands (20.1's writer): charged with its hold's attempt id, charged-free, or refused
 * with the door's own code. The identity, the ledger and the audit trail say the same
 * thing about the same call, and a replay converges on the row its hold already minted.
 *
 * WHO CALLS THIS. The deployment's tool entrypoints — the MCP transport's execution seam,
 * the injected-tool executor, the Responses tools pass, the A2A pass — one door for every
 * entrance the registry (20.1) enumerates, which is what makes "no entrance bypasses
 * admission" a property of the wiring, not of each caller's diligence. The reserve
 * caller, the dispatch, the basis resolver, the audit store and the company-tool policy
 * are injected seams, so tests prove provider/tool call counts without touching the
 * money paths' own homes.
 */

/** Why the door refused, in the door's own closed stages. Displayable on any surface. */
export type ToolAdmissionRefusal =
  | {
      status: "refused";
      /** The request's own shape was outside the closed vocabulary. */
      stage: "shape";
      reasonCode: "request_invalid";
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** Stage 1: the caller tried to reach company scope, or named a company tool. */
      stage: "isolation";
      reasonCode: "company_scope_refused" | "tool_scope_denied";
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** Stage 2: the locked basis leaves a billed surcharge dimension unknown. */
      stage: "enablement";
      reasonCode: "tool_price_unknown";
      detail: {
        dimensions: readonly { dimension: PriceDimension; reason: string }[];
      };
    }
  | {
      status: "refused";
      /** Stage 3: the ceiling could not certify, or the reserve door refused. */
      stage: "reserve";
      reasonCode:
        | "price_basis_not_found"
        | "ceiling_not_certifiable"
        | string;
      detail: Record<string, unknown>;
    };

/** The admitted answer: the identity row plus what the caller's dispatch stands on. */
export type ToolAdmission =
  | {
      status: "admitted";
      /** True when the basis priced the call exactly zero — dispatched hold-free. */
      free: boolean;
      chargeId: string;
      /** The hold the call stands on; null exactly when free. */
      reservationId: string | null;
      /** The hold's 07.x attempt id; null exactly when free. */
      attemptId: string | null;
    };

export type ToolAdmissionOutcome = ToolAdmission | ToolAdmissionRefusal;

/** The seams the door composes — production wires 06.2, the dispatch client and the audit store. */
export type ToolAdmissionDependencies = {
  database: Database;
  /** The reserve door: 06.2's CreditReserveService in production. */
  reserve: (request: CreditReserveRequest) => Promise<CreditReserveOutcome>;
  /**
   * The company-tool policy: whether a tool pattern lives behind server-issued trusted
   * (company) scopes. Injected because the policy is the deployment's own registry — the
   * door's job is to enforce it, not to own it. Default: no tool is company-scoped.
   */
  isCompanyTool?: (tool: string) => boolean;
  /** The tool dispatch: called at most once, only after the hold exists (or the basis is free). */
  dispatch: (input: { entry: string; tool: string; free: boolean }) => Promise<unknown>;
  /** The locked basis's dims and rate — resolved by the caller from the same versions. */
  resolveBasis: (model: {
    provider: string;
    model: string;
    capability: string;
    snapshotVersion: number;
    rateVersion: number;
  }) => Promise<
    | {
        ok: true;
        dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
        rate: Parameters<typeof computeReservationCeiling>[0]["rate"];
      }
    | { ok: false; reason: "price_basis_not_found"; detail?: Record<string, unknown> }
  >;
  /** The audit store every refusal is written to. */
  audit?: AuditStore;
};

const IDENTITY_ENTRY_IDS = new Set<string>(
  TOOL_SURCHARGE_ENTRIES.filter((entry) => entry.billsIdentity).map(
    (entry) => entry.id,
  ),
);

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/** The request's closed shape: the entrance, the tool, the grant, the cell and its versions. */
type ToolAdmissionRequest = {
  toolCallIdempotencyKey: string;
  entry: ToolSurchargeEntryIdForIdentity;
  tool: string;
  grantId: string;
  payer: { kind: string; id: string };
  model: { provider: string; model: string; capability: string };
  snapshotVersion: number;
  rateVersion: number;
};

function validateAdmissionRequest(
  input: unknown,
): { ok: true; request: ToolAdmissionRequest } | { ok: false; detail: Record<string, unknown> } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, detail: { field: "body" } };
  }
  const raw = input as Record<string, unknown>;
  if (!isIdentifier(raw.toolCallIdempotencyKey, 512)) {
    return { ok: false, detail: { field: "toolCallIdempotencyKey" } };
  }
  if (
    typeof raw.entry !== "string" ||
    !IDENTITY_ENTRY_IDS.has(raw.entry)
  ) {
    return { ok: false, detail: { field: "entry" } };
  }
  if (!isIdentifier(raw.tool, 512)) {
    return { ok: false, detail: { field: "tool" } };
  }
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
  const model = raw.model as Record<string, unknown> | null | undefined;
  if (
    model === null ||
    typeof model !== "object" ||
    !isIdentifier(model.provider, 512) ||
    !isIdentifier(model.model, 512) ||
    !isIdentifier(model.capability, 64)
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
      toolCallIdempotencyKey: raw.toolCallIdempotencyKey,
      entry: raw.entry as ToolSurchargeEntryIdForIdentity,
      tool: raw.tool,
      grantId: raw.grantId,
      payer: { kind: payer.kind, id: payer.id },
      model: {
        provider: model.provider,
        model: model.model,
        capability: model.capability,
      },
      snapshotVersion: raw.snapshotVersion as number,
      rateVersion: raw.rateVersion as number,
    },
  };
}

/** One closed-vocabulary audit write; a broken trail must never mask the refusal itself. */
async function auditRefusal(
  deps: ToolAdmissionDependencies,
  event: "billing.tool_bypass_refused" | "billing.tool_overreach_refused",
  request: ToolAdmissionRequest,
  reasonCode: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (deps.audit === undefined) return;
  try {
    await recordAuditEvent(deps.audit, {
      eventType: event,
      targetType: "tool_admission",
      targetId: request.grantId,
      initiator: DEPLOYMENT_INITIATOR,
      payload: {
        entry: request.entry,
        tool: request.tool,
        grantId: request.grantId,
        reasonCode,
        ...detail,
      },
    });
  } catch {
    // The refusal stands on its own refusal record; a failed audit write is surfaced by
    // the audit layer's own failures, not by un-refusing the call.
  }
}

/** The door itself: shape → isolation → enablement → hold → dispatch, each stage refusing alone. */
export function createToolAdmissionService(
  dependencies: ToolAdmissionDependencies,
) {
  const { database, reserve, dispatch, resolveBasis } = dependencies;
  const isCompanyTool = dependencies.isCompanyTool ?? (() => false);

  return {
    async admit(input: unknown): Promise<ToolAdmissionOutcome> {
      // ---- Stage 0: the closed shape, and the two presence-refused vocabularies. The
      // account-identity and company-scope fields are refused ON PRESENCE, top level or
      // inside payer, exactly as the credit protocol doors refuse them: a personal-key
      // tool call has no business naming an account or a company scope at all.
      const validated = validateAdmissionRequest(input);
      if (!validated.ok) {
        return {
          status: "refused",
          stage: "shape",
          reasonCode: "request_invalid",
          detail: validated.detail,
        };
      }
      const request = validated.request;
      const forbidden = new Set(
        RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
      );
      for (const key of Object.keys(input as Record<string, unknown>)) {
        if (forbidden.has(key.toLowerCase()) || findCompanyScopeIdentityField({ [key]: true })) {
          const refusal: ToolAdmissionRefusal = {
            status: "refused",
            stage: "isolation",
            reasonCode: "company_scope_refused",
            detail: { field: key },
          };
          await recordToolCallCharge(database, {
            idempotencyKey: request.toolCallIdempotencyKey,
            entry: request.entry,
            tool: request.tool,
            dimension: dimensionOf(request.entry),
            grantId: request.grantId,
            outcome: { kind: "refused", reason: refusal.reasonCode },
          });
          await auditRefusal(
            dependencies,
            "billing.tool_overreach_refused",
            request,
            refusal.reasonCode,
            { field: key },
          );
          return refusal;
        }
      }

      // ---- Stage 1: the company-tool policy. A tool behind server-issued trusted
      // (company) scopes is structurally unreachable for a personal model-access grant —
      // this door is where that structure answers, before any price is read.
      if (isCompanyTool(request.tool)) {
        const refusal: ToolAdmissionRefusal = {
          status: "refused",
          stage: "isolation",
          reasonCode: "tool_scope_denied",
          detail: { tool: request.tool },
        };
        await recordToolCallCharge(database, {
          idempotencyKey: request.toolCallIdempotencyKey,
          entry: request.entry,
          tool: request.tool,
          dimension: dimensionOf(request.entry),
          grantId: request.grantId,
          outcome: { kind: "refused", reason: refusal.reasonCode },
        });
        await auditRefusal(
          dependencies,
          "billing.tool_overreach_refused",
          request,
          refusal.reasonCode,
          { tool: request.tool },
        );
        return refusal;
      }

      // ---- Stage 2: the enablement verdict over the LOCKED basis. An unpriced
      // dimension refuses before any hold — unknown is never a zero cost (Q20).
      const basis = await resolveBasis({
        ...request.model,
        snapshotVersion: request.snapshotVersion,
        rateVersion: request.rateVersion,
      });
      if (!basis.ok) {
        const refusal: ToolAdmissionRefusal = {
          status: "refused",
          stage: "reserve",
          reasonCode: "price_basis_not_found",
          detail: basis.detail ?? {},
        };
        await recordToolCallCharge(database, {
          idempotencyKey: request.toolCallIdempotencyKey,
          entry: request.entry,
          tool: request.tool,
          dimension: dimensionOf(request.entry),
          grantId: request.grantId,
          outcome: { kind: "refused", reason: refusal.reasonCode },
        });
        await auditRefusal(
          dependencies,
          "billing.tool_bypass_refused",
          request,
          refusal.reasonCode,
          basis.detail ?? {},
        );
        return refusal;
      }
      const verdict = assessToolSurchargeEnablement(basis.dims);
      if (verdict.status === "refused") {
        const refusal: ToolAdmissionRefusal = {
          status: "refused",
          stage: "enablement",
          reasonCode: verdict.code,
          detail: { dimensions: verdict.missing },
        };
        await recordToolCallCharge(database, {
          idempotencyKey: request.toolCallIdempotencyKey,
          entry: request.entry,
          tool: request.tool,
          dimension: dimensionOf(request.entry),
          grantId: request.grantId,
          outcome: { kind: "refused", reason: verdict.code },
        });
        await auditRefusal(
          dependencies,
          "billing.tool_bypass_refused",
          request,
          verdict.code,
          { dimensions: verdict.missing },
        );
        return refusal;
      }

      // ---- Stage 3a: the free path. Every billed dimension priced exactly zero is a
      // price, not a gap: dispatch hold-free, identity row charged-free.
      if (verdict.free) {
        await dispatch({ entry: request.entry, tool: request.tool, free: true });
        const recorded = await recordToolCallCharge(database, {
          idempotencyKey: request.toolCallIdempotencyKey,
          entry: request.entry,
          tool: request.tool,
          dimension: dimensionOf(request.entry),
          grantId: request.grantId,
          outcome: { kind: "charged-free" },
        });
        if (recorded.status !== "refused") {
          return {
            status: "admitted",
            free: true,
            chargeId: recorded.charge.chargeId,
            reservationId: null,
            attemptId: null,
          };
        }
        return {
          status: "refused",
          stage: "reserve",
          reasonCode: recorded.reasonCode,
          detail: {},
        };
      }

      // ---- Stage 3b: the hold. One unit of the entrance's dimension — the call count
      // IS the payload, certified by refusal over the ceiling exactly like the async
      // submit's entries (计满即拒, never truncation). Every other dimension of the
      // closed vocabulary is certified 0: a tool call bills its own surcharge side only.
      const billedDimension = dimensionOf(request.entry);
      const quantities = Object.fromEntries(
        PRICE_DIMENSIONS.map(
          (dimension) => [dimension, dimension === billedDimension ? 1 : 0] as const,
        ),
      ) as ReservationBoundQuantities;
      const ceiling = computeReservationCeiling({
        dims: basis.dims,
        quantities,
        rate: basis.rate,
      });
      if (!ceiling.ok) {
        const refusal: ToolAdmissionRefusal = {
          status: "refused",
          stage: "reserve",
          reasonCode: "ceiling_not_certifiable",
          detail: { issue: ceiling.issue },
        };
        await recordToolCallCharge(database, {
          idempotencyKey: request.toolCallIdempotencyKey,
          entry: request.entry,
          tool: request.tool,
          dimension: dimensionOf(request.entry),
          grantId: request.grantId,
          outcome: { kind: "refused", reason: refusal.reasonCode },
        });
        await auditRefusal(
          dependencies,
          "billing.tool_bypass_refused",
          request,
          refusal.reasonCode,
          { issue: ceiling.issue },
        );
        return refusal;
      }
      const reserved = await reserve({
        grantId: request.grantId,
        payer: request.payer as CreditReserveRequest["payer"],
        model: request.model as CreditReserveRequest["model"],
        snapshotVersion: request.snapshotVersion,
        rateVersion: request.rateVersion,
        maximumCredits: ceiling.maximumCredits,
        idempotencyKey: request.toolCallIdempotencyKey,
        boundEvidence: [
          { kind: "self_enforced_input_refusal", maximumTokens: 1 },
        ],
      });
      if (reserved.status !== "reserved") {
        const reasonCode =
          typeof (reserved as { reasonCode?: string }).reasonCode === "string"
            ? (reserved as { reasonCode: string }).reasonCode
            : "reserve_refused";
        const refusal: ToolAdmissionRefusal = {
          status: "refused",
          stage: "reserve",
          reasonCode,
          detail: {
            detail: (reserved as { detail?: Record<string, unknown> }).detail ?? {},
          },
        };
        await recordToolCallCharge(database, {
          idempotencyKey: request.toolCallIdempotencyKey,
          entry: request.entry,
          tool: request.tool,
          dimension: dimensionOf(request.entry),
          grantId: request.grantId,
          outcome: { kind: "refused", reason: reasonCode },
        });
        await auditRefusal(
          dependencies,
          "billing.tool_bypass_refused",
          request,
          reasonCode,
          { detail: (reserved as { detail?: Record<string, unknown> }).detail ?? {} },
        );
        return refusal;
      }

      // ---- The dispatch, only after the hold exists — the seam the tool-call-count
      // proofs read (provider/tool execution count is zero on every refusal above).
      await dispatch({ entry: request.entry, tool: request.tool, free: false });
      const recorded = await recordToolCallCharge(database, {
        idempotencyKey: request.toolCallIdempotencyKey,
        entry: request.entry,
        tool: request.tool,
        dimension: dimensionOf(request.entry),
        grantId: request.grantId,
        outcome: { kind: "charged", reservationId: reserved.reservationId },
      });
      if (recorded.status !== "refused") {
        return {
          status: "admitted",
          free: false,
          chargeId: recorded.charge.chargeId,
          reservationId: reserved.reservationId,
          attemptId: attemptIdForReservation(reserved.reservationId),
        };
      }
      return {
        status: "refused",
        stage: "reserve",
        reasonCode: recorded.reasonCode,
        detail: {},
      };
    },

    /** The grant's tool-call charges, oldest first — the door's own view of its trail. */
    listCharges: (grantId: string) => listToolCallChargesByGrant(database, grantId),
  };
}

export type ToolAdmissionService = ReturnType<typeof createToolAdmissionService>;

/** The dimension one entrance bills on — the registry's own mapping, never a second list. */
function dimensionOf(entry: ToolSurchargeEntryIdForIdentity): PriceDimension {
  const found = TOOL_SURCHARGE_ENTRIES.find((candidate) => candidate.id === entry);
  if (found === undefined || found.dimension === null) {
    // validateAdmissionRequest already refused ids outside the identity set; reaching
    // here means the registry and the id type drifted — a loud defect, never a guess.
    throw new TypeError(
      `tool-admission: entrance ${entry} is not an identity entrance of the registry`,
    );
  }
  return found.dimension;
}
