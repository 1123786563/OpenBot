import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ComputerConnection } from "./client";
import type { ComputerSeat } from "./computer-key";

export type ExecutionConnectionMode = "wake" | "observe";

export type OpenShellExecutionConfig = {
  pilotUsers: ReadonlySet<string>;
  cli: string;
  gateway: string;
  workspace: string;
  image: string;
  token: string;
  networkPolicies: Record<string, unknown>;
};

const sandboxList = z.object({
  sandboxes: z.array(
    z.object({
      name: z.string(),
      phase: z.string(),
      labels: z.record(z.string(), z.string()),
    }),
  ),
  next_page_token: z.string(),
});

export function createOpenShellExecution(
  config: OpenShellExecutionConfig,
  serialize: <T>(owner: string, run: () => Promise<T>) => Promise<T>,
  knownBots: () => Promise<string[]> = async () => [],
) {
  const forwards = new Map<
    string,
    { name: string; url: string; close(): void }
  >();
  const connecting = new Map<string, Promise<ComputerConnection>>();
  const scope = [
    "--gateway",
    config.gateway,
    "--workspace",
    config.workspace,
    "--color",
    "never",
  ];

  async function cli(args: string[], env = process.env): Promise<string> {
    const child = Bun.spawn([config.cli, ...scope, ...args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 130_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      console.warn(
        JSON.stringify({
          type: "openshell-execution-failed",
          operation: args.slice(0, 2),
          code,
        }),
      );
      throw new Error(
        `OpenShell ${args.slice(0, 2).join(" ")} failed (exit ${code}).`,
        {
          cause: stderr.trim(),
        },
      );
    }
    return stdout;
  }

  async function list(selector?: string) {
    const entries: z.infer<typeof sandboxList>["sandboxes"] = [];
    let token = "";
    do {
      const result = sandboxList.parse(
        JSON.parse(
          await cli([
            "sandbox",
            "list",
            ...(selector ? ["--selector", selector] : []),
            ...(token ? ["--page-token", token] : []),
            "-o",
            "json",
          ]),
        ),
      );
      entries.push(...result.sandboxes);
      if (token && token === result.next_page_token)
        throw new Error("OpenShell inventory did not advance.");
      token = result.next_page_token;
    } while (token);
    return entries;
  }

  async function lookup(name: string, identity: string) {
    const sandboxes = await list(`openbot-execution=${identity}`);
    const [sandbox] = sandboxes;
    if (
      sandboxes.length > 1 ||
      (sandbox &&
        (sandbox.name !== name ||
          sandbox.labels["openbot-execution"] !== identity))
    ) {
      throw new Error("OpenShell returned an ambiguous execution workspace.");
    }
    return sandbox;
  }

  async function create(
    name: string,
    identity: string,
    token: string,
    owner: string,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "openbot-execution-"));
    try {
      const policy = join(dir, "policy.yaml");
      await writeFile(
        policy,
        JSON.stringify({
          version: 1,
          filesystem_policy: {
            include_workdir: false,
            read_only: [
              "/usr",
              "/bin",
              "/lib",
              "/lib64",
              "/etc",
              "/proc",
              "/dev/urandom",
            ],
            read_write: [
              "/sandbox",
              "/tmp",
              "/dev/null",
              "/dev/shm",
              "/dev/ptmx",
              "/dev/pts",
            ],
          },
          landlock: { compatibility: "hard_requirement" },
          network_policies: config.networkPolicies,
        }),
        { mode: 0o600 },
      );
      await cli(
        [
          "sandbox",
          "create",
          "--name",
          name,
          "--from",
          config.image,
          "--label",
          `openbot-execution=${identity}`,
          "--label",
          `openbot-person=${owner}`,
          "--policy",
          policy,
          "--env-from",
          "OPENBOT_EXECUTION_TOKEN",
          "--no-auto-providers",
          "--approval-mode",
          "manual",
          "--detach",
          "--timeout",
          "110",
          "--",
          "/usr/local/bin/openbot-execution",
        ],
        { ...process.env, OPENBOT_EXECUTION_TOKEN: token },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function healthy(url: string, token: string): Promise<boolean> {
    return fetch(`${url}/health`, {
      headers: { "x-openbot-computer-token": token },
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    }).then(
      async (response) => {
        await response.body?.cancel().catch(() => {});
        return response.ok;
      },
      () => false,
    );
  }

  async function forward(name: string, identity: string, token: string) {
    const child = Bun.spawn(
      [
        config.cli,
        "forward",
        "service",
        name,
        "--target-port",
        "4100",
        "--local",
        "127.0.0.1:0",
        ...scope,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OpenShell terminal tunnel timed out.")),
          15_000,
        );
      });
      const address = readForwardAddress(child.stderr);
      const url = await Promise.race([address, timeout]);
      const ready = async () => {
        while (child.exitCode === null) {
          if (await healthy(url, token)) return;
          await Bun.sleep(200);
        }
        throw new Error("OpenShell execution service did not start.");
      };
      await Promise.race([ready(), timeout]);
      const tunnel = { name, url, close: () => child.kill() };
      forwards.set(identity, tunnel);
      void child.exited.then(() => {
        if (forwards.get(identity) === tunnel) forwards.delete(identity);
      });
      return url;
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensure(
    name: string,
    identity: string,
    token: string,
    owner: string,
    mode: ExecutionConnectionMode,
  ): Promise<ComputerConnection> {
    const known = forwards.get(identity);
    if (known && (await healthy(known.url, token)))
      return { url: known.url, token };
    known?.close();

    const existing = await lookup(name, identity);
    if (mode === "observe" && existing?.phase !== "Ready")
      throw new Error(
        "OpenShell execution is stopped. Reopen the terminal to start it.",
      );
    if (!existing) {
      // A concurrent API replica may have created this sandbox after the lookup.
      await create(name, identity, token, owner).catch(
        async (error: unknown) => {
          if ((await lookup(name, identity))?.phase !== "Ready") throw error;
        },
      );
    } else if (existing.phase === "Stopped" || existing.phase === "Completed") {
      await cli(["sandbox", "start", name]);
    } else if (existing.phase !== "Ready") {
      throw new Error(`OpenShell execution workspace is ${existing.phase}.`);
    }
    return { url: await forward(name, identity, token), token };
  }

  function ownerOf(personId: string) {
    if (!config.pilotUsers.has(personId))
      throw new Error("This person is outside the OpenShell pilot.");
    return createHmac("sha256", config.token)
      .update(`execution-owner:${personId}`)
      .digest("hex")
      .slice(0, 60);
  }

  function workspaceFor(personId: string, botId: string) {
    const pair = JSON.stringify([personId, botId]);
    const identity = createHash("sha256")
      .update(pair)
      .digest("hex")
      .slice(0, 60);
    // OpenShell reserves DNS label space for workspace and service names.
    const name = `ob-${BigInt(`0x${identity.slice(0, 24)}`)
      .toString(36)
      .slice(0, 16)}`;
    return { pair, name, identity };
  }

  function target(seat: ComputerSeat) {
    if (seat.key.kind !== "person")
      throw new Error("This seat is outside the OpenShell pilot.");
    const owner = ownerOf(seat.key.personId);
    const { pair, name, identity } = workspaceFor(
      seat.key.personId,
      seat.botId,
    );
    const token = createHmac("sha256", config.token).update(pair).digest("hex");
    return { owner, identity, name, token };
  }

  async function stop(name: string, phase: string) {
    const running = phase !== "Stopped" && phase !== "Completed";
    if (running) await cli(["sandbox", "stop", name]);
    for (const tunnel of forwards.values()) {
      if (tunnel.name === name) tunnel.close();
    }
    return running;
  }

  return {
    pilotUsers: config.pilotUsers,
    connect(
      seat: ComputerSeat,
      mode: ExecutionConnectionMode = "wake",
    ): Promise<ComputerConnection> {
      const { owner, identity, name, token } = target(seat);
      const key = `${identity}:${mode}`;
      const existing = connecting.get(key);
      if (existing) return existing;
      const pending = serialize(owner, () =>
        ensure(name, identity, token, owner, mode),
      ).finally(() => connecting.delete(key));
      connecting.set(key, pending);
      return pending;
    },
    stop(seat: ComputerSeat) {
      const { owner, name, identity } = target(seat);
      return serialize(owner, async () => {
        const sandbox = await lookup(name, identity);
        if (sandbox) return stop(name, sandbox.phase);
        forwards.get(identity)?.close();
        return false;
      });
    },
    clear(seat: ComputerSeat) {
      const { owner, name, identity } = target(seat);
      return serialize(owner, async () => {
        const sandbox = await lookup(name, identity);
        if (!sandbox) return false;
        if (sandbox.phase !== "Deleting")
          await cli(["sandbox", "delete", name]);
        forwards.get(identity)?.close();
        const deadline = Date.now() + 15_000;
        while (await lookup(name, identity)) {
          if (Date.now() >= deadline)
            throw new Error(
              "OpenShell workspace deletion is still pending. Retry to confirm completion.",
            );
          await Bun.sleep(250);
        }
        return true;
      });
    },
    stopPerson(personId: string) {
      const owner = ownerOf(personId);
      return serialize(owner, async () => {
        // Earlier pilot sandboxes have only the pair label. Match those against
        // this person's derived identities, including Bots that were since removed.
        const legacy = new Map(
          (await knownBots()).map((botId) => {
            const { name, identity } = workspaceFor(personId, botId);
            return [identity, name];
          }),
        );
        const sandboxes = (await list()).filter(
          ({ name, labels }) =>
            /^ob-[a-z0-9]{1,16}$/.test(name) &&
            (labels["openbot-person"] === owner ||
              (labels["openbot-person"] === undefined &&
                legacy.get(labels["openbot-execution"]) === name)),
        );
        const results = await Promise.allSettled(
          sandboxes.map((sandbox) => stop(sandbox.name, sandbox.phase)),
        );
        if (results.some((result) => result.status === "rejected"))
          throw new Error("OpenShell could not stop every execution sandbox.");
        return results.some(
          (result) => result.status === "fulfilled" && result.value,
        );
      });
    },
  };
}

async function readForwardAddress(
  stderr: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 16_384) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      const match =
        /Forwarding 127\.0\.0\.1:([1-9]\d{0,4}) -> 127\.0\.0\.1:4100 /.exec(
          text,
        );
      if (match) {
        // Keep draining the child's diagnostics for as long as the tunnel lives.
        void (async () => {
          try {
            while (!(await reader.read()).done) {}
          } finally {
            reader.releaseLock();
          }
        })().catch(() => {});
        return `http://127.0.0.1:${match[1]}`;
      }
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  reader.releaseLock();
  throw new Error("OpenShell could not open the execution tunnel.");
}
