import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The R4 artifact contract, asserted against the committed artifacts
 * themselves (01 plan R4 + master plan §6):
 *
 *   - runtime-go/testdata/compatibility-report.json must register every gate
 *     with the four-state vocabulary (not_run/passed/failed/blocked) plus
 *     evidence refs — never a single adoption boolean;
 *   - it must carry the R4 report fields (commit, workspace_digest,
 *     document_baseline, go_version, dependency_graph_digest, sdk_versions,
 *     environment, commands, exit_codes, evidence_refs, limitations);
 *   - its checks must cover the nine R4 categories, each with an honest
 *     passed/failed/not_run status;
 *   - runtime-go/dependency-review.json must describe the CURRENT dependency
 *     graph (R4-B: a risk record for a graph that no longer exists is not a
 *     record), anchored by digests of the real go.mod/go.sum on disk.
 *
 * These assertions are deliberately anchored to files on disk, not to
 * constants: if the frozen graph moves, the artifacts go stale and these
 * tests fail until the probe/scan re-runs — which is exactly the discipline
 * R4-B demands ("上游API路径/依赖变动时先适配契约再验收，不复制过期测试成功记录").
 */

const repoRoot = join(import.meta.dir, "../../..");
const runtimeGoDir = join(repoRoot, "runtime-go");
const reportPath = join(runtimeGoDir, "testdata", "compatibility-report.json");
const dependencyReviewPath = join(runtimeGoDir, "dependency-review.json");

const sha256Of = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const sha256Hex = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

const lineCount = (path: string): number =>
  readFileSync(path, "utf8").trim().split("\n").length;

