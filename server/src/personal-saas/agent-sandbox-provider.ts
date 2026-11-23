import { z } from "zod";
import {
  type AgentSandboxBinding,
  type AgentSandboxProvider,
  agentSandboxObservation,
} from "./agent-sandbox";
import type { ComputerLease } from "./workspace-computer";

const observationResponse = z.object({
  binding: z.object({
    workspaceId: z.uuid(),
    generation: z.uuid(),
    epoch: z.int().nonnegative(),
  }),
  observation: agentSandboxObservation,
});

/** Client for the pilot's lease and exit-evidence authority in front of Flash Edition. */
export function createAgentSandboxProvider(config: {
  url: string;
  token: string;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}): AgentSandboxProvider {
  async function call(
    binding: AgentSandboxBinding,
    method: "GET" | "POST" | "PUT" | "DELETE",
    expectedStatus: number,
    lease?: ComputerLease,
  ) {
    const url = new URL(
      `/v1/workspaces/${binding.workspaceId}/agent-sandboxes/${binding.generation}${method === "PUT" ? "/lease" : ""}`,
      config.url,
    );
    url.searchParams.set("epoch", String(binding.epoch));
    const response = await (config.fetch ?? fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(lease && { "Content-Type": "application/json" }),
      },
      body: lease && JSON.stringify(lease),
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (response.status !== expectedStatus)
      throw new Error("Agent Sandbox authority request unconfirmed");
    return response;
  }

  return {
    async start(binding, lease) {
      await call(binding, "POST", 202, lease);
    },
    async renew(binding, lease) {
      await call(binding, "PUT", 204, lease);
    },
    async destroy(binding) {
      await call(binding, "DELETE", 202);
    },
    async inspect(binding) {
      const response = await call(binding, "GET", 200);
      const result = observationResponse.parse(await response.json());
      if (
        result.binding.workspaceId !== binding.workspaceId ||
        result.binding.generation !== binding.generation ||
        result.binding.epoch !== binding.epoch
      )
        throw new Error("Agent Sandbox evidence belongs to another generation");
      return result.observation;
    },
  };
}
