import { timingSafeEqual } from "node:crypto";
import {
  describeExecutionScope,
  type ExecutionScope,
  parseExecutionScope,
} from "../../shared/execution-scope";

export {
  EXECUTION_TENANT_HEADER,
  EXECUTION_WORKSPACE_HEADER,
} from "../../shared/execution-scope";
export { parseExecutionScope, describeExecutionScope };
export type { ExecutionScope };

/**
 * Whether a request's `Authorization` header carries the supervisor's secret.
 *
 * Compared in constant time, as the server (`sameToken`) and the computer (`matchesToken`) already
 * compare theirs. A plain `!==` stops at the first differing character, so the time a refusal takes
 * says how much of a guess was right. This process holds the Docker socket, so it should leak no
 * less than the services it creates. Length still leaks; content does not.
 *
 * Kept out of `index.ts`, which exits at import without its environment, so a test can reach it.
 */
export function authorised(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const offered = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}

/**
 * The execution ownership a request must state alongside the token (MT050).
 *
 * The Bearer says "a caller of this deployment"; it does not say whose computer this call reaches
 * for. These two headers carry that, and a request without them is refused rather than served as
 * deployment-level — the token alone no longer widens into every Bot's container. The scope is
 * compared against the Bot's earlier binding by the caller (`scopeFor`), because the place a
 * cross-scope reach shows up is per-Bot, not per-request.
 */
export function statedScope(
  headers: Headers | Record<string, string | undefined>,
): ExecutionScope | null {
  return parseExecutionScope(headers);
}
