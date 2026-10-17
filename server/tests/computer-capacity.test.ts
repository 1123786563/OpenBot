import { describe, expect, test } from "../../tests/support/e2e-compat";
import type {
  ComputerControlState,
  HandoffRequest,
} from "../../shared/computer-control";
import {
  ComputerCapacityError,
  computerCapacity,
  WorkspaceQuotaError,
} from "../src/computer/capacity";
import type { ComputerLocation } from "../src/computer/provider";

/**
 * The §10 capacity bounds, decided at the limiter seam.
 *
 * Three rows of the contract's table for the 1–20 profile: at most 20 concurrent running
 * computers counted deployment-wide, a 15-minute idle stop that leaves the workspace intact, and
 * a 2 GiB per-Bot workspace disk cap. The limiter owns the decisions; the gateway asks it at the
 * start path (`locate`, the one call every action makes and the one that starts the computer) and
 * before a workspace write, and the routes map its refusals onto statuses with stable codes.
 *
 * Everything here is fakes: a provider that owns a list of computers and records what was stopped,
 * a control seam that answers for one Bot the way GET /control does, and a clock the test holds.
 */

const GIB = 1024 ** 3;
const START = Date.parse("2026-10-13T12:00:00.000Z");

function running(botId: string, startedMinutesAgo: number): ComputerLocation {
  return {
    botId,
    status: "running",
    startedAt: new Date(START - startedMinutesAgo * 60_000).toISOString(),
  };
}

function controlState(
  overrides: Partial<ComputerControlState> = {},
): ComputerControlState {
  return {
    holder: "bot",
    since: new Date(START - 30 * 60_000).toISOString(),
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    ...overrides,
  };
}

function handoff(updatedMinutesAgo: number): HandoffRequest {
  return {
    id: "lease-1",
    reason: "Help me sign in.",
    source: "manual",
    status: "waiting",
    createdAt: new Date(START - 20 * 60_000).toISOString(),
    updatedAt: new Date(START - updatedMinutesAgo * 60_000).toISOString(),
    expiresAt: new Date(START + 5 * 60_000).toISOString(),
  };
}

/**
 * A provider that owns the list, so a test can see both the decisions (what was stopped) and the
 * effects (what the list says afterwards).
 */
function fakeProvider(computers: ComputerLocation[]) {
  const stopped: string[] = [];
  const ensured: string[] = [];
  let reads = 0;
  return {
    stopped,
    ensured,
    listed: () => reads,
    computers,
    async list() {
      reads += 1;
      return computers.map((computer) => ({ ...computer }));
    },
    async stop(botId: string) {
      const index = computers.findIndex(
        (computer) => computer.botId === botId && computer.status === "running",
      );
      if (index >= 0) {
        computers[index] = { ...computers[index], status: "stopped" };
      }
      stopped.push(botId);
      return { wasRunning: index >= 0 };
    },
    async locate(botId: string) {
      ensured.push(botId);
      return "http://computer.test";
    },
  };
}

function capacity(
  computers: ComputerLocation[],
  options: {
    control?: (botId: string) => Promise<ComputerControlState | undefined>;
    maxActive?: number;
    idleMinutes?: number;
  } = {},
) {
  const provider = fakeProvider(computers);
  const clock = { ms: START };
  const limiter = computerCapacity({
    provider,
    control: options.control,
    ...(options.maxActive !== undefined
      ? { maxActive: options.maxActive }
      : {}),
    ...(options.idleMinutes !== undefined
      ? { idleMinutes: options.idleMinutes }
      : {}),
    now: () => new Date(clock.ms),
  });
  return { provider, limiter, clock };
}

const noControl = async () => undefined;

