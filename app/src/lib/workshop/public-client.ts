import { useMutation } from "@tanstack/react-query";

/**
 * The share page's API surface: anonymous, token-keyed, read-only.
 *
 * Kept separate from the owner client (workshop/client.ts) on purpose — that file speaks for
 * a signed-in actor against /api/workshop/**; this one speaks for a TOKEN against
 * /api/public/workshop/**, and the two must never grow into each other's permissions.
 */
export type PublicShareData = {
  scope: "preview" | "preview_download";
  artifacts: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes: number;
    downloadUrl: string | null;
  }>;
  previewUrl: string | null;
};

/**
 * Resolve a token to its share view. Every failure — wrong, expired, revoked, offline —
 * rejects identically; the page renders one miss page for all of them (see its head).
 */
export async function fetchPublicShare(token: string): Promise<PublicShareData> {
  const listResponse = await fetch(
    `/api/public/workshop/share/${encodeURIComponent(token)}/artifacts`,
    { credentials: "omit" },
  );
  if (!listResponse.ok) {
    // 404, 429, anything else: the same rejection, the same page.
    throw new Error("share-miss");
  }
  const list = (await listResponse.json()) as {
    scope: "preview" | "preview_download";
    artifacts: Array<{
      id: string;
      name: string;
      type: string;
      sizeBytes: number;
      downloadUrl: string | null;
    }>;
  };
  // The preview is a static iframe against the same token; a 404 there simply hides it.
  const previewResponse = await fetch(
    `/api/public/workshop/share/${encodeURIComponent(token)}/preview/index.html`,
    { credentials: "omit" },
  );
  return {
    scope: list.scope,
    artifacts: list.artifacts,
    previewUrl: previewResponse.ok
      ? `/api/public/workshop/share/${encodeURIComponent(token)}/preview/index.html`
      : null,
  };
}

/** The namespace the public routes mount under (public-routes.ts's mount). */
export const workshopApi = {
  publicShare: fetchPublicShare,
  useReportShare: () =>
    useMutation({
      mutationFn: async (token: string) => {
        const response = await fetch(
          `/api/public/workshop/share/${encodeURIComponent(token)}/report`,
          { method: "POST", credentials: "omit" },
        );
        if (!response.ok) throw new Error("report-refused");
      },
    }),
};
