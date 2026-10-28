import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  CONFORMANCE_GROUP_22_3,
  CONFORMANCE_GROUP_22_4,
  MODEL_ENTRYPOINTS,
  auditedEntrypoints,
  reconcileEntrypointCatalog,
  registryEntrypointIdentities,
  type ModelEntrypoint,
} from "../src/billing/entrypoint-catalog";
import { IMAGE_ENTRYPOINTS } from "../src/billing/image-entrypoints";
import { AUDIO_CAPABILITY_EVIDENCE } from "../src/billing/audio-capability-evidence";
import { TOOL_SURCHARGE_ENTRIES } from "../src/billing/tool-surcharge-pricing";

/*
 * Ticket 22.1 (#352) — the all-entrance enumeration's own check.
 *
 * THE CATALOG IS THE RECONCILIATION, AND THE RECONCILIATION RUNS HERE. The family
 * registries 12.4/14.3/20.x delivered are machine-enumerable; this file pins that the
 * catalog carries exactly their rows (both directions), that every row's admission seam
 * exists in this repository as code, and that the audio translations entrance — the one
 * live unwired path — is BLOCKED with its reasons, not silently absent (未接入准入的
 * 入口被列为阻塞项，不放行).
 *
 * THE FAILURE MODE IS THE TEST'S OWN CASE. Feeding the reconciliation a hypothetical
 * catalog that lacks an image row (what "someone added an entrance and did not register
 * it" looks like from the registry side) must report it unregistered — 新增入口未登记
 * 到清单时自动化检查失败, demonstrated on the machinery itself rather than asserted in
 * prose. The same run pins the stale direction: a catalog row whose registry row is gone
 * is reported stale, because an annotation that outlived its entrance lies the other way.
 */

const repoRoot = join(import.meta.dirname, "../..");

/** The real repository's file existence — the seam evidence check runs against actual code. */
const fileExists = (modulePath: string) =>
  existsSync(join(repoRoot, modulePath));

