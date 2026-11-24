import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { ClientError, client } from "@/lib/client";
import { reviewerGuidanceKeys } from "./queries";

const FALLBACK = "The guidance for auto-review couldn't be saved.";

const invalidateGuidance = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: reviewerGuidanceKeys.all });

export const isGuidanceConflict = (error: unknown) =>
  error instanceof ClientError && error.status === 409;

const refreshOnConflict = (queryClient: QueryClient) => (error: Error) => {
  if (isGuidanceConflict(error)) return invalidateGuidance(queryClient);
};

/**
 * Save the guidance. The server reads the words again and refuses them, saying why, unless they still
 * read as guidance; then it records the save on the trail with the words and the reading.
 */
export const saveReviewerGuidanceMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (input: { text: string; basedOn: string | null }) =>
      client("/api/approvals/team/guidance", {
        method: "PUT",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateGuidance(queryClient),
    onError: refreshOnConflict(queryClient),
  });

/** Remove the guidance, so the reviewer reads only its own instructions again. Recorded on the trail. */
export const removeReviewerGuidanceMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: (basedOn: string) =>
      client("/api/approvals/team/guidance", {
        method: "DELETE",
        body: { basedOn },
        fallback: "The guidance for auto-review couldn't be removed.",
      }),
    onSuccess: () => invalidateGuidance(queryClient),
    onError: refreshOnConflict(queryClient),
  });
