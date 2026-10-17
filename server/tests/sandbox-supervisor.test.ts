import { describe, expect, test } from "bun:test";
import {
  createInMemoryContainerRuntime,
  createSandboxSupervisor,
} from "../src/sandbox/supervisor";
import type {
  ContainerRuntimeView,
  SandboxInstanceStateStore,
} from "../src/sandbox/state";

/**
 * The supervisor's four verbs against an in-memory state store and the in-memory runtime: the
 * same choreography production runs, none of the containers. What these cases pin is the
 * CONTRACT — idempotent provision, wake-on-demand, full rewalk after stop, and the type's own
 * refusal to know anything about containers.
 */
function fakeState() {
  type Row = {
    id: string;
    botId: string;
    status: "provisioning" | "ready" | "sleeping" | "terminated" | "failed";
    attemptNumber: number;
    address: string | null;
    ports: Record<string, unknown>;
    lastHeartbeatAt: Date | null;
    ownerUserId: string;
  };
  const rows = new Map<string, Row>();
  let sequence = 0;
  const liveOf = (botId: string) =>
    [...rows.values()].find(
      (row) =>
        row.botId === botId &&
        ["provisioning", "ready", "sleeping"].includes(row.status),
    );
  const state: SandboxInstanceStateStore = {
    liveOf: async (botId) => liveOf(botId),
    beginAttempt: async (input) => {
      // The attempt number counts EVERY row this bot has ever had — live or sunk — because
      // that is the audit trail: attempt 2 after a terminated attempt 1, not a reset.
      const highWater = Math.max(
        0,
        ...[...rows.values()]
          .filter((row) => row.botId === input.botId)
          .map((row) => row.attemptNumber),
      );
      const attemptNumber = highWater + 1;
      const _current = liveOf(input.botId);
      const row: Row = {
        id: `sbx-${++sequence}`,
        botId: input.botId,
        status: "provisioning",
        attemptNumber,
        address: null,
        ports: {},
        lastHeartbeatAt: null,
        ownerUserId: input.ownerUserId,
      };
      // The CAS: a live provisioning row for this bot already means somebody won.
      const existing = liveOf(input.botId);
      if (existing?.status === "provisioning") {
        return {
          id: existing.id,
          attemptNumber: existing.attemptNumber,
          won: false,
        };
      }
      // A live ready/sleeping row is replaced by a fresh provision attempt.
      if (existing) rows.delete(existing.id);
      rows.set(row.id, row);
      return { id: row.id, attemptNumber, won: true };
    },
    transition: async (id, from, to, patch) => {
      const row = rows.get(id);
      if (!row || row.status !== from) return false;
      row.status = to;
      if (patch?.address !== undefined) row.address = patch.address;
      if (patch?.ports !== undefined) row.ports = patch.ports;
      return true;
    },
    heartbeat: async (id, at) => {
      const row = rows.get(id);
      if (row) row.lastHeartbeatAt = at;
    },
    listLive: async () =>
      [...rows.values()]
        .filter((row) =>
          ["provisioning", "ready", "sleeping"].includes(row.status),
        )
        .map((row) => ({
          id: row.id,
          botId: row.botId,
          status: row.status,
          attemptNumber: row.attemptNumber,
          lastHeartbeatAt: row.lastHeartbeatAt,
        })),
  };
  return { state, rows, liveOf };
}

const ADDRESS = (botId: string) => ({
  address: `ws://${botId}.sandbox.internal`,
  ports: { webapp: 4500, opencode: 4400 },
});

function build(initial: string[] = [], clockMs = 0) {
  const state = fakeState();
  const memory = createInMemoryContainerRuntime(initial);
  const supervisor = createSandboxSupervisor({
    state: state.state,
    runtime: memory.runtime,
    addressFor: ADDRESS,
    // A frozen clock: provision stamps its heartbeat at clockMs, so a sweep run at a later
    // nowMs is genuinely later — the C4 cases' staleness is arithmetic, never wall time.
    now: () => new Date(clockMs),
  });
  return { supervisor, state, memory };
}

