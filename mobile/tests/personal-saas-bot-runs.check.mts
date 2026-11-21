import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { personalBotRuns } from "../src/personal-saas-bot-runs.ts";

test("mobile sends the original submission key and reads a settled Test Credit receipt", async () => {
  const runId = "a".repeat(64);
  const requestId = "00000000-0000-4000-8000-000000000000";
  const quote = { route: "pilot", priceVersion: requestId };
  const input = {
    workspaceId: "workspace-1",
    botId: "bot-1",
    instruction: "Hello",
    requestId,
    quote,
  };
  const status = {
    state: "completed",
    output: "Managed answer",
    testCredit: {
      model: "Pilot model",
      state: "settled",
      heldMicrocredits: "0",
      chargedMicrocredits: "3",
      releasedMicrocredits: "247",
    },
  };
  const runs = personalBotRuns(async (path, request) => {
    if (request.method === "POST") {
      strictEqual(path, "/api/workspace/bot-runs");
      strictEqual(
        new Headers(request.headers).get("Idempotency-Key"),
        requestId,
      );
      deepStrictEqual(JSON.parse(String(request.body)), {
        workspaceId: "workspace-1",
        botId: "bot-1",
        instruction: "Hello",
        execution: "test-credit",
        quote,
      });
      return Response.json({ runId }, { status: 202 });
    }
    strictEqual(path, `/api/workspace/bot-runs/${runId}`);
    return Response.json(status);
  });

  deepStrictEqual(await runs.start(input), { runId });
  deepStrictEqual(await runs.status(runId), status);

  const changedPrice = { error: "test_credit_quote_changed" };
  const changedRuns = personalBotRuns(async () =>
    Response.json(changedPrice, { status: 409 }),
  );
  deepStrictEqual(await changedRuns.start(input), changedPrice);
});
