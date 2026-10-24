import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { createOpikHttpPort } from "../src/ai-observability/opik-http";
import {
  type OpikHttpPortDeps,
  OpikPortError,
  type VerifiedOpikContract,
} from "../src/ai-observability/opik-port";
import {
  DEFAULT_RETENTION_DATASETS_DAYS,
  DEFAULT_RETENTION_EXPERIMENTS_DAYS,
  DEFAULT_RETENTION_EXPORTS_DAYS,
  DEFAULT_RETENTION_RUNS_DAYS,
  effectiveRetention,
  isExpired,
  resolveRetentionDays,
} from "../src/ai-observability/retention";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/**
 * The pure contract of the retention pipeline (Issue #41 / DAG T35), no database:
 * the deployment bounds and their fail-closed parsing, the expiry boundary
 * (exactly-expired IS expired), the global-default-plus-scope-override policy
 * fold, and the port's two deletion operations at the transport seam. The
 * database-backed behavior is opik-retention.integration.test.ts.
 */

const manifest = (await Bun.file(
  join(hereDir, "../src/ai-observability/opik-contract/47-manifest.json"),
).json()) as VerifiedOpikContract;

/** A verified contract minus one capability: what a deployment looks like without it. */
const withoutCapability = (name: string): VerifiedOpikContract => ({
  ...manifest,
  capabilities: manifest.capabilities.map((capability) =>
    capability.name === name ? { ...capability, ok: false } : capability,
  ),
  checks: { ...manifest.checks, passed: manifest.checks.passed - 1 },
});

describe("retention deployment bounds", () => {
  test("absent env means the defaults: runs 7, datasets 30, experiments 30, exports 7", () => {
    expect(resolveRetentionDays({})).toEqual({
      runs: DEFAULT_RETENTION_RUNS_DAYS,
      datasets: DEFAULT_RETENTION_DATASETS_DAYS,
      experiments: DEFAULT_RETENTION_EXPERIMENTS_DAYS,
      exports: DEFAULT_RETENTION_EXPORTS_DAYS,
    });
    expect(DEFAULT_RETENTION_RUNS_DAYS).toBe(7);
    expect(DEFAULT_RETENTION_DATASETS_DAYS).toBe(30);
    expect(DEFAULT_RETENTION_EXPERIMENTS_DAYS).toBe(30);
    expect(DEFAULT_RETENTION_EXPORTS_DAYS).toBe(7);
  });

  test("clean values are honored, per category", () => {
    expect(
      resolveRetentionDays({
        OPIK_RETENTION_RUNS_DAYS: "14",
        OPIK_RETENTION_DATASETS_DAYS: "90",
        OPIK_RETENTION_EXPERIMENTS_DAYS: "120",
        OPIK_RETENTION_EXPORTS_DAYS: "2",
      }),
    ).toEqual({ runs: 14, datasets: 90, experiments: 120, exports: 2 });
  });

  test("garbage, zero, negative and over-max keep the default rather than being guessed at", () => {
    for (const bad of ["0", "-1", "abc", "", "3660", "1.5"]) {
      expect(resolveRetentionDays({ OPIK_RETENTION_RUNS_DAYS: bad }).runs).toBe(
        DEFAULT_RETENTION_RUNS_DAYS,
      );
    }
    expect(
      resolveRetentionDays({ OPIK_RETENTION_DATASETS_DAYS: "0" }).datasets,
    ).toBe(DEFAULT_RETENTION_DATASETS_DAYS);
  });
});

