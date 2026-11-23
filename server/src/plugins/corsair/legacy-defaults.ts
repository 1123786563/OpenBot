import { z } from "zod";
import { githubId } from "./github";

const legacyDefaults = z.array(
  z.strictObject({
    workspaceId: z.string().min(1),
    registration: z.string().min(1),
    personId: z.string().min(1),
    brokeredAccountId: z.uuid(),
    githubUserId: githubId,
    evidenceRef: z.string().trim().min(1).max(256),
  }),
);

export type VerifiedLegacyGithubDefault = z.infer<
  typeof legacyDefaults
>[number];

export function readVerifiedLegacyGithubDefaults(raw: string | undefined) {
  if (!raw?.trim()) return [];
  try {
    const input: unknown = JSON.parse(raw);
    return legacyDefaults.parse(input);
  } catch {
    throw new Error(
      "CORSAIR_GITHUB_VERIFIED_LEGACY_DEFAULTS must contain valid GitHub identity evidence records.",
    );
  }
}
