/**
 * The administrator's model open scope (Bifrost 03.7, AC10/Q4/Q17).
 *
 * A MODEL IN THE CATALOG IS NOT A MODEL USERS CAN CALL. The catalog (03.1) is what the
 * gateway lists; the open scope is what an administrator has explicitly opened. This module
 * keeps those two apart: a ref is open only when its `gateway_model_open_scopes` row says
 * `open` AND the ref is still in the last-good catalog — so a newly synced model widens
 * nothing until an administrator says so (Q17: 同步不自动扩大管理员开放范围), and a
 * delisted model stops being open no matter what its row says (Q17: 下架模型阻止新请求).
 *
 * THE DEFAULT IS CLOSED, AND IT IS STATED BY ABSENCE. A ref with no scope row has never
 * been acted on, and the answer for it is `false` — the closed state is the default, not
 * an oversight. Opening requires the administrator's reason, the ref's presence in the
 * catalog, and a price basis that is fully priced (the latest snapshot's classification is
 * not `unknown` — design Q11: 无法完整定价的路径不可启用). Every successful open and
 * close writes an audit row (`gateway.model_scope_changed`) carrying the reason, the
 * previous state and the actor, so the history lives where nobody can rewrite it.
 *
 * SCOPE CHANGES ARE ADMISSION-BOUND, NEVER RETROSPECTIVE (AC10). `closeModel` writes the
 * scope row and the audit row and nothing else: the price snapshots a running request
 * locked stay resolvable forever (03.2's append-only table), and live reservations are
 * untouched. `isModelOpen` is the one query the downstream consumers (03.8's capability
 * filter, 06.2's reserve path) gate selection and admission on; it answers for NEW
 * requests only.
 *
 * WHO CALLS THIS. The admin surface (`gateway/admin-routes.ts`) drives `openModel`,
 * `closeModel` and `listAdminCatalog`; 03.8 and 06.2 consume `isModelOpen`. No fallback,
 * no guessing: a store that cannot be reached fails the call, it never defaults open.
 */
import { and, eq } from "drizzle-orm";
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";
import type { AuditStore } from "../audit";
import type { Database } from "../db/client";
import { gatewayModelOpenScopes } from "../db/schema";
import type { GatewayCatalogStore } from "./catalog";
import {
  type CatalogCapabilitySource,
  type CatalogStoredRef,
  createEnterpriseGatewayCatalogStore,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelRef,
  modelRefKey,
} from "./catalog";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  type GatewayPriceSnapshotStore,
} from "./price-snapshot";

/** The two states an administrator's action can leave a ref in. */
export const MODEL_SCOPE_STATES = ["open", "closed"] as const;

export type ModelScopeState = (typeof MODEL_SCOPE_STATES)[number];

/** Why an open/close was refused. Fixed codes of this module — displayable anywhere. */
export type ModelScopeChangeRefusalReason =
  | "model_scope_reason_required"
  | "model_scope_reason_too_long"
  | "model_scope_capability_invalid"
  | "model_scope_ref_not_in_catalog"
  | "model_scope_price_missing"
  | "model_scope_price_unknown"
  | "model_scope_state_invalid"
  | "model_scope_store_unavailable";

/** How long a recorded reason may be: a sentence, not an essay. */
export const MODEL_SCOPE_REASON_MAX_LENGTH = 512;

/** One stored scope decision: the current state plus who left it and why. */
export type ModelOpenScopeRecord = {
  ref: ModelRef;
  state: ModelScopeState;
  /** The administrator's recorded reason — the displayable why. */
  reason: string;
  /** The operator's email at the time of the change. */
  changedBy: string;
  /** When the latest change was made, ISO 8601. */
  changedAt: string;
};

/** The input every open/close carries: the ref, the why, and who is acting. */
export type ModelScopeChangeInput = {
  ref: ModelRef;
  reason: string;
  actor: { userId: string; email: string };
};

/** What an open/close answers — a record, or the fixed code it was refused for. */
export type ModelScopeChangeResult =
  | { ok: true; record: ModelOpenScopeRecord }
  | {
      ok: false;
      reasonCode: ModelScopeChangeRefusalReason;
      /** When the refusal is about the price basis, the status that refused. */
      priceStatus?: "known" | "free" | "unknown";
    };

