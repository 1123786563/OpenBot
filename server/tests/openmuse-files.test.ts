import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createHash } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  OpenMuseConnectionRefusedError,
  type OpenMuseGoogleOAuth,
} from "../src/openmuse-connectors/google-oauth";
import type { StoredOpenMuseGoogleConnection } from "../src/openmuse-connectors/store";
import type { FileByteStore } from "../src/openmuse-files/bytes";
import { createOpenMuseFilesRoutes } from "../src/openmuse-files/routes";
import {
  createOpenMuseFileStore,
  type OpenMuseFileRows,
  type OpenMuseFileStore,
  OpenMuseOwnerDisabledError,
  type StoredOpenMuseFile,
} from "../src/openmuse-files/store";
import {
  buildOpenMuseMailClient,
  type MailWireDial,
} from "../src/openmuse-mail/client";

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

let currentActor: AuthenticatedActor = actorOne;
let guardAdmits = true;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  if (!guardAdmits) {
    return context.json({ error: "Sign in first." }, 401);
  }
  context.set("actor", currentActor);
  await next();
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-memory row store: same contract as the drizzle rows, rows live as data. */
function fakeRows(): OpenMuseFileRows & {
  files: StoredOpenMuseFile[];
  versions: StoredOpenMuseFileVersion[];
  latestVersionCalls: number;
} {
  const files: StoredOpenMuseFile[] = [];
  const versions: StoredOpenMuseFileVersion[] = [];
  const disabled = new Set<string>();
  let latestVersionCalls = 0;
  return {
    files,
    versions,
    get latestVersionCalls() {
      return latestVersionCalls;
    },
    insertFile: async (file) => {
      if (
        file.idempotencyKey !== null &&
        files.some(
          (row) =>
            row.ownerUserId === file.ownerUserId &&
            row.idempotencyKey === file.idempotencyKey &&
            row.deletedAt === null,
        )
      ) {
        throw new Error("duplicate idempotency key");
      }
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
      if (row === undefined) {
        return null;
      }
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
      if (row === undefined) {
        return false;
      }
      row.deletedAt = new Date();
      return true;
    },
    insertVersion: async (version) => {
      versions.push({ ...version });
    },
    insertFileWithVersion: async (file, version) => {
      if (
        file.idempotencyKey !== null &&
        files.some(
          (row) =>
            row.ownerUserId === file.ownerUserId &&
            row.idempotencyKey === file.idempotencyKey &&
            row.deletedAt === null,
        )
      ) {
        throw new Error("duplicate idempotency key");
      }
      // Both rows or neither: the fake mirrors the drizzle transaction.
      files.push({ ...file });
      versions.push({ ...version });
    },
    sumBytesByOwner: async (ownerUserId) =>
      files
        .filter((row) => row.ownerUserId === ownerUserId && !row.deletedAt)
        .reduce((total, row) => total + row.size, 0),
    latestVersion: async (fileId) => {
      latestVersionCalls += 1;
      return (
        [...versions].filter((row) => row.fileId === fileId).at(-1) ?? null
      );
    },
    latestVersionsForFileIds: async (fileIds) => {
      const latest = new Map<string, StoredOpenMuseFileVersion>();
      for (const row of [...versions].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      )) {
        if (fileIds.includes(row.fileId) && !latest.has(row.fileId))
          latest.set(row.fileId, row);
      }
      return [...latest.values()];
    },
    versionsByFile: async (fileId) =>
      [...versions]
        .filter((row) => row.fileId === fileId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    deleteVersions: async (versionIds) => {
      for (const versionId of versionIds)
        versions.splice(
          versions.findIndex((row) => row.versionId === versionId),
          1,
        );
    },
    listByOwner: async (ownerUserId, { limit, before }) =>
      files
        .filter((row) => row.ownerUserId === ownerUserId && !row.deletedAt)
        .filter((row) =>
          before
            ? row.createdAt < before.createdAt ||
              (row.createdAt.getTime() === before.createdAt.getTime() &&
                row.id < before.id)
            : true,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id > b.id ? -1 : 1),
        )
        .slice(0, limit),
    ownerDisabled: async (ownerUserId) => disabled.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      disabled.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      disabled.delete(ownerUserId);
    },
    // No deletedAt filter: tombstoned files' bytes are D06's to purge too —
    // the deletion manifest's source must see them (mirrors the drizzle rows).
    versionsByOwner: async (ownerUserId) =>
      versions.filter((version) => {
        const file = files.find((row) => row.id === version.fileId);
        return file !== undefined && file.ownerUserId === ownerUserId;
      }),
    // D06's purge seam — these suites never purge, so the fake needs none.
    hardDeleteFile: async () => {},
  };
}

