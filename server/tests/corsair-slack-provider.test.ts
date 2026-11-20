import { expect, test } from "bun:test";
import { createSlackPilotProvider } from "../src/plugins/corsair/slack/provider";

test("Slack OAuth selects only a rotating user credential and verifies its installation and subject", async () => {
  let returnedTeam = "T123";
  const provider = createSlackPilotProvider(
    {
      appId: "A123",
      teamId: "T123",
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://openbot.test/api/corsair/slack/callback",
    },
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/oauth.v2.access")) {
          expect(new URLSearchParams(await request.text()).get("code")).toBe(
            "code",
          );
          return Response.json({
            ok: true,
            app_id: "A123",
            team: { id: returnedTeam, name: "Fixture" },
            is_enterprise_install: false,
            access_token: "xoxb-ignore",
            authed_user: {
              id: "U123",
              token_type: "user",
              access_token: "xoxe.xoxp-user",
              refresh_token: "xoxe-refresh",
              expires_in: 3600,
              scope: "chat:write,channels:read,groups:read",
            },
          });
        }
        expect(request.url).toBe("https://slack.com/api/auth.test");
        expect(request.headers.get("authorization")).toBe(
          "Bearer xoxe.xoxp-user",
        );
        return Response.json({
          ok: true,
          user_id: "U123",
          team_id: "T123",
          user: "Taylor",
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const url = new URL(provider.authorizationUrl("state"));
  expect(url.searchParams.get("scope")).toBeNull();
  expect(url.searchParams.get("user_scope")?.split(",").sort()).toEqual([
    "channels:read",
    "chat:write",
    "groups:read",
  ]);
  expect(url.searchParams.get("team")).toBe("T123");
  expect(await provider.exchange("code")).toMatchObject({
    userId: "U123",
    label: "Taylor",
    accessToken: "xoxe.xoxp-user",
  });
  returnedTeam = "T999";
  await expect(provider.exchange("code")).rejects.toThrow();
});

test("a refreshed token must authenticate as the same Slack user within the installation", async () => {
  const provider = createSlackPilotProvider(
    {
      appId: "A123",
      teamId: "T123",
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://openbot.test/api/corsair/slack/callback",
    },
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/oauth.v2.access")) {
          const form = new URLSearchParams(await request.text());
          expect(form.get("grant_type")).toBe("refresh_token");
          expect(form.get("refresh_token")).toBe("xoxe-old");
          return Response.json({
            ok: true,
            app_id: "A123",
            team: { id: "T123" },
            is_enterprise_install: false,
            token_type: "user",
            access_token: "xoxe.xoxp-new",
            refresh_token: "xoxe-new",
            expires_in: 3600,
            scope: "chat:write,channels:read,groups:read",
          });
        }
        expect(request.headers.get("authorization")).toBe(
          "Bearer xoxe.xoxp-new",
        );
        return Response.json({
          ok: true,
          user_id: "U123",
          team_id: "T123",
          user: "Taylor",
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  expect(await provider.refresh("xoxe-old", "U123")).toMatchObject({
    accessToken: "xoxe.xoxp-new",
    refreshToken: "xoxe-new",
  });
  await expect(provider.refresh("xoxe-old", "U456")).rejects.toThrow();
});
