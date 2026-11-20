import { z } from "zod";
import { catalogSegment, exactVersion, type SkillMarketConfig } from "./config";

const envelope = z.object({ code: z.literal(0), data: z.unknown() });
const id = z.number().int().positive();
const versionSummary = z.object({
  id,
  version: exactVersion,
  status: z.string(),
});
const upstreamSkill = z.object({
  id,
  namespace: catalogSegment,
  slug: catalogSegment,
  displayName: z.string(),
  summary: z.string().nullish(),
  ownerDisplayName: z.string().nullish(),
  status: z.string(),
  visibility: z.string(),
  hidden: z.boolean().optional(),
  publishedVersion: versionSummary.nullish(),
});

type PublishedSkill = z.infer<typeof upstreamSkill> & {
  publishedVersion: z.infer<typeof versionSummary>;
};

const page = <Item extends z.ZodType>(item: Item) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
    size: z.number().int().positive(),
  });

const versionDetail = versionSummary.extend({
  parsedMetadataJson: z.string().nullish(),
});
const resolution = z.object({
  skillId: id,
  namespace: catalogSegment,
  slug: catalogSegment,
  version: exactVersion,
  versionId: id,
  fingerprint: z.string().min(1),
});

const metadata = z.object({
  body: z.string(),
  frontmatter: z
    .object({
      metadata: z
        .object({ "openbot-compatibility": z.unknown().optional() })
        .optional(),
      compatibility: z.unknown().optional(),
    })
    .nullish(),
});

const compatibility = z.strictObject({
  scripts: z.boolean(),
  supportingFiles: z.boolean(),
  dedicatedRuntime: z.boolean(),
});

export type RegistryFetch = (url: URL, init: RequestInit) => Promise<Response>;

export class CatalogEntryUnavailable extends Error {}