/** Where the current scope state persists; tests may supply their own. */
export type GatewayModelOpenScopeStore = {
  /** The current record for one ref, or undefined when nobody ever acted on it. */
  getScope(ref: ModelRef): Promise<ModelOpenScopeRecord | undefined>;
  /** Every recorded scope decision, ordered by the ref identity. */
  listScopes(): Promise<ModelOpenScopeRecord[]>;
  /** Record the latest decision for one ref — an insert or an overwrite, audited by the caller. */
  setScope(input: {
    ref: ModelRef;
    state: ModelScopeState;
    reason: string;
    changedBy: string;
    /** When the change was made — the caller's clock, so tests control the timestamp. */
    changedAt: Date;
  }): Promise<ModelOpenScopeRecord>;
};

/** Strict read of one stored row; a damaged row is skipped, not repaired. */
function scopeRecordFromRow(row: {
  provider: string;
  model: string;
  capability: string;
  state: string;
  reason: string;
  changedBy: string;
  changedAt: Date;
}): ModelOpenScopeRecord | undefined {
  if (!MODEL_CAPABILITIES.includes(row.capability as ModelCapability)) {
    return undefined;
  }
  if (row.state !== "open" && row.state !== "closed") {
    return undefined;
  }
  return {
    ref: {
      provider: row.provider,
      model: row.model,
      capability: row.capability as ModelCapability,
    },
    state: row.state,
    reason: row.reason,
    changedBy: row.changedBy,
    changedAt: row.changedAt.toISOString(),
  };
}

