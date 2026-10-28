import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  buildOpenConnectorOAuthClient,
  type OAuthWireDial,
  type OpenMuseGoogleProvider,
} from "../src/openmuse-connectors/client";
import {
  createOpenMuseGoogleOAuth,
  OpenMuseConnectionRefusedError,
  // Aliased: the files store exports a same-named class, already imported.
  OpenMuseOwnerDisabledError as OpenMuseConnectorOwnerDisabledError,
  type OpenMuseGoogleOAuth,
  openmuseAlias,
} from "../src/openmuse-connectors/google-oauth";
import { createOpenMuseGoogleRoutes } from "../src/openmuse-connectors/routes";
import {
  createOpenMuseGoogleRows,
  type OpenMuseGoogleRows,
  type StoredOpenMuseGoogleConnection,
  type StoredOpenMusePending,
} from "../src/openmuse-connectors/store";
import {
  OPENMUSE_ACCOUNT_DISABLED_CODE,
  openMuseAccountFence,
} from "../src/openmuse-deletion/fence";
import {
  createOpenMuseDeletionManifest,
  MODULE_GAP,
  type OpenMuseDeletionManifestResource,
} from "../src/openmuse-deletion/manifest";
import {
  createOpenMuseFileBytePurger,
  type OpenMuseFileBytePurgeReport,
} from "../src/openmuse-deletion/purge";
import { createOpenMuseConnectorGrantPurger } from "../src/openmuse-deletion/purge-connectors";
import { createOpenMuseRelationalPurger } from "../src/openmuse-deletion/purge-relational";
import {
  createOpenMuseDeletionAdminRoutes,
  createOpenMuseDeletionRestore,
} from "../src/openmuse-deletion/restore";
import {
  backupRetentionDays,
  createOpenMuseBackupRetention,
  createOpenMuseDeletionCleanupView,
  OPENMUSE_REDACTED_LAST_ERROR,
  retentionElapsed,
} from "../src/openmuse-deletion/retention";
import { createOpenMuseExternalAccessRevoker } from "../src/openmuse-deletion/revoke";
import { createOpenMuseAccountDeletionRoutes } from "../src/openmuse-deletion/routes";
import {
  createOpenMuseWorkShutdown,
  recordWorkShutdown,
} from "../src/openmuse-deletion/shutdown";
import {
  createOpenMuseAccountDeletionStore,
  createOpenMuseDeletionResourceRows,
  type OpenMuseAccountDeletionStore,
  type OpenMuseDeletionResourceInput,
  type OpenMuseDeletionResourceRows,
  OpenMusePurgeRefusedError,
  openmuseAccountDeletions,
  openmuseDeletionResources,
  type StoredOpenMuseAccountDeletion,
  type StoredOpenMuseDeletionResource,
} from "../src/openmuse-deletion/store";
import {
  type FileByteStore,
  openMuseFileByteKey,
} from "../src/openmuse-files/bytes";
import { createOpenMuseFilesRoutes } from "../src/openmuse-files/routes";
import {
  createOpenMuseFileRows,
  createOpenMuseFileStore,
  type OpenMuseFileRows,
  OpenMuseOwnerDisabledError,
  type StoredOpenMuseFile,
  type StoredOpenMuseFileVersion,
} from "../src/openmuse-files/store";
import { createOpenMuseNotificationRoutes } from "../src/openmuse-notifications/routes";
import {
  createOpenMuseNotificationStore,
  type OpenMuseNotificationRows,
  type StoredOpenMuseNotification,
} from "../src/openmuse-notifications/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

/** D05: the administrator the restore route requires. */
const actorAdmin: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

/*
 * The session the guards see. Null is an unauthenticated request; the fence's
 * guard and every family's own guard resolve the same switch.
 */
let session: AuthenticatedActor | null = actorOne;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  if (!session) {
    return context.json({ error: "Authentication required." }, 401);
  }
  context.set("actor", session);
  await next();
};

/** Which users carry a deletion marker — the whole state the fence consults. */
const markers = new Set<string>();

/**
 * D05: the marker rows the fake store remembers — the phase column as data.
 * A user is `fenced` while in the set, `restored` while in `restoredUntil`.
 */
const restoredUntil = new Map<string, Date>();
/** D08: the users whose relational purge completed — the third phase, as data. */
const completed = new Set<string>();
const markerRows = new Map<string, StoredOpenMuseAccountDeletion>();

const clock = { now: new Date("2026-10-13T00:00:00Z") };

function deletionMarker(userId: string): StoredOpenMuseAccountDeletion {
  return {
    userId,
    disabledAt: clock.now,
    phase: "fenced",
    restoreUntil: null,
    resources: [],
  };
}

const store: OpenMuseAccountDeletionStore = {
  delete: async (userId) => {
    if (!markers.has(userId)) {
      markers.add(userId);
      const marker = deletionMarker(userId);
      markerRows.set(userId, marker);
      return marker;
    }
    return markerRows.get(userId) ?? deletionMarker(userId);
  },
  get: async (userId) => {
    if (markers.has(userId))
      return markerRows.get(userId) ?? deletionMarker(userId);
    const restored = restoredUntil.get(userId);
    if (restored)
      return {
        ...(markerRows.get(userId) ?? deletionMarker(userId)),
        phase: "restored",
        restoreUntil: restored,
      };
    if (completed.has(userId))
      return {
        ...(markerRows.get(userId) ?? deletionMarker(userId)),
        phase: "completed",
      };
    return null;
  },
  isDisabled: async (userId) => markers.has(userId),
  // D08: the terminal flip — whatever phase the marker carried, it lands
  // `completed`; a repeat re-answers it and a missing marker is null.
  complete: async (userId) => {
    if (
      !markers.has(userId) &&
      !restoredUntil.has(userId) &&
      !completed.has(userId)
    )
      return null;
    markers.delete(userId);
    restoredUntil.delete(userId);
    completed.add(userId);
    return {
      ...(markerRows.get(userId) ?? deletionMarker(userId)),
      phase: "completed",
    };
  },
  restore: async (userId, restoreUntilAt) => {
    if (markers.has(userId)) {
      markers.delete(userId);
      restoredUntil.set(userId, restoreUntilAt);
      const restored = {
        ...(markerRows.get(userId) ?? deletionMarker(userId)),
        phase: "restored" as const,
        restoreUntil: restoreUntilAt,
      };
      return restored;
    }
    const existing = restoredUntil.get(userId);
    return existing
      ? {
          ...(markerRows.get(userId) ?? deletionMarker(userId)),
          phase: "restored" as const,
          restoreUntil: existing,
        }
      : null;
  },
  enumerateOwner: async (userId) =>
    markers.has(userId) || completed.has(userId)
      ? [{ kind: "openmuse-account-deletion", id: userId, externalKey: userId }]
      : [],
  // D09: the deployment-wide roster the cleanup visibility walks — every
  // marker there ever was, phase re-derived the way get() derives it.
  list: async () => {
    const ids = new Set<string>([
      ...markers,
      ...restoredUntil.keys(),
      ...completed,
    ]);
    return [...ids]
      .map((userId) => markerRows.get(userId) ?? deletionMarker(userId))
      .map((row) =>
        completed.has(row.userId)
          ? { ...row, phase: "completed" as const }
          : restoredUntil.has(row.userId)
            ? {
                ...row,
                phase: "restored" as const,
                restoreUntil: restoredUntil.get(row.userId) ?? null,
              }
            : row,
      )
      .sort(
        (a, b) =>
          a.disabledAt.getTime() - b.disabledAt.getTime() ||
          (a.userId < b.userId ? -1 : 1),
      );
  },
};

/**
 * The families D01 fences, one representative route each (workspace is the
 * mobile-bff aggregate; the rest are the openmuse-* sub-app mounts). Each is
 * a working fixture behind its own session guard — the fence must refuse
 * before them, not instead of them.
 */
const FAMILIES = [
  "/api/mobile/workspace",
  "/api/mobile/openmuse-files",
  "/api/mobile/openmuse-tasks",
  "/api/mobile/openmuse-mail",
  "/api/mobile/openmuse-calendar",
  "/api/mobile/openmuse-reviewed-actions",
  "/api/mobile/openmuse-goals",
  "/api/mobile/openmuse-activity",
] as const;

/** Which family handlers actually ran — a fenced request must never land one. */
const handled = new Set<string>();

function familyApp(path: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.get("/", (context) => {
    handled.add(path);
    return context.json({ family: path });
  });
  return app;
}

/**
 * The app.ts mount shape, mirrored: the delete route is registered BEFORE the
 * fence, so a repeat delete after the marker exists still answers; the fence
 * then stands in front of every /api/mobile family registered after it.
 */
function appFor() {
  handled.clear();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/mobile/openmuse-account",
    createOpenMuseAccountDeletionRoutes({ requireUser, store }),
  );
  app.use(
    "/api/mobile/*",
    openMuseAccountFence({ requireUser, isDisabled: store.isDisabled }),
  );
  for (const path of FAMILIES) {
    app.route(path, familyApp(path));
  }
  return app;
}

describe("openMuseAccountFence", () => {
  test("refuses every family with 403 and the stable code, before the handler", async () => {
    markers.add(actorOne.id);
    session = actorOne;
    const app = appFor();
    for (const path of FAMILIES) {
      const response = await app.request(path);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({
        error: expect.any(String),
        code: OPENMUSE_ACCOUNT_DISABLED_CODE,
      });
    }
    // The fence refused; no family handler ran.
    expect(handled).toEqual(new Set());
  });

  test("another user without a marker keeps every family", async () => {
    markers.clear();
    markers.add(actorOne.id);
    session = actorTwo;
    const app = appFor();
    for (const path of FAMILIES) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual({ family: path });
    }
  });

  test("an unauthenticated request keeps the 401 the guards answer", async () => {
    markers.add(actorOne.id);
    session = null;
    const app = appFor();
    for (const path of FAMILIES) {
      const response = await app.request(path);
      expect(response.status, path).toBe(401);
      const body = (await response.json()) as { code?: unknown };
      expect(body.code, path).not.toBe(OPENMUSE_ACCOUNT_DISABLED_CODE);
    }
  });

  test("the fence is cleanup-independent: a marker alone refuses", async () => {
    // The marker exists and nothing else has run — no revocation, no
    // disconnect, every family fixture fully operational (the previous test
    // just proved they answer 200 for a live user). The fence still refuses.
    markers.clear();
    markers.add(actorOne.id);
    session = actorOne;
    const app = appFor();
    const response = await app.request("/api/mobile/openmuse-mail");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code: OPENMUSE_ACCOUNT_DISABLED_CODE,
    });
    expect(handled).toEqual(new Set());
  });
});

describe("POST /api/mobile/openmuse-account/delete", () => {
  test("writes the marker and nothing else, returning it", async () => {
    markers.clear();
    session = actorOne;
    const app = appFor();
    const response = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deletion: {
        userId: actorOne.id,
        disabledAt: clock.now.toISOString(),
        phase: "fenced",
        restoreUntil: null,
      },
      // No seams wired (round 6 M18): the answer names only the steps the
      // deployment can act on — none — instead of reporting unwired work as
      // a no-op ok. A caller can tell executed from not-wired, and a partial
      // wiring's answer stays the whole truth.
      steps: {},
    });
    expect(markers).toEqual(new Set([actorOne.id]));
  });

  test("a repeat delete is idempotent and never fenced by its own marker", async () => {
    markers.clear();
    session = actorOne;
    const app = appFor();
    const first = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(first.status).toBe(200);
    const second = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as {
      deletion: { disabledAt: string };
    };
    const secondBody = (await second.json()) as {
      deletion: { disabledAt: string };
    };
    expect(secondBody.deletion.disabledAt).toBe(firstBody.deletion.disabledAt);
  });

  test("a failing step answers by name instead of an opaque 500: the marker stands and later steps still run", async () => {
    markers.clear();
    session = actorOne;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({
        requireUser,
        store,
        // The shutdown dies mid-flight; the fence is already live, so the
        // answer must name the failure and keep converging behind it.
        shutdownOwnerWork: async () => {
          throw new Error("tasks table unreachable");
        },
        revokeExternalAccess: async () => "revoked",
      }),
    );
    const response = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletion: { phase: string };
      steps: Record<string, string>;
    };
    expect(body.deletion.phase).toBe("fenced");
    expect(body.steps.shutdown).toBe("failed: tasks table unreachable");
    expect(body.steps.revoke).toBe("ok");
    // Manifest is not wired in this assembly: the step is absent, not "ok"
    // for work that never ran (round 6 M18).
    expect(body.steps.manifest).toBeUndefined();
  });

  test("a step failure that quotes a credential is redacted in the answer (G06)", async () => {
    markers.clear();
    session = actorOne;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({
        requireUser,
        store,
        // The vendor's refusal quotes the bearer it failed on: the delete
        // answer is an exit like the cleanup view and the manifest, never the
        // surface a raw reason escapes through. Details stay server-side.
        revokeExternalAccess: async () => {
          throw new Error(
            "provider refused: bearer ya29.a0AfH6SMBx-toomanychars-for-a-token-shape",
          );
        },
      }),
    );
    const response = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      steps: Record<string, string>;
    };
    expect(body.steps.revoke).toBe(
      "failed: redacted: the recorded reason may quote a credential",
    );
    expect(JSON.stringify(body)).not.toContain("ya29.");
  });

  test("refuses an unauthenticated caller with 401", async () => {
    markers.clear();
    session = null;
    const app = appFor();
    const response = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(markers).toEqual(new Set());
  });
});

/*
 * The store against a real PostgreSQL, gated on TEST_DATABASE_URL the way the
 * billing and code-run suites are. The table is created by applying the
 * generated migration to the test database out of band.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "openmuse account deletion store",
  () => {
    const database = createDatabase(testDatabaseUrl(), TEST_POOL);
    const store = createOpenMuseAccountDeletionStore(database);
    const prefix = `del-${randomUUID().slice(0, 8)}`;

    afterAll(async () => {
      await database
        .delete(openmuseAccountDeletions)
        .where(like(openmuseAccountDeletions.userId, `${prefix}%`));
      await database.$client.close();
    });

    test("delete is insert-once: a repeat returns the existing row unchanged", async () => {
      const userId = `${prefix}-a`;
      const first = await store.delete(userId);
      expect(first.userId).toBe(userId);
      expect(first.phase).toBe("fenced");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await store.delete(userId);
      expect(second.disabledAt).toEqual(first.disabledAt);
      const rows = await database
        .select()
        .from(openmuseAccountDeletions)
        .where(like(openmuseAccountDeletions.userId, userId));
      expect(rows).toHaveLength(1);
    });

    test("a repeat delete over a restored marker re-engages the fence, keeping the first disabledAt", async () => {
      const userId = `${prefix}-refence-restored`;
      const first = await store.delete(userId);
      await store.restore(
        userId,
        new Date(first.disabledAt.getTime() + 30 * 86_400_000),
      );
      expect(await store.isDisabled(userId)).toBe(false);
      // The owner asks to delete again from inside the restored window:
      // the route proceeds to shutdown/revocation/manifest behind this
      // answer, so the fence must be live again — not still lifted.
      const again = await store.delete(userId);
      expect(again.phase).toBe("fenced");
      expect(again.disabledAt).toEqual(first.disabledAt);
      expect(await store.isDisabled(userId)).toBe(true);
    });

    test("a repeat delete over a completed tombstone re-fences too", async () => {
      const userId = `${prefix}-refence-completed`;
      const first = await store.delete(userId);
      await store.complete(userId);
      const again = await store.delete(userId);
      expect(again.phase).toBe("fenced");
      expect(again.disabledAt).toEqual(first.disabledAt);
      expect(await store.isDisabled(userId)).toBe(true);
    });

    test("isDisabled flips only for the user whose marker was written", async () => {
      const marked = `${prefix}-b`;
      const other = `${prefix}-c`;
      expect(await store.isDisabled(marked)).toBe(false);
      await store.delete(marked);
      expect(await store.isDisabled(marked)).toBe(true);
      expect(await store.isDisabled(other)).toBe(false);
      expect(await store.get(other)).toBe(null);
    });

    test("enumerateOwner returns the marker ref and nothing else", async () => {
      const userId = `${prefix}-d`;
      await store.delete(userId);
      expect(await store.enumerateOwner(userId)).toEqual([
        { kind: "openmuse-account-deletion", id: userId, externalKey: userId },
      ]);
    });

    test("D09: list answers the deployment-wide roster in stable order", async () => {
      const first = await store.delete(`${prefix}-f1`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.delete(`${prefix}-f2`);
      const roster = await store.list();
      const mine = roster.filter((row) => row.userId.startsWith(`${prefix}-f`));
      expect(mine.map((row) => row.userId)).toEqual([
        `${prefix}-f1`,
        `${prefix}-f2`,
      ]);
      expect(mine[0]?.disabledAt).toEqual(first.disabledAt);
    });

    test("recordWorkShutdown appends its transitions to the marker's resources", async () => {
      const userId = `${prefix}-e`;
      await store.delete(userId);
      const record = recordWorkShutdown(database);
      await record(userId, ["openmuse-task:t1:cancelled"]);
      await record(userId, [
        "openmuse-task:t2:cancel-requested",
        "openmuse-reviewed-action:r1:cancelled",
      ]);
      const rows = await database
        .select()
        .from(openmuseAccountDeletions)
        .where(eq(openmuseAccountDeletions.userId, userId));
      expect(rows[0]?.resources).toEqual([
        "openmuse-task:t1:cancelled",
        "openmuse-task:t2:cancel-requested",
        "openmuse-reviewed-action:r1:cancelled",
      ]);
    });

    test("insertResources writes large manifests in batches under PG's parameter ceiling", async () => {
      const userId = `${prefix}-batch`;
      await store.delete(userId);
      const rows = createOpenMuseDeletionResourceRows(database);
      // 1_500 rows at 6 bound parameters each would ride one statement in
      // the unsliced insert this replaces — fine at this size, but a large
      // owner's File versions (one row per version) run past PG's 65_535
      // parameter ceiling and the whole insert fails. Two batches land.
      const resources = Array.from({ length: 1_500 }, (_, index) => ({
        kind: "openmuse-file",
        id: `file-${index}`,
        externalKey: `bytes/${userId}/${index}`,
      }));
      await rows.insertResources(userId, resources);
      expect(await rows.listResources(userId)).toHaveLength(1_500);
      // Insert-once across the batch boundary: a repeat adds nothing.
      await rows.insertResources(userId, resources);
      expect(await rows.listResources(userId)).toHaveLength(1_500);
      await rows.hardDeleteResources(userId);
    });

    test("D03: createOpenMuseGoogleRows reads the deletion marker for ownerDisabled (the public callback's check)", async () => {
      const rows = createOpenMuseGoogleRows(database);
      expect(await rows.ownerDisabled(`${prefix}-gone`)).toBe(false);
      await store.delete(`${prefix}-gone`);
      expect(await rows.ownerDisabled(`${prefix}-gone`)).toBe(true);
      expect(await rows.ownerDisabled("somebody-else")).toBe(false);
      // D05 lifts the fence the same way for the direct readers: a restored
      // marker is a live account again, not a tombstone that fences forever.
      await store.restore(`${prefix}-gone`, new Date("2026-11-13T00:00:00Z"));
      expect(await rows.ownerDisabled(`${prefix}-gone`)).toBe(false);
    });

    test("D03: createOpenMuseFileRows reads the deletion marker beside the disable table", async () => {
      const rows = createOpenMuseFileRows(database);
      // Its own user id: the google-rows test above leaves `${prefix}-gone`
      // marked, and a shared id would fence this test's first assertion.
      expect(await rows.ownerDisabled(`${prefix}-gone-files`)).toBe(false);
      // The marker alone refuses, no disable row written.
      await store.delete(`${prefix}-gone-files`);
      expect(await rows.ownerDisabled(`${prefix}-gone-files`)).toBe(true);
      // D05: the marker half of the refusal lifts with the phase; the files
      // seam's own disable table is restoreOwner's to clear, not this read's.
      await store.restore(
        `${prefix}-gone-files`,
        new Date("2026-11-13T00:00:00Z"),
      );
      expect(await rows.ownerDisabled(`${prefix}-gone-files`)).toBe(false);
    });
  },
);

/*
 * D02 (§9 work shutdown): the delete route runs the shutdown AFTER the
 * marker — the fence is live the moment the row exists, the shutdown is the
 * convergence work behind it. The transition ids land in the marker's
 * resources (bookkeeping only), the cancelled Tasks emit best-effort through
 * the T12 seam, and a repeat delete converges rather than re-transitions.
 */
