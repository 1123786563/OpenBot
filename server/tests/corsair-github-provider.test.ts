import { expect, test } from "bun:test";
import { createGithubPilotProvider } from "../src/plugins/corsair/github";

test("the pinned Corsair SDK sends a single issue write as the supplied GitHub App user", async () => {
  let githubStatus = 200;
  const writes: {
    url: string;
    authorization: string | null;
    redirect: RequestRedirect;
    body: unknown;
  }[] = [];
  const fakeFetch: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      writes.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        redirect: request.redirect,
        body: await request.json(),
      });
      if (githubStatus !== 200)
        return new Response(null, { status: githubStatus });
      return Response.json({
        data: {
          createIssue: {
            issue: {
              databaseId: 901,
              number: 7,
              repository: { id: "R_pilot" },
              url: "https://github.com/acme/pilot/issues/7",
              author: { databaseId: 12, login: "octocat" },
            },
          },
        },
      });
    },
    { preconnect: fetch.preconnect },
  );
  const provider = createGithubPilotProvider(
    {
      appId: "9",
      clientId: "fixture",
      clientSecret: "fixture",
      redirectUri: "https://openbot.test/api/corsair/github/callback",
    },
    fakeFetch,
  );
  await expect(
    provider.createIssue({
      token: "ghu_fixture",
      repositoryNodeId: "R_pilot",
      title: "Pilot evidence",
    }),
  ).resolves.toMatchObject({ number: 7, user: { id: 12 } });
  expect(writes).toEqual([
    {
      url: "https://api.github.com/graphql",
      authorization: "Bearer ghu_fixture",
      redirect: "error",
      body: {
        query: expect.stringContaining("createIssue"),
        variables: {
          input: { repositoryId: "R_pilot", title: "Pilot evidence" },
        },
      },
    },
  ]);
  githubStatus = 401;
  await expect(
    provider.createIssue({
      token: "ghu_fixture",
      repositoryNodeId: "R_pilot",
      title: "Refused",
    }),
  ).rejects.toThrow();
  expect(writes).toHaveLength(2);
});
