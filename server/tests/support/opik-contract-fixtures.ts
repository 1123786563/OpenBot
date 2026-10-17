// Pure contract logic for Issue #10 / DAG T04 (VerifiedOpikContract).
//
// No network, no filesystem: the live runner in server/scripts/opik-contract.ts
// imports these helpers against a real isolated Opik instance, and the parser
// tests in server/tests/opik-contract.test.ts exercise them deterministically.
// The upstream facts encoded here were verified against comet-ml/opik 2.2.100
// (upstream commit c8231ef8cdabb6fc5223c8dece17959e8af461ce):
//   - OTLP ingest: POST /v1/private/otel/v1/traces, application/json, hex ids;
//     the routing project comes from the `projectName` request header.
//   - OpenTelemetryMapper: without `opik.*` overrides the Opik trace/span ids
//     are derived (SHA-256 based UUIDv7), never equal to the OTel ids; with
//     `opik.trace_id`/`opik.span_id`/`opik.parent_span_id` (UUIDv7 strings) the
//     ids are used verbatim.
//   - GeneralMappingRules: attributes `input*`/`output*` prefixes map to
//     input/output, `thread_id` to thread, `opik.tags`/`opik.metadata.*` to
//     tags/metadata; `opik.*` id attributes are dropped from storage.

/**
 * The REST trace-create request body the T04 contract runner verified against the real
 * instance (fixture `05-trace-b-rest-create.json`, answered HTTP 201): exactly these
 * keys, `name` included — the only creation shape the real backend was observed to
 * accept. The HTTP adapter mirrors this evidence rather than guessing a field set
 * (R4-16), and the port wire test pins its serialized body against this fixture so the
 * two cannot drift.
 */
export const VERIFIED_TRACE_CREATE_BODY_KEYS = [
  "id",
  "project_name",
  "name",
  "start_time",
  "thread_id",
] as const;

export type VersionsImage = {
  repository: string;
  tag: string;
  digest: string;
};

export type VersionsManifest = {
  opik: {
    version: string;
    upstreamCommit: string;
    verifiedAt?: string;
    images: Record<string, VersionsImage>;
  };
  sdk: { typescript: string | null };
};

export type ContractCheck = {
  name: string;
  ok: boolean;
  evidence: string;
};

export type IdMappingTrace = {
  kind: "derived" | "explicit";
  otelTraceId: string;
  opikTraceId: string;
  /** Evidence file the Opik side of the mapping was queried from. */
  source: string;
};

export type IdMappingSpan = {
  otelSpanId: string;
  opikSpanId: string;
  opikParentSpanId: string | null;
};