describe("POST /delete work shutdown (D02)", () => {
  function shutdownApp(input: {
    cancelled?: string[];
    cancelRequested?: string[];
    reviewedCancelled?: string[];
    emitThrows?: boolean;
  }) {
    const calls: string[] = [];
    const recorded: Array<{ userId: string; transitions: string[] }> = [];
    const emitted: string[] = [];
    const shutdown = createOpenMuseWorkShutdown({
      tasks: {
        shutdownOwner: async (userId) => {
          // The marker must already be on: the fence precedes the shutdown.
          expect(markers.has(userId)).toBe(true);
          calls.push(`tasks:${userId}`);
          return {
            cancelled: input.cancelled ?? [],
            cancelRequested: input.cancelRequested ?? [],
          };
        },
      },
      reviewed: {
        cancelAwaiting: async (userId) => {
          calls.push(`reviewed:${userId}`);
          return input.reviewedCancelled ?? [];
        },
      },
      record: async (userId, transitions) => {
        calls.push(`record:${userId}`);
        recorded.push({ userId, transitions });
      },
      emit: async (event) => {
        emitted.push(event.taskId);
        if (input.emitThrows) throw new Error("notification store down");
      },
    });
    return { calls, recorded, emitted, shutdown };
  }

  function appForShutdown(shutdown: (userId: string) => Promise<unknown>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({
        requireUser,
        store,
        shutdownOwnerWork: shutdown,
      }),
    );
    return app;
  }

  test("runs the shutdown after the marker: tasks then reviewed, transitions recorded, cancelled tasks emitted", async () => {
    markers.clear();
    session = actorOne;
    const { calls, recorded, emitted, shutdown } = shutdownApp({
      cancelled: ["task-a", "task-b"],
      reviewedCancelled: ["ra-1"],
    });
    const response = await appForShutdown(shutdown).request(
      "/api/mobile/openmuse-account/delete",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(markers).toEqual(new Set([actorOne.id]));
    expect(calls).toEqual(["tasks:user-1", "reviewed:user-1", "record:user-1"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.transitions.slice().sort()).toEqual(
      [
        "openmuse-task:task-a:cancelled",
        "openmuse-task:task-b:cancelled",
        "openmuse-reviewed-action:ra-1:cancelled",
      ].sort(),
    );
    expect(emitted.slice().sort()).toEqual(["task-a", "task-b"]);
  });

  test("a Reviewed cancellation failure still records the landed Task transitions", async () => {
    // shutdownOwner's rows already landed cancelled; if the Reviewed half then
    // throws before the record, the retry sees an empty transitions list and
    // reports ok — the marker loses the evidence permanently.
    const recorded: string[][] = [];
    const partial = createOpenMuseWorkShutdown({
      tasks: {
        shutdownOwner: async () => ({
          cancelled: ["task-a"],
          cancelRequested: [],
        }),
      },
      reviewed: {
        cancelAwaiting: async () => {
          throw new Error("reviewed store down");
        },
      },
      record: async (_userId, transitions) => {
        recorded.push(transitions);
      },
    });

    await expect(partial("user-1")).rejects.toThrow(/reviewed store down/);
    expect(recorded).toEqual([["openmuse-task:task-a:cancelled"]]);
  });

  test("a record failure throws with the landed transitions carried, never silently ok on retry", async () => {
    markers.clear();
    markers.add("user-1");
    // The bookkeeping seam dies AFTER the rows landed cancelled: a retry
    // would find empty transitions (the status guards no longer match the
    // already-cancelled rows) and answer ok — masking both the failure and
    // the marker's missing evidence. The throw must carry the landed ids so
    // the failure is observable and a compensating append can replay them.
    const failing = createOpenMuseWorkShutdown({
      tasks: {
        shutdownOwner: async () => ({
          cancelled: ["task-a"],
          cancelRequested: [],
        }),
      },
      reviewed: { cancelAwaiting: async () => [] },
      record: async () => {
        throw new Error("marker row locked");
      },
    });
    await expect(failing("user-1")).rejects.toThrow(
      /1 shutdown transitions.*openmuse-task:task-a:cancelled.*marker row locked/,
    );
  });

  test("a running Task reports its flag transition and emits nothing until the sweep lands it", async () => {
    markers.clear();
    session = actorOne;
    const { recorded, emitted, shutdown } = shutdownApp({
      cancelRequested: ["task-running"],
    });
    const response = await appForShutdown(shutdown).request(
      "/api/mobile/openmuse-account/delete",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(recorded[0]?.transitions).toEqual([
      "openmuse-task:task-running:cancel-requested",
    ]);
    // The public status is still running — no "cancelled" notification lies.
    expect(emitted).toEqual([]);
  });

  test("a throwing emit is non-fatal: the delete answers, the transitions still record", async () => {
    markers.clear();
    session = actorOne;
    const { recorded, shutdown } = shutdownApp({
      cancelled: ["task-a"],
      emitThrows: true,
    });
    const response = await appForShutdown(shutdown).request(
      "/api/mobile/openmuse-account/delete",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(recorded[0]?.transitions).toEqual([
      "openmuse-task:task-a:cancelled",
    ]);
  });

  test("fence remains first: with the shutdown wired, a marked owner's families still refuse before any handler", async () => {
    markers.clear();
    markers.add(actorOne.id);
    session = actorOne;
    const { shutdown } = shutdownApp({});
    const app = appForShutdown(shutdown);
    app.use(
      "/api/mobile/*",
      openMuseAccountFence({ requireUser, isDisabled: store.isDisabled }),
    );
    app.route(
      "/api/mobile/openmuse-mail",
      familyApp("/api/mobile/openmuse-mail"),
    );
    const response = await app.request("/api/mobile/openmuse-mail");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code: OPENMUSE_ACCOUNT_DISABLED_CODE,
    });
    expect(handled).toEqual(new Set());
  });
});

/*
 * D03 (§9 external access revocation): the delete route runs the revocation
 * AFTER D02's shutdown — every Google connection seat is withdrawn at the
 * vendor BEST-EFFORT (one alias's failure records retryable and never blocks
 * the delete), the local rows land revoked, a late OAuth callback for a
 * deleted owner never completes, and the File byte path is refused at the
 * store level beside the fence (defense in depth). The connector rows below
 * wire `ownerDisabled` straight to the markers set, which is the injection
 * the drizzle row factories gain in this ticket.
 */
describe("external access revocation at deletion (D03)", () => {
  /** In-memory connector rows: ownerDisabled reads the deletion markers. */
  function connectorRows(): OpenMuseGoogleRows & {
    pendings: StoredOpenMusePending[];
    connections: StoredOpenMuseGoogleConnection[];
  } {
    const pendings: StoredOpenMusePending[] = [];
    const connections: StoredOpenMuseGoogleConnection[] = [];
    return {
      pendings,
      connections,
      insertPending: async (pending) => {
        pendings.push({ ...pending });
      },
      getPending: async (state) =>
        pendings.find((row) => row.state === state) ?? null,
      consumePending: async (state, consumedAt) => {
        const row = pendings.find((candidate) => candidate.state === state);
        if (!row || row.consumedAt !== null) return false;
        row.consumedAt = consumedAt;
        return true;
      },
      recordOutcome: async (state, outcome) => {
        const row = pendings.find((candidate) => candidate.state === state);
        if (!row) throw new Error(`no pending row for ${state}`);
        row.outcome = "completed";
        row.connectionId = outcome.connectionId;
      },
      sweepExpired: async () => 0,
      getConnectionById: async (id) =>
        connections.find((row) => row.id === id) ?? null,
      getConnection: async (userId, provider) =>
        connections.find(
          (row) => row.userId === userId && row.provider === provider,
        ) ?? null,
      overwriteConnection: async (connection) => {
        const existing = connections.find(
          (row) =>
            row.userId === connection.userId &&
            row.provider === connection.provider,
        );
        if (!existing) {
          throw new Error(`no connection row for ${connection.provider}`);
        }
        Object.assign(existing, connection);
      },
      saveConnection: async (connection) => {
        const existing = connections.find(
          (row) =>
            row.userId === connection.userId &&
            row.provider === connection.provider,
        );
        if (existing) {
          Object.assign(existing, connection, {
            id: existing.id,
            generation: existing.generation + 1,
          });
          return;
        }
        connections.push({ ...connection });
      },
      listIdsByOwner: async (userId) =>
        connections
          .filter((row) => row.userId === userId)
          .map((row) => ({ id: row.id, provider: row.provider })),
      hardDeleteConnection: async (userId, connectionId) => {
        const index = connections.findIndex(
          (row) => row.userId === userId && row.id === connectionId,
        );
        if (index >= 0) connections.splice(index, 1);
      },
      ownerDisabled: async (userId) => markers.has(userId),
      disableOwner: async (userId) => {
        markers.add(userId);
      },
      restoreOwner: async (userId) => {
        markers.delete(userId);
      },
    };
  }

  /**
   * The vendor dial D03 needs: the delete-by-alias seam (with per-service
   * refusal) and the exchange, every call recorded so a refusal can prove
   * nothing dialed.
   */
  function revocationVendor() {
    const calls: Array<{ method: string; path: string }> = [];
    const refused = new Set<string>();
    const dial: OAuthWireDial = async (path, init) => {
      calls.push({ method: init.method, path });
      const url = new URL(path, "http://openconnector.test");
      if (
        init.method === "DELETE" &&
        url.pathname.startsWith("/api/connections/")
      ) {
        const service = decodeURIComponent(
          url.pathname.slice("/api/connections/".length),
        );
        if (refused.has(service)) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ message: "the withdrawal was refused" }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      if (url.pathname === "/oauth/callback") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ connected: true }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "unexpected vendor call" }),
      };
    };
    return {
      calls,
      dial,
      refuseDeletesFor: (service: string) => refused.add(service),
      deleteCalls: () => calls.filter((call) => call.method === "DELETE"),
      exchangeCalls: () =>
        calls.filter((call) => call.path === "/oauth/callback"),
    };
  }

  /** One live seat, as a pre-deletion connect leaves it. */
  function connectedRow(
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): StoredOpenMuseGoogleConnection {
    return {
      id: `conn-${provider}`,
      userId,
      provider,
      accountEmail: "person@gmail.com",
      status: "connected",
      grantedScopes: [],
      generation: 1,
      alias: openmuseAlias(userId, provider),
      connectedAt: clock.now,
      lastError: null,
    };
  }

  function connectorService(rows: ReturnType<typeof connectorRows>) {
    const vendor = revocationVendor();
    const service = createOpenMuseGoogleOAuth({
      client: buildOpenConnectorOAuthClient({ dial: vendor.dial }),
      rows,
      // The frozen clock keeps the seeded consent inside its TTL regardless
      // of when the suite runs.
      now: () => clock.now,
    });
    return { service, vendor };
  }

  /** The delete route with D02's shutdown and D03's revocation both wired. */
  function revokingApp(input: {
    connectors: OpenMuseGoogleOAuth;
    calls: string[];
    recorded: Array<{ userId: string; entries: string[] }>;
  }) {
    const shutdown = createOpenMuseWorkShutdown({
      tasks: {
        shutdownOwner: async (userId) => {
          input.calls.push(`shutdown:${userId}`);
          return { cancelled: [], cancelRequested: [] };
        },
      },
      reviewed: { cancelAwaiting: async () => [] },
    });
    const revoke = createOpenMuseExternalAccessRevoker({
      connectors: input.connectors,
      record: async (userId, entries) => {
        input.calls.push(`revoke:${userId}`);
        input.recorded.push({ userId, entries });
      },
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({
        requireUser,
        store,
        shutdownOwnerWork: shutdown,
        revokeExternalAccess: revoke,
      }),
    );
    return app;
  }

  test("revokes every seat at the vendor after the shutdown, lands the rows revoked, records the marker entries", async () => {
    markers.clear();
    session = actorOne;
    const rows = connectorRows();
    rows.connections.push(
      connectedRow(actorOne.id, "gmail"),
      connectedRow(actorOne.id, "googlecalendar"),
    );
    const { service, vendor } = connectorService(rows);
    const calls: string[] = [];
    const recorded: Array<{ userId: string; entries: string[] }> = [];
    const response = await revokingApp({
      connectors: service,
      calls,
      recorded,
    }).request("/api/mobile/openmuse-account/delete", { method: "POST" });
    expect(response.status).toBe(200);
    // The revocation runs after D02's shutdown, behind the marker.
    expect(calls).toEqual(["shutdown:user-1", "revoke:user-1"]);
    // The vendor lost exactly each alias, once, gmail first (catalog order).
    expect(vendor.deleteCalls()).toEqual([
      {
        method: "DELETE",
        path: `/api/connections/gmail?connectionName=${openmuseAlias(actorOne.id, "gmail")}`,
      },
      {
        method: "DELETE",
        path: `/api/connections/googlecalendar?connectionName=${openmuseAlias(actorOne.id, "googlecalendar")}`,
      },
    ]);
    // Every local row landed revoked.
    expect(rows.connections.map((row) => [row.provider, row.status])).toEqual([
      ["gmail", "revoked"],
      ["googlecalendar", "revoked"],
    ]);
    // §9: the revoke rows are enumerated in the marker's resources.
    expect(recorded).toEqual([
      {
        userId: actorOne.id,
        entries: [
          "openmuse-google-connection:conn-gmail:revoked",
          "openmuse-google-calendar-connection:conn-googlecalendar:revoked",
        ],
      },
    ]);
  });

  test("a vendor failure on one seat never blocks the delete: retryable recorded, the other proceeds", async () => {
    markers.clear();
    session = actorOne;
    const rows = connectorRows();
    rows.connections.push(
      connectedRow(actorOne.id, "gmail"),
      connectedRow(actorOne.id, "googlecalendar"),
    );
    const { service, vendor } = connectorService(rows);
    vendor.refuseDeletesFor("gmail");
    const calls: string[] = [];
    const recorded: Array<{ userId: string; entries: string[] }> = [];
    const response = await revokingApp({
      connectors: service,
      calls,
      recorded,
    }).request("/api/mobile/openmuse-account/delete", { method: "POST" });
    // Best-effort: the delete still succeeds with the marker on.
    expect(response.status).toBe(200);
    expect(markers).toEqual(new Set([actorOne.id]));
    // Both seats were attempted.
    expect(vendor.deleteCalls()).toHaveLength(2);
    // The refused seat stays exactly as it was (retryable); the other revoked.
    expect(rows.connections.map((row) => [row.provider, row.status])).toEqual([
      ["gmail", "connected"],
      ["googlecalendar", "revoked"],
    ]);
    expect(recorded[0]?.entries.slice().sort()).toEqual(
      [
        "openmuse-google-connection:conn-gmail:retryable",
        "openmuse-google-calendar-connection:conn-googlecalendar:revoked",
      ].sort(),
    );
  });

  test("post-delete provider surfaces: the fence re-refuses 403, a revoked seat answers the 409-class refusal", async () => {
    markers.clear();
    markers.add(actorOne.id);
    session = actorOne;
    const rows = connectorRows();
    rows.connections.push({
      ...connectedRow(actorOne.id, "gmail"),
      status: "revoked",
    });
    const { service, vendor } = connectorService(rows);
    // (a) the fence: a real provider surface behind /api/mobile refuses
    // before its handler, with the stable code.
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({ requireUser, store }),
    );
    app.use(
      "/api/mobile/*",
      openMuseAccountFence({ requireUser, isDisabled: store.isDisabled }),
    );
    app.route(
      "/api/mobile/openmuse-google",
      createOpenMuseGoogleRoutes({ service, requireUser }),
    );
    app.route(
      "/api/mobile/openmuse-mail",
      familyApp("/api/mobile/openmuse-mail"),
    );
    const fenced = await app.request("/api/mobile/openmuse-google");
    expect(fenced.status).toBe(403);
    expect(await fenced.json()).toEqual({
      error: expect.any(String),
      code: OPENMUSE_ACCOUNT_DISABLED_CODE,
    });
    expect(handled).toEqual(new Set());
    // (b) the seam the Mail/Calendar routes borrow: a revoked seat refuses
    // the stable 409 before any vendor dial — even without the fence.
    await expect(
      service.requireConnection(actorOne.id, "gmail"),
    ).rejects.toMatchObject({
      name: "OpenMuseConnectionRefusedError",
      status: 409,
    });
    await expect(
      service.runProviderCall(actorOne.id, "gmail", async () => {
        throw new Error("a revoked seat never dials");
      }),
    ).rejects.toBeInstanceOf(OpenMuseConnectionRefusedError);
    expect(vendor.calls).toEqual([]);
  });

  test("a late OAuth callback for a deleted owner is refused: no exchange, no connection row", async () => {
    markers.clear();
    session = actorOne;
    const rows = connectorRows();
    rows.pendings.push({
      state: "state-late",
      userId: actorOne.id,
      provider: "gmail",
      scopes: [],
      returnUri: "openmuse://consent-done",
      createdAt: clock.now,
      expiresAt: new Date(clock.now.getTime() + 10 * 60 * 1000),
      consumedAt: null,
      nonce: "nonce-late",
      outcome: null,
      connectionId: null,
    });
    const { service, vendor } = connectorService(rows);
    // The deletion lands while the consent is in flight.
    markers.add(actorOne.id);
    await expect(
      service.callback({
        actorId: actorOne.id,
        code: "code-late",
        state: "state-late",
        nonce: "nonce-late",
      }),
    ).rejects.toMatchObject({
      name: "OpenMuseGoogleCallbackError",
      status: 403,
    });
    // Nothing was exchanged, nothing was recorded, nothing was restored.
    expect(vendor.exchangeCalls()).toEqual([]);
    expect(rows.connections).toEqual([]);
    expect(rows.pendings[0]?.consumedAt).toBe(null);
  });

  test("file bytes: the fence re-refuses, the store guard throws, the bytes survive", async () => {
    markers.clear();
    session = actorOne;
    const rows = deletionFileRows();
    const bytes = deletionByteStore();
    const files = createOpenMuseFileStore({ rows, byteStore: bytes });
    const uploaded = await files.upload({
      ownerUserId: actorOne.id,
      name: "evidence.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      idempotencyKey: null,
    });
    // The deletion lands.
    markers.add(actorOne.id);
    // The fence refuses the byte route before its handler.
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({ requireUser, store }),
    );
    app.use(
      "/api/mobile/*",
      openMuseAccountFence({ requireUser, isDisabled: store.isDisabled }),
    );
    app.route(
      "/api/mobile/openmuse-files",
      createOpenMuseFilesRoutes({ store: files, requireUser }),
    );
    const fenced = await app.request(
      `/api/mobile/openmuse-files/${uploaded.file.id}/content`,
    );
    expect(fenced.status).toBe(403);
    expect(await fenced.json()).toEqual({
      error: expect.any(String),
      code: OPENMUSE_ACCOUNT_DISABLED_CODE,
    });
    // Defense in depth: the store guard refuses even called directly, while
    // the bytes physically survive for D06's purge.
    await expect(
      files.getOwnedFile(actorOne.id, uploaded.file.id),
    ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);
    expect(bytes.data.size).toBe(1);
  });
});

