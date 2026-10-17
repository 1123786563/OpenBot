// Issue #10 / DAG T04 — VerifiedOpikContract live runner.
//
// Proves the pinned Opik 2.2.100 server contract against a running isolated
// self-hosted instance and emits the versioned manifest every later Opik
// adapter serializes against. Run it explicitly against a disposable instance:
//
//   bun server/scripts/opik-contract.ts \
//     --target http://127.0.0.1:5174/api \
//     --evidence docs/plans/evidence/2026-10-15-issue4/opik-contract \
//     --compose-project opik-issue4-validation \
//     --secrets-env /tmp/opik-issue4-validation.env
//
// Safety rules baked in: the target and project must be explicit and synthetic
// (openbot-t04-*), every request is sequential with a finite timeout, evidence
// is sanitized before it is written, datastore credentials are read only to be
// scanned for as forbidden canaries and never printed, and the manifest is
// written only when every real assertion passes. A missing instance, a skipped
// probe or a failed check exits nonzero without a manifest.
//
// The verified endpoint surface (snake_case bodies, hex OTLP ids, projectName
// routing header, batch_group_id versioning, physical-delete + 404 semantics)
// is documented in docs/opik-contract.md.

import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  buildOtlpJsonPayload,
  type Canary,
  type ContractCheck,
  collectForbiddenCanaryLabels,
  contractTarget,
  type IdMappingSpan,
  parseVersionsManifest,
  sanitizeEvidence,
  uuidV7,
  type VerifiedOpikContract,
  validateContract,
} from "../tests/support/opik-contract-fixtures";

type ApiCall = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

class ContractFailure extends Error {}

const SYNTHETIC_FORBIDDEN_CANARIES: Canary[] = [
  { label: "private-key-header", value: "-----BEGIN RSA PRIVATE KEY-----" },
  { label: "private-key-header-ec", value: "-----BEGIN EC PRIVATE KEY-----" },
  { label: "fake-api-token", value: "sk-ant-api03-t04-forbidden-canary" },
  {
    label: "fake-account-identifier",
    value: "forbidden-account@openbot.invalid",
  },
  {
    label: "raw-attachment-blob",
    value: "%%RAW_ATTACHMENT_T04_FORBIDDEN_BLOB%%",
  },
];

const LADDER = [
  1024, 65536, 524288, 1_048_576, 2_097_152, 4_194_304, 8_388_608,
];
const BODY_LIMIT_CAP = 64 * 1024 * 1024;
const MAX_EVIDENCE_BODY_BYTES = 256 * 1024;

