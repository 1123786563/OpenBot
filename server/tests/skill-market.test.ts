import { expect, test } from "bun:test";
import { createSkillMarketRoutes } from "../src/skill-market/routes";

const skill = {
  id: 2,
  namespace: "catalog",
  slug: "summarize",
  displayName: "Summarize",
  summary: "Summarize meeting notes",
  status: "ACTIVE",
  visibility: "NAMESPACE_ONLY",
  publishedVersion: { id: 3, version: "1.0.0", status: "PUBLISHED" },
};

test("signed-in users share published catalog previews while direct reads enforce scope and version status", async () => {
  const calls: string[] = [];
  const routes = createSkillMarketRoutes(
    async (context, next) => {
      if (!["one", "two"].includes(context.req.header("cookie") ?? "")) {
        return context.body(null, 401);
      }
      await next();
    },
    {
      baseUrl: "https://registry.example",
      namespace: "catalog",
      token: "read",
      confirmations: {},
    },
    async (url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer read",
      );
      const { pathname, searchParams } = new URL(url);
      calls.push(pathname);
      let data: unknown = skill;
      if (pathname === "/api/web/skills") {
        expect(searchParams.get("namespace")).toBe("catalog");
        data = {
          items: [skill, { ...skill, namespace: "outside" }],
          total: 2,
          page: 0,
          size: 20,
        };
      } else if (pathname.endsWith("/resolve")) {
        data = {
          skillId: 2,
          namespace: "catalog",
          slug: "summarize",
          version: "1.0.0",
          versionId: 3,
          fingerprint: "abc",
          matched: true,
        };
      } else if (pathname.endsWith("/files")) {
        data = [{ filePath: "SKILL.md" }];
      } else if (pathname.includes("/versions/")) {
        data = {
          id: 3,
          version: pathname.split("/").at(-1),
          status: pathname.endsWith("2.0.0") ? "PENDING_REVIEW" : "PUBLISHED",
          parsedMetadataJson: JSON.stringify({ body: "Summarize the notes." }),
        };
      }
      return Response.json({ code: 0, data });
    },
  );

  expect((await routes.request("/")).status).toBe(401);
  for (const cookie of ["one", "two"]) {
    const headers = { cookie };
    const found = await routes.request("/?q=summarize", { headers });
    expect(
      (await found.json()).items.map((item: { slug: string }) => item.slug),
    ).toEqual(["summarize"]);
    const response = await routes.request("/catalog/summarize/versions/1.0.0", {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: "1.0.0",
      instructions: "Summarize the notes.",
      reasons: ["The publisher has not declared OpenBot compatibility."],
    });
    expect(
      (await routes.request("/outside/summarize", { headers })).status,
    ).toBe(404);
    expect(
      (
        await routes.request("/outside/summarize/versions/1.0.0/download", {
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (await routes.request("/catalog/summarize/versions/2.0.0", { headers }))
        .status,
    ).toBe(404);
    expect(
      (
        await routes.request("/catalog/summarize/versions/2.0.0/download", {
          headers,
        })
      ).status,
    ).toBe(404);
  }
  expect(
    calls.some(
      (path) => path.includes("/outside/") || path.endsWith("/download"),
    ),
  ).toBe(false);
});

test("a compatibility confirmation applies only to the reviewed package fingerprint", async () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  let resolvedFingerprint = fingerprint;
  const routes = createSkillMarketRoutes(
    async (_context, next) => next(),
    {
      baseUrl: "https://registry.example",
      namespace: "catalog",
      token: "read",
      confirmations: {
        3: {
          slug: "summarize",
          version: "1.0.0",
          versionId: 3,
          reviewTaskId: 8,
          reviewerId: "catalog-reviewer",
          fingerprint,
        },
      },
    },
    async ({ pathname, searchParams }) => {
      let data: unknown = skill;
      if (pathname.endsWith("/resolve")) {
        const version = searchParams.get("version");
        data = {
          skillId: 2,
          namespace: "catalog",
          slug: "summarize",
          version,
          versionId: version === "1.0.0" ? 3 : 4,
          fingerprint: resolvedFingerprint,
          matched: null,
        };
      } else if (pathname.endsWith("/files")) {
        data = pathname.includes("/2.0.0/")
          ? [{ filePath: "SKILL.md" }, { filePath: "references/notes.md" }]
          : [{ filePath: "SKILL.md" }];
      } else if (pathname.includes("/versions/")) {
        const version = pathname.split("/").at(-1);
        data = {
          id: version === "1.0.0" ? 3 : 4,
          version,
          status: "PUBLISHED",
          parsedMetadataJson: JSON.stringify({
            body: "Summarize the notes.",
            frontmatter: {
              metadata: {
                "openbot-compatibility": {
                  scripts: version === "2.0.0",
                  supportingFiles: version === "2.0.0",
                  dedicatedRuntime: version === "2.0.0",
                },
              },
            },
          }),
        };
      }
      return Response.json({ code: 0, data });
    },
  );
  const first = await routes.request("/catalog/summarize/versions/1.0.0");
  expect(await first.json()).toMatchObject({ installable: true, reasons: [] });
  resolvedFingerprint = `sha256:${"b".repeat(64)}`;
  const changed = await routes.request("/catalog/summarize/versions/1.0.0");
  expect(await changed.json()).toMatchObject({
    installable: false,
    reasons: [
      "A reviewer has not confirmed OpenBot compatibility for this package.",
    ],
  });
  const next = await routes.request("/catalog/summarize/versions/2.0.0");
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({
    installable: false,
    instructions: "Summarize the notes.",
    reasons: [
      "This version requires scripts.",
      "This version requires supporting files.",
      "This version requires a dedicated runtime.",
      "A reviewer has not confirmed OpenBot compatibility for this package.",
      "Only a package containing a single SKILL.md file is supported.",
    ],
  });
});
