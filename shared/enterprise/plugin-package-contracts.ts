/**
 * Plugin-package V1 wire contract: package manifest, marketplace index, HTTP
 * read DTOs and the closed blocker vocabulary.
 *
 * Every object is `.strict()`: a package or a caller that smuggles an extra
 * field is probing, not configuring. Nothing here carries a scope, a secret, a
 * filesystem path, a connector endpoint or an internal install id — those live
 * server-side and never reach a DTO.
 */

import { z } from "zod";

/** Package publisher, name and resource ids: lower-case kebab, max 64 chars. */
const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PackageIdSchema = z.string().max(64).regex(PACKAGE_ID_PATTERN);

/** Three non-negative integers, no leading zeros. `1.0`, `01.0.0` are not versions. */
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export const PackageVersionSchema = z.string().max(32).regex(VERSION_PATTERN);

/** `publisher/name`, the canonical package identity. */
const PACKAGE_KEY_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PackageKeySchema = z.string().max(129).regex(PACKAGE_KEY_PATTERN);

/**
 * A POSIX relative path inside the package: no absolute path, no empty
 * segment, no `.`/`..`, no backslash, no control characters. The artifact
 * builder re-checks this against the real filesystem; the schema keeps a
 * manifest from even describing an escaping path.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const PackagePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((value, context) => {
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      hasControlCharacters(value) ||
      value
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "path must be a POSIX relative path without . or .. segments",
      });
    }
  });

export const PackageResourceSchema = z.union([
  z
    .object({
      kind: z.literal("skill"),
      id: PackageIdSchema,
      path: PackagePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("expertTemplate"),
      id: PackageIdSchema,
      path: PackagePathSchema,
      skills: z.array(PackageIdSchema).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("managedConnector"),
      id: PackageIdSchema,
      catalogKey: PackageIdSchema,
      required: z.boolean(),
      // Deliberately no url/endpoint/auth field: a connector is a reference
      // to an existing catalog entry, never a way to inject an address.
      tools: z
        .array(
          z
            .object({
              name: z.string().min(1).max(128),
              effect: z.enum(["read", "write"]),
            })
            .strict(),
        )
        .max(256),
    })
    .strict(),
]);

export const PackageManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    platformApi: z.literal(1),
    publisher: PackageIdSchema,
    name: PackageIdSchema,
    version: PackageVersionSchema,
    display: z
      .object({
        name: z.string().min(1).max(120),
        summary: z.string().min(1).max(500),
        icon: PackagePathSchema.optional(),
      })
      .strict(),
    resources: z.array(PackageResourceSchema).max(256),
    // V1 packages do not depend on other packages.
    dependencies: z.tuple([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, resource] of manifest.resources.entries()) {
      if (ids.has(resource.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate resource id: ${resource.id}`,
          path: ["resources", index, "id"],
        });
      }
      ids.add(resource.id);
    }
    const skills = new Set(
      manifest.resources
        .filter((resource) => resource.kind === "skill")
        .map((resource) => resource.id),
    );
    for (const [index, resource] of manifest.resources.entries()) {
      if (resource.kind !== "expertTemplate") continue;
      for (const skill of resource.skills) {
        if (!skills.has(skill)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `expert template references unknown skill: ${skill}`,
            path: ["resources", index, "skills"],
          });
        }
      }
    }
  });

export type PackageManifestV1 = z.infer<typeof PackageManifestV1Schema>;

/**
 * PKG08 (#467): deployment release state. `listed` decides discovery only;
 * `withdrawn` is the safety withdrawal that blocks every new dispatch and
 * every install/upgrade/rollback into the release, in every scope. The two
 * facts are orthogonal: unlisting never withdraws, withdrawing never unlists.
 */
export const PackageReleaseStateSchema = z.enum(["published", "withdrawn"]);

export type PackageReleaseState = z.infer<typeof PackageReleaseStateSchema>;

