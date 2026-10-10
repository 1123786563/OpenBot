import type {
  ContainerRuntimeView,
  SandboxInstanceStateStore,
} from "./state";

/**
 * The sandbox supervisor: four verbs, nothing else.
 *
 * The server NEVER touches a container runtime directly — the same posture computer/supervisor
 * holds ("the server asks, a supervisor answers, Docker stays behind it"). This type is that
 * contract for the workshop's per-bot sandboxes: provision, status, reap, stop. No container
 * ids, no image names, no ports beyond the address a caller may actually connect to; anything
 * the runtime knows stays behind `ContainerRuntimeView`, which this module consumes and never
 * re-exports.
 *
 * THE PERSISTED TRUTH IS C2'S STATE STORE. Every verb lands in `sandbox_instances` first or
 * alongside its runtime call: the row is the audit and the crash-recovery source, and the
 * supervisor is only the choreography above it.
 */

/** What a provisioned sandbox answers with: where it lives, and which door is which. */
export type SandboxAddress = {
  address: string;
  ports: Record<string, unknown>;
};

export type SandboxStatus =
  | { kind: "ready"; address: SandboxAddress }
  | { kind: "sleeping" }
  | { kind: "absent" }
  | { kind: "provisioning" };

export type SandboxSupervisor = {
  /**
   * The sandbox for a Bot, starting one if none is usable. Idempotent: a ready sandbox answers
   * its address again; a sleeping one wakes (sleeping → ready) without a new container; an
   * absent or failed one runs the full provision (a NEW row at the next attempt number — the
   * database's CAS on that increment is what makes two replicas racing this safe).
   */
  provision(input: {
    botId: string;
    ownerUserId: string;
  }): Promise<SandboxAddress>;
  /** Where a Bot's sandbox stands right now. Never mutates anything. */
  status(botId: string): Promise<SandboxStatus>;
  /** Sleep a ready sandbox (ready → sleeping): the container stays, the bill slows down. */
  reap(botId: string): Promise<void>;
  /** Tear the sandbox down (… → terminated): a later provision starts fresh, full walk. */
  stop(botId: string): Promise<void>;
};

export type SandboxSupervisorOptions = {
  state: SandboxInstanceStateStore;
  /**
   * The runtime this supervisor choreographs. The production implementation is a deployment
   * concern (C-lane later batches); tests and B15's fakes inject this in-memory one or their
   * own. Three verbs on purpose: list (observe), remove (destroy), recreate (rebuild) — the
   * supervisor composes THEM into its four, and never lets a container detail past this line.
   */
  runtime: ContainerRuntimeView;
  /** The address the runtime's containers are reachable at, per Bot. Tests inject; production
   * derives it from the deployment's network shape. */
  addressFor: (botId: string) => SandboxAddress;
  /** Injection for tests; default is the wall clock. */
  now?: () => Date;
};

export function createSandboxSupervisor(
  options: SandboxSupervisorOptions,
): SandboxSupervisor {
  const { state, runtime, addressFor } = options;
  const now = options.now ?? (() => new Date());

  const provision: SandboxSupervisor["provision"] = async (input) => {
    // Ready answers immediately: idempotency is the first requirement, not a nicety.
    const live = await state.liveOf(input.botId);
    if (live?.status === "ready" && live.address) {
      return { address: live.address, ports: live.ports };
    }

    // Sleeping wakes in place: the container is warm, only the row moves.
    if (live?.status === "sleeping") {
      const woke = await state.transition(live.id, "sleeping", "ready");
      if (woke) return addressFor(input.botId);
      // The row moved under us (another replica woke it, or it was torn down): fall through
      // to the full walk, which reads the world as it now is.
    }

    // The full provision: row FIRST (the CAS on attempt_number picks the winner between two
    // racing replicas), container after, ready transition only once the address is durable.
    const attempt = await state.beginAttempt(input);
    if (!attempt.won) {
      // Another replica is provisioning this Bot: wait for its verdict by reading back.
      const winner = await state.liveOf(input.botId);
      if (winner?.status === "ready" && winner.address) {
        return { address: winner.address, ports: winner.ports };
      }
      throw new Error(
        `Another provision attempt for ${input.botId} is in flight and has not settled.`,
      );
    }
    const address = addressFor(input.botId);
    await state.transition(attempt.id, "provisioning", "ready", {
      address: address.address,
      ports: address.ports,
    });
    await state.heartbeat(attempt.id, now());
    return address;
  };

  const status: SandboxSupervisor["status"] = async (botId) => {
    const live = await state.liveOf(botId);
    if (!live) return { kind: "absent" };
    switch (live.status) {
      case "ready":
        return live.address
          ? { kind: "ready", address: { address: live.address, ports: live.ports } }
          : { kind: "provisioning" };
      case "provisioning":
        return { kind: "provisioning" };
      case "sleeping":
        return { kind: "sleeping" };
      default:
        return { kind: "absent" };
    }
  };

  const reap: SandboxSupervisor["reap"] = async (botId) => {
    const live = await state.liveOf(botId);
    if (!live || live.status !== "ready") return; // Nothing awake is nothing to sleep.
    await state.transition(live.id, "ready", "sleeping");
  };

  const stop: SandboxSupervisor["stop"] = async (botId) => {
    const live = await state.liveOf(botId);
    // The container goes away in the runtime FIRST: a row saying terminated beside a live
    // container is a leak, while a stopped container beside a stale row is Tuesday for the
    // reconcile sweep.
    await runtime.remove(botId).catch(() => undefined);
    if (live) {
      await state
        .transition(live.id, live.status, "terminated")
        .catch(() => undefined);
    }
  };

  return { provision, status, reap, stop };
}

/**
 * The in-memory runtime: for tests and for B15's fakeSupervisor. A set of bot ids is the whole
 * world; remove deletes, recreate is a no-op re-add (nothing about a fake container needs
 * building), and listBotIds answers the set. It implements ContainerRuntimeView exactly, so a
 * test that types against the fake still types against the real one.
 */
export function createInMemoryContainerRuntime(initial: string[] = []) {
  const containers = new Set(initial);
  const calls: Array<{ verb: "remove" | "recreate"; botId: string }> = [];
  const runtime: ContainerRuntimeView = {
    async listBotIds() {
      return [...containers];
    },
    async remove(botId) {
      calls.push({ verb: "remove", botId });
      containers.delete(botId);
    },
    async recreate(botId) {
      calls.push({ verb: "recreate", botId });
      containers.add(botId);
    },
  };
  return { runtime, containers, calls };
}