export type VerifiedOpikContract = {
  manifestVersion: 1;
  generatedAt: string;
  target: { baseUrl: string; composeProject: string };
  isolatedProject: { name: string; id: string; deleted: boolean };
  service: {
    version: string;
    upstreamCommit: string;
    images: Array<{
      name: string;
      repository: string;
      tag: string;
      pinnedDigest: string;
      runningDigest: string;
      match: boolean;
    }>;
  };
  sdk: {
    typescript: string;
    npmDist: { shasum?: string; tarball?: string } | null;
  };
  capabilities: ContractCheck[];
  idMapping: {
    derivation: string;
    traces: IdMappingTrace[];
    spans: IdMappingSpan[];
  };
  datasets: {
    datasetId: string;
    versions: Array<{
      versionName: string;
      versionHash: string;
      itemsTotal: number;
    }>;
    immutabilityVerified: boolean;
  };
  experiments: { experimentId: string; verified: boolean };
  deletion: {
    traces: Array<{ opikId: string; absentAfterDelete: boolean }>;
    spans: Array<{ opikId: string; absentAfterDelete: boolean }>;
    dataset: { id: string; absentAfterDelete: boolean };
    experiment: { id: string; absentAfterDelete: boolean };
    project: { id: string; absentAfterDelete: boolean };
  };
  bodyLimit: {
    maxAcceptedBytes: number;
    minRejectedBytes: number | null;
    cappedAtBytes: number | null;
  };
  canaries: {
    safe: { marker: string; foundInStoredSpan: boolean };
    forbiddenFound: string[];
  };
  fixtures: string[];
  checks: { total: number; passed: number };
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;

/** Parses docker/opik/versions.json. Throws on any floating or unpinned value. */
export function parseVersionsManifest(input: unknown): VersionsManifest {
  const value = input as {
    opik?: { version?: unknown; upstreamCommit?: unknown; images?: unknown };
    sdk?: { typescript?: unknown };
  };
  if (
    !value?.opik ||
    typeof value.opik.version !== "string" ||
    !SEMVER.test(value.opik.version)
  ) {
    throw new Error("versions.json: opik.version must be an exact semver");
  }
  if (
    typeof value.opik.upstreamCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.opik.upstreamCommit)
  ) {
    throw new Error(
      "versions.json: opik.upstreamCommit must be a 40-hex git commit",
    );
  }
  const images = value.opik.images as Record<string, VersionsImage> | undefined;
  if (
    !images ||
    typeof images !== "object" ||
    Object.keys(images).length === 0
  ) {
    throw new Error("versions.json: opik.images must be a non-empty object");
  }
  for (const [name, image] of Object.entries(images)) {
    if (
      typeof image?.tag !== "string" ||
      image.tag === "latest" ||
      image.tag.endsWith("-latest")
    ) {
      throw new Error(`versions.json: image ${name} has a floating tag`);
    }
    if (typeof image?.digest !== "string" || !SHA256.test(image.digest)) {
      throw new Error(
        `versions.json: image ${name} is missing a pinned sha256 digest`,
      );
    }
    if (
      typeof image?.repository !== "string" ||
      image.repository.length === 0
    ) {
      throw new Error(`versions.json: image ${name} is missing a repository`);
    }
  }
  if (
    typeof value.sdk?.typescript !== "string" ||
    !SEMVER.test(value.sdk.typescript)
  ) {
    throw new Error(
      "versions.json: sdk.typescript must be an exact semver (unknown SDK version)",
    );
  }
  return {
    opik: {
      version: value.opik.version,
      upstreamCommit: value.opik.upstreamCommit,
      images,
    },
    sdk: { typescript: value.sdk.typescript },
  };
}

/**
 * Resolves the live contract target. The base URL must be passed explicitly —
 * no environment fallback — so a contract run can never silently point at a
 * production Opik. The project is always a disposable openbot-t04-* synthetic
 * project, generated per run when not given.
 */
