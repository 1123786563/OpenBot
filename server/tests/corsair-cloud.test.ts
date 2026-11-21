import { describe, expect, test } from "bun:test";
import { createCorsairCloudClient } from "../src/plugins/corsair/cloud";
import {
  callTool as callCorsairTool,
  listTools as listCorsairTools,
  useCorsairCloudClient,
} from "../src/plugins/corsair/transport";

describe("Corsair Cloud client", () => {
  test("derives the cloud endpoint and forwards tenant-scoped calls", async () => {
    const requests: Request[] = [];
    const client = createCorsairCloudClient({
      apiKey: "ck_cloud_demo.slug",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });

    await client.call("person-1", "notion", "pages.searchPage", {
      query: "OpenBot",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.corsair.cloud/demo/api/corsair/person-1/notion/call/pages.searchPage",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer ck_cloud_demo.slug",
    );
    expect(await requests[0]?.json()).toEqual({ args: { query: "OpenBot" } });
  });

  test("builds a fail-closed operation catalog for every runtime plugin", async () => {
    const client = createCorsairCloudClient({
      apiKey: "ck_cloud_demo.slug",
      fetch: async () =>
        Response.json({
          plugins: {
            slack: ["messages.send", "messages.list"],
            github: ["issues.create"],
          },
        }),
    });

    await expect(client.listOperations()).resolves.toEqual([
      {
        plugin: "github",
        operation: "issues.create",
        riskLevel: "write",
        approvalRequired: true,
      },
      {
        plugin: "slack",
        operation: "messages.list",
        riskLevel: "write",
        approvalRequired: true,
      },
      {
        plugin: "slack",
        operation: "messages.send",
        riskLevel: "write",
        approvalRequired: true,
      },
    ]);
  });

  test("calls tenant-scoped Corsair entity methods with positional arguments", async () => {
    const requests: Request[] = [];
    const client = createCorsairCloudClient({
      apiKey: "ck_cloud_demo.slug",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ data: [] });
      },
    });

    await client.callEntity("person-1", "github", "issues", "findMany", [
      { repository: "openbot" },
    ]);

    expect(requests[0]?.url).toBe(
      "https://api.corsair.cloud/demo/api/corsair/person-1/github/db/issues/findMany",
    );
    expect(await requests[0]?.json()).toEqual({
      args: [{ repository: "openbot" }],
    });
  });

  test("manages instance-scoped webhook endpoints through the v1 project API", async () => {
    const requests: Request[] = [];
    const client = createCorsairCloudClient({
      apiKey: "ck_cloud_demo.slug",
      instanceKey: "users",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ object: "webhook" });
      },
    });

    await client.createWebhook("github", "provider-secret");

    expect(requests[0]?.url).toBe(
      "https://api.corsair.cloud/v1/projects/demo/webhooks",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer ck_cloud_demo.slug",
    );
    expect(await requests[0]?.json()).toEqual({
      instance: "users",
      integration: "github",
      signing_secret: "provider-secret",
    });
  });

  test("publishes every runtime operation through the governed OpenBot transport", async () => {
    const requests: Request[] = [];
    const client = createCorsairCloudClient({
      apiKey: "ck_cloud_demo.slug",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/call"))
          return Response.json({ plugins: { github: ["issues.create"] } });
        return Response.json({ ok: true });
      },
    });

    useCorsairCloudClient(client);
    try {
      await expect(
        listCorsairTools({ url: "corsair://cloud" }),
      ).resolves.toEqual([
        expect.objectContaining({
          name: "github.issues.create",
          effect: "write",
        }),
      ]);
      await expect(
        callCorsairTool(
          { url: "corsair://cloud", actorId: "person-1" },
          "github.issues.create",
          { args: { title: "OpenBot" } },
        ),
      ).resolves.toMatchObject({ isError: false });
      expect(await requests.at(-1)?.json()).toEqual({
        args: { title: "OpenBot" },
      });
    } finally {
      useCorsairCloudClient(null);
    }
  });
});
