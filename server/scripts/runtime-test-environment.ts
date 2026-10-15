import { testDatabaseUrlFrom } from "../tests/support/database";

export interface RuntimeTestEnvironment {
  readonly databaseUrl: string;
  readonly databaseName: string;
}

/** Reads only TEST_DATABASE_URL and never loads dotenv or falls back to DATABASE_URL. */
export function runtimeTestEnvironment(
  environment: Record<string, string | undefined> = process.env,
): RuntimeTestEnvironment {
  const databaseUrl = testDatabaseUrlFrom(environment);
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, ""),
  );
  return { databaseUrl, databaseName };
}

if (import.meta.main) {
  const { databaseName } = runtimeTestEnvironment();
  console.log(`Runtime test database validated: ${databaseName}`);
}
