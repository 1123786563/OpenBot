import { z } from "zod";

export const catalogSegment = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[\p{L}\p{N}\p{So}]+(?:-[\p{L}\p{N}\p{So}]+)*$/u);
export const exactVersion = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/);

export const skillHubConfirmation = z.object({
  slug: catalogSegment,
  version: exactVersion,
  versionId: z.number().int().positive(),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  reviewTaskId: z.number().int().positive(),
  reviewerId: z.string().min(1),
});

export type SkillMarketConfig = {
  writesFrozen?: boolean;
  baseUrl: string;
  namespace: string;
  token: string;
  confirmations: Record<string, z.infer<typeof skillHubConfirmation>>;
};

export function skillHubOrigin(value: string): string | undefined {
  const url = URL.parse(value);
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin.length > 2048
  ) {
    return;
  }
  return url.origin;
}

export const bifrostNamespace = "bifrost";
export const bifrostSlug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export type BifrostMarketConfig = {
  writesFrozen?: boolean;
  kind: "bifrost";
  namespace: typeof bifrostNamespace;
  databaseUrl: string;
  legacy?: SkillMarketConfig;
};

export function loadSkillMarketConfig(
  env: Record<string, string | undefined>,
): SkillMarketConfig | BifrostMarketConfig | undefined {
  const freeze = env.SKILL_MARKET_WRITES_FROZEN?.trim() || "false";
  if (freeze !== "true" && freeze !== "false") {
    throw new Error("SKILL_MARKET_WRITES_FROZEN must be true or false.");
  }
  const writesFrozen = freeze === "true";
  const legacy = loadSkillHubConfig(env);
  const databaseUrl = env.BIFROST_SKILL_MARKET_DATABASE_URL?.trim();
  if (!databaseUrl) return legacy && { ...legacy, writesFrozen };

  const url = URL.parse(databaseUrl);
  if (
    !url ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2 ||
    legacy?.namespace === bifrostNamespace
  ) {
    throw new Error(
      "BIFROST_SKILL_MARKET_DATABASE_URL requires a PostgreSQL catalog reader URL and reserves the bifrost namespace.",
    );
  }
  return {
    kind: "bifrost",
    namespace: bifrostNamespace,
    databaseUrl,
    legacy,
    writesFrozen,
  };
}

function loadSkillHubConfig(
  env: Record<string, string | undefined>,
): SkillMarketConfig | undefined {
  const url = env.SKILLHUB_URL?.trim();
  const namespace = env.SKILLHUB_CATALOG_NAMESPACE?.trim();
  const token = env.SKILLHUB_READ_TOKEN?.trim();
  const rawConfirmations = env.SKILLHUB_COMPATIBILITY_CONFIRMATIONS?.trim();
  if (!url && !namespace && !token && !rawConfirmations) return;

  const baseUrl = skillHubOrigin(url ?? "");
  if (
    !baseUrl ||
    !namespace ||
    namespace === "global" ||
    !catalogSegment.safeParse(namespace).success ||
    !token ||
    /\s/.test(token)
  ) {
    throw new Error(
      "SkillHub requires SKILLHUB_URL (an HTTP origin), SKILLHUB_CATALOG_NAMESPACE (a team namespace), and SKILLHUB_READ_TOKEN.",
    );
  }

  try {
    const confirmed = z
      .array(skillHubConfirmation)
      .parse(JSON.parse(rawConfirmations || "[]"));
    const confirmations = Object.fromEntries(
      confirmed.map((entry) => [entry.versionId, entry]),
    );
    if (Object.keys(confirmations).length !== confirmed.length) {
      throw new Error("Duplicate version IDs");
    }
    return { baseUrl, namespace, token, confirmations };
  } catch {
    throw new Error(
      "SKILLHUB_COMPATIBILITY_CONFIRMATIONS must be a JSON array of exact-version confirmations with unique version IDs.",
    );
  }
}