/** The scope store over `gateway_model_open_scopes` — the sibling pattern of the catalog store. */
export function createEnterpriseGatewayModelScopeStore(
  database: Database,
): GatewayModelOpenScopeStore {
  return {
    async getScope(ref) {
      const rows = await database
        .select()
        .from(gatewayModelOpenScopes)
        .where(
          and(
            eq(gatewayModelOpenScopes.provider, ref.provider),
            eq(gatewayModelOpenScopes.model, ref.model),
            eq(gatewayModelOpenScopes.capability, ref.capability),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? scopeRecordFromRow(row) : undefined;
    },

    async listScopes() {
      const rows = await database
        .select()
        .from(gatewayModelOpenScopes)
        .orderBy(
          gatewayModelOpenScopes.provider,
          gatewayModelOpenScopes.model,
          gatewayModelOpenScopes.capability,
        );
      return rows
        .map(scopeRecordFromRow)
        .filter(
          (record): record is ModelOpenScopeRecord => record !== undefined,
        );
    },

    async setScope({ ref, state, reason, changedBy, changedAt }) {
      const [row] = await database
        .insert(gatewayModelOpenScopes)
        .values({
          provider: ref.provider,
          model: ref.model,
          capability: ref.capability,
          state,
          reason,
          changedBy,
          changedAt,
        })
        .onConflictDoUpdate({
          target: [
            gatewayModelOpenScopes.provider,
            gatewayModelOpenScopes.model,
            gatewayModelOpenScopes.capability,
          ],
          set: {
            state,
            reason,
            changedBy,
            changedAt,
          },
        })
        .returning();
      const record = scopeRecordFromRow(row);
      if (!record) {
        throw new TypeError(
          `The stored open-scope row for ${ref.provider}/${ref.model} came back outside the closed state set; the table has been tampered with.`,
        );
      }
      return record;
    },
  };
}

/** One catalog entry as the admin's catalog page shows it. */
export type AdminModelCatalogEntry = {
  ref: ModelRef;
  /** Where the capability came from — the catalog's own derivation metadata. */
  capabilitySource: CatalogCapabilitySource;
  /** Why the capability is unknown, when it is. */
  unknownReason: string | null;
  /**
   * The latest price basis's classification: the closed three from 03.3, plus
   * `unmapped` when no snapshot has ever been synced for the ref. Displayed,
   * never a number.
   */
  priceStatus: "known" | "free" | "unknown" | "unmapped";
  /** Why the status is unknown, from the classification's fixed reason set; null otherwise. */
  priceStatusReason: string | null;
  /** The unpriced necessary dimensions, for the refusal display; null otherwise. */
  priceMissingDims: readonly { dimension: string; reason: string }[] | null;
  /** The current scope decision, or null while no administrator has acted on the ref. */
  scope: {
    state: ModelScopeState;
    reason: string;
    changedBy: string;
    changedAt: string;
  } | null;
  /** The resolved answer: in the catalog AND explicitly opened. */
  open: boolean;
};

export type GatewayModelScopeDeps = {
  /** The catalog's last-good refs — the universe a scope decision can name. */
  catalog: GatewayCatalogStore;
  /** The latest price bases — opening requires a fully priced ref. */
  priceSnapshots: GatewayPriceSnapshotStore;
  /** The current scope state. */
  scopes: GatewayModelOpenScopeStore;
  /** The append-only audit trail every successful change is written to. */
  audit: AuditStore;
  /** Injectable clock for tests. */
  now?: () => Date;
  log?: Logger;
};

export type GatewayModelScopeService = {
  /**
   * The one selection/invocation answer (consumed by 03.8 and 06.2): the ref is in the
   * last-good catalog AND an administrator left it open. Absence of a scope row is
   * closed — the default a sync must arrive at. A store failure throws; it never
   * defaults open.
   */
  isModelOpen(ref: ModelRef): Promise<boolean>;
  /** The current scope decision for one ref, or undefined when nobody has acted on it. */
  getScope(ref: ModelRef): Promise<ModelOpenScopeRecord | undefined>;
  /**
   * Open one ref: requires a reason, the ref in the catalog, and a price basis whose
   * classification is not `unknown`. Records the audit row with the previous state.
   */
  openModel(input: ModelScopeChangeInput): Promise<ModelScopeChangeResult>;
  /**
   * Close one ref: requires a reason and the ref in the catalog. Writes the scope row
   * and the audit row and nothing else — locked snapshots and live reservations are
   * not touched (AC10).
   */
  closeModel(input: ModelScopeChangeInput): Promise<ModelScopeChangeResult>;
  /** Every catalog ref with its price status and scope decision — the admin page's read. */
  listAdminCatalog(): Promise<AdminModelCatalogEntry[]>;
};

/** The audit event type every scope change is recorded under. */
export const MODEL_SCOPE_AUDIT_EVENT_TYPE = "gateway.model_scope_changed";
export type ModelScopeAuditEventType = typeof MODEL_SCOPE_AUDIT_EVENT_TYPE;

/** Validate the input every change shares: reason present, bounded, capability closed. */
function validateChangeInput(
  input: ModelScopeChangeInput,
): ModelScopeChangeResult | undefined {
  const reason = input.reason.trim();
  if (reason === "") {
    return { ok: false, reasonCode: "model_scope_reason_required" };
  }
  if (reason.length > MODEL_SCOPE_REASON_MAX_LENGTH) {
    return { ok: false, reasonCode: "model_scope_reason_too_long" };
  }
  if (!MODEL_CAPABILITIES.includes(input.ref.capability)) {
    return { ok: false, reasonCode: "model_scope_capability_invalid" };
  }
  return undefined;
}

/**
 * The shared preconditions of both actions: the ref must be in the last-good catalog. A
 * ref the gateway stopped listing can be neither opened (nothing to open) nor closed
 * (already unselectable through the catalog check).
 */
async function requireCatalogedRef(
  deps: GatewayModelScopeDeps,
  ref: ModelRef,
): Promise<ModelScopeChangeResult | undefined> {
  const refs = await deps.catalog.readCatalogRefs();
  const cataloged = refs.some(
    (entry: CatalogStoredRef) =>
      entry.ref.provider === ref.provider &&
      entry.ref.model === ref.model &&
      entry.ref.capability === ref.capability,
  );
  if (!cataloged) {
    return { ok: false, reasonCode: "model_scope_ref_not_in_catalog" };
  }
  return undefined;
}

/** Write the audit row every successful change owes the trail. */
async function auditScopeChange(
  deps: GatewayModelScopeDeps,
  input: ModelScopeChangeInput,
  previousState: ModelScopeState | null,
  nextState: ModelScopeState,
  reason: string,
): Promise<void> {
  await deps.audit.insert({
    eventType: MODEL_SCOPE_AUDIT_EVENT_TYPE,
    targetType: "gateway_model",
    targetId: modelRefKey(input.ref),
    actorUserId: input.actor.userId,
    payload: {
      provider: input.ref.provider,
      model: input.ref.model,
      capability: input.ref.capability,
      previousState,
      state: nextState,
      reason,
    },
  });
}

export function createGatewayModelScopeService(
  deps: GatewayModelScopeDeps,
): GatewayModelScopeService {
  const log = deps.log ?? getLogger("server");
  const now = deps.now ?? (() => new Date());

  async function changeScope(
    input: ModelScopeChangeInput,
    nextState: ModelScopeState,
  ): Promise<ModelScopeChangeResult> {
    const invalid = validateChangeInput(input);
    if (invalid) return invalid;

    const notCataloged = await requireCatalogedRef(deps, input.ref);
    if (notCataloged) return notCataloged;

    // Opening requires a price basis an admission could enforce; closing does not
    // (closing is the safe direction — it can only narrow what new requests may do).
    let previousState: ModelScopeState | null = null;
    const existing = await deps.scopes.getScope(input.ref);
    if (existing) previousState = existing.state;
    if (nextState === "open") {
      const snapshot = await deps.priceSnapshots.latestPriceSnapshot(input.ref);
      if (!snapshot) {
        return { ok: false, reasonCode: "model_scope_price_missing" };
      }
      if (snapshot.classification.status === "unknown") {
        log.info(
          {
            type: "gateway-model-scope-open-refused",
            ref: modelRefKey(input.ref),
            priceStatus: "unknown",
          },
          "Opening was refused: the ref's price basis is not completely priced.",
        );
        return {
          ok: false,
          reasonCode: "model_scope_price_unknown",
          priceStatus: "unknown",
        };
      }
    }

    const reason = input.reason.trim();
    const record = await deps.scopes.setScope({
      ref: input.ref,
      state: nextState,
      reason,
      changedBy: input.actor.email,
      changedAt: now(),
    });
    await auditScopeChange(deps, input, previousState, nextState, reason);
    return { ok: true, record };
  }

  return {
    async isModelOpen(ref) {
      // One closed-set read each: the scope row must say open, and the ref must
      // still be in the last-good catalog — a delisted model is not selectable
      // whatever its row says (Q17).
      const [record, refs] = await Promise.all([
        deps.scopes.getScope(ref),
        deps.catalog.readCatalogRefs(),
      ]);
      if (record?.state !== "open") return false;
      return refs.some(
        (entry: CatalogStoredRef) =>
          entry.ref.provider === ref.provider &&
          entry.ref.model === ref.model &&
          entry.ref.capability === ref.capability,
      );
    },

    getScope(ref) {
      return deps.scopes.getScope(ref);
    },

    openModel(input) {
      return changeScope(input, "open");
    },

    closeModel(input) {
      return changeScope(input, "closed");
    },

    async listAdminCatalog() {
      const [refs, scopes, snapshots] = await Promise.all([
        deps.catalog.readCatalogRefs(),
        deps.scopes.listScopes(),
        deps.priceSnapshots.listLatestPriceSnapshots(),
      ]);
      const scopeByKey = new Map(
        scopes.map((record) => [modelRefKey(record.ref), record]),
      );
      const snapshotByKey = new Map(
        snapshots.map((snapshot) => [modelRefKey(snapshot.ref), snapshot]),
      );
      return refs.map((entry: CatalogStoredRef): AdminModelCatalogEntry => {
        const key = modelRefKey(entry.ref);
        const scope = scopeByKey.get(key);
        const snapshot = snapshotByKey.get(key);
        const classification = snapshot?.classification;
        return {
          ref: entry.ref,
          capabilitySource: entry.capabilitySource,
          unknownReason: entry.unknownReason ?? null,
          priceStatus: classification
            ? classification.status
            : ("unmapped" as const),
          priceStatusReason:
            classification?.status === "unknown"
              ? classification.reasonCode
              : null,
          priceMissingDims:
            classification?.status === "unknown"
              ? classification.missingDimensions.map((missing) => ({
                  dimension: missing.dimension,
                  reason: missing.reason,
                }))
              : null,
          scope: scope
            ? {
                state: scope.state,
                reason: scope.reason,
                changedBy: scope.changedBy,
                changedAt: scope.changedAt,
              }
            : null,
          open: scope?.state === "open",
        };
      });
    },
  };
}

/**
 * The running model-scope service, resolved through the installed enterprise controls so
 * the admin routes need no new wiring: the catalog, price-snapshot, scope and audit
 * stores over the shared database. Undefined in a test or script that never installed
 * the controls — the same answer the sibling accessors give.
 */
export function gatewayModelScopeControls():
  | GatewayModelScopeService
  | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  const database = controls.deps.database;
  return createGatewayModelScopeService({
    catalog: createEnterpriseGatewayCatalogStore(database),
    priceSnapshots: createEnterpriseGatewayPriceSnapshotStore(database),
    scopes: createEnterpriseGatewayModelScopeStore(database),
    audit: controls.deps.auditStore,
    log: getLogger("server"),
  });
}
