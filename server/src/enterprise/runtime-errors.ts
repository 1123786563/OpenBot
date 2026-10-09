import { z } from "zod";

export const OPERATION_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "gone",
  "rate_limited",
  "unsupported_version",
  "budget_exceeded",
  "approval_required",
  "reconciliation_required",
  "unavailable",
  "internal",
] as const;

export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];

export const OPERATION_ERROR_HTTP_STATUS: Readonly<
  Record<OperationErrorCode, number>
> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  rate_limited: 429,
  unsupported_version: 426,
  budget_exceeded: 422,
  approval_required: 409,
  reconciliation_required: 409,
  unavailable: 503,
  internal: 500,
};

export const OperationErrorSchema = z
  .object({
    code: z.enum(OPERATION_ERROR_CODES),
    message: z.string().min(1).max(500),
    request_id: z.string().min(1).max(200),
  })
  .strict();

export const OperationErrorEnvelopeSchema = z
  .object({ error: OperationErrorSchema })
  .strict();

/** Only safe, caller-facing fields enter the public response envelope. */
export function publicOperationError(
  code: OperationErrorCode,
  requestId: string,
): z.infer<typeof OperationErrorEnvelopeSchema> {
  return OperationErrorEnvelopeSchema.parse({
    error: {
      code,
      message: code === "internal" ? "Request failed." : PUBLIC_MESSAGES[code],
      request_id: requestId,
    },
  });
}

const PUBLIC_MESSAGES: Readonly<Record<OperationErrorCode, string>> = {
  invalid_request: "The request is invalid.",
  unauthenticated: "Authentication is required.",
  forbidden: "The operation is not permitted.",
  not_found: "The requested resource was not found.",
  conflict: "The request conflicts with the current resource state.",
  gone: "The requested resource is no longer available.",
  rate_limited: "Too many requests.",
  unsupported_version: "The requested contract version is not supported.",
  budget_exceeded: "The operation exceeds its allowed budget.",
  approval_required: "Approval is required before continuing.",
  reconciliation_required: "The operation requires reconciliation.",
  unavailable: "The service is temporarily unavailable.",
  internal: "Request failed.",
};
