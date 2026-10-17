import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerControlState } from "../../shared/computer-control";

// A real HTTP dispatcher and shell lease, without launching Chromium. Opt in like live-screen tests
// because agent-computer's own Playwright dependency is not installed by the root unit-test lane.
const asked = process.env.OPENBOT_CONTROL_HTTP === "1";
let root = "";
let base = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
const token = "handoff-http-test-token";
async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "x-openbot-computer-token": token,
      "x-openbot-bot-id": "bot-http",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function control(requestId?: string): Promise<ComputerControlState> {
  const response = await fetch(
    `${base}/control${requestId ? `?requestId=${requestId}` : ""}`,
    {
      headers: {
        "x-openbot-computer-token": token,
        "x-openbot-bot-id": "bot-http",
      },
    },
  );
  expect(response.status).toBe(200);
  return response.json();
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error(
        "Timed out waiting for the HTTP fixture's observable condition.",
      );
    await Bun.sleep(5);
  }
}
beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "control-http-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(hereDir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: token,
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      PORT: String(port),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await until(async () => {
    if (child?.exitCode !== null)
      throw new Error(`Computer fixture exited with ${child?.exitCode}.`);
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    } // Explicit readiness probe, bounded above.
  });
});
afterAll(async () => {
  if (!asked) return;
  child?.kill();
  if (child) await child.exited;
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!asked)(
  "request handoff through the actual computer HTTP dispatcher",
  () => {
    test("take cannot overtake admitted work; later mutations are refused, then freshness is mandatory", async () => {
      const running = post("/exec", {
        command: "printf admitted > admitted; sleep 0.3",
        timeoutMs: 3000,
      });
      await until(() => Bun.file(join(root, "workspace", "admitted")).exists());
      const requested = await post("/control/request", {
        reason: "A human step",
        toolCallId: "http-call",
      });
      const waiting: ComputerControlState = await requested.json();
      expect(waiting.transitioning).toBe(true);
      expect(waiting.holder).toBe("bot");
      const requestId = waiting.request!.id;
      const taking = post("/control/take", { requestId });
      const refused = await post("/files/write", {
        path: "too-late",
        contents: "wrong",
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        humanHasControl: true,
        requestId,
      });
      expect((await control(requestId)).holder).toBe("bot");
      expect((await running).status).toBe(200);
      expect((await (await taking).json()).holder).toBe("human");
      expect(
        (await post("/control/release", { requestId: "wrong" })).status,
      ).toBe(409);
      expect((await post("/control/release", { requestId })).status).toBe(200);
      for (const path of ["/navigate", "/click", "/type", "/key", "/scroll"]) {
        const response = await post(path, {});
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          stale: true,
          snapshotRequired: true,
        });
      }
      expect(
        (await post("/files/write", { path: "after", contents: "allowed" }))
          .status,
      ).toBe(200);
      expect((await control(requestId)).request?.status).toBe("completed");
      const next: ComputerControlState = await (
        await post("/control/request", {
          reason: "Next",
          toolCallId: "next-http-call",
        })
      ).json();
      expect((await post("/control/take", { requestId })).status).toBe(409);
      expect((await control(requestId)).request?.status).toBe("completed");
      expect(
        (await post("/control/cancel", { requestId: next.request!.id })).status,
      ).toBe(200);
    });

    test("a rejected gesture's sequence number is not spent, and revoke carries the observed lease", async () => {
      // Payload validation answers before the lease gate: an invalid scroll is a 400 here,
      // not the 409 a lease-less caller would otherwise get, so the ordering the fix is about
      // is observable without driving a page.
      expect(
        (await post("/human/scroll", { deltaY: "not-a-number", seq: 1 }))
          .status,
      ).toBe(400);

      // The same ordering for the other three gesture paths, observed WITH the wheel:
      // each first bad payload answers 400 (not the 502 of a post-gate throw), and the
      // same seq retried still answers 400 rather than 409 STALE_INPUT_SEQUENCE —
      // the gate must not spend a number on a gesture it refused.
      const wheeled: ComputerControlState = await (
        await post("/control/request", {
          reason: "A seq-ordering check",
          toolCallId: "http-call-seq",
        })
      ).json();
      const wheelId = wheeled.request!.id;
      await post("/control/take", { requestId: wheelId, userId: "seq-holder" });
      expect((await post("/human/click", { seq: 1 })).status).toBe(400);
      expect((await post("/human/click", { seq: 1 })).status).toBe(400);
      expect((await post("/human/type", { seq: 2 })).status).toBe(400);
      expect((await post("/human/type", { seq: 2 })).status).toBe(400);
      expect((await post("/human/key", { seq: 3 })).status).toBe(400);
      expect((await post("/human/key", { seq: 3 })).status).toBe(400);
      await post("/control/release", { requestId: wheelId });

      const requested: ComputerControlState = await (
        await post("/control/request", {
          reason: "A second human step",
          toolCallId: "http-call-2",
        })
      ).json();
      const requestId = requested.request!.id;
      await post("/control/take", { requestId, userId: "holder-1" });
      // A revoke naming a lease that is not the one on the wheel answers take's own 409
      // instead of ending it — and the 409 carries the control-request flag so the server's
      // client maps it to the control-error shape, not the stale-snapshot one.
      const staleReading = await post("/control/revoke", {
        reason: "stale reading",
        requestId: "a-different-lease",
      });
      expect(staleReading.status).toBe(409);
      expect(await staleReading.json()).toMatchObject({
        controlRequestError: true,
      });
      // The observed-none precondition (requestId null — the server read no lease) refuses
      // the same way: a request that went active after that read is exactly the takeover
      // the read-then-revoke window is about, never something to interrupt sight-unseen.
      const sightUnseen = await post("/control/revoke", {
        reason: "read said none",
        requestId: null,
      });
      expect(sightUnseen.status).toBe(409);
      expect(await sightUnseen.json()).toMatchObject({
        controlRequestError: true,
      });
      expect(
        (
          await post("/control/revoke", {
            reason: "wrong holder",
            requestId,
            takenBy: "someone-else",
          })
        ).status,
      ).toBe(409);
      // The observed lease, id and holder both, is the one revoked.
      const revoked = await post("/control/revoke", {
        reason: "logout",
        requestId,
        takenBy: "holder-1",
      });
      expect(revoked.status).toBe(200);
      expect((await revoked.json()).request?.status).toBe("refused");
    });

    test("GET /control answers the computer's last activity, and polls do not refresh it", async () => {
      // The sweep on another server replica reads this field to tell a run
      // being driven elsewhere from an idle computer, so it must move when the
      // computer is used and stay put when it is only polled.
      const before = await control();
      expect(typeof before.lastActivity).toBe("string");
      await Bun.sleep(5);
      const polled = await control();
      expect(polled.lastActivity).toBe(before.lastActivity);
      await post("/control/request", {
        reason: "a clock check",
        toolCallId: "http-call-3",
      });
      const after = await control();
      expect(Date.parse(after.lastActivity ?? "invalid")).toBeGreaterThan(
        Date.parse(before.lastActivity ?? "invalid"),
      );
    });
  },
);
