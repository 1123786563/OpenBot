import { expect, test } from "bun:test";
import { createOpikClient } from "../src/opik/client";

test("Opik receives only allowlisted fields even when callers have content", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        body: await request.json(),
      });
      return new Response(null, { status: 204 });
    },
  });
  try {
    const opik = createOpikClient({
      apiUrl: new URL("api/", server.url),
      project: "test",
    });
    const trace = {
      id: "019330f0-1234-7890-abcd-123456789abc",
      startedAt: new Date("2026-11-20T00:00:00Z"),
      finishedAt: new Date("2026-11-20T00:00:01Z"),
      status: "completed" as const,
      incomplete: false,
      prompt: "private message",
      toolPayload: { secret: "private tool invocation" },
      memory: "private memory",
    };
    await opik.trace(trace);
    const feedback = {
      traceId: trace.id,
      score: 1,
      comment: "private feedback",
    };
    await opik.score(feedback);
    expect(requests).toEqual([
      {
        path: "/api/v1/private/traces/batch",
        method: "POST",
        body: {
          traces: [
            {
              id: trace.id,
              name: "OpenBot Run",
              project_name: "test",
              start_time: "2026-11-20T00:00:00.000Z",
              end_time: "2026-11-20T00:00:01.000Z",
              metadata: {
                status: "completed",
                duration_ms: 1000,
                incomplete: false,
              },
            },
          ],
        },
      },
      {
        path: "/api/v1/private/traces/feedback-scores",
        method: "PUT",
        body: {
          scores: [
            {
              id: trace.id,
              project_name: "test",
              name: "user_feedback",
              source: "sdk",
              value: 1,
            },
          ],
        },
      },
    ]);
  } finally {
    server.stop(true);
  }
});
