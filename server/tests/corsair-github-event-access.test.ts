import { expect, test } from "bun:test";
import { createGithubEventReader } from "../src/plugins/corsair/event-reader";

const target = {
  token: "ghu_bound",
  userId: "12",
  installationId: "20",
  repositoryId: "30",
  nodeId: "repo-node",
};
const matchingInstallation = {
  id: 20,
  app_id: 9,
  suspended_at: null,
  permissions: { issues: "read" },
};

function reader({
  identityStatus = 200,
  userId = 12,
  repoStatus = 200,
  repositoryId = 30,
  issues = "read",
} = {}) {
  return createGithubEventReader(
    "9",
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe("Bearer ghu_bound");
        switch (new URL(request.url).pathname) {
          case "/user":
            return Response.json({ id: userId }, { status: identityStatus });
          case "/user/installations":
            return Response.json({
              total_count: 1,
              installations: [
                { ...matchingInstallation, permissions: { issues } },
              ],
            });
          case "/user/installations/20/repositories":
            return Response.json(
              {
                total_count: 1,
                repositories: [
                  { id: repositoryId, node_id: "repo-node", has_issues: true },
                ],
              },
              { status: repoStatus },
            );
          default:
            throw new Error(`Unexpected request: ${request.url}`);
        }
      },
      { preconnect: fetch.preconnect },
    ),
  );
}

test("checks the explicit GitHub user, App installation, and repository for Issues read access", async () => {
  expect(await reader()(target)).toBe("allowed");
  expect(await reader({ userId: 13 })(target)).toBe("denied");
  expect(await reader({ issues: "none" })(target)).toBe("denied");
  expect(await reader({ repositoryId: 31 })(target)).toBe("denied");
  expect(await reader({ identityStatus: 401 })(target)).toBe("denied");
  expect(await reader({ repoStatus: 429 })(target)).toBe("retry");
  expect(await reader({ repoStatus: 502 })(target)).toBe("retry");
});