export const MarketplaceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    packages: z
      .array(
        z
          .object({
            packageKey: PackageKeySchema,
            version: PackageVersionSchema,
            artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
            category: PackageIdSchema,
            listed: z.boolean(),
            /**
             * Absent means `published`: an index written before PKG08 keeps
             * parsing, and the parsed record always carries the state — the
             * default is decided here, once, never at a use site.
             */
            state: PackageReleaseStateSchema.default("published"),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();

export type MarketplaceV1 = z.infer<typeof MarketplaceV1Schema>;

export const PackageListQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    category: z.string().max(64).optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type PackageListQuery = z.infer<typeof PackageListQuerySchema>;

export const PackageBlockerCodes = [
  "ARTIFACT_MISSING",
  "ARTIFACT_INVALID",
  "PACKAGE_UNLISTED",
  "PACKAGE_WITHDRAWN",
  "PACKAGE_UNSUPPORTED",
  "RESOURCE_UNAVAILABLE",
  "NEEDS_CONNECTION",
  "NEEDS_GRANT",
] as const;

export const PackageBlockerCodeSchema = z.enum(PackageBlockerCodes);

export type PackageBlockerCode = z.infer<typeof PackageBlockerCodeSchema>;

export const PackageBlockerSchema = z
  .object({
    code: PackageBlockerCodeSchema,
    resourceId: PackageIdSchema.optional(),
  })
  .strict();

export type PackageBlocker = z.infer<typeof PackageBlockerSchema>;

export const PackageResourceKindSchema = z.enum([
  "skill",
  "expertTemplate",
  "managedConnector",
]);

export type PackageResourceKind = z.infer<typeof PackageResourceKindSchema>;

export const PackageResourceSummarySchema = z
  .object({
    id: PackageIdSchema,
    kind: PackageResourceKindSchema,
    available: z.boolean(),
    /**
     * PKG05 (#464): the tools a managed-connector resource declares in the
     * install's current revision manifest. The grant form offers exactly this
     * list (a grant is per tool; the server re-derives each digest/effect from
     * this same manifest). Absent for skills and templates.
     */
    tools: z
      .array(
        z
          .object({
            ref: z.string().min(1).max(256),
            effect: z.enum(["read", "write"]),
          })
          .strict(),
      )
      .max(256)
      .optional(),
  })
  .strict();

export type PackageResourceSummary = z.infer<
  typeof PackageResourceSummarySchema
>;

/**
 * Installability facts plus the real install for the current scope. PKG01 wrote
 * `install: null`; PKG02 merges the trusted scope's install or leaves it null —
 * never another team's facts.
 */
export const PackagePageItemSchema = z
  .object({
    packageKey: PackageKeySchema,
    version: PackageVersionSchema,
    displayName: z.string().max(120),
    summary: z.string().max(500),
    category: PackageIdSchema,
    install: z.lazy(() => PackageInstallDTOSchema).nullable(),
    installable: z.boolean(),
    blockers: z.array(PackageBlockerSchema),
  })
  .strict();

export type PackagePageItem = z.infer<typeof PackagePageItemSchema>;

export const PackagePageSchema = z
  .object({
    items: z.array(PackagePageItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type PackagePage = z.infer<typeof PackagePageSchema>;

export const PackageCatalogueDetailSchema = z
  .object({
    packageKey: PackageKeySchema,
    version: PackageVersionSchema,
    artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
    displayName: z.string().max(120),
    summary: z.string().max(500),
    category: PackageIdSchema,
    publisher: PackageIdSchema,
    name: PackageIdSchema,
    resources: z.array(PackageResourceSummarySchema),
    installable: z.boolean(),
    blockers: z.array(PackageBlockerSchema),
    /**
     * PKG06 (#465): the package's published (listed) releases, newest first.
     * The upgrade/rollback picker draws its exact target versions from here;
     * unlisted releases stay invisible (PKG08 owns withdrawal), and a plan
     * re-verifies the exact version server-side regardless.
     */
    versions: z
      .array(
        z
          .object({
            version: PackageVersionSchema,
            artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
            verified: z.boolean(),
            listed: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type PackageCatalogueDetail = z.infer<
  typeof PackageCatalogueDetailSchema
>;

// ---------------------------------------------------------------------------
// PKG02: install plans and install facts
// ---------------------------------------------------------------------------

/**
 * A secret-looking config key is refused at the wire contract, not just at the
 * service: secrets belong to the connector domain's sealed channel and must
 * never travel through a package plan. Exported beside `PACKAGE_CONFIG_LIMITS`
 * for the same reason: client-side pre-validation refuses exactly the keys this
 * schema refuses, from one source, instead of re-embedding a copy that drifts.
 */
export const SECRET_LOOKING_CONFIG_KEY =
  /(secret|token|passw|credential|api[-_]?key|private[-_]?key|authori[sz]ation|bearer|envelope|plaintext|cookie|session)/i;

/**
 * The flat, non-secret install-config wire limits. Exported so client-side
 * pre-validation mirrors the schema from one source instead of re-embedding
 * the numbers.
 */
export const PACKAGE_CONFIG_LIMITS = {
  maxKeys: 32,
  maxKeyLength: 64,
  maxValueLength: 512,
} as const;

/** One flat, non-secret config entry (≤32 keys, string ≤512 chars). */
export const PackageConfigSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(PACKAGE_CONFIG_LIMITS.maxKeyLength)
      .refine((key) => !SECRET_LOOKING_CONFIG_KEY.test(key), {
        message: "config keys must not look like secrets",
      }),
    z.union([
      z.string().max(PACKAGE_CONFIG_LIMITS.maxValueLength),
      z.number().finite(),
      z.boolean(),
    ]),
  )
  .refine(
    (config) => Object.keys(config).length <= PACKAGE_CONFIG_LIMITS.maxKeys,
    {
      message: "config supports at most 32 flat fields",
    },
  );

export type PackageConfig = z.infer<typeof PackageConfigSchema>;

export const PackageOperationSchema = z.enum([
  "install",
  "upgrade",
  "rollback",
]);

export type PackageOperation = z.infer<typeof PackageOperationSchema>;

/**
 * `PKG02` accepts `install` only; `upgrade`/`rollback` parse so the route can
 * answer `PACKAGE_UNSUPPORTED` instead of `INPUT_INVALID`.
 */
export const PackagePlanInputSchema = z
  .object({
    operation: PackageOperationSchema,
    packageKey: PackageKeySchema,
    version: PackageVersionSchema,
    expectedRevision: z.number().int().positive().nullable(),
    config: PackageConfigSchema.default({}),
    connectorInstalls: z
      .record(PackageIdSchema, z.string().min(1).max(128))
      .default({}),
  })
  .strict();

export type PackagePlanInput = z.infer<typeof PackagePlanInputSchema>;

/** 1–128 printable ASCII characters (an HTTP header value). */
/**
 * PKG05: the model-facing ref of one package connector tool.
 *
 * `pkg:<installId>:<resourceId>/<toolName>`. The prefix names the package
 * source, so a call carrying one is routed to the package dispatch branch and a
 * call carrying one WITHOUT a server-issued run context is refused
 * `PACKAGE_RUN_REQUIRED` — never quietly resolved as a legacy grant. The server
 * id / tool name split matches the legacy `mcp__<server>__<tool>` convention
 * (`serverId` = the part before the first `/`), so the same tool-name rules
 * apply to both sources.
 */
export const PACKAGE_TOOL_REF_PREFIX = "pkg:";

export function packageToolRefFor(
  installId: string,
  resourceId: string,
  toolName: string,
): string {
  return `${PACKAGE_TOOL_REF_PREFIX}${installId}:${resourceId}/${toolName}`;
}

export function parsePackageToolRef(
  ref: string,
): { installId: string; resourceId: string; toolName: string } | null {
  if (typeof ref !== "string" || !ref.startsWith(PACKAGE_TOOL_REF_PREFIX)) {
    return null;
  }
  const body = ref.slice(PACKAGE_TOOL_REF_PREFIX.length);
  const slash = body.indexOf("/");
  if (slash <= 0) return null;
  const identity = body.slice(0, slash);
  const toolName = body.slice(slash + 1);
  const colon = identity.indexOf(":");
  if (colon <= 0 || colon === identity.length - 1) return null;
  const installId = identity.slice(0, colon);
  const resourceId = identity.slice(colon + 1);
  if (!toolName || toolName.length > 200) return null;
  return { installId, resourceId, toolName };
}

export const PackageIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);

export const PackagePlanResourceSchema = z
  .object({
    id: PackageIdSchema,
    kind: PackageResourceKindSchema,
  })
  .strict();

export const PackageToolGrantSchema = z
  .object({
    ref: z.string().min(1).max(256),
    effect: z.enum(["read", "write"]),
    schemaDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type PackageToolGrant = z.infer<typeof PackageToolGrantSchema>;

/**
 * PKG06 (#465): the current→target version diff an upgrade/rollback plan
 * previews. Every entry is what the administrator must re-confirm: added and
 * removed resources, same-ref tools whose effect or schema digest changed
 * (the read→write / digest re-authorization cases), flat config key changes
 * (V1 has no migration script — the plan always carries the FULL target
 * config), and required-connector requirement changes. Present only on
 * upgrade/rollback plans (an install plan has nothing to diff).
 */
export const PackagePlanVersionDiffSchema = z
  .object({
    currentVersion: PackageVersionSchema,
    currentRevision: z.number().int().positive(),
    addedResources: z.array(PackagePlanResourceSchema),
    removedResources: z.array(PackagePlanResourceSchema),
    changedTools: z
      .array(
        z
          .object({
            ref: z.string().min(1).max(256),
            previousEffect: z.enum(["read", "write"]),
            effect: z.enum(["read", "write"]),
            previousSchemaDigest: z.string().regex(/^[0-9a-f]{64}$/),
            schemaDigest: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(256),
    configChanges: z
      .array(
        z
          .object({
            key: z.string().min(1).max(64),
            change: z.enum(["added", "removed", "changed"]),
          })
          .strict(),
      )
      .max(64),
    connectionChanges: z
      .array(
        z
          .object({
            resourceId: PackageIdSchema,
            change: z.enum(["added", "removed"]),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export type PackagePlanVersionDiff = z.infer<
  typeof PackagePlanVersionDiffSchema
>;

export const PackagePlanDTOSchema = z
  .object({
    planId: z.string().min(1).max(128),
    operation: PackageOperationSchema,
    packageKey: PackageKeySchema,
    version: PackageVersionSchema,
    artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedRevision: z.number().int().positive().nullable(),
    expiresAt: z.string().datetime(),
    resources: z.array(PackagePlanResourceSchema),
    /**
     * Install plans: every connector tool the release declares. Upgrade and
     * rollback plans: the PERMISSION INCREMENT — new tools plus same-ref tools
     * whose effect or schema digest changed — because those are exactly the
     * tools that need fresh authorization before any run may dispatch them.
     */
    addedTools: z.array(PackageToolGrantSchema),
    removedTools: z.array(z.string()),
    blockers: z.array(PackageBlockerSchema),
    /** PKG06: present on upgrade/rollback plans (null on install plans). */
    diff: PackagePlanVersionDiffSchema.optional(),
  })
  .strict();

export type PackagePlanDTO = z.infer<typeof PackagePlanDTOSchema>;

export const PackageInstallStatusSchema = z.enum([
  "enabled",
  "disabled",
  "uninstalled",
]);

export const PackageReadinessSchema = z.enum([
  "ready",
  "needs_connection",
  "needs_grant",
  "unavailable",
]);

export const PackageInstallActionSchema = z.enum([
  "plan",
  "apply",
  "grant",
  "createExpert",
  "disable",
  "enable",
  "uninstall",
]);

export type PackageInstallAction = z.infer<typeof PackageInstallActionSchema>;

/**
 * PKG07 (#466): PATCH …/installs/:id/status body.
 *
 * The install's three lifecycle states (`enabled` / `disabled` /
 * `uninstalled`) plus the CAS target the caller read. The CAS compares the
 * install REVISION, never a lifecycle counter: a status change moves
 * `generation` (and never creates a revision row), so a caller who read before
 * an upgrade is refused 409 and re-reads, while two lifecycle calls are
 * serialized by the install lock and the transition itself.
 *
 * `uninstalled` is a tombstone, not a delete: the row, its revision, Run pins,
 * audit receipts and dispatch evidence stay. Sending `enabled` from a
 * non-enabled install is the reinstall path — same install id, generation
 * increments, previously revoked grants stay revoked.
 */
export const PackageInstallStatusUpdateSchema = z
  .object({
    status: PackageInstallStatusSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export type PackageInstallStatusUpdate = z.infer<
  typeof PackageInstallStatusUpdateSchema
>;

// ---------------------------------------------------------------------------
// PKG03A: Bot grants (skill resources only in slice A)
// ---------------------------------------------------------------------------

/**
 * One granted resource of a Bot grant. Slice A only ever writes
 * `kind: "skill"`; the wire schema still carries the closed kind vocabulary so
 * a connector-tool request reaches the service and is answered with the
 * explicit `RESOURCE_KIND_UNSUPPORTED` verdict instead of a shape 400.
 */
export const PackageGrantResourceSchema = z
  .object({
    resourceId: PackageIdSchema,
    kind: PackageResourceKindSchema,
    /**
     * PKG05: the connector tools this resource grant covers, each written
     * `<resourceId>:<toolName>` and each declared by the install's CURRENT
     * revision manifest. Present exactly for `kind: "managedConnector"` rows
     * (a skill grant declares no tools); the server re-derives the schema
     * digest and effect from the reviewed manifest, never from the request.
     */
    toolRefs: z.array(z.string().min(1).max(256)).max(256).optional(),
  })
  .strict();

export type PackageGrantResource = z.infer<typeof PackageGrantResourceSchema>;

/** PUT …/bots/:botId/grants body. Scope and actor never travel on the wire. */
export const PackageGrantInputSchema = z
  .object({
    installId: z.string().min(1).max(128),
    botId: z.string().min(1).max(256),
    /** null = first grant for this install/bot pair; else exact CAS target. */
    expectedGrantRevision: z.number().int().positive().nullable(),
    resources: z.array(PackageGrantResourceSchema).min(1).max(256),
  })
  .strict();

export type PackageGrantInput = z.infer<typeof PackageGrantInputSchema>;

/** DELETE …/bots/:botId/grants body (optional; an absent key means null). */
export const PackageGrantRevokeBodySchema = z
  .object({
    expectedGrantRevision: z.number().int().positive().nullable().default(null),
  })
  .strict();

export type PackageGrantRevokeBody = z.infer<
  typeof PackageGrantRevokeBodySchema
>;

/** Service-side revoke input: the path supplies install and bot identity. */
export type PackageGrantRevokeInput = {
  installId: string;
  botId: string;
  expectedGrantRevision: number | null;
};

/** Grant facts for one Bot: `revision` counts distinct grant generations. */
export const PackageGrantDTOSchema = z
  .object({
    installId: z.string().min(1).max(128),
    botId: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    resources: z.array(PackageGrantResourceSchema),
  })
  .strict();

export type PackageGrantDTO = z.infer<typeof PackageGrantDTOSchema>;

/** Install facts visible to the current scope. Never carries config or secrets. */
export const PackageInstallDTOSchema = z
  .object({
    installId: z.string().min(1).max(128),
    packageKey: PackageKeySchema,
    version: PackageVersionSchema,
    artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
    revision: z.number().int().positive(),
    generation: z.number().int().positive(),
    status: PackageInstallStatusSchema,
    readiness: PackageReadinessSchema,
    blockers: z.array(PackageBlockerSchema),
    allowedActions: z.array(PackageInstallActionSchema),
  })
  .strict();

export type PackageInstallDTO = z.infer<typeof PackageInstallDTOSchema>;

export const PackageInstallDetailDTOSchema = z
  .object({
    installId: z.string().min(1).max(128),
    packageKey: PackageKeySchema,
    version: PackageVersionSchema,
    artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
    revision: z.number().int().positive(),
    generation: z.number().int().positive(),
    status: PackageInstallStatusSchema,
    readiness: PackageReadinessSchema,
    blockers: z.array(PackageBlockerSchema),
    allowedActions: z.array(PackageInstallActionSchema),
    resources: z.array(PackageResourceSummarySchema),
    /** Active (never revoked) Bot grants of this install, per Bot. */
    grants: z.array(PackageGrantDTOSchema),
    /**
     * PKG06 (#465): the deployment's newest published (listed + verified)
     * release of this package — null when nothing listed verifies. The
     * upgrade/rollback facts the detail screen draws beside the install.
     */
    latestPublishedVersion: PackageVersionSchema.nullable().optional(),
    /** PKG06: published exact targets an upgrade/rollback plan may name. */
    availableVersions: z
      .array(
        z
          .object({
            version: PackageVersionSchema,
            artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .optional(),
    /**
     * PKG10 (#469): dispatches of this install still in the `unknown` state —
     * the redacted "effect undetermined" badge the detail screen draws. Absent
     * when the ledger read is not wired (degraded read stays the detail it was).
     */
    unknownDispatches: z.number().int().nonnegative().optional(),
  })
  .strict();

export type PackageInstallDetailDTO = z.infer<
  typeof PackageInstallDetailDTOSchema
>;

// ---------------------------------------------------------------------------
// PKG10 (#469): dispatch ledger reads — unknown visibility, verification,
// recovery. Never carries arguments, tokens or raw vendor payloads.
// ---------------------------------------------------------------------------

/** The dispatch state machine's wire face (PKG05 semantics, unchanged). */
export const PackageDispatchStateSchema = z.enum([
  "prepared",
  "dispatched",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
]);

export type PackageDispatchState = z.infer<typeof PackageDispatchStateSchema>;

/** One dispatch row as this scope may read it: identities and redacted outcome facts only. */
export const PackageDispatchSummaryDTOSchema = z
  .object({
    operationId: z.string().min(1).max(64),
    runId: z.string().uuid(),
    attemptGeneration: z.number().int().positive(),
    toolCallId: z.string().min(1).max(256),
    installId: z.string().min(1).max(128),
    resourceId: z.string().min(1).max(128),
    /** `<resourceId>:<toolName>` — the binding inside the run snapshot. */
    toolRef: z.string().min(1).max(256),
    effect: z.enum(["read", "write"]),
    state: PackageDispatchStateSchema,
    /** Redacted outcome facts as recorded (effectStatus and friends); null until settled. */
    receiptRef: z.record(z.string(), z.unknown()).nullable(),
    errorCode: z.string().max(128).nullable(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export type PackageDispatchSummaryDTO = z.infer<
  typeof PackageDispatchSummaryDTOSchema
>;

/**
 * The evidence identity an unknown dispatch is bound to (AC3): the caller's
 * own connection row and vendor account alias, the managed connector install
 * the call reached, and the argument digest — never the arguments themselves.
 */
export const PackageDispatchEvidenceDTOSchema = z
  .object({
    connectionId: z.string().min(1).max(128).nullable(),
    accountHandle: z.string().min(1).max(256).nullable(),
    connectorInstallId: z.string().min(1).max(128),
    argsDigest: z.string().regex(/^[0-9a-f]{64}$/),
    connectionGeneration: z.number().int().positive(),
  })
  .strict();

export type PackageDispatchEvidenceDTO = z.infer<
  typeof PackageDispatchEvidenceDTOSchema
>;

/**
 * What the verification surface can honestly say about one dispatch. `unknown`
 * is the PKG10 core: no auto-resend ever, and a vendor query only when a
 * verified protocol is registered. `definite` / `in_flight` reuse the recorded
 * state — the surface never invents a completion or failure.
 */
export const PackageDispatchVerificationDTOSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("unknown"),
        /** False = no verified vendor query protocol exists for this call. */
        canQueryVendor: z.boolean(),
        /** Closed reason vocabulary for the "why no auto-resend" line. */
        noAutoResendReason: z.enum([
          "NO_VENDOR_QUERY_PROTOCOL",
          "VENDOR_QUERY_UNRESOLVED",
        ]),
        /** Settled receipts of the same run the handler can correlate against. */
        relatedReceipts: z.array(PackageDispatchSummaryDTOSchema).max(20),
      })
      .strict(),
    z.object({ kind: z.literal("definite") }).strict(),
    z.object({ kind: z.literal("in_flight") }).strict(),
  ],
);

export type PackageDispatchVerificationDTO = z.infer<
  typeof PackageDispatchVerificationDTOSchema
>;

/** The recovery gate for an unknown dispatch (AC5): would a FOLLOW-UP call (a
 * new operation, never a resend) pass every revalidation the dispatch chain
 * enforces — membership, run lease, pin, install state/generation, release
 * state, grant, connection generation, per-call revalidation. */
export const PackageDispatchRecoveryDTOSchema = z.union([
  z
    .object({
      ready: z.literal(true),
    })
    .strict(),
  z
    .object({
      ready: z.literal(false),
      /** The first gate that refused (the dispatch chain's closed refusal codes). */
      refusalCode: z.string().min(1).max(64),
    })
    .strict(),
]);

export type PackageDispatchRecoveryDTO = z.infer<
  typeof PackageDispatchRecoveryDTOSchema
>;

/** GET /installs/:id/dispatches/:operationId — one dispatch's verification view. */
export const PackageDispatchInspectionDTOSchema = z
  .object({
    dispatch: PackageDispatchSummaryDTOSchema,
    evidence: PackageDispatchEvidenceDTOSchema,
    verification: PackageDispatchVerificationDTOSchema,
    /** Present for `unknown` rows only; null otherwise. */
    recovery: PackageDispatchRecoveryDTOSchema.nullable(),
  })
  .strict();

export type PackageDispatchInspectionDTO = z.infer<
  typeof PackageDispatchInspectionDTOSchema
>;

/** POST /installs/:id/dispatches/:operationId/verify — protocol-mediated result. */
export const PackageDispatchVerifyDTOSchema = z
  .object({
    /** `verified` = a definite result was written back; `unresolved` = the
     * protocol found no match and the row keeps its unknown facts untouched. */
    outcome: z.enum(["verified", "unresolved"]),
    dispatch: PackageDispatchSummaryDTOSchema,
  })
  .strict();

export type PackageDispatchVerifyDTO = z.infer<
  typeof PackageDispatchVerifyDTOSchema
>;

// ---------------------------------------------------------------------------
// PKG04A: expert instantiation (create a scoped Bot from a package template)
// ---------------------------------------------------------------------------

/** Limits for the expert template file inside a verified package artifact. */
export const PACKAGE_EXPERT_TEMPLATE_LIMITS = {
  maxNameLength: 120,
  maxSummaryLength: 500,
  maxSystemPromptLength: 100_000,
  maxSkills: 256,
} as const;

/**
 * The expert template JSON a package ships at the manifest resource's `path`.
 * Strict: a template that carries an endpoint, auth or remote-runtime field is
 * a probing artifact, and the instantiation refuses it outright — a package
 * Bot always runs `built_in` on the deployment's own runtime.
 */
export const PackageExpertTemplateSchema = z
  .object({
    name: z.string().min(1).max(PACKAGE_EXPERT_TEMPLATE_LIMITS.maxNameLength),
    summary: z
      .string()
      .min(1)
      .max(PACKAGE_EXPERT_TEMPLATE_LIMITS.maxSummaryLength),
    systemPrompt: z
      .string()
      .min(1)
      .max(PACKAGE_EXPERT_TEMPLATE_LIMITS.maxSystemPromptLength),
    /**
     * The in-package skill refs this template uses. Must equal the manifest's
     * `expertTemplate.skills` for the same resource — the manifest is the
     * authority; a file that disagrees with it is rejected.
     */
    skills: z
      .array(PackageIdSchema)
      .max(PACKAGE_EXPERT_TEMPLATE_LIMITS.maxSkills),
  })
  .strict();

export type PackageExpertTemplate = z.infer<typeof PackageExpertTemplateSchema>;

/**
 * POST …/installs/:id/experts/:resourceId body. Scope, actor, principal and
 * the new Bot's id are server-resolved; the caller picks only the display name
 * and the CAS revision target. There is no template field here on purpose:
 * template content comes from the installed revision's verified artifact.
 */
export const PackageExpertCreateInputSchema = z
  .object({
    installId: z.string().min(1).max(128),
    resourceId: PackageIdSchema,
    expectedRevision: z.number().int().positive(),
    name: z.string().min(1).max(PACKAGE_EXPERT_TEMPLATE_LIMITS.maxNameLength),
  })
  .strict();

export type PackageExpertCreateInput = z.infer<
  typeof PackageExpertCreateInputSchema
>;

/** Result of one expert instantiation (also the stored replay payload). */
export const PackageExpertCreatedDTOSchema = z
  .object({
    agentId: z.string().min(1).max(256),
    installId: z.string().min(1).max(128),
    packageKey: PackageKeySchema,
    version: PackageVersionSchema,
    resourceId: PackageIdSchema,
    /** `publisher/name/resourceId`, same shape as the resource link ref. */
    expertTemplateRef: z.string().min(1).max(256),
    displayName: z
      .string()
      .min(1)
      .max(PACKAGE_EXPERT_TEMPLATE_LIMITS.maxNameLength),
    /** Distinct grant generations written for the initial Skill grant. */
    grantRevision: z.number().int().positive(),
    /** The template's skill resources granted to the new Bot at creation. */
    resources: z.array(PackageGrantResourceSchema),
  })
  .strict();

export type PackageExpertCreatedDTO = z.infer<
  typeof PackageExpertCreatedDTOSchema
>;

/** Closed HTTP error vocabulary for the package surface. */
export const PackageErrorCodes = [
  "AUTH_REQUIRED",
  "SCOPE_REQUIRED",
  "INPUT_INVALID",
  "TENANT_FORBIDDEN",
  "TENANT_ADMIN_REQUIRED",
  "RESOURCE_NOT_FOUND",
  "REVISION_CONFLICT",
  "PLAN_CHANGED",
  "IDEMPOTENCY_CONFLICT",
  "PLAN_EXPIRED",
  "PACKAGE_UNSUPPORTED",
  "RESOURCE_KIND_UNSUPPORTED",
  "PACKAGE_BOT_SCOPE_UNAVAILABLE",
  "PACKAGE_RUN_REQUIRED",
  "TEMPLATE_FIELD_REJECTED",
  "PACKAGE_STORAGE_UNAVAILABLE",
  "ADMIN_CHANNEL_UNAVAILABLE",
  // PKG10 (#469): dispatch verification refusals — closed additions.
  "VENDOR_QUERY_PROTOCOL_UNAVAILABLE",
  "DISPATCH_NOT_UNKNOWN",
  "DISPATCH_ACCOUNT_UNAVAILABLE",
  "INTERNAL",
] as const;

export const PackageErrorCodeSchema = z.enum(PackageErrorCodes);

export type PackageErrorCode = z.infer<typeof PackageErrorCodeSchema>;
