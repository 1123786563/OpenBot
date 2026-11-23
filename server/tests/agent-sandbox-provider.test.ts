import { expect, test } from "bun:test";
import { createAgentSandboxProvider } from "../src/personal-saas/agent-sandbox-provider";

const binding = {
  workspaceId: "fd677bcd-825f-4c30-b540-5b930d97f98a",
  generation: "cbc5bf2c-038a-4687-b956-388f9b3f620c",
  epoch: 4,
};

test("Agent Sandbox preserves the absolute lease and requires generation-bound exit evidence", async () => {
  const lease = { epoch: 4, issuedAt: 1_001, expiresAt: 16_001 };
  let observation: Response;
  const provider = createAgentSandboxProvider({
    url: "https://sandbox-authority.example",
    token: "fixture-token",
    async fetch(input, init) {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      expect(new URL(request.url).pathname).toBe(
        `/v1/workspaces/${binding.workspaceId}/agent-sandboxes/${binding.generation}${request.method === "PUT" ? "/lease" : ""}`,
      );
      expect(new URL(request.url).searchParams.get("epoch")).toBe("4");
      if (request.method === "POST" || request.method === "PUT") {
        expect(await request.json()).toEqual(lease);
        return new Response(null, {
          status: request.method === "POST" ? 202 : 204,
        });
      }
      if (request.method === "DELETE")
        return new Response(null, { status: 202 });
      return observation;
    },
  });
  await provider.start(binding, lease);
  await provider.renew(binding, lease);
  await provider.destroy(binding);
  observation = new Response(null, { status: 404 });
  await expect(provider.inspect(binding)).rejects.toThrow();
  observation = Response.json({
    binding: { ...binding, generation: crypto.randomUUID() },
    observation: { kind: "exited", exitedAt: 16_001, leaseExpiresAt: 16_001 },
  });
  await expect(provider.inspect(binding)).rejects.toThrow();
  observation = Response.json({
    binding,
    observation: { kind: "exited", exitedAt: 16_001, leaseExpiresAt: 16_001 },
  });
  expect(await provider.inspect(binding)).toEqual({
    kind: "exited",
    exitedAt: 16_001,
    leaseExpiresAt: 16_001,
  });
});