export function contractTarget(opts: {
  baseUrl?: string;
  project?: string;
  now?: number;
}): {
  baseUrl: URL;
  project: string;
} {
  if (!opts.baseUrl || opts.baseUrl.trim() === "") {
    throw new Error(
      "Opik contract target requires an explicit --target base URL",
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(opts.baseUrl);
  } catch {
    throw new Error(`--target is not a valid URL: ${opts.baseUrl}`);
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("--target must be an http(s) URL");
  }
  let project = opts.project?.trim();
  if (!project) {
    const now = opts.now ?? Date.now();
    const stamp = new Date(now)
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    project = `openbot-t04-${stamp}-${rand}`;
  }
  if (!/^openbot-t04-[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new Error(
      "contract project must be a disposable openbot-t04-* synthetic project",
    );
  }
  return { baseUrl, project };
}

/** UUIDv7 (time-ordered), the id format Opik derives and accepts for overrides. */
export function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  const millis = BigInt(now);
  const rand12 = BigInt(Math.floor(Math.random() * 0x0fff));
  // bytes 0..5: 48-bit unix millis; bytes 6..7: version 7 + 12 random bits.
  view.setBigUint64(0, (millis << 16n) | 0x7000n | rand12, false);
  // bytes 8..15: RFC 4122 variant (10) + 60 random bits (two 30-bit draws,
  // staying under Number.MAX_SAFE_INTEGER; uniqueness is enough for tooling).
  const rand60 =
    BigInt(Math.floor(Math.random() * 0x40000000)) * 0x40000000n +
    BigInt(Math.floor(Math.random() * 0x40000000));
  view.setBigUint64(8, 0x8000000000000000n | rand60, false);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

export type OtlpSpanSpec = {
  name: string;
  traceHex: string;
  spanHex: string;
  parentSpanHex?: string;
  /** UUIDv7 strings; when set the backend uses them verbatim as Opik ids. */
  opikTraceId?: string;
  opikSpanId?: string;
  opikParentSpanId?: string;
  attributes?: Record<string, string>;
};

export type OtlpPayloadSpec = {
  threadId: string;
  scopeName?: string;
  serviceName?: string;
  spans: OtlpSpanSpec[];
};

/**
 * Builds an OTLP HTTP/JSON ExportTraceServiceRequest. Ids are hex strings
 * (OTLP JSON encoding); nanosecond timestamps are stringified integers as
 * proto3 JSON requires for 64-bit fields.
 */
export function buildOtlpJsonPayload(
  spec: OtlpPayloadSpec,
): Record<string, unknown> {
  const startNanos = BigInt(Date.now()) * 1_000_000n;
  const spans = spec.spans.map((span, index) => {
    if (!HEX_TRACE_ID.test(span.traceHex))
      throw new Error(`trace id must be 32 hex chars: ${span.traceHex}`);
    if (!HEX_SPAN_ID.test(span.spanHex))
      throw new Error(`span id must be 16 hex chars: ${span.spanHex}`);
    const attributes: Array<{ key: string; value: { stringValue: string } }> = [
      { key: "thread_id", value: { stringValue: spec.threadId } },
    ];
    for (const [key, value] of Object.entries(span.attributes ?? {})) {
      attributes.push({ key, value: { stringValue: value } });
    }
    // Overrides are refused, never silently dropped (OCR m213): a probe that meant
    // to exercise the explicit path must not slide into the derived path and mint
    // an idMapping that attests a surface nobody verified.
    if (
      (span.opikSpanId !== undefined || span.opikParentSpanId !== undefined) &&
      span.opikTraceId === undefined
    ) {
      throw new Error(
        "opik.span_id/opik.parent_span_id require opik.trace_id — the overrides ride the explicit path only",
      );
    }
    if (span.opikTraceId) {
      if (!isUuidV7(span.opikTraceId))
        throw new Error("opik.trace_id override must be a UUIDv7");
      attributes.push({
        key: "opik.trace_id",
        value: { stringValue: span.opikTraceId },
      });
      if (span.opikSpanId) {
        if (!isUuidV7(span.opikSpanId))
          throw new Error("opik.span_id override must be a UUIDv7");
        attributes.push({
          key: "opik.span_id",
          value: { stringValue: span.opikSpanId },
        });
      }
      if (span.opikParentSpanId) {
        if (!isUuidV7(span.opikParentSpanId))
          throw new Error("opik.parent_span_id override must be a UUIDv7");
        attributes.push({
          key: "opik.parent_span_id",
          value: { stringValue: span.opikParentSpanId },
        });
      }
    }
    const out: Record<string, unknown> = {
      traceId: span.traceHex,
      spanId: span.spanHex,
      name: span.name,
      kind: 1,
      startTimeUnixNano: (startNanos + BigInt(index) * 1_000_000n).toString(),
      endTimeUnixNano: (
        startNanos +
        (BigInt(index) + 1n) * 5_000_000n
      ).toString(),
      attributes,
    };
    if (span.parentSpanHex) {
      if (!HEX_SPAN_ID.test(span.parentSpanHex))
        throw new Error("parent span id must be 16 hex chars");
      out.parentSpanId = span.parentSpanHex;
    }
    return out;
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: spec.serviceName ?? "openbot-contract" },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: spec.scopeName ?? "openbot-contract-runner" },
            spans,
          },
        ],
      },
    ],
  };
}

const SENSITIVE_HEADERS =
  /^(authorization|cookie|set-cookie|api[-_]key|x-api-key)$/i;

/** Deep-copies a JSON value with secret values and auth headers redacted. */
export function sanitizeEvidence(value: unknown, secrets: string[]): unknown {
  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      if (secret && secret.length >= 4) {
        out = out.split(secret).join("[redacted]");
      }
    }
    return out;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redact(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        node as Record<string, unknown>,
      )) {
        out[key] = SENSITIVE_HEADERS.test(key)
          ? "[redacted-header]"
          : walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

export type Canary = { label: string; value: string };

/**
 * Scans serialized text for canary values. Returns the LABELS of everything
 * found so a failure report never echoes the secret itself.
 */
export function scanTextForCanaries(
  text: string,
  canaries: readonly Canary[],
): string[] {
  const found: string[] = [];
  for (const canary of canaries) {
    if (canary.value.length >= 4 && text.includes(canary.value)) {
      found.push(canary.label);
    }
  }
  return found;
}

/**
 * Labels of forbidden canaries found in ANY of the given serialized texts.
 *
 * The caller MUST include the raw, pre-sanitization evidence text: evidence is
 * sanitized before it is written to disk, so a scan confined to the sanitized
 * disk files (plus the manifest and diagnostics) removes the canaries before it
 * looks for them and is structurally empty — the redline could never fire
 * (review finding R2-31). Raw texts stay in memory only; nothing unsanitized is
 * ever written.
 */
export function collectForbiddenCanaryLabels(
  texts: readonly string[],
  canaries: readonly Canary[],
): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const label of scanTextForCanaries(text, canaries)) {
      found.add(label);
    }
  }
  return [...found];
}

