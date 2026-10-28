/**
 * The profile shape a legacy marketplace install writes for one catalogue
 * expert — the single source both the install route and the migration's
 * reference hash consume, so the reference can never drift from what the
 * write actually persists (OCR R5-H-C).
 */

import type { CatalogueExpert } from "./catalogue";

/** Only the two catalogue fields the install write projects. */
export type CatalogueExpertProfileFields = Pick<
  CatalogueExpert,
  "name" | "roleDescription"
>;

export function builtinExpertInstallInput(
  expert: CatalogueExpertProfileFields,
): {
  name: string;
  title: string;
  roleDescription: string;
  systemPrompt: string;
} {
  return {
    name: expert.name,
    title: expert.name,
    roleDescription: expert.roleDescription,
    // The persona doubles as the standing instruction of a coworker created
    // without an endpoint; the profile store persists it trimmed, and only
    // when no managed Bot exists (the managed shape persists no prompt).
    systemPrompt: expert.roleDescription,
  };
}
