import { createDatabase } from "../../src/db/client";
import { resumeMastraContinuation } from "../../src/mastra/approvals";
import { createMastraContinuationStore } from "../../src/mastra/continuation-store";
import { createMastraResumeDriver } from "../../src/mastra/resume-driver";
import {
  buildMe06FrontendStack,
  ME06_CHILD_RESULT_PREFIX,
  ME06_INSTRUCTIONS,
  ME06_STORE_SECRET,
} from "./me06-fixture";

/*
 * ME06 resume child: a separate OS process that opens the SAME durable state
 * from the same databases — the OpenBot continuation store and the Mastra
 * snapshot storage — and applies the client's real tool_result decision to a
 * frontend_tool continuation through the PRODUCTION path: the six-gate
 * orchestrator `resumeMastraContinuation` (single CAS claim, receipt
 * `started` fence before the engine can consume the client result) and the
 * production `createMastraResumeDriver` frontend drive. Prints one JSON line
 * prefixed with ME06_CHILD_RESULT.
 *
 * argv: [continuationDbUrl, mastraDbUrl, providerUrl, continuationId, scopeJson, clientResultJson]
 */

async function main(): Promise<void> {
  const [
    continuationDbUrl,
    mastraDbUrl,
    providerUrl,
    continuationId,
    scopeJson,
    clientResultJson,
  ] = process.argv.slice(2, 8);
  if (
    !continuationDbUrl ||
    !mastraDbUrl ||
    !providerUrl ||
    !continuationId ||
    !scopeJson
  ) {
    console.error(
      "usage: me06-child.ts <continuationDbUrl> <mastraDbUrl> <providerUrl> <continuationId> <scopeJson> [clientResultJson]",
    );
    process.exit(2);
  }
  const clientResult =
    clientResultJson === undefined ? undefined : JSON.parse(clientResultJson);
  const database = createDatabase(continuationDbUrl, { max: 2 });
  let stack: Awaited<ReturnType<typeof buildMe06FrontendStack>> | undefined;
  try {
    const store = createMastraContinuationStore({
      database,
      // The SAME secret the parent test wrote the continuation with (the
      // production posture: all processes share one server secret).
      secret: ME06_STORE_SECRET,
    });
    const scope = JSON.parse(scopeJson) as Parameters<
      ReturnType<typeof createMastraContinuationStore>["getContinuation"]
    >[0];
    const record = await store.getContinuation(scope, continuationId);
    if (!record) {
      console.log(
        `${ME06_CHILD_RESULT_PREFIX}${JSON.stringify({
          ok: false,
          error: "CONTINUATION_NOT_FOUND",
        })}`,
      );
      process.exitCode = 1;
      return;
    }
    stack = await buildMe06FrontendStack({
      providerUrl,
      dbUrl: mastraDbUrl,
      // The suspension was written under the execution path's agent id
      // (`openbot-<botId>`); the resumed stack MUST carry the same identity.
      agentId: `openbot-${record.binding.botId}`,
    });
    // The production resume: same six gates, same CAS, same receipt ordering
    // as the wired copilot install — the loop surface (model, tools, agent
    // id) is re-resolved server-side from the fixture stack, never from the
    // continuation payload.
    const driver = createMastraResumeDriver({
      storageFor: () => stack!.store,
      loopFor: () => ({
        model: stack!.model,
        tools: stack!.tools,
        instructions: [ME06_INSTRUCTIONS],
      }),
    });
    const result = await resumeMastraContinuation(
      {
        store,
        toolGrantCurrent: async () => true,
        generationCurrent: async () => true,
        driver,
      },
      {
        scope,
        ref: record.ref,
        decision: {
          kind: "tool_result",
          receiptId: `child-tool-result-${continuationId}`,
          result: clientResult,
        },
      },
    );
    const receipts = await stack.store.pool.query(
      `SELECT status FROM mastra_execution_receipts WHERE run_id = $1`,
      [record.binding.runId],
    );
    console.log(
      `${ME06_CHILD_RESULT_PREFIX}${JSON.stringify({
        ok: true,
        pid: process.pid,
        kind: result.kind,
        answer: "answer" in result ? result.answer : undefined,
        finishReason:
          "finishReason" in result ? result.finishReason : undefined,
        toolCallId: record.payload.toolCallId,
        argsDigest: record.payload.argsDigest,
        receiptStatuses: receipts.rows.map((row) => row.status),
      })}`,
    );
  } finally {
    // Cleanup must never overwrite the real failure evidence the catch above
    // reports (the same convention as the database close beside it).
    await stack?.store.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.log(
    `${ME06_CHILD_RESULT_PREFIX}${JSON.stringify({
      ok: false,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    })}`,
  );
  process.exitCode = 1;
});
