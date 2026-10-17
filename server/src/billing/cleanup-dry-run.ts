import { createHash } from "node:crypto";
import type { Database } from "../db/client";
import {
  classifyCleanup,
  type ClassifiedRecord,
  type CleanupClassification,
  type TestEvidenceInput,
} from "./cleanup-classification";
import {
  evaluateCleanupRelations,
  type CleanupRelationsManifest,
  type RemovalReason,
} from "./cleanup-relations";
import type { CleanupManifest } from "./cleanup-manifest";

/*
 * The legacy billing cleanup dry-run (group 21.4) on top of 21.2's classification and 21.3's
 * relation evaluation. Everything upstream answers "what may be cleaned"; this module turns
 * that verdict into the artifact an administrator reviews before any execution exists:
 *
 * - Three lists with row counts: to-delete (exactly 21.3's safe candidates), to-retain (the
 *   kept classes plus every candidate 21.3 pulled, with its reason) and quarantine (21.2's
 *   unknown_owner records by isolation reason). Presentation is grouped statistics with a
 *   deterministic sample per group; the full record lists stay in the manifests the hash
 *   binds, so a sample never decides anything.
 * - A scope hash bound to content, not to a moment: sha256 over the canonical (key-sorted)
 *   JSON of every scope-deciding input — the manifest versions themselves, the database and
 *   schema the evidence was read from, the classification's rules, registries and every
 *   record verdict, and the relation evaluation's edges, probes, safe/removed sets, anchors
 *   and summary. Every `generatedAt` timestamp is excluded, so re-running the dry-run on
 *   unchanged data reproduces the hash byte for byte (repeatable, AC1), while a changed
 *   row, verdict, registry, anchor or version — including an unsampled row no human would
 *   notice in the report — changes it (AC3). The database is inside the hash and compared
 *   at verification: a confirmation taken on one database never verifies on another.
 * - Sanitization by construction: the report projects only opaque review identifiers
 *   (table, record id, external customer key, class, reasons). Amounts, checkout payloads,
 *   provider unique keys, body hashes, channel transaction ids and payer ids have no field
 *   to travel through (AC4).
 *
 * Read-only by construction: the deletion-relevant reads happen inside 21.2/21.3's
 * `REPEATABLE READ, READ ONLY` transaction fences and the assembly is a pure function of
 * their manifests — an accidental write is a runtime error, not a silent mutation. The
 * report itself never deletes anything; 21.5+ own the guards and the execution.
 */

/** The dry-run report contract version; a bump changes every hash (it is hash input). */
export const DRY_RUN_VERSION = 1;

/** The scope-hash scheme version; a bump invalidates every confirmation ever taken. */
export const SCOPE_HASH_VERSION = "cleanup-scope-v1";

/** The only hash algorithm the binding records today. */
export const SCOPE_HASH_ALGORITHM = "sha256";

/** How many record ids a review group samples, in deterministic (sorted) order. */
export const DEFAULT_SAMPLE_LIMIT = 5;

/** Every manifest version the hash binds; a bump anywhere invalidates prior hashes. */
export const MANIFEST_VERSIONS = {
  manifest: 1,
  classification: 1,
  relations: 1,
  dryRun: DRY_RUN_VERSION,
} as const;

export type ManifestVersions = typeof MANIFEST_VERSIONS;

/** What a confirmation records, and what `verifyCleanupScopeConfirmation` re-checks. */
export type CleanupScopeBinding = {
  scopeHashVersion: typeof SCOPE_HASH_VERSION;
  hashAlgorithm: typeof SCOPE_HASH_ALGORITHM;
  manifestVersions: ManifestVersions;
  /** The database the reviewed scope was read from — a confirmation never crosses databases. */
  database: string;
  schema: string;
  /** Lowercase hex sha256 over `scopeContent` — the full manifests, timestamps excluded. */
  scopeHash: string;
};

/** One review group: a table's row count plus a deterministic sample of its record ids. */
export type DryRunGroup = {
  table: string;
  rows: number;
  sampleRecordIds: string[];
};

/** One to-delete record: exactly the identifiers a reviewer (or 21.5) needs, no more. */
export type DryRunRecordRef = {
  table: string;
  recordId: string;
  externalCustomerId: string | null;
};

