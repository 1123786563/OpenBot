/*
 * The delivery baseline (Bifrost 22.6, #357): the versions this closure batch pins —
 * OpenBot's worktree HEAD plus its uncommitted increment, the bifrost submodule's
 * recorded commit under the zero-commit policy, the migration head — together with the
 * independent-review record, the OCR to-execute checklist and the deployment-readiness
 * conclusions the whole 22.x line hands the coordinator.
 *
 * WHY A MODULE AND NOT A DOCUMENT. The record is checkable: the test below asserts the
 * pins are present and shaped, that the OCR checklist names the workspace-mode command
 * covering the UNCOMMITTED scope (this batch's whole delivery is uncommitted — a
 * BASE..HEAD-only review would see nothing), and that the readiness conclusion lists
 * the unverified capabilities by the same names the conformance store carries. A
 * conclusion a machine cannot check is a claim; this one is pinned to the same tree.
 *
 * THE OCR IS A CHECKLIST BY RULING, NOT AN OMISSION. The repo's process decision
 * (2026-10-20): no intermediate OCR rounds — the final commit gets ONE full-scope run
 * by the coordinator. This batch's delivery is uncommitted, so the checklist's first
 * entry is the workspace-mode command over the entire uncommitted tree, with the
 * committed BASE..HEAD segment named for the day the increment lands on a branch.
 */

/** The pinned versions — the delivery baseline itself. */
export const DELIVERY_BASELINE = {
  openbot: {
    /** The worktree this batch executed in (bf20). */
    worktree: "bf20",
    branch: "1123786563/bf20",
    /** main@HEAD at dispatch — the committed base under the increment. */
    baseCommit: "a789f6a438738cc37927cb978cac5fb343e6a1cc",
    /**
     * The pre-existing uncommitted increment this batch started from (11.x–21.x lines,
     * 0165–0206 + #305 + #312), captured as a git-status snapshot: 276 entries,
     * SHA-256 d2de7240a8ae718fd8ce7de1252182a04752c836577ce611f81ce37c86394e56. This
     * batch's own files are listed in the increment manifest; the snapshot distinguishes
     * them from everything that was already in the tree.
     */
    preexistingIncrement: {
      gitStatusEntries: 276,
      snapshotSha256: "d2de7240a8ae718fd8ce7de1252182a04752c836577ce611f81ce37c86394e56",
    },
    /** The increment manifest (this batch's own files), an untracked reports/ artifact. */
    incrementManifest: "reports/bf20-increment-files.txt",
    /** The last migration this tree carries; 22.x added none (pure modules + evidence). */
    migrationHead: "0206_realtime_session_payer_idx",
    /** Commit policy for this batch: no commit, no push — uncommitted delivery. */
    commitPolicy: "uncommitted-delivery",
  },
  bifrost: {
    /** The recorded submodule commit this batch checked out READ-ONLY for anchor proof. */
    commit: "ad9470a5c59699032716114dfc5c69a925b36b03",
    /** Zero-commit policy: the submodule working tree stays clean; nothing lands there. */
    policy: "zero-commit",
    /** What the checkout was FOR: 22.1's route-table and hook anchors verified in-place. */
    role: "read-only anchor verification (inference.go route table, governance hook surface)",
  },
  tickets: {
    parent: "#5",
    batch: ["#352", "#353", "#354", "#355", "#356", "#357"],
    plan: "docs/plans/2026-10-22-bf20-bifrost-352-357/plan.md",
    report: "reports/orca-dag-wave3-bf20.md",
  },
} as const;

/** One step of the OCR / final-review checklist, with its scope and expectation. */
export type FinalGateChecklistEntry = {
  step: string;
  command: string;
  scope: string;
  expected: string;
};

/**
 * The to-execute checklist the coordinator runs at final commit (the repo ruling: one
 * full-scope OCR, no intermediate rounds). Order matters: the workspace mode covers
 * EVERYTHING uncommitted (this batch + the pre-existing increment it rode on); the
 * BASE..HEAD leg covers the same content once committed; the review legs read what the
 * OCR found, not what exit code it returned.
 */
