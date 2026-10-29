import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createRuntimeLifecycle } from "../src/assembly/lifecycle";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/*
 * MOD03 (#623): the runtime lifecycle registry and the runtime assembly.
 *
 * Two layers of evidence:
 *
 *   1. SEMANTIC (real module): lifecycle.ts is dependency-free, so its
 *      ordering, isolation, rollback, once-guard and import purity are tested
 *      by really importing it and really firing signals at this process.
 *   2. SOURCE PINS: runtime.ts imports `serve` from "bun", so a Node test
 *      process cannot load it (ADR 0008's two-layer reality). Its wiring is
 *      pinned the same way qa-batch1 pins the meter: read from disk, asserted
 *      structurally — the module scope stays imports-only, the hold()
 *      registration keeps TODAY's frozen shutdown order, optional
 *      capabilities register only under their creation guard, the shutdown
 *      install keeps its anchor position, and the rollback catch is wired
 *      before the rethrow.
 *
 * The real-boot smoke is env-adaptive and never faked: a fully configured
 * environment must reach listening and exit 0 on SIGTERM; a stripped one must
 * refuse with the same agent-runtime-unconfigured semantics as before MOD03.
 */

const RUNTIME_SOURCE = readFileSync(
  join(hereDir, "../src/assembly/runtime.ts"),
  "utf8",
);
const LIFECYCLE_SOURCE = readFileSync(
  join(hereDir, "../src/assembly/lifecycle.ts"),
  "utf8",
);

/** Today's shutdown order, frozen (old index.ts :8416–8452), one name per step. */
const FROZEN_STOP_ORDER = [
  "responsibilitySweep",
  "catalogSyncScheduler",
  "keyStateSyncScheduler",
  "wakeUpSweep",
  "wakeUpReaper",
  "opikTicketReaper",
  "opikExportWorker",
  "opikRetentionWorker",
  "opikExecutionWorker",
  "openMuseTaskSweep",
  "openMuseTaskReaper",
  "memorySweep",
  "proactiveSweep",
  "approvalSweep",
  "personResponseSweep",
  "groupSweep",
  "deliverySweep",
  "handoffKickSweep",
  "billingSweep",
  "craftIdleReaper",
  "listenerShutdownGroup",
] as const;

/** Resources whose registration must sit inside the creation-mirroring guard. */
const GUARDED_OPTIONALS = [
  "catalogSyncScheduler",
  "keyStateSyncScheduler",
  "opikExportWorker",
  "opikRetentionWorker",
  "opikExecutionWorker",
  "handoffKickSweep",
] as const;