describe("Bifrost 22.1 (#352): the all-entrance enumeration", () => {
  test("the catalog reconciles against every machine-enumerable family registry, both directions", () => {
    const result = reconcileEntrypointCatalog(fileExists);
    // Empty on every field IS the enumeration's consistency; a non-empty field names the
    // exact row that broke it.
    expect(result.unregistered).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.seamMissing).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });

  test("every admission seam exists as code in this repository", async () => {
    const seams = new Map(
      MODEL_ENTRYPOINTS.map((row) => [
        row.admissionSeam.module,
        row.admissionSeam.door,
      ]),
    );
    expect(seams.size).toBeGreaterThan(10);
    for (const [modulePath, door] of seams) {
      expect(fileExists(modulePath), modulePath).toBe(true);
      // A door that is a bare identifier must be the module's own export — the door is
      // named, not narrated. Composition seams (index.ts's runner wiring, copilot's
      // collaborator) carry descriptive doors; their anchor names the symbol instead.
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(door)) {
        const mod = (await import(
          `../${modulePath.replace(/^server\/src\//, "src/")}`
        )) as Record<string, unknown>;
        expect(typeof mod[door], `${modulePath}#${door}`).toBe("function");
      }
    }
  });

  test("the image rows are exactly 12.4's registry, the audio rows exactly 14.3's, the tool rows exactly 20.x's", () => {
    const ids = new Set(MODEL_ENTRYPOINTS.map((row) => row.id));
    const registries = registryEntrypointIdentities();
    for (const id of [
      ...registries.image,
      ...registries.audio,
      ...registries.tool,
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    // And the counts: no family carries rows the registry does not (the reconcile test
    // above already proves the reverse direction; this pins the shape plainly).
    expect(
      MODEL_ENTRYPOINTS.filter((row) => row.family === "image"),
    ).toHaveLength(IMAGE_ENTRYPOINTS.length);
    expect(
      MODEL_ENTRYPOINTS.filter((row) => row.family === "audio"),
    ).toHaveLength(AUDIO_CAPABILITY_EVIDENCE.length);
    expect(
      MODEL_ENTRYPOINTS.filter((row) => row.family === "tool"),
    ).toHaveLength(TOOL_SURCHARGE_ENTRIES.length);
  });

  test("every row states its admission verdict and its payer source", () => {
    for (const row of MODEL_ENTRYPOINTS) {
      expect(["admitted", "blocked", "absent"]).toContain(row.admission.status);
      expect([
        "grant-resolution",
        "workbench-company",
        "deployment-selection",
      ]).toContain(row.payerSource);
      if (row.admission.status === "admitted") {
        expect(
          row.admission.stagesBeforeDispatch.length,
          row.id,
        ).toBeGreaterThan(0);
      }
      if (row.admission.status === "blocked") {
        // A blocked row is a finding: it names its reasons and the ticket that owns the
        // unblocking — 22.2/22.5 read these as the不放行 list.
        expect(row.admission.blockingReasons.length, row.id).toBeGreaterThan(0);
        expect(row.admission.ownerTicket, row.id).toMatch(/^#/);
      }
    }
  });

  test("the audio translations entrance is blocked, not silently dropped — and it is the only blocked row", () => {
    const blocked = MODEL_ENTRYPOINTS.filter(
      (row) => row.admission.status === "blocked",
    );
    // Exactly the one live unwired path today: a real wire route the gateway carries as a
    // passthrough billing reference with no meter and no admission wiring (14.3/14.4).
    expect(blocked.map((row) => row.id)).toEqual(["audio.translation"]);
    const row = blocked[0] as ModelEntrypoint;
    if (row.admission.status !== "blocked") return;
    expect(row.admission.blockingReasons.join(" ")).toContain(
      "no_input_meter_wired",
    );
    expect(row.admission.blockingReasons.join(" ")).toContain(
      "no_admission_wiring",
    );
    expect(row.admission.ownerTicket).toContain("#313");
  });

  test("an entrance the registry gains but the catalog does not register fails the check", () => {
    // The hypothetical someone-wired-a-new-entrance world: the image registry's row is
    // there (the registry is the machine side), the catalog is missing it. The
    // reconciliation must name it unregistered — this is the AC's own failure sentence,
    // proven on the machinery that the run above pins to the real catalog.
    const missingOne = MODEL_ENTRYPOINTS.filter(
      (row) => row.id !== "image.generation",
    );
    const result = reconcileEntrypointCatalog(fileExists, missingOne);
    expect(result.unregistered).toEqual(["image.generation"]);
    expect(result.stale).toEqual([]);
  });

  test("a catalog row whose registry row is gone is reported stale", () => {
    const extraRow: ModelEntrypoint = {
      id: "image.upscale",
      family: "image",
      surface: "a hypothetical upscale path",
      sourceAnchor: "hypothetical",
      admissionSeam: {
        module: "server/src/billing/image-entrypoints.ts",
        door: "admitImageEntrypoint",
      },
      payerSource: "grant-resolution",
      admission: { status: "admitted", stagesBeforeDispatch: ["entry"] },
    };
    const result = reconcileEntrypointCatalog(fileExists, [
      ...MODEL_ENTRYPOINTS,
      extraRow,
    ]);
    expect(result.unregistered).toEqual([]);
    expect(result.stale).toEqual(["image.upscale"]);
  });

  test("a seam module that moved off disk breaks the check", () => {
    const never = () => false;
    const result = reconcileEntrypointCatalog(never);
    expect(result.seamMissing.length).toBe(MODEL_ENTRYPOINTS.length);
  });

  test("the seven-family conformance split covers every family exactly once", () => {
    const families = new Set(MODEL_ENTRYPOINTS.map((row) => row.family));
    for (const family of families) {
      const in223 = CONFORMANCE_GROUP_22_3.includes(family);
      const in224 = CONFORMANCE_GROUP_22_4.includes(family);
      expect(in223 !== in224, family).toBe(true);
    }
    // The split the closure tickets name: 文本/图像/音频 on one side; Embedding/实时/
    // 异步/工具 (with Rerank/OCR/evaluation/harness) on the other.
    expect([...CONFORMANCE_GROUP_22_3]).toEqual([
      "text",
      "image",
      "audio",
      "runtime",
    ]);
    expect(CONFORMANCE_GROUP_22_4).toContain("realtime");
    expect(CONFORMANCE_GROUP_22_4).toContain("tool");
    expect(CONFORMANCE_GROUP_22_4).toContain("embedding");
  });

  test("the audited set is every admitted and blocked row — absences are answers, not audit subjects", () => {
    const audited = new Set(auditedEntrypoints().map((row) => row.id));
    for (const row of MODEL_ENTRYPOINTS) {
      if (row.admission.status === "absent") {
        expect(audited.has(row.id), row.id).toBe(false);
      } else {
        expect(audited.has(row.id), row.id).toBe(true);
      }
    }
  });

  test("every bifrost file:line anchor names a real line — and route anchors name the line that serves the route", () => {
    // The anchors are the enumeration's code evidence; this check keeps them from
    // drifting silently. A `bifrost/<path>:<line>` reference must land in a file that
    // exists (the submodule is checked out at the recorded commit), and when the anchor
    // names a wire route ("/v1/…"), the pinned line must be the registration that
    // serves it — the load-bearing half, checked mechanically.
    const anchorPattern = /(bifrost\/[A-Za-z0-9_./-]+\.go):(\d+)/g;
    let checked = 0;
    for (const row of MODEL_ENTRYPOINTS) {
      for (const match of row.sourceAnchor.matchAll(anchorPattern)) {
        const filePath = join(repoRoot, match[1]);
        const line = Number(match[2]);
        expect(existsSync(filePath), `${row.id}: ${match[1]}`).toBe(true);
        const lines = readFileSync(filePath, "utf8").split("\n");
        const at = lines[line - 1] ?? "";
        expect(at.trim().length, `${row.id}: ${match[0]}`).toBeGreaterThan(0);
        const namesRegistration =
          row.sourceAnchor.includes("r.POST") ||
          row.sourceAnchor.includes("r.GET");
        const route = row.sourceAnchor.match(/\/v1\/[A-Za-z0-9_/{}.-]+/);
        if (namesRegistration && route) {
          expect(at, `${row.id}: ${match[0]}`).toContain(route[0]);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });
});
