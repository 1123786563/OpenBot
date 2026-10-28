import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../db/client";
import { accessGrants } from "../db/schema";
import {
  asyncJobs,
  creditReservations,
} from "../db/schema/credit-reservations";
import { RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS } from "./credit-reserve";
import type { CreditServiceVariables } from "./credit-service-auth";
import { findCompanyScopeIdentityField } from "./personal-key-isolation";

/**
 * The async job Status query (Bifrost 17.4, #328): the read-only, ownership-scoped door a
 * job's owner asks "what became of my job" through.
 *
 * WHAT A QUERY MAY SEE. The answer is scoped by the grant the caller works under — the
 * server resolves the payment account FROM the grant row (06.4's boundary: the request
 * names no account, and any self-reported account or company-scope field is the tamper
 * shape, refused at the shape boundary before a single read). Only the owning account's
 * job answers. Another account's job, a job that does not exist, and a scope that resolves
 * nothing all answer the SAME bare `not_found` — the answer's shape carries nothing about
 * which jobs exist under another account (06.7's uniform-unknown discipline, job flavour).
 * Visibility is deliberately not admission: a grant revoked after the submit still answers,
 * because the job it admitted still occupies that account's credit and its owner may still
 * ask what became of it.
 *
 * WHAT A QUERY MAY DO. Nothing. Every statement here is a SELECT — no transaction, no
 * lock, no write, and structurally NO money seam at all: the service holds a database and
 * nothing else, so a status query cannot reserve, settle, release or dispatch (17.5 keeps
 * settlement entirely on the background terminal lane; a query that settled would be the
 * double-charge AC07 forbids). The dispatch state and the money state are reported
 * verbatim off their own rows — `dispatch_unconfirmed` jobs read as unconfirmed with the
 * reservation's `unknown` beside them (17.3's lane), never re-derived.
 *
 * WHO CALLS THIS. The deployment-trusted Bifrost admission extension — the same service
 * identity 06.1 issues and the protocol surfaces mount behind. An administrator's reads
 * travel the existing admin billing surfaces with their own audit trail; this door offers
 * no admin bypass, and an account-naming field refuses no matter who sends it.
 */

/** The refusal vocabulary — the shape boundary's own closed set. */
export type AsyncStatusRefusalReasonCode = "request_invalid" | "payer_conflict";

/** The one displayable sentence per refusal code. */
export const ASYNC_STATUS_REFUSAL_SENTENCES: Record<
  AsyncStatusRefusalReasonCode,
  string
> = {
  request_invalid: "The async status request is not a valid status request.",
  payer_conflict:
    "The request names a payment account; the account is resolved server-side from the scope grant and self-reported accounts are refused.",
};

/** The reservation's own money view, read verbatim — the fields an owner may ask about. */
export type AsyncJobReservationView = {
  reservationId: string;
  status: "reserved" | "unknown" | "settled" | "released";
  maximumCredits: number;
  appliedCredits: number | null;
  releasedCredits: number | null;
  terminalAt: string | null;
};

/** The answer for a job the scope owns: identity, dispatch state, and the hold's state. */
export type AsyncJobStatusFound = {
  status: "found";
  job: {
    jobId: string;
    providerJobId: string | null;
    state: "submitted" | "dispatch_unconfirmed";
    grantId: string;
    model: { provider: string; model: string; capability: string };
    snapshotVersion: number;
    rateVersion: number;
    entryCount: number;
    createdAt: string;
    dispatchedAt: string | null;
    reservation: AsyncJobReservationView;
  };
};

/** What a Status query answers: the owner's job, the uniform not-found, or a shape refusal. */
export type AsyncJobStatusAnswer =
  | { kind: "answered"; outcome: AsyncJobStatusFound | { status: "not_found" } }
  | {
      kind: "refused";
      reasonCode: AsyncStatusRefusalReasonCode;
      detail: Record<string, unknown>;
    };

type AsyncStatusRequest = {
  grantId: string;
  jobId?: string;
  submitIdempotencyKey?: string;
  providerJobId?: string;
};

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

// Compile-time constant, requested on every status read — built once, not per request.
const FORBIDDEN_ACCOUNT_KEY_FIELDS = new Set(
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
);

/**
 * Pure shape validation, before any database contact: exactly one selector, and the
 * account/company-scope vocabulary refused on presence (06.4 + 09.3 — presence is the
 * attempt, because the account is resolved from the grant, never named).
 */
function validateStatusRequest(input: unknown):
  | { ok: true; request: AsyncStatusRequest }
  | {
      ok: false;
      reasonCode: AsyncStatusRefusalReasonCode;
      detail: Record<string, unknown>;
    } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: { field: "body" },
    };
  }
  const raw = input as Record<string, unknown>;

  const forbidden = FORBIDDEN_ACCOUNT_KEY_FIELDS;
  for (const key of Object.keys(raw)) {
    if (
      forbidden.has(key.toLowerCase()) ||
      findCompanyScopeIdentityField({ [key]: true })
    ) {
      return {
        ok: false,
        reasonCode: "payer_conflict",
        detail: { stage: "request_shape", field: key },
      };
    }
  }

  if (!isIdentifier(raw.grantId, 512)) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: { field: "grantId" },
    };
  }

  const selectors = ["jobId", "submitIdempotencyKey", "providerJobId"].filter(
    // Null is absence here (isIdentifier would refuse it as a value, but then a lone
    // `{"jobId": null}` would read as "two selectors" instead of "none").
    (key) => raw[key] !== undefined && raw[key] !== null,
  );
  if (selectors.length !== 1) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: {
        field: selectors.length === 0 ? "jobId" : selectors[0],
        reason: "exactly_one_of_jobId_submitIdempotencyKey_providerJobId",
      },
    };
  }
  const selector = selectors[0];
  if (!isIdentifier(raw[selector], 512)) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: { field: selector },
    };
  }

  return {
    ok: true,
    request: {
      grantId: raw.grantId as string,
      ...(raw.jobId !== undefined ? { jobId: raw.jobId as string } : {}),
      ...(raw.submitIdempotencyKey !== undefined
        ? { submitIdempotencyKey: raw.submitIdempotencyKey as string }
        : {}),
      ...(raw.providerJobId !== undefined
        ? { providerJobId: raw.providerJobId as string }
        : {}),
    },
  };
}

