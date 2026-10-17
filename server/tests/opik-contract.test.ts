// Parser tests only (Issue #10 / DAG T04). These validate the VerifiedOpikContract
// validator, the versions.json parser, the OTLP payload builder and the evidence
// sanitizer against deterministic fixtures. They never touch the network: the real
// gate is `bun server/scripts/opik-contract.ts --target ... --evidence ...` against
// a running isolated Opik instance, whose output is preserved as evidence.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildOtlpJsonPayload,
  contractTarget,
  parseVersionsManifest,
  sampleContractManifest,
  sanitizeEvidence,
  scanTextForCanaries,
  validateContract,
} from "./support/opik-contract-fixtures";

const versionsJson = await Bun.file(
  join(import.meta.dir, "../../docker/opik/versions.json"),
).json();

describe("versions manifest parser", () => {
  test("accepts the pinned T03 versions.json with non-floating tags", () => {
    const manifest = parseVersionsManifest(versionsJson);
    expect(manifest.opik.version).toBe("2.2.100");
    expect(manifest.opik.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.sdk.typescript).toMatch(/^\d+\.\d+\.\d+$/);
    for (const image of Object.values(manifest.opik.images)) {
      expect(image.tag).not.toContain("latest");
      expect(image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("rejects a floating tag", () => {
    const bad = structuredClone(versionsJson);
    bad.opik.images.backend.tag = "latest";
    expect(() => parseVersionsManifest(bad)).toThrow(/floating/i);
  });

  test("rejects a missing digest", () => {
    const bad = structuredClone(versionsJson);
    delete bad.opik.images.backend.digest;
    expect(() => parseVersionsManifest(bad)).toThrow(/digest/i);
  });

  test("rejects an unknown SDK version", () => {
    const bad = structuredClone(versionsJson);
    bad.sdk.typescript = null;
    expect(() => parseVersionsManifest(bad)).toThrow(/sdk/i);
  });
});

describe("contract target", () => {
  test("throws without an explicit base URL", () => {
    expect(() => contractTarget({})).toThrow(/--target/i);
  });

  test("throws on a non-http base URL", () => {
    expect(() => contractTarget({ baseUrl: "ftp://x" })).toThrow();
  });

  test("generates a unique disposable project and keeps explicit safe names", () => {
    const generated = contractTarget({ baseUrl: "http://127.0.0.1:5174/api" });
    expect(generated.project).toMatch(/^openbot-t04-[a-z0-9-]+$/);
    const explicit = contractTarget({
      baseUrl: "http://127.0.0.1:5174/api",
      project: "openbot-t04-explicit",
    });
    expect(explicit.project).toBe("openbot-t04-explicit");
  });

  test("refuses a project name outside the disposable prefix", () => {
    expect(() =>
      contractTarget({
        baseUrl: "http://127.0.0.1:5174/api",
        project: "Default Project",
      }),
    ).toThrow(/disposable/i);
  });
});

describe("OTLP payload builder", () => {
  test("emits OTLP HTTP/JSON with hex ids, parent linkage and mapping attributes", () => {
    const payload = buildOtlpJsonPayload({
      threadId: "thread-x",
      spans: [
        {
          name: "parent",
          traceHex: "a".repeat(32),
          spanHex: "b".repeat(16),
          attributes: { "input.value": "hello" },
        },
        {
          name: "child",
          traceHex: "a".repeat(32),
          spanHex: "c".repeat(16),
          parentSpanHex: "b".repeat(16),
          attributes: { "output.value": "world" },
        },
      ],
    });
    const root = (
      payload as {
        resourceSpans: Array<{
          scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
        }>;
      }
    ).resourceSpans[0].scopeSpans[0].spans;
    expect(root[0].traceId).toBe("a".repeat(32));
    expect(root[0].spanId).toBe("b".repeat(16));
    expect(root[1].parentSpanId).toBe("b".repeat(16));
    const attrs = root[0].attributes as Array<{
      key: string;
      value: { stringValue: string };
    }>;
    expect(attrs.find((a) => a.key === "input.value")?.value.stringValue).toBe(
      "hello",
    );
    expect(attrs.find((a) => a.key === "thread_id")?.value.stringValue).toBe(
      "thread-x",
    );
  });

  test("threads explicit opik.* id overrides for the cross-service identity path", () => {
    const payload = buildOtlpJsonPayload({
      threadId: "thread-x",
      spans: [
        {
          name: "root",
          traceHex: "d".repeat(32),
          spanHex: "e".repeat(16),
          opikTraceId: "018f0000-0000-7000-8000-000000000001",
          opikSpanId: "018f0000-0000-7000-8000-000000000002",
        },
        {
          name: "child",
          traceHex: "d".repeat(32),
          spanHex: "f".repeat(16),
          parentSpanHex: "e".repeat(16),
          opikTraceId: "018f0000-0000-7000-8000-000000000001",
          opikSpanId: "018f0000-0000-7000-8000-000000000003",
          opikParentSpanId: "018f0000-0000-7000-8000-000000000002",
        },
      ],
    });
    const spans = (
      payload as {
        resourceSpans: Array<{
          scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
        }>;
      }
    ).resourceSpans[0].scopeSpans[0].spans;
    for (const span of spans) {
      const attrs = span.attributes as Array<{
        key: string;
        value: { stringValue: string };
      }>;
      expect(
        attrs.find((a) => a.key === "opik.trace_id")?.value.stringValue,
      ).toBe("018f0000-0000-7000-8000-000000000001");
    }
    const childAttrs = spans[1].attributes as Array<{
      key: string;
      value: { stringValue: string };
    }>;
    expect(
      childAttrs.find((a) => a.key === "opik.parent_span_id")?.value
        .stringValue,
    ).toBe("018f0000-0000-7000-8000-000000000002");
  });

  test("serialized payload contains no forbidden canaries", () => {
    const payload = buildOtlpJsonPayload({
      threadId: "t",
      spans: [
        {
          name: "root",
          traceHex: "1".repeat(32),
          spanHex: "2".repeat(16),
          attributes: { "input.value": "safe-content" },
        },
      ],
    });
    const found = scanTextForCanaries(JSON.stringify(payload), [
      { label: "env-secret", value: "super-secret-datastore-password" },
      { label: "private-key", value: "-----BEGIN RSA PRIVATE KEY-----" },
    ]);
    expect(found).toEqual([]);
  });
});

describe("evidence sanitizer and canary scan", () => {
  test("redacts secret values at any depth without echoing them", () => {
    const cleaned = sanitizeEvidence(
      {
        headers: { authorization: "Bearer super-secret-datastore-password" },
        nested: ["keep", "super-secret-datastore-password"],
      },
      ["super-secret-datastore-password"],
    );
    const text = JSON.stringify(cleaned);
    expect(text).not.toContain("super-secret-datastore-password");
    expect(text).toContain("keep");
  });

  test("scan reports canary labels, never values", () => {
    const found = scanTextForCanaries(
      '{"a":"leak super-secret-datastore-password here"}',
      [{ label: "env-secret", value: "super-secret-datastore-password" }],
    );
    expect(found).toEqual(["env-secret"]);
  });
});

describe("VerifiedOpikContract validator", () => {
  test("accepts a fully verified sample manifest", () => {
    expect(validateContract(sampleContractManifest())).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("rejects a missing or mismatched service digest", () => {
    const bad = sampleContractManifest();
    bad.service.images[0].runningDigest = `sha256:${"0".repeat(64)}`;
    expect(validateContract(bad).ok).toBe(false);

    const missing = sampleContractManifest();
    missing.service.images[0].pinnedDigest = "";
    expect(validateContract(missing).ok).toBe(false);
  });

  test("rejects an unknown SDK version", () => {
    const bad = sampleContractManifest();
    bad.sdk.typescript = "";
    expect(validateContract(bad).ok).toBe(false);
  });

  test("rejects an empty fixture list", () => {
    const bad = sampleContractManifest();
    bad.fixtures = [];
    expect(validateContract(bad).ok).toBe(false);
  });

  test("rejects an identity-assumed ID mapping", () => {
    const bad = sampleContractManifest();
    bad.idMapping.traces[0].otelTraceId = bad.idMapping.traces[0].opikTraceId;
    expect(validateContract(bad).ok).toBe(false);

    const unproven = sampleContractManifest();
    unproven.idMapping.traces[0].source = "";
    expect(validateContract(unproven).ok).toBe(false);
  });

  test("requires a real parent/child link between mapped spans", () => {
    const bad = sampleContractManifest();
    bad.idMapping.spans[1].opikParentSpanId = null;
    expect(validateContract(bad).ok).toBe(false);

    const dangling = sampleContractManifest();
    dangling.idMapping.spans[1].opikParentSpanId =
      "018f0000-0000-7000-8000-00000000dead";
    expect(validateContract(dangling).ok).toBe(false);
  });

  test("rejects unverified physical deletion", () => {
    const bad = sampleContractManifest();
    bad.deletion.traces[0].absentAfterDelete = false;
    expect(validateContract(bad).ok).toBe(false);

    const noProof = sampleContractManifest();
    noProof.deletion.dataset.absentAfterDelete = false;
    expect(validateContract(noProof).ok).toBe(false);
  });

  test("rejects a manifest without an explicit isolated project", () => {
    const bad = sampleContractManifest();
    bad.isolatedProject = { name: "", id: "x", deleted: false };
    expect(validateContract(bad).ok).toBe(false);
  });

  test("rejects any forbidden canary found in serialized evidence", () => {
    const bad = sampleContractManifest();
    bad.canaries.forbiddenFound = ["env-secret"];
    expect(validateContract(bad).ok).toBe(false);
  });

  test("rejects a safe canary that never reached stored data", () => {
    const bad = sampleContractManifest();
    bad.canaries.safe.foundInStoredSpan = false;
    expect(validateContract(bad).ok).toBe(false);
  });

  test("rejects an unproven body limit and any failed capability", () => {
    const noLimit = sampleContractManifest();
    noLimit.bodyLimit.maxAcceptedBytes = 0;
    expect(validateContract(noLimit).ok).toBe(false);

    const failedStep = sampleContractManifest();
    failedStep.capabilities.push({ name: "extra", ok: false, evidence: "x" });
    expect(validateContract(failedStep).ok).toBe(false);
  });
});