/**
 * In-memory file rows: ownerDisabled reads the deletion markers (D03's
 * injection). D06: `versions` is exposed and `hardDeleteFile` records into
 * the shared event log, so bytes-before-metadata ordering is provable.
 */
function deletionFileRows(events?: string[]): OpenMuseFileRows & {
  files: StoredOpenMuseFile[];
  versions: StoredOpenMuseFileVersion[];
} {
  const files: StoredOpenMuseFile[] = [];
  const versions: StoredOpenMuseFileVersion[] = [];
  return {
    files,
    versions,
    sumBytesByOwner: async (ownerUserId) =>
      files
        .filter(
          (row) => row.ownerUserId === ownerUserId && row.deletedAt === null,
        )
        .reduce((total, row) => total + row.size, 0),
    insertFileWithVersion: async (file, version) => {
      files.push({ ...file });
      versions.push({ ...version });
    },
    insertFile: async (file) => {
      files.push({ ...file });
    },
    findFileByIdempotencyKey: async (ownerUserId, key) =>
      files.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.idempotencyKey === key &&
          row.deletedAt === null,
      ) ?? null,
    findOwnedFile: async (ownerUserId, id) =>
      files.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.id === id &&
          row.deletedAt === null,
      ) ?? null,
    renameFile: async (ownerUserId, id, name) => {
      const row = files.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId &&
          candidate.id === id &&
          candidate.deletedAt === null,
      );
      if (row === undefined) return null;
      row.name = name;
      return { ...row };
    },
    tombstoneFile: async (ownerUserId, id) => {
      const row = files.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId &&
          candidate.id === id &&
          candidate.deletedAt === null,
      );
      if (row === undefined) return false;
      row.deletedAt = new Date();
      return true;
    },
    insertVersion: async (version) => {
      versions.push({ ...version });
    },
    latestVersion: async (fileId) =>
      versions.find((version) => version.fileId === fileId) ?? null,
    listByOwner: async (ownerUserId, options) =>
      files
        .filter(
          (row) => row.ownerUserId === ownerUserId && row.deletedAt === null,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, options.limit),
    ownerDisabled: async (ownerUserId) => markers.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      markers.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      markers.delete(ownerUserId);
    },
    versionsByOwner: async (ownerUserId) =>
      versions.filter((version) =>
        files.some(
          (row) => row.id === version.fileId && row.ownerUserId === ownerUserId,
        ),
      ),
    hardDeleteFile: async (ownerUserId, fileId) => {
      // D06's post-restoreUntil seam: only the owner's own file row and its
      // versions leave — a foreign id deletes nothing, like the drizzle rows.
      if (
        !files.some(
          (row) => row.ownerUserId === ownerUserId && row.id === fileId,
        )
      )
        return;
      events?.push(`rows:${ownerUserId}/${fileId}`);
      for (let index = versions.length - 1; index >= 0; index -= 1) {
        if (versions[index]?.fileId === fileId) versions.splice(index, 1);
      }
      files.splice(
        files.findIndex(
          (row) => row.ownerUserId === ownerUserId && row.id === fileId,
        ),
        1,
      );
    },
  };
}

/**
 * In-memory byte store; the data map is the physical evidence D06 purges.
 * D06: `calls` counts every delete attempt (idempotency), `failures`
 * injects a byte-store refusal (F-PURGE-1), and successful deletes record
 * into the shared event log for the ordering proof.
 */
function deletionByteStore(events?: string[]): FileByteStore & {
  data: Map<string, Uint8Array>;
  calls: string[];
  failures: Set<string>;
} {
  const data = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const failures = new Set<string>();
  return {
    data,
    calls,
    failures,
    put: async (key, bytes) => {
      data.set(key, bytes);
    },
    get: async (key) => data.get(key) ?? null,
    delete: async (key) => {
      calls.push(key);
      if (failures.has(key)) {
        throw new Error(`byte store refused to delete ${key}`);
      }
      data.delete(key);
      events?.push(`bytes:${key}`);
    },
  };
}

/*
 * D04 (§9 resource manifest): BEFORE any metadata removal, the delete flow
 * records every owner resource as {kind,id,externalKey?,state} rows —
 * Bot/computer, Channel/Thread, Task/Monitor, Reviewed actions, Goals/Ideas/
 * Memories, notifications, File byte-store keys, connector aliases and the
 * marker itself — all `pending`, external keys enumerated before any
 * relational deletion, gaps recorded as explicit rows rather than omissions,
 * and a repeat delete rebuilding only missing rows. Cleanup execution itself
 * is D06/D07/D08's; the manifest is this ticket's deliverable.
 */
describe("deletion resource manifest (D04)", () => {
  /**
   * In-memory manifest rows, mirroring the drizzle seam's insert-once and
   * stay-deleted semantics. `insertSnapshots` records the deletion log as it
   * stood at each write, so a test can prove enumeration precedes deletion.
   */
  function manifestRows(deletions?: string[]): {
    rows: import("../src/openmuse-deletion/store").OpenMuseDeletionResourceRows;
    table: Map<string, StoredOpenMuseDeletionResource>;
    insertSnapshots: string[][];
    keyOf: (
      manifestId: string,
      kind: string,
      id: string,
      externalKey?: string,
    ) => string;
    drop: (
      manifestId: string,
      kind: string,
      id: string,
      externalKey?: string,
    ) => void;
  } {
    const table = new Map<string, StoredOpenMuseDeletionResource>();
    const insertSnapshots: string[][] = [];
    const keyOf = (manifestId, kind, id, externalKey) =>
      [manifestId, kind, id, externalKey ?? ""].join("\u0000");
    return {
      table,
      insertSnapshots,
      keyOf,
      drop: (manifestId, kind, id, externalKey) => {
        table.delete(keyOf(manifestId, kind, id, externalKey));
      },
      rows: {
        insertResources: async (manifestId, resources) => {
          insertSnapshots.push([...(deletions ?? [])]);
          for (const resource of resources) {
            const key = keyOf(
              manifestId,
              resource.kind,
              resource.id,
              resource.externalKey,
            );
            if (table.has(key)) continue;
            table.set(key, {
              manifestId,
              kind: resource.kind,
              id: resource.id,
              externalKey: resource.externalKey ?? "",
              state: resource.state ?? "pending",
              lastError: resource.lastError ?? null,
              updatedAt: clock.now,
            });
          }
        },
        listResources: async (manifestId) =>
          [...table.values()]
            .filter((row) => row.manifestId === manifestId)
            .sort((a, b) =>
              [a.kind, a.id, a.externalKey]
                .join("\u0000")
                .localeCompare([b.kind, b.id, b.externalKey].join("\u0000")),
            ),
        markDeleted: async (manifestId, kind, id, externalKey) => {
          const row = table.get(keyOf(manifestId, kind, id, externalKey));
          if (row && row.state !== "deleted") {
            row.state = "deleted";
            row.lastError = null;
          }
        },
        markRetryable: async (manifestId, kind, id, lastError, externalKey) => {
          const row = table.get(keyOf(manifestId, kind, id, externalKey));
          if (row && row.state !== "deleted") {
            row.state = "retryable_error";
            row.lastError = lastError;
          }
        },
        resolveGaps: async (manifestId, kinds) => {
          for (const [key, row] of table) {
            if (
              row.manifestId === manifestId &&
              row.id === MODULE_GAP &&
              kinds.includes(row.kind)
            ) {
              table.delete(key);
            }
          }
        },
      },
    };
  }

  /**
   * The two-user seeded world: every §9 module as a fake whose enumeration
   * reads its rows and whose deletion hooks push to the shared log — the
   * deletion-counting fake that proves manifest time deletes nothing.
   */
  function deletionWorld() {
    const deletions: string[] = [];
    const fileVersions = [
      {
        ownerUserId: actorOne.id,
        fileId: "file-1",
        bytePath: "openmuse-files/user-1/file-1/v1",
      },
      {
        ownerUserId: actorOne.id,
        fileId: "file-1",
        bytePath: "openmuse-files/user-1/file-1/v2",
      },
      {
        ownerUserId: actorTwo.id,
        fileId: "file-2",
        bytePath: "openmuse-files/user-2/file-2/v1",
      },
    ];
    const tasks = [
      { ownerUserId: actorOne.id, id: "task-1" },
      { ownerUserId: actorOne.id, id: "monitor-1" },
      { ownerUserId: actorTwo.id, id: "task-2" },
    ];
    const reviewed = [
      { ownerUserId: actorOne.id, id: "reviewed-1" },
      { ownerUserId: actorTwo.id, id: "reviewed-2" },
    ];
    const goals = [
      { ownerUserId: actorOne.id, id: "goal-1" },
      { ownerUserId: actorTwo.id, id: "goal-2" },
    ];
    const ideas = [
      { ownerUserId: actorOne.id, id: "idea-1" },
      { ownerUserId: actorTwo.id, id: "idea-2" },
    ];
    const memories = [
      { ownerUserId: actorOne.id, id: "memory-1" },
      { ownerUserId: actorTwo.id, id: "memory-2" },
    ];
    const notifications = [
      { userId: actorOne.id, id: "notification-1" },
      { userId: actorTwo.id, id: "notification-2" },
    ];
    const connections = [
      { userId: actorOne.id, id: "conn-gmail", provider: "gmail" as const },
      {
        userId: actorOne.id,
        id: "conn-cal",
        provider: "googlecalendar" as const,
      },
      { userId: actorTwo.id, id: "conn-2", provider: "gmail" as const },
    ];
    const bots = [
      {
        owner: actorOne.id,
        id: "bot-1",
        hidden: false,
        deleted: false,
        isPublic: false,
      },
      {
        owner: actorOne.id,
        id: "bot-hidden-1",
        hidden: true,
        deleted: false,
        isPublic: false,
      },
      // The owner's soft-deleted Bot: list can never see it, hardDelete
      // still removes it — the under-capture half of the agentResources fix.
      {
        owner: actorOne.id,
        id: "bot-deleted-1",
        hidden: false,
        deleted: true,
        isPublic: false,
      },
      // A foreign PUBLIC Bot: list sees it under role "user", hardDelete
      // never removes it — the over-capture half.
      {
        owner: actorTwo.id,
        id: "bot-2",
        hidden: false,
        deleted: false,
        isPublic: true,
      },
    ];
    const channels = [
      {
        owner: actorOne.id,
        id: "chan-1",
        threadId: "thread-1",
        archived: false,
      },
      {
        owner: actorOne.id,
        id: "chan-page2",
        threadId: "thread-2",
        archived: false,
      },
      {
        owner: actorOne.id,
        id: "chan-archived",
        threadId: "thread-3",
        archived: true,
      },
      // §9: a soft-deleted channel still owes its rows to the deletion — the
      // roster's `list` hides it, the manifest's enumerateOwner names it.
      {
        owner: actorOne.id,
        id: "chan-deleted",
        threadId: "thread-5",
        archived: false,
        deleted: true,
      },
      {
        owner: actorTwo.id,
        id: "chan-2",
        threadId: "thread-4",
        archived: false,
      },
    ];
    return {
      deletions,
      files: {
        enumerateOwner: async (ownerUserId: string) =>
          fileVersions
            .filter((version) => version.ownerUserId === ownerUserId)
            .map((version) => ({
              kind: "openmuse-file" as const,
              id: version.fileId,
              externalKey: version.bytePath,
            })),
        purgeOwnerBytes: async (ownerUserId: string) => {
          deletions.push(`files:${ownerUserId}`);
        },
      },
      tasks: {
        enumerateOwner: async (ownerUserId: string) =>
          tasks
            .filter((task) => task.ownerUserId === ownerUserId)
            .map((task) => ({ kind: "openmuse-task" as const, id: task.id })),
        deleteOwnerTasks: async (ownerUserId: string) => {
          deletions.push(`tasks:${ownerUserId}`);
        },
      },
      reviewed: {
        enumerateOwner: async (ownerUserId: string) =>
          reviewed
            .filter((action) => action.ownerUserId === ownerUserId)
            .map((action) => ({
              kind: "openmuse-reviewed-action" as const,
              id: action.id,
            })),
        purgeOwner: async (ownerUserId: string) => {
          deletions.push(`reviewed:${ownerUserId}`);
        },
      },
      goals: {
        enumerateOwner: async (ownerUserId: string) =>
          goals
            .filter((goal) => goal.ownerUserId === ownerUserId)
            .map((goal) => ({ kind: "openmuse-goal" as const, id: goal.id })),
        purgeOwner: async (ownerUserId: string) => {
          deletions.push(`goals:${ownerUserId}`);
        },
      },
      ideas: {
        enumerateOwner: async (ownerUserId: string) =>
          ideas
            .filter((idea) => idea.ownerUserId === ownerUserId)
            .map((idea) => ({ kind: "openmuse-idea" as const, id: idea.id })),
        purgeOwner: async (ownerUserId: string) => {
          deletions.push(`ideas:${ownerUserId}`);
        },
      },
      memories: {
        enumerateOwner: async (ownerUserId: string) =>
          memories
            .filter((memory) => memory.ownerUserId === ownerUserId)
            .map((memory) => ({
              kind: "openmuse-memory" as const,
              id: memory.id,
            })),
        purgeOwner: async (ownerUserId: string) => {
          deletions.push(`memories:${ownerUserId}`);
        },
      },
      notifications: {
        enumerateOwner: async (userId: string) =>
          notifications
            .filter((notification) => notification.userId === userId)
            .map((notification) => ({
              kind: "openmuse-notification" as const,
              id: notification.id,
            })),
        purgeOwner: async (userId: string) => {
          deletions.push(`notifications:${userId}`);
        },
      },
      connectors: {
        enumerateOwner: async (userId: string) =>
          connections
            .filter((connection) => connection.userId === userId)
            .map((connection) => ({
              kind:
                connection.provider === "googlecalendar"
                  ? ("openmuse-google-calendar-connection" as const)
                  : ("openmuse-google-connection" as const),
              id: connection.id,
            })),
        revokeOwner: async () => [],
      },
      agents: {
        // Mirrors profile-store.list's REAL semantics under role "user":
        // foreign public Bots are visible, soft-deleted ones are not —
        // exactly the two directions in which list deviates from
        // owner-scoped hardDelete, kept here so the manifest cannot
        // enumerate through it honestly.
        list: async (
          actor: { id: string; role: "admin" | "user" },
          hidden = false,
        ) =>
          bots
            .filter(
              (bot) =>
                !bot.deleted &&
                (bot.owner === actor.id || bot.isPublic) &&
                bot.hidden === hidden,
            )
            .map((bot) => ({ id: bot.id })),
        // The §9 seam the manifest reads instead: owner-scoped exactly as
        // hardDelete removes — soft-deleted included, foreign never.
        enumerateOwner: async (ownerUserId: string) =>
          bots
            .filter((bot) => bot.owner === ownerUserId)
            .map((bot) => ({ kind: "openmuse-bot" as const, id: bot.id })),
        deleteOwnerBots: async (userId: string) => {
          deletions.push(`bots:${userId}`);
        },
      },
      channels: {
        // The §9 seam the manifest reads: owner-scoped, soft-deleted
        // included — the roster `list`'s partitions and cursor are not here.
        enumerateOwner: async (ownerUserId: string) =>
          channels
            .filter((channel) => channel.owner === ownerUserId)
            .map((channel) => ({ id: channel.id })),
        hideAllForOwner: async (userId: string) => {
          deletions.push(`channels:${userId}`);
        },
      },
    };
  }

  /** The §9 rows user 1's manifest must carry, as comparable keys. */
  function manifestKeys(resources: OpenMuseDeletionManifestResource[]) {
    return resources
      .map((resource) =>
        [
          resource.kind,
          resource.id,
          resource.externalKey ?? "",
          resource.state,
          resource.lastError ?? "",
        ].join("\u0000"),
      )
      .sort();
  }

  function expectedUserOneKeys() {
    return manifestKeys([
      {
        kind: "openmuse-account-deletion",
        id: actorOne.id,
        externalKey: actorOne.id,
        state: "pending",
      },
      {
        kind: "openmuse-file",
        id: "file-1",
        externalKey: "openmuse-files/user-1/file-1/v1",
        state: "pending",
      },
      {
        kind: "openmuse-file",
        id: "file-1",
        externalKey: "openmuse-files/user-1/file-1/v2",
        state: "pending",
      },
      { kind: "openmuse-task", id: "task-1", state: "pending" },
      { kind: "openmuse-task", id: "monitor-1", state: "pending" },
      { kind: "openmuse-reviewed-action", id: "reviewed-1", state: "pending" },
      { kind: "openmuse-goal", id: "goal-1", state: "pending" },
      { kind: "openmuse-idea", id: "idea-1", state: "pending" },
      { kind: "openmuse-memory", id: "memory-1", state: "pending" },
      { kind: "openmuse-notification", id: "notification-1", state: "pending" },
      {
        kind: "openmuse-google-connection",
        id: "conn-gmail",
        externalKey: openmuseAlias(actorOne.id, "gmail"),
        state: "pending",
      },
      {
        kind: "openmuse-google-calendar-connection",
        id: "conn-cal",
        externalKey: openmuseAlias(actorOne.id, "googlecalendar"),
        state: "pending",
      },
      { kind: "openmuse-bot", id: "bot-1", state: "pending" },
      { kind: "openmuse-bot", id: "bot-deleted-1", state: "pending" },
      { kind: "openmuse-bot", id: "bot-hidden-1", state: "pending" },
      { kind: "openmuse-channel", id: "chan-1", state: "pending" },
      { kind: "openmuse-channel", id: "chan-page2", state: "pending" },
      { kind: "openmuse-channel", id: "chan-archived", state: "pending" },
      { kind: "openmuse-channel", id: "chan-deleted", state: "pending" },
    ]);
  }

  function manifestApp(
    world: ReturnType<typeof deletionWorld>,
    rows: import("../src/openmuse-deletion/store").OpenMuseDeletionResourceRows,
  ) {
    const manifest = createOpenMuseDeletionManifest({
      rows,
      marker: store,
      files: world.files,
      tasks: world.tasks,
      reviewed: world.reviewed,
      goals: world.goals,
      ideas: world.ideas,
      memories: world.memories,
      notifications: world.notifications,
      connectors: world.connectors,
      agents: world.agents,
      channels: world.channels,
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({
        requireUser,
        store,
        buildManifest: manifest.buildManifest,
      }),
    );
    return app;
  }

  test("records every owner resource with correct kinds and external keys, before any row deletion", async () => {
    markers.clear();
    session = actorOne;
    const world = deletionWorld();
    const manifestStore = manifestRows(world.deletions);
    const response = await manifestApp(world, manifestStore.rows).request(
      "/api/mobile/openmuse-account/delete",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletion: { userId: string; disabledAt: string };
      manifest: {
        userId: string;
        disabledAt: string;
        restoreUntil: string | null;
        phase: string;
        resources: OpenMuseDeletionManifestResource[];
      };
    };
    // The §9 shape: the manifest answers beside the marker, restoreUntil
    // carried from it (null until D05 opens the window).
    expect(body.manifest.userId).toBe(actorOne.id);
    expect(body.manifest.disabledAt).toBe(clock.now.toISOString());
    expect(body.manifest.restoreUntil).toBe(null);
    expect(body.manifest.phase).toBe("fenced");
    expect(manifestKeys(body.manifest.resources)).toEqual(
      expectedUserOneKeys(),
    );
    // Enumeration precedes deletion: no module row was deleted at manifest
    // time (each write saw an empty log) or after the whole route.
    for (const snapshot of manifestStore.insertSnapshots) {
      expect(snapshot).toEqual([]);
    }
    expect(world.deletions).toEqual([]);
  });

  test("a restored marker is answered, never re-enumerated: phase restored, no rows named or written", async () => {
    markers.clear();
    const world = deletionWorld();
    const manifestStore = manifestRows(world.deletions);
    markers.add(actorOne.id);
    const window = new Date(clock.now.getTime() + 30 * 86_400_000);
    await store.restore(actorOne.id, window);
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      goals: world.goals,
      ideas: world.ideas,
      memories: world.memories,
    });
    const answered = await manifest.buildManifest(actorOne.id);
    // The lifted marker answers its own phase and window — not an asserted
    // "fenced" — and names no rows: D05 deliberately keeps the stored ones.
    expect(answered.phase).toBe("restored");
    expect(answered.restoreUntil).toBe(window.toISOString());
    expect(answered.resources).toEqual([]);
    expect([...manifestStore.table.values()]).toEqual([]);
    expect(manifestStore.insertSnapshots).toEqual([]);
  });

  test("a fence lifted during the enumeration is answered, never asserted", async () => {
    markers.clear();
    restoredUntil.clear();
    markers.add(actorOne.id);
    const window = new Date(clock.now.getTime() + 30 * 86_400_000);
    // The marker is fenced when buildManifest checks on entry, and D05's
    // restore lands before the manifest re-reads it to answer: the answer
    // must name the lifted phase, never an asserted "fenced" over a live
    // account.
    let reads = 0;
    const liftingMarker = {
      get: async (userId: string) => {
        reads += 1;
        if (reads >= 2) await store.restore(userId, window);
        return store.get(userId);
      },
      enumerateOwner: store.enumerateOwner,
    };
    const manifestStore = manifestRows();
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: liftingMarker,
      files: { enumerateOwner: async () => [] },
    });
    const answered = await manifest.buildManifest(actorOne.id);
    expect(answered.phase).toBe("restored");
    expect(answered.restoreUntil).toBe(window.toISOString());
    expect(answered.resources).toEqual([]);
  });

  test("another user's resources never land in the manifest", async () => {
    markers.clear();
    session = actorOne;
    const world = deletionWorld();
    const manifestStore = manifestRows(world.deletions);
    const response = await manifestApp(world, manifestStore.rows).request(
      "/api/mobile/openmuse-account/delete",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      manifest: { resources: OpenMuseDeletionManifestResource[] };
    };
    const foreign = body.manifest.resources.filter(
      (resource) =>
        [
          "file-2",
          "task-2",
          "reviewed-2",
          "goal-2",
          "idea-2",
          "memory-2",
          "notification-2",
          "conn-2",
          "bot-2",
          "chan-2",
          actorTwo.id,
        ].includes(resource.id) ||
        resource.externalKey === openmuseAlias(actorTwo.id, "gmail"),
    );
    expect(foreign).toEqual([]);
  });

  test("agentResources enumerates exactly what hardDelete removes: the owner's soft-deleted Bots in, foreign public Bots out", async () => {
    markers.clear();
    session = actorOne;
    const world = deletionWorld();
    const manifestStore = manifestRows(world.deletions);
    const response = await manifestApp(world, manifestStore.rows).request(
      "/api/mobile/openmuse-account/delete",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      manifest: { resources: OpenMuseDeletionManifestResource[] };
    };
    // The owner-scoped hardDelete removes the owner's rows, soft-deleted or
    // not — their profile rows and vault keys survive account deletion
    // unless enumerated. list's visibility semantics deviate in BOTH
    // directions (foreign public visible, own soft-deleted hidden), so the
    // manifest must owe exactly and only what hardDelete can remove.
    expect(
      body.manifest.resources
        .filter((resource) => resource.kind === "openmuse-bot")
        .map((resource) => resource.id)
        .sort(),
    ).toEqual(["bot-1", "bot-deleted-1", "bot-hidden-1"]);
  });

  test("§9 shape: rows hang from the marker's manifestId and carry its restoreUntil", async () => {
    markers.clear();
    markers.add(actorOne.id);
    const restoreUntil = new Date("2026-11-12T00:00:00Z");
    const windowedMarker = {
      get: async (userId: string) =>
        markers.has(userId)
          ? {
              userId,
              disabledAt: clock.now,
              phase: "fenced" as const,
              restoreUntil,
              resources: [],
            }
          : null,
      enumerateOwner: async (userId: string) =>
        markers.has(userId)
          ? [
              {
                kind: "openmuse-account-deletion" as const,
                id: userId,
                externalKey: userId,
              },
            ]
          : [],
    };
    const world = deletionWorld();
    const manifestStore = manifestRows(world.deletions);
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: windowedMarker,
      files: world.files,
    });
    const built = await manifest.buildManifest(actorOne.id);
    expect(built.restoreUntil).toBe(restoreUntil.toISOString());
    expect(built.disabledAt).toBe(clock.now.toISOString());
    // The linkage: every row's manifestId is the marker's userId, and no
    // other user's manifest sees them.
    expect(manifestStore.table.size).toBeGreaterThan(0);
    expect(
      [...manifestStore.table.values()].every(
        (row) => row.manifestId === actorOne.id,
      ),
    ).toBe(true);
    expect(await manifestStore.rows.listResources(actorTwo.id)).toEqual([]);
  });

  test("a repeat delete rebuilds only missing rows and preserves existing states", async () => {
    markers.clear();
    session = actorOne;
    const world = deletionWorld();
    const manifestStore = manifestRows(world.deletions);
    const app = manifestApp(world, manifestStore.rows);
    const first = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(first.status).toBe(200);
    // D06's world between deletes: one resource landed deleted, one row was
    // dropped entirely (purged and pruned).
    await manifestStore.rows.markDeleted(
      actorOne.id,
      "openmuse-file",
      "file-1",
      "openmuse-files/user-1/file-1/v1",
    );
    manifestStore.drop(actorOne.id, "openmuse-channel", "chan-archived");
    const second = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      manifest: { resources: OpenMuseDeletionManifestResource[] };
    };
    const expected = expectedUserOneKeys().map((key) =>
      key ===
      [
        "openmuse-file",
        "file-1",
        "openmuse-files/user-1/file-1/v1",
        "pending",
        "",
      ].join("\u0000")
        ? key.replace("pending", "deleted")
        : key,
    );
    expect(manifestKeys(body.manifest.resources)).toEqual(expected);
    // Two builds, the same rows: nothing duplicated.
    expect(body.manifest.resources).toHaveLength(expectedUserOneKeys().length);
  });

  test("a module without an enumerable seam is an explicit gap row, never an omission", async () => {
    markers.clear();
    markers.add(actorOne.id);
    const world = deletionWorld();
    const manifestStore = manifestRows(world.deletions);
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      // Only files wired: every other seam is a deployment gap.
      files: world.files,
    });
    const built = await manifest.buildManifest(actorOne.id);
    const gaps = built.resources.filter(
      (resource) => resource.id === "<module-gap>",
    );
    expect(manifestKeys(gaps)).toEqual(
      manifestKeys(
        [
          "openmuse-task",
          "openmuse-reviewed-action",
          "openmuse-goal",
          "openmuse-idea",
          "openmuse-memory",
          "openmuse-notification",
          "openmuse-google-connection",
          "openmuse-google-calendar-connection",
          "openmuse-bot",
          "openmuse-channel",
        ].map((kind) => ({
          kind,
          id: "<module-gap>",
          state: "pending" as const,
          lastError: "enumeration seam missing — D04",
        })),
      ),
    );
  });

  test("a throwing seam records retryable, never silently omitting the module", async () => {
    markers.clear();
    markers.add(actorOne.id);
    const manifestStore = manifestRows();
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      tasks: {
        enumerateOwner: async () => {
          throw new Error("tasks table unreadable");
        },
      },
    });
    const built = await manifest.buildManifest(actorOne.id);
    expect(built.resources).toContainEqual({
      kind: "openmuse-task",
      id: "<module-gap>",
      state: "retryable_error",
      lastError: "enumeration failed: tasks table unreadable",
    });
  });

  test("a rebuild resolves a kind's gap rows: a recovered enumeration replaces the gap, a still-failing one refreshes it", async () => {
    markers.clear();
    markers.add(actorOne.id);
    const manifestStore = manifestRows();
    // One mutable files seam: unreadable first, recovered second, failing
    // again with a different reason third.
    let failure: Error | null = new Error("files table unreadable");
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      files: {
        enumerateOwner: async () => {
          if (failure) throw failure;
          return [
            {
              kind: "openmuse-file" as const,
              id: "file-1",
              externalKey: "openmuse-files/user-1/file-1/v1",
            },
          ];
        },
      },
    });
    await manifest.buildManifest(actorOne.id);
    const gapAfterFirst = (
      await manifestStore.rows.listResources(actorOne.id)
    ).find((row) => row.kind === "openmuse-file" && row.id === MODULE_GAP);
    expect(gapAfterFirst?.state).toBe("retryable_error");
    expect(gapAfterFirst?.lastError).toContain("files table unreadable");
    // The recovery: the seam answers, and the rebuild REPLACES the gap row
    // with the real one — insert-once alone never could, and an unresolved
    // gap would otherwise wedge D08's finalize forever.
    failure = null;
    await manifest.buildManifest(actorOne.id);
    const afterRecovery = await manifestStore.rows.listResources(actorOne.id);
    expect(
      afterRecovery.filter(
        (row) => row.id === MODULE_GAP && row.kind === "openmuse-file",
      ),
    ).toEqual([]);
    expect(
      afterRecovery.find(
        (row) => row.kind === "openmuse-file" && row.id === "file-1",
      ),
    ).toMatchObject({ state: "pending" });
    // A still-failing rebuild refreshes the gap's recorded reason — the row
    // never silently freezes at a stale error.
    failure = new Error("files table gone");
    await manifest.buildManifest(actorOne.id);
    const gapAfterThird = (
      await manifestStore.rows.listResources(actorOne.id)
    ).find((row) => row.kind === "openmuse-file" && row.id === MODULE_GAP);
    expect(gapAfterThird?.lastError).toContain("files table gone");
  });
});

