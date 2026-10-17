import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import {
  createInProcessTurnStateStore,
  type TurnStateStore,
} from "../src/craft/turn-state";

/**
 * The interactive-turn lifecycle store — port of onyx
 * `tests/unit/onyx/server/features/craft/interactive_turns/test_state.py` against the
 * in-process implementation (the reference semantics for the Redis one, same interface).
 *
 * The claim CAS is the crash-recovery core: QUEUED → RUNNING mints a fresh runner_id; a fresh
 * RUNNING refuses a second claim; a stale RUNNING (heartbeat past runnerStaleAfterSeconds) is
 * re-claimed with a new owner and the old owner's touch/finish are refused. The stale window
 * is config-wide (onyx passed it per call), so the stale cases run on a zero-staleness config —
 * `age >= 0` makes every heartbeat instantly stale, the deterministic equivalent of onyx's
 * `stale_after_seconds=0`.
 */

const freshStore = (): TurnStateStore =>
  createInProcessTurnStateStore({ config: loadCraftConfig({}) });

const instantlyStaleStore = (): TurnStateStore =>
  createInProcessTurnStateStore({
    config: loadCraftConfig({ OPENBOT_CRAFT_SSE_KEEPALIVE_INTERVAL: "0" }),
  });

async function createTurn(
  store: TurnStateStore,
  input: {
    sessionId?: string;
    userId?: string;
    clientRequestId?: string;
    prompt?: string;
  } = {},
) {
  return store.createInteractiveTurn({
    sessionId: input.sessionId ?? "cs-sess",
    userId: input.userId ?? "u1",
    clientRequestId: input.clientRequestId ?? "req-1",
    prompt: input.prompt ?? "hello",
    turnIndex: 0,
  });
}

describe("createInteractiveTurn", () => {
  test("records the active-turn and request mappings; born QUEUED", async () => {
    const store = freshStore();
    const turn = await createTurn(store, { clientRequestId: "req-1" });

    expect(turn.status).toBe("QUEUED");
    expect(turn.runnerId).toBeNull();

    const active = await store.getActiveTurn({
      sessionId: "cs-sess",
      userId: "u1",
    });
    expect(active?.turnId).toBe(turn.turnId);

    const byRequest = await store.getTurnForRequest({
      sessionId: "cs-sess",
      userId: "u1",
      clientRequestId: "req-1",
    });
    expect(byRequest?.turnId).toBe(turn.turnId);
  });

  test("round-trips prompt attachments", async () => {
    const store = freshStore();
    const turn = await store.createInteractiveTurn({
      sessionId: "cs-sess",
      userId: "u1",
      clientRequestId: "req-img",
      prompt: "Use this image",
      turnIndex: 0,
      attachments: [
        {
          name: "reference image.png",
          path: "attachments/reference image.png",
          mimeType: "image/png",
        },
      ],
    });
    const restored = await store.getTurn(turn.turnId);
    expect(restored?.attachments).toEqual([
      {
        name: "reference image.png",
        path: "attachments/reference image.png",
        mimeType: "image/png",
      },
    ]);
  });

  test("the request key is the idempotency key: same key → same turn, other key → none", async () => {
    const store = freshStore();
    const turn = await createTurn(store, { clientRequestId: "req-A" });
    const again = await store.getTurnForRequest({
      sessionId: "cs-sess",
      userId: "u1",
      clientRequestId: "req-A",
    });
    expect(again?.turnId).toBe(turn.turnId);

    const other = await store.getTurnForRequest({
      sessionId: "cs-sess",
      userId: "u1",
      clientRequestId: "req-B",
    });
    expect(other).toBeNull();
  });

  test("a request key does not resolve across sessions or users", async () => {
    const store = freshStore();
    await createTurn(store, { clientRequestId: "req-1" });
    expect(
      await store.getTurnForRequest({
        sessionId: "cs-other",
        userId: "u1",
        clientRequestId: "req-1",
      }),
    ).toBeNull();
    expect(
      await store.getTurnForRequest({
        sessionId: "cs-sess",
        userId: "u2",
        clientRequestId: "req-1",
      }),
    ).toBeNull();
  });
});

