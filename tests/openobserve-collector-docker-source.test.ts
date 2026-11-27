import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const deploy = join(import.meta.dir, "../deploy");
const packages = join(deploy, "1panel/apps/openobserve");
// The package directory is named for the release it ships, so a version bump must not break this check.
const copies = [
  "openobserve/otel-collector.yaml",
  ...readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(
      (entry) => `1panel/apps/openobserve/${entry.name}/otel-collector.yaml`,
    ),
];

type Operator = { type?: string; field?: string; value?: unknown };
type Context = { conditions?: string[]; statements?: string[] };

const text = (path: string) => readFileSync(join(deploy, path), "utf8");
const collector = (path: string) =>
  parse(text(path)) as {
    receivers: { "filelog/docker"?: { operators?: Operator[] } };
    processors: { "transform/runtime"?: { log_statements?: Context[] } };
  };

test("every copy of the Collector configuration is the same file", () => {
  expect(copies.length).toBeGreaterThan(1);
  for (const path of copies.slice(1)) expect(text(path)).toBe(text(copies[0]));
});

// Docker's log directory holds every container on the host. A line from there that is not an
// OpenBot record must not become an OpenBot "unmigrated" marker, or every other service's log line
// is counted as this deployment's.
test("Docker's log directory yields OpenBot records only", () => {
  for (const path of copies) {
    const { receivers, processors } = collector(path);

    expect(receivers["filelog/docker"]?.operators).toContainEqual({
      type: "add",
      field: "attributes.docker_source",
      value: "docker",
      on_error: "drop_quiet",
    });

    const contexts = processors["transform/runtime"]?.log_statements ?? [];
    expect(contexts[0]?.statements?.[0]).toBe(
      'keep_keys(log.attributes, ["cri_stream", "docker_source"])',
    );
    const markers = contexts.filter((context) =>
      context.statements?.includes(
        'set(log.attributes["diagnostic"], "Unmigrated process log line.")',
      ),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.conditions).toContain(
      'log.attributes["cri_stream"] != nil and log.attributes["docker_source"] != "docker"',
    );
  }
});