describe("the expiry boundary", () => {
  const asOf = new Date("2026-10-16T12:00:00.000Z");

  test("a record exactly retention-days old IS expired (>= cutoff, not >)", () => {
    const exactly = new Date(asOf.getTime() - 7 * 86_400_000);
    expect(isExpired({ asOf, createdAt: exactly, days: 7 })).toBe(true);
  });

  test("one millisecond newer is not expired", () => {
    const justInside = new Date(asOf.getTime() - 7 * 86_400_000 + 1);
    expect(isExpired({ asOf, createdAt: justInside, days: 7 })).toBe(false);
  });

  test("far past the cutoff is expired, fresh is not", () => {
    expect(
      isExpired({ asOf, createdAt: new Date("2026-09-01T00:00:00Z"), days: 7 }),
    ).toBe(true);
    expect(
      isExpired({ asOf, createdAt: new Date("2026-10-16T00:00:00Z"), days: 7 }),
    ).toBe(false);
  });
});

describe("the policy fold: global default + scope override", () => {
  const global = resolveRetentionDays({});

  test("a null override field defers to the global default, per category", () => {
    expect(
      effectiveRetention(global, {
        runs: 60,
        datasets: null,
        experiments: null,
        exports: null,
      }),
    ).toEqual({ ...global, runs: 60 });
  });

  test("an empty override is exactly the global", () => {
    expect(
      effectiveRetention(global, {
        runs: null,
        datasets: null,
        experiments: null,
        exports: null,
      }),
    ).toEqual(global);
  });
});

/** The deletion locator exactly as discovery freezes it out of our own tables. */
const scope = resolveObservationScope({
  actorId: "t35-unit",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});
const locator = resolveStorageLocator(scope);

type Recorded = { url: string; init: RequestInit };

/** A transport that records every call and answers from a handler. */
function recorder(handler: (call: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const transport = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(handler(calls.length));
  }) as typeof fetch;
  return { calls, transport };
}

const json = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });

function port(overrides: Partial<OpikHttpPortDeps> = {}) {
  return createOpikHttpPort({
    baseUrl: "http://opik.test/api",
    contract: manifest,
    timeoutMs: 5_000,
    ...overrides,
  });
}

