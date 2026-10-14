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
