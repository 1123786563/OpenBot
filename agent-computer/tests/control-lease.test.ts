import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlRequestError,
  createControl,
  HELP_REQUEST_TTL_MS,
  TAKE_CONTROL_FIRST,
} from "../src/control";
import { createControlStore } from "../src/control-store";

/**
 * The §3 computer-control lease, clause by clause, at the state machine.
 *
 * The machine is the authority: both input paths (the live screen and the HTTP gestures) gate on it
 * before anything reaches a page, so a refusal here is a refusal everywhere. Clauses OpenBot already
 * had are pinned as regression tests; the lease-identity and sequence clauses were gaps this
 * ticket's matrix proved and closed. The route-level half of the matrix lives in
 * `server/tests/control-lease-routes.test.ts`.
 */

const directories: string[] = [];
function fixture() {
  let tick = Date.parse("2026-10-13T00:00:00Z");
  const control = createControl(() => new Date(tick).toISOString());
  const advance = (ms: number) => {
    tick += ms;
  };
  const request = (toolCallId = "call-1") =>
    control.requestHelp("Sign in to continue.", toolCallId).request!;
  return { control, advance, request };
}
function stored() {
  const directory = mkdtempSync(join(tmpdir(), "control-lease-"));
  directories.push(directory);
  const store = createControlStore(directory, "bot-1");
  const control = createControl(() => "2026-10-13T00:00:00Z", { store });
  return { store, control };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("§3 lease matrix — the state machine", () => {
  test("viewing → requesting → controlling → released, each state observable", async () => {
    const { control, request } = fixture();
    // Viewing: nobody holds anything, nothing asked for.
    expect(control.get()).toMatchObject({
      holder: "bot",
      requested: false,
    });
    // Requesting: the Bot asks, and only a person may answer.
    const help = request();
    expect(help.status).toBe("waiting");
    expect(help.expiresAt).toBeDefined();
    expect(control.get().holder).toBe("bot");
    expect(control.humanMayDrive()).toBe(false);
    // Controlling: one named person takes, and their input is admitted.
    await control.take(help.id, { userId: "user-a" });
    expect(control.get()).toMatchObject({
      holder: "human",
      requested: false,
    });
    expect(control.get(help.id).request).toMatchObject({
      status: "taken",
      takenBy: "user-a",
    });
    expect(control.humanMayDrive()).toBe(true);
    // Released: the same person hands it back, and input stops being admitted.
    control.release(help.id);
    expect(control.get(help.id).request).toMatchObject({
      status: "completed",
      takenBy: "user-a",
    });
    expect(control.get().holder).toBe("bot");
    expect(control.humanMayDrive()).toBe(false);
  });

  test("expired outcome lands and releases the lease", () => {
    const { control, advance, request } = fixture();
    const help = request();
    advance(HELP_REQUEST_TTL_MS + 1);
    expect(control.get(help.id).request?.status).toBe("expired");
    expect(control.get().holder).toBe("bot");
    expect(() => control.admitBotAction()()).not.toThrow();
  });

  test("refused outcome lands and releases the lease", async () => {
    const { control, request } = fixture();
    const help = request();
    await control.take(help.id, { userId: "user-a" });
    const after = control.interrupt(
      "A policy refusal ended this takeover.",
      "refused",
    );
    expect(control.get(help.id).request).toMatchObject({
      status: "refused",
      takenBy: "user-a",
    });
    expect(after.holder).toBe("bot");
    expect(control.humanMayDrive()).toBe(false);
    expect(control.admitHumanInput()).toMatchObject({
      ok: false,
      error: TAKE_CONTROL_FIRST,
      status: 409,
    });
  });

  test("two concurrent takes have exactly one winner, the other refused", async () => {
    const { control, request } = fixture();
    const help = request();
    const [a, b] = await Promise.allSettled([
      control.take(help.id, { userId: "user-a" }),
      control.take(help.id, { userId: "user-b" }),
    ]);
    const winners = [a, b].filter((r) => r.status === "fulfilled");
    const losers = [a, b].filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0] as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ControlRequestError);
    expect((loser.reason as ControlRequestError).status).toBe(409);
    expect(control.get().holder).toBe("human");
    expect(control.get(help.id).request?.status).toBe("taken");
  });

  test("a lease already held is not a second person's to re-take", async () => {
    const { control, request } = fixture();
    const help = request();
    await control.take(help.id, { userId: "user-a" });
    await expect(control.take(help.id, { userId: "user-b" })).rejects.toThrow(
      /Another person/,
    );
    // The holder re-taking their own lease is the idempotent join it always was.
    const rejoined = await control.take(help.id, { userId: "user-a" });
    expect(rejoined.holder).toBe("human");
  });

  test("input needs the lease, and the sequence moves only forward", async () => {
    const { control, request } = fixture();
    const refused = control.admitHumanInput();
    expect(refused).toMatchObject({
      ok: false,
      error: TAKE_CONTROL_FIRST,
      status: 409,
    });
    const help = request();
    await control.take(help.id, { userId: "user-a" });
    expect(control.admitHumanInput({ seq: 1 })).toMatchObject({ ok: true });
    expect(control.admitHumanInput({ seq: 2 })).toMatchObject({ ok: true });
    // A replayed or reordered number is stale input and is not admitted.
    expect(control.admitHumanInput({ seq: 1 })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(control.admitHumanInput({ seq: 2 })).toMatchObject({
      ok: false,
      status: 409,
    });
    // A number that is not a sequence at all never reaches the lease.
    expect(control.admitHumanInput({ seq: 1.5 })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(control.admitHumanInput({ seq: 0 })).toMatchObject({
      ok: false,
      status: 400,
    });
    // Unnumbered input from a surface that predates sequences still drives, as before.
    expect(control.admitHumanInput()).toMatchObject({ ok: true });
  });

  test("input after revocation is refused — nothing is delivered", async () => {
    const { control, request } = fixture();
    const help = request();
    await control.take(help.id, { userId: "user-a" });
    control.interrupt("Signed out elsewhere.", "refused");
    expect(control.admitHumanInput({ seq: 3 })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(control.admitHumanInput()).toMatchObject({ ok: false, status: 409 });
  });

  test("the sequence belongs to the lease, not the Bot", async () => {
    const { control, request } = fixture();
    const first = request("call-1");
    await control.take(first.id, { userId: "user-a" });
    expect(control.admitHumanInput({ seq: 7 })).toMatchObject({ ok: true });
    control.release(first.id);
    const second = request("call-2");
    await control.take(second.id, { userId: "user-b" });
    // A fresh lease starts a fresh sequence; user-b's surface never saw user-a's numbers.
    expect(control.admitHumanInput({ seq: 1 })).toMatchObject({ ok: true });
  });

  test("transfer needs release or expiry: a second lease cannot open under a held one", async () => {
    const { control, request } = fixture();
    const help = request();
    await control.take(help.id, { userId: "user-a" });
    // requestHelp while held returns the held lease rather than opening a second one.
    const stillHeld = control.requestHelp("Anything else?", "call-2");
    expect(stillHeld.holder).toBe("human");
    expect(stillHeld.request?.id).toBe(help.id);
    control.release(help.id);
    const next = control.requestHelp("Next task.", "call-3").request!;
    expect(next.id).not.toBe(help.id);
    await control.take(next.id, { userId: "user-b" });
    expect(control.get(next.id).request?.takenBy).toBe("user-b");
  });

  test("a refused lease and its holder survive the store round trip", async () => {
    const { store, control } = stored();
    const help = control.requestHelp("Sign in", "call-1").request!;
    await control.take(help.id, { userId: "user-a" });
    control.interrupt("A policy refusal ended this takeover.", "refused");
    const restored = createControl(() => "2026-10-13T00:00:01Z", { store });
    expect(restored.get(help.id).request).toMatchObject({
      status: "refused",
      takenBy: "user-a",
    });
    expect(restored.get().holder).toBe("bot");
  });
});
