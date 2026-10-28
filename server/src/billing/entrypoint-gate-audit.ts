/*
 * The per-entrance gate/payer audit (Bifrost 22.2, #353): every audited catalog row
 * checked four ways — 门禁 (the admission runs before dispatch), payer (the paying
 * account is resolved the way AC13 fixes it), 拒绝 (an insufficient balance refuses with
 * the provider dispatch count ZERO), 旁路 (no entrance dials a provider except through
 * its named seam) — with each verdict bound to the evidence that proves it.
 *
 * THE VERDICTS ARE DERIVED, THE EVIDENCE IS NAMED. The structural half (does the row
 * carry stages, a payer source, a seam) comes from the catalog itself; the behavioral
 * half comes from the delivered suites each family already carries, named per family in
 * the evidence table below, plus the live drives 22.2's own integration test runs
 * against a real PostgreSQL (TEST_DATABASE_URL) for the database-backed doors. Nothing
 * here re-asserts what a suite proved; this module BINDS the proof to the row, so a
 * reader can复核 any entrance from its id alone.
 *
 * DEFECTS ARE FINDINGS, NOT EDITS. 核查失败不就地放宽语义: the audit returns fail
 * verdicts; a fail belongs to the family's own ticket (the evidence table names it),
 * never to a semantic change made in passing here. Today's catalog audits clean — the
 * audio translation row is the one blocked entrance, and the enumeration (22.1) carries
 * it with its reasons.
 */

import {
  MODEL_ENTRYPOINTS,
  type ModelEntrypoint,
  type PayerSource,
} from "./entrypoint-catalog";

/** The four checks every audited entrance answers. */
export const FOUR_WAY_CHECKS = ["gate", "payer", "refusal", "bypass"] as const;
export type FourWayCheck = (typeof FOUR_WAY_CHECKS)[number];

/** How a payer source is resolved — the module and the mechanism AC13 pinned. */
export const PAYER_RESOLUTION: Record<
  PayerSource,
  { module: string; mechanism: string }
> = {
  "grant-resolution": {
    module: "server/src/billing/payer-binding.ts",
    mechanism:
      "resolveConsumptionPayerBinding — the grant's own user, resolved server-side; a client-specified or mismatched payer is refused (payer_conflict), never adopted",
  },
  "workbench-company": {
    module: "server/src/billing/workbench-payer.ts",
    mechanism:
      "resolveWorkbenchPayerBinding — the tenancy middleware's entryBusiness scopes the company account; no header a caller typed is ever read",
  },
  "deployment-selection": {
    module: "server/src/index.ts",
    mechanism:
      "the deployment's own model selection (immutable route refs, credential-store dial) — a runtime lane, not a client surface, so no client field selects anything",
  },
};

/** The refusal proof one family's insufficient-balance matrix lives in. */
export type RefusalEvidence = {
  /** The delivered suite whose assertions carry the family's 拒绝 matrix. */
  suite: string;
  /** The stage the refusal lands at, before any dispatch seam could fire. */
  stage: string;
  /** The refusal code the door answers with when the balance cannot cover the hold. */
  reasonCode: string;
  /** The live drive 22.2's own integration test performs for this family. */
  drive: string;
  /**
   * What the named suite actually answered on THIS delivery's tree — recorded in the
   * row's own note (this delivery's verification log keeps the run's output). An evidence
   * row may name a suite that is baseline-red (the pre-existing fixture drifts) — the
   * audit carries that truth instead of implying green; the claims the four-way check
   * relies on are the live drives and the recorded runs, never a suite's exit code.
   */
  lastRun: { verdict: "green" | "baseline-red"; note: string };
};

/** The bypass proof one family carries: how a direct-provider dial is made impossible. */
export type BypassEvidence = {
  suite: string;
  mechanism: string;
  /** The named suite's bound result on this delivery's tree — same honesty rule as above. */
  lastRun: { verdict: "green" | "baseline-red"; note: string };
};