describe("active computer cap (§10 row 1)", () => {
  test("the 21st start is refused with a typed, coded refusal and starts nothing", async () => {
    const computers = Array.from({ length: 20 }, (_, i) =>
      running(`other-${i}`, 1),
    );
    const { provider, limiter } = capacity(computers, { control: noControl });

    await expect(limiter.reserve("mine")).rejects.toMatchObject({
      name: "ComputerCapacityError",
      code: "computer_capacity_exceeded",
    });
    // Zero starts: the gateway locates — and so starts — only after reserve passes.
    expect(provider.ensured).toEqual([]);
    expect(provider.stopped).toEqual([]);
  });

  test("the refusal names the deployment limit, never another user's Bot", async () => {
    const computers = Array.from({ length: 20 }, (_, i) =>
      running(`other-${i}`, 1),
    );
    const { limiter } = capacity(computers, { control: noControl });

    const refusal = await limiter.reserve("mine").catch((error) => error);
    expect(refusal).toBeInstanceOf(ComputerCapacityError);
    expect(refusal.message).toContain("20");
    // Cross-user effects run one way: their computers count against mine, but no other Bot's
    // identity crosses back to the refused caller.
    for (const computer of computers) {
      expect(refusal.message).not.toContain(computer.botId);
    }
  });

  test("the 20th start passes, and a freed slot allows the next one again", async () => {
    const computers = Array.from({ length: 19 }, (_, i) =>
      running(`other-${i}`, 1),
    );
    const { provider, limiter } = capacity(computers, { control: noControl });

    await limiter.reserve("mine");
    expect(provider.ensured).toEqual([]);

    // A slot frees — a person stopped a computer — and the next start passes again.
    provider.computers[0] = { ...provider.computers[0], status: "stopped" };
    await limiter.reserve("next");
  });

  test("a contended cap sweeps idlers before refusing, and passes once one frees a slot", async () => {
    const computers = [
      ...Array.from({ length: 19 }, (_, i) => running(`busy-${i}`, 1)),
      running("sleepy", 30),
    ];
    const { provider, limiter } = capacity(computers, { control: noControl });

    await limiter.reserve("mine");
    expect(provider.stopped).toEqual(["sleepy"]);
  });

  test("a start still in flight holds a slot: the cold-start burst cannot overshoot the cap", async () => {
    const computers = Array.from({ length: 19 }, (_, i) =>
      running(`other-${i}`, 1),
    );
    const { limiter, clock } = capacity(computers, { control: noControl });

    // Bot A is admitted, but its /ensure (container create + start, seconds) has not
    // landed it in the provider's list yet — the cold-start burst shape after a redeploy.
    await limiter.reserve("starting-a");

    // Bot B contends inside that window: the in-flight start must occupy the 20th slot
    // rather than vanish from the count and let the fleet run past maxActive.
    await expect(limiter.reserve("contender-b")).rejects.toMatchObject({
      name: "ComputerCapacityError",
    });

    // The placeholder is a grace, not a lease: once A's window lapses without it ever
    // landing, the slot frees for the contender again.
    clock.ms = START + 31 * 60_000;
    computers.pop();
    await limiter.reserve("contender-b");
  });
});

describe("idle sweep (§10 row 2)", () => {
  test("stops a computer idle past the limit with no run activity and no control", async () => {
    const { provider, limiter } = capacity([running("bot-1", 16)], {
      control: noControl,
    });

    expect(await limiter.sweepIdle()).toEqual(["bot-1"]);
    expect(provider.computers[0].status).toBe("stopped");
  });

  test("leaves a computer that is not yet idle", async () => {
    const { provider, limiter } = capacity([running("bot-1", 14)], {
      control: noControl,
    });

    expect(await limiter.sweepIdle()).toEqual([]);
    expect(provider.stopped).toEqual([]);
  });

  test("human control resets the clock: a held lease is never swept", async () => {
    const { provider, limiter } = capacity([running("bot-1", 60)], {
      control: async () => controlState({ holder: "human" }),
    });

    expect(await limiter.sweepIdle()).toEqual([]);
    expect(provider.stopped).toEqual([]);
  });

  test("control activity resets the clock", async () => {
    const { limiter } = capacity([running("bot-1", 60)], {
      control: async () => controlState({ request: handoff(5) }),
    });

    expect(await limiter.sweepIdle()).toEqual([]);
  });

  test("the computer's own last activity resets the clock: a run driven through another replica is not idle", async () => {
    /*
     * startedAt is a beginning, not an activity, and lastRunActivity only knows
     * THIS process — a deployment's servers behind a load balancer each hold
     * their own half of the picture. The consult's lastActivity is the one
     * signal visible from outside the computer, so the sweep must read it:
     * a Bot whose run is being driven through another replica must not read
     * as idle here and lose its browser 15 minutes in.
     */
    const { limiter } = capacity([running("bot-1", 60)], {
      control: async () =>
        controlState({
          lastActivity: new Date(START - 5 * 60_000).toISOString(),
        }),
    });

    expect(await limiter.sweepIdle()).toEqual([]);

    // And the same signal grown stale does not protect it any longer.
    const later = capacity([running("bot-1", 60)], {
      control: async () =>
        controlState({
          lastActivity: new Date(START - 20 * 60_000).toISOString(),
        }),
    });
    expect(await later.limiter.sweepIdle()).toEqual(["bot-1"]);
  });

  test("run activity resets the clock: a Bot acting on its computer keeps it", async () => {
    const { provider, limiter, clock } = capacity([running("bot-1", 60)], {
      control: noControl,
    });

    // The Bot acts now; the run whose start is an hour old is still in use.
    await limiter.reserve("bot-1");
    clock.ms += 14 * 60_000;
    expect(await limiter.sweepIdle()).toEqual([]);

    // Sixteen quiet minutes after the last action, it is idle and stops — with its workspace
    // kept, which is the provider's own stop semantics the sweep rides.
    clock.ms += 2 * 60_000;
    expect(await limiter.sweepIdle()).toEqual(["bot-1"]);
    expect(provider.stopped).toEqual(["bot-1"]);
  });
});

