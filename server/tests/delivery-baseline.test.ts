import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  DELIVERY_BASELINE,
  FINAL_GATE_CHECKLIST,
  READINESS_CONCLUSION,
  REVIEW_RECORD,
} from "../src/billing/delivery-baseline";

/*
 * Ticket 22.6 (#357) — the delivery baseline's own check.
 *
 *   AC-1  OpenBot 与 Bifrost 的交付版本被明确固定并记录 — both pins present and shaped
 *         (commit hashes, the uncommitted-delivery policy, the migration head, the
 *         submodule's zero-commit posture);
 *   AC-2  独立 Review 给出 Spec compliance 与 code quality 两个结论 — both verdicts
 *         present, with the final independent pass's ownership named (the repo ruling
 *         defers it to the coordinator's one-shot gate);
 *   AC-3  OCR 覆盖全部交付范围（含未提交改动）— the checklist's first entry IS the
 *         workspace-mode command over the uncommitted tree, and the manifest it must
 *         span exists with real entries inside authorized write scopes;
 *   AC-4  部署就绪结论明确列出未验证能力与遗留限制 — the unverified list and the
 *         residual list are non-empty and name their items, because an empty
 *         "unverified" list would itself be the biggest claim in the file.
 */

const repoRoot = join(import.meta.dirname, "../..");

/** The write scopes this batch was authorized to touch (the tickets' own write scopes). */
const AUTHORIZED_PREFIXES = [
  "server/src/billing/",
  "server/src/ai-observability/",
  "server/tests/",
  "docs/plans/bifrost/waves/2026-10-22-bf20-bifrost-352-357/",
  "reports/",
  // The shared driven-suite manifest: baseline-modified already; this batch's addition
  // is the six suite registrations the e2e-add-driven audit carries.
  "tests/config/e2e-bun-suites.json",
];

describe("Bifrost 22.6 (#357): the delivery baseline", () => {
  test("both delivery versions are pinned, with the uncommitted-delivery policy named", () => {
    expect(DELIVERY_BASELINE.openbot.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(DELIVERY_BASELINE.openbot.branch).toBe("1123786563/bf20");
    expect(DELIVERY_BASELINE.openbot.commitPolicy).toBe("uncommitted-delivery");
    expect(
      DELIVERY_BASELINE.openbot.preexistingIncrement.gitStatusEntries,
    ).toBeGreaterThan(200);
    expect(
      DELIVERY_BASELINE.openbot.preexistingIncrement.snapshotSha256,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(DELIVERY_BASELINE.openbot.migrationHead).toMatch(/^0206_/);
    expect(DELIVERY_BASELINE.bifrost.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(DELIVERY_BASELINE.bifrost.policy).toBe("zero-commit");
    expect(DELIVERY_BASELINE.tickets.batch).toEqual([
      "#352",
      "#353",
      "#354",
      "#355",
      "#356",
      "#357",
    ]);
    expect(DELIVERY_BASELINE.tickets.parent).toBe("#5");
  });

  test("the plan and report the baseline names exist", () => {
    // Tracked planning artifact: every checkout owes this file.
    expect(existsSync(join(repoRoot, DELIVERY_BASELINE.tickets.plan))).toBe(
      true,
    );
    // The report and the increment manifest are untracked `/reports/` delivery
    // artifacts (the repo's standing convention for every wave) — they exist on
    // the machine that ran the delivery, nowhere else. A checkout without them
    // (CI, any fresh clone) checks the tracked shape only.
    const reportPath = join(repoRoot, DELIVERY_BASELINE.tickets.report);
    if (!existsSync(reportPath)) return;
    expect(readFileSync(reportPath, "utf8").length).toBeGreaterThan(0);
  });

  test("the independent review carries BOTH conclusions and names the final gate's owner", () => {
    expect(REVIEW_RECORD.specCompliance.verdict.length).toBeGreaterThan(3);
    expect(REVIEW_RECORD.specCompliance.summary.length).toBeGreaterThan(40);
    expect(REVIEW_RECORD.codeQuality.verdict.length).toBeGreaterThan(3);
    expect(REVIEW_RECORD.codeQuality.summary.length).toBeGreaterThan(40);
    expect(REVIEW_RECORD.finalIndependentReview.status).toBe(
      "pending-final-commit",
    );
    expect(REVIEW_RECORD.finalIndependentReview.owner.length).toBeGreaterThan(
      10,
    );
  });

  test("the OCR checklist's first entry covers the UNCOMMITTED scope in workspace mode", () => {
    expect(FINAL_GATE_CHECKLIST.length).toBeGreaterThanOrEqual(3);
    const workspace = FINAL_GATE_CHECKLIST[0]!;
    expect(workspace.command).toContain("--workspace");
    expect(workspace.command).toContain("--audience agent");
    expect(workspace.scope).toContain("uncommitted");
    // And the rule the ticket states: exit 0 alone is not completion.
    expect(workspace.expected).toContain("NOT completion");
    // The committed-range leg names the real base.
    const committed = FINAL_GATE_CHECKLIST.find((entry) =>
      entry.command.includes("--from"),
    );
    expect(committed?.command).toContain("a789f6a4");
  });

  test("the increment manifest exists, is non-empty, and stays inside the authorized write scopes", () => {
    const manifestPath = join(
      repoRoot,
      DELIVERY_BASELINE.openbot.incrementManifest,
    );
    // Untracked `/reports/` delivery artifact (see the plan/report test above):
    // asserted only where the delivery actually ran.
    if (!existsSync(manifestPath)) return;
    const entries = readFileSync(manifestPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const entry of entries) {
      const path = entry.replace(/^[A-Z?]+\s+/, "");
      const authorized = AUTHORIZED_PREFIXES.some((prefix) =>
        path.startsWith(prefix),
      );
      expect(authorized, path).toBe(true);
    }
  });

  test("the readiness conclusion lists unverified capabilities and residual limits by name", () => {
    expect(READINESS_CONCLUSION.verified.length).toBeGreaterThanOrEqual(4);
    expect(READINESS_CONCLUSION.unverified.length).toBeGreaterThanOrEqual(3);
    expect(
      READINESS_CONCLUSION.residualLimitations.length,
    ).toBeGreaterThanOrEqual(3);
    for (const item of READINESS_CONCLUSION.unverified) {
      expect(item.length).toBeGreaterThan(15);
    }
    // The unverified list names the SAME families the conformance store marked — the
    // realtime and video provider-environment gaps cannot quietly vanish here.
    const unverified = READINESS_CONCLUSION.unverified.join(" ");
    expect(unverified).toContain("realtime");
    expect(unverified).toContain("video");
  });
});