/** The admin-reviewable dry-run report. */
export type CleanupDryRunReport = {
  dryRunVersion: typeof DRY_RUN_VERSION;
  database: string;
  schema: string;
  generatedAt: string;
  /** Review-trail metadata about the consumed manifests; timestamps stay OUT of the hash. */
  basis: {
    classificationGeneratedAt: string;
    relationsGeneratedAt: string;
    classificationEvidenceSha256: string;
    candidatesIn: number;
  };
  /** The scope binding a confirmation records and verification re-checks. */
  binding: CleanupScopeBinding;
  /** A reviewer-readable statement of exactly what the hash covers. */
  hashCoverage: string;
  /** AC18's deletion scope: exactly 21.3's safe candidates, grouped and counted. */
  toDelete: {
    totalRows: number;
    /** The full actionable list — opaque identifiers only (see `DryRunRecordRef`). */
    records: DryRunRecordRef[];
    byTable: DryRunGroup[];
    byExternalCustomer: { externalCustomerId: string; rows: number }[];
  };
  /** Everything that stays: the kept classes, plus the candidates 21.3 pulled. */
  toRetain: {
    totalRows: number;
    keptByClass: {
      class: "company_history" | "personal_records";
      rows: number;
      byTable: DryRunGroup[];
    }[];
    pulledCandidates: {
      total: number;
      byReason: Record<RemovalReason, number>;
      sample: { table: string; recordId: string; reason: RemovalReason }[];
    };
  };
  /** The isolated keep: every unknown_owner record, by its isolation reason. */
  quarantine: {
    totalRows: number;
    byIsolationReason: {
      reason: NonNullable<ClassifiedRecord["isolationReason"]>;
      rows: number;
      byTable: DryRunGroup[];
    }[];
  };
  /** The live external associations, carried for human confirmation — never disposed. */
  externalAnchors: {
    activeSubscriptions: {
      total: number;
      sample: {
        externalSubscriptionId: string;
        externalCustomerId: string;
        planCode: string;
        status: string;
      }[];
    };
    openOrders: {
      total: number;
      sample: { orderId: string; status: string }[];
    };
  };
  summary: { recordsTotal: number };
};

/** The loose shape a persisted confirmation presents; verification fails closed. */
export type CleanupScopeConfirmationInput = {
  scopeHash?: unknown;
  scopeHashVersion?: unknown;
  hashAlgorithm?: unknown;
  manifestVersions?: unknown;
  database?: unknown;
  schema?: unknown;
};

/** The verdict of `verifyCleanupScopeConfirmation`. */
export type ConfirmationVerdict = { valid: boolean; differences: string[] };

/** Options of the pure assembly; the orchestrated builder passes them through. */
export type DryRunOptions = { sampleLimit?: number };

/**
 * Deterministic JSON: object keys sorted recursively, so the hash input is immune to field
 * ordering drift upstream. Arrays keep their (contract-fixed) order; `undefined` fields are
 * dropped exactly as `JSON.stringify` would.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The hash's exact coverage: every input that decides the deletion scope, with every
 * generation timestamp stripped. `basis.classificationGeneratedAt` is metadata — the
 * relations manifest carries it for the review trail, but hashing it would break the
 * repeat-run guarantee, so it is simply omitted here.
 */
function scopeContent(
  classification: CleanupClassification,
  relations: CleanupRelationsManifest,
) {
  return {
    scopeHashVersion: SCOPE_HASH_VERSION,
    manifestVersions: MANIFEST_VERSIONS,
    database: relations.database,
    schema: relations.schema,
    classification: {
      classificationVersion: classification.classificationVersion,
      rules: classification.rules,
      evidenceInput: classification.evidenceInput,
      records: classification.records,
    },
    relations: {
      relationsVersion: relations.relationsVersion,
      basis: {
        classificationVersion: relations.basis.classificationVersion,
        classificationDatabase: relations.basis.classificationDatabase,
        evidenceSha256: relations.basis.evidenceSha256,
        candidatesIn: relations.basis.candidatesIn,
      },
      fkEdges: relations.fkEdges,
      observedLinks: relations.observedLinks,
      evaluations: relations.evaluations,
      safeCandidates: relations.safeCandidates,
      removedCandidates: relations.removedCandidates,
      externalActiveSubscriptions: relations.externalActiveSubscriptions,
      externalOpenOrders: relations.externalOpenOrders,
      summary: relations.summary,
    },
  };
}

/**
 * The scope hash over the full manifests — never over the sampled report. Computing it from
 * `(classification, relations)` is what makes verification cheap downstream: re-derive the
 * manifests, recompute, compare.
 */
export function computeCleanupScopeHash(
  classification: CleanupClassification,
  relations: CleanupRelationsManifest,
): string {
  return createHash(SCOPE_HASH_ALGORITHM)
    .update(canonicalJson(scopeContent(classification, relations)))
    .digest("hex");
}

