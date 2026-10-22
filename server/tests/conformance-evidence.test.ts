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
  sha256OfContent,
  staleEvidence,
  type ConformanceRecord,
} from "../src/billing/conformance-evidence";
import {
  CONFORMANCE_GROUP_22_3,
  MODEL_ENTRYPOINTS,
} from "../src/billing/entrypoint-catalog";

/*
 * Ticket 22.3 (#354) — conformance evidence for the 文本/图像/音频 families (and the
 * runtime lanes that dial the text funnel).
 *
 *   AC-1  三族中每个启用的能力都有绑定版本的 conformance 证据 — every admitted catalog
 *         row of the 22.3 families is covered by a record carrying constraints, a
 *         verification environment, re-runnable commands and a version binding;
 *   AC-2  证据包含验证环境与实际结果，可复现 — every command's suite file exists in
 *         this repository, and every constraint carries the FACT it pinned, not a promise;
 *   AC-3  配置或版本变更后受影响证据失效 — the fingerprint machinery marks a record
 *         stale the moment any bound module's content changes;
 *   AC-4  缺真实供应商环境的能力标记为未验证/不可启用 — what only a real provider can
 *         prove is NAMED in needsProviderEnvironment, and a capability without (fresh)
 *         evidence is out of the enableable projection — never silently enabled.
 */

const repoRoot = join(import.meta.dirname, "../..");

const readRepoFile = (modulePath: string) => readFileSync(join(repoRoot, modulePath), "utf8");
const repoFileExists = (modulePath: string) => existsSync(join(repoRoot, modulePath));

const GROUP_RECORDS = CONFORMANCE_EVIDENCE.filter((record) => record.group === "22.3");
const GROUP_FAMILIES = ["text", "image", "audio", "runtime"];

