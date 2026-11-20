import { z } from "zod";

export const catalogSegment = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[\p{L}\p{N}\p{So}]+(?:-[\p{L}\p{N}\p{So}]+)*$/u);
export const exactVersion = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/);

const confirmation = z.object({
  slug: catalogSegment,
  version: exactVersion,
  versionId: z.number().int().positive(),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  reviewTaskId: z.number().int().positive(),
  reviewerId: z.string().min(1),
});

export type SkillMarketConfig = {
  baseUrl: string;
  namespace: string;
  token: string;
  confirmations: Record<string, z.infer<typeof confirmation>>;
};

export function loadSkillMarketConfig(
  env: Record<string, string | undefined>,
): SkillMarketConfig | undefined {
  const url = env.SKILLHUB_URL?.trim();
  const namespace = env.SKILLHUB_CATALOG_NAMESPACE?.trim();
  const token = env.SKILLHUB_READ_TOKEN?.trim();
  const rawConfirmations = env.SKILLHUB_COMPATIBILITY_CONFIRMATIONS?.trim();
  if (!url && !namespace && !token && !rawConfirmations) return;

  const parsed = URL.parse(url ?? "");
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
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
      .array(confirmation)
      .parse(JSON.parse(rawConfirmations || "[]"));
    const confirmations = Object.fromEntries(
      confirmed.map((entry) => [entry.versionId, entry]),
    );
    if (Object.keys(confirmations).length !== confirmed.length) {
      throw new Error("Duplicate version IDs");
    }
    return { baseUrl: parsed.origin, namespace, token, confirmations };
  } catch {
    throw new Error(
      "SKILLHUB_COMPATIBILITY_CONFIRMATIONS must be a JSON array of exact-version confirmations with unique version IDs.",
    );
  }
}