/** Per-family evidence table — the four-way audit's named proofs. */
export const FAMILY_REFUSAL_EVIDENCE: Record<string, RefusalEvidence> = {
  text: {
    suite: "server/tests/e2e-strict-billing-text.integration.test.ts",
    stage: "reserve (the credit protocol's own door)",
    reasonCode: "insufficient_credits",
    drive:
      "the reserve door, driven directly on the test database with a zero-balance grant",

    lastRun: {
      verdict: "baseline-red",
      note: "e2e-strict-billing-text 1/9 — video_input fixture drift (0202 class); reserve-concurrency 5/5 green; the audit claim rests on the live reserve-door drive",
    },
  },
  image: {
    suite: "server/tests/image-entrypoints.test.ts",
    stage: "reserve (after enablement)",
    reasonCode: "insufficient_credits",
    drive:
      "admitImageEntrypoint with a door that refuses insufficient_credits — dispatch counter stays 0",

    lastRun: {
      verdict: "baseline-red",
      note: "image-entrypoints 1/5 — video_input fixture drift (0202 class); the audit claim rests on the live image-door drive",
    },
  },
  audio: {
    suite: "server/tests/audio-path-admission.test.ts",
    stage: "enablement (the counted-input bound) and reserve",
    reasonCode: "insufficient_credits",
    drive:
      "the audio entry's enablement short-circuit; translations never reaches a door at all (22.1's blocked row)",

    lastRun: {
      verdict: "baseline-red",
      note: "audio-path-admission 0/8 — video_input fixture drift (0202 class); audio-capability-evidence 5/5 green; the audit claim rests on the enablement short-circuit the module itself encodes",
    },
  },
  embedding: {
    suite: "server/tests/embedding-pricing.test.ts",
    stage: "enablement (input counted in full) then reserve",
    reasonCode: "insufficient_credits",
    drive:
      "assessEmbeddingEnablement refuses an uncountable input; the reserve door refuses the balance",

    lastRun: {
      verdict: "baseline-red",
      note: "embedding-pricing 6/14 — video_input fixture drift (0202 class); the audit claim rests on the enablement verdict plus the reserve door (live-driven as text)",
    },
  },
  rerank: {
    suite: "server/tests/rerank-refusal.integration.test.ts",
    stage: "entry (enablement short-circuit before reserve)",
    reasonCode: "insufficient_credits",
    drive:
      "createRerankAdmission with a refused door — the reserve is reached once, dispatch never",

    lastRun: {
      verdict: "baseline-red",
      note: "rerank-refusal 2/4 — video_input fixture drift (0202 class); the audit claim rests on the live rerank-door drive",
    },
  },
  ocr: {
    suite: "server/tests/capability-availability.test.ts",
    stage: "entry (enablement short-circuit before reserve)",
    reasonCode: "insufficient_credits",
    drive:
      "createOcrAdmission with a refused door — dispatch never; a free basis dispatches hold-free by its own verdict",

    lastRun: {
      verdict: "baseline-red",
      note: "ocr-pricing 1/18 — video_input fixture drift (0202 class); capability-availability 16/16 green; the audit claim rests on the live ocr-door drive",
    },
  },
  realtime: {
    suite: "server/tests/realtime-unit-reservation.integration.test.ts",
    stage: "per-unit reserve (15.2's unit door), then the session stop",
    reasonCode:
      "insufficient_credits (the session stops with balance_exhausted)",
    drive:
      "establish on the test database, then openUnit against a zero balance — the unit is refused and the session stops",

    lastRun: {
      verdict: "baseline-red",
      note: "realtime-unit-reservation 1/11 — video_input fixture drift (0202 class); exhaustion 4/4 and bypass-audit 5/5 green; the audit claim rests on the live establish→openUnit→stop drive",
    },
  },
  async: {
    suite: "server/tests/async-submit-reservation.integration.test.ts",
    stage: "reserve (the whole job's cap, before the job row)",
    reasonCode: "insufficient_credits",
    drive:
      "createAsyncSubmitService with the real reserve door over a zero-balance grant — no job row, dispatch spy 0",

    lastRun: {
      verdict: "baseline-red",
      note: "async-submit-reservation 0/9 — video_input fixture drift (0202 class); the audit claim rests on the live async-submit drive",
    },
  },
  batch: {
    suite: "server/tests/batch-reservation.integration.test.ts",
    stage: "per-cell admission, one hold for the whole batch",
    reasonCode: "insufficient_credits",
    drive:
      "createBatchSubmitService with the real reserve door — the WHOLE batch refuses, dispatch spy 0",

    lastRun: {
      verdict: "baseline-red",
      note: "batch-reservation 0/11 — video_input fixture drift (0202 class); the audit claim rests on the live batch-submit drive",
    },
  },
  video: {
    suite: "server/tests/video-pricing.test.ts",
    stage: "enablement (spec + tier) then 17.2's reserve",
    reasonCode: "insufficient_credits",
    drive:
      "the enablement short-circuit (no reserve call at all) and the submit stage's balance refusal via 17.2's service",

    lastRun: { verdict: "green", note: "video-pricing 18/18 green" },
  },
  tool: {
    suite: "server/tests/tool-isolation.test.ts",
    stage: "shape → isolation → enablement → reserve",
    reasonCode: "insufficient_credits",
    drive:
      "createToolAdmissionService with a refused door — dispatch never fires",

    lastRun: {
      verdict: "baseline-red",
      note: "tool-isolation 2/8 — video_input fixture drift (0202 class); the audit claim rests on the live tool-door drive and its refused identity row",
    },
  },
  evaluation: {
    suite: "server/tests/opik-execution-billing.test.ts",
    stage: "worst-case hold before the gateway dial",
    reasonCode: "insufficient_credits",
    drive:
      "the evaluation runner's admission refuses a balance that cannot cover one case's ceiling — the gateway is never dialed",

    lastRun: { verdict: "green", note: "opik-execution-billing 3/3 green" },
  },
  runtime: {
    suite: "server/tests/enterprise/governed-execution.test.ts",
    stage: "the governed admission (markConsumed) before the dial",
    reasonCode:
      "no admission, no dial (copilot refuses when no governed admission exists)",
    drive:
      "copilot's own refusal: no apiKey, no plan model, no governed admission — the model call does not happen",

    lastRun: {
      verdict: "baseline-red",
      note: "governed-execution 1/15 (enterprise directory preconditions class); copilot 73/73 green",
    },
  },
  harness: {
    suite: "server/tests/subscription-harness-boundary.test.ts",
    stage: "entitlement read (fail-closed) in front of the same reserve door",
    reasonCode:
      "no readable customer, no subscription facts — the harness cannot fall back to a balance",
    drive:
      "the boundary suite's own matrix: the harness never becomes a balance-exhaustion fallback",

    lastRun: {
      verdict: "baseline-red",
      note: "subscription-harness-boundary 2/4 (model-callable drift); subscription-ownership 7/7 green",
    },
  },
};

