import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { registerIdentityProviderMutationOptions } from "@/lib/identity-providers/mutations";
import {
  type IdentityProvider,
  identityProviderListQueryOptions,
} from "@/lib/identity-providers/queries";

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

test("identity provider access denial clears the list across later failures", async () => {
  const originalFetch = global.fetch;
  let status = 503;
  global.fetch = Object.assign(
    async () => Response.json({ error: "Read failed" }, { status }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const cache = new QueryClient();
    const query = identityProviderListQueryOptions();
    cache.setQueryData<IdentityProvider[]>(query.queryKey, [
      {
        providerId: "workplace",
        protocol: "oidc",
        issuer: "https://login.example.test",
        domain: "example.test",
        registeredBy: "admin",
      },
    ]);
    const read = () => cache.fetchQuery({ ...query, retry: false });
    const count = () =>
      cache.getQueryData<IdentityProvider[]>(query.queryKey)?.length;
    await expect(read()).rejects.toThrow("Read failed");
    expect(count()).toBe(1);

    status = 403;
    await expect(read()).rejects.toThrow("Read failed");
    status = 503;
    await expect(read()).rejects.toThrow("Read failed");
    expect(count()).toBe(0);
  } finally {
    global.fetch = originalFetch;
  }
});
