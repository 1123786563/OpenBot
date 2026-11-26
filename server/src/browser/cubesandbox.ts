import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ComputerSeat } from "../computer/computer-key";
import {
  type EgressPolicy,
  pushEgressPolicy,
} from "../computer/policy-network";
import { ProviderError } from "../computer/provider";
import type { ComputerStatus } from "../computer/schema";
import { checkComputerAddress } from "../computer/target";
import { personBrowserId } from "./person";

export type BrowserProvider = {
  serves(seat: ComputerSeat): boolean;
  locate(seat: ComputerSeat): Promise<string>;
  status(seat: ComputerSeat): Promise<ComputerStatus>;
  tokenFor(seat: ComputerSeat): string;
};

const sandboxSchema = z.object({
  sandboxID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/i),
  state: z.string().optional(),
  metadata: z.record(z.string(), z.string()).nullish(),
  envdAccessToken: z.string().min(1).nullish(),
});
const volumesSchema = z.record(z.string().min(1), z.string().trim().min(1));
const MOUNT = "/profiles";
const LABEL = "openbotBrowser";

export function cubeSandboxBrowsers(
  env: Record<string, string | undefined>,
  options: {
    policyForBot: (botId: string) => Promise<EgressPolicy | undefined>;
    serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>;
  },
): BrowserProvider | undefined {
  const bindings = env.OPENBOT_CUBE_BROWSER_VOLUMES?.trim();
  if (!bindings) return undefined;

  const volumes = new Map(
    Object.entries(volumesSchema.parse(JSON.parse(bindings))),
  );
  if (volumes.size === 0) return undefined;
  if (new Set(volumes.values()).size !== volumes.size)
    throw new Error(
      "CubeSandbox browser volumes must be dedicated to one person each.",
    );

  const api = env.OPENBOT_CUBE_API_URL?.trim().replace(/\/$/, "");
  const apiKey = env.OPENBOT_CUBE_API_KEY?.trim();
  const templateID = env.OPENBOT_CUBE_BROWSER_TEMPLATE?.trim();
  const address = env.OPENBOT_CUBE_BROWSER_URL?.trim();
  const envd = env.OPENBOT_CUBE_ENVD_URL?.trim();
  const secret = env.OPENBOT_CUBE_BROWSER_SECRET?.trim();
  if (
    !api ||
    !templateID ||
    !address?.includes("{{sandbox}}") ||
    !envd?.includes("{{sandbox}}") ||
    !secret ||
    secret.length < 32
  )
    throw new Error(
      "CubeSandbox browser pilot requires an API URL, template, browser and envd URL patterns and a dedicated secret of at least 32 characters.",
    );

  const dataAddress = (pattern: string, id: string) => {
    const url = checkComputerAddress(pattern.replaceAll("{{sandbox}}", id));
    if (!url.allowed)
      throw new ProviderError("Invalid CubeSandbox browser endpoint.");
    const parsed = new URL(url.url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new ProviderError("Invalid CubeSandbox browser endpoint.");
    return url.url.replace(/\/$/, "");
  };
  dataAddress(address, "validation");
  dataAddress(envd, "validation");
  const apiUrl = new URL(api);
  if (
    !["http:", "https:"].includes(apiUrl.protocol) ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  )
    throw new Error("Invalid CubeSandbox API URL.");

  const owners = new Map(
    [...volumes.keys()].map((id) => [personBrowserId(id), id]),
  );
  const personOf = (seat: ComputerSeat) =>
    seat.key.kind === "person" ? seat.key.personId : owners.get(seat.key.botId);
  const bindingFor = (seat: ComputerSeat) => {
    const person = personOf(seat);
    const volume = person && volumes.get(person);
    if (!person || !volume)
      throw new ProviderError(
        "This person is not enrolled in the CubeSandbox browser pilot.",
      );
    const logicalId = createHmac("sha256", secret)
      .update("browser-id:" + person)
      .digest("hex");
    const token = createHmac("sha256", secret)
      .update("browser-token:" + person)
      .digest("hex");
    return { person, volume, logicalId, token };
  };

  async function cube(path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await fetch(api + path, {
        ...(body === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(body) }),
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new ProviderError(
          `CubeSandbox browser API answered ${response.status}.`,
        );
      return await response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "The CubeSandbox browser API could not be reached.",
      );
    }
  }

  async function find(logicalId: string) {
    const query = new URLSearchParams({ metadata: `${LABEL}=${logicalId}` });
    const response = await cube(`/sandboxes?${query}`);
    const result = sandboxSchema.array().safeParse(response);
    if (!result.success)
      throw new ProviderError("Invalid CubeSandbox browser inventory.");
    const matches = result.data.filter(
      (entry) => entry.metadata?.[LABEL] === logicalId,
    );
    if (matches.length > 1)
      throw new ProviderError(
        "Multiple CubeSandbox instances claim this personal computer.",
      );
    return matches[0];
  }

  async function ready(base: string, seat: ComputerSeat, token: string) {
    try {
      const response = await fetch(base + "/control", {
        headers: {
          "x-openbot-bot-id": seat.botId,
          "x-openbot-computer-token": token,
        },
        redirect: "error",
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    serves: (seat) => volumes.has(personOf(seat) ?? ""),
    tokenFor: (seat) => bindingFor(seat).token,
    async locate(seat) {
      const { person, volume, logicalId, token } = bindingFor(seat);
      const base = await options.serialize(logicalId, async () => {
        let sandbox = await find(logicalId);
        if (sandbox && sandbox.state !== "running")
          throw new ProviderError(
            "The CubeSandbox browser instance is not running.",
          );
        if (!sandbox) {
          const created = sandboxSchema.safeParse(
            await cube("/sandboxes", {
              templateID,
              metadata: { [LABEL]: logicalId },
              volumeMounts: [{ name: volume, path: MOUNT, readOnly: false }],
              envVars: {
                COMPUTER_PERSON_ID: person,
                COMPUTER_TOKEN: token,
                OPENBOT_BROWSER_ONLY: "on",
                PROFILES_DIR: MOUNT,
                PORT: "4100",
                PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
                OPENBOT_RECORDER_DIR: "/recorder",
                WORKSPACE_DIR: "/workspace",
              },
              secure: true,
              network: { allowPublicTraffic: false },
              restartPolicy: "Never",
              timeout: -1,
            }),
          );
          if (!created.success)
            throw new ProviderError("Invalid CubeSandbox browser instance.");
          sandbox = created.data;
        }
        const base = dataAddress(address, sandbox.sandboxID);
        if (await ready(base, seat, token)) return base;

        await startBrowser(
          dataAddress(envd, sandbox.sandboxID),
          sandbox.envdAccessToken,
        );

        for (let attempt = 0; attempt < 10; attempt++) {
          if (await ready(base, seat, token)) return base;
          await Bun.sleep(400);
        }
        throw new ProviderError(
          "The CubeSandbox browser did not become ready.",
        );
      });
      const policy = await options.policyForBot(seat.botId);
      if (policy)
        await pushEgressPolicy(base, seat.botId, policy, {
          token,
          redirect: "error",
        });
      return base;
    },
    async status(seat) {
      const { logicalId } = bindingFor(seat);
      try {
        const sandbox = await find(logicalId);
        const state: ComputerStatus["state"] = sandbox
          ? sandbox.state === "running"
            ? "ready"
            : "starting"
          : "absent";
        return { botId: seat.botId, state };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        return {
          botId: seat.botId,
          state: "unreachable",
          reason: error.message,
        };
      }
    },
  };
}

// Cube passes create-time environment variables to envd. Start the browser through
// envd so it inherits them. flock makes retries safe if a response was lost.
async function startBrowser(
  base: string,
  accessToken?: string | null,
): Promise<void> {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      process: {
        cmd: "/usr/bin/flock",
        args: [
          "-n",
          "-F",
          "/run/openbot-browser.lock",
          "/usr/local/bin/bun",
          "/app/src/index.ts",
        ],
        cwd: "/app",
      },
      tag: "openbot-browser",
      stdin: false,
    }),
  );
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);

  try {
    const response = await fetch(base + "/process.Process/Start", {
      method: "POST",
      headers: {
        authorization: "Basic " + btoa("root:"),
        ...(accessToken ? { "x-access-token": accessToken } : {}),
        "content-type": "application/connect+json",
        "connect-protocol-version": "1",
      },
      body: frame,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || !response.body)
      throw new ProviderError(
        `CubeSandbox browser startup answered ${response.status}.`,
      );
    // Read the initial reply. The process outlives its Connect subscriber.
    const reader = response.body.getReader();
    try {
      await reader.read();
    } finally {
      await reader.cancel();
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("CubeSandbox browser startup did not answer.");
  }
}
