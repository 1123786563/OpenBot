import { type paths, Sandbox } from "e2b";
import { z } from "zod";
import type { AgentSandboxBinding } from "./agent-sandbox";

const sandboxId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const detail = z.object({
  sandboxID: sandboxId,
  templateID: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
});
export const flashConnection = z.object({
  envdVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
  envdAccessToken: z.string().min(1),
  trafficAccessToken: z.string().min(1),
});
export type FlashConnection = z.infer<typeof flashConnection>;
type CreateRequest =
  paths["/sandboxes"]["post"]["requestBody"]["content"]["application/json"];

type FlashConfig = {
  apiKey: string;
  apiUrl: string;
  domain: string;
  template: string;
};

function metadata(binding: AgentSandboxBinding) {
  return {
    openbotWorkspace: binding.workspaceId,
    openbotGeneration: binding.generation,
    openbotEpoch: String(binding.epoch),
  };
}

export function createFlashSandboxApi(config: FlashConfig) {
  function request(
    url: URL,
    method: string,
    {
      body,
      signal = AbortSignal.timeout(4_000),
    }: { body?: CreateRequest; signal?: AbortSignal } = {},
  ) {
    return fetch(url, {
      method,
      headers: {
        "X-API-KEY": config.apiKey,
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
      redirect: "error",
      signal,
    });
  }

  function instanceUrl(id: string) {
    return new URL(`/sandboxes/${sandboxId.parse(id)}`, config.apiUrl);
  }

  async function inventory(binding: AgentSandboxBinding) {
    const entries: z.infer<typeof detail>[] = [];
    const signal = AbortSignal.timeout(4_000);
    const seenPages = new Set<string>();
    const url = new URL("/v2/sandboxes", config.apiUrl);
    url.searchParams.set(
      "metadata",
      new URLSearchParams(metadata(binding)).toString(),
    );
    url.searchParams.set("state", "running,paused");
    url.searchParams.set("limit", "20");

    while (true) {
      const response = await request(url, "GET", { signal });
      if (!response.ok) throw new Error("Flash inventory unavailable");
      entries.push(...detail.array().parse(await response.json()));
      const token = response.headers.get("x-next-token");
      if (!token) return entries;
      if (seenPages.has(token) || seenPages.size >= 10)
        throw new Error("Flash inventory incomplete");
      seenPages.add(token);
      url.searchParams.set("nextToken", token);
    }
  }

  function matchesBinding(
    entry: z.infer<typeof detail>,
    binding: AgentSandboxBinding,
  ) {
    return Object.entries(metadata(binding)).every(
      ([key, value]) => entry.metadata?.[key] === value,
    );
  }

  return {
    async discover(binding: AgentSandboxBinding) {
      const entries = await inventory(binding);
      return [
        ...new Set(
          entries
            .filter((entry) => matchesBinding(entry, binding))
            .map((entry) => entry.sandboxID),
        ),
      ];
    },
    async create(binding: AgentSandboxBinding) {
      // One POST per generation. A lost response is resolved from metadata.
      const response = await request(
        new URL("/sandboxes", config.apiUrl),
        "POST",
        {
          body: {
            templateID: config.template,
            metadata: metadata(binding),
            secure: true,
            autoPause: false,
            autoResume: { enabled: false },
            allow_internet_access: false,
            network: { allowPublicTraffic: false },
            timeout: 300,
          },
        },
      );
      if (response.status !== 201)
        throw new Error("Flash allocation unconfirmed");
      const data: unknown = await response.json();
      const instance = detail
        .extend({ domain: z.string().nullish() })
        .parse(data);
      const connection = flashConnection.safeParse(data);
      return {
        id: instance.sandboxID,
        connection:
          instance.templateID === config.template &&
          (!instance.domain || instance.domain === config.domain) &&
          connection.success
            ? connection.data
            : undefined,
      };
    },
    async delete(id: string) {
      const response = await request(instanceUrl(id), "DELETE");
      if (![202, 204, 404].includes(response.status))
        throw new Error("Flash deletion unconfirmed");
    },
    async isDestroyed(binding: AgentSandboxBinding, id: string) {
      const response = await request(instanceUrl(id), "GET");
      // An error payload from the Flash API and a separate complete inventory
      // lookup are required. A proxy's generic 404 is insufficient.
      if (response.status === 404) {
        const missing = z
          .object({ code: z.literal(404) })
          .safeParse(await response.json());
        if (!missing.success) throw new Error("Flash detail unavailable");
        const entries = await inventory(binding);
        return !entries.some(
          (entry) => entry.sandboxID === id || matchesBinding(entry, binding),
        );
      }
      if (!response.ok) throw new Error("Flash detail unavailable");
      if (detail.parse(await response.json()).sandboxID !== id)
        throw new Error("Flash detail belongs to another instance");
      return false;
    },
    runtime(id: string, connection: FlashConnection) {
      // Attach to envd using create-time credentials. Sandbox.connect would
      // resume a paused instance and request a fresh provider timeout.
      return new Sandbox({
        sandboxId: sandboxId.parse(id),
        sandboxDomain: config.domain,
        sandboxUrl: `https://49983-${id}.${config.domain}`,
        domain: config.domain,
        debug: false,
        requestTimeoutMs: 3_000,
        ...connection,
      });
    },
    address(id: string) {
      return `https://4100-${sandboxId.parse(id)}.${config.domain}`;
    },
  };
}
