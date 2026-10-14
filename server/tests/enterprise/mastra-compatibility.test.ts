import { expect, test } from "bun:test";
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

test("Hono adapter and self-hosted storage constructors are available", async () => {
  const report = await probeMastraCompatibility();

  expect(report.honoMount.status).toBe(200);
  expect(report.storageConstructor.memory).toBe(true);
  expect(report.storageConstructor.postgresStore).toBe(true);
  expect(report.runtime.bun).toBe(Bun.version);
  expect(report.runtime.declaredBun).toBe("bun@1.3.14");
});
