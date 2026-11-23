import { Zip, ZipPassThrough } from "fflate";
import postgres from "postgres";
import { stringify } from "yaml";
import { z } from "zod";
import { CatalogEntryUnavailable } from "./catalog";
import { type BifrostMarketConfig, exactVersion } from "./config";

const slugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const pageSize = 20;
const maxFiles = 256;
const maxPackageBytes = 32 * 1024 * 1024;

const summaryRow = z.object({
  name: slugSchema,
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
  const installationReason =
    "Bifrost versions are available to preview and download. Installation approval is unavailable.";

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
    if (namespace !== config.namespace || !slugSchema.safeParse(slug).success)
      throw new CatalogEntryUnavailable();
  }

  async function findVersion(
    connection: postgres.Sql | postgres.TransactionSql,
    slug: string,
    version: string,
  ) {
    const rows = await connection`
      select id, version, skill_md_body, frontmatter_snapshot
      from openbot_skill_market.versions
      where name = ${slug} and version = ${version}
    `;
    if (!rows.length) throw new CatalogEntryUnavailable();
    const selected = versionRow.safeParse(rows[0]);
    if (!selected.success) throw new IncompleteBifrostPackage();
    return selected.data;
  }

  return {
    namespace: config.namespace,
    installationReason,

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
      checkScope(namespace, slug);
      const [row] = await sql`
        select name, description, latest_version
        from openbot_skill_market.catalog where name = ${slug}
      `;
      if (!row) throw new CatalogEntryUnavailable();
      const versions = await sql`
        select version from openbot_skill_market.versions
        where name = ${slug}
        order by created_at desc, version desc
        limit ${pageSize + 1} offset ${page * pageSize}
      `;
      return {
        ...summary(summaryRow.parse(row)),
        versions: z
          .array(z.object({ version: exactVersion }))
          .parse(versions.slice(0, pageSize))
          .map(({ version }) => version),
        hasMore: versions.length > pageSize,
      };
    },

    async preview(namespace: string, slug: string, version: string) {
      checkScope(namespace, slug);
      if (!exactVersion.safeParse(version).success)
        throw new CatalogEntryUnavailable();
      const selected = await findVersion(sql, slug, version);
      return {
        registry: "bifrost",
        source: "Bifrost",
        namespace,
        slug,
        version,
        publisher: null,
        instructions: selected.skill_md_body,
        runtimeRequirements:
          selected.frontmatter_snapshot.compatibility ?? null,
        installable: false,
        reasons: [installationReason],
      };
    },

    async download(namespace: string, slug: string, version: string) {
      checkScope(namespace, slug);
      if (!exactVersion.safeParse(version).success)
        throw new CatalogEntryUnavailable();
      const files = await sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => {
          const selected = await findVersion(transaction, slug, version);
          const frontmatter = stringify(
            { name: slug, ...selected.frontmatter_snapshot },
            {
              lineWidth: 0,
              defaultStringType: "QUOTE_DOUBLE",
              defaultKeyType: "PLAIN",
            },
          );
          const main = Buffer.from(
            `---\n${frontmatter}---\n${selected.skill_md_body}`,
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
          if (
            !contents.success ||
            contents.data.length !== manifest.data.length
          )
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
          return entries;
        },
      );

      return new Response(archive(files), {
        headers: { "Content-Type": "application/zip" },
      });
    },
  };
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

function checkArchivePaths(paths: string[]) {
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
