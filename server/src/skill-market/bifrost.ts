import { createHash } from "node:crypto";
import { Zip, ZipPassThrough } from "fflate";
import postgres from "postgres";
import { stringify } from "yaml";
import { z } from "zod";
import { CatalogEntryUnavailable } from "./catalog";
import {
  type BifrostMarketConfig,
  bifrostNamespace,
  bifrostSlug,
  exactVersion,
} from "./config";
import { decodeImportedSkillDocument } from "./imported-document";

export { bifrostSlug as bifrostSkillName } from "./config";

const pageSize = 20;
export const maxFiles = 256;
export const maxPackageBytes = 32 * 1024 * 1024;

const summaryRow = z.object({
  name: bifrostSlug,
  description: z.string(),
  latest_version: exactVersion,
});
const fileRow = z.object({
  path: z.string().max(1024),
  source_type: z.enum(["text", "dataurl", "upload"]),
  size: z.number().int().nonnegative(),
});
const versionRow = z.object({
  id: z.uuid(),
  skill_id: z.uuid(),
  version: exactVersion,
  skill_md_body: z.string().refine((body) => body.trim().length > 0),
  frontmatter_snapshot: z
    .object({
      name: z.never().optional(),
      description: z.string().min(1),
      compatibility: z.string().optional(),
    })
    .catchall(z.json()),
});
const storedFile = z.object({ path: z.string(), data: z.instanceof(Buffer) });
const compatibilityDeclaration = z.object({
  metadata: z
    .object({
      "openbot-compatibility": z.preprocess(
        (value) => {
          if (typeof value !== "string") return value;
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        },
        z
          .object({
            scripts: z.boolean(),
            supportingFiles: z.boolean(),
            dedicatedRuntime: z.boolean(),
          })
          .optional(),
      ),
    })
    .optional(),
});

