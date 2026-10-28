/**
 * Shared thrown-error probes for the enterprise multitenancy suites.
 *
 * Single source for the two async helpers the package test chain (PKG02/03/04
 * support + suites) imports: Bun's postgres client carries the SQLSTATE on
 * `errno` (PostgresError) while drizzle surfaces it as `code`, so both
 * spellings are accepted down the `cause` chain. These were duplicated
 * verbatim in `support/plugin-install.ts` and `support/package-install.ts`;
 * both now re-export from here.
 */

/** SQLSTATE is five [0-9A-Z] characters (42P01, 55P03, …), not only digits. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Bounded so a cyclic `cause` cannot hang the probe; deeper nesting is not a driver chain. */
const MAX_CAUSE_DEPTH = 8;

/** Bun's postgres client carries the SQLSTATE on `errno`, drizzle on `code`. */
function sqlStateOf(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  const errno = (error as Error & { errno?: unknown }).errno;
  if (typeof code === "string" && SQLSTATE.test(code)) return code;
  if (typeof errno === "string" && SQLSTATE.test(errno)) return errno;
  return undefined;
}

/**
 * Resolves to the first SQLSTATE in the error chain: "" when the promise did not throw,
 * "UNKNOWN" when it threw without any SQLSTATE on the chain.
 */
export async function thrownSqlState(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    for (
      let e: unknown = error, depth = 0;
      e instanceof Error && depth < MAX_CAUSE_DEPTH;
      e = e.cause, depth += 1
    ) {
      const sqlstate = sqlStateOf(e);
      if (sqlstate !== undefined) return sqlstate;
    }
    return "UNKNOWN";
  }
}

/** Resolves to the concatenated error-message + SQLSTATE chain ("" when it did not throw). */
export async function thrownMessage(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const parts: string[] = [];
    for (
      let e: unknown = error, depth = 0;
      e instanceof Error && depth < MAX_CAUSE_DEPTH;
      e = e.cause, depth += 1
    ) {
      parts.push(e.message);
      const sqlstate = sqlStateOf(e);
      if (sqlstate !== undefined) parts.push(sqlstate);
    }
    return parts.join(" | ");
  }
}
