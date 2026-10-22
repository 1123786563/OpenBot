import { expect, test } from "../../../tests/support/bun-test-compat";
import { probeMastraCompatibility } from "../../src/mastra/compatibility";

test("locked Mastra bridge emits a non-empty native AG-UI text chunk and finishes cleanly", async () => {
  const report = await probeMastraCompatibility();

  expect(report.agentStream.textMessageChunk).toBe(true);
  expect(report.agentStream.text).toContain("mastra-loopback-ok");
  expect(report.agentStream.runFinished).toBe(true);
  expect(report.agentStream.runError).toBe(false);
  expect(report.agentStream.downstreamCanonicalEvent).toBe(
    "TEXT_MESSAGE_CONTENT",
  );
  expect(report.agentStream.normalizationOwner).toBe("Task 6");
});

test("locked Mastra packages suspend and resume a native workflow", async () => {
  const report = await probeMastraCompatibility();

  expect(report.workflowSuspendResume.suspended).toBe(true);
  expect(report.workflowSuspendResume.resumedOutput).toBe("approved-value");
});

test("ME01: locked Mastra runs a tool loop once through the controlled model", async () => {
  const report = await probeMastraCompatibility();

  expect(report.agentToolLoop.toolCallOnce).toBe(true);
  expect(report.agentToolLoop.finalAnswerFromResult).toBe(true);
  expect(report.agentToolLoop.controlledModelSteps).toBe(2);
  expect(report.agentToolLoop.providerRequests).toBe(2);
});

test("ME01: fullStream shapes and suspend/resume API surface are pinned", async () => {
  const report = await probeMastraCompatibility();

  expect(report.agentExecution.fullStreamChunkTypes).toEqual(
    expect.arrayContaining([
      "text-delta",
      "tool-call",
      "tool-result",
      "step-finish",
      "finish",
    ]),
  );
  expect(report.agentExecution.languageModelVersion).toBe("v3");
  expect(report.agentExecution.suspendResumeApiSurface).toEqual({
    listSuspendedRuns: true,
    resumeStream: true,
    approveToolCall: true,
  });
  expect(report.packageVersions["@mastra/core"]).toBe("1.64.0");
});

test("Hono adapter and self-hosted storage constructors are available", async () => {
  const report = await probeMastraCompatibility();

  expect(report.honoMount.status).toBe(200);
  expect(report.storageConstructor.memory).toBe(true);
  expect(report.storageConstructor.postgresStore).toBe(true);
  expect(report.runtime.bun).toBe(Bun.version);
  expect(report.runtime.declaredBun).toBe("bun@1.4.3");
});