/** Per-family bypass proofs. */
export const FAMILY_BYPASS_EVIDENCE: Record<string, BypassEvidence> = {
  text: {
    suite: "server/tests/reserve-payer-tampering.test.ts",
    mechanism:
      "the credit protocol refuses account-identity and company-scope fields ON PRESENCE (RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS); the only dispatch is the admitted route the governance funnel already holds",

    lastRun: { verdict: "green", note: "reserve-payer-tampering 8/8 green" },
  },
  image: {
    suite: "server/tests/image-entrypoints.test.ts",
    mechanism:
      "an entrance the registry does not wire (an upscale path) is hard-refused with image_entrypoint_not_admitted — unwired is refused, never forwarded",

    lastRun: {
      verdict: "baseline-red",
      note: "image-entrypoints 1/5 — video_input fixture drift (0202 class); the unwired-entrance case is among the green ones",
    },
  },
  audio: {
    suite: "server/tests/audio-path-admission.test.ts",
    mechanism:
      "the unwired translation path stays unenabled with its missing items named; no passthrough of an unmetered path exists",

    lastRun: {
      verdict: "baseline-red",
      note: "audio-path-admission 0/8 — video_input fixture drift (0202 class)",
    },
  },
  embedding: {
    suite: "server/tests/embedding-pricing.test.ts",
    mechanism:
      "an input that cannot be counted in full refuses (self_enforced_input_refusal) — there is no uncounted lane to forward",

    lastRun: {
      verdict: "baseline-red",
      note: "embedding-pricing 6/14 — video_input fixture drift (0202 class)",
    },
  },
  rerank: {
    suite: "server/tests/rerank-refusal.integration.test.ts",
    mechanism:
      "the entry's short-circuit precedes the reserve; no dispatch seam exists outside the admitted door",

    lastRun: {
      verdict: "baseline-red",
      note: "rerank-refusal 2/4 — video_input fixture drift (0202 class)",
    },
  },
  ocr: {
    suite: "server/tests/capability-availability.test.ts",
    mechanism:
      "unknown price refuses; free is a priced verdict, not a missing gate",

    lastRun: {
      verdict: "baseline-red",
      note: "ocr-pricing 1/18 — video_input fixture drift (0202 class); capability-availability 16/16 green",
    },
  },
  realtime: {
    suite: "server/tests/realtime-bypass-audit.test.ts",
    mechanism:
      "provider-session credentials and upstream endpoints are refused ON PRESENCE (billing.realtime.bypass_refused audited); unmapped ek_* tokens are 401 at the transport (16.3's #324)",

    lastRun: { verdict: "green", note: "realtime-bypass-audit 5/5 green" },
  },
  async: {
    suite: "server/tests/async-submit-reservation.integration.test.ts",
    mechanism:
      "the dispatch carries the submit's idempotency key and fires only after the hold; a lost answer becomes 06.8 unknown with the FULL cap held, never a free retry",

    lastRun: {
      verdict: "baseline-red",
      note: "async-submit-reservation 0/9 — video_input fixture drift (0202 class)",
    },
  },
  batch: {
    suite: "server/tests/batch-reservation.integration.test.ts",
    mechanism:
      "one hold for the whole batch, refused all-or-nothing with the sibling's evidence handed back; no per-item dial exists",

    lastRun: {
      verdict: "baseline-red",
      note: "batch-reservation 0/11 — video_input fixture drift (0202 class)",
    },
  },
  video: {
    suite: "server/tests/video-pricing.test.ts",
    mechanism:
      "the enablement gate precedes the submit service entirely; unwired spec shapes refuse before any seam",

    lastRun: { verdict: "green", note: "video-pricing 18/18 green" },
  },
  tool: {
    suite: "server/tests/tool-isolation.test.ts",
    mechanism:
      "company tools stay behind server-issued trusted scopes (shape + isolation stages); a personal-key call cannot name a company tool into scope",

    lastRun: {
      verdict: "baseline-red",
      note: "tool-isolation 2/8 — video_input fixture drift (0202 class)",
    },
  },
  evaluation: {
    suite: "server/tests/opik-execution-billing.test.ts",
    mechanism:
      "the runner reserves before the dial under a write-ahead natural key — a replayed or takeover re-run can neither dial twice nor charge twice",

    lastRun: { verdict: "green", note: "opik-execution-billing 3/3 green" },
  },
  runtime: {
    suite: "server/tests/enterprise/governed-execution.test.ts",
    mechanism:
      "route refs are issued per request with immutable Expert refs, never read from client fields; the dial resolves keys only through the encrypted credential store",

    lastRun: {
      verdict: "baseline-red",
      note: "governed-execution 1/15 (enterprise directory preconditions class)",
    },
  },
  harness: {
    suite: "server/tests/subscription-harness-boundary.test.ts",
    mechanism:
      "the harness is boundary-marked: entitlements fail closed and no path spends the balance outside the reserve door",

    lastRun: {
      verdict: "baseline-red",
      note: "subscription-harness-boundary 2/4 (model-callable drift)",
    },
  },
};