describe("workspace disk cap (§10 row 3)", () => {
  test("a write that would pass 2 GiB is refused with a typed quota error and records nothing", () => {
    const { limiter } = capacity([], { control: noControl });

    limiter.chargeWrite("bot-1", 2 * GIB - 1);

    expect(() => limiter.chargeWrite("bot-1", 2)).toThrow(WorkspaceQuotaError);
    expect(() => limiter.chargeWrite("bot-1", 2)).toThrowError(/2 GiB/);

    // The refused write charged nothing: exactly one byte still fits.
    expect(() => limiter.chargeWrite("bot-1", 1)).not.toThrow();
  });

  test("a write under the cap passes, and the cap is per Bot", () => {
    const { limiter } = capacity([], { control: noControl });

    limiter.chargeWrite("bot-1", GIB);
    expect(() => limiter.chargeWrite("bot-1", GIB + 1)).toThrow(
      WorkspaceQuotaError,
    );
    // A different Bot's workspace has its own budget.
    expect(() => limiter.chargeWrite("bot-2", 2 * GIB)).not.toThrow();
  });

  test("a reset workspace starts its budget over", () => {
    const { limiter } = capacity([], { control: noControl });

    limiter.chargeWrite("bot-1", 2 * GIB);
    expect(() => limiter.chargeWrite("bot-1", 1)).toThrow(WorkspaceQuotaError);

    limiter.resetUsage("bot-1");
    expect(() => limiter.chargeWrite("bot-1", 2 * GIB)).not.toThrow();
  });
});

describe("cross-user effects (§10 row 1: the deployment-wide reading)", () => {
  test("another user's computers count against the cap, which is the installation's", async () => {
    // §10 bounds the installation, not the user — "one user's work cannot exhaust the
    // installation" — so the count is every running computer the provider owns.
    const computers = Array.from({ length: 20 }, (_, i) =>
      running(`theirs-${i}`, 1),
    );
    const { limiter } = capacity(computers, { control: noControl });

    await expect(limiter.reserve("mine")).rejects.toBeInstanceOf(
      ComputerCapacityError,
    );
  });

  test("a sweep stops only idle computers, never another user's active one", async () => {
    const { provider, limiter } = capacity(
      [running("theirs", 1), running("mine-idle", 30)],
      { control: noControl },
    );

    expect(await limiter.sweepIdle()).toEqual(["mine-idle"]);
    expect(provider.stopped).toEqual(["mine-idle"]);
  });
});

describe("the §10 bounds read their envs, defaulting to the contract's values", () => {
  test("a smaller env cap is honored, and an unusable one falls back", async () => {
    process.env.OPENMUSE_MAX_ACTIVE_COMPUTERS = "3";
    try {
      const computers = Array.from({ length: 3 }, (_, i) =>
        running(`bot-${i}`, 1),
      );
      const { limiter } = capacity(computers, { control: noControl });
      await expect(limiter.reserve("mine")).rejects.toBeInstanceOf(
        ComputerCapacityError,
      );
    } finally {
      delete process.env.OPENMUSE_MAX_ACTIVE_COMPUTERS;
    }

    process.env.OPENMUSE_COMPUTER_DISK_GIB = "not a number";
    try {
      const { limiter } = capacity([], { control: noControl });
      // The default 2 GiB, not NaN or 0.
      limiter.chargeWrite("bot-1", 2 * GIB);
    } finally {
      delete process.env.OPENMUSE_COMPUTER_DISK_GIB;
    }
  });
});

/**
 * The sweep's own consult must not count as activity, and the sweep must not stop the very Bot
 * whose start triggered it — the round-3 repair findings, pinned here.
 */
