import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The model access confirmation flow (Bifrost #238, 04.5) as the settings page drives it.
 *
 * Two steps, never one: the preview shows what a one-time binding code would authorize and
 * consumes nothing, and the confirm — a separate, explicit press — is the only act that creates
 * the authorization. Neither takes a user or an identity from the page: the server takes the user
 * from the session and the identity from the code, so there is nothing here to get wrong.
 *
 * The person's own list and its revocation (Bifrost #240, 04.7) ride the same mount: the server
 * answers only the session's own rows, so the page carries no user field and could not get that
 * wrong either. A revocation invalidates the list, so the revoked state on screen is the
 * refetched server truth, not a local guess.
 */

/** What one live binding code would authorize: the whole of what the confirmation page shows. */
export type BindingPreview = {
  bot: { botId: string; displayName: string };
  externalIdentity: string;
  scope: string;
  expiresAt: string;
};

/**
 * The authorization a confirmation produced. A repeat confirmation of the same (you, Bot,
 * external identity) answers the grant that already is — the same grantId — rather than a second
 * one, so the page never needs to care whether it was the first press.
 */
export type AccessGrant = {
  grantId: string;
  userId: string;
  botId: string;
  externalIdentity: string;
  scope: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
};

export function previewBindingCodeMutationOptions() {
  return mutationOptions({
    mutationFn: (bindingCode: string): Promise<BindingPreview> =>
      client<BindingPreview>("/api/model-access/binding-preview", "preview", {
        method: "POST",
        body: { bindingCode },
        fallbackKey: "modelAccess.previewFailed",
      }),
  });
}

export function confirmAccessGrantMutationOptions() {
  return mutationOptions({
    mutationFn: (bindingCode: string): Promise<AccessGrant> =>
      client<AccessGrant>("/api/model-access/confirm", "accessGrant", {
        method: "POST",
        body: { bindingCode },
        fallbackKey: "modelAccess.confirmFailed",
      }),
  });
}

/**
 * One live key version of a grant, as the status page shows it (Bifrost 05.10): the version
 * number, the state the deployment believes, and the term the key was minted under. No secret
 * field exists in this shape — what the server never stores cannot reach the browser.
 */
export type AccessGrantKeyStatus = {
  credentialVersion: number;
  status: "active" | "expired" | "revoked";
  expiresAt: string | null;
};

/** One of the person's own grants as the list shows it: the grant, the Bot's display name, and
 * the live key versions the authorization still holds. */
export type AccessGrantSummary = AccessGrant & {
  botDisplayName: string;
  activeKeys: AccessGrantKeyStatus[];
};

export const accessGrantsKey = ["model-access", "grants"] as const;

/** The person's own authorizations, active and revoked — the server reports the state as it is. */
export function accessGrantsQueryOptions() {
  return queryOptions({
    queryKey: accessGrantsKey,
    queryFn: async (): Promise<AccessGrantSummary[]> =>
      client<AccessGrantSummary[]>("/api/model-access/grants", "grants", {
        fallbackKey: "modelAccess.loadFailed",
      }),
  });
}

/**
 * Revoke one of the person's own grants. The press carries only the grantId: whose grant it is
 * is the session's fact, and the server refuses what is not the caller's with the same silence
 * as what does not exist. The list is invalidated when the request settles either way, so the
 * screen never disagrees with the server about a grant's state for longer than one fetch.
 */
export function revokeAccessGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (grantId: string): Promise<AccessGrant> =>
      client<AccessGrant>(
        `/api/model-access/grants/${encodeURIComponent(grantId)}/revoke`,
        "accessGrant",
        { method: "POST", fallbackKey: "modelAccess.revokeFailed" },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: accessGrantsKey }),
  });
}

/**
 * Revoke EVERYTHING the person still holds for one Bot (Bifrost 05.10): every active grant for
 * that Bot, and through each grant's own revocation every key version it still holds. The press
 * carries only the botId — whose grants they are is the session's fact, and a Bot the person
 * never authorized answers an empty revoke, not an error. The list is invalidated on settle, so
 * the rows read revoked the moment the server has committed them.
 */
export function revokeAllAccessGrantsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      botId: string,
    ): Promise<{
      grants: AccessGrant[];
      revokedCount: number;
    }> =>
      client<{ grants: AccessGrant[]; revokedCount: number }>(
        "/api/model-access/grants/revoke-all",
        "grants",
        {
          method: "POST",
          body: { botId },
          fallbackKey: "modelAccess.revokeAllFailed",
        },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: accessGrantsKey }),
  });
}
