import type { ContainerRuntimeView, SandboxInstanceStateStore } from "./state";

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

/** What an idle sweep answers: who slept, and why nobody else did. */
export type IdleReapReport = {
  slept: string[];
  /** Ready rows whose heartbeat is fresh: counted, not named, because they are the nonevent. */
  fresh: number;
};

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
  /**
   * The idle sweep: every READY sandbox whose heartbeat is older than `idleMs` sleeps. A fresh
   * heartbeat keeps its sandbox awake (the nonevent, counted not named); sleeping and absent
   * rows are not the sweep's business — one already cheap, the other already gone. A later
   * provision wakes a slept sandbox (sleeping → ready), which is the whole point of sleeping
   * rather than stopping.
   */
  reapIdleSupervision(input: {
    nowMs: number;
    idleMs: number;
  }): Promise<IdleReapReport>;
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
      if (woke) {
        // A fresh heartbeat, or the next idle sweep reads the pre-sleep one and sleeps the
        // sandbox straight back — the wake this path exists for, undone in one pass. The
        // persisted address is the row's own truth, the same one `status` answers from.
        await state.heartbeat(live.id, now());
        return live.address
          ? { address: live.address, ports: live.ports }
          : addressFor(input.botId);
      }
      // The row moved under us (another replica woke it, or it was torn down): fall through
      // to the full walk, which reads the world as it now is.
    }

    // The full provision: row FIRST (the CAS on attempt_number picks the winner between two
    // racing replicas), container after, ready transition only once the address is durable.
    const attempt = await state.beginAttempt(input);
    if (!attempt.won) {
      // The loser closes out its OWN row first, the way state.ts's protocol words it: left live,
      // the row stays this bot's earliest provisioning attempt, every later provision loses the
      // CAS to it, and no reconcile pass ever reaps a provisioning row — refused for ever.
      await state
        .transition(attempt.id, "provisioning", "failed")
        .catch(() => undefined);
      // Another replica is provisioning this Bot: wait for its verdict by reading back.
      const winner = await state.liveOf(input.botId);
      if (winner?.status === "ready" && winner.address) {
        return { address: winner.address, ports: winner.ports };
      }
      throw new Error(
        `Another provision attempt for ${input.botId} is in flight and has not settled.`,
      );
    }
    try {
      // The container exists before the row claims it: a ready row over no container is what
      // the reconcile sweep fails, which would unpick this provision one pass later.
      await runtime.recreate(input.botId);
      const address = addressFor(input.botId);
      const moved = await state.transition(
        attempt.id,
        "provisioning",
        "ready",
        {
          address: address.address,
          ports: address.ports,
        },
      );
      // CAS false means the row was torn down under us (a stop, another replica): the address
      // is no longer ours to hand out.
      if (!moved)
        throw new Error(
          `The provision row for ${input.botId} moved before it could be marked ready.`,
        );
      await state.heartbeat(attempt.id, now());
      return address;
    } catch (error) {
      // `provisioning → failed` is the only exit this file owns for a provision that threw;
      // skipped, the row stays live for ever and every later provision loses the CAS to it.
      await state
        .transition(attempt.id, "provisioning", "failed")
        .catch(() => undefined);
      throw error;
    }
  };

  const status: SandboxSupervisor["status"] = async (botId) => {
    const live = await state.liveOf(botId);
    if (!live) return { kind: "absent" };
    switch (live.status) {
      case "ready":
        return live.address
          ? {
              kind: "ready",
              address: { address: live.address, ports: live.ports },
            }
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
    if (live?.status !== "ready") return; // Nothing awake is nothing to sleep.
    await state.transition(live.id, "ready", "sleeping");
  };

  const stop: SandboxSupervisor["stop"] = async (botId) => {
    const live = await state.liveOf(botId);
    // The container goes away in the runtime FIRST: a row saying terminated beside a live
    // container is a leak, while a stopped container beside a stale row is Tuesday for the
    // reconcile sweep.
    // Removal failing means the container may still be alive. Leave the durable row live so
    // reconcile can observe and retry; writing terminated here would hide the leak from it.
    await runtime.remove(botId);
    if (live) {
      await state
        .transition(live.id, live.status, "terminated")
        .catch(() => undefined);
    }
  };

  const reapIdleSupervision: SandboxSupervisor["reapIdleSupervision"] = async (
    input,
  ) => {
    const lived = await state.listLive();
    // Each row's CAS is independent of the others', so the scan goes out in parallel
    // instead of one round trip per awake bot.
    const outcomes = await Promise.all(
      lived.map(async (row) => {
        if (row.status !== "ready")
          return { fresh: false, slept: undefined as string | undefined }; // Sleeping is done; provisioning is not ours to judge.
        const age =
          row.lastHeartbeatAt === null
            ? Number.POSITIVE_INFINITY // Never heartbeated: provision died mid-flight, asleep it goes.
            : input.nowMs - row.lastHeartbeatAt.getTime();
        if (age <= input.idleMs) return { fresh: true, slept: undefined };
        // CAS-quiet: if the row moved first (a provision woke it, a stop tore it down), the
        // transition answers false and the sweep simply disagrees with a newer truth.
        return {
          fresh: false,
          slept: (await state.transition(row.id, "ready", "sleeping"))
            ? row.botId
            : undefined,
        };
      }),
    );
    const slept = outcomes.flatMap((outcome) =>
      outcome.slept ? [outcome.slept] : [],
    );
    const fresh = outcomes.filter((outcome) => outcome.fresh).length;
    return { slept, fresh };
  };

  return { provision, status, reap, stop, reapIdleSupervision };
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
