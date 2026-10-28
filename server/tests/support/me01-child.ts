import { buildMe01Stack, ME01_CHILD_RESULT_PREFIX } from "./me01-fixture";

/**
 * ME01 resume child: a separate OS process that loads the same durable stack
 * from the same storage, lists the suspended run, and resumes the exact
 * pending operation. Prints one JSON line prefixed with ME01_CHILD_RESULT.
 *
 * argv: [dbUrl, providerUrl, runId]
 */
async function main(): Promise<void> {
  const [dbUrl, providerUrl, runId] = process.argv.slice(2);
  if (!dbUrl || !providerUrl || !runId) {
    console.error("usage: me01-child.ts <dbUrl> <providerUrl> <runId>");
    process.exit(2);
  }
  process.env.ME01_RUN_ID = runId;
  // Every path closes the pool: an open PostgresStore holds TCP handles that
  // keep this process alive, and the parent test only awaits 'exit' — an
  // exception leaking the pool would hang the whole case to the runner
  // timeout instead of failing fast on the result line. The build itself is
  // inside the try: a failure after the store was constructed (e.g. a DDL
  // query erroring on a live pool) must still reach the finally, so the
  // optional reference gets closed instead of the process hanging on the
  // leaked TCP handle.
  let stack: Awaited<ReturnType<typeof buildMe01Stack>> | undefined;
  try {
    stack = await buildMe01Stack({
      dbUrl,
      providerUrl,
      requireApproval: true,
    });
    const { agent, controlled } = stack;
    const suspended = await agent.listSuspendedRuns();
    const run = suspended.runs.find((candidate) => candidate.runId === runId);
    if (!run) {
      console.log(
        `${ME01_CHILD_RESULT_PREFIX}${JSON.stringify({
          ok: false,
          error: "SUSPENDED_RUN_NOT_FOUND",
          discovered: suspended.runs.map((candidate) => candidate.runId),
        })}`,
      );
      process.exitCode = 1;
      return;
    }
    const toolCall = run.toolCalls[0];
    const output = await agent.resumeStream(
      { approved: true },
      {
        runId,
        ...(toolCall?.toolCallId ? { toolCallId: toolCall.toolCallId } : {}),
      },
    );
    const reader = output.fullStream.getReader();
    const types: string[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      types.push(String((next.value as { type?: string }).type));
    }
    const finishReason = await output.finishReason;
    const text = await output.text;
    console.log(
      `${ME01_CHILD_RESULT_PREFIX}${JSON.stringify({
        ok: true,
        pid: process.pid,
        answer: text,
        finishReason,
        chunkTypes: types,
        controlledModelCalls: controlled.doStreamCalls(),
        suspendedToolCalls: run.toolCalls,
      })}`,
    );
  } finally {
    // A close() rejection must not overwrite the real failure evidence the
    // catch below reports (the fixture/me05-child cleanup convention).
    await stack?.store.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.log(
    `${ME01_CHILD_RESULT_PREFIX}${JSON.stringify({
      ok: false,
      // The stack, not just the message: the parent test otherwise cannot
      // tell WHICH probe (buildMe01Stack / listSuspendedRuns / resumeStream)
      // failed. JSON.stringify escapes the newlines, so the single-line
      // result contract holds.
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    })}`,
  );
  process.exitCode = 1;
});
