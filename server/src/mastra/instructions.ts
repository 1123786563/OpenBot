import { PROVENANCE_GUIDANCE } from "../../../shared/bot-prompt";
import { UNTRUSTED_GUIDANCE } from "../untrusted-content";

/**
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
 *
 * ME07 (#479): the optional `memoryBlock` composes LAST — after the tail.
 * The legacy engine injected the personal-memory context as the head of the
 * run's message list (PersonalMemoryMiddleware), which lands after every
 * system-prompt part and before the conversation; on this engine the same
 * relative position is the end of the composed prompt. The block arrives
 * already rendered by the #395 consumer (`renderPersonalMemoryContext`), so
 * this composition never re-authors its untrusted-data discipline; an empty
 * string composes nothing, exactly like the legacy path that injected no
 * message when the person had no effective memory.
 */
export function buildInstructions(
  parts: readonly string[],
  trailingParts: readonly string[] = [],
  memoryBlock?: string,
): string {
  const trusted = (group: readonly string[]): string[] =>
    group.filter((part) => typeof part === "string" && part.trim().length > 0);
  return [
    ...trusted(parts),
    PROVENANCE_GUIDANCE,
    UNTRUSTED_GUIDANCE,
    ...trusted(trailingParts),
    ...(memoryBlock && memoryBlock.trim().length > 0 ? [memoryBlock] : []),
  ].join("\n\n");
}