export const bifrostPackageIdentity = z.object({
  namespace: z.literal(bifrostNamespace),
  slug: bifrostSlug,
  version: exactVersion,
  skillId: z.uuid(),
  versionId: z.uuid(),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export type BifrostPackageIdentity = z.infer<typeof bifrostPackageIdentity>;

export function bifrostPackageFingerprint(
  files: ReadonlyMap<string, Uint8Array>,
) {
  const hash = createHash("sha256");
  const entries = [...files].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [path, bytes] of entries) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    hash.update(`${path}:${digest}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

export class IncompleteBifrostPackage extends Error {
  constructor() {
    super(
      "This Bifrost package is incomplete or failed an integrity check. The ZIP was not created.",
    );
  }
}

export function createBifrostMarket(config: BifrostMarketConfig) {
  const sql = postgres(config.databaseUrl, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 5,
    connection: {
      statement_timeout: 10_000,
      application_name: "openbot-skill-market",
    },
  });

  function summary(row: z.infer<typeof summaryRow>) {
    return {
      namespace: config.namespace,
      slug: row.name,
      title: row.name,
      summary: row.description,
      latestVersion: row.latest_version,
      publisher: null,
    };
  }

  function checkScope(namespace: string, slug: string) {
    if (namespace !== config.namespace || !bifrostSlug.safeParse(slug).success)
      throw new CatalogEntryUnavailable();
  }

  async function scopedSummary(namespace: string, slug: string) {
    checkScope(namespace, slug);
    const [row] = await sql`
      select name, description, latest_version
      from openbot_skill_market.catalog where name = ${slug}
    `;
    if (!row) throw new CatalogEntryUnavailable();
    return summary(summaryRow.parse(row));
  }

  async function findVersion(
    connection: postgres.Sql | postgres.TransactionSql,
    slug: string,
    version: string,
  ) {
    const rows = await connection`
      select id, skill_id, version, skill_md_body, frontmatter_snapshot
      from openbot_skill_market.versions
      where name = ${slug} and version = ${version}
      limit 2
    `;
    if (!rows.length) throw new CatalogEntryUnavailable();
    const selected = versionRow.safeParse(rows[0]);
    if (rows.length !== 1 || !selected.success)
      throw new IncompleteBifrostPackage();
    return selected.data;
  }

  async function readExactPackage(
    namespace: string,
    slug: string,
    version: string,
  ) {
    checkScope(namespace, slug);
    if (!exactVersion.safeParse(version).success)
      throw new CatalogEntryUnavailable();
    return sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        const selected = await findVersion(transaction, slug, version);
        let original: Buffer | undefined;
        try {
          original = decodeImportedSkillDocument(
            slug,
            selected.skill_md_body,
            selected.frontmatter_snapshot,
          );
        } catch {
          throw new IncompleteBifrostPackage();
        }
        const main =
          original ??
          renderSkillDocument(
            slug,
            selected.frontmatter_snapshot,
            selected.skill_md_body,
          );
        const rows = await transaction`
          select path, source_type, least(file_size_bytes, ${maxPackageBytes + 1})::integer as size
          from openbot_skill_market.files
          where skill_version_id = ${selected.id}
          limit ${maxFiles + 1}
        `;
        const manifest = z.array(fileRow).safeParse(rows);
        if (
          !manifest.success ||
          rows.length > maxFiles ||
          manifest.data.reduce(
            (total, file) => total + file.size,
            main.length,
          ) > maxPackageBytes
        )
          throw new IncompleteBifrostPackage();

        checkArchivePaths(manifest.data.map(({ path }) => path));
        const blobs = await transaction`
          select path, data
          from openbot_skill_market.files
          where skill_version_id = ${selected.id}
            and octet_length(data) = file_size_bytes
        `;
        const contents = z.array(storedFile).safeParse(blobs);
        if (!contents.success || contents.data.length !== manifest.data.length)
          throw new IncompleteBifrostPackage();
        const byPath = new Map(
          contents.data.map(({ path, data }) => [path, data]),
        );
        const entries = new Map<string, Uint8Array>([["SKILL.md", main]]);
        for (const file of manifest.data) {
          const data = byPath.get(file.path);
          if (!data || data.byteLength !== file.size)
            throw new IncompleteBifrostPackage();
          entries.set(file.path, data);
        }
        return {
          versionId: selected.id,
          packageIdentity: bifrostPackageIdentity.parse({
            namespace,
            slug,
            version: selected.version,
            skillId: selected.skill_id,
            versionId: selected.id,
            fingerprint: bifrostPackageFingerprint(entries),
          }),
          frontmatter: selected.frontmatter_snapshot,
          instructions: selected.skill_md_body,
          files: entries,
        };
      },
    );
  }

  return {
    namespace: config.namespace,
    readExactPackage,
    close: () => sql.end(),

    async search(q: string, page: number) {
      const rows = await sql`
        select name, description, latest_version
        from openbot_skill_market.catalog
        where strpos(lower(name), lower(${q})) > 0
           or strpos(lower(description), lower(${q})) > 0
        order by name
        limit ${pageSize + 1} offset ${page * pageSize}
      `;
      return {
        items: z.array(summaryRow).parse(rows.slice(0, pageSize)).map(summary),
        hasMore: rows.length > pageSize,
      };
    },

    async detail(namespace: string, slug: string, page: number) {
      const skill = await scopedSummary(namespace, slug);
      const versions = await sql`
        select version from openbot_skill_market.versions
        where name = ${slug}
        order by created_at desc, version desc
        limit ${pageSize + 1} offset ${page * pageSize}
      `;
      return {
        ...skill,
        versions: z
          .array(z.object({ version: exactVersion }))
          .parse(versions.slice(0, pageSize))
          .map(({ version }) => version),
        hasMore: versions.length > pageSize,
      };
    },

    async commandSource(namespace: string, slug: string) {
      checkScope(namespace, slug);
      const [row] = await sql`
        select name, skill_id from openbot_skill_market.catalog where name = ${slug}
      `;
      if (!row) throw new CatalogEntryUnavailable();
      const skill = z
        .object({ name: bifrostSlug, skill_id: z.uuid() })
        .parse(row);
      return {
        source: bifrostNamespace,
        namespace,
        slug,
        title: skill.name,
        skillId: skill.skill_id,
      };
    },

    async preview(namespace: string, slug: string, version: string) {
      const { packageIdentity, frontmatter, instructions, files } =
        await readExactPackage(namespace, slug, version);
      const runtimeRequirements = frontmatter.compatibility?.trim() || null;
      const reasons: string[] = [];
      if (files.size > 1)
        reasons.push(
          "This package includes scripts or supporting files. OpenBot only installs self-contained SKILL.md packages.",
        );
      if (runtimeRequirements)
        reasons.push("This version declares additional runtime requirements.");
      const declaration = compatibilityDeclaration.safeParse(frontmatter);
      if (!declaration.success) {
        reasons.push(
          "This version has an invalid OpenBot compatibility declaration.",
        );
      } else {
        const compatibility =
          declaration.data.metadata?.["openbot-compatibility"];
        if (
          compatibility?.scripts ||
          compatibility?.supportingFiles ||
          compatibility?.dedicatedRuntime
        )
          reasons.push(
            "The publisher declares that this version requires scripts, supporting files, or a dedicated runtime.",
          );
      }
      return {
        registry: "bifrost",
        source: bifrostNamespace,
        namespace: packageIdentity.namespace,
        slug,
        title: slug,
        summary: frontmatter.description,
        version,
        publisher: null,
        instructions,
        runtimeRequirements,
        packageIdentity,
        fingerprint: packageIdentity.fingerprint,
        reasons,
      };
    },

    async download(namespace: string, slug: string, version: string) {
      const { files } = await readExactPackage(namespace, slug, version);
      return new Response(archive(files), {
        headers: { "Content-Type": "application/zip" },
      });
    },
  };
}

function renderSkillDocument(
  slug: string,
  snapshot: z.infer<typeof versionRow>["frontmatter_snapshot"],
  body: string,
) {
  const frontmatter = stringify(
    { name: slug, ...snapshot },
    {
      lineWidth: 0,
      defaultStringType: "QUOTE_DOUBLE",
      defaultKeyType: "PLAIN",
    },
  );
  return Buffer.from(`---\n${frontmatter}---\n${body}`);
}

function archive(files: Map<string, Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [path, bytes] of files) {
    const entry = new ZipPassThrough(path);
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

export function checkArchivePaths(paths: string[]) {
  const files = new Set(["skill.md"]);
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.normalize("NFC").toLowerCase().split("/");
    if (
      parts.some(
        (part) => !part || /[. ]$/.test(part) || /[\\:\p{Cc}]/u.test(part),
      )
    )
      throw new IncompleteBifrostPackage();
    const key = parts.join("/");
    if (files.has(key) || directories.has(key))
      throw new IncompleteBifrostPackage();
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/");
      if (files.has(parent)) throw new IncompleteBifrostPackage();
      directories.add(parent);
    }
    files.add(key);
  }
}
