import { randomUUID } from "node:crypto";

/**
 * A programmable fake Bifrost gateway for the probe tests (Bifrost 01.5).
 *
 * It exists so the probe can be pointed at something that answers like the real
 * gateway's management surface — JSON on an authorized GET, refusals elsewhere —
 * while the test stays in charge of what comes back. Every response the test
 * injects, including bodies carrying marker secrets, is produced verbatim; the
 * helper adds nothing of its own. It is test scaffolding only: nothing in
 * `server/src` imports it, and it must never become a production fallback.
 */
export type FakeGatewayRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
};

export type FakeGatewayPlan =
  | {
      kind: "response";
      status: number;
      body?: string;
      headers?: Record<string, string>;
    }
  | {
      /** Hold the request open until `release()` is called (or the caller times out). */
      kind: "hold";
    }
  | {
      /** Never answer at all — the caller's own timeout has to end the request. */
      kind: "hang";
    };

export type FakeGateway = {
  /** The origin to point a probe at: `http://127.0.0.1:<port>` (no path). */
  baseUrl: string;
  /** Requests the gateway received, in order. */
  requests: FakeGatewayRequest[];
  /** Replace the canned response for subsequent requests. */
  respondWith(plan: FakeGatewayPlan): void;
  /** Release every request a `hold` plan is keeping open. */
  release(): void;
  /** The response bodies (if any) this gateway has served, for leak assertions. */
  servedBodies: string[];
  stop(): Promise<void>;
};

/**
 * Marker material a test can inject into a fake response to prove the probe
 * never echoes upstream bytes. The helper derives a few encodings the way a
 * careless log line might plausibly carry them.
 */
export function upstreamSecretMarker(label = randomUUID().slice(0, 8)) {
  const secret = `upstream-secret-${label}-DO-NOT-ECHO`;
  return {
    secret,
    variants: [
      secret,
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
      Buffer.from(secret).toString("hex"),
    ],
  };
}

export async function startFakeGateway(
  initialPlan: FakeGatewayPlan,
): Promise<FakeGateway> {
  const requests: FakeGatewayRequest[] = [];
  const servedBodies: string[] = [];
  let plan = initialPlan;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const authorization = request.headers.get("authorization") ?? undefined;
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization,
      });
      if (plan.kind === "response") {
        if (plan.body !== undefined) servedBodies.push(plan.body);
        return new Response(plan.body ?? "", {
          status: plan.status,
          headers: {
            "content-type": "application/json",
            ...(plan.headers ?? {}),
          },
        });
      }
      if (plan.kind === "hold") {
        await held;
        return Response.json({ released: true });
      }
      // "hang": never answer; the caller's signal has to end it.
      await new Promise(() => {});
      return new Response("", { status: 500 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    servedBodies,
    respondWith(next) {
      plan = next;
    },
    release() {
      release();
    },
    async stop() {
      release();
      await server.stop(true);
    },
  };
}