/**
 * Validates a completed VerifiedOpikContract. Every rejection here corresponds
 * to an acceptance criterion of Issue #10: an unverified manifest must never
 * be emitted, and fixtures alone can never pass this gate.
 */
export function validateContract(manifest: VerifiedOpikContract): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (!SEMVER.test(manifest.service.version))
    fail("service.version is not an exact semver");
  if (!/^[0-9a-f]{40}$/.test(manifest.service.upstreamCommit))
    fail("upstream commit missing");
  if (!manifest.service.images.length)
    fail("no pinned service images recorded");
  for (const image of manifest.service.images) {
    if (!SHA256.test(image.pinnedDigest))
      fail(`image ${image.name}: pinned digest missing`);
    if (!SHA256.test(image.runningDigest))
      fail(`image ${image.name}: running digest not proven`);
    if (image.pinnedDigest !== image.runningDigest) {
      fail(
        `image ${image.name}: running digest does not match the pinned digest`,
      );
    }
    if (image.tag === "latest" || image.tag.endsWith("-latest"))
      fail(`image ${image.name}: floating tag`);
  }
  if (!manifest.sdk.typescript || !SEMVER.test(manifest.sdk.typescript)) {
    fail("sdk.typescript is an unknown or non-exact version");
  }
  if (manifest.fixtures.length === 0) fail("fixture list is empty");
  for (const check of manifest.capabilities) {
    if (!check.ok) fail(`capability not verified: ${check.name}`);
  }

  if (manifest.isolatedProject.name.length === 0)
    fail("no explicit isolated project recorded");

  if (manifest.idMapping.traces.length === 0)
    fail("no OTel-to-Opik trace id mapping");
  for (const trace of manifest.idMapping.traces) {
    if (!HEX_TRACE_ID.test(trace.otelTraceId))
      fail("id mapping: OTel trace id side missing");
    if (!isUuidV7(trace.opikTraceId))
      fail("id mapping: Opik trace id side missing");
    if (trace.otelTraceId === trace.opikTraceId.replace(/-/g, "")) {
      fail(
        "id mapping assumes OTel id equals Opik id (identity-assumed, unproven)",
      );
    }
    if (!trace.source) fail("id mapping has no query evidence");
  }
  if (manifest.idMapping.spans.length < 2)
    fail("id mapping needs at least a parent and a child span");
  const spanIds = new Set(
    manifest.idMapping.spans.map((span) => span.opikSpanId),
  );
  let linked = false;
  for (const span of manifest.idMapping.spans) {
    if (!HEX_SPAN_ID.test(span.otelSpanId) || !isUuidV7(span.opikSpanId)) {
      fail("span id mapping missing one side");
    }
    if (span.opikParentSpanId !== null) {
      if (!spanIds.has(span.opikParentSpanId))
        fail("span parent id does not resolve to a mapped span");
      linked = true;
    }
  }
  if (!linked) fail("no parent/child relation proven between mapped spans");

  if (!manifest.datasets.datasetId || manifest.datasets.versions.length === 0) {
    fail("dataset versioning not proven");
  }
  if (!manifest.datasets.immutabilityVerified)
    fail("dataset version immutability not verified");
  if (!manifest.experiments.experimentId || !manifest.experiments.verified) {
    fail("experiment create/query not verified");
  }

  for (const trace of manifest.deletion.traces) {
    if (!trace.absentAfterDelete)
      fail(`trace ${trace.opikId} still queryable after delete`);
  }
  if (manifest.deletion.traces.length === 0) fail("no trace deletion proof");
  for (const span of manifest.deletion.spans) {
    if (!span.absentAfterDelete)
      fail(`span ${span.opikId} still queryable after delete`);
  }
  if (!manifest.deletion.dataset.absentAfterDelete)
    fail("dataset still queryable after delete");
  if (!manifest.deletion.experiment.absentAfterDelete)
    fail("experiment still queryable after delete");
  if (!manifest.deletion.project.absentAfterDelete)
    fail("isolated project still queryable after delete");
  if (!manifest.isolatedProject.deleted) fail("isolated project not deleted");

  if (manifest.bodyLimit.maxAcceptedBytes <= 0)
    fail("supported body limit not proven");
  if (!manifest.canaries.safe.foundInStoredSpan)
    fail("safe canary never reached stored span data");
  if (manifest.canaries.forbiddenFound.length > 0) {
    fail(
      `forbidden canaries found in evidence: ${manifest.canaries.forbiddenFound.join(", ")}`,
    );
  }

  if (manifest.checks.passed !== manifest.checks.total) {
    fail(
      `checks incomplete: ${manifest.checks.passed}/${manifest.checks.total} passed`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * A fully green sample manifest used ONLY by the parser tests to pin the
 * validator's accepting path. It is not live evidence; the runner produces the
 * real manifest from actual service responses.
 */
export function sampleContractManifest(): VerifiedOpikContract {
  return {
    manifestVersion: 1,
    generatedAt: "2026-10-15T00:00:00.000Z",
    target: {
      baseUrl: "http://127.0.0.1:5174/api",
      composeProject: "opik-issue4-validation",
    },
    isolatedProject: {
      name: "openbot-t04-sample",
      id: "018f0000-0000-7000-8000-00000000aaaa",
      deleted: true,
    },
    service: {
      version: "2.2.100",
      upstreamCommit: "c8231ef8cdabb6fc5223c8dece17959e8af461ce",
      images: [
        {
          name: "backend",
          repository: "ghcr.io/comet-ml/opik/opik-backend",
          tag: "2.2.100",
          pinnedDigest: `sha256:${"a".repeat(64)}`,
          runningDigest: `sha256:${"a".repeat(64)}`,
          match: true,
        },
      ],
    },
    sdk: {
      typescript: "2.2.100",
      npmDist: {
        shasum: `${"b".repeat(64)}`,
        tarball: "https://registry.npmjs.org/opik/-/opik-2.2.100.tgz",
      },
    },
    capabilities: [
      { name: "otlp-write", ok: true, evidence: "01-otlp-write.json" },
    ],
    idMapping: {
      derivation: "sha256-derived-until-overridden",
      traces: [
        {
          kind: "derived",
          otelTraceId: "a".repeat(32),
          opikTraceId: "018f0000-0000-7000-8000-00000000bbbb",
          source: "03-trace-query.json",
        },
        {
          kind: "explicit",
          otelTraceId: "b".repeat(32),
          opikTraceId: "018f0000-0000-7000-8000-00000000cccc",
          source: "03-trace-query.json",
        },
      ],
      spans: [
        {
          otelSpanId: "c".repeat(16),
          opikSpanId: "018f0000-0000-7000-8000-00000000d001",
          opikParentSpanId: null,
        },
        {
          otelSpanId: "d".repeat(16),
          opikSpanId: "018f0000-0000-7000-8000-00000000d002",
          opikParentSpanId: "018f0000-0000-7000-8000-00000000d001",
        },
      ],
    },
    datasets: {
      datasetId: "018f0000-0000-7000-8000-00000000dddd",
      versions: [
        { versionName: "v1", versionHash: "aaaa1111", itemsTotal: 1 },
        { versionName: "v2", versionHash: "aaaa2222", itemsTotal: 2 },
      ],
      immutabilityVerified: true,
    },
    experiments: {
      experimentId: "018f0000-0000-7000-8000-00000000eeee",
      verified: true,
    },
    deletion: {
      traces: [
        {
          opikId: "018f0000-0000-7000-8000-00000000bbbb",
          absentAfterDelete: true,
        },
      ],
      spans: [
        {
          opikId: "018f0000-0000-7000-8000-00000000d001",
          absentAfterDelete: true,
        },
      ],
      dataset: {
        id: "018f0000-0000-7000-8000-00000000dddd",
        absentAfterDelete: true,
      },
      experiment: {
        id: "018f0000-0000-7000-8000-00000000eeee",
        absentAfterDelete: true,
      },
      project: {
        id: "018f0000-0000-7000-8000-00000000aaaa",
        absentAfterDelete: true,
      },
    },
    bodyLimit: {
      maxAcceptedBytes: 8388608,
      minRejectedBytes: 8388609,
      cappedAtBytes: null,
    },
    canaries: {
      safe: { marker: "SAFE_CANARY_sample", foundInStoredSpan: true },
      forbiddenFound: [],
    },
    fixtures: ["01-otlp-write.json", "03-trace-query.json"],
    checks: { total: 12, passed: 12 },
  };
}
