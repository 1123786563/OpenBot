import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = join(import.meta.dir, "../charts/openbot");
const helm = Bun.which("helm");

function render(...args: string[]) {
  const result = Bun.spawnSync([
    "helm",
    "template",
    "openbot",
    chart,
    "--values",
    join(chart, "ci/vanilla-values.yaml"),
    ...args,
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return parseAllDocuments(result.stdout.toString()).flatMap((document) =>
    document.contents ? [document.toJSON()] : [],
  );
}

function workload(docs: ReturnType<typeof render>, kind: string, name: string) {
  const doc = docs.find(
    (doc) => doc.kind === kind && doc.metadata.name === name,
  );
  if (!doc) throw new Error(`${kind} ${name} was not rendered`);
  return doc.spec.jobTemplate?.spec.template.spec ?? doc.spec.template.spec;
}

function server(docs: ReturnType<typeof render>) {
  return workload(docs, "Deployment", "openbot-server").containers[0];
}

test.skipIf(!helm)(
  "passes the browser URL only to the API server",
  () => {
    const name = "OPENBOT_OPENOBSERVE_URL";
    const value = "https://observe.example.test/ops/";
    const docs = render(
      "--set-string",
      `config.openObserveUrl=${value}`,
      "--set",
      "routines.enabled=true",
    );
    expect(server(docs).env).toContainEqual({ name, value });
    expect(
      workload(docs, "CronJob", "openbot-routines").containers[0].env,
    ).not.toContainEqual(expect.objectContaining({ name }));
    expect(
      workload(docs, "Job", "openbot-migrations-1").containers[0].env,
    ).not.toContainEqual(expect.objectContaining({ name }));
    expect(server(render()).env).not.toContainEqual(
      expect.objectContaining({ name }),
    );
  },
  20_000,
);

test.skipIf(!helm)(
  "sets deployment identity for API, routine sweep and migration logs",
  () => {
    const docs = render(
      "--set-string",
      "config.deploymentId=production-east",
      "--set-string",
      "config.otel.serviceName=openbot-east",
      "--set",
      "routines.enabled=true",
    );
    for (const container of [
      server(docs),
      workload(docs, "CronJob", "openbot-routines").containers[0],
      workload(docs, "Job", "openbot-migrations-1").containers[0],
    ]) {
      expect(container.env).toEqual(
        expect.arrayContaining([
          { name: "DEPLOYMENT_ID", value: "production-east" },
          { name: "OTEL_SERVICE_NAME", value: "openbot-east" },
        ]),
      );
    }
  },
  20_000,
);

test.skipIf(!helm)(
  "renders a generic endpoint and admits the configured Collector through server egress",
  () => {
    const docs = render(
      "--set-string",
      "config.otel.endpoint=https://collector.example:4318",
      "--set",
      "networkPolicy.enabled=true",
      "--set",
      "networkPolicy.extraEgress[0].to[0].namespaceSelector.matchLabels.observability=enabled",
      "--set",
      "networkPolicy.extraEgress[0].to[0].podSelector.matchLabels.app=collector",
      "--set",
      "networkPolicy.extraEgress[0].ports[0].port=4318",
      "--set",
      "networkPolicy.extraEgress[0].ports[0].protocol=TCP",
    );
    expect(server(docs).env).toContainEqual({
      name: "OTEL_EXPORTER_OTLP_ENDPOINT",
      value: "https://collector.example:4318",
    });
    const policy = docs.find(
      (doc) =>
        doc.kind === "NetworkPolicy" && doc.metadata.name === "openbot-server",
    );
    expect(policy?.spec.egress).toContainEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { observability: "enabled" } },
          podSelector: { matchLabels: { app: "collector" } },
        },
      ],
      ports: [{ port: 4318, protocol: "TCP" }],
    });
  },
  20_000,
);

test.skipIf(!helm)(
  "renders a paused logs-only endpoint and keeps ingestion credentials in the Secret",
  () => {
    const credential = "x-api-key=logs-fixture";
    const docs = render(
      "--set-string",
      "config.otel.logsEndpoint=https://collector.example/ingest",
      "--set",
      "config.otel.paused=true",
      "--set-string",
      `secrets.otelLogsHeaders=${credential}`,
      "--set",
      "routines.enabled=true",
    );
    expect(server(docs).env).toContainEqual({
      name: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      value: "https://collector.example/ingest",
    });
    expect(server(docs).env).toContainEqual({
      name: "OPENBOT_OTEL_EXPORT",
      value: "off",
    });
    expect(server(docs).env).toContainEqual({
      name: "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
      valueFrom: {
        secretKeyRef: {
          name: "openbot-secrets",
          key: "otel-logs-headers",
          optional: true,
        },
      },
    });
    const secret = docs.find(
      (doc) => doc.kind === "Secret" && doc.metadata.name === "openbot-secrets",
    );
    expect(secret?.stringData["otel-logs-headers"]).toBe(credential);
    expect(
      docs.filter((doc) => JSON.stringify(doc).includes(credential)),
    ).toEqual([secret]);
    const otherPods = docs.filter(
      (doc) =>
        doc.kind !== "Deployment" || doc.metadata.name !== "openbot-server",
    );
    expect(JSON.stringify(otherPods)).not.toContain(
      "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    );
  },
  20_000,
);

test.skipIf(!helm)(
  "reads logs headers from an externally managed Secret",
  () => {
    const docs = render(
      "--set-string",
      "config.otel.logsEndpoint=https://collector.example/ingest",
      "--set-string",
      "secrets.existingSecret=deployment-secrets",
      "--set",
      "intelligence.enabled=false",
      "--set-string",
      "config.intelligence.apiUrl=https://intelligence.example",
      "--set-string",
      "config.intelligence.gatewayWsUrl=wss://intelligence.example",
    );
    expect(server(docs).env).toContainEqual({
      name: "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
      valueFrom: {
        secretKeyRef: {
          name: "deployment-secrets",
          key: "otel-logs-headers",
          optional: true,
        },
      },
    });
    expect(
      docs.some(
        (doc) =>
          doc.kind === "Secret" && doc.metadata.name === "deployment-secrets",
      ),
    ).toBe(false);
  },
  20_000,
);

test.skipIf(!helm)(
  "renders a normal install with no deployment identity or exporter configured",
  () => {
    expect(
      server(render())
        .env.map((entry: { name: string }) => entry.name)
        .filter(
          (name: string) =>
            name === "DEPLOYMENT_ID" ||
            name.startsWith("OTEL_") ||
            name === "OPENBOT_OTEL_EXPORT",
        ),
    ).toEqual([]);
  },
  20_000,
);