/** In-memory byte store that counts writes and logs read keys. */
function fakeBytes(): FileByteStore & {
  writes: Map<string, number>;
  data: Map<string, Uint8Array>;
  gets: string[];
} {
  const writes = new Map<string, number>();
  const data = new Map<string, Uint8Array>();
  const gets: string[] = [];
  return {
    writes,
    data,
    gets,
    put: async (key, bytes) => {
      writes.set(key, (writes.get(key) ?? 0) + 1);
      data.set(key, bytes);
    },
    get: async (key) => {
      gets.push(key);
      return data.get(key) ?? null;
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

type Fixture = {
  store: OpenMuseFileStore;
  rows: ReturnType<typeof fakeRows>;
  bytes: ReturnType<typeof fakeBytes>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixtureFor(overrides: Partial<Fixture> = {}): Fixture {
  const rows = fakeRows();
  const bytes = fakeBytes();
  const store = createOpenMuseFileStore({
    rows,
    byteStore: bytes,
    ...(overrides.pruneGraceMs !== undefined
      ? { pruneGraceMs: overrides.pruneGraceMs }
      : {}),
  });
  const app = createOpenMuseFilesRoutes({ store, requireUser });
  return { store, rows, bytes, app, ...overrides };
}

function uploadBody(bytes: Uint8Array, name: string, type: string): FormData {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return form;
}

function post(
  app: Hono<{ Variables: AppVariables }>,
  body: FormData,
  idempotencyKey?: string,
): Promise<Response> {
  return app.request("/", {
    method: "POST",
    body,
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

/** One uploaded file's answer DTO, so download tests reuse the upload truth. */
type UploadedFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  versionId: string;
  createdAt: string;
};

async function uploadOne(
  fixture: Fixture,
  bytes: Uint8Array,
  name = "f02.txt",
): Promise<UploadedFile> {
  const response = await post(
    fixture.app,
    uploadBody(bytes, name, "text/plain"),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as UploadedFile;
}

describe("POST / (upload)", () => {
  test("stores bytes under a server-derived key and returns stable id, versionId, size and sha256", async () => {
    const fixture = fixtureFor();
    const bytes = new TextEncoder().encode("notes".repeat(2_000));
    const response = await post(
      fixture.app,
      uploadBody(bytes, "notes.txt", "text/plain"),
      "key-1",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe("string");
    expect(typeof body.versionId).toBe("string");
    expect(body.name).toBe("notes.txt");
    expect(body.mimeType).toBe("text/plain");
    expect(body.size).toBe(bytes.byteLength);
    expect(body.sha256).toBe(sha256(bytes));
    expect(typeof body.createdAt).toBe("string");

    const key = [...fixture.bytes.writes.keys()].at(0) ?? "";
    expect(key.startsWith("openmuse-files/user-1/")).toBe(true);
    expect(fixture.bytes.data.get(key)).toEqual(bytes);
  });

  test("same owner + same idempotency key returns the same file and writes bytes once", async () => {
    const fixture = fixtureFor();
    const first = await post(
      fixture.app,
      uploadBody(new Uint8Array(100), "a.txt", "text/plain"),
      "retry-key",
    );
    expect(first.status).toBe(201);
    const retried = await post(
      fixture.app,
      uploadBody(new Uint8Array(100), "a.txt", "text/plain"),
      "retry-key",
    );
    expect(retried.status).toBe(200);
    const firstBody = (await first.json()) as { id: string; versionId: string };
    const retriedBody = (await retried.json()) as {
      id: string;
      versionId: string;
    };
    expect(retriedBody.id).toBe(firstBody.id);
    expect(retriedBody.versionId).toBe(firstBody.versionId);
    expect(fixture.rows.files).toHaveLength(1);
    expect(
      [...fixture.bytes.writes.values()].every((count) => count === 1),
    ).toBe(true);
  });

  test("the same key for a different owner creates a second file", async () => {
    const fixture = fixtureFor();
    await post(
      fixture.app,
      uploadBody(new Uint8Array(100), "a.txt", "text/plain"),
      "shared-key",
    );
    currentActor = actorTwo;
    try {
      const response = await post(
        fixture.app,
        uploadBody(new Uint8Array(100), "a.txt", "text/plain"),
        "shared-key",
      );
      expect(response.status).toBe(201);
    } finally {
      currentActor = actorOne;
    }
    expect(fixture.rows.files).toHaveLength(2);
    expect(fixture.rows.files.map((row) => row.ownerUserId).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  test.each([
    [
      "general over 20 MiB",
      20 * 1024 * 1024 + 1,
      "application/octet-stream",
      413,
    ],
    ["pdf over 10 MiB", 10 * 1024 * 1024 + 1, "application/pdf", 413],
    [
      "general exactly 20 MiB",
      20 * 1024 * 1024,
      "application/octet-stream",
      201,
    ],
    ["pdf exactly 10 MiB", 10 * 1024 * 1024, "application/pdf", 201],
  ])("%s answers %d", async (_label, size, mimeType, expected) => {
    const fixture = fixtureFor();
    /*
     * This deployment's multipart parser derives the part's declared type
     * from the filename extension, not the part's Content-Type header (see
     * channels/attachments.ts), so the extension carries the claim.
     */
    const name = mimeType === "application/pdf" ? "big.pdf" : "big.bin";
    const response = await post(
      fixture.app,
      uploadBody(new Uint8Array(size), name, mimeType),
    );
    expect(response.status).toBe(expected);
  });

  test("pdf magic bytes under a false claim still get the pdf ceiling", async () => {
    const fixture = fixtureFor();
    const bytes = new Uint8Array(11 * 1024 * 1024);
    bytes.set(new TextEncoder().encode("%PDF-"));
    const response = await post(
      fixture.app,
      uploadBody(bytes, "lie.bin", "application/octet-stream"),
    );
    expect(response.status).toBe(413);
  });

  test("refuses a missing file part and a directory-traversal-free key is always server-derived", async () => {
    const fixture = fixtureFor();
    const form = new FormData();
    form.append("not-file", "hello");
    const response = await post(fixture.app, form);
    expect(response.status).toBe(400);
    expect(fixture.bytes.writes.size).toBe(0);
  });

  test("refuses a name carrying path separators or a NUL before any byte is written", async () => {
    // The rename route's rule, applied at the parse: a NUL would otherwise
    // fail at the row insert AFTER the bytes landed (a misleading 503 and
    // an orphan blob).
    const fixture = fixtureFor();
    for (const name of ["a/b.txt", "a\\b.txt", "nul\u0000byte.txt"]) {
      const response = await post(
        fixture.app,
        uploadBody(new Uint8Array(4), name, "text/plain"),
      );
      expect(response.status).toBe(400);
    }
    expect(fixture.bytes.writes.size).toBe(0);
    expect(fixture.rows.files).toHaveLength(0);
  });
});

describe("GET / (list)", () => {
  test("returns only the owner's files, newest first, id breaking ties", async () => {
    const fixture = fixtureFor();
    const when = new Date("2026-10-01T00:00:00Z");
    for (const [id, minutes] of [
      ["file-a", 0],
      ["file-b", 0],
      ["file-c", 5],
    ] as const) {
      await fixture.rows.insertFile({
        id,
        ownerUserId: "user-1",
        name: `${id}.txt`,
        mimeType: "text/plain",
        size: 1,
        sha256: "0".repeat(64),
        idempotencyKey: `key-${id}`,
        createdAt: new Date(when.getTime() + minutes * 60_000),
        deletedAt: null,
      });
      await fixture.rows.insertVersion({
        versionId: `version-${id}`,
        fileId: id,
        bytePath: `openmuse-files/user-1/${id}/version-${id}`,
        sha256: "0".repeat(64),
        createdAt: new Date(when.getTime() + minutes * 60_000),
      });
    }
    await fixture.rows.insertFile({
      id: "file-foreign",
      ownerUserId: "user-2",
      name: "foreign.txt",
      mimeType: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      idempotencyKey: "key-foreign",
      createdAt: new Date(when.getTime() + 9 * 60_000),
      deletedAt: null,
    });

    const response = await fixture.app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      files: Array<Record<string, unknown>>;
    };
    expect(body.files.map((file) => file.id)).toEqual([
      "file-c",
      "file-b",
      "file-a",
    ]);
    expect(body.files[0]).toEqual({
      id: "file-c",
      name: "file-c.txt",
      mimeType: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      versionId: "version-file-c",
      createdAt: new Date(when.getTime() + 5 * 60_000).toISOString(),
    });
  });

  test("pages with an opaque cursor: default 25, max 100, second page continues", async () => {
    const fixture = fixtureFor();
    const when = new Date("2026-10-01T00:00:00Z");
    for (let index = 0; index < 30; index += 1) {
      const id = `f${index.toString().padStart(2, "0")}`;
      await fixture.rows.insertFile({
        id,
        ownerUserId: "user-1",
        name: `${id}.txt`,
        mimeType: "text/plain",
        size: 1,
        sha256: "0".repeat(64),
        idempotencyKey: `key-${id}`,
        createdAt: new Date(when.getTime() + index * 1_000),
        deletedAt: null,
      });
      await fixture.rows.insertVersion({
        versionId: `version-${id}`,
        fileId: id,
        bytePath: `openmuse-files/user-1/${id}/version-${id}`,
        sha256: "0".repeat(64),
        createdAt: new Date(when.getTime() + index * 1_000),
      });
    }
    const first = await fixture.app.request("/?limit=25");
    const firstBody = (await first.json()) as {
      files: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(firstBody.files).toHaveLength(25);
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await fixture.app.request(
      `/?limit=25&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
    );
    const secondBody = (await second.json()) as {
      files: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(secondBody.files.map((file) => file.id)).toEqual([
      "f04",
      "f03",
      "f02",
      "f01",
      "f00",
    ]);
    expect(secondBody.nextCursor).toBeUndefined();

    const refused = await fixture.app.request("/?limit=abc");
    expect(refused.status).toBe(400);
    const clamped = await fixture.app.request("/?limit=101");
    expect(clamped.status).toBe(200);
    const refusedCursor = await fixture.app.request("/?cursor=not-base64");
    expect(refusedCursor.status).toBe(400);
  });
});

describe("GET /:id and /:id/content (F02 download)", () => {
  test("the owner downloads the exact original bytes with the stored type and a sha256 ETag", async () => {
    const fixture = fixtureFor();
    const bytes = new TextEncoder().encode("F02 fixture ".repeat(100));
    const uploaded = await uploadOne(fixture, bytes);
    const response = await fixture.app.request(`/${uploaded.id}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("ETag")).toBe(`"sha256:${sha256(bytes)}"`);
    expect(response.headers.get("Content-Length")).toBe(
      String(bytes.byteLength),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("a foreign id answers 404, not 403, for both metadata and content", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(
      fixture,
      new TextEncoder().encode("private"),
    );
    currentActor = actorTwo;
    try {
      const metadata = await fixture.app.request(`/${uploaded.id}`);
      expect(metadata.status).toBe(404);
      const content = await fixture.app.request(`/${uploaded.id}/content`);
      expect(content.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
  });

  test("a missing id answers 404 for both routes", async () => {
    const fixture = fixtureFor();
    expect((await fixture.app.request("/no-such-file")).status).toBe(404);
    expect((await fixture.app.request("/no-such-file/content")).status).toBe(
      404,
    );
  });

  test("a tombstoned file refuses its old URL with no bytes and leaves the list", async () => {
    const fixture = fixtureFor();
    const bytes = new TextEncoder().encode("deleted soon");
    const uploaded = await uploadOne(fixture, bytes);
    const row = fixture.rows.files.find((file) => file.id === uploaded.id);
    expect(row).toBeDefined();
    row!.deletedAt = new Date();

    const content = await fixture.app.request(`/${uploaded.id}/content`);
    expect(content.status).toBe(404);
    const leaked = new TextDecoder().decode(
      new Uint8Array(await content.arrayBuffer()),
    );
    expect(leaked).not.toContain("deleted soon");

    const metadata = await fixture.app.request(`/${uploaded.id}`);
    expect(metadata.status).toBe(404);

    const list = await fixture.app.request("/");
    const listed = (await list.json()) as { files: Array<{ id: string }> };
    expect(listed.files.map((file) => file.id)).not.toContain(uploaded.id);
  });

  test("a byte-store failure answers 503 with no partial body", async () => {
    const fixture = fixtureFor();
    const bytes = new TextEncoder().encode("storage will fail");
    const uploaded = await uploadOne(fixture, bytes);
    fixture.bytes.get = async () => {
      throw new Error("byte store down");
    };
    const response = await fixture.app.request(`/${uploaded.id}/content`);
    expect(response.status).toBe(503);
    const body = new TextDecoder().decode(
      new Uint8Array(await response.arrayBuffer()),
    );
    expect(body).not.toContain("storage will fail");
  });

  test("GET /:id returns the F01 metadata DTO without touching bytes", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(
      fixture,
      new TextEncoder().encode("metadata only"),
      "meta.txt",
    );
    const response = await fixture.app.request(`/${uploaded.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(uploaded);
    expect(fixture.bytes.gets).toEqual([]);
  });

  test("byte-path payloads in query or headers are ignored: the server key always wins", async () => {
    const fixture = fixtureFor();
    const bytes = new TextEncoder().encode("server key wins");
    const uploaded = await uploadOne(fixture, bytes);
    const response = await fixture.app.request(
      `/${uploaded.id}/content?path=${encodeURIComponent("../../etc/passwd")}`,
      {
        headers: {
          "X-Byte-Path": "openmuse-files/user-2/other/other-version",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(fixture.bytes.gets).toEqual([
      `openmuse-files/user-1/${uploaded.id}/${uploaded.versionId}`,
    ]);
  });
});

describe("PATCH /:id (F03 rename)", () => {
  async function patch(
    fixture: Fixture,
    id: string,
    name: unknown,
  ): Promise<Response> {
    return fixture.app.request(`/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  test("renames display metadata only: name moves, id/versionId/sha256/size stay, bytes untouched", async () => {
    const fixture = fixtureFor();
    const bytes = new TextEncoder().encode("rename me");
    const uploaded = await uploadOne(fixture, bytes, "old-name.txt");
    const writesBefore = fixture.bytes.writes.size;

    const response = await patch(fixture, uploaded.id, "new-name.txt");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...uploaded,
      name: "new-name.txt",
    });

    const row = fixture.rows.files.find((file) => file.id === uploaded.id);
    expect(row?.name).toBe("new-name.txt");
    expect(fixture.bytes.writes.size).toBe(writesBefore);
    expect(fixture.bytes.gets).toEqual([]);

    const content = await fixture.app.request(`/${uploaded.id}/content`);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
  });

  test("a foreign rename answers 404 and leaves the name alone", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(
      fixture,
      new TextEncoder().encode("private"),
      "mine.txt",
    );
    currentActor = actorTwo;
    try {
      const response = await patch(fixture, uploaded.id, "theirs.txt");
      expect(response.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
    const row = fixture.rows.files.find((file) => file.id === uploaded.id);
    expect(row?.name).toBe("mine.txt");
  });

  test.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["over 255 characters", "x".repeat(256)],
    ["a path separator /", "a/b.txt"],
    ["a path separator \\", "a\\b.txt"],
    ["a NUL byte", "a\0b"],
  ])("refuses a name with %s", async (_label, name) => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new Uint8Array(4), "keep.txt");
    const response = await patch(fixture, uploaded.id, name);
    expect(response.status).toBe(400);
  });

  test("a tombstoned file answers 404", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new Uint8Array(4), "gone.txt");
    const deleted = await fixture.app.request(`/${uploaded.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    const response = await patch(fixture, uploaded.id, "renamed.txt");
    expect(response.status).toBe(404);
  });
});

describe("DELETE /:id (F03 delete)", () => {
  test("tombstones immediately: gone from the list, metadata 404, content 404, bytes kept for D06", async () => {
    const fixture = fixtureFor();
    const bytes = new TextEncoder().encode("delete me");
    const uploaded = await uploadOne(fixture, bytes, "doomed.txt");
    const byteKey = `openmuse-files/user-1/${uploaded.id}/${uploaded.versionId}`;

    const deleted = await fixture.app.request(`/${uploaded.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const list = await fixture.app.request("/");
    const listed = (await list.json()) as { files: Array<{ id: string }> };
    expect(listed.files.map((file) => file.id)).not.toContain(uploaded.id);

    const metadata = await fixture.app.request(`/${uploaded.id}`);
    expect(metadata.status).toBe(404);

    const content = await fixture.app.request(`/${uploaded.id}/content`);
    expect(content.status).toBe(404);

    const row = fixture.rows.files.find((file) => file.id === uploaded.id);
    expect(row?.deletedAt).toBeInstanceOf(Date);
    // The physical blob survives tombstone — physical purge is D06's manifest.
    expect(fixture.bytes.data.get(byteKey)).toEqual(bytes);
  });

  test("a second delete answers 404", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new Uint8Array(4), "once.txt");
    await fixture.app.request(`/${uploaded.id}`, { method: "DELETE" });
    const again = await fixture.app.request(`/${uploaded.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  test("a foreign delete answers 404 and leaves the owner's file live", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new Uint8Array(4), "safe.txt");
    currentActor = actorTwo;
    try {
      const response = await fixture.app.request(`/${uploaded.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
    const metadata = await fixture.app.request(`/${uploaded.id}`);
    expect(metadata.status).toBe(200);
  });

  test("a disabled owner's rename and delete answer 403", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new Uint8Array(4), "held.txt");
    await fixture.store.disableOwner("user-1");
    const renamed = await fixture.app.request(`/${uploaded.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "held-2.txt" }),
    });
    expect(renamed.status).toBe(403);
    const deleted = await fixture.app.request(`/${uploaded.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(403);
  });
});

describe("re-upload after delete (F03)", () => {
  async function uploadWithKey(
    fixture: Fixture,
    key: string,
    contents: string,
  ): Promise<Response> {
    return post(
      fixture.app,
      uploadBody(new TextEncoder().encode(contents), "again.txt", "text/plain"),
      key,
    );
  }

  test("a NEW key creates a new file; the tombstoned row stays tombstoned", async () => {
    const fixture = fixtureFor();
    const first = await uploadWithKey(fixture, "key-one", "first bytes");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };
    await fixture.app.request(`/${firstBody.id}`, { method: "DELETE" });

    const second = await uploadWithKey(fixture, "key-two", "first bytes");
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).not.toBe(firstBody.id);

    const tombstoned = fixture.rows.files.find(
      (file) => file.id === firstBody.id,
    );
    expect(tombstoned?.deletedAt).toBeInstanceOf(Date);
  });

  /*
   * The same OLD key after delete also creates a NEW file: the F01 schema's
   * partial unique index (WHERE deleted_at IS NULL) frees the key at
   * tombstone time, so an idempotent retry only dedupes against live rows.
   */
  test("the SAME old key creates a new file: delete frees the idempotency key", async () => {
    const fixture = fixtureFor();
    const first = await uploadWithKey(fixture, "reused-key", "same bytes");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; versionId: string };
    await fixture.app.request(`/${firstBody.id}`, { method: "DELETE" });

    const retried = await uploadWithKey(fixture, "reused-key", "same bytes");
    expect(retried.status).toBe(201);
    const retriedBody = (await retried.json()) as { id: string };
    expect(retriedBody.id).not.toBe(firstBody.id);

    const list = await fixture.app.request("/");
    const listed = (await list.json()) as { files: Array<{ id: string }> };
    expect(listed.files.map((file) => file.id)).toEqual([retriedBody.id]);

    const oldBytes = fixture.bytes.data.get(
      `openmuse-files/user-1/${firstBody.id}/${firstBody.versionId}`,
    );
    expect(oldBytes).toEqual(new TextEncoder().encode("same bytes"));
  });
});

describe("authentication", () => {
  test("without a session both verbs answer 401", async () => {
    const fixture = fixtureFor();
    guardAdmits = false;
    try {
      const upload = await post(
        fixture.app,
        uploadBody(new Uint8Array(10), "a.txt", "text/plain"),
      );
      expect(upload.status).toBe(401);
      const list = await fixture.app.request("/");
      expect(list.status).toBe(401);
    } finally {
      guardAdmits = true;
    }
  });

  test("a copied URL answers 401 after logout (guardAdmits=false)", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new Uint8Array(8));
    guardAdmits = false;
    try {
      expect((await fixture.app.request(`/${uploaded.id}`)).status).toBe(401);
      const content = await fixture.app.request(`/${uploaded.id}/content`);
      expect(content.status).toBe(401);
    } finally {
      guardAdmits = true;
    }
  });
});

describe("restart durability", () => {
  test("a second store over the same rows and bytes still lists the file", async () => {
    const fixture = fixtureFor();
    await post(
      fixture.app,
      uploadBody(new Uint8Array(64), "durable.txt", "text/plain"),
      "durable-key",
    );
    const restarted = createOpenMuseFileStore({
      rows: fixture.rows,
      byteStore: fixture.bytes,
    });
    const listed = await restarted.list("user-1", { limit: 25 });
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0]?.name).toBe("durable.txt");
    expect(listed.files[0]?.sha256).toBe(sha256(new Uint8Array(64)));
  });
});

describe("mounted through the mobile bff", () => {
  test("uploads under /api/mobile/openmuse-files past the family 8 KiB body limit", async () => {
    const fixture = fixtureFor();
    const { createMobileBffRoutes } = await import("../src/mobile-bff/routes");
    const { createMobileBffWorkspace } = await import(
      "../src/mobile-bff/workspace"
    );
    const bff = createMobileBffRoutes({
      requireUser,
      workspace: createMobileBffWorkspace({
        agentProfileStore: undefined,
        channelStore: undefined,
      }),
      openMuseFiles: fixture.app,
    });
    const form = uploadBody(
      new Uint8Array(9_000),
      "through-bff.txt",
      "text/plain",
    );
    const response = await bff.request("/openmuse-files", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(201);
    const list = await bff.request("/openmuse-files");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { files: Array<{ name: string }> };
    expect(body.files[0]?.name).toBe("through-bff.txt");
  });
});

describe("§9 lifecycle hook", () => {
  test("disableOwner refuses further uploads and lists with the disabled error", async () => {
    const fixture = fixtureFor();
    await fixture.store.disableOwner("user-1");
    await expect(
      fixture.store.upload({
        ownerUserId: "user-1",
        name: "x.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array(4),
        idempotencyKey: null,
      }),
    ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);
    const response = await fixture.app.request("/");
    expect(response.status).toBe(403);
    const upload = await post(
      fixture.app,
      uploadBody(new Uint8Array(4), "x.txt", "text/plain"),
    );
    expect(upload.status).toBe(403);
  });

  test("enumerateOwner returns byte-store-keyed ResourceRefs", async () => {
    const fixture = fixtureFor();
    const uploaded = await fixture.store.upload({
      ownerUserId: "user-1",
      name: "y.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array(4),
      idempotencyKey: "enum-key",
    });
    const refs = await fixture.store.enumerateOwner("user-1");
    expect(refs).toEqual([
      {
        kind: "openmuse-file",
        id: uploaded.file.id,
        externalKey: `openmuse-files/user-1/${uploaded.file.id}/${uploaded.file.versionId}`,
      },
    ]);
    expect(await fixture.store.enumerateOwner("user-2")).toEqual([]);
  });

  test("enumerateOwner keeps a tombstoned file's versions — the deletion manifest must purge them too", async () => {
    const fixture = fixtureFor();
    const uploaded = await fixture.store.upload({
      ownerUserId: "user-1",
      name: "swept.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array(4),
      idempotencyKey: "enum-tombstone-key",
    });
    expect(await fixture.store.enumerateOwner("user-1")).toHaveLength(1);
    await fixture.store.tombstone("user-1", uploaded.file.id);
    /*
     * F03's tombstone keeps the bytes for the restore window; when the
     * account itself is deleted, the manifest (this seam's only consumer)
     * is the one sweeper — dropping tombstoned versions here would leave
     * their blobs and metadata rows behind forever.
     */
    const refs = await fixture.store.enumerateOwner("user-1");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "openmuse-file",
      id: uploaded.file.id,
      externalKey: `openmuse-files/user-1/${uploaded.file.id}/${uploaded.file.versionId}`,
    });
  });

  test("list reads the page's latest versions through the batch seam, one query not one per row", async () => {
    const fixture = fixtureFor();
    for (let index = 0; index < 3; index += 1) {
      await fixture.store.upload({
        ownerUserId: "user-1",
        name: `batched-${index}.txt`,
        mimeType: "text/plain",
        bytes: new Uint8Array(4),
        idempotencyKey: `batched-key-${index}`,
      });
    }
    const listed = await fixture.store.list("user-1", { limit: 25 });
    expect(listed.files).toHaveLength(3);
    // The batch member carried the whole page: the per-row seam never ran.
    expect(fixture.rows.latestVersionCalls).toBe(0);
  });

  test("a fill-append prunes superseded middle versions, keeping the original and the latest", async () => {
    // Grace zeroed: this test pins the synchronous end state (rows AND blobs
    // gone) — the default grace (M22) delays the blob sweep for in-flight
    // readers, pinned by the test below.
    const fixture = fixtureFor({ pruneGraceMs: 0 });
    const uploaded = await fixture.store.upload({
      ownerUserId: "user-1",
      name: "filled.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      idempotencyKey: "prune-key",
    });
    const originalVersion = uploaded.file.versionId;
    const appended: StoredOpenMuseFileVersion[] = [];
    for (let index = 0; index < 3; index += 1) {
      const parent = appended.at(-1)?.versionId ?? originalVersion;
      const landed = await fixture.store.appendVersion({
        ownerUserId: "user-1",
        fileId: uploaded.file.id,
        bytes: new Uint8Array([10 + index]),
        parentVersionId: parent,
        values: { field: `v${index}` },
      });
      expect(landed).not.toBe("stale-parent");
      expect(landed).not.toBeNull();
      appended.push(landed as StoredOpenMuseFileVersion);
    }
    const latest = appended.at(-1);
    // The original upload's version and the newest survive; the two
    // superseded middles — rows AND blobs — are gone, so version bytes
    // cannot accumulate without bound against the aggregate quota.
    expect(fixture.rows.versions.map((row) => row.versionId)).toEqual([
      originalVersion,
      latest?.versionId,
    ]);
    for (const middle of appended.slice(0, -1)) {
      expect(fixture.bytes.data.has(middle?.bytePath ?? "")).toBe(false);
    }
    expect(
      fixture.bytes.data.has(
        `openmuse-files/user-1/${uploaded.file.id}/${originalVersion}`,
      ),
    ).toBe(true);
    expect(fixture.bytes.data.has(latest?.bytePath ?? "")).toBe(true);
    const served = await fixture.store.getOwnedFile("user-1", uploaded.file.id);
    expect(served?.file.versionId).toBe(latest?.versionId);
  });

  test("the default prune grace keeps a superseded blob readable long enough for an in-flight download (round 6 M22)", async () => {
    const fixture = fixtureFor({ pruneGraceMs: 5 });
    const uploaded = await fixture.store.upload({
      ownerUserId: "user-1",
      name: "filled.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      idempotencyKey: "prune-grace-key",
    });
    const first = await fixture.store.appendVersion({
      ownerUserId: "user-1",
      fileId: uploaded.file.id,
      bytes: new Uint8Array([10]),
      parentVersionId: uploaded.file.versionId,
      values: { field: "v0" },
    });
    expect(first).not.toBe("stale-parent");
    const second = await fixture.store.appendVersion({
      ownerUserId: "user-1",
      fileId: uploaded.file.id,
      bytes: new Uint8Array([11]),
      parentVersionId: (first as { versionId: string } | null)?.versionId ?? "",
      values: { field: "v1" },
    });
    expect(second).not.toBe("stale-parent");
    // The superseded MIDDLE version's row is gone, but its blob must survive
    // the grace window: a reader that resolved the old latest before the
    // prune is mid-flight right now.
    expect(
      fixture.bytes.data.has((first as { bytePath: string })?.bytePath ?? ""),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      fixture.bytes.data.has((first as { bytePath: string })?.bytePath ?? ""),
    ).toBe(false);
  });
});

/*
 * T14 (issue #71): import a Gmail PDF attachment as one File. The mail half
 * is faked the way openmuse-mail.test.ts fakes it — an alias-bound wire dial
 * (the recorded alias is how the tests prove the OWNER's connection was
 * used) and the G01 requireConnection seam borrowed whole.
 */

/** One PDF attachment's bytes: real %PDF- magic, so nothing here is a claim. */
function pdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\nT14 fixture report\n");
}

/** The connected owner's connection row — its alias is what every dial must carry. */
function gmailConnection(userId: string): StoredOpenMuseGoogleConnection {
  return {
    id: `conn-${userId}`,
    userId,
    provider: "gmail",
    accountEmail: `${userId}@gmail.test`,
    status: "connected",
    grantedScopes: ["gmail.readonly"],
    generation: 1,
    alias: `openmuse-alias-${userId}`,
    connectedAt: new Date("2026-10-01T00:00:00Z"),
  };
}

/** The requireConnection seam M01 borrows from G01: connected row or the stable 409 refusal. */
function fakeGmailGuard(
  connections: Map<string, StoredOpenMuseGoogleConnection>,
): Pick<OpenMuseGoogleOAuth, "requireConnection"> {
  return {
    async requireConnection(userId, provider) {
      const row = connections.get(userId);
      if (row === undefined || row.status !== "connected") {
        throw new OpenMuseConnectionRefusedError(provider);
      }
      return row;
    },
  };
}

/**
 * One alias-bound fake Gmail wire: the attachment's metadata and bytes exist
 * only under the owning alias, so a dial from any other alias answers 404 —
 * foreign and missing stay indistinguishable, exactly as under the live
 * alias-bound dial. Every call is recorded with the alias that made it.
 */
function fakeGmail(deps: {
  alias: string;
  attachment: { name: string; mimeType: string; size?: number };
  bytes: Uint8Array;
}) {
  const calls: Array<{ path: string; alias: string; input: unknown }> = [];
  const dial: MailWireDial = async (path, init) => {
    const alias = init.headers["x-oo-connector-alias"] ?? "";
    calls.push({ path, alias, input: init.body });
    if (alias !== deps.alias) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (path.endsWith("gmail.attachment.get")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: "att-1",
            name: deps.attachment.name,
            mimeType: deps.attachment.mimeType,
            size: deps.attachment.size ?? deps.bytes.byteLength,
          },
        }),
      };
    }
    if (path.endsWith("gmail.attachment.bytes")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            data: Buffer.from(deps.bytes).toString("base64"),
            sha256: null,
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, client: buildOpenMuseMailClient({ dial }) };
}

