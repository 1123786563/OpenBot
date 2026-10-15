import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import versions from "../../docker/opik/versions.json";

const repoRoot = join(import.meta.dir, "..", "..");
const compose = readFileSync(join(repoRoot, "docker/compose/opik.yml"), "utf8");

const FLOATING = ["latest", "stable", "edge", "main", "master", "dev"];

describe("docker/opik/versions.json", () => {
  test("no image is pinned to a floating tag", () => {
    for (const [name, image] of Object.entries(versions.opik.images)) {
      for (const floating of FLOATING) {
        expect(image.tag.toLowerCase(), `${name} tag`).not.toBe(floating);
        expect(image.tag.toLowerCase(), `${name} tag contains`).not.toContain(
          `:${floating}`,
        );
      }
      expect(image.digest, `${name} digest`).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("the Opik version and upstream commit are exact, not a range", () => {
    expect(versions.opik.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versions.opik.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(versions.opik.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("the SDK version is exact", () => {
    expect(versions.sdk.typescript).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("compatibility is verified by ticket #10 with real-instance evidence", () => {
    // T04 (#10) flipped this after proving ingest, query, evaluation, id mapping and
    // deletion against a real instance; the evidence manifest must stay traceable.
    expect(versions.compatibility.status).toBe("verified");
    expect(versions.compatibility.verifiedBy).toBe("#10");
    expect(versions.compatibility.verifiedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    expect(versions.compatibility.evidence).toMatch(
      /47-manifest\.json, sha256 [0-9a-f]{64}$/,
    );
  });
});

describe("docker/compose/opik.yml", () => {
  test("the demo data generator and jaeger are not part of the stack", () => {
    expect(compose).not.toMatch(/^\s{2}demo-data-generator:/m);
    expect(compose).not.toMatch(/^\s{2}jaeger:/m);
  });

  test("the compose file names the openbot project like every other optional stack", () => {
    expect(compose).toMatch(/^name:\s*openbot$/m);
  });

  test("the default OPIK_VERSION matches the pinned versions.json", () => {
    const fallback = /\$\{OPIK_VERSION:-([^}]+)\}/.exec(compose)?.[1];
    expect(
      fallback,
      "compose must not default to a floating tag",
    ).toBeDefined();
    expect(fallback).toBe(versions.opik.version);
  });
});

const envExample = readFileSync(join(repoRoot, ".env.example"), "utf8");
const opikDocs = readFileSync(join(repoRoot, "docs/opik.md"), "utf8");
const rootCompose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");

/** The exact variable names T09 (#15) will read from config.ts. */
const CONTRACT_VARS = [
  "OPIK_ENABLED",
  "OPIK_BASE_URL",
  "OPIK_API_KEY",
  "OPIK_WORKSPACE_NAME",
  "OPIK_PORT",
  "OPIK_OTLP_HTTP_PORT",
  "OPIK_OTLP_GRPC_PORT",
];

describe("configuration surface", () => {
  test("every contract variable is documented in .env.example", () => {
    for (const name of CONTRACT_VARS) {
      expect(envExample, `${name} must appear in .env.example`).toContain(name);
    }
  });

  test("the integration is off by default: every OPIK_ line in .env.example is commented out", () => {
    const lines = envExample
      .split("\n")
      .filter((l) => /^\s*[^#\s].*OPIK_/.test(l));
    expect(lines, `uncommented OPIK_ defaults: ${lines.join(", ")}`).toEqual(
      [],
    );
  });

  test("no secret value is written into .env.example or the docs", () => {
    for (const text of [envExample, opikDocs, compose]) {
      expect(text).not.toMatch(/OPIK_API_KEY\s*=\s*["']?[A-Za-z0-9]{16,}/);
      expect(text).not.toMatch(
        /OPIK_(MYSQL|CLICKHOUSE)_\w*PASSWORD\s*=\s*["']?[^\s"'$]{6,}/,
      );
    }
  });

  test("docs/opik.md gives the run command, the health check and the port rationale", () => {
    expect(opikDocs).toContain(
      "docker compose --project-directory . -f docker/compose/opik.yml up -d",
    );
    expect(opikDocs).toContain("health-check");
    expect(opikDocs).toContain("4318");
    expect(opikDocs).toContain("5418");
    expect(opikDocs).toContain("versions.json");
  });

  test("the optional stack is listed where the other optional stacks are listed", () => {
    expect(rootCompose).toContain("opik.yml");
  });
});

// The port and image guards assert against `docker compose config` output, not the raw
// YAML: the raw file's ${OPIK_PORT:-...} syntax made the old regex match zero lines
// (T03-F1), and YAML anchors hid the real image string from the old scan (T03-F2). The
// rendered config shows exactly what Compose would run, anchors resolved and variables
// interpolated. Rendering needs no daemon and no running Opik.
const STACK_SERVICES = [
  "backend",
  "clickhouse",
  "frontend",
  "mc",
  "minio",
  "mysql",
  "otel-collector",
  "python-backend",
  "redis",
  "zookeeper",
];

type RenderedPort = { host_ip?: string; published?: number | string | null };
type RenderedService = { image?: string; ports?: RenderedPort[] };
type RenderedConfig = { services?: Record<string, RenderedService> };

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
/** Placeholder values for the compose file's six `:?` credentials; no real secret. */
const RENDER_CREDENTIALS = {
  OPIK_MYSQL_PASSWORD: "guard",
  OPIK_MYSQL_ROOT_PASSWORD: "guard",
  OPIK_CLICKHOUSE_PASSWORD: "guard",
  OPIK_REDIS_PASSWORD: "guard",
  OPIK_MINIO_ROOT_USER: "guard",
  OPIK_MINIO_ROOT_PASSWORD: "guard",
};

let scratchDir: string;
const renderedConfigs = new Map<string, RenderedConfig>();

function renderComposeConfig(file: string): RenderedConfig {
  const cached = renderedConfigs.get(file);
  if (cached) return cached;
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      repoRoot,
      "--env-file",
      join(scratchDir, "empty.env"),
      "-f",
      file,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? tmpdir(),
        ...RENDER_CREDENTIALS,
      },
    },
  );
  if (result.error) {
    throw new Error(
      `docker compose is unavailable (${result.error.message}); the deployment guard fails closed, it does not skip`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `docker compose config rejected ${file} (exit ${result.status}): ${result.stderr}`,
    );
  }
  let config: RenderedConfig;
  try {
    config = JSON.parse(result.stdout) as RenderedConfig;
  } catch (error) {
    throw new Error(
      `docker compose config emitted unparseable output for ${file}: ${error}`,
    );
  }
  if (Object.keys(config.services ?? {}).length === 0) {
    throw new Error(
      `docker compose config rendered no services for ${file}; the guard fails closed`,
    );
  }
  renderedConfigs.set(file, config);
  return config;
}

function publishedHostPorts(config: RenderedConfig): string[] {
  const published: string[] = [];
  for (const service of Object.values(config.services ?? {})) {
    for (const port of service.ports ?? []) {
      if (port.published != null && port.published !== "") {
        published.push(String(port.published));
      }
    }
  }
  return published;
}

/**
 * Every rendered `ports` entry is a publish intent, so each must carry an explicit
 * loopback host_ip and a fixed host port; a missing host_ip binds 0.0.0.0 and a missing
 * published port takes an ephemeral one.
 */
function nonLoopbackBindings(config: RenderedConfig): string[] {
  const exposed: string[] = [];
  for (const [name, service] of Object.entries(config.services ?? {})) {
    for (const port of service.ports ?? []) {
      const host = port.host_ip ?? "<any-interface>";
      const published =
        port.published == null || port.published === ""
          ? "<ephemeral>"
          : String(port.published);
      if (!LOOPBACK.has(host)) {
        exposed.push(`${name} ${host}:${published}`);
      }
    }
  }
  return exposed;
}

function floatingImageRefs(config: RenderedConfig): string[] {
  const floating: string[] = [];
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const image = service.image?.trim();
    if (!image) {
      floating.push(`${name}: <no image>`);
      continue;
    }
    if (image.includes("@sha256:")) continue; // digest-pinned is exact
    const tag = image.slice(image.lastIndexOf(":") + 1);
    if (tag.includes("/") || FLOATING.includes(tag.toLowerCase())) {
      // A tag containing "/" means there was no tag at all (or only a registry port),
      // which Docker resolves to the floating implicit :latest.
      floating.push(`${name}: ${image}`);
    }
  }
  return floating;
}

describe("deployment guard on the rendered Compose configuration", () => {
  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "opik-guard-"));
    // An empty env file keeps interpolation deterministic: no ambient root .env or
    // exported OPIK_* value can change what the guard sees.
    writeFileSync(join(scratchDir, "empty.env"), "");
  });
  afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

  const renderStack = () => renderComposeConfig("docker/compose/opik.yml");

  test("renders the full target stack, failing closed when Compose cannot render it", () => {
    expect(Object.keys(renderStack().services ?? {}).sort()).toEqual(
      [...STACK_SERVICES].sort(),
    );
  }, 60_000);

  test("every published port binds loopback only", () => {
    const config = renderStack();
    expect(publishedHostPorts(config), "guard matched no ports").not.toEqual(
      [],
    );
    expect(nonLoopbackBindings(config)).toEqual([]);
  }, 60_000);

  test("the OTLP host ports do not collide with the existing Tempo stack", () => {
    // docker/compose/observability.yml already publishes 4318/4317 on loopback for Tempo.
    const hosts = publishedHostPorts(renderStack());
    for (const taken of ["4317", "4318", "3200", "3102", "3003"]) {
      expect(
        hosts,
        `host port ${taken} belongs to the LGTM stack`,
      ).not.toContain(taken);
    }
  }, 60_000);

  test("no floating or tagless image reference in the rendered stack", () => {
    const config = renderStack();
    const images = Object.values(config.services ?? {})
      .map((service) => service.image)
      .filter((image): image is string => Boolean(image));
    expect(images, "guard matched no images").not.toEqual([]);
    expect(floatingImageRefs(config)).toEqual([]);
  }, 60_000);

  function mutatedFixture(name: string, from: string, to: string): string {
    if (!compose.includes(from)) {
      throw new Error(
        `mutation fixture is stale — pattern no longer in docker/compose/opik.yml: ${from}`,
      );
    }
    // Function replacement: the fixture strings contain ${...}, which String.replace
    // would otherwise interpret as substitution patterns.
    const file = join(scratchDir, name);
    writeFileSync(
      file,
      compose.replace(from, () => to),
    );
    return file;
  }

  test("a 0.0.0.0 bind on the Opik UI is caught in the rendered config (T03-F1)", () => {
    // \${ escapes the placeholder syntax so the literal survives Biome's
    // noTemplateCurlyInString: the ${OPIK_PORT:-…} is Compose interpolation, not a JS
    // template placeholder.
    const uiPortLine = (host: string) =>
      `- "${host}:\${OPIK_PORT:-5174}:\${NGINX_PORT:-5173}"`;
    const file = mutatedFixture(
      "ui-open-to-world.yml",
      uiPortLine("127.0.0.1"),
      uiPortLine("0.0.0.0"),
    );
    expect(nonLoopbackBindings(renderComposeConfig(file))).toEqual([
      "frontend 0.0.0.0:5174",
    ]);
  }, 60_000);

  test("a floating tag hidden behind the minio YAML anchor is caught in the rendered config (T03-F2)", () => {
    const file = mutatedFixture(
      "anchor-floating-tag.yml",
      "docker.io/cloudpirates/image-minio:RELEASE.2025-10-15T17-29-55Z-hardened",
      "docker.io/cloudpirates/image-minio:latest",
    );
    const floating = floatingImageRefs(renderComposeConfig(file));
    expect(floating).toHaveLength(2); // minio and mc share the anchor
    expect(floating).toContain(
      "minio: docker.io/cloudpirates/image-minio:latest",
    );
    expect(floating).toContain("mc: docker.io/cloudpirates/image-minio:latest");
  }, 60_000);
});
