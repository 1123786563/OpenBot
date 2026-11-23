import { realpath } from "node:fs/promises";
import postgres from "postgres";
import { z } from "zod";
import { createBifrostMarket } from "../src/skill-market/bifrost";
import {
  bifrostNamespace,
  catalogSegment,
  skillHubConfirmation,
  skillHubOrigin,
} from "../src/skill-market/config";
import { inventory, readSourceVersion } from "./skill-migration/source";
import {
  compareVersionCores,
  MigrationConflict,
  migrationTarget,
  versionCore,
} from "./skill-migration/target";

const origin = z.string().transform((value, context) => {
  const normalized = skillHubOrigin(value);
  if (normalized) return normalized;
  context.addIssue({ code: "custom", message: "Expected an HTTP origin" });
  return z.NEVER;
});
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const settings = z.object({
  SKILLHUB_URL: origin,
  SKILLHUB_CATALOG_NAMESPACE: catalogSegment.refine(
    (value) => value !== "global",
  ),
  SKILLHUB_MIGRATION_SNAPSHOT_ID: label,
  SKILLHUB_MIGRATION_DATABASE_URL: postgresUrl,
  SKILLHUB_MIGRATION_STORAGE_ROOT: z.string().min(1),
  BIFROST_SKILL_MARKET_DATABASE_URL: postgresUrl,
  BIFROST_MIGRATION_URL: origin,
  BIFROST_MIGRATION_REGISTRY_ID: label,
  BIFROST_MIGRATION_COOKIE: z.string().min(1).optional(),
});

async function main() {
  const mode = z.enum(["import", "verify"]).parse(process.argv[2]);
  const env = settings.parse(process.env);
  if (mode === "import" && !env.BIFROST_MIGRATION_COOKIE)
    throw new Error("Import requires BIFROST_MIGRATION_COOKIE");
  const confirmations = z
    .array(skillHubConfirmation)
    .parse(
      JSON.parse(process.env.SKILLHUB_COMPATIBILITY_CONFIRMATIONS || "[]"),
    );
  const confirmedById = new Map(
    confirmations.map((item) => [item.versionId, item]),
  );
  if (confirmedById.size !== confirmations.length)
    throw new Error("Duplicate SkillHub review confirmations");
  const storage = await realpath(env.SKILLHUB_MIGRATION_STORAGE_ROOT);
  const sourceDb = postgres(env.SKILLHUB_MIGRATION_DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
  });
  const readerDb = postgres(env.BIFROST_SKILL_MARKET_DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
  });
  const market = createBifrostMarket({
    kind: "bifrost",
    namespace: bifrostNamespace,
    databaseUrl: env.BIFROST_SKILL_MARKET_DATABASE_URL,
  });
  const target = migrationTarget({
    sql: readerDb,
    market,
    origin: env.BIFROST_MIGRATION_URL,
    cookie: mode === "import" ? env.BIFROST_MIGRATION_COOKIE : undefined,
    registryId: env.BIFROST_MIGRATION_REGISTRY_ID,
  });
  const namespace = env.SKILLHUB_CATALOG_NAMESPACE;
  const sourceScope = { source: env.SKILLHUB_URL, namespace };

  try {
    const entries = await sourceDb.begin(
      "isolation level repeatable read read only",
      async (tx) => {
        const versions = (await inventory(tx, namespace))
          .map((version) => ({
            ...version,
            core: versionCore(version.version),
          }))
          .sort(
            (left, right) =>
              left.slug.localeCompare(right.slug) ||
              compareVersionCores(left.core, right.core),
          );
        const results = [];
        const blockedSkills = new Set<string>();
        for (const version of versions) {
          const source = {
            ...sourceScope,
            registrySkillId: version.registrySkillId,
            versionId: version.versionId,
            slug: version.slug,
            version: version.version,
          };
          const confirmation = confirmedById.get(version.versionId) ?? null;
          confirmedById.delete(version.versionId);
          let failureStage = "source";
          try {
            const { files, manifest, reviews } = await readSourceVersion(
              tx,
              storage,
              version,
            );
            if (
              confirmation &&
              (confirmation.slug !== version.slug ||
                confirmation.version !== version.version ||
                confirmation.fingerprint !== manifest.fingerprint ||
                !reviews.some(
                  (review) =>
                    review.reviewTaskId === String(confirmation.reviewTaskId) &&
                    review.reviewerId === confirmation.reviewerId &&
                    review.status === "APPROVED",
                ))
            )
              throw new Error(
                "OpenBot review confirmation conflicts with the verified SkillHub version",
              );
            const evidence = {
              source: { ...source, fingerprint: manifest.fingerprint },
              package: manifest,
              provenance: {
                status: version.status,
                ownerId: version.ownerId,
                createdBy: version.createdBy,
                publishedAt: version.publishedAt,
                yankedAt: version.yankedAt,
                yankReason: version.yankReason,
                reviews,
                confirmation,
              },
            };
            failureStage = "target";
            if (version.disposition === "catalog") {
              if (mode === "import" && blockedSkills.has(version.slug))
                throw new Error(
                  "Import deferred until the earlier version failure for this skill is resolved",
                );
              const verifiedTarget = await target.ensurePackage(source, files);
              results.push({
                status: "verified",
                ...evidence,
                target: verifiedTarget,
              });
            } else {
              await target.verifyAbsent(source);
              results.push({
                status: version.disposition,
                ...evidence,
                target: null,
              });
            }
          } catch (error) {
            if (version.disposition === "catalog")
              blockedSkills.add(version.slug);
            results.push({
              status: "failed",
              kind:
                error instanceof MigrationConflict
                  ? "conflict"
                  : "verification",
              stage: failureStage,
              source,
              error: message(error),
            });
          }
        }
        for (const confirmation of confirmedById.values())
          results.push({
            status: "failed",
            kind: "verification",
            stage: "source",
            source: { ...sourceScope, ...confirmation },
            error: "OpenBot review confirmation has no verified source record",
          });
        return results;
      },
    );
    return {
      schemaVersion: 1,
      mode,
      ready: entries.every(({ status }) => status !== "failed"),
      snapshotId: env.SKILLHUB_MIGRATION_SNAPSHOT_ID,
      source: sourceScope,
      target: {
        registryId: env.BIFROST_MIGRATION_REGISTRY_ID,
        namespace: bifrostNamespace,
      },
      entries,
    };
  } finally {
    await Promise.all([sourceDb.end(), readerDb.end(), market.close()]);
  }
}

function message(error: unknown) {
  // Driver diagnostics can contain query arguments or credentials.
  if (error instanceof postgres.PostgresError)
    return `PostgreSQL error (${error.code})`;
  if (error instanceof z.ZodError)
    return `Invalid data (${error.issues.map((issue) => issue.path.join(".")).join(", ")})`;
  return error instanceof Error ? error.message : "Unknown migration error";
}

try {
  const report = await main();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ready: false, error: message(error) })}\n`,
  );
  process.exitCode = 1;
}
