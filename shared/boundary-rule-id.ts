import { sha256HexSync } from "./recorder-masking";

export const boundaryRuleIdPattern =
  /^r-(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** Existing rules keep a reproducible link until their identifier is saved with the label. */
export function boundaryRuleId(rule: string, savedId?: string): string {
  return savedId ?? `r-${sha256HexSync(rule)}`;
}
