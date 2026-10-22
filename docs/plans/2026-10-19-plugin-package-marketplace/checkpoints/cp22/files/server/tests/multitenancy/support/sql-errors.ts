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

/** Resolves to the first SQLSTATE in the error chain ("" when it did not throw). */
export async function thrownSqlState(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      // Bun's postgres client carries the SQLSTATE on `errno` (PostgresError);
      // drizzle surfaces it as `code`. Accept either spelling.
      const code = (e as Error & { code?: unknown }).code;
      const errno = (e as Error & { errno?: unknown }).errno;
      if (typeof code === "string" && /^\d{5}$/.test(code)) return code;
      if (typeof errno === "string" && /^\d{5}$/.test(errno)) return errno;
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
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      parts.push(e.message);
      const code = (e as Error & { code?: unknown }).code;
      const errno = (e as Error & { errno?: unknown }).errno;
      if (typeof code === "string") parts.push(code);
      if (typeof errno === "string") parts.push(errno);
    }
    return parts.join(" | ");
  }
}
