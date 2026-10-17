import { mutationOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The model access confirmation flow (Bifrost #238, 04.5) as the settings page drives it.
 *
 * Two steps, never one: the preview shows what a one-time binding code would authorize and
 * consumes nothing, and the confirm — a separate, explicit press — is the only act that creates
 * the authorization. Neither takes a user or an identity from the page: the server takes the user
 * from the session and the identity from the code, so there is nothing here to get wrong.
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
