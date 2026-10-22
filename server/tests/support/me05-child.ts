import { createDatabase } from "../../src/db/client";
import { resumeMastraContinuation } from "../../src/mastra/approvals";
import { createMastraContinuationStore } from "../../src/mastra/continuation-store";
import { createMastraResumeDriver } from "../../src/mastra/resume-driver";
import {
  buildMe05Stack,
  ME05_AGENT_ID,
  ME05_CHILD_RESULT_PREFIX,
  ME05_INSTRUCTIONS,
  ME05_STORE_SECRET,
  ME05_TOOL_NAME,
} from "./me05-fixture";

/**
 * ME05 resume child: a separate OS process that opens the SAME durable state
 * from the same databases — the OpenBot continuation store and the Mastra
 * snapshot storage — and applies an approved decision through the PRODUCTION
 * path (fix-round-1): the six-gate orchestrator `resumeMastraContinuation`
 * with the single CAS claim, and the production `createMastraResumeDriver`
 * (receipt `started` strictly before the engine can reach the external call).
 * Prints one JSON line prefixed with ME05_CHILD_RESULT.
 *
 * argv: [continuationDbUrl, mastraDbUrl, providerUrl, continuationId, scopeJson, mode?]
 *
 * mode "claim" (default "resume"): claim only, then exit — the concurrency
 * race entry, where exactly one of two processes may win the CAS. It targets
 * the raw store claim deliberately: the race subject IS the CAS primitive the
 * orchestrator rides.
 */
async function main(): Promise<void> {
  const [
    continuationDbUrl,
    mastraDbUrl,
    providerUrl,
    continuationId,
    scopeJson,
  ] = process.argv.slice(2, 7);
  const mode = process.argv[7] === "claim" ? "claim" : "resume";
  if (
    !continuationDbUrl ||
    !mastraDbUrl ||
    !providerUrl ||
    !continuationId ||
    !scopeJson
  ) {
    console.error(
      "usage: me05-child.ts <continuationDbUrl> <mastraDbUrl> <providerUrl> <continuationId> <scopeJson>",
    );
    process.exit(2);
  }
  const database = createDatabase(continuationDbUrl, { max: 2 });
  let stack: Awaited<ReturnType<typeof buildMe05Stack>> | undefined;
  try {
    const store = createMastraContinuationStore({
      database,
      // The SAME secret the parent test wrote the continuation with (the
      // production posture: all processes share one server secret).
      secret: ME05_STORE_SECRET,
    });
    const scope = JSON.parse(scopeJson) as Parameters<
      ReturnType<typeof createMastraContinuationStore>["getContinuation"]
    >[0];
    const record = await store.getContinuation(scope, continuationId);
    if (!record) {
      console.log(
        `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
          ok: false,
          error: "CONTINUATION_NOT_FOUND",
        })}`,
      );
      process.exitCode = 1;
      return;
    }
    // The tool's receipt rows key on the BUSINESS run identity the
    // continuation binds — the exactly-once evidence the parent asserts on.
    process.env.ME05_RUN_ID = record.binding.runId;
    if (mode === "claim") {
      const claim = await store.claimContinuation(scope, record.ref, {
        kind: "approved",
        approvalId: `child-approval-${continuationId}`,
        argsDigest: record.payload.argsDigest,
      });
      console.log(
        `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
          ok: true,
          pid: process.pid,
          mode,
          claimed: true,
          revision: claim.ref.revision,
        })}`,
      );
      return;
    }
    stack = await buildMe05Stack({
      providerUrl,
      dbUrl: mastraDbUrl,
      requireApproval: true,
    });
    // The production resume: same six gates, same CAS, same receipt
    // ordering as the wired copilot install — the loop surface (model,
    // tools, agent id) is re-resolved server-side from the fixture stack,
    // never from the continuation payload.
    const driver = createMastraResumeDriver({
      storageFor: () => stack!.store,
      loopFor: () => ({
        model: stack!.model,
        tools: stack!.tools,
        instructions: [ME05_INSTRUCTIONS],
        agentId: ME05_AGENT_ID,
        durableToolNames: [ME05_TOOL_NAME],
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
          kind: "approved",
          approvalId: `child-approval-${continuationId}`,
          argsDigest: record.payload.argsDigest,
        },
      },
    );
    const probe = await stack.store.pool.query(
      `SELECT receipt_status_at_execute FROM me05_tool_receipts WHERE run_id = $1`,
      [record.binding.runId],
    );
    console.log(
      `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
        ok: true,
        pid: process.pid,
        mode,
        kind: result.kind,
        answer: "answer" in result ? result.answer : undefined,
        finishReason: "finishReason" in result ? result.finishReason : undefined,
        toolCallId: record.payload.toolCallId,
        argsDigest: record.payload.argsDigest,
        receiptStatusAtExecute: probe.rows[0]?.receipt_status_at_execute,
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
    `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
      ok: false,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    })}`,
  );
  process.exitCode = 1;
});