/** Rendering an absent confirmation field in a difference message. */
function shown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/**
 * Whether a persisted confirmation still holds: every binding field must be present and
 * equal to the fresh report's. Any difference is named — a scope-hash mismatch means the
 * manifest content changed since the confirmation; a version mismatch means the contract
 * moved under it; a database mismatch means someone tried to replay it elsewhere. An
 * incomplete confirmation fails closed: a field it does not record cannot be verified.
 */
export function verifyCleanupScopeConfirmation(
  confirmation: CleanupScopeConfirmationInput,
  fresh: CleanupDryRunReport,
): ConfirmationVerdict {
  const binding = fresh.binding;
  const differences: string[] = [];
  if (confirmation.scopeHashVersion !== binding.scopeHashVersion) {
    differences.push(
      `hash version mismatch: confirmation recorded ${shown(confirmation.scopeHashVersion)}, the current binding uses ${binding.scopeHashVersion}`,
    );
  }
  if (confirmation.hashAlgorithm !== binding.hashAlgorithm) {
    differences.push(
      `hash algorithm mismatch: confirmation recorded ${shown(confirmation.hashAlgorithm)}, the current binding uses ${binding.hashAlgorithm}`,
    );
  }
  const versions =
    typeof confirmation.manifestVersions === "object" &&
    confirmation.manifestVersions !== null
      ? (confirmation.manifestVersions as Record<string, unknown>)
      : {};
  for (const [name, current] of Object.entries(binding.manifestVersions)) {
    if (versions[name] !== current) {
      differences.push(
        `${name} version mismatch: confirmation recorded ${shown(versions[name])}, the current manifest is version ${current}`,
      );
    }
  }
  if (confirmation.database !== binding.database) {
    differences.push(
      `database mismatch: confirmation was taken on ${shown(confirmation.database)}, the current dry-run read ${binding.database} — a confirmation never crosses databases`,
    );
  }
  if (confirmation.schema !== binding.schema) {
    differences.push(
      `schema mismatch: confirmation recorded ${shown(confirmation.schema)}, the current dry-run read ${binding.schema}`,
    );
  }
  if (confirmation.scopeHash !== binding.scopeHash) {
    differences.push(
      `scope hash differs: the manifest content changed since the confirmation (confirmation ${shown(confirmation.scopeHash)}, current ${binding.scopeHash})`,
    );
  }
  return { valid: differences.length === 0, differences };
}

/**
 * The dry-run consumes 21.2's and 21.3's verdicts; if the two manifests do not describe the
 * same classification run, the report would review a scope nobody derived. Refuse, never
 * reconcile silently.
 */
function assertContractsAligned(
  classification: CleanupClassification,
  relations: CleanupRelationsManifest,
): void {
  if (
    relations.basis.classificationVersion !==
    classification.classificationVersion
  ) {
    throw new Error(
      `relations manifest was built on classification version ${relations.basis.classificationVersion}, but version ${classification.classificationVersion} was handed in — re-evaluate relations before assembling the dry-run.`,
    );
  }
  if (relations.basis.evidenceSha256 !== classification.evidenceInput.sha256) {
    throw new Error(
      `relations manifest cites evidence sha256 ${relations.basis.evidenceSha256}, but the classification's registries hash to ${classification.evidenceInput.sha256} — the two manifests do not describe the same classification run.`,
    );
  }
  if (relations.basis.candidatesIn !== classification.candidates.length) {
    throw new Error(
      `relations manifest evaluated ${relations.basis.candidatesIn} candidates, but the classification names ${classification.candidates.length} — re-evaluate relations before assembling the dry-run.`,
    );
  }
  const named = new Set(
    classification.candidates.map(
      (candidate) => `${candidate.table}/${candidate.recordId}`,
    ),
  );
  for (const evaluation of relations.evaluations) {
    if (!named.has(`${evaluation.table}/${evaluation.recordId}`)) {
      throw new Error(
        `relations manifest evaluates candidate ${evaluation.table}/${evaluation.recordId} that the classification never named — the two manifests disagree on the cleanup set.`,
      );
    }
  }
}

/** Tables in the classification's fixed order (records arrive pre-sorted), first-appearance. */
function tableOrderOf(classification: CleanupClassification): string[] {
  const order: string[] = [];
  for (const record of classification.records) {
    if (!order.includes(record.table)) order.push(record.table);
  }
  return order;
}