describe("sweep on contention (round 3)", () => {
  test("a Bot whose own computer is already running is admitted past the cap as a refresh, sweeping nothing", async () => {
    const computers = [running("mine", 30), running("busy", 1)];
    const { provider, limiter } = capacity(computers, {
      control: noControl,
      maxActive: 1,
    });

    /*
     * The cap counts starts, and this reserve starts nothing: mine's /ensure refreshes a
     * computer the list already shows running. Stopping mine for room was never available to
     * it — the sweep has always excluded the reserving Bot's own computer — so refusing the
     * refresh only locked a running computer away from its own Bot (its gestures, releases and
     * revocations all 503'd until an unrelated computer idled).
     */
    await limiter.reserve("mine");
    expect(provider.stopped).toEqual([]);
  });

  test("a re-entrant sweep stands aside rather than deadlocking or doubling", async () => {
    const nested: string[][] = [];
    const { provider, limiter } = capacity([running("bot-1", 60)], {
      control: async () => {
        nested.push(await limiter.sweepIdle());
        return undefined;
      },
    });

    expect(await limiter.sweepIdle()).toEqual(["bot-1"]);
    // The consult's own sweep ran inside the outer one and let the outer finish the work.
    expect(nested).toEqual([[]]);
    expect(provider.stopped).toEqual(["bot-1"]);
  });

  test("concurrent reserves serialise their list reads", async () => {
    let inFlight = 0;
    let peak = 0;
    let reads = 0;
    const provider = {
      stopped: [] as string[],
      async list() {
        reads += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return [running("busy", 1)];
      },
      async stop() {
        return { wasRunning: true };
      },
      async locate() {
        return "http://computer.test";
      },
    };
    const limiter = computerCapacity({
      provider,
      maxActive: 20,
      control: noControl,
      now: () => new Date(START),
    });

    await Promise.all([limiter.reserve("a"), limiter.reserve("b")]);
    // Two reserves, two list reads, and never two reads in flight at once: the check-then-act
    // window between concurrent starts is narrowed to one reserve at a time.
    expect(reads).toBe(2);
    expect(peak).toBe(1);
  });

  test("a Bot acting again within the throttle window does not re-list the fleet", async () => {
    const computers = [running("bot-1", 1)];
    const { provider, limiter, clock } = capacity(computers, {
      control: noControl,
    });
    const listedBefore = provider.listed();

    await limiter.reserve("bot-1");
    await limiter.reserve("bot-1");
    expect(provider.listed()).toBe(listedBefore + 1);

    // Past the window the deployment's count is asked for again.
    clock.ms += 3000;
    await limiter.reserve("bot-1");
    expect(provider.listed()).toBe(listedBefore + 2);
  });
});

describe("sweep and budget safety (final pass)", () => {
  test("a consult that fails reads as unjudgeable, not as unheld: the computer is skipped", async () => {
    const consulted: string[] = [];
    const { provider, limiter } = capacity([running("bot-1", 30)], {
      control: async (botId) => {
        consulted.push(botId);
        throw new Error("computer unreachable");
      },
    });

    // Idle by every timestamp, but the one question that matters — does a person hold it? —
    // could not be asked, so the sweep stops nothing rather than betting on "no". The gateway
    // consult propagates its failures for exactly this reading (a held lease is never idle,
    // including when the asking fails).
    expect(await limiter.sweepIdle()).toEqual([]);
    expect(consulted).toEqual(["bot-1"]);
    expect(provider.stopped).toEqual([]);
  });

  test("a contended reserve does not re-pay the sweep on every retry", async () => {
    const consulted: string[] = [];
    const { limiter, clock } = capacity([running("busy", 1)], {
      control: async (botId) => {
        consulted.push(botId);
        return controlState();
      },
      maxActive: 1,
    });

    await expect(limiter.reserve("mine")).rejects.toBeInstanceOf(
      ComputerCapacityError,
    );
    const consultedOnce = consulted.length;
    expect(consultedOnce).toBeGreaterThan(0);

    // Inside the sweep-throttle window the refusal is answered on the count alone.
    clock.ms = START + 1_000;
    await expect(limiter.reserve("mine")).rejects.toBeInstanceOf(
      ComputerCapacityError,
    );
    expect(consulted).toHaveLength(consultedOnce);

    // Past it, a still-contended retry sweeps again.
    clock.ms = START + 11_000;
    await expect(limiter.reserve("mine")).rejects.toBeInstanceOf(
      ComputerCapacityError,
    );
    expect(consulted.length).toBeGreaterThan(consultedOnce);
  });

  test("forget drops the run-activity entry a stop made stale", async () => {
    const { provider, limiter } = capacity([running("bot-1", 1)], {
      control: noControl,
    });
    await limiter.reserve("bot-1");
    const listedBefore = provider.listed();
    await limiter.reserve("bot-1");
    // Within the reserve-throttle window: the remembered activity answers, no list.
    expect(provider.listed()).toBe(listedBefore);

    limiter.forget("bot-1");
    await limiter.reserve("bot-1");
    // The entry is gone, so the deployment's count is asked for again.
    expect(provider.listed()).toBe(listedBefore + 1);
  });

  test("a refunded write's bytes come back, so transient failures cannot eat the budget", () => {
    const { limiter } = capacity([], { control: noControl });

    limiter.chargeWrite("bot-1", 2 * GIB - 1);
    limiter.refundWrite("bot-1", 2 * GIB - 1);
    expect(() => limiter.chargeWrite("bot-1", 2 * GIB)).not.toThrow();
  });
});
