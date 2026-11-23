import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";
import { z } from "zod";
import {
  bifrostSkillName,
  type createBifrostMarket,
} from "../../src/skill-market/bifrost";
import { bifrostNamespace, exactVersion } from "../../src/skill-market/config";
import { encodeImportedSkillDocument } from "../../src/skill-market/imported-document";
import { packageManifest } from "./source";

export class MigrationConflict extends Error {}

const coordinate = z.object({ slug: bifrostSkillName, version: exactVersion });
const skillRow = z.object({ skill_id: z.uuid() });
const versionRow = z.object({ id: z.uuid() });

// v2.6.0 compares the numeric core against the latest created version.
export function versionCore(version: string) {
  if (version !== version.trim()) return undefined;
  const [, major, minor, patch] =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.exec(
      version,
    ) ?? [];
  if (major === undefined || minor === undefined || patch === undefined)
    return undefined;
  const core = [BigInt(major), BigInt(minor), BigInt(patch)];
  return core.every((part) => part <= 9223372036854775807n) ? core : undefined;
}

export function compareVersionCores(
  left: ReturnType<typeof versionCore>,
  right: ReturnType<typeof versionCore>,
) {
  if (!left || !right) return Number(Boolean(left)) - Number(Boolean(right));
  for (const [index, part] of left.entries()) {
    const other = right[index];
    if (other !== undefined && part !== other) return part < other ? -1 : 1;
  }
  return 0;
}

export function migrationTarget({
  sql,
  market,
  origin,
  cookie,
  registryId,
}: {
  sql: postgres.Sql;
  market: ReturnType<typeof createBifrostMarket>;
  origin: string;
  cookie: string | undefined;
  registryId: string;
}) {
  async function exactId(slug: string, version: string) {
    const rows = z.array(versionRow).parse(
      await sql`
      select id from openbot_skill_market.versions
      where name = ${slug} and version = ${version}
    `,
    );
    if (rows.length > 1)
      throw new MigrationConflict("Ambiguous Bifrost version");
    return rows[0]?.id;
  }

  return {
    async verifyAbsent({ slug, version }: z.infer<typeof coordinate>) {
      if (await exactId(slug, version))
        throw new MigrationConflict(
          "A historical or withdrawn coordinate already exists in Bifrost",
        );
    },

    async ensurePackage(
      source: z.infer<typeof coordinate>,
      files: ReadonlyMap<string, Buffer>,
    ) {
      const { slug, version } = coordinate.parse(source);
      async function skillId() {
        const rows = z.array(skillRow).parse(
          await sql`
          select skill_id from openbot_skill_market.catalog where name = ${slug}
        `,
        );
        if (rows.length > 1)
          throw new MigrationConflict("Ambiguous Bifrost skill");
        return rows[0]?.skill_id;
      }
      let versionId = await exactId(slug, version);
      let existed = versionId !== undefined;
      let writtenSkillId: string | undefined;
      if (!versionId) {
        if (!cookie) throw new Error("Exact version is missing in Bifrost");
        const core = versionCore(version);
        if (!core)
          throw new Error(
            "Source version uses an unsupported Bifrost version format",
          );
        const [latest] = await sql`
          select version from openbot_skill_market.versions
          where name = ${slug} order by created_at desc limit 1
        `;
        if (
          latest &&
          compareVersionCores(
            core,
            versionCore(z.string().parse(latest.version)),
          ) < 0
        )
          throw new MigrationConflict(
            "Bifrost cannot add this missing version below its latest created version",
          );
        const main = files.get("SKILL.md");
        if (!main) throw new Error("SKILL.md is missing");
        const document = encodeImportedSkillDocument(main, slug);
        const attachments = [...files]
          .filter(([path]) => path !== "SKILL.md")
          .map(([path, bytes]) => ({
            path,
            source_type: "dataurl",
            dataurl: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
          }));
        const id = await skillId();
        const response = await fetch(
          new URL(id ? `/api/skills/${id}` : "/api/skills", origin),
          {
            method: id ? "PUT" : "POST",
            headers: { "content-type": "application/json", cookie, origin },
            redirect: "error",
            signal: AbortSignal.timeout(60_000),
            body: JSON.stringify({
              ...(id ? { serve: false } : { name: slug }),
              version,
              ...document.request,
              files: attachments,
            }),
          },
        );
        if (response.ok) {
          writtenSkillId = z
            .object({
              skill: z.object({ id: z.uuid(), name: z.literal(slug) }),
            })
            .parse(await response.json()).skill.id;
        } else {
          await response.body?.cancel();
          existed = true;
        }
        versionId = await exactId(slug, version);
        if (!versionId)
          throw new Error(
            `Exact version is missing after the Bifrost write (HTTP ${response.status})`,
          );
      }
      const resolvedSkillId = await skillId();
      if (
        !resolvedSkillId ||
        (writtenSkillId && resolvedSkillId !== writtenSkillId)
      )
        throw new Error("Bifrost management and reader identities disagree");

      const read = await market.readExactPackage(
        bifrostNamespace,
        slug,
        version,
      );
      if (read.versionId !== versionId)
        throw new Error("Bifrost version identity changed during verification");
      const manifest = packageManifest(read.files);
      if (!isDeepStrictEqual(packageManifest(files), manifest)) {
        const message =
          "Bifrost exact-version paths or bytes differ from SkillHub";
        if (existed) throw new MigrationConflict(message);
        throw new Error(message);
      }
      return {
        registryId,
        namespace: bifrostNamespace,
        slug,
        version,
        skillId: resolvedSkillId,
        versionId,
        fingerprint: manifest.fingerprint,
      };
    },
  };
}
