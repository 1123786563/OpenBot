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
 * never travel through a package plan.
 */
const SECRET_LOOKING_CONFIG_KEY =
  /(secret|token|passw|credential|api[-_]?key|private[-_]?key|authori[sz]ation|bearer|envelope|plaintext|cookie|session)/i;

/** One flat, non-secret config entry (≤32 keys, string ≤512 chars). */
export const PackageConfigSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .refine((key) => !SECRET_LOOKING_CONFIG_KEY.test(key), {
        message: "config keys must not look like secrets",
      }),
    z.union([z.string().max(512), z.number().finite(), z.boolean()]),
  )
  .refine((config) => Object.keys(config).length <= 32, {
    message: "config supports at most 32 flat fields",
  });

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
    addedTools: z.array(PackageToolGrantSchema),
    removedTools: z.array(z.string()),
    blockers: z.array(PackageBlockerSchema),
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
  })
  .strict();

export type PackageInstallDetailDTO = z.infer<
  typeof PackageInstallDetailDTOSchema
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
  "PACKAGE_STORAGE_UNAVAILABLE",
  "ADMIN_CHANNEL_UNAVAILABLE",
  "INTERNAL",
] as const;

export const PackageErrorCodeSchema = z.enum(PackageErrorCodes);

export type PackageErrorCode = z.infer<typeof PackageErrorCodeSchema>;