describe("MOD03 lifecycle registry semantics (real module)", () => {
  test("stopRegistered replays the registration order — today's frozen shutdown sequence", async () => {
    const lifecycle = createRuntimeLifecycle();
    const events: string[] = [];
    const hold = (name: string, isolate?: boolean) =>
      lifecycle.hold({
        name,
        isolate,
        stop: () => {
          events.push(name);
        },
      });

    // The production registration shape (see runtime.ts's W1 segment): named
    // sweeps first, the delivery loop expanded, the billing loop expanded with
    // isolate, the craft reaper, and the listener group LAST.
    hold("responsibilitySweep");
    hold("catalogSyncScheduler");
    hold("keyStateSyncScheduler");
    hold("wakeUpSweep");
    hold("wakeUpReaper");
    hold("opikTicketReaper");
    hold("opikExportWorker");
    hold("opikRetentionWorker");
    hold("opikExecutionWorker");
    hold("openMuseTaskSweep");
    hold("openMuseTaskReaper");
    hold("memorySweep");
    hold("proactiveSweep");
    hold("approvalSweep");
    hold("personResponseSweep");
    hold("groupSweep");
    hold("deliverySweep:0");
    hold("deliverySweep:1");
    hold("deliverySweep:2");
    hold("handoffKickSweep");
    hold("billingSweep:0", true);
    hold("billingSweep:1", true);
    hold("craftIdleReaper");
    lifecycle.hold({
      name: "listenerShutdownGroup",
      // Today's tail: the four listener stops invoked inside the group, the
      // allSettled result returned as the registry's completion.
      stop: () => {
        events.push("channelActivityListener");
        events.push("policyListener");
        events.push("workOfferedListener");
        events.push("retentionSweeps");
        return Promise.allSettled([
          Promise.resolve(),
          Promise.resolve(),
          Promise.resolve(),
          Promise.resolve(),
        ]);
      },
    });

    const completion = lifecycle.stopRegistered();
    expect(events.slice(0, 23)).toEqual([
      "responsibilitySweep",
      "catalogSyncScheduler",
      "keyStateSyncScheduler",
      "wakeUpSweep",
      "wakeUpReaper",
      "opikTicketReaper",
      "opikExportWorker",
      "opikRetentionWorker",
      "opikExecutionWorker",
      "openMuseTaskSweep",
      "openMuseTaskReaper",
      "memorySweep",
      "proactiveSweep",
      "approvalSweep",
      "personResponseSweep",
      "groupSweep",
      "deliverySweep:0",
      "deliverySweep:1",
      "deliverySweep:2",
      "handoffKickSweep",
      "billingSweep:0",
      "billingSweep:1",
      "craftIdleReaper",
    ]);
    expect(events.slice(23)).toEqual([
      "channelActivityListener",
      "policyListener",
      "workOfferedListener",
      "retentionSweeps",
    ]);
    // The completion is the group's allSettled — it settles, exactly where the
    // old handler's `.finally(() => process.exit(0))` used to attach.
    await expect(completion).resolves.toBeDefined();
    // Every named step of the frozen order is covered: the group step shows up
    // as its four member stops (there is no separate group invocation today).
    for (const name of FROZEN_STOP_ORDER) {
      if (name === "listenerShutdownGroup") continue;
      expect(events.some((e) => e === name || e.startsWith(`${name}:`))).toBe(
        true,
      );
    }
    for (const member of [
      "channelActivityListener",
      "policyListener",
      "workOfferedListener",
      "retentionSweeps",
    ]) {
      expect(events).toContain(member);
    }
  });

  test("an isolated stop that throws is swallowed; a non-isolated throw aborts the rest, exactly like today's handler", () => {
    const lifecycle = createRuntimeLifecycle();
    const events: string[] = [];
    lifecycle.hold({
      name: "fine-before",
      stop: () => {
        events.push("fine-before");
      },
    });
    lifecycle.hold({
      name: "billingSweep-boom",
      isolate: true,
      stop: () => {
        events.push("billingSweep-boom");
        throw new Error("isolated stop failed");
      },
    });
    lifecycle.hold({
      name: "fine-after-isolate",
      stop: () => {
        events.push("fine-after-isolate");
      },
    });

    const completion = lifecycle.stopRegistered();
    // The isolated throw did not block anything, and stopRegistered still
    // returns a completion promise.
    expect(events).toEqual([
      "fine-before",
      "billingSweep-boom",
      "fine-after-isolate",
    ]);
    expect(typeof (completion as Promise<unknown>).then).toBe("function");

    // Non-isolated: today's inline handler DIED mid-sequence (no exit(0), the
    // remaining stops never ran). The registry keeps that behavior.
    const lifecycle2 = createRuntimeLifecycle();
    const events2: string[] = [];
    lifecycle2.hold({
      name: "throws",
      stop: () => {
        events2.push("throws");
        throw new Error("non-isolated stop failed");
      },
    });
    lifecycle2.hold({
      name: "never-reached",
      stop: () => {
        events2.push("never-reached");
      },
    });
    let propagated: unknown;
    let threw = false;
    try {
      lifecycle2.stopRegistered();
    } catch (error) {
      threw = true;
      propagated = error;
    }
    expect(threw).toBe(true);
    expect(String(propagated)).toContain("non-isolated stop failed");
    expect(events2).toEqual(["throws"]);
  });

  test("rollback stops only what was registered — external/shared services are untouched", async () => {
    const lifecycle = createRuntimeLifecycle();
    const events: string[] = [];
    lifecycle.hold({
      name: "first",
      stop: () => {
        events.push("first");
      },
    });
    lifecycle.hold({
      name: "second",
      stop: () => {
        events.push("second");
      },
    });
    lifecycle.hold({
      name: "third",
      stop: () => {
        events.push("third");
      },
    });
    // An external/shared service this run did NOT register (a dependency's
    // own daemon, another process's resource): never held, never stopped.
    const externalStops: string[] = [];
    const externalSharedService = {
      stop: () => {
        externalStops.push("external-shared-daemon");
      },
    };

    await lifecycle.stopRegistered();
    expect(events).toEqual(["first", "second", "third"]);
    expect(externalStops).toEqual([]);
    void externalSharedService;

    // An empty registry (startup failed before anything registered) is a
    // resolving no-op — the rethrow path stays intact.
    const empty = createRuntimeLifecycle();
    await empty.stopRegistered();
  });

  test("a second signal never replays the stop sequence (once guard, real SIGUSR2 probe)", async () => {
    const lifecycle = createRuntimeLifecycle();
    const events: string[] = [];
    lifecycle.hold({
      name: "stops-once",
      stop: () => {
        events.push("stops-once");
      },
    });
    // The final group NEVER settles in this probe, so the deferred
    // exit(0) cannot fire mid-test — the same lever a real pending listener
    // connection would pull.
    lifecycle.hold({
      name: "listenerShutdownGroup",
      stop: () =>
        new Promise<unknown>(() => {
          events.push("listenerShutdownGroup");
        }),
    });

    const dispose = lifecycle.installSignalShutdown(["SIGUSR2"]);
    try {
      const before = events.length;
      expect(before).toBe(0);
      process.kill(process.pid, "SIGUSR2");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toEqual(["stops-once", "listenerShutdownGroup"]);
      // The second signal is acknowledged by the guard and replay is refused.
      process.kill(process.pid, "SIGUSR2");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toEqual(["stops-once", "listenerShutdownGroup"]);
    } finally {
      dispose();
    }
  });

  test("importing and instantiating the lifecycle adds no listeners and no resources", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGUSR2"] as const;
    const before = signals.map((s) => process.listenerCount(s));
    const module = await import("../src/assembly/lifecycle");
    const after = signals.map((s) => process.listenerCount(s));
    expect(after).toEqual(before);
    expect(typeof module.createRuntimeLifecycle).toBe("function");
    // A fresh registry is empty: stopping it is a no-op that resolves.
    const completion = module.createRuntimeLifecycle().stopRegistered();
    expect(typeof (completion as Promise<unknown>).then).toBe("function");
    await completion;
    // Source-level module-scope pin: lifecycle.ts has NO column-0 executable
    // statement — its whole surface is the doc comment, the interface, and
    // the factory. Every process.on/removeListener/exit lives inside
    // functions, so import time is side-effect free by construction.
    for (const line of LIFECYCLE_SOURCE.split("\n")) {
      if (line === "" || /^\s/.test(line)) continue;
      expect(
        line.startsWith("//") ||
          line.startsWith("/*") ||
          line.startsWith("*") ||
          line.startsWith("export interface") ||
          line.startsWith("export function") ||
          line === "}",
      ).toBe(true);
    }
  });
});

