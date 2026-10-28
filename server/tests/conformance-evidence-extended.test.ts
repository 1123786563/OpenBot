import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  CONFORMANCE_EVIDENCE,
  DELIVERED_FINGERPRINTS,
  admittedEntrypointsWithoutEvidence,
  conformanceGroupOf,
  enableableWithEvidence,
  evidenceFingerprint,
  staleEvidence,
  type ConformanceConstraintKind,
  type ConformanceRecord,
} from "../src/billing/conformance-evidence";
import {
  CONFORMANCE_GROUP_22_4,
  MODEL_ENTRYPOINTS,
} from "../src/billing/entrypoint-catalog";

/*
 * Ticket 22.4 (#355) — conformance evidence for the remaining families:
 * Embedding/Rerank/OCR、实时（WS/WebRTC）、异步/批量/视频、工具附加费 — the SAME store,
 * the SAME shape, the SAME invalidation rule 22.3 established (共用同一证据结构与存储:
 * a second format here would leave 22.5 unable to verify both halves with one lens).
 *
 * Beyond 22.3's completeness checks, this file pins the family-specific key constraints
 * the ticket names: the realtime family's 单元门控、耗尽停止、关停尾部; the async
 * family's 终态结算 and cancel-unknown-held; the tool family's 附加费计价 and
 * 逐入口无旁路 — each as a DEDICATED constraint entry, not a sentence inside another.
 */

const repoRoot = join(import.meta.dirname, "../..");

const readRepoFile = (modulePath: string) =>
  readFileSync(join(repoRoot, modulePath), "utf8");
const repoFileExists = (modulePath: string) =>
  existsSync(join(repoRoot, modulePath));

const GROUP_RECORDS = CONFORMANCE_EVIDENCE.filter(
  (record) => record.group === "22.4",
);

function recordOf(family: string): ConformanceRecord {
  const record = GROUP_RECORDS.find((entry) => entry.family === family);
  expect(record, family).toBeDefined();
  return record as ConformanceRecord;
}

function constraintKinds(
  record: ConformanceRecord,
): Set<ConformanceConstraintKind> {
  return new Set(record.constraints.map((constraint) => constraint.kind));
}