export type AsyncJobStatusServiceDependencies = {
  database: Database;
};

export type AsyncJobStatusService = {
  /** Read-only, ownership-scoped status lookup. Never writes; never moves money. */
  queryStatus(request: unknown): Promise<AsyncJobStatusAnswer>;
};

/**
 * The Status service: shape validation, then three plain reads — the scope grant, the job
 * row, the reservation row — and nothing else. No transaction, because no invariant spans
 * them: each read answers whatever committed state it sees, and the writer's own
 * transitions are the only writers there are.
 */
export function createAsyncJobStatusService(
  dependencies: AsyncJobStatusServiceDependencies,
): AsyncJobStatusService {
  const { database } = dependencies;
  return {
    async queryStatus(request: unknown): Promise<AsyncJobStatusAnswer> {
      const validated = validateStatusRequest(request);
      if (!validated.ok) {
        return {
          kind: "refused",
          reasonCode: validated.reasonCode,
          detail: validated.detail,
        };
      }
      const { grantId, jobId, submitIdempotencyKey, providerJobId } =
        validated.request;

      // Scope first: the payer is resolved from the grant row alone. A grant this server
      // cannot resolve scopes nothing, and a scope that sees nothing answers not_found —
      // for anything, the same word as a job that does not exist.
      const [grant] = await database
        .select({ userId: accessGrants.userId, scope: accessGrants.scope })
        .from(accessGrants)
        .where(eq(accessGrants.grantId, grantId))
        .limit(1);
      if (grant?.scope !== "model-access") {
        return { kind: "answered", outcome: { status: "not_found" } };
      }

      const [jobRow] = await database
        .select()
        .from(asyncJobs)
        .where(
          (() => {
            if (jobId !== undefined) return eq(asyncJobs.jobId, jobId);
            if (submitIdempotencyKey !== undefined) {
              return eq(asyncJobs.submitIdempotencyKey, submitIdempotencyKey);
            }
            return eq(asyncJobs.providerJobId, providerJobId as string);
          })(),
        )
        .limit(1);

      // The ownership check the whole door exists for: the job's frozen payer must be
      // exactly the account the grant resolves. Anything else — foreign or missing — is
      // the one same answer.
      if (
        jobRow === undefined ||
        jobRow.payerId !== grant.userId ||
        jobRow.payerKind !== "personal"
      ) {
        return { kind: "answered", outcome: { status: "not_found" } };
      }

      const [hold] = await database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, jobRow.reservationId))
        .limit(1);
      if (hold === undefined) {
        // A job row without its hold is a defect the submit path's NOT NULL makes
        // impossible; answered as not_found rather than guessed at.
        return { kind: "answered", outcome: { status: "not_found" } };
      }

      return {
        kind: "answered",
        outcome: {
          status: "found",
          job: {
            jobId: jobRow.jobId,
            providerJobId: jobRow.providerJobId,
            state: jobRow.state,
            grantId: jobRow.grantId,
            model: {
              provider: jobRow.provider,
              model: jobRow.model,
              capability: jobRow.capability,
            },
            snapshotVersion: jobRow.snapshotVersion,
            rateVersion: jobRow.rateVersion,
            entryCount: jobRow.entryCount,
            createdAt: jobRow.createdAt.toISOString(),
            dispatchedAt: jobRow.dispatchedAt
              ? jobRow.dispatchedAt.toISOString()
              : null,
            reservation: {
              reservationId: hold.id,
              status: hold.status,
              maximumCredits: hold.maximum,
              appliedCredits: hold.applied,
              releasedCredits: hold.released,
              terminalAt: hold.terminalAt
                ? hold.terminalAt.toISOString()
                : null,
            },
          },
        },
      };
    },
  };
}

/**
 * The Status surface — composed behind the deployment's service identity (06.1's guard,
 * exactly the way the protocol endpoints mount), so no path here exists unauthenticated. A
 * POST, not a GET: the capability-shaped ids belong in a body access logs do not capture.
 * A found job is one 200; the uniform not_found is a 200 too (it is an answer, not an
 * error); a shape refusal is one 422 with its reason code.
 */
export function asyncJobStatusEndpoints(dependencies: {
  service: AsyncJobStatusService;
}): Hono<{ Variables: CreditServiceVariables }> {
  const app = new Hono<{ Variables: CreditServiceVariables }>();
  app.post("/async/status", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: ASYNC_STATUS_REFUSAL_SENTENCES.request_invalid,
          code: "request_invalid",
          detail: { field: "body" },
        },
        422,
      );
    }
    const answer = await dependencies.service.queryStatus(body);
    if (answer.kind === "refused") {
      return context.json(
        {
          error: ASYNC_STATUS_REFUSAL_SENTENCES[answer.reasonCode],
          code: answer.reasonCode,
          detail: answer.detail,
        },
        422,
      );
    }
    return context.json(answer.outcome, 200);
  });
  return app;
}
