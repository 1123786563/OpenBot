import type { PlatformScope } from "../../../src/enterprise/contracts";
import { testDatabaseUrlFrom } from "../../support/database";

export interface RuntimeTestFixture {
  readonly scope: PlatformScope;
  readonly clock: { now(): Date };
  testDatabaseUrl(environment?: Record<string, string | undefined>): string;
  openIsolatedDatabase<T extends { close(): void | Promise<void> }>(
    open: (databaseUrl: string) => Promise<T>,
    environment?: Record<string, string | undefined>,
  ): Promise<T>;
  registerCloseable(closeable: { close(): void | Promise<void> }): void;
  close(): Promise<void>;
}

export function createRuntimeTestFixture(
  options: { now?: string } = {},
): RuntimeTestFixture {
  const instant = new Date(options.now ?? "2026-10-09T00:00:00.000Z");
  if (Number.isNaN(instant.valueOf()))
    throw new Error("Runtime fixture clock requires a valid ISO timestamp.");
  const closeables: Array<{ close(): void | Promise<void> }> = [];
  const closedResources = new WeakSet<object>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const ensureOpen = () => {
    if (closed) throw new Error("Runtime test fixture is already closed.");
  };
  const closeOnce = async (closeable: { close(): void | Promise<void> }) => {
    if (closedResources.has(closeable)) return;
    closedResources.add(closeable);
    await closeable.close();
  };

  return {
    scope: Object.freeze({
      tenantId: "tenant-test",
      workspaceId: "workspace-test",
      principalId: "principal-test",
      actorId: "actor-test",
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    }),
    clock: {
      now: () => new Date(instant),
    },
    testDatabaseUrl: (environment = process.env) =>
      testDatabaseUrlFrom(environment),
    openIsolatedDatabase: async (open, environment = process.env) => {
      ensureOpen();
      const databaseUrl = testDatabaseUrlFrom(environment);
      const database = await open(databaseUrl);
      if (closed) {
        await closeOnce(database);
        throw new Error("Runtime test fixture is already closed.");
      }
      closeables.push(database);
      return database;
    },
    registerCloseable: (closeable) => {
      ensureOpen();
      closeables.push(closeable);
    },
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        for (const closeable of closeables.reverse()) {
          try {
            await closeOnce(closeable);
          } catch (error) {
            failures.push(error);
          }
        }
        closeables.length = 0;
        if (failures.length)
          throw new AggregateError(
            failures,
            "Failed to close runtime test fixture resources.",
          );
      });
      return closePromise;
    },
  };
}