export const FINAL_GATE_CHECKLIST: readonly FinalGateChecklistEntry[] = [
  {
    step: "workspace-mode OCR over the entire uncommitted delivery",
    command:
      "ocr review --audience agent --background 'Bifrost 严格积分计费 22.x 收口交付（#352-#357）' --workspace --output reports/ocr/bf20-final.md",
    scope:
      "the uncommitted tree — staged + unstaged + untracked across the whole worktree (this batch's files AND the pre-existing 11.x–21.x increment under it)",
    expected:
      "no valid critical/high/medium findings remain; coverage spans every file the increment manifest lists — exit 0 with skipped files is NOT completion",
  },
  {
    step: "committed-range OCR once the increment lands on a branch",
    command:
      "ocr review --audience agent --background 'Bifrost 严格积分计费交付范围' --from a789f6a4 --to <branch-HEAD> --output reports/ocr/bf20-branch.md",
    scope: "BASE a789f6a4..HEAD after the increment is committed",
    expected: "the same findings surface (the range is the same content as the workspace leg)",
  },
  {
    step: "coverage completeness check",
    command: "node scripts/e2e-coverage-audit.mjs && bun run typecheck && bunx biome lint --error-on-warnings .",
    scope: "the full repo state the OCR reviewed",
    expected: "driven-manifest audit clean; typecheck/lint carry only the documented baseline residue",
  },
] as const;

/** The independent review record: what this batch's own review concluded, and what the final independent pass owns. */
export const REVIEW_RECORD = {
  deliveredBy: "bf20 worker (this batch)",
  independentReviewer: {
    scope: "11 source/test files, fresh-context read-only reviewer",
    specCompliance: {
      verdict: "pass-after-fixes",
      summary:
        "initial pass: #357 pass; #352/#353/#355/#356 pass-with-notes; #354 fail-on-evidence-honesty (resultSummaries recorded green for baseline-red suites). Two HIGH findings (fabricated-green summaries; the /v1/realtime/client_secrets provider-call route missing from the catalog) plus 10 medium/low findings — ALL addressed in this tree: truthful per-suite summaries with bound receipts, client_secrets row added (anchor realtime_client_secrets.go:156), invalidation armed via DELIVERED_FINGERPRINTS, audit evidence carries lastRun verdicts, image cancel-tail leg added, vacuous-pass accounting closed, cleanup order fixed, receipts completed, route anchors machine-checked",
    },
    codeQuality: {
      verdict: "pass-with-notes",
      summary:
        "house style respected; suites drive real services where it matters; the noted cleanups (duplicate import, descriptive-door wording, plan/delivery drift) are fixed in this tree",
    },
  },
  specCompliance: {
    verdict: "pass-with-documented-boundaries",
    summary:
      "#352-#356 acceptance criteria each have a matching automated check (enumeration reconciliation incl. anchor line-checks, four-way audit with live drives and honest lastRun bindings, evidence completeness + ARMED invalidation for both groups, matrix executability with absence-is-not-pass accounting); #357's OCR item is the checklist above by the repo's no-intermediate-OCR ruling",
  },
  codeQuality: {
    verdict: "pass",
    summary:
      "pure modules over injected seams in the established billing-module style; no production behavior changed by this batch (catalog/audit/evidence/matrix are new reads); no migration added",
  },
  finalIndependentReview: {
    status: "pending-final-commit",
    owner: "the coordinator's final gate (per the 2026-10-20 ruling, with the one-shot OCR above)",
  },
} as const;

/** The deployment-readiness conclusion: verified, unverified and residual, by name. */
export const READINESS_CONCLUSION = {
  verified: [
    "all-entrance enumeration reconciled against the family registries (22.1)",
    "per-entrance gate/payer/refusal/bypass audit clean, with live drives on the dedicated bf20 PostgreSQL (22.2)",
    "conformance evidence complete and invalidation-machined for 文本/图像/音频 and Embedding/Rerank/OCR/实时/异步/批量/视频/工具 (22.3/22.4)",
    "AC01–AC19 matrix executable with bound receipts (22.5)",
  ],
  unverified: [
    "real-provider conformance for the realtime family (local proofs run both transports against faked upstreams)",
    "real-provider conformance for the video async lifecycle (local proofs drive the 17.2 service with injected dispatch)",
    "real-provider conformance for runtime lanes' governed dials and the image tier pricing's provider-side honoring",
    "end-to-end WebRTC media (no real media devices; relay-layer coverage only)",
  ],
  residualLimitations: [
    "bifrost submodule stays at ad9470a5 with zero commits; the 15.x-17.x Go-side increments live uncommitted in sibling worktrees and are referenced by their own receipts, not re-proven here",
    "known baseline reds in the pre-existing increment are untouched by policy (video_input fixture drift class: image-entrypoints 5 cases, ocr-pricing, rerank-pricing, tool-surcharge-pricing, subscription-harness-boundary under the wrong runner; realtime-session-identity/realtime-unit-reservation suite reds)",
    "server/app typecheck and usage-credits-view lint carry documented baseline residue",
  ],
} as const;