type ImportFixture = Fixture & {
  gmail: ReturnType<typeof fakeGmail>;
  connections: Map<string, StoredOpenMuseGoogleConnection>;
};

function importFixture(
  attachment: { name: string; mimeType: string; size?: number } = {
    name: "report.pdf",
    mimeType: "application/pdf",
  },
  bytes: Uint8Array = pdfBytes(),
): ImportFixture {
  const rows = fakeRows();
  const byteStore = fakeBytes();
  const store = createOpenMuseFileStore({ rows, byteStore: byteStore });
  const gmail = fakeGmail({
    alias: "openmuse-alias-user-1",
    attachment,
    bytes,
  });
  const connections = new Map([[actorOne.id, gmailConnection(actorOne.id)]]);
  const app = createOpenMuseFilesRoutes({
    store,
    requireUser,
    mail: { client: gmail.client, service: fakeGmailGuard(connections) },
  });
  return { store, rows, bytes: byteStore, app, gmail, connections };
}

function importBody(
  importKey = "key-1",
  overrides: Record<string, string> = {},
): string {
  return JSON.stringify({
    threadId: "thread-1",
    messageId: "msg-1",
    attachmentId: "att-1",
    importKey,
    ...overrides,
  });
}

function postImport(fixture: ImportFixture, body: string): Promise<Response> {
  return fixture.app.request("/import/gmail-attachment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /import/gmail-attachment (T14)", () => {
  test("imports the owner's PDF attachment as one File with the bytes' sha256 and gmail provenance", async () => {
    const fixture = importFixture();
    const bytes = pdfBytes();
    const response = await postImport(fixture, importBody("happy"));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      name: "report.pdf",
      mimeType: "application/pdf",
      size: bytes.byteLength,
      sha256: sha256(bytes),
      versionId: expect.any(String),
      createdAt: expect.any(String),
    });

    /*
     * PROVENANCE REPRESENTATION (recorded): the F01 schema has no source
     * column, so the namespaced idempotency key on the file row IS the
     * durable provenance — it names the thread, message and attachment the
     * file came from.
     */
    expect(fixture.rows.files).toHaveLength(1);
    expect(fixture.rows.files[0]?.idempotencyKey).toBe(
      "gmail:thread-1:msg-1:att-1:happy",
    );

    // Every vendor call carried the OWNER's alias and the asked-for ids.
    expect(fixture.gmail.calls.map((call) => call.alias)).toEqual([
      "openmuse-alias-user-1",
      "openmuse-alias-user-1",
    ]);
    expect(fixture.gmail.calls[0]?.input).toEqual({
      input: {
        threadId: "thread-1",
        messageId: "msg-1",
        attachmentId: "att-1",
      },
    });
  });

  test("the same importKey retry returns the same file and version with zero further Gmail calls", async () => {
    const fixture = importFixture();
    const first = await postImport(fixture, importBody("retry"));
    expect(first.status).toBe(201);
    const callsAfterFirst = fixture.gmail.calls.length;

    const retried = await postImport(fixture, importBody("retry"));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(await first.json());

    // RETRY-FETCH DECISION (recorded): the converged key answers before any dial.
    expect(fixture.gmail.calls).toHaveLength(callsAfterFirst);
    expect(fixture.rows.files).toHaveLength(1);
  });

  test("a different importKey for the same attachment imports a second distinct file", async () => {
    const fixture = importFixture();
    const first = await postImport(fixture, importBody("key-a"));
    const second = await postImport(fixture, importBody("key-b"));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).not.toBe(firstBody.id);
    expect(fixture.rows.files).toHaveLength(2);
  });

  test("a foreign attachment (another alias's data) answers 404 and imports nothing", async () => {
    const fixture = importFixture();
    fixture.connections.set(actorTwo.id, gmailConnection(actorTwo.id));
    currentActor = actorTwo;
    try {
      const response = await postImport(fixture, importBody("foreign"));
      expect(response.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
    expect(fixture.rows.files).toHaveLength(0);
  });

  test("a non-PDF attachment answers 400 naming the mime, before any bytes dial", async () => {
    const fixture = importFixture({
      name: "photo.png",
      mimeType: "image/png",
    });
    const response = await postImport(fixture, importBody("png"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("image/png");
    // Only the metadata dial happened; the bytes were never asked for.
    expect(fixture.gmail.calls).toHaveLength(1);
  });

  test("disconnected gmail answers 409 connection_required and never dials the vendor", async () => {
    const fixture = importFixture();
    fixture.connections.clear();
    const response = await postImport(fixture, importBody("disconnected"));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("connection_required");
    expect(fixture.gmail.calls).toHaveLength(0);
  });

  test("a §9 disabled owner's import answers 403 with no vendor call", async () => {
    const fixture = importFixture();
    await fixture.store.disableOwner(actorOne.id);
    const response = await postImport(fixture, importBody("disabled"));
    expect(response.status).toBe(403);
    expect(fixture.gmail.calls).toHaveLength(0);
  });

  test("a PDF attachment over the Files 10 MiB ceiling answers 413 before the bytes dial", async () => {
    const fixture = importFixture({
      name: "huge.pdf",
      mimeType: "application/pdf",
      size: 10 * 1024 * 1024 + 1,
    });
    const response = await postImport(fixture, importBody("huge"));
    expect(response.status).toBe(413);
    expect(fixture.gmail.calls).toHaveLength(1);
  });

  test("a nameless PDF falls back to a derived name rather than an empty one", async () => {
    const fixture = importFixture({ name: "", mimeType: "application/pdf" });
    const response = await postImport(fixture, importBody("nameless"));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { name: string };
    expect(body.name).toBe("gmail-att-1.pdf");
  });

  test("a sender-controlled name is stripped of separators and NUL before it is stored", async () => {
    // A NUL in the name would fail the row insert only after the bytes
    // landed — a misleading 503 and an orphan blob; separators break the
    // same rule the rename route enforces on the name it stores.
    const fixture = importFixture({
      name: "evil\\name/with\u0000nul.pdf",
      mimeType: "application/pdf",
    });
    const response = await postImport(fixture, importBody("evil-name"));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { name: string };
    expect(body.name).toBe("evilnamewithnul.pdf");
  });
});

/**
 * Round 3 repair findings, pinned.
 */
describe("upload safety (round 3)", () => {
  test("an HTML or SVG claim is refused rather than stored for same-origin rendering", async () => {
    const fixture = fixtureFor();
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    const claimed = await post(
      fixture.app,
      uploadBody(html, "page.html", "text/html"),
    );
    expect(claimed.status).toBe(415);

    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    );
    const svgClaim = await post(
      fixture.app,
      uploadBody(svg, "pic.svg", "image/svg+xml"),
    );
    expect(svgClaim.status).toBe(415);
    expect(fixture.rows.files).toHaveLength(0);
  });

  test("downloads are served as attachments with nosniff, never rendered inline", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new TextEncoder().encode("hi"));
    const response = await fixture.app.request(`/${uploaded.id}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a client upload key cannot squat the gmail import namespace", async () => {
    const fixture = importFixture();
    // A plain upload using the exact shape of an import key must not converge
    // a later import: the namespaces are isolated by the upload: prefix.
    const squatted = await post(
      fixture.app,
      uploadBody(
        new TextEncoder().encode("not a pdf"),
        "trap.txt",
        "text/plain",
      ),
      "gmail:thread-1:msg-1:att-1:happy",
    );
    expect(squatted.status).toBe(201);
    expect(fixture.rows.files[0]?.idempotencyKey).toBe(
      "upload:gmail:thread-1:msg-1:att-1:happy",
    );

    const imported = await postImport(fixture, importBody("happy"));
    expect(imported.status).toBe(201);
    expect(fixture.rows.files).toHaveLength(2);
    expect(fixture.rows.files[1]?.idempotencyKey).toBe(
      "gmail:thread-1:msg-1:att-1:happy",
    );
  });

  test("a body-limit 413 is passed through, not swallowed as a 503 retry-me", async () => {
    const fixture = fixtureFor();
    const oversized = new Uint8Array(
      20 * 1024 * 1024 + 65 * 1024, // over the 20 MiB + 64 KiB framing allowance
    );
    const response = await post(
      fixture.app,
      uploadBody(oversized, "big.bin", "application/octet-stream"),
    );
    expect(response.status).toBe(413);
  });

  test("a fill-appended version changes the served ETag to the served bytes' hash", async () => {
    const fixture = fixtureFor();
    const uploaded = await uploadOne(fixture, new TextEncoder().encode("seed"));
    const filled = new TextEncoder().encode("seed+filled");
    await fixture.store.appendVersion({
      ownerUserId: "user-1",
      fileId: uploaded.id,
      bytes: filled,
      parentVersionId: uploaded.versionId,
      values: { name: "Ada" },
    });
    const response = await fixture.app.request(`/${uploaded.id}/content`);
    expect(response.status).toBe(200);
    expect(await response.arrayBuffer()).toEqual(filled.buffer);
    expect(response.headers.get("ETag")).toBe(`"sha256:${sha256(filled)}"`);
  });
});

describe("upload atomicity (round 3)", () => {
  test("a version-row failure leaves no file row behind", async () => {
    const rows = fakeRows();
    const failingRows = {
      ...rows,
      insertFileWithVersion: async () => {
        throw new Error("version insert failed");
      },
    };
    const store = createOpenMuseFileStore({
      rows: failingRows,
      byteStore: fakeBytes(),
    });
    await expect(
      store.upload({
        ownerUserId: "user-1",
        name: "a.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array(10),
        idempotencyKey: null,
      }),
    ).rejects.toThrow("version insert failed");
    expect(rows.files).toHaveLength(0);
  });
});

describe("per-owner quota (round 3)", () => {
  test("uploads past the aggregate quota answer 413 and store nothing", async () => {
    const rows = fakeRows();
    const store = createOpenMuseFileStore({
      rows,
      byteStore: fakeBytes(),
      quotaBytes: 100,
    });
    const app = createOpenMuseFilesRoutes({ store, requireUser });
    const first = await post(
      app,
      uploadBody(new Uint8Array(80), "a.txt", "text/plain"),
    );
    expect(first.status).toBe(201);
    const second = await post(
      app,
      uploadBody(new Uint8Array(30), "b.txt", "text/plain"),
    );
    expect(second.status).toBe(413);
    expect(rows.files).toHaveLength(1);
  });
});

describe("gmail import byte recheck (round 3)", () => {
  test("real bytes over the PDF ceiling answer 413 whatever the metadata claimed", async () => {
    // The metadata dial claims a small size; the bytes dial answers bigger
    // than the 10 MiB PDF ceiling — the upload path checks real bytes, so
    // must the import.
    const overCeiling = new Uint8Array(10 * 1024 * 1024 + 1);
    overCeiling.set(new TextEncoder().encode("%PDF-"));
    const fixture = importFixture(
      { name: "big.pdf", mimeType: "application/pdf", size: 1 },
      overCeiling,
    );
    const response = await postImport(fixture, importBody("big"));
    expect(response.status).toBe(413);
    expect(fixture.rows.files).toHaveLength(0);
  });

  test("bytes that are not a PDF, answering a PDF claim, are refused", async () => {
    const fixture = importFixture(
      { name: "fake.pdf", mimeType: "application/pdf", size: 10 },
      new TextEncoder().encode("definitely not a pdf"),
    );
    const response = await postImport(fixture, importBody("fake"));
    expect(response.status).toBe(400);
    expect(fixture.rows.files).toHaveLength(0);
  });
});
