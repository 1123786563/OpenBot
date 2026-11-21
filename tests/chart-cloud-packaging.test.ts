import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = join(import.meta.dir, "../charts/openbot");

test.skipIf(!Bun.which("helm"))("a fresh cloud chart renders without Intelligence and keeps provider keys on the server", () => {
  const result = Bun.spawnSync([
    "helm", "template", "cloud", chart,
    "--values", join(chart, "ci/self-hosted-values.yaml"),
    "--set-json", 'server.extraEnv=[{"name":"OPENBOT_HINDSIGHT_API_URL","value":"http://hindsight.memory.svc:8888"},{"name":"OPENBOT_HINDSIGHT_API_KEY","valueFrom":{"secretKeyRef":{"name":"memory-api","key":"token"}}},{"name":"OPENBOT_OPIK_API_URL","value":"http://opik.telemetry.svc:8080/api"},{"name":"OPENBOT_OPIK_API_KEY","valueFrom":{"secretKeyRef":{"name":"trace-api","key":"token"}}}]',
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);

  const rendered = result.stdout.toString();
  expect(rendered).not.toMatch(/intelligence|copilotkit_license_token|learning-setup/i);
  const documents = parseAllDocuments(rendered);
  const server = documents.find((document) =>
    document.getIn(["metadata", "labels", "app.kubernetes.io/component"]) === "server" &&
    document.get("kind") === "Deployment",
  );
  expect(server?.toString()).toContain("http://hindsight.memory.svc:8888");
  expect(server?.toString()).toContain("http://opik.telemetry.svc:8080/api");
  expect(server?.toString()).toContain("name: memory-api");
  expect(server?.toString()).toContain("name: trace-api");
  for (const document of documents.filter((document) => document !== server)) {
    expect(document.toString()).not.toMatch(/OPENBOT_(HINDSIGHT|OPIK)_|name: (memory-api|trace-api)/);
  }
});