/*
 * The manifest's own rows against a real PostgreSQL, gated the same way the
 * marker store above is: the insert-once, stay-deleted semantics the in-memory
 * fake mirrors are decided here, in SQL.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "openmuse deletion resource rows",
  () => {
    const database = createDatabase(testDatabaseUrl(), TEST_POOL);
    const rows = createOpenMuseDeletionResourceRows(database);
    const prefix = `delres-${randomUUID().slice(0, 8)}`;

    afterAll(async () => {
      await database
        .delete(openmuseDeletionResources)
        .where(like(openmuseDeletionResources.manifestId, `${prefix}%`));
      await database.$client.close();
    });

    test("insertResources is insert-once: a rebuild re-adds only missing rows and preserves states", async () => {
      const manifestId = `${prefix}-a`;
      await rows.insertResources(manifestId, [
        { kind: "openmuse-file", id: "file-1", externalKey: "bytes/v1" },
        { kind: "openmuse-file", id: "file-1", externalKey: "bytes/v2" },
        { kind: "openmuse-bot", id: "bot-1" },
      ]);
      await rows.markDeleted(manifestId, "openmuse-file", "file-1", "bytes/v1");
      // The re-delete rebuild: the same rows again plus one newly missing.
      await rows.insertResources(manifestId, [
        { kind: "openmuse-file", id: "file-1", externalKey: "bytes/v1" },
        { kind: "openmuse-file", id: "file-1", externalKey: "bytes/v2" },
        { kind: "openmuse-bot", id: "bot-1" },
        { kind: "openmuse-task", id: "task-1" },
      ]);
      const listed = await rows.listResources(manifestId);
      // One row per external key, no duplicates, the state preserved.
      expect(listed).toHaveLength(4);
      const byKey = new Map(
        listed.map((row) => [[row.id, row.externalKey].join(":"), row]),
      );
      expect(byKey.get("file-1:bytes/v1")?.state).toBe("deleted");
      expect(byKey.get("file-1:bytes/v2")?.state).toBe("pending");
      expect(byKey.get("bot-1:")?.state).toBe("pending");
      expect(byKey.get("task-1:")?.state).toBe("pending");
    });

    test("markDeleted is idempotent and terminal; markRetryable keeps the last error and never leaves deleted", async () => {
      const manifestId = `${prefix}-b`;
      await rows.insertResources(manifestId, [
        { kind: "openmuse-goal", id: "goal-a" },
        { kind: "openmuse-goal", id: "goal-b" },
      ]);
      await rows.markDeleted(manifestId, "openmuse-goal", "goal-a");
      // A repeat is a no-op.
      await rows.markDeleted(manifestId, "openmuse-goal", "goal-a");
      // Deleted is terminal: a late retryable never reopens it.
      await rows.markRetryable(
        manifestId,
        "openmuse-goal",
        "goal-a",
        "vendor refused",
      );
      await rows.markRetryable(
        manifestId,
        "openmuse-goal",
        "goal-b",
        "byte store down",
      );
      await rows.markRetryable(
        manifestId,
        "openmuse-goal",
        "goal-b",
        "byte store down again",
      );
      const listed = await rows.listResources(manifestId);
      const byId = new Map(listed.map((row) => [row.id, row]));
      expect(byId.get("goal-a")?.state).toBe("deleted");
      expect(byId.get("goal-a")?.lastError).toBe(null);
      expect(byId.get("goal-b")?.state).toBe("retryable_error");
      expect(byId.get("goal-b")?.lastError).toBe("byte store down again");
    });

    test("resolveGaps removes exactly the named kinds' gap rows, never a real row", async () => {
      const manifestId = `${prefix}-c`;
      await rows.insertResources(manifestId, [
        { kind: "openmuse-file", id: MODULE_GAP },
        { kind: "openmuse-task", id: MODULE_GAP },
        { kind: "openmuse-bot", id: "bot-1" },
      ]);
      await rows.markDeleted(manifestId, "openmuse-bot", "bot-1");
      await rows.resolveGaps(manifestId, ["openmuse-file"]);
      const listed = await rows.listResources(manifestId);
      expect(
        listed.map((row) => `${row.kind}:${row.id}:${row.state}`).sort(),
      ).toEqual([
        "openmuse-bot:bot-1:deleted",
        "openmuse-task:<module-gap>:pending",
      ]);
    });
  },
);

/*
 * D05 (§9 restoration): within 30 days an admin restore returns the
 * recoverable set READ-ONLY — the fence lifts and every family re-admits,
 * files and their bytes come back (D06 has not purged), notifications
 * return, cancelled work stays terminal (nothing resumes, the queue is
 * offered nothing), revoked connections stay revoked, and past the window
 * the answer is 410. The restore report enumerates the live-again,
 * read-only and not-restorable classes.
 */