describe("the port's trace deletion (verified capability: trace-span-physical-delete)", () => {
  test("resolves the locator's project, deletes the ids with 204, and completes only on the read-back's 404 (FREV-07)", async () => {
    const { calls, transport } = recorder((call) =>
      call === 1
        ? json(200, JSON.stringify({ id: "proj-1" }))
        : call === 2
          ? new Response(null, { status: 204 })
          : json(404, "{}"),
    );
    const result = await port({ fetch: transport }).deleteTraces(locator, {
      traceIds: ["01a1405b-f832-70cf-b204-f4dd51387044"],
    });
    expect(result).toEqual({ outcome: "ok", value: { deleted: true } });
    expect(calls[0].url).toBe(
      "http://opik.test/api/v1/private/projects/retrieve",
    );
    expect(calls[1].url).toBe("http://opik.test/api/v1/private/traces/delete");
    expect(calls[1].init.method).toBe("POST");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      ids: ["01a1405b-f832-70cf-b204-f4dd51387044"],
      project_id: "proj-1",
    });
    // The 204 is acceptance; completion rides the absence read-back — the same
    // trace-detail GET the delete capability's own evidence polled.
    expect(calls[2].url).toBe(
      "http://opik.test/api/v1/private/traces/01a1405b-f832-70cf-b204-f4dd51387044?project_id=proj-1",
    );
    expect(calls[2].init.method).toBe("GET");
  });

  test("a 204 whose read-back still finds the trace is not completion — the bounded window expires as a retryable timeout (FREV-07)", async () => {
    const { calls, transport } = recorder((call) =>
      call === 1
        ? json(200, JSON.stringify({ id: "proj-1" }))
        : call === 2
          ? new Response(null, { status: 204 })
          : json(
              200,
              JSON.stringify({ id: "01a1405b-f832-70cf-b204-f4dd51387044" }),
            ),
    );
    const result = await port({
      fetch: transport,
      timeoutMs: 100,
    }).deleteTraces(locator, {
      traceIds: ["01a1405b-f832-70cf-b204-f4dd51387044"],
    });
    // The counterexample from the final review: the delete request was accepted,
    // the trace is still queryable — so the operation answers its own timeout
    // fact, retryable, never the {deleted:true} the upstream has not made true.
    expect(result).toEqual({
      outcome: "unavailable",
      operation: "deleteTraces",
      code: "OPIK_TIMEOUT",
    });
    expect(calls[2].url).toBe(
      "http://opik.test/api/v1/private/traces/01a1405b-f832-70cf-b204-f4dd51387044?project_id=proj-1",
    );
    expect(calls[2].init.method).toBe("GET");
    expect(calls).toHaveLength(3);
  });

  test("an accepted delete completes on a later poll once the trace stops answering (FREV-07)", async () => {
    const { calls, transport } = recorder((call) =>
      call === 1
        ? json(200, JSON.stringify({ id: "proj-1" }))
        : call === 2
          ? new Response(null, { status: 204 })
          : call === 3
            ? json(
                200,
                JSON.stringify({ id: "01a1405b-f832-70cf-b204-f4dd51387044" }),
              )
            : json(404, "{}"),
    );
    const result = await port({
      fetch: transport,
      timeoutMs: 5_000,
    }).deleteTraces(locator, {
      traceIds: ["01a1405b-f832-70cf-b204-f4dd51387044"],
    });
    expect(result).toEqual({ outcome: "ok", value: { deleted: true } });
    // One present answer, one absent: the poll window, not the bare 204, is what
    // the completion rides.
    expect(calls).toHaveLength(4);
  });

  test("a hard read-back failure surfaces as itself, never polled into success", async () => {
    const { transport } = recorder((call) =>
      call === 1
        ? json(200, JSON.stringify({ id: "proj-1" }))
        : call === 2
          ? new Response(null, { status: 204 })
          : new Response(null, { status: 500 }),
    );
    const result = await port({ fetch: transport }).deleteTraces(locator, {
      traceIds: ["01a1405b-f832-70cf-b204-f4dd51387044"],
    });
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "deleteTraces",
      code: "OPIK_UPSTREAM_ERROR",
      status: 500,
    });
  });

  test("every requested id must read back absent before the deletion completes (FREV-07)", async () => {
    const traceA = "01a1405b-f832-70cf-b204-f4dd51387044";
    const traceB = "01a1405b-f832-70cf-b204-f4dd51387045";
    const { calls, transport } = recorder((call) =>
      call === 1
        ? json(200, JSON.stringify({ id: "proj-1" }))
        : call === 2
          ? new Response(null, { status: 204 })
          : json(404, "{}"),
    );
    const result = await port({ fetch: transport }).deleteTraces(locator, {
      traceIds: [traceA, traceB],
    });
    expect(result).toEqual({ outcome: "ok", value: { deleted: true } });
    const readbacks = calls.slice(2).map((call) => call.url);
    expect(readbacks).toEqual([
      `http://opik.test/api/v1/private/traces/${traceA}?project_id=proj-1`,
      `http://opik.test/api/v1/private/traces/${traceB}?project_id=proj-1`,
    ]);
  });

  test("a project that does not exist upstream answers ok without a delete call", async () => {
    const { calls, transport } = recorder(() => json(404, "{}"));
    const result = await port({ fetch: transport }).deleteTraces(locator, {
      traceIds: ["01a1405b-f832-70cf-b204-f4dd51387044"],
    });
    // The project is gone, so the traces are gone: the deletion is complete by
    // absence, and honestly reported as nothing-was-deleted rather than 204-guessed.
    expect(result).toEqual({ outcome: "ok", value: { deleted: false } });
    expect(calls).toHaveLength(1);
  });

  test("an upstream 5xx is an upstream error, never a disguised success", async () => {
    const { transport } = recorder((call) =>
      call === 1
        ? json(200, JSON.stringify({ id: "proj-1" }))
        : new Response(null, { status: 503 }),
    );
    const result = await port({ fetch: transport }).deleteTraces(locator, {
      traceIds: ["01a1405b-f832-70cf-b204-f4dd51387044"],
    });
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "deleteTraces",
      code: "OPIK_UPSTREAM_ERROR",
      status: 503,
    });
  });

  test("empty ids are refused before any transport call", async () => {
    const { calls, transport } = recorder(() => json(200, "{}"));
    expect(() =>
      port({ fetch: transport }).deleteTraces(locator, { traceIds: [] }),
    ).toThrow(OpikPortError);
    expect(calls).toHaveLength(0);
  });

  test("a contract without the deletion capability refuses pre-I/O", async () => {
    const { calls, transport } = recorder(() => json(200, "{}"));
    expect(() =>
      port({
        fetch: transport,
        contract: withoutCapability("trace-span-physical-delete"),
      }).deleteTraces(locator, { traceIds: ["x"] }),
    ).toThrow(OpikPortError);
    expect(calls).toHaveLength(0);
  });
});

