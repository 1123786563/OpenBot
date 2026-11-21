import { describe, expect, test } from "bun:test";
import { createCorsairCloudClient } from "../src/plugins/corsair/cloud";

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

    await client.call("person-1", "notion", "pages.searchPage", { query: "OpenBot" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.corsair.cloud/demo/api/corsair/person-1/notion/call/pages.searchPage",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer ck_cloud_demo.slug",
    );
    expect(await requests[0]?.json()).toEqual({ args: { query: "OpenBot" } });
  });
});