/** Sort key placing a table at its classification position (unknown tables last). */
function tableRank(order: string[], table: string): number {
  const index = order.indexOf(table);
  return index === -1 ? order.length : index;
}

/** One class's or reason's groups: rows counted whole, ids sampled sorted. */
function groupsFor(
  records: ReadonlyArray<{ table: string; recordId: string }>,
  sampleLimit: number,
  order: string[],
): DryRunGroup[] {
  const byTable = new Map<string, string[]>();
  for (const record of records) {
    const ids = byTable.get(record.table) ?? [];
    ids.push(record.recordId);
    byTable.set(record.table, ids);
  }
  return [...byTable.entries()]
    .sort(([a], [b]) => tableRank(order, a) - tableRank(order, b))
    .map(([table, ids]) => ({
      table,
      rows: ids.length,
      sampleRecordIds: ids.sort().slice(0, sampleLimit),
    }));
}

/**
 * Assemble the admin-reviewable report from the two manifests — a pure function, so 21.5+
 * can re-derive it from re-evaluated manifests and compare bindings byte for byte.
 * `generatedAt` is stamped here, metadata only: it never enters the binding's hash.
 */
export function assembleCleanupDryRunReport(
  classification: CleanupClassification,
  relations: CleanupRelationsManifest,
  options: DryRunOptions = {},
): CleanupDryRunReport {
  assertContractsAligned(classification, relations);
  const sampleLimit = Math.max(
    1,
    Math.trunc(options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT),
  );
  const order = tableOrderOf(classification);
  const rank = (table: string) => tableRank(order, table);
  const byRecordId = (a: { recordId: string }, b: { recordId: string }) =>
    a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;

  // --- to-delete: exactly 21.3's safe candidates, keyed and grouped for review.
  const keyByCandidate = new Map(
    classification.candidates.map((candidate) => [
      `${candidate.table}/${candidate.recordId}`,
      candidate.externalCustomerId,
    ]),
  );
  const deleteRecords: DryRunRecordRef[] = relations.safeCandidates
    .map((safe) => ({
      table: safe.table,
      recordId: safe.recordId,
      externalCustomerId:
        keyByCandidate.get(`${safe.table}/${safe.recordId}`) ?? null,
    }))
    .sort((a, b) => rank(a.table) - rank(b.table) || byRecordId(a, b));
  const deleteByTable = groupsFor(deleteRecords, sampleLimit, order);
  const deleteRowsByKey = new Map<string, number>();
  for (const record of deleteRecords) {
    const key = record.externalCustomerId ?? "unknown";
    deleteRowsByKey.set(key, (deleteRowsByKey.get(key) ?? 0) + 1);
  }

  // --- to-retain: the kept classes, then the candidates 21.3 pulled (with reasons).
  const keptByClass = (["company_history", "personal_records"] as const).map(
    (klass) => {
      const records = classification.records.filter(
        (record) => record.class === klass,
      );
      return {
        class: klass,
        rows: records.length,
        byTable: groupsFor(records, sampleLimit, order),
      };
    },
  );
  const byReason = Object.fromEntries(
    (
      [
        "cascade_impact_on_retained",
        "external_subscription_anchor",
        "external_payment_order_open",
        "attribution_basis_of_kept_records",
        "deletion_blocked_by_retained_reference",
      ] as RemovalReason[]
    ).map((reason) => [reason, 0]),
  ) as Record<RemovalReason, number>;
  for (const removed of relations.removedCandidates) {
    byReason[removed.reason] += 1;
  }
  const pulledTotal = relations.removedCandidates.length;

  // --- quarantine: every unknown_owner record, by its isolation reason.
  const isolationReasons = [
    "unknown_attribution",
    "insufficient_test_evidence",
    "in_flight_reservation",
  ] as const;
  const quarantineByReason = isolationReasons.map((reason) => {
    const records = classification.unknownOwners.filter(
      (record) => record.isolationReason === reason,
    );
    return {
      reason,
      rows: records.length,
      byTable: groupsFor(records, sampleLimit, order),
    };
  });

  const scopeHash = computeCleanupScopeHash(classification, relations);
  const keptRows = keptByClass.reduce((sum, entry) => sum + entry.rows, 0);
  const quarantineRows = quarantineByReason.reduce(
    (sum, entry) => sum + entry.rows,
    0,
  );

  return {
    dryRunVersion: DRY_RUN_VERSION,
    database: relations.database,
    schema: relations.schema,
    generatedAt: new Date().toISOString(),
    basis: {
      classificationGeneratedAt: classification.generatedAt,
      relationsGeneratedAt: relations.generatedAt,
      classificationEvidenceSha256: classification.evidenceInput.sha256,
      candidatesIn: relations.basis.candidatesIn,
    },
    binding: {
      scopeHashVersion: SCOPE_HASH_VERSION,
      hashAlgorithm: SCOPE_HASH_ALGORITHM,
      manifestVersions: MANIFEST_VERSIONS,
      database: relations.database,
      schema: relations.schema,
      scopeHash,
    },
    hashCoverage:
      "sha256 over the canonical (key-sorted) JSON of the scope-deciding manifest content: " +
      "the hash scheme version, all manifest versions, the database and schema the evidence was read from, " +
      "the classification's rules, evidence registries and every record verdict, and the relation evaluation's " +
      "foreign keys, observed links, per-candidate evaluations, safe and removed candidates, external anchors and summary. " +
      "Generation timestamps are excluded; any other change to any row, verdict, registry, edge, anchor or version changes this hash.",
    toDelete: {
      totalRows: deleteRecords.length,
      records: deleteRecords,
      byTable: deleteByTable,
      byExternalCustomer: [...deleteRowsByKey.entries()]
        .map(([externalCustomerId, rows]) => ({ externalCustomerId, rows }))
        .sort((a, b) =>
          a.externalCustomerId < b.externalCustomerId
            ? -1
            : a.externalCustomerId > b.externalCustomerId
              ? 1
              : 0,
        ),
    },
    toRetain: {
      totalRows: keptRows + pulledTotal,
      keptByClass,
      pulledCandidates: {
        total: pulledTotal,
        byReason,
        sample: [...relations.removedCandidates]
          .sort((a, b) => rank(a.table) - rank(b.table) || byRecordId(a, b))
          .slice(0, sampleLimit)
          .map((removed) => ({
            table: removed.table,
            recordId: removed.recordId,
            reason: removed.reason,
          })),
      },
    },
    quarantine: {
      totalRows: quarantineRows,
      byIsolationReason: quarantineByReason,
    },
    externalAnchors: {
      activeSubscriptions: {
        total: relations.externalActiveSubscriptions.length,
        sample: relations.externalActiveSubscriptions
          .slice(0, sampleLimit)
          .map((subscription) => ({
            externalSubscriptionId: subscription.externalSubscriptionId,
            externalCustomerId: subscription.externalCustomerId,
            planCode: subscription.planCode,
            status: subscription.status,
          })),
      },
      openOrders: {
        total: relations.externalOpenOrders.length,
        sample: relations.externalOpenOrders
          .slice(0, sampleLimit)
          .map((order_) => ({
            orderId: order_.orderId,
            status: order_.status,
          })),
      },
    },
    summary: { recordsTotal: classification.records.length },
  };
}