export function createSkillMarket(
  config: SkillMarketConfig,
  fetchRegistry: RegistryFetch = fetch,
) {
  async function request(path: string) {
    const response = await fetchRegistry(new URL(path, config.baseUrl), {
      headers: { authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if ([400, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      throw new CatalogEntryUnavailable();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("SkillHub request failed");
    }
    return response;
  }

  async function read<Schema extends z.ZodType>(path: string, schema: Schema) {
    const response = await request(path);
    return schema.parse(envelope.parse(await response.json()).data);
  }

  function visible(
    skill: z.infer<typeof upstreamSkill>,
  ): skill is PublishedSkill {
    return (
      skill.namespace === config.namespace &&
      skill.status === "ACTIVE" &&
      !skill.hidden &&
      skill.visibility === "NAMESPACE_ONLY" &&
      skill.publishedVersion?.status === "PUBLISHED"
    );
  }

  function summary(skill: PublishedSkill) {
    return {
      slug: skill.slug,
      namespace: skill.namespace,
      title: skill.displayName,
      summary: skill.summary ?? "",
      publisher: skill.ownerDisplayName ?? null,
      latestVersion: skill.publishedVersion.version,
    };
  }

  async function scopedSkill(namespace: string, slug: string) {
    if (
      namespace !== config.namespace ||
      !catalogSegment.safeParse(slug).success
    ) {
      throw new CatalogEntryUnavailable();
    }
    const path = `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
    const skill = await read(path, upstreamSkill);
    if (!visible(skill) || skill.slug !== slug)
      throw new CatalogEntryUnavailable();
    return { skill, path };
  }

  async function publishedVersion(
    namespace: string,
    slug: string,
    version: string,
  ) {
    if (!exactVersion.safeParse(version).success)
      throw new CatalogEntryUnavailable();
    const { skill, path } = await scopedSkill(namespace, slug);
    const versionPath = `${path}/versions/${encodeURIComponent(version)}`;
    const detail = await read(versionPath, versionDetail);
    if (detail.version !== version || detail.status !== "PUBLISHED") {
      throw new CatalogEntryUnavailable();
    }
    const resolved = await read(
      `${path}/resolve?${new URLSearchParams({ version })}`,
      resolution,
    );
    if (
      resolved.skillId !== skill.id ||
      resolved.versionId !== detail.id ||
      resolved.namespace !== namespace ||
      resolved.slug !== slug ||
      resolved.version !== version
    ) {
      throw new CatalogEntryUnavailable();
    }
    return { skill, detail, resolved, versionPath };
  }

  const market = {
    async search(q: string, pageNumber: number) {
      const params = new URLSearchParams({
        q,
        namespace: config.namespace,
        page: String(pageNumber),
        size: "20",
      });
      const result = await read(
        `/api/web/skills?${params}`,
        page(upstreamSkill),
      );
      return {
        items: result.items.filter(visible).map(summary),
        hasMore: (result.page + 1) * result.size < result.total,
      };
    },

    async detail(namespace: string, slug: string, pageNumber: number) {
      const { skill, path } = await scopedSkill(namespace, slug);
      const params = new URLSearchParams({
        downloadableOnly: "true",
        page: String(pageNumber),
        size: "20",
      });
      const result = await read(
        `${path}/versions?${params}`,
        page(versionSummary),
      );
      return {
        ...summary(skill),
        versions: result.items
          .filter((version) => version.status === "PUBLISHED")
          .map((version) => version.version),
        hasMore: (result.page + 1) * result.size < result.total,
      };
    },

    async preview(namespace: string, slug: string, version: string) {
      const { skill, detail, resolved, versionPath } = await publishedVersion(
        namespace,
        slug,
        version,
      );
      const document = metadata.parse(
        JSON.parse(detail.parsedMetadataJson ?? "null"),
      );
      const files = await read(
        `${versionPath}/files`,
        z.array(z.object({ filePath: z.string() })),
      );
      const declaration =
        document.frontmatter?.metadata?.["openbot-compatibility"];
      const requirements = compatibility.safeParse(declaration);
      const confirmed = config.confirmations[detail.id];
      const reasons: string[] = [];
      if (declaration === undefined) {
        reasons.push("The publisher has not declared OpenBot compatibility.");
      } else if (!requirements.success) {
        reasons.push(
          "The publisher's OpenBot compatibility declaration is invalid.",
        );
      } else {
        if (requirements.data.scripts)
          reasons.push("This version requires scripts.");
        if (requirements.data.supportingFiles)
          reasons.push("This version requires supporting files.");
        if (requirements.data.dedicatedRuntime)
          reasons.push("This version requires a dedicated runtime.");
        if (
          confirmed?.slug !== slug ||
          confirmed.version !== version ||
          confirmed.fingerprint !== resolved.fingerprint
        ) {
          reasons.push(
            "A reviewer has not confirmed OpenBot compatibility for this package.",
          );
        }
      }
      if (files.length !== 1 || files[0]?.filePath !== "SKILL.md") {
        reasons.push(
          "Only a package containing a single SKILL.md file is supported.",
        );
      }
      const runtimeRequirement = document.frontmatter?.compatibility;
      const runtimeRequirements =
        typeof runtimeRequirement === "string"
          ? runtimeRequirement.trim() || null
          : null;
      if (runtimeRequirements) {
        reasons.push("This version declares additional runtime requirements.");
      } else if (
        runtimeRequirement != null &&
        typeof runtimeRequirement !== "string"
      ) {
        reasons.push(
          "This version's additional runtime requirements are invalid.",
        );
      }
      if (!document.body.trim()) {
        reasons.push("SKILL.md does not contain instructions.");
      }
      return {
        ...summary(skill),
        source: config.baseUrl,
        registrySkillId: skill.id,
        version,
        versionId: detail.id,
        fingerprint: resolved.fingerprint,
        instructions: document.body,
        compatibility: requirements.success ? requirements.data : null,
        runtimeRequirements,
        reasons,
        installable: reasons.length === 0,
      };
    },

    async download(namespace: string, slug: string, version: string) {
      const { versionPath } = await publishedVersion(namespace, slug, version);
      const response = await request(`${versionPath}/download`);
      if (
        !response.body ||
        response.headers.get("content-type") !== "application/zip"
      ) {
        await response.body?.cancel();
        throw new Error("SkillHub did not return a ZIP archive");
      }
      return response;
    },
  };

  return {
    ...market,
    async qualifyInstallation(
      namespace: string,
      slug: string,
      version: string,
    ) {
      const preview = await market.preview(namespace, slug, version);
      if (!preview.installable)
        return { kind: "ineligible", reasons: preview.reasons } as const;
      return { kind: "qualified", preview } as const;
    },
  };
}

export type MarketPreview = Awaited<
  ReturnType<ReturnType<typeof createSkillMarket>["preview"]>
>;

export type QualifiedMarketVersion = Extract<
  Awaited<
    ReturnType<ReturnType<typeof createSkillMarket>["qualifyInstallation"]>
  >,
  { kind: "qualified" }
>;
