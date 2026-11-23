import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type postgres from "postgres";
import { z } from "zod";
import {
  checkArchivePaths,
  maxFiles,
  maxPackageBytes,
} from "../../src/skill-market/bifrost";

import {
  packageManifest,
  sha256,
} from "../../src/skill-market/package-manifest";

const fileRow = z.object({
  path: z.string().max(1024),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageKey: z.string().min(1),
});

export async function verifySourceFiles(
  files: z.infer<typeof fileRow>[],
  declared: { count: number; size: number },
  read: (file: z.infer<typeof fileRow>) => Promise<Buffer>,
) {
  if (
    files.length !== declared.count ||
    files.length > maxFiles + 1 ||
    declared.size > maxPackageBytes ||
    files.reduce((total, file) => total + file.size, 0) !== declared.size ||
    files.filter(({ path }) => path === "SKILL.md").length !== 1
  )
    throw new Error(
      "Source file manifest is incomplete or exceeds package limits",
    );

  checkArchivePaths(
    files.filter(({ path }) => path !== "SKILL.md").map(({ path }) => path),
  );
  const result = new Map<string, Buffer>();
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = await read(file);
    } catch {
      throw new Error(`Missing or unreadable source object for ${file.path}`);
    }
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      throw new Error(
        `Source bytes differ from the SkillHub manifest for ${file.path}`,
      );
    result.set(file.path, bytes);
  }
  return result;
}

const positiveId = z.number().int().positive();
const versionRow = z.object({
  registrySkillId: positiveId,
  versionId: positiveId,
  slug: z.string(),
  version: z.string(),
  disposition: z.enum(["catalog", "withdrawn", "historical"]),
  status: z.string(),
  ownerId: z.string(),
  createdBy: z.string(),
  publishedAt: z.date().nullable(),
  yankedAt: z.date().nullable(),
  yankReason: z.string().nullable(),
  count: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
});

export async function inventory(
  transaction: postgres.TransactionSql,
  namespace: string,
) {
  const namespaces =
    await transaction`select id from namespace where slug = ${namespace}`;
  if (namespaces.length !== 1)
    throw new Error("SkillHub source namespace is absent or ambiguous");
  return z.array(versionRow).parse(
    await transaction`
    select s.id::integer as "registrySkillId", v.id::integer as "versionId",
           s.slug, v.version, v.status, s.owner_id as "ownerId",
           v.created_by as "createdBy", v.published_at as "publishedAt",
           v.yanked_at as "yankedAt", v.yank_reason as "yankReason",
           v.file_count as count, least(v.total_size, ${maxPackageBytes + 1})::integer as size,
           case
             when v.status = 'YANKED' or v.yanked_at is not null then 'withdrawn'
             when s.status = 'ACTIVE' and not s.hidden and s.visibility = 'NAMESPACE_ONLY'
                  and latest.status = 'PUBLISHED' and v.status = 'PUBLISHED' and v.download_ready then 'catalog'
             else 'historical'
           end as disposition
    from namespace n
    join skill s on s.namespace_id = n.id
    join skill_version v on v.skill_id = s.id
    left join skill_version latest on latest.id = s.latest_version_id and latest.skill_id = s.id
    where n.slug = ${namespace}
      and (v.status in ('PUBLISHED', 'YANKED') or v.published_at is not null)
    order by s.slug, v.id
  `,
  );
}

export async function readSourceVersion(
  transaction: postgres.TransactionSql,
  storage: string,
  version: z.infer<typeof versionRow>,
) {
  const declared = z.array(fileRow).parse(
    await transaction`
    select file_path as path, least(file_size, ${maxPackageBytes + 1})::integer as size,
           sha256, storage_key as "storageKey"
    from skill_file where version_id = ${version.versionId}
    limit ${maxFiles + 2}
  `,
  );
  const files = await verifySourceFiles(
    declared,
    version,
    async ({ size, storageKey }) => {
      const path = await realpath(resolve(storage, storageKey));
      const within = relative(storage, path);
      if (
        !within ||
        within === ".." ||
        within.startsWith(`..${sep}`) ||
        isAbsolute(within)
      )
        throw new Error("Object is outside the snapshot");
      const file = await open(path);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== size)
          throw new Error("Object has an unexpected size");
        return await file.readFile();
      } finally {
        await file.close();
      }
    },
  );

  const reviews = z
    .array(
      z.object({
        reviewTaskId: z.string().regex(/^[0-9]+$/),
        status: z.string(),
        submittedBy: z.string(),
        reviewerId: z.string().nullable(),
        reviewedAt: z.date().nullable(),
        comment: z.string().nullable(),
        decisionMethod: z.string().nullable(),
      }),
    )
    .parse(
      await transaction`
    select id::text as "reviewTaskId", status, submitted_by as "submittedBy",
           reviewed_by as "reviewerId", reviewed_at as "reviewedAt",
           review_comment as comment, decision_method as "decisionMethod"
    from review_task where skill_version_id = ${version.versionId} and subject_type = 'SKILL_VERSION'
    order by id
  `,
    );
  return { files, reviews, manifest: packageManifest(files) };
}