/**
 * The full dry-run: classify and evaluate through 21.2/21.3's read-only fences, then
 * assemble. Runs nothing but reads; safe to repeat on the dedicated test database or,
 * with the operator entry below, against the deployment database for review.
 */
export async function buildCleanupDryRun(
  database: Database,
  evidence: TestEvidenceInput,
  options: DryRunOptions & { enumeration?: CleanupManifest } = {},
): Promise<CleanupDryRunReport> {
  const classification = await classifyCleanup(database, evidence, {
    enumeration: options.enumeration,
  });
  const relations = await evaluateCleanupRelations(database, classification);
  return assembleCleanupDryRunReport(classification, relations, {
    sampleLimit: options.sampleLimit,
  });
}

if (import.meta.main) {
  // Operator entry: `bun server/src/billing/cleanup-dry-run.ts [registries.json]` prints the
  // dry-run report for the deployment database DATABASE_URL names, with the test-evidence
  // registries read from the JSON file argument
  // ({ "testOrderIds": [...], "testUserIds": [...] }; default: empty). Read-only by
  // construction — classification and evaluation run inside their own READ ONLY
  // transactions. Hand the printed JSON to the administrator; a confirmation records the
  // report's `binding`, and 21.5+ re-verify it before anything is deleted.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must point at the deployment database this dry-run should read.",
    );
  }
  const registryPath = process.argv[2];
  const registryInput: TestEvidenceInput = registryPath
    ? await Bun.file(registryPath).json()
    : { testOrderIds: [], testUserIds: [] };
  const { createDatabase } = await import("../db/client");
  const databaseInstance = createDatabase(databaseUrl);
  try {
    const dryRun = await buildCleanupDryRun(databaseInstance, registryInput);
    process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
  } finally {
    await databaseInstance.$client.end();
  }
}