describe("Bifrost 22.4 (#355): conformance evidence — Embedding/实时/异步/工具", () => {
  test("every admitted 22.4-family entrance is covered, by the same store 22.3 uses", () => {
    expect(admittedEntrypointsWithoutEvidence()).toEqual([]);
    const admitted224 = MODEL_ENTRYPOINTS.filter(
      (row) =>
        row.admission.status === "admitted" &&
        CONFORMANCE_GROUP_22_4.includes(row.family),
    );
    expect(admitted224.length).toBeGreaterThanOrEqual(14);
    const covered = new Set(
      GROUP_RECORDS.flatMap((record) => record.entrypointIds),
    );
    for (const row of admitted224) {
      expect(covered.has(row.id), row.id).toBe(true);
    }
    // All ten families the ticket names have records.
    for (const family of [
      "embedding",
      "rerank",
      "ocr",
      "realtime",
      "async",
      "batch",
      "video",
      "tool",
      "evaluation",
      "harness",
    ]) {
      expect(recordOf(family).group).toBe("22.4");
    }
  });

  test("the realtime family carries its three key constraints as dedicated entries", () => {
    const kinds = constraintKinds(recordOf("realtime"));
    expect(kinds.has("unit-gating")).toBe(true);
    expect(kinds.has("exhaustion-stop")).toBe(true);
    expect(kinds.has("shutdown-tail")).toBe(true);
    expect(kinds.has("no-bypass")).toBe(true);
  });

  test("the async family carries terminal settlement and unknown-holds retention; batch and video their own", () => {
    const asyncKinds = constraintKinds(recordOf("async"));
    expect(asyncKinds.has("terminal-settlement")).toBe(true);
    expect(asyncKinds.has("unknown-holds-retained")).toBe(true);

    const batchKinds = constraintKinds(recordOf("batch"));
    expect(batchKinds.has("terminal-settlement")).toBe(true);
    expect(batchKinds.has("cancel-tail")).toBe(true);

    const videoKinds = constraintKinds(recordOf("video"));
    expect(videoKinds.has("terminal-settlement")).toBe(true);
    expect(videoKinds.has("unknown-holds-retained")).toBe(true);
  });

  test("the tool family carries surcharge pricing and the no-bypass entry as dedicated entries", () => {
    const kinds = constraintKinds(recordOf("tool"));
    expect(kinds.has("surcharge-pricing")).toBe(true);
    expect(kinds.has("no-bypass")).toBe(true);
    expect(kinds.has("usage-observable")).toBe(true);
  });

  test("every record's shape, commands and version bindings are real — same rule as 22.3", () => {
    for (const record of GROUP_RECORDS) {
      expect(record.constraints.length, record.id).toBeGreaterThan(0);
      expect(record.verification.commands.length, record.id).toBeGreaterThan(0);
      expect(
        record.verification.resultSummary.length,
        record.id,
      ).toBeGreaterThan(0);
      for (const command of record.verification.commands) {
        const match = command.match(
          /(server\/tests\/[A-Za-z0-9_./-]+\.test\.ts[ex]*)/,
        );
        expect(match, `${record.id}: ${command}`).not.toBeNull();
        if (match)
          expect(existsSync(join(repoRoot, match[1])), match[1]).toBe(true);
      }
      for (const modulePath of record.versionBinding) {
        expect(repoFileExists(modulePath), `${record.id}: ${modulePath}`).toBe(
          true,
        );
      }
      if (record.needsProviderEnvironment) {
        expect(record.verification.environment, record.id).toBe(
          "local-deterministic",
        );
      }
    }
  });

  test("the invalidation rule is the same machinery — the delivered fingerprints hold, and a changed bound module stale-marks this half too", () => {
    // The same ARMED check 22.3's file carries, over the whole store (both halves).
    expect(
      staleEvidence(DELIVERED_FINGERPRINTS, readRepoFile, repoFileExists),
    ).toEqual([]);
    const fingerprints = Object.fromEntries(
      CONFORMANCE_EVIDENCE.map((record) => [
        record.id,
        evidenceFingerprint(record, readRepoFile),
      ]),
    );
    expect(staleEvidence(fingerprints, readRepoFile, repoFileExists)).toEqual(
      [],
    );

    // The realtime unit door changed (a stage reordered): the realtime record goes stale,
    // its entrances drop out of the enableable projection, everything else stays.
    const changed = (modulePath: string) =>
      modulePath.endsWith("realtime-unit.ts")
        ? `${readRepoFile(modulePath)}// edited\n`
        : readRepoFile(modulePath);
    const stale = staleEvidence(fingerprints, changed, repoFileExists);
    expect(stale.map((entry) => entry.id)).toEqual(["conformance.realtime"]);
    const enableable = enableableWithEvidence({
      stale: new Set(["conformance.realtime"]),
    });
    expect(enableable).not.toContain("realtime.ws.main");
    expect(enableable).not.toContain("realtime.webrtc.sdp");
    expect(enableable).toContain("tool.mcp.tool_call");
    expect(enableable).toContain("async.jobs");
  });

  test("the group split agrees with the catalog, and no record straddles it", () => {
    for (const record of CONFORMANCE_EVIDENCE) {
      expect(record.group).toBe(conformanceGroupOf(record.family));
      const familiesCovered = new Set(
        MODEL_ENTRYPOINTS.filter((row) => row.family === record.family).map(
          (row) => row.family,
        ),
      );
      expect(familiesCovered.size, record.id).toBe(1);
    }
    // The blocked/absent rows are never evidence-covered — evidence states capability,
    // and a blocked entrance has none.
    const covered = new Set(
      CONFORMANCE_EVIDENCE.flatMap((r) => r.entrypointIds),
    );
    for (const row of MODEL_ENTRYPOINTS) {
      if (row.admission.status !== "admitted") {
        expect(covered.has(row.id), row.id).toBe(false);
      }
    }
  });

  test("capabilities without a real provider environment stay marked unverified — the marking survives completeness", () => {
    // The families whose proof is structurally local-only name exactly what a provider
    // environment would upgrade; the marking is part of the record, so 22.5's matrix and
    // the readiness conclusion read the SAME unverified list from here.
    const marked = GROUP_RECORDS.filter(
      (record) => record.needsProviderEnvironment,
    );
    expect(marked.map((record) => record.id)).toContain("conformance.realtime");
    expect(marked.map((record) => record.id)).toContain("conformance.video");
    for (const record of marked) {
      for (const need of record.needsProviderEnvironment ?? []) {
        expect(need.length, record.id).toBeGreaterThan(10);
      }
    }
  });
});