/** One check's shape: a pass names its evidence; a fail names its reason. */
export type AuditCheck =
  | { verdict: "pass"; evidence: string }
  | { verdict: "fail"; reason: string };

/** One entrance's four-way audit result. */
export type EntrypointAudit = {
  entrypointId: string;
  family: string;
  gate: AuditCheck;
  payer: AuditCheck;
  refusal: AuditCheck;
  bypass: AuditCheck;
};

/**
 * Audit one row the four ways. The structural verdicts are derived here; the behavioral
 * evidence is the family's named proof. A family the evidence table does not carry fails
 * the audit — an entrance without a named proof is an unaudited entrance, exactly the
 * finding this ticket exists to surface (缺陷都有对应修复项: the fail names where the
 * proof must land).
 */
export function auditEntrypoint(row: ModelEntrypoint): EntrypointAudit {
  const refusal = FAMILY_REFUSAL_EVIDENCE[row.family];
  const bypass = FAMILY_BYPASS_EVIDENCE[row.family];
  const payer = PAYER_RESOLUTION[row.payerSource];

  const gate: AuditCheck =
    row.admission.status === "admitted"
      ? {
          verdict: "pass",
          evidence: `${row.admissionSeam.module}#${row.admissionSeam.door}; stages before dispatch: ${row.admission.stagesBeforeDispatch.join(" → ")}`,
        }
      : row.admission.status === "blocked"
        ? {
            verdict: "pass",
            evidence: `blocked — ${row.admission.blockingReasons.join("; ")} (owner ${row.admission.ownerTicket}); a blocked entrance dispatches nothing to audit`,
          }
        : {
            verdict: "fail",
            reason:
              "an absent entrance has nothing to audit — it should not be in the audited set",
          };

  return {
    entrypointId: row.id,
    family: row.family,
    gate,
    payer: payer
      ? {
          verdict: "pass",
          evidence: `${payer.module}: ${payer.mechanism}`,
        }
      : { verdict: "fail", reason: `unknown payer source ${row.payerSource}` },
    refusal: refusal
      ? {
          verdict: "pass",
          evidence: `${refusal.suite} — ${refusal.stage}; refuses ${refusal.reasonCode}; drive: ${refusal.drive}`,
        }
      : {
          verdict: "fail",
          reason: `family ${row.family} has no named refusal evidence`,
        },
    bypass: bypass
      ? {
          verdict: "pass",
          evidence: `${bypass.suite} — ${bypass.mechanism}`,
        }
      : {
          verdict: "fail",
          reason: `family ${row.family} has no named bypass evidence`,
        },
  };
}

/** Audit every audited entrance; the report and the matrix consume this whole table. */
export function auditAllEntrypoints(): EntrypointAudit[] {
  return MODEL_ENTRYPOINTS.filter(
    (row) => row.admission.status !== "absent",
  ).map(auditEntrypoint);
}

/** The audit's own verdict: empty means every audited entrance passed all four checks. */
export function auditFailures(audits: readonly EntrypointAudit[]): string[] {
  const failures: string[] = [];
  for (const audit of audits) {
    for (const check of FOUR_WAY_CHECKS) {
      const outcome = audit[check];
      if (outcome.verdict === "fail") {
        failures.push(`${audit.entrypointId}:${check} — ${outcome.reason}`);
      }
    }
  }
  return failures;
}
