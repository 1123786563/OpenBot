import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
        expect(image.tag.toLowerCase(), `${name} tag contains`).not.toContain(`:${floating}`);
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

  test("compatibility stays unverified until ticket #10 proves it", () => {
    // Flipping this to "verified" is T04's job, with real ingest/query/delete evidence.
    expect(versions.compatibility.status).toBe("unverified");
    expect(versions.compatibility.verifiedBy).toBe("#10");
  });
});

const PUBLISHED = /^\s*-\s*["']?([^\s"']+:\d+:\d+|\d+:\d+)/gm;

function publishedPorts(text: string): string[] {
  return [...text.matchAll(PUBLISHED)].map((m) => m[1]);
}

describe("docker/compose/opik.yml", () => {
  test("every published port is loopback-only", () => {
    for (const mapping of publishedPorts(compose)) {
      const host = mapping.split(":")[0];
      expect(["127.0.0.1", "[::1]"], `${mapping} must bind loopback`).toContain(host);
    }
  });

  test("no floating image tag anywhere in the stack", () => {
    for (const line of compose.split("\n")) {
      const image = /^\s*image:\s*(\S+)/.exec(line)?.[1];
      if (!image) continue;
      for (const floating of FLOATING) {
        expect(image, `${image} must not float`).not.toMatch(new RegExp(`:${floating}\\s*$`));
      }
      expect(image, `${image} must not default to latest`).not.toContain(":-latest}");
    }
  });

  test("the OTLP host ports do not collide with the existing Tempo stack", () => {
    // docker/compose/observability.yml already publishes 4318/4317 on loopback for Tempo.
    const hosts = publishedPorts(compose).map((m) => m.split(":")[1]);
    for (const taken of ["4317", "4318", "3200", "3102", "3003"]) {
      expect(hosts, `host port ${taken} belongs to the LGTM stack`).not.toContain(taken);
    }
  });

  test("the demo data generator and jaeger are not part of the stack", () => {
    expect(compose).not.toMatch(/^\s{2}demo-data-generator:/m);
    expect(compose).not.toMatch(/^\s{2}jaeger:/m);
  });

  test("the compose file names the openbot project like every other optional stack", () => {
    expect(compose).toMatch(/^name:\s*openbot$/m);
  });

  test("the default OPIK_VERSION matches the pinned versions.json", () => {
    const fallback = /\$\{OPIK_VERSION:-([^}]+)\}/.exec(compose)?.[1];
    expect(fallback, "compose must not default to a floating tag").toBeDefined();
    expect(fallback).toBe(versions.opik.version);
  });
});