describe("the port's dataset deletion (verified capability: experiment-dataset-physical-delete)", () => {
  test("deletes the upstream dataset id with 204 and completes on the read-back's 404 (FREV-07)", async () => {
    const { calls, transport } = recorder((call) =>
      call === 1 ? new Response(null, { status: 204 }) : json(404, "{}"),
    );
    const result = await port({ fetch: transport }).deleteDataset(locator, {
      datasetId: "01a1405c-09c2-71bb-a219-53d843ca7d1f",
    });
    expect(result).toEqual({ outcome: "ok", value: { deleted: true } });
    expect(calls[0].url).toBe(
      "http://opik.test/api/v1/private/datasets/delete-batch",
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      ids: ["01a1405c-09c2-71bb-a219-53d843ca7d1f"],
    });
    // Same discipline as trace deletion: the batch's 204 is acceptance, and the
    // dataset-detail GET is the verified absence the completion rides.
    expect(calls[1].url).toBe(
      "http://opik.test/api/v1/private/datasets/01a1405c-09c2-71bb-a219-53d843ca7d1f",
    );
    expect(calls[1].init.method).toBe("GET");
  });

  test("a 204 whose read-back still finds the dataset is not completion (FREV-07)", async () => {
    const { calls, transport } = recorder((call) =>
      call === 1
        ? new Response(null, { status: 204 })
        : json(
            200,
            JSON.stringify({ id: "01a1405c-09c2-71bb-a219-53d843ca7d1f" }),
          ),
    );
    const result = await port({
      fetch: transport,
      timeoutMs: 100,
    }).deleteDataset(locator, {
      datasetId: "01a1405c-09c2-71bb-a219-53d843ca7d1f",
    });
    expect(result).toEqual({
      outcome: "unavailable",
      operation: "deleteDataset",
      code: "OPIK_TIMEOUT",
    });
    expect(calls[1].url).toBe(
      "http://opik.test/api/v1/private/datasets/01a1405c-09c2-71bb-a219-53d843ca7d1f",
    );
  });

  test("a 404 from the delete endpoint itself is not a verified answer — upstream error", async () => {
    const { transport } = recorder(() => json(404, "{}"));
    const result = await port({ fetch: transport }).deleteDataset(locator, {
      datasetId: "01a1405c-09c2-71bb-a219-53d843ca7d1f",
    });
    // Unlike trace deletion's project 404 (a verified answer on retrieve), a 404
    // here is a client error from a delete endpoint the contract only knows as
    // 204 — it stays a retryable failure, never a success.
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "deleteDataset",
      code: "OPIK_CLIENT_ERROR",
      status: 404,
    });
  });

  test("a contract without the deletion capability refuses pre-I/O", async () => {
    const { calls, transport } = recorder(() => json(200, "{}"));
    expect(() =>
      port({
        fetch: transport,
        contract: withoutCapability("experiment-dataset-physical-delete"),
      }).deleteDataset(locator, { datasetId: "x" }),
    ).toThrow(OpikPortError);
    expect(calls).toHaveLength(0);
  });
});
