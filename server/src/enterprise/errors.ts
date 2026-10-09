/**
 * Stable security errors, per plan 02 §4.3.
 *
 * The code is the contract; the message is deliberately just the code. Callers classify behaviour
 * by `code`, map transport status from `status`, and never parse message text. Database and auth
 * adapters map already-identified driver error codes onto these; every unrecognized error fails
 * closed rather than being coerced into a more optimistic class.
 *
 * Uniform meaning: no session 401; missing/invalid tenant selection 400; non-member or suspended
 * 403; invisible resource 404; operation-idempotency or update-version conflicts 409; identifiable
 * dependency unavailability, corrupted authorization state or unknown policy 503; anything else
 * 500.
 */
export class EnterpriseError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
  ) {
    super(code);
  }
}
