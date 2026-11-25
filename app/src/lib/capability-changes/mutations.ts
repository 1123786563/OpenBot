import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import { enterpriseKeys } from "@/lib/enterprise/queries";
import { capabilityChangeKeys, type CapabilitySnapshot } from "./queries";
import type { CapabilityChange } from "./translate";

const FALLBACK = "Couldn't save the changes. Try again.";

/** Where saved changes came from: the sentence the model wrote them from. */
export type CapabilityChangeAuthoring = { source: "english"; text: string };

/**
 * Several switches in one save, with the sentence they were written from. The server refuses them,
 * saying what is wrong, unless every change checks, and saves them together or not at all.
 *
 * `basedOn` is the reading the impact was worked out from. The server compares it under its write
 * lock and answers 409 when another admin saved first, so a draft written against what somebody else
 * changed is refused instead of landing over it.
 */
export const saveCapabilityChangesMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: (variables: {
      changes: CapabilityChange[];
      basedOn?: CapabilitySnapshot;
      authoring?: CapabilityChangeAuthoring;
    }) =>
      client("/api/admin/enterprise/capabilities/batch", {
        method: "POST",
        body: variables,
        fallback: FALLBACK,
      }),
    /*
     * The switches are the Permissions page's, and a Bot's profile says whether its computer of its
     * own is in effect, decided from its owner's "Isolated Bots" switch, as the one-switch save does.
     *
     * On settled, never on success: the switches commit before their Audit rows, so a save that
     * answers with an Audit failure has still changed them. Re-reading on both outcomes is the only
     * way the screen shows what is in force, and it gives a refused save the latest preview to
     * decide on again. See `lib/plugins/mutations.ts` for the same rule.
     */
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: enterpriseKeys.all }),
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
        queryClient.invalidateQueries({ queryKey: capabilityChangeKeys.all }),
      ]),
  });
