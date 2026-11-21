import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { registerIdentityProviderMutationOptions } from "@/lib/identity-providers/mutations";

test("identity provider registration reports Better Auth's refusal reason", async () => {
  const originalFetch = global.fetch;
  const reason =
    "This providerId is reserved and cannot be used for an SSO provider";
  global.fetch = Object.assign(
    async () =>
      Response.json(
        { code: "UNPROCESSABLE_ENTITY", message: reason },
        { status: 422 },
      ),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const client = new QueryClient();
    const registration = client
      .getMutationCache()
      .build(client, registerIdentityProviderMutationOptions(client));
    await expect(
      registration.execute({
        protocol: "oidc",
        providerId: "google",
        domain: "example.test",
        issuer: "https://idp.example.test",
        clientId: "fixture",
        clientSecret: "fixture",
      }),
    ).rejects.toThrow(reason);
  } finally {
    global.fetch = originalFetch;
  }
});
