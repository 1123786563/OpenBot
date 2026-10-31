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
 * The share itself could not be asked about: the network refused, or the server answered
 * something other than 404. This is NOT a verdict on the token — only a 404 is (see
 * {@link fetchPublicShare}) — so it may pass on retry and the page says so.
 */
export class ShareUnavailableError extends Error {}

/**
 * Resolve a token to its share view. A 404 is the uniform miss: wrong, expired, or revoked all
 * read the same, so nothing about which it was leaks. Everything else — offline, DNS, 429, a
 * 5xx — is {@link ShareUnavailableError} instead: it is a fact about the service, not the
 * token, and telling a visitor their link is dead when the server is down sends them to blame
 * the sender.
 */
export async function fetchPublicShare(
  token: string,
): Promise<PublicShareData> {
  const listResponse = await fetch(
    `/api/public/workshop/share/${encodeURIComponent(token)}/artifacts`,
    { credentials: "omit" },
  ).catch(() => {
    throw new ShareUnavailableError("share-unreachable");
  });
  if (!listResponse.ok) {
    if (listResponse.status === 404) {
      throw new Error("share-miss");
    }
    throw new ShareUnavailableError(`share-status-${listResponse.status}`);
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