describe("claimTurnForRunner — the CAS", () => {
  test("QUEUED → RUNNING with a fresh runner_id; a fresh RUNNING refuses re-claim", async () => {
    const store = freshStore();
    const turn = await createTurn(store);

    const claimed = await store.claimTurnForRunner(turn.turnId);
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("RUNNING");
    expect(claimed?.runnerId).not.toBeNull();
    expect(claimed?.reclaimed).toBe(false);

    // Fresh RUNNING (heartbeat just stamped, stale window 90s) — second claim refused.
    expect(await store.claimTurnForRunner(turn.turnId)).toBeNull();
  });

  test("a stale-RUNNING turn is re-claimed: new owner, reclaimed flag, old owner locked out", async () => {
    const store = instantlyStaleStore();
    const turn = await createTurn(store);

    const first = await store.claimTurnForRunner(turn.turnId);
    expect(first?.runnerId).not.toBeNull();
    const firstRunnerId = first?.runnerId as string;

    const reclaimed = await store.claimTurnForRunner(turn.turnId);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.reclaimed).toBe(true);
    expect(reclaimed?.status).toBe("RUNNING");
    expect(reclaimed?.runnerId).not.toBeNull();
    expect(reclaimed?.runnerId).not.toBe(firstRunnerId);

    // The dispossessed owner can neither heartbeat nor finish.
    expect(
      await store.touchTurn({ turnId: turn.turnId, runnerId: firstRunnerId }),
    ).toBe(false);
    expect(
      await store.finishTurn({
        turnId: turn.turnId,
        status: "FAILED",
        runnerId: firstRunnerId,
      }),
    ).toBeNull();

    const active = await store.getActiveTurn({
      sessionId: "cs-sess",
      userId: "u1",
    });
    expect(active?.runnerId).toBe(reclaimed?.runnerId);
  });

  test("the reclaimed flag is claim-local: not persisted across reload", async () => {
    const store = instantlyStaleStore();
    const turn = await createTurn(store);
    await store.claimTurnForRunner(turn.turnId);
    const reclaimed = await store.claimTurnForRunner(turn.turnId);
    expect(reclaimed?.reclaimed).toBe(true);

    const reloaded = await store.getTurn(turn.turnId);
    expect(reloaded?.reclaimed).toBe(false);
  });

  test("terminal turns refuse the claim", async () => {
    const store = freshStore();
    const turn = await createTurn(store);
    const claimed = await store.claimTurnForRunner(turn.turnId);
    await store.finishTurn({
      turnId: turn.turnId,
      status: "SUCCEEDED",
      runnerId: claimed?.runnerId,
    });
    expect(await store.claimTurnForRunner(turn.turnId)).toBeNull();
  });

  test("unknown turns refuse the claim", async () => {
    const store = freshStore();
    expect(await store.claimTurnForRunner("turn-does-not-exist")).toBeNull();
  });
});

describe("touchTurn — the heartbeat", () => {
  test("the owner refreshes the heartbeat; the clock moves; the active pointer survives", async () => {
    const store = freshStore();
    const turn = await createTurn(store);
    const claimed = await store.claimTurnForRunner(turn.turnId);
    const before = new Date(claimed!.lastHeartbeatAt!).getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await store.touchTurn({
        turnId: turn.turnId,
        runnerId: claimed?.runnerId,
      }),
    ).toBe(true);

    const after = await store.getTurn(turn.turnId);
    expect(new Date(after!.lastHeartbeatAt!).getTime()).toBeGreaterThan(before);
    const active = await store.getActiveTurn({
      sessionId: "cs-sess",
      userId: "u1",
    });
    expect(active?.turnId).toBe(turn.turnId);
  });

  test("touch without a runner id is accepted (ownership not checked)", async () => {
    const store = freshStore();
    const turn = await createTurn(store);
    await store.claimTurnForRunner(turn.turnId);
    expect(await store.touchTurn({ turnId: turn.turnId })).toBe(true);
  });

  test("a wrong owner or an unknown/terminal turn refuses the touch", async () => {
    const store = freshStore();
    const turn = await createTurn(store);
    const claimed = await store.claimTurnForRunner(turn.turnId);
    expect(
      await store.touchTurn({ turnId: turn.turnId, runnerId: "runner-other" }),
    ).toBe(false);
    expect(await store.touchTurn({ turnId: "turn-none" })).toBe(false);

    await store.finishTurn({
      turnId: turn.turnId,
      status: "SUCCEEDED",
      runnerId: claimed?.runnerId,
    });
    expect(
      await store.touchTurn({
        turnId: turn.turnId,
        runnerId: claimed?.runnerId,
      }),
    ).toBe(false);
  });
});

describe("finishTurn", () => {
  test("clears the active marker but keeps the request mapping (idempotent retries resolve)", async () => {
    const store = freshStore();
    const turn = await createTurn(store, { clientRequestId: "req-1" });

    const finished = await store.finishTurn({
      turnId: turn.turnId,
      status: "FAILED",
      errorDetail: "boom",
    });
    expect(finished).not.toBeNull();
    expect(finished?.status).toBe("FAILED");
    expect(finished?.errorDetail).toBe("boom");
    expect(finished?.runnerId).toBeNull();

    expect(
      await store.getActiveTurn({ sessionId: "cs-sess", userId: "u1" }),
    ).toBeNull();

    const byRequest = await store.getTurnForRequest({
      sessionId: "cs-sess",
      userId: "u1",
      clientRequestId: "req-1",
    });
    expect(byRequest?.status).toBe("FAILED");
    expect(byRequest?.errorDetail).toBe("boom");
  });

  test("a wrong owner cannot finish; the turn stays RUNNING", async () => {
    const store = freshStore();
    const turn = await createTurn(store);
    const claimed = await store.claimTurnForRunner(turn.turnId);
    expect(
      await store.finishTurn({
        turnId: turn.turnId,
        status: "FAILED",
        runnerId: "runner-other",
      }),
    ).toBeNull();
    const still = await store.getTurn(turn.turnId);
    expect(still?.status).toBe("RUNNING");
    expect(still?.runnerId).toBe(claimed?.runnerId);
  });

  test("after finish, a new turn may be admitted on the session", async () => {
    const store = freshStore();
    const first = await createTurn(store, { clientRequestId: "req-1" });
    const claimed = await store.claimTurnForRunner(first.turnId);
    await store.finishTurn({
      turnId: first.turnId,
      status: "SUCCEEDED",
      runnerId: claimed?.runnerId,
    });

    const second = await createTurn(store, {
      clientRequestId: "req-2",
      prompt: "again",
    });
    expect(second.turnId).not.toBe(first.turnId);
    const active = await store.getActiveTurn({
      sessionId: "cs-sess",
      userId: "u1",
    });
    expect(active?.turnId).toBe(second.turnId);
  });
});
