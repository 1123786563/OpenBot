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
  })
  .strict();

export type PackageInstallDetailDTO = z.infer<
  typeof PackageInstallDetailDTOSchema
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
  "INTERNAL",
] as const;

export const PackageErrorCodeSchema = z.enum(PackageErrorCodes);

export type PackageErrorCode = z.infer<typeof PackageErrorCodeSchema>;