describe("account restoration (D05)", () => {
  /** Day arithmetic off the fixture's T0. */
  const T0 = new Date("2026-10-13T00:00:00Z");
  const DAY_MS = 86_400_000;

  /** The cancelled Task history the restore must leave untouched. */
  const taskHistory = [{ id: "task-cancelled", status: "cancelled" }];

  /** The queue offers a resumed Task would produce — the restore must offer zero. */
  const queueOffers: string[] = [];

  /** The revoked connection rows the restore must leave revoked. */
  const connections = [
    { id: "conn-gmail", state: "revoked" },
    { id: "conn-googlecalendar", state: "revoked" },
  ];

  /** In-memory notification rows, the seam the drizzle rows implement. */
  function deletionNotificationRows(): OpenMuseNotificationRows & {
    rows: StoredOpenMuseNotification[];
  } {
    const rows: StoredOpenMuseNotification[] = [];
    const keyOf = (row: StoredOpenMuseNotification) =>
      [row.userId, row.taskId, row.eventKind, row.attemptKey].join(":");
    return {
      rows,
      insertNotification: async (row) => {
        if (rows.some((stored) => keyOf(stored) === keyOf(row))) return false;
        rows.push({ ...row });
        return true;
      },
      findNotificationByKey: async (userId, taskId, eventKind, attemptKey) =>
        rows.find(
          (stored) =>
            keyOf(stored) === [userId, taskId, eventKind, attemptKey].join(":"),
        ) ?? null,
      pageByOwner: async (userId, { limit }) =>
        rows
          .filter((row) => row.userId === userId)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              (a.id < b.id ? 1 : -1),
          )
          .slice(0, limit),
      listIdsByOwner: async (userId) =>
        rows.filter((row) => row.userId === userId).map((row) => row.id),
      getNotification: async (id) => rows.find((row) => row.id === id) ?? null,
      markNotificationRead: async (userId, id, at) => {
        const row = rows.find(
          (stored) => stored.id === id && stored.userId === userId,
        );
        if (!row) return null;
        row.readAt ??= at;
        return { ...row };
      },
      ownerDisabled: async (userId) => markers.has(userId),
      disableOwner: async (userId) => {
        markers.add(userId);
      },
      restoreOwner: async (userId) => {
        markers.delete(userId);
      },
    };
  }

  /**
   * The D05 world: the phase-capable fake store above, a real files store
   * over in-memory bytes, a real notifications store, and the restore
   * service whose module hooks (files/notifications restoreOwner — the §9
   * seams, emit-only) are wrapped to record their calls.
   */
  function restorationWorld() {
    markers.clear();
    restoredUntil.clear();
    session = actorOne;
    clock.now = T0;
    const files = createOpenMuseFileStore({
      rows: deletionFileRows(),
      byteStore: deletionByteStore(),
    });
    const notifications = createOpenMuseNotificationStore({
      rows: deletionNotificationRows(),
      now: () => clock.now,
    });
    const hookCalls: string[] = [];
    const restore = createOpenMuseDeletionRestore({
      marker: store,
      now: () => clock.now,
      files: {
        restoreOwner: async (userId) => {
          hookCalls.push(`files:${userId}`);
          await files.restoreOwner(userId);
        },
      },
      notifications: {
        restoreOwner: async (userId) => {
          hookCalls.push(`notifications:${userId}`);
          await notifications.restoreOwner(userId);
        },
      },
    });
    return { files, notifications, restore, hookCalls };
  }

  /**
   * The app.ts mount shape mirrored for restoration: the admin restore route
   * beside the delete route, the shared fence in front of every mobile
   * family, with the real files and notifications routes standing in for
   * those two families' fixtures.
   */
  function restorationApp(world: ReturnType<typeof restorationWorld>) {
    handled.clear();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/openmuse-deletion",
      createOpenMuseDeletionAdminRoutes({
        requireUser,
        restore: world.restore,
      }),
    );
    app.route(
      "/api/mobile/openmuse-account",
      createOpenMuseAccountDeletionRoutes({ requireUser, store }),
    );
    app.use(
      "/api/mobile/*",
      openMuseAccountFence({ requireUser, isDisabled: store.isDisabled }),
    );
    app.route(
      "/api/mobile/openmuse-files",
      createOpenMuseFilesRoutes({ store: world.files, requireUser }),
    );
    app.route(
      "/api/mobile/openmuse-notifications",
      createOpenMuseNotificationRoutes({
        store: world.notifications,
        requireUser,
      }),
    );
    for (const path of FAMILIES) {
      if (
        path === "/api/mobile/openmuse-files" ||
        path === "/api/mobile/openmuse-notifications"
      )
        continue;
      app.route(path, familyApp(path));
    }
    return app;
  }

  test("day-29 restore lifts the fence and returns the recoverable set read-only", async () => {
    const world = restorationWorld();
    const app = restorationApp(world);
    // Pre-deletion content: one file with bytes, one notification.
    const uploaded = await world.files.upload({
      ownerUserId: actorOne.id,
      name: "evidence.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      idempotencyKey: null,
    });
    await world.notifications.emit({
      userId: actorOne.id,
      taskId: "task-cancelled",
      eventKind: "task.failed",
      attemptKey: "run-1",
      title: "Task failed",
    });
    // The deletion lands at T0.
    const deleted = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(deleted.status).toBe(200);
    // Fenced: the family and the byte route refuse before any handler.
    expect((await app.request("/api/mobile/openmuse-goals")).status).toBe(403);
    expect(
      (
        await app.request(
          `/api/mobile/openmuse-files/${uploaded.file.id}/content`,
        )
      ).status,
    ).toBe(403);
    // Day 29: the administrator restores.
    session = actorAdmin;
    clock.now = new Date(T0.getTime() + 29 * DAY_MS);
    const restored = await app.request(
      "/api/admin/openmuse-deletion/user-1/restore",
      { method: "POST" },
    );
    expect(restored.status).toBe(200);
    // The fence re-admits every family.
    session = actorOne;
    for (const path of FAMILIES) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
    }
    // Files list/get return rows and the bytes survive untouched (pre-D06).
    const list = await app.request("/api/mobile/openmuse-files");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { files: Array<{ id: string }> };
    expect(listBody.files.map((file) => file.id)).toEqual([uploaded.file.id]);
    const content = await app.request(
      `/api/mobile/openmuse-files/${uploaded.file.id}/content`,
    );
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    // Notifications return.
    const feed = await app.request("/api/mobile/openmuse-notifications");
    expect(feed.status).toBe(200);
    const feedBody = (await feed.json()) as {
      notifications: Array<{ taskId: string }>;
    };
    expect(feedBody.notifications.map((item) => item.taskId)).toEqual([
      "task-cancelled",
    ]);
    // Cancelled work stays cancelled history; the queue is offered nothing.
    expect(taskHistory.map((task) => task.status)).toEqual(["cancelled"]);
    expect(queueOffers).toEqual([]);
    // Revoked connections stay revoked — external credentials do not return.
    expect(connections.map((connection) => connection.state)).toEqual([
      "revoked",
      "revoked",
    ]);
    // The §9 module hooks were emitted exactly once each.
    expect(world.hookCalls).toEqual(["files:user-1", "notifications:user-1"]);
  });

  test("day-31 restore answers 410 and the fence stays", async () => {
    const world = restorationWorld();
    const app = restorationApp(world);
    await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    session = actorAdmin;
    clock.now = new Date(T0.getTime() + 31 * DAY_MS);
    const response = await app.request(
      "/api/admin/openmuse-deletion/user-1/restore",
      { method: "POST" },
    );
    expect(response.status).toBe(410);
    const body = (await response.json()) as { restoreUntil?: string };
    expect(body.restoreUntil).toBe(
      new Date(T0.getTime() + 30 * DAY_MS).toISOString(),
    );
    // No hook ran and the marker is still fencing.
    expect(world.hookCalls).toEqual([]);
    session = actorOne;
    expect((await app.request("/api/mobile/openmuse-goals")).status).toBe(403);
  });

  test("a non-admin is refused 403; a user without a marker is 404", async () => {
    const world = restorationWorld();
    const app = restorationApp(world);
    await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    clock.now = new Date(T0.getTime() + 29 * DAY_MS);
    session = actorOne;
    const forbidden = await app.request(
      "/api/admin/openmuse-deletion/user-1/restore",
      { method: "POST" },
    );
    expect(forbidden.status).toBe(403);
    expect(world.hookCalls).toEqual([]);
    session = actorAdmin;
    const missing = await app.request(
      "/api/admin/openmuse-deletion/user-2/restore",
      { method: "POST" },
    );
    expect(missing.status).toBe(404);
    // The refused calls left the marker fencing.
    session = actorOne;
    expect((await app.request("/api/mobile/openmuse-goals")).status).toBe(403);
  });

  test("a second restore answers the same report and re-emits the idempotent hooks", async () => {
    const world = restorationWorld();
    const app = restorationApp(world);
    await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    session = actorAdmin;
    clock.now = new Date(T0.getTime() + 29 * DAY_MS);
    const first = await app.request(
      "/api/admin/openmuse-deletion/user-1/restore",
      { method: "POST" },
    );
    expect(first.status).toBe(200);
    const report = await first.json();
    const second = await app.request(
      "/api/admin/openmuse-deletion/user-1/restore",
      { method: "POST" },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(report);
    // The hooks re-emitted (they are idempotent), the fence stays lifted.
    expect(world.hookCalls).toEqual([
      "files:user-1",
      "notifications:user-1",
      "files:user-1",
      "notifications:user-1",
    ]);
    session = actorOne;
    expect((await app.request("/api/mobile/openmuse-goals")).status).toBe(200);
  });

  test("the report enumerates live-again, read-only and not-restorable classes", async () => {
    const world = restorationWorld();
    const app = restorationApp(world);
    await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    session = actorAdmin;
    clock.now = new Date(T0.getTime() + 29 * DAY_MS);
    const response = await app.request(
      "/api/admin/openmuse-deletion/user-1/restore",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      restore: {
        userId: actorOne.id,
        phase: "restored",
        disabledAt: T0.toISOString(),
        restoreUntil: new Date(T0.getTime() + 30 * DAY_MS).toISOString(),
        liveAgain: [
          "openmuse-bot",
          "openmuse-channel",
          "openmuse-file",
          "openmuse-goal",
          "openmuse-idea",
          "openmuse-memory",
          "openmuse-notification",
        ],
        readOnly: ["openmuse-task", "openmuse-reviewed-action"],
        notRestorable: [
          "openmuse-google-connection",
          "openmuse-google-calendar-connection",
        ],
      },
    });
  });
});

/*
 * D05 over the real store: the phase flip, the 30-day window the service
 * decides with an injected clock, and the fence's re-admission — the same
 * contract the in-memory describe pins, against drizzle.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "openmuse account restoration store (D05)",
  () => {
    const database = createDatabase(testDatabaseUrl(), TEST_POOL);
    const store = createOpenMuseAccountDeletionStore(database);
    const prefix = `res-${randomUUID().slice(0, 8)}`;

    afterAll(async () => {
      await database
        .delete(openmuseAccountDeletions)
        .where(like(openmuseAccountDeletions.userId, `${prefix}%`));
      await database.$client.close();
    });

    test("restore flips the marker restored with the window, and the fence re-admits", async () => {
      const userId = `${prefix}-a`;
      const marker = await store.delete(userId);
      expect(await store.isDisabled(userId)).toBe(true);
      const restoreUntil = new Date(
        marker.disabledAt.getTime() + 30 * 86_400_000,
      );
      const restored = await store.restore(userId, restoreUntil);
      expect(restored?.phase).toBe("restored");
      expect(restored?.restoreUntil?.toISOString()).toBe(
        restoreUntil.toISOString(),
      );
      expect(await store.isDisabled(userId)).toBe(false);
      // The flip is insert-once: a repeat answers the same row.
      const again = await store.restore(userId, restoreUntil);
      expect(again).toEqual(restored);
    });

    test("the service window: day-29 restores, day-31 answers 410, unknown 404", async () => {
      const userId = `${prefix}-b`;
      const marker = await store.delete(userId);
      const day = (n: number) =>
        new Date(marker.disabledAt.getTime() + n * 86_400_000);
      const late = createOpenMuseDeletionRestore({
        marker: store,
        now: () => day(31),
      });
      const refused = await late(userId);
      expect(refused).toMatchObject({ status: 410 });
      expect(await store.isDisabled(userId)).toBe(true);
      const early = createOpenMuseDeletionRestore({
        marker: store,
        now: () => day(29),
      });
      const restored = await early(userId);
      expect(restored).toMatchObject({ status: 200 });
      expect(await store.isDisabled(userId)).toBe(false);
      const missing = await early(`${prefix}-none`);
      expect(missing).toMatchObject({ status: 404 });
    });
  },
);

/** The manifest rows: the same insert-once/stay-deleted fake D04 used. */
/** A relational seam that must never be reached by the test that injects it. */
const hardDeleteNever = {
  hardDelete: async () => {
    throw new Error("this seam must not be reached");
  },
} as const;

function purgeManifestRows() {
  const table = new Map<string, StoredOpenMuseDeletionResource>();
  const keyOf = (
    manifestId: string,
    kind: string,
    id: string,
    externalKey?: string,
  ) => [manifestId, kind, id, externalKey ?? ""].join("\u0000");
  return {
    table,
    rows: {
      insertResources: async (
        manifestId: string,
        resources: OpenMuseDeletionResourceInput[],
      ) => {
        for (const resource of resources) {
          const key = keyOf(
            manifestId,
            resource.kind,
            resource.id,
            resource.externalKey,
          );
          if (table.has(key)) continue;
          table.set(key, {
            manifestId,
            kind: resource.kind,
            id: resource.id,
            externalKey: resource.externalKey ?? "",
            state: resource.state ?? "pending",
            lastError: resource.lastError ?? null,
            updatedAt: clock.now,
          });
        }
      },
      listResources: async (manifestId: string) =>
        [...table.values()]
          .filter((row) => row.manifestId === manifestId)
          .sort((a, b) =>
            [a.kind, a.id, a.externalKey]
              .join("\u0000")
              .localeCompare([b.kind, b.id, b.externalKey].join("\u0000")),
          ),
      markDeleted: async (
        manifestId: string,
        kind: string,
        id: string,
        externalKey?: string,
      ) => {
        const row = table.get(keyOf(manifestId, kind, id, externalKey));
        if (row && row.state !== "deleted") {
          row.state = "deleted";
          row.lastError = null;
        }
      },
      markRetryable: async (
        manifestId: string,
        kind: string,
        id: string,
        lastError: string,
        externalKey?: string,
      ) => {
        const row = table.get(keyOf(manifestId, kind, id, externalKey));
        if (row && row.state !== "deleted") {
          row.state = "retryable_error";
          row.lastError = lastError;
        }
      },
      resolveGaps: async (manifestId: string, kinds: string[]) => {
        for (const [key, row] of table) {
          if (
            row.manifestId === manifestId &&
            row.id === MODULE_GAP &&
            kinds.includes(row.kind)
          ) {
            table.delete(key);
          }
        }
      },
      hardDeleteResources: async (manifestId: string) => {
        for (const [key, row] of table)
          if (row.manifestId === manifestId) table.delete(key);
      },
    } satisfies OpenMuseDeletionResourceRows,
  };
}

/*
 * D06 (§9 cleanup): the manifest's file rows drive deletion of original AND
 * derived bytes BEFORE the file metadata rows are removed; a byte-store
 * refusal lands its row `retryable_error` with the reason (F-PURGE-1: the
 * manifest retains the external key, then marks deleted — the relational
 * row is never removed first) and never takes its file's metadata with it;
 * the retry touches only this manifest's keys; and a post-purge restore
 * reports files as bytes-unavailable instead of live-again.
 */
