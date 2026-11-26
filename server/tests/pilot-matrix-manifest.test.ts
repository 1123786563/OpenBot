import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePilotMatrixManifest } from "../scripts/pilot-matrix-manifest";
import { loadPilotTarget } from "../scripts/pilot-matrix-target";

const targetConfig = {
  PILOT_EVIDENCE: "deployment",
  PILOT_TARGET_URL: "https://pilot.example/api/billing",
  PILOT_TARGET_TOKEN: "fixture-execution-secret",
  PILOT_DEPLOYMENT_ID: "pilot-1",
  PILOT_SOURCE_COMMIT: "a".repeat(40),
  PILOT_BUILD_VERSION: "build-3",
  PILOT_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  PILOT_GATEWAY_URL: "https://gateway.example/v1/chat/completions",
  PILOT_GATEWAY_REVISION: "target-g",
};

test("the evidence file contains only public fields and deterministic signoff references", async () => {
  const target = loadPilotTarget(targetConfig);
  expect(() =>
    loadPilotTarget({ ...targetConfig, PILOT_SOURCE_COMMIT: "" }),
  ).toThrow("provenance");
  const directory = await mkdtemp(join(tmpdir(), "pilot-private-path-"));
  try {
    const startedAt = Date.parse("2026-11-26T10:00:00Z");
    const results = [
      {
        scenario: "target-model-switch",
        operationIds: ["op-a", "op-b", "op-a"],
        outcome: "pass",
        detail: { description: "fixture-execution-secret" },
      },
      {
        scenario: "target-lago-reconciliation",
        operationIds: ["op-a"],
        outcome: "fail",
        reason: "lago_event_unmatched",
        error: "postgres://user:fixture-db-secret@db",
        detail: {
          cookie: "fixture-cookie-secret",
          description: "fixture-response-secret",
        },
      },
    ] as const;
    const manifest = await writePilotMatrixManifest(
      directory,
      target,
      startedAt,
      results,
    );
    const file = Bun.file(join(directory, "manifest.json"));
    const contents = await file.text();
    expect(JSON.parse(contents)).toEqual(manifest);
    expect(manifest).toMatchObject({
      evidence: "deployment",
      creditScope: "test",
      deployment: {
        id: "pilot-1",
        sourceCommit: targetConfig.PILOT_SOURCE_COMMIT,
        buildVersion: "build-3",
        imageDigest: targetConfig.PILOT_IMAGE_DIGEST,
      },
      passed: 1,
      failed: 1,
      scenarios: [
        {
          scenario: "target-model-switch",
          outcome: "pass",
          operationIds: ["op-a", "op-b"],
        },
        {
          scenario: "target-lago-reconciliation",
          outcome: "fail",
          operationIds: ["op-a"],
          reason: "lago_event_unmatched",
        },
      ],
    });
    const deploymentRef = `pilot-matrix/pilot-1/${targetConfig.PILOT_SOURCE_COMMIT}/build-3/${targetConfig.PILOT_IMAGE_DIGEST}`;
    expect(manifest.deploymentRef).toBe(deploymentRef);
    expect(manifest.rampRef).toMatch(/\/runs\/[a-f0-9]{64}$/);
    expect(manifest.rampRef?.startsWith(deploymentRef)).toBe(true);
    for (const privateValue of [
      directory,
      "fixture-execution-secret",
      "fixture-db-secret",
      "fixture-cookie-secret",
      "fixture-response-secret",
      "pilot.example",
    ]) {
      expect(contents).not.toContain(privateValue);
    }
    await writePilotMatrixManifest(directory, target, startedAt, results);
    expect(await file.text()).toBe(contents);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a failed matrix CLI run writes a shareable fixture manifest and exits nonzero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-matrix-cli-"));
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/gateway") return new Response(null, { status: 403 });
      if (path === "/billing/v1/quote")
        return Response.json({
          route: "route-a",
          priceVersion: "fixture-price",
        });
      return Response.json(
        { message: "fixture-private-upstream-body" },
        { status: 401 },
      );
    },
  });
  try {
    const script = fileURLToPath(
      new URL("../scripts/pilot-matrix.ts", import.meta.url),
    );
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", script, directory],
      env: {
        PILOT_EVIDENCE: "fixture",
        PILOT_TARGET_URL: `${fixture.url.origin}/billing`,
        PILOT_GATEWAY_URL: `${fixture.url.origin}/gateway`,
        PILOT_TARGET_TOKEN: "fixture-execution-secret",
        PILOT_TARGET_DATABASE_URL:
          "postgres://user:fixture-db-secret@127.0.0.1:1/unused",
        PILOT_LAGO_URL: fixture.url.origin,
        LAGO_API_KEY: "fixture-lago-secret",
        LAGO_USAGE_SUBSCRIPTION_ID: "fixture-subscription",
        PILOT_TOKEN_A: "fixture-token-a",
        PILOT_TOKEN_B: "fixture-token-b",
        PILOT_TOKEN_C: "fixture-token-c",
        PILOT_SESSION_COOKIE_A: "session=fixture-cookie-a",
        PILOT_SESSION_COOKIE_B: "session=fixture-cookie-b",
        PILOT_SESSION_COOKIE_C: "session=fixture-cookie-c",
        PILOT_ROUTE_A: "route-a",
        PILOT_ROUTE_B: "route-b",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(1);
    const file = Bun.file(join(directory, "manifest.json"));
    const contents = await file.text();
    expect(JSON.parse(contents)).toMatchObject({
      evidence: "fixture",
      deployment: null,
      deploymentRef: null,
      rampRef: null,
      passed: 1,
      failed: 7,
      scenarios: expect.arrayContaining([
        {
          scenario: "target-model-switch",
          outcome: "fail",
          operationIds: [expect.stringMatching(/^[a-f0-9-]{36}$/)],
          reason: "product_request_failed",
        },
        {
          scenario: "target-lago-reconciliation",
          outcome: "fail",
          operationIds: [],
          reason: "model_switch_incomplete",
        },
      ]),
    });
    expect(contents).not.toContain("fixture-private-upstream-body");
    expect(contents).not.toContain("fixture-cookie");
    expect(contents).not.toContain("fixture-db-secret");
    expect(await Bun.file(join(directory, "matrix.json")).exists()).toBe(true);
  } finally {
    fixture.stop(true);
    await rm(directory, { recursive: true });
  }
});
