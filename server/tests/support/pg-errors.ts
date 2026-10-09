/**
 * Classifies a rejected database statement by the driver's SQLSTATE plus the object the message
 * names, so a table-privilege denial (42501 "permission denied for table"), an RLS WITH CHECK
 * denial (42501 "new row violates row-level security policy") and a composite foreign-key denial
 * (23503) stay three distinguishable answers instead of one `toThrow()`.
 *
 * Drizzle wraps driver failures in DrizzleQueryError (whose message is only "Failed query: …"),
 * and Bun's PostgresError carries the SQLSTATE in `errno` while `code` holds a driver-level
 * string — so walk the cause chain for the first five-character SQLSTATE. An error without one is
 * itself a failure: it means the driver's classification was never reached.
 */
export type PgError = { code: string; message: string };

export async function rejectionOf(
  run: () => Promise<unknown>,
): Promise<PgError> {
  try {
    await run();
  } catch (error) {
    let candidate = error as Record<string, unknown> | undefined;
    for (let depth = 0; candidate !== undefined && depth < 5; depth += 1) {
      const sqlstate = [candidate.errno, candidate.code].find(
        (value) =>
          typeof value === "string" && /^[0-9A-Z]{5}$/.test(value as string),
      );
      if (
        typeof sqlstate === "string" &&
        typeof candidate.message === "string"
      ) {
        return { code: sqlstate, message: candidate.message as string };
      }
      candidate = candidate.cause as Record<string, unknown> | undefined;
    }
    throw new Error(
      `expected a PostgreSQL error with a SQLSTATE and message, got: ${String(error)}`,
    );
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}