/** Every direct (non-indirect) require in runtime-go/go.mod, as `path -> version`. */
function directGoDependencies(): Record<string, string> {
  const goMod = readFileSync(join(runtimeGoDir, "go.mod"), "utf8");
  const deps: Record<string, string> = {};
  for (const match of goMod.matchAll(/^\t(\S+)\s+(v\S+)$/gm)) {
    deps[match[1]] = match[2];
  }
  return deps;
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const dependencyReview = JSON.parse(readFileSync(dependencyReviewPath, "utf8"));

/** The nine check categories the 01 plan R4 contract names, in plan order. */
const R4_CHECKS = [
  "identity",
  "trusted_input",
  "text",
  "tool",
  "wait",
  "error",
  "cancel",
  "backpressure",
  "restart",
] as const;

const R4_GATES = ["G1a", "G1b", "G2"] as const;

const R4_FIELDS = [
  "commit",
  "workspace_digest",
  "document_baseline",
  "go_version",
  "dependency_graph_digest",
  "sdk_versions",
  "environment",
  "commands",
  "exit_codes",
  "evidence_refs",
  "limitations",
] as const;

describe("the compatibility report obeys the R4 report contract", () => {
  test("carries every R4 field plus checks, gates and measurements", () => {
    for (const field of R4_FIELDS) {
      expect(report, `missing R4 field: ${field}`).toHaveProperty(field);
    }
    expect(report).toHaveProperty("checks");
    expect(report).toHaveProperty("gates");
    expect(report).toHaveProperty("measurements");
  });

  test("never uses the forbidden adoption conclusion", () => {
    // Master plan §6: 候选报告使用每门禁 not_run/passed/failed/blocked 与
    // 证据引用，不使用一个含糊的 adoption 布尔值替代。
    expect(Object.keys(report)).not.toContain("adoption");
  });

  test("records the commit it was generated at", () => {
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("covers the nine R4 check categories with honest statuses and evidence", () => {
    expect(Object.keys(report.checks).sort()).toEqual([...R4_CHECKS].sort());
    for (const name of R4_CHECKS) {
      const check = report.checks[name];
      expect(["passed", "failed", "not_run"], `${name}.status`).toContain(
        check.status,
      );
      expect(check.evidence.length, `${name}.evidence`).toBeGreaterThan(0);
    }
  });

  test("registers every gate in the four-state vocabulary with evidence", () => {
    expect(Object.keys(report.gates).sort()).toEqual([...R4_GATES].sort());
    for (const gate of R4_GATES) {
      expect(
        ["not_run", "passed", "failed", "blocked"],
        `${gate}.status`,
      ).toContain(report.gates[gate].status);
      expect(report.gates[gate].evidence.length, `${gate}.evidence`).toBeGreaterThan(0);
      for (const ref of report.gates[gate].evidence) {
        expect(ref.length, `${gate}.evidence entries`).toBeGreaterThan(0);
      }
    }
  });

  test("does not auto-pass G1b/G2 (01 plan: G1b/G2本册不自动填写passed)", () => {
    expect(report.gates.G1b.status).not.toBe("passed");
    expect(report.gates.G2.status).not.toBe("passed");
  });

  test("derives G1a honestly from the check outcomes", () => {
    const statuses = R4_CHECKS.map((name) => report.checks[name].status);
    if (report.gates.G1a.status === "passed") {
      // A gate may only pass when every check behind it actually ran and passed
      // (master §6: 所有项只有实际执行后才填pass/fail).
      expect(statuses).not.toContain("not_run");
      expect(statuses).not.toContain("failed");
    }
    if (statuses.includes("failed")) {
      expect(report.gates.G1a.status).toBe("failed");
    } else if (statuses.includes("not_run")) {
      expect(["blocked", "failed"]).toContain(report.gates.G1a.status);
    }
  });

  test("describes the dependency graph that is actually on disk", () => {
    const digest = report.dependency_graph_digest;
    expect(digest.goSumSha256).toBe(sha256Of(join(runtimeGoDir, "go.sum")));
    expect(sha256Hex(digest.goSumSha256)).toBe(true);
    expect(digest.goSumLines).toBe(lineCount(join(runtimeGoDir, "go.sum")));
    expect(digest.goModSha256).toBe(sha256Of(join(runtimeGoDir, "go.mod")));
    expect(digest.moduleCount).toBe(report.modules.length);
  });

  test("records the locked SDK versions, including every direct Go dependency", () => {
    const direct = directGoDependencies();
    for (const [path, version] of Object.entries(direct)) {
      expect(report.sdk_versions[path], `sdk_versions[${path}]`).toBe(version);
    }
    const serverPackage = JSON.parse(
      readFileSync(join(repoRoot, "server", "package.json"), "utf8"),
    );
    expect(report.sdk_versions["@ag-ui/client"]).toBe(
      serverPackage.dependencies["@ag-ui/client"],
    );
  });

  test("baselines the governing documents it answers to", () => {
    const plans = [
      "docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md",
      "docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md",
    ];
    for (const plan of plans) {
      expect(report.document_baseline[plan], `document_baseline[${plan}]`).toBe(
        sha256Of(join(repoRoot, plan)),
      );
    }
  });

  test("records the commands it ran and the exit code it exited with", () => {
    expect(report.exit_codes.probe).toBe(0);
    expect(report.commands.length).toBeGreaterThan(0);
    for (const command of report.commands) {
      expect(Array.isArray(command.argv)).toBe(true);
      expect(Number.isInteger(command.exitCode), "exitCode").toBe(true);
      expect(command.purpose.length).toBeGreaterThan(0);
    }
  });

  test("points its evidence at the risk record the G1b gate must close", () => {
    expect(report.evidence_refs.join("\n")).toContain(
      "runtime-go/dependency-review.json",
    );
  });

  test("states its limitations instead of hiding them", () => {
    expect(report.limitations.length).toBeGreaterThan(0);
    for (const limitation of report.limitations) {
      expect(limitation.length).toBeGreaterThan(0);
    }
  });
});

describe("the dependency risk record describes the current graph (R4-B)", () => {
  test("anchors itself to the go.mod/go.sum that are actually on disk", () => {
    const graph = dependencyReview.graph;
    expect(graph.goSum.sha256).toBe(sha256Of(join(runtimeGoDir, "go.sum")));
    expect(graph.goSum.lines).toBe(lineCount(join(runtimeGoDir, "go.sum")));
    expect(graph.goSum.sha256First16).toBe(graph.goSum.sha256.slice(0, 16));
    expect(graph.goSum.modVerifyOutput).toBe("all modules verified");
    expect(graph.goMod.sha256).toBe(sha256Of(join(runtimeGoDir, "go.mod")));
  });

  test("records every direct dependency the module actually requires", () => {
    const direct = directGoDependencies();
    for (const [path, version] of Object.entries(direct)) {
      expect(
        graph_direct(dependencyReview)[path],
        `resolvedDirectDependencies[${path}]`,
      ).toBe(version);
    }
  });

  test("counts the module list the graph actually resolves to", () => {
    expect(dependencyReview.graph.goListAll.moduleCount).toBe(
      report.modules.length,
    );
  });

  test("records a vulnerability scan OF THIS graph, not a stale one", () => {
    const scan = dependencyReview.vulnerabilityScan;
    expect(scan.scannedGoSumSha256).toBe(
      sha256Of(join(runtimeGoDir, "go.sum")),
    );
    expect(Number.isInteger(scan.exitCode), "exitCode").toBe(true);
    expect(scan.summary.length).toBeGreaterThan(0);
    expect(scan.reachableFindings.length).toBeGreaterThan(0);
    expect(scan.disposition.length).toBeGreaterThan(0);
    expect(scan.securitySignOff.status.length).toBeGreaterThan(0);
    expect(scan.securitySignOff.requiredBy.length).toBeGreaterThan(0);
  });
});

function graph_direct(review: {
  graph: { resolvedDirectDependencies: Record<string, string> };
}): Record<string, string> {
  return review.graph.resolvedDirectDependencies;
}
