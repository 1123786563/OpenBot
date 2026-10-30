import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import {
  startIdentityCenter,
  type IdentityCenterProcess,
} from "./support/identity-center";
import { identityCenter } from "../src/auth/identity-center-client";
import { createAuth } from "../src/auth/index";

/*
 * #714 OpenBot side: the RP entry points at a real, separately-deployed identity center.
 * The provider runs as its own Bun process (the same artifact openbot-identity ships),
 * so its availability here is process-level proof it does not ride on OpenBot.
 */

let center: IdentityCenterProcess;

beforeAll(async () => {
  center = await startIdentityCenter({ port: 4210 });
});

afterAll(async () => {
  await center.stop();
});

describe("identity-center-provider", () => {
  test("discovery 由独立进程提供，PKCE/S256 与登记端点齐备", async () => {
    const response = await fetch(
      `${center.issuer}/.well-known/openid-configuration`,
    );
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(center.issuer);
    expect(metadata.authorization_endpoint).toBe(
      `${center.issuer}/oauth2/authorize`,
    );
    expect(metadata.token_endpoint).toBe(`${center.issuer}/oauth2/token`);
    expect(metadata.jwks_uri).toBe(`${center.issuer}/oauth2/jwks`);
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.response_types_supported).toContain("code");
  });

  test("OpenBot RP 配置按登记回调与 issuer 生成", () => {
    const entry = identityCenter({
      clientId: center.clientId,
      clientSecret: center.clientSecret,
      issuer: center.issuer,
    });
    expect(entry.providerId).toBe("identity-center");
    expect(entry.accountIssuer).toBe(center.issuer);
    expect(entry.discoveryUrl).toBe(
      `${center.issuer}/.well-known/openid-configuration`,
    );
    expect(entry.scopes).toContain("openid");
  });

  test("the RP entry rides the real auth assembly, not a dead module (#714)", async () => {
    // sign-in/social separates wired from absent: a registered provider enters
    // the OAuth state write (500 on the empty test database), an unregistered
    // one is 404. Deleting the oidcProviders spread flips this to 404.
    process.env.EXPO_PROJECT_ID = "00000000-0000-0000-0000-000000000000";
    const base = {
      baseUrl: "https://openbot.test",
      secret: "test-secret-that-is-long-enough",
      trustedOrigins: ["https://app.openbot.test"],
      initialAdminEmails: [] as string[],
    };
    const probe = async (auth: ReturnType<typeof createAuth>) =>
      (
        await auth.handler(
          new Request("https://openbot.test/api/auth/sign-in/social", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              provider: "identity-center",
              callbackURL: "https://app.openbot.test/",
            }),
          }),
        )
      ).status;

    const wired = createAuth(
      {
        auth: {
          ...base,
          identityCenter: {
            clientId: center.clientId,
            clientSecret: center.clientSecret,
            issuer: center.issuer,
          },
        },
        keyEncryptionKey: "A".repeat(44),
      },
      {} as never,
    );
    expect(await probe(wired)).toBe(500);

    const withoutTheEntry = createAuth(
      { auth: { ...base }, keyEncryptionKey: "A".repeat(44) },
      {} as never,
    );
    expect(await probe(withoutTheEntry)).toBe(404);
  });

  test("未登记回调在授权端点被拒绝（400，不产生重定向）", async () => {
    const url = new URL(`${center.issuer}/oauth2/authorize`);
    url.searchParams.set("client_id", center.clientId);
    url.searchParams.set("redirect_uri", "https://attacker.test/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid");
    url.searchParams.set("code_challenge", "irrelevant-challenge");
    url.searchParams.set("code_challenge_method", "S256");
    const response = await fetch(url);
    expect(response.status).toBe(400);
  });

  test("JWKS 公开 RS256 公钥", async () => {
    const response = await fetch(`${center.issuer}/oauth2/jwks`);
    expect(response.status).toBe(200);
    const jwks = (await response.json()) as {
      keys: { kty: string; alg: string }[];
    };
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys[0].kty).toBe("RSA");
    expect(jwks.keys[0].alg).toBe("RS256");
  });
});