describe("file byte purge (D06)", () => {
  const T0 = new Date("2026-10-13T00:00:00Z");
  const DAY_MS = 86_400_000;

  /**
   * The D06 world: a real files store over the in-memory rows and byte
   * store (both recording into one event log, so bytes-before-metadata is
   * provable), a real manifest over fake manifest rows, and the purger.
   */
  function purgeWorld() {
    markers.clear();
    restoredUntil.clear();
    session = actorOne;
    clock.now = T0;
    const events: string[] = [];
    const byteStore = deletionByteStore(events);
    const fileRows = deletionFileRows(events);
    const files = createOpenMuseFileStore({ rows: fileRows, byteStore });
    const manifestStore = purgeManifestRows();
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      files,
    });
    const purger = createOpenMuseFileBytePurger({
      rows: manifestStore.rows,
      marker: store,
      byteStore,
      files,
    });
    return {
      events,
      byteStore,
      fileRows,
      files,
      manifestStore,
      manifest,
      purger,
    };
  }

  async function upload(
    world: ReturnType<typeof purgeWorld>,
    ownerUserId: string,
    name: string,
  ) {
    return world.files.upload({
      ownerUserId,
      name,
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      idempotencyKey: null,
    });
  }

  /** The manifest's file rows, the subset the purge walks. */
  async function fileManifestRows(world: ReturnType<typeof purgeWorld>) {
    return (await world.manifestStore.rows.listResources(actorOne.id)).filter(
      (row) => row.kind === "openmuse-file",
    );
  }

  test("purges original and derived bytes before the metadata rows, then lands every manifest row deleted", async () => {
    const world = purgeWorld();
    const original = await upload(world, actorOne.id, "lease.pdf");
    const derived = await world.files.appendVersion({
      ownerUserId: actorOne.id,
      fileId: original.file.id,
      bytes: new Uint8Array([4, 5, 6]),
      parentVersionId: original.file.versionId,
      values: { signed: true },
    });
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    const report = await world.purger.purgeFileBytes(actorOne.id);
    // BOTH byte objects — original and derived — left the store.
    expect(world.byteStore.data.size).toBe(0);
    expect(report.purged.slice().sort()).toEqual(
      [
        derived.bytePath,
        openMuseFileByteKey(
          actorOne.id,
          original.file.id,
          original.file.versionId,
        ),
      ].sort(),
    );
    // Bytes before metadata: the first rows: event follows the last bytes:
    // event — the ordering fake's whole claim.
    const firstRowEvent = world.events.findIndex((event) =>
      event.startsWith("rows:"),
    );
    expect(firstRowEvent).toBeGreaterThan(-1);
    expect(
      world.events
        .slice(0, firstRowEvent)
        .filter((event) => event.startsWith("bytes:")),
    ).toHaveLength(2);
    expect(
      world.events
        .slice(firstRowEvent)
        .some((event) => event.startsWith("bytes:")),
    ).toBe(false);
    // The metadata rows are gone — the file and both its versions.
    expect(world.fileRows.files).toEqual([]);
    expect(world.fileRows.versions).toEqual([]);
    // Every file manifest row landed deleted.
    expect((await fileManifestRows(world)).map((row) => row.state)).toEqual([
      "deleted",
      "deleted",
    ]);
    // §9: cleanup lag never reopens access — the marker still fences.
    expect(await store.isDisabled(actorOne.id)).toBe(true);
  });

  test("a failing byte delete lands retryable with its reason, keeps its file's metadata, and retryCleanup completes it", async () => {
    const world = purgeWorld();
    const fileOne = await upload(world, actorOne.id, "lease.pdf");
    const derived = await world.files.appendVersion({
      ownerUserId: actorOne.id,
      fileId: fileOne.file.id,
      bytes: new Uint8Array([4, 5, 6]),
      parentVersionId: fileOne.file.versionId,
      values: { signed: true },
    });
    // The other file — single version — must still purge around the failure.
    await upload(world, actorOne.id, "photo.png");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // F-PURGE-1: the byte store refuses the derived key once.
    world.byteStore.failures.add(derived.bytePath);
    await world.purger.purgeFileBytes(actorOne.id);
    const failed = (await fileManifestRows(world)).find(
      (row) => row.externalKey === derived.bytePath,
    );
    expect(failed?.state).toBe("retryable_error");
    expect(failed?.lastError).toContain("byte store refused");
    // The failed key's bytes survive for the retry; every other object left.
    expect(world.byteStore.data.has(derived.bytePath)).toBe(true);
    expect(world.byteStore.data.size).toBe(1);
    // The others still purge — fileTwo's metadata is gone — while fileOne's
    // metadata is retained (a retryable key never lets its rows go).
    expect(world.fileRows.files.map((file) => file.id)).toEqual([
      fileOne.file.id,
    ]);
    expect(world.fileRows.versions.map((version) => version.fileId)).toEqual([
      fileOne.file.id,
      fileOne.file.id,
    ]);
    // The retry completes it: bytes, metadata, manifest rows.
    world.byteStore.failures.delete(derived.bytePath);
    await world.purger.retryCleanup(actorOne.id);
    expect(world.byteStore.data.size).toBe(0);
    expect(world.fileRows.files).toEqual([]);
    expect(world.fileRows.versions).toEqual([]);
    expect((await fileManifestRows(world)).map((row) => row.state)).toEqual([
      "deleted",
      "deleted",
      "deleted",
    ]);
    // The repeat is idempotent: no new byte delete is attempted, nothing moves.
    const attempts = world.byteStore.calls.length;
    await world.purger.retryCleanup(actorOne.id);
    expect(world.byteStore.calls.length).toBe(attempts);
    expect(
      (await fileManifestRows(world)).every((row) => row.state === "deleted"),
    ).toBe(true);
    expect(world.fileRows.files).toEqual([]);
  });

  test("a MODULE_GAP file row is never byte-deleted: it stays retryable and visible while real rows purge around it", async () => {
    const world = purgeWorld();
    const uploaded = await upload(world, actorOne.id, "lease.pdf");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // A stale enumeration gap from an earlier build: no key, no resource.
    await world.manifestStore.rows.insertResources(actorOne.id, [
      { kind: "openmuse-file", id: MODULE_GAP },
    ]);
    const report = await world.purger.purgeFileBytes(actorOne.id);
    // The gap's "" key never reaches the byte store — delete("") resolves to
    // the byte-store root — and the real key purged around it.
    const realKey = openMuseFileByteKey(
      actorOne.id,
      uploaded.file.id,
      uploaded.file.versionId,
    );
    expect(world.byteStore.calls).toEqual([realKey]);
    // The gap stays retryable and operator-visible: never marked deleted by
    // a tolerated no-op, never closed but by a manifest rebuild.
    const gap = (await fileManifestRows(world)).find(
      (row) => row.id === MODULE_GAP,
    );
    expect(gap?.state).toBe("retryable_error");
    expect(gap?.lastError).toBe(
      "module gap unresolved — re-enumerate the manifest",
    );
    expect(report.retryable).toEqual([
      {
        id: MODULE_GAP,
        externalKey: "",
        lastError: "module gap unresolved — re-enumerate the manifest",
      },
    ]);
    expect(report.hardDeleted).toEqual([uploaded.file.id]);
    // The retry keeps it visible: nothing but a rebuild closes a gap.
    await world.purger.retryCleanup(actorOne.id);
    expect(
      (await fileManifestRows(world)).find((row) => row.id === MODULE_GAP)
        ?.state,
    ).toBe("retryable_error");
  });

  test("a phase-2 hardDelete failure keeps its rows out of report.retryable and the walk continues", async () => {
    const world = purgeWorld();
    const refused = await upload(world, actorOne.id, "lease.pdf");
    const survivor = await upload(world, actorOne.id, "photo.png");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // One file's metadata delete refuses; the neighbour must still complete
    // — a single module's failure never holds its neighbours hostage.
    const files = {
      hardDelete: async (ownerUserId: string, fileId: string) => {
        if (fileId === refused.file.id)
          throw new Error("metadata delete refused");
        await world.files.hardDelete(ownerUserId, fileId);
      },
    };
    const purger = createOpenMuseFileBytePurger({
      rows: world.manifestStore.rows,
      marker: store,
      byteStore: world.byteStore,
      files,
    });
    const report = await purger.purgeFileBytes(actorOne.id);
    expect(report.hardDeleted).toEqual([survivor.file.id]);
    // The failed file's byte rows stay OUT of report.retryable: their bytes
    // are gone, so every row is terminal `deleted` and markRetryable's
    // ne(deleted) guard makes the marks no-ops — claiming they "stayed
    // retryable" would misstate the manifest. The debt lives on the manifest
    // (the next test), and the next pass re-surveys and completes it.
    expect(report.retryable).toEqual([]);
    expect(world.fileRows.files.map((file) => file.id)).toEqual([
      refused.file.id,
    ]);
    // The next pass surveys every file row again and completes the
    // refusal — the survivor's id re-answers too, the idempotent re-delete
    // of a row that is already gone.
    const completed = await world.purger.retryCleanup(actorOne.id);
    expect(completed.hardDeleted.slice().sort()).toEqual(
      [refused.file.id, survivor.file.id].sort(),
    );
    expect(world.fileRows.files).toEqual([]);
  });

  test("a phase-2 hardDelete failure persists its metadata debt on the manifest, and the debt closes and unblocks finalize", async () => {
    const world = purgeWorld();
    const refused = await upload(world, actorOne.id, "lease.pdf");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    const files = {
      hardDelete: async () => {
        throw new Error("metadata delete refused");
      },
    };
    const purger = createOpenMuseFileBytePurger({
      rows: world.manifestStore.rows,
      marker: store,
      byteStore: world.byteStore,
      files,
    });
    await purger.purgeFileBytes(actorOne.id);

    // The debt is DURABLE, not report-only: the file's own rows are terminal
    // deleted (markRetryable is a no-op on them), so one dedicated manifest
    // row per file carries it — the cleanup view sees it, and finalize waits.
    const debt = (
      await world.manifestStore.rows.listResources(actorOne.id)
    ).find((row) => row.kind === "openmuse-file-metadata");
    expect(debt).toMatchObject({
      id: refused.file.id,
      state: "retryable_error",
      lastError: "metadata delete refused",
    });

    // The debt blocks the relational finalize: the externals are not all
    // terminal while the metadata row still owes.
    const relational = createOpenMuseRelationalPurger({
      rows: world.manifestStore.rows,
      marker: store,
      agents: hardDeleteNever,
      channels: hardDeleteNever,
      tasks: hardDeleteNever,
      reviewed: hardDeleteNever,
      goals: hardDeleteNever,
      ideas: hardDeleteNever,
      memories: hardDeleteNever,
      notifications: hardDeleteNever,
    });
    const blocked = await relational.purgeRelationalData(actorOne.id);
    expect(blocked.status).toBe(409);
    if (blocked.status === 409) {
      expect(
        blocked.blocked.some((row) => row.kind === "openmuse-file-metadata"),
      ).toBe(true);
    }

    // A later pass completes the delete — the debt row closes with it.
    const completed = await world.purger.retryCleanup(actorOne.id);
    expect(completed.hardDeleted).toEqual([refused.file.id]);
    const closed = (
      await world.manifestStore.rows.listResources(actorOne.id)
    ).find((row) => row.kind === "openmuse-file-metadata");
    expect(closed?.state).toBe("deleted");
  });

  test("never touches another user's object: only the manifest's keys are attempted", async () => {
    const world = purgeWorld();
    const mine = await upload(world, actorOne.id, "lease.pdf");
    const theirs = await upload(world, actorTwo.id, "photo.png");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    await world.purger.purgeFileBytes(actorOne.id);
    // User 2's object is untouched — bytes intact, rows intact.
    const theirKey = openMuseFileByteKey(
      actorTwo.id,
      theirs.file.id,
      theirs.file.versionId,
    );
    expect(world.byteStore.data.get(theirKey)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(world.fileRows.files.map((file) => file.ownerUserId)).toEqual([
      actorTwo.id,
    ]);
    expect(world.fileRows.versions.map((version) => version.fileId)).toEqual([
      theirs.file.id,
    ]);
    // Only the manifest's key was ever attempted.
    expect(world.byteStore.calls).toEqual([
      openMuseFileByteKey(actorOne.id, mine.file.id, mine.file.versionId),
    ]);
  });

  test("a post-purge restore records files as bytes-unavailable, not live-again", async () => {
    const world = purgeWorld();
    await upload(world, actorOne.id, "lease.pdf");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    await world.purger.purgeFileBytes(actorOne.id);
    // D05's contract returns Files/versions "provided D06 hasn't purged" —
    // it has, so the day-29 restore must not claim them live again.
    const restore = createOpenMuseDeletionRestore({
      marker: store,
      now: () => clock.now,
      files: world.files,
      manifestRows: world.manifestStore.rows,
    });
    clock.now = new Date(T0.getTime() + 29 * DAY_MS);
    const outcome = await restore(actorOne.id);
    expect(outcome.status).toBe(200);
    if (outcome.status !== 200) return;
    expect(outcome.report.liveAgain).not.toContain("openmuse-file");
    expect(outcome.report.notRestorable).toContain("openmuse-file");
    // The restored owner lists nothing — the rows, not just the bytes, are gone.
    expect((await world.files.list(actorOne.id, { limit: 10 })).files).toEqual(
      [],
    );
  });

  test("the admin purge route answers the report and refuses a non-admin", async () => {
    const world = purgeWorld();
    const uploaded = await upload(world, actorOne.id, "lease.pdf");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    const restore = createOpenMuseDeletionRestore({
      marker: store,
      now: () => clock.now,
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/openmuse-deletion",
      createOpenMuseDeletionAdminRoutes({
        requireUser,
        restore,
        purge: world.purger.purgeFileBytes,
      }),
    );
    session = actorAdmin;
    const response = await app.request(
      `/api/admin/openmuse-deletion/${actorOne.id}/purge`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      purge: OpenMuseFileBytePurgeReport;
    };
    expect(body.purge.userId).toBe(actorOne.id);
    expect(body.purge.purged).toEqual([
      openMuseFileByteKey(
        actorOne.id,
        uploaded.file.id,
        uploaded.file.versionId,
      ),
    ]);
    expect(body.purge.hardDeleted).toEqual([uploaded.file.id]);
    expect(world.byteStore.data.size).toBe(0);
    // A non-admin never reaches the purge.
    session = actorOne;
    const forbidden = await app.request(
      `/api/admin/openmuse-deletion/${actorTwo.id}/purge`,
      { method: "POST" },
    );
    expect(forbidden.status).toBe(403);
    expect(world.byteStore.calls).toHaveLength(1);
  });

  test("§9's phase gate: a restored account's bytes are never purged, and the admin route answers the refusal 409", async () => {
    const world = purgeWorld();
    await upload(world, actorOne.id, "lease.pdf");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    await store.restore(
      actorOne.id,
      new Date(clock.now.getTime() + 30 * 86_400_000),
    );
    await expect(
      world.purger.purgeFileBytes(actorOne.id),
    ).rejects.toBeInstanceOf(OpenMusePurgeRefusedError);
    // Not one byte left the store.
    expect(world.byteStore.data.size).toBe(1);
    const restore = createOpenMuseDeletionRestore({
      marker: store,
      now: () => clock.now,
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/openmuse-deletion",
      createOpenMuseDeletionAdminRoutes({
        requireUser,
        restore,
        purge: world.purger.purgeFileBytes,
      }),
    );
    session = actorAdmin;
    const response = await app.request(
      `/api/admin/openmuse-deletion/${actorOne.id}/purge`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not fenced");
  });

  test("a restore landing mid-walk stops the pass: later bytes and the metadata phase are never touched", async () => {
    const world = purgeWorld();
    const first = await upload(world, actorOne.id, "lease.pdf");
    const second = await upload(world, actorOne.id, "photo.png");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // D05's restore lands the moment the first byte leaves — the two admin
    // routes share a face and nothing serializes them. The next gate read
    // must refuse the walk, so the still-fenced file keeps its bytes and
    // its metadata rows. (The manifest walks newest first: which file goes
    // first is read off the walk, not assumed.)
    const innerDelete = world.byteStore.delete.bind(world.byteStore);
    let firstGone = "";
    world.byteStore.delete = async (key: string) => {
      await innerDelete(key);
      firstGone = key;
      await store.restore(
        actorOne.id,
        new Date(clock.now.getTime() + 30 * DAY_MS),
      );
    };
    await expect(
      world.purger.purgeFileBytes(actorOne.id),
    ).rejects.toBeInstanceOf(OpenMusePurgeRefusedError);
    expect(firstGone).not.toBe("");
    const keys = [first, second].map((file) =>
      openMuseFileByteKey(actorOne.id, file.file.id, file.file.versionId),
    );
    const survivorKey = keys.find((key) => key !== firstGone)!;
    const survivorId = survivorKey === keys[0] ? first.file.id : second.file.id;
    // Exactly one byte left before the refusal: the survivor's bytes stand.
    expect(world.byteStore.calls).toEqual([firstGone]);
    expect(world.byteStore.data.has(survivorKey)).toBe(true);
    // And the metadata phase never ran: the survivor's rows are intact.
    expect(world.fileRows.files.map((row) => row.id)).toContain(survivorId);
  });

  test("G06 on the report's exit: a token-shaped lastError is redacted before the admin route answers it", async () => {
    const world = purgeWorld();
    await upload(world, actorOne.id, "lease.pdf");
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // The byte store fails quoting a credential — the reason lands
    // retryable on the row, and the route must answer it sanitized, the
    // same display guard the cleanup view runs on the same column.
    const leakingByteStore = {
      ...world.byteStore,
      delete: async () => {
        throw new Error(`refresh failed with ya29.${"a0ARrdaM".repeat(8)}`);
      },
    };
    const purger = createOpenMuseFileBytePurger({
      rows: world.manifestStore.rows,
      marker: store,
      byteStore: leakingByteStore,
      files: world.files,
    });
    const restore = createOpenMuseDeletionRestore({
      marker: store,
      now: () => clock.now,
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/openmuse-deletion",
      createOpenMuseDeletionAdminRoutes({
        requireUser,
        restore,
        purge: purger.purgeFileBytes,
      }),
    );
    session = actorAdmin;
    const response = await app.request(
      `/api/admin/openmuse-deletion/${actorOne.id}/purge`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      purge: OpenMuseFileBytePurgeReport;
    };
    expect(body.purge.retryable).toHaveLength(1);
    expect(body.purge.retryable[0]?.lastError).toBe(
      OPENMUSE_REDACTED_LAST_ERROR,
    );
    // The raw reason quoted below never rides the answer.
    expect(JSON.stringify(body)).not.toContain("ya29.");
  });
});

/*
 * D07 (§9 cleanup): the manifest's connector rows drive vendor connection
 * deletion BEFORE the local connection row is removed; a vendor refusal
 * blocks only its own alias, which stays enumerated (the row is what
 * enumerateOwner lists) and blocked (D03's pass already revoked the seat)
 * until a successful purge — F-PURGE-2; the retry re-walks retryable rows
 * only; another user's alias is never dialed; and the D01 fence outlives
 * the purge, so a deleted owner cannot start a new consent however clean
 * the seats are.
 */
describe("connector grant purge (D07)", () => {
  const T0 = new Date("2026-10-13T00:00:00Z");

  /**
   * In-memory connector rows recording hard deletes into the event log, so
   * vendor-before-row is provable (the D06 ordering fake's trick).
   */
  function purgeConnectorRows(events: string[]) {
    const connections: StoredOpenMuseGoogleConnection[] = [];
    return {
      connections,
      rows: {
        insertPending: async () => {},
        getPending: async () => null,
        consumePending: async () => false,
        recordOutcome: async () => {},
        sweepExpired: async () => 0,
        getConnectionById: async (id) =>
          connections.find((row) => row.id === id) ?? null,
        getConnection: async (userId, provider) =>
          connections.find(
            (row) => row.userId === userId && row.provider === provider,
          ) ?? null,
        overwriteConnection: async (connection) => {
          const existing = connections.find(
            (row) =>
              row.userId === connection.userId &&
              row.provider === connection.provider,
          );
          if (!existing) {
            throw new Error(`no connection row for ${connection.provider}`);
          }
          Object.assign(existing, connection);
        },
        saveConnection: async (connection) => {
          connections.push({ ...connection });
        },
        listIdsByOwner: async (userId) =>
          connections
            .filter((row) => row.userId === userId)
            .map((row) => ({ id: row.id, provider: row.provider })),
        ownerDisabled: async (userId) => markers.has(userId),
        disableOwner: async () => {},
        restoreOwner: async () => {},
        // The one openmuse-connectors member D07 adds: owner-scoped, so a
        // foreign id (even a colliding one) deletes nothing.
        hardDeleteConnection: async (userId, connectionId) => {
          const index = connections.findIndex(
            (row) => row.userId === userId && row.id === connectionId,
          );
          if (index >= 0) connections.splice(index, 1);
          events.push(`rows:${connectionId}`);
        },
      } satisfies OpenMuseGoogleRows,
    };
  }

  /**
   * The vendor dial D07 needs: the delete-by-alias seam (refusable per
   * alias) and a start-authorization answer, every call recorded and every
   * DELETE logged, so vendor-before-row is provable and a foreign alias
   * never dials unnoticed.
   */
  function purgeVendor(events: string[]) {
    const refused = new Set<string>();
    const calls: Array<{ method: string; path: string }> = [];
    const dial: OAuthWireDial = async (path, init) => {
      calls.push({ method: init.method, path });
      const url = new URL(path, "http://openconnector.test");
      if (
        init.method === "DELETE" &&
        url.pathname.startsWith("/api/connections/")
      ) {
        const service = decodeURIComponent(
          url.pathname.slice("/api/connections/".length),
        );
        const alias = url.searchParams.get("connectionName") ?? "";
        events.push(`vendor:${service}:${alias}`);
        if (refused.has(alias)) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ message: "the deletion was refused" }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      if (
        init.method === "POST" &&
        url.pathname === "/api/oauth/authorizations"
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authorizationUrl: "https://accounts.google.test/o?state=state-1",
          }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "unexpected vendor call" }),
      };
    };
    return {
      dial,
      refused,
      calls,
      deleteCalls: () => calls.filter((call) => call.method === "DELETE"),
    };
  }

  /**
   * The D07 world: the real OAuth service over in-memory rows and the
   * recording vendor dial (D03's shape), a real manifest over fake manifest
   * rows, and the purger.
   */
  function grantPurgeWorld() {
    markers.clear();
    restoredUntil.clear();
    session = actorOne;
    clock.now = T0;
    const events: string[] = [];
    const connectorStore = purgeConnectorRows(events);
    const vendor = purgeVendor(events);
    const client = buildOpenConnectorOAuthClient({ dial: vendor.dial });
    const service = createOpenMuseGoogleOAuth({
      client,
      rows: connectorStore.rows,
      now: () => clock.now,
    });
    const manifestStore = purgeManifestRows();
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      connectors: service,
    });
    const purger = createOpenMuseConnectorGrantPurger({
      rows: manifestStore.rows,
      marker: store,
      client,
      connections: connectorStore.rows,
    });
    return {
      events,
      connectorStore,
      vendor,
      service,
      manifestStore,
      manifest,
      purger,
    };
  }

  /** One seat, as G01's connect leaves it (the D03 pass revokes it later). */
  function seatRow(
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): StoredOpenMuseGoogleConnection {
    return {
      id: `conn-${provider}`,
      userId,
      provider,
      accountEmail: "person@gmail.com",
      status: "connected",
      grantedScopes: [],
      generation: 1,
      alias: openmuseAlias(userId, provider),
      connectedAt: clock.now,
      lastError: null,
    };
  }

  /**
   * The §9 sequence up to the purge: connect → D03 revoke → marker → D04
   * manifest — then a clean event log for the pass under test.
   */
  async function fencedManifest(
    world: ReturnType<typeof grantPurgeWorld>,
    providers: OpenMuseGoogleProvider[],
  ) {
    for (const provider of providers) {
      world.connectorStore.connections.push(seatRow(actorOne.id, provider));
    }
    await world.service.revokeOwner(actorOne.id);
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // A clean log: the revocation pass's own dials must not count against
    // the pass under test.
    world.events.length = 0;
    world.vendor.calls.length = 0;
  }

  /** The manifest's connector rows, the subset the purge walks. */
  async function connectorManifestRows(
    world: ReturnType<typeof grantPurgeWorld>,
  ) {
    return (await world.manifestStore.rows.listResources(actorOne.id)).filter(
      (row) =>
        row.kind === "openmuse-google-connection" ||
        row.kind === "openmuse-google-calendar-connection",
    );
  }

  test("deletes each alias at the vendor before its local row leaves, then lands every manifest row deleted", async () => {
    const world = grantPurgeWorld();
    await fencedManifest(world, ["gmail", "googlecalendar"]);
    const gmailAlias = openmuseAlias(actorOne.id, "gmail");
    const calendarAlias = openmuseAlias(actorOne.id, "googlecalendar");
    const report = await world.purger.purgeConnectorGrants(actorOne.id);
    // Vendor deleteConnection once per alias (the fake's counts), each
    // BEFORE its local row left — the ordering fake's whole claim. The
    // manifest lists the calendar kind first, so that seat walks first.
    expect(world.events).toEqual([
      `vendor:googlecalendar:${calendarAlias}`,
      "rows:conn-googlecalendar",
      `vendor:gmail:${gmailAlias}`,
      "rows:conn-gmail",
    ]);
    // The local rows are gone, and with them the enumeration.
    expect(world.connectorStore.connections).toEqual([]);
    expect(await world.service.enumerateOwner(actorOne.id)).toEqual([]);
    // Every connector manifest row landed deleted.
    expect(
      (await connectorManifestRows(world)).map((row) => row.state),
    ).toEqual(["deleted", "deleted"]);
    expect(report.purged.slice().sort()).toEqual(
      [calendarAlias, gmailAlias].sort(),
    );
    expect(report.hardDeleted.slice().sort()).toEqual(
      ["conn-gmail", "conn-googlecalendar"].sort(),
    );
    expect(report.retryable).toEqual([]);
  });

  test("a refused vendor deletion blocks only its alias — retained, enumerable and blocked — and retryCleanup completes it idempotently", async () => {
    const world = grantPurgeWorld();
    await fencedManifest(world, ["gmail", "googlecalendar"]);
    const gmailAlias = openmuseAlias(actorOne.id, "gmail");
    // F-PURGE-2: the vendor refuses one alias's deletion once.
    world.vendor.refused.add(gmailAlias);
    await world.purger.purgeConnectorGrants(actorOne.id);
    const rows = await connectorManifestRows(world);
    const failed = rows.find((row) => row.externalKey === gmailAlias);
    expect(failed?.state).toBe("retryable_error");
    expect(failed?.lastError).toContain("the deletion was refused");
    // The other alias completed around the failure.
    expect(rows.find((row) => row.externalKey !== gmailAlias)?.state).toBe(
      "deleted",
    );
    // The refused alias stays enumerated (its row survives)...
    expect(await world.service.enumerateOwner(actorOne.id)).toEqual([
      { kind: "openmuse-google-connection", id: "conn-gmail" },
    ]);
    // ...and blocked: the seat D03 revoked never serves a provider call.
    expect(world.connectorStore.connections.map((row) => row.status)).toEqual([
      "revoked",
    ]);
    await expect(
      world.service.requireConnection(actorOne.id, "gmail"),
    ).rejects.toBeInstanceOf(OpenMuseConnectionRefusedError);
    // The failed alias's row was never removed.
    expect(world.events).not.toContain("rows:conn-gmail");
    // The retry completes it: vendor, row, manifest — then repeats move nothing.
    world.vendor.refused.delete(gmailAlias);
    await world.purger.retryCleanup(actorOne.id);
    expect(world.connectorStore.connections).toEqual([]);
    expect(
      (await connectorManifestRows(world)).map((row) => row.state),
    ).toEqual(["deleted", "deleted"]);
    expect(await world.service.enumerateOwner(actorOne.id)).toEqual([]);
    const deletes = world.vendor.deleteCalls().length;
    await world.purger.retryCleanup(actorOne.id);
    expect(world.vendor.deleteCalls().length).toBe(deletes);
    expect(
      (await connectorManifestRows(world)).every(
        (row) => row.state === "deleted",
      ),
    ).toBe(true);
  });

  test("a MODULE_GAP connector row is never dialed or closed: it stays retryable while the real grants purge", async () => {
    const world = grantPurgeWorld();
    await fencedManifest(world, ["gmail"]);
    const gmailAlias = openmuseAlias(actorOne.id, "gmail");
    // A stale enumeration gap from an earlier build: its externalKey is ""
    // and its id names no connection row.
    await world.manifestStore.rows.insertResources(actorOne.id, [
      { kind: "openmuse-google-connection", id: MODULE_GAP },
    ]);
    const report = await world.purger.purgeConnectorGrants(actorOne.id);
    // No vendor dial ever named the gap's empty alias, and no tolerated
    // no-op closed the gap — only the real seat walked vendor-before-row.
    expect(world.events).toEqual([
      `vendor:gmail:${gmailAlias}`,
      "rows:conn-gmail",
    ]);
    const gap = (await connectorManifestRows(world)).find(
      (row) => row.id === MODULE_GAP,
    );
    expect(gap?.state).toBe("retryable_error");
    expect(gap?.lastError).toBe(
      "module gap unresolved — re-enumerate the manifest",
    );
    expect(report.retryable).toEqual([
      {
        id: MODULE_GAP,
        externalKey: "",
        lastError: "module gap unresolved — re-enumerate the manifest",
      },
    ]);
    expect(report.hardDeleted).toEqual(["conn-gmail"]);
    // The retry leaves the gap exactly where it is — operator-visible.
    await world.purger.retryCleanup(actorOne.id);
    expect(
      (await connectorManifestRows(world)).find((row) => row.id === MODULE_GAP)
        ?.state,
    ).toBe("retryable_error");
  });

  test("never dials another user's alias or removes their row", async () => {
    const world = grantPurgeWorld();
    await fencedManifest(world, ["gmail"]);
    // A second user's live seat — same connection id, different owner —
    // never in the deleting owner's manifest.
    const theirs = seatRow(actorTwo.id, "gmail");
    world.connectorStore.connections.push(theirs);
    await world.purger.purgeConnectorGrants(actorOne.id);
    // Only the manifest's alias was ever dialed (the fake dial's whole claim).
    expect(world.vendor.deleteCalls().map((call) => call.path)).toEqual([
      `/api/connections/gmail?connectionName=${encodeURIComponent(
        openmuseAlias(actorOne.id, "gmail"),
      )}`,
    ]);
    // Their row survives the owner-scoped delete untouched.
    expect(world.connectorStore.connections).toEqual([theirs]);
    expect(await world.service.enumerateOwner(actorTwo.id)).toEqual([
      { kind: "openmuse-google-connection", id: theirs.id },
    ]);
  });

  test("a post-purge start-authorize is fence-refused anyway (D01 outlives the purge)", async () => {
    const world = grantPurgeWorld();
    await fencedManifest(world, ["gmail", "googlecalendar"]);
    await world.purger.purgeConnectorGrants(actorOne.id);
    // The seats are gone — vendor and rows — yet the deleted owner cannot
    // start a new consent: D01's marker fence refuses before any dial, so
    // the purge's clean slate never becomes a reconnect path.
    const calls = world.vendor.calls.length;
    await expect(
      world.service.start({
        userId: actorOne.id,
        provider: "gmail",
        returnUri: "https://app.test/back",
      }),
    ).rejects.toBeInstanceOf(OpenMuseConnectorOwnerDisabledError);
    expect(world.vendor.calls.length).toBe(calls);
  });

  test("§9's phase gate: a restored account's grants are never purged — the walk refuses before any dial", async () => {
    const world = grantPurgeWorld();
    await fencedManifest(world, ["gmail"]);
    await store.restore(
      actorOne.id,
      new Date(clock.now.getTime() + 30 * 86_400_000),
    );
    const calls = world.vendor.calls.length;
    await expect(
      world.purger.purgeConnectorGrants(actorOne.id),
    ).rejects.toBeInstanceOf(OpenMusePurgeRefusedError);
    expect(world.vendor.calls.length).toBe(calls);
  });
});

