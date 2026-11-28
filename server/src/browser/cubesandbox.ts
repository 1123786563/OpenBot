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
  stop?(seat: ComputerSeat): Promise<boolean>;
  reset?(seat: ComputerSeat): Promise<void>;
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
/** On each sandbox made to pause when idle. One without it was made before OpenBot asked for that, and Cube destroys
 * it once an idle window runs out. */
const PAUSES = "openbotPauses";
/** How long a sandbox goes without a request before Cube pauses it: the house's idle window for a computer
 * (`COMPUTER_BROWSER_IDLE_MS`, `COMPUTER_SANDBOX_IDLE_AFTER`). Paused, it holds no CPU or memory, and the next
 * request resumes it. */
const IDLE_SECONDS = 30 * 60;
/** How often OpenBot starts that window again for a sandbox it is still being asked for. */
const RENEW_EVERY_MS = IDLE_SECONDS * 500;

type Sandbox = z.infer<typeof sandboxSchema>;

export function cubeBrowserVolumes(env: Record<string, string | undefined>) {
  const bindings = env.OPENBOT_CUBE_BROWSER_VOLUMES?.trim();
  return new Map(
    bindings ? Object.entries(volumesSchema.parse(JSON.parse(bindings))) : [],
  );
}

export function cubeSandboxBrowsers(
  env: Record<string, string | undefined>,
  options: {
    policyForBot: (botId: string) => Promise<EgressPolicy | undefined>;
    serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>;
  },
): BrowserProvider | undefined {
  const volumes = cubeBrowserVolumes(env);
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
  /** Nothing runs in a sandbox Cube has paused or is pausing, and reaching it would wake it. */
  const asleep = (sandbox?: Sandbox) =>
    sandbox?.state === "paused" || sandbox?.state === "pausing";
  const pauses = (sandbox: Sandbox) => sandbox.metadata?.[PAUSES] === "on";
  /** When OpenBot may next ask Cube to start each sandbox's idle window again. */
  const renewAt = new Map<string, number>();
  const refused = (status: number) =>
    new ProviderError(`CubeSandbox browser API answered ${status}.`);

  async function call(path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(api + path, {
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
    } catch {
      throw new ProviderError(
        "The CubeSandbox browser API could not be reached.",
      );
    }
  }

  /** `call` for a request Cube answers without a body: its status. */
  async function act(path: string, body?: unknown): Promise<number> {
    const response = await call(path, body);
    await response.body?.cancel();
    return response.status;
  }

  /** `call`, answered with a JSON body. */
  async function cube(path: string, body?: unknown): Promise<unknown> {
    const response = await call(path, body);
    try {
      if (!response.ok) throw refused(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "The CubeSandbox browser API could not be reached.",
      );
    }
  }

  /**
   * Starts a sandbox's idle window again from now, at most once every half window. Cube counts a request as activity
   * only where it enters through its own proxy, and the pilot's ingress sits on the node's port mappings: without
   * this, a browser in use would be paused one window after it was made or resumed. A refusal costs the request
   * nothing, and is tried again a minute on.
   * shortcut: a use is not told apart from the state every screen polls, so a browser stays awake while OpenBot is
   * in view, idle or not; upgrade when a deployment needs idle-but-watched browsers released too.
   */
  async function keepAwake(sandbox: Sandbox) {
    if (!pauses(sandbox)) return;
    const now = Date.now();
    if (now < (renewAt.get(sandbox.sandboxID) ?? 0)) return;
    let next = 60_000;
    try {
      if (
        (await act(`/sandboxes/${sandbox.sandboxID}/timeout`, {
          timeout: IDLE_SECONDS,
        })) < 400
      )
        next = RENEW_EVERY_MS;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
    }
    renewAt.set(sandbox.sandboxID, Date.now() + next);
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

  async function lifecycle(
    base: string,
    path: string,
    seat: ComputerSeat,
    token: string,
  ) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "x-openbot-bot-id": seat.botId,
        "x-openbot-computer-token": token,
      },
      redirect: "error",
      signal: AbortSignal.timeout(50_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(
        `CubeSandbox browser action answered ${response.status}.`,
      );
    }
    return z
      .object({ wasRunning: z.boolean().optional() })
      .parse(await response.json());
  }

  const browser: BrowserProvider = {
    async stop(seat) {
      const { logicalId, token } = bindingFor(seat);
      return options.serialize(logicalId, async () => {
        const sandbox = await find(logicalId);
        // Paused already, or pausing: no browser runs there, and reaching it would wake it.
        if (!sandbox || asleep(sandbox)) return false;
        const base = dataAddress(address, sandbox.sandboxID);
        const wasRunning =
          (await lifecycle(base, "/computers/stop-all", seat, token))
            .wasRunning === true;
        // A sandbox holds its memory while it runs, browsers or not.
        const status = await act(`/sandboxes/${sandbox.sandboxID}/pause`, {});
        // Cube refuses one that is pausing already, by its own idle timer or an operator's hand: no less stopped.
        if (status >= 400 && status !== 409) throw refused(status);
        return wasRunning;
      });
    },
    async reset(seat) {
      const base = await browser.locate(seat);
      await lifecycle(base, "/computers/reset", seat, bindingFor(seat).token);
    },
    serves: (seat) => volumes.has(personOf(seat) ?? ""),
    tokenFor: (seat) => bindingFor(seat).token,
    async locate(seat) {
      const { person, volume, logicalId, token } = bindingFor(seat);
      const base = await options.serialize(logicalId, async () => {
        let sandbox = await find(logicalId);
        if (sandbox?.state === "paused") {
          // `connect` resumes it and starts its idle window again. It keeps its ID, and Cube, not the reply, says
          // whether it is running. Cube makes its node port mappings again, so the ingress must resolve them afresh.
          await cube(`/sandboxes/${sandbox.sandboxID}/connect`, {
            timeout: pauses(sandbox) ? IDLE_SECONDS : -1,
          });
          renewAt.set(sandbox.sandboxID, Date.now() + RENEW_EVERY_MS);
          sandbox = await find(logicalId);
        }
        if (sandbox && sandbox.state !== "running")
          throw new ProviderError(
            "The CubeSandbox browser instance is not running.",
          );
        if (!sandbox) {
          const created = sandboxSchema.safeParse(
            await cube("/sandboxes", {
              templateID,
              metadata: { [LABEL]: logicalId, [PAUSES]: "on" },
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
              // Paused when idle, never killed: the next request resumes it.
              timeout: IDLE_SECONDS,
              lifecycle: { onTimeout: "pause", autoResume: true },
            }),
          );
          if (!created.success)
            throw new ProviderError("Invalid CubeSandbox browser instance.");
          sandbox = created.data;
          renewAt.set(sandbox.sandboxID, Date.now() + RENEW_EVERY_MS);
        }
        await keepAwake(sandbox);
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
        // Nothing runs in a sandbox Cube has paused or is pausing, and opening it resumes it.
        const state: ComputerStatus["state"] =
          !sandbox || asleep(sandbox)
            ? "absent"
            : sandbox.state === "running"
              ? "ready"
              : "starting";
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
  return browser;
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