describe("SandboxSupervisor (C3: four verbs, no containers in sight)", () => {
  test("provision is idempotent: a ready sandbox answers its address again", async () => {
    const { supervisor, state } = build();
    const first = await supervisor.provision({
      botId: "alpha",
      ownerUserId: "u1",
    });
    expect(first.address).toBe(ADDRESS("alpha").address);
    const second = await supervisor.provision({
      botId: "alpha",
      ownerUserId: "u1",
    });
    expect(second.address).toBe(first.address);
    // One row, one attempt: the second call was a read, not a rewalk.
    expect(
      [...state.rows.values()].filter((row) => row.botId === "alpha"),
    ).toHaveLength(1);
  });

  test("a sleeping sandbox wakes without a new row or container", async () => {
    const { supervisor, state } = build();
    await supervisor.provision({ botId: "beta", ownerUserId: "u1" });
    await supervisor.reap("beta");
    expect(await supervisor.status("beta")).toEqual({ kind: "sleeping" });

    const woke = await supervisor.provision({
      botId: "beta",
      ownerUserId: "u1",
    });
    expect(woke.address).toBe(ADDRESS("beta").address);
    // The same row, moved back: not a fresh attempt.
    const rows = [...state.rows.values()].filter((row) => row.botId === "beta");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attemptNumber).toBe(1);
    expect(await supervisor.status("beta")).toMatchObject({ kind: "ready" });
  });

  test("stop tears down; the next provision walks the full path on a fresh row", async () => {
    const { supervisor, state, memory } = build();
    await supervisor.provision({ botId: "gamma", ownerUserId: "u1" });
    await supervisor.stop("gamma");

    expect(await supervisor.status("gamma")).toEqual({ kind: "absent" });
    expect(
      memory.calls.filter(
        (call) => call.verb === "remove" && call.botId === "gamma",
      ),
    ).toHaveLength(1);

    // Full rewalk: a NEW row at the next attempt number.
    const again = await supervisor.provision({
      botId: "gamma",
      ownerUserId: "u1",
    });
    expect(again.address).toBe(ADDRESS("gamma").address);
    const rows = [...state.rows.values()].filter(
      (row) => row.botId === "gamma",
    );
    expect(rows.at(-1)?.attemptNumber).toBe(2);
    expect(await supervisor.status("gamma")).toMatchObject({ kind: "ready" });
  });

  test("reap is quiet on nothing: absent and sleeping reap without effect", async () => {
    const { supervisor } = build();
    await supervisor.reap("never-provisioned"); // No row, no throw.
    await supervisor.provision({ botId: "delta", ownerUserId: "u1" });
    await supervisor.reap("delta");
    await supervisor.reap("delta"); // Already sleeping: still quiet.
    expect(await supervisor.status("delta")).toEqual({ kind: "sleeping" });
  });

  test("the type exposes exactly four verbs and no container surface (pinned)", async () => {
    const { supervisor } = build();
    // The five verbs exist (C4 added the idle sweep to the original four)...
    for (const verb of [
      "provision",
      "status",
      "reap",
      "stop",
      "reapIdleSupervision",
    ] as const) {
      expect(typeof supervisor[verb]).toBe("function");
    }
    // ...and nothing else: no container ids, no image names, no runtime handles. The keys of
    // the object ARE the contract; a future field that leaks a container detail fails here.
    expect(Object.keys(supervisor).sort()).toEqual([
      "provision",
      "reap",
      "reapIdleSupervision",
      "status",
      "stop",
    ]);
    // The runtime type the supervisor consumes is the three-verb view, never more.
    const runtimeViewKeys: Array<keyof ContainerRuntimeView> = [
      "listBotIds",
      "remove",
      "recreate",
    ];
    expect(runtimeViewKeys.sort()).toEqual([
      "listBotIds",
      "recreate",
      "remove",
    ]);
  });

  test("the idle sweep sleeps a ready sandbox whose heartbeat is stale (C4)", async () => {
    const { supervisor } = build();
    await supervisor.provision({ botId: "stale", ownerUserId: "u1" });
    // Time passes past the idle budget; the sweep runs.
    const report = await supervisor.reapIdleSupervision({
      nowMs: 10 * 60_000,
      idleMs: 60_000,
    });
    expect(report.slept).toEqual(["stale"]);
    expect(report.fresh).toBe(0);
    expect(await supervisor.status("stale")).toEqual({ kind: "sleeping" });
  });

  test("a fresh heartbeat keeps its sandbox awake, and is counted not named (C4)", async () => {
    const { supervisor, state } = build();
    await supervisor.provision({ botId: "busy", ownerUserId: "u1" });
    await supervisor.provision({ botId: "idle", ownerUserId: "u1" });
    // Renew ONLY the busy one's heartbeat, right before the sweep.
    const busyRow = state.liveOf("busy");
    expect(busyRow).toBeDefined();
    await state.state.heartbeat(busyRow!.id, new Date(9 * 60_000));
    const report = await supervisor.reapIdleSupervision({
      nowMs: 10 * 60_000,
      idleMs: 60_000,
    });
    expect(report.slept).toEqual(["idle"]); // The stale one slept...
    expect(report.fresh).toBe(1); // ...and the fresh one is a count, never a name.
    expect(await supervisor.status("busy")).toMatchObject({ kind: "ready" });
  });

  test("after the sweep sleeps it, provision wakes the sandbox without a new row (C4)", async () => {
    const { supervisor, state } = build();
    await supervisor.provision({ botId: "wake", ownerUserId: "u1" });
    await supervisor.reapIdleSupervision({
      nowMs: 10 * 60_000,
      idleMs: 60_000,
    });
    const woke = await supervisor.provision({
      botId: "wake",
      ownerUserId: "u1",
    });
    expect(woke.address).toBe(ADDRESS("wake").address);
    // The wake moved the SAME row: no fresh attempt, the container never left.
    const rows = [...state.rows.values()].filter((row) => row.botId === "wake");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attemptNumber).toBe(1);
    expect(await supervisor.status("wake")).toMatchObject({ kind: "ready" });
  });

  test("a racing loser reads the winner's ready row instead of double-provisioning", async () => {
    const { supervisor, state } = build();
    // A live provisioning row another replica "owns": beginAttempt will lose the CAS.
    await state.state.beginAttempt({ botId: "epsilon", ownerUserId: "u1" });
    await expect(
      supervisor.provision({ botId: "epsilon", ownerUserId: "u1" }),
    ).rejects.toThrow(/in flight/);
  });
});
