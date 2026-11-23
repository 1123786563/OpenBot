import { expect, test } from "bun:test";
import { createFlashSandboxApi } from "../src/personal-saas/flash-sandbox-api";

const binding = {
  workspaceId: "fd677bcd-825f-4c30-b540-5b930d97f98a",
  generation: "cbc5bf2c-038a-4687-b956-388f9b3f620c",
  epoch: 4,
};
const metadata = {
  openbotWorkspace: binding.workspaceId,
  openbotGeneration: binding.generation,
  openbotEpoch: String(binding.epoch),
};
const sandboxId = "sandbox-fixture";
const template = "template-fixture";
const domain = "cn-hangzhou.sandbox.aliyuncs.com";
const storage = {
  accessPointId: "ap-fixture",
  fileSystemId: "31a8e4",
  accessPointDomain: "ap-fixture.31a8e4-fixture.cn-hangzhou.nas.aliyuncs.com",
  roleArn: "acs:ram::1234567890123456:role/openbot-fixture",
  storageEgressIps: ["10.12.0.2", "10.12.0.3"],
  vpcId: "vpc-fixture",
  vSwitchId: "vsw-fixture",
  securityGroupId: "sg-fixture",
};
const fixture = {
  sandboxID: sandboxId,
  templateID: template,
  envdVersion: "0.4.0",
  envdAccessToken: "fixture-envd",
  trafficAccessToken: "fixture-traffic",
  domain,
};

test("Flash creates a private instance once and independently verifies inventory after delete", async () => {
  let inventory = true;
  let inventoryHasMetadata = true;
  let info = true;
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      expect(request.headers.get("x-api-key")).toBe("fixture-api-key");
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/sandboxes" && request.method === "POST") {
        const create = await request.json();
        expect(create).toMatchObject({
          templateID: template,
          metadata,
          secure: true,
          autoPause: false,
          autoResume: { enabled: false },
          allow_internet_access: false,
          network: {
            allowPublicTraffic: false,
            allowOut: ["10.12.0.2", "10.12.0.3"],
          },
          timeout: 300,
        });
        expect(
          JSON.parse(create.metadata["fc.sandbox.storage.agenticfs"]),
        ).toEqual({
          userID: 10001,
          groupID: 10001,
          mountPoints: [
            {
              serverAddr:
                "ap-fixture.31a8e4-fixture.cn-hangzhou.nas.aliyuncs.com:/",
              mountDir: "/mnt/openbot-workspace",
            },
          ],
        });
        expect(JSON.parse(create.metadata["fc.sandbox.network.vpc"])).toEqual({
          vpcId: "vpc-fixture",
          vSwitchIds: ["vsw-fixture"],
          securityGroupId: "sg-fixture",
        });
        expect(create.metadata["fc.sandbox.auth.role"]).toBe(storage.roleArn);
        expect(create).not.toHaveProperty("envVars");
        return Response.json(fixture, { status: 201 });
      }
      if (url.pathname === `/sandboxes/${sandboxId}`) {
        if (request.method === "DELETE")
          return new Response(null, { status: 204 });
        return info
          ? Response.json({ ...fixture, metadata })
          : Response.json({ code: 404 }, { status: 404 });
      }
      if (url.pathname === "/v2/sandboxes") {
        expect(url.searchParams.get("metadata")).toContain(binding.generation);
        expect(url.searchParams.get("state")).toBe("running,paused");
        return Response.json(
          inventory
            ? [
                {
                  ...fixture,
                  ...(inventoryHasMetadata && { metadata }),
                  state: "running",
                },
              ]
            : [],
        );
      }
      return new Response(null, { status: 500 });
    },
  });
  try {
    const api = createFlashSandboxApi({
      apiKey: "fixture-api-key",
      apiUrl: server.url.origin,
      domain,
      template,
    });
    expect(() =>
      api.workspaceMount({
        ...storage,
        accessPointDomain: `${storage.accessPointDomain}:/folder`,
      }),
    ).toThrow();
    expect(() =>
      api.workspaceMount({ ...storage, accessPointId: "ap-other" }),
    ).toThrow();
    expect(() =>
      api.workspaceMount({ ...storage, storageEgressIps: ["100.100.100.200"] }),
    ).toThrow();
    const allocation = await api.create(binding, api.workspaceMount(storage));
    expect(allocation.id).toBe(sandboxId);
    expect(await api.discover(binding)).toEqual([sandboxId]);
    await api.delete(sandboxId);
    expect(await api.isDestroyed(binding, sandboxId)).toBe(false);
    info = false;
    expect(await api.isDestroyed(binding, sandboxId)).toBe(false);
    inventoryHasMetadata = false;
    expect(await api.isDestroyed(binding, sandboxId)).toBe(false);
    inventory = false;
    expect(await api.isDestroyed(binding, sandboxId)).toBe(true);
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST /sandboxes",
    ]);
  } finally {
    server.stop(true);
  }
});