/*
 * D08 (§9 final relational cleanup): after D06's bytes and D07's grants are
 * terminal, the manifest's remaining kinds drive removal of the relational
 * rows — Bot profiles, Channels with their threads, Tasks and Monitors,
 * Reviewed actions, personal context and notifications — through each
 * module's own removal seam, one transactional batch per kind; a DB failure
 * mid-walk retains the unfinished rows so the retry converges; another
 * user's identical-shaped rows are never touched; and completion empties
 * the manifest and flips the marker's phase to completed.
 */
describe("relational purge (D08)", () => {
  const T0 = new Date("2026-10-13T00:00:00Z");

  /**
   * One owner-scoped module fake: the rows its enumerateOwner lists, every
   * hard-delete batch recorded with the ids it named, refusable once so a
   * mid-walk DB failure is injectable at any kind.
   */
  function relationalFake(kind: string) {
    const owners = new Map<string, string>();
    const batches: Array<{ owner: string; ids: string[] }> = [];
    const fake = {
      kind,
      owners,
      batches,
      failNext: false,
      add(owner: string, ...ids: string[]) {
        for (const id of ids) fake.owners.set(id, owner);
        return fake;
      },
      idsOf: (owner: string) =>
        [...fake.owners]
          .filter(([, ownerUserId]) => ownerUserId === owner)
          .map(([id]) => id)
          .sort(),
      /** Every id this fake was ever told to remove, flattened and sorted. */
      removals: (owner: string) =>
        fake.batches
          .filter((batch) => batch.owner === owner)
          .flatMap((batch) => batch.ids)
          .sort(),
      enumerateOwner: async (owner: string) =>
        fake.idsOf(owner).map((id) => ({ kind, id })),
      hardDelete: async (owner: string, ids: string[]) => {
        if (fake.failNext) {
          fake.failNext = false;
          throw new Error("database down");
        }
        fake.batches.push({ owner, ids: [...ids] });
        for (const id of ids)
          if (fake.owners.get(id) === owner) fake.owners.delete(id);
      },
    };
    return fake;
  }

  /**
   * The D08 world: every manifested module as an owner-scoped fake under one
   * real manifest and the purger under test. User 2's identical-shaped rows
   * ride the same fakes, so the cross-user claim is one assertion wide.
   */
  function relationalPurgeWorld() {
    markers.clear();
    restoredUntil.clear();
    completed.clear();
    session = actorOne;
    clock.now = T0;
    const bots = relationalFake("openmuse-bot");
    const channelsFake = relationalFake("openmuse-channel");
    const goals = relationalFake("openmuse-goal");
    const ideas = relationalFake("openmuse-idea");
    const memories = relationalFake("openmuse-memory");
    const notifications = relationalFake("openmuse-notification");
    const reviewed = relationalFake("openmuse-reviewed-action");
    const tasks = relationalFake("openmuse-task");
    const manifestStore = purgeManifestRows();
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      // The D08 world is post-D06+D07: the external seams answer empty
      // because their rows are already terminal, so no gap rows appear.
      files: { enumerateOwner: async () => [] },
      connectors: { enumerateOwner: async () => [] },
      agents: {
        enumerateOwner: async (owner: string) =>
          bots
            .idsOf(owner)
            .map((id) => ({ kind: "openmuse-bot" as const, id })),
      },
      channels: {
        enumerateOwner: async (owner: string) =>
          channelsFake.idsOf(owner).map((id) => ({ id })),
      },
      tasks,
      reviewed,
      goals,
      ideas,
      memories,
      notifications,
    });
    const purger = createOpenMuseRelationalPurger({
      rows: manifestStore.rows,
      marker: store,
      agents: bots,
      channels: channelsFake,
      tasks,
      reviewed,
      goals,
      ideas,
      memories,
      notifications,
    });
    const fakes = [
      bots,
      channelsFake,
      goals,
      ideas,
      memories,
      notifications,
      reviewed,
      tasks,
    ];
    return {
      manifestStore,
      manifest,
      purger,
      bots,
      channels: channelsFake,
      goals,
      ideas,
      memories,
      notifications,
      reviewed,
      tasks,
      fakes,
      /** Both users' identical-shaped rows: one of everything, user 1 twice. */
      seedBothUsers() {
        bots
          .add(actorOne.id, "bot-1", "bot-hidden-1")
          .add(actorTwo.id, "bot-2");
        channelsFake
          .add(actorOne.id, "chan-1", "chan-archived-1")
          .add(actorTwo.id, "chan-2");
        goals.add(actorOne.id, "goal-1").add(actorTwo.id, "goal-2");
        ideas.add(actorOne.id, "idea-1").add(actorTwo.id, "idea-2");
        memories.add(actorOne.id, "memory-1").add(actorTwo.id, "memory-2");
        notifications
          .add(actorOne.id, "notification-1")
          .add(actorTwo.id, "notification-2");
        reviewed.add(actorOne.id, "reviewed-1").add(actorTwo.id, "reviewed-2");
        tasks
          .add(actorOne.id, "task-1", "monitor-1")
          .add(actorTwo.id, "task-2");
      },
      countsOf: (owner: string) => ({
        bots: bots.idsOf(owner).length,
        channels: channelsFake.idsOf(owner).length,
        goals: goals.idsOf(owner).length,
        ideas: ideas.idsOf(owner).length,
        memories: memories.idsOf(owner).length,
        notifications: notifications.idsOf(owner).length,
        reviewed: reviewed.idsOf(owner).length,
        tasks: tasks.idsOf(owner).length,
      }),
      adminApp() {
        const app = new Hono<{ Variables: AppVariables }>();
        app.route(
          "/api/admin/openmuse-deletion",
          createOpenMuseDeletionAdminRoutes({
            requireUser,
            restore: createOpenMuseDeletionRestore({
              marker: store,
              now: () => clock.now,
            }),
            purgeRelational: purger.purgeRelationalData,
          }),
        );
        return app;
      },
    };
  }

  test("removes every manifested relational row through its module's seam, empties the manifest and completes the marker", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    const outcome = await world.purger.purgeRelationalData(actorOne.id);
    expect(outcome.status).toBe(200);
    if (outcome.status !== 200) return;
    // Every module fake lost user 1's rows — Bot profile, Channel/Thread,
    // Task AND Monitor, reviewed, personal context, notification.
    for (const fake of world.fakes) expect(fake.idsOf(actorOne.id)).toEqual([]);
    // Each through owner-scoped batches naming the manifest's own ids.
    expect(world.bots.removals(actorOne.id)).toEqual(["bot-1", "bot-hidden-1"]);
    expect(world.channels.removals(actorOne.id)).toEqual([
      "chan-1",
      "chan-archived-1",
    ]);
    expect(world.tasks.removals(actorOne.id)).toEqual(["monitor-1", "task-1"]);
    expect(world.reviewed.removals(actorOne.id)).toEqual(["reviewed-1"]);
    expect(world.goals.removals(actorOne.id)).toEqual(["goal-1"]);
    expect(world.ideas.removals(actorOne.id)).toEqual(["idea-1"]);
    expect(world.memories.removals(actorOne.id)).toEqual(["memory-1"]);
    expect(world.notifications.removals(actorOne.id)).toEqual([
      "notification-1",
    ]);
    // The report names every row that landed deleted this pass.
    expect(
      outcome.report.purged.map((row) => `${row.kind}:${row.id}`).sort(),
    ).toEqual(
      [
        "openmuse-bot:bot-1",
        "openmuse-bot:bot-hidden-1",
        "openmuse-channel:chan-1",
        "openmuse-channel:chan-archived-1",
        "openmuse-goal:goal-1",
        "openmuse-idea:idea-1",
        "openmuse-memory:memory-1",
        "openmuse-notification:notification-1",
        "openmuse-reviewed-action:reviewed-1",
        "openmuse-task:monitor-1",
        "openmuse-task:task-1",
      ].sort(),
    );
    expect(outcome.report.retryable).toEqual([]);
    expect(outcome.report.completed).toBe(true);
    // The manifest empties — not one row left owing — and the marker is
    // completed, the whole of §9's terminal state.
    expect(await world.manifestStore.rows.listResources(actorOne.id)).toEqual(
      [],
    );
    expect((await store.get(actorOne.id))?.phase).toBe("completed");
    // The admin route re-answers the same completed truth and moves nothing:
    // the repeat cleanup is idempotent, no new batch anywhere.
    const batches = world.fakes.map((fake) => fake.batches.length);
    session = actorAdmin;
    const response = await world
      .adminApp()
      .request(`/api/admin/openmuse-deletion/${actorOne.id}/purge-relational`, {
        method: "POST",
      });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      purge: { completed: boolean; purged: unknown[] };
    };
    expect(body.purge.completed).toBe(true);
    expect(body.purge.purged).toEqual([]);
    expect(world.fakes.map((fake) => fake.batches.length)).toEqual(batches);
  });

  test("a retryable byte or grant row blocks the purge with a 409 naming it, and nothing is deleted", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // D06 left one byte row retryable; D07 never ran, so one grant row is
    // still pending — both are the externals D08 must wait on.
    await world.manifestStore.rows.insertResources(actorOne.id, [
      {
        kind: "openmuse-file",
        id: "file-1",
        externalKey: "openmuse-files/user-1/file-1/v1",
        state: "retryable_error",
        lastError: "byte store refused",
      },
      {
        kind: "openmuse-google-connection",
        id: "conn-gmail",
        externalKey: openmuseAlias(actorOne.id, "gmail"),
      },
    ]);
    const outcome = await world.purger.purgeRelationalData(actorOne.id);
    expect(outcome.status).toBe(409);
    if (outcome.status !== 409) return;
    // The 409 names the blocking rows with their state and reason.
    expect(
      outcome.blocked.find((row) => row.kind === "openmuse-file"),
    ).toMatchObject({
      id: "file-1",
      state: "retryable_error",
      lastError: "byte store refused",
    });
    expect(
      outcome.blocked.find((row) => row.kind === "openmuse-google-connection"),
    ).toMatchObject({ id: "conn-gmail", state: "pending" });
    // Nothing was deleted: every module fake intact, no batch, the manifest
    // still owes everything, and the marker still fences.
    for (const fake of world.fakes)
      expect(fake.idsOf(actorOne.id).length).toBeGreaterThan(0);
    expect(world.bots.batches).toEqual([]);
    const rows = await world.manifestStore.rows.listResources(actorOne.id);
    expect(rows.length).toBeGreaterThan(0);
    // No row landed deleted — the manifest is exactly as it stood.
    expect(rows.some((row) => row.state === "deleted")).toBe(false);
    expect(await store.isDisabled(actorOne.id)).toBe(true);
    // The admin route answers the same 409.
    session = actorAdmin;
    const response = await world
      .adminApp()
      .request(`/api/admin/openmuse-deletion/${actorOne.id}/purge-relational`, {
        method: "POST",
      });
    expect(response.status).toBe(409);
    expect(world.bots.batches).toEqual([]);
  });

  test("a blocked row's recorded reason is sanitized in the 409 (G06)", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // A recorded refusal may quote the credential it failed on — the 409
    // payload is an exit like the 200 report, never a raw-reason surface.
    await world.manifestStore.rows.insertResources(actorOne.id, [
      {
        kind: "openmuse-file",
        id: "file-1",
        externalKey: "openmuse-files/user-1/file-1/v1",
        state: "retryable_error",
        lastError:
          "provider refused: bearer ya29.a0AfH6SMBx-more-than-forty-chars-of-token",
      },
    ]);
    const outcome = await world.purger.purgeRelationalData(actorOne.id);
    expect(outcome.status).toBe(409);
    if (outcome.status !== 409) return;
    expect(outcome.blocked[0]?.lastError).toBe(
      "redacted: the recorded reason may quote a credential",
    );
  });

  test("a DB failure mid-walk keeps finished modules deleted, retains the failed kind's rows for the retry, and the retry completes", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // The goals seam fails once — mid-walk, after Bot and Channel, before
    // Idea — so the pass has work both behind and ahead of the failure.
    world.goals.failNext = true;
    const outcome = await world.purger.purgeRelationalData(actorOne.id);
    expect(outcome.status).toBe(200);
    if (outcome.status !== 200) return;
    expect(outcome.report.completed).toBe(false);
    // Already-deleted modules stay deleted, and the walk continued past the
    // failure: every kind but goals completed in this one pass.
    for (const fake of world.fakes)
      if (fake !== world.goals) expect(fake.idsOf(actorOne.id)).toEqual([]);
    // The failed kind's rows are retained, retryable, with the reason.
    expect(world.goals.idsOf(actorOne.id)).toEqual(["goal-1"]);
    const goalRows = (
      await world.manifestStore.rows.listResources(actorOne.id)
    ).filter((row) => row.kind === "openmuse-goal");
    expect(goalRows.map((row) => row.state)).toEqual(["retryable_error"]);
    expect(goalRows[0]?.lastError).toContain("database down");
    expect(outcome.report.retryable).toEqual([
      {
        kind: "openmuse-goal",
        id: "goal-1",
        lastError: "database down",
      },
    ]);
    // The manifest survives for the retry and the marker stays fenced —
    // cleanup lag never reopens access.
    expect(
      (await world.manifestStore.rows.listResources(actorOne.id)).length,
    ).toBeGreaterThan(0);
    expect((await store.get(actorOne.id))?.phase).toBe("fenced");
    expect(await store.isDisabled(actorOne.id)).toBe(true);
    // The retry completes: the goal's rows go, the manifest empties, the
    // marker completes.
    const retry = await world.purger.retryCleanup(actorOne.id);
    expect(retry.status).toBe(200);
    if (retry.status !== 200) return;
    expect(retry.report.completed).toBe(true);
    expect(world.goals.idsOf(actorOne.id)).toEqual([]);
    expect(await world.manifestStore.rows.listResources(actorOne.id)).toEqual(
      [],
    );
    expect((await store.get(actorOne.id))?.phase).toBe("completed");
  });

  test("a markDeleted failure does not put already-settled rows in the retryable report", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // The marker write dies on the second row: the first is already deleted,
    // and re-marking it retryable would name one id in BOTH report arrays
    // with a "delete failed" reason on a row that is gone.
    const innerMarkDeleted = world.manifestStore.rows.markDeleted;
    let calls = 0;
    world.manifestStore.rows.markDeleted = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error("marker write refused");
      return innerMarkDeleted(...args);
    };
    const outcome = await world.purger.purgeRelationalData(actorOne.id);
    expect(outcome.status).toBe(200);
    if (outcome.status !== 200) return;
    const purgedIds = new Set(outcome.report.purged.map((row) => row.id));
    expect(
      outcome.report.retryable.filter((row) => purgedIds.has(row.id)),
    ).toEqual([]);
  });

  test("an unresolved marker gap row blocks finalize: kind alone exempts nothing and the manifest survives", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // A marker-enumeration gap from an earlier build: it names no resource,
    // so no seam can delete it — finalize must wait for a rebuild.
    await world.manifestStore.rows.insertResources(actorOne.id, [
      { kind: "openmuse-account-deletion", id: MODULE_GAP },
    ]);
    const outcome = await world.purger.purgeRelationalData(actorOne.id);
    expect(outcome.status).toBe(200);
    if (outcome.status !== 200) return;
    expect(outcome.report.completed).toBe(false);
    // The walk itself finished — every module emptied — but finalize
    // refused: the gap row survived, and with it the whole manifest.
    for (const fake of world.fakes) expect(fake.idsOf(actorOne.id)).toEqual([]);
    const after = await world.manifestStore.rows.listResources(actorOne.id);
    expect(
      after.some((row) => row.id === MODULE_GAP && row.state === "pending"),
    ).toBe(true);
    expect(
      after.filter((row) => row.state === "deleted").length,
    ).toBeGreaterThan(0);
    expect((await store.get(actorOne.id))?.phase).toBe("fenced");
  });

  test("never touches user 2's identical-shaped rows: counts before and after are equal", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    const before = world.countsOf(actorTwo.id);
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    await world.purger.purgeRelationalData(actorOne.id);
    expect(world.countsOf(actorTwo.id)).toEqual(before);
    // And no batch ever named user 2 — every removal was owner-scoped.
    for (const fake of world.fakes)
      expect(fake.batches.every((batch) => batch.owner === actorOne.id)).toBe(
        true,
      );
  });

  test("§9 stands after completion: a repeat delete resurrects nothing and restore is gone for good", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    await world.purger.purgeRelationalData(actorOne.id);
    expect((await store.get(actorOne.id))?.phase).toBe("completed");
    // A repeat delete's manifest rebuild resurrects nothing: the completed
    // marker answers an empty manifest and inserts no rows.
    const rebuilt = await world.manifest.buildManifest(actorOne.id);
    expect(rebuilt.phase).toBe("completed");
    expect(rebuilt.resources).toEqual([]);
    expect(await world.manifestStore.rows.listResources(actorOne.id)).toEqual(
      [],
    );
    // D05's restore answers 410 for good — nothing is restorable once the
    // relational purge completed, whatever the calendar says.
    const restore = createOpenMuseDeletionRestore({
      marker: store,
      now: () => clock.now,
    });
    const outcome = await restore(actorOne.id);
    expect(outcome.status).toBe(410);
  });

  test("§9's phase gate: a restored account is never purged — the walk refuses 409 before touching a row", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // D05 lifts the fence: the account is live again, its manifest rows
    // deliberately retained — the purge must refuse, not destroy them.
    await store.restore(
      actorOne.id,
      new Date(clock.now.getTime() + 30 * 86_400_000),
    );
    const before = world.countsOf(actorOne.id);
    const refused = await world.purger.purgeRelationalData(actorOne.id);
    expect(refused.status).toBe(409);
    if (refused.status !== 409) return;
    expect(refused.blocked).toEqual([]);
    expect(refused.refused).toContain("restored");
    // Nothing moved: every module fake still holds its rows, and no batch
    // was ever named — the marker stays restored, restore stays possible.
    expect(world.countsOf(actorOne.id)).toEqual(before);
    for (const fake of world.fakes) expect(fake.batches).toEqual([]);
    expect((await store.get(actorOne.id))?.phase).toBe("restored");
    // The admin route answers the refusal as a 409 with the reason.
    session = actorAdmin;
    const response = await world
      .adminApp()
      .request(`/api/admin/openmuse-deletion/${actorOne.id}/purge-relational`, {
        method: "POST",
      });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("restored");
  });

  test("G06 on the report's exit: a token-shaped retryable reason is redacted before the admin route answers it", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.add(actorOne.id);
    await world.manifest.buildManifest(actorOne.id);
    // A kind's walk fails quoting a credential: the reason lands retryable
    // on the row, and the route must answer it sanitized.
    const token = `purge failed with ya29.${"a0ARrdaM".repeat(8)}`;
    world.goals.hardDelete = async () => {
      throw new Error(token);
    };
    session = actorAdmin;
    const response = await world
      .adminApp()
      .request(`/api/admin/openmuse-deletion/${actorOne.id}/purge-relational`, {
        method: "POST",
      });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      purge: { retryable: Array<{ id: string; lastError: string }> };
    };
    const goalRow = body.purge.retryable.find((row) => row.id === "goal-1");
    expect(goalRow?.lastError).toBe(OPENMUSE_REDACTED_LAST_ERROR);
    expect(JSON.stringify(body)).not.toContain("ya29.");
  });

  test("§9's phase gate: a missing marker is refused too — no purge invents a deletion", async () => {
    const world = relationalPurgeWorld();
    world.seedBothUsers();
    markers.clear();
    const refused = await world.purger.purgeRelationalData(actorOne.id);
    expect(refused.status).toBe(409);
    if (refused.status !== 409) return;
    expect(refused.refused).toContain("missing");
    for (const fake of world.fakes) expect(fake.batches).toEqual([]);
  });
});