function randomHex(chars: number): string {
  let out = "";
  for (let i = 0; i < chars; i++)
    out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

async function fetchJson(
  target: URL,
  call: ApiCall,
): Promise<{ status: number; body: unknown; text: string }> {
  // String-join, not new URL(path, base): call.path is absolute ("/v1/...")
  // and URL resolution would drop the /api prefix of the target.
  const url = `${target.toString().replace(/\/+$/, "")}${call.path}`;
  const response = await fetch(url, {
    method: call.method,
    headers: { "content-type": "application/json", ...(call.headers ?? {}) },
    body: call.body,
    signal: AbortSignal.timeout(call.timeoutMs ?? 20_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  return { status: response.status, body: parsed, text };
}

async function pollUntil(
  label: string,
  timeoutMs: number,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadline)
      throw new ContractFailure(`${label}: timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Reads KEY=VALUE lines and returns the secret VALUES (never printed) as
 * canaries. Only credential-shaped keys count: OPIK_VERSION and friends are
 * deployment facts, not secrets, and would make every version string in the
 * evidence a false positive.
 */
async function loadSecretCanaries(path: string): Promise<Canary[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ContractFailure(
      `secrets env file not found: ${path} (cannot prove non-leakage without it)`,
    );
  }
  const canaries: Canary[] = [];
  for (const line of (await file.text()).split("\n")) {
    const match = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
    if (
      match &&
      match[2].length >= 4 &&
      /PASSWORD|SECRET|TOKEN|KEY|USER/.test(match[1])
    ) {
      canaries.push({ label: `env:${match[1]}`, value: match[2] });
    }
  }
  if (canaries.length === 0) {
    throw new ContractFailure(
      `secrets env file has no credential entries: ${path}`,
    );
  }
  return canaries;
}

type RunningImage = { service: string; image: string; digest: string | null };

function inspectRunningImages(composeProject: string): RunningImage[] {
  const listed = Bun.spawnSync([
    "docker",
    "ps",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
  ]);
  if (listed.exitCode !== 0) {
    throw new ContractFailure(
      `docker ps failed: ${listed.stderr.toString().trim()}`,
    );
  }
  const ids = listed.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length === 0) {
    throw new ContractFailure(
      `no running containers for compose project ${composeProject}`,
    );
  }
  const images: RunningImage[] = [];
  for (const id of ids) {
    const inspect = Bun.spawnSync([
      "docker",
      "inspect",
      id,
      "--format",
      '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Config.Image}}',
    ]);
    if (inspect.exitCode !== 0) {
      throw new ContractFailure(
        `docker inspect ${id} failed: ${inspect.stderr.toString().trim()}`,
      );
    }
    const [service, image] = inspect.stdout.toString().trim().split("\t");
    // Pinned images are referenced as repo@sha256:... so the digest is in the
    // reference itself; tag-referenced images fall back to RepoDigests.
    let digest: string | null = null;
    if (image.includes("@sha256:")) {
      digest = image.slice(image.indexOf("@sha256:") + 1);
    } else {
      const imageInspect = Bun.spawnSync([
        "docker",
        "image",
        "inspect",
        image,
        "--format",
        '{{join .RepoDigests ","}}',
      ]);
      if (imageInspect.exitCode === 0) {
        const repoDigest = imageInspect.stdout
          .toString()
          .trim()
          .split(",")
          .find((entry) => entry.includes("@sha256:"));
        digest = repoDigest
          ? repoDigest.slice(repoDigest.indexOf("@sha256:") + 1)
          : null;
      }
    }
    images.push({ service, image, digest });
  }
  return images;
}

async function lookupSdkDist(
  version: string,
): Promise<VerifiedOpikContract["sdk"]["npmDist"]> {
  try {
    const response = await fetch(`https://registry.npmjs.org/opik/${version}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const dist = (await response.json()) as {
      dist?: { shasum?: string; tarball?: string };
    };
    return dist.dist
      ? { shasum: dist.dist.shasum, tarball: dist.dist.tarball }
      : null;
  } catch {
    return null;
  }
}

export async function runOpikContract(options: {
  target: URL;
  project: string;
  evidenceDir: string;
  versionsPath: string;
  secretsEnvPath: string;
  composeProject: string;
}): Promise<VerifiedOpikContract> {
  const {
    target,
    project,
    evidenceDir,
    versionsPath,
    secretsEnvPath,
    composeProject,
  } = options;

  const versions = parseVersionsManifest(await Bun.file(versionsPath).json());
  const forbiddenCanaries = [
    ...(await loadSecretCanaries(secretsEnvPath)),
    ...SYNTHETIC_FORBIDDEN_CANARIES,
  ];
  const safeMarker = `SAFE_CANARY_T04_${randomHex(8)}`;
  const secretValues = forbiddenCanaries.map((canary) => canary.value);

  const checks: ContractCheck[] = [];
  const diagnostics: string[] = [];
  const writtenFiles: string[] = [];
  const rawEvidenceTexts: string[] = [];
  let evidenceCounter = 0;

  // Request/response bodies larger than MAX_EVIDENCE_BODY_BYTES are stored as a
  // size note so multi-megabyte body-limit probes never bloat the evidence.
  const summarize = (body: string | undefined): unknown => {
    if (body === undefined) return undefined;
    if (Buffer.byteLength(body, "utf8") > MAX_EVIDENCE_BODY_BYTES) {
      return {
        note: "large body omitted from evidence",
        bodyBytes: Buffer.byteLength(body, "utf8"),
      };
    }
    return JSON.parse(body);
  };

  const writeEvidence = async (
    name: string,
    value: unknown,
  ): Promise<string> => {
    const fileName = `${String(++evidenceCounter).padStart(2, "0")}-${name}.json`;
    // The disk copy is sanitized, but the final forbidden-canary scan must see
    // what WOULD have leaked: sanitized-only scanning removes the canaries
    // before it looks for them and can never fire (review finding R2-31). The
    // raw text is retained in memory only — nothing unsanitized is written.
    rawEvidenceTexts.push(JSON.stringify(value));
    await writeFile(
      `${evidenceDir}/${fileName}`,
      `${JSON.stringify(sanitizeEvidence(value, secretValues), null, 2)}\n`,
    );
    writtenFiles.push(fileName);
    return fileName;
  };

  const api = async (
    step: string,
    call: ApiCall,
    expectedStatus: number,
  ): Promise<{ status: number; body: unknown; file: string }> => {
    const result = await fetchJson(target, call);
    const file = await writeEvidence(step, {
      step,
      request: {
        method: call.method,
        path: call.path,
        headers: call.headers ?? {},
        body: summarize(call.body),
        bodyBytes:
          call.body === undefined
            ? undefined
            : Buffer.byteLength(call.body, "utf8"),
      },
      response: {
        status: result.status,
        body:
          typeof result.body === "string"
            ? result.body.slice(0, 2000)
            : result.body,
      },
    });
    diagnostics.push(
      `${step}: ${call.method} ${call.path} -> ${result.status} (${file})`,
    );
    if (result.status !== expectedStatus) {
      throw new ContractFailure(
        `${step}: expected HTTP ${expectedStatus}, got ${result.status}`,
      );
    }
    return { status: result.status, body: result.body, file };
  };

  const record = (name: string, evidenceFile: string): void => {
    checks.push({ name, ok: true, evidence: evidenceFile });
  };

  const threadId = `t04-thread-${randomHex(8)}`;
  const suffix = safeMarker.slice(-6);
  const parentName = `t04-parent-${suffix}`;
  const childName = `t04-child-${suffix}`;
  const attempt2Name = `t04-attempt2-${suffix}`;

  const traceAHex = randomHex(32);
  const spanA1Hex = randomHex(16);
  const spanA2Hex = randomHex(16);
  const traceBHex = randomHex(32);
  const spanB1Hex = randomHex(16);
  const spanB2Hex = randomHex(16);
  const traceBOpik = uuidV7();
  const spanB1Opik = uuidV7();
  const spanB2Opik = uuidV7();

  let projectId = "";
  let traceAOpikId = "";
  let spanA1OpikId = "";
  let spanA2OpikId = "";
  let experimentId = "";
  let datasetId = "";
  let datasetVersions: VerifiedOpikContract["datasets"]["versions"] = [];
  const idMappingSpans: IdMappingSpan[] = [];
  let bodyLimit = {
    maxAcceptedBytes: 0,
    minRejectedBytes: null as number | null,
    cappedAtBytes: null as number | null,
  };
  let digestImages: VerifiedOpikContract["service"]["images"] = [];
  let traceQueryFile = "";

  const retrieveProject = (): ApiCall => ({
    method: "POST",
    path: "/v1/private/projects/retrieve",
    body: JSON.stringify({ name: project }),
  });

  try {
    // 1. Service health.
    const health = await api(
      "health-check",
      { method: "GET", path: "/health-check" },
      200,
    );
    record("service-health", health.file);

    // 2. Running image digests vs the pinned versions.json.
    const running = inspectRunningImages(composeProject);
    digestImages = Object.entries(versions.opik.images).map(
      ([name, pinned]) => {
        const runningDigest =
          running.find((entry) => entry.service === name)?.digest ?? "";
        return {
          name,
          repository: pinned.repository,
          tag: pinned.tag,
          pinnedDigest: pinned.digest,
          runningDigest,
          match: runningDigest === pinned.digest,
        };
      },
    );
    const imagesFile = await writeEvidence("running-images", {
      composeProject,
      running,
      images: digestImages,
      versionsSha256Note:
        "docker/opik/versions.json is byte-identical to branch 1123786563/opik-t03-deployment (sha256 04d7f202d70db203e38f3ec7ab4d40a48b8575dce9bfbea468f89d17e4e7262c)",
    });
    const mismatched = digestImages.filter((image) => !image.match);
    if (mismatched.length > 0) {
      throw new ContractFailure(
        `running image digests do not match pinned digests: ${mismatched.map((image) => image.name).join(", ")}`,
      );
    }
    record("image-digests-pinned", imagesFile);

    // 3. OTLP write: derived-ID trace with parent/child spans, safe canary, shared thread.
    const payloadA = buildOtlpJsonPayload({
      threadId,
      spans: [
        {
          name: parentName,
          traceHex: traceAHex,
          spanHex: spanA1Hex,
          attributes: {
            "input.value": `{"marker":"${safeMarker}"}`,
            "output.value": "ack",
          },
        },
        {
          name: childName,
          traceHex: traceAHex,
          spanHex: spanA2Hex,
          parentSpanHex: spanA1Hex,
          attributes: { "input.value": "child-input" },
        },
      ],
    });
    const writeA = await api(
      "otlp-write-derived",
      {
        method: "POST",
        path: "/v1/private/otel/v1/traces",
        headers: { projectName: project },
        body: JSON.stringify(payloadA),
      },
      200,
    );

    // 4. Resolve the auto-created isolated project (creation is asynchronous).
    await pollUntil("project visible", 30_000, async () => {
      const result = await fetchJson(target, retrieveProject());
      const body = result.body as { id?: string };
      return result.status === 200 && typeof body?.id === "string";
    });
    const projectRow = await api("project-retrieve", retrieveProject(), 200);
    projectId = (projectRow.body as { id: string }).id;

    // 5. Attempt 2 on the same thread with explicit ids: Opik spans carrying
    //    opik.* overrides attach to an EXISTING trace, so the trace is created
    //    first via REST with our own UUIDv7 id, then the OTLP spans override
    //    into it. This is the cross-service identity path for later adapters.
    await api(
      "trace-b-rest-create",
      {
        method: "POST",
        path: "/v1/private/traces",
        body: JSON.stringify({
          id: traceBOpik,
          project_name: project,
          name: attempt2Name,
          start_time: new Date().toISOString(),
          thread_id: threadId,
        }),
      },
      201,
    );
    const payloadB = buildOtlpJsonPayload({
      threadId,
      spans: [
        {
          name: attempt2Name,
          traceHex: traceBHex,
          spanHex: spanB1Hex,
          opikTraceId: traceBOpik,
          opikSpanId: spanB1Opik,
          attributes: { "input.value": "attempt-2-explicit-ids" },
        },
        {
          name: `${attempt2Name}-child`,
          traceHex: traceBHex,
          spanHex: spanB2Hex,
          parentSpanHex: spanB1Hex,
          opikTraceId: traceBOpik,
          opikSpanId: spanB2Opik,
          opikParentSpanId: spanB1Opik,
          attributes: { "input.value": "attempt-2-child" },
        },
      ],
    });
    await api(
      "otlp-write-explicit",
      {
        method: "POST",
        path: "/v1/private/otel/v1/traces",
        headers: { projectName: project },
        body: JSON.stringify(payloadB),
      },
      200,
    );
    record("otlp-write-parent-child", writeA.file);

    // 6. Query both attempts: derived ids for A, override honored for B, shared thread.
    type TraceRow = { id: string; name: string; thread_id?: string };
    const traces = await api(
      "trace-query",
      {
        method: "GET",
        path: `/v1/private/traces?project_id=${projectId}&size=100`,
      },
      200,
    );
    traceQueryFile = traces.file;
    const traceContent =
      (traces.body as { content?: TraceRow[] }).content ?? [];
    const traceA = traceContent.find((row) => row.name === parentName);
    const traceB = traceContent.find((row) => row.name === attempt2Name);
    if (!traceA)
      throw new ContractFailure(
        `trace A (${parentName}) not queryable after OTLP write`,
      );
    if (!traceB)
      throw new ContractFailure(
        `trace B (${attempt2Name}) not queryable after OTLP write`,
      );
    traceAOpikId = traceA.id;
    if (traceB.id !== traceBOpik) {
      throw new ContractFailure(
        `explicit opik.trace_id override not honored: sent ${traceBOpik}, stored ${traceB.id}`,
      );
    }
    if (traceA.thread_id !== threadId || traceB.thread_id !== threadId) {
      throw new ContractFailure(
        "thread_id not preserved on the shared thread across attempts",
      );
    }
    record("trace-query-id-mapping", traces.file);

    // 7. Query spans per trace: full id mapping, parent linkage, canary round-trip.
    type SpanRow = { id: string; name: string; parent_span_id?: string | null };
    const spanQueries: Array<{
      label: string;
      traceId: string;
      wanted: Array<[string, string]>;
    }> = [
      {
        label: "span-query-derived",
        traceId: traceAOpikId,
        wanted: [
          [spanA1Hex, parentName],
          [spanA2Hex, childName],
        ],
      },
      {
        label: "span-query-explicit",
        traceId: traceBOpik,
        wanted: [
          [spanB1Hex, attempt2Name],
          [spanB2Hex, `${attempt2Name}-child`],
        ],
      },
    ];
    for (const query of spanQueries) {
      const result = await api(
        query.label,
        {
          method: "GET",
          path: `/v1/private/spans?project_id=${projectId}&trace_id=${query.traceId}&size=100`,
        },
        200,
      );
      const rows = (result.body as { content?: SpanRow[] }).content ?? [];
      for (const [otelSpanHex, spanName] of query.wanted) {
        const row = rows.find((entry) => entry.name === spanName);
        if (!row)
          throw new ContractFailure(
            `span ${spanName} not found in ${query.label}`,
          );
        idMappingSpans.push({
          otelSpanId: otelSpanHex,
          opikSpanId: row.id,
          opikParentSpanId: row.parent_span_id ?? null,
        });
      }
    }
    spanA1OpikId = idMappingSpans[0].opikSpanId;
    spanA2OpikId = idMappingSpans[1].opikSpanId;
    if (idMappingSpans[1].opikParentSpanId !== idMappingSpans[0].opikSpanId) {
      throw new ContractFailure(
        "derived parent/child spans are not linked in Opik storage",
      );
    }
    if (idMappingSpans[3].opikParentSpanId !== idMappingSpans[2].opikSpanId) {
      throw new ContractFailure(
        "explicit-id parent/child spans are not linked in Opik storage",
      );
    }
    if (
      idMappingSpans[2].opikSpanId !== spanB1Opik ||
      idMappingSpans[3].opikSpanId !== spanB2Opik
    ) {
      throw new ContractFailure("explicit opik.span_id overrides not honored");
    }
    const spanDetail = await api(
      "span-detail-canary",
      {
        method: "GET",
        path: `/v1/private/spans/${spanA1OpikId}?project_id=${projectId}`,
      },
      200,
    );
    if (!JSON.stringify(spanDetail.body).includes(safeMarker)) {
      throw new ContractFailure(
        "safe canary did not round-trip into stored span data",
      );
    }
    record("parent-child-query-link", spanDetail.file);

    // 8. Dataset with immutable versions: v1 (one item), then v2 via batch_group_id.
    type VersionRow = {
      version_name?: string;
      version_hash?: string;
      items_total?: number;
    };
    const datasetName = `${project}-ds`;
    await api(
      "dataset-create",
      {
        method: "POST",
        path: "/v1/private/datasets",
        body: JSON.stringify({ name: datasetName, project_id: projectId }),
      },
      201,
    );
    await api(
      "dataset-items-v1",
      {
        method: "PUT",
        path: "/v1/private/datasets/items",
        body: JSON.stringify({
          dataset_name: datasetName,
          items: [
            { source: "sdk", data: { q: "t04-first", expected: "first" } },
          ],
        }),
      },
      204,
    );
    await api(
      "dataset-query",
      {
        method: "GET",
        path: `/v1/private/datasets?project_id=${projectId}&name=${encodeURIComponent(datasetName)}`,
      },
      200,
    ).then((result) => {
      datasetId =
        (result.body as { content?: Array<{ id?: string }> }).content?.[0]
          ?.id ?? "";
    });
    if (!datasetId) throw new ContractFailure("created dataset not queryable");
    await pollUntil("dataset v1 visible", 30_000, async () => {
      const result = await fetchJson(target, {
        method: "GET",
        path: `/v1/private/datasets/${datasetId}/versions`,
      });
      const content = (result.body as { content?: VersionRow[] }).content ?? [];
      return (
        result.status === 200 &&
        content.some((row) => row.version_name === "v1")
      );
    });
    const versionsAfterV1 = await api(
      "dataset-versions-v1",
      { method: "GET", path: `/v1/private/datasets/${datasetId}/versions` },
      200,
    );
    const v1 =
      (versionsAfterV1.body as { content?: VersionRow[] }).content?.find(
        (row) => row.version_name === "v1",
      ) ?? null;
    if (!v1?.version_hash || v1.items_total !== 1) {
      throw new ContractFailure(
        "dataset v1 missing or does not hold exactly one item",
      );
    }
    const v1Hash = v1.version_hash;
    await api(
      "dataset-items-v2",
      {
        method: "PUT",
        path: "/v1/private/datasets/items",
        body: JSON.stringify({
          dataset_id: datasetId,
          batch_group_id: uuidV7(),
          items: [
            { source: "sdk", data: { q: "t04-second", expected: "second" } },
          ],
        }),
      },
      204,
    );
    await pollUntil("dataset v2 visible", 30_000, async () => {
      const result = await fetchJson(target, {
        method: "GET",
        path: `/v1/private/datasets/${datasetId}/versions`,
      });
      const content = (result.body as { content?: VersionRow[] }).content ?? [];
      return (
        result.status === 200 &&
        content.some((row) => row.version_name === "v2")
      );
    });
    const versionsAfterV2 = await api(
      "dataset-versions-v2",
      { method: "GET", path: `/v1/private/datasets/${datasetId}/versions` },
      200,
    );
    datasetVersions = (
      (versionsAfterV2.body as { content?: VersionRow[] }).content ?? []
    ).map((row) => ({
      versionName: row.version_name ?? "",
      versionHash: row.version_hash ?? "",
      itemsTotal: row.items_total ?? 0,
    }));
    const v1After = datasetVersions.find((row) => row.versionName === "v1");
    const v2After = datasetVersions.find((row) => row.versionName === "v2");
    if (
      !v1After ||
      v1After.versionHash !== v1Hash ||
      v1After.itemsTotal !== 1
    ) {
      throw new ContractFailure(
        "dataset v1 changed after v2 was created (version not immutable)",
      );
    }
    if (v2After?.itemsTotal !== 2)
      throw new ContractFailure("dataset v2 does not hold both items");
    const v1Items = await api(
      "dataset-v1-items-immutability",
      {
        method: "GET",
        path: `/v1/private/datasets/${datasetId}/items?version=${v1Hash}&size=100`,
      },
      200,
    );
    const v1ItemsText = JSON.stringify(v1Items.body);
    if (
      v1ItemsText.includes("t04-second") ||
      !v1ItemsText.includes("t04-first")
    ) {
      throw new ContractFailure(
        "dataset v1 items leaked the v2 write (immutability violated)",
      );
    }
    record("dataset-versioned-samples", versionsAfterV2.file);

    // 9. Experiment on the dataset, items linked to both attempts' traces.
    const experimentName = `${project}-exp`;
    await api(
      "experiment-create",
      {
        method: "POST",
        path: "/v1/private/experiments",
        body: JSON.stringify({
          name: experimentName,
          dataset_name: datasetName,
          project_id: projectId,
        }),
      },
      201,
    );
    await pollUntil("experiment visible", 30_000, async () => {
      const result = await fetchJson(target, {
        method: "GET",
        path: `/v1/private/experiments?project_id=${projectId}&name=${encodeURIComponent(experimentName)}`,
      });
      const content =
        (result.body as { content?: Array<{ id?: string }> }).content ?? [];
      return result.status === 200 && (content.length ?? 0) > 0;
    });
    const experimentsPage = await api(
      "experiment-query",
      {
        method: "GET",
        path: `/v1/private/experiments?project_id=${projectId}&name=${encodeURIComponent(experimentName)}`,
      },
      200,
    );
    experimentId =
      (experimentsPage.body as { content?: Array<{ id?: string }> })
        .content?.[0]?.id ?? "";
    if (!experimentId)
      throw new ContractFailure("created experiment not queryable");
    const datasetItems = await api(
      "experiment-dataset-items",
      {
        method: "GET",
        path: `/v1/private/datasets/${datasetId}/items?size=100`,
      },
      200,
    );
    const itemRows =
      (datasetItems.body as { content?: Array<{ id?: string }> }).content ?? [];
    if (itemRows.length !== 2)
      throw new ContractFailure(
        `expected 2 dataset items, got ${itemRows.length}`,
      );
    await api(
      "experiment-items-write",
      {
        method: "POST",
        path: "/v1/private/experiments/items",
        body: JSON.stringify({
          experiment_items: itemRows.map((row, index) => ({
            experiment_id: experimentId,
            dataset_item_id: row.id,
            trace_id: index === 0 ? traceAOpikId : traceBOpik,
          })),
        }),
      },
      204,
    );
    const experimentGet = await api(
      "experiment-get",
      { method: "GET", path: `/v1/private/experiments/${experimentId}` },
      200,
    );
    record("experiment-create-query", experimentGet.file);

    // 10. Body limit boundary with safe synthetic content (same isolated project).
    // maxAcceptedBytes/minRejectedBytes count the full OTLP request body bytes.
    const probeBody = (fill: number): string =>
      JSON.stringify(
        buildOtlpJsonPayload({
          threadId,
          spans: [
            {
              name: `t04-bodylimit-${fill}`,
              traceHex: randomHex(32),
              spanHex: randomHex(16),
              attributes: { "input.value": "x".repeat(fill) },
            },
          ],
        }),
      );
    const probeOnce = async (
      fill: number,
    ): Promise<{ accepted: boolean; bodyBytes: number }> => {
      const body = probeBody(fill);
      const bodyBytes = Buffer.byteLength(body, "utf8");
      const result = await fetchJson(target, {
        method: "POST",
        path: "/v1/private/otel/v1/traces",
        headers: { projectName: project },
        body,
        timeoutMs: 180_000,
      });
      await writeEvidence(`body-limit-probe-${fill}`, {
        step: `body-limit-probe-${fill}`,
        request: {
          method: "POST",
          path: "/v1/private/otel/v1/traces",
          headers: { projectName: project },
          bodyBytes,
        },
        response: { status: result.status, body: result.text.slice(0, 2000) },
      });
      diagnostics.push(
        `body-limit-probe-${fill}: ${bodyBytes} bytes -> ${result.status}`,
      );
      return { accepted: result.status === 200, bodyBytes };
    };
    let maxAccepted = 0;
    let minRejected: number | null = null;
    let cappedAt: number | null = null;
    const sizes = [
      ...LADDER,
      16 * 1024 * 1024,
      32 * 1024 * 1024,
      BODY_LIMIT_CAP,
    ];
    for (const size of sizes) {
      const probe = await probeOnce(size);
      if (probe.accepted) {
        maxAccepted = probe.bodyBytes;
      } else {
        minRejected = probe.bodyBytes;
        break;
      }
    }
    if (minRejected === null) {
      cappedAt = BODY_LIMIT_CAP;
    } else {
      // Binary-search the boundary between the last accepted and first rejected size.
      let low = maxAccepted;
      let high = minRejected;
      for (let i = 0; i < 7 && high - low > 1024; i++) {
        const mid = Math.floor((low + high) / 2);
        const fill = Math.max(mid - 480, 1); // ~480B of JSON scaffolding around the fill
        const probe = await probeOnce(fill);
        if (probe.accepted && probe.bodyBytes <= high) {
          low = probe.bodyBytes;
        } else {
          high = probe.bodyBytes;
        }
      }
      maxAccepted = low;
      minRejected = high;
    }
    if (maxAccepted <= 0)
      throw new ContractFailure(
        "even the smallest OTLP body probe was rejected",
      );
    bodyLimit = {
      maxAcceptedBytes: maxAccepted,
      minRejectedBytes: minRejected,
      cappedAtBytes: cappedAt,
    };
    const bodyLimitFile = await writeEvidence("body-limit-summary", {
      ladderFills: sizes,
      ...bodyLimit,
      semantics: "bytes of the full serialized OTLP POST body",
    });
    record("body-limit-boundary", bodyLimitFile);

    // 11. Physical deletion of only our objects, then absence proofs.
    const tracesBeforeDelete = await api(
      "deletion-trace-list",
      {
        method: "GET",
        path: `/v1/private/traces?project_id=${projectId}&size=1000`,
      },
      200,
    );
    const traceIds = (
      (tracesBeforeDelete.body as { content?: Array<{ id: string }> })
        .content ?? []
    ).map((row) => row.id);
    if (traceIds.length < 3) {
      throw new ContractFailure(
        `expected at least 3 traces (2 contract + body-limit), got ${traceIds.length}`,
      );
    }
    await api(
      "traces-delete",
      {
        method: "POST",
        path: "/v1/private/traces/delete",
        body: JSON.stringify({ ids: traceIds, project_id: projectId }),
      },
      204,
    );
    // Physical deletion is asynchronous on the analytics side: a 404 may take
    // a few seconds to stick, so poll for absence and record the final state.
    const absence = async (
      step: string,
      path: string,
    ): Promise<{ gone: boolean; file: string }> => {
      const deadline = Date.now() + 30_000;
      let status = 0;
      let body: unknown = null;
      for (;;) {
        const result = await fetchJson(target, { method: "GET", path });
        status = result.status;
        body = result.body;
        if (status === 404 || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const file = await writeEvidence(step, {
        step,
        request: { method: "GET", path, headers: {} },
        response: {
          status,
          body: typeof body === "string" ? body.slice(0, 2000) : body,
        },
      });
      diagnostics.push(
        `${step}: GET ${path} -> ${status} after poll (${file})`,
      );
      return { gone: status === 404, file };
    };
    const traceAGone = await absence(
      "trace-a-absence",
      `/v1/private/traces/${traceAOpikId}?project_id=${projectId}`,
    );
    if (!traceAGone.gone)
      throw new ContractFailure("trace A still queryable after delete");
    if (
      !(
        await absence(
          "trace-b-absence",
          `/v1/private/traces/${traceBOpik}?project_id=${projectId}`,
        )
      ).gone
    ) {
      throw new ContractFailure("trace B still queryable after delete");
    }
    const spanA1 = await absence(
      "span-a1-absence",
      `/v1/private/spans/${spanA1OpikId}?project_id=${projectId}`,
    );
    const spanA2 = await absence(
      "span-a2-absence",
      `/v1/private/spans/${spanA2OpikId}?project_id=${projectId}`,
    );
    if (!spanA1.gone || !spanA2.gone)
      throw new ContractFailure("span still queryable after trace delete");
    record("trace-span-physical-delete", traceAGone.file);

    await api(
      "experiment-delete",
      {
        method: "POST",
        path: "/v1/private/experiments/delete",
        body: JSON.stringify({ ids: [experimentId] }),
      },
      204,
    );
    const experimentGone = await absence(
      "experiment-absence",
      `/v1/private/experiments/${experimentId}`,
    );
    if (!experimentGone.gone) {
      throw new ContractFailure("experiment still queryable after delete");
    }
    await api(
      "dataset-delete",
      {
        method: "POST",
        path: "/v1/private/datasets/delete-batch",
        body: JSON.stringify({ ids: [datasetId] }),
      },
      204,
    );
    if (
      !(await absence("dataset-absence", `/v1/private/datasets/${datasetId}`))
        .gone
    ) {
      throw new ContractFailure("dataset still queryable after delete");
    }
    record("experiment-dataset-physical-delete", experimentGone.file);

    await api(
      "project-delete",
      {
        method: "POST",
        path: "/v1/private/projects/delete",
        body: JSON.stringify({ ids: [projectId] }),
      },
      204,
    );
    const projectGone = await api("project-absence", retrieveProject(), 404);
    record("project-physical-delete", projectGone.file);
  } catch (error) {
    // Best-effort cleanup so a failed run leaves no synthetic residue behind.
    try {
      if (projectId) {
        await fetchJson(target, {
          method: "POST",
          path: "/v1/private/projects/delete",
          body: JSON.stringify({ ids: [projectId] }),
        });
        diagnostics.push("cleanup: deleted isolated project after failure");
      }
    } catch {
      diagnostics.push("cleanup: project cleanup failed after failure");
    }
    await writeEvidence("evidence-partial", {
      checks,
      diagnostics,
      error: error instanceof Error ? error.message : String(error),
    });
    await writeEvidence("diagnostics", {
      diagnostics,
      safeMarker,
      forbiddenCanaryLabels: forbiddenCanaries.map((canary) => canary.label),
    });
    console.error(
      `contract FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }

  // 12. Assemble the manifest, scan every artifact for canaries, validate, emit.
  const manifest: VerifiedOpikContract = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    target: { baseUrl: target.toString(), composeProject },
    isolatedProject: { name: project, id: projectId, deleted: true },
    service: {
      version: versions.opik.version,
      upstreamCommit: versions.opik.upstreamCommit,
      images: digestImages,
    },
    sdk: {
      typescript: versions.sdk.typescript ?? "",
      npmDist: await lookupSdkDist(versions.sdk.typescript ?? ""),
    },
    capabilities: checks,
    idMapping: {
      derivation:
        "without opik.* overrides the backend derives Opik UUIDv7 ids from the OTel ids (SHA-256 based); with opik.trace_id/opik.span_id/opik.parent_span_id overrides (UUIDv7 strings) the backend uses them verbatim",
      traces: [
        {
          kind: "derived",
          otelTraceId: traceAHex,
          opikTraceId: traceAOpikId,
          source: traceQueryFile,
        },
        {
          kind: "explicit",
          otelTraceId: traceBHex,
          opikTraceId: traceBOpik,
          source: traceQueryFile,
        },
      ],
      spans: idMappingSpans,
    },
    datasets: {
      datasetId,
      versions: datasetVersions,
      immutabilityVerified: true,
    },
    experiments: { experimentId, verified: true },
    deletion: {
      traces: [
        { opikId: traceAOpikId, absentAfterDelete: true },
        { opikId: traceBOpik, absentAfterDelete: true },
      ],
      spans: [
        { opikId: spanA1OpikId, absentAfterDelete: true },
        { opikId: spanA2OpikId, absentAfterDelete: true },
      ],
      dataset: { id: datasetId, absentAfterDelete: true },
      experiment: { id: experimentId, absentAfterDelete: true },
      project: { id: projectId, absentAfterDelete: true },
    },
    bodyLimit,
    canaries: {
      safe: { marker: safeMarker, foundInStoredSpan: true },
      forbiddenFound: [],
    },
    fixtures: [],
    checks: {
      total: checks.length,
      passed: checks.filter((check) => check.ok).length,
    },
  };

  await writeEvidence("diagnostics", {
    diagnostics,
    safeMarker,
    forbiddenCanaryLabels: forbiddenCanaries.map((canary) => canary.label),
  });

  // Canary scan across everything this run serialized: the raw (pre-sanitization)
  // evidence text in memory, the manifest and diagnostics, and the sanitized disk
  // files as a final defense. Requests kept in memory are gone; the raw evidence
  // texts are what make the forbidden redline genuinely triggerable — a
  // sanitized-files-only scan deletes the canaries before it searches and is
  // structurally empty (review finding R2-31).
  const forbiddenTexts: string[] = [
    JSON.stringify(manifest),
    JSON.stringify(diagnostics),
    ...rawEvidenceTexts,
  ];
  for (const file of writtenFiles) {
    forbiddenTexts.push(await Bun.file(`${evidenceDir}/${file}`).text());
  }
  const forbiddenFound = collectForbiddenCanaryLabels(
    forbiddenTexts,
    forbiddenCanaries,
  );
  manifest.canaries.forbiddenFound = forbiddenFound;
  manifest.fixtures = writtenFiles;

  const verdict = validateContract(manifest);
  if (!verdict.ok) {
    await writeEvidence("validation-failures", verdict.errors);
    throw new ContractFailure(
      `manifest failed validation: ${verdict.errors.join("; ")}`,
    );
  }

  await writeEvidence("manifest", manifest);
  return manifest;
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      args[arg.slice(2)] = value;
      i++;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

const isDirectRun =
  process.argv[1] && basename(process.argv[1]) === "opik-contract.ts";
if (isDirectRun) {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.target || !args.evidence) {
    console.error(
      "usage: bun server/scripts/opik-contract.ts --target <base-url> --evidence <dir> [--versions <path>] [--secrets-env <path>] [--compose-project <name>]",
    );
    process.exit(2);
  }
  const { baseUrl: target, project } = contractTarget({
    baseUrl: args.target,
    project: args.project,
  });
  await mkdir(args.evidence, { recursive: true });
  try {
    const manifest = await runOpikContract({
      target,
      project,
      evidenceDir: args.evidence,
      versionsPath: args.versions ?? "docker/opik/versions.json",
      secretsEnvPath: args["secrets-env"] ?? "/tmp/opik-issue4-validation.env",
      composeProject: args["compose-project"] ?? "opik-issue4-validation",
    });
    console.log(
      `VerifiedOpikContract: opik ${manifest.service.version} VERIFIED (${manifest.checks.passed}/${manifest.checks.total} checks, bodyLimit ${manifest.bodyLimit.maxAcceptedBytes}B accepted)`,
    );
  } catch (error) {
    console.error(
      `contract run failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