describe("Bifrost 22.3 (#354): conformance evidence — 文本/图像/音频", () => {
  test("every admitted 22.3-family entrance is covered by a record — 启用能力都有证据", () => {
    // The whole-catalog check (both groups) is the store's real contract; this file's
    // focus asserts its group's slice and lets 22.4's file do the same for its own.
    expect(admittedEntrypointsWithoutEvidence()).toEqual([]);
    const admitted223 = MODEL_ENTRYPOINTS.filter(
      (row) =>
        row.admission.status === "admitted" && CONFORMANCE_GROUP_22_3.includes(row.family),
    );
    expect(admitted223.length).toBeGreaterThanOrEqual(15);
    const covered = new Set(
      GROUP_RECORDS.flatMap((record) => record.entrypointIds),
    );
    for (const row of admitted223) {
      expect(covered.has(row.id), row.id).toBe(true);
    }
    // The blocked translation row is NOT covered evidence-wise — it is not enabled.
    expect(covered.has("audio.translation")).toBe(false);
  });

  test("every record carries constraints, environment, re-runnable commands and a version binding", () => {
    for (const record of GROUP_RECORDS) {
      expect(record.constraints.length, record.id).toBeGreaterThan(0);
      expect(["local-deterministic", "provider-real"]).toContain(record.verification.environment);
      expect(record.verification.commands.length, record.id).toBeGreaterThan(0);
      expect(record.verification.resultSummary.length, record.id).toBeGreaterThan(0);
      expect(record.versionBinding.length, record.id).toBeGreaterThan(0);
      for (const constraint of record.constraints) {
        expect(constraint.fact.claim.length, record.id).toBeGreaterThan(0);
        // The fact's result is the evidence: a sentence with substance, not an exit code.
        expect(constraint.fact.result.length, record.id).toBeGreaterThan(20);
      }
    }
  });

  test("every command's suite file exists in this repository — the evidence is reproducible", () => {
    for (const record of GROUP_RECORDS) {
      for (const command of record.verification.commands) {
        const match = command.match(/(server\/tests\/[A-Za-z0-9_./-]+\.test\.ts[ex]*)/);
        expect(match, `${record.id}: ${command}`).not.toBeNull();
        if (!match) continue;
        expect(existsSync(join(repoRoot, match[1])), match[1]).toBe(true);
      }
    }
  });

  test("every version-bound module exists on disk — the binding binds real code", () => {
    for (const record of GROUP_RECORDS) {
      for (const modulePath of record.versionBinding) {
        expect(repoFileExists(modulePath), `${record.id}: ${modulePath}`).toBe(true);
      }
    }
  });

  test("fingerprints are stable for the same content and change with the content", () => {
    const record = GROUP_RECORDS[0] as ConformanceRecord;
    const once = evidenceFingerprint(record, readRepoFile);
    const again = evidenceFingerprint(record, readRepoFile);
    expect(once).toBe(again);
    // A single character in ONE bound module changes the fingerprint.
    const tampered = (modulePath: string) =>
      modulePath === record.versionBinding[0]
        ? `${readRepoFile(modulePath)}\n`
        : readRepoFile(modulePath);
    expect(evidenceFingerprint(record, tampered)).not.toBe(once);
    // And the atom itself is the content's own hash.
    expect(sha256OfContent("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("the delivered fingerprints match the shipped tree — the invalidation rule is ARMED, not illustrative", () => {
    // DELIVERED_FINGERPRINTS is what this delivery recorded over the exact module
    // contents it shipped. Asserting staleness EMPTY binds the evidence to the code:
    // edit any bound module afterwards and THIS test fails with the record named stale,
    // until the evidence is re-verified and the fingerprint re-recorded.
    expect(staleEvidence(DELIVERED_FINGERPRINTS, readRepoFile, repoFileExists)).toEqual([]);
    // Every record has a delivered fingerprint — none silently skipped.
    for (const record of CONFORMANCE_EVIDENCE) {
      expect(DELIVERED_FINGERPRINTS[record.id], record.id).toBeDefined();
    }
  });

  test("a changed bound module marks its record stale — 配置或版本变更后证据失效", () => {
    // The fingerprints a verification run would record, from the real files.
    const fingerprints = Object.fromEntries(
      CONFORMANCE_EVIDENCE.map((record) => [
        record.id,
        evidenceFingerprint(record, readRepoFile),
      ]),
    );
    // Nothing changed: nothing is stale.
    expect(staleEvidence(fingerprints, readRepoFile, repoFileExists)).toEqual([]);

    // One module changed (the pricing table edited, the stage reordered): every record
    // bound to it goes stale, by name, with its reason.
    const changed = (modulePath: string) =>
      modulePath.endsWith("image-generation-pricing.ts")
        ? `${readRepoFile(modulePath)}// edited\n`
        : readRepoFile(modulePath);
    const stale = staleEvidence(fingerprints, changed, repoFileExists);
    expect(stale.map((entry) => entry.id)).toEqual(["conformance.image"]);
    expect(stale[0]?.reason).toBe("fingerprint-mismatch");

    // A bound module that vanished is stale the loudest way.
    const vanishedExists = (modulePath: string) =>
      !modulePath.endsWith("speech-settlement.ts") && repoFileExists(modulePath);
    const vanishedStale = staleEvidence(fingerprints, readRepoFile, vanishedExists);
    expect(vanishedStale.map((entry) => entry.id)).toContain("conformance.audio");
    expect(
      vanishedStale.find((entry) => entry.id === "conformance.audio")?.reason,
    ).toBe("bound-file-missing");
  });

  test("an admitted capability without evidence stays out of the enableable projection", () => {
    // The honest world: every admitted row is enableable with its family's fresh record.
    const enableable = enableableWithEvidence({});
    const admitted = MODEL_ENTRYPOINTS.filter((row) => row.admission.status === "admitted");
    expect(enableable).toEqual(admitted.map((row) => row.id));

    // The regression world: someone wires a new entrance (a fresh admitted row) and no
    // record covers it — 启用但缺证据的能力被标记不可用.
    const newEntrance = {
      ...admitted[0]!,
      id: "image.upscale",
    };
    const uncovered = admittedEntrypointsWithoutEvidence(undefined, [
      ...MODEL_ENTRYPOINTS,
      newEntrance,
    ]);
    expect(uncovered).toEqual(["image.upscale"]);
    const stillEnableable = enableableWithEvidence({
      catalog: [...MODEL_ENTRYPOINTS, newEntrance],
    });
    expect(stillEnableable).not.toContain("image.upscale");
  });

  test("a stale record's family drops out of the enableable projection until re-verified", () => {
    const enableable = enableableWithEvidence({
      stale: new Set(["conformance.image"]),
    });
    expect(enableable).not.toContain("image.generation");
    expect(enableable).toContain("text.chat.completions");
  });

  test("what only a real provider can prove is named — no local run is dressed as a provider one", () => {
    // Today every record is locally verified; the honest marking is that the provider-
    // dependent upgrades are LISTED, not claimed.
    for (const record of GROUP_RECORDS) {
      if (record.verification.environment === "local-deterministic") {
        // A record that needs a provider environment names exactly what it needs.
        if (record.needsProviderEnvironment) {
          expect(record.needsProviderEnvironment.length, record.id).toBeGreaterThan(0);
        }
      } else {
        expect(record.needsProviderEnvironment, record.id).toBeUndefined();
      }
    }
    const withProviderNeeds = GROUP_RECORDS.filter((r) => r.needsProviderEnvironment);
    expect(withProviderNeeds.length).toBeGreaterThan(0);
  });

  test("the group assignment agrees with the catalog's own split", () => {
    for (const record of CONFORMANCE_EVIDENCE) {
      expect(record.group).toBe(conformanceGroupOf(record.family));
    }
    expect(GROUP_FAMILIES).toEqual([...CONFORMANCE_GROUP_22_3]);
  });
});