/*
 * D09 (§9 retention/ops): backups containing deleted personal bytes expire
 * within the configured retention — the policy seam retentionElapsed is pure
 * and clock-injected, the window itself env-sized; a deployment's backup
 * window covering a deletion is noted ON the marker (noteBackupRetention, the
 * enforcement point — the backup system itself is deployment infrastructure,
 * honestly recorded, never claimed as removed); unresolved manifest rows stay
 * operator-visible through the admin cleanup endpoint (kind, safe id,
 * sanitized lastError, at — no bytes, no byte-store keys, no credentials),
 * survive failing retries without ever being silently cleared, and a
 * fully-cleaned deletion leaves only the non-personal audit summary.
 */
describe("backup retention and cleanup visibility (D09)", () => {
  const T0 = new Date("2026-10-13T00:00:00Z");
  const DAY_MS = 86_400_000;

  test("retentionElapsed: false before restoreUntil+retention (the manifest persists), true after; the unrestored marker falls back to the restore window", async () => {
    const marker = {
      disabledAt: T0,
      restoreUntil: new Date(T0.getTime() + 30 * DAY_MS),
    };
    // Day 59 — restoreUntil + 29, still inside the retention window.
    expect(retentionElapsed(marker, new Date(T0.getTime() + 59 * DAY_MS))).toBe(
      false,
    );
    // Day 61 — restoreUntil + 31, elapsed: eligible for the final archive.
    expect(retentionElapsed(marker, new Date(T0.getTime() + 61 * DAY_MS))).toBe(
      true,
    );
    // A marker that was never restored counts from D05's own fallback
    // deadline: disabledAt + the 30-day restore window.
    const unrestored = { disabledAt: T0, restoreUntil: null };
    expect(
      retentionElapsed(unrestored, new Date(T0.getTime() + 59 * DAY_MS)),
    ).toBe(false);
    expect(
      retentionElapsed(unrestored, new Date(T0.getTime() + 61 * DAY_MS)),
    ).toBe(true);
  });

  test("the retention window is env-sized: OPENMUSE_BACKUP_RETENTION_DAYS=7 shortens it; an unusable value keeps the §9 default", async () => {
    const previous = process.env.OPENMUSE_BACKUP_RETENTION_DAYS;
    try {
      process.env.OPENMUSE_BACKUP_RETENTION_DAYS = "7";
      expect(backupRetentionDays()).toBe(7);
      const marker = {
        disabledAt: T0,
        restoreUntil: new Date(T0.getTime() + 30 * DAY_MS),
      };
      // restoreUntil (day 30) + 7 = day 37 closes the window.
      expect(
        retentionElapsed(
          marker,
          new Date(T0.getTime() + 36 * DAY_MS),
          backupRetentionDays(),
        ),
      ).toBe(false);
      expect(
        retentionElapsed(
          marker,
          new Date(T0.getTime() + 38 * DAY_MS),
          backupRetentionDays(),
        ),
      ).toBe(true);
      // Garbage is not a window: the bound keeps the contract's default.
      process.env.OPENMUSE_BACKUP_RETENTION_DAYS = "not-a-number";
      expect(backupRetentionDays()).toBe(30);
    } finally {
      if (previous === undefined)
        delete process.env.OPENMUSE_BACKUP_RETENTION_DAYS;
      else process.env.OPENMUSE_BACKUP_RETENTION_DAYS = previous;
    }
  });

  test("noteBackupRetention records the honest bookkeeping row — covered-at, retention days, expiry — on the marker, and nothing for a marker-less user", async () => {
    markers.clear();
    restoredUntil.clear();
    completed.clear();
    markers.add(actorOne.id);
    clock.now = T0;
    const recorded: Array<{ userId: string; entries: string[] }> = [];
    const retention = createOpenMuseBackupRetention({
      marker: store,
      record: async (userId, entries) => recorded.push({ userId, entries }),
      now: () => clock.now,
    });
    const entry = await retention.noteBackupRetention(actorOne.id);
    expect(entry).not.toBeNull();
    // The row names the policy facts, never bytes or credentials: covered
    // now, under the default 30-day retention, expiring at the deadline the
    // pure seam consults (restore window 30 + retention 30 = day 60).
    expect(entry).toContain("openmuse-backup-retention");
    expect(entry).toContain(`covered-at:${T0.toISOString()}`);
    expect(entry).toContain("retention-days:30");
    expect(entry).toContain(
      `expires:${new Date(T0.getTime() + 60 * DAY_MS).toISOString()}`,
    );
    expect(recorded).toEqual([{ userId: actorOne.id, entries: [entry] }]);
    // A user without a marker was never deleted — nothing covers them.
    expect(await retention.noteBackupRetention("never-deleted")).toBe(null);
    expect(recorded).toHaveLength(1);
  });

  /**
   * The D09 visibility world: the shared phase-capable fake store, the
   * manifest-rows fake, and the admin app the cleanup route rides — the
   * D05/D06/D08 factory shape, nothing new mounted.
   */
  function cleanupWorld() {
    markers.clear();
    restoredUntil.clear();
    completed.clear();
    session = actorOne;
    clock.now = T0;
    const manifestStore = purgeManifestRows();
    const cleanupView = createOpenMuseDeletionCleanupView({
      markers: store,
      rows: manifestStore.rows,
      now: () => clock.now,
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/openmuse-deletion",
      createOpenMuseDeletionAdminRoutes({
        requireUser,
        restore: createOpenMuseDeletionRestore({
          marker: store,
          now: () => clock.now,
        }),
        cleanupView,
      }),
    );
    return { app, manifestStore };
  }

  test("the cleanup endpoint lists unresolved rows with kind/id/state/sanitized-lastError/at, counts the retryable, flags retention; a non-admin is refused 403", async () => {
    const world = cleanupWorld();
    markers.add(actorOne.id);
    await world.manifestStore.rows.insertResources(actorOne.id, [
      {
        kind: "openmuse-file",
        id: "file-1",
        externalKey: "openmuse-files/user-1/file-1/v1",
        state: "retryable_error",
        lastError: "byte store refused to delete",
      },
      // Pending, never attempted — owed exactly like the retryable one.
      {
        kind: "openmuse-google-connection",
        id: "conn-1",
        externalKey: "alias-user-1-gmail",
      },
      {
        kind: "openmuse-task",
        id: "task-1",
        state: "retryable_error",
        // G06's display guard, server-side: a reason quoting a token never
        // reaches the operator surface.
        lastError: `refresh failed with ya29.${"a0ARrdaM".repeat(8)} and Bearer abc`,
      },
      // Terminal — the purge closed it; it is not owed anything.
      { kind: "openmuse-goal", id: "goal-1", state: "deleted" },
    ]);
    session = actorAdmin;
    clock.now = new Date(T0.getTime() + 40 * DAY_MS);
    const response = await world.app.request(
      "/api/admin/openmuse-deletion/cleanup",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cleanup: {
        retentionDays: number;
        markers: Array<Record<string, unknown>>;
      };
    };
    expect(body.cleanup.retentionDays).toBe(30);
    const mine = body.cleanup.markers.find(
      (marker) => marker.userId === actorOne.id,
    );
    // The whole entry: audit facts plus the unresolved rows — and nothing
    // else. restoreUntil is null (never restored); retention has 20 days to
    // run at day 40 of a day-60 deadline.
    expect(mine).toEqual({
      userId: actorOne.id,
      disabledAt: T0.toISOString(),
      phase: "fenced",
      restoreUntil: null,
      retentionElapsed: false,
      retryable: 2,
      unresolved: [
        {
          kind: "openmuse-file",
          id: "file-1",
          state: "retryable_error",
          lastError: "byte store refused to delete",
          at: T0.toISOString(),
        },
        {
          kind: "openmuse-google-connection",
          id: "conn-1",
          state: "pending",
          at: T0.toISOString(),
        },
        {
          kind: "openmuse-task",
          id: "task-1",
          state: "retryable_error",
          lastError: "redacted: the recorded reason may quote a credential",
          at: T0.toISOString(),
        },
      ],
    });
    // Sanitized visibility — no bytes, no byte-store keys, no aliases, no
    // token shapes anywhere in the answer.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("openmuse-files/user-1");
    expect(serialized).not.toContain("alias-user-1-gmail");
    expect(serialized).not.toContain("ya29.");
    // A non-admin never reaches the visibility.
    session = actorOne;
    expect(
      (await world.app.request("/api/admin/openmuse-deletion/cleanup")).status,
    ).toBe(403);
  });

  test("the retention flag flips once the window closes, and the marker with its unresolved rows persists past it — nothing is silently archived", async () => {
    const world = cleanupWorld();
    markers.add(actorOne.id);
    await world.manifestStore.rows.insertResources(actorOne.id, [
      {
        kind: "openmuse-file",
        id: "file-1",
        externalKey: "openmuse-files/user-1/file-1/v1",
        state: "retryable_error",
        lastError: "byte store refused to delete",
      },
    ]);
    session = actorAdmin;
    clock.now = new Date(T0.getTime() + 61 * DAY_MS);
    const response = await world.app.request(
      "/api/admin/openmuse-deletion/cleanup",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cleanup: {
        markers: Array<{
          userId: string;
          retentionElapsed: boolean;
          unresolved: unknown[];
        }>;
      };
    };
    const mine = body.cleanup.markers.find(
      (marker) => marker.userId === actorOne.id,
    );
    expect(mine?.retentionElapsed).toBe(true);
    // The row the deletion still owes is as visible after the window as
    // before it — the archive is the operator's act, never a silent clear.
    expect(mine?.unresolved).toHaveLength(1);
    expect(
      await world.manifestStore.rows.listResources(actorOne.id),
    ).toHaveLength(1);
  });

  test("a fully-cleaned deletion answers only the non-personal audit summary — timestamps and phases, no rows", async () => {
    const world = cleanupWorld();
    markers.add(actorOne.id);
    // D08's terminal state: the purge emptied the manifest and completed the
    // marker — the tombstone is the audit proof that remains.
    markers.delete(actorOne.id);
    completed.add(actorOne.id);
    session = actorAdmin;
    const response = await world.app.request(
      "/api/admin/openmuse-deletion/cleanup",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cleanup: { markers: Array<Record<string, unknown>> };
    };
    expect(body.cleanup.markers).toEqual([
      {
        userId: actorOne.id,
        disabledAt: T0.toISOString(),
        phase: "completed",
        restoreUntil: null,
        retentionElapsed: false,
        retryable: 0,
        unresolved: [],
      },
    ]);
    // The phases are recorded on the marker the audit summary answers from.
    expect((await store.get(actorOne.id))?.phase).toBe("completed");
  });

  test("unresolved visibility persists across sweeps: a failing byte purge and its failing retry never silently clear a row", async () => {
    markers.clear();
    restoredUntil.clear();
    completed.clear();
    session = actorOne;
    clock.now = T0;
    const events: string[] = [];
    const byteStore = deletionByteStore(events);
    const fileRows = deletionFileRows(events);
    const files = createOpenMuseFileStore({ rows: fileRows, byteStore });
    const manifestStore = purgeManifestRows();
    const manifest = createOpenMuseDeletionManifest({
      rows: manifestStore.rows,
      marker: store,
      files,
    });
    const purger = createOpenMuseFileBytePurger({
      rows: manifestStore.rows,
      marker: store,
      byteStore,
      files,
    });
    const uploaded = await files.upload({
      ownerUserId: actorOne.id,
      name: "lease.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      idempotencyKey: null,
    });
    markers.add(actorOne.id);
    await manifest.buildManifest(actorOne.id);
    const key = openMuseFileByteKey(
      actorOne.id,
      uploaded.file.id,
      uploaded.file.versionId,
    );
    byteStore.failures.add(key);
    await purger.purgeFileBytes(actorOne.id);
    const cleanupView = createOpenMuseDeletionCleanupView({
      markers: store,
      rows: manifestStore.rows,
      now: () => clock.now,
    });
    const first = await cleanupView();
    const owed = first.markers.find(
      (marker) => marker.userId === actorOne.id,
    )?.unresolved;
    const owedCount = (await manifestStore.rows.listResources(actorOne.id))
      .length;
    // The file row the failed purge owes, with its recorded reason — plain,
    // so G06's guard passes it through truncated to 120 (the byte-store key
    // the reason quotes runs long; nothing token-shaped, no redaction).
    const reason = `byte store refused to delete ${key}`;
    expect(owed?.find((row) => row.kind === "openmuse-file")).toEqual({
      kind: "openmuse-file",
      id: uploaded.file.id,
      state: "retryable_error",
      lastError: reason.slice(0, 120),
      at: T0.toISOString(),
    });
    // …the marker's own row, D04's hook root, still pending…
    expect(
      owed?.find((row) => row.kind === "openmuse-account-deletion"),
    ).toEqual({
      kind: "openmuse-account-deletion",
      id: actorOne.id,
      state: "pending",
      at: T0.toISOString(),
    });
    // …and D04's gap rows for the seams this world never wired — owed and
    // operator-visible exactly like the enumerated ones.
    expect(owed?.filter((row) => row.id === MODULE_GAP).length).toBeGreaterThan(
      0,
    );
    expect(owed).toHaveLength(owedCount);
    // The retry fails again — the bytes are still refused, every row stays:
    // the visibility after is the visibility before, nothing silently cleared.
    await purger.retryCleanup(actorOne.id);
    const second = await cleanupView();
    expect(
      second.markers.find((marker) => marker.userId === actorOne.id)
        ?.unresolved,
    ).toEqual(owed);
    expect(await manifestStore.rows.listResources(actorOne.id)).toHaveLength(
      owedCount,
    );
  });
});