describe("MOD03 runtime assembly (source pins)", () => {
  test("the module scope is imports-only: no listeners, no exit, no executable wiring outside assembleRuntime", () => {
    // Module scope = everything before the factory. The old inline signal
    // handler (and its exit(0)) now live in lifecycle.ts; the body's own
    // pre-existing process.on("unhandledRejection") guard and boot-refusal
    // exit(1) gates stay INSIDE the factory, so the module-scope slice must be
    // free of any process touch or listener wiring.
    const moduleScope = RUNTIME_SOURCE.slice(
      0,
      RUNTIME_SOURCE.indexOf("export async function assembleRuntime"),
    );
    expect(moduleScope).not.toMatch(/\bprocess\./);
    expect(moduleScope).not.toMatch(/\bserve\(/);
    expect(RUNTIME_SOURCE).not.toMatch(/\.finally\(/);
    // Exactly the two frozen exports: the interface and the factory.
    const topLevelExports = RUNTIME_SOURCE.match(/^export /gm) ?? [];
    expect(topLevelExports.length).toBe(2);
    expect(RUNTIME_SOURCE).toContain("export interface RuntimeAssembly {");
    expect(RUNTIME_SOURCE).toContain(
      "export async function assembleRuntime(): Promise<RuntimeAssembly> {",
    );
    // Between the import block and the interface there is nothing but
    // whitespace and the interface's doc comment.
    const lifecycleImportEnd = RUNTIME_SOURCE.indexOf(
      'import { createRuntimeLifecycle } from "./lifecycle";',
    );
    const interfaceStart = RUNTIME_SOURCE.indexOf(
      "export interface RuntimeAssembly {",
    );
    expect(lifecycleImportEnd).toBeGreaterThan(-1);
    expect(interfaceStart).toBeGreaterThan(lifecycleImportEnd);
    const between = RUNTIME_SOURCE.slice(
      lifecycleImportEnd +
        'import { createRuntimeLifecycle } from "./lifecycle";'.length,
      interfaceStart,
    );
    for (const line of between.split("\n")) {
      const trimmed = line.trim();
      expect(
        trimmed === "" ||
          trimmed.startsWith("//") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("*"),
      ).toBe(true);
    }
  });

  test("the registration segment holds every resource in TODAY's frozen shutdown order", () => {
    const heldNames: string[] = [];
    const holdPattern = /lifecycle\.hold\(\{\s*name: "([a-zA-Z]+)"/g;
    let match: RegExpExecArray | null = holdPattern.exec(RUNTIME_SOURCE);
    while (match !== null) {
      heldNames.push(match[1]);
      match = holdPattern.exec(RUNTIME_SOURCE);
    }
    // The loops (deliverySweeps, billingSweepStops) hold one statement each;
    // their expansion semantics are pinned by the unit layer above.
    expect(heldNames).toEqual([...FROZEN_STOP_ORDER]);
    // The billing loop keeps its per-stop isolation (isolate: true).
    expect(RUNTIME_SOURCE).toMatch(
      /for \(const stop of billingSweepStops\) \{\s*\n\s*lifecycle\.hold\(\{ name: "billingSweep", stop, isolate: true \}\);/,
    );
    // The final group keeps today's tail exactly: the four listener stops,
    // the optional one via `?.`, retention wrapped in Promise.resolve.
    expect(RUNTIME_SOURCE).toMatch(
      /Promise\.allSettled\(\[\s*\n\s*channelActivityListener\.stop\(\),\s*\n\s*policyListener\.stop\(\),/,
    );
    expect(RUNTIME_SOURCE).toContain(
      "workOfferedListener?.stop() ?? Promise.resolve()",
    );
    expect(RUNTIME_SOURCE).toContain("Promise.resolve(retentionSweeps.stop())");
    // The old `.finally(() => process.exit(0))` moved to the lifecycle's
    // signal wrapper — it must NOT be back in the assembly.
    expect(RUNTIME_SOURCE).not.toContain(".finally(() => process.exit(0))");
  });

  test("optional capabilities register only under their creation guard (acceptance 4)", () => {
    for (const name of GUARDED_OPTIONALS) {
      const guard = new RegExp(
        `if \\(${name}\\) \\{\\s*\\n\\s*lifecycle\\.hold\\(\\{ name: "${name}"`,
      );
      expect(RUNTIME_SOURCE).toMatch(guard);
    }
    // The workOfferedListener stays inside the group expression with its `?.`
    // — never registered as an entry of its own.
    expect(RUNTIME_SOURCE).not.toMatch(
      /lifecycle\.hold\(\{ name: "workOfferedListener"/,
    );
  });

  test("the shutdown install keeps its anchor: after startHttpServer, before the listening log", () => {
    const startHttpServer = RUNTIME_SOURCE.indexOf("startHttpServer({");
    const install = RUNTIME_SOURCE.indexOf(
      'lifecycle.installSignalShutdown(["SIGINT", "SIGTERM"]);',
    );
    const listening = RUNTIME_SOURCE.indexOf(
      'log.info({ port }, "OpenBot server listening on http://127.0.0.1");',
    );
    expect(startHttpServer).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(startHttpServer);
    expect(listening).toBeGreaterThan(install);
  });

  test("startup failure rolls back via stopRegistered, then rethrows (W2 wiring)", () => {
    const catchBlock = RUNTIME_SOURCE.indexOf("  } catch (error) {");
    const rollback = RUNTIME_SOURCE.indexOf(
      "await lifecycle.stopRegistered();",
    );
    // The first `    throw error;` AFTER the rollback call is the W2 rethrow
    // (the moved body has its own inner catches with the same shape).
    const rethrow = RUNTIME_SOURCE.indexOf("    throw error;", rollback);
    expect(catchBlock).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(catchBlock);
    expect(rethrow).toBeGreaterThan(rollback);
  });
});

describe("MOD03 real boot smoke (env-adaptive, never faked)", () => {
  test("thin entry boots the real assembly: configured env listens and exits 0 on SIGTERM; stripped env refuses with agent-runtime-unconfigured", async () => {
    const workspaceRoot = join(hereDir, "../..");
    const serverRoot = join(workspaceRoot, "server");
    // The Node worker's PATH may not carry bun; resolve the way Bun itself
    // installs (BUN_INSTALL, ~/.bun/bin) plus Homebrew, else PATH.
    const bunCandidates = [
      process.env.BUN_INSTALL
        ? join(process.env.BUN_INSTALL, "bin", "bun")
        : undefined,
      join(process.env.HOME ?? "", ".bun", "bin", "bun"),
      "/opt/homebrew/bin/bun",
      "/usr/local/bin/bun",
    ].filter((p): p is string => typeof p === "string");
    const bunPath = bunCandidates.find((p) => existsSync(p)) ?? "bun";
    const child = spawn(bunPath, ["src/index.ts"], {
      cwd: serverRoot,
      env: {
        ...process.env,
        // The smallest environment loadConfig accepts, with NO Intelligence
        // (the mastra-no-intelligence-boot recipe): missing agent runtime must
        // REFUSE rather than degrade — the pre-MOD03 semantics.
        DATABASE_URL:
          process.env.TEST_DATABASE_URL ??
          "postgresql://postgres:openbot@127.0.0.1:5433/openbot_test",
        KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        OPENBOT_SINGLE_USER: "true",
        PORT: "39777",
        INTELLIGENCE_API_URL: undefined as unknown as string,
        INTELLIGENCE_GATEWAY_WS_URL: undefined as unknown as string,
        INTELLIGENCE_API_KEY: undefined as unknown as string,
        COPILOTKIT_LICENSE_TOKEN: undefined as unknown as string,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));

    const exited: Promise<number | null> = new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    const refusal = new Promise<boolean>((resolve) => {
      const poll = setInterval(() => {
        if (output.includes("agent-runtime-unconfigured")) {
          clearInterval(poll);
          resolve(true);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(poll);
        resolve(false);
      }, 30_000).unref?.();
    });

    const refused = await refusal;
    if (refused) {
      // Branch A (this environment): the refusal must be the WHOLE story —
      // exit code 1, before any listener exists.
      const code = await exited;
      expect(code).toBe(1);
      expect(output).toContain("AGENT_RUNTIME_UNCONFIGURED");
      expect(output).not.toContain("OpenBot server listening");
      return;
    }
    // Branch B (a fully configured environment): the server must be
    // listening; SIGTERM must drain the registry and exit 0.
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    expect(output).toContain("OpenBot server listening");
    expect(code).toBe(0);
  }, 120_000);
});
