import { PROVENANCE_GUIDANCE } from "../../../shared/bot-prompt";
import { UNTRUSTED_GUIDANCE } from "../untrusted-content";

/*
 * ME02 (#474) T2: the trusted instruction composition for one execution.
 *
 * The two guidance texts are imported from their owning modules — the exact
 * constants the legacy built-in prompt uses — never re-authored here. The
 * caller passes the trusted parts in two groups: the head (the Bot's role,
 * the person's standing instructions) and the optional tail (the guidance
 * legacy places AFTER the two blocks — the granted-tool paragraph). The
 * composition always reads [head, PROVENANCE_GUIDANCE, UNTRUSTED_GUIDANCE,
 * tail] — the legacy built-in prompt's exact sequence (copilot.ts legacy
 * branch). The order is legacy-mandated; never re-weight it by moving the
 * guidance to the end.
 *
 * The guidance is inserted unconditionally, because a text-only Bot with no
 * tools has nothing to read and needs the provenance sentence most.
 *
 * The client cannot contribute to this composition: nothing here reads the
 * request's context, state or forwardedProps. The role is who the server says
 * the Bot is; everything else is envelope guidance around it.
 */
export function buildInstructions(
  parts: readonly string[],
  trailingParts: readonly string[] = [],
): string {
  const trusted = (group: readonly string[]): string[] =>
    group.filter((part) => typeof part === "string" && part.trim().length > 0);
  return [
    ...trusted(parts),
    PROVENANCE_GUIDANCE,
    UNTRUSTED_GUIDANCE,
    ...trusted(trailingParts),
  ].join("\n\n");
}
